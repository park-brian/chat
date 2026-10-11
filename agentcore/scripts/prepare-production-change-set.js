// Prepare review only. This script never executes a change set or publishes UI.
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  CloudFormationClient,
  DescribeStacksCommand,
  CreateChangeSetCommand,
  DescribeChangeSetCommand,
} from "@aws-sdk/client-cloudformation";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

process.loadEnvFile(new URL("../../.env", import.meta.url));
const stackName = "agentcore-chat-prod",
  region = "us-east-1";
const filename = process.argv[2];
if (!/^controller-[a-f0-9]{20}\.zip$/.test(filename || ""))
  throw Error("Pass the exact validated ZIP filename");
// A release that intentionally removes or adds resources names them; anything
// else must be an in-place update. Example: --remove Data,Memory --add Table
const listed = (flag) => {
  const at = process.argv.indexOf(flag);
  return at < 0 ? [] : process.argv[at + 1].split(",").filter(Boolean).sort();
};
const allowed = { remove: listed("--remove"), add: listed("--add") };
const cf = new CloudFormationClient({ region });
const stack = (
  await cf.send(new DescribeStacksCommand({ StackName: stackName }))
).Stacks[0];
if (!["CREATE_COMPLETE", "UPDATE_COMPLETE"].includes(stack.StackStatus))
  throw Error("Production stack is not ready for review");
if (
  stack.Parameters.find(
    (parameter) => parameter.ParameterKey === "EnableScriptedModel",
  )?.ParameterValue !== "false"
)
  throw Error("Production scripted inference must remain disabled");
const bucket = stack.Outputs.find(
  (output) => output.OutputKey === "SharedBucket",
).OutputValue;
const codeKey = "controller/" + filename.slice(11);
const directory = new URL("../.artifacts/", import.meta.url);
await new S3Client({ region }).send(
  new PutObjectCommand({
    Bucket: bucket,
    Key: codeKey,
    Body: await readFile(new URL(filename, directory)),
  }),
);
const name = "pages-review-" + randomUUID();
const created = await cf.send(
  new CreateChangeSetCommand({
    StackName: stackName,
    ChangeSetName: name,
    Description: "AgentCore release " + codeKey,
    TemplateBody: await readFile(
      new URL("../template.yaml", import.meta.url),
      "utf8",
    ),
    Capabilities: ["CAPABILITY_NAMED_IAM"],
    Parameters: stack.Parameters.map(({ ParameterKey }) =>
      ParameterKey === "ControllerCodeKey"
        ? { ParameterKey, ParameterValue: codeKey }
        : { ParameterKey, UsePreviousValue: true },
    ),
  }),
);
let review;
do {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  review = await cf.send(
    new DescribeChangeSetCommand({ StackName: stackName, ChangeSetName: name }),
  );
} while (["CREATE_PENDING", "CREATE_IN_PROGRESS"].includes(review.Status));
if (review.Status !== "CREATE_COMPLETE") throw Error(review.StatusReason);
const changes = review.Changes.map(({ ResourceChange: change }) => ({
  id: change.LogicalResourceId,
  action: change.Action,
  replacement: change.Replacement,
}));
await writeFile(
  new URL("pages-production-review.json", directory),
  JSON.stringify(
    {
      stackName,
      region,
      codeKey,
      changeSetId: created.Id,
      changes,
      allowed,
      executed: false,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    stackName,
    codeKey,
    changeSetId: created.Id,
    changes,
    executed: false,
  }),
);
if (
  changes.some((change) => ["True", "Conditional"].includes(change.replacement))
)
  throw Error(
    "Review required: possible resource replacement; change set was not executed",
  );
const actual = (action) =>
  changes
    .filter((change) => change.action === action)
    .map((change) => change.id)
    .sort();
if (
  JSON.stringify(actual("Remove")) !== JSON.stringify(allowed.remove) ||
  JSON.stringify(actual("Add")) !== JSON.stringify(allowed.add)
)
  throw Error(
    "Review required: removals/additions differ from --remove/--add; change set was not executed",
  );
