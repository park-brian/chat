// E11 spike driver: serves the repository with the app's own static server (no COOP/COEP headers, like GitHub
// Pages), opens spike/shell.html in headless Chromium, runs the fixed command list and prints a results table.
// node spike/run.mjs [--only=shell,node,npm,git,py,pydata,ml,loops,almostnode] [--gpu] [--json=out.json]
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";
import { chromium } from "playwright";
import { startServer } from "../server.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? true]));
const only = args.only ? new Set(String(args.only).split(",")) : null;
const want = g => !only || only.has(g);

// --- seed files ---------------------------------------------------------------------------------------------------
function readTree(dir, prefix, out = {}) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) readTree(p, prefix + "/" + name, out);
    else out[prefix + "/" + name] = readFileSync(p, "utf8");
  }
  return out;
}
const SWE = join(ROOT, "evals", "swe");
const seed = {
  ...readTree(join(SWE, "swe-dequal-keys", "repo"), "/project"),
  ...readTree(join(SWE, "swe-ms-negative", "repo"), "/ms"),
  ...readTree(join(SWE, "swe-ms-negative", "hidden"), "/fixtures/ms/hidden"),
  ...readTree(join(SWE, "swe-ms-negative", "fix"), "/fixtures/ms/fix"),
  ...readTree(join(SWE, "swe-dequal-keys", "hidden"), "/fixtures/dequal/hidden"),
  ...readTree(join(SWE, "swe-dequal-keys", "fix"), "/fixtures/dequal/fix"),
  "/project/x.txt": "banana\n",
  "/project/a.txt": "one\ntwo\nthree\n",
  "/project/b.txt": "one\n2\nthree\nfour\n",
  "/project/words.txt": "b\na\nb\nc\na\nb\n",
  "/project/hello.cjs": "const path = require('path'); const { EventEmitter } = require('events'); const util = require('util');\nconst e = new EventEmitter(); e.on('x', v => console.log('event', v)); e.emit('x', path.join('a', 'b'));\nconsole.log(util.format('%s=%d', 'n', 42), Buffer.from('hi').toString('base64'), process.argv.slice(2).join(','));\n",
  "/project/hello.mjs": "import path from 'node:path';\nimport { readFileSync } from 'node:fs';\nconst pj = JSON.parse(readFileSync('package.json', 'utf8'));\nconsole.log('esm', path.basename(import.meta.url), pj.name);\n",
  "/project/writes.cjs": "require('fs').writeFileSync('out.txt', 'from node\\n'); require('fs').mkdirSync('gen/deep', { recursive: true }); require('fs').writeFileSync('gen/deep/a.json', '{}');\n",
  "/work/use-ms.cjs": "console.log(require('ms')('2h'));\n",
  "/work/use-chalk.cjs": "const chalk = require('chalk'); console.log(chalk.red('red'), 'level', chalk.level);\n",
  "/work/use-esr.mjs": "import esr from 'escape-string-regexp';\nconsole.log(esr('a.b*c'));\n",
  "/py/data.csv": "city,temp\nOslo,3\nOslo,5\nRome,18\nRome,20\nLima,15\n",
  "/py/hello.py": "import sys\nrows = open('data.csv').read().splitlines()[1:]\nopen('out.txt', 'w').write(f'{len(rows)} rows, argv={sys.argv[1:]}\\n')\nprint('wrote out.txt')\n",
  "/py/test_tiny.py": "def test_pass():\n    assert 1 + 1 == 2\n\ndef test_fail():\n    assert 1 + 1 == 3\n",
  "/py/analysis.py": [
    "import pandas as pd, duckdb, matplotlib",
    "matplotlib.use('Agg')",
    "import matplotlib.pyplot as plt",
    "df = pd.read_csv('data.csv')",
    "g = df.groupby('city')['temp'].mean().sort_index()",
    "print('groupby', g.to_dict())",
    "print('duckdb', duckdb.sql(\"select city, max(temp) as hi from read_csv_auto('data.csv') group by city order by city\").fetchall())",
    "g.plot.bar(); plt.tight_layout(); plt.savefig('fig.png', dpi=80)",
    "print('png', len(open('fig.png','rb').read()))",
  ].join("\n") + "\n",
  "/ml/gpu.mjs": "let gl = null; try { gl = new OffscreenCanvas(1, 1).getContext('webgl2') ? 'webgl2' : 'none'; } catch (e) { gl = 'error ' + e.message; }\nconst a = navigator.gpu ? await navigator.gpu.requestAdapter() : undefined;\nconsole.log('navigator.gpu', navigator.gpu ? 'present' : 'absent', '| adapter', a === undefined ? '-' : a ? (a.info?.vendor || 'yes') + ' ' + (a.info?.architecture || '') : 'null', '| OffscreenCanvas', gl);\n",
  "/ml/tf.mjs": [
    "import * as tf from 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/+esm';",
    "let webgpu = 'no adapter';",
    "const adapter = navigator.gpu && await navigator.gpu.requestAdapter();",
    "if (adapter) { try { await import('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-webgpu@4.22.0/+esm'); webgpu = 'registered'; } catch (e) { webgpu = 'import failed: ' + e.message; } }",
    "for (const b of (process.argv[2] ? [process.argv[2]] : [adapter && 'webgpu', 'webgl', 'cpu']).filter(Boolean)) { try { if (await tf.setBackend(b)) break; } catch {} }",
    "await tf.ready();",
    "console.error('chosen backend', tf.getBackend());",
    "const t0 = performance.now();",
    "const model = tf.sequential({ layers: [tf.layers.dense({ units: 16, activation: 'relu', inputShape: [2] }), tf.layers.dense({ units: 1 })] });",
    "model.compile({ optimizer: tf.train.adam(0.05), loss: 'meanSquaredError' });",
    "const xs = tf.randomNormal([512, 2]), ys = xs.sum(1).expandDims(1);",
    "const h = await model.fit(xs, ys, { epochs: 30, batchSize: 64, verbose: 0 });",
    "console.log('backend', tf.getBackend(), '| webgpu', webgpu, '| loss', h.history.loss.at(-1).toFixed(4), '| train ms', Math.round(performance.now() - t0));",
  ].join("\n") + "\n",
  "/ml/ort.mjs": [
    "import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.wasm.min.mjs';",
    "ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';",
    "ort.env.wasm.numThreads = 1;",
    "const t0 = performance.now();",
    "process.versions.node = undefined; // otherwise ort's Emscripten glue takes the Node path (import 'worker_threads')",
    "const bytes = new Uint8Array(await (await fetch('https://raw.githubusercontent.com/microsoft/onnxruntime-inference-examples/ae2c5417c4b8454023a67a7595a4bc80d1cce6ab/js/quick-start_onnxruntime-web-bundler/model.onnx')).arrayBuffer());",
    "const s = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });",
    "const a = new ort.Tensor('float32', Float32Array.from({ length: 12 }, (_, i) => i), [3, 4]);",
    "const b = new ort.Tensor('float32', Float32Array.from({ length: 12 }, (_, i) => i), [4, 3]);",
    "const out = await s.run({ [s.inputNames[0]]: a, [s.inputNames[1]]: b });",
    "const c = out[s.outputNames[0]];",
    "console.log('inputs', s.inputNames.join(','), '| out', c.dims.join('x'), Array.from(c.data).slice(0, 3).join(','), '| ms', Math.round(performance.now() - t0));",
  ].join("\n") + "\n",
};

