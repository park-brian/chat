#!/usr/bin/env node
// Local CORS proxy and TCP relay for the chat, on your own machine.
//   http://localhost:8001/https://example.com/x  fetches the URL and adds CORS headers
//   ws://localhost:8001/host:port                 opens a TCP socket (the tcpipe protocol)
//   http://example.com.localhost:8001/x           mirrors https://example.com/x at an origin of its own
// Only pages served from localhost may use it; set PROXY_ORIGINS=* (or a comma list, entries trimmed) to widen that.
// A mirror answers only the frame such a page opens and that frame's own same-origin requests (see mirrorAllowed).

import { lookup } from "node:dns/promises";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, connect, isIP } from "node:net";
import { Readable, Transform, pipeline } from "node:stream";
import { fileURLToPath } from "node:url";
import { createBrotliDecompress, createGunzip, createInflate, createInflateRaw } from "node:zlib";
import { WebSocketServer } from "ws";

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const LOCAL_NAME = /^(localhost|127\.0\.0\.1|\[::1\])$/;
const MIRROR = /^(.+)\.localhost(:\d+)?$/i;
// A mirrored page is never let in, not even by PROXY_ORIGINS=*.
const allowed = (origin) =>
  !!origin &&
  !MIRROR.test(URL.parse(origin)?.host ?? "") &&
  (LOCAL_ORIGIN.test(origin) ||
    [process.env.PROXY_ORIGINS]
      .join()
      .split(",")
      .map((o) => o.trim())
      .some((o) => o === "*" || o === origin));
// The Host a request was sent to, if it names this proxy's port: anything else is a rebound DNS name.
const hostOn = (header, port) => {
  const url = URL.parse(`http://${header}`);
  return url && Number(url.port || 80) === port ? url : null;
};
// This machine and its network, which a mirror never serves: by name, by number, and by address once resolved.
const LOCAL_HOST =
  /^(localhost|.+\.localhost|.+\.local|0\.0\.0\.0|127\.[\d.]+|10\.[\d.]+|192\.168\.[\d.]+|172\.(1[6-9]|2\d|3[01])\.[\d.]+|169\.254\.[\d.]+|\[.*\])$/i;
const NUMERIC = /(^|\.)(0x[\da-f]*|\d+)$/i;
// IPv4-mapped IPv6 addresses are checked against the IPv4 ranges.
const PRIVATE = new BlockList();
for (const [net, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]])
  PRIVATE.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [["::", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["2001::", 32], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]])
  PRIVATE.addSubnet(net, prefix, "ipv6");
export const privateAddress = (address) => PRIVATE.check(address, `ipv${isIP(address)}`);
const refused = (message) => Object.assign(new Error(message), { status: 403 });
// Hop-by-hop and browser-identity headers stay behind; fetch sets its own framing.
const DROP_REQUEST =
  /^(host|origin|referer|cookie|connection|keep-alive|proxy-.*|te|trailer|transfer-encoding|upgrade|content-length|sec-fetch-.*|x-proxy-api-key)$/i;
const DROP_RESPONSE =
  /^(connection|keep-alive|transfer-encoding|upgrade|trailer|te|proxy-authenticate|access-control-.*|set-cookie)$/i;
// What a decoded body no longer has.
const DROP_CODING = /^(content-encoding|content-length)$/i;
// The app frames a mirror, which the site's own policies would forbid.
const DROP_MIRROR = /^(content-security-policy.*|x-frame-options)$/i;
// Deflate should be zlib-wrapped, but some servers send it raw: a zlib stream's first byte names method 8.
const inflate = () => {
  let inner;
  return new Transform({
    transform(chunk, _, done) {
      inner ??= ((chunk[0] & 0x0f) === 8 && chunk[0] >> 4 <= 7 ? createInflate() : createInflateRaw())
        .on("data", (data) => this.push(data))
        .on("error", (error) => this.destroy(error));
      inner.write(chunk) ? done() : inner.once("drain", done);
    },
    flush(done) {
      inner ? inner.once("end", done).end() : done();
    },
    destroy(error, done) {
      inner?.destroy();
      done(error);
    },
  });
};
const DECODERS = { gzip: createGunzip, "x-gzip": createGunzip, deflate: inflate, br: createBrotliDecompress };
const RENDER_LIMIT = 15000;
// A mirror's body stops at 20 MB decoded, and its request at 20 s, DNS and redirects included: about as long as the
// page waits for a frame.
export const MIRROR_CAP = 20 << 20,
  MIRROR_DEADLINE = 20_000;

