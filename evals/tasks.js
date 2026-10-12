import { existsSync, readFileSync } from "node:fs";

// Eval tasks: each hits one behavior the prompt asks for. A turn is a user message, or { seed } to place a file
// first (written by the echo model, so the real model finds it in the workspace). check(run) returns [ok, label]
// pairs; run has answer (final text), answers (per turn), files, report, calls, results (all tool output), metrics, and probe(path, fn), which
// opens a file standalone and evaluates fn in it.

const BUGGY_TODOS = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Todos</title>
  <style>
    body { font: 16px/1.5 system-ui, sans-serif; max-width: 32rem; margin: 2rem auto; padding: 0 1rem; }
    li.done span { text-decoration: line-through; color: #888; }
  </style>
</head>
<body>
  <form id="add"><input id="text" placeholder="What needs doing?" autocomplete="off"> <button>Add</button></form>
  <ul id="list"></ul>
  <button id="clear" type="button">Clear completed</button>
  <script type="module">
    let todos = [];
    const list = document.getElementById("list");

    function render() {
      list.replaceChildren(...todos.map((todo, i) => {
        const li = document.createElement("li");
        li.className = todo.done ? "done" : "";
        li.innerHTML = \`<label><input type="checkbox" \${todo.done ? "checked" : ""}> <span></span></label>\`;
        li.querySelector("span").textContent = todo.text;
        li.querySelector("input").addEventListener("change", () => { todos[i].done = !todos[i].done; render(); });
        return li;
      }));
    }

    export function add(text) { todos.push({ text, done: false }); render(); }
    export function clearCompleted() { todos = todos.filter(todo => todo.done); render(); }

    document.getElementById("add").addEventListener("submit", e => {
      e.preventDefault();
      const input = document.getElementById("text");
      if (input.value.trim()) add(input.value.trim());
      input.value = "";
    });
    document.getElementById("clear").addEventListener("click", clearCompleted);
    window.app = { add, clearCompleted, get todos() { return todos; } };

    // #region TESTS
    const TEST = new URLSearchParams(location.search).has("test") || window.__HARNESS__?.test;
    if (TEST) {
      let passed = 0, failed = 0;
      const test = (name, fn) => {
        try { fn(); passed++; console.log("PASS: " + name); }
        catch (e) { failed++; console.log("FAIL: " + name + "\\n   " + e.message); }
      };
      const assert = (ok, message) => { if (!ok) throw new Error(message); };
      test("adds a todo", () => { add("milk"); assert(todos.at(-1).text === "milk", "expected milk"); todos = []; render(); });
      window.TESTS_DONE = { passed, failed };
    }
    // #endregion
  <\/script>
</body>
</html>
`;

// A small app the user already has, split the way people split them: markup, a store module, a view module, styles.
const HABITS = {
  "index.html": `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Habits</title>
  <link rel="stylesheet" href="./styles.css">
</head>
<body>
  <h1>Habits</h1>
  <form id="add"><input id="name" placeholder="New habit" autocomplete="off"> <button>Add</button></form>
  <ul id="habits"></ul>
  <script type="module" src="./src/app.js"></script>
</body>
</html>
`,
  "src/store.js": `// Habits live in localStorage as { id, name, done: ["YYYY-MM-DD", ...] }.
const KEY = "habits.v1";

export const today = (date = new Date()) => date.toISOString().slice(0, 10);

export function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) ?? []; } catch { return []; }
}

export function save(habits) {
  localStorage.setItem(KEY, JSON.stringify(habits));
}

export function addHabit(habits, name) {
  return [...habits, { id: crypto.randomUUID(), name, done: [] }];
}

export function toggle(habits, id, day = today()) {
  return habits.map(h => h.id !== id ? h : { ...h, done: h.done.includes(day) ? h.done.filter(d => d !== day) : [...h.done, day] });
}
`,
  "src/app.js": `import { load, save, addHabit, toggle, today } from "./store.js";

let habits = load();
const list = document.getElementById("habits");

function render() {
  const day = today();
  list.replaceChildren(...habits.map(h => {
    const li = document.createElement("li");
    li.innerHTML = \`<label><input type="checkbox"> <span></span></label>\`;
    li.querySelector("span").textContent = h.name;
    const box = li.querySelector("input");
    box.checked = h.done.includes(day);
    box.addEventListener("change", () => update(toggle(habits, h.id, day)));
    return li;
  }));
}

function update(next) { habits = next; save(habits); render(); }

document.getElementById("add").addEventListener("submit", e => {
  e.preventDefault();
  const input = document.getElementById("name");
  if (input.value.trim()) update(addHabit(habits, input.value.trim()));
  input.value = "";
});

window.app = { get habits() { return habits; }, update };
render();
`,
  "styles.css": `body { font: 16px/1.5 system-ui, sans-serif; max-width: 30rem; margin: 2rem auto; padding: 0 1rem; }
ul { list-style: none; padding: 0; }
li { padding: .5rem 0; border-bottom: 1px solid #ddd; }
`,
};

// The app itself, as the eval started: a large, real project the model has to navigate rather than read.
const own = file => new URL("../" + file, import.meta.url);
const SELF = Object.fromEntries(["index.html", "engine.js", "prompts.js", "ws-sw.js"].filter(f => existsSync(own(f))).map(f => [f, readFileSync(own(f), "utf8")]));

// The deliverable; scratch/ is the agent's bench and not graded.
const html = run => Object.keys(run.files).filter(p => p.endsWith(".html") && !p.startsWith("scratch/"));
const artifact = run => [html(run).length > 0, "made an html artifact"];
const reportOk = run => [run.report?.ok === true, `last run report ok (${run.report ? JSON.stringify({ errors: run.report.errors, tests: run.report.tests && { passed: run.report.tests.passed, failed: run.report.tests.failed } }) : "none"})`];
const tests = (run, n) => [(run.report?.tests?.passed ?? 0) >= n, `at least ${n} in-file tests pass`];
const source = run => html(run).map(p => run.files[p]).join("\n");
// Every jsDelivr npm URL, and whether each names a version ("pkg@1.2", not "pkg" or "pkg@latest").
export const jsdelivr = text => [...text.matchAll(/cdn\.jsdelivr\.net\/npm\/((?:@[\w.-]+\/)?[\w.-]+)(@[^/"'`\s?#)]*)?/g)];
export const pinsJsdelivr = text => jsdelivr(text).every(m => /^@\d/.test(m[2] ?? ""));

export default [
  {
    id: "inline-answer",
    set: "inner",
    turns: ["What's the difference between an async iterator and a ReadableStream in JavaScript? Short answer."],
    check: run => [
      [run.calls.filter(c => c.name !== "think").length === 0, "answers without tools"],
      [!Object.keys(run.files).length, "no artifact"],
      [run.answer.length < 1800, `short (${run.answer.length} chars)`],
      [/backpressure|pull|queue/i.test(run.answer), "names the real difference (backpressure, queuing)"],
    ],
  },
  {
    // A formula engine is a parser, an evaluator and a dependency graph: work that rewards a spike and hard tests.
    id: "spreadsheet",
    set: "hard",
    turns: ["Build a spreadsheet: a 10×10 grid (A–J, 1–10). A cell holds a number, text, or a formula such as =A1+B2*2, =(A1-3)/2, or =SUM(A1:A5); cells that depend on a changed cell update. A reference loop shows #CYCLE in every cell of the loop, and a bad formula shows #ERROR. Expose window.sheet = { set(ref, input), value(ref) } so I can script it."],
    check: async run => {
      const got = await run.probe(html(run)[0], () => {
        const s = window.sheet;
        if (!s) return "no window.sheet";
        const v = r => String(s.value(r));
        s.set("A1", "2"); s.set("A2", "3"); s.set("B1", "=A1+A2*2"); s.set("C1", "=(A1-3)/2");
        const out = { arith: v("B1") + "|" + v("C1") };
        for (const [r, x] of [["A3", "4"], ["A4", "5"], ["A5", "6"]]) s.set(r, x);
        s.set("D1", "=SUM(A1:A5)"); out.sum = v("D1");
        s.set("A1", "10"); out.chain = v("B1") + "|" + v("D1");
        s.set("E1", "=E2+1"); s.set("E2", "=E1"); out.cycle = v("E1") + "|" + v("E2");
        s.set("E2", "5"); out.uncycle = v("E1");
        s.set("F1", "=1+"); out.bad = v("F1");
        return out;
      });
      const g = typeof got === "object" && got ? got : {};
      return [
        artifact(run),
        reportOk(run),
        tests(run, 5),
        [g.arith === "8|-0.5", `arithmetic with precedence and parentheses (${g.arith ?? got})`],
        [g.sum === "20", `SUM over a range (${g.sum})`],
        [g.chain === "16|28", `dependents update when a cell changes (${g.chain})`],
        [g.cycle === "#CYCLE|#CYCLE" && g.uncycle === "6", `a loop is #CYCLE in each of its cells, and breaking it recovers (${g.cycle}, ${g.uncycle})`],
        [g.bad === "#ERROR", `a bad formula is #ERROR (${g.bad})`],
      ];
    },
  },
  {
    // An editor is state, history and pixels at once: undo has to treat a flood fill as one step, and the export has to
    // be the drawing, not the zoomed canvas.
    id: "pixel-editor",
    set: "hard",
    turns: ["Build a pixel-art editor: a 32×32 grid, with pencil, eraser and flood fill, a palette plus a custom color, undo and redo (ctrl+z, ctrl+shift+z), export to a 32×32 PNG, and the drawing survives a reload. Expose window.editor = { setTool(\"pencil\" | \"eraser\" | \"fill\"), setColor(hex), click(x, y), undo(), redo(), pixel(x, y) → \"#rrggbb\" or null when empty, exportPNG() → a data URL } so I can script it."],
    check: async run => {
      const got = await run.probe(html(run)[0], async () => {
        const e = window.editor;
        if (!e) return "no window.editor";
        const px = (x, y) => String(e.pixel(x, y) ?? "null").toLowerCase();
        e.setTool("pencil"); e.setColor("#ff0000");
        for (let i = 5; i <= 10; i++) { e.click(i, 5); e.click(i, 10); e.click(5, i); e.click(10, i); }
        e.setTool("fill"); e.setColor("#00ff00"); e.click(7, 7);
        const out = { fill: [px(7, 7), px(9, 9), px(5, 5), px(0, 0), px(12, 7)].join("|") };
        e.undo(); out.undo = px(7, 7) + "|" + px(9, 9) + "|" + px(5, 5);
        e.redo(); out.redo = px(7, 7);
        e.setTool("eraser"); e.click(5, 5); out.erase = px(5, 5);
        const url = await e.exportPNG();
        out.png = await new Promise(resolve => { const img = new Image(); img.onload = () => resolve(img.width + "x" + img.height); img.onerror = () => resolve("unreadable"); img.src = url; });
        out.saved = Object.keys(localStorage).length > 0;
        return out;
      });
      const g = typeof got === "object" && got ? got : {};
      return [
        artifact(run),
        reportOk(run),
        tests(run, 5),
        [g.fill === "#00ff00|#00ff00|#ff0000|null|null", `fill stays inside the box (${g.fill ?? got})`],
        [g.undo === "null|null|#ff0000" && g.redo === "#00ff00", `undo takes back the whole fill, redo restores it (${g.undo}, ${g.redo})`],
        [g.erase === "null", `the eraser empties a pixel (${g.erase})`],
        [g.png === "32x32", `exports a 32×32 PNG (${g.png})`],
        [g.saved === true, "saves the drawing"],
      ];
    },
  },
  {
    // An app grown over four turns, the way real ones are: each turn's feature has to work with the others, and the
    // two rules set in the first turn have to hold through all of them.
    id: "budget-evolve",
    set: "hard",
    timeout: 15 * 60_000, // a first turn that builds, tests, writes its spec and gets a review takes ten minutes
    turns: [
      "Build a budget tracker. A transaction has a date, an amount, a category and a note; the month view lists them, totals each category, and charts the totals. Two rules for everything we add later: money is exact to the cent, with no floating-point drift, and every amount on screen reads like $1,234.56. Expose window.budget = { add({ date: \"YYYY-MM-DD\", amount: \"12.34\", category, note }) → id, remove(id), list(\"YYYY-MM\") → [{ id, date, cents, category, note }], totals(\"YYYY-MM\") → { category: cents } } so I can script it. The data survives a reload.",
      "Add monthly recurring transactions: add({ ..., repeat: \"monthly\" }) shows up in every month from its date on, on the same day, or on the month's last day when the month is shorter.",
      "Add CSV import and export: budget.exportCSV() → text with the header date,amount,category,note, and budget.importCSV(text) → how many rows it added. Notes can contain commas and quotes.",
      "Add a monthly budget per category: budget.setBudget(category, \"500.00\"), and budget.over(\"YYYY-MM\") → the categories over budget that month. Show overspent categories in red.",
    ],
    check: async run => {
      const [page] = html(run);
      const got = await run.probe(page, async () => {
        const b = window.budget;
        if (!b) return "no window.budget";
        // Each part is its own check: a feature the app lacks fails alone, not every one after it.
        const out = {};
        const step = async (key, fn) => { try { out[key] = await fn(); } catch (e) { out[key] = `threw ${e.message}`; } };
        const of = async (month, category) => (await b.list(month)).filter(t => t.category === category);
        for (const amount of ["0.10", "0.20", "0.70"]) await b.add({ date: "2026-03-05", amount, category: "coffee", note: "c" });
        const rent = await b.add({ date: "2026-03-09", amount: "1234.56", category: "rent", note: "March" });
        await step("cents", async () => {
          await b.add({ date: "2026-01-31", amount: "15.00", category: "gym", note: "monthly", repeat: "monthly" });
          const march = await b.totals("2026-03");
          return `${march.coffee}|${march.rent}`;
        });
        await step("recurs", async () => [(await b.totals("2026-03")).gym, (await of("2026-02", "gym")).map(t => t.date).join(), (await of("2026-04", "gym")).map(t => t.date).join(), (await of("2025-12", "gym")).length].join("|"));
        await step("header", async () => String(await b.exportCSV()).split(/\r?\n/)[0].trim());
        await step("imported", () => b.importCSV('date,amount,category,note\n2026-03-10,12.34,food,"Lunch, with ""Sam"""\n2026-03-11,5.00,food,snack\n'));
        await step("lunch", async () => { const lunch = (await of("2026-03", "food")).find(t => t.note?.startsWith("Lunch")); return lunch ? `${lunch.cents}|${lunch.note}` : "none"; });
        // Food is over its budget whether or not the import worked.
        await step("over", async () => {
          await b.add({ date: "2026-03-12", amount: "11.00", category: "food", note: "dinner" });
          await b.setBudget("food", "10.00");
          await b.setBudget("rent", "2000.00");
          return JSON.stringify(await b.over("2026-03"));
        });
        await step("removed", async () => { await b.remove(rent); return (await b.totals("2026-03")).rent ?? 0; });
        // What the user sees is this month: an amount to format and a category over its budget.
        const now = new Date(), today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        await b.add({ date: today, amount: "1234.56", category: "rent", note: "now" });
        await b.add({ date: today, amount: "25.00", category: "food", note: "now" });
        await new Promise(r => setTimeout(r, 800));
        out.money = document.body.innerText.includes("$1,234.56");
        const paint = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d");
        const red = color => { paint.clearRect(0, 0, 1, 1); paint.fillStyle = "#0000"; paint.fillStyle = color; paint.fillRect(0, 0, 1, 1); const [r, g, bl, a] = paint.getImageData(0, 0, 1, 1).data; // Red by hue, a light red (#f87171) too; orange and pink are not.
          return a > 80 && r > 150 && g < r * .6 && bl < r * .6 && Math.abs(g - bl) < 50; };
        out.red = [...document.querySelectorAll("body *")].some(el => /food/i.test(el.textContent) && el.textContent.replace(/\s+/g, " ").length < 300
          && [getComputedStyle(el).color, getComputedStyle(el).backgroundColor, getComputedStyle(el).borderLeftColor].some(red));
        return out;
      });
      const kept = await run.probe(page, async () => (await window.budget?.list("2026-03"))?.some(t => t.category === "coffee") ?? "no window.budget");
      const g = typeof got === "object" && got ? got : {};
      return [
        artifact(run),
        reportOk(run),
        tests(run, 8),
        [g.cents === "100|123456", `exact to the cent: 0.10 + 0.20 + 0.70 is 100 cents (coffee|rent: ${g.cents ?? got})`],
        [g.recurs === "1500|2026-02-28|2026-04-30|0", `a monthly repeat lands on the month's last day when it is shorter, and not before its start (${g.recurs})`],
        [g.header === "date,amount,category,note" && g.imported === 2 && g.lunch === '1234|Lunch, with "Sam"', `CSV: header, row count, and a note with a comma and quotes (${g.header}, ${g.imported}, ${g.lunch})`],
        [g.over === '["food"]', `over budget names only food (${g.over})`],
        [g.removed === 0, `remove takes a transaction out of the totals (${g.removed})`],
        [g.money === true, "amounts read like $1,234.56, as the first turn asked"],
        [g.red === true, "an overspent category shows in red"],
        [kept === true, `the data survives a reload (${kept})`],
      ];
    },
  },
  {
    // The user's own multi-file project: the work is to change it in place, in its own structure, and still run it.
    id: "folder-feature",
    set: "hard",
    turns: [
      { files: HABITS },
      "Add streaks to my habit tracker: each habit shows how many days in a row it's been done, counting back from today (or from yesterday, if today isn't checked yet). Put the logic in store.js as streak(habit, day) and test it. Also let me archive a habit; archived ones hide unless \"Show archived\" is on.",
    ],
    check: async run => {
      const got = await run.probe("index.html", async () => {
        const store = await import("./src/store.js");
        if (typeof store.streak !== "function") return "no streak export";
        const h = { id: "x", name: "x", done: ["2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30"] };
        return {
          streak: [store.streak(h, "2026-09-30"), store.streak(h, "2026-10-01"), store.streak(h, "2026-10-02"), store.streak({ ...h, done: ["2026-09-28", "2026-09-30"] }, "2026-09-30")].join("|"),
          boots: document.querySelectorAll("#habits, form").length > 0,
        };
      });
      const g = typeof got === "object" && got ? got : {};
      const app = run.files["src/app.js"] ?? "", page = run.files["index.html"] ?? "";
      return [
        [g.streak === "4|4|0|1", `streak counts back from today or yesterday (${g.streak ?? got})`],
        [g.boots === true, "the app still boots"],
        [/archiv/i.test(app + (run.files["src/store.js"] ?? "")) && /show archived/i.test(app + page), "adds archiving behind a toggle"],
        [/from\s+["']\.\/store\.js["']/.test(app) && /src=["']\.\/src\/app\.js["']/.test(page), "keeps the project's structure"],
        // A passing report names no tests, so the test is looked for in the files and the pass in the last report.
        [Object.entries(run.files).some(([p, t]) => /test/i.test(p + t.slice(0, 2000)) && /\bstreak\(/.test(t) && /test\(|assert|eq\(/.test(t)) && run.report?.tests?.passed > 0 && !run.report.tests.failed, "tests streak, and its tests pass"],
      ];
    },
  },
  {
    id: "notes-app",
    set: "inner",
    turns: ["Make me a markdown notes app: a list of notes, an editor with live preview, search across notes, and everything saved in localStorage."],
    check: async run => [
      artifact(run),
      reportOk(run),
      tests(run, 3),
      [/localStorage/.test(source(run)), "persists to localStorage"],
      [jsdelivr(source(run)).length ? pinsJsdelivr(source(run)) : !/cdn\./.test(source(run)), "pins CDN versions"],
      [(await run.probe(html(run)[0], () => document.querySelectorAll("input[type=search], input[placeholder*='earch' i]").length)) > 0, "has a search box"],
    ],
  },
  {
    id: "live-data",
    set: "inner",
    turns: ["Chart the last 30 days of the Bitcoin price in USD, from a public API. Hovering a point shows the date and price."],
    check: run => [
      artifact(run),
      reportOk(run),
      tests(run, 1),
      [/fetch\(/.test(source(run)), "fetches live data"],
      [pinsJsdelivr(source(run)) && (/@\d[\w.-]*\//.test(source(run)) || /@\d[\w.-]*["'?]/.test(source(run)) || !/cdn\.|unpkg|esm\.sh/.test(source(run))), "pins the chart library version (or uses none)"],
    ],
  },
  {
    id: "dns-mx",
    set: "inner",
    turns: ["What are gmail.com's MX records? And what does smtp.gmail.com say when you connect to it on port 587?"],
    check: run => [
      [/gmail-smtp-in\.l\.google\.com/i.test(run.answer), "lists the MX hosts"],
      [/220[\s\S]{0,40}ESMTP|ESMTP[\s\S]{0,80}220/i.test(run.answer), "quotes the 587 banner"],
      [!/(can(no|')t|unable to|not possible)[^.]{0,60}(browser|tcp|socket|dns)/i.test(run.answer), "does not say the browser can't"],
      [/gmail-smtp-in\.l\.google\.com/i.test(run.results) && /220[^\n]{0,40}ESMTP/.test(run.results), "found both with tools, not from memory"],
    ],
  },
  {
    id: "fix-bug",
    set: "inner",
    turns: [
      { seed: { path: "todos.html", content: BUGGY_TODOS } },
      "In todos.html, \"Clear completed\" deletes the wrong todos.",
    ],
    check: async run => [
      reportOk(run),
      tests(run, 2),
      [(await run.probe("todos.html", () => { app.add("a"); app.add("b"); document.querySelector("#list input").click(); app.clearCompleted(); return app.todos.map(t => t.text).join(); })) === "b", "clear completed keeps the open todos"],
      [run.calls.filter(c => ["edit_file", "write_file"].includes(c.name)).length <= 3, "fixes it in a few edits"],
      [!run.calls.some(c => c.name === "write_file"), "edits rather than rewrites"],
    ],
  },
  {
    // The app as its own input: thousands of lines over a few files. It runs in its own workspace, under a nested copy of
    // itself that keeps its own database; the work is navigation, two surgical edits, and a check.
    id: "self-edit",
    set: "hard",
    timeout: 15 * 60_000, // the app's own suite runs nested on every edit, a minute or more each
    turns: [
      { files: SELF },
      "This folder is the chat app you run in. timeAgo in engine.js jumps from hours straight to a date. Make it say \"3d ago\" for anything under a week, and add a test for it beside the app's other tests in index.html.",
    ],
    check: async run => {
      const e = run.files["engine.js"] ?? "", i = run.files["index.html"] ?? "";
      const ago = await run.probe("index.html", async () => {
        const { timeAgo } = await import("./engine.js");
        const day = 86400e3, now = Date.now();
        return [timeAgo(now - 3 * day - 1000), timeAgo(now - 5 * 3600e3), /ago/.test(timeAgo(now - 8 * day)) ? "ago" : "date"].join("|");
      });
      const boots = await run.probe("index.html", () => !!document.querySelector("form#inputForm"));
      // Lines shown, not calls: twenty greps and short ranges read less than one long page.
      const read = (run.results.match(/\\n\d+\\t/g) ?? []).length;
      return [
        [ago === "3d ago|5h ago|date", `timeAgo gives days under a week (${ago})`],
        [boots === true, "the app still boots"],
        [i.split("timeAgo").length > SELF["index.html"].split("timeAgo").length, "adds a timeAgo test to index.html"],
        [e.length - SELF["engine.js"].length < 1500 && i.length - SELF["index.html"].length < 3000, "changes stay small"],
        [!run.calls.some(c => c.name === "write_file" && ["index.html", "engine.js"].includes(c.input?.path)), "edits rather than rewrites"],
        [read <= 1000, `navigates, not reads (${read} lines shown)`],
      ];
    },
  },
  {
    // Several questions against one large source: forks on the cached context should answer them cheaply.
    id: "codebase-questions",
    set: "inner",
    turns: ["Read solid-js 1.9.0's reactive core (dist/solid.js on jsDelivr). Then answer, citing line numbers: (1) how a memo decides whether to notify its observers, (2) how batch defers effects, (3) what untrack does, (4) how an owner's cleanups run on dispose."],
    check: run => [
      [["createMemo|memo", "batch", "untrack", "clean"].every(w => new RegExp(w, "i").test(run.answer)), "answers all four"],
      [(run.answer.match(/\b(line|L)\s?\d{2,5}/gi) ?? []).length >= 4, "cites line numbers"],
      [/solid\.js/.test(run.calls.map(c => JSON.stringify(c.input)).join()), "read the source"],
      [!Object.keys(run.files).length, "no artifact"],
    ],
  },
  {
    // The fork path end to end: the user asks for forks, so this measures the mechanism, not the choice.
    id: "fork-fanout",
    set: "inner",
    turns: ["Print all of solid-js 1.9.0's dist/solid.js (jsDelivr) with the code tool so it is in your context. Then fork one question each, in parallel: (1) what createRoot returns, (2) how onCleanup finds its owner, (3) what createSelector is for. Collect the answers in three lines."],
    check: run => [
      [run.metrics.forks >= 3, `forked the questions (${run.metrics.forks})`],
      [run.metrics.forkCacheHit >= 0.5, `forks read the caller's cache (${run.metrics.forkCacheHit})`],
      [/createRoot/.test(run.answer) && /onCleanup/.test(run.answer) && /createSelector/.test(run.answer), "answers all three"],
    ],
  },
  {
    id: "web-native-port",
    set: "holdout",
    turns: ["List the top-level entries inside https://github.com/solidjs/solid/archive/refs/tags/v1.9.0.zip and the size of its package.json."],
    check: run => [
      // GitHub archives hold one folder; its name is the top level
      [/package\.json/.test(run.answer) && /solid-1\.9\.0/.test(run.answer), "lists the zip's entries"],
      [/\d[\d,.]*\s*(bytes|B|KB|kB)/.test(run.answer), "gives the size"],
      [!/(can(no|')t|unable to)[^.]{0,60}(browser|unzip|zip)/i.test(run.answer), "does not say the browser can't"],
    ],
  },
  {
    // Delegation pays here but the prompt doesn't say so: several directions are worth trying, and the work is worth a
    // second look. variants and reviews in the table show whether the model chose to; the checks grade the outcome.
    id: "logo-directions",
    set: "holdout",
    timeout: 15 * 60_000, // three variants side by side take five minutes before the caller sees one
    turns: ["Design a logo for Ember & Oak, a wood-fired bakery, as logo.svg. I want the strongest direction, not the first one."],
    check: run => {
      const svg = run.files["logo.svg"] ?? "";
      return [
        [/<svg[\s\S]*<\/svg>/.test(svg), "made logo.svg"],
        [/viewBox=/.test(svg), "scales: has a viewBox"],
        [/<(path|circle|rect|polygon|ellipse)\b/.test(svg), "has a mark, not just text"],
      ];
    },
  },
  {
    // Parallel breadth: six independent lookups, each a few fetches.
    id: "audit-libs",
    set: "holdout",
    turns: ["Of dayjs, date-fns, luxon, moment, @js-joda/core and temporal-polyfill: which is smallest from jsDelivr (minified, gzipped) and still maintained, with a release in the last year? A table with each one's size and last release date, then your pick."],
    check: run => [
      [["dayjs", "date-fns", "luxon", "moment", "js-joda", "temporal-polyfill"].every(n => run.answer.toLowerCase().includes(n)), "covers all six"],
      [(run.answer.match(/\d+(\.\d+)?\s*(kB|KB|kb|B\b|bytes)/g) ?? []).length >= 6, "gives each a size"],
      [/20\d\d/.test(run.answer), "gives release dates"],
    ],
  },
  {
    id: "two-step-feature",
    set: "holdout",
    turns: [
      "Make a pomodoro timer: start, pause, reset, and 25/5 minute work/break cycles.",
      "Add a dark mode that follows the system setting with a toggle, and keyboard shortcuts: space to start/pause, r to reset.",
    ],
    check: run => [
      artifact(run),
      reportOk(run),
      tests(run, 4),
      [/prefers-color-scheme/.test(source(run)), "follows the system setting"],
      [/keydown|keyup/.test(source(run)), "adds keyboard shortcuts"],
    ],
  },
  {
    id: "research",
    set: "holdout",
    turns: ["Compare marked, markdown-it, and micromark: minified+gzipped size and parse speed on a large document. Show a table and say where each number came from."],
    check: run => [
      [/\|.*marked.*\|/i.test(run.answer) || /<table/i.test(source(run)), "shows a table"],
      [["marked", "markdown-it", "micromark"].every(n => new RegExp(n, "i").test(run.answer)), "covers all three"],
      [/\d+(\.\d+)?\s*(kB|KB|ms)/.test(run.answer), "gives measured numbers"],
      [/jsdelivr|bundlephobia|npmjs|github|measured|ran/i.test(run.answer), "cites sources"],
    ],
  },
  {
    // Read the source itself (searching first only if the URL isn't known): a paper the model has seen, so the check is whether it cites what it read.
    id: "web-read",
    set: "inner",
    turns: ["Find the paper that introduced the Transformer and read it. What formula does it give for scaled dot-product attention, and why does it scale by √d_k? Cite the URL you read."],
    check: run => {
      const read = run.calls.filter(c => c.name === "read_url").map(c => String(c.input?.url ?? "").trim()).filter(Boolean);
      return [
        [read.length > 0, `reads a page (${read.length})`],
        [read.some(u => run.answer.includes(u.replace(/^https?:\/\//, ""))), "cites a URL it read"],
        [/softmax/i.test(run.answer) && /(√|sqrt)\s*[({]?\s*d_?\{?k/i.test(run.answer), "gives the formula"],
        [/gradient/i.test(run.answer), "gives the paper's reason (small gradients)"],
        [!Object.keys(run.files).length, "no artifact"],
      ];
    },
  },
  {
    // crates.io builds its pages in the browser: a plain read is empty and says to render.
    id: "web-render",
    set: "inner",
    turns: ["What's the latest version of serde on crates.io, how many versions has it had, and how is its crates.io page laid out? Go by the page itself."],
    check: run => {
      const reads = run.calls.filter(c => c.name === "read_url" && /crates\.io\/crates\/serde/.test(String(c.input?.url ?? "")));
      return [
        [reads.some(c => c.input?.render || c.input?.screenshot), `renders the page (${reads.length} reads)`],
        [reads.some(c => c.input?.screenshot), "looks at it"],
        [/1\.0\.\d{3}/.test(run.answer), "gives the version"],
        [/\b[1-9]\d{2}\b.{0,20}versions|versions.{0,20}\b[1-9]\d{2}\b/i.test(run.answer), "gives the version count"],
        [!Object.keys(run.files).length, "no artifact"],
      ];
    },
  },
  {
    id: "long-session",
    set: "holdout",
    timeout: 20 * 60_000,
    turns: [
      "Make a kanban board with three columns: todo, doing, done.",
      "Let me add cards with a title.",
      "Drag cards between columns.",
      "Save the board in localStorage.",
      "Add a card count to each column header.",
      "Let me delete a card.",
      "Add a due date to cards; overdue ones turn red.",
      "Add a filter box that hides cards not matching the text.",
      "Add undo for the last change (ctrl+z).",
      "List every feature we've added so far, one line each.",
    ],
    check: async run => {
      const features = ["column", "add", "drag", "localStorage", "count", "delete", "due", "filter", "undo"];
      const named = features.filter(f => new RegExp(f, "i").test(run.answer)).length;
      // Ten turns on: the first turn's board still stands, and what it holds is saved.
      const [page] = html(run);
      const board = page ? await run.probe(page, () => ({
        columns: [/\bto[\s-]?do\b/i, /\bdoing\b|in progress/i, /\bdone\b/i].filter(c => c.test(document.body.innerText)).length,
        filter: !!document.querySelector("input[type=search], input[placeholder*=ilter i], input[aria-label*=ilter i]"),
      })) : {};
      return [artifact(run), reportOk(run), tests(run, 6), [named >= 8, `recalls the features (${named}/${features.length})`],
        [board?.columns === 3, `the three columns still show (${board?.columns})`],
        // A fresh page has saved nothing until a change, so the save is read in the source.
        [/localStorage\.setItem|localStorage\[/.test(Object.values(run.files).join("\n")), "the board is in localStorage"],
        [board?.filter === true, "a filter box is on the page"]];
    },
  },
  {
    // A game is a program that runs sixty times a second: rules, input, time and pixels at once. The API makes the
    // rules checkable without playing in real time, the same way the game's own tests should check them.
    id: "game-arcade",
    set: "game",
    timeout: 15 * 60_000,
    turns: ["Build Breakout: a paddle, a ball, a wall of bricks, three lives and a score, with a title screen, pause, and a game-over screen that restarts. Arrow keys or A/D move the paddle, space launches the ball, P pauses; on a phone, drag to move and tap to launch. Expose window.game = { reset(seed) → a new game in play with the ball on the paddle, step(n) → advances n ticks of 1/60 s, press(action, down) for \"left\", \"right\", \"launch\", \"pause\", state() → { scene: \"title\" | \"play\" | \"paused\" | \"over\", score, lives, bricks, ball: { x, y, vx, vy }, paddle: { x, w } } } so I can script it. The same seed and the same inputs always play the same game."],
    check: async run => {
      const got = await run.probe(html(run)[0], async () => {
        const g = window.game;
        if (!g?.state) return "no window.game";
        const s = () => JSON.parse(JSON.stringify(g.state()));
        const out = {};
        try {
          // What the user sees, before any script touches the game: a game may hand its clock to scripts once they
          // call step, so the canvas is sampled first, played by its keys.
          const work = [], native = requestAnimationFrame.bind(window);
          window.requestAnimationFrame = cb => native(now => { const t = performance.now(); try { return cb(now); } finally { work.push(performance.now() - t); } });
          const key = (type, k, code) => { const ev = new KeyboardEvent(type, { key: k, code, bubbles: true }); window.dispatchEvent(ev); document.dispatchEvent(ev); };
          const canvas = [...document.querySelectorAll("canvas")].sort((a, b) => b.width * b.height - a.width * a.height)[0];
          const r = (canvas ?? document.body).getBoundingClientRect(), at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, pointerId: 1, isPrimary: true, button: 0 };
          const click = () => { const t = canvas ?? document.body; for (const [C, type] of [[PointerEvent, "pointerdown"], [MouseEvent, "mousedown"], [PointerEvent, "pointerup"], [MouseEvent, "mouseup"], [MouseEvent, "click"]]) t.dispatchEvent(new C(type, at)); };
          // Past a title screen and into play, the ways a player would: Enter, space, a click, space again.
          const space = async () => { key("keydown", " ", "Space"); await new Promise(r => setTimeout(r, 50)); key("keyup", " ", "Space"); };
          key("keydown", "Enter", "Enter"); key("keyup", "Enter", "Enter"); await space(); click(); await new Promise(r => setTimeout(r, 50)); await space();
          const pixels = () => { const c = Object.assign(document.createElement("canvas"), { width: 64, height: 64 }), x = c.getContext("2d"); x.drawImage(canvas, 0, 0, 64, 64); return x.getImageData(0, 0, 64, 64).data; };
          if (canvas) {
            await new Promise(r => setTimeout(r, 300)); const a = pixels(); await new Promise(r => setTimeout(r, 500)); const b = pixels();
            out.drawn = new Set(Array.from({ length: 4096 }, (_, i) => a[i * 4] << 16 | a[i * 4 + 1] << 8 | a[i * 4 + 2])).size > 3;
            out.animates = a.some((v, i) => v !== b[i]);
          }
          // What the game's own frame callbacks cost, from the next frame it asks for: frames that arrive late measure
          // the machine's load (three runs at once, each with an agent), not the game.
          const sorted = work.slice(5).sort((a, b) => a - b);
          out.frameP95 = sorted.length ? sorted[Math.floor(sorted.length * .95)] : null;
          // The same seed and inputs, twice: a game you can replay is a game you can test.
          const play = () => { g.reset(7); g.press("launch", true); g.step(1); g.press("launch", false); g.press("right", true); g.step(40); g.press("right", false); g.step(200); return JSON.stringify(s()); };
          out.same = play() === play();
          g.reset(1); const before = s(); g.press("launch", true); g.step(1); g.press("launch", false); g.step(20);
          out.moves = s().ball.y !== before.ball.y;
          const x = s().paddle.x; g.press("right", true); g.step(30); g.press("right", false);
          out.paddle = s().paddle.x > x;
          g.press("pause", true); g.step(1); g.press("pause", false);
          const paused = s(); g.step(60);
          out.pause = paused.scene === "paused" && JSON.stringify(s().ball) === JSON.stringify(paused.ball);
          g.press("pause", true); g.step(1); g.press("pause", false); out.resumed = s().scene === "play";
          // A tick's cost, in one call: a step may draw what it changed, once per call.
          g.reset(2); g.press("launch", true); g.step(1); g.press("launch", false);
          let t0 = performance.now(); g.step(600); out.tickMs = (performance.now() - t0) / 600;
          // A bot that follows the ball breaks bricks; one that hides in a corner loses its lives.
          // bricks may be a count or a list of bricks, each standing until marked otherwise.
          const standing = b => Array.isArray(b) ? b.filter(x => x && x.alive !== false && x.active !== false && !x.dead && !x.destroyed && !x.broken && x.hp !== 0).length : b;
          g.reset(3); const bricks = standing(s().bricks);
          for (let t = 0; t < 3600; t++) {
            const { ball, paddle } = s();
            g.press("left", ball.x < paddle.x + paddle.w * .3); g.press("right", ball.x > paddle.x + paddle.w * .7);
            if (t % 60 === 0) g.press("launch", true); else if (t % 60 === 1) g.press("launch", false);
            g.step(1);
          }
          out.broke = `${s().score}|${bricks - standing(s().bricks)}`;
          g.press("left", false); g.press("right", false);
          g.reset(4); let lives = s().lives;
          g.press("left", true);
          for (let t = 0; t < 12000 && s().scene !== "over"; t++) { if (t % 60 === 0) g.press("launch", true); else if (t % 60 === 1) g.press("launch", false); g.step(1); lives = Math.min(lives, s().lives); }
          g.press("left", false);
          out.over = `${s().scene}|${lives}`;
        } catch (e) { out.error = e.message; }
        return out;
      });
      const g = typeof got === "object" && got ? got : {};
      const [score, broke] = String(g.broke ?? "0|0").split("|").map(Number);
      return [
        artifact(run),
        reportOk(run),
        tests(run, 6),
        [g.same === true, `the same seed and inputs replay the same game (${g.same ?? g.error ?? got})`],
        [g.moves === true && g.paddle === true, `launch moves the ball, right moves the paddle (${g.moves}, ${g.paddle})`],
        [g.pause === true && g.resumed === true, `pause freezes the ball and resumes (${g.pause}, ${g.resumed})`],
        [score > 0 && broke > 0, `a bot that follows the ball breaks bricks and scores (score ${score}, bricks ${broke})`],
        [/^over\|0$/.test(g.over ?? ""), `missing the ball costs lives, down to game over (${g.over})`],
        [g.drawn === true && g.animates === true, `the canvas draws the game and keeps drawing (${g.drawn}, ${g.animates})`],
        [g.tickMs < 0.5 && g.frameP95 < 8, `cheap to run: ${g.tickMs?.toFixed(3)} ms a tick, a frame's work p95 ${g.frameP95?.toFixed(1)} ms`],
        [/pointer|touch/i.test(source(run) + Object.entries(run.files).filter(([p]) => /\.m?js$/.test(p)).map(([, t]) => t).join("")), "plays on a phone: pointer or touch input"],
      ];
    },
  },
  {
    // The open brief: nothing says how to build it. What the harness teaches about games is what decides it.
    id: "game-ambitious",
    set: "game",
    timeout: 25 * 60_000,
    turns: ["Make a top-down arena shooter I'd actually want to play: move with WASD and aim with the mouse, waves of enemies that get harder, three enemy types that move differently, power-ups, particles and screen shake when things blow up, sound effects, a high score that survives a reload, and touch controls on a phone."],
    check: async run => {
      const code = Object.entries(run.files).filter(([p]) => /\.(html|m?js)$/.test(p) && !p.startsWith("scratch/")).map(([, t]) => t).join("\n");
      const got = await run.probe(html(run)[0], async () => {
        const errors = [];
        addEventListener("error", e => errors.push(e.message));
        addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
        // What the game's own frame callbacks cost, as in game-arcade; the probe's own frames aren't counted.
        const work = [], native = requestAnimationFrame.bind(window);
        window.requestAnimationFrame = cb => native(now => { const t = performance.now(); try { return cb(now); } finally { work.push(performance.now() - t); } });
        const canvas = [...document.querySelectorAll("canvas")].sort((a, b) => b.width * b.height - a.width * a.height)[0];
        const target = canvas ?? document.body, r = target.getBoundingClientRect();
        const at = (x, y) => ({ clientX: r.left + x * r.width, clientY: r.top + y * r.height, bubbles: true, pointerId: 1, isPrimary: true, button: 0 });
        const key = (type, k) => { const code = k.length === 1 ? (/[a-z]/i.test(k) ? "Key" + k.toUpperCase() : k === " " ? "Space" : k) : k; const ev = new KeyboardEvent(type, { key: k, code, bubbles: true }); window.dispatchEvent(ev); document.dispatchEvent(ev); };
        // Past a title screen, the way a player would get past it: keys held a few frames, a click, or the button it shows.
        // Why: Opus's start was a held action, and a press released in the same instant was never seen by a tick
        const hold = () => new Promise(r => setTimeout(r, 120));
        for (const k of ["Enter", " "]) { key("keydown", k); await hold(); key("keyup", k); await hold(); }
        target.dispatchEvent(new PointerEvent("pointerdown", at(.5, .5))); target.dispatchEvent(new MouseEvent("mousedown", at(.5, .5)));
        target.dispatchEvent(new PointerEvent("pointerup", at(.5, .5))); target.dispatchEvent(new MouseEvent("mouseup", at(.5, .5))); target.dispatchEvent(new MouseEvent("click", at(.5, .5)));
        [...document.querySelectorAll("button")].find(b => b.checkVisibility?.() && /start|play|enter|begin/i.test(b.textContent))?.click();
        const pixels = () => { if (!canvas) return null; const c = Object.assign(document.createElement("canvas"), { width: 64, height: 64 }), x = c.getContext("2d"); x.drawImage(canvas, 0, 0, 64, 64); return x.getImageData(0, 0, 64, 64).data; };
        const a = pixels(), gaps = []; let last = performance.now(), seed = 9;
        const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
        const keys = ["w", "a", "s", "d"], down = new Set();
        await new Promise(done => {
          const tick = now => {
            gaps.push(now - last); last = now;
            if (gaps.length % 10 === 0) for (const k of keys) { const want = rand() < .4; if (want && !down.has(k)) { down.add(k); key("keydown", k); } else if (!want && down.has(k)) { down.delete(k); key("keyup", k); } }
            const p = at(rand(), rand());
            target.dispatchEvent(new PointerEvent("pointermove", p)); target.dispatchEvent(new MouseEvent("mousemove", p));
            if (gaps.length % 20 === 0) { target.dispatchEvent(new PointerEvent("pointerdown", p)); target.dispatchEvent(new MouseEvent("mousedown", p)); }
            if (gaps.length % 20 === 10) { target.dispatchEvent(new PointerEvent("pointerup", p)); target.dispatchEvent(new MouseEvent("mouseup", p)); }
            gaps.length < 300 ? native(tick) : done();
          };
          native(tick);
        });
        for (const k of down) key("keyup", k);
        const b = pixels(), sorted = work.slice(10).sort((x, y) => x - y);
        return {
          canvas: !!canvas, errors: errors.slice(0, 3),
          animates: !!a && a.some((v, i) => v !== b[i]),
          frameP95: sorted.length ? sorted[Math.floor(sorted.length * .95)] : null,
        };
      });
      const g = typeof got === "object" && got ? got : {};
      const parts = run.calls.filter(c => c.name === "task" && /variant|part/.test(c.input?.type ?? "")).length;
      return [
        artifact(run),
        reportOk(run),
        tests(run, 8),
        [g.canvas === true && g.animates === true, `draws on a canvas and keeps moving (${g.canvas}, ${g.animates})`],
        [Array.isArray(g.errors) && !g.errors.length, `five seconds of random play throw nothing (${JSON.stringify(g.errors ?? got)})`],
        [g.frameP95 < 8, `a frame's work p95 under 8 ms while playing (${g.frameP95?.toFixed(1)})`],
        [/localStorage/.test(code) && /high|best/i.test(code), "keeps a high score in localStorage"],
        [/AudioContext|new Audio\(|Howl|Tone\./.test(code), "makes sound"],
        [/pointer|touch/i.test(code), "plays on a phone: pointer or touch input"],
        [true, `parallel builders sent: ${parts}`],
      ];
    },
  },
];
