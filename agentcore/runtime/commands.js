// The product API: every command the Runtime answers, in one table.
//
// An entry is { run(input, identity, { request, response }), write?, admin?,
// stream? }. `write` commands are closed to Auditors and `admin` commands
// require Administrators; controller.js enforces both before `run`. Handlers
// return data or throw a Failure. A `stream` command writes its own
// server-sent events to the response instead of returning data.
import { AdminGetUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { defaults, effectiveLimits, emailOf } from "./accounts.js";
import { agentCommands, listAgents } from "./agents.js";
import { idp } from "./aws.js";
import { chat } from "./chat.js";
import { conversationCommands } from "./conversations.js";
import { credentialCommands } from "./credentials.js";
import { Failure, get, sk, userKey } from "./db.js";
import { modelCatalog } from "./models.js";
import { objectCommands } from "./objects.js";
import { listProjects, projectCommands, projectOf } from "./projects.js";
import { createRuns } from "./runs.js";
import { usageCommands } from "./usage.js";
import { userCommands } from "./users.js";

// The browser resets its Runtime session when this differs from its own.
export const apiVersion = 3;
export const runs = createRuns();
const conversations = conversationCommands(runs);

async function session(identity) {
  const [user, profile, base] = await Promise.all([
    idp.send(
      new AdminGetUserCommand({
        UserPoolId: process.env.POOL,
        Username: identity.sub,
      }),
    ),
    get(userKey(identity.sub, sk.profile)),
    defaults(),
  ]);
  return {
    apiVersion,
    user: {
      sub: identity.sub,
      email: emailOf(user),
      role: identity.role,
      ...effectiveLimits(profile, base),
    },
    defaults: base,
  };
}

// A streaming command reports a refusal as its only event.
export function streamError(response, code) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
  });
  response.end(`data: ${JSON.stringify({ type: "error", code })}\n\n`);
}

const startTurn = (input, identity, request) =>
  runs.start(chat, input, identity, request.headers.workloadaccesstoken);

export const commands = {
  "session.get": { run: (input, identity) => session(identity) },
  // Everything the chat page needs to open, in one invocation.
  "workspace.get": {
    run: async (input, identity) => {
      const projectId = await projectOf(identity, input);
      const [current, projects, agents, recent] = await Promise.all([
        session(identity),
        listProjects(identity),
        listAgents(identity, projectId),
        conversations["conversations.list"].run({ projectId }, identity),
      ]);
      return {
        session: current,
        projects,
        agents,
        models: modelCatalog(),
        conversations: recent,
      };
    },
  },
  "models.list": { run: () => ({ items: modelCatalog() }) },
  ...projectCommands,
  ...objectCommands,
  ...agentCommands,
  ...conversations,
  ...credentialCommands,
  ...usageCommands(runs),
  ...userCommands,
  "chat.start": {
    write: true,
    run: (input, identity, { request }) => startTurn(input, identity, request),
  },
  "chat.status": {
    run: (input, identity) => runs.state(identity, input.requestId),
  },
  "chat.cancel": {
    write: true,
    run: (input, identity) => runs.cancel(identity, input),
  },
  // A run's events as server-sent events, resumable after a sequence number.
  "chat.watch": {
    stream: true,
    run: (input, identity, { response }) =>
      runs.watch(identity, input, response),
  },
  // Starts a turn and streams it to completion in the same response.
  "chat.send": {
    write: true,
    stream: true,
    run: async (input, identity, { request, response }) => {
      let accepted;
      try {
        accepted = await startTurn(input, identity, request);
      } catch (error) {
        if (!(error instanceof Failure)) throw error;
        return streamError(response, error.code);
      }
      await runs.watch(identity, { requestId: accepted.requestId }, response, {
        untilTerminal: true,
      });
    },
  },
};
