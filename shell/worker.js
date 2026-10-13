// The shell: just-bash in a dedicated Worker, one per run, over an in-memory copy of the project at /project. The tab
// (shell/host.js) starts it, sends the project's text files, and terminates it on a timeout or Stop. The harness keeps
// cwd and env (just-bash starts each exec afresh). After each command it answers the files the command changed: text
// files go back to the engine, which commits them as versions; node_modules, .git, caches and binary files go to the
// shell's own store (store.js). node runs in a nested Worker per program, Python in the tab's Pyodide Worker, and
// curl, wget and git's network go through the tab's fetch, which keeps the app's proxy rules.
import { archiveCommands } from "./archive.js";
import { gitCommand } from "./git.js";
import { npmCommands } from "./npm.js";
import { openStore } from "./store.js";

const JUST_BASH = "https://esm.sh/just-bash@3.6.0/browser";
const { Bash, InMemoryFs, defineCommand } = await import(JUST_BASH);

export const ROOT = "/project", HOME = "/home/user";
const NPM_CACHE = HOME + "/.npm";
const td = new TextDecoder(), te = new TextEncoder();
const strict = new TextDecoder("utf-8", { fatal: true });
// Folders kept in the shell's store rather than the project's versions, wherever they are in the tree.
const BULKY = new Set(["node_modules", ".git", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".venv", "venv", ".tox", ".cache", ".next", ".turbo", ".parcel-cache"]);
const TEXT_MAX = 5e6; // a larger file stays in the shell's store
const OUT_LIMIT = 12_000, OUT_HEAD = 4_000, OUT_TAIL = 6_000;
const SYSTEM = /^\/(bin|usr|proc|dev|sys|etc)(\/|$)/;
export const DEFAULT_ENV = { HOME, USER: "user", PATH: `${ROOT}/node_modules/.bin:/usr/local/bin:/usr/bin:/bin`, LANG: "C.UTF-8", TERM: "dumb", SHELL: "/bin/bash", PWD: ROOT };

const normalize = p => {
  const out = [];
  for (const s of String(p).split("/")) { if (!s || s === ".") continue; if (s === "..") out.pop(); else out.push(s); }
  return "/" + out.join("/");
};
const dirname = p => normalize(p + "/..");
const relOf = p => (p.startsWith(ROOT + "/") ? p.slice(ROOT.length + 1) : null);
const bulky = rel => rel.split("/").some(s => BULKY.has(s));
const isText = bytes => { if (bytes.includes(0)) return false; try { strict.decode(bytes); return true; } catch { return false; } };
export const result = (stdout, stderr = "", exitCode = 0) => ({ stdout, stderr, exitCode });
// A command's stdin arrives latin1-shaped: one char per byte.
export const bytesOf = s => {
  if (s == null) return new Uint8Array();
  if (s instanceof Uint8Array) return s;
  const text = String(s), b = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) b[i] = text.charCodeAt(i) & 255;
  return b;
};
export const latin1 = bytes => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return s; };
export const stdinText = ctx => td.decode(bytesOf(ctx.stdin));
export const envOf = ctx => ctx.exportedEnv ?? Object.fromEntries(ctx.env);

// The FS records each path a command touches: dirty for the sync after the command, gen for the node workers, which
// get only what changed since their snapshot. quiet: writes from the engine (seed, deltas) aren't the command's.
class TrackedFs extends InMemoryFs {
  dirty = new Set(); changes = new Map(); gen = 0; quiet = 0;
  mark(p) { p = normalize(p); this.changes.set(p, ++this.gen); if (!this.quiet) this.dirty.add(p); }
  markTree(p) { p = normalize(p); this.mark(p); for (const q of this.getAllPaths()) if (q.startsWith(p + "/")) this.mark(q); }
  async writeFile(p, c, o) { await super.writeFile(p, c, o); this.mark(p); }
  async appendFile(p, c, o) { await super.appendFile(p, c, o); this.mark(p); }
  async mkdir(p, o) { await super.mkdir(p, o); this.mark(p); }
  async rm(p, o) { if (await super.exists(p)) this.markTree(p); await super.rm(p, o); }
  async mv(a, b) { this.markTree(a); await super.mv(a, b); this.markTree(b); }
  async cp(a, b, o) { await super.cp(a, b, o); this.markTree(b); }
  async symlink(t, p) { await super.symlink(t, p); this.mark(p); }
  async link(a, b) { await super.link(a, b); this.mark(b); }
  async chmod(p, m) { await super.chmod(p, m); this.mark(p); }
}
export const fs = new TrackedFs();

