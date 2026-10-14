// Test counts an answer claims ("21 passed") that no tool output shows: one checker for every tier, since copies of it
// drifted (E12: swe didn't know node's "# pass 47"; E28: long had the same gap after swe's was fixed).
const NOUN = String.raw`(?:(?:hidden|unit|new|existing)\s+)?(?:tests?|programs?|checks?|cases?|specs?)`;
const CLAIM = new RegExp(String.raw`\b(\d+)(?:\s*\/\s*\d+)?\s+(?:${NOUN}\s+)?(?:(?:all|now)\s+)?pass(?:ed|ing|es)?\b`, "gi");
// A list of plan items or steps ("items 1 and 3 pass") is not a count.
const LISTED = /\b(?:items?|steps?|parts?|phases?|checks?|chapters?|versions?|v)\s+\d+(?:\s*(?:,|and|&|or)\s*\d+)*/gi;

// What a tool printed that backs a count n: a run report's JSON, "n passed", node's "# pass n", pytest's "n passed".
const backs = n => new RegExp(String.raw`"passed":\s*${n}\b|\b${n}(?:\s*\/\s*\d+)?\s+(?:${NOUN}\s+)?pass|\bpass(?:ed)?:?\s*${n}\b`, "i");

export function claimedCounts(answer) {
  return [...new Set([...String(answer ?? "").replace(LISTED, " ").matchAll(CLAIM)].map(m => m[1]))];
}

export function unbackedClaims(answer, results) {
  return claimedCounts(answer).filter(n => !backs(n).test(results ?? ""));
}
