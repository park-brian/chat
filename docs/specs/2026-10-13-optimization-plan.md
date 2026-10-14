# Optimizing the harness: a measured plan

The user's direction (2026-10-13): think carefully about how to optimize the harness; plan it in docs, review the
plan, then carry it out. Later the same day: "we may benefit from an oracle which uses a powerful model like opus
5.5 to assist with planning, then use haiku to execute."

Every step is an experiment with a prediction written before it runs, judged against the noise floor (E5: tier
means move up to 2 points, single tasks up to 12; long has no measured floor yet), and logged in
docs/experiments/LOG.md. Changes ship behind a flag first, so an arm is one `--flags` value.

## Where the points and the cost are (medium swe run 2026-10-13T10-07-41, 21 runs, read in full)

- **Code is not the problem.** Hidden tests and the libraries' own tests passed in all 21 runs.
- **Misses:** PLAIN failed 6 times; "says the cause" twice (real: dset-2, regexparam-2 give no cause); "how it was
  checked" twice (mri-2 a real over-claim, "all three failed" when one passed; dequal-3 a judge carry-over); two
  "reports only test results it got" (grader bugs, below).
- **The leak has a specific cause.** The 4 real leaks (dequal-2, dequal-3, mitt-1, mitt-3) are all in runs where
  the `goal` note fired at 8 calls (engine.js `GOAL_NOTE`, `PLAN_AFTER`) after the fix was already verified; the
  model then made plan items, each item's check already passed, the `red` rule (`DIRECTOR_RULES`, `redFirst`)
  asked for checks that fail now, and the model refused to undo its fix and told the user so ("I won't revert the
  fix just to make the checks red"). 14 of 21 runs got the goal note; they made 11-21 calls (mean about 271k input
  tokens) against 5-7 calls (about 128k) without it. Self-selected groups (long runs are the ones that pass 8
  calls), so this needs arms, not a comparison.
- **Grader bugs:** evals/swe.js's claim pattern reads "Plan items 1 and 2 pass now" as "2 passed" (mitt-1, mitt-3;
  the real "21 pass" claims match `# pass 21`). engine.js `COUNT_CLAIM` has the same gap for "items 1 and 2". Both
  swe.js and the judge read every text block since the user's message, so mid-work narration is graded as the
  reply (mitt-2's PLAIN fail was on "Both new tests fail as expected. Now the fix:").
- **Cost:** 5-21 calls, 106-494k input tokens per fix, 83-95% cached. Cached input costs 0.1×, so call count
  matters far more than the prefix.
- **Long tier:** Lisp at this spec is at Haiku's ceiling (all 167 hidden programs pass); its runs were lost to
  a frozen tab and to revising after green. The novella's failures were abandoned sub-agents, revising until time
  ran out, and 23M tokens. These are stopping and orchestration failures, more than planning ones.

## Phase A. Cheap and decisive (now)

1. **Grader fixes (E25a).** swe.js's claim pattern and `COUNT_CLAIM` skip item and step lists ("items 1 and 3
   pass"); swe.js reads the final reply (text after the last tool call) for claim checks. Tests in
   evals/swe.test.js and the engine tests with the two sentences from mitt-1 and mitt-3.
2. **Director ablation on small fixes (E25b, was E13).** swe ×3 with `rule.goal=off` and with `rule.red=off`
   against a fresh baseline ×3 (same code). Measure: leak by E6's regex on the final reply and by the PLAIN grade
   (two independent measures), calls, input tokens, time, code checks.
   Prediction: `rule.goal=off` cuts calls on the long runs by 5+ and the leak to 0-1/21 with no loss in code
   checks; `rule.red=off` cuts the leak to 0-1/21 with calls unchanged. If both hold, the director's sizing
   trigger is wrong for small fixes, not the red rule.
3. **Prefix measured (E25c).** Tokens of the system prompt and each tool's docs from saved request.json files.
   No change, just the number, for Phase F.

## Phase B. The judge (E26)

1. **The final message is graded as the final message.** The judge prompt shows text before the last tool call
   as `<progress>` and the rest as the reply. The flourish counter still counts everything the user sees.
2. **calibrate.js fixes:** pass tool outcomes (so "claims no check the tool calls don't show" can be judged);
   report, per criterion, how often the judge passes replies hand-graded good and how often it fails replies
   hand-graded bad, not one agreement number.
3. **Labels without bias.** Hand labels are made blind to the judge's reasons, in a fresh context (a sub-agent
   given only the reply, the tool calls and the criteria). Tune on this run's 21 replies; measure on held-out
   replies from E10 and E24 runs. A file of 15 items is left for the user to label, to measure the labeller.
