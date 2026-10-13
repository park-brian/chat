// The long set's graders, offline: the hidden Lisp suite against the reference interpreter (100%) and stubs (fail),
// the novella grader's registry logic with a stubbed judge and a planted contradiction, and the research checks on
// hand-made runs. node evals/long.test.js; exits nonzero on a failure.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import LONG, { gradeLisp, gradeNovella, gradeResearch, LONG_DIR, lispSuite, ownTests, passes, researchScripted, unbackedClaims } from "./long.js";
import TASKS from "./tasks.js";
import { options, SETS } from "../eval.js";

let failures = 0;
const ok = (cond, message) => {
  if (cond) console.log("ok   " + message);
  else { failures++; console.log("FAIL " + message); }
};
const labels = checks => checks.filter(([pass]) => !pass).map(([, l]) => l);

// Wiring: in tasks.js, in the long set, an hour to run.
assert.ok(SETS.includes("long"));
assert.deepEqual(options(["--tasks", "long"]).tasks.map(t => t.id), ["long-lisp", "long-novella", "long-research"]);
for (const t of LONG) {
  assert.ok(TASKS.includes(t), t.id + " is in tasks.js");
  assert.equal(t.set, "long");
  assert.ok(t.timeout >= 45 * 60_000, t.id + " has a long timeout");
  assert.ok(t.turns.length === 1 && typeof t.turns[0] === "string");
}

// ---- long-lisp
const suite = lispSuite();
const all = suite.flatMap(g => g.programs);
assert.ok(all.length >= 150, `${all.length} hidden programs`);
assert.equal(new Set(all.map(p => p.id)).size, all.length);
assert.ok(suite.filter(g => !g.optional).length >= 14 && suite.some(g => g.optional));
// The matcher: trailing whitespace aside; an error program ends in an Error line after the expected text.
assert.ok(passes({ expect: "1\n2" }, { output: "1\n2\n" }));
assert.ok(!passes({ expect: "12" }, { output: "1\n2" }));
assert.ok(passes({ expect: "before", error: true }, { output: "before\nError: boom" }));
assert.ok(passes({ expect: "", error: true }, { output: "Error: unbound variable: x" }));
assert.ok(!passes({ expect: "before", error: true }, { output: "before" }));
assert.ok(!passes({ expect: "before", error: true }, { output: "before\nafter\nError: boom" }));
assert.ok(!passes({ expect: "x" }, { threw: "TypeError" }));