// --- the command list -------------------------------------------------------------------------------------------
const has = s => r => r.stdout.includes(s);
const exit = n => r => r.exitCode === n;
const all = (...fs) => r => fs.every(f => f(r));
const counts = r => (r.stdout.match(/# tests (\d+)\n# pass (\d+)\n# fail (\d+)/) ?? []).slice(1).join("/");
const ITEMS = [
  ["shell", "ls -la", "ls -la", all(exit(0), has("package.json"))],
  ["shell", "cat | jq", "cat package.json | jq .name", has('"dequal"')],
  ["shell", "grep -rn | head", 'grep -rn "function" src | head -5', all(exit(0), r => r.stdout.trim().split("\n").length === 3)], // real grep: 3 matches
  ["shell", "find | wc -l", 'find . -name "*.js" | wc -l', r => +r.stdout.trim() === 6],
  ["shell", "sed -i", "sed -i 's/a/b/' x.txt && cat x.txt", has("bbnana")],
  ["shell", "redirect, rm", "echo hi > f && cat f && rm f && test ! -e f && echo gone", has("hi\ngone")],
  ["shell", "for loop", "for f in src/*.js; do wc -l $f; done", r => r.stdout.trim().split("\n").length === 2],
  ["shell", "cd in one exec", "cd src && pwd && cd ..", has("/project/src")],
  ["shell", "cwd persists (cd src; pwd)", "cd src", exit(0), "pwd", has("/project/src\n"), "cd .."],
  ["shell", "export persists across execs", "export X=1", exit(0), "echo $X", r => r.stdout === "1\n"],
  ["shell", "sort | uniq -c", "sort words.txt | uniq -c | sort -rn", r => /3 b/.test(r.stdout)],
  ["shell", "diff", "diff a.txt b.txt; echo exit=$?", all(has("< two"), has("> 2"), has("exit=1"))],
  ["shell", "tar czf / xzf round trip (DIY tar)", "tar czf /tmp/src.tgz src && mkdir -p /tmp/out && tar xzf /tmp/src.tgz -C /tmp/out && diff src/index.js /tmp/out/src/index.js && echo same", has("same")],
  ["shell", "gzip / gunzip (DIY, CompressionStream)", "cp x.txt /tmp/g.txt && gzip /tmp/g.txt && gunzip /tmp/g.txt.gz && cat /tmp/g.txt", has("bbnana")],
  ["node", "node -v", "node -v", has("v22")],
  ["node", 'node -e "console.log(1+1)"', 'node -e "console.log(1+1)"', r => r.stdout === "2\n"],
  ["node", "node file.cjs (path/events/util/buffer)", "node hello.cjs a b", all(has("event a/b"), has("n=42 aGk= a,b"))],
  ["node", "node file.mjs (ESM, fs, import.meta)", "node hello.mjs", has("esm hello.mjs dequal")],
  ["node", "node writes files back to the shell FS", "node writes.cjs && cat out.txt gen/deep/a.json", has("from node\n{}")],
  ["node", "node --test dequal seeds", "node --test test/index.test.js test/lite.test.js", all(exit(0), has("# tests 44"))],
  ["node", "node --test ms seeds", "cd /ms && node --test test/index.test.js", all(exit(0), has("# tests 47"))],
  ["node", "ms hidden test fails before fix", "cp /fixtures/ms/hidden/*.js test/ && node --test test/negative-decimals.test.js", r => r.exitCode === 1 && /# fail [1-9]/.test(r.stdout)],
  ["node", "ms hidden test passes after fix", "cp /fixtures/ms/fix/index.js index.js && node --test test/negative-decimals.test.js", exit(0)],
  ["node", "npm test (ms, all test files)", "npm test", all(exit(0), has("# fail 0"))],
  ["node", "node -e sync infinite loop: nested Worker.terminate", 'cd /project && NODE_TIMEOUT_MS=1500 node -e "while(true){}"', exit(124)],
  ["git", "git init", "git init", has("Initialized")],
  ["git", "git add -A", "git add -A", exit(0)],
  ["git", "git commit -m x", "git commit -m x", has("[main ")],
  ["node", "dequal hidden test fails before fix", "cp /fixtures/dequal/hidden/*.js test/ && node --test test/extra-keys.test.js", r => r.exitCode === 1 && /# fail [1-9]/.test(r.stdout)],
  ["node", "apply the dequal fix", "cp /fixtures/dequal/fix/src/*.js src/", exit(0)],
  ["git", "git status", "git status --short", all(has(" M src/index.js"), has("?? test/extra-keys.test.js"))],
  ["git", "git diff", "git diff", all(has("diff --git a/src/index.js"), has("@@"))],
  ["node", "dequal hidden test passes after fix", "node --test test/extra-keys.test.js", exit(0)],
  ["node", "node --test (default discovery, dequal)", "node --test", all(exit(0), has("# fail 0"))],
  ["git", "git log", "git add -A && git commit -m fix", exit(0), "git log --oneline", r => r.stdout.trim().split("\n").length === 2],
  ["npm", "npm install ms@2.1.3", "mkdir -p /work && cd /work && npm install ms@2.1.3", has("added 1 packages")],
  ["npm", "require('ms')('2h')", `node -e "console.log(require('ms')('2h'))"`, r => r.stdout === "7200000\n"],
  ["npm", "npm install chalk@4 (deps)", "npm install chalk@4", has("added")],
  ["npm", "require('chalk')", "node use-chalk.cjs", has("red level 0")],
  ["npm", "npm install escape-string-regexp@5 (ESM-only)", "npm install escape-string-regexp@5", has("added 1")],
  ["npm", "import ESM-only package (.mjs)", "node use-esr.mjs", has("a\\.b\\*c")],
  ["npm", "import() of ESM-only from node -e", `node -e "import('escape-string-regexp').then(m => console.log(m.default('x.y')))"`, has("x\\.y")],
  ["npm", "require() of ESM-only (Node 22.12+ allows)", `node -e "console.log(require('escape-string-regexp')('x.y'))"`, has("x\\.y")],
  ["npm", "npm install lodash@4.17.21 (600 files)", "npm install lodash@4.17.21", has("added")],
  ["npm", "require('lodash')", `node -e "console.log(require('lodash').chunk([1,2,3,4], 2))"`, has("[ [ 1, 2 ], [ 3, 4 ] ]")],
  ["npm", "npm install typescript@5.9.3", "npm install typescript@5.9.3", has("added")],
  ["npm", "tsc --version", "node node_modules/typescript/bin/tsc --version", has("Version 5.9.3")],
  ["npm", "tsc --noEmit on a file", "echo 'const n: number = \"x\";' > bad.ts && node node_modules/typescript/bin/tsc --noEmit bad.ts; echo exit=$?", all(has("TS2322"), has("exit=2"))],
  ["py", "python3 -c (cold: loads Pyodide)", 'python3 -c "print(1+1)"', r => r.stdout === "2\n"],
  ["py", "python3 -c (warm)", 'python3 -c "print(2+2)"', r => r.stdout === "4\n"],
  ["py", "python3 file.py reads/writes the shell FS", "cd /py && python3 hello.py x && cat out.txt", has("5 rows, argv=['x']")],
  ["py", "pip install six (pure Python)", "pip install six && python3 -c 'import six; print(six.__version__)'", has("1.17")],
  ["py", "pip install attrs", "pip install attrs && python3 -c 'import attrs; print(attrs.__version__)'", exit(0)],
  ["py", "pip install numpy (Pyodide-built)", "pip install numpy && python3 -c 'import numpy as np; print(np.arange(6).reshape(2, 3).sum())'", has("15")],
  ["py", "pip install pytest", "pip install pytest", exit(0)],
  ["py", "pytest -q (1 pass, 1 fail)", "pytest -q test_tiny.py", r => r.exitCode === 1 && /1 failed, 1 passed/.test(r.stdout)],
  ["pydata", "pip install pandas matplotlib duckdb", "pip install pandas matplotlib duckdb", exit(0)],
  ["pydata", "pandas groupby + duckdb SQL + matplotlib PNG", "python3 analysis.py && ls -la fig.png", all(has("groupby {'Lima': 15.0"), has("duckdb [('Lima', 15)"), has("fig.png"))],
  ["ml", "navigator.gpu / WebGL in nested worker", "cd /ml && node gpu.mjs", has("navigator.gpu")],
  ["ml", "TensorFlow.js training loop", "NODE_TIMEOUT_MS=120000 node tf.mjs", has("loss")],
  ["ml", "TensorFlow.js training loop, cpu backend", "NODE_TIMEOUT_MS=120000 node tf.mjs cpu", has("backend cpu")],
  ["ml", "onnxruntime-web tiny model (Node detection hidden)", "node ort.mjs", has("out 3x3")],
];
const GROUP_OF_LOOPS = "loops";

// --- sizes of what the page loaded (esm.sh sends no Timing-Allow-Origin, so measure the URLs here) ---------------
const sizeCache = new Map();
function transferSize(url) {
  if (sizeCache.has(url)) return sizeCache.get(url);
  const p = new Promise(resolve => {
    const req = https.get(url, { headers: { "accept-encoding": "br, gzip", origin: "http://localhost" } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return transferSize(new URL(res.headers.location, url).href).then(resolve);
      let n = 0;
      res.on("data", d => (n += d.length)).on("end", () => resolve(n)).on("error", () => resolve(0));
    });
    req.on("error", () => resolve(0));
  });
  sizeCache.set(url, p);
  return p;
}
async function sizeOf(urls) {
  const external = [...new Set(urls)].filter(u => u.startsWith("https://"));
  const sizes = await Promise.all(external.map(transferSize));
  return { count: external.length, bytes: sizes.reduce((a, b) => a + b, 0) };
}

// --- run ------------------------------------------------------------------------------------------------------------
const server = await startServer(0, ROOT);
const base = `http://localhost:${server.address().port}/spike/shell.html`;
const launchArgs = args.gpu ? ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=d3d11"] : [];
const browser = await chromium.launch({ headless: true, args: launchArgs, ...(args.channel ? { channel: args.channel } : {}) });
const context = await browser.newContext();
const out = { rows: [], boot: {}, sizes: {}, notes: [] };

async function openShell() {
  const page = await context.newPage();
  page.on("console", m => m.type() === "error" && out.notes.push("console: " + m.text().slice(0, 200)));
  page.on("pageerror", e => out.notes.push("pageerror: " + e.message.slice(0, 200)));
  await page.goto(base);
  await page.waitForFunction(() => window.spike);
  const t0 = Date.now();
  const started = await page.evaluate(() => spike.start());
  await page.evaluate(s => spike.seed(s, "/project"), seed);
  const first = await page.evaluate(() => spike.exec("echo ready"));
  return { page, started, coldToFirstMs: Date.now() - t0, first };
}
const short = s => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "").trim().replace(/\s+/g, " ").slice(0, 90);

const shell = await openShell();
out.boot.cold = { ...shell.started, toFirstResultMs: shell.coldToFirstMs, firstExecMs: shell.first.ms };
out.coi = await shell.page.evaluate(() => spike.coi);

for (const item of ITEMS) {
  const [group, name, ...steps] = item;
  if (!want(group)) continue;
  let pass = true, last, ms = 0;
  for (let i = 0; i < steps.length; i += 2) {
    const t = Date.now();
    last = await shell.page.evaluate(c => spike.exec(c), steps[i]);
    last.wall = Date.now() - t;
    ms += last.ms;
    if (typeof steps[i + 1] === "function" && !steps[i + 1](last)) pass = false;
    if (typeof steps[i + 1] !== "function") i--;
  }
  const note = /--test/.test(steps[0]) || steps[0] === "npm test" ? `counts ${counts(last)}` + (last.exitCode ? "; " + short(last.stdout.split("\n").find(l => l.startsWith("FAIL"))) : "") : short(last.stdout) || short(last.stderr);
  out.rows.push({ group, item: name, pass, exit: last.exitCode, ms: Math.round(ms), note: pass ? note : (note + " | stderr: " + short(last.stderr)).slice(0, 160), stderr: last.stderr.slice(0, 2000), stdout: last.stdout.slice(0, 2000) });
  console.error(`${pass ? "PASS" : "FAIL"} ${name} (${Math.round(ms)} ms)`);
}

// warm latency
if (want("shell")) {
  const lat = [];
  for (let i = 0; i < 20; i++) lat.push((await shell.page.evaluate(() => spike.exec("echo hi | wc -c"))).ms);
  const nodeLat = [];
  out.boot.nodeCalls = [];
  for (let i = 0; i < 8; i++) {
    nodeLat.push((await shell.page.evaluate(() => spike.exec('cd /project && node -e "1"'))).ms);
    out.boot.nodeCalls.push((await shell.page.evaluate(() => spike.info())).lastNode);
    if (i === 3) await new Promise(r => setTimeout(r, 1500)); // let the spare finish warming
  }
  const med = a => [...a].sort((x, y) => x - y)[a.length >> 1];
  out.boot.warm = { shellMedianMs: med(lat), nodeEMedianMs: med(nodeLat) };
}
const info = await shell.page.evaluate(() => spike.info());
out.boot.lastNode = info.lastNode;
const png = want("pydata") ? await shell.page.evaluate(() => spike.readBytes("/py/fig.png").then(b => Array.from(b.slice(0, 8)), e => String(e))) : null;
if (png) out.notes.push("fig.png first bytes: " + JSON.stringify(png) + (png[0] === 137 && png[1] === 80 ? " (PNG signature: readable from the shell FS)" : ""));
if (info.lastPython) out.sizes.pythonFirstRun = { transfer: info.lastPython.resources.reduce((a, r) => a + r.transfer, 0), files: info.lastPython.resources.length };

// infinite loops
if (want(GROUP_OF_LOOPS)) {
  const p = shell.page;
  const loop = "while true; do :; done";
  let r = await p.evaluate(c => spike.exec(c, { limits: { maxExecutionTimeMs: 1500, maxCommandCount: 1e12 } }), loop);
  out.rows.push({ group: "loops", item: "while true (maxExecutionTimeMs 1500)", pass: r.exitCode !== 0 && r.ms < 5000, exit: r.exitCode, ms: Math.round(r.ms), note: short(r.stderr) });
  r = await p.evaluate(c => spike.exec(c), loop);
  out.rows.push({ group: "loops", item: "while true (default limits)", pass: r.exitCode !== 0, exit: r.exitCode, ms: Math.round(r.ms), note: short(r.stderr) });
  r = await p.evaluate(() => spike.exec("cd /py && PY_TIMEOUT_MS=3000 python3 -c 'while True: pass'"));
  out.rows.push({ group: "loops", item: "python while True (Pyodide Worker.terminate)", pass: r.exitCode === 124, exit: r.exitCode, ms: Math.round(r.ms), note: short(r.stderr) });
  r = await p.evaluate(() => spike.exec("python3 -c 'print(\"back\")'"));
  out.rows.push({ group: "loops", item: "python after terminate (reboot, cached)", pass: r.stdout === "back\n", exit: r.exitCode, ms: Math.round(r.ms), note: short(r.stdout) });
  r = await p.evaluate(c => spike.exec(c, { limits: { maxExecutionTimeMs: 1e12, maxCommandCount: 1e12 }, hardTimeout: 2000 }), loop);
  const t = Date.now();
  await p.evaluate(s => spike.start().then(() => spike.seed(s, "/project")).then(() => spike.exec("echo back")), seed);
  out.rows.push({ group: "loops", item: "while true, no limits: page Worker.terminate + restart", pass: !!r.killed, exit: "-", ms: 2000, note: `terminate ${r.terminateMs} ms; restart+reseed+first exec ${Date.now() - t} ms` });
}

// cold boot repeated in a new page (HTTP cache now warm) and python package cache
if (want("shell")) {
  const again = await openShell();
  out.boot.cachedSecondPage = { ...again.started, toFirstResultMs: again.coldToFirstMs };
  if (want("pydata")) {
    const r = await again.page.evaluate(() => spike.exec("cd /py && pip install pandas matplotlib duckdb"));
    const i2 = await again.page.evaluate(() => spike.info());
    out.sizes.pythonSecondPage = { ms: r.ms, transfer: i2.lastPython.resources.reduce((a, x) => a + x.transfer, 0), files: i2.lastPython.resources.length, cachedFiles: i2.lastPython.resources.filter(x => x.transfer === 0).length, refetched: i2.lastPython.resources.filter(x => x.transfer > 0).map(x => `${x.name.split("/").pop()} ${x.transfer}`) };
  }
  await again.page.close();
}

// sizes
const modules = info.resources.filter(u => u.startsWith("https://esm.sh/"));
out.sizes.shell = await sizeOf(info.bootResources.filter(u => u.startsWith("https://esm.sh/"))); // loaded before the first command
out.sizes.shellAllModules = await sizeOf(modules);
out.sizes.nodeLayer = await sizeOf(info.nodeResources.filter(u => u.startsWith("https://esm.sh/")));
out.moduleUrls = { shell: modules, node: info.nodeResources };

// almostnode, in its own context so its downloads are counted alone
if (want("almostnode")) {
  const ctx2 = await browser.newContext();
  const page = await ctx2.newPage();
  await page.goto(base);
  await page.waitForFunction(() => window.spike);
  const t0 = Date.now();
  const an = await page.evaluate(s => spike.almostnode(s), seed);
  an.wallMs = Date.now() - t0;
  if (an.resources) an.size = await sizeOf(an.resources);
  an.resourceNames = an.resources;
  delete an.resources;
  out.almostnode = an;
  await ctx2.close();
}

await browser.close();
server.close();

// --- report -----------------------------------------------------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
console.log(`\ncrossOriginIsolated=${out.coi.crossOriginIsolated} SharedArrayBuffer=${out.coi.sab} gpuFlags=${!!args.gpu}`);
console.log(`${pad("group", 7)} ${pad("item", 52)} ${pad("pass", 4)} ${pad("exit", 4)} ${pad("ms", 7)} note`);
for (const r of out.rows) console.log(`${pad(r.group, 7)} ${pad(r.item, 52)} ${pad(r.pass ? "yes" : "NO", 4)} ${pad(r.exit, 4)} ${pad(r.ms, 7)} ${r.note}`);
console.log(`\npassed ${out.rows.filter(r => r.pass).length}/${out.rows.length}`);
console.log("boot", JSON.stringify(out.boot));
console.log("sizes", JSON.stringify(out.sizes));
if (out.almostnode) {
  const a = out.almostnode;
  console.log(`\nalmostnode: import ${a.importMs} ms, boot ${a.bootMs} ms, first result ${a.firstMs} ms, ${JSON.stringify(a.size)} ${a.error ?? ""}`);
  for (const r of a.rows ?? []) console.log(`  ${pad(r.item, 46)} exit ${pad(r.exitCode, 4)} ${pad(r.ms, 6)} ${short(r.stdout) || short(r.stderr)}`);
}
for (const n of out.notes.slice(0, 20)) console.log("note:", n);
if (args.json) writeFileSync(args.json, JSON.stringify(out, null, 2));