4. **Judge noise.** Re-judge 10 saved runs ×3 each before reading any move in a judged score.
5. **Re-grading saved runs.** Pull eval.js's run building into one exported function so a saved run can be
   re-graded (scripted checks and judge) by `evals/regrade.js`; grader changes are tried on saved runs first.
6. PLAIN applies to every tier's rubric, so a change to it is checked on answer, research and answer-hard too.

## Phase C. The fix the ablation points to (E27)

Depends on E25b. Candidates: the sizing trigger counts calls only before the first passing test run on a
reported bug; or `red` stays quiet when a failing run of the same check or test file is already in the
conversation before the edit (the model's own objection, "the red state was already observed"). Measured on swe
×3 and game-ambitious ×3 (to show the director still helps where it did).

## Phase D. The oracle: a strong model plans, Haiku executes (E28)

The premise to test: some long-run failures come from planning and stopping decisions a stronger model makes
better. The evidence above says stopping more than planning, so the `done` moment matters as much as `plan`.

1. **Baselines first.** Long tier (Lisp, novella, research trap) at medium ×3, twice (an A/A), to get its noise
   floor. Count how often `same` and `stalled` fire there.
2. **Seeded plan, no harness change.** Opus 5.5 writes a plan once per long task (goal in the user's terms, its
   checks, order of work, traps, when to stop). Haiku ×3 with that plan as PLAN.md in the task's starting files,
   against the plain task. If this doesn't move the score beyond the A/A floor, a plan oracle won't either.
3. **Harness-called oracle**, flag `oracle` with arms `off`, `plan`, `done` (separately, not nested), oracle
   model by `oracle.model`. Called by the harness, not chosen by the model (B10; `task` already takes a model and
   Haiku rarely uses it). A fresh Opus request at medium effort, reading files only; its text enters as a harness
   note in `additional_instructions`.
   - `plan`: at the first sizing of large work (a new project or long request, not at call 8 of a bug fix).
   - `done`: before the all-done note and when the model stops with work open, the oracle compares the work with
     the user's request and says what's missing or that it is finished, and stop.
   - `stuck` only if the baselines show `same`/`stalled` fire often enough to matter.
   Metrics: score, oracle tokens apart, dollars per passing check at list prices, time. The judge is Sonnet;
   when Sonnet is the oracle, note the self-preference risk; default oracle Opus 5.5.

## Phase E. Long tasks keep their state (E29)

Needs goal checks in the contract (E20's data model; the contract today has goal, done, assumptions, items,
notes, questions, no goal checks): build that first. Then a facts sheet in the newest turn's metadata (files and
versions, last test result, goal checks' states, sources read), and a count of facts lost across summaries in
long runs that compact. With no goal checks, the done note behaves as today.

## Phase F. Fewer calls (E30)

The harness runs a project's tests when it opens and puts the result in the first message's metadata (watch the
"ran code to reproduce" check: pre-run results are not the model's). Then, using E25c's numbers, tool docs on
first use and the six primitives (E19), on Haiku and Gemini.

### E30, measured (E25c, 2026-10-14)

The fixed prefix of a swe request is about 12.7k tokens: system prompt 31.2k characters (about 7.8k tokens), tool
specs 19.5k (about 4.9k). Largest system sections: Artifacts 5.3k characters plus the HTML skeleton 4.2k (a
counter app with in-file tests, sent on every request, bug fixes included), Working 5.1k, plan 2.6k, Environment
2.5k, task 2.2k, code 1.8k. The plan, task and code docs are in both the system prompt and the tool specs. Arms
(flag `prefix`): `full` (today), `lean` (each tool's docs once, in its spec; the skeleton only when no project is
open). Prediction: about 3k fewer tokens per request with swe, games and answer unchanged; games are where the
skeleton could matter, so they are in the run.

## Gates and presets

- A `quick` preset (inner, answer, swe, research ×1) catches crashes and large breaks only; it is not a
  regression test. Regressions are judged ×3 against the noise floor.
- Phase A runs first. Phase B before reading any judged score as a result. Phase D's baselines don't wait for
  Phase B (long is graded mostly by scripts). Commit after each phase with its log entry.

## Review (2026-10-13)

An independent review of the first draft read all 21 transcripts and the code. It found: the leak's cause is the
goal note at 8 calls plus the red rule, not the status line's wording; the two claim misses are grader bugs;
several counts and a function name were wrong; calibration by the fix's author on the same data is biased, and
agreement is the wrong number at a 29% fail rate; the oracle's ceiling gate (Opus alone ×2) can't separate
planning from execution and a seeded plan is the cheaper, direct test; nested oracle arms can't separate `done`
from `plan`. This version takes all of those.
