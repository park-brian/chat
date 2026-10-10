import { createHash } from "node:crypto";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const canonical = JSON.stringify(
  JSON.parse(await readFile(path.join(root, "shared/importmap.json"), "utf8")),
  null,
  2,
);
const map =
  "'sha384-" + createHash("sha384").update(canonical).digest("base64") + "'";
const policy = [
  "default-src 'none'",
  // solid-js/html compiles static tagged templates with Function at runtime.
  `script-src 'self' 'unsafe-eval' ${map} https://cdn.jsdelivr.net`,
  "style-src 'self'",
  "connect-src 'self' https://*.amazonaws.com https://*.amazoncognito.com",
  "img-src 'self' data:",
  "font-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
].join("; ");
const folders = [
  root,
  ...(await readdir(root, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isDirectory() &&
        [
          "profile",
          "users",
          "usage",
          "agents",
          "connectors",
          "credentials",
        ].includes(entry.name),
    )
    .map((entry) => path.join(root, entry.name)),
];
if (folders.length !== 7) throw Error("Expected seven page entrypoints");
// Painted before Solid loads from the CDN; mountPage replaces it. Kept identical on every page.
const boot = [
  '<div id="app"><!--boot-->',
  '<div class="page-layout" data-app-state="connecting" data-boot-phase="static">',
  '<header class="topbar" data-busy><span class="brand"><span class="mark" aria-hidden="true">✦</span><span class="brand-name">agentcore</span></span><span class="activity" aria-hidden="true"></span></header>',
  '<main class="page-main"><section class="boot" role="status"><span class="boot-mark" aria-hidden="true">✦</span><h1 class="boot-title">Opening agentcore</h1><p class="boot-detail">Loading the workspace shell.</p></section></main>',
  "</div>",
  "<!--/boot--></div>",
].join("\n    ");
for (const folder of folders) {
  const file = path.join(folder, "index.html"),
    // HTML parsing normalizes CRLF before CSP hashing; Git checkouts may use either.
    source = (await readFile(file, "utf8")).replaceAll("\r\n", "\n");
  if (
    [...source.matchAll(/<script type="importmap">/g)].length !== 1 ||
    !source.includes('<script type="module" src="./app.js"></script>')
  )
    throw Error(`Invalid page entrypoint: ${file}`);
  const updated = source
    .replace(
      /(<script type="importmap">)[\s\S]*?(<\/script>)/,
      `$1${canonical}$2`,
    )
    .replace(/<div id="app">(<!--boot-->[\s\S]*?<!--\/boot-->)?<\/div>/, boot)
    .replace(
      /(<meta id="app-csp" http-equiv="Content-Security-Policy" content=")[^"]*(">)/,
      `$1${policy}$2`,
    );
  if (!updated.includes(policy)) throw Error(`Missing CSP element: ${file}`);
  if (!updated.includes(boot)) throw Error(`Missing app root: ${file}`);
  if (process.argv.includes("--check")) {
    if (updated !== source)
      throw Error(`CSP/import map/boot shell is stale: ${file}; run npm run csp:sync`);
  } else if (updated !== source) await writeFile(file, updated);
}
console.log("CSP and pinned imports checked for seven pages");
