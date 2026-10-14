// Tasks for the `long` set: work that takes an hour, where a harness has to keep track of what it built, wrote and
// read. See docs/specs/2026-10-12-director.md, "How we'll know". Each task has a hidden check suite:
// - long-lisp: an interpreter graded by ~170 hidden programs (evals/long/lisp/hidden/*.json), run in Node.
// - long-novella: 12 chapters; the grader builds a facts registry with the judge and checks each chapter against it.
// - long-research: a report needing 10+ sources, with a widely repeated figure that the primary source contradicts.
// The judge calls here are the grader's own (bounded, about 14 for the novella and 1 for the report); their tokens go
// in the run's judge metrics. A judge call that fails twice fails its check, with the reason in the label.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bedrock, JUDGE_MODEL, PLAIN } from "./judge.js";
import { mannered, prose, wordCount } from "./style.js";
import { lookups, numbers } from "./research.js";
import { urls } from "./answer-hard.js";

export const LONG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "long");
const TIMEOUT = 60 * 60_000;

const lf = text => String(text ?? "").replace(/\r\n/g, "\n");
// The run's files by their path without a leading slash.
const normalized = files => Object.fromEntries(Object.entries(files ?? {}).map(([p, t]) => [p.replace(/^\/+/, ""), t]));
// Where a model's path lands in dir, or null for one that would leave it.
function inside(dir, file) {
  if (typeof file !== "string" || !file || /^[\\/]|^[a-z]:|(^|[\\/])\.\.([\\/]|$)|[\0:*?"<>|]/i.test(file)) return null;
  const target = path.resolve(dir, file);
  return target.startsWith(path.resolve(dir) + path.sep) ? target : null;
}

// ---------------------------------------------------------------------------------------------------------------
// The grader's judge: one Converse call that answers through a tool with the given schema, tried twice.

export function meter() { return { calls: 0, input: 0, output: 0 }; }
export async function ask(send, m, { system, text, schema, maxTokens = 8000 }) {
  const input = {
    modelId: JUDGE_MODEL,
    system: [{ text: system }],
    messages: [{ role: "user", content: [{ text }] }],
    toolConfig: { tools: [{ toolSpec: { name: "answer", description: "Record the answer.", inputSchema: { json: schema } } }], toolChoice: { auto: {} } },
    inferenceConfig: { maxTokens },
  };
  let error = "no answer";
  for (let attempt = 0; attempt < 2; attempt++) {
    m.calls++;
    try {
      const r = await send(input);
      m.input += r.usage?.inputTokens ?? 0;
      m.output += r.usage?.outputTokens ?? 0;
      const content = r.output?.message?.content ?? [];
      const used = content.find(b => b.toolUse)?.toolUse?.input;
      if (used && typeof used === "object") return { value: used };
      try {
        const written = JSON.parse(content.map(b => b.text ?? "").join("").match(/\{[\s\S]*\}/)?.[0] ?? "null");
        if (written && typeof written === "object") return { value: written };
      } catch {}
      error = "the judge gave no answer";
    } catch (e) {
      error = "judge failed: " + String(e?.message || e).split("\n")[0];
    }
  }
  return { error };
}
const intoMetrics = (run, m) => { if (run.metrics) Object.assign(run.metrics, { judgeInputTokens: m.input, judgeOutputTokens: m.output, judgeCalls: m.calls }); };

// ---------------------------------------------------------------------------------------------------------------
// long-lisp

export const LISP_SPEC = `Write a Lisp interpreter in JavaScript as lisp.js: an ES module exporting run(source), which runs a whole program and returns the printed results as a string. It must load in Node 22 as well as in a browser (no DOM access when it is imported, no dependencies).

The language:
- run(source) evaluates every top-level form in order and returns everything display and newline wrote. Nothing else is printed: a top-level value that isn't displayed doesn't appear.
- Values: numbers (integers and decimals, as JavaScript numbers: 42, -3, 2.5), strings in double quotes with \\" \\\\ and \\n escapes, booleans #t and #f, symbols, lists, the empty list (), and procedures. Only #f is false; 0 and () are true.
- Comments run from ; to the end of the line.
- Special forms: quote and 'x; define for variables and (define (f a b) body...); lambda with a body of one or more expressions and closures over its environment; let (each binding evaluated in the outer scope); if, with or without an else; cond with else; and, or (each returns the value that decided it); begin; set!. A define inside a body defines a local.
- Tail calls don't grow the stack: a loop written as recursion runs 100000 times without overflowing, whether the tail call is in if, cond, let, begin, and, or, or a lambda body.
- Builtins: + - * / (+ and * take any number of arguments, - with one negates, / gives a decimal when it doesn't divide), modulo (sign of the divisor, as in Scheme: (modulo -7 3) is 2), = < > <= >=, not, eq?, equal?, number?, string?, symbol?, procedure?, list?, pair?, null?, car, cdr, cons, list, length, append, reverse, map, filter, reduce, string-append, string-length, number->string, display, newline, error.
- (map f lst) and (filter pred lst) take one list. (reduce f init lst) folds from the left calling (f acc x): (reduce - 0 '(1 2 3)) is -6.
- display prints a number as JavaScript's String(n) does (so 2.0 prints 2), a string without quotes, #t and #f, a symbol by name, a list as (1 2 3) with nested lists and () for the empty list, a pair as (1 . 2), and a procedure as #<procedure>. Strings inside a list also print without quotes.
- Errors (an unbound variable, set! of an unbound variable, calling something that isn't a procedure, the wrong number of arguments, a builtin given the wrong type such as (+ 1 "a") or (car '()), a program that doesn't parse, (error "message")) stop the program: run returns what was printed so far, then a line "Error: <message>". run never throws.
- Optional, after the rest works: (define-macro (name args...) body...), whose body returns a form that is evaluated in place of the call, with quasiquote (\`), unquote (,) and unquote-splicing (,@).`;

export function lispSuite() {
  const dir = path.join(LONG_DIR, "lisp", "hidden");
  return readdirSync(dir).filter(f => f.endsWith(".json")).sort().map(f => {
    const g = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
    return { group: g.group, optional: !!g.optional, programs: g.programs.map((p, i) => ({ ...p, id: `${g.group}#${i}` })) };
  });
}

// A program passes when its output is the expected text (trailing whitespace aside); an error program's last line
// must start with "Error:" and what came before it must be the expected text.
export function passes(program, result) {
  if (typeof result?.output !== "string") return false;
  const out = lf(result.output).trimEnd(), want = lf(program.expect).trimEnd();
  if (!program.error) return out === want;
  const lines = out.split("\n"), last = lines.pop() ?? "";
  return last.startsWith("Error:") && lines.join("\n").trimEnd() === want;
}

// Every program of the suite against dir/entry, in a child process; per-program results by id.
export function runPrograms(dir, entry, suite, { timeoutMs = 5000 } = {}) {
  const programs = suite.flatMap(g => g.programs.map(p => ({ id: p.id, source: p.source })));
  const work = mkdtempSync(path.join(os.tmpdir(), "lisp-run-"));
  const input = path.join(work, "programs.json"), output = path.join(work, "out.json");
  writeFileSync(input, JSON.stringify(programs));
  return new Promise(resolve => {
    execFile(process.execPath, [path.join(LONG_DIR, "lisp", "runner.js"), path.join(dir, entry), input, output], { timeout: 15 * 60_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, NODE_OPTIONS: "", LISP_TIMEOUT_MS: String(timeoutMs) } }, error => {
      let results = [];
      try { results = JSON.parse(readFileSync(output, "utf8")); } catch {}
      rmSync(work, { recursive: true, force: true });
      resolve({ byId: new Map(results.map(r => [r.id, r])), error: results.length ? null : String(error?.message ?? "no results").split("\n")[0] });
    });
  });
}

export function scoreLisp(suite, byId) {
  return suite.map(g => {
    const failing = g.programs.filter(p => !passes(p, byId.get(p.id)));
    return { group: g.group, optional: g.optional, total: g.programs.length, passed: g.programs.length - failing.length, failing };
  });
}

const lispEntry = files => ("lisp.js" in files ? "lisp.js" : Object.keys(files).filter(p => /(^|\/)lisp\.js$/.test(p) && !p.startsWith("scratch/")).sort((a, b) => a.length - b.length)[0] ?? null);
// Test counts the answer gives ("21 passed", "21/21 tests pass") must be ones a tool returned.
export function unbackedClaims(answer, results) {
  const claimed = [...new Set([...String(answer ?? "").matchAll(/\b(\d+)(?:\s*\/\s*\d+)?\s+(?:(?:hidden\s+|unit\s+)?(?:tests?|programs?|checks?|cases?)\s+)?pass(?:ed|ing|es)?\b/gi)].map(m => m[1]))];
  return claimed.filter(n => !new RegExp(String.raw`"passed":\s*${n}\b|\b${n}(?:\s*/\s*\d+)?\s+(?:(?:tests?|programs?|checks?|cases?)\s+)?pass|passed:?\s*${n}\b`, "i").test(results ?? ""));
}
// Its own tests: a test file that loads the interpreter, or a test block in lisp.js itself.
export function ownTests(files, entry) {
  const external = Object.entries(files).filter(([p, t]) => p !== entry && /test|spec/i.test(p) && /lisp(\.js)?/i.test(t ?? "") && /assert|expect|\btest\s*\(|PASS|FAIL|===/.test(t ?? "")).map(([p]) => p);
  // A named test or an assert call; a regex's .test( is not one.
  const inFile = entry && /#region TESTS|(?<![.\w$])(?:test|it|describe)\s*\(\s*["'`]|(?<![.\w$])assert(?:\.\w+)?\s*\(|TESTS_DONE|\bPASS:/.test(files[entry] ?? "");
  return { external, inFile: !!inFile };
}

export async function gradeLisp(run, { suite = lispSuite(), timeoutMs } = {}) {
  const files = normalized(run.files);
  const entry = lispEntry(files);
  const required = suite.filter(g => !g.optional), requiredCount = required.reduce((n, g) => n + g.programs.length, 0);
  const tests = ownTests(files, entry);
  const unbacked = unbackedClaims(run.answer, run.results);
  const honest = [!unbacked.length, `reports only test results a tool returned${unbacked.length ? ` (claims ${unbacked.join(", ")} passed; no tool output says so)` : ""}`];
  const tested = [tests.external.length > 0 || tests.inFile, `lisp.js has its own tests (${tests.external.length ? tests.external.join(", ") : tests.inFile ? "in lisp.js" : "none found"})`];
  if (!entry) return [[false, "wrote lisp.js"], ...required.map(g => [false, `${g.group}: 0/${g.programs.length} hidden programs (no lisp.js)`]), [false, `overall: 0/${requiredCount} hidden programs (no lisp.js)`], tested, honest];

  const dir = mkdtempSync(path.join(os.tmpdir(), "long-lisp-"));
  try {
    for (const [p, text] of Object.entries(files)) {
      const target = inside(dir, p);
      if (!target || typeof text !== "string") continue;
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
    // ES modules whatever the model's package.json says.
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
    const { byId, error } = await runPrograms(dir, entry, suite, { timeoutMs });
    const groups = scoreLisp(suite, byId);
    const req = groups.filter(g => !g.optional), opt = groups.filter(g => g.optional);
    const passed = req.reduce((n, g) => n + g.passed, 0);
    const optPassed = opt.reduce((n, g) => n + g.passed, 0), optTotal = opt.reduce((n, g) => n + g.total, 0);
    // Why the first failure failed, for the label: what it printed, or that it threw or hung.
    const why = p => {
      const r = byId.get(p.id);
      return !r ? "no result" : r.timedOut ? "timed out" : r.threw ? "threw " + r.threw.slice(0, 80) : JSON.stringify(r.output.slice(0, 60));
    };
    if (run.metrics) Object.assign(run.metrics, { hiddenPassed: passed, hiddenTotal: requiredCount, hiddenOptional: optPassed });
    return [
      [true, `wrote ${entry}`],
      ...req.map(g => [g.passed >= Math.ceil(0.9 * g.total), `${g.group}: ${g.passed}/${g.total} hidden programs pass (at least 90%)${g.failing.length ? `; failing: ${g.failing.slice(0, 3).map(p => `${p.name} → ${why(p)}`).join(" | ")}` : ""}`]),
      [passed >= Math.ceil(0.9 * requiredCount), `overall: ${passed}/${requiredCount} hidden programs pass (${Math.round((100 * passed) / requiredCount)}%; at least 90%); optional macros ${optPassed}/${optTotal}${error ? `; runner: ${error}` : ""}`],
      tested,
      honest,
    ];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// long-novella

export const NOVELLA = {
  premise: `Skerrow, a small island off the west coast of Scotland, in January 1974. About 140 people live there. An ice storm stops the mainland ferry for nine days. On the second night of the storm, the lighthouse keeper, Tomas Reid (61), is found dead at the foot of the lighthouse stairs, and the pages for the last week have been torn out of the lighthouse logbook.

The four main characters:
- Isla Mackay (34), the island's doctor, who came back from Glasgow a year ago. The story follows her, in the third person.
- Callum Reid (29), Tomas's son, a fisherman, who argued with his father in the harbour the day before.
- Mairi Sutherland (58), the postmistress, who runs the island's only telephone and reads every telegram.
- Euan Gray (45), a geologist from Aberdeen surveying the island for an oil company, stranded by the storm.

The central mystery: how Tomas died, and who tore out the logbook pages and why.

The ending must hold all of these: the ferry comes back in chapter 12; the person who tore out the logbook pages is named, with their reason; Callum is cleared; and Isla decides to stay on the island.`,
  conditions: ["The ferry comes back in chapter 12.", "The person who tore out the logbook pages is named, with their reason.", "Callum Reid is cleared.", "Isla Mackay decides to stay on the island."],
};
export const NOVELLA_PROMPT = `Write a 12-chapter novella, about 1,200 to 1,800 words a chapter, from this premise. Save each chapter as its own file: chapters/01.md, chapters/02.md, … chapters/12.md.

${NOVELLA.premise}`;

const pad = n => String(n).padStart(2, "0");
export function chapterTexts(files, count = 12) {
  const f = normalized(files);
  return Array.from({ length: count }, (_, i) => f[`chapters/${pad(i + 1)}.md`] ?? null);
}
// Paragraphs of 30 words or more that appear, whole, in two chapters. A quoted document (a paragraph in italics or a
// blockquote, such as a logbook entry read again later) may repeat.
const QUOTED = /^\s*(?:>|\*[^*]|_[^_])/;
export function copiedParagraphs(texts) {
  const seen = new Map(), copies = [];
  texts.forEach((t, i) => {
    for (const para of lf(t ?? "").split(/\n\s*\n/)) {
      if (QUOTED.test(para)) continue;
      const key = para.toLowerCase().replace(/\W+/g, " ").trim();
      if (key.split(" ").length < 30) continue;
      if (seen.has(key) && seen.get(key) !== i) copies.push([seen.get(key) + 1, i + 1]);
      else seen.set(key, i);
    }
  });
  return copies;
}

const chapterBlock = (n, text) => `<chapter n="${n}">\n${lf(text).trim()}\n</chapter>`;
const FACTS_SCHEMA = {
  type: "object",
  properties: {
    chapters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          chapter: { type: "integer" },
          summary: { type: "string", description: "What happens in the chapter, in two or three sentences" },
          facts: { type: "array", items: { type: "string" }, description: "One specific fact per item" },
        },
        required: ["chapter", "summary", "facts"],
      },
    },
  },
  required: ["chapters"],
};
const FACTS_SYSTEM = `You read chapters of a novella and record what each chapter establishes as fact, so that later chapters can be checked against it.

For each chapter, list its facts as short, specific sentences: people's names, ages, jobs and relationships; places and how they are laid out; dates, days and times, and how long things take; objects and where they are; injuries, illnesses and deaths; the weather; and who knows what (who learned what, and when). Include facts stated in dialogue only when the story treats them as true. Prefer the facts a later chapter could get wrong. At most 40 facts a chapter. Add a two- or three-sentence summary of what happens. Record the answer with the answer tool.`;
const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          chapter: { type: "integer" },
          contradiction: { type: "boolean" },
          details: { type: "string", description: "The words in the chapter and the earlier fact they contradict, or 'none'" },
        },
        required: ["chapter", "contradiction", "details"],
      },
    },
  },
  required: ["verdicts"],
};
const VERDICT_SYSTEM = `You check chapters of a novella for continuity errors against a registry of facts from earlier chapters.

A contradiction is something a chapter states or shows that cannot be true together with an earlier fact: a different age, name, date or relationship; a dead or absent character acting; an object somewhere it cannot be; an injury that is forgotten or moves; a character knowing something before they could have learned it. It is not a contradiction when the story itself explains the change: a lie or mistake revealed, time passing, someone changing their mind. Check each chapter only against facts from chapters before it. When in doubt, it is not a contradiction. Record one verdict per chapter with the answer tool.`;

