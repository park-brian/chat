// A project's root: where its files come from and where they go. engine.js keeps every file the harness touches in
// its journal (versions in IndexedDB); a root decides what lies under the journal.
//
//   { kind: "workspace" }                            the journal is all there is (the default)
//   { kind: "folder", handle }                       a folder on disk, through the File System Access API
//   { kind: "github", owner, repo, branch, base }    a repository's branch, through GitHub's REST API
//
// A live root answers list(), read(path), write(path, text), watch(onChange), and git: one interface the shell's
// git and gh commands call. This module has no imports: engine.js hands it what it needs (isomorphic-git's loader,
// a patch maker, fetch), so it runs alike in a tab, the SharedWorker, and the tests.

// #region Ignores

// What a project never lists, beside its .gitignore files: dependencies, build output, git's own files.
export const DEFAULT_IGNORES = [
  "node_modules/", "dist/", "build/", "out/", "coverage/", ".next/", ".nuxt/", ".cache/", ".parcel-cache/", ".turbo/",
  ".venv/", "venv/", "__pycache__/", ".pytest_cache/", ".mypy_cache/", "target/", ".artifacts/",
  ".git", ".DS_Store", "Thumbs.db", "*.pyc",
];
// A file over this size is left out of the listing (a big binary, a bundle, a dataset).
export const MAX_FILE_SIZE = 1_000_000;
// Names that are binary whatever their size: listed, never read as text.
const BINARY = /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|avif|heic|psd|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|wasm|woff2?|ttf|otf|eot|mp[34]|m4a|mov|avi|mkv|webm|ogg|wav|flac|exe|dll|so|dylib|bin|o|a|class|pyd|db|sqlite3?|lockb)$/i;
export const isBinaryPath = path => BINARY.test(path);

const escapeRe = s => s.replace(/[.+^${}()|[\]\\*?]/g, "\\$&");

