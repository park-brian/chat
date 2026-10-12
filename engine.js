// The engine: chats, their runs, the model clients, the tools, and the projects they change. One engine serves every
// tab of the app from a SharedWorker; where there is none, it runs in the tab, over the same port. index.html is its
// presentation: it shows what the engine sends, and runs what only a tab can (frames, screenshots, code).

// #region 1. IMPORTS & DEFINITIONS
import {
  DEFAULT_PROMPT, DELEGATING, ENVIRONMENT, EXPLORE_PROMPT, FORK_BRIEF, FRONTEND_SKILL, GENERAL_PROMPT, HARNESS_DOCUMENTATION,
  NETWORK, PART_BRIEF, PLAN_PROMPT, REVIEW_PROMPT, SUMMARY_PROMPT, TOOL_DOCUMENTATION, VARIANT_BRIEF, WORKING,
} from "./prompts.js";

// A SharedWorker's console is its own; what the engine logs, and what it throws, goes to the tabs' consoles too. The
// first tab connects while the imports below are still loading: its port waits for the engine.
const inSharedWorker = typeof SharedWorkerGlobalScope === "function";
const early = [];
if (inSharedWorker) {
  onconnect = event => early.push(event.ports[0]);
  const tabs = new BroadcastChannel("engine-console");
  const text = args => args.map(a => a instanceof Error ? a.stack : typeof a === "string" ? a : JSON.stringify(a)).join(" ");
  for (const level of ["error", "warn"]) {
    const log = console[level].bind(console);
    console[level] = (...args) => { log(...args); tabs.postMessage({ level, text: text(args) }); };
  }
  addEventListener("error", e => console.error(e.error ?? e.message));
  addEventListener("unhandledrejection", e => console.error(e.reason));
}

// Every package the app loads from the CDN, at the version it was tested with. index.html's import map and
// stylesheets name the same URLs; its tests hold them to this table.
const CDN = Object.fromEntries(Object.entries({
  "@aws-sdk/client-bedrock-runtime": "3.1149.0", "@google/genai": "1.52.0", "@mozilla/readability": "0.6.0", acorn: "8.19.0",
  bootstrap: "5.3.8", "bootstrap-icons": "1.13.2", diff: "5.2.2", dompurify: "3.4.16", idb: "8.0.4", mammoth: "1.13.0",
  marked: "15.0.12", "modern-screenshot": "4.7.0", "pdfjs-dist": "6.3.289", "solid-js": "1.9.17", tcpipe: "1.0.0",
  turndown: "7.2.4", "turndown-plugin-gfm": "1.0.2",
}).map(([name, version]) => [name, `https://cdn.jsdelivr.net/npm/${name}@${version}`]));

const [{ BedrockRuntimeClient, ConverseStreamCommand }, { GoogleGenAI }, { openDB }, { createTwoFilesPatch, diffLines }] = await Promise.all(
  ["@aws-sdk/client-bedrock-runtime", "@google/genai", "idb", "diff"].map(name => import(`${CDN[name]}/+esm`)));

// A tab shares its Solid with the engine, so the UI tracks the stores the engine makes. A worker has no import map
// and no UI: it takes the store from the CDN, and has nothing to batch.
const inWorker = typeof WorkerGlobalScope === "function";
const { createStore, produce, reconcile, unwrap } = await import(inWorker ? `${CDN["solid-js"]}/store/+esm` : "solid-js/store");
const batch = inWorker ? fn => fn() : (await import("solid-js")).batch;

// A prompt's {name} placeholders, filled. Values go in as they are: none is read as a replacement pattern.
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (match, name) => values[name] ?? match);

// Assembled per request: the agent's own prompt and memories, then how this harness works, for the tools it has.
function systemPrompt(persona, { tools = [], memories = null } = {}) {
  const guide = TOOL_DOCUMENTATION.split(/\n(?=### )/).filter(part => !part.startsWith("### ") || tools.includes(part.match(/^### (\w+)/)[1]));
  const artifacts = tools.some(name => WORKSPACE_TOOL_NAMES.includes(name)) && HARNESS_DOCUMENTATION;
  const delegating = artifacts && tools.includes("task") && DELEGATING;
  const network = relayUrl() && fill(NETWORK, { relay: relayUrl(), tcpipe: CDN.tcpipe });
  return [persona, memories, ENVIRONMENT, WORKING, delegating, guide.join("\n"), artifacts, network].filter(Boolean).join("\n");
}

// /memories/ as the conversation found it. Taken once per thread: the prompt stays byte-stable for the cache,
// and what the agent saves later is already in its history.
const MEMORY_BUDGET = 16000;
async function memoriesBlock(db, agentId) {
  const files = (await db.getAllFromIndex("resources", "agentId", agentId)).filter(r => r.path.startsWith("memories/")).sort((a, b) => a.path.localeCompare(b.path));
  if (!files.length) return "\n## Memories\n/memories/ is empty.\n";
  let room = MEMORY_BUDGET;
  const shown = [], held = [];
  for (const f of files) {
    const text = `### ${f.path}\n${String(f.content ?? "").trim()}\n`;
    if (text.length <= room) { shown.push(text); room -= text.length; } else held.push(f.path);
  }
  const rest = held.length ? `Not shown for length (view when needed): ${held.join(", ")}\n` : "";
  return `\n## Memories\nThe contents of /memories/ when this conversation began.\n\n${shown.join("\n")}${rest}`;
}

// edit_file takes a patch: the file's own text between markers, so code goes in without JSON escaping.
const PATCH_FORMAT = "<<<<<<< SEARCH\nexact lines from the file\n=======\nthe lines to put there\n>>>>>>> REPLACE";
const SEARCH_MARK = /^\s*<{5,9}\s*(SEARCH)?\s*$/i, DIVIDER_MARK = /^\s*={5,9}\s*$/, REPLACE_MARK = /^\s*>{5,9}\s*(REPLACE)?\s*(ALL)?\s*$/i;

// Tools every agent gets, independent of its saved tool list.
const WORKSPACE_TOOL_NAMES = ["view_file", "edit_file", "write_file", "run_app", "history", "diff", "restore"];
// A fork reads and reports; changes and further sub-agents stay with the caller.
const FORK_REFUSES = ["task", "edit_file", "write_file", "restore"];
const VARIANT_REFUSES = ["task"];
const PATH_PROPERTY = { type: "string", description: "File path, e.g. index.html, notes.md, logo.svg. Defaults to the shown artifact." };
const SCREENSHOT_PROPERTY = { type: "boolean", description: "true forces a screenshot, false skips it. By default one is attached when the user lets you see the page and it changed." };

const CAPTURE_CHOICE_KEY = "harness.capture"; // localStorage: allowed | dismissed
const PROXY_CONFIG_KEY = "proxy-config"; // localStorage: one CORS proxy for every agent
// Same sizes as test.js, so a report here matches a headless run.
const VIEWPORTS = { desktop: [1440, 900], tablet: [768, 1024], mobile: [390, 844] };

// Each model lists the reasoning levels it accepts, lowest first, and how to ask for one. Checked against the live
// APIs and current model cards: Fable, Opus, and Sonnet use adaptive thinking; Haiku 5.5 can turn it off. Gemini
// and Sol 6.1 always reason; Sol and Luna send theirs encrypted, so it shows as thinking with nothing to read.
const LEVELS = ["off", "low", "medium", "high", "xhigh", "max"];
// Claude 5 accepts 128k out; 64k leaves room for adaptive thinking and a long file in one reply.
const CLAUDE_5 = { window: 1_000_000, maxTokens: 64_000, levels: ["low", "medium", "high", "xhigh", "max"], reasoning: effort => ({ thinking: { type: "adaptive", display: "summarized" }, output_config: { effort } }) };
const CLAUDE_BUDGET = { levels: ["off", "low", "medium", "high"], reasoning: level => ({ thinking: { type: "enabled", budget_tokens: { low: 4_000, medium: 8_000, high: 16_000 }[level] } }) };
const GPT_6 = { window: 1_050_000, levels: ["off", "low", "medium", "high", "xhigh", "max"], reasoning: effort => ({ reasoning: { effort } }), off: { reasoning: { effort: "none" } } };
const MODELS = [
  { id: "global.anthropic.claude-fable-5-1", label: "Fable 5.1", group: "AWS Bedrock", ...CLAUDE_5 },
  { id: "global.anthropic.claude-opus-5-5", label: "Opus 5.5", group: "AWS Bedrock", ...CLAUDE_5 },
  { id: "global.anthropic.claude-sonnet-5-5", label: "Sonnet 5.5", group: "AWS Bedrock", ...CLAUDE_5 },
  { id: "global.anthropic.claude-haiku-5-5", label: "Haiku 5.5", group: "AWS Bedrock", ...CLAUDE_5, levels: ["off", ...CLAUDE_5.levels], off: { thinking: { type: "disabled" } } },
  // Bedrock's OpenAI models take no cache points and no documents. They see a tool result's image only beside it,
  // in the same message, never inside it (evals/NOTES.md).
  { id: "global.openai.gpt-6.1-sol", label: "Sol 6.1", group: "AWS Bedrock", ...GPT_6, levels: ["low", "medium", "high", "xhigh", "max"], cache: false, documents: false, beside: true },
  { id: "global.openai.gpt-6-luna", label: "Luna 6", group: "AWS Bedrock", ...GPT_6, cache: false, documents: false, beside: true },
  // Grok too, and it caches by itself. Its effort refuses none, and above low it sends nothing while it thinks: at
  // medium and high, one harness turn got no reply in 10 and 15 minutes; at low, 40-90 s (evals/NOTES.md).
  { id: "global.xai.grok-4.7", label: "Grok 4.7", group: "AWS Bedrock", levels: ["low"], reasoning: effort => ({ reasoning: { effort } }), cache: false, documents: false, beside: true },
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", group: "Google", levels: ["low", "medium", "high"], reasoning: thinkingLevel => ({ thinkingLevel }), window: 1_048_576 },
  { id: "echo", label: "Echo", group: "Test" },
];
const DEFAULT_MODEL = "global.anthropic.claude-haiku-5-5";
const SUBAGENT_TYPES = ["fork", "variant", "part", "explore", "plan", "general", "review"];
const SUBAGENT_MODELS = MODELS.filter(m => m.group !== "Test").map(m => m.label);
const modelInfo = id => ({ maxTokens: 32_000, window: 200_000, cache: true, documents: true, beside: false, ...(MODELS.find(m => m.id === id) ?? { id, ...(/anthropic/.test(id) && CLAUDE_BUDGET) }) });
// The level a model runs at: the one asked for, or the nearest it accepts.
function reasoningLevel(model, level) {
  if (!model.levels) return "off";
  const want = LEVELS.indexOf(level || "off");
  return model.levels.reduce((best, l) => (Math.abs(LEVELS.indexOf(l) - want) < Math.abs(LEVELS.indexOf(best) - want) ? l : best));
}
function reasoningFields(model, level) {
  const effective = reasoningLevel(model, level);
  return effective === "off" ? model.off ?? {} : model.reasoning(effective);
}
const providerOf = id => (id === "echo" ? "echo" : /^gemini/.test(id) ? "google" : "aws");
const MAX_TURNS = 60; // model calls per message before the loop pauses
const COMPACT_AT = 0.6; // share of the context window that triggers a summary

// Sub-agents as they run, by the toolUseId of their task call: { threadId, messages, currentMessage, status, type }.
// A finished one stays a minute, for a card or a test that asks after it, then goes.
const subagents = new Map();
const subagentListeners = new Set();
const SUBAGENT_KEPT_MS = 60_000;
const runningSubagents = () => subagents;
function setSubagent(toolUseId, entry) {
  if (entry) subagents.set(toolUseId, entry);
  else subagents.delete(toolUseId);
  subagentListeners.forEach(fn => fn(toolUseId));
}

const TOOLS = [
  {
    // Code runs in a frame, which only a tab has; the engine asks one.
    fn: (input, { host, threadId, agentId, workspace, signal }) => host ? host.code({ input: unwrap(input), threadId, agentId, projectId: workspace?.state.project?.id ?? null }, { signal }) : { error: "No tab is open to run code in." },
    toolSpec: {
      name: "code",
      description: "Execute JavaScript or HTML code. Provide source directly, or use filename to run a file from the editor.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            source: { type: "string", description: "The code to execute (ignored if filename provided)" },
            filename: { type: "string", description: "Path to a workspace or editor file to run instead of source" },
            language: { type: "string", description: "Language (js/html). Auto-detected from filename extension.", default: "javascript" },
            timeout: { type: "number", description: "Seconds before it is stopped, up to 60.", default: 5 },
          },
        },
      },
    },
  },
  {
    fn: think,
    toolSpec: {
      name: "think",
      description: "Use this tool to create a dedicated thinking space for complex reasoning. Use it when you need to analyze information, plan steps, or work through problems before providing a final answer.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            thought: { type: "string", description: "Your detailed thought process, analysis, or reasoning steps." },
          },
          required: ["thought"],
        },
      },
    },
  },
  {
    fn: editor,
    toolSpec: {
      name: "editor",
      description: `Create, view, edit, delete, and rename your notes, skills, memories, and secrets. A project's files,
the app and its SPEC.md among them, have their own tools: view_file, edit_file, write_file.

Examples:
- View file: {"command": "view", "path": "notes.md"}
- View lines 1-10: {"command": "view", "path": "notes.md", "view_range": [1, 10]}
- List directory: {"command": "view", "path": "/"}
- Create file: {"command": "create", "path": "notes.md", "file_text": "# Notes"}
- Replace text: {"command": "str_replace", "path": "notes.md", "old_str": "foo", "new_str": "bar"}
- Insert at line 5: {"command": "insert", "path": "notes.md", "insert_line": 5, "new_str": "- a line"}
- Delete file: {"command": "delete", "path": "old.txt"}
- Rename file: {"command": "rename", "path": "old.txt", "new_path": "new.txt"}`,
      inputSchema: {
        json: {
          type: "object",
          properties: {
            command: { type: "string", enum: ["view", "create", "str_replace", "insert", "delete", "rename"], description: "The operation to perform" },
            path: { type: "string", description: "The file or directory path (end with / for directories)" },
            view_range: { type: "array", items: { type: "integer" }, description: "Optional [start, end] line numbers (1-indexed, -1 for end). Only for view command on files." },
            old_str: { type: "string", description: "Text to replace (for str_replace command)" },
            new_str: { type: "string", description: "Replacement text (for str_replace and insert commands)" },
            file_text: { type: "string", description: "File content (for create command)" },
            insert_line: { type: "integer", description: "Line number to insert after (0 for beginning, for insert command)" },
            new_path: { type: "string", description: "New path for rename command" },
          },
          required: ["command", "path"],
        },
      },
    },
  },
  {
    fn: mcp,
    toolSpec: {
      name: "mcp",
      description: `Interact with MCP (Model Context Protocol) servers. Commands:
- list_servers: Show configured MCP servers and their status
- list_tools [server]: List tools available from an MCP server
- call_tool [server] [tool] [args]: Call a tool on an MCP server
- list_resources [server]: List available resources from an MCP server
- read_resource [server] [uri]: Read a resource by URI
- list_prompts [server]: List available prompts from an MCP server
- get_prompt [server] [name] [args]: Get an expanded prompt
- Use filename parameter to save any result to a resource file`,
      inputSchema: {
        json: {
          type: "object",
          properties: {
            command: { type: "string", enum: ["list_servers", "list_tools", "call_tool", "list_resources", "read_resource", "list_prompts", "get_prompt"], description: "The MCP command to execute" },
            server: { type: "string", description: "MCP server name (required for all commands except list_servers)" },
            tool: { type: "string", description: "Tool name (required for call_tool)" },
            uri: { type: "string", description: "Resource URI (required for read_resource)" },
            name: { type: "string", description: "Prompt name (required for get_prompt)" },
            args: { type: "object", description: "Arguments object for call_tool or get_prompt" },
            filename: { type: "string", description: "Optional path to save results to a resource file" },
          },
          required: ["command"],
        },
      },
    },
  },
  {
    fn: task,
    toolSpec: {
      name: "task",
      description: `Spawn a sub-agent. Several in one turn run in parallel.
- fork: A copy of you with this whole conversation, answering one question. Reads, never changes files. Cheap: it reuses your cached context.
- variant: A fork that builds one take on the work, on a branch of its own; returns its versions. For a take that is the work (a mark, a layout) or takes the user asked for, not for behavior the user spelled out: several in one turn try several takes.
- part: A fork that builds one part of the whole on a branch, changing only its files, which are yours when it returns. Several in one turn build the parts of one contract at once.
- explore: Starts fresh with only this prompt. Finds information, saves EXACT raw data to /explore/{folder}/
- plan: Designs implementation approach, can read explore findings
- general: Does a self-contained piece of work and reports the result
- review: Fresh eyes on the artifact. Runs it, looks at it, tries it; returns ranked defects with evidence. Never changes files.`,
      inputSchema: {
        json: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "What the sub-agent should do" },
            type: { type: "string", enum: SUBAGENT_TYPES, description: "Agent type" },
            folder: { type: "string", description: "For explore: folder name under /explore/ to save findings" },
            files: { type: "array", items: { type: "string" }, description: "For a part: the files it owns, as paths or folders ending in /. It changes only these." },
            model: { type: "string", enum: SUBAGENT_MODELS, description: "Not for a fork, variant, or part. Defaults to yours; a smaller model suits bulk reading." },
          },
          required: ["prompt", "type"],
        },
      },
    },
  },
  {
    fn: webSearch,
    toolSpec: {
      name: "web_search",
      description: "Search the web with Brave. Returns each result's title, URL, age, and snippets from the page. Read a page whole with read_url.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            query: { type: "string", description: "What to search for, as you would type it" },
            count: { type: "integer", description: "Results, 1-20 (default 10)" },
            freshness: { type: "string", enum: ["pd", "pw", "pm", "py"], description: "Only pages from the past day, week, month, or year" },
          },
          required: ["query"],
        },
      },
    },
  },
  {
    fn: (input, { host, signal }) => host ? host.readUrl({ input: unwrap(input) }, { signal }) : { error: "No tab is open to read it in." },
    toolSpec: {
      name: "read_url",
      description: "Read a URL as markdown: a web page's main text, a PDF, a Word document, text or JSON as they are, an image as itself. Long pages come in parts; from gives the next.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            url: { type: "string", description: "The whole URL, with https://" },
            from: { type: "integer", description: "Character to start at, from the last part's note" },
            render: { type: "boolean", description: "Run the page's scripts first, for a page that builds its content in the browser. Slower." },
            screenshot: { type: "boolean", description: "Also see the page as it looks (renders it)" },
          },
          required: ["url"],
        },
      },
    },
  },
  {
    fn: viewFile,
    toolSpec: {
      name: "view_file",
      description: "Read an artifact or project file with line numbers. Without a range, files over 400 lines return an outline of regions, tags, and functions. A path ending in / lists files; with grep, it searches every file under it (\"/\" for all). An image (png, jpeg, gif, webp) returns what it looks like, a PDF its pages: a test's screenshots/name.webp, say.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            path: PATH_PROPERTY,
            start: { type: "integer", description: "First line (1-indexed)" },
            end: { type: "integer", description: "Last line (inclusive, -1 for end of file)" },
            grep: { type: "string", description: "Case-insensitive regular expression; returns matching lines with numbers, exactly as in the file" },
            context: { type: "integer", description: "Lines to show before and after each match, or around start when there is no end (0-10)" },
          },
        },
      },
    },
  },
  {
    fn: editFile,
    toolSpec: {
      name: "edit_file",
      description: "Change a file with SEARCH/REPLACE blocks, all or nothing, in order. Each SEARCH must match once (whitespace at line ends and indentation may differ); end a block with >>>>>>> REPLACE ALL to replace every match. Returns the new version and, when the file renders, its run report.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            path: PATH_PROPERTY,
            patch: { type: "string", description: "One or more blocks, the file's text as is, no escaping:\n" + PATCH_FORMAT },
            screenshot: SCREENSHOT_PROPERTY,
          },
          required: ["patch"],
        },
      },
    },
  },
  {
    fn: writeFile,
    toolSpec: {
      name: "write_file",
      description: "Create or replace a whole file; it becomes the shown artifact when it renders. Returns the new version and its run report.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            path: PATH_PROPERTY,
            content: { type: "string", description: "Full file content" },
            screenshot: SCREENSHOT_PROPERTY,
          },
          required: ["content"],
        },
      },
    },
  },
  {
    fn: runApp,
    toolSpec: {
      name: "run_app",
      description: "Re-render the shown artifact (or an older version) with its tests and return the run report. Optionally run an async script in the page after it settles; its return value is included.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            path: { type: "string", description: "A file to run instead of the shown artifact, e.g. a page under scratch/" },
            version: { type: "integer", description: "Version id to run instead of the current file, such as one a variant returned" },
            viewport: { type: "string", enum: ["fit", "desktop", "tablet", "mobile"], description: "Preview size. Wider than a phone, the screenshot has a phone's width beside it" },
            script: { type: "string", description: "Async function body run in the app page, e.g. document.querySelector('button').click(); return document.title" },
            screenshot: { type: "boolean", description: "Attach a screenshot (default true; approximate when the user has not shared the tab)" },
          },
        },
      },
    },
  },
  {
    fn: listHistory,
    toolSpec: {
      name: "history",
      description: "List recent file versions, newest first, with source and test outcome.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            path: { type: "string", description: "Only versions of this file" },
            limit: { type: "integer", description: "Maximum versions (default 20)" },
          },
        },
      },
    },
  },
  {
    fn: diffVersions,
    toolSpec: {
      name: "diff",
      description: "Unified diff between two versions of a file. to defaults to the current version.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            from: { type: "integer", description: "Older version id" },
            to: { type: "integer", description: "Newer version id (default: current)" },
          },
          required: ["from"],
        },
      },
    },
  },
  {
    fn: restoreVersion,
    toolSpec: {
      name: "restore",
      description: "Make an earlier version current again. History is kept; the restore is a new version.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            version: { type: "integer", description: "Version id to restore" },
          },
          required: ["version"],
        },
      },
    },
  },
];

// A copy of this app run as an artifact (the chat, worked on in the chat) keeps a database of its own: its tests
// would otherwise write over the chats of the app it runs in.
const DB_NAME = /\/__ws\//.test(globalThis.location?.pathname ?? "") ? "chat-workspace" : "chat";

// One schema, no migrations: a database made by any other version starts over empty.
// blocking: a newer version wants to upgrade, so this connection closes and its owner reloads. blocked: an older
// version still holds the database open.
const SCHEMA = { agents: [], threads: ["agentId"], messages: ["agentId", "threadId"], resources: ["agentId", "threadId"], projects: [], versions: ["projectId"] };
async function initDB({ blocking = () => {}, blocked = () => {} } = {}) {
  const db = await openDB(DB_NAME, 7, {
    upgrade(db) {
      for (const name of [...db.objectStoreNames]) db.deleteObjectStore(name);
      for (const [name, indexes] of Object.entries(SCHEMA)) {
        const store = db.createObjectStore(name, { keyPath: "id", autoIncrement: true });
        for (const index of indexes) store.createIndex(index, index);
      }
      db.createObjectStore("blobs", { keyPath: "hash" });
    },
    blocked,
    blocking() { db.close(); blocking(); },
  });
  return db;
}

