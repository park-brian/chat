// Deterministic inference adapter for live infrastructure tests only.
// It emits Bedrock ConverseStream-shaped events and never calls a model.
export async function* scriptedStream(messages) {
  const prompt = messages.at(-1)?.content?.find((part) => part.text)?.text || "";
  const toolResult = messages.at(-1)?.content?.find((part) => part.toolResult)?.toolResult;
  const reply = toolResult
    ? `Tool result: ${toolResult.content?.[0]?.text || ""}`
    : prompt === "history?"
    ? `History: ${messages.filter((item) => item.role === "user").map((item) => item.content.find((part) => part.text)?.text).join(" | ")}`
    : `Echo: ${prompt}`;
  yield { messageStart: { role: "assistant" } };
  const code = prompt.startsWith("run-code:") && !toolResult ? prompt.slice(9).trim() : null;
  yield { contentBlockStart: { contentBlockIndex: 0, start: code
    ? { toolUse: { toolUseId: "scripted-tool-1", name: "execute_code" } } : {} } };
  yield { contentBlockDelta: { contentBlockIndex: 0, delta: code
    ? { toolUse: { input: JSON.stringify({ language: "python", code }) } }
    : { text: reply } } };
  yield { contentBlockStop: { contentBlockIndex: 0 } };
  yield { messageStop: { stopReason: code ? "tool_use" : "end_turn" } };
  yield { metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } };
}
