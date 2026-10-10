import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { SignatureV4 } from "@smithy/signature-v4";
import { Hash } from "@smithy/hash-node";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { scriptedStream } from "./scripted-model.js";
import { modelCost, modelRates, periodKey } from "./accounting.js";
import {
  geminiRequest,
  geminiFunctionResult,
  geminiStepCalls,
  readGeminiStream,
} from "./gemini-protocol.js";
import {
  GetItemCommand,
  PutItemCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  CreateEventCommand,
  DeleteEventCommand,
  GetEventCommand,
  GetResourceApiKeyCommand,
  StartCodeInterpreterSessionCommand,
  InvokeCodeInterpreterCommand,
  StopCodeInterpreterSessionCommand,
  StartBrowserSessionCommand,
  InvokeBrowserCommand,
  StopBrowserSessionCommand,
} from "@aws-sdk/client-bedrock-agentcore";

export function createChat(context) {
  const {
    credentialStore,
    db,
    memory,
    bedrock,
    s3,
    uuid,
    S,
    N,
    key,
    unpack,
    defaults,
    projectPattern,
    projectIdOf,
    projectKey,
    invalid,
    missing,
    objectKey,
    objectPublic,
    uploadKey,
    storageState,
    selectedSkills,
    repairPendingObject,
    completeStagedObject,
    project,
    effectiveLimits,
    approvedModel,
    connectionsById,
    branchPattern,
    eventPattern,
    branchKey,
    archiveKey,
    archiveObjectKey,
    archivePath,
    branchEvents,
  } = context;
  async function runGemini(
    config,
    model,
    level,
    messages,
    emit,
    workloadToken,
    tools,
    meter,
  ) {
    if (!workloadToken) throw Error("Missing runtime workload token");
    const { apiKey } = await memory.send(
      new GetResourceApiKeyCommand({
        resourceCredentialProviderName: process.env.GEMINI_PROVIDER,
        workloadIdentityToken: workloadToken,
      }),
    );
    const contents = messages.map(({ role, content }) => ({
      role: role === "assistant" ? "model" : "user",
      parts: content.map(({ text }) => ({ text })),
    }));
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    };
    let text = "";
    for (let turn = 0; turn < 8; turn++) {
      await meter.guard();
      const body = geminiRequest(
        model,
        level,
        contents,
        toolInstructions(config),
        tools.specs,
      );
      const reply = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.modelId)}:streamGenerateContent?alt=sse`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120000),
        },
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
          results.push(
            geminiFunctionResult(call, result.content, result.isError),
          );
        }
        contents.push({ role: "user", parts: results });
        continue;
      }
      if (step.finishReason === "MAX_TOKENS") {
        const notice = text
          ? "\n\n[Response truncated at the model output limit.]"
          : "The model reached its output limit before producing a visible reply.";
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
    const response = await memory.send(
      new InvokeCodeInterpreterCommand({
        codeInterpreterIdentifier: process.env.CODE_INTERPRETER_ID,
        sessionId,
        name,
        arguments: args,
      }),
    );
    let output = "";
    let isError = false;
    for await (const event of response.stream) {
      if (!event.result) continue;
      const structured = event.result.structuredContent;
      const content = (event.result.content || [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      output = (
        output +
        (structured?.stdout || "") +
        (structured?.stderr || "") +
        (structured?.stdout || structured?.stderr ? "" : content)
      ).slice(0, 8000);
      isError ||= event.result.isError === true;
    }
    return { output, isError };
  }

  const shellQuote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

  async function initializeWorkspace(sessionId, scope) {
    const saved = scope.connectionIds?.length
      ? await credentialStore.resolve({ sub: scope.sub }, scope.connectionIds)
      : {};
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
    const fileManifest = await Promise.all(
      (scope.files || []).map(async (item) => ({
        id: item.id,
        name: item.name,
        sizeBytes: item.sizeBytes,
        url: await getSignedUrl(
          s3,
          new GetObjectCommand({
            Bucket: process.env.BUCKET,
            Key: item.key,
            ...(item.versionId && { VersionId: item.versionId }),
          }),
          { expiresIn: 900 },
        ),
      })),
    );
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
    const contents =
      Object.entries(variables)
        .map(([name, value]) => {
          if (!/^[A-Za-z0-9._:/+=-]+$/.test(value || ""))
            throw Error("Invalid workspace context");
          return `${name}=${value}`;
        })
        .join("\n") + "\n";
    const written = await interpreterCall(sessionId, "writeFiles", {
      content: [
        { path: ".env", text: contents },
        ...(fileManifest.length
          ? [
              {
                path: "selected-files.json",
                text: JSON.stringify(fileManifest),
              },
            ]
          : []),
        ...(scope.skills || []).map((skill) => ({
          path: `skill-${skill.id}.md`,
          text: skill.text,
        })),
      ],
    });
    if (written.isError) throw Error("Could not initialize code workspace");
    const cwd = await interpreterCall(sessionId, "executeCommand", {
      command: "pwd",
    });
    const path = cwd.output.trim().split(/\r?\n/)[0];
    if (cwd.isError || !/^\/[A-Za-z0-9._/-]+$/.test(path))
      throw Error("Could not locate code workspace");
    return {
      path: `${path}/.env`,
      names: Object.keys(secretsForSession),
      values: [
        ...Object.values(secretsForSession),
        ...granted
          .filter((item) => item.kind === "jira")
          .map((item) => `${item.jiraEmail}:${item.apiKey}`),
        ...fileManifest.map((item) => item.url),
        JSON.stringify(fileManifest),
      ],
    };
  }

  async function saveInterpreterArtifact(sessionId, scope, input) {
    const {
      path,
      name,
      contentType = "application/octet-stream",
      idempotencyKey,
    } = input;
    if (
      typeof path !== "string" ||
      !/^outputs\/[A-Za-z0-9._/-]{1,180}$/.test(path) ||
      path.split("/").some((part) => part === "." || part === ".." || !part) ||
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 180 ||
      /[\r\n\0]/.test(name) ||
      typeof contentType !== "string" ||
      !/^[\w.+-]+\/[\w.+-]+$/.test(contentType) ||
      typeof idempotencyKey !== "string" ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(idempotencyKey)
    )
      throw Object.assign(new Error("Invalid artifact request"), {
        code: "INVALID_ARTIFACT",
      });
    const displayName = name.trim();
    const digest = createHash("sha256")
      .update(`artifact:${scope.sub}:${scope.requestId}:${idempotencyKey}`)
      .digest("hex");
    const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
    const identity = { sub: scope.sub };
    const savedRow = await db.send(
      new GetItemCommand({
        TableName: process.env.TABLE,
        Key: objectKey(scope.sub, id),
        ConsistentRead: true,
      }),
    );
    let item = savedRow.Item && unpack(savedRow.Item);
    if (item) {
      if (
        item.requestId !== scope.requestId ||
        item.saveKey !== idempotencyKey ||
        item.projectId !== scope.projectId ||
        item.name !== displayName ||
        item.contentType !== contentType ||
        item.sourcePath !== path
      )
        throw Object.assign(
          new Error("Artifact key was already used differently"),
          { code: "ARTIFACT_CONFLICT" },
        );
      if (item.status === "ACTIVE") return objectPublic(item);
      if (item.status !== "PENDING")
        throw Object.assign(
          new Error("Previously saved artifact was removed"),
          { code: "ARTIFACT_CONFLICT" },
        );
      item = await repairPendingObject(identity, item);
      if (item.status === "ACTIVE") return objectPublic(item);
      try {
        return objectPublic(
          await completeStagedObject(identity, item, item.declaredBytes),
        );
      } catch (error) {
        if (error.code !== "UPLOAD_MISSING") throw error;
      }
    }
    const check = `from pathlib import Path
