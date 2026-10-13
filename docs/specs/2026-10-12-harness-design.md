# Harness design: hypotheses checked against reality

The user's framing (2026-10-12): a good harness lets the model form better and better hypotheses about what the
user wants, and lets it check those hypotheses against reality, reliably. This document turns that into concrete
harness and eval changes, using current published practice (sources at the end) and what our own evals showed.

## The loop

1. **Hypothesize.** From the request and what is already known, the agent states what it thinks the user wants,
   what it is assuming, and what would show it wrong.
2. **Expose.** The hypothesis is visible: to the user (so they can correct it cheaply) and to the agent's future
   self (so it survives a summary).
3. **Test.** Each hypothesis is checked against the cheapest reliable source: the user for intent and taste; a
   test, a run, or a screenshot for behavior; a fetched primary source for facts.
4. **Keep what held.** Results that were checked are recorded with their evidence; what failed changes the
   hypothesis; what was not checked is marked as such.

"Reliably" is the part harnesses usually miss. A model that says it ran the tests is not a check. Reliability
comes from the harness doing or witnessing the check: test counts come from run reports, quotes are matched
against fetched text, file contents come from the workspace, not from the model's memory of them.

## What our evals already show

- Short, clear questions are answered well (0.97-0.98). The failures are in longer work: no plan file, claims the
  tool calls don't show, assumptions not stated, numbers computed in the head (fixed by round 1).
- Context grows without bound. One research report reached 280k tokens of context over 16 steps and processed
  4.47M input tokens, carrying 23 whole web pages, because old results are stubbed only in batches of 10 and the
  1M window means compaction never starts.
- The judge was blind to tool results until we fixed it, and the model's claims about verification were then the
  most common failure on swe ("17 passed" with no report saying so).

## Harness changes

### Context (user requirement: 256k default, 100k for Haiku)

- **A context budget separate from the model's window.** `context` defaults to 256k, Haiku 5.5 gets 100k, and a
  smaller window wins. Compaction starts at 60% of the budget.
- **Clear tool results once they're used, not in batches of 10.** Anthropic's guidance is to start compaction by
  clearing tool results. Keep each result whole for the step that reads it, then replace bulky ones with a
  one-line stub ("read_url https://… 38k chars, read at step 4; read again if needed"). The batch-of-10 schedule
  exists to keep the cache prefix stable; clearing at fixed boundaries (every N steps, all results older than the
  last N) keeps that property while bounding growth.
- **Read long sources in code.** With `web.read()` inside the code tool (round 2), the agent can fetch a page,
  search it and print only the lines it needs. The prompt should say to read long pages this way, and `read_url`
  should offer an outline and a `find` option (headings first, then the matching sections), the same progressive
  disclosure as skills.
- **Notes outlive results.** What a result established goes into PLAN.md (or the answer) before the result is
  cleared. The plan file is the agent's memory across compaction, as in Anthropic's and OpenAI's long-running
  harnesses (progress file, plans file with milestones, status log).
- **Show the agent its own budget.** A line in each request: "Context: 64k of 100k; 12 results cleared". Agents
  plan better when they can see the constraint.

### Intent hypotheses

- **An "Understanding" block at the top of PLAN.md**: the goal in the user's words, the assumptions, and what
  would change the plan. For short tasks, one line in the reply ("Assuming metric tons; say if you meant US tons").
