// E23: full-page capture methods against Playwright's full-page screenshot. node spike/capture.mjs [--runs 3]
// [--pages article,sticky] [--browser path-to-chrome.exe] [--headed]
// Writes spike/out/<page>/{truth,<method>,<method>-diff}.png, spike/out/results.json and prints the table.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.dirname(here), outDir = path.join(here, "out");
const args = process.argv.slice(2), opt = (name, fallback) => { const i = args.indexOf("--" + name); return i < 0 ? fallback : args[i + 1]; };
const RUNS = +opt("runs", 3);
const PAGES = opt("pages", "article,sticky,lazy,game,webgl,anim,form").split(",");
const VIEW = { width: 1024, height: 768 };
// Chrome 156 (Playwright's chromium-1248) has HTML-in-Canvas's renamed API; Playwright's own 153 the older one.
const chrome156 = path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright/chromium-1248/chrome-win64/chrome.exe");
const executablePath = opt("browser", existsSync(chrome156) ? chrome156 : undefined);

// Images, made up: figures and a texture, and slow photos the lazy page waits on.
function svg(label, hue, w = 672, h = 300) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="hsl(${hue} 70% 45%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360} 70% 70%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${w * 0.7}" cy="${h * 0.4}" r="${h * 0.25}" fill="#fff8"/><text x="24" y="${h - 28}" font-family="sans-serif" font-size="32" fill="#fff">${label}</text></svg>`;
}
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
function serve() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    let m;
    if ((m = url.pathname.match(/^\/spike\/img\/(slow\/)?([\w-]+)\.svg$/))) {
      if (m[1]) await new Promise(r => setTimeout(r, 250));
      const n = +(m[2].match(/\d+/)?.[0] ?? 0);
      const body = m[2] === "texture" ? `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#f6efe6"/><path d="M0 40L40 0" stroke="#e2d2bf" stroke-width="6"/></svg>`
        : m[1] ? svg(`photo ${n}`, (n * 37) % 360, 320, 240) : svg(`Figure ${n}`, (n * 50) % 360);
      res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" });
      return res.end(body);
    }
    const file = path.join(repo, path.normalize(url.pathname));
    if (!file.startsWith(repo)) { res.writeHead(403); return res.end(); }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  return new Promise(resolve => server.listen(0, () => resolve(server)));
}

// The same state in the truth and in the frame before each method: forms filled, the button hovered, a box scrolled,
// animations at one time. The truth's animations stay paused there; the frame's run on, as a live page's do.
async function prepare(name, target, mouse, { truth }) {
  if (name === "form") {
    await target.locator("#email").fill("ada@example.com");
    await target.locator("#plan").selectOption("Team");
    await target.locator("#agree").check();
    await target.locator("#notes").fill("Two lines\nof notes");
    await target.locator("#scroller").evaluate(el => { el.scrollTop = 200; });
    await target.locator("#name").fill("Ada Lovelace");
    const box = await target.locator("#go").boundingBox();
    await mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  }
  if (name === "anim") await target.locator("body").evaluate((_, paused) => document.getAnimations().forEach(a => { a.currentTime = 1234; if (paused) a.pause(); }), truth);
  if (name === "lazy" && truth) {
    // Playwright's full-page capture doesn't scroll, so lazy images below the fold would be blank in the truth.
    await target.locator("body").evaluate(async () => {
      for (let y = 0; y < document.documentElement.scrollHeight; y += 500) { scrollTo(0, y); await new Promise(r => setTimeout(r, 60)); }
      await Promise.all([...document.images].map(i => i.decode().catch(() => {})));
      scrollTo(0, 0);
    });
  }
}

const dataToBuffer = url => Buffer.from(url.split(",")[1], "base64");
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

