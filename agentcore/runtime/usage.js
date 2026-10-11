// Reading recorded usage: the current budget period, the per-step ledger, day
// rollups and one request in detail. People see their own usage;
// administrators may see anyone's, or everyone's combined.
import { createHash } from "node:crypto";
import { periodKey } from "./accounting.js";
import { limits } from "./accounts.js";
import {
  decodeCursor,
  encodeCursor,
  fail,
  get,
  getMany,
  patterns,
  query,
  sk,
  userKey,
  userPk,
} from "./db.js";
import { runStatuses } from "./runs.js";

const day = 86400000;

// Whose usage a request may read: its own, or anyone's for administrators.
function targetOf(input, identity) {
  const target = input.userSub || identity.sub;
  if (!patterns.id.test(target)) fail("VALIDATION_FAILED");
  if (target !== identity.sub && identity.role !== "Administrators")
    fail("FORBIDDEN");
  return target;
}
function scopeOf(input, identity) {
  const scope = input.scope ?? "self";
  if (!["self", "all"].includes(scope)) fail("VALIDATION_FAILED");
  if (scope === "all" && identity.role !== "Administrators") fail("FORBIDDEN");
  // A chosen person is read from their own partition, not the combined index.
  return scope === "all" && !input.userSub ? "all" : "self";
}

async function summary(input, identity) {
  const target = targetOf(input, identity);
  const current = await limits(target);
  const period = periodKey(current.period, new Date(), current.budgetEpoch);
  const totals = (await get(userKey(target, period))) || {};
  return {
    period,
    userSub: target,
    budgetMicroUsd: current.budgetMicroUsd,
    costMicroUsd: totals.costMicroUsd || 0,
    unpricedToolCalls: totals.unpricedToolCalls || 0,
    unknownModelCalls: totals.unknownModelCalls || 0,
    // "partial": some spend is estimated from text or unpriced tool use.
    quality:
      totals.unknownModelCalls || totals.unpricedToolCalls
        ? "partial"
        : totals.estimatedModelCalls
          ? "estimated"
          : "none",
  };
}

const listFilters = ["projectId", "agentId", "requestId", "tool", "kind", "quality", "status"];
function validListInput(input) {
  const { range = "30d", sort = "desc", from, to } = input;
  const valid =
    ["30d", "90d"].includes(range) &&
    ["asc", "desc"].includes(sort) &&
    (input.projectId === undefined || patterns.project.test(input.projectId)) &&
    (input.agentId === undefined || patterns.id.test(input.agentId)) &&
    (input.requestId === undefined || patterns.id.test(input.requestId)) &&
    (input.tool === undefined || /^[a-z_]{1,80}$/.test(input.tool)) &&
    (input.kind === undefined || ["model", "tool"].includes(input.kind)) &&
    (input.quality === undefined ||
      ["estimated", "unknown", "unpriced"].includes(input.quality)) &&
    (input.status === undefined || runStatuses.includes(input.status)) &&
    (from === undefined) === (to === undefined) &&
    (from === undefined || (patterns.day.test(from) && patterns.day.test(to)));
  if (!valid) fail("VALIDATION_FAILED");
  const since = from
    ? `${from}T00:00:00.000Z`
    : new Date(Date.now() - (range === "90d" ? 90 : 30) * day).toISOString();
  const until = to ? `${to}T23:59:59.999Z` : new Date().toISOString();
  if (
    !Number.isFinite(Date.parse(since)) ||
    !Number.isFinite(Date.parse(until)) ||
    until < since ||
    Date.parse(until) - Date.parse(since) > 91 * day
  )
    fail("VALIDATION_FAILED");
  return { range, sort, since, until };
}

