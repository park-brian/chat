# Prompt refinement log

`npm run eval -- --tasks inner --models haiku --repeat 2` is the inner loop. The holdout set (`--tasks holdout`)
checks that a change didn't overfit. Transcripts are in `.artifacts/evals/<run>/<model>/<task>/transcript.md`.

Each entry: the failure mode seen in transcripts, the hypothesis, the change, and before/after.

## 0. Smoke (2026-09-26T04-16-27, haiku)

- **Code results echoed the source.** Every `code` result carried the full source the model had just written.
  Harness fix: return `source` only when it came from a file.
- **Node habits on sockets.** The model wrote `data.toString()` on a ProxySocket chunk, got comma-joined bytes, and
  spent a turn decoding them. Network docs now say chunks are Uint8Array and name the DNS client.

## Baseline (2026-09-26T04-17-53, haiku, inner ×2): mean pass 0.82

## 1. The eval itself was broken (harness, not prompt)

- **Proxy unreachable in every eval.** dns-mx transcripts showed correct relay URLs failing with "websocket error"
  and every proxied fetch failing. Cause: `context.route` (used to pin index.html) makes Playwright break the page's
  cross-origin requests. Fix: serve the snapshot from the eval's own server. Failed requests are now recorded per
  run (`netErrors`), so a harness fault is visible apart from a model fault.
- **No screenshots after edits.** Headless Chromium can't share a tab (`NotSupportedError`), so every run got the
  approximate DOM render and edits came back without images. Fix: headed windows placed off screen, where tab
  capture gives real pixels, three at a time. `shots` column added.
- **Grader bugs.** The echo seed's write_file counted as a model call (fix-bug "edits rather than rewrites" always
  failed); now echo turns are excluded. dns-mx passed on MX records recited from memory; it now also checks that
  the records and the 220 banner appear in tool output.
- **request.json never written.** The first model request was bodyless; now the last one is kept.

## 2. Guessed APIs, missing relay URL, answers from memory (dns-mx)

