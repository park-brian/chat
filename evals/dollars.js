// Runs in dollars, by the model of each message (sub-agents included), at Anthropic's first-party list prices per
// million tokens (cached 2026-10-06; Bedrock's partner prices may differ). node evals/dollars.js <eval folder> [...]
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// [input, output, cache read, cache write] per 1M tokens. Haiku's cache prices aren't listed: 0.1× and 1.25× input.
export const PRICES = {
  haiku: [0.1, 0.5, 0.01, 0.125],
  sonnet: [2, 10, 0.2, 2.5],
  opus: [4, 20, 0.2, 5],
};
const family = id => Object.keys(PRICES).find(k => String(id ?? "").includes(k));

export function dollars(messages) {
  let total = 0;
  const by = {};
  for (const m of messages) {
    const u = m.usage, f = family(m.modelId);
    if (!u || !f) continue;
    const [i, o, r, w] = PRICES[f];
    const d = ((u.inputTokens ?? 0) * i + (u.outputTokens ?? 0) * o + (u.cacheReadInputTokens ?? 0) * r + (u.cacheWriteInputTokens ?? 0) * w) / 1e6;
    total += d;
    by[f] = (by[f] ?? 0) + d;
  }
  return { total, by };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"))) {
  for (const dir of process.argv.slice(2)) {
    const runs = readdirSync(dir, { recursive: true }).filter(f => path.basename(f) === "result.json").map(f => JSON.parse(readFileSync(path.join(dir, f), "utf8")));
    const rows = runs.map(r => ({ task: r.task, score: r.error ? "unfinished" : `${r.passed}/${r.total}`, ...dollars([...(r.messages ?? []), ...(r.subagents ?? [])]) }));
    console.log(`${path.basename(dir)}: ${rows.map(r => `${r.score} $${r.total.toFixed(2)}${Object.keys(r.by).length > 1 ? ` (${Object.entries(r.by).map(([k, v]) => `${k} $${v.toFixed(2)}`).join(", ")})` : ""}`).join(" · ")}`);
  }
}
