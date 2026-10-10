import { createSignal, For, Show, onCleanup } from "solid-js";
import html from "solid-js/html";

export const dollars = (micro) => (Number(micro || 0) / 1000000).toFixed(2);
export const gb = (bytes) => (Number(bytes || 0) / 1000000000).toFixed(2);
export const Notice = (props) =>
  html`<${Show} when=${() => props.text}
    ><div
      class=${() => (props.error ? "error" : "notice")}
      role=${() => (props.error ? "alert" : "status")}
    >
      ${() => props.text}
    </div><//
  >`;
export const Empty = (props) =>
  html`<div class="empty" role="status">
    ${() => props.text || "Nothing here yet."}
  </div>`;
export const Badge = (props) =>
  html`<span class="status">${() => props.text}</span>`;
export const Heading = (props) =>
  html`<header class="page-heading">
    <h1>${props.title}</h1>
    <p class="mono">${props.description}</p>
  </header>`;
// Placeholder rows with the eventual layout's rhythm; the label is for assistive tech only.
export const Skeleton = (props) =>
  html`<div
    class=${() => "skeleton " + (props.variant || "panel")}
    role="status"
    aria-busy="true"
  >
    <span class="visually-hidden">${() => props.label || "Loading…"}</span>
    <${For} each=${() => Array.from({ length: props.rows || 3 })}
      >${() => html`<span class="skeleton-line"></span>`}<//
    >
  </div>`;
// Disclosure menu: Escape or an outside click closes it and focus returns to the trigger.
export function Menu(props) {
  const [open, setOpen] = createSignal(false);
  let root, trigger;
  const close = (restore) => {
    if (!open()) return;
    setOpen(false);
    if (restore) trigger?.focus();
  };
  const outside = (event) => {
    if (root && !root.contains(event.target)) close(false);
  };
  const escape = (event) => {
    if (event.key === "Escape") close(true);
  };
  document.addEventListener("pointerdown", outside);
  document.addEventListener("keydown", escape);
  onCleanup(() => {
    document.removeEventListener("pointerdown", outside);
    document.removeEventListener("keydown", escape);
  });
  return html`<div
    class=${() => "menu " + (props.class || "") + (open() ? " open" : "")}
    ref=${(element) => (root = element)}
  >
    <button
      type="button"
      class=${() => "menu-trigger " + (props.triggerClass || "")}
      aria-label=${() => props.label}
      aria-expanded=${() => String(open())}
      disabled=${() => props.disabled}
      ref=${(element) => (trigger = element)}
      onClick=${(event) => {
        const next = !open();
        setOpen(next);
        if (next) props.onOpen?.(event);
      }}
    >
      ${props.trigger}
    </button>
    <div class="menu-panel" onClick=${(event) => {
      if (event.target.closest("a, [data-close]")) close(false);
    }}>${props.children}</div>
  </div>`;
}
export const Field = (props) =>
  html`<label>${props.label}${props.children}</label>`;
export function createFeedback() {
  const [error, setError] = createSignal(""),
    [notice, setNotice] = createSignal(""),
    [saving, setSaving] = createSignal(false);
  let dirty = false;
  const beforeUnload = (event) => {
    if (dirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  };
  window.addEventListener("beforeunload", beforeUnload);
  onCleanup(() => window.removeEventListener("beforeunload", beforeUnload));
  const changed = () => {
    dirty = true;
    setNotice("");
  };
  async function perform(work, message = "Saved.") {
    setError("");
    setNotice("");
    setSaving(true);
    try {
      const result = await work();
      if (message) dirty = false;
      setNotice(message);
      return result;
    } catch (cause) {
      setError(cause.message);
      return undefined;
    } finally {
      setSaving(false);
    }
  }
  return {
    error,
    notice,
    saving,
    changed,
    perform,
    report: setError,
    saved: (text = "Saved.") => {
      dirty = false;
      setNotice(text);
    },
    mayLeave: async () =>
      !dirty || (await confirmAction("Discard your unsaved changes?")),
    clean: () => {
      dirty = false;
    },
    view: () =>
      html`<${Notice} error=${true} text=${error()} /><${Notice}
          text=${notice()}
        />`,
  };
}
export function confirmAction(message) {
  return new Promise((resolve) => {
    const previous = document.activeElement,
      dialog = document.createElement("dialog");
    dialog.className = "confirmation";
    dialog.setAttribute("aria-label", "Confirm action");
    const content = document.createElement("p");
    content.textContent = message;
    const buttons = document.createElement("div");
    buttons.className = "actions";
    const cancel = document.createElement("button"),
      proceed = document.createElement("button");
    cancel.textContent = "Cancel";
    proceed.textContent = "Confirm";
    proceed.className = "primary";
    const finish = (accepted) => {
      dialog.close();
      dialog.remove();
      previous?.focus();
      resolve(accepted);
    };
    cancel.onclick = () => finish(false);
    proceed.onclick = () => finish(true);
    dialog.oncancel = (event) => {
      event.preventDefault();
      finish(false);
    };
    buttons.append(cancel, proceed);
    dialog.append(content, buttons);
    document.body.append(dialog);
    dialog.showModal();
    cancel.focus();
  });
}
