import { createSignal, For, Show, onCleanup } from "solid-js";
import html from "solid-js/html";
import { mountPage } from "./shared/page.js";
import { parseDeployment } from "./shared/session.js";
import { createFeedback, confirmAction } from "./shared/ui.js";

await mountPage({
  key: "chat",
  title: "Chat",
  render: ({ rpc, watch, session, pageUrl }) => {
    const query = new URL(location.href).searchParams,
      feedback = createFeedback();
    const [error, setError] = createSignal(""),
      [activeRun, setActiveRun] = createSignal(null),
      [files, setFiles] = createSignal([]),
      [filesCursor, setFilesCursor] = createSignal(null);
    let observer, fileDialog, fileDialogTrigger;
    onCleanup(() => observer?.abort());
    const openFiles = () => {
      fileDialogTrigger = document.activeElement;
      fileDialog.showModal();
    };
    const [projects, setProjects] = createSignal([]);
    const [projectId] = createSignal(
      /^[a-z0-9][a-z0-9-]{0,39}$/.test(query.get("project") || "")
        ? query.get("project")
        : "main",
    );
    const currentProject = () =>
      projects().find((item) => item.id === projectId()) || {
        id: "main",
        name: "Main project",
        hidden: false,
      };
    function showRoute(
      project = projectId(),
      conversation = null,
      branch = "main",
    ) {
      const url = new URL(location.href);
      url.searchParams.set("project", project);
      if (conversation) url.searchParams.set("conversation", conversation);
      else url.searchParams.delete("conversation");
      if (selectedAgent()) url.searchParams.set("agent", selectedAgent().id);
      else url.searchParams.delete("agent");
      if (conversation && branch !== "main")
        url.searchParams.set("branch", branch);
      else url.searchParams.delete("branch");
      history.replaceState(history.state, "", url.pathname + url.search);
    }
    const [agents, setAgents] = createSignal([]);
    const [models, setModels] = createSignal([]);
    const [selectedAgent, setSelectedAgent] = createSignal(null);
    const [composerChoice, setComposerChoice] = createSignal(null);
    const modelAllowed = (model, agent) =>
      model.active && !(agent?.browser && !model.browserTool);
    const composerModel = () => {
      const agent = selectedAgent();
      if (!agent) return null;
      const choice = composerChoice();
      return models().find(
        (model) =>
          model.id ===
          (choice?.agentId === agent.id ? choice.modelId : agent.modelId),
      );
    };
    const composerThinking = () => {
      const agent = selectedAgent(),
        model = composerModel(),
        choice = composerChoice();
      if (!model?.thinkingLevels?.length) return null;
      const level =
        (choice?.agentId === agent?.id &&
          choice.modelId === model.id &&
          choice.thinkingLevel) ||
        (model.id === agent?.modelId ? agent.thinkingLevel : null);
      return model.thinkingLevels.includes(level)
        ? level
        : model.defaultThinkingLevel;
    };
    const [conversationId, setConversationId] = createSignal(
      crypto.randomUUID(),
    );
    const [branchId, setBranchId] = createSignal("main");
    const [branches, setBranches] = createSignal([
      { id: "main", name: "Main", headEventId: null },
    ]);
    const [headEventId, setHeadEventId] = createSignal(null);
    const [forkFrom, setForkFrom] = createSignal(null);
    const [conversations, setConversations] = createSignal([]);
    const [conversationCursor, setConversationCursor] = createSignal(null);
    const [olderCursor, setOlderCursor] = createSignal(null);
    const [uncertainConversationId, setUncertainConversationId] =
      createSignal(null);
    const [messages, setMessages] = createSignal([]);
    const [draft, setDraft] = createSignal("");
    const [selectedFiles, setSelectedFiles] = createSignal([]);
    const [saveOutputs, setSaveOutputs] = createSignal(false);
    const [sending, setSending] = createSignal(false);
    const [loadingConversation, setLoadingConversation] = createSignal(false);
    let conversationRequest = 0;
    function newChat(agent = selectedAgent()) {
      ++conversationRequest;
      setSelectedAgent(agent);
      setConversationId(crypto.randomUUID());
      setBranchId("main");
      setBranches([{ id: "main", name: "Main", headEventId: null }]);
      setHeadEventId(null);
      setForkFrom(null);
      setOlderCursor(null);
      setUncertainConversationId(null);
      setMessages([]);
      setSaveOutputs(false);
      setError("");
      setLoadingConversation(false);
      showRoute(projectId());
    }
    async function openConversation(
      item,
      selectedBranch = item.activeBranchId || "main",
    ) {
      if (sending()) return;
      const agent = agents().find((entry) => entry.id === item.agentId);
      if (!agent) return;
      const request = ++conversationRequest;
      setSelectedAgent(agent);
      setConversationId(item.id);
      showRoute(projectId(), item.id, selectedBranch);
      setOlderCursor(null);
      setMessages([]);
      setError("");
      setLoadingConversation(true);
      try {
        const page = await rpc("conversations.get", {
          projectId: projectId(),
          agentId: agent.id,
          conversationId: item.id,
          branchId: selectedBranch,
        });
        if (request === conversationRequest) {
          setMessages(page.messages);
          const active = page.activeRequests?.find(
            (run) =>
              run.branchId === selectedBranch &&
              ["running", "memory_written"].includes(run.status),
          );
          if (active) {
            setActiveRun(active.requestId);
            setMessages((items) => [
              ...items,
              { role: "assistant", text: "", status: "pending" },
            ]);
            observeRun(active.requestId, true);
          }
          setBranchId(selectedBranch);
          setBranches(page.branches);
          setHeadEventId(
            page.branches.find((branch) => branch.id === selectedBranch)
              ?.headEventId ||
              page.messages.at(-1)?.eventId ||
              null,
          );
          setForkFrom(null);
          setOlderCursor(page.nextCursor);
          setUncertainConversationId(
            page.historyExpired || page.archiveIncomplete ? item.id : null,
          );
          if (page.historyExpired)
            setError(
              "This older development conversation has expired. Start a new chat.",
            );
          else if (page.archiveIncomplete)
            setError(
              "Part of this saved conversation is unavailable. Continuing is disabled.",
            );
        }
      } catch (cause) {
        if (request === conversationRequest) setError(cause.message);
      } finally {
        if (request === conversationRequest) setLoadingConversation(false);
      }
    }
    async function deleteConversation() {
      const id = conversationId(),
        agent = selectedAgent();
      if (
        !agent ||
        !conversations().some((item) => item.id === id) ||
        !(await confirmAction(
          "Delete this conversation and its saved history? Usage records remain.",
        ))
      )
        return;
      setLoadingConversation(true);
      setError("");
      try {
        let deleted = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const result = await rpc("conversations.delete", {
            projectId: projectId(),
            conversationId: id,
            agentId: agent.id,
          });
          if (result.deleted) {
            deleted = true;
            break;
          }
          if (!result.deleting) break;
        }
        if (!deleted)
          throw Error(
            "Deletion is still in progress. Try again to finish cleanup.",
          );
        setConversations((items) => items.filter((item) => item.id !== id));
        newChat(agent.archived ? null : agent);
      } catch (cause) {
        setError(cause.message);
      } finally {
        setLoadingConversation(false);
      }
    }
    function forkAt(index, retry = false) {
      if (
        sending() ||
        loadingConversation() ||
        uncertainConversationId() ||
        (index < 2 && olderCursor())
      )
        return;
      const items = messages();
      const userIndex = retry ? index - 1 : index;
      const rootEventId = items.slice(0, userIndex).at(-1)?.eventId || null;
      setForkFrom({ fromIndex: userIndex, rootEventId });
      setDraft(items[userIndex].text);
      if (retry) send();
    }
    function selectAgent(agent) {
      if (sending() || !agent) return;
      const recent = conversations().find((item) => item.agentId === agent.id);
      if (recent) openConversation(recent);
      else newChat(agent);
    }
    async function moreConversations() {
      const cursor = conversationCursor();
      if (!cursor) return;
      try {
        const page = await rpc("conversations.list", {
          projectId: projectId(),
          cursor,
        });
        setConversations((items) => [
          ...items,
          ...page.items.filter(
            (item) => !items.some((existing) => existing.id === item.id),
          ),
        ]);
        setConversationCursor(page.nextCursor);
      } catch (cause) {
        setError(cause.message);
      }
    }
    async function moreMessages() {
      const cursor = olderCursor(),
        agent = selectedAgent(),
        id = conversationId();
      if (!cursor || !agent || sending()) return;
      try {
        const page = await rpc("conversations.get", {
          projectId: projectId(),
          agentId: agent.id,
          conversationId: id,
          branchId: branchId(),
          cursor,
        });
        if (id === conversationId()) {
          setMessages((items) => [...page.messages, ...items]);
          setOlderCursor(page.nextCursor);
        }
      } catch (cause) {
        setError(cause.message);
      }
    }
    const modelCompanies = ["Anthropic", "OpenAI", "Google", "Amazon", "Other"];
    const modelCompany = (model) =>
      model.company ||
      (/anthropic/.test(model.id)
        ? "Anthropic"
        : /openai/.test(model.id)
          ? "OpenAI"
          : /gemini/.test(model.id)
            ? "Google"
            : /amazon/.test(model.id)
              ? "Amazon"
              : "Other");

    const messageSections = (value) =>
      String(value || "")
        .split(/(```[^\n]*\n[\s\S]*?(?:```|$))/g)
        .filter(Boolean)
        .map((part) =>
          part.startsWith("```")
            ? { code: part.replace(/^```[^\n]*\n/, "").replace(/\n?```$/, "") }
            : { text: part },
        );

    async function observeRun(requestId, resume = false) {
      observer?.abort();
      observer = new AbortController();
      setSending(true);
      setActiveRun(requestId);
      let outcome,
        acceptedMessage = false;
      try {
        await watch(
          requestId,
          (event) => {
            if (
              event.type === "message.accepted" &&
              resume &&
              !acceptedMessage
            ) {
              acceptedMessage = true;
              setMessages((items) => [
                ...items.slice(0, -1),
                { role: "user", text: event.message },
                items.at(-1),
              ]);
            }
            if (event.type === "message.delta")
              setMessages((items) =>
                items.map((item, i) =>
                  i === items.length - 1
                    ? { ...item, text: item.text + (event.text || "") }
                    : item,
                ),
              );
            if (event.type === "tool.done")
              setMessages((items) =>
                items.map((item, i) =>
                  i === items.length - 1
                    ? {
                        ...item,
                        tools: [
                          ...(item.tools || []),
                          { name: event.name, isError: event.isError },
                        ],
                      }
                    : item,
                ),
              );
            if (event.type === "message.done") {
              setBranchId(event.branchId);
              setHeadEventId(event.eventId);
              setForkFrom(null);
              setSelectedFiles([]);
              setSaveOutputs(false);
              setMessages((items) =>
                items.map((item, i) =>
                  i >= items.length - 2
                    ? { ...item, eventId: event.eventId, status: "complete" }
                    : item,
                ),
              );
            }
            if (event.type === "error") setError(event.message);
            if (event.type === "run.status") outcome = event;
          },
          { signal: observer.signal },
        );
        if (outcome?.status === "completed") {
          setActiveRun(null);
          setSending(false);
          const workspace = await rpc("workspace.get", {
            projectId: projectId(),
          });
          setConversations(workspace.conversations.items);
          setConversationCursor(workspace.conversations.nextCursor);
          const saved = workspace.conversations.items.find(
            (item) => item.id === conversationId(),
          );
          if (saved) await openConversation(saved, outcome.branchId);
        } else if (outcome) {
          setActiveRun(null);
          if (!branches().some((branch) => branch.id === branchId())) {
            setBranchId("main");
            showRoute(projectId(), conversationId());
          }
          setMessages((items) =>
            items.map((item, i) =>
              i === items.length - 1 ? { ...item, status: "failed" } : item,
            ),
          );
          setError(
            outcome.status === "cancelled"
              ? "Turn cancelled. Observed usage is retained."
              : "Turn outcome: " +
                  outcome.status +
                  ". Check usage before starting another turn.",
          );
        }
      } catch (cause) {
        if (cause.name !== "AbortError")
          setError(
            "Observation detached. Reopen this conversation to reconnect. " +
              cause.message,
          );
      } finally {
        setSending(false);
      }
    }
    async function send() {
      const message = draft().trim(),
        agent = selectedAgent(),
        model = composerModel(),
        fork = forkFrom();
      if (
        !message ||
        !agent ||
        !modelAllowed(model || {}, agent) ||
        sending() ||
        loadingConversation()
      )
        return;
      const targetBranch = fork ? crypto.randomUUID() : branchId(),
        requestId = crypto.randomUUID();
      setError("");
      setSending(true);
      try {
        const accepted = await rpc("chat.start", {
          projectId: projectId(),
          agentId: agent.id,
          sessionId: conversationId(),
          requestId,
          message,
          branchId: targetBranch,
          modelId: model.id,
          ...(fork
            ? { forkEventId: fork.rootEventId, sourceBranchId: branchId() }
            : { expectedHeadEventId: headEventId() }),
          ...(composerThinking() && { thinkingLevel: composerThinking() }),
          ...(agent.codeInterpreter && {
            fileIds: selectedFiles(),
            saveOutputs: saveOutputs(),
          }),
        });
        setDraft("");
        setBranchId(targetBranch);
        setMessages((items) => [
          ...(fork ? items.slice(0, fork.fromIndex) : items),
          { role: "user", text: message },
          { role: "assistant", text: "", status: "pending" },
        ]);
        showRoute(projectId(), conversationId(), targetBranch);
        await observeRun(accepted.requestId);
      } catch (cause) {
        setError(cause.message);
        setSending(false);
      }
    }
    async function load() {
      await feedback.perform(async () => {
        const workspace = await rpc("workspace.get", {
          projectId: projectId(),
        });
        setProjects(workspace.projects);
        setAgents(workspace.agents);
        setModels(workspace.models);
        setConversations(workspace.conversations.items);
        setConversationCursor(workspace.conversations.nextCursor);
        const objects = await rpc("objects.list", { projectId: projectId() });
        setFiles(objects.items);
        setFilesCursor(objects.nextCursor);
        let saved = workspace.conversations.items.find(
          (item) => item.id === query.get("conversation"),
        );
        if (!saved && query.get("conversation") && query.get("agent"))
          saved = {
            id: query.get("conversation"),
            agentId: query.get("agent"),
          };
        while (!saved && query.get("conversation") && conversationCursor()) {
          const page = await rpc("conversations.list", {
            projectId: projectId(),
            cursor: conversationCursor(),
          });
          setConversations((items) => [...items, ...page.items]);
          setConversationCursor(page.nextCursor);
          saved = page.items.find(
            (item) => item.id === query.get("conversation"),
          );
        }
        if (!saved && query.get("conversation"))
          throw Error("Conversation not found.");
        if (saved)
          await openConversation(
            saved,
            query.get("branch") || saved.activeBranchId || "main",
          );
        else if (query.get("agent"))
          selectAgent(
            workspace.agents.find((item) => item.id === query.get("agent")),
          );
      }, "");
    }
    function toggleSelectedFile(id) {
      setSelectedFiles((ids) =>
        ids.includes(id)
          ? ids.filter((value) => value !== id)
          : ids.length < 4
            ? [...ids, id]
            : ids,
      );
    }
    async function moreFiles() {
      try {
        const result = await rpc("objects.list", {
          projectId: projectId(),
          cursor: filesCursor(),
        });
        setFiles((items) => [...items, ...result.items]);
        setFilesCursor(result.nextCursor);
      } catch (cause) {
        setError(cause.message);
      }
    }
    load();
    return html`${feedback.view}
      <div class="chat-workspace">
        <aside class="chat-history" aria-label="Chat selection">
          <label
            >Project<select
              value=${projectId}
              disabled=${sending}
              onChange=${(event) => location.assign(pageUrl("chat", { project: event.currentTarget.value }))}
            >
              <${For} each=${projects}
                >${(project) => html`<option value=${project.id}>${project.name}</option>`}<//
              >
            </select></label
          >
          <label
            >Agent<select
              value=${() => selectedAgent()?.id || ""}
              disabled=${sending}
              onChange=${(event) => selectAgent(agents().find((item) => item.id === event.currentTarget.value))}
            >
              <option value="">Choose an agent</option>
              <${For} each=${() => agents().filter((agent) => !agent.archived)}
                >${(agent) => html`<option value=${agent.id}>${agent.name}</option>`}<//
              >
            </select></label
          >
          <button
            class="secondary"
            disabled=${sending}
            onClick=${() => newChat()}
          >
            ＋ New chat
          </button>
          <h2 class="eyebrow">Conversations</h2>
          <${For} each=${conversations}
            >${(item) => html`<button class=${() => "nav" + (conversationId() === item.id ? " active" : "")} disabled=${sending} onClick=${() => openConversation(item)}>${item.title}${item.activeRequests?.some((run) => run.status === "running") ? " · Working" : ""}</button>`}<//
          >
          <${Show} when=${conversationCursor}
            ><button onClick=${moreConversations}>More conversations</button><//
          >
        </aside>
        <section class="chat-panel">
          <header class="top">
            <div>
              <div class="top-title">
                ${() => selectedAgent()?.name || selectedAgent()?.agentName || "Your workspace"}
              </div>
              <div class="top-sub">
                AgentCore · ${() => currentProject().name}
              </div>
            </div>
            <div class="spacer"></div>
            <span class="status">Connected</span>
            <a class="link-button" href=${pageUrl("profile")}> Account </a>
          </header>
          <div class="mobile-agent">
            ${() => selectedAgent()?.name || "Choose an agent"}
          </div>
          <div class="content">
            <div class="conversation">
              <${Show} when=${() => branches().length > 1}>
                <div class="path-bar">
                  <span>Path</span>
                  <select
                    aria-label="Conversation path"
                    value=${branchId}
                    disabled=${sending}
                    onChange=${(event) =>
                      openConversation(
                        {
                          id: conversationId(),
                          agentId: selectedAgent()?.id,
                        },
                        event.currentTarget.value,
                      )}
                  >
                    <${For} each=${branches}
                      >${(branch) =>
                        html` <option
                          value=${branch.id}
                          selected=${() => branch.id === branchId()}
                        >
                          ${branch.name}
                        </option>`}<//
                    >
                  </select>
                </div>
              <//>
              <${Show}
                when=${() =>
                  conversations().some(
                    (item) => item.id === conversationId(),
                  ) && !sending()}
              >
                <button class="link-button" onClick=${deleteConversation}>
                  Delete conversation
                </button><//
              >
              <${Show} when=${olderCursor}>
                <button class="link-button" onClick=${(e) => moreMessages()}>
                  Load earlier messages
                </button><//
              >
              <${Show} when=${loadingConversation}>
                <div class="empty">Opening conversation…</div><//
              >
              <${Show} when=${() => !messages().length}
                ><div class="welcome">
                  <div class="welcome-icon">✦</div>
                  <h1>
                    ${() => (selectedAgent() ? "How can I help?" : "Your agents, one place.")}
                  </h1>
                  <p>
                    ${() => (selectedAgent() ? "Ask your agent anything. AgentCore manages its tools, skills and memory." : "Select an agent to begin.")}
                  </p>
                  <${Show} when=${() => session() && !selectedAgent()}
                    ><a class="primary" href=${pageUrl("agents")}>
                      Choose an agent
                    </a><//
                  >
                </div><//
              >
              <${For} each=${messages}
                >${(item, index) =>
                  html`<article class=${() => "message " + item.role}>
                    <div class="avatar">
                      ${item.role === "user" ? "Y" : "✦"}
                    </div>
                    <div>
                      <b>${item.role === "user" ? "You" : "Agent"}</b>
                      <${Show}
                        when=${() =>
                          item.eventId &&
                          !sending() &&
                          !loadingConversation() &&
                          (index() >= 2 || !olderCursor())}
                      >
                        <button
                          class="message-action"
                          onClick=${() =>
                            forkAt(index(), item.role === "assistant")}
                        >
                          ${item.role === "user" ? "Edit · new path" : "Retry · new path"}
                        </button><//
                      >
                      <div class="message-text">
                        <${For} each=${() => messageSections(item.text)}>
                          ${(section) =>
                            section.code !== undefined
                              ? html`<pre><code>${section.code}</code></pre>`
                              : html`<${For}
                                  each=${() => section.text.split(/(https:\/\/[^\s<>"']+)/g)}
                                >
                                  ${(part) =>
                                    /^https:\/\/[^\s<>"']+$/.test(part)
                                      ? html`<a
                                          href=${part}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          >${part}</a
                                        >`
                                      : part}<//
                                >`}<//
                        >
                      </div>
                      <${Show} when=${() => item.tools?.length}>
                        <small class="tool-activity"
                          ><${For} each=${() => item.tools || []}>
                            ${(tool, index) =>
                              `${index() ? " · " : ""}${tool.isError ? "Failed: " : "Used "}${
                                {
                                  web_search: "web search",
                                  browser: "browser",
                                  execute_code: "code workspace",
                                  execute_command: "command workspace",
                                }[tool.name] || tool.name
                              }`}<//
                          ></small
                        ><//
                      >
                      <${Show}
                        when=${() => item.status && item.status !== "complete"}
                      >
                        <small class="message-state"
                          >${() =>
                            item.status === "pending"
                              ? "Working…"
                              : item.status === "failed"
                                ? "Turn failed"
                                : "Outcome uncertain · reopen to check"}</small
                        ><//
                      >
                    </div>
                  </article>`}<//
              >
              <${Show} when=${error}
                ><div class="error" role="alert">${error}</div><//
              >
            </div>
          </div>
          <div class="compose-wrap">
            <div class="composer">
              <${Show} when=${forkFrom}>
                <div class="path-bar">
                  Editing an earlier turn creates a new path.
                  <button
                    class="message-action"
                    onClick=${() => setForkFrom(null)}
                  >
                    Cancel
                  </button>
                </div><//
              >
              <${Show} when=${() => selectedAgent()?.codeInterpreter}>
                <div class="path-bar">
                  <button class="message-action" onClick=${openFiles}>
                    Files for this
                    turn${() =>
                      selectedFiles().length
                        ? " · " + selectedFiles().length + " selected"
                        : ""}
                  </button>
                  <${Show} when=${() => selectedFiles().length}>
                    <button
                      class="message-action"
                      onClick=${() => setSelectedFiles([])}
                    >
                      Clear
                    </button><//
                  >
                  <label class="save-output-toggle">
                    <input
                      type="checkbox"
                      checked=${saveOutputs}
                      onChange=${(event) => setSaveOutputs(event.currentTarget.checked)}
                    />
                    Save outputs
                  </label>
                </div><//
              >
              <textarea
                aria-label="Message"
                placeholder=${() => (selectedAgent() ? "Message your agent…" : "Choose an agent to start chatting")}
                value=${draft}
                onInput=${(e) => setDraft(e.currentTarget.value)}
                onKeyDown=${(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                    e.preventDefault();
                    send();
                  }
                }}
                disabled=${() =>
                  !selectedAgent() ||
                  selectedAgent()?.archived ||
                  sending() ||
                  loadingConversation() ||
                  uncertainConversationId() === conversationId()}
              ></textarea>
              <${Show}
                when=${() => selectedAgent()?.browser && !composerModel()?.browserTool}
              >
                <p class="help">
                  Visual browsing needs Claude or configured Gemini. Choose one
                  before sending, or disable Browser in the agent settings.
                </p>
              <//>
              <div class="composer-foot">
                <${Show}
                  when=${selectedAgent}
                  fallback=${html`<span class="hint">AgentCore handles memory, tools and execution</span>`}
                >
                  <div class="composer-controls">
                    <select
                      aria-label="Model for this message"
                      disabled=${() => sending() || loadingConversation()}
                      onChange=${(e) =>
                        setComposerChoice({
                          agentId: selectedAgent()?.id,
                          modelId: e.currentTarget.value,
                          thinkingLevel: null,
                        })}
                    >
                      <${For} each=${modelCompanies}>
                        ${(company) =>
                          html`<optgroup label=${company}>
                            <${For}
                              each=${() =>
                                models().filter(
                                  (model) => modelCompany(model) === company,
                                )}
                            >
                              ${(model) =>
                                html`<option
                                  value=${model.id}
                                  disabled=${() => !modelAllowed(model, selectedAgent())}
                                  selected=${() => composerModel()?.id === model.id}
                                >
                                  ${() =>
                                    model.name +
                                    (selectedAgent()?.browser &&
                                    !model.browserTool
                                      ? " · no visual browser"
                                      : "")}
                                </option>`}<//
                            >
                          </optgroup>`}<//
                      >
                    </select>
                    <${Show}
                      when=${() => composerModel()?.thinkingLevels?.length}
                    >
                      <label class="composer-thinking">
                        <span>Thinking: ${() => composerThinking()}</span>
                        <input
                          type="range"
                          aria-label="Thinking level for this message"
                          aria-valuetext=${() => composerThinking()}
                          min="0"
                          max=${() => composerModel().thinkingLevels.length - 1}
                          step="1"
                          value=${() =>
                            composerModel().thinkingLevels.indexOf(
                              composerThinking(),
                            )}
                          onInput=${(e) =>
                            setComposerChoice({
                              agentId: selectedAgent()?.id,
                              modelId: composerModel()?.id,
                              thinkingLevel:
                                composerModel()?.thinkingLevels[
                                  Number(e.currentTarget.value)
                                ],
                            })}
                          disabled=${() => sending() || loadingConversation()}
                        />
                      </label>
                    <//>
                  </div>
                <//>
                <button
                  class="send"
                  onClick=${(e) => send()}
                  disabled=${() =>
                    !selectedAgent() ||
                    selectedAgent()?.archived ||
                    !modelAllowed(composerModel() || {}, selectedAgent()) ||
                    !draft().trim() ||
                    sending() ||
                    loadingConversation() ||
                    uncertainConversationId() === conversationId()}
                >
                  ${() => (sending() ? "Working…" : "Send ↑")}
                </button>
              </div>
            </div>
            <div class="footnote">
              Responses can be imperfect. Review actions before relying on them.
            </div>
          </div>
        </section>
      </div>
      <dialog
        ref=${(element) => {
          fileDialog = element;
        }}
        class="panel file-picker"
        aria-labelledby="file-picker-title"
        onClose=${() => fileDialogTrigger?.focus()}
      >
        <h2 id="file-picker-title">Files for this turn</h2>
        <p>Select up to four files.</p>
        <${For}
          each=${() => files().filter((item) => ["file", "artifact"].includes(item.kind))}
          >${(item) => html`<label class="check"><input type="checkbox" checked=${() => selectedFiles().includes(item.id)} disabled=${() => selectedFiles().length >= 4 && !selectedFiles().includes(item.id)} onChange=${() => toggleSelectedFile(item.id)} />${item.name}</label>`}<//
        >
        <${Show} when=${filesCursor}
          ><button onClick=${moreFiles}>Load more files</button><//
        >
        <a href=${pageUrl("agents", { section: "skills" })}
          >Manage files & skills</a
        ><button autofocus onClick=${() => fileDialog.close()}>Done</button>
      </dialog>
      <${Show} when=${activeRun}
        ><div class="run-controls">
          <span role="status"
            >${() => (sending() ? "Working in AgentCore. You can leave this page." : "Observation detached.")}</span
          >
          <button
            onClick=${() => rpc("chat.cancel", { requestId: activeRun() }).catch((cause) => setError(cause.message))}
          >
            Cancel turn
          </button>
          <${Show} when=${() => !sending()}
            ><button onClick=${() => observeRun(activeRun(), true)}>
              Reconnect
            </button><//
          >
        </div><//
      >`;
  },
});
if (new URL(location.href).searchParams.get("test") === "1") {
  const { runTests } = await import("./tests.js");
  window.TESTS_DONE = await runTests({ parseDeployment });
}
