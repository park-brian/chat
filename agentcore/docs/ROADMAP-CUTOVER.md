# AgentCore Chat cutover contract

Status: implementation and live-test record for the 2026-09-25 roadmap. This
document distinguishes a working slice from the remaining milestones. The
buildless page, one V2 Runtime, one Memory resource, one table, and one shared
versioned bucket remain the deployment shape. The production origin is
`https://park-brian.github.io/chat/agentcore/`.

## Slice 1: accounts and observed usage

The Runtime rechecks Cognito's **current** enabled state and sole group before
accepting each invocation. JWT groups alone are not sufficient after an admin
change. `users.list` is paginated and returns current role/status, inherited
markers, effective limits/cadence, and counted bytes. Administrators can
`users.setRole`, `users.setEnabled`, and
`users.startNewBudgetPeriod`. The stack may designate a
`BootstrapAdministratorEmail`; its resolved subject is protected from UI
demotion/disable. The dev stack without that parameter protects its first
administrator. An administrator does **not** gain private chat or credential
read access.

The account defaults row supplies live inherited budget, storage, and cadence.
Nullable per-user overrides mean inherit; zero is restrictive, not missing.
`periodKey(cadence, UTC date, epoch)` computes lazy daily/weekly/monthly
windows. An admin reset increments the user epoch and starts an empty period on
the next read/admission. No cron budget reset or pending budget reservation
exists. Concurrent overdraft remains a deliberate user-favorable race.

Admission writes `USER#sub / REQUEST#id` before chargeable work. Each reported
model step transacts an immutable `USAGE#time#id#MODEL#step` event, its
request aggregate, its current period, and `DAY#UTC-date` before another
model/tool step. Managed tool completions similarly write unpriced tool events
and counts. The request row links its exact step keys. `usage.request` returns
that bounded detail; `usage.list` supports 30/90-day or bounded explicit
dates, self/selected/all users, project/agent/request/tool/kind/quality/status
filters, time order, and filter-bound pagination. `usage.daily` reads the
same-table daily summaries, including a combined administrator view. The
single Usage modal shows period and 30/90-day model estimates, request detail,
and separate unpriced tools. These are token-and-reviewed-rate estimates,
**not** delayed AWS billing or a complete dollar cap.

A provider/tool error after metering leaves those events intact and the request
marked `outcome_unknown`; missing provider usage is not silently called
free. Memory or navigation failure cannot roll back observed cost. Before the
final navigation transaction, the Runtime stores its prepared small
transaction on the request. `usage.reconcile` can replay that transaction
idempotently after an ambiguous navigation write, check the exact archive
object first, or mark a request older than one hour `outcome_unknown`.
It does not manufacture usage for a provider call whose outcome was never
reported. The prepared transaction contains IDs, ancestry, title, rates and
object location, not full messages or secrets.

## Slice 2: new durable conversations

Memory retention is set to its CloudFormation-supported 365-day maximum.
**Cutoff rule:** a conversation whose first committed turn occurs after this
controller cutover receives `durable=true`; older dev conversations do not.
No old history is scanned, backfilled, deleted for migration, or promised
beyond its existing lifetime. An old navigation row with no Memory messages
returns `historyExpired`, and the UI blocks continuation rather than showing
an invented empty chat.

For each new durable turn, the Runtime writes one immutable JSON object under
`users/sub/project/chats/conversation/request.json`. It contains the user and
assistant text plus the same receipt as Memory. The owner/project table
partition stores only archive key, exact S3 version, measured bytes,
`eventId`, parent event, branch, and Memory session ID. The conditional
navigation transaction links the archive, head, and user byte counter.
Archive reads follow parent IDs to reopen a selected path from S3 even when
Memory events are gone. A continuation uses archived context and starts a
fresh Memory session if a native branch root has expired; its archived parent
still enforces the expected-head check. Persistent turn admission stops when
the user-wide logical storage counter is at its limit. A turn admitted just
below the limit may finish over it rather than discard its answer.

