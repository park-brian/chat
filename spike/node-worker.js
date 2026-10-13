// E11 spike: a Node-ish runtime in a nested Worker. The shell worker posts a snapshot of the files, argv, env and
// cwd; this worker runs the program with a CommonJS loader, an ESM loader (blob URLs with rewritten specifiers),
// Node built-ins from node-stdlib-browser's packages, and a synchronous fs over the snapshot. Output streams back
// as messages; the final message carries the exit code and the files written or removed.
import { init as lexerInit, parse as lexImports } from "https://esm.sh/es-module-lexer@1.7.0";

const RUNNER = new URL("../evals/swe/runner/", import.meta.url).href;
// The polyfill set (node-stdlib-browser's choices), pinned, from esm.sh.
const POLYFILLS = {
  path: "https://esm.sh/path-browserify@1.0.1?bundle",
  events: "https://esm.sh/events@3.3.0?bundle",
  util: "https://esm.sh/util@0.12.5?bundle",
  buffer: "https://esm.sh/buffer@6.0.3?bundle",
  stream: "https://esm.sh/stream-browserify@3.0.0?bundle",
  string_decoder: "https://esm.sh/string_decoder@1.3.0?bundle",
};

const td = new TextDecoder(), te = new TextEncoder();
const files = new Map(); // absolute path -> Uint8Array
const dirs = new Set(["/"]);
const changed = new Map(); // path -> Uint8Array | null (removed)
let cwd = "/";

const post = (fd, text) => postMessage({ type: "out", fd, text: String(text) });

// --- paths ---------------------------------------------------------------------------------------------------
function normalize(p) {
  const out = [];
  for (const s of p.split("/")) {
    if (!s || s === ".") continue;
    if (s === "..") out.pop(); else out.push(s);
  }
  return "/" + out.join("/");
}
const join = (...ps) => normalize(ps.join("/"));
const dirname = p => normalize(p + "/..");
const abs = p => (String(p).startsWith("/") ? normalize(String(p)) : join(cwd, String(p)));

// --- fs over the snapshot --------------------------------------------------------------------------------------
const fsError = (code, syscall, p) => Object.assign(new Error(`${code}: ${{ ENOENT: "no such file or directory", EISDIR: "illegal operation on a directory", ENOTDIR: "not a directory", EEXIST: "file already exists" }[code] ?? code}, ${syscall} '${p}'`), { code, syscall, path: p, errno: -2 });
function addDirs(p) { for (let d = dirname(p); !dirs.has(d); d = dirname(d)) dirs.add(d); }
function readBytes(p) { p = abs(p); if (files.has(p)) return files.get(p); throw fsError(dirs.has(p) ? "EISDIR" : "ENOENT", "open", p); }
function write(p, data) {
  p = abs(p);
  if (!dirs.has(dirname(p))) throw fsError("ENOENT", "open", p);
  const bytes = typeof data === "string" ? te.encode(data) : new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data);
  files.set(p, bytes); changed.set(p, bytes);
}
const decode = (b, enc) => {
  enc = typeof enc === "string" ? enc : enc?.encoding;
  if (!enc) return builtins.buffer.Buffer.from(b);
  if (enc === "utf8" || enc === "utf-8") return td.decode(b);
  return builtins.buffer.Buffer.from(b).toString(enc);
};
function statOf(p) {
  p = abs(p);
  const isFile = files.has(p), isDir = dirs.has(p);
  if (!isFile && !isDir) throw fsError("ENOENT", "stat", p);
  const now = new Date();
  return { isFile: () => isFile, isDirectory: () => isDir, isSymbolicLink: () => false, size: isFile ? files.get(p).length : 0, mode: isDir ? 0o40755 : 0o100644, mtime: now, mtimeMs: +now, ctime: now, ctimeMs: +now, birthtime: now, atime: now, uid: 1000, gid: 1000, dev: 1, ino: 0, nlink: 1 };
}
function readdir(p, opts) {
  p = abs(p);
  if (!dirs.has(p)) throw fsError(files.has(p) ? "ENOTDIR" : "ENOENT", "scandir", p);
  const prefix = p === "/" ? "/" : p + "/", names = new Set();
  for (const x of [...files.keys(), ...dirs]) if (x.startsWith(prefix) && x !== p) names.add(x.slice(prefix.length).split("/")[0]);
  const list = [...names].sort();
  return opts?.withFileTypes ? list.map(name => ({ name, isFile: () => files.has(prefix + name), isDirectory: () => dirs.has(prefix + name), isSymbolicLink: () => false })) : list;
}
const fs = {
  readFileSync: (p, enc) => decode(readBytes(p), enc),
  writeFileSync: (p, d) => write(p, d),
  appendFileSync: (p, d) => { p = abs(p); const old = files.get(p) ?? new Uint8Array(); const add = typeof d === "string" ? te.encode(d) : d; const b = new Uint8Array(old.length + add.length); b.set(old); b.set(add, old.length); write(p, b); },
  existsSync: p => { p = abs(p); return files.has(p) || dirs.has(p); },
  statSync: statOf, lstatSync: statOf,
  readdirSync: readdir,
  mkdirSync: (p, o) => { p = abs(p); if (dirs.has(p)) { if (o?.recursive) return; throw fsError("EEXIST", "mkdir", p); } if (!o?.recursive && !dirs.has(dirname(p))) throw fsError("ENOENT", "mkdir", p); addDirs(p + "/x"); dirs.add(p); changed.set(p + "/", null); },
  unlinkSync: p => { p = abs(p); if (!files.has(p)) throw fsError("ENOENT", "unlink", p); files.delete(p); changed.set(p, null); },
  rmSync: (p, o) => { p = abs(p); for (const f of [...files.keys()]) if (f === p || f.startsWith(p + "/")) { files.delete(f); changed.set(f, null); } dirs.delete(p); },
  realpathSync: p => abs(p),
  accessSync: p => { if (!fs.existsSync(p)) throw fsError("ENOENT", "access", abs(p)); },
  constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
};
fs.promises = Object.fromEntries(Object.entries(fs).filter(([k, v]) => k.endsWith("Sync")).map(([k, v]) => [k.slice(0, -4), async (...a) => v(...a)]));
for (const [k, v] of Object.entries(fs.promises)) fs[k] = (...a) => { const cb = typeof a.at(-1) === "function" ? a.pop() : null; v(...a).then(r => cb?.(null, r), e => cb?.(e)); };

