# Client review 2: plan

Second review of the client after the first round of fixes (commits 14d7824..0ed99b5). Three reviewers;
the branch jump and both proxy crashes were confirmed against the code. Same ground rules as the first plan:
no data migrations, same-origin frames are intentional, `npm test` stays green, nothing paid is run.

## Decisions

- Network tests are opt-in: `node test.js index.html --net` adds `net=1` to the test page's query; the page's
  tests that reach the internet (testLocalProxy and friends) print SKIP without it. `npm test` stays offline.
- "Pinned" means an exact `x.y.z` version.
- An unfinished run (turn timeout, crash) is a harness failure: left out of the mean, listed, exit 1.
- Node 22.1 or later (`engines`), stated in the README.

## Phase A: engine.js and index.html (one engineer)

Engine
1. The path shown after a run is the path to the newest message: walk up from the highest id
   (`getPathToMessage(tree, maxId)`), used by open, finish, recover and the run's end. Test: reply on an older
   branch stays on that branch.
2. Engine start failures reach the page: wrap the worker's top-level imports; on failure every queued and new
   port gets `refused`. The page rejects all pending replies and dones on `refused` or `worker.onerror`, shows a
   page notice, and offers reload.
3. Boot errors are shown: the page's boot (initDB, ensureDefaultAgent, render) is wrapped and writes the error
   into `#app`; the module script has an `onerror`. A `VersionError` says a newer version is open.
4. First paint: `#app` holds a static "Loading…" placeholder that render replaces. Bedrock and GenAI SDKs are
   imported inside `getConverseClient` (and the Gemini client), not at the top, so tabs never download them.
5. The worker URL carries the database version as well as `PROTOCOL` (`DB_VERSION` constant).
6. `blocking` disposes the engine (stops runs) before closing; `finish()` releases the run's lock and workspace
   in a `finally`. `blobCache` is cleared whenever the database is opened or closed, and `putBlob` always checks
   the database.
7. Sub-agent updates send the changed fields only: `currentMessage` on its own, appended messages as a tail.
8. Document names use the same sanitizer as `mediaBlock`; the htm→html mapping is fixed.
9. Stop reaches a started tab-side `run`: the signal is passed into `runner.run` and honored by display.open
   and exclusive.
10. Branch scoping also carries the run's `leafId`; a tab accepts an event if it shows that message or its
    `messages[from]` is missing or equal. `from = 0` is scoped the same way.
11. `open()` reads `runs.get` after its await. Sub-agent expiry compares identity. Editor `insert` handles Blob
    content. The detected proxy is sent to the worker when detection finishes; the worker runs its own
    `/health` probe.
12. Cleanup: the unused `client` field, the dead Gemini JSON.parse, the dead parseFloat try/catch, `inWorker`,
    the worker's unreachable `blocked` handler, `think`'s parameter, a `resultOf` helper for the four
    toolResult lookups, one local-host check, one document-name sanitizer, one structuredClone per outgoing
    event, accurate comments (runs map, PROTOCOL, initDB), compactHistory unwraps store proxies, `task()` uses
    the engine's `client` option.

Page
13. Code tab: on first input, capture `{ projectId, path, base }` and pin the file (`selected`); a save is
    dropped with a notice if the project changed, the file is gone, or its content is no longer `base`. The
    worker's `reload` saves (or clears) a pending edit first.
14. Settings sync listens only to the host's own keys and sends only the stored proxy.
15. Deleting an agent: Save reads "Stopping N chats…", Cancel and Escape are disabled while saving, and a
    timeout throws instead of deleting.
16. A send while a run is going throws the "running" error, so restore runs; an open editor closes when loading
    starts and `saveEdit` restores into it. Notices and restores are tied to the thread they came from.
17. IME: also ignore Enter with `keyCode === 229`, including the MCP add-server field. The open mobile sidebar
    is modal: content behind is inert and Escape closes it.
18. Service worker: a clear message when `navigator.serviceWorker` is missing; a worker replaced by a newer one
    isn't reported as a failed install.
19. Markdown: render each lexer token with the document's `links`, keyed by `raw`, so reference links and
    multi-block HTML render as a whole parse would. Test with a reference link and a `<details>` block.
20. Cleanup: one Copy and one Retry per message; tool input parsed once and passed down; one `act` helper;
    `stored` uses the engine's `storedJSON`; dead branches (`removed.includes`, `typeof props.toolUseId`,
    unused `setAgent`).
21. Network tests SKIP unless the page query has `net`.

## Phase B: proxy.js and server.js (one engineer)

1. The upgrade handler adds `socket.on("error", () => socket.destroy())` first. Test: reset during refusal.
2. Mirror bodies are capped (20 MB decoded) with an overall deadline; past either, the upstream is destroyed and
   the reply is 502. Test with a gzip bomb.
3. No decoding for HEAD, 204 and 304; when no decoder applies (several codings, raw deflate), keep
   `content-encoding` and `content-length` as they came; raw deflate is tried after zlib deflate.
4. Mirrors serve only framed requests whose framer is allowed, or subresource requests from the mirror's own
   origin (`sec-fetch-site: same-origin`); other cross-site requests are refused. Comments and README say so.
