// Gemini's wire format stays here; grants and managed-tool execution stay in controller.js.
export function geminiRequest(model, level, contents, instructions, specs) {
  const body = {
    contents,
    ...(instructions && { systemInstruction: { parts: [{ text: instructions }] } }),
    generationConfig: { maxOutputTokens: model.maxOutputTokens,
      thinkingConfig: { thinkingLevel: level } },
    ...(specs.length && { tools: [{ functionDeclarations: specs.map((spec) => ({
      name: spec.name, description: spec.description,
      parametersJsonSchema: spec.inputSchema.json,
    })) }] }),
  };
  if (Buffer.byteLength(JSON.stringify(body)) > 15_000_000)
    throw Error("Gemini request exceeds the inline-media safety limit");
  return body;
}

export function geminiFunctionResult(call, content, isError) {
  const text = content.find((part) => part.text)?.text || "(no output)";
  const image = content.find((part) => part.image)?.image;
  return { functionResponse: {
    ...(call.id && { id: call.id }), name: call.name,
    response: isError ? { error: text } : image
      ? { output: text, screenshot: "See attached image." } : { output: text },
    ...(image && { parts: [{ inlineData: { mimeType: "image/png",
      data: Buffer.from(image.source.bytes).toString("base64") } }] }),
  } };
}

export function geminiUsage(meter) {
  if (!meter) throw Error("Gemini did not report token usage");
  const names = ["promptTokenCount", "cachedContentTokenCount", "toolUsePromptTokenCount",
    "candidatesTokenCount", "thoughtsTokenCount", "totalTokenCount"];
  const values = Object.fromEntries(names.map((name) => [name, meter[name] ?? 0]));
  if (names.some((name) => !Number.isSafeInteger(values[name]) || values[name] < 0) ||
    values.cachedContentTokenCount > values.promptTokenCount ||
    meter.totalTokenCount === undefined)
    throw Error("Invalid Gemini token usage");
  const expected = values.promptTokenCount + values.toolUsePromptTokenCount +
    values.candidatesTokenCount + values.thoughtsTokenCount;
  if (values.totalTokenCount !== expected) throw Error("Inconsistent Gemini token usage");
  return { inputTokens: values.promptTokenCount - values.cachedContentTokenCount +
      values.toolUsePromptTokenCount,
    outputTokens: values.candidatesTokenCount + values.thoughtsTokenCount,
    totalTokens: values.totalTokenCount,
    cacheReadInputTokens: values.cachedContentTokenCount, cacheWriteInputTokens: 0 };
}

export function geminiStepCalls(step) {
  const calls = step.parts.filter((part) => part.functionCall)
    .map((part) => part.functionCall);
  if (calls.length && (step.finishReason !== "STOP" || calls.some((call) =>
    typeof call.name !== "string" || !call.name ||
    !call.args || typeof call.args !== "object" || Array.isArray(call.args) ||
    (call.id !== undefined && typeof call.id !== "string"))))
    throw Error("Malformed Gemini function turn");
  if (!calls.length && !["STOP", "MAX_TOKENS"].includes(step.finishReason))
    throw Error(`Gemini stopped: ${step.finishReason || "unknown"}`);
  return calls;
}

export async function readGeminiStream(body, emit) {
  if (!body) throw Error("Gemini response had no stream");
  const decoder = new TextDecoder();
  let buffer = "";
  const parts = [];
  let finishReason;
  let meter;
  let visibleText = "";
  const frame = (raw) => {
    const data = raw.split("\n").filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6)).join("\n");
    if (!data) return;
    const event = JSON.parse(data);
    const candidate = event.candidates?.[0];
    for (const part of candidate?.content?.parts || []) {
      parts.push(part); // Keep positions and opaque thought signatures unchanged.
      if (part.text && !part.thought) {
        visibleText += part.text;
        emit({ type: "message.delta", text: part.text });
      }
    }
    if (candidate?.finishReason) finishReason = candidate.finishReason;
    if (event.usageMetadata) meter = event.usageMetadata; // Last frame is cumulative.
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r/g, "");
    if (buffer.length > 1_048_576) throw Error("Gemini event exceeded limit");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      frame(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) throw Error("Gemini stream ended mid-event");
  return { parts, finishReason, usage: geminiUsage(meter), visibleText };
}