p=Path(${JSON.stringify(path)})
cwd=Path.cwd().resolve()
root=cwd/"outputs"
if root.is_symlink() or not root.is_dir(): raise SystemExit(2)
target=(cwd/p).resolve(strict=True)
if root not in target.parents or not target.is_file() or target.is_symlink():
    raise SystemExit(2)
print(target.stat().st_size)`;
    const stat = await interpreterCall(sessionId, "executeCommand", {
      command: `python3 -c ${shellQuote(check)}`,
    });
    const size = Number(stat.output.trim());
    if (
      stat.isError ||
      !/^\d+$/.test(stat.output.trim()) ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > 100000000
    )
      throw Object.assign(new Error("Output is missing or exceeds 100 MB"), {
        code: "ARTIFACT_FILE_UNAVAILABLE",
      });
    const storage = await storageState(identity);
    if (storage.usedBytes + size > storage.limitBytes)
      throw Object.assign(new Error("Storage quota reached"), {
        code: "QUOTA_EXCEEDED",
      });
    if (!item) {
      item = {
        id,
        projectId: scope.projectId,
        name: displayName,
        kind: "artifact",
        contentType,
        declaredBytes: size,
        stageKey: uploadKey(scope.sub, id),
        status: "PENDING",
        requestId: scope.requestId,
        saveKey: idempotencyKey,
        sourcePath: path,
        createdAt: new Date().toISOString(),
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
      };
      try {
        await db.send(
          new PutItemCommand({
            TableName: process.env.TABLE,
            Item: {
              ...objectKey(scope.sub, id),
              ...Object.fromEntries(
                Object.entries(item).map(([field, value]) => [
                  field,
                  typeof value === "number" ? N(value) : S(value),
                ]),
              ),
            },
            ConditionExpression: "attribute_not_exists(pk)",
          }),
        );
      } catch (error) {
        if (error.name !== "ConditionalCheckFailedException") throw error;
        const raced = await db.send(
          new GetItemCommand({
            TableName: process.env.TABLE,
            Key: objectKey(scope.sub, id),
            ConsistentRead: true,
          }),
        );
        if (raced.Item?.status?.S === "ACTIVE")
          return objectPublic(unpack(raced.Item));
        throw Object.assign(new Error("Artifact save in progress"), {
          code: "ARTIFACT_CONFLICT",
        });
      }
    } else if (item.declaredBytes !== size) {
      throw Object.assign(new Error("Output changed during retry"), {
        code: "ARTIFACT_CONFLICT",
      });
    }
    const upload = await createPresignedPost(s3, {
      Bucket: process.env.BUCKET,
      Key: item.stageKey,
      Expires: 300,
      Fields: { "Content-Type": contentType },
      Conditions: [
        { "Content-Type": contentType },
        ["content-length-range", 1, size + 16384],
      ],
    });
    const fields = Object.entries(upload.fields)
      .map(
        ([field, value]) => `--form-string ${shellQuote(`${field}=${value}`)}`,
      )
      .join(" ");
    const command = `curl --fail --silent --show-error --max-time 120 --output /dev/null --write-out '%{http_code}' ${fields} --form ${shellQuote(`file=@${path};type=${contentType}`)} ${shellQuote(upload.url)}`;
    const sent = await interpreterCall(sessionId, "executeCommand", {
      command,
    });
    if (sent.isError || !/^(200|201|204)$/.test(sent.output.trim()))
      throw Object.assign(new Error("Artifact upload outcome unknown"), {
        code: "ARTIFACT_OUTCOME_UNKNOWN",
      });
    return objectPublic(await completeStagedObject(identity, item, size));
  }

  const gatewaySigner = new SignatureV4({
    credentials: defaultProvider(),
    region: process.env.AWS_REGION,
    service: "bedrock-agentcore",
    sha256: Hash.bind(null, "sha256"),
  });

  async function searchWeb(query, maxResults) {
    const endpoint = new URL("/mcp", process.env.GATEWAY_URL);
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: uuid(),
      method: "tools/call",
      params: { name: "Search___WebSearch", arguments: { query, maxResults } },
    });
    const signed = await gatewaySigner.sign({
      method: "POST",
      protocol: endpoint.protocol,
      hostname: endpoint.hostname,
      path: endpoint.pathname,
      headers: {
        host: endpoint.hostname,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-03-26",
      },
      body,
    });
    const response = await fetch(endpoint, {
      method: "POST",
      headers: signed.headers,
      body,
      signal: AbortSignal.timeout(30000),
    });
    const raw = await response.text();
    if (!response.ok)
      throw Error(`Web Search gateway returned ${response.status}`);
    const payload = raw.startsWith("data:")
      ? JSON.parse(
          raw
            .split("\n")
            .find((line) => line.startsWith("data:"))
            .slice(5),
        )
      : JSON.parse(raw);
    if (payload.error || payload.result?.isError)
      throw Error("Web Search was unavailable");
    const result = payload.result || payload;
    const text = result.content?.find((item) => item.type === "text")?.text;
    const results =
      result.structuredContent?.results ||
      (text ? JSON.parse(text).results : []);
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
        return parsed.protocol === "https:"
          ? [
              {
                title: String(title || parsed.hostname)
                  .replace(/[\r\n]/g, " ")
                  .slice(0, 120),
                url: parsed.href,
              },
            ]
          : [];
      } catch {
        return [];
      }
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
      const result = (
        await browserSend(
          new InvokeBrowserCommand({
            browserIdentifier: browserId,
            sessionId,
            action: operation,
          }),
        )
      ).result;
      const part = Object.values(result || {})[0];
      if (part?.status !== "SUCCESS") throw Error("Browser action failed");
      return part;
    };
    if (action === "navigate") {
      const url = new URL(input.url);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        url.href.length > 2000 ||
        isIP(url.hostname.replace(/^\[|\]$/g, "")) ||
        /(^localhost$|\.localhost$|\.local$)/i.test(url.hostname)
      )
        throw Error("Browser requires a public HTTPS URL");
      await invoke({ keyShortcut: { keys: ["ctrl", "l"] } });
      await invoke({ keyType: { text: url.href } });
      await invoke({ keyPress: { key: "enter" } });
    } else if (action === "click") {
      if (
        !Number.isInteger(input.x) ||
        input.x < 2 ||
        input.x > 997 ||
        !Number.isInteger(input.y) ||
        input.y < 2 ||
        input.y > 697
      )
        throw Error("Invalid browser coordinates");
      await invoke({ mouseClick: { x: input.x, y: input.y } });
    } else if (action === "type") {
      if (
        typeof input.text !== "string" ||
        !input.text ||
        input.text.length > 2000
      )
        throw Error("Invalid browser text");
      await invoke({ keyType: { text: input.text } });
    } else if (action === "scroll") {
      if (!Number.isInteger(input.deltaY) || Math.abs(input.deltaY) > 1000)
        throw Error("Invalid browser scroll");
      await invoke({ mouseScroll: { x: 500, y: 350, deltaY: input.deltaY } });
    } else if (action !== "screenshot") throw Error("Invalid browser action");
    if (action !== "screenshot")
      await new Promise((resolve) => setTimeout(resolve, 500));
    const screenshot = await invoke({ screenshot: { format: "PNG" } });
    if (!screenshot.data || screenshot.data.length > 3500000)
      throw Error("Browser screenshot unavailable or too large");
    return [
      {
        text: `Browser ${action} complete. Inspect the screenshot before the next action.`,
      },
      { image: { format: "png", source: { bytes: screenshot.data } } },
    ];
  }

  function toolSpecs(config) {
    const specs = [];
    if (config.codeInterpreter)
      specs.push(
        {
          name: "execute_code",
          description:
            "Run Python, JavaScript, or TypeScript in an isolated public-network workspace. Session .env is loaded automatically.",
          inputSchema: {
            json: {
              type: "object",
              properties: {
                language: {
                  type: "string",
                  enum: ["python", "javascript", "typescript"],
                },
                code: { type: "string" },
              },
              required: ["language", "code"],
            },
          },
        },
        {
          name: "execute_command",
          description:
            "Run a shell command in that workspace, with session .env loaded. Python, Node, curl, AWS CLI, pip and npm are installed; install other tools only when needed. Commands are capped at 120 seconds.",
          inputSchema: {
            json: {
              type: "object",
              properties: {
                command: { type: "string" },
              },
              required: ["command"],
            },
          },
        },
      );
    if (config.codeInterpreter && config.allowSaveOutputs)
      specs.push({
        name: "save_artifact",
        description:
          "Save one user-requested outputs/ file to private, quota-counted Files. First create the file in the code workspace. Reuse the same idempotencyKey when investigating an uncertain save.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              path: { type: "string" },
              name: { type: "string" },
              contentType: { type: "string" },
              idempotencyKey: { type: "string" },
            },
            required: ["path", "name", "idempotencyKey"],
          },
        },
      });
    if (config.webSearch)
      specs.push({
        name: "web_search",
        description:
          "Search the current public web. Cite source URLs in your answer. Queries are limited to 200 characters.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              query: { type: "string" },
            },
            required: ["query"],
          },
        },
      });
    if (config.browser)
      specs.push({
        name: "browser",
        description:
          "Use an isolated public browser. Each action returns a screenshot to inspect. Navigate only to a public HTTPS URL; click uses screenshot coordinates. No authenticated browser profile is loaded.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["navigate", "click", "type", "scroll", "screenshot"],
              },
              url: { type: "string" },
              x: { type: "integer" },
              y: { type: "integer" },
              text: { type: "string" },
              deltaY: { type: "integer" },
            },
            required: ["action"],
          },
        },
      });
    return specs;
  }

  function toolInstructions(config) {
    return [
      config.systemPrompt,
      ...(config.skills || []).map(
        (skill) => `Selected skill ${skill.name} (${skill.id}):\n${skill.text}`,
      ),
      "Use only the tools provided in this request. If a requested capability is unavailable, say so; do not invent tool results.",
      config.codeInterpreter
        ? "Use the code workspace to inspect, run and revise work. Selected skill files are in skill-<id>.md. When this turn has selected user files, selected-files.json lists their names and short-lived read-only download URLs; fetch only what you need and never print URLs. Prefer installed Python requests/boto3 and native HTTPS APIs before installing packages. Granted GitHub/Jira connections, if any, appear as GITHUB_TOKEN or JIRA_API_TOKEN/JIRA_URL/JIRA_EMAIL environment variables. Do not print session secrets; code with granted credentials can read and transmit them."
        : "",
      config.allowSaveOutputs
        ? "The user allowed saving outputs for this turn. Put only requested deliverables under outputs/ and call save_artifact for each file (100 MB maximum). Reuse an idempotencyKey for the same output; if the outcome is uncertain, check Files before trying again. Never save secrets or temporary files."
        : "",
      config.webSearch
        ? "Web Search returns current results. Base factual claims on the returned sources and cite their URLs."
        : "",
      config.browser
        ? "Browser actions return screenshots. Inspect each screenshot and avoid entering private credentials."
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
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
      await meter.guard();
      if (toolCalls.length >= 8) throw Error("Agent tool call limit reached");
      const isCode =
        name === "execute_code" &&
        ["python", "javascript", "typescript"].includes(input?.language) &&
        typeof input.code === "string" &&
        input.code.length <= 20000;
      const isCommand =
        name === "execute_command" &&
        typeof input?.command === "string" &&
        input.command.length <= 20000;
      const isSearch =
        name === "web_search" &&
        config.webSearch &&
        typeof input?.query === "string" &&
        input.query.trim().length > 0 &&
        input.query.length <= 200;
      const isBrowser =
        name === "browser" &&
        config.browser &&
        ["navigate", "click", "type", "scroll", "screenshot"].includes(
          input?.action,
        );
      const isSave =
        name === "save_artifact" &&
        config.codeInterpreter &&
        config.allowSaveOutputs &&
        input &&
        typeof input === "object";
      if (
        !(isCode && config.codeInterpreter) &&
        !(isCommand && config.codeInterpreter) &&
        !isSearch &&
        !isBrowser &&
        !isSave
      )
        throw Error("Invalid tool request");
      if ((isCode || isCommand) && !codeSession) {
        if (!process.env.CODE_INTERPRETER_ID)
          throw Error("Code workspace unavailable");
        codeSession = (
          await memory.send(
            new StartCodeInterpreterSessionCommand({
              codeInterpreterIdentifier: process.env.CODE_INTERPRETER_ID,
              name: `chat-${uuid().slice(0, 8)}`,
              sessionTimeoutSeconds: 900,
            }),
          )
        ).sessionId;
        const workspace = await initializeWorkspace(codeSession, scope);
        envPath = workspace.path;
        envNames = workspace.names;
        envValues = workspace.values;
      }
      const started = Date.now();
      let content;
      let isError = false;
      if (isSearch || isBrowser || isSave) {
        try {
          if (isSearch) {
            const result = await searchWeb(
              input.query.trim(),
              config.webSearchMaxResults || 5,
            );
            for (const { url, title } of result.sources)
              sources.set(url, title);
            content = [{ text: result.text }];
          } else if (isBrowser) {
            if (!browserSession)
              browserSession = (
                await browserSend(
                  new StartBrowserSessionCommand({
                    browserIdentifier: browserId,
                    name: `chat-${uuid().slice(0, 8)}`,
                    clientToken: uuid(),
                    sessionTimeoutSeconds: config.browserSessionSeconds || 300,
                    viewPort: { width: 1000, height: 700 },
                  }),
                )
              ).sessionId;
            content = await browserAction(browserSession, input);
          } else {
            if (!codeSession)
              throw Object.assign(
                Error("Create the output in the code workspace first"),
                { code: "ARTIFACT_FILE_UNAVAILABLE" },
              );
            const saved = await saveInterpreterArtifact(
              codeSession,
              scope,
              input,
            );
            content = [
              {
                text: `Saved ${saved.name} in Files (id ${saved.id}, ${saved.sizeBytes} bytes).`,
              },
            ];
          }
        } catch (error) {
          console.error(
            "Managed tool failed",
            name,
            error.name,
            error.$metadata?.httpStatusCode || "",
          );
          isError = true;
          const saveMessages = {
            INVALID_ARTIFACT:
              "Invalid output path, name, MIME type, or idempotency key.",
            ARTIFACT_CONFLICT:
              "That idempotency key belongs to a different or removed output.",
            ARTIFACT_FILE_UNAVAILABLE:
              "Create a regular file under outputs/ first (100 MB maximum).",
            QUOTA_EXCEEDED:
              "The storage limit was reached; the output was not admitted.",
            ARTIFACT_OUTCOME_UNKNOWN:
              "The save outcome is unknown. Check Files before another attempt with the same idempotency key.",
            UPLOAD_MISSING:
              "The upload did not complete. Retry with the same idempotency key.",
            UPLOAD_SIZE_MISMATCH:
              "The uploaded size changed. Retry with the same idempotency key.",
          };
          content = [
            {
              text: isSave
                ? saveMessages[error.code] ||
                  "Output save could not complete; check Files before retrying."
                : `${isSearch ? "Web Search" : "Browser"} could not complete that action.`,
            },
          ];
        }
      } else {
        const pythonEnv = envNames.length
          ? `import os, base64
