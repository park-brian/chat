# Experiment log

Every change to the harness is an experiment: a question, a hypothesis with a predicted effect and a reason, a
method that changes one thing, a result with its spread, and what we now believe. Raw eval output is in
`.artifacts/`; run-by-run notes are in `evals/NOTES.md`; this log keeps the reasoning.

## Method

- **One variable per experiment.** Everything else is held fixed: model, effort, tasks, repeats, judge.
- **Predict before running.** Write the hypothesis and the expected direction and size first.
- **Know the noise.** Measured in E5 on identical code (Haiku, ×3 per task): tier means move up to 2 points,
  single tasks up to 12. A tier change over 3 points is a signal; a single task needs over 12 points or a
  mechanism seen in transcripts. Single-repeat comparisons (Gemini ×1) are anecdotes.
- **Read transcripts, not just scores.** A score says something changed; the transcript says why.
- **Check the grader too.** Two "regressions" so far were grading bugs (E2's lodash key, E1's decision rubric).
- **Record what was refuted** as carefully as what held.

Metrics: mean pass (share of checks passed, averaged over graded runs), pass^k (tasks that pass every check on
every repeat), cost (input tokens in uncached equivalents), seconds, and task-specific counts from transcripts.

## Current beliefs

| # | Belief | Evidence | Strength |
| --- | --- | --- | --- |
| B1 | A rule in the system prompt is followed less than the same rule injected at the right moment | E3: plan file 0/3 with the prompt rule, 3/3 with an injection after 8 calls | tentative (n=3, one task) |
| B2 | Models report in the vocabulary of the process they run; removing one trigger doesn't stop it | E6: leak 0-2/21 before the director, 15/21 with it; E6b: removing the strongest trigger left it at 11-12/21 | strong (the cause is the process, not one note) |
| B9 | Asking the model to change wording rarely holds; checking the output and asking for a fix might | E4b (wording) 15 → 11; E6b (rule change) 11 → 11-12; E6c pending | tentative |
| B11 | For Haiku 5.5, effort medium is better than high on agentic work, not just cheaper | E24 games 1.00 vs 0.94 at a third to half the time; swe 0.94 vs 0.92 at -40% time, no timeouts vs 3 | strong (two tiers, tier-level) |
| B10 | An affordance (a tool that makes the right action easy) changes behavior more than an instruction | E10: a way to run test files cut test-running confusion 11-16 → 3/21, claim failures to 0, leak 11-12 → 5/21, swe +4 | strong (tier-level, mechanism in transcripts) |
| B12 | On edits to existing code the director's contract costs more than it gives | E25b: goal note off: calls -38%, tokens -30%, leak 13/21 → 1/19, code checks unchanged | strong (one tier, ×3, mechanism in transcripts) |
| B3 | Tool error messages steer behavior | E4c: "No project is open yet. Create the app with write_file" preceded a 2,317-line app for a prose request | one transcript |
| B4 | Making the model compute with code fixes counting errors | E1: arxiv 0.64 → 0.97, lodash 0.85 → 1.00 | moderate (two tasks, ×3) |
| B5 | Unbounded context grows with page reads; a budget plus summaries bounds it | E3: 280k → 30-60k per request on the long report | strong (direct measurement) |
| B6 | Summaries drop sources unless told to keep them | E3: 2/3 reports without links; E3b: 1/3 | tentative |
| B7 | Short, well-posed questions are already answered well by Haiku 5.5 | answer set 0.97-0.98 across rounds | strong (saturated) |
| B8 | A harness that adds process to small tasks makes them worse | E4: fix-bug rewritten after four plan calls; inner 1.00 → 0.88 | moderate |

## Experiments

### E1. Literal persona and working rules (round 1, 5d81348)

- **Question:** does rewriting the prompt literally, with verify, cite, compute-with-code, plan-file and
  ambiguity rules, improve answers on the hard tiers?
- **Hypothesis:** yes, mostly on research (compute, cite) and answer-hard (assumptions, audience), by 5+ points.
- **Method:** Haiku 5.5, effort high, ×3 on research, answer-hard, swe, answer; inner ×1. Against baseline B.
- **Result:** research 0.88 → 0.98, answer-hard 0.86 → 0.89, swe 0.95 → 0.96, answer 0.97 → 0.98, inner 0.97 → 1.00.
- **Analysis:** research's gain is large and has a mechanism in the transcripts (code runs for counts). The others
  are within what noise might be. The plan-file rule had no effect (0/3).
- **Learned:** B4. Rules that describe an action the model takes anyway (compute) work; a rule about a separate
  bookkeeping step (write a plan file) doesn't.

### E2. Network tools that match reality (round 2, 39cad47)

- **Question:** do honest network instructions, cause-naming CORS errors and `web.read` in code change scores?
- **Hypothesis:** small or none in evals (the proxy runs there); the value is for the published app.
- **Result:** research 0.96, answer-hard 0.89, swe 0.96: unchanged. `web.read` used in 2 of 63 transcripts.
- **Analysis:** as predicted. A drop on lodash was the answer key (305 in a browser, 306 under CommonJS).
- **Learned:** a new tool isn't used unless something gives the model a reason to; graders need checking when a
  score moves.

