// `node` for the shell: one nested Worker per program. The shell seeds a spare with its files ahead of time and, when
// a command comes, sends only what changed since. Programs run with a CommonJS loader, an ESM loader (blob URLs with
// rewritten specifiers), Node's built-ins from node-stdlib-browser's packages, a synchronous fs over the files, and
// node:test from the app's node-test.js. Output streams back as messages; the last one carries the exit code and the
// files written or removed.
import { init as lexerInit, parse as lexImports } from "https://esm.sh/es-module-lexer@1.7.0";

const RUNNER = new URL("../node-test.js", import.meta.url).href;
// The polyfill set (node-stdlib-browser's choices), pinned. From jsDelivr: esm.sh's builds of stream, zlib and the
// hashes swap in its own class-based events, which their constructors can't call.
const POLYFILLS = Object.fromEntries(Object.entries({
  path: "path-browserify@1.0.1", events: "events@3.3.0", util: "util@0.12.5", buffer: "buffer@6.0.3", stream: "stream-browserify@3.0.0",
  string_decoder: "string_decoder@1.3.0", zlib: "browserify-zlib@0.2.0", "create-hash": "create-hash@1.2.0", "create-hmac": "create-hmac@1.1.7",
}).map(([k, pkg]) => [k, `https://cdn.jsdelivr.net/npm/${pkg}/+esm`]));
// Packages that take a Node path when they see Node, though they have a browser build that works here: the loader
// prefers their "browser" export condition and field, and hides process.versions.node once one loads.
// NODE_BROWSER_PACKAGES adds to the list (a,b,@scope/), removes (-a), or takes every package (*); none empties it.
const BROWSER_PACKAGES = ["onnxruntime-web", "onnxruntime-common", "@tensorflow/", "@huggingface/transformers", "@xenova/transformers", "@mediapipe/", "@jax-js/", "jax-js", "@ffmpeg/", "@webgpu/"];

const td = new TextDecoder(), te = new TextEncoder();
const files = new Map(); // absolute path -> Uint8Array
const dirs = new Set(["/"]);
const changed = new Map(); // path -> Uint8Array | null (removed) | "dir"
let cwd = "/", stdin = new Uint8Array(), browserPolicy = { all: false, names: BROWSER_PACKAGES };

const post = (fd, text) => postMessage({ type: "out", fd, text: String(text) });

// --- paths -------------------------------------------------------------------------------------------------------
function normalize(p) {
  const out = [];
  for (const s of String(p).split("/")) { if (!s || s === ".") continue; if (s === "..") out.pop(); else out.push(s); }
  return "/" + out.join("/");
}
const join = (...ps) => normalize(ps.join("/"));
const dirname = p => normalize(p + "/..");
const abs = p => (p instanceof URL ? normalize(decodeURIComponent(p.pathname)) : String(p).startsWith("file://") ? normalize(decodeURIComponent(new URL(String(p)).pathname)) : String(p).startsWith("/") ? normalize(String(p)) : join(cwd, String(p)));