- Seen: `DNSClient`, `DNS`, `resolveMx` guessed; `new ProxySocket()` without the relay URL (defaults to
  ws://localhost:3100); after failures, MX records and a banner recited from memory as if measured.
- Changes: network docs show DnsClient and ProxySocket with the relay URL and the method names, and say every
  client needs it. Environment: "'Not a function' or 'does not provide an export' means the draft was wrong: read
  the source, don't guess again." Working: "When a tool fails, find out why before trying something else. If it
  still fails, say what failed. Never fill the gap from memory: a guess dressed as a result is worse than no answer."
- After (04-28-09): dns-mx 0.5 → 1.0, 2.5 calls (was 4–7). Mean 0.82 → 0.92.

## 3. Stringified edits, polluting tests (notes-app, live-data)

- Seen: Haiku sent `edits` as a JSON string 7 times in one run; tests cleared localStorage and reloaded the page,
  or deleted each other's notes; ok:false with tests:null, then "Done".
- Changes (harness): edit_file parses a string `edits`, and a garbled one gets an error saying exactly that. The
  report adds plain notes for load and test timeouts ("Tests never finished … This is a failure"). An HTML report
  without tests is not ok (it was ok with a note the model ignored).
- Changes (prompt, Artifacts): "Tests run in the page the user sees, on the user's data. Never clear storage or
  reload in a test. Each test puts back what it changed (data, DOM, localStorage) …"
- After (04-33-14, with §1 capture): notes-app 10.5 → 3.5 turns, 149k → 38k tokens in; live-data 11 → 2 turns,
  157k → 16k. Mean 0.96.

## 4. Bug fixed, no regression test (fix-bug)

- Seen: 0/6 runs added a test with "a fix comes with the test that would have caught it" as a batching bullet.
  Haiku's reasoning goes straight from reading the code to the one-line fix.
- Change: Working states what a bug report is: "A bug report is a missing test: write the test that reproduces
  it, then the fix that makes it pass." Artifacts: "Write a test for each behavior you add and each bug you fix."
- After (04-41-02, 04-44-33): 2/3 runs add the test each time.

## 5. "Done" on a failing report (live-data)

- Seen: every report ok:false, final message "Done."
- Change: "End with what changed and what is left … A report that is not ok is what is left."

## Holdout (2026-09-26T04-46-59, haiku ×2): mean 0.92

- web-native-port 0.67 was the grader: a GitHub archive's only top-level entry is `solid-1.9.0/`, which both runs
  reported; the check wanted `packages/`. Fixed.
- long-session is where the money goes: 115 turns, 5.3M input tokens, cache 0.88, ~50 failed calls or reports a
  run. Most failures were the model's own tests asserting the fixture ("expected 2 cards in todo, got 0") after the
  user's data had changed it, retried up to 19 times without re-reading.

## 6. Cost: cache-sharing forks, exact cache reads, a cost metric

- Metric: `kCost` = uncached input + 1.25 × cache writes + 0.1 × cache reads (thousands); `kOut` alongside.
  Sub-agent turns now record usage (they never did, so sub-agent cost was invisible).
- Cache points ride the last two user messages: the older one is exactly where the previous request wrote, so the
  read no longer depends on the ~20-block lookback after a wide parallel turn. System + tools + 2 = Bedrock's max 4.
- `task` type `fork`: the caller continued. Same system prompt, tools, and prepared history (a `tail` that does not
  move the stubbing steps), then the caller's turn, then a result carrying the fork's question. Its first request
  is a cache read of everything the caller had read. It refuses edits and further sub-agents. Unit test checks the
  prefix byte for byte across a stub-step boundary. (Same idea as DeepSeek's compaction replaying the last request,
  and its fixed tool catalog across modes.)
- New inner task `codebase-questions` (four questions against solid.js). Baseline 05-05-56: 1.0, kCost 35: Haiku
  saved the file and grepped it with code, which is the right call at that size. Forks are for when the reading is
  bigger than the answer.

## 7. Universal policies (from long-session transcripts and the Codex/DeepSeek prompts)

- Working: change the plan when what you learn changes it; fix the cause, not the symptom; don't ask what you can
  find out; a proposal is not a change; change what the task needs in the style already there, mention the rest;
  never undo the user's edits; the same failure twice means your picture of the code is wrong; fork questions whose
  reading outweighs their answer; do small things yourself.
- Artifacts: "Assert what the test did (count before, act, count after), not what the page held: the user's data is
  not a fixture."
- Summary prompt: keep exact names, numbers, error text, and the user's corrections; fold in the earlier summary.

## Full run after 7 (2026-09-26T05-07-58, haiku ×2): mean 0.84 (baseline 0.95)

- Inner set held: every inner task 1.0 except one notes-app run (unpinned CDN). codebase-questions 1.0, kCost 24.
- The drop is three holdout runs that hit the 10-minute turn limit, not wrong answers:
  - two-step-feature-1: Haiku sent edit_file seven times with its arguments run together in one string,
    `{path: 'pomodoro.html">\n<parameter name="edits">[…]'}`, got "edits must be a non-empty array" each time, then
    tried writing the file through code (unterminated string) and a `general` sub-agent, which never came back.
  - research, long-session: long, and the window was one of three sharing the machine; rerun alone before reading
    anything into them.
- Fix: `splitRunTogether` at stream stop splits such strings back into their arguments, so the call runs and the
  history shows it well formed. Unit test from the transcript's input.
- eval.js: a timed-out run's check was stored as a bare array (label `undefined` in results.json); now `{ok, label}`.

## 8. Tools as they are used (from transcripts and the user's sessions)

- `console.log(obj)` printed `[object Object]`. Code's console now prints like devtools (`inspectArgs`): quoted
  nested strings, Map/Set/typed arrays, class names, `[Circular]`, errors with stack and cause, depth 3, wrapping at
  76, printf substitutions. Uncaught errors log as `Uncaught …`.
- `resources.view('snake.html')` returned `{status, error}` for a workspace file. Code's `resources` is now one
  small API over editor files and the workspace: read/list/exists/write/replace/delete/rename, throwing on failure
  with the nearby file names; workspace files read, and are changed only through edit_file/write_file. `view` and
  `create` stay as aliases; an unknown method throws naming the real ones.
- editor view of `/memories/` on a fresh thread said "Not found"; an empty directory now lists as empty.

## 9. Reasoning, per provider (live probes, probe-reasoning.mjs)

- Opus 5.5, Sonnet 5: `thinking: {type: "adaptive", display: "summarized"}` + `output_config.effort` low…max.
  Without `display` only a signature streams, so no text to show. Opus thinks even with no thinking field; `enabled`
  is rejected. Levels low–max.
- Haiku 4.5: `enabled` + budget_tokens; can be off. Levels off–high.
- Sol 6, Luna 6: `reasoning.effort` none…xhigh (minimal rejected). Reasoning arrives only as redactedContent bytes;
  no summary option returns text. The UI says the provider keeps it private.
- Gemini 3.8: thinkingLevel low/medium/high; minimal rejected and omitting it still thinks, so low is the floor.
- "invalid encrypted reasoning" on Sol: redacted chunks were joined as strings, and an empty reasoningText sat
  beside the bytes. Now bytes join as bytes; a redacted block goes back alone; another model's reasoning is dropped.
- "toolUse.input must not be null": a call with no arguments streams no input; it becomes `{}`.
- The reasoning control is a slider over the model's own levels; the chosen level is kept across models and each
  runs at the nearest it accepts.

## 10. UI

- Reasoning streams open as it arrives and folds when the answer starts. Code source, editor file_text, write_file
  content, run_app scripts, and edit_file edits stream into their cards live; titles read "Writing", "Editing" until done.
- Generic branding: "Share tab" for screen capture, in the UI, the prompt, and eval.js.
- The artifact panel resizes by dragging its edge (double-click resets; kept in localStorage). The viewport dropdown
  is gone; when run_app picks a size, a chip shows it and returns to fit.

## All-model check (2026-09-26T06-05-05: inline-answer, fix-bug, dns-mx × opus, sonnet, sol, luna, gemini): 0.97

- No reasoning or replay errors on any model: Sol and Luna ran 4–6 tool turns with encrypted reasoning sent back.
- The two misses are Sol and Luna on inline-answer: each opened `/memories/` first, as the persona's Memory Protocol
  asks, then answered. The other three models skip it on a plain question. Open: whether the protocol should
  say "when the task could use them", or the grader should allow a memory read.

## Inner set against the first baseline (2026-09-26T06-08-05, haiku ×2): 0.92 (baseline 0.82)

- dns-mx 0.5 → 1.0, fix-bug 0.6 → 0.9, inline-answer, notes-app, fork-fanout 1.0. Misses:
  - live-data-2: wrote a chart with no tests, got `ok: false` with "No in-file tests ran", and said "Done." The note
    now says what it means: "…so the report is not ok and the change is not done."
  - fix-bug-1: one regression test where the check wants two (the fix, and the task's existing test).
  - codebase-questions-2: the thread ends on a `think` call with no result and no answer. The loop ran tools only
    when `stopReason === "tool_use"`; any other ending (a stream closing early, max_tokens) left the call unanswered
    and the turn over.

## 11. Harness faults found in transcripts

- `</script>` in code source: the code tool inlined the source into its frame's module script, so any string
  holding a page (`const html = \`…</script>…\``) ended the program early: "Unexpected end of input". In the
  iter6 two-step-feature timeout Haiku hit it five times, then tried forks and a general sub-agent to work around
  it until the turn timed out. The "hang" was that timeout, not the sub-agent. The source now goes in as a JSON
  string mounted as a module script.
- The same run's 12 run-together `path` arguments: `splitRunTogether` recovers 11; the twelfth is JSON the model
  truncated itself, and gets the not-valid-JSON error.
- Calls run whenever the turn has any; the stop reason is kept on the message. When output hits the length limit,
  the last call (whose input is incomplete) is answered with an error saying to send less per call.
- eval.js: two evals started in the same second shared a folder and one results.json; run ids now end in a tag.
- The live edit preview (section 10) called `edits.map` on edits streamed as a JSON string. The render error
  reached the store update that streamed it and ended the turn: in the holdout (06-08-05, 0.94, no timeouts)
  long-session lost its filter and undo turns to "input(...).edits.map is not a function", and its final list
  correctly left them out. Cards now read edits through `editsOf` (array, JSON string, or partial string), and
  each message block sits in an ErrorBoundary, so a card that fails to render says so in place.

## 12. Stopping on a failing report (06-17-07 inner 0.97; 06-20-24 live-data ×3 0.60; 06-22-49 0.93)

- Inner set after section 11: 0.97. live-data-1 drew its own SVG chart after three guessed Chart.js APIs; the
  grader now accepts no CDN at all, and "Read before you guess" names "not a constructor" and "is not defined" too,
  with Object.keys(await import(url)) to see real exports.
- live-data ×3 then went 0/3: no tests, and "Done" twice straight after "…the change is not done". The note alone
  does not stop a model from stopping.
- The loop now answers the first stop per turn on a failing report with a harness note naming the failure; after
  that the model's word stands. live-data 0.60 → 0.93 (reminder fired in 2 of 6 runs, both then added tests), at
  about 3× the cost for those runs.
- Reward hack: live-data-3, rate-limited by CoinGecko in its own tests, swapped the fetch for generated prices and
  still credited CoinGecko. The reminder now says "Never fake data or drop what was asked to get a passing
  report", and Artifacts says to test code against a fixture while the page keeps fetching the real data. The
  report note went back to its original wording; the reminder carries the rest.
- live-data ×3 after the fixture line (06-26-58): 1.00; every run fetches live data, none fakes it; the reminder
  fired 3/3. Cost ~121k kCost, 11 turns, ~6 failed calls a run.
- live-data-3 spent five steps on a bare "Script error.": jsDelivr's `chart.js@4.4.0/dist/chart.min.js` is an ES
  module build, and a classic `<script src>` of it throws a muted cross-origin error. The bridge now names the
  cross-origin scripts on the page and says an ES module build loaded as a classic script fails this way.

## 13. Proxy failures look like data (06-17-07-abux holdout)

- Holdout: web-native-port 2/2, two-step-feature 2/2, research 1/2 (the other hit the 10-minute turn limit).
- The timed-out research run fetched `data.jsdelivr.net` (the host is `.com`). The proxy answered 502 with a text
  body, so `r.json()` said only `Unexpected token 'P', "Proxy erro"...`, and the model dropped the API and wrote a
  1 MB in-page benchmark whose every report took a minute. A browser rejects an unreachable host; the proxy now
  marks its own failures with `x-proxy-error`, and both fetch shims (code tool and artifact) reject with
  `TypeError: Failed to fetch <url>: <reason>`.
- Holdout final (06-17-07-abux, haiku ×2): 0.84 against 0.94. The drop is research-1's timeout above (the old
  06-08-05 holdout scored its per-task mean on fewer checks). long-session 0.75 → 0.88, and cheaper by far than
  section 5's: 32 turns and 786k tokens in (299k kCost) against 115 turns and 5.3M; its one miss is 5 in-file tests
  where the check wants 6.
- After the proxy fix (06-35-35-gakj, haiku ×3): live-data 0.93, research 0.67 → 1.00 regraded (below).
- Both research misses had answered in full (table, sizes, speeds, sources); the failing-report reminder then had
  them add tests, and their last message said only that. The grader read the last message; the user reads the
  turn. eval.js's answer is now everything said since the user's last message. Regraded: 06-35-35 research 3/3.
- live-data-3 wrote `<script src="https://cdn.jsdelivr.net/npm/chart.js">` without reading anything. The network
  docs' own tcpipe examples were unpinned under a rule that says pin; they now load `tcpipe@1/`.

## Full run after 13 (2026-09-26T06-43-46-yg2c, haiku ×2, both sets): mean 0.98
- Every task 1.0 but two test-count misses: fix-bug-2 wrote one regression test where the check wants two, and
  long-session-1 ended with fewer than 6. No timeouts, no harness errors, research 2/2 under the new answer rule.
- long-session is the cost and the variance: 53 and 75 turns, 479k and 954k kCost (06-17-07: 32 turns, 299k).
  The next place to look.

## 14. Tool input that doesn't parse, and eager streaming on Bedrock
- The stream's end parsed a call's input with the lenient parser built for showing it mid-stream, so a truncated
  or malformed call ran on whatever it salvaged. Now the end parses strictly: anything but a JSON object stays
  the string it came as, the call doesn't run, and it answers `status: "error"` with `{"INVALID_JSON": "<input>"}`,
  Anthropic's documented reply. The history sends `{}` in its place; eval.js counts it as a failed call.
- `eager_input_streaming` can't be set through Converse (probe-eager*.mjs): the SDK drops it from a toolSpec,
  `additionalModelRequestFields` rejects it ("Extra inputs are not permitted"), and tools passed there clash with
  toolConfig ("Tool names must be unique") or, without toolConfig, fail once history holds a toolUse. Nor is it
  needed: plain Converse already streams input finely (Haiku 643 deltas, first at 983ms; Sonnet 5 353; Opus 5.5
  369), where the fine-grained beta gave coarser chunks (150–200) and Haiku's first at 3s.

## 15. One error per retry; a fix with no test (07-48-37-dmo0, haiku ×3, long-session + fix-bug)
- long-session's cost was in edit retries: an edit_file with one bad edit named only that one, so long-session-1
  spent three failing calls in a row on the filter step, each finding the next. applyEdits still applies all or
  none, but tries every edit and names each that fails ("2 of 3 edits failed, so none were applied: …").
  eval.js's editsPerCall counted characters when edits arrived as a string (the 1504); it counts arrays only now.
- After: long-session 0.88 → 0.92, 44.7 turns and 409k kCost against 64 and 716k (yg2c's two runs).
- fix-bug 0.90 → 0.80: 3 of 3 fixed the bug in one edit, in 7 seconds, and wrote no test. yg2c was 1 of 2 with
  a test too; section 4's "A bug report is a missing test" holds about half the time. Like "Done" on a failing
  report (section 12), a rule the model reads is not one it keeps at the moment it stops.
- Change: the loop's stop reminder has a second kind. A turn that changed a file and left its test count where
  the file's last report before the turn had it (a new file: at zero) gets, once per turn, "This turn changed
  <path> and added no test. Write a test for each behavior you add and each bug you fix, or say why this change
  has none." Each kind fires at most once per turn.
- After (07-58-09-huri, haiku ×3): fix-bug 0.80 → 1.00, 4 turns and 17.9k kCost; long-session 0.92 → 1.00, but
  56.7 turns and 557k kCost against 409k: the reminder buys tests with a turn or two each.
- Holdout-side check (08-05-32-fp34, haiku ×2, notes-app + live-data + two-step-feature): 1.00 against yg2c's
  0.98. notes-app writes a tested file in one call, so the reminder never fires there.
- Other providers (08-06-42-5brg, luna + gemini ×2, fix-bug, long-session, notes-app, live-data,
  two-step-feature): 20 of 20 pass, 1.00 against 06-05-05's 0.97. The reminder fires once or twice a
  long-session run on either. Cost is the gap: Gemini's long-session averages 120 turns and 1983k kCost (Luna
  49 and 352k), notes-app 30 turns and 457k (Luna 11 and 125k).
- The untested reminder fired on a markdown file (storyBackgroundRun's notes.md): only HTML runs tests, so it
  asked for the impossible. It skips files that aren't HTML now.

## 16. Gemini builds big, then pages through it (08-06-42-5brg)
- Gemini's long-session kanbans end at 2520 and 2381 lines (Luna's: 578 and 444): 918 lines of CSS, 960 of
  JS, 420 of tests. It then reads them 20–130 lines a call, one call a turn, 100 and 52 view_file calls, each
  re-sending the whole context. The prompt's "Small" is a word it reads past.
- Change: "Small is a budget: a few dozen CSS rules and the code each feature needs. Every later change reads
  the file again." after "Small, portable, and working when opened directly."
- After (08-39-21-1zpw, gemini + luna + haiku ×2, long-session + notes-app + two-step-feature): 18 of 18
  pass, but Gemini reads past this sentence as well. Its long-session files end at 2438 and 2214 lines
  (2520 and 2381 before), notes-app at 2033 and 2392 (2630 and 2169), and it still pages them: 50 and 85
  view_file calls. long-session costs 1788k kCost (1983k before, within the spread of 1543k–2424k), and
  notes-app 662k (457k). Luna is level (long-session 352k, notes-app 91k). Haiku's long-session rose to 98
  turns and 962k, against huri's 56.7 and 557k.
- Reverted. A size budget stated in prose doesn't change how much Gemini writes, and it may cost Haiku. The
  next lever is structural, not a sentence: what the harness returns when a file passes a size, or a
  view_file that answers a whole small file in one call.

## 17. No fallbacks: one shape per tool
- The user's rule: keep the tools clean and easy to use, with no fallbacks. edit_file had grown three input
  shapes: `patch`, an `edits` array, and `edits` as a JSON string (repaired when garbled or overclosed).
  There was also splitRunTogether, which pulled arguments Haiku had run together into `path` back apart,
  and `resources.view` and `create` as aliases of read and write.
- Change: edit_file takes `patch` only. Anything else is refused with "patch is required" and the format.
  splitRunTogether and the resource aliases are gone, and a failed block is named "block N" everywhere.
- The card and eval.js's editsPerCall read only `patch`. The suite is 76 of 76 on desktop and mobile (the
  splitRunTogether test is gone), and all 4 tab stories pass.