### E3. Context budget and plan reminder (round 3, 3a0f703) and E3b (sources kept)

- **Question:** with requests bounded (256k default, 100k Haiku) and a reminder after 8 calls, does long work keep
  its plan and stay correct?
- **Hypothesis:** context per request drops sharply; the plan file appears; scores hold.
- **Result:** plan file 3/3 (0/3 before); requests 30-60k (280k before); scores held; 2/3 reports lost their links;
  cost per run up 15-25%. E3b (summary and reminder keep URLs): 1/3 reports without links.
- **Learned:** B1, B5, B6. Bounded context has a price in cache breaks.

### E4. The director, first run (de36eda)

- **Question:** does a contract of harness-run checks plus a rules table improve long and intent work without
  hurting the rest?
- **Hypothesis:** intent and long improve; short tiers unchanged.
- **Result:** long finished 3/3 (2/3 timed out before); intent 0.84 → 0.85; research 0.98 → 0.99; swe 0.97 → 0.88;
  inner 1.00 → 0.88.
- **Analysis:** the regressions had three causes found in transcripts: contract vocabulary in replies (B2), the
  director starting on small tasks through a 100-word request trigger (B8), and a stall rule that read research
  as no progress.
- **E4b (d0ca249):** tool-call trigger only, replies in the user's terms, research counts as progress. inner back
  to 1.00; swe 0.90; intent 0.86; Gemini timed out three times, once building a 2,317-line app for a prose plan.
- **E4c (da412ed):** the no-project error no longer says to create an app; the plan doc says a question or prose
  plan needs no contract; the all-done note asks a fix's report for its cause. Result: Gemini had no timeouts
  (3 in E4b) and answered the GraphQL request with one view_file, as before the director (E4b: a 2,317-line app);
  intent 0.81 and answer-hard 0.91 on 6-7 runs each, against 0.88 and 0.95 on the 4-6 runs E4b finished. Haiku swe
  0.88 (E4b 0.90), leak 11/21: unchanged, as E6 explains. Supports B3 (one repeat per task: tentative).

### E6. Vocabulary leak (B2), measured on saved transcripts

- **Question:** how often do final replies speak in contract terms, and what causes it?
- **Hypothesis:** the leak rises with the director and falls with E4b's "user's terms" wording.
- **Method:** every swe final reply (21 per round), regex for "item N", "the check", "the harness"; validated by
  reading flagged replies (all were real leaks, e.g. "The harness shows it as open because the check was already
  green when I added the item"). Cross-tabbed against whether the open-items or red-first injection had fired.
- **Result:** baseline and rounds 1-3: 0-2/21. Director v1: 15/21. After E4b: 11/21. After E4c: 11/21.
  Two rounds, leak by injection: leaked after an injection 10 and 10; leaked without one 1 and 1; injection without
  a leak 5 and 8; neither 5 and 2.
- **Analysis:** B2 confirmed and quantified. The wording fix barely helped (15 → 11). 20 of 22 leaking replies came
  after an open-items or red-first note. The trigger is structural: on a bug fix the repository's existing tests
  already pass, so a check on them is flagged red-first, the item can never be done, and the stop rule then tells
  the model that items are open; the model explains this to the user.
- **Learned:** an injection the model can't act on turns into an explanation to the user. Wording can't fix a rule
  that fires when nothing can be done.
- **Next (E6b):** a red-flagged item no longer counts as open at the stop (it is unverified, and the reply says so
  plainly), and stop-time notes say they are for the model, not for the reply. Prediction: leak at most 3/21 and swe
  at least 0.95 (pre-director 0.97).

### E5 + E6b. Noise floor, and weak items no longer open (0df40e3)

- **Questions:** (E5) how far do results move when nothing changes? (E6b) does dropping weak items from the
  open-items rule stop the leak and restore swe?
- **Hypotheses, written before the run:** (E5) the two identical copies differ by under 3 points on each tier's
  mean, but single tasks move by up to 10-15 points on ×3. (E6b) leak at most 3/21 per copy; swe at least 0.95.
- **Method:** the same commit run twice (copies a and b): swe, answer-hard, intent ×3 each, Haiku 5.5, effort high;
  inner ×1 for regressions. Noise = |a − b| per tier and per task. E6b effect = mean(a, b) against E4c.
- **Result so far:** swe a 0.92, b 0.90; answer-hard a 0.90, b 0.90; intent a 0.86 (b running). Leak: a 11/21,
  b 12/21.
- **E6b refuted.** The leak didn't move (11-12/21 against E4c's 11/21; predicted at most 3). Removing weak items
  from the stop rule wasn't the cause. Leaking runs had slightly more director notes (7.3 against 5.7 on average)
  and the same number of plan calls (7.7 against 7.6): the model uses the contract heavily on every swe run and
  reports in its terms. One injection isn't the source; the contract's presence in the run is.
- **E5 result (complete).** Same code twice, Haiku ×3 per task: swe 0.92/0.90, answer-hard 0.90/0.90, intent
  0.86/0.84. **Tier means move by up to 2 points; single tasks by up to 12 (klona 0.91/0.79), 3.5 on average.**
  inner ×1: 0.94.
