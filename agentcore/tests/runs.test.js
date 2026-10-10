import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRuns } from "../runtime/runs.js";

// Exercise the commit/progress race directly: durable completion is visible
// before the worker publishes its final observer event.
let request,
  writes = 0,
  finished = false;
const objects = new Map();
const db = {
  async send(command) {
    const input = command.input;
    if (command.constructor.name === "GetItemCommand") return { Item: request };
    if (command.constructor.name === "TransactWriteItemsCommand") {
      const accepted = input.TransactItems.find(
        (item) => item.Put?.Item.workerId,
      );
      if (accepted) {
        request = accepted.Put.Item;
        writes++;
      }
      return {};
    }
    if (command.constructor.name === "UpdateItemCommand") {
      if (input.UpdateExpression.startsWith("SET progressChunks")) {
        request.progressChunks = input.ExpressionAttributeValues[":chunks"];
        request.progressSequence = input.ExpressionAttributeValues[":sequence"];
      }
      if (input.UpdateExpression.startsWith("SET progressClosed"))
        request.progressClosed = { BOOL: true };
      return {};
    }
    throw Error("Unexpected command " + command.constructor.name);
  },
};
const s3 = {
  async send(command) {
    if (command.constructor.name === "PutObjectCommand") {
      objects.set(command.input.Key, command.input.Body);
      return {};
    }
    return {
      Body: { transformToString: async () => objects.get(command.input.Key) },
    };
  },
};
const identity = { sub: randomUUID(), role: "Members" };
const input = {
  requestId: randomUUID(),
  sessionId: randomUUID(),
  agentId: randomUUID(),
  message: "hello",
};
const runs = createRuns({
  db,
  s3,
  table: "fixture",
  bucket: "fixture",
  currentIdentity: async () => true,
});
let finish;
const canFinish = new Promise((resolve) => {
  finish = resolve;
});
const chat = async (value, owner, response) => {
  await response.accept(
    { observedHead: null },
    {
      pk: { S: "USER#" + owner.sub },
      sk: { S: "REQUEST#" + value.requestId },
      status: { S: "running" },
      projectId: { S: "main" },
      conversationId: { S: value.sessionId },
      agentId: { S: value.agentId },
      branchId: { S: "main" },
      acceptedAt: { S: new Date().toISOString() },
      durable: { BOOL: true },
    },
  );
  request.status = { S: "completed" };
  await canFinish;
  response.write('data: {"type":"message.done","text":"final result"}\n\n');
  response.end();
};
await runs.start(chat, input, identity, "fixture");
assert.equal(runs.busy(), true);
await runs.start(chat, input, identity, "fixture");
assert.equal(writes, 1);
await assert.rejects(
  runs.start(chat, { ...input, message: "changed" }, identity, "fixture"),
  { code: "REQUEST_ID_CONFLICT" },
);
const output = [];
const observation = runs.watch(
  identity,
  { requestId: input.requestId },
  {
    destroyed: false,
    writeHead() {},
    write(value) {
      output.push(value);
    },
    end() {
      finished = true;
    },
  },
  { untilTerminal: true },
);
await new Promise((resolve) => setTimeout(resolve, 350));
assert.equal(
  finished,
  false,
  "completed must wait for final progress persistence",
);
finish();
await observation;
assert.ok(output.some((value) => value.includes('"type":"message.done"')));
assert.ok(output.at(-1).includes('"type":"run.status"'));
assert.equal(runs.busy(), false);
assert.equal(request.progressClosed.BOOL, true);
console.log(
  "PASS: independent run admission, duplicate identity, final progress ordering and worker cleanup",
);
