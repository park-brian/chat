// One AgentCore Runtime owns product control and the configured agent loop.
// AgentCore validates the Cognito JWT before forwarding its Authorization header.
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import {
  S3Client,
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { periodKey } from "./accounting.js";
import suggestedModels from "./models.json" with { type: "json" };
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  DynamoDBClient,
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  BedrockAgentCoreClient,
  DeleteEventCommand,
  ListEventsCommand,
} from "@aws-sdk/client-bedrock-agentcore";

import { createCredentials } from "./credentials.js";
import { createConnections } from "./connections.js";
import { createUsers } from "./users.js";
import { createRuns } from "./runs.js";
import { createChat } from "./chat.js";

const scriptedModel = {
  id: "test.echo",
  name: "Scripted echo (test only)",
  transport: "scripted",
  contextTokens: 1000000,
  maxOutputTokens: 128000,
  thinkingLevels: [],
  browserTool: true,
  active: true,
};
const idp = new CognitoIdentityProviderClient({});
const db = new DynamoDBClient({});
const memory = new BedrockAgentCoreClient({});
const bedrock = new BedrockRuntimeClient({});
const s3 = new S3Client({});
// V2 may restore workers from one snapshot, including random state. Mix fresh
// clock time with uncached entropy so separate sessions cannot reuse a key.
const uuid = () => {
  const hex = createHash("sha256")
    .update(
      `${randomUUID({ disableEntropyCache: true })}:${Date.now()}:${process.hrtime.bigint()}`,
    )
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
      value.S ??
        (value.N !== undefined
          ? Number(value.N)
          : value.BOOL !== undefined
            ? value.BOOL
            : value.L?.map((part) => part.S)),
    ]),
  );

const credentialStore = createCredentials({
  db,
  table: process.env.TABLE,
  uuid,
});

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
      idp.send(
        new AdminGetUserCommand({
          UserPoolId: process.env.POOL,
          Username: identity.sub,
        }),
      ),
      idp.send(
        new AdminListGroupsForUserCommand({
          UserPoolId: process.env.POOL,
          Username: identity.sub,
          Limit: 10,
        }),
      ),
    ]);
    const names = (groups.Groups || []).map((group) => group.GroupName);
    return user.Enabled && names.length === 1 && names[0] === identity.role;
  } catch (error) {
    if (error.name === "UserNotFoundException") return false;
    throw error;
  }
}

async function protectedAdministrator(sub) {
  const existing = await db.send(
    new GetItemCommand({
      TableName: process.env.TABLE,
      Key: key("ACCOUNT#CONTROL", "OWNER"),
      ConsistentRead: true,
    }),
  );
  if (existing.Item?.ownerSub?.S) return existing.Item.ownerSub.S;
  const configured = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  let owner = sub;
  if (configured) {
    const users = await idp.send(
      new ListUsersCommand({
        UserPoolId: process.env.POOL,
        Filter: `email = "${configured.replaceAll('"', "")}"`,
        Limit: 10,
      }),
    );
    owner = users.Users?.find((user) =>
      user.Attributes?.some(
        (attribute) =>
          attribute.Name === "email" &&
          attribute.Value?.toLowerCase() === configured,
      ),
    )?.Attributes?.find((attribute) => attribute.Name === "sub")?.Value;
    if (!owner) return null;
  }
  const row = await db.send(
    new UpdateItemCommand({
      TableName: process.env.TABLE,
      Key: key("ACCOUNT#CONTROL", "OWNER"),
      UpdateExpression: "SET ownerSub = if_not_exists(ownerSub, :sub)",
      ExpressionAttributeValues: { ":sub": S(owner) },
      ReturnValues: "ALL_NEW",
    }),
  );
  return row.Attributes.ownerSub.S;
}

async function defaults() {
  const existing = await db.send(
    new GetItemCommand({
      TableName: process.env.TABLE,
      Key: key("ACCOUNT#CONTROL", "DEFAULTS"),
      ConsistentRead: true,
    }),
  );
  if (
    existing.Item?.baselineBudgetMicroUsd &&
    existing.Item?.baselineStorageBytes
  )
    return unpack(existing.Item);
  const initialBudget = Number(
    existing.Item?.budgetMicroUsd?.N ?? process.env.BUDGET,
  );
  const initialStorage = Number(
    existing.Item?.storageBytes?.N ?? process.env.STORAGE,
  );
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
const projectMetaKey = (sub, projectId) =>
  key(`USER#${sub}`, `PROJECT#${projectId}`);
const invalid = () => ({
  status: 400,
  data: { ok: false, error: { code: "VALIDATION_FAILED" } },
});
const missing = () => ({
  status: 404,
  data: { ok: false, error: { code: "NOT_FOUND" } },
});
const mainProject = { id: "main", name: "Main project", hidden: false };
const projectPublic = ({ id, name, hidden, revision, createdAt }) => ({
  id,
  name,
  hidden,
  ...(revision !== undefined && { revision }),
  ...(createdAt && { createdAt }),
});
const objectKey = (sub, id) => key(`USER#${sub}`, `OBJECT#${id}`);
const objectPublic = ({
  id,
  projectId,
  name,
  kind,
  contentType,
  sizeBytes,
  createdAt,
  status,
}) => ({
  id,
  projectId,
  name,
  kind,
  contentType,
  sizeBytes,
  createdAt,
  status,
});
const uploadKey = (sub, id) => `pending/${sub}/${id}`;
const savedKey = (sub, projectId, id) => `users/${sub}/${projectId}/${id}`;

async function storageState(identity) {
  const [limits, row] = await Promise.all([
    defaults(),
    db.send(
      new GetItemCommand({
        TableName: process.env.TABLE,
        Key: key(`USER#${identity.sub}`, "CONTROL"),
        ConsistentRead: true,
      }),
    ),
  ]);
  return {
    limitBytes: effectiveLimits(row.Item, limits).storageBytes,
    usedBytes: Number(row.Item?.storageUsedBytes?.N || 0),
  };
}

async function selectedSkills(identity, projectId, ids) {
  if (!ids?.length) return [];
  const rows = await Promise.all(
    ids.map((id) =>
      db.send(
        new GetItemCommand({
          TableName: process.env.TABLE,
          Key: objectKey(identity.sub, id),
          ConsistentRead: true,
        }),
      ),
    ),
  );
  if (
    rows.some(
      (row) =>
        row.Item?.projectId?.S !== projectId ||
        row.Item?.kind?.S !== "skill" ||
        row.Item?.status?.S !== "ACTIVE" ||
        Number(row.Item?.sizeBytes?.N || 0) > 50000,
    )
  )
    throw Error("Selected skill was removed");
  return Promise.all(
    rows.map(async (row) => {
      const item = unpack(row.Item);
      const object = await s3.send(
        new GetObjectCommand({
          Bucket: process.env.BUCKET,
          Key: item.key,
          ...(item.versionId && { VersionId: item.versionId }),
        }),
      );
      const text = await object.Body.transformToString("utf-8");
      if (text.length > 50000 || text.includes("\0"))
        throw Error("Invalid skill text");
      return { id: item.id, name: item.name, text };
    }),
  );
}

async function activateObject(identity, item, sizeBytes, versionId) {
  const keyName = savedKey(identity.sub, item.projectId, item.id);
  try {
    await db.send(
      new TransactWriteItemsCommand({
        ClientRequestToken: uuid(),
        TransactItems: [
          {
            Update: {
              TableName: process.env.TABLE,
              Key: objectKey(identity.sub, item.id),
              UpdateExpression:
                "SET #status = :active, #key = :key, sizeBytes = :size, versionId = :version REMOVE stageKey, expiresAt",
              ConditionExpression: "#status = :pending",
              ExpressionAttributeNames: { "#status": "status", "#key": "key" },
              ExpressionAttributeValues: {
                ":active": S("ACTIVE"),
                ":pending": S("PENDING"),
                ":key": S(keyName),
                ":size": N(sizeBytes),
                ":version": S(versionId || ""),
              },
            },
          },
          {
            Update: {
              TableName: process.env.TABLE,
              Key: key(`USER#${identity.sub}`, "CONTROL"),
              UpdateExpression: "ADD storageUsedBytes :size",
              ExpressionAttributeValues: { ":size": N(sizeBytes) },
            },
          },
        ],
      }),
    );
    return {
      ...item,
      key: keyName,
      status: "ACTIVE",
      sizeBytes,
      versionId: versionId || "",
    };
  } catch (error) {
    const latest = await db.send(
      new GetItemCommand({
        TableName: process.env.TABLE,
        Key: objectKey(identity.sub, item.id),
        ConsistentRead: true,
      }),
    );
    if (latest.Item?.status?.S === "ACTIVE") return unpack(latest.Item);
    throw error;
  }
}

async function repairPendingObject(identity, item) {
  if (item.status !== "PENDING") return item;
  const objectKeyName = savedKey(identity.sub, item.projectId, item.id);
  // The role lists only users/* prefixes. Exact-key listing distinguishes a
  // missing copy from AccessDenied without broad bucket enumeration.
  const listed = await s3.send(
    new ListObjectsV2Command({
      Bucket: process.env.BUCKET,
      Prefix: objectKeyName,
      MaxKeys: 1,
    }),
  );
  if (!listed.Contents?.some((entry) => entry.Key === objectKeyName))
    return item;
  const head = await s3.send(
    new HeadObjectCommand({ Bucket: process.env.BUCKET, Key: objectKeyName }),
  );
  if (
    !Number.isSafeInteger(head.ContentLength) ||
    head.ContentLength > item.declaredBytes
  )
    return item;
  return activateObject(identity, item, head.ContentLength, head.VersionId);
}

async function completeStagedObject(identity, item, expectedBytes = null) {
  const recovered = await repairPendingObject(identity, item);
  if (recovered.status === "ACTIVE") return recovered;
  let head;
  try {
    head = await s3.send(
      new HeadObjectCommand({ Bucket: process.env.BUCKET, Key: item.stageKey }),
    );
  } catch (error) {
    if (error.$metadata?.httpStatusCode === 404)
      throw Object.assign(new Error("Staging upload missing"), {
        code: "UPLOAD_MISSING",
      });
    throw error;
  }
  const size = head.ContentLength;
  if (
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > item.declaredBytes ||
    (expectedBytes !== null && size !== expectedBytes)
  )
    throw Object.assign(new Error("Staging size mismatch"), {
      code: "UPLOAD_SIZE_MISMATCH",
    });
  const storage = await storageState(identity);
  if (storage.usedBytes + size > storage.limitBytes)
    throw Object.assign(new Error("Storage limit reached"), {
      code: "QUOTA_EXCEEDED",
    });
  const copy = await s3.send(
    new CopyObjectCommand({
      Bucket: process.env.BUCKET,
      Key: savedKey(identity.sub, item.projectId, item.id),
      CopySource: `${process.env.BUCKET}/${item.stageKey}`,
      MetadataDirective: "REPLACE",
      ContentType: item.contentType,
    }),
  );
  const saved = await activateObject(identity, item, size, copy.VersionId);
  await s3
    .send(
      new DeleteObjectCommand({
        Bucket: process.env.BUCKET,
        Key: item.stageKey,
        ...(head.VersionId && { VersionId: head.VersionId }),
      }),
    )
    .catch(() => console.error("Could not remove completed staging object"));
  return saved;
}

async function project(identity, projectId) {
  if (!projectPattern.test(projectId || "")) return null;
  if (projectId === "main") return mainProject;
  const row = await db.send(
    new GetItemCommand({
      TableName: process.env.TABLE,
      Key: projectMetaKey(identity.sub, projectId),
      ConsistentRead: true,
    }),
  );
  return row.Item ? unpack(row.Item) : null;
}

async function listProjects(identity) {
  const page = await db.send(
    new QueryCommand({
      TableName: process.env.TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": S(`USER#${identity.sub}`),
        ":prefix": S("PROJECT#"),
      },
      Limit: 100,
      ConsistentRead: true,
    }),
  );
  return [mainProject, ...(page.Items || []).map(unpack).map(projectPublic)];
}

