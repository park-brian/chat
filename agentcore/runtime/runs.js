// A turn runs as a Runtime task that owns its execution; HTTP responses are
// only observers. The heartbeat detects lost execution, never permission to
// replay it. Progress is kept in memory for watchers on this worker and
// flushed to S3 for any other worker.
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { stillAuthorized } from "./accounts.js";
import { s3 } from "./aws.js";
import {
  expression,
  fail,
  get,
  pack,
  patterns,
  sk,
  transact,
  update,
  userKey,
  uuid,
} from "./db.js";

export const maxActiveRuns = 3;
// "running" until the turn is saved, fails or is cancelled; "outcome_unknown"
// only when its worker stopped heartbeating.
export const runStatuses = [
  "running",
  "completed",
  "failed",
  "cancelled",
  "outcome_unknown",
];
const heartbeatMs = 15000;
const lostAfterMs = 90000;
const terminal = (status) => status !== "running";
const bucket = () => process.env.BUCKET;
const progressLocation = (sub, requestId, chunk) =>
  `runs/${sub}/${requestId}/progress-${chunk}.json`;
const fingerprint = (input) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(input).sort(([a], [b]) => a.localeCompare(b)),
        ),
      ),
    )
    .digest("hex");
const requestKey = (sub, requestId) => userKey(sub, sk.request(requestId));
const lockKey = (sub, run) =>
  userKey(sub, sk.lock(run.projectId, run.conversationId, run.branchId));
const chatKey = (sub, run) =>
  userKey(sub, sk.chat(run.projectId, run.conversationId));

// The operations that free a run: its branch lock (only if still its own),
// one off the conversation's run count, and its slot in the owner's set.
export const releaseOps = (sub, run) => ({
  lock: {
    Delete: {
      Key: lockKey(sub, run),
      ...expression({
        condition: "#requestId = :request",
        values: { ":request": run.requestId },
      }),
    },
  },
  chatAdd: { activeRuns: -1 },
  slot: {
    Update: {
      Key: userKey(sub, sk.profile),
      ...expression({ drop: { activeRequests: new Set([run.requestId]) } }),
    },
  },
});

