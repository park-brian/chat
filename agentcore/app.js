import {
  createEffect,
  createMemo,
  createRenderEffect,
  createSignal,
  For,
  Index,
  Show,
  onCleanup,
} from "solid-js";
import { createStore } from "solid-js/store";
import html from "solid-js/html";
import { mountPage } from "./shared/page.js";
import { parseDeployment } from "./shared/session.js";
import { replaceUrl } from "./shared/navigation.js";
import { createFeedback, confirmAction, Menu, Skeleton } from "./shared/ui.js";

// Unique by id, keeping the first copy: pages can overlap while items move.
const appendNew = (items, more) => [
  ...items,
  ...more.filter((item) => !items.some((existing) => existing.id === item.id)),
];
// A stable text node, so streamed text updates in place.
const textNode = (value) => {
  const node = document.createTextNode("");
  createRenderEffect(() => (node.data = value()));
  return node;
};
// Alternating [text, url, text, …]; trailing punctuation and unbalanced closers stay text.
const linkParts = (text) => {
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(/https:\/\/[^\s<>"']+/g)) {
    let url = match[0];
    const unbalanced = (open, close) =>
      url.split(close).length > url.split(open).length;
    while (
      /[.,;:!?]$/.test(url) ||
      (url.endsWith(")") && unbalanced("(", ")")) ||
      (url.endsWith("]") && unbalanced("[", "]"))
    )
      url = url.slice(0, -1);
    parts.push(text.slice(last, match.index), url);
    last = match.index + url.length;
  }
  parts.push(text.slice(last));
  return parts;
};
await mountPage({
  key: "chat",
  title: "Chat",
  render: ({
    rpc,
    watch,
    session,
    projectId,
    pageUrl,
    setCrumb,
    setStatus,
    setProjects,
  }) => {
    const query = new URL(location.href).searchParams,
      feedback = createFeedback();
    const [error, setError] = createSignal(""),
      [activeRun, setActiveRun] = createSignal(null),
      [files, setFiles] = createSignal([]),
      [filesCursor, setFilesCursor] = createSignal(null),
      [filesLoaded, setFilesLoaded] = createSignal(false),
      [filesRequested, setFilesRequested] = createSignal(false),
      [filesBusy, setFilesBusy] = createSignal(false),
      [announcement, setAnnouncement] = createSignal(""),
      [loaded, setLoaded] = createSignal(false),
      [historyOpen, setHistoryOpen] = createSignal(false);
    let observer, fileDialog, fileDialogTrigger;
    onCleanup(() => observer?.abort());
    const openFiles = () => {
      fileDialogTrigger = document.activeElement;
      fileDialog.showModal();
      ensureFiles();
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
      replaceUrl(url.pathname + url.search);
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
      { id: "main", name: "Main", headTurnId: null },
    ]);
    const [headTurnId, setHeadTurnId] = createSignal(null);
    const [forkFrom, setForkFrom] = createSignal(null);
    const [conversations, setConversations] = createSignal([]);
    const [conversationCursor, setConversationCursor] = createSignal(null);
    const [olderCursor, setOlderCursor] = createSignal(null);
    const [loadingOlder, setLoadingOlder] = createSignal(false);
    // A store keeps each message's identity, so streaming updates only its text.
    const [messages, setMessages] = createStore([]);
    const [draft, setDraft] = createSignal("");
    const [selectedFiles, setSelectedFiles] = createSignal([]);
    const [saveOutputs, setSaveOutputs] = createSignal(false);
    const [sending, setSending] = createSignal(false);
    const [loadingConversation, setLoadingConversation] = createSignal(false);
    let conversationRequest = 0;
    // The run shown belongs to one conversation and path; switching drops it,
    // and reopening that conversation resumes it from conversations.get.
    function detachRun() {
      observer?.abort();
      observer = null;
      setActiveRun(null);
    }
    function newChat(agent = selectedAgent()) {
      ++conversationRequest;
      detachRun();
      setSelectedAgent(agent);
      setConversationId(crypto.randomUUID());
      setBranchId("main");
      setBranches([{ id: "main", name: "Main", headTurnId: null }]);
      setHeadTurnId(null);
      setForkFrom(null);
      setOlderCursor(null);
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
      detachRun();
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
              run.status === "running",
          );
          setBranchId(selectedBranch);
          setBranches(page.branches);
          if (active) {
            // A fork shows as a placeholder branch headed at its fork point
            // until its first turn commits.
            const head =
              page.branches.find((branch) => branch.id === selectedBranch)
                ?.headTurnId ?? null;
            setMessages((items) => [
              ...items,
              { role: "assistant", text: "", status: "pending" },
            ]);
            observeRun({
              requestId: active.requestId,
              agentId: agent.id,
              conversationId: item.id,
              branchId: selectedBranch,
              fork:
                selectedBranch !== "main" &&
                head === (active.forkTurnId ?? null),
              previousBranch: "main",
              after: 0,
              needsMessage: true,
            });
          }
          setHeadTurnId(
            page.branches.find((branch) => branch.id === selectedBranch)
              ?.headTurnId ||
              page.messages.at(-1)?.turnId ||
              null,
          );
          setForkFrom(null);
          setOlderCursor(page.nextCursor);
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
        (index < 2 && olderCursor())
      )
        return;
      const items = messages;
      const userIndex = retry ? index - 1 : index;
      // The edited turn's parent: the turn before it, or none for the first.
      const forkTurnId = items.slice(0, userIndex).at(-1)?.turnId || null;
      setForkFrom({ fromIndex: userIndex, forkTurnId });
      setDraft(items[userIndex].text);
      if (retry) send();
    }
    function selectAgent(agent) {
      if (sending() || !agent) return;
      const recent = conversations().find((item) => item.agentId === agent.id);
      if (recent) openConversation(recent);
      else newChat(agent);
    }
    // One conversations.list page at a time, shared by "More" and deep links.
    let conversationPage = null;
    function nextConversations() {
      return (conversationPage ||= rpc("conversations.list", {
        projectId: projectId(),
        cursor: conversationCursor(),
      })
        .then((page) => {
          setConversations((items) => appendNew(items, page.items));
          setConversationCursor(page.nextCursor);
          return page.items;
        })
        .finally(() => (conversationPage = null)));
    }
    async function moreConversations() {
      if (!conversationCursor()) return;
      try {
        await nextConversations();
      } catch (cause) {
        setError(cause.message);
      }
    }
    async function moreMessages() {
      const cursor = olderCursor(),
        agent = selectedAgent(),
        request = conversationRequest;
      if (!cursor || !agent || sending() || loadingOlder()) return;
      setLoadingOlder(true);
      try {
        const page = await rpc("conversations.get", {
          projectId: projectId(),
          agentId: agent.id,
          conversationId: conversationId(),
          branchId: branchId(),
          cursor,
        });
        if (request === conversationRequest) {
          setMessages((items) => [...page.messages, ...items]);
          setOlderCursor(page.nextCursor);
        }
      } catch (cause) {
        if (request === conversationRequest) setError(cause.message);
      } finally {
        setLoadingOlder(false);
      }
    }
    const modelCompanies = ["Anthropic", "OpenAI", "Google", "Amazon", "Other"];

    // Alternating [text, code, text, …], so each slot keeps its kind while streaming.
    const messageSections = (value) =>
      String(value || "")
        .split(/(```[^\n]*\n[\s\S]*?(?:```|$))/g)
        .map((part, index, parts) =>
          index % 2
            ? part.replace(/^```[^\n]*\n/, "").replace(/\n?```$/, "")
            : // The code block supplies its own spacing; drop blank lines touching it.
              part
                .replace(index > 0 ? /^\n+/ : /(?!)/, "")
                .replace(index < parts.length - 1 ? /\n+$/ : /(?!)/, ""),
        );

    // A run: { requestId, agentId, conversationId, branchId, fork,
    // previousBranch, after, needsMessage }. `after` is the last progress
    // sequence shown, so a reconnect resumes instead of replaying.
    async function observeRun(run) {
      observer?.abort();
      const controller = (observer = new AbortController());
      setSending(true);
      setActiveRun(run);
      setAnnouncement("");
      const shown = () => activeRun() === run;
      const last = () => messages.length - 1;
      let outcome;
      try {
        await watch(
          run.requestId,
          (event) => {
            if (!shown()) return;
            if (event.sequence && event.type !== "run.status")
              run.after = event.sequence;
            if (event.type === "message.accepted" && run.needsMessage) {
              run.needsMessage = false;
              setMessages((items) => [
                ...items.slice(0, -1),
                { role: "user", text: event.message },
                items.at(-1),
              ]);
            }
            if (event.type === "message.delta")
              setMessages(last(), "text", (text) => text + (event.text || ""));
            if (event.type === "tool.done")
              setMessages(last(), "tools", (tools = []) => [
                ...tools,
                { name: event.name, isError: event.isError },
              ]);
            if (event.type === "message.done") {
              run.branchId = event.branchId;
              run.turnId = event.turnId;
              setBranchId(event.branchId);
              setHeadTurnId(event.turnId);
              setForkFrom(null);
              setSelectedFiles([]);
              setSaveOutputs(false);
              setMessages(
                { from: Math.max(0, last() - 1), to: last() },
                { turnId: event.turnId, status: "complete" },
              );
            }
            if (event.type === "error") setError(event.message);
            if (event.type === "run.status") outcome = event;
          },
          { after: run.after, signal: controller.signal },
        );
        if (!shown() || !outcome) return;
        setActiveRun(null);
        setSending(false);
        if (outcome.status === "completed") {
          setAnnouncement("Response complete.");
          await refreshConversation(run);
          return;
        }
        const text =
          outcome.status === "cancelled"
            ? "Turn cancelled. Observed usage is retained."
            : "Turn outcome: " +
              outcome.status +
              ". Check usage before starting another turn.";
        // A fork that never committed has no branch: return to the path it left.
        if (run.fork)
          await openConversation(
            { id: run.conversationId, agentId: run.agentId },
            run.previousBranch,
          );
        else if (last() >= 0) setMessages(last(), "status", "failed");
        setError(text);
        setAnnouncement(text);
      } catch (cause) {
        if (cause.name !== "AbortError" && shown()) {
          setError(
            "Observation detached. Reconnect from the run status, or reopen this conversation. " +
              cause.message,
          );
          setAnnouncement("Observation detached.");
        }
      } finally {
        if (observer === controller) setSending(false);
      }
    }
    // After a turn commits, refresh paths and the history entry in place; the
    // streamed messages already carry their turn ids.
    async function refreshConversation(run) {
      const request = conversationRequest;
      try {
        const page = await rpc("conversations.get", {
          projectId: projectId(),
          agentId: run.agentId,
          conversationId: run.conversationId,
          branchId: run.branchId,
        });
        if (request !== conversationRequest) return;
        setBranches(
          page.branches.some((branch) => branch.id === run.branchId)
            ? page.branches
            : [
                ...page.branches,
                { id: run.branchId, name: "New path", headTurnId: run.turnId },
              ],
        );
        if (page.conversation)
          setConversations((items) => [
            page.conversation,
            ...items.filter((item) => item.id !== run.conversationId),
          ]);
      } catch (cause) {
        if (request === conversationRequest) setError(cause.message);
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
      const previousBranch = branchId(),
        targetBranch = fork ? crypto.randomUUID() : previousBranch,
        requestId = crypto.randomUUID();
      setError("");
      setSending(true);
      try {
        const accepted = await rpc("chat.start", {
          projectId: projectId(),
          agentId: agent.id,
          conversationId: conversationId(),
          requestId,
          message,
          branchId: targetBranch,
          modelId: model.id,
          ...(fork
            ? { forkTurnId: fork.forkTurnId }
            : { expectedHeadTurnId: headTurnId() }),
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
        await observeRun({
          requestId: accepted.requestId,
          agentId: agent.id,
          conversationId: conversationId(),
          branchId: targetBranch,
          fork: Boolean(fork),
          previousBranch,
          after: 0,
          needsMessage: false,
        });
      } catch (cause) {
        setError(cause.message);
        setSending(false);
      }
    }
    async function load() {
      await feedback.perform(async () => {
        try {
          const workspace = await rpc("workspace.get", {
            projectId: projectId(),
          });
          setProjects(workspace.projects);
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
          while (!saved && query.get("conversation") && conversationCursor())
            saved = (await nextConversations()).find(
              (item) => item.id === query.get("conversation"),
            );
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
      if (filesLoaded() || filesBusy()) return;
      setFilesRequested(true);
      setFilesBusy(true);
      try {
        const objects = await rpc("objects.list", { projectId: projectId() });
        setFiles(objects.items);
        setFilesCursor(objects.nextCursor);
        setFilesLoaded(true);
      } catch (cause) {
        setError(cause.message);
      } finally {
        setFilesBusy(false);
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
      if (filesBusy() || !filesCursor()) return;
      setFilesBusy(true);
      try {
        const result = await rpc("objects.list", {
          projectId: projectId(),
          cursor: filesCursor(),
        });
        setFiles((items) => appendNew(items, result.items));
        setFilesCursor(result.nextCursor);
      } catch (cause) {
        setError(cause.message);
      } finally {
        setFilesBusy(false);
      }
    }
    const toolNames = {
      web_search: "web search",
      browser: "browser",
      execute_code: "code workspace",
      execute_command: "command workspace",
    };
    const agentName = (agent) => agent?.name || "Agent";
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
      (messages.length ? "Untitled conversation" : "New conversation");
    const day = 86400000;
    // Groups are keyed by label, so the sidebar keeps its sections across updates.
    const historyItems = createMemo(() => {
      const startOfToday = new Date().setHours(0, 0, 0, 0),
        groups = { Today: [], Yesterday: [], Earlier: [] };
      for (const item of conversations()) {
        const time = Date.parse(item.lastActivityAt || item.createdAt || "");
        groups[
          !time || time < startOfToday - day
            ? "Earlier"
            : time < startOfToday
              ? "Yesterday"
              : "Today"
        ].push(item);
      }
      return groups;
    });
    const historyGroups = () =>
      ["Today", "Yesterday", "Earlier"].filter(
        (label) => historyItems()[label].length,
      );
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
    let frame = 0;
    onCleanup(() => cancelAnimationFrame(frame));
    createEffect(() => {
      const latest = messages[messages.length - 1];
      latest?.text;
      latest?.tools?.length;
      latest?.status;
      // At most one layout read per frame, however fast tokens arrive.
      if (scroller && pinned && !frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          scroller.scrollTop = scroller.scrollHeight;
        });
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
              onClick=${(event) => activeRun() && observeRun(activeRun())}
            >
              Reconnect
            </button><//
          >
          <button
            type="button"
            class="menu-item danger"
            data-close
            onClick=${(event) =>
              rpc("chat.cancel", { requestId: activeRun()?.requestId }).catch(
                (cause) => setError(cause.message),
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
                >${(label) =>
                  html`<section class="history-group">
                    <h2 class="eyebrow">${label}</h2>
                    <${For} each=${() => historyItems()[label]}
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
                              relativeTime(item.lastActivityAt) +
                              (item.running ? " · working" : "")}</span
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
            <p class="visually-hidden" role="status">${announcement}</p>
            <div class="conversation" role="log" aria-label="Conversation" aria-live="off">
              <${Show} when=${olderCursor}>
                <button
                  class="load-earlier"
                  disabled=${loadingOlder}
                  onClick=${(event) => moreMessages()}
                >
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
                when=${() => loaded() && !loadingConversation() && !messages.length}
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
              <${For} each=${() => messages}
                >${(item, index) =>
                  html`<article class=${() => "message " + item.role}>
                    <header class="turn-meta">
                      <span class="turn-role mono"
                        >${item.role === "user" ? "you" : () => agentName(selectedAgent())}</span
                      >
                      <${Show}
                        when=${() =>
                          item.turnId &&
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
                      <${Index} each=${() => messageSections(item.text)}>
                        ${(section, slot) =>
                          slot % 2
                            ? html`<pre><code>${section}</code></pre>`
                            : html`<${Index} each=${() => linkParts(section())}>
                                ${(part, at) =>
                                  at % 2
                                    ? html`<a
                                        href=${part}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        >${part}</a
                                      >`
                                    : textNode(part)}<//
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
                  loadingConversation()}
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
                  fallback=${html`<span class="hint mono">tools · execution handled by AgentCore</span>`}
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
                                  (model) => model.company === company,
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
                    loadingConversation()}
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
              ><button class="secondary" disabled=${filesBusy} onClick=${(event) => moreFiles()}>Load more files</button><//
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