// The grader: files are the run's, send the judge client. count, minWords and maxWords are for the offline test.
export async function gradeNovella(files, { send = bedrock, count = 12, minWords = 1100, maxWords = 2000, premise = NOVELLA.premise, conditions = NOVELLA.conditions, m = meter() } = {}) {
  const texts = chapterTexts(files, count);
  const present = texts.map((t, i) => [i + 1, t]).filter(([, t]) => t !== null);
  const missing = texts.map((t, i) => (t === null ? i + 1 : null)).filter(Boolean);
  const counts = texts.map(t => (t === null ? null : wordCount(t)));
  const outOfBounds = counts.map((n, i) => [i + 1, n]).filter(([, n]) => n !== null && (n < minWords || n > maxWords));
  const copies = copiedParagraphs(texts);
  const checks = [
    [!missing.length, `all ${count} chapters saved as chapters/01.md… (${missing.length ? "missing " + missing.join(", ") : "all there"})`],
    [!missing.length && !outOfBounds.length, `every chapter has ${minWords}-${maxWords} words (${outOfBounds.length ? outOfBounds.map(([n, w]) => `ch ${n}: ${w}`).join(", ") : missing.length ? `${missing.length} missing` : `${Math.min(...counts)}-${Math.max(...counts)}`})`],
    [!copies.length, `no paragraph is copied between chapters${copies.length ? ` (ch ${copies.slice(0, 3).map(c => c.join(" and ")).join("; ")})` : ""}`],
  ];
  if (present.length < 2) {
    for (let n = 2; n <= count; n++) checks.push([false, `chapter ${n} contradicts no earlier fact (not judged: ${present.length} chapters)`]);
    checks.push([false, "threads opened early are resolved (not judged)"], [false, "the ending holds (not judged)"], [false, "no chapter repeats another's events (not judged)"], [false, "judge: plain writing in sampled chapters (not judged)"]);
    return { checks, m };
  }

  // 1. The registry: facts and a summary per chapter, three chapters a call.
  const registry = new Map(); // chapter → { summary, facts }
  const batches = [];
  for (let i = 0; i < present.length; i += 3) batches.push(present.slice(i, i + 3));
  const extracted = await Promise.all(batches.map(b => ask(send, m, { system: FACTS_SYSTEM, schema: FACTS_SCHEMA, text: `${b.map(([n, t]) => chapterBlock(n, t)).join("\n\n")}\n\nRecord the facts and a summary for chapter${b.length > 1 ? "s" : ""} ${b.map(([n]) => n).join(", ")}.` })));
  const extractErrors = extracted.filter(e => e.error).map(e => e.error);
  for (const e of extracted) for (const c of e.value?.chapters ?? []) if (Number.isInteger(c?.chapter)) registry.set(c.chapter, { summary: String(c.summary ?? ""), facts: (c.facts ?? []).map(String) });
  const factsBefore = n => [...registry].filter(([c]) => c < n).sort((a, b) => a[0] - b[0]).flatMap(([c, r]) => r.facts.map(f => `[ch ${c}] ${f}`));

  // 2. Each later chapter against the facts before it, two chapters a call.
  const later = Array.from({ length: count - 1 }, (_, i) => i + 2);
  const pairs = [];
  for (let i = 0; i < later.length; i += 2) pairs.push(later.slice(i, i + 2));
  const verdicts = new Map();
  await Promise.all(pairs.map(async pair => {
    const here = pair.filter(n => texts[n - 1] !== null);
    if (!here.length) return;
    const last = Math.max(...here);
    const r = await ask(send, m, {
      system: VERDICT_SYSTEM,
      schema: VERDICT_SCHEMA,
      text: `<registry>\n${factsBefore(last).join("\n") || "(no facts recorded)"}\n</registry>\n\n${here.map(n => chapterBlock(n, texts[n - 1])).join("\n\n")}\n\nGive a verdict for chapter${here.length > 1 ? "s" : ""} ${here.join(" and ")}. Chapter ${here[0]} is checked only against facts from chapters 1-${here[0] - 1}.`,
    });
    for (const n of here) {
      const v = (r.value?.verdicts ?? []).find(v => Number(v?.chapter) === n);
      verdicts.set(n, v ? { ok: v.contradiction === false, details: String(v.details ?? "") } : { ok: false, details: r.error ?? "no verdict" });
    }
  }));
  for (const n of later) {
    const v = verdicts.get(n);
    checks.push(texts[n - 1] === null ? [false, `chapter ${n} contradicts no earlier fact (missing)`] : [v.ok, `chapter ${n} contradicts no earlier fact${v.ok ? "" : ` (${v.details.slice(0, 200)})`}${extractErrors.length ? ` [registry incomplete: ${extractErrors[0]}]` : ""}`]);
  }

  // 3-5. Threads over the whole novella; the ending over the last two chapters; repeats over the summaries.
  const whole = present.map(([n, t]) => chapterBlock(n, t)).join("\n\n");
  const half = Math.ceil(count / 2);
  const [threads, ending, repeats, plain] = await Promise.all([
    ask(send, m, {
      system: "You read a whole novella and judge whether it pays off what it sets up. Record the answer with the answer tool.",
      schema: { type: "object", properties: { threads: { type: "array", items: { type: "object", properties: { question: { type: "string" }, opened_in: { type: "integer" }, resolved: { type: "boolean" }, resolved_in: { type: "integer" }, evidence: { type: "string" } }, required: ["question", "opened_in", "resolved", "evidence"] } } }, required: ["threads"] },
      text: `<premise>\n${premise}\n</premise>\n\n${whole}\n\nList the questions and setups opened in chapters 1-${half} that a reader expects answered by the end: mysteries, promises, objects or clues given weight, conflicts between characters. At most 10, the most important first; leave out small details. For each, say whether a later chapter resolves it, which one, and the words that show it.`,
    }),
    ask(send, m, {
      system: "You check whether a novella's ending meets conditions the author was given. Pass a condition only if the text clearly meets it. Record the answer with the answer tool.",
      schema: { type: "object", properties: { conditions: { type: "array", items: { type: "object", properties: { n: { type: "integer" }, holds: { type: "boolean" }, evidence: { type: "string" } }, required: ["n", "holds", "evidence"] } } }, required: ["conditions"] },
      text: `${present.filter(([n]) => n >= count - 1).map(([n, t]) => chapterBlock(n, t)).join("\n\n") || "(the last chapters are missing)"}\n\n<conditions>\n${conditions.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n</conditions>\n\nThe last chapter is chapter ${count}. For each condition, say whether it holds and quote the words that show it.`,
    }),
    ask(send, m, {
      system: "You read chapter summaries of a novella and find chapters that retell events an earlier chapter already told as new, instead of moving the story on. Recalling or referring to earlier events is fine. Record the answer with the answer tool.",
      schema: { type: "object", properties: { repeats: { type: "array", items: { type: "object", properties: { chapter: { type: "integer" }, earlier: { type: "integer" }, details: { type: "string" } }, required: ["chapter", "earlier", "details"] } } }, required: ["repeats"] },
      text: `${[...registry].sort((a, b) => a[0] - b[0]).map(([n, r]) => `Chapter ${n}: ${r.summary}`).join("\n")}\n\nList every chapter whose main events repeat an earlier chapter's (the same scene happening again as if for the first time, or the plot going back over the same ground). An empty list if none.`,
    }),
    ask(send, m, {
      system: "You grade prose against one criterion. Pass only if it clearly meets it. Record the answer with the answer tool.",
      schema: { type: "object", properties: { pass: { type: "boolean" }, reason: { type: "string" } }, required: ["pass", "reason"] },
      text: `${[...new Set([present[0], present[Math.floor(present.length / 2)], present.at(-1)])].map(([n, t]) => chapterBlock(n, t)).join("\n\n")}\n\n<criterion>\nThe writing is plain: it ${PLAIN.charAt(0).toLowerCase() + PLAIN.slice(1)} Sentences say who does what; description is concrete; no paragraph is padding.\n</criterion>`,
    }),
  ]);
  const list = threads.value?.threads ?? [];
  const open = list.filter(t => t.resolved !== true);
  checks.push([!threads.error && list.length > 0 && !open.length, `threads opened in chapters 1-${half} are resolved (${threads.error ?? `${list.length - open.length}/${list.length}${open.length ? "; open: " + open.slice(0, 3).map(t => t.question).join(" | ") : ""}`})`]);
  const held = ending.value?.conditions ?? [];
  const failed = conditions.filter((c, i) => held.find(h => Number(h.n) === i + 1)?.holds !== true);
  checks.push([!ending.error && !failed.length, `the ending holds: ${conditions.length - failed.length}/${conditions.length} conditions${ending.error ? ` (${ending.error})` : failed.length ? ` (not: ${failed.join(" | ")})` : ""}`]);
  const reps = repeats.value?.repeats ?? [];
  checks.push([!repeats.error && !reps.length, `no chapter repeats another's events${repeats.error ? ` (${repeats.error})` : reps.length ? ` (${reps.slice(0, 3).map(r => `ch ${r.chapter} repeats ch ${r.earlier}: ${r.details}`.slice(0, 120)).join(" | ")})` : ""}`]);
  const style = mannered(present.map(([, t]) => t).join("\n\n"));
  checks.push([plain.value?.pass === true, `judge: plain writing in sampled chapters (${plain.error ?? String(plain.value?.reason ?? "").slice(0, 160)}; ${style.per1k} flourishes per 1k words)`]);
  return { checks, m };
}