- **What that changes.** A tier change of more than about 3 points is a signal; a single task needs more than
  about 12, or a mechanism found in transcripts. Re-judged: round 1's research gain (+10) and the director's swe
  drop (-7 to -9) are real; the decision-record "regression" (-11 on one task, E1), most single-task moves, and
  the Gemini single-run comparisons (×1) are within noise. Beliefs resting only on single-task moves are
  downgraded.
- **Next (E6c):** enforce instead of ask. A stop rule checks the final reply for contract vocabulary ("item N",
  "the check", "the harness", "the plan") and asks for a rewrite in the user's terms, once. Prediction: leak at
  most 2/21, swe unchanged or better, one extra turn in about half the runs. Also worth testing: 7.7 plan calls
  per bug fix is overhead; raise the director's start threshold for edits to existing code (E13).

### E10. Running a repository's tests (user observation, 2026-10-13)

- **Observation (user):** the coder thinks it can't test code, because tests run automatically and must live in the
  page; it sometimes plans to call `node --test`, spending thinking tokens on a tool that doesn't exist.
- **Measured on saved transcripts:** swe reasoning mentions running node, npm or a terminal, or being unable to run
  tests, in 16/21 (baseline B), 12/21 (E4b) and 11/21 (E4c) runs. Examples: "Since I can't execute node …",
  "probing feels infeasible without page-level loading of the source". It then settles on text-presence checks
  ("those were just text-presence checks confirming my edits exist, not that the behavior works").
- **Hypothesis:** the harness lacks an obvious way to run a `node:test` file. If run_app runs a test file directly
  (mapping node:test and node:assert to browser versions and returning pass/fail counts), and the docs say plainly
  that there is no Node or shell and how tests run, then: reasoning about running tests falls below 3/21; test
  checks replace text checks in the contract; claims of test counts match reports (the "reports only results it
  got" check stops failing); swe's mean rises.
- **Method:** build it, then swe ×3 against E6b's copies (same code otherwise; the seeds now carry the app's
  runner, a small confound); count reasoning mentions, run_app on test files, claim failures, leak.
- **Result (b87941f):** swe 0.95 (E6b copies 0.92 and 0.90: +4, beyond tier noise); pass^k 2/7 (0/7). Reasoning
  about running tests 3/21 (11-16). run_app on a test file in 21/21 runs. "Reports only test results it got"
  failures 0 (several per round before). Leak 5/21 (11-12), not predicted.
- **Analysis:** every prediction held. The leak fell without any change aimed at it: with real counts to report,
  the final message talks about the tests rather than about the plan's items (a hypothesis, from reading replies).
- **Learned (B10):** giving the model an affordance (a way to run the tests) changed behavior more than any
  instruction we tried, including the four wording attempts on the leak.

### E11. Shell spike (design: docs/specs/2026-10-13-shell.md)

- **Question:** can a real-enough shell run in a static page, without COOP/COEP, fast enough for a cheap model?
- **Hypotheses, before the spike:** just-bash runs in a Worker and passes the coreutils list; a DIY `node` with a
  CommonJS loader and polyfills runs the swe seeds' `node:test` files with the right counts; `npm install` from
  registry tarballs works for small pure-JS packages and fails for packages that need native code or sync
  resolution tricks; Worker.terminate() stops an infinite loop where in-page guards can't; cold boot under 1 s.
- **Method:** a spike page driven by Playwright with a fixed command list, served without COOP/COEP
  (crossOriginIsolated false, no SharedArrayBuffer), as on GitHub Pages. Branch 2c74ee3, `spike/`.
- **Result: 66 of 67 items passed.**
  - **just-bash** (pinned via esm.sh) in a Worker: coreutils, pipes, redirects and loops all pass. Cold boot to
    first result 318 ms (190 ms warm cache), median command 1.4 ms, 490 KB brotli. Its browser build has no tar
    and a broken gzip, so the spike wrote both (60 lines on CompressionStream). `while true` stops by its limits
    (exit 124) or by Worker.terminate() (about 0 ms; restart 334 ms).
  - **DIY node layer** (nested Worker, CommonJS and ESM loaders, bundled polyfills, 62 KB): `node -e`, `.cjs`,
    `.mjs`, writes back to the shell FS, `node --test` with Node's exact counts (dequal 44/44, ms 47/47; hidden
    tests fail before the fix and pass after), `npm test`, and a sync infinite loop terminated (exit 124).
    `node -e "1"` takes 6-20 ms on a small tree.
  - **npm from registry tarballs:** ms, chalk@4 (6 packages), lodash (600 files), an ESM-only package, and
    typescript 5.9.3 (`tsc --noEmit` reports TS2322, exit 2). Fails: `require()` of an ESM-only package.
  - **git** (isomorphic-git plus a jsdiff `diff`): init, add, commit, status, diff, log.
  - **Python** (Pyodide): `-c`, files on the shared FS, pip install of six, attrs and numpy, pytest with exit
    codes, pandas + duckdb + matplotlib with the PNG read back. Cold boot 7.9 s, warm command 266 ms; the science
    stack is 22.6 MB of wheels and must be cached by us in Cache Storage. A terminated Python costs a 5-7 s reboot.
  - **GPU:** WebGPU in the node Worker works in Edge and Chrome; not in Playwright's bundled Chromium here.
    TensorFlow.js trains (webgpu 4.4 s in Edge); onnxruntime-web runs only if `process.versions.node` is hidden.
  - **almostnode** fails `node -e`, CommonJS, ESM imports and `--test`, and runs on the main thread where it can't
    be stopped: rejected.
