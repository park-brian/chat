// Tabs sharing one engine: a run two tabs watch, a host call that moves when its tab closes, a chat left mid-run,
// a run every tab left, continued, and an old database reset. test.js runs these against an app that has an engine.js.

export async function testTabs(browser, url) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  const errors = [];
  const open = async (at = url) => {
    const page = await context.newPage();
    page.on("pageerror", e => errors.push(e.message));
    page.on("console", m => m.type() === "error" && !/ERR_CONNECTION_REFUSED/.test(m.text()) && errors.push(m.text()));
    await page.goto(at);
    await page.waitForSelector("form#inputForm");
    return page;
  };
  const send = async (page, instruction) => {
    await page.selectOption("#modelId", "echo");
    await page.fill("#userMessage", JSON.stringify(instruction));
    await page.locator("form#inputForm").evaluate(form => form.requestSubmit());
    await page.waitForFunction(() => new URLSearchParams(location.search).get("threadId"));
  };
  const shows = (page, text, timeout = 15000) => page.waitForFunction(t => document.querySelector("#messages, main")?.innerText.includes(t) ?? document.body.innerText.includes(t), text, { timeout });
  const idle = (page, timeout = 15000) => page.waitForFunction(() => document.querySelector("form#inputForm")?.dataset.loading === "false", null, { timeout });
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  // This context's shared workers, as the browser lists them (Playwright doesn't expose shared workers).
  const cdp = await browser.newBrowserCDPSession();
  const probe = await context.newPage();
  const { targetInfo: { browserContextId } } = await (await context.newCDPSession(probe)).send("Target.getTargetInfo");
  await probe.close();
  const workers = async () => (await cdp.send("Target.getTargets")).targetInfos.filter(t => t.type === "shared_worker" && t.browserContextId === browserContextId);
  const results = [];
  const story = async (name, fn) => {
    try { await fn(); results.push("PASS: tabs " + name); }
    catch (e) { results.push("FAIL: tabs " + name + "\n   " + e.message.split("\n")[0]); }
  };

  try {
    await story("share a run", async () => {
      const a = await open();
      await send(a, { text: "Shared reply, streamed slowly to both tabs until it ends here.", chunk: 150 });
      const b = await open(a.url());
      await b.waitForFunction(() => document.querySelector("form#inputForm")?.dataset.loading === "true", null, { timeout: 3000 });
      await shows(b, "until it ends here.");
      await idle(b);
      await Promise.all([a.close(), b.close()]);
    });

    await story("a host call moves when its tab closes", async () => {
      // Each tab is named, and the code frame logs its tab's name, so the result says which tab ran it.
      const a = await open();
      await a.evaluate(() => { window.name = "tab-a"; });
      const b = await open();
      await send(a, { toolUse: [{ name: "code", input: { source: "await new Promise(r => setTimeout(r, 2500)); console.log('ran in ' + parent.name + ' ' + (window.parent !== window))", timeout: 10000 } }] });
      await b.goto(a.url());
      await b.waitForSelector("form#inputForm");
      await b.evaluate(() => { window.name = "tab-b"; });
      await a.waitForTimeout(800);
      await a.close();
      await shows(b, "Echo: received", 20000);
      await idle(b);
      const result = await b.evaluate(async id => {
        const db = await new Promise((resolve, reject) => { const r = indexedDB.open("chat"); r.onsuccess = () => resolve(r.result); r.onerror = reject; });
        const all = await new Promise(resolve => { const r = db.transaction("messages").objectStore("messages").getAll(); r.onsuccess = () => resolve(r.result); });
        db.close();
        return JSON.stringify(all.filter(m => m.threadId === id).flatMap(m => m.content ?? []).filter(c => c.toolResult));
      }, Number(new URL(b.url()).searchParams.get("threadId")));
      assert(/ran in tab-b true/.test(result) && !/tab-a|No tab is open/.test(result), "the call ran again in the tab left: " + result.slice(0, 300));
      await b.close();
    });

    await story("a chat left mid-run goes on", async () => {
      const a = await open();
      await send(a, { text: "Left and found again, finished while another chat was open.", chunk: 150 });
      const first = new URL(a.url()).searchParams.get("threadId");
      await a.getByRole("button", { name: "New chat" }).click();
      await a.waitForFunction(id => new URLSearchParams(location.search).get("threadId") !== id, first);
      await a.waitForSelector(".sidebar-item [data-running]", { timeout: 3000 });
      await a.waitForSelector(".sidebar-item [data-running]", { state: "detached", timeout: 15000 });
      await a.locator(".sidebar-item").filter({ hasText: "Left and found" }).first().click();
      await shows(a, "while another chat was open.");
      await a.close();
    });

    await story("a run every tab left continues", async () => {
      const a = await open();
      await send(a, { text: "Interrupted by its last tab closing, then continued from the chat when a tab came back, to the very last word.", chunk: 400 });
      const at = a.url();
      await a.waitForTimeout(600);
      assert((await workers()).length, "no shared worker to wait for");
      await a.close();
      // The engine's worker goes with its last tab: wait until this context has no shared worker left.
      const deadline = Date.now() + 10000;
      while ((await workers()).length) {
        assert(Date.now() < deadline, "the engine's worker outlived its last tab");
        await new Promise(r => setTimeout(r, 100));
      }
      const b = await open(at);
      await b.waitForSelector("[data-continue]", { timeout: 10000 });
      await b.click("[data-continue]");
      await shows(b, "to the very last word.");
      await idle(b);
      await b.close();
    });

    // There are no migrations: a database from before version 7 is dropped, and the default agent seeded again.
    await story("an old database is reset", async () => {
      const fresh = await browser.newContext();
      try {
        const blank = new URL("/__blank-for-db-reset", url).href;
        await fresh.route(blank, route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>blank</title>" }));
        const page = await fresh.newPage();
        page.on("pageerror", e => errors.push(e.message));
        await page.goto(blank);
        await page.evaluate(() => new Promise((resolve, reject) => {
          const r = indexedDB.open("chat", 6);
          r.onupgradeneeded = () => {
            r.result.createObjectStore("threads", { keyPath: "id", autoIncrement: true }).put({ id: 999, title: "junk from version 6" });
            r.result.createObjectStore("legacy", { keyPath: "id" }).put({ id: 1, junk: true });
          };
          r.onsuccess = () => { r.result.close(); resolve(); };
          r.onerror = () => reject(r.error);
        }));
        await page.goto(url);
        await page.waitForSelector("form#inputForm");
        const read = () => page.evaluate(() => new Promise((resolve, reject) => {
          const r = indexedDB.open("chat");
          r.onsuccess = () => {
            const db = r.result, stores = [...db.objectStoreNames];
            const get = (store, key) => new Promise(done => { const q = db.transaction(store).objectStore(store).get(key); q.onsuccess = () => done(q.result ?? null); q.onerror = () => done(null); });
            Promise.all([stores.includes("threads") ? get("threads", 999) : null, stores.includes("agents") ? get("agents", 1) : null])
              .then(([junk, agent]) => { db.close(); resolve({ version: db.version, stores, junk, agent: !!agent }); });
          };
          r.onerror = () => reject(r.error);
        }));
        // The engine seeds the agent as it starts, which may land just after the form shows.
        let db = await read();
        for (const deadline = Date.now() + 5000; !db.agent && Date.now() < deadline; db = await read()) await page.waitForTimeout(100);
        assert(db.version >= 7, "the database is still version " + db.version);
        assert(!db.junk && !db.stores.includes("legacy"), "old data survived: " + JSON.stringify(db));
        assert(db.agent, "the default agent is missing: " + JSON.stringify(db));
      } finally {
        await fresh.close();
      }
    });
  } finally {
    await context.close();
  }
  if (errors.length) results.push("FAIL: tabs errors\n   " + errors.join("; "));
  return results;
}

