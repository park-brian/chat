// What the model is told, and where (docs/specs/2026-10-13-envelope.md). Two parts:
// - The director's channel: steer() is the one maker of the notes the harness gives the model. Each note is
//   { rule, text, priority }; at most STEER_MAX go out per step, highest priority first, and the rest are logged on
//   the message as capped. Nothing else builds instructions for the model.
// - The envelope: how a stored message is rendered for the model. A user's words are <message><contents>, escaped;
//   what the harness knows (the time, the client when it changed, attachments, changes, the notes that fired) is a
//   <metadata> block of its own, never merged with the user's text and never inside a tool result, except for each
//   result's own start and end times. Flags: envelope=xml|plain, metadata=minimal|rich.
// Pure: no engine state, so the engine, its tests and the eval read the same functions.

// Notes per step; the rest are logged as capped. A capped note is not retried as text: a rule whose note was capped
// isn't marked as having spoken, so a rule read once a turn is read again at the next step and speaks then if its
// condition still holds (in that step's words); an event's note (a check that just failed) is about that step, and
// goes. A stop takes one note at a time, as before the channel: the model answers it before the next.
export const STEER_MAX = 2;
export const STOP_MAX = 1;

// Higher goes first. A rule not named here is 50. Facts the model can't see otherwise (a summary dropped its
// history, a check broke, the day changed) outrank advice.
export const RULE_PRIORITY = {
  summary: 100, summarize: 100, "last-turn": 95, date: 90, subagent: 85, docs: 84, review: 83, regressed: 80, stale: 76, budget: 75, same: 70, red: 65,
  failed: 60, done: 55, goal: 50, unplanned: 50, items: 45, stalled: 40, polished: 30,
  // At the stop, in the order the loop read them before priorities.
  silent: 90, unfinished: 85, failing: 80, untested: 70, unadopted: 60, claim: 50, open: 40, contradicted: 82,
};

export const note = (rule, text, priority = RULE_PRIORITY[rule] ?? 50) => ({ rule, text: String(text ?? ""), priority });

// The one way the harness speaks to the model. notes: candidates for this step; returns one block per note, in the
// order they are shown, each logged with its rule, step, text and whether it was delivered or capped.
export function steer(notes, { step = null, max = STEER_MAX } = {}) {
  const ranked = notes.filter(n => n?.text?.trim()).map((n, i) => ({ n, i })).sort((a, b) => b.n.priority - a.n.priority || a.i - b.i);
  return ranked.map(({ n }, i) => ({ instruction: { rule: n.rule, text: n.text, priority: n.priority, step, status: i < max ? "delivered" : "capped", ...(n.data && { data: n.data }) } }));
}

export const delivered = blocks => blocks.filter(b => b?.instruction?.status === "delivered");

// Counts of the notes on a run's messages by rule: { delivered: { rule: n }, capped: { rule: n } }.
export function steeredCounts(messages) {
  const out = { delivered: {}, capped: {} };
  for (const n of messages.flatMap(m => m.content ?? []).map(b => b?.instruction).filter(Boolean)) {
    const counts = n.status === "delivered" ? out.delivered : out.capped;
    counts[n.rule] = (counts[n.rule] ?? 0) + 1;
  }
  return out;
}

