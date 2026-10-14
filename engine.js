// The engine: chats, their runs, the model clients, the tools, and the projects they change. One engine serves every
// tab of the app from a SharedWorker; where there is none, it runs in the tab, over the same port. index.html is its
// presentation: it shows what the engine sends, and runs what only a tab can (frames, screenshots, code).

// #region 1. IMPORTS & DEFINITIONS
import {
  DEFAULT_PROMPT, DELEGATING, ENVIRONMENT, EXPLORE_PROMPT, FETCH_DIRECT, FETCH_PROXIED, FORK_BRIEF, FRONTEND_SKILL,
  GENERAL_PROMPT, HARNESS_DOCUMENTATION, NETWORK, PART_BRIEF, PART_REVIEW, PART_REVIEW_NOTE, PARTS_REVIEW, PARTS_REVIEW_NOTE, PLAN_PROMPT, REVIEW_PROMPT, SHELL_ABSENT, SHELL_PRESENT,
  SUMMARY_PROMPT, TASK_ASYNC, TOOL_DOCUMENTATION, VARIANT_BRIEF, WORKING,
} from "./prompts.js";
import {
  STOP_MAX, STEER_MAX, delivered, envelopeGuide, isoLocal, localDate, note, renderTurn, sameClient, steer, timing,
} from "./envelope.js";
import {
  MemoryObserver, connectGitHub, createFolderRoot, createGitHubRoot, isBinaryPath, isMemoryDirectory, liveHandle, storableHandle,
} from "./projects.js";
import { BASH_TOOL_SPEC, createShellTool } from "./shell/tool.js";
// The tab's half, for index.html: it loads only this file.
export { createShellHost } from "./shell/host.js";

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
  bootstrap: "5.3.8", "bootstrap-icons": "1.13.2", diff: "5.2.2", dompurify: "3.4.16", idb: "8.0.4", "isomorphic-git": "1.44.2", mammoth: "1.13.0",
  marked: "15.0.12", "modern-screenshot": "4.7.0", "pdfjs-dist": "6.3.289", "solid-js": "1.9.17", tcpipe: "1.0.0",
  turndown: "7.2.4", "turndown-plugin-gfm": "1.0.2",
}).map(([name, version]) => [name, `https://cdn.jsdelivr.net/npm/${name}@${version}`]));

// A tab shares its Solid with the engine, so the UI tracks the stores the engine makes. A worker has no import map
// and no UI: it takes the store from the CDN, and has nothing to batch. A worker whose imports fail refuses every
// tab that connects, and goes: the next tab starts a new one.
const [{ openDB }, { createTwoFilesPatch, diffLines }, { createStore, produce, reconcile, unwrap }, batch] = await Promise.all([
  import(`${CDN.idb}/+esm`), import(`${CDN.diff}/+esm`),
  import(inSharedWorker ? `${CDN["solid-js"]}/store/+esm` : "solid-js/store"),
  inSharedWorker ? fn => fn() : import("solid-js").then(m => m.batch),
]).catch(e => {
  if (!inSharedWorker) throw e;
  const refuse = port => port.postMessage({ type: "refused", reason: `The engine failed to start: ${e.message}` });
  onconnect = event => refuse(event.ports[0]);
  early.splice(0).forEach(refuse);
  close();
  return new Promise(() => {});
});

// A prompt's {name} placeholders, filled. Values go in as they are: none is read as a replacement pattern.
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (match, name) => values[name] ?? match);

