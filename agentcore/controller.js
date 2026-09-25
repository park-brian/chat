// One AgentCore Runtime owns product control and the configured agent loop.
// AgentCore validates the Cognito JWT before forwarding its Authorization header.
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { SignatureV4 } from "@smithy/signature-v4";
import { Hash } from "@smithy/hash-node";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { S3Client, CopyObjectCommand, DeleteObjectCommand,
  GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { BedrockRuntimeClient, ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { scriptedStream } from "./scripted-model.js";
import { modelCost, periodKey } from "./accounting.js";
import { geminiRequest, geminiFunctionResult, geminiStepCalls,
  readGeminiStream } from "./gemini-protocol.js";
import suggestedModels from "./models.json" with { type: "json" };
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
  AdminCreateUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminListGroupsForUserCommand,
  AdminEnableUserCommand,
  AdminDisableUserCommand,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  DynamoDBClient, DeleteItemCommand, GetItemCommand, PutItemCommand, QueryCommand,
  TransactWriteItemsCommand, UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  BedrockAgentCoreClient, CreateEventCommand, DeleteEventCommand,
  GetEventCommand, ListEventsCommand,
  GetResourceApiKeyCommand,
  StartCodeInterpreterSessionCommand, InvokeCodeInterpreterCommand,
  StopCodeInterpreterSessionCommand,
  StartBrowserSessionCommand, InvokeBrowserCommand, StopBrowserSessionCommand,
} from "@aws-sdk/client-bedrock-agentcore";

const scriptedModel = { id: "test.echo", name: "Scripted echo (test only)",
  transport: "scripted", contextTokens: 1000000, maxOutputTokens: 128000,
  thinkingLevels: [], browserTool: true, active: true };
const idp = new CognitoIdentityProviderClient({});
const db = new DynamoDBClient({});
const memory = new BedrockAgentCoreClient({});
const bedrock = new BedrockRuntimeClient({});
const s3 = new S3Client({});
// V2 may restore workers from one snapshot, including random state. Mix fresh
// clock time with uncached entropy so separate sessions cannot reuse a key.
const uuid = () => {
  const hex = createHash("sha256")
    .update(`${randomUUID({ disableEntropyCache: true })}:${Date.now()}:${process.hrtime.bigint()}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const S = (value) => ({ S: String(value) });
const N = (value) => ({ N: String(value) });
const key = (pk, sk) => ({ pk: S(pk), sk: S(sk) });
const unpack = (item) =>
  Object.fromEntries(
    Object.entries(item || {}).map(([name, value]) => [
      name,
      value.S ?? (value.N !== undefined ? Number(value.N) :
        value.BOOL !== undefined ? value.BOOL : value.L?.map((part) => part.S)),
    ]),
  );

function caller(authorization) {
  const token =
    /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(
      authorization || "",
    )?.[1];
  if (!token) return null;
  // This is claim extraction, not signature verification. The configured AgentCore
  // custom JWT authorizer is the trust boundary; never expose this server directly.
  const claims = JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString(),
  );
  const groups = claims["cognito:groups"];
  if (
    claims.iss !== process.env.ISSUER ||
    claims.client_id !== process.env.CLIENT ||
    claims.token_use !== "access" ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= Date.now() / 1000 ||
    !/^[0-9a-f-]{36}$/i.test(claims.sub || "") ||
    !Array.isArray(groups) ||
    groups.length !== 1 ||
    !["Administrators", "Members", "Auditors"].includes(groups[0])
  )
    return null;
  return { sub: claims.sub, role: groups[0] };
}

async function currentIdentity(identity) {
  try {
    const [user, groups] = await Promise.all([
    idp.send(new AdminGetUserCommand({ UserPoolId: process.env.POOL,
      Username: identity.sub })),
    idp.send(new AdminListGroupsForUserCommand({ UserPoolId: process.env.POOL,
      Username: identity.sub, Limit: 10 })),
    ]);
    const names = (groups.Groups || []).map((group) => group.GroupName);
    return user.Enabled && names.length === 1 && names[0] === identity.role;
  } catch (error) {
    if (error.name === "UserNotFoundException") return false;
    throw error;
  }
}

async function protectedAdministrator(sub) {
  const existing = await db.send(new GetItemCommand({ TableName: process.env.TABLE,
    Key: key("ACCOUNT#CONTROL", "OWNER"), ConsistentRead: true }));
  if (existing.Item?.ownerSub?.S) return existing.Item.ownerSub.S;
  const configured = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  let owner = sub;
  if (configured) {
    const users = await idp.send(new ListUsersCommand({ UserPoolId: process.env.POOL,
      Filter: `email = "${configured.replaceAll('"', "")}"`, Limit: 10 }));
    owner = users.Users?.find((user) => user.Attributes?.some((attribute) =>
      attribute.Name === "email" && attribute.Value?.toLowerCase() === configured))
      ?.Attributes?.find((attribute) => attribute.Name === "sub")?.Value;
    if (!owner) return null;
  }
  const row = await db.send(new UpdateItemCommand({
    TableName: process.env.TABLE, Key: key("ACCOUNT#CONTROL", "OWNER"),
    UpdateExpression: "SET ownerSub = if_not_exists(ownerSub, :sub)",
    ExpressionAttributeValues: { ":sub": S(owner) }, ReturnValues: "ALL_NEW",
  }));
  return row.Attributes.ownerSub.S;
}

async function defaults() {
  const existing = await db.send(new GetItemCommand({ TableName: process.env.TABLE,
    Key: key("ACCOUNT#CONTROL", "DEFAULTS"), ConsistentRead: true }));
  if (existing.Item?.baselineBudgetMicroUsd && existing.Item?.baselineStorageBytes)
    return unpack(existing.Item);
  const initialBudget = Number(existing.Item?.budgetMicroUsd?.N ?? process.env.BUDGET);
  const initialStorage = Number(existing.Item?.storageBytes?.N ?? process.env.STORAGE);
  const row = await db.send(
    new UpdateItemCommand({
      TableName: process.env.TABLE,
      Key: key("ACCOUNT#CONTROL", "DEFAULTS"),
      UpdateExpression:
        "SET budgetMicroUsd = if_not_exists(budgetMicroUsd, :budget), storageBytes = if_not_exists(storageBytes, :storage), baselineBudgetMicroUsd = if_not_exists(baselineBudgetMicroUsd, :baselineBudget), baselineStorageBytes = if_not_exists(baselineStorageBytes, :baselineStorage), #period = if_not_exists(#period, :period), revision = if_not_exists(revision, :zero)",
      ExpressionAttributeNames: { "#period": "period" },
      ExpressionAttributeValues: {
        ":budget": N(process.env.BUDGET),
        ":storage": N(process.env.STORAGE),
        ":baselineBudget": N(initialBudget),
        ":baselineStorage": N(initialStorage),
        ":period": S("daily"),
        ":zero": N(0),
      },
      ReturnValues: "ALL_NEW",
    }),
  );
  return unpack(row.Attributes);
}

const projectPattern = /^[a-z0-9][a-z0-9-]{0,39}$/;
const projectIdOf = (input) => input.projectId ?? "main";
const projectKey = (sub, projectId) => `PROJECT#${sub}/${projectId}`;
const projectMetaKey = (sub, projectId) => key(`USER#${sub}`, `PROJECT#${projectId}`);
const invalid = () => ({ status: 400, data: { ok: false,
  error: { code: "VALIDATION_FAILED" } } });
const missing = () => ({ status: 404, data: { ok: false,
  error: { code: "NOT_FOUND" } } });
const mainProject = { id: "main", name: "Main project", hidden: false };
const projectPublic = ({ id, name, hidden, revision, createdAt }) =>
  ({ id, name, hidden, ...(revision !== undefined && { revision }),
    ...(createdAt && { createdAt }) });
const objectKey = (sub, id) => key(`USER#${sub}`, `OBJECT#${id}`);
const objectPublic = ({ id, projectId, name, kind, contentType, sizeBytes,
  createdAt, status }) => ({ id, projectId, name, kind, contentType, sizeBytes,
    createdAt, status });
const uploadKey = (sub, id) => `pending/${sub}/${id}`;
const savedKey = (sub, projectId, id) => `users/${sub}/${projectId}/${id}`;

async function storageState(identity) {
  const [limits, row] = await Promise.all([defaults(), db.send(new GetItemCommand({
    TableName: process.env.TABLE, Key: key(`USER#${identity.sub}`, "CONTROL"),
    ConsistentRead: true }))]);
  return { limitBytes: effectiveLimits(row.Item, limits).storageBytes,
    usedBytes: Number(row.Item?.storageUsedBytes?.N || 0) };
}

async function selectedSkills(identity, projectId, ids) {
  if (!ids?.length) return [];
  const rows = await Promise.all(ids.map((id) => db.send(new GetItemCommand({
    TableName: process.env.TABLE, Key: objectKey(identity.sub, id),
    ConsistentRead: true }))));
  if (rows.some((row) => row.Item?.projectId?.S !== projectId ||
    row.Item?.kind?.S !== "skill" || row.Item?.status?.S !== "ACTIVE" ||
    Number(row.Item?.sizeBytes?.N || 0) > 50000))
    throw Error("Selected skill was removed");
  return Promise.all(rows.map(async (row) => {
    const item = unpack(row.Item);
    const object = await s3.send(new GetObjectCommand({ Bucket: process.env.BUCKET,
      Key: item.key, ...(item.versionId && { VersionId: item.versionId }) }));
    const text = await object.Body.transformToString("utf-8");
    if (text.length > 50000 || text.includes("\0")) throw Error("Invalid skill text");
    return { id: item.id, name: item.name, text };
  }));
}

async function activateObject(identity, item, sizeBytes, versionId) {
  const keyName = savedKey(identity.sub, item.projectId, item.id);
  try {
    await db.send(new TransactWriteItemsCommand({ ClientRequestToken: uuid(),
      TransactItems: [
      { Update: { TableName: process.env.TABLE, Key: objectKey(identity.sub, item.id),
        UpdateExpression: "SET #status = :active, #key = :key, sizeBytes = :size, versionId = :version REMOVE stageKey, expiresAt",
        ConditionExpression: "#status = :pending",
        ExpressionAttributeNames: { "#status": "status", "#key": "key" },
        ExpressionAttributeValues: { ":active": S("ACTIVE"), ":pending": S("PENDING"),
          ":key": S(keyName), ":size": N(sizeBytes), ":version": S(versionId || "") } } },
      { Update: { TableName: process.env.TABLE,
        Key: key(`USER#${identity.sub}`, "CONTROL"),
        UpdateExpression: "ADD storageUsedBytes :size",
        ExpressionAttributeValues: { ":size": N(sizeBytes) } } },
    ] }));
    return { ...item, key: keyName, status: "ACTIVE", sizeBytes,
      versionId: versionId || "" };
  } catch (error) {
    const latest = await db.send(new GetItemCommand({ TableName: process.env.TABLE,
      Key: objectKey(identity.sub, item.id), ConsistentRead: true }));
    if (latest.Item?.status?.S === "ACTIVE") return unpack(latest.Item);
    throw error;
  }
}

async function repairPendingObject(identity, item) {
  if (item.status !== "PENDING") return item;
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: process.env.BUCKET,
      Key: savedKey(identity.sub, item.projectId, item.id) }));
    if (!Number.isSafeInteger(head.ContentLength) ||
      head.ContentLength > item.declaredBytes) return item;
    return activateObject(identity, item, head.ContentLength, head.VersionId);
  } catch (error) {
    if (error.$metadata?.httpStatusCode === 404) return item;
    throw error;
  }
}

async function project(identity, projectId) {
  if (!projectPattern.test(projectId || "")) return null;
  if (projectId === "main") return mainProject;
  const row = await db.send(new GetItemCommand({ TableName: process.env.TABLE,
    Key: projectMetaKey(identity.sub, projectId), ConsistentRead: true }));
  return row.Item ? unpack(row.Item) : null;
}

async function listProjects(identity) {
  const page = await db.send(new QueryCommand({ TableName: process.env.TABLE,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": S(`USER#${identity.sub}`), ":prefix": S("PROJECT#") },
    Limit: 100, ConsistentRead: true }));
  return [mainProject, ...(page.Items || []).map(unpack).map(projectPublic)];
}

function effectiveLimits(row, limits) {
  const choose = (legacy, override, baseline) => {
    if (row?.limitsVersion?.N === "2")
      return row[override]?.N === undefined ? limits[legacy] : Number(row[override].N);
    const old = row?.[legacy]?.N;
    return old === undefined || Number(old) === limits[baseline]
      ? limits[legacy] : Number(old);
  };
  return { budgetMicroUsd: choose("budgetMicroUsd", "budgetOverrideMicroUsd",
      "baselineBudgetMicroUsd"),
    storageBytes: choose("storageBytes", "storageOverrideBytes", "baselineStorageBytes"),
    period: row?.periodOverride?.S || limits.period,
    budgetEpoch: Number(row?.budgetEpoch?.N || 0) };
}

async function approvedModel(modelId) {
  if (modelId === "test.echo")
    return process.env.SCRIPTED_MODEL === "true" ? scriptedModel : null;
  const model = suggestedModels.find((entry) => entry.id === modelId);
  return (model?.transport === "bedrock" ||
    (model?.transport === "gemini" && process.env.GEMINI_PROVIDER)) &&
    Number.isSafeInteger(model.inputRate) &&
    Number.isSafeInteger(model.outputRate) ? model : null;
}

const modelCatalog = () => [
  ...(process.env.SCRIPTED_MODEL === "true" ? [scriptedModel] : []),
  ...suggestedModels.map((model) => ({ ...model,
    active: model.transport === "bedrock" ||
      (model.transport === "gemini" && Boolean(process.env.GEMINI_PROVIDER)) })),
];

async function listAgents(identity, projectId = "main", includeArchived = true) {
  const page = await db.send(new QueryCommand({ TableName: process.env.TABLE,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": S(projectKey(identity.sub, projectId)), ":prefix": S("AGENT#") },
    Limit: 100 }));
  return (page.Items || []).map(unpack).map(({ pk, sk, ...agent }) => agent)
    .filter((agent) => includeArchived || !agent.archived);
}

const uuidPattern = /^[0-9a-f-]{36}$/i;
const credentialKey = (identity) => key(`USER#${identity.sub}`, "CREDENTIALS");
const publicConnection = ({ apiKey, ...metadata }) => metadata;

async function credentials(identity) {
  const row = await db.send(new GetItemCommand({ TableName: process.env.TABLE,
    Key: credentialKey(identity), ConsistentRead: true }));
  return { revision: Number(row.Item?.revision?.N || 0),
    items: JSON.parse(row.Item?.connectionsJson?.S || "{}") };
}

async function changeCredentials(identity, edit) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const state = await credentials(identity);
    const result = edit(state.items);
    try {
      await db.send(new PutItemCommand({ TableName: process.env.TABLE,
        Item: { ...credentialKey(identity), revision: N(state.revision + 1),
          connectionsJson: S(JSON.stringify(state.items)) },
        ConditionExpression: state.revision ? "revision = :expected" : "attribute_not_exists(pk)",
        ...(state.revision && { ExpressionAttributeValues: { ":expected": N(state.revision) } }),
      }));
      return result;
    } catch (error) {
      if (error.name !== "ConditionalCheckFailedException") throw error;
    }
  }
  throw Error("Connection changed concurrently; please retry");
}

async function listConversations(identity, projectId, cursor) {
  let start;
  if (cursor) {
    try {
      if (typeof cursor !== "string" || cursor.length > 2000) throw Error();
      start = JSON.parse(Buffer.from(cursor, "base64url").toString());
      if (start.gsi1pk?.S !== `CONVERSATIONS#${identity.sub}/${projectId}` ||
        start.pk?.S !== projectKey(identity.sub, projectId) ||
        !/^CONVERSATION#[0-9a-f-]{36}$/i.test(start.sk?.S || "")) throw Error();
    } catch {
      return { status: 400, data: { ok: false, error: { code: "VALIDATION_FAILED" } } };
    }
  }
  const page = await db.send(new QueryCommand({
    TableName: process.env.TABLE, IndexName: "UsageByTime",
    KeyConditionExpression: "gsi1pk = :pk",
    ExpressionAttributeValues: { ":pk": S(`CONVERSATIONS#${identity.sub}/${projectId}`) },
    ExclusiveStartKey: start, Limit: 30, ScanIndexForward: false,
  }));
  return { status: 200, data: { ok: true, data: {
    items: (page.Items || []).map(unpack).filter((item) =>
      item.status !== "DELETING").map(conversationPublic),
    nextCursor: page.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(page.LastEvaluatedKey)).toString("base64url") : null,
  } } };
}