// --- fs over the files -------------------------------------------------------------------------------------------
const MESSAGES = { ENOENT: "no such file or directory", EISDIR: "illegal operation on a directory", ENOTDIR: "not a directory", EEXIST: "file already exists", ENOTEMPTY: "directory not empty", EBADF: "bad file descriptor", EINVAL: "invalid argument" };
const fsError = (code, syscall, p) => Object.assign(new Error(`${code}: ${MESSAGES[code] ?? code}, ${syscall} '${p}'`), { code, syscall, path: p, errno: -2 });
function addDirs(p) { for (let d = dirname(p); !dirs.has(d); d = dirname(d)) { dirs.add(d); changed.set(d, "dir"); } }
const isStdin = p => p === 0 || p === "/dev/stdin";
function readBytes(p) {
  if (isStdin(p)) return stdin;
  p = abs(p);
  if (files.has(p)) return files.get(p);
  throw fsError(dirs.has(p) ? "EISDIR" : "ENOENT", "open", p);
}
const toBytes = data => (typeof data === "string" ? te.encode(data) : data instanceof Uint8Array ? data.slice() : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)) : new Uint8Array(data));
function write(p, data) {
  if (p === 1 || p === "/dev/stdout") return void post(1, typeof data === "string" ? data : td.decode(toBytes(data)));
  if (p === 2 || p === "/dev/stderr") return void post(2, typeof data === "string" ? data : td.decode(toBytes(data)));
  p = abs(p);
  if (!dirs.has(dirname(p))) throw fsError("ENOENT", "open", p);
  if (dirs.has(p)) throw fsError("EISDIR", "open", p);
  const bytes = toBytes(data);
  files.set(p, bytes); changed.set(p, bytes);
}
const decode = (b, enc) => {
  enc = typeof enc === "string" ? enc : enc?.encoding;
  if (!enc) return builtins.buffer.Buffer.from(b);
  if (enc === "utf8" || enc === "utf-8") return td.decode(b);
  return builtins.buffer.Buffer.from(b).toString(enc);
};
const T0 = new Date();
function statOf(p) {
  if (typeof p === "number") return statOf(fds.get(p)?.path ?? "/dev/null");
  p = abs(p);
  const isFile = files.has(p), isDir = dirs.has(p);
  if (!isFile && !isDir) throw fsError("ENOENT", "stat", p);
  return { isFile: () => isFile, isDirectory: () => isDir, isSymbolicLink: () => false, isFIFO: () => false, isSocket: () => false, isBlockDevice: () => false, isCharacterDevice: () => false,
    size: isFile ? files.get(p).length : 0, mode: isDir ? 0o40755 : 0o100644, mtime: T0, mtimeMs: +T0, ctime: T0, ctimeMs: +T0, birthtime: T0, birthtimeMs: +T0, atime: T0, atimeMs: +T0, uid: 1000, gid: 1000, dev: 1, ino: 0, nlink: 1, blksize: 4096, blocks: 0 };
}
function readdir(p, opts) {
  p = abs(p);
  if (!dirs.has(p)) throw fsError(files.has(p) ? "ENOTDIR" : "ENOENT", "scandir", p);
  const prefix = p === "/" ? "/" : p + "/", names = new Set();
  for (const x of [...files.keys(), ...dirs]) if (x.startsWith(prefix) && x !== p) names.add(x.slice(prefix.length).split("/")[0]);
  const list = [...names].sort();
  return opts?.withFileTypes ? list.map(name => ({ name, parentPath: p, path: p, isFile: () => files.has(prefix + name), isDirectory: () => dirs.has(prefix + name), isSymbolicLink: () => false })) : list;
}
function remove(p, recursive) {
  p = abs(p);
  if (files.has(p)) { files.delete(p); changed.set(p, null); return; }
  if (!dirs.has(p)) throw fsError("ENOENT", "rm", p);
  const inside = [...files.keys(), ...dirs].filter(x => x.startsWith(p + "/"));
  if (inside.length && !recursive) throw fsError("ENOTEMPTY", "rmdir", p);
  for (const x of inside) { files.delete(x); dirs.delete(x); changed.set(x, null); }
  dirs.delete(p); changed.set(p, null);
}
const fds = new Map();
let nextFd = 10;
const fs = {
  readFileSync: (p, enc) => decode(readBytes(p), enc),
  writeFileSync: (p, d) => write(typeof p === "number" ? fds.get(p)?.path ?? p : p, d),
  appendFileSync: (p, d) => { p = abs(p); const old = files.get(p) ?? new Uint8Array(), add = toBytes(d), b = new Uint8Array(old.length + add.length); b.set(old); b.set(add, old.length); write(p, b); },
  existsSync: p => { try { p = abs(p); } catch { return false; } return files.has(p) || dirs.has(p); },
  statSync: (p, o) => { try { return statOf(p); } catch (e) { if (o?.throwIfNoEntry === false) return undefined; throw e; } },
  lstatSync: (p, o) => fs.statSync(p, o),
  fstatSync: fd => statOf(fd),
  readdirSync: readdir,
  mkdirSync: (p, o) => {
    p = abs(p);
    if (dirs.has(p)) { if (o?.recursive) return; throw fsError("EEXIST", "mkdir", p); }
    if (files.has(p)) throw fsError("EEXIST", "mkdir", p);
    if (!o?.recursive && !dirs.has(dirname(p))) throw fsError("ENOENT", "mkdir", p);
    addDirs(p + "/x"); dirs.add(p); changed.set(p, "dir");
    return o?.recursive ? p : undefined;
  },
  mkdtempSync: prefix => { const p = abs(prefix + Math.random().toString(36).slice(2, 8)); fs.mkdirSync(p, { recursive: true }); return p; },
  unlinkSync: p => { p = abs(p); if (!files.has(p)) throw fsError(dirs.has(p) ? "EISDIR" : "ENOENT", "unlink", p); remove(p); },
  rmSync: (p, o) => { try { remove(p, o?.recursive); } catch (e) { if (!(o?.force && e.code === "ENOENT")) throw e; } },
  rmdirSync: (p, o) => remove(p, o?.recursive),
  renameSync: (a, b) => {
    a = abs(a); b = abs(b);
    if (files.has(a)) { write(b, files.get(a)); remove(a); return; }
    if (!dirs.has(a)) throw fsError("ENOENT", "rename", a);
    for (const x of [...dirs].filter(x => x === a || x.startsWith(a + "/"))) { const to = b + x.slice(a.length); dirs.add(to); changed.set(to, "dir"); }
    for (const [x, bytes] of [...files].filter(([x]) => x.startsWith(a + "/"))) write(b + x.slice(a.length), bytes);
    remove(a, true);
  },
  copyFileSync: (a, b) => write(b, readBytes(a)),
  cpSync: (a, b, o) => { a = abs(a); b = abs(b); if (files.has(a)) return write(b, files.get(a)); for (const [x, bytes] of [...files].filter(([x]) => x.startsWith(a + "/"))) { addDirs(b + x.slice(a.length)); write(b + x.slice(a.length), bytes); } },
  realpathSync: Object.assign(p => { const n = abs(p); if (!files.has(n) && !dirs.has(n)) throw fsError("ENOENT", "realpath", n); return n; }, { native: p => fs.realpathSync(p) }),
  readlinkSync: p => { throw fsError("EINVAL", "readlink", abs(p)); },
  symlinkSync: (t, p) => write(p, readBytes(join(dirname(abs(p)), t))),
  accessSync: p => { if (!fs.existsSync(p)) throw fsError("ENOENT", "access", abs(p)); },
  chmodSync: () => {}, utimesSync: () => {}, fsyncSync: () => {},
  openSync: (p, flags = "r") => {
    const path = abs(p), fd = nextFd++;
    if (/[wa]/.test(flags)) { if (flags.startsWith("w") || !files.has(path)) write(path, new Uint8Array()); }
    else readBytes(path);
    fds.set(fd, { path, pos: flags.startsWith("a") ? (files.get(path)?.length ?? 0) : 0 });
    return fd;
  },
  closeSync: fd => void fds.delete(fd),
  writeSync: (fd, data, ...rest) => {
    if (fd === 1 || fd === 2) { const bytes = typeof data === "string" ? te.encode(data) : toBytes(data); post(fd, td.decode(bytes)); return bytes.length; }
    const f = fds.get(fd);
    if (!f) throw fsError("EBADF", "write", String(fd));
    const add = typeof data === "string" ? te.encode(data) : toBytes(data).subarray(rest[0] ?? 0, (rest[0] ?? 0) + (rest[1] ?? data.length));
    const old = files.get(f.path) ?? new Uint8Array(), size = Math.max(old.length, f.pos + add.length), b = new Uint8Array(size);
    b.set(old); b.set(add, f.pos); f.pos += add.length; write(f.path, b);
    return add.length;
  },
  readSync: (fd, buffer, offset = 0, length = buffer.length - offset, position = null) => {
    const f = fd === 0 ? (fds.get(0) ?? (fds.set(0, { path: "/dev/stdin", pos: 0 }), fds.get(0))) : fds.get(fd);
    if (!f) throw fsError("EBADF", "read", String(fd));
    const src = f.path === "/dev/stdin" ? stdin : readBytes(f.path), at = position ?? f.pos;
    const chunk = src.subarray(at, at + length);
    buffer.set(chunk, offset);
    if (position == null) f.pos += chunk.length;
    return chunk.length;
  },
  watch: () => { throw Object.assign(new Error("fs.watch is not available in this shell"), { code: "ERR_NOT_AVAILABLE" }); },
  watchFile: () => {}, unwatchFile: () => {},
  constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_TRUNC: 512, O_APPEND: 1024, COPYFILE_EXCL: 1 },
};
fs.promises = Object.fromEntries(Object.entries(fs).filter(([k]) => k.endsWith("Sync")).map(([k, v]) => [k.slice(0, -4), async (...a) => v(...a)]));
fs.promises.constants = fs.constants;
for (const [k, v] of Object.entries(fs.promises)) if (typeof v === "function") fs[k] = (...a) => { const cb = typeof a.at(-1) === "function" ? a.pop() : null; v(...a).then(r => cb?.(null, r), e => cb?.(e)); };
fs.exists = (p, cb) => cb?.(fs.existsSync(p));

// --- built-ins ---------------------------------------------------------------------------------------------------
const builtins = {};
const unsupported = (name, hint = "") => new Proxy({}, { get: (_, k) => (k === "__esModule" ? false : k === Symbol.toPrimitive || k === "then" ? undefined : () => { throw Object.assign(new Error(`node:${name}${typeof k === "string" ? "." + k : ""} is not available in this shell${hint}`), { code: "ERR_NOT_AVAILABLE" }); }) });
class Exit { constructor(code) { this.code = code; } }