// The browser offers zstd, which neither fetch here can decode; it would pass the bytes on still compressed.
const upstreamHeaders = (request) => ({
  ...Object.fromEntries(
    Object.entries(request.headers).filter(([name]) => !DROP_REQUEST.test(name)),
  ),
  "accept-encoding": "gzip, deflate, br",
});
const requestBody = async (request) =>
  ["GET", "HEAD"].includes(request.method)
    ? undefined
    : Buffer.concat(await request.toArray());
// Hop-by-hop headers stay behind, and so do those the response's Connection names.
export const keptHeaders = (entries, ...drops) => {
  const named = String(entries.find(([name]) => name === "connection")?.[1] ?? "").toLowerCase().split(/\s*,\s*/);
  return Object.fromEntries(
    entries.filter(([name]) => !named.includes(name) && ![DROP_RESPONSE, ...drops].some((drop) => drop.test(name))),
  );
};
// A client that leaves takes its upstream request with it.
const abortOnLeave = (response) => {
  const controller = new AbortController();
  response.on("close", () => !response.writableFinished && controller.abort());
  return controller.signal;
};

async function forward(request, response, port) {
  const host = hostOn(request.headers.host, port);
  if (host?.hostname.endsWith(".localhost"))
    return mirror(request, response, host.hostname.slice(0, -".localhost".length));
  if (!host || !LOCAL_NAME.test(host.hostname))
    return response.writeHead(403).end("Host not allowed\n");
  const origin = request.headers.origin;
  const cors = {
    "access-control-allow-origin": origin || "*",
    "access-control-expose-headers": "*",
    vary: "origin",
  };
  // Only a page's fetch: a navigation (a link, a form) could be any site's.
  if (!allowed(origin) || request.headers["sec-fetch-mode"] === "navigate")
    return response.writeHead(403, cors).end("Origin not allowed\n");
  if (request.url === "/health")
    return response
      .writeHead(200, { ...cors, "content-type": "application/json" })
      .end(JSON.stringify({ proxy: "chat" }));
  if (request.method === "OPTIONS") {
    return response
      .writeHead(204, {
        ...cors,
        "access-control-allow-methods": "*",
        "access-control-max-age": "86400",
        "access-control-allow-headers":
          request.headers["access-control-request-headers"] || "*",
      })
      .end();
  }
  const target = request.url.slice(1).replace(/^(https?:)\/+/, "$1//");
  if (!/^https?:\/\//.test(target))
    return response
      .writeHead(400, cors)
      .end("Usage: /https://example.com/path\n");

  const signal = abortOnLeave(response);
  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers: upstreamHeaders(request),
      body: await requestBody(request),
      redirect: "follow",
      signal,
    });
    // The page reads it with fetch; opened as a document, it is inert.
    response.writeHead(upstream.status, {
      ...keptHeaders([...upstream.headers], DROP_CODING),
      ...cors,
      "content-security-policy": "sandbox",
      "x-content-type-options": "nosniff",
      "x-final-url": upstream.url,
    });
    upstream.body
      ? pipeline(Readable.fromWeb(upstream.body), response, () => {})
      : response.end();
  } catch (error) {
    if (signal.aborted) return;
    // The header marks the failure as the network's, so the page's fetch can reject the way a browser's does.
    const reason = error.cause?.message || error.message;
    response
      .writeHead(502, { ...cors, "x-proxy-error": encodeURIComponent(reason) })
      .end(`Proxy error: ${reason}\n`);
  }
}

// The address a mirror fetch connects to, checked once and then pinned, so a second resolution can't rebind it.
async function publicAddress(url, signal) {
  const name = url.hostname.replace(/\.$/, "");
  if (!/^https?:$/.test(url.protocol) || LOCAL_HOST.test(name) || NUMERIC.test(name) || isIP(name))
    throw refused("Not mirrored");
  const addresses = await until(lookup(name, { all: true }), signal);
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address)))
    throw refused("Not mirrored");
  return addresses;
}
// A lookup that answers only with the checked addresses: all of them when asked for all.
export const pinned = (addresses) => (_, options, done) =>
  options?.all ? done(null, addresses) : done(null, addresses[0].address, addresses[0].family);
// The promise, or the signal's reason once it aborts.
const until = (promise, signal) =>
  new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
const send = (url, method, headers, body, addresses, signal) =>
  new Promise((resolve, reject) =>
    (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method,
        headers: body ? { ...headers, "content-length": body.length } : headers,
        signal,
        lookup: pinned(addresses),
      },
      resolve,
    )
      .on("error", reject)
      .end(body),
  );
