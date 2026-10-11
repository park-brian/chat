# Architecture

AgentCore Chat is seven buildless SolidJS pages on GitHub Pages and one
AgentCore Runtime. The Runtime is the whole backend: it authorizes every
call, owns all data, runs agent turns against Bedrock or Gemini with
AgentCore tools, and meters what they use. Data lives in one DynamoDB table
and one S3 bucket. There is no Lambda, API Gateway, or second service.

```
browser ──PKCE──> Cognito
   │ JWT
   ▼
AgentCore Runtime (V2, Node 22 ZIP) ──> DynamoDB table, S3 bucket
   │                                 ──> Bedrock Converse / Gemini REST
   └──> Code Interpreter, Browser, Gateway Web Search, Identity (Gemini key)
```

## Runtime modules

| Module | Owns |
| --- | --- |
| `controller.js` | HTTP server: body decoding, caller check, role rules, error envelope |
| `commands.js` | The command table: every API entry point and its role rule |
| `accounts.js` | Token claims, the cached Cognito revocation check, account owner, defaults and per-person limits |
| `db.js` | Key vocabulary, marshalling, expression builder, queries, transactions |
| `projects.js`, `agents.js`, `objects.js`, `conversations.js`, `credentials.js`, `users.js`, `usage.js` | One command group each |
| `chat.js` | One turn: admission, the provider-agnostic agent loop, the commit |
| `runs.js` | Durable runs: admission and release, heartbeat, progress, watchers, cancellation |
| `meter.js` | Usage rows and rollups for every model and tool step |
| `tools.js` | Code workspace, artifact saving, Web Search, Browser |
| `models.js`, `models.json`, `accounting.js`, `gemini-protocol.js`, `scripted-model.js`, `aws.js` | Catalog and prices, cost and period math, Gemini wire format, the test model, shared AWS clients |

`npm run build:controller` bundles `controller.js` into one content-addressed
ZIP. See [RELEASING.md](RELEASING.md).

## Data

Everything a person owns is in their partition, `pk = USER#sub`. Sort keys
lead with the item type, then its project and parents, so each type is one
prefix query and `#` separators keep `alpha` and `alp` apart. Client ids are
validated by pattern before they become key parts.

| Sort key | Holds |
| --- | --- |
| `PROFILE` | Limit overrides (`budgetOverrideMicroUsd`, `storageOverrideBytes`, `periodOverride`), `budgetEpoch`, `storageUsedBytes`, `activeRequests` (string set, at most 3) |
| `PROJECT#p` | Project name, hidden flag, revision. `main` has no row |
| `AGENT#p#id` | Agent configuration and revision |
| `OBJECT#p#id` | File, skill or artifact: `PENDING` while uploading, then `ACTIVE`. Deleting removes the row |
| `CHAT#p#c` | Conversation: agent, title, last activity, active branch, `activeRuns`, status `ACTIVE` or `DELETING` |
| `BRANCH#p#c#b` | A named path: `headTurnId`, and `rootTurnId` for forks. `main` is a branch like any other |
| `TURN#p#c#t` | One saved turn: `parentTurnId`, branch, request, its S3 body and size |
| `LOCK#p#c#b` | The one running turn on a branch |
| `REQUEST#r` | A turn's run state, costs and progress counters |
| `USAGE#time#r#KIND#n` | One metered model or tool step |
| `PERIOD#…`, `DAY#date` | Budget-period and day rollups |
| `CREDENTIAL#id`, `CONNECTION#id` | Private secret, and the service configuration that uses it (each one revisioned JSON document) |

Account settings are `pk = ACCOUNT`: `OWNER` (the protected administrator)
and `DEFAULTS` (budget, storage, period, revision).

The `ByTime` index orders conversations by activity
(`CHATS#sub#p`, `time#c`), usage across people (`USAGE`, `time#sub#…`) and
day rollups across people (`USAGE_DAYS`, `date#sub`).

Turn ids are `13-digit epoch ms#16 hex`, so they sort by time.

S3, one versioned bucket:

| Prefix | Holds | Lifetime |
| --- | --- | --- |
| `users/sub/p/files/id` | File, skill and artifact bytes | Until deleted |
| `users/sub/p/chats/c/turn.json` | Turn bodies: message, answer, tool calls, cost | Until the conversation is deleted |
| `pending/sub/id` | Uploads before activation | 1 day |
| `runs/sub/r/progress-n.json` | Streamed events for watchers on other workers | 7 days |
| `controller/hash.zip` | Runtime code | Until replaced |

Each fact is stored once. The only derived data are the usage rollups and the
counters (`storageUsedBytes`, `activeRuns`, `activeRequests`), and each is
written in the same transaction as the item it counts.

The browser keeps only `sessionStorage`: the deployment entry, tokens and
Runtime session id, and the PKCE callback state.

## Commands

