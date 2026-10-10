// Imported by index.html only for ?test=1, or explicitly by the browser-story runner.
export async function _screenshot(name, element = undefined, options = {}) {
  if (typeof window.__captureScreenshot !== "function") {
    throw new Error("_screenshot requires the Playwright browser-story runner");
  }
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    throw new Error("Screenshot names must be short kebab-case labels");
  }
  await document.fonts.ready;
  let targetId = null;
  if (element !== undefined) {
    if (
      !(element instanceof Element) ||
      !element.isConnected ||
      !element.getClientRects().length
    ) {
      throw new Error(
        "Screenshot target must be a visible, connected DOM element",
      );
    }
    targetId = crypto.randomUUID();
    element.setAttribute("data-screenshot-target", targetId);
  }
  try {
    return await window.__captureScreenshot({
      name,
      targetId,
      fullPage: options.fullPage === true,
    });
  } finally {
    if (
      targetId &&
      element?.getAttribute("data-screenshot-target") === targetId
    ) {
      element.removeAttribute("data-screenshot-target");
    }
  }
}

export { runTests } from "./tests/browser.js";
export async function createLiveFixture(options) {
  return (await import("./tests/fixtures.js")).createLiveFixture(options);
}
export async function runLiveStory(...args) {
  return (await import("./tests/live.js")).runLiveStory(...args);
}