- After (09-44-31-3f8t, haiku + luna + gemini ×2, fix-bug + notes-app): 12 of 12 pass. No call in any
  transcript sends `edits` or gets "patch is required": every model already writes patches, so nothing
  depended on the fallbacks.

## 18. The outline comes to the model, not the other way round
- Gemini's views in 1zpw aren't paging: 6 of 78 (long-session-1) and 8 of 42 (-2) start where the last one
  ended. It makes one view_file a turn and jumps (625-700, 1240-1340, 470-520…), hunting for code whose
  place it doesn't know. The outline would tell it, but the outline comes only without a range, and Gemini
  always sends one.
- Change: the first view of a file over 400 lines in each version brings its outline, after the range asked
  for. Later views of that version don't. The view_file description and the Tools line say so.
- After (09-56-35-o15p, haiku + luna + gemini ×2, long-session + notes-app): 11 of 12 pass. Gemini got the
  outline 13 times in each long-session run and still hunted: 64 and 56 views (78 and 42), 9 and 4 of them
  adjacent. long-session costs 1503k kCost (1788k, inside 1543k–2424k), and notes-app-2 made 28 views after
  3 outlines. Haiku's long-session is 482k (962k), Luna's 449k (352k): noise either way.
- Reverted. Gemini hunts with the map in hand, so what it lacks isn't the map. view_file is as it was.

## 19. A reply that says nothing
- o15p gemini notes-app-1 (1 of 6): 16 code calls prototyping marked, DOMPurify, hljs, smart-enter and tab
  indent, then a reply of reasoning alone with end_turn. Nothing was written, and the loop took it as done.
  It is 1 run of 297 across every eval so far, all of them Gemini, but the user gets nothing at all.
- Change: silentReply, a third once-per-turn reminder beside failing and untested. It fires when a reply has
  no text and no call: "Your reply ended with no text and no tool call. Go on with the work, or answer."
  Unit-tested, since an eval won't reproduce 1 in 300. Suite 77 of 77 on both viewports, plus 4 tab stories.

## 20. Screenshots from inside the tests
- The one screenshot a change returns is the preview after load: the page's first state. The states a test
  reaches (a note added, a dialog open, an error shown) were never seen, only asserted.
- Change: `await window.__HARNESS__?.screenshot("name")` in a test. The runner renders the test frame's DOM at
  that moment (html-to-image; the test frame is parked off the page), saves it to resources at
  screenshots/name.webp, and lists it in the report's `screenshots`. A run_app script's call shoots the preview
  instead. view_file (and the editor) return an image in resources as its pixels. resources.write takes a Blob;
  replace refuses one. The skeleton's tests are async and take one shot; Artifacts has a line on when to take
  them; NO_IMAGES tells Sol and Luna not to view them. Unit test: a shot taken mid-test shows the red page the
  test set and then undid. Suite 79 of 79 on both viewports, plus 4 tab stories.
- Also: a message whose blocks show nothing (a tool result, blank text, a bare signature) renders no block, so
  the chat has no gaps (storyNothingShownTakesNoRoom).
- After (20-57-55-d52y, haiku + luna + gemini ×2, notes-app + two-step-feature): 12 of 12 pass. Gemini took a
  shot in 4 of 4 runs and viewed it in 4 (each view came back as an image, 8–65 KB), then kept building. Luna
  took one in 1 of 4 and never viewed it, as told. Haiku took none. Every shot is the skeleton's one: no run
  took a second, so shots of the states that matter need either a stronger prompt or the harness to offer them.
- Cost: Gemini notes-app 578k kCost, inside earlier runs (3f8t 265k, 1zpw 662k); two-step 271k. Haiku and Luna
  as before.

## 21. Files read as themselves
- §20 first attached each shot to the report. Wrong: a shot is the model's own reference, a resource like any
  other, looked at when it wants to. Now the report only lists the paths, and reading is the read tools' job.
- What the models take inside a tool result, from the docs (Bedrock ToolResultContentBlock, Anthropic
  tool_result, Gemini multimodal function responses, OpenAI function_call_output) and a live probe
  (probe-media.mjs): Claude via Converse takes image (png/jpeg/gif/webp, 3.75 MB) and document (pdf 4.5 MB; the
  name letters, digits, single spaces, hyphens, brackets only, so no dots). Gemini 3 takes png/jpeg/webp and pdf,
  documented inside `functionResponse.parts`; the probe had them work as trailing parts too. Sol and Luna on
  Bedrock reject both: text only.
- Change: view_file and the editor's view return a binary resource as itself. An image comes back as an image
  block, a PDF as a document block named after the file, beside the JSON (path, type, size). Other bytes, or a
  file over the limit, return an error that says to read it in code (resources.read gives a Blob). Gemini
  gets the files inside the function response. For Sol and Luna, and for old results, each becomes a note
  ("[spec v1 omitted]"). `__images` became `__media`. Docs: resources.read/write say Blob; view_file names the
  formats. Unit test: a PDF read comes back as a document, a text-only model gets the note, and unknown bytes
  get the error. Suite 79 of 79 on both viewports, plus 4 tab stories.
