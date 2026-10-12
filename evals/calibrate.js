// How often the judge agrees with hand grades. node evals/calibrate.js [file.json ...]
// Each file under evals/calibration/ is an array of { task, answer | dialogue, criteria: { criterion: true | false } }.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tasks from "./tasks.js";
import { criteriaOf, judge } from "./judge.js";

const here = path.dirname(fileURLToPath(import.meta.url));
process.loadEnvFile(path.join(here, "..", ".env"));
const dir = path.join(here, "calibration");
const files = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(dir).filter(f => f.endsWith(".json")).map(f => path.join(dir, f));
const items = files.flatMap(f => JSON.parse(readFileSync(f, "utf8")).map((item, i) => ({ ...item, where: `${path.basename(f)}#${i}` })));

let agree = 0, judged = 0, unjudged = 0, tokens = 0;
const rows = await Promise.all(items.map(async item => {
  const task = tasks.find(t => t.id === item.task) ?? { id: item.task };
  const known = criteriaOf(task);
  const criteria = Object.keys(item.criteria);
  const strays = criteria.filter(c => !known.includes(c));
  const turns = task.turns?.flatMap(t => (typeof t === "string" ? [{ role: "user", text: t }] : t.said ? [{ role: "user", text: t.said[0] }, { role: "assistant", text: t.said[1] }] : [])) ?? [];
  const dialogue = item.dialogue ?? [...turns, { role: "assistant", text: item.answer }];
  return { item, strays, verdict: await judge({ dialogue, calls: item.calls ?? [] }, task, { criteria }) };
}));
for (const { item, strays, verdict } of rows) {
  tokens += verdict.tokens.input + verdict.tokens.output;
  unjudged += verdict.unjudged.length;
  const misses = verdict.graded.filter(g => g.pass !== item.criteria[g.criterion]);
  judged += verdict.graded.length;
  agree += verdict.graded.length - misses.length;
  console.log(`${verdict.unjudged.length ? "UNJ " : misses.length ? "DIFF" : "ok  "} ${item.where} ${item.task}: ${verdict.graded.length - misses.length}/${verdict.graded.length}${verdict.error ? ` (${verdict.error})` : ""}`);
  for (const c of strays) console.log(`     not in ${item.task}'s rubric: ${c}`);
  for (const g of misses) console.log(`     hand ${item.criteria[g.criterion]}, judge ${g.pass}: ${g.criterion}\n       ${g.reason}`);
}
console.log(`agreement ${judged ? ((100 * agree) / judged).toFixed(1) : "n/a"}% on ${judged} criteria over ${items.length} answers${unjudged ? `, ${unjudged} unjudged` : ""}; judge tokens ${tokens}`);
