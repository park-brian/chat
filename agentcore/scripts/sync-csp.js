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
    .replace(
      /(<meta id="app-csp" http-equiv="Content-Security-Policy" content=")[^"]*(">)/,
      `$1${policy}$2`,
    );
  if (!updated.includes(policy)) throw Error(`Missing CSP element: ${file}`);
  if (process.argv.includes("--check")) {
    if (updated !== source)
      throw Error(`CSP/import map is stale: ${file}; run npm run csp:sync`);
  } else if (updated !== source) await writeFile(file, updated);
}
console.log("CSP and pinned imports checked for seven pages");
