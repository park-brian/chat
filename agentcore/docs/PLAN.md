# AgentCore Chat: implementation plan

> Historical design exploration. The authoritative Runtime-only product plan and current implementation map are in [ARCHITECTURE.md](./ARCHITECTURE.md). This document includes superseded Harness/Lambda proposals and must not be used as a current runbook.

**Backend amendment (2026-09-22):** [RUNTIME-DECISION.md](./RUNTIME-DECISION.md) supersedes this plan's Lambda/API Gateway backend topology. The product contract and AWS resource ownership remain, but the target trusted boundary is one AgentCore CodeZip Runtime. Existing Lambda-specific passages below are migration history until rewritten. [STATUS.md](./STATUS.md) distinguishes deployed behavior from the target.

Status: target architecture; [STATUS.md](./STATUS.md) records the implemented, live-verified slice
Verified against the AWS SDK and AWS documentation on 2026-09-22

Execution details and the verified `eaap` account baseline are in [IMPLEMENTATION.md](./IMPLEMENTATION.md). The exact browser-facing commands, request/response shapes, credential flows, and AWS operation mapping are in [API-CONTRACT.md](./API-CONTRACT.md). The normative cost, budget, reset, storage, and reconciliation contract is [USAGE-RESOURCES.md](./USAGE-RESOURCES.md).

## 1. Executive decision

Build `agentcore/index.html` as a genuinely buildless, single-file SolidJS browser application backed by a minimal AWS-native product API. The production entry URL defaults to `https://park-brian.github.io/chat/agentcore/`; it remains a deployment parameter so forks and other environments can use their own URL. Amazon Cognito managed login is the application's sign-in surface: a User Pool authenticates the human, and an API Gateway REST API Cognito User Pool authorizer validates an application-scoped access token. Normal application sessions receive no AWS credentials.

Use one managed Amazon Bedrock AgentCore Harness per persistent agent/configuration, while sharing one AgentCore Memory, one AgentCore Gateway, the execution roles, and skill storage. Memory actors represent user-scoped projects, not agents: `actorId = user/project`, with `main` as every user's implicit default project. Each agent has one thin DynamoDB authorization binding to its project/model; the actual model, prompt, skills, tools, limits, truncation settings, status, and versions live natively on the Harness and are not copied into an application agent document.

This is conceptually cleaner than keeping one shared Harness and storing full agent configurations as Memory events. AgentCore gives Harnesses first-class create/update/status/version APIs, while Memory events have no update/CAS operation and would require a custom configuration database protocol. Invocation overrides remain useful for temporary experiments and one-off tests, but are not the durable configuration mechanism.

The browser can deploy and repair the foundation stack through the CloudFormation JavaScript SDK, but only in an explicit **deployment administrator** mode using separately entered short-lived AWS credentials. Cognito users—including application administrators—use the same deliberately small product API for users, budgets, models, projects, agents, credentials, Gateway integrations, Memory reads, and streamed chat. Their Cognito group changes authorization, not the implementation path. This gives every invariant one trusted owner and avoids a second, direct-admin path that could create an agent without its model policy, user-limit checks, tags, or audit record. Normal sessions make no direct AWS service calls. Raw credentials use a dedicated non-logging API route that passes them directly to AgentCore Identity; skills and large schemas use broker-issued S3 presigned requests. No CDK, general-purpose application server, or custom agent loop is required. The one Lambda is a command, authorization, and metering boundary—not an agent backend.

The design deliberately delegates the expensive parts to AgentCore:

- Each managed Harness owns one persistent agent configuration plus the agent loop, streaming, model calls, tool execution, context truncation, and memory integration.
- Memory owns actors, chat sessions, messages, and project-scoped long-term memories.
- Gateway owns integrations, credentials, tool discovery, and policy enforcement.
- Browser and Code Interpreter provide the general-purpose execution tools.
- CloudFormation owns durable infrastructure.
- S3 is shared object storage for skill directories and large gateway schemas; the browser does not create a second skill registry on top of it.
- Solid signals hold only transient view state. IndexedDB is not part of the new architecture.

This model fits the default adjustable AgentCore Runtime quota of 1,000 agents per account. It is appropriate for a personal/team chat product with tens or hundreds of configured agents. A single shared Harness with per-invocation overrides becomes preferable only if configurations are ephemeral, extremely numerous, or expected to approach the account's Runtime-agent quota.

```text
single-file browser UI
├─ Cognito managed login ── scoped User Pool access token ── REST API Cognito authorizer
├─ CloudFormation ── Cognito, shared Memory/Gateway, roles, one table, one thin Lambda, skill bucket
├─ deployment admin mode ── entered temporary credentials ── CloudFormation bootstrap/update/recovery
├─ all Cognito roles ── Product API ── users/models/projects/agents/budgets/usage
├─ write-only credential route ── broker ── AgentCore Identity credential providers
├─ AgentCore control ── one Harness per app agent; tagged credentials/targets/policies
└─ Harness(agent configuration, trusted user/project actor, agent-prefixed session)
   ├─ Memory ── project knowledge and chat events
   ├─ Gateway → Policy → Identity credential → Google/Jira/API
   ├─ Browser
   └─ Code Interpreter → temporary IAM role credentials → S3/AWS
```

## 2. Feasibility findings

### 2.1 Browser SDK support

The installed AWS packages explicitly provide Node.js, Browser, and React Native builds:

- `@aws-sdk/client-bedrock-agentcore@3.1137.0`
- `@aws-sdk/client-bedrock-agentcore-control@3.1137.0`
- `@aws-sdk/client-cloudformation@3.1137.0`
- `@aws-sdk/client-cognito-identity@3.1137.0`
- `@aws-sdk/client-cognito-identity-provider@3.1137.0`
- `@aws-sdk/credential-provider-cognito-identity@3.972.70`
- `@aws-sdk/client-iam@3.1137.0`
- `@aws-sdk/client-s3@3.1137.0`
- `@aws-sdk/client-secrets-manager@3.1137.0`
- `@aws-sdk/client-sts@3.1137.0`

The data-plane client contains `InvokeHarness`, Memory event/session/actor operations, Browser, and Code Interpreter operations. The control-plane client contains Harness, Memory, Gateway, GatewayTarget, credential-provider, and policy CRUD.

The UI must import only the bare clients and commands it actually uses. Do not use the aggregated service clients.

### 2.2 CORS conclusion

Direct browser access is feasible. Preflight requests were tested against `us-east-1` with the headers required by SigV4 (`authorization`, `content-type`, `x-amz-date`, `x-amz-security-token`, and `x-amz-user-agent`). The following routes accepted browser preflights:

| Surface                 | Tested route                             | Result  |
| ----------------------- | ---------------------------------------- | ------- |
| Harness invocation      | `POST /harnesses/invoke`                 | allowed |
| Memory events           | `POST /memories/{id}/events`             | allowed |
| Memory retrieval        | `POST /memories/{id}/retrieve`           | allowed |
| AgentCore control plane | `POST /harnesses` and `/memories/create` | allowed |
| CloudFormation          | regional `POST /` Query API              | allowed |
| IAM                     | global Query API `POST /`                | allowed |
| STS                     | regional Query API `POST /`              | allowed |
| Secrets Manager         | regional JSON API `POST /`               | allowed |

The same service tests passed for `Origin: null`, which is the origin Chromium sends when `index.html` is opened from `file://`. This is useful endpoint evidence but no longer makes `file://` a supported authenticated application mode: Cognito requires a registered redirect URL, so production uses the GitHub Pages HTTPS URL and local development uses a registered `http://localhost` URL.

This proves that the service endpoints permit the relevant browser preflights. A signed integration smoke test is still required during implementation because a preflight cannot prove IAM authorization, response streaming, or every individual operation.

S3 object access is the surface whose CORS policy is controlled by us. The CloudFormation template will add an explicit bucket CORS rule for browser `GET`, `HEAD`, `PUT`, `POST`, and `DELETE` requests from the exact configured application origins. Do not use `*` now that authenticated use has explicit HTTPS/localhost origins.

### 2.3 CloudFormation from the browser

Use `CloudFormationClient` directly from the page for:

- `ValidateTemplate`
- `CreateStack`
- `DescribeStacks`
- `DescribeStackEvents`
- `UpdateStack`
- `DeleteStack`

Pass the template through `TemplateBody`; the planned template is safely below CloudFormation's inline template size limit. Stack creation/update requires `CAPABILITY_NAMED_IAM` because the template creates execution roles.

The infrastructure modal will render stack events while polling. It should stop polling on a terminal status and show the first useful failure reason. Treat `ValidationError: No updates are to be performed` as success.

The canonical template will be `agentcore/template.yaml`. To preserve a one-file runtime, the same template text will also be embedded in `index.html` inside a non-executable `<script type="text/yaml" id="infrastructure-template">` block. A test must assert that the embedded and standalone forms are identical.

### 2.4 Cognito login, application sessions, and bootstrap

The stack creates an `AWS::Cognito::UserPool`, public `AWS::Cognito::UserPoolClient`, resource server, domain, and default managed-login branding for OAuth/OIDC login, password reset, and tokens. The app client has no client secret and enables only authorization-code flow with `openid`, `email`, `profile`, and the application API access scope. A REST API Cognito User Pool authorizer requires that scope on authenticated methods and validates the access token. No Cognito Identity Pool or browser IAM role is needed for normal use.

The browser uses authorization code plus PKCE, not the implicit flow:

```text
ApplicationEntryUrl
  -> generate verifier, S256 challenge, state, nonce
  -> Cognito /oauth2/authorize
  -> clean registered callback URL?code=...&state=...
  -> verify state, exchange code at /oauth2/token
  -> validate nonce/issuer/audience/expiry claims locally
  -> call session.get with the access token
  -> API Gateway validates issuer/audience/expiry/signature
  -> construct only the product API client
```

Use native `fetch`, `crypto.getRandomValues`, and Web Crypto SHA-256 for this flow; do not add Amplify or a client-side auth framework. Decoded JWT claims are not trusted merely because they parse. Local state/nonce/issuer/audience/expiry checks catch protocol mistakes; the API authorizer is the server-side proof, and the broker derives `sub` and groups only from its verified context.

The Cognito token endpoint supports cross-origin browser calls. Access, ID, and refresh tokens remain in JavaScript memory only. Refresh at a bounded margin or on demand; on `invalid_grant`, clear state and restart login.

The PKCE verifier, OAuth state, nonce, deployment descriptor, and return route must survive the cross-origin redirect, so they may live briefly in `sessionStorage`. Delete them immediately after a successful or failed callback. They are not AWS credentials, but the verifier is still sensitive and must never enter a URL or log. Page reload after login intentionally starts a new authorization flow; the Cognito login cookie normally makes that redirect quick. No auth token is written to `sessionStorage`, `localStorage`, or IndexedDB.

The stack cannot create its own login path without an unauthenticated starting point. Bootstrap is therefore a separate, explicit route:

1. The operator opens the static page with no deployment descriptor and chooses **Bootstrap deployment**.
2. The modal accepts short-lived AWS credentials, Region, stack name, exact application URL/origins, Cognito domain prefix, and the first user's email. These credentials remain memory-only.
3. The page validates and creates the stack, waits for `CREATE_COMPLETE`, reads its outputs, and calls `AdminCreateUser` for the first user. Cognito sends the temporary-password invitation.
4. The page discards the bootstrap clients and credentials, then opens the stack's `ApplicationEntryUrl`. The first user completes the required password change in Cognito managed login.
5. The first user is added to `Administrators`. Subsequent users are invited from **Account -> Users** into `Members` by default; public self-sign-up is disabled.

`ApplicationEntryUrl` is a CloudFormation output that points at the one-file application with a non-secret deployment descriptor in its query string: Region, stack name, User Pool ID, app-client ID, Cognito domain, and product API URL. The app copies that descriptor to temporary callback state, removes it from the visible URL with `history.replaceState`, and starts PKCE. This solves static-host bootstrapping without a config service or second runtime file. Users bookmark the entry URL, not the clean callback URL.

Bootstrap IAM credentials are a separate break-glass/install mode and retain whatever authority their IAM principal already has. A Cognito login does not imply deployment authority. `Administrators`, `Members`, and `Auditors` are application authorization groups read from the validated token; all use the same product API and receive no AWS credentials. The product API derives `sub` and role from the authorizer context.

