import assert from "node:assert/strict";
import { chromium } from "../../node_modules/playwright/index.mjs";
import { startServer } from "../../server.js";
import { mkdir } from "node:fs/promises";
import catalog from "../runtime/models.json" with { type: "json" };

const server = await startServer(
  0,
  new URL("../../", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"),
);
const base = `http://localhost:${server.address().port}/agentcore/`;
const browser = await chromium.launch();
const config = {
  region: "us-east-1",
  stack: "pages-test",
  pool: "us-east-1_test",
  client: "client",
  scope: "chat-api/access",
  domain: "https://pages-test.auth.us-east-1.amazoncognito.com",
  runtime: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test",
};
const sub = "11111111-1111-4111-a111-111111111111",
  other = "22222222-2222-4222-a222-222222222222";
const defaults = {
  budgetMicroUsd: 5000000,
  storageBytes: 5000000000,
  period: "daily",
  revision: 1,
};
const user = {
  sub,
  email: "admin@example.com",
  role: "Administrators",
  enabled: true,
  status: "CONFIRMED",
  protected: true,
  ...defaults,
  budgetInherited: true,
  storageInherited: true,
  periodInherited: true,
  storageUsedBytes: 1200000,
};
const second = {
  ...user,
  sub: other,
  email: "member@example.com",
  role: "Members",
  protected: false,
};
const snapshots = new URL("../.artifacts/screenshots/pages/", import.meta.url);
await mkdir(snapshots, { recursive: true });
try {
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 1000 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    const context = await browser.newContext({ viewport });
    await context.addInitScript(
      ({ config, sub }) => {
        if (sessionStorage.getItem("agentcore:deployment")) return;
        const token =
          btoa(JSON.stringify({ alg: "none" })) +
          "." +
          btoa(
            JSON.stringify({
              iss: `https://cognito-idp.${config.region}.amazonaws.com/${config.pool}`,
              client_id: config.client,
              token_use: "access",
              scope: config.scope,
              "cognito:groups": ["Administrators"],
              sub,
              exp: Math.floor(Date.now() / 1000) + 3600,
            }),
          ) +
          ".test";
        sessionStorage.setItem("agentcore:deployment", JSON.stringify(config));
        sessionStorage.setItem(
          `agentcore:session:${config.runtime}:${config.client}`,
          JSON.stringify({
            tokens: {
              access_token: token,
              id_token:
                btoa(JSON.stringify({ alg: "none" })) +
                "." +
                btoa(JSON.stringify({ email: "admin@example.com" })) +
                ".test",
            },
            runtimeSessionId: "pages-test-session",
          }),
        );
      },
      { config, sub },
    );
    const calls = [],
      errors = [];
    // Boot check only: imitate the Runtime's ~400ms round trip and one cold start.
    let delay = 0,
      cold = false;
    let credentialItems = [],
      connectionItems = [];
    await context.route("**/invocations?qualifier=DEFAULT", async (route) => {
      const { command, input } = route.request().postDataJSON();
      calls.push({ command, input });
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      // Same shape as production: the terminal snapshot repeats the last progress sequence.
      if (command === "chat.watch") {
        await new Promise((resolve) => setTimeout(resolve, 800));
        return route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: [
            { type: "message.delta", sequence: 1, text: "Done" },
            { type: "message.done", sequence: 2, eventId: "3#c", branchId: "main" },
            { type: "run.status", status: "completed", sequence: 2, branchId: "main" },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
        });
      }
      if (cold && command === "session.get") {
        cold = false;
        return route.fulfill({
          status: 424,
          json: { ok: false, error: { code: "RUNTIME_STARTING" } },
        });
      }
      let data, error;
      const projectItems = [{ id: "main", name: "Main project" }];
      const conversation = {
        id: "44444444-4444-4444-a444-444444444444",
        agentId: "33333333-3333-4333-a333-333333333333",
        title: "Quarterly summary",
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        activeBranchId: "main",
      };
      const agent = {
        id: "33333333-3333-4333-a333-333333333333",
        name: "Research",
        modelId: catalog[0].id,
        revision: 0,
        systemPrompt: "Research carefully.",
      };
      if (command === "session.get") data = { apiVersion: 2, user, defaults };
      else if (command === "users.list")
        data = { items: [user, second], defaults, cursor: null };
      else if (command === "users.get")
        data = { user: input.userSub === other ? second : user, defaults };
      else if (command.startsWith("users.") || command === "defaults.set")
        data = { updated: true };
      else if (command === "projects.list") data = { items: projectItems };
      else if (command === "workspace.get")
        data = {
          session: { user, defaults },
          projects: projectItems,
          agents: [agent],
          models: catalog.map((model) => ({ ...model, active: true })),
          conversations: { items: [conversation] },
        };
      else if (command === "conversations.get")
        data = {
          messages: [
            { role: "user", text: "Summarise the Q3 numbers", eventId: "1#a" },
            {
              role: "assistant",
              text: "Revenue grew 12% quarter on quarter.\n\n```\nq3 = 1.12 * q2\n```\nSources: https://example.com/q3",
              eventId: "2#b",
              tools: [
                { name: "web_search", isError: false },
                { name: "execute_code", isError: true },
              ],
            },
          ],
          branches: [
            { id: "main", name: "Main", headEventId: "2#b" },
            { id: other, name: "Edit 1", headEventId: null },
          ],
          nextCursor: null,
        };
      else if (command === "chat.start") data = { requestId: input.requestId };
      else if (command === "agents.list") data = { items: [agent] };
      else if (command === "models.list")
        data = { items: catalog.map((model) => ({ ...model, active: true })) };
      else if (command === "objects.list")
        data = { items: [], limitBytes: defaults.storageBytes, usedBytes: 0 };
      else if (command === "usage.get")
        data = {
          items: [],
          costMicroUsd: 12345,
          budgetMicroUsd: 5000000,
          quality: "estimated",
          period: "PERIOD#daily#2026-10-10",
          daily: { items: [] },
        };
      else if (command === "credentials.list")
        data = { items: credentialItems };
      else if (command === "credentials.put") {
        credentialItems = [
          {
            id: other,
            name: input.name,
            kind: input.kind,
            revision: 0,
            usedBy: [],
          },
        ];
        data = credentialItems[0];
      } else if (command === "connections.list")
        data = { items: connectionItems };
      else if (command === "connections.put") {
        connectionItems = [{ ...input, id: sub, revision: 0 }];
        data = connectionItems[0];
      } else if (command === "connections.test")
        data = { connected: true, account: "pages-test" };
      else error = { code: "UNEXPECTED_COMMAND_" + command };
      await route.fulfill({
        json: error ? { ok: false, error } : { ok: true, data },
      });
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    const navigation = async (path) => {
      await page.goto(base + path);
      await page.locator('[data-app-state="ready"]').waitFor();
    };
    delay = 400;
    cold = true;
    await page.goto(base);
    await page.locator('[data-boot-phase="warming"]').waitFor();
    assert.equal(await page.locator(".welcome").count(), 0);
    assert.equal(
      await page.locator(".account-head strong").textContent(),
      "admin@example.com",
      "Optimistic identity before session.get resolves",
    );
    await page.screenshot({
      path: new URL(`${name}-boot-warming.png`, snapshots).pathname.replace(
        /^\/([A-Z]:)/,
        "$1",
      ),
    });
    await page.locator('[data-app-state="ready"]').waitFor();
    await page.locator(".welcome").waitFor();
    const boot = calls.map(({ command }) => command);
    assert.deepEqual(
      [...boot].sort(),
      ["session.get", "session.get", "workspace.get"],
      "workspace.get starts beside session.get once; objects.list waits for the picker",
    );
    assert.ok(boot.indexOf("workspace.get") < boot.lastIndexOf("session.get"));
    delay = 0;
    calls.length = 0;
    if (name === "desktop") {
      await page.getByRole("button", { name: "Account menu" }).click();
      await page.getByRole("link", { name: "Profile", exact: true }).click();
      await page.getByRole("heading", { name: "admin@example.com" }).waitFor();
      await page.goto(base);
      await page.locator(".welcome").waitFor();
    }
    const shot = (label) =>
      page.screenshot({
        path: new URL(`${name}-${label}.png`, snapshots).pathname.replace(
          /^\/([A-Z]:)/,
          "$1",
        ),
      });
    if (name === "mobile")
      await page.getByRole("button", { name: "Show conversations" }).click();
    await page.locator(".history-item").first().click();
    await page.locator(".message.assistant .trace-line").first().waitFor();
    assert.equal(
      await page.locator('[data-state="error"] .trace-status').textContent(),
      "failed",
    );
    await page.waitForFunction(
      () => !document.querySelector(".topbar[data-busy]"),
    );
    await shot("chat-thread");
    await page.emulateMedia({ colorScheme: "dark" });
    await shot("chat-thread-dark");
    await page.emulateMedia({ colorScheme: "light" });
    await page.getByRole("textbox", { name: "Message" }).fill("Continue");
    await page.getByRole("button", { name: "Send ↑" }).click();
    await page.locator('.run-pill[data-state="working"]').waitFor();
    await shot("chat-running");
    await page.locator(".run-pill").waitFor({ state: "detached", timeout: 5000 });
    await page.getByRole("button", { name: "Send ↑" }).waitFor();
    assert.equal(
      calls.filter(({ command }) => command === "chat.watch").length,
      1,
      "A completed run is observed once, not reconnected forever",
    );
    await navigation("users/");
    await page.getByRole("link", { name: /member@example.com/ }).click();
    await page.getByRole("heading", { name: "member@example.com" }).waitFor();
    assert.match(page.url(), /profile\/\?user=/);
    await page.reload();
    await page.getByRole("heading", { name: "member@example.com" }).waitFor();
    await page.getByRole("link", { name: "View usage" }).click();
    await page.getByText("Viewing member@example.com").waitFor();
    assert.ok(
      calls.some(
        ({ command, input }) =>
          command === "usage.get" && input.userSub === other,
      ),
    );
    await page.locator("#usage-range").selectOption("90d");
    assert.match(page.url(), /range=90d/);
    await page.reload();
    assert.equal(await page.locator("#usage-range").inputValue(), "90d");
    for (const path of [
      "",
      "profile/",
      "users/",
      "usage/",
      "agents/",
      "connectors/",
      "credentials/",
    ]) {
      await navigation(path);
      await page.locator(".empty, .panel, .chat-panel").first().waitFor();
      if (path === "agents/") await page.locator("#agent-name").waitFor();
      await page.waitForFunction(
        () => !document.querySelector('#page-content [aria-busy="true"]'),
        null,
        { timeout: 5000 },
      );
      await page.screenshot({
        path: new URL(
          `${name}-${path.replace("/", "") || "chat"}.png`,
          snapshots,
        ).pathname.replace(/^\/([A-Z]:)/, "$1"),
        fullPage: true,
      });
      assert.ok(
        (await page.locator('nav a[aria-current="page"]').count()) === 1,
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth + 1,
        ),
        false,
        "Horizontal overflow: " + path,
      );
    }
    await navigation("credentials/");
    await page.getByLabel("Name", { exact: true }).fill("GitHub personal");
    await page
      .getByLabel("Secret", { exact: true })
      .fill("fixture-secret-never-persist");
    await page.getByRole("button", { name: "Save credential" }).click();
    await page.getByText("No connectors use this credential.").waitFor();
    assert.equal(await page.locator('input[name="secret"]').inputValue(), "");
    assert.equal(
      await page.evaluate(() =>
        JSON.stringify(sessionStorage).includes("fixture-secret"),
      ),
      false,
    );
    await navigation("connectors/");
    await page.getByLabel("Name", { exact: true }).fill("Code repository");
    await page.getByLabel("Saved credential").selectOption(other);
    await page.getByRole("button", { name: "Save connector" }).click();
    await page.getByRole("button", { name: "Test connection" }).click();
    await page.getByText("Connected · pages-test").waitFor();
    const write = calls.find(({ command }) => command === "connections.put");
    assert.equal(write.input.credentialId, other);
    assert.equal(write.input.apiKey, undefined);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("Unsaved name");
    const cancelEdit = page.getByRole("button", { name: "Cancel edit" });
    await cancelEdit.click();
    await page.getByRole("dialog", { name: "Confirm action" }).waitFor();
    await page.keyboard.press("Escape");
    assert.equal(
      await page.getByLabel("Name", { exact: true }).inputValue(),
      "Unsaved name",
    );
    assert.equal(
      await cancelEdit.evaluate(
        (element) => element === document.activeElement,
      ),
      true,
    );
    await cancelEdit.click();
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    if (name === "mobile") {
      await page.getByRole("button", { name: "Toggle navigation" }).click();
      await page.locator(".site-menu.open").waitFor();
      await page.waitForTimeout(300);
      await shot("menu");
    }
    assert.deepEqual(errors, []);
    console.log(
      "PASS: " +
        name +
        " page journey, direct refresh, URL filters, private credential form, shared navigation",
    );
    const peer = await context.newPage();
    await peer.goto(base + "profile/");
    await peer.locator('[data-app-state="ready"]').waitFor();
    await context.route("**/logout?**", (route) =>
      route.fulfill({ contentType: "text/html", body: "Signed out" }),
    );
    const signOut = page.getByRole("button", { name: "Sign out", exact: true });
    if (!(await signOut.isVisible()))
      await page.getByRole("button", { name: "Account menu" }).click();
    await signOut.click();
    await peer.locator('[data-app-state="disconnected"]').waitFor();
    assert.equal(
      await peer.evaluate(() =>
        Object.keys(sessionStorage).some((key) =>
          key.startsWith("agentcore:session:"),
        ),
      ),
      false,
    );
    console.log(
      "PASS: " +
        name +
        " sign-out clears tab state and broadcasts to other documents",
    );
    await context.close();
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
