// Mannered prose, counted: known flourishes per 1000 words of what the model said, code blocks left out.

export const FLOURISHES = [
  ["earns its keep", /\bearns? (?:its|their) keep\b/gi],
  ["dial", /\bdials?\b(?!-up)/gi],
  ["lever", /\blevers?\b/gi],
  ["north star", /\bnorth star\b/gi],
  ["load-bearing", /\bload[- ]bearing\b/gi],
  ["heavy lifting", /\bheavy lifting\b/gi],
  ["at the end of the day", /\bat the end of the day\b/gi],
  ["it's worth noting", /\bit(?:'|’|\si)?s worth (?:noting|mentioning|pointing out)\b/gi],
  ["delve", /\bdelv(?:e|es|ed|ing)\b/gi],
  ["tapestry", /\btapestr(?:y|ies)\b/gi],
  ["landscape", /\blandscapes?\b/gi],
  ["unlock", /\bunlock(?:s|ed|ing)?\b/gi],
  ["a quiet/subtle X", /\ba (?:quiet|subtle) [a-z]+/gi],
  // Where an abstraction "sits" or "lives": a person or an animal living somewhere is literal.
  ["sits/lives in", /(?<!\b(?:he|she|who|they|people|i|we|you|cat|dog) )\b(?:sits|lives) (?:in|inside|on|at|behind|between|under|above|alongside|next to)\b/gi],
];

export const prose = text => String(text ?? "").replace(/```[\s\S]*?(?:```|$)/g, " ").replace(/`[^`\n]*`/g, " ");
export const wordCount = text => (prose(text).match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu) ?? []).length;

export function mannered(text) {
  const body = prose(text);
  const hits = Object.fromEntries(FLOURISHES.map(([name, re]) => [name, body.match(re)?.length ?? 0]).filter(([, n]) => n));
  const count = Object.values(hits).reduce((a, b) => a + b, 0);
  const words = wordCount(text);
  return { count, words, per1k: words ? +((count * 1000) / words).toFixed(1) : 0, hits };
}
