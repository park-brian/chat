# Usage, budgets, and user-resource accounting

> Historical detailed design. [ARCHITECTURE.md](./ARCHITECTURE.md) distinguishes implemented model-only metering from planned full-cost and storage accounting. Treat future-tense claims below as proposals, not shipping behavior.

Status: normative target design, not yet an implemented meter or quota gate; see [STATUS.md](./STATUS.md)
Audience: product, frontend, broker, Harness, CloudFormation, and test authors
Related contracts: [PLAN.md](./PLAN.md), [API-CONTRACT.md](./API-CONTRACT.md), [IMPLEMENTATION.md](./IMPLEMENTATION.md)

This document is the canonical contract for user cost visibility, budget admission, reset schedules, storage quotas, usage events, reconciliation, and administrator reporting. If another planning document disagrees with this one, this document wins.

## 1. Product promise

Every user can see:

- current spend, limit, remaining amount, overdraft, and exact next reset;
- managed storage used, limit, and overage;
- costs grouped by request, model, project, agent, and meter;
- every model call and tool use within a request;
- whether each quantity/cost is measured, estimated, reconciled, or unpriced.

Administrators use the same user view. They may select a user or an all-users scope, change account defaults, change an individual user's limits, and start a new budget period. There is no independent administrator-only accounting implementation.

The v1 default for every newly created user, including administrators, is:

```json
{
  "budget": {
    "limitMicroUsd": 5000000,
    "schedule": {
      "cadence": "daily",
      "timeZone": "UTC"
    },
    "warningPercent": 80
  },
  "storageLimitBytes": 5000000000
}
```

The deployment administrator chooses the initial account time zone. An application administrator may change it later as part of the account defaults. Five GB means exactly 5,000,000,000 bytes; the UI uses decimal GB consistently.

## 2. Non-negotiable invariants

1. **No reservation consumes budget.** There is no `reservedMicroUsd`, monetary lease, or pending charge.
2. **Pending state never blocks work.** Request status and upload intent are operational facts, not quota counters.
3. **Accepted work may finish.** Crossing a limit never cancels an already accepted request or deletes an accepted upload.
4. **Race overdraft is the platform's responsibility.** Concurrent requests may exceed a limit; the overshoot is visible but creates no debt and is not carried into another period.
5. **Usage is append-only.** Corrections are new adjustment events. Original measured events are not rewritten.
6. **Every cost update is idempotent.** A deterministic event ID prevents a retry or duplicate callback from charging twice.
7. **The authenticated initiator pays.** V1 budget enforcement is per user. Project and agent amounts are attribution dimensions, not independently enforced budgets.
8. **Storage quota is separate from spend.** User spend controls metered execution; storage bytes control managed S3 content.
9. **Unknown is not zero.** An unpriced tool or unavailable billing dimension is explicitly labeled `unpriced` or `estimated`.
10. **Billing and application attribution are different truths.** Delayed AWS billing reconciliation never masquerades as immediate per-user metering.

## 3. Why v1 deliberately has no reservations

The rejected design reserved a conservative maximum before an invocation, released it on finalization, and repaired stale leases on a schedule. It could enforce a stricter ceiling, but a lost finalizer or failed repair could prevent future work. It also required estimates for tools whose final cost is not bounded precisely.

V1 instead uses committed-spend admission:

```text
strongly read active user's current-period summary
if finite limit and actualCostMicroUsd >= limitMicroUsd:
    reject new request
else:
    idempotently accept request
    allow it to finish
```

Two callers may read the same remaining amount and both be accepted. Their actual events may take the period over its limit. This is an intentional, bounded overdraft rather than an accounting corruption.

Exposure is bounded with native per-invocation controls:

- maximum model input/output tokens;
- maximum agent iterations/tool calls;
- Browser and Code Interpreter duration limits;
- Harness/runtime timeout;
- API Gateway throttling and ordinary abuse controls.

Do not reintroduce a persistent concurrency counter as a hidden reservation. A stale active-count row can reproduce the same lockout. UI duplicate-send prevention and platform rate limits are sufficient for v1.

