import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "../../node_modules/playwright/index.mjs";
import { mkdir } from "node:fs/promises";

export async function runLiveStory(
  page,
  fixture,
  { story = "pages", screenshot = false } = {},
) {
  const peers = [],
    contexts = [];
  let replacementBrowser;
  page.on("request", (request) => {
    if (request.url() === fixture.controllerUrl) {
      const id =
        request.headers()["x-amzn-bedrock-agentcore-runtime-session-id"];
      if (id) fixture.trackRuntimeSession(id);
    }
  });
  const base = new URL(fixture.entryUrl);
  base.search = "";
  const login = async (target, identity, destination = "") => {
    const url = new URL(destination, base);
    const descriptor = new URL(identity.entryUrl).searchParams;
    for (const [name, value] of descriptor) url.searchParams.set(name, value);
    await target.goto(url.href);
    await target.getByRole("button", { name: "Sign in", exact: true }).click();
    await target
      .locator('input[type="password"]')
      .first()
      .waitFor({ timeout: 30000 });
    await target
      .locator('input[type="email"], input[name="username"]')
      .first()
      .fill(identity.email);
    await target
      .locator('input[type="password"]')
      .first()
      .fill(identity.password);
    await target
      .locator('button[type="submit"], input[type="submit"]')
      .first()
      .click();
    try {
      await target
        .locator('[data-app-state="ready"]')
        .waitFor({ timeout: 60000 });
    } catch (error) {
      // Say where sign-in stopped, not just that it timed out.
      const seen = await target
        .evaluate(() => ({
          url: location.href,
          state: document.querySelector(".page-layout")?.dataset,
          alerts: [...document.querySelectorAll('[role="alert"]')].map(
            (alert) => alert.textContent,
          ),
          text: document.body.innerText.slice(0, 400),
        }))
        .catch((reason) => reason.message);
      throw new Error(`Sign-in did not finish: ${JSON.stringify(seen)}`, {
        cause: error,
      });
    }
    const auth = await target.evaluate(() => {
      const config = JSON.parse(sessionStorage.getItem("agentcore:deployment"));
      const state = JSON.parse(
        sessionStorage.getItem(
          `agentcore:session:${config.runtime}:${config.client}`,
        ),
      );
      return { config, ...state };
    });
    identity.trackRuntimeSession(auth.runtimeSessionId);
    identity.setRuntimeStopToken(auth.tokens.access_token);
    return auth;
  };
  const transport =
    (identity, auth) =>
    async (command, input = {}) => {
      const response = await fetch(identity.controllerUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + auth.tokens.access_token,
          "x-amzn-bedrock-agentcore-runtime-session-id": auth.runtimeSessionId,
        },
        body: JSON.stringify({ v: 1, command, requestId: randomUUID(), input }),
        signal: AbortSignal.timeout(120000),
      });
      if (!response.ok) throw Error("Runtime HTTP " + response.status);
      const result = await response.json();
      return result;
    };
  const good = async (rpc, command, input) => {
    const result = await rpc(command, input);
    assert.equal(
      result.ok,
      true,
      `${command}: ${JSON.stringify(result.error)}`,
    );
    return result.data;
  };
  const denied = async (rpc, command, input, code) => {
    const result = await rpc(command, input);
    assert.equal(result.ok, false, command);
    if (code) assert.equal(result.error.code, code);
  };
  const waitRun = async (rpc, requestId, timeout = 120000) => {
    const end = Date.now() + timeout;
    for (;;) {
      const run = await good(rpc, "chat.status", { requestId });
      if (run.status !== "running") return run;
      if (Date.now() >= end) throw Error("Run did not finish");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };
  const capture = async (target, name) => {
    if (!screenshot) return;
    const dir = new URL(
      "../.artifacts/screenshots/live-pages/",
      import.meta.url,
    );
    await mkdir(dir, { recursive: true });
    await target.screenshot({
      path: new URL(name + ".png", dir).pathname.replace(/^\/([A-Z]:)/, "$1"),
      fullPage: true,
    });
  };
  try {
    const auth = await login(page, fixture, "users/");
    const rpc = transport(fixture, auth);
    assert.match(page.url(), /\/users\/$/);
    await page
      .getByRole("link", {
        name: new RegExp(fixture.email.replaceAll(".", "\\.")),
      })
      .click();
    await page.getByRole("heading", { name: fixture.email }).waitFor();
    await page.reload();
    await page.getByRole("link", { name: "View usage" }).click();
    await page.locator("#usage-range").waitFor();
    await page.locator("#usage-range").selectOption("90d");
    await page.reload();
    assert.equal(await page.locator("#usage-range").inputValue(), "90d");
    await capture(
      page,
      "usage-" + (page.viewportSize().width < 620 ? "mobile" : "desktop"),
    );
    const own = await good(rpc, "users.get", {});
    assert.equal(own.user.sub, fixture.sub);
    assert.equal(own.user.protected, true);
    await denied(
      rpc,
      "users.setRole",
      { sub: fixture.sub, role: "Members" },
      "PROTECTED_ADMIN",
    );
    await denied(
      rpc,
      "users.setEnabled",
      { sub: fixture.sub, enabled: false },
      "PROTECTED_ADMIN",
    );
    if (story === "login") return;
    if (
      ["runtime-foundation", "runtime-roadmap", "runtime-benchmark"].includes(
        story,
      )
    ) {
      await (
        await import("./regressions.js")
      ).runRegression(page, fixture, {
        story,
        accessToken: auth.tokens.access_token,
        runtimeSessionId: auth.runtimeSessionId,
      });
      console.log(
        "PASS: preserved " + story + " protocol/accounting regression",
      );
      return;
    }
    if (["runtime-model", "runtime-web"].includes(story)) {
      const models = (await good(rpc, "models.list", {})).items;
      const selected = process.env.AGENTCORE_TEST_MODEL;
      const candidates =
        story === "runtime-web"
          ? models.filter((model) => model.id === "test.echo")
          : models.filter((model) =>
              selected
                ? model.id === selected
                : [
                    "Claude Haiku 5.5",
                    "Claude Sonnet 5.5",
                    "Claude Opus 5.5",
                    "Claude Fable 5.1",
                    "GPT-6.1 Sol",
                    "GPT-6 Luna",
                    "Gemini 3.8 Flash",
                  ].includes(model.name),
            );
      assert.equal(
        candidates.length,
        story === "runtime-web" || selected ? 1 : 7,
      );
      for (const model of candidates) {
        const agent = await good(rpc, "agents.put", {
          projectId: "main",
          name: "Provider smoke " + model.name,
          modelId: model.id,
          ...(story === "runtime-model" && { thinkingLevel: "low" }),
          codeInterpreter: story === "runtime-model",
          webSearch: story === "runtime-web",
          browser: story === "runtime-web",
        });
        for (const scenario of story === "runtime-web"
          ? [
              {
                message:
                  "run-search:official Amazon Bedrock AgentCore documentation",
                tool: "web_search",
                pattern: /Search results reviewed/,
              },
              {
                message: "run-browser:https://example.com/",
                tool: "browser",
                pattern: /Browser screenshot reviewed/,
              },
            ]
          : [
              {
                message:
                  "Use execute_code with Python to print 41 + 1, then state its output in one short sentence.",
                tool: "execute_code",
                pattern: /42/,
              },
            ]) {
          const input = {
            projectId: "main",
            agentId: agent.id,
            conversationId: randomUUID(),
            requestId: randomUUID(),
            expectedHeadTurnId: null,
            message: scenario.message,
          };
          await good(rpc, "chat.start", input);
          const result = await waitRun(rpc, input.requestId, 180000);
          assert.equal(
            result.status,
            "completed",
            model.name + ": " + result.status,
          );
          const chat = await good(rpc, "conversations.get", {
            projectId: "main",
            agentId: agent.id,
            conversationId: input.conversationId,
          });
          assert.match(chat.messages.at(-1).text, scenario.pattern);
          const usage = (await fixture.readUsage()).Items.filter(
            (row) => row.requestId?.S === input.requestId,
          );
          assert.ok(
            usage.some(
              (row) => row.kind?.S === "tool" && row.name?.S === scenario.tool,
            ),
          );
          assert.ok(usage.some((row) => row.kind?.S === "model"));
          console.log(
            "PASS: real " +
              model.name +
              " inference, " +
              scenario.tool +
              ", durable result and observed accounting",
          );
        }
      }
      return;
    }

    const member = await fixture.createPeer("Members"),
      auditor = await fixture.createPeer("Auditors");
    peers.push(member, auditor);
    for (const peer of peers) {
      const context = await page
        .context()
        .browser()
        .newContext({ viewport: page.viewportSize() });
      contexts.push(context);
      const target = await context.newPage(),
        peerAuth = await login(target, peer, "profile/");
      peer.auth = peerAuth;
      peer.rpc = transport(peer, peerAuth);
      assert.equal((await good(peer.rpc, "users.get", {})).user.sub, peer.sub);
      await denied(
        peer.rpc,
        "users.get",
        { userSub: fixture.sub },
        "FORBIDDEN",
      );
      await denied(peer.rpc, "users.list", {}, "FORBIDDEN");
      await denied(
        peer.rpc,
        "users.setLimits",
        { sub: peer.sub, budgetMicroUsd: 1, storageBytes: 1 },
        "FORBIDDEN",
      );
      assert.equal(
        (await good(rpc, "users.get", { userSub: peer.sub })).user.sub,
        peer.sub,
      );
    }
    await denied(
      auditor.rpc,
      "credentials.put",
      { name: "Denied", kind: "github", secret: "audit-secret" },
      "FORBIDDEN",
    );
    // A change made directly in Cognito is honoured once the Runtime's
    // 15-second authorization cache for that person expires.
    await member.setEnabled(false);
    const revokedBy = Date.now() + 20000;
    for (;;) {
      const result = await member.rpc("session.get", {});
      if (result.error?.code === "SESSION_CHANGED") break;
      assert.ok(Date.now() < revokedBy, "Disabled user kept access past 15s");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    await member.setEnabled(true);
    await good(rpc, "users.setLimits", {
      sub: member.sub,
      budgetMicroUsd: 0,
      storageBytes: null,
      period: null,
    });
    const limited = await good(rpc, "users.get", { userSub: member.sub });
    assert.equal(limited.user.budgetMicroUsd, 0);
    assert.equal(limited.user.budgetInherited, false);
    assert.equal(limited.user.storageInherited, true);
    assert.deepEqual(
      (await good(rpc, "users.list", {})).items.find(
        (user) => user.sub === member.sub,
      ),
      limited.user,
    );

    let credential = await good(rpc, "credentials.put", {
      name: "Reusable GitHub",
      kind: "github",
      secret: "pages-fixture-secret-v1",
    });
    const first = await good(rpc, "connections.put", {
      projectId: "main",
      name: "Repository one",
      kind: "github",
      credentialId: credential.id,
    });
    const second = await good(rpc, "connections.put", {
      projectId: "main",
      name: "Repository two",
      kind: "github",
      credentialId: credential.id,
    });
    credential = (await good(rpc, "credentials.list", {})).items.find(
      (item) => item.id === credential.id,
    );
    assert.equal(credential.usedBy.length, 2);
    assert.equal(
      JSON.stringify(credential).includes("pages-fixture-secret"),
      false,
    );
    await denied(
      rpc,
      "credentials.delete",
      { id: credential.id, revision: credential.revision },
      "CREDENTIAL_IN_USE",
    );
    await denied(rpc, "credentials.list", { userSub: member.sub }, "FORBIDDEN");
    await denied(
      member.rpc,
      "connections.test",
      { projectId: "main", id: first.id },
      "NOT_FOUND",
    );
    assert.equal(
      (await good(member.rpc, "credentials.list", {})).items.length,
      0,
    );
    const rotations = await Promise.all([
      rpc("credentials.rotate", {
        id: credential.id,
        revision: credential.revision,
        secret: "pages-fixture-secret-v2",
      }),
      rpc("credentials.rotate", {
        id: credential.id,
        revision: credential.revision,
        secret: "pages-fixture-secret-v3",
      }),
    ]);
    assert.equal(rotations.filter((result) => result.ok).length, 1);
    assert.equal(
      rotations.find((result) => !result.ok).error.code,
      "REVISION_CONFLICT",
    );
    const grantCredential = await good(rpc, "credentials.put", {
      name: "Granted GitHub",
      kind: "github",
      secret: "pages-grant-secret",
    });
    const grant = await good(rpc, "connections.put", {
      projectId: "main",
      name: "Granted repository",
      kind: "github",
      credentialId: grantCredential.id,
    });
    await good(rpc, "connections.delete", {
      projectId: "main",
      id: first.id,
      revision: first.revision,
    });
    await good(rpc, "connections.delete", {
      projectId: "main",
      id: second.id,
      revision: second.revision,
    });
    credential = (await good(rpc, "credentials.list", {})).items.find(
      (item) => item.id === credential.id,
    );
    await good(rpc, "credentials.delete", {
      id: credential.id,
      revision: credential.revision,
    });
    console.log(
      "PASS: live roles, protected administrator, foreign denial, revocation, credential reuse/rotation/deletion",
    );

    const agent = await good(rpc, "agents.put", {
      projectId: "main",
      name: "Background validation",
      modelId: "test.echo",
      systemPrompt: "",
      codeInterpreter: true,
      connectionIds: [grant.id],
    });
    assert.deepEqual(
      (await fixture.readAgent(agent.id)).connectionIds.L.map((item) => item.S),
      [grant.id],
    );
    await page.goto(new URL(`?agent=${agent.id}`, base).href);
    await page.getByRole("textbox", { name: "Message" }).waitFor();
    await page
      .getByRole("textbox", { name: "Message" })
      .fill("wait:15000:browser closed");
    const startedResponse = page.waitForResponse((reply) => {
      try {
        return reply.request().postDataJSON()?.command === "chat.start";
      } catch {
        return false;
      }
    });
    const before = Date.now();
    await page.getByRole("button", { name: "Send ↑" }).click();
    const started = await startedResponse,
      input = started.request().postDataJSON().input;
    assert.equal((await started.json()).ok, true);
    assert.ok(Date.now() - before < 8000, "Acceptance waited for inference");
    await good(rpc, "chat.start", input);
    await denied(
      rpc,
      "chat.start",
      { ...input, requestId: randomUUID(), message: "Competing turn" },
      "BRANCH_BUSY",
    );
    await denied(
      rpc,
      "chat.start",
      { ...input, message: "Changed duplicate" },
      "REQUEST_ID_CONFLICT",
    );
    await page.getByRole("link", { name: "Usage", exact: true }).click();
    await page.locator("#usage-range").waitFor();
    const watcher = new AbortController();
    const watched = await fetch(fixture.controllerUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + auth.tokens.access_token,
        "x-amzn-bedrock-agentcore-runtime-session-id": auth.runtimeSessionId,
      },
      body: JSON.stringify({
        v: 1,
        command: "chat.watch",
        input: { requestId: input.requestId },
      }),
      signal: watcher.signal,
    });
    const initial = await watched.body.getReader().read();
    assert.ok(initial.value?.length);
    watcher.abort();
    assert.equal(
      (await good(rpc, "chat.status", { requestId: input.requestId })).status,
      "running",
    );
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page
      .locator('[data-app-state="disconnected"]')
      .waitFor({ timeout: 30000 });
    for (const context of contexts.splice(0)) await context.close();
    await page.context().browser().close();
    const completed = await waitRun(rpc, input.requestId);
    assert.equal(completed.status, "completed");
    await good(rpc, "chat.start", input);
    const usage = await fixture.readUsage();
    assert.equal(
      usage.Items.filter(
        (row) =>
          row.requestId?.S === input.requestId && row.kind?.S === "model",
      ).length,
      1,
    );
    assert.equal(
      (await fixture.readTurns(input.conversationId)).length,
      1,
    );
    replacementBrowser = await chromium.launch();
    const context = await replacementBrowser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    contexts.push(context);
    const returning = await context.newPage();
    await login(returning, fixture, `?conversation=${input.conversationId}`);
    await returning
      .locator(".message.assistant")
      .getByText("Echo: wait:15000:browser closed", { exact: true })
      .waitFor();
    await capture(returning, "returned-completed-chat");
    const fork = {
      ...input,
      requestId: randomUUID(),
      branchId: randomUUID(),
      message: "wait:6000:fork refresh",
      forkTurnId: completed.turnId,
    };
    delete fork.expectedHeadTurnId;
    await good(rpc, "chat.start", fork);
    await denied(
      rpc,
      "conversations.delete",
      { projectId: "main", conversationId: input.conversationId, agentId: agent.id },
      "RUN_ACTIVE",
    );
    await returning.goto(
      new URL(`?conversation=${input.conversationId}&branch=${fork.branchId}`, base)
        .href,
    );
    await returning
      .locator(".message-state")
      .getByText("Working…", { exact: true })
      .waitFor();
    await returning.reload();
    await returning
      .locator(".message.assistant")
      .getByText("Echo: wait:6000:fork refresh", { exact: true })
      .waitFor({ timeout: 30000 });
    assert.equal((await waitRun(rpc, fork.requestId)).status, "completed");
    const deleted = await good(rpc, "conversations.delete", {
      projectId: "main",
      conversationId: input.conversationId,
      agentId: agent.id,
    });
    assert.equal(deleted.deleted, true);
    assert.equal(
      Number((await fixture.readProfile()).storageUsedBytes?.N || 0),
      0,
    );
    assert.equal(
      (await fixture.readUsage()).Items.filter((row) => row.kind?.S === "model")
        .length,
      2,
    );
    console.log(
      "PASS: active fork refresh/reconnect, deletion protection, branch completion and exact archive-byte cleanup",
    );
    const toolInput = {
      ...input,
      conversationId: randomUUID(),
      requestId: randomUUID(),
      message:
        "run-code:import os, base64; print(os.getenv('GITHUB_TOKEN')); print(base64.b64encode(os.getenv('GITHUB_TOKEN').encode()).decode())",
      expectedHeadTurnId: null,
    };
    await good(rpc, "chat.start", toolInput);
    assert.equal((await waitRun(rpc, toolInput.requestId)).status, "completed");
    const toolChat = await good(rpc, "conversations.get", {
      projectId: "main",
      agentId: agent.id,
      conversationId: toolInput.conversationId,
    });
    assert.ok(toolChat.messages.at(-1).text.includes("[redacted]"));
    assert.equal(
      JSON.stringify(toolChat).includes("pages-grant-secret"),
      false,
    );
    assert.equal(
      JSON.stringify(toolChat).includes(
        Buffer.from("pages-grant-secret").toString("base64"),
      ),
      false,
    );
    console.log(
      "PASS: granted credential reaches real Code Interpreter; raw and encoded outputs are redacted before model/history/progress",
    );
    const cancelInput = {
      ...input,
      conversationId: randomUUID(),
      requestId: randomUUID(),
      message: "wait:6000:cancel me",
      expectedHeadTurnId: null,
    };
    await good(rpc, "chat.start", cancelInput);
    await good(rpc, "chat.cancel", { requestId: cancelInput.requestId });
    assert.equal(
      (await waitRun(rpc, cancelInput.requestId)).status,
      "cancelled",
    );
    assert.equal(
      (
        await good(rpc, "usage.list", {
          status: "cancelled",
          requestId: cancelInput.requestId,
        })
      ).items.length,
      1,
    );
    const lost = {
      ...cancelInput,
      conversationId: randomUUID(),
      requestId: randomUUID(),
      message: "wait:15000:runtime lost",
    };
    await good(rpc, "chat.start", lost);
    await fixture.stopRuntimeSession(auth.runtimeSessionId);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const lostAuth = await returning.evaluate(() => {
      const config = JSON.parse(sessionStorage.getItem("agentcore:deployment"));
      return JSON.parse(
        sessionStorage.getItem(
          `agentcore:session:${config.runtime}:${config.client}`,
        ),
      );
    });
    const later = transport(fixture, lostAuth);
    assert.equal(
      (await waitRun(later, lost.requestId, 150000)).status,
      "outcome_unknown",
    );
    assert.equal(
      (await fixture.readUsage()).Items.filter(
        (row) => row.requestId?.S === lost.requestId,
      ).length,
      0,
    );
    console.log(
      "PASS: live acceptance, duplicate/branch protection, navigation, closed browser, watcher detach/reconnect, exactly-once result/charges, cancellation, forced Runtime loss",
    );
  } finally {
    for (const context of contexts) await context.close();
    await replacementBrowser?.close();
    for (const peer of peers.reverse()) await peer.cleanup();
  }
}
