// A conversation is a tree of turns. Each turn row points at its parent and its
// body in S3; a branch names the head of one path. "main" is a branch like any
// other. Turn bodies count toward the owner's storage.
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
} from "@aws-sdk/client-s3";
import { s3 } from "./aws.js";
import {
  attempt,
  chatIndex,
  decodeCursor,
  encodeCursor,
  expression,
  fail,
  get,
  patterns,
  query,
  queryAll,
  remove,
  sk,
  transact,
  update,
  userKey,
  userPk,
} from "./db.js";
import { projectOf } from "./projects.js";

const bucket = () => process.env.BUCKET;
export const chatKey = (sub, projectId, conversationId) =>
  userKey(sub, sk.chat(projectId, conversationId));
export const branchKey = (sub, projectId, conversationId, branchId) =>
  userKey(sub, sk.branch(projectId, conversationId, branchId));
export const turnKey = (sub, projectId, conversationId, id) =>
  userKey(sub, sk.turn(projectId, conversationId, id));
const chatPrefix = (sub, projectId, conversationId) =>
  `users/${sub}/${projectId}/chats/${conversationId}/`;
export const turnLocation = (sub, projectId, conversationId, id) =>
  chatPrefix(sub, projectId, conversationId) + id.replace("#", "-") + ".json";

const conversationView = (row) => ({
  id: row.id,
  agentId: row.agentId,
  title: row.title,
  createdAt: row.createdAt,
  lastActivityAt: row.lastActivityAt,
  activeBranchId: row.activeBranchId || "main",
  running: (row.activeRuns || 0) > 0,
});
const branchView = ({ id, name, headTurnId, rootTurnId, createdAt }) => ({
  id,
  name,
  headTurnId,
  rootTurnId: rootTurnId ?? null,
  createdAt,
});