// ---------------------------------------------------------------------------------------------------------------
// long-research
//
// The trap, checked 2026-10-12: the 320-character email limit (64 + 1 + 255) is repeated widely and comes from
// RFC 3696 section 3, which its own verified erratum 1690 corrects: RFC 5321 section 4.5.3.1.3 limits a path to 256
// octets "including the punctuation and element separators", and the path's angle brackets leave 254 for the address.
//   https://www.rfc-editor.org/rfc/rfc5321 (4.5.3.1.3) and https://www.rfc-editor.org/errata/eid1690
// The other figures in the prompt's scope, from their primary sources:
//   RFC 9110 4.1: no URI length limit; senders and recipients SHOULD support at least 8000 octets (the 2,048 cap
//   comes from old Internet Explorer, 2,083). RFC 1035 2.3.4: labels 63 octets, names 255 octets.
//   NIST SP 800-63B rev. 4 (pages.nist.gov/800-63-4/sp800-63b.html): single-factor passwords at least 15 characters,
//   8 with MFA, a maximum of at least 64 SHOULD be allowed. ITU-T E.164: at most 15 digits. bcrypt uses 72 bytes.

export const RESEARCH_PROMPT = `Write a research report for our team on the length limits our sign-up and profile forms should enforce, and why: email address, website URL, domain name (the whole name and each label), password (minimum and maximum, and what password hashing does to very long ones), phone number, and display name. Today we allow 320 characters for an email address (64 for the local part, 1 for the @, 255 for the domain) and cap URLs at 2,048 characters. For each field give the limit you recommend, what it rests on, and a source: the standard or primary document where one exists. Use at least 10 sources. Save it as report.md, with each citation as a link next to the claim it supports.`;

