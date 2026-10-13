// The bash tool, engine side (docs/specs/2026-10-13-shell.md). The shell itself runs in a tab (shell/host.js): a
// SharedWorker can't start Workers. Here: sessions (cwd, env, and which version of each file the tab's shell has),
// the delta of the project's files sent before each command, and the commit of what the command changed, as
// versions with source "shell", so history, diff, run_app, PLAN.md and the director's checks see them. Also the
// director's command check. The engine passes in what it owns, so this module imports nothing of it.
import { BASH_DESCRIPTION } from "../prompts.js";

export const SHELL_ROOT = "/project";
const DEFAULT_TIMEOUT = 60, PYTHON_TIMEOUT = 300, MAX_TIMEOUT = 600, CHECK_TIMEOUT = 300;
const PYTHON = /(^|[\s;&|(`])(python3?|pip3?|pytest)(\s|$)/;

export const BASH_TOOL_SPEC = {
  name: "bash",
  description: BASH_DESCRIPTION,
  inputSchema: {
    json: {
      type: "object",
      properties: {
        command: { type: "string", description: "The bash command, e.g. npm test, or ls src && grep -rn TODO src" },
        timeout: { type: "integer", description: `Seconds before it is stopped, up to ${MAX_TIMEOUT}. Default ${DEFAULT_TIMEOUT}, or ${PYTHON_TIMEOUT} for python3, pip and pytest` },
        restart: { type: "boolean", description: "Start a fresh shell first: cwd back to /project, env reset" },
      },
    },
  },
};

const clip = (text, n) => (text = String(text ?? ""), text.length > n ? text.slice(0, n - 1) + "…" : text);
// The counts a test run printed, as node --test, npm test or pytest print them.
export function testCounts(text) {
  const tap = /# pass (\d+)\s*\n# fail (\d+)/.exec(text);
  if (tap) return { passed: +tap[1], failed: +tap[2] };
  const py = /=+ (?:(\d+) failed)?(?:, )?(?:(\d+) passed)?/.exec(text.split("\n").reverse().find(l => /=+ .*(passed|failed)/.test(l)) ?? "");
  if (py && (py[1] || py[2])) return { passed: +(py[2] ?? 0), failed: +(py[1] ?? 0) };
  return null;
}

// workspaceFor(context, { create }) and runApp(input, context) are the engine's.
export function createShellTool({ workspaceFor, runApp }) {
  const sessions = new Map(); // key -> { shellId, known: Map(path -> versionId), cwd, env }
  // A chat's run on a project, or on a variant's branch of it; a fork has one of its own.
  const keyOf = (context, ws) => [context.threadId ?? "-", ws.branch ?? "", context.shell?.session ?? ""].join(":");
  const session = key => {
    if (!sessions.has(key)) sessions.set(key, { shellId: null, known: new Map(), cwd: SHELL_ROOT, env: null });
    return sessions.get(key);
  };

  const textFiles = (heads, files) => Object.fromEntries(Object.keys(heads).filter(p => typeof files[p] === "string").map(p => [p, files[p]]));
  function deltaOf(known, heads, files) {
    const write = {}, remove = [];
    for (const [p, id] of Object.entries(heads)) if (known.get(p) !== id && typeof files[p] === "string") write[p] = files[p];
    for (const p of known.keys()) if (!(p in heads)) remove.push(p);
    return { write, remove };
  }

  // Runs a command in the session's shell, then commits what it changed. commit: false keeps the changes in the
  // shell (a fork's); owns(path): only those files are committed (a part's). keepState: false leaves cwd and env.
  async function exec(ws, context, { command, timeoutMs, cwd = null, keepState = true, toolUseId = null, commit = true, owns = null }) {
    const host = context.host;
    if (!host?.shell) throw new Error("No tab is open to run the shell in.");
    const key = keyOf(context, ws), s = session(key);
    await ws.exclusive(() => {}); // the files as other workspaces left them
    const heads = { ...ws.state.project.heads }, files = ws.state.files;
    const base = { op: "exec", key, projectId: ws.state.project.id, threadId: context.threadId ?? null, command, cwd: cwd ?? s.cwd, env: s.env, timeoutMs };
    const send = full => host.shell(full ? { ...base, shellId: null, seed: textFiles(heads, files) } : { ...base, shellId: s.shellId, delta: deltaOf(s.known, heads, files) }, { signal: context.signal });
    let reply;
    try {
      reply = await send(!s.shellId);
      if (reply.unseeded) reply = await send(true);
    } catch (e) {
      s.shellId = null;
      throw e;
    }
    s.shellId = reply.shellId ?? null;
    // What was sent is what the shell has.
    s.known = new Map(Object.entries(heads));
    if (reply.killed) return { ...reply, saved: [], skipped: [] };
    const saved = [], skipped = [];
    if (reply.changed?.length) await ws.exclusive(async () => {
      for (const c of reply.changed) {
        if (commit === false || (owns && !owns(c.path))) { if (!c.deleted || c.path in ws.state.project.heads) skipped.push(c.path); continue; }
        if (c.deleted) {
          if (c.path in ws.state.project.heads) { await ws.remove(c.path); saved.push({ path: c.path, deleted: true }); }
          s.known.delete(c.path);
          continue;
        }
        const { version, changed } = await ws.commit(c.path, c.text, { source: "shell", toolUseId });
        s.known.set(c.path, version.id);
        if (changed) saved.push({ path: c.path, version: version.id });
      }
    });
    if (keepState) { s.cwd = reply.cwd ?? s.cwd; s.env = reply.env ?? s.env; }
    return { ...reply, saved, skipped };
  }

  async function bash(input, context = {}) {
    try {
      const { command = "", timeout = null, restart = false } = input && typeof input === "object" ? input : {};
      if (typeof command !== "string") return { error: "command must be a string, e.g. { \"command\": \"ls\" }" };
      if (!context.host?.shell) return { error: "No tab is open to run the shell in." };
      const ws = await workspaceFor(context, { create: true });
      if (restart) {
        const key = keyOf(context, ws);
        await context.host.shell({ op: "restart", key, threadId: context.threadId ?? null }, { signal: context.signal });
        sessions.delete(key);
        if (!command.trim()) return { restarted: true, cwd: SHELL_ROOT };
      }
      if (!command.trim()) return { error: "command is empty: give a bash command, e.g. ls" };
      const secs = Math.min(MAX_TIMEOUT, Math.max(1, Number(timeout) || (PYTHON.test(command) ? PYTHON_TIMEOUT : DEFAULT_TIMEOUT)));
      const r = await exec(ws, context, { command, timeoutMs: secs * 1000, toolUseId: context.toolUseId ?? null, commit: context.shell?.commit, owns: context.shell?.owns });
      const out = { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exitCode, ms: r.ms };
      if (r.cwd && r.cwd !== SHELL_ROOT) out.cwd = r.cwd;
      if (r.saved.length) out.files = r.saved;
      const notes = [];
      if (r.kept?.binary?.length) notes.push(`Kept in the shell, not in the project's versions (binary): ${r.kept.binary.slice(0, 10).join(", ")}${r.kept.binary.length > 10 ? ", …" : ""}.`);
      if (r.skipped.length) notes.push(context.shell?.commit === false
        ? `Not saved: a fork doesn't change files, so ${clip(r.skipped.join(", "), 200)} stay${r.skipped.length > 1 ? "" : "s"} in its own shell. Put what should change in your answer.`
        : `Not saved: ${clip(r.skipped.join(", "), 200)} ${r.skipped.length > 1 ? "aren't" : "isn't"} yours. This part changes only its own files.`);
      const media = [...(r.images ?? [])];
      const reports = [];
      for (const path of r.opens ?? []) {
        const ran = await runApp({ path }, context);
        if (ran?.error) notes.push(`open ${path}: ${ran.error}`);
        else { reports.push({ path, report: ran.report }); media.push(...(ran.__media ?? [])); }
      }
      if (reports.length === 1) out.report = reports[0].report;
      else if (reports.length) out.opened = reports;
      if (notes.length) out.notes = notes;
      return media.length ? { ...out, __media: media.slice(0, 4) } : out;
    } catch (e) {
      if (context.signal?.aborted) throw e;
      return { error: e?.message || String(e) };
    }
  }

  // The director's check: { kind: "command", run, exit = 0, stdout? }, run from /project in the run's shell.
  async function runCommandCheck(check, { ws, host, threadId = null, agentId = null, signal = null } = {}) {
    if (!ws?.state?.project) return { result: "fail", evidence: "no project is open, so the command has nothing to run on yet" };
    if (!host?.shell) return { result: "not run", evidence: "not run: no tab is open to run the shell in" };
    const r = await exec(ws, { host, threadId, agentId, signal }, { command: check.run, cwd: SHELL_ROOT, keepState: false, timeoutMs: CHECK_TIMEOUT * 1000 });
    const want = check.exit ?? 0, text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    const t = testCounts(text), counts = t ? ` (${t.passed} passed, ${t.failed} failed)` : "";
    const tail = clip(text.trim().split("\n").filter(Boolean).slice(-3).join(" / "), 200);
    if (r.exitCode !== want) return { result: "fail", evidence: `\`${clip(check.run, 80)}\` exited ${r.exitCode}, not ${want}${counts}${tail ? `: ${tail}` : ""}` };
    if (check.stdout != null && !text.includes(String(check.stdout))) return { result: "fail", evidence: `\`${clip(check.run, 80)}\` exited ${r.exitCode}, but its output lacks "${clip(check.stdout, 60)}"${tail ? `: ${tail}` : ""}` };
    return { result: "pass", evidence: `\`${clip(check.run, 80)}\` exited ${r.exitCode}${counts}` };
  }

  return { bash, runCommandCheck, sessions };
}