const branchPattern = /^(main|[0-9a-f-]{36})$/i;
const conversationPublic = ({ id, agentId, title, createdAt, lastActivityAt,
  activeBranchId }) => ({ id, agentId, title, createdAt, lastActivityAt,
    activeBranchId: activeBranchId || "main" });
const eventPattern = /^[0-9]+#[a-f0-9]+$/i;
const branchKey = (sub, projectId, conversationId, branchId) =>
  key(projectKey(sub, projectId), `BRANCH#${conversationId}#${branchId}`);
const archiveKey = (sub, projectId, conversationId, eventId) =>
  key(projectKey(sub, projectId), `ARCHIVE#${conversationId}#${eventId}`);
const archiveObjectKey = (sub, projectId, conversationId, requestId) =>
  `users/${sub}/${projectId}/chats/${conversationId}/${requestId}.json`;

async function archivePath(identity, projectId, conversationId, headEventId, limit = 50) {
  const records = [];
  let cursor = headEventId;
  while (cursor && records.length < limit) {
    const row = await db.send(new GetItemCommand({ TableName: process.env.TABLE,
      Key: archiveKey(identity.sub, projectId, conversationId, cursor),
      ConsistentRead: true }));
    if (!row.Item) return { events: await archiveEvents(records), nextCursor: null,
      incomplete: true };
    const record = unpack(row.Item);
    records.push(record);
    cursor = record.parentEventId || null;
  }
  return { events: await archiveEvents(records), nextCursor: cursor,
    incomplete: false };
}

async function archiveEvents(records) {
  return Promise.all(records.map(async (record) => {
    const result = await s3.send(new GetObjectCommand({
      Bucket: process.env.BUCKET, Key: record.objectKey,
      ...(record.versionId && { VersionId: record.versionId }) }));
    const data = JSON.parse(await result.Body.transformToString());
    return { eventId: record.eventId, payload: [
      { conversational: { role: "USER", content: { text: data.message } } },
      { conversational: { role: "ASSISTANT", content: { text: data.answer } } },
      { json: { content: data.receipt } },
    ] };
  }));
}

async function branchCatalog(identity, projectId, conversationId, conversation) {
  const page = await db.send(new QueryCommand({ TableName: process.env.TABLE,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": S(projectKey(identity.sub, projectId)),
      ":prefix": S(`BRANCH#${conversationId}#`) }, ConsistentRead: true, Limit: 100 }));
  return [{ id: "main", name: "Main", headEventId: conversation.mainHeadEventId || null },
    ...(page.Items || []).map(unpack).map(({ id, name, rootEventId,
      headEventId, createdAt, memorySessionId, memoryRoot }) =>
      ({ id, name, rootEventId: rootEventId || null, headEventId,
        createdAt, memorySessionId, memoryRoot }))];
}

async function branchEvents(actorId, sessionId, branchId, cursor, maxResults = 100) {
  const events = [];
  let nextToken = cursor;
  do {
    const page = await memory.send(new ListEventsCommand({
      memoryId: process.env.MEMORY, actorId, sessionId,
      ...(branchId !== "main" && { filter: { branch: {
        name: branchId, includeParentBranches: true } } }),
      includePayloads: true, maxResults: Math.min(100, maxResults), nextToken,
    }));
    events.push(...(branchId === "main"
      ? (page.events || []).filter((event) =>
        !event.branch || event.branch.name === "main")
      : page.events || []));
    nextToken = page.nextToken;
  } while (nextToken && events.length < maxResults);
  return { events: events.slice(0, maxResults), nextToken };
}

const eventMessages = (events) => events.toReversed().flatMap((event) => {
  const calls = (event.payload || []).find((payload) =>
    Array.isArray(payload.json?.content?.toolCalls))?.json.content.toolCalls || [];
  return (event.payload || []).flatMap((payload) => {
    const entry = payload.conversational;
    return entry?.content?.text && ["USER", "ASSISTANT"].includes(entry.role)
      ? [{ eventId: event.eventId, role: entry.role.toLowerCase(),
        text: entry.content.text, status: "complete",
        ...(entry.role === "ASSISTANT" && { tools: calls }) }]
      : [];
  });
});

async function getSession(identity) {
  const [user, limits] = await Promise.all([
    idp.send(new AdminGetUserCommand({ UserPoolId: process.env.POOL, Username: identity.sub })),
    defaults(),
  ]);
  const row = await db.send(new GetItemCommand({
    TableName: process.env.TABLE, Key: key(`USER#${identity.sub}`, "CONTROL"),
    ConsistentRead: true,
  }));
  const effective = effectiveLimits(row.Item, limits);
  return {
    user: {
      sub: identity.sub,
      email: user.UserAttributes?.find((attribute) => attribute.Name === "email")?.Value || "",
      role: identity.role,
      ...effective,
      storageUsedBytes: Number(row.Item?.storageUsedBytes?.N || 0),
    },
    defaults: limits, defaultProjectId: "main",
  };
}

