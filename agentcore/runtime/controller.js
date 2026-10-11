// The Runtime's HTTP server. AgentCore validates the Cognito JWT before it
// forwards the Authorization header; this server re-checks the caller against
// Cognito, applies each command's role rules, and answers every request with
// HTTP 200, because AgentCore masks any other Runtime status as a generic 424.
import { createServer } from "node:http";
import { caller, stillAuthorized } from "./accounts.js";
import { commands, runs, streamError } from "./commands.js";
import { Failure, fail } from "./db.js";

const json = (response, data) => {
  response.writeHead(200, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(data));
};

// The request body, decoded once from all its bytes so a multi-byte character
// split across chunks is never corrupted. Null when over the limit.
async function body(request, limit = 65536) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function dispatch(request, response, identity) {
  const raw = await body(request);
  if (raw === null)
    return json(response, { ok: false, error: { code: "TOO_LARGE" } });
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    fail("VALIDATION_FAILED");
  }
  if (
    message?.v !== 1 ||
    !message.input ||
    typeof message.input !== "object" ||
    Array.isArray(message.input)
  )
    fail("VALIDATION_FAILED");
  const command = commands[message.command];
  if (!command) fail("NOT_IMPLEMENTED");
  const refused =
    (command.write && identity.role === "Auditors") ||
    (command.admin && identity.role !== "Administrators");
  if (refused && command.stream) return streamError(response, "FORBIDDEN");
  if (refused) fail("FORBIDDEN");
  const data = await command.run(message.input, identity, { request, response });
  if (!command.stream) json(response, { ok: true, data });
}

createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/ping")
    return json(response, { status: runs.busy() ? "HealthyBusy" : "Healthy" });
  if (request.method !== "POST" || request.url !== "/invocations") {
    response.writeHead(404);
    return response.end();
  }
  const identity = caller(request.headers.authorization);
  if (!identity)
    return json(response, { ok: false, error: { code: "UNAUTHENTICATED" } });
  try {
    if (!(await stillAuthorized(identity))) fail("SESSION_CHANGED");
    await dispatch(request, response, identity);
  } catch (error) {
    if (response.headersSent) return response.end();
    if (error instanceof Failure)
      return json(response, { ok: false, error: { code: error.code } });
    console.error(
      "Command failed",
      error.name,
      error.$metadata?.httpStatusCode || "",
    );
    json(response, {
      ok: false,
      error: {
        code: "INTERNAL",
        ...(process.env.SCRIPTED_MODEL === "true" && { diagnostic: error.name }),
      },
    });
  }
}).listen(Number(process.env.PORT || 8080), "0.0.0.0");
