# AgentCore Chat: implementation and test runbook

**Backend amendment (2026-09-22):** Follow [RUNTIME-DECISION.md](./RUNTIME-DECISION.md) for the CodeZip Runtime migration. Lambda/API Gateway steps below document the currently deployed slice and prior live evidence, not the final backend topology.

Status: roadmap/runbook; [STATUS.md](./STATUS.md) has current commands and live results
Account probe date: 2026-09-22
Architecture sources: [PLAN.md](./PLAN.md), the exact [API-CONTRACT.md](./API-CONTRACT.md), and the normative [USAGE-RESOURCES.md](./USAGE-RESOURCES.md)

## 1. Verified `eaap` baseline

The read-only probe used local AWS profile `eaap` in `us-east-1`. It made no AWS changes.

- Credentials resolve to IAM user `admin` in account ending `6138`.
- The profile has no default Region. Region is therefore a required UI field; never silently use an SDK default.
- The credentials come from the local shared-credentials file and the user currently has `AdministratorAccess`.
- IAM simulation returned `allowed` for all 23 operations needed by the planned browser: CloudFormation lifecycle, Harness CRUD/invoke, Memory events, credential providers, Gateway targets, Policy, Code Interpreter, IAM role/pass-role, Secrets Manager, and S3 writes.
- A second read-only IAM simulation returned `allowed` for a superset of Cognito/bootstrap operations, including the User Pool/client/domain/branding, user lifecycle, CloudFormation, and IAM role/pass-role operations still required. Identity Pool operations were also probed during exploration but are no longer part of the chosen architecture.
- A third read-only IAM simulation returned `allowed` for all 18 newly planned authorization/metering operations: DynamoDB table/write/transactions, Lambda create/update/invoke, API Gateway read/write, EventBridge rule/targets, AWS Budgets create/view, CloudWatch/Logs reads, Cost Explorer, Pricing, and `iam:PassRole`.
- `us-east-1` currently contains four READY Harnesses, four ACTIVE Memories, two READY IAM-authenticated Gateways, one READY custom Code Interpreter, zero Policy Engines, and zero API-key/OAuth credential providers.
- The existing development Harness is READY at version 2, uses the active streaming model `us.openai.gpt-5.6-luna`, a BYO Memory, summarization, a public Runtime, and a CloudFormation-created execution role.
- The existing custom Code Interpreter is READY, VPC-backed, and has its own execution role. This validates role-based AWS access as the account's established pattern.
- Relevant current quotas include 1,000 total agents, 5,000 active session workloads, 1,000 policies per Policy Engine, and 50 each of API-key and OAuth2 credential providers.
- AWS CLI `2.28.14` predates Harness and Policy Engine commands. Use the installed JavaScript SDK for those resources; do not treat CLI command absence as service absence.

The temporary read-only probe script was removed after the baseline and disposable live stack were verified. Recheck exact operations for later slices with the AWS CLI/SDK rather than treating the historic probe as a permanent health command.

Never adopt or modify the existing `eaap-ac-*` resources during development. Disposable infrastructure uses `chat-dev-<UTC timestamp>-<random>` names and `ac-chat:*` tags; each test invocation has a separate `chat-test-*` run ID (see §4.5).

## 2. Cognito authentication and browser session

### 2.1 Normal login path

The browser cannot use the local `eaap` profile. A profile is only a Node/CLI bootstrap and test convenience. Normal users open the foundation stack's `ApplicationEntryUrl` (default `https://park-brian.github.io/chat/agentcore/`, configurable at deployment), which contains only the non-secret Region, stack name, User Pool ID, app-client ID, Cognito domain, and product API URL. The production CORS origin is `https://park-brian.github.io`.

The application performs OAuth 2.0 authorization code with PKCE:

```text
beginLogin(deployment)
  -> random verifier/state/nonce
  -> SHA-256/base64url challenge
  -> one-use sessionStorage callback record
  -> /oauth2/authorize redirect

finishLogin(code, state)
  -> load-and-delete callback record
  -> constant-time state comparison
  -> POST /oauth2/token with verifier and exact redirect_uri
  -> check nonce, iss, aud, token_use, exp
  -> session.get with the access token
  -> REST API Cognito authorizer validates the scoped access token
  -> create the product API client
```

Keep access, ID, and refresh tokens in one module-level token manager. Refresh at a bounded margin before expiry or lazily on demand; on `invalid_grant`, clear state and start login again.

Only the PKCE verifier/state/nonce, clean return route, and non-secret deployment descriptor may temporarily enter `sessionStorage`; consume and remove them for success, denial, malformed callbacks, and expiry. Tokens never enter a DOM attribute, URL, log, exception detail, `localStorage`, `sessionStorage`, IndexedDB, Cache Storage, Memory, a service worker, or telemetry. Deployment-mode AWS credentials follow the same rule while that separate mode is connected.

The first authenticated product request is `session.get`. Until it succeeds, enable no mutation control. On success show the email, immutable Cognito `sub`, effective admin/member/auditor role, Region, and budget state returned by the broker. The broker accepts exactly one known global group and fails closed on missing or conflicting groups. Sign out first aborts work and clears token/client state, then redirects through Cognito `/logout` to the registered application URL.

The normal application is supported from registered GitHub Pages HTTPS and localhost HTTP URLs, not `file://`. Reload intentionally starts a fresh authorization flow; Cognito's own login cookie can satisfy it without another password prompt.

