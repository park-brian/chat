// E28a: a stronger model plans a long task once, before a cheap one does it. The plan is saved, so every run of the
// "+plan" variant gets the same text and the experiment can be repeated. node evals/oracle.js <task-id> [...] [--model opus|sonnet]
// Plans go to evals/long/plans/<task>.<model>.md; long.js adds a "<task>+plan" variant for each plan there.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bedrock } from "./judge.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PLANS_DIR = path.join(here, "long", "plans");
export const ORACLE_MODELS = { opus: "global.anthropic.claude-opus-5-5", sonnet: "global.anthropic.claude-sonnet-5-5" };

export const ORACLE_SYSTEM = `You plan work that another, less capable model will do. It has a shell and files in a browser, works alone for up to an hour, and loses detail when its context is summarized. You write the plan it will keep beside it.

Write plain markdown, literal and short (under 900 words). Sections:
1. Goal: what will exist at the end, in the user's terms.
2. Done means: each thing that must be true, stated so it can be checked; a command to run where one exists.
3. Fixed facts: the names, numbers, dates, places and relations every later part must agree with. Decide them now; the worker must not change them.
4. Order of work: numbered steps, each with what it produces.
5. Traps: the ways this kind of work usually goes wrong, and what to do instead.
6. When to stop: the condition after which the worker reports and stops instead of revising.

Do not do the work itself. Do not address the worker as "you will"; write the plan as instructions.`;

export async function writePlan(request, { model = "opus", send = bedrock } = {}) {
  const response = await send({
    modelId: ORACLE_MODELS[model],
    system: [{ text: ORACLE_SYSTEM }],
    messages: [{ role: "user", content: [{ text: `<request>\n${request}\n</request>` }] }],
    inferenceConfig: { maxTokens: 32_000 },
    additionalModelRequestFields: { thinking: { type: "adaptive" }, output_config: { effort: "medium" } },
  });
  const text = (response.output?.message?.content ?? []).map(b => b.text ?? "").join("").trim();
  return { text, tokens: { input: response.usage?.inputTokens ?? 0, output: response.usage?.outputTokens ?? 0 } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.loadEnvFile(path.join(here, "..", ".env"));
  const args = process.argv.slice(2);
  const i = args.indexOf("--model"), model = i < 0 ? "opus" : args.splice(i, 2)[1];
  const { default: LONG } = await import("./long.js");
  mkdirSync(PLANS_DIR, { recursive: true });
  for (const id of args) {
    const task = LONG.find(t => t.id === id) ?? (() => { throw new Error("Unknown long task: " + id); })();
    const { text, tokens } = await writePlan(task.turns.join("\n\n"), { model });
    writeFileSync(path.join(PLANS_DIR, `${id}.${model}.md`), text + "\n");
    console.log(`${id}: ${text.split(/\s+/).length} words, ${tokens.input} in, ${tokens.output} out`);
  }
}