// One .gitignore line as a rule, relative to the folder the file is in (base: "" or "src/").
function compileRule(line, base) {
  let pattern = line.replace(/(?<!\\)\s+$/, "");
  if (!pattern || pattern.startsWith("#")) return null;
  let negate = false, dirOnly = false;
  if (pattern.startsWith("!")) { negate = true; pattern = pattern.slice(1); }
  else if (/^\\[#!]/.test(pattern)) pattern = pattern.slice(1);
  if (pattern.endsWith("/")) { dirOnly = true; pattern = pattern.slice(0, -1); }
  if (!pattern) return null;
  // A slash anywhere but the end anchors the pattern to its folder; otherwise it matches a name at any depth.
  const anchored = pattern.includes("/");
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*" && (i === 0 || pattern[i - 1] === "/") && (pattern[i + 2] === "/" || i + 2 === pattern.length)) {
      if (pattern[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i += 1; }
    } else if (c === "*") {
      while (pattern[i + 1] === "*") i++;
      re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "[" && pattern.indexOf("]", i + 2) > i) {
      const end = pattern.indexOf("]", i + 2);
      const body = pattern.slice(i + 1, end);
      re += "[" + (body[0] === "!" ? "^" + body.slice(1) : body).replace(/\\/g, "\\\\") + "]";
      i = end;
    } else if (c === "\\" && i + 1 < pattern.length) re += escapeRe(pattern[++i]);
    else re += escapeRe(c);
  }
  return { negate, dirOnly, re: new RegExp(`^${escapeRe(base)}${anchored ? "" : "(?:.*/)?"}${re}$`) };
}

// gitignore's rules, as git reads them: the last rule that matches decides, ! re-includes, a trailing slash matches
// only folders. A folder left out is never walked, so nothing inside it comes back (as in git).
export function createIgnore(lines = DEFAULT_IGNORES) {
  const rules = [];
  const add = (text, base = "") => {
    for (const line of Array.isArray(text) ? text : String(text).split(/\r?\n/)) {
      const rule = compileRule(line, base);
      if (rule) rules.push(rule);
    }
    return api;
  };
  const ignores = (path, isDir = false) => {
    let ignored = false;
    for (const rule of rules) if ((!rule.dirOnly || isDir) && rule.re.test(path)) ignored = !rule.negate;
    return ignored;
  };
  const api = { add, ignores, get size() { return rules.length; } };
  return add(lines);
}

// #endregion

// #region Folders

const notFound = path => new DOMException(`${path} was not found`, "NotFoundError");

async function readText(dir, name) {
  try { return await (await (await dir.getFileHandle(name)).getFile()).text(); } catch { return null; }
}

// The handle at path under dir: a file's, or with folder: true a folder's. create makes what's missing.
export async function handleAt(dir, path, { create = false, folder = false } = {}) {
  const parts = path.split("/").filter(Boolean);
  const name = folder ? null : parts.pop();
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
  return folder ? dir : dir.getFileHandle(name, { create });
}

// Every file under dir a project lists, with its size and time: .gitignore files at every level are read as the walk
// reaches them, and files over maxSize stay out. limit caps a huge folder.
export async function scanFolder(dir, { maxSize = MAX_FILE_SIZE, limit = 20_000, ignores = DEFAULT_IGNORES } = {}) {
  const rules = createIgnore(ignores);
  const files = new Map(), large = [];
  let ignored = 0, truncated = false;
  async function walk(dir, prefix) {
    const own = await readText(dir, ".gitignore");
    if (own != null) rules.add(own, prefix);
    const entries = [];
    for await (const entry of dir.entries()) entries.push(entry);
    entries.sort(([a], [b]) => (a < b ? -1 : 1));
    for (const [name, handle] of entries) {
      const path = prefix + name, isDir = handle.kind === "directory";
      if (rules.ignores(path, isDir)) { ignored++; continue; }
      if (isDir) { await walk(handle, path + "/"); continue; }
      if (files.size >= limit) { truncated = true; continue; }
      const file = await handle.getFile();
      if (file.size > maxSize) { large.push(path); continue; }
      files.set(path, { size: file.size, lastModified: file.lastModified });
    }
  }
  await walk(dir, "");
  return { files, rules, large, ignored, truncated };
}

// A path left out by a rule on it or on any folder above it.
export const excluded = (rules, path) => path.split("/").some((_, i, parts) => rules.ignores(parts.slice(0, i + 1).join("/"), i < parts.length - 1));

const looksBinary = bytes => bytes.subarray(0, 8000).includes(0);

// A folder on disk as a project's root. The listing comes at once; contents on first read. Writes go straight to
// disk. watch() follows the user's own edits: FileSystemObserver where there is one (an "unknown" or "errored"
// record, which means changes were missed, re-scans), else a scan every poll ms.
// onChange gets [{ path, type: "added" | "modified" | "removed" }], never for the root's own writes.
export function createFolderRoot(handle, { maxSize = MAX_FILE_SIZE, ignores = DEFAULT_IGNORES, poll = 1500, Observer = globalThis.FileSystemObserver, git = null } = {}) {
  let listing = new Map(), rules = createIgnore(ignores), stop = null, scanned = null, large = [];
  const written = new Map(); // path -> lastModified of the root's own write
  const listeners = new Set();

  async function scan() {
    const before = listing;
    const result = await scanFolder(handle, { maxSize, ignores });
    listing = result.files; rules = result.rules; large = result.large;
    const changes = [];
    for (const [path, meta] of listing) {
      const old = before.get(path);
      if (!old) changes.push({ path, type: "added" });
      else if (old.lastModified !== meta.lastModified || old.size !== meta.size) changes.push({ path, type: "modified" });
    }
    for (const path of before.keys()) if (!listing.has(path)) changes.push({ path, type: "removed" });
    return { changes: changes.filter(c => !(c.type !== "removed" && written.get(c.path) === listing.get(c.path)?.lastModified)), truncated: result.truncated };
  }

  const ready = () => (scanned ??= scan());

  async function read(path) {
    await ready();
    if (isBinaryPath(path)) return null;
    let file;
    try { file = await (await handleAt(handle, path)).getFile(); } catch { return null; }
    if (file.size > maxSize) return null;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (looksBinary(bytes)) return null;
    return new TextDecoder().decode(bytes);
  }

  async function write(path, text) {
    await ready();
    const file = await handleAt(handle, path, { create: true });
    const writable = await file.createWritable();
    await writable.write(text);
    await writable.close();
    const { lastModified, size } = await file.getFile();
    written.set(path, lastModified);
    listing.set(path, { size, lastModified });
  }

  async function remove(path) {
    const parts = path.split("/");
    const name = parts.pop();
    const dir = await handleAt(handle, parts.join("/"), { folder: true });
    await dir.removeEntry(name);
    listing.delete(path);
    written.delete(path);
  }

  // One change per path that the disk says moved since it was last seen.
  async function check(paths) {
    const changes = [];
    for (const path of new Set(paths)) {
      const file = await handleAt(handle, path).then(h => h.getFile(), () => null);
      const old = listing.get(path);
      if (!file) {
        if (old) { listing.delete(path); changes.push({ path, type: "removed" }); }
        continue;
      }
      if (file.size > maxSize || excluded(rules, path)) continue;
      const meta = { size: file.size, lastModified: file.lastModified };
      if (old && old.lastModified === meta.lastModified && old.size === meta.size) continue;
      listing.set(path, meta);
      if (written.get(path) === meta.lastModified) continue;
      changes.push({ path, type: old ? "modified" : "added" });
    }
    return changes;
  }

  const emit = changes => { if (changes.length) for (const fn of listeners) fn(changes); };
  let queue = Promise.resolve();
  const serial = fn => (queue = queue.then(fn).catch(e => console.warn("folder watch:", e)));

  // Records arrive in bursts (an editor's save is several); a burst is checked once.
  function watch(onChange) {
    listeners.add(onChange);
    if (stop) return () => listeners.delete(onChange);
    let pending = new Set(), rescan = false, timer = null;
    const flush = () => serial(async () => {
      timer = null;
      const paths = [...pending], full = rescan;
      pending = new Set(); rescan = false;
      emit(full ? (await scan()).changes : await check(paths));
    });
    const later = () => { timer ??= setTimeout(flush, 50); };
    if (Observer) {
      const observer = new Observer(records => {
        for (const r of records) {
          if (r.type === "unknown" || r.type === "errored") rescan = true;
          else if (r.changedHandle?.kind === "directory" && r.type !== "modified") rescan = true;
          else {
            const path = r.relativePathComponents.join("/");
            if (path && !excluded(rules, path)) pending.add(path);
            if (r.type === "moved" && r.relativePathMovedFrom) pending.add(r.relativePathMovedFrom.join("/"));
          }
        }
        later();
      });
      // An observer the browser refuses (a per-origin limit) falls back to polling.
      const polling = () => {
        const timer = setInterval(() => (globalThis.document?.visibilityState ?? "visible") === "visible" && serial(async () => emit((await scan()).changes)), poll);
        stop = () => clearInterval(timer);
      };
      stop = () => observer.disconnect();
      Promise.resolve(observer.observe(handle, { recursive: true })).catch(() => { observer.disconnect(); polling(); });
    } else {
      const timer = setInterval(() => (globalThis.document?.visibilityState ?? "visible") === "visible" && serial(async () => emit((await scan()).changes)), poll);
      stop = () => clearInterval(timer);
    }
    return () => listeners.delete(onChange);
  }

  function unwatch() {
    stop?.();
    stop = null;
    listeners.clear();
  }

  const root = {
    kind: "folder", name: handle.name, handle,
    ready, scan, read, write, remove, watch, unwatch,
    list: () => [...listing.keys()].sort(),
    has: path => listing.has(path),
    get large() { return large; },
    ignores: (path, isDir) => rules.ignores(path, isDir),
    excluded: path => excluded(rules, path),
    git: null,
  };
  root.git = git ? createFolderGit(handle, git, root) : null;
  return root;
}

// #endregion

// #region git on a folder

// node's fs.promises, as much of it as isomorphic-git uses, over a directory handle. Paths are absolute ("/.git/HEAD").
export function handleFs(root) {
  const fail = (code, path) => Object.assign(new Error(`${code}: ${path}`), { code });
  const parts = path => String(path).split("/").filter(p => p && p !== ".");
  async function parent(path, create = false) {
    const names = parts(path);
    const name = names.pop();
    let dir = root;
    try {
      for (const part of names) dir = await dir.getDirectoryHandle(part, { create });
    } catch (e) {
      throw fail(e.name === "TypeMismatchError" ? "ENOTDIR" : "ENOENT", path);
    }
    return { dir, name };
  }
  async function entry(path) {
    if (!parts(path).length) return root;
    const { dir, name } = await parent(path);
    try { return await dir.getFileHandle(name); } catch { /* a folder, or nothing */ }
    try { return await dir.getDirectoryHandle(name); } catch { throw fail("ENOENT", path); }
  }
  const encoding = options => (typeof options === "string" ? options : options?.encoding);
  // isomorphic-git compares times in whole seconds, so a same-size edit within the second would look unchanged
  // ("racy git"); the inode it also compares carries the milliseconds.
  const stats = (kind, size = 0, mtimeMs = 0) => ({
    type: kind === "file" ? "file" : "dir", mode: kind === "file" ? 0o100644 : 0o40000, size, ino: mtimeMs % 2 ** 32, mtimeMs, ctimeMs: mtimeMs,
    uid: 1, gid: 1, dev: 1, mtime: new Date(mtimeMs), ctime: new Date(mtimeMs),
    isFile: () => kind === "file", isDirectory: () => kind !== "file", isSymbolicLink: () => false,
  });
  const promises = {
    async readFile(path, options) {
      const handle = await entry(path);
      if (handle.kind !== "file") throw fail("EISDIR", path);
      const file = await handle.getFile();
      return encoding(options) === "utf8" ? file.text() : new Uint8Array(await file.arrayBuffer());
    },
    async writeFile(path, data, options) {
      const { dir, name } = await parent(path);
      const handle = await dir.getFileHandle(name, { create: true }).catch(e => { throw fail(e.name === "TypeMismatchError" ? "EISDIR" : "ENOENT", path); });
      const writable = await handle.createWritable();
      await writable.write(typeof data === "string" ? data : data instanceof Uint8Array ? data : new Uint8Array(data));
      await writable.close();
    },
    async unlink(path) {
      const { dir, name } = await parent(path);
      await dir.removeEntry(name).catch(() => { throw fail("ENOENT", path); });
    },
    async readdir(path) {
      const handle = await entry(path);
      if (handle.kind === "file") throw fail("ENOTDIR", path);
      const names = [];
      for await (const name of handle.keys()) names.push(name);
      return names;
    },
    async mkdir(path) {
      const { dir, name } = await parent(path);
      const exists = await dir.getDirectoryHandle(name).then(() => true, () => false);
      if (exists) throw fail("EEXIST", path);
      await dir.getDirectoryHandle(name, { create: true });
    },
    async rmdir(path) {
      const { dir, name } = await parent(path);
      await dir.removeEntry(name).catch(e => { throw fail(e.name === "InvalidModificationError" ? "ENOTEMPTY" : "ENOENT", path); });
    },
    async stat(path) {
      const handle = await entry(path);
      if (handle.kind !== "file") return stats("dir");
      const file = await handle.getFile();
      return stats("file", file.size, file.lastModified);
    },
    async lstat(path) { return promises.stat(path); },
    async readlink(path) { throw fail("ENOENT", path); },
    async symlink(_, path) { throw fail("EPERM", path); },
    async chmod() {},
  };
  return { promises };
}

// One file's change as git diff prints it. patch: the diff package's createTwoFilesPatch.
const gitPatch = (patch, path, before, after) => `diff --git a/${path} b/${path}\n` + patch(`a/${path}`, `b/${path}`, before, after).replace(/^=+\n/, "");

const NO_REMOTE ="isn't supported on a folder project: the browser can't reach a git server's protocol without a relay. Run it in your own terminal.";
const AGENT = { name: "Chat agent", email: "agent@chat.local" };

// git on the folder: isomorphic-git (loaded on first use) over handleFs. status, diff, log, branch, commit; push and
// pull are the user's own.
export function createFolderGit(handle, { load, patch }, root = null) {
  const fs = handleFs(handle);
  let module = null;
  const lib = async () => (module ??= await load());
  const at = { fs, dir: "/", gitdir: "/.git" };
  const present = () => handle.getDirectoryHandle(".git").then(() => true, () => false);

  async function guard() {
    if (!(await present())) throw new Error(`${handle.name} has no .git: it is not a git repository.`);
    return lib();
  }

  // One row per file that differs from HEAD or the index: { path, status, staged }.
  async function status() {
    const git = await guard();
    const rows = await git.statusMatrix({ ...at, filter: path => !root?.excluded?.(path) });
    const out = [];
    for (const [path, head, work, stage] of rows) {
      if (head === 1 && work === 1 && stage === 1) continue;
      const status = head === 0 ? (stage === 0 ? "untracked" : "added") : work === 0 ? "deleted" : work === 2 ? "modified" : stage === 0 ? "deleted" : "modified";
      out.push({ path, status, staged: stage === 2 || (head === 1 && stage === 0) || (head === 0 && stage !== 0) || stage === 3 });
    }
    return out;
  }

  async function headText(git, path) {
    try {
      const oid = await git.resolveRef({ ...at, ref: "HEAD" });
      const { blob } = await git.readBlob({ ...at, oid, filepath: path });
      return new TextDecoder().decode(blob);
    } catch {
      return "";
    }
  }

  // A unified diff of the working files against HEAD: one file, or every changed one.
  async function diff({ path = null } = {}) {
    const git = await guard();
    const changed = (await status()).filter(r => !path || r.path === path);
    const parts = [];
    for (const { path: p, status: s } of changed) {
      const before = s === "untracked" || s === "added" ? "" : await headText(git, p);
      const after = s === "deleted" ? "" : await fs.promises.readFile("/" + p, "utf8").catch(() => "");
      if (before !== after) parts.push(gitPatch(patch, p, before, after));
    }
    return parts.join("\n");
  }

  async function log({ depth = 20, ref = "HEAD" } = {}) {
    const git = await guard();
    const commits = await git.log({ ...at, ref, depth }).catch(e => (e.code === "NotFoundError" ? [] : Promise.reject(e)));
    return commits.map(({ oid, commit }) => ({ oid, message: commit.message.trim(), author: { name: commit.author.name, email: commit.author.email }, date: new Date(commit.author.timestamp * 1000).toISOString() }));
  }

  // The current branch and the others; name makes one (checkout: true switches to it, and the folder's files follow).
  async function branch({ name = null, checkout = false } = {}) {
    const git = await guard();
    if (name) {
      const exists = (await git.listBranches(at)).includes(name);
      if (!exists) await git.branch({ ...at, ref: name, checkout: false });
      if (checkout) { await git.checkout({ ...at, ref: name }); await root?.scan(); }
    }
    return { current: (await git.currentBranch({ ...at, fullname: false })) ?? null, branches: await git.listBranches(at) };
  }

  // Stages every change (git commit -a, new files too) or only paths, and commits. author: the repository's
  // user.name and user.email, else the agent's.
  async function commit({ message, author = null, paths = null } = {}) {
    if (!message?.trim()) throw new Error("A commit needs a message.");
    const git = await guard();
    const changed = (await status()).filter(r => !paths || paths.includes(r.path));
    if (!changed.length) throw new Error("Nothing to commit: the working files match HEAD.");
    for (const { path, status: s } of changed) {
      if (s === "deleted") await git.remove({ ...at, filepath: path });
      else await git.add({ ...at, filepath: path });
    }
    const name = await git.getConfig({ ...at, path: "user.name" }).catch(() => null);
    const email = await git.getConfig({ ...at, path: "user.email" }).catch(() => null);
    const oid = await git.commit({ ...at, message, author: author ?? (name ? { name, email: email ?? "" } : AGENT) });
    return { oid, message, files: changed.map(r => r.path) };
  }

  // A new repository in the folder, for a folder that has none.
  async function init({ branch: defaultBranch = "main" } = {}) {
    const git = await lib();
    await git.init({ ...at, defaultBranch });
    return { branch: defaultBranch };
  }

  return {
    kind: "folder", present, status, diff, log, branch, commit, init,
    push: async () => { throw new Error(`git push ${NO_REMOTE}`); },
    pull: async () => { throw new Error(`git pull ${NO_REMOTE}`); },
    openPullRequest: async () => { throw new Error("gh pr create needs a GitHub project: connect the repository in the sidebar."); },
  };
}

// #endregion

// #region GitHub

export const GITHUB_API = "https://api.github.com";
// GitHub's secondary limit on content creations (blobs, trees, commits, refs, pull requests).
export const CREATIONS_PER_MINUTE = 80;

export class RateLimitError extends Error {
  constructor(message, reset) {
    super(message);
    this.name = "RateLimitError";
    this.reset = reset;
  }
}

const clock = date => date.toLocaleTimeString("en-GB", { hour12: false });
const rateMessage = (what, reset) => `${what}: try again after ${clock(reset)} (in ${Math.max(1, Math.ceil((reset - Date.now()) / 1000))}s).`;

// The REST API with a token. Requests that create content are counted, so a push that would pass the minute's
// allowance fails before it starts, with the time it may go; a rate-limit answer says when the limit resets.
const creations = new Map(); // token -> times of its recent creations, shared by every client in this thread
export function createGitHubClient({ token = null, fetch: fetcher = (...args) => globalThis.fetch(...args), api = GITHUB_API, perMinute = CREATIONS_PER_MINUTE, now = () => Date.now() } = {}) {
  if (!creations.has(token)) creations.set(token, []);
  const created = creations.get(token);
  const recent = () => { while (created.length && now() - created[0] >= 60_000) created.shift(); return created.length; };

  function reserve(count) {
    if (recent() + count <= perMinute) return;
    const reset = new Date(created[Math.max(0, recent() + count - perMinute - 1)] + 60_000);
    throw new RateLimitError(rateMessage(`GitHub allows ${perMinute} content creations a minute and this needs ${count} (${recent()} made in the last minute)`, reset), reset);
  }

  let rate = null; // the last answer's { remaining, reset }: what a poller paces itself by
  async function request(method, path, body = undefined, { accept = "application/vnd.github+json", raw = false } = {}) {
    if (method !== "GET") { reserve(1); created.push(now()); }
    let response = await fetcher(path.startsWith("http") ? path : api + path, {
      method,
      headers: { Accept: accept, "X-GitHub-Api-Version": "2022-11-28", ...(token && { Authorization: `Bearer ${token}` }), ...(body !== undefined && { "Content-Type": "application/json" }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    // A redirect a fetch handed back (one that doesn't follow them): a job's log is at a storage URL, without the token.
    const location = response.status >= 300 && response.status < 400 ? response.headers?.get?.("location") : null;
    if (location && method === "GET") response = await fetcher(location);
    const header = name => response.headers?.get?.(name) ?? null;
    if (header("x-ratelimit-remaining") != null && header("x-ratelimit-reset") != null) rate = { remaining: +header("x-ratelimit-remaining"), reset: new Date(+header("x-ratelimit-reset") * 1000) };
    if (response.ok) return raw ? response : response.status === 204 ? null : response.json();
    const data = await response.json().catch(() => ({}));
    const message = data.message || response.statusText || `HTTP ${response.status}`;
    if ((response.status === 403 || response.status === 429) && (header("x-ratelimit-remaining") === "0" || header("retry-after") || /rate limit/i.test(message))) {
      const reset = header("retry-after") ? new Date(now() + +header("retry-after") * 1000) : header("x-ratelimit-reset") ? new Date(+header("x-ratelimit-reset") * 1000) : new Date(now() + 60_000);
      throw new RateLimitError(rateMessage(`GitHub's rate limit stopped ${method} ${path.replace(api, "")} (${message})`, reset), reset);
    }
    const detail = data.errors?.map(e => e.message || e.code).filter(Boolean).join("; ");
    throw Object.assign(new Error(`GitHub ${response.status} on ${method} ${path.replace(api, "")}: ${message}${detail ? ` (${detail})` : ""}`), { status: response.status });
  }

  return {
    request, reserve,
    get: (path, options) => request("GET", path, undefined, options),
    post: (path, body) => request("POST", path, body),
    patch: (path, body) => request("PATCH", path, body),
    creationsLeft: () => perMinute - recent(),
    rate: () => rate,
  };
}

const encodePath = path => path.split("/").map(encodeURIComponent).join("/");

// Git's name for a blob's content: sha1("blob <bytes>\0<content>").
export async function gitBlobSha(text) {
  const body = new TextEncoder().encode(text);
  const head = new TextEncoder().encode(`blob ${body.length}\0`);
  const all = new Uint8Array(head.length + body.length);
  all.set(head); all.set(body, head.length);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-1", all))].map(b => b.toString(16).padStart(2, "0")).join("");
}

// A branch's tip and its whole tree: what connecting and every push record as the base.
async function fetchBase(client, owner, repo, branch) {
  const tip = await client.get(`/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`);
  const commit = tip.commit.sha, tree = tip.commit.commit.tree.sha;
  const listing = await client.get(`/repos/${owner}/${repo}/git/trees/${tree}?recursive=1`);
  const files = {};
  for (const e of listing.tree) if (e.type === "blob") files[e.path] = [e.sha, e.size ?? 0, e.mode];
  return { commit, tree, files, truncated: !!listing.truncated };
}

// Connects a repository: { kind: "github", owner, repo, branch, from, defaultBranch, private, base: { commit, tree,
// files: { path: [sha, size, mode] } }, commits: [] }, the record a project keeps as its root.
export async function connectGitHub({ owner, repo, branch = null, token = null, fetch: fetcher } = {}) {
  if (!owner || !repo) throw new Error("Name the repository as owner/repo.");
  const client = createGitHubClient({ token, ...(fetcher && { fetch: fetcher }) });
  const info = await client.get(`/repos/${owner}/${repo}`);
  branch ||= info.default_branch;
  const base = await fetchBase(client, owner, repo, branch);
  return { kind: "github", owner, repo, branch, from: branch, defaultBranch: info.default_branch, private: !!info.private, base, commits: [] };
}

const DEFAULT_BRANCH = branch => `${branch} is the repository's default branch: pushing there needs the user's yes (confirmDefault: true). Push to a branch of its own and open a pull request instead.`;

// A connected repository as a project's root. record is the stored root; save(changes) stores changes to it.
// files() is the working copy: { path: text } for every file the journal holds (the rest are as the base has them).
// Local commits wait in record.commits until push turns them into commits on a branch. current(): the stored
// record now, when it can change under the root.
export function createGitHubRoot(record, { token = () => null, fetch: fetcher, patch, save = async () => {}, files: working = async () => ({}), current = null, perMinute = CREATIONS_PER_MINUTE, sleep, now } = {}) {
  let state = record;
  let client = null, clientToken;
  const github = () => {
    const t = typeof token === "function" ? token() : token;
    if (!client || clientToken !== t) { client = createGitHubClient({ token: t, perMinute, ...(fetcher && { fetch: fetcher }) }); clientToken = t; }
    return client;
  };
  const repoPath = () => `/repos/${state.owner}/${state.repo}`;
  const cache = new Map(); // blob sha -> text
  const update = async changes => { state = { ...state, ...changes }; await save(changes); return state; };

  async function blobText(sha, path) {
    if (cache.has(sha)) return cache.get(sha);
    let response;
    // A public repository's files come from raw.githubusercontent.com, which costs no API request.
    if (!state.private) response = await (fetcher ?? globalThis.fetch)(`https://raw.githubusercontent.com/${state.owner}/${state.repo}/${state.base.commit}/${encodePath(path)}`).catch(() => null);
    if (!response?.ok) response = await github().request("GET", `${repoPath()}/git/blobs/${sha}`, undefined, { accept: "application/vnd.github.raw+json", raw: true });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const text = looksBinary(bytes) ? null : new TextDecoder().decode(bytes);
    cache.set(sha, text);
    return text;
  }

  async function read(path) {
    const entry = state.base.files[path];
    if (!entry || isBinaryPath(path) || entry[1] > MAX_FILE_SIZE) return null;
    return blobText(entry[0], path);
  }

  const ignore = createIgnore(DEFAULT_IGNORES);
  const list = () => Object.entries(state.base.files).filter(([p, [, size]]) => size <= MAX_FILE_SIZE && !excluded(ignore, p)).map(([p]) => p).sort();

  // What differs between texts (the working copy, or a commit's snapshot) and the base: [{ path, status, sha }].
  async function changesAgainst(texts, against = state.base.files) {
    const out = [];
    for (const [path, text] of Object.entries(texts)) {
      if (text == null) { if (against[path]) out.push({ path, status: "deleted" }); continue; }
      const sha = await gitBlobSha(text);
      if (!against[path]) out.push({ path, status: "added", sha });
      else if (against[path][0] !== sha) out.push({ path, status: "modified", sha });
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  // The local commits' last snapshot, else the base: what the working copy is compared with for "uncommitted".
  const lastSnapshot = () => state.commits.at(-1)?.files ?? null;

  async function status() {
    const current = await working();
    const changed = await changesAgainst(current);
    const snapshot = lastSnapshot();
    const uncommitted = snapshot ? Object.keys(current).filter(p => current[p] !== (snapshot[p] ?? undefined)) : changed.map(c => c.path);
    return changed.map(c => ({ path: c.path, status: c.status, staged: !uncommitted.includes(c.path) }));
  }

  async function diff({ path = null } = {}) {
    const current = await working();
    const parts = [];
    for (const { path: p, status: s } of await changesAgainst(current)) {
      if (path && p !== path) continue;
      const before = s === "added" ? "" : (await read(p)) ?? "";
      parts.push(gitPatch(patch, p, before, current[p] ?? ""));
    }
    return parts.join("\n");
  }

  async function log({ depth = 20 } = {}) {
    const local = state.commits.map((c, i) => ({ oid: `local-${i + 1}`, message: c.message, author: { name: AGENT.name, email: AGENT.email }, date: new Date(c.at).toISOString(), local: true })).reverse();
    const remote = await github().get(`${repoPath()}/commits?sha=${state.base.commit}&per_page=${Math.min(depth, 100)}`);
    return [...local, ...remote.map(c => ({ oid: c.sha, message: c.commit.message.trim(), author: { name: c.commit.author?.name, email: c.commit.author?.email }, date: c.commit.author?.date }))].slice(0, depth);
  }

  // The branch the next push goes to; the base stays where it is.
  async function branch({ name = null } = {}) {
    if (name) await update({ branch: name });
    return { current: state.branch, from: state.from, defaultBranch: state.defaultBranch, base: state.base.commit };
  }

  // A local commit: the working copy as it is, under a message. push sends it.
  async function commit({ message } = {}) {
    if (!message?.trim()) throw new Error("A commit needs a message.");
    const current = await working();
    const snapshot = lastSnapshot() ?? {};
    const changed = (await changesAgainst(current, lastSnapshot() ? Object.fromEntries(await Promise.all(Object.entries(snapshot).map(async ([p, t]) => [p, [await gitBlobSha(t)]]))) : state.base.files));
    if (!changed.length) throw new Error("Nothing to commit: the files match the last commit.");
    const entry = { message: message.trim(), at: Date.now(), files: current };
    await update({ commits: [...state.commits, entry] });
    return { oid: `local-${state.commits.length}`, message: entry.message, files: changed.map(c => c.path) };
  }

  // Turns the local commits (and, with a message, the uncommitted changes) into commits on branch: one tree each,
  // with the files inline, on the base; then makes or moves the branch. Never the default branch without
  // confirmDefault. The pushed commit becomes the base.
  async function push({ branch: target = state.branch, message = null, confirmDefault = false } = {}) {
    if (!target) throw new Error("Name the branch to push to.");
    if (target === state.defaultBranch && !confirmDefault) throw new Error(DEFAULT_BRANCH(target));
    const current = await working();
    const commits = [...state.commits];
    const pending = await changesAgainst(current, commits.length ? Object.fromEntries(await Promise.all(Object.entries(commits.at(-1).files).map(async ([p, t]) => [p, [t == null ? null : await gitBlobSha(t)]]))) : state.base.files);
    if (pending.length && message?.trim()) commits.push({ message: message.trim(), at: Date.now(), files: current });
    if (!commits.length) throw new Error(pending.length ? "The changes aren't committed: commit them, or push with a message." : "Nothing to push: the files match the base.");
    const client = github();
    // Each commit costs a tree and a commit; the branch, one more. Checked before the first, so a push never stops halfway.
    client.reserve(commits.length * 2 + 1);
    let parent = state.base.commit, tree = state.base.tree, previous = state.base.files;
    for (const c of commits) {
      const changed = await changesAgainst(c.files, previous);
      if (!changed.length) continue;
      const entries = changed.map(({ path, status: s }) => s === "deleted"
        ? { path, mode: "100644", type: "blob", sha: null }
        : { path, mode: state.base.files[path]?.[2] ?? "100644", type: "blob", content: c.files[path] });
      tree = (await client.post(`${repoPath()}/git/trees`, { base_tree: tree, tree: entries })).sha;
      parent = (await client.post(`${repoPath()}/git/commits`, { message: c.message, tree, parents: [parent] })).sha;
      previous = { ...previous };
      for (const ch of changed) { if (ch.status === "deleted") delete previous[ch.path]; else previous[ch.path] = [ch.sha, c.files[ch.path].length, previous[ch.path]?.[2] ?? "100644"]; }
    }
    if (parent === state.base.commit) throw new Error("Nothing to push: the commits change nothing.");
    const ref = `${repoPath()}/git/refs/heads/${encodePath(target)}`;
    const existing = await client.get(`${repoPath()}/git/ref/heads/${encodePath(target)}`).catch(e => (e.status === 404 ? null : Promise.reject(e)));
    if (existing) {
      await client.patch(ref, { sha: parent, force: false }).catch(e => {
        throw e.status === 422 ? new Error(`${target} has commits the base (${state.base.commit.slice(0, 7)}) lacks: push to a new branch, or reconnect to start from its tip.`) : e;
      });
    } else await client.post(`${repoPath()}/git/refs`, { ref: `refs/heads/${target}`, sha: parent });
    await update({ branch: target, commits: [], base: { ...state.base, commit: parent, tree, files: previous } });
    return { branch: target, commit: parent, commits: commits.length, url: `https://github.com/${state.owner}/${state.repo}/tree/${encodePath(target)}` };
  }

  // A pull request from the pushed branch into the branch the project came from (or base).
  async function openPullRequest({ title, body = "", base = null, draft = false } = {}) {
    if (!title?.trim()) throw new Error("A pull request needs a title.");
    const into = base || state.from || state.defaultBranch;
    if (state.branch === into) throw new Error(`The work is on ${into} itself: push it to a branch of its own first.`);
    const pr = await github().post(`${repoPath()}/pulls`, { title: title.trim(), body, head: state.branch, base: into, draft });
    await update({ pullRequest: { number: pr.number, url: pr.html_url } });
    return { number: pr.number, url: pr.html_url };
  }

  // Each call starts from the stored record, which another workspace's push may have moved.
  const fresh = fn => (...args) => { if (current) state = current() ?? state; return fn(...args); };
  return {
    kind: "github", name: `${state.owner}/${state.repo}`,
    get record() { return state; },
    ready: async () => {}, scan: async () => ({ changes: [] }), read: fresh(read), list: fresh(list), has: fresh(path => !!state.base.files[path]),
    write: async () => {}, remove: async () => {}, watch: () => () => {}, unwatch: () => {},
    ignores: path => ignore.ignores(path), excluded: path => excluded(ignore, path),
    git: {
      kind: "github", present: async () => true,
      status: fresh(status), diff: fresh(diff), log: fresh(log), branch: fresh(branch), commit: fresh(commit), push: fresh(push), openPullRequest: fresh(openPullRequest),
      pull: async () => { throw new Error("git pull isn't supported on a GitHub project yet: reconnect the repository to start from its tip."); },
      ci: Object.fromEntries(Object.entries(createGitHubCI({ client: github, repo: () => state, sleep, now })).map(([k, fn]) => [k, fresh(fn)])),
    },
  };
}

// #endregion

// #region CI

// What a check run's or a commit status's outcome counts as, as gh pr checks buckets them.
export function checkBucket({ status = "completed", conclusion = null, state = null } = {}) {
  if (state) return state === "success" ? "pass" : state === "pending" ? "pending" : "fail"; // a commit status
  if (status !== "completed") return "pending";
  if (conclusion === "success") return "pass";
  if (conclusion === "skipped" || conclusion === "neutral") return "skipping";
  if (["failure", "cancelled", "timed_out", "action_required", "startup_failure"].includes(conclusion)) return "fail";
  return "pending"; // stale, or none yet
}

// The whole: pending while any check is, then failure if any failed, success if any passed, else neutral (none, or
// all skipped).
export function checksState(items) {
  const buckets = items.map(checkBucket);
  return buckets.includes("pending") ? "pending" : buckets.includes("fail") ? "failure" : buckets.includes("pass") ? "success" : "neutral";
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const STAMP = /^\uFEFF?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z ?/;
// Lines worth keeping from anywhere in a failed job's log: the runner's errors, TAP's and test runners' failures,
// assertion messages and the first lines of a stack.
const MARKER = /##\[error\]|^\s*not ok\b|\bFAIL(ED)?\b|✖|✗|×|\b\w*Error\b:|\bAssertionError\b|\bexpected\b.*\b(to|but|got|received)\b|^\s*(actual|expected):|^\s*[-+] |^\s+at\s/;
const STEP_START = /^##\[group\]Run |^Post job cleanup\.|^Cleaning up orphan processes/;

// A failed job's log, short: its timestamps and colors gone, the lines with error markers from anywhere, then the
// tail of the step that failed (the section around the first ##[error]). maxChars bounds the whole.
export function failedLogExcerpt(text, { maxChars = 8000, tailLines = 40 } = {}) {
  const lines = String(text ?? "").split(/\r?\n/).map(l => l.replace(STAMP, "").replace(ANSI, "").replace(/\s+$/, ""));
  const firstError = lines.findIndex(l => l.startsWith("##[error]"));
  let from = 0, to = lines.length;
  if (firstError >= 0) {
    for (let i = firstError; i >= 0; i--) if (/^##\[group\]Run /.test(lines[i])) { from = i; break; }
    for (let i = firstError + 1; i < lines.length; i++) if (STEP_START.test(lines[i])) { to = i; break; }
  }
  // The step's command echo (between its group lines) says nothing a reader needs: keep its first line.
  const step = lines.slice(from, to);
  const echoEnd = /^##\[group\]Run /.test(step[0] ?? "") ? step.indexOf("##[endgroup]") : -1;
  const section = echoEnd > 0 ? [step[0].replace("##[group]", ""), ...step.slice(echoEnd + 1)] : step;
  const marked = [];
  let stack = 0;
  const keep = l => {
    if (/^\s+at\s/.test(l)) { if (++stack > 3) return; } else stack = 0;
    if (marked.at(-1) !== l) marked.push(l);
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || !MARKER.test(l) || /^##\[(group|endgroup)\]/.test(l)) { stack = 0; continue; }
    keep(l);
    // A failed TAP test (node --test): its YAML block says what was expected and where, without the timings.
    if (/^\s*not ok\b/.test(l) && /^\s*---$/.test(lines[i + 1] ?? "")) {
      let j = i + 2, kept = 0;
      for (; j < lines.length && !/^\s*\.\.\.$/.test(lines[j]); j++)
        if (!/^\s*(duration_ms|type|failureType|exitCode|signal):/.test(lines[j]) && kept++ < 16) keep(lines[j]);
      i = j;
    }
  }
  // With the failures found, the step's last lines are its summary; without, they are all there is to go on.
  const found = marked.some(l => !l.startsWith("##[error]"));
  const tail = section.filter(l => !/^\s*(duration_ms|type):|^# duration_ms/.test(l)).slice(-(found ? Math.min(tailLines, 12) : tailLines));
  const tailSet = new Set(tail);
  const markedText = marked.filter(l => !tailSet.has(l)).join("\n").trim();
  const clipEnd = (s, n) => (s.length <= n ? s : "…\n" + s.slice(s.length - n + 2).replace(/^[^\n]*\n/, ""));
  const clipStart = (s, n) => (s.length <= n ? s : s.slice(0, n - 2).replace(/\n[^\n]*$/, "") + "\n…");
  const tailText = tail.join("\n").trim();
  if (!markedText) return clipEnd(tailText, maxChars);
  const budget = Math.max(0, maxChars - Math.min(tailText.length, Math.ceil(maxChars * 0.6)) - 1);
  const head = clipStart(markedText, budget);
  return head ? `${head}\n${clipEnd(tailText, maxChars - head.length - 1)}` : clipEnd(tailText, maxChars);
}

const defaultSleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
  const t = setTimeout(() => { signal?.removeEventListener?.("abort", stop); resolve(); }, Math.max(0, ms));
  const stop = () => { clearTimeout(t); reject(signal.reason ?? new Error("aborted")); };
  signal?.addEventListener?.("abort", stop, { once: true });
});

// A repository's CI, read through the REST API (every endpoint here answers cross-origin, and a job's log redirects
// to storage that does too): check runs and commit statuses for a commit, workflow runs and their jobs, a failed
// job's log, and waiting for it all to finish. client(): createGitHubClient's; repo(): { owner, repo, branch, base }.
export function createGitHubCI({ client, repo, sleep = defaultSleep, now = () => Date.now() }) {
  const path = () => `/repos/${repo().owner}/${repo().repo}`;
  const get = (p, options) => client().get(path() + p, options);
  const enc = s => encodeURIComponent(s);

  const hasWorkflows = () => Object.keys(repo().base?.files ?? {}).some(p => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p));

  // The commit a branch is at; with neither, the project's own (the last push, or where it was connected).
  async function resolveSha({ sha = null, branch = null } = {}) {
    if (sha) return sha;
    if (branch) return (await get(`/branches/${enc(branch)}`)).commit.sha;
    return repo().base.commit;
  }

  const ids = url => {
    const m = /\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/.exec(url ?? "");
    return { runId: m ? +m[1] : null, jobId: m?.[2] ? +m[2] : null };
  };
  const toRun = c => ({
    id: c.id, name: c.name, status: c.status, conclusion: c.conclusion, url: c.html_url || c.details_url,
    title: c.output?.title ?? "", summary: c.output?.summary ?? "", annotationsCount: c.output?.annotations_count ?? 0, annotations: [],
    app: c.app?.slug ?? null, startedAt: c.started_at ?? null, completedAt: c.completed_at ?? null, ...ids(c.details_url || c.html_url),
  });

  async function annotate(runs) {
    await Promise.all(runs.filter(r => checkBucket(r) === "fail" && r.annotationsCount > 0).map(async r => {
      const list = await get(`/check-runs/${r.id}/annotations?per_page=50`).catch(() => []);
      r.annotations = list.map(a => ({ path: a.path, line: a.start_line ?? null, message: a.message, level: a.annotation_level, title: a.title ?? "" }));
    }));
    return runs;
  }

  // { sha, state, total, runs: [{ name, status, conclusion, url, summary, annotations }], statuses: [{ name, state,
  // description, url }] }: the commit's check runs (annotations for the failed ones) and its combined status.
  async function checks({ sha = null, branch = null, annotations = true } = {}) {
    const at = await resolveSha({ sha, branch });
    const [checkRuns, combined] = await Promise.all([get(`/commits/${at}/check-runs?per_page=100`), get(`/commits/${at}/status`)]);
    const runs = (checkRuns.check_runs ?? []).map(toRun).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (annotations) await annotate(runs);
    // A commit with no statuses has a combined state of "pending": only the statuses themselves count.
    const statuses = (combined.statuses ?? []).map(s => ({ name: s.context, state: s.state, description: s.description ?? "", url: s.target_url ?? null }));
    return { sha: at, state: checksState([...runs, ...statuses]), total: runs.length + statuses.length, runs, statuses };
  }

  const toWorkflowRun = r => ({
    id: r.id, name: r.name, title: r.display_title ?? r.head_commit?.message?.split("\n")[0] ?? "", status: r.status, conclusion: r.conclusion,
    branch: r.head_branch, sha: r.head_sha, event: r.event, url: r.html_url, attempt: r.run_attempt ?? 1,
    createdAt: r.created_at, updatedAt: r.updated_at, startedAt: r.run_started_at ?? r.created_at,
  });
  async function runs({ branch = null, sha = null, limit = 20 } = {}) {
    const q = new URLSearchParams({ per_page: String(Math.min(100, Math.max(1, limit))) });
    if (branch) q.set("branch", branch);
    if (sha) q.set("head_sha", sha);
    return ((await get(`/actions/runs?${q}`)).workflow_runs ?? []).slice(0, limit).map(toWorkflowRun);
  }
  const run = async id => toWorkflowRun(await get(`/actions/runs/${id}`));

  const toJob = j => ({
    id: j.id, runId: j.run_id, name: j.name, status: j.status, conclusion: j.conclusion, url: j.html_url, startedAt: j.started_at, completedAt: j.completed_at,
    steps: (j.steps ?? []).map(s => ({ number: s.number, name: s.name, status: s.status, conclusion: s.conclusion })),
  });
  const jobs = async runId => ((await get(`/actions/runs/${runId}/jobs?per_page=100`)).jobs ?? []).map(toJob);

  // The failed jobs' logs of a run (or one job's: { job: id }), each as failedLogExcerpt keeps it, under a line
  // naming the job and the step that failed. A bare id is a run's, else a job's.
  async function failedLog(target, { maxChars = 8000 } = {}) {
    let failed;
    if (target && typeof target === "object" && target.job != null) failed = [toJob(await get(`/actions/jobs/${target.job}`))];
    else {
      const id = typeof target === "object" ? target.run : target;
      try { failed = (await jobs(id)).filter(j => checkBucket(j) === "fail"); }
      catch (e) {
        if (e.status !== 404 || typeof target === "object") throw e;
        failed = [toJob(await get(`/actions/jobs/${id}`))];
      }
    }
    if (!failed.length) return "";
    const each = Math.max(500, Math.floor(maxChars / failed.length) - 80);
    const parts = [];
    for (const j of failed) {
      const step = j.steps.find(s => s.conclusion === "failure")?.name;
      const head = `${j.name}${step ? ` › ${step}` : ""} (${j.conclusion ?? j.status})`;
      let text;
      try {
        // 302 to a storage URL that sends Access-Control-Allow-Origin: *; fetch follows it, dropping the token.
        const response = await client().request("GET", `${path()}/actions/jobs/${j.id}/logs`, undefined, { raw: true, accept: "application/vnd.github+json" });
        text = failedLogExcerpt(await response.text(), { maxChars: each });
      } catch (e) {
        text = e.status === 404 || e.status === 410 ? "(the log isn't available: it may have expired, or the job hasn't finished)" : `(the log couldn't be read: ${e.message})`;
      }
      parts.push(`${head}\n${text}`);
    }
    const all = parts.join("\n\n");
    return all.length <= maxChars ? all : all.slice(0, maxChars - 2) + "\n…";
  }

  // Polls until done(value) or the time is up. The interval stretches while nothing changes (to 60 s) and when the
  // hour's allowance runs low; a rate-limit answer waits for its reset when that comes before the deadline.
  async function poll(read, { done, key = v => JSON.stringify(v), timeoutMs, pollMs, onUpdate = null, signal = null }) {
    const start = now(), deadline = start + timeoutMs;
    let wait = pollMs, last;
    for (;;) {
      let value;
      try { value = await read(); }
      catch (e) {
        if (!(e instanceof RateLimitError) || +e.reset + 1000 > deadline) throw e;
        await sleep(+e.reset - now() + 1000, signal);
        continue;
      }
      const k = key(value);
      if (k !== last) { last = k; wait = pollMs; onUpdate?.(value); } else wait = Math.min(Math.max(wait, Math.round(wait * 1.5)), Math.max(pollMs, 60_000));
      if (done(value, now() - start)) return value;
      const rate = client().rate?.();
      if (rate && rate.remaining < 50) wait = Math.max(wait, rate.remaining > 0 ? (+rate.reset - now()) / rate.remaining : +rate.reset - now() + 1000);
      if (now() + wait > deadline) return { ...value, timedOut: true };
      await sleep(wait, signal);
    }
  }

  // Resolves when no check on the commit is queued or in progress (or, failFast, when one fails), with checks()'s
  // answer; timedOut: true when the time ran out first. Right after a push GitHub may take a while to register the
  // checks: on a repository with workflows, none yet keeps waiting for graceMs.
  async function waitForChecks({ sha = null, branch = null, timeoutMs = 15 * 60_000, pollMs = 10_000, graceMs = 120_000, failFast = false, onUpdate = null, signal = null } = {}) {
    const at = await resolveSha({ sha, branch });
    const workflows = hasWorkflows();
    const result = await poll(() => checks({ sha: at, annotations: false }), {
      timeoutMs, pollMs, onUpdate, signal,
      key: c => JSON.stringify([...c.runs.map(r => [r.name, r.status, r.conclusion]), ...c.statuses.map(s => [s.name, s.state])]),
      done: (c, elapsed) => (c.state !== "pending" && (c.total > 0 || !workflows || elapsed >= graceMs)) || (failFast && [...c.runs, ...c.statuses].some(r => checkBucket(r) === "fail")),
    });
    await annotate(result.runs);
    return result;
  }

  // Resolves when the workflow run completes, with run()'s answer (timedOut: true when the time ran out first).
  const waitForRun = (id, { timeoutMs = 15 * 60_000, pollMs = 10_000, onUpdate = null, signal = null } = {}) =>
    poll(() => run(id), { timeoutMs, pollMs, onUpdate, signal, key: r => `${r.status}:${r.conclusion}`, done: r => r.status === "completed" });

  // The open pull request from a branch (the project's by default), or the one numbered: { number, url, title,
  // headSha, headRef, state }, or null.
  async function pullRequest({ number = null, branch = null } = {}) {
    const pr = number != null ? await get(`/pulls/${number}`)
      : (await get(`/pulls?head=${enc(`${repo().owner}:${branch ?? repo().branch}`)}&state=open&per_page=1`))[0];
    return pr ? { number: pr.number, url: pr.html_url, title: pr.title, headSha: pr.head.sha, headRef: pr.head.ref, state: pr.state } : null;
  }

  return { hasWorkflows, checks, runs, run, jobs, failedLog, waitForChecks, waitForRun, pullRequest };
}

// #endregion

// #region In memory

// The File System Access API's directory handle, in memory: tests use it as a folder, and a workspace can mount it
// where a real one would go. lastModified moves on with every write, as a disk's does. Observers registered with
// MemoryObserver hear every change, as FileSystemObserver reports them.
let tick = Date.now();
const memoryDirectories = new Map(); // id -> handle, so a project record can name one (handles of its own don't clone)

class MemoryNode {
  constructor(kind, name, parent = null) {
    Object.assign(this, { kind, name, parent, children: kind === "directory" ? new Map() : null, data: new Uint8Array(), lastModified: ++tick });
  }
  path() { const parts = []; for (let n = this; n.parent; n = n.parent) parts.unshift(n.name); return parts; }
  top() { let n = this; while (n.parent) n = n.parent; return n; }
}

function notify(node, type, extra = {}) {
  const top = node.top();
  for (const observer of top.observers ?? []) observer.record({ type, relativePathComponents: node.path(), changedHandle: wrap(node), root: wrap(top), ...extra });
}

const toBytes = async data => {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (data?.type === "write") return toBytes(data.data);
  throw new TypeError("Unsupported data");
};

const handles = new WeakMap();
function wrap(node) {
  if (handles.has(node)) return handles.get(node);
  const handle = node.kind === "file" ? new MemoryFileHandle(node) : new MemoryDirectoryHandle(node);
  handles.set(node, handle);
  return handle;
}

class MemoryHandle {
  #node;
  constructor(node) { this.#node = node; }
  get node() { return this.#node; }
  get kind() { return this.#node.kind; }
  get name() { return this.#node.name; }
  async isSameEntry(other) { return other?.node === this.#node; }
  async queryPermission() { return this.#node.top().permission ?? "granted"; }
  async requestPermission() { const top = this.#node.top(); if (top.permission === "prompt") top.permission = top.grant ?? "granted"; return top.permission ?? "granted"; }
}

class MemoryFileHandle extends MemoryHandle {
  async getFile() { return new File([this.node.data], this.name, { lastModified: this.node.lastModified }); }
  async createWritable() {
    const node = this.node, chunks = [];
    return {
      write: async data => { chunks.push(await toBytes(data)); },
      truncate: async () => {},
      close: async () => {
        const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let at = 0;
        for (const c of chunks) { all.set(c, at); at += c.length; }
        node.data = all;
        node.lastModified = ++tick;
        notify(node, "modified");
      },
    };
  }
}

class MemoryDirectoryHandle extends MemoryHandle {
  get id() { return this.node.top().id; }
  #child(name, kind, create) {
    if (!name || name.includes("/") || name === "." || name === "..") throw new TypeError(`Invalid name: ${name}`);
    let child = this.node.children.get(name);
    if (child && child.kind !== kind) throw new DOMException(`${name} is a ${child.kind}`, "TypeMismatchError");
    if (!child) {
      if (!create) throw notFound(name);
      child = new MemoryNode(kind, name, this.node);
      this.node.children.set(name, child);
      notify(child, "appeared");
    }
    return wrap(child);
  }
  async getFileHandle(name, { create = false } = {}) { return this.#child(name, "file", create); }
  async getDirectoryHandle(name, { create = false } = {}) { return this.#child(name, "directory", create); }
  async removeEntry(name, { recursive = false } = {}) {
    const child = this.node.children.get(name);
    if (!child) throw notFound(name);
    if (child.kind === "directory" && child.children.size && !recursive) throw new DOMException(`${name} is not empty`, "InvalidModificationError");
    notify(child, "disappeared");
    this.node.children.delete(name);
  }
  async resolve(other) {
    const path = other?.node?.path(), mine = this.node.path();
    return path && mine.every((p, i) => path[i] === p) && other.node.top() === this.node.top() ? path.slice(mine.length) : null;
  }
  async *entries() { for (const [name, node] of [...this.node.children]) yield [name, wrap(node)]; }
  async *keys() { for (const name of [...this.node.children.keys()]) yield name; }
  async *values() { for (const node of [...this.node.children.values()]) yield wrap(node); }
  [Symbol.asyncIterator]() { return this.entries(); }
}

// files: { "src/a.js": "text" }. permission: "granted" | "prompt" | "denied", as queryPermission answers.
export async function memoryDirectory(name = "folder", files = {}, { permission = "granted" } = {}) {
  const top = new MemoryNode("directory", name);
  top.id = "mem-" + Math.random().toString(36).slice(2, 10);
  top.permission = permission;
  top.observers = new Set();
  const handle = wrap(top);
  for (const [path, text] of Object.entries(files)) {
    const file = await handleAt(handle, path, { create: true });
    const w = await file.createWritable();
    await w.write(text);
    await w.close();
  }
  memoryDirectories.set(top.id, handle);
  return handle;
}

export const isMemoryDirectory = handle => handle instanceof MemoryDirectoryHandle;
// What a project record keeps for a handle: the handle itself, which IndexedDB stores, or a memory one's id.
export const storableHandle = handle => (isMemoryDirectory(handle) ? { memory: handle.id, name: handle.name } : handle);
export const liveHandle = stored => (stored?.memory ? memoryDirectories.get(stored.memory) ?? null : stored);

// FileSystemObserver's shape, for memory directories. records() delivers in a microtask, as the real one batches.
export class MemoryObserver {
  #callback; #roots = new Set(); #queue = [];
  constructor(callback) { this.#callback = callback; }
  async observe(handle, { recursive = false } = {}) {
    const top = handle.node.top();
    this.recursive = recursive;
    top.observers.add(this);
    this.#roots.add(top);
  }
  record(record) {
    if (!this.#queue.length) queueMicrotask(() => { const batch = this.#queue.splice(0); if (batch.length) this.#callback(batch, this); });
    this.#queue.push(record);
  }
  disconnect() { for (const top of this.#roots) top.observers.delete(this); this.#roots.clear(); }
  // The browser's way of saying records were lost: the observer should re-scan.
  static lose(handle, type = "unknown") { const top = handle.node.top(); for (const o of top.observers) o.record({ type, relativePathComponents: [], changedHandle: null, root: wrap(top) }); }
}

// #endregion
