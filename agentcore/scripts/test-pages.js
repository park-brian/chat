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
  budgetMicroUsd: 5000123,
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
  // Not a round GB, so a rounded prefill would rewrite it on save.
  storageBytes: 1234567891,
  storageInherited: false,
};
const agent = {
  id: "33333333-3333-4333-a333-333333333333",
  name: "Research",
  modelId: catalog[0].id,
  revision: 0,
  systemPrompt: "Research carefully.",
};
// Field names and types each page mutation must send, checked as the UI drives them.
const shapes = {
  "agents.put": [
    {
      projectId: "string",
      name: "string",
      modelId: "string",
      systemPrompt: "string",
      codeInterpreter: "boolean",
      webSearch: "boolean",
      browser: "boolean",
      webSearchMaxResults: "integer",
      browserSessionSeconds: "integer",
      connectionIds: "strings",
      skillIds: "strings",
    },
    { id: "string", revision: "integer", thinkingLevel: "string" },
  ],
  "agents.setArchived": [
    { projectId: "string", id: "string", revision: "integer", archived: "boolean" },
  ],
  "objects.beginUpload": [
    {
      projectId: "string",
      name: "string",
      sizeBytes: "integer",
      contentType: "string",
      kind: "string",
    },
  ],
  "objects.completeUpload": [{ projectId: "string", id: "string" }],
  "projects.create": [{ id: "string", name: "string" }],
  "projects.rename": [{ id: "string", revision: "integer", name: "string" }],
  "projects.setHidden": [{ id: "string", revision: "integer", hidden: "boolean" }],
  "users.invite": [{ email: "string", role: "string" }],
  "users.setLimits": [
    {
      sub: "string",
      budgetMicroUsd: "integer?",
      storageBytes: "integer?",
      period: "string?",
    },
  ],
  "users.setRole": [{ sub: "string", role: "string" }],
  "users.setEnabled": [{ sub: "string", enabled: "boolean" }],
  "users.startNewBudgetPeriod": [{ sub: "string" }],
  "defaults.set": [
    {
      budgetMicroUsd: "integer",
      storageBytes: "integer",
      period: "string",
      revision: "integer",
    },
  ],
  "connections.put": [
    { name: "string", kind: "string", credentialId: "string" },
    { id: "string", revision: "integer", jiraUrl: "string", jiraEmail: "string" },
  ],
  "connections.test": [{ id: "string" }],
};
const typed = {
  string: (value) => typeof value === "string",
  boolean: (value) => typeof value === "boolean",
  integer: Number.isSafeInteger,
  strings: (value) =>
    Array.isArray(value) && value.every((item) => typeof item === "string"),
};
function shapeErrors(command, input) {
  const [required, optional = {}] = shapes[command] || [];
  if (!required) return [];
  const problems = [];
  for (const [name, type] of Object.entries({ ...required, ...optional })) {
    if (!(name in input)) {
      if (name in required) problems.push("missing " + name);
      continue;
    }
    const nullable = type.endsWith("?");
    if (!(nullable && input[name] === null) && !typed[type.replace("?", "")](input[name]))
      problems.push(`${name} is ${JSON.stringify(input[name])}, expected ${type}`);
  }
  for (const name of Object.keys(input))
    if (!(name in required) && !(name in optional))
      problems.push("unexpected " + name);
  return problems.map((problem) => `${command}: ${problem}`);
}
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
      cold = false,
      starting = false;
    let credentialItems = [],
      connectionItems = [],
      agentItems = [agent],
      objectItems = [],
      projectItems = [{ id: "main", name: "Main project" }],
      conflictNext = false;
    const invalid = [];
    await context.route(
      "https://pages-test.s3.us-east-1.amazonaws.com/**",
      (route) =>
        route.fulfill({
          status: 204,
          headers: { "Access-Control-Allow-Origin": "*" },
        }),
    );
    await context.route("**/invocations?qualifier=DEFAULT", async (route) => {
      const { command, input } = route.request().postDataJSON();
      calls.push({ command, input });
      const problems = shapeErrors(command, input);
      if (problems.length) {
        invalid.push(...problems);
        return route.fulfill({
          json: { ok: false, error: { code: "VALIDATION_FAILED" } },
        });
      }
      // Long enough that a second click lands while the first save is in flight.
      if (command === "agents.put")
        await new Promise((resolve) => setTimeout(resolve, 200));
      // session.get is held longer than page reads so overlap is observable.
      if (delay)
        await new Promise((resolve) =>
          setTimeout(resolve, command === "session.get" ? delay * 2 : delay),
        );
      // Same shape as production: the terminal snapshot repeats the last progress sequence.
      if (command === "chat.watch") {
        await new Promise((resolve) => setTimeout(resolve, 800));
        return route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: [
            { type: "message.delta", sequence: 1, text: "Done" },
            { type: "message.done", sequence: 2, turnId: "3#c", branchId: "main" },
            { type: "run.status", status: "completed", sequence: 2, branchId: "main" },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
        });
      }
      // AgentCore's answer to a call that overlaps the creation of its session.
      if (starting && command === "workspace.get") {
        starting = false;
        return route.fulfill({
          status: 409,
          json: { message: "Session operation in progress, please retry" },
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
      const conversation = {
        id: "44444444-4444-4444-a444-444444444444",
        agentId: "33333333-3333-4333-a333-333333333333",
        title: "Quarterly summary",
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        activeBranchId: "main",
      };
      const saved = (items, id) => items.find((item) => item.id === id);
      if (command === "session.get") data = { apiVersion: 3, user, defaults };
      else if (command === "users.list")
        data = { items: [user, second], defaults, cursor: null };
      else if (command === "users.get")
        data = { user: input.userSub === other ? second : user, defaults };
      else if (command === "defaults.set")
        data = { ...defaults, revision: defaults.revision + 1 };
      else if (command.startsWith("users.")) data = { updated: true };
      else if (command === "projects.list") data = { items: projectItems };
      else if (command === "projects.create") {
        data = { id: input.id, name: input.name, revision: 0 };
        projectItems = [...projectItems, data];
      } else if (["projects.rename", "projects.setHidden"].includes(command)) {
        const project = saved(projectItems, input.id);
        if (project?.revision !== input.revision) error = { code: "REVISION_CONFLICT" };
        else {
          data = {
            ...project,
            ...(command === "projects.rename"
              ? { name: input.name }
              : { hidden: input.hidden }),
            revision: project.revision + 1,
          };
          projectItems = projectItems.map((item) => (item.id === input.id ? data : item));
        }
      } else if (command === "agents.put") {
        const current = input.id && saved(agentItems, input.id);
        // One edit meets a newer revision saved elsewhere.
        if (current && conflictNext) {
          conflictNext = false;
          agentItems = agentItems.map((item) =>
            item.id === input.id
              ? { ...item, name: "Research (edited elsewhere)", revision: item.revision + 1 }
              : item,
          );
          error = { code: "REVISION_CONFLICT" };
        } else if (current && current.revision !== input.revision)
          error = { code: "REVISION_CONFLICT" };
        else {
          const { projectId, ...fields } = input;
          data = {
            ...fields,
            id: input.id || crypto.randomUUID(),
            revision: current ? current.revision + 1 : 0,
          };
          agentItems = current
            ? agentItems.map((item) => (item.id === data.id ? data : item))
            : [...agentItems, data];
        }
      } else if (command === "agents.setArchived") {
        const current = saved(agentItems, input.id);
        data = { ...current, archived: input.archived, revision: current.revision + 1 };
        agentItems = agentItems.map((item) => (item.id === data.id ? data : item));
      } else if (command === "objects.beginUpload")
        data = {
          id: "66666666-6666-4666-a666-666666666666",
          upload: {
            url: "https://pages-test.s3.us-east-1.amazonaws.com/",
            fields: { key: "pending/upload" },
          },
          pending: input,
        };
      else if (command === "objects.completeUpload") {
        const begun = calls.findLast(({ command }) => command === "objects.beginUpload");
        data = { id: input.id, ...begun.input, status: "ACTIVE" };
        objectItems = [...objectItems, data];
      }
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
            { role: "user", text: "Summarise the Q3 numbers", turnId: "1#a" },
            {
              role: "assistant",
              text: "Revenue grew 12% quarter on quarter.\n\n```\nq3 = 1.12 * q2\n```\nSources: https://example.com/q3",
              turnId: "2#b",
              tools: [
                { name: "web_search", isError: false },
                { name: "execute_code", isError: true },
              ],
            },
          ],
          branches: [
            { id: "main", name: "Main", headTurnId: "2#b" },
            { id: other, name: "Edit 1", headTurnId: null },
          ],
          nextCursor: null,
        };
      else if (command === "chat.start") data = { requestId: input.requestId };
      else if (command === "agents.list") data = { items: agentItems };
      else if (command === "models.list")
        data = {
          items: [
            ...catalog.map((model) => ({ ...model, active: true })),
            // A company outside the familiar ones still gets its own group.
            {
              ...catalog[0],
              id: "pages-test-unlisted",
              name: "Unlisted model",
              company: "Example Labs",
              active: false,
            },
          ],
        };
      else if (command === "objects.list")
        data = { items: objectItems, limitBytes: defaults.storageBytes, usedBytes: 0 };
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
    // The module's top-level await holds the load event until validation; wait for commit only.
    await page.goto(base, { waitUntil: "commit" });
    await page.locator(".welcome").waitFor();
    assert.equal(
      await page.locator(".page-layout").getAttribute("data-app-state"),
      "connecting",
      "Page content renders before session.get confirms the session",
    );
    await page.locator('[data-app-state="ready"]').waitFor();
    assert.deepEqual(
      calls.map(({ command }) => command).sort(),
      ["session.get", "workspace.get"],
      "One overlapped read per page; objects.list waits for the picker",
    );
    calls.length = 0;
    starting = true;
    await page.reload();
    await page.locator('[data-app-state="ready"]').waitFor();
    await page.locator(".welcome").waitFor();
    assert.equal(
      calls.filter(({ command }) => command === "workspace.get").length,
      2,
      "A call rejected while the Runtime session starts is retried",
    );
    assert.deepEqual(
      await page.locator('#page-content [role="alert"]').allTextContents(),
      [],
    );
    calls.length = 0;
    cold = true;
    await page.reload();
    await page.locator('[data-boot-phase="warming"]').waitFor();
    assert.equal(
      await page.locator(".welcome").count(),
      0,
      "A cold Runtime unmounts the optimistic page",
    );
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
    assert.equal(
      calls.filter(({ command }) => command === "workspace.get").length,
      2,
      "The page reloads its data once the Runtime is confirmed",
    );
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
    if (name === "desktop") {
      const sent = (command) =>
        calls.filter((call) => call.command === command).map((call) => call.input);
      const alert = page.locator('#page-content [role="alert"]');
      await navigation("agents/");
      const modelPicker = page.locator("#agent-model");
      await modelPicker.locator("option").first().waitFor({ state: "attached" });
      assert.deepEqual(
        await modelPicker.locator("optgroup").evaluateAll((groups) =>
          groups.map((group) => group.label),
        ),
        [...new Set(catalog.map((model) => model.company)), "Example Labs"],
        "Model groups follow the catalog's companies",
      );
      assert.equal(await modelPicker.inputValue(), catalog[0].id);
      await page.locator("#agent-name").fill("Writer");
      await page.getByLabel(/Code repository/).check();
      await page.getByRole("button", { name: "Create agent" }).click();
      await alert.getByText("Enable code workspace").waitFor();
      assert.equal(sent("agents.put").length, 0, "Grant without workspace is refused locally");
      await page.getByLabel("Enable code workspace").check();
      await page.getByRole("button", { name: "Create agent" }).dblclick();
      await page.getByText("Saved.").waitFor();
      const [created, ...duplicates] = sent("agents.put");
      assert.equal(duplicates.length, 0, "A double click creates one agent");
      assert.equal(created.name, "Writer");
      assert.equal(created.modelId, catalog[0].id);
      assert.equal(created.codeInterpreter, true);
      assert.deepEqual(created.connectionIds, [sub]);
      assert.equal(created.id, undefined);
      assert.equal(await page.locator("#agent-name").inputValue(), "", "Create resets the form");
      assert.equal(await page.getByLabel("Enable code workspace").isChecked(), false);
      const row = (text) => page.locator(".agent-list .item").filter({ hasText: text });
      await row("Research").getByRole("button", { name: "Edit" }).click();
      assert.equal(
        await row("Research").getByRole("button", { name: "Archive" }).isDisabled(),
        true,
        "The agent being edited cannot be archived",
      );
      await page.locator("#agent-name").fill("Research v2");
      conflictNext = true;
      await page.getByRole("button", { name: "Save agent" }).click();
      await alert.getByText("changed elsewhere").waitFor();
      assert.equal(
        await page.locator("#agent-name").inputValue(),
        "Research (edited elsewhere)",
        "A conflict reloads the edited agent",
      );
      await page.getByRole("button", { name: "Save agent" }).click();
      await page.getByRole("heading", { name: "New agent" }).waitFor();
      const edit = sent("agents.put").at(-1);
      assert.equal(edit.id, agent.id);
      assert.equal(edit.revision, 1);
      await row("Writer").getByRole("button", { name: "Archive" }).click();
      await row("Writer").getByRole("button", { name: "Restore" }).waitFor();
      assert.equal(sent("agents.setArchived").at(-1).archived, true);

      await page.getByRole("button", { name: "Files & skills" }).click();
      await page.locator("#object-file").setInputFiles({
        name: "notes.md",
        mimeType: "text/markdown",
        buffer: Buffer.from("# Notes\n"),
      });
      await page.locator("#object-kind").selectOption("skill");
      await page.getByRole("button", { name: "Upload" }).click();
      await page.getByText("Upload saved.").waitFor();
      await page.locator(".item").filter({ hasText: "notes.md" }).waitFor();
      assert.deepEqual(sent("objects.beginUpload").at(-1), {
        projectId: "main",
        name: "notes.md",
        sizeBytes: 8,
        contentType: "text/markdown",
        kind: "skill",
      });
      assert.equal(await page.locator("#object-file").inputValue(), "");

      await page.getByRole("button", { name: "Projects" }).click();
      await page.locator("#project-name").fill("Research lab");
      await page.locator("#project-id").fill("research-lab");
      await page.getByRole("button", { name: "Create project" }).click();
      await page.waitForURL(/project=research-lab/);
      assert.deepEqual(sent("projects.create").at(-1), {
        id: "research-lab",
        name: "Research lab",
      });
      await navigation("agents/?project=research-lab&section=projects");
      await page.locator("#project-name-research-lab").fill("Lab");
      await page.getByRole("button", { name: "Rename" }).click();
      await page.locator(".item strong", { hasText: /^Lab$/ }).waitFor();
      await page.getByRole("button", { name: "Hide" }).click();
      await page.getByText("Lab · Hidden").waitFor();
      assert.deepEqual(sent("projects.rename").at(-1), {
        id: "research-lab",
        revision: 0,
        name: "Lab",
      });
      assert.deepEqual(sent("projects.setHidden").at(-1), {
        id: "research-lab",
        revision: 1,
        hidden: true,
      });

      await navigation("profile/?user=" + other);
      await page.locator('input[name="inheritBudget"]').uncheck();
      await page.locator('input[name="budget"]').fill("0.001234");
      const request = (command) =>
        page
          .waitForRequest(
            (sent) =>
              sent.url().includes("/invocations") &&
              sent.postDataJSON()?.command === command,
          )
          .then((sent) => sent.postDataJSON().input);
      const limits = request("users.setLimits");
      await page.getByRole("button", { name: "Save limits" }).click();
      assert.deepEqual(
        await limits,
        { sub: other, budgetMicroUsd: 1234, storageBytes: second.storageBytes, period: null },
        "Sub-cent budgets submit and untouched storage keeps its exact bytes",
      );
      await page.getByText("Saved.").waitFor();
      // Chosen while a notice shows: clearing it must not redraw the form and drop the choice.
      await page.locator('select[name="role"]').selectOption("Auditors");
      const role = request("users.setRole");
      await page.getByRole("button", { name: "Save role" }).click();
      await page.getByRole("button", { name: "Confirm", exact: true }).click();
      assert.deepEqual(await role, { sub: other, role: "Auditors" });
      await page.getByText("Saved.").waitFor();

      await navigation("users/");
      const saveDefaults = request("defaults.set");
      await page.getByRole("button", { name: "Save defaults" }).click();
      assert.deepEqual(
        await saveDefaults,
        { ...defaults },
        "Untouched defaults are sent back exactly",
      );
      await page.getByText("Saved.").waitFor();
      await page.locator('input[name="email"]').fill("new@example.com");
      await page.locator('select[name="role"]').selectOption("Auditors");
      await page.getByRole("button", { name: "Send invitation" }).click();
      await page.getByText("Invitation sent.").waitFor();
      assert.deepEqual(sent("users.invite").at(-1), {
        email: "new@example.com",
        role: "Auditors",
      });
      assert.equal(await page.locator('input[name="email"]').inputValue(), "");
      assert.deepEqual(invalid, [], "Mutation payloads match the Runtime's shapes");
      console.log("PASS: desktop page mutations send well-formed input and recover from conflicts");
    }
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
    peer.on("pageerror", (error) => errors.push("peer: " + error.message));
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
    assert.deepEqual(errors, [], "Sign-out tears pages down without errors");
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
