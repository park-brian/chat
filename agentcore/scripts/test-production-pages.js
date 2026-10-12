// Bounded production smoke: temporary identity, owned records, one real turn.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { chromium } from "../../node_modules/playwright/index.mjs";
import { fileURLToPath } from "node:url";
import {
  catalogModelNames,
  createLiveFixture,
  readSession,
  submitHostedSignIn,
  transport,
} from "../tests/fixtures.js";
import { startServer } from "../../server.js";

process.loadEnvFile(new URL("../../.env", import.meta.url));
const visualOnly = process.argv.includes("--visual-only");
// Measure the currently published release before deploying local changes.
const baseline = process.argv.includes("--baseline");
// Serve this checkout on the pool's registered LocalUrl callback instead of the
// published origin, to exercise unpublished code against production services.
const local = process.argv.includes("--local");
let server;
const fixture = await createLiveFixture({
  stackName: "agentcore-chat-prod",
  region: "us-east-1",
  profile: process.env.AWS_PROFILE,
});
let browser, page;
const consoleLog = [];
const evidence = {
  stackName: "agentcore-chat-prod",
  startedAt: new Date().toISOString(),
  pages: [],
  rpc: [],
  boot: {},
};
const release = randomUUID();
try {
  const base = new URL(
    local ? "http://localhost:8000/agentcore/" : fixture.publicEntryUrl,
  );
  base.search = "";
  if (local)
    server = await startServer(
      8000,
      fileURLToPath(new URL("../../", import.meta.url)),
    );
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
  for (const file of baseline || local ? [] : files) {
    const url = new URL(file, base);
    url.searchParams.set("release", release);
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 200, file);
    const normalize = (text) => text.replaceAll("\r\n", "\n");
    assert.equal(
      normalize(await response.text()),
      normalize(await readFile(new URL("../" + file, import.meta.url), "utf8")),
      "Published file differs: " + file,
    );
  }
  if (!baseline && !local)
    console.log(
      "PASS: all 21 published entrypoints and shared assets match the validated source",
    );
  browser = await chromium.launch();
  page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) =>
    consoleLog.push(`${message.type()}: ${message.text()}`.slice(0, 300)),
  );
  page.on("response", async (response) => {
    if (response.url() === fixture.controllerUrl && response.status() !== 200)
      consoleLog.push(
        `runtime ${response.status()} ${response.request().postDataJSON()?.command}: ` +
          (await response.text().catch(() => "")).slice(0, 300),
      );
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) consoleLog.push("navigated: " + frame.url().slice(0, 120));
  });
  // Real latency evidence: each Runtime call, and the boot phases each document passes through.
  page.on("requestfinished", async (request) => {
    if (request.url() !== fixture.controllerUrl) return;
    evidence.rpc.push({
      command: request.postDataJSON()?.command,
      page: new URL(page.url()).pathname,
      ms: Math.round(request.timing().responseEnd),
      status: (await request.response())?.status(),
    });
  });
  await page.addInitScript(() => {
    const start = performance.now(),
      phases = [];
    window.__bootPhases = phases;
    let content = false;
    new MutationObserver(() => {
      const phase = document
        .querySelector(".page-layout")
        ?.getAttribute("data-boot-phase");
      if (phase && phases.at(-1)?.phase !== phase)
        phases.push({ phase, ms: Math.round(performance.now() - start) });
      // "content": the page's data is on screen, whether or not session.get has returned.
      const main = document.getElementById("page-content");
      if (
        !content &&
        main?.querySelector(".panel, .chat-panel, .signin") &&
        !main.querySelector('[aria-busy="true"], .boot')
      ) {
        content = true;
        phases.push({ phase: "content", ms: Math.round(performance.now() - start) });
      }
    }).observe(document, {
      subtree: true,
      attributes: true,
      childList: true,
    });
  });
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
  await submitHostedSignIn(page, fixture);
  await page.locator('[data-app-state="ready"]').waitFor({ timeout: 90000 });
  assert.equal(new URL(page.url()).pathname, new URL("users/", base).pathname);
  const auth = await readSession(page);
  fixture.trackRuntimeSession(auth.runtimeSessionId);
  fixture.setRuntimeStopToken(auth.tokens.access_token);
  const send = transport(fixture, auth);
  const rpc = async (command, input = {}) => {
    const result = await send(command, input);
    assert.equal(
      result.ok,
      true,
      command + ": " + JSON.stringify(result.error),
    );
    return result.data;
  };
  assert.equal((await rpc("session.get")).apiVersion, 3);
  assert.equal((await rpc("users.get")).user.sub, fixture.sub);
  const models = (await rpc("models.list")).items;
  for (const name of catalogModelNames)
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
  const shotPath = (file) =>
    fileURLToPath(new URL(file, screens));
  const settled = async (key) => {
    await page.locator('[data-app-state="ready"]').waitFor({ timeout: 90000 });
    await page.waitForFunction(
      () => !document.querySelector('#page-content [aria-busy="true"]'),
    );
    if (key === "chat")
      await page
        .locator(".chat-history .history-item, .chat-history .history-empty")
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
  const timing = () =>
    page.evaluate(() => ({ phases: window.__bootPhases }));
  const openLink = async (name) => {
    const link = page.getByRole("link", { name, exact: true });
    if (!(await link.isVisible()))
      await page.getByRole("button", { name: "Account menu" }).click();
    try {
      await link.click({ timeout: 15000 });
    } catch (cause) {
      await page.screenshot({ path: shotPath("failure.png") });
      console.log(await page.locator(".topbar").ariaSnapshot());
      throw cause;
    }
  };
  for (const key of [
    "profile",
    "users",
    "usage",
    "agents",
    "connectors",
    "credentials",
    "chat",
  ]) {
    await openLink(
      key === "chat" ? "Chat" : key[0].toUpperCase() + key.slice(1),
    );
    await settled(key);
    (evidence.nav ??= {})[key] = await timing();
    await page.reload();
    await settled(key);
    evidence.boot[key] = await timing();
    assert.equal(await page.locator('a[aria-current="page"]').count(), 1);
    await page.screenshot({
      path: shotPath(key + "-desktop.png"),
      fullPage: true,
      mask: [page.locator(".account-head")],
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
    path: shotPath("credentials-mobile.png"),
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
      conversationId: randomUUID(),
      requestId: randomUUID(),
      expectedHeadTurnId: null,
      message: "What is 19 + 23? Reply with the number only.",
    };
    await rpc("chat.start", input);
    await rpc("chat.start", input);
    await page.goto(new URL("usage/", base).href);
    await page.locator('[data-app-state="ready"]').waitFor();
    let run;
    const deadline = Date.now() + 120000;
    do {
      run = await rpc("chat.status", { requestId: input.requestId });
      if (run.status !== "running") break;
      assert.ok(Date.now() < deadline, "Production turn timed out");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } while (true);
    assert.equal(run.status, "completed");
    const chat = await rpc("conversations.get", {
      projectId: "main",
      agentId: agent.id,
      conversationId: input.conversationId,
    });
    assert.match(chat.messages.at(-1).text, /42/);
    assert.equal(
      (await fixture.readTurns(input.conversationId)).length,
      1,
    );
    assert.equal(
      (await fixture.readUsage()).Items.filter(
        (row) =>
          row.requestId?.S === input.requestId && row.kind?.S === "model",
      ).length,
      1,
    );
    await page.goto(new URL(`?conversation=${input.conversationId}`, base).href);
    await page.locator(".message.assistant").getByText(/42/).waitFor();
    await page.waitForFunction(() => !document.querySelector(".topbar[data-busy]"));
    await page.screenshot({ path: shotPath("chat-conversation-mobile.png") });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({
      path: shotPath("chat-conversation-desktop.png"),
      mask: [page.locator(".account-head")],
    });
    // The same conversation continued through the composer: Send, live run pill,
    // streamed answer, then the settled saved conversation.
    await page
      .getByRole("textbox", { name: "Message" })
      .fill("What is 50 + 8? Reply with the number only.");
    const sentAt = Date.now();
    await page.getByRole("button", { name: "Send ↑" }).click();
    await page.locator('.run-pill[data-state="working"]').waitFor();
    evidence.uiTurn = { pillMs: Date.now() - sentAt };
    await page.screenshot({ path: shotPath("chat-ui-turn-running.png") });
    await page
      .locator(".message.assistant")
      .getByText(/58/)
      .waitFor({ timeout: 120000 });
    evidence.uiTurn.answerMs = Date.now() - sentAt;
    await page.locator(".run-pill").waitFor({ state: "detached", timeout: 60000 });
    await page.waitForFunction(() => !document.querySelector(".topbar[data-busy]"));
    evidence.uiTurn.settledMs = Date.now() - sentAt;
    assert.equal(await page.locator(".message").count(), 4);
    assert.equal(await page.locator(".message-state").count(), 0);
    assert.equal(
      await page.getByRole("textbox", { name: "Message" }).inputValue(),
      "",
    );
    await page.screenshot({
      path: shotPath("chat-ui-turn-settled.png"),
      mask: [page.locator(".account-head")],
    });
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
} catch (cause) {
  // Cleanup can fail after a broken login; report the original failure first.
  console.error("SMOKE FAILURE:", cause);
  console.error(consoleLog.join("\n"));
  if (page)
    console.error(
      "state:",
      await page
        .evaluate(() => ({
          url: location.href,
          app: document.querySelector(".page-layout")?.dataset,
          alerts: [...document.querySelectorAll('[role="alert"]')].map((e) => e.textContent),
          main: document.getElementById("page-content")?.innerText.slice(0, 300),
        }))
        .catch((error) => error.message),
    );
  throw cause;
} finally {
  if (browser) await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
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
