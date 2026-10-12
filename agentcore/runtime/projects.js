// Projects separate agents, files and conversations. "main" always exists and
// has no row; every other project is a row in its owner's partition.
import {
  attempt,
  expression,
  fail,
  get,
  pack,
  patterns,
  put,
  nameOf,
  query,
  revised,
  revisionOf,
  sk,
  update,
  userKey,
  userPk,
} from "./db.js";

const main = { id: "main", name: "Main project", hidden: false };
const view = ({ id, name, hidden, revision, createdAt }) => ({
  id,
  name,
  hidden,
  revision,
  createdAt,
});

// Resolves a request's project id, defaulting to main, and proves it exists.
export async function projectOf(identity, input) {
  const id = input.projectId ?? "main";
  if (!patterns.project.test(id)) fail("VALIDATION_FAILED");
  if (id !== "main" && !(await get(userKey(identity.sub, sk.project(id)))))
    fail("NOT_FOUND");
  return id;
}

export async function listProjects(identity) {
  const page = await query({
    pk: userPk(identity.sub),
    prefix: sk.project(),
  });
  return [main, ...page.items.map(view)];
}

const existingId = (id) => {
  if (!patterns.project.test(id || "") || id === "main")
    fail("VALIDATION_FAILED");
  return id;
};
async function change(identity, input, set) {
  const id = existingId(input.id);
  const revision = revisionOf(input.revision);
  const saved = await revised(
    update(
      userKey(identity.sub, sk.project(id)),
      expression({
        set,
        add: { revision: 1 },
        condition: "attribute_exists(pk) AND #revision = :revision",
        values: { ":revision": revision },
      }),
    ),
  );
  return view(saved);
}
export const projectCommands = {
  "projects.list": {
    run: async (input, identity) => ({ items: await listProjects(identity) }),
  },
  "projects.create": {
    write: true,
    run: async (input, identity) => {
      const id = existingId(input.id);
      const name = nameOf(input.name);
      if ((await listProjects(identity)).length >= 100) fail("PROJECT_LIMIT");
      const project = {
        id,
        name,
        hidden: false,
        revision: 0,
        createdAt: new Date().toISOString(),
      };
      const created = await attempt(
        put(
          { ...userKey(identity.sub, sk.project(id)), ...pack(project) },
          { ConditionExpression: "attribute_not_exists(pk)" },
        ),
      );
      if (!created) fail("PROJECT_EXISTS");
      return project;
    },
  },
  "projects.rename": {
    write: true,
    run: (input, identity) =>
      change(identity, input, { name: nameOf(input.name) }),
  },
  "projects.setHidden": {
    write: true,
    run: (input, identity) => {
      if (typeof input.hidden !== "boolean") fail("VALIDATION_FAILED");
      return change(identity, input, { hidden: input.hidden });
    },
  },
};
