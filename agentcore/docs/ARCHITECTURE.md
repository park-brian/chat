# AgentCore Chat: Runtime-only product plan

Status: authoritative plan and implementation map, 2026-09-22. The old PLAN, API-CONTRACT, IMPLEMENTATION, USAGE-RESOURCES, RUNTIME-DECISION, and STATUS documents record earlier explorations; where they conflict, this document and the current code win. "Implemented" below means exercised in a disposable live AWS stack. "Planned" is not a claim of availability.

## Product in one sentence

A buildless SolidJS page at https://park-brian.github.io/chat/agentcore/ signs users into Cognito and calls one JWT-protected AgentCore CodeZip Runtime; that Runtime executes configurable agents with direct Bedrock Converse, AgentCore Memory and managed tools, while one DynamoDB table stores only app-specific configuration, permissions, budgets, and usage. Plain CloudFormation owns the shared infrastructure.

## Why this is the smallest shape

- A single Runtime handles both deterministic control commands and the model/tool loop. There is no Lambda, API Gateway, Strands, managed Harness, per-agent deployment, or browser AWS SDK in the normal path. A durable agent is a configuration row, not compute. This avoids duplicating auth, budget admission, and lifecycle logic. Direct Bedrock Runtime is materially smaller than bundling Strands; reconsider only if its orchestration features earn their dependency and latency cost.
- Cognito owns login and groups. The Runtime authorizer validates access JWTs before forwarding them; code derives the subject and exactly one group from the forwarded token. The browser supplies no actor ID, role, owner, model override, or AWS credential to ordinary chat.
- Actor ID is Cognito-sub/project, initially sub/main. The agent ID is part of the Memory session ID, so agents in a project can share one Runtime without leaking history. Projects other than main and project memberships are planned, not yet implemented.
- One DynamoDB table is a necessary application ledger; AgentCore Memory is a conversation store, not an atomic budget ledger. One shared private S3 bucket holds CodeZip today and can hold skill/object blobs later. CloudFormation retains it deliberately because CodeZip deployment needs a stable object. No separate artifact bucket.
- Gateway and a Cedar Policy Engine exist in the foundation but have no targets or permits, so are default-deny. They are not yet a usable integrations product. The smallest deployable variant could make these optional until the first integration; do not add further always-on resources just for future plans.
- CloudFormation is the correct foundation boundary: users can audit ownership, IAM, parameters, outputs, update, and teardown. Dynamic agent configurations and credentials do not need a stack each. The browser may eventually use CloudFormation with explicitly entered administrator AWS credentials in a separate deployment mode; this is not required for ordinary users and is not yet implemented.

## Trust and ownership

Normal browser: non-secret deployment descriptor in URL, Cognito authorization-code PKCE, in-memory access token, authenticated POST to the Runtime /invocations endpoint. No user JWT in localStorage, no secret in URL, no direct DynamoDB writes, no generic AWS-operation proxy. The account state remains AWS, not browser storage. Static assets are pinned; inline-module CSP hashes are checked by npm test. Read the coding notes at the top of index.html before editing Solid expressions.

Runtime: only the AgentCore front door is public. It checks issuer, client ID, token use, expiry, subject shape, and fixed group cardinality after service validation. A local port must never be exposed as a public auth surface. Administrators can manage defaults, users, model rates, and their own agents; Members manage their own agents and chat; Auditors read only their permitted views. Admin combined usage is an explicit role gate. All write operations are scoped by the derived subject or a validated target and use least-privilege IAM. Never log tokens, prompts, credential bodies, or third-party secrets.

AWS administrators: CLI bootstrap is allowed. Production Cognito administrators are not equivalent to AWS account administrators; the former cannot mutate CloudFormation/IAM. Any future browser deployment mode must be visually distinct, short-lived, explicitly entered credentials, and limited to a reviewed stack/template, with no credential persistence.

## Current resources and code

CloudFormation template.yaml creates a Cognito user pool, managed-login domain and public PKCE client, three groups, one on-demand DynamoDB table with a sparse UsageByTime index, one versioned private S3 bucket, AgentCore Memory, default-deny Gateway/Policy, and (after ZIP upload) one Node 22 CodeZip Runtime with its IAM role. The only server source is controller.js, bundled to one index.js ZIP by scripts/build-controller.js. The ZIP key is content-addressed and supplied as ControllerCodeKey in a stack update. The browser is index.html; tests.js holds opt-in stories and _screenshot, using the shared parent test.js. scripted-model.js is only enabled by a disposable-stack parameter and mocks inference only; Cognito, Runtime, Memory, DynamoDB, and Code Interpreter remain real in live tests.

Bootstrap: create the stack with blank ControllerCodeKey; upload the deterministic ZIP into its SharedObjects output; update that same stack with the key; wait for Runtime READY; take ApplicationEntryUrl. Later code iterations reuse the stack and update only the key. Do not create/destroy a stack per browser test. Preserve the stack during development, then delete the exact disposable stack and inspect/delete only its retained bucket and versions. The browser should gain a guided CloudFormation administration dialog after auth/stack APIs are proven in browser CORS; no privileged deployment credentials should be mixed with the Cognito session.

