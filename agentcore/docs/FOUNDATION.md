# Projects, paths, and objects

Status: implemented in the single AgentCore Runtime and browser page; exercised on the reusable disposable stack on 2026-09-25. Production rollout is tracked in [ARCHITECTURE.md](ARCHITECTURE.md). This document is the contract for the foundation slice; [PRODUCT-ROADMAP.md](PRODUCT-ROADMAP.md) owns later work.

## Ownership and state

The authenticated Cognito subject is the owner. A browser-supplied project, agent, conversation, branch, or object ID is only a selector within that owner's namespace. Administrators may inspect user limits and usage but have no command for another person's message or object content. The built-in `main` project is virtual and cannot be hidden. A new project is one `USER#sub / PROJECT#slug` row: the lowercase slug is immutable, while its display name and hidden flag are revisioned. Hidden means omitted from the normal rail, not disabled; direct links and operations continue to work. User credentials remain one vault across the user's projects; each agent explicitly grants connection IDs.

Agents, conversation navigation, and branch catalogs use `PROJECT#sub/projectId` table partitions. Memory uses actor `sub/projectId` and session `a_agentId_conversationId`. Older clients and rows default to `main`. The one Runtime, one Memory, one DynamoDB table, and one shared versioned S3 bucket remain the whole application backend; no Lambda or per-agent deployment is needed. Browser state is only navigation, draft, modal, and the short-lived Cognito token.

## Narrow Runtime API

All commands are version-1 POSTs to the JWT-protected Runtime. Expected application errors return `{ok:false,error:{code}}` over HTTP 200 because AgentCore masks non-2xx Runtime responses. The owner is always derived from the verified JWT. Reads and direct links validate the project even when it is hidden.

| Command | Input and effect |
| --- | --- |
| `projects.list` | Returns `main` plus up to 99 owned projects, including hidden ones for management. |
| `projects.create` | `{id,name}` creates one immutable slug; duplicate returns `PROJECT_EXISTS`. |
| `projects.rename`, `projects.setHidden` | `{id,revision,name}` or `{id,revision,hidden}` conditionally changes metadata; `main` is immutable and stale revisions conflict. |
| `workspace.get`, `agents.*`, `conversations.*`, `connections.*`, `chat.send` | Optional `projectId`, default `main`. Connection commands still operate on the shared user vault; agent grant IDs are checked per turn. |
| `conversations.get` | `{projectId,agentId,conversationId,branchId?,cursor?}` returns the selected chronological Memory path, branch catalog, and head IDs. |
| `chat.send` | Adds `branchId`, `expectedHeadEventId`, optional `forkEventId`, and `sourceBranchId` for a fork to the existing streaming contract. An absent fork means append; a present fork creates a new branch, where `null` roots it before the first event. A stale head or invalid ancestor returns `BRANCH_CONFLICT`, never an append to another path. Terminal `message.done` includes branch and Memory event IDs. |
| `objects.beginUpload` | `{projectId,name,contentType,sizeBytes,kind}` returns an exact-key, five-minute presigned S3 POST. Kinds are file, skill, artifact. Form size is bounded by policy; the Runtime does not proxy file bytes. |
| `objects.completeUpload` | `{projectId,id}` HEADs staging bytes, rejects oversized/missing data, copies to the user's persistent prefix, atomically activates inventory and increments user bytes. Repeating an active completion returns the same metadata. |
| `objects.list/get/delete` | Project-owned inventory, five-minute presigned GET, and exact-version deletion. Deletion atomically marks the row and decrements user bytes. `list` and `get` repair a copied-but-uncommitted pending object on demand. |
| `users.setLimits` | Nullable `budgetMicroUsd` and `storageBytes` set or clear per-user overrides. `0` is restrictive, `null` inherits current account defaults. |

The browser route contains only `project`, `conversation`, and optional `branch` IDs. The project modal handles create/rename/hide/open; the path selector and edit/retry actions stay in chat; Files & skills handles upload/download/delete; the agent modal selects up to four small project-owned skill objects. A selected skill is loaded into model instructions and, when Code Interpreter is granted, copied into that ephemeral workspace. No bucket credentials are given to generated code. Other persistent file types are not yet chat attachments.

## Memory paths and concurrency

Each completed turn is one Memory event containing user text, assistant text, and a JSON usage receipt. The table holds only a conversation navigation row, active branch, main head, and one catalog row/head per alternative branch; it never duplicates message bodies. The live Memory contract confirmed `CreateEvent.branch` plus `ListEvents.filter.branch.includeParentBranches` preserve legacy roots and nested ancestry while excluding a later sibling. AWS labels an unbranched event `branch.name = main`; the Runtime explicitly treats that as the main path. A fork validates its root with `GetEvent` in the same actor/session, then asks Memory for that source path. Continuations use the chosen branch's recent context.