- After (21-25-42-jg08, haiku + luna + gemini, notes-app + fix-bug): 6 of 6 pass, no failed calls from the
  change. Gemini took 3 shots and viewed them 4 times through the nested parts. Its reasoning names what is
  in the image (the note's title, the task list, the code block), and the shot shows exactly that. Haiku and
  Luna took none. Cost in range (Gemini notes-app 358k).

## 22. Screenshots are part of the tests; every model sees them
- Each shot names the test that took it: the next PASS or FAIL logged after it. The report lists
  `screenshots/name.webp (PASS: ...)`, and a note names the shots failing tests took ("view_file them to see the
  page as it failed"). The Artifacts docs say it plainly: an assertion checks what you expected, a screenshot shows
  what you didn't. Each test that brings the page to a state ends by recording it, and a change is done when the
  report is ok and its shots show what the tests claim.
- Sol and Luna see images after all, beside the tool result, in the same user message, never inside it
  (probe-openai.mjs, probe-beside.mjs: "ZEBRA 42" read back; parallel results, each image after a text label naming
  its path, kept apart). `besideResults` moves them there for models flagged `beside`. Documents stay a note for
  them: Converse rejects them, and only the Responses API reads `input_file` (not built). NO_IMAGES, the prompt line
  telling them they couldn't see, is gone.
- Eval 22-32-02-glns (haiku, luna, gemini × notes-app, two-step-feature × 2): 12 of 12. Luna took 2-2.5 shots and
  viewed 3.5; Gemini 5.5-6.5 and 5-9.5. Haiku took 1-1.5 and never looked. Luna spent about 8 turns on a dark-theme
  shot that showed a black disk and a white button while its test said `fill === "none"`. The test was right: the
  DOM render was wrong. html-to-image paints a class-styled SVG `fill: none` black, and a shot taken just after a
  state change catches CSS transitions halfway. The renderer is now modern-screenshot@4 on the document element,
  after the running transitions finish (at most 1s). Unit test: a red page after its transition, and a hollow
  green ring styled from a class, counted over the whole shot so the mobile scale doesn't matter.
- Sonnet 5 and Opus 5.5 join the default eval set (haiku, sonnet, opus, luna, gemini).

## 23. The harness lied twice: a cropped shot and a silent stream
- Eval 22-49-33-xi6r (all five × notes-app, two-step-feature × 2): 19 of 20. Opus is the model to beat: 7-10
  turns, 0 failed calls, 3-4 shots, and it views them (2-5), 27k-95k cost. Sonnet notes-app matches it; its
  two-step runs took 23-31 turns with 3-6 failed calls or reports (a separate thread to pull). Luna 7-9 turns,
  36k-84k. Gemini views the most (up to 7) and costs 175k-399k.
- The failure: one Luna request never answered. The user message was stored, nothing came back, and the run sat
  on the eval's 10-minute limit. A user would have watched a spinner forever. `watchedSend` now wraps every model
  call (turns, compaction, sub-agents): no event for 5 minutes and the turn ends with "The model sent nothing for
  300 seconds." A user's stop is still a stop. Unit test with a fake client: a stream that keeps talking, one that
  goes quiet, a request that never answers, and a user abort.
- The costliest run: Haiku notes-app-1, 33 turns, 29 run_app calls, 614k. It asked for the desktop viewport, was
  told "1440x900", and was shown the left 660px: the preview surface is a fixed 1440px box in an 830px panel, and
  Element Capture records only the part on screen. Haiku took the cut edge for its bug ("the preview pane is cut
  off on the right") and spent 25 turns scrolling, re-rendering, and demoing around a layout that was fine in
  every real browser (probe-clip.mjs). Tagged: harness fault, not model fault. It never wrote a shot into its
  tests either (tShots 0 in both notes-app runs), so its only eyes were the broken ones.
- Fix: a viewport larger than the panel shrinks to fit, as devtools does. CSS zoom, not a transform: under a
  transform Element Capture sends one frame and then none, so every later shot was the first one again
  (probe-fit.mjs). The zoom is snapped so the width lands on whole pixels; otherwise the page laid out at 1441px.
  The height can be 1px short at small scales (1440x899), which keeps the width exact rather than dropping mobile
  to half size. The probe now gets the whole page at desktop, tablet, and mobile, each a fresh frame. Unit test:
  at desktop in the test panel the page is 1440px wide and its frame fits the panel. Suite 80 of 80 on both
  viewports, plus 4 tab stories.
- Sonnet's long two-step runs, read call by call. Two of the 3-6 failures were the harness's wording, not the
  model's reasoning:
  - A patch block with two `=======` lines. parsePatch split on the first one and wrote the second into the file
    as code. The file broke, and clearing the line took four edits and a restore. A second divider in a block is
    now refused, with the block and line numbers.
  - The editor sent at the artifact. "File not found: index.html" was true, since the editor only sees notes, but
    Sonnet read it as the file being gone and went looking for it. The editor now says "index.html is a project
    file, not a note: change it with edit_file." Both changes have unit tests; the suite is 80 of 80 on both
    viewports.
  - The third was an await inside a synchronous test. That is the model's own bug, and the report caught it.

## 24. Tools over rules; a bench for the work behind one file
- Where the turns went (xi6r + vgya, 39 runs, every call classified). A tool error that names the problem without
  its fix costs a turn every time; a rule the model reads holds about half the time (§4, §12, §15). So each fix
  this round is in a tool, and the prompt changes are two lines.
- `await` where it can't go was the top syntax failure: 9 reports across Haiku, Sonnet, and Luna. Two shapes:
  `await` inside a test's sync `() =>` (from copying the skeleton's first test, the one sync test in it), and
  `await test(...)` in a classic `<script>` (Luna). The pre-flight error now says the fix: "This <script> is
  classic: top-level await and import need <script type="module">", or "The function around this await is not
  async; a test's is test("name", async () => { … })". Every skeleton test is async now, so there is one pattern
  to copy.
- A harness bug: a run_app script's screenshot has no test, so `s.test` was `false` and
  `false?.startsWith("FAIL:")` threw "s.test?.startsWith is not a function" in place of the report (Sonnet and
  Luna, 3 runs).
- Gemini wrote a 2,200-line notes app and then read it back in 17 view_file ranges to make CSS edits. The file was
  already in its context. Working now says: "A file you wrote is already in your context: edit from it, and read
  back only what changed under you."
- scratch/, the change this round is about. The deliverable is one file, but the work behind it needn't be:
  spikes that try a library first, fixtures saved from real responses, pages that test a part harder than the app
  should ship. Before, every HTML file written took the preview and became the default for edit_file and run_app,
  and one without tests got the "added no test" reminder, so the harness punished exactly this work. A page under
  scratch/ now runs in a parked frame of its own (tests on, a DOM render when a screenshot is wanted). The
  preview, the report on show, and shownPath stay the app's. The failing and untested reminders skip it, and the
  eval grades the deliverable only. run_app takes a path to run one again. Artifacts has a paragraph on it.
  Unit test: a scratch page runs tested and off screen, the app keeps the preview, and run_app by path works.
- A harder task, spreadsheet (set "hard"): formulas with precedence and parentheses, SUM over ranges,
  dependents updating, #CYCLE in every cell of a loop and recovery once it breaks, and #ERROR. It is graded
  through a window.sheet contract the prompt asks for. A parser plus a dependency graph is work that rewards a
  spike and hard tests, and it should separate models where notes-app no longer does.
- Suite 80 of 80 on both viewports.

## 25. The app, fed itself
- Round 24's runs (spreadsheet and the bench): 30 of 30. No model used scratch/ unasked. Gemini is the cost
  outlier, and Haiku's spreadsheet runs churn on re-running their own tests.
- A new hard task, self-edit: the folder is this app (index.html and engine.js), opened as a project the way a
  user would open theirs (eval.js `openFolder`). The task: make timeAgo say "3d ago" under a week, and add a test
  beside the app's own tests. It is a big-codebase navigation test: 4,600 and 3,700 lines, with a budget of 12
  views.
- The first runs found four harness bugs, not model ones:
  - Preview frames are same-origin with the host, and srcdoc resolves relative URLs against the host's server.
    index.html's `import "./engine.js"` loaded the host's engine, and its test suite wrote over the eval's own
    chat. Haiku clobbered the files twice. The fix: `unreachableUrls`, checked in runNow, not only in preflight,
    so bare run_app runs are refused too. A page whose script, link, or module import is relative doesn't run,
    and the report says why and how to check the change instead.
  - The code tool echoed a file's source back with its logs. For index.html that was 561KB per call, and Opus
    paid kCost 1445 for it. A result is now its logs.
  - A DOMException arrived as a bare "Uncaught " with no message; the error itself is formatted now. A
    ResizeObserver loop note is ignored, since nothing broke.
  - The failing reminder then told Sonnet the not-run report "is not ok". It spent 30 more turns: blob-URL
    imports of resources.read('engine.js') that got around the guard, edits to the user's app, and the app's suite
    run inside the preview. The untested reminder did the same to Gemini, which went reading engine.js for why. A
    report that says Not run is neither a failure nor a test count; both reminders skip it, with unit tests.
- view_file `{start, context}` without an end returned 800 lines; Gemini asked for it ten times a run, expecting a
  window. It is a window now (start ± context), and the schema says so.

  | self-edit, 2 runs each | z8t4 (before) | 693q (guard in runNow) | ko1t (reminders, view window) |
  |---|---|---|---|
  | Haiku | 2/6, clobbered | 5.5/6, 21 turns, kCost 113 | 5.5/6, 15 turns, kCost 71 |
  | Sonnet | timeout | 5.5/6, 23 turns, kCost 80 | 5.5/6, 17 turns, kCost 54 |
  | Opus | 6/6, kCost 1445 | 6/6, 8 turns, kCost 25 | 6/6, 7.5 turns, kCost 25 |
  | Luna | timeout | 6/6, 10 turns, kCost 42 | 5.5/6, 8 turns, kCost 37 |
  | Gemini | 5/6 | 5/6, 40 turns, kCost 597 | 5/6, 35 turns, kCost 350 |

  Every miss left is the view budget (13 views against 12, Gemini's 22–27). The edit, the test, and the boot pass
  in every run. fix-bug: 10 of 10, unchanged.
- Preview and scratch frames share the host origin by design: an artifact runs on the user's machine with the
  user's keys, and apps that call inference use them. The runNow guard is for correctness (the wrong engine ran),
  not isolation.
- Suite 80 of 80 on both viewports.

## 26. The web as tools: web_search and read_url
- Before, the web came only through fetch() in code: a page arrived as raw HTML and a PDF as raw bytes, and there
  was no search at all. Now every agent gets read_url, and web_search too when a Brave key is set (Settings,
  Network). Both go through the proxy.
- web_search is Brave's web endpoint with extra_snippets. A result is its title, its URL, its age and the
  snippets as plain text. The description is often an extra snippet cut short with "...", so a snippet whose
  pieces all appear in a longer one is dropped.
- read_url sends a navigation's headers (Accept, Upgrade-Insecure-Requests). The proxy forwards the tab's own
  User-Agent and Accept-Language. The page's type decides the converter:

  | Type | Converter |
  |---|---|
  | HTML | Readability, then Turndown with gfm |
  | PDF | pdf.js, one marker per page |
  | docx | mammoth, then Turndown |
  | JSON | fenced |
  | text | as is |
  | images | the same path as view_resource |

  Anything else says to fetch it in code. Output is 40,000 characters a read, with a `from=` to page.
- The live probe found four problems:
  - The proxy passed the browser's `zstd` offer upstream, and Node 22's fetch can't decode zstd. The docx arrived
    as compressed bytes. The proxy now asks for gzip, deflate or br.
  - Layout tables (HN) stayed as HTML under gfm, and later came out as pipe tables with empty header cells. A
    table with no th is now its rows as lines.
  - Cloudflare fingerprints the TLS of Node's fetch, so no set of headers passes its check (docs.solidjs.com,
    nytimes). The tool now says the page is a bot wall and points to another source or the snippets, so the model
    doesn't treat the wall as the page.
  - A page built by its scripts (Reddit) came back empty. It now says so.
- The new task web-read asks for the Transformer paper, its attention formula and the reason for √d_k, with a
  cited URL.
  - The first grading marked Sonnet, Opus and Gemini down for not searching. They knew the arXiv URL and went
    straight to it, which is the better move, so the check was wrong. The check was also missing LaTeX
    `\sqrt{d_k}`.
  - After the fix: 10 of 10 across the five models, 2 to 3 turns, kCost 19–34.
- Regression check with the new tool docs in every prompt: inline-answer 5 of 5, and no model searched. fix-bug
  was 4 of 5. Luna's miss is its test count (1 in-file test against 2); it made no web calls.
- Suite 81 of 81 on both viewports. The new unit test (testWebTools) covers the key header, the count cap,
  snippet dedupe, the article as markdown with absolute links, a gfm table, a layout table, the bot wall,
  paging, a hand-built PDF and a refused file: URL.

## 27. read_url renders: a page's scripts run at a mirror of its site
- Some pages build their content with scripts, so a plain read comes back empty and says to use render: true. With
  render, the page's scripts run first; with screenshot, a picture of the page comes back as well.
- The first version put the page in a sandboxed srcdoc frame and handled its fetch() for it through the proxy. The
  live probe found that wrong in two ways:
  - The frame's location was about:srcdoc, so client routers showed their not-found page (crates.io).
  - The frame's origin was null, so CORS blocked module scripts (Excalidraw).
- Now the proxy mirrors each site at an origin of its own: `http://crates.io.localhost:8001/x` is
  `https://crates.io/x`.
  - The page's paths resolve on its own host, and its router sees its own path.
  - Its origin is neither the app's nor one the proxy lets in, so the page can't reach the app's storage, the
    proxy or the TCP relay.
  - The mirror drops the site's CSP (the header and a meta tag) and X-Frame-Options. When the page is framed, it
    adds a small reader script.
  - The reader posts the built HTML once the page has loaded and gone quiet for 800ms, with a 15s limit. When asked,
    it posts a picture of the live page, drawn with modern-screenshot in the page itself, so the page's own fonts,
    canvases and same-origin images are in it.
  - The engine frames the mirror and swaps the mirror's origin back to the real one in the HTML. The fetch bridge,
    the scriptless copy and its image fetch are gone.
- Sealing, checked against the running proxy:
  - It refuses requests whose Origin isn't the mirror's own.
  - It refuses to be framed except by a page that may use the proxy (checked on the Referer), or by itself when
    it navigates. Without that check, any website could frame a mirror and receive the HTML, which would make the
    local proxy a read-anything service for the open web.
  - It never mirrors local or private hosts.
  - The proxy and the relay never let a mirror origin in, not even with PROXY_ORIGINS=*.
- The picture needed three fixes:
  - A lazy image offscreen never loads, and modern-screenshot waited 30s for it. react.dev took 20s and timed out.
    The reader now makes lazy images eager first; react.dev now takes 7.5s.
  - A page's noscript notice showed, because the picture is an SVG image with scripts off. It is now filtered out.
  - crates.io's meta CSP blocked the library's import. The mirror now drops that meta tag too.
- Live results, with each picture checked by eye:

  | Site | Time |
  |---|---|
  | crates.io/crates/serde | 2.5s |
  | Excalidraw | 3s |
  | react.dev | 7.5s |
  | HN | 2.5s |

- Limits:
  - Rendering needs the proxy on this machine, and an https page on its usual port.
  - Reddit blocks the proxy's own fetch ("blocked by network security"). Allowing forms, so its bot check can
    submit, gains nothing.
  - Excalidraw's handwriting font is loaded by script through the FontFace API, not by CSS, so the picture shows
    a fallback font.
- The unit test serves a page the test writes, from httpbin's /base64/, a real upstream. It checks:
  - its scripts run, and a relative fetch reaches its own site;
  - the proxy refuses it;
  - its origin and storage are its own;
  - a webp picture comes back;
  - a proxy that isn't local gets an error.
- Suite 81 of 81 on both viewports.
- The new task web-render asks for serde's latest version, its version count and how the crates.io page is laid
  out. Result: 20 of 20 across web-render and web-read, 2 runs each on the five models.
  - Luna read plainly first, followed the error's render: true, and passed. That is the flow the error is for.
  - Gemini answered from its first render, then spent 17 to 25 code calls in crates.io's Svelte source on GitHub,
    after a plain fetch() of the page returned 404. It averaged 23.5 turns, against 2 for the others.
  - Not tuned: that is one model on one task.
  - A tool gap under it: Readability keeps the README as the article, so the text loses the header ("v1.0.229 ·
    316 Versions"), and the version has to come from the picture or the API.

## Round: cache breaks, found and fixed (2026-09-29)

- eval.js now reads the worker's own Converse requests over CDP; `page.on("request")` saw none. From them it counts
  **prefix breaks**: each request is compared with the earlier one it repeats furthest, and it is a break if that
  one isn't repeated whole. The column is `breaks`, and results.json keeps a snippet of each break.
- The baseline (notes-app) found the cause at once. The first run report changed after it went into the history:
  Solid's `setState("report", obj)` merges into the object already in the store, which was the one the history
  held. Opus had 1 break at message 4, and Haiku had 5 breaks that rewrote message 2, even on a re-run of the same
  version. The store now gets a copy. testReportsStayPut fails without the copy.
- Also this round:
  - the tools cache point is gone, because the system point already covers the tools;
  - the fourth point goes to the summary a compaction leaves;
  - compactHistory passes memories, so its request matches the thread's prefix;
  - the code tool takes a timeout (seconds, default 5, up to 60);
  - Sonnet 5.5 replaces Sonnet 5.
- The sub-agent runner ends its thread and spinner as "error" when the sub-agent throws; before, they stayed
  "running". A sub-agent stopped at 15 turns says so in its answer. The new test is testTaskThatThrows.
- Suite 84 of 84.

  | notes-app | before: breaks · cache · kCost | after: breaks · cache · kCost |
  |---|---|---|
  | haiku | 9 · .78 · 531k | 0 · .40 · 16.4k (a 2-turn run) |
  | sonnet 5.5 | (new) | 0 · .50 · 29.3k |
  | opus | 1 · .54 · 26.2k | 0 · .79 · 14.6k |
  | luna | | 1 · .80 · 54.4k |
  | gemini | | 7 · .83 · 386.5k |

- Every break left is planned pruning: an image dropped (Luna 1, Gemini 5), or a view_file result stubbed
  (Gemini 2). The low cache rates for Haiku and Sonnet come from short runs, where the first write is most of the
  input. The next step is pruning that changes the prefix less often (plan item 3).
- Gemini made 35 calls against 1 to 8 for the other models, and its 1761-line index.html is read in view_file
  ranges.

## Round: sub-agents that do what the parent can't (2026-10-01)

- Two new types of task:
  - **review**: a critic with a fresh context. It gets the workspace, run_app, history and diff. It changes nothing
    and returns ranked defects with evidence.
  - **variant**: a fork that writes to a branch of its own (`project.branches[name].heads`). It returns the versions
    it made, and `restore` adopts one.
- `task` takes a `model`, chosen from the configured models. It is not for forks or variants, because they read
  the caller's cache.
- DELEGATING, in the system prompt when artifacts and task are on, says when each type pays:
  - variants when the take is a matter of taste;
  - one review before calling substantial work done.
- Fixes:
  - a sub-agent's answer is never stubbed;
  - a sub-agent is told on its next-to-last turn that one turn is left. Before this, a reviewer that spent its 15
    turns on checks returned nothing but "(Stopped after 15 turns, unfinished.)", which happened to opus once and luna
    once;
  - variants in a new chat make the project between them, and `ensureProject` shares one pending creation. Before,
    they were refused, and opus wrote a placeholder to get past that;
  - the variant brief says to write the deliverable itself early. Two of opus's three variants had left their real
    design in scratch/;
  - eval.js honours a task's `timeout` per turn. long-session had one, and nothing read it.
- New tests:
  - testReviewer;
  - testVariantBranch, which includes parallel variants making one project;
  - testTaskThatThrows.
- Suite 86 of 86.
- New tasks, neither of which asks for delegation:
  - logo-directions: "the strongest direction, not the first one";
  - audit-libs: six date libraries.

  | | logo-directions: pass · variants · reviews · sec | notes-app: pass · reviews · sec | audit-libs: pass · sec |
  |---|---|---|---|
  | haiku | 1 · 1 · 0 · 120 | 1 · 0 · 29 | .33 · 65 |
  | sonnet 5.5 | 1 · 3 · 1 · 431 | 1 · 0 · 128 | 1 · 24 |
  | opus | 1 · 3 · 0 · 443 | 0 (timeout) · 1 · 600 | 1 · 41 |
  | luna | 1 · 3 · 1 · 244 | 1 · 1 · 305 | 1 · 99 |
  | gemini | 0 (timeout) · 3 · 0 · 901 | 1 · 1 · 366 | 1 · 64 |

  These are the last run of each pair. The notes-app runs of haiku, luna and gemini are reruns, after a Bedrock 500,
  two empty Luna replies, and Gemini ending on thought alone.

- **Delegation is now chosen.** Before this round it happened once in 24 runs:
  - on the logo, every model made variants unprompted;
  - opus's run is the whole flow: three variants from an empty chat, a look at each one's render, restore v10, 7
    turns;
  - its mark is an acorn whose body is a flame, and it holds at 16px. Opus built its own sheet of sizes in scratch/,
    the views the logo type of Phase 4 renders without being asked.
- **Reviews find what the checks miss.**
  - Luna gave a review to Sonnet 5.5 on its own. It found that on mobile the grid column was 962px in a 390px
    viewport, which `overflow: hidden` on `.app` kept from the report's overflow count. It also found emphasis
    regexes rewriting `_blank` and URLs with underscores.
  - Luna fixed both. Phase 3's overflow check has to look inside clipped containers.
- **Over-delegation:** luna reviewed after every fix (4 reviews, 636s). "One review per piece of work: check your
  fixes yourself, with tests" brought it to 1 review and 305s.
- **The price is wall time.**
  - Three variants take about five minutes before the caller sees one, and the caller waits for the slowest.
    Gemini's slowest took 11 minutes, at about 10k output tokens of SVG a turn, while its fastest took 40s.
  - Opus's review on notes-app took 3 minutes, and opus was still fixing what the review found when the 10 minutes
    ran out.
  - logo-directions gets 15 minutes. notes-app keeps 10, the patience budget for a small app.
- audit-libs needed no delegation: four of five passed in 24 to 99s with fetches from the code tool. Haiku's table was in
  an earlier message, and its last message says "the table above", so the check (which reads the last message)
  saw neither the sizes nor js-joda.
- Next:
  - a variant's tail latency (a time budget, or the caller taking the first two that finish);
  - Phase 1 item 3 (stable pruning);
  - Phase 3.

## Round 2026-10-01: ambitious apps, a real workspace, and perception

The goal moves from "one artifact done well" to "an ambitious app built over many turns".

### Baseline

Run 2026-10-01T22-35-01-i93p, on the old code:
- spreadsheet and pixel-editor passed 8 of 8 on all five models. They no longer tell models, or harnesses, apart.
- folder-feature timed out on all five. That turned out to be the eval, not the models (below).

### Changes

- **The workspace is served, not inlined.** ws-sw.js, scoped to `__ws/`, serves each run's files from Cache Storage
  at `${RUNS}-${id}-${app|scratch}-${n}/path`, and the frame loads them by `src`. Relative imports, CSS, data files
  and the nested app's own database all work as on a server. Missing files are found before the run.
- **The eval's hang.**
  - watchRequests attaches CDP to the SharedWorker, so the eval can see the worker's requests.
  - Chrome keeps a SharedWorker's DevTools target after its last page leaves. The worker that starts on that target
    (after openFolder navigates) waits for a debugger, and nothing told it to go: every folder-feature and self-edit
    run sat at 0 requests.
  - The fix is `Runtime.runIfWaitingForDebugger` on `Runtime.executionContextsCleared`.
- `stopped.png`: a run that fails or times out keeps a screenshot of where it stopped.

### Round ws1

Run 2026-10-01T23-30-06-ufhv: the served workspace and the eval fix. Mean pass 0.76.

| | folder-feature | self-edit | notes-app | fix-bug |
|---|---|---|---|---|
| haiku | 5/6 | 5/6 (45 views) | 6/6 | 3/5 |
| sonnet 5.5 | 5/6 | 5/6 (13 views) | 6/6 | 5/5 |
| opus | 5/6 (rewrote all 4 files) | timeout | timeout | 5/5 |
| luna | 6/6 | timeout | 4/6 (no last report) | 5/5 |
| gemini | 6/6 | 5/6 (44 views) | 6/6 | 5/5 |

- folder-feature misses were all "edits rather than rewrites"; haiku's fix-bug misses were the same.
- self-edit's timeouts: the nested app's 88-test suite takes longer than the runner's 20s test wait, so the report
  said "timed out", and opus and luna then spent their time debugging a harness that was fine.
- opus's notes-app sat at "Running…" after a 24-edit edit that followed a review. The saved notes.html doesn't hang
  on its own; unexplained.

### Changes after ws1

- **Layout checks** in the report, from the DOM with no model involved, for shown elements:
  - text cut off by its own box (ellipsis is meant, so it isn't reported);
  - text below AA contrast, with colors resolved by a canvas (so oklch works) and backgrounds composited up the
    ancestors; a gradient or image background is not judged;
  - images without alt and buttons with no name.
  They go in `report.layout` with a note, and don't change ok. testLayoutChecks covers each.
- **SPEC.md.** WORKING: an app built over many turns keeps its plan in SPEC.md beside it (the ask in the user's
  words, the decisions and why, the steps ticked as checks pass) and reads it first when a summary starts the
  context. Writing the spec doesn't run anything or take the panel.
- write_file's doc says to edit rather than rewrite, and why.
- **The test wait follows progress:** 20s from the suite's last result (2s once the page has thrown), and two
  minutes in all, so an 88-test suite finishes and a stuck one still doesn't hold the turn.
- **budget-evolve**, a hard task in four turns: a budget tracker with a JS API; then monthly recurring entries
  (clamped to the month's last day); then CSV export and import with quoted commas and quotes; then budgets and
  overspent categories shown in red. Its 11 checks include exact cents, $1,234.56 formatting, persistence across a
  reload, and red resolved by canvas. They all pass on a reference build.

### Round ws2

Run 2026-10-01T23-55-08-zpt7, with the changes above. Mean pass 0.74.

| | budget-evolve | folder-feature | self-edit | notes-app | fix-bug |
|---|---|---|---|---|---|
| haiku | 4/11 (keys wiped) | 5/6 | 5/6 (30 views) | 6/6 | 5/5 |
| sonnet 5.5 | **11/11**, 388s | 5/6 | timeout | 6/6 | 5/5 |
| opus | timeout in turn 1 | 5/6 | timeout | 6/6 | 5/5 |
| luna | timeout in turn 1 (2 variants + review) | 6/6 | 6/6 | timeout (2 variants + review) | 5/5 |
| gemini | **11/11**, 648s, 94 turns, kCost 1660 | 6/6 | 5/6 (43 views) | 6/6 | 5/5 |

- **An app's tests wiped the user's keys.** Haiku's budget tests called `localStorage.clear()`. The frame shares
  the host's origin, so its turns 2 to 4 answered "Add AWS credentials in Settings first". A user's would too. The
  preview and the tests also ran at once on the same storage, so a test's clear could take the preview's data.
  - Fix: a test run keeps its own storage. localStorage and sessionStorage start as copies (reads still work), and
    its IndexedDB databases are named under the workspace and start empty each run. testTestRunStorage.
- **SPEC.md works as meant.** Opus's first budget turn: an app, then SPEC.md with the ask in the user's words, then
  a review that found five real defects (a transaction added for another month seemed to vanish; the phone header
  was clipped), then fixes. All in 10 minutes, which was the whole turn. budget-evolve gets 15 minutes a turn.
- **Variants for a spec.** Luna made two variants of the budget tracker and of notes-app, both fully specified,
  and ran out of time on each. DELEGATING: "Behavior the user spelled out isn't a matter of taste: build it once."
- **The self-edit timeouts were our flaky tests.** Sonnet and opus spent their time on storyRetryRewindsFiles and
  storyBackgroundRun failing in the nested copy under load. Both were races in the tests:
  - `idle()` read "not loading" before a retry had even started;
  - the project reached the page over the port after the reply.
  Each now waits for what it asserts.
- Contrast findings are rounded down and say what they need ("4.49:1, needs 4.5"). "4.5:1" read as a pass, and
  sonnet dismissed it.
- "Edits rather than rewrites" is dropped from folder-feature. Its files are 21 to 30 lines, and every rewrite kept
  85 to 100% of them, which costs what an edit costs. It stays on self-edit and fix-bug, where files are big.
  - The harness says it instead, where it matters: write_file over a file of more than 40 lines that keeps over half
    of them notes "Rewrote X to keep N of its M lines: edit it instead".
- budget-evolve's probe checks each part on its own. One missing function no longer fails every check after it.
- **Phone width.** After its tests, the parked test frame is resized to 390×844 and checked again: horizontal
  overflow, plus layout findings the shown size didn't have, in `report.phone` with a note.
- view_file with a start and no end, on a file of over 400 lines, shows 200 lines, not 800. Gemini paged a
  3000-line budget app 800 lines at a time, about 30 times.

## Round ws3 (2026-10-02T00-28-12-fn8y): storage kept to the run, phone width, a spec held to

Same four hard tasks plus notes-app; view_file's 200-line page came after its snapshot.

- **Storage isolation works.** Haiku's budget-evolve went from 4/11 to 10/11. Its keys survived its own tests.
- **The self-edit timeouts were the harness's, not the models'.** The chat app's own suite starts on `?test=1`,
  and a run frame has no query, so under run_app it never started. Every report said "Tests never finished:
  window.TESTS_DONE was not set", and opus (9 such reports), luna (5, 41 views) and sonnet (18 views) each went
  looking for a hang that was a gate.
  - The app's suite also starts on `window.__HARNESS__.test`, without its stories: each drives a whole second app,
    and npm test runs them.
  - A suite that logged no PASS or FAIL now gets its own note: "No test started … A suite that waits for ?test=1
    never starts here; start it on window.__HARNESS__?.test too." One that stalls says after how many results.
- **A run_app script's import() read the host's files.** V8 resolves import() in a Function against the script
  that made the Function, the host page's. Sonnet imported ./engine.js to check its edit, got the host's, and the
  edit looked undone. The script now runs from a script element of the page's own (compiled first, so a syntax
  error is still the script's). testFolderProject.
- **The layout note asked for fixes nobody wanted.** "Fix each" on the chat app's own buttons (4.45:1) sent opus
  into contrast work on a timeAgo task, against WORKING's "fix them only when asked". Now: "Fix what your work
  made, or say why it is meant; mention what it didn't make", and the note isn't repeated while the findings are
  the same as the last run's (they stay listed).
- **The user's header, extended.** Haiku and opus both exported `date,amount,category,note,repeat`: they saw that
  four columns lose recurrence, and added one. Defensible, but the user named the header, and haiku's answer
  didn't say it changed it. WORKING: "Names, formats and values the user gave are the spec: match them exactly.
  When one collides with what is already built, keep theirs and say what it costs."
- **Variants still build the whole app.** Luna made notes-app twice, one variant after the other, each to the
  15-turn cap (the second unfinished), then a review, and timed out. DELEGATING: variants are called in one turn so
  they run at once, and for a specified app they come after it is built and tested, each starting from what works.
- folder-feature's "ran a test of streak" was the check's fault. A passing report names no tests, so sonnet's six
  streak tests (15/15 passing) never showed in the results text. The check now looks for a test of streak( in
  the files and a pass in the last report.
- test.js ignores page errors thrown in the served workspace (`/__ws/`): those are fixtures', checked by reports.
- Gemini's budget "shows in red" miss was the probe's: its food row has a rose border, but the template's
  indentation put the row's textContent past the probe's 300 characters. Whitespace is collapsed before measuring;
  gemini's files pass 11/11, the reference still 11/11.
- With the gate open, haiku's self-edit (2026-10-02T00-59-44-2x0v) got real nested reports: 73 passed, 1 failed.
  The failure was ours: testTestRunStorage asked the host's indexedDB for the preview's database, and when the
  whole suite is a test run, the host's indexedDB is the run's copy. It now asks the preview's own window.
  - The nested suite takes 50 to 110 s a run, and every edit runs it: seven edits were most of haiku's ten
    minutes. self-edit gets 15 minutes, as a real self-edit would need.
- Gemini's self-edit timed out on the same gate as the others.

## Round ws4 (2026-10-02T01-12-12-ckgg): mean 0.88, from 0.75

| | budget-evolve | notes-app | self-edit | folder-feature |
|---|---|---|---|---|
| haiku | 9/11 | 6/6 | 6/6 | 5/5 |
| sonnet | 11/11 | 6/6 | 6/6 | 5/5 |
| opus | 11/11 | 6/6 | 6/6 | 5/5 |
| luna | timeout (15 min) | timeout (10 min) | 6/6 | 5/5 |
| gemini | 11/11 | 6/6 | 5/6 | 5/5 |

- self-edit passes on four of five models, where every one timed out in ws3: the gate and storage fixes hold.
- **Variants took themselves for the caller.** Luna's two budget variants checked the build, asked for a review,
  called variants of their own ("A fork does not start sub-agents"), and summed up the caller's build; neither made
  its take, and luna sent the pair again. The brief came as the task's tool result, which reads as the output of a
  call the model made, not as an instruction. It now comes as the user's words after the results, and the call's
  own result says only "(This call is you: your brief follows.)". This is most of luna's lost time in both rounds.
- **The eval graded a variant's files.** heads were the newest version of each path, and a variant's branch writes
  newer versions than the take kept: luna's ws3 "report (none)" and red miss were a variant's index.html. eval.js
  now reads the main thread's project heads, which also drops deleted files.
- Haiku wrote the user's CSV header, saw "But the user specified the header", and still exported a repeat column;
  its SPEC.md and its test both said its own header, so the test passed. WORKING: "test them against the user's
  words, copied, not against your code."
- Gemini's self-edit "miss" was 21 views of greps and 10–60-line ranges: 434 lines in all, against 852–3433 for
  runs that passed. The check counts lines shown now (≤ 1000), not calls.
- Luna's notes-app: build, two visual variants, a review that found a real loss (a failed save shown as Saved),
  the fix — then time ran out. The practice is right; the variants were wasted for the reason above.

## Round ws5 (2026-10-02T01-47-06-q8ws): mean 0.89 on four tasks

- **An app signed the harness out.** Haiku's budget-evolve answered turns 2–4 with "Add AWS credentials in Settings":
  its run_app scripts reset the app with `localStorage.clear()`, and the preview shares the host's storage, so the
  keys went with the app's data. Its 6/11 is not a model result. A preview's clear() now removes all but the host's
  keys (HOST_KEYS); reads and writes are unchanged, so apps that use the keys still can.
- UI: a plan chip in the artifact toolbar ("1/2", SPEC.md's ticked steps, opens it); on a phone-wide panel the
  tabs are icons, so every control fits (the folder, re-run, focus and close buttons were off the edge).

| model  | budget-evolve | notes-app | logo-directions | fork-fanout |
|--------|---------------|-----------|-----------------|-------------|
| haiku  | 6/11 (signed out) | 6/6 | 3/3 | 2/3 (cache 0.33) |
| sonnet | 11/11 | 6/6 | 3/3 | 3/3 |
| opus   | 11/11 | 6/6 | 3/3 | 3/3 |
| luna   | 11/11 | timeout | 3/3 | 3/3 |
| gemini | 11/11 | 6/6 | 3/3 | 2/3 (cache 0.42) |

- **Haiku's forks lost the cache, and the brief was why.** Each read 9,370 tokens (through the first user message)
  and wrote 19k. After ws4 the brief had moved out of the fork's result into user text; on Haiku, user text after the
  caller's calls strips the caller's earlier thinking from the prompt, so the prefix differed at the first
  assistant message. Opus thought there too and read 0.97: newer models keep the thinking. The brief now rides in
  the fork's own result as a second block, after "(This call is you: your brief follows.)", so the turn is tool
  results only. The test asserts that.
- **Luna sent variants for a spelled-out app, one per turn.** Two variants took 370 of the 600 s, serially. Then
  `run_app { path, version }` on each answered "File not found": the path was checked against the project's heads,
  and a variant's file is only on its branch. It rewrote the app from scratch and ran out of time in review. A
  version now names its file, branch or not; the task tool's variant line says "For a matter of taste, not for
  behavior the user spelled out", as DELEGATING already did.
- Two test flakes fixed: storyBackgroundRun's 404 was `blank()` dropping a project's folders while a run was
  between publish and load (a run now waits for the drop, and one published meanwhile stops as closed);
  storyArtifactPanelOpens asserted the panel before the project's state crossed the engine's port.

## Round ws6 (2026-10-02T02-28-23-8nwb): mean 0.74 on four tasks, haiku, luna and gemini

The fixes for Haiku's unadopted variants (below) landed at 22:39, mid-round; runs that started earlier ran without
them.

| model  | budget-evolve | notes-app | logo-directions | fork-fanout |
|--------|---------------|-----------|-----------------|-------------|
| haiku  | 11/11 | 6/6 | 0/3 (unadopted) | 3/3 (cache 0.98) |
| luna   | 11/11 | timeout | 3/3 | 3/3 |
| gemini | 10/11 (grader) | 6/6 | timeout | 3/3 |

- **Fork cache fixed.** Haiku's forks read 0.98 with the brief in their own result (0.33 in ws5).
- **Haiku called a variant's work done.** Its variants made logo.svg on their branches; it read "done", saw "File
  not found", and finished with no logo. Now: a task result's versions carry "not in your files: run_app { version }
  shows one, restore { version } makes it yours"; view_file, edit_file and run_app name the branch and version of a
  file only a variant made; history marks such versions `~`; and an end-of-turn reminder fires once when the turn's
  variants were never restored.
- **Luna's notes-app timed out again, on taste nobody asked for.** It built and tested the app in 260 s, then sent
  two visual variants (80 s), compared them (130 s), and a review (150 s, which found a real bug: deleting the last
  note left an editable ghost). DELEGATING had said "build it once, tested, and only then send variants on its look":
  every app has a look, so every app got variants. Now variants are for a take that is the work (a mark, a layout)
  or takes the user asked for; "Takes on its look cost the user's wait." Haiku did the same task in 27 s.
- **Gemini's logo-directions never converged.** Three variants polished ~7 rounds each; after restoring one it sent
  two more, both stopped at the 15-turn cap, then rewrote logo.svg 12 times and called a review at 832 s. The variant
  brief now says "breadth beats polish: fix what is broken, then stop; the caller polishes the one it chooses", and
  DELEGATING "One round of takes: then refine the one you chose, and stop when the next change would be a different
  taste, not a fix."
- **Grader:** Gemini painted overspent amounts #f87171 (red-400); the check wanted green and blue under 110 and got
  113. Red is now by hue (g and b under 0.6 r, within 50 of each other), so orange and pink still fail.
- Luna's failed edit blocks were the doubled-backslash case nearMiss now names; that run predates it too.

## Round ws7 (2026-10-02T03-14-21-kuh8): mean 0.85 on four tasks, all five models

A ws7 that TaskStop had "stopped" kept running beside this one for its first ~20 minutes (TaskStop on Windows leaves
`node eval.js` alive), so early runs ran at double load; app runs took 11–17 s instead of 3–5.

| model  | budget-evolve | notes-app | logo-directions | fork-fanout |
|--------|---------------|-----------|-----------------|-------------|
| haiku  | 8/11 | 6/6 (32 s) | 3/3 | 3/3 (fork cache 0.98) |
| sonnet | 11/11 | 6/6 (87 s) | 3/3 | 3/3 |
| opus   | 11/11 | timeout (602 s) | 3/3 | 3/3 |
| luna   | 11/11 (2568 s) | 6/6 (369 s, no variants) | 3/3 | 3/3 (fork cache 0.99) |
| gemini | 11/11 | 6/6 (453 s) | timeout (901 s) | 1/3 (answered without forking) |

- **The phone-width sheet.** A screenshot wider than 1.5× a phone's now carries the page at 390 px beside it, after a
  gray bar: one image, both widths. Earlier rounds: Haiku and Sonnet looked at a phone's width in 7 of ~50 runs, and
  Luna spent a run on every viewport.
- **The variant fixes held.** Haiku restored its chosen logo (0/3 → 3/3); Luna built notes-app with no taste
  variants (timeout → 369 s).
- **Haiku's budget-evolve: two real bugs its 34 tests missed.** ids were `Date.now()`, so two adds in one millisecond
  shared one and remove took the wrong transaction; and calls through `window.budget` never re-rendered, so
  $1,234.56 and the red row never reached the screen. Its tests drove the form, never the API back to back. Artifacts
  now say: "A script API (window.app) is a second door to the same state: a change made through it shows on screen
  as one made by hand. Test it as a script uses it: calls back to back, then what the page shows."
- **Gemini's logo still didn't converge, and the variants were not why.** It made three takes by 74 s, then rewrote
  the mark itself ~20 times (168–860 s), reviewed at 689 s and kept editing, and restored v5 at 874 s. The prompt's
  "stop when the next change would be a different taste" didn't hold, so the harness now says it mid-turn: once a
  turn's takes are back and the turn has made 6 versions since, the tool results carry "N versions since your takes
  came back. Stop when the next change would be a different taste, not a fix: say which take you chose and why."
  Once per turn.
- **Opus's notes-app timeout** was load plus a 260 s review that found nothing blocking; rerun clean in ws8.

## Round ws8 (2026-10-02T04-24-30-yxs3): mean 0.92 on four tasks, all five models (0.95 with the grader fixed)

| model  | budget-evolve | notes-app | logo-directions | long-session |
|--------|---------------|-----------|-----------------|--------------|
| haiku  | 10/11 | 6/6 (98 s) | 3/3 (81 s) | 5/7 |
| sonnet | 11/11 | 6/6 (86 s) | 3/3 | 6/7 |
| opus   | 11/11 | timeout (602 s) | 3/3 | 6/7 |
| luna   | 11/11 (2043 s) | 6/6 | 3/3 | 7/7 |
| gemini | 11/11 | 6/6 | 3/3 (322 s, was a 901 s timeout) | 7/7 |

- **The script-API line held.** Haiku's budget-evolve went from 8/11 to 10/11: remove, money and the red row now pass.
  The one miss is `over()` returning objects where names were asked for.
- **Gemini's logo converged.** It took 322 s, against a 901 s timeout in ws7.
- **long-session's misses are the grader's.** A fresh probe page has saved nothing until a change is made, so
  "in localStorage" is now read in the source. The columns probe matched "todo" but not "To Do". Both are fixed in
  tasks.js and apply from the next round.
- **Opus's notes-app timed out without contention.** The trace shows no hang. It spent 131 s writing 580 lines, 236 s
  in a review (12 tool calls, mostly run_app, that found 8 problems), and 71 s regenerating a 21-block patch that
  missed once. Review latency is now the cost to cut: a reviewer budget, or a faster reviewer model.

## Game baseline (2026-10-02T05-33-40-40t6): game-arcade and game-ambitious, before the game harness

| model  | game-arcade | game-ambitious |
|--------|-------------|----------------|
| haiku  | 10/11 (100 s) | 9/10 (91 s) |
| sonnet | 9/11 (317 s) | 9/10 (775 s) |
| opus   | 9/11 (579 s) | 9/10 (1172 s) |
| luna   | 9/11 (395 s) | 9/10 (481 s) |
| gemini | 9/11 (301 s) | 1/10 (205 s) |

- **Most misses were the grader's.** Its frame-gap p95 measured machine load, so it now times the page's own rAF
  callbacks. "Keeps drawing" failed games that hand their clock to scripts after step(), so the probe samples pixels
  first, by keys and a click (Haiku's and the reference need a click to start). tickMs counted a render per step(1);
  it is now step(600) / 600. Regraded, every arcade passes every game check, and every ambitious game but Gemini's
  passes. ref-slow fails "cheap" (12.2 ms a frame); ref-bad fails replay.
- **No model built in parallel.** Ambitious games took 8–20 minutes of one agent writing one file after another.
- **Gemini wrote only SPEC.md.** Two replies came back empty with reasoning only: a whole game in one write_file,
  finished as MALFORMED_FUNCTION_CALL, and the harness told it only "no text and no tool call".
- **Haiku's title screen can't be left by keyboard.** A real bug that nothing in its tests drove.

What changed for the next round:
- Artifacts teach a game's shape: a fixed-tick step over plain state, a seeded generator in the state, input as
  actions, scenes as one machine, window.game = { actions, reset, step, press, state } as the door, tests that step,
  a frame budget, and feel.
- The run report's frames line times the page's frame callbacks; the harness plays window.game twice from reset(7)
  in the test copy, and a replay that differs fails the run with a note on where.
- A `part` sub-agent: a variant that builds one named piece on its own branch (30 turns), beside the others, against
  the contract the parent wrote first. DELEGATING says when, and the unadopted reminder covers parts.
- The reviewer plays games: scripted to the moments that decide them, then by keys.
- Gemini's finishReason reaches the model: a malformed call or the output limit says to write the file in parts.

## Game round 1 (2026-10-02T14-36-18-iklp): mean 0.95 raw, 0.99 regraded (baseline 0.79 raw)

| model  | game-arcade | game-ambitious |
|--------|-------------|----------------|
| haiku  | 11/11 (237 s) | 9/10 (53 s) |
| sonnet | 11/11 (217 s) | 10/10 (761 s) |
| opus   | 11/11 (645 s) | 10/10 (1430 s) |
| luna   | 11/11 (368 s) | 10/10 (604 s) |
| gemini | 11/11 (254 s) | 10/10 (410 s, was 1/10) |

- **Gemini's ambitious game went from 1/10 to 10/10.** It wrote the file in pieces, with no malformed calls.
- **Every game's report carried the replay check, and every one replayed the same.** The games were written to the
  shape: a fixed tick, a seeded generator in the state, actions, and window.game with actions.
- **The output-limit note fired on Opus, which lost 440 s.** Its first reply was a whole game in one write_file
  that ran past 32k tokens and came back with nothing. Told why, it wrote a skeleton with #region markers and filled
  each region by edit. That is the seams pattern, in one file and one at a time. write_file's doc now says to start
  a long file as a skeleton.
- **No model sent a part.** Every game was one HTML file, and a part owns files, so there was nothing to split.
  The games block now says that a game past a few hundred lines is modules beside index.html (sim.js with no DOM,
  render.js, input.js, audio.js, levels as data), each one write and each a part against sim.js's state.
- **Grader fixes:**
  - The bot check read `bricks` as a count, but three models returned the standing bricks as a list. The prompt
    allows both, so now the grader does too.
  - Luna's title screen starts only from its button, which sits over the canvas the probe clicked. The probe now
    presses a visible start button, and the prompt says a scene is left by every input the game takes.
- **Reviews are still slow.** Opus's took 425 s, about 30% of its run.

## Game round 2 (2026-10-02T15-18-30-8wue): game-ambitious only, mean 0.98

| model  | score | time | files | parts |
|--------|-------|------|-------|-------|
| haiku  | 9/10 (fewer than 8 tests) | 383 s | index.html | 0 |
| sonnet | 10/10 | 964 s (761) | sim, render, input, audio, index | 2 |
| opus   | 10/10 | 1493 s (1430) | sim, render, input, audio, index | 0 |
| luna   | 10/10 | 557 s (604) | index.html | 0 |
| gemini | 10/10 | 359 s (410) | sim, render, input, audio, index | 0 |

- **The module layout took.** Three of five models split the game as taught.
- **Sonnet sent parts, the first model to, but was slower for it:**
  - 0–237 s: it wrote the whole 431-line sim.js as the "contract".
  - 243–457 s: it sent two parts, render and audio. Audio was done at 312 s and render at 455 s, and the parent sat
    idle until both returned.
  - After that it wrote input.js and index.html itself.
  - The fix, in DELEGATING: the seams are short stubs, the rules are a part too, every part goes out in one turn,
    and the biggest part is split, since the parts take as long as the slowest.
- **Opus lost 429 s to the output limit again.** This time no single file was too big: it put the write_file calls
  for all four modules in one reply. write_file's doc now says the limit covers all of a reply's calls: a few
  hundred lines a reply.
- **Reviews:** Opus's took 450 s (832–1280 s), and Sonnet's 215 s.

## Game round 3 (2026-10-02T15-46-16-991m): game-ambitious only, mean 0.94

| model  | score | time | files | parts |
|--------|-------|------|-------|-------|
| haiku  | 10/10 | 247 s | shooter.html | 0 |
| sonnet | 10/10 | 1210 s | index.html, src/ | 1 |
| opus   | 8/10 (Bedrock error mid-run) | 730 s | sim, render, input, audio, index | 0 |
| luna   | 10/10 | 1435 s | sim, render, audio, index | 3 |
| gemini | 9/10 (fewer than 8 tests) | 447 s | index.html | 0 |

- **Luna's run is the case for enforcing scope:**
  - It followed DELEGATING exactly: a stub contract by 36 s, then three parts in one turn at 62 s.
  - The parts took 564 s, and two stopped at 30 turns.
  - Every part's first call was a whole game in index.html. The audio part then wrote sim.js and render.js, and
    got to audio.js last.
  - Parts found one another's versions in history and restored them.
  - "Change only the files this names" is a request, and parts didn't keep to it, so the tools now enforce it.
    A part takes `files` (paths, or folders ending in /) and must name them. write_file, edit_file and restore
    refuse other paths with "X isn't yours: this part owns …. The rest is the contract: read it, build against it,
    and say in your final message what it lacks."
- **Opus lost 394 s to the output limit a third time.** The doc line didn't prevent it. Bedrock accepts 128k out
  for Opus and Sonnet 5.5, so CLAUDE_5 now sets maxTokens to 64k, leaving room for adaptive thinking.

## Game round 4 (2026-10-02T16-26-35-wazl): no signal

Every run failed on "network error" / "Failed to fetch" from its first requests. Sonnet, Opus, Luna and Gemini spent
0 tokens; Haiku made 31 calls, and 17 of them failed. The machine likely slept. Parts with `files` went untested,
and the round is not counted.

## What a part is actually sent, and why parts didn't keep to their brief

From Luna's round 3 request.json and its part threads:

- **The context is the caller's.** A part gets the caller's system prompt, about 6.2k tokens over 367 lines, and the
  caller's 11.6k chars of tool specs, both kept for the cache. It also gets the caller's whole history, which starts
  with the user's "Make a top-down arena shooter". Its own brief arrives last, inside a tool result. Everything before
  the brief says "you orchestrate": SPEC.md, review before done, the task tool. Two parts called `task` (a fork, then
  a review) and were refused.
- **The brief asked for what only the whole can do.** "Test your part through the contract, the way the whole will
  use it, and look at what it draws". But the whole was stubs, and a sim draws nothing without a renderer. So each
  part built the whole game first: its first call was a 286-line index.html.
- **Branches weren't isolated.** history listed every branch's versions, and restore took any of them. The render
  part restored the sim part's v16 and the audio part's v22. In the end, the sim part restored the stubs over its own
  index.html.
- **Integration came down to choosing among whole games.** Each part returned versions for every file it had
  touched. The parent spent 30 s on history and took one part's whole-game index.html (v40) over the modules.
- **The owned-folder check never matched.** normalizePath keeps a trailing /, and the code appended another, so
  `sfx/` became `sfx//`. The ownedTools test passed `sfx/` directly and missed it.

The changes:

1. **A part's tests are its own.** The seams include a test file per part, which the page's tests import. The part
   tests its piece by itself: it steps a state it made, draws a state it made, or calls the sound. The brief says
   the other files are stubs until their parts land, and are never to be built in their place.
2. **One file, one part.** Two parts in one turn that claim the same file, or a folder over it, are both refused.
3. **A part's files are adopted when it returns.** Ownership is disjoint, so taking them can't collide. The result
   carries `adopted` and "These are your files now: run the whole." The parts branch of the unadopted reminder is
   gone.
4. **Branches are isolated.** Each version records its branch. On a branch, history lists only main's versions
   and the branch's own, and readVersion refuses another branch's version ("another sub-agent's").
5. **The persona says the brief holds.** A fork, variant, or part finds its brief in its own call's result, and
   where the brief and the prompt differ, the brief holds.
6. **Fixed:** the variant adopt note was a plain string, so the model read a literal "${type}".

## Game round 5 (2026-10-05T18-32-43-nhph): game-ambitious, raw mean 0.74, regraded 0.98

| model  | raw | regraded | time | files | subs |
|--------|-----|----------|------|-------|------|
| haiku  | 10/10 | 10/10 | 321 s | index.html | 0 |
| sonnet | 10/10 | 10/10 | 1179 s | index.html | review |
| opus   | 0/1 (timeout at 1500 s) | 10/10 | 1500 s | sim, render, input, audio, 3 test files, index | 3 parts, review |
| luna   | 8/10 (no final report) | 10/10 | 808 s | index.html | 3 variants, review |
| gemini | 9/10 | 9/10 | 420 s | index.html | review |

- **Opus ran parts as designed.**
  - At 212 s it wrote the stubs and a test file for each part (sim.test.js, render.test.js, io.test.js), and at
    243 s an index.html whose tests import them.
  - At 313 s it sent three parts in one turn, each with `files`.
  - Each part built its own files and its own tests: 16, 24 and 10 messages. There were no ownership refusals,
    no sibling refusals and no overlaps.
  - All three were adopted, and the whole ran at 906 s with 34 tests passing.
  - In round 3, Luna's parts each built a whole game and two hit the 30-turn cap.
  - Opus's time went to its 100-line SPEC.md (207 s), the slowest part (593 s), and a review (440 s) that found
    nothing game-breaking. It timed out while fixing the review's nits. Its files regrade 10/10.
- **Luna didn't use parts this time.** It sent three whole-game variants, which DELEGATING reserves for taste. One
  variant came back after one empty turn ("Completed", no versions). The heads have no report, so "last run report
  ok" read none, though Luna's last edit reported ok at v12: an eval collection gap still to find.
- **Gemini's title has no keyboard way out.** Only an "INITIALIZE SYSTEM" button starts it, and Enter and Space do
  nothing. That breaks the scenes rule, and the FAIL stands.
- **Two grader fixes:**
  - The probe now holds Enter and Space for 120 ms, since a start read as a held action never saw a press released
    in the same instant.
  - gradecheck.tmp.mjs served .js as text/html, so module games never loaded: earlier regrades of multi-file games
    under-counted "keeps moving".
- **Reviews are now the longest step:** Luna's took 204 s, Opus's 440 s, and both found nothing that mattered.

## Grok 4.7 (2026-10-05)

Added as `global.xai.grok-4.7` on Bedrock, alias `grok`. probe-grok.mjs found:

- **Like Sol and Luna:** no cache points, no documents, and an image read only beside a tool result, never inside it.
  It caches the prefix by itself (9472 of 9516 input tokens read on a replay).
- **Effort:** `reasoning: { effort }` takes low, medium, high and xhigh, and refuses none, so there's no off.
  `reasoning_effort` is ignored. maxTokens takes 128k.
- **Above low, a harness turn gets no reply.** The first eval ran at the default high and failed at 301 s: "The
  model sent nothing for 300 seconds." Replaying its request (10k tokens, 14 tools) directly: high got no response in
  15 minutes and medium none in 10; low answered in 40-90 s. Its only level is low.

| model | raw | time | files | delegation |
|---|---|---|---|---|
| grok (low) | 9/10 | 103 s | index.html | none |

- One write and three edits, one screenshot, 7 tests (8 wanted). It is quick and shallow: no SPEC.md, no parts,
  no review.

## Probes retired (2026-10-12)

The one-off probe scripts in the repo root were deleted; what they found is above, and git history has none of them
(they were never committed). Re-create one from its description if a finding needs re-checking.

- probe-reasoning.mjs, probe2.mjs: reasoning levels and which params stream readable text (section 9). Sol and Luna
  return only redacted bytes whatever `reasoning.summary` is set to; Claude 5 needs `display: "summarized"`.
- probe-eager.mjs, probe-eager2.mjs: `eager_input_streaming` through Converse (section 14).
- probe-media.mjs, probe-openai.mjs, probe-beside.mjs: which media each model reads in a tool result, and that Sol
  and Luna read an image placed beside the result (sections 21, 22).
- probe-clip.mjs, probe-fit.mjs: the cropped screenshot and the desktop-width fit (section 23).
- probe-maxtokens.mjs: Opus and Sonnet 5.5 accept 128k maxTokens with adaptive thinking (game round 3).
- probe-grok.mjs: Grok 4.7 on Converse (the Grok section).
- probe-haiku.tmp.mjs: the Haiku 5.5 model id (`global.anthropic.claude-haiku-5-5`), its effort levels, maxTokens
  and a system cache point. Its results weren't written down; what the engine encodes (CLAUDE_5 levels plus off via
  `thinking: { type: "disabled" }`) is what it settled on.
- gradecheck.tmp.mjs is now evals/gradecheck.js: `node evals/gradecheck.js <task-id> <folder>` grades a folder of
  files with a task's check, no model involved.