// --- built-ins ---------------------------------------------------------------------------------------------------
const builtins = {};
const unsupported = name => new Proxy({}, { get: (_, k) => (k === "__esModule" ? false : () => { throw Object.assign(new Error(`node:${name}.${String(k)} is not available in this shell`), { code: "ERR_NOT_AVAILABLE" }); }) });

function makeProcess(argv, env) {
  const { EventEmitter } = builtins.events;
  const p = new EventEmitter();
  const t0 = performance.now();
  Object.assign(p, {
    argv, env, execArgv: [], argv0: "node", execPath: "/usr/local/bin/node", title: "node", pid: 1, ppid: 0,
    platform: "linux", arch: "x64", version: "v22.18.0", versions: { node: "22.18.0" }, release: { name: "node" },
    cwd: () => cwd, chdir: d => { const n = abs(d); if (!dirs.has(n)) throw fsError("ENOENT", "chdir", n); cwd = n; },
    exitCode: undefined,
    exit: code => { throw new Exit(code ?? p.exitCode ?? 0); },
    stdout: { write: s => (post(1, typeof s === "string" ? s : td.decode(s)), true), isTTY: false, columns: 80, on() {}, once() {}, end() {} },
    stderr: { write: s => (post(2, typeof s === "string" ? s : td.decode(s)), true), isTTY: false, columns: 80, on() {}, once() {}, end() {} },
    stdin: { isTTY: false, on() {}, once() {}, read: () => null },
    nextTick: (f, ...a) => queueMicrotask(() => f(...a)),
    hrtime: Object.assign(prev => { const t = performance.now() * 1e6, s = Math.floor(t / 1e9), n = Math.floor(t % 1e9); return prev ? [s - prev[0], n - prev[1]] : [s, n]; }, { bigint: () => BigInt(Math.floor(performance.now() * 1e6)) }),
    uptime: () => (performance.now() - t0) / 1000,
    memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }),
    emitWarning: m => post(2, `(node) Warning: ${m}\n`),
    umask: () => 0o22,
    binding: n => { throw new Error(`process.binding(${n}) is not available`); },
  });
  return p;
}
class Exit { constructor(code) { this.code = code; } }

