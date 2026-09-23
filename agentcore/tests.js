// Imported by index.html only for ?test=1, or explicitly by the browser-story runner.
export async function _screenshot(name, element = undefined, options = {}) {
  if (typeof window.__captureScreenshot !== "function") {
    throw new Error("_screenshot requires the Playwright browser-story runner");
  }
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    throw new Error("Screenshot names must be short kebab-case labels");
  }
  await document.fonts.ready;
  let targetId = null;
  if (element !== undefined) {
    if (
      !(element instanceof Element) ||
      !element.isConnected ||
      !element.getClientRects().length
    ) {
      throw new Error(
        "Screenshot target must be a visible, connected DOM element",
      );
    }
    targetId = crypto.randomUUID();
    element.setAttribute("data-screenshot-target", targetId);
  }
  try {
    return await window.__captureScreenshot({
      name,
      targetId,
      fullPage: options.fullPage === true,
    });
  } finally {
    if (
      targetId &&
      element?.getAttribute("data-screenshot-target") === targetId
    ) {
      element.removeAttribute("data-screenshot-target");
    }
  }
}

export async function runTests(api) {
  const selectedStory = new URLSearchParams(location.search).get("story");
  if (selectedStory && selectedStory !== "shell") {
    return { passed: 0, failed: 1, message: `Unknown story: ${selectedStory}` };
  }
  const tests = [
    [
      "deployment rejects malformed input",
      () => {
        if (api.parseDeployment("not-json") !== null)
          throw new Error("Malformed descriptor accepted");
        if (
          api.parseDeployment({
            region: "us-east-1",
            stack: "chat-dev",
            pool: "us-east-1_abc",
            client: "client",
            scope: "chat-api/access",
            domain: "https://example.com",
            runtime: "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/evil",
          }) !== null
        )
          throw new Error("Cross-region Runtime destination accepted");
      },
    ],
    [
      "runtime dependencies are pinned and integrity checked",
      () => {
        const map = JSON.parse(
          document.querySelector('script[type="importmap"]').textContent,
        );
        for (const url of Object.values(map.imports)) {
          if (
            !url.includes("solid-js@1.9.15/") ||
            !/^sha384-/.test(map.integrity[url] || "")
          )
            throw new Error("Unpinned or unchecked runtime module: " + url);
        }
        const policy = document.getElementById("app-csp")?.content || "";
        if (
          !policy.includes("script-src") ||
          policy.includes("'unsafe-inline'")
        )
          throw new Error(
            "Static page CSP is missing or allows inline scripts",
          );
      },
    ],
    [
      "disconnected shell renders",
      () => {
        if (!document.querySelector("[data-app-state='disconnected']"))
          throw new Error("Shell missing");
      },
    ],
    [
      "one routed dialog opens and closes",
      async () => {
        document.querySelector("[data-action='open-deployment']")?.click();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        if (document.querySelectorAll("[role='dialog'][open]").length !== 1)
          throw new Error("Expected one open dialog");
        document.querySelector("[data-action='close-dialog']")?.click();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        if (document.querySelector("[role='dialog'][open]"))
          throw new Error("Dialog did not close");
      },
    ],
    [
      "shell story",
      async () => {
        if (window.__captureScreenshot)
          await _screenshot("workspace", undefined, { fullPage: true });
        document.querySelector("[data-action='open-deployment']").click();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const deployment = document.querySelector("dialog[open]");
        if (
          !deployment ||
          !deployment.textContent.includes("Deployment entry URL")
        )
          throw new Error("Deployment dialog missing");
        if (window.__captureScreenshot)
          await _screenshot("deployment-dialog", deployment);
        document.querySelector("[data-action='close-dialog']").click();
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
        if (innerWidth < 761) {
          document.querySelector("[aria-label='Open menu']").click();
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
          const menu = document.querySelector("dialog[open]");
          if (!menu || !menu.textContent.includes("Workspace menu"))
            throw new Error("Mobile menu missing");
          if (window.__captureScreenshot)
            await _screenshot("mobile-menu", menu);
          document.querySelector("[data-action='close-dialog']").click();
        }
      },
    ],
  ];
  let passed = 0;
  let failed = 0;
  for (const [name, test] of tests) {
    try {
      await test();
      console.log(`PASS: ${name}`);
      passed++;
    } catch (error) {
      console.error(`FAIL: ${name}: ${error.message}`);
      failed++;
    }
  }
  return { passed, failed };
}