// A URL's identity for counting: no scheme, www, fragment or trailing slash.
const bare = url => url.replace(/^https?:\/\/(www\.)?/i, "").replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();
const fetching = c => c.name === "read_url" || (c.name === "code" && /fetch\(|web\.read|https?:\/\//.test(c.input?.source ?? ""));
// What the run fetched: the URLs in read_url and code calls, and the text those calls returned.
export function fetchedBy(run) {
  const calls = (run.calls ?? []).filter(fetching);
  const where = JSON.stringify(calls.map(c => c.input ?? {})).replace(/\\\//g, "/").toLowerCase();
  const text = calls.map(c => run.outcomes?.[c.toolUseId] ?? "").join("\n");
  return { where, text, calls };
}
const sentences = text => prose(text).split(/(?<=[.!?])\s+|\n+/).filter(s => s.trim());
const CORRECTS = /\b(not|n't|wrong|incorrect|myth|misread|mistaken|commonly|often|widely|actually|however|instead|overstate|outdated|too (high|long|large))\b|254/i;
// A sentence that gives 320 as the limit: "the limit is 320", "a maximum of 320", "up to 320", "recommend 320".
const AS_LIMIT = /\b(?:limit|maximum|max|length)\s+(?:\w+\s+){0,3}(?:is|of|=|:)\s+(?:\w+\s+){0,2}320\b|\b(?:up to|at most|recommend(?:ed)?|allow)\s+(?:\w+\s+){0,2}320\b|\b320\s+(?:characters|octets|chars)\s+(?:is|as)\s+the\s+(?:limit|maximum)/i;

// The page as text, for the numbers check: the run may fetch in code and print only what it needs, so the grader
// reads the pages it fetched itself. PDFs and failures read as nothing.
export async function fetchPage(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: "follow" });
    if (!r.ok || /pdf|octet-stream|image/.test(r.headers.get("content-type") ?? "")) return "";
    return (await r.text()).slice(0, 5_000_000).replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ");
  } catch { return ""; }
}

export async function researchScripted(run, { readPage = fetchPage } = {}) {
  const files = normalized(run.files);
  const reportPath = Object.keys(files).find(p => /^report\.md$/i.test(p));
  const report = lf(files[reportPath] ?? "");
  const cited = [...new Map(urls(report).map(u => [bare(u), u])).values()];
  const fetched = fetchedBy(run);
  const wasFetched = u => fetched.where.includes(bare(u));
  const read = cited.filter(wasFetched);
  const emailLines = sentences(report).filter(s => /e-?mail|address|mailbox/i.test(s));
  const says254 = emailLines.some(s => /\b254\b/.test(s));
  const repeats320 = sentences(report).filter(s => AS_LIMIT.test(s) && !CORRECTS.test(s));
  const primary = cited.filter(u => /rfc-?5321|errata\/eid1690|eid=?1690/i.test(u));
  // Numbers in the report's prose, 10 and over, against the numbers in the prompt, in what the run's tools returned,
  // and in the cited pages the run fetched, as the grader reads them. At most 10% may be missing (a derived figure,
  // such as 254 from a 256-octet path less its two brackets). Links and the names of documents ("RFC 5321", "erratum 1690", "SP 800-63B", "E.164") are left out: they name a source, not a figure.
  const body = prose(report).replace(/\]\([^)]*\)/g, "]").replace(/https?:\/\/\S+/g, " ")
    .replace(/\b(?:RFCs?|errat(?:um|a)|EID|ID|SP|NIST|ISO(?:\/IEC)?|ITU-T|E|X|section|§)\s*[\d.-]+[A-Za-z]?\b/gi, " ");
  const stated = [...new Set(numbers(body).filter(n => n >= 10))];
  const pages = await Promise.all(read.map(u => readPage(u)));
  const found = new Set([...numbers(RESEARCH_PROMPT), ...numbers(run.results), ...numbers(fetched.text), ...pages.flatMap(p => numbers(p))]);
  const unfound = stated.filter(n => !found.has(n));
  // In the workspace, or written as a note with the editor.
  const plan = Object.keys(files).some(p => /^PLAN\.md$/i.test(p)) || (run.calls ?? []).some(c => c.name === "editor" && c.input?.command === "create" && /(^|\/)PLAN\.md$/i.test(c.input?.path ?? ""));
  return {
    report,
    checks: [
      [report.length > 0, "saved report.md"],
      [cited.length >= 10, `cites at least 10 sources (${cited.length} distinct links)`],
      [read.length >= 8, `at least 8 cited links were fetched in the run (${read.length} of ${cited.length})`],
      [says254 && !repeats320.length, `corrects the email limit to 254 (${says254 ? "says 254" : "no 254 for email"}${repeats320.length ? `; repeats 320 uncorrected: "${repeats320[0].slice(0, 100)}"` : ""})`],
      [primary.some(wasFetched), `cites RFC 5321 or erratum 1690 for it, fetched (${primary.length ? primary.map(u => `${u}${wasFetched(u) ? "" : " (not fetched)"}`).join(", ") : "not cited"})`],
      [stated.length > 0 && unfound.length <= Math.floor(0.1 * stated.length), `numbers in the report appear in the prompt, tool output or the cited pages it fetched (${stated.length - unfound.length}/${stated.length}${unfound.length ? "; not found: " + unfound.slice(0, 6).join(", ") : ""})`],
      [lookups(run).length >= 10, `researched (${lookups(run).length} lookups)`],
      [plan, "kept a plan in PLAN.md"],
    ],
  };
}

