// The checked-in model catalog. A model is usable when its transport is
// configured and it carries integer rates, so every call can be priced.
import catalog from "./models.json" with { type: "json" };
import { fail } from "./db.js";

const scripted = {
  id: "test.echo",
  name: "Scripted echo (test only)",
  company: "Other",
  transport: "scripted",
  contextTokens: 1000000,
  maxOutputTokens: 128000,
  thinkingLevels: [],
  browserTool: true,
  // Small nonzero prices so test budgets and costs behave like real ones.
  inputRate: 1000000,
  outputRate: 2000000,
};
const scriptedEnabled = () => process.env.SCRIPTED_MODEL === "true";
// Promotional prices end on pricingExpiresAt (a UTC date). After that day the
// catalog's rates may be wrong, so the model is unavailable until reviewed.
const configured = (model) =>
  (model.transport === "bedrock" ||
    (model.transport === "gemini" && Boolean(process.env.GEMINI_PROVIDER))) &&
  !(Date.parse(`${model.pricingExpiresAt}T23:59:59.999Z`) < Date.now());

export const modelCatalog = () => [
  ...(scriptedEnabled() ? [{ ...scripted, active: true }] : []),
  ...catalog.map((model) => ({ ...model, active: configured(model) })),
];

export function approvedModel(id) {
  if (id === scripted.id) return scriptedEnabled() ? scripted : null;
  const model = catalog.find((entry) => entry.id === id);
  return model &&
    configured(model) &&
    Number.isSafeInteger(model.inputRate) &&
    Number.isSafeInteger(model.outputRate)
    ? model
    : null;
}

// The thinking level a turn runs at: an explicit choice if the model offers
// it, else the agent's saved level for that model, else the model default.
// Null when the model has no levels; an unsupported request fails.
export function thinkingLevelFor(model, requested, agent) {
  if (!model.thinkingLevels.length) {
    if (requested !== undefined) fail("VALIDATION_FAILED");
    return null;
  }
  const saved =
    agent?.modelId === model.id &&
    model.thinkingLevels.includes(agent.thinkingLevel)
      ? agent.thinkingLevel
      : model.defaultThinkingLevel;
  const level = requested ?? saved;
  if (!model.thinkingLevels.includes(level)) fail("VALIDATION_FAILED");
  return level;
}