Revisit reservations only if a legal or contractual requirement demands a strict prepaid ceiling. That would require an explicit user-visible lease policy and proof that expiration cannot strand capacity.

## 4. Budget semantics

### 4.1 User policy

```ts
type UserLimits = {
  budget: {
    mode: "hard" | "unlimited";
    limitMicroUsd: number | null;
    warningPercent: number;
    schedule: ResetSchedule;
    epoch: number;
  };
  storageLimitBytes: number;
  sourceDefaultsRevision: number;
  revision: number;
};

type ResetSchedule =
  | { cadence: "daily"; timeZone: string }
  | { cadence: "weekly"; timeZone: string; weekStartsOn: 1|2|3|4|5|6|7 }
  | { cadence: "monthly"; timeZone: string };
```

- `limitMicroUsd` and all costs are integers.
- Weekly v1 resets at local midnight on the selected ISO weekday.
- Monthly v1 resets at local midnight on day 1.
- Rolling windows and arbitrary monthly days are not supported in v1.
- A user's schedule can override the account default.

### 4.2 Period identity

The broker derives a period from `{schedule, epoch, instant}`. Reset is a change in the derived key, not a mutation that zeros a counter.

Example keys:

```text
E3#D#2026-09-22#America-New_York
E3#W#2026-09-21#America-New_York
E3#M#2026-09#America-New_York
```

The API also returns exact UTC `startsAt`, `endsAt`, and `nextResetAt`. Period calculations use an IANA-aware implementation and are tested over daylight-saving changes. Stored events retain their original period even if the user's schedule later changes.

### 4.3 Manual reset

`users.startNewBudgetPeriod` increments `epoch`. It never deletes or edits an old period. It requires an administrator, a reason, an optimistic revision, and confirmation. The next request immediately uses the new epoch's current derived period.

### 4.4 Lowering and raising limits

- Lowering a limit below current actual spend is valid and blocks the next request.
- Raising the limit may immediately allow work again.
- Changing a schedule affects the next admission calculation but does not move historical events.
- Switching to unlimited preserves all usage visibility.
- No policy change cancels work that was already accepted.

### 4.5 Overdraft

For a finite budget:

```text
remainingMicroUsd = max(0, limitMicroUsd - actualCostMicroUsd)
overdraftMicroUsd = max(0, actualCostMicroUsd - limitMicroUsd)
percentUsed = actualCostMicroUsd / limitMicroUsd
```

The UI may show more than 100%. Overdraft is never a negative balance, invoice, or debt. It blocks later work only until the period changes or an administrator raises the limit. It does not reduce the next period.

## 5. Account defaults and user creation

The account-control row holds:

```json
{
  "defaultsRevision": 4,
  "newUserLimits": {
    "budget": {
      "mode": "hard",
      "limitMicroUsd": 5000000,
      "warningPercent": 80,
      "schedule": { "cadence": "daily", "timeZone": "UTC" }
    },
    "storageLimitBytes": 5000000000
  }
}
```

Invitation and first-administrator bootstrap copy the complete limits snapshot into `USER#<sub>/CONTROL`. Existing users do not silently follow later default changes.

An administrator changing defaults chooses one explicit application mode:

- `newUsersOnly` — update defaults only;
- `usersStillOnDefaults` — also update users whose limits still match their recorded source revision;
- `selectedUsers` — update an explicit reviewed set.

There is no implicit `allUsers` mode. Bulk application reports per-user success/conflict and is safely retryable.

## 6. Usage hierarchy and event model

### 6.1 Request as the user-visible unit

A request is one accepted user action sent through `POST /chat`. It captures stable attribution at acceptance:

```json
{
  "requestId": "uuidv7",
  "turnId": "uuidv7",
  "userSub": "cognito-sub",
  "projectId": "main",
  "agentId": "uuidv7",
  "harnessId": "...",
  "sessionId": "...",
  "modelKey": "...",
  "modelRevision": 7,
  "priceCatalogRevision": 12,
  "periodId": "...",
  "acceptedAt": "...",
  "lastObservedAt": "...",
  "status": "accepted|running|completed|failed|cancelled"
}
```

