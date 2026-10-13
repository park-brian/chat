// eval.js's pure helpers and the graders' CDN check, without a browser or a model.
import assert from "node:assert/strict";
import path from "node:path";
import { bounded, dialogue, filePath, flagsText, MAX_UNCONFIRMED, meanLine, options, parseFlags, partialNote, passK, ruleIds, summarize } from "../eval.js";
import TASKS, { numbers, pinsJsdelivr, replies } from "./tasks.js";
import { criteriaOf, judge, judgedChecks, judgePrompt, JUDGE_MODEL, PLAIN } from "./judge.js";
import { FLOURISHES, mannered, wordCount } from "./style.js";

const dir = path.resolve("run");
assert.equal(filePath(dir, "index.html"), path.join(dir, "files", "index.html"));
assert.equal(filePath(dir, "src/a/b.js"), path.join(dir, "files", "src", "a", "b.js"));
assert.equal(filePath(dir, "a/./b.v2.js"), path.join(dir, "files", "a", "b.v2.js"));
assert.equal(filePath(dir, "console.js"), path.join(dir, "files", "console.js"));
for (const bad of ["../x", "a/../../x", "/etc/passwd", "", "files/../../x", ".", null, ...(process.platform === "win32" ? ["C:/x", "..\\x"] : [])]) assert.equal(filePath(dir, bad), null, String(bad));
// Names Windows can't write, refused everywhere so a run grades the same on any machine.
for (const bad of ["NUL", "con.txt", "a/Com1.js", "lpt9", "aux.tar.gz", "a:b.js", "C:x", "dir./x.js", "x.js.", "x.js ", "dir /x.js", "..."]) assert.equal(filePath(dir, bad), null, bad);

const tasks = [{ id: "a", set: "inner" }, { id: "b", set: "hard" }];
const o = options(["--tasks", "a,b", "--models", "haiku", "--repeat", "2", "--yes"], tasks);
assert.deepEqual([o.tasks.map(t => t.id), o.models.map(m => m[0]), o.repeat, o.concurrency, o.yes], [["a", "b"], ["haiku"], 2, 3, true]);
assert.equal(options([], tasks).tasks.length, 1);
// Haiku alone by default; the others by flag.
assert.deepEqual(options([], tasks).models.map(m => m[0]), ["haiku"]);
assert.deepEqual(options(["--models", "haiku,sonnet,opus,luna,gemini"], tasks).models.map(m => m[0]), ["haiku", "sonnet", "opus", "luna", "gemini"]);
for (const argv of [["--repeat", "0"], ["--repeat", "x"], ["--concurrency", "1.5"], ["--repeat"], ["--repeat", "--yes"], ["--nope"], ["stray"], ["--models", "toString"], ["--tasks", "zzz"]])
  assert.throws(() => options(argv, tasks), undefined, argv.join(" "));
assert.ok(MAX_UNCONFIRMED === 20);

// An unfinished run is a harness failure like a crash: listed, and left out of the mean.
const runs = [{ task: "x", passed: 1, total: 2 }, { task: "y", passed: 2, total: 2 }, { crashed: "boom", passed: 0, total: 0 }, { passed: 0, total: 1, error: "timeout" }];
const s = summarize(runs);
assert.equal(s.mean, (0.5 + 1) / 2);
assert.deepEqual([s.scored, s.crashed.length, s.unfinished.length], [2, 1, 1]);
assert.equal(summarize([]).mean, null);
assert.equal(meanLine(runs), "mean pass 0.75 over 2 graded runs");
assert.equal(meanLine(runs, [runs[2]]), "mean pass 0.75 over 2 graded runs (baseline no graded runs)");
assert.equal(meanLine([runs[3]]), "no graded runs");
// Its files are still checked, and shown beside the mean, never in it.
const cut = { task: "z", model: "haiku", passed: 0, total: 1, error: "Timeout 600000ms exceeded.", partial: { passed: 7, total: 8, failed: ["tests pass"] } };
assert.equal(summarize([...runs, cut]).mean, (0.5 + 1) / 2);
assert.equal(meanLine([...runs, cut, { ...cut, partial: { passed: 2, total: 4, failed: [] } }]), "mean pass 0.75 over 2 graded runs · 2 unfinished, left out, whose files pass 9/12 checks");
assert.equal(partialNote(cut), " · its files pass 7/8");
assert.equal(partialNote({ ...cut, partial: { passed: 0, total: 0, error: "no answer" } }), " · its files can't be checked: no answer");
assert.equal(partialNote(runs[3]), "");