function makeProcess(argv, env) {
  const { EventEmitter } = builtins.events;
  const p = new EventEmitter();
  const t0 = performance.now();
  const stream = fd => Object.assign(new EventEmitter(), { write: (s, enc, cb) => { post(fd, typeof s === "string" ? s : td.decode(toBytes(s))); (typeof enc === "function" ? enc : cb)?.(); return true; }, isTTY: false, columns: 80, rows: 24, fd, end() {}, cork() {}, uncork() {}, hasColors: () => false, getColorDepth: () => 1 });
  Object.assign(p, {
    argv, env, execArgv: [], argv0: "node", execPath: "/usr/local/bin/node", title: "node", pid: 42, ppid: 1, arch: "x64", platform: "linux",
    version: "v22.18.0", versions: { node: "22.18.0", v8: "12.4.254.21-node.27", uv: "1.51.0", modules: "127" }, release: { name: "node", lts: "Jod" },
    config: { variables: {} }, features: {},
    cwd: () => cwd, chdir: d => { const n = abs(d); if (!dirs.has(n)) throw fsError("ENOENT", "chdir", n); cwd = n; },
    exitCode: undefined,
    exit: code => { throw new Exit(code ?? p.exitCode ?? 0); },
    abort: () => { throw new Exit(134); },
    kill: () => true,
    stdout: stream(1), stderr: stream(2),
    stdin: makeStdin(),
    nextTick: (f, ...a) => queueMicrotask(() => f(...a)),
    hrtime: Object.assign(prev => { const t = performance.now() * 1e6, s = Math.floor(t / 1e9), n = Math.floor(t % 1e9); if (!prev) return [s, n]; let ds = s - prev[0], dn = n - prev[1]; if (dn < 0) { ds--; dn += 1e9; } return [ds, dn]; }, { bigint: () => BigInt(Math.floor(performance.now() * 1e6)) }),
    uptime: () => (performance.now() - t0) / 1000,
    memoryUsage: Object.assign(() => ({ rss: 5e7, heapTotal: 3e7, heapUsed: 2e7, external: 1e6, arrayBuffers: 1e5 }), { rss: () => 5e7 }),
    cpuUsage: () => ({ user: 0, system: 0 }), resourceUsage: () => ({}),
    emitWarning: m => post(2, `(node:42) Warning: ${m?.message ?? m}\n`),
    umask: () => 0o22, getuid: () => 1000, getgid: () => 1000, geteuid: () => 1000,
    binding: n => { throw new Error(`process.binding(${n}) is not available`); },
  });
  return p;
}
// stdin: the command's input, all at once, as a stream that has already ended.
function makeStdin() {
  const r = readableOf(stdin);
  return Object.assign(r, { isTTY: false, fd: 0, setRawMode: () => r, ref: () => r, unref: () => r });
}
function readableOf(bytes) {
  let done = false;
  return new builtins.stream.Readable({ read() { if (done) return; done = true; if (bytes.length) this.push(builtins.buffer.Buffer.from(bytes)); this.push(null); } });
}
fs.createReadStream = (p, o) => {
  const r = readableOf(readBytes(p));
  const enc = typeof o === "string" ? o : o?.encoding;
  if (enc) r.setEncoding(enc);
  return Object.assign(r, { path: abs(p), close: () => r.destroy() });
};
fs.createWriteStream = (p, o) => {
  const path = abs(p), append = (typeof o === "object" && o?.flags?.startsWith("a"));
  let bytes = append ? files.get(path) ?? new Uint8Array() : new Uint8Array();
  write(path, bytes);
  const w = new builtins.stream.Writable({
    write(chunk, enc, cb) { const add = typeof chunk === "string" ? te.encode(chunk) : toBytes(chunk), b = new Uint8Array(bytes.length + add.length); b.set(bytes); b.set(add, bytes.length); bytes = b; write(path, bytes); cb(); },
  });
  return Object.assign(w, { path, close: cb => w.end(cb) });
};

// Loaded as soon as the worker starts, so a spare is warm before the command comes.
async function loadPolyfills() {
  const mods = await Promise.all(Object.entries(POLYFILLS).map(async ([k, url]) => [k, await import(url)]));
  for (const [k, m] of mods) builtins[k] = m.default ?? m;
  // Node's zlib takes any Uint8Array; browserify-zlib only its Buffer.
  const z = builtins.zlib, asBuffer = d => (typeof d === "string" || builtins.buffer.Buffer.isBuffer(d) ? d : builtins.buffer.Buffer.from(d));
  builtins.zlib = Object.assign({ ...z }, Object.fromEntries(Object.keys(z).filter(k => /Sync$/.test(k)).map(k => [k, (d, o) => z[k](asBuffer(d), o)])));
  runner = await import(RUNNER);
}
let runner = null, registeredTests = false;
const warm = Promise.all([lexerInit, loadPolyfills()]);
// Node has no requestAnimationFrame; Chromium's worker one throws outside a canvas worker (tfjs calls it).
delete globalThis.requestAnimationFrame; delete globalThis.cancelAnimationFrame;

function makeReadline() {
  const { EventEmitter } = builtins.events;
  const lines = () => td.decode(stdin).split(/\r?\n/).filter((l, i, all) => i < all.length - 1 || l);
  return {
    createInterface: () => {
      const rl = new EventEmitter(), queue = lines();
      let closed = false;
      const close = () => { if (!closed) { closed = true; rl.emit("close"); } };
      setTimeout(() => { for (const l of [...queue]) rl.emit("line", l); queue.length = 0; close(); }, 0);
      return Object.assign(rl, {
        question: (q, cb) => { post(1, q); const a = queue.shift() ?? ""; setTimeout(() => cb(a), 0); },
        close, pause: () => rl, resume: () => rl, setPrompt() {}, prompt() {}, write() {},
        [Symbol.asyncIterator]: async function* () { for (const l of lines()) yield l; },
      });
    },
    clearLine: () => true, cursorTo: () => true, moveCursor: () => true, emitKeypressEvents() {},
  };
}
const promised = (fn, args) => new Promise((resolve, reject) => fn(...args, (e, v) => (e ? reject(e) : resolve(v))));

