import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const port = 20000 + Math.floor(Math.random() * 20000);
const endpoint = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [fileURLToPath(new URL("../controller.js", import.meta.url))], {
  env: { ...process.env, PORT: String(port) },
  stdio: "ignore",
});

try {
  let health;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error("Controller exited before it was ready");
    try {
      health = await fetch(endpoint + "/ping");
      break;
    } catch {
      await delay(50);
    }
  }
  if (health?.status !== 200 || (await health.json()).status !== "Healthy")
    throw new Error("Controller health check failed");
  for (const authorization of [undefined, "Bearer malformed"]) {
    const response = await fetch(endpoint + "/invocations", {
      method: "POST",
      headers: authorization ? { authorization } : {},
      body: JSON.stringify({ v: 1, command: "session.get", input: {} }),
    });
    if (response.status !== 403) throw new Error("Unauthenticated invocation was not denied");
  }
  console.log("PASS: controller health and unauthenticated denial");
} finally {
  child.kill();
}
