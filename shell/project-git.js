// git and gh on a folder or GitHub project: the shell's git runs on its own copy of the files, whose .git isn't the
// project's, so on a project with a root the bash tool sends git and gh commands to workspace.git instead (the
// folder's repository through isomorphic-git, or the connected GitHub branch; projects.js). A command goes there when
// it is a git or gh command of its own, or a && chain of them and other commands (the others run in the shell, in
// order, stopping at the first that fails). Pipes, redirections, ;, ||, substitutions and $ expansions leave the
// whole command to the shell. Pure: the workspace is passed in.

// The command as a && chain of { text, words }, or null when it has anything else the shell must read.
export function splitChain(command) {
  const segments = [];
  let words = [], word = null, start = 0, i = 0;
  const end = () => { if (word != null) words.push(word); word = null; };
  const close = at => { end(); segments.push({ text: command.slice(start, at).trim(), words }); words = []; };
  for (; i < command.length; i++) {
    const c = command[i];
    if (c === "'") {
      const j = command.indexOf("'", i + 1);
      if (j < 0) return null;
      word = (word ?? "") + command.slice(i + 1, j);
      i = j;
    } else if (c === '"') {
      let j = i + 1, text = "";
      for (; j < command.length && command[j] !== '"'; j++) {
        if (command[j] === "$" || command[j] === "`") return null;
        if (command[j] === "\\" && /["\\$`]/.test(command[j + 1] ?? "")) j++;
        text += command[j];
      }
      if (j >= command.length) return null;
      word = (word ?? "") + text;
      i = j;
    } else if (c === "\\") {
      if (i + 1 >= command.length || command[i + 1] === "\n") return null;
      word = (word ?? "") + command[++i];
    } else if (c === "&" && command[i + 1] === "&") {
      close(i);
      start = ++i + 1;
    } else if (/[|;<>&`$(){}\n#*?~]/.test(c)) {
      return null;
    } else if (/\s/.test(c)) end();
    else word = (word ?? "") + c;
  }
  close(i);
  return segments.every(s => s.words.length) ? segments : null;
}

const isGit = segment => segment.words[0] === "git" || segment.words[0] === "gh";

// The chain, when this workspace's git is the project's and the chain has a git or gh command; else null.
export function projectGitChain(ws, command) {
  if (!ws?.root || ws.branch || !ws.git) return null;
  const chain = splitChain(command);
  return chain?.some(isGit) ? chain.map(s => ({ ...s, git: isGit(s) })) : null;
}

// A command with git or gh in it the chain rule left to the shell, on a project whose git is elsewhere.
export const mentionsGit = command => /(^|[\s;&|(`])(git|gh)(\s|$)/.test(command);
export const SHELL_GIT_NOTE = "git here is the project's own only as a command of its own or in a && chain (git status, git add . && git commit -m ...): this command's git ran on the shell's copy of the files, which isn't the project's repository.";

const MUTATING = new Set(["add", "commit", "push", "pull", "init", "checkout", "switch", "pr"]);
const SUPPORTED = "status, diff, log, branch, checkout -b, switch -c, add, commit, push, pull, init, remote -v; gh pr create";
const LETTER = { modified: "M", added: "A", deleted: "D" };

const valueOf = (args, ...names) => {
  for (const n of names) {
    const i = args.indexOf(n);
    if (i >= 0) return args[i + 1] ?? null;
    const eq = args.find(a => a.startsWith(n + "="));
    if (eq) return eq.slice(n.length + 1);
  }
  return null;
};
const valuesOf = (args, name) => args.flatMap((a, i) => a === name && args[i + 1] != null ? [args[i + 1]] : []);
const positional = (args, withValues = []) => args.filter((a, i) => !a.startsWith("-") && !withValues.includes(args[i - 1]));
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// One git or gh command on ws.git: { stdout, stderr, exitCode }. state: the session's, for what git add staged.
// readOnly: a fork's or a part's shell, which reads the repository and changes nothing in it.
export async function runProjectGit(ws, [tool, cmd, ...args], { state = {}, readOnly = false } = {}) {
  const ok = stdout => ({ stdout: stdout && !stdout.endsWith("\n") ? stdout + "\n" : stdout, stderr: "", exitCode: 0 });
  const fail = (message, exitCode = 1) => ({ stdout: "", stderr: `${tool === "gh" ? "" : "fatal: "}${message}\n`, exitCode });
  try {
    if (tool === "gh") {
      if (cmd !== "pr" || args[0] !== "create") return fail(`gh ${[cmd, args[0]].filter(Boolean).join(" ")} isn't available here: gh pr create is, on a GitHub project.`);
      if (readOnly) return fail("A sub-agent doesn't open pull requests: say in your answer what should go in one.");
      const rest = args.slice(1);
      let title = valueOf(rest, "--title", "-t");
      if (title == null && rest.includes("--fill")) title = (await ws.git.log({ depth: 1 }))[0]?.message.split("\n")[0] ?? null;
      if (!title) return fail("gh pr create needs --title (or --fill).");
      const pr = await ws.git.openPullRequest({ title, body: valueOf(rest, "--body", "-b") ?? "", base: valueOf(rest, "--base", "-B"), draft: rest.includes("--draft") || rest.includes("-d") });
      return ok(pr.url);
    }
    if (!cmd) return fail(`git needs a command: ${SUPPORTED}.`);
    if (readOnly && (MUTATING.has(cmd) || (cmd === "branch" && positional(args).length))) return fail(`a sub-agent's shell reads the project's repository and doesn't change it: say in your answer what to ${cmd}.`);
    switch (cmd) {
      case "status": {
        const rows = await ws.git.status();
        const short = rows.map(r => `${r.status === "untracked" ? "??" : r.staged ? `${LETTER[r.status] ?? "M"} ` : ` ${LETTER[r.status] ?? "M"}`} ${r.path}`);
        if (["-s", "--short", "--porcelain"].some(f => args.includes(f))) return ok(short.join("\n"));
        const { current } = await ws.git.branch().catch(() => ({ current: null }));
        return ok([current ? `On branch ${current}` : null, ...(short.length ? short : ["nothing to commit, working tree clean"])].filter(Boolean).join("\n"));
      }
      case "diff": {
        const paths = args.includes("--") ? args.slice(args.indexOf("--") + 1) : positional(args);
        if (args.includes("--name-only") || args.includes("--name-status") || args.includes("--stat")) {
          const rows = (await ws.git.status()).filter(r => r.status !== "untracked" && (!paths.length || paths.includes(r.path)));
          return ok(rows.map(r => args.includes("--name-status") ? `${LETTER[r.status] ?? "M"}\t${r.path}` : r.path).join("\n"));
        }
        const parts = paths.length ? await Promise.all(paths.map(path => ws.git.diff({ path }))) : [await ws.git.diff()];
        return ok(parts.filter(Boolean).join("\n"));
      }
      case "log": {
        const n = valueOf(args, "-n", "--max-count") ?? args.find(a => /^-\d+$/.test(a))?.slice(1);
        const commits = await ws.git.log({ depth: n ? Math.max(1, +n || 1) : 20 });
        if (args.includes("--oneline")) return ok(commits.map(c => `${c.oid.slice(0, 7)} ${c.message.split("\n")[0]}`).join("\n"));
        return ok(commits.map(c => `commit ${c.oid}\nAuthor: ${c.author?.name ?? ""} <${c.author?.email ?? ""}>\nDate:   ${c.date ?? ""}\n\n${c.message.split("\n").map(l => "    " + l).join("\n")}\n`).join("\n"));
      }
      case "branch": {
        const [name] = positional(args);
        if (args.includes("-d") || args.includes("-D") || args.includes("-m")) return fail("deleting or renaming a branch isn't available here.");
        const b = await ws.git.branch(name ? { name } : {});
        if (args.includes("--show-current")) return ok(b.current ?? "");
        if (name) return ok("");
        return ok([...new Set([b.current, ...(b.branches ?? [])].filter(Boolean))].map(n => `${n === b.current ? "*" : " "} ${n}`).join("\n"));
      }
      case "checkout": case "switch": {
        const create = valueOf(args, cmd === "checkout" ? "-b" : "-c") ?? valueOf(args, "-B", "-C");
        const [name] = positional(args, ["-b", "-c", "-B", "-C"]);
        const target = create ?? name;
        if (!target || args.includes("--")) return fail(`git ${cmd} switches branches here (git ${cmd} ${cmd === "checkout" ? "-b" : "-c"} NAME); to undo a file's change, use restore.`);
        if (!create && ws.root.kind === "folder" && !(await ws.git.branch()).branches?.includes(target)) return fail(`'${target}' is not a branch: make it with git ${cmd} ${cmd === "checkout" ? "-b" : "-c"} ${target}.`);
        const b = await ws.git.branch({ name: target, checkout: true });
        return ok(`Switched to ${create ? "a new branch" : "branch"} '${b.current ?? target}'`);
      }
      case "add": {
        const paths = positional(args);
        if (!paths.length && !args.some(a => ["-A", "--all", "-u"].includes(a))) return fail("Nothing specified, nothing added.");
        if (args.some(a => ["-A", "--all", "-u"].includes(a)) || paths.includes(".")) state.staged = "all";
        else if (state.staged !== "all") state.staged = [...new Set([...(state.staged ?? []), ...paths])];
        return ok("");
      }
      case "commit": {
        const messages = [...valuesOf(args, "-m"), ...valuesOf(args, "--message"), ...args.filter(a => a.startsWith("--message=")).map(a => a.slice(10))];
        const combined = args.find(a => /^-[a-zA-Z]*a[a-zA-Z]*m$/.test(a));
        if (combined) messages.unshift(args[args.indexOf(combined) + 1]);
        if (!messages.length) return fail("git commit needs a message: git commit -m \"...\" (no editor here).");
        const all = args.includes("-a") || args.includes("--all") || !!combined;
        const paths = !all && Array.isArray(state.staged) && state.staged.length ? state.staged : null;
        const made = await ws.git.commit({ message: messages.join("\n\n"), ...(paths && { paths }) });
        state.staged = null;
        const { current } = await ws.git.branch().catch(() => ({ current: null }));
        return ok(`[${current ?? "HEAD"} ${String(made.oid).slice(0, 7)}] ${made.message.split("\n")[0]}\n ${plural(made.files?.length ?? 0, "file")} changed`);
      }
      case "push": {
        if (args.some(a => a === "-f" || a === "--force" || a.startsWith("--force-with-lease"))) return fail("no force push: push to a new branch instead.");
        const [, refspec] = positional(args);
        const branch = refspec?.includes(":") ? refspec.split(":")[1] : refspec === "HEAD" ? undefined : refspec;
        const pushed = await ws.git.push(branch ? { branch } : {});
        return ok(`To ${pushed.url}\n   ${plural(pushed.commits, "commit")} -> ${pushed.branch} (${String(pushed.commit).slice(0, 7)})`);
      }
      case "pull": return ok(JSON.stringify(await ws.git.pull()) ?? "");
      case "init": {
        const made = await ws.git.init({ branch: valueOf(args, "-b", "--initial-branch") ?? "main" });
        return ok(`Initialized empty Git repository in ${ws.root.name}/.git/ (branch ${made.branch})`);
      }
      case "remote": {
        const name = ws.root.kind === "github" ? ws.root.name : null;
        if (!name) return ok("");
        return ok(args.includes("-v") ? `origin\thttps://github.com/${name}.git (fetch)\norigin\thttps://github.com/${name}.git (push)` : "origin");
      }
      default:
        return fail(`git ${cmd} isn't available on this project's repository: ${SUPPORTED}.`);
    }
  } catch (e) {
    return fail(e?.message || String(e));
  }
}
