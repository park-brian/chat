import { chromium } from "../../node_modules/playwright/index.mjs";
import { startServer } from "../../server.js";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createLiveFixture } from "../tests/fixtures.js";
import { runLiveStory } from "../tests/live.js";

process.loadEnvFile(new URL("../../.env", import.meta.url));
const record = JSON.parse(
  await readFile(
    new URL("../.artifacts/pages-validation-stack.json", import.meta.url),
  ),
);
if (record.createdBy !== "pages-validation")
  throw Error("Expected disposable validation stack");
const server = await startServer(
  8000,
  fileURLToPath(new URL("../../", import.meta.url)),
);
const fixture = await createLiveFixture({
  stackName: record.stackName,
  region: record.region,
});
const browser = await chromium.launch();
const errors = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await runLiveStory(page, fixture, {
    story: process.argv[2] || "pages",
    screenshot: true,
  });
  if (errors.length) throw Error(errors.join("; "));
  console.log("PASS: disposable multi-page end-to-end validation");
} finally {
  await browser.close();
  await fixture.cleanup();
  await new Promise((resolve) => server.close(resolve));
}
