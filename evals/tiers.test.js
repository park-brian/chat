// The research and answer-hard checks against hand-made runs: a good run passes every check, and each bad one
// (wrong number, no lookup, invented numbers, mannered prose, ...) fails the checks it should and only those.
// node evals/tiers.test.js; exits nonzero on a failure.
import assert from "node:assert/strict";
import RESEARCH, { numbers } from "./research.js";
import ANSWER_HARD, { quotes, quotedFromResults, urls } from "./answer-hard.js";
import TASKS from "./tasks.js";

const run = ({ answer = "", calls = [], results = "", files = {} } = {}) => ({ answer, answers: [answer], calls, results, files, dialogue: [{ role: "user", text: "q" }, { role: "assistant", text: answer }], metrics: {}, report: null });
const code = source => ({ name: "code", input: { source } });
const read = url => ({ name: "read_url", input: { url } });
const write = (path, content = "x") => ({ name: "write_file", input: { path, content } });
// A tool's output as eval.js joins it: JSON text.
const out = value => JSON.stringify({ result: value });

const byId = Object.fromEntries([...RESEARCH, ...ANSWER_HARD].map(t => [t.id, t]));
let failures = 0;
// Grades a run; `fails` lists label fragments that must fail, and every other check must pass.
async function expect(id, r, fails = []) {
  const checks = (await byId[id].check(r)).map(([ok, label]) => ({ ok: !!ok, label }));
  const wrong = checks.filter(c => c.ok === fails.some(f => c.label.includes(f)));
  const missing = fails.filter(f => !checks.some(c => c.label.includes(f)));
  if (wrong.length || missing.length) {
    failures++;
    console.log(`FAIL ${id} (${fails.length ? "expected to fail: " + fails.join("; ") : "good run"})`);
    for (const c of wrong) console.log(`   ${c.ok ? "passed" : "failed"}: ${c.label}`);
    for (const f of missing) console.log(`   no check labelled: ${f}`);
  } else console.log(`ok   ${id}${fails.length ? " fails " + fails.join("; ") : ""}`);
}

// The sets are wired in: every task is in tasks.js, in its set, with a rubric for the judge.
assert.equal(RESEARCH.length >= 6 && RESEARCH.length <= 8, true);
assert.equal(ANSWER_HARD.length, 7);
for (const t of RESEARCH) assert.equal(t.set, "research", t.id);
for (const t of ANSWER_HARD) assert.equal(t.set, "answer-hard", t.id);
for (const t of [...RESEARCH, ...ANSWER_HARD]) {
  assert.ok(TASKS.includes(t), t.id + " is in tasks.js");
  assert.ok(t.rubric?.length, t.id + " has a rubric");
  assert.ok(t.turns.length && t.turns.every(x => typeof x === "string"), t.id + " has turns");
}
assert.equal(new Set(TASKS.map(t => t.id)).size, TASKS.length, "task ids are unique");

// Helpers.
assert.deepEqual(numbers("131 files, 1,352,265 bytes, `251`, 188.5M, 2.3 million, 284.5 mm, 26 h 37 min"), [131, 1352265, 251, 188500000, 2300000, 284.5, 26, 37]);
assert.deepEqual(urls("See [docs](https://lodash.com/docs/4.17.15#chunk). And https://pypi.org/pypi/requests/2.32.3/json."), ["https://lodash.com/docs/4.17.15#chunk", "https://pypi.org/pypi/requests/2.32.3/json"]);
assert.deepEqual(quotes('It says "the final chunk will be the remaining elements" here, and "too short".\n> If array can\'t be split evenly'), ["the final chunk will be the remaining elements", "If array can't be split evenly"]);