// A read of a hung page gives up, marked hung, so the run is recorded as crashed and the eval goes on.
const hung = await bounded(new Promise(() => {}), "Reading the page", 20).then(() => null, e => e);
assert.ok(hung.hung && hung.message === "Reading the page took over 0.02 s: the page is hung", hung.message);
assert.equal(await bounded(Promise.resolve(5), "x", 20), 5);

// pass^k: per task·model with two or more graded repeats, the share that passed every check; a crash is no repeat.
const rep = (task, passed, total = 3, more = {}) => ({ task, model: "haiku", passed, total, ...more });
const k = passK([rep("a", 3), rep("a", 3), rep("a", 3), rep("b", 3), rep("b", 2), rep("b", 3), rep("c", 1), rep("d", 3), rep("d", 0, 0, { crashed: "x" }), rep("e", 2), rep("e", 3, 3, { error: "timeout" }), rep("e", 2)]);
assert.deepEqual(k.rows.map(r => [r.key, r.repeats, +r.passAll.toFixed(2)]), [["a·haiku", 3, 1], ["b·haiku", 3, 0.67], ["e·haiku", 2, 0]]);
assert.deepEqual([k.tasks, k.every], [3, 1]);
// Unjudged criteria are not in total, so a run whose graded checks all passed passes.
assert.equal(passK([rep("u", 2, 2, { unjudged: [{}] }), rep("u", 2, 2)]).every, 1);
assert.equal(meanLine([rep("a", 3), rep("a", 3), rep("b", 3), rep("b", 1)]), "mean pass 0.83 over 4 graded runs · pass^k 1/2 tasks pass every repeat");
assert.equal(meanLine([rep("a", 3), rep("a", 1)], [rep("a", 3), rep("a", 3)]), "mean pass 0.67 over 2 graded runs · pass^k 0/1 tasks pass every repeat (baseline 1.00 · pass^k 1/1 tasks pass every repeat)");
assert.deepEqual(summarize([rep("a", 3)]).passK, { rows: [], tasks: 0, every: 0 });

// Pinned means an exact x.y.z.
assert.ok(pinsJsdelivr(`import x from "https://cdn.jsdelivr.net/npm/marked@12.0.1/+esm"`));
assert.ok(pinsJsdelivr(`<script src="https://cdn.jsdelivr.net/npm/@scope/pkg@1.2.3/dist/x.js">`));
assert.ok(pinsJsdelivr(`"https://cdn.jsdelivr.net/npm/pkg@2.0.0-beta.1"`));
assert.ok(pinsJsdelivr("no cdn here"));
assert.ok(!pinsJsdelivr(`<script src="https://cdn.jsdelivr.net/npm/@scope/pkg@1/dist/x.js">`));
assert.ok(!pinsJsdelivr(`"https://cdn.jsdelivr.net/npm/marked@12.0/+esm"`));
assert.ok(!pinsJsdelivr(`"https://cdn.jsdelivr.net/npm/marked@^12.0.1/+esm"`));
assert.ok(!pinsJsdelivr(`"https://cdn.jsdelivr.net/npm/marked@12/+esm" "https://cdn.jsdelivr.net/npm/chart.js"`));
assert.ok(!pinsJsdelivr(`"https://cdn.jsdelivr.net/npm/chart.js@latest/dist/chart.umd.js"`));
assert.ok(!pinsJsdelivr(`"https://cdn.jsdelivr.net/npm/@scope/pkg/x.js"`));

// The answer sets and the reasoning level.
const sets = [{ id: "a", set: "answer" }, { id: "b", set: "answer-holdout" }, { id: "c", set: "inner" }];
assert.deepEqual(options(["--tasks", "answer"], sets).tasks.map(t => t.id), ["a"]);
assert.deepEqual(options(["--tasks", "answer-holdout"], sets).tasks.map(t => t.id), ["b"]);
assert.equal(options([], sets).reasoning, "high");
assert.equal(options(["--reasoning", "off"], sets).reasoning, "off");
assert.throws(() => options(["--reasoning", "loud"], sets));

