// git for the shell: isomorphic-git over the shell's files, with jsdiff for diffs. clone, fetch, pull and push go
// through the tab's fetch, so they reach GitHub only through the local proxy (GitHub sends no CORS headers).
const GIT = "https://esm.sh/isomorphic-git@1.44.2";
const DIFF = "https://esm.sh/diff@8.0.4";
const td = new TextDecoder();
const SKIP = /(^|\/)(node_modules|__pycache__|\.pytest_cache)(\/|$)/;

// isomorphic-git's fs over the shell's.
function gitFs(vfs) {
  const wrap = fn => async (...a) => {
    try { return await fn(...a); } catch (e) {
      const m = String(e?.message ?? e);
      e.code ??= /ENOENT|no such file/i.test(m) ? "ENOENT" : /EEXIST|exists/i.test(m) ? "EEXIST" : /ENOTDIR|not a directory/i.test(m) ? "ENOTDIR" : /ENOTEMPTY|not empty/i.test(m) ? "ENOTEMPTY" : /EISDIR|is a directory/i.test(m) ? "EISDIR" : undefined;
      throw e;
    }
  };
  // isomorphic-git takes a file as unchanged when its size and mtime in whole seconds match the index: two edits
  // of one size in a second (a = 2, then a = 3) looked clean. The millisecond mtime as the inode tells them apart.
  const stat = s => ({ ...s, isFile: () => s.isFile, isDirectory: () => s.isDirectory, isSymbolicLink: () => s.isSymbolicLink, mode: (s.isDirectory ? 0o040000 : s.isSymbolicLink ? 0o120000 : 0o100000) | ((s.mode ?? 0o644) & 0o777), size: s.size ?? 0, mtimeMs: +s.mtime, ctimeMs: +s.mtime, uid: 1, gid: 1, dev: 1, ino: (+s.mtime % 2147483647) || 1 });
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

// The project as it was when the user's message arrived, committed with that tree and index, so git diff and git
// status show what changed since. The working files are untouched: the tree is built in a scratch directory. A
// repository the agent made itself (no marker) is left alone. Returns the commit's oid, or null for none.
export async function baselineCommit(vfs, root, { files, message }) {
  const git = (await import(GIT)).default;
  const fs = gitFs(vfs), gitdir = root + "/.git", marker = gitdir + "/chat-baseline";
  if (await vfs.exists(gitdir)) { if (!(await vfs.exists(marker))) return null; }
  else { await git.init({ fs, dir: root, defaultBranch: "main" }); await vfs.writeFile(marker, "made by the chat\n"); }
  const scratch = "/tmp/.baseline-" + Date.now();
  try {
    await vfs.mkdir(scratch, { recursive: true });
    for (const [rel, text] of Object.entries(files)) {
      const p = scratch + "/" + rel;
      await vfs.mkdir(p.slice(0, p.lastIndexOf("/")), { recursive: true });
      await vfs.writeFile(p, text);
    }
    const g = { fs, dir: scratch, gitdir };
    let changed = false;
    for (const [filepath, headState, workState, stageState] of await git.statusMatrix(g)) {
      if (workState === 0) { if (stageState !== 0) await git.remove({ ...g, filepath }); }
      else await git.add({ ...g, filepath });
      if (headState !== 1 || workState !== 1 || stageState !== 1) changed = true;
    }
    const head = await git.resolveRef({ ...g, ref: "HEAD" }).catch(() => null);
    if (!changed && head) return null;
    if (!Object.keys(files).length && !head) return null;
    const oid = await git.commit({ ...g, message, author: { name: "chat", email: "chat@localhost" } });
    // The index took its stat cache from the scratch files: reset it against the working copy, so a file whose
    // size and time match by chance is still read.
    for (const filepath of Object.keys(files)) await git.resetIndex({ fs, dir: root, gitdir, filepath });
    return oid;
  } finally {
    await vfs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

export function gitCommand({ defineCommand, result, fetchVia, ROOT }) {
  let git = null, jsdiff = null;

  const http = {
    async request({ url, method = "GET", headers = {}, body }) {
      let bytes;
      if (body) {
        const chunks = [];
        for await (const c of body) chunks.push(c);
        bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let o = 0;
        for (const c of chunks) { bytes.set(c, o); o += c.length; }
      }
      const r = await fetchVia({ url, method, headers, body: bytes });
      return { url: r.url || url, method, statusCode: r.status, statusMessage: r.statusText, headers: Object.fromEntries(r.headers.map(([k, v]) => [k.toLowerCase(), v])), body: [new Uint8Array(r.body ?? [])] };
    },
  };

  const flag = (args, ...names) => names.some(n => args.includes(n));
  const valueOf = (args, ...names) => { for (const n of names) { const i = args.indexOf(n); if (i >= 0) return args[i + 1]; const eq = args.find(a => a.startsWith(n + "=")); if (eq) return eq.slice(n.length + 1); } return null; };
  const positional = (args, withValues = []) => args.filter((a, i) => !a.startsWith("-") && !withValues.includes(args[i - 1]));

  return defineCommand("git", async (args, ctx) => {
    git ??= (await import(GIT)).default;
    const fs = gitFs(ctx.fs);
    // Global options before the command: -C dir (models write git -C /project ...), -c name=value, --no-pager.
    for (;;) {
      if (args[0] === "-C" && args[1]) { ctx = { ...ctx, cwd: ctx.fs.resolvePath(ctx.cwd, args[1]) }; args = args.slice(2); }
      else if (args[0] === "-c" && args[1]) args = args.slice(2);
      else if (args[0] === "--no-pager" || args[0] === "-P") args = args.slice(1);
      else break;
    }
    const [cmd, ...rest] = args;
    const findRoot = async () => { try { return await git.findRoot({ fs, filepath: ctx.cwd }); } catch { return null; } };
    const env = k => ctx.env.get(k);
    const token = env("GIT_TOKEN") ?? env("GITHUB_TOKEN") ?? env("GH_TOKEN");
    const onAuth = () => (token ? { username: "x-access-token", password: token } : { cancel: true });
    const net = { http, onAuth, onAuthFailure: () => ({ cancel: true }) };
    const netError = (e, url) => {
      const m = String(e?.message ?? e);
      const hint = /CORS|Failed to fetch|NetworkError/i.test(m) ? "\nhint: git reaches remotes only through the local proxy (npm run start:proxy); GitHub sends no CORS headers." : /401|403|auth/i.test(m) ? "\nhint: set GIT_TOKEN (a token with access) to push or read a private repository." : "";
      return result("", `fatal: unable to access '${url ?? "the remote"}': ${m}${hint}\n`, 128);
    };
    if (cmd === "--version" || cmd === "version") return result("git version 2.47.0 (isomorphic-git 1.44.2)\n");
    if (!cmd || cmd === "help") return result("usage: git <command>\n\nThis shell has: init, clone, status, add, rm, commit, log, diff, show, stash, branch, checkout, switch, restore, reset, merge, tag, remote, fetch, pull, push, config, rev-parse\n");

    if (cmd === "clone") {
      const [url, target] = positional(rest, ["--depth", "-b", "--branch"]);
      if (!url) return result("", "fatal: You must specify a repository to clone.\n", 128);
      const dir = ctx.fs.resolvePath(ctx.cwd, target ?? url.replace(/\/+$/, "").split("/").pop().replace(/\.git$/, ""));
      if ((await ctx.fs.exists(dir)) && (await ctx.fs.readdir(dir)).length) return result("", `fatal: destination path '${target ?? dir}' already exists and is not an empty directory.\n`, 128);
      const depth = valueOf(rest, "--depth");
      try {
        await git.clone({ fs, dir, url, ...net, singleBranch: true, ...(depth && { depth: +depth }), ...(valueOf(rest, "-b", "--branch") && { ref: valueOf(rest, "-b", "--branch") }) });
        return result("", `Cloning into '${dir.split("/").pop()}'...\ndone.\n`, 0);
      } catch (e) {
        await ctx.fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        return netError(e, url);
      }
    }
    const dir = cmd === "init" ? ctx.fs.resolvePath(ctx.cwd, positional(rest, ["-b", "--initial-branch"])[0] ?? ".") : await findRoot();
    if (!dir) return result("", "fatal: not a git repository (or any of the parent directories): .git\n", 128);
    const g = { fs, dir };
    const author = async () => ({
      name: env("GIT_AUTHOR_NAME") ?? (await git.getConfig({ ...g, path: "user.name" })) ?? "agent",
      email: env("GIT_AUTHOR_EMAIL") ?? (await git.getConfig({ ...g, path: "user.email" })) ?? "agent@localhost",
    });
    const matrix = () => git.statusMatrix({ ...g, filter: f => !SKIP.test(f) });
    const head = () => git.resolveRef({ ...g, ref: "HEAD" }).catch(() => null);
    const short = oid => oid.slice(0, 7);
    const readAt = async (oid, filepath) => { try { return td.decode((await git.readBlob({ ...g, oid, filepath })).blob); } catch { return null; } };
    const work = async f => { try { return await ctx.fs.readFile(dir + "/" + f); } catch { return null; } };
    // The index's text of each file, by walking the stage.
    const staged = async () => {
      const out = new Map();
      await git.walk({ ...g, trees: [git.STAGE()], map: async (f, [e]) => { if (e && f !== "." && (await e.type()) === "blob") out.set(f, await e.oid()); return f; } });
      return out;
    };
    const blobText = async oid => td.decode((await git.readBlob({ ...g, oid })).blob);
    // A revision: a ref or an abbreviated id, then ~N and ^ steps back through first parents.
    const rev = async spec => {
      const [, name, steps] = /^(.*?)((?:[~^]\d*)*)$/.exec(spec);
      let oid = await git.resolveRef({ ...g, ref: name || "HEAD" }).catch(() => git.expandOid({ ...g, oid: name }));
      for (const [, op, n] of steps.matchAll(/([~^])(\d*)/g)) {
        const count = op === "~" ? +(n || 1) : 1;
        for (let i = 0; i < count; i++) {
          const parent = (await git.readCommit({ ...g, oid })).commit.parent[op === "^" && n ? +n - 1 : 0];
          if (!parent) throw new Error(`Could not find an object matching "${spec}".`);
          oid = parent;
        }
      }
      return oid;
    };
    const filesAt = async ref => {
      const oid = await rev(ref);
      const out = new Map();
      await git.walk({ ...g, trees: [git.TREE({ ref: oid })], map: async (f, [e]) => { if (e && f !== "." && (await e.type()) === "blob") out.set(f, await e.oid()); return f; } });
      return out;
    };
    async function patch(pairs, { stat = false, names = false } = {}) {
      jsdiff ??= await import(DIFF);
      let out = "";
      const stats = [];
      for (const [f, a, b] of pairs) {
        if (a === b) continue;
        if (names) { out += f + "\n"; continue; }
        const p = jsdiff.structuredPatch("a/" + f, "b/" + f, a ?? "", b ?? "", "", "", { context: 3 });
        if (stat) { const plus = p.hunks.reduce((n, h) => n + h.lines.filter(l => l[0] === "+").length, 0), minus = p.hunks.reduce((n, h) => n + h.lines.filter(l => l[0] === "-").length, 0); stats.push(` ${f} | ${plus + minus} ${"+".repeat(Math.min(plus, 40))}${"-".repeat(Math.min(minus, 40))}`); continue; }
        out += `diff --git a/${f} b/${f}\n${a == null ? "new file mode 100644\n" : b == null ? "deleted file mode 100644\n" : ""}--- ${a == null ? "/dev/null" : "a/" + f}\n+++ ${b == null ? "/dev/null" : "b/" + f}\n`;
        for (const h of p.hunks) out += `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n` + h.lines.join("\n") + "\n";
      }
      return stat ? stats.join("\n") + (stats.length ? `\n ${stats.length} file${stats.length > 1 ? "s" : ""} changed\n` : "") : out;
    }
    const only = (paths, f) => !paths.length || paths.some(p => { const rel = ctx.fs.resolvePath(ctx.cwd, p).slice(dir.length + 1); return !rel || f === rel || f.startsWith(rel.replace(/\/?$/, "/")); });

    try {
      switch (cmd) {
        case "init": {
          const existed = await ctx.fs.exists(dir + "/.git");
          await git.init({ ...g, defaultBranch: valueOf(rest, "-b", "--initial-branch") ?? "main" });
          return result(`${existed ? "Reinitialized existing" : "Initialized empty"} Git repository in ${dir}/.git/\n`);
        }
        case "status": {
          const lines = [], untracked = [], branch = await git.currentBranch({ ...g }) ?? "HEAD (detached)";
          for (const [f, h, w, s] of await matrix()) {
            const x = h === 0 && s >= 2 ? "A" : h === 1 && s === 0 ? "D" : h === 1 && (s === 2 || s === 3) ? "M" : " ";
            const y = h === 0 && s === 0 && w === 2 ? "?" : w === 0 && s !== 0 ? "D" : (s === 1 && w === 2) || (s === 3) || (s === 2 && w === 3) ? "M" : " ";
            if (y === "?") untracked.push(f);
            else if (x !== " " || y !== " ") lines.push(`${x}${y} ${f}`);
          }
          if (flag(rest, "-s", "--short", "--porcelain")) return result([...lines, ...untracked.map(f => `?? ${f}`)].map(l => l + "\n").join(""));
          const toCommit = lines.filter(l => l[0] !== " "), notStaged = lines.filter(l => l[1] !== " ");
          const word = { A: "new file", M: "modified", D: "deleted" };
          let out = `On branch ${branch}\n`;
          if (!(await head())) out += "\nNo commits yet\n";
          if (toCommit.length) out += "\nChanges to be committed:\n" + toCommit.map(l => `\t${word[l[0]]}:   ${l.slice(3)}`).join("\n") + "\n";
          if (notStaged.length) out += "\nChanges not staged for commit:\n" + notStaged.map(l => `\t${word[l[1]]}:   ${l.slice(3)}`).join("\n") + "\n";
          if (untracked.length) out += "\nUntracked files:\n" + untracked.map(f => `\t${f}`).join("\n") + "\n";
          if (!lines.length && !untracked.length) out += "nothing to commit, working tree clean\n";
          return result(out);
        }
        case "add": case "stage": {
          const paths = positional(rest), all = flag(rest, "-A", "--all", "-u", "--update") || paths.includes(".");
          if (!paths.length && !all) return result("", "Nothing specified, nothing added.\n", 0);
          for (const [f, h, w, s] of await matrix()) {
            if (!all && !only(paths, f)) continue;
            if (flag(rest, "-u", "--update") && h === 0) continue;
            if (w === 0) { if (s !== 0) await git.remove({ ...g, filepath: f }); }
            else if (w !== s) await git.add({ ...g, filepath: f });
          }
          return result("");
        }
        case "rm": {
          const paths = positional(rest), cached = flag(rest, "--cached");
          for (const [f] of await matrix()) {
            if (!only(paths, f)) continue;
            await git.remove({ ...g, filepath: f });
            if (!cached) await ctx.fs.rm(dir + "/" + f, { force: true });
          }
          return result(paths.map(p => `rm '${p}'\n`).join(""));
        }
        case "commit": {
          const message = valueOf(rest, "-m", "--message");
          if (!message) return result("", "error: this shell needs the message: git commit -m \"message\"\n", 1);
          if (flag(rest, "-a", "--all", "-am")) for (const [f, h, w, s] of await matrix()) { if (h === 0) continue; if (w === 0) await git.remove({ ...g, filepath: f }); else if (w !== s) await git.add({ ...g, filepath: f }); }
          const changes = (await matrix()).filter(([, h, , s]) => !(h === 1 && s === 1) && !(h === 0 && s === 0));
          if (!changes.length && !flag(rest, "--allow-empty")) return result("nothing to commit, working tree clean\n", "", 1);
          const parent = flag(rest, "--amend") ? (await git.readCommit({ ...g, oid: await head() })).commit.parent : undefined;
          const oid = await git.commit({ ...g, message, author: await author(), ...(parent && { parent }) });
          const branch = await git.currentBranch({ ...g }) ?? "detached HEAD";
          return result(`[${branch} ${short(oid)}] ${message.split("\n")[0]}\n ${changes.length} file${changes.length === 1 ? "" : "s"} changed\n`);
        }
        case "log": {
          const n = valueOf(rest, "-n", "--max-count") ?? rest.find(a => /^-\d+$/.test(a))?.slice(1);
          const ref = positional(rest, ["-n", "--max-count"])[0] ?? "HEAD";
          let log;
          try { log = await git.log({ ...g, ref, ...(n && { depth: +n }) }); }
          catch { return result("", `fatal: your current branch '${await git.currentBranch({ ...g })}' does not have any commits yet\n`, 128); }
          if (flag(rest, "--oneline") || flag(rest, "--pretty=oneline", "--format=oneline")) return result(log.map(c => `${short(c.oid)} ${c.commit.message.split("\n")[0]}`).join("\n") + "\n");
          return result(log.map(c => `commit ${c.oid}\nAuthor: ${c.commit.author.name} <${c.commit.author.email}>\nDate:   ${new Date(c.commit.author.timestamp * 1000).toUTCString()}\n\n${c.commit.message.trim().split("\n").map(l => "    " + l).join("\n")}\n`).join("\n"));
        }
        case "diff": {
          const opts = { stat: flag(rest, "--stat"), names: flag(rest, "--name-only") };
          const dash = rest.indexOf("--");
          const refs = positional(dash >= 0 ? rest.slice(0, dash) : rest).filter(a => !a.includes("/") && !(/\./.test(a) && !/^[0-9a-f]{4,40}$/.test(a)));
          const paths = dash >= 0 ? rest.slice(dash + 1) : positional(rest).filter(a => !refs.includes(a));
          const pairs = [];
          if (refs.length >= 2) {
            const [a, b] = [await filesAt(refs[0]), await filesAt(refs[1])];
            for (const f of new Set([...a.keys(), ...b.keys()])) if (only(paths, f) && a.get(f) !== b.get(f)) pairs.push([f, a.has(f) ? await blobText(a.get(f)) : null, b.has(f) ? await blobText(b.get(f)) : null]);
          } else if (flag(rest, "--staged", "--cached")) {
            const h = await head(), index = await staged(), tree = h ? await filesAt(h) : new Map();
            for (const f of new Set([...index.keys(), ...tree.keys()])) if (only(paths, f) && index.get(f) !== tree.get(f)) pairs.push([f, tree.has(f) ? await blobText(tree.get(f)) : null, index.has(f) ? await blobText(index.get(f)) : null]);
          } else {
            const base = refs.length ? await filesAt(refs[0]) : await staged();
            for (const [f, , w] of await matrix()) {
              if (!only(paths, f) || !base.has(f)) continue;
              pairs.push([f, await blobText(base.get(f)), w === 0 ? null : await work(f)]);
            }
          }
          return result(await patch(pairs.sort((a, b) => (a[0] < b[0] ? -1 : 1)), opts));
        }
        case "show": {
          const spec = positional(rest)[0] ?? "HEAD", colon = spec.indexOf(":");
          // rev:path is the file's text at that commit (models reach for git show HEAD:file to see the original).
          if (colon >= 0) {
            const at = spec.slice(0, colon) || "HEAD", file = spec.slice(colon + 1).replace(/^\.\//, "");
            const text = await readAt(await rev(at), file);
            return text == null ? result("", `fatal: path '${file}' does not exist in '${at}'\n`, 128) : result(text);
          }
          const oid = await rev(spec);
          const { commit } = await git.readCommit({ ...g, oid });
          const after = await filesAt(oid), before = commit.parent[0] ? await filesAt(commit.parent[0]) : new Map();
          const pairs = [];
          for (const f of new Set([...before.keys(), ...after.keys()])) if (before.get(f) !== after.get(f)) pairs.push([f, before.has(f) ? await blobText(before.get(f)) : null, after.has(f) ? await blobText(after.get(f)) : null]);
          return result(`commit ${oid}\nAuthor: ${commit.author.name} <${commit.author.email}>\n\n${commit.message.trim().split("\n").map(l => "    " + l).join("\n")}\n\n` + await patch(pairs, { stat: flag(rest, "--stat"), names: flag(rest, "--name-only") }));
        }
        // Models stash a fix to run the tests on the original code, then pop it back.
        case "stash": {
          const quiet = flag(rest, "-q", "--quiet");
          const op = positional(rest, ["-m", "--message"])[0] ?? "push";
          if (!["push", "save", "pop", "apply", "drop", "list", "clear"].includes(op)) return result("", `error: this shell's git stash has push, pop, apply, drop, list and clear, not '${op}'\n`, 1);
          if (op === "list") {
            const out = await git.stash({ ...g, op: "list" });
            return result(Array.isArray(out) ? out.map(s => s + "\n").join("") : out ? out + "\n" : "");
          }
          if (op === "push" || op === "save") {
            if (!(await matrix()).some(([, h, w, s]) => h !== w || w !== s)) return result("No local changes to save\n");
            const branch = await git.currentBranch({ ...g }), oid = await head();
            // git.stash takes its author from the config only.
            const who = await author();
            for (const [key, value] of [["user.name", who.name], ["user.email", who.email]]) if (!(await git.getConfig({ ...g, path: key }))) await git.setConfig({ ...g, path: key, value });
            await git.stash({ ...g, op: "push", message: valueOf(rest, "-m", "--message") ?? "" });
            return result(quiet ? "" : `Saved working directory and index state WIP on ${branch}: ${short(oid)} ${(await git.readCommit({ ...g, oid })).commit.message.split("\n")[0]}\n`);
          }
          const entries = await git.stash({ ...g, op: "list" }).catch(() => []);
          if (op !== "clear" && !(Array.isArray(entries) ? entries.length : entries)) return result("", "No stash entries found.\n", 1);
          try { await git.stash({ ...g, op }); }
          catch (e) { return result("", `error: ${e?.message ?? e}\n`, 1); }
          return result(quiet ? "" : op === "clear" ? "" : op === "drop" ? "Dropped refs/stash@{0}\n" : `Applied stash@{0}${op === "pop" ? " and dropped it" : ""}\n`);
        }
        case "branch": {
          const names = positional(rest);
          if (flag(rest, "-d", "-D", "--delete")) { for (const n of names) await git.deleteBranch({ ...g, ref: n }); return result(names.map(n => `Deleted branch ${n}.\n`).join("")); }
          if (flag(rest, "-m", "-M", "--move")) { const [a, b] = names.length > 1 ? names : [await git.currentBranch({ ...g }), names[0]]; await git.renameBranch({ ...g, oldref: a, ref: b }); return result(""); }
          if (flag(rest, "--show-current")) return result((await git.currentBranch({ ...g }) ?? "") + "\n");
          if (names.length) { await git.branch({ ...g, ref: names[0], ...(names[1] && { object: names[1] }) }); return result(""); }
          const current = await git.currentBranch({ ...g });
          return result((await git.listBranches({ ...g })).map(b => `${b === current ? "*" : " "} ${b}`).join("\n") + "\n");
        }
        case "checkout": case "switch": {
          const dash = rest.indexOf("--");
          if (dash >= 0 || (cmd === "checkout" && positional(rest).some(p => p.includes(".") || p.includes("/")) && !flag(rest, "-b"))) {
            const files = dash >= 0 ? rest.slice(dash + 1) : positional(rest);
            const ref = dash > 0 ? positional(rest.slice(0, dash))[0] : null;
            const at = ref ? await filesAt(ref) : await staged();
            for (const f of files) {
              const rel = ctx.fs.resolvePath(ctx.cwd, f).slice(dir.length + 1);
              const hits = [...at.keys()].filter(p => p === rel || p.startsWith(rel + "/"));
              if (!hits.length) return result("", `error: pathspec '${f}' did not match any file(s) known to git\n`, 1);
              for (const p of hits) await ctx.fs.writeFile(dir + "/" + p, await blobText(at.get(p)));
            }
            return result("", `Updated ${files.length} path${files.length > 1 ? "s" : ""}\n`);
          }
          const create = flag(rest, "-b", "-c", "-B", "--create");
          const [ref, start] = positional(rest, []);
          if (!ref) return result("", "fatal: a branch name is needed\n", 128);
          if (create) await git.branch({ ...g, ref, ...(start && { object: start }), force: flag(rest, "-B") });
          await git.checkout({ ...g, ref, force: flag(rest, "-f", "--force"), filter: f => !SKIP.test(f) });
          return result("", create ? `Switched to a new branch '${ref}'\n` : `Switched to '${ref}'\n`);
        }
        case "restore": {
          const files = positional(rest, ["--source", "-s"]);
          if (flag(rest, "--staged", "-S")) { for (const f of files) await git.resetIndex({ ...g, filepath: ctx.fs.resolvePath(ctx.cwd, f).slice(dir.length + 1) }); return result(""); }
          const source = valueOf(rest, "--source", "-s");
          const at = source ? await filesAt(source) : await staged();
          for (const f of files) {
            const rel = ctx.fs.resolvePath(ctx.cwd, f).slice(dir.length + 1);
            const hits = [...at.keys()].filter(p => p === rel || p.startsWith(rel.replace(/\/?$/, "/")) || rel === "");
            if (!hits.length) return result("", `error: pathspec '${f}' did not match any file(s) known to git\n`, 1);
            for (const p of hits) await ctx.fs.writeFile(dir + "/" + p, await blobText(at.get(p)));
          }
          return result("");
        }
        case "reset": {
          const files = positional(rest).filter(a => !/^(HEAD|[0-9a-f]{7,40})(~\d*|\^)*$/.test(a));
          if (files.length) { for (const f of files) await git.resetIndex({ ...g, filepath: ctx.fs.resolvePath(ctx.cwd, f).slice(dir.length + 1) }); return result(""); }
          const oid = await rev(positional(rest)[0] ?? "HEAD");
          const branch = await git.currentBranch({ ...g });
          if (branch) await git.writeRef({ ...g, ref: `refs/heads/${branch}`, value: oid, force: true });
          const tree = await filesAt(oid);
          if (!flag(rest, "--soft")) for (const [f, h] of await matrix()) { if (tree.has(f)) await git.resetIndex({ ...g, filepath: f, ref: oid }); else if (h) await git.remove({ ...g, filepath: f }); }
          if (flag(rest, "--hard")) {
            await git.checkout({ ...g, ref: branch ?? oid, force: true, filter: f => !SKIP.test(f) });
            const { commit } = await git.readCommit({ ...g, oid });
            return result(`HEAD is now at ${short(oid)} ${commit.message.split("\n")[0]}\n`);
          }
          return result("");
        }
        case "merge": {
          const theirs = positional(rest)[0];
          const r = await git.merge({ ...g, theirs, author: await author(), fastForward: !flag(rest, "--no-ff") });
          if (r.alreadyMerged) return result("Already up to date.\n");
          await git.checkout({ ...g, ref: await git.currentBranch({ ...g }), force: true, filter: f => !SKIP.test(f) });
          return result(r.fastForward ? `Fast-forward\n` : `Merge made by the 'ort' strategy.\n`);
        }
        case "tag": {
          const [name, object] = positional(rest);
          if (!name) return result((await git.listTags({ ...g })).join("\n") + "\n");
          if (flag(rest, "-d")) { await git.deleteTag({ ...g, ref: name }); return result(`Deleted tag '${name}'\n`); }
          await git.tag({ ...g, ref: name, ...(object && { object }) });
          return result("");
        }
        case "remote": {
          const [sub, name, url] = positional(rest);
          if (sub === "add") { await git.addRemote({ ...g, remote: name, url }); return result(""); }
          if (sub === "remove" || sub === "rm") { await git.deleteRemote({ ...g, remote: name }); return result(""); }
          if (sub === "get-url") return result(((await git.listRemotes({ ...g })).find(r => r.remote === name)?.url ?? "") + "\n");
          const remotes = await git.listRemotes({ ...g });
          return result(remotes.map(r => (flag(rest, "-v") ? `${r.remote}\t${r.url} (fetch)\n${r.remote}\t${r.url} (push)` : r.remote)).join("\n") + (remotes.length ? "\n" : ""));
        }
        case "fetch": case "pull": case "push": {
          const [remote = "origin", ref] = positional(rest);
          const url = (await git.listRemotes({ ...g })).find(r => r.remote === remote)?.url;
          if (!url) return result("", `fatal: '${remote}' does not appear to be a git repository\n`, 128);
          try {
            if (cmd === "push") {
              const r = await git.push({ ...g, ...net, remote, ...(ref && { ref }), force: flag(rest, "-f", "--force") });
              return result("", r.ok ? `To ${url}\n   ${ref ?? await git.currentBranch({ ...g })} -> ${ref ?? await git.currentBranch({ ...g })}\n` : `error: failed to push: ${JSON.stringify(r.refs)}\n`, r.ok ? 0 : 1);
            }
            if (cmd === "fetch") { await git.fetch({ ...g, ...net, remote, ...(ref && { ref }) }); return result("", `From ${url}\n`); }
            await git.pull({ ...g, ...net, remote, ...(ref && { ref }), author: await author(), singleBranch: true });
            return result(`Updated from ${url}\n`);
          } catch (e) { return netError(e, url); }
        }
        case "config": {
          const names = positional(rest);
          if (flag(rest, "--list", "-l")) { const keys = ["user.name", "user.email", "core.bare"]; return result((await Promise.all(keys.map(async k => [k, await git.getConfig({ ...g, path: k })]))).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join("\n") + "\n"); }
          if (names.length === 1) { const v = await git.getConfig({ ...g, path: names[0] }); return v == null ? result("", "", 1) : result(v + "\n"); }
          await git.setConfig({ ...g, path: names[0], value: names.slice(1).join(" ") });
          return result("");
        }
        case "rev-parse": {
          if (flag(rest, "--show-toplevel")) return result(dir + "\n");
          if (flag(rest, "--is-inside-work-tree")) return result("true\n");
          if (flag(rest, "--git-dir")) return result(".git\n");
          const ref = positional(rest)[0] ?? "HEAD";
          if (flag(rest, "--abbrev-ref")) return result((await git.currentBranch({ ...g })) + "\n");
          const oid = await rev(ref);
          return result((flag(rest, "--short") ? short(oid) : oid) + "\n");
        }
        default: return result("", `git: '${cmd}' isn't available in this shell. See 'git help'.\n`, 1);
      }
    } catch (e) { return result("", `fatal: ${e?.message ?? e}\n`, 128); }
  });
}
