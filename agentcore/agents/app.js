import { createSignal, For, Show } from "solid-js";
import html from "solid-js/html";
import { mountPage } from "../shared/page.js";
import { updateQuery } from "../shared/navigation.js";
import { canWrite, confirmAction, createFeedback, createPager, gb, LoadMore, Skeleton } from "../shared/ui.js";
mountPage({
  key: "agents",
  title: "Agents",
  render: ({ rpc, session, projectId, pageUrl, setProjects: setShellProjects }) => {
    const [section, setSection] = createSignal(
      new URL(location.href).searchParams.get("section") || "agents",
    );
    const [projects, setProjects] = createSignal([]),
      [agents, setAgents] = createSignal([]),
      [models, setModels] = createSignal([]);
    // equals: false so clearing the editor after a create re-applies the blank form.
    const [view, setView] = createSignal(null),
      [editingAgent, setEditingAgent] = createSignal(null, { equals: false }),
      [draftModelId, setDraftModelId] = createSignal(null);
    const feedback = createFeedback(),
      setError = feedback.report,
      pager = createPager(setError);
    const writable = () => canWrite(session);
    let viewRequest = 0;
    const currentProject = () =>
      projects().find((item) => item.id === projectId()) || {
        name: "Main project",
      };
    const chosenModel = () =>
      models().find(
        (model) => model.id === (draftModelId() || editingAgent()?.modelId),
      ) || models().find((model) => model.active);
    const companyOf = (model) => model.company || "Other";
    const modelCompanies = () => [...new Set(models().map(companyOf))];
    // After a conflict the editor follows the reloaded copy of its agent.
    async function reloadEditing() {
      const id = editingAgent()?.id;
      await read();
      const fresh = id && agents().find((item) => item.id === id);
      setEditingAgent(fresh && !fresh.archived ? fresh : null);
      setDraftModelId(fresh?.modelId || null);
    }
    const setAgentArchived = (agent, archived) =>
      feedback.perform(
        async () => {
          const updated = await rpc("agents.setArchived", {
            projectId: projectId(),
            id: agent.id,
            revision: agent.revision || 0,
            archived,
          });
          setAgents((items) =>
            items.map((item) => (item.id === agent.id ? updated : item)),
          );
        },
        archived ? "Agent archived." : "Agent restored.",
        reloadEditing,
      );
    async function createAgent(form) {
      const fields = new FormData(form);
      if (fields.getAll("connectionId").length && !fields.has("codeInterpreter"))
        return setError("Enable code workspace to grant connections to this agent.");
      await feedback.perform(
        async () => {
          const editing = editingAgent();
          const result = await rpc("agents.put", {
            projectId: projectId(),
            ...(editing && { id: editing.id, revision: editing.revision || 0 }),
            name: fields.get("name"),
            modelId: fields.get("modelId"),
            systemPrompt: fields.get("systemPrompt"),
            thinkingLevel: fields.get("thinkingLevel") || undefined,
            codeInterpreter: fields.has("codeInterpreter"),
            webSearch: fields.has("webSearch"),
            browser: fields.has("browser"),
            webSearchMaxResults: Number(fields.get("webSearchMaxResults")),
            browserSessionSeconds: Number(fields.get("browserSessionSeconds")),
            connectionIds: fields.getAll("connectionId"),
            skillIds: fields.getAll("skillId"),
          });
          setAgents((items) =>
            editing
              ? items.map((item) => (item.id === result.id ? result : item))
              : [...items, result],
          );
          form.reset();
          setEditingAgent(null);
          setDraftModelId(null);
          await read();
        },
        undefined,
        reloadEditing,
      );
    }
    const moreObjects = () =>
      pager.more(
        () =>
          rpc("objects.list", {
            projectId: projectId(),
            cursor: view().nextCursor,
          }),
        (page) =>
          setView((current) => ({
            ...current,
            items: [...current.items, ...page.items],
            nextCursor: page.nextCursor,
          })),
      );
    function uploadObject(event) {
      event.preventDefault();
      const form = event.currentTarget,
        file = form.elements.file.files[0];
      if (!file) return;
      return feedback.perform(async () => {
        const started = await rpc("objects.beginUpload", {
          projectId: projectId(),
          name: file.name,
          sizeBytes: file.size,
          contentType: file.type || "application/octet-stream",
          kind: new FormData(form).get("kind"),
        });
        const fields = new FormData();
        for (const [name, value] of Object.entries(started.upload.fields))
          fields.append(name, value);
        fields.append("file", file);
        const uploaded = await fetch(started.upload.url, {
          method: "POST",
          body: fields,
        });
        if (!uploaded.ok)
          throw Error(
            `Upload failed (${uploaded.status}). Retry with a new upload.`,
          );
        await rpc("objects.completeUpload", {
          projectId: projectId(),
          id: started.id,
        });
        form.reset();
        await read();
      }, "Upload saved.");
    }
    async function downloadObject(item) {
      try {
        const result = await rpc("objects.get", {
          projectId: projectId(),
          id: item.id,
        });
        const link = document.createElement("a");
        link.href = result.url;
        link.download = item.name;
        link.rel = "noopener noreferrer";
        link.click();
      } catch (cause) {
        setError(cause.message);
      }
    }
    async function deleteObject(item) {
      if (!(await confirmAction(`Delete ${item.name}?`))) return;
      await feedback.perform(async () => {
        await rpc("objects.delete", { projectId: projectId(), id: item.id });
        await read();
      }, "Deleted.");
    }
    function createProject(event) {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      return feedback.perform(async () => {
        const created = await rpc("projects.create", {
          id: String(form.get("id") || "").trim(),
          name: String(form.get("name") || "").trim(),
        });
        feedback.clean();
        location.assign(pageUrl("agents", { project: created.id }));
      }, "");
    }
    const updateProject = (item, command, value) =>
      feedback.perform(
        async () => {
          await rpc(command, {
            id: item.id,
            revision: item.revision,
            ...(command === "projects.rename"
              ? { name: value }
              : { hidden: value }),
          });
          await read();
        },
        undefined,
        read,
      );

    async function availableSkills() {
      const items = [];
      let cursor;
      do {
        const page = await rpc("objects.list", {
          projectId: projectId(),
          cursor,
        });
        items.push(...page.items.filter((item) => item.kind === "skill"));
        cursor = page.nextCursor;
      } while (cursor);
      return items;
    }
    // Numbered so a slower read for an earlier tab never replaces the current view.
    async function read() {
      const request = ++viewRequest,
        current = () => request === viewRequest;
      pager.reset();
      // Project names are needed beside, not before, each section's own reads.
      const listed = rpc("projects.list").then((result) => {
        if (!current()) return;
        setProjects(result.items);
        setShellProjects(result.items);
      });
      if (section() === "projects") {
        await listed;
        if (current()) setView({ route: "projects", items: projects() });
        return;
      }
      if (section() === "skills") {
        const [, objects] = await Promise.all([
          listed,
          rpc("objects.list", { projectId: projectId() }),
        ]);
        if (current()) setView({ route: "skills", ...objects });
        return;
      }
      const [, saved, catalog, connections, objects] = await Promise.all([
        listed,
        rpc("agents.list", { projectId: projectId(), includeArchived: true }),
        rpc("models.list"),
        rpc("connections.list"),
        availableSkills(),
      ]);
      if (!current()) return;
      setAgents(saved.items);
      setModels(catalog.items);
      setView({
        route: "agents",
        connections: connections.items,
        skills: objects,
      });
    }
    const load = () => feedback.perform(read, "");
    load();
    // The section's child takes a parameter, so Show renders it once per shown
    // view and notices never redraw its forms.
    return html`${feedback.view}
      <nav class="section-tabs" aria-label="Agent sections">
        <${For} each=${["agents", "projects", "skills"]}
          >${(key) =>
            html`<button
              aria-current=${() => (section() === key ? "page" : undefined)}
              onClick=${async () => {
                if (!(await feedback.mayLeave())) return;
                feedback.clean();
                setView(null);
                setSection(key);
                updateQuery({ section: key });
                load();
              }}
            >
              ${{ agents: "Agents", projects: "Projects", skills: "Files & skills" }[key]}
            </button>`}<//
        >
      </nav>
      <section class="panel">
        <${Show}
          when=${view}
          fallback=${html`<${Skeleton} rows=${5} label="Loading agents…" />`}
          >${(shown) =>
            section() === "projects"
              ? html`<p class="help">
                    Projects separate agents, conversations and files. Your
                    budget, storage limit and private connection vault are
                    shared across them. Hiding a project removes it from the
                    picker, but its direct links still work.
                  </p>
                  <${Show} when=${() => writable()}>
                    <form onInput=${feedback.changed} onSubmit=${createProject}>
                      <div class="inline-fields">
                        <div class="field">
                          <label for="project-name">New project name</label>
                          <input
                            id="project-name"
                            name="name"
                            maxlength="80"
                            required
                          />
                        </div>
                        <div class="field">
                          <label for="project-id">Permanent slug</label>
                          <input
                            id="project-id"
                            name="id"
                            pattern="[a-z0-9][a-z0-9\\-]{0,39}"
                            maxlength="40"
                            placeholder="my-project"
                            required
                          />
                        </div>
                      </div>
                      <div class="actions">
                        <button class="primary" type="submit" disabled=${feedback.saving}>
                          Create project
                        </button>
                      </div>
                    </form>
                  <//>
                  <h3 class="section-title">Your projects</h3>
                  <${For}
                    each=${() => (view()?.route === "projects" ? view()?.items || [] : [])}
                  >
                    ${(item) =>
                      html`<div class="item">
                        <strong
                          >${item.name}${item.hidden ? " · Hidden" : ""}</strong
                        >
                        <small>${item.id}</small>
                        <div class="actions">
                          <a
                            class="secondary"
                            href=${pageUrl("agents", { project: item.id })}
                          >
                            Open
                          </a>
                          <${Show}
                            when=${() => item.id !== "main" && writable()}
                          >
                            <button
                              class="secondary"
                              disabled=${feedback.saving}
                              onClick=${() =>
                                updateProject(
                                  item,
                                  "projects.setHidden",
                                  !item.hidden,
                                )}
                            >
                              ${item.hidden ? "Show" : "Hide"}
                            </button>
                          <//>
                        </div>
                        <${Show}
                          when=${() => item.id !== "main" && writable()}
                        >
                          <form
                            onInput=${feedback.changed}
                            onSubmit=${(event) => {
                              event.preventDefault();
                              updateProject(
                                item,
                                "projects.rename",
                                new FormData(event.currentTarget).get("name"),
                              );
                            }}
                          >
                            <div class="field">
                              <label for=${"project-name-" + item.id}
                                >Display name</label
                              >
                              <input
                                id=${"project-name-" + item.id}
                                name="name"
                                maxlength="80"
                                value=${item.name}
                                required
                              />
                            </div>
                            <div class="actions">
                              <button class="secondary" type="submit" disabled=${feedback.saving}>
                                Rename
                              </button>
                            </div>
                          </form>
                        <//>
                      </div>`}<//
                  >`
              : section() === "skills"
                ? html`<p class="help">
                      Saved files, skills and artifacts share your
                      ${() => gb(view()?.limitBytes)} GB account limit. Current
                      use: ${() => gb(view()?.usedBytes)} GB. Temporary code
                      workspace files are not included.
                    </p>
                    <${Show} when=${() => writable()}>
                      <form
                        onInput=${feedback.changed}
                        onSubmit=${uploadObject}
                      >
                        <div class="inline-fields">
                          <div class="field">
                            <label for="object-file">File</label>
                            <input
                              id="object-file"
                              name="file"
                              type="file"
                              required
                            />
                          </div>
                          <div class="field">
                            <label for="object-kind">Type</label>
                            <select id="object-kind" name="kind">
                              <option value="file">File</option>
                              <option value="skill">Skill</option>
                              <option value="artifact">Artifact</option>
                            </select>
                          </div>
                        </div>
                        <div class="actions">
                          <button class="primary" type="submit" disabled=${feedback.saving}>
                            Upload
                          </button>
                        </div>
                      </form>
                    <//>
                    <h3 class="section-title">
                      Saved in ${() => currentProject().name}
                    </h3>
                    <${For}
                      each=${() => (view()?.route === "skills" ? view()?.items || [] : [])}
                    >
                      ${(item) =>
                        html`<div class="item">
                          <strong>${item.name}</strong>
                          <small
                            >${item.kind} · ${item.sizeBytes?.toLocaleString()}
                            bytes</small
                          >
                          <div class="actions">
                            <button
                              class="secondary"
                              onClick=${() => downloadObject(item)}
                            >
                              Download
                            </button>
                            <${Show}
                              when=${() => writable()}
                            >
                              <button
                                class="secondary"
                                onClick=${() => deleteObject(item)}
                              >
                                Delete
                              </button><//
                            >
                          </div>
                        </div>`}<//
                    >
                    <${Show} when=${() => !view()?.items?.length}>
                      <div class="empty">
                        No saved objects in this project.
                      </div><//
                    >
                    <${LoadMore}
                      when=${() => view()?.nextCursor}
                      pager=${pager}
                      onMore=${moreObjects}
                    />`
                : html` <p class="help">
                      Create and manage agents for this project. Choose a model,
                      instructions, and the tools it may use.
                    </p>
                    <div class="agents-split">
                    <div class="agents-index">
                    <h3 class="section-title">In this project</h3>
                    <${Show}
                      when=${() => agents().length}
                      fallback=${html`<div class="empty">No agents found in this project.</div>`}
                    >
                      <div class="agent-list">
                        <${For} each=${agents}
                          >${(agent) =>
                            html` <div class="item">
                              <strong
                                >${agent.name}</strong
                              >
                              <small
                                >${agent.modelId}${agent.archived ? " · Archived" : ""}</small
                              >
                              <div class="actions">
                                <a
                                  class="secondary"
                                  href=${agent.archived ? undefined : pageUrl("chat", { agent: agent.id })}
                                  aria-disabled=${agent.archived}
                                >
                                  Open chat
                                </a>
                                <button
                                  class="secondary"
                                  type="button"
                                  disabled=${() => agent.archived || !writable()}
                                  onClick=${async () => {
                                    if (!(await feedback.mayLeave())) return;
                                    feedback.clean();
                                    setEditingAgent(agent);
                                    setDraftModelId(agent.modelId);
                                  }}
                                >
                                  Edit
                                </button>
                                <button
                                  class="secondary"
                                  type="button"
                                  disabled=${() => !writable() || feedback.saving() || editingAgent()?.id === agent.id}
                                  title=${() => (editingAgent()?.id === agent.id ? "Finish or cancel the edit first" : undefined)}
                                  onClick=${() => setAgentArchived(agent, !agent.archived)}
                                >
                                  ${agent.archived ? "Restore" : "Archive"}
                                </button>
                              </div>
                            </div>`}<//
                        >
                      </div><//
                    >
                    </div>
                    <${Show} when=${writable}
                      ><form
                        class="agent-editor"
                        onInput=${feedback.changed}
                        onSubmit=${(event) => {
                          event.preventDefault();
                          createAgent(event.currentTarget);
                        }}
                      >
                        <h2 class="editor-title">
                          ${() => (editingAgent() ? "Edit " + (editingAgent().name || "agent") : "New agent")}
                        </h2>
                        <div class="field">
                          <label for="agent-name">Agent name</label
                          ><input
                            id="agent-name"
                            name="name"
                            required
                            maxlength="80"
                            value=${() => editingAgent()?.name || ""}
                          />
                        </div>
                        <div class="field">
                          <label for="agent-model">Default model</label
                          ><select
                            id="agent-model"
                            name="modelId"
                            required
                            onChange=${(event) => {
                              setDraftModelId(event.currentTarget.value);
                              for (const tool of event.currentTarget.form.querySelectorAll(
                                "[data-model-tool]",
                              )) {
                                tool.disabled =
                                  tool.name === "browser" &&
                                  !chosenModel()?.browserTool;
                                if (tool.disabled) tool.checked = false;
                              }
                            }}
                          >
                            <${For} each=${modelCompanies}
                              >${(company) =>
                                html` <optgroup label=${company}>
                                  <${For}
                                    each=${() =>
                                      models().filter(
                                        (model) => companyOf(model) === company,
                                      )}
                                  >
                                    ${(model) =>
                                      html`<option
                                        value=${model.id}
                                        disabled=${!model.active}
                                        selected=${() => chosenModel()?.id === model.id}
                                      >
                                        ${model.name}${model.active ? "" : " · not configured"}
                                      </option>`}<//
                                  >
                                </optgroup>`}<//
                            >
                          </select>
                        </div>
                        <div class="field">
                          <label for="agent-prompt">Instructions</label
                          ><textarea
                            id="agent-prompt"
                            name="systemPrompt"
                            rows="3"
                            value=${() => editingAgent()?.systemPrompt || ""}
                          ></textarea>
                        </div>
                        <div class="field">
                          <label>Model capacity</label>
                          <p class="help">
                            ${() =>
                              `${chosenModel()?.contextTokens?.toLocaleString() || "—"} context · ${chosenModel()?.maxOutputTokens?.toLocaleString() || "—"} maximum output tokens per turn.`}
                          </p>
                        </div>
                        <${Show}
                          when=${() => chosenModel()?.thinkingLevels?.length}
                        >
                          <div class="field">
                            <label for="agent-thinking"
                              >Default thinking level</label
                            >
                            <select id="agent-thinking" name="thinkingLevel">
                              <${For}
                                each=${() => chosenModel()?.thinkingLevels || []}
                              >
                                ${(level) =>
                                  html`<option
                                    value=${level}
                                    selected=${() =>
                                      level ===
                                      ((editingAgent()?.modelId ===
                                      chosenModel()?.id
                                        ? editingAgent()?.thinkingLevel
                                        : null) ||
                                        chosenModel()?.defaultThinkingLevel)}
                                  >
                                    ${level}
                                  </option>`}<//
                              >
                            </select>
                          </div>
                        <//>
                        <div class="field">
                          <label class="check"
                            ><input
                              type="checkbox"
                              name="codeInterpreter"
                              data-model-tool
                              checked=${() => Boolean(editingAgent()?.codeInterpreter)}
                            />
                            Enable code workspace</label
                          >
                          <p class="help">
                            Python, Node, shell, AWS CLI and internet access in
                            an isolated session. No account credentials are
                            granted automatically.
                          </p>
                        </div>
                        <div class="field">
                          <label class="check"
                            ><input
                              type="checkbox"
                              name="webSearch"
                              data-model-tool
                              checked=${() => Boolean(editingAgent()?.webSearch)}
                            />
                            Enable web search</label
                          >
                          <p class="help">
                            Current public results through AgentCore Gateway.
                            Source links appear beneath the reply.
                          </p>
                          <label for="agent-search-results"
                            >Maximum results per search</label
                          >
                          <input
                            id="agent-search-results"
                            name="webSearchMaxResults"
                            type="number"
                            min="1"
                            max="25"
                            value=${() => editingAgent()?.webSearchMaxResults || 5}
                            required
                          />
                        </div>
                        <div class="field">
                          <label class="check"
                            ><input
                              type="checkbox"
                              name="browser"
                              data-model-tool
                              disabled=${() => !chosenModel()?.browserTool}
                              checked=${() => Boolean(editingAgent()?.browser)}
                            />
                            Enable browser</label
                          >
                          <p class="help">
                            Visual browsing works with Claude or configured
                            Gemini; GPT-6 can use Web Search instead. The
                            isolated browser has no site logins or saved profile
                            and stops after each turn.
                          </p>
                          <label for="agent-browser-timeout"
                            >Session timeout (seconds)</label
                          >
                          <input
                            id="agent-browser-timeout"
                            name="browserSessionSeconds"
                            type="number"
                            min="60"
                            max="900"
                            value=${() => editingAgent()?.browserSessionSeconds || 300}
                            required
                          />
                        </div>
                        <${Show} when=${() => view()?.connections?.length}>
                          <div class="field">
                            <label>Grant connections to this agent</label>
                            <${For} each=${() => view()?.connections || []}
                              >${(item) =>
                                html` <label class="check"
                                  ><input
                                    type="checkbox"
                                    name="connectionId"
                                    value=${item.id}
                                    checked=${() => Boolean(editingAgent()?.connectionIds?.includes(item.id))}
                                  />
                                  ${item.name} · ${item.kind}</label
                                >`}<//
                            >
                            <p class="help">
                              Enable code workspace to use a grant. Generated
                              code can read the selected keys.
                            </p>
                          </div><//
                        >
                        <${Show} when=${() => view()?.skills?.length}>
                          <div class="field">
                            <label>Use saved skills</label>
                            <${For} each=${() => view()?.skills || []}
                              >${(item) =>
                                html` <label class="check"
                                  ><input
                                    type="checkbox"
                                    name="skillId"
                                    value=${item.id}
                                    checked=${() => Boolean(editingAgent()?.skillIds?.includes(item.id))}
                                  />
                                  ${item.name}</label
                                >`}<//
                            >
                            <p class="help">
                              Selected skill text enters this agent's
                              instructions and code workspace. Removing a skill
                              stops future turns until the agent is
                              reconfigured.
                            </p>
                          </div><//
                        >
                        <div class="actions">
                          <${Show} when=${editingAgent}
                            ><button
                              class="secondary"
                              type="button"
                              onClick=${async () => {
                                if (!(await feedback.mayLeave())) return;
                                feedback.clean();
                                setEditingAgent(null);
                                setDraftModelId(null);
                              }}
                            >
                              Cancel edit
                            </button><//
                          >
                          <button class="primary" type="submit" disabled=${feedback.saving}>
                            ${() => (editingAgent() ? "Save agent" : "Create agent")}
                          </button>
                        </div>
                      </form>
                    <//>
                    </div>`}<//
        >
      </section>`;
  },
});
