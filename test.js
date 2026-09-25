import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { createCoverageReport } from "./coverage.js";
import { startServer } from "./server.js";

function isCoverageEntryForTarget(entry, pageUrl) {
  try {
    const entryUrl = new URL(entry.url);
    entryUrl.search = "";
    entryUrl.hash = "";
    pageUrl = new URL(pageUrl);
    pageUrl.search = "";
    pageUrl.hash = "";
    return entryUrl.href === pageUrl.href;
  } catch {
    return false;
  }
}

function options(argv) {
  const [target, ...flags] = argv;
  if (!target)
    throw new Error(
      "Usage: node test.js <target.html> [--story name] [--screenshot] [--viewports desktop,mobile] [--headed] [--live-stack name --profile name --region name [--published]]",
    );
  const result = {
    target,
    story: null,
    screenshot: false,
    headed: false,
    viewports: ["desktop"],
    liveStack: null,
    published: false,
    profile: null,
    region: null,
  };
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === "--screenshot") result.screenshot = true;
    else if (flags[i] === "--headed") result.headed = true;
    else if (flags[i] === "--story") result.story = flags[++i];
    else if (flags[i] === "--viewports")
      result.viewports = flags[++i]?.split(",") ?? [];
    else if (flags[i] === "--live-stack") result.liveStack = flags[++i];
    else if (flags[i] === "--published") result.published = true;
    else if (flags[i] === "--profile") result.profile = flags[++i];
    else if (flags[i] === "--region") result.region = flags[++i];
    else throw new Error("Unknown test option: " + flags[i]);
  }
  const sizes = {
    desktop: { width: 1440, height: 900 },
    mobile: { width: 390, height: 844 },
    tablet: { width: 768, height: 1024 },
  };
  if (!result.viewports.length || result.viewports.some((name) => !sizes[name]))
    throw new Error("Unknown viewport");
  if (result.story && !/^[a-z0-9-]+$/.test(result.story))
    throw new Error("Invalid story name");
  if (result.liveStack && (!result.profile || !result.region))
    throw new Error("Live stories require --profile and --region");
  if (result.published && !result.liveStack)
    throw new Error("--published requires a live stack");
  return { ...result, sizes };
}

