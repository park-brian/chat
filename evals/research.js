// Tasks for the `research` set: questions with one exact answer, pinned to a fixed artifact (a package version on
// jsDelivr, a file at a GitHub commit, an arXiv version), that need fetching and computing to get. GAIA's shape with a
// deterministic key: every expected value below was computed in Node on 2026-10-12 from the URL beside it.
// See docs/specs/2026-10-12-answer-quality-plan.md, "Benchmarks that grade themselves".

// Every number in a text, inline code and code blocks included: 1,234.5, 1.2 million, 5e5, 600k, 188.5M.
// "M" counts as million only in capitals ("188.5M"); a lower-case m is metres or minutes.
const SCALE = { k: 1e3, K: 1e3, thousand: 1e3, million: 1e6, M: 1e6, bn: 1e9, billion: 1e9 };
export function numbers(text) {
  const t = String(text ?? "").replaceAll("`", " ").replace(/(\d),(?=\d{3}\b)/g, "$1");
  return [...t.matchAll(/(\d+(?:\.\d+)?)(?:e(\d+)\b|\s*([Tt]housand|[Mm]illion|[Bb]illion|bn|k|K|M)\b)?/g)]
    .map(m => Number(m[1]) * (m[2] ? 10 ** Number(m[2]) : SCALE[m[3]?.length > 2 ? m[3].toLowerCase() : m[3]] ?? 1));
}
// Looked something up: a search, a page read, or code that fetched.
export const lookups = run => run.calls.filter(c => ["web_search", "read_url"].includes(c.name) || (c.name === "code" && /fetch\(|https?:\/\/|web\.read/.test(c.input?.source ?? "")));
export const lookedUp = run => [lookups(run).length > 0, `looked it up (${lookups(run).map(c => c.name).join(", ") || "no lookups"})`];
const computed = run => {
  const code = run.calls.filter(c => c.name === "code");
  return [code.length > 0, `computed with the code tool (${code.length} runs)`];
};
// The value came back from a tool, so it was computed rather than guessed. Tool output is JSON text: a number's
// digits stand as they are, so a pattern over the joined results finds it.
const inResults = (run, re, what) => [re.test(run.results ?? ""), `${what} appears in tool output`];
const hasNumber = (text, want, tol = 0) => numbers(text).some(n => Math.abs(n - want) <= tol);
const noArtifact = run => [!Object.keys(run.files ?? {}).some(p => !p.startsWith("scratch/") && !["PLAN.md", "SPEC.md"].includes(p.split("/").pop())), "no artifact"];

// What every research answer should look like; the judge also adds the plain-writing criterion.
const RUBRIC = [
  "Gives the answer in the first sentence or line, before any explanation.",
  "Says in a line or two how the value was found or computed (what was fetched, what the code counted).",
  "Names the source: the URL, or the package, version and file it read.",
];

export default [
  {
    // sha256 of the bytes at the URL: node -e "crypto.createHash('sha256').update(buf).digest('hex')" (14,109 bytes).
    id: "research-sha-readme",
    set: "research",
    turns: ["What is the SHA-256 hash of the README.md that ships in the solid-js 1.9.0 npm package (jsDelivr has it)? Give the hex digest."],
    check: run => {
      const sha = "eee332d8f2a7f76b2384288002676c3aabc9c02d996c567de51f80748e404263";
      return [
        [run.answer.toLowerCase().includes(sha), "gives the digest eee332d8…404263"],
        lookedUp(run),
        computed(run),
        inResults(run, new RegExp(sha, "i"), "the digest"),
        noArtifact(run),
      ];
    },
    rubric: RUBRIC,
    reference: "eee332d8f2a7f76b2384288002676c3aabc9c02d996c567de51f80748e404263, the SHA-256 of https://cdn.jsdelivr.net/npm/solid-js@1.9.0/README.md (14,109 bytes), computed with crypto.subtle.digest over the fetched bytes.",
  },
  {
    // https://cdn.jsdelivr.net/npm/solid-js@1.9.0/dist/solid.js split on "\n": line 251 is "function createMemo(fn, value, options) {"
    // (createSignal is 197, createEffect 224; the file has 1,899 lines).
    id: "research-line-creatememo",
    set: "research",
    turns: ["In solid-js 1.9.0, which line of dist/solid.js defines the createMemo function? Just the line number and how you found it."],
    check: run => [
      [hasNumber(run.answer, 251), "line 251"],
      lookedUp(run),
      computed(run),
      inResults(run, /\b251\b/, "251"),
      noArtifact(run),
    ],
    rubric: RUBRIC,
    reference: "Line 251: `function createMemo(fn, value, options) {` in https://cdn.jsdelivr.net/npm/solid-js@1.9.0/dist/solid.js, found by splitting the fetched file into lines and searching for the declaration.",
  },
  {
    // data.jsdelivr.com/v1/packages/npm/preact@10.19.3?structure=flat: 131 files, sizes summing to 1,352,265 bytes;
    // registry.npmjs.org/preact/10.19.3 dist.fileCount 131 and dist.unpackedSize 1352265 agree.
    id: "research-preact-files",
    set: "research",
    turns: ["How many files does the preact 10.19.3 npm package contain, and what is their total size in bytes?"],
    check: run => [
      [hasNumber(run.answer, 131), "131 files"],
      [hasNumber(run.answer, 1352265), "1,352,265 bytes"],
      lookedUp(run),
      inResults(run, /\b1352265\b/, "1352265"),
      noArtifact(run),
    ],
    rubric: RUBRIC,
    reference: "131 files, 1,352,265 bytes in total: the sum of the sizes in jsDelivr's flat file list (https://data.jsdelivr.com/v1/packages/npm/preact@10.19.3?structure=flat), which matches the npm registry's dist.fileCount and dist.unpackedSize.",
  },
  {
    // https://cdn.jsdelivr.net/npm/vega-datasets@2.8.0/data/seattle-weather.csv: 1,461 days, 2012-2015. Summing
    // precipitation by date.slice(0, 7): 2015-12 = 284.5 mm, then 2014-03 = 240.0 and 2015-11 = 212.6.
    id: "research-seattle-rain",
    set: "research",
    turns: ["In the seattle-weather.csv from the vega-datasets 2.8.0 npm package, which calendar month (year and month) had the most total precipitation, and how much was it?"],
    check: run => {
      const a = run.answer;
      return [
        [/2015-12|dec(ember)?\.?,? 2015|12\/2015/i.test(a), "December 2015"],
        [hasNumber(a, 284.5, 0.06), "284.5 mm"],
        lookedUp(run),
        computed(run),
        inResults(run, /284\.(5|49{3,})/, "284.5"),
        noArtifact(run),
      ];
    },
    rubric: RUBRIC,
    reference: "December 2015, with 284.5 mm of precipitation in total (next: March 2014, 240.0 mm). Computed by summing the precipitation column of https://cdn.jsdelivr.net/npm/vega-datasets@2.8.0/data/seattle-weather.csv by year and month.",
  },
  {
    // https://raw.githubusercontent.com/expressjs/express/8368dc178af16b91b576c4c1d135f701a0007e5d/History.md (tag 4.18.2):
    // headings "x.y.z / YYYY-MM-DD" underlined with "===": 83 start with "4." (4.0.0 to 4.18.2); by year 2014: 48,
    // 2015: 14, 2017: 10, 2022: 4, 2016/2018/2019: 2, 2021: 1.
    id: "research-express-history",
    set: "research",
    turns: ["Look at express's History.md as of commit 8368dc178af16b91b576c4c1d135f701a0007e5d (github.com/expressjs/express). How many 4.x releases does it list, and in which year were the most of them released?"],
    check: run => {
      const a = run.answer;
      return [
        [hasNumber(a, 83), "83 releases"],
        [/\b2014\b/.test(a) && hasNumber(a, 48), "2014, with 48"],
        lookedUp(run),
        computed(run),
        inResults(run, /\b83\b/, "83"),
        noArtifact(run),
      ];
    },
    rubric: RUBRIC,
    reference: "83 releases from 4.0.0 to 4.18.2; 2014 had the most, 48 (then 2015 with 14). Counted from the release headings (\"4.x.y / date\") in https://raw.githubusercontent.com/expressjs/express/8368dc178af16b91b576c4c1d135f701a0007e5d/History.md.",
  },
  {
    // https://export.arxiv.org/api/query?id_list=2307.09288v2: 68 <author> entries; <published> 2023-07-18T14:31:57Z (v1),
    // <updated> 2023-07-19T17:08:59Z (v2): 95,822 s apart = 26 h 37 min 2 s.
    id: "research-arxiv-llama2",
    set: "research",
    turns: ["For arXiv paper 2307.09288 (version 2), how many authors are listed, and how long after version 1 was version 2 submitted, in hours and minutes?"],
    check: run => {
      const a = run.answer;
      return [
        [hasNumber(a, 68), "68 authors"],
        [/\b26\s*(h|hours?|hrs?)\b[^.\n]{0,12}?\b37\s*(m|min|minutes?)\b|\b26:37\b/i.test(a), "26 hours 37 minutes"],
        lookedUp(run),
        computed(run),
        inResults(run, /\b68\b/, "68"),
        inResults(run, /\b26\b\D{1,30}\b37\b|\b95822\b|\b1597(\.\d+)?\b|\b26\.6[12]\d*/, "the interval"),
        noArtifact(run),
      ];
    },
    rubric: RUBRIC,
    reference: "68 authors. v1 was submitted 2023-07-18 14:31:57 UTC and v2 2023-07-19 17:08:59 UTC, 26 hours 37 minutes later. From the arXiv API record https://export.arxiv.org/api/query?id_list=2307.09288v2 (or the abstract page's submission history).",
  },
  {
    // https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.js has two right answers. Run as a browser script it attaches
    // to window._ with 307 keys, 305 of them functions (VERSION and templateSettings are not). Loaded as CommonJS
    // (module.exports) it also sets _._ to itself: 308 keys, 306 functions. Either passes if the tool output shows it.
    id: "research-lodash-functions",
    set: "research",
    turns: ["How many functions does lodash 4.17.21 (lodash.js from jsDelivr) put on `_`? Count its own enumerable properties whose value is a function."],
    check: run => {
      const a = run.answer;
      return [
        [hasNumber(a, 305) || hasNumber(a, 306), "305 functions (browser script) or 306 (CommonJS)"],
        lookedUp(run),
        computed(run),
        hasNumber(a, 305) ? inResults(run, /\b305\b/, "305") : inResults(run, /\b306\b/, "306"),
        noArtifact(run),
      ];
    },
    rubric: RUBRIC,
    reference: "305 when lodash.js runs as a browser script (window._ has 307 keys; VERSION and templateSettings are not functions), or 306 when it is loaded as CommonJS, which adds _._ itself. Either is right if the answer says how it was loaded.",
  },
];
