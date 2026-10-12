#!/usr/bin/env node
// The proxy's gates, against a local upstream: no internet needed. Node's fetch can't set Host, so http.request.

import { createServer, request } from "node:http";
import { connect } from "node:net";
import { hostname } from "node:os";
import { Readable } from "node:stream";
import { deflateRawSync, deflateSync, gzipSync } from "node:zlib";
import { WebSocket } from "ws";
import { MIRROR_CAP, capped, deadline, decoderFor, keptHeaders, mirrorAllowed, pinned, privateAddress, startProxy } from "./proxy.js";

const ORIGIN = "http://localhost:8000";
// What the browser sends for the frame the app opens on a mirror.
const FRAMED = { "sec-fetch-dest": "iframe", "sec-fetch-site": "cross-site", referer: ORIGIN + "/" };
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
await test("a client resetting during a refused upgrade leaves the proxy up", async () => {
  // The reset comes once the refusal is out, while the proxy still reads the socket.
  await Promise.all(Array.from({ length: 5 }, () => new Promise((resolve) => {
    const socket = connect(port, "localhost", () =>
      socket.write(`GET /127.0.0.1:1 HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`),
    ).once("data", () => socket.resetAndDestroy()).on("error", () => {}).on("close", resolve);
  })));
  await new Promise((resolve) => setTimeout(resolve, 200));
  const { body } = await call("/health", { origin: ORIGIN });
  assert(body === '{"proxy":"chat"}', "still answers");
});
await test("PROXY_ORIGINS entries are trimmed", async () => {
  process.env.PROXY_ORIGINS = " https://a.example , https://b.example ";
  try {
    for (const origin of ["https://a.example", "https://b.example"]) {
      const { status } = await call("/health", { origin });
      assert(status === 200, `${origin}: got ${status}`);
    }
  } finally { delete process.env.PROXY_ORIGINS; }
});
await test("refuses to mirror a numeric host", async () => {
  for (const site of ["2130706433", "0x7f000001", "127.1", "localhost."]) {
    const { status, body } = await call("/", { host: `${site}.localhost:${port}`, ...FRAMED });
    assert(status === 403 && body.includes("Not mirrored"), `${site}: got ${status} ${body}`);
  }
});
await test("refuses to mirror a name that resolves to this machine's network", async () => {
  const { status, body } = await call("/", { host: `${hostname()}.localhost:${port}`, ...FRAMED });
  assert(status === 403 && body.includes("Not mirrored"), `${hostname()}: got ${status} ${body}`);
});
// Past the rule, a numeric host is refused by the address check instead: "Not mirrored", not "Not allowed".
await test("a mirror lets the app's frame and its own requests past the access rule", async () => {
  for (const headers of [FRAMED, { "sec-fetch-dest": "image", "sec-fetch-site": "same-origin" }, { "sec-fetch-dest": "iframe", "sec-fetch-site": "same-origin" }]) {
    const { status, body } = await call("/", { host: `127.1.localhost:${port}`, ...headers });
    assert(status === 403 && body.includes("Not mirrored"), `${JSON.stringify(headers)}: got ${status} ${body}`);
  }
  assert(mirrorAllowed(FRAMED), "the app's frame");
  assert(mirrorAllowed({ ...FRAMED, referer: "http://127.0.0.1:5173/chat/" }), "a frame from another local page");
  assert(mirrorAllowed({ "sec-fetch-dest": "script", "sec-fetch-site": "same-origin" }), "a subresource");
  assert(mirrorAllowed({ "sec-fetch-dest": "empty", "sec-fetch-site": "same-origin" }), "a fetch");
  assert(mirrorAllowed({ "sec-fetch-dest": "iframe", "sec-fetch-site": "same-origin" }), "an in-frame navigation");
});
await test("a mirror refuses requests the access rule doesn't name", async () => {
  const { referer, ...unframed } = FRAMED;
  for (const headers of [
    {},
    { "sec-fetch-dest": "iframe", referer: ORIGIN + "/" },
    { "sec-fetch-dest": "document", "sec-fetch-site": "none" },
    { "sec-fetch-dest": "document", "sec-fetch-site": "cross-site", referer: ORIGIN + "/" },
    { "sec-fetch-dest": "document", "sec-fetch-site": "same-origin" },
    { ...FRAMED, "sec-fetch-site": "same-site" },
    { ...FRAMED, "sec-fetch-dest": "image" },
    unframed,
    { ...FRAMED, referer: "https://evil.example/" },
    { ...FRAMED, referer: `http://other.example.localhost:${port}/` },
    { "sec-fetch-dest": "image", "sec-fetch-site": "same-site", referer: `http://other.example.localhost:${port}/` },
  ]) {
    assert(!mirrorAllowed(headers), `allowed ${JSON.stringify(headers)}`);
    const { status, body } = await call("/", { host: `example.com.localhost:${port}`, ...headers });
    assert(status === 403 && body.includes("Not allowed"), `${JSON.stringify(headers)}: got ${status} ${body}`);
  }
});
await test("private IPv6 forms are private", async () => {
  for (const address of ["::1", "::", "::7f00:1", "::ffff:127.0.0.1", "64:ff9b::a00:1", "64:ff9b:1::1", "2001::1", "2001:db8::1",
    "2002:7f00:1::", "fc00::1", "fe80::1", "fec0::1", "ff02::1", "10.0.0.1", "100.64.0.1"])
    assert(privateAddress(address), `${address} is public`);
  for (const address of ["2606:4700:4700::1111", "2001:4860:4860::8888", "1.1.1.1"])
    assert(!privateAddress(address), `${address} is private`);
});
await test("the pinned lookup answers every checked address when asked for all", async () => {
  const addresses = [{ address: "93.184.215.14", family: 4 }, { address: "2606:2800:21f:cb07:6820:80da:af6b:8b2c", family: 6 }];
  let all, one;
  pinned(addresses)("x", { all: true }, (_, list) => (all = list));
  pinned(addresses)("x", {}, (_, address, family) => (one = [address, family]));
  assert(all === addresses && one[0] === "93.184.215.14" && one[1] === 4, `${JSON.stringify(all)} ${one}`);
});
await test("response headers drop hop-by-hop ones and those Connection names", async () => {
  const kept = keptHeaders([["connection", "x-hop, Keep-Alive"], ["x-hop", "1"], ["upgrade", "h2"], ["trailer", "x"], ["te", "trailers"],
    ["proxy-authenticate", "Basic"], ["content-encoding", "gzip"], ["content-length", "3"], ["x-kept", "1"]]);
  assert(JSON.stringify(Object.keys(kept)) === '["content-encoding","content-length","x-kept"]', JSON.stringify(kept));
});
await test("no decoding without a body or without one known coding", async () => {
  for (const [method, status, encoding] of [["HEAD", 200, "gzip"], ["GET", 204, "gzip"], ["GET", 304, "br"], ["GET", 200, "gzip, br"],
    ["GET", 200, "zstd"], ["GET", 200, undefined], ["GET", 200, "identity"]])
    assert(!decoderFor(method, status, encoding), `${method} ${status} ${encoding} decoded`);
  for (const encoding of ["gzip", "x-gzip", " Deflate ", "br"])
    assert(decoderFor("GET", 200, encoding), `${encoding} not decoded`);
});
await test("deflate decodes zlib-wrapped and raw", async () => {
  const text = "hello ".repeat(1000);
  for (const bytes of [deflateSync(text), deflateRawSync(text)]) {
    const chunks = Readable.from([bytes.subarray(0, 1), bytes.subarray(1)]);
    const out = Buffer.concat(await capped(chunks, decoderFor("GET", 200, "deflate")()).toArray());
    assert(out.toString() === text, `got ${out.length} bytes`);
  }
});
await test("a gzip bomb stops at the cap and takes its upstream with it", async () => {
  const source = Readable.from([gzipSync(Buffer.alloc(MIRROR_CAP + (10 << 20)))]);
  const error = await capped(source, decoderFor("GET", 200, "gzip")()).toArray().then(() => null, (e) => e);
  assert(/over 20 MB/.test(error?.message) && source.destroyed, `${error?.message}, destroyed: ${source.destroyed}`);
  const under = Buffer.concat(await capped(Readable.from([Buffer.alloc(1 << 20)])).toArray());
  assert(under.length === 1 << 20, "a body under the cap passes");
});
await test("the deadline aborts, and so does leaving", async () => {
  const leave = new AbortController();
  const timed = deadline(leave.signal, 50);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert(timed.aborted && timed.reason?.name === "TimeoutError", `${timed.aborted} ${timed.reason?.name}`);
  const left = deadline(leave.signal);
  leave.abort();
  assert(left.aborted && left.reason?.name === "AbortError", `leaving: ${left.reason?.name}`);
});

proxy.closeAllConnections();
await new Promise((resolve) => proxy.close(resolve));
upstream.closeAllConnections();
await new Promise((resolve) => upstream.close(resolve));
console.log(results.join("\n"));
process.exit(results.some((line) => line.startsWith("FAIL")) ? 1 : 0);
