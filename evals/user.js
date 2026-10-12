// A simulated user, τ-bench style: a second model plays the person who asked, with a hidden goal and a persona. After
// each reply it answers the assistant's questions from the goal, corrects assumptions that contradict it, and says DONE
// when the work meets it. It sees the conversation and the names of the files the assistant wrote; never the model's
// name, the task's checks or its rubric.
//
// A task opts in with user: { goal, persona, reveal?: [facts given only when asked], maxTurns }. Its turns run first as
// usual (the last plain string is the opening message); the simulator writes every user message after that.

import { bedrock } from "./judge.js";

export const SIM_MODEL = "global.anthropic.claude-sonnet-5-5";
export const DONE = "DONE";

const clip = (s, n) => (s.length > n ? s.slice(0, n) + " …(cut)" : s);

const system = user => [
  "You are playing a person who is chatting with an AI assistant. You asked the assistant for something. What you actually want is the goal below. The assistant cannot see the goal.",
  `<persona>\n${user.persona}\n</persona>`,
  `<goal>\n${user.goal}\n</goal>`,
  user.reveal?.length && `<facts>\nFacts about you. Give one only when the assistant asks for it.\n${user.reveal.map(f => "- " + f).join("\n")}\n</facts>`,
  `Rules for your next message:
1. Answer the assistant's questions only from the goal and the facts. If they don't cover a question, say "I don't mind".
2. If the assistant states an assumption or makes a choice that contradicts the goal, correct it in one short sentence.
3. If the assistant's work meets every part of the goal, reply with exactly ${DONE} and nothing else. Decide from what the assistant says it did and the files it wrote. If it doesn't say how it handled a part of the goal, ask about that part.
4. If the work is finished but misses or gets wrong a part of the goal, say which part, in one short sentence.
5. Don't give the whole goal at once unless the assistant asks for all of your requirements.
6. If the assistant asks whether to go ahead, say yes.
7. Write like a busy person: short and plain; lower-case is fine. Write only the message you would send.`,
].filter(Boolean).join("\n\n");

// The Converse request. Only the goal, the persona, the conversation and file names go in.
export function userPrompt(user, dialogue, wrote = []) {
  const turns = dialogue.map(m => (m.role === "user" ? `<you>\n${m.text}\n</you>` : `<assistant>\n${clip(m.text, 8000)}\n</assistant>`)).join("\n\n");
  const text = `<conversation>\n${turns}\n</conversation>\n\nFiles the assistant has written: ${wrote.length ? wrote.join(", ") : "none"}\n\nWrite your next message to the assistant.`;
  return {
    modelId: SIM_MODEL,
    system: [{ text: system(user) }],
    messages: [{ role: "user", content: [{ text }] }],
    // Sonnet 5.5 refuses temperature; its default sampling is what the simulator gets.
    inferenceConfig: { maxTokens: 1000 },
  };
}

// { text, done, tokens: { input, output } } for the next user message.
export async function nextMessage(user, dialogue, wrote, { send = bedrock } = {}) {
  // A failed call is a harness failure: the run stops unfinished and says the simulator failed.
  const response = await send(userPrompt(user, dialogue, wrote)).catch(e => { throw new Error("simulated user failed: " + String(e?.message || e).split("\n")[0]); });
  const text = (response.output?.message?.content ?? []).map(b => b.text ?? "").join("").trim();
  if (!text) throw new Error("simulated user wrote nothing");
  const tokens = { input: response.usage?.inputTokens ?? 0, output: response.usage?.outputTokens ?? 0 };
  return { text, done: /^["'`*]*DONE[.!]?["'`*]*$/.test(text), tokens };
}

// Runs the rest of the conversation. read() returns { dialogue, wrote } as it stands; say(text) sends one user message
// and waits for the reply. sent is how many user messages the task's own turns already sent. Stops at DONE, or when
// maxTurns user messages have been sent and the last reply still isn't DONE.
export async function simulate(user, { read, say, sent = 1, send = bedrock }) {
  const said = [], tokens = { input: 0, output: 0 };
  let userTurns = sent, done = false;
  for (;;) {
    const { dialogue, wrote } = await read();
    const next = await nextMessage(user, dialogue, wrote, { send });
    tokens.input += next.tokens.input;
    tokens.output += next.tokens.output;
    if (next.done) { done = true; break; }
    if (userTurns >= user.maxTurns) break;
    said.push(next.text);
    await say(next.text);
    userTurns++;
  }
  return { userTurns, done, said, tokens, dontMind: said.filter(s => /i don'?t mind/i.test(s)).length };
}
