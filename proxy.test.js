#!/usr/bin/env node
// The proxy's gates, against a local upstream: no internet needed. Node's fetch can't set Host, so http.request.

import { createServer, request } from "node:http";
import { hostname } from "node:os";
import { WebSocket } from "ws";
import { startProxy } from "./proxy.js";

const ORIGIN = "http://localhost:8000";
const results = [];
const test = async (name, fn) => {
  try { await fn(); results.push("PASS: proxy " + name); }
  catch (e) { results.push("FAIL: proxy " + name + "\n   " + e.message.split("\n")[0]); }
};
const assert = (ok, message) => { if (!ok) throw new Error(message); };

let seen, left;
const upstream = createServer((req, res) => {
  seen = req.headers;
  if (req.url === "/moved") return res.writeHead(302, { location: "/final" }).end();
  if (req.url === "/hang") return req.on("close", () => left?.());
  res.writeHead(200, { "content-type": "text/plain", "set-cookie": "a=b" }).end("upstream " + req.url);
});
await new Promise((ready) => upstream.listen(0, "127.0.0.1", ready));
const target = `http://127.0.0.1:${upstream.address().port}`;
const proxy = await startProxy(0);
const { port } = proxy.address();

const call = (path, headers = {}, options = {}) =>
  new Promise((resolve, reject) => {
    const req = request({ host: "localhost", port, path, headers: { host: `localhost:${port}`, ...headers }, ...options }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (chunk) => (body += chunk)).on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on("error", reject);
    req.on("upgrade", (res, socket) => { socket.destroy(); resolve({ status: res.statusCode, headers: res.headers, body: "" }); });
    options.onRequest?.(req);
    req.end();
  });
const upgrade = (path, headers = {}) =>
  call(path, { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers });

await test("health answers its own body to an allowed origin", async () => {
  const { status, headers, body } = await call("/health", { origin: ORIGIN });
  assert(status === 200 && body === '{"proxy":"chat"}', `${status} ${body}`);
  assert(headers["access-control-allow-origin"] === ORIGIN, "CORS for the origin");
});
await test("refuses a request without an Origin", async () => {
  const { status } = await call(`/${target}/x`);
  assert(status === 403, `got ${status}`);
});
await test("refuses a foreign origin", async () => {
  const { status } = await call(`/${target}/x`, { origin: "https://evil.example" });
  assert(status === 403, `got ${status}`);
});
await test("refuses a navigation", async () => {
  const { status } = await call(`/${target}/x`, { origin: ORIGIN, "sec-fetch-mode": "navigate" });
  assert(status === 403, `got ${status}`);
});
await test("refuses a foreign Host", async () => {
  for (const host of ["evil.example", `evil.example:${port}`, `localhost:${port + 1}`]) {
    const { status } = await call("/health", { origin: ORIGIN, host });
    assert(status === 403, `${host}: got ${status}`);
  }
});
await test("forwards for an allowed origin, without cookies, inert", async () => {
  const { status, headers, body } = await call(`/${target}/x`, { origin: ORIGIN, cookie: "session=secret" });
  assert(status === 200 && body === "upstream /x", `${status} ${body}`);
  assert(!("cookie" in seen) && !("origin" in seen), `upstream saw ${JSON.stringify(seen)}`);
  assert(headers["content-security-policy"] === "sandbox" && headers["x-content-type-options"] === "nosniff", "sandbox and nosniff");
  assert(!headers["set-cookie"] && headers["access-control-allow-origin"] === ORIGIN, "no set-cookie, CORS for the origin");
});
await test("follows redirects and names the final URL", async () => {
  const { status, headers, body } = await call(`/${target}/moved`, { origin: ORIGIN });
  assert(status === 200 && body === "upstream /final" && headers["x-final-url"] === `${target}/final`, `${status} ${headers["x-final-url"]}`);
});
await test("aborts the upstream request when the client leaves", async () => {
  const gone = new Promise((resolve, reject) => { left = resolve; setTimeout(() => reject(new Error("upstream request still open")), 3000); });
  await call(`/${target}/hang`, { origin: ORIGIN }, { onRequest: (req) => setTimeout(() => req.destroy(), 200) }).catch(() => {});
  await gone;
});
await test("refuses a websocket without an Origin", async () => {
  const { status } = await upgrade(`/127.0.0.1:${upstream.address().port}`);
  assert(status === 403, `got ${status}`);
});
await test("refuses relay port 99999 and keeps answering", async () => {
  const { status } = await upgrade("/127.0.0.1:99999", { origin: ORIGIN });
  assert(status === 400, `got ${status}`);
  const { status: after } = await upgrade("/127.0.0.1:0", { origin: ORIGIN });
  assert(after === 400, `port 0: got ${after}`);
  const health = await call("/health", { origin: ORIGIN });
  assert(health.body === '{"proxy":"chat"}', "still answers");
});
await test("relays TCP for an allowed origin", async () => {
  const ws = new WebSocket(`ws://localhost:${port}/127.0.0.1:${upstream.address().port}`, { origin: ORIGIN });
  const reply = await new Promise((resolve, reject) => {
    let text = "";
    ws.on("message", (data, binary) => {
      if (!binary && JSON.parse(data).type === "connected") return ws.send(Buffer.from("GET /tcp HTTP/1.0\r\n\r\n"));
      text += data;
    });
    ws.on("close", () => resolve(text));
    ws.on("error", reject);
  });
  assert(reply.startsWith("HTTP/1.1 200") && reply.endsWith("upstream /tcp"), reply.slice(0, 80));
});
await test("refuses to mirror a numeric host", async () => {
  for (const site of ["2130706433", "0x7f000001", "127.1", "localhost."]) {
    const { status } = await call("/", { host: `${site}.localhost:${port}` });
    assert(status === 403, `${site}: got ${status}`);
  }
});
await test("refuses to mirror a name that resolves to this machine's network", async () => {
  const { status, body } = await call("/", { host: `${hostname()}.localhost:${port}` });
  assert(status === 403, `${hostname()}: got ${status} ${body}`);
});

proxy.closeAllConnections();
await new Promise((resolve) => proxy.close(resolve));
upstream.closeAllConnections();
await new Promise((resolve) => upstream.close(resolve));
console.log(results.join("\n"));
process.exit(results.some((line) => line.startsWith("FAIL")) ? 1 : 0);
