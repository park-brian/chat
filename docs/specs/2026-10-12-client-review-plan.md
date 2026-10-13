# Client review fixes: plan

Review of the uncommitted client work (index.html, engine.js, proxy.js, ws-sw.js, eval.js, evals/, tests, probes)
on 2026-10-12. Three reviewers; every high-severity claim was checked against the code. This plan fixes all of
it and leaves the client as small and plain as it can be.

Ground rules:

- Same-origin artifact frames and keys in localStorage stay as they are (intentional; see the engine notes).
- No data migrations. The database is reset to one schema; old data is dropped.
- `npm test` (node test.js index.html, including tabs.test.js) stays green after every phase. New behavior gets
  a test where the suite can reach it (in-page stories, tabs.test.js, or a small node test for proxy.js and
  eval.js helpers).
- Nothing that calls paid APIs is run. eval.js is checked by `node --check` and unit tests of its helpers.

## Phase 1: proxy.js, ws-sw.js, server.js (security)

1. Forwarding requires an allowed `Origin`; a missing one is refused, as is `sec-fetch-mode: navigate`. The
   `/health` probe keeps working (it is a cross-origin fetch, so it has an Origin).
2. `Host` must be localhost / 127.0.0.1 / [::1] on the proxy's port, or a `*.localhost` mirror name. This closes
   DNS rebinding.
3. `cookie` joins `DROP_REQUEST`. Forwarded responses get `Content-Security-Policy: sandbox` and
   `X-Content-Type-Options: nosniff` (mirror documents keep their own rules, since they must run scripts).
4. TCP relay: reject ports outside 1–65535 with 400 before the upgrade; pause the socket while the websocket's
   `bufferedAmount` is above a high-water mark.
5. Mirror: resolve the hostname and refuse private, loopback, link-local and numeric-host addresses after
   resolution; follow redirects manually and re-check each hop; decode with the declared charset.
6. Upstream fetches are aborted when the client disconnects (`AbortController` + `stream.pipeline`).
7. The proxy listens on `PROXY_PORT` (default 8001), validated. `/health` answers a distinctive body, and the
   engine only adopts a local proxy that returns it.
8. ws-sw.js: a malformed `%` sequence falls through without throwing. index.html: a service worker that becomes
   `redundant`, or a failed `register`, rejects and clears the cached promise.
9. server.js: compare the `node_modules` segment case-insensitively.

Tests: a node test (proxy.test.js, run from test.js) that starts the proxy and checks: no Origin → 403, navigate
→ 403, foreign Host → 403, cookie not forwarded, port 99999 → 400 without crashing, numeric and private mirror
hosts refused.

## Phase 2: engine.js

Database:
1. One schema, no migrations. `initDB` opens version 7; its `upgrade` deletes every existing store and creates
   the current ones with their indexes. `stripLegacyToolDocs`, `upgradeMemoryLine`, the legacy prompt
   constants and the agent-proxyConfig move to localStorage go away.
2. `blocking` closes the connection (so a newer tab can upgrade) and tells the tabs to reload; `blocked` is
   reported instead of hanging. A failed engine start is not remembered for the worker's life.

Provider requests:
3. After filtering, a message with no content is dropped (or given a short placeholder where the role order
   must hold), for Gemini parts and Bedrock content alike.

Runs and tools:
4. Sub-agent entries are deleted shortly after they finish, and updates send only the changed entry.
5. Stop reaches tab-side calls: the run's abort sends `cancel` for its pending host calls, and `read_url`,
   `proxyFetch` and MCP calls get a default timeout combined with the run's signal.
6. A sub-agent's setup runs inside its `try`, so a failure there finishes it as an error. A sub-agent the user
   stopped is recorded as stopped.
7. MCP: a session is stored only after `initialize` succeeds and is dropped on error or 404.
8. `str_replace` uses a replacer function. The editor, sandboxFiles and mcp save share one resource helper.
9. Tool lookup uses `Object.hasOwn`. `view` before `hello` is ignored. `brave-config` is parsed safely.
10. The context summary: failures are logged and recorded so they are not retried every turn; summary requests
    offer no tools.
11. `saveProject` reads and writes in one transaction (or under the project lock) from every caller.
12. `blobCache` is an LRU capped by total size.
13. Branch-scoped run events: each delta carries the id of the message it follows; tabs on another path ignore it.

