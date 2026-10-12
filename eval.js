// Runs the chat harness against real models on fixed tasks, grades each run, and keeps every transcript.
// npm run eval -- [--tasks a,b | inner | holdout | hard | game | answer | answer-holdout | swe | research | answer-hard] [--models haiku (default) | haiku,sonnet,opus,luna,gemini | all] [--repeat n] [--concurrency n]
//                 [--system persona.md] [--baseline run-id] [--reasoning off|low|medium|high (default)|xhigh|max] [--headed] [--yes (needed above MAX_UNCONFIRMED jobs)]
// A task with a rubric is also graded by a judge model (evals/judge.js); its criteria join the checks.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startProxy } from "./proxy.js";
import { startServer } from "./server.js";
import TASKS from "./evals/tasks.js";
import { judge, judgedChecks } from "./evals/judge.js";
import { mannered } from "./evals/style.js";

const MODELS = {
  fable: "global.anthropic.claude-fable-5-1",
  opus: "global.anthropic.claude-opus-5-5",
  sonnet: "global.anthropic.claude-sonnet-5-5",
  haiku: "global.anthropic.claude-haiku-5-5",
  sol: "global.openai.gpt-6.1-sol",
  luna: "global.openai.gpt-6-luna",
  grok: "global.xai.grok-4.7",
  gemini: "gemini-3.8-flash",
};
const TURN_TIMEOUT = 10 * 60_000;
// A reply may finish before its loading state is seen, so waiting for it to start is only a short grace.
const START_TIMEOUT = 5_000;
// Every job calls paid APIs: more than this many must be confirmed with --yes.
export const MAX_UNCONFIRMED = 20;
const root = path.dirname(fileURLToPath(import.meta.url));
export const SETS = ["inner", "holdout", "hard", "game", "answer", "answer-holdout", "swe", "research", "answer-hard"];
const LEVELS = ["off", "low", "medium", "high", "xhigh", "max"];

export function options(argv, tasks = TASKS) {
  const o = { tasks: "inner", models: "haiku", repeat: 1, concurrency: 3, system: null, baseline: null, reasoning: "high", headed: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i].startsWith("--") ? argv[i].slice(2) : null;
    if (flag === "headed" || flag === "yes") o[flag] = true;
    else if (flag && Object.hasOwn(o, flag)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) fail(`--${flag} needs a value`);
      o[flag] = value;
    } else fail("Unknown option: " + argv[i]);
  }
  const count = flag => {
    const n = Number(o[flag]);
    return Number.isInteger(n) && n >= 1 ? n : fail(`--${flag} must be a positive integer, got ${o[flag]}`);
  };
  if (!LEVELS.includes(o.reasoning)) fail(`--reasoning must be one of ${LEVELS.join(", ")}, got ${o.reasoning}`);
  const chosen = SETS.includes(o.tasks) ? tasks.filter(t => t.set === o.tasks) : o.tasks === "all" ? tasks : o.tasks.split(",").map(id => tasks.find(t => t.id === id) ?? fail("Unknown task: " + id));
  const models = (o.models === "all" ? Object.keys(MODELS) : o.models.split(",")).map(m => [m, Object.hasOwn(MODELS, m) ? MODELS[m] : fail("Unknown model: " + m)]);
  return { ...o, tasks: chosen, models, repeat: count("repeat"), concurrency: count("concurrency") };
}

// Where a workspace file is written: under files/, or null for a path that would leave it (absolute, "..", a drive)
// or that Windows can't name (a device such as NUL or com1.txt, a ":" in a segment, a trailing dot or space).
const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
export function filePath(dir, file) {
  if (typeof file !== "string" || !file) return null;
  if (file.split(/[\\/]/).some(s => DEVICE.test(s) || s.includes(":") || /[. ]$/.test(s) && s !== "." && s !== "..")) return null;
  const base = path.resolve(dir, "files");
  const target = path.resolve(base, file);
  return target.startsWith(base + path.sep) ? target : null;
}

