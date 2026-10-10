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
export function updateQuery(values) {
  const url = new URL(location.href);
  for (const [name, value] of Object.entries(values)) {
    if (value === null || value === undefined || value === "")
      url.searchParams.delete(name);
    else url.searchParams.set(name, value);
  }
  history.replaceState(history.state, "", url);
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