5. The pinned lookup returns every checked address when `options.all` is set.
6. Private IPv6 forms: `::/96`, `2002::/16`, `64:ff9b:1::/48`, `fec0::/10`.
7. Relay: one `waiting` flag for drain.
8. Response hop-by-hop headers: also `upgrade`, `trailer`, `te`, `proxy-authenticate`, and those named in
   `Connection`.
9. `PROXY_ORIGINS` entries are trimmed.

## Phase C: eval, evals, tests, packaging, docs (one engineer)

1. eval.js: a crashed run's context and server close in `finally`; a failed file write is recorded like an
   escaped path; Windows device names, `:` in a segment, and trailing dots or spaces are refused; unfinished
   runs are harness failures (out of the mean, exit 1); no "mean pass NaN".
2. gradecheck.js reads folders recursively and serves through `startServer(0, dir)`.
3. Pinned means exact `x.y.z` in evals/tasks.js; eval.test.js splits the assertion.
4. tabs.test.js: the hand-off logs "started in <tab>" first; the story waits for it in tab-a before closing it
   and asserts both; the fixed sleeps at the other stories become polls.
5. test.js: `--net` adds `net=1` to the test page's query.
6. package.json `engines: { node: ">=22.1" }`.
7. README: Node 22.1+, `PORT`, `PROXY_PORT`, `PROXY_ORIGINS` (and that `*` opens the relay to any site), mirrors,
   `--net`.

## Order

The phases touch disjoint files and run in parallel. Seam: the `net` query flag (C5 sets it, A21 reads it).
Then `npm test`, a combined review, commit, push, and a check of the published page.

## Revisions after reviewing this plan against the code

Engine and page (A)
- A4: SDKs move into the bedrock and google branches of `getConverseClient`, each import cached and cleared on
  failure; `getGeminiClient(client)` stays synchronous. idb and diff stay top-level (openDB runs at boot).
- A2: the wrap is worker-only (`if (!inSharedWorker) throw`): on failure set `onconnect` to refuse, refuse every
  queued port, `close()` the worker, and stop the module. After `refused`, the page's `command()` rejects at once.
- A3: a classic inline script before the module listens for `error`/`unhandledrejection` until boot finishes
  (an evaluation error in engine.js is not a script `onerror`). VersionError says the saved data is newer than
  this page: reload.
- A6: `initDB`'s `blocking` disposes first and closes after; `finish()` releases its lock and workspace in a
  `finally` before anything that can throw.
- A1: use `store.activeLeafId` at the run's end; `getPathToMessage(tree, maxId)` for open/finish/recover; keep
  `getMostRecentPath` exported for its test.
- A7: sub-agent updates send `{ from, messages }` with an absolute index plus `currentMessage`; the page merges
  by index; a hello still gets a full snapshot. Expiry compares the entry stored by the final update.
- A10: partial events with `from === 0` are accepted only by a tab with no messages or the same first message
  id; tree events keep `after = leafId`.
- A11/A14: the worker probes `/health` itself and uses `settings.proxy ?? detectedProxy`; tabs send only the
  stored proxy; the storage listener filters on `HOST_KEYS` and ignores `key === null`.
- A19: render each top-level token with `markdown.parser([token])` (references resolve at lex time over the
  whole text); group tokens from an opening html token to its close into one block; key `For` on the rendered
  HTML string, not on `raw`.
- A12: one local-host check exported from engine and used by the page; `DB_VERSION` replaces the literal 7.
- A21: gate the mirror render/screenshot/httpbin story as well as testLocalProxy. "Offline" means no third-party
  sites beyond the CDN.

Proxy (B)
- B4: serve a mirror request if `sec-fetch-site === "same-origin"` and `sec-fetch-dest !== "document"`
  (the frame's own subresources and in-frame navigations; needs the frame's allow-same-origin), or if
  `sec-fetch-dest === "iframe"`, `sec-fetch-site === "cross-site"` and the framer (Referer origin) is allowed.
  Refuse the rest, including a missing `sec-fetch-site`. Never `same-site` (mirrors share `com.localhost`).
  B edits comments only; the README is C's, written last from B's final wording.
- The existing mirror address tests send framed headers (`sec-fetch-dest: iframe`, `sec-fetch-site:
  cross-site`, `referer: http://localhost:8000/`) so the address checks still run; add positive and negative
  cases for the rule.
- B2/B3: mirrors fetch real https hosts, so the cap, deadline and decoder are exported helpers with unit tests.
  The 502 applies to the buffered framed-HTML path; pass-through streams are destroyed past the cap. The
  deadline covers DNS and redirects (combined with the leave signal). Undecodable framed HTML fails with a
  rendered error. Raw deflate is detected by its first byte.
- B5: `publicAddress` returns every checked address. B6: also `2001::/32` (Teredo) and `2001:db8::/32`.

Evals and tests (C)
- C1: update eval.test.js's assertions (unfinished runs out of the mean, "no graded runs" instead of NaN).
- C4: the hand-off code logs `started in <name>` first; wait for it in tab-a's console; polls replace the
  800 ms and 600 ms sleeps.
- C5: `options()` accepts `--net`. The combined review also runs `node test.js index.html --net`.
- C7: README last, from B's mirror rule, caps and `PROXY_ORIGINS` trimming, and A's proxy settings; it says the
  app detects the proxy on 8001 only.
- New (user, 2026-10-12): eval.js defaults to Haiku 5.5 alone (`--models haiku`); other models by flag.