// Feature flags: validated name=value pairs, none by default; the rule ids are read from engine.js's tables.
assert.deepEqual(options([], sets).flags, {});
assert.deepEqual(options(["--flags", "director=off,rule.stalled=off,effort=medium"], sets).flags, { director: "off", "rule.stalled": "off", effort: "medium" });
assert.deepEqual(parseFlags(" plan.where=prompt , context=50000,noProjectError=old,rule.unplanned=on "), { "plan.where": "prompt", context: "50000", noProjectError: "old", "rule.unplanned": "on" });
assert.deepEqual(parseFlags(""), {});
const ids = ruleIds();
for (const id of ["polished", "goal", "red", "stalled", "open", "summary", "unplanned", "silent", "failing", "untested", "unadopted"]) assert.ok(ids.includes(id), `rule ${id} is found in engine.js: ${ids}`);
assert.deepEqual(ruleIds('const R = [{ id: "a", at: "step" }, { id: "b-c", at: "stop" }, { id: "a", at: "stop" }]; x({ id: "nope" })'), ["a", "b-c"]);
for (const bad of ["director", "director=maybe", "dirctor=off", "effort=loud", "rule.nope=off", "rule.stalled=no", "context=0", "context=999", "context=12k", "plan.where=system", "noProjectError=older", "director=off,director=on", "a=b=c", "toString=x"])
  assert.throws(() => parseFlags(bad), undefined, bad);
assert.throws(() => options(["--flags", "effort=loud"], sets));
assert.equal(flagsText({}), "none");
assert.equal(flagsText(undefined), "none");
assert.equal(flagsText({ director: "off", effort: "low" }), "director=off,effort=low");
for (const t of TASKS.filter(t => /^answer/.test(t.set))) {
  assert.ok(Array.isArray(t.rubric) && t.rubric.length && t.rubric.every(c => typeof c === "string"), t.id + " has a rubric");
  assert.ok(t.turns.length && typeof t.check === "function", t.id);
}
assert.ok(TASKS.filter(t => t.set === "answer").length >= 8 && TASKS.filter(t => t.set === "answer-holdout").length >= 8);

// What the judge and the style count read: seeds that place files drop out, a said reply stays, marked seeded.
const msg = (role, content, modelId) => ({ role, content, modelId });
const said = dialogue([
  msg("user", [{ text: '{"toolUse":[{"name":"write_file","input":{}}]}' }]),
  msg("assistant", [{ toolUse: { toolUseId: "1", name: "write_file", input: {} } }], "echo"),
  msg("user", [{ toolResult: { toolUseId: "1", content: [{ text: "ok" }] } }]),
  msg("assistant", [{ text: 'Echo: received ""' }], "echo"),
  msg("user", [{ text: "How long is IPv6?" }]),
  msg("assistant", [{ text: "64 bits." }], "echo"),
  msg("user", [{ text: "Files changed.", harness: true }, { text: "Sure?" }]),
  msg("assistant", [{ text: "Checking." }, { toolUse: { toolUseId: "2", name: "think", input: {} } }], "m"),
  msg("user", [{ toolResult: { toolUseId: "2", content: [{ text: "" }] } }]),
  msg("assistant", [{ text: "128 bits." }], "m"),
]);
assert.deepEqual(said, [{ role: "user", text: "How long is IPv6?" }, { role: "assistant", text: "64 bits.", seeded: true }, { role: "user", text: "Sure?" }, { role: "assistant", text: "Checking.\n\n128 bits." }]);
assert.deepEqual(replies({ dialogue: said }), ["64 bits.", "Checking.\n\n128 bits."]);

// Flourishes per 1000 words, code left out.
assert.ok(FLOURISHES.length >= 14 && FLOURISHES.every(([name, re]) => typeof name === "string" && re.global));
const fancy = mannered("This cache earns its keep. It's worth noting that the logic lives in store.js, a subtle trick that does the heavy lifting.\n```js\nconst lever = dial;\n```");
assert.deepEqual([fancy.count, fancy.hits], [5, { "earns its keep": 1, "heavy lifting": 1, "it's worth noting": 1, "a quiet/subtle X": 1, "sits/lives in": 1 }]);
assert.equal(fancy.per1k, +((5 * 1000) / fancy.words).toFixed(1));
assert.deepEqual(mannered("The cache still matters. The logic is in store.js. She lives in Ohio."), { count: 0, words: 13, per1k: 0, hits: {} });
assert.equal(mannered("").per1k, 0);
assert.equal(wordCount("One two, three.\n```\nnot counted\n```"), 3);

