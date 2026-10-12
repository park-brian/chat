// The whole Runtime API, offline: the real controller over HTTP, with AWS
// replaced by in-memory fakes that enforce DynamoDB's conditions and
// transactions. Live stories confirm the same contract against AWS.
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { createCognito, createDynamo, createS3 } from "./fake-aws.js";

const port = 20000 + Math.floor(Math.random() * 20000);
Object.assign(process.env, {
  TABLE: "table",
  BUCKET: "bucket",
  POOL: "pool",
  ISSUER: "https://issuer.example",
  CLIENT: "client",
  BUDGET: "5000000",
  STORAGE: "5000000000",
  SCRIPTED_MODEL: "true",
  PORT: String(port),
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "test",
  AWS_SECRET_ACCESS_KEY: "test",
});
const aws = await import("../runtime/aws.js");
const dynamo = createDynamo(),
  s3 = createS3(),
  cognito = createCognito();
aws.dynamo.send = (command) => dynamo.send(command);
aws.s3.send = (command) => s3.send(command);
aws.idp.send = (command) => cognito.send(command);
await import("../runtime/controller.js");

const person = (role, email) => {
  const sub = randomUUID();
  cognito.add({ sub, email, groups: [role] });
  return { sub, role };
};
const owner = person("Administrators", "owner@example.com"),
  member = person("Members", "member@example.com"),
  auditor = person("Auditors", "auditor@example.com");
const token = ({ sub, role }) =>
  [
    { alg: "none" },
    {
      iss: process.env.ISSUER,
      client_id: process.env.CLIENT,
      token_use: "access",
      exp: Math.floor(Date.now() / 1000) + 3600,
      sub,
      "cognito:groups": [role],
    },
  ]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
    .join(".") + ".signature";

// Sends a body as the given chunks, so tests can split a character.
const post = (who, chunks) =>
  new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        port,
        method: "POST",
        path: "/invocations",
        headers: {
          authorization: "Bearer " + token(who),
          "content-type": "application/json",
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (part) => (text += part));
        response.on("end", () => resolve({ status: response.statusCode, text }));
      },
    );
    outgoing.on("error", reject);
    for (const chunk of chunks) outgoing.write(chunk);
    outgoing.end();
  });
const call = async (who, command, input = {}) => {
  const { status, text } = await post(who, [
    JSON.stringify({ v: 1, command, input }),
  ]);
  assert.equal(status, 200, command);
  return JSON.parse(text);
};
const data = async (who, command, input) => {
  const result = await call(who, command, input);
  assert.ok(result.ok, `${command}: ${JSON.stringify(result.error)}`);
  return result.data;
};
const code = async (who, command, input) =>
  (await call(who, command, input)).error?.code;
const events = (text) =>
  text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice(6)));
const send = async (who, input) => {
  const { text } = await post(who, [
    JSON.stringify({
      v: 1,
      command: "chat.send",
      input: { requestId: randomUUID(), ...input },
    }),
  ]);
  const all = events(text);
  return {
    done: all.find((event) => event.type === "message.done"),
    error: all.find((event) => event.type === "error"),
    status: all.findLast((event) => event.type === "run.status"),
  };
};
const texts = (conversation) =>
  conversation.messages.map((message) => message.text).join("|");
const waitFor = async (check) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error("Timed out waiting");
};

// Session and the request envelope.
const session = await data(owner, "session.get");
assert.equal(session.apiVersion, 3);
assert.equal(session.user.budgetMicroUsd, 5000000);
assert.equal(await code(owner, "nope.nothing"), "NOT_IMPLEMENTED");
assert.equal(
  JSON.parse((await post(owner, ["{not json"])).text).error.code,
  "VALIDATION_FAILED",
);
assert.equal(
  JSON.parse(
    (await post(owner, [JSON.stringify({ v: 1, command: "session.get", input: "x".repeat(70000) })])).text,
  ).error.code,
  "TOO_LARGE",
);
console.log("PASS: session and request envelope");