function effectiveLimits(row, limits) {
  const choose = (legacy, override, baseline) => {
    if (row?.limitsVersion?.N === "2")
      return row[override]?.N === undefined
        ? limits[legacy]
        : Number(row[override].N);
    const old = row?.[legacy]?.N;
    return old === undefined || Number(old) === limits[baseline]
      ? limits[legacy]
      : Number(old);
  };
  return {
    budgetMicroUsd: choose(
      "budgetMicroUsd",
      "budgetOverrideMicroUsd",
      "baselineBudgetMicroUsd",
    ),
    storageBytes: choose(
      "storageBytes",
      "storageOverrideBytes",
      "baselineStorageBytes",
    ),
    period: row?.periodOverride?.S || limits.period,
    budgetEpoch: Number(row?.budgetEpoch?.N || 0),
  };
}

async function approvedModel(modelId) {
  if (modelId === "test.echo")
    return process.env.SCRIPTED_MODEL === "true" ? scriptedModel : null;
  const model = suggestedModels.find((entry) => entry.id === modelId);
  return (model?.transport === "bedrock" ||
    (model?.transport === "gemini" && process.env.GEMINI_PROVIDER)) &&
    Number.isSafeInteger(model.inputRate) &&
    Number.isSafeInteger(model.outputRate)
    ? model
    : null;
}

const modelCatalog = () => [
  ...(process.env.SCRIPTED_MODEL === "true" ? [scriptedModel] : []),
  ...suggestedModels.map((model) => ({
    ...model,
    active:
      model.transport === "bedrock" ||
      (model.transport === "gemini" && Boolean(process.env.GEMINI_PROVIDER)),
  })),
];

async function listAgents(
  identity,
  projectId = "main",
  includeArchived = true,
) {
  const page = await db.send(
    new QueryCommand({
      TableName: process.env.TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": S(projectKey(identity.sub, projectId)),
        ":prefix": S("AGENT#"),
      },
      Limit: 100,
    }),
  );
  return (page.Items || [])
    .map(unpack)
    .map(({ pk, sk, ...agent }) => agent)
    .filter((agent) => includeArchived || !agent.archived);
}

const uuidPattern = /^[0-9a-f-]{36}$/i;
async function connectionsById(identity) {
  const items = await credentialStore.connections(identity);
  return { items: Object.fromEntries(items.map((item) => [item.id, item])) };
}

async function listConversations(identity, projectId, cursor) {
  let start;
  if (cursor) {
    try {
      if (typeof cursor !== "string" || cursor.length > 2000) throw Error();
      start = JSON.parse(Buffer.from(cursor, "base64url").toString());
      if (
        start.gsi1pk?.S !== `CONVERSATIONS#${identity.sub}/${projectId}` ||
        start.pk?.S !== projectKey(identity.sub, projectId) ||
        !/^CONVERSATION#[0-9a-f-]{36}$/i.test(start.sk?.S || "")
      )
        throw Error();
    } catch {
      return {
        status: 400,
        data: { ok: false, error: { code: "VALIDATION_FAILED" } },
      };
    }
  }
  const page = await db.send(
    new QueryCommand({
      TableName: process.env.TABLE,
      IndexName: "UsageByTime",
      KeyConditionExpression: "gsi1pk = :pk",
      ExpressionAttributeValues: {
        ":pk": S(`CONVERSATIONS#${identity.sub}/${projectId}`),
      },
      ExclusiveStartKey: start,
      Limit: 30,
      ScanIndexForward: false,
    }),
  );
  const items = await Promise.all(
    (page.Items || [])
      .map(unpack)
      .filter((item) => item.status !== "DELETING")
      .map(async (item) => ({
        ...conversationPublic(item),
        activeRequests: await runs.activeFor(identity, projectId, item.id),
      })),
  );
  return {
    status: 200,
    data: {
      ok: true,
      data: {
        items,
        nextCursor: page.LastEvaluatedKey
          ? Buffer.from(JSON.stringify(page.LastEvaluatedKey)).toString(
              "base64url",
            )
          : null,
      },
    },
  };
}

const branchPattern = /^(main|[0-9a-f-]{36})$/i;
const conversationPublic = ({
  id,
  agentId,
  title,
  createdAt,
  lastActivityAt,
  activeBranchId,
}) => ({
  id,
  agentId,
  title,
  createdAt,
  lastActivityAt,
  activeBranchId: activeBranchId || "main",
});
const eventPattern = /^[0-9]+#[a-f0-9]+$/i;
const branchKey = (sub, projectId, conversationId, branchId) =>
  key(projectKey(sub, projectId), `BRANCH#${conversationId}#${branchId}`);
const archiveKey = (sub, projectId, conversationId, eventId) =>
  key(projectKey(sub, projectId), `ARCHIVE#${conversationId}#${eventId}`);
const archiveObjectKey = (sub, projectId, conversationId, requestId) =>
  `users/${sub}/${projectId}/chats/${conversationId}/${requestId}.json`;

async function archivePath(
  identity,
  projectId,
  conversationId,
  headEventId,
  limit = 50,
) {
  const records = [];
  let cursor = headEventId;
  while (cursor && records.length < limit) {
    const row = await db.send(
      new GetItemCommand({
        TableName: process.env.TABLE,
        Key: archiveKey(identity.sub, projectId, conversationId, cursor),
        ConsistentRead: true,
      }),
    );
    if (!row.Item)
      return {
        events: await archiveEvents(records),
        nextCursor: null,
        incomplete: true,
      };
    const record = unpack(row.Item);
    records.push(record);
    cursor = record.parentEventId || null;
  }
  return {
    events: await archiveEvents(records),
    nextCursor: cursor,
    incomplete: false,
  };
}

