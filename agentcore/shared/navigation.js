export const baseUrl = new URL("../", import.meta.url);
// "primary" pages are top-bar tabs; "account" pages live in the account menu.
// Scoped pages read ?project= and show the project crumb.
export const pages = [
  { key: "chat", title: "Chat", path: "", group: "primary", scoped: true },
  { key: "agents", title: "Agents", path: "agents/", group: "primary", scoped: true },
  { key: "connectors", title: "Connectors", path: "connectors/", group: "primary", scoped: true },
  { key: "usage", title: "Usage", path: "usage/", group: "primary" },
  { key: "profile", title: "Profile", path: "profile/", group: "account" },
  { key: "credentials", title: "Credentials", path: "credentials/", group: "account" },
  { key: "users", title: "Users", path: "users/", group: "account", admin: true },
];
export const projectId = () =>
  new URL(location.href).searchParams.get("project") || "main";
export function pageUrl(key, params = {}) {
  const page = pages.find((page) => page.key === key);
  if (!page) throw Error("Unknown page");
  const url = new URL(page.path, baseUrl);
  const values = {
    ...(projectId() !== "main" && { project: projectId() }),
    ...params,
  };
  for (const [name, value] of Object.entries(values))
    if (value !== undefined && value !== null && value !== "")
      url.searchParams.set(name, value);
  return url.href;
}
// Pages mount while the incoming cross-document view transition is still running,
// and rewriting the URL then aborts it. URL rewrites wait for the transition, and
// its promises are marked handled so a skipped transition is never an error.
// The incoming side is recorded by the inline pagereveal handler in index.html,
// which runs before this module can; this covers the outgoing side.
let revealed = window.agentcoreReveal || Promise.resolve();
addEventListener("pageswap", (event) => {
  const transition = event.viewTransition;
  if (transition)
    for (const name of ["ready", "updateCallbackDone", "finished"])
      transition[name].catch(() => {});
});
export function replaceUrl(url) {
  revealed = revealed.then(() =>
    history.replaceState(history.state, "", url),
  );
}
export function updateQuery(values) {
  const url = new URL(location.href);
  for (const [name, value] of Object.entries(values)) {
    if (value === null || value === undefined || value === "")
      url.searchParams.delete(name);
    else url.searchParams.set(name, value);
  }
  replaceUrl(url);
}
export function safeDestination(value) {
  const url = new URL(value || baseUrl.href, baseUrl);
  if (
    url.origin !== baseUrl.origin ||
    !url.pathname.startsWith(baseUrl.pathname)
  )
    throw Error("Invalid login destination");
  for (const name of ["code", "state", "error", "error_description"])
    url.searchParams.delete(name);
  return url.href;
}