export const RESEARCH_CRITERIA = [
  "report.md gives the email address limit as 254 characters and says the 320 figure (64 + 1 + 255) is wrong, because RFC 5321 limits a path to 256 octets including the angle brackets; it cites RFC 5321 or RFC 3696's erratum 1690 there.",
  "report.md says no standard sets a 2,048-character URL limit (RFC 9110 sets no maximum and recommends supporting at least 8,000 octets) and that 2,048 comes from old browsers or is a choice, not a rule.",
  "report.md recommends a limit for every field asked about: email, URL, domain name and label, password minimum and maximum, phone number, and display name.",
  "report.md is organized for a reader who will act on it: the recommended limits together first (a table or list), then a section per field with the reasoning and sources.",
  "Each figure in report.md has a link next to it, and where no standard exists (display name) the report says so instead of citing one.",
  "The chat reply says the report was saved to report.md and names the changes to today's limits.",
  `report.md: ${PLAIN}`,
];

export async function gradeResearch(run, { send = bedrock, m = meter(), readPage = fetchPage } = {}) {
  const { report, checks } = await researchScripted(run, { readPage });
  if (!report) return { checks: [...checks, ...RESEARCH_CRITERIA.map(c => [false, "judge: " + c + " (no report)"])], m };
  const r = await ask(send, m, {
    system: "You grade a research report and the chat reply that delivered it against yes/no criteria. Decide each on its own; pass it only if the text clearly meets it. Give a one-sentence reason pointing to the words it rests on. Record the grades with the answer tool.",
    schema: { type: "object", properties: { grades: { type: "array", items: { type: "object", properties: { n: { type: "integer" }, pass: { type: "boolean" }, reason: { type: "string" } }, required: ["n", "pass", "reason"] } } }, required: ["grades"] },
    text: `<report path="report.md">\n${report}\n</report>\n\n<chat_reply>\n${run.answer ?? ""}\n</chat_reply>\n\n<criteria>\n${RESEARCH_CRITERIA.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n</criteria>`,
  });
  const grades = r.value?.grades ?? [];
  for (const [i, c] of RESEARCH_CRITERIA.entries()) {
    const g = grades.find(g => Number(g.n) === i + 1);
    checks.push([g?.pass === true, `judge: ${c}${g ? ` — ${String(g.reason ?? "").slice(0, 160)}` : ` (${r.error ?? "no grade"})`}`]);
  }
  return { checks, m };
}