- **Analysis:** every prediction held except two: npm did better than expected (typescript works) and Python's
  cold boot is 8x the 1 s target, which only the shell and node meet.
- **Learned:** a real enough shell runs on static hosting today. Looking like Node is a double edge: libraries
  that support both take their Node path when they see `process.versions.node`, so the loader needs a per-package
  policy (prefer the `browser` export condition).

### E14. Following Anthropic's "Prompting Claude Haiku 5.5" guide (read 2026-10-13)

The guide gives tested texts and placements; ours are paraphrases or differ. One is a bug, the rest are
experiments, each against the noise floor from E5.

- **Bug (fix, no experiment): the date.** The guide: render the date once when the conversation starts and keep
  `system` unchanged; on a later day give the new date in the newest turn. Ours renders it on every request, so a
  conversation that continues past midnight changes `system`, which returns a 400 once thinking blocks are sent
  back. Fix: the date comes from the thread's start (like memories, taken once per thread), and a later day adds
  a one-line note to the newest turn.
- **Bug (fix): refusals.** `stop_reason: "refusal"` is not handled; the turn should end with a plain message that
  the model declined, not an empty reply or a retry loop.
- **E14a. Tested texts.** Replace our paraphrases with the guide's texts for search ("Your training data ends
  well before today's date…"), early stopping ("Keep working until everything the user asked for is done…") and
  verification ("When you change code that can be run…"). Our round-1 line "facts that can change come from a
  tool" is close to the blanket rule the guide says doubled needless searches. Measure: answer (restraint tasks:
  searches on questions that need none), research, swe (checks run before reporting), the "reports only results
  it got" check. Prediction: needless searches unchanged or fewer; swe claims check failures fewer.
- **E14b. Notices as system messages.** The guide: keep harness notices in a separate mid-conversation system
  message; Haiku can treat text placed right after a tool result as untrusted. Ours are text blocks beside the
  tool results. Hypothesis: notices are followed more often as system messages. Measure on the director's notes:
  the share of "goal" notes followed by a plan call, of "same failure twice" notes followed by reading the code,
  and of claim-check notes followed by a corrected reply. Needs Bedrock support for mid-conversation system
  messages in the Converse API (check first; if absent, test the newest-turn placement instead).
- **E8 (effort)** now has the guide's prior: medium is the default for agentic coding, high for strict
  instruction following; low stops early and skips checks.

### E15. The lead keeps working while sub-agents run (Anthropic guidance for Fable 5.1)

- **Guidance:** don't make the lead stop and wait for each sub-agent. The tool that starts one returns at once;
  each result arrives in a later user message; a separate tool waits when the lead wants to. On coding tasks this
  lowered average time to completion at similar quality, tokens and cost. "The model still often chooses to wait.
  The time savings come from the runs where it carries on."
- **Ours today:** `task` blocks until the sub-agent finishes (parallel calls in one turn block until all finish).
  The novella run (long baseline) shows the cost of the opposite failure: the lead gave up on four of six
  chapter sub-agents and revised chapters they were still writing.
- **Hypothesis:** for cheap models the gain is smaller than for Fable, and there is a risk: Haiku may lose track of
  work in flight or edit files a running sub-agent owns. With the harness tracking what is in flight (a running
  sub-agent's files locked to it; its result delivered in the next message; the lead told at its stop which are
  still running), long work finishes faster at the same quality.
- **Method:** async `task` (returns `{ started: id }`), results delivered as harness user messages, a `wait` tool,
  file ownership enforced while running, and a stop rule for sub-agents still running. Flag `subagents=async`
  against the current blocking default on long-novella, game-ambitious and hard-ssg-report, Haiku and Gemini,
  ×3: seconds to completion, score, tokens, edits refused for ownership, and how often the lead waited.
- **Result:** pending.

### E16. A timestamp on every message (user, 2026-10-13)

- **Idea (user):** include the time in each message sent to the model, so it knows how long things take and what
  time it is for the user.
- **Design, which also fixes E14's date bug:** the system prompt keeps only the date the conversation started
  (rendered once, so `system` never changes). Each user message gets a harness block with the user's local time
  and UTC offset ("Sent 2026-10-13 14:05 (UTC-04:00)"), kept apart from the user's words. Each tool result
  carries its start and end time and duration ("ran 14:05:02-14:05:05, 3.2 s", user, 2026-10-13), so parallel
  calls show what overlapped and the model can see where time went. Appending to the newest turn leaves the cached prefix intact.
