import { createSignal, For, Show } from "solid-js";
import html from "solid-js/html";
import { mountPage } from "../shared/page.js";
import { createFeedback, confirmAction, Field, Empty, Skeleton } from "../shared/ui.js";

mountPage({
  key: "credentials",
  title: "Credentials",
  render: ({ rpc, session, pageUrl }) => {
    const [items, setItems] = createSignal(null),
      [editing, setEditing] = createSignal(null),
      feedback = createFeedback();
    const writable = () => session().user.role !== "Auditors";
    async function load() {
      setItems((await rpc("credentials.list")).items);
    }
    feedback.perform(load, "");
    const mutation = (command, input, form) =>
      feedback.perform(async () => {
        await rpc(command, input);
        form?.reset();
        setEditing(null);
        await load();
      });
    return html`${feedback.view}
      <p class="help">
        Reusable secrets for your connectors. Saved secret values are never
        displayed.
      </p>
      <${Show} when=${writable}
        ><section class="panel">
          <h2>Add a credential</h2>
          <form
            onInput=${feedback.changed}
            onSubmit=${(event) => {
              event.preventDefault();
              mutation(
                "credentials.put",
                Object.fromEntries(new FormData(event.currentTarget)),
                event.currentTarget,
              );
            }}
          >
            <div class="inline-fields">
              <${Field} label="Name"
                ><input name="name" required maxlength="80" /><//
              ><label
                >Service<select name="kind">
                  <option value="github">GitHub</option>
                  <option value="jira">Jira</option>
                </select></label
              >
            </div>
            <label
              >Secret<input
                name="secret"
                type="password"
                required
                maxlength="4096"
                autocomplete="new-password" /></label
            ><button class="primary" type="submit" disabled=${feedback.saving}>
              Save credential
            </button>
          </form>
        </section><//
      >
      <section class="panel">
        <h2>Saved credentials</h2>
        <${Show}
          when=${items}
          fallback=${html`<${Skeleton} rows=${4} label="Loading credentials…" />`}
        >
          <${For} each=${items}
            >${(item) =>
              html`<div class="item">
                <div class="section-heading">
                  <div>
                    <strong>${item.name}</strong
                    ><small>${item.kind} · Revision ${item.revision}</small>
                  </div>
                  <${Show} when=${writable}
                    ><button
                      onClick=${async () => {
                        if (await feedback.mayLeave()) {
                          feedback.clean();
                          setEditing(editing()?.id === item.id ? null : item);
                        }
                      }}
                    >
                      Edit
                    </button><//
                  >
                </div>
                <p class="help">
                  ${item.usedBy?.length ? "Used by " + item.usedBy.map((connection) => connection.name).join(", ") : "No connectors use this credential."}
                </p>
                <${Show} when=${() => editing()?.id === item.id}>
                  <form
                    onInput=${feedback.changed}
                    onSubmit=${(event) => {
                      event.preventDefault();
                      mutation("credentials.put", {
                        id: item.id,
                        revision: item.revision,
                        name: new FormData(event.currentTarget).get("name"),
                      });
                    }}
                  >
                    <label
                      >Name<input
                        name="name"
                        value=${item.name}
                        required
                        maxlength="80" /></label
                    ><button type="submit" disabled=${feedback.saving}>
                      Rename
                    </button>
                  </form>
                  <form
                    onInput=${feedback.changed}
                    onSubmit=${(event) => {
                      event.preventDefault();
                      mutation(
                        "credentials.rotate",
                        {
                          id: item.id,
                          revision: item.revision,
                          secret: new FormData(event.currentTarget).get(
                            "secret",
                          ),
                        },
                        event.currentTarget,
                      );
                    }}
                  >
                    <label
                      >Replacement secret<input
                        name="secret"
                        type="password"
                        required
                        maxlength="4096"
                        autocomplete="new-password" /></label
                    ><button type="submit" disabled=${feedback.saving}>
                      Rotate secret
                    </button>
                  </form>
                  <div class="actions">
                    <button
                      disabled=${() => feedback.saving() || Boolean(item.usedBy?.length)}
                      onClick=${async () => {
                        if (await confirmAction(`Delete ${item.name}?`))
                          mutation("credentials.delete", {
                            id: item.id,
                            revision: item.revision,
                          });
                      }}
                    >
                      Delete credential</button
                    ><button
                      onClick=${async () => {
                        if (await feedback.mayLeave()) {
                          feedback.clean();
                          setEditing(null);
                        }
                      }}
                    >
                      Done
                    </button>
                  </div>
                <//>
              </div>`}<//
          >
          <${Show} when=${() => !items()?.length}
            ><div class="empty">
              No saved credentials. Add one to configure a connector.
            </div><//
          >
        <//>
      </section>
      <a href=${pageUrl("connectors")}>Manage connectors →</a>`;
  },
});