Every user belongs to exactly one global group. Admin role changes reconcile the exact group set with `AdminAddUserToGroup`/`AdminRemoveUserFromGroup`, followed by `AdminUserGlobalSignOut`; the UI states that already-issued JWTs remain effective until revocation/expiry and requires reauthentication before showing the new role.

## 3. Identity and AWS state model

### 3.1 Terminology

- **Harness / agent**: the AWS managed Harness resource containing one persistent agent configuration and agent loop. The UI uses the AWS resource directly rather than wrapping it in an application-agent record.
- **Project / actor**: one authorization-table project record plus a user-scoped Memory actor containing chats and shared project memory. The table owns membership; user limits and usage attribution stay user-scoped.
- **Session / chat**: one Memory session for one Harness inside a project actor; its ID is also the Harness `runtimeSessionId`.
- **Skill**: one native Harness skill source (`awsSkills`, `git`, `s3`, or `path`). S3 objects are storage, not a separate skill entity.
- **Integration**: the actual AgentCore Identity provider, Gateway target, Gateway policy, and Harness tool reference involved. The UI may create them in a wizard but does not persist a wrapper record.

### 3.2 Actor ID

The actor ID is the immutable Cognito User Pool `sub` claim plus project ID:

```text
<cognitoSub>/<projectId>
```

Example:

```text
8f14e45f-ea6d-4f67-9b32-6ee32f0f1f95/main
```

The UUID-shaped Cognito `sub` is already stable and uses AgentCore-compatible characters. Require project IDs to use `A-Z`, `a-z`, `0-9`, `_`, and `-`; validate the composed value against the AgentCore actor-ID contract and 255-character limit. Never use mutable email, username, display name, access-key ID, STS ARN, or a user-entered alias as the normal user component.

Read `sub` only from the token validated by Cognito/API Gateway. For an owned project, the actor is `<ownerSub>/<projectId>`; shared-project members use that same owner-scoped actor rather than creating a second copy. The browser sends a project key, never an authoritative `actorId` or `runtimeUserId`. The access Lambda loads the project, verifies membership, derives the actor from the stored immutable owner `sub`, and derives `runtimeUserId` from the authenticated caller `sub` before invoking Harness. Client-supplied values are ignored. The Harness ARN identifies the agent configuration; the actor identifies the project's Memory partition; `runtimeUserId` identifies the human for user-delegated credentials and audit.

This trusted derivation is required. AgentCore documents that `runtimeUserId` is opaque on the IAM path and does not itself prove the end-user identity, and AgentCore does not bind an arbitrary Memory actor ID to the authenticated caller. A direct member `InvokeHarness`/Memory permission would therefore allow actor substitution. Only the access Lambda role receives `InvokeHarness`, `InvokeAgentRuntimeForUser`, and member-facing Memory data permissions. Administrators manage Harnesses but the normal UI still uses the metered path for chat.

### 3.3 Project discovery and the default project

`main` is created lazily as an owned project on first access and always shown. The project list comes from the single authorization table's membership index, not from an account-wide `ListActors` scan. The access Lambda then reads the actor's native sessions and tagged Harnesses. This is the one intentional catalog record: project membership cannot be represented securely by Memory actors or tags.

Creating a project writes one `PROJECT` item and one owner `MEMBERSHIP` item. No chat, Harness, Memory event, S3 prefix, or stack is created until needed. Rename is display metadata only; the stable project key and actor ID never change. Archive is a project flag, not a second resource tree.

Project deletion is advanced and destructive: the access API checks owner/admin authority, lists tagged Harnesses plus actor sessions/events/records, shows the exact AWS resources, and deletes only after confirmation. Actor-prefix filtering remains discovery, never authorization.

### 3.4 Agent discovery

Agents are native Harnesses. Every Cognito role receives only the product API's exact project-authorized result after it paginates `ListHarnesses`, hydrates tags, and retains this stack plus `ac-chat:actor-id=<ownerSub>/<projectId>`. Administrators may select any project; members require owner/editor/viewer membership. The Harness name is the agent name; it is not duplicated in DynamoDB or Memory. Renaming a Harness is a create-copy-delete operation and is not presented as a cheap profile edit.

Create an agent with one `CreateHarness` call containing its full configuration and ownership tags, then poll `GetHarness` until `READY` or a terminal failure. Update with `UpdateHarness` and inspect history with `ListHarnessVersions`. AgentCore has no native archive operation, so the UI does not invent one; removal uses guarded `DeleteHarness`. No binding event, directory revision, or reconciliation database is required.

### 3.5 Harness ownership and configuration

The Harness stores the full native configuration:

- model and provider credential reference;
- system prompt;
- tools, Gateway references, and allowed tools;
- skills;
- the shared Memory ARN and retrieval configuration;
- truncation;
- maximum iterations, output tokens, and timeout;
- the foundation `before_invocation` and `after_invocation` Lambda hooks;
- the shared execution role and environment settings.

Read this state with `GetHarness`; write it with `CreateHarness`/`UpdateHarness`; show history with `ListHarnessVersions`. Do not duplicate those fields in Memory.

Harness names are the user-entered, AWS-validated agent names:

```text
<harness-name>
```

The returned Harness ID/ARN is used directly. Copying an agent to another project creates a new Harness from the source configuration and new actor tag; it does not share the old mutable Harness.

Do not automatically deduplicate identical configurations in version one. Shared-by-hash Harnesses require reference counting and immutable-update semantics; editing one agent could otherwise affect another. One Harness per agent is the cleanest mapping for code, versions, events, status, and deletion. If scale later demands deduplication, add immutable config-hash Harnesses as an explicit optimization.

Do not store raw OAuth client secrets, API keys, AWS credentials, or third-party model keys in tags or Harness fields. Store AgentCore Identity credential-provider ARNs only.

### 3.6 Chat state

- Derive `sessionKey` as the first 12 lowercase hex characters of `SHA-256(harnessId)`; it is reproducible from the native Harness and is not persisted separately.
- New chat: `a_<sessionKey>_<crypto.randomUUID()>`, for example `a_9f86d081884c_550e8400-e29b-41d4-a716-446655440000`. It is long enough for AgentCore and valid for the documented session pattern.
- List chats: ask the access API to authorize the project, then paginate `ListSessions(memoryId, derivedActorId)` and retain only IDs beginning `a_<selected sessionKey>_`.
- Load chat: the access API authorizes the project/session binding, then calls `ListEvents(memoryId, derivedActorId, sessionId, includePayloads: true)`.
- Send: post only project key, Harness ID, session ID, request ID, and the new message to the streaming access route. The Lambda derives actor/user IDs, checks committed user spend, idempotently accepts the request, invokes Harness, forwards the event stream, and records component usage as it becomes known.
- Resume: reuse the session ID. Harness memory restores configured recent/long-term context; do not resend the entire browser history unless a live integration test proves a provider-specific need.
- Branching is deferred. AgentCore Memory has branch support, but preserving the existing local branching UI would add code before the basic harness path is proven.

Because agents in one project share an actor, long-term memories are project knowledge by design. An agent that must not see project knowledge belongs in another project. The Harness still controls its own retrieval strategy and prompt.

The URL may hold navigational state (`region`, `stack`, `project`, `agent`, `session`), with `project=main` as the default. It is not the source of truth. Credentials live in memory only and disappear on reload.

## 4. Harness invocation

### 4.1 Persistent configuration versus invocation

Administrators and project owners/editors submit the same bounded agent draft to the product API. The broker authorizes the caller, resolves an active model-catalog key into a complete provider configuration, validates referenced skills/tool profiles, adds the shared execution-role/Memory/Gateway/hooks plus ownership tags, and calls `CreateHarness`. `UpdateHarness` follows the same projection and produces a native Harness version. The browser never supplies an execution-role ARN, credential-provider ARN, raw model union, hook target, actor ID, or ownership tag. This single path is what lets ordinary users create agents without receiving AgentCore control-plane permissions.

The persistent Harness configuration should normally include:

- model/provider and credential-provider ARN;
- system prompt;
- the shared Memory without a fixed actor ID;
- Gateway, Browser, and Code Interpreter tools;
- optional shell/file-operation policy;
- skills and `allowedTools`;
- truncation and execution limits.

Do not reconstruct this configuration from Memory on every send. Fetch it only when opening the Agent dialog or refreshing status.

### 4.2 Minimal invocation

An ordinary browser send is deliberately small:

```js
fetch(`${accessApi}/chat`, {
  method: "POST",
  headers: { Authorization: idToken, "Content-Type": "application/json" },
  body: JSON.stringify({
    projectKey,
    harnessId,
    sessionId,
    invocationId,
    text,
  }),
});
```

The Lambda's trusted call is the minimal `InvokeHarness` request shown above: Harness ARN, derived actor, derived runtime user, session, and message. The selected Harness supplies model, prompt, tools, skills, and limits. API Gateway uses a Cognito User Pool authorizer and Lambda proxy response streaming, so the browser still receives the native chat stream without a polling store or WebSocket service.

The SDK also supports per-invocation model, prompt, tool, skill, allowlist, and limit overrides. Reserve them for a bounded **Try without saving** action in the Agent dialog. If the user accepts the trial, persist the same values with `UpdateHarness`; normal chat never depends on overrides.

Browser and Code Interpreter use their AWS-managed defaults. Gateway uses the stack's Gateway ARN and IAM outbound authentication from the Harness execution role.

### 4.3 Streaming

Consume `response.stream` as an async iterable and handle only the event variants needed by the UI:

- `messageStart`
- `contentBlockStart`
- `contentBlockDelta`
- `contentBlockStop`
- `messageStop`
- `metadata`
- `hookEvent`
- `validationException`, `runtimeClientError`, and `internalServerException`

Content blocks can contain text, reasoning, tool use, and tool results. Render unknown union members as compact JSON details rather than failing.

The `metadata` event contains input, output, total, cache-read, and cache-write token counts plus end-to-end latency. Feed those values to the Usage modal immediately.

No client-side agent/tool loop is needed. Inline function tools are deferred because they would return execution responsibility to the browser and undermine the minimal-harness design.

### 4.4 AWS-native skill management

The selected Harness's `skills` array is the only skill-assignment record. The Skills dialog reads it from `GetHarness` and saves it through `UpdateHarness` using the service's native `awsSkills`, Git, S3, and path union shapes. It does not create a local skill ID, manifest, catalog event, attachment row, or derived capability object.

The shared S3 bucket is an ordinary versioned bucket. Users upload a valid AgentSkills directory and attach its `s3://bucket/key/` URI directly. The UI may browse `skills/`, preview `SKILL.md`, upload/replace objects, inspect native S3 object versions, and warn before deleting a prefix referenced by a managed Harness. S3 Versioning provides recovery; the application does not invent content-hash versions or a commit-marker protocol. A replacement at the same URI is naturally observed when AgentCore fetches that skill for a new Harness session.

AWS Skills are configured as native path/glob values. Because AgentCore exposes no skill-catalog list API, the dialog offers a few documented path shortcuts plus a raw path field; these are form conveniences, not persisted frontend metadata. Git credentials are AgentCore Identity provider references. Filesystem path skills remain advanced because their files must already exist in the Harness environment.

## 5. AWS infrastructure (`template.yaml`)

### 5.1 Parameters

- `ApplicationName` (default `chat`)
- `EnvironmentName` (default `dev`)
- `ApplicationUrl` (default `https://park-brian.github.io/chat/agentcore/`; exact HTTPS callback/logout/entry URL, no fragment or query; editable for another deployment)
- `AllowedUiOrigins` (default production origin `https://park-brian.github.io`; comma-delimited exact origins including optional localhost for S3/API CORS; an origin contains no path)
- `LocalCallbackUrl` (optional registered `http://localhost` development callback)
- `CognitoDomainPrefix` (globally unique in the Region; the UI proposes a normalized app/environment/account-suffix value)
- `MemoryRetentionDays` (default 30, allowed 3–365)
- `DefaultBudgetMicroUsd` (default `5000000`, or `0` for unlimited)
- `DefaultBudgetCadence` (default `daily`; `daily`, `weekly`, or `monthly`)
- `DefaultBudgetTimeZone` (default `UTC`; IANA time zone)
- `DefaultStorageLimitBytes` (default `5000000000`)
- `NoncurrentVersionRetentionDays` (default 30; bounds the cost of retained S3 object versions outside the active-object quota)
- `EnableScriptedTestModel` (default `false`; only disposable smoke stacks expose the test inference route)
- `ScriptedTestModelKey` (NoEcho, supplied only when the scripted route is enabled; generated anew for each disposable run)
- optional `PermissionsBoundaryArn`