// Projects and agents, with role rules applied centrally.
await data(owner, "projects.create", { id: "alpha", name: "Alpha" });
assert.equal(await code(owner, "projects.create", { id: "alpha", name: "Again" }), "PROJECT_EXISTS");
assert.equal(await code(auditor, "projects.create", { id: "gamma", name: "G" }), "FORBIDDEN");
const agent = await data(owner, "agents.put", {
  projectId: "alpha",
  name: "Echo",
  modelId: "test.echo",
});
assert.equal(agent.revision, 0);
assert.equal((await data(owner, "agents.list", { projectId: "main" })).items.length, 0);
assert.equal((await data(owner, "agents.list", { projectId: "alpha" })).items.length, 1);
assert.equal(await code(owner, "agents.list", { projectId: "missing" }), "NOT_FOUND");
console.log("PASS: projects, agents and central role checks");

// Conversation turns, history, branches and the first-turn rewrite.
const conversationId = randomUUID();
const base = { projectId: "alpha", agentId: agent.id, conversationId };
const first = await send(owner, { ...base, message: "first", expectedHeadTurnId: null });
assert.ok(first.done, JSON.stringify(first));
const second = await send(owner, {
  ...base,
  message: "history?",
  expectedHeadTurnId: first.done.turnId,
});
assert.ok(second.done);
const alternateId = randomUUID();
const alternate = await send(owner, {
  ...base,
  branchId: alternateId,
  forkTurnId: first.done.turnId,
  message: "edited second",
});
assert.ok(alternate.done);
const nestedId = randomUUID();
assert.ok(
  (
    await send(owner, {
      ...base,
      branchId: nestedId,
      forkTurnId: alternate.done.turnId,
      message: "history?",
    })
  ).done,
);
const rewriteId = randomUUID();
const rewrite = await send(owner, {
  ...base,
  branchId: rewriteId,
  forkTurnId: null,
  message: "rewritten first",
});
assert.ok(rewrite.done);
const rewriteChildId = randomUUID();
assert.ok(
  (
    await send(owner, {
      ...base,
      branchId: rewriteChildId,
      forkTurnId: rewrite.done.turnId,
      message: "history?",
    })
  ).done,
);
const read = (branchId) =>
  data(owner, "conversations.get", { ...base, branchId });
assert.equal(texts(await read("main")), "first|Echo: first|history?|History: first | history?");
assert.equal(
  texts(await read(nestedId)),
  "first|Echo: first|edited second|Echo: edited second|history?|History: first | edited second | history?",
);
assert.equal(
  texts(await read(rewriteChildId)),
  "rewritten first|Echo: rewritten first|history?|History: rewritten first | history?",
);
const opened = await read("main");
assert.equal(opened.branches.length, 5);
assert.equal(opened.branches[0].id, "main");
assert.equal(
  (await send(owner, {
    ...base,
    branchId: alternateId,
    message: "stale",
    expectedHeadTurnId: first.done.turnId,
  })).error?.code,
  "BRANCH_CONFLICT",
);
assert.equal(
  (await send(owner, {
    ...base,
    branchId: randomUUID(),
    forkTurnId: "1234567890123#0123456789abcdef",
    message: "x",
  })).error?.code,
  "BRANCH_CONFLICT",
);
const listed = await data(owner, "conversations.list", { projectId: "alpha" });
assert.equal(listed.items.length, 1);
assert.equal(listed.items[0].running, false);
console.log("PASS: turns, history, forks, nested forks, first-turn rewrite and stale heads");

// Isolation between people.
assert.equal(
  await code(member, "conversations.get", { ...base, projectId: "main" }),
  "NOT_FOUND",
);
assert.equal(
  await code(member, "usage.request", { userSub: owner.sub, requestId: first.done.requestId }),
  "FORBIDDEN",
);
assert.equal(await code(member, "users.list"), "FORBIDDEN");
assert.equal(
  (await send(auditor, { ...base, conversationId: randomUUID(), message: "x" })).error?.code,
  "FORBIDDEN",
);
console.log("PASS: cross-user and auditor denial");

