// One AgentCore Runtime owns product control and the configured agent loop.
// AgentCore validates the Cognito JWT before forwarding its Authorization header.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { BedrockRuntimeClient, ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { scriptedStream } from "./scripted-model.js";
import { modelCost, periodKey } from "./accounting.js";
import suggestedModels from "./models.json" with { type: "json" };
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
  AdminCreateUserCommand,
  AdminAddUserToGroupCommand,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand,
  TransactWriteItemsCommand, UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  BedrockAgentCoreClient, CreateEventCommand, ListEventsCommand,
  GetResourceApiKeyCommand,
  StartCodeInterpreterSessionCommand, InvokeCodeInterpreterCommand,
  StopCodeInterpreterSessionCommand,
} from "@aws-sdk/client-bedrock-agentcore";

const idp = new CognitoIdentityProviderClient({});
const db = new DynamoDBClient({});
const memory = new BedrockAgentCoreClient({});
const bedrock = new BedrockRuntimeClient({});
const S = (value) => ({ S: String(value) });
const N = (value) => ({ N: String(value) });
const key = (pk, sk) => ({ pk: S(pk), sk: S(sk) });
const unpack = (item) =>
  Object.fromEntries(
    Object.entries(item || {}).map(([name, value]) => [
      name,
      value.S ?? (value.N === undefined ? value.BOOL : Number(value.N)),
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

async function defaults() {
  const row = await db.send(
    new UpdateItemCommand({
      TableName: process.env.TABLE,
      Key: key("ACCOUNT#CONTROL", "DEFAULTS"),
      UpdateExpression:
        "SET budgetMicroUsd = if_not_exists(budgetMicroUsd, :budget), storageBytes = if_not_exists(storageBytes, :storage), #period = if_not_exists(#period, :period), revision = if_not_exists(revision, :zero)",
      ExpressionAttributeNames: { "#period": "period" },
      ExpressionAttributeValues: {
        ":budget": N(process.env.BUDGET),
        ":storage": N(process.env.STORAGE),
        ":period": S("daily"),
        ":zero": N(0),
      },
      ReturnValues: "ALL_NEW",
    }),
  );
  return unpack(row.Attributes);
}

async function approvedModel(modelId) {
  if (modelId === "test.echo")
    return process.env.SCRIPTED_MODEL === "true" ? { id: modelId } : null;
  const model = suggestedModels.find((entry) => entry.id === modelId);
  return (model?.transport === "bedrock" ||
    (model?.transport === "gemini" && process.env.GEMINI_PROVIDER)) &&
    Number.isSafeInteger(model.inputRate) &&
    Number.isSafeInteger(model.outputRate) ? model : null;
}

async function listAgents(identity) {
  const page = await db.send(new QueryCommand({ TableName: process.env.TABLE,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": S(`PROJECT#${identity.sub}/main`), ":prefix": S("AGENT#") },
    Limit: 100 }));
  return (page.Items || []).map(unpack);
}

async function listConversations(identity, cursor) {
  let start;
  if (cursor) {
    try {
      if (typeof cursor !== "string" || cursor.length > 2000) throw Error();
      start = JSON.parse(Buffer.from(cursor, "base64url").toString());
      if (start.gsi1pk?.S !== `CONVERSATIONS#${identity.sub}/main` ||
        start.pk?.S !== `PROJECT#${identity.sub}/main` ||
        !/^CONVERSATION#[0-9a-f-]{36}$/i.test(start.sk?.S || "")) throw Error();
    } catch {
      return { status: 400, data: { ok: false, error: { code: "VALIDATION_FAILED" } } };
    }
  }
  const page = await db.send(new QueryCommand({
    TableName: process.env.TABLE, IndexName: "UsageByTime",
    KeyConditionExpression: "gsi1pk = :pk",
    ExpressionAttributeValues: { ":pk": S(`CONVERSATIONS#${identity.sub}/main`) },
    ExclusiveStartKey: start, Limit: 30, ScanIndexForward: false,
  }));
  return { status: 200, data: { ok: true, data: {
    items: (page.Items || []).map(unpack).filter((row) => row.expiresAt > Date.now() / 1000)
      .map(({ id, agentId, title, createdAt, lastActivityAt }) =>
        ({ id, agentId, title, createdAt, lastActivityAt })),
    nextCursor: page.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(page.LastEvaluatedKey)).toString("base64url") : null,
  } } };
}

async function getSession(identity) {
  const [user, limits] = await Promise.all([
    idp.send(new AdminGetUserCommand({ UserPoolId: process.env.POOL, Username: identity.sub })),
    defaults(),
  ]);
  const row = await db.send(new UpdateItemCommand({
    TableName: process.env.TABLE, Key: key(`USER#${identity.sub}`, "CONTROL"),
    UpdateExpression:
      "SET budgetMicroUsd = if_not_exists(budgetMicroUsd, :budget), storageBytes = if_not_exists(storageBytes, :storage)",
    ExpressionAttributeValues: { ":budget": N(limits.budgetMicroUsd), ":storage": N(limits.storageBytes) },
    ReturnValues: "ALL_NEW",
  }));
  return {
    user: {
      sub: identity.sub,
      email: user.UserAttributes?.find((attribute) => attribute.Name === "email")?.Value || "",
      role: identity.role,
      budgetMicroUsd: Number(row.Attributes.budgetMicroUsd.N),
      storageBytes: Number(row.Attributes.storageBytes.N),
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
  if (body.command === "agents.list") {
    if (body.input.projectId !== "main")
      return { status: 400, data: { ok: false, error: { code: "VALIDATION_FAILED" } } };
    return { status: 200, data: { ok: true, data: { items: await listAgents(identity) } } };
  }
  if (body.command === "workspace.get") {
    if (Object.keys(body.input).length)
      return { status: 400, data: { ok: false, error: { code: "VALIDATION_FAILED" } } };
    const [session, agents, conversations] = await Promise.all([
      getSession(identity), listAgents(identity), listConversations(identity),
    ]);
    return { status: 200, data: { ok: true,
      data: { session, agents, conversations: conversations.data.data } } };
  }
  if (body.command === "conversations.list") {
    if (body.input.projectId !== "main")
      return { status: 400, data: { ok: false, error: { code: "VALIDATION_FAILED" } } };
    return listConversations(identity, body.input.cursor);
  }
  if (body.command === "conversations.get") {
    const { projectId, agentId, conversationId, cursor } = body.input;
    const uuid = /^[0-9a-f-]{36}$/i;
    if (projectId !== "main" || !uuid.test(agentId || "") ||
      !uuid.test(conversationId || "") ||
      (cursor !== undefined && (typeof cursor !== "string" || cursor.length > 4000)))
      return { status: 400, data: { ok: false, error: { code: "VALIDATION_FAILED" } } };
    const row = await db.send(new GetItemCommand({ TableName: process.env.TABLE,
      Key: key(`PROJECT#${identity.sub}/main`, `CONVERSATION#${conversationId}`),
      ConsistentRead: true }));
    if (!row.Item || row.Item.agentId?.S !== agentId ||
      Number(row.Item.expiresAt?.N || 0) <= Date.now() / 1000)
      return { status: 404, data: { ok: false, error: { code: "NOT_FOUND" } } };
    const page = await memory.send(new ListEventsCommand({
      memoryId: process.env.MEMORY, actorId: `${identity.sub}/main`,
      sessionId: `a_${agentId}_${conversationId}`,
      includePayloads: true, maxResults: 100, nextToken: cursor,
    }));
    return { status: 200, data: { ok: true, data: {
      conversation: unpack(row.Item),
      messages: (page.events || []).toReversed().flatMap((event) =>
        (event.payload || []).flatMap((payload) => {
          const entry = payload.conversational;
          return entry?.content?.text && ["USER", "ASSISTANT"].includes(entry.role)
            ? [{ role: entry.role.toLowerCase(), text: entry.content.text, status: "complete" }]
            : [];
        })),
      nextCursor: page.nextToken || null,
    } } };
  }
  if (body.command === "agents.put") {
    if (identity.role === "Auditors")
      return { status: 403, data: { ok: false, error: { code: "FORBIDDEN" } } };
    const { projectId, name, modelId, systemPrompt = "", codeInterpreter = false,
      maxOutputTokens = 4096 } = body.input;
    if (projectId !== "main" || typeof name !== "string" || !name.trim() || name.length > 80 ||
      typeof modelId !== "string" || !modelId || modelId.length > 512 ||
      typeof systemPrompt !== "string" || systemPrompt.length > 12000 ||
      typeof codeInterpreter !== "boolean" ||
      !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 16 || maxOutputTokens > 4096)
      return { status: 400, data: { ok: false, error: { code: "VALIDATION_FAILED" } } };
    const model = await approvedModel(modelId);
    if (!model)
      return { status: 400, data: { ok: false, error: { code: "MODEL_UNAVAILABLE" } } };
    if (model.transport === "gemini" && codeInterpreter)
      return { status: 400, data: { ok: false, error: { code: "TOOL_UNAVAILABLE" } } };
    const id = randomUUID();
    const agent = { id, name: name.trim(), modelId, systemPrompt,
      codeInterpreter, maxOutputTokens, createdAt: new Date().toISOString() };
    await db.send(new PutItemCommand({ TableName: process.env.TABLE,
      Item: { pk: S(`PROJECT#${identity.sub}/main`), sk: S(`AGENT#${id}`),
        id: S(id), name: S(agent.name), modelId: S(modelId),
        systemPrompt: S(systemPrompt), codeInterpreter: { BOOL: codeInterpreter },
        maxOutputTokens: N(maxOutputTokens),
        createdAt: S(agent.createdAt) },
      ConditionExpression: "attribute_not_exists(pk)" }));
    return { status: 200, data: { ok: true, data: agent } };
  }
  if (body.command === "usage.get") {
    // Compose two independent, authorized reads inside one Runtime invocation.
    const [summary, detail] = await Promise.all([
      invoke({ v: 1, command: "usage.summary", input: {} }, identity),
      invoke({ v: 1, command: "usage.list", input: body.input }, identity),
    ]);
    if (summary.status !== 200) return summary;
    if (detail.status !== 200) return detail;
    return { status: 200, data: { ok: true,
      data: { ...summary.data.data, ...detail.data.data } } };
  }
  if (body.command === "usage.summary") {
    const limits = await defaults();
    const period = periodKey(limits.period);
    const row = await db.send(new GetItemCommand({ TableName: process.env.TABLE,
      Key: key(`USER#${identity.sub}`, period), ConsistentRead: true }));
    return { status: 200, data: { ok: true, data: { period,
      costMicroUsd: Number(row.Item?.costMicroUsd?.N || 0),
      unpricedToolCalls: Number(row.Item?.unpricedToolCalls?.N || 0),
      quality: Number(row.Item?.unpricedToolCalls?.N || 0) ? "partial" :
        Number(row.Item?.estimatedModelCalls?.N || 0) ? "estimated" : "model-only" } } };
  }
  if (body.command === "usage.list") {
    const { range = "30d", sort = "desc", scope = "self", cursor } = body.input;
    const target = body.input.userSub || identity.sub;
    if (!["30d", "90d"].includes(range) || !["asc", "desc"].includes(sort) ||
      !["self", "all"].includes(scope) || (scope === "all" && identity.role !== "Administrators"))
      return { status: 400, data: { ok: false, error: { code: "VALIDATION_FAILED" } } };
    if (target !== identity.sub && identity.role !== "Administrators")
      return { status: 403, data: { ok: false, error: { code: "FORBIDDEN" } } };
    if (!/^[0-9a-f-]{36}$/i.test(target))
      return { status: 400, data: { ok: false, error: { code: "VALIDATION_FAILED" } } };
    const since = new Date(Date.now() - (range === "90d" ? 90 : 30) * 86400000).toISOString();
    let start;
    if (cursor) {
      try {
        if (typeof cursor !== "string" || cursor.length > 2000) throw Error();
        start = JSON.parse(Buffer.from(cursor, "base64url").toString());
        if (!/^USER#[0-9a-f-]{36}$/i.test(start.pk?.S || "") ||
          (scope === "self" && start.pk.S !== `USER#${target}`) ||
          !start.sk?.S?.startsWith("USAGE#") ||
          (scope === "all" && start.gsi1pk?.S !== "USAGE")) throw Error();
      } catch {
        return { status: 400, data: { ok: false, error: { code: "VALIDATION_FAILED" } } };
      }
    }
    const page = await db.send(new QueryCommand({ TableName: process.env.TABLE,
      ...(scope === "all" && { IndexName: "UsageByTime" }),
      KeyConditionExpression: scope === "all"
        ? "gsi1pk = :pk AND gsi1sk BETWEEN :from AND :to"
        : "pk = :pk AND sk BETWEEN :from AND :to",
      ExpressionAttributeValues: {
        ":pk": S(scope === "all" ? "USAGE" : `USER#${target}`),
        ":from": S(`${scope === "all" ? "" : "USAGE#"}${since}`),
        ":to": S(`${scope === "all" ? "" : "USAGE#"}${new Date().toISOString()}~`),
      },
      ExclusiveStartKey: start, Limit: 50, ScanIndexForward: sort === "asc",
      ...(scope === "self" && { ConsistentRead: true }) }));
    return { status: 200, data: { ok: true, data: { range, sort, scope,
      items: (page.Items || []).map(unpack),
      nextCursor: page.LastEvaluatedKey
        ? Buffer.from(JSON.stringify(page.LastEvaluatedKey)).toString("base64url") : null } } };
  }
  if (body.command === "models.list") {
    const items = suggestedModels.map((model) =>
      ({ ...model, active: model.transport === "bedrock" ||
        (model.transport === "gemini" && Boolean(process.env.GEMINI_PROVIDER)) }));
    if (process.env.SCRIPTED_MODEL === "true")
      items.unshift({ id: "test.echo", name: "Scripted echo (test only)", active: true });
    return { status: 200, data: { ok: true, data: { items } } };
  }
  const admin = identity.role === "Administrators";
  if (["users.list", "users.invite", "users.setLimits", "defaults.get", "defaults.set"].includes(body.command) && !admin)
    return { status: 403, data: { ok: false, error: { code: "FORBIDDEN" } } };
  if (body.command === "users.list") {
    const page = await idp.send(new ListUsersCommand({ UserPoolId: process.env.POOL,
      Limit: 20, PaginationToken: body.input.cursor || undefined }));
    const limits = await defaults();
    const items = await Promise.all(page.Users.map(async (user) => {
      const sub = user.Attributes?.find((attribute) => attribute.Name === "sub")?.Value;
      const row = await db.send(new GetItemCommand({ TableName: process.env.TABLE,
        Key: key(`USER#${sub}`, "CONTROL") }));
      return { sub, email: user.Attributes?.find((attribute) => attribute.Name === "email")?.Value,
        enabled: user.Enabled, status: user.UserStatus,
        budgetMicroUsd: Number(row.Item?.budgetMicroUsd?.N || limits.budgetMicroUsd),
        storageBytes: Number(row.Item?.storageBytes?.N || limits.storageBytes) };
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
    const { sub, budgetMicroUsd, storageBytes } = body.input;
    if (!/^[0-9a-f-]{36}$/i.test(sub || "") ||
      !Number.isSafeInteger(budgetMicroUsd) || budgetMicroUsd < 0 ||
      !Number.isSafeInteger(storageBytes) || storageBytes < 0)
      return { status: 400, data: { ok: false, error: { code: "VALIDATION_FAILED" } } };
    await idp.send(new AdminGetUserCommand({ UserPoolId: process.env.POOL, Username: sub }));
    await db.send(new UpdateItemCommand({ TableName: process.env.TABLE,
      Key: key(`USER#${sub}`, "CONTROL"),
      UpdateExpression: "SET budgetMicroUsd = :budget, storageBytes = :storage",
      ExpressionAttributeValues: { ":budget": N(budgetMicroUsd), ":storage": N(storageBytes) } }));
    return { status: 200, data: { ok: true, data: { updated: true } } };
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

async function runGemini(config, messages, emit, workloadToken) {
  if (!workloadToken) throw Error("Missing runtime workload token");
  const { apiKey } = await memory.send(new GetResourceApiKeyCommand({
    resourceCredentialProviderName: process.env.GEMINI_PROVIDER,
    workloadIdentityToken: workloadToken,
  }));
  const body = {
    contents: messages.map(({ role, content }) => ({
      role: role === "assistant" ? "model" : "user",
      parts: content.map(({ text }) => ({ text })),
    })),
    ...(config.systemPrompt && { systemInstruction: { parts: [{ text: config.systemPrompt }] } }),
    generationConfig: { maxOutputTokens: config.maxOutputTokens || 4096,
      ...(config.maxOutputTokens < 256 && { thinkingConfig: { thinkingLevel: "low" } }) },
  };
  const reply = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.modelId)}:streamGenerateContent?alt=sse`,
    { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body), signal: AbortSignal.timeout(120000) },
  );
  if (!reply.ok) {
    const error = Error(`Gemini HTTP ${reply.status}`);
    error.name = "GeminiHttpError";
    throw error;
  }
  if (!reply.body) throw Error("Gemini response had no stream");
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let reported;
  for await (const chunk of reply.body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r/g, "");
    if (buffer.length > 1048576) throw Error("Gemini event exceeded limit");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame.split("\n").filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6)).join("\n");
      if (!data) continue;
      const event = JSON.parse(data);
      for (const part of event.candidates?.[0]?.content?.parts || []) {
        if (part.text && !part.thought) {
          text += part.text;
          emit({ type: "message.delta", text: part.text });
        }
      }
      if (event.usageMetadata) reported = event.usageMetadata;
    }
  }
  if (buffer.trim()) throw Error("Gemini stream ended mid-event");
  if (!reported) throw Error("Gemini did not report token usage");
  if (!text) {
    text = "The model reached its output limit before producing a visible reply.";
    emit({ type: "message.delta", text });
  }
  const inputTokens = reported.promptTokenCount || 0;
  const cacheReadInputTokens = reported.cachedContentTokenCount || 0;
  const outputTokens = (reported.candidatesTokenCount || 0) +
    (reported.thoughtsTokenCount || 0);
  if (cacheReadInputTokens > inputTokens) throw Error("Invalid Gemini cache meter");
  return { text, usage: {
    inputTokens: inputTokens - cacheReadInputTokens, outputTokens,
    totalTokens: reported.totalTokenCount || inputTokens + outputTokens,
    cacheReadInputTokens, cacheWriteInputTokens: 0,
  }, toolCalls: [] };
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
  const variables = {
    AGENTCORE_USER_ID: scope.sub,
    AGENTCORE_PROJECT_ID: scope.projectId,
    AGENTCORE_AGENT_ID: scope.agentId,
    AGENTCORE_CHAT_ID: scope.sessionId,
    AWS_REGION: process.env.AWS_REGION,
    AWS_DEFAULT_REGION: process.env.AWS_REGION,
  };
  // These are derived identifiers only. Credential values need a separately
  // audited serializer and an explicit user grant before they may be added.
  const contents = Object.entries(variables).map(([name, value]) => {
    if (!/^[A-Za-z0-9._:/-]+$/.test(value || "")) throw Error("Invalid workspace context");
    return `${name}=${value}`;
  }).join("\n") + "\n";
  const written = await interpreterCall(sessionId, "writeFiles", {
    content: [{ path: ".env", text: contents }],
  });
  if (written.isError) throw Error("Could not initialize code workspace");
  const cwd = await interpreterCall(sessionId, "executeCommand", { command: "pwd" });
  const path = cwd.output.trim().split(/\r?\n/)[0];
  if (cwd.isError || !/^\/[A-Za-z0-9._/-]+$/.test(path))
    throw Error("Could not locate code workspace");
  return `${path}/.env`;
}

async function runModel(config, messages, emit, workloadToken, scope) {
  if (config.modelId === "gemini-3.8-flash")
    return runGemini(config, messages, emit, workloadToken);
  const toolConfig = config.codeInterpreter ? { tools: [
    { toolSpec: {
      name: "execute_code",
      description: "Run Python, JavaScript, or TypeScript in an isolated public-network workspace. Session .env is loaded automatically.",
      inputSchema: { json: { type: "object", properties: {
        language: { type: "string", enum: ["python", "javascript", "typescript"] },
        code: { type: "string" },
      }, required: ["language", "code"] } },
    } },
    { toolSpec: {
      name: "execute_command",
      description: "Run a shell command in that workspace, with session .env loaded. Python, Node, curl, AWS CLI, pip and npm are installed; install other tools only when needed. Commands are capped at 120 seconds.",
      inputSchema: { json: { type: "object", properties: {
        command: { type: "string" },
      }, required: ["command"] } },
    } },
  ] } : undefined;
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0,
    cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };
  const toolCalls = [];
  let toolSession;
  let envPath;
  try {
    for (let turn = 0; turn < 8; turn++) {
      const stream = config.modelId === "test.echo"
        ? scriptedStream(messages)
        : (await bedrock.send(new ConverseStreamCommand({
            modelId: config.modelId, messages,
            system: config.systemPrompt || toolConfig ? [{ text: [
              config.systemPrompt,
              toolConfig ? "Use the code workspace to inspect, run and revise work. Prefer installed Python requests/boto3 and native HTTPS APIs before installing packages. Do not print session secrets; code with granted credentials can read and transmit them." : "",
            ].filter(Boolean).join("\n\n") }] : undefined,
            inferenceConfig: { maxTokens: config.maxOutputTokens || 4096 }, toolConfig,
          }))).stream;
      const content = [];
      let stopReason;
      let metered = false;
      for await (const event of stream) {
        if (event.contentBlockStart?.start?.toolUse) {
          const { contentBlockIndex, start } = event.contentBlockStart;
          content[contentBlockIndex] = { toolUse: { ...start.toolUse, input: "" } };
        }
        if (event.contentBlockDelta) {
          const { contentBlockIndex, delta } = event.contentBlockDelta;
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
          for (const name of Object.keys(usage)) usage[name] += event.metadata.usage[name] || 0;
        }
      }
      if (!metered) throw Error("Model did not report token usage");
      if (stopReason === "end_turn")
        return { text: content.map((part) => part?.text || "").join(""), usage, toolCalls };
      if (stopReason !== "tool_use" || !toolConfig) throw Error("Unsupported model stop reason");
      const requested = content.filter((part) => part?.toolUse).map((part) => part.toolUse);
      if (!requested.length) throw Error("Tool turn had no tool requests");
      messages.push({ role: "assistant", content });
      const results = [];
      for (const tool of requested) {
        if (toolCalls.length >= 8) throw Error("Agent tool call limit reached");
        const isCode = tool.name === "execute_code" &&
          ["python", "javascript", "typescript"].includes(tool.input?.language) &&
          typeof tool.input.code === "string" && tool.input.code.length <= 20000;
        const isCommand = tool.name === "execute_command" &&
          typeof tool.input?.command === "string" && tool.input.command.length <= 20000;
        if (!isCode && !isCommand)
          throw Error("Invalid tool request");
        if (!toolSession) {
          if (!process.env.CODE_INTERPRETER_ID) throw Error("Code workspace unavailable");
          toolSession = (await memory.send(new StartCodeInterpreterSessionCommand({
            codeInterpreterIdentifier: process.env.CODE_INTERPRETER_ID,
            name: `chat-${randomUUID().slice(0, 8)}`, sessionTimeoutSeconds: 900,
          }))).sessionId;
          envPath = await initializeWorkspace(toolSession, scope);
        }
        const started = Date.now();
        const args = isCode ? {
          language: tool.input.language,
          runtime: tool.input.language === "python" ? "python" : "nodejs",
          code: tool.input.language === "python"
            ? `from dotenv import load_dotenv\nload_dotenv(${JSON.stringify(envPath)}, override=True)\n${tool.input.code}`
            : `process.loadEnvFile(${JSON.stringify(envPath)});\n${tool.input.code}`,
        } : { command: `set -a; . ${shellQuote(envPath)}; set +a; timeout 120s sh -lc ${shellQuote(tool.input.command)}` };
        const { output, isError } = await interpreterCall(toolSession,
          isCode ? "executeCode" : "executeCommand", args);
        toolCalls.push({ name: tool.name, latencyMs: Date.now() - started,
          occurredAt: new Date().toISOString(), isError });
        emit({ type: "tool.done", name: tool.name, isError });
        results.push({ toolResult: { toolUseId: tool.toolUseId,
          content: [{ text: output || "(no output)" }], status: isError ? "error" : "success" } });
      }
      messages.push({ role: "user", content: results });
    }
    throw Error("Agent turn limit reached");
  } finally {
    if (toolSession) await memory.send(new StopCodeInterpreterSessionCommand({
      codeInterpreterIdentifier: process.env.CODE_INTERPRETER_ID, sessionId: toolSession,
    })).catch(() => console.error("Could not stop Code Interpreter session"));
  }
}

async function chat(input, identity, response, workloadToken) {
  const { projectId, agentId, sessionId, requestId, message } = input;
  const uuid = /^[0-9a-f-]{36}$/i;
  if (projectId !== "main" || !uuid.test(agentId || "") ||
    !uuid.test(sessionId || "") || !uuid.test(requestId || "") ||
    typeof message !== "string" || !message.trim() || message.length > 20000)
    return respond(response, 400, { ok: false, error: { code: "VALIDATION_FAILED" } });
  if (identity.role === "Auditors")
    return respond(response, 403, { ok: false, error: { code: "FORBIDDEN" } });
  const [row, defaultsRow, prior, user] = await Promise.all([
    db.send(new GetItemCommand({ TableName: process.env.TABLE,
      Key: key(`PROJECT#${identity.sub}/main`, `AGENT#${agentId}`), ConsistentRead: true })),
    defaults(),
    db.send(new GetItemCommand({ TableName: process.env.TABLE,
      Key: key(`USER#${identity.sub}`, `REQUEST#${requestId}`), ConsistentRead: true })),
    db.send(new GetItemCommand({ TableName: process.env.TABLE,
      Key: key(`USER#${identity.sub}`, "CONTROL"), ConsistentRead: true })),
  ]);
  if (!row.Item)
    return respond(response, 404, { ok: false, error: { code: "NOT_FOUND" } });
  const config = unpack(row.Item);
  if (prior.Item)
    return respond(response, 409, { ok: false, error: { code: "REQUEST_ALREADY_COMPLETED" } });
  const period = periodKey(defaultsRow.period);
  const [model, spent] = await Promise.all([
    approvedModel(config.modelId),
    db.send(new GetItemCommand({ TableName: process.env.TABLE,
      Key: key(`USER#${identity.sub}`, period), ConsistentRead: true })),
  ]);
  if (!model)
    return respond(response, 403, { ok: false, error: { code: "MODEL_UNAVAILABLE" } });
  const limit = Number(user.Item?.budgetMicroUsd?.N ?? defaultsRow.budgetMicroUsd);
  if (Number(spent.Item?.costMicroUsd?.N || 0) >= limit)
    return respond(response, 403, { ok: false, error: { code: "BUDGET_EXHAUSTED" } });
  const actorId = `${identity.sub}/main`;
  const memorySessionId = `a_${agentId}_${sessionId}`;
  const history = await memory.send(new ListEventsCommand({
    memoryId: process.env.MEMORY, actorId, sessionId: memorySessionId,
    includePayloads: true, maxResults: 20 }));
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
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  const emit = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
  const started = Date.now();
  try {
    const result = await runModel(config, messages, emit, workloadToken,
      { sub: identity.sub, projectId, agentId, sessionId });
    const costMicroUsd = modelCost(result.usage, model);
    const occurredAt = new Date().toISOString();
    const receipt = { version: 1, requestId, agentId, conversationId: sessionId,
      modelId: config.modelId, occurredAt, usage: result.usage, costMicroUsd,
      rates: { inputRate: model.inputRate || 0, outputRate: model.outputRate || 0,
        cacheReadRate: model.cacheReadRate || 0, cacheWriteRate: model.cacheWriteRate || 0 },
      pricingQuality: model.pricingQuality || "unknown",
      toolCalls: result.toolCalls.map(({ name, occurredAt, latencyMs, isError }) =>
        ({ name, occurredAt, latencyMs, isError })) };
    await memory.send(new CreateEventCommand({
      memoryId: process.env.MEMORY, actorId, sessionId: memorySessionId,
      eventTimestamp: new Date(), clientToken: requestId, extractionMode: "SKIP",
      payload: [
        { conversational: { role: "USER", content: { text: message } } },
        { conversational: { role: "ASSISTANT", content: { text: result.text } } },
        { json: { content: receipt } },
      ] }));
    await db.send(new TransactWriteItemsCommand({ TransactItems: [
      { Put: { TableName: process.env.TABLE,
        Item: { pk: S(`USER#${identity.sub}`), sk: S(`REQUEST#${requestId}`),
          expiresAt: N(Math.floor(Date.now() / 1000) + 30 * 86400) },
        ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: process.env.TABLE,
        Item: { pk: S(`USER#${identity.sub}`), sk: S(`USAGE#${occurredAt}#${requestId}`),
          gsi1pk: S("USAGE"), gsi1sk: S(`${occurredAt}#${identity.sub}#${requestId}`),
          occurredAt: S(occurredAt), userSub: S(identity.sub), requestId: S(requestId),
          agentId: S(agentId), modelId: S(config.modelId), costMicroUsd: N(costMicroUsd),
          inputTokens: N(result.usage.inputTokens), outputTokens: N(result.usage.outputTokens),
          cacheReadInputTokens: N(result.usage.cacheReadInputTokens || 0),
          cacheWriteInputTokens: N(result.usage.cacheWriteInputTokens || 0),
          inputRate: N(model.inputRate || 0), outputRate: N(model.outputRate || 0),
          cacheReadRate: N(model.cacheReadRate || 0), cacheWriteRate: N(model.cacheWriteRate || 0),
          pricingSource: S(model.pricingSource || ""), pricingQuality: S(model.pricingQuality || "unknown"),
          quality: S("estimated"),
          toolCalls: N(result.toolCalls.length),
          unpricedToolCalls: N(result.toolCalls.length),
          latencyMs: N(Date.now() - started) },
        ConditionExpression: "attribute_not_exists(pk)" } },
      { Update: { TableName: process.env.TABLE, Key: key(`USER#${identity.sub}`, period),
        UpdateExpression: "ADD costMicroUsd :cost, unpricedToolCalls :tools, estimatedModelCalls :one",
        ExpressionAttributeValues: { ":cost": N(costMicroUsd), ":tools": N(result.toolCalls.length),
          ":one": N(1) } } },
      { Update: { TableName: process.env.TABLE,
        Key: key(`PROJECT#${identity.sub}/main`, `CONVERSATION#${sessionId}`),
        UpdateExpression: "SET id = :id, agentId = :agent, title = if_not_exists(title, :title), createdAt = if_not_exists(createdAt, :time), lastActivityAt = :time, gsi1pk = :index, gsi1sk = :sort, expiresAt = :expiry",
        ExpressionAttributeValues: {
          ":id": S(sessionId), ":agent": S(agentId),
          ":title": S(message.trim().replace(/\s+/g, " ").slice(0, 80)),
          ":time": S(occurredAt), ":index": S(`CONVERSATIONS#${identity.sub}/main`),
          ":sort": S(`${occurredAt}#${sessionId}`),
          ":expiry": N(Math.floor(Date.now() / 1000) + 30 * 86400),
        } } },
      ...result.toolCalls.map((tool, index) => ({ Put: { TableName: process.env.TABLE,
        Item: { pk: S(`USER#${identity.sub}`),
          sk: S(`USAGE#${tool.occurredAt}#${requestId}#TOOL#${index}`),
          gsi1pk: S("USAGE"), gsi1sk: S(`${tool.occurredAt}#${identity.sub}#${requestId}#TOOL#${index}`),
          occurredAt: S(tool.occurredAt), userSub: S(identity.sub), requestId: S(requestId),
          agentId: S(agentId), name: S(tool.name), costMicroUsd: N(0),
          latencyMs: N(tool.latencyMs), isError: { BOOL: tool.isError },
          quality: S("unpriced") },
        ConditionExpression: "attribute_not_exists(pk)" } })),
    ] }));
    emit({ type: "message.done", requestId, conversationId: sessionId,
      usage: result.usage, costMicroUsd,
      unpricedToolCalls: result.toolCalls.length, latencyMs: Date.now() - started });
  } catch (error) {
    console.error("Chat failed", error.name, error.$metadata?.httpStatusCode || "");
    const message = error.name === "AccessDeniedException"
      ? "Model access denied. An AWS administrator may need to enable its Marketplace agreement or Runtime role."
      : error.name === "ThrottlingException"
        ? "The model is busy. Please try again."
        : "Agent turn failed";
    emit({ type: "error", message,
      ...(process.env.SCRIPTED_MODEL === "true" && {
        diagnostic: error.name, detail: error.message?.slice(0, 300) }) });
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
    respond(response, result.status, result.data);
  } catch {
    respond(response, 500, {
      ok: false,
      error: { code: "INTERNAL", message: "Operation failed" },
    });
  }
}).listen(Number(process.env.PORT || 8080), "0.0.0.0");