The live API rejected a native branch without `rootEventId`, so an edit of the **first** turn uses one separate Memory session and stores its session pointer in that branch's catalog row. Its descendants again use native branches within that session. `sourceBranchId` identifies the selected source path for forks from such a session. The public conversation tree and branch selector are unchanged; no ancestor text is copied into DynamoDB or another Memory event. This fallback is limited to first-turn edits, not a second backend architecture.

The table transaction that writes request marker, usage, spend, conversation navigation, and branch head is conditional. The model result is not declared complete to the browser until Memory and the table commit. A raced head causes `BRANCH_CONFLICT` and an attempted `DeleteEvent` compensation. A provider call billed before Memory or table commit is **not** yet reconciled; do not describe its cost as zero or an exactly enforced hard budget. Memory's current 30-day retention still bounds reopenability.

## Logical storage and limits

The default user-wide limit is 5,000,000,000 bytes, shared across projects. Count each ACTIVE user-visible file, skill, or artifact once by actual `HeadObject.ContentLength`; the `USER#sub / CONTROL` byte counter is updated in the same transaction as inventory state. Memory, temporary Code Interpreter files, staging, and historical S3 versions are outside this logical quota. New uploads stop when measured bytes reach the limit; lowering a limit does not hide or delete existing objects. Concurrent completions can overdraft slightly, deliberately favoring users over indefinite reservations. Uncompleted staging has no quota hold and expires after one day. Noncurrent versions under pending and user prefixes expire after one day; physical AWS charges may differ from logical bytes until lifecycle processing.

Pending inventory rows have TTL and no count. If S3 copy succeeds but the table transaction fails, the next list/get can HEAD the persistent key and activate it once. All object transactions supply fresh idempotency tokens: AgentCore V2 can restore SDK random state, and a reused SDK-generated DynamoDB token caused a live `IdempotentParameterMismatchException`. A random token per attempt plus conditional inventory state makes retry safe. S3 and DynamoDB do not provide a cross-service transaction; reconcile rare delete/copy crashes before treating this counter as a physical billing meter.

Account defaults and legacy baselines live separately from per-user overrides. Old per-user numeric values equal to the frozen baseline mean inherited; differing values remain overrides. Version-2 marker rows use NULL for inheritance and N for an explicit value, preserving old numeric fields for rollback. Run `node scripts/audit-limits.js <stack> eaap us-east-1` first, then `node scripts/migrate-limits.js <stack> eaap us-east-1 --apply`; the latter conditionally checks old fields and verifies each result. Budget periods still reset lazily on read/use, with no cron. Usage rows now carry project and branch IDs; old rows are interpreted as `main`. Budgets remain user-wide.

## Live acceptance and operational loop

`npm test` runs deterministic protocol, model, accounting, controller, and buildless-page checks. `node scripts/test-memory-branches.js <stack> eaap us-east-1` creates and removes exact disposable Memory events in native and separate sessions. `npm run test:foundation -- <stack> --profile eaap --region us-east-1 --viewports desktop,mobile --screenshot` creates a fresh Cognito user per viewport and exercises project isolation/hiding, nested and first-turn-edit reopen, stale-head denial, real S3 browser transfer, quota, skill grant, null versus zero overrides, and responsive UI. The shared browser runner cleans that user's Memory sessions, table rows, exact S3 versions, and Cognito identity in `finally`; inference alone uses scripted echo. Existing live linear-chat and settings stories remain regression gates.

Reuse one named development stack and content-addressed CodeZip key for iteration. CloudFormation updates only when template or Runtime ZIP changes; then run each story with a fresh Runtime session to avoid old warm workers. Deploy the same reviewed template/ZIP to production, push the static page to GitHub Pages, verify published-origin login and a real model turn, and remove only the exact disposable stack and retained bucket after checking ownership and contents.

## Still outside this slice

Account-wide/user-selected usage refinements, Cognito enable/role controls, complete billed-but-failed reconciliation, broader third-party OAuth and customer AWS scoped roles, agent archive, resumable background runs, and Browser DOM/live view remain in the ordered roadmap. Storage quota is a logical user-visible file limit, not a complete AWS spend cap. No project memberships, project budgets, credential sub-vaults, conversation deletion, or browser CloudFormation administrator mode are implied by this foundation.
