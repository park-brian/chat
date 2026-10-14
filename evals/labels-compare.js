// The judge against hand labels: per criterion, how often it passes what a careful grader passed, and fails what the
// grader failed. node evals/labels-compare.js <labels.json> <regrade --out file.json> [prefix]
// labels.json: [{ file: "<prefix>-<run>.md", labels: [bool per criterion] }]; the regrade file has old and new grades.
import { readFileSync } from "node:fs";

const [labelsFile, judgedFile, prefix = ""] = process.argv.slice(2);
const labels = JSON.parse(readFileSync(labelsFile, "utf8"));
const judged = JSON.parse(readFileSync(judgedFile, "utf8"));
const criteria = [...new Set(judged.map(r => r.criterion))];
const pct = (a, b) => (b ? `${a}/${b}` : "-");
for (const [i, criterion] of criteria.entries()) {
  const t = { n: 0, good: 0, bad: 0, nowPassGood: 0, nowFailBad: 0, oldPassGood: 0, oldFailBad: 0 };
  for (const l of labels) {
    const run = l.file.replace(prefix, "").replace(/\.md$/, "");
    const j = judged.find(r => r.criterion === criterion && r.dir.split(/[\\/]/).at(-1) === run);
    if (!j) continue;
    const hand = l.labels[i], now = j.grades.filter(Boolean).length * 2 > j.grades.length;
    t.n++;
    if (hand) { t.good++; t.nowPassGood += +now; t.oldPassGood += +j.old; }
    else { t.bad++; t.nowFailBad += +!now; t.oldFailBad += +!j.old; }
  }
  console.log(`${criterion.slice(0, 70)}\n  hand: ${t.good} good, ${t.bad} bad · passes the good: old ${pct(t.oldPassGood, t.good)}, now ${pct(t.nowPassGood, t.good)} · fails the bad: old ${pct(t.oldFailBad, t.bad)}, now ${pct(t.nowFailBad, t.bad)}`);
}