async function invoke(body, identity) {
  if (body?.v !== 1 || !body.input || typeof body.input !== "object") {
    return {
      status: 400,
      data: { ok: false, error: { code: "VALIDATION_FAILED" } },
    };
  }
  if (body.command === "projects.list")
    return { status: 200, data: { ok: true, data: { items: await listProjects(identity) } } };
  if (["projects.create", "projects.rename", "projects.setHidden"].includes(body.command)) {
    if (identity.role === "Auditors")
      return { status: 403, data: { ok: false, error: { code: "FORBIDDEN" } } };
    const { id, name, hidden, revision } = body.input;
    if (!projectPattern.test(id || "") || id === "main") return invalid();
    if (body.command === "projects.create") {
      if (typeof name !== "string" || !name.trim() || name.length > 80) return invalid();
      if ((await listProjects(identity)).length >= 100)
        return { status: 409, data: { ok: false, error: { code: "PROJECT_LIMIT" } } };
      const item = { ...projectMetaKey(identity.sub, id), id: S(id), name: S(name.trim()),
        hidden: { BOOL: false }, revision: N(0), createdAt: S(new Date().toISOString()) };
      try {
        await db.send(new PutItemCommand({ TableName: process.env.TABLE, Item: item,
          ConditionExpression: "attribute_not_exists(pk)" }));
      } catch (error) {
        if (error.name === "ConditionalCheckFailedException")
          return { status: 409, data: { ok: false, error: { code: "PROJECT_EXISTS" } } };
        throw error;
      }
      return { status: 200, data: { ok: true, data: projectPublic(unpack(item)) } };
    }
    if (!Number.isSafeInteger(revision) || revision < 0 ||
      (body.command === "projects.rename" &&
        (typeof name !== "string" || !name.trim() || name.length > 80)) ||
      (body.command === "projects.setHidden" && typeof hidden !== "boolean"))
      return invalid();
    try {
      const row = await db.send(new UpdateItemCommand({ TableName: process.env.TABLE,
        Key: projectMetaKey(identity.sub, id),
        UpdateExpression: body.command === "projects.rename"
          ? "SET #name = :value, revision = revision + :one"
          : "SET #hidden = :value, revision = revision + :one",
        ConditionExpression: "attribute_exists(pk) AND revision = :revision",
        ExpressionAttributeNames: body.command === "projects.rename"
          ? { "#name": "name" } : { "#hidden": "hidden" },
        ExpressionAttributeValues: { ":value": body.command === "projects.rename"
          ? S(name.trim()) : { BOOL: hidden }, ":one": N(1), ":revision": N(revision) },
        ReturnValues: "ALL_NEW" }));
      return { status: 200, data: { ok: true,
        data: projectPublic(unpack(row.Attributes)) } };
    } catch (error) {
      if (error.name === "ConditionalCheckFailedException")
        return { status: 409, data: { ok: false, error: { code: "REVISION_CONFLICT" } } };
      throw error;
    }
  }
  if (["objects.beginUpload", "objects.completeUpload", "objects.list",
    "objects.get", "objects.delete"].includes(body.command)) {
    const projectId = projectIdOf(body.input);
    if (!projectPattern.test(projectId)) return invalid();
    if (!await project(identity, projectId)) return missing();
    if (["objects.beginUpload", "objects.completeUpload", "objects.delete"]
      .includes(body.command) && identity.role === "Auditors")
      return { status: 403, data: { ok: false, error: { code: "FORBIDDEN" } } };
    if (body.command === "objects.beginUpload") {
      const { name, contentType = "application/octet-stream", sizeBytes,
        kind = "file" } = body.input;
      if (typeof name !== "string" || !name.trim() || name.length > 180 ||
        /[\r\n\0]/.test(name) || !["file", "skill", "artifact"].includes(kind) ||
        typeof contentType !== "string" || !/^[\w.+-]+\/[\w.+-]+$/.test(contentType) ||
        !Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > 5000000000)
        return invalid();
      const storage = await storageState(identity);
      if (storage.usedBytes + sizeBytes > storage.limitBytes)
        return { status: 409, data: { ok: false, error: { code: "QUOTA_EXCEEDED" } } };
      const id = uuid(), stageKey = uploadKey(identity.sub, id);
      const item = { ...objectKey(identity.sub, id), id: S(id), projectId: S(projectId),
        name: S(name.trim()), kind: S(kind), contentType: S(contentType),
        declaredBytes: N(sizeBytes), stageKey: S(stageKey), status: S("PENDING"),
        createdAt: S(new Date().toISOString()),
        expiresAt: N(Math.floor(Date.now() / 1000) + 86400) };
      await db.send(new PutItemCommand({ TableName: process.env.TABLE, Item: item,
        ConditionExpression: "attribute_not_exists(pk)" }));
      const upload = await createPresignedPost(s3, { Bucket: process.env.BUCKET,
        Key: stageKey, Expires: 300,
        Fields: { "Content-Type": contentType },
        Conditions: [{ "Content-Type": contentType },
          ["content-length-range", 1, Math.min(5000016384, sizeBytes + 16384)]] });
      return { status: 200, data: { ok: true, data: {
        id, upload, expiresInSeconds: 300 } } };
    }
    if (body.command === "objects.list") {
      let start;
      if (body.input.cursor) {
        try {
          if (typeof body.input.cursor !== "string" || body.input.cursor.length > 2000)
            throw Error();
          start = JSON.parse(Buffer.from(body.input.cursor, "base64url").toString());
          if (start.pk?.S !== `USER#${identity.sub}` ||
            !/^OBJECT#[0-9a-f-]{36}$/i.test(start.sk?.S || "")) throw Error();
        } catch { return invalid(); }
      }
      const page = await db.send(new QueryCommand({ TableName: process.env.TABLE,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": S(`USER#${identity.sub}`),
            ":prefix": S("OBJECT#") }, ExclusiveStartKey: start,
          ConsistentRead: true, Limit: 50 }));
      const rows = await Promise.all((page.Items || []).map((item) =>
        repairPendingObject(identity, unpack(item))));
      const storage = await storageState(identity);
      return { status: 200, data: { ok: true, data: {
        items: rows.filter((item) =>
          item.projectId === projectId && item.status === "ACTIVE").map(objectPublic),
        ...storage, nextCursor: page.LastEvaluatedKey
          ? Buffer.from(JSON.stringify(page.LastEvaluatedKey)).toString("base64url") : null,
      } } };
    }
    const id = body.input.id;
    if (!uuidPattern.test(id || "")) return invalid();
    const row = await db.send(new GetItemCommand({ TableName: process.env.TABLE,
      Key: objectKey(identity.sub, id), ConsistentRead: true }));
    if (!row.Item || row.Item.projectId?.S !== projectId) return missing();
    let item = unpack(row.Item);
    if (body.command === "objects.completeUpload") {
      if (item.status === "ACTIVE")
        return { status: 200, data: { ok: true, data: { item: objectPublic(item) } } };
      if (item.status !== "PENDING" || item.expiresAt <= Date.now() / 1000)
        return missing();
      let head;
      try {
        head = await s3.send(new HeadObjectCommand({ Bucket: process.env.BUCKET,
          Key: item.stageKey }));
      } catch (error) {
        if (error.$metadata?.httpStatusCode === 404)
          return { status: 409, data: { ok: false, error: { code: "UPLOAD_MISSING" } } };
        throw error;
      }
      const size = head.ContentLength;
      if (!Number.isSafeInteger(size) || size < 1 || size > item.declaredBytes)
        return { status: 409, data: { ok: false, error: { code: "UPLOAD_SIZE_MISMATCH" } } };
      const storage = await storageState(identity);
      if (storage.usedBytes + size > storage.limitBytes)
        return { status: 409, data: { ok: false, error: { code: "QUOTA_EXCEEDED" } } };
      const destination = savedKey(identity.sub, projectId, id);
      const copy = await s3.send(new CopyObjectCommand({ Bucket: process.env.BUCKET,
        Key: destination, CopySource: `${process.env.BUCKET}/${item.stageKey}`,
        MetadataDirective: "REPLACE", ContentType: item.contentType }));
      const saved = await activateObject(identity, item, size, copy.VersionId);
      await s3.send(new DeleteObjectCommand({ Bucket: process.env.BUCKET,
        Key: item.stageKey, ...(head.VersionId && { VersionId: head.VersionId }) }))
        .catch(() => console.error("Could not remove completed staging object"));
      return { status: 200, data: { ok: true, data: { item: objectPublic(saved) } } };
    }
    if (item.status === "PENDING") item = await repairPendingObject(identity, item);
    if (item.status !== "ACTIVE") return missing();
    if (body.command === "objects.get") {
      const url = await getSignedUrl(s3, new GetObjectCommand({
        Bucket: process.env.BUCKET, Key: item.key,
        ...(item.versionId && { VersionId: item.versionId }) }), { expiresIn: 300 });
      return { status: 200, data: { ok: true, data: { url, expiresInSeconds: 300 } } };
    }
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.BUCKET,
      Key: item.key, ...(item.versionId && { VersionId: item.versionId }) }));
    try {
      await db.send(new TransactWriteItemsCommand({ ClientRequestToken: uuid(),
        TransactItems: [
        { Update: { TableName: process.env.TABLE, Key: objectKey(identity.sub, id),
          UpdateExpression: "SET #status = :deleted, expiresAt = :expiry",
          ConditionExpression: "#status = :active",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":deleted": S("DELETED"), ":active": S("ACTIVE"),
            ":expiry": N(Math.floor(Date.now() / 1000) + 30 * 86400) } } },
        { Update: { TableName: process.env.TABLE, Key: key(`USER#${identity.sub}`, "CONTROL"),
          UpdateExpression: "ADD storageUsedBytes :size",
          ExpressionAttributeValues: { ":size": N(-item.sizeBytes) } } },
      ] }));
    } catch (error) {
      const latest = await db.send(new GetItemCommand({ TableName: process.env.TABLE,
        Key: objectKey(identity.sub, id), ConsistentRead: true }));
      if (latest.Item?.status?.S !== "DELETED") throw error;
    }
    return { status: 200, data: { ok: true, data: { deleted: true } } };
  }
  if (body.command === "agents.list") {
    const projectId = projectIdOf(body.input);
    if (!projectPattern.test(projectId)) return invalid();
    if (!await project(identity, projectId)) return missing();
    if (body.input.includeArchived !== undefined &&
      typeof body.input.includeArchived !== "boolean") return invalid();
    return { status: 200, data: { ok: true, data: { items: await listAgents(
      identity, projectId, body.input.includeArchived ?? true) } } };
  }
  if (body.command === "agents.setArchived") {
    if (identity.role === "Auditors") return { status: 403, data: {
      ok: false, error: { code: "FORBIDDEN" } } };
    const { id, revision, archived } = body.input;
    const projectId = projectIdOf(body.input);
    if (!projectPattern.test(projectId) || !uuidPattern.test(id || "") ||
      !Number.isSafeInteger(revision) || revision < 0 ||
      typeof archived !== "boolean") return invalid();
    if (!await project(identity, projectId)) return missing();
    try {
      const updated = await db.send(new UpdateItemCommand({
        TableName: process.env.TABLE,
        Key: key(projectKey(identity.sub, projectId), `AGENT#${id}`),
        UpdateExpression: "SET archived = :archived, revision = :next",
        ConditionExpression: "attribute_exists(pk) AND revision = :revision",
        ExpressionAttributeValues: { ":archived": { BOOL: archived },
          ":next": N(revision + 1), ":revision": N(revision) },
        ReturnValues: "ALL_NEW" }));
      return { status: 200, data: { ok: true, data: unpack(updated.Attributes) } };
    } catch (error) {
      if (error.name === "ConditionalCheckFailedException")
        return { status: 409, data: { ok: false, error: { code: "REVISION_CONFLICT" } } };
      throw error;
    }
  }
  if (body.command === "connections.list") {
    const projectId = projectIdOf(body.input);
    if (!projectPattern.test(projectId)) return invalid();
    if (!await project(identity, projectId)) return missing();
    const state = await credentials(identity);
    return { status: 200, data: { ok: true, data: {
      items: Object.values(state.items).map(publicConnection) } } };
  }
  if (body.command === "connections.test") {
    const projectId = projectIdOf(body.input);
    if (!projectPattern.test(projectId) || !uuidPattern.test(body.input.id || ""))
      return invalid();
    if (!await project(identity, projectId)) return missing();
    if (identity.role === "Auditors")
      return { status: 403, data: { ok: false, error: { code: "FORBIDDEN" } } };
    const connection = (await credentials(identity)).items[body.input.id];
    if (!connection) return missing();
    const jira = connection.kind === "jira";
    const host = jira ? new URL(connection.jiraUrl) : null;
    // Never turn a user-supplied Jira URL into an authenticated SSRF probe.
    if (jira && (host.protocol !== "https:" || host.port ||
      !/^[a-z0-9-]+\.atlassian\.net$/i.test(host.hostname)))
      return { status: 400, data: { ok: false,
        error: { code: "CONNECTION_TEST_UNAVAILABLE" } } };
    const url = jira ? new URL("/rest/api/3/myself", host).href :
      "https://api.github.com/user";
    let checked;
    try {
      const result = await fetch(url, { method: "GET", redirect: "manual",
        signal: AbortSignal.timeout(8000), headers: {
          Accept: "application/json",
          Authorization: jira ? "Basic " + Buffer.from(
            connection.jiraEmail + ":" + connection.apiKey).toString("base64") :
            "Bearer " + connection.apiKey,
          ...(!jira && { "User-Agent": "agentcore-chat-connection-check" }),
        } });
      const connected = result.status === 200;
      let account = null;
      if (connected) {
        const length = Number(result.headers.get("content-length") || 0);
        if (length > 16384) throw Error("Connection response too large");
        const raw = await result.text();
        if (raw.length > 16384) throw Error("Connection response too large");
        const data = JSON.parse(raw);
        const label = jira ? data.displayName : data.login;
        if (typeof label === "string") account = label.slice(0, 120);
      } else await result.body?.cancel();
      checked = { connected, account, httpStatus: result.status };
    } catch {
      checked = { connected: false, account: null, httpStatus: null };
    }
    return { status: 200, data: { ok: true, data: checked } };
  }
  if (["connections.put", "connections.rotate", "connections.delete"].includes(body.command)) {
    if (identity.role === "Auditors")
      return { status: 403, data: { ok: false, error: { code: "FORBIDDEN" } } };
    const projectId = projectIdOf(body.input);
    if (!projectPattern.test(projectId)) return invalid();
    if (!await project(identity, projectId)) return missing();
    if (body.command === "connections.put") {
      const { name, kind, apiKey, jiraUrl = "", jiraEmail = "" } = body.input;
      let url;
      try { if (kind === "jira") url = new URL(jiraUrl); } catch { /* invalid below */ }
      if (!["github", "jira"].includes(kind) || typeof name !== "string" ||
        !name.trim() || name.length > 80 || typeof apiKey !== "string" ||
        !apiKey || apiKey.length > 4096 || /[\r\n\0]/.test(apiKey) ||
        (kind === "jira" && (url?.protocol !== "https:" || url.username || url.password ||
          url.search || url.hash || jiraUrl.length > 500 ||
          !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(jiraEmail || ""))))
        return { status: 400, data: { ok: false, error: { code: "VALIDATION_FAILED" } } };
      const item = { id: uuid(), name: name.trim(), kind, apiKey,
        createdAt: new Date().toISOString(),
        ...(kind === "jira" && { jiraUrl: url.href.replace(/\/$/, ""), jiraEmail }) };
      let visible;
      try {
        visible = await changeCredentials(identity, (items) => {
          if (Object.keys(items).length >= 10) throw Error("Connection limit reached");
          items[item.id] = item;
          return publicConnection(item);
        });
      } catch (error) {
        if (error.message === "Connection limit reached")
          return { status: 409, data: { ok: false, error: { code: "CONNECTION_LIMIT" } } };
        throw error;
      }
      return { status: 200, data: { ok: true, data: visible } };
    }
    const { id } = body.input;
    if (!uuidPattern.test(id || ""))
      return { status: 400, data: { ok: false, error: { code: "VALIDATION_FAILED" } } };
    if (body.command === "connections.rotate") {
      const { apiKey } = body.input;
      if (typeof apiKey !== "string" || !apiKey || apiKey.length > 4096 ||
        /[\r\n\0]/.test(apiKey))
        return { status: 400, data: { ok: false, error: { code: "VALIDATION_FAILED" } } };
    }
    try {
      await changeCredentials(identity, (items) => {
        if (!items[id]) throw Error("Connection not found");
        if (body.command === "connections.rotate") items[id].apiKey = body.input.apiKey;
        else delete items[id];
      });
    } catch (error) {
      if (error.message === "Connection not found")
        return { status: 404, data: { ok: false, error: { code: "NOT_FOUND" } } };
      throw error;
    }
    return { status: 200, data: { ok: true, data: {
      [body.command === "connections.rotate" ? "rotated" : "deleted"]: true } } };
  }
  if (body.command === "workspace.get") {
    const projectId = projectIdOf(body.input);
    if (!projectPattern.test(projectId) || Object.keys(body.input).some((name) => name !== "projectId"))
      return invalid();
    if (!await project(identity, projectId)) return missing();
    const [session, projects, agents, conversations] = await Promise.all([
      getSession(identity), listProjects(identity), listAgents(identity, projectId),
      listConversations(identity, projectId),
    ]);
    return { status: 200, data: { ok: true,
      data: { session, projects, agents, models: modelCatalog(),
        conversations: conversations.data.data } } };
  }
  if (body.command === "conversations.list") {
    const projectId = projectIdOf(body.input);
    if (!projectPattern.test(projectId)) return invalid();
    if (!await project(identity, projectId)) return missing();
    return listConversations(identity, projectId, body.input.cursor);
  }
  if (body.command === "conversations.get") {
    const { agentId, conversationId, cursor } = body.input;
    const projectId = projectIdOf(body.input);
    const branchId = body.input.branchId ?? "main";
    const uuid = /^[0-9a-f-]{36}$/i;
    if (!projectPattern.test(projectId) || !branchPattern.test(branchId) || !uuid.test(agentId || "") ||
      !uuid.test(conversationId || "") ||
      (cursor !== undefined && (typeof cursor !== "string" || cursor.length > 4000)))
      return { status: 400, data: { ok: false, error: { code: "VALIDATION_FAILED" } } };
    if (!await project(identity, projectId)) return missing();
    const row = await db.send(new GetItemCommand({ TableName: process.env.TABLE,
      Key: key(projectKey(identity.sub, projectId), `CONVERSATION#${conversationId}`),
      ConsistentRead: true }));
    if (!row.Item || row.Item.agentId?.S !== agentId ||
      row.Item.status?.S === "DELETING")
      return { status: 404, data: { ok: false, error: { code: "NOT_FOUND" } } };
    const conversation = unpack(row.Item);
    const branches = await branchCatalog(identity, projectId, conversationId, conversation);
    if (!branches.some((branch) => branch.id === branchId)) return missing();
    const selected = branches.find((branch) => branch.id === branchId);
    if (conversation.durable && cursor && !eventPattern.test(cursor)) return invalid();
    const page = conversation.durable
      ? await archivePath(identity, projectId, conversationId,
        cursor || selected.headEventId, 50)
      : await branchEvents(`${identity.sub}/${projectId}`,
        selected.memorySessionId || conversation.mainMemorySessionId ||
          `a_${agentId}_${conversationId}`,
        selected.memoryRoot ? "main" : selected.id, cursor);
    return { status: 200, data: { ok: true, data: {
      conversation: conversationPublic(conversation), branchId,
      branches: branches.map(({ memorySessionId, memoryRoot, ...branch }) => branch),
      messages: eventMessages(page.events),
      historyExpired: !conversation.durable && !page.events.length,
      archiveIncomplete: Boolean(page.incomplete),
      nextCursor: page.nextCursor || page.nextToken || null,
    } } };
  }
  if (body.command === "conversations.delete") {
    if (identity.role === "Auditors")
      return { status: 403, data: { ok: false, error: { code: "FORBIDDEN" } } };
    const { conversationId, agentId } = body.input;
    const projectId = projectIdOf(body.input);
    if (!projectPattern.test(projectId) || !uuidPattern.test(conversationId || "") ||
      (agentId !== undefined && !uuidPattern.test(agentId))) return invalid();
    if (!await project(identity, projectId)) return missing();
    const conversationKey = key(projectKey(identity.sub, projectId),
      `CONVERSATION#${conversationId}`);
    const read = () => db.send(new GetItemCommand({ TableName: process.env.TABLE,
      Key: conversationKey, ConsistentRead: true }));
    const row = await read();
    if (!row.Item) return { status: 200, data: { ok: true,
      data: { deleted: true } } };
    if (agentId && row.Item.agentId?.S !== agentId) return missing();
    if (row.Item.status?.S !== "DELETING") {
      try {
        await db.send(new UpdateItemCommand({ TableName: process.env.TABLE,
          Key: conversationKey,
          UpdateExpression: "SET #status = :deleting REMOVE gsi1pk, gsi1sk",
          ConditionExpression: "attribute_exists(pk) AND (attribute_not_exists(#status) OR #status = :active)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":deleting": S("DELETING"),
            ":active": S("ACTIVE") } }));
      } catch (error) {
        if (error.name !== "ConditionalCheckFailedException") throw error;
        const current = await read();
        if (!current.Item) return { status: 200, data: { ok: true,
          data: { deleted: true } } };
        if (current.Item.status?.S !== "DELETING") throw error;
      }
    }
    const archives = await db.send(new QueryCommand({ TableName: process.env.TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": S(projectKey(identity.sub, projectId)),
        ":prefix": S(`ARCHIVE#${conversationId}#`) },
      ConsistentRead: true, Limit: 100 }));
    for (const item of archives.Items || []) {
      if (!item.versionId?.S) throw Error("Archive version is missing");
      await s3.send(new DeleteObjectCommand({ Bucket: process.env.BUCKET,
        Key: item.objectKey.S, VersionId: item.versionId.S }));
      try {
        await db.send(new TransactWriteItemsCommand({ ClientRequestToken: uuid(),
          TransactItems: [
            { Delete: { TableName: process.env.TABLE,
              Key: { pk: item.pk, sk: item.sk },
              ConditionExpression: "versionId = :version",
              ExpressionAttributeValues: { ":version": item.versionId } } },
            { Update: { TableName: process.env.TABLE,
              Key: key(`USER#${identity.sub}`, "CONTROL"),
              UpdateExpression: "ADD storageUsedBytes :bytes",
              ExpressionAttributeValues: { ":bytes": N(-Number(item.sizeBytes.N)) } } },
          ] }));
      } catch (error) {
        if (error.name !== "TransactionCanceledException") throw error;
        const latest = await db.send(new GetItemCommand({ TableName: process.env.TABLE,
          Key: { pk: item.pk, sk: item.sk }, ConsistentRead: true }));
        if (latest.Item) throw error;
      }
    }
    if (archives.LastEvaluatedKey || archives.Items?.length === 100)
      return { status: 200, data: { ok: true, data: { deleting: true } } };
    const sessions = new Set([row.Item.mainMemorySessionId?.S ||
      `a_${row.Item.agentId.S}_${conversationId}`,
      ...(row.Item.memorySessions?.SS || [])]);
    const branches = await db.send(new QueryCommand({ TableName: process.env.TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": S(projectKey(identity.sub, projectId)),
        ":prefix": S(`BRANCH#${conversationId}#`) },
      ConsistentRead: true, Limit: 100 }));
    for (const branch of branches.Items || [])
      if (branch.memorySessionId?.S) sessions.add(branch.memorySessionId.S);
    let removed = 0;
    for (const sessionId of sessions) {
      let page;
      try {
        page = await memory.send(new ListEventsCommand({ memoryId: process.env.MEMORY,
          actorId: `${identity.sub}/${projectId}`, sessionId,
          maxResults: 100, includePayloads: false }));
      } catch (error) {
        if (error.name === "ResourceNotFoundException") continue;
        throw error;
      }
      for (const event of page.events || []) {
        await memory.send(new DeleteEventCommand({ memoryId: process.env.MEMORY,
          actorId: `${identity.sub}/${projectId}`, sessionId,
          eventId: event.eventId })).catch((error) => {
          if (error.name !== "ResourceNotFoundException") throw error;
        });
        if (++removed === 100)
          return { status: 200, data: { ok: true,
            data: { deleting: true } } };
      }
      if (page.nextToken)
        return { status: 200, data: { ok: true,
          data: { deleting: true } } };
    }
    for (const branch of branches.Items || [])
      await db.send(new DeleteItemCommand({ TableName: process.env.TABLE,
        Key: { pk: branch.pk, sk: branch.sk } }));
    if (branches.LastEvaluatedKey || branches.Items?.length === 100)
      return { status: 200, data: { ok: true, data: { deleting: true } } };
    await db.send(new DeleteItemCommand({ TableName: process.env.TABLE,
      Key: conversationKey, ConditionExpression: "#status = :deleting",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":deleting": S("DELETING") } }))
      .catch((error) => {
        if (error.name !== "ConditionalCheckFailedException") throw error;
      });
    return { status: 200, data: { ok: true, data: { deleted: true } } };
  }
  if (body.command === "agents.put") {
    if (identity.role === "Auditors")
      return { status: 403, data: { ok: false, error: { code: "FORBIDDEN" } } };
    const { id: existingId, revision, name, modelId,
      systemPrompt = "", codeInterpreter = false, webSearch = false, browser = false,
      connectionIds = [], skillIds = [], thinkingLevel,
      webSearchMaxResults = 5, browserSessionSeconds = 300 } = body.input;
    const projectId = projectIdOf(body.input);
    if (!projectPattern.test(projectId) || typeof name !== "string" || !name.trim() || name.length > 80 ||
      typeof modelId !== "string" || !modelId || modelId.length > 512 ||
      typeof systemPrompt !== "string" || systemPrompt.length > 12000 ||
      [codeInterpreter, webSearch, browser].some((value) => typeof value !== "boolean") ||
      !Array.isArray(connectionIds) || connectionIds.length > 4 ||
      connectionIds.some((id) => !uuidPattern.test(id || "")) ||
      new Set(connectionIds).size !== connectionIds.length ||
      !Array.isArray(skillIds) || skillIds.length > 4 ||
      skillIds.some((id) => !uuidPattern.test(id || "")) ||
      new Set(skillIds).size !== skillIds.length ||
      (connectionIds.length && !codeInterpreter) ||
      (existingId !== undefined && (!uuidPattern.test(existingId || "") ||
        !Number.isSafeInteger(revision) || revision < 0)) ||
      !Number.isSafeInteger(webSearchMaxResults) || webSearchMaxResults < 1 || webSearchMaxResults > 25 ||
      !Number.isSafeInteger(browserSessionSeconds) || browserSessionSeconds < 60 ||
      browserSessionSeconds > 900)
      return { status: 400, data: { ok: false, error: { code: "VALIDATION_FAILED" } } };
    if (!await project(identity, projectId)) return missing();
    const model = await approvedModel(modelId);
    if (!model)
      return { status: 400, data: { ok: false, error: { code: "MODEL_UNAVAILABLE" } } };
    const selectedThinkingLevel = thinkingLevel ?? model.defaultThinkingLevel;
    if (model.thinkingLevels.length
      ? !model.thinkingLevels.includes(selectedThinkingLevel)
      : thinkingLevel !== undefined)
      return { status: 400, data: { ok: false, error: { code: "VALIDATION_FAILED" } } };
    if (browser && !model.browserTool)
      return { status: 400, data: { ok: false, error: { code: "TOOL_UNAVAILABLE" } } };
    if (connectionIds.length) {
      const saved = (await credentials(identity)).items;
      const selected = connectionIds.map((id) => saved[id]);
      if (selected.some((item) => !item) ||
        new Set(selected.map((item) => item.kind)).size !== selected.length)
        return { status: 400, data: { ok: false, error: { code: "CONNECTION_UNAVAILABLE" } } };
    }
    if (skillIds.length) {
      const selected = await Promise.all(skillIds.map((id) => db.send(new GetItemCommand({
        TableName: process.env.TABLE, Key: objectKey(identity.sub, id),
        ConsistentRead: true }))));
      if (selected.some((row) => row.Item?.projectId?.S !== projectId ||
        row.Item?.kind?.S !== "skill" || row.Item?.status?.S !== "ACTIVE" ||
        Number(row.Item?.sizeBytes?.N || 0) > 50000))
        return { status: 400, data: { ok: false,
          error: { code: "SKILL_UNAVAILABLE" } } };
    }
    const id = existingId || uuid();
    let createdAt = new Date().toISOString();
    let legacyRevision = false;
    if (existingId) {
      const current = await db.send(new GetItemCommand({ TableName: process.env.TABLE,
        Key: key(projectKey(identity.sub, projectId), `AGENT#${id}`), ConsistentRead: true }));
      if (!current.Item)
        return { status: 404, data: { ok: false, error: { code: "NOT_FOUND" } } };
      if (current.Item.archived?.BOOL)
        return { status: 409, data: { ok: false, error: { code: "AGENT_ARCHIVED" } } };
      if (Number(current.Item.revision?.N || 0) !== revision)
        return { status: 409, data: { ok: false, error: { code: "REVISION_CONFLICT" } } };
      createdAt = current.Item.createdAt.S;
      legacyRevision = !current.Item.revision;
    }
    const agent = { id, name: name.trim(), modelId, systemPrompt,
      codeInterpreter, webSearch, browser, connectionIds, skillIds,
      ...(selectedThinkingLevel && { thinkingLevel: selectedThinkingLevel }),
      webSearchMaxResults, browserSessionSeconds, createdAt,
      revision: existingId ? revision + 1 : 0 };
    try {
      await db.send(new PutItemCommand({ TableName: process.env.TABLE,
        Item: { pk: S(projectKey(identity.sub, projectId)), sk: S(`AGENT#${id}`),
          id: S(id), name: S(agent.name), modelId: S(modelId),
          systemPrompt: S(systemPrompt), codeInterpreter: { BOOL: codeInterpreter },
          webSearch: { BOOL: webSearch }, browser: { BOOL: browser },
          connectionIds: { L: connectionIds.map(S) },
          skillIds: { L: skillIds.map(S) },
          ...(selectedThinkingLevel && { thinkingLevel: S(selectedThinkingLevel) }),
          createdAt: S(createdAt),
          webSearchMaxResults: N(webSearchMaxResults),
          browserSessionSeconds: N(browserSessionSeconds),
          revision: N(agent.revision) },
        ConditionExpression: existingId
          ? legacyRevision ? "attribute_not_exists(revision)" : "revision = :expected"
          : "attribute_not_exists(pk)",
        ...(existingId && !legacyRevision && { ExpressionAttributeValues: { ":expected": N(revision) } }),
      }));
    } catch (error) {
      if (error.name === "ConditionalCheckFailedException")
        return { status: 409, data: { ok: false, error: { code: "REVISION_CONFLICT" } } };
      throw error;
    }
    return { status: 200, data: { ok: true, data: agent } };
  }
  if (body.command === "usage.get") {
    if (body.input.requestId)
      return invoke({ v: 1, command: "usage.request", input: body.input }, identity);
    // Compose two independent, authorized reads inside one Runtime invocation.
    const [summary, detail, daily] = await Promise.all([
      invoke({ v: 1, command: "usage.summary", input: {
        userSub: body.input.userSub } }, identity),
      invoke({ v: 1, command: "usage.list", input: body.input }, identity),
      body.input.includeDaily ? invoke({ v: 1, command: "usage.daily", input: {
        range: body.input.range, scope: body.input.scope,
        userSub: body.input.userSub } }, identity) : null,
    ]);
    if (summary.status !== 200) return summary;
    if (detail.status !== 200) return detail;
    if (daily && daily.status !== 200) return daily;
    return { status: 200, data: { ok: true,
      data: { ...summary.data.data, ...detail.data.data,
        ...(daily && { daily: daily.data.data }) } } };
  }
  if (body.command === "usage.daily") {
    const { range = "30d", scope = "self", cursor } = body.input;
    const target = body.input.userSub || identity.sub;
    if (!["30d", "90d"].includes(range) || !["self", "all"].includes(scope) ||
      !/^[0-9a-f-]{36}$/i.test(target)) return invalid();
    if ((scope === "all" || target !== identity.sub) &&
      identity.role !== "Administrators")
      return { status: 403, data: { ok: false, error: { code: "FORBIDDEN" } } };
    const since = new Date(Date.now() - (range === "90d" ? 89 : 29) * 86400000)
      .toISOString().slice(0, 10);
    let start;
    if (cursor) {
      try {
        if (typeof cursor !== "string" || cursor.length > 4000) throw Error();
        const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
        if (decoded.range !== range || decoded.scope !== scope ||
          decoded.target !== target || decoded.since !== since) throw Error();
        start = decoded.key;
        if (!start?.sk?.S?.startsWith("DAY#") ||
          (scope === "self" && start.pk?.S !== `USER#${target}`) ||
          (scope === "all" && start.gsi1pk?.S !== "USAGE_DAYS")) throw Error();
      } catch { return invalid(); }
    }
    const page = await db.send(new QueryCommand({ TableName: process.env.TABLE,
      ...(scope === "all" && { IndexName: "UsageByTime" }),
      KeyConditionExpression: scope === "all"
        ? "gsi1pk = :pk AND gsi1sk BETWEEN :from AND :to"
        : "pk = :pk AND sk BETWEEN :from AND :to",
      ExpressionAttributeValues: {
        ":pk": S(scope === "all" ? "USAGE_DAYS" : `USER#${target}`),
        ":from": S(scope === "all" ? since : `DAY#${since}`),
        ":to": S(scope === "all" ? "￿" : "DAY#9999-12-31"),
      },
      ExclusiveStartKey: start, Limit: 100,
      ...(scope === "self" && { ConsistentRead: true }) }));
    return { status: 200, data: { ok: true, data: {
      items: (page.Items || []).map(unpack),
      nextCursor: page.LastEvaluatedKey
        ? Buffer.from(JSON.stringify({ key: page.LastEvaluatedKey,
          range, scope, target, since })).toString("base64url") : null } } };
  }
  if (body.command === "usage.request") {
    const target = body.input.userSub || identity.sub;
    const requestId = body.input.requestId;
    if (!/^[0-9a-f-]{36}$/i.test(target) ||
      !/^[0-9a-f-]{36}$/i.test(requestId || "")) return invalid();
    if (target !== identity.sub && identity.role !== "Administrators")
      return { status: 403, data: { ok: false, error: { code: "FORBIDDEN" } } };
    const row = await db.send(new GetItemCommand({ TableName: process.env.TABLE,
      Key: key(`USER#${target}`, `REQUEST#${requestId}`),
      ConsistentRead: true }));
    if (!row.Item) return missing();
    const { pendingCommitJson, meterKeys, ...request } = unpack(row.Item);
    const steps = await Promise.all((meterKeys || []).map(async (sk) => {
      const item = await db.send(new GetItemCommand({ TableName: process.env.TABLE,
        Key: key(`USER#${target}`, sk), ConsistentRead: true }));
      return item.Item ? unpack(item.Item) : null;
    }));
    return { status: 200, data: { ok: true, data: {
      request, steps: steps.filter(Boolean) } } };
  }
  if (body.command === "usage.reconcile") {
    const target = body.input.userSub || identity.sub;
    const requestId = body.input.requestId;
    if (!/^[0-9a-f-]{36}$/i.test(target) ||
      !/^[0-9a-f-]{36}$/i.test(requestId || "")) return invalid();
    if (target !== identity.sub && identity.role !== "Administrators")
      return { status: 403, data: { ok: false, error: { code: "FORBIDDEN" } } };
    const requestKey = key(`USER#${target}`, `REQUEST#${requestId}`);
    const row = await db.send(new GetItemCommand({ TableName: process.env.TABLE,
      Key: requestKey, ConsistentRead: true }));
    if (!row.Item) return missing();
    const state = unpack(row.Item);
    if (state.status === "completed")
      return { status: 200, data: { ok: true, data: {
        status: "completed", costMicroUsd: state.costMicroUsd } } };
    if (state.pendingCommitJson && state.eventId &&
      ["memory_written", "navigation_failed"].includes(state.status)) {
      const items = JSON.parse(state.pendingCommitJson);
      if (!Array.isArray(items) || items.length > 6 || items.some((item) => {
        const operation = item.Put || item.Update;
        const itemKey = operation?.Key || operation?.Item;
        return operation?.TableName !== process.env.TABLE ||
          !(itemKey?.pk?.S === `USER#${target}` ||
            itemKey?.pk?.S?.startsWith(`PROJECT#${target}/`));
      })) throw Error("Invalid prepared completion");
      const archived = items.find((item) =>
        item.Put?.Item?.sk?.S?.startsWith("ARCHIVE#"))?.Put.Item;
      if (archived) {
        try {
          const head = await s3.send(new HeadObjectCommand({
            Bucket: process.env.BUCKET, Key: archived.objectKey.S,
            ...(archived.versionId?.S && { VersionId: archived.versionId.S }) }));
          if (head.ContentLength !== Number(archived.sizeBytes.N))
            return { status: 409, data: { ok: false,
              error: { code: "ARCHIVE_MISMATCH" } } };
        } catch (error) {
          if (error.$metadata?.httpStatusCode === 404)
            return { status: 409, data: { ok: false,
              error: { code: "ARCHIVE_MISSING" } } };
          throw error;
        }
      }
      try {
        await db.send(new TransactWriteItemsCommand({
          ClientRequestToken: requestId, TransactItems: items }));
      } catch (error) {
        if (error.name !== "TransactionCanceledException") throw error;
        const latest = await db.send(new GetItemCommand({ TableName: process.env.TABLE,
          Key: requestKey, ConsistentRead: true }));
        if (latest.Item?.status?.S !== "completed")
          return { status: 409, data: { ok: false,
            error: { code: "RECONCILE_CONFLICT" } } };
      }
      return { status: 200, data: { ok: true, data: {
        status: "completed", costMicroUsd: state.costMicroUsd } } };
    }
    if (state.status === "running" &&
      Date.parse(state.acceptedAt) < Date.now() - 3600000) {
      await db.send(new UpdateItemCommand({ TableName: process.env.TABLE,
        Key: requestKey,
        UpdateExpression: "SET #status = :unknown, failureStage = :stage",
        ConditionExpression: "#status = :running AND acceptedAt < :cutoff",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":unknown": S("outcome_unknown"),
          ":stage": S("stale_request"), ":running": S("running"),
          ":cutoff": S(new Date(Date.now() - 3600000).toISOString()) } }))
        .catch((error) => {
          if (error.name !== "ConditionalCheckFailedException") throw error;
        });
      return { status: 200, data: { ok: true, data: {
        status: "outcome_unknown", costMicroUsd: state.costMicroUsd } } };
    }
    return { status: 200, data: { ok: true, data: {
      status: state.status, costMicroUsd: state.costMicroUsd,
      quality: "unresolved" } } };
  }
  if (body.command === "usage.summary") {
    const target = body.input.userSub || identity.sub;
    if (!/^[0-9a-f-]{36}$/i.test(target)) return invalid();
    if (target !== identity.sub && identity.role !== "Administrators")
      return { status: 403, data: { ok: false, error: { code: "FORBIDDEN" } } };
    const [limits, user] = await Promise.all([defaults(),
      db.send(new GetItemCommand({ TableName: process.env.TABLE,
        Key: key(`USER#${target}`, "CONTROL"), ConsistentRead: true }))]);
    const effective = effectiveLimits(user.Item, limits);
    const period = periodKey(effective.period, new Date(), effective.budgetEpoch);
    const row = await db.send(new GetItemCommand({ TableName: process.env.TABLE,
      Key: key(`USER#${target}`, period), ConsistentRead: true }));
    return { status: 200, data: { ok: true, data: { period, userSub: target,
      budgetMicroUsd: effective.budgetMicroUsd,
      costMicroUsd: Number(row.Item?.costMicroUsd?.N || 0),
      unpricedToolCalls: Number(row.Item?.unpricedToolCalls?.N || 0),
      quality: Number(row.Item?.unpricedToolCalls?.N || 0) ? "partial" :
        Number(row.Item?.estimatedModelCalls?.N || 0) ? "estimated" : "model-only" } } };
  }
  if (body.command === "usage.list") {
    const { range = "30d", sort = "desc", scope = "self", cursor,
      projectId: usageProjectId, agentId, requestId, tool, kind, quality,
      status, from, to } = body.input;
    const target = body.input.userSub || identity.sub;
    if ((usageProjectId !== undefined && !projectPattern.test(usageProjectId)) ||
      !["30d", "90d"].includes(range) || !["asc", "desc"].includes(sort) ||
      !["self", "all"].includes(scope) || (scope === "all" && identity.role !== "Administrators") ||
      (agentId !== undefined && !uuidPattern.test(agentId)) ||
      (requestId !== undefined && !uuidPattern.test(requestId)) ||
      (tool !== undefined && (!/^[a-z_]{1,80}$/.test(tool))) ||
      (kind !== undefined && !["model", "tool"].includes(kind)) ||
      (quality !== undefined && !["estimated", "unpriced", "unknown"].includes(quality)) ||
      (status !== undefined && !["running", "completed", "memory_failed",
        "navigation_failed", "outcome_unknown"].includes(status)) ||
      ((from === undefined) !== (to === undefined)) ||
      (from !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(from) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(to))))
      return { status: 400, data: { ok: false, error: { code: "VALIDATION_FAILED" } } };
    if (target !== identity.sub && identity.role !== "Administrators")
      return { status: 403, data: { ok: false, error: { code: "FORBIDDEN" } } };
    if (!/^[0-9a-f-]{36}$/i.test(target))
      return { status: 400, data: { ok: false, error: { code: "VALIDATION_FAILED" } } };
    const filterKey = createHash("sha256").update(JSON.stringify({
      range, sort, scope, target, usageProjectId, agentId, requestId,
      tool, kind, quality, status, from, to })).digest("hex").slice(0, 20);
    if (from && (!Number.isFinite(Date.parse(from + "T00:00:00.000Z")) ||
      !Number.isFinite(Date.parse(to + "T23:59:59.999Z")))) return invalid();
    let since = from ? new Date(from + "T00:00:00.000Z").toISOString() :
      new Date(Date.now() - (range === "90d" ? 90 : 30) * 86400000).toISOString();
    let until = to ? new Date(to + "T23:59:59.999Z").toISOString() :
      new Date().toISOString();
    if (!Number.isFinite(Date.parse(since)) || !Number.isFinite(Date.parse(until)) ||
      Date.parse(until) < Date.parse(since) ||
      Date.parse(until) - Date.parse(since) > 91 * 86400000 ||
      Date.parse(until) > Date.now() + 86400000) return invalid();
    let start;
    if (cursor) {
      try {
        if (typeof cursor !== "string" || cursor.length > 4000) throw Error();
        const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
        if (decoded.filterKey !== filterKey ||
          typeof decoded.since !== "string" || typeof decoded.until !== "string" ||
          !Number.isFinite(Date.parse(decoded.since)) ||
          !Number.isFinite(Date.parse(decoded.until)) ||
          Date.parse(decoded.until) < Date.parse(decoded.since) ||
          Date.parse(decoded.until) - Date.parse(decoded.since) > 91 * 86400000)
          throw Error();
        ({ since, until } = decoded);
        start = decoded.key;
        if (!/^USER#[0-9a-f-]{36}$/i.test(start.pk?.S || "") ||
          (scope === "self" && start.pk.S !== `USER#${target}`) ||
          !start.sk?.S?.startsWith("USAGE#") ||
          (scope === "all" && start.gsi1pk?.S !== "USAGE")) throw Error();
      } catch {
        return { status: 400, data: { ok: false, error: { code: "VALIDATION_FAILED" } } };
      }
    }
    const filters = [];
    const values = {
      ":pk": S(scope === "all" ? "USAGE" : `USER#${target}`),
      ":from": S(`${scope === "all" ? "" : "USAGE#"}${since}`),
      ":to": S(`${scope === "all" ? "" : "USAGE#"}${until}~`),
    };
    const names = {};
    if (usageProjectId) {
      values[":project"] = S(usageProjectId);
      filters.push(usageProjectId === "main"
        ? "(projectId = :project OR attribute_not_exists(projectId))"
        : "projectId = :project");
    }
    for (const [field, value] of Object.entries({
      agentId, requestId, kind, quality })) if (value !== undefined) {
      names[`#${field}`] = field;
      values[`:${field}`] = S(value);
      filters.push(`#${field} = :${field}`);
    }
    if (tool !== undefined) {
      names["#name"] = "name";
      values[":tool"] = S(tool);
      filters.push("#name = :tool");
    }
    if (scope === "all" && body.input.userSub) {
      values[":user"] = S(target);
      filters.push("userSub = :user");
    }
    const page = await db.send(new QueryCommand({ TableName: process.env.TABLE,
      ...(scope === "all" && { IndexName: "UsageByTime" }),
      KeyConditionExpression: scope === "all"
        ? "gsi1pk = :pk AND gsi1sk BETWEEN :from AND :to"
        : "pk = :pk AND sk BETWEEN :from AND :to",
      ExpressionAttributeValues: values,
      ExclusiveStartKey: start, Limit: 50, ScanIndexForward: sort === "asc",
      ...(filters.length && { FilterExpression: filters.join(" AND "),
        ...(Object.keys(names).length && { ExpressionAttributeNames: names }) }),
      ...(scope === "self" && { ConsistentRead: true }) }));
    let items = (page.Items || []).map(unpack).map((item) => ({
      ...item, projectId: item.projectId || "main" }));
    if (status !== undefined) {
      const states = await Promise.all(items.map((item) => db.send(
        new GetItemCommand({ TableName: process.env.TABLE,
          Key: key(`USER#${item.userSub}`, `REQUEST#${item.requestId}`),
          ConsistentRead: true }))));
      items = items.map((item, index) => ({
        ...item, requestStatus: states[index].Item?.status?.S || "unknown" }))
        .filter((item) => item.requestStatus === status);
    }
    return { status: 200, data: { ok: true, data: { range, sort, scope,
      items,
      nextCursor: page.LastEvaluatedKey
        ? Buffer.from(JSON.stringify({ key: page.LastEvaluatedKey,
          filterKey, since, until })).toString("base64url") : null } } };
  }
  if (body.command === "models.list") {
    return { status: 200, data: { ok: true, data: { items: modelCatalog() } } };
  }
  const admin = identity.role === "Administrators";
  if (["users.list", "users.invite", "users.setLimits", "users.setRole",
    "users.setEnabled", "users.startNewBudgetPeriod", "defaults.get",
    "defaults.set"].includes(body.command) && !admin)
    return { status: 403, data: { ok: false, error: { code: "FORBIDDEN" } } };
  if (body.command === "users.list") {
    if (body.input.cursor !== undefined && (typeof body.input.cursor !== "string" ||
      body.input.cursor.length > 4096)) return invalid();
    const page = await idp.send(new ListUsersCommand({ UserPoolId: process.env.POOL,
      Limit: 20, PaginationToken: body.input.cursor || undefined }));
    const [limits, ownerSub] = await Promise.all([
      defaults(), protectedAdministrator(identity.sub) ]);
    const items = await Promise.all(page.Users.map(async (user) => {
      const sub = user.Attributes?.find((attribute) => attribute.Name === "sub")?.Value;
      const [row, groups] = await Promise.all([
        db.send(new GetItemCommand({ TableName: process.env.TABLE,
          Key: key(`USER#${sub}`, "CONTROL") })),
        idp.send(new AdminListGroupsForUserCommand({ UserPoolId: process.env.POOL,
          Username: sub, Limit: 10 })),
      ]);
      return { sub, email: user.Attributes?.find((attribute) => attribute.Name === "email")?.Value,
        enabled: user.Enabled, status: user.UserStatus,
        role: (groups.Groups || []).map((group) => group.GroupName)[0] || null,
        protected: sub === ownerSub,
        ...effectiveLimits(row.Item, limits),
        budgetInherited: row.Item?.limitsVersion?.N === "2"
          ? row.Item.budgetOverrideMicroUsd?.N === undefined
          : row.Item?.budgetMicroUsd?.N === undefined ||
            Number(row.Item.budgetMicroUsd.N) === limits.baselineBudgetMicroUsd,
        storageInherited: row.Item?.limitsVersion?.N === "2"
          ? row.Item.storageOverrideBytes?.N === undefined
          : row.Item?.storageBytes?.N === undefined ||
            Number(row.Item.storageBytes.N) === limits.baselineStorageBytes,
        periodInherited: !row.Item?.periodOverride?.S,
        storageUsedBytes: Number(row.Item?.storageUsedBytes?.N || 0) };
    }));
    return { status: 200, data: { ok: true, data: {
      items, cursor: page.PaginationToken || null, defaults: limits } } };
  }
  if (body.command === "users.invite") {
    const { email, role } = body.input;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || "") ||
      !["Members", "Auditors", "Administrators"].includes(role))
      return { status: 400, data: { ok: false, error: { code: "VALIDATION_FAILED" } } };
    await idp.send(new AdminCreateUserCommand({ UserPoolId: process.env.POOL,
      Username: email, UserAttributes: [
        { Name: "email", Value: email }, { Name: "email_verified", Value: "true" },
      ] }));
    await idp.send(new AdminAddUserToGroupCommand({ UserPoolId: process.env.POOL,
      Username: email, GroupName: role }));
    return { status: 200, data: { ok: true, data: { invited: true } } };
  }
  if (body.command === "users.setLimits") {
    const { sub, budgetMicroUsd, storageBytes, period = null } = body.input;
    if (!/^[0-9a-f-]{36}$/i.test(sub || "") ||
      (budgetMicroUsd !== null && (!Number.isSafeInteger(budgetMicroUsd) || budgetMicroUsd < 0)) ||
      (storageBytes !== null && (!Number.isSafeInteger(storageBytes) || storageBytes < 0)) ||
      (period !== null && !["daily", "weekly", "monthly"].includes(period)))
      return { status: 400, data: { ok: false, error: { code: "VALIDATION_FAILED" } } };
    await idp.send(new AdminGetUserCommand({ UserPoolId: process.env.POOL, Username: sub }));
    const limits = await defaults();
    await db.send(new UpdateItemCommand({ TableName: process.env.TABLE,
      Key: key(`USER#${sub}`, "CONTROL"),
      UpdateExpression: "SET limitsVersion = :version, budgetOverrideMicroUsd = :budgetOverride, storageOverrideBytes = :storageOverride, budgetMicroUsd = :budget, storageBytes = :storage, periodOverride = :period",
      ExpressionAttributeValues: { ":version": N(2),
        ":budgetOverride": budgetMicroUsd === null ? { NULL: true } : N(budgetMicroUsd),
        ":storageOverride": storageBytes === null ? { NULL: true } : N(storageBytes),
        ":budget": N(budgetMicroUsd ?? limits.budgetMicroUsd),
        ":storage": N(storageBytes ?? limits.storageBytes),
        ":period": period === null ? { NULL: true } : S(period) } }));
    return { status: 200, data: { ok: true, data: { updated: true } } };
  }
  if (body.command === "users.startNewBudgetPeriod") {
    const { sub } = body.input;
    if (!/^[0-9a-f-]{36}$/i.test(sub || "")) return invalid();
    await idp.send(new AdminGetUserCommand({ UserPoolId: process.env.POOL, Username: sub }));
    const row = await db.send(new UpdateItemCommand({ TableName: process.env.TABLE,
      Key: key(`USER#${sub}`, "CONTROL"),
      UpdateExpression: "ADD budgetEpoch :one",
      ExpressionAttributeValues: { ":one": N(1) }, ReturnValues: "ALL_NEW" }));
    return { status: 200, data: { ok: true,
      data: { budgetEpoch: Number(row.Attributes.budgetEpoch.N) } } };
  }
  if (["users.setRole", "users.setEnabled"].includes(body.command)) {
    const { sub } = body.input;
    if (!/^[0-9a-f-]{36}$/i.test(sub || "")) return invalid();
    if (sub === await protectedAdministrator(identity.sub))
      return { status: 403, data: { ok: false, error: { code: "PROTECTED_ADMIN" } } };
    await idp.send(new AdminGetUserCommand({ UserPoolId: process.env.POOL, Username: sub }));
    if (body.command === "users.setEnabled") {
      if (typeof body.input.enabled !== "boolean") return invalid();
      await idp.send(new (body.input.enabled
        ? AdminEnableUserCommand : AdminDisableUserCommand)({
        UserPoolId: process.env.POOL, Username: sub }));
      return { status: 200, data: { ok: true,
        data: { enabled: body.input.enabled } } };
    }
    const role = body.input.role;
    if (!["Administrators", "Members", "Auditors"].includes(role)) return invalid();
    const groups = await idp.send(new AdminListGroupsForUserCommand({
      UserPoolId: process.env.POOL, Username: sub, Limit: 10 }));
    const old = (groups.Groups || []).map((group) => group.GroupName);
    if (old.length !== 1 || !["Administrators", "Members", "Auditors"].includes(old[0]))
      return { status: 409, data: { ok: false, error: { code: "ROLE_CONFLICT" } } };
    if (old[0] !== role) {
      await idp.send(new AdminAddUserToGroupCommand({
        UserPoolId: process.env.POOL, Username: sub, GroupName: role }));
      try {
        await idp.send(new AdminRemoveUserFromGroupCommand({
          UserPoolId: process.env.POOL, Username: sub, GroupName: old[0] }));
      } catch (error) {
        await idp.send(new AdminRemoveUserFromGroupCommand({
          UserPoolId: process.env.POOL, Username: sub, GroupName: role }))
          .catch(() => console.error("Role update needs administrator repair"));
        throw error;
      }
    }
    return { status: 200, data: { ok: true, data: { role } } };
  }
  if (body.command === "defaults.get")
    return { status: 200, data: { ok: true, data: await defaults() } };
  if (body.command === "defaults.set") {
    const { budgetMicroUsd, storageBytes, period, revision } = body.input;
    if (!Number.isSafeInteger(budgetMicroUsd) || budgetMicroUsd < 0 ||
      !Number.isSafeInteger(storageBytes) || storageBytes < 0 ||
      !["daily", "weekly", "monthly"].includes(period) ||
      !Number.isSafeInteger(revision))
      return { status: 400, data: { ok: false, error: { code: "VALIDATION_FAILED" } } };
    const row = await db.send(new UpdateItemCommand({ TableName: process.env.TABLE,
      Key: key("ACCOUNT#CONTROL", "DEFAULTS"),
      UpdateExpression: "SET budgetMicroUsd = :budget, storageBytes = :storage, #period = :period, revision = revision + :one",
      ConditionExpression: "revision = :revision", ExpressionAttributeNames: { "#period": "period" },
      ExpressionAttributeValues: { ":budget": N(budgetMicroUsd), ":storage": N(storageBytes),
        ":period": S(period), ":revision": N(revision), ":one": N(1) }, ReturnValues: "ALL_NEW" }));
    return { status: 200, data: { ok: true, data: unpack(row.Attributes) } };
  }
  if (body.command !== "session.get" || Object.keys(body.input).length)
    return { status: 501, data: { ok: false, error: { code: "NOT_IMPLEMENTED" } } };
  return { status: 200, data: { ok: true, data: await getSession(identity) } };
}