// A new database starts with one agent and its skill.
async function ensureDefaultAgent(db) {
  const tx = db.transaction(["agents", "resources"], "readwrite");
  if (await tx.objectStore("agents").get(1)) return;
  tx.objectStore("agents").put({ id: 1, name: "default", systemPrompt: DEFAULT_PROMPT, tools: ["code", "think", "editor", "mcp", "task"], mcpServers: [], resources: [] });
  tx.objectStore("resources").add({ agentId: 1, path: "skills/frontend-design.md", content: FRONTEND_SKILL, createdAt: Date.now() });
  await tx.done;
}

// #endregion

// #region 2. ENGINE
// =============================================================================
// Runs by thread, the workspaces they change, and the port every tab talks to.
// =============================================================================

// The engine runs chats; the UI shows one of them. Runs are keyed by thread, each with a store of its own, so a
// chat goes on while another is open. Commands and events are plain data, so the engine can move behind a port.
// workspaces.for(threadId) finds the workspace a chat's project is in, for as long as the run needs it.
function createEngine(db, { tools = TOOLS, workspaces = null, host = null, client = modelId => getConverseClient(providerOf(modelId)) } = {}) {
  const runs = new Map(); // threadId -> { store, setStore, controller, from, timer }
  const listeners = new Set();
  const emit = event => listeners.forEach(fn => fn(event));
  const running = () => [...runs.keys()];
  // A run holds run:<threadId> while it lives, so a row still marked running whose lock is free lost its tab.
  const lock = name => new Promise(granted => navigator.locks.request(name, { ifAvailable: true }, held => held ? new Promise(release => granted(release)) : granted(null)));

  // The thread row says a run is on: { status: "running" | "interrupted", leafId, modelId, reasoningMode }.
  async function markRun(threadId, run) {
    const thread = await db.get("threads", threadId);
    if (!thread) return;
    if (run) thread.run = run;
    else delete thread.run;
    await db.put("threads", thread);
  }

  // A sub-agent's entry goes out when it changes, every 50ms at most; null is one that went.
  const changed = new Set();
  let subagentTimer = null;
  const watchSubagents = toolUseId => {
    changed.add(toolUseId);
    subagentTimer ??= setTimeout(() => {
      subagentTimer = null;
      emit({ type: "subagents", entries: structuredClone([...changed].map(id => [id, subagents.get(id) ?? null])) });
      changed.clear();
    }, 50);
  };
  subagentListeners.add(watchSubagents);

  let recovered = recover();
  async function recover() {
    for (const thread of await db.getAll("threads")) {
      if (thread.run?.status !== "running" || runs.has(thread.id)) continue;
      const release = await lock("run:" + thread.id);
      if (!release) continue;
      await markRun(thread.id, { ...thread.run, status: "interrupted" });
      release();
      const state = await open(thread.id);
      if (state) emit({ type: "thread", threadId: thread.id, ...state, from: 0, after: thread.run.leafId });
    }
  }

  // Registers a run under its lock: null while the chat runs here or in another tab.
  async function claim(threadId) {
    if (runs.has(threadId)) return null;
    const [store, setStore] = createStore({ messages: [], messageTree: null, activePath: [], activeLeafId: null });
    const run = { store, setStore, controller: new AbortController(), from: Infinity, timer: null, release: null, leafId: null };
    runs.set(threadId, run);
    run.release = await lock("run:" + threadId);
    if (!run.release) {
      runs.delete(threadId);
      return null;
    }
    emit({ type: "runs", threadIds: running() });
    return run;
  }

  // Runs the chat on from leafId to the end of its branch; resolves when the run ends.
  async function launch(threadId, run, { agentId, modelId, reasoningMode, tree, leafId, resume = false }) {
    run.leafId = leafId;
    const record = await db.get("agents", +agentId);
    const names = new Set([...(record.tools || []), ...(workspaces ? WORKSPACE_TOOL_NAMES : []), ...webToolNames()]);
    const activePath = extendPath(tree, getPathToMessage(tree, leafId));
    run.setStore({
      id: record.id, name: record.name, systemPrompt: record.systemPrompt, resources: record.resources, modelId, reasoningMode,
      tools: tools.filter(t => names.has(t.toolSpec.name)),
      messages: activePath.map(id => tree.nodes.get(id)?.message).filter(Boolean),
      messageTree: tree, activePath, activeLeafId: activePath.at(-1),
    });
    await markRun(threadId, { status: "running", leafId, modelId, reasoningMode });
    // Every change marks where the next event starts: the message that was last, or the one it adds.
    const set = (...args) => {
      run.from = Math.min(run.from, Math.max(0, run.store.messages.length - 1));
      run.setStore(...args);
      run.timer ??= setTimeout(() => flush(threadId), 50);
    };
    const workspace = workspaces && (() => workspaces.for(threadId));
    return runAgentWithBranching(run.store, set, () => client(modelId), activePath.at(-1), { agentId, threadId }, db, { signal: run.controller.signal, workspace, host, resume });
  }

  // An event carries the messages from the first that changed, and the id of the one before them: a tab showing
  // another branch has a different message there, and leaves the event. A stream sends one every 50ms at most.
  function flush(threadId) {
    const run = runs.get(threadId);
    if (!run) return;
    clearTimeout(run.timer);
    run.timer = null;
    const messages = unwrap(run.store.messages);
    const from = Math.min(run.from, messages.length);
    run.from = Infinity;
    emit({ type: "thread", threadId, from, after: messages[from - 1]?.id ?? null, messages: structuredClone(messages.slice(from)), activeLeafId: run.store.activeLeafId, running: true });
  }

  // A chat as it stands: the run's store while it runs, else the database's most recent branch.
  async function open(threadId) {
    const run = runs.get(threadId);
    const thread = await db.get("threads", threadId);
    if (!thread) return null;
    if (run) {
      const { messages, messageTree, activePath, activeLeafId, modelId } = unwrap(run.store);
      return { thread, messages: structuredClone(messages), tree: messageTree, activePath: [...activePath], activeLeafId, modelId, running: true };
    }
    const history = await db.getAllFromIndex("messages", "threadId", threadId);
    const tree = history.length ? buildMessageTree(history) : null;
    const activePath = tree ? getMostRecentPath(tree) : [];
    const messages = activePath.map(id => tree.nodes.get(id)?.message).filter(Boolean);
    return { thread, messages, tree, activePath, activeLeafId: activePath.at(-1) ?? null, running: false };
  }

  // Starts a run and answers once its user message is saved: { threadId, done }, or null while that chat runs.
  // leafId is the message the reply follows; forkFromId, a message to retry or edit, which then branches.
  async function send({ agentId = 1, threadId = null, projectId = null, leafId = null, forkFromId = null, text, files = [], modelId, reasoningMode, liveErrors = [] }) {
    await recovered;
    if (threadId && runs.has(threadId)) return null;
    const name = text.trim().replace(/\s+/g, " ").slice(0, 60) || "Untitled";
    if (!threadId) threadId = await db.add("threads", { agentId, name, projectId, createdAt: Date.now() });
    const run = await claim(threadId);
    if (!run) return null;
    try {
      const ws = await workspaces?.for(threadId);
      if (["Untitled", "Untitled app"].includes(ws?.state.project?.name) && !leafId && forkFromId == null) await ws.rename(name);

      const history = await db.getAllFromIndex("messages", "threadId", threadId);
      const before = history.length ? buildMessageTree(history) : null;
      const forked = forkFromId != null ? before?.nodes.get(forkFromId)?.message : null;
      const parentId = forkFromId != null ? forked?.parentId ?? null : leafId ?? null;
      // A retry or edit starts from the files the original message saw.
      if (forked?.heads) await ws?.checkout(forked.heads);

      // Tell the model about file changes it did not make since it last saw them.
      const parent = parentId != null ? before?.nodes.get(parentId)?.message : null;
      const parentHeads = parentId == null ? null : parent && "heads" in parent ? parent.heads : undefined;
      const notice = await ws?.describeChanges(parentHeads, liveErrors);
      // A retry or edit keeps the original's attachments.
      const kept = forked ? forked.content.filter(c => c.image || c.document) : [];
      const [typed, ...attached] = await getMessageContent(text, files);
      const content = [...(notice ? [{ text: notice, harness: true }] : []), typed, ...kept, ...attached];
      const userMessage = { role: "user", content, parentId, createdAt: Date.now() };
      userMessage.id = await db.add("messages", { ...userMessage, agentId, threadId, heads: workspaces ? await projectHeads(db, threadId) : null });

      const tree = buildMessageTree(await db.getAllFromIndex("messages", "threadId", threadId));
      return { threadId, done: start(threadId, run, { agentId, modelId, reasoningMode, tree, leafId: userMessage.id }) };
    } catch (e) {
      await finish(threadId);
      throw e;
    }
  }

  // Picks up a run that lost its tab where its last saved message left it.
  async function resume(threadId) {
    await recovered;
    const thread = await db.get("threads", threadId);
    if (thread?.run?.status !== "interrupted") return null;
    const run = await claim(threadId);
    if (!run) return null;
    const tree = buildMessageTree(await db.getAllFromIndex("messages", "threadId", threadId));
    const { leafId, modelId, reasoningMode } = thread.run;
    return { threadId, done: start(threadId, run, { agentId: thread.agentId ?? 1, modelId, reasoningMode, tree, leafId, resume: true }) };
  }

  const start = (threadId, run, options) => launch(threadId, run, options).finally(() => finish(threadId));

  // The chat as the run left it, for the tabs whose branch holds the message the run went on from.
  async function finish(threadId) {
    const run = runs.get(threadId);
    clearTimeout(run?.timer);
    await markRun(threadId, null);
    runs.delete(threadId);
    run?.release?.();
    workspaces?.release(threadId);
    const state = await open(threadId);
    emit({ type: "runs", threadIds: running() });
    if (state) emit({ type: "thread", threadId, ...state, from: 0, after: run?.leafId ?? null });
  }

  return {
    open, send, resume, running,
    recover: () => (recovered = recovered.then(recover).catch(e => console.error(e))),
    stop: threadId => runs.get(threadId)?.controller.abort(),
    on: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    dispose: () => { for (const run of runs.values()) run.controller.abort(); listeners.clear(); subagentListeners.delete(watchSubagents); clearTimeout(subagentTimer); },
  };
}

// A run works on its own chat's project, in a workspace of its own without frames: host.run tests a version in
// a tab. Every workspace on a project follows the others, the panel included.
function createWorkspaces(db, host) {
  const own = new Map(); // threadId -> the engine's workspace
  return {
    async for(threadId) {
      const projectId = (await db.get("threads", threadId))?.projectId ?? null;
      let ws = own.get(threadId);
      if (!ws) own.set(threadId, (ws = createWorkspace(db, { host })));
      if (projectId && ws.state.project?.id !== projectId) await ws.open(projectId);
      return ws;
    },
    release(threadId) {
      const projectId = own.get(threadId)?.state.project?.id;
      own.get(threadId)?.dispose();
      own.delete(threadId);
      if (projectId && ![...own.values()].some(ws => ws.state.project?.id === projectId)) host.release(projectId);
    },
    dispose() {
      for (const ws of own.values()) ws.dispose();
      own.clear();
    },
  };
}

// The engine serves every tab from one place: a SharedWorker, or the tab itself where there is none. A tab
// connects a port and holds tab:<id> while it lives. The engine sends it every event and answers its commands,
// and asks a tab for what only a tab has (run, code): the tab showing the chat, else a visible one, else any.
// A call a tab took with it when it closed goes to the next.
const PROTOCOL = 3; // bump when a command, event, or host call changes
let served = null;
function serve(port) {
  const starting = served ??= startEngine();
  starting.then(engine => engine.connect(port), e => {
    if (served === starting) served = null; // the next tab tries again
    console.error(e);
    port.postMessage({ type: "refused", reason: e.message });
  });
}

const plainError = e => e instanceof Error ? { message: e.message, stack: e.stack } : e;
const toError = e => e?.message !== undefined ? Object.assign(new Error(e.message), e) : e;

async function startEngine() {
  const tabs = new Map(); // tabId -> { port, visible, threadId, calls: Map(id -> call) }
  // A newer version wants the database: this engine lets it go, and its tabs reload into the new one.
  const db = await initDB({
    blocking: () => { served = null; tabs.forEach(t => t.port.postMessage({ type: "reload" })); },
    blocked: () => console.warn("An older version of this app holds the database open: close its other tabs."),
  });
  let calls = 0;
  const choose = threadId => {
    const open = [...tabs.values()];
    return open.find(t => t.visible && t.threadId === threadId) ?? open.find(t => t.visible) ?? open[0] ?? null;
  };
  function dispatch(call) {
    const tab = call.tab = choose(call.threadId);
    if (!tab) return call.reject(new Error("No tab is open to run it in."));
    tab.calls.set(call.id, call);
    tab.port.postMessage({ type: "call", id: call.id, method: call.method, args: call.args });
  }
  // A run's stop reaches the tab doing its work. The call leaves that tab's list first, so a tab that closes
  // meanwhile doesn't hand it on.
  const ask = method => (args, { signal } = {}) => new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const cancel = () => {
      call.tab?.calls.delete(call.id);
      call.tab?.port.postMessage({ type: "cancel", id: call.id });
      reject(signal.reason);
    };
    const settle = fn => value => { signal?.removeEventListener("abort", cancel); fn(value); };
    const call = { id: ++calls, method, args, threadId: args.threadId, resolve: settle(resolve), reject: settle(reject), tab: null };
    signal?.addEventListener("abort", cancel, { once: true });
    dispatch(call);
  });
  const host = {
    run: ask("run"),
    code: ask("code"),
    readUrl: ask("readUrl"),
    release: (projectId, branch = null) => tabs.forEach(t => t.port.postMessage({ type: "release", projectId, branch })),
  };
  const workspaces = createWorkspaces(db, host);
  const engine = createEngine(db, { workspaces, host });
  engine.on(event => tabs.forEach(t => t.port.postMessage(event)));

  function drop(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    tabs.delete(tabId);
    tab.port.close();
    for (const call of tab.calls.values()) dispatch(call);
  }

  const commands = {
    open: ({ threadId }) => engine.open(threadId),
    stop: ({ threadId }) => engine.stop(threadId),
    running: () => engine.running(),
    send: args => engine.send(args),
    resume: ({ threadId }) => engine.resume(threadId),
  };

  function connect(port) {
    let tab = null;
    port.onmessage = async ({ data }) => {
      if (data.type === "hello") {
        if (data.protocol !== PROTOCOL) return port.postMessage({ type: "refused", reason: `The engine speaks protocol ${PROTOCOL}, the tab ${data.protocol}.` });
        tab = { port, visible: data.visible, threadId: data.threadId, calls: new Map() };
        tabs.set(data.tabId, tab);
        navigator.locks.request("tab:" + data.tabId, () => drop(data.tabId));
        port.postMessage({ type: "runs", threadIds: engine.running() });
        port.postMessage({ type: "subagents", entries: structuredClone([...subagents]), full: true });
        engine.recover();
      } else if (data.type === "settings") {
        applySettings(data.settings);
      } else if (data.type === "view") {
        // A view or an answer before hello has no tab to go to.
        if (tab) Object.assign(tab, { visible: data.visible, threadId: data.threadId });
      } else if (data.type === "answer") {
        const call = tab?.calls.get(data.id);
        tab?.calls.delete(data.id);
        if ("error" in data) call?.reject(toError(data.error));
        else call?.resolve(data.value);
      } else if (data.type === "command") {
        if (data.settings) applySettings(data.settings);
        try {
          if (!Object.hasOwn(commands, data.name)) throw new Error(`Unknown command: ${data.name}`);
          const value = await commands[data.name](data.args);
          // A run answers once it starts, and again when it ends.
          if (value?.done) value.done.then(() => port.postMessage({ type: "done", id: data.id }), e => port.postMessage({ type: "done", id: data.id, error: plainError(e) }));
          port.postMessage({ type: "reply", id: data.id, value: value?.done ? { threadId: value.threadId } : value ?? null });
        } catch (e) {
          port.postMessage({ type: "reply", id: data.id, error: plainError(e) });
        }
      }
    };
  }
  return { connect };
}

// #endregion

// #region 3. AGENT LOOP & STREAMING
// =============================================================================
// Core agent loop, streaming response processing, and command construction.
// =============================================================================

// The note for a turn whose latest run report is not ok, or null.
function failingReport(messages) {
  const report = messages.flatMap(m => m.content ?? []).map(c => c?.toolResult?.content?.[0]?.json?.result?.report).filter(r => r && !isScratch(r.path)).at(-1);
  if (!report || report.ok !== false) return null;
  const why = [...(report.errors ?? []), ...(report.tests?.failures ?? []), ...(report.notes ?? [])].slice(0, 3).join("; ").replace(/(?<=[^.])$/, ".") || "see the report.";
  return `The last run report for ${report.path} is not ok: ${why} Fix the cause before you finish, or say why you can't. Never fake data or drop what was asked to get a passing report.`;
}

// The note for a turn that changed a file without adding a test to it, or null. The count to beat is the file's
// last report before the turn; a file new this turn has none, so any test will do.
function untestedChange(messages, start) {
  const reports = messages.map((m, i) => (m.content ?? []).map(c => [i, c?.toolResult?.content?.[0]?.json?.result?.report]).filter(([, r]) => r?.path && !isScratch(r.path))).flat();
  const count = r => (r?.tests?.passed ?? 0) + (r?.tests?.failed ?? 0);
  const changed = messages.slice(start).flatMap(m => (m.content ?? []).filter(c => ["edit_file", "write_file"].includes(c?.toolUse?.name))).length;
  const [, after] = reports.findLast(([i]) => i >= start) ?? [];
  if (!changed || !after || !isHtml(after.path) || after.notes?.some(n => n.startsWith("Not run"))) return null; // only HTML runs tests, and only a page that ran counts them
  const [, before] = reports.findLast(([i, r]) => i < start && r.path === after.path) ?? [];
  if (count(after) > count(before)) return null;
  return `This turn changed ${after.path} and added no test. Write a test for each behavior you add and each bug you fix, or say why this change has none.`;
}

// The note for a turn whose variants made versions and none was restored after them, or null: their work is on
// their branches, and the user sees none of it.
function unadoptedVariants(messages, start) {
  const blocks = messages.slice(start).flatMap(m => m.content ?? []), result = c => c?.toolResult?.content?.[0]?.json?.result;
  const last = blocks.findLastIndex(c => result(c)?.type === "variant" && Object.keys(result(c).versions ?? {}).length);
  if (last < 0 || blocks.slice(last).some(c => c?.toolUse?.name === "restore")) return null;
  return "Your variants' versions are on their branches, not in your files: the user sees none of them. Restore the one you choose, or ask the user to choose from the takes.";
}

// The note for a turn that chose from its takes and kept reworking the choice, or null: a taste polished past
// its fixes costs the user's wait and buys another taste.
function polishedTake(messages, start, most = 6) {
  const results = messages.slice(start).flatMap(m => m.content ?? []).map(c => c?.toolResult?.content?.[0]?.json?.result).filter(Boolean);
  const last = results.findLastIndex(r => r.type === "variant" && Object.keys(r.versions ?? {}).length);
  const since = last < 0 ? 0 : results.slice(last + 1).filter(r => r.version != null && r.path).length;
  return since < most ? null : `${since} versions since your takes came back. Stop when the next change would be a different taste, not a fix: say which take you chose and why.`;
}

// The note for a reply that ended in thought alone, with no text and no call, or null.
function silentReply(messages) {
  const last = messages.at(-1);
  if (last?.role !== "assistant" || (last.content ?? []).some(c => c?.text?.trim() || c?.toolUse)) return null;
  // Why: Gemini wrote a whole game in one call twice; each came back malformed and empty, and it was told only "no text"
  if (last.stopReason === "malformed_tool_call") return "Your tool call came back malformed, so nothing ran: a call that large fails as a whole. Write the file in parts: write_file with the skeleton, then edit_file to fill each part.";
  if (last.stopReason === "max_tokens") return "Your reply reached the output limit before any text or tool call. Write the file in parts: write_file with the skeleton, then edit_file to fill each part.";
  return "Your reply ended with no text and no tool call. Go on with the work, or answer.";
}

// workspace: the run's workspace, or a function that finds it each turn, since the chat's project can open in
// the panel or close there while the run goes on.
// resume: pick up a run whose tab closed, from the last message it saved.
async function runAgentWithBranching(store, setStore, client, lastMessageId, params, db, { signal, workspace, host = null, maxTurns = MAX_TURNS, resume = false } = {}) {
  // Each message records the file heads it left behind, so a branch can restore the code it saw.
  const saveMsg = async msg => db.add("messages", { ...unwrap(msg), agentId: params.agentId, threadId: params.threadId, heads: workspace ? await projectHeads(db, params.threadId) : null });
  const toolMap = Object.fromEntries(store.tools.map(t => [t.toolSpec.name, t.fn]));
  const push = async msg => {
    setStore("messages", store.messages.length, msg);
    const id = await saveMsg(msg);
    setStore("messages", store.messages.length - 1, "id", id);
    return id;
  };
  let parentId = lastMessageId;
  let streaming = null;
  const start = store.messages.length;
  const reminded = new Set();
  const runTools = async (callsId, conversation, cutOff) => {
    const ws = typeof workspace === "function" ? await workspace() : workspace;
    const context = { db, threadId: params.threadId, agentId: params.agentId, modelId: store.modelId, reasoningMode: store.reasoningMode, workspace: ws, host, signal, conversation, cutOff };
    const results = await getToolResults(store.messages.at(-1).content, toolMap, context);
    // Reworking a chosen take is noticed while it happens, once per turn, since the turn may not end before the user's patience.
    const polished = !reminded.has("polished") && polishedTake([...store.messages, results], start);
    if (polished) { reminded.add("polished"); results.content.push({ text: polished, harness: true }); }
    return push({ ...results, parentId: callsId, createdAt: Date.now() });
  };

  try {
    // Resolved here so a missing key becomes an error reply instead of a stuck request.
    if (typeof client === "function") client = await client();
    const thread = await db.get("threads", params.threadId);
    let summary = thread?.summary ?? null;
    let memories = thread?.memories ?? null;
    if (memories == null && store.tools.some(t => t.toolSpec.name === "editor")) {
      memories = await memoriesBlock(db, params.agentId);
      if (thread) await db.put("threads", { ...(await db.get("threads", params.threadId)), memories });
    }
    // Calls made and never answered run first; a reply that had finished has nothing to add.
    const last = store.messages.at(-1);
    if (resume && last?.role === "assistant") {
      if (!last.content.some(c => c?.toolUse)) return;
      parentId = await runTools(last.id, null, false);
    }
    for (let turn = 0; ; turn++) {
      signal?.throwIfAborted();
      if (turn === maxTurns) {
        const note = { text: `(Paused after ${maxTurns} steps. Say "continue" to go on.)` };
        setStore("activeLeafId", await push({ role: "assistant", content: [note], parentId, createdAt: Date.now() }));
        break;
      }
      summary = await compactHistory(store, client, db, params.threadId, summary, memories, signal);
      const request = { ...unwrap(store), summary, memories, messages: store.messages.map(({ id, role, modelId, content }) => ({ id, role, modelId, content: unwrap(content) })) };
      const output = await watchedSend(client, getConverseCommand(request), signal);

      setStore("messages", store.messages.length, { role: "assistant", content: [], parentId, createdAt: Date.now(), modelId: store.modelId });
      streaming = store.messages.length - 1;

      let stopReason = null;
      for await (const msg of output.stream) {
        signal?.throwIfAborted();
        setStore(produce(s => processStreamChunk(s.messages.at(-1).content, msg)));
        if (msg.messageStop) stopReason = msg.messageStop.stopReason;
        if (msg.metadata?.usage) setStore("messages", streaming, "usage", msg.metadata.usage);
      }

      if (stopReason) setStore("messages", streaming, "stopReason", stopReason);
      const savedId = await saveMsg(store.messages.at(-1));
      setStore("messages", streaming, "id", savedId);
      setStore("activeLeafId", savedId);
      streaming = null;
      parentId = savedId;

      // Calls run whatever the stop reason says: a stream can close without one, and an unanswered call ends the turn.
      if (!store.messages.at(-1).content.some(c => c?.toolUse)) {
        // Stopping silent, on a failing report, on a change with no test, or with variants' work left on their branches
        // gets one reminder each per turn; then the model's word stands.
        const reminder = [["silent", () => silentReply(store.messages)], ["failing", () => failingReport(store.messages.slice(start))], ["untested", () => untestedChange(store.messages, start)], ["unadopted", () => unadoptedVariants(store.messages, start)]].find(([kind, note]) => !reminded.has(kind) && note());
        if (!reminder) break;
        reminded.add(reminder[0]);
        const note = reminder[1]();
        parentId = await push({ role: "user", content: [{ text: note, harness: true }], parentId, createdAt: Date.now() });
        continue;
      }

      // A fork continues this exact request, so it reads the cache the request just wrote.
      parentId = await runTools(savedId, { request, turn: unwrap(store.messages.at(-1).content) }, stopReason === "max_tokens");
    }
  } catch (error) {
    // Keep what streamed so far, minus unfinished tool calls, and say why the turn ended.
    const aborted = signal?.aborted;
    const note = { text: aborted ? "(stopped)" : `Error: ${error?.message || error}` };
    const flags = aborted ? {} : { error: true };
    if (streaming != null) {
      const texts = store.messages[streaming].content.filter(c => c?.text).map(c => ({ text: c.text }));
      const content = aborted && texts.length ? texts : [...texts, note];
      setStore("messages", streaming, m => ({ ...m, content, ...flags }));
      const id = await saveMsg(store.messages[streaming]);
      setStore("messages", streaming, "id", id);
      setStore("activeLeafId", id);
    } else {
      setStore("activeLeafId", await push({ role: "assistant", content: [note], parentId, createdAt: Date.now(), ...flags }));
    }
  } finally {
    const allMessages = await db.getAllFromIndex("messages", "threadId", params.threadId);
    const tree = buildMessageTree(allMessages);
    setStore("messageTree", tree);
    setStore("activePath", getMostRecentPath(tree));
  }
}