// Node-only live story hook used by the shared root test.js runner. It makes a
// disposable Cognito identity; the browser still drives the real hosted login.
export async function createLiveFixture({ stackName, profile, region }) {
  const [
    { fromIni },
    cloudformation,
    cognito,
    dynamodb,
    memoryApi,
    { randomUUID, randomBytes },
  ] = await Promise.all([
    import("@aws-sdk/credential-providers"),
    import("@aws-sdk/client-cloudformation"),
    import("@aws-sdk/client-cognito-identity-provider"),
    import("@aws-sdk/client-dynamodb"),
    import("@aws-sdk/client-bedrock-agentcore"),
    import("node:crypto"),
  ]);
  const credentials = fromIni({ profile });
  const cf = new cloudformation.CloudFormationClient({ region, credentials });
  const idp = new cognito.CognitoIdentityProviderClient({
    region,
    credentials,
  });
  const db = new dynamodb.DynamoDBClient({ region, credentials });
  const memory = new memoryApi.BedrockAgentCoreClient({ region, credentials });
  const result = await cf.send(
    new cloudformation.DescribeStacksCommand({ StackName: stackName }),
  );
  const stack = result.Stacks?.[0];
  if (!["CREATE_COMPLETE", "UPDATE_COMPLETE"].includes(stack?.StackStatus))
    throw new Error("Live stack must be stable");
  const outputs = Object.fromEntries(
    stack.Outputs.map(({ OutputKey, OutputValue }) => [OutputKey, OutputValue]),
  );
  const parameters = Object.fromEntries(
    stack.Parameters.map(({ ParameterKey, ParameterValue }) => [
      ParameterKey,
      ParameterValue,
    ]),
  );
  const email = "smoke-" + randomUUID().slice(0, 12) + "@example.com";
  const password = "A1!" + randomBytes(22).toString("base64url");
  const pool = outputs.UserPoolId;
  const entry = new URL(outputs.ApplicationEntryUrl);
  const local = new URL(
    parameters.LocalUrl || "http://localhost:8000/agentcore/",
  );
  entry.protocol = local.protocol;
  entry.host = local.host;
  entry.pathname = local.pathname;
  let created = false;
  let sub;
  const chatSessions = [];
  const cleanup = async () => {
    if (sub) {
      for (const sessionId of chatSessions) {
        const scope = { memoryId: outputs.MemoryArn, actorId: `${sub}/main`, sessionId };
        const page = await memory.send(new memoryApi.ListEventsCommand(scope));
        for (const event of page.events || [])
          await memory.send(new memoryApi.DeleteEventCommand({ ...scope, eventId: event.eventId }));
      }
      for (const pk of [`USER#${sub}`, `PROJECT#${sub}/main`]) {
        let nextToken;
        do {
          const page = await db.send(new dynamodb.QueryCommand({
            TableName: outputs.DataTable,
            KeyConditionExpression: "pk = :pk",
            ExpressionAttributeValues: { ":pk": { S: pk } },
            ExclusiveStartKey: nextToken,
          }));
          for (const item of page.Items || [])
            await db.send(new dynamodb.DeleteItemCommand({
              TableName: outputs.DataTable,
              Key: { pk: item.pk, sk: item.sk },
            }));
          nextToken = page.LastEvaluatedKey;
        } while (nextToken);
      }
    }
    if (created)
      await idp.send(new cognito.AdminDeleteUserCommand({ UserPoolId: pool, Username: email }));
  };
  try {
    const createdUser = await idp.send(
      new cognito.AdminCreateUserCommand({
        UserPoolId: pool,
        Username: email,
        MessageAction: "SUPPRESS",
        UserAttributes: [
          { Name: "email", Value: email },
          { Name: "email_verified", Value: "true" },
        ],
      }),
    );
    created = true;
    sub = createdUser.User?.Attributes?.find(
      (attribute) => attribute.Name === "sub",
    )?.Value;
    await idp.send(
      new cognito.AdminSetUserPasswordCommand({
        UserPoolId: pool,
        Username: email,
        Password: password,
        Permanent: true,
      }),
    );
    await idp.send(
      new cognito.AdminAddUserToGroupCommand({
        UserPoolId: pool,
        Username: email,
        GroupName: "Administrators",
      }),
    );
  } catch (error) {
    await cleanup();
    throw error;
  }
  const readUserControl = async () =>
    (
      await db.send(
        new dynamodb.GetItemCommand({
          TableName: outputs.DataTable,
          Key: { pk: { S: "USER#" + sub }, sk: { S: "CONTROL" } },
          ConsistentRead: true,
        }),
      )
    ).Item;
  const controllerUrl = outputs.ControllerArn
    ? `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/${encodeURIComponent(outputs.ControllerArn)}/invocations?qualifier=DEFAULT`
    : null;
  return {
    entryUrl: entry.href,
    email,
    password,
    cleanup,
    readUserControl,
    controllerUrl,
    trackChat: (agentId, sessionId) => chatSessions.push(`a_${agentId}_${sessionId}`),
    readChat: async (agentId, sessionId) => memory.send(new memoryApi.ListEventsCommand({
      memoryId: outputs.MemoryArn, actorId: `${sub}/main`,
      sessionId: `a_${agentId}_${sessionId}`, includePayloads: true,
    })),
    readUsage: async () => db.send(new dynamodb.QueryCommand({
      TableName: outputs.DataTable,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :usage)",
      ExpressionAttributeValues: { ":pk": { S: `USER#${sub}` }, ":usage": { S: "USAGE#" } },
      ConsistentRead: true,
    })),
  };
}

