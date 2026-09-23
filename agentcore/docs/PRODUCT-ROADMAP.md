# AgentCore Chat product roadmap

Status: proposed execution plan, 2026-09-22. This document owns remaining product work and acceptance criteria; [ARCHITECTURE.md](ARCHITECTURE.md) owns deployed structure, current APIs, security boundaries, and measured evidence. Proposed behavior is not implemented behavior.

## Product promise and present gap

A person signs in at the static GitHub Pages app, chooses an agent, starts a conversation, and can revisit and continue it after switching agents, reloading, or signing in again. They can see request/tool usage and estimated cost with unpriced components honestly marked. An administrator manages people, defaults, and per-person or combined usage. Developers maintain the small model list and price estimates in source control; the only model UI is the agent dropdown. User-owned projects, skills, credentials, Gateway tools, and managed Browser execution extend the same Runtime/configuration shape.

The first administrator's path must be complete: deploy the stack; create/invite an administrator; sign in; choose from the maintained model dropdown; create an agent; chat. A new member sees a clear create-agent path. Source-control maintainers review model identity, AWS offer rates, and capped live inference; the account owner handles any required third-party Marketplace terms. Never equate “AWS listed it” or “one initial call succeeded” with durable model access.

Current live evidence covers Cognito login, deterministic control mutations, scripted multi-turn Memory, Code Interpreter, usage queries, one sticky Runtime session, the fixed model dropdown, capped real-model smoke turns, and desktop/mobile conversation reopen after switching and reload. A JSON metering receipt is saved alongside each Memory turn. It does **not** cover durable third-party agreement access for every listed model, all Cognito roles, cross-store reconciliation, accurate total AWS cost, Gemini/Browser/Gateway/skills, or a full visual pass. The production model list is checked-in JSON, not an admin table or settings dialog. Skills and Integrations are placeholders, users.list UI stops after 20, and the 5 GB storage limit is not enforced.

## Constraints that shape every slice

- Keep one buildless SolidJS `index.html`, test stories and `_screenshot` in `tests.js`, and `.js` modules rather than `.mjs`. Follow the **parent** `index.html` header: components run once, reactive template values are zero-argument functions, and event handlers accept an argument. Preserve findable page regions: auth/RPC, chat/state, modal bodies, shell, CSS.
- Ordinary browser calls one Cognito-JWT-protected AgentCore CodeZip Runtime. AgentCore Memory owns messages, one DynamoDB table owns app configuration/ledger, one shared private S3 bucket owns artifacts/objects, and plain CloudFormation owns infrastructure. No Lambda, API Gateway, Strands, per-agent Runtime, direct browser table writes, local chat database, or generic AWS-operation proxy without a measured need.
- Actor ID is derived from Cognito sub/project, initially sub/main. Agent ID remains separate and is part of the Memory session ID. A Cognito Administrator is **not** an AWS administrator. A future browser CloudFormation mode requires explicitly entered short-lived AWS credentials in a separate UI, only after CORS/SigV4 proof.
- A stream is successful only after both Memory and ledger commit and a terminal `message.done`. Budget admission uses already committed measured spend, never a pending hold. Concurrent overdraft is our error; a stuck attempt must not lock a user out. Reset stays lazy on read/use.

## User-visible contract

1. **Conversation continuity.** Selecting another agent does not erase a saved chat. New chat is explicit. A recent-chat list reopens Memory events after reload/sign-in. URLs may contain opaque project/agent/conversation IDs, never tokens, prompts, secrets, or authority. Every read/write derives owner from the JWT. A missing or foreign conversation has the same 404 shape.
2. **Honest stream state.** Text deltas are pending until `message.done`. A network cut, missing terminal event, or server error leaves a visible uncertain/failed turn. Reopen by ID to resolve an unknown outcome before offering an intentional retry. A retry must not silently rerun and bill twice. Do not show Stop until abort truly stops model/tool work and settles observed partial usage.
3. **Usable chat UI.** Preserve whitespace, render code blocks safely, never inject raw model HTML, show tool activity and terminal tool/error state, auto-scroll only when near the bottom, and retain composer focus. Enter sends, Shift+Enter inserts a newline. Desktop/mobile layout, keyboard access, focus, contrast, and readable 14–16 px primary text are product behavior, not cosmetic extras. Every settings component may use the one native modal; chat navigation remains in the shell.
4. **Model meaning.** The dropdown comes from checked-in JSON grouped by company. A provider-specific option is selectable only when its server adapter and token-rate estimate exist; otherwise it is disabled with a reason. A read-only account catalog listing is not proof of Runtime access. Source-control review and capped opt-in live smoke tests replace model-admin forms.
5. **Admin meaning.** A user detail shows current Cognito role/status, inherited or overridden limits, current-period measured spend, next UTC reset, and recent requests. Never show storage “remaining” until storage is counted and enforced. Prevent an administrator from accidentally removing the last usable administrator.
6. **Money meaning.** Model tokens and cache meters use reported values and a rate snapshot; tool/Runtime/Memory/S3/embedding/Gateway/provider costs remain visibly partial until measured or reconciled. Do not call model-only spend a complete AWS bill. Keep immutable usage rows; record corrections separately.

