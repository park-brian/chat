// A fixed, stronger model grades what scripts can't see: each answer task's rubric, one yes/no criterion at a time.
// It reads the conversation, the tools called and what each returned, the rubric and a reference answer, and for a task
// with judgeFiles (a path regex) the final text of those files; it never sees which model answered.

export const JUDGE_MODEL = "global.anthropic.claude-sonnet-5-5";
export const PLAIN = "States things literally; no metaphor or flourish where a literal phrase exists.";
export const criteriaOf = task => (task.rubric?.length ? [...task.rubric, PLAIN] : []);

const SYSTEM = `You grade an assistant's replies in a chat against yes/no criteria.

Decide each criterion on its own. Pass it only if the replies clearly meet it; when in doubt, fail it. A criterion is about the assistant's last reply unless it names an earlier one. Text in <assistant_progress> is what the assistant wrote between its tool calls, before that reply; the user read it too. What it says counts toward a criterion about what the reply or final message says, but mid-work remarks there ("Now the fix:") are not faults of the reply's writing. A reference answer, when given, says what a correct answer contains; the reply need not match its wording or length. The tool calls list what the assistant actually ran or read, so a claim to have checked something can be compared with it.

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
// A tool's output keeps its start and its end: node --test and pytest print their counts last (E26: "can't be
// confirmed from the truncated test output").
const ends = (s, n) => (s.length > n ? s.slice(0, n / 2) + "\n…\n" + s.slice(-n / 2) : s);

// The Converse request: the model id travels outside the text, and the graded model's name is in none of it.
export function judgePrompt(run, criteria) {
  // An assistant turn's text before its last tool call is shown apart, as progress (eval.js dialogue: text, reply).
  const turns = (run.dialogue ?? []).map(m => {
    const said = m.role === "assistant" && m.reply != null ? m.reply : m.text;
    const progress = said === m.text ? "" : m.text.slice(0, m.text.length - said.length).trim();
    return (progress ? `<assistant_progress>\n${progress}\n</assistant_progress>\n` : "") + `<${m.role}>\n${said}\n</${m.role}>`;
  }).join("\n\n");
  // Each call with what it returned, so a claim about a check can be held against the check.
  const tools = (run.calls ?? []).filter(c => c.name !== "think").map(c => {
    const out = run.outcomes?.[c.toolUseId];
    return `${c.name} ${clip(JSON.stringify(c.input ?? {}), 300)}` + (out ? `\n  → ${ends(out, 1000).replaceAll("\n", "\n    ")}` : "");
  });
  const text = [
    `<conversation>\n${turns}\n</conversation>`,
    `<tool_calls>\n${tools.join("\n") || "none"}\n</tool_calls>`,
    run.finalFiles?.length && `<final_files>\n${run.finalFiles.map(([p, t]) => `<file path="${p}">\n${clip(t ?? "", 12000)}\n</file>`).join("\n")}\n</final_files>`,
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
export async function bedrock(input) {
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
    const finalFiles = task.judgeFiles ? Object.entries(run.files ?? {}).filter(([p]) => task.judgeFiles.test(p)) : [];
    response = await send(judgePrompt({ ...run, reference: task.reference, finalFiles }, criteria));
  } catch (e) {
    const error = String(e?.message || e).split("\n")[0];
    return { ...none, unjudged: criteria.map(criterion => ({ criterion, reason: "judge failed: " + error })), error };
  }
  const tokens = { input: response.usage?.inputTokens ?? 0, output: response.usage?.outputTokens ?? 0 };
  const content = response.output?.message?.content ?? [];
  // A reply that wrote its grades as JSON text instead of calling the tool is read the same way.
  const written = (() => { try { return JSON.parse(content.map(b => b.text ?? "").join("").match(/\{[\s\S]*\}/)?.[0] ?? "null"); } catch { return null; } })();
  let grades = content.find(b => b.toolUse)?.toolUse?.input?.grades ?? written?.grades ?? [];
  // Sonnet sometimes passes the array as a JSON string.
  if (typeof grades === "string") try { grades = JSON.parse(grades); } catch { grades = []; }
  if (!Array.isArray(grades)) grades = [];
  const byN = new Map(grades.filter(g => typeof g?.pass === "boolean").map(g => [Number(g.n), g]));
  const graded = [], unjudged = [];
  criteria.forEach((criterion, i) => {
    const g = byN.get(i + 1);
    if (g) graded.push({ criterion, pass: g.pass, reason: String(g.reason ?? "") });
    else unjudged.push({ criterion, reason: "judge gave no grade" });
  });
  return { graded, unjudged, tokens, error: unjudged.length ? `no grade for ${unjudged.length} of ${criteria.length} criteria` : null };
}

// The judge's grade moved between repeats on 1 run in 5 (E26: 16-17 of 21 agreed ×3), as much as the effects being
// measured; the majority of three is the grade. A tie among the votes that came back fails, as doubt does.
export const JUDGE_VOTES = 3;
export async function vote(run, task, { votes = JUDGE_VOTES, ...options } = {}) {
  const verdicts = await Promise.all(Array.from({ length: votes }, () => judge(run, task, options)));
  if (votes === 1) return verdicts[0];
  const criteria = options.criteria ?? criteriaOf(task);
  const graded = [], unjudged = [];
  for (const criterion of criteria) {
    const grades = verdicts.flatMap(v => v.graded.filter(g => g.criterion === criterion));
    if (!grades.length) { unjudged.push(verdicts.flatMap(v => v.unjudged).find(u => u.criterion === criterion) ?? { criterion, reason: "judge gave no grade" }); continue; }
    const yes = grades.filter(g => g.pass).length, pass = yes * 2 > grades.length;
    graded.push({ criterion, pass, reason: `${grades.find(g => g.pass === pass)?.reason ?? ""} (${pass ? yes : grades.length - yes}/${grades.length} votes)`, votes: grades.map(g => g.pass) });
  }
  const tokens = { input: verdicts.reduce((n, v) => n + v.tokens.input, 0), output: verdicts.reduce((n, v) => n + v.tokens.output, 0) };
  return { graded, unjudged, tokens, error: unjudged.length ? `no grade for ${unjudged.length} of ${criteria.length} criteria` : null };
}

// Judged criteria join the run's checks; unjudged ones stay apart and out of the score.
export const judgedChecks = verdict => verdict.graded.map(g => ({ ok: g.pass, label: "judge: " + g.criterion, reason: g.reason }));
