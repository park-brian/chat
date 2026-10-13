# Answer quality: plan

Goal (user, 2026-10-12): improve how the chat answers what people actually ask, measured with evals, iterating on
Haiku 5.5 by default. chat-games (D:\Projects\chat-games) is the earlier copy where the refinement loop started; its
notes are already merged into evals/NOTES.md. Its method carries over: a failure seen in transcripts, a
hypothesis, one change, before/after on the same tasks, and a holdout to catch overfitting.

## Where the evals stand

- 22 tasks. 20 are builds (apps, games, a port, a feature) graded by probing the result: does the spreadsheet
  compute, does the game replay, do the tests pass. The game and build tracks reached 0.92-0.98.
- Two tasks are about answering: `inline-answer` (one question, graded by length, no tools, one keyword) and a few
  research tasks (`research`, `web-read`, `codebase-questions`, `audit-libs`), graded by keywords and tool use.
- Every run already records turns, tool calls, tokens, cache hits, cost in token equivalents, failed calls and
  seconds, plus a transcript.
- Missing: everyday requests, and any judgment of an answer beyond keywords: is it right, is it what was asked,
  is it the right length and shape, does it say what it doesn't know.

## What "answers well" means here

Five properties, each checked per task:

1. **Right**: the facts and the code are correct (reference answer or an executable check).
2. **Fits the ask**: answers the question asked, at the length and in the form asked for (a short answer is
   short; a request for code gets code; a question doesn't get an app).
3. **Grounded**: facts that change (versions, prices, news) come from tools, and say where from; nothing is
   recited from memory as if looked up.
4. **Honest about limits**: an unanswerable or ambiguous request gets a plain "I don't know" or one question, not
   a guess.
5. **Economical**: few turns, tool calls, tokens and seconds for what was asked.

## The answer set

A new `answer` set of 16-20 tasks, mostly one turn, a few two or three turns, covering what people ask a chat:

- Explain (a concept, the difference between two things, "why does X happen").
- How-to with a snippet (a regex, a SQL query, a shell one-liner): the snippet is executed against fixtures.
- Debug: a pasted error and code; the fix is checked by running it.
- Write and rewrite: shorten a paragraph, change its tone, a commit message from a diff; graded by rubric and length.
- Look up something current (a package's latest version, a page's content): must use tools and name the source.
- Compute or estimate: arithmetic and unit conversions with exact answers; a Fermi estimate within a range.
- Compare and recommend: two libraries for a stated need; must give one recommendation and the reason.
- Follow-ups: "shorter", "now in Python", "you're wrong about X" (when it was right: holds its ground; when it was
  wrong: corrects).
- Ambiguity: a request with two readings; one short clarifying question, or a stated assumption plus an answer.
- Unanswerable: a question about something private or nonexistent; says it doesn't know.
- Restraint: "what's a good name for a cat?" or "fix the typo" must not produce an artifact or a tool call.

Half go in `answer-holdout`, never tuned on.

## Grading

- **Scripted checks first**: exact values, executed snippets, tool use, length bounds, no artifact. They are cheap
  and stable.
- **A judge for what scripts can't see**: a fixed, stronger model (Sonnet 5.5) reads the request, the answer and a
  per-task rubric of yes/no criteria ("names backpressure as the difference", "gives one recommendation", "under
  120 words", "does not claim to have run the code"). Binary criteria, not a 1-10 score, with the judge's reason
  kept in the transcript. The judge sees no model name.
- **Judge calibration**: hand-grade 30 answers once and check the judge agrees on at least 90% of criteria;
  re-check whenever the judge prompt or model changes.
- Score per task = criteria passed / total; the round's score is the mean, reported with its spread over repeats.

## The loop

1. **Baseline**: Haiku 5.5, the answer set × 3 repeats (run-to-run variance is large on one sample), plus the
   existing inner set × 1 for regressions. Record cost and time.
2. **Read transcripts**, not just scores. Sort failures into kinds: wrong, over-built, under-grounded, too long,
   guessed, slow.
3. **One change per round** where the failures point: the system prompt (`prompts.js`), a tool's description, a
   harness reminder, or the default reasoning level. Each change gets a NOTES.md entry with the failure, the
   hypothesis, the change and before/after.
4. **Accept** only if the answer set improves beyond the baseline's spread, the holdout doesn't drop, and the inner
   set doesn't regress.
5. **Confirm on other models** (Sonnet, Opus, Luna, Gemini) once a change has held on Haiku for two rounds.

First levers to test, from what the prompt does today:

- The persona says "terse and direct": check it doesn't cut answers short where depth was asked for.
- Every eval turn runs reasoning `high`: measure `off`/`low` on the answer set (Haiku answers most questions
  without it, at a fraction of the time and cost).
- Tool use on plain questions: `inline-answer` already checks it; widen to the restraint tasks.
- The prompt is about 6k tokens of build guidance on every turn; measure whether a short question pays for it in
  latency and in answers that drift toward building.

## Cost guard

A Haiku round of the answer set (×3) plus the inner set is about 70 jobs: `--yes` is required above 20. Judge calls
are counted in the run's cost. Rounds on the other models only after a Haiku win.

## Work items

1. eval.js: an `answer` and `answer-holdout` set; a `judge(run, rubric)` helper calling Sonnet 5.5 with the
   rubric, returning criteria results that merge into the check list; judge cost in metrics; `--reasoning` to
   override the level.
2. evals/tasks.js: the answer tasks with scripted checks, rubrics and references; snippet fixtures.
3. A calibration file: 30 hand-graded answers and a script that reports judge agreement.
4. Baseline round, then the loop, logged in evals/NOTES.md.

## Prompt design (user, 2026-10-12)

How agents work, and what the prompt should therefore give them:

- **Verifiable environments.** An agent improves when it can check its work: tests, run reports, executed
  snippets, fetched sources. Builds already have this (run reports, screenshots, in-file tests). Answers mostly
  don't. The prompt should make checking the default for answers too: compute with the code tool instead of in
  the head, run a snippet before giving it, fetch a fact that may have changed, and say which of these were done.
- **A plan file for long work.** Long tasks drift once early context is summarized away. Today only apps get a
  plan file (SPEC.md). Any task past a few steps (research, a multi-file change, a migration, a long analysis)
  should keep PLAN.md: the goal in the user's words, the steps with the check for each, what is done, what was
  learned, open questions. Read it after a summary; update it in the same turn as the work.
- **Explore, think, break down.** Before acting on anything non-trivial: find out what exists (read, search,
  run), list what is unknown, split the work into steps small enough that each has a check, and do the riskiest
  unknown first. Thinking goes into the think tool or the plan file, not into the answer.
- **Ambiguity, while moving forward.** Ask only what only the user can answer (intent, taste, private facts),
  and at most one question at a time. Everything else: pick the most likely reading, say the assumption in one
  line, and proceed, so the user can correct course without waiting for a round trip. When work can start on the
  part that doesn't depend on the answer, start it.
- **Writing: plain and direct, not mannered.** Mannered prose substitutes metaphor and flourish for direct
  statement ("a dial worth turning" for "a parameter worth varying", "earns its keep" for "still matters"). It
  displays the writer, makes the reader work harder, and is imprecise, since a metaphor carries connotations the
  writer didn't choose. Say what you mean; when a literal phrase exists, use it. Breadth and creativity belong in
  the ideas (more options considered, unexpected angles, concrete examples), not in the phrasing. Gemini 3.8
  Flash's default register is the reference for plain; Claude models drift toward mannered.

### The prompt follows its own rule

prompts.js is written in the style it should forbid: "surgical economy", "trust your reader to complete the
circuit", "the right word sounds inevitable; its cousin sounds written", "your context forgets; the file doesn't".
Models imitate the prompt's register more reliably than they follow its instructions. The rewrite states each
rule literally, and gives a short before/after pair for the writing rule rather than an aphorism.

### Measuring it

- **Mannered-prose check**: a judge criterion on every answer task ("states things literally; no metaphor or
  flourish where a literal phrase exists"), plus a scripted count of known flourish patterns (earns its keep,
  dial, lever, north star, load-bearing, the heavy lifting, at the end of the day, it's worth noting, delve,
  tapestry, landscape, unlock, a quiet/subtle X) per 1000 words, reported per model.
- **Style baseline**: the answer set on Haiku 5.5 and Gemini 3.8 Flash, side by side, judged blind on plainness
  and on correctness, so the target register is measured rather than assumed.
- **Process checks** (from the transcript, not the answer): a plan file exists for tasks past N steps and is
  updated; a computed or version-dependent claim came from a tool call; an ambiguous task got either one question
  or a stated assumption plus progress, never only a question and never a silent guess.
- **Long-horizon task**: one multi-turn task (8-12 turns) whose later turns depend on decisions made early, with a
  forced summary midway, to test that the plan file carries the work.

### Order

1. Build the answer set, the judge and the style metrics (work items 1-3).
2. Baseline: Haiku 5.5 ×3 on the answer set; Gemini 3.8 Flash ×1 for the style reference; inner set ×1.
3. Round 1: rewrite DEFAULT_PROMPT and WORKING literally (writing rule with before/after, verify-by-default,
   PLAN.md for long tasks, explore/break down, ambiguity with forward progress). Measure on Haiku.
4. Further rounds from the transcripts.

## Research and verification (user, 2026-10-12)

The user wants the agent to research online to verify claims, including fetching and reading sites with the code
tool, and pointed at chat-games for a specialized tool list. Finding: chat-games has the same tools and older drafts
of the same prompt sections; chat already contains everything it has. The research path itself is the gap.

How research works today:
- `read_url` is always offered; `web_search` (Brave, with `extra_snippets`) only when a Brave key is set. Evals pass
  `BRAVE_SEARCH_API_KEY` from `.env` and run the local proxy, so in evals both work.
- Both, and `fetch()` inside the code tool, need the local CORS proxy. On the published site (no proxy, often no
  key) most fetches fail with "Failed to fetch", while ENVIRONMENT still says "fetch() works (proxied for CORS)".
- The prompt has no verification workflow and no citation rule; research appears only as "read before you guess"
  for libraries. The code tool has no helper to fetch and read a page, and its default timeout is 5 s.

Round 2 (after the writing/working round), measured on the lookup and verify tasks plus new ones below:
1. A "Verifying" part of WORKING: decide which claims matter and can be checked; search, then read the primary
   source; use code `fetch` for structured data and computation; cite each checked claim with its URL and, where it
   decides the answer, a short quote; mark the rest as unverified. Answer from memory only for stable, well-known
   facts; check anything recent, numeric, contested, or asked to be verified.
2. Tool descriptions say when to use them: web_search before stating facts that may be wrong or out of date
   (numbers, dates, versions, quotes, attributions); read_url to check a claim against its source.
3. Network wording depends on what exists: with no proxy, say that only CORS-open hosts are reachable and name them
   (jsDelivr, raw.githubusercontent.com, api.github.com, Wikipedia's API with `origin=*`, arXiv's export API), and
   make a CORS failure's error name the cause and the fix (`npm run start:proxy`).
4. Inside the code tool, `web.read(url)` returns what read_url returns, and `web.search(q)` when a key exists, so
   code can fetch, read and compute in one call; the code timeout for network work goes to 30 s.
5. New answer tasks: verify a claim with a planted wrong premise (must fetch and correct it), a two-source
   question (must cite both), and a numeric fact that changed recently (must not answer from memory). Checks: the
   cited URLs appear in tool output, and the quoted text appears in what was read.

## Benchmarks that grade themselves (user, 2026-10-12)

The first answer set scored 0.97 on Haiku 5.5: short, well-posed questions don't separate a good harness from a
weak one. The user's direction: clone benchmarks like DeepSWE (SWE-bench-style: a real repository, an issue,
hidden tests), and use the code tool fully. Tasks whose grading is mechanical are also the environments agents
work best in, so they test the harness the way it will be used.

Three new tiers:

1. **`swe`: issues against real small repositories.** Each task is a pinned snapshot of a small JavaScript library
   (from jsDelivr or GitHub at a fixed version: candidates such as ms, mitt, dlv, kleur, nanoid, tiny-invariant,
   p-limit, dequal, klona), seeded into the workspace with its own tests. The prompt is an issue in a user's words
   (a bug report with a reproduction, or a small feature request). The bug is either a real historical one (the
   commit before its fix, with the fix's tests hidden) or introduced on purpose. Grading writes the model's files
   to a temporary folder and runs the hidden tests and the library's existing tests with `node --test`: the fix
   passes the hidden tests, nothing else breaks, and the diff stays small (lines changed outside the relevant
   files are counted). The judge reads only the final message (says what was wrong and what changed).
2. **`research`: questions with exact, stable answers that need fetching and computing.** Each answer is pinned
   to a fixed artifact so it never goes stale, but can't be recited from memory: a count, a hash, a size, a line,
   a date taken from a specific version of a package, a specific commit, an arXiv paper version, or a fixed CSV.
   Examples: "how many functions does lodash 4.17.21's lodash.js export", "the SHA-256 of the README.md in
   solid-js 1.9.0", "in this CSV (a pinned URL), which month had the highest total", "which line of
   dist/solid.js in 1.9.0 defines createMemo". Checks: the exact answer, a lookup happened, and the value is
   present in tool output. This is GAIA's shape with a deterministic key.
3. **`answer-hard`: prose and verification that the first set didn't reach.** A planted false premise to check
   against a source and correct with a quote that appears in what was read; a two-source question with both
   cited; a number that changes (weekly downloads) within 5% of what the tool returned; a 300-word explainer for
   non-engineers; a decision record from given facts with no invented ones; a broad request ("move our REST API to
   GraphQL") that should state assumptions and give a usable first plan rather than only questions; and a long
   research report saved to a file, with a plan file written before it.

Grading for all three runs offline in Node after the run; only the model's own work needs the network.
The prompt round is then measured on these tiers as well as the first answer set.