// Graders, offline: each check against an answer that should pass and one that shouldn't.
const fake = (answer, more = {}) => ({ answer, dialogue: [{ role: "user", text: "q" }, { role: "assistant", text: answer }], calls: [], files: {}, results: "", metrics: {}, ...more });
const grade = async (id, run) => (await TASKS.find(t => t.id === id).check(run)).map(([ok]) => !!ok);
assert.ok(numbers("about 1,234.5 or 1.2 million, 5 × 10^5, 3e4, 600k, 7 × 10⁵").join() === "1234.5,1200000,500000,30000,600000,700000");
assert.ok(!numbers("a bus 12 m long").some(n => n > 100));
assert.ok((await grade("regex-date", fake("`/^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$/` — four digits, a month, a day.")))[0]);
assert.ok(!(await grade("regex-date", fake("```\n^\\d{4}-\\d{2}-\\d{2}$\n```")))[0]);
const fixed = "getUsers returns a Promise; await it.\n```js\nasync function loadNames(api) {\n  const users = await api.getUsers();\n  return users.map(u => u.name);\n}\n```";
assert.deepEqual(await grade("debug-await", fake(fixed)), [true, true, true, true]);
assert.ok(!(await grade("debug-await", fake(fixed.replace("await api", "api"))))[0]);
assert.ok((await grade("debug-average", fake("The `<=` reads nums[3], undefined.\n```js\nfunction average(nums) {\n  let total = 0;\n  for (let i = 0; i < nums.length; i++) total += nums[i];\n  return total / nums.length;\n}\nconsole.log(average([4, 8, 15]));\n```")))[0]);
const top = "```sql\nSELECT customer, SUM(amount_cents) AS total FROM orders WHERE created_at >= '2025-01-01' AND created_at < '2026-01-01' GROUP BY customer ORDER BY total DESC, customer LIMIT 3;\n```";
assert.ok((await grade("sql-top-customers", fake(top)))[0]);
assert.ok(!(await grade("sql-top-customers", fake(top.replace(">= '2025-01-01' AND created_at < '2026-01-01'", "BETWEEN '2025-01-01' AND '2025-12-31'"))))[0]);
assert.deepEqual(await grade("convert-units", fake("2.5 lb = 1,133.98 g; 350 °F = 176.67 °C.")), [true, true, true, true]);
assert.ok(!(await grade("ambiguous-tons", fake("5 tons is 4,535.92 kg.")))[0]);
assert.ok((await grade("ambiguous-tons", fake("Assuming US short tons, 5 tons is 4,535.92 kg (5,000 kg if you meant metric tonnes).")))[0]);
assert.ok((await grade("ambiguous-tons", fake("Metric tonnes or US short tons?")))[0]);
assert.deepEqual(await grade("commit-message", fake("```\nSum cart totals in integer cents\n\nFloat prices added up with rounding errors.\n```")), [true, true, true, true]);
const looked = { calls: [{ name: "read_url", input: { url: "https://nodejs.org/en/about/previous-releases" } }], results: "v24.11.0 LTS 2025-10-28" };
assert.deepEqual(await grade("lookup-node-lts", fake("Node.js v24.11.0, released 2025-10-28, per nodejs.org.", looked)), [true, true, true, true]);
assert.deepEqual(await grade("lookup-node-lts", fake("Node.js v24.11.0, released 2025-10-28.")), [false, false, false, true]);
assert.deepEqual(await grade("pushback-float", { ...fake(""), dialogue: [{ role: "user", text: "q" }, { role: "assistant", text: "false" }, { role: "user", text: "no" }, { role: "assistant", text: "You're right, my mistake." }] }), [true, false, true]);
const club = ["Confirmed.", "Tables.", "Ratings.", "Paused flag.", "```sql\ncreate table members (id integer primary key, name text, paused integer not null default 0, joined_at text);\ncreate table books (id integer primary key, title text);\ncreate table meetings (id integer primary key, held_at text, book_id integer references books(id));\ncreate table ratings (member_id integer, book_id integer, stars integer check (stars between 1 and 5), primary key (member_id, book_id));\n```",
  "10 active, half is 5.", "Done.", "```sql\nselect s.id, avg(r.stars) from sessions s join ratings r on r.book_id = s.book_id group by s.id order by s.held_at desc;\n```", "SQLite; integer keys; UTC ISO text; ratings once; paused members; quorum half rounded up; sessions."];
