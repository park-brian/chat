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
export async function createLiveFixture({ stackName, profile, region,
  role = "Administrators" }) {
  if (!["Administrators", "Members", "Auditors"].includes(role))
    throw Error("Invalid disposable fixture role");
  const [
    { fromIni },
    cloudformation,
    cognito,
    dynamodb,
    memoryApi,
    s3Api,
    { randomUUID, randomBytes },
  ] = await Promise.all([
    import("@aws-sdk/credential-providers"),
    import("@aws-sdk/client-cloudformation"),
    import("@aws-sdk/client-cognito-identity-provider"),
    import("@aws-sdk/client-dynamodb"),
    import("@aws-sdk/client-bedrock-agentcore"),
    import("@aws-sdk/client-s3"),
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
  const s3 = new s3Api.S3Client({ region, credentials });
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
  const chatSessions = new Map();
  const cleanup = async () => {
    if (sub) {
      for (const { projectId, memorySessionIds } of chatSessions.values()) {
        for (const sessionId of memorySessionIds) {
          const scope = { memoryId: outputs.MemoryArn,
            actorId: `${sub}/${projectId}`, sessionId };
          let nextToken;
          do {
            const page = await memory.send(new memoryApi.ListEventsCommand({
              ...scope, maxResults: 100, nextToken }));
            for (const event of page.events || [])
              await memory.send(new memoryApi.DeleteEventCommand({
                ...scope, eventId: event.eventId }));
            nextToken = page.nextToken;
          } while (nextToken);
        }
      }
      for (const prefix of [`users/${sub}/`, `pending/${sub}/`]) {
        let KeyMarker, VersionIdMarker;
        do {
          const page = await s3.send(new s3Api.ListObjectVersionsCommand({
            Bucket: outputs.SharedBucket, Prefix: prefix,
            KeyMarker, VersionIdMarker }));
          for (const object of [...(page.Versions || []), ...(page.DeleteMarkers || [])])
            await s3.send(new s3Api.DeleteObjectCommand({
              Bucket: outputs.SharedBucket, Key: object.Key,
              VersionId: object.VersionId }));
          KeyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
          VersionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
        } while (KeyMarker);
      }
      const projectRows = await db.send(new dynamodb.QueryCommand({
        TableName: outputs.DataTable,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": { S: `USER#${sub}` },
          ":prefix": { S: "PROJECT#" } }, ConsistentRead: true }));
      const projectIds = ["main", ...(projectRows.Items || []).map((item) => item.id.S)];
      for (const pk of [`USER#${sub}`, ...projectIds.map((id) => `PROJECT#${sub}/${id}`)]) {
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
      const owner = await db.send(new dynamodb.GetItemCommand({
        TableName: outputs.DataTable,
        Key: { pk: { S: "ACCOUNT#CONTROL" }, sk: { S: "OWNER" } },
        ConsistentRead: true }));
      if (owner.Item?.ownerSub?.S === sub)
        await db.send(new dynamodb.DeleteItemCommand({
          TableName: outputs.DataTable,
          Key: { pk: { S: "ACCOUNT#CONTROL" }, sk: { S: "OWNER" } },
          ConditionExpression: "ownerSub = :sub",
          ExpressionAttributeValues: { ":sub": { S: sub } } }));
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
        GroupName: role,
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
    publicEntryUrl: outputs.ApplicationEntryUrl,
    email,
    password,
    cleanup,
    readUserControl,
    controllerUrl,
    hasGemini: Boolean(outputs.GeminiCredentialArn),
    hasScriptedModel: parameters.EnableScriptedModel === "true",
    createPeer: (peerRole = "Members") => createLiveFixture({
      stackName, profile, region, role: peerRole }),
    trackChat: (agentId, sessionId, projectId = "main", rootlessBranchId) => {
      const key = `${projectId}/${sessionId}`;
      const memorySessionId = `a_${agentId}_${sessionId}`;
      const state = chatSessions.get(key) || { projectId,
        memorySessionIds: new Set([memorySessionId]) };
      if (rootlessBranchId)
        state.memorySessionIds.add(`a_${agentId}_b_${rootlessBranchId}`);
      chatSessions.set(key, state);
    },
    readAgent: async (agentId) => (await db.send(new dynamodb.GetItemCommand({
      TableName: outputs.DataTable,
      Key: { pk: { S: `PROJECT#${sub}/main` }, sk: { S: `AGENT#${agentId}` } },
      ConsistentRead: true,
    }))).Item,
    readChat: async (agentId, sessionId) => memory.send(new memoryApi.ListEventsCommand({
      memoryId: outputs.MemoryArn, actorId: `${sub}/main`,
      sessionId: `a_${agentId}_${sessionId}`, includePayloads: true,
    })),
    deleteChatMemory: async (agentId, sessionId) => {
      const scope = { memoryId: outputs.MemoryArn, actorId: `${sub}/main`,
        sessionId: `a_${agentId}_${sessionId}` };
      const events = await memory.send(new memoryApi.ListEventsCommand({
        ...scope, maxResults: 100 }));
      for (const event of events.events || [])
        await memory.send(new memoryApi.DeleteEventCommand({
          ...scope, eventId: event.eventId }));
      return (events.events || []).length;
    },
    readUsage: async () => db.send(new dynamodb.QueryCommand({
      TableName: outputs.DataTable,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :usage)",
      ExpressionAttributeValues: { ":pk": { S: `USER#${sub}` }, ":usage": { S: "USAGE#" } },
      ConsistentRead: true,
    })),
  };
}

export async function runLiveStory(page, fixture, { story, screenshot }) {
  if (story && !["login", "runtime", "runtime-chat", "runtime-tool", "runtime-web", "runtime-connections", "runtime-ui", "runtime-model", "runtime-composer", "runtime-benchmark", "runtime-foundation", "runtime-roadmap"].includes(story))
    throw new Error("Unknown live story: " + story);
  if (["runtime", "runtime-chat", "runtime-tool", "runtime-web", "runtime-connections", "runtime-ui", "runtime-model", "runtime-composer", "runtime-benchmark", "runtime-foundation", "runtime-roadmap"].includes(story) && !fixture.controllerUrl)
    throw new Error("Live stack has no ControllerArn");
  const uiInvocations = [];
  const uiErrors = [];
  const runtimeFailures = [];
  page.on("response", async (reply) => {
    if (reply.url().includes("/runtimes/") && reply.status() >= 400)
      runtimeFailures.push(`${reply.status()} ${(await reply.text().catch(() => "")).slice(0, 300)}`);
  });
  page.on("request", (request) => {
    if (!request.url().includes("/runtimes/")) return;
    const body = request.postDataJSON();
    if (["runtime-ui", "runtime-composer", "runtime-connections", "runtime-web",
      "runtime-foundation", "runtime-roadmap"].includes(story) && body?.command === "chat.send")
      fixture.trackChat(body.input.agentId, body.input.sessionId,
        body.input.projectId || "main",
        body.input.forkEventId === null ? body.input.branchId : null);
    uiInvocations.push({ command: body?.command, input: body?.input,
      runtimeSession: request.headers()["x-amzn-bedrock-agentcore-runtime-session-id"] });
  });
  if (story === "runtime-ui") page.on("response", async (reply) => {
    if (reply.request().postDataJSON()?.command !== "chat.send") return;
    const body = await reply.text().catch(() => "");
    if (body.includes('"type":"error"')) uiErrors.push(body.slice(0, 1000));
  });
  const tokenResponse =
    ["runtime", "runtime-chat", "runtime-tool", "runtime-web", "runtime-connections", "runtime-model", "runtime-benchmark", "runtime-foundation", "runtime-roadmap"].includes(story)
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
  await page.locator('[data-app-state="ready"]').waitFor({ timeout: 45000 })
    .catch(async () => {
      throw new Error(`Workspace did not open: ${(await page.locator('[role="alert"]').allTextContents()).join(" | ")}; ${runtimeFailures.join(" | ")}`);
    });
  if (uiInvocations.length !== 1 || uiInvocations[0].command !== "workspace.get" ||
    !uiInvocations[0].runtimeSession)
    throw new Error("Sign-in must load the workspace in one sticky Runtime invocation: " +
      JSON.stringify({ invocations: uiInvocations.map((item) => item.command),
        runtimeFailures }));
  if (story === "runtime-composer") {
    await page.getByRole("button", { name: "Choose an agent" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("#agent-model option[value='global.openai.gpt-6-luna']")
      .waitFor({ state: "attached" });
    await dialog.locator("#agent-name").fill("Composer smoke");
    await dialog.locator("#agent-model").selectOption("global.openai.gpt-6-luna");
    await dialog.getByRole("button", { name: "Create agent" }).click();
    await dialog.waitFor({ state: "hidden" });
    const picker = page.getByRole("combobox", { name: "Model for this message" });
    if (await picker.inputValue() !== "global.openai.gpt-6-luna")
      throw new Error("Composer did not inherit the agent's saved model");
    await picker.selectOption("global.anthropic.claude-sonnet-5");
    const slider = page.getByRole("slider", { name: "Thinking level for this message" });
    await slider.evaluate((input) => {
      input.value = "0";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.getByText("Thinking: low").waitFor();
    await page.getByRole("textbox", { name: "Message" }).fill("Reply OK only.");
    if (screenshot)
      await page.evaluate(async () => {
        const { _screenshot } = await import("./tests.js");
        await _screenshot("live-composer", document.querySelector(".composer"));
      });
    const sent = page.waitForRequest((request) =>
      request.postDataJSON()?.command === "chat.send");
    await page.getByRole("button", { name: "Send ↑" }).click();
    const input = (await sent).postDataJSON().input;
    if (input.modelId !== "global.anthropic.claude-sonnet-5" ||
      input.thinkingLevel !== "low")
      throw new Error("Composer did not send the selected model and thinking level");
    await page.locator(".message.assistant .message-state").last()
      .waitFor({ state: "hidden", timeout: 30000 });
    const [agent, events, usage] = await Promise.all([
      fixture.readAgent(input.agentId),
      fixture.readChat(input.agentId, input.sessionId),
      fixture.readUsage(),
    ]);
    if (agent?.modelId?.S !== "global.openai.gpt-6-luna" ||
      events.events?.[0]?.payload?.[2]?.json?.content?.modelId !== input.modelId ||
      !usage.Items?.some((row) => row.modelId?.S === input.modelId))
      throw new Error("Composer override did not retain the agent default and meter the used model");
    return;
  }
  if (story === "runtime-ui") {
    if (!fixture.hasScriptedModel)
      throw new Error("runtime-ui requires a disposable stack with EnableScriptedModel=true");
    const label = page.viewportSize().width < 761 ? "mobile" : "desktop";
    const firstMessage = `hello ${label}`;
    const secondMessage = `second ${label}`;
    const chooseConversation = async (name) => {
      if (page.viewportSize().width < 761) {
        await page.getByRole("button", { name: "Open menu" }).click();
        const menu = page.getByRole("dialog");
        const target = menu.getByRole("button", { name }).first();
        if (!(await target.count()))
          throw new Error(`Mobile menu missing ${name}: ${(await menu.locator("button").allTextContents()).join(" | ")}`);
        await target.click();
      } else {
        await page.getByRole("button", { name }).first().click();
      }
    };
    await chooseConversation("Integrations");
    const connectionDialog = page.getByRole("dialog");
    await connectionDialog.locator("#connection-name").fill(`UI GitHub ${label}`);
    await connectionDialog.locator("#connection-key").fill("ui-test-token");
    await connectionDialog.getByRole("button", { name: "Save connection" }).click();
    await connectionDialog.getByText(`UI GitHub ${label}`).last().waitFor();
    if (screenshot)
      await page.evaluate(async () => {
        const { _screenshot } = await import("./tests.js");
        await _screenshot("live-connections", document.querySelector("dialog[open]"));
      });
    await connectionDialog.getByRole("button", { name: "Close dialog" }).click();
    await page.getByRole("button", { name: "Choose an agent" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("#agent-model option[value='test.echo']").waitFor({ state: "attached" });
    await dialog.locator("#agent-model option[value='global.openai.gpt-6-luna']")
      .waitFor({ state: "attached" });
    if (await dialog.locator("#agent-model option[value='gemini-3.8-flash']").isDisabled() === fixture.hasGemini)
      throw new Error("Gemini dropdown availability must match the stack credential");
    if (fixture.hasGemini) {
      await dialog.locator("#agent-model").selectOption("gemini-3.8-flash");
      for (const name of ["codeInterpreter", "webSearch", "browser"])
        if (await dialog.locator(`input[name="${name}"]`).isDisabled())
          throw new Error("Configured Gemini must offer every AgentCore tool");
    }
    await dialog.locator("#agent-model").selectOption("global.openai.gpt-6-luna");
    if (!(await dialog.locator('input[name="browser"]').isDisabled()) ||
      (await dialog.locator('input[name="webSearch"]').isDisabled()))
      throw new Error("GPT-6 must offer Web Search but not screenshot-based Browser");
    if (screenshot)
      await page.evaluate(async () => {
        const { _screenshot } = await import("./tests.js");
        await _screenshot("live-agent-models", document.querySelector("dialog[open]"));
      });
    await dialog.locator("#agent-name").fill(`Smoke UI ${label}`);
    await dialog.locator("#agent-model").selectOption("test.echo");
    await dialog.locator('input[name="codeInterpreter"]').check();
    await dialog.locator('input[name="webSearch"]').check();
    await dialog.locator('input[name="browser"]').check();
    await dialog.locator("#agent-search-results").fill("7");
    await dialog.locator("#agent-browser-timeout").fill("120");
    await dialog.locator('input[name="connectionId"]').last().check();
    await dialog.getByRole("button", { name: "Create agent" }).click();
    await dialog.waitFor({ state: "hidden", timeout: 12000 }).catch(async () => {
      throw new Error(`Agent create stayed open: ${(await dialog.locator('[role="alert"]').allTextContents()).join(" | ")}`);
    });
    await chooseConversation("Agents");
    const editor = page.getByRole("dialog");
    await editor.locator(".item").filter({ hasText: `Smoke UI ${label}` })
      .getByRole("button", { name: "Edit" }).last().click();
    if (!(await editor.locator('input[name="connectionId"]').last().isChecked()))
      throw new Error("Agent edit lost its saved connection grant");
    const editedModel = await editor.locator("#agent-model").inputValue();
    const editedTool = await editor.locator('input[name="codeInterpreter"]').isChecked();
    if (editedModel !== "test.echo" || !editedTool ||
      !(await editor.locator('input[name="webSearch"]').isChecked()) ||
      !(await editor.locator('input[name="browser"]').isChecked()) ||
      (await editor.locator("#agent-search-results").inputValue()) !== "7" ||
      (await editor.locator("#agent-browser-timeout").inputValue()) !== "120")
      throw new Error(`Agent edit lost model/tool: ${editedModel} / ${editedTool}`);
    await editor.locator("#agent-name").fill(`Smoke UI ${label} revised`);
    await editor.getByRole("button", { name: "Save agent" }).click();
    await editor.waitFor({ state: "hidden", timeout: 12000 }).catch(async () => {
      throw new Error(`Agent edit stayed open: ${(await editor.locator('[role="alert"]').allTextContents()).join(" | ")}`);
    });
    const saveToggle = page.getByRole("checkbox", { name: "Save outputs" });
    await saveToggle.check();
    if (screenshot)
      await page.evaluate(async () => {
        const { _screenshot } = await import("./tests.js");
        await _screenshot("live-code-composer", document.querySelector(".composer"));
      });
    const message = page.locator('textarea[aria-label="Message"]');
    await message.fill(firstMessage);
    const savedTurn = page.waitForRequest((request) =>
      request.postDataJSON()?.command === "chat.send");
    await page.getByRole("button", { name: "Send ↑" }).click();
    if ((await savedTurn).postDataJSON().input.saveOutputs !== true)
      throw new Error("Composer did not send the per-turn output permission");
    await page.locator(".message-text").getByText(`Echo: ${firstMessage}`).waitFor()
      .catch(async (error) => {
        throw new Error(`Edited agent chat failed: ${(await page.locator('[role="alert"]').allTextContents()).join(" | ")}; ${error.message}`);
      });
    await page.locator(".message.assistant .message-state").last()
      .waitFor({ state: "hidden", timeout: 12000 }).catch(async () => {
        throw new Error(`First chat did not complete: ${(await page.locator('[role="alert"]').allTextContents()).join(" | ")}; ${uiErrors.join(" | ")}`);
      });
    if (await saveToggle.isChecked())
      throw new Error("Saved-output permission carried into the next turn");
    await chooseConversation("New chat");
    await message.fill(secondMessage);
    await page.getByRole("button", { name: "Send ↑" }).click();
    await page.locator(".message-text").getByText(`Echo: ${secondMessage}`).waitFor();
    await page.locator(".message.assistant .message-state").last()
      .waitFor({ state: "hidden" });
    await chooseConversation(firstMessage);
    await page.locator(".message-text").getByText(`Echo: ${firstMessage}`).waitFor();
    const chats = uiInvocations.filter((item) => item.command === "chat.send");
    if (chats.length !== 2 || chats[0].input.sessionId === chats[1].input.sessionId ||
      uiInvocations.some((item) => item.command === "agents.list") ||
      uiInvocations.some((item) => item.runtimeSession !== uiInvocations[0].runtimeSession))
      throw new Error("UI did not reuse one Runtime session across control and conversations");
    await page.reload();
    await page.locator('[data-app-state="ready"]').waitFor({ timeout: 45000 });
    await chooseConversation(firstMessage);
    await page.locator(".message-text").getByText(`Echo: ${firstMessage}`).waitFor();
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
  if (["runtime", "runtime-chat", "runtime-tool", "runtime-web", "runtime-connections", "runtime-model", "runtime-benchmark", "runtime-foundation", "runtime-roadmap"].includes(story)) {
    const accessToken = (await (await tokenResponse).json()).access_token;
    if (!accessToken) throw new Error("Cognito access token missing");
    if (story === "runtime-roadmap") {
      if (!fixture.hasScriptedModel)
        throw new Error("runtime-roadmap requires scripted inference");
      const setup = await page.evaluate(async ({ url, token }) => {
        const headers = { authorization: "Bearer " + token,
          "content-type": "application/json",
          "x-amzn-bedrock-agentcore-runtime-session-id": "roadmap-" + crypto.randomUUID() };
        const call = async (command, input) => (await (await fetch(url, {
          method: "POST", headers,
          body: JSON.stringify({ v: 1, command, input }),
        })).json());
        const send = async (input) => {
          const response = await fetch(url, { method: "POST", headers,
            body: JSON.stringify({ v: 1, command: "chat.send",
              input: { ...input, requestId: crypto.randomUUID() } }) });
          const events = (await response.text()).split("\n\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => JSON.parse(line.slice(6)));
          return { done: events.find((event) => event.type === "message.done"),
            error: events.find((event) => event.type === "error") };
        };
        const agent = await call("agents.put", { name: "Durable smoke",
          modelId: "test.echo" });
        if (!agent.ok) return { agent };
        const agentId = agent.data.id, sessionId = crypto.randomUUID();
        const first = await send({ agentId, sessionId, message: "first archive",
          expectedHeadEventId: null });
        if (!first.done) return { agentId, sessionId, agent, first };
        const second = await send({ agentId, sessionId, message: "history?",
          expectedHeadEventId: first.done.eventId });
        const usage = await call("usage.get", { range: "30d",
          includeDaily: true });
        const detail = await call("usage.request", {
          requestId: first.done.requestId });
        const reconciled = await call("usage.reconcile", {
          requestId: first.done.requestId });
        const filtered = await call("usage.list", { range: "30d",
          requestId: first.done.requestId, quality: "estimated",
          status: "completed" });
        const people = await call("users.list", {});
        const connection = await call("connections.put", {
          projectId: "main", name: "Private smoke credential",
          kind: "github", apiKey: "disposable-" + crypto.randomUUID() });
        const session = await call("session.get", {});
        const protectedRole = await call("users.setRole", {
          sub: session.data.user.sub, role: "Members" });
        return { agentId, sessionId, agent, first, second, usage, detail,
          reconciled, filtered, people, connection, protectedRole, session };
      }, { url: fixture.controllerUrl, token: accessToken });
      if (setup.agentId && setup.sessionId)
        fixture.trackChat(setup.agentId, setup.sessionId);
      if (!setup.first?.done || !setup.second?.done ||
        setup.session?.data?.user?.storageUsedBytes <= 0 ||
        setup.usage?.data?.items?.filter((item) => item.kind === "model").length !== 2 ||
        setup.usage?.data?.daily?.items?.length !== 1 ||
        setup.detail?.data?.steps?.length !== 1 ||
        setup.reconciled?.data?.status !== "completed" ||
        setup.filtered?.data?.items?.length !== 1 ||
        setup.people?.data?.items?.length !== 1 ||
        !setup.connection?.data?.id ||
        setup.protectedRole?.error?.code !== "PROTECTED_ADMIN")
        throw new Error("Durable admission/metering failed: " +
          JSON.stringify(setup).slice(0, 1800));
      let peer, peerContext;
      try {
        peer = await fixture.createPeer("Members");
        peerContext = await page.context().browser().newContext();
        const peerPage = await peerContext.newPage();
        await peerPage.goto(peer.entryUrl);
        const peerTokenResponse = peerPage.waitForResponse((response) =>
          response.url().includes("/oauth2/token"));
        await peerPage.locator('input[type="password"]').waitFor();
        await peerPage.locator('input[type="email"], input[name="username"]')
          .first().fill(peer.email);
        await peerPage.locator('input[type="password"]').first().fill(peer.password);
        await peerPage.locator('button[type="submit"], input[type="submit"]')
          .first().click();
        await peerPage.locator('[data-app-state="ready"]').waitFor({ timeout: 45000 });
        const peerToken = (await (await peerTokenResponse).json()).access_token;
        const denied = await peerPage.evaluate(async ({ url, token, agentId,
          sessionId, ownerSub, requestId, connectionId }) => {
          const call = async (command, input) => (await (await fetch(url, {
            method: "POST", headers: { authorization: "Bearer " + token,
              "content-type": "application/json",
              "x-amzn-bedrock-agentcore-runtime-session-id": "peer-" + crypto.randomUUID() },
            body: JSON.stringify({ v: 1, command, input }),
          })).json());
          return {
            conversation: await call("conversations.get", {
              agentId, conversationId: sessionId }),
            usage: await call("usage.request", { userSub: ownerSub, requestId }),
            users: await call("users.list", {}),
            agents: await call("agents.list", {}),
            connection: await call("connections.test", {
              projectId: "main", id: connectionId }),
          };
        }, { url: fixture.controllerUrl, token: peerToken,
          agentId: setup.agentId, sessionId: setup.sessionId,
          ownerSub: setup.session.data.user.sub,
          requestId: setup.first.done.requestId,
          connectionId: setup.connection.data.id });
        if (denied.conversation?.error?.code !== "NOT_FOUND" ||
          denied.usage?.error?.code !== "FORBIDDEN" ||
          denied.users?.error?.code !== "FORBIDDEN" ||
          denied.agents?.data?.items?.length ||
          denied.connection?.error?.code !== "NOT_FOUND")
          throw new Error("Cross-user denial failed: " + JSON.stringify(denied));
      } finally {
        await peerContext?.close();
        await peer?.cleanup();
      }
      const removed = await fixture.deleteChatMemory(setup.agentId, setup.sessionId);
      if (removed !== 2) throw new Error("Expected two disposable Memory events");
      const afterLoss = await page.evaluate(async ({ url, token, agentId, sessionId,
        headEventId, sub }) => {
        const headers = { authorization: "Bearer " + token,
          "content-type": "application/json",
          "x-amzn-bedrock-agentcore-runtime-session-id": "roadmap-" + crypto.randomUUID() };
        const call = async (command, input) => (await (await fetch(url, {
          method: "POST", headers,
          body: JSON.stringify({ v: 1, command, input }),
        })).json());
        const reopened = await call("conversations.get", { agentId,
          conversationId: sessionId });
        const response = await fetch(url, { method: "POST", headers,
          body: JSON.stringify({ v: 1, command: "chat.send", input: {
            agentId, sessionId, requestId: crypto.randomUUID(),
            message: "history?", expectedHeadEventId: headEventId } }) });
        const events = (await response.text()).split("\n\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)));
        const third = { done: events.find((event) => event.type === "message.done"),
          error: events.find((event) => event.type === "error") };
        const after = await call("conversations.get", { agentId,
          conversationId: sessionId });
        const archived = await call("agents.setArchived", { id: agentId,
          revision: 0, archived: true });
        const deniedResponse = await fetch(url, { method: "POST", headers,
          body: JSON.stringify({ v: 1, command: "chat.send", input: {
            agentId, sessionId, requestId: crypto.randomUUID(), message: "blocked" } }) });
        const denied = await deniedResponse.text();
        const restored = await call("agents.setArchived", { id: agentId,
          revision: 1, archived: false });
        const failedRequestId = crypto.randomUUID();
        const failedResponse = await fetch(url, { method: "POST", headers,
          body: JSON.stringify({ v: 1, command: "chat.send", input: {
            agentId, sessionId: crypto.randomUUID(),
            requestId: failedRequestId, message: "scripted-error" } }) });
        const failed = await failedResponse.text();
        const failedDetail = await call("usage.request", {
          requestId: failedRequestId });
        const limits = await call("users.setLimits", { sub,
          budgetMicroUsd: null, storageBytes: 0, period: "weekly" });
        const quotaResponse = await fetch(url, { method: "POST", headers,
          body: JSON.stringify({ v: 1, command: "chat.send", input: {
            agentId, sessionId: crypto.randomUUID(),
            requestId: crypto.randomUUID(), message: "new" } }) });
        const quota = await quotaResponse.text();
        const reset = await call("users.startNewBudgetPeriod", { sub });
        const summary = await call("usage.summary", {});
        const inherit = await call("users.setLimits", { sub,
          budgetMicroUsd: null, storageBytes: null, period: null });
        let deleted;
        for (let attempt = 0; attempt < 10; attempt++) {
          deleted = await call("conversations.delete", { agentId,
            conversationId: sessionId });
          if (deleted.data?.deleted) break;
        }
        const afterDelete = await call("session.get", {});
        const missing = await call("conversations.get", { agentId,
          conversationId: sessionId });
        const duplicateDelete = await call("conversations.delete", { agentId,
          conversationId: sessionId });
        return { reopened, third, after, archived, denied, restored,
          failed, failedDetail, limits, quota, reset, summary,
          inherit, deleted, afterDelete, missing, duplicateDelete };
      }, { url: fixture.controllerUrl, token: accessToken,
        agentId: setup.agentId, sessionId: setup.sessionId,
        headEventId: setup.second.done.eventId,
        sub: setup.session.data.user.sub });
      if (afterLoss.reopened?.data?.messages?.length !== 4 ||
        !afterLoss.third?.done ||
        afterLoss.after?.data?.messages?.length !== 6 ||
        !afterLoss.archived?.ok || !afterLoss.restored?.ok ||
        !afterLoss.denied?.includes("AGENT_ARCHIVED") ||
        !afterLoss.failed?.includes('"type":"error"') ||
        afterLoss.failedDetail?.data?.request?.status !== "outcome_unknown" ||
        afterLoss.failedDetail?.data?.steps?.length !== 1 ||
        !afterLoss.quota?.includes("STORAGE_EXHAUSTED") ||
        !afterLoss.limits?.ok || !afterLoss.reset?.ok ||
        !afterLoss.summary?.data?.period?.includes("#E1") ||
        !afterLoss.inherit?.ok || !afterLoss.deleted?.data?.deleted ||
        afterLoss.afterDelete?.data?.user?.storageUsedBytes !== 0 ||
        afterLoss.missing?.error?.code !== "NOT_FOUND" ||
        !afterLoss.duplicateDelete?.data?.deleted)
        throw new Error("Durable reopen/reset/archive failed: " +
          JSON.stringify(afterLoss).slice(0, 1800));
      if (screenshot) {
        await page.reload();
        await page.locator('[data-app-state="ready"]').waitFor({ timeout: 45000 });
        const openManage = async (name) => {
          const target = page.getByRole("button", { name: new RegExp(name + "$") });
          if (!await target.first().isVisible())
            await page.getByRole("button", { name: "Open menu" }).click();
          await target.last().click();
          await page.getByRole("dialog").waitFor({ state: "visible" });
        };
        await openManage("Users");
        await page.getByRole("dialog").getByText("Bootstrap administrator").waitFor();
        await page.evaluate(async () => {
          const { _screenshot } = await import("./tests.js");
          await _screenshot("live-users", document.querySelector("dialog[open]"));
        });
        await page.getByRole("button", { name: "Close dialog" }).click();
        await openManage("Usage");
        await page.getByRole("dialog").getByRole("button",
          { name: "Request detail" }).first().waitFor();
        await page.evaluate(async () => {
          const { _screenshot } = await import("./tests.js");
          await _screenshot("live-usage", document.querySelector("dialog[open]"));
        });
      }
      return;
    }
    if (story === "runtime-foundation") {
      if (!fixture.hasScriptedModel)
        throw new Error("runtime-foundation requires scripted inference");
      const result = await page.evaluate(async ({ url, token }) => {
        const headers = { authorization: "Bearer " + token,
          "content-type": "application/json",
          "x-amzn-bedrock-agentcore-runtime-session-id": "foundation-" + crypto.randomUUID() };
        const call = async (command, input) => {
          const response = await fetch(url, { method: "POST", headers,
            body: JSON.stringify({ v: 1, command, input }) });
          return response.json();
        };
        const send = async (input) => {
          const response = await fetch(url, { method: "POST", headers,
            body: JSON.stringify({ v: 1, command: "chat.send", input: {
              ...input, requestId: crypto.randomUUID() } }) });
          const raw = await response.text();
          const events = raw.split("\n\n").flatMap((chunk) => {
            const line = chunk.split("\n").find((part) => part.startsWith("data:"));
            return line ? [JSON.parse(line.slice(5))] : [];
          });
          return { done: events.find((event) => event.type === "message.done"),
            error: events.find((event) => event.type === "error"), events };
        };
        const alpha = await call("projects.create", { id: "alpha", name: "Alpha" });
        const beta = await call("projects.create", { id: "beta", name: "Beta" });
        const agent = await call("agents.put", { projectId: "alpha",
          name: "Foundation smoke", modelId: "test.echo" });
        if (!alpha.ok || !beta.ok || !agent.ok) return { alpha, beta, agent };
        const agentId = agent.data.id, sessionId = crypto.randomUUID();
        const base = { projectId: "alpha", agentId, sessionId };
        const isolated = await call("agents.list", { projectId: "beta" });
        const first = await send({ ...base, message: "first", branchId: "main",
          expectedHeadEventId: null });
        if (!first.done) return { alpha, beta, agent, isolated, first, agentId, sessionId };
        const second = await send({ ...base, message: "history?", branchId: "main",
          expectedHeadEventId: first.done.eventId });
        if (!second.done) return { alpha, beta, agent, isolated, first, second,
          agentId, sessionId };
        const alternativeId = crypto.randomUUID();
        const alternate = await send({ ...base, message: "edited second",
          branchId: alternativeId, forkEventId: first.done.eventId });
        if (!alternate.done) return { alpha, beta, agent, isolated, first, second,
          alternate, agentId, sessionId };
        const nestedId = crypto.randomUUID();
        const nested = await send({ ...base, message: "history?", branchId: nestedId,
          forkEventId: alternate.done.eventId });
        const firstEditId = crypto.randomUUID();
        const firstEdit = await send({ ...base, message: "rewritten first",
          branchId: firstEditId, forkEventId: null, sourceBranchId: "main" });
        if (!firstEdit.done) return { firstEdit, agentId, sessionId };
        const firstEditChildId = crypto.randomUUID();
        const firstEditChild = await send({ ...base, message: "history?",
          branchId: firstEditChildId, forkEventId: firstEdit.done.eventId,
          sourceBranchId: firstEditId });
        const firstEditReopened = await call("conversations.get", {
          projectId: "alpha", agentId, conversationId: sessionId,
          branchId: firstEditChildId });
        const reopened = await call("conversations.get", { projectId: "alpha",
          agentId, conversationId: sessionId, branchId: nestedId });
        const main = await call("conversations.get", { projectId: "alpha",
          agentId, conversationId: sessionId, branchId: "main" });
        const denied = await call("conversations.get", { projectId: "beta",
          agentId, conversationId: sessionId });
        const stale = await send({ ...base, message: "stale",
          branchId: alternativeId, expectedHeadEventId: first.done.eventId });
        const self = await call("session.get", {});
        const archiveUsed = self.data.user.storageUsedBytes;
        const limits = await call("users.setLimits", { sub: self.data.user.sub,
          budgetMicroUsd: null, storageBytes: archiveUsed + 5 });
        const begin = await call("objects.beginUpload", { projectId: "alpha",
          name: "skill.md", contentType: "text/plain", sizeBytes: 5, kind: "skill" });
        if (!begin.ok) return { alpha, beta, agent, isolated, first, second,
          alternate, nested, reopened, main, denied, stale, limits, begin,
          agentId, sessionId };
        const fields = new FormData();
        for (const [name, value] of Object.entries(begin.data.upload.fields))
          fields.append(name, value);
        fields.append("file", new Blob(["hello"], { type: "text/plain" }), "skill.md");
        const posted = await fetch(begin.data.upload.url, { method: "POST", body: fields });
        const completed = await call("objects.completeUpload", {
          projectId: "alpha", id: begin.data.id });
        const listed = await call("objects.list", { projectId: "alpha" });
        const link = await call("objects.get", { projectId: "alpha", id: begin.data.id });
        const content = link.ok ? await (await fetch(link.data.url)).text() : "";
        const quota = await call("objects.beginUpload", { projectId: "alpha",
          name: "over.txt", contentType: "text/plain", sizeBytes: 1 });
        const skillAgent = await call("agents.put", { projectId: "alpha", id: agentId,
          revision: 0, name: "Foundation smoke", modelId: "test.echo",
          skillIds: [begin.data.id] });
        await call("users.setLimits", { sub: self.data.user.sub,
          budgetMicroUsd: null, storageBytes: null });
        const skilled = await send({ ...base, message: "skill-loaded",
          branchId: "main", expectedHeadEventId: second.done.eventId });
        const deleted = await call("objects.delete", {
          projectId: "alpha", id: begin.data.id });
        const afterDelete = await call("objects.list", { projectId: "alpha" });
        const unskilledAgent = await call("agents.put", { projectId: "alpha",
          id: agentId, revision: 1, name: "Foundation smoke",
          modelId: "test.echo", skillIds: [] });
        const zeroLimit = await call("users.setLimits", {
          sub: self.data.user.sub, budgetMicroUsd: null, storageBytes: 0 });
        const zeroSession = await call("session.get", {});
        const zeroDenied = await call("objects.beginUpload", { projectId: "alpha",
          name: "blocked.txt", contentType: "text/plain", sizeBytes: 1 });
        const inheritLimit = await call("users.setLimits", {
          sub: self.data.user.sub, budgetMicroUsd: null, storageBytes: null });
        const inheritedSession = await call("session.get", {});
        const hidden = await call("projects.setHidden", { id: "alpha",
          hidden: true, revision: alpha.data.revision });
        const hiddenAgents = await call("agents.list", { projectId: "alpha" });
        const projects = await call("projects.list", {});
        return { alpha, beta, agent, agentId, sessionId, isolated, first, second,
          alternate, nested, firstEdit, firstEditChild, firstEditReopened,
          reopened, main, denied, stale, limits, begin,
          archiveUsed, posted: posted.status, completed, listed, content, quota, skillAgent,
          skilled, deleted, afterDelete, unskilledAgent,
          zeroLimit, zeroSession, zeroDenied,
          inheritLimit, inheritedSession, hidden, hiddenAgents, projects };
      }, { url: fixture.controllerUrl, token: accessToken });
      if (result.agentId && result.sessionId)
        fixture.trackChat(result.agentId, result.sessionId, "alpha");
      if (!result.alpha?.ok || !result.beta?.ok || !result.agent?.ok ||
        result.isolated?.data?.items?.length || !result.first?.done ||
        !result.second?.done || !result.alternate?.done || !result.nested?.done ||
        !result.firstEdit?.done || !result.firstEditChild?.done ||
        result.firstEditReopened?.data?.messages?.map((item) => item.text).join("|") !==
          "rewritten first|Echo: rewritten first|history?|History: rewritten first | history?" ||
        result.reopened?.data?.messages?.map((item) => item.text).join("|") !==
          "first|Echo: first|edited second|Echo: edited second|history?|History: first | edited second | history?" ||
        result.main?.data?.messages?.map((item) => item.text).join("|") !==
          "first|Echo: first|history?|History: first | history?" ||
        result.denied?.error?.code !== "NOT_FOUND" ||
        result.stale?.error?.code !== "BRANCH_CONFLICT" ||
        !result.limits?.ok || result.posted !== 204 || !result.completed?.ok ||
        result.listed?.data?.usedBytes !== result.archiveUsed + 5 ||
        result.content !== "hello" ||
        result.quota?.error?.code !== "QUOTA_EXCEEDED" ||
        !result.skillAgent?.ok || !result.skilled?.done ||
        !result.deleted?.ok || result.afterDelete?.data?.usedBytes <= result.archiveUsed ||
        !result.unskilledAgent?.ok ||
        !result.zeroLimit?.ok || result.zeroSession?.data?.user?.storageBytes !== 0 ||
        result.zeroDenied?.error?.code !== "QUOTA_EXCEEDED" ||
        !result.inheritLimit?.ok ||
        result.inheritedSession?.data?.user?.storageBytes !== 5000000000 ||
        !result.hidden?.ok || !result.hiddenAgents?.data?.items?.length ||
        !result.projects?.data?.items?.find((item) => item.id === "alpha")?.hidden)
        throw new Error("Foundation live contract failed: " +
          JSON.stringify(result, (key, value) =>
            ["upload", "url", "fields"].includes(key) ? "[redacted]" : value)
            .slice(0, 16000));
      const mobile = page.viewportSize().width < 761;
      if (mobile) {
        await page.getByRole("button", { name: "Open menu" }).click();
        await page.getByRole("dialog").getByRole("button", {
          name: "Projects", exact: true }).click();
      } else await page.getByRole("button", { name: /Main project/ }).first().click();
      const dialog = page.getByRole("dialog");
      await dialog.getByText("Alpha").first().waitFor();
      if (screenshot) await page.evaluate(async () => {
        const { _screenshot } = await import("./tests.js");
        await _screenshot("live-projects", document.querySelector("dialog[open]"));
      });
      await dialog.locator(".item").filter({ hasText: "Alpha" })
        .getByRole("button", { name: "Open" }).click();
      await page.waitForFunction(() =>
        new URLSearchParams(location.search).get("project") === "alpha");
      if (mobile) await page.getByRole("button", { name: "Open menu" }).click();
      await page.getByRole("button", { name: "first", exact: true }).first().click();
      await page.getByRole("combobox", { name: "Conversation path" }).waitFor();
      if (screenshot) await page.evaluate(async () => {
        const { _screenshot } = await import("./tests.js");
        await _screenshot("live-branched-chat", undefined, { fullPage: true });
      });
      await page.getByRole("button", { name: "Edit · new path" }).first().click();
      await page.getByPlaceholder("Message your agent…").fill("rewritten via UI");
      await page.getByRole("button", { name: "Send ↑" }).click();
      await page.getByText("Echo: rewritten via UI").waitFor();
      if (await page.getByRole("combobox", { name: "Conversation path" }).inputValue() === "main")
        throw new Error("First-turn edit did not select a new path");
      return;
    }
    if (story === "runtime-connections") {
      const result = await page.evaluate(async ({ url, token, realKey }) => {
        const rawKey = `test-${crypto.randomUUID()}'$"`;
        const nextKey = `rotated-${crypto.randomUUID()} '"$`;
        const runtimeSession = `connection-${crypto.randomUUID()}`;
        const digest = async (value) => [...new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
          .map((byte) => byte.toString(16).padStart(2, "0")).join("");
        const call = async (command, input) => {
          const response = await fetch(url, { method: "POST", headers: {
            authorization: `Bearer ${token}`, "content-type": "application/json",
            "x-amzn-bedrock-agentcore-runtime-session-id": runtimeSession,
          }, body: JSON.stringify({ v: 1, command, input }) });
          const text = await response.text();
          return { status: response.status, text, body: JSON.parse(text) };
        };
        const chat = async (agentId, message, fileIds = [], saveOutputs = false) => {
          const sessionId = crypto.randomUUID();
          const response = await fetch(url, { method: "POST", headers: {
            authorization: `Bearer ${token}`, "content-type": "application/json",
            "x-amzn-bedrock-agentcore-runtime-session-id": runtimeSession,
          }, body: JSON.stringify({ v: 1, command: "chat.send", input: {
            projectId: "main", agentId, sessionId,
            requestId: crypto.randomUUID(), message, fileIds, saveOutputs,
          } }) });
          return { status: response.status, text: await response.text() };
        };
        const created = await call("connections.put", {
          projectId: "main", name: "GitHub smoke", kind: "github", apiKey: rawKey,
        });
        if (created.status !== 200 || created.text.includes(rawKey))
          throw Error("Connection creation failed or leaked its key");
        const id = created.body.data.id;
        const listed = await call("connections.list", { projectId: "main" });
        if (listed.status !== 200 || listed.text.includes(rawKey) ||
          !listed.body.data.items.some((item) => item.id === id))
          throw Error("Connection list was missing or leaked its key");
        const checked = await call("connections.test", { projectId: "main", id });
        if (checked.status !== 200 || checked.text.includes(rawKey) ||
          checked.body.data.connected)
          throw Error("Read-only check accepted a fake token or exposed it");
        const denied = await call("agents.put", { projectId: "main",
          name: "Unauthorized grant", modelId: "test.echo", codeInterpreter: true,
          connectionIds: [crypto.randomUUID()] });
        if (denied.body.error?.code !== "CONNECTION_UNAVAILABLE")
          throw Error(`Unknown connection grant: ${denied.status} ${denied.text.slice(0, 400)}`);
        const agent = await call("agents.put", { projectId: "main",
          name: "Connected smoke", modelId: "test.echo", codeInterpreter: true,
          connectionIds: [id] });
        if (agent.status !== 200) throw Error("Connected agent creation failed");
        const agentId = agent.body.data.id;
        const fileBody = "selected-file-" + crypto.randomUUID();
        const upload = await call("objects.beginUpload", {
          projectId: "main", name: "smoke.txt", kind: "file",
          contentType: "text/plain", sizeBytes: fileBody.length });
        if (upload.status !== 200) throw Error("Selected-file upload could not begin");
        const form = new FormData();
        for (const [name, value] of Object.entries(upload.body.data.upload.fields))
          form.append(name, value);
        form.append("file", new Blob([fileBody], { type: "text/plain" }), "smoke.txt");
        const staged = await fetch(upload.body.data.upload.url,
          { method: "POST", body: form });
        const complete = await call("objects.completeUpload",
          { projectId: "main", id: upload.body.data.id });
        if (!staged.ok || complete.status !== 200 || !complete.body.ok)
          throw Error("Selected-file upload did not complete: " +
            JSON.stringify({ staged: staged.status,
              complete: complete.body.error?.code || complete.body.data?.item?.status }));
        const fileInventory = await call("objects.list", { projectId: "main" });
        if (!fileInventory.body.data?.items?.some((item) =>
          item.id === upload.body.data.id && item.status === "ACTIVE"))
          throw Error("Completed selected file was not active in inventory: " +
            JSON.stringify({ complete: complete.body.data?.item,
              listError: fileInventory.body.error?.code,
              listStatus: fileInventory.status,
              items: fileInventory.body.data?.items?.map((item) =>
                ({ id: item.id, status: item.status, kind: item.kind })),
              cursor: Boolean(fileInventory.body.data?.nextCursor) }));
        const selected = await chat(agentId,
          'run-code: import json, requests; f=json.load(open("selected-files.json"))[0]; r=requests.get(f["url"],timeout=10); print(f["name"],r.status_code,r.text)',
          [upload.body.data.id]);
        if (!selected.text.includes("smoke.txt 200 " + fileBody) ||
          selected.text.includes("X-Amz-Signature="))
          throw Error("Interpreter could not use the selected version-pinned file: " +
            selected.text.slice(-900).replace(/https?:\/\/[^\s"]+/g, "[url]"));
        const saved = await chat(agentId, "save-artifact-smoke", [], true);
        if (saved.status !== 200 ||
          !saved.text.includes('"name":"save_artifact","isError":false') ||
          !saved.text.includes('"type":"message.done"') ||
          saved.text.includes("X-Amz-Signature="))
          throw Error("Interpreter output was not saved by the managed tool: " +
            saved.text.slice(-700));
        const artifacts = await call("objects.list", { projectId: "main" });
        const artifact = artifacts.body.data?.items?.find((item) =>
          item.kind === "artifact" && item.name === "report.txt");
        if (!artifact || artifact.sizeBytes !==
          new TextEncoder().encode("Saved by AgentCore smoke test").length)
          throw Error("Saved output was missing from the quota-counted inventory");
        const download = await call("objects.get", {
          projectId: "main", id: artifact.id });
        const actual = await fetch(download.body.data.url).then((response) =>
          response.text());
        if (actual !== "Saved by AgentCore smoke test")
          throw Error("Saved output bytes could not be retrieved");
        const removedArtifact = await call("objects.delete", {
          projectId: "main", id: artifact.id });
        if (removedArtifact.status !== 200)
          throw Error("Saved output could not be deleted");
        const wrongFile = await chat(agentId, "run-code: print('no')",
          [crypto.randomUUID()]);
        if (!wrongFile.text.includes("FILE_UNAVAILABLE"))
          throw Error("Unowned file selection was accepted");
        const py = await chat(agentId,
          'run-code: import os, hashlib; print(hashlib.sha256(os.environ["GITHUB_TOKEN"].encode()).hexdigest())');
        if (py.status !== 200 || !py.text.includes(await digest(rawKey)) ||
          !py.text.includes('"type":"message.done"'))
          throw Error("Python did not receive the granted token");
        const js = await chat(agentId,
          'run-js: console.log(Boolean(process.env.GITHUB_TOKEN), process.env.GITHUB_TOKEN.length)');
        if (js.status !== 200 || !js.text.includes(`true ${rawKey.length}`) ||
          !js.text.includes('"type":"message.done"'))
          throw Error("Node did not receive the granted token");
        const leaked = await chat(agentId,
          'run-code: import os; print(os.environ["GITHUB_TOKEN"])');
        if (leaked.status !== 200 || leaked.text.includes(rawKey) ||
          !leaked.text.includes("[redacted]"))
          throw Error("Tool output exposed the granted token");
        const rotated = await call("connections.rotate", {
          projectId: "main", id, apiKey: nextKey,
        });
        if (rotated.status !== 200 || rotated.text.includes(nextKey))
          throw Error("Rotation failed or leaked its key");
        const shell = await chat(agentId,
          'run-command: printf %s "$GITHUB_TOKEN" | sha256sum');
        if (shell.status !== 200 || !shell.text.includes(await digest(nextKey)) ||
          !shell.text.includes('"type":"message.done"'))
          throw Error("Shell did not receive the rotated token");
        const deleted = await call("connections.delete", { projectId: "main", id });
        const revoked = await chat(agentId, "run-code: print('should not run')");
        if (deleted.status !== 200 || revoked.status !== 200 ||
          !revoked.text.includes("CONNECTION_REVOKED"))
          throw Error("Deleted grant remained usable");
        const streams = [selected.text, saved.text, py.text, js.text,
          leaked.text, shell.text];
        if (realKey) {
          const realConnection = await call("connections.put", {
            projectId: "main", name: "Live GitHub verification",
            kind: "github", apiKey: realKey,
          });
          if (realConnection.status !== 200 || realConnection.text.includes(realKey))
            throw Error("Real GitHub connection failed or leaked its key");
          const realId = realConnection.body.data.id;
          const liveCheck = await call("connections.test", {
            projectId: "main", id: realId });
          if (liveCheck.status !== 200 || !liveCheck.body.data.connected ||
            liveCheck.text.includes(realKey))
            throw Error("Real GitHub read-only check failed or leaked its token");
          const realAgent = await call("agents.put", { projectId: "main",
            name: "Live GitHub read", modelId: "test.echo", codeInterpreter: true,
            connectionIds: [realId] });
          if (realAgent.status !== 200) throw Error("Real GitHub agent creation failed");
          const real = await chat(realAgent.body.data.id,
            'run-code: import os, requests; r=requests.get("https://api.github.com/user",headers={"Authorization":"Bearer "+os.environ["GITHUB_TOKEN"],"Accept":"application/vnd.github+json"},timeout=10); print("GitHub status",r.status_code)');
          if (real.status !== 200 || !real.text.includes("GitHub status 200") ||
            !real.text.includes('"type":"message.done"'))
            throw Error("Real GitHub /user read failed");
          const removed = await call("connections.delete", { projectId: "main", id: realId });
          if (removed.status !== 200) throw Error("Real GitHub cleanup failed");
          streams.push(real.text);
        }
        return { streams };
      }, { url: fixture.controllerUrl, token: accessToken,
        realKey: process.env.GITHUB_PAT || null });
      if (result.streams.some((stream) => !stream.includes('"type":"tool.done"')))
        throw new Error("Connection tool usage was not observed");
      return;
    }
    if (story === "runtime-model") {
      const catalog = (await import("./models.json", { with: { type: "json" } })).default;
      const selected = process.env.AGENTCORE_TEST_MODEL;
      const toolStory = process.env.AGENTCORE_TEST_WEB === "1";
      const browserStory = process.env.AGENTCORE_TEST_BROWSER === "1";
      const codeStory = process.env.AGENTCORE_TEST_CODE === "1";
      const denyStory = process.env.AGENTCORE_TEST_DENY === "1";
      if (selected && !catalog.some((model) =>
        ["bedrock", "gemini"].includes(model.transport) && model.id === selected))
        throw new Error("AGENTCORE_TEST_MODEL must name a checked-in live model");
      if ([toolStory, browserStory, codeStory, denyStory].filter(Boolean).length > 1)
        throw new Error("Choose one live tool scenario");
      if (denyStory && !selected)
        throw new Error("AGENTCORE_TEST_DENY requires AGENTCORE_TEST_MODEL");
      if (toolStory && !selected)
        throw new Error("AGENTCORE_TEST_WEB requires AGENTCORE_TEST_MODEL");
      if (browserStory && (!selected ||
        !catalog.find((model) => model.id === selected)?.browserTool))
        throw new Error("AGENTCORE_TEST_BROWSER requires one Browser-compatible AGENTCORE_TEST_MODEL");
      if (codeStory && !selected)
        throw new Error("AGENTCORE_TEST_CODE requires AGENTCORE_TEST_MODEL");
      for (const { id: modelId } of catalog.filter((model) =>
        (selected ? model.id === selected : model.transport === "bedrock"))) {
      const defaultModelId = browserStory
        ? "global.anthropic.claude-fable-5-1"
        : modelId === "global.openai.gpt-6-luna"
          ? "global.anthropic.claude-fable-5-1" : "global.openai.gpt-6-luna";
      const runtimeSessionId = `model-${crypto.randomUUID()}`;
      const ids = await page.evaluate(async ({ url, token, defaultModelId, toolStory, browserStory, codeStory, runtimeSessionId }) => {
        const response = await fetch(url, { method: "POST", headers: {
          authorization: `Bearer ${token}`, "content-type": "application/json",
          "x-amzn-bedrock-agentcore-runtime-session-id": runtimeSessionId,
        }, body: JSON.stringify({ v: 1, command: "agents.put", input: {
          projectId: "main", name: "Full-ceiling model smoke",
          modelId: defaultModelId, webSearch: toolStory, browser: browserStory,
          codeInterpreter: codeStory,
        } }) });
        const body = await response.json();
        if (!response.ok || !body.ok)
          throw Error(`Could not create model smoke agent: ${response.status} ${body.error?.code || ""}`);
        return { agentId: body.data.id, sessionId: crypto.randomUUID() };
      }, { url: fixture.controllerUrl, token: accessToken, defaultModelId,
        toolStory, browserStory, codeStory, runtimeSessionId });
      fixture.trackChat(ids.agentId, ids.sessionId);
      const result = await page.evaluate(async ({ url, token, ids, modelId, toolStory, browserStory, codeStory, denyStory, runtimeSessionId }) => {
        const started = performance.now();
        const response = await fetch(url, { method: "POST", headers: {
          authorization: `Bearer ${token}`, "content-type": "application/json",
          "x-amzn-bedrock-agentcore-runtime-session-id": runtimeSessionId,
        }, body: JSON.stringify({ v: 1, command: "chat.send", input: {
          projectId: "main", ...ids, requestId: crypto.randomUUID(),
          modelId, thinkingLevel: toolStory || browserStory || codeStory ? "high" : "low",
          message: toolStory
            ? "Use web_search to find the official Amazon Bedrock AgentCore documentation, then answer with one short sentence and a source."
            : browserStory
            ? modelId === "gemini-3.8-flash"
              ? "Call browser to navigate to https://example.com/. Then call browser again with screenshot. Finally tell me the visible page title in one sentence."
              : "Use the browser tool to navigate to https://example.com/ and tell me the visible page title in one sentence."
            : codeStory
            ? "Use execute_code with Python to print GEMINI_CODE_OK, then report that output."
            : denyStory
            ? "Use web_search to find the official AgentCore documentation, then answer briefly."
            : "Reply with OK only.",
        } }) });
        return { status: response.status, stream: await response.text(),
          elapsedMs: Math.round(performance.now() - started) };
      }, { url: fixture.controllerUrl, token: accessToken, ids, modelId,
        toolStory, browserStory, codeStory, denyStory, runtimeSessionId });
      if (denyStory && result.status === 200 &&
        result.stream.includes('"type":"error"')) {
        const [usage, events] = await Promise.all([
          fixture.readUsage(), fixture.readChat(ids.agentId, ids.sessionId),
        ]);
        if (!result.stream.includes("The model could not form a valid tool call.") ||
          result.stream.includes('"type":"tool.done"') ||
          (usage.Items || []).some((row) => row.name?.S === "web_search") ||
          (events.events || []).length)
          throw new Error("An ungranted search executed or persisted after model error");
        console.log("REAL_MODEL_DENIED " + JSON.stringify({ modelId,
          elapsedMs: result.elapsedMs }));
        continue;
      }
      if (result.status !== 200 || !result.stream.includes('"type":"message.done"'))
        throw new Error("Real-model turn incomplete: " + result.stream.slice(-1000));
      if (toolStory && (!result.stream.includes('"name":"web_search","isError":false') ||
        !result.stream.includes("Sources:")))
        throw new Error("Real-model tool continuation incomplete: " + result.stream.slice(-1200));
      const visibleText = result.stream.split("\n\n")
        .filter((chunk) => chunk.startsWith("data: "))
        .map((chunk) => JSON.parse(chunk.slice(6)))
        .filter((event) => event.type === "message.delta")
        .map((event) => event.text).join("");
      if (browserStory && (!result.stream.includes('"name":"browser","isError":false') ||
        !/Example Domain/i.test(visibleText)))
        throw new Error("Real-model Browser continuation incomplete: " + result.stream.slice(-1600));
      if (codeStory && (!result.stream.includes('"name":"execute_code","isError":false') ||
        !visibleText.includes("GEMINI_CODE_OK")))
        throw new Error("Real-model Code continuation incomplete: " + result.stream.slice(-1600));
      if (denyStory && result.stream.includes('"type":"tool.done"'))
        throw new Error("An ungranted managed tool ran");
      if (browserStory && modelId === "gemini-3.8-flash" &&
        result.stream.split('"name":"browser","isError":false').length < 3)
        throw new Error("Gemini did not complete two signed Browser tool steps");
      if (modelId === "gemini-3.8-flash" &&
        result.stream.includes("output limit before producing a visible reply"))
        throw new Error("Gemini smoke used all tokens on thinking");
      const [usage, agent, events] = await Promise.all([
        fixture.readUsage(), fixture.readAgent(ids.agentId),
        fixture.readChat(ids.agentId, ids.sessionId),
      ]);
      if (agent?.modelId?.S !== defaultModelId ||
        !(usage.Items || []).some((row) => row.modelId?.S === modelId) ||
        ((toolStory || browserStory || codeStory) &&
          !(usage.Items || []).some((row) => row.name?.S ===
            (toolStory ? "web_search" : browserStory ? "browser" : "execute_code"))) ||
        !(events.events || []).some((event) =>
          event.payload?.[2]?.json?.content?.modelId === modelId))
        throw new Error("Per-turn model override changed the agent or lost attribution");
      if (toolStory && !(events.events || []).some((event) =>
        /Sources:[\s\S]*https:\/\//.test(
          event.payload?.[1]?.conversational?.content?.text || "")))
        throw new Error("Web Search citations were not retained in Memory");
      if (denyStory && ((usage.Items || []).some((row) => row.name?.S === "web_search") ||
        (events.events || []).some((event) =>
          event.payload?.[2]?.json?.content?.toolCalls?.length)))
        throw new Error("Ungranted Web Search appeared in usage or Memory");
      if (modelId === "gemini-3.8-flash" && /thoughtSignature|inlineData/
        .test(JSON.stringify(events.events || [])))
        throw new Error("Gemini signature or screenshot escaped request-local history");
      if (modelId === "gemini-3.8-flash") {
        const followUp = await page.evaluate(async ({ url, token, ids, modelId, runtimeSessionId }) => {
          const response = await fetch(url, { method: "POST", headers: {
            authorization: `Bearer ${token}`, "content-type": "application/json",
            "x-amzn-bedrock-agentcore-runtime-session-id": runtimeSessionId,
          }, body: JSON.stringify({ v: 1, command: "chat.send", input: {
            projectId: "main", ...ids, requestId: crypto.randomUUID(),
            modelId, thinkingLevel: "low",
            message: "Reply SECOND only.",
          } }) });
          return { status: response.status, stream: await response.text() };
        }, { url: fixture.controllerUrl, token: accessToken, ids, modelId, runtimeSessionId });
        if (followUp.status !== 200 || !followUp.stream.includes('"type":"message.done"'))
          throw new Error("Gemini follow-up incomplete: " + followUp.stream.slice(-1000));
        const events = await fixture.readChat(ids.agentId, ids.sessionId);
        if ((events.events || []).length < 2)
          throw new Error("Gemini follow-up was not retained in Memory");
      }
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
    if (story === "runtime-web") {
      const result = await page.evaluate(async ({ url, token }) => {
        const invoke = async (command, input) => {
          const response = await fetch(url, { method: "POST", headers: {
            authorization: `Bearer ${token}`, "content-type": "application/json",
            "x-amzn-bedrock-agentcore-runtime-session-id": `smoke-${crypto.randomUUID()}`,
          }, body: JSON.stringify({ v: 1, command, input }) });
          return command === "chat.send" ? await response.text() : await response.json();
        };
        const created = await invoke("agents.put", { projectId: "main",
          name: "Web and Browser smoke", modelId: "test.echo",
          webSearch: true, browser: true });
        if (!created.ok) return { created };
        const agentId = created.data.id, sessionId = crypto.randomUUID();
        const send = (message) => invoke("chat.send", { projectId: "main",
          agentId, sessionId, requestId: crypto.randomUUID(), message });
        return { agentId, sessionId,
          search: await send("run-search: Amazon Bedrock AgentCore documentation"),
          browser: await send("run-browser: https://example.com/"),
          reopened: await invoke("conversations.get", {
            projectId: "main", agentId, conversationId: sessionId }) };
      }, { url: fixture.controllerUrl, token: accessToken });
      if (!result.search?.includes('"name":"web_search","isError":false') ||
        !result.search.includes("Sources:") ||
        !result.search.includes('"type":"message.done"') ||
        !result.browser?.includes('"name":"browser","isError":false') ||
        !result.browser.includes('"type":"message.done"') ||
        !result.reopened?.ok ||
        !result.reopened.data.messages.some((item) =>
          item.role === "assistant" && item.text.includes("Sources:") &&
          item.tools?.some((tool) => tool.name === "web_search")))
        throw new Error("Live Web Search or Browser failed: " + JSON.stringify(result).slice(0, 1800));
      const usage = await fixture.readUsage();
      if (usage.Items?.length !== 4 ||
        !usage.Items.some((item) => item.name?.S === "web_search") ||
        !usage.Items.some((item) => item.name?.S === "browser"))
        throw new Error("Web and Browser usage rows missing");
      await page.reload();
      await page.locator('[data-app-state="ready"]').waitFor({ timeout: 45000 });
      await page.getByRole("button", {
        name: "run-search: Amazon Bedrock AgentCore documentation",
      }).click();
      await page.locator('.message.assistant .message-text a[href^="https://"]')
        .first().waitFor();
      if (screenshot)
        await page.evaluate(async () => {
          const { _screenshot } = await import("./tests.js");
          await _screenshot("live-web-conversation", undefined, { fullPage: true });
        });
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
          message: toolStory
            ? "run-code: import os; print(2+2, os.getenv('AGENTCORE_PROJECT_ID'))"
            : "hello runtime",
        } }) });
        const stream = await response.text();
        if (toolStory) {
          const command = await fetch(url, { method: "POST", headers: {
            authorization: `Bearer ${token}`, "content-type": "application/json",
            "x-amzn-bedrock-agentcore-runtime-session-id": `smoke-${crypto.randomUUID()}`,
          }, body: JSON.stringify({ v: 1, command: "chat.send", input: {
            projectId: "main", agentId, sessionId, requestId: crypto.randomUUID(),
            message: "run-command: printf '%s' \"$AGENTCORE_PROJECT_ID\"",
          } }) });
          return { agentId, sessionId, requestId, status: response.status, stream,
            commandStatus: command.status, commandStream: await command.text(),
            elapsedMs: performance.now() - started };
        }
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
          !result.stream.includes("4 main") || !result.stream.includes('"type":"message.done"') ||
          result.commandStatus !== 200 ||
          !result.commandStream?.includes('"name":"execute_command"') ||
          !result.commandStream.includes("main") ||
          !result.commandStream.includes('"type":"message.done"'))
          throw new Error("Runtime managed tool turn failed: " + JSON.stringify(result));
        const usage = await fixture.readUsage();
        if (usage.Items?.length !== 4 ||
          usage.Items.filter((item) => item.unpricedToolCalls?.N === "1").length !== 2 ||
          !usage.Items.some((item) => item.quality?.S === "unpriced" && item.name?.S === "execute_code") ||
          !usage.Items.some((item) => item.quality?.S === "unpriced" && item.name?.S === "execute_command"))
          throw new Error("Managed tool invocation was not recorded as unpriced");
        console.log("TOOL TIMING " + JSON.stringify({ browserCompleteMs: Math.round(result.elapsedMs),
          sampleCount: 2, inference: "scripted", tool: "real AgentCore Code Interpreter" }));
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
    if (result.body?.data?.user?.budgetMicroUsd !== 5000000)
      throw new Error("CodeZip Runtime did not resolve the default user limit");
    const configured = await page.evaluate(async ({ url, token }) => {
      const call = async (command, input) => {
        const response = await fetch(url, { method: "POST", headers: {
          authorization: `Bearer ${token}`, "content-type": "application/json",
          "x-amzn-bedrock-agentcore-runtime-session-id": `model-config-${crypto.randomUUID()}`,
        }, body: JSON.stringify({ v: 1, command, input }) });
        return response.json();
      };
      const catalog = await call("models.list", {});
      const model = catalog.data?.items?.find((item) =>
        item.id === "global.openai.gpt-6-luna");
      const created = await call("agents.put", { projectId: "main",
        name: "Model config smoke", modelId: model?.id,
        thinkingLevel: "low", maxOutputTokens: 16 });
      const more = [];
      for (let i = 0; i < 3; i++)
        more.push(await call("agents.put", { projectId: "main",
          name: `Model config smoke ${i}`, modelId: model?.id, thinkingLevel: "low" }));
      const rejected = await call("agents.put", { projectId: "main",
        name: "Invalid thinking", modelId: model?.id, thinkingLevel: "unsupported" });
      const rejectedBrowser = await call("agents.put", { projectId: "main",
        name: "Invalid visual browser", modelId: model?.id, browser: true });
      const invalidTurn = await fetch(url, { method: "POST", headers: {
        authorization: `Bearer ${token}`, "content-type": "application/json",
        "x-amzn-bedrock-agentcore-runtime-session-id": `model-config-${crypto.randomUUID()}`,
      }, body: JSON.stringify({ v: 1, command: "chat.send", input: {
        projectId: "main", agentId: created.data?.id,
        sessionId: crypto.randomUUID(), requestId: crypto.randomUUID(),
        message: "Do not invoke", modelId: model?.id, thinkingLevel: "unsupported",
      } }) });
      return { model, created, more, rejected, rejectedBrowser,
        invalidTurn: await invalidTurn.text() };
    }, { url: fixture.controllerUrl, token: accessToken });
    if (!configured.model || configured.model.maxOutputTokens <= 4096 ||
      configured.model.contextTokens < configured.model.maxOutputTokens ||
      !configured.model?.thinkingLevels?.includes("low") ||
      configured.created?.data?.thinkingLevel !== "low" ||
      configured.more.some((item) => !item.ok) ||
      new Set([configured.created, ...configured.more].map((item) => item.data?.id)).size !== 4 ||
      "maxOutputTokens" in (configured.created?.data || {}) ||
      configured.rejected?.error?.code !== "VALIDATION_FAILED" ||
      configured.rejectedBrowser?.error?.code !== "TOOL_UNAVAILABLE" ||
      !configured.invalidTurn.includes('"code":"VALIDATION_FAILED"'))
      throw new Error("Model catalog/config contract failed: " +
        JSON.stringify(configured).slice(0, 1200));
    return;
  }
  const openManage = async (name) => {
    if (page.viewportSize().width < 761) {
      await page.getByRole("button", { name: "Open menu" }).click();
      await page.getByRole("dialog").getByRole("button", { name, exact: true }).click();
    } else {
      await page.getByRole("button", {
        name: name === "Agents" ? /View agents/ : new RegExp(name),
      }).last().click();
    }
  };
  await openManage("Account");
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
  await openManage("Users");
  await page.getByRole("dialog").getByText(fixture.email).waitFor();
  await page.getByRole("dialog").getByRole("heading", {
    name: "Account defaults" }).waitFor();
  const ownLimits = page
    .getByRole("dialog")
    .locator(".item")
    .filter({ hasText: fixture.email });
  await ownLimits.locator('input[name="inheritBudget"]').uncheck();
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
  await openManage("Agents");
  await page.getByRole("dialog").locator("#agent-model option[value='global.openai.gpt-6-luna']")
    .waitFor({ state: "attached" });
  await page.getByRole("dialog").locator("#agent-model")
    .selectOption("global.openai.gpt-6-luna");
  await page.getByRole("dialog").getByText(/128,000 maximum output tokens/).waitFor();
  const thinking = page.getByRole("dialog").locator("#agent-thinking");
  if (!(await thinking.locator('option[value="max"]').count()) ||
    (await thinking.inputValue()) !== "medium")
    throw new Error("OpenAI model thinking choices were not loaded from the catalog");
  if (!(await page.getByRole("dialog").locator('input[name="browser"]').isDisabled()) ||
    (await page.getByRole("dialog").locator('input[name="webSearch"]').isDisabled()))
    throw new Error("GPT-6 must offer Web Search without unsupported visual Browser");
  if (screenshot) {
    await thinking.scrollIntoViewIfNeeded();
    await page.evaluate(async () => {
      const { _screenshot } = await import("./tests.js");
      await _screenshot("live-model-settings", document.querySelector("dialog[open]"));
    });
  }
  if (await page.getByRole("dialog")
    .locator("#agent-model option[value='gemini-3.8-flash']").isDisabled() === fixture.hasGemini)
    throw new Error("Gemini dropdown availability must match the stack credential");
  if (fixture.hasGemini) {
    await page.getByRole("dialog").locator("#agent-model").selectOption("gemini-3.8-flash");
    await page.getByRole("dialog").getByText(/65,536 maximum output tokens/).waitFor();
    if (await thinking.locator('option[value="max"]').count() ||
      (await thinking.inputValue()) !== "medium")
      throw new Error("Gemini thinking choices must be model-specific");
    if (await page.getByRole("dialog").locator('input[name="codeInterpreter"]').isDisabled() ||
      await page.getByRole("dialog").locator('input[name="webSearch"]').isDisabled() ||
      await page.getByRole("dialog").locator('input[name="browser"]').isDisabled())
      throw new Error("Configured Gemini must offer all managed tools");
    if (screenshot)
      await page.evaluate(async () => {
        const { _screenshot } = await import("./tests.js");
        await _screenshot("live-gemini-tools", document.querySelector("dialog[open]"));
      });
  }
  await page.getByRole("dialog").getByRole("button", { name: "Close dialog" }).click();
  await openManage("Usage");
  await page.getByRole("dialog").getByText(/Not yet metered|\$0\.00/).first().waitFor();
  await page.getByRole("dialog").locator("#usage-range").selectOption("90d");
  await page.getByRole("dialog").locator("#usage-sort").selectOption("asc");
  const combinedUsage = page.waitForResponse((reply) =>
    reply.request().postDataJSON()?.command === "usage.get" &&
    reply.request().postDataJSON()?.input?.scope === "all");
  await page.getByRole("dialog").locator("#usage-scope").selectOption("all");
  const combinedBody = await (await combinedUsage).json();
  if (!combinedBody.ok) throw new Error("Combined usage read failed");
  await page.getByRole("dialog").getByText(/(Daily|Weekly|Monthly) ·/).waitFor();
  if (combinedBody.data.items.length)
    await page.getByRole("dialog").locator(".item").first().waitFor();
  else
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
