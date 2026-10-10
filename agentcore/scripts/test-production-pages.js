// Bounded production smoke: temporary identity, owned records, one real turn.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { chromium } from "../../node_modules/playwright/index.mjs";
import { createLiveFixture } from "../tests/fixtures.js";

process.loadEnvFile(new URL("../../.env", import.meta.url));
const visualOnly = process.argv.includes("--visual-only");
const fixture = await createLiveFixture({
  stackName: "agentcore-chat-prod",
  region: "us-east-1",
});
let browser;
const evidence = {
  stackName: "agentcore-chat-prod",
  startedAt: new Date().toISOString(),
  pages: [],
};
try {
  const base = new URL(fixture.publicEntryUrl);
  base.search = "";
  const files = [
    "index.html",
    "app.js",
    ...[
      "profile",
      "users",
      "usage",
      "agents",
      "connectors",
      "credentials",
    ].flatMap((key) => [key + "/index.html", key + "/app.js"]),
    ...[
      "page.js",
      "session.js",
      "api.js",
      "navigation.js",
      "ui.js",
      "styles.css",
      "importmap.json",
    ].map((file) => "shared/" + file),
  ];
  for (const file of files) {
    const url = new URL(file, base);
    url.searchParams.set("release", "d10ad44c002c5e960b60");
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 200, file);
    const normalize = (text) => text.replaceAll("\r\n", "\n");
    assert.equal(
      normalize(await response.text()),
      normalize(await readFile(new URL("../" + file, import.meta.url), "utf8")),
      "Published file differs: " + file,
    );
  }
  console.log(
    "PASS: all 21 published entrypoints and shared assets match the validated source",
  );
  browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", (request) => {
    if (["script", "stylesheet"].includes(request.resourceType()))
      errors.push("Failed asset: " + request.url());
  });
  page.on("request", (request) => {
    if (request.url() === fixture.controllerUrl) {
      const id =
        request.headers()["x-amzn-bedrock-agentcore-runtime-session-id"];
      if (id) fixture.trackRuntimeSession(id);
    }
  });
  const login = new URL("users/", base);
  for (const [name, value] of new URL(fixture.publicEntryUrl).searchParams)
    login.searchParams.set(name, value);
  await page.goto(login.href);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .locator('input[type="password"]')
    .first()
    .waitFor({ timeout: 30000 });
  await page
    .locator('input[type="email"], input[name="username"]')
    .first()
    .fill(fixture.email);
  await page.locator('input[type="password"]').first().fill(fixture.password);
  await page
    .locator('button[type="submit"], input[type="submit"]')
    .first()
    .click();
  await page.locator('[data-app-state="ready"]').waitFor({ timeout: 90000 });
  assert.equal(new URL(page.url()).pathname, new URL("users/", base).pathname);
  const auth = await page.evaluate(() => {
    const config = JSON.parse(sessionStorage.getItem("agentcore:deployment"));
    return JSON.parse(
      sessionStorage.getItem(
        `agentcore:session:${config.runtime}:${config.client}`,
      ),
    );
  });
  fixture.trackRuntimeSession(auth.runtimeSessionId);
  fixture.setRuntimeStopToken(auth.tokens.access_token);
  const rpc = async (command, input = {}) => {
    const response = await fetch(fixture.controllerUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + auth.tokens.access_token,
        "x-amzn-bedrock-agentcore-runtime-session-id": auth.runtimeSessionId,
      },
      body: JSON.stringify({ v: 1, command, requestId: randomUUID(), input }),
      signal: AbortSignal.timeout(120000),
    });
    assert.equal(response.ok, true, command + " HTTP " + response.status);
    const result = await response.json();
    assert.equal(
      result.ok,
      true,
      command + ": " + JSON.stringify(result.error),
    );
    return result.data;
  };
  assert.equal((await rpc("session.get")).apiVersion, 2);
  assert.equal((await rpc("users.get")).user.sub, fixture.sub);
  const models = (await rpc("models.list")).items;
  for (const name of [
    "Claude Haiku 5.5",
    "Claude Sonnet 5.5",
    "Claude Opus 5.5",
    "Claude Fable 5.1",
    "GPT-6.1 Sol",
    "GPT-6 Luna",
    "Gemini 3.8 Flash",
  ])
    assert.ok(
      models.some((model) => model.name === name),
      name,
    );
  assert.ok(!models.some((model) => model.id === "test.echo"));
  const screens = new URL(
    "../.artifacts/screenshots/production/",
    import.meta.url,
  );
  await mkdir(screens, { recursive: true });
  const settled = async (key) => {
    await page.locator('[data-app-state="ready"]').waitFor({ timeout: 90000 });
    await page.waitForFunction(
      () =>
        ![...document.querySelectorAll("#page-content .empty")].some(
          (element) => /^(Loading|Opening)/.test(element.textContent.trim()),
        ),
    );
    if (key === "chat")
      await page
        .locator(".chat-history select")
        .first()
        .locator("option")
        .first()
        .waitFor({ state: "attached" });
    assert.deepEqual(
      await page.locator('#page-content [role="alert"]').allTextContents(),
      [],
      key + " error notice",
    );
  };
  // Real links exercise the Users -> selected Profile -> filtered Usage journey.
  await page.locator(`a[href*="user=${fixture.sub}"]`).first().click();
  await page.getByRole("heading", { name: fixture.email }).waitFor();
  await page.reload();
  await page.getByRole("heading", { name: fixture.email }).waitFor();
  await page.getByRole("link", { name: "View usage" }).click();
  await page.locator("#usage-range").waitFor();
  assert.equal(new URL(page.url()).searchParams.get("user"), fixture.sub);
  await page.locator("#usage-range").selectOption("90d");
  await page.reload();
  assert.equal(await page.locator("#usage-range").inputValue(), "90d");
  for (const key of [
    "profile",
    "users",
    "usage",
    "agents",
    "connectors",
    "credentials",
    "chat",
  ]) {
    await page
      .getByRole("link", {
        name: key === "chat" ? "Chat" : key[0].toUpperCase() + key.slice(1),
        exact: true,
      })
      .click();
    await page.locator('[data-app-state="ready"]').waitFor({ timeout: 90000 });
    await page.reload();
    await settled(key);
    assert.equal(await page.locator('a[aria-current="page"]').count(), 1);
    await page.screenshot({
      path: new URL(key + "-desktop.png", screens).pathname.replace(
        /^\/(\w:)/,
        "$1",
      ),
      fullPage: true,
      mask: [page.locator(".sidebar-account")],
    });
    evidence.pages.push(key);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(new URL("profile/", base).href);
  await page.getByRole("heading", { name: fixture.email }).waitFor();
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await page.getByRole("link", { name: "Credentials", exact: true }).click();
  await settled("credentials");
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  await page.screenshot({
    path: new URL("credentials-mobile.png", screens).pathname.replace(
      /^\/(\w:)/,
      "$1",
    ),
    fullPage: true,
  });
  console.log(
    "PASS: published PKCE return, Users -> Profile -> Usage, seven direct refreshes and mobile navigation",
  );
  if (!visualOnly) {
    let credential = await rpc("credentials.put", {
      name: "Production smoke",
      kind: "github",
      secret: "synthetic-release-" + randomUUID(),
    });
    const connection = await rpc("connections.put", {
      projectId: "main",
      name: "Production smoke",
      kind: "github",
      credentialId: credential.id,
    });
    credential = (await rpc("credentials.list")).items.find(
      (item) => item.id === credential.id,
    );
    assert.equal(credential.usedBy.length, 1);
    assert.equal("secret" in credential, false);
    credential = await rpc("credentials.rotate", {
      id: credential.id,
      revision: credential.revision,
      secret: "synthetic-rotated-" + randomUUID(),
    });
    await rpc("connections.delete", {
      projectId: "main",
      id: connection.id,
      revision: connection.revision,
    });
    credential = (await rpc("credentials.list")).items.find(
      (item) => item.id === credential.id,
    );
    await rpc("credentials.delete", {
      id: credential.id,
      revision: credential.revision,
    });
    const agent = await rpc("agents.put", {
      projectId: "main",
      name: "Production smoke",
      modelId: "global.anthropic.claude-haiku-5-5",
      thinkingLevel: "low",
      systemPrompt: "Answer briefly.",
    });
    const input = {
      projectId: "main",
      agentId: agent.id,
      sessionId: randomUUID(),
      requestId: randomUUID(),
      expectedHeadEventId: null,
      message: "What is 19 + 23? Reply with the number only.",
    };
    fixture.trackChat(agent.id, input.sessionId);
    await rpc("chat.start", input);
    await rpc("chat.start", input);
    await page.goto(new URL("usage/", base).href);
    await page.locator('[data-app-state="ready"]').waitFor();
    let run;
    const deadline = Date.now() + 120000;
    do {
      run = await rpc("chat.status", { requestId: input.requestId });
      if (!["running", "memory_written"].includes(run.status)) break;
      assert.ok(Date.now() < deadline, "Production turn timed out");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } while (true);
    assert.equal(run.status, "completed");
    const chat = await rpc("conversations.get", {
      projectId: "main",
      agentId: agent.id,
      conversationId: input.sessionId,
    });
    assert.match(chat.messages.at(-1).text, /42/);
    assert.equal(
      (await fixture.readChat(agent.id, input.sessionId)).events.length,
      1,
    );
    assert.equal(
      (await fixture.readUsage()).Items.filter(
        (row) =>
          row.requestId?.S === input.requestId && row.kind?.S === "model",
      ).length,
      1,
    );
    await page.goto(new URL(`?conversation=${input.sessionId}`, base).href);
    await page.locator(".message.assistant").getByText(/42/).waitFor();
    assert.deepEqual(errors, []);
    evidence.completedAt = new Date().toISOString();
    evidence.passed = true;
    evidence.models = models.map((model) => model.name);
    console.log(
      "PASS: production private credential lifecycle and real background inference, durable result, one charge set",
    );
  }
  assert.deepEqual(errors, []);
  evidence.completedAt = new Date().toISOString();
  evidence.passed = true;
  evidence.visualOnly = visualOnly;
} finally {
  if (browser) await browser.close();
  await fixture.cleanup();
  evidence.cleanedAt = new Date().toISOString();
  await writeFile(
    new URL(
      visualOnly
        ? "../.artifacts/pages-production-visuals.json"
        : "../.artifacts/pages-production-smoke.json",
      import.meta.url,
    ),
    JSON.stringify(evidence, null, 2),
  );
}