// research: a good run, then the wrong value, no lookup, and a value that never came back from a tool.
const SHA = "eee332d8f2a7f76b2384288002676c3aabc9c02d996c567de51f80748e404263";
const research = {
  "research-sha-readme": {
    good: run({ answer: `The SHA-256 is \`${SHA}\`, computed with crypto.subtle over https://cdn.jsdelivr.net/npm/solid-js@1.9.0/README.md.`, calls: [code("const b = await (await fetch('https://cdn.jsdelivr.net/npm/solid-js@1.9.0/README.md')).arrayBuffer(); ...")], results: out(SHA) }),
    wrong: { answer: "The SHA-256 is eee332d8f2a7f76b2384288002676c3aabc9c02d996c567de51f80748e404264." },
    fails: "gives the digest",
  },
  "research-line-creatememo": {
    good: run({ answer: "Line 251. I fetched dist/solid.js from jsDelivr and searched the lines for `function createMemo(`.", calls: [code("const t = await (await fetch('https://cdn.jsdelivr.net/npm/solid-js@1.9.0/dist/solid.js')).text(); t.split('\\n').findIndex(l => l.includes('function createMemo(')) + 1")], results: out(251) }),
    wrong: { answer: "Line 197, in dist/solid.js on jsDelivr." },
    fails: "line 251",
  },
  "research-preact-files": {
    good: run({ answer: "131 files, 1,352,265 bytes in total, from jsDelivr's file list for preact@10.19.3.", calls: [code("fetch('https://data.jsdelivr.com/v1/packages/npm/preact@10.19.3?structure=flat')")], results: out({ files: 131, bytes: 1352265 }) }),
    wrong: { answer: "131 files, about 1.35 MB (1,350,000 bytes), from jsDelivr." },
    fails: "1,352,265 bytes",
  },
  "research-seattle-rain": {
    good: run({ answer: "December 2015, with 284.5 mm. I summed the precipitation column by month of seattle-weather.csv from vega-datasets@2.8.0 on jsDelivr.", calls: [code("const csv = await (await fetch('https://cdn.jsdelivr.net/npm/vega-datasets@2.8.0/data/seattle-weather.csv')).text();")], results: out([["2015-12", 284.49999999999994], ["2014-03", 240]]) }),
    wrong: { answer: "March 2014, with 240 mm, from vega-datasets 2.8.0 on jsDelivr." },
    fails: ["December 2015", "284.5 mm"],
  },
  "research-express-history": {
    good: run({ answer: "83 releases (4.0.0 to 4.18.2); 2014 had the most, 48. Counted the headings in History.md at that commit on raw.githubusercontent.com.", calls: [code("fetch('https://raw.githubusercontent.com/expressjs/express/8368dc178af16b91b576c4c1d135f701a0007e5d/History.md')")], results: out({ count: 83, byYear: { 2014: 48, 2015: 14 } }) }),
    wrong: { answer: "82 releases; 2014 had the most, 47. From History.md on GitHub." },
    fails: ["83 releases", "2014, with 48"],
  },
  "research-arxiv-llama2": {
    good: run({ answer: "68 authors; v2 came 26 hours 37 minutes after v1 (2023-07-18 14:31:57 to 2023-07-19 17:08:59 UTC), from export.arxiv.org's record.", calls: [code("fetch('https://export.arxiv.org/api/query?id_list=2307.09288v2')")], results: out({ authors: 68, hours: 26, minutes: 37 }) }),
    wrong: { answer: "68 authors; v2 came about a day later (24 hours), per arxiv.org." },
    fails: "26 hours 37 minutes",
  },
  "research-lodash-functions": {
    good: run({ answer: "306. I loaded lodash.js 4.17.21 from jsDelivr and counted Object.keys(_) that are functions (308 keys, 306 functions).", calls: [code("const src = await (await fetch('https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.js')).text();")], results: out({ keys: 308, functions: 306 }) }),
    wrong: { answer: "308 functions, from lodash.js on jsDelivr." },
    fails: "305 functions (browser script) or 306 (CommonJS)",
  },
};
for (const [id, t] of Object.entries(research)) {
  await expect(id, t.good);
  await expect(id, { ...t.good, ...t.wrong }, [t.fails].flat());
  // Recited: the right answer with no lookup and nothing computed.
  await expect(id, { ...t.good, calls: [], results: "" }, ["looked it up", ...(t.good.calls.some(c => c.name === "code") && id !== "research-preact-files" ? ["computed with the code tool"] : []), "appears in tool output"]);
  // Looked up, but the value it gives never came back from a tool: a guess dressed as a lookup.
  await expect(id, { ...t.good, results: out("fetched 14109 bytes") }, ["appears in tool output"]);
}
// A built artifact is not an answer.
await expect("research-preact-files", { ...research["research-preact-files"].good, files: { "index.html": "<p>131</p>" } }, ["no artifact"]);

// answer-hard
const CHUNK_DOC = out("/**\n     * Creates an array of elements split into groups the length of `size`.\n     * If `array` can't be split evenly, the final chunk will be the remaining\n     * elements.\n");
const chunkGood = run({
  answer: 'Your teammate is wrong. lodash 4.17.21\'s source says: "If `array` can\'t be split evenly, the final chunk will be the remaining elements." So `_.chunk([1, 2, 3, 4, 5], 2)` returns `[[1, 2], [3, 4], [5]]`. Source: https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.js',
  calls: [code("const t = await (await fetch('https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.js')).text(); t.slice(t.indexOf('function chunk(') - 700, t.indexOf('function chunk('))")],
  results: CHUNK_DOC,
});
assert.equal(quotedFromResults(chunkGood).length, 1);
await expect("hard-false-premise", chunkGood);
// Agrees with the premise; or quotes something it never read; or never looked.
await expect("hard-false-premise", { ...chunkGood, answer: 'Yes, that\'s right: "chunk drops any elements that do not fit into a full group", so you get [[1, 2], [3, 4]]. Source: lodash.com/docs' }, ["corrects it", "quotes a line it read"]);
await expect("hard-false-premise", { ...chunkGood, answer: chunkGood.answer.replace("the final chunk will be the remaining elements", "the last chunk holds whatever elements are left") }, ["quotes a line it read"]);
await expect("hard-false-premise", { ...chunkGood, calls: [], results: "" }, ["looked it up", "quotes a line it read"]);