### 5.2 Resources

1. Cognito login resources
   - `AWS::Cognito::UserPool` with email sign-in/verification, account recovery, public self-sign-up disabled, and deletion protection configurable by environment;
   - `AWS::Cognito::UserPoolClient` as a public client (`GenerateSecret: false`) with authorization-code OAuth only, `openid email profile` plus one application API access scope, exact callback/logout URLs, token revocation, and bounded token lifetimes;
   - one `AWS::Cognito::UserPoolResourceServer` defining the application API access scope used by the REST API authorizer;
   - `AWS::Cognito::UserPoolDomain` with managed-login version 2;
   - `AWS::Cognito::ManagedLoginBranding` using Cognito defaults so login works without app-owned authentication forms or assets.

2. Cognito application-authorization resources
   - fixed `Administrators`, `Members`, and `Auditors` User Pool groups;
   - exactly one global group per user, reconciled by the product API;
   - no Identity Pool, guest role, browser IAM role, or long-lived access key;
   - an API Gateway REST API `COGNITO_USER_POOLS` authorizer; each authenticated method requires the application access scope so Cognito access tokens are validated;

   The broker maps the verified group to its command capability set. Foundation update/delete re-enters deployment-administrator mode and requires separately entered temporary AWS credentials. No Cognito user receives `AdministratorAccess` or direct AWS service permissions.

3. `AWS::BedrockAgentCore::Memory`
   - one shared BYO Memory;
   - semantic and summarization strategies if supported by the selected region;
   - configurable retention;
   - tags for app/environment;
   - no fixed actor ID.

4. `AWS::BedrockAgentCore::PolicyEngine`
   - one shared Cedar engine;
   - account-managed encryption by default, optional KMS later;
   - tagged as a foundation resource;
   - policies are added dynamically, not embedded in the template.

5. `AWS::IAM::Role` for Gateway
   - trust `bedrock-agentcore.amazonaws.com`;
   - Policy evaluation actions (`AuthorizeAction`, `PartiallyAuthorizeActions`, and `GetPolicyEngine`);
   - logging/token-vault permissions needed by configured targets;
   - add target-specific AWS permissions later rather than a wildcard service policy.

6. `AWS::BedrockAgentCore::Gateway`
   - MCP protocol;
   - `AWS_IAM` inbound authorization;
   - the Gateway role;
   - the Policy Engine attached in `ENFORCE` mode;
   - no targets in the base template unless a sample target is useful for smoke testing.

7. `AWS::S3::Bucket` for skills and large OpenAPI/Smithy schemas
   - block all public access;
   - default encryption;
   - enable S3 Versioning for native recovery and expire noncurrent versions after the configurable retention period; the user quota counts current managed objects, while noncurrent versions remain separately billable until expiry;
   - CORS for presigned browser uploads/downloads from exact application origins;
   - retain by default on stack deletion to avoid losing authored skills.

8. `AWS::IAM::Role` for Harness
   - trust `bedrock-agentcore.amazonaws.com`;
   - model invocation;
   - shared Memory event/retrieval actions;
   - `bedrock-agentcore:InvokeGateway` on the shared Gateway;
   - managed Browser and Code Interpreter session/invoke actions;
   - token-vault reads for configured model/Gateway credential providers;
   - S3 read/list under the skill bucket;
   - CloudWatch Logs/metrics permissions required by harness observability.

9. Minimal access and metering boundary
   - one `AWS::DynamoDB::Table`, on-demand billing, point-in-time recovery, AWS-owned encryption, TTL only for genuinely disposable idempotency/export records, and one overloaded GSI;
   - one Node.js Lambda function with two API modes: ordinary JSON RPC and Lambda proxy response streaming for chat;
   - one Regional API Gateway REST API with a Cognito User Pool authorizer, exact-origin CORS, `/rpc`, `/credential-secrets`, and `/chat`; configure the `/chat` Lambda proxy integration with `ResponseTransferMode: STREAM` and the response-streaming invocation URI;
   - one Lambda execution role that alone can administer the application User Pool, project approved configuration into AgentCore control operations, invoke application Harnesses for users, pass the derived runtime user ID, issue project-scoped S3 presigned requests, read/write the authorization table, and read/write project-scoped Memory;
   - no periodic reconciliation resource initially; an administrator can run explicit usage/storage repair through the same Lambda, and a schedule is added only if measured missed events justify it;
   - optional SNS topic and one account-level AWS Budget as delayed financial backstops.

   Keep the Lambda inline in the CloudFormation template if the reviewed source and required runtime SDK clients remain comfortably within CloudFormation's inline-code constraints; otherwise use one deterministic deployment ZIP in the shared artifact bucket rather than adding functions. It contains no agent loop, prompt logic, model adapter, chat database, or secret store. Its responsibilities are limited to validated command projection, user/model/project policy, membership checks, actor derivation, committed-spend admission, idempotent usage/storage projections, native AWS calls, and stream forwarding.

The foundation template intentionally does **not** contain an `AWS::BedrockAgentCore::Harness`. Harnesses are native agent resources created by the broker after the stack exists. Do not create a Memory or stack per agent.

### 5.3 Outputs

- `HarnessExecutionRoleArn`
- `MemoryArn`
- `MemoryId`
- `GatewayArn`
- `GatewayId`
- `GatewayUrl`
- `PolicyEngineArn`
- `PolicyEngineId`
- `SkillsBucketName`
- `CognitoUserPoolId`
- `CognitoUserPoolClientId`
- `CognitoDomain`
- `CognitoIssuer`
- `CognitoAuthorizationEndpoint`
- `CognitoTokenEndpoint`
- `CognitoLogoutEndpoint`
- `AccessApiUrl`
- `AuthorizationTableName`
- `ApplicationEntryUrl`
- `Region`

After bootstrap, the page discovers resource outputs through `DescribeStacks`. Before authentication, the non-secret Cognito identifiers come from `ApplicationEntryUrl`; they may be held in temporary callback state but are never treated as credentials. The clean callback URL contains only the OAuth response parameters.

### 5.4 Why Harnesses are direct API resources

CloudFormation is not required to create a Harness. Both the installed control client and AWS's public API expose `CreateHarness`, `GetHarness`, `UpdateHarness`, `DeleteHarness`, and native Harness version listing.

Use CloudFormation for the low-churn shared foundation and the AgentCore control API for high-churn product objects. This boundary is cleaner because:

- creating or editing an agent does not update a shared stack;
- one failed agent change cannot roll back unrelated infrastructure;
- `UpdateHarness` remains the sole owner of Harness versions, avoiding CloudFormation drift;
- delete/duplicate operations map directly to native Harness actions;
- a user can create agents without receiving broad CloudFormation mutation permissions after initial setup;
- deterministic names and tags make interrupted creates repairable.

Putting each Harness in CloudFormation would require either one stack per agent or continuously rewriting a monolithic template. The first creates stack sprawl and slow lifecycle operations; the second creates concurrency, replacement, drift, and deletion hazards. `HarnessName` changes also require CloudFormation replacement. Native Harness state plus tags already provides the account inventory.

The tradeoff is that stack rollback and stack deletion do not manage direct-created Harnesses. Handle that explicitly:

- tag every Harness with the common application/stack namespace and exact non-secret actor ID;
- always call `DeleteHarness` with `deleteManagedMemory: false`, because Memory is shared and CloudFormation-owned;
- before deleting the foundation stack, enumerate tagged app Harnesses and block deletion while any remain;
- offer a separately confirmed **Delete app Harnesses, then stack** workflow;
- provide diagnostics that show unmanaged or mistagged Harnesses without adopting or deleting them automatically.

High-churn user-managed resources should likewise use their native control APIs:

- Harnesses and Harness endpoints;
- optional custom Code Interpreters and tightly templated IAM capability roles;
- API key/OAuth credential providers;
- Gateway targets and synchronization;
- optional Gateway policies;
- native Memory actors and events.

These remain AWS-account state but are not stack resources. This avoids regenerating a stack for every OAuth connection or agent edit and avoids putting secret values in templates or stack events.

If strict all-resource IaC is later required, the UI can generate a change set for non-secret target definitions. Credential material should still be created through AgentCore Identity, not embedded in CloudFormation parameters.

## 6. Credentials, policy, integrations, and code execution

### 6.1 Choose the narrowest credential path

| Need                                                | Credential mechanism                                                                 | Enforcement boundary                       | Recommended use            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------ | -------------------------- |
| Google/Jira/other SaaS                              | AgentCore OAuth or API-key provider attached to a Gateway target                     | Gateway Policy plus provider scope         | default                    |
| Authenticated remote MCP                            | AgentCore provider ARN placeholder in MCP headers, preferably routed through Gateway | Gateway Policy when routed through Gateway | default                    |
| Same-account S3/AWS API from code                   | temporary credentials from a custom Code Interpreter execution role (MMDS)           | IAM role and network mode                  | default for code           |
| Cross-account S3/AWS                                | scoped `sts:AssumeRole` from the Code Interpreter role                               | both roles' IAM policies and trust         | preferred over access keys |
| Non-Bedrock model key                               | credential-provider ARN in the Harness model config                                  | Harness/Identity access permissions        | default                    |
| Arbitrary external API directly from generated code | project-scoped custom Code Interpreter plus exact secret grants                      | IAM + network only; not Gateway Policy     | advanced/high risk         |

Never place plaintext credentials in Harness environment variables, prompts, skills, Memory events, URLs, tags, or browser storage. Non-secret settings such as API base URLs may be Harness environment variables.

For normal SaaS work, let the Code Interpreter transform data locally and let the agent perform I/O through Gateway tools. The credential stays in AgentCore Identity, Gateway injects it downstream, and the model/code never receives the raw value. A broad but typed OpenAPI target can still support Jira searches, issue edits, pagination, and batch orchestration without exposing the Jira token.

For S3, do not ask users for AWS access keys when an execution role or cross-account role is possible. A custom Code Interpreter receives short-lived role credentials through AgentCore's microVM metadata service and can use `boto3`, the AWS CLI, or an SDK. Scope access to exact buckets/prefixes and split read-only from read-write profiles.

### 6.2 The direct-secret code mode is intentionally exceptional

The user may explicitly bind an API key to a custom Code Interpreter so generated code can call an arbitrary public API. Support this only under an **Advanced: expose credential to code** disclosure:

1. store the key in an AgentCore API-key credential provider (or an external Secrets Manager secret reference);
2. create/select a project-specific custom Code Interpreter with public network access;
3. grant that interpreter's execution role `secretsmanager:GetSecretValue` on only the returned backing-secret ARN;
4. add a reviewed skill helper that reads the secret at execution time and places it in the child process only;
5. never echo the value and redact known secret values from displayed command output;
6. show that generated code can still print or exfiltrate the secret and require an exact confirmation.

This mode is not protected by AgentCore Gateway Policy, because arbitrary HTTP traffic from a public Code Interpreter does not traverse Gateway. Redaction is defense in depth, not a security boundary. Use a separate interpreter/role per project or capability profile; never give the shared default interpreter access to every secret.

Static AWS access-key pairs are not modeled as a single AgentCore API key. If legacy cross-account keys are unavoidable, store the complete JSON credential set in an external Secrets Manager secret and use the same advanced flow. The UI should strongly prefer role assumption and should not implement long-lived AWS keys in the MVP.

### 6.3 Policy is layered, not singular

The control UI must show these layers together:

1. **Cognito group / browser IAM role** — which account-level UI operations the human can request.
2. **Project membership** — which project/Harness that human may view, invoke, or edit.
3. **Harness tool declaration and `allowedTools`** — what the model can discover/call.
4. **Gateway Policy Engine** — default-deny Cedar authorization for every Gateway action and its typed inputs; forbid wins.
5. **Credential-provider access** — which workload/execution roles may retrieve which AgentCore Identity providers.
6. **Harness execution-role IAM** — Bedrock, Memory, Gateway, skills, and other AWS access.
7. **Code Interpreter execution-role IAM** — the AWS APIs code can call and exact secrets it can retrieve.
8. **Network mode** — sandbox, public, or VPC egress.

