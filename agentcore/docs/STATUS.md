# AgentCore Chat: implemented slice and development loop

Updated 2026-09-22. This is the implementation ledger; [PLAN.md](./PLAN.md), [API-CONTRACT.md](./API-CONTRACT.md), and [USAGE-RESOURCES.md](./USAGE-RESOURCES.md) describe the target product, not a claim that every route exists today.

The backend target changed after a live CORS preflight and SDK review: [RUNTIME-DECISION.md](./RUNTIME-DECISION.md) chooses one JWT-protected AgentCore CodeZip Runtime for deterministic application control, while managed Harnesses remain the chat workers. **The published app still uses Lambda/API Gateway; Runtime parity and migration are not complete.** `controller.js` is an isolated migration slice with only `/ping` and `session.get`; `npm run build:controller` bundles it into a single Linux-readable, content-addressed ZIP under `.artifacts/` using dev-only `esbuild` and `fflate`. `template.yaml` conditionally creates a CloudFormation-owned Runtime when `ControllerCodeKey` names that ZIP in the shared bucket; the default remains the existing Lambda path.

A second disposable stack verified this path live: the Runtime reached `READY`, browser preflight from the GitHub Pages origin returned 200 with authorization/content-type/session headers, anonymous POST returned 401, and `npm run test:runtime -- <stack> --profile eaap --region us-east-1` completed managed Cognito login and a browser POST to the CodeZip Runtime. The Runtime forwarded the validated token to `session.get`; a strongly consistent DynamoDB read confirmed the new $5 default limit. The repeatable story passed twice. Both smoke users/control rows were removed; CloudFormation deleted the exact test stack and Runtime, then its sole retained ZIP version and empty bucket were deleted. This proves the control boundary, **not** chat streaming, Harness invocation, all roles, credential handling, or per-user OAuth.

## Product shape now

`index.html` is the buildless SolidJS app. It retains the original Solid reactivity notes in its header and imports `tests.js` only under `?test=1`. The normal browser has no AWS SDK, persistent token store, or application database. It accepts the non-secret `ApplicationEntryUrl` from the stack, completes Cognito authorization-code PKCE, validates the returned token claims, and calls one Cognito-scoped `/rpc` endpoint. One native `<dialog>` hosts every view. The account, users, models, and usage views now call real AWS-backed broker commands; the agent picker reads user/project bindings. Unavailable capabilities are labeled as unavailable instead of simulating success.

`template.yaml` is plain CloudFormation, not CDK. A single foundation stack creates the Cognito pool/client/domain/managed login and fixed groups, API Gateway with a custom access scope, one inline broker Lambda, one DynamoDB table, one private versioned shared S3 bucket, shared AgentCore Memory, a Policy Engine, an IAM-authenticated Gateway in `ENFORCE` mode, and narrow roles. The bucket is retained on stack deletion deliberately; smoke teardown must delete the exact empty bucket separately. There is no per-user stack or Harness in this foundation. A user's default actor will be `<Cognito sub>/main`; each durable agent will have its own Harness and a thin project binding.

Implemented broker commands: `session.get`, `users.list`, `users.invite`, `users.setLimits`, `defaults.get`, `defaults.set` (optimistic revision), `models.list`, `models.put`, `agents.list` (actual user/main binding query), and `usage.summary` (explicitly `unmetered`). New users inherit an adjustable $5 daily budget and 5,000,000,000-byte storage default. The table currently stores control data, not charged usage events; **budget and storage limits are not yet enforced**. `models.put` is a catalog entry, not a runnable agent. Unknown RPC commands return 501, never a fabricated success. The account administrator role is the Cognito `Administrators` group; broker authorization derives the subject and one fixed group from the API Gateway authorizer, not the request body.

The managed Gateway currently has no targets or permit policies, so it remains default-deny. The shared Harness role currently has no tool permissions. This is intentional until an agent lifecycle and reviewed grants exist.

## Verified live, not mocked

Using `aws --profile eaap --region us-east-1`, a disposable `chat-dev-*` stack reached `CREATE_COMPLETE`. API Gateway CORS preflight responded with the exact localhost origin. The shared root `test.js` runner created a temporary Cognito administrator, completed the hosted managed-login form in Chromium, checked the account/users/models/usage dialogs, changed that user's budget through the UI, read the committed value with a strongly consistent DynamoDB read, and deleted the smoke Cognito user and its control row in `finally`. The original app's browser suite and AgentCore's desktop/mobile local story were also run. No real model inference was used.

During deployment, live CloudFormation revealed two AgentCore-specific schema requirements now encoded in the template: Policy Engine tags are a list (Memory/Gateway tags are maps), and the Gateway execution role needs policy authorization on its own uniquely prefixed Gateway ARN as well as the Policy Engine ARN. The service, not a mock, validated both fixes.

## Day-to-day commands

Run from the repository root for the shared static server and original tests:

```powershell
node server.js                      # http://localhost:8000/agentcore/
npm test                            # original root app
```

