// Execute the reviewed pages release only; retain a record for rollout checks.
import { readFile, writeFile } from "node:fs/promises";
import {
  CloudFormationClient,
  DescribeChangeSetCommand,
  DescribeStacksCommand,
  ListStackResourcesCommand,
  ExecuteChangeSetCommand,
} from "@aws-sdk/client-cloudformation";

process.loadEnvFile(new URL("../../.env", import.meta.url));
const recordUrl = new URL(
  "../.artifacts/pages-production-review.json",
  import.meta.url,
);
const record = JSON.parse(await readFile(recordUrl, "utf8"));
if (record.stackName !== "agentcore-chat-prod" || record.region !== "us-east-1")
  throw Error("Unexpected production review record");
const cf = new CloudFormationClient({ region: record.region });
const review = await cf.send(
  new DescribeChangeSetCommand({
    StackName: record.stackName,
    ChangeSetName: record.changeSetId,
  }),
);
if (
  review.Status !== "CREATE_COMPLETE" ||
  review.ExecutionStatus !== "AVAILABLE"
)
  throw Error("Reviewed change set is not available for execution");
const changes = review.Changes.map(({ ResourceChange: change }) => ({
  id: change.LogicalResourceId,
  action: change.Action,
  replacement: change.Replacement,
}));
// Only reviewed in-place updates, plus exactly the removals and additions
// named when the change set was prepared.
const allowed = record.allowed || { remove: [], add: [] };
if (
  JSON.stringify(changes) !== JSON.stringify(record.changes) ||
  changes.some(
    (change) =>
      !(change.action === "Modify" && change.replacement === "False") &&
      !(change.action === "Remove" && allowed.remove.includes(change.id)) &&
      !(change.action === "Add" && allowed.add.includes(change.id)),
  )
)
  throw Error("Change set differs from the reviewed release");
if (
  !review.Parameters.some(
    (p) =>
      p.ParameterKey === "ControllerCodeKey" &&
      p.ParameterValue === record.codeKey,
  ) ||
  !review.Parameters.some(
    (p) =>
      p.ParameterKey === "EnableScriptedModel" && p.ParameterValue === "false",
  )
)
  throw Error("Unexpected production code or scripted inference parameter");
const resources = async () => {
  const result = {};
  let NextToken;
  do {
    const page = await cf.send(
      new ListStackResourcesCommand({ StackName: record.stackName, NextToken }),
    );
    for (const resource of page.StackResourceSummaries)
      result[resource.LogicalResourceId] = resource.PhysicalResourceId;
    NextToken = page.NextToken;
  } while (NextToken);
  return result;
};
const before = await resources();
record.executionStartedAt = new Date().toISOString();
await cf.send(
  new ExecuteChangeSetCommand({
    StackName: record.stackName,
    ChangeSetName: record.changeSetId,
    ClientRequestToken:
      "pages-release-" + record.codeKey.match(/[a-f0-9]{20}/)[0],
  }),
);
record.executed = true;
await writeFile(recordUrl, JSON.stringify(record, null, 2));
console.log("Production change set execution accepted");
let previous;
const deadline = Date.now() + 15 * 60 * 1000;
for (;;) {
  const stack = (
    await cf.send(new DescribeStacksCommand({ StackName: record.stackName }))
  ).Stacks[0];
  if (stack.StackStatus !== previous) console.log("STACK " + stack.StackStatus);
  previous = stack.StackStatus;
  if (
    stack.StackStatus === "UPDATE_COMPLETE" &&
    new Date(stack.LastUpdatedTime).getTime() >=
      new Date(record.executionStartedAt).getTime() - 5000
  )
    break;
  if (
    !stack.StackStatus.endsWith("_IN_PROGRESS") &&
    stack.StackStatus !== "UPDATE_COMPLETE"
  )
    throw Error("Production update ended with " + stack.StackStatus);
  if (Date.now() > deadline)
    throw Error(
      "Production update still pending; inspect stack before retrying",
    );
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
const after = await resources();
const kept = Object.keys(before).filter((key) => !allowed.remove.includes(key));
if (
  kept.some((key) => after[key] !== before[key]) ||
  allowed.remove.some((key) => key in after) ||
  allowed.add.some((key) => !(key in after)) ||
  Object.keys(after).length !== kept.length + allowed.add.length
)
  throw Error("Production resource identities changed");
record.executionCompletedAt = new Date().toISOString();
record.resourceIdentitiesPreserved = true;
record.stackStatus = "UPDATE_COMPLETE";
await writeFile(recordUrl, JSON.stringify(record, null, 2));
console.log(
  JSON.stringify({
    status: record.stackStatus,
    resourceCount: Object.keys(after).length,
    resourceIdentitiesPreserved: true,
    codeKey: record.codeKey,
  }),
);
