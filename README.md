# Chat

A browser-only chat workspace for coding agents. `index.html` is the interface; `engine.js` runs the chats in a
SharedWorker, so every tab shares one engine and a run continues when its tab closes (`?inpage` runs it in the
page instead). Chats, agents, projects and files live in IndexedDB. Models are called directly from the browser
with your own keys: Bedrock (Claude, GPT, Grok) and Gemini.

`agentcore/` is a separate, hosted variant with its own docs.

## Run

```bash
npm start
```

Serves the app on http://localhost:8000.

```bash
npm run start:proxy
```

Optional local proxy on port 8001 (`PROXY_PORT` to change; the app looks for it on 8001): CORS for fetched URLs,
a TCP relay for the network tools, and site mirrors at `*.localhost`. Only pages served from localhost may use
it.

The database has no migrations: a schema change resets it.

## Test

```bash
npm test
```

Runs the proxy checks, the eval helpers, the in-page suite and the multi-tab stories in Chromium. Lines reading
`FAIL: value is good` or `FAIL: breaks` come from fixtures that fail on purpose; the exit code is what counts.

## Evaluate

```bash
npm run eval -- --tasks inner --models haiku --repeat 2
```

Runs the harness against real models on fixed tasks and grades each run. It calls paid APIs, and more than 20
jobs need `--yes`. Transcripts go to `.artifacts/evals/`; the refinement log is `evals/NOTES.md`.