// The newest `limit` turns of the path ending at `headTurnId`, oldest first,
// with their bodies, plus the turn id to continue from for older ones.
export async function pathTo(sub, projectId, conversationId, headTurnId, limit) {
  if (!headTurnId) return { turns: [], next: null };
  const rows = await queryAll({
    pk: userPk(sub),
    prefix: sk.turn(projectId, conversationId),
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const path = [];
  let cursor = headTurnId;
  while (cursor && path.length < limit) {
    const row = byId.get(cursor);
    if (!row) fail("HISTORY_INCOMPLETE");
    path.push(row);
    cursor = row.parentTurnId;
  }
  const turns = await Promise.all(
    path.reverse().map(async (row) => {
      const object = await s3.send(
        new GetObjectCommand({
          Bucket: bucket(),
          Key: row.objectKey,
          ...(row.versionId && { VersionId: row.versionId }),
        }),
      );
      return { ...row, ...JSON.parse(await object.Body.transformToString()) };
    }),
  );
  return { turns, next: cursor || null };
}

export const turnMessages = (turns) =>
  turns.flatMap((turn) => [
    { turnId: turn.id, role: "user", text: turn.message, status: "complete" },
    {
      turnId: turn.id,
      role: "assistant",
      text: turn.answer,
      status: "complete",
      tools: (turn.tools || []).map(({ name, isError }) => ({ name, isError })),
    },
  ]);

async function branchesOf(sub, projectId, conversationId) {
  const page = await query({
    pk: userPk(sub),
    prefix: sk.branch(projectId, conversationId),
  });
  return page.items
    .map(branchView)
    .sort((a, b) =>
      a.id === "main" ? -1 : b.id === "main" ? 1 : a.createdAt.localeCompare(b.createdAt),
    );
}

// Up to 25 turns, with their bodies and counted bytes. False when none remain.
async function removeTurns(sub, projectId, conversationId) {
  const turns = await query({
    pk: userPk(sub),
    prefix: sk.turn(projectId, conversationId),
    limit: 25,
  });
  if (!turns.items.length) return false;
  await s3.send(
    new DeleteObjectsCommand({
      Bucket: bucket(),
      Delete: {
        Objects: turns.items.map((turn) => ({
          Key: turn.objectKey,
          ...(turn.versionId && { VersionId: turn.versionId }),
        })),
      },
    }),
  );
  await transact([
    ...turns.items.map((turn) => ({
      Delete: { Key: turnKey(sub, projectId, conversationId, turn.id) },
    })),
    {
      Update: {
        Key: userKey(sub, sk.profile),
        ...expression({
          add: {
            storageUsedBytes: -turns.items.reduce(
              (total, turn) => total + turn.sizeBytes,
              0,
            ),
          },
        }),
      },
    },
  ]);
  return true;
}

// Bodies whose turn never committed, and any older versions. False when none.
async function removeLeftoverBodies(sub, projectId, conversationId) {
  const versions = await s3.send(
    new ListObjectVersionsCommand({
      Bucket: bucket(),
      Prefix: chatPrefix(sub, projectId, conversationId),
      MaxKeys: 1000,
    }),
  );
  const leftovers = [
    ...(versions.Versions || []),
    ...(versions.DeleteMarkers || []),
  ].map(({ Key, VersionId }) => ({ Key, VersionId }));
  if (!leftovers.length) return false;
  await s3.send(
    new DeleteObjectsCommand({ Bucket: bucket(), Delete: { Objects: leftovers } }),
  );
  return true;
}

export function conversationCommands(runs) {
  // Runs holding a lock on one of this conversation's branches.
  async function activeRuns(identity, projectId, conversationId) {
    const locks = await query({
      pk: userPk(identity.sub),
      prefix: sk.lock(projectId, conversationId),
    });
    return Promise.all(
      locks.items.map((lock) => runs.state(identity, lock.requestId)),
    );
  }
  async function readChat(identity, input) {
    const projectId = await projectOf(identity, input);
    if (
      !patterns.id.test(input.conversationId || "") ||
      (input.agentId !== undefined && !patterns.id.test(input.agentId))
    )
      fail("VALIDATION_FAILED");
    const chat = await get(chatKey(identity.sub, projectId, input.conversationId));
    if (
      chat &&
      (chat.status === "DELETING" ||
        (input.agentId !== undefined && chat.agentId !== input.agentId))
    )
      fail("NOT_FOUND");
    return { projectId, chat };
  }
  return {
    "conversations.list": {
      run: async (input, identity) => {
        const projectId = await projectOf(identity, input);
        const index = chatIndex(identity.sub, projectId);
        const cursor = decodeCursor(
          input.cursor,
          (start) =>
            start.gsi1pk?.S === index && start.pk?.S === userPk(identity.sub),
        );
        const page = await query({
          pk: index,
          index: "ByTime",
          cursor,
          limit: 30,
          forward: false,
        });
        return {
          items: page.items.map(conversationView),
          nextCursor: encodeCursor(page.next),
        };
      },
    },
    "conversations.get": {
      run: async (input, identity) => {
        const branchId = input.branchId ?? "main";
        if (
          !patterns.branch.test(branchId) ||
          (input.cursor !== undefined && !patterns.turn.test(input.cursor))
        )
          fail("VALIDATION_FAILED");
        const { projectId, chat } = await readChat(identity, input);
        if (!chat) fail("NOT_FOUND");
        const [branches, active] = await Promise.all([
          branchesOf(identity.sub, projectId, input.conversationId),
          activeRuns(identity, projectId, input.conversationId),
        ]);
        // A fork's branch row is written when its first turn commits; until
        // then a running fork is shown as a working alternative.
        for (const run of active)
          if (!branches.some((branch) => branch.id === run.branchId))
            branches.push({
              id: run.branchId,
              name: "Alternative · working",
              headTurnId: run.forkTurnId,
              rootTurnId: run.forkTurnId,
              createdAt: run.acceptedAt,
            });
        const branch = branches.find((item) => item.id === branchId);
        if (!branch) fail("NOT_FOUND");
        const page = await pathTo(
          identity.sub,
          projectId,
          input.conversationId,
          input.cursor || branch.headTurnId,
          50,
        );
        return {
          conversation: conversationView(chat),
          branchId,
          branches,
          activeRequests: active,
          messages: turnMessages(page.turns),
          nextCursor: page.next,
        };
      },
    },
    // Resumable: each call removes a bounded batch and reports `deleting`
    // until nothing of the conversation remains.
    "conversations.delete": {
      write: true,
      run: async (input, identity) => {
        const { projectId, chat } = await readChat(identity, input).catch(
          (error) => {
            if (error.code === "NOT_FOUND") return {};
            throw error;
          },
        );
        if (!chat) return { deleted: true };
        const sub = identity.sub,
          conversationId = input.conversationId,
          key = chatKey(sub, projectId, conversationId);
        if (chat.status !== "DELETING") {
          const marked = await attempt(
            update(
              key,
              expression({
                set: { status: "DELETING" },
                remove: ["gsi1pk", "gsi1sk"],
                condition:
                  "#status = :active AND (attribute_not_exists(#activeRuns) OR #activeRuns = :zero)",
                values: { ":active": "ACTIVE", ":zero": 0 },
              }),
            ),
          );
          if (!marked) {
            const current = await get(key);
            if (!current) return { deleted: true };
            if ((current.activeRuns || 0) > 0) fail("RUN_ACTIVE");
            if (current.status !== "DELETING") fail("REVISION_CONFLICT");
          }
        }
        // Each step removes a bounded batch; a call takes as many steps as
        // its budget allows, so ordinary conversations go in one call.
        for (let step = 0; step < 40; step++) {
          if (await removeTurns(sub, projectId, conversationId)) continue;
          if (await removeLeftoverBodies(sub, projectId, conversationId)) continue;
          const [branches, locks] = await Promise.all([
            query({ pk: userPk(sub), prefix: sk.branch(projectId, conversationId) }),
            query({ pk: userPk(sub), prefix: sk.lock(projectId, conversationId) }),
          ]);
          for (const row of [...branches.items, ...locks.items])
            await remove(userKey(sub, row.sk));
          await attempt(
            remove(
              key,
              expression({
                condition: "#status = :deleting",
                values: { ":deleting": "DELETING" },
              }),
            ),
          );
          return { deleted: true };
        }
        return { deleting: true };
      },
    },
  };
}
