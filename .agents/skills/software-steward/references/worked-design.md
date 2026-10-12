# From a design principle to a working boundary

Read this when a change seems to require either another patch or a new abstraction. The examples illustrate the reasoning; they do not prescribe a language, framework, or file layout.

## One export policy, two callers

Suppose an archive preview and an archive writer each select published files and calculate export size. A new option allows including drafts. The size limit should apply to the selected files, not all stored files.

A distinguishing example includes a large excluded draft: exporting the smaller published set must remain possible. Checking a folder where every file is published would not distinguish the correct policy from counting everything.

An incomplete patch copies a new filter into each caller. A speculative design introduces selection strategies, size policies, a registry, and an export framework for one rule. Compare the actual responsibilities:

- Export planning owns selection and the meaning of the size limit.
- Archive writing owns encoding, output I/O, and successful completion.
- Preview presents the same selection without writing an archive.

A small operation can hide the shared decision:

```js
function planExport(entries, { includeDrafts, maxBytes }) {
  const selected = entries.filter(entry =>
    includeDrafts || entry.status === 'published');
  const totalBytes = selected.reduce((sum, entry) => sum + entry.byteLength, 0);
  if (totalBytes > maxBytes) throw new Error('Export exceeds size limit');
  return { entries: selected, totalBytes };
}
```

This is a design sketch, not a drop-in implementation. Establish where entries are validated and what byteLength means. Uncompressed size is not encoded archive size; if the real promise concerns compressed output, this calculation is insufficient. The representation and boundary must match the actual contract.

The writer should consume the same plan and report success only when its output contract is met. Observe the resulting archive as well as the preview. Merely asserting that planExport was called freezes decomposition without proving that the intended files were written.

Now rehearse an actual next change: omit files of selected types. If preview and writing each need their own new filter, ownership still leaks. If the selection policy changes once with corresponding evidence, the seam is doing useful work. Do not implement that extension before it is requested.


## A guard that does not fix ownership

Consider asynchronous generation whose result belongs to a workspace:

```js
const result = await generate();
if (!currentWorkspaceId) return;
await save(currentWorkspaceId, result);
```

The guard handles absence but permits saving into a different workspace after navigation. Another guard in each UI button will not repair that meaning. Capture the target when the operation starts:

```js
const target = resolveTargetAtStart();
const result = await generate();
await save(target, result);
```

Then resolve the remaining real questions: what happens if the target is deleted, whether this result supersedes another run, when input is considered accepted, and whether the result can be recovered after interruption. Answer only those required by the operation. A stable target does not automatically imply a queue, global lock, background service, or full event history.

## A transaction boundary cannot be faked by naming it

```js
const record = await store.read(id);
if (record.revision !== expectedRevision) return conflict;
await store.write(id, replacement);
```

This check can race. A better caller asks the storage owner to compare and write atomically:

```js
await store.compareAndSet(id, expectedRevision, replacement);
```

The implementation must actually use an appropriate transaction or conditional operation. If the storage cannot provide it, describe the weaker guarantee and choose serialization, a recoverable protocol, or a different contract based on the real deployment. A process-local lock cannot serialize another process. Moving the first snippet behind the second name is cosmetic.

## How to tell whether the change improved the architecture

Inspect the artifacts, not the explanation alone:

- Search the old policy: remaining copies are either removed, deliberately independent, or explicitly outside scope.
- Follow each affected caller to the new owner. An unused helper has no architectural benefit.
- Read returned data without its implementation. The meaning of amounts, IDs, states, and errors is unambiguous.
- Run an acceptance example that would fail with the original mechanism; observe through the boundary that matters.
- Trace one justified extension and one failure. Identify exact owners that change and the obligations each caller retains.

A design is allowed to remain direct. More files, injectable objects, diagrams, tests, or specification pages are not evidence of lower change cost by themselves.
