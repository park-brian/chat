# AgentCore Chat application API contract

> Historical target contract. The authoritative implemented commands and Runtime-only API boundary are in [ARCHITECTURE.md](./ARCHITECTURE.md) and controller.js. Lambda/API Gateway/Harness routes below are superseded.

**Backend amendment (2026-09-22):** [RUNTIME-DECISION.md](./RUNTIME-DECISION.md) supersedes the Lambda/API Gateway transport described below. The command names and authorization/accounting invariants remain the target; the new transport is `POST /invocations` on a JWT-protected AgentCore CodeZip Runtime. Secret-body and streaming behavior must be reverified there before migration.

Status: target contract; [STATUS.md](./STATUS.md) lists implemented commands and routes
Audience: frontend, CloudFormation, broker, harness, and test authors
Normative language: **must**, **must not**, **should**, and **may** are intentional.

This document defines the smallest application API that keeps the browser thin while making the AWS account the source of truth. It is a refinement of [PLAN.md](./PLAN.md): Cognito owns login identity, AgentCore owns agents, memory, tools, and credentials, and one DynamoDB table owns only the control and accounting facts that those services do not model. [USAGE-RESOURCES.md](./USAGE-RESOURCES.md) is normative for budgets, usage, resets, storage, overdraft, and reconciliation.

## 1. Boundary and design decisions

The browser talks to three public surfaces:

1. Cognito managed login/logout endpoints.
2. The application REST API for chat and product control.
3. AgentCore-generated OAuth authorization URLs, opened only for user consent.

It does **not** call DynamoDB, Cognito administration, CloudFormation, AgentCore control plane, or the token vault after login. Deployment mode may call CloudFormation using credentials explicitly entered by the deployment administrator, but that is a separate UI mode and credential lifetime.

The application API is one Regional API Gateway REST API backed initially by one Lambda. `/chat` uses a streaming Lambda proxy integration; the other routes return ordinary JSON. Authenticated methods use a Cognito User Pool authorizer with an application access scope so they validate Cognito access tokens. A second Lambda is not required. Routes are separated by data classification, not by implementation:

| Route                      | Purpose                                            | Body classification                                           |
| -------------------------- | -------------------------------------------------- | ------------------------------------------------------------- |
| `POST /rpc`                | Small authenticated control commands and queries   | no raw secrets                                                |
| `POST /credential-secrets` | Create or rotate API keys and OAuth client secrets | secret; never logged, traced, echoed, or persisted by the app |
| `POST /chat`               | Invoke/resume a configured agent and stream events | user content                                                  |
| `GET /health`              | Deployment smoke test                              | public, no account details                                    |

The separate credential route is important even though it reaches the same function. API Gateway data tracing is disabled for the whole API, request bodies are absent from access logs, and application logging applies an additional hard deny to this route. The handler passes a secret directly to AgentCore Identity and drops the value before returning.

Do not add CRUD-shaped REST resources for every AWS resource. `/rpc` gives the single-file client one small transport, lets the server authorize commands consistently, and avoids exposing AWS service shapes as the product contract.

## 2. Common wire contract

All authenticated requests use the Cognito access token:

```http
Authorization: Bearer <access-token>
Content-Type: application/json
```

The broker derives `userSub`, global role, and groups from the verified authorizer context. A request can never choose its own user ID or global role.

### 2.1 RPC request

```json
{
  "v": 1,
  "command": "usage.summary",
  "requestId": "018f...uuidv7",
  "idempotencyKey": "018f...uuidv7",
  "ifRevision": 7,
  "input": {}
}
```

- `v` is required and currently `1`.
- `command` is an allow-listed name; no arbitrary AWS operation names are accepted.
- `requestId` is required for tracing and must not contain user data.
- `idempotencyKey` is required for mutations and absent for reads. The result is retained for 24 hours.
- `ifRevision` is required for updates and deletes of mutable records.
- Unknown fields are rejected.

### 2.2 RPC result

```json
{
  "v": 1,
  "requestId": "018f...uuidv7",
  "ok": true,
  "data": {},
  "meta": { "nextCursor": null }
}
```

Errors have a stable application code:

```json
{
  "v": 1,
  "requestId": "018f...uuidv7",
  "ok": false,
  "error": {
    "code": "REVISION_CONFLICT",
    "message": "The record changed. Reload and try again.",
    "retryable": false,
    "details": { "currentRevision": 8 }
  }
}
```

