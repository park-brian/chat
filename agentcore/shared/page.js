import { createSignal, For, Show } from "solid-js";
import { render as renderSolid } from "solid-js/web";
import html from "solid-js/html";
import { createSession, parseDeployment } from "./session.js";
import { createApi } from "./api.js";
import { pages, pageUrl, projectId } from "./navigation.js";
import { Heading, Menu, Notice } from "./ui.js";

// Boot phases are chosen from what this tab already knows, then advanced by real
// responses: a 424 retry means the Runtime is cold, not that a timer elapsed.
const phaseCopy = {
  exchanging: ["Finishing sign-in", "Confirming your sign-in with Cognito."],
  restoring: ["Restoring your session", "Checking your access with the AgentCore Runtime."],
  warming: ["Waking the runtime", "The first request after idle can take a few seconds."],
  updating: ["Deployment updating", "Connecting to the newest Runtime version."],
};
const booting = (phase) => phase in phaseCopy;
const initials = (email) => (email || "?").slice(0, 1).toUpperCase();

export async function mountPage({ key, title, render, preload }) {
  const auth = createSession(),
    api = createApi(auth);
  const query = new URL(location.href).searchParams;
  const [phase, setPhase] = createSignal(
    query.has("code") || query.has("error")
      ? "exchanging"
      : auth.hasTokens()
        ? "restoring"
        : "signed-out",
  );
  const [error, setError] = createSignal(""),
    [menu, setMenu] = createSignal(false),
    [projects, setProjects] = createSignal(null),
    [crumb, setCrumb] = createSignal(null),
    [status, setStatus] = createSignal(null);
  const page = pages.find((item) => item.key === key);
  const identity = () =>
    auth.session()?.user || (booting(phase()) ? auth.claims() : null);
  const isAdmin = () => identity()?.role === "Administrators";
  const visible = (group) =>
    pages.filter((item) => item.group === group && (!item.admin || isAdmin()));
  // A page's first data call may start beside session.get; it is used once and
  // discarded whenever validation replaces the Runtime session.
  let preloaded = null;
  const context = {
    ...auth,
    ...api,
    projectId,
    pageUrl,
    setProjects,
    // Wrapped: a Solid setter would call a view function as an updater.
    setCrumb: (view) => setCrumb(() => view),
    setStatus: (view) => setStatus(() => view),
    takePreload: () => {
      const value = preloaded;
      preloaded = null;
      return value;
    },
  };
  const loadProjects = () => {
    if (projects() || !auth.session()) return;
    api
      .rpc("projects.list")
      .then((result) => setProjects(result.items))
      .catch((cause) => setError(cause.message));
  };
  const projectName = () =>
    projects()?.find((item) => item.id === projectId())?.name ||
    (projectId() === "main" ? "Main project" : projectId());
  const switchProject = (id) => {
    const params = { project: id };
    const section = query.get("section");
    if (section) params.section = section;
    location.assign(pageUrl(key, params));
  };
  const signIn = async (event) => {
    event?.preventDefault();
    setError("");
    try {
      const value = event?.currentTarget?.elements?.deployment?.value;
      const config = value ? parseDeployment(value) : auth.deployment();
      if (!config) throw Error("Paste a valid deployment entry URL.");
      await auth.beginLogin(config);
    } catch (cause) {
      setError(cause.message);
    }
  };
  const busy = () => booting(phase()) || api.pending() > 0;
  const navLink = (item) =>
    html`<a
      class=${"nav" + (item.key === key ? " active" : "")}
      href=${pageUrl(item.key)}
      aria-current=${item.key === key ? "page" : undefined}
      >${item.title}</a
    >`;
  const app = document.getElementById("app");
  // Solid appends, so drop the static first-paint markup from index.html.
  app.replaceChildren();
  renderSolid(
    () =>
      html`<div
        class="page-layout"
        data-app-state=${() =>
          booting(phase())
            ? "connecting"
            : auth.session()
              ? "ready"
              : "disconnected"}
        data-boot-phase=${phase}
      >
        <a class="skip-link" href="#page-content">Skip to content</a>
        <header class="topbar" data-busy=${() => (busy() ? "" : undefined)}>
          <a class="brand" href=${pageUrl("chat")}
            ><span class="mark" aria-hidden="true">✦</span
            ><span class="brand-name">agentcore</span></a
          >
          <${Show} when=${() => page.scoped && auth.session()}>
            <span class="crumb-sep" aria-hidden="true">/</span>
            <${Menu}
              class="crumb"
              label=${() => "Project: " + projectName()}
              trigger=${() => html`<span class="crumb-label">${projectName}</span
                ><span class="caret" aria-hidden="true">▾</span>`}
              onOpen=${(event) => loadProjects(event)}
            >
              <div class="menu-heading">Projects</div>
              <${Show}
                when=${projects}
                fallback=${html`<div class="menu-note">Loading projects…</div>`}
              >
                <${For} each=${() => projects().filter((item) => !item.hidden || item.id === projectId())}
                  >${(item) =>
                    html`<button
                      type="button"
                      class="menu-item"
                      data-close
                      aria-current=${item.id === projectId() ? "true" : undefined}
                      onClick=${() => item.id !== projectId() && switchProject(item.id)}
                    >
                      <span>${item.name}</span><span class="mono dim">${item.id}</span>
                    </button>`}<//
                >
              <//>
              <a class="menu-item subtle" href=${pageUrl("agents", { section: "projects" })}
                >Manage projects</a
              >
            <//>
            ${() => crumb()?.()}
          <//>
          <div class=${() => "site-menu" + (menu() ? " open" : "")} id="site-menu">
            <nav class="primary-nav" aria-label="Workspace">
              <${For} each=${() => visible("primary")}>${navLink}<//>
            </nav>
            <${Menu}
              class="account"
              label="Account menu"
              triggerClass=${() => (booting(phase()) ? "verifying" : "")}
              trigger=${() => html`<span class="avatar-mark">${() => initials(identity()?.email)}</span>`}
            >
              <div class="account-head">
                <strong>${() => identity()?.email || (booting(phase()) ? "Verifying…" : "Signed out")}</strong>
                <span class="mono dim">${() => identity()?.role || ""}</span>
              </div>
              <nav aria-label="Account">
                <${For} each=${() => visible("account")}>${navLink}<//>
              </nav>
              <${Show} when=${auth.session}
                ><button type="button" class="menu-item danger" onClick=${auth.signOut}>
                  Sign out
                </button><//
              >
            <//>
          </div>
          <div class="topbar-status">${() => status()?.()}</div>
          <button
            type="button"
            class="menu-toggle"
            aria-label="Toggle navigation"
            aria-controls="site-menu"
            aria-expanded=${() => String(menu())}
            onClick=${() => setMenu(!menu())}
          >
            <span aria-hidden="true">${() => (menu() ? "✕" : "☰")}</span>
          </button>
          <span class="activity" aria-hidden="true"></span>
        </header>
        <main id="page-content" class=${"page-main page-" + key} tabindex="-1">
          <${Show} when=${() => key !== "chat" && !booting(phase())}
            ><${Heading}
              title=${title}
              description=${() => (page.scoped ? "project · " + projectId() : "")}
          /><//>
          <${Notice} error=${true} text=${error} />
          <${Show}
            when=${() => !booting(phase())}
            fallback=${html`<section class="boot" role="status" aria-live="polite">
              <span class="boot-mark" aria-hidden="true">✦</span>
              <h1 class="boot-title">${() => phaseCopy[phase()]?.[0]}</h1>
              <p class="boot-detail">${() => phaseCopy[phase()]?.[1]}</p>
            </section>`}
          >
            <${Show}
              when=${auth.session}
              fallback=${html`<section class="signin">
                <span class="boot-mark" aria-hidden="true">✦</span>
                <h2>Open your workspace</h2>
                <p>Sign in to your AgentCore deployment.</p>
                <form onSubmit=${signIn}>
                  <label
                    >Deployment entry URL<input
                      name="deployment"
                      type="text"
                      placeholder="https://…/agentcore/?region=…"
                      required=${() => !auth.deployment()}
                  /></label>
                  <button class="primary" type="submit">
                    ${() => (auth.deployment() ? "Sign in" : "Connect deployment")}
                  </button>
                </form>
              </section>`}
            >
              <${Show}
                when=${() => !page.admin || auth.session()?.user.role === "Administrators"}
                fallback=${html`<div class="empty">Administrator access is required.</div>`}
              >
                ${() => (auth.session() ? render(context) : null)}
              <//>
            <//>
          <//>
        </main>
      </div>`,
    app,
  );
  let redirecting = false;
  try {
    if (await auth.finishLogin()) {
      redirecting = true;
      return context;
    }
    if (auth.hasTokens()) {
      setPhase("restoring");
      preloaded = preload?.(context)?.catch(() => null) || null;
      let validated,
        replacedWorker = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          validated = await api.rpc("session.get");
          if (validated.apiVersion !== 2) {
            if (replacedWorker)
              throw Error("This deployment is updating. Reload in a moment.");
            preloaded = null;
            setPhase("updating");
            auth.resetRuntimeSession();
            replacedWorker = true;
            continue;
          }
          break;
        } catch (cause) {
          if (cause.status !== 424 || attempt === 3) throw cause;
          setPhase("warming");
          await new Promise((resolve) =>
            setTimeout(resolve, 500 * 2 ** attempt),
          );
        }
      }
      auth.setSession(validated);
    }
  } catch (cause) {
    preloaded = null;
    setError(cause.message);
  } finally {
    if (!redirecting) setPhase(auth.session() ? "ready" : "signed-out");
  }
  return context;
}