Skills and system prompts are guidance, not authorization. Tag filters are ownership/discovery, not authorization. AgentCore Policy currently governs Gateway calls; IAM and network controls govern Browser/Code Interpreter/shell behavior.

The foundation creates one Policy Engine and attaches it to the shared Gateway in `ENFORCE` mode. It also grants the Gateway role the Policy evaluation permissions required by AgentCore. Policies are created after the stack through product API commands because targets and project assignments change frequently. The UI starts with audited templates such as read-only, read/write, amount/field constrained, and deny-destructive, then validates the generated Cedar against the live Gateway schema before saving.

With the `AWS_IAM` tool Gateway authorizer, the Cedar principal is the assumed Harness execution-role ARN, not the human `sub` or `actorId`. Therefore:

- `actorId` must never be treated as a policy principal;
- shared roles can express capability classes but cannot distinguish two agents using the same role;
- project/agent isolation relies on trusted Harness configuration and `allowedTools` unless distinct execution roles are selected;
- human-to-project authorization remains in the access API; Gateway policy governs the agent's tool capability. If a future design requires end-user claims at each tool call, switch that path to JWT/OAuth identity propagation rather than treating `runtimeUserId` as a Cedar principal.

### 6.4 Resource tags and UI filtering

Use AWS resource tags only for ownership and discovery; do not turn them into a parallel record model. Apply the same minimal namespace to taggable Harnesses, credential providers, Gateway targets, policies, custom Code Interpreters, and optional endpoints.

```text
ac-chat:managed-by = agentcore-chat
ac-chat:stack      = <stack name>
ac-chat:actor-id   = <cognitoSub>/<projectId>   # omit for account-wide resources
```

Actor IDs are deliberately visible AWS identifiers in this design, so they must be stable non-secret aliases rather than email addresses or other sensitive identifiers. Never put secret material in tags. Region and account already scope API calls, and stack name separates installations.

Most AgentCore list operations do not accept tag filters and list summaries often omit tags. Discovery therefore uses:

1. paginate the resource-specific list API;
2. fetch tags with `ListTagsForResource` using a bounded concurrency pool (six is a good starting point);
3. require exact `managed-by` and `stack` matches;
4. treat a missing actor tag as account-wide and an exact actor tag as project-scoped;
5. cache `{arn, tags, observedUpdatedAt}` only for the page lifetime; Refresh clears it.

An untagged resource is **Unmanaged** and hidden from ordinary selectors. Account diagnostics can reveal it but must never adopt or delete it automatically. Harness and actor APIs are the primary indexes; tag scans associate native resources with the selected actor and protect stack deletion. Visibility does not grant runtime access: Gateway Policy and IAM remain the authorization boundaries.

### 6.5 Google, Jira, and generic integrations

For Google:

1. create a tagged `GoogleOauth2` provider;
2. show/copy its AgentCore callback URL for Google Cloud;
3. complete authorization through AgentCore Identity;
4. create a narrow OpenAPI Gateway target;
5. attach the provider, synchronize, add policies, then assign tools to selected Harnesses.

For Jira Cloud, prefer Atlassian OAuth when user delegation is needed; otherwise create a tagged API-key provider and a project-scoped OpenAPI target. Keep destructive operations in a separate target/tool group so a read-only policy can omit them cleanly.

AgentCore Gateway supports OpenAPI 3.0/3.1 and OAuth targets. Every exposed operation needs a simple `operationId`; flatten complex union schemas. Large specifications go in the skill/schema bucket; small specifications can be inline.

Do not depend on AWS console-only integration-provider templates, which AWS documents as unavailable through the API. The browser creates regular OpenAPI, MCP-server, connector, Lambda, API Gateway, or Smithy targets with `CreateGatewayTarget`. The first worked examples are Google Drive and Jira, but the form remains generic.

### 6.6 The smallest durable storage shape

Use exactly one on-demand DynamoDB table. It is not a second application database: Cognito remains the user directory; Harness remains the agent configuration; Memory remains chat and long-term memory; Gateway/Identity remain tools and credentials; S3 remains skill/schema blobs; CloudWatch remains detailed telemetry. The table stores only application policy and cross-service bindings that none of those services can own safely.

Use generic `PK`/`SK` keys, one overloaded GSI, and no streams:

| Item            | `PK`                   | `SK`                                             | Purpose                                                                                                   |
| --------------- | ---------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Account control | `ACCOUNT`              | `CONTROL`                                        | required default-user budget/reset/storage settings and policy revision; no enforced account budget       |
| User control    | `USER#<sub>`           | `CONTROL`                                        | application access plus snapshotted/overridden budget, reset, and storage limits; no profile or role copy |
| Project         | `PROJECT#<projectKey>` | `META`                                           | immutable owner `sub`, stable actor ID, display name, status                                              |
| Membership      | `PROJECT#<projectKey>` | `MEMBER#<sub>`                                   | `owner`, `editor`, or `viewer`; GSI maps `USER#<sub>` to projects                                         |
| Model           | `CATALOG#MODEL`        | `MODEL#<modelKey>`                               | approved Harness model template, status, safe tuning bounds, credential reference, revision               |
| Model price     | `CATALOG#MODEL`        | `MODEL#<modelKey>#PRICE#<meter>#<effectiveFrom>` | effective-dated integer rate, region/tier/cache dimensions, currency, source                              |
| Agent binding   | `AGENT#<harnessId>`    | `CONTROL`                                        | authoritative project/model binding, creator `sub`, lifecycle state; no prompt/tool/skill copy            |
| User period     | `USER#<sub>`           | `PERIOD#<periodId>`                              | committed application/budget cost, quantities, overdraft-derived fields                                   |
| Session binding | `SESSION#<sessionId>`  | `META`                                           | project, actor, Harness, creator `sub`, timestamps, TTL                                                   |
| Request         | `REQUEST#<requestId>`  | `CONTROL`                                        | idempotency, stable attribution, rate/config snapshots, aggregate, operational status                     |
| Usage event     | `REQUEST#<requestId>`  | `EVENT#<time>#<eventId>`                         | immutable component or adjustment event                                                                   |
| Managed object  | `USER#<sub>`           | `OBJECT#<objectId>`                              | S3 ownership/reference/size manifest                                                                      |
| Storage summary | `USER#<sub>`           | `STORAGE#SUMMARY`                                | rebuildable committed byte projection                                                                     |
| Usage rollup    | `SCOPE#<type>#<id>`    | `USAGE#<day>#<meter>`                            | compact reporting totals; no message content                                                              |

`projectKey` is an opaque UUID; its project item holds `<ownerSub>/<projectId>` as the AgentCore actor. Do not copy email, global Cognito role, prompts, messages, secrets, Harness configuration, Gateway schemas, or Cognito profile fields into this table. A User control row exists because immediate application suspension plus user budget/reset/storage limits are application facts that Cognito does not own; Cognito still owns identity, email, status, MFA, and global-group membership. `main` needs only a project and owner-membership item on first use.

One overloaded GSI is sufficient. Membership items use `GSI1PK=USER#<sub>`, `GSI1SK=PROJECT#<projectKey>#<role>`; agent bindings use `GSI1PK=PROJECT#<projectKey>`, `GSI1SK=AGENT#<harnessId>`; user-period summaries and requests use period/user sort keys for the combined Usage view. TTL is cleanup, not correctness. Point-in-time recovery protects policy, usage evidence/projections, storage manifests, membership, and bindings.

The MVP grants the browser **no direct DynamoDB access**. This is not a CORS limitation: an Identity Pool could vend credentials and DynamoDB IAM could restrict partition-key prefixes with `dynamodb:LeadingKeys`. The problem is semantic authorization. IAM cannot look up a project-membership row before authorizing another write, prove that a submitted membership role is not a self-promotion, restrict user-limit/default changes to administrators, verify that a price came from the trusted catalog, or distinguish a real usage/storage increment from one fabricated by the page. DynamoDB condition expressions do not solve this because the caller supplies them. Sending these low-volume operations through the already-required broker is less code and a much smaller permission surface.

If a later product requirement introduces durable, non-authoritative personal preferences, add broker commands for only `PK=USER#<sub>`, `SK=PREF#<name>` items with an attribute allowlist. Prefer URL or in-memory UI state if preferences do not need persistence; that keeps the table small and entirely service-written.

### 6.7 Product command boundary and authorization ownership

The frontend has one product interface: authenticated `POST /rpc` commands plus streaming `POST /chat`. Reads are commands too so the backend can return complete view rows instead of forcing the single-file page to join Cognito, DynamoDB, Harness, and usage data with N+1 calls. The operation discriminator is allowlisted; there is no generic AWS proxy and no caller-supplied command name, ARN, role, actor, price, or provider union.

The command groups are deliberately small:

| Group    | Representative commands                                                                             | Authority                                                                       |
| -------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Session  | `me.get`                                                                                            | any authenticated, active user                                                  |
| Users    | `users.list`, `users.invite`, `users.setRole`, `users.setAccess`, `users.setBudget`, `users.delete` | administrator only                                                              |
| Models   | `models.list`, `models.create`, `models.update`, `models.setStatus`, `models.addPrice`              | list active: any user; mutate: administrator                                    |
| Projects | `projects.list`, `projects.create`, `projects.update`, membership commands                          | create: member/admin; membership: owner/admin                                   |
| Agents   | `agents.list/get/create/update/delete/try`                                                          | read: project viewer; mutate: owner/editor/admin                                |
| Sessions | `sessions.list/get/delete`                                                                          | project member/admin, with destructive actions owner/editor/admin               |
| Usage    | `usage.me`, `usage.project`, `usage.account`, exports                                               | own/project role/admin as appropriate                                           |
| Chat     | streamed send/stop                                                                                  | active user with project access and committed user spend below the finite limit |

There are two administrator identities with different purposes. Deployment-administrator credentials can create/update/delete the foundation and recover a broken Cognito configuration; they are entered only for that explicit mode. A Cognito `Administrators` user is an application administrator: the token authorizes administrator product commands but does not grant general deployment or AWS control-plane access.

Authorization has four non-overlapping owners:

1. **Cognito groups** decide the coarse application role: administrator, member, or auditor. Global role is never copied into DynamoDB.
2. **User control + project membership + agent binding** decide whether this active `sub` may operate on this project/Harness. Administrator may operate across projects; owner manages members; editor manages agents and chat; viewer may chat/read. Explicit deny, suspended user, archived project, blocked model, and deleting/error agent states win.
3. **Model catalog, Harness configuration, execution-role IAM, Gateway Cedar, credential-provider scope, and network mode** decide which model and capabilities an authorized agent may use. The Gateway principal on the default IAM path is the Harness execution identity, not the human actor; use fixed capability-profile roles when two agents need different Gateway/secret privileges.
4. **Native Harness limits + committed user-period spend** decide whether a new invocation may start and bound the exposure of an accepted invocation.

The browser uses permissions only to hide or disable controls; every trusted decision is repeated by Cognito/IAM, API Gateway, the Lambda, DynamoDB conditions, or AgentCore. Tags are filters, never grants; the Agent binding is the authorization fact. Do not expose an arbitrary IAM editor. Admins assign one of the fixed Cognito groups and user limits; project owners assign only `owner`/`editor`/`viewer`; agent capability profiles come from reviewed IAM/Cedar templates.

The access Lambda accepts an operation discriminator and a small validated payload, projects it into an allowlisted AWS command, and returns a redacted view model. It never accepts an ARN, actor ID, execution role, policy document, raw model configuration, price, or AWS command name from a caller without resolving an approved record. Browser roles cannot bypass it. Audit every decision with request ID, caller `sub`, project key, Harness ID, operation, decision, reason code, and current period ID—never tokens, secrets, prompts, or message bodies.

#### User lifecycle

