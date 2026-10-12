// Tasks for the `intent` set: short, underspecified requests where the user wants something specific they didn't say.
// A simulated user (evals/user.js) holds the hidden goal, answers questions from it, corrects wrong assumptions and
// says DONE when the work meets it. Each task checks that DONE came, how many user turns it took, that the final work
// meets the hidden goal (scripted where possible, else the judge), and, by the judge, that the assistant asked about or
// stated each goal element before building on it. A control task is fully specified and should need no questions.
// See docs/specs/2026-10-12-harness-design.md, "Eval changes: better, not only harder", items 3 and 4.
import vm from "node:vm";
import { wordCount } from "./style.js";

const html = run => Object.keys(run.files ?? {}).filter(p => p.endsWith(".html") && !p.startsWith("scratch/"));
const artifact = run => [html(run).length > 0, "made an html artifact"];
const written = (run, re = /./) => Object.entries(run.files ?? {}).filter(([p]) => !p.startsWith("scratch/") && re.test(p)).map(([, t]) => t ?? "").join("\n");
// The final work: the last reply and the files.
const work = run => `${run.answer ?? ""}\n${written(run)}`;
const blocks = text => [...String(text ?? "").matchAll(/```([\w+-]*)[^\n]*\n([\s\S]*?)```/g)].map(m => ({ lang: m[1], code: m[2] }));

// DONE came, and within this many user messages (the opening one counts).
const reached = (run, within) => [
  [run.user?.done === true, `the user said DONE (${run.user ? (run.user.done ? "yes" : `no, after ${run.user.userTurns} turns`) : "no simulated user"})`],
  [run.user?.done === true && run.user.userTurns <= within, `DONE within ${within} user turns (${run.user?.userTurns ?? "-"})`],
];

// Judge criteria, one per goal element: asked or stated before building on it, never a silent guess. The judge sees
// "[wrote: path]" where each file was written.
const askedFirst = what => `Before building on ${what} (writing the file, marked "[wrote: …]", or giving the finished answer), the assistant asked the user or stated its assumption. A stated assumption the user corrected passes; a silent choice fails.`;

// JavaScript from the work, run in a fresh context with expr evaluated after it. Module syntax is dropped.
function runJs(code, expr) {
  const source = code.replace(/^\s*import\s[^\n]*$/gm, "").replace(/^(\s*)export\s+(default\s+)?/gm, "$1");
  try { return { value: vm.runInContext(`${source}\n;(${expr})`, vm.createContext({ console: { log() {} } }), { timeout: 2000 }) }; } catch (e) { return { error: String(e?.message ?? e).split("\n")[0] }; }
}

// A function other code calls, written the hard way. Callers rely on its name, its two parameters and its result.
const STATS = `// Used by report.js and the dashboard: keep it working.
export function summarize(rows, opts) {
  var r = {}, t = 0, n = 0, mx = null, mn = null, k = (opts && opts.key) || "amount";
  for (var i = 0; i < rows.length; i++) {
    var x = rows[i];
    if (x == null) continue;
    var v = x[k];
    if (typeof v === "string") v = parseFloat(v);
    if (v === null || v === undefined || isNaN(v)) continue;
    t = t + v; n++;
    if (mx === null || v > mx) mx = v;
    if (mn === null || v < mn) mn = v;
    var g = (opts && opts.groupBy) ? x[opts.groupBy] : null;
    if (g !== null && g !== undefined) { if (!r[g]) r[g] = { count: 0, total: 0 }; r[g].count++; r[g].total = r[g].total + v; }
  }
  return { count: n, total: t, mean: n ? t / n : 0, min: mn, max: mx, groups: (opts && opts.groupBy) ? r : undefined };
}
`;
// Inputs the original handles: numbers, numeric strings, junk, missing keys, null rows, groups with gaps.
const STATS_CASES = `[
  summarize([]),
  summarize([{ amount: 3 }, { amount: "4.5" }, null, { amount: "abc" }, {}, { amount: -2 }]),
  summarize([{ price: 10, cat: "a" }, { price: 5, cat: "b" }, { price: "7", cat: "a" }, { price: 1 }], { key: "price", groupBy: "cat" }),
  summarize([{ amount: 2, cat: "x" }], { groupBy: "cat" }),
  summarize.length,
]`;
const statsWant = JSON.stringify(runJs(STATS, STATS_CASES).value);

