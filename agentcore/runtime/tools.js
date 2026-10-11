// The tools a turn may use: an isolated code workspace (with optional granted
// connections, selected files and skills), saving workspace outputs to Files,
// public web search through the Gateway, and an isolated browser. Each call is
// metered as it finishes, and each managed session's lifetime when it closes.
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { SignatureV4 } from "@smithy/signature-v4";
import { Hash } from "@smithy/hash-node";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import {
  InvokeBrowserCommand,
  InvokeCodeInterpreterCommand,
  StartBrowserSessionCommand,
  StartCodeInterpreterSessionCommand,
  StopBrowserSessionCommand,
  StopCodeInterpreterSessionCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { storage } from "./accounts.js";
import { agentcore } from "./aws.js";
import { resolveConnections } from "./credentials.js";
import { fail, get, uuid } from "./db.js";
import {
  completeStaged,
  downloadUrl,
  objectKey,
  objectView,
  presignUpload,
  repairPending,
  stage,
  validContentType,
  validName,
} from "./objects.js";

const maxToolCalls = 8;
const browserId = "aws.browser.v1";
const shellQuote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

async function interpreterCall(sessionId, name, args) {
  const response = await agentcore.send(
    new InvokeCodeInterpreterCommand({
      codeInterpreterIdentifier: process.env.CODE_INTERPRETER_ID,
      sessionId,
      name,
      arguments: args,
    }),
  );
  let output = "",
    isError = false;
  for await (const event of response.stream) {
    if (!event.result) continue;
    const structured = event.result.structuredContent;
    const text = (event.result.content || [])
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    output = (
      output +
      (structured?.stdout || "") +
      (structured?.stderr || "") +
      (structured?.stdout || structured?.stderr ? "" : text)
    ).slice(0, 8000);
    isError ||= event.result.isError === true;
  }
  return { output, isError };
}

// Writes the session's .env (granted secrets as base64, which is serialization,
// not encryption), the selected-files manifest and skill files. Returns what
// must be redacted from any output.
async function initializeWorkspace(sessionId, scope) {
  const granted = Object.values(
    await resolveConnections({ sub: scope.sub }, scope.connectionIds),
  );
  const secrets = {};
  for (const item of granted) {
    if (item.kind === "github") secrets.GITHUB_TOKEN = item.apiKey;
    if (item.kind === "jira") {
      secrets.JIRA_API_TOKEN = item.apiKey;
      secrets.JIRA_URL = item.jiraUrl;
      secrets.JIRA_EMAIL = item.jiraEmail;
    }
  }
  const manifest = await Promise.all(
    scope.files.map(async (item) => ({
      id: item.id,
      name: item.name,
      sizeBytes: item.sizeBytes,
      url: await downloadUrl(item, 900),
    })),
  );
  const variables = {
    AGENTCORE_USER_ID: scope.sub,
    AGENTCORE_PROJECT_ID: scope.projectId,
    AGENTCORE_AGENT_ID: scope.agentId,
    AGENTCORE_CHAT_ID: scope.conversationId,
    AWS_REGION: process.env.AWS_REGION,
    AWS_DEFAULT_REGION: process.env.AWS_REGION,
  };
  for (const [name, value] of Object.entries(secrets))
    variables[`${name}_B64`] = Buffer.from(value, "utf8").toString("base64");
  const env =
    Object.entries(variables)
      .map(([name, value]) => {
        if (!/^[A-Za-z0-9._:/+=-]+$/.test(value || ""))
          throw Error("Invalid workspace context");
        return `${name}=${value}`;
      })
      .join("\n") + "\n";
  const written = await interpreterCall(sessionId, "writeFiles", {
    content: [
      { path: ".env", text: env },
      ...(manifest.length
        ? [{ path: "selected-files.json", text: JSON.stringify(manifest) }]
        : []),
      ...scope.skills.map((skill) => ({
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
    names: Object.keys(secrets),
    redact: [
      ...Object.values(secrets),
      ...granted
        .filter((item) => item.kind === "jira")
        .map((item) => `${item.jiraEmail}:${item.apiKey}`),
      ...manifest.map((item) => item.url),
      JSON.stringify(manifest),
    ],
  };
}

// Saves one workspace file under outputs/ as a quota-counted artifact. The id
// derives from the request and idempotency key, so a retried save converges.
async function saveArtifact(sessionId, scope, input) {
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
    !validName(name) ||
    !validContentType(contentType) ||
    typeof idempotencyKey !== "string" ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(idempotencyKey)
  )
    fail("INVALID_ARTIFACT");
  const displayName = name.trim();
  const digest = createHash("sha256")
    .update(`artifact:${scope.sub}:${scope.requestId}:${idempotencyKey}`)
    .digest("hex");
  const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
  let item = await get(objectKey(scope.sub, scope.projectId, id));
  if (item) {
    if (
      item.requestId !== scope.requestId ||
      item.saveKey !== idempotencyKey ||
      item.name !== displayName ||
      item.contentType !== contentType ||
      item.sourcePath !== path
    )
      fail("ARTIFACT_CONFLICT");
    item = await repairPending(scope.sub, item);
    if (item.status === "ACTIVE") return objectView(item);
    try {
      return objectView(
        await completeStaged(scope.sub, item, item.declaredBytes),
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
    fail("ARTIFACT_FILE_UNAVAILABLE");
  const current = await storage(scope.sub);
  if (current.usedBytes + size > current.limitBytes) fail("QUOTA_EXCEEDED");
  if (!item) {
    const staged = await stage(scope.sub, {
      id,
      projectId: scope.projectId,
      name: displayName,
      kind: "artifact",
      contentType,
      declaredBytes: size,
      requestId: scope.requestId,
      saveKey: idempotencyKey,
      sourcePath: path,
    });
    if (!staged.created) {
      const raced = await get(objectKey(scope.sub, scope.projectId, id));
      if (raced?.status === "ACTIVE") return objectView(raced);
      fail("ARTIFACT_CONFLICT");
    }
    item = staged.row;
  } else if (item.declaredBytes !== size) fail("ARTIFACT_CONFLICT");
  const upload = await presignUpload(item.stageKey, contentType, size);
  const fields = Object.entries(upload.fields)
    .map(([field, value]) => `--form-string ${shellQuote(`${field}=${value}`)}`)
    .join(" ");
  const sent = await interpreterCall(sessionId, "executeCommand", {
    command: `curl --fail --silent --show-error --max-time 120 --output /dev/null --write-out '%{http_code}' ${fields} --form ${shellQuote(`file=@${path};type=${contentType}`)} ${shellQuote(upload.url)}`,
  });
  if (sent.isError || !/^(200|201|204)$/.test(sent.output.trim()))
    fail("ARTIFACT_OUTCOME_UNKNOWN");
  return objectView(await completeStaged(scope.sub, item, size));
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
  if (!response.ok) throw Error(`Web Search gateway returned ${response.status}`);
  const payload = JSON.parse(
    raw.startsWith("data:")
      ? raw
          .split("\n")
          .find((line) => line.startsWith("data:"))
          .slice(5)
      : raw,
  );
  if (payload.error || payload.result?.isError)
    throw Error("Web Search was unavailable");
  const result = payload.result || payload;
  const text = result.content?.find((item) => item.type === "text")?.text;
  const results =
    result.structuredContent?.results || (text ? JSON.parse(text).results : []);
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

// Managed Browser answers 409 while a session is still changing state.
async function browserSend(command) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await agentcore.send(command);
    } catch (error) {
      if (error.name !== "ConflictException" || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
}
const viewport = { width: 1000, height: 700 };
async function browserAction(sessionId, input) {
  const { action } = input;
  const invoke = async (operation) => {
    const part = Object.values(
      (
        await browserSend(
          new InvokeBrowserCommand({
            browserIdentifier: browserId,
            sessionId,
            action: operation,
          }),
        )
      ).result || {},
    )[0];
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
    // Clicks stay two pixels inside the viewport edge.
    if (
      !Number.isInteger(input.x) ||
      input.x < 2 ||
      input.x > viewport.width - 3 ||
      !Number.isInteger(input.y) ||
      input.y < 2 ||
      input.y > viewport.height - 3
    )
      throw Error("Invalid browser coordinates");
    await invoke({ mouseClick: { x: input.x, y: input.y } });
  } else if (action === "type") {
    if (typeof input.text !== "string" || !input.text || input.text.length > 2000)
      throw Error("Invalid browser text");
    await invoke({ keyType: { text: input.text } });
  } else if (action === "scroll") {
    if (!Number.isInteger(input.deltaY) || Math.abs(input.deltaY) > 1000)
      throw Error("Invalid browser scroll");
    await invoke({
      mouseScroll: {
        x: viewport.width / 2,
        y: viewport.height / 2,
        deltaY: input.deltaY,
      },
    });
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

export function toolSpecs(config) {
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
            properties: { command: { type: "string" } },
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
          properties: { query: { type: "string" } },
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

export function instructions(config) {
  return [
    config.systemPrompt,
    ...config.skills.map(
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

const saveMessages = {
  INVALID_ARTIFACT: "Invalid output path, name, MIME type, or idempotency key.",
  ARTIFACT_CONFLICT:
    "That idempotency key belongs to a different or removed output.",
  ARTIFACT_FILE_UNAVAILABLE:
    "Create a regular file under outputs/ first (100 MB maximum).",
  QUOTA_EXCEEDED: "The storage limit was reached; the output was not admitted.",
  ARTIFACT_OUTCOME_UNKNOWN:
    "The save outcome is unknown. Check Files before another attempt with the same idempotency key.",
  UPLOAD_MISSING: "The upload did not complete. Retry with the same idempotency key.",
  UPLOAD_SIZE_MISMATCH:
    "The uploaded size changed. Retry with the same idempotency key.",
};

// Code a tool runs gets the granted secrets decoded from their _B64 form.
function decodedEnvironment(names) {
  if (!names.length) return { python: "", node: "", shell: "" };
  return {
    python: `import os, base64
for _name in ${JSON.stringify(names)}:
    os.environ[_name] = base64.b64decode(os.environ.pop(_name + "_B64")).decode("utf-8")
`,
    node: `for (const name of ${JSON.stringify(names)}) {
  process.env[name] = Buffer.from(process.env[name + "_B64"], "base64").toString("utf8");
  delete process.env[name + "_B64"];
}
`,
    shell: names
      .map(
        (name) =>
          `export ${name}="$(printf '%s' "$${name}_B64" | base64 -d)"; unset ${name}_B64; `,
      )
      .join(""),
  };
}

// One turn's tool state. `execute` validates, runs and meters a call; `close`
// stops managed sessions and meters their lifetimes.
export function toolSession(config, scope, { emit, guard, meter }) {
  const specs = toolSpecs(config);
  const calls = [];
  const sources = new Map();
  const sessions = { code: null, browser: null };
  let workspace;
  const accepts = {
    execute_code: (input) =>
      config.codeInterpreter &&
      ["python", "javascript", "typescript"].includes(input?.language) &&
      typeof input.code === "string" &&
      input.code.length <= 20000,
    execute_command: (input) =>
      config.codeInterpreter &&
      typeof input?.command === "string" &&
      input.command.length <= 20000,
    web_search: (input) =>
      config.webSearch &&
      typeof input?.query === "string" &&
      input.query.trim().length > 0 &&
      input.query.length <= 200,
    browser: (input) =>
      config.browser &&
      ["navigate", "click", "type", "scroll", "screenshot"].includes(
        input?.action,
      ),
    save_artifact: (input) =>
      config.codeInterpreter &&
      config.allowSaveOutputs &&
      input &&
      typeof input === "object",
  };
  async function codeSession() {
    if (sessions.code) return sessions.code.id;
    if (!process.env.CODE_INTERPRETER_ID) throw Error("Code workspace unavailable");
    const started = Date.now();
    const id = (
      await agentcore.send(
        new StartCodeInterpreterSessionCommand({
          codeInterpreterIdentifier: process.env.CODE_INTERPRETER_ID,
          name: `chat-${uuid().slice(0, 8)}`,
          clientToken: uuid(),
          sessionTimeoutSeconds: 900,
        }),
      )
    ).sessionId;
    sessions.code = { id, started };
    workspace = await initializeWorkspace(id, scope);
    return id;
  }
  async function browserSession() {
    if (sessions.browser) return sessions.browser.id;
    const started = Date.now();
    const id = (
      await browserSend(
        new StartBrowserSessionCommand({
          browserIdentifier: browserId,
          name: `chat-${uuid().slice(0, 8)}`,
          clientToken: uuid(),
          sessionTimeoutSeconds: config.browserSessionSeconds,
          viewPort: viewport,
        }),
      )
    ).sessionId;
    sessions.browser = { id, started };
    return id;
  }
  async function run(name, input) {
    if (name === "web_search") {
      const result = await searchWeb(
        input.query.trim(),
        config.webSearchMaxResults,
      );
      for (const { url, title } of result.sources) sources.set(url, title);
      return [{ text: result.text }];
    }
    if (name === "browser")
      return browserAction(await browserSession(), input);
    if (name === "save_artifact") {
      if (!sessions.code) fail("ARTIFACT_FILE_UNAVAILABLE");
      const saved = await saveArtifact(sessions.code.id, scope, input);
      return [
        {
          text: `Saved ${saved.name} in Files (id ${saved.id}, ${saved.sizeBytes} bytes).`,
        },
      ];
    }
    const sessionId = await codeSession();
    const env = decodedEnvironment(workspace.names);
    const isCode = name === "execute_code";
    const result = await interpreterCall(
      sessionId,
      isCode ? "executeCode" : "executeCommand",
      isCode
        ? {
            language: input.language,
            runtime: input.language === "python" ? "python" : "nodejs",
            code:
              input.language === "python"
                ? `from dotenv import load_dotenv\nload_dotenv(${JSON.stringify(workspace.path)}, override=True)\n${env.python}${input.code}`
                : `process.loadEnvFile(${JSON.stringify(workspace.path)});\n${env.node}${input.code}`,
          }
        : {
            command: `set -a; . ${shellQuote(workspace.path)}; set +a; ${env.shell}timeout 120s sh -lc ${shellQuote(input.command)}`,
          },
    );
    const output = workspace.redact.reduce(
      (text, value) =>
        text
          .replaceAll(value, "[redacted]")
          .replaceAll(Buffer.from(value, "utf8").toString("base64"), "[redacted]"),
      result.output || "(no output)",
    );
    if (result.isError) throw Object.assign(Error("Tool reported an error"), { output });
    return [{ text: output }];
  }
  async function execute(name, input) {
    await guard();
    if (calls.length >= maxToolCalls) throw Error("Agent tool call limit reached");
    if (!accepts[name]?.(input)) fail("INVALID_TOOL_REQUEST");
    const started = Date.now();
    let content,
      isError = false;
    try {
      content = await run(name, input);
    } catch (error) {
      isError = true;
      if (error.output !== undefined) content = [{ text: error.output }];
      else {
        console.error(
          "Tool failed",
          name,
          error.name,
          error.$metadata?.httpStatusCode || "",
        );
        content = [
          {
            text:
              name === "save_artifact"
                ? saveMessages[error.code] ||
                  "Output save could not complete; check Files before retrying."
                : name === "web_search"
                  ? "Web Search could not complete that action."
                  : name === "browser"
                    ? "Browser could not complete that action."
                    : "The code workspace could not run that request.",
          },
        ];
      }
    } finally {
      const call = { name, latencyMs: Date.now() - started, isError };
      calls.push(call);
      await meter.tool(call);
      emit({ type: "tool.done", name, isError });
    }
    return { content, isError };
  }
  const citations = () =>
    sources.size
      ? "\n\nSources:\n" +
        [...sources].map(([url, title]) => `- ${title}: ${url}`).join("\n")
      : "";
  async function close() {
    const stops = [
      sessions.browser &&
        browserSend(
          new StopBrowserSessionCommand({
            browserIdentifier: browserId,
            sessionId: sessions.browser.id,
          }),
        ).then(
          () => ({ name: "browser_session", session: sessions.browser, ok: true }),
          () => ({ name: "browser_session", session: sessions.browser, ok: false }),
        ),
      sessions.code &&
        agentcore
          .send(
            new StopCodeInterpreterSessionCommand({
              codeInterpreterIdentifier: process.env.CODE_INTERPRETER_ID,
              sessionId: sessions.code.id,
            }),
          )
          .then(
            () => ({ name: "code_session", session: sessions.code, ok: true }),
            () => ({ name: "code_session", session: sessions.code, ok: false }),
          ),
    ].filter(Boolean);
    // Managed sessions bill by lifetime; a failed stop keeps billing until the
    // session's own timeout, so it is recorded as an error.
    for (const stopped of await Promise.all(stops)) {
      if (!stopped.ok) console.error("Could not stop managed session", stopped.name);
      await meter
        .tool({
          name: stopped.name,
          latencyMs: Date.now() - stopped.session.started,
          isError: !stopped.ok,
        })
        .catch(() => console.error("Could not meter managed session"));
    }
  }
  return { specs, calls, execute, citations, close };
}

