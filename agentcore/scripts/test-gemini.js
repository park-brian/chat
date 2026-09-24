import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { geminiRequest, geminiFunctionResult, geminiUsage, geminiStepCalls,
  readGeminiStream } from "../gemini-protocol.js";

const model = { maxOutputTokens: 65536 };
const spec = { name: "browser", description: "Inspect a page", inputSchema: {
  json: { type: "object", properties: { action: { type: "string" } },
    required: ["action"] } } };
const request = geminiRequest(model, "high", [{ role: "user", parts: [{ text: "hello" }] }],
  "Use the browser", [spec]);
assert.equal(request.generationConfig.maxOutputTokens, 65536);
assert.equal(request.tools[0].functionDeclarations[0].parametersJsonSchema,
  spec.inputSchema.json);
assert.throws(() => geminiRequest(model, "low", [{ role: "user",
  parts: [{ text: "x".repeat(15_000_000) }] }], "", []), /safety limit/);

const call = { id: "call-1", name: "browser" };
const result = geminiFunctionResult(call, [{ text: "Navigate complete" },
  { image: { format: "png", source: { bytes: Buffer.from("png") } } }], false);
assert.equal(result.functionResponse.response.screenshot, "See attached image.");
assert.equal(result.functionResponse.parts[0].inlineData.data, "cG5n");
assert.ok(!JSON.stringify(result).includes('"$ref"'));
assert.deepEqual(geminiFunctionResult(call, [{ text: "Unavailable" }], true)
  .functionResponse.response, { error: "Unavailable" });

const meter = { promptTokenCount: 100, cachedContentTokenCount: 10,
  toolUsePromptTokenCount: 15, candidatesTokenCount: 20,
  thoughtsTokenCount: 5, totalTokenCount: 140 };
assert.deepEqual(geminiUsage(meter), { inputTokens: 105, outputTokens: 25,
  totalTokens: 140, cacheReadInputTokens: 10, cacheWriteInputTokens: 0 });
assert.throws(() => geminiUsage(null), /did not report/);
assert.throws(() => geminiUsage({ ...meter, totalTokenCount: 139 }), /Inconsistent/);
assert.throws(() => geminiUsage({ ...meter, cachedContentTokenCount: 101 }), /Invalid/);

const signed = { functionCall: { id: "one", name: "web_search", args: { query: "a" } },
  thoughtSignature: "opaque-signature" };
const second = { functionCall: { id: "two", name: "browser", args: { action: "screenshot" } } };
const frames = [
  { candidates: [{ content: { parts: [{ text: "thinking", thought: true },
    { text: "Looking" }] } }], usageMetadata: { promptTokenCount: 5 } },
  { candidates: [{ content: { parts: [signed, second] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4,
      thoughtsTokenCount: 2, totalTokenCount: 14 } },
].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
const bytes = Buffer.from(frames);
const emitted = [];
const stream = Readable.from([bytes.subarray(0, 12), bytes.subarray(12, 47),
  bytes.subarray(47)]);
const parsed = await readGeminiStream(stream, (event) => emitted.push(event));
assert.equal(parsed.finishReason, "STOP");
assert.equal(parsed.parts[2].thoughtSignature, "opaque-signature");
assert.deepEqual(parsed.parts.slice(2).map((part) => part.functionCall.id), ["one", "two"]);
assert.equal(parsed.visibleText, "Looking");
assert.deepEqual(emitted, [{ type: "message.delta", text: "Looking" }]);
assert.equal(parsed.usage.totalTokens, 14);
assert.equal(geminiStepCalls(parsed).length, 2);
assert.throws(() => geminiStepCalls({ ...parsed, finishReason: "SAFETY" }),
  /Malformed Gemini/);
assert.throws(() => geminiStepCalls({ parts: [], finishReason: "SAFETY" }),
  /Gemini stopped: SAFETY/);
assert.throws(() => geminiStepCalls({ parts: [{ functionCall: {
  name: "browser", args: "invalid" } }], finishReason: "STOP" }),
  /Malformed Gemini/);
assert.deepEqual(geminiStepCalls({ parts: [], finishReason: "MAX_TOKENS" }), []);
await assert.rejects(readGeminiStream(Readable.from([Buffer.from("data: {}\n\n")]), () => {}),
  /did not report/);
await assert.rejects(readGeminiStream(Readable.from([Buffer.from("data: {}")]), () => {}),
  /mid-event/);

console.log("PASS: Gemini protocol, signatures, multimodal tools, and usage meters");
