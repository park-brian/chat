import { createSignal, For, Show } from "solid-js";
import html from "solid-js/html";
import { mountPage } from "../shared/page.js";
import { createFeedback, dollars, gb, Badge, Empty } from "../shared/ui.js";

mountPage({
  key: "users",
  title: "Users",
  render: ({ rpc, pageUrl }) => {
    const [data, setData] = createSignal(null),
      feedback = createFeedback();
    async function load() {
      setData(await rpc("users.list"));
    }
    feedback.perform(load, "");
    return html`${feedback.view}
      <section class="panel">
        <h2>People</h2>
        <${Show}
          when=${data}
          fallback=${html`<${Empty} text="Loading users…" />`}
        >
          <div class="compact-list">
            <${For} each=${() => data()?.items || []}
              >${(user) =>
                html`<a
                  class="list-row"
                  href=${pageUrl("profile", { user: user.sub })}
                >
                  <div>
                    <strong>${user.email}</strong
                    ><small
                      >${user.role || "No role"} ·
                      ${user.status}${user.protected ? " · Protected administrator" : ""}</small
                    >
                  </div>
                  <${Badge}
                    text=${user.enabled ? "Enabled" : "Disabled"}
                  /><span aria-hidden="true">→</span></a
                >`}<//
            >
          </div>
          <${Show} when=${() => data()?.cursor}
            ><button
              onClick=${() =>
                feedback.perform(async () => {
                  const next = await rpc("users.list", {
                    cursor: data().cursor,
                  });
                  setData({ ...next, items: [...data().items, ...next.items] });
                }, "")}
            >
              Load more people
            </button><//
          >
          <${Show} when=${() => !data()?.items?.length}
            ><${Empty} text="No users found."
          /><//>
        <//>
      </section>
      <section class="panel">
        <h2>Invite a user</h2>
        <form
          onInput=${feedback.changed}
          onSubmit=${(event) => {
            event.preventDefault();
            const form = event.currentTarget,
              values = Object.fromEntries(new FormData(form));
            feedback.perform(async () => {
              await rpc("users.invite", values);
              form.reset();
              await load();
            }, "Invitation sent.");
          }}
        >
          <div class="inline-fields">
            <label
              >Email<input
                name="email"
                type="email"
                required
                autocomplete="off" /></label
            ><label
              >Role<select name="role">
                <option>Members</option>
                <option>Auditors</option>
                <option>Administrators</option>
              </select></label
            >
          </div>
          <button class="primary" type="submit" disabled=${feedback.saving}>
            Send invitation
          </button>
        </form>
      </section>
      <${Show} when=${() => data()?.defaults}
        >${() => {
          const defaults = data().defaults;
          return html`<section class="panel">
            <h2>Account defaults</h2>
            <p class="help">Inherited by users without a personal override.</p>
            <form
              onInput=${feedback.changed}
              onSubmit=${(event) => {
                event.preventDefault();
                const fields = new FormData(event.currentTarget);
                feedback.perform(async () => {
                  await rpc("defaults.set", {
                    budgetMicroUsd: Math.round(
                      Number(fields.get("budget")) * 1000000,
                    ),
                    storageBytes: Math.round(
                      Number(fields.get("storage")) * 1000000000,
                    ),
                    period: fields.get("period"),
                    revision: defaults.revision,
                  });
                  await load();
                });
              }}
            >
              <div class="inline-fields">
                <label
                  >Budget ($)<input
                    name="budget"
                    type="number"
                    min="0"
                    step="0.01"
                    required
                    value=${dollars(defaults.budgetMicroUsd)}
                /></label>
                <label
                  >Storage (GB)<input
                    name="storage"
                    type="number"
                    min="0"
                    step="0.01"
                    required
                    value=${gb(defaults.storageBytes)}
                /></label>
                <label
                  >Reset cadence<select name="period" value=${defaults.period}>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                  </select></label
                >
              </div>
              <button class="primary" type="submit" disabled=${feedback.saving}>
                Save defaults
              </button>
            </form>
          </section>`;
        }}<//
      >`;
  },
});