Cognito owns the user; `USER#<sub>/CONTROL` owns application access plus the user's budget schedule/limit and storage limit. The Users table is a backend-composed view: paginate Cognito `ListUsers`, resolve each immutable `sub`, batch-read User control/current-period/storage projections, and return one row containing email, Cognito status, global group, application access, budget, committed spend/overdraft, next reset, storage used/limit, and project count. The frontend never joins these systems itself.

Invitation is an idempotent, fail-closed sequence: `AdminCreateUser` returns the new `sub`; snapshot the current account defaults ($5 daily and 5 GB initially) into the User control unless explicit limits were supplied; then add exactly one Cognito group **last**. If control creation fails, the invited identity has no application group and cannot use the product; retry resumes from `AdminGetUser`. Public sign-up remains disabled. The same required defaults apply to the first bootstrap administrator.

Role change reconciles the user to exactly one of `Administrators`, `Members`, or `Auditors`, removes a higher-privilege old group before adding a lower-privilege new group, and then calls `AdminUserGlobalSignOut`. A temporary loss of access is safer than a partial promotion. Suspending a user writes `access=blocked` first, then calls `AdminDisableUser` and global sign-out; enabling performs Cognito enable first and writes `access=active` last. This User control check gives immediate application denial even while already-issued JWT behavior catches up. Deletion first requires transfer or deletion of owned projects, blocks access, disables/signs out the identity, removes memberships, then deletes the Cognito user. Retained usage is keyed only by opaque `sub`; no email/profile copy remains.

Only administrators set user budget/reset and storage limits. Lowering a limit below committed spend is valid and immediately blocks the next request; it never cancels already-accepted work or rewrites usage. Members see their own actual spend, overdraft, remaining amount, reset time, storage, and denial reason. Project/agent costs remain breakdown dimensions rather than independent v1 budgets. Auditors are read-only and cannot chat or create agents.

#### Model catalog and agent creation

“Model table” means one logical catalog partition in the existing physical DynamoDB table, not another AWS table. Each model row has an immutable `modelKey`, display name, provider (`bedrock`, `openai`, `gemini`, or `litellm`), exact model ID/API format/endpoint kind, optional AgentCore Identity credential-provider ARN, administrator-reviewed `additionalParams`, safe tunable defaults/bounds, capabilities/context metadata, status, revision, and audit timestamps. It never contains an API key. Effective-dated price rows sit beside it under the same catalog partition.

Model status is explicit: `draft` is visible only to administrators, `active` is selectable by agent creators, and `blocked` denies new creates/updates **and future invocations** that reference it. Blocking does not silently rewrite existing Harnesses. Re-enabling or migrating agents is an explicit operation. Model configuration fields such as LiteLLM `apiBase` and `additionalParams` are administrator-only because AgentCore documents that they can alter endpoints, region, credentials, and routing.

Every Member owns the lazily created `main` project, so every active Member can create an agent there. An administrator can create in any project; owners and editors can create/update/delete agents in their projects; viewers and auditors cannot. The create command accepts product fields only: project key, name, model key, prompt, skill IDs, approved capability-profile IDs, and bounded limits. The broker snapshots the active model revision, resolves all ARNs/configuration, calls `CreateHarness(clientToken)`, and conditionally writes the Agent binding returned by the service. If binding fails, it best-effort deletes the just-created Harness; an unbound tagged Harness is unusable and appears only in administrator diagnostics.

Updates conditionally move the Agent binding from `ready` to `updating`, apply one `UpdateHarness`, then store the new model key/version and return to `ready`. Deletes similarly use `deleting`. Chat admits only `ready` bindings. An interrupted operation therefore fails closed and can be repaired by comparing the binding with `GetHarness`; no prompt, skill, or tool configuration is copied into DynamoDB. The model revision is a creation/update snapshot: if an administrator blocks the model concurrently, a command already accepted may finish, but its resulting agent cannot be invoked while the model is blocked.

### 6.8 Usage admission, events, limits, and storage

[USAGE-RESOURCES.md](./USAGE-RESOURCES.md) is normative. V1 uses three deliberately separate controls:

1. **Per invocation:** immutable Harness caps for model tokens, iterations/tool calls, Browser/Code duration, and total timeout. These bound one accepted request.
2. **User-period admission:** committed application cost in DynamoDB compared with the user's finite or unlimited daily/weekly/monthly policy.
3. **Account backstop:** AWS Budgets alerts/actions at 80/90/100 percent. Delayed AWS billing is never the per-chat gate.

New users and administrators receive the current account-default snapshot, initially $5.00 per day and 5,000,000,000 managed-storage bytes. Administrators can change defaults for future users, explicitly apply them to users still on a prior defaults revision or selected users, and override one user. Existing users never change silently.

Budget reset is derived from `{cadence, IANA time zone, epoch, instant}`. Daily resets occur at local midnight, weekly at the configured ISO weekday, and monthly on day 1. No job zeros counters. A manual reset increments epoch and preserves history.

There is no `reservedMicroUsd` and no monetary lease. Admission strongly reads the active user's committed current-period summary. If a finite user is already at/over the limit, return `BUDGET_EXHAUSTED`; otherwise conditionally create the idempotent request and invoke the Harness. A duplicate `requestId` resumes the same operation. A request accepted below the limit is allowed to finish.

Concurrent callers may both be accepted and produce overdraft. That race is the platform's error: show `overdraftMicroUsd`, stop later requests once the committed summary is at/over the limit, never cancel completed/streaming output, never create debt, and never carry it into the next period. Project and agent values are usage breakdown dimensions, not separate enforced v1 budgets.

Every independently measurable model, embedding, Memory, Gateway, tool, Browser, Code Interpreter, and Runtime component appends an immutable usage event as soon as its native usage becomes available. One DynamoDB transaction conditionally inserts the deterministic event ID and increments the request, user-period, and time-bucket projections. Duplicate delivery charges once. A failed terminal callback cannot hold budget because request status has no monetary effect.

Original events are never edited. Later native usage, telemetry, price repair, or billing evidence appends a positive/negative adjustment event. Money is integer micro-USD with one final upward rounding step. Each event pins exact effective price keys and uses `measured`, `estimated`, `reconciled`, or `unpriced` quality. Unpriced activity is visible and never described as free.

Usage does not live in AgentCore Memory and no custom Memory strategy participates. Memory remains conversational state. The chat stream can emit normalized `usage.event`/`usage.summary` events, and reload joins request IDs to the usage API. This avoids an extra billable Memory projection and keeps one accounting owner.

A non-terminal request becomes display-state `stale` after its last observation ages past the threshold. Reconciliation may recover events or terminal status from Harness/CloudWatch evidence, but it is not required to release capacity and never charges a guessed reserved ceiling.

The separate 5 GB user quota covers product-owned S3 attachments, skills, schemas, exports, and managed files. `storage.beginUpload` strongly reads committed bytes and returns an exact-key, content-length-bounded presigned POST only if the user is currently below the limit. It writes no pending byte reservation. S3 notifications idempotently update the object manifest and byte projection. Concurrent accepted uploads may create overage; objects remain and later uploads stop until deletion or a limit increase.

### 6.9 Alternatives deliberately rejected

- **Separate user-admin, project-control, and chat Lambdas on day one:** this would give stronger execution-role isolation, especially keeping Cognito administration away from the chat path, but adds functions, packages, routes, observability, and cross-handler helpers before load or team boundaries require them. Start with one small allowlisted dispatcher whose command handlers authorize before constructing privileged clients. Split the administrator command group into its own Lambda if security review requires an IAM boundary, the handler no longer fits/reviews comfortably as one unit, or the paths need independent deployment/scaling. The RPC contract and single table make that split mechanical.
- **Custom code inside a managed Harness as the access service:** a Harness custom container supplies dependencies and filesystem environment; AgentCore overrides its `ENTRYPOINT`/`CMD`, and the managed agent loop remains the invocation handler. A background process must be started per session with `InvokeAgentRuntimeCommand`. That is useful for agent tools, not a stable account-wide authorization/budget boundary, and it cannot gate the invocation that creates its own session.
- **A custom AgentCore Runtime as the access service:** technically valid and the only AgentCore-native code-hosting replacement for Lambda/API Gateway. A JWT-authorized HTTP Runtime could read the validated Cognito token, check DynamoDB, invoke managed Harnesses, and stream SSE. It still needs the table and the same deterministic code, plus an S3 ZIP/ECR artifact, Runtime version/endpoint, packaging/update flow, and crash reconciliation. The foundation cannot reference code in its newly-created shared bucket in a single CloudFormation create, so this makes bootstrap two-phase or requires a separate artifact location. Keep it as the migration target if the broker gains substantial long-running, bidirectional, or agentic behavior; it is not the smaller MVP.
- **Pure browser-to-Harness for every user:** smallest code, but not a security boundary. The caller controls actor/runtime-user inputs, native list APIs are not project membership checks, and direct service calls cannot enforce trusted user-budget admission or usage attribution.
- **Direct browser writes to the authorization table:** technically possible with Cognito temporary credentials and partition-key IAM conditions, but safe only for arbitrary state wholly owned by one principal. Project membership, roles, budgets, prices, sessions, usage events, and storage counters are cross-principal or accounting invariants whose values IAM cannot validate. Keep the authoritative table service-written; add a tightly isolated `USER#<sub>/PREF#*` namespace only if persistent preferences become necessary.
- **Cognito group per project:** acceptable for a few coarse tenants, poor for dynamic many-to-many projects. Groups are not nested, group claims are cached in existing tokens, and role precedence is an account-role mechanism rather than an object ACL. Keep only three global groups.
- **A second JWT Chat Gateway in front of each Harness Runtime:** attractive because Cedar sees JWT `sub` and Runtime targets can stream, but streaming request interceptors cannot rewrite/validate the actor-bearing body. It still needs a trusted broker for actor derivation, user-budget admission, and accounting, so it adds a Gateway without removing the Lambda. Revisit only if AgentCore adds body-aware streaming authorization.
- **AWS Budgets as the hard limiter:** its billing feed updates at least daily; use it for account alerts/actions, never per-turn admission.
- **Separate membership, budget, price, session, and usage stores:** clearer names but needless resources and cross-store failure modes. One DynamoDB table gives the required atomic transaction boundary. Do not force blobs, chat events, Harness configs, or telemetry into it.
- **DynamoDB as the whole application state:** would duplicate AgentCore and create reconciliation work. The table is an authorization/accounting index only.

## 7. Control system and modal-first UI

### 7.1 Four explicit scopes

Every control belongs to one visible scope:

| Scope   | What it controls                                                                                                                                           | AWS source of truth                                                       | Entry point                       |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------- |
| Account | Cognito session/users/roles, foundation stack, shared Memory/Gateway/Policy engine, global integrations, default user limits, price catalog, diagnostics   | Cognito, CloudFormation, AgentCore, and authorization table               | account/status button             |
| Project | membership, actor identity, tagged Harnesses/integrations, project memory, and usage attribution                                                           | one project/membership record plus Memory actors and native resource tags | project switcher                  |
| Agent   | thin project/model binding plus one Harness for prompt, model, skills, tools, credential references, code profile, limits, versions, and usage attribution | authorization table + `GetHarness`/`UpdateHarness`                        | current-agent button or agent row |
| Chat    | one agent-prefixed Memory session, active stream, retry/export/usage                                                                                       | Memory events and `InvokeHarness`                                         | chat title/usage control          |

The UI must name the scope in every modal breadcrumb and destructive confirmation. Account resources can be assigned downward; project controls must never silently modify another project; agent Save updates exactly one Harness.

Configurability is a product requirement, not permission to duplicate native AWS state. Every durable setting has one owner and an authorized dialog:

| Scope       | Editable settings                                                                                                                                           | Source of truth                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Deployment  | production/callback URL, allowed origins, Region, Cognito domain, retention, bucket version retention, stack lifecycle                                      | CloudFormation parameters and outputs; defaults target `https://park-brian.github.io/chat/agentcore/`    |
| Account     | new-user budget cadence/time zone/amount, storage default, approved models and effective prices, Gateway targets and policies, credential-provider metadata | account/model/price rows in the one table plus native AgentCore resources                                |
| User        | role/status, individual budget cadence/time zone/amount/reset epoch, storage limit                                                                          | Cognito group/status plus one User control row; defaults are snapshotted and can be explicitly reapplied |
| Project     | name, members/access when sharing is enabled, agent assignments, integration grants, managed files                                                          | project/membership rows and native actor/tags; no second project document                                |
| Agent       | prompt, model and safe tuning, skills, Browser/Code Interpreter/Gateway tools, credentials by reference, memory behavior, runtime limits                    | the managed Harness, with only a thin authorization/model binding in the table                           |
| Integration | API schema/endpoint, OAuth or API-key provider, target scope, policy, assigned agents                                                                       | AgentCore Identity, Gateway, Policy, Harness references, and ownership tags                              |