### 2.2 First deployment and recovery bootstrap

Cognito cannot authenticate a browser before its stack exists. With no valid deployment descriptor, show only **Open deployment URL** and **Bootstrap deployment**. Bootstrap accepts Region, stack name, application callback/logout URL, allowed origins, domain prefix, first-user email, and short-lived AWS credentials. The inputs are write-only, memory-only, and cleared as soon as the bootstrap client bag exists.

The bootstrap sequence is:

```text
GetCallerIdentity -> ValidateTemplate -> CreateStack(CAPABILITY_NAMED_IAM)
-> poll events/status -> read outputs -> AdminCreateUser(first email)
-> destroy bootstrap clients/credentials -> open ApplicationEntryUrl
```

The first user receives Cognito's temporary-password invitation, is added to `Administrators`, and completes the password change in managed login. Public self-sign-up is disabled. After login, Account / Users invites later users into `Members` by default and can assign only the fixed administrator/member/auditor groups. If stack creation succeeds but invitation/group assignment fails, show the application entry URL and a retry action; never roll back a valid foundation merely because user creation failed.

The `eaap` profile is suitable for development bootstrap only. Never copy it automatically from the local credentials file into the browser. Production bootstrap should use a temporary administrator session. Stack deletion warns that Cognito login will disappear and recovery will again require external bootstrap credentials.

### 2.3 Remote dependency integrity

Temporary credentials remaining on the user's machine does not protect them from JavaScript loaded by the page. The current broad CDN mappings (`@3`, `@1`, Bootstrap `@5`) are unacceptable once the page receives Cognito tokens and AWS credentials.

Keep the app buildless and single-file, but make release dependencies fail closed:

1. Pin every runtime module and stylesheet to an exact version and immutable URL.
2. Use bundled ESM CDN endpoints so the executable dependency graph is small and enumerable.
3. Add SHA-384 entries in the import map's `integrity` object for every fetched module URL.
4. Add `integrity` and `crossorigin="anonymous"` to external stylesheets.
5. Add a meta CSP restricting scripts/styles/connect targets to the page, the exact CDN, Cognito domain/issuer, and required AWS HTTPS endpoints. Hash the inline import map and application module; do not use a static nonce or `unsafe-inline` in the published page.
6. In the browser test, record every script/module/style request and fail if its exact URL is not pinned and integrity-covered.
7. Require browser versions supporting import-map integrity. If compatibility becomes broader than modern browsers, switch to a checked-in same-origin vendor snapshot; do not silently drop integrity.

No service worker is needed. GitHub Pages deployment is static and receives only `index.html` plus any icons/assets that cannot be inlined.

## 3. Implementation slices and gates

Each slice must pass the fast local tests and the smallest relevant live AWS/browser journey before starting the next slice. Run the complete disposable suite before release.

### Slice 0 — destructive replacement of the copied app

- Preserve the essential SolidJS header guidance verbatim.
- Preserve `?test=1` as the test entry point.
- Replace the existing application body/module rather than adapting its IndexedDB/provider/tool-loop architecture.
- First render only the disconnected shell with Open deployment, Sign in, and Bootstrap routes.

Gate: no IndexedDB, Gemini client, local tool loop, MCP client, virtual filesystem, branching, or subagent code remains.

### Slice 1 — Cognito session, clients, and read-only discovery

Implement these plain functions, not classes:

```text
parseDeployment(url)         -> validated non-secret Cognito/stack descriptor
beginLogin(deployment)       -> PKCE callback record + authorize redirect
finishLogin(callback)        -> tokens + sub/groups + validated session.get result
refreshTokens()              -> new in-memory tokens or forced reauthentication
disconnect()                 -> abort requests, clear all state, Cognito logout
discoverStack(stackName)     -> status + typed outputs
rpc(operation, payload)      -> Cognito-authorized product command returning a complete view model
listManaged(resourceType, scopeId) -> product API exact-scope result for every Cognito role
```

The normal client bag contains only the product API transport. CloudFormation and STS clients exist only while deployment-administrator credentials are explicitly connected. Bare deployment commands are imported individually. Backend native-list hydration uses bounded concurrency and backs off on throttling.

Gate: from GitHub Pages, administrator/member/auditor users complete PKCE and receive their expected command capabilities from `session.get`. All can call only their permitted `/rpc` operations; normal mode has no AWS credentials or direct service clients. Storage inspection shows no tokens or AWS credentials; callback state has been consumed.

### Slice 2 — foundation CloudFormation

Author `agentcore/template.yaml` and embed the identical text in `index.html`. The single foundation stack contains:

- Cognito User Pool, public app client, managed-login domain/default branding;
- fixed Cognito groups, one application API access scope, and a REST API Cognito User Pool authorizer requiring that scope on authenticated methods;
- shared Memory;
- Policy Engine;
- Gateway role with Policy evaluation permissions;
- IAM-authenticated Gateway attached to the Policy Engine in `ENFORCE` mode;
- encrypted, private, versioned skill/schema S3 bucket with exact configured production/localhost CORS origins;
- shared default Harness execution role;
- one on-demand DynamoDB policy/authorization/usage table with account/user controls, projects/memberships, model catalog/prices, Agent bindings, request/component events, storage manifests/projections, PITR, TTL, and one overloaded GSI;
- one broker Lambda, one Cognito-authorized Regional API Gateway REST API with `/rpc`, `/credential-secrets`, and streamed `/chat` (`ResponseTransferMode: STREAM`); the same Lambda receives managed-prefix S3 object notifications;
- optional SNS/account AWS Budget backstop;
- outputs documented in `PLAN.md`.

