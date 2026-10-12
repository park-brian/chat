# Chat

A browser-only chat workspace for coding agents. `index.html` is the interface; `engine.js` runs the chats in a
SharedWorker, so every tab shares one engine and a run continues when its tab closes (`?inpage` runs it in the
page instead). Chats, agents, projects and files live in IndexedDB. Models are called directly from the browser
with your own keys: Bedrock (Claude, GPT, Grok) and Gemini.

`agentcore/` is a separate, hosted variant with its own docs.

## Run

Needs Node 22.1 or later.

```bash
npm start
```

Serves the app on http://localhost:8000 (`PORT` to change).

```bash
npm run start:proxy
```

Optional local proxy on port 8001: CORS for fetched URLs, a TCP relay for the network tools, and site mirrors at
`*.localhost`. `PROXY_PORT` moves it, but the app detects the proxy on 8001 only. Only pages served from localhost
may use it; `PROXY_ORIGINS` adds origins (a comma list, entries trimmed), and `*` opens the proxy and the TCP relay
to pages from any site.

A mirror (`http://example.com.localhost:8001/` for `https://example.com/`) serves only a frame opened by a page
that may use the proxy, and that frame's own same-origin requests; a top-level visit or another site's request is
refused. A mirrored body stops at 20 MB decoded and its request at 20 s.

The database has no migrations: a schema change resets it.

## Test

```bash
npm test
```

Runs the proxy checks, the eval helpers, the in-page suite and the multi-tab stories in Chromium. It stays offline
(the CDN aside); `node test.js index.html --net` also runs the page's tests that reach real sites. Lines reading
`FAIL: value is good` or `FAIL: breaks` come from fixtures that fail on purpose; the exit code is what counts.

## Evaluate

```bash
npm run eval -- --tasks inner --repeat 2
```

Runs the harness against real models on fixed tasks and grades each run, on Haiku 5.5 unless `--models` names
others (`--models haiku,sonnet,opus` or `all`). A run that crashes or doesn't finish is a harness failure, left out
of the mean. It calls paid APIs, and more than 20 jobs need `--yes`. Transcripts go to `.artifacts/evals/`; the
refinement log is `evals/NOTES.md`.
