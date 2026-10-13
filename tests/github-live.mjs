// Live check of GitHub projects against a real repository: connect, read, commit, push a branch, open a pull
// request; then CI: a commit with a failing test turns the checks red with the failing test in the log, a fix turns
// them green; then close the pull request and delete the branch. Needs a token with access to the repository:
//   GITHUB_TOKEN=... node tests/github-live.mjs [owner/repo]
// Defaults to the throwaway park-brian/chat-harness-sandbox (a node --test workflow on push and pull_request).
// Exits nonzero on any failure.
import assert from "node:assert/strict";
import { connectGitHub, createGitHubRoot, GITHUB_API } from "../projects.js";
import { runProjectGit } from "../shell/project-git.js";

const [owner, repo] = (process.argv[2] ?? "park-brian/chat-harness-sandbox").split("/");
const token = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;
assert.ok(token, "set GITHUB_TOKEN (or GITHUB_PAT) to a token with access to the repository");
const api = (method, path, body) =>
  fetch(GITHUB_API + path, { method, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", ...(body && { "Content-Type": "application/json" }) }, body: body && JSON.stringify(body) });
const began = Date.now();
const secs = (from = began) => `${Math.round((Date.now() - from) / 1000)}s`;

const record = await connectGitHub({ owner, repo, token });
console.log(`connected ${owner}/${repo}@${record.branch} (${Object.keys(record.base.files).length} files, base ${record.base.commit.slice(0, 7)})`);
let working = {};
const root = createGitHubRoot(record, { token: () => token, files: async () => working });
// The shell's gh, on this root: what the bash tool runs for gh on a GitHub project.
const ws = { root, git: root.git };
const sh = (...words) => runProjectGit(ws, ["gh", ...words], { timeoutMs: 10 * 60_000 });

const original = await root.read("index.js");
assert.ok(original?.includes("module.exports") || original?.includes("export"), "index.js reads as text");
const tests = await root.read("test/index.test.js");
const passing = "expect(ms('1m')).to.be(60000);", failing = "expect(ms('1m')).to.be(60001);";
assert.ok(tests?.includes(passing), "the test file has the assertion this breaks");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
working = { "index.js": original + `\n// harness live test ${stamp}\n`, "test/index.test.js": tests.replace(passing, failing) };

const status = await root.git.status();
assert.ok(status.some(s => s.path === "index.js" && s.status === "modified"), `status shows the change: ${JSON.stringify(status)}`);
await root.git.commit({ message: `Live test ${stamp}: a failing test` });

await assert.rejects(() => root.git.push({ branch: record.defaultBranch }), /default branch/, "pushing to the default branch needs confirmation");
const branch = `agent/live-${stamp}`;
let pr = null;
try {
  const pushed = await root.git.push({ branch });
  console.log(`pushed ${pushed.branch} at ${pushed.commit.slice(0, 7)}`);

  const onBranch = await api("GET", `/repos/${owner}/${repo}/contents/index.js?ref=${encodeURIComponent(branch)}`).then(r => r.json());
  assert.ok(Buffer.from(onBranch.content, "base64").toString().includes(`harness live test ${stamp}`), "the branch has the change");

  // Before a pull request, gh pr checks has nothing to report: a CI check is red until there is one.
  const none = await sh("pr", "checks");
  assert.equal(none.exitCode, 1, `no pull request yet: ${JSON.stringify(none)}`);
  assert.match(none.stderr, /no pull requests found/);

  pr = await root.git.openPullRequest({ title: `Live test ${stamp}`, body: "Opened by tests/github-live.mjs; closed by it too." });
  console.log(`opened PR #${pr.number} ${pr.url}`);
  const fetched = await api("GET", `/repos/${owner}/${repo}/pulls/${pr.number}`).then(r => r.json());
  assert.equal(fetched.head.ref, branch, "the pull request is from the pushed branch");
  assert.equal((await root.git.ci.pullRequest()).number, pr.number, "ci.pullRequest finds it from the branch");

  // Red: the failing test fails CI, and the log says which test and why.
  let t = Date.now();
  const red = await root.git.ci.waitForChecks({ sha: pushed.commit, onUpdate: c => console.log(`  ${secs(t)} ${c.state}: ${c.runs.map(r => `${r.name} ${r.status}${r.conclusion ? `/${r.conclusion}` : ""}`).join(", ") || "no checks yet"}`) });
  console.log(`waitForChecks: ${red.state} after ${secs(t)} (${red.runs.length} check runs)`);
  assert.equal(red.state, "failure", `the failing test fails CI: ${JSON.stringify(red.runs.map(r => [r.name, r.conclusion]))}`);
  const failedRun = red.runs.find(r => r.conclusion === "failure");
  assert.ok(failedRun.runId && failedRun.url.includes("/actions/runs/"), `a failed check names its workflow run: ${JSON.stringify(failedRun)}`);
  console.log(`annotations: ${JSON.stringify(failedRun.annotations)}`);
  t = Date.now();
  const log = await root.git.ci.failedLog(failedRun.runId);
  console.log(`failedLog (${log.length} chars, ${secs(t)}):\n${log.split("\n").map(l => "  | " + l).join("\n")}`);
  assert.match(log, /should convert from m to ms/, "the failed log names the failing test");
  assert.match(log, /60001/, "and what it expected");
  assert.ok(!/^\d{4}-\d\d-\d\dT/m.test(log), "without timestamps");

  const checks = await sh("pr", "checks");
  console.log(`gh pr checks -> exit ${checks.exitCode}\n${checks.stdout.trimEnd().split("\n").map(l => "  | " + l).join("\n")}`);
  assert.equal(checks.exitCode, 1, "gh pr checks exits 1 on a failure");
  const view = await sh("run", "view", String(failedRun.runId), "--log-failed");
  assert.equal(view.exitCode, 0);
  assert.match(view.stdout, /should convert from m to ms/, "gh run view --log-failed shows it too");
  const list = await sh("run", "list", "--branch", branch, "--limit", "5");
  console.log(`gh run list -> exit ${list.exitCode}\n${list.stdout.trimEnd().split("\n").map(l => "  | " + l).join("\n")}`);
  assert.ok(list.stdout.includes(String(failedRun.runId)), "gh run list lists the run");

  // Green: the fix, pushed to the same branch, and gh pr checks --watch waits for it.
  working = { ...working, "test/index.test.js": tests };
  await root.git.commit({ message: `Live test ${stamp}: fix the test` });
  const fix = await root.git.push();
  console.log(`pushed the fix at ${fix.commit.slice(0, 7)}`);
  t = Date.now();
  const watched = await sh("pr", "checks", "--watch");
  console.log(`gh pr checks --watch -> exit ${watched.exitCode} after ${secs(t)}\n${watched.stdout.trimEnd().split("\n").map(l => "  | " + l).join("\n")}${watched.stderr}`);
  assert.equal(watched.exitCode, 0, "gh pr checks --watch exits 0 once the fix is green");
  const green = await root.git.ci.checks({ sha: fix.commit });
  assert.equal(green.state, "success", `the fix's checks pass: ${JSON.stringify(green.runs.map(r => [r.name, r.conclusion]))}`);
  const watchRun = await sh("run", "watch");
  assert.equal(watchRun.exitCode, 0, `gh run watch on a passed run exits 0: ${watchRun.stdout}${watchRun.stderr}`);
} finally {
  if (pr) await api("PATCH", `/repos/${owner}/${repo}/pulls/${pr.number}`, { state: "closed" });
  const deleted = await api("DELETE", `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`);
  assert.ok(deleted.status === 204 || deleted.status === 422, `the branch is deleted (${deleted.status})`);
  console.log(`cleaned up: PR ${pr ? `#${pr.number} closed` : "none"}, branch ${deleted.status === 204 ? "deleted" : "absent"}`);
}
console.log(`PASS: GitHub project live in ${secs()}: connect, read, status, commit, default-branch guard, push, pull request, CI red (log names the test), CI green, cleanup`);