The API derives `stale` when a non-terminal request's `lastObservedAt` is older than the configured threshold. Stale is a display/reconciliation state and has no admission effect.

### 6.2 Cost-bearing event

Every independently measurable component appends one event:

```json
{
  "eventId": "deterministic-id",
  "requestId": "uuidv7",
  "sourceCallId": "provider-or-tool-call-id",
  "sequence": 3,
  "occurredAt": "...",
  "type": "model|embedding|memory|gateway|tool|browser|codeInterpreter|runtime|adjustment",
  "name": "jira.searchIssues",
  "status": "succeeded|failed|cancelled",
  "quantity": {
    "inputTokens": 0,
    "outputTokens": 0,
    "cacheReadInputTokens": 0,
    "cacheWriteInputTokens": 0,
    "requests": 1,
    "durationMs": 0,
    "bytes": 0,
    "nativeUnits": {}
  },
  "priceKeys": [],
  "applicationCostMicroUsd": 0,
  "budgetCostMicroUsd": 0,
  "quality": "measured|estimated|reconciled|unpriced",
  "missingDimensions": []
}
```

Events never contain prompts, responses, tool arguments/results, OAuth tokens, API keys, or arbitrary vendor payloads.

### 6.3 Event commit

One DynamoDB transaction:

1. puts the immutable event only if `eventId` is absent;
2. adds its quantities/cost to the request aggregate;
3. adds its budget cost to the user's period summary;
4. updates affected daily/hourly rollups.

The event ID is derived from the stable source operation plus adjustment revision. Retrying the transaction cannot double-charge.

Cost is committed when a component finishes or exposes authoritative usage—not only when the overall request finishes. If a later tool crashes, earlier model/tool events remain accounted for. A missing request finalizer therefore cannot lose or hold already observed cost.

### 6.4 Corrections

Never edit an event. Append an `adjustment` event that references the prior event and contains positive or negative deltas. Examples:

- late provider usage replaces a provisional estimate;
- a duplicate provider charge is reversed;
- a rate mapping error is corrected;
- account billing identifies an attributable difference.

Negative adjustments may lower a period below its limit and re-enable work. Adjustment history remains visible to administrators.

## 7. Cost classification and calculation

### 7.1 Application and budget cost

`applicationCostMicroUsd` is the best current attribution for the operation. `budgetCostMicroUsd` is the amount counted against the user budget.

Normally they are equal. They differ when:

- a cost is informational but excluded by policy;
- a vendor operation is unpriced;
- account-level infrastructure cannot be attributed reliably;
- an administrator applies an explicit credit adjustment.

The user budget includes model inference, embeddings, attributable Memory/Gateway operations, Browser, Code Interpreter, and Runtime usage when a reliable rate and quantity exist. Managed S3 storage is controlled by its byte quota rather than the daily dollar budget in v1.

### 7.2 Integer arithmetic

Rate rows are effective-dated and store integer numerator/denominator units. Calculate component terms without monetary rounding, sum them, and round upward once for the final event micro-dollar cost.

Each event pins:

- exact provider/billed model;
- region and inference tier;
- context band and cache class/TTL where known;
- rate row IDs/effective instants;
- Harness/model configuration revision.

### 7.3 Quality

- `measured` — native quantity returned for this operation and an approved rate mapping;
- `estimated` — quantity or rate dimension inferred from an explicit documented rule;
- `reconciled` — later authoritative telemetry/billing adjustment;
- `unpriced` — activity occurred but no approved price exists.

An unpriced event contributes zero to `budgetCostMicroUsd` but is prominently counted in `unpricedEvents`. It must never be displayed as free.

### 7.4 AWS billing

The user ledger is the immediate admission authority. Cost Explorer/CUR and CloudWatch are delayed reconciliation sources.

The UI distinguishes:

- application-attributed cost;
- budget-counted cost;
- AWS-reconciled account cost;
- unattributed account cost.

Account-level discounts and infrastructure are not arbitrarily distributed among users. Billing reconciliation cannot create user debt in a later period.

## 8. Request lifecycle and failure behavior