const reference = readFileSync(path.join(LONG_DIR, "lisp", "reference", "lisp.js"), "utf8");
const lispRun = (files, answer = "", results = "") => ({ files, answer, results, calls: [], metrics: {} });
{
  const r = lispRun({ "lisp.js": reference, "lisp.test.js": "import { run } from './lisp.js';\nassert.equal(run('(display 1)'), '1');" });
  const checks = await gradeLisp(r);
  ok(checks.every(([pass]) => pass), `reference passes every check (${labels(checks).join("; ") || "all"})`);
  ok(r.metrics.hiddenPassed === r.metrics.hiddenTotal && r.metrics.hiddenOptional === suite.find(g => g.optional).programs.length, `reference: ${r.metrics.hiddenPassed}/${r.metrics.hiddenTotal}, macros ${r.metrics.hiddenOptional}`);
}
{
  // A stub that prints nothing, one that throws, and none at all fail every hidden check.
  for (const [name, source] of [["empty stub", "export function run(source) { return ''; }"], ["throwing stub", "export function run() { throw new Error('todo'); }"], ["no export", "export const x = 1;"]]) {
    const checks = await gradeLisp(lispRun({ "lisp.js": source }));
    const hidden = checks.filter(([, l]) => /hidden programs/.test(l));
    ok(hidden.length === suite.filter(g => !g.optional).length + 1 && hidden.every(([pass]) => !pass), `${name} fails every hidden check`);
  }
  const none = await gradeLisp(lispRun({ "index.html": "<p>hi</p>" }));
  ok(none.filter(([pass]) => !pass).length === none.length - 1 && /wrote lisp.js/.test(none[0][1]), "no lisp.js fails all but the claims check");
}
{
  // Without tail calls the tail-call group fails and the rest pass: the reference with its loop turned into recursion.
  const noTco = reference.replace("function evaluate(x, env) {\n  for (;;) {", "function evaluate(x, env) {\n  return evalOnce(x, env);\n}\nfunction evalOnce(x, env) {\n  for (;;) {").replaceAll(/\n(\s+)continue;/g, "\n$1return evaluate(x, env);");
  assert.notEqual(noTco, reference);
  const checks = await gradeLisp(lispRun({ "lisp.js": noTco }));
  const failed = labels(checks);
  ok(failed.some(l => l.startsWith("tail-calls:")) && !failed.some(l => /^(numbers|lists|lambda|let):/.test(l)), `an interpreter without tail calls fails tail-calls only among groups (${failed.map(l => l.split(":")[0]).join(", ")})`);
}
{
  // A hang is cut off by the per-program timeout and fails that program.
  const hang = `import { run as real } from "./real.js";\nexport function run(s) { if (s.includes("fib")) for (;;); return real(s); }`;
  const r = lispRun({ "lisp.js": hang, "real.js": reference });
  const checks = await gradeLisp(r, { timeoutMs: 2000 });
  ok(checks.some(([pass, l]) => pass && l.startsWith("recursion: 10/11")) && r.metrics.hiddenPassed === r.metrics.hiddenTotal - 1, "a hanging program times out and fails alone");
}
// Own tests and claims.
assert.deepEqual(ownTests({ "lisp.js": "export function run(){}", "test/lisp.test.js": "import { run } from '../lisp.js'; test('x', () => {})" }, "lisp.js"), { external: ["test/lisp.test.js"], inFile: false });
assert.deepEqual(ownTests({ "lisp.js": "export function run(){}\n// #region TESTS\n" }, "lisp.js"), { external: [], inFile: true });
assert.deepEqual(ownTests({ "lisp.js": "export function run(){}", "notes.md": "tests later" }, "lisp.js"), { external: [], inFile: false });
assert.deepEqual(unbackedClaims("All 42 tests passed.", '{"passed": 42, "failed": 0}'), []);
assert.deepEqual(unbackedClaims("42/42 tests pass.", "PASS: x\n42 passed, 0 failed"), []);
assert.deepEqual(unbackedClaims("All 42 tests passed.", '{"passed": 40, "failed": 2}'), ["42"]);
assert.deepEqual(unbackedClaims("It works.", ""), []);
{
  const checks = await gradeLisp(lispRun({ "lisp.js": reference }, "All 99 tests passed.", '{"passed": 12}'));
  ok(labels(checks).length === 2 && labels(checks).some(l => /own tests/.test(l)) && labels(checks).some(l => /claims 99/.test(l)), "no tests and an unbacked claim fail their two checks");
}