async function archiveEvents(records) {
  return Promise.all(
    records.map(async (record) => {
      const result = await s3.send(
        new GetObjectCommand({
          Bucket: process.env.BUCKET,
          Key: record.objectKey,
          ...(record.versionId && { VersionId: record.versionId }),
        }),
      );
      const data = JSON.parse(await result.Body.transformToString());
      return {
        eventId: record.eventId,
        payload: [
          { conversational: { role: "USER", content: { text: data.message } } },
          {
            conversational: {
              role: "ASSISTANT",
              content: { text: data.answer },
            },
          },
          { json: { content: data.receipt } },
        ],
      };
    }),
  );
}

async function branchCatalog(
  identity,
  projectId,
  conversationId,
  conversation,
) {
  const page = await db.send(
    new QueryCommand({
      TableName: process.env.TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": S(projectKey(identity.sub, projectId)),
        ":prefix": S(`BRANCH#${conversationId}#`),
      },
      ConsistentRead: true,
      Limit: 100,
    }),
  );
  return [
    {
      id: "main",
      name: "Main",
      headEventId: conversation.mainHeadEventId || null,
    },
    ...(page.Items || [])
      .map(unpack)
      .map(
        ({
          id,
          name,
          rootEventId,
          headEventId,
          createdAt,
          memorySessionId,
          memoryRoot,
        }) => ({
          id,
          name,
          rootEventId: rootEventId || null,
          headEventId,
          createdAt,
          memorySessionId,
          memoryRoot,
        }),
      ),
  ];
}

async function branchEvents(
  actorId,
  sessionId,
  branchId,
  cursor,
  maxResults = 100,
) {
  const events = [];
  let nextToken = cursor;
  do {
    const page = await memory.send(
      new ListEventsCommand({
        memoryId: process.env.MEMORY,
        actorId,
        sessionId,
        ...(branchId !== "main" && {
          filter: {
            branch: {
              name: branchId,
              includeParentBranches: true,
            },
          },
        }),
        includePayloads: true,
        maxResults: Math.min(100, maxResults),
        nextToken,
      }),
    );
    events.push(
      ...(branchId === "main"
        ? (page.events || []).filter(
            (event) => !event.branch || event.branch.name === "main",
          )
        : page.events || []),
    );
    nextToken = page.nextToken;
  } while (nextToken && events.length < maxResults);
  return { events: events.slice(0, maxResults), nextToken };
}

const eventMessages = (events) =>
  events.toReversed().flatMap((event) => {
    const calls =
      (event.payload || []).find((payload) =>
        Array.isArray(payload.json?.content?.toolCalls),
      )?.json.content.toolCalls || [];
    return (event.payload || []).flatMap((payload) => {
      const entry = payload.conversational;
      return entry?.content?.text && ["USER", "ASSISTANT"].includes(entry.role)
        ? [
            {
              eventId: event.eventId,
              role: entry.role.toLowerCase(),
              text: entry.content.text,
              status: "complete",
              ...(entry.role === "ASSISTANT" && { tools: calls }),
            },
          ]
        : [];
    });
  });