// Usage: every step recorded, failures included.
const usage = await data(owner, "usage.get", { range: "30d", includeDaily: true });
assert.equal(usage.items.filter((item) => item.kind === "model").length, 6);
assert.equal(usage.daily.items.length, 1);
assert.equal(usage.quality, "estimated");
assert.ok(usage.costMicroUsd > 0);
const detail = await data(owner, "usage.request", { requestId: first.done.requestId });
assert.equal(detail.request.status, "completed");
assert.equal(detail.steps.length, 1);
const scriptedFailure = await send(owner, {
  ...base,
  conversationId: randomUUID(),
  message: "scripted-error",
});
assert.equal(scriptedFailure.error?.code, "TURN_FAILED");
const failedDetail = await data(owner, "usage.request", {
  requestId: scriptedFailure.status.requestId,
});
assert.equal(failedDetail.request.status, "failed");
assert.equal(failedDetail.steps.length, 1);
assert.equal(failedDetail.steps[0].quality, "estimated");
const streamFailure = await send(owner, {
  ...base,
  conversationId: randomUUID(),
  message: "scripted-stream-error",
});
assert.ok(streamFailure.error);
const lost = await data(owner, "usage.request", {
  requestId: streamFailure.status.requestId,
});
assert.equal(lost.request.status, "failed");
assert.equal(lost.steps.length, 1, "A failed stream is metered, not dropped");
assert.equal(lost.steps[0].quality, "unknown");
assert.ok(lost.steps[0].costMicroUsd > 0, "Unknown usage is estimated, never free");
assert.equal((await data(owner, "usage.summary")).quality, "partial");
const filtered = await data(owner, "usage.list", {
  range: "30d",
  requestId: first.done.requestId,
  quality: "estimated",
  status: "completed",
});
assert.equal(filtered.items.length, 1);
console.log("PASS: usage ledger, request detail and failure metering");