// Pass rates over the runs that were graded. A run that crashed or didn't finish its turns is a harness failure:
// it has no score and is reported apart.
const graded = r => !r.crashed && !r.error && r.total > 0;
export function summarize(results) {
  const scored = results.filter(graded);
  const mean = scored.length ? scored.reduce((n, r) => n + r.passed / r.total, 0) / scored.length : null;
  return { mean, scored: scored.length, crashed: results.filter(r => r.crashed), unfinished: results.filter(r => !r.crashed && r.error) };
}
export function meanLine(results, baseline) {
  const now = summarize(results), was = baseline && summarize(baseline);
  const line = now.mean === null ? "no graded runs" : `mean pass ${now.mean.toFixed(2)} over ${now.scored} graded runs`;
  return line + (was ? ` (baseline ${was.mean === null ? "no graded runs" : was.mean.toFixed(2)})` : "");
}
const fail = message => { throw new Error(message); };

// The conversation as the user saw it: typed messages and the assistant's text, one entry per reply. Echo turns
// that only placed a file are left out; a reply seeded with { said } stays, marked seeded.
export function dialogue(messages) {
  const out = [];
  let seeding = false;
  for (const m of messages) {
    const text = m.content.filter(b => b.text && !b.harness).map(b => b.text).join("\n").trim();
    if (m.role === "user") {
      if (!text) continue; // tool results
      try { seeding = typeof JSON.parse(text) === "object"; } catch { seeding = false; }
      if (!seeding) out.push({ role: "user", text });
    } else if (text && !seeding && !text.startsWith('Echo: received "')) {
      const last = out.at(-1);
      if (last?.role === "assistant") last.text += "\n\n" + text;
      else out.push({ role: "assistant", text, ...(m.modelId === "echo" && { seeded: true }) });
    }
  }
  return out;
}

// Everything the app stored, read straight from IndexedDB. Bytes become base64 so they survive the trip out.
async function collect(page) {
  return page.evaluate(async () => {
    const request = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const db = await request(indexedDB.open("chat"));
    const all = name => request(db.transaction(name).objectStore(name).getAll());
    const [threads, messages, versions, blobs, agents, projects] = await Promise.all(["threads", "messages", "versions", "blobs", "agents", "projects"].map(all));
    const unzip = async bytes => new TextDecoder().decode(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
    const text = Object.fromEntries(await Promise.all(blobs.map(async b => [b.hash, await unzip(b.content)])));
    const b64 = bytes => { let s = ""; for (const c of bytes) s += String.fromCharCode(c); return btoa(s); };
    const plain = v => ArrayBuffer.isView(v) || v instanceof ArrayBuffer ? { base64: b64(new Uint8Array(v.buffer ?? v)) }
      : Array.isArray(v) ? v.map(plain) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v;
    return plain({ threads, messages, projects, versions: versions.map(v => ({ ...v, text: text[v.hash] })), persona: agents.find(a => a.id === 1)?.systemPrompt });
  });
}

// Files the user already has, as if they opened their folder: a project holds them and the chat starts in it,
// so the model meets them in the <workspace> block, not in its history.
async function openFolder(page, base, files) {
  const projectId = await page.evaluate(async files => {
    const { initDB, createWorkspace } = await import("/engine.js");
    const ws = createWorkspace(await initDB(), { headless: true });
    const [entry, ...rest] = Object.keys(files);
    await ws.createProject({ name: "Folder", entry, content: files[entry] });
    for (const path of rest) await ws.userEdit(path, files[path]);
    const { id } = ws.state.project;
    ws.dispose();
    return id;
  }, files);
  await page.goto(base + `index.html?projectId=${projectId}`);
  await page.waitForSelector("form#inputForm");
}

// The engine runs in a SharedWorker, whose requests the page never sees; CDP attaches to the worker of this page's
// context (the browser's other contexts run other evals) and reads each model request's body.
async function watchRequests(browser, page, onRequest) {
  const { targetInfo: { browserContextId } } = await (await page.context().newCDPSession(page)).send("Target.getTargetInfo");
  const cdp = await browser.newBrowserCDPSession();
  const pending = new Map();
  let id = 0;
  const call = (sessionId, method, params = {}) => new Promise(resolve => {
    pending.set(++id, resolve);
    cdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method, params }) }).catch(() => {});
  });
  cdp.on("Target.receivedMessageFromTarget", async ({ sessionId, message }) => {
    const m = JSON.parse(message);
    if (pending.has(m.id)) return pending.get(m.id)(m.result ?? {}), pending.delete(m.id);
    // A worker whose last page left ends, but its target stays attached, and the one the next page starts on it
    // waits for a debugger: this is the debugger, so it says go.
    if (m.method === "Runtime.executionContextsCleared") return setTimeout(() => call(sessionId, "Runtime.runIfWaitingForDebugger"), 100);
    const r = m.method === "Network.requestWillBeSent" && m.params.request;
    if (!r || !/bedrock-runtime|generativelanguage/.test(r.url) || !(r.postData || r.hasPostData)) return;
    onRequest(r.url, r.postData ?? (await call(sessionId, "Network.getRequestPostData", { requestId: m.params.requestId })).postData ?? "");
  });
  cdp.on("Target.targetCreated", async ({ targetInfo: t }) => {
    if (t.type !== "shared_worker" || t.browserContextId !== browserContextId) return;
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: false });
    await call(sessionId, "Network.enable");
    await call(sessionId, "Runtime.enable");
  });
  await cdp.send("Target.setDiscoverTargets", { discover: true });
}