```text
authenticate and authorize
-> derive user/project/agent/period
-> idempotency lookup by requestId
-> strongly read user limits and current period summary
-> deny only if inactive/forbidden/model blocked/already at finite limit
-> write accepted request
-> invoke Harness and stream
-> append component events as usage becomes known
-> write terminal request status when observed
```

Rules:

- A duplicate `requestId` resumes or returns the existing request; it never starts a second chargeable operation.
- A client disconnect does not erase recorded usage and does not invent a charge.
- Cancellation requests stop work when possible; actual completed component events remain.
- A broker/Harness crash leaves a stale request, not reserved spend.
- A late event for a stale request remains valid and is applied idempotently.
- Reconciliation may append corrections or a terminal observation; it is not required to unlock the user.
- Once a limit is observed as exceeded, later admissions fail with `BUDGET_EXHAUSTED`.

## 9. Managed storage quota

### 9.1 Included storage

The 5 GB default covers objects the product owns in the shared S3 bucket:

- attachments;
- skill files and bundles;
- custom API/Gateway schemas;
- generated exports;
- project/user-managed files.

It excludes AgentCore Memory internals, CloudWatch logs/traces, DynamoDB bytes, provider token vaults, and AWS-managed Browser/Code Interpreter internals because the app cannot measure those as user-owned bytes reliably.

### 9.2 Upload flow

```text
storage.beginUpload(name, contentType, contentLength, purpose, projectId)
-> strongly read committed user storage
-> reject if already at/over limit
-> validate one-object maximum and allowed purpose/type
-> return a short-lived, content-length-bounded presigned POST
-> S3 ObjectCreated invokes the same broker Lambda
-> HeadObject and idempotently commit manifest + byte counter
```

No pending byte reservation is written. An unused or expired upload form cannot block later uploads. Concurrent accepted uploads may create storage overage; both remain intact and future uploads are blocked until deletion or a limit increase.

Use a presigned POST with an exact key/prefix and `content-length-range`. The browser cannot choose another owner prefix, ACL, bucket, encryption mode, or ownership tag.

### 9.3 Delete and reconciliation

Deletion is requested through the broker. The S3 delete plus manifest/counter update is idempotent and repairable. S3 object-created/object-removed notifications target the same Lambda handler; a periodic prefix/manifest reconciliation repairs missed notifications.

The object manifest is authoritative for product ownership and references; the byte counter is a rebuildable projection. Reconciliation never deletes an unknown object automatically. It marks it for administrator review.

### 9.4 Storage overage

```text
remainingBytes = max(0, storageLimitBytes - usedBytes)
overageBytes = max(0, usedBytes - storageLimitBytes)
```

Overage is not debt. Never delete existing data automatically. New uploads are blocked until bytes fall below the limit or an administrator raises it.

## 10. Resource summary

`resources.summary` returns one high-level view:

```json
{
  "cost": {
    "periodId": "...",
    "limitMicroUsd": 5000000,
    "actualCostMicroUsd": 2140000,
    "budgetCostMicroUsd": 2140000,
    "remainingMicroUsd": 2860000,
    "overdraftMicroUsd": 0,
    "nextResetAt": "..."
  },
  "storage": {
    "usedBytes": 1700000000,
    "limitBytes": 5000000000,
    "remainingBytes": 3300000000,
    "overageBytes": 0
  },
  "counts": {
    "projects": 2,
    "agents": 7,
    "connections": 3,
    "skills": 12,
    "nonTerminalRequests": 1,
    "staleRequests": 0
  },
  "quality": {
    "estimatedEvents": 0,
    "unpricedEvents": 1,
    "lastReconciledAt": "..."
  }
}
```

Only cost and storage are enforced user quotas in v1. Resource counts are informational and help administrators see account pressure. Do not invent per-user count quotas until a product requirement needs them.

## 11. Public API contract

Normal users are always forced to `scope=self`. Administrators may use `self`, a specific user, or `all`. The broker derives/authorizes user identity; callers cannot impersonate another subject.

### 11.1 Reads