Cleanliness:
14. Delete dead code (`snapshot()`), wrong comments (the useAgent note, "Update signal" comments).
15. Split engine.js: prompts (the long prompt text), tab-only helpers (`readUrl` and the HTML/PDF/Word converters,
    `renderPage`, `inspectArgs`, `parseJSON`, sandbox resources) and providers move to their own modules, so the
    worker and the page each load only what they use. Pin CDN imports to exact versions.

## Phase 3: index.html

1. Code tab: the path is captured when the textarea becomes dirty and the save goes there; switching files
   flushes the old one first.
2. `sendMessage` re-checks the view after awaiting `engine.open`; `null` from `engine.send` clears loading and
   says the chat is running elsewhere; a failed send restores the text and attachments and notifies.
3. Edit is hidden while a reply streams. Retry and Edit keep the original message's attachments.
4. Deleting an agent stops its running chats first. Stop works before the new chat's id arrives (queued).
5. Commands send the stored proxy config, and tabs listen for `storage` events.
6. Streaming: settled Markdown blocks render once and only the last block re-renders; tool cards memoize their
   parsed input, edits and results, and results come from one `toolUseId → result` map.
7. Layout: the panel track uses `minmax(20rem, var(--panel-w))`; `pointercancel` and lost capture end a drag.
8. Accessibility: `.hover-parent:focus-within .hover-show`; the closed mobile sidebar is `inert`; artifact tabs set
   `aria-selected`; the settings modal moves, traps and restores focus; the sidebar toggle has
   `aria-expanded`; the agent picker closes on Escape; Enter does nothing while an IME is composing.
9. Opening a chat or sending scrolls to the bottom.
10. Dead code: `mcpSessions.clear()` in the page, the unused `settings` import, `isCompleted`, `.hover-fade`;
    define or remove `.cursor-pointer` and `.preview-surface.fixed`; test-only imports grouped with the tests;
    indentation of `run()`.
11. Confirm with the user whether the removed inline HtmlPreview should return (default: the artifact panel
    replaces it; no change).

## Phase 4: eval.js, evals, tests, packaging, hygiene

1. eval.js: workspace paths are resolved and must stay under `files/` (and `normalizePath` rejects `..`); each
   run is wrapped so one failure is recorded, not fatal; numeric flags are validated; the job count is printed
   and more than 20 jobs needs `--yes`; the "loading true" wait is short; crashed runs are excluded from the mean
   and reported; exit code 1 when any run failed.
2. evals/tasks.js: the CDN-pin check requires every jsDelivr URL to be pinned; the read_url check ignores empty
   urls.
3. gradecheck.tmp.mjs becomes evals/gradecheck.js with a relative import.
4. tabs.test.js: the handoff story proves the call ran in the second tab; the worker-death wait polls instead of
   sleeping.
5. test.js: `--profile` and `--region` refuse a missing value like `--live-stack`.
6. package.json: drop `solid-js`, `tcpipe` and `@aws-sdk/client-bedrock-runtime`; `ws` moves to dependencies.
   index.html pins `tcpipe@1` like engine.js.
7. Probes: findings worth keeping go into evals/NOTES.md; every probe-*.mjs and probe-haiku.tmp.mjs is deleted.
8. .gitignore: `.artifacts/`, `.claude/settings.local.json`, `*.tmp.mjs`, `probe-*.mjs`.

## Order and ownership

Phases touch disjoint files and run in parallel: proxy/ws-sw/server (1), engine.js and its new modules (2),
index.html (3), eval/evals/tests/package/gitignore (4). The two cross-file seams are agreed up front:

- Run events carry `after: <message id>` (engine 2.13, page 3.x).
- `/health` returns `{"proxy":"chat"}` (proxy 1.7, engine adopts only that).
- Host-call cancel message: `{ type: "cancel", id }` from engine to the tab that holds the call.
- The engine split keeps every name index.html imports today exported from engine.js (re-exports are fine), so
  the page changes in phase 3 do not depend on module boundaries.

Then: `npm test`, a review pass over the combined diff, and a summary of anything left. Nothing is committed;
the user reviews the working tree.

## Revisions after reviewing this plan against the code

A second review checked each item against the code; these changes replace the items above where they differ.

