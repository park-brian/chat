// Private credentials and the connections that use them. Every key is derived
// from the authenticated owner; a reference change and the revision checks of
// both sides commit in one transaction, so deletion races cannot orphan either.
import {
  conditionFailed,
  fail,
  get,
  patterns,
  queryAll,
  sk,
  transact,
  userKey,
  userPk,
  uuid,
} from "./db.js";

const kinds = ["github", "jira"];
const credentialKey = (sub, id) => userKey(sub, sk.credential(id));
const connectionKey = (sub, id) => userKey(sub, sk.connection(id));
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
const revisionOf = (revision) => {
  if (!Number.isSafeInteger(revision) || revision < 0)
    fail("VALIDATION_FAILED");
  return revision;
};
const withoutSecret = ({ secret, ...item }) => item;

// Each record is one JSON document guarded by its revision attribute.
const decode = (row) => (row ? JSON.parse(row.data) : null);
const write = (itemKey, item, expected) => ({
  Put: {
    Item: {
      ...itemKey,
      revision: { N: String(item.revision) },
      data: { S: JSON.stringify(item) },
    },
    ...(expected === null
      ? { ConditionExpression: "attribute_not_exists(pk)" }
      : {
          ConditionExpression: "revision = :revision",
          ExpressionAttributeValues: { ":revision": { N: String(expected) } },
        }),
  },
});
const erase = (itemKey, item) => ({
  Delete: {
    Key: itemKey,
    ConditionExpression: "revision = :revision",
    ExpressionAttributeValues: { ":revision": { N: String(item.revision) } },
  },
});
const commit = async (items) => {
  try {
    await transact(items);
  } catch (error) {
    if (conditionFailed(error)) fail("REVISION_CONFLICT");
    throw error;
  }
};
const list = async (sub, prefix) =>
  (await queryAll({ pk: userPk(sub), prefix })).map(decode);
async function owned(itemKey, id) {
  if (!patterns.id.test(id || "")) fail("VALIDATION_FAILED");
  const item = decode(await get(itemKey));
  if (!item) fail("NOT_FOUND");
  return item;
}
const credentialOf = (sub, id) => owned(credentialKey(sub, id), id);
const connectionOf = (sub, id) => owned(connectionKey(sub, id), id);

export const connectionsOf = (identity) =>
  list(identity.sub, sk.connection());

// Secrets leave this module only for server-side, explicitly granted tools.
export async function resolveConnections(identity, ids) {
  const result = {};
  for (const id of ids) {
    const connection = await connectionOf(identity.sub, id).catch((error) => {
      if (error.code === "NOT_FOUND") fail("CONNECTION_REVOKED");
      throw error;
    });
    const credential = await credentialOf(identity.sub, connection.credentialId);
    result[id] = { ...connection, apiKey: credential.secret };
  }
  return result;
}

function jiraTarget(input) {
  let url;
  try {
    url = new URL(input.jiraUrl);
  } catch {
    fail("VALIDATION_FAILED");
  }
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
  return { jiraUrl: url.origin, jiraEmail: input.jiraEmail };
}

// Checks a connection against its service's "who am I" endpoint. Jira URLs are
// limited to Atlassian Cloud hosts so a user URL can never become an
// authenticated request to an arbitrary server.
async function probe(connection) {
  const jira = connection.kind === "jira";
  const url = jira
    ? new URL("/rest/api/3/myself", connection.jiraUrl).href
    : "https://api.github.com/user";
  if (jira && !/^https:\/\/[a-z0-9-]+\.atlassian\.net\//i.test(url))
    fail("CONNECTION_TEST_UNAVAILABLE");
  try {
    const result = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
      headers: {
        Accept: "application/json",
        Authorization: jira
          ? "Basic " +
            Buffer.from(`${connection.jiraEmail}:${connection.apiKey}`).toString(
              "base64",
            )
          : "Bearer " + connection.apiKey,
        ...(!jira && { "User-Agent": "agentcore-chat-connection-check" }),
      },
    });
    if (result.status !== 200) {
      await result.body?.cancel();
      return { connected: false, account: null, httpStatus: result.status };
    }
    const raw = await result.text();
    if (raw.length > 16384) throw Error("Connection response too large");
    const label = jira ? JSON.parse(raw).displayName : JSON.parse(raw).login;
    return {
      connected: true,
      account: typeof label === "string" ? label.slice(0, 120) : null,
      httpStatus: 200,
    };
  } catch {
    return { connected: false, account: null, httpStatus: null };
  }
}

// Secrets are only ever the caller's own: naming another person is refused,
// not silently ignored.
const ownOnly = (commands) =>
  Object.fromEntries(
    Object.entries(commands).map(([name, command]) => [
      name,
      {
        ...command,
        run: (input, identity, context) => {
          if (input.userSub !== undefined || input.sub !== undefined)
            fail("FORBIDDEN");
          return command.run(input, identity, context);
        },
      },
    ]),
  );