// Loaded as soon as the worker starts, so a spare worker can be warmed before the next node command arrives.
async function loadPolyfills() {
  const mods = await Promise.all(Object.entries(POLYFILLS).map(async ([k, url]) => [k, await import(url)]));
  for (const [k, m] of mods) builtins[k] = m.default ?? m;
  const [test, assert, assertStrict] = await Promise.all(["node-test.js", "assert.js", "assert-strict.js"].map(f => import(RUNNER + f)));
  builtins.test = Object.assign(test.default, test);
  builtins.assert = assert.default; builtins["assert/strict"] = assertStrict.default;
}
const warm = Promise.all([lexerInit, loadPolyfills()]);
const timing = { warmDoneAt: 0 };
warm.then(() => (timing.warmDoneAt = performance.now()));
// Node has no requestAnimationFrame; Chromium's worker one throws outside a canvas worker (tfjs calls it).
delete globalThis.requestAnimationFrame; delete globalThis.cancelAnimationFrame;
function loadBuiltins(argv, env) {
  builtins.process = makeProcess(argv, env);
  builtins.fs = fs; builtins["fs/promises"] = fs.promises;
  builtins.os = { EOL: "\n", platform: () => "linux", type: () => "Linux", arch: () => "x64", release: () => "6.0.0", homedir: () => "/home/user", tmpdir: () => "/tmp", hostname: () => "localhost", cpus: () => [{ model: "browser", speed: 0 }], totalmem: () => 4e9, freemem: () => 2e9, endianness: () => "LE", userInfo: () => ({ username: "user", homedir: "/home/user" }), networkInterfaces: () => ({}), constants: { signals: {} } };
  builtins.tty = { isatty: () => false, WriteStream: class {}, ReadStream: class {} };
  builtins.url = { URL, URLSearchParams, fileURLToPath: u => decodeURIComponent(new URL(u).pathname), pathToFileURL: p => new URL("file://" + abs(p)) };
  builtins.timers = { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate: (f, ...a) => setTimeout(f, 0, ...a), clearImmediate: clearTimeout };
  builtins["timers/promises"] = { setTimeout: (ms, v) => new Promise(r => setTimeout(() => r(v), ms)), setImmediate: v => Promise.resolve(v) };
  builtins.module = { createRequire: f => makeRequire(dirname(String(f).replace(/^file:\/\//, ""))), builtinModules: Object.keys(builtins) };
  builtins.perf_hooks = { performance, PerformanceObserver: class { observe() {} disconnect() {} } };
  builtins.querystring = { parse: s => Object.fromEntries(new URLSearchParams(s)), stringify: o => new URLSearchParams(o).toString() };
  builtins.crypto = { randomUUID: () => crypto.randomUUID(), getRandomValues: a => crypto.getRandomValues(a), webcrypto: crypto, randomBytes: n => builtins.buffer.Buffer.from(crypto.getRandomValues(new Uint8Array(n))) };
  for (const n of ["child_process", "net", "http", "https", "zlib", "worker_threads", "vm", "dns", "cluster", "http2", "inspector", "v8", "readline"]) builtins[n] = unsupported(n);
  globalThis.process = builtins.process;
  globalThis.Buffer = builtins.buffer.Buffer;
  globalThis.global = globalThis;
  globalThis.setImmediate ??= builtins.timers.setImmediate;
  globalThis.clearImmediate ??= clearTimeout;
  const { format } = builtins.util;
  const line = fd => (...a) => post(fd, format(...a) + "\n");
  Object.assign(console, { log: line(1), info: line(1), debug: line(1), warn: line(2), error: line(2), trace: line(2) });
}
const builtinName = s => { const n = s.startsWith("node:") ? s.slice(5) : s; return n in builtins ? n : null; };

// --- resolution (Node's rules, the parts packages use) ---------------------------------------------------------
const readJson = p => JSON.parse(td.decode(files.get(p)));
function pick(t, cond) {
  if (t == null) return null;
  if (typeof t === "string") return t;
  if (Array.isArray(t)) { for (const x of t) { const r = pick(x, cond); if (r) return r; } return null; }
  for (const [k, v] of Object.entries(t)) if (k === cond || k === "node" || k === "default" || k === "module-sync") { const r = pick(v, cond); if (r) return r; }
  return null;
}
function exportsTarget(pj, sub, cond) {
  let ex = pj.exports;
  if (typeof ex === "string" || Array.isArray(ex) || !Object.keys(ex).some(k => k.startsWith("."))) ex = { ".": ex };
  if (sub in ex) return pick(ex[sub], cond);
  for (const [k, v] of Object.entries(ex)) {
    const star = k.indexOf("*");
    if (star >= 0 && sub.startsWith(k.slice(0, star)) && sub.endsWith(k.slice(star + 1))) { const r = pick(v, cond); return r && r.replace("*", sub.slice(star, sub.length - (k.length - star - 1))); }
  }
  return null;
}
const EXTS = ["", ".js", ".mjs", ".cjs", ".json"];
const tryFile = p => { for (const e of EXTS) if (files.has(p + e)) return p + e; return null; };
function tryDir(p, cond) {
  const pjPath = p + "/package.json";
  if (files.has(pjPath)) { const main = readJson(pjPath).main; if (main) { const r = tryFile(join(p, main)) ?? tryFile(join(p, main, "index")); if (r) return r; } }
  return tryFile(p + "/index");
}
function resolveSpec(spec, fromDir, cond) {
  const b = builtinName(spec);
  if (b) return "node:" + b;
  if (spec.startsWith("node:")) throw Object.assign(new Error(`No such built-in module: ${spec}`), { code: "ERR_UNKNOWN_BUILTIN_MODULE" });
  if (/^https?:\/\//.test(spec)) return spec; // URL imports, as Deno and browsers do
  if (spec.startsWith("file://")) spec = spec.slice(7);
  if (/^\.{1,2}(\/|$)|^\//.test(spec)) {
    const p = spec.startsWith("/") ? normalize(spec) : join(fromDir, spec);
    const r = tryFile(p) ?? tryDir(p, cond);
    if (r) return r;
  } else {
    const parts = spec.split("/"), name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    const sub = spec.slice(name.length);
    for (let d = fromDir; ; d = dirname(d)) {
      const root = join(d, "node_modules", name);
      if (dirs.has(root)) {
        const pj = files.has(root + "/package.json") ? readJson(root + "/package.json") : {};
        if (pj.exports) { const t = exportsTarget(pj, "." + sub, cond); if (t && files.has(join(root, t))) return join(root, t); throw Object.assign(new Error(`Package subpath '.${sub}' is not defined by "exports" in ${root}/package.json`), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }); }
        const r = sub ? tryFile(root + sub) ?? tryDir(root + sub, cond) : tryDir(root, cond);
        if (r) return r;
      }
      if (d === "/") break;
    }
  }
  throw Object.assign(new Error(`Cannot find module '${spec}' from ${fromDir}`), { code: "MODULE_NOT_FOUND" });
}
function isEsm(p) {
  if (p.endsWith(".mjs")) return true;
  if (p.endsWith(".cjs") || p.endsWith(".json")) return false;
  for (let d = dirname(p); ; d = dirname(d)) {
    if (files.has(d + "/package.json")) { try { return readJson(d + "/package.json").type === "module"; } catch { return false; } }
    if (d === "/") return false;
  }
}

// --- CommonJS --------------------------------------------------------------------------------------------------
const cjsCache = new Map(), esmNamespaces = new Map();
function makeRequire(fromDir) {
  const require = spec => loadCjs(resolveSpec(spec, fromDir, "require"));
  require.resolve = spec => resolveSpec(spec, fromDir, "require");
  require.cache = cjsCache;
  return require;
}
function loadCjs(p) {
  if (p.startsWith("node:")) return builtins[p.slice(5)];
  if (/^https?:/.test(p)) throw Object.assign(new Error(`require() of a URL (${p}) is not supported; use import()`), { code: "ERR_REQUIRE_ESM" });
  if (cjsCache.has(p)) return cjsCache.get(p).exports;
  if (p.endsWith(".json")) { const m = { exports: readJson(p) }; cjsCache.set(p, m); return m.exports; }
  if (isEsm(p)) {
    if (esmNamespaces.has(p)) return esmNamespaces.get(p);
    throw Object.assign(new Error(`require() of ES Module ${p} is not supported in this shell; use import()`), { code: "ERR_REQUIRE_ESM" });
  }
  const module = { exports: {}, id: p, filename: p, loaded: false, children: [], paths: [], require: null };
  cjsCache.set(p, module);
  module.require = makeRequire(dirname(p));
  runCjs(td.decode(files.get(p)), p, module);
  module.loaded = true;
  return module.exports;
}
function runCjs(src, p, module) {
  src = rewriteDynamic(src.replace(/^#!.*/, ""), p);
  const fn = (0, eval)(`(function (exports, require, module, __filename, __dirname) {${src}\n})\n//# sourceURL=file://${p}`);
  fn.call(module.exports, module.exports, module.require, module, p, dirname(p));
}
globalThis.__cjs = loadCjs;

// --- ESM: each module becomes a blob URL with its specifiers rewritten -------------------------------------------
const esmUrls = new Map(), inProgress = new Set();
const blob = code => URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
const ident = k => /^[A-Za-z_$][\w$]*$/.test(k) && !["default", "await", "enum", "implements", "package", "protected", "interface", "private", "public", "yield", "let", "static"].includes(k);
const RUNNER_URLS = { test: "node-test.js", assert: "assert.js", "assert/strict": "assert-strict.js" };
function wrapper(expr, m) {
  const keys = Object.keys(m ?? {}).filter(ident);
  return `const m = ${expr}; export default m;\n` + keys.map(k => `export const ${k} = m[${JSON.stringify(k)}];`).join("\n");
}
globalThis.__builtin = n => builtins[n];
function rewriteDynamic(src, p) {
  if (!src.includes("import")) return src;
  let imports;
  try { [imports] = lexImports(src); } catch { return src; }
  for (const imp of [...imports].reverse()) if (imp.d > -1) src = src.slice(0, imp.ss) + `__imp(${JSON.stringify(p)})` + src.slice(imp.ss + 6);
  return src;
}
// Pending async work Node would wait for: dynamic imports and fetches (timers are tracked below).
let pendingOps = 0;
const track = p => { pendingOps++; return p.finally(() => pendingOps--); };
globalThis.__imp = from => spec => track(importFrom(spec, dirname(from)));
const realFetch = fetch;
globalThis.fetch = (...a) => track(realFetch(...a));
async function importFrom(spec, fromDir) {
  const r = resolveSpec(spec, fromDir, "import");
  const ns = await import(await esmUrl(r));
  if (!r.startsWith("node:") && !/^https?:/.test(r)) esmNamespaces.set(r, ns);
  return ns;
}
function esmUrl(p) {
  if (esmUrls.has(p)) {
    if (inProgress.has(p)) throw new Error(`circular ES module imports are not supported in this shell (${p})`);
    return esmUrls.get(p);
  }
  const job = (async () => {
    if (/^https?:/.test(p)) return p;
    inProgress.add(p);
    try {
      if (p.startsWith("node:")) {
        const n = p.slice(5);
        return RUNNER_URLS[n] ? RUNNER + RUNNER_URLS[n] : blob(wrapper(`globalThis.__builtin(${JSON.stringify(n)})`, builtins[n]));
      }
      if (!isEsm(p)) return blob(wrapper(`globalThis.__cjs(${JSON.stringify(p)})`, loadCjs(p)));
      let src = td.decode(files.get(p));
      const [imports] = lexImports(src);
      const edits = [];
      for (const imp of imports) {
        if (imp.d === -1) edits.push([imp.s, imp.e, await esmUrl(resolveSpec(imp.n, dirname(p), "import"))]);
        else if (imp.d === -2) edits.push([imp.s, imp.e, `({ url: ${JSON.stringify("file://" + p)}, filename: ${JSON.stringify(p)}, dirname: ${JSON.stringify(dirname(p))}, resolve: s => "file://" + globalThis.__resolve(s, ${JSON.stringify(dirname(p))}) })`]);
        else edits.push([imp.ss, imp.ss + 6, `__imp(${JSON.stringify(p)})`]);
      }
      for (const [s, e, text] of edits.sort((a, b) => b[0] - a[0])) src = src.slice(0, s) + text + src.slice(e);
      return blob(src + `\n//# sourceURL=file://${p}`);
    } finally { inProgress.delete(p); }
  })();
  esmUrls.set(p, job);
  return job;
}
globalThis.__resolve = (s, d) => resolveSpec(s, d, "import");

// --- running ---------------------------------------------------------------------------------------------------
// Node exits when nothing is pending; here: when no timers are pending after the main module settles.
let pendingTimers = 0;
const realSetTimeout = setTimeout, realClearTimeout = clearTimeout, live = new Set();
globalThis.setTimeout = (f, ms, ...a) => { const id = realSetTimeout(() => { live.delete(id); f(...a); }, ms); live.add(id); return id; };
globalThis.clearTimeout = id => { live.delete(id); realClearTimeout(id); };
const realSetInterval = setInterval, realClearInterval = clearInterval;
globalThis.setInterval = (f, ms, ...a) => { const id = realSetInterval(f, ms, ...a); live.add(id); return id; };
globalThis.clearInterval = id => { live.delete(id); realClearInterval(id); };

let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  try { builtins.process?.emit("exit", code); } catch {}
  postMessage({ type: "exit", code, changed: [...changed], timing: { ...timing, runMs: Math.round(performance.now() - timing.receivedAt) }, resources: performance.getEntriesByType("resource").map(e => e.name) });
}
function crash(e) {
  if (e instanceof Exit) return finish(e.code);
  post(2, (e?.stack && !String(e.stack).includes("blob:") ? e.stack : `${e?.name ?? "Error"}: ${e?.message ?? e}`) + "\n");
  finish(1);
}
self.addEventListener("error", e => { e.preventDefault(); crash(e.error ?? e.message); });
self.addEventListener("unhandledrejection", e => { e.preventDefault(); crash(e.reason); });
async function idle() {
  for (;;) {
    await new Promise(r => realSetTimeout(r, 0));
    if (live.size === 0 && pendingOps === 0) return;
    await new Promise(r => realSetTimeout(r, 5));
  }
}

function testFiles(args) {
  const found = [];
  const add = p => { if (files.has(p)) found.push(p); else for (const f of files.keys()) if (f.startsWith(p + "/") && !f.includes("/node_modules/") && /\.(c|m)?js$/.test(f)) found.push(f); };
  if (args.length) args.forEach(a => add(abs(a)));
  else for (const f of files.keys()) if (f.startsWith(cwd === "/" ? "/" : cwd + "/") && !f.includes("/node_modules/") && /(\.|-|_)test\.(c|m)?js$|(^|\/)test\.(c|m)?js$|\/test\/[^/]*\.(c|m)?js$/.test(f.slice(cwd.length)) && /test/.test(f)) found.push(f);
  return [...new Set(found)].sort();
}

onmessage = async ({ data }) => {
  try {
    const t0 = performance.now();
    timing.receivedAt = t0; timing.warmAtReceipt = timing.warmDoneAt > 0;
    for (const [p, bytes] of data.files) { files.set(p, bytes); addDirs(p); }
    for (const d of data.dirs) { dirs.add(d); addDirs(d + "/x"); }
    cwd = data.cwd;
    await warm;
    timing.warmWaitMs = Math.round(performance.now() - t0);
    loadBuiltins(data.argv, data.env);
    const tLoaded = performance.now();
    if (data.timing) post(2, `[node-worker] snapshot+builtins ${Math.round(tLoaded - t0)} ms\n`);
    if (data.mode === "eval") {
      const module = { exports: {}, id: "[eval]", filename: join(cwd, "[eval]"), loaded: false, children: [], paths: [], require: makeRequire(cwd) };
      runCjs(data.code, join(cwd, "[eval]"), module);
      if (data.print) console.log(module.exports);
    } else if (data.mode === "file") {
      const p = resolveSpec(abs(data.file), cwd, "import");
      if (isEsm(p)) await importFrom(p, cwd); else loadCjs(p);
    } else if (data.mode === "test") {
      const list = testFiles(data.files_);
      let broken = 0;
      for (const f of list) {
        try { if (isEsm(f)) await importFrom(f, cwd); else loadCjs(f); }
        catch (e) { broken++; post(1, `FAIL: ${f.slice(cwd.length + 1)} did not load\n   ${e?.message ?? e}\n`); }
      }
      globalThis.window ??= {};
      const { passed, failed } = await builtins.test.run({ broken });
      post(1, `# files ${list.length}\n# tests ${passed + failed}\n# pass ${passed}\n# fail ${failed}\n`);
      process.exitCode = failed > 0 || list.length === 0 ? 1 : 0;
    }
    await idle();
    finish(process.exitCode ?? 0);
  } catch (e) { crash(e); }
};
