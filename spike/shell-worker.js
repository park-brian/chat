// E11 spike: just-bash in a dedicated Worker over an in-memory FS. The harness keeps cwd and env across execs,
// and adds node, npm, git, python3/pip/pytest as custom commands.
const T0 = performance.now();
const JB = "https://esm.sh/just-bash@3.6.0/browser";
const { Bash, InMemoryFs, defineCommand } = await import(JB);
const T_IMPORT = performance.now();

const td = new TextDecoder(), te = new TextEncoder();
const fs = new InMemoryFs();
const state = { cwd: "/project", env: { HOME: "/home/user", USER: "user", PATH: "/usr/bin:/bin" } };
const NODE_TIMEOUT = 10_000;

// --- snapshot of the FS for the node and python workers ---------------------------------------------------------
const SYSTEM = /^\/(bin|usr|proc|dev|sys|etc)(\/|$)/;
async function snapshot(vfs) {
  const files = [], dirs = [];
  for (const p of vfs.getAllPaths()) {
    if (SYSTEM.test(p) || p === "/") continue;
    const st = await vfs.lstat(p);
    if (st.isDirectory) dirs.push(p);
    else if (st.isFile) files.push([p, await vfs.readFileBuffer(p)]);
  }
  return { files, dirs };
}
async function apply(vfs, changed) {
  for (const [p, bytes] of changed) {
    if (p.endsWith("/")) { await vfs.mkdir(p.slice(0, -1), { recursive: true }); continue; }
    if (bytes === null) { await vfs.rm(p, { force: true }); continue; }
    await vfs.mkdir(p.slice(0, p.lastIndexOf("/")) || "/", { recursive: true });
    await vfs.writeFile(p, bytes);
  }
}
const result = (stdout, stderr, exitCode) => ({ stdout, stderr, exitCode });

// --- node: a nested Worker per run, terminated on timeout -------------------------------------------------------
function runNode(job, ctx, timeout = NODE_TIMEOUT) {
  return new Promise(async resolve => {
    const t0 = performance.now();
    const { files, dirs } = await snapshot(ctx.fs);
    const tSnap = performance.now();
    // A spare worker, already loading its polyfills, takes the job; a new spare starts for the next command.
    const w = spareNode ?? newNodeWorker();
    spareNode = newNodeWorker();
    let stdout = "", stderr = "", done = false, workerTiming = null;
    const end = async (code, changed = []) => {
      if (done) return;
      done = true; clearTimeout(timer); w.terminate();
      await apply(ctx.fs, changed);
      lastNode = { snapshotMs: Math.round(tSnap - t0), files: files.length, totalMs: Math.round(performance.now() - t0), worker: workerTiming };
      resolve(result(stdout, stderr, code));
    };
    const timer = setTimeout(() => { stderr += `node: killed after ${timeout} ms (Worker.terminate)\n`; end(124); }, timeout);
    ctx.signal?.addEventListener("abort", () => { stderr += "node: aborted\n"; end(130); });
    w.onmessage = ({ data }) => {
      if (data.type === "out") data.fd === 1 ? (stdout += data.text) : (stderr += data.text);
      else if (data.type === "exit") { data.resources?.forEach(u => nodeResources.add(u)); workerTiming = data.timing; end(data.code, data.changed); }
    };
    w.onerror = e => { stderr += `node worker error: ${e.message}\n`; end(1); };
    w.postMessage({ ...job, files, dirs, cwd: ctx.cwd, env: Object.fromEntries(ctx.env), argv: job.argv ?? ["/usr/local/bin/node"] });
  });
}
let lastNode = null, spareNode = null;
const newNodeWorker = () => new Worker(new URL("./node-worker.js", import.meta.url), { type: "module" });
const nodeResources = new Set();

const node = defineCommand("node", async (args, ctx) => {
  const timeout = Number(ctx.env.get("NODE_TIMEOUT_MS")) || NODE_TIMEOUT;
  if (args[0] === "-v" || args[0] === "--version") return result("v22.18.0\n", "", 0);
  if (args[0] === "-e" || args[0] === "--eval" || args[0] === "-p" || args[0] === "--print")
    return runNode({ mode: "eval", code: args[0].startsWith("-p") || args[0] === "--print" ? `module.exports = (${args[1]})` : args[1], print: args[0].startsWith("-p") || args[0] === "--print", argv: ["/usr/local/bin/node", ...args.slice(2)] }, ctx, timeout);
  if (args[0] === "--test") return runNode({ mode: "test", files_: args.slice(1).filter(a => !a.startsWith("-")) }, ctx, timeout);
  if (!args[0]) return result("", "node: no REPL in this shell; use node -e or node file.js\n", 2);
  return runNode({ mode: "file", file: args[0], argv: ["/usr/local/bin/node", ctx.fs.resolvePath(ctx.cwd, args[0]), ...args.slice(1)] }, ctx, timeout);
});