async function list(input, identity) {
  const target = targetOf(input, identity);
  const scope = scopeOf(input, identity);
  const { range, sort, since, until } = validListInput(input);
  // Cursors only resume the exact query they came from.
  const filterKey = createHash("sha256")
    .update(
      JSON.stringify([scope, target, range, sort, since.slice(0, 10), ...listFilters.map((name) => input[name])]),
    )
    .digest("hex")
    .slice(0, 20);
  const resumed = decodeCursor(
    input.cursor,
    (value) =>
      value.filterKey === filterKey &&
      (scope === "all"
        ? value.key?.gsi1pk?.S === "USAGE"
        : value.key?.pk?.S === userPk(target)) &&
      value.key?.sk?.S?.startsWith(sk.usage()),
  );
  const window = resumed?.window || [since, until];
  const conditions = [],
    names = {},
    values = {};
  for (const field of ["projectId", "agentId", "requestId", "kind", "quality"])
    if (input[field] !== undefined) {
      names[`#${field}`] = field;
      values[`:${field}`] = input[field];
      conditions.push(`#${field} = :${field}`);
    }
  if (input.tool !== undefined) {
    names["#name"] = "name";
    values[":tool"] = input.tool;
    conditions.push("#name = :tool");
  }
  const page = await query({
    ...(scope === "all"
      ? { pk: "USAGE", index: "ByTime", between: [window[0], `${window[1]}~`] }
      : {
          pk: userPk(target),
          between: [sk.usage(window[0]), sk.usage(`${window[1]}~`)],
        }),
    cursor: resumed?.key,
    limit: 50,
    forward: sort === "asc",
    ...(conditions.length && {
      filter: { expression: conditions.join(" AND "), names, values },
    }),
  });
  let items = page.items;
  if (input.status !== undefined) {
    const requests = await getMany(
      items.map((item) => userKey(item.userSub, sk.request(item.requestId))),
    );
    items = items
      .map((item, index) => ({
        ...item,
        requestStatus: requests[index]?.status || "unknown",
      }))
      .filter((item) => item.requestStatus === input.status);
  }
  return {
    range,
    sort,
    scope,
    items: items.map(({ pk, sk: sortKey, gsi1pk, gsi1sk, ...item }) => item),
    nextCursor: page.next ? encodeCursor({ key: page.next, filterKey, window }) : null,
  };
}

async function daily(input, identity) {
  const target = targetOf(input, identity);
  const scope = scopeOf(input, identity);
  const range = input.range ?? "30d";
  if (!["30d", "90d"].includes(range)) fail("VALIDATION_FAILED");
  const since = new Date(Date.now() - (range === "90d" ? 89 : 29) * day)
    .toISOString()
    .slice(0, 10);
  const resumed = decodeCursor(
    input.cursor,
    (value) =>
      value.since === since &&
      value.scope === scope &&
      value.target === target &&
      value.key?.sk?.S?.startsWith(sk.day()),
  );
  const page = await query({
    ...(scope === "all"
      ? { pk: "USAGE_DAYS", index: "ByTime", between: [since, "9999-12-31~"] }
      : { pk: userPk(target), between: [sk.day(since), sk.day("9999-12-31")] }),
    cursor: resumed?.key,
    limit: 100,
  });
  return {
    items: page.items.map(({ pk, sk: sortKey, gsi1pk, gsi1sk, ...item }) => item),
    nextCursor: page.next
      ? encodeCursor({ key: page.next, since, scope, target })
      : null,
  };
}

export function usageCommands(runs) {
  return {
    "usage.summary": { run: summary },
    "usage.list": { run: list },
    "usage.daily": { run: daily },
    "usage.get": {
      run: async (input, identity) => {
        const [current, page, days] = await Promise.all([
          summary({ userSub: input.userSub }, identity),
          list(input, identity),
          input.includeDaily
            ? daily(
                { range: input.range, scope: input.scope, userSub: input.userSub },
                identity,
              )
            : null,
        ]);
        return { ...current, ...page, ...(days && { daily: days }) };
      },
    },
    // One request and its metered steps. Reading it also settles a run whose
    // worker was lost, so its status is never stuck at "running".
    "usage.request": {
      run: async (input, identity) => {
        const target = targetOf(input, identity);
        if (!patterns.id.test(input.requestId || "")) fail("VALIDATION_FAILED");
        await runs.state({ sub: target }, input.requestId);
        const request = await get(userKey(target, sk.request(input.requestId)));
        const end = request.completedAt || request.failedAt || new Date().toISOString();
        const steps = await query({
          pk: userPk(target),
          between: [sk.usage(request.acceptedAt), sk.usage(`${end}~`)],
          limit: 1000,
          filter: {
            expression: "#requestId = :request",
            names: { "#requestId": "requestId" },
            values: { ":request": input.requestId },
          },
        });
        const { pk, sk: sortKey, inputFingerprint, workerId, ...visible } = request;
        return {
          request: visible,
          steps: steps.items.map(({ pk, sk: sortKey, gsi1pk, gsi1sk, ...step }) => step),
        };
      },
    },
  };
}
