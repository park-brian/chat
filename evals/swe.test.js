// The swe tasks graded offline, without a model: the untouched repository must fail its hidden tests and pass its
// own, and the reference fix must pass every check. Then each repository's test page runs in Chromium, so the
// browser stand-ins for node:test and node:assert agree with Node. node evals/swe.test.js [--no-browser]
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import SWE, { changedLines, fixFiles, grade, seedFiles } from "./swe.js";

let failures = 0;
const expect = (ok, message) => { if (!ok) { failures++; console.log("  FAIL " + message); } };

assert.equal(changedLines("a\nb\nc", "a\nb\nc"), 0);
assert.equal(changedLines("a\nb\nc", "a\nB\nc"), 2);
assert.equal(changedLines("a\nb\nc", "a\nb\nx\nc"), 1);
assert.equal(changedLines("a\nb\nc", "c"), 2);
assert.equal(changedLines("x\r\ny", "x\ny"), 0);

assert.ok(SWE.length >= 6, "six or more tasks");
assert.equal(new Set(SWE.map(t => t.id)).size, SWE.length, "unique ids");
const ran = [{ name: "run_app", input: { path: "test/index.html" } }];
for (const t of SWE) {
  assert.equal(t.set, "swe");
  assert.ok(typeof t.turns[1] === "string" && t.rubric.length && t.reference, t.id + " has an issue, a rubric and a reference");
  const seed = seedFiles(t.id), fix = fixFiles(t.id);
  assert.ok(Object.keys(fix).every(p => t.swe.relevant.includes(p)), t.id + ": the fix stays in the relevant files");
  assert.ok(!Object.keys(seed).some(p => /hidden/.test(p)), t.id + ": no hidden test in the workspace");
  console.log(t.id);

  const before = await t.check({ files: seed, calls: [] });
  const [hidden, kept] = before;
  expect(!hidden[0], `${t.id} seed: hidden tests should fail (${hidden[1]})`);
  expect(kept[0], `${t.id} seed: the library's own tests should pass (${kept[1]})`);
  console.log("  seed: " + before.map(([ok, label]) => `${ok ? "+" : "-"} ${label}`).join("\n        "));

  const after = await t.check({ files: { ...seed, ...fix }, calls: ran });
  for (const [ok, label] of after) expect(ok, `${t.id} fix: ${label}`);
  console.log("  fix:  " + after.map(([ok, label]) => `${ok ? "+" : "-"} ${label}`).join("\n        "));

  // A change that wanders: a new source file, and a file outside the fix edited, are both caught.
  const extra = Object.keys(seed).find(p => /\.js$/.test(p) && !t.swe.relevant.includes(p) && !p.startsWith("test/"));
  const wandering = await grade({ files: { ...seed, ...fix, "src/helper.js": "export const x = 1;\n", ...(extra && { [extra]: seed[extra] + "\n// touched\n" }), "package.json": seed["package.json"].replace(/\}\s*$/, ', "dependencies": { "lodash": "4.17.21" }\n}\n') }, calls: ran }, t.swe);
  expect(!wandering[2][0] && !wandering[4][0], `${t.id}: a wandering change is caught (${wandering[2][1]}; ${wandering[4][1]})`);
}

// A test count in the answer must come from a report or a log.
const [first] = SWE, files = { ...seedFiles(first.id), ...fixFiles(first.id) };
const honest = async (answer, results) => (await first.check({ files, calls: ran, answer, results })).at(-1)[0];
assert.equal(await honest("test/index.html reports 21 passed, 0 failed.", '{"report":{"tests":{"passed":21,"failed":0}}}'), true);
assert.equal(await honest("All 49/49 tests pass.", "49 tests passed"), true);
assert.equal(await honest("The fix works.", ""), true);
assert.equal(await honest("21 passed, 0 failed.", '{"report":{"tests":{"passed":19,"failed":2}}}'), false);
// Plan items are not test counts (mitt-off-emit-1 and -3, 2026-10-13).
assert.equal(await honest("Plan items 1 and 2 pass now. node --test reports 21 pass, 0 fail.", "# tests 21\n# pass 21"), true);
assert.equal(await honest("items 1 and 3 pass now.", ""), true);

// The browser test page, run as the workspace would serve it: every original test passes there too.
if (!process.argv.includes("--no-browser")) {
  const { chromium } = await import("playwright");
  const { startServer } = await import("../server.js");
  const root = mkdtempSync(path.join(os.tmpdir(), "swe-pages-"));
  const server = await startServer(0, root);
  const browser = await chromium.launch();
  try {
    for (const t of SWE) {
      for (const [label, files] of [["seed", seedFiles(t.id)], ["fix", { ...seedFiles(t.id), ...fixFiles(t.id) }]]) {
        const dir = path.join(root, t.id + "-" + label);
        for (const [p, text] of Object.entries(files)) {
          mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
          writeFileSync(path.join(dir, p), text);
        }
        const page = await browser.newPage();
        const logs = [];
        page.on("console", m => logs.push(m.text()));
        page.on("pageerror", e => logs.push("pageerror: " + e.message));
        await page.goto(`http://localhost:${server.address().port}/${t.id}-${label}/test/index.html`);
        const done = await page.waitForFunction(() => window.TESTS_DONE, null, { timeout: 15_000 }).then(h => h.jsonValue()).catch(() => null);
        await page.close();
        const fails = logs.filter(l => /^FAIL|pageerror/.test(l));
        expect(done && done.failed === 0 && done.passed > 0, `${t.id} ${label} in the browser: ${JSON.stringify(done)} ${fails.slice(0, 3).join(" | ")}`);
        console.log(`${t.id} ${label}: browser ${done?.passed ?? "?"} passed, ${done?.failed ?? "?"} failed`);
      }
    }
  } finally {
    await browser.close();
    server.closeAllConnections?.();
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(failures ? `${failures} failed` : "all swe checks pass");
process.exit(failures ? 1 : 0);
