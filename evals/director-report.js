// What the director did to a set of runs, and what it cost: per results folder, the code checks, the plain-writing
// grade, the vocabulary leak in the final reply, calls, tokens, time and the notes that fired.
// node evals/director-report.js <eval folder> [...]
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

// E6's leak: contract words in the reply the user reads, code left out.
export const LEAK = /\bitems? \d|\bthe check\b|\bthe harness\b|\bplan (?:items?|checks?)\b|\bcontract\b/i;
const prose = t => t.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");

// The last assistant message's own text: what the user reads as the answer.
export function finalReply(messages = []) {
  const last = messages.filter(m => m.role === "assistant" && (m.content ?? []).some(c => typeof c.text === "string" && c.text.trim())).at(-1);
  return (last?.content ?? []).filter(c => typeof c.text === "string" && !c.harness).map(c => c.text).join("\n");
}

export function summarizeRuns(all) {
  // A run that didn't finish (a crash, the eval's own timeout) has no checks to count.
  const results = all.filter(r => !r.error), n = results.length;
  const mean = f => n ? results.reduce((a, r) => a + f(r), 0) / n : 0;
  const check = (r, re) => r.checks.find(c => re.test(c.label));
  const notes = {};
  for (const r of results) for (const [k, v] of Object.entries(r.metrics?.steered ?? {})) notes[k] = (notes[k] ?? 0) + v;
  return {
    runs: n, unfinished: all.length - n,
    hidden: mean(r => +!!check(r, /^fixes the issue/)?.ok),
    plain: mean(r => +(check(r, /^judge: States things literally/)?.ok ?? true)),
    leak: results.filter(r => LEAK.test(prose(finalReply(r.messages)))).length,
    pass: mean(r => r.passed / r.total),
    calls: mean(r => r.metrics?.calls ?? 0),
    kTokIn: mean(r => (r.metrics?.inputTokens ?? 0) / 1000),
    sec: mean(r => r.metrics?.seconds ?? 0),
    goalRuns: results.filter(r => r.metrics?.steered?.goal).length,
    notes,
  };
}

const load = dir => readdirSync(dir, { recursive: true }).filter(f => path.basename(f) === "result.json").map(f => JSON.parse(readFileSync(path.join(dir, f), "utf8")));

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"))) {
  for (const dir of process.argv.slice(2)) {
    if (!existsSync(dir)) { console.log(`${dir}: not found`); continue; }
    const results = load(dir);
    const s = summarizeRuns(results);
    console.log(`${path.basename(dir)} flags=${results[0]?.flags ? JSON.stringify(results[0].flags) : "none"}`);
    console.log(`  runs ${s.runs}${s.unfinished ? ` (+${s.unfinished} unfinished)` : ""} · pass ${s.pass.toFixed(2)} · hidden ${s.hidden.toFixed(2)} · plain ${s.plain.toFixed(2)} · leak ${s.leak}/${s.runs} · calls ${s.calls.toFixed(1)} · kTokIn ${s.kTokIn.toFixed(0)} · sec ${s.sec.toFixed(0)} · goal note in ${s.goalRuns}`);
    console.log(`  notes ${JSON.stringify(s.notes)}`);
  }
}
