---
name: software-steward
description: Choose, test, and evolve software architecture from concrete requirements, change scenarios, and operational constraints. Use for architecture decisions, substantive feature design, structural refactoring, and code health reviews. Guides representation, ownership, interfaces, dependencies, and migration across architectural styles; small local edits need no architecture exercise.
---

# Software steward

This is a meta-architecture skill: a method for making and revising design decisions. Use it to produce software whose behavior is clear, whose important rules have reliable owners, and whose next likely change is understandable. Architectural labels are possible descriptions of the result, not starting requirements.

Judge the architecture through the work it makes necessary. Follow a real operation, a meaningful failure, and a plausible change. Count the policies a caller must know, independent facts that must stay synchronized, places that must change together, and boundaries across which failure can split an operation. A diagram or shorter file does not establish improvement.

For a private rename or an obvious local correction, make the small change. For a review, investigate and recommend within scope. For substantive design, use the loop below; write down only decisions that need to survive the conversation. Do not turn the loop into mandatory documents or an approval process.

## 1. Frame the decision before choosing the shape

Read the relevant spec, actual entry point, affected readers/writers, tests, and current changes. Trace a concrete input through decisions, effects, and the returned or displayed result. Search for other entry points that enforce the same rule; one well-designed new path does not repair the old ones.

State what must change and what must remain true. Separate:

- **Constraints:** actual compatibility, deployment, data, latency, cost, team, and user requirements. Cite their source where a mistaken assumption would change the design.
- **Preferences:** conventions or desirable qualities that can trade off against each other.
- **Unknowns:** assumptions that could invalidate the choice and the smallest observation or experiment that would resolve them.

Do not invent scale requirements or a universal priority order. A prototype, embedded library, accounting system, and collaborative editor have different obligations. Where requirements conflict, expose the choice. Make reversible implementation decisions using the available evidence; seek clarification for an unresolved consequential product requirement, not ordinary naming or decomposition.

Describe the decision in concrete terms: who owns an edit, whether work must outlive a request, or whether two deployments must change independently. "Use clean architecture" is not yet a decision.

## 2. Choose scenarios that can reject a design

Use a few examples relevant to the decision, often:

- The ordinary operation through its real caller.
- The failure, interruption, concurrency, or boundary value most likely to violate the promise.
- One plausible next change grounded in an actual consumer, roadmap item, or unstable dependency.

For each, identify initial state, action, observable result, and what must remain unchanged. This is usually a few sentences in an existing spec or working note. Do not invent exotic cases to justify infrastructure.

Example: "An export starts for project A, the view switches to B, then the write finishes. The output still belongs to A. A failed write produces a failure result and leaves the prior completed export usable." This distinguishes designs that use operation identity from designs that consult current UI selection later.

## 3. Design the representation and its owner together

List the facts required by those scenarios. Classify each as authoritative state, a derived value, a deliberate snapshot/draft, or a cache. Choose a representation that makes the ordinary read and legal update clear while reducing facts that must change in lockstep.

For example, `{items, selectedId}` often needs less coordination than `{items, selectedItem, selectedIndex}`. But a separately editable draft is independent information and should not be replaced by a derived view. State what happens if the selected item is deleted.

For each important invariant, identify the operation that enforces it and the mechanism that makes enforcement hold: a constructor, a domain function, a transaction, a conditional write, a single writer, or an explicit coordination protocol. "The service owns it" is incomplete if other callers can bypass the rule. Multiple systems may own different facts; do not pretend distributed work becomes atomic by putting it behind one function.

Distinguish absence, invalid input, a legitimate alternative, and an internal contradiction. Reject invalid external input at its boundary. Model real alternatives. Trace contradictions to the writer or transition that creates them. Before adding a guard, check whether the value can change between checking and using it, or whether every caller must repeat the guard. Those are reasons to repair ownership or representation, not accumulate caller precautions.

For work that outlives its caller, capture stable target identity and required input at the start. Define acceptance, commit, terminal outcomes, and resource cleanup. A lost response after an external effect can mean an unknown outcome; retries need a duplication/reconciliation policy when effects matter. Use these distinctions only where the operation requires them.

## 4. Make callers expose the quality of an interface

Write or sketch a real caller before spreading an interface through the codebase. Ask what the caller must know to use it correctly. If callers repeat validation, ordering, scope lookup, concurrency, or cleanup rules, move enforcement to the owner with the information and authority to implement them.

Prefer an operation that completes a meaningful responsibility over an API that exposes each internal step. A function named `compareAndSet` still needs an atomic implementation; wrapping read/check/write does not supply it. Conversely, a coordinator can legitimately compose independent effects and report partial results. Low-level control is appropriate when that is the API's actual purpose.

Keep domain decisions separate from transport and representation conversions when they change independently. Pass ordinary inputs to calculations; make I/O and mutation visible in the coordinating path. A parameter or small record often supplies the needed seam. Avoid introducing a framework merely to name a boundary.

Use product vocabulary in data, APIs, specs, and tests. Prefer explicit units and distinct names for draft, saved record, identifier, and display label. A reader should see the main operation in order, without tracing forwarding helpers or decoding flags that select unrelated jobs. Extract a helper when its contract removes knowledge from its caller; retain a cohesive algorithm when splitting only scatters it.

## 5. Compare credible architectures by consequences

Keep the existing or direct implementation as a candidate. When a choice is consequential and uncertain, compare it with a credible alternative. An obvious constrained decision needs no alternatives document.