async function runGemini(config, model, level, messages, emit, workloadToken, tools, meter) {
  if (!workloadToken) throw Error("Missing runtime workload token");
  const { apiKey } = await memory.send(new GetResourceApiKeyCommand({
    resourceCredentialProviderName: process.env.GEMINI_PROVIDER,
    workloadIdentityToken: workloadToken,
  }));
  const contents = messages.map(({ role, content }) => ({
    role: role === "assistant" ? "model" : "user",
    parts: content.map(({ text }) => ({ text })),
  }));
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0,
    cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };
  let text = "";
  for (let turn = 0; turn < 8; turn++) {
    const body = geminiRequest(model, level, contents, toolInstructions(config), tools.specs);
    const reply = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.modelId)}:streamGenerateContent?alt=sse`,
      { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body), signal: AbortSignal.timeout(120000) },
    );
    if (!reply.ok) throw Error(`Gemini HTTP ${reply.status}`);
    const step = await readGeminiStream(reply.body, emit);
    await meter.model(turn, step.usage);
    for (const name of Object.keys(usage)) usage[name] += step.usage[name];
    text += step.visibleText;
    const calls = geminiStepCalls(step);
    if (calls.length) {
      contents.push({ role: "model", parts: step.parts });
      const results = [];
      for (const call of calls) {
        const result = await tools.execute(call.name, call.args || {});
        results.push(geminiFunctionResult(call, result.content, result.isError));
      }
      contents.push({ role: "user", parts: results });
      continue;
    }
    if (step.finishReason === "MAX_TOKENS") {
      const notice = text ? "\n\n[Response truncated at the model output limit.]" :
        "The model reached its output limit before producing a visible reply.";
      emit({ type: "message.delta", text: notice });
      text += notice;
    }
    if (!text) throw Error("Gemini returned no visible response");
    const citations = tools.citations();
    if (citations) emit({ type: "message.delta", text: citations });
    return { text: text + citations, usage, toolCalls: tools.toolCalls };
  }
  throw Error("Agent turn limit reached");
}

async function interpreterCall(sessionId, name, args) {
  const response = await memory.send(new InvokeCodeInterpreterCommand({
    codeInterpreterIdentifier: process.env.CODE_INTERPRETER_ID, sessionId,
    name, arguments: args,
  }));
  let output = "";
  let isError = false;
  for await (const event of response.stream) {
    if (!event.result) continue;
    const structured = event.result.structuredContent;
    const content = (event.result.content || []).filter((part) => part.type === "text")
      .map((part) => part.text).join("\n");
    output = (output + (structured?.stdout || "") + (structured?.stderr || "") +
      (structured?.stdout || structured?.stderr ? "" : content)).slice(0, 8000);
    isError ||= event.result.isError === true;
  }
  return { output, isError };
}

const shellQuote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

async function initializeWorkspace(sessionId, scope) {
  const saved = scope.connectionIds?.length ? (await credentials({ sub: scope.sub })).items : {};
  const granted = (scope.connectionIds || []).map((id) => saved[id]);
  if (granted.some((item) => !item)) throw Error("Connection revoked");
  const secretsForSession = {};
  for (const item of granted) {
    if (item.kind === "github") secretsForSession.GITHUB_TOKEN = item.apiKey;
    if (item.kind === "jira") {
      secretsForSession.JIRA_API_TOKEN = item.apiKey;
      secretsForSession.JIRA_URL = item.jiraUrl;
      secretsForSession.JIRA_EMAIL = item.jiraEmail;
    }
  }
  const fileManifest = await Promise.all((scope.files || []).map(async (item) => ({
    id: item.id, name: item.name, sizeBytes: item.sizeBytes,
    url: await getSignedUrl(s3, new GetObjectCommand({
      Bucket: process.env.BUCKET, Key: item.key,
      ...(item.versionId && { VersionId: item.versionId }),
    }), { expiresIn: 900 }),
  })));
  const variables = {
    AGENTCORE_USER_ID: scope.sub,
    AGENTCORE_PROJECT_ID: scope.projectId,
    AGENTCORE_AGENT_ID: scope.agentId,
    AGENTCORE_CHAT_ID: scope.sessionId,
    AWS_REGION: process.env.AWS_REGION,
    AWS_DEFAULT_REGION: process.env.AWS_REGION,
  };
  // Base64 is serialization, not encryption. Only this granted session gets
  // the file; wrappers decode values before generated code runs.
  for (const [name, value] of Object.entries(secretsForSession))
    variables[`${name}_B64`] = Buffer.from(value, "utf8").toString("base64");
  const contents = Object.entries(variables).map(([name, value]) => {
    if (!/^[A-Za-z0-9._:/+=-]+$/.test(value || "")) throw Error("Invalid workspace context");
    return `${name}=${value}`;
  }).join("\n") + "\n";
  const written = await interpreterCall(sessionId, "writeFiles", {
    content: [{ path: ".env", text: contents },
      ...(fileManifest.length ? [{ path: "selected-files.json",
        text: JSON.stringify(fileManifest) }] : []),
      ...(scope.skills || []).map((skill) => ({ path: `skill-${skill.id}.md`,
        text: skill.text }))],
  });
  if (written.isError) throw Error("Could not initialize code workspace");
  const cwd = await interpreterCall(sessionId, "executeCommand", { command: "pwd" });
  const path = cwd.output.trim().split(/\r?\n/)[0];
  if (cwd.isError || !/^\/[A-Za-z0-9._/-]+$/.test(path))
    throw Error("Could not locate code workspace");
  return { path: `${path}/.env`, names: Object.keys(secretsForSession),
    values: [...Object.values(secretsForSession), ...fileManifest.map((item) => item.url),
      JSON.stringify(fileManifest)] };
}

const gatewaySigner = new SignatureV4({
  credentials: defaultProvider(), region: process.env.AWS_REGION,
  service: "bedrock-agentcore", sha256: Hash.bind(null, "sha256"),
});

async function searchWeb(query, maxResults) {
  const endpoint = new URL("/mcp", process.env.GATEWAY_URL);
  const body = JSON.stringify({ jsonrpc: "2.0", id: uuid(),
    method: "tools/call", params: { name: "Search___WebSearch",
      arguments: { query, maxResults } } });
  const signed = await gatewaySigner.sign({
    method: "POST", protocol: endpoint.protocol, hostname: endpoint.hostname,
    path: endpoint.pathname, headers: { host: endpoint.hostname,
      "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-03-26" }, body,
  });
  const response = await fetch(endpoint, { method: "POST", headers: signed.headers,
    body, signal: AbortSignal.timeout(30000) });
  const raw = await response.text();
  if (!response.ok) throw Error(`Web Search gateway returned ${response.status}`);
  const payload = raw.startsWith("data:")
    ? JSON.parse(raw.split("\n").find((line) => line.startsWith("data:")).slice(5))
    : JSON.parse(raw);
  if (payload.error || payload.result?.isError)
    throw Error("Web Search was unavailable");
  const result = payload.result || payload;
  const text = result.content?.find((item) => item.type === "text")?.text;
  const results = result.structuredContent?.results || (text ? JSON.parse(text).results : []);
  if (!Array.isArray(results)) throw Error("Unexpected Web Search result");
  const visible = [];
  let length = 2;
  for (const item of results) {
    const size = JSON.stringify(item).length + 1;
    if (length + size > 12000) break;
    visible.push(item);
    length += size;
  }
  const sources = visible.flatMap(({ title, url }) => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" ? [{ title: String(title || parsed.hostname)
        .replace(/[\r\n]/g, " ").slice(0, 120),
        url: parsed.href }] : [];
    } catch { return []; }
  });
  return { text: JSON.stringify(visible), sources };
}

const browserId = "aws.browser.v1";
async function browserSend(command) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await memory.send(command);
    } catch (error) {
      if (error.name !== "ConflictException" || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
}
async function browserAction(sessionId, input) {
  const { action } = input;
  const invoke = async (operation) => {
    const result = (await browserSend(new InvokeBrowserCommand({
      browserIdentifier: browserId, sessionId, action: operation,
    }))).result;
    const part = Object.values(result || {})[0];
    if (part?.status !== "SUCCESS") throw Error("Browser action failed");
    return part;
  };
  if (action === "navigate") {
    const url = new URL(input.url);
    if (url.protocol !== "https:" || url.username || url.password ||
      url.port || url.href.length > 2000 ||
      isIP(url.hostname.replace(/^\[|\]$/g, "")) ||
      /(^localhost$|\.localhost$|\.local$)/i.test(url.hostname))
      throw Error("Browser requires a public HTTPS URL");
    await invoke({ keyShortcut: { keys: ["ctrl", "l"] } });
    await invoke({ keyType: { text: url.href } });
    await invoke({ keyPress: { key: "enter" } });
  } else if (action === "click") {
    if (!Number.isInteger(input.x) || input.x < 2 || input.x > 997 ||
      !Number.isInteger(input.y) || input.y < 2 || input.y > 697)
      throw Error("Invalid browser coordinates");
    await invoke({ mouseClick: { x: input.x, y: input.y } });
  } else if (action === "type") {
    if (typeof input.text !== "string" || !input.text || input.text.length > 2000)
      throw Error("Invalid browser text");
    await invoke({ keyType: { text: input.text } });
  } else if (action === "scroll") {
    if (!Number.isInteger(input.deltaY) || Math.abs(input.deltaY) > 1000)
      throw Error("Invalid browser scroll");
    await invoke({ mouseScroll: { x: 500, y: 350, deltaY: input.deltaY } });
  } else if (action !== "screenshot") throw Error("Invalid browser action");
  if (action !== "screenshot") await new Promise((resolve) => setTimeout(resolve, 500));
  const screenshot = await invoke({ screenshot: { format: "PNG" } });
  if (!screenshot.data || screenshot.data.length > 3500000)
    throw Error("Browser screenshot unavailable or too large");
  return [{ text: `Browser ${action} complete. Inspect the screenshot before the next action.` },
    { image: { format: "png", source: { bytes: screenshot.data } } }];
}

function toolSpecs(config) {
  const specs = [];
  if (config.codeInterpreter) specs.push(
    {
      name: "execute_code",
      description: "Run Python, JavaScript, or TypeScript in an isolated public-network workspace. Session .env is loaded automatically.",
      inputSchema: { json: { type: "object", properties: {
        language: { type: "string", enum: ["python", "javascript", "typescript"] },
        code: { type: "string" },
      }, required: ["language", "code"] } },
    },
    {
      name: "execute_command",
      description: "Run a shell command in that workspace, with session .env loaded. Python, Node, curl, AWS CLI, pip and npm are installed; install other tools only when needed. Commands are capped at 120 seconds.",
      inputSchema: { json: { type: "object", properties: {
        command: { type: "string" },
      }, required: ["command"] } },
    },
  );
  if (config.webSearch) specs.push({
    name: "web_search",
    description: "Search the current public web. Cite source URLs in your answer. Queries are limited to 200 characters.",
    inputSchema: { json: { type: "object", properties: {
      query: { type: "string" },
    }, required: ["query"] } },
  });
  if (config.browser) specs.push({
    name: "browser",
    description: "Use an isolated public browser. Each action returns a screenshot to inspect. Navigate only to a public HTTPS URL; click uses screenshot coordinates. No authenticated browser profile is loaded.",
    inputSchema: { json: { type: "object", properties: {
      action: { type: "string", enum: ["navigate", "click", "type", "scroll", "screenshot"] },
      url: { type: "string" }, x: { type: "integer" }, y: { type: "integer" },
      text: { type: "string" }, deltaY: { type: "integer" },
    }, required: ["action"] } },
  });
  return specs;
}

function toolInstructions(config) {
  return [
    config.systemPrompt,
    ...(config.skills || []).map((skill) =>
      `Selected skill ${skill.name} (${skill.id}):\n${skill.text}`),
    "Use only the tools provided in this request. If a requested capability is unavailable, say so; do not invent tool results.",
    config.codeInterpreter ? "Use the code workspace to inspect, run and revise work. Selected skill files are in skill-<id>.md. When this turn has selected user files, selected-files.json lists their names and short-lived read-only download URLs; fetch only what you need and never print URLs. Prefer installed Python requests/boto3 and native HTTPS APIs before installing packages. Granted GitHub/Jira connections, if any, appear as GITHUB_TOKEN or JIRA_API_TOKEN/JIRA_URL/JIRA_EMAIL environment variables. Do not print session secrets; code with granted credentials can read and transmit them." : "",
    config.webSearch ? "Web Search returns current results. Base factual claims on the returned sources and cite their URLs." : "",
    config.browser ? "Browser actions return screenshots. Inspect each screenshot and avoid entering private credentials." : "",
  ].filter(Boolean).join("\n\n");
}

function toolSession(config, emit, scope, meter) {
  const specs = toolSpecs(config);
  const toolCalls = [];
  const sources = new Map();
  let codeSession;
  let browserSession;
  let envPath;
  let envNames = [];
  let envValues = [];
  const execute = async (name, input) => {
    if (toolCalls.length >= 8) throw Error("Agent tool call limit reached");
    const isCode = name === "execute_code" &&
      ["python", "javascript", "typescript"].includes(input?.language) &&
      typeof input.code === "string" && input.code.length <= 20000;
    const isCommand = name === "execute_command" &&
      typeof input?.command === "string" && input.command.length <= 20000;
    const isSearch = name === "web_search" && config.webSearch &&
      typeof input?.query === "string" && input.query.trim().length > 0 &&
      input.query.length <= 200;
    const isBrowser = name === "browser" && config.browser &&
      ["navigate", "click", "type", "scroll", "screenshot"].includes(input?.action);
    if (!(isCode && config.codeInterpreter) && !(isCommand && config.codeInterpreter) &&
      !isSearch && !isBrowser)
      throw Error("Invalid tool request");
    if ((isCode || isCommand) && !codeSession) {
      if (!process.env.CODE_INTERPRETER_ID) throw Error("Code workspace unavailable");
      codeSession = (await memory.send(new StartCodeInterpreterSessionCommand({
        codeInterpreterIdentifier: process.env.CODE_INTERPRETER_ID,
        name: `chat-${uuid().slice(0, 8)}`, sessionTimeoutSeconds: 900,
      }))).sessionId;
      const workspace = await initializeWorkspace(codeSession, scope);
      envPath = workspace.path;
      envNames = workspace.names;
      envValues = workspace.values;
    }
    const started = Date.now();
    let content;
    let isError = false;
    if (isSearch || isBrowser) {
      try {
        if (isSearch) {
          const result = await searchWeb(input.query.trim(), config.webSearchMaxResults || 5);
          for (const { url, title } of result.sources) sources.set(url, title);
          content = [{ text: result.text }];
        } else {
          if (!browserSession) browserSession = (await browserSend(
            new StartBrowserSessionCommand({ browserIdentifier: browserId,
              name: `chat-${uuid().slice(0, 8)}`, clientToken: uuid(),
              sessionTimeoutSeconds: config.browserSessionSeconds || 300,
              viewPort: { width: 1000, height: 700 } }))).sessionId;
          content = await browserAction(browserSession, input);
        }
      } catch (error) {
        console.error("Managed tool failed", name, error.name,
          error.$metadata?.httpStatusCode || "");
        isError = true;
        content = [{ text: `${isSearch ? "Web Search" : "Browser"} could not complete that action.` }];
      }
    } else {
      const pythonEnv = envNames.length ? `import os, base64