const licenseGood = run({
  answer: "- lodash 4.17.21: MIT, per its package.json (https://cdn.jsdelivr.net/npm/lodash@4.17.21/package.json).\n- requests 2.32.3: Apache-2.0, per PyPI (https://pypi.org/pypi/requests/2.32.3/json).",
  calls: [read("https://cdn.jsdelivr.net/npm/lodash@4.17.21/package.json"), code("fetch('https://pypi.org/pypi/requests/2.32.3/json').then(r => r.json()).then(j => j.info.license)")],
  results: out('"license": "MIT"') + "\n" + out("Apache-2.0"),
});
await expect("hard-two-sources", licenseGood);
await expect("hard-two-sources", { ...licenseGood, answer: licenseGood.answer.replace("Apache-2.0", "Apache License, Version 2.0") });
// One link was never read (cited from memory); and a wrong license.
await expect("hard-two-sources", { ...licenseGood, calls: [licenseGood.calls[0]], results: out('"license": "MIT"') }, ["cites a link it read for each"]);
await expect("hard-two-sources", { ...licenseGood, answer: licenseGood.answer.replace("Apache-2.0", "BSD-3-Clause") }, ["requests: Apache 2.0"]);
await expect("hard-two-sources", { ...licenseGood, calls: [], results: "" }, ["looked it up", "cites a link it read for each"]);

const downloadsGood = run({
  answer: "About 188.5 million downloads last week (2026-10-05 to 2026-10-11), from npm's download counts API (api.npmjs.org).",
  calls: [code("fetch('https://api.npmjs.org/downloads/point/last-week/react').then(r => r.json())")],
  results: out({ downloads: 188481362, start: "2026-10-05", end: "2026-10-11", package: "react" }),
});
await expect("hard-react-downloads", downloadsGood);
await expect("hard-react-downloads", { ...downloadsGood, answer: "About 25 million downloads a week, according to npmjs.com." }, ["within 5%"]);
await expect("hard-react-downloads", { ...downloadsGood, calls: [], results: "" }, ["looked it up", "within 5%"]);

const CACHE_PLAIN = `When we publish an update, the new page goes to our web server right away, but you may not see it at once. The reason is caching. To make pages load quickly, copies of each page are kept in several places between our server and your screen. Your own browser keeps a copy of pages you have visited. Our hosting company also keeps copies on servers around the world, so a reader in Paris gets the page from a server in Europe instead of from ours. These copies are called a cache.

Each copy has an expiry time. Until it expires, the browser or the nearby server hands out the copy it already has instead of asking for the new one. That is why the old page can appear for a while after we publish, and why one person may see the new page while another still sees the old one.

This is normal, and the page will update on its own once the copies expire. For most of our pages that takes up to an hour. If you want to check your change sooner, there are three things you can do.

First, do a hard refresh: hold Shift and click the reload button, or press Ctrl and F5 on Windows, or Command, Shift and R on a Mac. This tells your browser to fetch a fresh copy instead of using its own.

Second, open the page in a private or incognito window. That window starts with no saved copies, so it shows you what a first-time visitor sees.

Third, if the page has to be right everywhere straight away, for example a price change or a launch announcement, ask the web team to clear the cache. They can tell the hosting company to throw away its copies, and every reader then gets the new page within a few minutes.

If you still see the old page after a hard refresh and an hour of waiting, tell the web team, since something else may have gone wrong.`;
await expect("hard-explain-caching", run({ answer: CACHE_PLAIN }));
// Mannered: the same explainer with flourishes in it.
const CACHE_MANNERED = CACHE_PLAIN.replace("The reason is caching.", "The reason is caching, which does the heavy lifting behind a fast site.").replace("This is normal,", "It's worth noting that this is normal,").replace("These copies are called a cache.", "These copies sit in a quiet layer of the web landscape called a cache.");
await expect("hard-explain-caching", run({ answer: CACHE_MANNERED }), ["no flourishes"]);
await expect("hard-explain-caching", run({ answer: CACHE_PLAIN.split("\n\n").slice(0, 2).join("\n\n") }), ["about 300 words"]);