- **Assumptions the user can answer in one click.** When the agent states an assumption, the UI shows it as a chip
  under the reply ("Assumed: PostgreSQL. Change?"). A click sends the correction as the next message. This makes
  correcting a hypothesis cheaper than the agent asking, so the agent can proceed instead of stopping
  ("ask first" wording makes models stop too early; OpenAI's GPT-6 notes and our graphql results agree).
- **Ask when only the user knows**, at most one question at a time, and keep working on the parts that don't
  depend on the answer.

### Verification the harness can vouch for

- **Claims with evidence links.** When an answer cites a source, the harness checks that the quoted text appears in
  what was fetched, and the UI links the claim to the tool result. An unmatched quote is flagged before the user
  sees it (a check pass on the final message, not a model judgment).
- **Test results only from reports.** Already in the prompt; the harness can enforce it by checking any "N passed"
  in a final message against the last report and adding a note when they differ.
- **A done condition before building.** For builds, the agent writes the checks that will define done (tests, a
  screenshot criterion) before the code: Anthropic's "sprint contract", our SPEC.md steps with checks.

### Tools

- Few tools, high-signal output, actionable errors (round 2 made CORS failures name the cause and the fix).
- `response_format` style options where output is large: read_url outline/find, web_search count, code logs capped
  with a pointer to the full log.
- Remove scaffolding that newer models don't need, one piece at a time, measured.

## Eval changes: better, not only harder

1. **Error analysis first.** Read ~100 transcripts across tiers, write open notes, group them into failure types,
   and only then write checks. Every failure type gets one binary check or one judge criterion.
2. **pass^k next to the mean.** Report the share of tasks that pass on all 3 repeats. Reliability is what users
   feel; a 0.9 mean can hide a task that fails one run in three.
3. **A simulated user for multi-turn intent.** τ-bench style: a second model plays the user with a hidden goal and
   a persona, answers questions only from that goal, and corrects wrong assumptions the way a real user would.
   Measures: turns until the agent's stated understanding matches the hidden goal, questions asked that the
   hidden goal could answer vs. ones it couldn't, and whether the final artifact meets the hidden spec. This tests
   the hypothesis loop directly.
4. **Underspecified tasks with a hidden spec.** The prompt says "make me a habit tracker"; the hidden spec says
   weekly goals and a dark theme. Pass requires either asking or stating assumptions that the simulated user then
   corrects, and the artifact meeting the corrected spec.
5. **Pairwise judging for quality at the ceiling.** Where absolute rubrics saturate (the first answer set), show the
   judge the baseline and the candidate answers side by side, in both orders, and count wins.
6. **Negative and adversarial controls.** Tasks that should not trigger a tool or an artifact (we have restraint
   tasks); oracle, no-op and cheating runs for each self-graded task, so a grader that passes a no-op is caught.
   Check that a swe fix wasn't simply downloaded from the published package.
7. **Noise as a variable.** Three repeats minimum; don't act on gaps under ~3 points; run baseline and candidate
   in the same window of time.
8. **Cost and latency per solved task**, not only per run.
9. **Capability and regression suites apart.** Saturated tasks (inline-answer, restraint-cat) move to regression;
   the capability suite should start well below 1.0.
10. **Calibrate the judge** against 30-50 hand-graded answers, one criterion at a time (TPR/TNR), and re-check when
    the judge prompt changes.
11. **Tasks from real use.** An export of real (consented) chats, with the user's own failures turned into tasks.

## Order

1. Context budget (256k / 100k) and the plan-file reminder: measured on long tasks (ssg-report, long-bookclub,
   swe).
2. Tool-result clearing at fixed boundaries, read_url outline/find, the budget line: measured on research and
   ssg-report (tokens per solved task and score).
3. pass^k in the summary; judge calibration; saturated tasks moved to regression.
4. The simulated user and hidden-spec tasks.
5. Assumption chips and evidence links in the UI.

## Sources

Anthropic engineering: Building effective agents (2024-12); Multi-agent research system (2025-06); Writing
effective tools for agents (2025-09); Effective context engineering (2025-09); Effective harnesses for long-running
agents (2025-11); Demystifying evals for AI agents (2026-01); Infrastructure noise (2026-02); Eval awareness in
BrowseComp (2026-03); Harness design for long-running apps (2026-03); Managed Agents (2026-04); Claude Code best
practices. OpenAI: A practical guide to building agents; Evaluation best practices; Run long-horizon tasks with
Codex; Testing agent skills with evals; Rethinking skills and prompts for GPT-6 Astra. Google: The anatomy of
harness engineering (2026-09); Measuring what matters with Jules (2026-06); the AQuA outer loop (2026-10). Cognition:
Don't build multi-agents. Cursor: Towards self-driving codebases. Amp: Feedback loopable; 200k tokens is plenty.
Hamel Husain and Shreya Shankar: Evals FAQ; LLM-as-judge guide; Who validates the validators. Eugene Yan:
LLM-evaluators; Product evals. τ-bench, τ²-bench, GAIA, Terminal-Bench task and integrity notes.