## State and ownership

| Fact | Authority | Smallest representation |
| --- | --- | --- |
| Identity, role, enabled state | Cognito; Runtime validates each request and current sensitive-write target | No browser role authority |
| Project, agent and limit overrides | One DynamoDB table through narrow Runtime commands | Revisioned rows, no separate deployment per agent |
| Model list and price estimates | Checked-in models.json bundled with the Runtime | No model mutation API or table rows |
| Conversation messages and events | AgentCore Memory actor `sub/project`, session `a_agentId_conversationId` | No duplicate message body in table |
| Conversation navigation | One table row per conversation with owner/project, agent, title, created/last-activity times, TTL | Memory [ListSessions](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_ListSessions.html) gives only ID/creation time, not title or last activity |
| Requests, tools, period spend | Immutable usage rows, atomic period update and completed-request marker in table | No pending reservation |
| Skill/object bytes and Runtime ZIP | One shared private S3 bucket; table records ownership, size and version | No per-user bucket |
| Draft, modal, scroll, ephemeral access token | Browser memory; PKCE state briefly in sessionStorage | Not account state |

A conversation row has a stable primary key and a sparse GSI sort key updated on each committed turn. Derive the initial short title from the first user message (trimmed and length-bounded), not an extra model call. Reuse the table's time index with a distinct `CONVERSATIONS#sub/project` partition; its current physical name `UsageByTime` can be migrated to `ActivityByTime` only on a stack we own, with a documented CloudFormation transition. Do not silently rewrite another deployment. Conversation TTL follows Memory's current 30-day event retention, and reads filter expired rows because DynamoDB TTL is asynchronous. If longer history becomes a promise, change both retention and metadata TTL first.

This is one deliberate projection, not a second chat store. A Memory-only recent list would fetch events for every visible session and still lack documented last-activity sorting. Table metadata can be rebuilt from Memory if a write fails; message content is never duplicated there.

## Planned narrow Runtime API

Inputs carry IDs but not owner, role, or actor ID. The Runtime validates shape/scope, returns stable error codes, and binds opaque cursors to the caller/filter. Keep `workspace.get`, `usage.get/list`, and `chat.send` rather than adding a generic AWS or batching API.

| Area | Commands and result |
| --- | --- |
| Conversations | `conversations.list({projectId,agentId?,cursor,limit})` returns recent metadata; `conversations.get({projectId,agentId,conversationId,cursor?})` returns chronological Memory events, terminal receipt/status and cursor. Add rename/archive only after open/list works. `chat.send` terminal event names request and conversation IDs. |
| Models | `models.list` serves the fixed reviewed JSON catalog to the agent dropdown. Add/update IDs and estimates in source control after checking AWS model compatibility and pricing; no admin model mutation API or separate dialog. A capped paid smoke should verify each newly selected provider/model under the Runtime role before claiming it works. |
| People/defaults | Existing `users.list` gains cursor/limit; `users.setRole` and `users.setEnabled` update Cognito; `users.setLimits({sub,budgetMicroUsd?,storageBytes?,inherit?})` stores only explicit overrides. `defaults.set` supplies inherited values, instead of freezing defaults in each user's first-login row. |
| Usage | Existing `usage.get/list` gain admin selected-user scope and component quality/price-source fields. Keep request plus tool rows, 30/90-day time ordering and rate snapshots. CSV can page the existing API from the browser before adding an export service. |
| Projects/agents | `projects.list/put/archive` start owner-only; `agents.put` becomes revisioned create/edit and `agents.archive` hides a config without deleting historical chat/usage. User/project defines actor; agent/conversation IDs stay separate. Shared membership waits for a real collaboration contract. |
| Later capabilities | Narrow `integrations.*`, `credentials.*`, `skills.*` and object presign/commit commands expose metadata/status, not secret bodies. Gateway target schemas and Cedar permits remain reviewed and default-deny. |

