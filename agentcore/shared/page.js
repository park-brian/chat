import { createSignal, For, Show } from "solid-js";
import { render as renderSolid } from "solid-js/web";
import html from "solid-js/html";
import { createSession, parseDeployment } from "./session.js";
import { createApi } from "./api.js";
import { pages, pageUrl, projectId } from "./navigation.js";
import { Heading, Notice } from "./ui.js";

export async function mountPage({ key, title, render }) {
  const auth = createSession(),
    api = createApi(auth);
  const [loading, setLoading] = createSignal(true),
    [error, setError] = createSignal(""),
    [menu, setMenu] = createSignal(false);
  const page = pages.find((item) => item.key === key);
  const context = { ...auth, ...api, projectId, pageUrl };
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
  renderSolid(
    () =>
      html`<div
        class="page-layout"
        data-app-state=${() => (loading() ? "connecting" : auth.session() ? "ready" : "disconnected")}
      >
        <a class="skip-link" href="#page-content">Skip to content</a>
        <aside class=${() => "page-sidebar" + (menu() ? " open" : "")}>
          <a class="brand" href=${pageUrl("chat")}
            ><span class="mark">✦</span>agentcore</a
          >
          <nav aria-label="Workspace">
            <${For}
              each=${() => pages.filter((item) => !item.admin || auth.session()?.user.role === "Administrators")}
            >
              ${(item) => html`<a class=${"nav" + (item.key === key ? " active" : "")} href=${pageUrl(item.key)} aria-current=${item.key === key ? "page" : undefined}>${item.title}</a>`}<//
            >
          </nav>
          <div class="sidebar-account">
            <small
              >${() => auth.session()?.user.email || "Your private workspace"}</small
            >
            <${Show} when=${auth.session}
              ><button class="link-button" onClick=${auth.signOut}>
                Sign out
              </button><//
            >
          </div>
        </aside>
        <main id="page-content" class=${"page-main page-" + key} tabindex="-1">
          <div class="mobile-page-bar">
            <a class="brand" href=${pageUrl("chat")}>✦ agentcore</a
            ><button
              aria-label="Toggle navigation"
              aria-expanded=${menu}
              onClick=${() => setMenu(!menu())}
            >
              ☰
            </button>
          </div>
          <${Show} when=${() => key !== "chat"}
            ><${Heading}
              title=${title}
              description=${() => (projectId() !== "main" ? "Project · " + projectId() : "")}
          /><//>
          <${Notice} error=${true} text=${error()} />
          <${Show}
            when=${() => !loading()}
            fallback=${html`<div class="empty" role="status">Opening workspace…</div>`}
          >
            <${Show}
              when=${auth.session}
              fallback=${html`<section class="signin">
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
    document.getElementById("app"),
  );
  try {
    if (await auth.finishLogin()) return context;
    if (auth.hasTokens()) {
      let validated, replacedWorker = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          validated = await api.rpc("session.get");
          if (validated.apiVersion !== 2) {
            if (replacedWorker) throw Error("This deployment is updating. Reload in a moment.");
            auth.resetRuntimeSession(); replacedWorker = true; continue;
          }
          break;
        } catch (cause) {
          if (cause.status !== 424 || attempt === 3) throw cause;
          await new Promise((resolve) =>
            setTimeout(resolve, 500 * 2 ** attempt),
          );
        }
      }
      auth.setSession(validated);
    }
  } catch (cause) {
    setError(cause.message);
  } finally {
    setLoading(false);
  }
  return context;
}
