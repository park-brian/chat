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
const SUPPORTED = "status, diff, log, branch, checkout -b, switch -c, add, commit, push, pull, init, remote -v; gh pr create, gh pr checks, gh run list/view/watch";
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

// #region gh: pull requests' checks and workflow runs (a GitHub project's CI, through ws.git.ci)

const GH_SUPPORTED = "gh pr create, gh pr checks [--watch] [--fail-fast], gh run list, gh run view [--log-failed], gh run watch, on a GitHub project";
export const WATCH_TIMEOUT = 15 * 60_000;
// Real gh's exit code for checks still pending (gh pr checks without --watch).
export const PENDING_EXIT = 8;
// gh's marks: pass, fail, pending, skipped.
const MARK = { pass: "✓", fail: "X", pending: "*", skipping: "-" };

const gh = (stdout, exitCode = 0, stderr = "") => ({ stdout: stdout && !stdout.endsWith("\n") ? stdout + "\n" : stdout, stderr: stderr && !stderr.endsWith("\n") ? stderr + "\n" : stderr, exitCode });
const ghFail = (message, exitCode = 1) => gh("", exitCode, message);
const elapsed = (from, to) => {
  const ms = from && to ? Date.parse(to) - Date.parse(from) : NaN;
  if (!(ms >= 0)) return "";
  const s = Math.round(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
  return h ? `${h}h${m % 60}m` : m ? `${m}m${s % 60}s` : `${s}s`;
};
const secondsOf = (args, ...names) => { const v = valueOf(args, ...names); return v != null && +v > 0 ? +v * 1000 : undefined; };
const table = rows => {
  const widths = rows.reduce((w, r) => r.map((c, i) => Math.max(w[i] ?? 0, String(c).length)), []);
  return rows.map(r => r.map((c, i) => (i === r.length - 1 ? String(c) : String(c).padEnd(widths[i]))).join("  ").trimEnd()).join("\n");
};

// gh's buckets, mirrored from projects.js checkBucket so this module stays free of imports.
const bucket = ({ status = "completed", conclusion = null, state = null } = {}) => {
  if (state) return state === "success" ? "pass" : state === "pending" ? "pending" : "fail";
  if (status !== "completed") return "pending";
  if (conclusion === "success") return "pass";
  if (conclusion === "skipped" || conclusion === "neutral") return "skipping";
  return ["failure", "cancelled", "timed_out", "action_required", "startup_failure"].includes(conclusion) ? "fail" : "pending";
};

// gh pr checks' report: a summary line, the counts, and a row a check; failed checks' annotations under them.
function checksReport(c) {
  const rows = [...c.runs.map(r => ({ b: bucket(r), name: r.name, time: elapsed(r.startedAt, r.completedAt), url: r.url ?? "", r })), ...c.statuses.map(s => ({ b: bucket(s), name: s.name, time: "", url: s.url ?? "", r: { annotations: [], summary: s.description } }))];
  const n = k => rows.filter(r => r.b === k).length;
  const head = n("fail") ? "Some checks were not successful" : n("pending") ? "Some checks are still pending" : "All checks were successful";
  const lines = [head, `${n("fail")} failing, ${n("pass")} successful, ${n("skipping")} skipped, and ${n("pending")} pending checks`, ""];
  const order = { fail: 0, pending: 1, pass: 2, skipping: 3 };
  const sorted = rows.sort((a, b) => order[a.b] - order[b.b]);
  const t = table(sorted.map(r => [MARK[r.b], r.name, r.time, r.url])).split("\n");
  sorted.forEach((r, i) => {
    lines.push(t[i]);
    if (r.b !== "fail") return;
    const notes = (r.r.annotations ?? []).filter(a => a.level === "failure" && !/^Process completed with exit code/.test(a.message)).slice(0, 5);
    for (const a of notes) lines.push(`    ${a.path && a.path !== ".github" ? `${a.path}${a.line ? `:${a.line}` : ""}: ` : ""}${a.message.split("\n")[0].slice(0, 200)}`);
    if (!notes.length && r.r.summary) lines.push(`    ${r.r.summary.split("\n")[0].slice(0, 200)}`);
  });
  const failedRun = c.runs.find(r => bucket(r) === "fail" && r.runId);
  if (failedRun) lines.push("", `gh run view ${failedRun.runId} --log-failed shows the failing log.`);
  return lines.join("\n");
}

// The pull request gh pr checks means: a number, a URL, a branch, or the project's branch's.
async function findPullRequest(ws, target) {
  const number = target && (/^#?(\d+)$/.exec(target)?.[1] ?? /\/pull\/(\d+)/.exec(target)?.[1]);
  if (number) return { pr: await ws.git.ci.pullRequest({ number: +number }), branch: null };
  const branch = target ?? (await ws.git.branch()).current;
  return { pr: await ws.git.ci.pullRequest({ branch }), branch };
}

// gh pr checks [<number> | <url> | <branch>] [--watch] [--fail-fast] [-i seconds]: exit 0 when every check
// passed, 1 when any failed (or none are reported), 8 when some are pending (without --watch, or past the time).
async function prChecks(ws, args, { timeoutMs, signal, pollMs, graceMs }) {
  const watch = args.includes("--watch"), failFast = args.includes("--fail-fast");
  if (failFast && !watch) return ghFail("cannot use `--fail-fast` flag without `--watch` flag");
  const [target] = positional(args, ["-i", "--interval"]);
  const { pr, branch } = await findPullRequest(ws, target);
  if (!pr) return ghFail(`no pull requests found for branch "${branch}" (open one with gh pr create; gh run watch shows a pushed branch's runs without one)`);
  // Right after a push GitHub may still name the commit before as the pull request's head: the project's own push is newer.
  const record = ws.root.record;
  const sha = record?.base?.commit && pr.headRef === record.branch ? record.base.commit : pr.headSha;
  const began = Date.now();
  const c = watch
    ? await ws.git.ci.waitForChecks({ sha, failFast, timeoutMs, signal, pollMs: secondsOf(args, "-i", "--interval") ?? pollMs, ...(graceMs != null && { graceMs }) })
    : await ws.git.ci.checks({ sha });
  if (!c.total) return ghFail(`no checks reported on the '${pr.headRef}' branch${ws.git.ci.hasWorkflows() ? "" : " (the repository has no .github/workflows)"}`);
  const report = checksReport(c);
  if (c.timedOut) return gh(`${report}\n\nStill pending after ${elapsed(new Date(began).toISOString(), new Date().toISOString())}: run gh pr checks --watch again to keep waiting.`, PENDING_EXIT);
  return gh(report, c.state === "failure" ? 1 : c.state === "pending" ? PENDING_EXIT : 0);
}

// The run a bare gh run view or watch means: the newest on the project's branch, preferring its pushed commit's
// (waiting graceMs for GitHub to start it after a push).
async function latestRun(ws, { graceMs = 60_000, pollMs = 5_000, signal } = {}) {
  const { current } = await ws.git.branch();
  const sha = ws.root.record?.base?.commit ?? null;
  const until = Date.now() + graceMs;
  for (;;) {
    const list = await ws.git.ci.runs({ branch: current, limit: 10 });
    const mine = list.find(r => r.sha === sha);
    if (mine || !ws.git.ci.hasWorkflows() || Date.now() + pollMs > until) return mine ?? list[0] ?? null;
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, pollMs);
      signal?.addEventListener?.("abort", () => { clearTimeout(t); reject(signal.reason ?? new Error("aborted")); }, { once: true });
    });
  }
}

