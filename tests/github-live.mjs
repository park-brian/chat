// Live check of GitHub projects against a real repository: connect, read, commit, push a branch, open a pull
// request, then close it and delete the branch. Needs a token with access to the repository:
//   GITHUB_TOKEN=... node tests/github-live.mjs [owner/repo]
// Defaults to the throwaway park-brian/chat-harness-sandbox. Exits nonzero on any failure.
import assert from "node:assert/strict";
import { connectGitHub, createGitHubRoot, GITHUB_API } from "../projects.js";

const [owner, repo] = (process.argv[2] ?? "park-brian/chat-harness-sandbox").split("/");
const token = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;
assert.ok(token, "set GITHUB_TOKEN (or GITHUB_PAT) to a token with access to the repository");
const api = (method, path, body) =>
  fetch(GITHUB_API + path, { method, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", ...(body && { "Content-Type": "application/json" }) }, body: body && JSON.stringify(body) });

const record = await connectGitHub({ owner, repo, token });
console.log(`connected ${owner}/${repo}@${record.branch} (${Object.keys(record.base.files).length} files, base ${record.base.commit.slice(0, 7)})`);
let working = {};
const root = createGitHubRoot(record, { token: () => token, files: async () => working });

const original = await root.read("index.js");
assert.ok(original?.includes("module.exports") || original?.includes("export"), "index.js reads as text");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
working = { "index.js": original + `\n// harness live test ${stamp}\n` };

const status = await root.git.status();
assert.ok(status.some(s => s.path === "index.js" && s.status === "modified"), `status shows the change: ${JSON.stringify(status)}`);
await root.git.commit({ message: `Live test ${stamp}` });

await assert.rejects(() => root.git.push({ branch: record.defaultBranch }), /default branch/, "pushing to the default branch needs confirmation");
const branch = `agent/live-${stamp}`;
const pushed = await root.git.push({ branch });
console.log(`pushed ${pushed.branch} at ${pushed.commit.slice(0, 7)}`);

const onBranch = await api("GET", `/repos/${owner}/${repo}/contents/index.js?ref=${encodeURIComponent(branch)}`).then(r => r.json());
assert.ok(Buffer.from(onBranch.content, "base64").toString().includes(`harness live test ${stamp}`), "the branch has the change");

const pr = await root.git.openPullRequest({ title: `Live test ${stamp}`, body: "Opened by tests/github-live.mjs; closed by it too." });
console.log(`opened PR #${pr.number} ${pr.url}`);
const fetched = await api("GET", `/repos/${owner}/${repo}/pulls/${pr.number}`).then(r => r.json());
assert.equal(fetched.head.ref, branch, "the pull request is from the pushed branch");

await api("PATCH", `/repos/${owner}/${repo}/pulls/${pr.number}`, { state: "closed" });
const deleted = await api("DELETE", `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`);
assert.equal(deleted.status, 204, "the branch is deleted");
console.log("PASS: GitHub project live: connect, read, status, commit, default-branch guard, push, pull request, cleanup");