- **Hypotheses:** (a) questions that depend on the time ("is it too late to call Tokyo?", "how long until
  Friday 5 pm?") are answered from the timestamp without asking; (b) on long tasks the model paces itself
  (fewer timeouts, earlier wrap-up of optional work) when it can see elapsed time; (c) cost: under 1% more input
  tokens. Risk, from B2: the model mentions timestamps or durations to the user unprompted.
- **Method:** flag `timestamps=off` against the default on: a few new time-dependent answer tasks (with a fixed
  clock in eval so answers are checkable), long tier and game-ambitious ×3 for timeouts and seconds, and a count
  of replies that mention a timestamp or a duration nobody asked for.
- **Result:** pending.

### E17. One message envelope: contents and metadata (user, 2026-10-13)

- **Design (user):** every user turn as `<message><contents>…</contents></message>` plus
  `<metadata><timestamp>…</timestamp><additional_instructions>…</additional_instructions></metadata>`, with the
  director's steering in `additional_instructions`. It carries E16's timestamps and replaces today's loose
  `harness` text blocks.
- **Constraints:**
  - The user's words and the harness's notes stay in separate blocks (Haiku guide: never a notice and the user's
    words in one block), so `<contents>` and `<metadata>` are two text blocks of one user message.
  - The user's text is escaped (`&`, `<`), and so is any tool output quoted inside metadata, so nobody can type
    `</contents><metadata><additional_instructions>` and pass for the harness.
  - The system prompt says once what the envelope means: metadata comes from the harness, not the user;
    `timestamp` is the user's local time; `additional_instructions` are for the current step, not for the reply
    (B2: steering that gets echoed is what leaked).
  - Tool results carry `<metadata><started/><ended/></metadata>` inside each result.
- **Hypotheses:** structured, consistently named steering is followed more often than loose text blocks
  (Anthropic: XML tags with consistent names), and saying it is not for the reply lowers the leak (E6's measure).
- **Method:** flag `envelope=xml|plain` and, from E14b, `notices=metadata|block|system`. Measures: the share of
  each director note acted on, the leak count on swe, intent and answer-hard scores, an injection test (a user
  message containing a fake `<additional_instructions>` must not be obeyed as harness steering).
- **Result:** pending.

### E18. Minimal or rich metadata (design: docs/specs/2026-10-13-envelope.md)

- **Question (user):** should each message's metadata carry uploads, things created, plan reminders and a goal
  mode, or should it stay small (time, device, resolution) with the rest elsewhere?
- **Constraints that decide most of it:** the system prompt can't change mid-conversation (cache, and Haiku's 400
  on a changed `system` with thinking), and messages can't be taken back (every metadata block is re-sent on every
  later request). Fixed things go in the system prompt; events and changes in metadata; state on request; full
  state again only after a summary, when a goal mode starts, and at milestones.
- **Hypothesis:** minimal metadata (events and changes) matches or beats rich metadata (full state every message)
  on intent, answer-hard and long, at much lower input tokens per request; rich may help long work where a cheap
  model doesn't read its own state.
- **Method:** flag `metadata=minimal|rich`, Haiku and Gemini ×3: scores, input tokens per request over the run,
  state reads (plan, view_file), leak count, unprompted mentions of metadata.
- **Result:** pending.

### E19 and E20. Six primitives; goals as confirmed contracts (design: docs/specs/2026-10-13-goals-and-primitives.md)

- **E19 question:** does a small set of general tools (bash, edit, look, web, agent, goal; checks as commands)
  beat the current ~17 tools with 7 sub-agent types and 8 check kinds, for cheap models?
  **Prediction:** equal or better scores with fewer steps and tool errors; the largest gain on Gemini (its guide
  advises 10-20 tools; E4c showed tool presence steering it).
- **E20 question:** is a goal better as a contract the model proposes and the user confirms (checks failing now,
  a budget, run to green) than as the current director that starts after 8 calls?
  **Prediction:** no run keeps revising after its checks are green; no red check at "done"; no process on small
  tasks (B8); leak count near the pre-director level (E6), since the process is the model's own proposal and
  the harness speaks only on state changes.
- **Status:** after the shell (E12) lands.

### E23. Seeing a whole page (design: docs/specs/2026-10-13-capture.md)

- **Question:** which full-page capture should `run_app { full: true }` use: scroll and stitch over tab capture,
  snapdom, HTML-in-Canvas, or our own DOM snapshot (snapshot.js)?