// --- npm: registry tarballs, untarred into node_modules ----------------------------------------------------------
let semver;
const REGISTRY = "https://registry.npmjs.org/";
async function untar(bytes) {
  const out = [];
  let longName = null, paxPath = null;
  const str = (o, n) => td.decode(bytes.subarray(o, o + n)).replace(/\0.*$/s, "");
  for (let o = 0; o + 512 <= bytes.length;) {
    if (bytes.subarray(o, o + 512).every(b => b === 0)) break;
    const size = parseInt(str(o + 124, 12).trim() || "0", 8), type = String.fromCharCode(bytes[o + 156] || 48);
    const prefix = str(o + 345, 155), name = longName ?? paxPath ?? (prefix ? prefix + "/" : "") + str(o, 100);
    const body = bytes.subarray(o + 512, o + 512 + size);
    longName = paxPath = null;
    if (type === "L") longName = td.decode(body).replace(/\0.*$/s, "");
    else if (type === "x") { const m = /\d+ path=([^\n]*)\n/.exec(td.decode(body)); paxPath = m?.[1] ?? null; }
    else if (type === "0" || type === "\0") out.push([name, body.slice()]);
    o += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}
async function fetchPackument(name) {
  const r = await fetch(REGISTRY + name.replace("/", "%2f"), { headers: { Accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8" } });
  if (!r.ok) throw new Error(`npm: ${name}: ${r.status} from the registry`);
  return r.json();
}
async function npmInstall(ctx, specs, log) {
  semver ??= (await import("https://esm.sh/semver@7.7.2")).default;
  const root = ctx.cwd, pjPath = root + "/package.json";
  const pj = (await ctx.fs.exists(pjPath)) ? JSON.parse(await ctx.fs.readFile(pjPath)) : { name: root.split("/").pop(), version: "1.0.0" };
  const wanted = specs.length ? specs.map(s => { const at = s.lastIndexOf("@"); return at > 0 ? [s.slice(0, at), s.slice(at + 1)] : [s, "latest"]; }) : Object.entries(pj.dependencies ?? {});
  const placed = new Map(), lock = {};
  let count = 0, bytes = 0;
  async function install(name, range, dir) {
    const doc = await fetchPackument(name);
    const version = doc["dist-tags"][range] ?? semver.maxSatisfying(Object.keys(doc.versions), range);
    if (!version) throw new Error(`npm: no version of ${name} matches ${range}`);
    const top = root + "/node_modules/" + name;
    let target;
    if (!placed.has(name)) target = top; // hoisted
    else if (placed.get(name) === version) return version;
    else target = dir + "/node_modules/" + name; // a conflicting version nests under its dependent
    if (target === top) placed.set(name, version);
    const meta = doc.versions[version];
    const tgz = new Uint8Array(await (await fetch(meta.dist.tarball)).arrayBuffer());
    bytes += tgz.length;
    const tar = new Uint8Array(await new Response(new Blob([tgz]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
    for (const [p, body] of await untar(tar)) {
      const rel = p.replace(/^[^/]+\//, ""), dest = target + "/" + rel;
      await ctx.fs.mkdir(dest.slice(0, dest.lastIndexOf("/")), { recursive: true });
      await ctx.fs.writeFile(dest, body);
    }
    if (meta.bin) {
      const bins = typeof meta.bin === "string" ? { [name.split("/").pop()]: meta.bin } : meta.bin;
      await ctx.fs.mkdir(root + "/node_modules/.bin", { recursive: true });
      for (const [b, p] of Object.entries(bins)) await ctx.fs.writeFile(`${root}/node_modules/.bin/${b}`, `#!/usr/bin/env node\nrequire("../${name}/${p.replace(/^\.\//, "")}")\n`);
    }
    lock[target.slice(root.length + 1)] = { version, resolved: meta.dist.tarball, integrity: meta.dist.integrity };
    count++;
    await Promise.all(Object.entries(meta.dependencies ?? {}).map(([d, r]) => install(d, r, target)));
    return version;
  }
  const versions = await Promise.all(wanted.map(([n, r]) => install(n, r, root)));
  if (specs.length) { pj.dependencies = { ...pj.dependencies }; wanted.forEach(([n], i) => (pj.dependencies[n] = "^" + versions[i])); }
  await ctx.fs.writeFile(pjPath, JSON.stringify(pj, null, 2) + "\n");
  await ctx.fs.writeFile(root + "/package-lock.json", JSON.stringify({ name: pj.name, lockfileVersion: 3, packages: lock }, null, 2) + "\n");
  return `added ${count} packages (${Math.round(bytes / 1024)} KB of tarballs)\n`;
}
const npm = defineCommand("npm", async (args, ctx) => {
  const [cmd, ...rest] = args;
  try {
    if (cmd === "install" || cmd === "i" || cmd === "add") return result(await npmInstall(ctx, rest.filter(a => !a.startsWith("-"))), "", 0);
    if (cmd === "test" || cmd === "t" || cmd === "run" || cmd === "start") {
      const script = cmd === "run" ? rest[0] : cmd === "start" ? "start" : "test";
      const pj = JSON.parse(await ctx.fs.readFile(ctx.cwd + "/package.json"));
      const line = pj.scripts?.[script];
      if (!line) return result("", `npm error Missing script: "${script}"\n`, 1);
      const r = await ctx.exec(line, { cwd: ctx.cwd, env: { PATH: `${ctx.cwd}/node_modules/.bin:` + (ctx.env.get("PATH") ?? "") } });
      return result(`\n> ${pj.name} ${script}\n> ${line}\n\n` + r.stdout, r.stderr, r.exitCode);
    }
    return result("", `npm: ${cmd}: not supported in this shell (install, test, run, start)\n`, 1);
  } catch (e) { return result("", String(e.message ?? e) + "\n", 1); }
});

// --- tar / gzip: just-bash's browser build has no tar, and its gzip needs node:zlib (esm.sh gives an unenv stub).
// The platform's CompressionStream does gzip; a ustar reader and writer is ~40 lines.
const gzipBytes = async (bytes, decompress) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(decompress ? new DecompressionStream("gzip") : new CompressionStream("gzip"))).arrayBuffer());
function tarPack(entries) {
  const blocks = [];
  for (const [name, body] of entries) {
    const h = new Uint8Array(512), put = (s, o, n) => h.set(te.encode(s).subarray(0, n), o);
    let n = name, prefix = "";
    if (n.length > 100) { const cut = n.lastIndexOf("/", 155); prefix = n.slice(0, cut); n = n.slice(cut + 1); }
    put(n, 0, 100); put(body ? "0000644\0" : "0000755\0", 100, 8); put("0001750\0", 108, 8); put("0001750\0", 116, 8);
    put((body?.length ?? 0).toString(8).padStart(11, "0") + "\0", 124, 12); put(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136, 12);
    put("        ", 148, 8); h[156] = body ? 48 : 53; put("ustar\0" + "00", 257, 8); put(prefix, 345, 155);
    put(h.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ", 148, 8);
    blocks.push(h);
    if (body) { const padded = new Uint8Array(Math.ceil(body.length / 512) * 512); padded.set(body); blocks.push(padded); }
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((a, b) => a + b.length, 0));
  let o = 0; for (const b of blocks) { out.set(b, o); o += b.length; }
  return out;
}
const tar = defineCommand("tar", async (args, ctx) => {
  let flags = "", file = null, dir = ctx.cwd;
  const paths = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-C") dir = ctx.fs.resolvePath(ctx.cwd, args[++i]);
    else if (i === 0 && !a.startsWith("-") || /^-[a-zA-Z]+$/.test(a)) { flags += a.replace(/^-/, ""); if (flags.endsWith("f") && file === null) file = args[++i]; }
    else paths.push(a);
  }
  try {
    if (!file) return result("", "tar: this shell needs -f FILE\n", 2);
    const archive = ctx.fs.resolvePath(ctx.cwd, file);
    if (flags.includes("c")) {
      const entries = [];
      const add = async rel => {
        const p = ctx.fs.resolvePath(dir, rel), st = await ctx.fs.stat(p);
        if (st.isDirectory) { entries.push([rel.replace(/\/?$/, "/"), null]); for (const n of (await ctx.fs.readdir(p)).sort()) await add(rel.replace(/\/$/, "") + "/" + n); }
        else entries.push([rel, await ctx.fs.readFileBuffer(p)]);
      };
      for (const p of paths) await add(p);
      let bytes = tarPack(entries);
      if (flags.includes("z")) bytes = await gzipBytes(bytes);
      await ctx.fs.writeFile(archive, bytes);
      return result(flags.includes("v") ? entries.map(e => e[0]).join("\n") + "\n" : "", "", 0);
    }
    let bytes = await ctx.fs.readFileBuffer(archive);
    if (flags.includes("z") || (bytes[0] === 0x1f && bytes[1] === 0x8b)) bytes = await gzipBytes(bytes, true);
    const entries = await untar(bytes);
    if (flags.includes("t")) return result(entries.map(e => e[0]).join("\n") + "\n", "", 0);
    for (const [name, body] of entries) {
      const dest = ctx.fs.resolvePath(dir, name);
      await ctx.fs.mkdir(dest.slice(0, dest.lastIndexOf("/")) || "/", { recursive: true });
      await ctx.fs.writeFile(dest, body);
    }
    return result(flags.includes("v") ? entries.map(e => e[0]).join("\n") + "\n" : "", "", 0);
  } catch (e) { return result("", `tar: ${e.message ?? e}\n`, 2); }
});
const gzipCmd = (name, decompress) => defineCommand(name, async (args, ctx) => {
  const d = decompress || args.includes("-d"), keep = args.includes("-k"), toStdout = name === "zcat" || args.includes("-c");
  let stdout = "";
  for (const f of args.filter(a => !a.startsWith("-"))) {
    const p = ctx.fs.resolvePath(ctx.cwd, f);
    try {
      const bytes = await gzipBytes(await ctx.fs.readFileBuffer(p), d);
      if (toStdout) { stdout += td.decode(bytes); continue; }
      await ctx.fs.writeFile(d ? p.replace(/\.gz$/, "") : p + ".gz", bytes);
      if (!keep) await ctx.fs.rm(p);
    } catch (e) { return result(stdout, `${name}: ${f}: ${e.message ?? e}\n`, 1); }
  }
  return result(stdout, "", 0);
});

// --- git: isomorphic-git over the same FS ----------------------------------------------------------------------
let git, jsdiff;
function gitFs(vfs) {
  const wrap = fn => async (...a) => {
    try { return await fn(...a); } catch (e) {
      const m = String(e?.message ?? e);
      e.code ??= /ENOENT|no such file/i.test(m) ? "ENOENT" : /EEXIST|exists/i.test(m) ? "EEXIST" : /ENOTDIR|not a directory/i.test(m) ? "ENOTDIR" : /ENOTEMPTY|not empty/i.test(m) ? "ENOTEMPTY" : /EISDIR|is a directory/i.test(m) ? "EISDIR" : undefined;
      throw e;
    }
  };
  const stat = s => ({ ...s, isFile: () => s.isFile, isDirectory: () => s.isDirectory, isSymbolicLink: () => s.isSymbolicLink, mode: (s.isDirectory ? 0o040000 : s.isSymbolicLink ? 0o120000 : 0o100000) | (s.mode & 0o777), mtimeMs: +s.mtime, ctimeMs: +s.mtime, uid: 1, gid: 1, dev: 1, ino: 1 });
  return { promises: {
    readFile: wrap(async (p, o) => ((typeof o === "string" ? o : o?.encoding) ? vfs.readFile(p) : vfs.readFileBuffer(p))),
    writeFile: wrap((p, d) => vfs.writeFile(p, typeof d === "string" ? d : new Uint8Array(d))),
    unlink: wrap(p => vfs.rm(p)),
    readdir: wrap(p => vfs.readdir(p)),
    mkdir: wrap(async p => { if (await vfs.exists(p)) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" }); return vfs.mkdir(p); }),
    rmdir: wrap(p => vfs.rm(p, { recursive: true })),
    stat: wrap(async p => stat(await vfs.stat(p))),
    lstat: wrap(async p => stat(await vfs.lstat(p))),
    readlink: wrap(p => vfs.readlink(p)),
    symlink: wrap((t, p) => vfs.symlink(t, p)),
    chmod: wrap((p, m) => vfs.chmod(p, m)),
  } };
}
const gitCmd = defineCommand("git", async (args, ctx) => {
  git ??= (await import("https://esm.sh/isomorphic-git@1.44.2")).default;
  const gfs = gitFs(ctx.fs);
  const [cmd, ...rest] = args;
  const findRoot = async () => { try { return await git.findRoot({ fs: gfs, filepath: ctx.cwd }); } catch { return null; } };
  const dir = cmd === "init" ? ctx.cwd : await findRoot();
  if (!dir) return result("", "fatal: not a git repository (or any of the parent directories): .git\n", 128);
  const author = { name: ctx.env.get("GIT_AUTHOR_NAME") ?? "agent", email: ctx.env.get("GIT_AUTHOR_EMAIL") ?? "agent@localhost" };
  try {
    if (cmd === "init") { await git.init({ fs: gfs, dir, defaultBranch: "main" }); return result(`Initialized empty Git repository in ${dir}/.git/\n`, "", 0); }
    const matrix = () => git.statusMatrix({ fs: gfs, dir, filter: f => !f.startsWith("node_modules/") });
    if (cmd === "add") {
      for (const [f, h, w, s] of await matrix()) {
        if (!(rest.includes("-A") || rest.includes(".") || rest.includes(f))) continue;
        if (w === 0) { if (h) await git.remove({ fs: gfs, dir, filepath: f }); }
        else if (w !== s) await git.add({ fs: gfs, dir, filepath: f });
      }
      return result("", "", 0);
    }
    if (cmd === "commit") {
      const message = rest[rest.indexOf("-m") + 1] ?? "commit";
      const oid = await git.commit({ fs: gfs, dir, message, author });
      const branch = await git.currentBranch({ fs: gfs, dir });
      return result(`[${branch} ${oid.slice(0, 7)}] ${message}\n`, "", 0);
    }
    if (cmd === "status") {
      const lines = [];
      for (const [f, h, w, s] of await matrix()) {
        const x = h === 0 && s >= 2 ? "A" : h === 1 && s === 0 ? "D" : h === 1 && s === 3 ? "M" : h === 1 && s === 2 && w === 2 ? "M" : " ";
        const y = h === 0 && s === 0 && w === 2 ? "?" : w === 0 && s !== 0 ? "D" : (s === 3 || (s === 1 && w === 2) || (s === 2 && w === 3)) ? "M" : " ";
        if (x !== " " || y !== " ") lines.push(`${y === "?" ? "??" : x + y} ${f}`);
      }
      const branch = await git.currentBranch({ fs: gfs, dir });
      return result(rest.includes("--short") || rest.includes("-s") || rest.includes("--porcelain") ? lines.map(l => l + "\n").join("") : `On branch ${branch}\n` + (lines.length ? lines.join("\n") + "\n" : "nothing to commit, working tree clean\n"), "", 0);
    }
    if (cmd === "log") {
      const log = await git.log({ fs: gfs, dir, depth: 20 });
      const oneline = rest.includes("--oneline");
      return result(log.map(c => (oneline ? `${c.oid.slice(0, 7)} ${c.commit.message.split("\n")[0]}` : `commit ${c.oid}\nAuthor: ${c.commit.author.name} <${c.commit.author.email}>\n\n    ${c.commit.message.trim()}\n`)).join("\n") + "\n", "", 0);
    }
    if (cmd === "diff") {
      jsdiff ??= await import("https://esm.sh/diff@8.0.4");
      const head = await git.resolveRef({ fs: gfs, dir, ref: "HEAD" }).catch(() => null);
      let out = "";
      for (const [f, h, w] of await matrix()) {
        if (h === 0 || h === w || w === 1) continue;
        const before = head ? td.decode((await git.readBlob({ fs: gfs, dir, oid: head, filepath: f })).blob) : "";
        const after = w === 0 ? "" : await ctx.fs.readFile(dir + "/" + f);
        out += `diff --git a/${f} b/${f}\n` + jsdiff.createTwoFilesPatch("a/" + f, "b/" + f, before, after, "", "", { context: 3 }).split("\n").slice(2).join("\n");
      }
      return result(out, "", 0);
    }
    return result("", `git: '${cmd}' is not supported in this shell (init, add, commit, status, log, diff)\n`, 1);
  } catch (e) { return result("", `git: ${e.message ?? e}\n`, 1); }
});

// --- python3 / pip / pytest: Pyodide in its own Worker, kept for the session --------------------------------------
let pyWorker = null, lastPython = null;
function runPython(job, ctx, timeout) {
  return new Promise(async resolve => {
    const { files, dirs } = await snapshot(ctx.fs);
    pyWorker ??= new Worker(new URL("./python-worker.js", import.meta.url), { type: "module" });
    const w = pyWorker;
    const timer = setTimeout(() => { w.terminate(); pyWorker = null; resolve(result("", `python3: killed after ${timeout} ms (Worker.terminate)\n`, 124)); }, timeout);
    w.onmessage = async ({ data }) => {
      clearTimeout(timer);
      await apply(ctx.fs, data.changed);
      lastPython = { bootMs: data.bootMs, ms: data.ms, synced: data.synced, resources: data.resources };
      resolve(result(data.stdout, data.stderr, data.code));
    };
    w.postMessage({ ...job, files, dirs, cwd: ctx.cwd });
  });
}
const pyTimeout = ctx => Number(ctx.env.get("PY_TIMEOUT_MS")) || 120_000;
const python = defineCommand("python3", async (args, ctx) => {
  if (args[0] === "--version" || args[0] === "-V") return result("Python 3.14.2 (Pyodide 314.0.7)\n", "", 0);
  if (args[0] === "-c") return runPython({ mode: "c", arg: args[1], code: args[1], argv: ["-c", ...args.slice(2)] }, ctx, pyTimeout(ctx));
  if (args[0] === "-m") {
    if (args[1] === "pip") return pip.execute(args.slice(2), ctx);
    return runPython({ mode: "m", arg: args[1], argv: [args[1], ...args.slice(2)] }, ctx, pyTimeout(ctx));
  }
  const file = ctx.fs.resolvePath(ctx.cwd, args[0]);
  const code = await ctx.fs.readFile(file).catch(() => null);
  if (code === null) return result("", `python3: can't open file '${args[0]}': [Errno 2] No such file or directory\n`, 2);
  return runPython({ mode: "file", arg: file, code, argv: [file, ...args.slice(1)] }, ctx, pyTimeout(ctx));
});
const pip = defineCommand("pip", async (args, ctx) => {
  if (args[0] !== "install") return result("", "pip: only `pip install` is supported in this shell\n", 1);
  return runPython({ op: "pip", packages: args.slice(1).filter(a => !a.startsWith("-")) }, ctx, pyTimeout(ctx));
});
const pytest = defineCommand("pytest", async (args, ctx) => runPython({ mode: "m", arg: "pytest", argv: ["pytest", ...args] }, ctx, pyTimeout(ctx)));
const aliases = ["python", "pip3"].map(n => defineCommand(n, (a, c) => (n === "python" ? python : pip).execute(a, c)));

// --- the shell ---------------------------------------------------------------------------------------------------
let bash;
function makeBash(limits) {
  return new Bash({ fs, cwd: state.cwd, env: state.env, customCommands: [node, npm, gitCmd, python, pip, pytest, ...aliases, tar, gzipCmd("gzip", false), gzipCmd("gunzip", true), gzipCmd("zcat", true)], executionLimits: limits });
}
bash = makeBash({ maxExecutionTimeMs: 30_000 });
const T_READY = performance.now();
const BOOT_RESOURCES = performance.getEntriesByType("resource").map(e => e.name);

async function exec(command, { limits } = {}) {
  const sh = limits ? makeBash(limits) : bash;
  const t0 = performance.now();
  const r = await sh.exec(command, { cwd: state.cwd, env: state.env });
  const ms = performance.now() - t0;
  // just-bash resets cwd and env per exec: keep them here.
  if (r.env) { state.env = { ...r.env }; if (r.env.PWD) state.cwd = r.env.PWD; }
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, ms: Math.round(ms * 10) / 10 };
}

onmessage = async ({ data: { id, op, ...arg } }) => {
  try {
    let value;
    if (op === "seed") {
      for (const [p, content] of Object.entries(arg.files)) {
        await fs.mkdir(p.slice(0, p.lastIndexOf("/")), { recursive: true });
        await fs.writeFile(p, content);
      }
      if (arg.cwd) state.cwd = arg.cwd;
      value = { files: Object.keys(arg.files).length };
    } else if (op === "exec") value = await exec(arg.command, arg);
    else if (op === "info") value = { importMs: Math.round(T_IMPORT - T0), readyMs: Math.round(T_READY - T0), lastNode, lastPython, nodeResources: [...nodeResources], bootResources: BOOT_RESOURCES, crossOriginIsolated: self.crossOriginIsolated, sab: typeof SharedArrayBuffer, resources: performance.getEntriesByType("resource").map(e => e.name) };
    else if (op === "readBytes") value = await fs.readFileBuffer(arg.path);
    postMessage({ id, value });
  } catch (e) { postMessage({ id, error: String(e?.stack ?? e) }); }
};
postMessage({ ready: true, importMs: Math.round(T_IMPORT - T0) });
