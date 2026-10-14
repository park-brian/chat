// Tasks for the `swe` set: see docs/specs/2026-10-12-answer-quality-plan.md ("Benchmarks that grade themselves").
// Each is an issue against a small library pinned to one version, opened as the user's folder. The fixtures are in
// evals/swe/<task>/: repo/ is what the workspace starts with, hidden/ holds the tests the model never sees, fix/ the
// reference fix (whole files). Grading writes the model's files to a temporary folder, adds the hidden tests and the
// original tests as they were, and runs both with `node --test`.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unbackedClaims } from "./claims.js";

export const SWE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "swe");
const NODE_TIMEOUT = 60_000;

const lf = text => text.replace(/\r\n/g, "\n");
// Every file under dir, by its path relative to dir, with LF line ends whatever the checkout did.
export function readTree(dir, prefix = "") {
  const out = {};
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name), rel = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(out, readTree(full, rel + "/"));
    else out[rel] = lf(readFileSync(full, "utf8"));
  }
  return out;
}

// The browser half of the test setup, the same in every repository: test/index.html maps node:test and node:assert
// to the app's own stand-ins (node-test.js, which run_app uses on a test file), so the suite that `node --test` runs
// also runs as a page in the workspace.
const ASSERT_NAMES = "ok, equal, notEqual, strictEqual, notStrictEqual, deepEqual, notDeepEqual, deepStrictEqual, notDeepStrictEqual, throws, doesNotThrow, rejects, doesNotReject, match, doesNotMatch, ifError, fail";
const assertShim = name => `// node:assert${name === "strict" ? "/strict" : ""} for the browser: test/index.html maps it here.
import { ${name} as assert, AssertionError } from "./node-test.js";

export default assert;
export { AssertionError };
export const { ${ASSERT_NAMES} } = assert;
`;
const browserFiles = () => ({
  "node-test.js": lf(readFileSync(path.join(SWE_DIR, "..", "..", "node-test.js"), "utf8")),
  "assert.js": assertShim("assert"),
  "assert-strict.js": assertShim("strict"),
});
function testPage(name, files) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${name} tests</title>
  <!-- The test suite in a browser: node:test and node:assert map to the stand-ins in ./browser/.
       \`npm test\` runs the same files under Node. -->
  <script type="importmap">
    { "imports": { "node:test": "./browser/node-test.js", "node:assert": "./browser/assert.js", "node:assert/strict": "./browser/assert-strict.js" } }
  </script>
</head>
<body>
  <pre id="out">running…</pre>
  <script type="module">
    import { run } from "./browser/node-test.js";
    const files = ${JSON.stringify(files.map(f => "./" + f.slice("test/".length)))};
    let broken = 0;
    for (const file of files) {
      try { await import(file); }
      catch (e) { broken++; console.log("FAIL: import " + file + "\\n   " + (e?.stack ?? e)); }
    }
    const { passed, failed } = await run({ broken, base: new URL("../", location.href).href });
    document.getElementById("out").textContent = passed + " passed, " + failed + " failed";
  </script>
</body>
</html>
`;
}

const isTest = p => /^test\/[^/]+\.test\.js$/.test(p);
const cache = new Map();
// What the workspace starts with: the repository, plus the browser test page and its stand-ins.
export function seedFiles(name) {
  if (cache.has(name)) return cache.get(name);
  const repo = readTree(path.join(SWE_DIR, name, "repo"));
  for (const [f, text] of Object.entries(browserFiles())) repo["test/browser/" + f] = text;
  repo["test/index.html"] = testPage(JSON.parse(repo["package.json"]).name, Object.keys(repo).filter(isTest));
  // The README first: it opens the folder, the way a repository's front page does.
  const readme = Object.keys(repo).find(p => /^readme\.md$/i.test(p));
  const files = readme ? { [readme]: repo[readme], ...repo } : repo;
  cache.set(name, files);
  return files;
}
export const hiddenFiles = name => readTree(path.join(SWE_DIR, name, "hidden"));
export const fixFiles = name => readTree(path.join(SWE_DIR, name, "fix"));

// Lines added plus lines removed between two texts: a longest common subsequence over what differs.
export function changedLines(before = "", after = "") {
  const a = lf(before).split("\n"), b = lf(after).split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) endA--, endB--;
  const x = a.slice(start, endA), y = b.slice(start, endB);
  if (!x.length || !y.length) return x.length + y.length;
  let prev = new Array(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    const row = [0];
    for (let j = 1; j <= y.length; j++) row[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    prev = row;
  }
  return x.length + y.length - 2 * prev[y.length];
}