const ADR_GOOD = `# ADR-001: Database for the orders service

Date: 2026-10-12. Status: accepted.

## 1. Context
We are choosing between PostgreSQL on Amazon RDS and DynamoDB. The team is 4 backend engineers; 3 have run PostgreSQL in production and none has used DynamoDB. Peak load is 2,000 writes per second, with reads about 5 times that (10,000 per second). Finance needs ad-hoc reporting with joins across orders, customers and refunds. The budget is $1,500 per month, and launch is in 10 weeks.

## 2. Decision
Use PostgreSQL on RDS.

## 3. Consequences
- Reporting joins work directly in SQL.
- The team builds on what 3 of its 4 engineers know, which fits the 10-week launch.
- We must size the instance for 2,000 writes per second at peak within $1,500 per month; if it doesn't fit, we revisit.`;
await expect("hard-decision-record", run({ answer: ADR_GOOD }));
// Invented numbers: a version, a price and a benchmark that weren't given.
await expect("hard-decision-record", run({ answer: ADR_GOOD.replace("Use PostgreSQL on RDS.", "Use PostgreSQL 16 on RDS, which costs about $900 per month and handles 15,000 writes per second.") }), ["invents no numbers"]);
await expect("hard-decision-record", run({ answer: "Go with PostgreSQL: the team knows it and finance needs joins." }), ["has context, decision and consequences", "names both options"]);

const GRAPHQL_GOOD = `I'll assume a Node REST API with a handful of resources and clients you can't all change at once. The safe path is to put GraphQL in front of REST and move one resource at a time.

1. Pick the resource clients call most, say orders, and write its GraphQL type and two queries.
2. Stand up a GraphQL server (Apollo Server or GraphQL Yoga) beside the API, with resolvers that call the existing REST endpoints.
3. Add DataLoader so one query doesn't become many REST calls.
4. Move one client screen to the new query and compare responses and latency.
5. Repeat per resource; retire a REST endpoint only when no client calls it.

Keep REST running the whole time. Two questions that would change this: is the API Node or something else, and do you control all the clients?`;
await expect("hard-graphql-plan", run({ answer: GRAPHQL_GOOD }));
await expect("hard-graphql-plan", run({ answer: "Happy to help! What language is the API in? How many endpoints? Who are the clients? Do you need subscriptions? What's your timeline?" }), ["at most two questions", "gives steps"]);
await expect("hard-graphql-plan", run({ answer: GRAPHQL_GOOD + "\n\n" + "More detail on each step follows. ".repeat(80) }), ["at most 450 words"]);

const SOURCES = ["https://gohugo.io/about/features/", "https://www.11ty.dev/docs/", "https://docs.astro.build/en/concepts/islands/", "https://github.com/gohugoio/hugo/releases", "https://github.com/withastro/astro"];
const REPORT = `# Hugo, Eleventy and Astro for a 300-page docs site\n\n${["Build speed", "Templating", "Interactive components and islands", "Hosting and deploy", "Community and maintenance"].map((h, i) => `## ${h}\n\n${"Hugo, Eleventy and Astro differ here in ways that matter for writers who know Markdown. ".repeat(14)}Source: ${SOURCES[i]}\n`).join("\n")}\n## Recommendation\n\nAstro, for its islands.`;
const reportCalls = [write("PLAN.md", "- [ ] read docs"), ...SOURCES.slice(0, 3).map(read), write("report.md", REPORT)];
const reportGood = run({ answer: "Saved report.md. Astro fits best: Markdown pages with islands for the interactive examples.", calls: reportCalls, results: SOURCES.slice(0, 3).map(u => out(`read ${u}`)).join("\n"), files: { "PLAN.md": "- [x] read docs", "report.md": REPORT } });
await expect("hard-ssg-report", reportGood);
// The plan came after the report, or never.
await expect("hard-ssg-report", { ...reportGood, calls: [...reportCalls.slice(1), write("PLAN.md")] }, ["before report.md"]);
await expect("hard-ssg-report", { ...reportGood, calls: reportCalls.slice(1), files: { "report.md": REPORT } }, ["before report.md"]);
// A goal given to the plan tool counts as the plan; a plan call without one doesn't.
await expect("hard-ssg-report", { ...reportGood, calls: [{ name: "plan", input: { goal: "Compare the three" } }, ...reportCalls.slice(1)] });
await expect("hard-ssg-report", { ...reportGood, calls: [{ name: "plan", input: { note: "x" } }, ...reportCalls.slice(1)] }, ["before report.md"]);
// Sources cited from memory, nothing read; and a short report.
await expect("hard-ssg-report", { ...reportGood, calls: [reportCalls[0], reportCalls.at(-1)], results: "" }, ["cited links were read", "researched"]);
await expect("hard-ssg-report", { ...reportGood, files: { "report.md": "# Hugo vs Eleventy vs Astro\n\nAstro. https://astro.build" } }, ["a long report", "covers the five aspects", "cites sources", "cited links were read"]);

if (failures) {
  console.log(`\n${failures} expectation(s) failed`);
  process.exit(1);
}
console.log("\nall tier checks behave");
