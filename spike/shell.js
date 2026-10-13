// E11 spike, page side: starts the shell Worker, forwards exec calls, and enforces a hard timeout by terminating
// the Worker (the harness's Stop). Also hosts the almostnode comparison, which runs on the main thread.
let worker = null, seq = 0;
const pending = new Map();

function start() {
  const t0 = performance.now();
  worker = new Worker(new URL("./shell-worker.js", import.meta.url), { type: "module" });
  return new Promise((resolve, reject) => {
    worker.onerror = e => reject(new Error("shell worker failed to load: " + (e.message || "error")));
    worker.onmessage = ({ data }) => {
      if (data.ready) { worker.onmessage = onMessage; resolve({ workerReadyMs: Math.round(performance.now() - t0), importMs: data.importMs }); }
    };
  });
}
function onMessage({ data }) {
  const p = pending.get(data.id);
  if (!p) return;
  pending.delete(data.id); clearTimeout(p.timer);
  data.error ? p.reject(new Error(data.error)) : p.resolve(data.value);
}
function call(op, arg = {}, hardTimeout = 0) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = hardTimeout && setTimeout(() => {
      pending.delete(id);
      const t0 = performance.now();
      worker.terminate();
      resolve({ killed: true, terminateMs: Math.round(performance.now() - t0) });
    }, hardTimeout);
    pending.set(id, { resolve, reject, timer });
    worker.postMessage({ id, op, ...arg });
  });
}

async function almostnode(seed) {
  const rows = [];
  const t0 = performance.now();
  let mod;
  try { mod = await import("https://esm.sh/almostnode@0.2.14"); }
  catch (e) { return { error: "import failed: " + e.message }; }
  const tImport = performance.now();
  const container = mod.createContainer({ cwd: "/project" });
  for (const [p, content] of Object.entries(seed)) {
    container.vfs.mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true });
    container.vfs.writeFileSync(p, content);
  }
  const tBoot = performance.now();
  const run = async (item, command, cwd = "/project", timeout = 30000) => {
    const t = performance.now();
    let r;
    try {
      r = await Promise.race([container.run(command, { cwd }), new Promise(res => setTimeout(() => res({ stdout: "", stderr: "timeout", exitCode: 124 }), timeout))]);
    } catch (e) { r = { stdout: "", stderr: "threw: " + (e?.message ?? e), exitCode: -1 }; }
    rows.push({ item, command, ...r, ms: Math.round(performance.now() - t) });
    return r;
  };
  await run("first command", "echo ready");
  const firstMs = Math.round(performance.now() - t0);
  await run("node -e", `node -e "console.log(1+1)"`);
  await run("node file.js (CJS)", "node /project/hello.cjs");
  await run("node file.js (ESM)", "node /project/hello.mjs");
  await run("node --test ms", "node --test test/index.test.js", "/ms");
  await run("node test file (ms, no --test)", "node test/index.test.js", "/ms");
  await run("node test file (dequal)", "node test/index.test.js", "/project");
  await run("npm install ms@2.1.3", "npm install ms@2.1.3", "/work");
  await run("require('ms')", "node /work/use-ms.cjs", "/work");
  await run("npm install chalk@4", "npm install chalk@4", "/work");
  await run("require('chalk')", "node /work/use-chalk.cjs", "/work");
  await run("npm install escape-string-regexp@5 (ESM-only)", "npm install escape-string-regexp@5", "/work");
  await run("import ESM-only package", "node /work/use-esr.mjs", "/work");
  await run("git", "git init", "/project");
  return { importMs: Math.round(tImport - t0), bootMs: Math.round(tBoot - t0), firstMs, rows, resources: performance.getEntriesByType("resource").map(e => e.name).filter(n => !n.includes("/spike/")) };
}

window.spike = {
  start, call,
  seed: (files, cwd) => call("seed", { files, cwd }),
  exec: (command, { limits, hardTimeout } = {}) => call("exec", { command, limits }, hardTimeout),
  info: () => call("info"),
  readBytes: path => call("readBytes", { path }),
  almostnode,
  coi: { crossOriginIsolated: self.crossOriginIsolated, sab: typeof SharedArrayBuffer },
};
document.getElementById("log").textContent = "ready";