async function getSession(identity) {
  const [user, limits] = await Promise.all([
    idp.send(
      new AdminGetUserCommand({
        UserPoolId: process.env.POOL,
        Username: identity.sub,
      }),
    ),
    defaults(),
  ]);
  const row = await db.send(
    new GetItemCommand({
      TableName: process.env.TABLE,
      Key: key(`USER#${identity.sub}`, "CONTROL"),
      ConsistentRead: true,
    }),
  );
  const effective = effectiveLimits(row.Item, limits);
  return {
    user: {
      sub: identity.sub,
      email:
        user.UserAttributes?.find((attribute) => attribute.Name === "email")
          ?.Value || "",
      role: identity.role,
      ...effective,
      storageUsedBytes: Number(row.Item?.storageUsedBytes?.N || 0),
    },
    defaults: limits,
    defaultProjectId: "main",
    apiVersion: 2,
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
    return {
      status: 200,
      data: { ok: true, data: { items: await listProjects(identity) } },
    };
  if (
    ["projects.create", "projects.rename", "projects.setHidden"].includes(
      body.command,
    )
  ) {
    if (identity.role === "Auditors")
      return { status: 403, data: { ok: false, error: { code: "FORBIDDEN" } } };
    const { id, name, hidden, revision } = body.input;
    if (!projectPattern.test(id || "") || id === "main") return invalid();
    if (body.command === "projects.create") {
      if (typeof name !== "string" || !name.trim() || name.length > 80)
        return invalid();
      if ((await listProjects(identity)).length >= 100)
        return {
          status: 409,
          data: { ok: false, error: { code: "PROJECT_LIMIT" } },
        };
      const item = {
        ...projectMetaKey(identity.sub, id),
        id: S(id),
        name: S(name.trim()),
        hidden: { BOOL: false },
        revision: N(0),
        createdAt: S(new Date().toISOString()),
      };
      try {
        await db.send(
          new PutItemCommand({
            TableName: process.env.TABLE,
            Item: item,
            ConditionExpression: "attribute_not_exists(pk)",
          }),
        );
      } catch (error) {
        if (error.name === "ConditionalCheckFailedException")
          return {
            status: 409,
            data: { ok: false, error: { code: "PROJECT_EXISTS" } },
          };
        throw error;
      }
      return {
        status: 200,
        data: { ok: true, data: projectPublic(unpack(item)) },
      };
    }
    if (
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      (body.command === "projects.rename" &&
        (typeof name !== "string" || !name.trim() || name.length > 80)) ||
      (body.command === "projects.setHidden" && typeof hidden !== "boolean")
    )
      return invalid();
    try {
      const row = await db.send(
        new UpdateItemCommand({
          TableName: process.env.TABLE,
          Key: projectMetaKey(identity.sub, id),
          UpdateExpression:
            body.command === "projects.rename"
              ? "SET #name = :value, revision = revision + :one"
              : "SET #hidden = :value, revision = revision + :one",
          ConditionExpression: "attribute_exists(pk) AND revision = :revision",
          ExpressionAttributeNames:
            body.command === "projects.rename"
              ? { "#name": "name" }
              : { "#hidden": "hidden" },
          ExpressionAttributeValues: {
            ":value":
              body.command === "projects.rename"
                ? S(name.trim())
                : { BOOL: hidden },
            ":one": N(1),
            ":revision": N(revision),
          },
          ReturnValues: "ALL_NEW",
        }),
      );
      return {
        status: 200,
        data: { ok: true, data: projectPublic(unpack(row.Attributes)) },
      };
    } catch (error) {
      if (error.name === "ConditionalCheckFailedException")
        return {
          status: 409,
          data: { ok: false, error: { code: "REVISION_CONFLICT" } },
        };
      throw error;
    }
  }
  if (
    [
      "objects.beginUpload",
      "objects.completeUpload",
      "objects.list",
      "objects.get",
      "objects.delete",
    ].includes(body.command)
  ) {
    const projectId = projectIdOf(body.input);
    if (!projectPattern.test(projectId)) return invalid();
    if (!(await project(identity, projectId))) return missing();
    if (
      [
        "objects.beginUpload",
        "objects.completeUpload",
        "objects.delete",
      ].includes(body.command) &&
      identity.role === "Auditors"
    )
      return { status: 403, data: { ok: false, error: { code: "FORBIDDEN" } } };
    if (body.command === "objects.beginUpload") {
      const {
        name,
        contentType = "application/octet-stream",
        sizeBytes,
        kind = "file",
      } = body.input;
      if (
        typeof name !== "string" ||
        !name.trim() ||
        name.length > 180 ||
        /[\r\n\0]/.test(name) ||
        !["file", "skill", "artifact"].includes(kind) ||
        typeof contentType !== "string" ||
        !/^[\w.+-]+\/[\w.+-]+$/.test(contentType) ||
        !Number.isSafeInteger(sizeBytes) ||
        sizeBytes < 1 ||
        sizeBytes > 5000000000
      )
        return invalid();
      const storage = await storageState(identity);
      if (storage.usedBytes + sizeBytes > storage.limitBytes)
        return {
          status: 409,
          data: { ok: false, error: { code: "QUOTA_EXCEEDED" } },
        };
      const id = uuid(),
        stageKey = uploadKey(identity.sub, id);
      const item = {
        ...objectKey(identity.sub, id),
        id: S(id),
        projectId: S(projectId),
        name: S(name.trim()),
        kind: S(kind),
        contentType: S(contentType),
        declaredBytes: N(sizeBytes),
        stageKey: S(stageKey),
        status: S("PENDING"),
        createdAt: S(new Date().toISOString()),
        expiresAt: N(Math.floor(Date.now() / 1000) + 86400),
      };
      await db.send(
        new PutItemCommand({
          TableName: process.env.TABLE,
          Item: item,
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
      const upload = await createPresignedPost(s3, {
        Bucket: process.env.BUCKET,
        Key: stageKey,
        Expires: 300,
        Fields: { "Content-Type": contentType },
        Conditions: [
          { "Content-Type": contentType },
          ["content-length-range", 1, Math.min(5000016384, sizeBytes + 16384)],
        ],
      });
      return {
        status: 200,
        data: {
          ok: true,
          data: {
            id,
            upload,
            expiresInSeconds: 300,
          },
        },
      };
    }
    if (body.command === "objects.list") {
      let start;
      if (body.input.cursor) {
        try {
          if (
            typeof body.input.cursor !== "string" ||
            body.input.cursor.length > 2000
          )
            throw Error();
          start = JSON.parse(
            Buffer.from(body.input.cursor, "base64url").toString(),
          );
          if (
            start.pk?.S !== `USER#${identity.sub}` ||
            !/^OBJECT#[0-9a-f-]{36}$/i.test(start.sk?.S || "")
          )
            throw Error();
        } catch {
          return invalid();
        }
      }
      const page = await db.send(
        new QueryCommand({
          TableName: process.env.TABLE,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: {
            ":pk": S(`USER#${identity.sub}`),
            ":prefix": S("OBJECT#"),
          },
          ExclusiveStartKey: start,
          ConsistentRead: true,
          Limit: 50,
        }),
      );
      const rows = await Promise.all(
        (page.Items || []).map((item) =>
          repairPendingObject(identity, unpack(item)),
        ),
      );
      const storage = await storageState(identity);
      return {
        status: 200,
        data: {
          ok: true,
          data: {
            items: rows
              .filter(
                (item) =>
                  item.projectId === projectId && item.status === "ACTIVE",
              )
              .map(objectPublic),
            ...storage,
            nextCursor: page.LastEvaluatedKey
              ? Buffer.from(JSON.stringify(page.LastEvaluatedKey)).toString(
                  "base64url",
                )
              : null,
          },
        },
      };
    }
    const id = body.input.id;
    if (!uuidPattern.test(id || "")) return invalid();
    const row = await db.send(
      new GetItemCommand({
        TableName: process.env.TABLE,
        Key: objectKey(identity.sub, id),
        ConsistentRead: true,
      }),
    );
    if (!row.Item || row.Item.projectId?.S !== projectId) return missing();
    let item = unpack(row.Item);
    if (body.command === "objects.completeUpload") {
      if (item.status === "ACTIVE")
        return {
          status: 200,
          data: { ok: true, data: { item: objectPublic(item) } },
        };
      if (item.status !== "PENDING" || item.expiresAt <= Date.now() / 1000)
        return missing();
      try {
        const saved = await completeStagedObject(identity, item);
        return {
          status: 200,
          data: { ok: true, data: { item: objectPublic(saved) } },
        };
      } catch (error) {
        if (
          ["UPLOAD_MISSING", "UPLOAD_SIZE_MISMATCH", "QUOTA_EXCEEDED"].includes(
            error.code,
          )
        )
          return {
            status: 409,
            data: { ok: false, error: { code: error.code } },
          };
        throw error;
      }
    }
    if (item.status === "PENDING")
      item = await repairPendingObject(identity, item);
    if (item.status !== "ACTIVE") return missing();
    if (body.command === "objects.get") {
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: process.env.BUCKET,
          Key: item.key,
          ...(item.versionId && { VersionId: item.versionId }),
        }),
        { expiresIn: 300 },
      );
      return {
        status: 200,
        data: { ok: true, data: { url, expiresInSeconds: 300 } },
      };
    }
    await s3.send(
      new DeleteObjectCommand({
        Bucket: process.env.BUCKET,
        Key: item.key,
        ...(item.versionId && { VersionId: item.versionId }),
      }),
    );
    try {
      await db.send(
        new TransactWriteItemsCommand({
          ClientRequestToken: uuid(),
          TransactItems: [
            {
              Update: {
                TableName: process.env.TABLE,
                Key: objectKey(identity.sub, id),
                UpdateExpression: "SET #status = :deleted, expiresAt = :expiry",
                ConditionExpression: "#status = :active",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":deleted": S("DELETED"),
                  ":active": S("ACTIVE"),
                  ":expiry": N(Math.floor(Date.now() / 1000) + 30 * 86400),
                },
              },
            },
            {
              Update: {
                TableName: process.env.TABLE,
                Key: key(`USER#${identity.sub}`, "CONTROL"),
                UpdateExpression: "ADD storageUsedBytes :size",
                ExpressionAttributeValues: { ":size": N(-item.sizeBytes) },
              },
            },
          ],
        }),
      );
    } catch (error) {
      const latest = await db.send(
        new GetItemCommand({
          TableName: process.env.TABLE,
          Key: objectKey(identity.sub, id),
          ConsistentRead: true,
        }),
      );
      if (latest.Item?.status?.S !== "DELETED") throw error;
    }
    return { status: 200, data: { ok: true, data: { deleted: true } } };
  }
  if (body.command === "agents.list") {
    const projectId = projectIdOf(body.input);
    if (!projectPattern.test(projectId)) return invalid();
    if (!(await project(identity, projectId))) return missing();
    if (
      body.input.includeArchived !== undefined &&
      typeof body.input.includeArchived !== "boolean"
    )
      return invalid();
    return {
      status: 200,
      data: {
        ok: true,
        data: {
          items: await listAgents(
            identity,
            projectId,
            body.input.includeArchived ?? true,
          ),
        },
      },
    };
  }
  if (body.command === "agents.setArchived") {
    if (identity.role === "Auditors")
      return {
        status: 403,
        data: {
          ok: false,
          error: { code: "FORBIDDEN" },
        },
      };
    const { id, revision, archived } = body.input;
    const projectId = projectIdOf(body.input);
    if (
      !projectPattern.test(projectId) ||
      !uuidPattern.test(id || "") ||
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      typeof archived !== "boolean"
    )
      return invalid();
    if (!(await project(identity, projectId))) return missing();
    try {
      const updated = await db.send(
        new UpdateItemCommand({
          TableName: process.env.TABLE,
          Key: key(projectKey(identity.sub, projectId), `AGENT#${id}`),
          UpdateExpression: "SET archived = :archived, revision = :next",
          ConditionExpression: "attribute_exists(pk) AND revision = :revision",
          ExpressionAttributeValues: {
            ":archived": { BOOL: archived },
            ":next": N(revision + 1),
            ":revision": N(revision),
          },
          ReturnValues: "ALL_NEW",
        }),
      );
      return {
        status: 200,
        data: { ok: true, data: unpack(updated.Attributes) },
      };
    } catch (error) {
      if (error.name === "ConditionalCheckFailedException")
        return {
          status: 409,
          data: { ok: false, error: { code: "REVISION_CONFLICT" } },
        };
      throw error;
    }
  }
  if (
    body.command.startsWith("credentials.") ||
    body.command.startsWith("connections.")
  ) {
    try {
      const checked = await connections(body, identity);
      if (checked) return checked;
      if (
        body.input.projectId &&
        !(await project(identity, body.input.projectId))
      )
        return missing();
      return {
        status: 200,
        data: {
          ok: true,
          data: await credentialStore.command(
            body.command,
            identity,
            body.input,
          ),
        },
      };
    } catch (error) {
      if (!error.code) throw error;
      return { status: 400, data: { ok: false, error: { code: error.code } } };
    }
  }
  if (body.command === "workspace.get") {
    const projectId = projectIdOf(body.input);
    if (
      !projectPattern.test(projectId) ||
      Object.keys(body.input).some((name) => name !== "projectId")
    )
      return invalid();
    if (!(await project(identity, projectId))) return missing();
    const [session, projects, agents, conversations] = await Promise.all([
      getSession(identity),
      listProjects(identity),
      listAgents(identity, projectId),
      listConversations(identity, projectId),
    ]);
    return {
      status: 200,
      data: {
        ok: true,
        data: {
          session,
          projects,
          agents,
          models: modelCatalog(),
          conversations: conversations.data.data,
        },
      },
    };
  }
  if (body.command === "conversations.list") {
    const projectId = projectIdOf(body.input);
    if (!projectPattern.test(projectId)) return invalid();
    if (!(await project(identity, projectId))) return missing();
    return listConversations(identity, projectId, body.input.cursor);
  }
  if (body.command === "conversations.get") {
    const { agentId, conversationId, cursor } = body.input;
    const projectId = projectIdOf(body.input);
    const branchId = body.input.branchId ?? "main";
    const uuid = /^[0-9a-f-]{36}$/i;
    if (
      !projectPattern.test(projectId) ||
      !branchPattern.test(branchId) ||
      !uuid.test(agentId || "") ||
      !uuid.test(conversationId || "") ||
      (cursor !== undefined &&
        (typeof cursor !== "string" || cursor.length > 4000))
    )
      return {
        status: 400,
        data: { ok: false, error: { code: "VALIDATION_FAILED" } },
      };
    if (!(await project(identity, projectId))) return missing();
    const row = await db.send(
      new GetItemCommand({
        TableName: process.env.TABLE,
        Key: key(
          projectKey(identity.sub, projectId),
          `CONVERSATION#${conversationId}`,
        ),
        ConsistentRead: true,
      }),
    );
    if (
      !row.Item ||
      row.Item.agentId?.S !== agentId ||
      row.Item.status?.S === "DELETING"
    )
      return { status: 404, data: { ok: false, error: { code: "NOT_FOUND" } } };
    const conversation = unpack(row.Item);
    const activeRequests = await runs.activeFor(
      identity,
      projectId,
      conversationId,
    );
    const branches = await branchCatalog(
      identity,
      projectId,
      conversationId,
      conversation,
    );
    for (const run of activeRequests)
      if (!branches.some((branch) => branch.id === run.branchId))
        branches.push({
          ...branches.find((branch) => branch.id === run.sourceBranchId),
          id: run.branchId,
          name: "Alternative · working",
          headEventId: run.forkEventId || null,
        });
    if (!branches.some((branch) => branch.id === branchId)) return missing();
    const selected = branches.find((branch) => branch.id === branchId);
    if (conversation.durable && cursor && !eventPattern.test(cursor))
      return invalid();
    const page = conversation.durable
      ? await archivePath(
          identity,
          projectId,
          conversationId,
          cursor || selected.headEventId,
          50,
        )
      : await branchEvents(
          `${identity.sub}/${projectId}`,
          selected.memorySessionId ||
            conversation.mainMemorySessionId ||
            `a_${agentId}_${conversationId}`,
          selected.memoryRoot ? "main" : selected.id,
          cursor,
        );
    return {
      status: 200,
      data: {
        ok: true,
        data: {
          conversation: conversationPublic(conversation),
          branchId,
          activeRequests,
          branches: branches.map(
            ({ memorySessionId, memoryRoot, ...branch }) => branch,
          ),
          messages: eventMessages(page.events),
          historyExpired: !conversation.durable && !page.events.length,
          archiveIncomplete: Boolean(page.incomplete),
          nextCursor: page.nextCursor || page.nextToken || null,
        },
      },
    };
  }
  if (body.command === "conversations.delete") {
    if (identity.role === "Auditors")
      return { status: 403, data: { ok: false, error: { code: "FORBIDDEN" } } };
    const { conversationId, agentId } = body.input;
    const projectId = projectIdOf(body.input);
    if (
      !projectPattern.test(projectId) ||
      !uuidPattern.test(conversationId || "") ||
      (agentId !== undefined && !uuidPattern.test(agentId))
    )
      return invalid();
    if (!(await project(identity, projectId))) return missing();
    if (
      (await runs.activeFor(identity, projectId, conversationId)).some((run) =>
        ["running", "memory_written"].includes(run.status),
      )
    )
      return {
        status: 409,
        data: { ok: false, error: { code: "RUN_ACTIVE" } },
      };
    const conversationKey = key(
      projectKey(identity.sub, projectId),
      `CONVERSATION#${conversationId}`,
    );
    const read = () =>
      db.send(
        new GetItemCommand({
          TableName: process.env.TABLE,
          Key: conversationKey,
          ConsistentRead: true,
        }),
      );
    const row = await read();
    if (!row.Item)
      return { status: 200, data: { ok: true, data: { deleted: true } } };
    if (agentId && row.Item.agentId?.S !== agentId) return missing();
    if (row.Item.status?.S !== "DELETING") {
      try {
        await db.send(
          new UpdateItemCommand({
            TableName: process.env.TABLE,
            Key: conversationKey,
            UpdateExpression: "SET #status = :deleting REMOVE gsi1pk, gsi1sk",
            ConditionExpression:
              "attribute_exists(pk) AND (attribute_not_exists(#status) OR #status = :active) AND (attribute_not_exists(activeRunCount) OR activeRunCount = :zero)",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":deleting": S("DELETING"),
              ":active": S("ACTIVE"),
              ":zero": N(0),
            },
          }),
        );
      } catch (error) {
        if (error.name !== "ConditionalCheckFailedException") throw error;
        const current = await read();
        if (!current.Item)
          return { status: 200, data: { ok: true, data: { deleted: true } } };
        if (Number(current.Item.activeRunCount?.N || 0) > 0)
          return {
            status: 409,
            data: { ok: false, error: { code: "RUN_ACTIVE" } },
          };
        if (current.Item.status?.S !== "DELETING") throw error;
      }
    }
    const archives = await db.send(
      new QueryCommand({
        TableName: process.env.TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": S(projectKey(identity.sub, projectId)),
          ":prefix": S(`ARCHIVE#${conversationId}#`),
        },
        ConsistentRead: true,
        Limit: 100,
      }),
    );
    for (const item of archives.Items || []) {
      if (!item.versionId?.S) throw Error("Archive version is missing");
      await s3.send(
        new DeleteObjectCommand({
          Bucket: process.env.BUCKET,
          Key: item.objectKey.S,
          VersionId: item.versionId.S,
        }),
      );
      try {
        await db.send(
          new TransactWriteItemsCommand({
            ClientRequestToken: uuid(),
            TransactItems: [
              {
                Delete: {
                  TableName: process.env.TABLE,
                  Key: { pk: item.pk, sk: item.sk },
                  ConditionExpression: "versionId = :version",
                  ExpressionAttributeValues: { ":version": item.versionId },
                },
              },
              {
                Update: {
                  TableName: process.env.TABLE,
                  Key: key(`USER#${identity.sub}`, "CONTROL"),
                  UpdateExpression: "ADD storageUsedBytes :bytes",
                  ExpressionAttributeValues: {
                    ":bytes": N(-Number(item.sizeBytes.N)),
                  },
                },
              },
            ],
          }),
        );
      } catch (error) {
        if (error.name !== "TransactionCanceledException") throw error;
        const latest = await db.send(
          new GetItemCommand({
            TableName: process.env.TABLE,
            Key: { pk: item.pk, sk: item.sk },
            ConsistentRead: true,
          }),
        );
        if (latest.Item) throw error;
      }
    }
    if (archives.LastEvaluatedKey || archives.Items?.length === 100)
      return { status: 200, data: { ok: true, data: { deleting: true } } };
    const sessions = new Set([
      row.Item.mainMemorySessionId?.S ||
        `a_${row.Item.agentId.S}_${conversationId}`,
      ...(row.Item.memorySessions?.SS || []),
    ]);
    const branches = await db.send(
      new QueryCommand({
        TableName: process.env.TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": S(projectKey(identity.sub, projectId)),
          ":prefix": S(`BRANCH#${conversationId}#`),
        },
        ConsistentRead: true,
        Limit: 100,
      }),
    );
    for (const branch of branches.Items || [])
      if (branch.memorySessionId?.S) sessions.add(branch.memorySessionId.S);
    let removed = 0;
    for (const sessionId of sessions) {
      let page;
      try {
        page = await memory.send(
          new ListEventsCommand({
            memoryId: process.env.MEMORY,
            actorId: `${identity.sub}/${projectId}`,
            sessionId,
            maxResults: 100,
            includePayloads: false,
          }),
        );
      } catch (error) {
        if (error.name === "ResourceNotFoundException") continue;
        throw error;
      }
      for (const event of page.events || []) {
        await memory
          .send(
            new DeleteEventCommand({
              memoryId: process.env.MEMORY,
              actorId: `${identity.sub}/${projectId}`,
              sessionId,
              eventId: event.eventId,
            }),
          )
          .catch((error) => {
            if (error.name !== "ResourceNotFoundException") throw error;
          });
        if (++removed === 100)
          return { status: 200, data: { ok: true, data: { deleting: true } } };
      }
      if (page.nextToken)
        return { status: 200, data: { ok: true, data: { deleting: true } } };
    }
    for (const branch of branches.Items || [])
      await db.send(
        new DeleteItemCommand({
          TableName: process.env.TABLE,
          Key: { pk: branch.pk, sk: branch.sk },
        }),
      );
    if (branches.LastEvaluatedKey || branches.Items?.length === 100)
      return { status: 200, data: { ok: true, data: { deleting: true } } };
    await db
      .send(
        new DeleteItemCommand({
          TableName: process.env.TABLE,
          Key: conversationKey,
          ConditionExpression: "#status = :deleting",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":deleting": S("DELETING") },
        }),
      )
      .catch((error) => {
        if (error.name !== "ConditionalCheckFailedException") throw error;
      });
    return { status: 200, data: { ok: true, data: { deleted: true } } };
  }
  if (body.command === "agents.put") {
    if (identity.role === "Auditors")
      return { status: 403, data: { ok: false, error: { code: "FORBIDDEN" } } };
    const {
      id: existingId,
      revision,
      name,
      modelId,
      systemPrompt = "",
      codeInterpreter = false,
      webSearch = false,
      browser = false,
      connectionIds = [],
      skillIds = [],
      thinkingLevel,
      webSearchMaxResults = 5,
      browserSessionSeconds = 300,
    } = body.input;
    const projectId = projectIdOf(body.input);
    if (
      !projectPattern.test(projectId) ||
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 80 ||
      typeof modelId !== "string" ||
      !modelId ||
      modelId.length > 512 ||
      typeof systemPrompt !== "string" ||
      systemPrompt.length > 12000 ||
      [codeInterpreter, webSearch, browser].some(
        (value) => typeof value !== "boolean",
      ) ||
      !Array.isArray(connectionIds) ||
      connectionIds.length > 4 ||
      connectionIds.some((id) => !uuidPattern.test(id || "")) ||
      new Set(connectionIds).size !== connectionIds.length ||
      !Array.isArray(skillIds) ||
      skillIds.length > 4 ||
      skillIds.some((id) => !uuidPattern.test(id || "")) ||
      new Set(skillIds).size !== skillIds.length ||
      (connectionIds.length && !codeInterpreter) ||
      (existingId !== undefined &&
        (!uuidPattern.test(existingId || "") ||
          !Number.isSafeInteger(revision) ||
          revision < 0)) ||
      !Number.isSafeInteger(webSearchMaxResults) ||
      webSearchMaxResults < 1 ||
      webSearchMaxResults > 25 ||
      !Number.isSafeInteger(browserSessionSeconds) ||
      browserSessionSeconds < 60 ||
      browserSessionSeconds > 900
    )
      return {
        status: 400,
        data: { ok: false, error: { code: "VALIDATION_FAILED" } },
      };
    if (!(await project(identity, projectId))) return missing();
    const model = await approvedModel(modelId);
    if (!model)
      return {
        status: 400,
        data: { ok: false, error: { code: "MODEL_UNAVAILABLE" } },
      };
    const selectedThinkingLevel = thinkingLevel ?? model.defaultThinkingLevel;
    if (
      model.thinkingLevels.length
        ? !model.thinkingLevels.includes(selectedThinkingLevel)
        : thinkingLevel !== undefined
    )
      return {
        status: 400,
        data: { ok: false, error: { code: "VALIDATION_FAILED" } },
      };
    if (browser && !model.browserTool)
      return {
        status: 400,
        data: { ok: false, error: { code: "TOOL_UNAVAILABLE" } },
      };
    if (connectionIds.length) {
      const saved = (await connectionsById(identity)).items;
      const selected = connectionIds.map((id) => saved[id]);
      if (
        selected.some((item) => !item) ||
        new Set(selected.map((item) => item.kind)).size !== selected.length
      )
        return {
          status: 400,
          data: { ok: false, error: { code: "CONNECTION_UNAVAILABLE" } },
        };
    }
    if (skillIds.length) {
      const selected = await Promise.all(
        skillIds.map((id) =>
          db.send(
            new GetItemCommand({
              TableName: process.env.TABLE,
              Key: objectKey(identity.sub, id),
              ConsistentRead: true,
            }),
          ),
        ),
      );
      if (
        selected.some(
          (row) =>
            row.Item?.projectId?.S !== projectId ||
            row.Item?.kind?.S !== "skill" ||
            row.Item?.status?.S !== "ACTIVE" ||
            Number(row.Item?.sizeBytes?.N || 0) > 50000,
        )
      )
        return {
          status: 400,
          data: { ok: false, error: { code: "SKILL_UNAVAILABLE" } },
        };
    }
    const id = existingId || uuid();
    let createdAt = new Date().toISOString();
    let legacyRevision = false;
    if (existingId) {
      const current = await db.send(
        new GetItemCommand({
          TableName: process.env.TABLE,
          Key: key(projectKey(identity.sub, projectId), `AGENT#${id}`),
          ConsistentRead: true,
        }),
      );
      if (!current.Item)
        return {
          status: 404,
          data: { ok: false, error: { code: "NOT_FOUND" } },
        };
      if (current.Item.archived?.BOOL)
        return {
          status: 409,
          data: { ok: false, error: { code: "AGENT_ARCHIVED" } },
        };
      if (Number(current.Item.revision?.N || 0) !== revision)
        return {
          status: 409,
          data: { ok: false, error: { code: "REVISION_CONFLICT" } },
        };
      createdAt = current.Item.createdAt.S;
      legacyRevision = !current.Item.revision;
    }
    const agent = {
      id,
      name: name.trim(),
      modelId,
      systemPrompt,
      codeInterpreter,
      webSearch,
      browser,
      connectionIds,
      skillIds,
      ...(selectedThinkingLevel && { thinkingLevel: selectedThinkingLevel }),
      webSearchMaxResults,
      browserSessionSeconds,
      createdAt,
      revision: existingId ? revision + 1 : 0,
    };
    try {
      await db.send(
        new PutItemCommand({
          TableName: process.env.TABLE,
          Item: {
            pk: S(projectKey(identity.sub, projectId)),
            sk: S(`AGENT#${id}`),
            id: S(id),
            name: S(agent.name),
            modelId: S(modelId),
            systemPrompt: S(systemPrompt),
            codeInterpreter: { BOOL: codeInterpreter },
            webSearch: { BOOL: webSearch },
            browser: { BOOL: browser },
            connectionIds: { L: connectionIds.map(S) },
            skillIds: { L: skillIds.map(S) },
            ...(selectedThinkingLevel && {
              thinkingLevel: S(selectedThinkingLevel),
            }),
            createdAt: S(createdAt),
            webSearchMaxResults: N(webSearchMaxResults),
            browserSessionSeconds: N(browserSessionSeconds),
            revision: N(agent.revision),
          },
          ConditionExpression: existingId
            ? legacyRevision
              ? "attribute_not_exists(revision)"
              : "revision = :expected"
            : "attribute_not_exists(pk)",
          ...(existingId &&
            !legacyRevision && {
              ExpressionAttributeValues: { ":expected": N(revision) },
            }),
        }),
      );
    } catch (error) {
      if (error.name === "ConditionalCheckFailedException")
        return {
          status: 409,
          data: { ok: false, error: { code: "REVISION_CONFLICT" } },
        };
      throw error;
    }
    return { status: 200, data: { ok: true, data: agent } };
  }
  if (body.command === "usage.get") {
    if (body.input.requestId)
      return invoke(
        { v: 1, command: "usage.request", input: body.input },
        identity,
      );
    // Compose two independent, authorized reads inside one Runtime invocation.
    const [summary, detail, daily] = await Promise.all([
      invoke(
        {
          v: 1,
          command: "usage.summary",
          input: {
            userSub: body.input.userSub,
          },
        },
        identity,
      ),
      invoke({ v: 1, command: "usage.list", input: body.input }, identity),
      body.input.includeDaily
        ? invoke(
            {
              v: 1,
              command: "usage.daily",
              input: {
                range: body.input.range,
                scope: body.input.scope,
                userSub: body.input.userSub,
              },
            },
            identity,
          )
        : null,
    ]);
    if (summary.status !== 200) return summary;
    if (detail.status !== 200) return detail;
    if (daily && daily.status !== 200) return daily;
    return {
      status: 200,
      data: {
        ok: true,
        data: {
          ...summary.data.data,
          ...detail.data.data,
          ...(daily && { daily: daily.data.data }),
        },
      },
    };
  }
  if (body.command === "usage.daily") {
    const { range = "30d", scope = "self", cursor } = body.input;
    const target = body.input.userSub || identity.sub;
    if (
      !["30d", "90d"].includes(range) ||
      !["self", "all"].includes(scope) ||
      !/^[0-9a-f-]{36}$/i.test(target)
    )
      return invalid();
    if (
      (scope === "all" || target !== identity.sub) &&
      identity.role !== "Administrators"
    )
      return { status: 403, data: { ok: false, error: { code: "FORBIDDEN" } } };
    const since = new Date(Date.now() - (range === "90d" ? 89 : 29) * 86400000)
      .toISOString()
      .slice(0, 10);
    let start;
    if (cursor) {
      try {
        if (typeof cursor !== "string" || cursor.length > 4000) throw Error();
        const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
        if (
          decoded.range !== range ||
          decoded.scope !== scope ||
          decoded.target !== target ||
          decoded.since !== since
        )
          throw Error();
        start = decoded.key;
        if (
          !start?.sk?.S?.startsWith("DAY#") ||
          (scope === "self" && start.pk?.S !== `USER#${target}`) ||
          (scope === "all" && start.gsi1pk?.S !== "USAGE_DAYS")
        )
          throw Error();
      } catch {
        return invalid();
      }
    }
    const page = await db.send(
      new QueryCommand({
        TableName: process.env.TABLE,
        ...(scope === "all" && { IndexName: "UsageByTime" }),
        KeyConditionExpression:
          scope === "all"
            ? "gsi1pk = :pk AND gsi1sk BETWEEN :from AND :to"
            : "pk = :pk AND sk BETWEEN :from AND :to",
        ExpressionAttributeValues: {
          ":pk": S(scope === "all" ? "USAGE_DAYS" : `USER#${target}`),
          ":from": S(scope === "all" ? since : `DAY#${since}`),
          ":to": S(scope === "all" ? "￿" : "DAY#9999-12-31"),
        },
        ExclusiveStartKey: start,
        Limit: 100,
        ...(scope === "self" && { ConsistentRead: true }),
      }),
    );
    return {
      status: 200,
      data: {
        ok: true,
        data: {
          items: (page.Items || []).map(unpack),
          nextCursor: page.LastEvaluatedKey
            ? Buffer.from(
                JSON.stringify({
                  key: page.LastEvaluatedKey,
                  range,
                  scope,
                  target,
                  since,
                }),
              ).toString("base64url")
            : null,
        },
      },
    };
  }
  if (body.command === "usage.request") {
    const target = body.input.userSub || identity.sub;
    const requestId = body.input.requestId;
    if (
      !/^[0-9a-f-]{36}$/i.test(target) ||
      !/^[0-9a-f-]{36}$/i.test(requestId || "")
    )
      return invalid();
    if (target !== identity.sub && identity.role !== "Administrators")
      return { status: 403, data: { ok: false, error: { code: "FORBIDDEN" } } };
    const row = await db.send(
      new GetItemCommand({
        TableName: process.env.TABLE,
        Key: key(`USER#${target}`, `REQUEST#${requestId}`),
        ConsistentRead: true,
      }),
    );
    if (!row.Item) return missing();
    const { pendingCommitJson, meterKeys, ...request } = unpack(row.Item);
    const steps = await Promise.all(
      (meterKeys || []).map(async (sk) => {
        const item = await db.send(
          new GetItemCommand({
            TableName: process.env.TABLE,
            Key: key(`USER#${target}`, sk),
            ConsistentRead: true,
          }),
        );
        return item.Item ? unpack(item.Item) : null;
      }),
    );
    return {
      status: 200,
      data: {
        ok: true,
        data: {
          request,
          steps: steps.filter(Boolean),
        },
      },
    };
  }
  if (body.command === "usage.reconcile") {
    const target = body.input.userSub || identity.sub;
    const requestId = body.input.requestId;
    if (
      !/^[0-9a-f-]{36}$/i.test(target) ||
      !/^[0-9a-f-]{36}$/i.test(requestId || "")
    )
      return invalid();
    if (target !== identity.sub && identity.role !== "Administrators")
      return { status: 403, data: { ok: false, error: { code: "FORBIDDEN" } } };
    const requestKey = key(`USER#${target}`, `REQUEST#${requestId}`);
    const row = await db.send(
      new GetItemCommand({
        TableName: process.env.TABLE,
        Key: requestKey,
        ConsistentRead: true,
      }),
    );
    if (!row.Item) return missing();
    const state = unpack(row.Item);
    if (state.status === "completed")
      return {
        status: 200,
        data: {
          ok: true,
          data: {
            status: "completed",
            costMicroUsd: state.costMicroUsd,
          },
        },
      };
    if (
      state.pendingCommitJson &&
      state.eventId &&
      ["memory_written", "navigation_failed"].includes(state.status)
    ) {
      const items = JSON.parse(state.pendingCommitJson);
      if (
        !Array.isArray(items) ||
        items.length > 6 ||
        items.some((item) => {
          const operation = item.Put || item.Update;
          const itemKey = operation?.Key || operation?.Item;
          return (
            operation?.TableName !== process.env.TABLE ||
            !(
              itemKey?.pk?.S === `USER#${target}` ||
              itemKey?.pk?.S?.startsWith(`PROJECT#${target}/`)
            )
          );
        })
      )
        throw Error("Invalid prepared completion");
      const archived = items.find((item) =>
        item.Put?.Item?.sk?.S?.startsWith("ARCHIVE#"),
      )?.Put.Item;
      if (archived) {
        try {
          const head = await s3.send(
            new HeadObjectCommand({
              Bucket: process.env.BUCKET,
              Key: archived.objectKey.S,
              ...(archived.versionId?.S && { VersionId: archived.versionId.S }),
            }),
          );
          if (head.ContentLength !== Number(archived.sizeBytes.N))
            return {
              status: 409,
              data: { ok: false, error: { code: "ARCHIVE_MISMATCH" } },
            };
        } catch (error) {
          if (error.$metadata?.httpStatusCode === 404)
            return {
              status: 409,
              data: { ok: false, error: { code: "ARCHIVE_MISSING" } },
            };
          throw error;
        }
      }
      try {
        await db.send(
          new TransactWriteItemsCommand({
            ClientRequestToken: requestId,
            TransactItems: items,
          }),
        );
      } catch (error) {
        if (error.name !== "TransactionCanceledException") throw error;
        const latest = await db.send(
          new GetItemCommand({
            TableName: process.env.TABLE,
            Key: requestKey,
            ConsistentRead: true,
          }),
        );
        if (latest.Item?.status?.S !== "completed")
          return {
            status: 409,
            data: { ok: false, error: { code: "RECONCILE_CONFLICT" } },
          };
      }
      return {
        status: 200,
        data: {
          ok: true,
          data: {
            status: "completed",
            costMicroUsd: state.costMicroUsd,
          },
        },
      };
    }
    if (
      state.status === "running" &&
      Date.parse(state.acceptedAt) < Date.now() - 3600000
    ) {
      await db
        .send(
          new UpdateItemCommand({
            TableName: process.env.TABLE,
            Key: requestKey,
            UpdateExpression: "SET #status = :unknown, failureStage = :stage",
            ConditionExpression: "#status = :running AND acceptedAt < :cutoff",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":unknown": S("outcome_unknown"),
              ":stage": S("stale_request"),
              ":running": S("running"),
              ":cutoff": S(new Date(Date.now() - 3600000).toISOString()),
            },
          }),
        )
        .catch((error) => {
          if (error.name !== "ConditionalCheckFailedException") throw error;
        });
      return {
        status: 200,
        data: {
          ok: true,
          data: {
            status: "outcome_unknown",
            costMicroUsd: state.costMicroUsd,
          },
        },
      };
    }
    return {
      status: 200,
      data: {
        ok: true,
        data: {
          status: state.status,
          costMicroUsd: state.costMicroUsd,
          quality: "unresolved",
        },
      },
    };
  }
  if (body.command === "usage.summary") {
    const target = body.input.userSub || identity.sub;
    if (!/^[0-9a-f-]{36}$/i.test(target)) return invalid();
    if (target !== identity.sub && identity.role !== "Administrators")
      return { status: 403, data: { ok: false, error: { code: "FORBIDDEN" } } };
    const [limits, user] = await Promise.all([
      defaults(),
      db.send(
        new GetItemCommand({
          TableName: process.env.TABLE,
          Key: key(`USER#${target}`, "CONTROL"),
          ConsistentRead: true,
        }),
      ),
    ]);
    const effective = effectiveLimits(user.Item, limits);
    const period = periodKey(
      effective.period,
      new Date(),
      effective.budgetEpoch,
    );
    const row = await db.send(
      new GetItemCommand({
        TableName: process.env.TABLE,
        Key: key(`USER#${target}`, period),
        ConsistentRead: true,
      }),
    );
    return {
      status: 200,
      data: {
        ok: true,
        data: {
          period,
          userSub: target,
          budgetMicroUsd: effective.budgetMicroUsd,
          costMicroUsd: Number(row.Item?.costMicroUsd?.N || 0),
          unpricedToolCalls: Number(row.Item?.unpricedToolCalls?.N || 0),
          quality: Number(row.Item?.unpricedToolCalls?.N || 0)
            ? "partial"
            : Number(row.Item?.estimatedModelCalls?.N || 0)
              ? "estimated"
              : "model-only",
        },
      },
    };
  }
  if (body.command === "usage.list") {
    const {
      range = "30d",
      sort = "desc",
      scope = "self",
      cursor,
      projectId: usageProjectId,
      agentId,
      requestId,
      tool,
      kind,
      quality,
      status,
      from,
      to,
    } = body.input;
    const target = body.input.userSub || identity.sub;
    if (
      (usageProjectId !== undefined && !projectPattern.test(usageProjectId)) ||
      !["30d", "90d"].includes(range) ||
      !["asc", "desc"].includes(sort) ||
      !["self", "all"].includes(scope) ||
      (scope === "all" && identity.role !== "Administrators") ||
      (agentId !== undefined && !uuidPattern.test(agentId)) ||
      (requestId !== undefined && !uuidPattern.test(requestId)) ||
      (tool !== undefined && !/^[a-z_]{1,80}$/.test(tool)) ||
      (kind !== undefined && !["model", "tool"].includes(kind)) ||
      (quality !== undefined &&
        !["estimated", "unpriced", "unknown"].includes(quality)) ||
      (status !== undefined &&
        ![
          "running",
          "completed",
          "cancelled",
          "memory_failed",
          "navigation_failed",
          "outcome_unknown",
        ].includes(status)) ||
      (from === undefined) !== (to === undefined) ||
      (from !== undefined &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)))
    )
      return {
        status: 400,
        data: { ok: false, error: { code: "VALIDATION_FAILED" } },
      };
    if (target !== identity.sub && identity.role !== "Administrators")
      return { status: 403, data: { ok: false, error: { code: "FORBIDDEN" } } };
    if (!/^[0-9a-f-]{36}$/i.test(target))
      return {
        status: 400,
        data: { ok: false, error: { code: "VALIDATION_FAILED" } },
      };
    const filterKey = createHash("sha256")
      .update(
        JSON.stringify({
          range,
          sort,
          scope,
          target,
          usageProjectId,
          agentId,
          requestId,
          tool,
          kind,
          quality,
          status,
          from,
          to,
        }),
      )
      .digest("hex")
      .slice(0, 20);
    if (
      from &&
      (!Number.isFinite(Date.parse(from + "T00:00:00.000Z")) ||
        !Number.isFinite(Date.parse(to + "T23:59:59.999Z")))
    )
      return invalid();
    let since = from
      ? new Date(from + "T00:00:00.000Z").toISOString()
      : new Date(
          Date.now() - (range === "90d" ? 90 : 30) * 86400000,
        ).toISOString();
    let until = to
      ? new Date(to + "T23:59:59.999Z").toISOString()
      : new Date().toISOString();
    if (
      !Number.isFinite(Date.parse(since)) ||
      !Number.isFinite(Date.parse(until)) ||
      Date.parse(until) < Date.parse(since) ||
      Date.parse(until) - Date.parse(since) > 91 * 86400000 ||
      Date.parse(until) > Date.now() + 86400000
    )
      return invalid();
    let start;
    if (cursor) {
      try {
        if (typeof cursor !== "string" || cursor.length > 4000) throw Error();
        const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
        if (
          decoded.filterKey !== filterKey ||
          typeof decoded.since !== "string" ||
          typeof decoded.until !== "string" ||
          !Number.isFinite(Date.parse(decoded.since)) ||
          !Number.isFinite(Date.parse(decoded.until)) ||
          Date.parse(decoded.until) < Date.parse(decoded.since) ||
          Date.parse(decoded.until) - Date.parse(decoded.since) > 91 * 86400000
        )
          throw Error();
        ({ since, until } = decoded);
        start = decoded.key;
        if (
          !/^USER#[0-9a-f-]{36}$/i.test(start.pk?.S || "") ||
          (scope === "self" && start.pk.S !== `USER#${target}`) ||
          !start.sk?.S?.startsWith("USAGE#") ||
          (scope === "all" && start.gsi1pk?.S !== "USAGE")
        )
          throw Error();
      } catch {
        return {
          status: 400,
          data: { ok: false, error: { code: "VALIDATION_FAILED" } },
        };
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
      filters.push(
        usageProjectId === "main"
          ? "(projectId = :project OR attribute_not_exists(projectId))"
          : "projectId = :project",
      );
    }
    for (const [field, value] of Object.entries({
      agentId,
      requestId,
      kind,
      quality,
    }))
      if (value !== undefined) {
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
    const page = await db.send(
      new QueryCommand({
        TableName: process.env.TABLE,
        ...(scope === "all" && { IndexName: "UsageByTime" }),
        KeyConditionExpression:
          scope === "all"
            ? "gsi1pk = :pk AND gsi1sk BETWEEN :from AND :to"
            : "pk = :pk AND sk BETWEEN :from AND :to",
        ExpressionAttributeValues: values,
        ExclusiveStartKey: start,
        Limit: 50,
        ScanIndexForward: sort === "asc",
        ...(filters.length && {
          FilterExpression: filters.join(" AND "),
          ...(Object.keys(names).length && { ExpressionAttributeNames: names }),
        }),
        ...(scope === "self" && { ConsistentRead: true }),
      }),
    );
    let items = (page.Items || []).map(unpack).map((item) => ({
      ...item,
      projectId: item.projectId || "main",
    }));
    if (status !== undefined) {
      const states = await Promise.all(
        items.map((item) =>
          db.send(
            new GetItemCommand({
              TableName: process.env.TABLE,
              Key: key(`USER#${item.userSub}`, `REQUEST#${item.requestId}`),
              ConsistentRead: true,
            }),
          ),
        ),
      );
      items = items
        .map((item, index) => ({
          ...item,
          requestStatus: states[index].Item?.status?.S || "unknown",
        }))
        .filter((item) => item.requestStatus === status);
    }
    return {
      status: 200,
      data: {
        ok: true,
        data: {
          range,
          sort,
          scope,
          items,
          nextCursor: page.LastEvaluatedKey
            ? Buffer.from(
                JSON.stringify({
                  key: page.LastEvaluatedKey,
                  filterKey,
                  since,
                  until,
                }),
              ).toString("base64url")
            : null,
        },
      },
    };
  }
  if (body.command === "models.list") {
    return { status: 200, data: { ok: true, data: { items: modelCatalog() } } };
  }
  const userResult = await users(body, identity);
  if (userResult) return userResult;
  if (body.command !== "session.get" || Object.keys(body.input).length)
    return {
      status: 501,
      data: { ok: false, error: { code: "NOT_IMPLEMENTED" } },
    };
  return { status: 200, data: { ok: true, data: await getSession(identity) } };
}