// Assembled per request, and the same for the whole conversation: the agent's own prompt and memories, then how
// this harness works, for the tools it has. started: the day the conversation began (the thread's, taken once, like
// its memories), so the cached prefix never changes; a later day travels in each message's timestamp
// (docs/specs/2026-10-13-envelope.md). Haiku answers a changed system prompt with thinking sent back with a 400.
function systemPrompt(persona, { tools = [], memories = null, modelId = null, started = null } = {}) {
  const changes = flag("envelope", "xml") === "xml" ? "<changes> block" : "<workspace> block";
  const guide = TOOL_DOCUMENTATION.split(/\n(?=### )/).filter(part => !part.startsWith("### ") || tools.includes(part.match(/^### (\w+)/)[1]))
    // subagents=async: the task section says how results come back.
    .map(part => part.startsWith("### task") && flag("subagents") === "async" ? part.trimEnd() + "\n" + TASK_ASYNC : part);
  const artifacts = tools.some(name => WORKSPACE_TOOL_NAMES.includes(name)) && fill(HARNESS_DOCUMENTATION, { changes });
  const delegating = artifacts && tools.includes("task") && DELEGATING;
  const network = relayUrl() && fill(NETWORK, { relay: relayUrl(), tcpipe: CDN.tcpipe });
  const cutoff = MODELS.find(m => m.id === modelId)?.cutoff;
  const environment = fill(ENVIRONMENT, {
    fetch: getProxyConfig()?.endpoint ? FETCH_PROXIED : FETCH_DIRECT,
    started: started ?? localDate(Date.now()),
    cutoff: cutoff ? ` What you know comes from data up to ${cutoff}.` : "",
    shell: tools.includes("bash") ? SHELL_PRESENT : SHELL_ABSENT,
  });
  const working = fill(WORKING, { changes }) + (planInPrompt(tools) ?? "");
  const envelope = envelopeGuide({ envelope: flag("envelope", "xml"), metadata: flag("metadata", "minimal") });
  return [persona, memories, environment, envelope, working, delegating, guide.join("\n"), artifacts, network].filter(Boolean).join("\n");
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
const WORKSPACE_TOOL_NAMES = ["view_file", "edit_file", "write_file", "run_app", "bash", "history", "diff", "restore"];
// A fork reads and reports; changes and further sub-agents stay with the caller.
const FORK_REFUSES = ["task", "edit_file", "write_file", "restore"];
const VARIANT_REFUSES = ["task"];
const PATH_PROPERTY = { type: "string", description: "File path, e.g. index.html, notes.md, logo.svg. Defaults to the shown artifact." };
const SCREENSHOT_PROPERTY = { type: "boolean", description: "true forces a screenshot, false skips it. By default one is attached when the user lets you see the page and it changed." };
// The harness runs test, probe, file, source and command checks itself; the other kinds are named so a plan can hold them.
const CHECK_KINDS = ["test", "probe", "file", "source", "command", "compute", "consistency", "judge", "user"];
const HARNESS_CHECKS = ["test", "probe", "file", "source", "command"];
const CHECK_SCHEMA = {
  type: "object",
  description: "How the harness tells the item is done",
  properties: {
    kind: { type: "string", enum: CHECK_KINDS, description: "test, probe, file, source and command are run by the harness" },
    run: { type: "string", description: "command: the bash command to run from /project, e.g. npm test" },
    exit: { type: "integer", description: "command: the exit code it must return (default 0)" },
    stdout: { type: "string", description: "command: text its output must contain" },
    file: { type: "string", description: "test, probe: the page to run (default: the shown one), or a test file it runs. file: the file to check" },
    name: { type: "string", description: "test: the name of a test that must be among those passing" },
    script: { type: "string", description: "probe: JS run in the page after it settles, true when the item is done, e.g. return app.items().length === 3" },
    exists: { type: "boolean", description: "file: false checks that it is gone (default true)" },
    contains: { type: "string", description: "file: text it must contain" },
    matches: { type: "string", description: "file: a regular expression it must match" },
    min_words: { type: "integer", description: "file: at least this many words" },
    max_words: { type: "integer", description: "file: at most this many words" },
    text: { type: "string", description: "source: a quote or number that must appear in a tool result in this chat. Other kinds: what to check" },
  },
  required: ["kind"],
};

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
  { id: "global.anthropic.claude-opus-5-5", label: "Opus 5.5", group: "AWS Bedrock", ...CLAUDE_5, cutoff: "June 2026" },
  { id: "global.anthropic.claude-sonnet-5-5", label: "Sonnet 5.5", group: "AWS Bedrock", ...CLAUDE_5 },
  // Haiku 5.5 takes 128k out, and thinking counts toward it: at 64k it thought through the whole budget twice (E15).
  { id: "global.anthropic.claude-haiku-5-5", label: "Haiku 5.5", group: "AWS Bedrock", ...CLAUDE_5, maxTokens: 128_000, context: 100_000, levels: ["off", ...CLAUDE_5.levels], off: { thinking: { type: "disabled" } } },
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
const modelInfo = id => {
  const info = { maxTokens: 32_000, window: 200_000, cache: true, documents: true, beside: false, ...(MODELS.find(m => m.id === id) ?? { id, ...(/anthropic/.test(id) && CLAUDE_BUDGET) }) };
  return { ...info, context: Math.min(Number(flag("context")) || (info.context ?? CONTEXT), info.window) };
};
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
const COMPACT_AT = 0.6; // share of the context budget that triggers a summary
// The context a request may use, whatever the model accepts: smaller requests are faster and keep attention on
// the work. A model can set its own (Haiku 5.5: 100k); a smaller window wins.
const CONTEXT = 256_000;

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
  return entry;
}
// What a running call has to show before its result (a command's output as it prints, a run's step), by its
// toolUseId: reportProgress(toolUseId, { stdout?, stderr?, status? }). The engine sends it on as tool.progress.
const progressListeners = new Set();
const reportProgress = (toolUseId, update) => progressListeners.forEach(fn => fn(toolUseId, update));

// The answer a tool result block carries.
// One delivered later (subagents=async) rides a note of the director's channel, and counts as its task's result
// once delivered (a capped copy is only the log's).
const resultOf = block => block?.toolResult?.content?.[0]?.json?.result
  ?? (block?.instruction?.status === "delivered" ? block.instruction.data?.subagent?.result : undefined);

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
            timeout: { type: "number", description: "Seconds before it is stopped, up to 60. Default 5, or 30 when the source uses fetch, import or web." },
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
    // The contract is the run's, kept by its director; a sub-agent reports to its caller instead.
    fn: (input, context) => context.director ? context.director.plan(input, context) : { error: "The plan is the main agent's. Report what you found in your final message instead." },
    toolSpec: {
      name: "plan",
      description: "The contract for long work, kept by the harness: the goal, assumptions, items each with a check the harness runs, notes with their sources, and questions for the user. Returns the current state. An item is done when the harness sees its check pass. The harness writes PLAN.md from it.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            goal: { type: "string", description: "The user's request in their words" },
            done: { type: "string", description: "What done means" },
            assumptions: { type: "array", items: { type: "string" }, description: "What you decided without asking, each one the user can correct" },
            add: { type: "object", description: "One item: { title, check }", properties: { title: { type: "string" }, check: CHECK_SCHEMA } },
            edit: { type: "integer", description: "The id of an item to change, with title or check; its old check stays in the ledger" },
            title: { type: "string", description: "With edit: the item's new title" },
            check: { ...CHECK_SCHEMA, description: "With edit: the item's new check" },
            note: { type: "string", description: "A fact learned, or a decision and its reason" },
            source: { type: "string", description: "With note: the URL or file it came from" },
            ask: { type: "string", description: "A question only the user can answer" },
          },
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
      description: "Re-render the shown artifact (or an older version) with its tests and return the run report. Optionally run an async script in the page after it settles; its return value is included. The screenshot shows the viewport, one screen; full: true returns the whole page, top to bottom, as pages (each up to two screens tall, labelled page N of M). A page taller than the screen is fine: look at it with full: true rather than changing its layout to fit one screen. On a test file or folder (test/index.test.js, test/), it runs the tests as node --test would (node:test, node:assert and the common runners work) and returns pass and fail counts.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            path: { type: "string", description: "A file to run instead of the shown artifact, e.g. a page under scratch/, or a test file, folder or glob (test/parse.test.js, test/, test/*.test.js)" },
            version: { type: "integer", description: "Version id to run instead of the current file, such as one a variant returned" },
            viewport: { type: "string", enum: ["fit", "desktop", "tablet", "mobile"], description: "Preview size. Wider than a phone, the screenshot has a phone's width beside it" },
            script: { type: "string", description: "Async function body run in the app page, e.g. document.querySelector('button').click(); return document.title" },
            screenshot: { type: "boolean", description: "Attach a screenshot of the viewport, what fits on one screen (default true; approximate when the user has not shared the tab)" },
            full: { type: "boolean", description: "Attach the whole page instead, scrolled top to bottom, as labelled pages up to two screens tall each" },
          },
        },
      },
    },
  },
  // The shell runs in a tab (shell/host.js); shell/tool.js keeps the sessions and commits what commands change.
  { fn: (input, context) => shellTool.bash(input, context), toolSpec: BASH_TOOL_SPEC },
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

const shellTool = createShellTool({ workspaceFor: (...a) => workspaceFor(...a), runApp: (...a) => runApp(...a) });

// A copy of this app run as an artifact (the chat, worked on in the chat) keeps a database of its own: its tests
// would otherwise write over the chats of the app it runs in.
const DB_NAME = /\/__ws\//.test(globalThis.location?.pathname ?? "") ? "chat-workspace" : "chat";
// The shell's own store, beside it: node_modules, .git, binary files (shell/store.js).
const SHELL_DB = DB_NAME + "-shell";

// One schema, no migrations: a database made by any other version starts over empty.
// blocking: a newer version wants to upgrade; the owner lets go of its work, then this connection closes.
// blocked: an older version still holds the database open.
const SCHEMA = { agents: [], threads: ["agentId"], messages: ["agentId", "threadId"], resources: ["agentId", "threadId"], projects: [], versions: ["projectId"] };
const DB_VERSION = 8;
async function initDB({ blocking = () => {}, blocked = () => {} } = {}) {
  const db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      for (const name of [...db.objectStoreNames]) db.deleteObjectStore(name);
      for (const [name, indexes] of Object.entries(SCHEMA)) {
        const store = db.createObjectStore(name, { keyPath: "id", autoIncrement: true });
        for (const index of indexes) store.createIndex(index, index);
      }
      db.createObjectStore("blobs", { keyPath: "hash" });
      // A root project's files as the harness first read them, before the journal holds them: { key: "projectId:path", hash }.
      db.createObjectStore("reads", { keyPath: "key" });
    },
    blocked,
    blocking() { blocking(); db.close(); blobCache.clear(); },
  });
  blobCache.clear();
  return db;
}

// A new database starts with one agent and its skill.
async function ensureDefaultAgent(db) {
  const tx = db.transaction(["agents", "resources"], "readwrite");
  if (await tx.objectStore("agents").get(1)) return;
  tx.objectStore("agents").put({ id: 1, name: "default", systemPrompt: DEFAULT_PROMPT, tools: ["code", "think", "plan", "editor", "mcp", "task"], mcpServers: [], resources: [] });
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
function createEngine(db, { tools = TOOLS, workspaces = null, host = null, client = modelClient } = {}) {
  const runs = new Map(); // threadId -> { store, setStore, controller, from, timer, release, leafId }
  const listeners = new Set();
  const emit = event => { event = structuredClone(event); listeners.forEach(fn => fn(event)); };
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

  // A sub-agent's entry goes out when it changes, every 50ms at most, with only the messages the tabs haven't had:
  // from is where they start. null is one that went.
  const changed = new Set(), told = new Map(); // toolUseId -> messages sent
  let subagentTimer = null;
  const watchSubagents = toolUseId => {
    changed.add(toolUseId);
    subagentTimer ??= setTimeout(() => {
      subagentTimer = null;
      emit({ type: "subagents", entries: [...changed].map(id => {
        const entry = subagents.get(id);
        if (!entry) return told.delete(id), [id, null];
        const { messages, ...fields } = entry, from = Math.min(told.get(id) ?? 0, messages.length);
        told.set(id, messages.length);
        return [id, { ...fields, from, messages: messages.slice(from) }];
      }) });
      changed.clear();
    }, 50);
  };
  subagentListeners.add(watchSubagents);

  // A call's progress goes out every 100ms at most: the output printed since the last event, and the latest status.
  // threadId: the run the call is in, for the tabs that show it (a sub-agent's call goes to its lead's chat).
  const progress = new Map(); // toolUseId -> { stdout, stderr, status }
  let progressTimer = null;
  const PROGRESS_MS = 100;
  const onProgress = (toolUseId, { stdout = "", stderr = "", status } = {}) => {
    if (!toolUseId) return;
    const p = progress.get(toolUseId) ?? { stdout: "", stderr: "" };
    p.stdout += stdout;
    p.stderr += stderr;
    if (status !== undefined) p.status = status;
    progress.set(toolUseId, p);
    progressTimer ??= setTimeout(() => {
      progressTimer = null;
      for (const [toolUseId, p] of progress) emit({ type: "tool.progress", toolUseId, ...(p.stdout && { stdout: p.stdout }), ...(p.stderr && { stderr: p.stderr }), ...(p.status !== undefined && { status: p.status }) });
      progress.clear();
    }, PROGRESS_MS);
  };
  progressListeners.add(onProgress);

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
    return runAgentWithBranching(run.store, set, () => client(modelId), activePath.at(-1), { agentId, threadId }, db, { signal: run.controller.signal, workspace, host, resume, modelClient: client });
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
    emit({ type: "thread", threadId, from, after: messages[from - 1]?.id ?? null, messages: messages.slice(from), activeLeafId: run.store.activeLeafId, running: true });
  }

  // A chat as it stands: the run's store while it runs, else the database's branch to its newest message.
  async function open(threadId) {
    const thread = await db.get("threads", threadId);
    if (!thread) return null;
    const run = runs.get(threadId);
    if (run) {
      const { messages, messageTree, activePath, activeLeafId, modelId } = unwrap(run.store);
      return { thread, messages, tree: messageTree, activePath, activeLeafId, modelId, running: true };
    }
    const history = await db.getAllFromIndex("messages", "threadId", threadId);
    const tree = history.length ? buildMessageTree(history) : null;
    const activePath = tree ? getPathToMessage(tree, Math.max(...history.map(m => m.id))) : [];
    const messages = activePath.map(id => tree.nodes.get(id)?.message).filter(Boolean);
    return { thread, messages, tree, activePath, activeLeafId: activePath.at(-1) ?? null, running: false };
  }

  // Starts a run and answers once its user message is saved: { threadId, done }, or null while that chat runs.
  // leafId is the message the reply follows; forkFromId, a message to retry or edit, which then branches.
  // client: the page's screen and locale ({ device, viewport, tz, locale }), announced to the model when it changes.
  async function send({ agentId = 1, threadId = null, projectId = null, leafId = null, forkFromId = null, text, files = [], modelId, reasoningMode, liveErrors = [], client: screen = null }) {
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
      const keptFiles = forked?.content.find(c => c.metadata)?.metadata.attachments ?? [];
      const [typed, ...attached] = await getMessageContent(text, files);
      const thread = await db.get("threads", threadId);
      const metadata = userMetadata({ thread, client: screen, files, kept: keptFiles, changes: notice, ws });
      if (metadata.client) await db.put("threads", { ...thread, client: metadata.client });
      const content = [typed, ...kept, ...attached, { metadata }];
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
    try {
      await markRun(threadId, null);
    } finally {
      runs.delete(threadId);
      run?.release?.();
      workspaces?.release(threadId);
    }
    const state = await open(threadId);
    emit({ type: "runs", threadIds: running() });
    if (state) emit({ type: "thread", threadId, ...state, from: 0, after: run?.leafId ?? null });
  }

  return {
    open, send, resume, running,
    recover: () => (recovered = recovered.then(recover).catch(e => console.error(e))),
    stop: threadId => runs.get(threadId)?.controller.abort(),
    on: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    dispose: () => { for (const run of runs.values()) run.controller.abort(); listeners.clear(); subagentListeners.delete(watchSubagents); progressListeners.delete(onProgress); clearTimeout(subagentTimer); clearTimeout(progressTimer); },
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
// Bump when a command, event, or host call changes. The worker's URL carries it and DB_VERSION, so a page of
// another version gets a worker of its own; hello checks it too.
const PROTOCOL = 6;
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
  let engine = null;
  // A newer version wants the database: this engine stops its runs and lets it go, and its tabs reload into the new one.
  const db = await initDB({
    blocking: () => {
      served = null;
      engine?.dispose();
      tabs.forEach(t => t.port.postMessage({ type: "reload" }));
    },
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
  // progress: the tab's reports on the call as it works (a command's output), before its answer.
  const ask = method => (args, { signal, progress = null } = {}) => new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const cancel = () => {
      call.tab?.calls.delete(call.id);
      call.tab?.port.postMessage({ type: "cancel", id: call.id });
      reject(signal.reason);
    };
    const settle = fn => value => { signal?.removeEventListener("abort", cancel); fn(value); };
    const call = { id: ++calls, method, args, threadId: args.threadId, resolve: settle(resolve), reject: settle(reject), progress, tab: null };
    signal?.addEventListener("abort", cancel, { once: true });
    dispatch(call);
  });
  const host = {
    run: ask("run"),
    code: ask("code"),
    readUrl: ask("readUrl"),
    shell: ask("shell"),
    release: (projectId, branch = null) => tabs.forEach(t => t.port.postMessage({ type: "release", projectId, branch })),
  };
  const workspaces = createWorkspaces(db, host);
  engine = createEngine(db, { workspaces, host });
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
        port.postMessage({ type: "subagents", entries: [...subagents], full: true });
        engine.recover();
      } else if (data.type === "settings") {
        applySettings(data.settings);
      } else if (data.type === "view") {
        // A view or an answer before hello has no tab to go to.
        if (tab) Object.assign(tab, { visible: data.visible, threadId: data.threadId });
      } else if (data.type === "progress") {
        tab?.calls.get(data.id)?.progress?.(data.value);
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
  const report = messages.flatMap(m => m.content ?? []).map(c => resultOf(c)?.report).filter(r => r && !isScratch(r.path)).at(-1);
  if (!report || report.ok !== false) return null;
  const why = [...(report.errors ?? []), ...(report.tests?.failures ?? []), ...(report.notes ?? [])].slice(0, 3).join("; ").replace(/(?<=[^.])$/, ".") || "see the report.";
  return `The last run report for ${report.path} is not ok: ${why} Fix the cause before you finish, or say why you can't. Never fake data or drop what was asked to get a passing report.`;
}

// The note for a turn that changed a file without adding a test to it, or null. The count to beat is the file's
// last report before the turn; a file new this turn has none, so any test will do.
function untestedChange(messages, start) {
  const reports = messages.map((m, i) => (m.content ?? []).map(c => [i, resultOf(c)?.report]).filter(([, r]) => r?.path && !isScratch(r.path))).flat();
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
  const blocks = messages.slice(start).flatMap(m => m.content ?? []);
  const last = blocks.findLastIndex(c => resultOf(c)?.type === "variant" && Object.keys(resultOf(c).versions ?? {}).length);
  if (last < 0 || blocks.slice(last).some(c => c?.toolUse?.name === "restore")) return null;
  return "Your variants' versions are on their branches, not in your files: the user sees none of them. Restore the one you choose, or ask the user to choose from the takes.";
}

// The note for a turn that chose from its takes and kept reworking the choice, or null: a taste polished past
// its fixes costs the user's wait and buys another taste.
function polishedTake(messages, start, most = 6) {
  const results = messages.slice(start).flatMap(m => m.content ?? []).map(resultOf).filter(Boolean);
  const last = results.findLastIndex(r => r.type === "variant" && Object.keys(r.versions ?? {}).length);
  const since = last < 0 ? 0 : results.slice(last + 1).filter(r => r.version != null && r.path).length;
  return since < most ? null : `${since} versions since your takes came back. Stop when the next change would be a different taste, not a fix: say which take you chose and why.`;
}

// The note for a turn that has made PLAN_AFTER calls (think aside) and has no plan file, or null. A plan file counts
// at the project's root or in the shown artifact's folder: the places the prompt's "beside the work" means.
// Why: Haiku made ~35 calls on hard-ssg-report and never wrote the PLAN.md its prompt asks for.
const PLAN_AFTER = 8;
function unplannedTask(messages, start, files, shown = null) {
  const calls = messages.slice(start).flatMap(m => m.content ?? []).filter(c => c?.toolUse && c.toolUse.name !== "think").length;
  if (calls < PLAN_AFTER) return null;
  const folder = shown?.includes("/") ? shown.slice(0, shown.lastIndexOf("/") + 1) : "";
  if (files.some(p => PLAN_FILES.some(name => p === name || p === folder + name))) return null;
  return PLAN_NOTE;
}
const PLAN_NOTE = "This task is long. Write PLAN.md now with write_file (SPEC.md if you are building an app): the goal in the user's words, the steps with the check for each, what is done, and what you learned with the URL or file it came from. Then continue.";

// The note for a reply that ended in thought alone, with no text and no call, or null.
function silentReply(messages) {
  const last = messages.at(-1);
  const silent = m => m?.role === "assistant" && !(m.content ?? []).some(c => c?.text?.trim() || c?.toolUse);
  if (!silent(last)) return null;
  const assistants = messages.filter(m => m.role === "assistant");
  if (assistants.length >= 3 && assistants.slice(-3).every(silent)) return null;
  // Why: Gemini wrote a whole game in one call twice; each came back malformed and empty, and it was told only "no text"
  if (last.stopReason === "malformed_tool_call") return "Your tool call came back malformed, so nothing ran: a call that large fails as a whole. Write the file in parts: write_file with the skeleton, then edit_file to fill each part.";
  if (last.stopReason === "max_tokens") return "Your reply reached the output limit before any text or tool call. Write the file in parts: write_file with the skeleton, then edit_file to fill each part.";
  return "Your reply ended with no text and no tool call. Go on with the work, or answer.";
}

// The director (docs/specs/2026-10-12-director.md). Long work gets a contract: the goal, items each with a check the
// harness runs, a ledger of what each check showed, notes with sources, questions for the user. The model makes the
// judgments; the harness keeps the books, so an item is done when its check passes, never on the model's word. A
// table of rules reads the contract and the run, and says one short thing at the tail of the request when it applies.
// Why: cheap models follow the instruction just before they act, and feedback better than rules. A plan-file rule in
// the prompt changed nothing; the same rule injected after the eighth call worked in 3 of 3 runs.

const STALL_STEPS = 6; // steps with no check turning green before the director says so
const NOTES_AT = 0.8; // share of the way to a summary at which the model is told to write its notes
const LEDGER_KEPT = 300;

const emptyContract = () => ({ goal: "", done: "", assumptions: [], items: [], ledger: [], notes: [], questions: [] });
const clip = (text, n) => (text = String(text ?? ""), text.length > n ? text.slice(0, n - 1) + "…" : text);
const andList = xs => xs.length < 2 ? String(xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
const itemsLabel = ids => `${ids.length > 1 ? "Items" : "Item"} ${andList(ids)}`;
const squash = text => String(text ?? "").toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
const runnable = item => HARNESS_CHECKS.includes(item.check?.kind);
// The item to work on: the first not done whose check the harness can run, else the first not done.
const currentItem = contract => contract.items.find(i => i.status !== "done" && runnable(i)) ?? contract.items.find(i => i.status !== "done") ?? null;
const lastEntry = (contract, item) => contract.ledger.findLast(e => e.itemId === item.id && e.result !== "replaced");
function progressLine(contract) {
  const done = contract.items.filter(i => i.status === "done").length;
  const green = contract.items.filter(i => lastEntry(contract, i)?.result === "pass").length;
  return `${done} of ${contract.items.length} items done, ${green} check${green === 1 ? "" : "s"} green`;
}

function describeCheck(c) {
  if (!c) return "none";
  switch (c.kind) {
    case "test": return `the tests in ${c.file || "the shown page"} pass${c.name ? `, "${clip(c.name, 80)}" among them` : ""}`;
    case "probe": return `\`${clip(c.script, 120)}\` returns true in ${c.file || "the shown page"}`;
    case "file": {
      const parts = c.exists === false ? ["is gone"] : ["exists"];
      if (c.contains != null) parts.push(`contains "${clip(c.contains, 60)}"`);
      if (c.matches) parts.push(`matches /${clip(c.matches, 60)}/`);
      if (c.min_words) parts.push(`has at least ${c.min_words} words`);
      if (c.max_words) parts.push(`has at most ${c.max_words} words`);
      return `${c.file} ${andList(parts)}`;
    }
    case "source": return `"${clip(c.text, 80)}" appears in a tool result`;
    case "command": return `\`${clip(c.run, 100)}\` exits ${c.exit ?? 0}${c.stdout != null ? ` with "${clip(c.stdout, 60)}" in its output` : ""}`;
    default: return `${c.kind}: ${clip(c.text ?? "", 80)}`;
  }
}

// A check as the plan keeps it, or a reason it can't be one.
function toCheck(c) {
  if (!c || typeof c !== "object") return { error: `needs a check: { "kind": "${HARNESS_CHECKS.join('" | "')}", ... }` };
  if (!CHECK_KINDS.includes(c.kind)) return { error: `has a check of unknown kind "${c.kind}": the harness runs ${andList(HARNESS_CHECKS)}` };
  if (c.kind === "probe" && !String(c.script ?? "").trim()) return { error: "has a probe check without a script" };
  if (c.kind === "file" && !c.file) return { error: "has a file check without a file" };
  if (c.kind === "source" && !String(c.text ?? "").trim()) return { error: "has a source check without the text to find" };
  if (c.kind === "command" && !String(c.run ?? "").trim()) return { error: 'has a command check without the command: { "kind": "command", "run": "npm test", "exit": 0 }' };
  if (c.kind === "command" && c.exit != null && !Number.isInteger(+c.exit)) return { error: "has a command check whose exit isn't a number" };
  if (c.matches) try { new RegExp(c.matches, "m"); } catch (e) { return { error: `has a pattern that doesn't parse: ${e.message}` }; }
  const fields = ["kind", "file", "name", "script", "exists", "contains", "matches", "min_words", "max_words", "text", "run", "exit", "stdout"];
  return { check: Object.fromEntries(fields.filter(k => c[k] != null).map(k => [k, k === "file" ? normalizePath(c[k]) : k === "exit" ? +c[k] : c[k]])) };
}

// The strings in every tool result of this chat but the plan's own, with the call that returned each.
function toolTexts(messages) {
  const calls = new Map(messages.flatMap(m => (m.content ?? []).filter(b => b?.toolUse).map(b => [b.toolUse.toolUseId, b.toolUse])));
  const strings = (v, out) => { if (typeof v === "string") out.push(v); else if (v && typeof v === "object" && !ArrayBuffer.isView(v)) Object.values(v).forEach(x => strings(x, out)); return out; };
  return messages.flatMap(m => (m.content ?? []).filter(b => b?.toolResult).map(b => ({ call: calls.get(b.toolResult.toolUseId), parts: b.toolResult.content ?? [] })))
    .filter(r => r.call?.name !== "plan")
    .map(({ call, parts }) => ({ call, text: squash(parts.flatMap(p => strings(p.text ?? p.json, [])).join("\n")) }));
}

const pass = evidence => ({ result: "pass", evidence }), fail = evidence => ({ result: "fail", evidence });

function fileCheck(c, text) {
  if (text == null) return c.exists === false ? pass(`${c.file} is gone`) : fail(`${c.file} doesn't exist`);
  if (c.exists === false) return fail(`${c.file} exists`);
  const words = text.split(/\s+/).filter(Boolean).length;
  if (c.contains != null && !text.includes(String(c.contains))) return fail(`${c.file} doesn't contain "${clip(c.contains, 60)}"`);
  if (c.matches && !new RegExp(c.matches, "m").test(text)) return fail(`${c.file} doesn't match /${clip(c.matches, 60)}/`);
  if (c.min_words && words < c.min_words) return fail(`${c.file} has ${words} words, fewer than ${c.min_words}`);
  if (c.max_words && words > c.max_words) return fail(`${c.file} has ${words} words, more than ${c.max_words}`);
  return pass(`${c.file}: ${words} words`);
}

function sourceCheck(c, messages) {
  const want = squash(c.text);
  const hit = toolTexts(messages).find(t => t.text.includes(want));
  if (!hit) return fail("not in any tool result in this chat");
  const where = hit.call && [hit.call.name, hit.call.input?.url ?? hit.call.input?.path ?? hit.call.input?.query].filter(Boolean).join(" ");
  return pass(`found in ${clip(where || "a tool result", 160)}`);
}

// A page and its tests, run fresh unless this step's results already ran its current version.
async function pageReport(ws, page, { script = null, fresh = [], signal } = {}) {
  const head = ws.state.project.heads[page];
  const ran = !script && fresh.findLast(r => r.path === page && r.version === head);
  return ran || (await ws.run({ versionId: head, script, screenshot: false, signal })).report;
}

async function testCheck(c, ws, fresh, signal) {
  if (!ws?.state?.project) return fail("no project is open, so nothing can be tested yet");
  const file = c.file ? normalizePath(c.file) : null;
  // A test file or folder runs as `node --test` would.
  const tests = file && !isHtml(file) ? testFiles(file, ws.state.project.heads) : null;
  if (tests && !tests.length) return fail(`${file} has no test files`);
  if (!tests && file && !ws.state.project.heads[file]) return fail(`${file} doesn't exist`);
  const page = tests ? file : file && isHtml(file) ? file : ws.shownPath();
  if (!tests && (!page || !isHtml(page))) return fail("no page runs tests: the project shows no HTML page");
  const report = tests ? (await ws.run({ tests: { files: tests, path: file }, signal })).report : await pageReport(ws, page, { fresh, signal });
  const t = report.tests;
  if (!t) return fail(`${page}: ${clip(report.notes?.[0] ?? report.errors?.[0] ?? "no in-file tests ran", 160)}`);
  if (t.failed) return fail(`${page}: ${t.passed} passed, ${t.failed} failed${t.failures?.length ? `: ${clip(t.failures.slice(0, 2).join("; "), 200)}` : ""}`);
  if (!t.passed) return fail(`${page}: no test passed`);
  if (c.name && !(t.passes ?? []).some(n => squash(n).includes(squash(c.name)))) return fail(`${page}: ${t.passed} passed, none named "${clip(c.name, 60)}"`);
  return pass(`${page}: ${t.passed} passed`);
}

async function probeCheck(c, ws, signal) {
  if (!ws?.state?.project) return fail("no project is open, so there is no page to probe yet");
  const page = c.file ? normalizePath(c.file) : ws.shownPath();
  if (!page || !ws.state.project.heads[page]) return fail(`${page ?? "the page"} doesn't exist yet`);
  // An expression is a probe too.
  const script = /\breturn\b/.test(c.script) ? c.script : `return (${c.script.trim().replace(/;+$/, "")});`;
  const report = await pageReport(ws, page, { script, signal });
  if (report.scriptError) return fail(`${page}: the script threw: ${clip(report.scriptError, 200)}`);
  if (!("result" in report)) return fail(`${page}: ${clip(report.notes?.[0] ?? report.errors?.[0] ?? "the page did not run", 160)}`);
  return report.result === true ? pass(`${page}: returned true`) : fail(`${page}: returned ${clip(JSON.stringify(report.result) ?? "undefined", 120)}`);
}

// { result: pass | fail | "not run", evidence }. A check that throws fails, with the reason as its evidence.
// host and threadId: for a command check, the tab that runs the shell, and the run whose shell it is.
async function runCheck(check, { ws = null, messages = [], fresh = [], signal = null, host = null, threadId = null } = {}) {
  try {
    switch (check.kind) {
      case "file": return fileCheck(check, ws?.readFile ? await ws.readFile(check.file) : null);
      case "source": return sourceCheck(check, messages);
      case "test": return await testCheck(check, ws, fresh, signal);
      case "probe": return await probeCheck(check, ws, signal);
      case "command": return await shellTool.runCommandCheck(check, { ws, host, threadId, signal });
      default: return { result: "not run", evidence: `not run by the harness yet: it runs ${andList(HARNESS_CHECKS)} checks, so this item stays open` };
    }
  } catch (e) {
    if (signal?.aborted) throw e;
    return fail(`the check could not run: ${clip(e?.message || e, 200)}`);
  }
}

// A command check of a GitHub project's CI (gh pr checks, gh run ...): it reads the pushed commit, not the files.
const isCICheck = check => check.kind === "command" && /^\s*gh\s+(pr\s+checks|run)\b/.test(check.run ?? "");

// Whether a change to path is a reason to run the check again.
function watches(check, path) {
  if (isPlanFile(path)) return false;
  if (check.kind === "file") return check.file === path;
  if (check.kind === "test" || check.kind === "probe" || check.kind === "command") return !isScratch(path) || check.file === path;
  return false;
}

// What the plan tool returns: the contract in a few lines.
function contractState(contract) {
  const current = currentItem(contract);
  const last = current && lastEntry(contract, current);
  const shown = contract.items.length <= 12 ? contract.items : contract.items.filter(i => i.status !== "done").slice(0, 6);
  const open = contract.questions.filter(q => q.answer == null);
  return [
    contract.goal ? `Goal: ${contract.goal}` : "Goal: not set yet; plan({ goal, done, assumptions }) sets it.",
    contract.done && `Done means: ${contract.done}`,
    contract.assumptions.length && `Assumptions: ${contract.assumptions.join("; ")}`,
    contract.items.length ? `Items: ${progressLine(contract)}.` : "Items: none yet; plan({ add: { title, check } }) adds one.",
    ...shown.map(i => `${i.id}. [${i.status}${i.weak ? ", check passed before the work" : ""}] ${i.title}`),
    current && `Current: item ${current.id}; check: ${describeCheck(current.check)}${last ? `; last run: ${last.result}, ${last.evidence}` : ""}.`,
    contract.notes.length && `Notes: ${contract.notes.length}.`,
    open.length && `Open questions: ${open.map(q => q.text).join(" / ")}`,
  ].filter(Boolean).join("\n");
}

// PLAN.md, written by the harness from the contract, for the user and for later chats on the project.
function renderPlan(contract) {
  const state = i => {
    const e = lastEntry(contract, i);
    return i.status === "done" ? "passed" : i.weak ? "check passed before the work" : e?.result === "fail" ? `failing: ${e.evidence}` : e?.result === "not run" ? "not run by the harness" : "open";
  };
  const lines = ["# Plan", "", "Kept by the harness from the agent's plan tool; edits here are overwritten.", ""];
  if (contract.goal) lines.push(`Goal: ${contract.goal}`, "");
  if (contract.done) lines.push(`Done means: ${contract.done}`, "");
  if (contract.assumptions.length) lines.push("## Assumptions", ...contract.assumptions.map(a => `- ${a}`), "");
  if (contract.items.length) lines.push("## Items", `${progressLine(contract)}.`, "",
    ...contract.items.map(i => `- [${i.status === "done" ? "x" : " "}] ${i.id}. ${i.title}. Check: ${describeCheck(i.check)} (${state(i)})`), "");
  if (contract.notes.length) lines.push("## Notes", ...contract.notes.map(n => `- ${n.text}${n.source ? ` (${n.source})` : ""}`), "");
  if (contract.questions.length) lines.push("## Questions", ...contract.questions.map(q => `- ${q.text}${q.answer != null ? ` Answer: ${clip(q.answer, 300)}` : " (open)"}`), "");
  if (contract.ledger.length) lines.push("## Ledger", ...contract.ledger.slice(-20).map(e => `- ${new Date(e.at).toISOString().slice(0, 16).replace("T", " ")} item ${e.itemId}: ${e.result}, ${e.evidence}`), "");
  return lines.join("\n");
}

// The notes that bear on an item: those naming its file or a word of its title, else the latest.
function relevantNotes(contract, item, most = 5) {
  const words = item ? [item.check?.file, ...item.title.toLowerCase().split(/\W+/).filter(w => w.length > 4)].filter(Boolean) : [];
  const near = contract.notes.filter(n => words.some(w => `${n.text} ${n.source}`.toLowerCase().includes(String(w).toLowerCase())));
  return (near.length ? near : contract.notes).slice(-most);
}

// A test result the final reply claims and nothing in the chat shows, or null.
// Why: "17 passed" with no report saying so was the commonest failure on swe. "Items 1 and 3 pass" counts nothing.
const COUNT_CLAIM = /(?<!\b(?:(?:items?|steps?|parts?|phases?|checks?)\s?(?:\d+\s*(?:,|and|&|or)\s*)*|version\s?|v\s?|of\s?))\b(\d+)(?:\s*(?:\/|of)\s*\d+)?\s+(?:[a-z-]+\s+)?(?:(?:tests?|checks?|specs?)\s+)?(?:(?:all|now)\s+)?pass(?:ed|ing|es)?\b/i;
const ALL_CLAIM = /(?<!\bnot\s)\b(?:all|every)\s+(?:of\s+)?(?:the\s+)?(?:\d+\s+)?(?:[a-z-]+\s+)?(?:tests?|checks?)\s+(?:now\s+)?pass|(?<!\bnot\s(?:all\s)?(?:the\s)?)\btests?\s+(?:all\s+|now\s+)*pass(?:es|ed|ing)?\b/i;
function contradictedClaim(messages) {
  const last = messages.at(-1);
  if (last?.role !== "assistant") return null;
  const said = (last.content ?? []).filter(c => typeof c?.text === "string").map(c => c.text).join("\n");
  const count = COUNT_CLAIM.exec(said), all = !count && ALL_CLAIM.exec(said);
  if (!count && !all) return null;
  const report = messages.flatMap(m => (m.content ?? []).map(c => resultOf(c)?.report)).filter(r => r?.tests && !isScratch(r.path ?? "")).at(-1);
  const texts = toolTexts(messages).map(t => t.text);
  const ran = report && `the last run of ${report.path} shows ${summarizeReport(report)}`;
  let fact = null;
  if (count) {
    const n = count[1], shown = new RegExp(`\\b${n}\\s+(?:[a-z-]+\\s+)?(?:tests?\\s+)?pass|\\bpass(?:ed|es|ing)?\\W{0,3}${n}\\b`);
    if (report?.tests.passed !== +n && !texts.some(t => shown.test(t))) fact = ran || `no run report or tool result in this chat shows ${n} passing`;
  } else if (report?.tests.failed) fact = ran;
  else if (!report && !texts.some(t => /\bpass(?:ed|es|ing)?\b/.test(t))) fact = "no run report or tool result in this chat shows a test run";
  return fact && `Your reply says "${clip((count ?? all)[0].trim(), 80)}", but ${fact}. Correct the reply, since the user reads it as checked.`;
}

function openItemsNote(contract, asked) {
  // A weak item (its check passed before the work) can't turn done, so it isn't open work: saying it is only made the
  // model explain the plan to the user (docs/experiments/LOG.md, E6).
  const open = contract.items.filter(i => i.status !== "done" && runnable(i) && !i.weak);
  if (!open.length || asked) return null;
  const [first] = open;
  return `${itemsLabel(open.map(i => i.id))} ${open.length > 1 ? "are" : "is"} open, and the harness counts an item done only when its check passes. Continue with item ${first.id}, "${first.title}" (check: ${describeCheck(first.check)}), or tell the user why the work stops here, in terms of the work: they don't see the plan.`;
}

function doneNote(done, contract) {
  const next = currentItem(contract), ids = done.map(i => i.id), so = done.length > 1 ? "they are" : "it is";
  const head = `${itemsLabel(ids)}'s check${done.length > 1 ? "s" : ""} passed, so ${so} done (${progressLine(contract)}).`;
  return next ? `${head} Next: item ${next.id}, "${next.title}"; its check: ${describeCheck(next.check)}.`
    : `${head} The items you listed all pass, but they are only your steps: check the goal itself, everything the user asked for. If something is missing or doesn't work yet, add it as an item and go on. If it is all there, tell the user what was done and what wasn't, in their terms (they don't see the plan's items or checks); for a fix, what caused the problem, which files changed, and how you checked it.`;
}

function resummaryNote(contract) {
  if (!contract.goal && !contract.items.length) return null;
  const done = contract.items.filter(i => i.status === "done").map(i => i.id), current = currentItem(contract);
  const notes = relevantNotes(contract, current).map(n => clip(n.text, 200) + (n.source ? ` (${n.source})` : "")).join("; ");
  return [
    "A summary replaced older messages; the contract still holds.",
    contract.goal && `Goal: ${contract.goal.replace(/\.?$/, ".")}`,
    contract.items.length && `Done: ${done.length ? `${done.length > 1 ? "items" : "item"} ${andList(done)}` : "nothing yet"}.`,
    current ? `Current: item ${current.id}, "${current.title}"; check: ${describeCheck(current.check)}.` : contract.items.length && "Every item is done.",
    notes && `Notes: ${notes}.`,
  ].filter(Boolean).join(" ");
}

const GOAL_NOTE = "This is long work, so the harness keeps a contract for it that outlasts summaries. Before more work, state the goal in the user's words, your assumptions, and what done means with plan({ goal, assumptions, done }).";
const ITEMS_NOTE = "The goal is set and the plan has no items. Add the steps with plan({ add: { title, check } }), each with a check the harness can run (test, probe, file, source or command), so it can tell when each one is done.";

// Each rule: when it is read (at a step's results, when the model stops, after a summary), how often it may speak
// (once a turn, at every event, or once between summaries), and what it says. A stop takes one note at a time. The
// first six are the reminders the loop had before the director; their conditions are unchanged.
const DIRECTOR_RULES = [
  { id: "polished", at: "step", every: "turn", note: s => polishedTake(s.messages, s.start) },
  // Past the size threshold with no goal. An agent without the plan tool is told to keep a plan file instead.
  { id: "goal", at: "step", every: "turn", note: s => s.has("plan") ? s.sized && !s.contract.goal && GOAL_NOTE
    : s.has("write_file") && s.ws && unplannedTask(s.messages, s.start, s.files, s.shown) },
  { id: "items", at: "step", every: "turn", note: s => s.contract.goal && !s.contract.items.length && ITEMS_NOTE },
  { id: "red", at: "step", every: "event", note: s => s.events.red.map(i => `Item ${i.id}'s check already passes before any work, so it can't show the item gets done. Change it with plan({ edit: ${i.id}, check }) to one that fails now and passes once the item is done.`) },
  { id: "regressed", at: "step", every: "event", note: s => s.events.regressed.map(({ item, evidence }) => `Item ${item.id}'s check passed before and fails now (${evidence}), so the item is open again. A change since it passed broke it: fix that before going on.`) },
  { id: "done", at: "step", every: "event", note: s => s.events.done.length && doneNote(s.events.done, s.contract) },
  // A test's failures are in the run report already; the other kinds say nothing unless the harness does.
  { id: "failed", at: "step", every: "event", note: s => s.events.failed.filter(({ item }) => item.check.kind !== "test").map(({ item, evidence }) => `Item ${item.id}'s check ran after this change and fails: ${evidence}.`) },
  { id: "same", at: "step", every: "event", note: s => s.events.same.map(({ item, evidence }) => `Item ${item.id}'s check failed twice the same way (${evidence}), so the approach isn't working yet. Read the code and the error again before the next edit, or split the item with plan({ edit }) and plan({ add }).`) },
  { id: "stalled", at: "step", every: "event", note: s => s.idle && s.idle % STALL_STEPS === 0 && s.current && runnable(s.current) && `No check has passed in ${s.idle} steps, and item ${s.current.id}, "${s.current.title}", is still open. Change the approach, split the item, or ask the user.` },
  { id: "budget", at: "step", every: "summary", note: s => s.has("plan") && s.used >= s.summaryAt * NOTES_AT && `The context is at ${Math.round(s.used / 1000)}k tokens, near the ${Math.round(s.summaryAt / 1000)}k at which older messages are summarized and earlier tool results cleared. Write what you learned to notes now with plan({ note, source }), then keep working: the summary and the notes carry the work on.` },
  // Per stop, not per turn: a second empty reply would otherwise end the run (E15). silentReply stops after two in a row.
  { id: "silent", at: "stop", every: "event", note: s => silentReply(s.messages) },
  { id: "failing", at: "stop", every: "turn", note: s => failingReport(s.messages.slice(s.start)) },
  { id: "untested", at: "stop", every: "turn", note: s => untestedChange(s.messages, s.start) },
  { id: "unadopted", at: "stop", every: "turn", note: s => unadoptedVariants(s.messages, s.start) },
  // Only after work: a turn that called no tool is an answer, and its words about tests are about tests in general.
  { id: "claim", at: "stop", every: "turn", note: s => s.calls && contradictedClaim(s.messages) },
  { id: "open", at: "stop", every: "turn", note: s => s.calls && openItemsNote(s.contract, s.asked) },
  { id: "summary", at: "summary", every: "event", note: s => resummaryNote(s.contract) },
];
// director=off: the six reminders as the loop had them before the director (5f2e583), each once a turn. The plan
// tool is withheld too (getConverseCommand), so no contract starts and no contract rule speaks.
const ruleOf = id => DIRECTOR_RULES.find(r => r.id === id);
const PRE_DIRECTOR_RULES = [
  ruleOf("polished"),
  { id: "unplanned", at: "step", every: "turn", note: s => s.has("write_file") && s.ws && unplannedTask(s.messages, s.start, s.files, s.shown) },
  ...["silent", "failing", "untested", "unadopted"].map(ruleOf),
];
// Notes of the harness's own, read with or without the director. "turn": read once when the user's message arrives.
// date: the system prompt keeps the day the conversation started, so a message on a later day says so once.
const CHANNEL_RULES = [
  { id: "date", at: "turn", every: "turn", note: s => newDayNote(s.messages, s.start, s.started) },
];
function newDayNote(messages, start, started) {
  const days = messages.slice(0, start).filter(m => m.role === "user").map(m => m.content?.find(b => b?.metadata?.timestamp)?.metadata.timestamp.slice(0, 10)).filter(Boolean);
  const today = days.at(-1), before = days.at(-2) ?? started;
  return today && before && today > before ? `The user's date is now ${today}, a later day than ${before}: the date in the system prompt is the day this conversation started.` : null;
}
// The plan-keeping note, said after PLAN_AFTER calls: the director's goal note, or, with no plan tool, the plan file.
const PLAN_RULES = ["goal", "unplanned"];
// The rules a run reads, by the flags: director=off, rule.<id>=off, and plan.where=prompt (the plan note is in the
// system prompt instead, so it isn't injected too).
function activeRules() {
  const rules = [...(flag("director") === "off" ? PRE_DIRECTOR_RULES : DIRECTOR_RULES), ...CHANNEL_RULES];
  return rules.filter(r => flag("rule." + r.id) !== "off" && !(flag("plan.where") === "prompt" && PLAN_RULES.includes(r.id)));
}
// plan.where=prompt (E7): the note the plan rule would inject, in WORKING instead, said for when it applies.
function planInPrompt(tools) {
  if (flag("plan.where") !== "prompt") return null;
  const rule = tools.includes("plan") ? "goal" : tools.includes("write_file") ? "unplanned" : null;
  if (!rule || flag("rule." + rule) === "off") return null;
  return `\nOnce a task has taken ${PLAN_AFTER} tool calls (think aside) and has no plan yet: ${rule === "goal" ? GOAL_NOTE : PLAN_NOTE}\n`;
}

// One per run (a turn): the thread's contract, the rules, and what they have said. messages: the run's messages as
// they stand. tools: the names of the tools the run has. started: the day the conversation started.
async function createDirector({ db, threadId = null, agentId = null, tools = [], modelId = null, messages = () => [], start = 0, resume = false, rules = activeRules(), started = null, turnStart = null } = {}) {
  const thread = threadId != null ? await db.get("threads", threadId) : null;
  // The files the user's message found. A turn that edits files that were there is a fix, not long work, however
  // many calls it takes (E25b, E27: on bug fixes the contract cost a third more calls and leaked into replies; games
  // start with no files and keep it). sizing=calls is the old rule, by calls alone.
  const sizing = flag("sizing", "building"), startHeads = sizing === "building" ? (await turnStart)?.heads ?? null : null;
  const contract = { ...emptyContract(), ...structuredClone(thread?.contract ?? {}) };
  const has = name => tools.includes(name);
  const reminded = new Set(), seen = new Set();
  let pending = [], idle = 0, asked = false, dirty = false, workspace = null, host = null;
  const sources = new Set();
  let queue = Promise.resolve();
  const serial = fn => { const p = queue.then(fn); queue = p.catch(() => {}); return p; };

  // A new message from the user answers the questions left open.
  const typed = !resume && messages()[start - 1]?.content?.find(c => typeof c?.text === "string" && !c.harness)?.text;
  if (typed && contract.questions.some(q => q.answer == null)) {
    for (const q of contract.questions) q.answer ??= clip(typed, 1000);
    dirty = true;
  }

  async function save() {
    if (!dirty) return;
    dirty = false;
    if (contract.ledger.length > LEDGER_KEPT) contract.ledger.splice(0, contract.ledger.length - LEDGER_KEPT);
    if (threadId != null) {
      // Read and written in one transaction, so a write to the thread beside it isn't undone.
      const tx = db.transaction("threads", "readwrite");
      const row = await tx.store.get(threadId);
      if (row) await tx.store.put({ ...row, contract: structuredClone(contract) });
      await tx.done;
    }
    const ws = workspace;
    if (!ws?.commit || (!contract.goal && !contract.items.length)) return;
    try {
      ws.setContext?.({ threadId, agentId });
      // Beside existing work only: a question shouldn't leave a project behind. The thread keeps the contract.
      if (!ws.state.project) return;
      const text = renderPlan(contract);
      if (ws.state.files["PLAN.md"] !== text) await ws.exclusive(() => ws.commit("PLAN.md", text, { source: "harness" }));
    } catch (e) {
      console.warn("PLAN.md was not written:", e);
    }
  }

  // A check's run goes in the ledger and moves its item. after: why it ran (add, change, step, milestone).
  function record(item, { result, evidence }, after, events) {
    const before = lastEntry(contract, item), at = Date.now();
    // A source check runs every step; only a new result is worth an entry.
    if (after === "step" && before?.result === result && before.evidence === evidence) return;
    const lastChange = contract.ledger.findLast(e => e.itemId === item.id && e.after === "change");
    contract.ledger.push({ itemId: item.id, check: item.check, result, evidence, at, after });
    dirty = true;
    if (result === "not run" || after === "add") return;
    if (result === "pass") {
      if (item.status === "done" || item.weak) return;
      item.status = "done";
      item.history.push({ at, status: "done" });
      events.done.push(item);
    } else if (item.status === "done") {
      item.status = "failing";
      item.history.push({ at, status: "failing", why: "regression" });
      events.regressed.push({ item, evidence });
    } else if (after === "change") {
      if (item.status !== "failing") item.history.push({ at, status: "failing" });
      item.status = "failing";
      const key = `${item.id}:${evidence}`;
      if (lastChange?.result === "fail" && lastChange.evidence === evidence) { if (!seen.has(key)) events.same.push({ item, evidence }); seen.add(key); }
      else events.failed.push({ item, evidence });
    }
  }

  // Red first: a check runs once when it is set, and one that already passes is not a check of the work.
  async function redFirst(item, env) {
    const outcome = await runCheck(item.check, env);
    record(item, outcome, "add", null);
    if (outcome.result === "pass") { item.weak = true; pending.push(item); return `Its check already passes (${outcome.evidence}), so it can't show the item gets done: change it with plan({ edit: ${item.id}, check }).`; }
    return outcome.result === "fail" ? `Its check fails now (${outcome.evidence}), as it should before the work.` : `Its check is ${outcome.evidence}.`;
  }

  function plan(input, context = {}) {
    return serial(async () => {
      if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "plan takes an object: { goal }, { add }, { edit }, { note } or { ask }." };
      workspace = context.workspace ?? workspace;
      host = context.host ?? host;
      const env = { ws: workspace, messages: messages(), signal: context.signal, host, threadId };
      const said = [];
      const statusGiven = "status" in input || [input.add].flat().some(a => a && "status" in a) || (input.check && "status" in input.check);
      if (statusGiven) said.push("Status is the harness's: an item is done when its check passes, so the status given was ignored.");
      for (const key of ["goal", "done"]) if (typeof input[key] === "string" && input[key].trim()) { contract[key] = input[key].trim(); dirty = true; }
      if (input.assumptions != null) { contract.assumptions = [input.assumptions].flat().map(String).map(a => a.trim()).filter(Boolean); dirty = true; }
      for (const add of [input.add ?? []].flat()) {
        const title = String(add?.title ?? "").trim();
        const { check, error } = toCheck(add?.check);
        if (!title || error) { said.push(`Not added: ${title ? `"${clip(title, 60)}" ${error}` : "an item needs a title and a check"}.`); continue; }
        const item = { id: Math.max(0, ...contract.items.map(i => i.id)) + 1, title, check, status: "open", history: [{ at: Date.now(), status: "open", why: "added" }] };
        contract.items.push(item);
        dirty = true;
        said.push(`Added item ${item.id}. ${runnable(item) ? await redFirst(item, env) : `Its check is ${(await runCheck(check, env)).evidence}.`}`);
      }
      if (input.edit != null) {
        const item = contract.items.find(i => i.id === +input.edit);
        if (!item) said.push(`There is no item ${input.edit}; the items are ${andList(contract.items.map(i => i.id)) || "none yet"}.`);
        else {
          if (typeof input.title === "string" && input.title.trim()) { item.title = input.title.trim(); dirty = true; }
          if (input.check != null) {
            const { check, error } = toCheck(input.check);
            if (error) said.push(`Item ${item.id} kept its check: the new one ${error}.`);
            else {
              const at = Date.now();
              contract.ledger.push({ itemId: item.id, check: item.check, result: "replaced", evidence: "the check was changed", at, after: "edit" });
              item.history.push({ at, status: "open", why: "check changed", check: item.check });
              Object.assign(item, { check, status: "open", weak: false });
              dirty = true;
              said.push(`Item ${item.id}'s check changed. ${runnable(item) ? await redFirst(item, env) : ""}`.trim());
            }
          }
        }
      }
      if (typeof input.note === "string" && input.note.trim()) { contract.notes.push({ text: input.note.trim(), source: String(input.source ?? "").trim(), at: Date.now() }); dirty = true; }
      if (typeof input.ask === "string" && input.ask.trim()) { contract.questions.push({ text: input.ask.trim() }); asked = true; dirty = true; }
      await save();
      return [...said, contractState(contract)].join("\n");
    });
  }

  const building = () => {
    if (!startHeads || !Object.keys(startHeads).length) return true;
    const heads = workspace?.state?.project?.heads ?? {};
    return Object.keys(heads).filter(p => !(p in startHeads) && !isPlanFile(p) && !isScratch(p)).length >= 3;
  };
  const stateFor = (messages, startAt, extra = {}) => {
    const calls = messages.slice(startAt).flatMap(m => m.content ?? []).filter(c => c?.toolUse && c.toolUse.name !== "think").length;
    const usage = messages.findLast(m => m.role === "assistant" && m.usage)?.usage ?? {};
    return {
      messages, start: startAt, calls, contract, has, idle, asked: asked && contract.questions.some(q => q.answer == null), current: currentItem(contract),
      // By tool calls: a long request can still be a small fix or a question. sizing=building also needs the turn to
      // build: no files when it began, or 3 or more new ones since.
      sized: calls >= PLAN_AFTER && (sizing !== "building" || building()),
      used: (usage.inputTokens || 0) + (usage.cacheReadInputTokens || 0) + (usage.cacheWriteInputTokens || 0),
      summaryAt: modelInfo(modelId).context * COMPACT_AT,
      events: { red: [], done: [], regressed: [], failed: [], same: [] },
      ...extra,
    };
  };

  // The rules read at this point, through the one channel (envelope.js steer): their notes and any delivered from
  // outside (deliver), ranked and capped. Returns the blocks to put on the message, capped ones included, logged. A
  // rule counts as having spoken only when its note was delivered. A delivered-in note (a result) that was capped
  // waits for the next step: unlike advice, it is the only copy.
  let delivering = [];
  function fire(at, s, { step: n = null, max = STEER_MAX } = {}) {
    const queued = at === "step" || at === "stop" || at === "deliver" ? delivering.splice(0) : [];
    const candidates = [...queued];
    for (const rule of rules.filter(r => r.at === at)) {
      if (rule.every !== "event" && reminded.has(rule.id)) continue;
      candidates.push(...[rule.note(s)].flat().filter(Boolean).map(text => note(rule.id, text)));
    }
    const blocks = steer(candidates, { step: n, max });
    for (const b of delivered(blocks)) reminded.add(b.instruction.rule);
    delivering.push(...queued.filter(q => blocks.some(b => b.instruction.status === "capped" && b.instruction.rule === q.rule && b.instruction.text === q.text)));
    return blocks;
  }

  // After a step's results: run the checks the step bears on, then the rules. Returns the note blocks to append.
  function step({ messages: all, start: startAt = start, ws = null, signal = null, step: n = null, host: tab = null }) {
    return serial(async () => {
      workspace = ws ?? workspace;
      host = tab ?? host;
      const results = (all.at(-1)?.content ?? []).map(resultOf).filter(r => r && typeof r === "object");
      // A tool's version, or the files a bash command changed.
      const changed = new Set(results.flatMap(r => [...(r.version != null && r.path ? [r.path] : []), ...(Array.isArray(r.files) ? r.files.map(f => f?.path).filter(Boolean) : [])]).map(normalizePath));
      const env = { ws: workspace, messages: all, fresh: results.map(r => r.report).filter(r => r?.path), signal, host, threadId };
      const s = stateFor(all, startAt, { ws: workspace, files: Object.keys(workspace?.state?.files ?? {}), shown: workspace?.shownPath?.() ?? null });
      s.events.red = pending.splice(0);
      // A push is what moves CI: a check of it (gh pr checks, gh run) runs again after one, not after an edit.
      const pushed = results.some(r => r.pushed);
      for (const item of contract.items.filter(i => i.status !== "done" && runnable(i))) {
        if (item.check.kind === "source") record(item, await runCheck(item.check, env), "step", s.events);
        else if (isCICheck(item.check) ? pushed : [...changed].some(p => watches(item.check, p))) record(item, await runCheck(item.check, env), "change", s.events);
      }
      // A milestone: every check that passed before runs again, and one that fails reopens its item.
      if (s.events.done.length) for (const item of contract.items.filter(i => i.status === "done" && !s.events.done.includes(i)))
        record(item, await runCheck(item.check, env), "milestone", s.events);
      // Reading a new source or recording a note is progress; an edit isn't, since an edit loop is what stalls.
      const learned = (all.at(-2)?.content ?? []).filter(c => c?.toolUse).map(c => c.toolUse).some(c => {
        const read = c.name === "read_url" ? c.input?.url : c.name === "web_search" ? c.input?.query
          : c.name === "code" && /fetch\(|web\.(read|search)/.test(c.input?.source ?? "") ? c.input.source : null;
        return (read && !sources.has(read) && sources.add(read)) || (c.name === "plan" && c.input?.note);
      });
      idle = s.events.done.length || learned || !contract.items.some(i => i.status !== "done" && runnable(i)) ? 0 : idle + 1;
      Object.assign(s, { idle, current: currentItem(contract) });
      await save();
      return fire("step", s, { step: n });
    });
  }

  return {
    contract, plan, step,
    // When the user's message arrives (not on a resume): the notes for it, e.g. a new day.
    begin: () => resume ? [] : fire("turn", stateFor(messages(), start, { started }), { step: 0 }),
    // The note blocks for a model that stopped, empty for none; one delivered at a time, each rule once a turn.
    stop: ({ messages: all, start: startAt = start, step: n = null }) => fire("stop", stateFor(all, startAt), { step: n, max: STOP_MAX }),
    // The notes after a summary ran: the contract, re-injected. The context-budget note may speak again.
    summarized: ({ step: n = null } = {}) => { reminded.delete("budget"); return fire("summary", stateFor(messages(), start), { step: n }); },
    // The hook for notes from outside the rules (an async sub-agent's result): { rule, text, priority } from
    // envelope.js note(), delivered with the next step's or stop's notes, through the same cap and log.
    deliver: n => { delivering.push(n); },
    // Only what was delivered in, for a step with no results and no rules to read (a sub-agent's result while the lead
    // waits for it): ranked and capped like any step's.
    flush: ({ step: n = null } = {}) => fire("deliver", null, { step: n }),
    save: () => serial(save),
  };
}

// workspace: the run's workspace, or a function that finds it each turn, since the chat's project can open in
// the panel or close there while the run goes on.
// resume: pick up a run whose tab closed, from the last message it saved.
// modelClient: a client for a model id, for the sub-agents the run starts.
async function runAgentWithBranching(store, setStore, client, lastMessageId, params, db, { signal, workspace, host = null, maxTurns = MAX_TURNS, resume = false, modelClient: clientFor = modelClient } = {}) {
  // Each message records the file heads it left behind, so a branch can restore the code it saw.
  const saveMsg = async msg => db.add("messages", { ...unwrap(msg), agentId: params.agentId, threadId: params.threadId, heads: workspace ? await projectHeads(db, params.threadId) : null });
  const toolMap = Object.fromEntries(store.tools.map(t => [t.toolSpec.name, t.fn]));
  // subagents=async: task returns at once, results come in later messages, and a running part's files are its own.
  const background = flag("subagents") === "async" && toolMap.task ? createBackground(signal) : null;
  let toldRunning = false;
  if (background) {
    toolMap.wait = WAIT_TOOL.fn;
    const locked = (name, fn) => async (input, context) => {
      const path = background.running.size && await changedPath(name, input, context.workspace, db).catch(() => null);
      const owner = path && background.owner(path);
      return owner ? { error: `${path} belongs to a running part (${owner}); wait for it or work on other files.` } : fn(input, context);
    };
    for (const name of ["write_file", "edit_file", "restore"]) if (toolMap[name]) toolMap[name] = locked(name, toolMap[name]);
  }
  const push = async msg => {
    setStore("messages", store.messages.length, msg);
    const id = await saveMsg(msg);
    setStore("messages", store.messages.length - 1, "id", id);
    return id;
  };
  let parentId = lastMessageId;
  // The user's message this run answers, with the files it found: the shell commits those as the turn's baseline.
  const turnStart = turnStartOf(db, lastMessageId).catch(() => null);
  let streaming = null;
  const start = store.messages.length;
  let director = null, tz = null, step = 0, reviewed = false, reviews = 0, partHeads = { ...((await turnStart)?.heads ?? {}) };
  // The oracle's review (E28): the review sub-agent on a stronger model, given one request; its review text, or null.
  // It runs in a thread of its own, so the user can open it and its tokens are counted with the run's.
  const reviewParts = (ws, prompt) => task({ type: "review", model: { opus: "Opus 5.5", sonnet: "Sonnet 5.5", haiku: "Haiku 5.5" }[flag("oracle.model", "opus")], prompt },
    { db, threadId: params.threadId, agentId: params.agentId, modelId: store.modelId, reasoningMode: store.reasoningMode, workspace: ws, host, signal, modelClient: clientFor, tz, toolUseId: `oracle-${crypto.randomUUID().slice(0, 8)}` })
    .then(r => r?.summary || null, () => null);
  // The director's notes ride after the results, in the message's metadata (envelope.js): the tail of the next request.
  const runTools = async (callsId, conversation, cutOff) => {
    const ws = typeof workspace === "function" ? await workspace() : workspace;
    const context = { db, threadId: params.threadId, agentId: params.agentId, modelId: store.modelId, reasoningMode: store.reasoningMode, workspace: ws, host, signal, conversation, cutOff, modelClient: clientFor, director, tz, turnStart, ...(background && { background }) };
    const results = await getToolResults(store.messages.at(-1).content, toolMap, context);
    // Sub-agents that finished meanwhile: through the director's channel, so they ride this step's notes, after the
    // results, never inside one.
    if (background) deliverSubagents(director, background.take());
    const notes = await director.step({ messages: [...unwrap(store.messages), results], start, ws, signal, step, host });
    const rich = stepMetadata(director.contract, ws);
    results.content.push(...(Object.keys(rich).length ? [{ metadata: rich }] : []), ...notes);
    return push({ ...results, parentId: callsId, createdAt: Date.now() });
  };
  // Notes for a message not yet sent go on it, in its metadata, apart from the user's own words.
  const amendLast = async blocks => {
    const i = store.messages.length - 1, last = store.messages[i];
    if (last?.role !== "user" || last.id == null || !blocks.length) return;
    const next = [...unwrap(last.content), ...blocks];
    setStore("messages", i, "content", next);
    const row = await db.get("messages", last.id);
    if (row?.threadId === params.threadId) await db.put("messages", { ...row, content: next });
  };

  try {
    // Resolved here so a missing key becomes an error reply instead of a stuck request.
    if (typeof client === "function") client = await client();
    const thread = await db.get("threads", params.threadId);
    tz = thread?.client?.tz ?? null;
    // The day the conversation started, in the user's time zone, taken once: the system prompt never changes with it.
    const started = thread?.started ?? localDate(thread?.createdAt ?? Date.now(), tz);
    if (thread && !thread.started) await db.put("threads", { ...(await db.get("threads", params.threadId)), started });
    setStore("started", started);
    director = await createDirector({ db, threadId: params.threadId, agentId: params.agentId, tools: Object.keys(toolMap), modelId: store.modelId, messages: () => unwrap(store.messages), start, resume, started, turnStart });
    let summary = thread?.summary ?? null;
    let memories = thread?.memories ?? null;
    if (memories == null && store.tools.some(t => t.toolSpec.name === "editor")) {
      memories = await memoriesBlock(db, params.agentId);
      if (thread) await db.put("threads", { ...(await db.get("threads", params.threadId)), memories });
    }
    await amendLast(director.begin());
    // Calls made and never answered run first; a reply that had finished has nothing to add.
    const last = store.messages.at(-1);
    if (resume && last?.role === "assistant") {
      if (!last.content.some(c => c?.toolUse)) return;
      parentId = await runTools(last.id, null, false);
    }
    for (let turn = 0; ; turn++) {
      signal?.throwIfAborted();
      step = turn;
      if (turn === maxTurns) {
        const note = { text: `(Paused after ${maxTurns} steps. Say "continue" to go on.)` };
        setStore("activeLeafId", await push({ role: "assistant", content: [note], parentId, createdAt: Date.now() }));
        break;
      }
      const before = summary;
      summary = await compactHistory(store, client, db, params.threadId, summary, memories, signal);
      // Why: cheap models lose the thread after a summary; the goal and the current item come back with it.
      if (summary !== before) await amendLast(director.summarized({ step }));
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
      // A declined request ends the turn in a plain line: no calls run, no stop rule asks again.
      const refused = declined(stopReason);
      if (refused) setStore("messages", streaming, m => ({ ...m, content: [{ text: REFUSAL_TEXT }], refused: true }));
      const savedId = await saveMsg(store.messages.at(-1));
      setStore("messages", streaming, "id", savedId);
      setStore("activeLeafId", savedId);
      streaming = null;
      parentId = savedId;
      step = turn + 1;
      if (refused) break;

      // Calls run whatever the stop reason says: a stream can close without one, and an unanswered call ends the turn.
      if (!store.messages.at(-1).content.some(c => c?.toolUse)) {
        // A turn doesn't end with sub-agents in flight: the lead hears once that they run, then their results as they land.
        if (background?.running.size || background?.finished.size) {
          if (!background.finished.size && !toldRunning) {
            toldRunning = true;
            director.deliver(note("running", stillRunning(background)));
            parentId = await push({ role: "user", content: director.flush({ step }), parentId, createdAt: Date.now() });
            continue;
          }
          if (!background.finished.size) await background.next(signal);
          signal?.throwIfAborted();
          deliverSubagents(director, background.take());
          parentId = await push({ role: "user", content: director.flush({ step }), parentId, createdAt: Date.now() });
          continue;
        }
        // oracle=done (E28b): a long work written in parts this turn is read once by a stronger reviewer, part
        // against part, before the turn ends; what it finds comes back for one round of fixes.
        if (!reviewed && toolMap.task && flag("oracle") === "done") {
          reviewed = true;
          const ws = typeof workspace === "function" ? await workspace() : workspace;
          const parts = await writtenParts(ws, (await turnStart)?.heads ?? {});
          const review = parts && await reviewParts(ws, fill(PARTS_REVIEW, { parts: parts.join(", ") }));
          if (review) {
            director.deliver(note("review", fill(PARTS_REVIEW_NOTE, { review })));
            parentId = await push({ role: "user", content: director.flush({ step }), parentId, createdAt: Date.now() });
            continue;
          }
        }
        // Each stop rule speaks once a turn; then the model's word stands.
        const notes = director.stop({ messages: unwrap(store.messages), start, step });
        if (!delivered(notes).length) break;
        parentId = await push({ role: "user", content: notes, parentId, createdAt: Date.now() });
        continue;
      }

      // A fork continues this exact request, so it reads the cache the request just wrote.
      parentId = await runTools(savedId, { request, turn: unwrap(store.messages.at(-1).content) }, stopReason === "max_tokens");

      // oracle=each (E28c): each prose part a step writes, in a work of two or more, is read against the parts before
      // it while drift is small; the review rides the next step's notes.
      if (toolMap.task && flag("oracle") === "each" && reviews < MAX_PART_REVIEWS) {
        const ws = typeof workspace === "function" ? await workspace() : workspace;
        const heads = ws?.state?.project?.heads ?? {};
        const prose = Object.keys(heads).filter(isProsePart).sort();
        const fresh = prose.filter(p => partHeads[p] !== heads[p]);
        partHeads = { ...heads };
        if (fresh.length && prose.length >= 2) {
          reviews++;
          const earlier = prose.filter(p => !fresh.includes(p) && p < fresh.at(-1));
          const review = await reviewParts(ws, fill(PART_REVIEW, { fresh: fresh.join(", "), earlier: earlier.join(", ") || "none" }));
          if (review) director.deliver(note("review", fill(PART_REVIEW_NOTE, { fresh: fresh.join(", "), review })));
        }
      }
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
    // A run that ends with sub-agents in flight (a pause, an error) stops them: nothing is left to take their results.
    background?.stop();
    const allMessages = await db.getAllFromIndex("messages", "threadId", params.threadId);
    const tree = buildMessageTree(allMessages);
    setStore("messageTree", tree);
    setStore("activePath", getPathToMessage(tree, store.activeLeafId ?? parentId));
  }
}

// The heads of a chat's project as they stand, or null for a chat without one.
// The prose files a turn wrote, when they are a work in parts (3 or more .md or .txt files new or changed since
// the turn began, plan files and scratch aside), in path order; or null.
const isProsePart = p => /\.(md|txt)$/i.test(p) && !isPlanFile(p) && !isScratch(p) && !/^notes\//.test(p);
const MAX_PART_REVIEWS = 16;
async function writtenParts(ws, startHeads) {
  const heads = ws?.state?.project?.heads ?? {};
  const parts = Object.keys(heads).filter(p => isProsePart(p) && heads[p] !== startHeads[p]).sort();
  return parts.length >= 3 ? parts : null;
}

// The nearest message up the branch that the user typed: { id, heads }, or null.
async function turnStartOf(db, id) {
  for (let n = 0; id != null && n < 10_000; n++) {
    const m = await db.get("messages", id);
    if (!m) return null;
    const typed = m.role === "user" && (m.content ?? []).some(c => typeof c.text === "string" && !c.harness) && !(m.content ?? []).some(c => c.toolResult);
    if (typed) return { id, heads: m.heads ?? null };
    id = m.parentId;
  }
  return null;
}

async function projectHeads(db, threadId) {
  const projectId = threadId && (await db.get("threads", threadId))?.projectId;
  const project = projectId && (await db.get("projects", projectId));
  return project ? { ...project.heads } : null;
}

// The <metadata> a user message carries (envelope.js renders it): the user's local time, the client when it changed,
// this message's attachments and the changes since the last turn. metadata=rich adds the contract's state and the
// project's files.
function userMetadata({ thread = null, client = null, files = [], kept = [], changes = null, ws = null, now = Date.now() } = {}) {
  const attachments = [...kept, ...files.map(f => ({ name: f.name, type: f.type || null, bytes: f.size ?? null }))];
  return {
    timestamp: isoLocal(now, client?.tz ?? thread?.client?.tz),
    ...(client && !sameClient(client, thread?.client) && { client }),
    ...(attachments.length && { attachments }),
    ...(changes && { changes }),
    ...stepMetadata(thread?.contract, ws),
  };
}

// What metadata=rich adds after every step and on every user message; nothing at the default.
function stepMetadata(contract, ws) {
  if (flag("metadata", "minimal") !== "rich") return {};
  return { state: contractState({ ...emptyContract(), ...contract }), files: Object.keys(ws?.state?.files ?? {}).sort() };
}

// Stop reasons that mean the model declined: the turn ends with a plain line, and isn't retried. Bedrock Converse
// says guardrail_intervened or content_filtered, the Anthropic API refusal; the Gemini client maps its safety stops
// to refusal.
const REFUSALS = ["refusal", "guardrail_intervened", "content_filtered"];
const REFUSAL_TEXT = "The model declined this request.";
const declined = stopReason => REFUSALS.includes(stopReason);

function getConverseCommand(config) {
  const model = modelInfo(config.modelId);
  const cachePoint = model.cache ? [{ cachePoint: { type: "default" } }] : [];
  // director=off: no plan tool, as before the director.
  const tools = config.tools.filter(t => t.toolSpec.name !== "plan" || flag("director") !== "off").map(({ toolSpec }) => ({ toolSpec }));
  // subagents=async: wait comes with task.
  if (flag("subagents") === "async" && tools.some(t => t.toolSpec.name === "task") && !tools.some(t => t.toolSpec.name === "wait")) tools.push({ toolSpec: WAIT_TOOL.toolSpec });
  const system = systemPrompt(config.systemPrompt, { tools: tools.map(t => t.toolSpec.name), memories: config.memories, modelId: config.modelId, started: config.started });
  return {
    modelId: config.modelId,
    messages: prepareMessages(config.messages, { documents: model.documents, beside: model.beside, cache: model.cache, summary: config.summary, tail: config.tail, modelId: config.modelId }),
    // Tools come before the system prompt in the cached prefix, so the system's point covers both.
    system: [{ text: system }, ...cachePoint],
    toolConfig: { tools },
    inferenceConfig: { maxTokens: model.maxTokens },
    // effort=<level> holds every call of the run at one level: the main loop's, sub-agents', summaries'.
    additionalModelRequestFields: reasoningFields(model, flag("effort", config.reasoningMode)),
  };
}

// What the model sees. Old screenshots and bulky tool results shrink in steps, so the request prefix (and its
// cache) changes rarely; a summary stands in for everything before it. A tail (a fork's own turns) follows the
// history without moving those steps, so a fork's prefix is the parent's, byte for byte.
// Cache points ride the last two user messages: the newest writes, the one before is where the previous
// request (or the parent of a fork) wrote, so the read is exact however many blocks the last turn added.
// Reasoning goes back only to the model that wrote it: another model can't read its signature and rejects the turn.
// Each message is first rendered in the envelope (envelope.js renderTurn): the user's words, their metadata, the notes
// that fired, each result's times.
function prepareMessages(messages, { documents = true, beside = false, cache = false, summary = null, tail = [], modelId = null } = {}) {
  const envelope = flag("envelope", "xml");
  messages = messages.map(m => renderTurn(m, { envelope }));
  tail = tail.map(m => renderTurn(m, { envelope }));
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
      if (block?.image && !isImage(block.image)) return { text: `[an empty or invalid ${block.image.format} image, left out]` };
      // Thinking can arrive as a signature alone; the API wants its text back, even empty.
      if (block?.reasoningContent?.reasoningText && block.reasoningContent.reasoningText.text == null)
        return { reasoningContent: { ...block.reasoningContent, reasoningText: { ...block.reasoningContent.reasoningText, text: "" } } };
      if (!block?.toolResult) return block;
      let parts = block.toolResult.content;
      // The names of passing tests are for the harness's checks; the model has the counts.
      if (parts.some(c => c.json?.result?.report?.tests?.passes)) parts = parts.map(c => {
        const passes = c.json?.result?.report?.tests?.passes;
        if (!passes) return c;
        const { passes: _, ...tests } = c.json.result.report.tests;
        return { ...c, json: { ...c.json, result: { ...c.json.result, report: { ...c.json.result.report, tests } } } };
      });
      // Old images and documents are the bulk of a request; the model can view them again.
      if (i <= oldImages) parts = parts.map(c => (c.image ? { text: "[image omitted]" } : c.document ? { text: `[${c.document.name} omitted]` } : c));
      if (!documents) parts = parts.map(c => (c.document ? unread(c.document.name) : c));
      // Bedrock rejects the whole request for one image that isn't one, and every later request carries it.
      if (parts.some(c => c.image && !isImage(c.image))) parts = parts.map(c => (c.image && !isImage(c.image) ? { text: `[an empty or invalid ${c.image.format} image, left out]` } : c));
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
    // A file's own label (a full page's "page 2 of 4") is the text just before it, and moves with it.
    const own = k => typeof parts[k - 1]?.text === "string" && !!(parts[k]?.image || parts[k]?.document);
    parts.forEach((c, k) => (c.image || c.document) && moved.push({ text: own(k) ? `${label}, ${parts[k - 1].text}` : label }, c));
    return { toolResult: { ...block.toolResult, content: parts.filter((c, k) => !c.image && !c.document && !own(k + 1)) } };
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
  if (size < 1500 || call?.name === "task" || call?.name === "wait") return part;
  const what = call ? `${call.name} ${JSON.stringify(call.input).slice(0, 200)}` : "tool result";
  const report = part.json?.result?.report;
  const verdict = report && { ok: report.ok, tests: report.tests && { passed: report.tests.passed, failed: report.tests.failed } };
  return { json: { result: { elided: `${what}: ${size} chars, dropped to save context; call again if needed`, ...verdict } } };
}

// Long chats outgrow the context window. When the last request used most of it, everything before the recent
// turns becomes one summary, saved on the thread so later requests start from it. A summary that fails is noted on
// the thread by the usage that asked for it, and not asked for again until a request uses more.
async function compactHistory(store, client, db, threadId, summary, memories, signal, keep = 6) {
  const messages = unwrap(store.messages);
  const last = messages.findLast(m => m.usage);
  const u = last?.usage ?? {};
  const used = (u.inputTokens || 0) + (u.cacheReadInputTokens || 0) + (u.cacheWriteInputTokens || 0);
  if (used < modelInfo(store.modelId).context * COMPACT_AT || last.id === summary?.usageId) return summary;
  let cut = messages.length - keep;
  while (cut > 1 && messages[cut].role !== "assistant") cut--;
  if (cut <= 1 || messages[cut - 1].id === summary?.throughId) return summary;
  if ((await db.get("threads", threadId))?.summaryFailed === last.id) return summary;

  // The summary request is the history so far, with the instruction added to its last (user) message.
  const head = messages.slice(0, cut).map(({ id, role, content }) => ({ id, role, content }));
  head[cut - 1] = { ...head[cut - 1], content: [...head[cut - 1].content, ...steer([note("summarize", SUMMARY_PROMPT)])] };
  try {
    const output = await watchedSend(client, getConverseCommand({ ...unwrap(store), memories, summary, messages: head }), signal);
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

// A provider's SDK loads when its first request does, so a tab that never asks never downloads it. One that failed
// to load is tried again by the next request.
const sdks = {};
const sdk = name => sdks[name] ??= import(`${CDN[name]}/+esm`).catch(e => { delete sdks[name]; throw e; });

async function getConverseClient(type = "aws") {
  if (type === "aws") {
    const config = getStoredConfig("aws-config", "AWS");
    const { BedrockRuntimeClient, ConverseStreamCommand } = await sdk("@aws-sdk/client-bedrock-runtime");
    const client = new BedrockRuntimeClient(config);
    return { send: (input, { signal } = {}) => client.send(new ConverseStreamCommand(input), { abortSignal: signal }) };
  }
  if (type === "google") {
    const config = getStoredConfig("google-config", "Google");
    const { GoogleGenAI } = await sdk("@google/genai");
    return getGeminiClient(new GoogleGenAI(config));
  }
  if (type === "echo") {
    return getEchoClient();
  }
}
const modelClient = modelId => getConverseClient(providerOf(modelId));

// A model that sends nothing this long has stalled: the turn ends with an error, not a spinner that never stops.
const STALL_MS = 5 * 60_000;
// A provider that is busy or briefly down answers again soon: the request goes again before anything of the reply has
// arrived, after these waits. Why: Gemini's 503s ("high demand") ended 2 of 21 swe runs with an error (E29).
const RETRY_MS = [2_000, 8_000, 30_000];
const TRANSIENT = /\b(?:429|500|502|503|504|529)\b|UNAVAILABLE|overloaded|high demand|throttl|too many requests|ServiceUnavailable|InternalServerException|ModelNotReady|ECONNRESET|Failed to fetch|NetworkError/i;
const pause = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});
async function watchedSend(client, input, signal, ms = STALL_MS, delays = RETRY_MS) {
  for (let attempt = 0; ; attempt++) {
    try {
      const output = await watchedOnce(client, input, signal, ms);
      // The first event shows whether the provider took the request; after it, an error is the reply's own.
      const events = output.stream[Symbol.asyncIterator]();
      const first = await events.next();
      return { ...output, stream: (async function* () { if (!first.done) yield first.value; for (let n; !(n = await events.next()).done; ) yield n.value; })() };
    } catch (e) {
      if (signal?.aborted || attempt >= delays.length || !TRANSIENT.test(String(e?.message ?? e) + " " + (e?.name ?? ""))) throw e;
      await pause(delays[attempt], signal);
    }
  }
}
async function watchedOnce(client, input, signal, ms) {
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

    // What the user typed: the envelope's <contents>, unescaped; under envelope=plain, the first text that isn't the
    // harness's (its metadata and notes follow the user's words).
    const lastUserMsg = input.messages?.filter(m => m.role === "user").pop();
    const texts = (lastUserMsg?.content ?? []).filter(c => c.text).map(c => c.text);
    const wrapped = texts.find(t => t.startsWith("<message><contents>"))?.match(/^<message><contents>([\s\S]*)<\/contents><\/message>$/)?.[1];
    const userText = wrapped != null ? wrapped.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
      : texts.find(t => !/^(<metadata>|<workspace>|Sent \d{4}-)/.test(t)) || "";

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

// Gemini's finish reasons for a reply it declined or withheld.
const GEMINI_REFUSALS = ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION"];
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
        const functionCall = { name: b.toolUse.name, args: b.toolUse.input, id: b.toolUse.toolUseId };
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
      // A prompt Gemini blocks comes back with no candidate at all.
      if (chunk.promptFeedback?.blockReason && !chunk.candidates?.length) { yield { messageStop: { stopReason: "refusal" } }; return; }
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
        const reason = { MAX_TOKENS: "max_tokens", MALFORMED_FUNCTION_CALL: "malformed_tool_call" }[done] ?? (GEMINI_REFUSALS.includes(done) ? "refusal" : null);
        yield { messageStop: { stopReason: reason ?? (calledTools ? "tool_use" : "end_turn") } };
      }
    }
  }

  return { send: (input, { signal } = {}) => Promise.resolve({ stream: stream(input, signal) }) };
}

// Credentials and the proxy are set in Settings and kept in localStorage. A worker has none: each tab sends its
// settings with every command, and again when another tab changes them; the latest copy stands in. The proxy sent
// is the stored one: the worker finds the local proxy itself.
const FLAGS_KEY = "harness-flags"; // localStorage: { name: value }, the experiment's feature flags
const SETTING_KEYS = ["aws-config", "google-config", "brave-config", "github-config", FLAGS_KEY];
const settings = { items: {}, proxy: null };
const setting = key => globalThis.localStorage ? localStorage.getItem(key) : settings.items[key] ?? null;
const storedJSON = key => { try { return JSON.parse(setting(key) || "null"); } catch { return null; } };
// A feature flag, or its default. Set per eval run (eval.js --flags) so an ablation needs no code change; each flag
// is a no-op at its default. director=off, rule.<id>=off, plan.where=prompt: activeRules and systemPrompt.
// effort=<level>: getConverseCommand. context=<tokens>: modelInfo. noProjectError=old: workspaceFor.
// envelope=plain: loose text blocks instead of <message>/<metadata> (envelope.js renderTurn). metadata=rich: the
// contract's state and the file list on every user message and after every step (userMetadata, stepMetadata).
const flag = (name, fallback = null) => { const value = storedJSON(FLAGS_KEY)?.[name]; return value == null ? fallback : String(value); };
// The user's GitHub token (Settings), for GitHub projects: a fine-grained one, scoped to the repositories.
const githubToken = () => storedJSON("github-config")?.token || null;
const snapshotSettings = () => ({ items: Object.fromEntries(SETTING_KEYS.map(key => [key, setting(key)])), proxy: storedProxyConfig() });
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
const storedProxyConfig = () => globalThis.localStorage ? storedJSON(PROXY_CONFIG_KEY) : settings.proxy;
const getProxyConfig = () => storedProxyConfig() ?? detectedProxy;
if (!storedProxyConfig())
  fetch(LOCAL_PROXY + "/health").then(r => r.json()).then(body => { if (body?.proxy === "chat") detectedProxy = { endpoint: LOCAL_PROXY }; }, () => {});

// This machine, whose addresses the proxy doesn't reach for. Stringified into the code sandbox's bridge.
function isLocalHost(hostname) {
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname) || hostname.endsWith(".localhost");
}

// The proxy also relays TCP over WebSocket at the same address (the tcpipe protocol).
const relayUrl = () => getProxyConfig()?.endpoint?.replace(/^http/, "ws").replace(/\/+$/, "") ?? null;

// Without a proxy, a site that sends no CORS headers fails as "Failed to fetch", which names neither the cause nor
// the fix. The code sandbox's fetch says the same.
const CORS_BLOCKED = "blocked by CORS (or unreachable): no local proxy. Use a CORS-open source, or run `npm run start:proxy`.";
const crossOrigin = target => /^https?:$/.test(target.protocol) && target.origin !== location.origin && !isLocalHost(target.hostname);

// A tool's fetch, through the proxy unless the URL is this machine's. It gives up after a minute, or when the run stops.
const FETCH_TIMEOUT_MS = 60_000;
async function proxyFetch(url, { signal, ...options } = {}) {
  const proxy = getProxyConfig();
  const target = new URL(url, location.origin);
  const timed = AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(signal ? [signal] : [])]);
  if (!proxy?.endpoint && crossOrigin(target))
    return fetch(url, { ...options, signal: timed }).catch(e => { throw e?.name === "TypeError" ? new TypeError(`Failed to fetch ${target.href}: ${CORS_BLOCKED}`) : e; });
  if (!proxy?.endpoint || isLocalHost(target.hostname)) return fetch(url, { ...options, signal: timed });
  const headers = new Headers(options.headers || {});
  if (proxy.headerName && proxy.headerValue) headers.set(proxy.headerName, proxy.headerValue);
  return fetch(proxy.endpoint.replace(/\/+$/, "") + "/" + target.href, { ...options, headers, signal: timed });
}

// Brave's results, as text: each one's title, URL, age, and the snippets Brave took from the page. Its API sends no
// CORS headers, so the call goes through the proxy.
const BRAVE_SEARCH = "https://api.search.brave.com/res/v1/web/search";
const hasBraveKey = () => !!storedJSON("brave-config")?.apiKey;
// Tools every agent and sub-agent gets for the web; search only when it can work: a key, and a proxy to reach Brave.
const webToolNames = () => ["read_url", ...(hasBraveKey() && getProxyConfig()?.endpoint ? ["web_search"] : [])];
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
  if (!proxy || !isLocalHost(proxy.hostname) || url.protocol !== "https:" || url.port) return null;
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
    // Sent directly, Upgrade-Insecure-Requests would need a CORS preflight, which a CORS-open host may not answer.
    const headers = getProxyConfig()?.endpoint ? NAVIGATE : { Accept: NAVIGATE.Accept };
    const response = await proxyFetch(target.href, { headers, signal });
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

function think() {
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
  const inWorkspace = p => !!ws && (p in ws.state.files || !!ws.root?.has(p));
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
      if (typeof resource.content !== "string") return { status: "error", error: `${path} is not text.` };
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
  // A fork that reads may still run commands (the tests, say): in a shell of its own, whose changes aren't saved.
  const readOnly = refuses.includes("write_file");
  const shellOf = fn => (input, context) => fn(input, { ...context, shell: { session: `fork-${toolUseId}`, commit: false } });
  const toolMap = Object.fromEntries(request.tools.map(({ toolSpec: { name }, fn }) => [name, refuses.includes(name) ? refuse(name) : readOnly && name === "bash" ? shellOf(fn) : fn]));
  toolMap.wait = () => ({ error: "Only the caller waits for sub-agents." }); // offered with task under subagents=async
  // The brief rides in the fork's own result, after a line that says so: read as the result, a fork took itself for the
  // caller and called the task it was; sent as the user's words, it made Haiku drop the caller's thinking, and the cache.
  const answers = turn.filter(b => b?.toolUse).map(({ toolUse }) => ({ toolResult: { toolUseId: toolUse.toolUseId, content:
    toolUse.toolUseId === toolUseId ? [{ text: "(This call is you: your brief follows.)" }, { text: brief(question) }]
      : [{ text: "(Runs alongside you; its result goes to the caller, not to you.)" }] } }));
  return { request, toolMap, messages: [{ role: "assistant", content: turn }, { role: "user", content: answers }] };
}

// A part changes only the files it owns. Why: Luna's three parts each rebuilt the whole game in index.html first,
// then wrote one another's modules and restored one another's versions, and two ran out of turns.
const ownsPath = (owned, path) => owned.some(f => f.endsWith("/") ? path.startsWith(f) : path === f);
// The file a write_file, edit_file or restore call changes.
const changedPath = async (name, input, ws, db) => name === "restore"
  ? (await db.get("versions", +input?.version))?.path
  : normalizePath(input?.path || ws?.shownPath() || ws?.state.project?.entry);
function ownedTools(toolMap, owned, ws, db) {
  const guard = (name, fn) => async (input, context) => {
    const path = await changedPath(name, input, ws, db);
    if (path && !ownsPath(owned, path)) return { error: `${path} isn't yours: this part owns ${owned.join(", ")}. The rest is the contract: read it, build against it, and say in your final message what it lacks.` };
    return fn(input, context);
  };
  // Its commands run, and only what they change in its own files is saved.
  const shellOwned = fn => (input, context) => fn(input, { ...context, shell: { owns } });
  return Object.fromEntries(Object.entries(toolMap).map(([name, fn]) => [name, ["write_file", "edit_file", "restore"].includes(name) ? guard(name, fn) : name === "bash" ? shellOwned(fn) : fn]));
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

// subagents=async (E15): the lead goes on while its sub-agents run. A run's background holds what is in flight
// (each by its task call's id, with the files a part owns) and what finished and is not yet delivered.
function createBackground(parent) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  const running = new Map(), finished = new Map(), delivered = new Set();
  let tick = Promise.withResolvers();
  const settle = (id, result) => {
    finished.set(id, { ...running.get(id), result });
    running.delete(id);
    tick.resolve();
    tick = Promise.withResolvers();
  };
  return {
    signal: controller.signal, running, finished, delivered,
    start(id, type, files, job) {
      running.set(id, { id, type, files });
      job.then(result => settle(id, result), error => settle(id, { error: error?.message || String(error) }));
    },
    // The running part that owns a path, or null.
    owner: path => [...running.values()].find(e => ownsPath(e.files, path))?.id ?? null,
    // The finished ones (of ids, or all), marked delivered.
    take(ids = null) {
      const out = [...finished.values()].filter(e => !ids || ids.includes(e.id));
      for (const e of out) { finished.delete(e.id); delivered.add(e.id); }
      return out;
    },
    // Resolves when the next one finishes, or the signal aborts.
    next: (signal = parent) => Promise.race([tick.promise, ...(signal ? [new Promise(resolve => signal.aborted ? resolve() : signal.addEventListener("abort", resolve, { once: true }))] : [])]),
    stop() { parent?.removeEventListener("abort", abort); controller.abort(); },
  };
}

// Finished sub-agents' results for the lead, each a note of its own through the director's channel (envelope.js):
// in the message's metadata, never inside a tool result, never merged with the user's words. The result rides the
// note as data, so it counts as its task's result (resultOf). A capped one waits for the next step.
const deliverSubagents = (director, entries) => entries.forEach(({ id, type, result }) =>
  director.deliver({ ...note("subagent", `Sub-agent ${id} (${type}) finished. Its result:\n${JSON.stringify(result)}`), data: { subagent: { id, result } } }));

const STARTED_NOTE = "Running. Its result will arrive in a later message; call wait({ id }) to wait for it.";
const stillRunning = background => {
  const types = [...background.running.values()].map(e => e.type), n = types.length;
  return `${n} sub-agent${n === 1 ? " is" : "s are"} still running (${types.join(", ")}). Their results will arrive here; continue with other work or call wait.`;
};

async function waitSubagents({ id, ids, timeout_s } = {}, { background, signal } = {}) {
  if (!background) return { error: "Nothing runs in the background here: task returns its result itself." };
  const want = Array.isArray(ids) && ids.length ? ids.map(String) : id != null ? [String(id)] : null;
  const unknown = want?.find(i => !background.running.has(i) && !background.finished.has(i));
  if (unknown) return { error: background.delivered.has(unknown) ? `${unknown}'s result was delivered already, in an earlier message.` : `No sub-agent ${unknown} is running. Running: ${[...background.running.keys()].join(", ") || "none"}.` };
  const pending = () => [...background.running.keys()].filter(i => !want || want.includes(i));
  const deadline = Number(timeout_s) > 0 ? Date.now() + Number(timeout_s) * 1000 : Infinity;
  while (pending().length && Date.now() < deadline) {
    signal?.throwIfAborted();
    await Promise.race([background.next(signal), ...(deadline < Infinity ? [sleep(deadline - Date.now())] : [])]);
  }
  signal?.throwIfAborted();
  const results = background.take(want).map(({ id, result }) => ({ id, result }));
  const still = pending();
  return { results, ...(still.length && { running: still, note: `Still running after ${timeout_s} s; their results will arrive in a later message.` }) };
}
const WAIT_TOOL = {
  fn: waitSubagents,
  toolSpec: {
    name: "wait",
    description: "Block until running sub-agents finish, and return their results. With no id, waits for all of them.",
    inputSchema: {
      json: {
        type: "object",
        properties: {
          id: { type: "string", description: "A sub-agent's id: the started value task returned" },
          ids: { type: "array", items: { type: "string" }, description: "Several ids" },
          timeout_s: { type: "number", description: "Return after this many seconds with what has finished" },
        },
      },
    },
  },
};

async function task({ prompt, type, folder, model, files }, context = {}) {
  const { db, toolUseId, conversation, workspace, background } = context;
  if (!db) return { error: "Database not available" };
  if (!SUBAGENT_TYPES.includes(type)) return { error: `Unknown type: ${type}. Use ${SUBAGENT_TYPES.map(t => `"${t}"`).join(", ")}.` };
  const forked = ["fork", "variant", "part"].includes(type), branched = type === "variant" || type === "part";
  if (forked && !conversation) return { error: `A ${type} needs a conversation to copy; use explore or general here.` };
  if (type === "review" && !workspace?.state?.project) return { error: "Nothing to review yet: no project is open." };
  const owned = type === "part" && Array.isArray(files) ? files.map(normalizePath).filter(Boolean) : [];
  if (type === "part" && !owned.length) return { error: "A part owns files: list them in files, as paths or folders ending in /." };
  const shared = type === "part" && overlap(owned, siblingFiles(conversation?.turn, toolUseId));
  if (shared) return { error: `${shared} is another part's in this turn too: give each file to one part.` };
  const busy = type === "part" && background && [...background.running.values()].find(e => overlap(owned, e.files));
  if (busy) return { error: `${overlap(owned, busy.files)} belongs to a running part (${busy.id}); give each file to one part.` };
  if (branched && !workspace) return { error: `A ${type} branches the project, and there is no workspace here.` };
  if (model && !SUBAGENT_MODELS.includes(model)) return { error: `Unknown model: ${model}. Use one of ${SUBAGENT_MODELS.join(", ")}, or leave it out for yours.` };

  const job = runTask({ prompt, type, folder, model, owned }, background ? { ...context, signal: background.signal } : context);
  if (!background || !toolUseId) return job;
  // Registered before task's first await, so a wait later in the same turn finds it.
  background.start(toolUseId, type, type === "part" ? owned : [], job);
  return { started: toolUseId, type, note: STARTED_NOTE };
}

// The sub-agent's run, from its thread to its result: what task returns, blocking, or delivers later.
async function runTask({ prompt, type, folder, model, owned }, context) {
  const { db, threadId, agentId, modelId, reasoningMode, signal, toolUseId, conversation, workspace, host } = context;
  const forked = ["fork", "variant", "part"].includes(type), branched = type === "variant" || type === "part";
  const folderName = folder || "findings";
  // A call with an id gets a thread of its own, and an entry the tabs show while it runs.
  const subagentThreadId = toolUseId ? await db.add("threads", { agentId, parentThreadId: threadId, parentToolUseId: toolUseId, type: "subagent", subagentType: type, status: "running", createdAt: Date.now() }) : null;
  if (toolUseId) setSubagent(toolUseId, { threadId: subagentThreadId, messages: [], currentMessage: null, status: "running", type });
  const update = change => {
    const entry = toolUseId && subagents.get(toolUseId);
    return entry && setSubagent(toolUseId, { ...entry, ...(typeof change === "function" ? change(entry) : change) });
  };
  const save = message => subagentThreadId && db.add("messages", { ...message, threadId: subagentThreadId, agentId, createdAt: message.createdAt ?? Date.now() });

  // The thread and its spinner end however the sub-agent does; its entry goes a while later.
  const finish = async status => {
    const thread = subagentThreadId && await db.get("threads", subagentThreadId);
    if (thread) await db.put("threads", { ...thread, status, updatedAt: Date.now() });
    const final = update({ status, currentMessage: null });
    if (final) setTimeout(() => subagents.get(toolUseId) === final && setSubagent(toolUseId, null), SUBAGENT_KEPT_MS);
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
      request = { systemPrompt: system, started: conversation?.request?.started ?? localDate(Date.now(), context.tz) };
      subTools = TOOLS.filter(t => [...names, ...webToolNames()].includes(t.toolSpec.name));
      toolMap = Object.fromEntries(subTools.map(t => [t.toolSpec.name, t.fn]));
      // A reviewer starts from what the caller's turn would see: the files and the last run.
      const files = type === "review" && workspace?.state?.project ? await workspace.describeChanges(null) : null;
      messages = [{ role: "user", content: [{ text: prompt }, ...(files ? [{ metadata: { changes: files } }] : [])] }];
    }

    const effectiveModelId = (model && !forked && MODELS.find(m => m.label === model)?.id) || modelId || DEFAULT_MODEL;
    const client = await (context.modelClient ?? modelClient)(effectiveModelId);
    const subContext = { db, threadId, agentId, signal, host, ...((type === "fork" || type === "review") && { workspace }), ...(branch && { workspace: branch }) };
    // A fork's history is the caller's; its thread shows the question it was asked.
    await save({ role: "user", content: forked ? [{ text: prompt }] : messages[0].content });

    for (let turn = 0; turn < most; turn++) {
      signal?.throwIfAborted();
      const input = forked
        ? getConverseCommand({ ...request, tail: messages })
        : getConverseCommand({ modelId: effectiveModelId, reasoningMode, systemPrompt: request.systemPrompt, tools: subTools, messages, started: request.started });
      const output = await watchedSend(client, input, signal);
      const assistantMsg = { role: "assistant", content: [], createdAt: Date.now(), modelId: effectiveModelId };
      let stopReason = null;
      for await (const msg of output.stream) {
        processStreamChunk(assistantMsg.content, msg);
        if (msg.messageStop) stopReason = msg.messageStop.stopReason;
        if (msg.metadata?.usage) assistantMsg.usage = msg.metadata.usage;
        update({ currentMessage: { ...assistantMsg } });
      }
      if (declined(stopReason)) Object.assign(assistantMsg, { content: [{ text: REFUSAL_TEXT }], refused: true });
      messages.push(assistantMsg);
      await save(assistantMsg);
      update(entry => ({ messages: [...entry.messages, { ...assistantMsg }], currentMessage: null }));

      if (!assistantMsg.content.some(c => c?.toolUse)) { capped = false; break; }

      const toolResults = await getToolResults(assistantMsg.content, toolMap, { ...subContext, tz: context.tz, cutOff: stopReason === "max_tokens" });
      // Work cut off at the cap is lost to the caller, so the last turn is for the answer.
      if (turn === most - 2) toolResults.content.push(...steer([note("last-turn", "One turn left: answer now with what you have, and say what you didn't get to.")], { step: turn + 1 }));
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

// Each result keeps when its call started and ended (in context.tz, the user's), rendered inside it (envelope.js).
async function getToolResults(toolUseContent, tools, context = {}) {
  const calls = toolUseContent.filter(c => c.toolUse);
  const timed = run => async (call, i) => {
    const started = Date.now(), block = await run(call, i);
    return { ...block, timing: timing(started, Date.now(), context.tz) };
  };
  const content = await Promise.all(
    calls
      .map(timed(async ({ toolUse }, i) => {
        const { toolUseId, name, input } = toolUse;
        // Output that hit the length limit ends inside its last call, so that call's input is incomplete.
        if (context.cutOff && i === calls.length - 1) return { toolResult: { toolUseId, content: [{ json: { result: { error: "Your output hit the length limit before this call was complete, so it did not run. Send less per call: edit rather than rewrite, or split the file." } } }] } };
        if (typeof input === "string") return { toolResult: { toolUseId, status: "error", content: [{ text: JSON.stringify({ INVALID_JSON: input }) }] } };
        try {
          const fn = Object.hasOwn(tools ?? {}, name) ? tools[name] : null;
          if (!fn) return { toolResult: { toolUseId, content: [{ json: { result: { error: `Unknown tool: ${name}` } } }] } };
          // Pass toolUseId in context for task tool to use
          const output = await fn(input, { ...context, toolUseId, progress: update => reportProgress(toolUseId, update) });
          if (!output?.__media) return { toolResult: { toolUseId, content: [{ json: { result: output } }] } };
          const { __media: media, ...result } = output;
          // A file with a label (a full page's "page 2 of 4") comes after it, so the model reads which one it sees.
          return { toolResult: { toolUseId, content: [{ json: { result } }, ...media.flatMap(m => (m.label ? [{ text: m.label }, mediaBlock(m)] : [mediaBlock(m)]))] } };
        } catch (error) {
          console.error("Tool error:", error);
          return { toolResult: { toolUseId, content: [{ json: { result: error.stack || error.message || String(error) } }] } };
        }
      }))
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

  const named = file.name.split(".").pop().toLowerCase();
  let ext = { htm: "html", jpg: "jpeg" }[named] ?? named;
  if ((file.type.startsWith("text/") || /json|xml/.test(file.type)) && !DOC_TYPES.includes(ext)) ext = "txt";

  const type = IMG_TYPES.includes(ext) ? "image" : DOC_TYPES.includes(ext) ? "document" : null;
  if (!type) return null;

  const bytes = new Uint8Array(await file.arrayBuffer());
  return { [type]: { format: ext, name: documentName(file.name.replace(/\.[^.]*$/, "")), source: { bytes } } };
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
  if (!(await db.getKey("blobs", hash))) {
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
// The agent's plan for the work, in any folder: notes on the work, never the artifact on show.
const PLAN_FILES = ["PLAN.md", "SPEC.md"];
const isPlanFile = path => PLAN_FILES.includes(normalizePath(path).split("/").pop());

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
  if (!/^https?:$/.test(u.protocol) || isLocalHost(u.hostname) || u.origin === location.origin || u.href.startsWith(endpoint)) return null;
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

// isomorphic-git, for a folder project's git, loaded the first time one asks.
const loadGit = () => import(`${CDN["isomorphic-git"]}/+esm`);
// A run serves the root's files beside the journal's, up to these: a bigger project serves the files it touched.
const ROOT_RUN_FILES = 2000, ROOT_RUN_BYTES = 20_000_000;

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
    project: null,    // { id, agentId, name, entry, heads: { path: versionId }, root? } (root: see projects.js)
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
    root: null,       // a folder or GitHub root: { kind, name, status: connected | permission | missing, files, git, branch… }
    versions: [],     // newest first
    notice: null,
    captureChoice: globalThis.localStorage?.getItem(CAPTURE_CHOICE_KEY) ?? null, // allowed | dismissed | null
  });
  let context = {};
  let runQueue = Promise.resolve();
  let root = null, stopWatching = null, noticeTimer = null;
  const runner = host || !frames ? null : frames(id, {
    state, setState,
    notify: message => notify(message),
    resources: (command, args) => sandboxFiles(command, args, { db, threadId: context.threadId, agentId: context.agentId, workspace: { state, readFile, listFiles } }),
  });

  const enqueueRun = fn => { const p = runQueue.then(fn); runQueue = p.catch(() => {}); return p; };
  // Read-modify-commit sections run one at a time, so parallel tool calls never lose an edit. Each starts from
  // the database, since another workspace may have moved the heads. signal: a caller that stops stops waiting.
  const exclusive = (fn, { signal } = {}) => navigator.locks.request("project:" + (state.project?.id ?? null), signal ? { signal } : {}, async () => { await sync(); return fn(); });
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
    return Object.keys(project.heads).sort().find(p => isRenderable(p) && !isScratch(p) && !isPlanFile(p)) ?? null;
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

  // screenshot: true forces one, false skips it, "auto" attaches one while the user shares the tab. full: the whole
  // page instead, as a list of labelled pages (snapshot.js).
  // announce: tell the other workspaces on the project, for a run the engine asked for.
  // signal: a run its caller stopped doesn't start, or stops where it is.
  // tests: { files, path }, test files to run as `node --test` would (see testFiles), reported as path.
  // progress({ status }): the run's steps as it goes, for the card of the call that asked for it.
  function run({ versionId = null, script = null, screenshot = false, full = false, viewport = null, announce = false, signal = null, tests = null, progress = null } = {}) {
    if (host) return hostRun({ versionId, script, screenshot, full, viewport, tests }, signal, progress);
    if (viewport) setState("viewport", viewport);
    return enqueueRun(async () => {
      signal?.throwIfAborted();
      if (tests) return runTests(tests, signal);
      const result = await runNow({ versionId, script, screenshot, full, signal, progress });
      if (announce) channel.postMessage({ projectId: state.project.id, ran: true });
      return result;
    });
  }

  async function hostRun(args, signal, progress = null) {
    const project = state.project;
    if (!project) throw new Error("No project is open.");
    if (args.tests) return host.run({ tests: args.tests, path: null, projectId: project.id, branch, threadId: context.threadId ?? null, agentId: context.agentId ?? null }, { signal, progress });
    const shown = shownPath(project);
    const versionId = args.versionId ?? (shown && project.heads[shown]);
    if (!versionId) throw new Error("Nothing to show yet. Create an artifact with write_file.");
    const path = (await db.get("versions", +versionId))?.path ?? null;
    const result = await host.run({ ...args, versionId: +versionId, path, projectId: project.id, branch, threadId: context.threadId ?? null, agentId: context.agentId ?? null }, { signal, progress });
    if (state.project?.id === project.id && project.heads[path] === +versionId && !isScratch(path)) setState("report", { ...result.report });
    return result;
  }
  // A run nobody waits on; one the user closed the project under has nothing to say.
  const refresh = () => run().catch(e => e.closed || notify(e.message));

  // The runner answers with the report; the version keeps it, as the shown artifact's latest.
  async function runNow({ versionId, script, screenshot, full, signal, progress = null }) {
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
    const files = await servedFiles(project, version.path);
    const missing = isHtml(version.path) ? await missingFiles(version.path, content, p => files[p] ?? null) : [];
    if (missing.length) return { report: { version: version.id, path: version.path, ok: false, errors: missing, notes: ["Not run: the page loads files the workspace doesn't have."] } };
    setState({ running: true, ...(!scratch && { logs: [], preview: isHead ? null : { versionId: version.id, path: version.path, text: content } }) });
    try {
      const { report, image, thumb, runLog } = await runner.run({ version: { id: version.id, path: version.path }, doc, files, script, screenshot, full, parked: scratch, signal, progress });
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

  // What a run serves: the journal's files, over the root's (read on first use, within ROOT_RUN_FILES and
  // ROOT_RUN_BYTES), all but except.
  async function servedFiles(project, except = null) {
    const files = {};
    if (root) {
      let bytes = 0;
      for (const path of root.list().slice(0, ROOT_RUN_FILES)) {
        if (path in project.heads || path === except || isBinaryPath(path)) continue;
        const text = await root.read(path).catch(() => null);
        if (text == null) continue;
        if ((bytes += text.length) > ROOT_RUN_BYTES) break;
        files[path] = text;
      }
    }
    for (const [path, id] of Object.entries(project.heads)) if (path !== except) files[path] = await getBlob(db, (await db.get("versions", id)).hash);
    return files;
  }

  // Test files run off screen, in a page of their own at the top of the folder; the preview and its report stay the
  // shown artifact's.
  async function runTests({ files: tests, path }, signal) {
    const project = state.project;
    if (!project) throw new Error("No project is open.");
    const files = await servedFiles(project);
    // A file that imports one the workspace hasn't got fails without a run, which would only say "failed to fetch".
    const missing = [], broken = [];
    for (const file of tests) {
      const found = (await missingFiles(file, files[file] ?? "", p => files[p] ?? null)).map(f => (f.startsWith("L") ? `${file} ${f}` : f));
      if (found.length) { missing.push(...found); broken.push(file); }
    }
    const runnable = tests.filter(f => !broken.includes(f));
    setState("running", true);
    try {
      const { report } = runnable.length ? await runner.run({ version: { id: null, path: TEST_PAGE }, doc: testDocument(runnable), files, parked: true, signal })
        : { report: { ok: true, errors: [], errorCount: 0, tests: { passed: 0, failed: 0, failures: [] }, console: [] } };
      const { version, viewport, overflow, ...rest } = report;
      const t = rest.tests, ran = t ? t.passed + t.failed : 0;
      if (t && broken.length) Object.assign(t, { failed: t.failed + broken.length, failures: [...broken.map(f => `${f} failed to load`), ...t.failures].slice(0, 5) });
      const notes = [
        ...(broken.length ? [`Not run: ${broken.join(", ")} ${broken.length > 1 ? "load" : "loads"} files the workspace doesn't have.`] : []),
        ...(t && runnable.length && !ran ? [`No test ran: ${runnable.length > 1 ? "these files register" : `${runnable[0]} registers`} none with test() or it() from node:test.`] : []),
        ...(rest.notes ?? []).filter(n => !/TESTS_DONE/.test(n)),
      ];
      const out = { ...rest, path: path || "./", ...(path !== tests[0] && { files: tests.slice(0, 30) }), ok: rest.ok && !missing.length && ran > 0, errors: [...missing, ...rest.errors].slice(0, 5), errorCount: rest.errorCount + missing.length };
      if (rest.timedOut?.includes("tests")) notes.push(`The tests stopped before they finished: look at the test after the last one logged.`);
      if (notes.length) out.notes = notes; else delete out.notes;
      return { report: out, image: null };
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
    detachRoot();
    runner?.reset();
    setState({ project, report: null, preview: null, logs: [], runLog: [], selected: null, focus: false });
    await loadFiles();
    await refreshVersions();
    if (project.root && project.root.kind !== "workspace") await attachRoot().catch(e => notify(e.message));
    if (headless) return state.project;
    // A folder or a repository with nothing to show opens on its files.
    setState({ panel: (!!shownPath() || !!state.root) && globalThis.innerWidth >= 992, ...(state.root && !shownPath() && { tab: "project" }) });
    if (shownPath() && preview) refresh();
    return state.project;
  }

  function close() {
    detachRoot();
    setState({ project: null, files: {}, report: null, preview: null, versions: [], logs: [], runLog: [], panel: false, focus: false, selected: null });
    runner?.blank();
  }

  // root: { kind: "folder", handle } or a GitHub record (projects.js connectGitHub); none is a workspace project.
  async function createProject({ agentId = 1, name = "Untitled", entry = "index.html", content = null, root: record = null } = {}) {
    const now = Date.now();
    const stored = record?.kind === "folder" ? { kind: "folder", name: record.handle.name, handle: storableHandle(record.handle) } : record;
    const projectId = await db.add("projects", { agentId, name, entry, heads: {}, ...(stored && { root: stored }), createdAt: now, updatedAt: now });
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
    let before = head ? await getBlob(db, head.hash) : null, parentId = headId ?? null;
    // A root's file the journal doesn't hold yet starts its history as it was: the root's copy, which the write
    // replaces, or for a change from the disk, the copy the harness last read.
    if (!head && root) {
      const seen = meta.source === "disk" && (await db.get("reads", readKey(path)));
      const base = meta.source === "disk" ? seen && (await getBlob(db, seen.hash)) : await root.read(path).catch(() => null);
      if (base != null && base !== text) {
        const baseVersion = { projectId: state.project.id, path, parentId: null, hash: await putBlob(db, base), size: base.length, lines: countLines(base), source: "base", threadId: null, toolUseId: null, restoredFrom: null, createdAt: Date.now(), report: null, branch };
        parentId = baseVersion.id = await db.add("versions", baseVersion);
        before = base;
        setState("versions", versions => [baseVersion, ...versions].slice(0, 200));
      }
    }
    const version = {
      projectId: state.project.id, path, parentId, hash, size: text.length, lines: countLines(text),
      source: meta.source || "agent", threadId: meta.threadId ?? context.threadId ?? null, toolUseId: meta.toolUseId ?? null,
      restoredFrom: meta.restoredFrom ?? null, createdAt: Date.now(), report: null, branch,
    };
    version.id = await db.add("versions", version);
    // The engine's changes are quiet: the run that follows shows them.
    await saveProject({ heads: { ...unwrap(state.project.heads), [path]: version.id } }, { quiet: !!host && meta.source !== "disk" });
    setState("files", path, text);
    setState("versions", versions => [version, ...versions].slice(0, 200));
    if (meta.source !== "disk" && meta.source !== "base") await writeRoot(path, text);
    return { version, changed: true, before };
  }

  // A file goes from the heads; its versions stay in the history. Call it inside exclusive, as commit. On a folder
  // project it goes from the disk too, as commit's writes do.
  async function remove(path) {
    path = normalizePath(path);
    if (!state.project || !(path in state.project.heads)) return false;
    const { [path]: _, ...heads } = unwrap(state.project.heads);
    await saveProject({ heads }, { quiet: !!host });
    setState("files", path, undefined);
    if (root && !branch) await root.remove(path).catch(e => notify(`Could not remove ${path} from ${root.name}: ${e.message}`));
    return true;
  }

  // A root's file into the journal, as the root has it (to run it, or show it): its version, or null if there is none.
  function adopt(path) {
    path = normalizePath(path);
    return exclusive(async () => {
      if (state.project.heads[path]) return db.get("versions", state.project.heads[path]);
      const text = await readFile(path);
      return text == null ? null : (await commit(path, text, { source: "base" })).version;
    });
  }

  // A file the disk no longer has leaves the journal's heads (its versions stay, for restore).
  async function drop(path) {
    if (!(path in state.project.heads)) return false;
    const heads = { ...unwrap(state.project.heads) };
    delete heads[path];
    await saveProject({ heads });
    setState("files", path, undefined);
    return true;
  }

  async function checkout(heads) {
    if (!state.project || !heads) return false;
    const current = { ...unwrap(state.project.heads) };
    const paths = new Set([...Object.keys(current), ...Object.keys(heads)]);
    if ([...paths].every(p => current[p] === heads[p])) return false;
    await exclusive(async () => {
      await saveProject({ heads: { ...heads } });
      await loadFiles();
      for (const path of Object.keys(heads)) if (heads[path] !== current[path]) await writeRoot(path, state.files[path]);
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
    // The text of a message's <changes> (envelope.js renders it, escaped, or as a <workspace> block under envelope=plain).
    const block = body => body + used;
    if (parentHeads === null) {
      const paths = Object.keys(heads).sort();
      const where = describeRootForAgent();
      if (!paths.length) return where ? block(where) : null;
      const lines = [];
      for (const path of paths) {
        const v = await db.get("versions", heads[path]);
        const shown = path === shownPath() ? isHtml(path) ? " (shown, runs with its tests)" : " (shown)" : "";
        lines.push(`- ${path} v${v.id}, ${v.lines} lines${shown}`);
      }
      const last = state.report ? `\nLast run of v${state.report.version}: ${summarizeReport(state.report)}` : "";
      return block(`${where ? where + "\n" : ""}Artifacts in this chat:\n${lines.join("\n")}${last}`);
    }
    const changed = [...new Set([...Object.keys(heads), ...Object.keys(parentHeads)])].filter(p => heads[p] !== parentHeads[p]).sort();
    if (!changed.length) return used ? block("No file changes since your last turn.") : null;
    const parts = [];
    for (const path of changed) {
      let from = parentHeads[path] ? await db.get("versions", parentHeads[path]) : null;
      const to = heads[path] ? await db.get("versions", heads[path]) : null;
      // A root's file the journal took in with this change: compared with the file as the harness first read it.
      if (!from && to?.parentId) from = await db.get("versions", to.parentId).then(v => (v?.source === "base" ? v : null));
      // One taken in as it was (to run it) is no change.
      if (!from && to?.source === "base") continue;
      const a = from ? await getBlob(db, from.hash) : "", b = to ? await getBlob(db, to.hash) : "";
      const label = `${path}: ${from ? "v" + from.id : "new"} → ${to ? `v${to.id} (${to.source})` : "removed"}`;
      const patch = createTwoFilesPatch(path, path, a, b, from ? `v${from.id}` : "", to ? `v${to.id}` : "", { context: 2 });
      parts.push(label + "\n" + truncate(patch.split("\n").slice(2).join("\n"), 4000));
    }
    if (!parts.length) return used ? block("No file changes since your last turn.") : null;
    return block(`Files changed outside your edits since your last turn:\n${parts.join("\n\n")}`);
  }

  async function readFile(path) {
    path = normalizePath(path || shownPath() || state.project?.entry);
    if (path in state.files) return state.files[path];
    if (!root) return null;
    const text = await root.read(path).catch(() => null);
    // Remembered as last read, so a change the user makes on disk later shows as a change from it.
    if (text != null) await db.put("reads", { key: readKey(path), hash: await putBlob(db, text), createdAt: Date.now() });
    return text;
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
    if (root) for (const path of root.list()) paths.add(path);
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

  // #region Roots: a folder or a repository under the journal (projects.js)
  const readKey = path => `${state.project.id}:${path}`;

  async function writeRoot(path, text) {
    if (!root || branch || text == null) return;
    try {
      await root.write(path, text);
    } catch (e) {
      notify(`Could not write ${path} to ${root.name}: ${e.message}`);
    }
  }

  // The root as the panel shows it.
  async function describeRoot() {
    if (!root) return null;
    if (root.kind === "folder") return { kind: "folder", name: root.name, status: "connected", files: root.list().length, large: root.large.length, git: await root.git.present() };
    const r = unwrap(state.project.root) ?? root.record;
    return { kind: "github", name: root.name, status: "connected", files: root.list().length, git: true, branch: r.branch, from: r.from, defaultBranch: r.defaultBranch,
      base: r.base.commit, commits: r.commits.length, truncated: !!r.base.truncated, pullRequest: r.pullRequest ?? null };
  }
  const showRoot = async () => setState("root", await describeRoot());

  // What the agent is told about the root in a chat's first message.
  function describeRootForAgent() {
    const r = state.root;
    if (!r) return null;
    if (r.status !== "connected") return `This project is the folder "${r.name}" on the user's disk, but ${r.status === "permission" ? "this session may not read it until the user clicks Reconnect in the panel" : "this browser can't reach it"}: only the files below are here.`;
    if (r.kind === "folder") return `This project is the folder "${r.name}" on the user's disk: ${r.files} files${r.git ? ", a git repository" : ""}. Your writes go to the disk at once; the user's own edits there come back as changes.`;
    return `This project is the GitHub repository ${r.name} at ${r.base.slice(0, 7)} on ${r.from}: ${r.files} files. Your writes stay here until pushed to a branch (the default branch, ${r.defaultBranch}, only with the user's yes).`;
  }

  // Connects the project's root: a folder needs the user's permission, which Chrome remembers when they allow it on
  // every visit; ask (a click) asks for it. mirror: the journal's files the folder lacks are written out (an app
  // saved to a new folder); otherwise a file the disk lost leaves the heads. Either way the disk wins.
  async function attachRoot({ ask = false, mirror = false } = {}) {
    detachRoot();
    const record = unwrap(state.project?.root);
    if (!record || record.kind === "workspace") return null;
    if (record.kind === "github") {
      root = createGitHubRoot(record, {
        token: githubToken, patch: createTwoFilesPatch, files: async () => ({ ...unwrap(state.files) }), current: () => unwrap(state.project?.root),
        save: async changes => { await saveProject({ root: { ...unwrap(state.project.root), ...changes } }); },
      });
      await showRoot();
      return root;
    }
    const handle = liveHandle(record.handle);
    if (!handle) { setState("root", { kind: "folder", name: record.name, status: "missing" }); return null; }
    const mode = { mode: "readwrite" };
    let permission = (await handle.queryPermission?.(mode)) ?? "granted";
    if (permission !== "granted" && ask) permission = await handle.requestPermission(mode);
    if (permission !== "granted") { setState("root", { kind: "folder", name: handle.name, status: "permission" }); return null; }
    root = createFolderRoot(handle, { git: { load: loadGit, patch: createTwoFilesPatch }, Observer: isMemoryDirectory(handle) ? MemoryObserver : globalThis.FileSystemObserver });
    await root.ready();
    await showRoot();
    if (branch) return root;
    // What changed while nobody watched: the journal's files, and the ones the harness had read.
    const changes = [];
    for (const path of Object.keys(state.files)) {
      if (root.has(path)) changes.push({ path, type: "modified" });
      else if (mirror) await writeRoot(path, state.files[path]);
      else changes.push({ path, type: "removed" });
    }
    const prefix = state.project.id + ":";
    for (const key of await db.getAllKeys("reads", IDBKeyRange.bound(prefix, prefix + "\uffff"))) {
      const path = key.slice(prefix.length);
      if (!(path in state.files) && root.has(path)) changes.push({ path, type: "modified" });
    }
    await onRootChanges(changes);
    const unlisten = root.watch(changes => onRootChanges(changes).catch(e => notify(`Folder sync failed: ${e.message}`)));
    stopWatching = () => { unlisten(); root?.unwatch(); };
    return root;
  }

  function detachRoot() {
    stopWatching?.();
    stopWatching = null;
    root?.unwatch();
    root = null;
    setState("root", null);
  }

  // The user's edits on disk: a file the journal holds, or one the harness has read, gets a version from the disk
  // (the disk wins); a file nobody has read is read fresh when it is. One the disk lost leaves the heads.
  async function onRootChanges(changes) {
    if (!state.project || !root) return;
    let shown = false;
    for (const { path, type } of changes) {
      if (type === "removed") {
        if (path in state.files && (await exclusive(() => drop(path))) && path === shownPath()) shown = true;
        continue;
      }
      if (!(path in state.files)) {
        const seen = await db.get("reads", readKey(path));
        if (!seen) continue;
      }
      const text = await root.read(path).catch(() => null);
      if (text == null) continue;
      const { changed } = await exclusive(async () => {
        if (path in state.files ? state.files[path] === text : await db.get("reads", readKey(path)).then(async r => !r || (await getBlob(db, r.hash)) === text)) return { changed: false };
        return commit(path, text, { source: "disk" });
      });
      if (changed && path === shownPath()) shown = true;
    }
    if (changes.length) await showRoot();
    if (shown && !headless) refresh();
  }

  // Saves the open project to a folder the user picks: its files are written there, and it becomes a folder project.
  async function openFolder({ handle = null } = {}) {
    if (!state.project) return openFolderProject({ handle });
    handle ??= await pickFolder();
    await saveProject({ root: { kind: "folder", name: handle.name, handle: storableHandle(handle) } });
    await attachRoot({ mirror: true });
  }

  async function pickFolder() {
    if (!globalThis.showDirectoryPicker) throw new Error("This browser can't open local folders (Chrome and Edge can): connect a GitHub repository instead.");
    return globalThis.showDirectoryPicker({ id: "chat-harness", mode: "readwrite" });
  }

  // A folder on disk as a new project: its files are listed at once, read when first needed.
  async function openFolderProject({ handle = null, agentId = context.agentId ?? 1 } = {}) {
    handle ??= await pickFolder();
    const project = await createProject({ agentId, name: handle.name, root: { kind: "folder", handle } });
    if (state.root?.status === "connected" && state.root.files === 0) notify(`${handle.name} has no files the project lists (dependencies, build output and .gitignore'd files are left out).`);
    return project;
  }

  // A GitHub repository's branch as a new project: its tree is listed, its files fetched when first needed.
  async function connectRepository({ owner, repo, branch: name = null, agentId = context.agentId ?? 1 } = {}) {
    const record = await connectGitHub({ owner, repo, branch: name, token: githubToken() });
    const project = await createProject({ agentId, name: `${owner}/${repo}`, root: record });
    if (record.base.truncated) notify(`${owner}/${repo} is too big for one listing: GitHub truncated its tree.`);
    return project;
  }

  // One click re-grants a folder Chrome forgot (or remembers, with "Allow on every visit").
  const reconnect = () => attachRoot({ ask: true });

  async function rescan() {
    if (!root) return [];
    const { changes } = await root.scan();
    await onRootChanges(changes);
    await showRoot();
    return changes;
  }

  // git on the project, for the shell's git and gh commands: a folder's own repository (isomorphic-git), or the
  // connected GitHub branch. status, diff, log, branch, commit; push and openPullRequest for GitHub only.
  const NO_GIT = "This project has no git: open a folder (with a .git) or connect a GitHub repository.";
  const git = Object.fromEntries(["status", "diff", "log", "branch", "commit", "push", "pull", "openPullRequest", "init"].map(name => [name, async (args = {}) => {
    if (!root) throw new Error(state.root?.status === "permission" ? `${state.root.name} needs your permission again: click Reconnect.` : NO_GIT);
    const fn = root.git?.[name];
    if (!fn) throw new Error(`git ${name} isn't available on a ${root.kind} project.`);
    // GitHub's commits and pushes read the working copy and write the root's record: one at a time, from the database.
    const result = root.kind === "github" && name !== "status" && name !== "diff" && name !== "log" ? await exclusive(() => fn(args)) : await fn(args);
    if (["commit", "push", "branch", "openPullRequest", "init"].includes(name)) await showRoot();
    return result;
  }]));
  // A GitHub project's CI (projects.js createGitHubCI): read only, so nothing waits on the project's lock.
  git.ci = Object.fromEntries(["hasWorkflows", "checks", "runs", "run", "jobs", "failedLog", "waitForChecks", "waitForRun", "pullRequest"].map(name => [name, (...args) => {
    const fn = root?.git?.ci?.[name];
    if (!fn) throw new Error(root ? `CI is a GitHub project's: this is a ${root.kind} project.` : NO_GIT);
    return fn(...args);
  }]));
  // #endregion

  async function captureView() {
    if (!shownPath()) throw new Error("Nothing is shown yet.");
    return runner.captureView(shownPath());
  }

  function dispose() {
    channel.close();
    runner?.dispose();
    detachRoot();
    clearTimeout(noticeTimer);
  }

  return {
    id, state, setState, notify, shownPath, show, select, rememberCapture: runner?.rememberCapture, captureView,
    open, close, createProject, ensureProject, commit, remove, checkout, describeChanges,
    readFile, readVersion, listFiles, listVersions, diff, restore, userEdit, exclusive,
    run, preview: versionId => run({ versionId }),
    setContext: value => { context = { ...context, ...value }; },
    rename: name => saveProject({ name }),
    mountPreview: runner?.mountPreview, enableCapture: runner?.enableCapture, disableCapture: runner?.disableCapture,
    liveErrors: () => runner?.liveErrors() ?? [],
    openFolder, openFolderProject, connectRepository, reconnect, rescan, adopt, git, get root() { return root; }, dispose,
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

// Model code runs on the tab's own thread, so an endless loop freezes the tab and no timer can fire to stop it
// (CodePen's "loop protect"). Every loop body is opened with a call to the guard loopGuard puts in the frame:
// `for (;;) x()` becomes `for (;;) {G;x()}`. Only insertions, none with a newline, so error lines stay. Optional,
// so a file also loaded where no guard is (a worker) runs as written. null when the code doesn't parse.
const LOOP_CALL = "globalThis.__harnessLoop?.();";
function guardSource(acorn, code, module) {
  let ast;
  try { ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: module ? "module" : "script", allowHashBang: true }); } catch { return null; }
  const edits = [];
  (function walk(node) {
    if (/^(For|ForIn|ForOf|While|DoWhile)Statement$/.test(node.type)) {
      const { body } = node;
      if (body.type === "BlockStatement") edits.push([body.start + 1, LOOP_CALL]);
      else edits.push([body.start, "{" + LOOP_CALL], [body.end, "}"]);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const v of value) v?.type && walk(v);
      else if (typeof value?.type === "string") walk(value);
    }
  })(ast);
  return edits.sort((a, b) => b[0] - a[0]).reduce((text, [at, insert]) => text.slice(0, at) + insert + text.slice(at), code);
}

// JS (a module, or else a classic script), or an HTML page's inline scripts. guarded: false when acorn didn't load
// or something didn't parse, which then runs as written.
async function guardLoops(source, { html = false } = {}) {
  const acorn = await loadAcorn();
  if (!acorn) return { source, guarded: false };
  if (!html) {
    const out = guardSource(acorn, source, true) ?? guardSource(acorn, source, false);
    return { source: out ?? source, guarded: out != null };
  }
  let guarded = true;
  const out = scriptsOf(source).reduceRight((text, s) => {
    const code = guardSource(acorn, s.code, s.module);
    if (code == null) guarded = false;
    return code == null ? text : text.slice(0, s.start) + code + text.slice(s.end);
  }, source);
  return { source: out, guarded };
}

// Stringified into a frame. The guard throws once the code's own timeout has passed, or once the thread has gone
// `limit` ms without a task turn: a loop that awaits a timer yields, and is left alone. The clock is read every
// 128th call; a read on every one made a tight loop 25× slower. A MessageChannel isn't throttled in a hidden tab
// as timers are, so a yield is seen as soon as it happens.
function loopGuard(limit, timeout = Infinity) {
  const deadline = Date.now() + timeout, channel = new MessageChannel();
  let calls = 0, since = 0;
  channel.port1.onmessage = () => { since = 0; };
  globalThis.__harnessLoop = () => {
    if (++calls & 127) return;
    const now = Date.now();
    if (!since) { since = now; channel.port2.postMessage(0); }
    if (now > deadline || now - since > limit) {
      const message = `Loop ran past ${now > deadline ? timeout : limit} ms: stopped by the harness`;
      globalThis.__harnessLoopStopped = message;
      throw new Error(message);
    }
  };
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

// A project's tests as `node --test` runs them, though there is no Node here: run_app on a test file, a folder or a
// glob runs a page whose import map points node:test, node:assert and the common runners at node-test.js beside this
// file, imports each test file from the workspace (its relative imports load the workspace's files), and reports the
// counts. Why: Haiku planned `node --test`, found no way to run a repository's tests, and settled for checking that
// its edits' text was there (docs/experiments/LOG.md, E10).
const NODE_TEST_URL = new URL("./node-test.js", import.meta.url).href;
const TEST_FILE = /(^|\/)([^/]*\.test\.m?js|test[^/]*\.m?js)$/;
// The page that runs them, at the top of the folder; no file of the project is served in its place.
const TEST_PAGE = "__tests__.html";
const globPattern = glob => new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\?/g, "[^/]")
  .replace(/\*\*\/|\*\*|\*/g, m => (m === "**/" ? "(?:.*/)?" : m === "**" ? ".*" : "[^/]*")) + "$");

// The test files a path names: a .js or .mjs file itself, the test files in a folder (every *.test.js, *.test.mjs
// and test*.js under it), or those a glob matches. null for a path that names none of these, such as a page.
function testFiles(path, heads) {
  const target = normalizePath(path ?? "");
  const files = Object.keys(heads).filter(p => !p.split("/").includes("node_modules")).sort();
  if (/\.m?js$/i.test(target) && heads[target]) return [target];
  if (target.includes("*")) return files.filter(p => globPattern(target).test(p));
  const dir = target.replace(/\/$/, "");
  if (heads[dir]) return null;
  const under = files.filter(p => !dir || p.startsWith(dir + "/"));
  return dir && !under.length ? null : under.filter(p => TEST_FILE.test(p));
}

// What each specifier imports: node-test.js's parts under the names Node and the runners give them.
function testImports(url = NODE_TEST_URL) {
  const from = JSON.stringify(url);
  const mod = source => "data:text/javascript," + encodeURIComponent(source);
  const asserts = name => mod(`import { ${name} as a } from ${from};\nexport default a;\nexport const { ok, equal, notEqual, strictEqual, notStrictEqual, deepEqual, notDeepEqual, deepStrictEqual, notDeepStrictEqual, throws, doesNotThrow, rejects, doesNotReject, match, doesNotMatch, ifError, fail, strict, AssertionError } = a;`);
  const nodeTest = mod(`export { default, test, it, describe, suite, before, after, beforeEach, afterEach, mock, run } from ${from};`);
  return {
    "node:test": nodeTest,
    "node:assert": asserts("assert"), assert: asserts("assert"),
    "node:assert/strict": asserts("strict"), "assert/strict": asserts("strict"),
    uvu: mod(`export { uvuSuite as suite, uvuTest as test } from ${from};`),
    "uvu/assert": mod(`import { uvuAssert as a } from ${from};\nexport const { ok, is, equal, type, instance, match, snapshot, fixture, throws, unreachable, not, Assertion } = a;`),
    tape: mod(`export { tape as default, tape as test } from ${from};`),
  };
}

function testDocument(files, url = NODE_TEST_URL) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Tests</title>
<script type="importmap">${JSON.stringify({ imports: testImports(url) })}<\/script>
</head>
<body>
<pre id="out">running…</pre>
<script type="module">
import { runFiles } from ${JSON.stringify(url)};
const result = await runFiles(${JSON.stringify(files.map(f => "./" + f))}, { base: new URL(".", location.href).href });
document.getElementById("out").textContent = result.passed + " passed, " + result.failed + " failed";
window.TESTS_DONE = result;
<\/script>
</body>
</html>
`;
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
    // noProjectError=old is the text before da412ed, which preceded a 2,317-line app for a prose plan (E9).
    if (!create) throw new Error(flag("noProjectError") === "old" ? "No project is open yet. Create the app with write_file." : "No project is open: there are no files yet.");
    await ws.ensureProject({ agentId: context.agentId, threadId: context.threadId });
  }
  return ws;
}

// Files a tool hands back as themselves, beside its JSON: an image the model sees, a PDF it reads. Each kind has the
// largest size Bedrock takes; Claude and Gemini read both inside a tool result, Sol and Luna see images beside it.
const MEDIA = { png: ["image", 3.75e6], jpeg: ["image", 3.75e6], gif: ["image", 3.75e6], webp: ["image", 3.75e6], pdf: ["document", 4.5e6] };
// An image block whose bytes start as its format's do. An empty file named .jpg (a model's test photo, E29) is not one.
const MAGIC = { png: [0x89, 0x50, 0x4e, 0x47], jpeg: [0xff, 0xd8, 0xff], gif: [0x47, 0x49, 0x46, 0x38], webp: [0x52, 0x49, 0x46, 0x46] };
function isImage({ format, source } = {}) {
  let bytes = source?.bytes;
  if (typeof bytes === "string") try { bytes = Uint8Array.from(atob(bytes.slice(0, 24)), ch => ch.charCodeAt(0)); } catch { return false; }
  const magic = MAGIC[format];
  return !!bytes?.length && (!magic || magic.every((b, i) => bytes[i] === b));
}
const withMedia = (result, ...files) => (files = files.filter(Boolean)).length ? { ...result, __media: files } : result;
// Bedrock allows a document name letters, digits, single spaces, hyphens, parentheses, and brackets.
const documentName = name => (name || "document").replace(/[^A-Z0-9 \-()[\]]+/gi, "-").replace(/\s+/g, " ").trim().slice(0, 200) || "document";
const mediaBlock = ({ format, bytes, name }) => MEDIA[format][0] === "image"
  ? { image: { format, source: { bytes } } }
  : { document: { format, name: documentName(name), source: { bytes } } };

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
  // The plan is the agent's notes on the work, not the work: the panel keeps showing the artifact.
  if (isPlanFile(version.path)) return result;
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

async function runApp({ path, version, viewport, script, screenshot = true, full = false } = {}, context = {}) {
  return attempt(async () => {
    const ws = await workspaceFor(context);
    if (viewport && viewport !== "fit" && !Object.hasOwn(VIEWPORTS, viewport)) viewport = null;
    // A test file, a folder or a glob runs its tests as `node --test` would.
    // A folder's or repository's files count as the journal's.
    const known = ws.root ? { ...Object.fromEntries((await ws.listFiles()).map(p => [p, true])), ...ws.state.project.heads } : ws.state.project.heads;
    const tests = path && version == null && !isHtml(path) ? testFiles(path, known) : null;
    if (tests && !tests.length) return { error: `No test files in ${normalizePath(path) || "the project"}: a folder runs its *.test.js, *.test.mjs and test*.js files. Name a file to run another.` };
    const progress = context.progress ?? null;
    if (tests) {
      progress?.({ status: `running ${tests.length} test file${tests.length === 1 ? "" : "s"}…` });
      return { report: (await ws.run({ tests: { files: tests, path: normalizePath(path) }, signal: context.signal, progress })).report };
    }
    // A version names its own file, a variant's on its branch too; path picks the current one. A root's file the
    // journal doesn't hold yet comes in as the root has it.
    let head = path && version == null && ws.state.project.heads[normalizePath(path)];
    if (path && version == null && !head && ws.root?.has(normalizePath(path))) head = (await ws.adopt(normalizePath(path)))?.id;
    if (path && version == null && !head) return { error: await missingFile(ws, normalizePath(path), context) };
    progress?.({ status: "loading the page…" });
    const { report, image } = await ws.run({ versionId: version ?? head ?? null, script: script || null, screenshot, full: full === true, viewport, signal: context.signal, progress });
    return withMedia({ report }, ...[image].flat());
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
    return parseFloat(numStr);
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
  CAPTURE_CHOICE_KEY, CDN, CHANNEL_RULES, CORS_BLOCKED, DB_VERSION, DEFAULT_MODEL, DIRECTOR_RULES, FLAGS_KEY, REFUSAL_TEXT, newDayNote, stepMetadata, userMetadata, PRE_DIRECTOR_RULES, activeRules, flag, LOCAL_PROXY, MEMORY_BUDGET, MODELS, PROTOCOL,
  PROXY_CONFIG_KEY, SHELL_DB, TOOLS, VIEWPORTS, WORKSPACE_TOOL_NAMES, appendReasoning, applyEdits, blobCache, contractState, contradictedClaim,
  countLines, countRepeats, createDirector, createWorkspace, describeCheck, editFile, editor, renderPlan, runCheck, ensureDefaultAgent, escapeHtml, failingReport, forkOf, getBlob, getContentBlock,
  getConverseClient, getConverseCommand, getProxyConfig, getToolResults, guardLoops, initDB, inspectArgs, isHtml, isLocalHost,
  isPlanFile, isRenderable, isScratch, listHistory, loopGuard, mcp, memoriesBlock, missingFiles, modelInfo, normalizePath, outline, overlap,
  ownedTools, parseJSON, parsePatch, plainError, polishedTake, preflight, prepareMessages, processStreamChunk,
  providerOf, proxyFetch, proxyRewrite, readUrl, reasoningFields, reasoningLevel, relayUrl, restoreVersion,
  runAgentWithBranching, runApp, runningSubagents, sameView, shellTool, sandboxFiles, sandboxResources, serve, setSubagent,
  siblingFiles, silentReply, sleep, snapshotSettings, storedJSON, storedProxyConfig, summarizeReport, systemPrompt,
  task, think, timeAgo, toDocument, toError, toResultValue, unadoptedVariants, unmuteScripts, unplannedTask, untestedChange,
  viewFile, waitSubagents, watchedSend, webSearch, webToolNames, writeFile,
};
