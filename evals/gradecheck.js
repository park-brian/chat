// Runs a task's check against a folder of files, as eval.js would, without a model.
// node evals/gradecheck.js <task-id> <folder>
import { chromium } from "playwright";
import { readFileSync, readdirSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import tasks from "./tasks.js";

const [, , taskId, dir] = process.argv;
if (!taskId || !dir) throw new Error("usage: node evals/gradecheck.js <task-id> <folder>");
const task = tasks.find(t => t.id === taskId) ?? (() => { throw new Error("Unknown task: " + taskId); })();
const files = Object.fromEntries(readdirSync(dir).map(f => [f, readFileSync(path.join(dir, f), "utf8")]));
const server = http.createServer((q, r) => { const f = Object.hasOwn(files, q.url.slice(1)) ? files[q.url.slice(1)] : undefined; r.writeHead(f ? 200 : 404, { "Content-Type": /.m?js$/.test(q.url) ? "text/javascript" : "text/html" }); r.end(f ?? ""); }).listen(0, "localhost");
const browser = await chromium.launch({ headless: false, args: ["--window-position=-32000,-32000", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"] });
const context = await browser.newContext();
const probe = async (file, fn) => { const p = await context.newPage(); try { await p.goto(`http://localhost:${server.address().port}/${file}`); await p.waitForTimeout(1500); return await p.evaluate(fn); } catch (e) { return "probe error: " + e.message.split("\n")[0]; } finally { await p.close(); } };
const run = { files, report: { ok: true, tests: { passed: 99, failed: 0 } }, calls: [], answer: "", results: "", answers: [], metrics: {}, probe };
for (const [ok, label] of await task.check(run)) console.log(ok ? "ok  " : "FAIL", label);
await browser.close(); server.close();
