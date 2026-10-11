// Every model and tool step of a turn is recorded as it happens: the step row,
// the budget period, the day rollup and the request total commit in one
// transaction. A step whose usage the provider never reported is still
// recorded, with estimated tokens and quality "unknown", so failures are never
// free and never silently zero.
import { modelCost, modelRates } from "./accounting.js";
import { expression, fail, get, pack, sk, transact, userKey } from "./db.js";

const emptyUsage = () => ({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
});
export { emptyUsage };

// About four characters per token: a deliberately rough, conservative stand-in
// used only when the provider reported nothing.
export function estimateUsage(promptText, outputText) {
  const inputTokens = Math.ceil(promptText.length / 4),
    outputTokens = Math.ceil(outputText.length / 4);
  return {
    ...emptyUsage(),
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

export function createMeter({
  sub,
  requestId,
  projectId,
  conversationId,
  branchId,
  agentId,
  modelId,
  model,
  period,
  budgetMicroUsd,
}) {
  const requestKey = userKey(sub, sk.request(requestId));
  let costMicroUsd = 0,
    steps = 0;
  const common = {
    userSub: sub,
    requestId,
    projectId,
    conversationId,
    branchId,
    agentId,
  };
  // Usage rows also feed the administrator's combined view by time.
  const usageRow = (occurredAt, kind, row) => ({
    Put: {
      Item: {
        ...userKey(sub, sk.usage(`${occurredAt}#${requestId}#${kind}#${steps}`)),
        ...pack({
          gsi1pk: "USAGE",
          gsi1sk: `${occurredAt}#${sub}#${requestId}#${kind}#${steps}`,
          occurredAt,
          kind: kind.toLowerCase(),
          step: steps,
          ...common,
          ...row,
        }),
      },
      ConditionExpression: "attribute_not_exists(pk)",
    },
  });
  const rollups = (occurredAt, totals) => {
    const day = occurredAt.slice(0, 10);
    return [
      { Update: { Key: userKey(sub, period), ...expression({ add: totals }) } },
      {
        Update: {
          Key: userKey(sub, sk.day(day)),
          ...expression({
            add: totals,
            set: {
              gsi1pk: "USAGE_DAYS",
              gsi1sk: `${day}#${sub}`,
              userSub: sub,
              day,
            },
          }),
        },
      },
    ];
  };
  const requestTotals = (occurredAt, add) => ({
    Update: {
      Key: requestKey,
      ...expression({
        add,
        set: { lastMeteredAt: occurredAt },
        condition: "attribute_exists(pk)",
      }),
    },
  });

  return {
    get costMicroUsd() {
      return costMicroUsd;
    },
    // Spend is re-read before every step, so a turn stops at the budget instead
    // of running every remaining step on an exhausted one.
    async checkBudget() {
      const spent = await get(userKey(sub, period));
      if ((spent?.costMicroUsd || 0) >= budgetMicroUsd)
        fail("BUDGET_EXHAUSTED");
    },
    async model(usage, quality = "estimated") {
      const occurredAt = new Date().toISOString();
      const cost = modelCost(usage, model);
      const rates = modelRates(usage, model);
      await transact([
        usageRow(occurredAt, "MODEL", {
          modelId,
          costMicroUsd: cost,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens || 0,
          cacheWriteInputTokens: usage.cacheWriteInputTokens || 0,
          inputRate: rates.inputRate || 0,
          outputRate: rates.outputRate || 0,
          cacheReadRate: rates.cacheReadRate || 0,
          cacheWriteRate: rates.cacheWriteRate || 0,
          pricingSource: model.pricingSource || "",
          pricingQuality: model.pricingQuality || "unknown",
          quality,
        }),
        ...rollups(occurredAt, {
          costMicroUsd: cost,
          [quality === "unknown" ? "unknownModelCalls" : "estimatedModelCalls"]: 1,
        }),
        requestTotals(occurredAt, { costMicroUsd: cost, modelSteps: 1 }),
      ]);
      steps++;
      costMicroUsd += cost;
      return cost;
    },
    // Tools are recorded but unpriced: AgentCore bills them by session time,
    // which is recorded separately when each session closes.
    async tool({ name, latencyMs, isError }) {
      const occurredAt = new Date().toISOString();
      await transact([
        usageRow(occurredAt, "TOOL", {
          name,
          costMicroUsd: 0,
          latencyMs,
          isError,
          quality: "unpriced",
        }),
        ...rollups(occurredAt, { unpricedToolCalls: 1 }),
        requestTotals(occurredAt, { toolSteps: 1 }),
      ]);
      steps++;
    },
  };
}
