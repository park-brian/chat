import assert from "node:assert/strict";
import { chromium } from "../../node_modules/playwright/index.mjs";
import { startServer } from "../../server.js";
import { fileURLToPath } from "node:url";

const server = await startServer(
  0,
  fileURLToPath(new URL("../../", import.meta.url)),
);
const base = `http://localhost:${server.address().port}/agentcore/`,
  browser = await chromium.launch();
const config = {
  region: "us-east-1",
  stack: "session-test",
  pool: "us-east-1_test",
  client: "client",
  scope: "chat-api/access",
  domain: "https://session-test.auth.us-east-1.amazoncognito.com",
  runtime: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test",
};
const claims = {
  iss: `https://cognito-idp.${config.region}.amazonaws.com/${config.pool}`,
  client_id: config.client,
  token_use: "access",
  scope: config.scope,
  sub: "11111111-1111-4111-a111-111111111111",
  exp: Math.floor(Date.now() / 1000) + 3600,
};
const jwt = (value) =>
  "test." + Buffer.from(JSON.stringify(value)).toString("base64url") + ".test";
const key = `agentcore:session:${config.runtime}:${config.client}`;
try {
  const context = await browser.newContext(),
    page = await context.newPage();
  await page.goto(base + "profile/");
  await page.evaluate(
    (config) =>
      sessionStorage.setItem("agentcore:deployment", JSON.stringify(config)),
    config,
  );
  await page.reload();
  let authorizationUrl;
  await context.route("**/oauth2/authorize?**", (route) => {
    authorizationUrl = new URL(route.request().url());
    return route.fulfill({
      contentType: "text/html",
      body: "Hosted sign-in fixture",
    });
  });
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/oauth2/authorize?**");
  await page.goto(base + "profile/");
  const pending = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("agentcore:callback")),
  );
  assert.equal(authorizationUrl.searchParams.get("redirect_uri"), base);
  assert.equal(pending.destination, base + "profile/");
  let refreshes = 0,
    validated = 0;
  await context.route("**/oauth2/token", async (route) => {
    const input = new URLSearchParams(route.request().postData());
    if (input.get("grant_type") === "refresh_token") refreshes++;
    else assert.equal(input.get("code_verifier"), pending.verifier);
    await route.fulfill({
      json: {
        access_token: jwt(claims),
        refresh_token: "fixture-refresh-token",
        id_token: jwt({
          ...claims,
          aud: config.client,
          token_use: "id",
          nonce: pending.nonce,
        }),
      },
    });
  });
  let changed = false, oldWorker = true;
  await context.route("**/invocations?qualifier=DEFAULT", (route) => {
    const { command } = route.request().postDataJSON();
    if (command === "session.get") {
      validated++;
      const apiVersion = oldWorker ? 1 : 3; oldWorker = false;
      return route.fulfill({
        json: changed
          ? { ok: false, error: { code: "SESSION_CHANGED" } }
          : {
              ok: true,
              data: {
                apiVersion,
                user: {
                  sub: claims.sub,
                  email: "member@example.com",
                  role: "Members",
                },
              },
            },
      });
    }
    if (command === "users.get")
      return route.fulfill({
        json: {
          ok: true,
          data: {
            user: {
              sub: claims.sub,
              email: "member@example.com",
              role: "Members",
              enabled: true,
            },
          },
        },
      });
    return route.fulfill({ json: { ok: false, error: { code: "FORBIDDEN" } } });
  });
  await page.goto(
    base + "?code=fixture&state=" + encodeURIComponent(pending.state),
  );
  await page.getByRole("heading", { name: "member@example.com" }).waitFor();
  assert.equal(page.url(), base + "profile/");
  assert.equal(validated, 2);
  const session = await page.evaluate(
      (key) => JSON.parse(sessionStorage.getItem(key)),
      key,
    ),
    sticky = session.runtimeSessionId;
  await page.evaluate(
    ({ key, expired }) => {
      const session = JSON.parse(sessionStorage.getItem(key));
      session.tokens.access_token = expired;
      sessionStorage.setItem(key, JSON.stringify(session));
    },
    {
      key,
      expired: jwt({ ...claims, exp: Math.floor(Date.now() / 1000) - 1 }),
    },
  );
  await page.reload();
  await page.getByRole("heading", { name: "member@example.com" }).waitFor();
  assert.equal(refreshes, 1);
  assert.equal(validated, 3);
  assert.equal(
    await page.evaluate(
      (key) => JSON.parse(sessionStorage.getItem(key)).runtimeSessionId,
      key,
    ),
    sticky,
  );
  changed = true;
  await page.reload();
  await page.locator('[data-app-state="disconnected"]').waitFor();
  assert.equal(
    await page.evaluate((key) => sessionStorage.getItem(key), key),
    null,
  );
  await page.evaluate(
    ({ config, key, tokens }) => {
      sessionStorage.setItem("agentcore:deployment", JSON.stringify(config));
      sessionStorage.setItem(key, JSON.stringify(tokens));
    },
    { config, key, tokens: session },
  );
  const alternate = {
    ...config,
    runtime: config.runtime.replace(/test$/, "different"),
  };
  await page.goto(base + "profile/?" + new URLSearchParams(alternate));
  await page.locator('[data-app-state="disconnected"]').waitFor();
  assert.equal(validated, 4);
  assert.ok(
    await page.evaluate((key) => Boolean(sessionStorage.getItem(key)), key),
  );
  console.log(
    "PASS: root PKCE callback restores destination, expired token refresh retains Runtime session, Runtime revocation clears auth, deployment sessions stay isolated",
  );
  await context.close();
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