Allowed error codes are `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_FAILED`, `REVISION_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `BUDGET_EXHAUSTED`, `RATE_LIMITED`, `DEPENDENCY_CONFLICT`, `OAUTH_REQUIRED`, `AWS_THROTTLED`, and `INTERNAL`.

Pagination uses an opaque, signed cursor. Clients never send DynamoDB keys or AWS next tokens directly. List commands cap `limit` at 100, default 50.

Amounts are integer `microUsd`; token and request counts are integers. Timestamps are RFC 3339 UTC. IDs are server-generated UUIDv7 values; AWS names are derived from IDs and are not the display name.

## 3. Authorization model

Global roles are Cognito groups and exactly one is assigned:

| Role      | Account users/models/integrations                   | Projects and agents                             | Usage                        |
| --------- | --------------------------------------------------- | ----------------------------------------------- | ---------------------------- |
| `admin`   | manage                                              | all                                             | all                          |
| `member`  | read active models; no account integration mutation | create project, create agent where owner/editor | own plus authorized projects |
| `auditor` | read metadata, never secrets                        | read                                            | all, if granted by policy    |

Project roles are table records: `owner`, `editor`, `viewer`. Global admin bypasses project membership checks but still has a budget and is blocked by account policy when disabled.

Every command has one owner in the broker. The harness is not an administration backdoor: it can read the resolved invocation envelope and append usage, but cannot create users, raise budgets, or grant itself integrations.

## 4. Identity and user management API

### 4.1 Self

`session.get`

Input: `{}`

Returns:

```json
{
  "user": {
    "sub": "cognito-sub",
    "email": "person@example.com",
    "displayName": "Person",
    "role": "member",
    "status": "active",
    "revision": 3
  },
  "capabilities": ["project.create", "agent.create", "usage.readOwn"],
  "defaultProjectId": "...",
  "currentBudget": {
    "limitMicroUsd": 5000000,
    "actualCostMicroUsd": 4123000,
    "remainingMicroUsd": 877000,
    "overdraftMicroUsd": 0,
    "nextResetAt": "..."
  },
  "storage": { "usedBytes": 0, "limitBytes": 5000000000, "overageBytes": 0 }
}
```

The broker reads the Cognito identity and user control row. On first successful login it may lazily create the user's `main` project if absent.

### 4.2 Administration

| Command               | Required role        | Input                                                    | Result / AWS work                                                                    |
| --------------------- | -------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `users.list`          | admin, auditor       | `query?`, `status?`, `role?`, `cursor?`, `limit?`        | merged Cognito + control projection                                                  |
| `users.get`           | admin, auditor, self | `userSub`                                                | profile, policy, memberships, current budget/storage                                 |
| `users.invite`        | admin                | `email`, `displayName?`, `role`, optional initial limits | `AdminCreateUser`; snapshot account defaults into control row; group assignment last |
| `users.resendInvite`  | admin                | `userSub`                                                | Cognito resend path; idempotent                                                      |
| `users.setRole`       | admin                | `userSub`, `role`                                        | replace all app groups, update projection, global sign-out                           |
| `users.block`         | admin                | `userSub`, `reason`                                      | table status first, then `AdminDisableUser` and global sign-out                      |
| `users.enable`        | admin                | `userSub`                                                | `AdminEnableUser` first, table status active last                                    |
| `users.passwordReset` | admin                | `userSub`                                                | `AdminResetUserPassword`                                                             |
| `users.signOut`       | admin, self          | `userSub` (self may name only self)                      | `AdminUserGlobalSignOut` or token revocation equivalent                              |
| `users.deletePlan`    | admin                | `userSub`                                                | blockers: owned projects, agents, active grants, retained ledger                     |
| `users.delete`        | admin                | `userSub`, `resolution`, `confirmation`                  | ordered saga; accounting records retained/pseudonymized                              |

`users.invite` returns the Cognito `sub`; email is never used as an immutable identifier. User deletion never deletes usage facts. It replaces display PII with a tombstone subject after the configured retention policy.

## 5. Budgets, usage, resets, and storage

[USAGE-RESOURCES.md](./USAGE-RESOURCES.md) is the normative accounting contract. The rules below are its transport summary.

V1 enforces one user budget and one managed-storage quota. New users, including administrators, default to $5.00 per day and 5,000,000,000 bytes. Administrators can change account defaults, explicitly apply them to selected/default-following users, and override individual users.

Budget periods are derived from a daily, weekly, or monthly IANA-time-zone schedule plus an epoch. No reset job zeros counters. `users.startNewBudgetPeriod` increments the epoch while preserving history.

There are no monetary reservations or pending-byte reservations. Admission strongly reads committed current-period spend and rejects only when the user is already at/over a finite limit. Accepted work may finish. Concurrent work can cause visible, forgiven overdraft; it creates no debt and does not affect the next period. Request status never consumes budget.

### 5.1 Read commands

| Command             | Input                                             | Output                                           |
| ------------------- | ------------------------------------------------- | ------------------------------------------------ |
| `usage.summary`     | `scope=self                                       | user                                             | all`, `period?`           | budget/storage cards, totals, quality, reset, per-user rows for all |
| `usage.timeseries`  | scope, dates, `grain=day                          | hour`                                            | cost/token/tool buckets   |
| `usage.breakdown`   | scope, dates, `groupBy=user                       | project                                          | agent                     | model                                                               | meter` | ranked aggregates |
| `usage.requests`    | scope, period/date/status/quality filters, cursor | redacted request rows                            |
| `usage.request`     | `requestId`                                       | request aggregate plus ordered model/tool events |
| `usage.export`      | filters, `format=jsonl                            | csv`                                             | short-lived scoped S3 URL |
| `resources.summary` | scope                                             | cost, storage, counts, quality                   |
| `storage.list`      | scope and filters                                 | managed object metadata                          |
| `defaults.get`      | none                                              | admin-only account defaults                      |
| `prices.list`       | filters/effective instant                         | effective rates and sources                      |

Normal users are forced to self scope. Administrators use the same response/component shapes for self, a selected user, or all users.

### 5.2 Mutation commands

| Command                      | Authorization | Purpose                                                       |
| ---------------------------- | ------------- | ------------------------------------------------------------- |
| `defaults.update`            | admin         | update new-user defaults                                      |
| `defaults.apply`             | admin         | apply to users-still-on-defaults or selected users            |
| `users.setLimits`            | admin         | update budget schedule/limit and storage limit with revision  |
| `users.startNewBudgetPeriod` | admin         | increment epoch with reason                                   |
| `usage.reconcile`            | admin         | best-effort append-only repair; never an admission dependency |
| `storage.beginUpload`        | owner         | bounded presigned POST; no pending quota                      |
| `storage.delete`             | owner/admin   | reference-check and delete a managed object                   |
| `prices.upsert`              | admin         | effective-dated rate                                          |

### 5.3 Usage events

Every completed cost-bearing component appends an immutable event under its request: model, embedding, Memory, Gateway, tool, Browser, Code Interpreter, Runtime, or adjustment. One DynamoDB transaction conditionally puts the deterministic event and increments request/user-period/time-bucket projections. A duplicate callback charges once. Corrections are positive/negative adjustment events, never rewrites.

Events carry native quantities, pinned rate keys, `applicationCostMicroUsd`, `budgetCostMicroUsd`, and `quality=measured|estimated|reconciled|unpriced`. Unknown is never displayed as free. Prompts, responses, tool arguments/results, and credentials are absent.

Application attribution is the immediate budget authority. AWS billing is a delayed account reconciliation and may remain unattributed; it cannot create user debt.

### 5.4 Storage

The byte quota covers product-owned S3 attachments, skills, schemas, exports, and user/project files. It excludes AgentCore Memory internals, logs, DynamoDB, token vaults, and AWS-managed tool internals. S3 object notifications idempotently maintain a manifest and byte projection. Concurrent accepted uploads may create overage; objects remain and later uploads stop until deletion or a limit increase.

## 7. Integration, credential, and Gateway API

The product vocabulary is intentionally smaller than the AWS vocabulary:

- **Integration**: a usable external API/tool definition and its AgentCore Gateway target.
- **Credential**: an AgentCore Identity credential-provider configuration. Its secret is never in DynamoDB.
- **Connection**: a user's OAuth authorization-code grant held in the AgentCore token vault.
- **Grant**: permission for an agent/project to use an integration.

### 7.1 Credential scopes

| Scope   | Appropriate auth                    | Target shape                                                           |
| ------- | ----------------------------------- | ---------------------------------------------------------------------- |
| user    | OAuth authorization code            | one shared target; token vault binds token to workload identity + user |
| project | API key or OAuth client credentials | one target/provider for the project                                    |
| account | API key or OAuth client credentials | one shared target/provider                                             |

Static per-user API keys are not the default. An AgentCore Gateway target binds a credential provider, so a personal static key generally requires a dedicated provider **and target**. The API may support `scope=user` by creating both and protecting the target with policy, but the UI warns about the extra resource and recommends OAuth when available.

### 7.2 Metadata commands

| Command                    | Authorization                                         | Purpose / AWS mapping                                                                                  |
| -------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `credentials.list`         | owner by scope, admin; auditor sees redacted metadata | list app records and verify AgentCore provider existence                                               |
| `credentials.get`          | same                                                  | metadata, ARN/name, auth type, health; never a secret                                                  |
| `credentials.deletePlan`   | owner/admin                                           | references and affected targets/grants                                                                 |
| `credentials.delete`       | owner/admin                                           | detach/replace target first, then `DeleteApiKeyCredentialProvider` or `DeleteOauth2CredentialProvider` |
| `integrations.list`        | scope reader                                          | integration/target health and granted agents                                                           |
| `integrations.get`         | scope reader                                          | normalized configuration and sync state                                                                |
| `integrations.validate`    | creator                                               | parse/fetch schema, validate host/auth/tool names; no mutation                                         |
| `integrations.create`      | project owner/editor or admin                         | provider dependency, `CreateGatewayTarget`, app binding record                                         |
| `integrations.update`      | owner/admin                                           | `UpdateGatewayTarget` with optimistic revision                                                         |
| `integrations.synchronize` | owner/admin                                           | `SynchronizeGatewayTargets`; poll normalized status                                                    |
| `integrations.test`        | authorized user                                       | invoke a read-only selected tool with a timeout; returns redacted diagnostics                          |
| `integrations.deletePlan`  | owner/admin                                           | grants, agents, credentials, schema objects affected                                                   |
| `integrations.delete`      | owner/admin                                           | remove grants/policy, delete target, retain audit tombstone                                            |
| `grants.list`              | project reader                                        | integrations usable by a project or agent                                                              |
| `grants.set`               | project owner/editor or admin                         | update binding plus Gateway policy/rule as one saga                                                    |
| `grants.delete`            | project owner/editor or admin                         | deny first, then remove binding                                                                        |

`integrations.create` accepts a normalized target, not the full AWS union:

```json
{
  "scope": { "type": "project", "id": "..." },
  "displayName": "Jira",
  "kind": "openapi",
  "schema": { "source": "inline|url|s3", "value": "...", "sha256": "..." },
  "auth": { "credentialId": "...", "mode": "oauthAuthorizationCode" },
  "network": { "allowedHosts": ["api.atlassian.com"] },
  "toolAllowlist": ["searchIssues", "getIssue"]
}
```

V1 supports OpenAPI, remote MCP server, Lambda, API Gateway stage, and AgentCore connector target configurations. Console-only integration templates are not treated as an API dependency. Schema bodies above a small inline limit are stored in the shared S3 bucket by presigned upload; DynamoDB keeps only URI, hash, size, and media type.

### 7.3 Secret commands

These use `POST /credential-secrets`, not `/rpc`:

```json
{
  "v": 1,
  "operation": "apiKey.create",
  "requestId": "...",
  "idempotencyKey": "...",
  "metadata": {
    "scope": { "type": "project", "id": "..." },
    "displayName": "Service Jira token",
    "placement": { "in": "header", "name": "Authorization", "prefix": "Basic " }
  },
  "secret": { "value": "..." }
}
```

Supported operations:

| Operation            | Secret fields                              | AgentCore call                                                 |
| -------------------- | ------------------------------------------ | -------------------------------------------------------------- |
| `apiKey.create`      | `value`                                    | `CreateApiKeyCredentialProvider` with mandatory ownership tags |
| `apiKey.rotate`      | `value`                                    | `UpdateApiKeyCredentialProvider`                               |
| `oauthClient.create` | `clientId`, `clientSecret?`, vendor/config | `CreateOauth2CredentialProvider`                               |
| `oauthClient.rotate` | `clientSecret` and allowed config          | `UpdateOauth2CredentialProvider`                               |

The response contains only the application `credentialId`, provider ARN/name, callback URL where supplied by AgentCore, revision, and status. It cannot contain the secret, a hash of the secret, or an AWS SDK request echo.

Required AgentCore tags:

```text
app = agentcore-chat
environment = <stack environment id>
managed-by = agentcore-chat
resource-id = <application UUID>
scope-type = account|project|user
scope-id = <opaque stable id>
owner-sub = <Cognito sub, when user-owned>
project-id = <project id, when project-owned>
```

Tags support discovery and drift repair, but DynamoDB binding records own display metadata, authorization, references, and revisions. List operations first query authorized binding records, then batch-resolve AWS state; they never list the whole account and filter only in the browser.

AgentCore supports request/resource-tag IAM conditions for credential providers. The broker role still owns these calls in v1 because it gives one authorization path, protects secrets from browser extensions inspecting AWS SDK requests, and avoids distributing broad control-plane credentials. Direct browser credential creation can be reconsidered later without changing the product API.

### 7.4 OAuth user connection flow

OAuth application client setup is administrative; user consent is not.

1. Admin creates the OAuth client/provider and registers the callback URL issued by AgentCore Identity with the vendor.
2. Admin creates one Gateway target using `OAUTH` + `AUTHORIZATION_CODE`, the provider ARN, reviewed scopes, and the application's public return URL.
3. A user clicks **Connect**, or a tool invocation needs a token.
4. `connections.begin` invokes a configured harmless probe through the same delivery path as the real integration (Gateway for Gateway targets; Identity from the harness for interpreter-only credentials). If consent is needed, it returns the AgentCore authorization URL. If no harmless probe exists, the UI labels the integration **Connect on first use** and the first real tool call starts this flow.
5. The browser opens that URL. After vendor consent, AgentCore redirects to the static app return URL with the short-lived `session_id`/session URI.
6. The reloaded app validates its current Cognito session and calls `connections.complete` with only the session URI. The broker derives the Cognito `sub` from the verified token and calls `CompleteResourceTokenAuth`; it never trusts a body-supplied user ID.
7. The UI retries the original action. AgentCore stores and refreshes the downstream token keyed to workload identity and user.

Commands:

| Command                   | Input                                   | Behavior                                                                            |
| ------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------- |
| `connections.begin`       | `integrationId`, `forceAuthentication?` | invokes the configured same-path auth probe; returns connected or authorization URL |
| `connections.complete`    | `sessionUri`                            | session-binds the current Cognito user through `CompleteResourceTokenAuth`          |
| `connections.test`        | `integrationId`                         | harmless authenticated probe; authoritative connection status                       |
| `connections.reauthorize` | `integrationId`                         | same as begin with forced authentication                                            |

There is no generic `connections.disconnect` promise in v1 because AgentCore exposes provider management but not a universal per-user downstream-token revocation operation. The UI links to the vendor's grant-revocation page where known and can disable the app-side grant immediately. Deleting a shared OAuth provider is an administrative, all-users operation. An AgentCore consent portal is intentionally not created in v1: Cognito already authenticates this app and the modal plus callback flow provides the same product surface with fewer resources.

### 7.5 Jira, OneDrive, and AWS examples

**Jira Cloud**: prefer the built-in Atlassian OAuth provider with authorization-code flow and a shared OpenAPI target. Each user consents to Jira; no Jira secret enters DynamoDB. For a service credential, accept email + API token, encode `email:token` as the single stored value, and configure the target to inject `Authorization: Basic <value>` at project/account scope.

**OneDrive**: use the built-in Microsoft OAuth provider and a Microsoft Graph OpenAPI target. Personal OneDrive access is authorization-code/user scope. App-only access uses client credentials and an account/project-scoped credential. There is no “OneDrive API key” field.

**AWS/S3**: never ask a user to paste long-lived AWS access keys into an agent. Use the code interpreter/harness execution role for shared access, or assume a narrowly scoped project role for delegated access. The shared application bucket is used only for schemas, attachments, exports, and optional billing reconciliation objects; it is not the source of chat state.

### 7.6 Code interpreter access

An agent receives only integration grants resolved for `{user, project, agent}`. Preferred access is through Gateway tools. If arbitrary code must call an API, the harness retrieves the credential from AgentCore Identity just-in-time and injects it into the isolated interpreter process/session, not into the prompt, memory, event body, or logs. OAuth access tokens are preferred because they are scoped and short-lived. Static keys remain inside AgentCore Identity and the execution sandbox boundary.

## 8. Agent and chat APIs affected by these controls

`agents.resolve` is an internal broker operation that builds one immutable invocation envelope:

```json
{
  "userSub": "...",
  "projectId": "...",
  "agentId": "...",
  "actorId": "<escaped-user-sub>/<project-id>",
  "model": { "id": "...", "priceVersion": "..." },
  "usage": { "periodId": "...", "requestId": "...", "priceCatalogRevision": 1 },
  "integrations": [
    { "integrationId": "...", "gatewayTargetId": "...", "allowedTools": [] }
  ],
  "configRevision": 1
}
```

`actorId` identifies memory ownership (`user/project`), not agent configuration. The `agentId` selects the configuration within that scope. Each persistent agent/configuration is one managed Harness; Memory, Gateway, Browser, Code Interpreter, roles, and the deployment package remain shared. Invocation overrides are reserved for unsaved experiments. This preserves native Harness versioning, events, and status without inventing a configuration store in Memory.

`POST /chat` input contains only `projectId`, `agentId`, `sessionId?`, `requestId`, `message`, and attachment references. The broker validates membership, model status, grants, and committed user spend; idempotently accepts the request; invokes the Harness; and streams normalized events:

```text
message.delta
tool.started
tool.completed
oauth.required
usage.event
usage.summary
error
done
```

Each completed metered component appends an idempotent usage event immediately. Terminal request status is operational only. A missing finalizer may leave a stale request but cannot reserve or strand budget.

## 9. Minimal DynamoDB additions

One physical table remains sufficient. Add these logical records to the existing user/project/agent/model/usage design:

| PK                         | SK                            | Purpose                                                                   |
| -------------------------- | ----------------------------- | ------------------------------------------------------------------------- |
| `CREDENTIAL#<id>`          | `CONTROL`                     | provider ARN/name, scope, kind, status, revision; no secret               |
| `INTEGRATION#<id>`         | `CONTROL`                     | Gateway/target IDs, normalized config, schema reference, status, revision |
| `PROJECT#<id>`             | `INTEGRATION#<id>`            | project listing/binding                                                   |
| `AGENT#<id>`               | `GRANT#<integrationId>`       | allowed tools and grant revision                                          |
| `ACCOUNT#CONTROL`          | `USAGE_DEFAULTS`              | $5 daily/5 GB defaults, schedule, revision                                |
| `USER#<sub>`               | `PERIOD#<periodId>`           | committed user cost/quantity projection; no reservation                   |
| `REQUEST#<requestId>`      | `CONTROL`                     | immutable attribution plus operational status/aggregate                   |
| `REQUEST#<requestId>`      | `EVENT#<timestamp>#<eventId>` | immutable component/adjustment event                                      |
| `USER#<sub>`               | `OBJECT#<objectId>`           | managed S3 object manifest                                                |
| `USER#<sub>`               | `STORAGE#SUMMARY`             | rebuildable committed byte projection                                     |
| `PRICE#<provider>#<model>` | `EFFECTIVE#<instant>`         | immutable/effective-dated rates                                           |
| `IDEMPOTENCY#<userSub>`    | `<command>#<key>`             | request hash + retained result                                            |

