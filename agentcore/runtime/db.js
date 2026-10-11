// One table, one key vocabulary. Everything a person owns lives in their
// USER#sub partition; sort keys lead with the item type so each type can be
// listed per project or conversation with a single prefix query.
import { createHash, randomUUID } from "node:crypto";
import {
  BatchGetItemCommand,
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { dynamo } from "./aws.js";

const table = () => process.env.TABLE;

// Runtime V2 may restore workers from one snapshot, including random state. Mix
// fresh clock time with uncached entropy so separate sessions never share an id.
export const uuid = () => {
  const hex = createHash("sha256")
    .update(
      `${randomUUID({ disableEntropyCache: true })}:${Date.now()}:${process.hrtime.bigint()}`,
    )
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

export const patterns = {
  id: /^[0-9a-f-]{36}$/i,
  project: /^[a-z0-9][a-z0-9-]{0,39}$/,
  branch: /^(main|[0-9a-f-]{36})$/i,
  // Time-ordered turn ids: 13-digit epoch milliseconds, then random hex.
  turn: /^[0-9]{13}#[a-f0-9]{16}$/,
  day: /^\d{4}-\d{2}-\d{2}$/,
};
export const turnId = () =>
  `${String(Date.now()).padStart(13, "0")}#${uuid().replaceAll("-", "").slice(0, 16)}`;

export const sk = {
  profile: "PROFILE",
  project: (p = "") => `PROJECT#${p}`,
  agent: (p, id = "") => `AGENT#${p}#${id}`,
  object: (p, id = "") => `OBJECT#${p}#${id}`,
  chat: (p, c = "") => `CHAT#${p}#${c}`,
  branch: (p, c, b = "") => `BRANCH#${p}#${c}#${b}`,
  turn: (p, c, t = "") => `TURN#${p}#${c}#${t}`,
  lock: (p, c, b = "") => `LOCK#${p}#${c}#${b}`,
  request: (r = "") => `REQUEST#${r}`,
  usage: (at = "") => `USAGE#${at}`,
  day: (d = "") => `DAY#${d}`,
  credential: (id = "") => `CREDENTIAL#${id}`,
  connection: (id = "") => `CONNECTION#${id}`,
};
export const userPk = (sub) => `USER#${sub}`;
export const accountPk = "ACCOUNT";
export const chatIndex = (sub, p) => `CHATS#${sub}#${p}`;

// Plain values <-> DynamoDB attributes: strings, numbers, booleans, null and
// string lists. Anything richer is stored as a JSON string by its owner.
const attribute = (value) =>
  value instanceof Set
    ? { SS: [...value].map(String) }
    : value === null
    ? { NULL: true }
    : typeof value === "number"
      ? { N: String(value) }
      : typeof value === "boolean"
        ? { BOOL: value }
        : Array.isArray(value)
          ? { L: value.map((entry) => ({ S: String(entry) })) }
          : { S: String(value) };
export const pack = (object) =>
  Object.fromEntries(
    Object.entries(object)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => [name, attribute(value)]),
  );
export const unpack = (item) =>
  item
    ? Object.fromEntries(
        Object.entries(item).map(([name, value]) => [
          name,
          value.S ??
            (value.N !== undefined
              ? Number(value.N)
              : value.BOOL !== undefined
                ? value.BOOL
                : value.NULL
                  ? null
                  : (value.L?.map((part) => part.S) ?? value.SS)),
        ]),
      )
    : null;
export const key = (pk, sortKey) => ({
  pk: { S: pk },
  sk: { S: sortKey },
});
export const userKey = (sub, sortKey) => key(userPk(sub), sortKey);

export class Failure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
export const fail = (code) => {
  throw new Failure(code);
};
export const conditionFailed = (error) =>
  ["ConditionalCheckFailedException", "TransactionCanceledException"].includes(
    error.name,
  );

// Builds Update/Condition parameters from plain values. `set` values are
// assigned and `add` values are numeric increments or set additions. In a
// `condition`, every #name is aliased and :placeholders come from `values`.
export function expression({
  set = {},
  init = {},
  add = {},
  remove = [],
  drop = {},
  condition,
  values = {},
}) {
  const names = {},
    attributes = {};
  const alias = (name) => ((names[`#${name}`] = name), `#${name}`);
  for (const [, name] of (condition || "").matchAll(/#(\w+)/g)) alias(name);
  const parts = [];
  // `init` assigns only when the attribute is missing.
  const assigned = [
    ...Object.entries(set)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => {
        attributes[`:set_${name}`] = attribute(value);
        return `${alias(name)} = :set_${name}`;
      }),
    ...Object.entries(init).map(([name, value]) => {
      attributes[`:init_${name}`] = attribute(value);
      return `${alias(name)} = if_not_exists(${alias(name)}, :init_${name})`;
    }),
  ];
  if (assigned.length) parts.push("SET " + assigned.join(", "));
  const added = Object.entries(add);
  if (added.length)
    parts.push(
      "ADD " +
        added
          .map(([name, value]) => {
            attributes[`:add_${name}`] = attribute(value);
            return `${alias(name)} :add_${name}`;
          })
          .join(", "),
    );
  if (remove.length) parts.push("REMOVE " + remove.map(alias).join(", "));
  // `drop` removes members from a string set (DynamoDB DELETE).
  const dropped = Object.entries(drop);
  if (dropped.length)
    parts.push(
      "DELETE " +
        dropped
          .map(([name, value]) => {
            attributes[`:drop_${name}`] = attribute(value);
            return `${alias(name)} :drop_${name}`;
          })
          .join(", "),
    );
  for (const [name, value] of Object.entries(values))
    attributes[name] = attribute(value);
  return {
    ...(parts.length && { UpdateExpression: parts.join(" ") }),
    ...(condition && { ConditionExpression: condition }),
    ...(Object.keys(names).length && { ExpressionAttributeNames: names }),
    ...(Object.keys(attributes).length && {
      ExpressionAttributeValues: attributes,
    }),
  };
}
// A conditional write that resolves to false instead of throwing on conflict.
export const attempt = (promise) =>
  promise.then(
    () => true,
    (error) => {
      if (conditionFailed(error)) return false;
      throw error;
    },
  );

export const get = async (itemKey) =>
  unpack(
    (
      await dynamo.send(
        new GetItemCommand({
          TableName: table(),
          Key: itemKey,
          ConsistentRead: true,
        }),
      )
    ).Item,
  );
export const put = (item, condition = {}) =>
  dynamo.send(
    new PutItemCommand({ TableName: table(), Item: item, ...condition }),
  );
// Resolves to the item as plain values after the update.
export const update = async (itemKey, parameters) =>
  unpack(
    (
      await dynamo.send(
        new UpdateItemCommand({
          TableName: table(),
          Key: itemKey,
          ReturnValues: "ALL_NEW",
          ...parameters,
        }),
      )
    ).Attributes,
  );
export const remove = (itemKey, condition = {}) =>
  dynamo.send(
    new DeleteItemCommand({ TableName: table(), Key: itemKey, ...condition }),
  );
// Every transaction carries an explicit token: the SDK's generated one comes
// from the snapshot-restored random state, so two restored workers would reuse
// the same token sequence and collide within DynamoDB's idempotency window.
export const transact = (items, token = uuid()) =>
  dynamo.send(
    new TransactWriteItemsCommand({
      TransactItems: items.map((item) => {
        const [type, operation] = Object.entries(item)[0];
        return { [type]: { TableName: table(), ...operation } };
      }),
      ClientRequestToken: token,
    }),
  );

// Many items by key, in input order (missing items are null).
export async function getMany(keys) {
  const found = new Map();
  for (let start = 0; start < keys.length; start += 100) {
    let pending = keys.slice(start, start + 100);
    while (pending.length) {
      const result = await dynamo.send(
        new BatchGetItemCommand({
          RequestItems: { [table()]: { Keys: pending, ConsistentRead: true } },
        }),
      );
      for (const item of result.Responses?.[table()] || [])
        found.set(`${item.pk.S}|${item.sk.S}`, unpack(item));
      pending = result.UnprocessedKeys?.[table()]?.Keys || [];
    }
  }
  return keys.map(
    (itemKey) => found.get(`${itemKey.pk.S}|${itemKey.sk.S}`) ?? null,
  );
}

// One page of a partition prefix, newest first unless asked otherwise.
export async function query({
  pk,
  prefix,
  between,
  index,
  cursor,
  limit = 100,
  forward = true,
  filter,
}) {
  const hash = index ? "gsi1pk" : "pk",
    range = index ? "gsi1sk" : "sk";
  const page = await dynamo.send(
    new QueryCommand({
      TableName: table(),
      ...(index && { IndexName: index }),
      KeyConditionExpression:
        `${hash} = :pk` +
        (prefix !== undefined
          ? ` AND begins_with(${range}, :prefix)`
          : between
            ? ` AND ${range} BETWEEN :from AND :to`
            : ""),
      ExpressionAttributeValues: {
        ":pk": { S: pk },
        ...(prefix !== undefined && { ":prefix": { S: prefix } }),
        ...(between && { ":from": { S: between[0] }, ":to": { S: between[1] } }),
        ...(filter?.values &&
          Object.fromEntries(
            Object.entries(filter.values).map(([name, value]) => [
              name,
              attribute(value),
            ]),
          )),
      },
      ...(filter && {
        FilterExpression: filter.expression,
        ...(filter.names && { ExpressionAttributeNames: filter.names }),
      }),
      ExclusiveStartKey: cursor,
      Limit: limit,
      ScanIndexForward: forward,
      ...(!index && { ConsistentRead: true }),
    }),
  );
  return {
    items: (page.Items || []).map(unpack),
    next: page.LastEvaluatedKey || null,
  };
}
export async function queryAll(options) {
  const items = [];
  let cursor;
  do {
    const page = await query({ ...options, cursor, limit: 1000 });
    items.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return items;
}

// Opaque, tamper-evident-enough cursors: the server re-checks every decoded
// key against the caller's own partition before using it.
export const encodeCursor = (value) =>
  value ? Buffer.from(JSON.stringify(value)).toString("base64url") : null;
export function decodeCursor(cursor, valid) {
  if (cursor === undefined || cursor === null) return undefined;
  try {
    if (typeof cursor !== "string" || cursor.length > 4000) throw Error();
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (!valid(value)) throw Error();
    return value;
  } catch {
    fail("VALIDATION_FAILED");
  }
}
