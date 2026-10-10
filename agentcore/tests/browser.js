import { _screenshot } from "../tests.js";
export async function runTests({ parseDeployment }) {
  let passed = 0,
    failed = 0;
  const tests = [
    [
      "deployment validation",
      () => {
        if (
          parseDeployment("not-json") !== null ||
          parseDeployment({
            region: "us-east-1",
            stack: "test",
            pool: "us-east-1_pool",
            client: "client",
            scope: "chat-api/access",
            domain: "https://evil.example",
            runtime:
              "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test",
          })
        )
          throw Error("Invalid deployment accepted");
      },
    ],
    [
      "pinned import integrity and CSP",
      () => {
        const map = JSON.parse(
          document.querySelector('script[type="importmap"]').textContent,
        );
        for (const url of Object.values(map.imports))
          if (
            !url.includes("solid-js@1.9.15/") ||
            !/^sha384-/.test(map.integrity[url])
          )
            throw Error("Unpinned import");
        if (
          document.getElementById("app-csp").content.includes("unsafe-inline")
        )
          throw Error("Inline script allowed");
      },
    ],
    [
      "document navigation and sign-in shell",
      async () => {
        if (!document.querySelector("[data-app-state=disconnected]"))
          throw Error("Shell missing");
        if (
          !document.querySelector('nav a[href$="profile/"]') ||
          document.querySelector("dialog")
        )
          throw Error("Page navigation missing");
        if (!document.querySelector("input[name=deployment]"))
          throw Error("Sign-in form missing");
        if (window.__captureScreenshot)
          await _screenshot("workspace", undefined, { fullPage: true });
        if (innerWidth <= 620) {
          document.querySelector('[aria-label="Toggle navigation"]').click();
          await new Promise((resolve) => requestAnimationFrame(resolve));
          if (!document.querySelector(".site-menu.open"))
            throw Error("Mobile navigation missing");
          if (window.__captureScreenshot)
            await _screenshot("mobile-menu", undefined, { fullPage: true });
        }
      },
    ],
  ];
  for (const [name, test] of tests) {
    try {
      await test();
      console.log("PASS: " + name);
      passed++;
    } catch (error) {
      console.error("FAIL: " + name + ": " + error.message);
      failed++;
    }
  }
  return { passed, failed };
}