// The heads of a chat's project as they stand, or null for a chat without one.
async function projectHeads(db, threadId) {
  const projectId = threadId && (await db.get("threads", threadId))?.projectId;
  const project = projectId && (await db.get("projects", projectId));
  return project ? { ...project.heads } : null;
}

function getConverseCommand(config) {
  const model = modelInfo(config.modelId);
  const cachePoint = model.cache ? [{ cachePoint: { type: "default" } }] : [];
  const tools = config.tools.map(({ toolSpec }) => ({ toolSpec }));
  const system = systemPrompt(config.systemPrompt, { tools: tools.map(t => t.toolSpec.name), memories: config.memories });
  return {
    modelId: config.modelId,
    messages: prepareMessages(config.messages, { documents: model.documents, beside: model.beside, cache: model.cache, summary: config.summary, tail: config.tail, modelId: config.modelId }),
    // Tools come before the system prompt in the cached prefix, so the system's point covers both.
    system: [{ text: system }, ...cachePoint],
    toolConfig: { tools },
    inferenceConfig: { maxTokens: model.maxTokens },
    additionalModelRequestFields: reasoningFields(model, config.reasoningMode),
  };
}

// What the model sees. Old screenshots and bulky tool results shrink in steps, so the request prefix (and its
// cache) changes rarely; a summary stands in for everything before it. A tail (a fork's own turns) follows the
// history without moving those steps, so a fork's prefix is the parent's, byte for byte.
// Cache points ride the last two user messages: the newest writes, the one before is where the previous
// request (or the parent of a fork) wrote, so the read is exact however many blocks the last turn added.
// Reasoning goes back only to the model that wrote it: another model can't read its signature and rejects the turn.
function prepareMessages(messages, { documents = true, beside = false, cache = false, summary = null, tail = [], modelId = null } = {}) {
  const through = summary ? messages.findIndex(m => m.id === summary.throughId) : -1;
  if (through >= 0) messages = [{ role: "user", content: [{ text: `<summary>\n${summary.text}\n</summary>` }] }, ...messages.slice(through + 1)];
  const results = messages.flatMap((m, i) => (m.content.some(b => b?.toolResult) ? [i] : []));
  const olderThan = (keep, step) => results[Math.floor(Math.max(0, results.length - keep) / step) * step - 1] ?? -1;
  const oldImages = olderThan(3, 3);
  const oldResults = olderThan(10, 10);
  const calls = new Map(messages.flatMap(m => m.content.filter(b => b?.toolUse).map(b => [b.toolUse.toolUseId, b.toolUse])));
  const unread = name => ({ text: `[${name || "document"} omitted: this model can't read documents]` });
  const out = fillEmpty([...messages, ...tail].map(({ role, content, modelId: author }, i) => ({
    role,
    content: content.flatMap(block => {
      if (typeof block?.text === "string" && !block.text.trim()) return [];
      if (block?.reasoningContent && author && modelId && author !== modelId) return [];
      if (block?.reasoningContent?.redactedContent != null) return { reasoningContent: { redactedContent: block.reasoningContent.redactedContent } };
      if (block?.harness) return { text: block.text };
      if (block?.toolUse && (block.toolUse.input == null || typeof block.toolUse.input !== "object")) return { toolUse: { ...block.toolUse, input: toolInput(block.toolUse.input) ?? {} } };
      if (block?.document && !documents) return unread(block.document.name);
      // Thinking can arrive as a signature alone; the API wants its text back, even empty.
      if (block?.reasoningContent?.reasoningText && block.reasoningContent.reasoningText.text == null)
        return { reasoningContent: { ...block.reasoningContent, reasoningText: { ...block.reasoningContent.reasoningText, text: "" } } };
      if (!block?.toolResult) return block;
      let parts = block.toolResult.content;
      // Old images and documents are the bulk of a request; the model can view them again.
      if (i <= oldImages) parts = parts.map(c => (c.image ? { text: "[image omitted]" } : c.document ? { text: `[${c.document.name} omitted]` } : c));
      if (!documents) parts = parts.map(c => (c.document ? unread(c.document.name) : c));
      if (i <= oldResults) parts = parts.map(c => stubResult(c, calls.get(block.toolResult.toolUseId)));
      return parts === block.toolResult.content ? block : { toolResult: { ...block.toolResult, content: parts } };
    }),
  })), "content", "assistant");
  if (beside) for (const m of out) besideResults(m, calls);
  if (cache) for (const m of out.filter(m => m.role === "user").slice(-2)) m.content.push({ cachePoint: { type: "default" } });
  // A summary stays until the next one: marked, it is read back from cache even when a turn after it changes.
  if (cache && through >= 0 && !out[0].content.at(-1).cachePoint) out[0].content.push({ cachePoint: { type: "default" } });
  return out;
}

// Some models see a tool result's files only beside it: each moves after the message's results, after a label
// naming what it is (the file's path, else the tool), so parallel results keep their files apart.
function besideResults(message, calls) {
  const moved = [];
  message.content = message.content.map(block => {
    const parts = block.toolResult?.content;
    if (!parts?.some(c => c.image || c.document)) return block;
    const label = parts.find(c => c.json)?.json?.result?.path ?? calls.get(block.toolResult.toolUseId)?.name ?? "tool result";
    for (const c of parts) if (c.image || c.document) moved.push({ text: label }, c);
    return { toolResult: { ...block.toolResult, content: parts.filter(c => !c.image && !c.document) } };
  });
  message.content.splice(message.content.findLastIndex(b => b.toolResult) + 1, 0, ...moved);
}

// A message left with nothing but thought breaks a request. One in the middle says so in a word, since Bedrock
// wants every turn and roles that alternate; a reply at the end with nothing in it goes. Decided before cache points.
const blank = b => !!(b.reasoningContent || b.cachePoint || (typeof b.text === "string" && !b.text.trim()));
function fillEmpty(messages, key, reply) {
  const last = messages.at(-1);
  const out = last?.role === reply && last[key].every(blank) ? messages.slice(0, -1) : messages;
  for (const m of out) if (m[key].every(blank)) m[key] = [{ text: "(empty)" }];
  return out;
}

// A bulky old tool result becomes a note of what it was; the model can ask again. A sub-agent's answer stays: asking
// again reruns the whole task.
function stubResult(part, call) {
  const size = JSON.stringify(part.json ?? part.text ?? "").length;
  if (size < 1500 || call?.name === "task") return part;
  const what = call ? `${call.name} ${JSON.stringify(call.input).slice(0, 200)}` : "tool result";
  const report = part.json?.result?.report;
  const verdict = report && { ok: report.ok, tests: report.tests && { passed: report.tests.passed, failed: report.tests.failed } };
  return { json: { result: { elided: `${what}: ${size} chars, dropped to save context; call again if needed`, ...verdict } } };
}

// Long chats outgrow the context window. When the last request used most of it, everything before the recent
// turns becomes one summary, saved on the thread so later requests start from it. A summary that fails is noted on
// the thread by the usage that asked for it, and not asked for again until a request uses more.
async function compactHistory(store, client, db, threadId, summary, memories, signal, keep = 6) {
  const messages = store.messages;
  const last = messages.findLast(m => m.usage);
  const u = last?.usage ?? {};
  const used = (u.inputTokens || 0) + (u.cacheReadInputTokens || 0) + (u.cacheWriteInputTokens || 0);
  if (used < modelInfo(store.modelId).window * COMPACT_AT || last.id === summary?.usageId) return summary;
  let cut = messages.length - keep;
  while (cut > 1 && messages[cut].role !== "assistant") cut--;
  if (cut <= 1 || messages[cut - 1].id === summary?.throughId) return summary;
  if ((await db.get("threads", threadId))?.summaryFailed === last.id) return summary;

  // The summary request is the history so far, with the instruction added to its last (user) message.
  const head = messages.slice(0, cut).map(({ id, role, content }) => ({ id, role, content }));
  head[cut - 1] = { ...head[cut - 1], content: [...head[cut - 1].content, { text: SUMMARY_PROMPT }] };
  try {
    const output = await watchedSend(client, getConverseCommand({ ...store, memories, summary, messages: head }), signal);
    const content = [];
    for await (const chunk of output.stream) processStreamChunk(content, chunk);
    const text = content.filter(b => b?.text).map(b => b.text).join("\n").trim();
    if (!text) throw new Error("the summary came back empty");
    const next = { throughId: head[cut - 1].id, usageId: last.id, text, createdAt: Date.now() };
    const thread = await db.get("threads", threadId);
    if (thread) await db.put("threads", { ...thread, summary: next });
    return next;
  } catch (e) {
    if (signal?.aborted) throw e;
    console.warn("The context summary failed:", e);
    const thread = await db.get("threads", threadId);
    if (thread) await db.put("threads", { ...thread, summaryFailed: last.id });
    return summary;
  }
}

function processStreamChunk(content, message) {
  const { contentBlockStart, contentBlockDelta, contentBlockStop } = message;

  if (contentBlockStart?.start?.toolUse) {
    content[contentBlockStart.contentBlockIndex] = { toolUse: contentBlockStart.start.toolUse };
    return;
  }
  if (contentBlockStop) {
    const block = content[contentBlockStop.contentBlockIndex];
    // Input that isn't a JSON object stays the string it arrived as; the call answers INVALID_JSON instead of running.
    if (block?.toolUse) block.toolUse.input = toolInput(block.toolUse.input) ?? block.toolUse.input;
    return;
  }
  if (!contentBlockDelta) return;

  const { contentBlockIndex, delta } = contentBlockDelta;
  content[contentBlockIndex] ||= {};
  const block = content[contentBlockIndex];

  if (delta.reasoningContent) appendReasoning(block, delta.reasoningContent);
  else if (delta.text) block.text = (block.text || "") + delta.text;
  else if (delta.toolUse) block.toolUse.input = (block.toolUse.input || "") + delta.toolUse.input;
}

// Strictly: the lenient parser is for showing a call while it streams, not for running one. A call without
// arguments streams no input.
function toolInput(raw) {
  if (raw == null || (typeof raw === "string" && !raw.trim())) return {};
  let input = raw;
  if (typeof raw === "string") try { input = JSON.parse(raw); } catch { return null; }
  return input && typeof input === "object" && !Array.isArray(input) ? input : null;
}

// Encrypted reasoning (Sol, Luna) arrives as bytes in chunks and must go back exactly as it came. The API takes
// a block as text or as bytes, not both; any text kept beside the bytes is for the reader, and requests drop it.
function appendReasoning(block, rc) {
  const r = (block.reasoningContent ||= {});
  if (rc.redactedContent != null) r.redactedContent = r.redactedContent == null ? rc.redactedContent : joinBytes(r.redactedContent, rc.redactedContent);
  if (rc.text) (r.reasoningText ||= {}).text = (r.reasoningText?.text || "") + rc.text;
  if (rc.signature) (r.reasoningText ||= {}).signature = (r.reasoningText?.signature || "") + rc.signature;
}

function joinBytes(a, b) {
  if (typeof a === "string" && typeof b === "string") return a + b;
  const [x, y] = [a, b].map(v => (typeof v === "string" ? new TextEncoder().encode(v) : new Uint8Array(v.buffer ?? v, v.byteOffset ?? 0, v.byteLength)));
  const out = new Uint8Array(x.length + y.length);
  out.set(x);
  out.set(y, x.length);
  return out;
}

// #endregion

// #region 4. PROVIDERS & CLIENTS
// =============================================================================
// AI provider clients (AWS Bedrock, Google Gemini) and configuration.
// =============================================================================

async function getConverseClient(type = "aws") {
  if (type === "aws") {
    const client = new BedrockRuntimeClient(getStoredConfig("aws-config", "AWS"));
    const send = (input, { signal } = {}) => client.send(new ConverseStreamCommand(input), { abortSignal: signal });
    return { client, send };
  }
  if (type === "google") {
    return getGeminiClient(new GoogleGenAI(getStoredConfig("google-config", "Google")));
  }
  if (type === "echo") {
    return getEchoClient();
  }
}

// A model that sends nothing this long has stalled: the turn ends with an error, not a spinner that never stops.
const STALL_MS = 5 * 60_000;
async function watchedSend(client, input, signal, ms = STALL_MS) {
  const stall = new AbortController();
  const stalled = new Promise((_, reject) => { stall.signal.onabort = () => reject(stall.signal.reason); });
  stalled.catch(() => {});
  let timer;
  const quiet = () => { clearTimeout(timer); timer = setTimeout(() => stall.abort(new Error(`The model sent nothing for ${ms / 1000} seconds.`)), ms); };
  const reason = e => (stall.signal.aborted ? stall.signal.reason : e);
  quiet();
  const both = signal ? AbortSignal.any([signal, stall.signal]) : stall.signal;
  const output = await Promise.race([client.send(input, { signal: both }), stalled]).catch(e => { clearTimeout(timer); throw reason(e); });
  const events = output.stream[Symbol.asyncIterator]();
  async function* stream() {
    try {
      for (let next; !(next = await Promise.race([events.next(), stalled])).done; ) { quiet(); yield next.value; }
    } catch (e) { throw reason(e); }
    finally { clearTimeout(timer); }
  }
  return { ...output, stream: stream() };
}

// Echo client for testing - interprets JSON instructions from user messages
// JSON format: { text?: string, toolUse?: [{name, input}], reasoning?: string, delay?: ms }
// Non-JSON text is echoed as before: "Echo: received \"...\""
function getEchoClient() {
  async function* stream(input, signal) {
    yield { messageStart: { role: "assistant" } };

    // The last text block is what the user typed; workspace notices come before it.
    const lastUserMsg = input.messages?.filter(m => m.role === "user").pop();
    const userText = lastUserMsg?.content?.findLast(c => c.text)?.text || "";

    // Try to parse as JSON instruction
    let instruction;
    try {
      instruction = JSON.parse(userText);
      if (typeof instruction !== "object" || instruction === null) throw new Error();
    } catch {
      // Not JSON or invalid - echo as before
      instruction = { text: `Echo: received "${userText.slice(0, 100)}${userText.length > 100 ? '...' : ''}"` };
    }

    if (instruction.delay) await sleep(instruction.delay);
    signal?.throwIfAborted();

    let blockIndex = 0;
    // With { chunk: ms }, every block streams in small pieces, as a real model's do.
    const pieces = async function* (s) {
      if (!instruction.chunk) return yield s;
      for (const piece of s.match(/[\s\S]{1,12}/g) ?? []) { await sleep(instruction.chunk); signal?.throwIfAborted(); yield piece; }
    };

    // Handle reasoning content (for extended thinking tests)
    if (instruction.reasoning) {
      yield { contentBlockStart: { contentBlockIndex: blockIndex, start: { reasoningContent: {} } } };
      for await (const text of pieces(instruction.reasoning)) yield { contentBlockDelta: { contentBlockIndex: blockIndex, delta: { reasoningContent: { text } } } };
      yield { contentBlockStop: { contentBlockIndex: blockIndex } };
      blockIndex++;
    }

    // Handle text response
    if (instruction.text) {
      yield { contentBlockStart: { contentBlockIndex: blockIndex, start: {} } };
      for await (const text of pieces(instruction.text)) yield { contentBlockDelta: { contentBlockIndex: blockIndex, delta: { text } } };
      yield { contentBlockStop: { contentBlockIndex: blockIndex } };
      blockIndex++;
    }

    // Handle tool use
    if (instruction.toolUse?.length) {
      for (const tool of instruction.toolUse) {
        const toolUseId = `echo_${crypto.randomUUID()}`;
        yield { contentBlockStart: { contentBlockIndex: blockIndex, start: { toolUse: { toolUseId, name: tool.name } } } };
        for await (const input of pieces(tool.raw ?? JSON.stringify(tool.input || {}))) yield { contentBlockDelta: { contentBlockIndex: blockIndex, delta: { toolUse: { input } } } };
        yield { contentBlockStop: { contentBlockIndex: blockIndex } };
        blockIndex++;
      }
    }

    if (instruction.usage) yield { metadata: { usage: instruction.usage } };

    // Determine stop reason
    const hasToolUse = instruction.toolUse?.length > 0;
    yield { messageStop: { stopReason: hasToolUse ? "tool_use" : "end_turn" } };
  }

  return { send: (input, { signal } = {}) => Promise.resolve({ stream: stream(input, signal) }) };
}

export function getGeminiClient(client) {
  const toB64 = b => btoa(b.reduce((s, x) => s + String.fromCharCode(x), ""));
  const MIME = { png: "image/png", jpeg: "image/jpeg", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf" };

  async function* stream(input, signal) {
    const toolNames = new Map();
    const toGeminiParts = b => {
      if (b.text) return [{ text: b.text }];
      if (b.image) return [{ inlineData: { data: toB64(b.image.source.bytes), mimeType: MIME[b.image.format] } }];
      if (b.document) return [{ inlineData: { data: toB64(b.document.source.bytes), mimeType: MIME[b.document.format] || "application/octet-stream" } }];
      if (b.toolUse) {
        toolNames.set(b.toolUse.toolUseId, b.toolUse.name);
        // Gemini 3 wants its thought signature back on each call; calls from other models carry the documented stand-in.
        const functionCall = { name: b.toolUse.name, args: typeof b.toolUse.input === "string" ? JSON.parse(b.toolUse.input) : b.toolUse.input, id: b.toolUse.toolUseId };
        return [{ functionCall, thoughtSignature: b.toolUse.signature ?? "skip_thought_signature_validator" }];
      }
      if (b.toolResult) {
        // Gemini 3 takes a result's images and PDFs inside the function response, as its parts; text follows it.
        const [c, ...rest] = b.toolResult.content ?? [];
        const name = toolNames.get(b.toolResult.toolUseId) || b.toolResult.toolUseId;
        const files = rest.filter(p => p.image || p.document).flatMap(toGeminiParts);
        const functionResponse = { id: b.toolResult.toolUseId, name, response: c?.json ?? { output: c?.text }, ...(files.length && { parts: files }) };
        return [{ functionResponse }, ...rest.filter(p => !p.image && !p.document).flatMap(toGeminiParts)];
      }
      return [];
    };

    const { thinkingLevel, thinking: budget } = input.additionalModelRequestFields ?? {};
    const thinking = thinkingLevel ? { thinkingLevel } : budget?.budget_tokens && { thinkingBudget: budget.budget_tokens };
    const geminiReq = {
      model: input.modelId,
      contents: fillEmpty(input.messages.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: m.content.flatMap(toGeminiParts) })), "parts", "model"),
      config: {
        abortSignal: signal,
        systemInstruction: input.system?.find(s => s.text)?.text,
        tools: input.toolConfig?.tools
          ?.filter(t => t.toolSpec)
          .map(t => ({
            functionDeclarations: [{
              name: t.toolSpec.name,
              description: t.toolSpec.description,
              parametersJsonSchema: t.toolSpec.inputSchema?.json,
            }],
          })),
        ...(input.inferenceConfig?.maxTokens && { maxOutputTokens: input.inferenceConfig.maxTokens }),
        ...(thinking && { thinkingConfig: { includeThoughts: true, ...thinking } }),
      },
    };

    const response = await client.models.generateContentStream(geminiReq);
    yield { messageStart: { role: "assistant" } };

    let idx = 0, active = null, calledTools = false, usage = null;

    for await (const chunk of response) {
      const parts = chunk.candidates?.[0]?.content?.parts ?? [];
      const done = chunk.candidates?.[0]?.finishReason;
      if (chunk.usageMetadata) usage = chunk.usageMetadata;

      for (const p of parts) {
        let type, start, delta;

        if (p.thought && p.text != null) {
          type = "reasoning";
          delta = { reasoningContent: { text: p.text, ...(p.thoughtSignature && { signature: p.thoughtSignature }) } };
        } else if (p.text != null) {
          type = "text";
          delta = { text: p.text };
        } else if (p.functionCall) {
          type = "tool";
          calledTools = true;
          // IDs must be unique across the thread: tool cards look their results up by ID.
          const id = p.functionCall.id || `gemini_${crypto.randomUUID()}`;
          start = { toolUse: { toolUseId: id, name: p.functionCall.name, ...(p.thoughtSignature && { signature: p.thoughtSignature }) } };
          delta = { toolUse: { input: JSON.stringify(p.functionCall.args ?? {}) } };
        } else continue;

        // Each function call gets its own block, even when calls arrive back to back.
        if (type !== active || type === "tool") {
          if (active) yield { contentBlockStop: { contentBlockIndex: idx++ } };
          if (start) yield { contentBlockStart: { contentBlockIndex: idx, start } };
          active = type;
        }
        yield { contentBlockDelta: { contentBlockIndex: idx, delta } };
      }

      if (done) {
        if (active) yield { contentBlockStop: { contentBlockIndex: idx } };
        const cached = usage?.cachedContentTokenCount || 0;
        if (usage) yield { metadata: { usage: { inputTokens: (usage.promptTokenCount || 0) - cached, outputTokens: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0), cacheReadInputTokens: cached } } };
        // A call Gemini couldn't form ends the reply with nothing in it; the model is told why, not just that.
        const reason = { MAX_TOKENS: "max_tokens", MALFORMED_FUNCTION_CALL: "malformed_tool_call" }[done];
        yield { messageStop: { stopReason: reason ?? (calledTools ? "tool_use" : "end_turn") } };
      }
    }
  }

  return { client, send: (input, { signal } = {}) => Promise.resolve({ stream: stream(input, signal) }) };
}

