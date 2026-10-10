import {
  GetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";

const S = (value) => ({ S: String(value) });
const N = (value) => ({ N: String(value) });
const key = (sub, type, id = "") => ({
  pk: S(`USER#${sub}`),
  sk: S(type + id),
});
export class ResourceError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const fail = (code) => {
  throw new ResourceError(code);
};
const conflict = (error) =>
  ["TransactionCanceledException", "ConditionalCheckFailedException"].includes(
    error.name,
  );
const validId = (id) => /^[0-9a-f-]{36}$/i.test(id || "");
const nameOf = (name) => {
  if (typeof name !== "string" || !name.trim() || name.length > 80)
    fail("VALIDATION_FAILED");
  return name.trim();
};
const secretOf = (secret) => {
  if (
    typeof secret !== "string" ||
    !secret ||
    secret.length > 4096 ||
    /[\r\n\0]/.test(secret)
  )
    fail("VALIDATION_FAILED");
  return secret;
};
const decode = (row) => (row ? JSON.parse(row.data.S) : null);
const publicCredential = ({ secret, ...item }) => item;

// All keys are derived from the authenticated owner. Reference changes and their
// credential revision checks share one transaction, including deletion races.
export function createCredentials({ db, table, uuid }) {
  const get = async (sub, type, id) =>
    decode(
      (
        await db.send(
          new GetItemCommand({
            TableName: table,
            Key: key(sub, type, id),
            ConsistentRead: true,
          }),
        )
      ).Item,
    );
  const put = (sub, type, item, expected) => ({
    Put: {
      TableName: table,
      Item: {
        ...key(sub, type, item.id),
        revision: N(item.revision),
        data: S(JSON.stringify(item)),
      },
      ConditionExpression:
        expected === null ? "attribute_not_exists(pk)" : "revision = :revision",
      ...(expected !== null && {
        ExpressionAttributeValues: { ":revision": N(expected) },
      }),
    },
  });
  const remove = (sub, type, item) => ({
    Delete: {
      TableName: table,
      Key: key(sub, type, item.id),
      ConditionExpression: "revision = :revision",
      ExpressionAttributeValues: { ":revision": N(item.revision) },
    },
  });
  const transact = async (items) => {
    try {
      await db.send(new TransactWriteItemsCommand({ TransactItems: items }));
    } catch (error) {
      if (conflict(error)) fail("REVISION_CONFLICT");
      throw error;
    }
  };
  async function migrate(sub) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const legacyKey = key(sub, "CREDENTIALS");
      const row = (
        await db.send(
          new GetItemCommand({
            TableName: table,
            Key: legacyKey,
            ConsistentRead: true,
          }),
        )
      ).Item;
      if (!row || row.migrated?.BOOL) return;
      const revision = Number(row.revision?.N || 0);
      const records = Object.values(JSON.parse(row.connectionsJson?.S || "{}"));
      const writes = records.flatMap(({ apiKey, ...connection }) => [
        put(
          sub,
          "CREDENTIAL#",
          {
            id: connection.id,
            name: connection.name,
            kind: connection.kind,
            secret: apiKey,
            revision: 0,
            createdAt: connection.createdAt,
            connectionIds: [connection.id],
          },
          null,
        ),
        put(
          sub,
          "CONNECTION#",
          { ...connection, credentialId: connection.id, revision: 0 },
          null,
        ),
      ]);
      writes.push({
        Put: {
          TableName: table,
          Item: {
            ...legacyKey,
            revision: N(revision + 1),
            migrated: { BOOL: true },
          },
          ConditionExpression: "revision = :revision",
          ExpressionAttributeValues: { ":revision": N(revision) },
        },
      });
      try {
        await transact(writes);
        return;
      } catch (error) {
        if (error.code !== "REVISION_CONFLICT" || attempt === 3) throw error;
      }
    }
  }
  async function list(sub, type) {
    await migrate(sub);
    const items = [];
    let cursor;
    do {
      const page = await db.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: {
            ":pk": S(`USER#${sub}`),
            ":prefix": S(type),
          },
          ConsistentRead: true,
          ExclusiveStartKey: cursor,
        }),
      );
      items.push(...(page.Items || []).map(decode));
      cursor = page.LastEvaluatedKey;
    } while (cursor);
    return items;
  }
  const owned = async (sub, type, id) => {
    if (!validId(id)) fail("VALIDATION_FAILED");
    const item = await get(sub, type, id);
    if (!item) fail("NOT_FOUND");
    return item;
  };
  const checkRevision = (item, revision) => {
    if (!Number.isSafeInteger(revision) || revision < 0)
      fail("VALIDATION_FAILED");
    if (item.revision !== revision) fail("REVISION_CONFLICT");
  };
  async function command(command, identity, input) {
    const sub = identity.sub;
    if (input.userSub !== undefined || input.sub !== undefined)
      fail("FORBIDDEN");
    if (command.endsWith(".list")) {
      if (command === "connections.list")
        return { items: await list(sub, "CONNECTION#") };
      const [credentials, connections] = await Promise.all([
        list(sub, "CREDENTIAL#"),
        list(sub, "CONNECTION#"),
      ]);
      return {
        items: credentials.map((item) => ({
          ...publicCredential(item),
          usedBy: connections
            .filter((connection) => connection.credentialId === item.id)
            .map(({ id, name }) => ({ id, name })),
        })),
      };
    }
    if (identity.role === "Auditors") fail("FORBIDDEN");
    await migrate(sub);
    if (command.startsWith("credentials.")) {
      if (command === "credentials.put" && !input.id) {
        if (!["github", "jira"].includes(input.kind)) fail("VALIDATION_FAILED");
        if ((await list(sub, "CREDENTIAL#")).length >= 100)
          fail("CREDENTIAL_LIMIT");
        const item = {
          id: uuid(),
          name: nameOf(input.name),
          kind: input.kind,
          secret: secretOf(input.secret),
          revision: 0,
          createdAt: new Date().toISOString(),
          connectionIds: [],
        };
        await transact([put(sub, "CREDENTIAL#", item, null)]);
        return publicCredential(item);
      }
      const item = await owned(sub, "CREDENTIAL#", input.id);
      checkRevision(item, input.revision);
      if (command === "credentials.delete") {
        if (item.connectionIds.length) fail("CREDENTIAL_IN_USE");
        await transact([remove(sub, "CREDENTIAL#", item)]);
        return { deleted: true };
      }
      if (command === "credentials.put") item.name = nameOf(input.name);
      else if (command === "credentials.rotate")
        item.secret = secretOf(input.secret);
      else fail("NOT_IMPLEMENTED");
      item.revision++;
      await transact([put(sub, "CREDENTIAL#", item, input.revision)]);
      return publicCredential(item);
    }
    if (
      command === "connections.rotate" ||
      input.apiKey !== undefined ||
      input.secret !== undefined
    )
      fail("USE_CREDENTIALS");
    const previous = input.id
      ? await owned(sub, "CONNECTION#", input.id)
      : null;
    if (previous) checkRevision(previous, input.revision);
    if (command === "connections.delete") {
      if (!previous) fail("NOT_FOUND");
      const credential = await owned(sub, "CREDENTIAL#", previous.credentialId);
      const updated = {
        ...credential,
        revision: credential.revision + 1,
        connectionIds: credential.connectionIds.filter(
          (id) => id !== previous.id,
        ),
      };
      await transact([
        remove(sub, "CONNECTION#", previous),
        put(sub, "CREDENTIAL#", updated, credential.revision),
      ]);
      return { deleted: true };
    }
    if (command !== "connections.put") fail("NOT_IMPLEMENTED");
    const credential = await owned(sub, "CREDENTIAL#", input.credentialId);
    if (credential.kind !== input.kind) fail("CREDENTIAL_KIND_MISMATCH");
    let jiraUrl;
    if (input.kind === "jira") {
      try {
        const url = new URL(input.jiraUrl);
        if (
          url.protocol !== "https:" ||
          url.port ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          !/^[a-z0-9-]+\.atlassian\.net$/i.test(url.hostname) ||
          !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.jiraEmail || "")
        )
          fail("VALIDATION_FAILED");
        jiraUrl = url.origin;
      } catch {
        fail("VALIDATION_FAILED");
      }
    }
    const item = {
      id: previous?.id || uuid(),
      name: nameOf(input.name),
      kind: input.kind,
      credentialId: credential.id,
      revision: previous ? previous.revision + 1 : 0,
      createdAt: previous?.createdAt || new Date().toISOString(),
      ...(jiraUrl && { jiraUrl, jiraEmail: input.jiraEmail }),
    };
    const writes = [put(sub, "CONNECTION#", item, previous?.revision ?? null)];
    if (!previous || previous.credentialId !== credential.id) {
      writes.push(
        put(
          sub,
          "CREDENTIAL#",
          {
            ...credential,
            revision: credential.revision + 1,
            connectionIds: [...credential.connectionIds, item.id],
          },
          credential.revision,
        ),
      );
      if (previous) {
        const old = await owned(sub, "CREDENTIAL#", previous.credentialId);
        writes.push(
          put(
            sub,
            "CREDENTIAL#",
            {
              ...old,
              revision: old.revision + 1,
              connectionIds: old.connectionIds.filter((id) => id !== item.id),
            },
            old.revision,
          ),
        );
      }
    } else
      writes.push({
        ConditionCheck: {
          TableName: table,
          Key: key(sub, "CREDENTIAL#", credential.id),
          ConditionExpression: "revision = :revision",
          ExpressionAttributeValues: { ":revision": N(credential.revision) },
        },
      });
    await transact(writes);
    return item;
  }
  // Secrets leave this repository only for server-side, explicitly granted tools.
  async function resolve(identity, ids) {
    await migrate(identity.sub);
    const result = {};
    for (const id of ids) {
      const connection = await owned(identity.sub, "CONNECTION#", id);
      const credential = await owned(
        identity.sub,
        "CREDENTIAL#",
        connection.credentialId,
      );
      result[id] = { ...connection, apiKey: credential.secret };
    }
    return result;
  }
  return {
    command,
    migrate,
    resolve,
    connections: (identity) => list(identity.sub, "CONNECTION#"),
  };
}
