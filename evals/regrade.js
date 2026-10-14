// Saved runs graded again with the current graders, so a grader change is tried on runs whose answers are known
// before it judges new ones. The judge runs --repeat times per run (default 3), which also measures its own noise.
// node evals/regrade.js <eval folder> [...] [--repeat n] [--votes n] [--criterion text] [--scripted]
// --out file.json: every grade, { dir, criterion, old, grades }, for comparing with hand labels.
// --votes: each repeat is the majority of n judge calls, as eval.js grades (default 1: one call).
// --scripted also re-runs each task's scripted checks on the saved files (probes of pages are skipped).
import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import TASKS from "./tasks.js";
import { conversationView } from "../eval.js";
import { criteriaOf, vote } from "./judge.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export function savedRun(dir) {
  const saved = JSON.parse(readFileSync(path.join(dir, "result.json"), "utf8"));
  const root = path.join(dir, "files");
  const files = existsSync(root) ? Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => {
    const full = path.join(e.parentPath, e.name);
    return [path.relative(root, full).split(path.sep).join("/"), readFileSync(full, "utf8")];
  })) : {};
  return { saved, run: { ...conversationView(saved.messages ?? []), files, answers: [], report: null, metrics: saved.metrics ?? {}, probe: async () => null } };
}

// Per criterion: how often the new majority agrees with the saved grade, and how often all repeats agree.
export function tally(rows) {
  const by = new Map();
  for (const { criterion, old, grades } of rows) {
    const t = by.get(criterion) ?? { n: 0, same: 0, stable: 0, oldPass: 0, newPass: 0 };
    const yes = grades.filter(Boolean).length, majority = yes * 2 > grades.length;
    t.n++;
    t.same += +(old === majority);
    t.stable += +(yes === 0 || yes === grades.length);
    t.oldPass += +!!old;
    t.newPass += +majority;
    by.set(criterion, t);
  }
  return by;
}

async function main() {
  process.loadEnvFile(path.join(here, "..", ".env"));
  const args = process.argv.slice(2);
  const opt = name => { const i = args.indexOf(name); return i < 0 ? null : args.splice(i, 2)[1]; };
  const repeat = Number(opt("--repeat") ?? 3), votes = Number(opt("--votes") ?? 1), only = opt("--criterion"), out = opt("--out");
  const scripted = args.includes("--scripted") && args.splice(args.indexOf("--scripted"), 1);
  const dirs = args.flatMap(d => readdirSync(d, { recursive: true }).filter(f => path.basename(f) === "result.json").map(f => path.join(d, path.dirname(f))));
  const rows = [];
  await Promise.all(dirs.map(async dir => {
    const { saved, run } = savedRun(dir);
    const task = TASKS.find(t => t.id === saved.task);
    if (!task || saved.error) return;
    const criteria = criteriaOf(task).filter(c => !only || c.includes(only));
    if (scripted) {
      const now = (await task.check(run)).map(([ok, label]) => ({ ok: !!ok, label }));
      for (const c of now) {
        const was = saved.checks.find(s => s.label.split(" (")[0] === c.label.split(" (")[0]);
        if (was && was.ok !== c.ok) console.log(`CHECK ${path.relative(process.cwd(), dir)}: ${was.ok ? "pass → fail" : "fail → pass"} ${c.label}`);
      }
    }
    if (!criteria.length) return;
    const verdicts = await Promise.all(Array.from({ length: repeat }, () => vote(run, task, { criteria, votes })));
    for (const criterion of criteria) {
      const old = saved.checks.find(c => c.label === "judge: " + criterion);
      const grades = verdicts.map(v => v.graded.find(g => g.criterion === criterion)).filter(Boolean);
      if (!old || !grades.length) continue;
      rows.push({ dir, criterion, old: old.ok, grades: grades.map(g => g.pass) });
      const majority = grades.filter(g => g.pass).length * 2 > grades.length;
      if (majority !== old.ok) console.log(`FLIP ${path.relative(process.cwd(), dir)}: ${old.ok ? "pass → fail" : "fail → pass"} (${grades.filter(g => g.pass).length}/${grades.length} pass) ${criterion.slice(0, 70)}\n     was: ${String(old.reason ?? "").slice(0, 200)}\n     now: ${grades.find(g => g.pass === majority)?.reason.slice(0, 200)}`);
    }
  }));
  if (out) writeFileSync(out, JSON.stringify(rows, null, 1));
  console.log(`\n${rows.length} grades over ${dirs.length} runs, judge ×${repeat}${votes > 1 ? `, each the majority of ${votes}` : ""}`);
  for (const [criterion, t] of tally(rows)) console.log(`  ${criterion.slice(0, 80)}\n    saved pass ${t.oldPass}/${t.n} · now ${t.newPass}/${t.n} · agrees with saved ${t.same}/${t.n} · repeats agree ${t.stable}/${t.n}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