The normal chat page stays small while these controls remain discoverable in one routed modal. Show defaults and presets as starting values, never as hidden constants. A configuration change must name its scope and affected users/agents; changing account defaults does not silently rewrite existing user overrides. Stable security and accounting rules—trusted actor derivation, authorization, immutable usage evidence, and no pending-cost lockout—are enforced by the backend rather than offered as unsafe toggles.

### 7.2 Keep the main screen quiet

The persistent page contains only:

- **Sidebar** — project switcher, agents in the current project, chats for the selected agent, New agent, and New chat.
- **Header** — current agent, connection/stack status, Integrations, and Usage.
- **Message area** — session events and live Harness stream.
- **Composer** — text/files if supported, Send, and Stop while running.

Models, skills, tools, credentials, policies, Gateway, Memory, and CloudFormation are routes inside scoped dialogs, not separate permanent panels.

### 7.3 One routed dialog, never stacked dialogs

Use one Bootstrap modal shell controlled by one signal:

```js
const [dialog, setDialog] = createSignal(null);
```

Its route object is small and serializable except for the in-memory draft:

```js
{
  scope: "account" | "project" | "agent" | "chat",
  page: "overview" | "infrastructure" | "model" | "skills" | "credentials" | "...",
  subjectId: "...",
  draft: {},
  dirty: false
}
```

The header renders breadcrumbs such as `Project / Legal / Credentials / Jira`. Back changes the route; it never opens another modal. Dirty-close confirmation is another route in the same shell. On narrow screens use fullscreen; on wider screens use `modal-xl`, a short left rail, and one content pane. Trap focus, focus the first error, and restore focus to the launcher.

### 7.4 Account control center

1. **Overview** — signed-in email/`sub`, application role, Region, stack status, Memory/Gateway/Policy status, managed Harness count, and Repair/refresh.
2. **Session** — Sign in, Sign out, reauthenticate, token expiry, stack name, and deployment entry URL. Tokens are never displayed; the derived `sub` is copyable.
3. **Users** — an administrator-only table composed by the backend with email, Cognito status, global role, application access, budget cadence/limit, committed spend/overdraft, reset time, storage use/limit, and project count. New users—including administrators—snapshot the account defaults of $5 daily and 5 GB unless explicitly overridden. A row route exposes separate idempotent actions for invite/resend, role, block/enable, password reset, global sign-out, limits/reset schedule, memberships, and guarded deletion; there is no misleading all-or-nothing “Save user” across Cognito and DynamoDB.
4. **Models** — an administrator-only table with display name, provider/model ID, API format/endpoint kind, credential reference status, lifecycle status, safe token/context limits, pricing completeness, agent count, and last update. Row routes edit the approved model template, tuning bounds, effective-dated prices, test result, and `draft`/`active`/`blocked` status. Secret values are created/rotated in the separate Credentials route and never appear here.
5. **Infrastructure** — bootstrap when no deployment exists; otherwise read-only status/events/outputs plus an explicit **Enter deployment credentials** transition for validate/update/delete. Deletion first checks Harnesses and other dependents and warns that recovery again requires external credentials.
6. **Integrations** — tagged Gateway targets, type/auth/status/last sync, add/synchronize/inspect/delete, and assignment count.
7. **Credentials** — tagged AgentCore API-key and OAuth providers; write-only secret submission/rotation through `/credential-secrets`, inspect non-secret metadata, reauthorize, change scope, and delete after backend reference checks.
8. **Policies** — foundation Policy Engine status, enforcement mode, Cedar policies, generated schema, validation, effective tool matrix, and recent decisions. Default is deny; every enabled Gateway action needs a permit.
9. **Code profiles** — system Code Interpreter plus tagged custom interpreters, network mode, execution role, S3 grants, and which agents use each profile.
10. **Shared memory** — Memory identity, strategies, retention, diagnostics, and raw record search.
11. **Usage and resources** — the signed-in user's view; for administrators, the same per-user view plus a combined all-users view. Show committed spend, remaining budget, visible forgiven overdraft, reset schedule, storage use/limit, request and component drill-down, token/cache/embedding/Memory/tool/compute meters, effective prices, estimates versus reconciled AWS cost, and redacted CSV/JSON export. Project and Harness are breakdown filters, not budget scopes.
12. **Diagnostics** — traces/logs, resource IDs, SDK versions, request IDs, orphan/unbound Harnesses, interrupted Agent bindings, stale request status, usage/storage reconciliation status, and redacted export.

### 7.5 Project control center

1. **Overview** — project ID/key, owner, actor ID, role, native resource counts, user-budget status, attributed project usage, and danger actions. `main` is marked Default and cannot be removed from the selector.
2. **Agents** — authoritative Agent bindings joined with native Harness status/version/model; owners, editors, and administrators can create/duplicate/edit/delete, while viewers are read-only.
3. **Integrations** — account integrations available to this project and project-owned targets. Assignment only changes selected agents' Harness tool allowlists; it never copies secret values.
4. **Credentials** — credentials whose ownership tags are account or current user/project; project-owned create/rotate/delete actions.
5. **Access** — owner/editor/viewer memberships plus the matrix of agents × Gateway actions/code profiles, with links to the underlying Harness allowlist, Cedar policy, IAM role, and network boundary.
6. **Memory** — project sessions and long-term records; filters by selected agent session prefix where possible; forget-project is destructive.
7. **Usage** — read-only project/Harness attribution, component meters, daily trend, and recent requests. V1 deliberately has no project or Harness budget; user limits are managed in Account → Users by administrators.

Selecting a project writes nothing. Creating one writes only its project and owner-membership items; no stack update or AgentCore resource is required.

### 7.6 Agent control center

1. **Overview** — name, stable IDs, project actor, Harness ARN/status/version, summary chips, duplicate/delete.
2. **Instructions** — system prompt, character count, restore default.
3. **Model** — choose one active catalog model, then only the safe tuning fields and bounds published by its administrator-owned row; show provider/model/pricing/credential status read-only and offer a bounded Try without saving. Raw provider unions, ARNs, endpoints, and `additionalParams` are never member-editable.
4. **Skills** — the Harness's native ordered `awsSkills`/Git/S3/path sources, plus broker-authorized presigned upload to an S3 URI. There is no frontend skill registry, manifest, or attachment record.
5. **Tools** — Browser, Code Interpreter, Gateway, shell/file operations, selected Gateway patterns, and raw `allowedTools` under Advanced.
6. **Code and data** — Code Interpreter profile, network mode, execution-role summary, S3 grants, direct-secret-risk disclosure, and a test command.
7. **Memory** — recent context/retrieval configuration and the selected agent's prefixed sessions; project-wide memories are clearly labeled shared.
8. **Limits** — max iterations/tokens/timeout plus Compact/Normal/Deep presets.
9. **Versions** — `ListHarnessVersions`, status/failure reason, and endpoint/promotion controls when endpoints are enabled.
10. **Raw configuration** — formatted `GetHarness` response, explicit validated edit mode, copy/download.

All pages edit one draft fetched from `GetHarness`. Save performs one `UpdateHarness` and waits for `READY`. Navigation never writes partial state.

### 7.7 Chat controls

The chat dialog shows project, Harness, actor/session IDs, created time, loaded event count, current usage/latency/cost estimate, remaining budget, refresh, stop, retry, export, and destructive session deletion. New Chat asks the access API to bind the prefixed session ID before invocation. Display titles are derived from the first user message; no metadata event is added.

### 7.8 Integration and credential wizard

The routed workflow supports Google, Jira, generic OpenAPI, remote MCP, Lambda, API Gateway, Smithy, and connectors:

1. **Scope** — account or current project; show exactly who will be able to discover it.
2. **Type** — target/API type and prepared narrow schemas where available.
3. **Identity** — existing tagged credential or new API key/OAuth provider.
4. **Credential** — write-only API key/client secret, or external Secrets Manager reference; show OAuth callback and consent where relevant.
5. **Schema** — paste/select OpenAPI or MCP endpoint; preview operation IDs.
6. **Policy** — choose read-only/read-write/custom, generate a Cedar draft, validate against the live Gateway schema, and show default-deny consequences.
7. **Review** — scope, target, credential ARN, tools, network path, and policy.
8. **Provision** — create provider/target/policy in dependency order, tag each, poll readiness, and retain repair information on failure.
9. **Assign** — update selected agents' Harness tools/allowlists.

Secret values never reappear after submission. Rotation uses the credential-provider update API. Delete is blocked while any managed Gateway target or Harness references the provider.

### 7.9 Control-to-API map

| User control               | Read operation                                                                 | Write operation                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Sign in                    | Cognito authorization/token endpoints, then `session.get`                      | OAuth redirect/token exchange only                                                                       |
| Sign out                   | current in-memory session                                                      | clear clients/tokens, then Cognito `/logout`                                                             |
| Bootstrap/discover         | `DescribeStacks` after bootstrap credentials                                   | `CreateStack`, then `AdminCreateUser`                                                                    |
| Manage users/roles/budgets | product API composed user view                                                 | product API user commands; backend coordinates Cognito + User control                                    |
| Manage models/prices       | product API model catalog view                                                 | product API model commands                                                                               |
| Update foundation          | direct `ValidateTemplate`, `DescribeStackEvents` in deployment-admin mode      | direct `UpdateStack` / guarded `DeleteStack` with entered credentials                                    |
| List projects              | access API membership query                                                    | none                                                                                                     |
| Create/select project      | access API membership query                                                    | project + owner membership only on create                                                                |
| List agents                | product API Agent-binding query joined to `GetHarness`                         | none                                                                                                     |
| Create agent               | product API active models/project permissions                                  | product API projects bounded draft into `CreateHarness` + Agent binding                                  |
| Edit agent configuration   | product API binding plus `GetHarness`/versions                                 | product API projected `UpdateHarness` and binding transition                                             |
| Delete agent               | product API binding, Harness, prefixed sessions                                | product API guarded `DeleteHarness(deleteManagedMemory:false)` plus binding/session cleanup              |
| List/open chats            | project-authorized access API → `ListSessions`/`ListEvents`                    | none                                                                                                     |
| Chat/send                  | access API membership/budget state                                             | streamed access API → `InvokeHarness`                                                                    |
| Stop chat                  | active invocation state                                                        | abort and/or `StopRuntimeSession`                                                                        |
| Integrations               | product API joins targets/tags/assignments                                     | product API Create/Update/Delete/Synchronize target                                                      |
| Credentials                | product API metadata/reference counts                                          | product API create/rotate/delete provider after authorization; raw values use only `/credential-secrets` |
| Policies                   | product API engine/policy/schema view                                          | product API Create/Update/Delete policy; update Gateway attachment                                       |
| Code profiles              | product API Code Interpreter view                                              | product API Create/Delete custom Code Interpreter                                                        |
| Skills/schemas             | product API metadata plus presigned S3 GET                                     | broker-authorized presigned S3 PUT/DELETE                                                                |
| User limits/prices         | access API table reads                                                         | administrator-only validated access API writes                                                           |
| Usage                      | access API event/projection reads plus CloudWatch/Cost Explorer reconciliation | idempotent component events, adjustments, and explicit reconciliation only                               |

### 7.10 Progressive disclosure rules

- Common fields first; provider-specific JSON and raw Cedar live under Advanced.
- Read-only AWS identifiers are copyable, not editable.
- Every status badge links to the page that can fix it.
- Disabled controls state the missing prerequisite and offer one direct action.
- Destructive actions remain inside a Danger disclosure and name account/project/agent scope.
- The ordinary agent path needs only name, model, prompt, skills, integration toggles, and code profile.

## 8. SolidJS rules and code structure

The existing `index.html` header is authoritative and must be preserved. In particular:

