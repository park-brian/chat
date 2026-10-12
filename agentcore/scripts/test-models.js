import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import models from "../runtime/models.json" with { type: "json" };

// Accept Bedrock model/profile IDs and same-account, same-Region ARNs.
// Syntax does not prove model availability, API compatibility, or access.
function validModelId(id, region, account) {
  if (typeof id !== "string" || id.length > 512) return false;
  if (!id.startsWith("arn:")) return /^[a-z0-9][a-z0-9._:-]*$/.test(id);
  const match =
    /^arn:aws:bedrock:([a-z0-9-]+):([0-9]{12})?:(foundation-model|inference-profile|application-inference-profile)\/([a-z0-9][a-z0-9._:-]*)$/.exec(
      id,
    );
  if (!match || match[1] !== region) return false;
  return match[3] === "foundation-model" ? !match[2] : match[2] === account;
}

const region = "us-east-1";
const account = "111122223333";
for (const id of [
  "us.anthropic.claude-sonnet-5",
  "us.amazon.nova-micro-v1:0",
  "arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-micro-v1:0",
  "arn:aws:bedrock:us-east-1:111122223333:inference-profile/example",
])
  assert.equal(validModelId(id, region, account), true, id);
for (const id of [
  "",
  "test/echo",
  "us.anthropic.model xyz",
  "arn:aws:bedrock:eu-west-1:111122223333:inference-profile/example",
  "arn:aws:bedrock:us-east-1:000000000000:inference-profile/example",
  "arn:aws:bedrock:us-east-1:111122223333:foundation-model/example",
])
  assert.equal(validModelId(id, region, account), false, id);

assert.equal(new Set(models.map((model) => model.id)).size, models.length);
const template = await readFile(
  new URL("../template.yaml", import.meta.url),
  "utf8",
);
for (const id of [
  "global.anthropic.claude-haiku-5-5",
  "global.anthropic.claude-sonnet-5-5",
  "global.anthropic.claude-opus-5-5",
  "global.anthropic.claude-fable-5-1",
  "global.openai.gpt-6.1-sol",
  "global.openai.gpt-6-luna",
  "gemini-3.8-flash",
])
  assert.ok(
    models.some((model) => model.id === id),
    `${id} is selectable`,
  );
assert.deepEqual(
  models.find((model) => model.id === "global.openai.gpt-6.1-sol")
    .thinkingLevels,
  ["low", "medium", "high", "xhigh", "max"],
);
assert.deepEqual(
  new Set(models.map((model) => model.company)),
  new Set(["Anthropic", "OpenAI", "Google"]),
);
for (const model of models) {
  assert.match(model.source, /^https:\/\//);
  assert.ok(
    Number.isSafeInteger(model.contextTokens) && model.contextTokens >= 65536,
  );
  assert.ok(
    Number.isSafeInteger(model.maxOutputTokens) &&
      model.maxOutputTokens > 4096 &&
      model.maxOutputTokens <= model.contextTokens,
  );
  assert.ok(Array.isArray(model.thinkingLevels) && model.thinkingLevels.length);
  assert.equal(new Set(model.thinkingLevels).size, model.thinkingLevels.length);
  assert.ok(model.thinkingLevels.includes(model.defaultThinkingLevel));
  assert.equal(
    model.browserTool,
    ["Anthropic", "Google"].includes(model.company),
  );
  if (model.transport === "bedrock") {
    assert.equal(validModelId(model.id, region, account), true);
    const foundationId = model.id.replace(/^global\./, "");
    for (const regionPart of ["*", ""])
      assert.ok(
        template.includes(
          `arn:aws:bedrock:${regionPart}::foundation-model/${foundationId}`,
        ),
        `${model.id} has an IAM grant for ${regionPart || "Regionless"} invocation`,
      );
    for (const rate of [
      "inputRate",
      "outputRate",
      "cacheReadRate",
      "cacheWriteRate",
    ])
      assert.ok(Number.isSafeInteger(model[rate]) && model[rate] >= 0, rate);
    assert.match(model.pricingSource, /^https:\/\//);
    assert.ok(
      ["aws-offer-global-standard", "provider-global-standard"].includes(
        model.pricingQuality,
      ),
    );
    if (model.longContext) {
      assert.ok(
        Number.isSafeInteger(model.longContext.inputTokenThreshold) &&
          model.longContext.inputTokenThreshold > 0,
      );
      for (const rate of [
        "inputRate",
        "outputRate",
        "cacheReadRate",
        "cacheWriteRate",
      ])
        assert.ok(
          Number.isSafeInteger(model.longContext[rate]) &&
            model.longContext[rate] >= model[rate],
        );
    }
  } else {
    assert.equal(model.transport, "gemini");
    assert.ok(model.pricingExpiresAt, "Promotional prices need an end date");
  }
}
console.log("PASS: checked-in model candidates and exact Bedrock ID shapes");