// ---- long-novella: a 3-chapter story, a judge stub that answers from what it is shown.
const words = (n, tag) => Array.from({ length: n }, (_, i) => tag + (i % 50)).join(" ");
const story = {
  "chapters/01.md": `# One\n\nIsla Mackay is 34. She walks to the lighthouse.\n\n${words(120, "a")}`,
  "chapters/02.md": `# Two\n\nIsla talks to Callum in the harbour.\n\n${words(120, "b")}`,
  "chapters/03.md": `# Three\n\nThe forty-year-old Isla reads the logbook.\n\n${words(120, "c")}`,
};
const FACTS = { 1: ["Isla Mackay is 34 years old."], 2: ["Callum is in the harbour."], 3: ["Isla reads the logbook."] };
const seen = [];
const stub = async input => {
  const text = input.messages[0].content[0].text, system = input.system[0].text;
  seen.push({ system, text });
  const tool = value => ({ usage: { inputTokens: 100, outputTokens: 10 }, output: { message: { content: [{ toolUse: { name: "answer", input: value } }] } } });
  if (system.startsWith("You read chapters")) {
    const ns = [...text.matchAll(/<chapter n="(\d+)">/g)].map(m => Number(m[1]));
    return tool({ chapters: ns.map(n => ({ chapter: n, summary: `Chapter ${n} happens.`, facts: FACTS[n] })) });
  }
  if (system.startsWith("You check chapters")) {
    const ns = [...text.matchAll(/<chapter n="(\d+)">/g)].map(m => Number(m[1]));
    // A contradiction only when the registry says 34 and the chapter says forty; a fact must come from before.
    return tool({ verdicts: ns.map(n => {
      const chapter = text.split(`<chapter n="${n}">`)[1].split("</chapter>")[0];
      const clash = /\[ch [12]\] Isla Mackay is 34/.test(text) && /forty-year-old Isla/.test(chapter);
      return { chapter: n, contradiction: clash, details: clash ? "Isla is forty here; chapter 1 says 34" : "none" };
    }) });
  }
  if (/pays off/.test(system)) return tool({ threads: [{ question: "Who tore out the pages?", opened_in: 1, resolved: true, resolved_in: 3, evidence: "x" }] });
  if (/ending meets/.test(system)) return tool({ conditions: [{ n: 1, holds: true, evidence: "x" }, { n: 2, holds: false, evidence: "not named" }] });
  if (/summaries/.test(system)) return tool({ repeats: [] });
  return tool({ pass: true, reason: "plain" });
};
{
  const { checks, m } = await gradeNovella(story, { send: stub, count: 3, minWords: 100, maxWords: 200, conditions: ["ferry returns", "culprit named"] });
  const byLabel = re => checks.find(([, l]) => re.test(l));
  ok(byLabel(/^all 3 chapters/)[0] && byLabel(/words/)[0], "3 chapters, within bounds");
  ok(byLabel(/^chapter 2 contradicts/)[0] === true, "chapter 2 has no contradiction");
  ok(byLabel(/^chapter 3 contradicts/)[0] === false && /forty/.test(byLabel(/^chapter 3/)[1]), "chapter 3's planted contradiction is found");
  ok(byLabel(/threads/)[0] === true && byLabel(/ending holds/)[0] === false && /culprit named/.test(byLabel(/ending holds/)[1]), "threads resolved; the failed ending condition is named");
  ok(byLabel(/repeats/)[0] && byLabel(/plain writing/)[0] && byLabel(/copied/)[0], "repeats, plain writing and copies pass");
  ok(m.calls <= 20 && m.calls === seen.length, `judge calls bounded (${m.calls})`);
  // The registry each check saw holds only earlier chapters' facts.
  const checksSeen = seen.filter(s => s.system.startsWith("You check chapters"));
  ok(checksSeen.every(s => !/\[ch 3\]/.test(s.text)) && checksSeen.some(s => /\[ch 1\] Isla Mackay is 34/.test(s.text)), "the registry passed to the check holds earlier facts only");
}
{
  // Full size: 12 chapters stay within 20 judge calls; a missing chapter and one out of bounds fail their checks.
  const twelve = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`chapters/${String(i + 1).padStart(2, "0")}.md`, `Chapter ${i + 1}.\n\n${words(1500, "c" + i + "x")}`]));
  delete twelve["chapters/07.md"];
  twelve["chapters/09.md"] = words(300, "short");
  seen.length = 0;
  const { checks, m } = await gradeNovella(twelve, { send: stub });
  ok(m.calls <= 20, `12 chapters: ${m.calls} judge calls`);
  ok(labels(checks).some(l => /missing 7/.test(l)) && labels(checks).some(l => /ch 9: 30\d/.test(l)) && labels(checks).some(l => /^chapter 7 contradicts no earlier fact \(missing\)/.test(l)), "a missing chapter and a short one fail");
  const copied = await gradeNovella({ ...story, "chapters/03.md": story["chapters/01.md"].replace("# One", "# Three") }, { send: stub, count: 3, minWords: 100, maxWords: 200 });
  ok(labels(copied.checks).some(l => /copied between chapters \(ch 1 and 3\)/.test(l)), "a copied paragraph is found");
  const entry = `*9.10. ${words(40, "log")}.*`;
  const quoted = await gradeNovella({ ...story, "chapters/01.md": story["chapters/01.md"] + "\n\n" + entry, "chapters/03.md": story["chapters/03.md"] + "\n\n" + entry }, { send: stub, count: 3, minWords: 100, maxWords: 300 });
  ok(!labels(quoted.checks).some(l => /copied/.test(l)), "a quoted document read again in a later chapter is not a copy");
  const broken = await gradeNovella(story, { send: async () => { throw new Error("throttled"); }, count: 3, minWords: 100, maxWords: 200 });
  ok(broken.checks.filter(([pass]) => !pass).length === broken.checks.length - 3 && broken.m.calls <= 20, "a failing judge fails the judged checks, within the call bound");
}

