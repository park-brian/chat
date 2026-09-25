// Deterministic inference adapter for live infrastructure tests only.
// It emits Bedrock ConverseStream-shaped events and never calls a model.
export async function* scriptedStream(messages) {
  const prompt = messages.at(-1)?.content?.find((part) => part.text)?.text || "";
  const toolResult = messages.at(-1)?.content?.find((part) => part.toolResult)?.toolResult;
  const previousTool = messages.at(-2)?.content?.find((part) => part.toolUse)?.toolUse?.name;
  const reply = toolResult
    ? ["web_search", "browser"].includes(previousTool)
      ? `${previousTool === "web_search" ? "Search results" : "Browser screenshot"} reviewed.`
      : `Tool result: ${toolResult.content?.[0]?.text || ""}`
    : prompt === "history?"
    ? `History: ${messages.filter((item) => item.role === "user").map((item) => item.content.find((part) => part.text)?.text).join(" | ")}`
    : `Echo: ${prompt}`;
  yield { messageStart: { role: "assistant" } };
  const code = prompt.startsWith("run-code:") && !toolResult ? prompt.slice(9).trim() : null;
  const javascript = prompt.startsWith("run-js:") && !toolResult ? prompt.slice(7).trim() : null;
  const command = prompt.startsWith("run-command:") && !toolResult ? prompt.slice(12).trim() : null;
  const search = prompt.startsWith("run-search:") && !toolResult ? prompt.slice(11).trim() : null;
  const browser = prompt.startsWith("run-browser:") && !toolResult ? prompt.slice(12).trim() : null;
  const tool = code || javascript || command || search || browser;
  const failAfterUsage = prompt === "scripted-error";
  yield { contentBlockStart: { contentBlockIndex: 0, start: tool
    ? { toolUse: { toolUseId: "scripted-tool-1", name: search ? "web_search" :
      browser ? "browser" : command ? "execute_command" : "execute_code" } } : {} } };
  yield { contentBlockDelta: { contentBlockIndex: 0, delta: tool
    ? { toolUse: { input: JSON.stringify(search ? { query: search } :
      browser ? { action: "navigate", url: browser } : command ? { command } :
      { language: javascript ? "javascript" : "python", code: javascript || code }) } }
    : { text: reply } } };
  yield { contentBlockStop: { contentBlockIndex: 0 } };
  yield { messageStop: { stopReason: failAfterUsage ? "scripted_failure" :
    tool ? "tool_use" : "end_turn" } };
  yield { metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } };
}