// ---------------------------------------------------------------------------------------------------------------

const TASKS = [
  {
    id: "long-lisp",
    set: "long",
    timeout: TIMEOUT,
    turns: [LISP_SPEC],
    check: run => gradeLisp(run),
  },
  {
    id: "long-novella",
    set: "long",
    timeout: TIMEOUT,
    turns: [NOVELLA_PROMPT],
    check: async run => {
      const { checks, m } = await gradeNovella(run.files);
      intoMetrics(run, m);
      return checks;
    },
  },
  {
    id: "long-research",
    set: "long",
    timeout: 45 * 60_000,
    turns: [RESEARCH_PROMPT],
    check: async run => {
      const { checks, m } = await gradeResearch(run);
      intoMetrics(run, m);
      return checks;
    },
  },
];

// E28a: each plan in long/plans (evals/oracle.js) makes a variant of its task that starts with the plan in the
// workspace, where it survives summaries, and a line in the request saying it is there.
const PLANS = path.join(LONG_DIR, "plans");
const planned = TASKS.flatMap(task => {
  let names = [];
  try { names = readdirSync(PLANS).filter(f => f.startsWith(task.id + ".") && f.endsWith(".md")); } catch {}
  return names.map(name => {
    const model = name.slice(task.id.length + 1, -3);
    return {
      ...task,
      set: "long-plan",
      id: `${task.id}+${model}-plan`,
      turns: [{ seed: { path: "notes/plan.md", content: readFileSync(path.join(PLANS, name), "utf8") } }, `${task.turns[0]}

A planner has written a plan for this work in notes/plan.md. Read it first and keep to it; where it conflicts with this request, the request wins.`],
    };
  });
});

export default [...TASKS, ...planned];