// child_process: commands of this shell, run by the shell over this program's files as they are.
let execs = 0;
const execWaiting = new Map();
function shellExec(command, options = {}) {
  const id = ++execs;
  const entries = [...changed].map(([p, v]) => (v === null ? ["x", p] : v === "dir" ? ["d", p] : ["f", p, v]));
  return new Promise(resolve => {
    execWaiting.set(id, resolve);
    pendingOps++;
    postMessage({ type: "exec", id, command, cwd: options.cwd ? abs(options.cwd) : cwd, env: { ...builtins.process.env, ...(options.env ?? {}) }, changed: entries, stdin: options.input != null ? String(options.input) : null });
  }).finally(() => pendingOps--);
}
function makeChildProcess() {
  const { EventEmitter } = builtins.events;
  const { Buffer } = builtins.buffer;
  const quote = a => (/^[\w./=:@%+-]+$/.test(a) ? a : `'${String(a).replace(/'/g, "'\\''")}'`);
  const exec = (command, options, cb) => {
    if (typeof options === "function") [cb, options] = [options, {}];
    const child = spawnLike(shellExec(command, options), options);
    child.on("_done", r => cb?.(r.exitCode ? Object.assign(new Error(`Command failed: ${command}\n${r.stderr}`), { code: r.exitCode, stdout: r.stdout, stderr: r.stderr }) : null, r.stdout, r.stderr));
    return child;
  };
  function spawnLike(promise, options = {}) {
    const child = new EventEmitter();
    const mk = () => Object.assign(new EventEmitter(), { setEncoding() { return this; }, pipe(dest) { this.on("data", d => dest.write(d)); return dest; } });
    Object.assign(child, { stdout: mk(), stderr: mk(), stdin: { write() { return true; }, end() {} }, pid: 100 + execs, kill: () => false });
    promise.then(r => {
      if (r.stdout) child.stdout.emit("data", options.encoding === "buffer" ? Buffer.from(r.stdout) : r.stdout);
      if (r.stderr) child.stderr.emit("data", r.stderr);
      child.stdout.emit("end"); child.stderr.emit("end");
      child.emit("exit", r.exitCode, null); child.emit("close", r.exitCode, null); child.emit("_done", r);
    });
    return child;
  }
  const notSync = name => () => { throw Object.assign(new Error(`child_process.${name} is not available in this shell: there is no synchronous way to run a command here. Use exec or spawn (async), or run the command in bash.`), { code: "ERR_NOT_AVAILABLE" }); };
  const cp = {
    exec,
    execFile: (file, args, options, cb) => { if (typeof args === "function") [cb, args, options] = [args, [], {}]; if (typeof options === "function") [cb, options] = [options, {}]; return exec([file, ...(args ?? [])].map(quote).join(" "), options, cb); },
    spawn: (cmd, args = [], options = {}) => { if (!Array.isArray(args)) [options, args] = [args, []]; return spawnLike(shellExec(options.shell ? [cmd, ...args].join(" ") : [cmd, ...args].map(quote).join(" "), options), options); },
    fork: notSync("fork"), execSync: notSync("execSync"), execFileSync: notSync("execFileSync"), spawnSync: notSync("spawnSync"),
  };
  cp.exec[Symbol.for("nodejs.util.promisify.custom")] = (c, o) => new Promise((resolve, reject) => exec(c, o, (e, stdout, stderr) => (e ? reject(e) : resolve({ stdout, stderr }))));
  cp.execFile[Symbol.for("nodejs.util.promisify.custom")] = (f, a, o) => new Promise((resolve, reject) => cp.execFile(f, a, o, (e, stdout, stderr) => (e ? reject(e) : resolve({ stdout, stderr }))));
  return cp;
}

// fetch: through the shell to the tab, so the app's proxy and CORS rules hold.
let fetches = 0;
const fetchWaiting = new Map();
function proxiedFetch(input, init = {}) {
  const request = input instanceof Request ? input : new Request(input, init);
  if (!/^https?:$/.test(new URL(request.url).protocol)) return realFetch(input, init);
  pendingOps++;
  return (async () => {
    const body = ["GET", "HEAD"].includes(request.method) ? undefined : new Uint8Array(await request.arrayBuffer());
    const id = ++fetches;
    const r = await new Promise(resolve => { fetchWaiting.set(id, resolve); postMessage({ type: "fetch", id, request: { url: request.url, method: request.method, headers: [...request.headers], body } }); });
    if (r.error) throw new TypeError(r.error);
    const res = new Response([101, 204, 205, 304].includes(r.status) ? null : r.body, { status: r.status, statusText: r.statusText, headers: r.headers });
    Object.defineProperty(res, "url", { value: r.url || request.url });
    return res;
  })().finally(() => pendingOps--);
}

function makeCrypto() {
  const { Buffer } = builtins.buffer;
  const wrap = h => { const update = h.update.bind(h), digest = h.digest.bind(h); return Object.assign(h, { update: (d, enc) => (update(typeof d === "string" ? Buffer.from(d, enc) : d), h), digest: enc => digest(enc) }); };
  return {
    randomUUID: () => crypto.randomUUID(), getRandomValues: a => crypto.getRandomValues(a), webcrypto: crypto, subtle: crypto.subtle,
    randomBytes: (n, cb) => { const b = Buffer.from(crypto.getRandomValues(new Uint8Array(n))); if (cb) { setTimeout(() => cb(null, b), 0); return; } return b; },
    randomInt: (a, b) => (b === undefined ? Math.floor(Math.random() * a) : a + Math.floor(Math.random() * (b - a))),
    createHash: alg => wrap(builtins["create-hash"](alg)),
    createHmac: (alg, key) => wrap(builtins["create-hmac"](alg, key)),
    getHashes: () => ["md5", "sha1", "sha256", "sha512"],
    timingSafeEqual: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]),
    createCipheriv: unsupported("crypto", "").createCipheriv,
  };
}