Separate the axes: code decomposition, interaction/control flow, state/history, execution, and deployment. A modular monolith can contain an event-driven workflow and a relational store. Do not choose a complete architectural package because one property is useful.

Walk the selected scenarios through each candidate. Identify:

- Where the invariant is enforced and what callers must remember.
- Which state/decisions are duplicated and what coordinates them.
- Which owners change for the plausible next requirement.
- What can fail independently, and who detects and recovers it.
- What implementation, operation, compatibility, and migration costs the boundary introduces.

Choose the least costly shape that satisfies the actual constraints, not the one with the fewest lines or newest label. Prototype the uncertainty that would reverse the choice. Preserve a boundary that permits later replacement only when it hides a meaningful decision now; hypothetical flexibility is not free.

Read [architecture choices](references/architecture-choices.md) when evaluating architectural styles, branching/history, or deployment boundaries. It gives discriminating scenarios and obligations, not a pattern-selection checklist. Read [worked design](references/worked-design.md) when translating this method into interfaces and concrete code changes.

Record a non-obvious decision briefly: the requirement, chosen owner/contract, rejected credible alternative and its cost, evidence, and a condition that would warrant revisiting. Omit a decision record for an ordinary local choice. Never label an unmeasured advantage as demonstrated.

## 6. Implement a slice that exercises the decision

Build one usable path through the real entry point and relevant boundary before expanding the design. Resolve the assumption most likely to invalidate it early. An experiment ends in adoption, rejection, or a precise remaining uncertainty; decide what happens to its code.

When centralizing a policy, search its existing readers/writers again. Route affected callers through the selected owner and remove displaced rules within scope. A new helper plus old divergent paths is an incomplete refactor. Keep behavior changes distinguishable from mechanical movement so the diff remains reviewable.

Keep canonical specs about observable behavior, invariants, failure semantics, and compatibility. Accepted intent, current implementation, and evidence are different facts. Do not amend a promise to bless a bug or treat a characterization test as approval of the behavior. Update the existing contract alongside intentional behavior changes; create a document only when an important contract has no adequate home. A private behavior-preserving edit needs no spec. Read [spec workflow](references/spec-workflow.md) for drift and migration decisions.

For concurrent development, divide work by contract/owner and integrate a small shared boundary before dependent implementations diverge. A branch isolates a line of development; a worktree isolates files. Neither prevents contradictory design decisions. Use the repository's branch/review conventions, preserve unrelated work, and verify the combined result after integration. A spec conflict requires reconciling intended behavior, not choosing whichever text merged last. Read the collaboration section of architecture choices only when this is relevant.

## 7. Verify the architecture through the delivered change

Use the cheapest observation that crosses the failure-causing boundary. A pure helper test does not establish process exit status, durable persistence, caller integration, or browser lifecycle. Observe a save after reopening when durability is the promise; invoke the process when exit status is the promise; control completion order when an interleaving is the risk. Distinguish representative adapter fixtures from evidence about a live external service.

Tests must observe an effect independently of its input. They should fail if the behavior is removed or replaced by an echo. Wait for defined outcomes, isolate mutable fixtures, and release owned resources. The command must propagate test failures. Coverage helps locate missing evidence, but cannot establish the contract.

Use a completion rule appropriate to the work:

| Work | Evidence of completion |
| --- | --- |
| Fix | The triggering failure is corrected without weakening the existing promise; relevant neighboring behavior remains valid. |
| Feature | The real caller reaches the usable behavior; contract, implementation, and evidence agree. |
| Refactor | Affected behavior is preserved, callers use the new owner, displaced policy is removed, and the claimed change cost improves. |
| Migration | Supported old/new reader-writer combinations and recovery work; remaining compatibility has an identified consumer/removal condition. |
| Experiment | The decision received evidence, and experimental code has a disposition. |
| Review | Findings have location, trigger, consequence, and evidence; recommendations are distinct from defects and open questions. |

Compare the actual diff with the chosen scenarios. Check for unwired helpers, duplicated policy, invented requirements, accidental compatibility changes, and documentation that promises more than the code delivers. Trace the plausible next change through the final code; if it still requires synchronized policy edits, the intended boundary may not exist yet. Do not implement that future feature just to complete this check.

Also cold-read the result: find the behavior by its product name, follow its normal path, explain mutations and failure handling, and identify the authoritative values. Report evidence and remaining limitations. Stop when the intended change is complete; architecture work is not permission for endless adjacent cleanup.

## Evolve the architecture and this skill

Revisit a choice when its assumptions fail: incompatible consumers, repeated cross-owner edits, measured operational limits, or recovery costs. Change the failing boundary through a coherent migration instead of rewriting unrelated working code. Remove obsolete adapters, flags, state, and documents when their consumers are gone. Concrete security, accessibility, reliability, and cost constraints participate in these decisions; keep remedies tied to actual requirements and effects.

Evaluate this skill on delivered artifacts. Give a fresh agent the skill and an unfamiliar executable task without the expected design. Inspect and execute its result independently, then request one plausible extension and inspect how many policies must change. Include a tiny task to check restraint. Architecture-choice trials should contain credible alternatives and conflicting constraints; a successful small function exercise cannot validate distributed-system design.

Revise instructions only when a decision or artifact demonstrates a gap. Remove rituals that do not improve a choice. Keep the skill self-contained. Research clones, creation notes, and trial artifacts are temporary evidence; using this skill must not require those files or the conversation that produced it.
