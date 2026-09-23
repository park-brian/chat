// Pure budget periods and Bedrock Converse token pricing; no reset worker.
export function periodKey(period, now = new Date()) {
  if (!["daily", "weekly", "monthly"].includes(period)) throw Error("Invalid budget period");
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === "monthly") start.setUTCDate(1);
  if (period === "weekly") start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
  return `PERIOD#${period}#${start.toISOString().slice(0, 10)}`;
}

export function modelCost(usage, model) {
  const meters = ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheWriteInputTokens"];
  const rates = ["inputRate", "outputRate", "cacheReadRate", "cacheWriteRate"];
  if (meters.some((name) => !Number.isSafeInteger(usage[name] || 0) || usage[name] < 0) ||
    rates.some((name) => !Number.isSafeInteger(model[name] || 0) || model[name] < 0))
    throw Error("Invalid token usage or model rates");
  // Converse inputTokens excludes cache reads/writes; each is a separate meter.
  const microUsd = meters.reduce((sum, name, index) =>
    sum + (usage[name] || 0) * (model[rates[index]] || 0), 0) / 1000000;
  if (!Number.isSafeInteger(Math.round(microUsd))) throw Error("Model cost overflow");
  return Math.round(microUsd);
}
