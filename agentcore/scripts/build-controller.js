import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { zipSync } from "fflate";

const output = await build({
  entryPoints: [fileURLToPath(new URL("../controller.js", import.meta.url))],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  write: false,
  logLevel: "silent",
});
const code = output.outputFiles[0].contents;
const hash = createHash("sha256").update(code).digest("hex").slice(0, 20);
const zip = zipSync(
  {
    "index.js": [
      code,
      { os: 3, attrs: 0o644 << 16, mtime: new Date("1980-01-02T00:00:00Z") },
    ],
  },
  { level: 9 },
);
const artifacts = new URL("../.artifacts/", import.meta.url);
await mkdir(artifacts, { recursive: true });
const file = new URL(`controller-${hash}.zip`, artifacts);
await writeFile(file, zip);
console.log(
  JSON.stringify({
    file: fileURLToPath(file),
    key: `controller/${hash}.zip`,
    bytes: zip.byteLength,
    entryPoint: ["index.js"],
  }),
);