for _name in ${JSON.stringify(envNames)}:
    os.environ[_name] = base64.b64decode(os.environ.pop(_name + "_B64")).decode("utf-8")
`
          : "";
        const nodeEnv = envNames.length
          ? `for (const name of ${JSON.stringify(envNames)}) {
  process.env[name] = Buffer.from(process.env[name + "_B64"], "base64").toString("utf8");
  delete process.env[name + "_B64"];
}
`
          : "";
        const shellEnv = envNames
          .map(
            (name) =>
              `export ${name}="$(printf '%s' "$${name}_B64" | base64 -d)"; unset ${name}_B64; `,
          )
          .join("");
        const args = isCode
          ? {
              language: input.language,
              runtime: input.language === "python" ? "python" : "nodejs",
              code:
                input.language === "python"
                  ? `from dotenv import load_dotenv\nload_dotenv(${JSON.stringify(envPath)}, override=True)\n${pythonEnv}${input.code}`
                  : `process.loadEnvFile(${JSON.stringify(envPath)});\n${nodeEnv}${input.code}`,
            }
          : {
              command: `set -a; . ${shellQuote(envPath)}; set +a; ${shellEnv}timeout 120s sh -lc ${shellQuote(input.command)}`,
            };
        const result = await interpreterCall(
          codeSession,
          isCode ? "executeCode" : "executeCommand",
          args,
        );
        isError = result.isError;
        const safeOutput = envValues.reduce(
          (text, value) =>
            text
              .replaceAll(value, "[redacted]")
              .replaceAll(
                Buffer.from(value, "utf8").toString("base64"),
                "[redacted]",
              ),
          result.output || "(no output)",
        );
        content = [{ text: safeOutput }];
      }
      const tool = {
        name,
        latencyMs: Date.now() - started,
        occurredAt: new Date().toISOString(),
        isError,
      };
      await meter.tool(toolCalls.length, tool);
      toolCalls.push(tool);
      emit({ type: "tool.done", name, isError });
      return { content, isError };
    };
    const citations = () =>
      sources.size
        ? "\n\nSources:\n" +
          [...sources].map(([url, title]) => `- ${title}: ${url}`).join("\n")
        : "";
    const close = async () => {
      if (browserSession)
        await browserSend(
          new StopBrowserSessionCommand({
            browserIdentifier: browserId,
            sessionId: browserSession,
          }),
        ).catch(() => console.error("Could not stop Browser session"));
      if (codeSession)
        await memory
          .send(
            new StopCodeInterpreterSessionCommand({
              codeInterpreterIdentifier: process.env.CODE_INTERPRETER_ID,
              sessionId: codeSession,
            }),
          )
          .catch(() =>
            console.error("Could not stop Code Interpreter session"),
          );
    };
    return { specs, toolCalls, execute, citations, close };
  }

  async function runModel(
    config,
    model,
    messages,
    emit,
    workloadToken,
    scope,
    meter,
  ) {
    const level = model.thinkingLevels.includes(config.thinkingLevel)
      ? config.thinkingLevel
      : model.defaultThinkingLevel;
    const tools = toolSession(config, emit, scope, meter);
    if (model.transport === "gemini") {
      try {
        return await runGemini(
          config,
          model,
          level,
          messages,
          emit,
          workloadToken,
          tools,
          meter,
        );
      } finally {
        await tools.close();
      }
    }
    const toolConfig = tools.specs.length
      ? { tools: tools.specs.map((toolSpec) => ({ toolSpec })) }
      : undefined;
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    };
    try {
      for (let turn = 0; turn < 8; turn++) {
        await meter.guard();
        const stream =
          config.modelId === "test.echo"
            ? scriptedStream(messages)
            : (
                await bedrock.send(
                  new ConverseStreamCommand({
                    modelId: config.modelId,
                    messages,
                    system:
                      config.systemPrompt || toolConfig
                        ? [{ text: toolInstructions(config) }]
                        : undefined,
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
        const content = [];
        let stopReason;
        let metered = false;
        const stepUsage = {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
        };
        for await (const event of stream) {
          if (event.contentBlockStart?.start?.toolUse) {
            const { contentBlockIndex, start } = event.contentBlockStart;
            content[contentBlockIndex] = {
              toolUse: { ...start.toolUse, input: "" },
            };
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
            }
            if (delta.text) {
              content[contentBlockIndex] ||= { text: "" };
              content[contentBlockIndex].text += delta.text;
              emit({ type: "message.delta", text: delta.text });
            }
            if (delta.toolUse)
              content[contentBlockIndex].toolUse.input +=
                delta.toolUse.input || "";
          }
          if (event.contentBlockStop) {
            const part = content[event.contentBlockStop.contentBlockIndex];
            if (part?.toolUse)
              part.toolUse.input = JSON.parse(part.toolUse.input);
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
          return {
            text: content.map((part) => part?.text || "").join("") + citations,
            usage,
            toolCalls: tools.toolCalls,
          };
        }
        if (stopReason !== "tool_use" || !toolConfig)
          throw Error("Unsupported model stop reason");
        const requested = content
          .filter((part) => part?.toolUse)
          .map((part) => part.toolUse);
        if (!requested.length) throw Error("Tool turn had no tool requests");
        messages.push({ role: "assistant", content });
        const results = [];
        for (const tool of requested) {
          const result = await tools.execute(tool.name, tool.input);
          results.push({
            toolResult: {
              toolUseId: tool.toolUseId,
              content: result.content,
              status: result.isError ? "error" : "success",
            },
          });
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
      CONNECTION_REVOKED:
        "A granted connection was removed. Edit this agent before sending again.",
      SKILL_UNAVAILABLE:
        "A selected skill was removed. Edit this agent before sending again.",
      STORAGE_EXHAUSTED:
        "Your storage limit is reached. Delete files or ask an administrator to raise it before starting another persistent turn.",
      HISTORY_INCOMPLETE:
        "This conversation's saved history is incomplete. Do not continue it until it is repaired.",
      BUDGET_EXHAUSTED: "Your current budget is exhausted.",
      MODEL_UNAVAILABLE: "This agent's model is unavailable.",
      TOOL_UNAVAILABLE: "This model cannot use the agent's enabled tools.",
      AGENT_ARCHIVED:
        "This agent is archived. Restore it to send another message.",
      REQUEST_ALREADY_COMPLETED:
        "This request was already accepted. Reopen the conversation or inspect usage before retrying.",
      FORBIDDEN: "This account cannot send messages.",
      NOT_FOUND: "This agent was not found.",
      FILE_UNAVAILABLE:
        "A selected file was removed or is outside this project. Choose files again.",
      VALIDATION_FAILED: "The message request is invalid.",
      BRANCH_CONFLICT:
        "This conversation path changed. Reopen it before sending again.",
    };
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
    });
    response.end(
      `data: ${JSON.stringify({
        type: "error",
        code,
        message: messages[code] || "Chat could not start.",
      })}\n\n`,
    );
  }

  async function chat(input, identity, response, workloadToken) {
    const {
      agentId,
      sessionId,
      requestId,
      message,
      modelId,
      thinkingLevel,
      fileIds = [],
      saveOutputs = false,
    } = input;
    const projectId = projectIdOf(input);
    const branchId = input.branchId ?? "main";
    const forking = Object.hasOwn(input, "forkEventId");
    const forkEventId = input.forkEventId;
    const sourceBranchId = input.sourceBranchId ?? "main";
    const idPattern = /^[0-9a-f-]{36}$/i;
    if (
      !projectPattern.test(projectId) ||
      !branchPattern.test(branchId) ||
      (forking
        ? !branchPattern.test(sourceBranchId)
        : input.sourceBranchId !== undefined) ||
      (forking &&
        (branchId === "main" ||
          (forkEventId !== null && !eventPattern.test(forkEventId || "")))) ||
      (input.expectedHeadEventId !== undefined &&
        input.expectedHeadEventId !== null &&
        !eventPattern.test(input.expectedHeadEventId)) ||
      !idPattern.test(agentId || "") ||
      !idPattern.test(sessionId || "") ||
      !idPattern.test(requestId || "") ||
      !Array.isArray(fileIds) ||
      fileIds.length > 4 ||
      fileIds.some((id) => !idPattern.test(id || "")) ||
      new Set(fileIds).size !== fileIds.length ||
      typeof saveOutputs !== "boolean" ||
      typeof message !== "string" ||
      !message.trim() ||
      message.length > 20000 ||
      (modelId !== undefined &&
        (typeof modelId !== "string" || modelId.length > 512)) ||
      (thinkingLevel !== undefined && typeof thinkingLevel !== "string")
    )
      return rejectChat(response, "VALIDATION_FAILED");
    if (identity.role === "Auditors") return rejectChat(response, "FORBIDDEN");
    if (!(await project(identity, projectId)))
      return rejectChat(response, "NOT_FOUND");
    const [
      row,
      defaultsRow,
      prior,
      user,
      conversationRow,
      branchRow,
      sourceBranchRow,
    ] = await Promise.all([
      db.send(
        new GetItemCommand({
          TableName: process.env.TABLE,
          Key: key(projectKey(identity.sub, projectId), `AGENT#${agentId}`),
          ConsistentRead: true,
        }),
      ),
      defaults(),
      db.send(
        new GetItemCommand({
          TableName: process.env.TABLE,
          Key: key(`USER#${identity.sub}`, `REQUEST#${requestId}`),
          ConsistentRead: true,
        }),
      ),
      db.send(
        new GetItemCommand({
          TableName: process.env.TABLE,
          Key: key(`USER#${identity.sub}`, "CONTROL"),
          ConsistentRead: true,
        }),
      ),
      db.send(
        new GetItemCommand({
          TableName: process.env.TABLE,
          Key: key(
            projectKey(identity.sub, projectId),
            `CONVERSATION#${sessionId}`,
          ),
          ConsistentRead: true,
        }),
      ),
      branchId === "main"
        ? Promise.resolve({})
        : db.send(
            new GetItemCommand({
              TableName: process.env.TABLE,
              Key: branchKey(identity.sub, projectId, sessionId, branchId),
              ConsistentRead: true,
            }),
          ),
      !forking || sourceBranchId === "main"
        ? Promise.resolve({})
        : db.send(
            new GetItemCommand({
              TableName: process.env.TABLE,
              Key: branchKey(
                identity.sub,
                projectId,
                sessionId,
                sourceBranchId,
              ),
              ConsistentRead: true,
            }),
          ),
    ]);
    if (!row.Item) return rejectChat(response, "NOT_FOUND");
    const config = unpack(row.Item);
    if (config.archived) return rejectChat(response, "AGENT_ARCHIVED");
    if (prior.Item) return rejectChat(response, "REQUEST_ALREADY_COMPLETED");
    const durable =
      !conversationRow.Item || conversationRow.Item.durable?.BOOL === true;
    if (
      conversationRow.Item &&
      (conversationRow.Item.agentId?.S !== agentId ||
        conversationRow.Item.status?.S === "DELETING" ||
        (!durable &&
          Number(conversationRow.Item.expiresAt?.N || 0) <= Date.now() / 1000))
    )
      return rejectChat(response, "NOT_FOUND");
    if (
      forking
        ? branchRow.Item ||
          !conversationRow.Item ||
          (sourceBranchId !== "main" && !sourceBranchRow.Item) ||
          (forkEventId === null && branchId === "main")
        : branchId !== "main" && !branchRow.Item
    )
      return rejectChat(response, "BRANCH_CONFLICT");
    const currentLimits = effectiveLimits(user.Item, defaultsRow);
    if (
      durable &&
      Number(user.Item?.storageUsedBytes?.N || 0) >= currentLimits.storageBytes
    )
      return rejectChat(response, "STORAGE_EXHAUSTED");
    const period = periodKey(
      currentLimits.period,
      new Date(),
      currentLimits.budgetEpoch,
    );
    const turnModelId = modelId ?? config.modelId;
    const [model, spent] = await Promise.all([
      approvedModel(turnModelId),
      db.send(
        new GetItemCommand({
          TableName: process.env.TABLE,
          Key: key(`USER#${identity.sub}`, period),
          ConsistentRead: true,
        }),
      ),
    ]);
    if (!model) return rejectChat(response, "MODEL_UNAVAILABLE");
    const savedLevel =
      turnModelId === config.modelId &&
      model.thinkingLevels.includes(config.thinkingLevel)
        ? config.thinkingLevel
        : model.defaultThinkingLevel;
    const turnThinkingLevel = thinkingLevel ?? savedLevel;
    if (
      model.thinkingLevels.length
        ? !model.thinkingLevels.includes(turnThinkingLevel)
        : thinkingLevel !== undefined
    )
      return rejectChat(response, "VALIDATION_FAILED");
    if (config.browser && !model.browserTool)
      return rejectChat(response, "TOOL_UNAVAILABLE");
    if (config.connectionIds?.length) {
      const current = (await connectionsById(identity)).items;
      if (config.connectionIds.some((id) => !current[id]))
        return rejectChat(response, "CONNECTION_REVOKED");
    }
    if (fileIds.length && !config.codeInterpreter)
      return rejectChat(response, "TOOL_UNAVAILABLE");
    if (saveOutputs && !config.codeInterpreter)
      return rejectChat(response, "TOOL_UNAVAILABLE");
    const files = [];
    for (const id of fileIds) {
      const row = await db.send(
        new GetItemCommand({
          TableName: process.env.TABLE,
          Key: objectKey(identity.sub, id),
          ConsistentRead: true,
        }),
      );
      const item = row.Item && unpack(row.Item);
      if (
        !item ||
        item.status !== "ACTIVE" ||
        item.projectId !== projectId ||
        !["file", "artifact"].includes(item.kind)
      )
        return rejectChat(response, "FILE_UNAVAILABLE");
      files.push({
        id,
        name: item.name,
        sizeBytes: item.sizeBytes,
        key: item.key,
        versionId: item.versionId,
      });
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
    const turnConfig = {
      ...config,
      modelId: turnModelId,
      thinkingLevel: turnThinkingLevel,
      skills,
      allowSaveOutputs: saveOutputs,
    };
    const actorId = `${identity.sub}/${projectId}`;
    const mainMemorySessionId =
      conversationRow.Item?.mainMemorySessionId?.S ||
      `a_${agentId}_${sessionId}`;
    // Memory requires a rootEventId for native branches. Editing the first turn
    // therefore starts one independent session; its later descendants can use
    // native branches inside that session without copying any message bodies.
    const sourceMemorySessionId =
      sourceBranchRow.Item?.memorySessionId?.S || mainMemorySessionId;
    let memorySessionId = forking
      ? forkEventId === null
        ? `a_${agentId}_b_${branchId}`
        : sourceMemorySessionId
      : branchRow.Item?.memorySessionId?.S || mainMemorySessionId;
    let nativeBranchId =
      (forking && forkEventId === null) ||
      (!forking && branchRow.Item?.memoryRoot?.BOOL)
        ? "main"
        : branchId;
    let rootEvent;
    if (forking && forkEventId) {
      try {
        rootEvent = (
          await memory.send(
            new GetEventCommand({
              memoryId: process.env.MEMORY,
              actorId,
              sessionId: sourceMemorySessionId,
              eventId: forkEventId,
            }),
          )
        ).event;
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
      const head = forking
        ? forkEventId
        : branchId === "main"
          ? conversationRow.Item?.mainHeadEventId?.S
          : branchRow.Item?.headEventId?.S;
      history = head
        ? await archivePath(identity, projectId, sessionId, head, 20)
        : { events: [], incomplete: false };
      if (history.incomplete) return rejectChat(response, "HISTORY_INCOMPLETE");
    } else if (forking && rootEvent) {
      const sourceBranch =
        sourceBranchId === "main"
          ? rootEvent.branch?.name || "main"
          : sourceBranchRow.Item?.memoryRoot?.BOOL
            ? "main"
            : sourceBranchId;
      let cursor;
      const events = [];
      do {
        const page = await branchEvents(
          actorId,
          sourceMemorySessionId,
          sourceBranch,
          cursor,
        );
        events.push(...page.events);
        cursor = page.nextToken;
      } while (
        cursor &&
        !events.some((event) => event.eventId === forkEventId)
      );
      const rootIndex = events.findIndex(
        (event) => event.eventId === forkEventId,
      );
      if (rootIndex < 0) return rejectChat(response, "BRANCH_CONFLICT");
      history = { events: events.slice(rootIndex, rootIndex + 20) };
    } else if (forking) history = { events: [] };
    else
      history = await branchEvents(
        actorId,
        memorySessionId,
        nativeBranchId,
        undefined,
        20,
      );
    const observedHead =
      branchId === "main"
        ? conversationRow.Item?.mainHeadEventId?.S ||
          history.events[0]?.eventId ||
          null
        : branchRow.Item?.headEventId?.S || null;
    if (
      !forking &&
      input.expectedHeadEventId !== undefined &&
      input.expectedHeadEventId !== observedHead
    )
      return rejectChat(response, "BRANCH_CONFLICT");
    // ListEvents returns newest first. Only recent context goes to the model;
    // AgentCore Memory retains the full session independently of that window.
    const messages = (history.events || []).toReversed().flatMap((event) =>
      (event.payload || []).flatMap((payload) => {
        const entry = payload.conversational;
        return entry?.content?.text &&
          ["USER", "ASSISTANT"].includes(entry.role)
          ? [
              {
                role: entry.role.toLowerCase(),
                content: [{ text: entry.content.text }],
              },
            ]
          : [];
      }),
    );
    messages.push({ role: "user", content: [{ text: message }] });
    const acceptedAt = new Date().toISOString();
    const requestKey = key(`USER#${identity.sub}`, `REQUEST#${requestId}`);
    await response.accept(
      {
        version: 1,
        input,
        config: turnConfig,
        model,
        messages,
        files,
        actorId,
        memorySessionId,
        nativeBranchId,
        observedHead,
        period,
        limits: currentLimits,
      },
      {
        ...requestKey,
        status: S("running"),
        acceptedAt: S(acceptedAt),
        userSub: S(identity.sub),
        projectId: S(projectId),
        agentId: S(agentId),
        conversationId: S(sessionId),
        branchId: S(branchId),
        modelId: S(turnModelId),
        ...(forking && {
          forkEventId: forkEventId ? S(forkEventId) : { NULL: true },
          sourceBranchId: S(sourceBranchId),
        }),
        durable: { BOOL: durable },
        period: S(period),
        costMicroUsd: N(0),
        modelSteps: N(0),
        toolSteps: N(0),
        meterKeys: { L: [] },
      },
    );
    let meteredCost = 0;
    const meter = {
      guard: async () => {
        await response.guard();
        const latest = await db.send(
          new GetItemCommand({
            TableName: process.env.TABLE,
            Key: key(projectKey(identity.sub, projectId), `AGENT#${agentId}`),
            ConsistentRead: true,
          }),
        );
        const agent = latest.Item && unpack(latest.Item);
        if (
          !agent ||
          agent.archived ||
          (config.connectionIds || []).some(
            (id) => !agent.connectionIds?.includes(id),
          )
        )
          throw Object.assign(Error("ACCESS_REVOKED"), {
            code: "ACCESS_REVOKED",
          });
        await credentialStore.resolve(identity, config.connectionIds || []);
      },
      model: async (step, usage) => {
        const occurredAt = new Date().toISOString();
        const cost = modelCost(usage, model);
        const rates = modelRates(usage, model);
        const eventKey = `USAGE#${occurredAt}#${requestId}#MODEL#${step}`;
        await db.send(
          new TransactWriteItemsCommand({
            ClientRequestToken: uuid(),
            TransactItems: [
              {
                Put: {
                  TableName: process.env.TABLE,
                  Item: {
                    ...key(`USER#${identity.sub}`, eventKey),
                    gsi1pk: S("USAGE"),
                    gsi1sk: S(
                      `${occurredAt}#${identity.sub}#${requestId}#MODEL#${step}`,
                    ),
                    occurredAt: S(occurredAt),
                    userSub: S(identity.sub),
                    requestId: S(requestId),
                    projectId: S(projectId),
                    branchId: S(branchId),
                    agentId: S(agentId),
                    modelId: S(turnModelId),
                    step: N(step),
                    kind: S("model"),
                    costMicroUsd: N(cost),
                    inputTokens: N(usage.inputTokens),
                    outputTokens: N(usage.outputTokens),
                    cacheReadInputTokens: N(usage.cacheReadInputTokens || 0),
                    cacheWriteInputTokens: N(usage.cacheWriteInputTokens || 0),
                    inputRate: N(rates.inputRate || 0),
                    outputRate: N(rates.outputRate || 0),
                    cacheReadRate: N(rates.cacheReadRate || 0),
                    cacheWriteRate: N(rates.cacheWriteRate || 0),
                    pricingSource: S(model.pricingSource || ""),
                    pricingQuality: S(model.pricingQuality || "unknown"),
                    quality: S("estimated"),
                  },
                  ConditionExpression: "attribute_not_exists(pk)",
                },
              },
              {
                Update: {
                  TableName: process.env.TABLE,
                  Key: key(`USER#${identity.sub}`, period),
                  UpdateExpression:
                    "ADD costMicroUsd :cost, estimatedModelCalls :one",
                  ExpressionAttributeValues: { ":cost": N(cost), ":one": N(1) },
                },
              },
              {
                Update: {
                  TableName: process.env.TABLE,
                  Key: key(
                    `USER#${identity.sub}`,
                    `DAY#${occurredAt.slice(0, 10)}`,
                  ),
                  UpdateExpression:
                    "ADD costMicroUsd :cost, estimatedModelCalls :one SET gsi1pk = :index, gsi1sk = :sort, userSub = :user, #day = :day",
                  ExpressionAttributeNames: { "#day": "day" },
                  ExpressionAttributeValues: {
                    ":cost": N(cost),
                    ":one": N(1),
                    ":index": S("USAGE_DAYS"),
                    ":sort": S(`${occurredAt.slice(0, 10)}#${identity.sub}`),
                    ":user": S(identity.sub),
                    ":day": S(occurredAt.slice(0, 10)),
                  },
                },
              },
              {
                Update: {
                  TableName: process.env.TABLE,
                  Key: requestKey,
                  UpdateExpression:
                    "ADD costMicroUsd :cost, modelSteps :one SET lastMeteredAt = :time, meterKeys = list_append(if_not_exists(meterKeys, :empty), :keys)",
                  ConditionExpression: "#status = :running",
                  ExpressionAttributeNames: { "#status": "status" },
                  ExpressionAttributeValues: {
                    ":cost": N(cost),
                    ":one": N(1),
                    ":time": S(occurredAt),
                    ":running": S("running"),
                    ":empty": { L: [] },
                    ":keys": { L: [S(eventKey)] },
                  },
                },
              },
            ],
          }),
        );
        meteredCost += cost;
      },
      tool: async (step, tool) => {
        const occurredAt = tool.occurredAt;
        await db.send(
          new TransactWriteItemsCommand({
            ClientRequestToken: uuid(),
            TransactItems: [
              {
                Put: {
                  TableName: process.env.TABLE,
                  Item: {
                    ...key(
                      `USER#${identity.sub}`,
                      `USAGE#${occurredAt}#${requestId}#TOOL#${step}`,
                    ),
                    gsi1pk: S("USAGE"),
                    gsi1sk: S(
                      `${occurredAt}#${identity.sub}#${requestId}#TOOL#${step}`,
                    ),
                    occurredAt: S(occurredAt),
                    userSub: S(identity.sub),
                    requestId: S(requestId),
                    projectId: S(projectId),
                    branchId: S(branchId),
                    agentId: S(agentId),
                    kind: S("tool"),
                    name: S(tool.name),
                    costMicroUsd: N(0),
                    latencyMs: N(tool.latencyMs),
                    isError: { BOOL: tool.isError },
                    quality: S("unpriced"),
                  },
                  ConditionExpression: "attribute_not_exists(pk)",
                },
              },
              {
                Update: {
                  TableName: process.env.TABLE,
                  Key: key(`USER#${identity.sub}`, period),
                  UpdateExpression: "ADD unpricedToolCalls :one",
                  ExpressionAttributeValues: { ":one": N(1) },
                },
              },
              {
                Update: {
                  TableName: process.env.TABLE,
                  Key: key(
                    `USER#${identity.sub}`,
                    `DAY#${occurredAt.slice(0, 10)}`,
                  ),
                  UpdateExpression:
                    "ADD unpricedToolCalls :one SET gsi1pk = :index, gsi1sk = :sort, userSub = :user, #day = :day",
                  ExpressionAttributeNames: { "#day": "day" },
                  ExpressionAttributeValues: {
                    ":one": N(1),
                    ":index": S("USAGE_DAYS"),
                    ":sort": S(`${occurredAt.slice(0, 10)}#${identity.sub}`),
                    ":user": S(identity.sub),
                    ":day": S(occurredAt.slice(0, 10)),
                  },
                },
              },
              {
                Update: {
                  TableName: process.env.TABLE,
                  Key: requestKey,
                  UpdateExpression:
                    "ADD toolSteps :one SET lastMeteredAt = :time, meterKeys = list_append(if_not_exists(meterKeys, :empty), :keys)",
                  ConditionExpression: "#status = :running",
                  ExpressionAttributeNames: { "#status": "status" },
                  ExpressionAttributeValues: {
                    ":one": N(1),
                    ":time": S(occurredAt),
                    ":running": S("running"),
                    ":empty": { L: [] },
                    ":keys": {
                      L: [S(`USAGE#${occurredAt}#${requestId}#TOOL#${step}`)],
                    },
                  },
                },
              },
            ],
          }),
        );
      },
    };
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
    });
    const emit = (event) =>
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    const started = Date.now();
    try {
      const result = await runModel(
        turnConfig,
        model,
        messages,
        emit,
        workloadToken,
        {
          sub: identity.sub,
          projectId,
          agentId,
          sessionId,
          requestId,
          connectionIds: config.connectionIds || [],
          skills,
          files,
        },
        meter,
      );
      await meter.guard();
      const costMicroUsd = meteredCost;
      const occurredAt = new Date().toISOString();
      const receipt = {
        version: 1,
        requestId,
        projectId,
        branchId,
        agentId,
        conversationId: sessionId,
        modelId: turnModelId,
        occurredAt,
        usage: result.usage,
        costMicroUsd,
        rates: {
          inputRate: model.inputRate || 0,
          outputRate: model.outputRate || 0,
          cacheReadRate: model.cacheReadRate || 0,
          cacheWriteRate: model.cacheWriteRate || 0,
        },
        pricingQuality: model.pricingQuality || "unknown",
        toolCalls: result.toolCalls.map(
          ({ name, occurredAt, latencyMs, isError }) => ({
            name,
            occurredAt,
            latencyMs,
            isError,
          }),
        ),
      };
      const saveMemory = () =>
        memory.send(
          new CreateEventCommand({
            memoryId: process.env.MEMORY,
            actorId,
            sessionId: memorySessionId,
            eventTimestamp: new Date(),
            clientToken: requestId,
            extractionMode: "SKIP",
            ...(nativeBranchId !== "main" && {
              branch: {
                name: nativeBranchId,
                ...(forking && { rootEventId: forkEventId }),
              },
            }),
            payload: [
              { conversational: { role: "USER", content: { text: message } } },
              {
                conversational: {
                  role: "ASSISTANT",
                  content: { text: result.text },
                },
              },
              { json: { content: receipt } },
            ],
          }),
        );
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
        savedEvent = await saveMemory().catch((retryError) => {
          retryError.stage = "memory";
          throw retryError;
        });
      }
      await db
        .send(
          new UpdateItemCommand({
            TableName: process.env.TABLE,
            Key: requestKey,
            UpdateExpression:
              "SET #status = :written, eventId = :event, memorySessionId = :session",
            ConditionExpression: "#status = :running",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":written": S("memory_written"),
              ":running": S("running"),
              ":event": S(savedEvent.event.eventId),
              ":session": S(memorySessionId),
            },
          }),
        )
        .catch((error) => {
          error.stage = "navigation";
          throw error;
        });
      let archive;
      if (durable) {
        const objectKey = archiveObjectKey(
          identity.sub,
          projectId,
          sessionId,
          requestId,
        );
        const data = Buffer.from(
          JSON.stringify({ message, answer: result.text, receipt }),
        );
        const saved = await s3
          .send(
            new PutObjectCommand({
              Bucket: process.env.BUCKET,
              Key: objectKey,
              Body: data,
              ContentType: "application/json",
              ServerSideEncryption: "AES256",
            }),
          )
          .catch((error) => {
            error.stage = "archive";
            throw error;
          });
        archive = {
          objectKey,
          versionId: saved.VersionId,
          sizeBytes: data.length,
        };
      }
      try {
        const completion = [
          {
            Update: {
              TableName: process.env.TABLE,
              Key: requestKey,
              UpdateExpression:
                "SET #status = :complete, completedAt = :time" +
                (archive
                  ? ", archiveObjectKey = :archiveKey, archiveBytes = :archiveBytes"
                  : "") +
                " REMOVE pendingCommitJson",
              ConditionExpression: "#status IN (:written, :failed)",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":complete": S("completed"),
                ":written": S("memory_written"),
                ":failed": S("navigation_failed"),
                ":time": S(occurredAt),
                ...(archive && {
                  ":archiveKey": S(archive.objectKey),
                  ":archiveBytes": N(archive.sizeBytes),
                }),
              },
            },
          },
          ...(archive
            ? [
                {
                  Put: {
                    TableName: process.env.TABLE,
                    Item: {
                      ...archiveKey(
                        identity.sub,
                        projectId,
                        sessionId,
                        savedEvent.event.eventId,
                      ),
                      eventId: S(savedEvent.event.eventId),
                      requestId: S(requestId),
                      branchId: S(branchId),
                      parentEventId: (forking ? forkEventId : observedHead)
                        ? S(forking ? forkEventId : observedHead)
                        : { NULL: true },
                      objectKey: S(archive.objectKey),
                      memorySessionId: S(memorySessionId),
                      ...(archive.versionId && {
                        versionId: S(archive.versionId),
                      }),
                      sizeBytes: N(archive.sizeBytes),
                      createdAt: S(occurredAt),
                    },
                    ConditionExpression: "attribute_not_exists(pk)",
                  },
                },
                {
                  Update: {
                    TableName: process.env.TABLE,
                    Key: key(`USER#${identity.sub}`, "CONTROL"),
                    UpdateExpression: "ADD storageUsedBytes :bytes",
                    ExpressionAttributeValues: {
                      ":bytes": N(archive.sizeBytes),
                    },
                  },
                },
              ]
            : []),
          {
            Update: {
              TableName: process.env.TABLE,
              Key: key(
                projectKey(identity.sub, projectId),
                `CONVERSATION#${sessionId}`,
              ),
              UpdateExpression:
                "SET id = :id, agentId = :agent, title = if_not_exists(title, :title), createdAt = if_not_exists(createdAt, :time), lastActivityAt = :time, gsi1pk = :index, gsi1sk = :sort, activeBranchId = :branch, durable = :durable, #status = :active" +
                (durable ? "" : ", expiresAt = :expiry") +
                (branchId === "main"
                  ? ", mainHeadEventId = :head, mainMemorySessionId = :memorySession"
                  : "") +
                " ADD memorySessions :sessions",
              ConditionExpression:
                "(attribute_not_exists(#status) OR #status = :active) AND " +
                (branchId === "main"
                  ? `(attribute_not_exists(agentId) OR agentId = :agent) AND ${
                      conversationRow.Item?.mainHeadEventId
                        ? "mainHeadEventId = :previous"
                        : "attribute_not_exists(mainHeadEventId)"
                    }`
                  : "agentId = :agent"),
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":id": S(sessionId),
                ":agent": S(agentId),
                ":active": S("ACTIVE"),
                ":sessions": { SS: [memorySessionId] },
                ":branch": S(branchId),
                ":durable": { BOOL: durable },
                ...(branchId === "main" && {
                  ":head": S(savedEvent.event.eventId),
                  ":memorySession": S(memorySessionId),
                  ...(conversationRow.Item?.mainHeadEventId && {
                    ":previous": S(observedHead),
                  }),
                }),
                ":title": S(message.trim().replace(/\s+/g, " ").slice(0, 80)),
                ":time": S(occurredAt),
                ":index": S(`CONVERSATIONS#${identity.sub}/${projectId}`),
                ":sort": S(`${occurredAt}#${sessionId}`),
                ...(!durable && {
                  ":expiry": N(Math.floor(Date.now() / 1000) + 30 * 86400),
                }),
              },
            },
          },
          ...(branchId === "main"
            ? []
            : forking
              ? [
                  {
                    Put: {
                      TableName: process.env.TABLE,
                      Item: {
                        ...branchKey(
                          identity.sub,
                          projectId,
                          sessionId,
                          branchId,
                        ),
                        id: S(branchId),
                        name: S(
                          `Alternative ${new Date().toISOString().slice(11, 19)}`,
                        ),
                        rootEventId: forkEventId
                          ? S(forkEventId)
                          : { NULL: true },
                        ...(memorySessionId !== mainMemorySessionId && {
                          memorySessionId: S(memorySessionId),
                        }),
                        ...(nativeBranchId === "main" && {
                          memoryRoot: { BOOL: true },
                        }),
                        headEventId: S(savedEvent.event.eventId),
                        createdAt: S(occurredAt),
                      },
                      ConditionExpression: "attribute_not_exists(pk)",
                    },
                  },
                ]
              : [
                  {
                    Update: {
                      TableName: process.env.TABLE,
                      Key: branchKey(
                        identity.sub,
                        projectId,
                        sessionId,
                        branchId,
                      ),
                      UpdateExpression:
                        "SET headEventId = :head, memorySessionId = :session, memoryRoot = :root",
                      ConditionExpression: "headEventId = :previous",
                      ExpressionAttributeValues: {
                        ":head": S(savedEvent.event.eventId),
                        ":previous": S(observedHead),
                        ":session": S(memorySessionId),
                        ":root": { BOOL: nativeBranchId === "main" },
                      },
                    },
                  },
                ]),
        ];
        await db.send(
          new UpdateItemCommand({
            TableName: process.env.TABLE,
            Key: requestKey,
            UpdateExpression: "SET pendingCommitJson = :commit",
            ConditionExpression: "#status = :written",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":written": S("memory_written"),
              ":commit": S(JSON.stringify(completion)),
            },
          }),
        );
        await db.send(
          new TransactWriteItemsCommand({
            ClientRequestToken: requestId,
            TransactItems: completion,
          }),
        );
      } catch (error) {
        error.stage = "navigation";
        if (error.name === "TransactionCanceledException") {
          if (archive)
            await s3
              .send(
                new DeleteObjectCommand({
                  Bucket: process.env.BUCKET,
                  Key: archive.objectKey,
                  ...(archive.versionId && { VersionId: archive.versionId }),
                }),
              )
              .catch(() =>
                console.error("Could not remove uncommitted turn archive"),
              );
          await memory
            .send(
              new DeleteEventCommand({
                memoryId: process.env.MEMORY,
                actorId,
                sessionId: memorySessionId,
                eventId: savedEvent.event.eventId,
              }),
            )
            .catch(() =>
              console.error("Could not remove uncommitted Memory event"),
            );
          error.message = "Branch head changed";
        }
        throw error;
      }
      emit({
        type: "message.done",
        requestId,
        conversationId: sessionId,
        branchId,
        eventId: savedEvent.event.eventId,
        usage: result.usage,
        costMicroUsd,
        unpricedToolCalls: result.toolCalls.length,
        latencyMs: Date.now() - started,
      });
    } catch (error) {
      await db
        .send(
          new UpdateItemCommand({
            TableName: process.env.TABLE,
            Key: requestKey,
            UpdateExpression:
              "SET #status = :failed, failureStage = :stage, failedAt = :time",
            ConditionExpression: "#status <> :complete",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":failed": S(
                error.code === "CANCELLED"
                  ? "cancelled"
                  : error.stage === "memory"
                    ? "memory_failed"
                    : error.stage === "navigation"
                      ? "navigation_failed"
                      : "outcome_unknown",
              ),
              ":stage": S(error.stage || "provider_or_tool"),
              ":time": S(new Date().toISOString()),
              ":complete": S("completed"),
            },
          }),
        )
        .catch(() => console.error("Could not mark failed request"));
      console.error(
        "Chat failed",
        error.name,
        error.$metadata?.httpStatusCode || "",
        error.stage || "provider_or_tool",
      );
      const message =
        error.code === "CANCELLED"
          ? "Turn cancelled. Observed usage is retained."
          : error.code === "ACCESS_REVOKED"
            ? "Access changed. This turn stopped."
            : error.name === "AccessDeniedException"
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
      emit({
        type: "error",
        message,
        ...(process.env.SCRIPTED_MODEL === "true" && {
          diagnostic: error.name,
          stage: error.stage,
        }),
      });
    } finally {
      response.end();
    }
  }

  return chat;
}