async function run(config = options(process.argv.slice(2))) {
  const repository = path.dirname(fileURLToPath(import.meta.url));
  const absoluteTarget = path.resolve(config.target);
  const relativeTarget = path.relative(repository, absoluteTarget);
  if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget))
    throw new Error("The test target must be inside this repository");
  const fileSource = await readFile(absoluteTarget, "utf8");
  const runId = new Date().toISOString().replaceAll(/[:.]/g, "-");
  let browser;
  let server;
  let fixture;

  try {
    const hooks = config.liveStack
      ? await import(
          pathToFileURL(path.join(path.dirname(absoluteTarget), "tests.js"))
            .href
        )
      : null;
    if (hooks)
      fixture = await hooks.createLiveFixture({
        stackName: config.liveStack,
        profile: config.profile,
        region: config.region,
      });
    const liveUrl = fixture?.entryUrl
      ? new URL(config.published ? fixture.publicEntryUrl : fixture.entryUrl) : null;
    const port = liveUrl ? Number(liveUrl.port) : 0;
    if (!config.published) {
      try {
        server = await startServer(port, repository);
      } catch (error) {
        if (!liveUrl || error.code !== "EADDRINUSE") throw error;
        const probe = await fetch(liveUrl.origin + liveUrl.pathname);
        if (!probe.ok || !(await probe.text()).includes("AgentCore Chat"))
          throw new Error("Existing local server does not serve the target app");
        console.log("Using existing local server at " + liveUrl.origin);
      }
    }
    const activePort = server?.address().port || port;
    const route = relativeTarget
      .split(path.sep)
      .map(encodeURIComponent)
      .join("/");
    const pageUrl =
      liveUrl || new URL(route, "http://localhost:" + activePort + "/");
    if (!liveUrl) {
      pageUrl.searchParams.set("test", "1");
      if (config.story) pageUrl.searchParams.set("story", config.story);
    }

    browser = await chromium.launch({ headless: !config.headed });
    for (const viewport of config.viewports) {
      // Each viewport is an independent live story. Reusing one identity leaks
      // prior mutations into the next layout's assertions and cleanup.
      if (hooks && !fixture)
        fixture = await hooks.createLiveFixture({ stackName: config.liveStack,
          profile: config.profile, region: config.region });
      const context = await browser.newContext({
        viewport: config.sizes[viewport],
        deviceScaleFactor: 1,
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      const errors = [];
      page.on("console", (message) => {
        console.log(message.text());
        if (message.type() === "error") errors.push(message.text());
      });
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("requestfailed", (request) => {
        if (["script", "stylesheet"].includes(request.resourceType()))
          errors.push("Failed asset: " + request.url());
      });
      if (config.screenshot) {
        await page.exposeBinding(
          "__captureScreenshot",
          async ({ frame }, request) => {
            const source = new URL(frame.url());
            if (
              source.origin !== pageUrl.origin ||
              source.pathname !== pageUrl.pathname ||
              source.searchParams.has("code")
            )
              throw new Error("Screenshot source is not the test page");
            if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(request.name))
              throw new Error("Invalid screenshot name");
            const file = path.join(
              path.dirname(absoluteTarget),
              ".artifacts",
              "screenshots",
              runId,
              viewport,
              request.name + ".png",
            );
            await mkdir(path.dirname(file), { recursive: true });
            const capture = {
              path: file,
              animations: "disabled",
              mask: [page.locator("[data-sensitive]")],
            };
            if (request.targetId) {
              const element = page.locator(
                '[data-screenshot-target="' + request.targetId + '"]',
              );
              if ((await element.count()) !== 1)
                throw new Error("Screenshot target is missing or ambiguous");
              await element.screenshot(capture);
            } else {
              await page.screenshot({
                ...capture,
                fullPage: request.fullPage === true,
              });
            }
            console.log("Screenshot: " + file);
            return file;
          },
        );
      }
      try {
        if (!liveUrl)
          await page.coverage.startJSCoverage({ reportAnonymousScripts: true });
        await page.goto(pageUrl.href);
        if (liveUrl) {
          await hooks.runLiveStory(page, fixture, {
            story: config.story,
            screenshot: config.screenshot,
          });
          if (errors.length)
            throw new Error("Browser errors: " + errors.join("; "));
          console.log(
            "PASS: live " + (config.story || "login") + " (" + viewport + ")",
          );
          continue;
        }
        await page.waitForFunction(() => window.TESTS_DONE, { timeout: 30000 });
        const result = await page.evaluate(() => window.TESTS_DONE);
        if (
          typeof result !== "object" ||
          !Number.isInteger(result.passed) ||
          !Number.isInteger(result.failed) ||
          result.failed ||
          errors.length
        )
          throw new Error(
            "Browser tests failed (" +
              viewport +
              "): " +
              JSON.stringify(result) +
              "; errors: " +
              errors.join("; "),
          );
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - innerWidth,
        );
        if (overflow > 1)
          throw new Error(
            "Horizontal overflow at " + viewport + ": " + overflow + "px",
          );
        const coverage = await page.coverage.stopJSCoverage();
        const entry = coverage.find((item) =>
          isCoverageEntryForTarget(item, pageUrl),
        );
        const { report } = createCoverageReport(
          relativeTarget.split(path.sep).join("/"),
          fileSource,
          entry,
          {
            width: process.stdout.columns || 120,
          },
        );
        console.log(report);
      } finally {
        await context.close();
        if (hooks) {
          await fixture?.cleanup();
          fixture = null;
        }
      }
    }
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await browser?.close();
    await fixture?.cleanup();
  }
}

run().catch((error) => {
  console.error("Browser test error: " + error.message);
  process.exitCode = 1;
});