for _name in ${JSON.stringify(envNames)}:
    os.environ[_name] = base64.b64decode(os.environ.pop(_name + "_B64")).decode("utf-8")
` : "";
      const nodeEnv = envNames.length ? `for (const name of ${JSON.stringify(envNames)}) {
  process.env[name] = Buffer.from(process.env[name + "_B64"], "base64").toString("utf8");
  delete process.env[name + "_B64"];
}
` : "";
      const shellEnv = envNames.map((name) =>
        `export ${name}="$(printf '%s' "$${name}_B64" | base64 -d)"; unset ${name}_B64; `).join("");
      const args = isCode ? {
        language: input.language,
        runtime: input.language === "python" ? "python" : "nodejs",
        code: input.language === "python"
          ? `from dotenv import load_dotenv\nload_dotenv(${JSON.stringify(envPath)}, override=True)\n${pythonEnv}${input.code}`
          : `process.loadEnvFile(${JSON.stringify(envPath)});\n${nodeEnv}${input.code}`,
      } : { command: `set -a; . ${shellQuote(envPath)}; set +a; ${shellEnv}timeout 120s sh -lc ${shellQuote(input.command)}` };
      const result = await interpreterCall(codeSession,
        isCode ? "executeCode" : "executeCommand", args);
      isError = result.isError;
      const safeOutput = envValues.reduce((text, value) =>
        text.replaceAll(value, "[redacted]")
          .replaceAll(Buffer.from(value, "utf8").toString("base64"), "[redacted]"),
      result.output || "(no output)");
      content = [{ text: safeOutput }];
    }
    const tool = { name, latencyMs: Date.now() - started,
      occurredAt: new Date().toISOString(), isError };
    await meter.tool(toolCalls.length, tool);
    toolCalls.push(tool);
    emit({ type: "tool.done", name, isError });
    return { content, isError };
  };
  const citations = () => sources.size ? "\n\nSources:\n" + [...sources]
    .map(([url, title]) => `- ${title}: ${url}`).join("\n") : "";
  const close = async () => {
    if (browserSession) await browserSend(new StopBrowserSessionCommand({
      browserIdentifier: browserId, sessionId: browserSession,
    })).catch(() => console.error("Could not stop Browser session"));
    if (codeSession) await memory.send(new StopCodeInterpreterSessionCommand({
      codeInterpreterIdentifier: process.env.CODE_INTERPRETER_ID, sessionId: codeSession,
    })).catch(() => console.error("Could not stop Code Interpreter session"));
  };
  return { specs, toolCalls, execute, citations, close };
}

async function runModel(config, model, messages, emit, workloadToken, scope, meter) {
  const level = model.thinkingLevels.includes(config.thinkingLevel)
    ? config.thinkingLevel : model.defaultThinkingLevel;
  const tools = toolSession(config, emit, scope, meter);
  if (model.transport === "gemini") {
    try {
      return await runGemini(config, model, level, messages, emit, workloadToken, tools, meter);
    } finally {
      await tools.close();
    }
  }
  const toolConfig = tools.specs.length
    ? { tools: tools.specs.map((toolSpec) => ({ toolSpec })) } : undefined;
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0,
    cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };
  try {
    for (let turn = 0; turn < 8; turn++) {
      const stream = config.modelId === "test.echo"
        ? scriptedStream(messages)
        : (await bedrock.send(new ConverseStreamCommand({
            modelId: config.modelId, messages,
            system: config.systemPrompt || toolConfig
              ? [{ text: toolInstructions(config) }] : undefined,
            inferenceConfig: { maxTokens: model.maxOutputTokens }, toolConfig,
            ...(model.company === "Anthropic" && { additionalModelRequestFields: {
              thinking: { type: "adaptive" }, output_config: { effort: level },
            } }),
            ...(model.company === "OpenAI" && { additionalModelRequestFields: {
              reasoning: { effort: level },
            } }),
          }))).stream;
      const content = [];
      let stopReason;
      let metered = false;
      const stepUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0,
        cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };
      for await (const event of stream) {
        if (event.contentBlockStart?.start?.toolUse) {
          const { contentBlockIndex, start } = event.contentBlockStart;
          content[contentBlockIndex] = { toolUse: { ...start.toolUse, input: "" } };
        }
        if (event.contentBlockDelta) {
          const { contentBlockIndex, delta } = event.contentBlockDelta;
          if (delta.reasoningContent) {
            const block = content[contentBlockIndex] ||= {
              reasoningContent: { reasoningText: { text: "" } },
            };
            const reasoning = delta.reasoningContent;
            if (reasoning.redactedContent)
              block.reasoningContent = { redactedContent: reasoning.redactedContent };
            else {
              const prior = block.reasoningContent.reasoningText;
              if (reasoning.text) prior.text += reasoning.text;
              if (reasoning.signature) prior.signature = reasoning.signature;
            }
          }
          if (delta.text) {
            content[contentBlockIndex] ||= { text: "" };
            content[contentBlockIndex].text += delta.text;
            emit({ type: "message.delta", text: delta.text });
          }
          if (delta.toolUse) content[contentBlockIndex].toolUse.input += delta.toolUse.input || "";
        }
        if (event.contentBlockStop) {
          const part = content[event.contentBlockStop.contentBlockIndex];
          if (part?.toolUse) part.toolUse.input = JSON.parse(part.toolUse.input);
        }
        if (event.messageStop) stopReason = event.messageStop.stopReason;
        if (event.metadata?.usage) {
          metered = true;
          for (const name of Object.keys(usage))
            stepUsage[name] += event.metadata.usage[name] || 0;
        }
      }
      if (!metered) throw Error("Model did not report token usage");
      await meter.model(turn, stepUsage);
      for (const name of Object.keys(usage)) usage[name] += stepUsage[name];
      if (stopReason === "end_turn") {
        const citations = tools.citations();
        if (citations) emit({ type: "message.delta", text: citations });
        return { text: content.map((part) => part?.text || "").join("") + citations,
          usage, toolCalls: tools.toolCalls };
      }
      if (stopReason !== "tool_use" || !toolConfig) throw Error("Unsupported model stop reason");
      const requested = content.filter((part) => part?.toolUse).map((part) => part.toolUse);
      if (!requested.length) throw Error("Tool turn had no tool requests");
      messages.push({ role: "assistant", content });
      const results = [];
      for (const tool of requested) {
        const result = await tools.execute(tool.name, tool.input);
        results.push({ toolResult: { toolUseId: tool.toolUseId,
          content: result.content, status: result.isError ? "error" : "success" } });
      }
      messages.push({ role: "user", content: results });
    }
    throw Error("Agent turn limit reached");
  } finally {
    await tools.close();
  }
}

function rejectChat(response, code) {
  const messages = {
    CONNECTION_REVOKED: "A granted connection was removed. Edit this agent before sending again.",
    SKILL_UNAVAILABLE: "A selected skill was removed. Edit this agent before sending again.",
    STORAGE_EXHAUSTED: "Your storage limit is reached. Delete files or ask an administrator to raise it before starting another persistent turn.",
    HISTORY_INCOMPLETE: "This conversation's saved history is incomplete. Do not continue it until it is repaired.",
    BUDGET_EXHAUSTED: "Your current budget is exhausted.",
    MODEL_UNAVAILABLE: "This agent's model is unavailable.",
    TOOL_UNAVAILABLE: "This model cannot use the agent's enabled tools.",
    AGENT_ARCHIVED: "This agent is archived. Restore it to send another message.",
    REQUEST_ALREADY_COMPLETED: "This request was already accepted. Reopen the conversation or inspect usage before retrying.",
    FORBIDDEN: "This account cannot send messages.",
    NOT_FOUND: "This agent was not found.",
    FILE_UNAVAILABLE: "A selected file was removed or is outside this project. Choose files again.",
    VALIDATION_FAILED: "The message request is invalid.",
    BRANCH_CONFLICT: "This conversation path changed. Reopen it before sending again.",
  };
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  response.end(`data: ${JSON.stringify({ type: "error", code,
    message: messages[code] || "Chat could not start." })}\n\n`);
}

async function chat(input, identity, response, workloadToken) {
  const { agentId, sessionId, requestId, message, modelId, thinkingLevel,
    fileIds = [] } = input;
  const projectId = projectIdOf(input);
  const branchId = input.branchId ?? "main";
  const forking = Object.hasOwn(input, "forkEventId");
  const forkEventId = input.forkEventId;
  const sourceBranchId = input.sourceBranchId ?? "main";
  const idPattern = /^[0-9a-f-]{36}$/i;
  if (!projectPattern.test(projectId) || !branchPattern.test(branchId) ||
    (forking ? !branchPattern.test(sourceBranchId) :
      input.sourceBranchId !== undefined) ||
    (forking && (branchId === "main" ||
      (forkEventId !== null && !eventPattern.test(forkEventId || "")))) ||
    (input.expectedHeadEventId !== undefined && input.expectedHeadEventId !== null &&
      !eventPattern.test(input.expectedHeadEventId)) ||
    !idPattern.test(agentId || "") ||
    !idPattern.test(sessionId || "") || !idPattern.test(requestId || "") ||
    !Array.isArray(fileIds) || fileIds.length > 4 ||
    fileIds.some((id) => !idPattern.test(id || "")) ||
    new Set(fileIds).size !== fileIds.length ||
    typeof message !== "string" || !message.trim() || message.length > 20000 ||
    (modelId !== undefined && (typeof modelId !== "string" || modelId.length > 512)) ||
    (thinkingLevel !== undefined && typeof thinkingLevel !== "string"))
    return rejectChat(response, "VALIDATION_FAILED");
  if (identity.role === "Auditors")
    return rejectChat(response, "FORBIDDEN");
  if (!await project(identity, projectId))
    return rejectChat(response, "NOT_FOUND");
  const [row, defaultsRow, prior, user, conversationRow, branchRow,
    sourceBranchRow] = await Promise.all([
    db.send(new GetItemCommand({ TableName: process.env.TABLE,
      Key: key(projectKey(identity.sub, projectId), `AGENT#${agentId}`), ConsistentRead: true })),
    defaults(),
    db.send(new GetItemCommand({ TableName: process.env.TABLE,
      Key: key(`USER#${identity.sub}`, `REQUEST#${requestId}`), ConsistentRead: true })),
    db.send(new GetItemCommand({ TableName: process.env.TABLE,
      Key: key(`USER#${identity.sub}`, "CONTROL"), ConsistentRead: true })),
    db.send(new GetItemCommand({ TableName: process.env.TABLE,
      Key: key(projectKey(identity.sub, projectId), `CONVERSATION#${sessionId}`),
      ConsistentRead: true })),
    branchId === "main" ? Promise.resolve({}) : db.send(new GetItemCommand({
      TableName: process.env.TABLE,
      Key: branchKey(identity.sub, projectId, sessionId, branchId),
      ConsistentRead: true })),
    !forking || sourceBranchId === "main" ? Promise.resolve({}) :
      db.send(new GetItemCommand({ TableName: process.env.TABLE,
        Key: branchKey(identity.sub, projectId, sessionId, sourceBranchId),
        ConsistentRead: true })),
  ]);
  if (!row.Item)
    return rejectChat(response, "NOT_FOUND");
  const config = unpack(row.Item);
  if (config.archived) return rejectChat(response, "AGENT_ARCHIVED");
  if (prior.Item)
    return rejectChat(response, "REQUEST_ALREADY_COMPLETED");
  const durable = !conversationRow.Item || conversationRow.Item.durable?.BOOL === true;
  if (conversationRow.Item && (conversationRow.Item.agentId?.S !== agentId ||
    conversationRow.Item.status?.S === "DELETING" ||
    (!durable && Number(conversationRow.Item.expiresAt?.N || 0) <= Date.now() / 1000)))
    return rejectChat(response, "NOT_FOUND");
  if (forking ? branchRow.Item || !conversationRow.Item ||
      (sourceBranchId !== "main" && !sourceBranchRow.Item) ||
      (forkEventId === null && branchId === "main")
    : branchId !== "main" && !branchRow.Item)
    return rejectChat(response, "BRANCH_CONFLICT");
  const currentLimits = effectiveLimits(user.Item, defaultsRow);
  if (durable && Number(user.Item?.storageUsedBytes?.N || 0) >= currentLimits.storageBytes)
    return rejectChat(response, "STORAGE_EXHAUSTED");
  const period = periodKey(currentLimits.period, new Date(), currentLimits.budgetEpoch);
  const turnModelId = modelId ?? config.modelId;
  const [model, spent] = await Promise.all([
    approvedModel(turnModelId),
    db.send(new GetItemCommand({ TableName: process.env.TABLE,
      Key: key(`USER#${identity.sub}`, period), ConsistentRead: true })),
  ]);
  if (!model)
    return rejectChat(response, "MODEL_UNAVAILABLE");
  const savedLevel = turnModelId === config.modelId &&
    model.thinkingLevels.includes(config.thinkingLevel)
    ? config.thinkingLevel : model.defaultThinkingLevel;
  const turnThinkingLevel = thinkingLevel ?? savedLevel;
  if (model.thinkingLevels.length
    ? !model.thinkingLevels.includes(turnThinkingLevel)
    : thinkingLevel !== undefined)
    return rejectChat(response, "VALIDATION_FAILED");
  if (config.browser && !model.browserTool)
    return rejectChat(response, "TOOL_UNAVAILABLE");
  if (config.connectionIds?.length) {
    const current = (await credentials(identity)).items;
    if (config.connectionIds.some((id) => !current[id]))
      return rejectChat(response, "CONNECTION_REVOKED");
  }
  if (fileIds.length && !config.codeInterpreter)
    return rejectChat(response, "TOOL_UNAVAILABLE");
  const files = [];
  for (const id of fileIds) {
    const row = await db.send(new GetItemCommand({ TableName: process.env.TABLE,
      Key: objectKey(identity.sub, id), ConsistentRead: true }));
    const item = row.Item && unpack(row.Item);
    if (!item || item.status !== "ACTIVE" || item.projectId !== projectId ||
      !["file", "artifact"].includes(item.kind))
      return rejectChat(response, "FILE_UNAVAILABLE");
    files.push({ id, name: item.name, sizeBytes: item.sizeBytes,
      key: item.key, versionId: item.versionId });
  }
  const limit = currentLimits.budgetMicroUsd;
  if (Number(spent.Item?.costMicroUsd?.N || 0) >= limit)
    return rejectChat(response, "BUDGET_EXHAUSTED");
  let skills;
  try {
    skills = await selectedSkills(identity, projectId, config.skillIds || []);
  } catch (error) {
    if (error.message === "Selected skill was removed")
      return rejectChat(response, "SKILL_UNAVAILABLE");
    throw error;
  }
  const turnConfig = { ...config, modelId: turnModelId,
    thinkingLevel: turnThinkingLevel, skills };
  const actorId = `${identity.sub}/${projectId}`;
  const mainMemorySessionId = conversationRow.Item?.mainMemorySessionId?.S ||
    `a_${agentId}_${sessionId}`;
  // Memory requires a rootEventId for native branches. Editing the first turn
  // therefore starts one independent session; its later descendants can use
  // native branches inside that session without copying any message bodies.
  const sourceMemorySessionId = sourceBranchRow.Item?.memorySessionId?.S ||
    mainMemorySessionId;
  let memorySessionId = forking
    ? forkEventId === null ? `a_${agentId}_b_${branchId}` :
      sourceMemorySessionId
    : branchRow.Item?.memorySessionId?.S || mainMemorySessionId;
  let nativeBranchId = forking && forkEventId === null ||
    !forking && branchRow.Item?.memoryRoot?.BOOL ? "main" : branchId;
  let rootEvent;
  if (forking && forkEventId) {
    try {
      rootEvent = (await memory.send(new GetEventCommand({
        memoryId: process.env.MEMORY, actorId,
        sessionId: sourceMemorySessionId,
        eventId: forkEventId }))).event;
    } catch (error) {
      if (error.name === "ResourceNotFoundException" && durable) {
        memorySessionId = `a_${agentId}_r_${uuid()}`;
        nativeBranchId = "main";
      } else if (error.name === "ResourceNotFoundException")
        return rejectChat(response, "BRANCH_CONFLICT");
      else throw error;
    }
  }
  let history;
  if (durable) {
    const head = forking ? forkEventId :
      branchId === "main" ? conversationRow.Item?.mainHeadEventId?.S :
        branchRow.Item?.headEventId?.S;
    history = head ? await archivePath(identity, projectId, sessionId, head, 20) :
      { events: [], incomplete: false };
    if (history.incomplete) return rejectChat(response, "HISTORY_INCOMPLETE");
  } else if (forking && rootEvent) {
    const sourceBranch = sourceBranchId === "main"
      ? rootEvent.branch?.name || "main"
      : sourceBranchRow.Item?.memoryRoot?.BOOL ? "main" : sourceBranchId;
    let cursor;
    const events = [];
    do {
      const page = await branchEvents(actorId, sourceMemorySessionId,
        sourceBranch, cursor);
      events.push(...page.events);
      cursor = page.nextToken;
    } while (cursor && !events.some((event) => event.eventId === forkEventId));
    const rootIndex = events.findIndex((event) => event.eventId === forkEventId);
    if (rootIndex < 0) return rejectChat(response, "BRANCH_CONFLICT");
    history = { events: events.slice(rootIndex, rootIndex + 20) };
  } else if (forking) history = { events: [] };
  else history = await branchEvents(actorId, memorySessionId,
    nativeBranchId, undefined, 20);
  const observedHead = branchId === "main"
    ? conversationRow.Item?.mainHeadEventId?.S || history.events[0]?.eventId || null
    : branchRow.Item?.headEventId?.S || null;
  if (!forking && input.expectedHeadEventId !== undefined &&
    input.expectedHeadEventId !== observedHead)
    return rejectChat(response, "BRANCH_CONFLICT");
  // ListEvents returns newest first. Only recent context goes to the model;
  // AgentCore Memory retains the full session independently of that window.
  const messages = (history.events || []).toReversed().flatMap((event) =>
    (event.payload || []).flatMap((payload) => {
      const entry = payload.conversational;
      return entry?.content?.text && ["USER", "ASSISTANT"].includes(entry.role)
        ? [{ role: entry.role.toLowerCase(), content: [{ text: entry.content.text }] }]
        : [];
    }));
  messages.push({ role: "user", content: [{ text: message }] });
  const acceptedAt = new Date().toISOString();
  const requestKey = key(`USER#${identity.sub}`, `REQUEST#${requestId}`);
  try {
    await db.send(new PutItemCommand({ TableName: process.env.TABLE,
      Item: { ...requestKey, status: S("running"), acceptedAt: S(acceptedAt),
        userSub: S(identity.sub), projectId: S(projectId), agentId: S(agentId),
        conversationId: S(sessionId), branchId: S(branchId), modelId: S(turnModelId),
        durable: { BOOL: durable },
        period: S(period), costMicroUsd: N(0), modelSteps: N(0), toolSteps: N(0),
        meterKeys: { L: [] },
        },
      ConditionExpression: "attribute_not_exists(pk)" }));
  } catch (error) {
    if (error.name === "ConditionalCheckFailedException")
      return rejectChat(response, "REQUEST_ALREADY_COMPLETED");
    throw error;
  }
  let meteredCost = 0;
  const meter = {
    model: async (step, usage) => {
      const occurredAt = new Date().toISOString();
      const cost = modelCost(usage, model);
      const eventKey = `USAGE#${occurredAt}#${requestId}#MODEL#${step}`;
      await db.send(new TransactWriteItemsCommand({ ClientRequestToken: uuid(),
        TransactItems: [
          { Put: { TableName: process.env.TABLE,
            Item: { ...key(`USER#${identity.sub}`, eventKey),
              gsi1pk: S("USAGE"), gsi1sk: S(`${occurredAt}#${identity.sub}#${requestId}#MODEL#${step}`),
              occurredAt: S(occurredAt), userSub: S(identity.sub), requestId: S(requestId),
              projectId: S(projectId), branchId: S(branchId), agentId: S(agentId),
              modelId: S(turnModelId), step: N(step), kind: S("model"),
              costMicroUsd: N(cost), inputTokens: N(usage.inputTokens),
              outputTokens: N(usage.outputTokens),
              cacheReadInputTokens: N(usage.cacheReadInputTokens || 0),
              cacheWriteInputTokens: N(usage.cacheWriteInputTokens || 0),
              inputRate: N(model.inputRate || 0), outputRate: N(model.outputRate || 0),
              cacheReadRate: N(model.cacheReadRate || 0),
              cacheWriteRate: N(model.cacheWriteRate || 0),
              pricingSource: S(model.pricingSource || ""),
              pricingQuality: S(model.pricingQuality || "unknown"),
              quality: S("estimated") },
            ConditionExpression: "attribute_not_exists(pk)" } },
          { Update: { TableName: process.env.TABLE,
            Key: key(`USER#${identity.sub}`, period),
            UpdateExpression: "ADD costMicroUsd :cost, estimatedModelCalls :one",
            ExpressionAttributeValues: { ":cost": N(cost), ":one": N(1) } } },
          { Update: { TableName: process.env.TABLE,
            Key: key(`USER#${identity.sub}`, `DAY#${occurredAt.slice(0, 10)}`),
            UpdateExpression: "ADD costMicroUsd :cost, estimatedModelCalls :one SET gsi1pk = :index, gsi1sk = :sort, userSub = :user, #day = :day",
            ExpressionAttributeNames: { "#day": "day" },
            ExpressionAttributeValues: { ":cost": N(cost), ":one": N(1),
              ":index": S("USAGE_DAYS"),
              ":sort": S(`${occurredAt.slice(0, 10)}#${identity.sub}`),
              ":user": S(identity.sub), ":day": S(occurredAt.slice(0, 10)) } } },
          { Update: { TableName: process.env.TABLE, Key: requestKey,
            UpdateExpression: "ADD costMicroUsd :cost, modelSteps :one SET lastMeteredAt = :time, meterKeys = list_append(if_not_exists(meterKeys, :empty), :keys)",
            ConditionExpression: "#status = :running",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: { ":cost": N(cost), ":one": N(1),
              ":time": S(occurredAt), ":running": S("running"),
              ":empty": { L: [] }, ":keys": { L: [S(eventKey)] } } } },
        ] }));
      meteredCost += cost;
    },
    tool: async (step, tool) => {
      const occurredAt = tool.occurredAt;
      await db.send(new TransactWriteItemsCommand({ ClientRequestToken: uuid(),
        TransactItems: [
          { Put: { TableName: process.env.TABLE,
            Item: { ...key(`USER#${identity.sub}`,
              `USAGE#${occurredAt}#${requestId}#TOOL#${step}`),
              gsi1pk: S("USAGE"), gsi1sk: S(`${occurredAt}#${identity.sub}#${requestId}#TOOL#${step}`),
              occurredAt: S(occurredAt), userSub: S(identity.sub), requestId: S(requestId),
              projectId: S(projectId), branchId: S(branchId), agentId: S(agentId),
              kind: S("tool"), name: S(tool.name), costMicroUsd: N(0),
              latencyMs: N(tool.latencyMs), isError: { BOOL: tool.isError },
              quality: S("unpriced") },
            ConditionExpression: "attribute_not_exists(pk)" } },
          { Update: { TableName: process.env.TABLE,
            Key: key(`USER#${identity.sub}`, period),
            UpdateExpression: "ADD unpricedToolCalls :one",
            ExpressionAttributeValues: { ":one": N(1) } } },
          { Update: { TableName: process.env.TABLE,
            Key: key(`USER#${identity.sub}`, `DAY#${occurredAt.slice(0, 10)}`),
            UpdateExpression: "ADD unpricedToolCalls :one SET gsi1pk = :index, gsi1sk = :sort, userSub = :user, #day = :day",
            ExpressionAttributeNames: { "#day": "day" },
            ExpressionAttributeValues: { ":one": N(1),
              ":index": S("USAGE_DAYS"),
              ":sort": S(`${occurredAt.slice(0, 10)}#${identity.sub}`),
              ":user": S(identity.sub), ":day": S(occurredAt.slice(0, 10)) } } },
          { Update: { TableName: process.env.TABLE, Key: requestKey,
            UpdateExpression: "ADD toolSteps :one SET lastMeteredAt = :time, meterKeys = list_append(if_not_exists(meterKeys, :empty), :keys)",
            ConditionExpression: "#status = :running",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: { ":one": N(1), ":time": S(occurredAt),
              ":running": S("running"), ":empty": { L: [] },
              ":keys": { L: [S(`USAGE#${occurredAt}#${requestId}#TOOL#${step}`)] } } } },
        ] }));
    },
  };
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  const emit = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
  const started = Date.now();
  try {
    const result = await runModel(turnConfig, model, messages, emit, workloadToken,
      { sub: identity.sub, projectId, agentId, sessionId,
        connectionIds: config.connectionIds || [], skills, files }, meter);
    const costMicroUsd = meteredCost;
    const occurredAt = new Date().toISOString();
    const receipt = { version: 1, requestId, projectId, branchId,
      agentId, conversationId: sessionId,
      modelId: turnModelId, occurredAt, usage: result.usage, costMicroUsd,
      rates: { inputRate: model.inputRate || 0, outputRate: model.outputRate || 0,
        cacheReadRate: model.cacheReadRate || 0, cacheWriteRate: model.cacheWriteRate || 0 },
      pricingQuality: model.pricingQuality || "unknown",
      toolCalls: result.toolCalls.map(({ name, occurredAt, latencyMs, isError }) =>
        ({ name, occurredAt, latencyMs, isError })) };
    const saveMemory = () => memory.send(new CreateEventCommand({
      memoryId: process.env.MEMORY, actorId, sessionId: memorySessionId,
      eventTimestamp: new Date(), clientToken: requestId, extractionMode: "SKIP",
      ...(nativeBranchId !== "main" && { branch: { name: nativeBranchId,
        ...(forking && { rootEventId: forkEventId }) } }),
      payload: [
        { conversational: { role: "USER", content: { text: message } } },
        { conversational: { role: "ASSISTANT", content: { text: result.text } } },
        { json: { content: receipt } },
      ] }));
    let savedEvent;
    try {
      savedEvent = await saveMemory();
    } catch (error) {
      if (!durable || error.name !== "ResourceNotFoundException") {
        error.stage = "memory";
        throw error;
      }
      // An archive can outlive its Memory branch. Link this turn through its
      // archived parent and begin a fresh ephemeral Memory session.
      memorySessionId = `a_${agentId}_r_${uuid()}`;
      nativeBranchId = "main";
      savedEvent = await saveMemory()
        .catch((retryError) => { retryError.stage = "memory"; throw retryError; });
    }
    await db.send(new UpdateItemCommand({ TableName: process.env.TABLE,
      Key: requestKey,
      UpdateExpression: "SET #status = :written, eventId = :event, memorySessionId = :session",
      ConditionExpression: "#status = :running",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":written": S("memory_written"),
        ":running": S("running"), ":event": S(savedEvent.event.eventId),
        ":session": S(memorySessionId) } }))
      .catch((error) => { error.stage = "navigation"; throw error; });
    let archive;
    if (durable) {
      const objectKey = archiveObjectKey(identity.sub, projectId, sessionId, requestId);
      const data = Buffer.from(JSON.stringify({ message, answer: result.text, receipt }));
      const saved = await s3.send(new PutObjectCommand({
        Bucket: process.env.BUCKET, Key: objectKey, Body: data,
        ContentType: "application/json", ServerSideEncryption: "AES256" }))
        .catch((error) => { error.stage = "archive"; throw error; });
      archive = { objectKey, versionId: saved.VersionId, sizeBytes: data.length };
    }
    try {
      const completion = [
      { Update: { TableName: process.env.TABLE, Key: requestKey,
        UpdateExpression: "SET #status = :complete, completedAt = :time" +
          (archive ? ", archiveObjectKey = :archiveKey, archiveBytes = :archiveBytes" : "") +
          " REMOVE pendingCommitJson",
        ConditionExpression: "#status IN (:written, :failed)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":complete": S("completed"),
          ":written": S("memory_written"), ":failed": S("navigation_failed"),
          ":time": S(occurredAt),
          ...(archive && { ":archiveKey": S(archive.objectKey),
            ":archiveBytes": N(archive.sizeBytes) }) } } },
      ...(archive ? [
        { Put: { TableName: process.env.TABLE,
          Item: { ...archiveKey(identity.sub, projectId, sessionId,
            savedEvent.event.eventId),
            eventId: S(savedEvent.event.eventId), requestId: S(requestId),
            branchId: S(branchId),
            parentEventId: (forking ? forkEventId : observedHead)
              ? S(forking ? forkEventId : observedHead) : { NULL: true },
            objectKey: S(archive.objectKey),
            memorySessionId: S(memorySessionId),
            ...(archive.versionId && { versionId: S(archive.versionId) }),
            sizeBytes: N(archive.sizeBytes), createdAt: S(occurredAt) },
          ConditionExpression: "attribute_not_exists(pk)" } },
        { Update: { TableName: process.env.TABLE,
          Key: key(`USER#${identity.sub}`, "CONTROL"),
          UpdateExpression: "ADD storageUsedBytes :bytes",
          ExpressionAttributeValues: { ":bytes": N(archive.sizeBytes) } } },
      ] : []),
      { Update: { TableName: process.env.TABLE,
        Key: key(projectKey(identity.sub, projectId), `CONVERSATION#${sessionId}`),
        UpdateExpression: "SET id = :id, agentId = :agent, title = if_not_exists(title, :title), createdAt = if_not_exists(createdAt, :time), lastActivityAt = :time, gsi1pk = :index, gsi1sk = :sort, activeBranchId = :branch, durable = :durable, #status = :active" +
          (durable ? "" : ", expiresAt = :expiry") +
          (branchId === "main"
            ? ", mainHeadEventId = :head, mainMemorySessionId = :memorySession" : "") +
          " ADD memorySessions :sessions",
        ConditionExpression: "(attribute_not_exists(#status) OR #status = :active) AND " + (branchId === "main"
          ? `(attribute_not_exists(agentId) OR agentId = :agent) AND ${conversationRow.Item?.mainHeadEventId
            ? "mainHeadEventId = :previous" : "attribute_not_exists(mainHeadEventId)"}`
          : "agentId = :agent"),
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":id": S(sessionId), ":agent": S(agentId), ":active": S("ACTIVE"),
          ":sessions": { SS: [memorySessionId] },
          ":branch": S(branchId), ":durable": { BOOL: durable },
          ...(branchId === "main" && { ":head": S(savedEvent.event.eventId),
            ":memorySession": S(memorySessionId),
            ...(conversationRow.Item?.mainHeadEventId && { ":previous": S(observedHead) }) }),
          ":title": S(message.trim().replace(/\s+/g, " ").slice(0, 80)),
          ":time": S(occurredAt), ":index": S(`CONVERSATIONS#${identity.sub}/${projectId}`),
          ":sort": S(`${occurredAt}#${sessionId}`),
          ...(!durable && { ":expiry": N(Math.floor(Date.now() / 1000) + 30 * 86400) }),
      } } },
      ...(branchId === "main" ? [] : forking ? [{ Put: { TableName: process.env.TABLE,
        Item: { ...branchKey(identity.sub, projectId, sessionId, branchId),
          id: S(branchId), name: S(`Alternative ${new Date().toISOString().slice(11, 19)}`),
          rootEventId: forkEventId ? S(forkEventId) : { NULL: true },
          ...(memorySessionId !== mainMemorySessionId && {
            memorySessionId: S(memorySessionId) }),
          ...(nativeBranchId === "main" && { memoryRoot: { BOOL: true } }),
          headEventId: S(savedEvent.event.eventId), createdAt: S(occurredAt) },
        ConditionExpression: "attribute_not_exists(pk)" } }] : [{ Update: {
        TableName: process.env.TABLE,
        Key: branchKey(identity.sub, projectId, sessionId, branchId),
        UpdateExpression: "SET headEventId = :head, memorySessionId = :session, memoryRoot = :root",
        ConditionExpression: "headEventId = :previous",
        ExpressionAttributeValues: { ":head": S(savedEvent.event.eventId),
          ":previous": S(observedHead), ":session": S(memorySessionId),
          ":root": { BOOL: nativeBranchId === "main" } } } }]),
      ];
      await db.send(new UpdateItemCommand({ TableName: process.env.TABLE,
        Key: requestKey,
        UpdateExpression: "SET pendingCommitJson = :commit",
        ConditionExpression: "#status = :written",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":written": S("memory_written"),
          ":commit": S(JSON.stringify(completion)) } }));
      await db.send(new TransactWriteItemsCommand({
        ClientRequestToken: requestId, TransactItems: completion }));
    } catch (error) {
      error.stage = "navigation";
      if (error.name === "TransactionCanceledException") {
        if (archive) await s3.send(new DeleteObjectCommand({
          Bucket: process.env.BUCKET, Key: archive.objectKey,
          ...(archive.versionId && { VersionId: archive.versionId }) }))
          .catch(() => console.error("Could not remove uncommitted turn archive"));
        await memory.send(new DeleteEventCommand({ memoryId: process.env.MEMORY,
          actorId, sessionId: memorySessionId, eventId: savedEvent.event.eventId }))
          .catch(() => console.error("Could not remove uncommitted Memory event"));
        error.message = "Branch head changed";
      }
      throw error;
    }
    emit({ type: "message.done", requestId, conversationId: sessionId,
      branchId, eventId: savedEvent.event.eventId,
      usage: result.usage, costMicroUsd,
      unpricedToolCalls: result.toolCalls.length, latencyMs: Date.now() - started });
  } catch (error) {
    await db.send(new UpdateItemCommand({ TableName: process.env.TABLE,
      Key: requestKey,
      UpdateExpression: "SET #status = :failed, failureStage = :stage, failedAt = :time",
      ConditionExpression: "#status <> :complete",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":failed": S(error.stage === "memory"
        ? "memory_failed" : error.stage === "navigation"
          ? "navigation_failed" : "outcome_unknown"),
        ":stage": S(error.stage || "provider_or_tool"),
        ":time": S(new Date().toISOString()), ":complete": S("completed") } }))
      .catch(() => console.error("Could not mark failed request"));
    console.error("Chat failed", error.name, error.$metadata?.httpStatusCode || "",
      /^(Gemini |Inconsistent Gemini|Invalid Gemini|Incomplete Gemini|Agent turn limit)/
        .test(error.message || "") ? error.message : "");
    const message = error.name === "AccessDeniedException"
      ? "Model access denied. An AWS administrator may need to enable its Marketplace agreement or Runtime role."
      : error.name === "ThrottlingException"
        ? "The model is busy. Please try again."
        : error.message === "Gemini stopped: MALFORMED_FUNCTION_CALL"
          ? "The model could not form a valid tool call."
          : error.message === "Invalid tool request"
            ? "The model requested an unavailable tool."
            : error.message === "Branch head changed"
              ? "This conversation path changed. Reopen it before sending again."
            : "Agent turn failed";
    emit({ type: "error", message,
      ...(process.env.SCRIPTED_MODEL === "true" && {
        diagnostic: error.name, stage: error.stage,
        detail: error.message?.slice(0, 300) }) });
  } finally {
    response.end();
  }
}

