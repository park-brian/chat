// Deterministic product boundary hosted by AgentCore Runtime, not an agent loop.
// AgentCore validates the Cognito JWT before forwarding its Authorization header.
import { createServer } from "node:http";
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";

const idp = new CognitoIdentityProviderClient({});
const db = new DynamoDBClient({});
const S = (value) => ({ S: String(value) });
const N = (value) => ({ N: String(value) });
const key = (pk, sk) => ({ pk: S(pk), sk: S(sk) });
const unpack = (item) =>
  Object.fromEntries(
    Object.entries(item || {}).map(([name, value]) => [
      name,
      value.S ?? (value.N === undefined ? value.BOOL : Number(value.N)),
    ]),
  );

function caller(authorization) {
  const token =
    /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(
      authorization || "",
    )?.[1];
  if (!token) return null;
  // This is claim extraction, not signature verification. The configured AgentCore
  // custom JWT authorizer is the trust boundary; never expose this server directly.
  const claims = JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString(),
  );
  const groups = claims["cognito:groups"];
  if (
    claims.iss !== process.env.ISSUER ||
    claims.client_id !== process.env.CLIENT ||
    claims.token_use !== "access" ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= Date.now() / 1000 ||
    !/^[0-9a-f-]{36}$/i.test(claims.sub || "") ||
    !Array.isArray(groups) ||
    groups.length !== 1 ||
    !["Administrators", "Members", "Auditors"].includes(groups[0])
  )
    return null;
  return { sub: claims.sub, role: groups[0] };
}

async function defaults() {
  const row = await db.send(
    new UpdateItemCommand({
      TableName: process.env.TABLE,
      Key: key("ACCOUNT#CONTROL", "DEFAULTS"),
      UpdateExpression:
        "SET budgetMicroUsd = if_not_exists(budgetMicroUsd, :budget), storageBytes = if_not_exists(storageBytes, :storage), #period = if_not_exists(#period, :period), revision = if_not_exists(revision, :zero)",
      ExpressionAttributeNames: { "#period": "period" },
      ExpressionAttributeValues: {
        ":budget": N(process.env.BUDGET),
        ":storage": N(process.env.STORAGE),
        ":period": S("daily"),
        ":zero": N(0),
      },
      ReturnValues: "ALL_NEW",
    }),
  );
  return unpack(row.Attributes);
}

async function invoke(body, identity) {
  if (
    body?.v !== 1 ||
    body.command !== "session.get" ||
    !body.input ||
    Object.keys(body.input).length
  ) {
    return {
      status: 501,
      data: {
        ok: false,
        error: {
          code: "NOT_IMPLEMENTED",
          message: "Command not available yet",
        },
      },
    };
  }
  const user = await idp.send(
    new AdminGetUserCommand({
      UserPoolId: process.env.POOL,
      Username: identity.sub,
    }),
  );
  const email =
    user.UserAttributes?.find((attribute) => attribute.Name === "email")
      ?.Value || "";
  const limits = await defaults();
  const row = await db.send(
    new UpdateItemCommand({
      TableName: process.env.TABLE,
      Key: key("USER#" + identity.sub, "CONTROL"),
      UpdateExpression:
        "SET budgetMicroUsd = if_not_exists(budgetMicroUsd, :budget), storageBytes = if_not_exists(storageBytes, :storage)",
      ExpressionAttributeValues: {
        ":budget": N(limits.budgetMicroUsd),
        ":storage": N(limits.storageBytes),
      },
      ReturnValues: "ALL_NEW",
    }),
  );
  return {
    status: 200,
    data: {
      ok: true,
      data: {
        user: {
          sub: identity.sub,
          email,
          role: identity.role,
          budgetMicroUsd: Number(row.Attributes.budgetMicroUsd.N),
          storageBytes: Number(row.Attributes.storageBytes.N),
        },
        defaults: limits,
        defaultProjectId: "main",
      },
    },
  };
}

const respond = (response, status, data) => {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(data));
};

createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/ping")
    return respond(response, 200, { status: "Healthy" });
  if (request.method !== "POST" || request.url !== "/invocations")
    return respond(response, 404, { ok: false });
  let identity;
  try {
    identity = caller(request.headers.authorization);
  } catch {
    /* malformed token */
  }
  if (!identity)
    return respond(response, 403, {
      ok: false,
      error: { code: "UNAUTHENTICATED" },
    });
  try {
    let raw = "";
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 65536)
        return respond(response, 413, {
          ok: false,
          error: { code: "TOO_LARGE" },
        });
      raw += chunk;
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return respond(response, 400, {
        ok: false,
        error: { code: "VALIDATION_FAILED" },
      });
    }
    const result = await invoke(body, identity);
    respond(response, result.status, result.data);
  } catch {
    respond(response, 500, {
      ok: false,
      error: { code: "INTERNAL", message: "Operation failed" },
    });
  }
}).listen(Number(process.env.PORT || 8080), "0.0.0.0");