// Credentials and the proxy are set in Settings and kept in localStorage. A worker has none: each tab sends its
// settings with every command, and again when another tab changes them; the latest copy stands in.
const SETTING_KEYS = ["aws-config", "google-config", "brave-config"];
const settings = { items: {}, proxy: null };
const setting = key => globalThis.localStorage ? localStorage.getItem(key) : settings.items[key] ?? null;
const storedJSON = key => { try { return JSON.parse(setting(key) || "null"); } catch { return null; } };
const snapshotSettings = () => ({ items: Object.fromEntries(SETTING_KEYS.map(key => [key, setting(key)])), proxy: getProxyConfig() });
const applySettings = ({ items, proxy }) => Object.assign(settings, { items, proxy });

function getStoredConfig(key, label) {
  const config = storedJSON(key);
  if (!config || typeof config !== "object") throw new Error(`Add ${label} credentials in Settings (the gear button) first.`);
  return config;
}

// #endregion

// #region 5. TOOLS
// =============================================================================
// Tool function implementations and file/message content handling.
// =============================================================================

// One CORS proxy serves every agent: the one saved in Settings, else this app's own (npm run start:proxy) when it
// answers its health check as itself.
const LOCAL_PROXY = "http://localhost:8001";
let detectedProxy = null;
const storedProxyConfig = () => storedJSON(PROXY_CONFIG_KEY);
const getProxyConfig = () => globalThis.localStorage ? storedProxyConfig() ?? detectedProxy : settings.proxy;
if (globalThis.localStorage && !storedProxyConfig())
  fetch(LOCAL_PROXY + "/health").then(r => r.json()).then(body => { if (body?.proxy === "chat") detectedProxy = { endpoint: LOCAL_PROXY }; }, () => {});

// The proxy also relays TCP over WebSocket at the same address (the tcpipe protocol).
const relayUrl = () => getProxyConfig()?.endpoint?.replace(/^http/, "ws").replace(/\/+$/, "") ?? null;

// A tool's fetch, through the proxy unless the URL is this machine's. It gives up after a minute, or when the run stops.
const FETCH_TIMEOUT_MS = 60_000;
async function proxyFetch(url, { signal, ...options } = {}) {
  const proxy = getProxyConfig();
  const target = new URL(url, location.origin);
  const local = ["localhost", "127.0.0.1", "[::1]"].some(h => target.hostname === h || target.hostname.endsWith(".localhost"));
  const timed = AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(signal ? [signal] : [])]);
  if (!proxy?.endpoint || local) return fetch(url, { ...options, signal: timed });
  const headers = new Headers(options.headers || {});
  if (proxy.headerName && proxy.headerValue) headers.set(proxy.headerName, proxy.headerValue);
  return fetch(proxy.endpoint.replace(/\/+$/, "") + "/" + target.href, { ...options, headers, signal: timed });
}

// Brave's results, as text: each one's title, URL, age, and the snippets Brave took from the page. Its API sends no
// CORS headers, so the call goes through the proxy.
const BRAVE_SEARCH = "https://api.search.brave.com/res/v1/web/search";
const hasBraveKey = () => !!storedJSON("brave-config")?.apiKey;
// Tools every agent and sub-agent gets for the web; search only with a key.
const webToolNames = () => ["read_url", ...(hasBraveKey() ? ["web_search"] : [])];
const plainText = s => String(s ?? "").replace(/<[^>]+>/g, "").replace(/&(#x[\da-f]+|#\d+|quot|amp|lt|gt|apos|nbsp);/gi, (_, e) =>
  e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : +e.slice(1)) : { quot: '"', amp: "&", lt: "<", gt: ">", apos: "'", nbsp: " " }[e.toLowerCase()]);
// The description is often an extra snippet cut down with "...": a snippet whose every piece is in a longer one goes.
const distinctSnippets = snippets => snippets.filter((s, i) => {
  const pieces = s.split(/\s*(?:\.\.\.|…)\s*/).filter(Boolean);
  return pieces.length && !snippets.some((t, j) => j !== i && (t.length > s.length || (t === s && j < i)) && pieces.every(p => t.includes(p)));
});
async function webSearch({ query, count = 10, freshness } = {}, { signal } = {}) {
  return attempt(async () => {
    if (!query?.trim()) return { error: "Give a query." };
    const { apiKey } = getStoredConfig("brave-config", "Brave Search");
    const url = new URL(BRAVE_SEARCH);
    url.search = new URLSearchParams({ q: query, count: String(Math.min(Math.max(1, count | 0), 20)), extra_snippets: "true", ...(freshness && { freshness }) });
    const response = await proxyFetch(url.href, { headers: { Accept: "application/json", "X-Subscription-Token": apiKey }, signal });
    const body = await response.json().catch(() => null);
    if (!response.ok) return { error: `Brave Search answered ${response.status}: ${body?.error?.detail || body?.message || response.statusText}` };
    const results = body?.web?.results ?? [];
    if (!results.length) return `No results for "${query}".`;
    return results.map((r, i) => [`${i + 1}. ${plainText(r.title)}`, `   ${r.url}${r.age ? ` (${r.age})` : ""}`,
      ...distinctSnippets([r.description, ...(r.extra_snippets ?? [])].map(plainText)).map(s => `   ${s}`)].join("\n")).join("\n\n");
  });
}

// A page as markdown: HTML through Readability and Turndown, PDF through pdf.js, Word through mammoth; text as it
// is, an image as itself. It needs a DOM, so a tab runs it. The request asks the way a browser's address bar does,
// and the proxy passes on this browser's own user agent and language.
const READ_LIMIT = 40000;
const PDFJS = CDN["pdfjs-dist"];
const NAVIGATE = { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8", "Upgrade-Insecure-Requests": "1" };
// Bot walls answer with a page of their own; its text is not the page asked for.
const BOT_WALL = /Just a moment\.\.\.|cf-chl-|challenge-platform|Attention Required! \| Cloudflare|captcha-delivery|px-captcha|Access Denied<\/title>/i;
async function toMarkdownService() {
  const [{ default: TurndownService }, { gfm }] = await Promise.all([import(`${CDN.turndown}/+esm`), import(`${CDN["turndown-plugin-gfm"]}/+esm`)]);
  const service = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  service.use(gfm);
  // A table with no header row is layout, which gfm keeps as HTML: its rows are the text.
  service.addRule("layout", {
    filter: node => /^(TABLE|THEAD|TBODY|TFOOT|TR|TD)$/.test(node.nodeName) && !node.closest("table").querySelector("th"),
    replacement: (content, node) => node.nodeName === "TD" ? `${content.trim()} ` : node.nodeName === "TR" ? `\n${content.trim()}\n` : `\n\n${content}\n\n`,
  });
  service.remove(["script", "style", "noscript", "template", "iframe", "form", "button", "svg"]);
  return service;
}
async function htmlToMarkdown(html, url) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  // Links and images keep working once the page is gone: every URL made absolute.
  for (const el of doc.querySelectorAll("[href], [src]")) for (const name of ["href", "src"]) {
    const absolute = el.hasAttribute(name) && URL.parse(el.getAttribute(name), url);
    if (absolute) el.setAttribute(name, absolute.href);
  }
  // An inline image is bytes, not text.
  doc.querySelectorAll("img[src^='data:']").forEach(img => img.removeAttribute("src"));
  const title = doc.title.trim();
  const { Readability } = await import(`${CDN["@mozilla/readability"]}/+esm`);
  const article = new Readability(doc.cloneNode(true)).parse();
  let root = article?.content && article.length > 200 && new DOMParser().parseFromString(article.content, "text/html").body;
  if (!root) {
    root = doc.querySelector("main, article, [role=main]") ?? doc.body;
    root.querySelectorAll("nav, header, footer, aside, [role=navigation], [aria-hidden=true]").forEach(el => el.remove());
  }
  const markdown = (await toMarkdownService()).turndown(root).replace(/\n{3,}/g, "\n\n").trim();
  return { title: article?.title || title, markdown };
}
async function pdfToMarkdown(bytes) {
  const pdfjs = await import(`${PDFJS}/build/pdf.min.mjs`);
  pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS}/build/pdf.worker.min.mjs`;
  const doc = await pdfjs.getDocument({ data: bytes, standardFontDataUrl: `${PDFJS}/standard_fonts/` }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const { items } = await (await doc.getPage(n)).getTextContent();
    pages.push(`<!-- page ${n} -->\n` + items.map(item => item.str + (item.hasEOL ? "\n" : "")).join("").trim());
  }
  const { info } = await doc.getMetadata();
  return { title: info?.Title || "", markdown: pages.join("\n\n") };
}
async function wordToMarkdown(bytes) {
  const { default: mammoth } = await import(`${CDN.mammoth}/+esm`);
  const { value } = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer });
  return { title: "", markdown: (await toMarkdownService()).turndown(value).trim() };
}
// A page's own scripts run in a frame at the proxy's mirror of its site: http://example.com.localhost:8001/ is
// https://example.com/. Its origin is its own, so the app's storage and keys are out of its reach, and the proxy serves
// it nothing but its own site. The page answers with what it built, and a picture of it if asked.
const RENDER_LIMIT = 15000;
function mirrorOf(url) {
  const proxy = URL.parse(getProxyConfig()?.endpoint ?? "");
  if (!proxy || !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(proxy.hostname) || url.protocol !== "https:" || url.port) return null;
  return new URL(url.pathname + url.search, `http://${url.hostname}.localhost:${proxy.port}`);
}
async function renderPage(url, mirror, { screenshot, signal }) {
  const frame = document.createElement("iframe");
  frame.sandbox = "allow-scripts allow-same-origin";
  frame.style.cssText = "position: fixed; left: -10000px; top: 0; width: 1280px; height: 800px; border: 0";
  frame.src = mirror.href;
  let onMessage, onAbort, timer, html;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${url.href} did not settle in ${RENDER_LIMIT / 1000 + 5}s.`)), RENDER_LIMIT + 5000);
      signal?.addEventListener("abort", onAbort = () => reject(signal.reason), { once: true });
      onMessage = ({ source, origin, data }) => {
        if (source !== frame.contentWindow || origin !== mirror.origin) return;
        if (data?.type === "rendered" && data.error) reject(new Error(`${url.href} can't render: ${data.error}.`));
        else if (data?.type === "rendered" && html === undefined) {
          html = data.html.replaceAll(mirror.origin, url.origin);
          if (!screenshot) resolve({ html });
          else source.postMessage({ type: "screenshot" }, mirror.origin);
        }
        if (data?.type === "screenshot") data.error ? reject(new Error(`${url.href} rendered, but its picture failed: ${data.error}`)) : resolve({ html, bytes: new Uint8Array(data.bytes) });
      };
      addEventListener("message", onMessage);
      document.body.append(frame);
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    removeEventListener("message", onMessage);
    frame.remove();
  }
}
// Text in the charset the server declared, or UTF-8 when it named none the browser knows.
function decode(bytes, charset = "utf-8") {
  try { return new TextDecoder(charset).decode(bytes); } catch { return new TextDecoder().decode(bytes); }
}
async function readUrl({ url, from = 0, render = false, screenshot = false } = {}, { signal } = {}) {
  return attempt(async () => {
    let target;
    try { target = new URL(url); } catch { return { error: `${url} is not a URL. Give it whole, with https://.` }; }
    if (!/^https?:$/.test(target.protocol)) return { error: `read_url reads http and https; ${target.protocol} is not one.` };
    const response = await proxyFetch(target.href, { headers: NAVIGATE, signal });
    const finalUrl = response.headers.get("x-final-url") || target.href;
    const contentType = response.headers.get("content-type") || "";
    const type = contentType.split(";")[0].trim().toLowerCase();
    const bytes = new Uint8Array(await response.arrayBuffer());
    const text = decode(bytes, /charset=["']?([\w-]+)/i.exec(contentType)?.[1]);
    // A wall's page is small; a large one that names a challenge script is most likely the real page.
    if (type === "text/html" && bytes.length < 50000 && BOT_WALL.test(text)) return { error: `${finalUrl} answered ${response.status} with a bot check, not the page. Its content can't be read from here: find it at another source, or use web_search's snippets.` };
    if (!response.ok) return { error: `${finalUrl} answered ${response.status} ${response.statusText}.` };
    if (type.startsWith("image/")) return viewResource(target.pathname.split("/").pop() || target.hostname, new Blob([bytes], { type }));
    const html = /^(text\/html|application\/xhtml\+xml)$/.test(type);
    let rendered;
    if (render || screenshot) {
      if (!html) return { error: `${finalUrl} is ${type || "of no stated type"}; only a web page renders.` };
      const site = new URL(finalUrl), mirror = mirrorOf(site);
      if (!mirror) return { error: `${finalUrl} can't render: rendering takes an https page on its usual port, and the proxy running on this machine (npm run start:proxy, set as the proxy in Settings).` };
      rendered = await renderPage(site, mirror, { screenshot, signal });
    }
    // Storage often serves a PDF as octet-stream; its first bytes say what it is.
    const page = text.startsWith("%PDF-") ? await pdfToMarkdown(bytes)
      : type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ? await wordToMarkdown(bytes)
      : html ? await htmlToMarkdown(rendered?.html ?? text, finalUrl)
      : type.startsWith("text/") || /json|xml|javascript|yaml|csv/.test(type) ? { title: "", markdown: text }
      : null;
    if (!page) return { error: `${finalUrl} is ${type || "of no stated type"}, which read_url doesn't convert. Fetch it in code and parse it there.` };
    if (!page.markdown.trim() && !screenshot) return { error: rendered ? `${finalUrl} has no text even with its scripts run. Find it at another source, or use web_search's snippets.` : `${finalUrl} has no text until its scripts run: read it with render: true.` };
    const start = Math.max(0, from | 0);
    const shown = page.markdown.slice(start, start + READ_LIMIT);
    const more = start + READ_LIMIT < page.markdown.length ? `\n\n… showing ${start}-${start + shown.length} of ${page.markdown.length} characters; read_url with from=${start + READ_LIMIT} for more` : "";
    const read = `${page.title ? `# ${page.title}\n` : ""}${finalUrl} (${type || "no type"})\n\n${shown}${more}`;
    if (!screenshot) return read;
    return withMedia({ page: read }, { format: "webp", bytes: rendered.bytes, name: "screenshot" });
  });
}

function think(input) {
  return "Thinking complete.";
}

// The editor's files: thread-scoped, plus the agent's own (skills/, memories/). A thread's file wins on a shared path.
function resourceStore({ db, threadId, agentId }) {
  const all = async () => {
    const threadResources = threadId ? await db.getAllFromIndex("resources", "threadId", threadId) : [];
    const agentResources = agentId ? await db.getAllFromIndex("resources", "agentId", agentId) : [];
    const byPath = new Map();
    for (const r of agentResources) byPath.set(r.path, r);
    for (const r of threadResources) byPath.set(r.path, r);
    return Array.from(byPath.values());
  };
  const get = async p => (await all()).find(r => r.path === p);
  const save = async (p, content) => {
    const existing = await get(p);
    if (existing) return db.put("resources", { ...existing, content, updatedAt: Date.now() });
    const resource = { path: p, content, agentId, createdAt: Date.now() };
    if (!p.startsWith("skills/") && !p.startsWith("memories/")) resource.threadId = threadId;
    return db.add("resources", resource);
  };
  const remove = file => db.delete("resources", file.id);
  const move = (file, to) => db.put("resources", { ...file, path: to, updatedAt: Date.now() });
  return { all, get, save, remove, move };
}

// `resources` in code and apps: the workspace's files and the editor's, in one namespace. Failures throw, so a
// missing file stops the script with a message instead of arriving as data. Workspace files are read-only here:
// their changes go through edit_file, which versions and tests them.
async function sandboxFiles(command, args = {}, context = {}) {
  if (!context.db) throw new Error("No file storage here.");
  const store = resourceStore(context);
  const ws = context.workspace?.state.project ? context.workspace : null;
  const path = normalizePath(args.path ?? "").replace(/\/+$/, "");
  const inWorkspace = p => !!ws && p in ws.state.files;
  const paths = async (prefix = "") => {
    const all = new Set((await store.all()).map(r => r.path));
    if (ws) for (const p of await ws.listFiles()) all.add(p);
    return [...all].filter(p => p.startsWith(prefix)).sort();
  };
  const missing = async p => {
    const near = await paths(p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "");
    return new Error(`No file at ${p || "/"}. ${near.length ? "Files: " + near.slice(0, 30).join(", ") + (near.length > 30 ? ", …" : "") : "There are no files yet."}`);
  };
  const need = (value, name) => { if (typeof value !== "string") throw new Error(`${name} must be a string, got ${value === null ? "null" : typeof value}.`); };
  const readOnly = p => { if (inWorkspace(p)) throw new Error(`${p} is a workspace file; change it with edit_file or write_file, which version and test it.`); };
  switch (command) {
    case "read": {
      if (ws && path) { const text = await ws.readFile(path); if (text != null) return text; }
      const file = await store.get(path);
      if (!file) throw await missing(path);
      return file.content;
    }
    case "list": return paths(path ? path + "/" : "");
    case "exists": return (ws && path && (await ws.readFile(path)) != null) || !!(await store.get(path));
    case "write": {
      if (!(args.content instanceof Blob)) need(args.content, "content");
      readOnly(path);
      if (!path) throw new Error("write needs a path.");
      await store.save(path, args.content);
      return path;
    }
    case "replace": {
      need(args.old_str, "old"); need(args.new_str, "new");
      readOnly(path);
      const file = await store.get(path);
      if (!file) throw await missing(path);
      if (typeof file.content !== "string") throw new Error(`${path} is not text.`);
      const count = file.content.split(args.old_str).length - 1;
      if (count !== 1) throw new Error(count ? `The text appears ${count} times in ${path}; include more of it.` : `The text is not in ${path}.`);
      await store.save(path, file.content.replace(args.old_str, () => args.new_str));
      return path;
    }
    case "delete": {
      readOnly(path);
      const file = await store.get(path);
      if (!file) throw await missing(path);
      await store.remove(file);
      return path;
    }
    case "rename": {
      readOnly(path);
      const to = normalizePath(args.new_path ?? "");
      const file = await store.get(path);
      if (!file) throw await missing(path);
      if (!to) throw new Error("rename needs a new path.");
      if (inWorkspace(to) || (await store.get(to))) throw new Error(`${to} already exists.`);
      await store.move(file, to);
      return to;
    }
    default: throw new Error(`Unknown file command: ${command}`);
  }
}

// Stringified into both sandboxes: calls go to the parent by `call(command, args)`, which returns a promise.
function sandboxResources(call) {
  const api = {
    read: path => call("read", { path }),
    list: (path = "") => call("list", { path }),
    exists: path => call("exists", { path }),
    write: (path, content) => call("write", { path, content }),
    replace: (path, old_str, new_str) => call("replace", { path, old_str, new_str }),
    delete: path => call("delete", { path }),
    rename: (path, new_path) => call("rename", { path, new_path }),
  };
  return new Proxy(api, {
    get: (target, name) => {
      if (name in target || typeof name === "symbol" || name === "then") return target[name];
      throw new TypeError(`resources.${String(name)} does not exist. resources has: ${Object.keys(target).join(", ")}.`);
    },
  });
}

async function editor({ command, path, view_range, old_str, new_str, file_text, insert_line, new_path }, context = {}) {
  if (!context.db) return "Error: Database not available";

  const normPath = normalizePath(path).replace(/\/+$/, "");
  const isDir = path.endsWith("/");
  const { all: getResources, get: getResource, save: saveResource, remove, move } = resourceStore(context);
  // The project's files aren't the editor's; a path that names one gets pointed at the tools that edit it.
  const missing = (use = "change it with edit_file", absent = `File not found: ${path}`) => context.workspace?.state?.project?.heads?.[normPath] != null
    ? `${path} is a project file, not a note: ${use}.` : absent;

  switch (command) {
    case "view": {
      const resources = await getResources();
      const file = resources.find(r => r.path === normPath);
      if (file?.content instanceof Blob && !isDir) return viewResource(normPath, file.content);
      if (file && !isDir) return { status: "viewed", path, content: file.content };

      // List as directory (with or without trailing slash)
      const prefix = normPath ? normPath + "/" : "";
      const entries = new Set();
      for (const r of resources) {
        if (r.path.startsWith(prefix)) {
          const rest = r.path.slice(prefix.length);
          const first = rest.split("/")[0];
          if (first) entries.add(rest.includes("/") ? first + "/" : first);
        }
      }
      // A folder named with its slash exists once asked for: empty is an answer, not an error.
      if (entries.size > 0 || isDir || !normPath) return { status: "directory", path: prefix || "/", entries: Array.from(entries).sort() };
      return { status: "error", error: missing("read it with view_file", `Not found: ${path}`) };
    }

    case "create": {
      if (!file_text && file_text !== "") return { status: "error", error: "file_text is required for create" };
      const existing = await getResource(normPath);
      if (existing) return { status: "error", error: `File already exists: ${path}. Use str_replace to edit.` };
      await saveResource(normPath, file_text);
      return { status: "created", path, content: file_text };
    }

    case "str_replace": {
      if (!old_str) return { status: "error", error: "old_str is required for str_replace" };
      if (new_str === undefined) return { status: "error", error: "new_str is required for str_replace" };
      const resource = await getResource(normPath);
      if (!resource) return { status: "error", error: missing() };
      if (typeof resource.content !== "string") return { status: "error", error: `${path} is not text.` };
      const count = resource.content.split(old_str).length - 1;
      if (count === 0) return { status: "error", error: "old_str not found in file" };
      if (count > 1) return { status: "error", error: `old_str appears ${count} times. Be more specific.` };
      const newContent = resource.content.replace(old_str, () => new_str);
      await saveResource(normPath, newContent);
      return { status: "replaced", path, content: newContent };
    }

    case "insert": {
      if (insert_line === undefined) return { status: "error", error: "insert_line is required for insert" };
      if (!new_str && new_str !== "") return { status: "error", error: "new_str is required for insert" };
      const resource = await getResource(normPath);
      if (!resource) return { status: "error", error: missing() };
      const lines = resource.content.split("\n");
      const idx = Math.max(0, Math.min(lines.length, insert_line));
      lines.splice(idx, 0, new_str);
      const newContent = lines.join("\n");
      await saveResource(normPath, newContent);
      return { status: "inserted", path, content: newContent };
    }

    case "delete": {
      const resource = await getResource(normPath);
      if (!resource) return { status: "error", error: `Path not found: ${path}` };
      await remove(resource);
      return { status: "deleted", path };
    }

    case "rename": {
      if (!new_path) return { status: "error", error: "new_path is required for rename" };
      const resource = await getResource(normPath);
      if (!resource) return { status: "error", error: `Path not found: ${path}` };
      const newNormPath = normalizePath(new_path).replace(/\/+$/, "");
      const existing = await getResource(newNormPath);
      if (existing) return { status: "error", error: `Destination already exists: ${new_path}` };
      await move(resource, newNormPath);
      return { status: "renamed", old_path: path, new_path };
    }

    default:
      return { status: "error", error: `Unknown command: ${command}` };
  }
}

// Sessions by the server's config, so a server edited in Settings starts a new one. A session is kept once it has
// initialized; a call that fails, a 404 for a session the server dropped among them, starts over next time.
const mcpSessions = new Map();

async function mcp({ command, server, tool, uri, name, args, filename }, context = {}) {
  const { db, agentId, signal } = context;
  if (!db) return { error: "Database not available" };

  const servers = (await db.get("agents", agentId || 1))?.mcpServers || [];

  if (command === "list_servers") {
    return { servers: servers.map(s => ({ name: s.name, url: s.url, enabled: s.enabled !== false })) };
  }

  const cfg = servers.find(s => s.name === server && s.enabled !== false);
  if (!cfg) return { error: server ? `Server not found: ${server}` : "Server name required" };
  const key = JSON.stringify(cfg);

  const send = async (session, method, params = {}) => {
    const res = await proxyFetch(cfg.url, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(session.id && { "Mcp-Session-Id": session.id }) },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++session.seq, method, params }),
    });
    session.id = res.headers.get("Mcp-Session-Id") || session.id;
    if (!res.ok) throw new Error(`MCP ${res.status}: ${(await res.text()).slice(0, 500)}`);
    if (res.status === 202 || res.status === 204) return null;

    const text = await res.text();
    if (!text?.trim()) return null;
    // A streamed answer carries its JSON on a data: line.
    const json = (res.headers.get("Content-Type") || "").includes("text/event-stream") ? text.match(/^data: (.+)$/m)?.[1] : text;
    if (!json) return null;
    const { result, error } = JSON.parse(json);
    if (error) throw new Error(error.message);
    return result;
  };

  const methods = {
    list_tools: () => ["tools/list"],
    call_tool: () => ["tools/call", { name: tool, arguments: args || {} }],
    list_resources: () => ["resources/list"],
    read_resource: () => ["resources/read", { uri }],
    list_prompts: () => ["prompts/list"],
    get_prompt: () => ["prompts/get", { name, arguments: args || {} }],
  };
  if (!Object.hasOwn(methods, command)) return { error: `Unknown command: ${command}` };

  try {
    let session = mcpSessions.get(key);
    if (!session) {
      session = { id: null, seq: 0 };
      await send(session, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "chat-html", version: "1.0.0" } });
      await send(session, "notifications/initialized");
      mcpSessions.set(key, session);
    }
    const result = { server, ...await send(session, ...methods[command]()) };

    if (filename && !result.error) {
      // JSON inside text fields is parsed, so the file isn't JSON encoded twice.
      const parsed = JSON.parse(JSON.stringify(result), (k, v) => {
        if (typeof v === "string" && (v.startsWith("{") || v.startsWith("["))) {
          try { return JSON.parse(v); } catch { return v; }
        }
        return v;
      });
      await resourceStore(context).save(normalizePath(filename).replace(/\/+$/, ""), JSON.stringify(parsed, null, 2));
      result.saved = filename;
    }
    return result;
  } catch (e) {
    mcpSessions.delete(key);
    return { error: e.message };
  }
}