// Where a request stopped repeating an earlier one, so its cache read ended there. Each is set against the earlier
// request with the same system and tools that it repeats furthest: a fork's repeats its parent's, and the parent's
// next repeats the parent's last. Cache points are left out; they move by design.
function prefixBreaks(bodies) {
  const parsed = bodies.map(body => {
    const j = JSON.parse(body || "{}", (k, v) => (Array.isArray(v) ? v.filter(x => !x?.cachePoint) : v));
    return { head: JSON.stringify([j.system ?? j.systemInstruction, j.toolConfig ?? j.tools]), messages: (j.messages ?? j.contents ?? []).map(m => JSON.stringify(m)) };
  });
  const breaks = [];
  parsed.forEach((now, i) => {
    const repeated = before => { let n = 0; while (n < before.messages.length && before.messages[n] === now.messages[n]) n++; return n; };
    const [best, n] = parsed.slice(0, i).filter(p => p.head === now.head).map(p => [p, repeated(p)]).reduce((a, b) => (b[1] >= a[1] ? b : a), [null, -1]);
    if (!best || n === best.messages.length) return;
    const was = best.messages[n], is = now.messages[n] ?? "";
    let at = 0;
    while (was[at] === is[at]) at++;
    breaks.push({ request: i, message: n, of: best.messages.length, was: was.slice(Math.max(0, at - 60), at + 120), now: is.slice(Math.max(0, at - 60), at + 120) });
  });
  return breaks;
}

async function send(page, text, modelId, reasoning, timeout = TURN_TIMEOUT) {
  await page.selectOption("#modelId", modelId);
  await page.locator("#reasoningMode").evaluate((input, level) => { input.value = level; }, reasoning || "off");
  await page.fill("#userMessage", text);
  const loading = v => page.waitForFunction(v => document.querySelector("form#inputForm")?.dataset.loading === v, v, { timeout, polling: 250 });
  await page.locator("form#inputForm").evaluate(form => form.requestSubmit());
  await page.waitForFunction(() => document.querySelector("form#inputForm")?.dataset.loading === "true", null, { timeout: START_TIMEOUT, polling: 100 }).catch(() => {});
  await loading("false");
}

