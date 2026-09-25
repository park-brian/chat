import assert from "node:assert/strict";
import { modelCost, periodKey } from "../accounting.js";

const sunday = new Date("2026-09-27T23:59:59Z");
assert.equal(periodKey("daily", sunday), "PERIOD#daily#2026-09-27");
assert.equal(periodKey("weekly", sunday), "PERIOD#weekly#2026-09-21");
assert.equal(periodKey("weekly", new Date("2026-09-28T00:00:00Z")), "PERIOD#weekly#2026-09-28");
assert.equal(periodKey("monthly", sunday), "PERIOD#monthly#2026-09-01");
assert.equal(periodKey("monthly", new Date("2026-10-01T00:00:00Z")), "PERIOD#monthly#2026-10-01");
assert.equal(periodKey("daily", sunday, 1), "PERIOD#daily#2026-09-27#E1");
assert.equal(periodKey("daily", sunday, 2), "PERIOD#daily#2026-09-27#E2");
assert.throws(() => periodKey("daily", sunday, -1), /epoch/);
assert.equal(modelCost({ inputTokens: 100, outputTokens: 20,
  cacheReadInputTokens: 40, cacheWriteInputTokens: 10 },
  { inputRate: 3000000, outputRate: 15000000,
    cacheReadRate: 300000, cacheWriteRate: 3750000 }), 650);
assert.equal(modelCost({ inputTokens: 1, outputTokens: 0 }, { inputRate: 250000 }), 0);
// Gemini reports cache reads inside promptTokenCount; its adapter separates them.
assert.equal(modelCost({ inputTokens: 75, cacheReadInputTokens: 25,
  outputTokens: 10, cacheWriteInputTokens: 0 },
{ inputRate: 750000, cacheReadRate: 75000, outputRate: 3750000 }), 96);
assert.throws(() => modelCost({ inputTokens: -1, outputTokens: 1 }, { inputRate: 1 }), /Invalid/);
console.log("PASS: on-demand UTC periods and provider-normalized cache meters");