## Application protocol, implemented

POST /invocations accepts version 1, command, input, and optional requestId. Control calls return an ok/data or stable error code JSON object. chat.send returns SSE message.delta, tool.done, message.done, or error. One Runtime session header is sent by the browser. No arbitrary AWS SDK call is exposed.

Implemented commands:

| Command | Permission | Effect |
| --- | --- | --- |
| session.get | signed-in | Initialize/read own control row and account defaults |
| agents.list, agents.put | own project; put denies Auditors | Query/create agent config in sub/main |
| models.list | signed-in | Approved model catalog plus test echo only in disposable mode |
| models.put | Administrators | Save active model ID and explicit input, output, cache-read, cache-write prices |
| users.list, users.invite, users.setLimits | Administrators | Cognito users/groups and per-user budget/storage overrides |
| defaults.get, defaults.set | Administrators | Account budget, storage, UTC reset cadence with revision check |
| usage.summary | signed-in | Strongly read own current-period committed model spend and unpriced-tool count |
| usage.list | own user, or admin-selected user/all | Query 30/90-day chronological request/tool rows, asc/desc, 50-row cursor |
| chat.send | own agent; denies Auditors | Budget admit, recent Memory context, direct Bedrock/tool stream, Memory event, atomic usage commit |

Current dialog routes: Account, Agents, Models, Users, Usage. Skills and Integrations are visible navigation entries but not functional management yet; they must say so plainly. One native dialog hosts all routes; no page-level control sprawl. Usage shows current reset-period summary separately from a last-30/90-days ledger filter, order selector, admin all-users selector, and Load more. The latter uses the same protected API, not a table scan.

## Usage and budget invariants

The default is $5 per user per UTC day and 5,000,000,000 storage bytes. Administrators can change account defaults, per-user limits, and daily/weekly/monthly UTC reset cadence. Reset is lazy: a period key is computed at read/admission time; no cron, scheduled Lambda, or pending reservation exists. Historical rows survive reset. A strongly consistent current-period sum gates a new chat only when already at or above the budget. Concurrent races can overdraft; that is accepted as our error and the user is not charged a synthetic penalty. A failed or stuck pending request cannot block future work.

Every completed model request writes a UTC ISO timestamp-sortable row under USER#sub and a sparse GSI time key for admin combined views. Each tool invocation gets its own row. A transacted completed-request marker, request row, tool rows, and period increment provide idempotent ledger commits. Marker TTL is 30 days; no marker is written before work finishes. The marker is not a reservation. Memory and DynamoDB cannot share one transaction: if Memory succeeds and the ledger write fails, the stream reports failure; reconciliation must detect/fix that before production monetary claims.

Costs use exact Converse token meters: input, output, cache-read input, cache-write input, each multiplied by its administrator-configured price per million tokens, then rounded to micro-USD. Bedrock inputTokens excludes cache meters, so do not subtract them again. The usage row snapshots rates for audit. Scripted inference is zero cost. Model rate entries are manually maintained and must be region/model-specific in practice. Managed Code Interpreter call prices, Runtime time, Memory, embeddings, Gateway, S3, third-party API charges, tax, and provider discounts are not yet metered; the UI calls tool events unpriced and quality partial. Do not present model-only spend as a complete AWS bill or enforce a supposedly complete dollar budget until those meters and reconciliation are implemented. Define measured, estimated, and unpriced quality per component; use AWS billing/usage exports to reconcile, never invent tokens.

Usage sorting is event-time based, not budget-period based. Own-user reads use the strongly consistent primary key, while admin combined reads use an eventually consistent sparse GSI. 30d and 90d are rolling day windows, not calendar-month labels. API cursors are opaque to the UI, bounded and validated by the Runtime. Admin should eventually get a selected-user filter, custom date range, aggregates, and CSV export; keep raw event rows as the source.

Storage: the configured 5 GB is a policy limit, not yet enforced or counted. Planned object ledger records owner/project/object key, size, revision and lifecycle; browser uploads use time-limited presigned S3 requests with a server check before commit, then on-demand reconciliation handles abandoned multipart uploads and deletes. Objects and skills live in the shared bucket under unguessable owner/project prefixes with explicit tags. Avoid per-user buckets and per-project stacks.

## Agent loop and background work

The Runtime currently loads up to 20 recent Memory events, appends the user turn, and runs at most eight direct ConverseStream turns. It streams text, validates execute_code arguments, starts one managed Code Interpreter session lazily per chat, invokes the tool, records timing/error, feeds the result to the model, and stops the session in finally. Memory actor sub/main and session a_agentId_conversationId isolate context. A model without usage telemetry fails rather than silently receiving a zero charge. Browser and Gateway tool execution are future slices, not claims of current behavior.

Ordinary chat should stay foreground streaming. For a genuinely long job, use Runtime /ping HealthyBusy while active and a durable task row with ID, owner, status, checkpoint, lease-expiry, and result pointer. On demand, tasks.get or tasks.resume may acquire an expired lease; never rely on a process surviving forever, nor leave a permanent pending budget lock. Do not add SQS/EventBridge/worker resources until a real job requires stronger delivery guarantees. Terminal task results should be idempotent and metered only on measured completion. Benchmark cold start, warm control, first SSE chunk, full chat, and real tool turns before accepting any added orchestration layer.