The browser has no DynamoDB credentials. The broker Lambda is the sole reader/writer for user control, project, membership, model, price, Agent binding, invocation, and usage items. If persistent personal preferences are added later, expose narrow broker commands over `USER#<sub>/PREF#*` with an attribute allowlist. This optional namespace must never contain authorization or accounting data.

It deliberately contains no Harness, credential provider, Gateway target, policy, or user Code Interpreter profile.

The UI state machine is:

```text
absent -> validating -> creating -> ready
ready  -> validating -> updating -> ready
any    -> failed (show newest relevant stack event and request ID)
ready  -> checking dependents -> deleting -> absent
```

Use `CAPABILITY_NAMED_IAM`. Treat “No updates are to be performed” as success. Never delete the retained skill bucket or direct-created resources implicitly.

Gate: bootstrap a disposable foundation, invite and sign in the first user through the output `ApplicationEntryUrl`, rediscover all outputs with Cognito credentials after reload, then delete it after the dependency check.

### Slice 3 — users, models, projects, and native agent discovery

Implement and unit-test:

```text
actorId(cognitoSub, projectId)
agentSessionKey(harnessId)
chatSessionId(agentId)
matchesManagedTags(tags, stackName, actorId)
```

Implement backend-composed `users.list` from Cognito plus batched User controls/counters, and `models.list` from the logical model catalog. Invitation performs `AdminCreateUser -> User control -> group`; budget, role, block/enable, and delete are separate idempotent commands. Require one finite or explicit-unlimited default user budget and give every administrator a User control too.

Use the owner Cognito `sub` plus an AWS-compatible project ID to compose `<ownerSub>/<projectId>`. Create `main` lazily with one project and one owner-membership item. Query the overloaded GSI for memberships and project Agent bindings, then hydrate bound native Harnesses. Exact stack/actor/model tags are reconciliation evidence, never authorization. The access Lambda derives the actor and runtime user; it ignores caller-supplied identity values. Paginate every list call. Do not create Memory catalog events or duplicate Cognito profiles/Harness configurations/chat data.

Gate: invite one disposable Member with a tiny budget, create an active model catalog row, create two bound disposable Harnesses under two actors, write one Memory event, reload, and recover users/models/projects/agents from their authoritative sources. An unbound tagged Harness appears only in admin diagnostics and cannot be invoked.

### Slice 4 — authorized Harness lifecycle

Create agents with `CreateHarness`, not CloudFormation. Administrators, owners, and editors all use the same projected RPC operation:

```text
authorize project + active user
-> resolve active modelKey, safe tuning bounds, skills, capability profiles
-> compute deterministic configuration/tags
-> CreateHarness(clientToken)
-> conditionally write Agent binding
-> poll GetHarness to READY/CREATE_FAILED and mark binding ready/error
-> select agent
```

Editing conditionally marks the binding `updating`, calls one `UpdateHarness`, polls to `READY/UPDATE_FAILED`, and completes or leaves a repairable error state. Deletion marks `deleting`, removes the Harness's prefixed sessions, calls `DeleteHarness(deleteManagedMemory:false)`, then removes the binding. AgentCore has no native archive operation, so the UI does not invent one. Raw provider configurations, role/credential ARNs, hooks, actors, and ownership tags never come from member drafts.

Gate: a Member creates an agent in `main`; an editor creates one in a shared project; viewer/auditor attempts fail; an administrator uses the same RPC path. Two Harnesses retain different prompts/models/tools/versions while sharing the same project actor. Blocking their model prevents new invocation without rewriting either Harness.

### Slice 5 — chat, usage, storage, and streaming

The browser posts only project key, Harness ID, prefixed session ID, logical turn ID, client-generated request ID, and the new message. The Lambda verifies membership, derives actor/runtime-user IDs, strongly reads the user's active-period committed spend, rejects only when an enabled finite limit is already exhausted, conditionally creates the idempotent request, invokes Harness, and forwards documented stream variants. Work admitted below the limit is allowed to finish even if another concurrent request creates overdraft. Retain unknown stream variants as expandable JSON.

As each trusted model, cache, embedding, Memory, Gateway/tool, Browser, Code Interpreter, or Runtime quantity becomes available, append a deterministic immutable component event. In one DynamoDB transaction, conditionally insert that event and increment the request, user-period, and time-bucket projections; duplicate delivery is a no-op. Late corrections append adjustment events. Request terminal status is operational only and never holds budget. A stale request is diagnosable but cannot block future work. Do not configure a custom Memory strategy or write cost projections into Memory; conversational messages stay in Memory, compact accounting stays in DynamoDB, and detailed traces stay in CloudWatch.

Use one `AbortController` per active session and disable duplicate sends in the UI. After cancellation, call or offer `StopRuntimeSession` when server work continues. The stream emits normalized `usage.event` and `usage.summary` records when available; reload joins the request ID through the usage API. Unknown or incomplete native meters are labeled `estimated` or `unpriced`, never silently free. Best-effort reconciliation can append missing events or adjustments, but it is not an unlock mechanism.

