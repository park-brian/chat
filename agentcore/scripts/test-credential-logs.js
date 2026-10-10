import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
process.loadEnvFile(new URL("../../.env", import.meta.url));
const record = JSON.parse(
  await readFile(
    new URL("../.artifacts/pages-validation-stack.json", import.meta.url),
  ),
);
if (record.createdBy !== "pages-validation")
  throw Error("Expected disposable test stack");
const runtimeName = record.outputs.ControllerArn.split("/").at(-1),
  group = "/aws/bedrock-agentcore/runtimes/" + runtimeName + "-DEFAULT";
const aws = "C:/Program Files/Amazon/AWSCLIV2/aws.exe";
const run = (args) => {
  const result = spawnSync(
    aws,
    [...args, "--region", record.region, "--output", "json"],
    { encoding: "utf8", env: process.env },
  );
  if (result.status) throw Error("Log audit command failed");
  return JSON.parse(result.stdout);
};
const streams = run([
  "logs",
  "describe-log-streams",
  "--log-group-name",
  group,
  "--query",
  "length(logStreams)",
]);
assert.ok(streams > 0, "No live Runtime log streams to audit");
for (const value of [
  "pages-fixture-secret-v1",
  "pages-fixture-secret-v2",
  "pages-fixture-secret-v3",
  "pages-legacy-secret",
]) {
  for (const marker of [value, Buffer.from(value).toString("base64")]) {
    const count = run([
      "logs",
      "filter-log-events",
      "--log-group-name",
      group,
      "--filter-pattern",
      '"' + marker + '"',
      "--query",
      "length(events)",
    ]);
    assert.equal(count, 0, "Credential fixture appeared in Runtime logs");
  }
}
console.log(
  "PASS: disposable Runtime CloudWatch logs contain no raw or encoded credential fixture values",
);
