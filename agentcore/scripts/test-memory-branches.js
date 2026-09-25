// Opt-in live contract check: node scripts/test-memory-branches.js <stack> [profile] [region].
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { BedrockAgentCoreClient, CreateEventCommand, GetEventCommand, DeleteEventCommand,
  ListEventsCommand } from "@aws-sdk/client-bedrock-agentcore";
import { fromIni } from "@aws-sdk/credential-providers";

const stack = process.argv[2];
if (!stack) throw Error("Pass an exact stack name");
const config = { region: process.argv[4] || "us-east-1",
  credentials: fromIni({ profile: process.argv[3] || "eaap" }) };
const cloud = new CloudFormationClient(config);
const memory = new BedrockAgentCoreClient(config);
const described = await cloud.send(new DescribeStacksCommand({ StackName: stack }));
const arn = described.Stacks?.[0]?.Outputs?.find((entry) => entry.OutputKey === "MemoryArn")?.OutputValue;
if (!arn) throw Error("Stack has no MemoryArn output");
const memoryId = arn.split("/").at(-1);
const actorId = `smoke_${randomUUID()}`;
const sessionId = `s_${randomUUID()}`;
const rootlessSessionId = `a_${randomUUID()}_b_${randomUUID()}`;
const created = [];
const append = async (label, branch, targetSessionId = sessionId) => {
  const result = await memory.send(new CreateEventCommand({ memoryId, actorId,
    sessionId: targetSessionId,
    eventTimestamp: new Date(), extractionMode: "SKIP", clientToken: randomUUID(),
    payload: [{ conversational: { role: "USER", content: { text: label } } }],
    ...(branch && { branch }) }));
  created.push({ sessionId: targetSessionId, eventId: result.event.eventId });
  return result.event.eventId;
};
const path = async (name, targetSessionId = sessionId) => {
  const events = [];
  let nextToken;
  do {
    const page = await memory.send(new ListEventsCommand({ memoryId, actorId,
      sessionId: targetSessionId,
      filter: { branch: { name, includeParentBranches: true } },
      includePayloads: true, maxResults: 100, nextToken }));
    events.push(...page.events);
    nextToken = page.nextToken;
  } while (nextToken);
  return events.map((event) => event.eventId);
};
try {
  const root = await append("root");
  assert.equal((await memory.send(new GetEventCommand({ memoryId, actorId,
    sessionId, eventId: root }))).event.eventId, root);
  const initial = await memory.send(new ListEventsCommand({ memoryId, actorId,
    sessionId, includePayloads: true }));
  assert(initial.events.some((event) => event.eventId === root));
  assert.equal(initial.events.find((event) => event.eventId === root).branch?.name,
    "main");
  const excluded = await append("later main event");
  const sibling = await append("sibling", { name: "sibling", rootEventId: root });
  await append("sibling continuation", { name: "sibling" });
  const child = await append("nested", { name: "nested", rootEventId: sibling });
  const rootless = await append("new first turn", undefined, rootlessSessionId);
  const rootlessChild = await append("nested from first edit",
    { name: "rootless-child", rootEventId: rootless }, rootlessSessionId);
  const siblingPath = await path("sibling");
  const nestedPath = await path("nested");
  const rootlessPath = await path("rootless-child", rootlessSessionId);
  assert(siblingPath.includes(root) && siblingPath.includes(sibling));
  assert(!siblingPath.includes(excluded) && !siblingPath.includes(child));
  assert(nestedPath.includes(root) && nestedPath.includes(sibling) && nestedPath.includes(child));
  assert(!nestedPath.includes(excluded));
  assert(rootlessPath.includes(rootless) && rootlessPath.includes(rootlessChild) &&
    !rootlessPath.includes(root));
  console.log("PASS: native ancestry and separate-session first-turn alternatives");
} finally {
  const removed = await Promise.allSettled(created.toReversed().map((item) =>
    memory.send(new DeleteEventCommand({ memoryId, actorId, ...item }))));
  if (removed.some((result) => result.status === "rejected"))
    console.error("Some disposable Memory events could not be removed:", actorId, sessionId);
}