const runMark = r => MARK[bucket(r)];

async function runSummary(ws, run) {
  const jobs = await ws.git.ci.jobs(run.id);
  const lines = [`${runMark(run)} ${run.branch} ${run.title} · ${run.id}`, `Triggered via ${run.event}${run.status === "completed" ? `, ${run.conclusion}` : `, ${run.status.replace("_", " ")}`}${elapsed(run.startedAt, run.status === "completed" ? run.updatedAt : null) ? ` in ${elapsed(run.startedAt, run.updatedAt)}` : ""}`, "", "JOBS"];
  for (const j of jobs) {
    lines.push(`${runMark(j)} ${j.name}${elapsed(j.startedAt, j.completedAt) ? ` in ${elapsed(j.startedAt, j.completedAt)}` : ""} (ID ${j.id})`);
    if (bucket(j) === "fail") for (const s of j.steps.filter(s => s.conclusion !== "skipped")) lines.push(`  ${runMark(s)} ${s.name}`);
  }
  if (bucket(run) === "fail") lines.push("", `To see what failed: gh run view ${run.id} --log-failed`);
  lines.push(`View this run on GitHub: ${run.url}`);
  return lines.join("\n");
}

// gh run list [--branch b] [--limit n] [--commit sha]; gh run view [<id>] [--log-failed] [--exit-status];
// gh run watch [<id>] [-i seconds]: exits 1 when the run fails (real gh needs --exit-status for that), 8 when it's
// still running at the time limit.
async function ghRun(ws, sub, args, { timeoutMs, signal, pollMs, graceMs }) {
  const withValues = ["-b", "--branch", "-L", "--limit", "-c", "--commit", "-i", "--interval", "-j", "--job", "-w", "--workflow"];
  if (sub === "list" || sub === "ls") {
    const limit = Math.max(1, +(valueOf(args, "-L", "--limit") ?? 20) || 20);
    const runs = await ws.git.ci.runs({ branch: valueOf(args, "-b", "--branch"), sha: valueOf(args, "-c", "--commit"), limit });
    if (!runs.length) return gh("", 0, "no runs found");
    return gh(table([["STATUS", "TITLE", "WORKFLOW", "BRANCH", "EVENT", "ID", "ELAPSED"], ...runs.map(r => [r.status === "completed" ? `${runMark(r)} ${r.conclusion}` : `${runMark(r)} ${r.status}`, r.title.slice(0, 50), r.name, r.branch, r.event, r.id, elapsed(r.startedAt, r.status === "completed" ? r.updatedAt : new Date().toISOString())])]));
  }
  const [id] = positional(args, withValues);
  const job = valueOf(args, "-j", "--job");
  const run = id ? await ws.git.ci.run(id) : await latestRun(ws, { signal, ...(graceMs != null && { graceMs }), ...(pollMs != null && { pollMs }) });
  if (!run) return ghFail(`no runs found for branch ${(await ws.git.branch()).current}${ws.git.ci.hasWorkflows() ? "" : " (the repository has no .github/workflows)"}`);
  if (sub === "view") {
    if (args.includes("--log-failed")) {
      if (run.status !== "completed" && !job) return ghFail(`run ${run.id} is still in progress; logs will be available when it is complete (gh run watch ${run.id} waits for it)`);
      const log = await ws.git.ci.failedLog(job ? { job: +job } : { run: run.id });
      return log ? gh(log) : ghFail(`no failed jobs in run ${run.id} (${run.conclusion ?? run.status})`);
    }
    return gh(await runSummary(ws, run), args.includes("--exit-status") && bucket(run) === "fail" ? 1 : 0);
  }
  // watch
  const done = run.status === "completed" ? run : await ws.git.ci.waitForRun(run.id, { timeoutMs, signal, pollMs: secondsOf(args, "-i", "--interval") ?? pollMs });
  const summary = await runSummary(ws, done);
  if (done.timedOut) return gh(`${summary}\n\nStill running at the time limit: run gh run watch ${run.id} again to keep waiting.`, PENDING_EXIT);
  return gh(`${summary}${done === run ? `\n\nRun ${run.id} had already completed.` : ""}`, bucket(done) === "fail" ? 1 : 0);
}