let store = null, project = 0, deadline = Infinity, outputs = 0;
let images = [], opens = [];
const remaining = () => Math.max(0, deadline - Date.now());

// --- calls to the tab: fetch (through the app's proxy rules) and python ------------------------------------------------
let bridges = 0;
const waiting = new Map();
export function bridge(type, payload = {}) {
  const id = ++bridges;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    postMessage({ bridge: id, type, ...payload });
  });
}

// --- the FS as entries, for the node and python workers --------------------------------------------------------------
// ["f", path, bytes] | ["d", path] | ["x", path] (gone)
async function entryOf(p) {
  let st;
  try { st = await fs.lstat(p); } catch { return ["x", p]; }
  if (st.isDirectory) return ["d", p];
  if (st.isSymbolicLink) { try { return ["f", p, await fs.readFileBuffer(p)]; } catch { return ["x", p]; } }
  return ["f", p, await fs.readFileBuffer(p)];
}
export async function snapshot(filter = () => true) {
  const out = [];
  for (const p of fs.getAllPaths()) if (p !== "/" && !SYSTEM.test(p) && filter(p)) out.push(await entryOf(p));
  return out;
}
export async function deltaSince(gen, filter = () => true) {
  const out = [];
  for (const [p, g] of fs.changes) if (g > gen && !SYSTEM.test(p) && filter(p)) out.push(await entryOf(p));
  return out;
}
export async function applyEntries(entries = []) {
  for (const [kind, p, bytes] of entries) {
    if (kind === "x") { await fs.rm(p, { recursive: true, force: true }).catch(() => {}); continue; }
    if (kind === "d") { await fs.mkdir(p, { recursive: true }); continue; }
    await fs.mkdir(dirname(p), { recursive: true });
    await fs.writeFile(p, bytes);
  }
}

// --- node: a nested Worker per program; a spare is seeded ahead with the files and gets only what changed since ------
const NODE_WORKER = new URL("./node.js", import.meta.url);
let spare = null;
function newSpare() {
  const worker = new Worker(NODE_WORKER, { type: "module" });
  const s = { worker, gen: fs.gen };
  s.seeded = snapshot().then(entries => worker.postMessage({ type: "seed", entries }));
  return s;
}
export async function runNode(job, ctx) {
  const s = spare ?? newSpare();
  spare = null;
  await s.seeded;
  const delta = await deltaSince(s.gen);
  const limit = Number(ctx.env.get("NODE_TIMEOUT_MS")) || Infinity;
  // A little inside the command's own deadline, so node says why it stopped.
  const timeout = Math.max(50, Math.min(remaining() - 300, limit));
  return new Promise(resolve => {
    let stdout = "", stderr = "", done = false;
    const end = async (code, changed = []) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      s.worker.terminate();
      await applyEntries(changed);
      spare = newSpare();
      resolve(result(stdout, stderr, code));
    };
    const timer = setTimeout(() => { stderr += `node: killed after ${Math.round(timeout / 100) / 10} s (timeout)\n`; end(124); }, timeout);
    ctx.signal?.addEventListener("abort", () => { stderr += "node: stopped\n"; end(130); }, { once: true });
    s.worker.onmessage = async ({ data }) => {
      if (data.type === "out") data.fd === 1 ? (stdout += data.text) : (stderr += data.text);
      else if (data.type === "exit") end(data.code, data.changed);
      else if (data.type === "fetch") {
        const value = await bridge("fetch", { request: data.request }).catch(e => ({ error: String(e?.message ?? e) }));
        s.worker.postMessage({ type: "fetched", id: data.id, ...value });
      } else if (data.type === "exec") {
        // child_process: a command of this shell, over the program's files as it left them.
        await applyEntries(data.changed);
        const before = fs.gen;
        const r = await makeBash(remaining()).exec(data.command, { cwd: data.cwd, env: data.env, replaceEnv: true, ...(data.stdin != null && { stdin: data.stdin }) })
          .catch(e => result("", String(e?.message ?? e) + "\n", 1));
        s.worker.postMessage({ type: "execd", id: data.id, stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, changed: await deltaSince(before) });
      }
    };
    s.worker.onerror = e => { e.preventDefault?.(); stderr += `node: ${e.message || "the worker failed to load"}\n`; end(1); };
    s.worker.postMessage({ type: "run", delta, job, cwd: ctx.cwd, env: envOf(ctx), stdin: bytesOf(ctx.stdin) });
  });
}

