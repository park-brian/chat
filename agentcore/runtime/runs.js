import {
  GetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID, createHash } from "node:crypto";

const S = (value) => ({ S: String(value) });
const N = (value) => ({ N: String(value) });
const key = (sub, id) => ({ pk: S(`USER#${sub}`), sk: S(`REQUEST#${id}`) });
const terminal = (status) => !["running", "memory_written"].includes(status);
const failure = (code) => Object.assign(new Error(code), { code });
const idPattern = /^[0-9a-f-]{36}$/i;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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

// A Runtime task owns execution. HTTP responses are replaceable observers.
// The heartbeat detects lost execution; it never grants permission to replay it.
export function createRuns({ db, s3, table, bucket, currentIdentity }) {
  const workerId = randomUUID();
  const active = new Map();
  const objectKey = (sub, id, suffix) =>
    `users/${sub}/runs/${id}/${suffix}.json`;
  const read = async (sub, id) =>
    (
      await db.send(
        new GetItemCommand({
          TableName: table,
          Key: key(sub, id),
          ConsistentRead: true,
        }),
      )
    ).Item;
  const lockKey = (sub, input) => ({
    pk: S(`PROJECT#${sub}/${input.projectId || "main"}`),
    sk: S(`RUN#${input.sessionId}#${input.branchId || "main"}`),
  });
  async function accept(identity, input, snapshot, requestItem) {
    const id = input.requestId;
    const contextKey = objectKey(identity.sub, id, `context-${randomUUID()}`);
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: contextKey,
        Body: JSON.stringify(snapshot),
        ContentType: "application/json",
        Tagging: "agentcore-retention=run-progress",
      }),
    );
    const now = new Date().toISOString();
    try {
      await db.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Put: {
                TableName: table,
                Item: {
                  ...requestItem,
                  workerId: S(workerId),
                  contextObjectKey: S(contextKey),
                  inputFingerprint: S(fingerprint(input)),
                  heartbeatAt: S(now),
                  progressChunks: N(0),
                  progressSequence: N(0),
                  progressClosed: { BOOL: false },
                  progressExpiresAt: N(
                    Math.floor(Date.now() / 1000) + 7 * 86400,
                  ),
                },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            {
              Put: {
                TableName: table,
                Item: {
                  ...lockKey(identity.sub, input),
                  requestId: S(id),
                  acceptedAt: S(now),
                  branchId: S(input.branchId || "main"),
                },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            {
              Update: {
                TableName: table,
                Key: {
                  pk: S(`PROJECT#${identity.sub}/${input.projectId || "main"}`),
                  sk: S(`CONVERSATION#${input.sessionId}`),
                },
                UpdateExpression:
                  "SET id = if_not_exists(id, :id), agentId = if_not_exists(agentId, :agent), title = if_not_exists(title, :title), createdAt = if_not_exists(createdAt, :time), lastActivityAt = :time, gsi1pk = :index, gsi1sk = :sort, durable = if_not_exists(durable, :durable), #status = if_not_exists(#status, :active) ADD activeRunCount :one",
                ConditionExpression:
                  "(attribute_not_exists(agentId) OR agentId = :agent) AND (attribute_not_exists(#status) OR #status = :active)" +
                  (input.forkEventId !== undefined
                    ? " AND attribute_exists(pk)"
                    : (input.branchId || "main") === "main"
                      ? " AND " +
                        (snapshot.observedHead
                          ? "mainHeadEventId = :observed"
                          : "attribute_not_exists(mainHeadEventId)")
                      : ""),
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":id": S(input.sessionId),
                  ":agent": S(input.agentId),
                  ":title": S(
                    input.message.trim().replace(/\s+/g, " ").slice(0, 80),
                  ),
                  ":time": S(now),
                  ":index": S(
                    `CONVERSATIONS#${identity.sub}/${input.projectId || "main"}`,
                  ),
                  ":sort": S(`${now}#${input.sessionId}`),
                  ":durable": requestItem.durable,
                  ":active": S("ACTIVE"),
                  ":one": N(1),
                  ...(input.forkEventId === undefined &&
                    (input.branchId || "main") === "main" &&
                    snapshot.observedHead && {
                      ":observed": S(snapshot.observedHead),
                    }),
                },
              },
            },
            ...(input.forkEventId === undefined &&
            input.branchId &&
            input.branchId !== "main"
              ? [
                  {
                    ConditionCheck: {
                      TableName: table,
                      Key: {
                        pk: S(
                          `PROJECT#${identity.sub}/${input.projectId || "main"}`,
                        ),
                        sk: S(`BRANCH#${input.sessionId}#${input.branchId}`),
                      },
                      ConditionExpression: "headEventId = :observed",
                      ExpressionAttributeValues: {
                        ":observed": S(snapshot.observedHead),
                      },
                    },
                  },
                ]
              : []),
          ],
        }),
      );
    } catch (error) {
      if (error.name === "TransactionCanceledException")
        throw failure("BRANCH_BUSY_OR_DUPLICATE");
      throw error;
    }
  }
  async function release(sub, input) {
    try {
      await db.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Delete: {
                TableName: table,
                Key: lockKey(sub, input),
                ConditionExpression: "requestId = :request",
                ExpressionAttributeValues: { ":request": S(input.requestId) },
              },
            },
            {
              Update: {
                TableName: table,
                Key: {
                  pk: S(`PROJECT#${sub}/${input.projectId || "main"}`),
                  sk: S(`CONVERSATION#${input.sessionId}`),
                },
                UpdateExpression: "ADD activeRunCount :minus",
                ConditionExpression: "activeRunCount > :zero",
                ExpressionAttributeValues: { ":minus": N(-1), ":zero": N(0) },
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (error.name !== "TransactionCanceledException") throw error;
    }
  }
  async function state(identity, input) {
    if (!idPattern.test(input.requestId || ""))
      throw failure("VALIDATION_FAILED");
    const row = await read(identity.sub, input.requestId);
    if (!row) throw failure("NOT_FOUND");
    if (
      !terminal(row.status.S) &&
      Date.now() - Date.parse(row.heartbeatAt?.S || row.acceptedAt.S) >
        (row.heartbeatAt ? 90000 : 3600000)
    ) {
      try {
        await db.send(
          new UpdateItemCommand({
            TableName: table,
            Key: key(identity.sub, input.requestId),
            UpdateExpression: "SET #status = :unknown, failureStage = :stage",
            ConditionExpression:
              "(attribute_not_exists(heartbeatAt) OR heartbeatAt = :observed) AND (#status = :running OR #status = :written)",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":unknown": S("outcome_unknown"),
              ":stage": S("runtime_lost"),
              ":observed": row.heartbeatAt || row.acceptedAt,
              ":running": S("running"),
              ":written": S("memory_written"),
            },
          }),
        );
        row.status = S("outcome_unknown");
        await release(identity.sub, {
          requestId: input.requestId,
          projectId: row.projectId.S,
          sessionId: row.conversationId.S,
          branchId: row.branchId.S,
        });
      } catch (error) {
        if (error.name !== "ConditionalCheckFailedException") throw error;
        return state(identity, input);
      }
    }
    if (terminal(row.status.S))
      await release(identity.sub, {
        requestId: input.requestId,
        projectId: row.projectId.S,
        sessionId: row.conversationId.S,
        branchId: row.branchId.S,
      });
    return {
      requestId: input.requestId,
      status: row.status.S,
      projectId: row.projectId.S,
      conversationId: row.conversationId.S,
      agentId: row.agentId.S,
      branchId: row.branchId.S,
      acceptedAt: row.acceptedAt.S,
      costMicroUsd: Number(row.costMicroUsd?.N || 0),
      progressChunks: Number(row.progressChunks?.N || 0),
      sequence: Number(row.progressSequence?.N || 0),
      eventId: row.eventId?.S || null,
      cancelRequested: row.cancelRequested?.BOOL === true,
      sourceBranchId: row.sourceBranchId?.S,
      forkEventId: row.forkEventId?.S || null,
      progressExpired:
        Date.now() / 1000 >= Number(row.progressExpiresAt?.N || Infinity),
      progressClosed:
        row.progressClosed?.BOOL !== false ||
        Date.now() - Date.parse(row.heartbeatAt?.S || row.acceptedAt.S) >=
          90000,
    };
  }
  async function guard(identity, id) {
    const row = await read(identity.sub, id);
    if (row?.cancelRequested?.BOOL) throw failure("CANCELLED");
    if (!row || terminal(row.status.S)) throw failure("OUTCOME_UNKNOWN");
    if (!(await currentIdentity(identity))) throw failure("ACCESS_REVOKED");
  }
  function taskResponse(identity, input, ready) {
    let events = [],
      bytes = 0,
      sequence = 0,
      chunks = 0,
      queue = Promise.resolve(),
      persistenceError;
    const flush = () => {
      if (!events.length) return queue;
      const batch = events;
      events = [];
      bytes = 0;
      const chunk = chunks++;
      if (chunk >= 1024) {
        persistenceError = failure("PROGRESS_LIMIT");
        return queue;
      }
      queue = queue
        .then(async () => {
          await s3.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: objectKey(
                identity.sub,
                input.requestId,
                `progress-${chunk}`,
              ),
              Body: JSON.stringify(batch),
              ContentType: "application/json",
              Tagging: "agentcore-retention=run-progress",
            }),
          );
          await db.send(
            new UpdateItemCommand({
              TableName: table,
              Key: key(identity.sub, input.requestId),
              UpdateExpression:
                "SET progressChunks = :chunks, progressSequence = :sequence",
              ExpressionAttributeValues: {
                ":chunks": N(chunk + 1),
                ":sequence": N(batch.at(-1).sequence),
              },
            }),
          );
        })
        .catch((error) => {
          persistenceError = error;
        });
      return queue;
    };
    const timer = setInterval(flush, 250);
    timer.unref();
    let accepted = false,
      rejection;
    return {
      async accept(snapshot, item) {
        await accept(identity, input, snapshot, item);
        accepted = true;
        this.write(
          `data: ${JSON.stringify({ type: "message.accepted", message: input.message })}\n\n`,
        );
        ready({
          requestId: input.requestId,
          status: "running",
          conversationId: input.sessionId,
          branchId: input.branchId || "main",
        });
      },
      async guard() {
        if (persistenceError) throw persistenceError;
        await guard(identity, input.requestId);
      },
      writeHead() {},
      write(text) {
        for (const match of text.matchAll(/^data: (.+)$/gm)) {
          const event = JSON.parse(match[1]);
          if (!accepted) {
            rejection = failure(event.code || "VALIDATION_FAILED");
            continue;
          }
          const saved = { ...event, sequence: ++sequence };
          events.push(saved);
          bytes += Buffer.byteLength(JSON.stringify(saved));
          if (bytes >= 32768) flush();
        }
      },
      end(text) {
        if (text) this.write(text);
      },
      async close() {
        clearInterval(timer);
        await flush();
        if (accepted) {
          await db.send(
            new UpdateItemCommand({
              TableName: table,
              Key: key(identity.sub, input.requestId),
              UpdateExpression: "SET progressClosed = :yes",
              ExpressionAttributeValues: { ":yes": { BOOL: true } },
            }),
          );
          await release(identity.sub, input);
        }
        if (!accepted) throw rejection || failure("CHAT_REJECTED");
      },
      get accepted() {
        return accepted;
      },
    };
  }
  async function start(chat, input, identity, workloadToken) {
    if (!idPattern.test(input.requestId || ""))
      throw failure("VALIDATION_FAILED");
    const prior = await read(identity.sub, input.requestId);
    if (prior) {
      if (
        prior.inputFingerprint &&
        prior.inputFingerprint.S !== fingerprint(input)
      )
        throw failure("REQUEST_ID_CONFLICT");
      return state(identity, input);
    }
    const activeKey = `${identity.sub}/${input.requestId}`;
    if (active.has(activeKey)) {
      if (active.get(activeKey).fingerprint !== fingerprint(input))
        throw failure("REQUEST_ID_CONFLICT");
      return active.get(activeKey).ready;
    }
    let resolve, reject;
    const ready = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const response = taskResponse(identity, input, resolve);
    const task = { ready, fingerprint: fingerprint(input) };
    active.set(activeKey, task);
    task.execution = (async () => {
      let heartbeat;
      try {
        const work = chat(input, identity, response, workloadToken);
        ready.then(
          () => {
            heartbeat = setInterval(
              () =>
                db
                  .send(
                    new UpdateItemCommand({
                      TableName: table,
                      Key: key(identity.sub, input.requestId),
                      UpdateExpression: "SET heartbeatAt = :now",
                      ConditionExpression:
                        "workerId = :worker AND (#status = :running OR #status = :written)",
                      ExpressionAttributeNames: { "#status": "status" },
                      ExpressionAttributeValues: {
                        ":now": S(new Date().toISOString()),
                        ":worker": S(workerId),
                        ":running": S("running"),
                        ":written": S("memory_written"),
                      },
                    }),
                  )
                  .catch(() => {}),
              15000,
            );
            heartbeat.unref();
          },
          () => {},
        );
        await work;
      } catch (error) {
        reject(error);
      } finally {
        clearInterval(heartbeat);
        try {
          await response.close();
        } catch (error) {
          reject(error);
        }
        active.delete(activeKey);
      }
    })();
    try {
      return await ready;
    } catch (error) {
      if (error.code !== "BRANCH_BUSY_OR_DUPLICATE") throw error;
      const existing = await read(identity.sub, input.requestId);
      if (!existing) throw failure("BRANCH_BUSY");
      if (existing.inputFingerprint?.S !== fingerprint(input))
        throw failure("REQUEST_ID_CONFLICT");
      return state(identity, input);
    }
  }
  async function watch(
    identity,
    input,
    response,
    { untilTerminal = false } = {},
  ) {
    let after = input.after ?? 0;
    if (!Number.isSafeInteger(after) || after < 0)
      throw failure("VALIDATION_FAILED");
    let current = await state(identity, input),
      chunk = 0;
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
    });
    const deadline = untilTerminal ? Infinity : Date.now() + 25000;
    while (!response.destroyed) {
      for (
        ;
        !current.progressExpired && chunk < current.progressChunks;
        chunk++
      ) {
        const stored = await s3.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: objectKey(identity.sub, input.requestId, `progress-${chunk}`),
          }),
        );
        for (const event of JSON.parse(await stored.Body.transformToString()))
          if (event.sequence > after) {
            response.write(`data: ${JSON.stringify(event)}\n\n`);
            after = event.sequence;
          }
      }
      if (
        (terminal(current.status) &&
          (current.progressClosed || current.progressExpired)) ||
        Date.now() >= deadline
      ) {
        response.write(
          `data: ${JSON.stringify({ type: "run.status", ...current })}\n\n`,
        );
        break;
      }
      await sleep(250);
      current = await state(identity, input);
    }
    response.end();
  }
  async function cancel(identity, input) {
    if (identity.role === "Auditors") throw failure("FORBIDDEN");
    const current = await state(identity, input);
    if (!terminal(current.status)) {
      await db.send(
        new UpdateItemCommand({
          TableName: table,
          Key: key(identity.sub, input.requestId),
          UpdateExpression: "SET cancelRequested = :yes",
          ExpressionAttributeValues: { ":yes": { BOOL: true } },
        }),
      );
    }
    return { ...current, cancelRequested: true };
  }
  async function activeFor(identity, projectId, conversationId) {
    const page = await db.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ConsistentRead: true,
        ExpressionAttributeValues: {
          ":pk": S(`PROJECT#${identity.sub}/${projectId}`),
          ":prefix": S(`RUN#${conversationId}#`),
        },
      }),
    );
    return Promise.all(
      (page.Items || []).map((row) =>
        state(identity, { requestId: row.requestId.S }),
      ),
    );
  }
  return {
    start,
    state,
    watch,
    cancel,
    activeFor,
    busy: () => active.size > 0,
  };
}
