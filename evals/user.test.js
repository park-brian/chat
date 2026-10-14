// The simulated user and the intent tasks, offline: a stubbed Converse client, no browser, no model.
import assert from "node:assert/strict";
import { dialogue, written } from "../eval.js";
import TASKS from "./tasks.js";
import { judgePrompt } from "./judge.js";
import { nextMessage, simulate, SIM_MODEL, userPrompt } from "./user.js";

const user = { persona: "You are a nurse.", goal: "Weekly targets per habit. Dark theme.", reveal: ["Your name is Dana."], maxTurns: 4 };
const reply = (text, input = 100, output = 5) => ({ usage: { inputTokens: input, outputTokens: output }, output: { message: { content: [{ text }] } } });

// The prompt: goal, persona, facts, the conversation and file names; no model name, no rubric, no checks.
const habits = TASKS.find(t => t.id === "intent-habits");
const conv = [{ role: "user", text: "make me a habit tracker" }, { role: "assistant", text: "Daily or weekly? Light or dark?" }];
const p = userPrompt(habits.user, conv, ["index.html"]);
const all = p.system[0].text + "\n" + p.messages[0].content[0].text;
assert.equal(p.modelId, SIM_MODEL);
assert.equal(p.inferenceConfig.temperature, undefined); // refused by Sonnet 5.5
assert.equal(p.toolConfig, undefined); // no forced tool choice, no tools
assert.ok(all.includes(habits.user.goal) && all.includes(habits.user.persona));
assert.ok(all.includes("<you>\nmake me a habit tracker\n</you>") && all.includes("<assistant>\nDaily or weekly? Light or dark?\n</assistant>"));
assert.ok(all.includes("Files the assistant has written: index.html"));
assert.ok(all.includes('say "I don\'t mind"') && all.includes("exactly DONE"));
assert.ok(!/haiku|claude|sonnet|opus|gemini|luna|gpt/i.test(all), "no model name");
for (const criterion of habits.rubric) assert.ok(!all.includes(criterion), "no rubric");
assert.ok(!all.includes("judge") && !all.includes("check"));
assert.ok(userPrompt(user, [], []).system[0].text.includes("- Your name is Dana.") && userPrompt(user, [], []).messages[0].content[0].text.includes("written: none"));
assert.ok(!userPrompt({ ...user, reveal: undefined }, [], []).system[0].text.includes("<facts>"));
// A long reply is cut, so one essay doesn't fill the simulator's context.
assert.ok(userPrompt(user, [{ role: "assistant", text: "x".repeat(20000) }]).messages[0].content[0].text.length < 9000);

// DONE is the whole message, give or take a period or quotes; DONE inside a sentence is not.
for (const [text, done] of [["DONE", true], ["DONE.", true], ['"DONE"', true], ["**DONE**", true], ["done", false], ["not DONE yet, make it dark", false]])
  assert.equal((await nextMessage(user, [], [], { send: async () => reply(text) })).done, done, text);
await assert.rejects(nextMessage(user, [], [], { send: async () => reply("  ") }), /wrote nothing/);
await assert.rejects(nextMessage(user, [], [], { send: async () => { throw new Error("ThrottlingException: slow\nstack"); } }), /^Error: simulated user failed: ThrottlingException: slow$/);

// The loop: each reply is read, the simulator answers, its message is sent, until DONE.
const fake = script => {
  const sentToAgent = [], prompts = [];
  let i = 0;
  return {
    sentToAgent, prompts,
    read: async () => ({ dialogue: [{ role: "user", text: "make me a habit tracker" }, ...sentToAgent.map(text => ({ role: "user", text }))], wrote: sentToAgent.length > 1 ? ["index.html"] : [] }),
    say: async text => { sentToAgent.push(text); },
    send: async input => { prompts.push(input); return reply(script[i++] ?? "DONE", 200, 10); },
  };
};
let f = fake(["weekly. dark.", "i don't mind", "DONE"]);
let r = await simulate(user, { ...f, sent: 1 });
assert.deepEqual([r.done, r.userTurns, r.said, f.sentToAgent, r.tokens, r.dontMind], [true, 3, ["weekly. dark.", "i don't mind"], ["weekly. dark.", "i don't mind"], { input: 600, output: 30 }, 1]);
assert.ok(f.prompts[2].messages[0].content[0].text.includes("<you>\ni don't mind\n</you>") && f.prompts[2].messages[0].content[0].text.includes("written: index.html"));