`conversations.delete` marks a conversation DELETING before cleanup, making
new turn commits conflict. Repeated calls delete exact archived S3 versions,
decrement bytes once with conditional archive-row removal, delete owned Memory
events and branch rows, then remove navigation. Usage stays. AgentCore Memory
currently exposes event deletion, not a session-delete API; empty session
metadata may remain until service expiry. The UI confirms deletion and retries
bounded cleanup calls. A failed delete remains recoverable as DELETING.

## Slice 3: current workbench boundary

`agents.setArchived` is revision checked. Archived configurations remain
available to reopen historical chats, but are absent from active agent
navigation and cannot run/edit until restored. The Users and Usage controls
share the existing modal. The company-grouped reviewed `models.json`
remains the sole model catalog; there is no admin model table.

The renderer formats fenced code as text nodes inside scrollable blocks;
ordinary HTTPS links remain explicit anchors. Enter-to-send respects IME
composition. A turn may select up to four owner/project-scoped files or saved
artifacts. The Runtime validates the exact active object rows before admission
and places only short-lived, version-pinned read URLs in that turn's ephemeral
Code Interpreter workspace `selected-files.json`. No bucket key or AWS
credential is given to the interpreter. The URLs are redacted from returned
tool output and disappear when the session ends; a later turn must select its
files again. The per-turn **Save outputs** switch alone exposes
`save_artifact` to the selected model. The model must first create a regular
file below `outputs/` in that turn's Code Interpreter session. The Runtime
checks the resolved path, MIME type, measured size (1 to 100,000,000 bytes),
and user-wide quota; it grants only a five-minute presigned POST to the
specific staging key. After upload, the Runtime verifies actual bytes, copies
to the private saved key, and activates the existing object row and byte
counter transactionally. A request-scoped idempotency key identifies the
output; ambiguous copy/accounting can be repaired through the same pending
object path. The interpreter receives neither bucket credentials nor general
S3 write authority. Completed artifacts appear in Files, can be selected on
later turns, and are removed through the normal object API.

`connections.test` uses read-only GitHub `GET /user` or Jira Cloud
`GET /rest/api/3/myself`. A Jira probe is restricted to a direct
`*.atlassian.net` HTTPS host without redirect to prevent the stored token
from becoming an arbitrary URL probe. It returns only success, HTTP status,
and a bounded account label. Members cannot test another owner's connection;
Auditors cannot use a stored credential. The full credentials continue to be
injected only into explicitly granted code sessions. Generated code can
exercise the key's full external scope; a UI intent label does not attenuate
it. A full credential transport/log audit is **not yet implemented**.

## Remaining ordered milestones

1. Finish workbench: complete focus/keyboard and responsive polish,
   interrupted-stream resolution, the credential transport/log audit, and
   saved-output edge cases (large files, interrupted transfer, retries). Verify
   rotation/revocation in fresh sessions.
2. Separate work from the SSE observer. At acceptance persist owner, project,
   agent revision, branch head, grants, request ID and step checkpoint. Add
   `chat.status`/`chat.watch`, private expiring run state, HealthyBusy only
   while active, and an EventBridge OAuth `worker.tick` wake path. A machine
   token selects due task IDs only; it may not select a user. Automate the
   generated machine-secret handoff without printing it. Do not enable the
   rule before a forced-session-loss live test.
3. Recovery must **investigate**, never blindly replay an uncertain write.
   Persist intent and observed facts; inspect the external target read-only.
   If applied, checkpoint. If absent, retry with the original idempotency key
   where supported, then verify. If unverifiable, assume it may have happened,
   do other safe work, and finish `completed_with_uncertainty` with a
   precise visible warning. Bound investigation and recheck current status,
   grants, and budget before new chargeable work. Recreate ephemeral managed
   tool sessions and never reinject revoked values.