const respond = (response, status, data) => {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(data));
};

createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/ping")
    return respond(response, 200, { status: "Healthy" });
  if (request.method !== "POST" || request.url !== "/invocations")
    return respond(response, 404, { ok: false });
  let identity;
  try {
    identity = caller(request.headers.authorization);
  } catch {
    /* malformed token */
  }
  if (!identity)
    return respond(response, 403, {
      ok: false,
      error: { code: "UNAUTHENTICATED" },
    });
  try {
    if (!await currentIdentity(identity))
      return respond(response, 200, { ok: false,
        error: { code: "SESSION_CHANGED", message: "Sign in again to refresh your access." } });
    if (identity.role === "Administrators")
      await protectedAdministrator(identity.sub);
    let raw = "";
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 65536)
        return respond(response, 413, {
          ok: false,
          error: { code: "TOO_LARGE" },
        });
      raw += chunk;
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return respond(response, 400, {
        ok: false,
        error: { code: "VALIDATION_FAILED" },
      });
    }
    if (body?.v === 1 && body.command === "chat.send")
      return await chat(body.input || {}, identity, response,
        request.headers.workloadaccesstoken);
    const result = await invoke(body, identity);
    // AgentCore masks non-2xx Runtime responses as generic 424 errors.
    // Application failures use a stable JSON envelope over HTTP 200.
    respond(response, 200, result.data);
  } catch (error) {
    console.error("Control failed", error.name, error.$metadata?.httpStatusCode || "");
    respond(response, 200, {
      ok: false,
      error: { code: "INTERNAL", message: "Operation failed",
        ...(process.env.SCRIPTED_MODEL === "true" && {
          diagnostic: error.name, detail: error.message?.slice(0, 300) }) },
    });
  }
}).listen(Number(process.env.PORT || 8080), "0.0.0.0");