// A fork is the caller itself, continued: the same system prompt, tools, and history, so every request it makes
// starts with the prefix the caller's request just cached. It answers every call in the caller's turn (the API
// wants each one answered) and finds its question in its own. It reads; the caller changes things.
function forkOf({ request, turn }, toolUseId, question, { brief = q => fill(FORK_BRIEF, { question: q }), refuses = FORK_REFUSES } = {}) {
  const refuse = name => () => ({ error: `A fork does not ${name === "task" ? "start sub-agents" : "change files"}. Put what should change in your answer; the caller makes the change.` });
  const toolMap = Object.fromEntries(request.tools.map(({ toolSpec: { name }, fn }) => [name, refuses.includes(name) ? refuse(name) : fn]));
  // The brief rides in the fork's own result, after a line that says so: read as the result, a fork took itself for the
  // caller and called the task it was; sent as the user's words, it made Haiku drop the caller's thinking, and the cache.
  const answers = turn.filter(b => b?.toolUse).map(({ toolUse }) => ({ toolResult: { toolUseId: toolUse.toolUseId, content:
    toolUse.toolUseId === toolUseId ? [{ text: "(This call is you: your brief follows.)" }, { text: brief(question) }]
      : [{ text: "(Runs alongside you; its result goes to the caller, not to you.)" }] } }));
  return { request, toolMap, messages: [{ role: "assistant", content: turn }, { role: "user", content: answers }] };
}

// A part changes only the files it owns. Why: Luna's three parts each rebuilt the whole game in index.html first,
// then wrote one another's modules and restored one another's versions, and two ran out of turns.
function ownedTools(toolMap, owned, ws, db) {
  const owns = path => owned.some(f => f.endsWith("/") ? path.startsWith(f) : path === f);
  const target = async (name, input) => name === "restore"
    ? (await db.get("versions", +input?.version))?.path
    : normalizePath(input?.path || ws.shownPath() || ws.state.project.entry);
  const guard = (name, fn) => async (input, context) => {
    const path = await target(name, input);
    if (path && !owns(path)) return { error: `${path} isn't yours: this part owns ${owned.join(", ")}. The rest is the contract: read it, build against it, and say in your final message what it lacks.` };
    return fn(input, context);
  };
  return Object.fromEntries(Object.entries(toolMap).map(([name, fn]) => [name, ["write_file", "edit_file", "restore"].includes(name) ? guard(name, fn) : fn]));
}

// The files the other parts called in the same turn own.
function siblingFiles(turn = [], toolUseId) {
  return turn.filter(b => b?.toolUse?.name === "task" && b.toolUse.toolUseId !== toolUseId && b.toolUse.input?.type === "part")
    .flatMap(b => Array.isArray(b.toolUse.input.files) ? b.toolUse.input.files : [])
    .map(normalizePath); // a folder keeps its trailing /
}
const overlap = (mine, theirs) => mine.find(a => theirs.some(b => a === b || (a.endsWith("/") && b.startsWith(a)) || (b.endsWith("/") && a.startsWith(b))));

// A part builds a whole piece, so it gets more turns than an answer or a take.
const SUBAGENT_TURNS = 15, PART_TURNS = 30;
async function task({ prompt, type, folder, model, files }, context = {}) {
  const { db, threadId, agentId, modelId, reasoningMode, signal, toolUseId, conversation, workspace, host } = context;
  if (!db) return { error: "Database not available" };
  if (!SUBAGENT_TYPES.includes(type)) return { error: `Unknown type: ${type}. Use ${SUBAGENT_TYPES.map(t => `"${t}"`).join(", ")}.` };
  const forked = ["fork", "variant", "part"].includes(type), branched = type === "variant" || type === "part";
  if (forked && !conversation) return { error: `A ${type} needs a conversation to copy; use explore or general here.` };
  if (type === "review" && !workspace?.state?.project) return { error: "Nothing to review yet: no project is open." };
  const owned = type === "part" && Array.isArray(files) ? files.map(normalizePath).filter(Boolean) : [];
  if (type === "part" && !owned.length) return { error: "A part owns files: list them in files, as paths or folders ending in /." };
  const shared = type === "part" && overlap(owned, siblingFiles(conversation?.turn, toolUseId));
  if (shared) return { error: `${shared} is another part's in this turn too: give each file to one part.` };
  if (branched && !workspace) return { error: `A ${type} branches the project, and there is no workspace here.` };
  if (model && !SUBAGENT_MODELS.includes(model)) return { error: `Unknown model: ${model}. Use one of ${SUBAGENT_MODELS.join(", ")}, or leave it out for yours.` };

  const folderName = folder || "findings";
  // A call with an id gets a thread of its own, and an entry the tabs show while it runs.
  const subagentThreadId = toolUseId ? await db.add("threads", { agentId, parentThreadId: threadId, parentToolUseId: toolUseId, type: "subagent", subagentType: type, status: "running", createdAt: Date.now() }) : null;
  if (toolUseId) setSubagent(toolUseId, { threadId: subagentThreadId, messages: [], currentMessage: null, status: "running", type });
  const update = change => {
    const entry = toolUseId && subagents.get(toolUseId);
    if (entry) setSubagent(toolUseId, { ...entry, ...(typeof change === "function" ? change(entry) : change) });
  };
  const save = message => subagentThreadId && db.add("messages", { ...message, threadId: subagentThreadId, agentId, createdAt: message.createdAt ?? Date.now() });

  // The thread and its spinner end however the sub-agent does; its entry goes a while later.
  const finish = async status => {
    const thread = subagentThreadId && await db.get("threads", subagentThreadId);
    if (thread) await db.put("threads", { ...thread, status, updatedAt: Date.now() });
    update({ status, currentMessage: null });
    if (toolUseId) setTimeout(() => subagents.get(toolUseId)?.status === status && setSubagent(toolUseId, null), SUBAGENT_KEPT_MS);
  };

  let branch = null, messages, capped = true;
  const most = type === "part" ? PART_TURNS : SUBAGENT_TURNS;
  try {
    let request, subTools, toolMap;
    // A variant's workspace is a branch of the caller's project, named for its call. The first variants of a chat make
    // the project, empty, so each starts from nothing.
    if (branched) {
      branch = workspace.branchOf(`${type}-${toolUseId ?? crypto.randomUUID().slice(0, 8)}`);
      await branch.open((await workspaceFor(context, { create: true })).state.project.id);
    }
    if (forked) {
      const question = type === "part" ? `${prompt}\n\nYour files: ${owned.join(", ")}` : prompt;
      const brief = type === "part" ? part => fill(PART_BRIEF, { part }) : take => fill(VARIANT_BRIEF, { take });
      ({ request, toolMap, messages } = forkOf(conversation, toolUseId, question, branch ? { brief, refuses: VARIANT_REFUSES } : {}));
      subTools = request.tools;
      if (type === "part") toolMap = ownedTools(toolMap, owned, branch, db);
    } else {
      // The rest start fresh, with every tool but task and the docs for those.
      const [system, names] = {
        explore: [fill(EXPLORE_PROMPT, { folder: folderName }), ["code", "think", "editor", "mcp"]],
        plan: [PLAN_PROMPT, ["code", "think", "editor", "mcp"]],
        general: [fill(GENERAL_PROMPT, { folder: folderName }), ["code", "think", "editor", "mcp"]],
        review: [REVIEW_PROMPT, ["code", "think", "view_file", "run_app", "history", "diff"]],
      }[type];
      request = { systemPrompt: system };
      subTools = TOOLS.filter(t => [...names, ...webToolNames()].includes(t.toolSpec.name));
      toolMap = Object.fromEntries(subTools.map(t => [t.toolSpec.name, t.fn]));
      // A reviewer starts from what the caller's turn would see: the files and the last run.
      const files = type === "review" && workspace?.state?.project ? await workspace.describeChanges(null) : null;
      messages = [{ role: "user", content: [...(files ? [{ text: files }] : []), { text: prompt }] }];
    }

    const effectiveModelId = (model && !forked && MODELS.find(m => m.label === model)?.id) || modelId || DEFAULT_MODEL;
    const client = await getConverseClient(providerOf(effectiveModelId));
    const subContext = { db, threadId, agentId, signal, host, ...((type === "fork" || type === "review") && { workspace }), ...(branch && { workspace: branch }) };
    // A fork's history is the caller's; its thread shows the question it was asked.
    await save({ role: "user", content: forked ? [{ text: prompt }] : messages[0].content });

    for (let turn = 0; turn < most; turn++) {
      signal?.throwIfAborted();
      const input = forked
        ? getConverseCommand({ ...request, tail: messages })
        : getConverseCommand({ modelId: effectiveModelId, reasoningMode, systemPrompt: request.systemPrompt, tools: subTools, messages });
      const output = await watchedSend(client, input, signal);
      const assistantMsg = { role: "assistant", content: [], createdAt: Date.now(), modelId: effectiveModelId };
      let stopReason = null;
      for await (const msg of output.stream) {
        processStreamChunk(assistantMsg.content, msg);
        if (msg.messageStop) stopReason = msg.messageStop.stopReason;
        if (msg.metadata?.usage) assistantMsg.usage = msg.metadata.usage;
        update({ currentMessage: { ...assistantMsg } });
      }
      messages.push(assistantMsg);
      await save(assistantMsg);
      update(entry => ({ messages: [...entry.messages, { ...assistantMsg }], currentMessage: null }));

      if (!assistantMsg.content.some(c => c?.toolUse)) { capped = false; break; }

      const toolResults = await getToolResults(assistantMsg.content, toolMap, { ...subContext, cutOff: stopReason === "max_tokens" });
      // Work cut off at the cap is lost to the caller, so the last turn is for the answer.
      if (turn === most - 2) toolResults.content.push({ text: "One turn left: answer now with what you have, and say what you didn't get to.", harness: true });
      messages.push(toolResults);
      await save(toolResults);
      update(entry => ({ messages: [...entry.messages, { ...toolResults }] }));
    }
  } catch (error) {
    await finish(signal?.aborted ? "stopped" : "error");
    throw error;
  } finally {
    branch?.dispose();
    if (branch) host?.release(workspace.state.project.id, branch.branch);
  }
  await finish("completed");
  // What the variant made: each file it changed, at its latest version. restore adopts one, diff compares.
  const made = branch && await (async () => {
    const project = await db.get("projects", workspace.state.project.id);
    const { base, heads } = project.branches?.[branch.branch] ?? { base: {}, heads: {} };
    return Object.fromEntries(Object.entries(heads).filter(([path, id]) => base[path] !== id));
  })();

  // A part's files are its own, and no sibling's, so the caller takes them all as they land.
  const adopted = type === "part" && made && Object.fromEntries(await Promise.all(Object.entries(made).map(async ([path, id]) =>
    [path, (await workspace.restore(id, { toolUseId })).version.id])));

  const said = messages.findLast(m => m.role === "assistant")?.content?.filter(c => c.text).map(c => c.text).join("\n\n");
  // Stopped at the cap, it may be mid-task; the caller hears so rather than taking its last words as the answer.
  const summary = capped ? `${said ? said + "\n\n" : ""}(Stopped after ${most} turns, unfinished.)` : said || "Completed";

  return {
    type,
    summary,
    folder: type === "explore" ? `/explore/${folderName}/` : null,
    // Nothing of a variant's is the caller's until it says so; a caller that took "done" for adopted lost the work.
    ...(adopted ? { adopted, ...(Object.keys(adopted).length && { note: "These are your files now: run the whole." }) }
      : made && { versions: made, ...(Object.keys(made).length && { adopt: `These versions are on the ${type}'s branch, not in your files: run_app { version } shows one, restore { version } makes it yours.` }) }),
    turns: messages.filter(m => m.role === "assistant").length - (forked ? 1 : 0), // not the caller's turn a fork starts from
    subagentThreadId,
  };
}

async function getToolResults(toolUseContent, tools, context = {}) {
  const calls = toolUseContent.filter(c => c.toolUse);
  const content = await Promise.all(
    calls
      .map(async ({ toolUse }, i) => {
        const { toolUseId, name, input } = toolUse;
        // Output that hit the length limit ends inside its last call, so that call's input is incomplete.
        if (context.cutOff && i === calls.length - 1) return { toolResult: { toolUseId, content: [{ json: { result: { error: "Your output hit the length limit before this call was complete, so it did not run. Send less per call: edit rather than rewrite, or split the file." } } }] } };
        if (typeof input === "string") return { toolResult: { toolUseId, status: "error", content: [{ text: JSON.stringify({ INVALID_JSON: input }) }] } };
        try {
          const fn = Object.hasOwn(tools ?? {}, name) ? tools[name] : null;
          if (!fn) return { toolResult: { toolUseId, content: [{ json: { result: { error: `Unknown tool: ${name}` } } }] } };
          // Pass toolUseId in context for task tool to use
          const output = await fn(input, { ...context, toolUseId });
          if (!output?.__media) return { toolResult: { toolUseId, content: [{ json: { result: output } }] } };
          const { __media: media, ...result } = output;
          return { toolResult: { toolUseId, content: [{ json: { result } }, ...media.map(mediaBlock)] } };
        } catch (error) {
          console.error("Tool error:", error);
          return { toolResult: { toolUseId, content: [{ json: { result: error.stack || error.message || String(error) } }] } };
        }
      })
  );
  return { role: "user", content };
}

async function getMessageContent(text, files) {
  const blocks = await Promise.all(files.map(getContentBlock));
  return [{ text }, ...blocks.filter(Boolean)];
}

async function getContentBlock(file) {
  const DOC_TYPES = ["pdf", "csv", "doc", "docx", "xls", "xlsx", "html", "txt", "md"];
  const IMG_TYPES = ["png", "jpg", "jpeg", "gif", "webp"];

  let ext = file.name.split(".").pop().toLowerCase();
  const isText = file.type.startsWith("text/") || /json|xml/.test(file.type);

  if (isText && !DOC_TYPES.includes(ext)) ext = "txt";
  if (ext === "htm") ext = "html";
  if (ext === "jpg") ext = "jpeg";

  const type = IMG_TYPES.includes(ext) ? "image" : DOC_TYPES.includes(ext) ? "document" : null;
  if (!type) return null;

  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = file.name.replace(/[^A-Z0-9 _\-\(\)\[\]]/gi, "_").replace(/\s+/g, " ").trim();
  return { [type]: { format: ext, name, source: { bytes } } };
}

// #endregion

// #region 6. WORKSPACE & RUNNER
// =============================================================================
// Versioned project files, the app runner and its reports, screenshots, local
// folders, and the workspace tools the agent edits with.
// =============================================================================

// File texts by hash, the most recently used kept up to a total length. A Map, so a caller can clear it.
const BLOB_CACHE_LIMIT = 32e6;
const blobCache = new class extends Map {
  length = 0;
  get(hash) {
    const text = super.get(hash);
    if (text !== undefined) { super.delete(hash); super.set(hash, text); }
    return text;
  }
  set(hash, text) {
    this.delete(hash);
    super.set(hash, text);
    this.length += text.length;
    for (const old of this.keys()) {
      if (this.length <= BLOB_CACHE_LIMIT || old === hash) break;
      this.delete(old);
    }
    return this;
  }
  delete(hash) {
    if (super.has(hash)) this.length -= super.get(hash).length;
    return super.delete(hash);
  }
  clear() {
    this.length = 0;
    super.clear();
  }
}();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

