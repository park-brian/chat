import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createCredentials } from "../runtime/credentials.js";

// Adapter fixture enforces atomic conditional transactions, rather than echoing
// writes, so tests observe saved records and losing concurrent operations.
const records = new Map();
const idOf = (key) => key.pk.S + "/" + key.sk.S;
const clone = (value) => structuredClone(value);
let beforeTransaction;
const db = {
  async send(command) {
    const input = command.input;
    if (command.constructor.name === "GetItemCommand")
      return { Item: clone(records.get(idOf(input.Key))) };
    if (command.constructor.name === "QueryCommand")
      return {
        Items: [...records.values()]
          .filter(
            (row) =>
              row.pk.S === input.ExpressionAttributeValues[":pk"].S &&
              row.sk.S.startsWith(input.ExpressionAttributeValues[":prefix"].S),
          )
          .map(clone),
      };
    if (command.constructor.name !== "TransactWriteItemsCommand")
      throw Error("Unexpected adapter operation");
    await beforeTransaction?.();
    beforeTransaction = null;
    for (const entry of input.TransactItems) {
      const operation = entry.Put || entry.Delete || entry.ConditionCheck,
        existing = records.get(idOf(operation.Key || operation.Item));
      if (
        operation.ConditionExpression === "attribute_not_exists(pk)"
          ? existing
          : existing?.revision.N !==
            operation.ExpressionAttributeValues[":revision"].N
      )
        throw Object.assign(Error("Conditional transaction rejected"), {
          name: "TransactionCanceledException",
        });
    }
    for (const entry of input.TransactItems) {
      if (entry.Put) records.set(idOf(entry.Put.Item), clone(entry.Put.Item));
      if (entry.Delete) records.delete(idOf(entry.Delete.Key));
    }
    return {};
  },
};
const repository = createCredentials({
  db,
  table: "fixture",
  uuid: randomUUID,
});
const identity = { sub: randomUUID(), role: "Members" },
  foreign = { sub: randomUUID(), role: "Administrators" };
const command = (name, input = {}) => repository.command(name, identity, input);
const rejected = (work, code) =>
  assert.rejects(work, (error) => error.code === code);

const credential = await command("credentials.put", {
  name: "Shared",
  kind: "github",
  secret: "private-value",
});
assert.equal(credential.secret, undefined);
const first = await command("connections.put", {
  name: "One",
  kind: "github",
  credentialId: credential.id,
});
const second = await command("connections.put", {
  name: "Two",
  kind: "github",
  credentialId: credential.id,
});
let current = (await command("credentials.list")).items[0];
assert.equal(current.usedBy.length, 2);
assert.equal(JSON.stringify(current).includes("private-value"), false);
await rejected(
  () =>
    command("credentials.delete", {
      id: credential.id,
      revision: current.revision,
    }),
  "CREDENTIAL_IN_USE",
);
await rejected(() => repository.resolve(foreign, [first.id]), "NOT_FOUND");
await rejected(
  () =>
    repository.command("credentials.list", foreign, { userSub: identity.sub }),
  "FORBIDDEN",
);
await rejected(
  () =>
    command("connections.put", {
      name: "Secret in connector",
      kind: "github",
      credentialId: credential.id,
      apiKey: "bad",
    }),
  "USE_CREDENTIALS",
);
const rotations = await Promise.allSettled(
  ["rotated-one", "rotated-two"].map((secret) =>
    command("credentials.rotate", {
      id: credential.id,
      revision: current.revision,
      secret,
    }),
  ),
);
assert.equal(
  rotations.filter((result) => result.status === "fulfilled").length,
  1,
);
assert.equal(
  rotations.find((result) => result.status === "rejected").reason.code,
  "REVISION_CONFLICT",
);
const resolved = await repository.resolve(identity, [first.id, second.id]);
assert.equal(resolved[first.id].apiKey, resolved[second.id].apiKey);
await command("connections.delete", { id: first.id, revision: first.revision });
await command("connections.delete", {
  id: second.id,
  revision: second.revision,
});
current = (await command("credentials.list")).items[0];
await command("credentials.delete", {
  id: credential.id,
  revision: current.revision,
});
assert.equal((await command("credentials.list")).items.length, 0);

const legacyId = randomUUID(),
  legacyKey = { pk: { S: `USER#${identity.sub}` }, sk: { S: "CREDENTIALS" } };
records.set(idOf(legacyKey), {
  ...legacyKey,
  revision: { N: "3" },
  connectionsJson: {
    S: JSON.stringify({
      [legacyId]: {
        id: legacyId,
        name: "Legacy",
        kind: "github",
        apiKey: "old-private-value",
      },
    }),
  },
});
beforeTransaction = () => {
  const row = records.get(idOf(legacyKey));
  row.revision.N = "4";
  const bundle = JSON.parse(row.connectionsJson.S);
  bundle[legacyId].apiKey = "new-private-value";
  row.connectionsJson.S = JSON.stringify(bundle);
};
await Promise.all([
  repository.migrate(identity.sub),
  repository.migrate(identity.sub),
]);
await repository.migrate(identity.sub);
assert.equal(
  (await repository.resolve(identity, [legacyId]))[legacyId].apiKey,
  "new-private-value",
);
assert.equal(records.get(idOf(legacyKey)).connectionsJson, undefined);
assert.equal((await command("connections.list")).items[0].id, legacyId);
assert.equal(
  JSON.stringify(await command("credentials.list")).includes("private-value"),
  false,
);
console.log(
  "PASS: private credential reuse, concurrent rotation, reference deletion, foreign denial, revision-checked idempotent migration",
);