| Command | Input | Result |
|---|---|---|
| `usage.summary` | `scope`, `period?` | budget/storage cards, totals, quality, reset |
| `usage.timeseries` | `scope`, `from`, `to`, `grain=hour|day` | cost/token/tool buckets |
| `usage.breakdown` | `scope`, dates, `groupBy=user|project|agent|model|meter` | ranked groups |
| `usage.requests` | `scope`, period/date filters, status/quality filters, cursor | request rows |
| `usage.request` | `requestId` | request aggregate and ordered child events |
| `usage.export` | filters, `jsonl|csv` | short-lived S3 URL |
| `resources.summary` | `scope` | cost, storage, counts, quality |
| `storage.list` | `scope`, purpose/project filters, cursor | owned object metadata |
| `defaults.get` | none | admin-only account defaults and revision |

For `scope=all`, `usage.summary` returns account totals plus paginated `users[]` entries using the same user-summary schema. Selecting an entry uses the same components and APIs as the user's own screen.

### 11.2 Mutations

| Command/route | Authorization | Purpose |
|---|---|---|
| `defaults.update` | admin | change defaults for future users |
| `defaults.apply` | admin | apply to users-still-on-defaults or selected users |
| `users.setLimits` | admin | update one user's budget/schedule/storage with revision |
| `users.startNewBudgetPeriod` | admin | increment epoch with reason |
| `usage.reconcile` | admin | request scoped best-effort repair; never blocks admission |
| `storage.beginUpload` | authorized owner | return bounded presigned POST |
| `storage.delete` | owner/admin | delete managed object after reference check |

## 12. User interface

The same Usage modal renders self, selected-user, and all-users modes.

### 12.1 User view

Top cards:

- `$2.14 of $5.00` and `Resets tomorrow at 12:00 AM EDT`;
- `1.70 GB of 5.00 GB`;
- warning, overdraft, incomplete, or unpriced callouts.

Sections:

1. timeline chart;
2. requests table;
3. model/project/agent/meter breakdown;
4. storage by purpose/project;
5. pricing/quality explanation.

Each request row shows time, agent, model, status, latency, total cost, tool count, and quality. Expanding it shows an ordered event timeline with model token/cache quantities and individual tool calls.

Prompts, answers, tool inputs, and outputs do not appear in usage exports or administrator views.

### 12.2 Administrator view

Add a scope selector:

```text
All users
Current administrator
<individual users>
```

The all-users view adds spend/storage by user, approaching-limit users, overdrafts, stale requests, unpriced events, and reconciliation coverage. Drilling into a user renders exactly the user view plus **Edit limits** and **Start new period**.

Account defaults live under Account → Usage defaults, not Infrastructure.

## 13. DynamoDB layout

One physical table remains sufficient.

| PK | SK | Purpose |
|---|---|---|
| `ACCOUNT#CONTROL` | `USAGE_DEFAULTS` | new-user defaults and revision |
| `USER#<sub>` | `CONTROL` | access, limits snapshot, limits revision |
| `USER#<sub>` | `PERIOD#<periodId>` | derived period summary/counters |
| `USER#<sub>` | `DAY#<date>` | daily rollup |
| `REQUEST#<requestId>` | `CONTROL` | immutable attribution + mutable operational status/aggregate |
| `REQUEST#<requestId>` | `EVENT#<occurredAt>#<eventId>` | immutable usage/adjustment event |
| `USER#<sub>` | `OBJECT#<objectId>` | managed S3 manifest row |
| `USER#<sub>` | `STORAGE#SUMMARY` | rebuildable committed-byte counter |
| `PRICE#<provider>#<model>` | `EFFECTIVE#<instant>` | rate row |

The overloaded GSI supports:

- period → user summaries for administrator combined view;
- user/period → requests ordered by accepted time;
- stale-request reconciliation;
- S3 key → object manifest where needed.

Do not index or store message text.

Period and request aggregates are projections. Immutable events plus policy/rate snapshots are the accounting evidence. A rebuild creates correction/replacement projections without changing event history.

## 14. Reconciliation

The EventBridge schedule invokes the same Lambda for best-effort repair:

- find old non-terminal requests and query available Harness/CloudWatch evidence;
- append missing measured/adjustment events;
- derive/display stale status;
- compare S3 manifests/counters with owned prefixes;
- compare account application totals with available AWS billing/telemetry;
- report unattributed differences.

