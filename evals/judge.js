// A fixed, stronger model grades what scripts can't see: each answer task's rubric, one yes/no criterion at a time.
// It reads the conversation, the tools called and what each returned, the rubric and a reference answer; it never sees which model answered.

export const JUDGE_MODEL = "global.anthropic.claude-sonnet-5-5";
export const PLAIN = "States things literally; no metaphor or flourish where a literal phrase exists.";
export const criteriaOf = task => (task.rubric?.length ? [...task.rubric, PLAIN] : []);

const SYSTEM = `You grade an assistant's replies in a chat against yes/no criteria.

Decide each criterion on its own. Pass it only if the replies clearly meet it; when in doubt, fail it. A criterion is about the assistant's last reply unless it names an earlier one. A reference answer, when given, says what a correct answer contains; the reply need not match its wording or length. The tool calls list what the assistant actually ran or read, so a claim to have checked something can be compared with it.

For each criterion give a one-sentence reason that points to the words in the reply it rests on. Record every grade with the grade tool.`;

const GRADE_TOOL = {
  toolSpec: {
    name: "grade",
    description: "Record one grade per criterion.",
    inputSchema: {
      json: {
        type: "object",
        properties: {
          grades: {
            type: "array",
            items: { type: "object", properties: { n: { type: "integer", description: "The criterion's number" }, pass: { type: "boolean" }, reason: { type: "string" } }, required: ["n", "pass", "reason"] },
          },
        },
        required: ["grades"],
      },
    },
  },
};

const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);

// The Converse request: the model id travels outside the text, and the graded model's name is in none of it.
export function judgePrompt(run, criteria) {
  const turns = (run.dialogue ?? []).map(m => `<${m.role}>\n${m.text}\n</${m.role}>`).join("\n\n");
  // Each call with what it returned, so a claim about a check can be held against the check.
  const tools = (run.calls ?? []).filter(c => c.name !== "think").map(c => {
    const out = run.outcomes?.[c.toolUseId];
    return `${c.name} ${clip(JSON.stringify(c.input ?? {}), 300)}` + (out ? `\n  → ${clip(out, 600).replaceAll("\n", "\n    ")}` : "");
  });
  const text = [
    `<conversation>\n${turns}\n</conversation>`,
    `<tool_calls>\n${tools.join("\n") || "none"}\n</tool_calls>`,
    run.reference && `<reference>\n${run.reference}\n</reference>`,
    `<criteria>\n${criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n</criteria>`,
  ].filter(Boolean).join("\n\n");
  return {
    modelId: JUDGE_MODEL,
    system: [{ text: SYSTEM }],
    messages: [{ role: "user", content: [{ text }] }],
    toolConfig: { tools: [GRADE_TOOL], toolChoice: { auto: {} } }, // Claude 5 refuses a forced tool choice
    // Sonnet 5.5 refuses temperature ("deprecated for this model"): its default sampling is what the judge gets.
    inferenceConfig: { maxTokens: 4000 },
  };
}

let client;
async function bedrock(input) {
  const { BedrockRuntimeClient, ConverseCommand } = await import("@aws-sdk/client-bedrock-runtime");
  client ??= new BedrockRuntimeClient({ region: process.env.AWS_REGION || "us-east-1" });
  return client.send(new ConverseCommand(input));
}

// { graded: [{ criterion, pass, reason }], unjudged: [{ criterion, reason }], tokens: { input, output }, error }.
// A judge that fails leaves its criteria unjudged: they don't count against the run, and the run says so.
export async function judge(run, task, { send = bedrock, criteria = criteriaOf(task) } = {}) {
  const none = { graded: [], unjudged: [], tokens: { input: 0, output: 0 }, error: null };
  if (!criteria.length) return none;
  let response;
  try {
    response = await send(judgePrompt({ ...run, reference: task.reference }, criteria));
  } catch (e) {
    const error = String(e?.message || e).split("\n")[0];
    return { ...none, unjudged: criteria.map(criterion => ({ criterion, reason: "judge failed: " + error })), error };
  }
  const tokens = { input: response.usage?.inputTokens ?? 0, output: response.usage?.outputTokens ?? 0 };
  const content = response.output?.message?.content ?? [];
  // A reply that wrote its grades as JSON text instead of calling the tool is read the same way.
  const written = (() => { try { return JSON.parse(content.map(b => b.text ?? "").join("").match(/\{[\s\S]*\}/)?.[0] ?? "null"); } catch { return null; } })();
  const grades = content.find(b => b.toolUse)?.toolUse?.input?.grades ?? written?.grades ?? [];
  const byN = new Map(grades.filter(g => typeof g?.pass === "boolean").map(g => [Number(g.n), g]));
  const graded = [], unjudged = [];
  criteria.forEach((criterion, i) => {
    const g = byN.get(i + 1);
    if (g) graded.push({ criterion, pass: g.pass, reason: String(g.reason ?? "") });
    else unjudged.push({ criterion, reason: "judge gave no grade" });
  });
  return { graded, unjudged, tokens, error: unjudged.length ? `no grade for ${unjudged.length} of ${criteria.length} criteria` : null };
}

// Judged criteria join the run's checks; unjudged ones stay apart and out of the score.
export const judgedChecks = verdict => verdict.graded.map(g => ({ ok: g.pass, label: "judge: " + g.criterion, reason: g.reason }));
