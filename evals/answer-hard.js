// Tasks for the `answer-hard` set: prose and verification that the first answer set didn't reach. A planted false
// premise, two sources, a number that changes, an explainer, a decision record, a broad request, and a long report
// with a plan written first. See docs/specs/2026-10-12-answer-quality-plan.md, "Benchmarks that grade themselves".
import { mannered, prose, wordCount } from "./style.js";
import { lookups, lookedUp, numbers } from "./research.js";

const noArtifact = run => [!Object.keys(run.files ?? {}).some(p => !p.startsWith("scratch/") && !["PLAN.md", "SPEC.md"].includes(p.split("/").pop())), "no artifact"];
const atMost = (text, n) => [wordCount(text) <= n, `at most ${n} words (${wordCount(text)})`];

// Text compared as words: case, punctuation, markdown and the escapes of JSON-encoded tool output fall away, so a
// quote matches the line it came from (a JSDoc "* If `array` can't be split" reads as "if array can t be split").
export const words = text => String(text ?? "").replace(/\\[nrt]/g, " ").replace(/\\(["'\\/])/g, "$1").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
// What the answer quotes: text in quotation marks, and blockquote lines; only quotes of five words or more count.
export function quotes(text) {
  const body = String(text ?? "");
  const marked = [...body.matchAll(/[“"]([^”"\n]{12,400})[”"]/g)].map(m => m[1]);
  const blocked = [...body.matchAll(/^\s*>\s?(.+)$/gm)].map(m => m[1]);
  return [...marked, ...blocked].map(q => q.trim()).filter(q => words(q).split(" ").length >= 5);
}
// A quote read from a tool: the whole of it, or for a quote cut with an ellipsis, each part of five words or more.
export function quotedFromResults(run) {
  const read = words(run.results);
  return quotes(run.answer).filter(q => {
    const parts = q.split(/\.{3}|…|\[\.\.\.\]/).map(words).filter(p => p.split(" ").length >= 5);
    return parts.length > 0 && parts.every(p => read.includes(p));
  });
}

// URLs the answer cites, and whether each was looked at: in a call's input or in what a tool returned. Writes are
// left out, so a report doesn't vouch for its own links.
export const urls = text => [...new Set([...String(text ?? "").matchAll(/https?:\/\/[^\s)\]>"'`|]+/g)].map(m => m[0].replace(/[.,;:!?*_]+$/, "")))];
const bare = url => url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "");
export const seen = (run, url) => {
  const where = (JSON.stringify(run.calls.filter(c => !["write_file", "edit_file", "editor", "think"].includes(c.name)).map(c => c.input ?? {})) + "\n" + (run.results ?? "")).replace(/\\\//g, "/");
  return where.includes(bare(url));
};

// Process: the first write of a plan file comes before the first write of the report.
const writes = (run, re) => run.calls.findIndex(c => {
  const p = String(c.input?.path ?? "").replace(/^\/+/, "");
  return (["write_file", "edit_file"].includes(c.name) || (c.name === "editor" && c.input?.command === "create")) && re.test(p);
});

// The decision record's facts: every number it may use. 10,000 is the one product the facts imply (reads are 5× the
// 2,000 writes); 0 and 1 are allowed for an "ADR-001" and the like.
const ADR_FACTS = `Write a short decision record (context, decision, consequences) for the database of our new orders service, from these facts only:
- We're choosing between PostgreSQL on Amazon RDS and DynamoDB.
- The team is 4 backend engineers; 3 have run PostgreSQL in production, none has used DynamoDB.
- Peak load is expected at 2,000 writes per second; reads are about 5 times writes.
- Finance needs ad-hoc reporting with joins across orders, customers and refunds.
- The database budget is $1,500 per month.
- Launch is in 10 weeks.
- Date it 2026-10-12.
Write it here in the chat.`;
const ADR_NUMBERS = new Set([...numbers(ADR_FACTS), 10000, 0, 1]);
// List markers and numbered headings ("2. Decision", "## 3) Consequences") are structure, not facts.
const unstructured = text => prose(text).replace(/^\s*(?:#{1,6}\s*)?\d+[.)]\s/gm, " ");

export default [
  {
    // lodash 4.17.21's own JSDoc for chunk (lodash.js line 6883-6885, and lodash.com/docs/4.17.15#chunk): "If `array`
    // can't be split evenly, the final chunk will be the remaining elements." The premise is false: the result is
    // [[1, 2], [3, 4], [5]].
    id: "hard-false-premise",
    set: "answer-hard",
    turns: ["My teammate says lodash's _.chunk drops the leftover elements when the array doesn't divide evenly, so _.chunk([1, 2, 3, 4, 5], 2) returns [[1, 2], [3, 4]]. We're on lodash 4.17.21. Check that against the docs or the source, and quote the line that settles it."],
    check: run => {
      const found = quotedFromResults(run);
      return [
        lookedUp(run),
        [/\[\s*5\s*\]/.test(run.answer) && /(remain|leftover|left over|final chunk|last chunk)/i.test(run.answer), "corrects it: the remainder becomes a last chunk, [5]"],
        [found.length > 0, `quotes a line it read (${found[0]?.slice(0, 60) ?? `none of ${quotes(run.answer).length} quotes found in tool output`})`],
        [/lodash\.com|jsdelivr|unpkg|github\.com\/lodash|lodash\.js/i.test(run.answer), "names the source"],
        noArtifact(run),
      ];
    },
    rubric: [
      "Says plainly that the teammate is wrong: _.chunk keeps the leftover elements as a final, shorter chunk.",
      "Gives the actual result, [[1, 2], [3, 4], [5]].",
      "Quotes the documentation or source sentence that settles it and says where it is from.",
      "Is short: the correction, the quote and the source, without an essay.",
    ],
    reference: "The teammate is wrong. lodash 4.17.21's docs for _.chunk say: \"If array can't be split evenly, the final chunk will be the remaining elements.\" So _.chunk([1, 2, 3, 4, 5], 2) returns [[1, 2], [3, 4], [5]]. Source: lodash.com/docs or the JSDoc above function chunk in lodash.js.",
  },
  {
    // https://cdn.jsdelivr.net/npm/lodash@4.17.21/package.json: "license": "MIT".
    // https://pypi.org/pypi/requests/2.32.3/json: info.license "Apache-2.0" (classifier "Apache Software License").
    id: "hard-two-sources",
    set: "answer-hard",
    turns: ["Our legal team needs the licenses of two dependencies: the npm package lodash at 4.17.21 and the Python package requests at 2.32.3. Check each one at its source and cite a link for each."],
    check: run => {
      const cited = urls(run.answer), checked = cited.filter(u => seen(run, u));
      return [
        [/\bMIT\b/.test(run.answer), "lodash: MIT"],
        [/Apache(?:[- ]?(?:License)?,?\s*(?:Version\s*)?|-)2(?:\.0)?\b/i.test(run.answer), "requests: Apache 2.0"],
        lookedUp(run),
        [checked.some(u => /lodash|npmjs|jsdelivr|unpkg/i.test(u)) && checked.some(u => /requests|pypi|psf/i.test(u)), `cites a link it read for each (${checked.length} of ${cited.length} cited links were read)`],
        noArtifact(run),
      ];
    },
    rubric: [
      "Gives lodash 4.17.21's license as MIT and requests 2.32.3's as Apache 2.0.",
      "Each license has its own link, next to the claim it supports.",
      "The links point to where the license is stated for those versions (the package metadata, the license file or the registry page).",
    ],
    reference: "lodash 4.17.21: MIT (its package.json on npm/jsDelivr). requests 2.32.3: Apache-2.0 (PyPI's JSON for 2.32.3, https://pypi.org/pypi/requests/2.32.3/json, or its LICENSE file).",
  },
  {
    // The number changes every week: the check is that the answer's figure is within 5% of one a tool returned
    // (api.npmjs.org/downloads/point/last-week/react gave 188,481,362 for 2026-10-05 to 2026-10-11).
    id: "hard-react-downloads",
    set: "answer-hard",
    turns: ["How many weekly downloads does the react package get on npm right now?"],
    check: run => {
      const returned = numbers(run.results).filter(n => n >= 1e6);
      const given = numbers(run.answer).filter(n => n >= 1e6);
      const close = given.find(n => returned.some(r => Math.abs(n - r) / r <= 0.05));
      return [
        lookedUp(run),
        [close !== undefined, `a figure within 5% of what a tool returned (said ${given.slice(0, 3).join(", ") || "none"}; tools gave ${returned.slice(0, 3).join(", ") || "none"})`],
        [/npmjs|npm-stat|npmtrends|npm registry|npm's/i.test(run.answer), "names where the number came from"],
        noArtifact(run),
        atMost(run.answer, 120),
      ];
    },
    rubric: [
      "Gives one figure for last week's downloads and the week it covers, or says it is the last 7 days.",
      "Names the source of the figure (npm's download counts API or npmjs.com).",
      "Does not give a remembered figure as current.",
    ],
  },
  {
    // Prose for non-engineers: length bounds and the flourish count are scripted, the rest is judged.
    id: "hard-explain-caching",
    set: "answer-hard",
    turns: ["Write about 300 words for our marketing team, who aren't engineers, explaining why the website sometimes still shows the old page right after we publish an update, and what they can do about it."],
    check: run => {
      const n = wordCount(run.answer), style = mannered(run.answer);
      return [
        [n >= 240 && n <= 360, `about 300 words (${n})`],
        [style.count === 0, `no flourishes (${Object.entries(style.hits).map(([k, v]) => `${k} ×${v}`).join(", ") || "none"})`],
        [/cach/i.test(run.answer), "names caching"],
        noArtifact(run),
      ];
    },
    rubric: [
      "Explains that copies of the page are kept (in the browser and on servers between us and the reader) and served until they expire, in words a non-engineer follows.",
      "Explains or avoids every technical term (cache, CDN, TTL): none is used without saying what it means.",
      "Says what the team can do: a hard refresh or private window to check, waiting a stated kind of interval, or asking engineering to clear (purge) the cache.",
      "Is one piece of prose for the audience, without headings for engineers or code.",
    ],
  },
  {
    // A decision record from given facts: every number in it must come from the prompt.
    id: "hard-decision-record",
    set: "answer-hard",
    turns: [ADR_FACTS],
    check: run => {
      const invented = [...new Set(numbers(unstructured(run.answer)).filter(n => !ADR_NUMBERS.has(n)))];
      return [
        [invented.length === 0, `invents no numbers (${invented.slice(0, 6).join(", ") || "none"})`],
        [/\bcontext\b/i.test(run.answer) && /\bdecision\b/i.test(run.answer) && /\bconsequences?\b/i.test(run.answer), "has context, decision and consequences"],
        [/postgres/i.test(run.answer) && /dynamo/i.test(run.answer), "names both options"],
        noArtifact(run),
      ];
    },
    rubric: [
      "Makes one decision, not a recommendation to keep evaluating.",
      "The decision follows from the facts given (the team's PostgreSQL experience, the reporting joins, the 10-week launch), and says which facts decide it.",
      "States no fact that isn't in the list: no prices, benchmarks, versions or features beyond what was given.",
      "Lists consequences that include a cost or risk of the choice, not only benefits.",
    ],
    reference: "Decision: PostgreSQL on RDS. Three of four engineers have run it in production and none has used DynamoDB; finance's ad-hoc reports need joins; launch is in 10 weeks. Consequences: the team must plan for 2,000 writes per second at peak (and about 10,000 reads) within the $1,500 monthly budget; DynamoDB's model is set aside.",
  },
  {
    // A broad request: assumptions and a first plan, not a list of questions.
    id: "hard-graphql-plan",
    set: "answer-hard",
    turns: ["Help me move our REST API to GraphQL."],
    check: run => {
      const p = prose(run.answer);
      const asked = (p.match(/\?/g) ?? []).length, steps = (p.match(/^\s*(?:\d+[.)]|[-*+])\s+\S/gm) ?? []).length;
      return [
        atMost(run.answer, 450),
        [asked <= 2, `at most two questions (${asked})`],
        [steps >= 3, `gives steps (${steps} list items)`],
        noArtifact(run),
      ];
    },
    rubric: [
      "States the assumptions it makes about the API or stack instead of only asking about them.",
      "Gives concrete steps the user can start on now, such as putting a GraphQL layer in front of the existing REST endpoints and moving one resource first.",
      "Advises an incremental move with REST kept running, not a rewrite all at once.",
      "Asks at most two questions, and only ones whose answers would change the plan.",
    ],
  },
  {
    // A long report saved to a file, with a plan written before it. The plan-first check is expected to fail until the
    // prompt asks for a plan file on long tasks. The judge sees only the chat, so the report is checked by script.
    id: "hard-ssg-report",
    set: "answer-hard",
    timeout: 20 * 60_000,
    turns: ["Write a research report comparing Hugo, Eleventy and Astro for our documentation site: about 300 pages, writers who know Markdown, and a few interactive examples. Cover build speed, templating, how interactive components work, hosting, and community and maintenance, with a source for each claim. Save it as report.md."],
    check: run => {
      const report = Object.entries(run.files ?? {}).find(([p]) => /^\/?report\.md$/i.test(p))?.[1] ?? "";
      const cited = urls(report), read = cited.filter(u => seen(run, u));
      // A goal given to the plan tool is a plan too: the harness writes PLAN.md from it.
      const planned = [writes(run, /^(PLAN|SPEC)\.md$/i), run.calls.findIndex(c => c.name === "plan" && c.input?.goal)].filter(i => i >= 0);
      const plan = planned.length ? Math.min(...planned) : -1, saved = writes(run, /^report\.md$/i);
      const aspects = [/build/i, /templat/i, /island|hydrat|interactiv|component/i, /host|deploy/i, /communit|maintain|release|contributor/i].filter(re => re.test(report)).length;
      return [
        [report.length > 0, "saved report.md"],
        [wordCount(report) >= 800, `a long report (${wordCount(report)} words)`],
        [["Hugo", "Eleventy", "Astro"].every(n => report.includes(n)), "covers all three"],
        [aspects === 5, `covers the five aspects (${aspects}/5)`],
        [cited.length >= 5, `cites sources (${cited.length} links)`],
        [read.length >= 3, `at least three cited links were read (${read.length})`],
        [lookups(run).length >= 3, `researched (${lookups(run).length} lookups)`],
        [plan >= 0 && (saved < 0 || plan < saved), `wrote PLAN.md or SPEC.md before report.md (plan call ${plan}, report call ${saved})`],
      ];
    },
    rubric: [
      "The chat reply says the report was saved to report.md and gives its conclusion in a few lines.",
      "The reply recommends one generator for the stated needs and says why.",
      "Does not claim to have read or measured anything the tool calls don't show.",
    ],
  },
];
