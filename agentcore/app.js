import { createEffect, createSignal, For, Show, onCleanup } from "solid-js";
import html from "solid-js/html";
import { mountPage } from "./shared/page.js";
import { parseDeployment } from "./shared/session.js";
import { createFeedback, confirmAction, Menu, Skeleton } from "./shared/ui.js";

const routeProject = () => {
  const value = new URL(location.href).searchParams.get("project") || "";
  return /^[a-z0-9][a-z0-9-]{0,39}$/.test(value) ? value : "main";
};
await mountPage({
  key: "chat",
  title: "Chat",
  // workspace.get no longer waits behind session.get.
  preload: ({ rpc }) => rpc("workspace.get", { projectId: routeProject() }),
  render: ({
    rpc,
    watch,
    session,
    pageUrl,
    takePreload,
    setCrumb,
    setStatus,
    setProjects: setShellProjects,
  }) => {
    const query = new URL(location.href).searchParams,
      feedback = createFeedback();
    const [error, setError] = createSignal(""),
      [activeRun, setActiveRun] = createSignal(null),
      [files, setFiles] = createSignal([]),
      [filesCursor, setFilesCursor] = createSignal(null),
      [filesLoaded, setFilesLoaded] = createSignal(false),
      [filesRequested, setFilesRequested] = createSignal(false),
      [loaded, setLoaded] = createSignal(false),
      [historyOpen, setHistoryOpen] = createSignal(false);
    let observer, fileDialog, fileDialogTrigger;
    onCleanup(() => observer?.abort());
    const openFiles = () => {
      fileDialogTrigger = document.activeElement;
      fileDialog.showModal();
      ensureFiles();
    };
    const [projects, setProjects] = createSignal([]);
    const [projectId] = createSignal(routeProject());
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
        .map((part, index, parts) =>
          part.startsWith("```")
            ? { code: part.replace(/^```[^\n]*\n/, "").replace(/\n?```$/, "") }
            : {
                // The code block supplies its own spacing; drop blank lines touching it.
                text: part
                  .replace(index > 0 ? /^\n+/ : /(?!)/, "")
                  .replace(index < parts.length - 1 ? /\n+$/ : /(?!)/, ""),
              },
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
        try {
          const workspace =
            (await takePreload()) ||
            (await rpc("workspace.get", { projectId: projectId() }));
          setProjects(workspace.projects);
          setShellProjects(workspace.projects);
          setAgents(workspace.agents);
          setModels(workspace.models);
          setConversations(workspace.conversations.items);
          setConversationCursor(workspace.conversations.nextCursor);
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
          if (saved) {
            setLoaded(true);
            await openConversation(
              saved,
              query.get("branch") || saved.activeBranchId || "main",
            );
          } else if (query.get("agent"))
            selectAgent(
              workspace.agents.find((item) => item.id === query.get("agent")),
            );
        } finally {
          setLoaded(true);
        }
      }, "");
    }
    // Files only matter once the picker opens, so they no longer delay the first render.
    async function ensureFiles() {
      if (filesLoaded()) return;
      setFilesRequested(true);
      try {
        const objects = await rpc("objects.list", { projectId: projectId() });
        setFiles(objects.items);
        setFilesCursor(objects.nextCursor);
        setFilesLoaded(true);
      } catch (cause) {
        setError(cause.message);
      }
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
    const toolNames = {
      web_search: "web search",
      browser: "browser",
      execute_code: "code workspace",
      execute_command: "command workspace",
    };
    const agentName = (agent) => agent?.name || agent?.agentName || "Agent";
    const modelName = (id) =>
      models().find((model) => model.id === id)?.name || id;
    const agentTools = (agent) =>
      [
        agent?.codeInterpreter && "code",
        agent?.webSearch && "search",
        agent?.browser && "browser",
      ].filter(Boolean);
    const activeAgents = () => agents().filter((agent) => !agent.archived);
    const currentTitle = () =>
      conversations().find((item) => item.id === conversationId())?.title ||
      (messages().length ? "Untitled conversation" : "New conversation");
    const day = 86400000;
    const historyGroups = () => {
      const startOfToday = new Date().setHours(0, 0, 0, 0),
        groups = [
          { label: "Today", items: [] },
          { label: "Yesterday", items: [] },
          { label: "Earlier", items: [] },
        ];
      for (const item of conversations()) {
        const time = Date.parse(item.lastActivityAt || item.createdAt || "");
        groups[
          !time || time < startOfToday - day ? 2 : time < startOfToday ? 1 : 0
        ].items.push(item);
      }
      return groups.filter((group) => group.items.length);
    };
    const relativeTime = (value) => {
      const time = Date.parse(value || "");
      if (!time) return "";
      const minutes = Math.round((Date.now() - time) / 60000);
      if (minutes < 1) return "now";
      if (minutes < 60) return minutes + "m";
      if (minutes < 1440) return Math.round(minutes / 60) + "h";
      return new Date(time).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      });
    };
    // Follow streaming output only while the reader is already near the bottom.
    let scroller,
      pinned = true;
    createEffect(() => {
      messages();
      if (scroller && pinned)
        queueMicrotask(() => (scroller.scrollTop = scroller.scrollHeight));
    });
    setCrumb(
      () => html`<span class="crumb-sep" aria-hidden="true">/</span>
        <${Menu}
          class="crumb"
          label=${() => "Agent: " + (selectedAgent() ? agentName(selectedAgent()) : "none")}
          disabled=${sending}
          trigger=${() => html`<span class="crumb-label"
              >${() => (selectedAgent() ? agentName(selectedAgent()) : "Choose agent")}</span
            ><span class="caret" aria-hidden="true">▾</span>`}
        >
          <div class="menu-heading">Agents</div>
          <${For}
            each=${activeAgents}
            fallback=${html`<div class="menu-note">No agents in this project.</div>`}
            >${(agent) =>
              html`<button
                type="button"
                class="menu-item"
                data-close
                aria-current=${() => (selectedAgent()?.id === agent.id ? "true" : undefined)}
                onClick=${(event) => selectAgent(agent)}
              >
                <span>${agentName(agent)}</span
                ><span class="mono dim">${() => modelName(agent.modelId)}</span>
              </button>`}<//
          >
          <a class="menu-item subtle" href=${pageUrl("agents")}>Manage agents</a>
        <//>`,
    );
    setStatus(
      () => html`<${Show} when=${activeRun}>
        <${Menu}
          class="run"
          label="Run status"
          trigger=${() => html`<span
            class="run-pill"
            data-state=${() => (sending() ? "working" : "detached")}
            ><span class="run-dot" aria-hidden="true"></span
            ><span class="run-label"
              >${() => (sending() ? "Working" : "Detached")}</span
            ></span
          >`}
        >
          <p class="menu-note" role="status">
            ${() =>
              sending()
                ? "Working in AgentCore. You can leave this page; the turn continues."
                : "Observation detached. The turn may still be running."}
          </p>
          <${Show} when=${() => !sending()}
            ><button
              type="button"
              class="menu-item"
              data-close
              onClick=${(event) => observeRun(activeRun(), true)}
            >
              Reconnect
            </button><//
          >
          <button
            type="button"
            class="menu-item danger"
            data-close
            onClick=${(event) =>
              rpc("chat.cancel", { requestId: activeRun() }).catch((cause) =>
                setError(cause.message),
              )}
          >
            Cancel turn
          </button>
        <//>
      <//>`,
    );
    load();
    return html`${feedback.view}
      <div
        class=${() => "chat-workspace" + (historyOpen() ? " history-open" : "")}
      >
        <aside class="chat-history" id="chat-history" aria-label="Conversations">
          <button
            class="new-chat"
            disabled=${sending}
            onClick=${(event) => {
              newChat();
              setHistoryOpen(false);
            }}
          >
            <span aria-hidden="true">＋</span> New chat
          </button>
          <${Show}
            when=${loaded}
            fallback=${html`<${Skeleton}
              variant="list"
              rows=${6}
              label="Loading conversations…"
            />`}
          >
            <${Show}
              when=${() => conversations().length}
              fallback=${html`<p class="history-empty">
                Conversations you start appear here.
              </p>`}
            >
              <${For} each=${historyGroups}
                >${(group) =>
                  html`<section class="history-group">
                    <h2 class="eyebrow">${group.label}</h2>
                    <${For} each=${() => group.items}
                      >${(item) =>
                        html`<button
                          class="history-item"
                          aria-current=${() => (conversationId() === item.id ? "true" : undefined)}
                          disabled=${sending}
                          onClick=${(event) => {
                            openConversation(item);
                            setHistoryOpen(false);
                          }}
                        >
                          <span class="history-title">${item.title}</span>
                          <span class="history-meta mono"
                            >${() =>
                              agentName(agents().find((agent) => agent.id === item.agentId)) +
                              " · " +
                              relativeTime(item.lastActivityAt)}</span
                          >
                        </button>`}<//
                    >
                  </section>`}<//
              >
            <//>
            <${Show} when=${conversationCursor}
              ><button class="link-button" onClick=${(event) => moreConversations()}>
                More conversations
              </button><//
            >
          <//>
        </aside>
        <button
          class="history-scrim"
          aria-label="Close conversations"
          tabindex="-1"
          onClick=${(event) => setHistoryOpen(false)}
        ></button>
        <section class="chat-panel">
          <header class="thread-head">
            <button
              class="history-toggle"
              aria-label="Show conversations"
              aria-controls="chat-history"
              aria-expanded=${() => String(historyOpen())}
              onClick=${(event) => setHistoryOpen(!historyOpen())}
            >
              <span aria-hidden="true">☰</span>
            </button>
            <h1 class="thread-title">${currentTitle}</h1>
            <${Show} when=${() => branches().length > 1}>
              <${Menu}
                class="path-menu"
                label="Conversation path"
                disabled=${sending}
                trigger=${() => html`<span class="mono"
                    >${() => "path: " + (branches().find((branch) => branch.id === branchId())?.name || "main")}</span
                  ><span class="caret" aria-hidden="true">▾</span>`}
              >
                <div class="menu-heading">Paths</div>
                <${For} each=${branches}
                  >${(branch) =>
                    html`<button
                      type="button"
                      class="menu-item"
                      data-close
                      aria-current=${() => (branch.id === branchId() ? "true" : undefined)}
                      onClick=${(event) =>
                        branch.id !== branchId() &&
                        openConversation(
                          { id: conversationId(), agentId: selectedAgent()?.id },
                          branch.id,
                        )}
                    >
                      ${branch.name}
                    </button>`}<//
                >
              <//>
            <//>
            <${Show}
              when=${() => conversations().some((item) => item.id === conversationId()) && !sending()}
            >
              <${Menu}
                class="thread-actions"
                label="Conversation actions"
                trigger=${() => html`<span aria-hidden="true">⋯</span>`}
              >
                <button
                  type="button"
                  class="menu-item danger"
                  data-close
                  onClick=${(event) => deleteConversation()}
                >
                  Delete conversation
                </button>
              <//>
            <//>
          </header>
          <div
            class="content"
            ref=${(element) => (scroller = element)}
            onScroll=${(event) => {
              const element = event.currentTarget;
              pinned =
                element.scrollHeight - element.scrollTop - element.clientHeight < 80;
            }}
          >
            <div class="conversation">
              <${Show} when=${olderCursor}>
                <button class="load-earlier" onClick=${(event) => moreMessages()}>
                  Load earlier messages
                </button><//
              >
              <${Show} when=${() => !loaded() || loadingConversation()}>
                <${Skeleton}
                  variant="thread"
                  rows=${4}
                  label=${() => (loaded() ? "Opening conversation…" : "Loading workspace…")}
                /><//
              >
              <${Show}
                when=${() => loaded() && !loadingConversation() && !messages().length}
                ><div class="welcome">
                  <${Show}
                    when=${() => activeAgents().length}
                    fallback=${html`<span class="boot-mark" aria-hidden="true">✦</span>
                      <h2>Create your first agent</h2>
                      <p>
                        An agent pairs a model with instructions and the tools it
                        may use: code, web search or a browser.
                      </p>
                      <a class="primary" href=${pageUrl("agents")}>Create an agent</a>`}
                  >
                    <${Show}
                      when=${selectedAgent}
                      fallback=${html`<h2>Choose an agent</h2>
                        <p>Each conversation belongs to one agent.</p>
                        <div class="agent-grid">
                          <${For} each=${activeAgents}
                            >${(agent) =>
                              html`<button
                                class="agent-card"
                                onClick=${(event) => selectAgent(agent)}
                              >
                                <strong>${agentName(agent)}</strong>
                                <span class="mono dim"
                                  >${() => modelName(agent.modelId)}</span
                                >
                                <span class="mono dim"
                                  >${agentTools(agent).join(" · ") || "chat only"}</span
                                >
                              </button>`}<//
                          >
                        </div>`}
                    >
                      <span class="boot-mark" aria-hidden="true">✦</span>
                      <h2>${() => agentName(selectedAgent())}</h2>
                      <p class="mono dim">
                        ${() =>
                          [
                            modelName(composerModel()?.id),
                            ...agentTools(selectedAgent()),
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                      </p>
                    <//>
                  <//>
                </div><//
              >
              <${For} each=${messages}
                >${(item, index) =>
                  html`<article class=${() => "message " + item.role}>
                    <header class="turn-meta">
                      <span class="turn-role mono"
                        >${item.role === "user" ? "you" : () => agentName(selectedAgent())}</span
                      >
                      <${Show}
                        when=${() =>
                          item.eventId &&
                          !sending() &&
                          !loadingConversation() &&
                          (index() >= 2 || !olderCursor())}
                      >
                        <button
                          class="message-action"
                          onClick=${(event) =>
                            forkAt(index(), item.role === "assistant")}
                        >
                          ${item.role === "user" ? "Edit · new path" : "Retry · new path"}
                        </button><//
                      >
                    </header>
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
                      <ul class="tool-activity" aria-label="Tool activity">
                        <${For} each=${() => item.tools || []}>
                          ${(tool) =>
                            html`<li
                              class="trace-line"
                              data-state=${tool.isError ? "error" : "ok"}
                            >
                              <span aria-hidden="true">→</span>
                              ${toolNames[tool.name] || tool.name}
                              <span class="trace-status"
                                >${tool.isError ? "failed" : "ok"}</span
                              >
                            </li>`}<//
                        >
                      </ul>
                    <//>
                    <${Show}
                      when=${() => item.status && item.status !== "complete"}
                    >
                      <small
                        class="message-state"
                        data-state=${() => item.status}
                        >${() =>
                          item.status === "pending"
                            ? "Working…"
                            : item.status === "failed"
                              ? "Turn failed"
                              : "Outcome uncertain · reopen to check"}</small
                      ><//
                    >
                  </article>`}<//
              >
            </div>
          </div>
          <div class="compose-wrap">
            <${Show} when=${error}
              ><div class="error" role="alert">${error}</div><//
            >
            <div class="composer">
              <${Show} when=${() => forkFrom() || selectedAgent()?.codeInterpreter}>
                <div class="composer-tray">
                  <${Show} when=${forkFrom}>
                    <span class="tray-chip" data-kind="fork"
                      >Editing an earlier turn creates a new path
                      <button
                        class="message-action"
                        onClick=${(event) => setForkFrom(null)}
                      >
                        Cancel
                      </button></span
                    >
                  <//>
                  <${Show} when=${() => selectedAgent()?.codeInterpreter}>
                    <button class="tray-chip" onClick=${(event) => openFiles()}>
                      <span aria-hidden="true">⌗</span> Files for this
                      turn${() =>
                        selectedFiles().length
                          ? " · " + selectedFiles().length + " selected"
                          : ""}
                    </button>
                    <${Show} when=${() => selectedFiles().length}>
                      <button
                        class="message-action"
                        onClick=${(event) => setSelectedFiles([])}
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
                  <//>
                </div>
              <//>
              <textarea
                aria-label="Message"
                rows="2"
                placeholder=${() =>
                  selectedAgent()
                    ? "Message " + agentName(selectedAgent()) + "…"
                    : "Choose an agent to start chatting"}
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
                  fallback=${html`<span class="hint mono">memory · tools · execution handled by AgentCore</span>`}
                >
                  <div class="composer-controls">
                    <select
                      class="model-chip"
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
                      <div
                        class="thinking"
                        role="radiogroup"
                        aria-label="Thinking level for this message"
                      >
                        <span class="thinking-label mono" aria-hidden="true">think</span>
                        <${For} each=${() => composerModel()?.thinkingLevels || []}
                          >${(level) =>
                            html`<button
                              type="button"
                              role="radio"
                              class="thinking-step"
                              title=${level}
                              aria-label=${level}
                              aria-checked=${() => String(composerThinking() === level)}
                              data-on=${() =>
                                (composerModel()?.thinkingLevels || []).indexOf(level) <=
                                (composerModel()?.thinkingLevels || []).indexOf(composerThinking())
                                  ? ""
                                  : undefined}
                              disabled=${() => sending() || loadingConversation()}
                              onClick=${(event) =>
                                setComposerChoice({
                                  agentId: selectedAgent()?.id,
                                  modelId: composerModel()?.id,
                                  thinkingLevel: level,
                                })}
                            ></button>`}<//
                        >
                        <span class="thinking-value mono">${composerThinking}</span>
                      </div>
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
        class="file-picker"
        aria-labelledby="file-picker-title"
        onClose=${() => fileDialogTrigger?.focus()}
      >
        <div class="dialog-head">
          <div>
            <h2 id="file-picker-title">Files for this turn</h2>
            <p>Select up to four files.</p>
          </div>
        </div>
        <div class="dialog-body">
          <${Show}
            when=${filesLoaded}
            fallback=${html`<${Show} when=${filesRequested}
              ><${Skeleton} variant="list" rows=${3} label="Loading files…"
            /><//>`}
          >
            <${For}
              each=${() => files().filter((item) => ["file", "artifact"].includes(item.kind))}
              fallback=${html`<div class="empty">No saved files in this project.</div>`}
              >${(item) => html`<label class="check"><input type="checkbox" checked=${() => selectedFiles().includes(item.id)} disabled=${() => selectedFiles().length >= 4 && !selectedFiles().includes(item.id)} onChange=${() => toggleSelectedFile(item.id)} />${item.name}</label>`}<//
            >
            <${Show} when=${filesCursor}
              ><button class="secondary" onClick=${(event) => moreFiles()}>Load more files</button><//
            >
          <//>
          <div class="actions">
            <a class="secondary" href=${pageUrl("agents", { section: "skills" })}
              >Manage files & skills</a
            ><button class="primary" autofocus onClick=${() => fileDialog.close()}>Done</button>
          </div>
        </div>
      </dialog>`;
  },
});
if (new URL(location.href).searchParams.get("test") === "1") {
  const { runTests } = await import("./tests.js");
  window.TESTS_DONE = await runTests({ parseDeployment });
}