- **Method:** spike/capture.mjs drives spike/capture.html (a same-origin frame, as the preview is) in Chrome 156
  (Playwright's chromium-1248, `--enable-blink-features=CanvasDrawElement`, tab capture auto-accepted) at
  1024x768 on seven pages in spike/pages. Truth: Playwright's `fullPage` screenshot of the same page in the same
  browser. Score: the share of pixels with no pixel within one of it in the other image within 40/255 (an edge
  antialiased or chroma-subsampled differently is the same picture), per screen band and per marked region.
  `--disable-lcd-text` and `--hide-scrollbars` so the truth's subpixel text and scrollbars aren't scored. Median of 3.
- **Result** (ms, diff share; spike/out/results.md):

  | page | stitch (tiles × ms) | snapshot (ours) | snapdom 3.3.3 | HTML-in-Canvas |
  | --- | --- | --- | --- | --- |
  | article, 8612 px (11 screens) | 1018 (12×84), 0 | 13, 0 | 75, 0.669: 100vh hero laid out as the page's height | 58, 0 |
  | sticky + fixed | 599 (7×86), 0.002 | 3, 0 | 36, 0 | 49, 0 |
  | lazy images | 1381 (5×252), 0 | 2776, 0 | 2917, 0.251: page cut short | 2837, 0 |
  | canvas game | 164 (2×79), 0.032 | 65, 0.033 | 72, 0.086 | 86, 0.032 |
  | WebGL | 154 (2×75), 0.007 | 68, 0.156: once-drawn canvas blank | 88, 0.191: blank | 101, 0.156: blank |
  | CSS animations | 269 (3×102), 0 | 8, 0.001 | 96, 0.028 | 48, 0 |
  | form, focus, hover | 284 (3×93), 0 | 4, 0 | 95, 0.046: hover, focus, values lost | 35, 0 |

  The game's and the animated WebGL scene's residue is motion between the truth's moment and the method's, the
  same for every method. Lazy pages are network-bound (the spike server delays each image 250 ms, uncached).
- **Findings:**
  - Hypotheses: stitch is faithful everywhere and the only method that shows a WebGL canvas drawn once without
    `preserveDrawingBuffer` (toDataURL, drawImage and createImageBitmap all read it back empty). Its 75-102 ms a
    tile meets the 50-100 ms hypothesis, but half of that is waiting to learn that no new frame is coming: tab
    capture sends frames only on repaint, and waiting for "the next frame" first cost 500 ms a tile.
    Stitch's seams came from the capture, not the page: a frame captured before the tile's paint (half-drawn
    photos, animations a few hundred ms off) until `after` became the paint after the images decoded; and the last
    tile placed by the page's old height when an image without a size grew it.
  - Playwright's truth puts a fixed footer at the first screen's bottom, not the page's end. "Hide fixed after the
    first tile" matches it (0.002); showing bottom-anchored ones in the last tile instead (0.021) does not.
  - Our snapshot matches HTML-in-Canvas pixel for pixel on every page (they share the frozen clone) at a third to
    a tenth of the time, and beats snapdom everywhere: snapdom has no vh fix, no hover or focus, and missed lazy
    images. Getting there needed: 100vh rewritten to the viewport's pixels (a foreignObject's viewport is the whole
    page), fixed elements placed where the first screen has them, canvases kept as canvases (their selectors) with
    the frame as a background, lazy images loaded first.
  - HTML-in-Canvas works behind the flag in Chrome 153-156 and Edge 155; Chrome 156 also takes the renamed
    `content="drawable"`. A canvas off screen or at opacity 0 paints its children blank (clip-path: inset(50%)
    works), and removing an iframe from a drawable canvas crashed the renderer, so the surface is kept and reused.
- **Decision:** `full: true` tries HTML-in-Canvas where the browser has it (as designed; equal to ours here), then
  stitch while the tab is shared (met the target, real pixels), then snapshot.js; snapdom is not used. Each one
  that fails hands on to the next.
- **Revised (integration, 2026-10-13):** HTML-in-Canvas is dropped: it was never more faithful than snapshot.js
  (the same frozen clone, pixel for pixel) and shares its WebGL blind spot, behind a flag. `full: true` is stitch
  while the user shares the tab (real pixels, the only method with WebGL), else snapshot.js; a failed stitch
  hands on to the snapshot. The spike measures those two now.
