# AgentCore Chat cutover contract

Status: implementation and live-test record, updated 2026-10-10. This
document distinguishes a working slice from the remaining milestones. The
buildless documents, one V2 Runtime, one Memory resource, one table, and one shared
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
Usage page shows period and 30/90-day model estimates, request detail,
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
navigation and cannot run/edit until restored. The independent Users and Usage
pages use the shared authenticated shell. The company-grouped reviewed `runtime/models.json`
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
it. The October 10 slice audits the new private credential transport, metadata,
browser persistence, output redaction, and disposable Runtime logs; arbitrary
code transformations and account-operator telemetry remain separate audit scope.

## Slice 4: independent pages, private credentials, native background runs

Each of Chat, Profile, Users, Usage, Agents, Connectors, and Credentials owns
an `index.html` and external `app.js`. Shared bootstrap validates current Runtime
identity on every document and fetches no feature data. Ordinary directory links
work under the GitHub Pages installation subdirectory without rewrites. The root
PKCE callback stores/restores the requested destination. Deployment descriptor,
tokens, and opaque Runtime session ID use deployment-isolated tab storage;
sign-out clears authentication and broadcasts to other open documents. A protocol
version check refreshes an old warm Runtime binding once during rollout.

Users is a compact paginated list with invitation and account defaults. Its links
open Profile, which uses `users.get` with the exact `users.list` projection, shows
inherited/effective limits, and links to selected-user Usage. Own profiles are
available to all roles; another user's profile and edits require administrator
authorization. Protected administrator controls remain enforced server-side.
Usage retains detail, summaries, advanced filters, pagination, and reconciliation;
meaningful filters live in the URL. Agents includes Projects and Files & skills,
revisioned edits, archive/restore, model/tool compatibility, and explicit grants.
All entrypoints share typography, responsive navigation, keyboard focus, save
feedback, errors/loading/empty states, and unsaved-form protection.

Private `CREDENTIAL#id` and `CONNECTION#id` rows replace the legacy bundle in the
existing user partition. Credentials list/create/rename/rotate/delete never
return saved secret values. Connector writes accept a compatible `credentialId`,
never an API key. Revision-checked transactions update both connector configuration
and credential references. In-use deletion is refused. Each legacy bundle migrates
atomically and idempotently at its observed revision, preserving connector IDs
and agent grants. Administrators cannot read another user's credentials.

`chat.start` acknowledges only after accepted identity/context, request row,
branch lock, and active-conversation metadata are persisted. Matching duplicate
starts return the existing request; changed input conflicts and competing branch
turns are rejected. The model/tool loop runs independently of the HTTP observer.
`chat.status`, bounded reconnectable `chat.watch`, and cooperative `chat.cancel`
expose its lifecycle; `chat.send` remains a start-and-watch adapter. Private
sequenced S3 progress chunks expire after seven days. Durable history, request
records, and accounting remain. `/ping` is `HealthyBusy` while tasks or tool
cleanup are active and returns `Healthy` in `finally`. Reload, navigation,
sign-out, and closed browsers detach observers without cancelling work. Metadata
discovers active main and pending-fork requests on return. Stale Runtime work
becomes `outcome_unknown`; no automatic inference or tool replay occurs.

## Remaining ordered milestones

1. Validate saved-output edge cases (large files, interrupted transfer, retries),
   audit account-operator telemetry beyond the new credential paths, and complete
   billing reconciliation for managed tools/Runtime/storage. Current usage is
   reported-token estimates plus explicitly unpriced tool events.
2. Design automatic Runtime-loss recovery separately from native background
   execution. Any future scheduled wake/worker path must select stored owned task
   IDs, recheck current authorization, and pass forced-session-loss tests before
   enabling recovery. No machine secret or EventBridge worker exists in this slice.
