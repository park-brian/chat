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
// Scripts load only from the one pinned package the import map names.
const packages = new Set(
  Object.values(JSON.parse(canonical).imports).map(
    (url) => url.match(/^https:\/\/cdn\.jsdelivr\.net\/npm\/[\w.-]+@[\w.-]+\//)?.[0],
  ),
);
if (packages.size !== 1 || packages.has(undefined))
  throw Error("Import map must pin one jsDelivr package version");
const [cdn] = packages;
const hash = (text) =>
  "'sha384-" + createHash("sha384").update(text).digest("base64") + "'";
// Classic and render-blocking, so it registers before the first render: Chrome
// fires pagereveal before module scripts run. It records the incoming
// transition and marks its promises handled, since a skipped transition is not
// an application error.
const reveal =
  'addEventListener("pagereveal",(e)=>{const t=e.viewTransition;if(!t)return;' +
  'for(const k of["ready","updateCallbackDone","finished"])t[k].catch(()=>{});' +
  "window.agentcoreReveal=t.finished.catch(()=>{})})";
const policy = [
  "default-src 'none'",
  // solid-js/html compiles static tagged templates with Function at runtime.
  `script-src 'self' 'unsafe-eval' ${hash(canonical)} ${hash(reveal)} ${cdn}`,
  "style-src 'self'",
  // The Runtime, S3 presigned uploads (<bucket>.s3.<region>) and the Cognito
  // hosted domain vary by deployment region; CSP wildcards are leftmost only.
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
// Painted before Solid loads from the CDN; mountPage replaces it. It mirrors the
// rendered top bar with this page's tab active, so a cross-document view
// transition never shows the bar without its tabs.
const primary = [
  ["chat", "Chat"],
  ["agents", "Agents"],
  ["connectors", "Connectors"],
  ["usage", "Usage"],
];
const boot = (key) =>
  [
    '<div id="app"><!--boot-->',
    '<div class="page-layout" data-app-state="connecting" data-boot-phase="static">',
    '<header class="topbar" data-busy><span class="brand"><span class="mark" aria-hidden="true">✦</span><span class="brand-name">agentcore</span></span>' +
      '<div class="topbar-status"></div><div class="site-menu"><div class="primary-nav" aria-hidden="true">' +
      primary
        .map(
          ([page, title]) =>
            `<span class="nav${page === key ? " active" : ""}">${title}</span>`,
        )
        .join("") +
      '</div><div class="menu account"><span class="menu-trigger"><span class="avatar-mark"></span></span></div></div>' +
      '<span class="menu-toggle" aria-hidden="true">☰</span><span class="activity" aria-hidden="true"></span></header>',
    '<main class="page-main"><section class="boot" role="status"><span class="boot-mark" aria-hidden="true">✦</span><h1 class="boot-title">Opening agentcore</h1><p class="boot-detail">Loading the workspace shell.</p></section></main>',
    "</div>",
    "<!--/boot--></div>",
  ].join("\n    ");
for (const folder of folders) {
  const file = path.join(folder, "index.html"),
    shell = boot(folder === root ? "chat" : path.basename(folder)),
    // HTML parsing normalizes CRLF before CSP hashing; Git checkouts may use either.
    source = (await readFile(file, "utf8")).replaceAll("\r\n", "\n");
  if (
    [...source.matchAll(/<script type="importmap">/g)].length !== 1 ||
    !source.includes('<script type="module" src="./app.js"></script>')
  )
    throw Error(`Invalid page entrypoint: ${file}`);
  const updated = source
    .replace(
      /(<script type="importmap">)[\s\S]*?(<\/script>)(\n {2}<script>[\s\S]*?<\/script>)?/,
      `$1${canonical}$2\n  <script>${reveal}</script>`,
    )
    .replace(/<div id="app">(<!--boot-->[\s\S]*?<!--\/boot-->)?<\/div>/, shell)
    .replace(
      /(<meta id="app-csp" http-equiv="Content-Security-Policy" content=")[^"]*(">)/,
      `$1${policy}$2`,
    );
  if (!updated.includes(policy)) throw Error(`Missing CSP element: ${file}`);
  if (!updated.includes(shell)) throw Error(`Missing app root: ${file}`);
  if (!updated.includes(reveal)) throw Error(`Missing reveal handler: ${file}`);
  if (process.argv.includes("--check")) {
    if (updated !== source)
      throw Error(
        `CSP/import map/boot shell is stale: ${file}; run npm run csp:sync`,
      );
  } else if (updated !== source) await writeFile(file, updated);
}
console.log("CSP, pinned imports and boot shells checked for seven pages");