Every call is `POST /invocations` with `{v: 1, command, input}` and returns
HTTP 200 with `{ok: true, data}` or `{ok: false, error: {code}}`. AgentCore
replaces any other Runtime status with a generic 424, which would hide the
code. Streaming commands answer with server-sent events instead.

Role rules: **write** commands are refused to Auditors and **admin** commands
need Administrators. Everything else is open to any signed-in person and
scoped to their own data, with administrators allowed to read others' usage
and profiles.

<!-- commands:start -->
| Command | Rule | Does |
| --- | --- | --- |
| `session.get` | | Identity, limits and API version |
| `workspace.get` | | Session, projects, agents, models and recent conversations for the chat page |
| `models.list` | | The model catalog |
| `projects.list` | | Projects, `main` first |
| `projects.create` | write | New project |
| `projects.rename` | write | Revision-checked rename |
| `projects.setHidden` | write | Revision-checked hide or show |
| `objects.beginUpload` | write | Records a pending object; returns a presigned POST |
| `objects.completeUpload` | write | Activates an upload and counts its bytes |
| `objects.list` | | Active objects in a project, paged |
| `objects.get` | | A short-lived download URL |
| `objects.delete` | write | Deletes bytes and row, and frees their storage |
| `agents.list` | | Agents in a project |
| `agents.put` | write | Create or revision-checked edit |
| `agents.setArchived` | write | Revision-checked archive or restore |
| `conversations.list` | | Conversations by recent activity |
| `conversations.get` | | One branch's path, its branches and active runs |
| `conversations.delete` | write | Removes turns, bodies, branches and the conversation, resumably |
| `credentials.list` | | Own credentials and the connections using them; never secrets |
| `credentials.put` | write | Create, or revision-checked rename |
| `credentials.rotate` | write | Replace a secret |
| `credentials.delete` | write | Delete an unused credential |
| `connections.list` | | Own connections |
| `connections.put` | write | Create or edit, updating credential references atomically |
| `connections.delete` | write | Delete and release its credential reference |
| `connections.test` | write | Read-only identity check against GitHub or Jira Cloud |
| `usage.summary` | | Current budget period |
| `usage.list` | | Metered steps by time, filtered and paged |
| `usage.daily` | | Day rollups |
| `usage.get` | | Summary, first page and optional days in one call |
| `usage.request` | | One request and its steps; settles a lost run |
| `users.get` | | A profile: own, or anyone's for administrators |
| `users.list` | admin | People with limits |
| `users.invite` | admin | Create a Cognito user in a group |
| `users.setLimits` | admin | Set or clear overrides |
| `users.startNewBudgetPeriod` | admin | Restart spending from zero |
| `users.setEnabled` | admin | Enable or disable; not the owner |
| `users.setRole` | admin | Change group; not the owner |
| `defaults.get` | admin | Account defaults |
| `defaults.set` | admin | Revision-checked defaults |
| `chat.start` | write | Admit a turn; returns once it is running |
| `chat.status` | | A run's state |
| `chat.cancel` | write | Ask a running turn to stop |
| `chat.watch` | stream | A run's events after a sequence number |
| `chat.send` | write, stream | Start a turn and stream it to completion |
<!-- commands:end -->

`tests/runtime.test.js` checks this table against `commands.js`.

## A turn

1. **Validate and read.** The agent, conversation, branch and limits are read
   together. Storage and budget must have room. The model, thinking level,
   tools, connections, files and skills are resolved.
2. **History.** The turn's parent is the fork point or the branch head. One
   query loads the conversation's turn rows; the parent path is walked in
   memory and its newest 20 bodies are read from S3 in parallel.
3. **Admit.** One transaction creates the request row and the branch lock,
   adds the run to the conversation and to the owner's active set (at most 3),
   and checks the branch head is unchanged. DynamoDB's cancellation reasons
   give the precise refusal: duplicate request, `BRANCH_BUSY`, `NOT_FOUND`,
   `BRANCH_CONFLICT` or `RUN_LIMIT`. A lock or slot left by a lost worker is
   reclaimed when it blocks, then admission is retried once.
4. **Run.** Up to 8 model steps, each guarded (cancellation, lost request,
   revoked access) and budget-checked. Tool calls run between steps, at most 8
   per turn.
5. **Commit.** The body goes to S3; then one transaction writes the turn row,
   moves or creates the branch head (compare-and-swap), updates the
   conversation, completes the request, counts the body's bytes and releases
   the lock and slot. If the head moved, nothing commits and the body is
   removed: `BRANCH_CONFLICT`.

Request status is `running`, then `completed`, `failed` or `cancelled`.
`outcome_unknown` means the worker stopped heartbeating for 90 seconds. A
repeated `requestId` returns the existing run; the same id with different
input is `REQUEST_ID_CONFLICT`.