export function createRuns() {
  // Created on first use: module state is captured in the Runtime snapshot, so
  // an id made at load time would be shared by every restored worker.
  let workerIdentity;
  const workerId = () => (workerIdentity ||= uuid());
  const tasks = new Map();

  // The lock, the conversation's run count and the owner's active-run slot are
  // released together, exactly once: the lock's own condition gates the rest.
  // A turn's commit includes these same operations, so a finished turn frees
  // its branch atomically with saving it.
  async function release(sub, run) {
    const ops = releaseOps(sub, run);
    await transact([
      ops.lock,
      {
        Update: {
          Key: chatKey(sub, run),
          ...expression({ add: ops.chatAdd }),
        },
      },
      ops.slot,
    ]).catch((error) => {
      if (error.name !== "TransactionCanceledException") throw error;
    });
  }

  const view = (row) => ({
    requestId: row.requestId,
    status: row.status,
    projectId: row.projectId,
    conversationId: row.conversationId,
    agentId: row.agentId,
    branchId: row.branchId,
    forkTurnId: row.forkTurnId ?? null,
    acceptedAt: row.acceptedAt,
    costMicroUsd: row.costMicroUsd || 0,
    turnId: row.turnId || null,
    cancelRequested: row.cancelRequested === true,
    progressChunks: row.progressChunks || 0,
    sequence: row.progressSequence || 0,
    progressClosed:
      row.progressClosed !== false ||
      Date.now() - Date.parse(row.heartbeatAt) >= lostAfterMs,
  });

  // A running request whose worker stopped heartbeating becomes
  // outcome_unknown, and only then are its lock and slot released.
  async function state(identity, requestId) {
    if (!patterns.id.test(requestId || "")) fail("VALIDATION_FAILED");
    const row = await get(requestKey(identity.sub, requestId));
    if (!row) fail("NOT_FOUND");
    if (
      row.status === "running" &&
      Date.now() - Date.parse(row.heartbeatAt) > lostAfterMs
    ) {
      try {
        Object.assign(
          row,
          await update(
            requestKey(identity.sub, requestId),
            expression({
              set: { status: "outcome_unknown", failureStage: "runtime_lost" },
              condition: "#status = :running AND #heartbeatAt = :seen",
              values: { ":running": "running", ":seen": row.heartbeatAt },
            }),
          ),
        );
        await release(identity.sub, row);
      } catch (error) {
        if (error.name !== "ConditionalCheckFailedException") throw error;
        return state(identity, requestId);
      }
    }
    return view(row);
  }

  // Admission: request row, branch lock, conversation run count, owner's
  // active-run slot and the observed branch head, all or nothing.
  async function admit(identity, request, admission) {
    const sub = identity.sub;
    const now = new Date().toISOString();
    const items = [
      {
        Put: {
          Item: {
            ...requestKey(sub, request.requestId),
            ...packRequest(request, now),
          },
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
      {
        Put: {
          Item: {
            ...lockKey(sub, request),
            requestId: { S: request.requestId },
            acceptedAt: { S: now },
          },
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
      {
        Update: {
          Key: chatKey(sub, request),
          ...expression({
            init: {
              id: request.conversationId,
              agentId: request.agentId,
              title: admission.title,
              createdAt: now,
              status: "ACTIVE",
            },
            set: {
              lastActivityAt: now,
              gsi1pk: admission.chatIndex,
              gsi1sk: `${now}#${request.conversationId}`,
            },
            add: { activeRuns: 1 },
            condition:
              "(attribute_not_exists(#agentId) OR #agentId = :agent) AND (attribute_not_exists(#status) OR #status = :active)",
            values: { ":agent": request.agentId, ":active": "ACTIVE" },
          }),
        },
      },
      {
        ConditionCheck: {
          Key: userKey(sub, admission.branchKey),
          ...(admission.observedHead
            ? expression({
                condition: "#headTurnId = :head",
                values: { ":head": admission.observedHead },
              })
            : { ConditionExpression: "attribute_not_exists(pk)" }),
        },
      },
      {
        Update: {
          Key: userKey(sub, sk.profile),
          ...expression({
            add: { activeRequests: new Set([request.requestId]) },
            condition:
              "attribute_not_exists(#activeRequests) OR size(#activeRequests) < :max",
            values: { ":max": maxActiveRuns },
          }),
        },
      },
    ];
    try {
      await transact(items);
    } catch (error) {
      if (error.name !== "TransactionCanceledException") throw error;
      const reasons = (error.CancellationReasons || []).map(
        (reason) => reason.Code === "ConditionalCheckFailed",
      );
      fail(
        reasons[0]
          ? "DUPLICATE_REQUEST"
          : reasons[1]
            ? "BRANCH_BUSY"
            : reasons[2]
              ? "NOT_FOUND"
              : reasons[3]
                ? "BRANCH_CONFLICT"
                : reasons[4]
                  ? "RUN_LIMIT"
                  : "ADMISSION_FAILED",
      );
    }
  }
  const packRequest = (request, now) =>
    pack({
      ...request,
      status: "running",
      acceptedAt: now,
      heartbeatAt: now,
      workerId: workerId(),
      costMicroUsd: 0,
      modelSteps: 0,
      toolSteps: 0,
      progressChunks: 0,
      progressSequence: 0,
      progressClosed: false,
    });

  // A lock or slot can outlive its request only if a worker died between
  // finishing and releasing. Such leftovers are reclaimed when they block.
  async function reclaim(identity, request, code) {
    const ids =
      code === "BRANCH_BUSY"
        ? [(await get(lockKey(identity.sub, request)))?.requestId]
        : [...((await get(userKey(identity.sub, sk.profile)))?.activeRequests || [])];
    let freed = false;
    for (const id of ids.filter(Boolean)) {
      const row = await get(requestKey(identity.sub, id));
      if (!row) {
        // A slot without a request: nothing else to release.
        await update(
          userKey(identity.sub, sk.profile),
          expression({ drop: { activeRequests: new Set([id]) } }),
        );
        freed = true;
        continue;
      }
      const current = await state(identity, id);
      if (terminal(current.status)) {
        await release(identity.sub, row);
        freed = true;
      }
    }
    return freed;
  }

  // The event sink a turn writes to. Events are numbered, kept for watchers
  // on this worker, and flushed to S3 in chunks for watchers elsewhere.
  function progress(sub, requestId) {
    const events = [],
      listeners = new Set();
    let pending = [],
      bytes = 0,
      chunk = 0,
      queue = Promise.resolve(),
      failure = null,
      closed = false;
    const flush = () => {
      if (!pending.length) return queue;
      const batch = pending,
        index = chunk++;
      pending = [];
      bytes = 0;
      if (index >= 1024) {
        failure = new Error("PROGRESS_LIMIT");
        return queue;
      }
      queue = queue
        .then(async () => {
          await s3.send(
            new PutObjectCommand({
              Bucket: bucket(),
              Key: progressLocation(sub, requestId, index),
              Body: JSON.stringify(batch),
              ContentType: "application/json",
            }),
          );
          await update(
            requestKey(sub, requestId),
            expression({
              set: {
                progressChunks: index + 1,
                progressSequence: batch.at(-1).sequence,
              },
            }),
          );
        })
        .catch((error) => {
          failure = error;
        });
      return queue;
    };
    const timer = setInterval(flush, 250);
    timer.unref();
    return {
      events,
      listeners,
      get closed() {
        return closed;
      },
      emit(event) {
        const saved = { ...event, sequence: events.length + 1 };
        events.push(saved);
        pending.push(saved);
        bytes += JSON.stringify(saved).length;
        if (bytes >= 32768) flush();
        for (const listener of listeners) listener(saved);
      },
      check() {
        if (failure) throw failure;
      },
      async close() {
        clearInterval(timer);
        await flush();
        await update(
          requestKey(sub, requestId),
          expression({ set: { progressClosed: true } }),
        );
        closed = true;
        for (const listener of listeners) listener(null);
      },
    };
  }

  // Starts a turn, or returns the existing one for a repeated request id.
  async function start(chat, input, identity, workloadToken) {
    if (!patterns.id.test(input.requestId || "")) fail("VALIDATION_FAILED");
    const print = fingerprint(input);
    const existing = async () => {
      const prior = await get(requestKey(identity.sub, input.requestId));
      if (!prior) return null;
      if (prior.inputFingerprint !== print) fail("REQUEST_ID_CONFLICT");
      return state(identity, input.requestId);
    };
    const prior = await existing();
    if (prior) return prior;
    const taskKey = `${identity.sub}/${input.requestId}`;
    if (tasks.has(taskKey)) {
      if (tasks.get(taskKey).fingerprint !== print) fail("REQUEST_ID_CONFLICT");
      return tasks.get(taskKey).ready;
    }
    let accepted, rejected;
    const ready = new Promise((resolve, reject) => {
      accepted = resolve;
      rejected = reject;
    });
    const task = { ready, fingerprint: print, progress: null };
    tasks.set(taskKey, task);
    let heartbeat;
    const run = {
      // Called by the turn once its inputs are valid; rejects the turn with a
      // precise code if admission fails, retrying once after reclaiming a
      // leftover lock or run slot.
      async accept(request, admission) {
        const row = { ...request, inputFingerprint: print };
        try {
          await admit(identity, row, admission);
        } catch (error) {
          if (
            !["BRANCH_BUSY", "RUN_LIMIT"].includes(error.code) ||
            !(await reclaim(identity, row, error.code))
          )
            throw error;
          await admit(identity, row, admission);
        }
        task.progress = progress(identity.sub, input.requestId);
        heartbeat = setInterval(
          () =>
            update(
              requestKey(identity.sub, input.requestId),
              expression({
                set: { heartbeatAt: new Date().toISOString() },
                condition: "#workerId = :worker AND #status = :running",
                values: { ":worker": workerId(), ":running": "running" },
              }),
            ).catch(() => {}),
          heartbeatMs,
        );
        heartbeat.unref();
        task.progress.emit({ type: "message.accepted", message: input.message });
        accepted({
          requestId: input.requestId,
          status: "running",
          conversationId: request.conversationId,
          branchId: request.branchId,
        });
      },
      emit: (event) => task.progress?.emit(event),
      // Before every model or tool step: stop on cancellation, a lost or
      // finished request, revoked access, or failed progress persistence.
      async guard() {
        task.progress?.check();
        const [row, authorized] = await Promise.all([
          get(requestKey(identity.sub, input.requestId)),
          stillAuthorized(identity),
        ]);
        if (row?.cancelRequested) fail("CANCELLED");
        if (!row || terminal(row.status)) fail("OUTCOME_UNKNOWN");
        if (!authorized) fail("ACCESS_REVOKED");
      },
    };
    (async () => {
      try {
        await chat(input, identity, run, workloadToken);
      } catch (error) {
        rejected(error);
      } finally {
        clearInterval(heartbeat);
        if (task.progress) {
          await task.progress.close().catch(() => {});
          const row = await get(requestKey(identity.sub, input.requestId));
          await release(identity.sub, row).catch(() =>
            console.error("Could not release run"),
          );
        }
        tasks.delete(taskKey);
      }
    })();
    try {
      return await ready;
    } catch (error) {
      if (error.code !== "DUPLICATE_REQUEST") throw error;
      const raced = await existing();
      if (!raced) fail("BRANCH_BUSY");
      return raced;
    }
  }

  // Streams a run's events after `after`, from memory when the run is on this
  // worker, else from its S3 chunks. Ends with a run.status event; a stream that
  // ends without a terminal status means "reconnect".
  async function watch(identity, input, response, { untilTerminal = false } = {}) {
    let after = input.after ?? 0;
    if (!Number.isSafeInteger(after) || after < 0) fail("VALIDATION_FAILED");
    let current = await state(identity, input.requestId);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
    });
    const write = (event) => {
      if (event.sequence > after) {
        response.write(`data: ${JSON.stringify(event)}\n\n`);
        after = event.sequence;
      }
    };
    const deadline = untilTerminal ? Infinity : Date.now() + 25000;
    const task = tasks.get(`${identity.sub}/${input.requestId}`);
    if (task?.progress) {
      const live = task.progress;
      for (const event of live.events) write(event);
      if (!live.closed)
        await new Promise((resolve) => {
          const done = () => {
            clearTimeout(timer);
            live.listeners.delete(listener);
            resolve();
          };
          const listener = (event) => (event ? write(event) : done());
          const timer = setTimeout(done, untilTerminal ? 600000 : 25000);
          live.listeners.add(listener);
          response.on("close", done);
        });
      current = await state(identity, input.requestId);
    } else {
      let chunk = 0;
      while (!response.destroyed) {
        for (; chunk < current.progressChunks; chunk++) {
          const stored = await s3.send(
            new GetObjectCommand({
              Bucket: bucket(),
              Key: progressLocation(identity.sub, input.requestId, chunk),
            }),
          );
          for (const event of JSON.parse(await stored.Body.transformToString()))
            write(event);
        }
        if (
          (terminal(current.status) && current.progressClosed) ||
          Date.now() >= deadline
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 250));
        current = await state(identity, input.requestId);
      }
    }
    // The status snapshot carries no sequence of its own: it is not progress.
    const { sequence, ...status } = current;
    response.write(`data: ${JSON.stringify({ type: "run.status", ...status })}\n\n`);
    response.end();
  }

  async function cancel(identity, input) {
    const current = await state(identity, input.requestId);
    if (!terminal(current.status))
      await update(
        requestKey(identity.sub, input.requestId),
        expression({ set: { cancelRequested: true } }),
      );
    return { ...current, cancelRequested: true };
  }

  return { start, state, watch, cancel, busy: () => tasks.size > 0 };
}
