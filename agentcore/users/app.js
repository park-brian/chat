import { createSignal, For, Show } from "solid-js";
import html from "solid-js/html";
import { mountPage } from "../shared/page.js";
import {
  bytesPerGb,
  createFeedback,
  createPager,
  exactAmount,
  fromAmount,
  microUsd,
  Badge,
  Empty,
  LoadMore,
  Skeleton,
} from "../shared/ui.js";

mountPage({
  key: "users",
  title: "Users",
  render: ({ rpc, pageUrl }) => {
    const [data, setData] = createSignal(null),
      feedback = createFeedback(),
      pager = createPager(feedback.report);
    async function load() {
      pager.reset();
      setData(await rpc("users.list"));
    }
    feedback.perform(load, "");
    return html`${feedback.view}
      <section class="panel">
        <h2>People</h2>
        <${Show}
          when=${data}
          fallback=${html`<${Skeleton} rows=${4} label="Loading users…" />`}
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
          <${LoadMore}
            when=${() => data()?.cursor}
            pager=${pager}
            label="Load more people"
            onMore=${() =>
              pager.more(
                () => rpc("users.list", { cursor: data().cursor }),
                (next) =>
                  setData((current) => ({
                    ...next,
                    defaults: current.defaults,
                    items: [...current.items, ...next.items],
                  })),
              )}
          />
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
      <${Show} when=${() => data()?.defaults} keyed=${true}
        >${(defaults) => {
          // Keyed: redrawn for each loaded copy, not when notices change.
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
                    budgetMicroUsd: fromAmount(
                      fields.get("budget"),
                      microUsd,
                      defaults.budgetMicroUsd,
                    ),
                    storageBytes: fromAmount(
                      fields.get("storage"),
                      bytesPerGb,
                      defaults.storageBytes,
                    ),
                    period: fields.get("period"),
                    revision: defaults.revision,
                  });
                  await load();
                }, undefined, load);
              }}
            >
              <div class="inline-fields">
                <label
                  >Budget ($)<input
                    name="budget"
                    type="number"
                    min="0"
                    step="any"
                    required
                    value=${exactAmount(defaults.budgetMicroUsd, microUsd)}
                /></label>
                <label
                  >Storage (GB)<input
                    name="storage"
                    type="number"
                    min="0"
                    step="any"
                    required
                    value=${exactAmount(defaults.storageBytes, bytesPerGb)}
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