3. Recover an interrupted tool call with an ordinary agent read-back, not a
   provider-specific recovery engine. Before a potentially mutating step,
   checkpoint its safe intent and target reference; mark its result observed
   when complete. A started step without an observed result has an unknown
   outcome. The resumed agent must use normal read-only GET/HEAD/list tools
   to inspect that target before making a dependent change. A confirmed
   effect is not repeated. Reliably confirmed absence permits one retry with
   the original idempotency key where supported. If read-back is ambiguous
   or the target cannot be identified, do not repeat or depend on the write;
   continue independent safe work and finish `completed_with_uncertainty`
   with a precise visible warning. A 404 is not necessarily proof of absence,
   and multiple effects inside one Code Interpreter call are not atomic.
   Reuse the existing tool-call bound; add no generic verifier, recovery API,
   or claim that the Runtime can enforce HTTP methods inside generated code.
   Recheck current user status, grants, and budget before new chargeable work;
   recreate ephemeral tool sessions without revoked credentials. This future
   tool recovery is separate from the implemented `usage.reconcile` ledger
   repair.
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

2026-10-10 pages evidence: both repository and AgentCore `npm test` passed.
The root suite reported 91 tests plus four tab-lifecycle stories. AgentCore
checks seven CSP/import maps, accounting/model/Gemini protocols, credential
transactions/migration, independent run admission/final-event ordering,
controller authorization, desktop/mobile page journeys, PKCE return/refresh,
deployment isolation, sign-out broadcasts, and confirmation keyboard/focus.
Desktop/mobile Profile, Users, Usage, Agents, Connectors, Credentials, and Chat
captures were inspected under `.artifacts/screenshots/pages/`.

Reusable disposable `agentcore-pages-test-1a0fd5f0` validated final
`controller/d10ad44c002c5e960b60.zip` (443,762 bytes). Preserved foundation and
roadmap regressions passed project isolation, nested/first-turn branches,
uploads/skills, quota inheritance, Memory-loss archive reopen, request detail,
reconciliation, protected administrator controls, archive/restore, and exact-byte
deletion. Managed Web Search and Browser passed real service calls. The seven
requested models each passed real inference and Code Interpreter with durable
results and observed charges during this slice; subsequent fixes changed only
stream finalization and the `chat.send` admission-error adapter.

The full pages suite passed self/admin/Auditor enforcement, disabled identities,
foreign-resource denial, credential reuse, concurrent rotation, in-use deletion,
repeated bundle migration preserving IDs/grants, accepted-request deduplication,
competing branch denial, navigation, explicit sign-out, fully closed Chromium,
watcher detach/reconnect, pending-fork refresh, one committed result/charge set,
cooperative cancellation with observed usage, and forced Runtime loss yielding
`outcome_unknown` without replay. A real granted Code Interpreter echo verified
raw/base64 credential output redaction. Scoped CloudWatch Runtime log checks
found no raw/base64 synthetic credential values. CloudTrail lookup returned no
`InvokeCodeInterpreter` events to inspect; this is not evidence about unconfigured
data-event trails or account-operator telemetry. No arbitrary-transformation
redaction guarantee is claimed.

Disposable artifact updates changed only Controller with replacement `False`.
A read-only production-template comparison preserved all 20 resource logical
IDs. After explicit user authorization, the validated artifact was uploaded and
production change set `pages-review-982f01ce-b302-4625-a706-11b12ae1b3ee`
was prepared on 2026-10-10. CloudFormation reports `CREATE_COMPLETE` and
`AVAILABLE`: Controller, ControllerRole, and SharedObjects are modified with
replacement `False`; every changed property requires recreation `Never`.
All parameters except ControllerCodeKey retain their production values, including
the root callback; scripted inference remains disabled. The review record is
`.artifacts/pages-production-review.json`. Following explicit authorization to
continue the rollout, the change set was executed on 2026-10-10 and reached
`UPDATE_COMPLETE`. A before/after comparison verified all 20 physical resource
identities were preserved. Commit `9aa26cb` published the pages through the
existing GitHub Pages workflow, run `38053727311` (`success`). The exact staged
release also passed AgentCore `npm test`, including a CSP-check portability fix
for Git's Windows/Linux line endings, using an isolated export of the release
with the original root server and only the required external-module coverage
change. Unrelated root-app edits were excluded from publication.

