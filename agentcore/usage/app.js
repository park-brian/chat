import { createSignal, For, Show } from "solid-js";
import html from "solid-js/html";
import { mountPage } from "../shared/page.js";
import { updateQuery } from "../shared/navigation.js";
import { createFeedback, confirmAction, dollars, gb } from "../shared/ui.js";
mountPage({
  key: "usage",
  title: "Usage",
  render: ({ rpc, session }) => {
    const query = new URL(location.href).searchParams;
    const [view, setView] = createSignal(null),
      [projects, setProjects] = createSignal([]);
    const feedback = createFeedback(),
      setError = feedback.report;
    let viewRequest = 0;
    const [usageRange, setUsageRange] = createSignal(
      query.get("range") || "30d",
    );
    const [usageSort, setUsageSort] = createSignal(query.get("sort") || "desc");
    const [usageScope, setUsageScope] = createSignal(
      query.get("scope") || "self",
    );
    const [usageUser, setUsageUser] = createSignal(
      query.get("user")
        ? { sub: query.get("user"), email: query.get("user") }
        : null,
    );
    const [usageDetail, setUsageDetail] = createSignal(null);
    const [usageProject, setUsageProject] = createSignal(
      query.get("usageProject") || "all",
    );
    const [usageFilters, setUsageFilters] = createSignal(
      Object.fromEntries(
        [
          "from",
          "to",
          "agentId",
          "requestId",
          "tool",
          "kind",
          "quality",
          "status",
        ]
          .filter((key) => query.has(key))
          .map((key) => [key, query.get(key)]),
      ),
    );
    const usageQuery = () => ({
      range: usageRange(),
      sort: usageSort(),
      scope: usageScope(),
      ...usageFilters(),
      ...(usageScope() === "self" &&
        usageUser() && { userSub: usageUser().sub }),
      ...(usageProject() !== "all" && { projectId: usageProject() }),
    });
    const periodLabel = (key) => {
      const [, cadence, date] = (key || "").split("#");
      return date
        ? cadence[0].toUpperCase() +
            cadence.slice(1) +
            " · " +
            new Date(date + "T00:00:00Z").toLocaleDateString(undefined, {
              timeZone: "UTC",
              month: "short",
              day: "numeric",
              year: "numeric",
            })
        : "—";
    };
    async function moreUsage() {
      const cursor = view()?.nextCursor;
      if (!cursor) return;
      const request = viewRequest;
      try {
        const page = await rpc("usage.list", { ...usageQuery(), cursor });
        if (request === viewRequest)
          setView((current) => ({
            ...current,
            items: [...current.items, ...page.items],
            nextCursor: page.nextCursor,
          }));
      } catch (cause) {
        if (request === viewRequest) setError(cause.message);
      }
    }
    async function moreDaily() {
      const cursor = view()?.daily?.nextCursor;
      if (!cursor) return;
      const request = viewRequest;
      try {
        const page = await rpc("usage.daily", {
          range: usageRange(),
          scope: usageScope(),
          cursor,
          ...(usageScope() === "self" &&
            usageUser() && { userSub: usageUser().sub }),
        });
        if (request === viewRequest)
          setView((current) => ({
            ...current,
            daily: {
              items: [...current.daily.items, ...page.items],
              nextCursor: page.nextCursor,
            },
          }));
      } catch (cause) {
        if (request === viewRequest) setError(cause.message);
      }
    }
    async function inspectUsage(item) {
      setError("");
      try {
        setUsageDetail(
          await rpc("usage.request", {
            requestId: item.requestId,
            ...(item.userSub && { userSub: item.userSub }),
          }),
        );
      } catch (cause) {
        setError(cause.message);
      }
    }

    async function loadView() {
      const request = ++viewRequest;
      updateQuery({
        range: usageRange(),
        sort: usageSort(),
        scope: usageScope(),
        user: usageUser()?.sub,
        usageProject: usageProject(),
        ...Object.fromEntries(
          [
            "from",
            "to",
            "agentId",
            "requestId",
            "tool",
            "kind",
            "quality",
            "status",
          ].map((key) => [key, usageFilters()[key] || null]),
        ),
      });
      await feedback.perform(async () => {
        const result = await rpc("usage.get", {
          ...usageQuery(),
          includeDaily: true,
        });
        if (request === viewRequest) setView({ route: "usage", ...result });
      }, "");
    }
    feedback.perform(async () => {
      setProjects((await rpc("projects.list")).items);
      if (usageUser() && session().user.role === "Administrators")
        setUsageUser(
          (await rpc("users.get", { userSub: usageUser().sub })).user,
        );
      await loadView();
    }, "");
    return html`${feedback.view}
      <section class="panel">
        <${Show}
          when=${view}
          fallback=${html`<div class="empty">Loading usage…</div>`}
          >${() =>
            html`<p class="help">
                Model costs estimate reported tokens using the checked-in rates.
                Provider tiers, discounts and other AWS charges may differ.
                Unpriced managed-tool calls are shown separately, not guessed.
              </p>
              <${Show} when=${usageUser}>
                <div class="path-bar">
                  Viewing ${() => usageUser()?.email}
                  <button
                    class="message-action"
                    onClick=${() => {
                      setUsageUser(null);
                      setUsageScope("self");
                      loadView("usage");
                    }}
                  >
                    My usage
                  </button>
                </div><//
              >
              <dl>
                <div class="kv">
                  <dt>Budget period</dt>
                  <dd>${() => periodLabel(view()?.period)}</dd>
                </div>
                <div class="kv">
                  <dt>
                    ${() => (usageScope() === "all" ? "My period cost" : "Period cost")}
                  </dt>
                  <dd>
                    ${() => (view()?.quality === "unmetered" ? "Not yet metered" : "$" + dollars(view()?.costMicroUsd))}
                  </dd>
                </div>
                <div class="kv">
                  <dt>Budget</dt>
                  <dd>$${() => dollars(view()?.budgetMicroUsd)}</dd>
                </div>
                <div class="kv">
                  <dt>Unpriced tool calls</dt>
                  <dd>${() => view()?.unpricedToolCalls || 0}</dd>
                </div>
                <div class="kv">
                  <dt>
                    ${() => (usageRange() === "90d" ? "Last 90 days" : "Last 30 days")}
                  </dt>
                  <dd>
                    ${() =>
                      "$" +
                      dollars(
                        (view()?.daily?.items || []).reduce(
                          (sum, day) => sum + Number(day.costMicroUsd || 0),
                          0,
                        ),
                      ) +
                      (view()?.daily?.nextCursor
                        ? " loaded so far"
                        : " model estimate")}
                  </dd>
                </div>
              </dl>
              <${Show} when=${() => view()?.daily?.nextCursor}>
                <button class="secondary" onClick=${moreDaily}>
                  Load more daily totals
                </button><//
              >
              <h3 class="section-title">Requests and tools</h3>
              <div class="inline-fields">
                <div class="field">
                  <label for="usage-range">Time range</label>
                  <select
                    id="usage-range"
                    value=${usageRange}
                    onChange=${(event) => {
                      setUsageRange(event.currentTarget.value);
                      loadView("usage");
                    }}
                  >
                    <option value="30d">Last 30 days</option>
                    <option value="90d">Last 90 days</option>
                  </select>
                </div>
                <div class="field">
                  <label for="usage-sort">Order</label>
                  <select
                    id="usage-sort"
                    value=${usageSort}
                    onChange=${(event) => {
                      setUsageSort(event.currentTarget.value);
                      loadView("usage");
                    }}
                  >
                    <option value="desc">Newest first</option>
                    <option value="asc">Oldest first</option>
                  </select>
                </div>
                <${Show}
                  when=${() => session()?.user?.role === "Administrators"}
                >
                  <div class="field">
                    <label for="usage-scope">People</label>
                    <select
                      id="usage-scope"
                      value=${usageScope}
                      onChange=${(event) => {
                        setUsageScope(event.currentTarget.value);
                        if (event.currentTarget.value === "all")
                          setUsageUser(null);
                        loadView("usage");
                      }}
                    >
                      <option value="self">
                        ${() => (usageUser() ? "Selected user" : "My usage")}
                      </option>
                      <option value="all">All users</option>
                    </select>
                  </div><//
                >
                <div class="field">
                  <label for="usage-project">Project</label>
                  <select
                    id="usage-project"
                    value=${usageProject}
                    onChange=${(event) => {
                      setUsageProject(event.currentTarget.value);
                      loadView("usage");
                    }}
                  >
                    <option value="all">All projects</option>
                    <${For} each=${projects}
                      >${(item) =>
                        html` <option value=${item.id}>
                          ${item.name}
                        </option>`}<//
                    >
                  </select>
                </div>
              </div>
              <details>
                <summary>Advanced filters</summary>
                <form
                  onSubmit=${(event) => {
                    event.preventDefault();
                    const values = Object.fromEntries(
                      [...new FormData(event.currentTarget)]
                        .filter(([, value]) => String(value).trim())
                        .map(([name, value]) => [name, String(value).trim()]),
                    );
                    setUsageFilters(values);
                    loadView("usage");
                  }}
                >
                  <div class="inline-fields">
                    <div class="field">
                      <label for="usage-filter-from">From (UTC)</label
                      ><input
                        id="usage-filter-from"
                        type="date"
                        name="from"
                        value=${() => usageFilters().from || ""}
                      />
                    </div>
                    <div class="field">
                      <label for="usage-filter-to">To (UTC)</label
                      ><input
                        id="usage-filter-to"
                        type="date"
                        name="to"
                        value=${() => usageFilters().to || ""}
                      />
                    </div>
                    <div class="field">
                      <label for="usage-filter-agentId">Agent ID</label
                      ><input
                        id="usage-filter-agentId"
                        name="agentId"
                        value=${() => usageFilters().agentId || ""}
                      />
                    </div>
                    <div class="field">
                      <label for="usage-filter-requestId">Request ID</label
                      ><input
                        id="usage-filter-requestId"
                        name="requestId"
                        value=${() => usageFilters().requestId || ""}
                      />
                    </div>
                    <div class="field">
                      <label for="usage-filter-tool">Tool name</label
                      ><input
                        id="usage-filter-tool"
                        name="tool"
                        value=${() => usageFilters().tool || ""}
                      />
                    </div>
                    <div class="field">
                      <label for="usage-filter-kind">Kind</label
                      ><select
                        id="usage-filter-kind"
                        name="kind"
                        value=${() => usageFilters().kind || ""}
                      >
                        <option value="">Any</option>
                        <option value="model">Model</option>
                        <option value="tool">Tool</option>
                      </select>
                    </div>
                    <div class="field">
                      <label for="usage-filter-quality">Quality</label
                      ><select
                        id="usage-filter-quality"
                        name="quality"
                        value=${() => usageFilters().quality || ""}
                      >
                        <option value="">Any</option>
                        <option value="estimated">Estimated</option>
                        <option value="unpriced">Unpriced</option>
                        <option value="unknown">Unknown</option>
                      </select>
                    </div>
                    <div class="field">
                      <label for="usage-filter-status">Request status</label
                      ><select
                        id="usage-filter-status"
                        name="status"
                        value=${() => usageFilters().status || ""}
                      >
                        <option value="">Any</option>
                        <option value="completed">Completed</option>
                        <option value="cancelled">Cancelled</option>
                        <option value="outcome_unknown">Unknown outcome</option>
                        <option value="memory_failed">Memory failed</option>
                        <option value="navigation_failed">
                          Navigation failed
                        </option>
                        <option value="running">Running</option>
                      </select>
                    </div>
                  </div>
                  <div class="actions">
                    <button class="secondary" type="submit">
                      Apply filters
                    </button>
                    <button
                      class="secondary"
                      type="button"
                      onClick=${() => {
                        setUsageFilters({});
                        loadView("usage");
                      }}
                    >
                      Clear
                    </button>
                  </div>
                </form>
              </details>
              <${For}
                each=${() => (view()?.route === "usage" ? view()?.items || [] : [])}
              >
                ${(item) =>
                  html`<div class="item">
                    <strong>${item.name || item.modelId || "Request"}</strong>
                    <small
                      >${new Date(item.occurredAt).toLocaleString()} ·
                      ${usageScope() === "all" ? "user " + String(item.userSub || "unknown").slice(0, 8) + " · " : ""}
                      ${item.projectId || "main"} ·
                      ${item.quality === "unpriced" ? "Tool · unpriced" : "Model · " + item.inputTokens + " in / " + item.outputTokens + " out"}
                      ${item.latencyMs === undefined ? "" : " · " + item.latencyMs + " ms"}
                      ·
                      ${
                        item.quality === "unpriced"
                          ? "cost unpriced"
                          : "$" +
                            (Number(item.costMicroUsd || 0) / 1000000).toFixed(
                              6,
                            ) +
                            " estimated"
                      }</small
                    >
                    <button
                      class="secondary"
                      type="button"
                      onClick=${() => inspectUsage(item)}
                    >
                      Request detail
                    </button>
                  </div>`}<//
              >
              <${Show} when=${usageDetail}>
                <div class="item">
                  <strong
                    >Request ${() => usageDetail()?.request?.requestId}</strong
                  >
                  <small
                    >${() => usageDetail()?.request?.status} ·
                    $${() => dollars(usageDetail()?.request?.costMicroUsd)}
                    model estimate ·
                    ${() => usageDetail()?.request?.toolSteps || 0} unpriced
                    tools</small
                  >
                  <${For} each=${() => usageDetail()?.steps || []}>
                    ${(step) =>
                      html`<small
                        >${
                          step.kind === "tool"
                            ? step.name
                            : step.modelId +
                              " · " +
                              step.inputTokens +
                              " input / " +
                              step.outputTokens +
                              " output tokens"
                        }
                        · ${step.quality} ·
                        ${
                          step.quality === "unpriced"
                            ? "cost unknown"
                            : "$" +
                              (
                                Number(step.costMicroUsd || 0) / 1000000
                              ).toFixed(6) +
                              " estimated"
                        }</small
                      >`}<//
                  >
                </div><//
              >
              <${Show} when=${() => !view()?.items?.length}
                ><div class="empty">No requests in this range.</div><//
              >
              <${Show} when=${() => view()?.nextCursor}
                ><div class="actions">
                  <button class="secondary" onClick=${moreUsage}>
                    Load more
                  </button>
                </div><//
              >`}
          <${Show} when=${usageDetail}
            ><div class="actions">
              <button
                onClick=${async () => {
                  if (
                    await confirmAction(
                      "Reconcile this request using its saved receipts?",
                    )
                  )
                    await feedback.perform(async () => {
                      const request = usageDetail().request;
                      await rpc("usage.reconcile", {
                        requestId: request.requestId,
                        ...(request.userSub && { userSub: request.userSub }),
                      });
                      await inspectUsage(request);
                      await loadView();
                    }, "Reconciliation checked.");
                }}
              >
                Reconcile request
              </button>
            </div><//
          >
        <//>
      </section>`;
  },
});