`storage.beginUpload` strongly reads committed managed bytes and, if the user is below the limit, returns an exact-key, content-length-bounded presigned POST into the user's managed prefix. It writes no pending-byte row. S3 object-created/removed notifications idempotently maintain the object manifest and user byte projection. Concurrent accepted uploads may overrun the limit; retain both objects, show overage, and block later uploads until deletion or a limit increase. Reconciliation is an explicit administrator operation initially; add a schedule only if observed missed notifications justify another resource.

Gate: create, stream, cancel, reload, and resume two chats under each of two agents. Verify session/project isolation, duplicate request/component idempotency, already-exhausted rejection, allowed race overdraft without debt, warning/unlimited modes, lost-finalizer behavior, usage drill-down, and storage overage/recovery.

### Slice 6 — credentials, targets, and Policy

Implement account/project/agent tag filtering before any create form. The integration saga records every created ARN in memory:

```text
credential provider -> Gateway target -> sync READY -> Cedar policy -> Harness assignment
```

Retries use idempotency fields where available. Failure offers Retry and Cleanup-this-attempt. Cleanup touches only resources tagged with the current smoke/run ID.

Credential values are write-only. Rotation calls the provider update API. Deletion first checks target/Harness references. The policy editor starts from reviewed templates, validates against the live Gateway schema, and explains that `ENFORCE` is default-deny.

Gate: management tests pass with a real disposable AgentCore Identity provider holding a generated throwaway key; functional tests then use read-only Google/Jira operations with real vendor test credentials as described below.

### Slice 7 — Code Interpreter access profiles

First implement role-based S3 access:

- create/select a custom Code Interpreter;
- use a dedicated role constrained to one disposable bucket prefix;
- use MMDS temporary credentials from Python/JavaScript/AWS CLI in the interpreter;
- never place AWS keys in the Harness or prompt.

Only afterward implement the optional direct-secret profile. It requires a project-specific interpreter/role, exact secret ARN grant, public-network warning, and explicit confirmation. It remains outside Gateway Policy enforcement.

Gate: code writes, reads, and deletes one object under the allowed prefix; access outside the prefix is denied. The optional direct-secret test uses a generated throwaway token and returns only its SHA-256 digest.

## 4. Test architecture

### 4.1 Fast local tests on every change

Move the current in-page `?test=1` suite out of `index.html` into `agentcore/tests.js`. The HTML retains only a conditional `import('./tests.js')` hook and passes a small test-only interface; normal application startup never fetches the test file. The root `test.js` runner must read a structured `window.TESTS_DONE = { passed, failed }` result, fail its process when `failed > 0`, and also fail on uncaught page errors, failed module loads, or timeout. Today the copied page sets `TESTS_DONE = true` even after failures; fix this before treating any green test output as evidence. This keeps the normal runtime one HTML file and the inner test loop fast without a build step. `agentcore/package.json` has `"type": "module"`; Node scripts and browser modules use `.js`, never `.mjs`.

Local tests cover pure and browser-local behavior: actor/period/key derivation, integer cost and cache arithmetic, PKCE/state parsing, URL and template equality, stream reduction, modal routing/reactivity, secret redaction, and static checks that normal mode has no AWS credential path. They use ordinary inputs and observed outputs. They do not replace AWS SDK clients or synthesize Cognito, Harness, Memory, Gateway, DynamoDB, S3, or CloudFormation responses. Any claim about those services moves to the live suite below.

Keep this local command short and deterministic; report its own elapsed time separately from live AWS provisioning. No local test receives real credentials.

### 4.2 Scripted inference over a real Harness

The existing browser `getEchoClient()` and its JSON scenario language are useful starting material, but invoking that client in the page bypasses AgentCore. Adapt the scenario interpreter into a stateless, test-only OpenAI-compatible Chat Completions endpoint that emits deterministic text, tool-call fragments, stop reasons, and synthetic usage. When `EnableScriptedTestModel=true` on a disposable stack, expose `POST /test-model/v1/chat/completions` through the existing API Gateway/Lambda as a streaming integration. The runner generates `ScriptedTestModelKey` for that run, passes it as a NoEcho deployment parameter, and creates a disposable AgentCore Identity API-key provider holding the same value. The Lambda checks the bearer key without logging it. Configure a disposable model catalog row and Harness with `liteLlmModelConfig.apiBase` pointing to the test endpoint and `apiKeyArn` pointing to that provider, so the real managed Harness makes the model call. Production stacks leave the route disabled.

Start with one live compatibility probe through `InvokeHarness`; confirm that LiteLLM accepts the endpoint's request/stream format before expanding scenarios. The scripted model is the sole substitute: Harness lifecycle, actor/session isolation, streaming, Memory, Gateway/Policy, Browser, Code Interpreter, Cognito, S3, DynamoDB, and API Gateway all remain real AWS calls. Synthetic token counts test application accounting mechanics and are labeled test data; they do not establish a provider's real billing rate. Real Google/Jira tests use real vendor test credentials and endpoints when available; absent credentials are reported as unrun, never replaced by fake vendor services.

Keep the scripted responses minimal: plain reply, one tool call followed by a reply, multi-call, cache/usage counters, provider error, and delayed/cancelled stream. Use stable scenario IDs and bounded outputs so failures are reproducible.

### 4.3 Read-only account contract test

`scripts/probe-account.js` is the default account test. It validates profile resolution, STS identity, read visibility, current SDK compatibility, and IAM simulation without creating state.