- components execute once;
- `${signal}` is reactive while `${signal()}` in a template is a static eager value;
- store and prop reads need zero-argument wrappers;
- never destructure reactive props;
- handlers take an event parameter;
- do not use `slice()` when a template must track store-array mutations;
- use `<${For}>` for reactive lists.

The installed `solid-js@1.9.15` source is for local reference only. Runtime imports remain pinned CDN ESM imports so there is no build step.

Suggested code regions inside the one HTML file:

1. imports and constants;
2. PKCE/Cognito token manager and in-memory Cognito credential provider;
3. AWS client factory plus bootstrap credential path;
4. stack discovery/deployment;
5. tag discovery/filtering and credential repositories;
6. actor/Harness/session discovery;
7. Harness CRUD and invocation stream reducer;
8. generic routed modal, focused form components, chat components, and tests.

Target roughly 1,000–1,400 lines for the first complete version, excluding the embedded CloudFormation template. The current 3,216-line copied chat implementation should be replaced, not incrementally adapted. Remove IndexedDB, provider adapters, the local tool loop, virtual filesystem, MCP client implementation, proxy support, subagents, and local branching; AgentCore replaces those concerns.

Keep adapters as plain functions returning AWS command inputs. Avoid a client-side domain framework, router library, state machine library, form library, or SDK wrapper. The four useful stores are auth/connection, discovery, selection, and active invocation; modal drafts remain local signals.

## 9. Credentials and security posture

There are two administrator entry paths. **Deployment mode** accepts short-lived external IAM credentials and has exactly that principal's authority for bootstrap/update/recovery. **Application mode** uses Cognito; the user's fixed group selects the admin, member, or auditor command capability set inside the product API. A Cognito administrator is not a deployment administrator. Authentication method never determines authorization by itself, and email/display name never grants privilege.

Even so:

- keep Cognito tokens—and deployment-mode AWS credentials when connected—only in JavaScript memory;
- never use `localStorage`, IndexedDB, query parameters, Memory events, logs, or error telemetry for tokens or secrets;
- allow `sessionStorage` only for the one-use PKCE verifier/state/nonce and non-secret deployment descriptor, then delete it on callback;
- clear product clients, tokens, and refresh state before redirecting to Cognito logout; clear deployment clients and AWS credentials when leaving deployment mode;
- configure the REST API Cognito User Pool authorizer to require the application access scope on every authenticated method;
- derive `runtimeUserId` and project actor only inside the trusted access Lambda from the validated Cognito `sub` and project record;
- show account/ARN/region before destructive operations;
- require exact names for stack, project, agent, Harness, credential, and policy deletion;
- keep third-party secrets in AgentCore Identity;
- allowlist trusted skill buckets/repositories when the caller is less trusted;
- never forward arbitrary caller-supplied Harness override fields; the bounded Try route builds them from a validated draft;
- require persistent limits on every Harness;
- treat direct-secret Code Interpreter profiles as privileged resources and show their IAM/network blast radius.

The broker role, Harness execution role, Code Interpreter roles, and Gateway role are separate. Only the broker receives the exact control and `iam:PassRole` permissions required by product commands. Capability-profile roles have constrained names, trust policies, inline policy templates, and optional permissions boundary; there is no free-form IAM policy editor. Normal browsers have no IAM principal. Tags and actor prefixes remain non-security metadata.

## 10. Usage, pricing, and reconciliation

The Usage modal distinguishes three truth levels instead of presenting one misleading number:

- **Live measured or estimated usage:** trusted Harness/stream/tool observations committed as immutable component events for input/output/cache tokens, latency, stop reason, invocation count, tool calls, duration, and bytes.
- **Operational telemetry:** AgentCore/CloudWatch traces, invocation metrics, Browser/Code Interpreter activity, Runtime vCPU/GB-hour usage logs, and Memory operation metrics. Resource-usage telemetry can lag by up to 60 minutes.
- **AWS billed cost:** Cost Explorer or CUR, delayed and authoritative only at the AWS billing dimensions that exist. Shared resources cannot always be allocated exactly to a user/project, so that allocation is labeled estimated chargeback.

Token pricing is effective-dated by provider, model, meter (`input`, `output`, `cacheRead`, `cacheWrite`, `embedding`), unit, currency, and source. Each request pins the catalog revision; each component event captures its actual rate key and quantity. Bedrock/OpenAI/Gemini/LiteLLM model output is calculated from the returned token counters. External embedding endpoints record exact token/vector usage when returned; otherwise they use a configured per-request/vector rate and remain estimated.

For a Bedrock-model invocation whose price is quoted per million tokens, calculate with integer/rational arithmetic:

```text
modelCost =
  inputTokens           * uncachedInputRatePerMillion / 1_000_000
+ cacheReadInputTokens  * cacheReadRatePerMillion     / 1_000_000
+ cacheWriteInputTokens * cacheWriteRatePerMillion    / 1_000_000
+ outputTokens          * outputRatePerMillion        / 1_000_000
```

Do not subtract the cache counters from `inputTokens` on Bedrock: when prompt caching is enabled, Bedrock documents `inputTokens` as only non-cached/non-written input, and total input is their sum. Store quantities as integers and rates as integer nano-USD per token (or numerator/denominator), then round only the final displayed amount; never round each term to cents.

The price key must include provider, exact billed model ID, AWS/model region, inference tier, context-length band, cache TTL/rate class, currency, and effective time. Pin the selected catalog revision and Harness version to the request, then record the actual rate key on each component event. If the Harness changes models between turns, each request gets its own price snapshot. If LiteLLM routing/fallback or a provider alias can use multiple actual models in one request, aggregate Harness metadata is insufficient for exact cost: record the aggregate as estimated, then append an immutable adjustment when per-model-call traces/provider usage become available. Never rewrite or silently replace history.

Harness usage has aggregate cache-read/write counters, but not every provider-specific billing dimension. For example, a model with distinct 5-minute and 1-hour cache-write prices requires TTL-specific usage that the aggregate event may not contain. The ledger therefore records `accuracy = exact-token`, `estimated-rate`, or `billing-reconciled`, plus the missing dimension. Never silently choose a rate. The AWS Price List can refresh Bedrock SKU candidates; an administrator must review the model/region/tier mapping. Third-party OpenAI/Gemini/LiteLLM rates come from their provider pricing and use a provider-specific `inputIncludesCache` rule rather than assuming Bedrock normalization.

AgentCore Memory's internal embedding-token count is not exposed as an exact per-request meter. Track the billable native quantities that are exposed—events, stored long-term records, and retrieval requests—and price/reconcile those. Likewise, Gateway, Browser, Code Interpreter, and Runtime costs use their native invocation/duration/compute meters. Do not fabricate token precision that AWS does not provide.

The table holds compact request records, immutable component events, and time/user projections needed for budgets and UI attribution; it never duplicates messages or full traces. Usage is not copied into AgentCore Memory. Chat streams may carry normalized usage events, and reload joins request IDs through the usage API. CloudWatch holds detailed operations, and Cost Explorer/CUR reconciles account charges. The reconciliation view shows `measured`, `estimated`, `reconciled`, or `unpriced`, timestamp, coverage gap, and delta. AWS Budgets remains an account-level alert/action backstop because its source billing data updates at least daily.

## 11. Error and consistency behavior

- Paginate every list operation; the default Memory page size is only 20.
- Retry throttling and transient 5xx errors with bounded exponential backoff and jitter.
- Do not blindly retry non-idempotent creates; set `clientToken` where supported.
- Treat Harness changes as `UpdateHarness` then poll to `READY`; preserve and display `UPDATE_FAILED` without inventing a Memory rollback record.
- Multi-resource integration creation is a small saga: record completed ARNs in the dialog draft, retry idempotently, and offer cleanup of only resources created by that attempt.
- Disable Send while one invocation is active for a session.
- Allow cancellation through `AbortController` and expose `StopRuntimeSession` if cancellation alone does not stop server work.
- Surface streaming exception events inline and preserve the user's unsent/retryable message.
- Keep a compact raw-response expander in error dialogs; redact authorization headers and credentials.
- If stack outputs are missing or resources are not ready, route directly to the Infrastructure dialog.

## 12. Implementation phases

### Phase 1 — infrastructure and authenticated-browser spike

1. Author `template.yaml` with a Cognito User Pool/resource server and fixed groups, Memory, Policy Engine, Gateway, one authorization table, one broker Lambda/Regional REST API, shared bucket, and execution roles; deliberately omit Harness resources.
2. Validate it with CloudFormation.
3. Add the bootstrap modal; deploy a disposable stack with temporary `eaap`-derived credentials and create the first invited test user.
4. Implement PKCE login, callback checks, in-memory token refresh, `session.get`, and logout from the actual HTTPS/localhost origins.
5. Verify admin/member/auditor command mapping and that normal sessions receive no AWS credentials or direct service path.
6. Create one disposable Harness as admin, invoke it through the streaming access route as a member, confirm actor derivation, committed-spend admission, and idempotent component usage events, then delete it with `deleteManagedMemory:false`.

Exit criterion: a newly deployed foundation exposes a working entry/login URL; the invited administrator and member receive different capabilities; the administrator can manage a Harness; the member can stream only through an authorized project with no browser AWS keys.

### Phase 2 — AWS-backed chat

1. Implement trusted actor/runtime-user derivation in the access Lambda.
2. Implement project/membership records plus authorized native actor/Harness discovery.
3. Implement broker-projected Harness create/get/update/delete/version operations plus Agent-binding transitions.
4. Implement project actor/session/event pagination and agent-prefixed chat IDs.
5. Implement committed user-budget admission, streamed `InvokeHarness`, idempotent request/component events, and the browser stream reducer.
6. Replace the existing page with the slim shell, sidebar, messages, and composer.

Exit criterion: one user can switch between `main` and another project; each project can hold two independently versioned Harness agents; chats reload under the correct agent while project memory stays shared.

### Phase 3 — management dialogs

Implement Account Defaults/Prices, Users/Roles/Limits, Project/Access, Agent, Chat, Infrastructure, Models, Skills, Tools, Memory, Usage/Resources, and Confirm routes using the single modal shell.

Exit criterion: no ordinary management task requires editing JSON or visiting the AWS console.

### Phase 4 — Gateway, credentials, and policy

1. Implement tag hydration/filtering and credential-provider create/rotate/delete.
2. Implement target CRUD/synchronization.
3. Implement Policy Engine/schema/policy views with validated default-deny templates.
4. Add generic OAuth/API-key + OpenAPI workflow.
5. Validate Google Drive OAuth and Jira API-key/OAuth targets.
6. Make permitted Gateway tools selectable per Harness.

Exit criterion: an agent can use authorized Google and Jira tools through Gateway without exposing downstream credentials to prompts, Memory, or code output.

### Phase 5 — code credentials and hardening

1. Add managed custom Code Interpreter profiles for S3 role access and test role assumption.
2. Add the explicitly privileged direct-secret-to-code flow only if still required after Gateway testing.
3. Add cancellation, retries, redaction, reconciliation, and destructive confirmations.
4. Add CloudWatch/Cost Explorer reconciliation, stale-request diagnosis, and S3 manifest repair.
5. Test pagination, large account inventories, hosted-origin CORS, IAM boundaries, and cleanup.

## 13. Test plan

Keep `?test=1`, but move its tests to `agentcore/tests.js`; `index.html` dynamically imports that file only in test mode. `agentcore/package.json` declares `"type": "module"`, so all new Node and browser modules use `.js`, not `.mjs`. Normal use still loads a single HTML app. Fast local tests exercise pure actor/period/rate calculations, PKCE and URL parsing, stream reduction, modal reactivity, secret redaction, embedded-template equality, and dependency integrity. They do not substitute AWS clients or claim to validate AWS behavior.

