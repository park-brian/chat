import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { createCoverageReport } from "./coverage.js";
import { testTabs } from "./tabs.test.js";
import { startProxy } from "./proxy.js";
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
      "Usage: node test.js <target.html> [--story name] [--screenshot] [--viewports desktop,mobile] [--headed] [--net] [--live-stack name --profile name --region name [--published]]",
    );
  const result = {
    target,
    story: null,
    screenshot: false,
    headed: false,
    net: false,
    viewports: ["desktop"],
    liveStack: null,
    published: false,
    profile: null,
    region: null,
  };
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === "--screenshot") result.screenshot = true;
    else if (flags[i] === "--headed") result.headed = true;
    // The page's tests that reach third-party sites run only with --net; npm test stays offline.
    else if (flags[i] === "--net") result.net = true;
    else if (flags[i] === "--story") result.story = flags[++i];
    else if (flags[i] === "--viewports")
      result.viewports = flags[++i]?.split(",") ?? [];
    else if (flags[i] === "--live-stack") {
      result.liveStack = flags[++i];
      if (!result.liveStack || result.liveStack.startsWith("--"))
        throw new Error("--live-stack needs a stack name");
    }
    else if (flags[i] === "--published") result.published = true;
    else if (flags[i] === "--profile" || flags[i] === "--region") {
      const value = flags[++i];
      if (!value || value.startsWith("--"))
        throw new Error(flags[i - 1] + " needs a " + flags[i - 1].slice(2) + " name");
      result[flags[i - 1].slice(2)] = value;
    }
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
  let proxy;
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
      ? new URL(config.published ? fixture.publicEntryUrl : fixture.entryUrl)
      : null;
    const port = liveUrl ? Number(liveUrl.port) : 0;
    if (!config.published) {
      try {
        server = await startServer(port, repository);
      } catch (error) {
        if (!liveUrl || error.code !== "EADDRINUSE") throw error;
        const probe = await fetch(liveUrl.origin + liveUrl.pathname);
        if (!probe.ok || !(await probe.text()).includes("AgentCore Chat"))
          throw new Error(
            "Existing local server does not serve the target app",
          );
        console.log("Using existing local server at " + liveUrl.origin);
      }
    }
    const activePort = server?.address().port || port;
    // A local run gets its own CORS proxy and TCP relay, so in-file tests can reach real sites and services.
    if (!liveUrl) proxy = await startProxy(0);
    const route = relativeTarget
      .split(path.sep)
      .map(encodeURIComponent)
      .join("/");
    const pageUrl =
      liveUrl || new URL(route, "http://localhost:" + activePort + "/");
    if (!liveUrl) {
      pageUrl.searchParams.set("test", "1");
      if (config.story) pageUrl.searchParams.set("story", config.story);
      if (config.net) pageUrl.searchParams.set("net", "1");
    }

    browser = await chromium.launch({ headless: !config.headed });
    for (const viewport of config.viewports) {
      // Each viewport is an independent live story. Reusing one identity leaks
      // prior mutations into the next layout's assertions and cleanup.
      if (hooks && !fixture)
        fixture = await hooks.createLiveFixture({
          stackName: config.liveStack,
          profile: config.profile,
          region: config.region,
        });
      const context = await browser.newContext({
        viewport: config.sizes[viewport],
        deviceScaleFactor: 1,
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      if (proxy)
        // The page only: its frames share its storage, and a sandboxed one has none to write.
        await page.addInitScript(
          (config) =>
            window !== top ||
            localStorage.getItem("proxy-config") ||
            localStorage.setItem("proxy-config", config),
          JSON.stringify({
            endpoint: "http://localhost:" + proxy.address().port,
          }),
        );
      const errors = [];
      page.on("console", (message) => {
        console.log(message.text());
        // A test's deliberately unreachable host logs its 502 like any failed load; it isn't a page error.
        const where = message.location().url;
        if (message.type() === "error" && !where?.includes(".invalid/")) errors.push(message.text() + (where ? ` (${where})` : ""));
      });
      // A page a test runs in the workspace throws on purpose; its report is what the test checks.
      page.on("pageerror", (error) => { if (!error.stack?.includes("/__ws/")) errors.push(error.message); });
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
            let image;
            if (request.targetId) {
              const element = page.locator(
                '[data-screenshot-target="' + request.targetId + '"]',
              );
              if ((await element.count()) !== 1)
                throw new Error("Screenshot target is missing or ambiguous");
              image = await element.screenshot(capture);
            } else {
              image = await page.screenshot({
                ...capture,
                fullPage: request.fullPage === true,
              });
            }
            console.log("Screenshot: " + file);
            // The in-page harness asks for the pixels so it can hand them to the model.
            return request.base64 === true ? image.toString("base64") : file;
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
        await page.waitForFunction(() => window.TESTS_DONE, null, { timeout: 120000 });
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
        const externalModule = await page.evaluate(() =>
          [...document.scripts].find((script) => script.type === "module" && script.hasAttribute("src"))?.getAttribute("src"),
        );
        const coverageTarget = externalModule ? new URL(externalModule, pageUrl) : pageUrl;
        const coverageFile = externalModule ? path.resolve(path.dirname(absoluteTarget), externalModule) : absoluteTarget;
        if (path.relative(repository, coverageFile).startsWith(".."))
          throw new Error("Coverage module must stay inside the repository");
        const entry = coverage.find((item) =>
          isCoverageEntryForTarget(item, coverageTarget),
        );
        const { report } = createCoverageReport(
          path.relative(repository, coverageFile).split(path.sep).join("/"),
          externalModule ? await readFile(coverageFile, "utf8") : fileSource,
          entry,
          {
            width: process.stdout.columns || 120,
          },
        );
        console.log(report);
        // The engine a page imports, and the prompts it imports, are covered by the same tests.
        for (const module of ["engine.js", "prompts.js"]) {
          const moduleEntry = coverage.find((item) =>
            isCoverageEntryForTarget(item, new URL(module, pageUrl)),
          );
          if (moduleEntry)
            console.log(
              createCoverageReport(
                path.posix.join(path.dirname(relativeTarget).split(path.sep).join("/"), module),
                await readFile(path.join(path.dirname(absoluteTarget), module), "utf8"),
                moduleEntry,
                { width: process.stdout.columns || 120 },
              ).report,
            );
        }
      } finally {
        await context.close();
        if (hooks) {
          await fixture?.cleanup();
          fixture = null;
        }
      }
    }
    // An app with an engine serves every tab from it; these check what that promises across tabs.
    const engine = path.join(path.dirname(absoluteTarget), "engine.js");
    if (!liveUrl && !config.story && (await access(engine).then(() => true, () => false))) {
      const url = new URL(pageUrl);
      url.search = "";
      const results = await testTabs(browser, url.href);
      console.log(results.join("\n"));
      const failed = results.filter((line) => line.startsWith("FAIL"));
      if (failed.length) throw new Error("Tab stories failed: " + failed.map((line) => line.split("\n")[0]).join("; "));
    }
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (proxy) await new Promise((resolve) => proxy.close(resolve));
    await browser?.close();
    await fixture?.cleanup();
  }
}

run().catch((error) => {
  console.error("Browser test error: " + error.message);
  process.exitCode = 1;
});