function metrics(messages, subagents, ms, forkTurns = []) {
  const forkUsage = forkTurns.map(m => m.usage).filter(Boolean);
  const forkSum = key => forkUsage.reduce((total, u) => total + (u[key] || 0), 0);
  const forkInput = forkSum("inputTokens") + forkSum("cacheReadInputTokens") + forkSum("cacheWriteInputTokens");
  const assistant = messages.filter(m => m.role === "assistant" && m.modelId !== "echo"); // echo turns are the eval's seeds
  const calls = assistant.flatMap(m => m.content.filter(b => b.toolUse).map(b => b.toolUse));
  const results = new Map(messages.flatMap(m => m.content.filter(b => b.toolResult).map(b => [b.toolResult.toolUseId, b.toolResult.status === "error" ? { error: b.toolResult.content[0]?.text } : b.toolResult.content.find(c => c.json)?.json?.result])));
  const usage = [...assistant, ...subagents].map(m => m.usage).filter(Boolean);
  const sum = key => usage.reduce((total, u) => total + (u[key] || 0), 0);
  const input = sum("inputTokens") + sum("cacheReadInputTokens") + sum("cacheWriteInputTokens");
  const edits = calls.filter(c => c.name === "edit_file");
  return {
    turns: assistant.length,
    calls: calls.length,
    byTool: Object.fromEntries(Object.entries(Object.groupBy(calls, c => c.name)).map(([k, v]) => [k, v.length])),
    parallelTurns: assistant.filter(m => m.content.filter(b => b.toolUse).length > 1).length,
    editsPerCall: edits.length ? +(edits.reduce((n, c) => n + (typeof c.input?.patch === "string" ? c.input.patch.match(/^\s*<{5,9}/gm)?.length || 0 : 0), 0) / edits.length).toFixed(1) : 0,
    // run_app with nothing new to show, right after a change that already reported
    redundantRunApp: calls.filter((c, i) => c.name === "run_app" && !c.input?.script && !c.input?.viewport && ["edit_file", "write_file"].includes(calls[i - 1]?.name)).length,
    failedCalls: calls.filter(c => { const r = results.get(c.toolUseId); return typeof r === "string" ? /^\w*Error/.test(r) : r?.error; }).length,
    failedReports: calls.filter(c => results.get(c.toolUseId)?.report?.ok === false).length,
    docReads: calls.filter(c => c.name === "code" && /README|\.d\.ts|data\.jsdelivr|raw\.githubusercontent|package\.json/.test(c.input?.source || "")).length,
    subagents: calls.filter(c => c.name === "task").length,
    screenshots: messages.flatMap(m => m.content).filter(b => b.toolResult?.content.some(c => c.image)).length,
    // __HARNESS__.screenshot in the file's tests: the most any one report listed, and how many the model looked at
    testShots: Math.max(0, ...calls.map(c => results.get(c.toolUseId)?.report?.screenshots?.length ?? 0)),
    shotViews: calls.filter(c => /^\/?screenshots\//.test(c.input?.path ?? "")).length,
    scratch: new Set(calls.filter(c => ["write_file", "edit_file"].includes(c.name) && /^\/?scratch\//.test(c.input?.path ?? "")).map(c => c.input.path)).size,
    inputTokens: input,
    outputTokens: sum("outputTokens"),
    cacheHit: input ? +(sum("cacheReadInputTokens") / input).toFixed(2) : 0,
    // What the input costs in uncached-token equivalents: a cache write is 1.25×, a read 0.1×. Output is separate.
    costTokens: Math.round(sum("inputTokens") + 1.25 * sum("cacheWriteInputTokens") + 0.1 * sum("cacheReadInputTokens")),
    forks: calls.filter(c => c.name === "task" && c.input?.type === "fork").length,
    reviews: calls.filter(c => c.name === "task" && c.input?.type === "review").length,
    variants: calls.filter(c => c.name === "task" && c.input?.type === "variant").length,
    forkCacheHit: forkInput ? +(forkSum("cacheReadInputTokens") / forkInput).toFixed(2) : 0,
    seconds: Math.round(ms / 1000),
  };
}

// A readable transcript: text, reasoning, calls, and reports; screenshots saved beside it.
async function transcript(messages, dir) {
  const out = [];
  let shot = 0;
  const clip = (s, n = 1500) => (s.length > n ? s.slice(0, n) + ` …(${s.length} chars)` : s);
  for (const m of messages) {
    out.push(`\n## ${m.role}${m.usage ? ` · in ${m.usage.inputTokens + (m.usage.cacheReadInputTokens || 0) + (m.usage.cacheWriteInputTokens || 0)} (cached ${m.usage.cacheReadInputTokens || 0}) out ${m.usage.outputTokens}` : ""}\n`);
    for (const b of m.content) {
      if (b.text) out.push(b.harness ? "```\n" + clip(b.text, 800) + "\n```" : b.text);
      if (b.reasoningContent?.reasoningText?.text) out.push("> " + clip(b.reasoningContent.reasoningText.text, 1200).replaceAll("\n", "\n> "));
      if (b.toolUse) out.push(`**→ ${b.toolUse.name}** \`${b.toolUse.toolUseId.slice(-6)}\`\n\`\`\`json\n${clip(JSON.stringify(b.toolUse.input, null, 1), 3000)}\n\`\`\``);
      if (b.image) out.push(`[attached image]`);
      for (const c of b.toolResult?.content ?? []) {
        if (c.image) {
          const file = `shot-${++shot}.${c.image.format}`;
          await writeFile(path.join(dir, file), Buffer.from(c.image.source.bytes.base64, "base64"));
          out.push(`![screenshot](${file})`);
        } else out.push(`**← ${b.toolResult.toolUseId.slice(-6)}**\n\`\`\`json\n${clip(JSON.stringify(c.json ?? c.text, null, 1), 2500)}\n\`\`\``);
      }
    }
  }
  return out.join("\n\n");
}

async function runOne({ browser, base, proxyUrl, task, model: [modelName, modelId], persona, reasoning, dir }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  // Closed however the run ends: a crash in grading or saving would otherwise leave them open.
  let seeing, fileServer;
  try {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    // Network failures tell a harness fault (proxy down) from a model fault (wrong URL).
    const netErrors = [];
    context.on("requestfailed", r => netErrors.push(`${r.method()} ${r.url().slice(0, 160)}: ${r.failure()?.errorText}`));
    context.on("weberror", e => errors.push(e.error().message));
    // The eval stands in for the user: keys, proxy, and "Share tab", clicked when it is offered.
    // The page only: its frames share its storage, and a sandboxed one has none to write.
    await page.addInitScript(settings => { if (window === top) for (const [k, v] of Object.entries(settings)) localStorage.setItem(k, v); }, {
      "aws-config": JSON.stringify({ region: process.env.AWS_REGION || "us-east-1", credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, ...(process.env.AWS_SESSION_TOKEN && { sessionToken: process.env.AWS_SESSION_TOKEN }) } }),
      "google-config": JSON.stringify({ apiKey: process.env.GEMINI_API_KEY }),
      "brave-config": JSON.stringify({ apiKey: process.env.BRAVE_SEARCH_API_KEY }),
      "proxy-config": JSON.stringify({ endpoint: proxyUrl }),
    });
    // Model requests, as the engine's worker sent them; the last one is kept whole, since it carries the most context.
    const requests = [];
    await watchRequests(browser, page, (url, body) => requests.push({ url, body }));
    seeing = setInterval(() => page.locator("button:has-text('Share tab')").first().click({ timeout: 500 }).catch(() => {}), 1000);

    const started = Date.now();
    const answers = [];
    let error = null;
    try {
      await page.goto(base + "index.html");
      await page.waitForSelector("form#inputForm");
      if (persona) await page.evaluate(async prompt => {
        const request = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
        const store = (await request(indexedDB.open("chat"))).transaction("agents", "readwrite").objectStore("agents");
        store.put({ ...(await request(store.get(1))), systemPrompt: prompt });
      }, persona);
      for (const turn of task.turns) {
        if (turn.files) await openFolder(page, base, turn.files);
        else if (turn.seed) await send(page, JSON.stringify({ toolUse: [{ name: "write_file", input: turn.seed }] }), "echo", false);
        else if (turn.said) {
          // An earlier exchange the model is told it had: echo says the reply, then the instruction becomes the question.
          const [question, reply] = turn.said, typed = JSON.stringify({ text: reply });
          await send(page, typed, "echo", false);
          await page.evaluate(async ({ typed, question }) => {
            const request = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
            const store = (await request(indexedDB.open("chat"))).transaction("messages", "readwrite").objectStore("messages");
            const m = (await request(store.getAll())).findLast(m => m.role === "user" && m.content.some(b => b.text === typed));
            if (!m) throw new Error("said: the seeded question was not saved");
            await request(store.put({ ...m, content: m.content.map(b => (b.text === typed ? { ...b, text: question } : b)) }));
          }, { typed, question });
        } else {
          await send(page, turn, modelId, reasoning, task.timeout);
          answers.push(await page.evaluate(() => document.querySelectorAll(".message-block")[document.querySelectorAll(".message-block").length - 1]?.innerText ?? ""));
        }
      }
    } catch (e) {
      error = String(e.message || e).split("\n")[0];
      // Where it stopped, as the user would have seen it.
      await page.screenshot({ path: path.join(dir, "stopped.png") }).catch(() => {});
    }
    clearInterval(seeing);
    const ms = Date.now() - started;

    const data = await collect(page).catch(e => ({ threads: [], messages: [], versions: [], error: e.message }));
    const main = data.threads.find(t => t.type !== "subagent");
    const messages = data.messages.filter(m => m.threadId === main?.id).sort((a, b) => a.id - b.id);
    const subThreads = new Set(data.threads.filter(t => t.type === "subagent").map(t => t.id));
    const subagents = data.messages.filter(m => subThreads.has(m.threadId));
    const forkThreads = new Set(data.threads.filter(t => t.subagentType === "fork").map(t => t.id));
    // The project's own heads: a variant's branch writes versions too, newer than the take that was kept.
    const project = data.projects?.find(p => p.id === main?.projectId) ?? data.projects?.sort((a, b) => b.id - a.id)[0];
    const byId = new Map(data.versions.map(v => [v.id, v]));
    const heads = new Map(Object.entries(project?.heads ?? {}).map(([p, id]) => [p, byId.get(id)]).filter(([, v]) => v));
    const files = Object.fromEntries([...heads].map(([p, v]) => [p, v.text]));
    const shown = [...heads.values()].filter(v => v.report && !v.path.startsWith("scratch/")).sort((a, b) => b.id - a.id)[0];
    // The answer is everything said since the user last spoke: a harness note can move it off the final message.
    const asked = messages.findLastIndex(m => m.role === "user" && m.content.some(b => b.text && !b.harness));
    const said = messages.slice(asked + 1).filter(m => m.role === "assistant");

    // Paths come from the model: one that would leave files/, or that can't be written, is skipped and recorded.
    await mkdir(path.join(dir, "files"), { recursive: true });
    const escaped = [], unwritten = [];
    for (const [p, text] of Object.entries(files)) {
      const target = filePath(dir, p);
      if (!target) { escaped.push(p); delete files[p]; continue; }
      try {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, text ?? "");
      } catch (e) { unwritten.push(`${p} (${e.code || e.message})`); delete files[p]; }
    }
    // The app's server hides dot folders, so the files get their own while the checks run.
    const probe = async (file, fn) => {
      if (!file || !files[file]) return null;
      fileServer ??= await startServer(0, path.join(dir, "files"));
      const probePage = await context.newPage();
      try {
        await probePage.goto(`http://localhost:${fileServer.address().port}/${file}`);
        await probePage.waitForTimeout(1500);
        return await probePage.evaluate(fn);
      } catch (e) { return "probe error: " + e.message.split("\n")[0]; }
      finally { await probePage.close(); }
    };
    const run = {
      answer: said.flatMap(m => m.content.filter(b => b.text).map(b => b.text)).join("\n"),
      answers,
      files,
      report: shown?.report ?? null,
      calls: messages.filter(m => m.modelId !== "echo").flatMap(m => m.content.filter(b => b.toolUse).map(b => b.toolUse)),
      // Each call's result by its id, so the judge can see what a claimed check returned.
      outcomes: Object.fromEntries(messages.flatMap(m => m.content.filter(b => b.toolResult).map(b => [b.toolResult.toolUseId, b.toolResult.content.map(c => c.text ?? JSON.stringify(c.json ?? "")).join("\n")]))),
      results: messages.flatMap(m => m.content.filter(b => b.toolResult).flatMap(b => b.toolResult.content.map(c => c.text ?? JSON.stringify(c.json ?? "")))).join("\n"),
      metrics: metrics(messages, subagents, ms, subagents.filter(m => forkThreads.has(m.threadId))),
      dialogue: dialogue(messages),
      probe,
    };
    const style = mannered(run.dialogue.filter(m => m.role === "assistant" && !m.seeded).map(m => m.text).join("\n\n"));
    Object.assign(run.metrics, { words: style.words, flourishes: style.count, flourishPer1k: style.per1k });
    const checks = (error ? [[false, "finished: " + error]] : await task.check(run)).map(([ok, label]) => ({ ok: !!ok, label }));
    // The judge grades a finished run only; its tokens are counted apart from the model's.
    const verdict = !error && task.rubric ? await judge(run, task) : null;
    if (verdict) {
      checks.push(...judgedChecks(verdict));
      Object.assign(run.metrics, { judgeInputTokens: verdict.tokens.input, judgeOutputTokens: verdict.tokens.output });
    }
    const unjudged = verdict?.unjudged ?? [];
    if (escaped.length) checks.push({ ok: false, label: "files stay in the workspace (escaped: " + escaped.join(", ") + ")" });
    if (unwritten.length) checks.push({ ok: false, label: "files can be saved (failed: " + unwritten.join(", ") + ")" });

    const breaks = prefixBreaks(requests.map(r => r.body));
    run.metrics.prefixBreaks = breaks.length;
    const result = { task: task.id, model: modelName, modelId, error, escaped, unwritten, passed: checks.filter(c => c.ok).length, total: checks.length, checks, unjudged, judgeError: verdict?.error ?? null, flourishHits: style.hits, metrics: run.metrics, errors: errors.slice(0, 5), netErrors: netErrors.slice(0, 20), requests: requests.length, requestBytes: requests.map(r => r.body.length), breaks };
    await writeFile(path.join(dir, "result.json"), JSON.stringify({ ...result, persona: data.persona, messages, subagents, summary: main?.summary ?? null }, null, 1));
    if (requests.length) await writeFile(path.join(dir, "request.json"), requests.at(-1).body);
    await writeFile(path.join(dir, "transcript.md"), `# ${task.id} · ${modelName}\n\n${[...checks.map(c => `- [${c.ok ? "x" : " "}] ${c.label}${c.reason ? ` — ${c.reason}` : ""}`), ...unjudged.map(u => `- [?] judge: ${u.criterion} (unjudged: ${u.reason})`)].join("\n")}\n\n\`${JSON.stringify(run.metrics)}\`\n` + (await transcript(messages, dir)));
    return result;
  } finally {
    clearInterval(seeing);
    await context.close().catch(() => {});
    fileServer?.closeAllConnections();
    fileServer?.close();
  }
}

function table(results, baseline) {
  const key = r => `${r.task}·${r.model}`;
  const before = Object.groupBy((baseline ?? []).filter(graded), key);
  const rows = Object.entries(Object.groupBy(results.filter(graded), key)).map(([k, runs]) => {
    const mean = f => runs.reduce((n, r) => n + f(r), 0) / runs.length;
    const row = { run: k, pass: mean(r => r.passed / r.total), turns: mean(r => r.metrics.turns), calls: mean(r => r.metrics.calls), shots: mean(r => r.metrics.screenshots ?? 0), tShots: mean(r => r.metrics.testShots ?? 0), tViews: mean(r => r.metrics.shotViews ?? 0), scratch: mean(r => r.metrics.scratch ?? 0), kTokIn: mean(r => r.metrics.inputTokens / 1000), kCost: mean(r => (r.metrics.costTokens ?? r.metrics.inputTokens) / 1000), kOut: mean(r => r.metrics.outputTokens / 1000), cache: mean(r => r.metrics.cacheHit), breaks: mean(r => r.metrics.prefixBreaks ?? 0), subs: mean(r => r.metrics.subagents ?? 0), reviews: mean(r => r.metrics.reviews ?? 0), variants: mean(r => r.metrics.variants ?? 0), redundant: mean(r => r.metrics.redundantRunApp), failed: mean(r => r.metrics.failedCalls + r.metrics.failedReports), flourish: mean(r => r.metrics.flourishPer1k ?? 0), kJudge: mean(r => ((r.metrics.judgeInputTokens ?? 0) + (r.metrics.judgeOutputTokens ?? 0)) / 1000), sec: mean(r => r.metrics.seconds) };
    const old = before[k];
    if (old) row.passWas = old.reduce((n, r) => n + r.passed / r.total, 0) / old.length;
    return Object.fromEntries(Object.entries(row).map(([f, v]) => [f, typeof v === "number" ? +v.toFixed(2) : v]));
  });
  console.table(rows);
  const now = summarize(results);
  console.log(meanLine(results, baseline));
  for (const r of now.crashed) console.log(`CRASHED ${r.task} ${r.model}: ${r.crashed}`);
  for (const r of now.unfinished) console.log(`UNFINISHED ${r.task} ${r.model}: ${r.error}`);
  for (const r of results.filter(r => r.unjudged?.length)) console.log(`UNJUDGED ${r.task} ${r.model}: ${r.unjudged.length} criteria left out of the score (${r.judgeError})`);
}

async function main() {
  const o = options(process.argv.slice(2));
  const jobs = o.models.flatMap(model => o.tasks.flatMap(task => Array.from({ length: o.repeat }, (_, i) => ({ task, model, i }))));
  console.log(`${jobs.length} jobs: ${o.tasks.length} tasks x ${o.models.length} models x ${o.repeat}, reasoning ${o.reasoning}`);
  if (jobs.length > MAX_UNCONFIRMED && !o.yes) {
    console.error(`More than ${MAX_UNCONFIRMED} jobs call paid APIs; pass --yes to run them.`);
    process.exit(2);
  }
  process.loadEnvFile(path.join(root, ".env"));
  const persona = o.system && (await readFile(o.system, "utf8"));
  // The page and its own modules, read once; a module that doesn't exist yet is left to the server.
  const app = {};
  for (const file of ["index.html", "engine.js", "prompts.js"]) {
    const text = await readFile(path.join(root, file), "utf8").catch(e => (e.code === "ENOENT" ? null : Promise.reject(e)));
    if (text !== null) app["/" + file] = [file.endsWith(".html") ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8", text];
  }
  const baseline = o.baseline && JSON.parse(await readFile(path.join(root, ".artifacts", "evals", o.baseline, "results.json"), "utf8"));
  // Named for the time and a short random tag, so two evals started together keep separate folders.
  const runId = new Date().toISOString().replaceAll(/[:.]/g, "-").slice(0, 19) + "-" + Math.random().toString(36).slice(2, 6);
  const server = await startServer(0, root);
  // Every run gets the app as it was when the eval started, so editing the prompt mid-run changes nothing.
  // (Served, not routed: a Playwright route breaks the page's cross-origin fetches, the proxy included.)
  const [serve] = server.listeners("request");
  server.removeAllListeners("request").on("request", (request, response) => {
    const file = app[new URL(request.url, "http://localhost").pathname];
    file ? response.writeHead(200, { "content-type": file[0] }).end(file[1]) : serve(request, response);
  });
  const proxy = await startProxy(0);
  // Headless Chromium can't share a tab, so windows open off screen (on screen with --headed) and the user's
  // "Share tab" works as it does for a real user: every change reports with a screenshot.
  const browser = await chromium.launch({ headless: false, args: ["--auto-accept-this-tab-capture", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", ...(o.headed ? [] : ["--window-position=-32000,-32000"])] });
  const base = `http://localhost:${server.address().port}/`;
  const proxyUrl = `http://localhost:${proxy.address().port}`;
  console.log(`eval ${runId}: ${jobs.length} runs`);
  const results = [];
  const queue = [...jobs];
  await Promise.all(Array.from({ length: o.concurrency }, async () => {
    for (let job; (job = queue.shift()); ) {
      const dir = path.join(root, ".artifacts", "evals", runId, job.model[0], job.task.id + (o.repeat > 1 ? `-${job.i + 1}` : ""));
      await mkdir(dir, { recursive: true });
      // One run's crash is recorded and the others go on.
      const result = await runOne({ browser, base, proxyUrl, persona, reasoning: o.reasoning, dir, ...job }).catch(e => ({
        task: job.task.id, model: job.model[0], modelId: job.model[1], crashed: String(e?.stack || e).split("\n").slice(0, 3).join(" | "), passed: 0, total: 0, checks: [],
      }));
      if (result.crashed) console.log(`CRASH ${job.task.id} ${job.model[0]} ${result.crashed}`);
      else if (result.error) console.log(`UNFINISHED ${job.task.id} ${job.model[0]} ${result.error}`);
      else console.log(`${result.passed === result.total ? "PASS" : "FAIL"} ${job.task.id} ${job.model[0]} ${result.passed}/${result.total} ${result.checks.filter(c => !c.ok).map(c => c.label).join("; ")}${result.unjudged?.length ? ` (${result.unjudged.length} unjudged: ${result.judgeError})` : ""}`);
      results.push(result);
    }
  }));
  await writeFile(path.join(root, ".artifacts", "evals", runId, "results.json"), JSON.stringify(results, null, 1));
  table(results, baseline);
  console.log(`transcripts: .artifacts/evals/${runId}/`);
  await browser.close();
  // A run that crashed or stopped before its turns finished is a harness failure, not a grade.
  const { crashed, unfinished } = summarize(results);
  process.exit(crashed.length || unfinished.length ? 1 : 0); // exits either way: the servers keep sockets open
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