async function main() {
  await mkdir(outDir, { recursive: true });
  const server = await serve(), origin = `http://localhost:${server.address().port}`;
  const browser = await chromium.launch({
    executablePath, headless: false,
    args: ["--auto-accept-this-tab-capture", "--enable-blink-features=CanvasDrawElement", "--hide-scrollbars", "--disable-lcd-text", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", ...(args.includes("--headed") ? [] : ["--window-position=-32000,-32000"])],
  });
  const results = { browser: browser.version(), viewport: VIEW, runs: RUNS, pages: {} };
  try {
    const truthContext = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1 });
    const hostContext = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1 });
    const host = await hostContext.newPage();
    host.on("console", m => (m.type() === "error" || m.text().startsWith("hic:")) && console.log("  [host]", m.text()));
    host.on("pageerror", e => console.log("  [host error]", e.message));
    await host.goto(`${origin}/spike/capture.html`);
    await host.waitForFunction(() => window.ready);
    await host.evaluate(({ width, height }) => window.size(width, height), VIEW);
    const shared = args.includes("--no-share") ? { error: "not shared" } : await host.evaluate(() => window.share().catch(e => ({ error: e.message })));
    console.log("tab capture:", JSON.stringify(shared));
    results.capture = shared;
    const hic = await host.evaluate(() => typeof CanvasRenderingContext2D.prototype.drawElementImage === "function");
    results.htmlInCanvas = hic;

    for (const name of PAGES) {
      const url = `${origin}/spike/pages/${name}.html`, dir = path.join(outDir, name);
      await mkdir(dir, { recursive: true });
      const truthPage = await truthContext.newPage();
      await truthPage.goto(url);
      await truthPage.waitForLoadState("networkidle");
      await prepare(name, truthPage, truthPage.mouse, { truth: true });
      const truthStart = performance.now();
      const truth = await truthPage.screenshot({ fullPage: true, animations: "allow", caret: "initial" });
      const truthMs = Math.round(performance.now() - truthStart);
      await truthPage.close();
      await writeFile(path.join(dir, "truth.png"), truth);
      const truthUrl = "data:image/png;base64," + truth.toString("base64");
      const row = results.pages[name] = { truthMs, methods: {} };
      await host.bringToFront();
      const methods = ["stitch", ...(name === "sticky" ? ["stitch-anchored"] : []), "snapshot", "snapdom", "hic"].filter(m => !opt("methods") || opt("methods").split(",").includes(m));
      for (const method of methods) {
        const runs = [];
        for (let r = 0; r < RUNS; r++) {
          await host.evaluate(u => window.load(u), url);
          await host.waitForTimeout(400);
          const frame = host.frames().find(f => f.url() === url);
          await prepare(name, frame, host.mouse, { truth: false });
          runs.push(await host.evaluate(m => window.run(m), method));
          if (!runs.at(-1).ok) break;
        }
        const first = runs[0];
        if (first.waits?.length) console.log(`  ${method} frame waits: ${first.waits.join(" ")}`);
        if (!first.ok) { row.methods[method] = { error: first.error }; console.log(`${name} ${method}: FAILED ${first.error.split("\n")[0]}`); continue; }
        const regions = await host.evaluate(() => window.regions());
        const d = await host.evaluate(([t, o, b, rg]) => window.diff(t, o, b, rg), [truthUrl, first.png, VIEW.height, regions]);
        await writeFile(path.join(dir, `${method}.png`), dataToBuffer(first.png));
        await writeFile(path.join(dir, `${method}-diff.png`), dataToBuffer(d.png));
        const tiles = runs.flatMap(r => r.tiles ?? []);
        row.methods[method] = {
          ms: median(runs.map(r => r.ms)), msRuns: runs.map(r => r.ms), ...(first.importMs != null && { importMs: first.importMs }),
          tiles: first.tiles?.length, perTileMs: tiles.length ? median(tiles) : undefined,
          score: d.score, size: d.size, bands: d.bands, regions: d.regions,
        };
        console.log(`${name} ${method}: ${row.methods[method].ms} ms${tiles.length ? ` (${first.tiles.length} tiles, ${median(tiles)} ms/tile)` : ""}, diff ${d.score}, bands ${d.bands.join(" ")}, size ${d.size.out.join("x")} vs ${d.size.truth.join("x")}`);
        for (const g of d.regions) console.log(`    ${g.name}@${g.y}: diff ${g.diff}, ink truth ${g.inkTruth} out ${g.inkOut}`);
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  await writeFile(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  // The table: a cell is time (per tile), the share of pixels differing, and what the numbers flag.
  const names = [...new Set(Object.values(results.pages).flatMap(p => Object.keys(p.methods)))];
  const cell = m => {
    if (!m) return "";
    if (m.error) return `failed: ${m.error.split("\n")[0].slice(0, 60)}`;
    const flags = [];
    if (m.size.out.join() !== m.size.truth.join()) flags.push(`${m.size.out[1]} px tall, truth ${m.size.truth[1]}`);
    for (const g of m.regions) if (g.inkTruth > 0.02 && g.inkOut < 0.005) flags.push(`${g.name} blank`); else if (g.diff > 0.5) flags.push(`${g.name} wrong`);
    const worst = m.bands.indexOf(Math.max(...m.bands));
    if (m.bands[worst] > 0.02) flags.push(`worst screen ${worst + 1} (${m.bands[worst]})`);
    return `${m.ms} ms${m.perTileMs ? ` (${m.tiles}×${m.perTileMs})` : ""}, ${m.score}${flags.length ? "; " + flags.join("; ") : ""}`;
  };
  const md = [`| page | ${names.join(" | ")} |`, `| --- | ${names.map(() => "---").join(" | ")} |`,
    ...Object.entries(results.pages).map(([p, r]) => `| ${p} (truth ${r.truthMs} ms) | ${names.map(n => cell(r.methods[n])).join(" | ")} |`)].join("\n");
  await writeFile(path.join(outDir, "results.md"), `${results.browser}, ${VIEW.width}x${VIEW.height}, median of ${RUNS} runs\n\n${md}\n`);
  console.log("\n" + md);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
