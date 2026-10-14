# Working docs: a plan that keeps its own notes

The user's direction (2026-10-14): a model should be able to set a high-level goal, plan it in a verifiable and
realistic way with a check at each step, and keep the support docs the work needs as it goes: for a novel, an
outline and the key facts; for experiments, a log of history and lessons, so it stays on the plan without getting
stuck. Compare with the harness this work is done in.

## How the harness I work in keeps me on track

| | Claude Code (this session) | the chat harness today |
| --- | --- | --- |
| Standing instructions | System prompt, plus CLAUDE.md and the memory index, loaded at the start and after every summary | System prompt; /memories/ for later chats |
| The plan | A plan document I write in docs/, reviewed, then followed; its status section updated as phases finish | The plan tool's contract: goal, items with harness-run checks, notes; the harness renders PLAN.md |
| Working docs | Files I chose and keep: docs/experiments/LOG.md (question, prediction before the run, result, lesson), the plan spec, memory files | None of the model's own in the project; contract notes (short facts with sources) |
| Seeing them again | I reread them; the summary that replaced old context told me where they are and what they said | After a summary: the goal, the current item and a few notes |
| Checks | Tests and scripts I run, and measuring tools I built for myself (director-report, regrade, dollars) | The harness runs each item's check on the artifact |
| Checkpoints | A commit after each phase, with what was learned | Versions per file; a baseline commit per turn |

What kept this session on track was not the checks alone: it was the log, written before and after each run,
and reread. Predictions written down before a run made each result a test; lessons written after made the next
step follow from them. The plan doc's status section said where things stood after every summary.

## What the novella runs show (E28 transcripts, read 2026-10-14)

Haiku planned well: 10-12 contract items, one per chapter, each with a word-count check, all passing. And in its
first step it wrote a story bible (timeline, who knows what, fixed facts). But:

- It wrote the bible with the `editor` tool, into the notes store outside the project, then cited it as
  `/project/novella-bible.md`, a path that doesn't exist.
- It never opened the bible again (one editor call in the run) and never updated it as chapters set new facts.
- After each of three summaries, the harness handed back the goal and the current item, not the bible.
- Every item's check was about length. Nothing checked a chapter against what earlier chapters had set.

So the model had the right instinct. The harness gave it two places to keep notes, showed neither again, and
checked only the artifact. Stronger models keep the facts in their heads over 20k words (Sonnet: 0.5
contradicting chapters a run); Haiku needs them written down, kept and shown (4.25).

## Design: working docs as part of the plan (flag `docs=on`)

One primitive added to the contract, and three duties for the harness.

**The model declares its docs with the goal.** `plan({ goal, done, docs: [{ path, keeps }] })`. A doc is a
project file (notes/facts.md, notes/outline.md, docs/log.md), never the editor's store: one place for files. The
plan tool's docs give three examples and no more:
- a long piece of writing: notes/outline.md (each part's events) and notes/facts.md (names, ages, dates, places,
  who was where, who knows what);
- experiments: docs/log.md (each run's question, prediction before it, result, lesson);
- a large change to code: notes/decisions.md (each decision and why).

**1. The harness shows the docs when they matter.** Their current text (each clipped to 2,500 characters, head
and tail kept) rides the note when the current item changes and after every summary. Not on every step, which
would cost the cache and attention.

**2. The harness checks that they are kept.** When an item's check passes and a doc hasn't changed since the item
began, the note says so once: the item passes, and notes/facts.md hasn't been brought up to date with what it
set. Scripted, free.

**3. A check against a doc.** A new check kind, `{ "kind": "consistent", "file": "chapters/03.md", "against":
"notes/facts.md" }`: a Haiku call reads the doc and the file and lists each statement in the file that
contradicts the doc, or each new fixed fact the doc lacks. It passes when there are no contradictions. It costs
about 5k Haiku tokens (about $0.0005), against Opus rereading every chapter in E28c. Haiku here, by the user's
rule: Opus and Sonnet sparingly.

**The editor's store** keeps memories and skills, for later chats. Under `docs=on`, a doc path under /memories/
is refused by the plan tool with the reason: working docs go in the project, where the harness can show and
check them.

## Experiment (E31)

- **Arms:** novella ×3 with `docs=on` against the plain runs at the same settings (E28b baseline: 11.5 of 19,
  4.25 contradicting chapters a run, $0.10). Research ×2 and Lisp ×1 with `docs=on` as a check for harm.
- **Measures:** checks passed; contradicting chapters (the grader's own count); whether docs were declared, how
  often they changed, how often `consistent` checks ran and failed; dollars by model.
- **Prediction (before the run):** contradicting chapters at most 2 a run, checks at least 13.5, at under 2× the
  cost. If docs are declared and kept but contradictions don't fall, the showing or the checking is wrong, not the
  idea; the transcripts will say which.
