import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const file = fileURLToPath(new URL("../index.html", import.meta.url));
const source = await readFile(file, "utf8");
const one = (expression, label) => {
  const matches = [...source.matchAll(expression)];
  if (matches.length !== 1) throw new Error(`Expected one ${label}`);
  return matches[0][1];
};
const hash = (text) =>
  "'sha384-" + createHash("sha384").update(text).digest("base64") + "'";
const style = hash(one(/<style>([\s\S]*?)<\/style>/g, "stylesheet"));
const map = hash(
  one(/<script type="importmap">([\s\S]*?)<\/script>/g, "import map"),
);
const app = hash(
  one(/<script type="module">([\s\S]*?)<\/script>/g, "application module"),
);
const policy = [
  "default-src 'none'",
  // solid-js/html compiles static tagged templates with Function at runtime.
  `script-src 'self' 'unsafe-eval' ${map} ${app} https://cdn.jsdelivr.net`,
  `style-src ${style}`,
  "connect-src 'self' https://*.amazonaws.com https://*.amazoncognito.com",
  "img-src 'self' data:",
  "font-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
].join("; ");
const updated = source.replace(
  /(<meta\s+id="app-csp"\s+http-equiv="Content-Security-Policy"\s+content=")[^"]*("\s*\/?>)/,
  `$1${policy}$2`,
);
if (updated === source && !source.includes(policy))
  throw new Error("CSP meta element is missing");
if (process.argv.includes("--check")) {
  if (updated !== source)
    throw new Error("CSP hashes are stale; run npm run csp:sync");
} else if (updated !== source) {
  await writeFile(file, updated);
  console.log("Updated AgentCore inline CSP hashes");
}