Reconciliation never:

- holds or releases budget;
- charges a reserved ceiling;
- creates user debt;
- deletes user objects automatically;
- changes a completed user-visible result;
- fabricates token precision.

If the schedule stops running, admissions and uploads continue from committed counters. Observability quality degrades, but users are not locked out by pending state.

## 15. Security and privacy

- Usage APIs return only scopes authorized by the verified Cognito subject/group.
- Application logs contain IDs, statuses, and redacted quantities, never content or credentials.
- Usage exports are generated into a short-lived user/admin-scoped S3 key and delivered by a short-lived presigned URL.
- User deletion retains opaque-sub accounting for the configured financial/audit period and removes copied PII.
- Administrators can see cost/resource metadata, not conversation content through the Usage UI.
- Storage keys are generated by the broker and never contain email addresses.

## 16. Acceptance scenarios

### Ordinary request

A user at $1.00 of a $5.00 daily limit sends a request. Two model calls and one Jira tool call finish. Three idempotent events appear under the request; the request and daily/user totals equal their sum; the user and administrator-selected-user views match.

### Race overdraft

A user has $0.03 remaining. Two requests start concurrently and each costs $0.02. Both complete. Actual spend is $5.01, overdraft is $0.01, later requests are denied, and the next day's period starts at zero without debt.

### Lost finalizer

A model event costing $0.05 is recorded, then the broker process dies before terminal status. The cost remains counted. The request later displays stale. The user can continue if below their limit; reconciliation may update status but is not needed to release anything.

### Duplicate event

The same tool callback is delivered twice. The deterministic event condition accepts it once, and request/period totals change once.

### Late correction

An estimated model event is followed by a negative adjustment when measured usage arrives. History shows both, effective totals decrease, and admission resumes if the user is again below the limit.

### Reset across DST

A daily budget in `America/New_York` returns correct UTC boundaries on both DST transition days. Events before and after the boundary remain in different immutable periods.

### Default change

Admin changes defaults from $5 daily/5 GB to $10 weekly/10 GB using `newUsersOnly`. Existing users retain their snapshots; the next invited user receives the new settings. Applying to users-still-on-defaults changes only users with the matching source revision.

### Concurrent uploads

A user with 100 MB remaining receives two 75 MB bounded upload forms before either object is committed. Both objects arrive and remain. Used storage is 50 MB over the limit; subsequent uploads are denied until deletion or limit increase. No pending upload row can strand quota.

### Missed S3 notification

An object exists but its notification was missed. The user is not blocked by a phantom reservation. Reconciliation discovers the object, writes its manifest/counter idempotently, and reports any resulting overage.

### Unpriced tool

A custom API tool call has no configured vendor price. The request shows the tool and `unpriced`; it is not presented as free, and administrator quality counts increase.

## 17. Implementation sequence

1. Implement and exhaustively test period derivation, integer pricing, overdraft calculations, and limits/default validation as pure functions.
2. Implement account defaults, user-limit snapshots, invitation/bootstrap defaults, revision updates, and manual epoch reset.
3. Implement request acceptance/idempotency with strongly consistent user/period reads and no monetary reservation.
4. Implement transactional component-event commit and request/user/day projections.
5. Emit model/cache/embedding events, then Gateway/tool/Browser/Code/Runtime events.
6. Implement the shared Usage modal for self and selected user, then the all-users summary.
7. Implement bounded S3 upload, object notifications, manifest/counter updates, deletion, and storage UI.
8. Add append-only adjustments and best-effort request/storage/billing reconciliation.
9. Run race, crash, duplicate, late-event, DST, default-application, upload-overage, and live-account smoke tests.

## 18. Explicit non-goals for v1

- strict prepaid accounting with zero possible overdraft;
- project or agent budget enforcement;
- storage-dollar charges in the user's daily budget;
- automatic deletion on storage overage;
- arbitrary rolling budget windows;
- conversation-content access from usage reporting;
- pretending an unpriced vendor call costs zero;
- allocating every AWS account invoice line to a user;
- using AgentCore Memory or a custom Memory strategy as the accounting ledger.
