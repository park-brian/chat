import { createSignal, For, Show } from "solid-js";
import html from "solid-js/html";
import { mountPage } from "../shared/page.js";
import { createFeedback, confirmAction, Field, Skeleton } from "../shared/ui.js";

mountPage({
  key: "connectors",
  title: "Connectors",
  render: ({ rpc, session, projectId, pageUrl }) => {
    const [items, setItems] = createSignal(null),
      [credentials, setCredentials] = createSignal([]),
      [editing, setEditing] = createSignal(null);
    const [kind, setKind] = createSignal("github"),
      [checks, setChecks] = createSignal({}),
      feedback = createFeedback();
    const writable = () => session().user.role !== "Auditors";
    async function load() {
      const [connections, saved] = await Promise.all([
        rpc("connections.list", { projectId: projectId() }),
        rpc("credentials.list"),
      ]);
      setItems(connections.items);
      setCredentials(saved.items);
    }
    feedback.perform(load, "");
    return html`${feedback.view}
      <p class="help">
        Configure a service, then grant its connector to an agent.
        <a href=${pageUrl("credentials")}>Manage credentials</a>.
      </p>
      <${Show} when=${writable}
        ><section class="panel">
          <h2>${() => (editing() ? "Edit connector" : "Add a connector")}</h2>
          <form
            onInput=${feedback.changed}
            onSubmit=${(event) => {
              event.preventDefault();
              const form = event.currentTarget,
                fields = Object.fromEntries(new FormData(form)),
                item = editing();
              feedback.perform(async () => {
                await rpc("connections.put", {
                  ...fields,
                  projectId: projectId(),
                  ...(item && { id: item.id, revision: item.revision }),
                });
                form.reset();
                setEditing(null);
                setKind("github");
                setChecks({});
                await load();
              });
            }}
          >
            <div class="inline-fields">
              <${Field} label="Name"
                ><input
                  name="name"
                  value=${() => editing()?.name || ""}
                  required
                  maxlength="80"
              /><//>
              <label
                >Service<select
                  name="kind"
                  value=${kind}
                  onChange=${(event) => setKind(event.currentTarget.value)}
                >
                  <option value="github">GitHub</option>
                  <option value="jira">Jira</option>
                </select></label
              >
            </div>
            <label
              >Saved credential<select name="credentialId" required>
                <option value="">Choose a credential</option>
                <${For}
                  each=${() => credentials().filter((item) => item.kind === kind())}
                >
                  ${(item) => html`<option value=${item.id} selected=${() => editing()?.credentialId === item.id}>${item.name}</option>`}<//
                >
              </select></label
            >
            <${Show} when=${() => kind() === "jira"}
              ><div class="inline-fields">
                <label
                  >Jira URL<input
                    name="jiraUrl"
                    type="url"
                    value=${() => editing()?.jiraUrl || ""}
                    placeholder="https://team.atlassian.net"
                    required
                /></label>
                <label
                  >Jira account email<input
                    name="jiraEmail"
                    type="email"
                    value=${() => editing()?.jiraEmail || ""}
                    required
                /></label></div
            ><//>
            <div class="actions">
              <button class="primary" type="submit" disabled=${feedback.saving}>
                Save connector</button
              ><${Show} when=${editing}
                ><button
                  type="button"
                  onClick=${async () => {
                    if (!(await feedback.mayLeave())) return;
                    setEditing(null);
                    setKind("github");
                    feedback.clean();
                  }}
                >
                  Cancel edit
                </button><//
              >
            </div>
          </form>
        </section><//
      >
      <section class="panel">
        <h2>Saved connectors</h2>
        <${Show}
          when=${items}
          fallback=${html`<${Skeleton} rows=${4} label="Loading connectors…" />`}
        >
          <${For} each=${items}
            >${(item) =>
              html`<div class="item">
                <strong>${item.name}</strong
                ><small
                  >${item.kind} ·
                  ${() => credentials().find((credential) => credential.id === item.credentialId)?.name || "Credential unavailable"}</small
                >
                <${Show} when=${writable}
                  ><div class="actions">
                    <button
                      disabled=${feedback.saving}
                      onClick=${async () => {
                        if (!(await feedback.mayLeave())) return;
                        feedback.clean();
                        setEditing(item);
                        setKind(item.kind);
                      }}
                    >
                      Edit
                    </button>
                    <button
                      disabled=${() => checks()[item.id]?.loading}
                      onClick=${async () => {
                        setChecks((current) => ({
                          ...current,
                          [item.id]: { loading: true },
                        }));
                        const result = await feedback.perform(
                          () =>
                            rpc("connections.test", {
                              projectId: projectId(),
                              id: item.id,
                            }),
                          "",
                        );
                        setChecks((current) => ({
                          ...current,
                          [item.id]: result || { connected: false },
                        }));
                      }}
                    >
                      Test connection</button
                    ><button
                      disabled=${feedback.saving}
                      onClick=${async () => {
                        if (
                          await confirmAction(
                            `Delete ${item.name}? Agents using this connector will need a new grant.`,
                          )
                        )
                          await feedback.perform(async () => {
                            await rpc("connections.delete", {
                              projectId: projectId(),
                              id: item.id,
                              revision: item.revision,
                            });
                            await load();
                          });
                      }}
                    >
                      Delete
                    </button>
                  </div><//
                >
                <${Show} when=${() => checks()[item.id]}
                  ><p role="status">
                    ${() => (checks()[item.id]?.loading ? "Testing…" : checks()[item.id]?.connected ? "Connected" + (checks()[item.id].account ? " · " + checks()[item.id].account : "") : "Connection failed")}
                  </p><//
                >
              </div>`}<//
          ><${Show} when=${() => !items()?.length}
            ><div class="empty">No saved connectors.</div><//
          >
        <//>
      </section>`;
  },
});