The overloaded listing index includes project-to-integrations and scope-to-credentials. High-volume usage events are sharded by a stable scope hash and summarized transactionally so dashboard reads do not scan raw events.

## 10. AWS operation map

| Product command                  | Primary AWS operations                                                                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users.*`                        | Cognito `AdminCreateUser`, `AdminGetUser`, `ListUsers`, group APIs, enable/disable/reset/sign-out/delete + DynamoDB transactions                    |
| `defaults.*` / `users.setLimits` | DynamoDB revisioned writes                                                                                                                          |
| `usage.*`                        | DynamoDB event/projection queries; S3 export; optional CUR/Cost Explorer reconciliation                                                             |
| `storage.*`                      | DynamoDB ownership/byte projections + bounded S3 presign/delete                                                                                     |
| secret operations                | AgentCore `Create/UpdateApiKeyCredentialProvider`, `Create/UpdateOauth2CredentialProvider`                                                          |
| credential delete                | AgentCore provider delete after dependency plan                                                                                                     |
| `integrations.*`                 | `Create/Get/List/Update/DeleteGatewayTarget`, `SynchronizeGatewayTargets`, S3 schema objects                                                        |
| `connections.complete`           | AgentCore data-plane `CompleteResourceTokenAuth`                                                                                                    |
| `connections.begin/test`         | same-path probe: authenticated Gateway `tools/call` for Gateway integrations, or harness `GetResourceOauth2Token` for interpreter-only integrations |
| `grants.*`                       | DynamoDB + AgentCore Gateway Policy/Rule operations                                                                                                 |
| `/chat`                          | strongly consistent user spend check + idempotent request + Harness invocation + component usage events                                             |

CloudFormation creates stable platform resources: Cognito, API, broker function/role, DynamoDB table, shared S3 bucket, schedules, log groups, and stable AgentCore primitives supported declaratively. Day-to-day users and integrations are application state and use the service APIs above, not CloudFormation stack updates. This avoids one stack operation per user/credential while retaining drift-safe infrastructure.

## 11. Implementation order and acceptance tests

1. Implement the common RPC parser, Cognito context, capability resolver, idempotency, optimistic revisions, and audit record.
2. Implement `session.get`, user lifecycle, account defaults, user limit snapshots, and reset schedules.
3. Implement committed-spend admission plus idempotent model/cache/embedding/tool events and projections.
4. Implement API-key credential route with log-leak tests, then OAuth client administration.
5. Implement integration validate/create/sync/test/delete sagas.
6. Implement OAuth authorization-code session binding and forced reauthorization.
7. Add grants to invocation resolution and expose integration tools to the shared harness.

Required tests:

- A caller cannot name another `userSub`, raise their own budget, or assign their own global role.
- Block is effective in DynamoDB before Cognito disable completes; enable is the reverse.
- Week/month boundaries are correct across DST and multiple IANA zones; no scheduled reset is required.
- A manual reset creates a new epoch and preserves old counters/events.
- Concurrent requests may produce measured overdraft; both accepted requests finish, later work stops, and no overdraft carries into the next period.
- A lost finalizer leaves no reserved amount and cannot block later work below the limit.
- Duplicate component events are idempotent; late positive/negative adjustments update projections once.
- New users receive $5 daily and 5 GB; default changes affect only the explicitly selected population.
- Concurrent accepted uploads may exceed storage; neither object is deleted and later uploads stop until resolved.
- Cache read/write and embedding counters select the correct effective price dimensions.
- `/credential-secrets` body/secret is absent from API Gateway logs, Lambda logs, X-Ray annotations, errors, and responses.
- Credential/integration list calls cannot discover another project's records even if AgentCore contains them.
- Creating a target and failing the binding write is detected and reconciled by tags; delete denies use before destructive cleanup.
- OAuth completion rejects an expired session URI, a logged-out browser, and a different Cognito user.
- One user connecting Microsoft or Atlassian does not expose their token or connection to another user.
- Revoking a vendor grant produces a clear reauthorization result; the UI never reports a stale projection as authoritative.
- A code-interpreter run can use an allowed integration but cannot print persisted long-lived credentials through normal tool output/logging.
- CloudFormation deployment, application-admin login, member invite, project/agent creation, budget exhaustion, credential rotation, and full cleanup pass against the `eaap` profile in a disposable stack.

## 12. Explicit non-goals for v1

- Direct browser access to DynamoDB or Cognito administration.
- Treating tags as the sole authorization database.
- A custom secret store or secrets in memory events.
- Arbitrary rolling budget windows.
- Claiming immediate application attribution is identical to the AWS invoice.
- One harness per agent configuration by default.
- Long-lived AWS access keys entered in the UI.
- A generic OAuth “disconnect” button that AgentCore/vendor APIs cannot actually honor.

## 13. Primary AWS references

- AgentCore Gateway target authorization: <https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-building-adding-targets-authorization.html>
- OpenAPI Gateway targets: <https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-schema-openapi.html>
- OAuth session binding: <https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/oauth2-authorization-url-session-binding.html>
- `CompleteResourceTokenAuth`: <https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_CompleteResourceTokenAuth.html>
- AgentCore Identity tagging and tag-based access: <https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/identity-tagging.html>
- AgentCore IAM actions and condition keys: <https://docs.aws.amazon.com/service-authorization/latest/reference/list_bedrock-agentcore.html>