A turn is a Runtime task, not an HTTP response, so it continues after the
browser leaves. Events are numbered. Watchers on the same worker read them
from memory as they happen; others read the S3 progress chunks. A watch ends
with a `run.status` snapshot. If that snapshot is not terminal, the client
reconnects with `after` set to the last sequence it saw.

## Usage and budgets

Every model step writes a usage row, the budget-period and day rollups and the
request total in one transaction, as it happens. Prices are integer
micro-dollars per million tokens, in `models.json`, applied per step and
rounded once. Long-context tiers switch every rate when the prompt crosses
the model's threshold.

| Quality | Meaning |
| --- | --- |
| `estimated` | Provider-reported tokens at the catalog's list price |
| `unknown` | The provider never reported usage (the stream failed, or its report was inconsistent); tokens are estimated at four characters each, priced, and counted against the budget |
| `unpriced` | A tool call, or a Code Interpreter or Browser session's lifetime: recorded, not priced |

The budget is checked at admission and before every step, so a turn stops
when it is spent; concurrency is at most three turns per person. Periods are
UTC days, Monday-start weeks or months. `users.startNewBudgetPeriod` starts a
new period key without editing recorded usage.

Not attributed to people: Runtime compute and memory, DynamoDB, S3, Cognito
and Gateway requests. Those appear only on the AWS bill.

## Tools and credentials

| Tool | Path |
| --- | --- |
| Code workspace | One shared PUBLIC Code Interpreter. A session starts on first use and stops when the turn ends |
| Save outputs | With per-turn consent, a regular `outputs/` file is staged and activated as a quota-counted artifact. Its id derives from the request and idempotency key, so retries converge |
| Web Search | The Gateway's managed Web Search target, SigV4-signed MCP `tools/call`. The Gateway is default-deny; Cedar permits only the Runtime role. Source links are appended to the answer |
| Browser | `aws.browser.v1`: navigate, click, type, scroll and screenshot, each returning a screenshot. Public HTTPS navigation only; clicks may still follow links elsewhere, so this is not a domain allowlist |

Visual Browser needs a model that accepts image tool results: Claude, and
Gemini when configured. GPT-6 rejects them, so the catalog marks it
incompatible and both agent writes and turns enforce that.

A connection grants its credential to an agent's code. For each turn, the
Runtime writes a session-local `.env` with only the granted values, base64
encoded (serialization, not encryption). Wrappers decode them into the
environment of each Python, Node or shell call. Granted code can read and send
those secrets: a grant is full use of the credential's external scope. Raw and
base64 values are redacted from tool output, but redaction is not a security
boundary. Secrets never appear in responses, URLs, browser storage, turn
bodies, progress or logs.

The interpreter has Python, Node, curl, the AWS CLI, pip, npm, `requests`,
`httpx`, `boto3` and `python-dotenv`, and no git or gh. Managed Browser
operations sometimes answer 409 while a session changes state; they are
retried three times with backoff.

## Security

AgentCore's JWT authorizer verifies tokens. `caller()` then requires the
expected issuer, client, access token use, an unexpired token and exactly one
known group. `stillAuthorized()` re-checks the person's enabled flag and group
against Cognito, caching a success for 15 seconds, so a disabled or regrouped
person loses access within 15 seconds (immediately on the worker that made the
change). Every key derives from the verified `sub`. Cursors are re-checked
against the caller's partition. Commands that touch secrets refuse any attempt
to name another person.

Runtime V2 restores workers from a snapshot that includes random state, so
every transaction carries an explicit token from `db.uuid()` (random UUID,
clock and high-resolution time). The worker id is created after restore.

## Latency

A warm call costs about 0.4–0.75 s from the browser; AgentCore's own latency
metric is about 0.37 s at the median. A new Runtime session costs about
2.4 s. Measured on 2026-09-25, full-response medians [ranges] in ms:

| Command | Sticky session | Fresh session |
| --- | ---: | ---: |
| `session.get` | 546–604 [496–1013] | 2403–2546 [2170–6186] |
| `workspace.get` | 553–616 [500–751] | 2258–2502 [2121–3482] |

Decisions that follow:

- A browser tab keeps one Runtime session id until sign-in or sign-out.
- Pages render on the identity already in the tab's tokens and start their own
  reads beside `session.get`, so content needs one round trip, about 0.5 s.
- AgentCore answers 409 "Session operation in progress" to calls that overlap
  a new session's start. The browser sends a new session's first call alone,
  and retries a 409.
- WebSockets would save repeated invocation overhead but add reconnection,
  token refresh and correlation work for little gain, so HTTP stays.

## Browser app

Seven HTML documents share `shared/page.js` (top bar, boot phases, sign-in),
`shared/api.js` (calls, the session-start gate, 409 retry, event streams) and
`shared/session.js` (PKCE, tokens, Runtime session id). The static boot markup
and the CSP, with hashes for the import map and the inline `pagereveal`
handler, are kept in sync by `npm run csp:sync`. Solid is pinned with SRI.