// ---- long-research: hand-made runs.
const SOURCES = ["https://www.rfc-editor.org/rfc/rfc5321", "https://www.rfc-editor.org/errata/eid1690", "https://www.rfc-editor.org/rfc/rfc9110", "https://www.rfc-editor.org/rfc/rfc1035", "https://pages.nist.gov/800-63-4/sp800-63b.html", "https://www.itu.int/rec/T-REC-E.164", "https://en.wikipedia.org/wiki/Bcrypt", "https://www.rfc-editor.org/rfc/rfc3696", "https://www.rfc-editor.org/rfc/rfc1123", "https://html.spec.whatwg.org/multipage/input.html", "https://support.microsoft.com/kb/208427"];
const page = "The maximum total length of a reverse-path or forward-path is 256 octets. limit 254. local part 64, domain 255, 320. 8000 octets. labels 63 octets, names 255 octets. a minimum of 15 characters, at least 64 characters. 15 digits. 72 bytes. 2083 characters. 2048";
const goodReport = `# Form length limits

| Field | Limit |
|---|---|
| Email | 254 |

The email limit is 254 characters: RFC 5321 caps a path at 256 octets including the angle brackets ([RFC 5321](${SOURCES[0]}), [erratum 1690](${SOURCES[1]})). The 320 figure from RFC 3696 is wrong ([RFC 3696](${SOURCES[7]})).
URLs: no standard limit; support at least 8000 octets ([RFC 9110](${SOURCES[2]})). Old IE stopped at 2083 ([Microsoft](${SOURCES[10]})).
Labels 63, names 255 ([RFC 1035](${SOURCES[3]}), [RFC 1123](${SOURCES[8]})). Passwords at least 15, allow 64 ([NIST](${SOURCES[4]})); bcrypt reads 72 bytes ([bcrypt](${SOURCES[6]})). Phones 15 digits ([E.164](${SOURCES[5]})). Display names: no standard ([HTML](${SOURCES[9]})).`;
const reads = SOURCES.map((url, i) => ({ name: "read_url", toolUseId: "r" + i, input: { url } }));
const researchRun = ({ report = goodReport, calls = reads, plan = true, printed = page, answer = "Saved report.md: email 254, not 320; no URL cap in the standard." } = {}) => ({
  files: { "report.md": report, ...(plan && { "PLAN.md": "# Plan" }) },
  answer,
  calls,
  outcomes: Object.fromEntries(calls.map(c => [c.toolUseId, printed])),
  results: printed,
  metrics: {},
});
// The grader's own read of a page is stubbed: offline, every cited page reads as nothing unless a test says so.
const blank = async () => "";
const scripted = async (r, readPage = blank) => labels((await researchScripted(r, { readPage })).checks);
const has = async (r, re, readPage) => (await scripted(r, readPage)).some(l => re.test(l));
{
  const good = await scripted(researchRun());
  ok(good.length === 0, `a good run passes the scripted checks (${good.join("; ") || "all"})`);
}
ok(await has(researchRun({ report: goodReport.replace("The email limit is 254 characters", "The email limit is 320 characters").replace("The 320 figure from RFC 3696 is wrong", "RFC 3696 agrees") }), /corrects the email limit/), "repeating 320 as the limit fails the trap");
// Naming the source of the 320 figure, or today's value in a table, is not repeating it.
ok(!(await has(researchRun({ report: goodReport + "\n- Verified from the primary text: RFC 5321 (path, local part, domain limits), RFC 3696 (the 320 sentence).\n| Email | today 320 | recommended 254 |" }), /corrects the email limit/)), "mentioning where 320 comes from passes");
ok(await has(researchRun({ calls: reads.slice(0, 5) }), /8 cited links were fetched in the run \(5/), "links not fetched fail");
ok(await has(researchRun({ calls: reads.slice(2) }), /RFC 5321 or erratum 1690.*not fetched/), "an unfetched primary source fails");
ok(await has(researchRun({ plan: false }), /PLAN\.md/), "no PLAN.md fails");
ok(await has(researchRun({ report: goodReport + "\nMost users pick 12345 or 54321 characters." }), /not found: 12345/), "a number on no fetched page fails");
// A run that fetched in code and printed only an excerpt: the numbers are found on the pages, read by the grader.
ok(await has(researchRun({ printed: "ok" }), /numbers in the report.*not found/), "excerpt only, pages unread: numbers not found");
ok(!(await has(researchRun({ printed: "ok" }), /numbers in the report/, async () => page)), "excerpt only, pages read by the grader: numbers found");
// Search results alone don't count as fetched.
ok(await has(researchRun({ calls: [{ name: "web_search", toolUseId: "s", input: { query: SOURCES.join(" ") } }] }), /fetched in the run \(0/), "a search result is not a fetch");
{
  const judged = async () => ({ usage: { inputTokens: 5, outputTokens: 5 }, output: { message: { content: [{ toolUse: { name: "answer", input: { grades: [1, 2, 3, 4, 5, 6, 7].map(n => ({ n, pass: n !== 4, reason: "r" })) } } }] } } });
  const { checks, m } = await gradeResearch(researchRun(), { send: judged, readPage: blank });
  ok(m.calls === 1 && labels(checks).length === 1 && /organized/.test(labels(checks)[0]), "the report judge: one call, its failed criterion fails");
}

console.log(failures ? `\n${failures} failed` : "\nall long-set grader checks pass");
process.exit(failures ? 1 : 0);