Bedrock is the first production model provider because the Runtime already uses ConverseStream. A small checked-in models.json carries five Bedrock profiles and a visibly disabled Gemini 3.8 Flash option, grouped by company. The five base rate cards came from the AWS ListFoundationModelAgreementOffers API in eaap/us-east-1 on 2026-09-22; cost totals remain estimates because long-context tiers and non-model charges are not fully handled. Google's introductory rates have a dated expiry and are informational until there is a direct adapter and AgentCore Identity-backed credential. A Gemini adapter is a later **provider-specific** option, not a reason to move ordinary inference or API keys into the browser. It must report Gemini's actual token/cache meters and produce the same usage quality/terminal chat contract. Do not promise “all models” across providers; the catalog is deliberately narrow and reviewed.

### The cross-store failure rule

`chat.send` crosses model, managed tool, Memory, and DynamoDB; one Runtime does not make them atomic. The first production-safe version should add an immutable JSON metering receipt to the same [Memory CreateEvent](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_CreateEvent.html) that stores user/assistant content. The receipt contains schema version, request ID, model/rate snapshot, reported meters, tool-call facts, and calculated cost. It is recovery evidence, **not** the budget ledger. Follow with an idempotent table transaction for completed marker, usage/tool rows, period sum, and conversation metadata. Emit `message.done` only when both stores succeed.

If the transaction fails after Memory succeeds, report an uncertain failure and expose bounded owner-scoped reconciliation that reads the receipt and repairs ledger/metadata exactly once. An open-by-ID path must find the Memory event even if its navigation row is absent; a recovery operation can rebuild recent metadata. Reconciliation has only Memory's retention window; older missing receipts require billing-based correction and an explicit unknown-quality period, not fabricated usage. If DynamoDB is unavailable at admission, start no model work. If a model/tool fails after reporting meters but before Memory commit, record only *observed* partial usage as a failed request; unknown meters stay unknown, not zero. Test duplicate Memory client tokens, lost responses, and injected table failures against real Memory/DynamoDB with scripted inference. Do not claim complete monetary enforcement before this recovery path and non-model price coverage are demonstrated.

### Security and scope rules for the later APIs

An Administrator sees combined usage and controls account policy, not private chat contents by default. Members manage only their owned project/agents/credentials. Auditors have explicitly scoped read views and cannot chat or mutate. A project starts as user-owned, so `sub/project` is both the Memory actor scope and the table/S3 owner prefix; do not accept an actor string from the browser. A role change may briefly produce zero or two Cognito groups, during which the Runtime rejects access rather than guessing; the admin operation must report/repair partial changes. JWT groups can be stale after role/disable changes, so phase 3 must measure revocation behavior and either recheck current Cognito state for sensitive calls or document/bound the delay with token lifetime. Secret values go to a managed broker/vault and never return through list/get, prompt text, browser logs, or usage rows. Code Interpreter receives only ephemeral scoped access, not long-lived Jira, OneDrive or AWS keys.

## Delivery sequence and completion gates

Each slice is a small WHY-focused commit or closely related pair. Implement a real UI caller through Runtime, update current-behavior docs, add a generic story in `tests.js`, run local and relevant live checks, inspect screenshots, then push and verify GitHub Pages. No permanent smoke user, event, object, or stack.

### 0. Remove first-use blockers

Use the checked-in exact profile IDs, review Runtime IAM for cross-region destinations and first-time third-party model access, and make capped paid turns in a disposable stack. All five produced an initial successful smoke turn after AWS's required global destination/model IAM resources were added, but Opus 5.5, GPT-6 Sol and GPT-6 Luna later showed NOT_AVAILABLE Marketplace agreement status in eaap; Luna then failed with AccessDenied. AWS documents this temporary first-use success while subscription setup is pending. Do not auto-subscribe or accept third-party terms from a test without an explicit account-owner decision. Keep scripted echo as the only inference mock in routine tests.