function loadBuiltins(argv, env) {
  builtins.process = makeProcess(argv, env);
  builtins.fs = fs; builtins["fs/promises"] = fs.promises;
  builtins.os = { EOL: "\n", platform: () => "linux", type: () => "Linux", arch: () => "x64", release: () => "6.0.0", version: () => "#1 SMP", machine: () => "x86_64", homedir: () => env.HOME ?? "/home/user", tmpdir: () => "/tmp", hostname: () => "localhost", cpus: () => Array.from({ length: navigator.hardwareConcurrency || 4 }, () => ({ model: "browser", speed: 0, times: {} })), availableParallelism: () => navigator.hardwareConcurrency || 4, totalmem: () => 4e9, freemem: () => 2e9, loadavg: () => [0, 0, 0], uptime: () => performance.now() / 1000, endianness: () => "LE", userInfo: () => ({ username: env.USER ?? "user", homedir: env.HOME ?? "/home/user", uid: 1000, gid: 1000, shell: "/bin/bash" }), networkInterfaces: () => ({}), constants: { signals: { SIGINT: 2, SIGTERM: 15 }, errno: {} }, devNull: "/dev/null" };
  builtins.tty = { isatty: () => false, WriteStream: class {}, ReadStream: class {} };
  builtins.url = { URL, URLSearchParams, fileURLToPath: u => decodeURIComponent(new URL(String(u)).pathname), pathToFileURL: p => new URL("file://" + abs(p)), format: u => String(u), parse: s => { const u = new URL(s, "http://x"); return { ...Object.fromEntries(["href", "protocol", "host", "hostname", "port", "pathname", "search", "hash"].map(k => [k, u[k]])), path: u.pathname + u.search, query: u.search.slice(1) }; }, resolve: (a, b) => new URL(b, a).href };
  builtins.timers = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, setImmediate: (f, ...a) => globalThis.setTimeout(f, 0, ...a), clearImmediate: id => globalThis.clearTimeout(id) };
  builtins["timers/promises"] = { setTimeout: (ms, v) => new Promise(r => globalThis.setTimeout(() => r(v), ms)), setImmediate: v => new Promise(r => globalThis.setTimeout(() => r(v), 0)), scheduler: { wait: ms => new Promise(r => globalThis.setTimeout(r, ms)) } };
  builtins.module = { createRequire: f => makeRequire(dirname(abs(String(f)))), builtinModules: Object.keys(builtins), isBuiltin: s => !!builtinName(s) };
  builtins.perf_hooks = { performance, PerformanceObserver: class { observe() {} disconnect() {} } };
  builtins.querystring = { parse: s => Object.fromEntries(new URLSearchParams(s)), stringify: o => new URLSearchParams(o).toString(), escape: encodeURIComponent, unescape: decodeURIComponent };
  builtins.crypto = makeCrypto();
  builtins.readline = makeReadline();
  builtins["readline/promises"] = { createInterface: o => { const rl = builtins.readline.createInterface(o); return Object.assign(rl, { question: q => new Promise(r => builtins.readline.createInterface(o).question(q, r)) }); } };
  builtins.child_process = makeChildProcess();
  builtins.assert = runner.assert; builtins["assert/strict"] = runner.strict;
  // node:test, as the runner exports it; a file that registers a test runs its tests when it settles.
  const flagged = fn => Object.assign((...a) => { registeredTests = true; return fn(...a); }, { skip: (...a) => (registeredTests = true, fn.skip(...a)), todo: (...a) => (registeredTests = true, fn.todo(...a)), only: (...a) => (registeredTests = true, fn.only(...a)) });
  const test = flagged(runner.test), describe = flagged(runner.describe);
  builtins.test = Object.assign(test, { test, it: test, describe, suite: describe, before: runner.before, after: runner.after, beforeEach: runner.beforeEach, afterEach: runner.afterEach, mock: runner.mock, run: undefined });
  builtins["stream/promises"] = { pipeline: (...s) => promised(builtins.stream.pipeline, s), finished: s => promised(builtins.stream.finished, [s]) };
  builtins["util/types"] = builtins.util.types;
  builtins["path/posix"] = builtins.path;
  builtins.async_hooks = { AsyncLocalStorage: class { run(store, fn, ...a) { this.store = store; return fn(...a); } getStore() { return this.store; } enterWith(s) { this.store = s; } }, AsyncResource: class { runInAsyncScope(fn, self, ...a) { return fn.apply(self, a); } }, createHook: () => ({ enable() {}, disable() {} }), executionAsyncId: () => 1 };
  builtins.diagnostics_channel = { channel: () => ({ hasSubscribers: false, publish() {}, subscribe() {}, unsubscribe() {} }), hasSubscribers: () => false, subscribe() {}, unsubscribe() {} };
  builtins.worker_threads = { isMainThread: true, parentPort: null, workerData: null, threadId: 0, Worker: class { constructor() { throw Object.assign(new Error("worker_threads.Worker is not available in this shell"), { code: "ERR_NOT_AVAILABLE" }); } } };
  for (const n of ["net", "tls", "dgram", "dns", "cluster", "http2", "inspector", "v8", "vm", "repl", "sqlite"]) builtins[n] = unsupported(n);
  for (const n of ["http", "https"]) builtins[n] = unsupported(n, ": use fetch(), which goes through the app's proxy rules");
  globalThis.process = builtins.process;
  globalThis.Buffer = builtins.buffer.Buffer;
  globalThis.global = globalThis;
  globalThis.setImmediate ??= builtins.timers.setImmediate;
  globalThis.clearImmediate ??= builtins.timers.clearImmediate;
  globalThis.fetch = proxiedFetch;
  const { format, inspect } = builtins.util;
  let indent = "";
  const line = fd => (...a) => post(fd, (indent + format(...a)).replace(/\n/g, "\n" + indent) + "\n");
  const counts = new Map(), timers = new Map();
  Object.assign(console, {
    log: line(1), info: line(1), debug: line(1), warn: line(2), error: line(2), trace: (...a) => line(2)("Trace:", ...a),
    dir: (o, opts) => post(1, indent + inspect(o, opts) + "\n"),
    table: d => post(1, inspect(d) + "\n"),
    group: (...a) => { if (a.length) line(1)(...a); indent += "  "; }, groupCollapsed: (...a) => console.group(...a), groupEnd: () => { indent = indent.slice(2); },
    assert: (ok, ...a) => { if (!ok) line(2)("Assertion failed" + (a.length ? ":" : ""), ...a); },
    count: (l = "default") => { counts.set(l, (counts.get(l) ?? 0) + 1); line(1)(`${l}: ${counts.get(l)}`); }, countReset: (l = "default") => counts.delete(l),
    time: (l = "default") => timers.set(l, performance.now()), timeEnd: (l = "default") => { line(1)(`${l}: ${(performance.now() - (timers.get(l) ?? performance.now())).toFixed(3)}ms`); timers.delete(l); },
    timeLog: (l = "default", ...a) => line(1)(`${l}: ${(performance.now() - (timers.get(l) ?? performance.now())).toFixed(3)}ms`, ...a),
  });
}
const builtinName = s => { const n = String(s).startsWith("node:") ? s.slice(5) : s; return Object.hasOwn(builtins, n) && !["create-hash", "create-hmac"].includes(n) ? n : null; };

// --- which packages load their browser build ------------------------------------------------------------------------
function setBrowserPolicy(value) {
  const names = new Set(BROWSER_PACKAGES);
  let all = false;
  for (const t of String(value ?? "").split(",").map(s => s.trim()).filter(Boolean)) {
    if (t === "*") all = true;
    else if (t === "none") names.clear();
    else if (t.startsWith("-")) names.delete(t.slice(1));
    else names.add(t);
  }
  browserPolicy = { all, names: [...names] };
}
const browserFirst = name => !!name && (browserPolicy.all || browserPolicy.names.some(n => (n.endsWith("/") ? name.startsWith(n) : name === n)));
// The package a file is in: the name after its last node_modules/.
const packageOf = p => { const i = p.lastIndexOf("/node_modules/"); if (i < 0) return null; const parts = p.slice(i + 14).split("/"); return parts[0].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]; };
const packageRoot = p => { const i = p.lastIndexOf("/node_modules/"), name = packageOf(p); return name && p.slice(0, i + 14) + name; };
let nodeHidden = false;
function hideNode(path) {
  if (nodeHidden || !browserFirst(packageOf(path))) return;
  nodeHidden = true;
  builtins.process.versions = { ...builtins.process.versions, node: undefined };
  builtins.process.release = { name: "browser" };
}

