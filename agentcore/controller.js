// One AgentCore Runtime owns product control and the configured agent loop.
// AgentCore validates the Cognito JWT before forwarding its Authorization header.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { BedrockRuntimeClient, ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { scriptedStream } from "./scripted-model.js";
import { modelCost, periodKey } from "./accounting.js";
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
  const row = await db.send(new GetItemCommand({ TableName: process.env.TABLE,
    Key: key("MODEL", modelId), ConsistentRead: true }));
  const model = unpack(row.Item);
  return model.active === true && Number.isSafeInteger(model.inputRate) &&
    Number.isSafeInteger(model.outputRate) ? model : null;
}

async function listAgents(identity) {
  const page = await db.send(new QueryCommand({ TableName: process.env.TABLE,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": S(`PROJECT#${identity.sub}/main`), ":prefix": S("AGENT#") },
    Limit: 100 }));
  return (page.Items || []).map(unpack);
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
    const [session, agents] = await Promise.all([getSession(identity), listAgents(identity)]);
    return { status: 200, data: { ok: true, data: { session, agents } } };
  }
  if (body.command === "agents.put") {
    if (identity.role === "Auditors")
      return { status: 403, data: { ok: false, error: { code: "FORBIDDEN" } } };
    const { projectId, name, modelId, systemPrompt = "", codeInterpreter = false } = body.input;
    if (projectId !== "main" || typeof name !== "string" || !name.trim() || name.length > 80 ||
      !/^[a-zA-Z0-9._/-]{1,120}$/.test(modelId || "") ||
      typeof systemPrompt !== "string" || systemPrompt.length > 12000 ||
      typeof codeInterpreter !== "boolean")
      return { status: 400, data: { ok: false, error: { code: "VALIDATION_FAILED" } } };
    if (!(await approvedModel(modelId)))
      return { status: 400, data: { ok: false, error: { code: "MODEL_UNAVAILABLE" } } };
    const id = randomUUID();
    const agent = { id, name: name.trim(), modelId, systemPrompt,
      codeInterpreter, createdAt: new Date().toISOString() };
    await db.send(new PutItemCommand({ TableName: process.env.TABLE,
      Item: { pk: S(`PROJECT#${identity.sub}/main`), sk: S(`AGENT#${id}`),
        id: S(id), name: S(agent.name), modelId: S(modelId),
        systemPrompt: S(systemPrompt), codeInterpreter: { BOOL: codeInterpreter },
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
      quality: Number(row.Item?.unpricedToolCalls?.N || 0) ? "partial" : "model-only" } } };
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
    const page = await db.send(new QueryCommand({ TableName: process.env.TABLE,
      KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": S("MODEL") },
      Limit: 100 }));
    const items = page.Items.map(unpack);
    if (process.env.SCRIPTED_MODEL === "true")
      items.unshift({ id: "test.echo", name: "Scripted echo (test only)", active: true });
    return { status: 200, data: { ok: true, data: { items } } };
  }
  const admin = identity.role === "Administrators";
  if (["users.list", "users.invite", "users.setLimits", "defaults.get", "defaults.set", "models.put"].includes(body.command) && !admin)
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
  if (body.command === "models.put") {
    const { id, name, inputRate, outputRate, cacheReadRate, cacheWriteRate } = body.input;
    if (!/^[a-zA-Z0-9._/-]{1,120}$/.test(id || "") || id === "test.echo" ||
      typeof name !== "string" || !name.trim() || name.length > 80 ||
      ![inputRate, outputRate, cacheReadRate, cacheWriteRate].every((rate) => Number.isSafeInteger(rate) && rate >= 0))
      return { status: 400, data: { ok: false, error: { code: "VALIDATION_FAILED" } } };
    await db.send(new PutItemCommand({ TableName: process.env.TABLE,
      Item: { pk: S("MODEL"), sk: S(id), id: S(id), name: S(name.trim()), active: { BOOL: true },
        inputRate: N(inputRate), outputRate: N(outputRate),
        cacheReadRate: N(cacheReadRate), cacheWriteRate: N(cacheWriteRate) } }));
    return { status: 200, data: { ok: true, data: { updated: true } } };
  }
  if (body.command !== "session.get" || Object.keys(body.input).length)
    return { status: 501, data: { ok: false, error: { code: "NOT_IMPLEMENTED" } } };
  return { status: 200, data: { ok: true, data: await getSession(identity) } };
}