export async function runLiveStory(page, fixture, { story, screenshot }) {
  if (story && !["login", "runtime", "runtime-chat", "runtime-tool", "runtime-ui", "runtime-model", "runtime-benchmark"].includes(story))
    throw new Error("Unknown live story: " + story);
  if (["runtime", "runtime-chat", "runtime-tool", "runtime-ui", "runtime-model", "runtime-benchmark"].includes(story) && !fixture.controllerUrl)
    throw new Error("Live stack has no ControllerArn");
  const uiInvocations = [];
  page.on("request", (request) => {
    if (!request.url().includes("/runtimes/")) return;
    const body = request.postDataJSON();
    if (story === "runtime-ui" && body?.command === "chat.send")
      fixture.trackChat(body.input.agentId, body.input.sessionId);
    uiInvocations.push({ command: body?.command, input: body?.input,
      runtimeSession: request.headers()["x-amzn-bedrock-agentcore-runtime-session-id"] });
  });
  const tokenResponse =
    ["runtime", "runtime-chat", "runtime-tool", "runtime-model", "runtime-benchmark"].includes(story)
      ? page.waitForResponse((response) =>
          response.url().includes("/oauth2/token"),
        )
      : null;
  await page.locator('input[type="password"]').waitFor({ timeout: 30000 });
  const identity = page.locator('input[type="email"], input[name="username"]');
  await identity.first().fill(fixture.email);
  await page.locator('input[type="password"]').first().fill(fixture.password);
  await page
    .locator('button[type="submit"], input[type="submit"]')
    .first()
    .click();
  await page.locator('[data-app-state="ready"]').waitFor({ timeout: 45000 });
  if (uiInvocations.length !== 1 || uiInvocations[0].command !== "workspace.get" ||
    !uiInvocations[0].runtimeSession)
    throw new Error("Sign-in must load the workspace in one sticky Runtime invocation");
  if (story === "runtime-ui") {
    const chooseConversation = async (name) => {
      if (page.viewportSize().width < 761) {
        await page.getByRole("button", { name: "Open menu" }).click();
        await page.getByRole("dialog").getByRole("button", { name }).first().click();
      } else {
        await page.getByRole("button", { name }).first().click();
      }
    };
    await page.getByRole("button", { name: "Choose an agent" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("#agent-model option[value='test.echo']").waitFor({ state: "attached" });
    await dialog.locator("#agent-model option[value='global.openai.gpt-6-luna']")
      .waitFor({ state: "attached" });
    if (!(await dialog.locator("#agent-model option[value='gemini-3.8-flash']").isDisabled()))
      throw new Error("Gemini must remain disabled until its adapter exists");
    if (screenshot)
      await page.evaluate(async () => {
        const { _screenshot } = await import("./tests.js");
        await _screenshot("live-agent-models", document.querySelector("dialog[open]"));
      });
    await dialog.locator("#agent-name").fill("Smoke UI agent");
    await dialog.locator("#agent-model").selectOption("test.echo");
    await dialog.getByRole("button", { name: "Create agent" }).click();
    await dialog.waitFor({ state: "hidden" });
    const message = page.locator('textarea[aria-label="Message"]');
    await message.fill("hello ui");
    await page.getByRole("button", { name: "Send ↑" }).click();
    await page.locator(".message-text").getByText("Echo: hello ui").waitFor();
    await page.getByRole("button", { name: "Send ↑" }).waitFor();
    await chooseConversation("New chat");
    await message.fill("second ui");
    await page.getByRole("button", { name: "Send ↑" }).click();
    await page.locator(".message-text").getByText("Echo: second ui").waitFor();
    await page.getByRole("button", { name: "Send ↑" }).waitFor();
    await chooseConversation("hello ui");
    await page.locator(".message-text").getByText("Echo: hello ui").waitFor();
    const chats = uiInvocations.filter((item) => item.command === "chat.send");
    if (chats.length !== 2 || chats[0].input.sessionId === chats[1].input.sessionId ||
      uiInvocations.some((item) => item.command === "agents.list") ||
      uiInvocations.some((item) => item.runtimeSession !== uiInvocations[0].runtimeSession))
      throw new Error("UI did not reuse one Runtime session across control and conversations");
    await page.reload();
    await page.locator('[data-app-state="ready"]').waitFor({ timeout: 45000 });
    await chooseConversation("hello ui");
    await page.locator(".message-text").getByText("Echo: hello ui").waitFor();
    if (!uiInvocations.some((item) => item.command === "conversations.get" &&
      item.input.conversationId === chats[0].input.sessionId))
      throw new Error("Reload did not reopen saved Memory events");
    if (screenshot)
      await page.evaluate(async () => {
        const { _screenshot } = await import("./tests.js");
        await _screenshot("live-chat", undefined, { fullPage: true });
      });
    return;
  }
  if (["runtime", "runtime-chat", "runtime-tool", "runtime-model", "runtime-benchmark"].includes(story)) {
    const accessToken = (await (await tokenResponse).json()).access_token;
    if (!accessToken) throw new Error("Cognito access token missing");
    if (story === "runtime-model") {
      const catalog = (await import("./models.json", { with: { type: "json" } })).default;
      const selected = process.env.AGENTCORE_TEST_MODEL;
      if (selected && !catalog.some((model) => model.transport === "bedrock" && model.id === selected))
        throw new Error("AGENTCORE_TEST_MODEL must name a checked-in Bedrock model");
      for (const { id: modelId } of catalog.filter((model) =>
        model.transport === "bedrock" && (!selected || model.id === selected))) {
      const ids = await page.evaluate(async ({ url, token, modelId }) => {
        const response = await fetch(url, { method: "POST", headers: {
          authorization: `Bearer ${token}`, "content-type": "application/json",
          "x-amzn-bedrock-agentcore-runtime-session-id": `model-${crypto.randomUUID()}`,
        }, body: JSON.stringify({ v: 1, command: "agents.put", input: {
          projectId: "main", name: "Capped model smoke", modelId, maxOutputTokens: 64,
        } }) });
        if (!response.ok) throw Error("Could not create model smoke agent");
        return { agentId: (await response.json()).data.id, sessionId: crypto.randomUUID() };
      }, { url: fixture.controllerUrl, token: accessToken, modelId });
      fixture.trackChat(ids.agentId, ids.sessionId);
      const result = await page.evaluate(async ({ url, token, ids }) => {
        const started = performance.now();
        const response = await fetch(url, { method: "POST", headers: {
          authorization: `Bearer ${token}`, "content-type": "application/json",
          "x-amzn-bedrock-agentcore-runtime-session-id": `model-${crypto.randomUUID()}`,
        }, body: JSON.stringify({ v: 1, command: "chat.send", input: {
          projectId: "main", ...ids, requestId: crypto.randomUUID(),
          message: "Reply with OK only.",
        } }) });
        return { status: response.status, stream: await response.text(),
          elapsedMs: Math.round(performance.now() - started) };
      }, { url: fixture.controllerUrl, token: accessToken, ids });
      if (result.status !== 200 || !result.stream.includes('"type":"message.done"'))
        throw new Error("Real-model turn incomplete: " + result.stream.slice(-1000));
      const usage = await fixture.readUsage();
      if (!(usage.Items || []).some((row) => row.modelId?.S === modelId))
        throw new Error("Real-model usage row missing");
      console.log("REAL_MODEL " + JSON.stringify({ modelId, elapsedMs: result.elapsedMs }));
      }
      return;
    }
    if (story === "runtime-benchmark") {
      const sample = await page.evaluate(async ({ runtimeUrl, token }) => {
        const runtimeSession = `bench-${crypto.randomUUID()}`;
        const call = async (command, input) => {
          const start = performance.now();
          const response = await fetch(runtimeUrl, { method: "POST", headers: {
            authorization: `Bearer ${token}`, "content-type": "application/json",
            "x-amzn-bedrock-agentcore-runtime-session-id": runtimeSession,
          }, body: JSON.stringify({ v: 1, command, input }) });
          const data = await response.json();
          if (!response.ok || !data.ok) throw Error(`${command}: ${response.status}`);
          return { ms: performance.now() - start, data: data.data };
        };
        const coldRuntimeMs = (await call("workspace.get", {})).ms;
        const controls = [];
        for (let i = 0; i < 8; i++)
          controls.push((await call("session.get", {})).ms);
        const signIn = { separate: [], workspace: [] };
        for (let i = 0; i < 5; i++) {
          const start = performance.now();
          await call("session.get", {});
          await call("agents.list", { projectId: "main" });
          signIn.separate.push(performance.now() - start);
          signIn.workspace.push((await call("workspace.get", {})).ms);
        }
        const usageView = { parallel: [], combined: [] };
        for (let i = 0; i < 5; i++) {
          const start = performance.now();
          await Promise.all([call("usage.summary", {}),
            call("usage.list", { range: "30d" })]);
          usageView.parallel.push(performance.now() - start);
          usageView.combined.push((await call("usage.get", { range: "30d" })).ms);
        }
        const agentId = (await call("agents.put", {
          projectId: "main", name: "Benchmark agent", modelId: "test.echo",
        })).data.id;
        const sessionId = crypto.randomUUID();
        const chat = [];
        for (let i = 0; i < 5; i++) {
          const start = performance.now();
          const response = await fetch(runtimeUrl, { method: "POST", headers: {
            authorization: `Bearer ${token}`, "content-type": "application/json",
            "x-amzn-bedrock-agentcore-runtime-session-id": runtimeSession,
          }, body: JSON.stringify({ v: 1, command: "chat.send", input: {
            projectId: "main", agentId, sessionId, requestId: crypto.randomUUID(), message: `turn ${i}`,
          } }) });
          if (!response.ok || !response.body) throw Error(`chat.send: ${response.status}`);
          const reader = response.body.getReader();
          const first = await reader.read();
          const firstChunkMs = performance.now() - start;
          let text = new TextDecoder().decode(first.value || new Uint8Array());
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            text += new TextDecoder().decode(next.value);
          }
          if (!text.includes('"type":"message.done"')) throw Error(`Incomplete chat: ${text}`);
          chat.push({ firstChunkMs, completeMs: performance.now() - start });
        }
        return { coldRuntimeMs, controls, signIn, usageView, chat, agentId, sessionId };
      }, { runtimeUrl: fixture.controllerUrl, token: accessToken });
      fixture.trackChat(sample.agentId, sample.sessionId);
      const percentile = (values, fraction) =>
        Math.round([...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]);
      const summarize = (values) => ({ p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95) });
      console.log("BENCHMARK " + JSON.stringify({
        coldRuntimeMs: Math.round(sample.coldRuntimeMs),
        warmRuntimeControl: summarize(sample.controls),
        sequentialSignIn: summarize(sample.signIn.separate),
        workspaceSignIn: summarize(sample.signIn.workspace),
        parallelUsageView: summarize(sample.usageView.parallel),
        combinedUsageView: summarize(sample.usageView.combined),
        chatFirstChunk: summarize(sample.chat.map((x) => x.firstChunkMs)),
        chatComplete: summarize(sample.chat.map((x) => x.completeMs)),
        samples: { controls: 8, signInPerPath: 5, usagePerPath: 5, chat: 5 },
      }));
      return;
    }
    if (["runtime-chat", "runtime-tool"].includes(story)) {
      const toolStory = story === "runtime-tool";
      const result = await page.evaluate(async ({ url, token, toolStory }) => {
        const call = async (command, input) => {
          const response = await fetch(url, { method: "POST", headers: {
            authorization: `Bearer ${token}`, "content-type": "application/json",
            "x-amzn-bedrock-agentcore-runtime-session-id": `smoke-${crypto.randomUUID()}`,
          }, body: JSON.stringify({ v: 1, command, input }) });
          return { status: response.status, body: await response.json() };
        };
        const created = await call("agents.put", { projectId: "main", name: "Smoke agent",
          modelId: "test.echo", codeInterpreter: toolStory });
        if (!created.body.ok) return { created };
        const agentId = created.body.data.id;
        const sessionId = crypto.randomUUID();
        const requestId = crypto.randomUUID();
        const started = performance.now();
        const response = await fetch(url, { method: "POST", headers: {
          authorization: `Bearer ${token}`, "content-type": "application/json",
          "x-amzn-bedrock-agentcore-runtime-session-id": `smoke-${crypto.randomUUID()}`,
        }, body: JSON.stringify({ v: 1, command: "chat.send", input: {
          projectId: "main", agentId, sessionId, requestId,
          message: toolStory ? "run-code: print(2+2)" : "hello runtime",
        } }) });
        const stream = await response.text();
        if (toolStory) return { agentId, sessionId, requestId, status: response.status, stream,
          elapsedMs: performance.now() - started };
        const followup = await fetch(url, { method: "POST", headers: {
          authorization: `Bearer ${token}`, "content-type": "application/json",
          "x-amzn-bedrock-agentcore-runtime-session-id": `smoke-${crypto.randomUUID()}`,
        }, body: JSON.stringify({ v: 1, command: "chat.send", input: {
          projectId: "main", agentId, sessionId, requestId: crypto.randomUUID(), message: "history?",
        } }) });
        const followupStream = await followup.text();
        const [newest, oldest, ninety] = await Promise.all([
          call("usage.list", { range: "30d", sort: "desc" }),
          call("usage.list", { range: "30d", sort: "asc" }),
          call("usage.list", { range: "90d", sort: "desc" }),
        ]);
        const conversations = await call("conversations.list", { projectId: "main" });
        const reopened = await call("conversations.get", {
          projectId: "main", agentId, conversationId: sessionId,
        });
        let combined;
        for (let attempt = 0; attempt < 8; attempt++) {
          combined = await call("usage.list", { range: "30d", scope: "all" });
          if (combined.body.data?.items?.length >= 2) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return { agentId, sessionId, requestId, status: response.status, stream,
          followupStatus: followup.status, followupStream, newest, oldest, ninety, combined,
          conversations, reopened };
      }, { url: fixture.controllerUrl, token: accessToken, toolStory });
      if (result.agentId && result.sessionId) fixture.trackChat(result.agentId, result.sessionId);
      if (toolStory) {
        if (result.status !== 200 || !result.stream?.includes('"type":"tool.done"') ||
          !result.stream.includes("4") || !result.stream.includes('"type":"message.done"'))
          throw new Error("Runtime managed tool turn failed: " + JSON.stringify(result));
        const usage = await fixture.readUsage();
        if (usage.Items?.length !== 2 ||
          !usage.Items.some((item) => item.unpricedToolCalls?.N === "1") ||
          !usage.Items.some((item) => item.quality?.S === "unpriced" && item.name?.S === "execute_code"))
          throw new Error("Managed tool invocation was not recorded as unpriced");
        console.log("TOOL TIMING " + JSON.stringify({ browserCompleteMs: Math.round(result.elapsedMs),
          sampleCount: 1, inference: "scripted", tool: "real AgentCore Code Interpreter" }));
        return;
      }
      if (result.status !== 200 || !result.stream?.includes('"text":"Echo: hello runtime"') ||
        !result.stream.includes('"type":"message.done"') ||
        result.followupStatus !== 200 || !result.followupStream?.includes("History: hello runtime | history?"))
        throw new Error("Runtime-only chat failed: " + JSON.stringify(result));
      const [events, usage] = await Promise.all([
        fixture.readChat(result.agentId, result.sessionId), fixture.readUsage(),
      ]);
      const replies = events.events?.map((event) => event.payload?.[1]?.conversational?.content?.text);
      const receipts = events.events?.map((event) => event.payload?.[2]?.json?.content);
      if (replies?.[0] !== "History: hello runtime | history?" ||
        replies?.[1] !== "Echo: hello runtime" ||
        receipts?.length !== 2 || receipts.some((receipt) =>
          receipt?.version !== 1 || receipt?.conversationId !== result.sessionId ||
          receipt?.usage?.inputTokens !== 10) ||
        usage.Items?.length !== 2 || usage.Items.some((item) => item.inputTokens?.N !== "10"))
        throw new Error("Runtime chat did not persist Memory and metered usage");
      if (result.conversations.status !== 200 ||
        !result.conversations.body.data.items.some((item) => item.id === result.sessionId) ||
        result.reopened.status !== 200 ||
        result.reopened.body.data.messages.map((item) => item.text).join("|") !==
          "hello runtime|Echo: hello runtime|history?|History: hello runtime | history?")
        throw new Error("Conversation index or Memory reopen failed: " +
          JSON.stringify({ conversations: result.conversations, reopened: result.reopened }));
      const newest = result.newest.body.data?.items || [];
      const oldest = result.oldest.body.data?.items || [];
      if ([result.newest, result.oldest, result.ninety, result.combined]
        .some((page) => page.status !== 200 || !page.body.ok) ||
        newest.length !== 2 || oldest.length !== 2 ||
        result.ninety.body.data.items.length !== 2 ||
        result.combined.body.data.items.length < 2 ||
        newest[0].occurredAt < newest[1].occurredAt ||
        oldest[0].occurredAt > oldest[1].occurredAt ||
        newest.some((item) => item.userSub !== result.combined.body.data.items
          .find((all) => all.requestId === item.requestId)?.userSub))
        throw new Error("Historical usage ordering or admin combined view failed: " +
          JSON.stringify({ newest: result.newest, oldest: result.oldest,
            ninety: result.ninety, combined: result.combined }));
      return;
    }
    const result = await page.evaluate(
      async ({ url, token }) => {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "x-amzn-bedrock-agentcore-runtime-session-id": `smoke-${crypto.randomUUID()}`,
          },
          body: JSON.stringify({ v: 1, command: "session.get", input: {} }),
        });
        return { status: response.status, body: await response.json() };
      },
      { url: fixture.controllerUrl, token: accessToken },
    );
    if (
      result.status !== 200 ||
      result.body?.data?.user?.email !== fixture.email
    )
      throw new Error(
        "Authenticated CodeZip Runtime session.get failed: " + result.status,
      );
    if ((await fixture.readUserControl())?.budgetMicroUsd?.N !== "5000000")
      throw new Error("CodeZip Runtime did not persist the default user limit");
    return;
  }
  await page.getByRole("button", { name: "Account" }).last().click();
  await page.getByRole("dialog").getByText(fixture.email).waitFor();
  await page.getByRole("dialog").getByText("Administrators").waitFor();
  if (screenshot)
    await page.evaluate(async () => {
      const { _screenshot } = await import("./tests.js");
      await _screenshot("live-account", document.querySelector("dialog[open]"));
    });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.getByRole("button", { name: /Users/ }).first().click();
  await page.getByRole("dialog").getByText(fixture.email).waitFor();
  await page.getByRole("dialog").getByText("Account defaults").waitFor();
  const ownLimits = page
    .getByRole("dialog")
    .locator(".item")
    .filter({ hasText: fixture.email });
  await ownLimits.locator('input[name="budget"]').fill("1.25");
  const changed = page.waitForResponse(
    (response) =>
      response.request().postDataJSON()?.command === "users.setLimits",
  );
  const reloaded = page.waitForResponse(
    (response) =>
      response.request().postDataJSON()?.command === "users.list",
  );
  await ownLimits.getByRole("button", { name: "Save limits" }).click();
  if (!(await (await changed).json()).ok)
    throw new Error("Budget update failed");
  await reloaded;
  if ((await fixture.readUserControl())?.budgetMicroUsd?.N !== "1250000")
    throw new Error("Budget update was not committed to DynamoDB");
  if (screenshot)
    await page.evaluate(async () => {
      const { _screenshot } = await import("./tests.js");
      await _screenshot("live-users", document.querySelector("dialog[open]"));
    });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close dialog" })
    .click();
  await page.getByRole("button", { name: /View agents/ }).click();
  await page.getByRole("dialog").locator("#agent-model option[value='global.openai.gpt-6-luna']")
    .waitFor({ state: "attached" });
  if (!(await page.getByRole("dialog")
    .locator("#agent-model option[value='gemini-3.8-flash']").isDisabled()))
    throw new Error("Unimplemented Gemini adapter must not be selectable");
  await page.getByRole("dialog").getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: /Usage/ }).first().click();
  await page.getByRole("dialog").getByText(/Not yet metered|\$0\.00/).first().waitFor();
  await page.getByRole("dialog").locator("#usage-range").selectOption("90d");
  await page.getByRole("dialog").locator("#usage-sort").selectOption("asc");
  await page.getByRole("dialog").locator("#usage-scope").selectOption("all");
  await page.getByRole("dialog").getByText(/(Daily|Weekly|Monthly) ·/).waitFor();
  await page.getByRole("dialog").getByText("No requests in this range.").waitFor();
  if (uiInvocations.some((item) => ["usage.summary", "usage.list", "defaults.get"].includes(item.command)) ||
    uiInvocations.filter((item) => item.command === "usage.get").length !== 4)
    throw new Error("Usage and Users dialogs made avoidable Runtime invocations");
  if (screenshot)
    await page.evaluate(async () => {
      const { _screenshot } = await import("./tests.js");
      await _screenshot("live-usage", document.querySelector("dialog[open]"));
    });
}
