// Serves a workspace's files at their paths, so a page loads its own folder: relative imports, fetch, CSS url(),
// workers, all as they work once the folder is on a server. The runner writes each run's files to Cache Storage
// before its frame navigates; this only reads them. Its scope is __ws/ beside the app, so the app's own requests
// never pass through it.
const CACHE = "workspace-runs";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", e => {
  // A page here also fetches from CDNs and APIs: those go to the network as they would anyway.
  if (!e.request.url.startsWith(self.registration.scope) || !["GET", "HEAD"].includes(e.request.method)) return;
  const url = new URL(e.request.url);
  // A malformed escape goes to the network, which answers it as it would.
  let path;
  try { path = decodeURIComponent((url.origin + url.pathname).slice(self.registration.scope.length).replace(/^[^/]*\//, "")); } catch { return; }
  e.respondWith(caches.open(CACHE).then(cache => cache.match(url.origin + url.pathname)).then(found => found ??
    new Response(`${path} is not in the workspace`, { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } })));
});
