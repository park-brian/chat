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
            api: "https://evil.example/rpc",
          }) !== null
        )
          throw new Error("Non-AWS token destination accepted");
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
    { randomUUID, randomBytes },
  ] = await Promise.all([
    import("@aws-sdk/credential-providers"),
    import("@aws-sdk/client-cloudformation"),
    import("@aws-sdk/client-cognito-identity-provider"),
    import("@aws-sdk/client-dynamodb"),
    import("node:crypto"),
  ]);
  const credentials = fromIni({ profile });
  const cf = new cloudformation.CloudFormationClient({ region, credentials });
  const idp = new cognito.CognitoIdentityProviderClient({
    region,
    credentials,
  });
  const db = new dynamodb.DynamoDBClient({ region, credentials });
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
  const cleanup = async () => {
    if (created)
      await idp.send(
        new cognito.AdminDeleteUserCommand({
          UserPoolId: pool,
          Username: email,
        }),
      );
    if (sub)
      await db.send(
        new dynamodb.DeleteItemCommand({
          TableName: outputs.DataTable,
          Key: { pk: { S: "USER#" + sub }, sk: { S: "CONTROL" } },
        }),
      );
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
  };
}

export async function runLiveStory(page, fixture, { story, screenshot }) {
  if (story && !["login", "runtime"].includes(story))
    throw new Error("Unknown live story: " + story);
  if (story === "runtime" && !fixture.controllerUrl)
    throw new Error("Live stack has no ControllerArn");
  const tokenResponse =
    story === "runtime"
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
  if (story === "runtime") {
    const accessToken = (await (await tokenResponse).json()).access_token;
    if (!accessToken) throw new Error("Cognito access token missing");
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
      response.url().endsWith("/rpc") &&
      response.request().postDataJSON()?.command === "users.setLimits",
  );
  const reloaded = page.waitForResponse(
    (response) =>
      response.url().endsWith("/rpc") &&
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
  await page
    .getByRole("button", { name: /Models/ })
    .first()
    .click();
  await page
    .getByRole("dialog")
    .getByRole("heading", { name: "Catalog" })
    .waitFor();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close dialog" })
    .click();
  await page.getByRole("button", { name: /Usage/ }).first().click();
  await page.getByRole("dialog").getByText("Not yet metered").waitFor();
}