// Budget is enforced at admission and per step.
await data(owner, "users.setLimits", { sub: owner.sub, budgetMicroUsd: 1, storageBytes: null });
assert.equal(
  (await send(owner, { ...base, conversationId: randomUUID(), message: "over" })).error?.code,
  "BUDGET_EXHAUSTED",
);
await data(owner, "users.startNewBudgetPeriod", { sub: owner.sub });
const fresh = await data(owner, "usage.summary");
assert.match(fresh.period, /#E1$/);
assert.equal(fresh.costMicroUsd, 0);
await data(owner, "users.setLimits", { sub: owner.sub, budgetMicroUsd: null, storageBytes: null });
console.log("PASS: budget admission and new budget periods");

// The per-person run limit, idempotent request ids and cancellation.
const started = [];
for (let count = 0; count < 3; count++)
  started.push(
    await data(owner, "chat.start", {
      ...base,
      conversationId: randomUUID(),
      requestId: randomUUID(),
      message: "wait:1500:slow",
    }),
  );
assert.equal(
  await code(owner, "chat.start", {
    ...base,
    conversationId: randomUUID(),
    requestId: randomUUID(),
    message: "one too many",
  }),
  "RUN_LIMIT",
);
const repeat = {
  ...base,
  conversationId: randomUUID(),
  requestId: randomUUID(),
  message: "repeat",
};
await waitFor(async () =>
  (await Promise.all(started.map((run) => data(owner, "chat.status", run)))).every(
    (run) => run.status === "completed",
  ),
);
const once = await data(owner, "chat.start", repeat);
const twice = await data(owner, "chat.start", repeat);
assert.equal(once.requestId, twice.requestId);
assert.equal(
  await code(owner, "chat.start", { ...repeat, message: "different" }),
  "REQUEST_ID_CONFLICT",
);
const slow = await data(owner, "chat.start", {
  ...base,
  conversationId: randomUUID(),
  requestId: randomUUID(),
  message: "wait:2000:cancel me",
});
await data(owner, "chat.cancel", { requestId: slow.requestId });
await waitFor(async () => (await data(owner, "chat.status", slow)).status !== "running");
assert.equal((await data(owner, "chat.status", slow)).status, "cancelled");
const finished = await data(owner, "chat.cancel", { requestId: first.done.requestId });
assert.equal(finished.status, "completed");
assert.equal(finished.cancelRequested, false, "A finished run is reported as it is");
console.log("PASS: run limit, idempotent requests and cancellation");

// Model edge cases: what was paid for is metered, and what was said is kept.
const newChat = () => ({ ...base, conversationId: randomUUID() });
const answerOf = async (conversation, turn) =>
  (await data(owner, "conversations.get", conversation)).messages.find(
    (message) => message.turnId === turn.done.turnId && message.role === "assistant",
  )?.text;
const stepsOf = async (outcome) =>
  (await data(owner, "usage.request", { requestId: outcome.status.requestId })).steps;
const malformed = await send(owner, { ...newChat(), message: "scripted-malformed" });
assert.equal(malformed.error?.code, "MALFORMED_TOOL_CALL");
assert.deepEqual(
  (await stepsOf(malformed)).map((step) => step.quality),
  ["estimated"],
  "A malformed call is metered with the usage the stream reported",
);
const empty = await send(owner, { ...newChat(), message: "scripted-empty" });
assert.equal(empty.error?.code, "TURN_FAILED", "An empty answer is never saved");
const cutConversation = newChat();
const cut = await send(owner, { ...cutConversation, message: "scripted-max-tokens" });
assert.ok(cut.done, "A reply at the output limit is kept");
assert.equal(
  await answerOf(cutConversation, cut),
  "Partial\n\n[Response truncated at the model output limit.]",
);
const coder = await data(owner, "agents.put", {
  projectId: "alpha",
  name: "Coder",
  modelId: "test.echo",
  codeInterpreter: true,
});
const coding = () => ({ ...newChat(), agentId: coder.id });
const preambleConversation = coding();
const preamble = await send(owner, { ...preambleConversation, message: "scripted-preamble" });
assert.equal(
  await answerOf(preambleConversation, preamble),
  "Checking. Answer.",
  "Text streamed before a tool call is saved",
);
for (const [perStep, results, modelSteps] of [
  [3, 9, 4],
  [1, 7, 8],
]) {
  const conversation = coding();
  const looped = await send(owner, { ...conversation, message: `loop-tools:${perStep}` });
  assert.ok(looped.done, JSON.stringify(looped.error));
  assert.equal(await answerOf(conversation, looped), `Done after ${results} tool results.`);
  assert.equal(looped.done.unpricedToolCalls, Math.min(8, results));
  const steps = await stepsOf(looped);
  assert.equal(steps.filter((step) => step.kind === "model").length, modelSteps);
  assert.equal(steps.filter((step) => step.kind === "tool").length, Math.min(8, results));
}
console.log("PASS: malformed calls, empty and truncated answers, preambles, tool and step limits");

// Contention, a commit whose reply is lost, and a cancel that lands at commit.
const transaction = (test) => (command) =>
  command.constructor.name === "TransactWriteItemsCommand" &&
  command.input.TransactItems.some((item) => test(item.Put?.Item?.sk?.S || ""));
const conflict = (reasons) =>
  Object.assign(new Error("Transaction cancelled"), {
    name: "TransactionCanceledException",
    CancellationReasons: reasons.map((Code) => ({ Code })),
  });
dynamo.once(transaction((key) => key.startsWith("USAGE#")), () => {
  throw conflict(["None", "TransactionConflict", "None", "None"]);
});
const progressUpdate = (command) =>
  command.constructor.name === "UpdateItemCommand" &&
  /progressChunks/.test(command.input.ExpressionAttributeNames?.["#progressChunks"] || "") &&
  !command.input.ExpressionAttributeNames["#progressClosed"];
for (let attempt = 0; attempt < 4; attempt++)
  dynamo.once(progressUpdate, () => {
    throw Object.assign(new Error("Conflict"), { name: "TransactionConflictException" });
  });
const contended = await send(owner, { ...newChat(), message: "contended" });
assert.ok(contended.done, "Conflicts are retried, and a missed progress count is not fatal");
assert.ok(contended.status.progressChunks >= 1, "close() records the chunks written");
const lostReply = newChat();
dynamo.once(transaction((key) => key.startsWith("TURN#")), async (apply) => {
  await apply();
  throw Object.assign(new Error("Socket timeout"), { name: "TimeoutError" });
});
const landed = await send(owner, { ...lostReply, message: "lost reply" });
assert.ok(landed.done, "A commit that landed is not failed by a lost reply");
assert.equal(await answerOf(lostReply, landed), "Echo: lost reply");
const lateCancel = { ...newChat(), requestId: randomUUID() };
dynamo.once(transaction((key) => key.startsWith("TURN#")), (apply) => {
  dynamo.items.get(`USER#${owner.sub}|REQUEST#${lateCancel.requestId}`).cancelRequested = {
    BOOL: true,
  };
  return apply();
});
const cancelled = await send(owner, { ...lateCancel, message: "cancel at commit" });
assert.equal(cancelled.error?.code, "CANCELLED", "A cancel before commit is honored");
assert.equal(cancelled.status.status, "cancelled");
assert.equal(
  [...s3.objects.keys()].filter((key) => key.includes(lateCancel.conversationId)).length,
  0,
  "The uncommitted body is removed",
);
assert.equal(
  [...dynamo.items.keys()].filter((key) => key.includes(`LOCK#alpha#${lateCancel.conversationId}`))
    .length,
  0,
);
console.log("PASS: write conflicts, lost commit replies and cancellation at commit");

// A delete interrupted after marking the conversation resumes on the next call.
const interrupted = { ...base, conversationId: randomUUID() };
assert.ok((await send(owner, { ...interrupted, message: "to resume" })).done);
const chatRow = dynamo.items.get(
  `USER#${owner.sub}|CHAT#alpha#${interrupted.conversationId}`,
);
chatRow.status = { S: "DELETING" };
delete chatRow.gsi1pk;
delete chatRow.gsi1sk;
assert.equal(await code(owner, "conversations.get", interrupted), "NOT_FOUND");
assert.ok((await data(owner, "conversations.delete", interrupted)).deleted);
assert.equal(
  [...dynamo.items.keys()].filter((key) => key.includes(interrupted.conversationId)).length,
  0,
  "Resuming removes the turns, not just the answer",
);
console.log("PASS: interrupted conversation deletes resume");

// Files and skills, counted against storage.
const before = (await data(owner, "session.get")).user.storageUsedBytes;
assert.ok(before > 0, "Turn bodies count toward storage");
const upload = await data(owner, "objects.beginUpload", {
  projectId: "alpha",
  name: "skill.md",
  contentType: "text/plain",
  sizeBytes: 5,
  kind: "skill",
});
s3.put(upload.upload.fields.key, "hello", "text/plain");
const completed = await data(owner, "objects.completeUpload", { projectId: "alpha", id: upload.id });
assert.equal(completed.item.status, "ACTIVE");
const files = await data(owner, "objects.list", { projectId: "alpha" });
assert.equal(files.items.length, 1);
assert.equal(files.usedBytes, before + 5);
for (let count = 0; count < 60; count++)
  await data(owner, "objects.beginUpload", {
    projectId: "alpha",
    name: "abandoned.txt",
    contentType: "text/plain",
    sizeBytes: 1,
  });
const past = await data(owner, "objects.list", { projectId: "alpha" });
assert.equal(past.items.length, 1, "Abandoned uploads don't hide files");
assert.equal(past.nextCursor, null);
assert.equal((await data(owner, "objects.list", { projectId: "main" })).items.length, 0);
await data(owner, "agents.put", {
  projectId: "alpha",
  id: agent.id,
  revision: 0,
  name: "Echo",
  modelId: "test.echo",
  skillIds: [upload.id],
});
assert.ok((await send(owner, { ...base, conversationId: randomUUID(), message: "skill-loaded" })).done);
assert.equal(
  await code(owner, "agents.put", {
    projectId: "alpha",
    id: agent.id,
    revision: 0,
    name: "Stale",
    modelId: "test.echo",
  }),
  "REVISION_CONFLICT",
);
await data(owner, "users.setLimits", { sub: owner.sub, budgetMicroUsd: null, storageBytes: 0 });
assert.equal(
  await code(owner, "objects.beginUpload", { projectId: "alpha", name: "x.txt", contentType: "text/plain", sizeBytes: 1 }),
  "QUOTA_EXCEEDED",
);
await data(owner, "users.setLimits", { sub: owner.sub, budgetMicroUsd: null, storageBytes: null });
assert.equal(await code(owner, "objects.delete", { projectId: "alpha", id: upload.id }), "SKILL_IN_USE");
await data(owner, "agents.put", {
  projectId: "alpha",
  id: agent.id,
  revision: 1,
  name: "Echo",
  modelId: "test.echo",
});
await data(owner, "objects.delete", { projectId: "alpha", id: upload.id });
assert.equal((await data(owner, "objects.list", { projectId: "alpha" })).items.length, 0);
console.log("PASS: uploads, skills, storage quota and object deletion");

// Deleting a conversation removes its turns, bodies and counted bytes.
assert.ok(
  (await data(owner, "conversations.delete", { ...base })).deleted,
  "An ordinary conversation is deleted in one call",
);
assert.equal(await code(owner, "conversations.get", base), "NOT_FOUND");
assert.ok((await data(owner, "conversations.delete", base)).deleted);
assert.equal(
  [...s3.objects.keys()].filter((key) => key.includes(`/chats/${conversationId}/`)).length,
  0,
);
for (const item of (await data(owner, "conversations.list", { projectId: "alpha" })).items)
  for (let attempt = 0; attempt < 20; attempt++)
    if ((await data(owner, "conversations.delete", { projectId: "alpha", conversationId: item.id })).deleted)
      break;
assert.equal((await data(owner, "session.get")).user.storageUsedBytes, 0);
console.log("PASS: conversation deletion returns storage to zero");

// Credentials: secrets stay private; references stay consistent.
const credential = await data(member, "credentials.put", {
  name: "GitHub",
  kind: "github",
  secret: "secret-value",
});
assert.equal("secret" in credential, false);
assert.equal(
  await code(member, "credentials.list", { userSub: owner.sub }),
  "FORBIDDEN",
  "Naming another person is refused, not ignored",
);
const connection = await data(member, "connections.put", {
  name: "Repo",
  kind: "github",
  credentialId: credential.id,
});
let current = (await data(member, "credentials.list")).items[0];
assert.deepEqual(current.usedBy.map((use) => use.id), [connection.id]);
assert.equal(
  await code(member, "credentials.delete", { id: credential.id, revision: current.revision }),
  "CREDENTIAL_IN_USE",
);
const rotations = await Promise.all(
  ["one", "two"].map((secret) =>
    call(member, "credentials.rotate", { id: credential.id, revision: current.revision, secret }),
  ),
);
assert.equal(rotations.filter((result) => result.ok).length, 1);
assert.equal(rotations.find((result) => !result.ok).error.code, "REVISION_CONFLICT");
assert.equal(await code(owner, "connections.test", { id: connection.id }), "NOT_FOUND");
assert.equal(
  await code(member, "connections.put", {
    id: connection.id,
    revision: connection.revision,
    name: "Repo",
    kind: "jira",
    credentialId: credential.id,
  }),
  "VALIDATION_FAILED",
  "A connection keeps its kind",
);
const user = await data(member, "agents.put", {
  name: "Coder",
  modelId: "test.echo",
  codeInterpreter: true,
  connectionIds: [connection.id],
});
assert.equal(
  await code(member, "connections.delete", { id: connection.id, revision: connection.revision }),
  "CONNECTION_IN_USE",
);
await data(member, "agents.put", {
  id: user.id,
  revision: user.revision,
  name: "Coder",
  modelId: "test.echo",
});
await data(member, "connections.delete", { id: connection.id, revision: connection.revision });
current = (await data(member, "credentials.list")).items[0];
await data(member, "credentials.delete", { id: credential.id, revision: current.revision });
assert.equal((await data(member, "credentials.list")).items.length, 0);
assert.equal(JSON.stringify([...dynamo.items.values()]).includes("secret-value"), false);
console.log("PASS: credentials, connections, concurrent rotation and deletion");

// Administration.
const people = await data(owner, "users.list");
assert.equal(people.items.length, 3);
assert.equal(people.items.find((item) => item.sub === owner.sub).protected, true);
assert.equal(await code(owner, "users.setRole", { sub: owner.sub, role: "Members" }), "PROTECTED_ADMIN");
await data(owner, "users.setRole", { sub: member.sub, role: "Auditors" });
assert.equal(await code(member, "session.get"), "SESSION_CHANGED");
assert.equal(await code(owner, "users.setLimits", { sub: randomUUID(), budgetMicroUsd: null, storageBytes: null }), "NOT_FOUND");
const defaults = await data(owner, "defaults.get");
assert.equal(
  (await data(owner, "defaults.set", { ...defaults, budgetMicroUsd: 1000 })).revision,
  defaults.revision + 1,
);
assert.equal(
  await code(owner, "users.invite", { email: "member@example.com", role: "Members" }),
  "USER_EXISTS",
);
await data(owner, "users.invite", { email: "new@example.com", role: "Members" });
const invited = [...cognito.users.values()].find((item) => item.email === "new@example.com");
invited.groups = [];
await data(owner, "users.setRole", { sub: invited.sub, role: "Members" });
assert.deepEqual(invited.groups, ["Members"], "A person with no role can be given one");
invited.groups = ["Members", "Auditors"];
await data(owner, "users.setRole", { sub: invited.sub, role: "Auditors" });
assert.deepEqual(invited.groups, ["Auditors"], "A half-finished change is repaired");
console.log("PASS: administration, protected owner and access changes");

// A character split across request chunks is decoded intact.
const bytes = Buffer.from(
  JSON.stringify({ v: 1, command: "projects.create", input: { id: "utf", name: "Café ☕" } }),
);
const split = bytes.indexOf(Buffer.from("☕")) + 1;
const created = JSON.parse((await post(owner, [bytes.subarray(0, split), bytes.subarray(split)])).text);
assert.equal(created.data.name, "Café ☕");
console.log("PASS: multi-byte request bodies");

// The documented command table is the real one, rules included.
const { commands } = await import("../runtime/commands.js");
const { readFile } = await import("node:fs/promises");
const architecture = await readFile(
  new URL("../docs/ARCHITECTURE.md", import.meta.url),
  "utf8",
);
const documented = [
  ...architecture
    .match(/<!-- commands:start -->([\s\S]*?)<!-- commands:end -->/)[1]
    .matchAll(/^\| `([\w.]+)` \|([^|]*)\|/gm),
].map(([, name, rule]) => [name, rule]);
assert.deepEqual(
  documented.map(([name]) => name).sort(),
  Object.keys(commands).sort(),
  "docs/ARCHITECTURE.md lists exactly the Runtime's commands",
);
for (const [name, rule] of documented)
  for (const flag of ["write", "admin", "stream"])
    assert.equal(rule.includes(flag), Boolean(commands[name][flag]), `${name} ${flag}`);
console.log("PASS: documented commands and role rules match the Runtime");

process.exit(0);