const node = defineCommand("node", async (args, ctx) => {
  const flags = [];
  while (args[0]?.startsWith("-") && !["-e", "--eval", "-p", "--print", "--test", "-v", "--version", "-h", "--help", "-"].includes(args[0])) flags.push(args.shift());
  const [first, ...rest] = args;
  if (first === "-v" || first === "--version") return result("v22.18.0\n");
  if (first === "-h" || first === "--help") return result("node [options] [script.js | -e \"script\" | --test [files]] [arguments]\n");
  if (first === "-e" || first === "--eval" || first === "-p" || first === "--print") {
    const print = first === "-p" || first === "--print";
    return runNode({ mode: "eval", code: rest[0] ?? "", print, argv: ["/usr/local/bin/node", ...rest.slice(1)] }, ctx);
  }
  if (first === "--test") return runNode({ mode: "test", files: rest.filter(a => !a.startsWith("-")), only: rest.includes("--test-only") }, ctx);
  if (!first || first === "-") {
    const code = stdinText(ctx);
    if (!code.trim()) return result("", "node: there is no REPL in this shell: use node -e \"code\" or node file.js\n", 9);
    return runNode({ mode: "eval", code, argv: ["/usr/local/bin/node", ...rest] }, ctx);
  }
  const file = ctx.fs.resolvePath(ctx.cwd, first);
  return runNode({ mode: "file", file, argv: ["/usr/local/bin/node", file, ...rest] }, ctx);
});

// A package's bin: node_modules/.bin/<name> is a shim naming the file node runs.
export async function binTarget(name, cwd) {
  for (let d = cwd; ; d = dirname(d)) {
    const shim = `${d === "/" ? "" : d}/node_modules/.bin/${name}`;
    if (await fs.exists(shim)) {
      const m = /exec node "\$\(dirname "\$0"\)\/([^"]+)"/.exec(await fs.readFile(shim));
      if (m) return normalize(dirname(shim) + "/" + m[1]);
    }
    if (d === "/") return null;
  }
}
const binCommand = name => defineCommand(name, async (args, ctx) => {
  const target = await binTarget(name, ctx.cwd);
  if (!target) return result("", `${name}: command not found\n`, 127);
  return runNode({ mode: "file", file: target, argv: ["/usr/local/bin/node", target, ...args] }, ctx);
});