4. Add work/school OneDrive only with a CloudFormation-owned Microsoft OAuth
   provider and AgentCore Identity token vault. Callback must restore Cognito
   identity and verify the initiating state/user. A dedicated workload
   identity serves foreground and recovered runs. Customer AWS access uses
   scoped cross-account role assumption, external ID, and short-lived STS
   credentials, not long-lived AWS keys.
5. Benchmark warm text/tool/background latency; audit IAM/Cedar, storage
   repair, cost quality, accessibility, desktop/mobile visual layout, and
   published-origin behavior. Browser DOM/live view, browser CloudFormation
   administration, project memberships, and project budgets are separate
   optional contracts.

## Verification and release rules

2026-09-25 release evidence: `npm test` in both repository and
`agentcore/` passed. Against reusable disposable
`agentcore-chat-dev-roadmap`, `runtime-roadmap` passed desktop/mobile,
`runtime-foundation` passed, and `runtime-connections` passed with an actual
S3-selected file, Code Interpreter, cross-owner denial, a real GitHub
current-user read, and disposable cleanup. Users/Usage desktop/mobile
`_screenshot` captures were inspected and list typography adjusted.
Production `agentcore-chat-prod` moved to content-addressed
`controller/8b9e6857a2308b062183.zip` by a reviewed change set with **no
resource replacements** and explicit `UsePreviousValue` for its NoEcho
Gemini key. From the published GitHub Pages origin, the real Gemini Browser
two-action turn plus follow-up and the desktop/mobile authenticated
`login` story passed; smoke identities were removed in `finally`.
This evidence does not qualify the unfinished background worker, OneDrive
OAuth, customer STS integration, or arbitrary external-write recovery.

The saved-output continuation used disposable
`agentcore-chat-dev-continue`: `runtime-connections` passed with a real
Code Interpreter-created file, S3 POST/copy, inventory accounting, exact-byte
download and delete. `runtime-foundation` and `runtime-roadmap` passed
against the same stack. Authenticated `runtime-ui` passed desktop/mobile,
asserted that consent is present on only one turn, and produced composer
`_screenshot` captures; both were visually inspected for alignment and
legibility. The first live run exposed an existing repair ambiguity: S3
returned 403 for a missing `HeadObject` without ListBucket. The fix lists
only the exact saved key under a `users/*` IAM prefix condition before
heading a present object. No broader bucket-list permission was added.
Production `agentcore-chat-prod` was updated via a reviewed change set to
`controller/2355030ebfd386cd2270.zip`; only `ControllerRole` policies and
the `Controller` artifact changed, both without replacement. The NoEcho
Gemini parameter and all other stack parameters used `UsePreviousValue`.
Commit `0afa9c7` reached GitHub Pages with the new **Save outputs** control;
published-origin Cognito login passed on desktop and mobile, and a real
Gemini 3.8 Flash text turn completed in 3.6 seconds. The disposable dev
stack was deleted after testing. Its tagged retained bucket contained only
the two known controller ZIP versions; both exact versions and then the empty
bucket were removed. Production resources and user data were not used for
this cleanup.

Run `npm test` for fast protocol/buildless checks. `npm run test:roadmap --
<disposable-stack> --profile eaap --region us-east-1` uses real Cognito,
Runtime, Memory, DynamoDB, and S3 with scripted echo as the sole inference
substitute. It checks archives, quota, forced Memory loss/reopen, request
metering/detail, admin protection/reset, agent archive, failed reported usage,
and idempotent deletion. `test:foundation` remains a project/branch/file
regression. Both stories create disposable smoke users and remove their exact
objects, events, rows, and owner markers in `finally`. Run desktop/mobile
`--screenshot` and inspect the Users/Usage captures; do not infer visual
quality from DOM assertions. CloudFormation is used only for template/ZIP
changes. Preserve production NoEcho parameters when updating the existing
stack. Publish the one-page site only after the live gate, then repeat
published-origin login and a real model turn. Never enable scripted inference
on the production stack.