// The control: DONE after the first reply is one user turn and nothing more is sent.
f = fake(["DONE"]);
r = await simulate(user, { ...f, sent: 1 });
assert.deepEqual([r.done, r.userTurns, f.sentToAgent.length, f.prompts.length], [true, 1, 0, 1]);

// maxTurns: after the last allowed message the reply is still asked about (to see whether it is DONE), then it stops.
f = fake(["no", "no", "no", "still no", "never sent"]);
r = await simulate(user, { ...f, sent: 1 });
assert.deepEqual([r.done, r.userTurns, f.sentToAgent, f.prompts.length], [false, 4, ["no", "no", "no"], 4]);
f = fake(["no", "DONE"]);
r = await simulate({ ...user, maxTurns: 2 }, { ...f, sent: 1 });
assert.deepEqual([r.done, r.userTurns], [true, 2]);
// The task's own turns count toward maxTurns.
f = fake(["no", "no"]);
r = await simulate({ ...user, maxTurns: 2 }, { ...f, sent: 2 });
assert.deepEqual([r.done, r.userTurns, f.sentToAgent.length], [false, 2, 0]);

// Where files were written, for the judge, and the list the simulator sees.
const msg = (role, content, modelId) => ({ role, content, modelId });
const messages = [
  msg("user", [{ text: '{"toolUse":[{"name":"write_file","input":{"path":"stats.js"}}]}' }]),
  msg("assistant", [{ toolUse: { toolUseId: "0", name: "write_file", input: { path: "stats.js" } } }], "echo"),
  msg("user", [{ text: "make me a habit tracker" }]),
  msg("assistant", [{ text: "Weekly targets, dark theme, saved in localStorage." }, { toolUse: { toolUseId: "1", name: "write_file", input: { path: "index.html" } } }], "m"),
  msg("user", [{ toolResult: { toolUseId: "1", content: [{ text: "ok" }] } }]),
  msg("assistant", [{ toolUse: { toolUseId: "2", name: "write_file", input: { path: "scratch/try.js" } } }, { toolUse: { toolUseId: "3", name: "edit_file", input: { path: "index.html" } } }], "m"),
  msg("user", [{ toolResult: { toolUseId: "3", content: [{ text: "ok" }] } }]),
  msg("assistant", [{ text: "Done." }], "m"),
];
assert.deepEqual(written(messages), ["index.html"]);
assert.deepEqual(dialogue(messages), [{ role: "user", text: "make me a habit tracker" }, { role: "assistant", text: "Weekly targets, dark theme, saved in localStorage.\n\nDone.", reply: "Done." }]);
assert.deepEqual(dialogue(messages, { writes: true }), [{ role: "user", text: "make me a habit tracker" }, { role: "assistant", text: "Weekly targets, dark theme, saved in localStorage.\n[wrote: index.html]\n\n[wrote: scratch/try.js, index.html]\n\nDone.", reply: "Done." }]);

// The judge can be shown the final files a task names.
const jp = judgePrompt({ dialogue: [], calls: [], finalFiles: [["stats.js", "export function summarize() {}"]] }, ["c"]).messages[0].content[0].text;
assert.ok(jp.includes('<final_files>\n<file path="stats.js">\nexport function summarize() {}\n</file>\n</final_files>'));
assert.ok(!judgePrompt({ dialogue: [], calls: [] }, ["c"]).messages[0].content[0].text.includes("final_files"));

// The intent set: each task has a hidden goal, an opening message, a grader and a rubric (the control needs none).
const intent = TASKS.filter(t => t.set === "intent");
assert.ok(intent.length >= 6 && intent.some(t => t.id === "intent-control"));
for (const t of intent) {
  assert.ok(t.user.goal && t.user.persona && Number.isInteger(t.user.maxTurns) && t.turns.some(x => typeof x === "string"), t.id);
  assert.ok(typeof t.check === "function" && (t.id === "intent-control" || t.rubric.length >= 3), t.id);
}