Run it once per live suite and after SDK upgrades. A denied or inaccessible surface is a blocking result, not something the UI should work around with broader permissions.

### 4.4 Automated browser UX and CORS/authentication smoke

Use a development-only Playwright suite (or the repository's equivalent browser driver) against the real `https://park-brian.github.io/chat/agentcore/` entry URL and the registered localhost origin; `file://` is not an OAuth callback. Drive the visible UI, including Cognito managed login, rather than calling product commands behind the page. Each slice adds a browser journey for its actual controls: open and close the routed modal, edit a draft, save, reload, inspect the persisted AWS-owned result, and exercise an expected denial or failure. Use state-based waits for Cognito redirects, stack/Harness readiness, streams, and S3 notifications; arbitrary fixed sleeps are not acceptance evidence.

The suite may create disposable Cognito users in its disposable User Pool. Use generated role-specific addresses under `example.invalid`, `AdminCreateUser` with invitation delivery suppressed, then set generated policy-compliant test passwords through Cognito. Hold passwords and tokens only in the test process/browser memory, redact traces/screenshots, and never send invitations to real people. The test users exercise the same managed-login page as users do; SDK calls only arrange and later remove fixtures.

For each journey, assert the visible controls, keyboard/modal behavior, denial message or completed result, and the authoritative AWS state after reload. Cover agent/model/skill/tool edits, project switching, integration credential rotation, user limits, usage request/tool drill-down, storage overage, and sign-out as those features land. Run from the actual GitHub Pages origin and the registered localhost origin:

1. open the stack's `ApplicationEntryUrl` and begin PKCE;
2. sign in through Cognito managed login and complete the code exchange;
3. call `session.get` and verify the expected command capabilities;
4. verify role-appropriate `/rpc` permissions and the absence of normal-mode AWS credentials/clients;
5. verify streamed `/chat` decoding and that the trusted invocation contains derived actor/runtime-user values;
6. inspect DevTools storage: no tokens, AWS credentials, or stale PKCE callback record;
7. reload and confirm a fresh authorization occurs with no stored application token;
8. sign out and confirm both local state and the Cognito login session are cleared;
9. run the external-resource integrity assertion.

Preflight success alone is insufficient; these must be signed browser calls with real responses.

### 4.4a Browser-first implementation and visual review

The implementation reuses the parent `server.js` and root `test.js`. The server binds loopback and blocks dotfiles, `node_modules`, and out-of-root paths. The current stack default callback is `http://localhost:8000/agentcore/` with origin `http://localhost:8000`; both are configurable parameters. The no-login browser runner starts the parent server on a random port. The live runner uses the stack's exact `LocalUrl`, starts the parent server on its port when available, or checks and reuses an existing server without stopping it. OAuth never runs from `file://` or a random callback port. GitHub Pages remains a separate release smoke. See [STATUS.md](./STATUS.md) for the exact commands working today.

Implement the first vertical slice in this order:

1. Repair test-result propagation, extract `tests.js`, reuse the loopback parent server and generic root browser runner, and update the copied header's obsolete `file://` instructions while preserving its SolidJS reactivity guidance. The runner records page/module/console failures and exposes a narrow test-only bridge for `_screenshot(...)`; no screenshot bridge is present in normal app mode. This step is implemented.
2. Replace the copied app with the small disconnected Solid shell and routed modal host. Open it in headed Chromium and capture its first desktop/mobile images before adding AWS state. This is the only visual state that does not need a live stack.
3. Create the warm dev stack; prove real Cognito PKCE on the fixed local URL, real `session.get`, and exact CORS. This is the browser integration risk to settle before building many dialogs. Create disposable smoke users through Cognito, but log in through the visible form.
4. Add one end-to-end chat path: native Harness create, scripted-model invocation through the real broker, streamed message, Memory reload, and usage row. Only after that path is observed in the browser, build each management modal as a thin projection of its live AWS-backed operation.
5. For each story: write its visible outcome and denial/error case, implement the smallest UI/API path, run `npm test`, run its targeted warm `test:live`, take screenshots, inspect them, adjust type/spacing/alignment/color, and rerun the same story. Do not promote a story based only on an API response or a screenshot; both behavior and visual presentation must pass.

The browser runner shares the warm stack from §4.5. A named story owns `arrange` (real AWS fixture IDs), `drive` (Playwright clicks/typing through the rendered UI), `ready` (observable element/stream state), `assert` (visible result plus authoritative AWS read), `capture` (optional screenshots), and `cleanup` in `finally`. It must not call application-internal functions to manufacture a visual state or route product commands around the UI. A small stable `data-testid` is acceptable when semantic role/name locators are ambiguous; prefer user-visible labels. Keep one browser context per story and close it in `finally` so cookies and memory-only tokens do not cross users. Do not save browser storage state or network traces containing credentials.

Current screenshot and live-story commands:

```powershell
cd D:\Projects\chat\agentcore
npm run csp:sync                            # after editing/formatting the single-file app
npm run test:visual                         # shell story, desktop/mobile captures
npm run test:live -- <stack> --profile eaap --region us-east-1 --screenshot
```

`test:visual` is a **real-browser story run with screenshot capture**, not an image generator or alternate mock UI. `tests.js` exports the test-only asynchronous helper `async _screenshot(name, element = null, options = {})`; a test can call:

```js
await _screenshot("chat-ready");
await _screenshot("agent-dialog", document.querySelector('[role="dialog"]'));
await _screenshot(
  "usage-table",
  document.querySelector('[data-testid="usage-table"]'),
);
```

Omitting `element` captures the viewport (or full page when `options.fullPage` is true); an `Element` captures that DOM node, including a dialog or message. The helper rejects a missing/detached/hidden node rather than silently taking the whole screen. It awaits `document.fonts.ready`, temporarily marks an element with a unique test-only attribute, calls an awaited Playwright binding with `{name, targetId, fullPage}`, and removes the mark in `finally`. The Node runner verifies the binding came from the exact allowed app origin and path, sanitizes `name` to a filename (never accepts an output path from page code), serializes captures, applies standard secret masks, and uses `page.screenshot()` or `locator.screenshot()` as appropriate. A binding error fails the test. The runner imports/installs this helper only after reaching the app page; production `index.html` never fetches `tests.js` or defines `_screenshot` in normal mode. The bridge must not capture Cognito pages or callback URLs with authorization codes. This gives tests a one-line capture at the meaningful DOM state while keeping filesystem access in Node. [Playwright bindings](https://playwright.dev/docs/api/class-page#page-expose-binding) and [page/element screenshots](https://playwright.dev/docs/screenshots) support this split.

The runner captures after explicit ready assertions, with animations disabled, a fixed browser version/viewport/device-scale factor, and deterministic generated content from the scripted inference Harness. Start with desktop 1440×900 and mobile 390×844 at DPR 1; add tablet 768×1024 and 200% text/zoom checks for release. Capture both full-page and the active modal when appropriate. Use a stable local, gitignored path such as `agentcore/.artifacts/screenshots/<runId>/<story>/<viewport>.png` and print the exact path. Screenshots contain only disposable example data; mask generated credentials, tokens, account IDs, and URLs that could carry callback codes. A failed story may capture a redacted failure screenshot but never a raw auth redirect.

The visual review is deliberate: open each image at actual size, compare desktop/mobile side by side, and check font hierarchy, readable line lengths, spacing rhythm, alignment, contrast, modal width/scroll containment, focus visibility, loading/empty/error states, long names, and chat/tool output density. Add browser assertions for no horizontal overflow, visible primary action, modal keyboard focus/Escape behavior, and absence of clipped controls. Fix a visual defect in the HTML/CSS, reload, rerun the same story, and inspect the new screenshot. Keep screenshots as local session artifacts for review, replacing old captures rather than accumulating them; remove them at `dev:down` after review unless the user explicitly asks to retain a sanitized example. Pixel-diff baselines are optional only after a design is accepted: [Playwright warns that rendering varies by OS/browser/environment](https://playwright.dev/docs/test-snapshots), so baseline approval cannot replace human inspection.

The browser compatibility gate runs the same local signed story in headed and headless Chromium during development, then smoke-tests supported Firefox/WebKit versions and the published GitHub Pages URL before release. Observe JavaScript exceptions, rejected promises, failed network/module/style requests, CSP/integrity violations, OAuth callback errors, and console errors; wait for a visible signed-in/ready state rather than `networkidle` on a streaming app. Check that `.js` modules have JavaScript MIME type, the import map and pinned CDN assets load, the test module is absent in normal mode, and normal mode has no AWS credential path. Browser support is an observed matrix, not inferred from a Node-only test. If import-map integrity is unsupported in a target browser, either restrict the supported browser set explicitly or use the planned same-origin vendor snapshot; do not weaken the security policy silently.

### 4.5 Warm disposable development stack and mandatory cleanup

The unit of provisioning is a **development session**, not a test invocation. A cold foundation stack, Cognito domain, shared Memory/Gateway/Policy resources, and one scripted-model Harness take materially longer to create/delete than a targeted test. Create them once with `dev:up`, run as many targeted live test commands and browser reloads as needed, and remove them with `dev:down` when development work ends. CI uses the same lifecycle in one job's `try/finally`; a local developer explicitly ends the session. A full cold create-and-destroy test is a separate release/CI check, never part of the inner loop. A warm test must not call CloudFormation create/update/delete merely to reset application state.

The _development session_ and each _test invocation_ have different IDs:

```text
sessionId = chat-dev-YYYYMMDDTHHMMSSZ-<6 random hex>
stack = chat-dev-<same suffix>                  # exact stack ID retained from CreateStack
runId = chat-test-YYYYMMDDTHHMMSSZ-<6 random hex>  # new for each test command
users = smoke-admin/member/auditor-<runId>@example.invalid, as required by scenarios
projects/sessions/requestIds = unique per scenario, never reused to reset state
```

All taggable resources receive `ac-chat:managed-by`, `ac-chat:stack`, and `ac-chat:dev-session=<sessionId>`; scenario-owned resources also receive `ac-chat:test-run=<runId>` and the exact non-secret `ac-chat:actor-id` when project-scoped. Record the exact AWS account, Region, stack ID, stack outputs, template hash, and created native resource IDs in a gitignored, non-secret local session manifest. The manifest is a safety index, not the product state; AWS tags and native list/get APIs are the authority. Never persist AWS keys, Cognito passwords/tokens, test-model bearer keys, or raw integration values. Use an exclusive local session lock so two runners cannot reset the same fixtures.

Planned package commands (these do not exist until the test runner is implemented):

| Command                                               | Work                                                                                                                                                                                    | Provisioning boundary                                                                          |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `npm run dev:up -- --profile eaap --region us-east-1` | STS/account preflight, validate the exact existing dev stack or create one, wait for outputs, create session-wide scripted Harness/Identity fixture, register localhost callback/origin | Cold once per development session; idempotent warm no-op afterward                             |
| `npm run test:live -- --grep <feature>`               | Run only selected real-AWS/browser journeys with a new `runId`; arrange and remove scenario fixtures in `finally`                                                                       | Reuses stack, Cognito pool, shared AgentCore primitives, and scripted Harness; no CF lifecycle |
| `npm run dev:sync-code`                               | Update only the disposable broker Lambda code and wait for `Successful` update; use the observed `RevisionId`                                                                           | Fast code iteration without stack operation; never allowed for production                      |
| `npm run dev:sync-infra`                              | When template/parameters change, validate a change set, update the exact dev stack, refresh outputs, and reverify fixtures                                                              | Deliberate slower infrastructure iteration only                                                |
| `npm run dev:down`                                    | Stop tests, clean exact direct-created native resources and smoke users, empty the versioned test bucket, delete the exact stack and retained bucket, verify absence                    | Cold teardown once when work ends; nonzero if anything remains                                 |
| `npm run dev:gc`                                      | Recover an interrupted session using the exact recorded IDs plus account/Region/tags; list and report unknowns, never delete by prefix                                                  | Crash/orphan recovery, not an alternate normal teardown                                        |

`dev:up` must first compare STS account, Region, stack ID/name, `ac-chat:dev-session` tag, expected application origin, and template hash. If all match and the stack is `CREATE_COMPLETE`/`UPDATE_COMPLETE`, reuse it. If the template changed, require `dev:sync-infra`; do not silently update the stack during a test. If the stack is in rollback/failed/deleting state, stop and show the exact state rather than adopting a similarly named stack. If no manifest exists, discovery can present exact tagged candidates, but requires explicit selection before reuse or deletion. The dev stack is isolated from existing `eaap-ac-*` resources and production stacks. No extra cleanup scheduler or always-on service is needed: CI's `finally`, normal `dev:down`, and `dev:gc` cover the lifecycle. If local work is abandoned before teardown, surface a stale-session warning on the next command; time/age alone is never authority to delete.

The first `dev:up` generates the test-model secret in process memory and creates the NoEcho stack parameter/Identity provider once. Warm runs use the already-connected disposable Harness; they do not need to recover the bearer secret. If this fixture is lost or incompatible, repair just that fixture by exact ID. Use localhost for rapid browser journeys (the callback and CORS origins are explicit template parameters), then run at least one signed smoke from the actual `https://park-brian.github.io/chat/agentcore/` origin after publishing. Frontend `.html` refresh and `tests.js` edits need no AWS deployment.

The broker's source of truth remains the CloudFormation template/artifact. `dev:sync-code` is an intentional, disposable-stack-only code drift shortcut using Lambda [UpdateFunctionCode](https://docs.aws.amazon.com/lambda/latest/api/API_UpdateFunctionCode.html) with `RevisionId`; record the deployed source hash in the session manifest. A subsequent `dev:sync-infra` must reconcile the template artifact to that code hash (or intentionally redeploy it), and release/production deployment always goes through CloudFormation. Agent configuration changes use native `UpdateHarness` and never update the foundation stack. A warm smoke uses real Cognito, CloudFormation-owned resources, Harness, Memory, Gateway/Policy, DynamoDB, S3, and API Gateway; only inference responses come from the scripted model.

Use one session-wide scripted-model Harness and read-only smoke admin/member fixtures for journeys that do not mutate them. Create a dedicated Cognito user or Harness for any budget, role, model, or lifecycle test that would alter a shared fixture, and delete it in that scenario's `finally`. Independent tests may run with a small bounded concurrency pool; serialize all mutations to the same fixture. Avoid fixed sleeps: wait on observable READY/ACTIVE states with capped backoff. Track **cold setup**, **warm selected tests**, **per-scenario cleanup**, and **cold teardown** as four separate timings. The performance objective is zero CloudFormation operations on a warm selected test, short bounded payloads, and a fast local `npm test`; publish measured p50/p95 timings rather than promising an AWS provisioning time the suite cannot control.

The complete suite covers these milestones; independent scenarios need not run in this listed order, and the stack lifecycle assertions run in a separate cold-lifecycle job rather than every warm invocation:

1. validate and bootstrap the foundation stack;
2. create disposable admin/member/auditor users, complete login, and verify each expected role;
3. create two projects/memberships and their owner-scoped actors;
4. create two tagged Harnesses and rediscover them;
5. invoke/resume both Harnesses through `/chat`, verify session filtering, and inspect idempotent request/component usage events;
6. update one Harness and verify version increment without changing the other;
7. create/tag/rotate a real disposable API-key provider holding a generated throwaway value;
8. create/sync a test target and default-deny/permit policies;
9. test S3 via a scoped custom Code Interpreter role;
10. change a user's group with global sign-out; invite/disable/enable/delete another user without affecting project state;
11. test owner/editor/viewer permissions and cross-project/actor/session denials;
12. set a tiny finite budget, verify already-exhausted admission denial, race two requests accepted below the limit, display forgiven overdraft, and prove a forced stale request holds no budget;
13. delete one disposable Harness and verify the other remains;
14. verify unmanaged resources are not adopted;
15. delete direct-created dependents with exact confirmations;
16. at `dev:down` or CI job completion, delete the disposable stack and its exact test bucket, including all object versions and delete markers, and verify the login endpoint is gone.

Every test owns its fixture IDs and cleans them in `finally`/`afterEach`, whether it passes, fails, or times out. Delete its temporary agents, objects, policies, targets, credentials, and dedicated users in dependency order; verify resulting absence through native list/get APIs. Delete test-created Memory events and derived long-term records separately by exact ID: [DeleteEvent does not remove long-term derivations](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/short-term-delete-event.html). Empty session metadata can remain until AgentCore's [one-day expiry](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_ListSessions.html); do not claim an unsupported session-delete operation. Immutable test usage rows remain as labeled evidence inside the isolated dev table until `dev:down`, rather than being silently erased to reset a budget. Session-wide smoke users, Harness, Memory, Gateway, and stack remain warm between test commands and are removed only at `dev:down`/CI `finally`. The teardown empties the exact test bucket's current objects, noncurrent versions, and delete markers before bucket deletion. A production stack's retained bucket policy does not make a dev bucket permanent. If cleanup is interrupted, the runner retries boundedly and writes a redacted orphan report containing exact account/Region/stack/session/run IDs and remaining resource IDs; `dev:gc` targets only those recorded IDs. Never select resources for deletion from a broad name prefix alone. Existing `eaap-ac-*` resources are always unmanaged and excluded.

The CI job fails when either the behavior or required cleanup fails. Keep a short per-test record of created IDs and cleanup results, but never persist test passwords, tokens, raw credential values, or chat content. The default account probe is read-only and has nothing to clean.

## 5. Functional credential tests

### 5.1 API-key provider management

The management test creates a real AgentCore Identity provider with a generated throwaway value, confirms list/get/tag visibility without value disclosure, rotates it, and deletes it. This proves the native provider lifecycle; downstream authentication is tested separately against a real vendor test endpoint.

### 5.2 Jira

Use the smallest read-only target first:

- provider: Atlassian OAuth when user delegation is desired, otherwise a Jira API token provider;
- OpenAPI operations: `myself`, project list, and bounded issue search;
- Cedar: permit only those reads;
- test: call `myself` and display the authenticated account name, never the token.

Add issue creation/editing only after it is split into a write target/action group with an explicit policy and confirmation.

### 5.3 Google

- create `GoogleOauth2` provider;
- show the AgentCore callback URL for Google Cloud configuration;
- complete consent;
- create a narrow Drive target;
- test `about.get` or a bounded file-list operation;
- verify another user ID cannot silently reuse the first user's OAuth grant.

### 5.4 S3 from code

Use the custom Code Interpreter role, not access keys. Test one allowed prefix and one expected-deny prefix. For cross-account data, test `sts:AssumeRole` with an external ID and a target role; never introduce static keys merely to simplify the test.

### 5.5 Direct secret to code

This is optional and last. Use a generated throwaway secret in real AgentCore Identity/Secrets Manager, retrieve it through the project-specific interpreter role, return only a digest, then remove the role grant and prove retrieval fails. Do not test with a real Jira, Google, or AWS secret until the throwaway-secret path and output redaction pass.

## 6. CI and release checks

Pull-request checks need no AWS credentials:

- HTML/in-page unit tests;
- template equality and static validation;
- dependency exact-version/integrity audit;
- secret-pattern scan of tracked files and rendered diagnostics;
- application-code line count and forbidden architecture checks (`indexedDB`, local tool loop, unpinned CDN ranges).

AWS live tests run automatically from the development machine or a protected environment with temporary credentials whenever a slice changes AWS behavior or browser authentication. They are not part of ordinary credential-free pull-request checks. Never place the `eaap` shared-credentials values in GitHub Actions secrets for ordinary pull requests.

The GitHub Pages release publishes only after offline tests pass. An automated post-deploy browser smoke starts from the stack's non-secret `ApplicationEntryUrl`, signs in with a disposable Cognito user, exercises the visible read-only chat shell and scoped product API, signs out, and deletes that user in `finally`. The generic site contains no hard-coded AWS identity or account-specific ARN.

## 7. Immediate build order

1. Replace CDN version ranges with exact versions and add the dependency-integrity test.
2. Reduce `index.html` to the disconnected shell while preserving the Solid header.
3. Implement deployment-entry parsing, PKCE callback handling, memory-only tokens/credentials, STS identity confirmation, and logout.
4. Author and validate `template.yaml` plus embedded-template equality, including Cognito groups/roles, the table, access Lambda/API, and exact origins.
5. Implement bootstrap/first-admin creation with a User control and default budget, then the composed Users table and lifecycle commands.
6. Implement the Model table/catalog with effective prices, safe provider projections, and blocked-model enforcement.
7. Implement projects, memberships, Agent bindings, `/rpc` authorization, and direct-browser deny tests.
8. Implement committed user-budget admission, immutable component usage events/projections, managed-storage accounting, and streamed `/chat`.
9. Run the first disposable bootstrap/login/role/isolation/model/budget smoke from GitHub Pages.
10. Continue through the remaining slices only after each gate passes.

This order proves the highest-risk assumptions—PKCE correctness, credential containment, group-to-role exchange, member non-bypass, trusted actor derivation, streaming through API Gateway/Lambda, idempotent accounting with race overdraft, signed browser CORS, and Harness lifecycle—before investing in the larger management UI.