Proxy (phase 1)
- The Origin, navigate and Host checks apply to the forward path only, after the mirror dispatch: framed mirror
  pages arrive as Origin-less navigations. The WebSocket upgrade also requires an Origin. The Host port is the
  bound port (`server.address().port`), since tests start the proxy on port 0.
- Abort on disconnect listens on the response: `response.on("close", () => !response.writableFinished &&
  controller.abort())`. The request's `close` fires once its body is read.
- Manual redirects and per-hop address checks are for `mirror()` only; the forward path keeps following redirects
  because read_url relies on `x-final-url`. The mirror pins the resolved address (`lookup`) so a second
  resolution can't rebind.
- `sandbox`/`nosniff` and dropping `cookie` are defense in depth: forwarded responses are only read via fetch.
- The service-worker half of 1.8 is an index.html change (phase 3).
- proxy.test.js is wired through package.json (`node proxy.test.js && node test.js index.html`) and uses
  http.request for the Host test.

Engine (phase 2)
- Legacy prompt helpers are removed together with their imports and tests in index.html.
- Database reset: `upgrade` deletes every store when `0 < oldVersion < 7`, then creates the schema; the default
  agent (id 1) is still seeded by `ensureDefaultAgent`. Any later version bump wipes again. `blocking` closes the
  connection, resets `served` and tells tabs to reload; `blocked` shows a plain-DOM notice in the page (the page
  awaits initDB before rendering). `PROTOCOL` is bumped once, by the engine change, so tabs get a new worker.
- Empty messages: a message is empty if it has no content once reasoning, cachePoint and blank text are
  removed, decided before cache points are added. An empty message in the middle becomes a short text
  placeholder (Bedrock needs alternating roles); a trailing empty assistant message is dropped. Gemini applies
  the same rule to its built parts.
- Summary requests keep the same tools and system (Bedrock needs toolConfig with tool blocks, and the cache
  prefix must match). Failures are logged and recorded on the thread by usageId so they are not retried every
  turn.
- The page's proxy setting: commands send "stored, else detected", so auto-detected proxies are not lost.
- read_url decodes with the declared charset, like the mirror.
- Sub-agent updates send only the changed entry, a full snapshot on hello, and finished entries are removed
  after a delay long enough for tests that read them.
- Cancel: a cancelled host call leaves `tab.calls` so `drop()` won't re-send it; the page gives each call its own
  AbortController and passes the signal to code, readUrl and run.
- Run events carry `after` = id of `messages[from-1]`; the final full-state events from `finish()` and
  `recover()` are scoped the same way so they don't pull a tab off its branch.
- blobCache keeps the Map interface (the page calls `blobCache.clear()`).
- MCP sessions are keyed by the server's config, so the page's `mcpSessions.clear()` can go.
- `normalizePath` clamps `..` rather than throwing (old messages run through it).
- The big engine split is dropped: re-exports would still load everything, and import cycles with top-level
  await risk losing the first port. Only the long prompt text moves to a leaf module with no imports
  (prompts.js), added to eval.js's snapshot, the self-edit eval folder and test.js coverage.
- CDN versions are pinned from one table, shared by engine.js and the import map (incl. marked and tcpipe).

Tests and hygiene (phase 4)
- The tabs handoff story tags each page via window.name and checks the frame ran in the second tab.
- A tabs.test.js story opens a v6 database and expects the reset.
- Ignore `probe*.mjs` (probe2.mjs too).

Ownership: engine.js and index.html are changed by one engineer in sequence (their seams are many), proxy and
server by a second, eval/evals/tests/package/gitignore by a third.

## Status (2026-10-12)

Implemented; nothing committed. `npm test` exits 0 with 175 passes: proxy.test.js (13), evals/eval.test.js,
the in-page suite and the five tab stories, including the new old-database reset story. The `FAIL: value is
good` / `FAIL: breaks` lines are the suite's deliberately failing fixtures.

Changed beyond the plan, to review: LEGACY_MODELS, the `reasoningMode === true` shim and the check for
string-joined redacted reasoning were removed (old-data compatibility). eval.js exits 1 only for crashed or
unfinished runs, not for failed checks. Finished sub-agent entries leave the tabs after 60 s.

Left as is: the inline HtmlPreview stays removed; editor files are shared by an agent's chats (that is what
lets /secrets/ carry over); the import map keeps literal pinned URLs, checked against engine.js's CDN table by
testCdnPinned.
