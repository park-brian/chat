# Comparing architecture choices

Read the sections relevant to a consequential decision. This is not a list of styles to apply or a ladder of maturity. Begin with the concrete operation and constraint; existing architecture may already be sufficient.

## Separate the decisions, then test their interaction

| Axis | Decision to make | Possible shapes |
| --- | --- | --- |
| Decomposition | Which rules must change together, and what can be hidden behind a stable contract? | Cohesive functions, feature modules, layers, a domain core with adapters |
| Interaction | Who controls sequencing and how does a caller learn the outcome? | Direct call, pipeline, explicit workflow, event/subscription |
| State | Which facts are authoritative and what history must remain reconstructable? | Current records, snapshots, tree/DAG, event history, derived projections |
| Execution | What work can proceed independently and what lifetime does it need? | Synchronous operation, background job, batch, stream, actor/single writer |
| Deployment | What needs independent rollout, failure isolation, location, or scaling? | One process, background worker, independently deployed services, local plus remote |

These choices compose, but they are not independent in cost. Moving a module across a process boundary adds latency, serialization, deployment compatibility, and partial failure. Adding events changes when a caller can know that dependent work completed. Re-run the same scenario after such a change.

## Which mechanism pays for itself?

| Candidate | Evidence that may justify it | Obligation or cost it introduces | A scenario that distinguishes it |
| --- | --- | --- | --- |
| Direct cohesive code | One caller/lifetime; policies are local and readable | Splitting may become useful when consumers or independently changing decisions appear | Trace the operation without hidden shared state; locate a changed rule once. |
| Feature modules / modular monolith | Several capabilities with meaningful ownership, one deployment acceptable | Define boundaries and prevent internal data access from bypassing them | Add a second entry point for the same operation without copying its policy. |
| Layered or core-and-adapter design | A rule has multiple delivery/storage/provider contexts, or external details change independently | Mapping, indirection, and interfaces can exceed what they hide | Replace one real adapter while preserving domain rules and observing error translation. |
| Functional pipeline | Stages transform data with clear inputs/results; intermediate representations have meaning | Stage error propagation, buffering, and excessive intermediate abstractions | Compose or reorder only stages whose data dependencies permit it; retain input/output meaning. |
| Explicit state machine / workflow | Legal actions depend on state; work suspends, resumes, cancels, or crosses effects | Transition ownership, state persistence if needed, terminal and recovery behavior | Interrupt at a transition, resume/retry, and determine which effects already happened. |
| Events / pub-sub | Producers can complete without consumers completing, and independent reactions are valuable | Ordering, duplicate delivery, schema evolution, correlation, failed consumers | Deliver twice or out of order; identify who owns deduplication and how users see incomplete reactions. |
| Actor / single writer | Concurrent commands modify one meaningful entity and serialization simplifies its invariants | Queue ownership, backpressure, persistence/restart semantics if needed | Two commands race; determine ordering and what an acknowledged result guarantees. |
| Separate services | A concrete independent deployment/scaling/failure/team boundary is worth remote coordination | Network failures, compatibility, observability, and distributed data ownership | One service commits and another is unavailable; identify the user-visible state and recovery. |
| Event history / event sourcing | Reconstructing historical decisions or temporal state is a product requirement | Event meaning/versioning, replay determinism, projections, corrections and erasure obligations | Rebuild state using old events after policy has changed; distinguish recorded facts from today's rules. |
| Separate read model / CQRS | Measured read/query needs differ from write invariants enough to justify another representation | Projection lag, rebuilds, consistency semantics and operational work | A write succeeds but a view lags; define what that user must see. |

These are starting questions, not automatic selection rules. An audit requirement may need an ordinary append-only audit record, not event sourcing. A slow operation may need a local queue/worker, not microservices. Multiple adapters can be plain functions. A branching UI does not automatically need an event bus. Prototype the uncertainty that matters.

## Representing branching and history

First decide what a branch means to the user: a private draft, an alternative future, a saved version, a concurrent edit, or a control-flow choice. Each implies different promises.

For alternative histories, work through these decisions before selecting a data structure:

1. **Identity and ancestry.** What is a stable node/version ID? Can a node have one parent or several? A tree supports forks; a merge may require a DAG or an explicit new snapshot. A label or array position is not stable identity.
2. **Shared versus private state.** Does editing an ancestor rewrite shared history or create a new node? Do attachments/resources follow the version, belong to a branch, or remain intentionally shared? Choose from the product contract; copying everything or sharing everything are both consequential choices.
3. **Selection versus execution.** A displayed path is a view. Work that started on branch A retains A's target even if the user views B. Persist selected head only if restoring selection is part of the product; compute latest activity under a defined rule if that is the chosen behavior.
4. **Merge and deletion.** Is merge supported? Which conflicts require user choice? What happens to descendants, references, active work, and shared resources when a node is removed? Keep unsupported operations explicit rather than accidentally accepting corrupt structure.

Acceptance example: fork a saved revision, edit one descendant, switch to its sibling while a save is pending, and reload. Assert the expected ancestry, unchanged shared content, saved target, and selected head. If merge is supported, add one conflict example. This tests the model more effectively than merely checking that a branch button renders.

For branching workflows rather than version histories, write the allowed state transitions and what each transition commits. Mutually exclusive actions, parallel independent work, and retry loops have different semantics; do not encode all three as loosely related booleans.

## Evolution without architectural lock-in

Prefer changing one boundary with its consumers over carrying two competing models indefinitely. A temporary adapter can bridge a migration, but name which consumer needs it and when it can disappear. Test supported old/new combinations that actually coexist. An application rollback does not necessarily undo a data migration.

Choose an extension seam around a real variation: provider protocol, file format, platform, or persistence policy. Keep the stable contract narrow enough to describe both existing consumers honestly. If each new case requires flags and exceptions in a common abstraction, reconsider whether those cases share a contract. Splitting the abstraction can be simpler than making it universal.

Performance can warrant a cache, index, specialized representation, or process split. Measure the relevant workload and memory/latency tradeoff, retain a correctness oracle when useful, and state the invalidation/consistency policy. Fewer network calls may matter more than fewer lines. A benchmark advantage outside the product workload does not establish an architectural need.

## Parallel development, Git branches, and integration

Use this section when several changes or contributors interact. It is distinct from the product's branch/history model.

- Find the actual integration target, existing work, and repository conventions. Isolate concurrent filesystem work when needed; separate worktrees are often useful. Never discard unrelated changes to create a clean architectural story.
- Divide work by owner or independently verifiable slice. Agree on shared vocabulary and boundary behavior before parallelizing dependent implementations. Two green branches can still implement contradictory meanings of the same field.
- Keep a branch about a coherent behavior or migration step. If a task depends on another, make that dependency explicit and integrate the shared contract early. Use stacked changes when the repository supports them; do not accumulate unrelated features in a long-lived architectural branch.
- Reconcile contracts and invariants during conflict resolution, then verify the combined implementation. Text merging and separate branch test results do not prove semantic compatibility.
- Introduce a rollout flag or compatibility path only when a real transition needs it. Define its removal condition. Follow existing review/release authorization rather than inventing extra approval gates.

The goal is a single understandable integrated design. Branches and worktrees are collaboration mechanisms, not substitutes for ownership or a source-of-truth spec.
