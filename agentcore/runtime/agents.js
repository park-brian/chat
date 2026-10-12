// An agent is configuration, not compute: a model, instructions, and the tools,
// connections and skills it may use. Edits are revision-checked.
import { connectionsOf } from "./credentials.js";
import {
  attempt,
  expression,
  fail,
  get,
  pack,
  patterns,
  put,
  queryAll,
  revised,
  sk,
  update,
  userKey,
  userPk,
  uuid,
} from "./db.js";
import { approvedModel, thinkingLevelFor } from "./models.js";
import { isUsableSkill, objectKey } from "./objects.js";
import { projectOf } from "./projects.js";

export const agentKey = (sub, projectId, id) =>
  userKey(sub, sk.agent(projectId, id));
const view = ({ pk, sk: sortKey, ...agent }) => agent;

export async function listAgents(identity, projectId, includeArchived = true) {
  const rows = await queryAll({
    pk: userPk(identity.sub),
    prefix: sk.agent(projectId),
  });
  return rows
    .map(view)
    .filter((agent) => includeArchived || !agent.archived);
}

const idList = (ids) =>
  Array.isArray(ids) &&
  ids.length <= 4 &&
  ids.every((id) => patterns.id.test(id || "")) &&
  new Set(ids).size === ids.length;
const boundedInteger = (value, min, max) =>
  Number.isSafeInteger(value) && value >= min && value <= max;

function validAgentInput(input) {
  const {
    name,
    modelId,
    systemPrompt = "",
    codeInterpreter = false,
    webSearch = false,
    browser = false,
    connectionIds = [],
    skillIds = [],
    webSearchMaxResults = 5,
    browserSessionSeconds = 300,
  } = input;
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.length > 80 ||
    typeof modelId !== "string" ||
    !modelId ||
    modelId.length > 512 ||
    typeof systemPrompt !== "string" ||
    systemPrompt.length > 12000 ||
    [codeInterpreter, webSearch, browser].some(
      (value) => typeof value !== "boolean",
    ) ||
    !idList(connectionIds) ||
    !idList(skillIds) ||
    (connectionIds.length && !codeInterpreter) ||
    !boundedInteger(webSearchMaxResults, 1, 25) ||
    !boundedInteger(browserSessionSeconds, 60, 900) ||
    (input.id !== undefined &&
      (!patterns.id.test(input.id || "") ||
        !boundedInteger(input.revision, 0, Number.MAX_SAFE_INTEGER)))
  )
    fail("VALIDATION_FAILED");
  return {
    name: name.trim(),
    modelId,
    systemPrompt,
    codeInterpreter,
    webSearch,
    browser,
    connectionIds,
    skillIds,
    webSearchMaxResults,
    browserSessionSeconds,
  };
}

export const agentCommands = {
  "agents.list": {
    run: async (input, identity) => {
      const projectId = await projectOf(identity, input);
      if (
        input.includeArchived !== undefined &&
        typeof input.includeArchived !== "boolean"
      )
        fail("VALIDATION_FAILED");
      return {
        items: await listAgents(
          identity,
          projectId,
          input.includeArchived ?? true,
        ),
      };
    },
  },
  "agents.put": {
    write: true,
    run: async (input, identity) => {
      const fields = validAgentInput(input);
      const projectId = await projectOf(identity, input);
      const model = approvedModel(fields.modelId);
      if (!model) fail("MODEL_UNAVAILABLE");
      const thinkingLevel = thinkingLevelFor(model, input.thinkingLevel);
      if (fields.browser && !model.browserTool) fail("TOOL_UNAVAILABLE");
      if (fields.connectionIds.length) {
        const saved = await connectionsOf(identity);
        const chosen = fields.connectionIds.map((id) =>
          saved.find((item) => item.id === id),
        );
        if (
          chosen.some((item) => !item) ||
          new Set(chosen.map((item) => item.kind)).size !== chosen.length
        )
          fail("CONNECTION_UNAVAILABLE");
      }
      const skills = await Promise.all(
        fields.skillIds.map((id) => get(objectKey(identity.sub, projectId, id))),
      );
      if (!skills.every(isUsableSkill)) fail("SKILL_UNAVAILABLE");
      const id = input.id || uuid();
      const current = input.id
        ? await get(agentKey(identity.sub, projectId, id))
        : null;
      if (input.id && !current) fail("NOT_FOUND");
      if (current?.archived) fail("AGENT_ARCHIVED");
      if (current && current.revision !== input.revision)
        fail("REVISION_CONFLICT");
      const agent = {
        id,
        ...fields,
        thinkingLevel,
        archived: false,
        createdAt: current?.createdAt || new Date().toISOString(),
        revision: current ? current.revision + 1 : 0,
      };
      const saved = await attempt(
        put(
          { ...agentKey(identity.sub, projectId, id), ...pack(agent) },
          current
            ? expression({
                condition: "#revision = :revision",
                values: { ":revision": current.revision },
              })
            : { ConditionExpression: "attribute_not_exists(pk)" },
        ),
      );
      if (!saved) fail("REVISION_CONFLICT");
      return agent;
    },
  },
  "agents.setArchived": {
    write: true,
    run: async (input, identity) => {
      const projectId = await projectOf(identity, input);
      if (
        !patterns.id.test(input.id || "") ||
        !boundedInteger(input.revision, 0, Number.MAX_SAFE_INTEGER) ||
        typeof input.archived !== "boolean"
      )
        fail("VALIDATION_FAILED");
      return view(
        await revised(
          update(
            agentKey(identity.sub, projectId, input.id),
            expression({
              set: { archived: input.archived },
              add: { revision: 1 },
              condition: "attribute_exists(pk) AND #revision = :revision",
              values: { ":revision": input.revision },
            }),
          ),
        ),
      );
    },
  },
};