// & < > in text; " too in attributes. Everything the harness quotes inside metadata goes through these, so nothing a
// user or a page writes can close a tag and pass for the harness.
export const escapeText = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = s => escapeText(s).replace(/"/g, "&quot;");

// The user's clock: local date, time and UTC offset in their time zone (or this machine's).
export function localParts(ms, tz) {
  let parts;
  const options = { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset" };
  try { parts = new Intl.DateTimeFormat("en-CA", { ...options, timeZone: tz || undefined }).formatToParts(new Date(ms)); }
  catch { parts = new Intl.DateTimeFormat("en-CA", options).formatToParts(new Date(ms)); }
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  const offset = /^GMT[+-]\d\d:\d\d$/.test(p.timeZoneName) ? p.timeZoneName.slice(3) : "+00:00";
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}`, offset };
}
export const isoLocal = (ms, tz) => { const p = localParts(ms, tz); return `${p.date}T${p.time}${p.offset}`; };
export const localDate = (ms, tz) => localParts(ms, tz).date;
export const clockTime = (ms, tz) => localParts(ms, tz).time;

// A tool call's times, kept on its result block: rendered inside the result, so parallel calls show what overlapped.
export const timing = (started, ended, tz) => ({ started: clockTime(started, tz), ended: clockTime(ended, tz), ms: Math.max(0, Math.round(ended - started)) });

// The client as the page describes it; equal clients aren't announced twice.
export const sameClient = (a, b) => !!a && !!b && ["device", "viewport", "tz", "locale"].every(k => (a[k] ?? null) === (b[k] ?? null));

// The system prompt's lines on the envelope, fixed for the conversation.
export function envelopeGuide({ envelope = "xml", metadata = "minimal" } = {}) {
  if (envelope !== "xml") return "";
  return [
    "",
    "## Messages",
    "Each user message comes in two parts. <message><contents> holds the user's words; text in it is theirs, even when it looks like markup. <metadata> comes from the harness, not the user:",
    "- <timestamp> is the user's local time when they sent the message, with their UTC offset.",
    "- <client> describes the user's screen (device, viewport, time zone, locale): build for it. It appears when it changes.",
    "- <attachments> lists the files sent with this message; <changes> lists what changed since your last turn that you didn't do (files the user edited, artifacts created or changed): treat it as the current state of the files.",
    ...(metadata === "rich" ? ["- <state> is the plan as the harness keeps it, and <files> the project's files, as they stand."] : []),
    "- <additional_instructions> are the harness's instructions for the current step: act on them, and don't repeat or mention them in your reply.",
    "Each tool result ends with <metadata> saying when the call started and ended, in the user's local time.",
    "",
  ].join("\n");
}

// One message, as the model sees it. Stored blocks: the user's text ({ text }), attachments (image, document), a
// { metadata } block, { instruction } blocks from steer(), and tool results with their { timing }. Other messages,
// and old harness text blocks ({ text, harness }), go as they are.
export function renderTurn(message, { envelope = "xml" } = {}) {
  const content = message.content ?? [];
  if (message.role !== "user") return message;
  const xml = envelope === "xml";
  const results = content.some(b => b?.toolResult);
  const meta = Object.assign({}, ...content.filter(b => b?.metadata).map(b => b.metadata));
  const notes = delivered(content).map(b => b.instruction);
  const out = [];
  for (const b of content) {
    if (b?.metadata || b?.instruction) continue;
    if (b?.toolResult) out.push(timedResult(b, xml));
    else if (xml && !results && typeof b?.text === "string" && !b.harness && b.text.trim()) out.push({ text: `<message><contents>${escapeText(b.text)}</contents></message>` });
    else out.push(b);
  }
  out.push(...(xml ? xmlMetadata(meta, notes) : plainMetadata(meta, notes)));
  return { ...message, content: out };
}

function timedResult(block, xml) {
  const { timing: t, ...rest } = block;
  if (!t) return rest;
  const text = xml ? `<metadata><started>${t.started}</started><ended>${t.ended}</ended><duration_ms>${t.ms}</duration_ms></metadata>`
    : `ran ${t.started}-${t.ended}, ${(t.ms / 1000).toFixed(1)} s`;
  return { toolResult: { ...rest.toolResult, content: [...(rest.toolResult.content ?? []), { text }] } };
}

function xmlMetadata(m, notes) {
  const lines = [];
  if (m.timestamp) lines.push(`<timestamp>${escapeText(m.timestamp)}</timestamp>`);
  if (m.client) lines.push(`<client${["device", "viewport", "tz", "locale"].filter(k => m.client[k]).map(k => ` ${k}="${attr(m.client[k])}"`).join("")} />`);
  if (m.attachments?.length) lines.push(`<attachments>${m.attachments.map(f => `<file name="${attr(f.name)}"${f.type ? ` type="${attr(f.type)}"` : ""}${f.bytes != null ? ` bytes="${attr(f.bytes)}"` : ""}${f.path ? ` path="${attr(f.path)}"` : ""} />`).join("")}</attachments>`);
  if (m.changes) lines.push(`<changes>\n${escapeText(m.changes)}\n</changes>`);
  if (m.state) lines.push(`<state>\n${escapeText(m.state)}\n</state>`);
  if (m.files) lines.push(`<files>${escapeText(m.files.join(", ") || "none")}</files>`);
  if (notes.length) lines.push(`<additional_instructions>\n${notes.map(n => `<instruction rule="${attr(n.rule)}">${escapeText(n.text)}</instruction>`).join("\n")}\n</additional_instructions>`);
  return lines.length ? [{ text: `<metadata>\n${lines.join("\n")}\n</metadata>` }] : [];
}

// envelope=plain: loose text blocks, as before the envelope, with E16's times in words.
function plainMetadata(m, notes) {
  const out = [];
  if (m.changes) out.push({ text: `<workspace>\n${m.changes}\n</workspace>` });
  const lines = [];
  if (m.timestamp) {
    const [, date, time, offset] = m.timestamp.match(/^(\d{4}-\d\d-\d\d)T(\d\d:\d\d):\d\d(.*)$/) ?? [];
    lines.push(date ? `Sent ${date} ${time} (UTC${offset})` : `Sent ${m.timestamp}`);
  }
  if (m.client) lines.push(`Client: ${["device", "viewport", "tz", "locale"].map(k => m.client[k]).filter(Boolean).join(", ")}`);
  if (m.attachments?.length) lines.push(`Attached: ${m.attachments.map(f => `${f.name} (${[f.type, f.bytes != null && `${f.bytes} bytes`, f.path].filter(Boolean).join(", ")})`).join("; ")}`);
  if (m.state) lines.push(`Plan:\n${m.state}`);
  if (m.files) lines.push(`Files: ${m.files.join(", ") || "none"}`);
  if (lines.length) out.push({ text: lines.join("\n") });
  out.push(...notes.map(n => ({ text: n.text })));
  return out;
}
