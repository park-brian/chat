// One chat turn: validate and admit it, run the model loop with the agent's
// tools, then save the turn. Saving writes the turn body to S3 and commits the
// turn row, the branch head, the conversation, the request and the run's
// release in one transaction; a stale branch head rejects the whole turn.
import { PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { GetResourceApiKeyCommand } from "@aws-sdk/client-bedrock-agentcore";
import { periodKey } from "./accounting.js";
import { agentcore, bedrock, s3 } from "./aws.js";
import { limits } from "./accounts.js";
import { agentKey } from "./agents.js";
import { connectionsOf } from "./credentials.js";
import {
  branchKey,
  chatKey,
  pathTo,
  turnKey,
  turnLocation,
} from "./conversations.js";
import {
  chatIndex,
  conditionFailed,
  expression,
  fail,
  get,
  pack,
  patterns,
  sk,
  transact,
  turnId as newTurnId,
  userKey,
} from "./db.js";
import {
  geminiFunctionResult,
  geminiRequest,
  geminiStepCalls,
  readGeminiStream,
} from "./gemini-protocol.js";
import { createMeter, emptyUsage, estimateUsage } from "./meter.js";
import { approvedModel, thinkingLevelFor } from "./models.js";
import { skillTexts, turnFiles } from "./objects.js";
import { projectOf } from "./projects.js";
import { releaseOps } from "./runs.js";
import { scriptedStream } from "./scripted-model.js";
import { instructions, toolSession } from "./tools.js";

const maxSteps = 8;
const historyTurns = 20;

const failureMessages = {
  CANCELLED: "Turn cancelled. Observed usage is retained.",
  ACCESS_REVOKED: "Access changed. This turn stopped.",
  BUDGET_EXHAUSTED: "Your budget ran out during this turn. Observed usage is retained.",
  BRANCH_CONFLICT: "This conversation path changed. Reopen it before sending again.",
  INVALID_TOOL_REQUEST: "The model requested an unavailable tool.",
  MALFORMED_TOOL_CALL: "The model could not form a valid tool call.",
  MODEL_ACCESS_DENIED:
    "Model access denied. An AWS administrator may need to enable its Marketplace agreement or Runtime role.",
  MODEL_BUSY: "The model is busy. Please try again.",
};

// Bedrock Converse, and the scripted test model that speaks its stream shape.
function bedrockProvider({ config, model, level, messages, tools, emit }) {
  const toolConfig = tools.specs.length
    ? { tools: tools.specs.map((toolSpec) => ({ toolSpec })) }
    : undefined;
  const system =
    config.systemPrompt || toolConfig
      ? [{ text: instructions(config) }]
      : undefined;
  return {
    async step(progress) {
      const stream =
        model.transport === "scripted"
          ? scriptedStream(messages)
          : (
              await bedrock.send(
                new ConverseStreamCommand({
                  modelId: config.modelId,
                  messages,
                  system,
                  inferenceConfig: { maxTokens: model.maxOutputTokens },
                  toolConfig,
                  ...(model.company === "Anthropic" && {
                    additionalModelRequestFields: {
                      thinking: { type: "adaptive" },
                      output_config: { effort: level },
                    },
                  }),
                  ...(model.company === "OpenAI" && {
                    additionalModelRequestFields: {
                      reasoning: { effort: level },
                    },
                  }),
                }),
              )
            ).stream;
      progress.started = true;
      const content = [];
      let stopReason,
        usage = null;
      for await (const event of stream) {
        if (event.contentBlockStart?.start?.toolUse) {
          const { contentBlockIndex, start } = event.contentBlockStart;
          content[contentBlockIndex] = { toolUse: { ...start.toolUse, input: "" } };
        }
        if (event.contentBlockDelta) {
          const { contentBlockIndex, delta } = event.contentBlockDelta;
          if (delta.reasoningContent) {
            const block = (content[contentBlockIndex] ||= {
              reasoningContent: { reasoningText: { text: "" } },
            });
            const reasoning = delta.reasoningContent;
            if (reasoning.redactedContent)
              block.reasoningContent = {
                redactedContent: reasoning.redactedContent,
              };
            else {
              const prior = block.reasoningContent.reasoningText;
              if (reasoning.text) prior.text += reasoning.text;
              if (reasoning.signature) prior.signature = reasoning.signature;
            }
            if (reasoning.text) progress.text += reasoning.text;
          }
          if (delta.text) {
            content[contentBlockIndex] ||= { text: "" };
            content[contentBlockIndex].text += delta.text;
            progress.text += delta.text;
            emit({ type: "message.delta", text: delta.text });
          }
          if (delta.toolUse) {
            content[contentBlockIndex].toolUse.input += delta.toolUse.input || "";
            progress.text += delta.toolUse.input || "";
          }
        }
        if (event.contentBlockStop) {
          const part = content[event.contentBlockStop.contentBlockIndex];
          if (part?.toolUse) {
            try {
              part.toolUse.input = JSON.parse(part.toolUse.input || "{}");
            } catch {
              fail("MALFORMED_TOOL_CALL");
            }
          }
        }
        if (event.messageStop) stopReason = event.messageStop.stopReason;
        if (event.metadata?.usage) usage = { ...emptyUsage(), ...event.metadata.usage };
      }
      const calls = content.filter((part) => part?.toolUse).map((part) => part.toolUse);
      if (stopReason === "tool_use" && toolConfig && calls.length)
        return { usage, calls, content };
      if (stopReason !== "end_turn")
        return { usage, error: Error(`Unsupported model stop reason ${stopReason}`) };
      return {
        usage,
        calls: [],
        text: content.map((part) => part?.text || "").join(""),
      };
    },
    addResults(step, results) {
      messages.push({ role: "assistant", content: step.content });
      messages.push({
        role: "user",
        content: step.calls.map((call, index) => ({
          toolResult: {
            toolUseId: call.toolUseId,
            content: results[index].content,
            status: results[index].isError ? "error" : "success",
          },
        })),
      });
    },
    callsOf: (step) => step.calls.map((call) => ({ name: call.name, input: call.input })),
  };
}

// Gemini through its REST API, keyed by the AgentCore Identity credential.
function geminiProvider({ config, model, level, messages, tools, emit, workloadToken }) {
  const contents = messages.map(({ role, content }) => ({
    role: role === "assistant" ? "model" : "user",
    parts: content.map(({ text }) => ({ text })),
  }));
  let apiKey,
    text = "";
  return {
    async step(progress) {
      if (!workloadToken) throw Error("Missing runtime workload token");
      apiKey ||= (
        await agentcore.send(
          new GetResourceApiKeyCommand({
            resourceCredentialProviderName: process.env.GEMINI_PROVIDER,
            workloadIdentityToken: workloadToken,
          }),
        )
      ).apiKey;
      const reply = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.modelId)}:streamGenerateContent?alt=sse`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify(
            geminiRequest(model, level, contents, instructions(config), tools.specs),
          ),
          signal: AbortSignal.timeout(300000),
        },
      );
      if (!reply.ok) throw Error(`Gemini HTTP ${reply.status}`);
      progress.started = true;
      const step = await readGeminiStream(reply.body, (event) => {
        progress.text += event.text;
        emit(event);
      });
      let calls;
      try {
        calls = geminiStepCalls(step);
      } catch (error) {
        return {
          usage: step.usage,
          error: /MALFORMED_FUNCTION_CALL|Malformed/.test(error.message)
            ? Object.assign(error, { code: "MALFORMED_TOOL_CALL" })
            : error,
        };
      }
      text += step.visibleText;
      if (calls.length) return { usage: step.usage, calls, parts: step.parts };
      if (step.finishReason === "MAX_TOKENS") {
        const notice = text
          ? "\n\n[Response truncated at the model output limit.]"
          : "The model reached its output limit before producing a visible reply.";
        emit({ type: "message.delta", text: notice });
        text += notice;
      }
      if (!text) return { usage: step.usage, error: Error("Gemini returned no visible response") };
      return { usage: step.usage, calls: [], text };
    },
    addResults(step, results) {
      contents.push({ role: "model", parts: step.parts });
      contents.push({
        role: "user",
        parts: step.calls.map((call, index) =>
          geminiFunctionResult(call, results[index].content, results[index].isError),
        ),
      });
    },
    callsOf: (step) => step.calls.map((call) => ({ name: call.name, input: call.args || {} })),
  };
}

// The model loop shared by every provider: guard, step, meter, run tools.
async function agentLoop(provider, { run, meter, tools, promptText }) {
  for (let step = 0; step < maxSteps; step++) {
    await run.guard();
    await meter.checkBudget();
    const progress = { started: false, text: "" };
    let result;
    try {
      result = await provider.step(progress);
    } catch (error) {
      // Tokens were consumed once a stream started; record an estimate.
      if (progress.started)
        await meter.model(estimateUsage(promptText(), progress.text), "unknown");
      throw error;
    }
    await meter.model(
      result.usage || estimateUsage(promptText(), progress.text),
      result.usage ? "estimated" : "unknown",
    );
    if (result.error) throw result.error;
    if (!result.calls.length) return result.text;
    const results = [];
    for (const call of provider.callsOf(result))
      results.push(await tools.execute(call.name, call.input));
    provider.addResults(result, results);
  }
  throw Error("Agent turn limit reached");
}

function validTurnInput(input) {
  const {
    agentId,
    conversationId,
    requestId,
    message,
    modelId,
    thinkingLevel,
    fileIds = [],
    saveOutputs = false,
  } = input;
  const branchId = input.branchId ?? "main";
  const forking = Object.hasOwn(input, "forkTurnId");
  if (
    !patterns.branch.test(branchId) ||
    (forking &&
      (branchId === "main" ||
        (input.forkTurnId !== null && !patterns.turn.test(input.forkTurnId || "")))) ||
    (input.expectedHeadTurnId != null &&
      !patterns.turn.test(input.expectedHeadTurnId)) ||
    ![agentId, conversationId, requestId].every((id) => patterns.id.test(id || "")) ||
    !Array.isArray(fileIds) ||
    fileIds.length > 4 ||
    !fileIds.every((id) => patterns.id.test(id || "")) ||
    new Set(fileIds).size !== fileIds.length ||
    typeof saveOutputs !== "boolean" ||
    typeof message !== "string" ||
    !message.trim() ||
    message.length > 20000 ||
    (modelId !== undefined && (typeof modelId !== "string" || modelId.length > 512)) ||
    (thinkingLevel !== undefined && typeof thinkingLevel !== "string")
  )
    fail("VALIDATION_FAILED");
  return { branchId, forking, fileIds, saveOutputs };
}

export async function chat(input, identity, run, workloadToken) {
  if (identity.role === "Auditors") fail("FORBIDDEN");
  const { branchId, forking, fileIds, saveOutputs } = validTurnInput(input);
  const { agentId, conversationId, requestId, message } = input;
  const sub = identity.sub;
  const projectId = await projectOf(identity, input);
  const [agent, conversation, branch, currentLimits] = await Promise.all([
    get(agentKey(sub, projectId, agentId)),
    get(chatKey(sub, projectId, conversationId)),
    get(branchKey(sub, projectId, conversationId, branchId)),
    limits(sub),
  ]);
  if (!agent) fail("NOT_FOUND");
  if (agent.archived) fail("AGENT_ARCHIVED");
  if (conversation && (conversation.agentId !== agentId || conversation.status !== "ACTIVE"))
    fail("NOT_FOUND");
  // A fork names a new branch; a plain send needs its branch to exist unless it
  // starts the conversation on main.
  if (forking ? branch || !conversation : !branch && branchId !== "main")
    fail("BRANCH_CONFLICT");
  if (currentLimits.storageUsedBytes >= currentLimits.storageBytes)
    fail("STORAGE_EXHAUSTED");
  const period = periodKey(currentLimits.period, new Date(), currentLimits.budgetEpoch);
  if (((await get(userKey(sub, period)))?.costMicroUsd || 0) >= currentLimits.budgetMicroUsd)
    fail("BUDGET_EXHAUSTED");
  const modelId = input.modelId ?? agent.modelId;
  const model = approvedModel(modelId);
  if (!model) fail("MODEL_UNAVAILABLE");
  const level = thinkingLevelFor(model, input.thinkingLevel, agent);
  if (agent.browser && !model.browserTool) fail("TOOL_UNAVAILABLE");
  if ((fileIds.length || saveOutputs) && !agent.codeInterpreter) fail("TOOL_UNAVAILABLE");
  if (agent.connectionIds.length) {
    const saved = await connectionsOf(identity);
    if (!agent.connectionIds.every((id) => saved.some((item) => item.id === id)))
      fail("CONNECTION_REVOKED");
  }
  const [files, skills] = await Promise.all([
    turnFiles(sub, projectId, fileIds),
    skillTexts(sub, projectId, agent.skillIds),
  ]);

  // The turn's parent: the fork point, or the branch's current head.
  const parentTurnId = forking ? input.forkTurnId : branch?.headTurnId || null;
  if (!forking && input.expectedHeadTurnId !== undefined && input.expectedHeadTurnId !== parentTurnId)
    fail("BRANCH_CONFLICT");
  const history = await pathTo(
    sub,
    projectId,
    conversationId,
    parentTurnId,
    historyTurns,
  ).catch((error) => {
    if (forking && error.code === "HISTORY_INCOMPLETE") fail("BRANCH_CONFLICT");
    throw error;
  });
  const messages = [
    ...history.turns.flatMap((turn) => [
      { role: "user", content: [{ text: turn.message }] },
      { role: "assistant", content: [{ text: turn.answer }] },
    ]),
    { role: "user", content: [{ text: message }] },
  ];
  const title = message.trim().replace(/\s+/g, " ").slice(0, 80);
  await run.accept(
    {
      requestId,
      userSub: sub,
      projectId,
      agentId,
      conversationId,
      branchId,
      modelId,
      period,
      forkTurnId: forking ? input.forkTurnId : undefined,
    },
    {
      title,
      chatIndex: chatIndex(sub, projectId),
      branchKey: sk.branch(projectId, conversationId, branchId),
      // A fork must create its branch; any other send must find this head.
      observedHead: forking ? null : branch?.headTurnId || null,
    },
  );

  const config = { ...agent, modelId, skills, allowSaveOutputs: saveOutputs };
  const meter = createMeter({
    sub,
    requestId,
    projectId,
    conversationId,
    branchId,
    agentId,
    modelId,
    model,
    period,
    budgetMicroUsd: currentLimits.budgetMicroUsd,
  });
  const tools = toolSession(
    config,
    {
      sub,
      projectId,
      agentId,
      conversationId,
      requestId,
      connectionIds: agent.connectionIds,
      skills,
      files,
    },
    { emit: run.emit, guard: run.guard, meter },
  );
  const provider = (model.transport === "gemini" ? geminiProvider : bedrockProvider)({
    config,
    model,
    level,
    messages,
    tools,
    emit: run.emit,
    workloadToken,
  });
  const started = Date.now();
  let saved;
  try {
    let answer;
    try {
      answer = await agentLoop(provider, {
        run,
        meter,
        tools,
        promptText: () => JSON.stringify(messages),
      });
    } finally {
      await tools.close();
    }
    const citations = tools.citations();
    if (citations) run.emit({ type: "message.delta", text: citations });
    await run.guard();
    saved = await commit({
      sub,
      projectId,
      conversationId,
      branchId,
      requestId,
      branchExists: Boolean(branch),
      parentTurnId,
      title,
      turn: {
        message,
        answer: answer + citations,
        modelId,
        tools: tools.calls,
        costMicroUsd: meter.costMicroUsd,
      },
    });
  } catch (error) {
    const code =
      error.code ||
      (error.name === "AccessDeniedException"
        ? "MODEL_ACCESS_DENIED"
        : error.name === "ThrottlingException"
          ? "MODEL_BUSY"
          : "TURN_FAILED");
    console.error("Turn failed", code, error.name, error.$metadata?.httpStatusCode || "");
    await markFailed(sub, requestId, code).catch(() =>
      console.error("Could not record failed turn"),
    );
    run.emit({
      type: "error",
      code,
      message: failureMessages[code] || "Agent turn failed",
      ...(process.env.SCRIPTED_MODEL === "true" && { diagnostic: error.name }),
    });
    return;
  }
  run.emit({
    type: "message.done",
    requestId,
    conversationId,
    branchId,
    turnId: saved,
    costMicroUsd: meter.costMicroUsd,
    unpricedToolCalls: tools.calls.length,
    latencyMs: Date.now() - started,
  });
}

async function markFailed(sub, requestId, code) {
  await transact([
    {
      Update: {
        Key: userKey(sub, sk.request(requestId)),
        ...expression({
          set: {
            status: code === "CANCELLED" ? "cancelled" : "failed",
            failureCode: code,
            failedAt: new Date().toISOString(),
          },
          condition: "#status = :running",
          values: { ":running": "running" },
        }),
      },
    },
  ]).catch((error) => {
    if (!conditionFailed(error)) throw error;
  });
}

// Body first, then everything else in one transaction. If the branch moved,
// nothing commits and the orphaned body is removed.
async function commit({
  sub,
  projectId,
  conversationId,
  branchId,
  requestId,
  branchExists,
  parentTurnId,
  title,
  turn,
}) {
  const id = newTurnId(),
    now = new Date().toISOString();
  const location = turnLocation(sub, projectId, conversationId, id);
  const body = Buffer.from(JSON.stringify(turn));
  const object = await s3.send(
    new PutObjectCommand({
      Bucket: process.env.BUCKET,
      Key: location,
      Body: body,
      ContentType: "application/json",
      ServerSideEncryption: "AES256",
    }),
  );
  const release = releaseOps(sub, {
    requestId,
    projectId,
    conversationId,
    branchId,
  });
  // A branch's first turn creates it; later turns move its head forward.
  const branchWrite = !branchExists
    ? {
        Put: {
          Item: {
            ...branchKey(sub, projectId, conversationId, branchId),
            ...pack({
              id: branchId,
              name: branchId === "main" ? "Main" : `Alternative ${now.slice(11, 19)}`,
              rootTurnId: branchId === "main" ? null : parentTurnId,
              headTurnId: id,
              createdAt: now,
            }),
          },
          ConditionExpression: "attribute_not_exists(pk)",
        },
      }
    : {
        Update: {
          Key: branchKey(sub, projectId, conversationId, branchId),
          ...expression({
            set: { headTurnId: id },
            condition: "#headTurnId = :parent",
            values: { ":parent": parentTurnId },
          }),
        },
      };
  try {
    await transact(
      [
        {
          Put: {
            Item: {
              ...turnKey(sub, projectId, conversationId, id),
              ...pack({
                id,
                parentTurnId,
                branchId,
                requestId,
                objectKey: location,
                versionId: object.VersionId || "",
                sizeBytes: body.length,
                createdAt: now,
              }),
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
        branchWrite,
        {
          Update: {
            Key: chatKey(sub, projectId, conversationId),
            ...expression({
              init: { title },
              set: {
                lastActivityAt: now,
                gsi1sk: `${now}#${conversationId}`,
                activeBranchId: branchId,
              },
              add: release.chatAdd,
            }),
          },
        },
        {
          Update: {
            Key: userKey(sub, sk.request(requestId)),
            ...expression({
              set: { status: "completed", turnId: id, completedAt: now },
              condition: "#status = :running",
              values: { ":running": "running" },
            }),
          },
        },
        {
          Update: {
            Key: userKey(sub, sk.profile),
            ...expression({
              add: { storageUsedBytes: body.length },
              drop: { activeRequests: new Set([requestId]) },
            }),
          },
        },
        release.lock,
      ],
      requestId,
    );
  } catch (error) {
    await s3
      .send(
        new DeleteObjectCommand({
          Bucket: process.env.BUCKET,
          Key: location,
          ...(object.VersionId && { VersionId: object.VersionId }),
        }),
      )
      .catch(() => console.error("Could not remove uncommitted turn body"));
    if (error.name !== "TransactionCanceledException") throw error;
    const [, branchMoved, , requestEnded] = (error.CancellationReasons || []).map(
      (reason) => reason.Code === "ConditionalCheckFailed",
    );
    if (branchMoved) fail("BRANCH_CONFLICT");
    if (requestEnded)
      fail(
        (await get(userKey(sub, sk.request(requestId))))?.cancelRequested
          ? "CANCELLED"
          : "OUTCOME_UNKNOWN",
      );
    throw error;
  }
  return id;
}