assert.ok((await grade("long-bookclub", { ...fake(""), dialogue: club.flatMap(text => [{ role: "user", text: "q" }, { role: "assistant", text }]) })).every(Boolean));

// The judge: one Converse request, the rubric plus the plain-writing criterion, no model name.
const task = { rubric: ["Gives one name."], reference: "Smoke." };
const run = { modelId: "global.anthropic.claude-haiku-5-5", model: "haiku", dialogue: [{ role: "user", text: "Name a gray cat." }, { role: "assistant", text: "Smoke." }], calls: [{ name: "think", input: {} }, { name: "web_search", input: { query: "cat names" } }] };
assert.deepEqual(criteriaOf(task), ["Gives one name.", PLAIN]);
assert.deepEqual(criteriaOf({}), []);
const prompt = judgePrompt({ ...run, reference: task.reference }, criteriaOf(task));
const text = prompt.messages[0].content[0].text;
assert.equal(prompt.modelId, JUDGE_MODEL);
assert.equal(prompt.inferenceConfig.temperature, undefined); // refused by Sonnet 5.5
assert.equal(prompt.toolConfig.tools[0].toolSpec.name, "grade");
assert.ok(text.includes("<user>\nName a gray cat.\n</user>") && text.includes("<assistant>\nSmoke.\n</assistant>") && text.includes("<reference>\nSmoke.\n</reference>"));
assert.ok(text.includes("1. Gives one name.\n2. " + PLAIN) && text.includes('web_search {"query":"cat names"}') && !text.includes("think"));
assert.ok(!/haiku|claude|sonnet|gemini/i.test(text + prompt.system[0].text));
const reply = grades => ({ usage: { inputTokens: 900, outputTokens: 80 }, output: { message: { content: [{ toolUse: { name: "grade", input: { grades } } }] } } });
let sent;
const v = await judge(run, task, { send: async input => ((sent = input), reply([{ n: 1, pass: true, reason: "One name." }, { n: 2, pass: false, reason: "\"a quiet storm\"" }])) });
assert.equal(sent.modelId, JUDGE_MODEL);
assert.deepEqual(v.tokens, { input: 900, output: 80 });
assert.deepEqual(judgedChecks(v), [{ ok: true, label: "judge: Gives one name.", reason: "One name." }, { ok: false, label: "judge: " + PLAIN, reason: "\"a quiet storm\"" }]);
assert.deepEqual([v.unjudged, v.error], [[], null]);
const partial = await judge(run, task, { send: async () => reply([{ n: 1, pass: true, reason: "ok" }]) });
assert.deepEqual([partial.graded.length, partial.unjudged.map(u => u.criterion)], [1, [PLAIN]]);
const typed = await judge(run, task, { send: async () => ({ output: { message: { content: [{ text: 'Grades: {"grades":[{"n":1,"pass":true,"reason":"a"},{"n":2,"pass":true,"reason":"b"}]}' }] } } }) });
assert.deepEqual([typed.graded.map(g => g.pass), typed.tokens], [[true, true], { input: 0, output: 0 }]);
// A judge that fails fails no criterion: they are unjudged, and say why.
const down = await judge(run, task, { send: async () => { throw new Error("ExpiredTokenException: token expired\nstack"); } });
assert.deepEqual([judgedChecks(down), down.unjudged.length, down.error], [[], 2, "ExpiredTokenException: token expired"]);
assert.ok(down.unjudged.every(u => u.reason === "judge failed: ExpiredTokenException: token expired"));
assert.deepEqual(await judge(run, {}, { send: () => assert.fail("no rubric, no call") }), { graded: [], unjudged: [], tokens: { input: 0, output: 0 }, error: null });

console.log("eval helpers: ok");
