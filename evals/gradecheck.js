// Runs a task's check against a folder of files, as eval.js would, without a model.
// node evals/gradecheck.js <task-id> <folder>
import { chromium } from "playwright";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { startServer } from "../server.js";
import tasks from "./tasks.js";

const [, , taskId, dir] = process.argv;
if (!taskId || !dir) throw new Error("usage: node evals/gradecheck.js <task-id> <folder>");
const task = tasks.find(t => t.id === taskId) ?? (() => { throw new Error("Unknown task: " + taskId); })();
// Every file under the folder, keyed by its path with forward slashes, as the workspace names them.
const files = Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => {
  const full = path.join(e.parentPath, e.name);
  return [path.relative(dir, full).split(path.sep).join("/"), readFileSync(full, "utf8")];
}));
const server = await startServer(0, dir);
const browser = await chromium.launch({ headless: false, args: ["--window-position=-32000,-32000", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"] });
const context = await browser.newContext();
const probe = async (file, fn) => { if (!file || !files[file]) return null; const p = await context.newPage(); try { await p.goto(`http://localhost:${server.address().port}/${file}`); await p.waitForTimeout(1500); return await p.evaluate(fn); } catch (e) { return "probe error: " + e.message.split("\n")[0]; } finally { await p.close(); } };
const run = { files, report: { ok: true, tests: { passed: 99, failed: 0 } }, calls: [], answer: "", results: "", answers: [], dialogue: [], metrics: {}, probe };
try {
  for (const [ok, label] of await task.check(run)) console.log(ok ? "ok  " : "FAIL", label);
} finally {
  await browser.close();
  server.closeAllConnections();
  server.close();
}