// --- python3, pip, pytest: Pyodide in the tab's own Worker, kept between runs ----------------------------------------
// It gets the project's files (not node_modules or .git) and /tmp; what it writes comes back.
const pyFiles = p => (p.startsWith(ROOT + "/") ? !bulky(relOf(p)) : p.startsWith("/tmp/") && !p.startsWith("/tmp/bash-out"));
// Inside the command's deadline, so Python says why it stopped; a command stopped another way stops Python too.
const pyTimeout = ctx => Math.max(100, Math.min(remaining() - 300, Number(ctx.env.get("PY_TIMEOUT_MS")) || Infinity));
async function runPython(job, ctx) {
  const files = (await snapshot(pyFiles)).filter(e => e[0] === "f").map(([, p, b]) => [p, b]);
  let running = true;
  ctx.signal?.addEventListener("abort", () => running && postMessage({ bridge: 0, type: "python-stop" }), { once: true });
  const r = await bridge("python", { job: { ...job, cwd: ctx.cwd, env: envOf(ctx), stdin: stdinText(ctx), files, roots: [ROOT, "/tmp"] }, timeoutMs: pyTimeout(ctx) })
    .catch(e => ({ stdout: "", stderr: `python3: ${e?.message ?? e}\n`, code: 1 }))
    .finally(() => (running = false));
  await applyEntries(r.changed);
  if (r.images?.length) images.push(...r.images);
  return result(r.stdout ?? "", r.stderr ?? "", r.code ?? 1);
}
const python = defineCommand("python3", async (args, ctx) => {
  const [first, ...rest] = args;
  if (first === "--version" || first === "-V") return result("Python 3.14.2 (Pyodide 314.0.7)\n");
  if (first === "-c") return runPython({ op: "run", mode: "c", arg: rest[0] ?? "", argv: ["-c", ...rest.slice(1)] }, ctx);
  if (first === "-m") {
    if (rest[0] === "pip") return pip.execute(rest.slice(1), ctx);
    return runPython({ op: "run", mode: "m", arg: rest[0], argv: [rest[0], ...rest.slice(1)] }, ctx);
  }
  if (!first || first === "-") {
    const code = stdinText(ctx);
    if (!code.trim()) return result("", "python3: there is no REPL in this shell: use python3 -c \"code\" or python3 file.py\n", 2);
    return runPython({ op: "run", mode: "c", arg: code, argv: ["-", ...rest] }, ctx);
  }
  const file = ctx.fs.resolvePath(ctx.cwd, first);
  if (!(await ctx.fs.exists(file))) return result("", `python3: can't open file '${first}': [Errno 2] No such file or directory\n`, 2);
  return runPython({ op: "run", mode: "file", arg: file, argv: [file, ...rest] }, ctx);
});
const pip = defineCommand("pip", async (args, ctx) => {
  const [cmd, ...rest] = args;
  if (cmd === "--version" || cmd === "-V") return result("pip (micropip, Pyodide)\n");
  if (!["install", "list", "freeze", "uninstall", "show"].includes(cmd)) return result("", "pip: this shell has pip install, uninstall, list, freeze and show (micropip)\n", 1);
  const specs = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "-r" || rest[i] === "--requirement") {
      const path = ctx.fs.resolvePath(ctx.cwd, rest[++i] ?? "");
      const text = await ctx.fs.readFile(path).catch(() => null);
      if (text == null) return result("", `pip: could not open requirements file ${rest[i]}\n`, 1);
      specs.push(...text.split("\n").map(l => l.replace(/#.*/, "").trim()).filter(Boolean));
    } else if (!rest[i].startsWith("-")) specs.push(rest[i]);
  }
  return runPython({ op: "pip", cmd, specs }, ctx);
});
const pytest = defineCommand("pytest", (args, ctx) => runPython({ op: "run", mode: "m", arg: "pytest", argv: ["pytest", ...args] }, ctx));
const alias = (name, target) => defineCommand(name, (a, c) => target.execute(a, c));

// --- curl and wget, through the tab's fetch: the same proxy and CORS rules as read_url -----------------------------------
async function fetchVia(request) {
  const r = await bridge("fetch", { request });
  if (r.error) throw new Error(r.error);
  return r;
}
const statusLine = r => `HTTP/1.1 ${r.status} ${r.statusText || ""}`.trim();
const headerText = r => [statusLine(r), ...r.headers.map(([k, v]) => `${k}: ${v}`)].join("\r\n") + "\r\n\r\n";
const textOrBytes = bytes => (isText(bytes) ? { stdout: td.decode(bytes) } : { stdout: latin1(bytes), stdoutKind: "bytes", stdoutEncoding: "binary" });
// -sSL is -s -S -L; -XPOST is -X POST. bools: letters that take no value; values: those that do.
const shortFlags = (args, bools, values) => args.flatMap(a => {
  if (!/^-[a-zA-Z#]{2,}$/.test(a)) return [a];
  const out = [];
  for (let i = 1; i < a.length; i++) {
    if (values.includes(a[i])) { out.push("-" + a[i]); if (i + 1 < a.length) out.push(a.slice(i + 1)); return out; }
    if (!bools.includes(a[i])) return [a];
    out.push("-" + a[i]);
  }
  return out;
});
const curl = defineCommand("curl", async (rawArgs, ctx) => {
  const args = shortFlags(rawArgs, "sSLkiIfvOg#", "XHdowAume");
  let url = null, method = null, data = null, out = null, remote = false, silent = false, showError = false, include = false, head = false, fail = false, writeOut = null;
  const headers = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-X" || a === "--request") method = args[++i];
    else if (a === "-H" || a === "--header") { const h = args[++i] ?? "", at = h.indexOf(":"); if (at > 0) headers[h.slice(0, at).trim()] = h.slice(at + 1).trim(); }
    else if (["-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--json"].includes(a)) {
      let d = args[++i] ?? "";
      if (d.startsWith("@") && a !== "--data-raw") d = d === "@-" ? stdinText(ctx) : await ctx.fs.readFile(ctx.fs.resolvePath(ctx.cwd, d.slice(1))).catch(() => "");
      data = data == null ? d : data + "&" + d;
      if (a === "--json") { headers["Content-Type"] ??= "application/json"; headers.Accept ??= "application/json"; }
      else headers["Content-Type"] ??= "application/x-www-form-urlencoded";
    } else if (a === "-o" || a === "--output") out = args[++i];
    else if (a === "-O" || a === "--remote-name") remote = true;
    else if (a === "-s" || a === "--silent") silent = true;
    else if (a === "-S" || a === "--show-error") showError = true;
    else if (a === "-i" || a === "--include") include = true;
    else if (a === "-I" || a === "--head") head = true;
    else if (a === "-f" || a === "--fail") fail = true;
    else if (a === "-w" || a === "--write-out") writeOut = args[++i];
    else if (a === "-A" || a === "--user-agent") headers["User-Agent"] = args[++i];
    else if (a === "-u" || a === "--user") headers.Authorization = "Basic " + btoa(args[++i] ?? "");
    else if (a === "-e" || a === "--referer") headers.Referer = args[++i];
    else if (["-L", "--location", "-k", "--insecure", "--compressed", "-v", "--verbose", "-#", "--progress-bar", "-g", "--globoff"].includes(a)) {}
    else if (["--max-time", "-m", "--connect-timeout", "--retry", "--max-redirs"].includes(a)) i++;
    else if (!a.startsWith("-") || a === "-") url ??= a;
  }
  if (!url) return result("", "curl: no URL specified\n", 2);
  if (!/^[a-z]+:\/\//i.test(url)) url = "http://" + url;
  method ??= head ? "HEAD" : data != null ? "POST" : "GET";
  let r;
  try { r = await fetchVia({ url, method, headers, body: data }); }
  catch (e) { return result("", silent && !showError ? "" : `curl: (7) ${e.message}\n`, 7); }
  if (fail && r.status >= 400) return result("", silent && !showError ? "" : `curl: (22) The requested URL returned error: ${r.status}\n`, 22);
  const body = new Uint8Array(r.body ?? []);
  const fmt = writeOut && writeOut.replace(/\\n/g, "\n").replace(/%\{(\w+)\}/g, (m, k) => ({ http_code: r.status, response_code: r.status, url_effective: r.url || url, content_type: r.headers.find(([h]) => h.toLowerCase() === "content-type")?.[1] ?? "", size_download: body.length })[k] ?? m);
  const prefix = include || head ? headerText(r) : "";
  if (out || remote) {
    const name = out ?? (decodeURIComponent(new URL(r.url || url).pathname.split("/").pop()) || "index.html");
    await ctx.fs.writeFile(ctx.fs.resolvePath(ctx.cwd, name), body);
    return result(prefix + (fmt ?? ""), "", 0);
  }
  if (head) return result(prefix + (fmt ?? ""), "", 0);
  const shown = textOrBytes(body);
  if (shown.stdoutKind === "bytes") return { ...shown, stdout: latin1(te.encode(prefix)) + shown.stdout + (fmt ? latin1(te.encode(fmt)) : ""), stderr: "", exitCode: 0 };
  return result(prefix + shown.stdout + (fmt ?? ""), "", 0);
});
const wget = defineCommand("wget", async (rawArgs, ctx) => {
  const args = shortFlags(rawArgs, "q", "OP");
  let url = null, out = null, quiet = false, dir = ctx.cwd;
  const headers = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-O" || a === "--output-document") out = args[++i];
    else if (a.startsWith("--output-document=")) out = a.slice(18);
    else if (a === "-q" || a === "--quiet") quiet = true;
    else if (a === "-P" || a === "--directory-prefix") dir = ctx.fs.resolvePath(ctx.cwd, args[++i]);
    else if (a === "--header") { const h = args[++i] ?? "", at = h.indexOf(":"); if (at > 0) headers[h.slice(0, at).trim()] = h.slice(at + 1).trim(); }
    else if (!a.startsWith("-")) url ??= a;
  }
  if (!url) return result("", "wget: missing URL\n", 1);
  if (!/^[a-z]+:\/\//i.test(url)) url = "http://" + url;
  let r;
  try { r = await fetchVia({ url, method: "GET", headers }); }
  catch (e) { return result("", `wget: ${e.message}\n`, 4); }
  if (r.status >= 400) return result("", `wget: ${url}: ERROR ${r.status} ${r.statusText ?? ""}\n`, 8);
  const body = new Uint8Array(r.body ?? []);
  if (out === "-") return { ...textOrBytes(body), stderr: "", exitCode: 0 };
  const name = out ?? (decodeURIComponent(new URL(r.url || url).pathname.split("/").pop()) || "index.html");
  const path = ctx.fs.resolvePath(dir, name);
  await ctx.fs.writeFile(path, body);
  return result("", quiet ? "" : `'${name}' saved [${body.length}]\n`, 0);
});

// --- open: run_app on a file, once the command's changes are in the workspace ----------------------------------------
const open = defineCommand("open", async (args, ctx) => {
  const names = args.filter(a => !a.startsWith("-"));
  if (!names.length) return result("", "open: usage: open FILE (runs it as run_app does, after this command)\n", 2);
  for (const name of names) {
    const p = ctx.fs.resolvePath(ctx.cwd, name), rel = relOf(p);
    if (!rel) return result("", `open: ${name} is outside the project (${ROOT})\n`, 1);
    if (!(await ctx.fs.exists(p))) return result("", `open: ${name}: No such file or directory\n`, 1);
    opens.push(rel);
  }
  return result(names.map(n => `open: ${n} runs once this command ends; its report comes with the result\n`).join(""));
});

// --- what there isn't --------------------------------------------------------------------------------------------------
const missing = (name, why) => defineCommand(name, async () => result("", `${name}: ${why}\n`, 127));
const NO_SYSTEM = "not available: this shell runs in the browser, with no root and no system packages. It has npm (JavaScript) and pip (Python, Pyodide) for packages.";
const absent = [
  ...["sudo", "su", "apt", "apt-get", "yum", "dnf", "brew", "apk", "pacman", "snap", "systemctl", "service"].map(n => missing(n, NO_SYSTEM)),
  ...["yarn", "pnpm", "bun", "deno"].map(n => missing(n, "not available here: use npm (install, test, run, ls) and npx.")),
  ...["gcc", "cc", "g++", "make", "cmake", "cargo", "rustc", "go", "java", "javac", "ruby", "php", "docker"].map(n => missing(n, "not available: no compilers, native toolchains or other runtimes here; node and python3 are what runs.")),
  missing("cmp", "not available in this shell: use diff, or compare checksums with sha256sum."),
  missing("ssh", "not available: there are no sockets here."),
];

// --- the shell ---------------------------------------------------------------------------------------------------------
const npm = npmCommands({ defineCommand, result, runNode, fs, ROOT, NPM_CACHE, binTarget, stdinText });
const git = gitCommand({ defineCommand, result, fetchVia, ROOT });
const core = [node, ...npm, git, python, alias("python", python), pip, alias("pip3", pip), pytest, curl, wget, open, alias("xdg-open", open),
  ...archiveCommands({ defineCommand, result }), ...absent];
const CORE_NAMES = new Set(core.map(c => c.name));

async function binNames(cwd) {
  const names = new Set();
  for (let d = cwd; ; d = dirname(d)) {
    const dir = `${d === "/" ? "" : d}/node_modules/.bin`;
    if (await fs.exists(dir)) for (const n of await fs.readdir(dir)) if (!CORE_NAMES.has(n)) names.add(n);
    if (d === "/") break;
  }
  return [...names];
}
let bins = [];
function makeBash(timeoutMs) {
  return new Bash({
    fs, cwd: ROOT, env: DEFAULT_ENV,
    customCommands: [...core, ...bins.map(binCommand)],
    // Time is the limit: the iteration caps of the "normal" profile (1e5) stop real scripts.
    executionLimits: { maxExecutionTimeMs: Math.max(1000, Math.round(timeoutMs)), maxCommandCount: 1e9, maxLoopIterations: 1e9, maxAwkIterations: 1e9, maxSedIterations: 1e9, maxJqIterations: 1e9, maxWorkUnits: 1e12, maxCallDepth: 1000, maxOutputSize: 64 * 1024 * 1024 },
  });
}

// Output past the limit keeps its head and tail; the whole of it goes to a file the model can read.
async function clip(name, text) {
  if (text.length <= OUT_LIMIT) return text;
  const file = `/tmp/bash-out/${++outputs}.${name}`;
  fs.quiet++;
  try { await fs.mkdir("/tmp/bash-out", { recursive: true }); await fs.writeFile(file, text); } finally { fs.quiet--; }
  return `${text.slice(0, OUT_HEAD)}\n[... ${text.length - OUT_HEAD - OUT_TAIL} of ${text.length} characters cut; all of ${name} is in ${file}: read it with grep, head, tail or sed -n ...]\n${text.slice(-OUT_TAIL)}`;
}

// What a command changed, sorted into the workspace's and the store's.
async function collect() {
  const changed = [], puts = [], dels = [], kept = { bulky: 0, binary: [] };
  for (const p of fs.dirty) {
    const rel = relOf(p), persisted = rel != null || p.startsWith(NPM_CACHE + "/");
    if (!persisted) continue;
    let st = null;
    try { st = await fs.lstat(p); } catch {}
    if (st?.isDirectory) continue;
    const inBulk = rel == null || bulky(rel);
    if (!st) { if (!inBulk) changed.push({ path: rel, deleted: true }); dels.push(p); continue; }
    const bytes = await fs.readFileBuffer(p).catch(() => null);
    if (!bytes) continue;
    if (!inBulk && bytes.length <= TEXT_MAX && isText(bytes)) { changed.push({ path: rel, text: td.decode(bytes) }); dels.push(p); continue; }
    puts.push([p, bytes]);
    if (inBulk) kept.bulky++;
    else { kept.binary.push(rel); changed.push({ path: rel, deleted: true }); }
  }
  fs.dirty.clear();
  await store?.apply(project, puts, dels);
  return { changed, kept };
}

async function seed({ files = {}, projectId = null, dbName }) {
  const t0 = performance.now();
  project = projectId ?? 0;
  store ??= dbName ? await openStore(dbName).catch(() => null) : null;
  const saved = (await store?.load(project).catch(() => [])) ?? [];
  fs.quiet++;
  try {
    for (const d of [ROOT, "/tmp", HOME]) await fs.mkdir(d, { recursive: true });
    for (const [path, bytes] of saved) { await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, bytes); }
    await applyDelta({ write: files });
  } finally { fs.quiet--; }
  setTimeout(() => (spare ??= newSpare()), 50);
  return { files: Object.keys(files).length, kept: saved.length, ms: Math.round(performance.now() - t0) };
}

// The engine's changes since the last command: other tools' edits, a restore, the user's typing.
async function applyDelta({ write = {}, remove = [] } = {}) {
  fs.quiet++;
  try {
    for (const rel of remove) await fs.rm(ROOT + "/" + rel, { force: true });
    for (const [rel, text] of Object.entries(write)) {
      const p = ROOT + "/" + rel;
      await fs.mkdir(dirname(p), { recursive: true });
      await fs.writeFile(p, text);
    }
  } finally { fs.quiet--; }
}

async function exec({ command, cwd = ROOT, env = null, delta = null, timeoutMs = 60_000 }) {
  await applyDelta(delta ?? {});
  images = []; opens = [];
  deadline = Date.now() + timeoutMs;
  env = { ...DEFAULT_ENV, ...(env ?? {}) };
  if (!(await fs.exists(cwd))) cwd = ROOT;
  bins = await binNames(cwd).catch(() => []);
  const t0 = performance.now();
  let r;
  try { r = await makeBash(timeoutMs).exec(command, { cwd, env: { ...env, PWD: cwd }, replaceEnv: true }); }
  catch (e) { r = result("", `bash: ${e?.message ?? e}\n`, 1); }
  const ms = Math.round(performance.now() - t0);
  const after = r.env ? { ...r.env } : { ...env, PWD: cwd };
  const { changed, kept } = await collect();
  const stdout = r.stdoutKind === "bytes" ? textOrBytes(bytesOf(r.stdout)).stdout : r.stdout;
  return {
    stdout: await clip("stdout", stdout ?? ""), stderr: await clip("stderr", r.stderr ?? ""), exitCode: r.exitCode, ms,
    cwd: after.PWD || cwd, env: after, changed, kept, opens, images: images.slice(0, 4),
  };
}

onmessage = async ({ data }) => {
  if (data.bridge) {
    const w = waiting.get(data.bridge);
    waiting.delete(data.bridge);
    return "error" in data ? w?.reject(new Error(data.error)) : w?.resolve(data.value);
  }
  try {
    const value = data.op === "seed" ? await seed(data) : data.op === "exec" ? await exec(data) : null;
    postMessage({ id: data.id, value });
  } catch (e) {
    postMessage({ id: data.id, error: String(e?.stack ?? e) });
  }
};
postMessage({ ready: true });
