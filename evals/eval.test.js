// eval.js's pure helpers and the graders' CDN check, without a browser or a model.
import assert from "node:assert/strict";
import path from "node:path";
import { filePath, MAX_UNCONFIRMED, options, summarize } from "../eval.js";
import { pinsJsdelivr } from "./tasks.js";

const dir = path.resolve("run");
assert.equal(filePath(dir, "index.html"), path.join(dir, "files", "index.html"));
assert.equal(filePath(dir, "src/a/b.js"), path.join(dir, "files", "src", "a", "b.js"));
for (const bad of ["../x", "a/../../x", "/etc/passwd", "", "files/../../x", ".", null, ...(process.platform === "win32" ? ["C:/x", "..\\x"] : [])]) assert.equal(filePath(dir, bad), null, String(bad));

const tasks = [{ id: "a", set: "inner" }, { id: "b", set: "hard" }];
const o = options(["--tasks", "a,b", "--models", "haiku", "--repeat", "2", "--yes"], tasks);
assert.deepEqual([o.tasks.map(t => t.id), o.models.map(m => m[0]), o.repeat, o.concurrency, o.yes], [["a", "b"], ["haiku"], 2, 3, true]);
assert.equal(options([], tasks).tasks.length, 1);
for (const argv of [["--repeat", "0"], ["--repeat", "x"], ["--concurrency", "1.5"], ["--repeat"], ["--repeat", "--yes"], ["--nope"], ["stray"], ["--models", "toString"], ["--tasks", "zzz"]])
  assert.throws(() => options(argv, tasks), undefined, argv.join(" "));
assert.ok(MAX_UNCONFIRMED === 20);

const s = summarize([{ passed: 1, total: 2 }, { passed: 2, total: 2 }, { crashed: "boom", passed: 0, total: 0 }, { passed: 0, total: 1, error: "timeout" }]);
assert.equal(s.mean, (0.5 + 1 + 0) / 3);
assert.deepEqual([s.scored, s.crashed.length, s.unfinished.length], [3, 1, 1]);
assert.ok(Number.isNaN(summarize([]).mean));

assert.ok(pinsJsdelivr(`import x from "https://cdn.jsdelivr.net/npm/marked@12.0.1/+esm"; <script src="https://cdn.jsdelivr.net/npm/@scope/pkg@1/dist/x.js">`));
assert.ok(pinsJsdelivr("no cdn here"));
assert.ok(!pinsJsdelivr(`"https://cdn.jsdelivr.net/npm/marked@12/+esm" "https://cdn.jsdelivr.net/npm/chart.js"`));
assert.ok(!pinsJsdelivr(`"https://cdn.jsdelivr.net/npm/chart.js@latest/dist/chart.umd.js"`));
assert.ok(!pinsJsdelivr(`"https://cdn.jsdelivr.net/npm/@scope/pkg/x.js"`));

console.log("eval helpers: ok");
