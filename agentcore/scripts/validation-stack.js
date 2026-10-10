// Only disposable stacks created by this script are eligible for mutation.
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import {
  CloudFormationClient,
  CreateStackCommand,
  DescribeStacksCommand,
  CreateChangeSetCommand,
  DescribeChangeSetCommand,
  ExecuteChangeSetCommand,
  DeleteStackCommand,
} from "@aws-sdk/client-cloudformation";
import {
  S3Client,
  PutObjectCommand,
  GetBucketTaggingCommand,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";

process.loadEnvFile(new URL("../../.env", import.meta.url));
const region = process.env.AWS_REGION || "us-east-1",
  cf = new CloudFormationClient({ region });
const directory = new URL("../.artifacts/", import.meta.url);
await mkdir(directory, { recursive: true });
const recordFile = new URL("pages-validation-stack.json", directory);
const mode = process.argv[2];
const template = await readFile(
  new URL("../template.yaml", import.meta.url),
  "utf8",
);
const wait = async (name) => {
  for (;;) {
    const stack = (
      await cf.send(new DescribeStacksCommand({ StackName: name }))
    ).Stacks[0];
    if (!stack.StackStatus.endsWith("IN_PROGRESS")) {
      if (!["CREATE_COMPLETE", "UPDATE_COMPLETE"].includes(stack.StackStatus))
        throw Error(stack.StackStatus);
      return stack;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
};
if (mode === "bootstrap") {
  const stackName = "agentcore-pages-test-" + randomUUID().slice(0, 8),
    prefix = "acpages" + randomUUID().replaceAll("-", "").slice(0, 12);
  const parameters = [
    { ParameterKey: "ResourcePrefix", ParameterValue: prefix },
    { ParameterKey: "CognitoDomainPrefix", ParameterValue: prefix },
    { ParameterKey: "EnableScriptedModel", ParameterValue: "true" },
    {
      ParameterKey: "GeminiApiKey",
      ParameterValue: process.env.GEMINI_API_KEY || "",
    },
  ];
  await cf.send(
    new CreateStackCommand({
      StackName: stackName,
      TemplateBody: template,
      Parameters: parameters,
      Capabilities: ["CAPABILITY_NAMED_IAM"],
      Tags: [
        { Key: "purpose", Value: "agentcore-pages-disposable-validation" },
      ],
    }),
  );
  await writeFile(
    recordFile,
    JSON.stringify({
      stackName,
      region,
      prefix,
      createdBy: "pages-validation",
    }),
  );
  console.log("Creating disposable validation stack: " + stackName);
  await wait(stackName);
  console.log("Disposable foundation ready.");
} else if (mode === "update") {
  const record = JSON.parse(await readFile(recordFile, "utf8"));
  if (
    record.createdBy !== "pages-validation" ||
    !/^agentcore-pages-test-[a-f0-9]{8}$/.test(record.stackName)
  )
    throw Error("Invalid validation stack identity");
  const stack = await wait(record.stackName);
  const outputs = Object.fromEntries(
    stack.Outputs.map(({ OutputKey, OutputValue }) => [OutputKey, OutputValue]),
  );
  const files = (await readdir(directory)).filter((name) =>
    /^controller-[a-f0-9]{20}\.zip$/.test(name),
  );
  const requested = process.argv[3];
  if (!files.includes(requested))
    throw Error("Pass the exact freshly built controller ZIP filename");
  const codeKey = "controller/" + requested.slice(11);
  await new S3Client({ region }).send(
    new PutObjectCommand({
      Bucket: outputs.SharedBucket,
      Key: codeKey,
      Body: await readFile(new URL(requested, directory)),
    }),
  );
  const changeSetName = "pages-" + randomUUID();
  await cf.send(
    new CreateChangeSetCommand({
      StackName: record.stackName,
      ChangeSetName: changeSetName,
      TemplateBody: template,
      Capabilities: ["CAPABILITY_NAMED_IAM"],
      Parameters: stack.Parameters.map(({ ParameterKey }) =>
        ParameterKey === "ControllerCodeKey"
          ? { ParameterKey, ParameterValue: codeKey }
          : { ParameterKey, UsePreviousValue: true },
      ),
    }),
  );
  let changes;
  do {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    changes = await cf.send(
      new DescribeChangeSetCommand({
        StackName: record.stackName,
        ChangeSetName: changeSetName,
      }),
    );
  } while (
    changes.Status === "CREATE_IN_PROGRESS" ||
    changes.Status === "CREATE_PENDING"
  );
  if (changes.Status !== "CREATE_COMPLETE") throw Error(changes.StatusReason);
  const replacements = changes.Changes.filter(
    (change) => change.ResourceChange?.Replacement === "True",
  );
  console.log(
    "Change set: " +
      JSON.stringify(
        changes.Changes.map(({ ResourceChange: change }) => ({
          id: change.LogicalResourceId,
          action: change.Action,
          replacement: change.Replacement,
        })),
      ),
  );
  if (replacements.length) throw Error("Unexpected resource replacement");
  await cf.send(
    new ExecuteChangeSetCommand({
      StackName: record.stackName,
      ChangeSetName: changeSetName,
    }),
  );
  const updated = await wait(record.stackName);
  await writeFile(
    recordFile,
    JSON.stringify(
      {
        ...record,
        codeKey,
        changes: changes.Changes,
        outputs: Object.fromEntries(
          updated.Outputs.map(({ OutputKey, OutputValue }) => [
            OutputKey,
            OutputValue,
          ]),
        ),
      },
      null,
      2,
    ),
  );
  console.log("Disposable Runtime ready: " + record.stackName);
} else if (mode === "cleanup") {
  const record = JSON.parse(await readFile(recordFile, "utf8"));
  if (
    record.createdBy !== "pages-validation" ||
    !/^agentcore-pages-test-[a-f0-9]{8}$/.test(record.stackName) ||
    !/^acpages[a-f0-9]{12}$/.test(record.prefix)
  )
    throw Error("Invalid disposable identity");
  const stack = (
    await cf.send(new DescribeStacksCommand({ StackName: record.stackName }))
  ).Stacks[0];
  if (
    !stack.Tags.some(
      ({ Key, Value }) =>
        Key === "purpose" && Value === "agentcore-pages-disposable-validation",
    )
  )
    throw Error("Missing disposable stack tag");
  const bucket = stack.Outputs.find(
    (output) => output.OutputKey === "SharedBucket",
  ).OutputValue;
  if (
    !bucket.startsWith(record.prefix + "-") ||
    bucket !== record.outputs.SharedBucket
  )
    throw Error("Bucket does not match the recorded disposable stack");
  const s3 = new S3Client({ region });
  const tags = (await s3.send(new GetBucketTaggingCommand({ Bucket: bucket })))
    .TagSet;
  if (
    !tags.some(
      ({ Key, Value }) => Key === "stack" && Value === record.stackName,
    )
  )
    throw Error("Bucket stack tag does not match");
  await cf.send(new DeleteStackCommand({ StackName: record.stackName }));
  console.log("Deleting owned disposable stack: " + record.stackName);
  for (;;) {
    try {
      const current = (
        await cf.send(
          new DescribeStacksCommand({ StackName: record.stackName }),
        )
      ).Stacks[0];
      if (current.StackStatus === "DELETE_FAILED")
        throw Error("Disposable cleanup failed");
    } catch (error) {
      if (
        error.name === "ValidationError" &&
        error.message.includes("does not exist")
      )
        break;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  for (;;) {
    const page = await s3.send(
      new ListObjectVersionsCommand({ Bucket: bucket, MaxKeys: 1000 }),
    );
    const objects = [
      ...(page.Versions || []),
      ...(page.DeleteMarkers || []),
    ].map(({ Key, VersionId }) => ({ Key, VersionId }));
    if (!objects.length) break;
    const result = await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: objects, Quiet: true },
      }),
    );
    if (result.Errors?.length) throw Error("Disposable version cleanup failed");
  }
  await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
  await writeFile(
    recordFile,
    JSON.stringify({ ...record, cleanedAt: new Date().toISOString() }, null, 2),
  );
  console.log(
    "PASS: disposable stack and its tagged retained bucket/versions removed",
  );
} else
  throw Error("Use bootstrap, update <controller ZIP filename>, or cleanup");
