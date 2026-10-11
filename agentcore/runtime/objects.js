// Files, skills and artifacts: a row per object in its project, bytes in S3.
// Uploads stage under pending/, then are copied into place and counted
// against the owner's storage in the same transaction that activates them.
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { storage } from "./accounts.js";
import { s3 } from "./aws.js";
import {
  attempt,
  decodeCursor,
  encodeCursor,
  expression,
  fail,
  get,
  pack,
  patterns,
  put,
  query,
  sk,
  transact,
  userKey,
  userPk,
  uuid,
} from "./db.js";
import { projectOf } from "./projects.js";

const bucket = () => process.env.BUCKET;
export const objectLocation = (sub, projectId, id) =>
  `users/${sub}/${projectId}/files/${id}`;
const stagingLocation = (sub, id) => `pending/${sub}/${id}`;
const kinds = ["file", "skill", "artifact"];
const contentTypePattern = /^[\w.+-]+\/[\w.+-]+$/;
const maxUploadBytes = 5000000000;
const maxSkillBytes = 50000;

export const objectView = ({
  id,
  projectId,
  name,
  kind,
  contentType,
  sizeBytes,
  createdAt,
  status,
}) => ({ id, projectId, name, kind, contentType, sizeBytes, createdAt, status });

export const objectKey = (sub, projectId, id) =>
  userKey(sub, sk.object(projectId, id));
const storageDelta = (sub, bytes) => ({
  Update: {
    Key: userKey(sub, sk.profile),
    ...expression({ add: { storageUsedBytes: bytes } }),
  },
});
export const validName = (name) =>
  typeof name === "string" &&
  name.trim() &&
  name.length <= 180 &&
  !/[\r\n\0]/.test(name);
export const validContentType = (type) =>
  typeof type === "string" && contentTypePattern.test(type);

// Copies are idempotent, so a crash between copy and activation is repaired by
// finding the copied bytes and activating them.
async function activate(sub, item, sizeBytes, versionId) {
  const location = objectLocation(sub, item.projectId, item.id);
  const activated = await attempt(
    transact([
      {
        Update: {
          Key: objectKey(sub, item.projectId, item.id),
          ...expression({
            set: {
              status: "ACTIVE",
              key: location,
              sizeBytes,
              versionId: versionId || "",
            },
            remove: ["stageKey", "expiresAt"],
            condition: "#status = :pending",
            values: { ":pending": "PENDING" },
          }),
        },
      },
      storageDelta(sub, sizeBytes),
    ]),
  );
  const latest = activated
    ? null
    : await get(objectKey(sub, item.projectId, item.id));
  if (!activated && latest?.status !== "ACTIVE")
    fail("UPLOAD_OUTCOME_UNKNOWN");
  return (
    latest || {
      ...item,
      key: location,
      status: "ACTIVE",
      sizeBytes,
      versionId: versionId || "",
    }
  );
}

export async function repairPending(sub, item) {
  if (item.status !== "PENDING") return item;
  const location = objectLocation(sub, item.projectId, item.id);
  // The role lists only users/ prefixes; exact-key listing distinguishes a
  // missing copy from AccessDenied without broad enumeration.
  const listed = await s3.send(
    new ListObjectsV2Command({ Bucket: bucket(), Prefix: location, MaxKeys: 1 }),
  );
  if (!listed.Contents?.some((entry) => entry.Key === location)) return item;
  const head = await s3.send(
    new HeadObjectCommand({ Bucket: bucket(), Key: location }),
  );
  if (
    !Number.isSafeInteger(head.ContentLength) ||
    head.ContentLength > item.declaredBytes
  )
    return item;
  return activate(sub, item, head.ContentLength, head.VersionId);
}

export async function completeStaged(sub, item, expectedBytes = null) {
  const repaired = await repairPending(sub, item);
  if (repaired.status === "ACTIVE") return repaired;
  const head = await s3
    .send(new HeadObjectCommand({ Bucket: bucket(), Key: item.stageKey }))
    .catch((error) => {
      if (error.$metadata?.httpStatusCode === 404) fail("UPLOAD_MISSING");
      throw error;
    });
  const size = head.ContentLength;
  if (
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > item.declaredBytes ||
    (expectedBytes !== null && size !== expectedBytes)
  )
    fail("UPLOAD_SIZE_MISMATCH");
  const current = await storage(sub);
  if (current.usedBytes + size > current.limitBytes) fail("QUOTA_EXCEEDED");
  const copy = await s3.send(
    new CopyObjectCommand({
      Bucket: bucket(),
      Key: objectLocation(sub, item.projectId, item.id),
      CopySource: `${bucket()}/${item.stageKey}`,
      MetadataDirective: "REPLACE",
      ContentType: item.contentType,
    }),
  );
  const saved = await activate(sub, item, size, copy.VersionId);
  await s3
    .send(
      new DeleteObjectCommand({
        Bucket: bucket(),
        Key: item.stageKey,
        ...(head.VersionId && { VersionId: head.VersionId }),
      }),
    )
    .catch(() => console.error("Could not remove completed staging object"));
  return saved;
}

// A presigned POST for one staging key, limited to the declared size.
export const presignUpload = (stageKey, contentType, bytes) =>
  createPresignedPost(s3, {
    Bucket: bucket(),
    Key: stageKey,
    Expires: 300,
    Fields: { "Content-Type": contentType },
    Conditions: [
      { "Content-Type": contentType },
      ["content-length-range", 1, bytes + 16384],
    ],
  });

// Records a pending object; `created` is false if its id already exists.
export async function stage(sub, item) {
  const row = {
    ...item,
    stageKey: stagingLocation(sub, item.id),
    status: "PENDING",
    createdAt: new Date().toISOString(),
    expiresAt: Math.floor(Date.now() / 1000) + 86400,
  };
  const created = await attempt(
    put(
      { ...objectKey(sub, item.projectId, item.id), ...pack(row) },
      { ConditionExpression: "attribute_not_exists(pk)" },
    ),
  );
  return { created, row };
}

