// The tab's half of the bash tool. A SharedWorker can't start Workers (Chromium has no Worker there), so the engine
// asks a tab, as it does for run and code: host.shell({ op, key, ... }). The tab keeps one shell Worker per key (a
// chat's run on a project or branch), terminates it on a timeout or Stop, and keeps one Pyodide Worker per project
// that outlives runs. It also answers the shell's fetches, through the app's proxyFetch, so curl, wget, git and node's
// fetch meet the same proxy and CORS rules as read_url.
import { openStore } from "./store.js";

const SHELL_WORKER = new URL("./worker.js", import.meta.url);
const PYTHON_WORKER = new URL("./python.js", import.meta.url);
const PYTHON_IDLE_MS = 15 * 60_000;
const GRACE_MS = 2_000; // past a command's own limit, before the Worker is terminated

export function createShellHost({ fetch: fetchVia = fetch, dbName = "chat-shell" } = {}) {
  const shells = new Map(); // key -> shell
  const pythons = new Map(); // projectId -> python
  let store = null;
  const storeOf = async () => (store ??= openStore(dbName).catch(() => null));

  function start(key, projectId) {
    const worker = new Worker(SHELL_WORKER, { type: "module" });
    const sh = { id: crypto.randomUUID().slice(0, 8), key, projectId, worker, calls: new Map(), seq: 0, dead: false, python: null };
    sh.ready = new Promise((resolve, reject) => {
      worker.onerror = e => { e.preventDefault?.(); const error = new Error(`The shell failed to start: ${e.message || "its script didn't load"}`); reject(error); kill(sh, error); };
      worker.onmessage = ({ data }) => {
        if (data.ready) return resolve();
        if (data.progress) return sh.progress?.(data.progress);
        if ("bridge" in data) return answer(sh, data);
        const call = sh.calls.get(data.id);
        sh.calls.delete(data.id);
        "error" in data ? call?.reject(new Error(data.error)) : call?.resolve(data.value);
      };
    });
    shells.set(key, sh);
    return sh;
  }
  const request = (sh, op, args) => new Promise((resolve, reject) => {
    const id = ++sh.seq;
    sh.calls.set(id, { resolve, reject });
    sh.worker.postMessage({ id, op, ...args });
  });
  function kill(sh, reason = new Error("The shell stopped.")) {
    if (sh.dead) return;
    sh.dead = true;
    sh.worker.terminate();
    for (const call of sh.calls.values()) call.reject(reason);
    sh.calls.clear();
    if (shells.get(sh.key) === sh) shells.delete(sh.key);
    // A Python job the shell was waiting on is stopped with it.
    if (sh.python) killPython(sh.python.p);
  }

  // The shell's calls to the tab: fetch and python.
  async function answer(sh, { bridge, type, ...data }) {
    const reply = (value, transfer = []) => !sh.dead && sh.worker.postMessage({ bridge, value }, transfer);
    try {
      // The command waiting on Python was stopped another way (its own deadline): Python stops with it.
      if (type === "python-stop") return void (sh.python && killPython(sh.python.p));
      if (type === "fetch") {
        const { url, method = "GET", headers = {}, body } = data.request;
        const res = await fetchVia(url, { method, headers, ...(body != null && !["GET", "HEAD"].includes(method) && { body }) });
        const bytes = new Uint8Array(await res.arrayBuffer());
        return reply({ status: res.status, statusText: res.statusText, url: res.url, headers: [...res.headers], body: bytes }, [bytes.buffer]);
      }
      if (type === "python") return reply(await runPython(sh, data.job, data.timeoutMs));
      throw new Error(`Unknown shell call: ${type}`);
    } catch (e) {
      if (!sh.dead) sh.worker.postMessage({ bridge, error: String(e?.message ?? e) });
    }
  }

  function pythonFor(projectId) {
    let p = pythons.get(projectId);
    if (p) return p;
    p = { worker: new Worker(PYTHON_WORKER, { type: "module" }), calls: new Map(), seq: 0, booted: false, timer: null, projectId };
    p.worker.onmessage = ({ data }) => {
      if (data.progress) return p.progress?.(data.progress);
      p.calls.get(data.id)?.(data);
      p.calls.delete(data.id);
    };
    p.worker.onerror = e => { e.preventDefault?.(); for (const done of p.calls.values()) done({ code: 1, stdout: "", stderr: `python3: ${e.message || "Pyodide failed to load"}\n`, changed: [] }); killPython(p); };
    pythons.set(projectId, p);
    return p;
  }
  function killPython(p, why = null) {
    clearTimeout(p.timer);
    p.worker.terminate();
    for (const done of p.calls.values()) done(why ?? { code: 130, stdout: "", stderr: "python3: stopped\n", changed: [] });
    p.calls.clear();
    if (pythons.get(p.projectId) === p) pythons.delete(p.projectId);
  }
  async function runPython(sh, job, timeoutMs) {
    const p = pythonFor(sh.projectId);
    clearTimeout(p.timer);
    // pip's installs live in Pyodide's own files: a new Pyodide installs them again, from the cache.
    const reinstall = p.booted ? [] : ((await (await storeOf())?.getMeta(sh.projectId, "pip").catch(() => null)) ?? []);
    p.booted = true;
    const r = await new Promise(resolve => {
      const id = ++p.seq;
      const timer = setTimeout(() => {
        const secs = Math.round(timeoutMs / 100) / 10;
        killPython(p, { code: 124, stdout: "", stderr: `python3: killed after ${secs} s (timeout); Python starts again on the next command\n`, changed: [] });
      }, timeoutMs);
      p.calls.set(id, value => { clearTimeout(timer); p.progress = null; resolve(value); });
      // What it prints as it runs goes to the command's card, as node's does.
      p.progress = sh.progress;
      sh.python = { p, id };
      p.worker.postMessage({ id, job, reinstall });
    });
    sh.python = null;
    if (pythons.get(sh.projectId) === p) p.timer = setTimeout(() => killPython(p), PYTHON_IDLE_MS);
    if (r.installed?.length) (await storeOf())?.setMeta(sh.projectId, "pip", [...new Set(r.installed)]).catch(() => {});
    return r;
  }

  // exec: { key, projectId, shellId, command, cwd, env, timeoutMs, delta, seed }. A shell the engine doesn't know
  // (none, or another than it last saw) needs the project's files: without seed, the answer is { unseeded: true }.
  // progress({ stdout?, stderr? }): what the command prints as it runs, every 100 ms at most; the answer replaces it.
  async function call(args, { signal, progress = null } = {}) {
    if (args.op === "restart") {
      const sh = shells.get(args.key);
      if (sh) kill(sh, new Error("The shell restarted."));
      return { restarted: true };
    }
    if (args.op !== "exec") throw new Error(`Unknown shell op: ${args.op}`);
    signal?.throwIfAborted();
    let sh = shells.get(args.key);
    if (sh && sh.id !== args.shellId) {
      if (!args.seed) return { unseeded: true };
      kill(sh);
      sh = null;
    }
    const t0 = performance.now();
    if (!sh) {
      if (!args.seed) return { unseeded: true };
      sh = start(args.key, args.projectId);
      await sh.ready;
      await request(sh, "seed", { files: args.seed, projectId: args.projectId, dbName });
    }
    const timeoutMs = args.timeoutMs ?? 60_000;
    sh.progress = progress;
    const work = request(sh, "exec", { command: args.command, cwd: args.cwd, env: args.env, delta: args.delta, timeoutMs }).then(value => ({ value }), error => ({ error }));
    let timer, onAbort;
    const stopped = new Promise(resolve => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs + GRACE_MS);
      onAbort = () => resolve("abort");
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    const outcome = await Promise.race([work, stopped]);
    sh.progress = null;
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    const ms = Math.round(performance.now() - t0);
    if (outcome === "timeout" || outcome === "abort") {
      kill(sh, new Error(outcome));
      const secs = Math.round(timeoutMs / 100) / 10;
      return {
        killed: true, shellId: null, stdout: "", exitCode: outcome === "timeout" ? 124 : 130, ms,
        stderr: outcome === "timeout"
          ? `bash: killed after ${secs} s (timeout). The shell starts again on the next command, with cwd and env kept; what this command wrote since it began is lost.\n`
          : "bash: stopped\n",
      };
    }
    if (outcome.error) { kill(sh, outcome.error); throw outcome.error; }
    return { ...outcome.value, shellId: sh.id };
  }

  return {
    call,
    // A project's shells end with the runs on it; its Python stays, for the next run.
    release(projectId) { for (const sh of [...shells.values()]) if (sh.projectId === projectId) kill(sh, new Error("The run ended.")); },
    dispose() {
      for (const sh of [...shells.values()]) kill(sh);
      for (const p of [...pythons.values()]) killPython(p);
    },
    // For tests: what runs.
    state: () => ({ shells: [...shells.values()].map(s => ({ key: s.key, id: s.id, projectId: s.projectId })), pythons: [...pythons.keys()] }),
  };
}
