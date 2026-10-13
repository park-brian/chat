# Goals and primitives

The user's direction (2026-10-13): think about what makes a goal mode useful. It is most useful with a clear,
verifiable objective at the end, a real goal planned carefully. Build the best harness that uses the models'
intelligence without overengineering: too much choice is bad; a simple set of primitives lets the model express
itself in powerful and creative ways.

## What the evidence says

- Work with a checkable end goes well: swe fixes every bug (hidden tests green in every run); research answers
  with exact values reach 0.98-0.99; the Lisp interpreter's first version passed all 167 hidden programs.
- Work without a checkable end goes on forever: both long runs kept revising finished work until time ran out
  (the novella with all 12 chapters on disk; Lisp after v1 passed everything).
- Process the model must run itself leaks into what it says (B2: "Item 1 passes now"), and process on small work
  makes it worse (B8: a two-test fix with four plan calls and a rewrite).
- Choices cost cheap models: Gemini built a 2,317-line app for a prose request when a tool's error and the plan
  tool's presence suggested building (E4c).

## A goal is a contract with a finish line

A goal is worth starting only when "done" can be checked by the harness. So a goal is not a mode the user
switches; it is something the model proposes and the user confirms.

1. **Propose.** When a request is large and has a checkable end, the model proposes a goal in a few lines: what
   will be true, in the user's words; the checks that show it (commands and their expected results, each one
   failing now); what it will not do; a budget (time or steps). It does this before building, with one question
   at most for what only the user knows.
2. **Confirm.** The user accepts with one click, or edits it. That confirmation is the careful planning: intent is
   pinned to checks before any work starts.
3. **Run.** The harness runs the checks after each change and stays quiet otherwise. It speaks only when
   something changes: a check turned green or red, the same failure twice, no progress, the budget running out,
   a stop with checks still red.
4. **Finish.** All checks green: report what was done with the evidence. Budget spent: report what is green, what
   is red, and why. Never "done" with a red check.

Where goals fit: a bug with a reproduction (the failing test turns green, the rest stay green); a feature or app
to a spec (its acceptance tests); a port or migration (the old tests pass against the new code); a performance
target (a benchmark under a number); data analysis with a defined answer (the figure and the number exist and
are recomputed by the harness); a research report (required sections, every cited source fetched, the planted
claims checked); a book with a continuity registry (chapters exist, no contradictions by the consistency check).

Where they don't: questions, explanations, brainstorming, open-ended drafting, taste. No goal, no contract, and
the director stays silent.

## Few primitives, each general

Today the model chooses among about 17 tools, `task` has 7 sub-agent types, `plan` has 6 operations, and checks
come in 8 kinds. Most of this is choice, not capability. With a real shell, almost everything becomes one tool.

| Primitive | Does | Replaces |
| --- | --- | --- |
| `bash` | Run anything in the project: files, node, python, tests, git, curl | code, view_file, history, diff, restore, run_app on test files |
| `edit` | Create or change a file precisely (write, replace, patch) | write_file, edit_file, editor |
| `look` | Open a page as the user sees it: screenshot, console, its tests, at a viewport | run_app on pages, screenshot |
| `web` | Search the web or read a URL | web_search, read_url |
| `agent` | Hand a piece of work to a fresh agent, or a copy of this conversation, optionally owning some files | task with its 7 types |
| `goal` | Propose the contract; ask the one question only the user can answer | plan's operations, the ask flow |

Kept out of the model's choices: `think` (adaptive thinking does this), `mcp` (shown only when a server is
configured), memory and skills (they are files: `bash` and `edit` reach them).

One kind of check: **a command and what it should return** (`{ run: "npm test", exit: 0 }`, `{ run: "python3
check.py", stdout: "OK" }`). A probe in a page is a command (`look --eval`); a file property is `grep` or `wc`; a
source check is `grep` over the fetched pages the harness saves. The only other kind is a judged criterion for
prose, marked as judged.

## What the director does, and doesn't

It doesn't plan for the model, rename its work into items, or speak on small tasks. It runs the checks, keeps the
ledger, and speaks in the newest turn when a check changes state, the same failure repeats, nothing moves, the
budget runs low, or the model stops with red checks. Every note goes through the one steering channel
(docs/specs/2026-10-13-envelope.md).

## How to get there without breaking what works

Each step is an experiment against the noise floor (docs/experiments/LOG.md):

1. Ship the shell next to the current tools (E12): does the model use it, and do test claims and scores improve?
2. E19: the six primitives against the current set, same tasks, Haiku and Gemini ×3: scores, tool errors, steps,
   tokens, time. Prediction: equal or better scores with fewer steps and errors, the largest gain on Gemini.
3. E20: goals as proposed-and-confirmed contracts (with the simulated user confirming or editing) against the
   current director on swe, long, intent and game-ambitious: finishes inside budget, red checks at "done", leak
   count, steps on small tasks. Prediction: no runs that keep revising after green; no process on small tasks.
4. Remove what isn't used, one tool at a time, measured.