// Graders against runs that should pass and ones that shouldn't.
const grade = async (id, run) => (await TASKS.find(t => t.id === id).check({ answer: "", files: {}, dialogue: [], calls: [], probe: async () => null, ...run })).map(([ok]) => !!ok);
const done = (userTurns, ok = true) => ({ user: { done: ok, userTurns, said: [] } });
assert.deepEqual(await grade("intent-control", { ...done(1), answer: "```js\nfunction isLeapYear(y) { return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0); }\n```", dialogue: [{ role: "assistant", text: "```js\n...\n```" }] }), [true, true, true, true]);
assert.deepEqual(await grade("intent-control", { ...done(2), answer: "```js\nfunction isLeapYear(y) { return y % 4 === 0; }\n```", dialogue: [{ role: "assistant", text: "Should centuries count?" }] }), [true, false, false, false]);
assert.deepEqual(await grade("intent-control", done(3, false)).then(g => g.slice(0, 2)), [false, false]);

const STATS = TASKS.find(t => t.id === "intent-cleanup").turns[0].seed.content;
const clean = `// Used by report.js and the dashboard.
export function summarize(rows, opts) {
  const key = opts?.key || "amount";
  const groupBy = opts?.groupBy;
  const groups = {};
  const values = [];
  for (const row of rows) {
    if (row == null) continue;
    const raw = row[key];
    const value = typeof raw === "string" ? parseFloat(raw) : raw;
    if (value === null || value === undefined || Number.isNaN(value)) continue;
    values.push(value);
    const group = groupBy ? row[groupBy] : null;
    if (group === null || group === undefined) continue;
    groups[group] ??= { count: 0, total: 0 };
    groups[group].count += 1;
    groups[group].total += value;
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    total,
    mean: values.length ? total / values.length : 0,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    groups: groupBy ? groups : undefined,
  };
}
`;
assert.deepEqual(await grade("intent-cleanup", { ...done(3), files: { "stats.js": clean } }), [true, true, true, true, true, true, true]);
assert.deepEqual(await grade("intent-cleanup", { ...done(3), files: { "stats.js": STATS } }), [true, true, false, true, true, true, false]);
assert.deepEqual((await grade("intent-cleanup", { ...done(3), files: { "stats.js": clean.replace("(rows, opts)", "({ rows, key, groupBy })") } }))[4], false);
assert.deepEqual((await grade("intent-cleanup", { ...done(3), files: { "stats.js": clean.replace("groups: groupBy ? groups : undefined", "groups") } }))[4], false);

const letter = "Dear Priya Shah,\n\nI am applying for the Senior QA Engineer role at Northwind Health. I have 8 years of experience testing healthcare software, and at Medisoft I cut our regression run from 3 days to 4 hours by building an automated Playwright suite.\n\nDana Reyes";
assert.ok((await grade("intent-cover-letter", { ...done(3), answer: letter })).every(Boolean));
assert.deepEqual(await grade("intent-cover-letter", { ...done(2), answer: "Dear Hiring Manager, I am excited to apply for the [Role] at [Company]." }), [true, true, false, false, false, true]);

const trip = "Day 1 (14 May): Oceanário, great for kids. Lunch at a vegetarian café. Metro to Baixa.\nDay 2: tram 28.\nDay 3: train to Belém.\nDay 4 (17 May): Lisbon zoo.\nTotal: about €1,150 of your €1,200 budget.";
assert.ok((await grade("intent-trip", { ...done(4), answer: trip })).every(Boolean));
assert.deepEqual((await grade("intent-trip", { ...done(4), answer: trip + "\nDay 5: rent a car to Sintra." })).slice(2), [false, true, true, true, false]);

const script = "```python\nimport sys\nfrom PIL import Image\n\ndef taken(path):\n    return Image.open(path).getexif().get_ifd(0x8769).get(36867)\n\nif __name__ == \"__main__\":\n    apply = \"--apply\" in sys.argv\n    name = dt.strftime(\"%Y-%m-%d_%H%M%S\") + \".jpg\"\n```";
assert.ok((await grade("intent-photos", { ...done(3), answer: script })).every(Boolean));
assert.deepEqual((await grade("intent-photos", { ...done(3), answer: script.replace('"--apply" in sys.argv', "True") })).at(-1), false);

const page = "<style>body{background:#111}</style><script>const KEY='habits'; // weekly target\nlocalStorage.setItem(KEY, '[]')</script>";
assert.deepEqual(await grade("intent-habits", { ...done(3), files: { "index.html": page }, probe: async () => 0.04 }), [true, true, true, true, true, true, true]);
assert.deepEqual((await grade("intent-habits", { ...done(3), files: { "index.html": page + "<script>fetch('/api/habits')</script>" }, probe: async () => 1 })).slice(4), [false, true, false]);

console.log("simulated user: ok");
