import assert from "node:assert/strict";
import models from "../models.json" with { type: "json" };
import { validModelId } from "../model-id.js";

const region = "us-east-1";
const account = "285397596138";
for (const id of [
  "us.anthropic.claude-sonnet-5",
  "us.amazon.nova-micro-v1:0",
  "arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-micro-v1:0",
  "arn:aws:bedrock:us-east-1:285397596138:inference-profile/example",
]) assert.equal(validModelId(id, region, account), true, id);
for (const id of [
  "", "test/echo", "us.anthropic.model xyz",
  "arn:aws:bedrock:eu-west-1:285397596138:inference-profile/example",
  "arn:aws:bedrock:us-east-1:000000000000:inference-profile/example",
  "arn:aws:bedrock:us-east-1:285397596138:foundation-model/example",
]) assert.equal(validModelId(id, region, account), false, id);

assert.equal(new Set(models.map((model) => model.id)).size, models.length);
assert.deepEqual(new Set(models.map((model) => model.company)),
  new Set(["Anthropic", "OpenAI", "Google"]));
for (const model of models) {
  assert.match(model.source, /^https:\/\//);
  assert.ok(Number.isSafeInteger(model.contextTokens) && model.contextTokens >= 65536);
  assert.ok(Number.isSafeInteger(model.maxOutputTokens) &&
    model.maxOutputTokens > 4096 && model.maxOutputTokens <= model.contextTokens);
  assert.ok(Array.isArray(model.thinkingLevels) && model.thinkingLevels.length);
  assert.equal(new Set(model.thinkingLevels).size, model.thinkingLevels.length);
  assert.ok(model.thinkingLevels.includes(model.defaultThinkingLevel));
  if (model.transport === "bedrock") {
    assert.equal(validModelId(model.id, region, account), true);
    for (const rate of ["inputRate", "outputRate", "cacheReadRate", "cacheWriteRate"])
      assert.ok(Number.isSafeInteger(model[rate]) && model[rate] >= 0, rate);
    assert.match(model.pricingSource, /^https:\/\//);
    assert.equal(model.pricingQuality, "aws-offer-global-standard");
  } else {
    assert.equal(model.transport, "gemini");
    assert.ok(model.pricingExpiresAt, "Promotional prices need an end date");
  }
}
console.log("PASS: checked-in model candidates and exact Bedrock ID shapes");
