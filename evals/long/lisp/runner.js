// Runs hidden Lisp programs against a lisp.js, each in its own worker so a hang, a crash or leftover global state in
// one program can't touch the next. Started as a child process by evals/long.js:
//   node runner.js <path to lisp.js> <programs.json> <out.json>
// programs.json is [{ id, source }]; out.json gets [{ id, output } | { id, threw } | { id, timedOut }].
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

const [file, programsPath, outPath] = process.argv.slice(2);
const PER_PROGRAM = Number(process.env.LISP_TIMEOUT_MS) || 5000;
const programs = JSON.parse(readFileSync(programsPath, "utf8"));
const url = pathToFileURL(file).href;

// The worker imports the module and calls run once; what it returns is the program's output.
const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
  try {
    const mod = await import(workerData.url);
    const run = mod.run ?? mod.default?.run ?? (typeof mod.default === "function" ? mod.default : null);
    if (typeof run !== "function") return parentPort.postMessage({ threw: "lisp.js exports no run function" });
    const output = await run(workerData.source);
    parentPort.postMessage(typeof output === "string" ? { output } : { threw: "run returned " + (output === null ? "null" : typeof output) + ", not a string" });
  } catch (e) {
    parentPort.postMessage({ threw: String(e?.stack ?? e).split("\\n").slice(0, 2).join(" | ") });
  }
})();
`;

function one({ id, source }) {
  return new Promise(resolve => {
    const worker = new Worker(WORKER, { eval: true, workerData: { url, source }, resourceLimits: { maxOldGenerationSizeMb: 256 }, stdout: true, stderr: true });
    // What the module logs is dropped: only run's return value counts.
    worker.stdout.resume();
    worker.stderr.resume();
    let done = false;
    const finish = result => { if (done) return; done = true; clearTimeout(timer); worker.terminate().catch(() => {}); resolve({ id, ...result }); };
    const timer = setTimeout(() => finish({ timedOut: true }), PER_PROGRAM);
    worker.on("message", finish);
    worker.on("error", e => finish({ threw: String(e?.message ?? e) }));
    worker.on("exit", code => finish({ threw: `worker exited (${code})` }));
  });
}

const queue = programs.map((p, i) => [i, p]);
const results = new Array(programs.length);
const lanes = Math.max(2, Math.min(8, os.availableParallelism() - 1));
await Promise.all(Array.from({ length: lanes }, async () => {
  for (let next; (next = queue.shift()); ) results[next[0]] = await one(next[1]);
}));
writeFileSync(outPath, JSON.stringify(results));
process.exit(0);
