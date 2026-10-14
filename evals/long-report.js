// Long-tier runs check by check: which kinds of check each arm loses, so a plan's effect on continuity, threads or
// the ending can be told apart from noise in the total. node evals/long-report.js <eval folder> [...]
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// A check's kind: its label up to the first number or parenthesis ("chapter 4 contradicts…" → "chapter N contradicts").
const kind = label => label.replace(/^judge: /, "judge: ").replace(/\(.*$/, "").replace(/\d+/g, "N").replace(/\s+—.*$/, "").trim().slice(0, 70);

for (const dir of process.argv.slice(2)) {
  const runs = readdirSync(dir, { recursive: true }).filter(f => path.basename(f) === "result.json").map(f => JSON.parse(readFileSync(path.join(dir, f), "utf8")));
  console.log(`== ${path.basename(dir)}`);
  for (const task of [...new Set(runs.map(r => r.task))].sort()) {
    const mine = runs.filter(r => r.task === task);
    const scores = mine.map(r => (r.error ? `unfinished${r.partial ? ` ${r.partial.passed}/${r.partial.total}` : ""}` : `${r.passed}/${r.total}`));
    const failed = {};
    for (const r of mine.filter(r => !r.error)) for (const c of r.checks.filter(c => !c.ok)) failed[kind(c.label)] = (failed[kind(c.label)] ?? 0) + 1;
    const cost = mine.map(r => Math.round((r.metrics?.costTokens ?? 0) / 1000) + "k").join(" ");
    console.log(`  ${task}: ${scores.join(", ")} · cost ${cost}`);
    for (const [k, n] of Object.entries(failed).sort((a, b) => b[1] - a[1])) console.log(`    ${n}× ${k}`);
  }
}
