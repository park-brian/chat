# Maintaining a useful spec

Read this when establishing intended behavior or changing a contract. Use existing repository conventions. The artifact can be a few paragraphs; its value is a decision a maintainer no longer has to reconstruct.

## What belongs where

| Artifact | Owns | Does not replace |
| --- | --- | --- |
| Behavioral spec | What users/callers may rely on, including failures | Evidence that behavior works |
| Architecture note or decision | Ownership, dependency direction, meaningful tradeoffs | The behavior contract |
| Plan | Remaining steps, dependencies, open decisions | A lasting spec |
| Tests | Executable examples and invariant checks | Every requirement or operational guarantee |
| Review | Observations, defects, evidence, recommendations at a revision | Current product intent |

Prefer one document with short sections over several documents that repeat the same facts. Split only when scope or audience warrants it. Maintain an index only once navigation needs it.

## Minimal shape, used selectively

```markdown
# Capability name
Status: proposed / accepted / deprecated
Scope: who uses it and the outcome it supplies

## Behavior
Observable rules with concrete examples.

## Invariants and failure behavior
What remains true; what is saved, returned, or recoverable on failure.

## Compatibility and constraints
Existing consumers, data formats, and relevant operational limits.

## Evidence and open decisions
Links to the checks that demonstrate the important rules.
Unresolved choices clearly separated from promises.
```

Omit sections without useful content. For a large spec, give requirements stable descriptive labels so tests can link to them. Do not copy whole assertions into prose. Add acceptance examples that could distinguish two plausible implementations.

Authority and conformance are separate: accepted means this is the intended contract, not that the implementation already meets it. Keep known deviations next to the affected promise or link to their tracked work; do not close a feature while a required acceptance example is known to fail. A second status system is unnecessary if the existing document already makes the distinction clear.

Make examples discriminate between plausible implementations. Include initial state, action, observable outcome, and any state that must remain unchanged. For example, "cancellation is supported" leaves the commit rule unknown; "cancellation before publication preserves the prior version, while cancellation after publication reports the committed result" defines a decision an implementation can enforce.

## Example: a file-editing operation

This is an illustrative proposed contract, not a retroactive claim about any implementation:

> `replaceText(fileId, expectedRevision, oldText, newText)` changes exactly one occurrence of literal `oldText`. The replacement is literal too: `$&` stays `$&`. Missing or ambiguous matches fail without changing the file. A revision conflict fails without overwriting another edit. Success returns the new revision and means the write is durable. File identity includes its owning workspace. Display names do not determine ownership.

The contract decides meaning, conflict behavior, and commit semantics. It leaves the storage engine, function decomposition, and UI presentation free to change. Useful evidence includes literal dollar characters, no match, repeated matches, and two writers using the same revision. A tiny personal tool may instead serialize edits and omit revisioned APIs; choose the policy its actual callers need.

## Resolving drift

1. Locate the canonical contract and inspect the current behavior and relevant tests. Record the concrete disagreement.
2. Determine whether the task requests restoring a promise or changing it. User intent and accepted product decisions matter more than whichever artifact is easiest to edit.
3. If the contract is missing, write observed behavior as observed and proposed behavior as proposed. A characterization test records a fact; it does not ratify that fact as desirable.
4. Resolve only choices necessary for this change. For example, choose whether duplicate commands queue or reject before implementing concurrency handling; do not redesign all navigation.
5. Update the contract, implementation, and evidence coherently. Explain any behavior intentionally left incomplete. Do not mark a spec implemented while its required behavior is known to fail.

## Planning without duplicating truth

Link each substantive work item to the contract it establishes or preserves. A plan should answer what remains uncertain, what comes next, and what would count as done. Use a vertical slice to validate an external integration before expanding the surrounding product.

For migrations, name the old and new readers/writers, the data transition, the period of overlap if needed, and how failures recover. A rollback of application code does not automatically undo a data migration. For deprecation, identify consumers, communicate through the project's established mechanism, and define when compatibility code can be removed.

For a small CLI, the compatibility surface may be exit status and output format. For a library, it may be public types and behavior. For a browser app, it may include saved data and interrupted operations. Choose the smallest spec that covers the real promises.