export default [
  {
    id: "intent-habits",
    set: "intent",
    turns: ["make me a habit tracker"],
    user: {
      persona: "You are a busy nurse who wants a simple habit tracker for yourself, on your laptop.",
      goal: "A habit tracker where each habit has a weekly target (for example: gym 3 times a week, reading 5 times a week), not a daily yes/no. It shows how many times each habit was done this week against its target. Dark theme. The data stays in the browser's localStorage: no accounts, no server, no sync.",
      maxTurns: 6,
    },
    check: async run => {
      const src = written(run, /\.(html|js|css)$/);
      const dark = await run.probe(html(run)[0], () => {
        const rgba = el => (getComputedStyle(el).backgroundColor.match(/[\d.]+/g) ?? []).map(Number);
        const shown = [document.body, document.documentElement, document.querySelector("main, #app, .app, .container")].filter(Boolean).map(rgba).find(c => c.length >= 3 && (c[3] ?? 1) > 0.5);
        return shown ? +((0.2126 * shown[0] + 0.7152 * shown[1] + 0.0722 * shown[2]) / 255).toFixed(2) : 1; // nothing painted: white
      });
      return [
        ...reached(run, 4),
        artifact(run),
        [/week/i.test(src) && /target|goal|times/i.test(src), "habits have weekly targets"],
        [typeof dark === "number" && dark < 0.35, `dark theme (background luminance ${dark})`],
        [/localStorage/.test(src), "saves to localStorage"],
        [!/fetch\(|XMLHttpRequest|indexedDB|firebase|supabase/i.test(src), "no server, sync or other store"],
      ];
    },
    judgeFiles: /\.(html|js)$/,
    rubric: [
      "In the final files, each habit has a target count per week, and the app shows this week's count against that target (not only a daily checkbox).",
      askedFirst("how often a habit should be done (a daily habit or a weekly target)"),
      askedFirst("the look of the app (light or dark)"),
      askedFirst("where the data is kept"),
    ],
  },
  {
    id: "intent-cover-letter",
    set: "intent",
    turns: ["write a cover letter for me"],
    user: {
      persona: "You are Dana Reyes, a software tester applying for a new job. You are in a hurry.",
      goal: "A cover letter for the Senior QA Engineer job at Northwind Health. It must mention two facts about you: you have 8 years of experience testing healthcare software, and you cut the regression test run from 3 days to 4 hours by building an automated Playwright suite. Under 350 words. Nothing made up: no other achievements, numbers or employers.",
      reveal: ["Your name is Dana Reyes.", "You work at Medisoft now.", "The hiring manager is Priya Shah."],
      maxTurns: 6,
    },
    check: run => {
      const text = work(run);
      return [
        ...reached(run, 4),
        [/Northwind Health/i.test(text) && /Senior QA Engineer/i.test(text), "names the role and the company"],
        [/\b(8|eight)[ -]years?\b/i.test(text) && /health ?care|medical/i.test(text), "says 8 years testing healthcare software"],
        [/\b(3|three) days\b/i.test(text) && /\b(4|four) hours\b/i.test(text) && /playwright/i.test(text), "says 3 days to 4 hours with Playwright"],
        [wordCount(run.answer || written(run)) <= 400, `the letter is short (${wordCount(run.answer || written(run))} words in the last reply)`],
      ];
    },
    rubric: [
      "The final letter is for the Senior QA Engineer job at Northwind Health and states both facts: 8 years testing healthcare software, and cutting the regression run from 3 days to 4 hours with an automated Playwright suite.",
      "The final letter adds no achievements, numbers, employers or skills that the user did not give.",
      askedFirst("which job and company the letter is for"),
      askedFirst("the user's own experience and achievements"),
    ],
  },
  {
    id: "intent-trip",
    set: "intent",
    turns: ["plan my trip"],
    user: {
      persona: "You are a parent planning a family holiday in spare minutes at work.",
      goal: "A day-by-day plan for 4 days in Lisbon, 14 to 17 May, for two adults and a 6-year-old. Things a 6-year-old enjoys every day. Vegetarian places to eat. Total budget 1,200 euros for everything except flights. No car: public transport and walking only.",
      maxTurns: 6,
    },
    check: run => {
      const text = work(run);
      return [
        ...reached(run, 4),
        [/Lisbon|Lisboa/i.test(text) && /day\s*4|thursday|17 may|may 17/i.test(text) && !/day\s*5\b/i.test(text), "4 days in Lisbon"],
        [/child|kid|6-year|six-year|family/i.test(text), "plans for the 6-year-old"],
        [/vegetarian|veggie/i.test(text), "vegetarian places to eat"],
        [/(€|eur|euros?)\s*1[,.]?200|1[,.]?200\s*(€|eur|euros?)/i.test(text), "keeps to the 1,200 euro budget"],
        [!/rent(ing|al)? a car|car rental|hire a car|car hire/i.test(text) && /metro|tram|bus|train|walk/i.test(text), "public transport and walking, no car"],
      ];
    },
    rubric: [
      "The final plan is day by day for 4 days in Lisbon (14 to 17 May), with something for a 6-year-old each day, vegetarian places to eat, a cost estimate that fits 1,200 euros excluding flights, and only public transport and walking.",
      askedFirst("where and when the trip is"),
      askedFirst("who is travelling (a 6-year-old comes)"),
      askedFirst("the budget"),
      askedFirst("food needs and how they get around"),
    ],
  },
  {
    id: "intent-cleanup",
    set: "intent",
    turns: [{ seed: { path: "stats.js", content: STATS } }, "clean up the function in stats.js"],
    user: {
      persona: "You are a developer on a small team. Other code imports this function.",
      goal: "Keep the public signature exactly: the export named summarize, its two parameters (rows, opts) and the shape of what it returns, because report.js and the dashboard call it. What you care about is readability: clear names, small steps, modern syntax. Speed doesn't matter; don't make it faster at the cost of clarity. No new dependencies.",
      maxTurns: 6,
    },
    check: run => {
      const code = run.files?.["stats.js"] ?? "";
      const got = runJs(code, STATS_CASES);
      return [
        ...reached(run, 4),
        [code && code !== STATS, "rewrote stats.js"],
        [/export\s+(function\s+summarize\s*\(|(const|let)\s+summarize\s*=)/.test(code), "still exports summarize"],
        [!got.error && JSON.stringify(got.value) === statsWant, `same results for the same inputs, and two parameters (${got.error ?? (JSON.stringify(got.value) === statsWant ? "same" : "differs")})`],
        [!/^\s*import\s/m.test(code) && !/\brequire\(/.test(code), "no new dependencies"],
        [!/\bvar\b/.test(code), "no var left"],
      ];
    },
    judgeFiles: /^stats\.js$/,
    rubric: [
      "The final stats.js is easier to read than the original: descriptive names instead of r, t, n, mx, mn, k, x, v, g, and the loop split into clear steps.",
      "The final stats.js does not add speed tricks (caching, bit operations, manual loop unrolling) that make it harder to read.",
      askedFirst("whether the function's name, parameters and return shape must stay the same"),
      askedFirst("what 'clean up' should aim for (readability rather than speed)"),
    ],
  },
  {
    id: "intent-photos",
    set: "intent",
    turns: ["i need a script to rename my photos"],
    user: {
      persona: "You are a hobby photographer on a Mac. You can run a script from the terminal but you don't write code.",
      goal: "A Python 3 script that renames the JPEG photos in one folder by the date each was taken, read from the EXIF data (DateTimeOriginal), not the file's modified date. New names look like 2024-05-14_093015.jpg. It must do a dry run first: by default it only prints what it would rename, and it renames only when run with --apply.",
      maxTurns: 6,
    },
    check: run => {
      const text = work(run);
      const code = [...blocks(text).map(b => b.code), written(run, /\.py$/)].join("\n");
      return [
        ...reached(run, 4),
        [/^\s*(import|from)\s+\w+/m.test(code) && /\bdef\s+\w+\(|if __name__/.test(code), "a Python script"],
        [/DateTimeOriginal|36867|exif/i.test(code), "reads the EXIF date taken"],
        [/%Y-%m-%d_%H%M%S/.test(code), "names files like 2024-05-14_093015.jpg"],
        [/--apply/.test(code), "renames only with --apply"],
      ];
    },
    rubric: [
      "The final script reads the date taken from EXIF (DateTimeOriginal), names files like 2024-05-14_093015.jpg, and by default only prints the planned renames, renaming only when run with --apply.",
      askedFirst("which date to rename by (EXIF date taken or file date)"),
      askedFirst("the new name format"),
      askedFirst("whether it renames at once or shows a dry run first"),
      askedFirst("the language or how the user will run it"),
    ],
  },
  {
    // Control: everything is in the request. Questions here are a cost, not care.
    id: "intent-control",
    set: "intent",
    turns: ["Write a JavaScript function isLeapYear(year) that returns true for Gregorian leap years: divisible by 4, except century years, which must be divisible by 400. Reply with only the function in one code block."],
    user: {
      persona: "You are a developer who wants a small helper function.",
      goal: "A JavaScript function isLeapYear(year) that returns true for Gregorian leap years (divisible by 4, except century years, which must be divisible by 400), given as only the function in one code block.",
      maxTurns: 3,
    },
    check: run => {
      const code = blocks(run.answer).map(b => b.code).find(c => /isLeapYear/.test(c)) ?? "";
      const got = runJs(code, "[2000, 1900, 2024, 2023, 2100].map(isLeapYear).join()");
      return [
        ...reached(run, 1),
        [got.value === "true,false,true,false,false", `correct for 2000, 1900, 2024, 2023, 2100 (${got.error ?? got.value})`],
        [!/\?\s*$/m.test((run.dialogue?.find(m => m.role === "assistant")?.text ?? "").replace(/```[\s\S]*?```/g, "")), "asked no question first"],
      ];
    },
  },
];