// Where a model's path lands in dir, or null for one that would leave it.
function inside(dir, file) {
  if (typeof file !== "string" || !file || /^[\\/]|^[a-z]:|(^|[\\/])\.\.([\\/]|$)|[\0:*?"<>|]/i.test(file)) return null;
  const target = path.resolve(dir, file);
  return target.startsWith(path.resolve(dir) + path.sep) ? target : null;
}

// node --test over files in dir: how many passed and failed, and the first failures' names.
function nodeTest(dir, files) {
  return new Promise(resolve => {
    execFile(process.execPath, ["--test", "--test-reporter=tap", ...files], { cwd: dir, timeout: NODE_TIMEOUT, windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, NODE_OPTIONS: "" } }, (error, stdout = "") => {
      const count = key => Number(stdout.match(new RegExp(`^# ${key} (\\d+)`, "m"))?.[1] ?? 0);
      resolve({ passed: count("pass"), failed: count("fail"), timedOut: !!error?.killed, failures: [...stdout.matchAll(/^not ok \d+ - (.*)$/gm)].map(m => m[1]).slice(0, 4) });
    });
  });
}

// Changes these may have without counting as "outside": tests, notes, docs and types.
const free = p => /^(test|scratch)\//.test(p) || /\.(md|d\.ts)$/i.test(p) || /(^|\/)(PLAN|SPEC|NOTES)\.md$/i.test(p);
const isSource = p => /\.(m|c)?[jt]s$/.test(p) && !free(p);
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "bundledDependencies"];
const specifiers = text => new Set([...lf(text ?? "").matchAll(/\b(?:from\s*|import\s*\(\s*|import\s+|require\s*\(\s*)(["'])([^"']+)\1/g)].map(m => m[2]).filter(s => !/^\.{0,2}\//.test(s)));

// The checks for one task: run is what eval.js collects (files, calls), spec the task's fixture names and limits.
export async function grade(run, { name, relevant, maxLines }) {
  const seed = seedFiles(name), hidden = hiddenFiles(name);
  const files = run.files ?? {};
  const dir = mkdtempSync(path.join(os.tmpdir(), `swe-${name}-`));
  try {
    for (const [p, text] of Object.entries(files)) {
      const target = inside(dir, p);
      if (!target || typeof text !== "string") continue;
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
    // The original tests as they were, whatever the model did to its copies; the hidden ones beside them.
    for (const [p, text] of Object.entries(seed).filter(([p]) => p.startsWith("test/"))) {
      mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      writeFileSync(path.join(dir, p), text);
    }
    const hiddenPaths = Object.keys(hidden).map(p => `test/hidden-${p}`);
    for (const [p, text] of Object.entries(hidden)) writeFileSync(path.join(dir, "test", `hidden-${p}`), text);
    const originals = Object.keys(seed).filter(isTest);
    const [fixed, kept] = await Promise.all([nodeTest(dir, hiddenPaths), nodeTest(dir, originals)]);

    const outside = [];
    for (const p of Object.keys(seed)) if (!relevant.includes(p) && !free(p) && lf(files[p] ?? "\0") !== seed[p]) outside.push(files[p] === undefined ? p + " (deleted)" : p);
    for (const p of Object.keys(files)) if (!(p in seed) && isSource(p)) outside.push(p + " (new)");
    const changed = relevant.reduce((n, p) => n + (files[p] === undefined ? 0 : changedLines(seed[p], files[p])), 0);

    let pkg = null;
    try { pkg = JSON.parse(files["package.json"] ?? seed["package.json"]); } catch {}
    const seedPkg = JSON.parse(seed["package.json"]);
    const depsOf = p => DEP_FIELDS.flatMap(f => Object.keys(p?.[f] ?? {})).sort().join(",");
    const newImports = relevant.flatMap(p => [...specifiers(files[p])].filter(s => !specifiers(seed[p]).has(s)));
    const noDeps = pkg !== null && depsOf(pkg) === depsOf(seedPkg) && !newImports.length;

    // Test counts the answer gives ("21 passed") must be ones a run report or a log returned (evals/claims.js).
    const unbacked = unbackedClaims(run.answer, run.results);
    const ran = (run.calls ?? []).some(c => c.name === "code" || c.name === "run_app" || (c.name === "bash" && /\b(node|npm|npx|pytest|python3?)\b/.test(c.input?.command ?? "")) || (["edit_file", "write_file"].includes(c.name) && /\.html?$/.test(c.input?.path ?? "")));
    const tally = r => `${r.passed}/${r.passed + r.failed}${r.timedOut ? ", timed out" : ""}${r.failures.length ? "; failing: " + r.failures.join(" | ") : ""}`;
    return [
      [fixed.passed > 0 && fixed.failed === 0 && !fixed.timedOut, `fixes the issue: hidden tests pass (${tally(fixed)})`],
      [kept.passed > 0 && kept.failed === 0 && !kept.timedOut, `breaks nothing: the library's own tests pass (${tally(kept)})`],
      [outside.length === 0, `changes only ${relevant.join(", ")}${outside.length ? ` (also: ${outside.slice(0, 6).join(", ")})` : ""}`],
      [changed > 0 && changed <= maxLines, `keeps the change small (${changed} lines changed, at most ${maxLines})`],
      [noDeps, `adds no dependencies${newImports.length ? ` (imports ${newImports.join(", ")})` : pkg === null ? " (package.json no longer parses)" : ""}`],
      [ran, "ran code to reproduce or check the fix"],
      [!unbacked.length, `reports only test results it got${unbacked.length ? ` (claims ${unbacked.join(", ")} passed; no report says so)` : ""}`],
    ];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const RUBRIC = [
  "The final message says what caused the problem in the code, not only the symptom the user reported.",
  "The final message says what was changed, naming the file.",
  "The final message says how the fix was checked (which tests or reproduction were run, and their result), and claims no check that the tool calls don't show. Every edit_file and run_app call returns a run report with the tests of the page it ran, so a test result may come from an edit.",
];

const task = ({ id, issue, relevant, maxLines, reference }) => ({
  id,
  set: "swe",
  turns: [{ files: seedFiles(id) }, issue],
  check: run => grade(run, { name: id, relevant, maxLines }),
  rubric: RUBRIC,
  reference,
  swe: { name: id, relevant, maxLines },
});

export default [
  task({
    // ms@2.1.1 (MIT), the commit before vercel/ms#111 (2669f23), released in 2.1.2. index.js made an ES module.
    id: "swe-ms-negative",
    issue: `ms('-10.5h') returns undefined. ms('-1.5h') gives -5400000 as expected, and ms('10.5h') works, but any negative decimal below -10 fails: ms('-10.5h'), ms('-12.25d'), ms('-100.5ms') all come back undefined. We read negative offsets from a config file, so this turns into NaN further down without any error. This is ms 2.1.1; the repo is open. Can you fix it?`,
    relevant: ["index.js"],
    maxLines: 8,
    reference: "The parse regex only allowed a single digit between the minus sign and the decimal point (\\-?\\d?\\.?\\d+), so '-10.5' did not match and parse returned undefined. The fix lets any number of digits follow the minus sign, e.g. /^((?:\\d+)?-?(?:\\d+)?\\.?\\d+) */ (or -?\\d*\\.?\\d+), in index.js.",
  }),
  task({
    // dset@3.1.1 (MIT), the commit before lukeed/dset#34 (2d156c7, CVE-2022-25645), released in 3.1.2.
    id: "swe-dset-pollution",
    issue: `Prototype pollution through dset/merge. We apply PATCH request bodies to a settings object with dset from dset/merge, and a body with a __proto__ key ends up on every object in the process:

\`\`\`js
import { dset } from 'dset/merge';
const settings = { profile: { name: 'a' } };
dset(settings, 'profile', JSON.parse('{"__proto__":{"isAdmin":true}}'));
({}).isAdmin; // true
\`\`\`

The key path is already checked for __proto__, but the value that gets merged in isn't. Plain dset (not /merge) doesn't do this. This is dset 3.1.1; the repo is open.`,
    relevant: ["src/merge.js", "src/index.js"],
    maxLines: 10,
    reference: "merge() copies every key of the incoming object with for...in, including an own '__proto__' key that JSON.parse creates, so a[k] = merge(a['__proto__'], ...) merges into Object.prototype. The fix in src/merge.js skips (or stops at) the keys __proto__, constructor and prototype in that loop, as dset already does for the path.",
  }),
  task({
    // regexparam@2.0.2 (MIT), the commit before lukeed/regexparam#25 (422f630), released in 3.0.0.
    id: "swe-regexparam-wildcard",
    issue: `Optional wildcard doesn't match the bare path. I expected '/books/*?' to make the wildcard optional, so that '/books' matches with wild = null, the way '/books/:title?' matches '/books'. Instead:

\`\`\`js
import { parse } from 'regexparam';
parse('/books/:title?').pattern.test('/books'); // true
parse('/books/*?').pattern.test('/books');      // false
parse('/books/*?').pattern.test('/books/x');    // true
\`\`\`

Could you make *? optional? A plain '/books/*' should keep working as it does now. regexparam 2.0.2, the repo is open.`,
    relevant: ["src/index.js"],
    maxLines: 8,
    reference: "parse() turned every '*' segment into '/(.*)' and ignored a '?' after it, so the slash before the wildcard was always required. The fix in src/index.js emits an optional group for '*?', '(?:/(.*))?', and keeps '/(.*)' for '*'. '/bookshelf' must still not match '/books/*?'.",
  }),
  task({
    // mri@1.1.4 (MIT), the commit before lukeed/mri's fix for #10 (5437ea5), released in 1.1.5. lib/index.js made an ES module.
    id: "swe-mri-alias-default",
    issue: `A default's type doesn't carry over to its aliases. The default for arg is a string, and --arg keeps the value as a string, but -a casts it to a number and loses the leading zero:

\`\`\`js
import mri from 'mri';
mri(['--arg', '01'], { alias: { a: ['arg'] }, default: { arg: '' } }); // { _: [], arg: '01', a: '01' }
mri(['-a', '01'], { alias: { a: ['arg'] }, default: { arg: '' } });    // { _: [], a: 1, arg: 1 }
\`\`\`

Same with a boolean default: mri(['-v', 'file.txt'], { alias: { v: ['verbose'] }, default: { verbose: false } }) gives { v: 'file.txt', verbose: 'file.txt' } and file.txt is gone from _. mri 1.1.4, the repo is open.`,
    relevant: ["lib/index.js"],
    maxLines: 24,
    reference: "When opts.default is given, mri adds each default's key to opts.string or opts.boolean by the default's type, but only the key itself, not its aliases, so '-a' is parsed as an untyped flag. The fix in lib/index.js also pushes every alias of the key (opts.alias[k]) into the same type list.",
  }),
  task({
    // klona@2.0.4 (MIT), the commit before lukeed/klona#31 (7650274), released in 2.0.5.
    id: "swe-klona-assign",
    issue: `klona drops the fields of class instances whose constructor sets them with Object.assign:

\`\`\`js
import { klona } from 'klona';
class User { constructor(data) { Object.assign(this, data); } }
const u = new User({ name: 'Ada', roles: ['admin'] });
klona(u); // User {}  — expected User { name: 'Ada', roles: ['admin'] }
\`\`\`

Same with klona/lite. Classes that assign their fields one by one in the constructor (this.name = ...) clone fine. klona 2.0.4, the repo is open.`,
    relevant: ["src/index.js", "src/lite.js"],
    maxLines: 12,
    reference: "For a class instance, klona creates tmp = new x.constructor() and then copies only keys for which tmp.hasOwnProperty(k), i.e. keys the argument-less constructor created; Object.assign(this, undefined) creates none, so every field is skipped. The fix in src/index.js and src/lite.js checks x.hasOwnProperty(k) instead, so the instance's own fields are copied.",
  }),
  task({
    // mitt@3.0.1 (MIT), src/index.ts as JavaScript. The bug is introduced: emit without .slice(), as before 1.1.3 (developit/mitt#65).
    id: "swe-mitt-off-emit",
    issue: `My once() helper makes mitt skip the next listener:

\`\`\`js
import mitt from 'mitt';
const once = (em, type, fn) => { const w = e => { em.off(type, w); fn(e); }; em.on(type, w); };
const em = mitt();
once(em, 'save', () => console.log('once'));
em.on('save', () => console.log('always'));
em.emit('save'); // logs only "once"; "always" doesn't run
em.emit('save'); // logs "always"
\`\`\`

Same with '*' listeners that remove themselves. mitt 3.0.1 (our copy in src/index.js), the repo is open.`,
    relevant: ["src/index.js"],
    maxLines: 8,
    reference: "emit() iterates the live handler array; off() splices the handler out of that same array during the iteration, so the next handler shifts into the removed one's index and is skipped. The fix in src/index.js iterates a copy (handlers.slice()) for both the typed and the '*' handlers.",
  }),
  task({
    // dequal@2.0.3 (MIT). The bug is introduced: the object branch's key-count comparison is >= instead of ===.
    id: "swe-dequal-keys",
    issue: `dequal isn't symmetric for objects:

\`\`\`js
import { dequal } from 'dequal';
dequal({ a: 1, b: 2 }, { a: 1 }); // false
dequal({ a: 1 }, { a: 1, b: 2 }); // true  ← should be false
\`\`\`

We use it to detect changed form state, and a field that was added isn't detected. dequal/lite does the same. dequal 2.0.3, the repo is open.`,
    relevant: ["src/index.js", "src/lite.js"],
    maxLines: 8,
    reference: "In the plain-object branch, dequal counts foo's own keys while checking each exists in bar, then returned Object.keys(bar).length >= len, so extra keys in bar passed. The fix in src/index.js and src/lite.js compares with === len.",
  }),
];