const runs = createRuns({
  db,
  s3,
  table: process.env.TABLE,
  bucket: process.env.BUCKET,
  currentIdentity,
});
const context = {
  N,
  S,
  approvedModel,
  archiveKey,
  archiveObjectKey,
  archivePath,
  bedrock,
  branchEvents,
  branchKey,
  branchPattern,
  completeStagedObject,
  connectionsById,
  db,
  defaults,
  effectiveLimits,
  eventPattern,
  idp,
  invalid,
  key,
  memory,
  missing,
  objectKey,
  objectPublic,
  project,
  projectIdOf,
  projectKey,
  projectPattern,
  protectedAdministrator,
  repairPendingObject,
  s3,
  selectedSkills,
  storageState,
  unpack,
  uploadKey,
  uuid,
  uuidPattern,
};
const users = createUsers(context);
const connections = createConnections({ ...context, credentialStore });
const chat = createChat({ ...context, credentialStore });

const respond = (response, status, data) => {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(data));
};

createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/ping")
    return respond(response, 200, {
      status: runs.busy() ? "HealthyBusy" : "Healthy",
    });
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
    if (!(await currentIdentity(identity)))
      return respond(response, 200, {
        ok: false,
        error: {
          code: "SESSION_CHANGED",
          message: "Sign in again to refresh your access.",
        },
      });
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
    if (
      body?.v === 1 &&
      [
        "chat.start",
        "chat.send",
        "chat.status",
        "chat.watch",
        "chat.cancel",
      ].includes(body.command)
    ) {
      try {
        const input = body.input || {};
        if (body.command === "chat.watch")
          return await runs.watch(identity, input, response);
        if (body.command === "chat.status")
          return respond(response, 200, {
            ok: true,
            data: await runs.state(identity, input),
          });
        if (body.command === "chat.cancel")
          return respond(response, 200, {
            ok: true,
            data: await runs.cancel(identity, input),
          });
        const accepted = await runs.start(
          chat,
          input,
          identity,
          request.headers.workloadaccesstoken,
        );
        if (body.command === "chat.send")
          return await runs.watch(
            identity,
            { requestId: accepted.requestId },
            response,
            { untilTerminal: true },
          );
        return respond(response, 200, { ok: true, data: accepted });
      } catch (error) {
        if (response.headersSent) return response.end();
        if (!error.code) throw error;
        if (body.command === "chat.send") {
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
          });
          return response.end(
            `data: ${JSON.stringify({
              type: "error",
              code: error.code,
              message: "Turn was not accepted.",
            })}\n\n`,
          );
        }
        return respond(response, 200, {
          ok: false,
          error: { code: error.code },
        });
      }
    }
    const result = await invoke(body, identity);
    // AgentCore masks non-2xx Runtime responses as generic 424 errors.
    // Application failures use a stable JSON envelope over HTTP 200.
    respond(response, 200, result.data);
  } catch (error) {
    console.error(
      "Control failed",
      error.name,
      error.$metadata?.httpStatusCode || "",
    );
    respond(response, 200, {
      ok: false,
      error: {
        code: "INTERNAL",
        message: "Operation failed",
        ...(process.env.SCRIPTED_MODEL === "true" && {
          diagnostic: error.name,
        }),
      },
    });
  }
}).listen(Number(process.env.PORT || 8080), "0.0.0.0");