async function transformBytes(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

// Content-addressed and gzipped: identical file states share one row, so keeping every version stays cheap.
async function putBlob(db, text) {
  const hash = await sha256(text);
  if (!blobCache.has(hash) && !(await db.getKey("blobs", hash))) {
    const content = await transformBytes(new TextEncoder().encode(text), new CompressionStream("gzip"));
    await db.put("blobs", { hash, content, size: text.length });
  }
  blobCache.set(hash, text);
  return hash;
}

async function getBlob(db, hash) {
  const cached = blobCache.get(hash);
  if (cached !== undefined) return cached;
  const row = await db.get("blobs", hash);
  if (!row) throw new Error(`Missing file content ${hash.slice(0, 12)}`);
  const text = new TextDecoder().decode(await transformBytes(row.content, new DecompressionStream("gzip")));
  blobCache.set(hash, text);
  return text;
}

// A path in the project: forward slashes, no leading slash, and a .. that would climb out of it stops at the top.
// A folder keeps its trailing slash.
function normalizePath(path) {
  const text = String(path || "").replace(/\\/g, "/"), parts = [];
  for (const part of text.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/") + (parts.length && text.endsWith("/") ? "/" : "");
}

function countLines(text) {
  return text.split("\n").length;
}

function truncate(text, max) {
  return text.length > max ? text.slice(0, max) + `\n… truncated ${text.length - max} characters` : text;
}

function summarizeReport(r) {
  if (!r) return "not run";
  const parts = [r.ok ? "ok" : "failing"];
  if (r.tests) parts.push(`${r.tests.passed} passed`, ...(r.tests.failed ? [`${r.tests.failed} failed`] : []));
  if (r.errorCount) parts.push(`${r.errorCount} error${r.errorCount === 1 ? "" : "s"}`);
  if (r.timedOut?.includes("tests")) parts.push("tests timed out");
  if (r.scriptError) parts.push("script failed");
  return parts.join(", ");
}

function timeAgo(time) {
  const s = (Date.now() - time) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(time).toLocaleDateString();
}

const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const extensionOf = path => /\.([^./]+)$/.exec(path || "")?.[1].toLowerCase() ?? "";

function page(style, body) {
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${style}</style></head><body>${body}</body></html>`;
}

const PROSE_STYLE = "body{font:16px/1.65 system-ui,sans-serif;color:#1f1f1f;background:#fff;margin:0;padding:2rem 1.5rem}main{max-width:46rem;margin:0 auto}"
  + "h1,h2,h3{line-height:1.25;margin:1.5em 0 .5em}h1:first-child,h2:first-child{margin-top:0}img{max-width:100%}a{color:#0b57d0}"
  + "pre{background:#f6f5f0;padding:.75rem 1rem;border-radius:.5rem;overflow:auto}code{font:.875em ui-monospace,Consolas,monospace}"
  + "blockquote{margin:0;padding-left:1rem;border-left:3px solid #ddd;color:#555}table{border-collapse:collapse}th,td{border:1px solid #ddd;padding:.35rem .6rem;text-align:left}th{background:#f6f5f0}";

async function markdownToHtml(text) {
  const { marked } = await import(`${CDN.marked}/+esm`);
  return marked.parse(text);
}

function parseDelimited(text, separator) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && !cell) quoted = true;
    else if (c === separator) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function tablePage(text, separator) {
  const [head = [], ...body] = parseDelimited(text, separator);
  const cells = (row, tag) => `<tr>${row.map(c => `<${tag}>${escapeHtml(c)}</${tag}>`).join("")}</tr>`;
  return page(PROSE_STYLE + "main{max-width:none}", `<main><table><thead>${cells(head, "th")}</thead><tbody>${body.map(r => cells(r, "td")).join("")}</tbody></table></main>`);
}

// Each renderable type becomes an HTML document; errors surface through the page console like any other.
const RENDERERS = {
  html: text => text,
  htm: text => text,
  svg: text => page("html,body{margin:0;height:100%;background:#fff}body{display:grid;place-items:center}body>svg{max-width:calc(100% - 2rem);max-height:calc(100% - 2rem);height:auto}", text),
  md: async text => page(PROSE_STYLE, `<main>${await markdownToHtml(text)}</main>`),
  csv: text => tablePage(text, ","),
  tsv: text => tablePage(text, "\t"),
  json: text => {
    let body, error = null;
    try { body = JSON.stringify(JSON.parse(text), null, 2); } catch (e) { body = text; error = e.message; }
    const report = error ? `<script>console.error(${JSON.stringify("Invalid JSON: " + error)})<\/script>` : "";
    return page(PROSE_STYLE + "main{max-width:none}pre{margin:0}", `<main><pre><code>${escapeHtml(body)}</code></pre></main>${report}`);
  },
};

const isRenderable = path => Object.hasOwn(RENDERERS, extensionOf(path));
const isHtml = path => /^html?$/.test(extensionOf(path));
// scratch/ is the agent's bench: spikes, fixtures, harder tests. It runs off screen and never becomes the shown artifact.
const isScratch = path => normalizePath(path).startsWith("scratch/");

async function toDocument(path, text) {
  return RENDERERS[extensionOf(path)](text);
}

// Two screenshots count as the same view when their 16x16 grayscale fingerprints barely differ.
function sameView(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length < 2;
}

// Formats console arguments the way devtools shows them: strings bare, everything else inspected.
// Stringified into both sandboxes, so it must not reference module scope.
function inspectArgs(args) {
  const quote = s => "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n") + "'";
  const key = k => typeof k === "symbol" ? `[${k.toString()}]` : /^[A-Za-z_$][\w$]*$/.test(k) ? k : quote(k);
  const nameOf = v => { try { return v.constructor && v.constructor.name; } catch { return ""; } };
  const wrap = (open, parts, close, indent) => {
    if (!parts.length) return open.trimEnd() + close.trimStart();
    const flat = open + parts.join(", ") + close;
    if (flat.length <= 76 && !flat.includes("\n")) return flat;
    const pad = "\n" + "  ".repeat(indent + 1);
    return open.trimEnd() + pad + parts.join("," + pad) + "\n" + "  ".repeat(indent) + close.trimStart();
  };
  const inspect = (v, depth, seen, indent) => {
    if (v === null) return "null";
    switch (typeof v) {
      case "undefined": return "undefined";
      case "string": return depth ? quote(v.length > 2000 ? v.slice(0, 2000) + `… ${v.length - 2000} more characters` : v) : v;
      case "number": return Object.is(v, -0) ? "-0" : String(v);
      case "bigint": return v + "n";
      case "boolean": case "symbol": return v.toString();
      case "function": {
        const src = Function.prototype.toString.call(v);
        if (/^class\b/.test(src)) return `[class ${v.name || "(anonymous)"}]`;
        return `[${/^async\b/.test(src) ? "AsyncFunction" : "Function"}: ${v.name || "(anonymous)"}]`;
      }
    }
    if (seen.includes(v)) return "[Circular]";
    if (v instanceof Error || Object.prototype.toString.call(v) === "[object Error]") {
      const head = v.stack && v.stack.includes(v.message) ? v.stack : `${v.name}: ${v.message}${v.stack ? "\n" + v.stack : ""}`;
      const extra = Object.keys(v).filter(k => k !== "stack" && k !== "message");
      const cause = "cause" in v ? `\n  [cause]: ${inspect(v.cause, depth + 1, [...seen, v], indent + 1)}` : "";
      return head + (extra.length ? " " + wrap("{ ", extra.map(k => `${key(k)}: ${inspect(v[k], depth + 1, [...seen, v], indent + 1)}`), " }", indent) : "") + cause;
    }
    if (v instanceof Date) return isNaN(v) ? "Invalid Date" : v.toISOString();
    if (v instanceof RegExp) return String(v);
    if (typeof Node !== "undefined" && v instanceof Node) {
      const html = v.outerHTML ?? v.textContent ?? String(v);
      return html.length > 300 ? html.slice(0, 300) + "…" : html;
    }
    if (typeof Promise !== "undefined" && v instanceof Promise) return "Promise {}";
    const name = nameOf(v);
    const next = [...seen, v];
    const child = x => inspect(x, depth + 1, next, indent + 1);
    if (depth > 3) return Array.isArray(v) ? "[Array]" : `[${name || "Object"}]`;
    if (v instanceof ArrayBuffer) return `ArrayBuffer { byteLength: ${v.byteLength} }`;
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
      const items = Array.from(v.subarray(0, 100), x => typeof x === "bigint" ? x + "n" : String(x));
      if (v.length > 100) items.push(`… ${v.length - 100} more items`);
      return wrap(`${name}(${v.length}) [ `, items, " ]", indent);
    }
    if (v instanceof Map) {
      const items = [...v].slice(0, 100).map(([k, x]) => `${child(k)} => ${child(x)}`);
      if (v.size > 100) items.push(`… ${v.size - 100} more items`);
      return wrap(`Map(${v.size}) { `, items, " }", indent);
    }
    if (v instanceof Set) {
      const items = [...v].slice(0, 100).map(child);
      if (v.size > 100) items.push(`… ${v.size - 100} more items`);
      return wrap(`Set(${v.size}) { `, items, " }", indent);
    }
    if (Array.isArray(v)) {
      const items = v.slice(0, 100).map(child);
      if (v.length > 100) items.push(`… ${v.length - 100} more items`);
      const named = Object.keys(v).filter(k => !/^\d+$/.test(k)).map(k => `${key(k)}: ${child(v[k])}`);
      return wrap("[ ", [...items, ...named], " ]", indent);
    }
    let keys = [...Object.keys(v), ...Object.getOwnPropertySymbols(v).filter(s => Object.prototype.propertyIsEnumerable.call(v, s))];
    // Platform objects (DOMRect, Response, Headers) keep their fields on the prototype.
    if (!keys.length && typeof v.toJSON === "function") try { return `${name} ${child(v.toJSON())}`; } catch {}
    if (!keys.length && typeof v.entries === "function" && typeof v[Symbol.iterator] === "function") try {
      return wrap(`${name} { `, [...v.entries()].slice(0, 100).map(([k, x]) => `${child(k)} => ${child(x)}`), " }", indent);
    } catch {}
    if (!keys.length && name && name !== "Object") {
      const proto = Object.getPrototypeOf(v);
      keys = Object.entries(Object.getOwnPropertyDescriptors(proto)).filter(([k, d]) => d.get && typeof k === "string").map(([k]) => k);
      if (keys.length) return wrap(`${name} { `, keys.slice(0, 30).map(k => { try { return `${key(k)}: ${child(v[k])}`; } catch { return `${key(k)}: [Getter]`; } }), " }", indent);
    }
    const prefix = Object.getPrototypeOf(v) === null ? "[Object: null prototype] " : name && name !== "Object" ? name + " " : "";
    const items = keys.slice(0, 100).map(k => `${key(k)}: ${child(v[k])}`);
    if (keys.length > 100) items.push(`… ${keys.length - 100} more properties`);
    return wrap(prefix + "{ ", items, " }", indent);
  };
  // printf-style substitutions, as in console.log("%s has %d items", name, n)
  if (typeof args[0] === "string" && /%[sdifoOjc%]/.test(args[0]) && args.length > 1) {
    let i = 1;
    const first = args[0].replace(/%([sdifoOjc%])/g, (m, f) => {
      if (f === "%") return "%";
      if (i >= args.length) return m;
      const a = args[i++];
      return f === "s" ? (typeof a === "string" ? a : inspect(a, 1, [], 0))
        : f === "d" || f === "i" ? String(parseInt(a)) : f === "f" ? String(parseFloat(a)) : f === "c" ? "" : inspect(a, 1, [], 0);
    });
    args = [first, ...args.slice(i)];
    return [args[0], ...args.slice(1).map(a => inspect(a, 0, [], 0))].join(" ");
  }
  return args.map(a => inspect(a, 0, [], 0)).join(" ");
}

// A classic script from a CDN throws only "Script error." unless it is fetched with CORS. These CDNs allow it,
// so the run asks, and the error arrives with its message and line. The stored file is not touched.
const CORS_CDN = /\bsrc\s*=\s*["']?https:\/\/(cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|esm\.sh|esm\.run)\//i;
const unmuteScripts = html => html.replace(/<script\b([^>]*)>/gi, (tag, attrs) =>
  CORS_CDN.test(attrs) && !/\b(crossorigin|integrity)\b|\btype\s*=\s*["']?module/i.test(attrs) ? `<script${attrs.replace(/\s*\/$/, "")} crossorigin="anonymous">` : tag);

function proxyRewrite(url) {
  const proxy = getProxyConfig();
  if (!proxy?.endpoint) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  const endpoint = proxy.endpoint.replace(/\/+$/, "");
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].some(h => u.hostname === h || u.hostname.endsWith(".localhost"));
  if (!/^https?:$/.test(u.protocol) || isLocal || u.origin === location.origin || u.href.startsWith(endpoint)) return null;
  const headers = proxy.headerName && proxy.headerValue ? { [proxy.headerName]: proxy.headerValue } : {};
  return { url: endpoint + "/" + u.href, headers };
}

function toResultValue(value) {
  if (value === undefined) return null;
  if (value && typeof value === "object" && "outerHTML" in value) return truncate(String(value.outerHTML), 2000);
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json.length > 4000 ? truncate(json, 4000) : JSON.parse(json);
  } catch {
    return truncate(String(value), 4000);
  }
}

async function fileHandle(dir, path, create = false) {
  const parts = path.split("/");
  const name = parts.pop();
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
  return dir.getFileHandle(name, { create });
}

async function listFolder(dir, prefix = "", out = []) {
  for await (const [name, handle] of dir.entries()) {
    if (out.length >= 200) break;
    if (handle.kind === "file") out.push(prefix + name);
    else if (!/^(\.git|node_modules|\.artifacts)$/.test(name) && prefix.split("/").length < 3) await listFolder(handle, prefix + name + "/", out);
  }
  return out;
}

// One per App. Owns the open project, its runner, and the run queue.
// Read-modify-commit sections on one project run one at a time, in whichever workspace, tab or worker holds it.
// headless: a workspace for a project the panel isn't showing. It tests in parked frames and shows nothing.
// host: the engine's workspace, which has no frames; host.run tests a version in a tab and stores its report.
// frames: createRunner, in a tab.
// branch: a variant's line of work on the project. Its commits move the branch's heads, never the project's; it
// starts from the project's heads (its base) and runs off screen.
function createWorkspace(db, { headless = false, host = null, frames = null, branch = null } = {}) {
  headless ||= !!host || !!branch;
  const view = project => (branch && project ? { ...project, heads: project.branches?.[branch]?.heads ?? project.heads } : project);
  const id = crypto.randomUUID().slice(0, 8);
  const [state, setState] = createStore({
    project: null,    // { id, agentId, name, entry, heads: { path: versionId }, dirHandle? }
    files: {},        // path -> current text
    report: null,     // last run report of the shown artifact
    running: false,
    runLog: [],       // console of the last test run
    logs: [],         // live console of the preview frame
    viewport: "fit",
    tab: "preview",
    panel: false,     // the artifact panel beside the chat
    focus: false,     // the artifact fills the window and the chat floats over it
    selected: null,   // file open in the Code tab; defaults to the shown artifact
    preview: null,    // { versionId, path, text } while an older version is shown
    capture: "none",  // element | region | tab | none
    folder: null,     // { name, status: connected | permission }
    versions: [],     // newest first
    notice: null,
    captureChoice: globalThis.localStorage?.getItem(CAPTURE_CHOICE_KEY) ?? null, // allowed | dismissed | null
  });
  let context = {};
  let runQueue = Promise.resolve();
  let folder = null, stopWatching = null, syncing = false, noticeTimer = null;
  const diskSeen = new Map();
  const runner = host || !frames ? null : frames(id, {
    state, setState,
    notify: message => notify(message),
    resources: (command, args) => sandboxFiles(command, args, { db, threadId: context.threadId, agentId: context.agentId, workspace: { state, readFile, listFiles } }),
  });

  const enqueueRun = fn => { const p = runQueue.then(fn); runQueue = p.catch(() => {}); return p; };
  // Read-modify-commit sections run one at a time, so parallel tool calls never lose an edit. Each starts from
  // the database, since another workspace may have moved the heads.
  const exclusive = fn => navigator.locks.request("project:" + (state.project?.id ?? null), async () => { await sync(); return fn(); });
  // Other workspaces on the same project, in this tab or another, follow each change. A quiet one is the
  // engine's, which a tab runs next and announces as ran, so the panel runs each version once.
  const channel = new BroadcastChannel("projects");
  channel.onmessage = ({ data }) => {
    if (data.projectId !== state.project?.id) return;
    const shown = state.project.heads[shownPath()];
    exclusive(() => {}).then(() => !headless && state.project && (data.ran || (!data.quiet && state.project.heads[shownPath()] !== shown)) && refresh());
  };

  function notify(message) {
    clearTimeout(noticeTimer);
    setState("notice", message);
    noticeTimer = setTimeout(() => setState("notice", null), 6000);
  }

  // The artifact on show: the entry when it renders, else the first file that does.
  function shownPath(project = state.project) {
    if (!project) return null;
    if (project.heads[project.entry] && isRenderable(project.entry)) return project.entry;
    return Object.keys(project.heads).sort().find(p => isRenderable(p) && !isScratch(p)) ?? null;
  }

  // Files that render become the shown artifact; others open as code. A new artifact opens the panel.
  async function show(path) {
    path = normalizePath(path);
    if (!isRenderable(path)) {
      setState({ selected: path, tab: "code", panel: true });
      return false;
    }
    const isNew = state.selected !== path;
    setState("selected", path);
    if (state.project.entry !== path) await saveProject({ entry: path }, { quiet: !!host });
    if (isNew && globalThis.innerWidth >= 992) setState("panel", true);
    return true;
  }

  async function select(path) {
    if (await show(path)) await run();
  }

  // screenshot: true forces one, false skips it, "auto" attaches one while the user shares the tab.
  // announce: tell the other workspaces on the project, for a run the engine asked for.
  // signal: a run its caller stopped while it waited its turn doesn't start.
  function run({ versionId = null, script = null, screenshot = false, viewport = null, announce = false, signal = null } = {}) {
    if (host) return hostRun({ versionId, script, screenshot, viewport }, signal);
    if (viewport) setState("viewport", viewport);
    return enqueueRun(async () => {
      signal?.throwIfAborted();
      const result = await runNow({ versionId, script, screenshot });
      if (announce) channel.postMessage({ projectId: state.project.id, ran: true });
      return result;
    });
  }

  async function hostRun(args, signal) {
    const project = state.project;
    if (!project) throw new Error("No project is open.");
    const shown = shownPath(project);
    const versionId = args.versionId ?? (shown && project.heads[shown]);
    if (!versionId) throw new Error("Nothing to show yet. Create an artifact with write_file.");
    const path = (await db.get("versions", +versionId))?.path ?? null;
    const result = await host.run({ ...args, versionId: +versionId, path, projectId: project.id, branch, threadId: context.threadId ?? null, agentId: context.agentId ?? null }, { signal });
    if (state.project?.id === project.id && project.heads[path] === +versionId && !isScratch(path)) setState("report", { ...result.report });
    return result;
  }
  // A run nobody waits on; one the user closed the project under has nothing to say.
  const refresh = () => run().catch(e => e.closed || notify(e.message));

  // The runner answers with the report; the version keeps it, as the shown artifact's latest.
  async function runNow({ versionId, script, screenshot }) {
    const project = state.project;
    if (!project) throw new Error("No project is open.");
    const shown = shownPath(project);
    const targetId = versionId ?? (shown && project.heads[shown]);
    if (!targetId) throw new Error("Nothing to show yet. Create an artifact with write_file.");
    const version = await db.get("versions", +targetId);
    if (!version || version.projectId !== project.id) throw new Error(`Unknown version v${targetId}`);
    if (!isRenderable(version.path)) throw new Error(`${version.path} does not render; read it with view_file.`);
    const content = await getBlob(db, version.hash);
    const doc = await toDocument(version.path, content);
    const isHead = project.heads[version.path] === version.id;
    // A scratch page runs off screen: the preview, its logs, and its report stay the shown artifact's.
    const scratch = isScratch(version.path);
    // The page runs in its folder: the project's other files, served beside it.
    const files = Object.fromEntries(await Promise.all(Object.entries(project.heads).filter(([p]) => p !== version.path)
      .map(async ([p, id]) => [p, await getBlob(db, (await db.get("versions", id)).hash)])));
    const missing = isHtml(version.path) ? await missingFiles(version.path, content, p => files[p] ?? null) : [];
    if (missing.length) return { report: { version: version.id, path: version.path, ok: false, errors: missing, notes: ["Not run: the page loads files the workspace doesn't have."] } };
    setState({ running: true, ...(!scratch && { logs: [], preview: isHead ? null : { versionId: version.id, path: version.path, text: content } }) });
    try {
      const { report, image, thumb, runLog } = await runner.run({ version: { id: version.id, path: version.path }, doc, files, script, screenshot, parked: scratch });
      if (!scratch) setState("runLog", runLog);
      if (isHead) {
        const stored = { ...report, thumb: thumb || version.report?.thumb || null };
        await db.put("versions", { ...version, report: stored });
        setState("versions", v => v.id === version.id, "report", stored);
        // A copy: the store merges the next report into this one, and the caller's goes into the history the model rereads.
        if (state.project?.id === project.id && !scratch) setState("report", { ...report });
      }
      return { report, image };
    } finally {
      setState("running", false);
    }
  }

  // Read and written in one transaction, so another workspace's save can't land between the two.
  async function saveProject(changes, { quiet = false } = {}) {
    const tx = db.transaction("projects", "readwrite");
    const current = (await tx.store.get(state.project.id)) ?? unwrap(state.project);
    const stale = (current.rev ?? 0) !== (state.project.rev ?? 0);
    if (branch && changes.heads) {
      const { heads, ...rest } = changes;
      const base = current.branches?.[branch]?.base ?? current.heads;
      changes = { ...rest, branches: { ...current.branches, [branch]: { base, heads } } };
    }
    const next = { ...current, ...changes, rev: (current.rev ?? 0) + 1, updatedAt: Date.now() };
    tx.store.put(next);
    await tx.done;
    setState("project", reconcile(view(next)));
    if (stale) { await loadFiles(); await refreshVersions(); }
    channel.postMessage({ projectId: next.id, ...(quiet && { quiet }) });
    return next;
  }

  // Catches up with changes another workspace made; false when there were none.
  async function sync() {
    const fresh = view(state.project && (await db.get("projects", state.project.id)));
    if (!fresh || (fresh.rev ?? 0) === (state.project.rev ?? 0)) return false;
    // One update, so a view of the shown file never sees it before its text.
    const { files, report } = await readFiles(fresh);
    batch(() => { setState("project", reconcile(fresh)); setState("files", reconcile(files)); setState("report", report); });
    await refreshVersions();
    return true;
  }

  async function readFiles(project) {
    const files = {};
    let report = null;
    for (const [path, versionId] of Object.entries(unwrap(project.heads))) {
      const version = await db.get("versions", versionId);
      if (!version) continue;
      files[path] = await getBlob(db, version.hash);
      if (path === shownPath(project)) report = version.report ?? null;
    }
    return { files, report };
  }

  async function loadFiles() {
    const { files, report } = await readFiles(state.project);
    setState("files", reconcile(files));
    setState("report", report);
  }

  async function refreshVersions() {
    const versions = await db.getAllFromIndex("versions", "projectId", state.project.id);
    setState("versions", reconcile(versions.sort((a, b) => b.id - a.id).slice(0, 200), { key: "id" }));
  }

  // run: false leaves the preview for the caller, who runs it next.
  async function open(projectId, { run: preview = true } = {}) {
    const project = view(await db.get("projects", +projectId));
    if (!project) return null;
    detachFolder();
    runner?.reset();
    setState({ project, report: null, preview: null, logs: [], runLog: [], selected: null, focus: false });
    await loadFiles();
    await refreshVersions();
    if (project.dirHandle && !branch) await reconnect(project.dirHandle, false).catch(e => notify(e.message));
    if (headless) return state.project;
    setState("panel", !!shownPath() && globalThis.innerWidth >= 992);
    if (shownPath() && preview) refresh();
    return state.project;
  }

  function close() {
    detachFolder();
    setState({ project: null, files: {}, report: null, preview: null, versions: [], logs: [], runLog: [], panel: false, focus: false, selected: null });
    runner?.blank();
  }

  async function createProject({ agentId = 1, name = "Untitled", entry = "index.html", content = null } = {}) {
    const now = Date.now();
    const projectId = await db.add("projects", { agentId, name, entry, heads: {}, createdAt: now, updatedAt: now });
    await open(projectId);
    if (content != null) {
      await exclusive(() => commit(entry, content, { source: "user" }));
      refresh();
    }
    return state.project;
  }

  // An agent can start building in any chat; the chat then belongs to the new project. Parallel calls (variants,
  // writes) share the one being made.
  let ensuring = null;
  function ensureProject({ agentId = 1, threadId = null } = {}) {
    if (state.project) return Promise.resolve(state.project);
    return ensuring ??= (async () => {
      const thread = threadId ? await db.get("threads", threadId) : null;
      const project = await createProject({ agentId, name: thread?.name || "Untitled" });
      if (thread) await db.put("threads", { ...thread, projectId: project.id });
      return project;
    })().finally(() => { ensuring = null; });
  }

  async function commit(path, text, meta = {}) {
    if (!state.project) throw new Error("No project is open.");
    path = normalizePath(path || shownPath() || state.project.entry);
    if (!path) throw new Error("A file path is required.");
    const hash = await putBlob(db, text);
    const headId = state.project.heads[path];
    const head = headId ? await db.get("versions", headId) : null;
    if (head?.hash === hash) return { version: head, changed: false, before: text };
    const before = head ? await getBlob(db, head.hash) : null;
    const version = {
      projectId: state.project.id, path, parentId: headId ?? null, hash, size: text.length, lines: countLines(text),
      source: meta.source || "agent", threadId: meta.threadId ?? context.threadId ?? null, toolUseId: meta.toolUseId ?? null,
      restoredFrom: meta.restoredFrom ?? null, createdAt: Date.now(), report: null, branch,
    };
    version.id = await db.add("versions", version);
    // The engine's changes are quiet: the run that follows shows them.
    await saveProject({ heads: { ...unwrap(state.project.heads), [path]: version.id } }, { quiet: !!host && meta.source !== "disk" });
    setState("files", path, text);
    setState("versions", versions => [version, ...versions].slice(0, 200));
    if (meta.source !== "disk") await writeToFolder(path, text);
    return { version, changed: true, before };
  }

  async function checkout(heads) {
    if (!state.project || !heads) return false;
    const current = { ...unwrap(state.project.heads) };
    const paths = new Set([...Object.keys(current), ...Object.keys(heads)]);
    if ([...paths].every(p => current[p] === heads[p])) return false;
    await exclusive(async () => {
      await saveProject({ heads: { ...heads } });
      await loadFiles();
      for (const path of Object.keys(heads)) if (heads[path] !== current[path]) await writeToFolder(path, state.files[path]);
    });
    if (shownPath()) refresh();
    return true;
  }

  // What the agent should know about the files before it reads the new user message:
  // undefined = parent predates versioning, null = start of the thread, otherwise the heads it last saw.
  // liveErrors: what the preview logged while the user used it; the tab showing it sends them.
  async function describeChanges(parentHeads, liveErrors = runner?.liveErrors() ?? []) {
    const project = state.project;
    if (!project || parentHeads === undefined) return null;
    const heads = unwrap(project.heads);
    const used = liveErrors.length ? `\nWhile the user used ${shownPath()}, it logged errors:\n${liveErrors.map(e => "- " + e).join("\n")}` : "";
    const block = body => `<workspace>\n${body}${used}\n</workspace>`;
    if (parentHeads === null) {
      const paths = Object.keys(heads).sort();
      if (!paths.length) return null;
      const lines = [];
      for (const path of paths) {
        const v = await db.get("versions", heads[path]);
        const shown = path === shownPath() ? isHtml(path) ? " (shown, runs with its tests)" : " (shown)" : "";
        lines.push(`- ${path} v${v.id}, ${v.lines} lines${shown}`);
      }
      const last = state.report ? `\nLast run of v${state.report.version}: ${summarizeReport(state.report)}` : "";
      return block(`Artifacts in this chat:\n${lines.join("\n")}${last}`);
    }
    const changed = [...new Set([...Object.keys(heads), ...Object.keys(parentHeads)])].filter(p => heads[p] !== parentHeads[p]).sort();
    if (!changed.length) return used ? block("No file changes since your last turn.") : null;
    const parts = [];
    for (const path of changed) {
      const from = parentHeads[path] ? await db.get("versions", parentHeads[path]) : null;
      const to = heads[path] ? await db.get("versions", heads[path]) : null;
      const a = from ? await getBlob(db, from.hash) : "", b = to ? await getBlob(db, to.hash) : "";
      const label = `${path}: ${from ? "v" + from.id : "new"} → ${to ? `v${to.id} (${to.source})` : "removed"}`;
      const patch = createTwoFilesPatch(path, path, a, b, from ? `v${from.id}` : "", to ? `v${to.id}` : "", { context: 2 });
      parts.push(label + "\n" + truncate(patch.split("\n").slice(2).join("\n"), 4000));
    }
    return block(`Files changed outside your edits since your last turn:\n${parts.join("\n\n")}`);
  }

  async function readFile(path) {
    path = normalizePath(path || shownPath() || state.project?.entry);
    if (path in state.files) return state.files[path];
    if (folder) {
      const disk = await readDisk(path);
      if (disk) return disk.text;
    }
    return null;
  }

  async function readVersion(versionId) {
    const version = await db.get("versions", +versionId);
    if (!version || version.projectId !== state.project?.id) throw new Error(`Unknown version v${versionId}`);
    // Why: Luna's parts listed one another's versions and restored them over their own.
    if (branch && version.branch && version.branch !== branch) throw new Error(`v${versionId} is another sub-agent's, on its own branch.`);
    return { version, text: await getBlob(db, version.hash) };
  }

  async function listFiles(prefix = "") {
    const paths = new Set(Object.keys(state.files));
    if (folder) for (const path of await listFolder(folder)) paths.add(path);
    return [...paths].filter(p => p.startsWith(prefix)).sort();
  }

  async function listVersions({ path, limit = 20 } = {}) {
    const versions = await db.getAllFromIndex("versions", "projectId", state.project.id);
    return versions.filter(v => (!path || v.path === normalizePath(path)) && (!branch || !v.branch || v.branch === branch)).sort((a, b) => b.id - a.id).slice(0, limit);
  }

  async function diff(fromId, toId) {
    const a = await readVersion(fromId);
    const b = await readVersion(toId ?? state.project.heads[a.version.path]);
    if (a.version.id === b.version.id || a.text === b.text) return `v${a.version.id} and v${b.version.id} are identical`;
    const patch = createTwoFilesPatch(a.version.path, b.version.path, a.text, b.text, `v${a.version.id}`, `v${b.version.id}`, { context: 3 });
    return truncate(patch, 12000);
  }

  async function restore(versionId, meta = {}) {
    const { version, text } = await readVersion(versionId);
    const result = await exclusive(() => commit(version.path, text, { ...meta, source: "restore", restoredFrom: version.id }));
    return { ...result, text };
  }

  async function userEdit(path, text) {
    const { version, changed } = await exclusive(() => commit(path, text, { source: "user" }));
    if (changed && version.path === shownPath()) refresh();
    return version;
  }

  async function readDisk(path) {
    try {
      const file = await (await fileHandle(folder, path)).getFile();
      diskSeen.set(path, file.lastModified);
      return { text: await file.text(), lastModified: file.lastModified };
    } catch {
      return null;
    }
  }

  async function writeToFolder(path, text) {
    if (!folder || text == null) return;
    try {
      const handle = await fileHandle(folder, path, true);
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      diskSeen.set(path, (await handle.getFile()).lastModified);
    } catch (e) {
      notify(`Could not write ${path} to the folder: ${e.message}`);
    }
  }

  async function openFolder() {
    if (!state.project) throw new Error("Create or open an app first.");
    if (!window.showDirectoryPicker) throw new Error("This browser cannot open local folders.");
    const handle = await window.showDirectoryPicker({ id: "chat-harness", mode: "readwrite" });
    await saveProject({ dirHandle: handle });
    await attachFolder(handle);
  }

  async function reconnect(handle = state.project?.dirHandle, ask = true) {
    if (!handle) return;
    const mode = { mode: "readwrite" };
    let permission = await handle.queryPermission?.(mode);
    if (permission !== "granted" && ask) permission = await handle.requestPermission(mode);
    if (permission === "granted") return attachFolder(handle);
    setState("folder", { name: handle.name, status: "permission" });
  }

  // The folder's copy wins when the two differ; files the folder lacks are written out.
  async function attachFolder(handle) {
    detachFolder();
    folder = handle;
    setState("folder", { name: handle.name, status: "connected" });
    let entryChanged = false;
    for (const path of new Set([...Object.keys(state.files), state.project.entry])) {
      const disk = await readDisk(path);
      if (!disk) await writeToFolder(path, state.files[path]);
      else if (disk.text !== state.files[path]) {
        await exclusive(() => commit(path, disk.text, { source: "disk" }));
        if (path === shownPath()) entryChanged = true;
      }
    }
    const sync = () => syncFromDisk().catch(e => notify(`Folder sync failed: ${e.message}`));
    if ("FileSystemObserver" in window) {
      const observer = new FileSystemObserver(() => sync());
      observer.observe(handle, { recursive: true }).catch(() => {});
      stopWatching = () => observer.disconnect();
    } else {
      const timer = setInterval(() => document.visibilityState === "visible" && sync(), 1500);
      stopWatching = () => clearInterval(timer);
    }
    if (entryChanged) refresh();
  }

  async function syncFromDisk() {
    if (!folder || syncing || !state.project) return;
    syncing = true;
    try {
      let entryChanged = false;
      for (const path of Object.keys(state.files)) {
        const handle = await fileHandle(folder, path).catch(() => null);
        if (!handle) continue;
        const file = await handle.getFile();
        if (diskSeen.get(path) === file.lastModified) continue;
        diskSeen.set(path, file.lastModified);
        const text = await file.text();
        if (text === state.files[path]) continue;
        const { changed } = await exclusive(() => commit(path, text, { source: "disk" }));
        if (changed && path === shownPath()) entryChanged = true;
      }
      if (entryChanged) refresh();
    } finally {
      syncing = false;
    }
  }

  function detachFolder() {
    stopWatching?.();
    stopWatching = null;
    folder = null;
    diskSeen.clear();
    setState("folder", null);
  }

  async function captureView() {
    if (!shownPath()) throw new Error("Nothing is shown yet.");
    return runner.captureView(shownPath());
  }

  function dispose() {
    channel.close();
    runner?.dispose();
    detachFolder();
    clearTimeout(noticeTimer);
  }

  return {
    id, state, setState, notify, shownPath, show, select, rememberCapture: runner?.rememberCapture, captureView,
    open, close, createProject, ensureProject, commit, checkout, describeChanges,
    readFile, readVersion, listFiles, listVersions, diff, restore, userEdit, exclusive,
    run, preview: versionId => run({ versionId }),
    setContext: value => { context = { ...context, ...value }; },
    rename: name => saveProject({ name }),
    mountPreview: runner?.mountPreview, enableCapture: runner?.enableCapture, disableCapture: runner?.disableCapture,
    liveErrors: () => runner?.liveErrors() ?? [],
    openFolder, reconnect, dispose,
    branch, branchOf: name => createWorkspace(db, { host, frames, branch: name }),
  };
}

// Workspace editing primitives

function numberedLine(n, line) {
  return `${n}\t${line.length > 1000 ? line.slice(0, 1000) + `… [+${line.length - 1000} chars]` : line}`;
}

function outline(lines) {
  const rules = [
    [/(?:\/\/|<!--|\/\*)\s*#(region|endregion)\b\s*(.*?)\s*(?:-->|\*\/)?\s*$/, m => m[1] === "region" ? `#region ${m[2]}` : null],
    [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)\s*\(/, m => `function ${m[1]}`],
    [/^\s*(?:export\s+)?class\s+([\w$]+)/, m => `class ${m[1]}`],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/, m => `function ${m[1]}`],
    [/<h([1-3])\b[^>]*>(.*?)(?:<\/h\1>|$)/i, m => `h${m[1]} ${m[2].replace(/<[^>]+>/g, "").trim()}`],
    [/<(head|body|main|header|footer|nav|section|article|aside|template|style|script|form|dialog)\b[^>]*>/i, m => m[0].length > 80 ? m[0].slice(0, 77) + "…>" : m[0]],
  ];
  const out = [];
  lines.forEach((line, i) => {
    for (const [pattern, label] of rules) {
      const match = line.match(pattern);
      if (!match) continue;
      const text = label(match);
      if (text) out.push(`${i + 1}: ${text}`);
      break;
    }
  });
  return out.length > 200 ? [...out.slice(0, 200), `… ${out.length - 200} more; use grep`] : out;
}

function indexesOf(text, needle) {
  const out = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

function lineAt(text, index) {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) line++;
  return line;
}

// Explains a failed match well enough that the next attempt succeeds.
function nearMiss(text, needle) {
  // Escaped once too often on the way into the call: each backslash the file has comes twice.
  const once = needle.replace(/\\\\/g, "\\");
  if (once !== needle && text.includes(once)) return ` The text is there with half the backslashes, at line ${lineAt(text, text.indexOf(once))}: copy each backslash as the file has it.`;
  const map = [];
  let squashed = "";
  for (let i = 0; i < text.length; i++) if (!/\s/.test(text[i])) { map.push(i); squashed += text[i]; }
  const target = needle.replace(/\s+/g, "");
  const at = target ? squashed.indexOf(target) : -1;
  if (at >= 0) return ` Text matching except for whitespace starts at line ${lineAt(text, map[at])}; copy it exactly, including indentation and line breaks.`;

  const tokens = s => new Set(s.match(/[\w$]+/g) || []);
  const wanted = tokens(needle);
  if (!wanted.size) return "";
  const lines = text.split(/\r?\n/);
  const span = Math.min(Math.max(needle.split("\n").length, 1), 30);
  const lineTokens = lines.map(tokens);
  let best = -1, bestScore = 0;
  for (let i = 0; i + span <= lines.length; i++) {
    const seen = new Set();
    for (let j = i; j < i + span; j++) for (const t of lineTokens[j]) if (wanted.has(t)) seen.add(t);
    const score = seen.size / wanted.size;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  if (best < 0 || bestScore < 0.3) return "";
  const shown = lines.slice(best, best + span).map((l, k) => numberedLine(best + k + 1, l)).join("\n");
  return ` Closest text (lines ${best + 1}-${best + span}):\n${shown}`;
}

// Marker lengths and a missing keyword are forgiven. partial takes what has streamed so far, for the card.
function parsePatch(patch, { partial = false } = {}) {
  const edits = [];
  let block = null;
  const close = all => edits.push({ old_str: block.old.join("\n"), new_str: block.new.join("\n"), ...(all && { replace_all: true }) });
  for (const [i, line] of String(patch).split(/\r?\n/).entries()) {
    if (!block) { if (SEARCH_MARK.test(line)) block = { old: [], new: [], side: "old", line: i + 1 }; continue; }
    if (block.side === "old" && DIVIDER_MARK.test(line)) block.side = "new";
    // A second divider would land in the file as code; which side of it is new text is anyone's guess.
    else if (DIVIDER_MARK.test(line) && !partial) throw new Error(`block ${edits.length + 1} (line ${block.line}) has a second ======= at line ${i + 1}; a block has one, between the old text and the new`);
    else if (block.side === "new" && REPLACE_MARK.test(line)) { close(REPLACE_MARK.exec(line)[2]); block = null; }
    else if (SEARCH_MARK.test(line) && !partial) throw new Error(`block ${edits.length + 1} (line ${block.line}) never reached ${block.side === "old" ? "=======" : ">>>>>>> REPLACE"} before the next SEARCH`);
    else block[block.side].push(line);
  }
  if (block && partial) close();
  else if (block) throw new Error(`block ${edits.length + 1} (line ${block.line}) has no ${block.side === "old" ? "=======" : ">>>>>>> REPLACE"} line`);
  if (!edits.length && !partial) throw new Error("patch has no SEARCH/REPLACE blocks. Write each change as:\n" + PATCH_FORMAT);
  return edits;
}

// The lines of oldStr, found once with whitespace at either end of each line ignored, replaced by newStr
// at the file's indentation. Returns null unless the match is unique.
function looseMatch(text, oldStr, newStr) {
  const lines = text.split(/\r?\n/);
  let want = oldStr.split(/\r?\n/), put = newStr.split(/\r?\n/);
  while (want.length && !want[0].trim()) { want.shift(); if (put.length && !put[0].trim()) put.shift(); }
  while (want.length && !want.at(-1).trim()) { want.pop(); if (put.length && !put.at(-1).trim()) put.pop(); }
  if (!want.length) return null;
  const hits = [];
  for (let i = 0; i + want.length <= lines.length && hits.length < 2; i++) if (want.every((w, k) => lines[i + k].trim() === w.trim())) hits.push(i);
  if (hits.length !== 1) return null;
  const [at] = hits;
  const indent = s => s.match(/^\s*/)[0];
  const from = indent(want[0]), to = indent(lines[at]);
  lines.splice(at, want.length, ...put.map(l => l.startsWith(from) ? to + l.slice(from.length) : l));
  return { text: lines.join(text.includes("\r\n") ? "\r\n" : "\n"), from: at + 1, to: at + want.length };
}

// Applies every edit in order or none of them. A failing edit is skipped and the rest still tried, so the error
// names every edit to fix, not only the first, and one retry can fix them all. A loose match goes in notes.
function applyEdits(text, edits, { notes = [], name = i => `block ${i + 1}` } = {}) {
  const crlf = text.includes("\r\n");
  let out = text;
  const failed = [];
  edits.forEach((edit, i) => { try { out = applyEdit(out, edit, i); } catch (e) { failed.push(e.message); } });
  if (failed.length > 1) throw new Error(`${failed.length} of ${edits.length} edits failed, so none were applied:\n${failed.join("\n")}`);
  if (failed.length) throw new Error(failed[0]);
  return out;

  function applyEdit(out, edit, i) {
    let { old_str: oldStr, new_str: newStr, replace_all: all } = edit || {};
    if (typeof oldStr !== "string" || typeof newStr !== "string") throw new Error(`${name(i)}: old_str and new_str must be strings`);
    if (!oldStr) throw new Error(`${name(i)}: the text to find is empty; use write_file to replace a whole file`);
    if (crlf && !oldStr.includes("\r")) {
      oldStr = oldStr.replace(/\n/g, "\r\n");
      newStr = newStr.replace(/\n/g, "\r\n");
    }
    const at = indexesOf(out, oldStr);
    if (!at.length) {
      const loose = !all && looseMatch(out, oldStr, newStr);
      if (!loose) throw new Error(`${name(i)}: text not found${i ? " (after applying the earlier edits)" : ""}.${nearMiss(out, oldStr)}`);
      notes.push(`${name(i)} matched L${loose.from}-${loose.to} with different whitespace; replaced at the file's indentation.`);
      return loose.text;
    }
    if (at.length > 1 && !all) {
      const lines = at.slice(0, 10).map(p => lineAt(out, p)).join(", ");
      throw new Error(`${name(i)}: text matches ${at.length} times (lines ${lines}). Include more surrounding lines, or end the block with >>>>>>> REPLACE ALL.`);
    }
    return all ? out.split(oldStr).join(newStr) : out.slice(0, at[0]) + newStr + out.slice(at[0] + oldStr.length);
  }
}

// A render loop throws the same error hundreds of times; it is one error, and the count says it repeats.
// Each run loads the same page, so an error's count is the most any one run saw.
function countRepeats(...runs) {
  const counts = new Map();
  for (const errors of runs) {
    const own = Map.groupBy(errors, e => e);
    for (const [e, seen] of own) counts.set(e, Math.max(counts.get(e) ?? 0, seen.length));
  }
  return [...counts].map(([e, n]) => n > 1 ? `×${n} ${e}` : e);
}

// #region Pre-flight: what can be known about a page before it runs

// Inline scripts as the HTML parser splits them: each ends at the first closing tag, even one inside a string.
const JS_TYPES = /^(|text\/javascript|application\/javascript|module)$/i;
function scriptsOf(html) {
  const scripts = [];
  const open = /<script\b([^>]*)>/gi;
  for (let m; (m = open.exec(html)); ) {
    const start = m.index + m[0].length;
    const close = html.slice(start).search(/<\/script/i);
    const end = close < 0 ? html.length : start + close;
    const type = /\btype\s*=\s*["']?([^"'\s>]*)/i.exec(m[1])?.[1] ?? "";
    if (!/\bsrc\s*=/i.test(m[1]) && JS_TYPES.test(type)) scripts.push({ start, end, module: /^module$/i.test(type), code: html.slice(start, end) });
    open.lastIndex = end;
  }
  return scripts;
}

let acornLoad;
const loadAcorn = () => acornLoad ??= import(`${CDN.acorn}/dist/acorn.mjs`).catch(() => (acornLoad = null));

// The parse error, or null. Script and module differ: a classic script can't use import or top-level await.
function parseError(acorn, code, module) {
  try { acorn.parse(code, { ecmaVersion: "latest", sourceType: module ? "module" : "script", allowHashBang: true }); return null; }
  catch (e) { return e; }
}

// A script cut short by a closing tag in one of its strings parses again once that tag is written <\/script>.
// Tried over the next few tags; kept only if the joined script parses, so a real syntax error is never "fixed".
function escapeCloseTags(acorn, html, script) {
  let end = script.end;
  for (let k = 0; k < 5; k++) {
    const next = html.slice(end + 1).search(/<\/script/i);
    if (next < 0) return null;
    end = end + 1 + next;
    const joined = html.slice(script.start, end);
    const escaped = joined.replace(/<\/(script)/gi, "<\\/$1");
    if (!parseError(acorn, escaped, script.module)) {
      const lines = [...joined.matchAll(/<\/script/gi)].map(m => lineAt(html, script.start + m.index));
      return { html: html.slice(0, script.start) + escaped + html.slice(end), lines };
    }
  }
  return null;
}

// Named imports from URLs, checked against what each module really exports (loaded once in the code sandbox, by run).
// Only literal URLs: a module named through an importmap imports names the sandbox has no map for.
const exportsCache = new Map();
async function importFindings(acorn, scripts, html, run) {
  const found = [];
  if (!run) return found;
  for (const s of scripts.filter(s => s.module)) {
    let ast;
    try { ast = acorn.parse(s.code, { ecmaVersion: "latest", sourceType: "module", locations: true }); } catch { continue; }
    for (const node of ast.body.filter(n => n.type === "ImportDeclaration" && n.specifiers.length)) {
      const url = node.source.value;
      if (!/^https:\/\//.test(url)) continue;
      if (!exportsCache.has(url)) exportsCache.set(url, run({ source: `console.log(JSON.stringify(Object.keys(await import(${JSON.stringify(url)}))))`, timeout: 15 })
        .then(r => { try { return JSON.parse(r.logs?.[0]); } catch { return null; } }, () => null));
      const names = await exportsCache.get(url);
      if (!names) continue; // it didn't load; the run reports that
      const line = lineAt(html, s.start) + node.loc.start.line - 1;
      for (const spec of node.specifiers) {
        const name = spec.type === "ImportDefaultSpecifier" ? "default" : spec.type === "ImportSpecifier" ? spec.imported.name ?? spec.imported.value : null;
        if (name && !names.includes(name)) found.push(`L${line}: ${node.source.value} has no ${name === "default" ? "default export" : `export named ${name}`}; it exports: ${names.slice(0, 30).join(", ")}${names.length > 30 ? ", …" : ""}`);
      }
    }
  }
  return found;
}

// An id looked up by a literal and never written anywhere else in the file: no element will have it.
function missingIds(html, scripts) {
  const found = [];
  for (const s of scripts) {
    for (const m of s.code.matchAll(/(?:getElementById\(\s*|querySelector(?:All)?\(\s*)(["'`])#?([\w-]+)\1\s*\)/g)) {
      const id = m[2];
      if (!m[0].includes("getElementById") && !m[0].includes("#")) continue;
      const uses = html.split(new RegExp(`(?<![\\w-])${id.replace(/-/g, "\\-")}(?![\\w-])`)).length - 1;
      const lookups = html.split(new RegExp(`(?:getElementById\\(\\s*|querySelector(?:All)?\\(\\s*)["'\`]#?${id.replace(/-/g, "\\-")}["'\`]`)).length - 1;
      if (uses === lookups && !found.some(f => f.includes(`#${id} `))) found.push(`L${lineAt(html, s.start + m.index)}: #${id} is looked up but never created`);
    }
  }
  return found.slice(0, 3);
}

// A page runs in its folder, so a relative URL loads the workspace file at that path. One that names no file fails
// with a bare "module import failed", or not at all for a stylesheet; this names it, from the page down through the
// modules it imports. A root URL (/app.js) leaves the folder for the chat app's own server.
// read(path) gives a workspace file's text, or null.
async function missingFiles(path, text, read) {
  const acorn = await loadAcorn();
  const found = [], seen = new Set([path]);
  const local = url => !/^([a-z][a-z\d+.-]*:|\/\/|#)/i.test(url);
  const resolve = (from, url) => decodeURIComponent(new URL(url, "http://ws/" + from).pathname.slice(1));
  const check = (from, line, url) => {
    if (!local(url)) return;
    const where = from === path ? `L${line}` : `${from} L${line}`;
    if (url.startsWith("/")) return found.push(`${where}: ${url} is a root URL: it loads from the chat app's server, not this folder. Write it relative (.${url}).`);
    const target = resolve(from, url);
    if (read(target) == null) return found.push(`${where}: ${url} is not in the workspace (${target}). Write the file, or fix the path.`);
    if (/\.m?js$/.test(target) && !seen.has(target)) { seen.add(target); imports(target, read(target), 1); }
  };
  const imports = (from, code, first) => {
    let ast;
    try { ast = acorn?.parse(code, { ecmaVersion: "latest", sourceType: "module", locations: true }); } catch { return; }
    for (const node of ast?.body ?? []) {
      const url = node.source?.value;
      if (typeof url === "string" && /^\.{0,2}\//.test(url)) check(from, first + node.loc.start.line - 1, url);
    }
  };
  if (/\.m?js$/.test(path)) imports(path, text, 1);
  else {
    const scripts = scriptsOf(text);
    const outside = scripts.reduceRight((h, s) => h.slice(0, s.start) + " ".repeat(s.end - s.start) + h.slice(s.end), text);
    for (const m of outside.matchAll(/<(script|link)\b[^>]*>/gi)) {
      if (m[1].toLowerCase() === "link" && !/\brel\s*=\s*["']?(stylesheet|modulepreload)/i.test(m[0])) continue;
      const url = /\b(?:src|href)\s*=\s*["']?([^"'\s>]+)/i.exec(m[0])?.[1];
      if (url) check(path, lineAt(text, m.index), url);
    }
    for (const s of scripts.filter(s => s.module)) imports(path, s.code, lineAt(text, s.start));
  }
  return found.slice(0, 3);
}

// Returns the text to commit (with any proven fix), fixes made, errors that stop the run, and notes.
// run: the code tool's runner, for the imports check.
async function preflight(path, text, { run = null } = {}) {
  const empty = { text, fixes: [], errors: [], notes: [] };
  const js = /\.m?js$/i.test(path);
  if (!isHtml(path) && !js) return empty;
  const acorn = await loadAcorn();
  if (!acorn) return empty;
  const describe = (e, line, lines) => `L${line}:${e.loc.column + 1} ${e.message.replace(/ \(\d+:\d+\)$/, "")}: ${lines[line - 1]?.trim().slice(0, 160)}`;
  if (js) {
    // A .js file may be either kind; it is broken only if it is neither, and the module error says more.
    const e = parseError(acorn, text, false) && parseError(acorn, text, true);
    return e ? { ...empty, errors: [describe(e, e.loc.line, text.split(/\r?\n/))] } : empty;
  }
  let html = text;
  const fixes = [], errors = [];
  for (let i = 0; i < 20; i++) {
    const script = scriptsOf(html).find(s => !errors.some(e => e.start === s.start) && parseError(acorn, s.code, s.module));
    if (!script) break;
    const fixed = escapeCloseTags(acorn, html, script);
    if (fixed) { html = fixed.html; fixes.push(`L${fixed.lines.join(", L")}: <\/script> inside a string would end the script; wrote <\\/script>.`); continue; }
    const e = parseError(acorn, script.code, script.module);
    const line = lineAt(html, script.start) + e.loc.line - 1;
    // The await in the wrong place is the commonest of these; the error says where, not why.
    const why = !script.module && !parseError(acorn, script.code, true) ? ". This <script> is classic: top-level await and import need <script type=\"module\">"
      : /await/.test(e.message) ? ". The function around this await is not async; a test's is test(\"name\", async () => { … })" : "";
    errors.push({ start: script.start, text: describe(e, line, html.split(/\r?\n/)) + why });
  }
  if (errors.length) return { text: html, fixes, errors: errors.map(e => e.text), notes: [] };
  const scripts = scriptsOf(html);
  return { text: html, fixes, errors: [], notes: [...(await importFindings(acorn, scripts, html, run)), ...missingIds(html, scripts)] };
}

// #endregion

function changeSummary(before, after) {
  let added = 0, removed = 0, line = 1, first = null, last = null;
  for (const part of diffLines(before ?? "", after)) {
    const n = part.count || 0;
    if (part.added) { added += n; first ??= line; last = line + n - 1; line += n; }
    else if (part.removed) { removed += n; first ??= line; last = Math.max(last ?? line, line); }
    else line += n;
  }
  return `+${added} -${removed}` + (first ? ` (L${first}-${last})` : "");
}

// Workspace tools

async function attempt(fn) {
  try { return await fn(); }
  catch (e) { return { error: e?.message || String(e) }; }
}

async function workspaceFor(context, { create = false } = {}) {
  const ws = context.workspace;
  if (!ws) throw new Error("No workspace is available here.");
  ws.setContext({ threadId: context.threadId, agentId: context.agentId });
  if (!ws.state.project) {
    if (!create) throw new Error("No project is open yet. Create the app with write_file.");
    await ws.ensureProject({ agentId: context.agentId, threadId: context.threadId });
  }
  return ws;
}

// Files a tool hands back as themselves, beside its JSON: an image the model sees, a PDF it reads. Each kind has the
// largest size Bedrock takes; Claude and Gemini read both inside a tool result, Sol and Luna see images beside it.
const MEDIA = { png: ["image", 3.75e6], jpeg: ["image", 3.75e6], gif: ["image", 3.75e6], webp: ["image", 3.75e6], pdf: ["document", 4.5e6] };
const withMedia = (result, ...files) => (files = files.filter(Boolean)).length ? { ...result, __media: files } : result;
const mediaBlock = ({ format, bytes, name }) => MEDIA[format][0] === "image"
  ? { image: { format, source: { bytes } } }
  // Bedrock allows a document name letters, digits, single spaces, hyphens, parentheses, and brackets.
  : { document: { format, name: (name || "document").replace(/[^A-Z0-9 \-()[\]]+/gi, "-").replace(/\s+/g, " ").trim().slice(0, 200) || "document", source: { bytes } } };

// A binary file in resources (a screenshot, a PDF), read as itself.
async function viewResource(path, blob) {
  const format = { "image/jpg": "jpeg" }[blob.type] ?? blob.type.split("/")[1] ?? "";
  if (!Object.hasOwn(MEDIA, format)) return { error: `${path} is ${blob.type || "binary"}, which can't be viewed. Read it in code: resources.read gives a Blob.` };
  if (blob.size > MEDIA[format][1]) return { error: `${path} is ${blob.size} bytes, more than a ${format} can be (${MEDIA[format][1]}). Shrink it in code first.` };
  return withMedia({ path, type: blob.type, size: blob.size }, { format, bytes: new Uint8Array(await blob.arrayBuffer()), name: path.split("/").pop().replace(/\.\w+$/, "") });
}

// A file that doesn't parse gets its errors without a run: loading it would only say the same, slower.
async function finishChange(ws, { version, change, notes, checked }, screenshot, signal) {
  const result = { version: version.id, path: version.path, change, ...(notes?.length && { notes }) };
  if (checked?.errors.length)
    return { ...result, report: { version: version.id, path: version.path, ok: false, errors: checked.errors, notes: ["Not run: the file does not parse. Fix these first."] } };
  // The spec is the agent's notes on the work, not the work: the panel keeps showing the artifact.
  if (version.path === "SPEC.md") return result;
  const scratch = isScratch(version.path);
  // A module, stylesheet or data file reports through the page that loads it: the shown one.
  const page = scratch || await ws.show(version.path) || isHtml(ws.shownPath() ?? "");
  if (scratch ? !isHtml(version.path) : !page) return result;
  const { report, image } = await ws.run({ versionId: scratch ? version.id : null, screenshot: screenshot ?? "auto", signal });
  const found = checked?.notes ?? [];
  return withMedia({ ...result, report: found.length ? { ...report, notes: [...found, ...(report.notes ?? [])] } : report }, image);
}

// Matching lines with numbers, and `context` lines around each; runs apart are split by "--".
// Lines come as the file has them, indentation included, so they can go straight into a SEARCH block.
function grepLines(lines, pattern, context = 0, limit = Infinity) {
  const hits = lines.flatMap((line, i) => pattern.test(line) ? [i] : []);
  const shown = new Set(hits.slice(0, limit).flatMap(i => Array.from({ length: 2 * context + 1 }, (_, k) => i - context + k)).filter(i => i >= 0 && i < lines.length));
  const out = [];
  let last = -1;
  for (const i of [...shown].sort((a, b) => a - b)) {
    if (context && last >= 0 && i > last + 1) out.push("--");
    out.push(numberedLine(i + 1, lines[i]));
    last = i;
  }
  return { hits: hits.length, out };
}

const GREP_LIMIT = 100;

// A file not in the project may be one only a variant or a part made: where it is, and how to take it.
async function missingFile(ws, file, context) {
  const project = context.db && await context.db.get("projects", ws.state.project.id);
  const found = Object.entries(project?.branches ?? {}).map(([name, b]) => [name, b.heads?.[file]]).filter(([, id]) => id);
  if (!found.length) return `File not found: ${file}. Create it with write_file.`;
  const [name, id] = found.reduce((a, b) => (b[1] > a[1] ? b : a));
  return `${file} is only on a ${name.startsWith("part-") ? "part" : "variant"}'s branch, at v${id}, not in your files: run_app { "version": ${id} } shows it, restore { "version": ${id} } makes it yours.`;
}

async function viewFile({ path, start, end, grep, context: around = 0 } = {}, context = {}) {
  return attempt(async () => {
    const ws = await workspaceFor(context);
    let pattern;
    if (grep) try { pattern = new RegExp(grep, "i"); } catch (e) { return { error: `Invalid grep pattern: ${e.message}` }; }
    around = Math.min(Math.max(0, around | 0), 10);
    if (path?.endsWith("/")) {
      const files = await ws.listFiles(normalizePath(path));
      if (!pattern) return files.length ? files.join("\n") : "(no files)";
      // Every text file under the folder, grouped by file.
      const parts = [];
      let total = 0;
      for (const file of files) {
        const text = await ws.readFile(file);
        if (typeof text !== "string" || text.includes("\0")) continue;
        const { hits, out } = grepLines(text.split(/\r?\n/), pattern, around, Math.max(0, GREP_LIMIT - total));
        if (hits && total < GREP_LIMIT) parts.push(`${file}: ${hits} matching\n${out.join("\n")}`);
        total += hits;
      }
      const more = total > GREP_LIMIT ? `\n… ${total - GREP_LIMIT} more; narrow the pattern or the folder` : "";
      return parts.length ? `${total} matching in ${parts.length} file${parts.length > 1 ? "s" : ""}\n\n${parts.join("\n\n")}${more}` : `No matches in ${files.length} files.`;
    }
    const file = normalizePath(path || ws.shownPath() || ws.state.project.entry);
    const text = await ws.readFile(file);
    if (text == null) {
      const binary = context.db && (await resourceStore(context).get(file));
      if (binary?.content instanceof Blob) return viewResource(file, binary.content);
      return { error: await missingFile(ws, file, context) };
    }
    const lines = text.split(/\r?\n/);
    const head = ws.state.project.heads[file];
    const header = `${file}${head ? ` v${head}` : " (folder only)"}: ${lines.length} lines`;
    if (pattern) {
      const { hits, out } = grepLines(lines, pattern, around, GREP_LIMIT);
      const more = hits > GREP_LIMIT ? `\n… ${hits - GREP_LIMIT} more; narrow the pattern` : "";
      return `${header}, ${hits} matching\n${out.join("\n")}${more}`;
    }
    if (start == null && end == null && lines.length > 400)
      return `${header}. Outline (view ranges with start/end, or grep):\n${outline(lines).join("\n")}`;
    // start with context and no end is a look around one line: Gemini asked for it ten times a run and got 800 lines each.
    const near = start != null && end == null && around > 0;
    const from = Math.max(1, near ? start - around : start ?? 1);
    const last = near ? Math.min(start + around, lines.length) : end == null || end === -1 ? lines.length : Math.min(end, lines.length);
    // A start alone in a big file is a look at a place, not the rest of the file: Gemini paged 3000 lines 800 at a time.
    const span = end == null && lines.length > 400 ? 200 : 800;
    const to = Math.min(last, from + span - 1);
    const more = to < last ? `\n… showing ${span} lines; view start=${to + 1} for more, or grep for what you're after` : "";
    return `${header}, showing ${from}-${to}\n${lines.slice(from - 1, to).map((l, i) => numberedLine(from + i, l)).join("\n")}${more}`;
  });
}

const codeRunner = ({ host, threadId, agentId, signal }) => host && (input => host.code({ input, threadId, agentId, projectId: null }, { signal }));

async function editFile({ path, patch, screenshot } = {}, context = {}) {
  return attempt(async () => {
    if (typeof patch !== "string") throw new Error("patch is required:\n" + PATCH_FORMAT);
    const edits = parsePatch(patch);
    const ws = await workspaceFor(context);
    const file = normalizePath(path || ws.shownPath() || ws.state.project.entry);
    const committed = await ws.exclusive(async () => {
      const before = await ws.readFile(file);
      if (before == null) throw new Error(await missingFile(ws, file, context));
      const notes = [];
      let edited;
      try { edited = applyEdits(before, edits, { notes }); }
      catch (e) {
        // Without a path the edit goes to the shown file; the text may be in the one the agent meant.
        const elsewhere = Object.entries(ws.state.files).filter(([p, text]) => p !== file && edits.every(edit => text.includes(edit.old_str))).map(([p]) => p);
        throw elsewhere.length === 1 ? new Error(`${e.message}\nThis edit went to ${file}; its text is in ${elsewhere[0]}. Pass "path": "${elsewhere[0]}".`) : e;
      }
      if (edited === before) throw new Error("The edits leave the file unchanged.");
      const checked = await preflight(file, edited, { run: codeRunner(context) });
      const { version } = await ws.commit(file, checked.text, { source: "agent", toolUseId: context.toolUseId });
      return { version, change: changeSummary(before, checked.text), notes: [...notes, ...checked.fixes], checked };
    });
    return finishChange(ws, committed, screenshot, context.signal);
  });
}

async function writeFile({ path, content, screenshot } = {}, context = {}) {
  return attempt(async () => {
    if (typeof content !== "string") return { error: "content must be a string" };
    const ws = await workspaceFor(context, { create: true });
    const file = normalizePath(path || ws.shownPath() || ws.state.project.entry);
    const committed = await ws.exclusive(async () => {
      const before = await ws.readFile(file);
      const checked = await preflight(file, content, { run: codeRunner(context) });
      const { version, changed } = await ws.commit(file, checked.text, { source: "agent", toolUseId: context.toolUseId });
      // A big file sent back mostly as it was cost every line it kept; the next change is an edit.
      const lines = before?.split("\n").length ?? 0;
      const kept = lines > 40 ? diffLines(before, checked.text).filter(p => !p.added && !p.removed).reduce((n, p) => n + p.count, 0) : 0;
      const rewrote = kept > lines / 2 ? [`Rewrote ${file} to keep ${kept} of its ${lines} lines: edit it instead, and send only what changes.`] : [];
      return { version, change: changed ? changeSummary(before, checked.text) : "unchanged", notes: [...checked.fixes, ...rewrote], checked };
    });
    return finishChange(ws, committed, screenshot, context.signal);
  });
}

async function runApp({ path, version, viewport, script, screenshot = true } = {}, context = {}) {
  return attempt(async () => {
    const ws = await workspaceFor(context);
    if (viewport && viewport !== "fit" && !Object.hasOwn(VIEWPORTS, viewport)) viewport = null;
    // A version names its own file, a variant's on its branch too; path picks the current one.
    const head = path && version == null && ws.state.project.heads[normalizePath(path)];
    if (path && version == null && !head) return { error: await missingFile(ws, normalizePath(path), context) };
    const { report, image } = await ws.run({ versionId: version ?? head ?? null, script: script || null, screenshot, viewport, signal: context.signal });
    return withMedia({ report }, image);
  });
}

async function listHistory({ path, limit = 20 } = {}, context = {}) {
  return attempt(async () => {
    const ws = await workspaceFor(context);
    const heads = ws.state.project.heads;
    const versions = await ws.listVersions({ path, limit: Math.min(Math.max(1, limit), 100) });
    if (!versions.length) return "(no versions)";
    const project = !ws.branch && context.db && await context.db.get("projects", ws.state.project.id);
    // What a variant made, not the files it started from.
    const branched = new Set(Object.values(project?.branches ?? {}).flatMap(b => Object.entries(b.heads ?? {}).filter(([p, id]) => b.base?.[p] !== id).map(([, id]) => id)));
    const rows = versions.map(v => [
      `v${v.id}${heads[v.path] === v.id ? "*" : branched.has(v.id) ? "~" : ""}`, v.path, v.source + (v.restoredFrom ? ` of v${v.restoredFrom}` : ""),
      timeAgo(v.createdAt), `${v.lines} lines`, summarizeReport(v.report),
    ].join("  "));
    return rows.join("\n") + `\n(* = current${branched.size ? ", ~ = a sub-agent's, not yours until restored" : ""})`;
  });
}

async function diffVersions({ from, to } = {}, context = {}) {
  return attempt(async () => (await workspaceFor(context)).diff(from, to ?? null));
}

async function restoreVersion({ version } = {}, context = {}) {
  return attempt(async () => {
    const ws = await workspaceFor(context);
    const { version: restored, changed, before, text } = await ws.restore(version, { toolUseId: context.toolUseId });
    if (!changed) return { version: restored.id, path: restored.path, change: `unchanged; v${version} is already current` };
    return finishChange(ws, { version: restored, change: `${changeSummary(before, text)}, restored v${version}` }, undefined, context.signal);
  });
}

// #endregion

// #region 7. UTILITIES
// =============================================================================
// Incremental JSON parser and tree/branching utilities.
// =============================================================================

/**
 * Parses a JSON string incrementally, returning partial results for incomplete inputs.
 * Essential for streaming responses where JSON arrives in chunks.
 */
function parseJSON(input) {
  if (typeof input !== "string") return input;
  const jsonString = input.trim();
  if (jsonString === "") return null;

  let index = 0;
  const LITERALS = { true: true, false: false, null: null, NaN: NaN, Infinity: Infinity, "-Infinity": -Infinity };

  function skipWhitespace() {
    while (index < jsonString.length && " \n\r\t".includes(jsonString[index])) index++;
  }

  function parseValue() {
    skipWhitespace();
    if (index >= jsonString.length) throw new Error("Unexpected end of input");

    const char = jsonString[index];
    if (char === "{") return parseObject();
    if (char === "[") return parseArray();
    if (char === '"') return parseString();

    const remainingText = jsonString.substring(index);
    for (const [key, value] of Object.entries(LITERALS)) {
      if (jsonString.startsWith(key, index)) {
        const endPos = index + key.length;
        if (endPos === jsonString.length || ",]} \n\r\t".includes(jsonString[endPos])) {
          index = endPos;
          return value;
        }
      }
      if (key.startsWith(remainingText)) {
        index = jsonString.length;
        return value;
      }
    }

    if (char === "-" || (char >= "0" && char <= "9")) return parseNumber();
    throw new Error(`Unexpected token '${char}' at position ${index}`);
  }

  function parseArray() {
    index++;
    const arr = [];
    while (index < jsonString.length && jsonString[index] !== "]") {
      try {
        arr.push(parseValue());
        skipWhitespace();
        if (jsonString[index] === ",") index++;
        else if (jsonString[index] !== "]") break;
      } catch (e) { return arr; }
    }
    if (index < jsonString.length && jsonString[index] === "]") index++;
    return arr;
  }

  function parseObject() {
    index++;
    const obj = {};
    while (index < jsonString.length && jsonString[index] !== "}") {
      try {
        skipWhitespace();
        if (jsonString[index] !== '"') break;
        const key = parseString();
        skipWhitespace();
        if (index >= jsonString.length || jsonString[index] !== ":") break;
        index++;
        obj[key] = parseValue();
        skipWhitespace();
        if (jsonString[index] === ",") index++;
        else if (jsonString[index] !== "}") break;
      } catch (e) { return obj; }
    }
    if (index < jsonString.length && jsonString[index] === "}") index++;
    return obj;
  }

  function parseString() {
    if (jsonString[index] !== '"') throw new Error("Expected '\"' to start a string");
    const startIndex = index;
    index++;
    let escape = false;
    while (index < jsonString.length) {
      if (jsonString[index] === '"' && !escape) {
        const fullString = jsonString.substring(startIndex, ++index);
        return JSON.parse(fullString);
      }
      escape = jsonString[index] === "\\" ? !escape : false;
      index++;
    }
    const partialStr = jsonString.substring(startIndex);
    try {
      return JSON.parse(partialStr + '"');
    } catch (e) {
      const lastBackslash = partialStr.lastIndexOf("\\");
      if (lastBackslash > 0) return JSON.parse(partialStr.substring(0, lastBackslash) + '"');
      return partialStr.substring(1);
    }
  }

  function parseNumber() {
    const startIndex = index;
    const numberChars = "0123456789eE.+-";
    while (index < jsonString.length && numberChars.includes(jsonString[index])) index++;
    const numStr = jsonString.substring(startIndex, index);
    if (!numStr) throw new Error("Empty number literal");
    try { return parseFloat(numStr); }
    catch (e) {
      if (numStr.length > 1) return parseFloat(numStr.slice(0, -1));
      throw e;
    }
  }

  return parseValue();
}

// Tree/Branching utilities

export function buildMessageTree(messages) {
  const nodes = new Map();
  const rootIds = [];

  for (const msg of messages) {
    nodes.set(msg.id, { message: msg, childIds: [] });
  }

  for (const msg of messages) {
    if (msg.parentId === null || msg.parentId === undefined) {
      rootIds.push(msg.id);
    } else if (nodes.has(msg.parentId)) {
      nodes.get(msg.parentId).childIds.push(msg.id);
    }
  }

  for (const [_, node] of nodes) {
    node.childIds.sort((a, b) => nodes.get(a).message.createdAt - nodes.get(b).message.createdAt);
  }
  rootIds.sort((a, b) => nodes.get(a).message.createdAt - nodes.get(b).message.createdAt);

  return { rootIds, nodes };
}

export function getMostRecentPath(tree) {
  if (tree.rootIds.length === 0) return [];
  const path = [];
  let currentId = tree.rootIds[tree.rootIds.length - 1];

  while (currentId !== undefined) {
    path.push(currentId);
    const node = tree.nodes.get(currentId);
    if (!node || node.childIds.length === 0) break;
    currentId = node.childIds[node.childIds.length - 1];
  }
  return path;
}

export function getSiblings(tree, messageId) {
  const node = tree.nodes.get(messageId);
  if (!node) return [messageId];
  const parentId = node.message.parentId;
  if (parentId === null || parentId === undefined) return tree.rootIds;
  const parentNode = tree.nodes.get(parentId);
  return parentNode ? parentNode.childIds : [messageId];
}

export function getPathToMessage(tree, messageId) {
  const path = [];
  let currentId = messageId;
  while (currentId !== null && currentId !== undefined) {
    path.unshift(currentId);
    const node = tree.nodes.get(currentId);
    if (!node) break;
    currentId = node.message.parentId;
  }
  return path;
}

export function extendPath(tree, path) {
  if (path.length === 0) return [];
  const extended = [...path];
  let currentId = extended[extended.length - 1];

  while (true) {
    const node = tree.nodes.get(currentId);
    if (!node || node.childIds.length === 0) break;
    currentId = node.childIds[node.childIds.length - 1];
    extended.push(currentId);
  }
  return extended;
}

// #endregion

// #region 8. WORKER
// In a SharedWorker, each tab that connects is served.
if (inSharedWorker) {
  onconnect = event => serve(event.ports[0]);
  early.splice(0).forEach(serve);
}
// #endregion

export {
  CAPTURE_CHOICE_KEY, CDN, DEFAULT_MODEL, LOCAL_PROXY, MEMORY_BUDGET, MODELS, PROTOCOL, PROXY_CONFIG_KEY, TOOLS,
  VIEWPORTS, WORKSPACE_TOOL_NAMES, appendReasoning, applyEdits, blobCache, countLines, countRepeats, createWorkspace,
  editFile, editor, ensureDefaultAgent, escapeHtml, failingReport, forkOf, getBlob, getConverseClient,
  getConverseCommand, getProxyConfig, getToolResults, initDB, inspectArgs, isHtml, isRenderable, isScratch,
  listHistory, mcp, memoriesBlock, missingFiles, modelInfo, normalizePath, outline, overlap, ownedTools, parseJSON,
  parsePatch, plainError, polishedTake, preflight, prepareMessages, processStreamChunk, providerOf, proxyFetch,
  proxyRewrite, readUrl, reasoningFields, reasoningLevel, relayUrl, restoreVersion, runAgentWithBranching, runApp,
  runningSubagents, sameView, sandboxFiles, sandboxResources, serve, setSubagent, siblingFiles, silentReply, sleep,
  snapshotSettings, storedProxyConfig, summarizeReport, systemPrompt, task, think, timeAgo, toDocument, toError,
  toResultValue, unadoptedVariants, unmuteScripts, untestedChange, viewFile, watchedSend, webSearch, writeFile,
};