## Credentials, Gateway, and policy roadmap

Secrets are not model instructions. Integrations need a managed provider/credential record with owner scope (user, project, or account), type, display name, status, tags, and secret reference; only a guarded broker can create/update/delete credentials. Never return secret bodies to chat or logs. Users may add their own Jira/OneDrive/API keys; administrators may define approved integration templates and account credentials. Gateway targets should expose reviewed operations with a minimal schema, per-user/project/agent authorization, explicit Cedar permits, and audited tool calls. Keep default-deny when no policy exists. Code Interpreter needs an explicit credential-injection design: ephemeral scoped tokens or references, per-agent allowlist, expiry, no long-lived AWS access keys passed as raw prompts, and no ambient permission beyond the task. Native AgentCore Identity user-delegated OAuth must be proven with the JWT-invoked Runtime before advertised. A cloud provider integration can use its own provider credential flow; do not conflate AWS account administration credentials with third-party secrets.

Skills are versioned text/object manifests scoped to user/project/agent with byte limits and a human-readable review. S3 holds content; table rows hold metadata and grants. Agent config lists approved skill versions and tool capability flags, not arbitrary executable code. Browser, Code Interpreter, and Gateway each need tests for denied grants and cost attribution. Per-agent configurations share one Runtime; a separate Runtime per configuration is warranted only for a demonstrable isolation, dependency, region, or scaling requirement.

## Remaining work in dependency order

1. Finish current Runtime slice: reject malformed control bodies, test all group permissions and budget exhaustion live, check event/cursor pagination and error behavior, ensure Memory/ledger failure reconciliation, and confirm production Bedrock model access with an approved model and a small paid smoke turn. The present live suite intentionally mocks inference only.
2. Make configurable projects and agent lifecycle complete: project create/list/rename/archive, memberships or explicit single-owner policy, agent edit/archive, model catalog version/region/price revision, authorization regression tests. Keep agent ID separate from actor ID.
3. Complete cost coverage and enforcement: use official per-service meters where available, per-tool/service rows, storage accounting, usage reconciliation, budget presentation and alerts, and a correction record rather than mutating historical facts. Expose user and admin per-request/tool time views with pagination and cumulative summaries.
4. Implement credential vault and Gateway target lifecycle, tested against real disposable service resources; add Cedar permissions and scope tagging/filtering. Build one narrow Jira or equivalent integration before generalizing the UI. Add secure Code Interpreter access only after a concrete ephemeral credential design.
5. Add skills and shared-bucket object flows; add a real Browser tool story. Keep each modal projection driven by the Runtime API. Add CloudFormation deployment-admin mode only after live CORS/auth testing; CLI bootstrap remains a supported minimal path.
6. Finish production readiness: access/logging review, retention and deletion policy, multi-user isolation tests, benchmarks, native tool cost policy, accessibility and visual pass, GitHub Pages origin smoke test, documented rollback/cleanup. Keep tests quick by reusing one disposable stack, using test.js stories and _screenshot for DOM-node/full-page visual inspection, cleaning every fixture in finally.

## Development loop and live evidence

Read index.html's header before editing. Change one cohesive region at a time; the file is small enough to reason about as sections: deployment/login, RPC/chat, signals/view loading, dialog bodies, shell. Keep server responsibilities in controller.js and pure math in accounting.js. Use apply_patch, then npm run csp:sync, npm test, and the smallest relevant live story. Run parent node server.js or let the shared browser runner reuse/start it. Run visual desktop/mobile stories and inspect screenshots for typography, spacing, focus, overflow, and contrast. Test local static origin first, then published GitHub Pages origin.

Live disposable stack used for this slice: chat-dev-20260922182027, profile eaap, us-east-1; it must be torn down after development and is not a production dependency. The live suite passed Cognito login, config/control mutations, Memory multi-turn history, real Code Interpreter tool use, chronological 30/90-day usage, and admin combined usage. Runtime warm control p50/p95 was about 491/513 ms over eight samples; scripted chat first chunk 471/525 ms and completion 538/559 ms over five samples. A single real Code Interpreter turn completed around 4.1 seconds. These are tiny exploratory samples, not an SLA or a real-model benchmark. Repeat with real Bedrock inference before making user-facing latency promises.

Useful commands from agentcore: npm install; npm run csp:sync; npm test; npm run test:visual; npm run build:controller; npm run test:live -- STACK --profile eaap --region us-east-1 --screenshot; npm run test:runtime-chat -- STACK --profile eaap --region us-east-1; npm run test:runtime-tool -- STACK --profile eaap --region us-east-1; npm run bench:runtime -- STACK --profile eaap --region us-east-1.

Sources: [AgentCore CodeZip Runtime](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-code-deploy-node.html), [long-running Runtime tasks](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-long-run.html), [Memory events](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-customer-scenario.html), [Bedrock prompt caching meters](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html).