From the published production origin, all 21 page/shared assets matched source.
PKCE returned to Users; Users -> selected Profile -> filtered Usage and `90d`
refresh passed. All seven direct-page refreshes and mobile navigation passed.
Temporary private credential creation/reference/rotation/deletion passed.
A real Haiku 5.5 request completed across navigation, with one Memory event and
one model-usage row despite a duplicate start, and its saved answer reopened in
Chat. Production catalog reads exposed all seven requested models with scripted
inference disabled. Settled desktop/mobile screenshots were inspected, including
loaded Profile and Agents and the Credentials empty state; no page errors or
error notices occurred. Both smoke identities, their owned records/objects, and
their Runtime sessions were removed in `finally`. Records are
`.artifacts/pages-production-smoke.json` and `pages-production-visuals.json`;
captures are under `.artifacts/screenshots/production/`. Reproduce the bounded
production smoke with `node scripts/test-production-pages.js`; use
`--visual-only` for page checks without repeating inference or credential writes.
Set `AWS_PROFILE` to use a named CLI profile instead of `.env` keys.

The top-bar redesign (commits `918b150` through `5dedfb3`, Pages run
`38083551319`) passed the same production smoke on 2026-10-10, with no Runtime
or template change. A temporary administrator signed in through published-origin
PKCE. The account menu reached Profile, Users and Credentials, and the mobile
sheet reached Credentials. Measured Runtime calls took about 0.4-0.75 s each
(`session.get` median 521 ms, no non-200 responses). Stored tokens rendered the
optimistic shell within about 20 ms of document start, and each page reached
`ready` in 0.44-0.79 s. The smoke now also continues the conversation through
the composer. That exposed a bug shipped in `9aa26cb`: the terminal `run.status`
snapshot repeats the last progress `sequence`, the observer dropped it as a
replay, and every UI-sent turn reconnected `chat.watch` about every 500 ms
while the UI stayed on "Working…". After the client fix (`ce96a49`), a real
Haiku 5.5 turn sent from the composer showed the run indicator at 0.9 s, the
answer at 2.9 s, and settled at 3.6 s on one `chat.watch` call. Evidence
records add `rpc` latencies, `boot` phases and `uiTurn` timings; captures
include `chat-ui-turn-running.png` and `chat-ui-turn-settled.png`.

Commit `547a28c` (Pages run for that commit) moved page content to one
Runtime round trip with no Runtime change. Pages mount on token-derived
identity while `session.get` confirms it. Usage and Agents overlap their
independent reads, and page switches use cross-document view transitions.
Against the published release, content appeared after 0.95-1.66 s on every
page except Chat (about 0.55 s). After the change it appeared in 0.43-0.72 s
on all seven pages, including the full smoke and a composer turn settled in
3.0 s. The first attempt (`314d4e4`) broke published sign-in for about 20
minutes until revert `f5dbead`. A tab's Runtime session ID is new after login,
and AgentCore answers HTTP 409 `Session operation in progress, please retry`
to any call that overlaps creation of that session's microVM; `session.get`
lost that race. The client now retries that 409, which the controller never
returns. The same race already affected Chat's overlapped `workspace.get`
after sign-in. Mocked stories could not show it, so this was diagnosed with
`node scripts/test-production-pages.js --local`, which serves the checkout on
the pool's registered `LocalUrl` callback and uses real Cognito and the
production Runtime without publishing. Hover prerendering with speculation
rules was left out: automation never showed an activation, and a prerender
started without the tab's session storage could render a signed-in user as
signed out. Profile and Users remain about 0.65-0.75 s because `users.get`
and `users.list` are slower server-side.
`prepare-production-change-set.js`
prepares review only, preserves every other parameter with `UsePreviousValue`
(including NoEcho), refuses production scripted inference, records replacements,
and never executes the change set. Preserve the root callback and all existing
resource identities during rollout.

Reproduce from `agentcore/`: `npm test`; `node scripts/test-live-pages.js`
for the recorded disposable stack; append `runtime-foundation`, `runtime-roadmap`,
`runtime-web`, or `runtime-model` for the preserved protocol/tool/provider gates;
`node scripts/test-credential-logs.js` for scoped log checks. Use the exact
validated ZIP with the production-review script only after authorization.
Disposable cleanup verifies both stack purpose and retained-bucket stack tags;
smoke identities, owner records, objects, and Runtime sessions are cleaned in
fixture `finally` blocks. Native background execution is implemented; automatic
Runtime recovery, OneDrive OAuth, customer AWS roles, editable personal identity,
and complete billed-cost reconciliation remain separate work.

After validation, the owned disposable stack and its tagged retained bucket,
including exact object versions/delete markers, were removed. The initial
rolled-back bootstrap had zero remaining resources and its stack record was
also removed. Production resources were excluded from cleanup.

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
