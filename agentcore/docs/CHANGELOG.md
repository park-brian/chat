# Changelog

Verified releases, newest first. Evidence records and screenshots are written
under `.artifacts/` by the release scripts.

## 2026-10-12: code review fixes

- Interrupted conversation deletes resume; overlapping deletes never return
  the same bytes twice. Uploads copy exactly the measured version and check
  the quota in the activation transaction.
- Writes to shared rows retry transaction conflicts. A commit whose reply was
  lost is settled by reading the request, never by deleting a committed body.
  A cancel that arrives at commit time is honored.
- Usage estimates count images at a fixed cost instead of their bytes. Bedrock
  keeps text from every step, keeps answers cut off at the output limit and
  refuses empty ones. Hitting the tool or step limit still ends in an answer.
- Skills and connections in use cannot be deleted; role changes repair any
  group membership; duplicate invites are reported.
- Pages: reconnect resumes from the last event, any call retries a cold
  start, a failed token refresh no longer signs out every tab, streaming
  updates only the changing text, and edits recover from revision conflicts.
- Live stories, the credential-log check and the production smoke passed;
  the change set updated only the Runtime and kept all 19 resource identities.

## 2026-10-11: one schema, exact accounting (API v3)

- The Runtime is rebuilt as modules over one command table, with role rules
  enforced centrally. Everything a person owns is in one partition; a
  conversation is a tree of turn rows with S3 bodies; history is one query; a
  turn commits in one transaction.
- AgentCore Memory, the run-context snapshot and all legacy encodings are
  removed. The table is replaced: this release resets all data.
- Every model step is metered as it happens, including failed streams and
  inconsistent usage reports (quality `unknown`). Budget is checked before
  every step, runs are capped at three per person, tool calls are always
  metered, and managed session lifetimes are recorded.
- Transactions carry explicit tokens, because Runtime V2 snapshots repeat the
  SDK's generated ones across workers.
- Cognito access checks are cached for 15 seconds per person.
- New offline API suite; on the disposable stack all live stories passed,
  including seven real models with Code Interpreter.

## 2026-10-10: pages load in one round trip

- Pages render on token identity and overlap their first reads with
  `session.get`; content arrives in 0.43–0.72 s instead of 0.95–1.66 s.
- A new Runtime session's first call goes alone, because AgentCore answers
  409 to calls that overlap its start.
- Cross-document view transitions, and a static top bar that matches the
  rendered one.
- The chat observer no longer drops the terminal run status, which had left
  every composer turn on "Working…".

## 2026-10-10: top-bar redesign

- One top bar for every page, with project and agent switching; chat keeps a
  single conversation sidebar.
- Boot phases that report what the app is waiting for; skeletons; a global
  activity line.
- The "Instrument" visual system: tokens, monospace machine values, transcript
  turns with tool traces, dark mode.

## 2026-10-10: independent pages and background runs

- Seven independent page documents, reusable private credentials, and turns
  that continue after the browser leaves. Change set preserved all 20
  resource identities.

## Earlier

- 2026-09-25: projects, branches, files and skills; production Runtime-only
  backend.
- 2026-09-22: one CodeZip AgentCore Runtime replaced the Lambda/API Gateway
  broker.

## Next

- Recovering interrupted tool calls by read-back, without replaying a write.
- Work or school OneDrive through AgentCore Identity, and scoped customer AWS
  roles instead of long-lived keys.
- Reconciling infrastructure costs (Runtime, storage, Gateway, managed tools)
  with the AWS bill.