Run from `agentcore/` for the new app:

```powershell
npm install                         # dev-only SDKs and Solid source; no browser build
npm run csp:sync                    # after editing index.html, after formatting
npm test                            # fast no-login browser story
npm run test:visual                 # desktop/mobile and DOM-node screenshots
npm run test:live -- <exact-stack-name> --profile eaap --region us-east-1 --screenshot
npm run build:controller            # deterministic single-file CodeZip under .artifacts/
npm run test:runtime -- <exact-stack-name> --profile eaap --region us-east-1
```

The live test reuses an existing **stable disposable** stack; it does not create/delete CloudFormation per test. It uses the stack's exact `LocalUrl`, starting the parent server when the port is free or reusing the existing parent server after checking that it serves this app. Screenshots are gitignored under `.artifacts/screenshots/`. The test-only `await _screenshot(name, element?, options?)` helper captures the whole page or a visible connected DOM node through the shared Playwright runner. Visual review should inspect actual desktop/mobile images, not just green assertions.

Runtime Solid files are pinned to exact static package URLs and SHA-384 import-map integrity entries. A hash-based CSP blocks unapproved inline code and remote scripts. `solid-js/html` compiles static tagged templates with `Function`, so this buildless app requires CSP `unsafe-eval`; it does **not** allow `unsafe-inline`. Keep user data as template values, never as template source. `csp:sync --check` runs before every AgentCore npm browser test and fails on stale hashes.

## Provisioning and cleanup today

The browser deployment-administrator flow is **planned**, not present. For now, bootstrap with AWS CLI and distinct disposable `ResourcePrefix`/`CognitoDomainPrefix` values. `ResourcePrefix` is lowercase alphanumeric, 6–26 characters; `CognitoDomainPrefix` must be globally available in the Region. Example shape (replace both names and profile as needed):

```powershell
aws cloudformation validate-template --profile eaap --region us-east-1 --template-body file://agentcore/template.yaml
aws cloudformation create-stack --profile eaap --region us-east-1 --stack-name <exact-dev-stack> --template-body file://agentcore/template.yaml --capabilities CAPABILITY_NAMED_IAM --parameters ParameterKey=ResourcePrefix,ParameterValue=<unique-prefix> ParameterKey=CognitoDomainPrefix,ParameterValue=<unique-domain>
aws cloudformation wait stack-create-complete --profile eaap --region us-east-1 --stack-name <exact-dev-stack>
aws cloudformation describe-stacks --profile eaap --region us-east-1 --stack-name <exact-dev-stack> --query 'Stacks[0].Outputs'
```

Production `ApplicationEntryUrl` is an output; local testing substitutes the configured `LocalUrl` origin/path while retaining its query. The first human administrator must be invited with Cognito `admin-create-user` and `admin-add-user-to-group Administrators` using the output `UserPoolId`, then complete managed login. Public signup is disabled. Normal users can subsequently be invited from the Users dialog. The account defaults and catalog are application state in DynamoDB, not stack parameters after first initialization.

Smoke users and their user-control rows are deleted by the live story. When development ends, check for direct-created Harness/target/provider dependents, delete the exact test stack, then inspect and remove its exact retained bucket, including versions if any. Never delete by prefix or touch existing `eaap-ac-*` resources. There is not yet a `dev:up`/`dev:down` automation; those commands in the long-form roadmap are future work. The present test script does not perform stack teardown for safety.

## Next slices, in dependency order

1. Build the deterministic CodeZip controller and prove authenticated browser invocation, validated-token forwarding, account-control parity, and streaming in a disposable AgentCore Runtime. Keep the current Lambda path until those gates pass. Bundle into the **same shared bucket**, then switch the foundation to CloudFormation-owned Runtime code and remove Lambda/API Gateway without drift.
2. Add a Harness binding transaction and native create/get/update/delete using the installed AgentCore control SDK. Keep `user/project` as actor and one Harness per durable agent. Model catalog entries must gain versioned rates and explicit active/budget policy before being invokable.
3. Add one real streamed `/chat` journey with a scripted echo model only for inference, AgentCore Memory, request IDs, and measured/estimated component events. Strongly read committed user spend before admission; never reserve pending cost. Implement daily/weekly/monthly UTC periods and clearly label unpriced meters.
4. Add skills and large schemas as exact-key objects in the shared S3 bucket, with broker-issued bounded uploads and object-byte projections. Then add AgentCore Identity credential providers, Gateway targets, and Cedar policy/grants. The secret route must never log or echo credential bodies.
5. Add project memberships, complete user administration, storage reconciliation, per-request/tool usage drill-down, deployment-administrator browser CloudFormation mode, and published-origin smoke coverage. Keep every dialog a projection of authoritative AWS state, not a second app database.

Do not claim the full roadmap is complete until the live Harness/chat/usage/credential stories and cleanup gates in [IMPLEMENTATION.md](./IMPLEMENTATION.md) pass.