Gate: a member sees the fixed company-grouped dropdown and sends a real conversation using a supported entry. The CLI catalog observation is not itself proof of invocation. AWS [model discovery](https://docs.aws.amazon.com/bedrock/latest/userguide/models-get-info.html), [ConverseStream](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html), and [global inference IAM](https://docs.aws.amazon.com/bedrock/latest/userguide/global-cross-region-inference.html) are changing external contracts.

### 1. Make chat a chat client

Conversation list/get, one navigation row per saved session, recent chats, explicit New chat, reopen after reload, pending/completed/failed-or-uncertain turn state, terminal SSE validation, and the Memory metering receipt are implemented. Next, add idempotent on-demand ledger/metadata reconciliation described above before presenting this as reliable saved chat; then safe code-block display and stronger interrupted-stream recovery. Preserve one sticky Runtime session per signed-in browser, but never confuse it with a durable Memory conversation session. The initial view must be useful with one agent and understandable with none.

Gate: two agents and two conversations survive switching/reload; a network cut after a text delta never masquerades as completion; a foreign conversation yields 404; the UI can reopen a Memory event when navigation metadata is missing. Test session pagination and 30-day expiry, not just the first two turns.

### 2. Maintain catalog and finish agent lifecycle

Keep a short model-catalog review checklist and test each added model with a capped, explicitly opt-in live story. Update checked-in rates when pricing, context tiers or regions change; old usage keeps its actual rate snapshot. Agent edit/archive uses revisions and retains historical conversation identity. Do not build an admin model table/dialog.

Gate: unsupported adapters are disabled in the dropdown; an unavailable model produces a clear error rather than an unmetered success; each model capability is probed with the Runtime role rather than assuming the CLI administrator's access applies to it.

### 3. Make administration and usage trustworthy

Page Cognito users; add role/enable controls and safeguard the last usable administrator (self-demotion/disable is forbidden; concurrent admin mutations need a tested serialization or an explicitly weaker guarantee). Measure how quickly a disabled/demoted user's existing JWT loses access. Distinguish inherited defaults from explicit overrides. Show per-user effective budget, current measured spend/period, selected-user and all-user request/tool timelines, quality labels, and 30/90-day sort/pagination. Add budget-zero, UTC reset boundary, duplicate-request, admin/member/auditor, cross-user, and concurrent-admission tests. Do not show 5 GB “remaining” until objects are counted.

Gate: an invited Member cannot invoke admin APIs; an Auditor cannot chat/mutate; admin and selected user see the same ledger; default changes affect inheritors but not overrides; no pending cost can strand a user. When migrating any existing per-user materialized defaults, preserve them as explicit legacy overrides unless the administrator deliberately resets inheritance.

### 4. Add user-owned projects without multiplying compute

Implement create/list/rename/archive, make all agent/conversation/skill/object APIs derive owner/project consistently, and retain `main` as default. Test same agent/session IDs in two projects, cross-project isolation, and archived-project read/write policy. Defer shared memberships until credential inheritance and collaboration permissions are specified.

Gate: two projects use one Runtime and cannot mix Memory histories, agents, objects, or grants. Budgets remain per user unless an explicit project budget feature is later requested.

### 5. Deliver one secure integration end to end

Choose one narrow Jira- or OneDrive-like Gateway target, not an arbitrary-URL proxy. Admin defines approved target schema/policy; user adds a scoped credential through managed Identity/vault flow only after JWT-invoked Runtime and browser OAuth are proven. Table records owner scope, type, display name, status, tags and secret reference, never the body. Test allowed/denied policy, rotation/revocation, error propagation, and per-call usage. No raw API key is injected into model text or unrestricted Code Interpreter.

Gate: a user can connect, call, inspect, and revoke one integration without manually editing the stack; another user cannot discover or invoke that credential. The target remains default-deny until the exact permit is installed.

The minimal credential record is `{id,provider,authKind,scope,ownerSub?,projectId?,displayName,status,secretRef,createdAt,updatedAt}`. Scope is one of account, user, or user/project; table partition keys implement authorization/filtering, while AWS tags (`app`, `stack`, `owner-sub`, `project`, `integration-id`) support inventory and cleanup, never access control by themselves. The UI accepts a new/rotated secret once and never reads it back. Agent grants refer to credential IDs and reviewed operation IDs. A later Google Cloud integration should use the same scope/metadata contract with its own OAuth/service-account flow and narrowly scoped Gateway operations; it must not turn into “arbitrary Google Cloud API from code.” For S3 in our own stack, prefer the Runtime's scoped role/presigned object flow over user-supplied long-lived AWS keys.

### 6. Skills, objects, Browser, and storage

Add reviewed, versioned skill manifests and a shared-bucket object flow with owner/project tags, content limits, presigned upload/commit, measured bytes, and on-demand orphan reconciliation. Agent config pins allowed skill versions. Add managed Browser as a separately permitted tool with a real live story. Tool credentials remain ephemeral, scoped and auditable.

Gate: the 5 GB policy is enforceable, denied grants remain denied, one Browser and one Code Interpreter story hit real managed services, and no test object/session survives cleanup.

### 7. Optional deployment-admin mode and release hardening

CLI + CloudFormation remain the supported bootstrap. Build a distinct browser deployment-admin modal only if required CloudFormation and bootstrap S3 CORS/SigV4 operations are proven with temporary administrator credentials; never mix those credentials with Cognito user roles. Review rollback, logging/redaction/retention, IAM and Cedar policies, AWS billing reconciliation, origin/CSP behavior, accessibility, and representative real-model/tool latency. Preserve the public GitHub Pages URL.

Gate: a clean browser can use the published app; the owned stack can update/teardown without orphaning resources; the UI describes exactly which expenses it bounds and which remain partial.

## Development and test loop

1. Read the parent `index.html` Solid header and only the affected regions of `agentcore/index.html`, `controller.js`, `template.yaml` and `tests.js`; use `rg` to find other readers/writers of a changed rule. Keep pure price/period math in `accounting.js`, browser stories in `tests.js`, server orchestration in `controller.js`. One dense page stays maintainable when regions and product names are stable, not when it accumulates hidden generic helpers.
2. For each slice write a discriminating ordinary, interruption/failure, and cross-owner story. Run `npm run csp:sync`, `npm test` in `agentcore`, root `npm test`, and the smallest relevant browser story. Call `_screenshot` on full desktop/mobile states and specific dialogs; inspect DOM dimensions, font sizes, line height, focus, overflow, spacing, alignment, contrast and actual screenshot pixels. Do not equate a green DOM assertion with a good UI.
3. Reuse one **named disposable** CloudFormation stack during development. Build a content-addressed CodeZip, upload to only its shared bucket, update that stack, and use a fresh Runtime session ID when verifying newly deployed code. Fixtures create temporary Cognito users and track request IDs, Memory sessions and objects before invoking; `finally` removes each fixture. Scripted echo can simulate model output/failure/meters; Cognito, Runtime, Memory, DynamoDB and managed tools stay live. Local checks should take seconds; live stories should be narrow; run slower real-tool and paid-model stories at their gates.
4. Reuse the parent `server.js`. Check local origin, then make simple WHY commits, push, and verify the GitHub Pages artifact. At session end delete only the exact verified disposable stack and its retained versioned bucket after checking tags/content, then confirm deletion. Never touch unrelated `eaap-ac-*` resources or the user's untracked `.agents/`.

## Review: scenarios that can reject this plan

- **Normal first use:** A new user sees the maintained Bedrock catalog in the agent dropdown, creates an agent, and chats without a model-admin setup step. If the selected profile is unavailable to this account/Region, the user sees a clear error; source-control maintainers update the fixed list after investigation.
- **Interrupted chat:** A response streams text, Memory commits, then the table transaction fails or the browser disconnects. The UI shows uncertainty, reopening finds the event, and reconciliation charges its recorded meters once and restores navigation. If the model reported no usage, show unknown rather than zero. This is why one Runtime is not mistaken for an atomic transaction.
- **Ownership:** Member A guesses Member B's agent/conversation/credential ID. The same scoped 404/denial occurs in list, get, chat, and tool invocation. Adding a project cannot introduce an alternate path around that owner check.
- **Next provider/tool:** A new tool changes its narrow adapter, grants and metering, not Cognito identity, Memory actor/session rules, the frontend chat protocol, or raw secret handling. If provider-specific conditionals proliferate in `index.html`, revisit the API boundary.
- **Resource and complexity:** One Runtime plus Memory/table/bucket/Cognito remains the base. One shared sparse time index is preferable to a second table; a second Runtime/Lambda/local database adds independent deployment or duplicated state without helping first-use chat. Gateway/Policy already exist but can become optional for fresh stacks if idle cost/creation time justifies it. Do not assert a latency improvement without a measured caller path.

Open before a production monetary claim: real-model and tool compatibility under the deployed Runtime role; first-time Marketplace access; current provider prices; native Code Interpreter/Browser, Runtime, Memory, embedding, S3 and Gateway charges; cross-store recovery under fault injection; long-term chat retention beyond 30 days; and browser CloudFormation CORS. Resolve each with the smallest live experiment, not a mock or assumption.