export const downloadUrl = (item, seconds = 300) =>
  getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucket(),
      Key: item.key,
      ...(item.versionId && { VersionId: item.versionId }),
    }),
    { expiresIn: seconds },
  );

async function activeObject(sub, projectId, id) {
  if (!patterns.id.test(id || "")) fail("VALIDATION_FAILED");
  const item = await get(objectKey(sub, projectId, id));
  if (!item) fail("NOT_FOUND");
  const current = await repairPending(sub, item);
  if (current.status !== "ACTIVE") fail("NOT_FOUND");
  return current;
}

// Selected objects for a turn: files the code workspace may download, and
// skills whose text joins the agent's instructions.
export async function turnFiles(sub, projectId, ids) {
  const items = await Promise.all(
    ids.map((id) => get(objectKey(sub, projectId, id))),
  );
  if (
    items.some(
      (item) =>
        item?.status !== "ACTIVE" || !["file", "artifact"].includes(item.kind),
    )
  )
    fail("FILE_UNAVAILABLE");
  return items.map(({ id, name, sizeBytes, key, versionId }) => ({
    id,
    name,
    sizeBytes,
    key,
    versionId,
  }));
}
export const isUsableSkill = (item) =>
  item?.kind === "skill" &&
  item.status === "ACTIVE" &&
  item.sizeBytes <= maxSkillBytes;
export async function skillTexts(sub, projectId, ids) {
  const items = await Promise.all(
    ids.map((id) => get(objectKey(sub, projectId, id))),
  );
  if (!items.every(isUsableSkill)) fail("SKILL_UNAVAILABLE");
  return Promise.all(
    items.map(async (item) => {
      const object = await s3.send(
        new GetObjectCommand({
          Bucket: bucket(),
          Key: item.key,
          ...(item.versionId && { VersionId: item.versionId }),
        }),
      );
      const text = await object.Body.transformToString("utf-8");
      if (text.length > maxSkillBytes || text.includes("\0"))
        fail("SKILL_UNAVAILABLE");
      return { id: item.id, name: item.name, text };
    }),
  );
}

export const objectCommands = {
  "objects.beginUpload": {
    write: true,
    run: async (input, identity) => {
      const projectId = await projectOf(identity, input);
      const {
        name,
        contentType = "application/octet-stream",
        sizeBytes,
        kind = "file",
      } = input;
      if (
        !validName(name) ||
        !kinds.includes(kind) ||
        !validContentType(contentType) ||
        !Number.isSafeInteger(sizeBytes) ||
        sizeBytes < 1 ||
        sizeBytes > maxUploadBytes
      )
        fail("VALIDATION_FAILED");
      const current = await storage(identity.sub);
      if (current.usedBytes + sizeBytes > current.limitBytes)
        fail("QUOTA_EXCEEDED");
      const { row } = await stage(identity.sub, {
        id: uuid(),
        projectId,
        name: name.trim(),
        kind,
        contentType,
        declaredBytes: sizeBytes,
      });
      return {
        id: row.id,
        upload: await presignUpload(row.stageKey, contentType, sizeBytes),
        expiresInSeconds: 300,
      };
    },
  },
  "objects.completeUpload": {
    write: true,
    run: async (input, identity) => {
      const projectId = await projectOf(identity, input);
      if (!patterns.id.test(input.id || "")) fail("VALIDATION_FAILED");
      const item = await get(objectKey(identity.sub, projectId, input.id));
      if (!item) fail("NOT_FOUND");
      if (item.status === "ACTIVE") return { item: objectView(item) };
      if (item.expiresAt <= Date.now() / 1000) fail("NOT_FOUND");
      return { item: objectView(await completeStaged(identity.sub, item)) };
    },
  },
  "objects.list": {
    run: async (input, identity) => {
      const projectId = await projectOf(identity, input);
      const prefix = sk.object(projectId);
      const cursor = decodeCursor(
        input.cursor,
        (start) =>
          start.pk?.S === userPk(identity.sub) &&
          start.sk?.S?.startsWith(prefix),
      );
      const [page, current] = await Promise.all([
        query({
          pk: userPk(identity.sub),
          prefix,
          cursor,
          limit: 50,
          filter: {
            expression: "#status = :active",
            names: { "#status": "status" },
            values: { ":active": "ACTIVE" },
          },
        }),
        storage(identity.sub),
      ]);
      return {
        items: page.items.map(objectView),
        ...current,
        nextCursor: encodeCursor(page.next),
      };
    },
  },
  "objects.get": {
    run: async (input, identity) => {
      const projectId = await projectOf(identity, input);
      const item = await activeObject(identity.sub, projectId, input.id);
      return { url: await downloadUrl(item), expiresInSeconds: 300 };
    },
  },
  "objects.delete": {
    write: true,
    run: async (input, identity) => {
      const projectId = await projectOf(identity, input);
      const item = await activeObject(identity.sub, projectId, input.id);
      await s3.send(
        new DeleteObjectCommand({
          Bucket: bucket(),
          Key: item.key,
          ...(item.versionId && { VersionId: item.versionId }),
        }),
      );
      // The row and its counted bytes leave together, exactly once.
      await attempt(
        transact([
          {
            Delete: {
              Key: objectKey(identity.sub, projectId, item.id),
              ...expression({
                condition: "#status = :active",
                values: { ":active": "ACTIVE" },
              }),
            },
          },
          storageDelta(identity.sub, -item.sizeBytes),
        ]),
      );
      return { deleted: true };
    },
  },
};