async function runModel(config, messages, emit) {
  const toolConfig = config.codeInterpreter ? { tools: [{ toolSpec: {
    name: "execute_code",
    description: "Execute Python, JavaScript, or TypeScript in an isolated managed Code Interpreter.",
    inputSchema: { json: { type: "object", properties: {
      language: { type: "string", enum: ["python", "javascript", "typescript"] },
      code: { type: "string" },
    }, required: ["language", "code"] } },
  } }] } : undefined;
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0,
    cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };
  const toolCalls = [];
  let toolSession;
  try {
    for (let turn = 0; turn < 8; turn++) {
      const stream = config.modelId === "test.echo"
        ? scriptedStream(messages)
        : (await bedrock.send(new ConverseStreamCommand({
            modelId: config.modelId, messages,
            system: config.systemPrompt ? [{ text: config.systemPrompt }] : undefined,
            inferenceConfig: { maxTokens: 4096 }, toolConfig,
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
        if (tool.name !== "execute_code" ||
          !["python", "javascript", "typescript"].includes(tool.input?.language) ||
          typeof tool.input.code !== "string" || tool.input.code.length > 20000)
          throw Error("Invalid tool request");
        if (!toolSession) toolSession = (await memory.send(new StartCodeInterpreterSessionCommand({
          codeInterpreterIdentifier: "aws.codeinterpreter.v1",
          name: `chat-${randomUUID().slice(0, 8)}`, sessionTimeoutSeconds: 900,
        }))).sessionId;
        const started = Date.now();
        const answer = await memory.send(new InvokeCodeInterpreterCommand({
          codeInterpreterIdentifier: "aws.codeinterpreter.v1", sessionId: toolSession,
          name: "executeCode", arguments: { language: tool.input.language, code: tool.input.code },
        }));
        let output = "";
        let isError = false;
        for await (const event of answer.stream) {
          if (event.result) {
            output += event.result.structuredContent?.stdout || "";
            output += event.result.structuredContent?.stderr || "";
            output += (event.result.content || []).filter((part) => part.type === "text")
              .map((part) => part.text).join("\n");
            isError ||= event.result.isError === true;
          }
        }
        output = output.slice(0, 8000);
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
      codeInterpreterIdentifier: "aws.codeinterpreter.v1", sessionId: toolSession,
    })).catch(() => console.error("Could not stop Code Interpreter session"));
  }
}

async function chat(input, identity, response) {
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
    const result = await runModel(config, messages, emit);
    const costMicroUsd = modelCost(result.usage, model);
    const occurredAt = new Date().toISOString();
    await memory.send(new CreateEventCommand({
      memoryId: process.env.MEMORY, actorId, sessionId: memorySessionId,
      eventTimestamp: new Date(), clientToken: requestId, extractionMode: "SKIP",
      payload: [
        { conversational: { role: "USER", content: { text: message } } },
        { conversational: { role: "ASSISTANT", content: { text: result.text } } },
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
          toolCalls: N(result.toolCalls.length),
          unpricedToolCalls: N(result.toolCalls.length),
          latencyMs: N(Date.now() - started) },
        ConditionExpression: "attribute_not_exists(pk)" } },
      { Update: { TableName: process.env.TABLE, Key: key(`USER#${identity.sub}`, period),
        UpdateExpression: "ADD costMicroUsd :cost, unpricedToolCalls :tools",
        ExpressionAttributeValues: { ":cost": N(costMicroUsd), ":tools": N(result.toolCalls.length) } } },
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
    emit({ type: "message.done", usage: result.usage, costMicroUsd,
      unpricedToolCalls: result.toolCalls.length, latencyMs: Date.now() - started });
  } catch (error) {
    console.error("Chat failed", error.name, error.$metadata?.httpStatusCode || "");
    emit({ type: "error", message: "Agent turn failed",
      ...(process.env.SCRIPTED_MODEL === "true" && { diagnostic: error.name }) });
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
      return await chat(body.input || {}, identity, response);
    const result = await invoke(body, identity);
    respond(response, result.status, result.data);
  } catch {
    respond(response, 500, {
      ok: false,
      error: { code: "INTERNAL", message: "Operation failed" },
    });
  }
}).listen(Number(process.env.PORT || 8080), "0.0.0.0");