// --- resolution (Node's rules, the parts packages use) ---------------------------------------------------------------
const readJson = p => JSON.parse(td.decode(files.get(p)));
const pjCache = new Map();
const packageJson = p => { if (!pjCache.has(p)) { try { pjCache.set(p, files.has(p) ? readJson(p) : null); } catch { pjCache.set(p, null); } } return pjCache.get(p); };
const CONDITIONS = {
  node: { import: ["node", "import", "module-sync", "default"], require: ["node", "require", "module-sync", "default"] },
  browser: { import: ["browser", "import", "module", "default"], require: ["browser", "require", "default"] },
};
function pick(t, conds) {
  if (t == null) return null;
  if (typeof t === "string") return t;
  if (Array.isArray(t)) { for (const x of t) { const r = pick(x, conds); if (r) return r; } return null; }
  for (const [k, v] of Object.entries(t)) if (conds.includes(k)) { const r = pick(v, conds); if (r) return r; }
  return null;
}
function exportsTarget(ex, sub, conds, imports = false) {
  if (!imports && (typeof ex === "string" || Array.isArray(ex) || !Object.keys(ex).some(k => k.startsWith(".")))) ex = { ".": ex };
  if (sub in ex) return pick(ex[sub], conds);
  let best = null;
  for (const [k, v] of Object.entries(ex)) {
    const star = k.indexOf("*");
    if (star >= 0 && sub.startsWith(k.slice(0, star)) && sub.endsWith(k.slice(star + 1)) && (!best || k.length > best[0].length)) best = [k, v, star];
    else if (k.endsWith("/") && sub.startsWith(k) && (!best || k.length > best[0].length)) best = [k, v, -1];
  }
  if (!best) return null;
  const [k, v, star] = best, r = pick(v, conds);
  if (!r) return null;
  return star >= 0 ? r.replaceAll("*", sub.slice(star, sub.length - (k.length - star - 1))) : r + sub.slice(k.length);
}
const EXTS = ["", ".js", ".mjs", ".cjs", ".json", ".node"];
const tryFile = p => { for (const e of EXTS) if (files.has(p + e)) return p + e; return null; };
function tryDir(p, kind, browser) {
  const pj = packageJson(p + "/package.json");
  const mains = [browser && typeof pj?.browser === "string" && pj.browser, browser && kind === "import" && pj?.module, pj?.main].filter(Boolean);
  for (const main of mains) { const r = tryFile(join(p, main)) ?? tryFile(join(p, main, "index")); if (r) return r; }
  return tryFile(p + "/index");
}
// A browser package's "browser" field object: a file mapped to another, or to nothing (false).
function browserMapped(p) {
  const root = packageRoot(p);
  if (!root || !browserFirst(packageOf(p))) return p;
  const map = packageJson(root + "/package.json")?.browser;
  if (!map || typeof map !== "object") return p;
  for (const [from, to] of Object.entries(map)) {
    if (!from.startsWith(".")) continue;
    const f = tryFile(join(root, from)) ?? join(root, from);
    if (f === p) return to === false ? "empty:" : tryFile(join(root, to)) ?? p;
  }
  return p;
}
function resolveSpec(spec, fromDir, kind) {
  spec = String(spec);
  // A browser package may map a module away: "fs": false.
  const owner = packageRoot(fromDir + "/x");
  const map = owner && browserFirst(packageOf(fromDir + "/x")) && packageJson(owner + "/package.json")?.browser;
  if (map && typeof map === "object" && spec in map) { if (map[spec] === false) return "empty:"; spec = map[spec].startsWith(".") ? join(owner, map[spec]) : map[spec]; }
  const b = builtinName(spec);
  if (b) return "node:" + b;
  if (spec.startsWith("node:")) throw Object.assign(new Error(`No such built-in module: ${spec}`), { code: "ERR_UNKNOWN_BUILTIN_MODULE" });
  if (/^(https?|data|blob):/.test(spec)) return spec; // URL imports, as browsers and Deno do
  if (spec.startsWith("file://")) spec = abs(spec);
  if (/^\.{1,2}(\/|$)|^\//.test(spec)) {
    const p = spec.startsWith("/") ? normalize(spec) : join(fromDir, spec);
    const browser = browserFirst(packageOf(p));
    const r = tryFile(p) ?? tryDir(p, kind, browser);
    if (r) return browser ? browserMapped(r) : r;
  } else if (spec.startsWith("#")) {
    for (let d = fromDir; ; d = dirname(d)) {
      const pj = packageJson(d + "/package.json");
      if (pj?.imports) { const t = exportsTarget(pj.imports, spec, CONDITIONS[browserFirst(packageOf(d + "/x")) ? "browser" : "node"][kind], true); if (t) return t.startsWith(".") ? tryFile(join(d, t)) ?? join(d, t) : resolveSpec(t, d, kind); }
      if (pj || d === "/") break;
    }
  } else {
    const parts = spec.split("/"), name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    const sub = spec.slice(name.length);
    const browser = browserFirst(name), conds = CONDITIONS[browser ? "browser" : "node"][kind];
    for (let d = fromDir; ; d = dirname(d)) {
      const root = join(d, "node_modules", name);
      if (dirs.has(root)) {
        const pj = packageJson(root + "/package.json") ?? {};
        if (pj.exports) {
          const t = exportsTarget(pj.exports, "." + sub, conds);
          if (t && files.has(join(root, t))) return browser ? browserMapped(join(root, t)) : join(root, t);
          throw Object.assign(new Error(`Package subpath '.${sub}' is not defined by "exports" in ${root}/package.json`), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
        }
        const r = sub ? tryFile(root + sub) ?? tryDir(root + sub, kind, browser) : tryDir(root, kind, browser);
        if (r) return browser ? browserMapped(r) : r;
      }
      if (d === "/") break;
    }
  }
  throw Object.assign(new Error(`Cannot find module '${spec}'\nRequire stack:\n- ${fromDir}`), { code: "MODULE_NOT_FOUND" });
}
function isEsm(p) {
  if (p.endsWith(".mjs")) return true;
  if (p.endsWith(".cjs") || p.endsWith(".json") || p.startsWith("empty:")) return false;
  for (let d = dirname(p); ; d = dirname(d)) {
    const pj = packageJson(d + "/package.json");
    if (pj) return pj.type === "module";
    if (d === "/") return false;
  }
}

// --- CommonJS --------------------------------------------------------------------------------------------------------
const cjsCache = new Map(), esmNamespaces = new Map();
function makeRequire(fromDir) {
  const require = spec => loadCjs(resolveSpec(spec, fromDir, "require"));
  require.resolve = Object.assign(spec => { const r = resolveSpec(spec, fromDir, "require"); return r.startsWith("node:") ? r.slice(5) : r; }, { paths: () => [join(fromDir, "node_modules")] });
  require.cache = new Proxy({}, { get: (_, k) => cjsCache.get(k), deleteProperty: (_, k) => cjsCache.delete(k), has: (_, k) => cjsCache.has(k), ownKeys: () => [...cjsCache.keys()], getOwnPropertyDescriptor: (_, k) => (cjsCache.has(k) ? { value: cjsCache.get(k), enumerable: true, configurable: true } : undefined) });
  require.main = mainModule;
  return require;
}
let mainModule;
function loadCjs(p) {
  if (p.startsWith("node:")) return builtins[p.slice(5)];
  if (p === "empty:") return {};
  if (/^(https?|data|blob):/.test(p)) throw Object.assign(new Error(`require() of a URL (${p}) is not supported; use import()`), { code: "ERR_REQUIRE_ESM" });
  if (p.endsWith(".node")) throw Object.assign(new Error(`${p} is a native addon, which can't load here: there is no native code in this shell`), { code: "ERR_DLOPEN_FAILED" });
  if (cjsCache.has(p)) return cjsCache.get(p).exports;
  hideNode(p);
  if (p.endsWith(".json")) { const m = { exports: readJson(p), loaded: true }; cjsCache.set(p, m); return m.exports; }
  if (isEsm(p)) {
    if (esmNamespaces.has(p)) return esmNamespaces.get(p);
    throw Object.assign(new Error(`require() of ES Module ${p} is not supported in this shell: use import() (or an .mjs file with import)`), { code: "ERR_REQUIRE_ESM" });
  }
  const module = { exports: {}, id: p, filename: p, path: dirname(p), loaded: false, children: [], paths: [], require: null, parent: null };
  cjsCache.set(p, module);
  module.require = makeRequire(dirname(p));
  try { runCjs(td.decode(files.get(p)), p, module); }
  catch (e) { cjsCache.delete(p); throw e; }
  module.loaded = true;
  return module.exports;
}
function runCjs(src, p, module) {
  src = rewriteDynamic(src.replace(/^#!.*/, ""), p);
  const fn = (0, eval)(`(function (exports, require, module, __filename, __dirname) {${src}\n})\n//# sourceURL=file://${p}`);
  fn.call(module.exports, module.exports, module.require, module, p, dirname(p));
}
globalThis.__cjs = loadCjs;

// --- ESM: each module becomes a blob URL with its specifiers rewritten ---------------------------------------------------
const esmUrls = new Map(), inProgress = new Set();
const blob = code => URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
const RESERVED = new Set(["default", "await", "enum", "implements", "package", "protected", "interface", "private", "public", "yield", "let", "static", "arguments", "eval"]);
const ident = k => /^[A-Za-z_$][\w$]*$/.test(k) && !RESERVED.has(k);
function wrapper(expr, m) {
  const keys = Object.keys(m ?? {}).filter(ident);
  return `const m = ${expr}; export default m;\n` + keys.map(k => `export const ${k} = m[${JSON.stringify(k)}];`).join("\n");
}
globalThis.__builtin = n => builtins[n];
function rewriteDynamic(src, p) {
  if (!src.includes("import")) return src;
  let imports;
  try { [imports] = lexImports(src); } catch { return src; }
  for (const imp of [...imports].reverse()) {
    if (imp.d > -1) src = src.slice(0, imp.ss) + `__imp(${JSON.stringify(p)})` + src.slice(imp.ss + 6);
    else if (imp.d === -2) src = src.slice(0, imp.s) + importMeta(p) + src.slice(imp.e);
  }
  return src;
}
const importMeta = p => `({ url: ${JSON.stringify("file://" + p)}, filename: ${JSON.stringify(p)}, dirname: ${JSON.stringify(dirname(p))}, main: ${JSON.stringify(p === mainPath)}, resolve: s => "file://" + globalThis.__resolve(s, ${JSON.stringify(dirname(p))}) })`;
// Async work Node would wait for: dynamic imports, fetches, child processes (timers are tracked below).
let pendingOps = 0, mainPath = null;
const track = p => { pendingOps++; return p.finally(() => pendingOps--); };
globalThis.__imp = from => spec => track(importFrom(spec, dirname(from)));
const realFetch = fetch;
async function importFrom(spec, fromDir) {
  const r = resolveSpec(spec, fromDir, "import");
  const ns = await import(await esmUrl(r));
  if (!r.startsWith("node:") && !/^(https?|data|blob):/.test(r)) esmNamespaces.set(r, ns);
  return ns;
}
function esmUrl(p) {
  if (esmUrls.has(p)) {
    if (inProgress.has(p)) throw new Error(`circular ES module imports are not supported in this shell (${p})`);
    return esmUrls.get(p);
  }
  const job = (async () => {
    if (/^(https?|data|blob):/.test(p)) return p;
    inProgress.add(p);
    try {
      if (p.startsWith("node:")) return blob(wrapper(`globalThis.__builtin(${JSON.stringify(p.slice(5))})`, builtins[p.slice(5)]));
      if (p === "empty:") return blob("export default {};");
      hideNode(p);
      if (!isEsm(p)) return blob(wrapper(`globalThis.__cjs(${JSON.stringify(p)})`, loadCjs(p)));
      let src = td.decode(files.get(p));
      const [imports] = lexImports(src);
      const edits = [];
      for (const imp of imports) {
        if (imp.d === -1) {
          edits.push([imp.s, imp.e, await esmUrl(resolveSpec(imp.n, dirname(p), "import"))]);
          const attrs = /^['"]?\s*(with|assert)\s*\{[^}]*\}/.exec(src.slice(imp.e, imp.se));
          if (attrs) edits.push([imp.e + attrs[0].indexOf(attrs[1]), imp.e + attrs[0].length, ""]);
        } else if (imp.d === -2) edits.push([imp.s, imp.e, importMeta(p)]);
        else edits.push([imp.ss, imp.ss + 6, `__imp(${JSON.stringify(p)})`]);
      }
      for (const [s, e, text] of edits.sort((a, b) => b[0] - a[0])) src = src.slice(0, s) + text + src.slice(e);
      return blob(src.replace(/^#!.*/, "") + `\n//# sourceURL=file://${p}`);
    } finally { inProgress.delete(p); }
  })();
  esmUrls.set(p, job);
  return job;
}
globalThis.__resolve = (s, d) => resolveSpec(s, d, "import");

// --- running -----------------------------------------------------------------------------------------------------------
// Node exits when nothing is pending; here: no timers, imports, fetches or child processes once the main module settles.
const realSetTimeout = setTimeout, realClearTimeout = clearTimeout, realSetInterval = setInterval, realClearInterval = clearInterval, live = new Set();
globalThis.setTimeout = (f, ms, ...a) => { const id = realSetTimeout(() => { live.delete(id); typeof f === "function" ? f(...a) : (0, eval)(f); }, ms); live.add(id); return Object.assign(Object(id), { ref: () => {}, unref: () => (live.delete(id), Object(id)), hasRef: () => live.has(id), [Symbol.toPrimitive]: () => id }); };
globalThis.clearTimeout = id => { id = +id; live.delete(id); realClearTimeout(id); };
globalThis.setInterval = (f, ms, ...a) => { const id = realSetInterval(f, ms, ...a); live.add(id); return Object.assign(Object(id), { ref: () => {}, unref: () => (live.delete(id), Object(id)), [Symbol.toPrimitive]: () => id }); };
globalThis.clearInterval = id => { id = +id; live.delete(id); realClearInterval(id); };

let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  try { builtins.process?.emit("exit", code); } catch {}
  const entries = [...changed].map(([p, v]) => (v === null ? ["x", p] : v === "dir" ? ["d", p] : ["f", p, v]));
  postMessage({ type: "exit", code: builtins.process?.exitCode ?? code, changed: entries });
}
const cleanStack = s => String(s).replace(/file:\/\//g, "").split("\n").filter(l => !/blob:|node\.js:\d|__imp|at async Promise\.all/.test(l)).join("\n");
function crash(e) {
  if (finished) return;
  if (e instanceof Exit) return finish(e.code);
  if (builtins.process?.listenerCount?.("uncaughtException")) { try { builtins.process.emit("uncaughtException", e); return; } catch (again) { e = again; } }
  post(2, (e?.stack ? cleanStack(e.stack) : `${e?.name ?? "Error"}: ${e?.message ?? e}`) + "\n" + (e?.code && !String(e.stack).includes(e.code) ? `  code: '${e.code}'\n` : "") + `\nNode.js v22.18.0\n`);
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

// node --test's files: those named on the command line (folders and globs too), else Node's default patterns.
const TEST_NAME = /(^|\/)(test|[^/]*[.\-_]test|test-[^/]*)\.(c|m)?js$|(^|\/)test\/.*\.(c|m)?js$/;
const globRe = g => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\?/g, "[^/]").replace(/\*\*\/|\*\*|\*/g, m => (m === "**/" ? "(?:.*/)?" : m === "**" ? ".*" : "[^/]*")) + "$");
function testFiles(args) {
  const all = [...files.keys()].filter(f => !f.includes("/node_modules/")).sort();
  const under = d => all.filter(f => f.startsWith(d === "/" ? "/" : d + "/") && TEST_NAME.test(f.slice(d.length)));
  if (!args.length) return under(cwd);
  const found = [];
  for (const a of args) {
    const p = abs(a);
    if (/[*?]/.test(a)) found.push(...all.filter(f => globRe(p).test(f)));
    else if (files.has(p)) found.push(p);
    else if (dirs.has(p)) found.push(...under(p));
    else throw Object.assign(new Error(`Could not find '${p}'`), { code: "ENOENT" });
  }
  return [...new Set(found)];
}
// The runner's PASS and FAIL lines as TAP, which is what node --test prints when its output isn't a terminal.
let tapCount = 0;
const tapLog = line => {
  const m = /^(PASS|FAIL): ([^\n]*)\n?([\s\S]*)$/.exec(String(line));
  if (!m) return post(1, `# ${line}\n`);
  tapCount++;
  if (m[1] === "PASS") return post(1, `ok ${tapCount} - ${m[2]}\n`);
  post(1, `not ok ${tapCount} - ${m[2]}\n  ---\n  error: ${JSON.stringify(m[3].trim())}\n  ...\n`);
};
// list: the files to load and run one by one; null runs the tests already registered (a test file run directly).
async function runTests(list) {
  const t0 = performance.now(), sum = { passed: 0, failed: 0, skipped: 0, todo: 0 };
  const base = "file://" + (cwd === "/" ? "/" : cwd + "/");
  if (!list) Object.assign(sum, await runner.run({ base, log: tapLog }));
  for (const f of list ?? []) {
    try {
      registeredTests = false;
      if (isEsm(f)) await importFrom(f, cwd); else loadCjs(f);
      const t = await runner.run({ base, log: tapLog });
      for (const k of Object.keys(sum)) sum[k] += t[k];
    } catch (e) {
      sum.failed++;
      tapLog(`FAIL: ${f.slice(cwd.length + 1) || f}\n   ${e?.message ?? e}`);
    }
  }
  const tests = sum.passed + sum.failed + sum.skipped + sum.todo;
  post(1, `1..${tapCount}\n# tests ${tests}\n# pass ${sum.passed}\n# fail ${sum.failed}\n# cancelled 0\n# skipped ${sum.skipped}\n# todo ${sum.todo}\n# duration_ms ${(performance.now() - t0).toFixed(1)}\n`);
  return sum;
}

function applyEntries(entries) {
  for (const [kind, p, bytes] of entries) {
    if (kind === "x") { files.delete(p); dirs.delete(p); for (const x of [...files.keys()]) if (x.startsWith(p + "/")) files.delete(x); for (const x of [...dirs]) if (x.startsWith(p + "/")) dirs.delete(x); }
    else if (kind === "d") { dirs.add(p); addDirsQuiet(p + "/x"); }
    else { files.set(p, bytes); addDirsQuiet(p); }
  }
  pjCache.clear();
}
function addDirsQuiet(p) { for (let d = dirname(p); !dirs.has(d); d = dirname(d)) dirs.add(d); }

onmessage = async ({ data }) => {
  if (data.type === "seed") return applyEntries(data.entries);
  if (data.type === "fetched") { fetchWaiting.get(data.id)?.(data); return fetchWaiting.delete(data.id); }
  if (data.type === "execd") {
    // The command's changes are in the shell already; this program sees them, and won't send its stale copies back.
    applyEntries(data.changed);
    for (const [, p] of data.changed) changed.delete(p);
    execWaiting.get(data.id)?.({ stdout: data.stdout, stderr: data.stderr, exitCode: data.exitCode });
    return execWaiting.delete(data.id);
  }
  if (data.type !== "run") return;
  try {
    applyEntries(data.delta);
    cwd = data.cwd;
    stdin = data.stdin ?? new Uint8Array();
    setBrowserPolicy(data.env?.NODE_BROWSER_PACKAGES);
    await warm;
    const job = data.job;
    loadBuiltins(job.argv, data.env);
    if (job.mode === "eval") {
      const filename = join(cwd, "[eval]");
      const module = mainModule = { exports: {}, id: "[eval]", filename, loaded: false, children: [], paths: [], require: makeRequire(cwd) };
      if (job.print) {
        Object.assign(globalThis, { require: module.require, module, exports: module.exports, __filename: filename, __dirname: cwd });
        const value = (0, eval)(rewriteDynamic(job.code, filename));
        console.log(typeof value === "string" ? value : builtins.util.inspect(value));
      } else runCjs(job.code, filename, module);
    } else if (job.mode === "file") {
      if (/\.(c|m)?ts$|\.tsx?$/.test(job.file)) throw Object.assign(new Error(`${job.file}: TypeScript doesn't run directly in this shell: compile it with npx tsc first, or write JavaScript`), { code: "ERR_UNKNOWN_FILE_EXTENSION" });
      const p = resolveSpec(job.file, cwd, "import");
      mainPath = p;
      if (isEsm(p)) await importFrom(p, cwd);
      else { mainModule = { id: ".", filename: p }; loadCjs(p); mainModule = cjsCache.get(p); }
      // A test file run directly runs its tests, as Node's does.
      if (registeredTests && runner.registered()) {
        await idle();
        const t = await runTests(null).catch(() => null);
        if (t?.failed) builtins.process.exitCode = 1;
      }
    } else if (job.mode === "test") {
      let list;
      try { list = testFiles(job.files); }
      catch (e) { post(2, `${e.message}\n`); return finish(1); }
      // No test files is no failure, as in Node; the counts say so.
      const t = await runTests(list);
      builtins.process.exitCode = t.failed > 0 ? 1 : 0;
    }
    await idle();
    finish(builtins.process.exitCode ?? 0);
  } catch (e) { crash(e); }
};
