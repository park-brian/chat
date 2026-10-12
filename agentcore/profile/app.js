import { createSignal, Show } from "solid-js";
import html from "solid-js/html";
import { mountPage } from "../shared/page.js";
import {
  bytesPerGb,
  createFeedback,
  confirmAction,
  dollars,
  exactAmount,
  fromAmount,
  gb,
  isAdmin,
  microUsd,
  Badge,
  Skeleton,
} from "../shared/ui.js";

mountPage({
  key: "profile",
  title: "Profile",
  render: ({ rpc, session, pageUrl }) => {
    const [profile, setProfile] = createSignal(null),
      feedback = createFeedback();
    const selected = new URL(location.href).searchParams.get("user");
    const admin = () => isAdmin(session);
    async function load() {
      setProfile(await rpc("users.get", selected ? { userSub: selected } : {}));
    }
    const change = (command, input) =>
      feedback.perform(async () => {
        await rpc(command, { sub: profile().user.sub, ...input });
        await load();
      });
    feedback.perform(load, "");
    return html`${feedback.view}<${Show}
        when=${profile}
        keyed=${true}
        fallback=${html`<${Skeleton} rows=${4} label="Loading profile…" />`}
      >
        ${(current) => {
          // Keyed: redrawn for each loaded profile, not when notices change.
          const user = current.user;
          return html`<section class="panel">
              <div class="section-heading">
                <div>
                  <h2>${user.email}</h2>
                  <p>${user.sub}</p>
                </div>
                <${Badge} text=${user.enabled ? "Enabled" : "Disabled"} />
              </div>
              <dl>
                <div class="kv">
                  <dt>Role</dt>
                  <dd>${user.role || "No role"}</dd>
                </div>
                <div class="kv">
                  <dt>Identity status</dt>
                  <dd>${user.status}</dd>
                </div>
                <div class="kv">
                  <dt>Budget</dt>
                  <dd>
                    $${dollars(user.budgetMicroUsd)} ·
                    ${user.period}${user.budgetInherited ? " · Account default" : " · Override"}
                  </dd>
                </div>
                <div class="kv">
                  <dt>Storage</dt>
                  <dd>
                    ${gb(user.storageUsedBytes)} / ${gb(user.storageBytes)}
                    GB${user.storageInherited ? " · Account default" : " · Override"}
                  </dd>
                </div>
                <div class="kv">
                  <dt>Budget cadence</dt>
                  <dd>
                    ${user.periodInherited ? "Account default" : "Override"}
                  </dd>
                </div>
              </dl>
              <a
                class="secondary"
                href=${pageUrl("usage", { user: selected || null })}
                >View usage</a
              >
              <${Show} when=${user.protected}
                ><p class="help">
                  Protected bootstrap administrator. Role and access are fixed.
                </p><//
              >
            </section>
            <${Show} when=${admin}>
              <${Show} when=${!user.protected}
                ><section class="panel">
                  <h2>Access</h2>
                  <form
                    onInput=${feedback.changed}
                    onSubmit=${async (event) => {
                      event.preventDefault();
                      const fields = new FormData(event.currentTarget),
                        role = fields.get("role");
                      if (
                        await confirmAction(`Change ${user.email} to ${role}?`)
                      )
                        await change("users.setRole", { role });
                    }}
                  >
                    <label
                      >Role<select name="role" value=${user.role}>
                        <option>Members</option>
                        <option>Auditors</option>
                        <option>Administrators</option>
                      </select></label
                    >
                    <div class="actions">
                      <button type="submit" disabled=${feedback.saving}>
                        Save role
                      </button>
                      <button
                        type="button"
                        disabled=${feedback.saving}
                        onClick=${async () => {
                          if (
                            await confirmAction(
                              `${user.enabled ? "Disable" : "Enable"} access for ${user.email}?`,
                            )
                          )
                            await change("users.setEnabled", {
                              enabled: !user.enabled,
                            });
                        }}
                      >
                        ${user.enabled ? "Disable access" : "Enable access"}
                      </button>
                    </div>
                  </form>
                </section><//
              >
              <section class="panel">
                <h2>Limits</h2>
                <form
                  onInput=${feedback.changed}
                  onSubmit=${(event) => {
                    event.preventDefault();
                    const values = new FormData(event.currentTarget);
                    change("users.setLimits", {
                      budgetMicroUsd: values.has("inheritBudget")
                        ? null
                        : fromAmount(
                            values.get("budget"),
                            microUsd,
                            user.budgetMicroUsd,
                          ),
                      storageBytes: values.has("inheritStorage")
                        ? null
                        : fromAmount(
                            values.get("storage"),
                            bytesPerGb,
                            user.storageBytes,
                          ),
                      period: values.has("inheritPeriod")
                        ? null
                        : values.get("period"),
                    });
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
                        value=${exactAmount(user.budgetMicroUsd, microUsd)}
                        disabled=${user.budgetInherited}
                      />
                      <span class="check"
                        ><input
                          type="checkbox"
                          name="inheritBudget"
                          checked=${user.budgetInherited}
                          onChange=${(event) => (event.currentTarget.form.elements.budget.disabled = event.currentTarget.checked)}
                        />Use account default</span
                      ></label
                    >
                    <label
                      >Storage (GB)<input
                        name="storage"
                        type="number"
                        min="0"
                        step="any"
                        required
                        value=${exactAmount(user.storageBytes, bytesPerGb)}
                        disabled=${user.storageInherited}
                      />
                      <span class="check"
                        ><input
                          type="checkbox"
                          name="inheritStorage"
                          checked=${user.storageInherited}
                          onChange=${(event) => (event.currentTarget.form.elements.storage.disabled = event.currentTarget.checked)}
                        />Use account default</span
                      ></label
                    >
                    <label
                      >Reset cadence<select
                        name="period"
                        value=${user.period}
                        disabled=${user.periodInherited}
                      >
                        <option value="daily">Daily</option>
                        <option value="weekly">Weekly</option>
                        <option value="monthly">Monthly</option>
                      </select>
                      <span class="check"
                        ><input
                          type="checkbox"
                          name="inheritPeriod"
                          checked=${user.periodInherited}
                          onChange=${(event) => (event.currentTarget.form.elements.period.disabled = event.currentTarget.checked)}
                        />Use account default</span
                      ></label
                    >
                  </div>
                  <div class="actions">
                    <button
                      class="primary"
                      disabled=${feedback.saving}
                      type="submit"
                    >
                      Save limits</button
                    ><button
                      type="button"
                      disabled=${feedback.saving}
                      onClick=${async () => {
                        if (
                          await confirmAction(
                            `Start a new budget period for ${user.email}?`,
                          )
                        )
                          await change("users.startNewBudgetPeriod", {});
                      }}
                    >
                      Reset budget now
                    </button>
                  </div>
                </form>
              </section>
            <//>`;
        }}
      <//>`;
  },
});