// Redirects are followed here, one hop at a time, each to an address checked like the first.
async function fetchPublic(request, url, body, signal) {
  let method = request.method;
  const headers = upstreamHeaders(request);
  for (let hop = 0; ; hop++) {
    const upstream = await send(url, method, headers, body, await publicAddress(url, signal), signal);
    const { statusCode: status, headers: { location } } = upstream;
    if (![301, 302, 303, 307, 308].includes(status) || !location) return upstream;
    upstream.resume();
    if (hop === 20) throw new Error("too many redirects");
    const next = new URL(location, url);
    if (next.host !== url.host) delete headers.authorization;
    if ((status === 303 && method !== "HEAD") || (status < 303 && method === "POST"))
      [method, body] = ["GET", undefined];
    url = next;
  }
}
const bodiless = (method, status) => method === "HEAD" || status === 204 || status === 304;
// A body's decoder, if it has a body in one coding decoded here; otherwise the body passes as it came.
export const decoderFor = (method, status, encoding) =>
  bodiless(method, status) ? undefined : DECODERS[encoding?.trim().toLowerCase()];
// The streams piped together and failing past the cap; a failure destroys them all, the upstream with them.
export const capped = (...streams) => {
  let size = 0;
  const count = new Transform({
    transform(chunk, _, done) {
      size += chunk.length;
      done(size > MIRROR_CAP ? new Error(`body over ${MIRROR_CAP >> 20} MB`) : null, chunk);
    },
  });
  return pipeline(...streams, count, () => {});
};
// The client leaving or the deadline passing, whichever comes first.
export const deadline = (leave, ms = MIRROR_DEADLINE) => AbortSignal.any([leave, AbortSignal.timeout(ms)]);
// A mirror serves the frame the app opens, framed cross-site by a page that may use this proxy, and that frame's own
// requests, which are same-origin: its subresources and in-frame navigations (the frame needs allow-same-origin).
// The rest is refused: a top-level visit, a request without Sec-Fetch-Site, and a same-site one, which is any other
// mirror, since all of them share localhost.
export const mirrorAllowed = (headers) => {
  const site = headers["sec-fetch-site"],
    dest = headers["sec-fetch-dest"];
  return (
    (site === "same-origin" && dest !== "document") ||
    (site === "cross-site" && dest === "iframe" && allowed(URL.parse(headers.referer ?? "")?.origin))
  );
};
// The charset the response declares, in its header or its own meta tag.
function decodeHtml(bytes, type) {
  const label =
    /charset=["']?([\w-]+)/i.exec(type ?? "")?.[1] ??
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(bytes.subarray(0, 1024).toString("latin1"))?.[1];
  try {
    return new TextDecoder(label ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

// A site at an origin of its own, for read_url to render: its paths resolve on its host, and its router sees its own
// path. It answers as mirrorAllowed says, and only for a site out on the internet. Its origin is neither the app's nor
// one this proxy lets in, so the page's scripts reach neither the app's storage nor the proxy nor the relay.
async function mirror(request, response, site) {
  const framed = request.headers["sec-fetch-dest"] === "iframe";
  // A framed failure tells the frame's parent, which would otherwise wait out its limit.
  const fail = (status, error) =>
    framed
      ? response
          .writeHead(status, { "content-type": "text/html" })
          .end(
            `<script>parent.postMessage(${JSON.stringify({ type: "rendered", error })}, "*")</script>`,
          )
      : response.writeHead(status).end(error + "\n");
  const target = URL.parse(`https://${site}${request.url}`);
  if (!mirrorAllowed(request.headers)) return fail(403, "Not allowed");
  if (target?.hostname !== site) return fail(403, "Not mirrored");
  const leave = abortOnLeave(response),
    signal = deadline(leave);
  try {
    const upstream = await fetchPublic(request, target, await requestBody(request), signal);
    const { statusCode: status, headers: { "content-type": type, "content-encoding": encoding } } = upstream;
    const entries = Object.entries(upstream.headers);
    const decoder = decoderFor(request.method, status, encoding);
    const body = () => capped(upstream, ...(decoder ? [decoder()] : []));
    // Past the cap a stream is cut short: its status has gone out.
    if (!framed || !/^text\/html/i.test(type) || bodiless(request.method, status))
      return pipeline(
        body(),
        response.writeHead(status, keptHeaders(entries, DROP_MIRROR, ...(decoder ? [DROP_CODING] : []))),
        () => {},
      );
    if (!decoder && !/^(identity)?$/i.test(encoding?.trim() ?? "")) {
      upstream.destroy();
      throw new Error(`can't decode ${encoding}`);
    }
    const script = `<script>(${reader})(${RENDER_LIMIT})</script>`;
    const html = decodeHtml(Buffer.concat(await body().toArray()), type)
      .replace(/<meta[^>]+http-equiv=["']?content-security-policy[^>]*>/gi, "")
      .replace(/^(\s*<!doctype[^>]*>)?/i, (doctype) => doctype + script);
    response
      .writeHead(status, {
        ...keptHeaders(entries, DROP_MIRROR, DROP_CODING),
        "content-type": "text/html; charset=utf-8",
      })
      .end(html);
  } catch (error) {
    if (leave.aborted) return;
    const reason = signal.aborted ? `no answer in ${MIRROR_DEADLINE / 1000} s` : error.cause?.message || error.message;
    fail(error.status ?? 502, error.status ? error.message : `Proxy error: ${reason}`);
  }
}
// Runs first in a framed mirror: once the page has loaded and gone quiet, it sends its frame's parent what it built,
// and when asked, a picture of what the frame shows, drawn from the live page with its own fonts and canvases.
function reader(limit) {
  const start = Date.now();
  let changed = start;
  new MutationObserver(() => (changed = Date.now())).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
  });
  (function settle() {
    const busy =
      document.readyState !== "complete" || Date.now() - changed < 800;
    if (busy && Date.now() - start < limit) return setTimeout(settle, 100);
    parent.postMessage(
      { type: "rendered", html: document.documentElement.outerHTML },
      "*",
    );
  })();
  addEventListener("message", async ({ source, data }) => {
    if (source !== parent || data?.type !== "screenshot") return;
    try {
      const { domToBlob } =
        await import("https://cdn.jsdelivr.net/npm/modern-screenshot@4.7.0/+esm");
      // A lazy image offscreen never loads, and the picture would wait for it.
      document
        .querySelectorAll("img[loading=lazy]")
        .forEach((img) => (img.loading = "eager"));
      const background = getComputedStyle(document.body).backgroundColor;
      const blob = await domToBlob(document.documentElement, {
        width: innerWidth,
        height: innerHeight,
        scale: 0.8,
        type: "image/webp",
        quality: 0.85,
        backgroundColor:
          background !== "rgba(0, 0, 0, 0)" ? background : "#ffffff",
        // The picture is drawn with scripts off, so a page's no-script notice would show.
        filter: (node) => node.nodeName !== "NOSCRIPT",
      });
      const bytes = await blob.arrayBuffer();
      parent.postMessage({ type: "screenshot", bytes }, "*", [bytes]);
    } catch (error) {
      parent.postMessage(
        { type: "screenshot", error: String(error?.message ?? error) },
        "*",
      );
    }
  });
}

// Same wire protocol as tcpipe's relay, so its clients (redis, postgres, ssh, ...) connect here unchanged.
// The socket pauses while the page is slower to take its data than the service is to send it.
const HIGH_WATER = 1 << 20,
  LOW_WATER = 1 << 18;
function relay(ws, host, port) {
  const tcp = connect(port, host);
  tcp.on("connect", () => ws.send(JSON.stringify({ type: "connected" })));
  tcp.on("data", (chunk) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(chunk, () => tcp.isPaused() && ws.bufferedAmount < LOW_WATER && tcp.resume());
    if (ws.bufferedAmount > HIGH_WATER) tcp.pause();
  });
  tcp.on("error", (error) => {
    if (ws.readyState === ws.OPEN)
      ws.send(JSON.stringify({ type: "error", message: error.message }));
    ws.close();
  });
  tcp.on("close", () => ws.close());
  let waiting = false;
  ws.on("message", (data) => {
    if (tcp.write(data) || waiting) return;
    waiting = true;
    ws.pause();
    tcp.once("drain", () => {
      waiting = false;
      ws.resume();
    });
  });
  ws.on("close", () => tcp.destroy());
  ws.on("error", () => tcp.destroy());
}

export async function startProxy(port = 8001) {
  const server = createServer((request, response) =>
    forward(request, response, server.address().port),
  );
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    // The server stops handling this socket's errors here: a client resetting it would otherwise crash the proxy.
    socket.on("error", () => socket.destroy());
    const refuse = (status) =>
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    const host = hostOn(request.headers.host, server.address().port);
    if (!host || !LOCAL_NAME.test(host.hostname) || !allowed(request.headers.origin))
      return refuse("403 Forbidden");
    const target = /^\/(?:[a-z]+:\/\/)?([^/:]+|\[[^\]]+\]):(\d+)/.exec(
      request.url,
    );
    const tcpPort = Number(target?.[2]);
    if (!target || !(tcpPort >= 1 && tcpPort <= 65535))
      return refuse("400 Bad Request");
    sockets.handleUpgrade(request, socket, head, (ws) =>
      relay(ws, target[1].replace(/^\[|\]$/g, ""), tcpPort),
    );
  });
  await new Promise((ready, reject) =>
    server.once("error", reject).listen(port, "localhost", ready),
  );
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || process.env.PROXY_PORT || 8001);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Invalid port");
  const server = await startProxy(port);
  console.log(
    `CORS proxy at http://localhost:${server.address().port}/<url>, TCP relay at ws://localhost:${server.address().port}/<host>:<port>`,
  );
}
