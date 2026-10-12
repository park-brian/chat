// Deterministic inference adapter for live infrastructure tests only.
// It emits Bedrock ConverseStream-shaped events and never calls a model.
export async function* scriptedStream(messages, system = []) {
  const prompt =
    messages.at(-1)?.content?.find((part) => part.text)?.text || "";
  const delay = /^wait:(\d+):/.exec(prompt);
  if (delay)
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(15000, Number(delay[1]))),
    );
  const special = edgeCase(messages, prompt, system);
  if (special) {
    yield* special;
    return;
  }
  const toolResult = messages
    .at(-1)
    ?.content?.find((part) => part.toolResult)?.toolResult;
  const previousTool = messages.at(-2)?.content?.find((part) => part.toolUse)
    ?.toolUse?.name;
  const artifactSmoke = messages.some(
    (item) =>
      item.role === "user" &&
      item.content?.some((part) => part.text === "save-artifact-smoke"),
  );
  const artifactStep =
    artifactSmoke &&
    (!toolResult ? "write" : previousTool === "execute_code" ? "save" : null);
  const reply = toolResult
    ? ["web_search", "browser"].includes(previousTool)
      ? `${previousTool === "web_search" ? "Search results" : "Browser screenshot"} reviewed.`
      : `Tool result: ${toolResult.content?.[0]?.text || ""}`
    : prompt === "history?"
      ? `History: ${messages
          .filter((item) => item.role === "user")
          .map((item) => item.content.find((part) => part.text)?.text)
          .join(" | ")}`
      : `Echo: ${prompt}`;
  yield { messageStart: { role: "assistant" } };
  const code =
    prompt.startsWith("run-code:") && !toolResult
      ? prompt.slice(9).trim()
      : null;
  const javascript =
    prompt.startsWith("run-js:") && !toolResult ? prompt.slice(7).trim() : null;
  const command =
    prompt.startsWith("run-command:") && !toolResult
      ? prompt.slice(12).trim()
      : null;
  const search =
    prompt.startsWith("run-search:") && !toolResult
      ? prompt.slice(11).trim()
      : null;
  const browser =
    prompt.startsWith("run-browser:") && !toolResult
      ? prompt.slice(12).trim()
      : null;
  const tool =
    code || javascript || command || search || browser || artifactStep;
  const failAfterUsage = prompt === "scripted-error";
  yield {
    contentBlockStart: {
      contentBlockIndex: 0,
      start: tool
        ? {
            toolUse: {
              toolUseId: "scripted-tool-1",
              name:
                artifactStep === "save"
                  ? "save_artifact"
                  : search
                    ? "web_search"
                    : browser
                      ? "browser"
                      : command
                        ? "execute_command"
                        : "execute_code",
            },
          }
        : {},
    },
  };
  yield {
    contentBlockDelta: {
      contentBlockIndex: 0,
      delta: tool
        ? {
            toolUse: {
              input: JSON.stringify(
                artifactStep === "save"
                  ? {
                      path: "outputs/report.txt",
                      name: "report.txt",
                      contentType: "text/plain",
                      idempotencyKey: "smoke-report",
                    }
                  : artifactStep === "write"
                    ? {
                        language: "python",
                        code: "from pathlib import Path; Path('outputs').mkdir(exist_ok=True); Path('outputs/report.txt').write_text('Saved by AgentCore smoke test')",
                      }
                    : search
                      ? { query: search }
                      : browser
                        ? { action: "navigate", url: browser }
                        : command
                          ? { command }
                          : {
                              language: javascript ? "javascript" : "python",
                              code: javascript || code,
                            },
              ),
            },
          }
        : { text: reply },
    },
  };
  // A provider stream that dies before reporting usage.
  if (prompt === "scripted-stream-error") throw Error("Scripted stream failure");
  yield { contentBlockStop: { contentBlockIndex: 0 } };
  yield {
    messageStop: {
      stopReason: failAfterUsage
        ? "scripted_failure"
        : tool
          ? "tool_use"
          : "end_turn",
    },
  };
  yield {
    metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
  };
}

// Offline edge cases, each a whole stream:
// scripted-malformed: a tool call whose input is not JSON.
// scripted-empty: an end_turn with no text.
// scripted-max-tokens: text cut off at the output limit.
// scripted-preamble: text, a tool call, then the answer.
// loop-tools:N: N code calls every step until told tools are gone.
function edgeCase(messages, prompt, system) {
  const usage = {
    metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
  };
  const text = (index, value) => [
    { contentBlockDelta: { contentBlockIndex: index, delta: { text: value } } },
    { contentBlockStop: { contentBlockIndex: index } },
  ];
  const toolUse = (index, input) => [
    {
      contentBlockStart: {
        contentBlockIndex: index,
        start: { toolUse: { toolUseId: `scripted-tool-${index}`, name: "execute_code" } },
      },
    },
    {
      contentBlockDelta: {
        contentBlockIndex: index,
        delta: { toolUse: { input } },
      },
    },
    { contentBlockStop: { contentBlockIndex: index } },
  ];
  const stop = (stopReason) => [{ messageStop: { stopReason } }, usage];
  const first = messages.find((item) => item.role === "user")?.content?.[0]?.text;
  const results = messages.flatMap((item) =>
    (item.content || []).filter((part) => part.toolResult),
  ).length;
  if (prompt === "scripted-malformed")
    return [...toolUse(0, "{not json"), ...stop("tool_use")];
  if (prompt === "scripted-empty") return stop("end_turn");
  if (prompt === "scripted-max-tokens")
    return [...text(0, "Partial"), ...stop("max_tokens")];
  if (first === "scripted-preamble")
    return results
      ? [...text(0, " Answer."), ...stop("end_turn")]
      : [
          ...text(0, "Checking."),
          ...toolUse(1, JSON.stringify({ language: "python", code: "1" })),
          ...stop("tool_use"),
        ];
  const loop = /^loop-tools:(\d)$/.exec(first || "");
  if (!loop) return null;
  if (system.some((part) => part.text?.includes("no longer available")))
    return [...text(0, `Done after ${results} tool results.`), ...stop("end_turn")];
  return [
    ...Array.from({ length: Number(loop[1]) }, (_, index) =>
      toolUse(index, JSON.stringify({ language: "python", code: "1" })),
    ).flat(),
    ...stop("tool_use"),
  ];
}