- **Next:** whether models stop squeezing content (the spec's "Then").

### E15 result, and two failures it exposed (9ac8abd, Haiku ×2 per arm)

- **Scores:** blocking 0.61 (game-ambitious 0.55, hard-ssg-report 0.83, long-novella 0.44); async 0.64 over 5
  graded (ssg 0.96 in 223 s against 329 s; game 0.55; novella 0.17, plus one unfinished whose files pass 16/18).
- **Inconclusive.** ×2 per arm is below the noise floor for single tasks, and both arms were dominated by two
  failures unrelated to sub-agents. The faster, better ssg report under async is the only hint; it needs ×3+.
- **Failure 1: the director declared an unfinished game done.** Haiku's contract had one item ("the rules
  engine"); its check passed; the director said "Every item is done: compare the work with the goal, then tell the
  user…"; Haiku stopped with nothing playable ("The game is not finished… Nothing is playable yet"). Items don't
  define done; the goal does. Fix (E20's premise): a goal's done criteria are checks on the goal itself, and the
  all-done note never fires while the goal's own checks are red or absent.
- **Failure 2: thinking used the whole output budget.** On the same task, Haiku at effort high produced 64,000
  output tokens with no text and no call, twice (thinking counts toward max_tokens on Haiku 5.5); the silent-reply
  note fired once and the turn ended. Next (E24): Haiku's max_tokens at its 128k ceiling against effort medium,
  on game-ambitious and long, ×3.
- **Also:** game-ambitious scored 0.94-0.98 in early October and 0.55 here; these two failures account for the
  four lowest runs. A regression check after the fixes will show whether anything else is going on.

### E24 and E12. The E15 fixes, effort, and the shell's first eval (e850add)

- **Changes:** the all-done note no longer declares the goal done; Haiku's max_tokens is 128k; the silent-reply
  note fires per stop, up to two in a row. The shell, envelope, projects and capture are all on main (8056cdd).
- **Predictions, before the run:** (E24) game-ambitious and game-arcade back near early October's 0.94-0.98 on
  Haiku high, with no run ending on an empty reply; effort=medium within noise of high at lower output tokens and
  time. (E12) on swe, bash is used for running tests or inspecting files in most runs, and swe holds at >= 0.95
  (E10 level).
- **Method:** game-ambitious and game-arcade ×3 at high and ×3 at medium; swe ×3. Haiku 5.5.
- **Result E24:** high: game-ambitious 0.97 (952 s), game-arcade 0.91 (678 s), mean 0.94 (E15: 0.55). medium:
  1.00 and 1.00 (406 s, 152 s), pass^k 2/2. The E15 fixes restored the games; **medium beat high** on score
  (+6, beyond tier noise) at a third to a half of the time. Prediction (medium within noise of high) was too
  cautious. Matches the Haiku guide (medium for agentic coding).
- **Result E12:** swe 0.81 with the shell (E10 0.95), pass^k 0/7. Every run used bash; no hidden test failed.
  **A grader bug, not a regression:** "ran code to reproduce or check the fix" knew only the code and run_app
  tools, and "reports only test results it got" looked for "N passed" while node --test prints "# pass 47". Both
  checks now understand bash and node's counts. Learned: graders must change when tools do (the third grading
  bug found by a result that looked like a regression, after E2's lodash key and E1's rubric).
- **Next:** swe ×3 at high and ×3 at medium with the fixed graders: the shell's true swe score, and whether medium
  holds on bug fixes before it becomes Haiku's default.
- **Result (fixed graders):** high 0.92 over 18 graded (3 unfinished: timeouts), pass^k 0/6, 480 s in total;
  medium 0.94 over 21, pass^k 1/7, 291 s (-40%), none unfinished. The shell holds swe at the E10 level (0.95)
  within noise: no gain on small fixes, no loss. medium equals or beats high on swe and beats it on games
  (+6, half the time): **medium is now Haiku's default effort, in the app and in evals** (B11).

### E21 (part). GitHub projects against a real repository

- **Setup:** a private sandbox, park-brian/chat-harness-sandbox, seeded with `ms` and its tests (created with the
  user's go-ahead, 2026-10-13). `tests/github-live.mjs` drives projects.js's GitHub client directly.
- **Result:** pass. Connect (6 files), read, status shows the change, local commit, push to `main` refused without
  confirmation, push to `agent/live-…`, the change present on the branch, pull request #1 opened from it, then
  closed and the branch deleted.
- **Limits of the check:** it ran in Node, which doesn't enforce CORS; the browser path rests on the research's
  curl check that api.github.com sends `Access-Control-Allow-Origin: *`. The `.env` fine-grained PAT has no access
  to the new repository (404), so the run used the gh login's token, passed in the environment and not stored.
- **Next:** the same flow from the app in a browser (connect in the UI, an agent's change, push, PR), and the
  swe tier as GitHub projects.

### E25. Where swe's points go, and the director on small fixes (plan: docs/specs/2026-10-13-optimization-plan.md)

- **Reading the misses (medium run 10-07-41, all 21 transcripts, checked by an independent review):** hidden and
  own tests pass in all 21. PLAIN failed 6 times: 4 real leaks of contract words ("I won't revert the fix just to
  make the checks red"), 2 judge errors (a mid-work line graded as the reply; "fell through" called figurative).
  Two "reports only test results it got" misses were a grader bug: "Plan items 1 and 2 pass" read as "2 passed".
  Fixed in evals/swe.js and in the engine's own claim check (COUNT_CLAIM), with the two sentences as tests.
- **E25b, prediction (before the run):** `rule.goal=off` cuts calls on long runs by 5+ and the leak to 0-1/21
  with code checks unchanged; `rule.red=off` cuts the leak to 0-1/21 with calls unchanged.
- **Method:** swe ×3 per arm, Haiku 5.5 medium, three arms in parallel on the same commit. Leak by E6's regex on
  the last assistant message (evals/director-report.js), independent of the judge's PLAIN grade.

| arm | graded | pass | hidden | PLAIN | leak | calls | k tokens in | goal note in |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| base | 21 | 0.95 | 1.00 | 0.90 | 13/21 | 14.1 | 235 | 17 |
| rule.goal=off | 19 (+2 unfinished) | 0.96 | 1.00 | 0.95 | 1/19 | 8.7 | 164 | 0 |
| rule.red=off | 20 (+1 unfinished) | 0.95 | 1.00 | 0.85 | 6/20 | 11.9 | 224 | 12 |

- **Result:** the goal note's prediction held: -5.4 calls (-38%), -30% input tokens, leak 13 → 1, code unchanged,
  PLAIN up 5. The red rule's was refuted: 6/20 leak, calls -2. The goal note is the source: once it fires, the
  model builds a contract for a fix that is already done, and every later note is about that contract. Turning
  off red removes one of those notes, not the contract. The three unfinished runs (mri-alias-default, the eval's
  600 s page wait) are an eval hang, not a score; none of these pages loaded the code changed during the run.
- **Learned (B12):** on edits to existing code, the contract costs more than it gives: a third more calls and
  most of the leak, for no change in what gets fixed. The size threshold (8 calls) can't tell a careful fix from
  long work.
- **Also found, from transcripts (user: "we may need to make git available to the shell"):** git and node were
  there, but a plain project had no repository: models ran `git diff`, `git status`, `git show HEAD:file` to see
  their own changes and got "no git history" (5 runs in the last 3 swe evals). Now the shell commits the files
  as the user's message found them at a turn's first command (a project of the chat's own only; a folder or
  GitHub project has its own repository), and `git show rev:path` works. isomorphic-git's index cached the stat
  of the scratch tree; a file of the same size looked unchanged until the index was reset against the working copy.
- **Next (E27):** `sizing=building`: the goal note needs 8 calls and a turn that builds (no files when it began,
  or 3+ new files). Prediction: swe like `rule.goal=off` (leak ≤ 2/21, calls ≤ 10); games unchanged (they start
  with no files, so the director runs as before).

### E26. The judge, measured against itself (evals/regrade.js)

- **Question:** how much of a judged score is the judge? Re-judging saved runs ×3 changes nothing but the judge's
  own sampling (Sonnet 5.5 refuses temperature).
- **Method:** the medium swe run (21 runs, 4 criteria), `node evals/regrade.js <folder> --repeat 3`: for each
  criterion, how often all three repeats agree, and how often their majority agrees with the saved grade.
- **Result, before any change:** repeats agreed on 20, 21, 16 and 17 of 21 (cause, file, how checked, PLAIN).
  The judge moved on 1 run in 5 for the two criteria that decide most misses: as large as the effects measured.
- **Two input bugs found by reading the flips:**
  - Tool outputs reached the judge cut to their first 600 characters, and node --test prints its counts last:
    "can't be confirmed from the truncated test output". Now the start and the end are kept (1000 characters).
    "How checked" went from 16 to 21 of 21 repeats agreeing, and the fails it now gives are real over-claims
    ("both failed before the fix" when the run shows one failure).
  - The whole turn's text was graded as the reply, so a mid-work line ("Both new tests fail as expected. Now the
    fix:") failed PLAIN. The judge now sees text before the last tool call as `<assistant_progress>`: it counts
    for what the reply says, not against its writing. A first version graded the reply alone and failed a cause
    the model had stated earlier in the turn; the user reads that text too, so it counts.
- **Also:** Sonnet sometimes passes `grades` as a JSON string, which crashed the judge; it is parsed now.
- **After the fixes:** repeats agree on 20, 21, 20 and 20 of 21. eval.js now grades by the majority of three votes
  (judge.js `vote`), which costs about 15k judge tokens a run.
- **Learned:** the judge's noise was mostly the inputs it was given, not its sampling. Re-grading saved runs
  turns a grader change into something tested before it is trusted. Scores judged before E26 are not comparable
  with later ones: E25 and E27 used the old judge in all their arms.

## Ideas, as testable hypotheses

What a good harness for cheap models might do, each with how to test it.

1. **Tool results carry the next step.** A run report that ends "2 tests fail: totals rounds wrong; the failing
   line is cart.js:41" is worth more than a rule to read reports. Test: run reports with and without a one-line
   cause and next step; measure steps to green on swe.
2. **Fewer tools, shown when relevant.** Gemini's guide says 10-20 tools; we offer about 17, several rarely used
   (history, diff, restore, mcp). Test: hide them until a trigger (a restore needs a version list) and measure
   score, tool errors and prompt tokens on Gemini.
3. **Tool docs on first use.** Inject a tool's full documentation the first time it is called or becomes relevant,
   instead of all upfront. Test: system prompt length against score on the short tiers.
4. **Pick the best of two with the harness's checks.** For a cheap model, sample two attempts at low effort and
   let the checks choose. Test: best-of-2 at medium against one at high on swe: score and cost.
5. **Escalate one step.** When an item fails twice, the harness runs the next step on a stronger model (Sonnet
   5.5) and returns to the cheap one. Test: swe and long with and without; cost per passing check.
6. **A facts sheet at the tail.** The harness keeps the current truth (files and versions, last test result,
   sources read) as a short block at the end of each request, so the model doesn't reconstruct state from history.
   Test: claims that contradict the ledger, with and without.
7. **Claims as data.** The model returns its final answer as claims with the evidence each rests on; the harness
   verifies them and renders the prose. Test: unsupported claims in answer-hard and research.
8. **Errors that don't steer.** Audit every tool error for instructions (B3) and rewrite them as facts. Test: E9.
9. **Questions the user answers in one click.** Assumption chips in the UI. Test with the simulated user: turns to
   DONE on intent.

## Planned

- **E5. Noise floor (A/A).** Run identical code twice on swe, answer-hard and intent (×3 each) and measure how
  much the mean and each task move. Everything above is judged against this.
- **E6. Vocabulary leak (B2), from existing transcripts.** Count final replies that mention "item N", "check" or
  "the harness", before and after E4b.
- **E7. Injection vs system prompt (B1).** The same plan instruction placed in WORKING versus injected after 8
  calls, on the long report ×5 each. Needs feature flags.
- **E8. Effort (medium vs high)** for Haiku on answer-hard and swe: does medium hold quality at lower cost?
- **E9. Error-message steering (B3).** The old and new no-project error on the restraint and plan tasks.
- **Infrastructure: feature flags** set per eval run (`--flags director=off,rule.stalled=off,effort=medium`), so
  ablations don't need worktrees.