The implementation loop is [browser-first and screenshot-reviewed](./IMPLEMENTATION.md#44a-browser-first-implementation-and-visual-review): reuse the parent loopback server and generic root browser runner; replace the copied app with a thin shell; prove Cognito and CORS in a real browser; complete one streamed Harness chat; then add dialogs one story at a time. `tests.js` exposes a test-only `await _screenshot(name, element?)` helper for viewport/full-page and DOM-node captures through Playwright, while the ordinary page imports no test code. The current local callback defaults to `http://localhost:8000/agentcore/` and is configurable in the stack. The published GitHub Pages URL receives a separate signed browser smoke before release. [STATUS.md](./STATUS.md) records which gates have actually passed.

Live AWS integration scenarios (all service calls use disposable real resources; the scripted echo model substitutes only inference):

- bootstrap create-stack/invite-first-user flow and repair after partial failure;
- authorization callback, token exchange, `session.get`, refresh, expiration, and logout;
- administrator/member/auditor capability selection, role changes, global sign-out, and stale-token behavior;
- API Gateway claim extraction and proof that caller-supplied `sub`, actor ID, role, ARN, price, and cost are ignored;
- concurrent sends at the remaining budget boundary—already-exhausted users are rejected, work accepted below the limit finishes, and any race overdraft is visible and forgiven;
- stream completion, client abort, Lambda failure, duplicate request, stale request display, late usage events, and best-effort usage reconciliation;
- create/edit/delete Harness and select actor;
- create/resume chat;
- cancel/retry invocation;
- CloudFormation create/update/no-op/failure rendering;
- Gateway target and Harness pending/ready/failed states;
- partial credential → target → policy workflow cleanup;
- expired/revoked tokens, command denial, state/nonce mismatch, and region mismatch.

Adapt the current `getEchoClient()` JSON scenarios into a test-only OpenAI-compatible Chat Completions endpoint. Configure a disposable managed Harness to reach it through `liteLlmModelConfig.apiBase` with a disposable AgentCore Identity key. The browser must still call the real `/chat` route and AgentCore Harness; never select the old browser echo client for an integration test. The endpoint returns deterministic text/tool calls and synthetic usage, while Cognito, CloudFormation, Harness, Memory, Gateway/Policy, Browser, Code Interpreter, DynamoDB, S3, and API Gateway remain live. Validate protocol compatibility with one actual Harness invocation before relying on it. Real external integration tests call Google/Jira with test credentials; without those credentials, mark them unrun rather than replacing those services.

Automated disposable live smoke tests run after a slice changes AWS behavior or browser authentication. The implemented `test:live` reuses an exact stable disposable stack and cleans its own Cognito/DynamoDB smoke identity in `finally`. A future [warm development stack lifecycle](./IMPLEMENTATION.md#45-warm-disposable-development-stack-and-mandatory-cleanup) will automate `dev:up`/`dev:down`, direct-created resource cleanup, and cold-lifecycle measurement; those commands do not yet exist. Never reset a test by deleting immutable usage rows. Current commands and results are in [STATUS.md](./STATUS.md).

The complete live journeys are:

- deploy a stack in a disposable name with bootstrap credentials;
- open its `ApplicationEntryUrl`, sign in as admin/member/auditor, and confirm each expected capability set and control visibility;
- prove the page receives no AWS credentials in normal mode and all managed-resource operations traverse the product API;
- create owner/editor/viewer memberships and prove cross-project, cross-actor, and cross-session attempts fail;
- set a tiny test budget, prove admission stops after committed spend reaches the limit, race two accepted requests and show forgiven overdraft without debt, then test warning and unlimited modes;
- verify per-component token/cost events, embedding/Memory estimate labels, and Cost Explorer/CloudWatch reconciliation timestamps;
- upload two files concurrently near the 5 GB-style test limit, show storage overage without deletion, block later uploads, then delete one and verify uploads resume;
- make authenticated product API calls from the actual GitHub Pages HTTPS origin and registered localhost origin;
- reload and verify that a new authorization flow occurs while no token/credential remains in storage;
- invite, disable, re-enable, and remove a disposable Cognito user;
- create two Harnesses in one project actor and verify distinct configs plus shared project memory;
- verify `ListActors`, tagged `ListHarnesses`, `ListSessions`, and `ListEvents` after reload;
- invoke Browser and Code Interpreter once;
- create/tag/filter/delete a harmless credential, Gateway target, and policy;
- use a custom Code Interpreter role against a disposable S3 prefix without static AWS keys;
- run the visible login, modal, save, reload, chat, usage, and sign-out journeys from `https://park-brian.github.io/chat/agentcore/` and the registered localhost URL with generated disposable Cognito users; SDK setup may arrange fixtures, but assertions exercise the UI;
- clean each scenario's tagged resources and dedicated smoke users in a `finally` block, including after failure; retain shared fixtures between warm runs; at `dev:down`/CI completion, remove the disposable stack and exact test bucket with all object versions/delete markers, then verify absence. Report and retry any cleanup failure without touching pre-existing `eaap-ac-*` resources.

## 14. Acceptance criteria

- The runtime artifact is one HTML file with no build step.
- Infrastructure is a plain CloudFormation YAML template, not CDK.
- The stack exposes a Cognito-managed application entry/login URL, User Pool endpoint details, and the product API URL.
- Normal users authenticate with authorization code + PKCE; the public app client has no secret and the REST API Cognito authorizer validates access tokens with the application scope.
- A Cognito `sub` is the authoritative user ID; every actor ID is `<sub>/<projectId>` and `main` is implicit.
- Cognito groups map to distinct admin/member/auditor command capabilities; bootstrap IAM credentials remain a separate recovery path.
- A member cannot call actor-bearing AgentCore APIs directly; the trusted access Lambda derives caller and actor IDs after a project-membership check.
- User control, project membership, model policy, thin agent bindings, and budget accounting use one DynamoDB table; no Cognito profile, Harness configuration, chat, secret, or trace database is duplicated there.
- Each user has one configurable daily/weekly/monthly or unlimited budget. Admission reads committed current-period spend, never reserves money, allows accepted work to finish, records every measured component idempotently, and treats race overdraft as visible platform cost with no debt or carryover.
- Each user has one managed-storage limit. Uploads use exact-key, content-length-bounded presigned POSTs; S3 notifications update committed bytes, concurrent overage never deletes data, and later uploads wait for deletion or a limit increase.
- Model token, embedding, Memory, Gateway/tool, Browser/Code Interpreter, and Runtime meters are labeled as live estimates, operational telemetry, or billing-reconciled cost as appropriate.
- No Cognito token, refresh token, or deployment AWS credential persists beyond JavaScript memory; only one-use PKCE callback state may use `sessionStorage`.
- The page can validate, create, update, inspect, and delete its stack directly from the browser.
- Each persistent agent is one managed Harness created directly through the control API, not CloudFormation.
- Agent listing comes from native Harnesses and tags; project/chat listing comes from Memory actors and sessions.
- Agent configuration lives natively on its Harness and uses AgentCore versioning.
- Ordinary invocation supplies only identifiers and messages; overrides are limited to Try without saving.
- Browser and Code Interpreter are the primary general-purpose tools.
- Gateway integrations, policies, tags, Code Interpreter profiles, and credentials are manageable through dialogs.
- SaaS credentials normally remain behind Gateway; S3 code access normally uses temporary role credentials.
- No long-lived secret is written to browser storage or Memory.
- Usage metadata is visible for every invocation.
- The implementation is materially smaller than the current copied chat app.
- Browser tests propagate failures as nonzero process exits, exercise visible authenticated journeys on the fixed localhost and hosted origins, and capture reviewable full-page/DOM-node screenshots through test-only `_screenshot` without adding runtime screenshot code to `index.html`.

## 15. Installed development references

Installed in `agentcore/package.json` as development dependencies:

- `@aws/agentcore@0.30.0`
- `@aws-sdk/client-bedrock-agentcore@3.1137.0`
- `@aws-sdk/client-bedrock-agentcore-control@3.1137.0`
- `@aws-sdk/client-cloudformation@3.1137.0`
- `@aws-sdk/client-budgets@3.1137.0`
- `@aws-sdk/client-cloudwatch@3.1137.0`
- `@aws-sdk/client-cloudwatch-logs@3.1137.0`
- `@aws-sdk/client-cognito-identity@3.1137.0`
- `@aws-sdk/client-cognito-identity-provider@3.1137.0`
- `@aws-sdk/client-cost-explorer@3.1137.0`
- `@aws-sdk/client-dynamodb@3.1137.0`
- `@aws-sdk/credential-provider-cognito-identity@3.972.70`
- `@aws-sdk/client-iam@3.1137.0`
- `@aws-sdk/client-s3@3.1137.0`
- `@aws-sdk/client-pricing@3.1137.0`
- `@aws-sdk/client-secrets-manager@3.1137.0`
- `@aws-sdk/client-sts@3.1137.0`
- `@aws-sdk/credential-providers@3.1137.0` (local account-probe tests only)
- `@aws-sdk/lib-dynamodb@3.1137.0`
- `solid-js@1.9.15`

`@aws/agentcore` is present for source/CLI reference only; its CDK-based deployment path will not be used. The Cognito User Pools client supports operator user management, the Identity client/provider supplies temporary browser credentials, S3 supports skill/schema uploads, STS identifies the caller, and IAM/Secrets Manager support the optional privileged code profiles. The credential-provider package has its own published version line, so `3.972.70` is intentionally different from the `3.1137.0` service clients. The package pulls a large development-only dependency graph. `npm audit` currently reports nine transitive advisories (one low, six moderate, two high), predominantly under the AgentCore CLI dependency tree. Do not ship or import the CLI into the browser. Recheck on every AgentCore CLI upgrade; do not run an unreviewed `npm audit fix`.

## 16. Primary references

- [AgentCore Harness overview](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-get-started.html)
- [Harness models and invocation overrides](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-models.html)
- [Harness tools](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-tools.html)
- [Harness Memory and actor scoping](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-memory.html)
- [Harness security](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-security.html)
- [Harness observability and cost controls](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-operations.html)
- [CreateHarness API](https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_CreateHarness.html)
- [UpdateHarness API](https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_UpdateHarness.html)
- [InvokeHarness API](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_InvokeHarness.html)
- [CreateEvent API and actor constraints](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_CreateEvent.html)
- [Cognito managed login](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-managed-login.html)
- [Authorization code with PKCE](https://docs.aws.amazon.com/cognito/latest/developerguide/using-pkce-in-authorization-code.html)
- [Cognito token endpoint and browser CORS](https://docs.aws.amazon.com/cognito/latest/developerguide/token-endpoint.html)
- [Cognito user groups](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-user-groups.html)
- [API Gateway REST API Cognito User Pool authorizers](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-enable-cognito-user-pool.html)
- [Cognito CloudFormation resources](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/AWS_Cognito.html)
- [AgentCore CloudFormation resource types](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/AWS_BedrockAgentCore.html)
- [Harness CloudFormation resource](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-bedrockagentcore-harness.html)
- [Memory CloudFormation resource](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-bedrockagentcore-memory.html)
- [Gateway CloudFormation resource](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-bedrockagentcore-gateway.html)
- [Policy Engine CloudFormation resource](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-bedrockagentcore-policyengine.html)
- [Gateway target configuration](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-add-target-api-target-config.html)
- [OpenAPI Gateway targets](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-schema-openapi.html)
- [AgentCore Policy concepts](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-core-concepts.html)
- [Harness lifecycle hooks and usage payloads](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-lifecycle-hooks.html)
- [Runtime OAuth and trusted runtime-user derivation](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-oauth.html)
- [AgentCore runtime observability metrics](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-runtime-metrics.html)
- [AWS Budgets update cadence](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-best-practices.html)
- [API Gateway Lambda response streaming](https://docs.aws.amazon.com/apigateway/latest/developerguide/response-streaming-lambda-configure.html)
- [AgentCore Identity credential providers](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/resource-providers.html)
- [Credential-provider scoping](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/scope-credential-provider-access.html)
- [Code Interpreter credentials](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/security-credentials-management.html)
- [Custom Code Interpreter S3 integration](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-s3-integration.html)

## 17. Decisions to confirm before implementation

The architecture above has three product choices that materially affect the first implementation:

1. Keep built-in harness `shell` and `file_operations` enabled alongside Browser and Code Interpreter, or disable them to reduce capability and token overhead.
2. Retain the skills bucket when the stack is deleted (recommended), or delete it with the stack.
3. Defer direct secret exposure to generated code until after Gateway-based Google/Jira flows are proven (recommended), or include the explicitly high-risk project Code Interpreter profile in the first release.

Everything else can proceed without changing the architecture.