export const credentialCommands = ownOnly({
  "credentials.list": {
    run: async (input, identity) => {
      const [credentials, connections] = await Promise.all([
        list(identity.sub, sk.credential()),
        list(identity.sub, sk.connection()),
      ]);
      return {
        items: credentials.map((item) => ({
          ...withoutSecret(item),
          usedBy: connections
            .filter((connection) => connection.credentialId === item.id)
            .map(({ id, name }) => ({ id, name })),
        })),
      };
    },
  },
  "credentials.put": {
    write: true,
    run: async (input, identity) => {
      const sub = identity.sub;
      if (!input.id) {
        if (!kinds.includes(input.kind)) fail("VALIDATION_FAILED");
        if ((await list(sub, sk.credential())).length >= 100)
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
        await commit([write(credentialKey(sub, item.id), item, null)]);
        return withoutSecret(item);
      }
      const item = await credentialOf(sub, input.id);
      if (item.revision !== revisionOf(input.revision)) fail("REVISION_CONFLICT");
      const renamed = {
        ...item,
        name: nameOf(input.name),
        revision: item.revision + 1,
      };
      await commit([write(credentialKey(sub, item.id), renamed, item.revision)]);
      return withoutSecret(renamed);
    },
  },
  "credentials.rotate": {
    write: true,
    run: async (input, identity) => {
      const item = await credentialOf(identity.sub, input.id);
      if (item.revision !== revisionOf(input.revision)) fail("REVISION_CONFLICT");
      const rotated = {
        ...item,
        secret: secretOf(input.secret),
        revision: item.revision + 1,
      };
      await commit([
        write(credentialKey(identity.sub, item.id), rotated, item.revision),
      ]);
      return withoutSecret(rotated);
    },
  },
  "credentials.delete": {
    write: true,
    run: async (input, identity) => {
      const item = await credentialOf(identity.sub, input.id);
      if (item.revision !== revisionOf(input.revision)) fail("REVISION_CONFLICT");
      if (item.connectionIds.length) fail("CREDENTIAL_IN_USE");
      await commit([erase(credentialKey(identity.sub, item.id), item)]);
      return { deleted: true };
    },
  },
  "connections.list": {
    run: async (input, identity) => ({ items: await connectionsOf(identity) }),
  },
  "connections.put": {
    write: true,
    run: async (input, identity) => {
      const sub = identity.sub;
      if (input.apiKey !== undefined || input.secret !== undefined)
        fail("USE_CREDENTIALS");
      const previous = input.id ? await connectionOf(sub, input.id) : null;
      if (previous && previous.revision !== revisionOf(input.revision))
        fail("REVISION_CONFLICT");
      const credential = await credentialOf(sub, input.credentialId);
      if (credential.kind !== input.kind) fail("CREDENTIAL_KIND_MISMATCH");
      const item = {
        id: previous?.id || uuid(),
        name: nameOf(input.name),
        kind: input.kind,
        credentialId: credential.id,
        revision: previous ? previous.revision + 1 : 0,
        createdAt: previous?.createdAt || new Date().toISOString(),
        ...(input.kind === "jira" && jiraTarget(input)),
      };
      const writes = [
        write(connectionKey(sub, item.id), item, previous?.revision ?? null),
      ];
      if (previous?.credentialId === credential.id)
        writes.push({
          ConditionCheck: {
            Key: credentialKey(sub, credential.id),
            ConditionExpression: "revision = :revision",
            ExpressionAttributeValues: {
              ":revision": { N: String(credential.revision) },
            },
          },
        });
      else {
        writes.push(
          write(
            credentialKey(sub, credential.id),
            {
              ...credential,
              revision: credential.revision + 1,
              connectionIds: [...credential.connectionIds, item.id],
            },
            credential.revision,
          ),
        );
        if (previous) {
          const old = await credentialOf(sub, previous.credentialId);
          writes.push(
            write(
              credentialKey(sub, old.id),
              {
                ...old,
                revision: old.revision + 1,
                connectionIds: old.connectionIds.filter((id) => id !== item.id),
              },
              old.revision,
            ),
          );
        }
      }
      await commit(writes);
      return item;
    },
  },
  "connections.delete": {
    write: true,
    run: async (input, identity) => {
      const sub = identity.sub;
      const previous = await connectionOf(sub, input.id);
      if (previous.revision !== revisionOf(input.revision))
        fail("REVISION_CONFLICT");
      const credential = await credentialOf(sub, previous.credentialId);
      await commit([
        erase(connectionKey(sub, previous.id), previous),
        write(
          credentialKey(sub, credential.id),
          {
            ...credential,
            revision: credential.revision + 1,
            connectionIds: credential.connectionIds.filter(
              (id) => id !== previous.id,
            ),
          },
          credential.revision,
        ),
      ]);
      return { deleted: true };
    },
  },
  "connections.test": {
    write: true,
    run: async (input, identity) => {
      const connection = await connectionOf(identity.sub, input.id);
      const credential = await credentialOf(identity.sub, connection.credentialId);
      return probe({ ...connection, apiKey: credential.secret });
    },
  },
});