// #endregion

// One git or gh command on ws.git: { stdout, stderr, exitCode }. state: the session's, for what git add staged.
// readOnly: a fork's or a part's shell, which reads the repository and changes nothing in it.
// timeoutMs, signal: how long gh's watching commands may wait (pollMs, graceMs: their pace, for tests).
export async function runProjectGit(ws, [tool, cmd, ...args], { state = {}, readOnly = false, timeoutMs = WATCH_TIMEOUT, signal = null, pollMs = undefined, graceMs = undefined } = {}) {
  const ok = stdout => ({ stdout: stdout && !stdout.endsWith("\n") ? stdout + "\n" : stdout, stderr: "", exitCode: 0 });
  const fail = (message, exitCode = 1) => ({ stdout: "", stderr: `${tool === "gh" ? "" : "fatal: "}${message}\n`, exitCode });
  try {
    if (tool === "gh") {
      if (cmd === "pr" && args[0] === "checks") return await prChecks(ws, args.slice(1), { timeoutMs, signal, pollMs, graceMs });
      if (cmd === "run" && ["list", "ls", "view", "watch"].includes(args[0])) return await ghRun(ws, args[0], args.slice(1), { timeoutMs, signal, pollMs, graceMs });
      if (cmd !== "pr" || args[0] !== "create") return fail(`gh ${[cmd, args[0]].filter(Boolean).join(" ")} isn't available here: ${GH_SUPPORTED}.`);
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
        const ci = ws.root.kind === "github" && (await Promise.resolve(ws.git.ci?.hasWorkflows?.()).catch(() => false))
          ? `\nCI: the repository has workflows (.github/workflows), so this push starts them. Watch the result: gh pr checks --watch (with a pull request open) or gh run watch; gh run view --log-failed shows what failed.` : "";
        return { ...ok(`To ${pushed.url}\n   ${plural(pushed.commits, "commit")} -> ${pushed.branch} (${String(pushed.commit).slice(0, 7)})${ci}`), pushed: { branch: pushed.branch, commit: pushed.commit } };
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
