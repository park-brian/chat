import { createSignal } from "solid-js";
const messages = {
  REVISION_CONFLICT: "This item changed elsewhere. Reload it before saving.",
  CREDENTIAL_IN_USE:
    "Remove this credential from its connectors before deleting it.",
  CREDENTIAL_KIND_MISMATCH:
    "Choose a credential for the same service as this connector.",
  CREDENTIAL_LIMIT: "The saved credential limit has been reached.",
  USE_CREDENTIALS:
    "Save the secret on Credentials, then select it for this connector.",
  FORBIDDEN: "Your account cannot perform this action.",
  NOT_FOUND: "This item is no longer available.",
  VALIDATION_FAILED: "Check the form values and try again.",
  PROTECTED_ADMIN: "The protected administrator cannot be disabled or demoted.",
  BRANCH_BUSY: "This conversation path already has a turn running.",
  BRANCH_CONFLICT: "This conversation path changed. Reopen it before sending.",
  RUN_ACTIVE:
    "Wait for active turns to finish before deleting this conversation.",
  SESSION_CHANGED: "Sign in again to refresh your access.",
  UNAUTHENTICATED: "Sign in to continue.",
};
const errorText = (error, fallback) =>
  error?.message || messages[error?.code] || error?.code || fallback;
export function createApi(auth) {
  const observers = new Set();
  // Short RPCs in flight; long-lived chat.watch streams are reported by the run indicator instead.
  const [pending, setPending] = createSignal(0);
  window.addEventListener("agentcore:signout", () => {
    for (const controller of observers) controller.abort();
  });
  window.addEventListener("pagehide", () => {
    for (const controller of observers) controller.abort();
  });
  async function request(command, input = {}, signal) {
    const token = await auth.accessToken(),
      config = auth.deployment();
    return fetch(
      `https://bedrock-agentcore.${config.region}.amazonaws.com/runtimes/${encodeURIComponent(config.runtime)}/invocations?qualifier=DEFAULT`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
          "x-amzn-bedrock-agentcore-runtime-session-id":
            auth.runtimeSessionId(),
        },
        signal,
        body: JSON.stringify({
          v: 1,
          command,
          requestId: crypto.randomUUID(),
          input,
        }),
      },
    );
  }
  async function rpc(command, input = {}) {
    setPending((count) => count + 1);
    try {
      return await call(command, input);
    } finally {
      setPending((count) => count - 1);
    }
  }
  async function call(command, input) {
    const response = await request(command, input),
      result = await response.json();
    if (!response.ok || !result.ok) {
      const error = Object.assign(
        Error(errorText(result.error, "Operation failed")),
        { status: response.status, code: result.error?.code },
      );
      if (["SESSION_CHANGED", "UNAUTHENTICATED"].includes(error.code))
        auth.clear();
      throw error;
    }
    return result.data;
  }
  async function watch(requestId, onEvent, { after = 0, signal } = {}) {
    const controller = new AbortController();
    observers.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      let reconnects = 0;
      for (;;) {
        try {
          const response = await request(
            "chat.watch",
            { requestId, after },
            controller.signal,
          );
          if (
            !response.ok ||
            !response.headers.get("content-type")?.includes("text/event-stream")
          ) {
            const result = await response.json();
            if (
              ["SESSION_CHANGED", "UNAUTHENTICATED"].includes(
                result.error?.code,
              )
            )
              auth.clear();
            throw Object.assign(
              Error(errorText(result.error, "Observer could not connect")),
              { code: result.error?.code },
            );
          }
          const reader = response.body.getReader(),
            decoder = new TextDecoder();
          let buffer = "",
            terminal = false;
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const chunks = buffer.split("\n\n");
            buffer = chunks.pop();
            for (const chunk of chunks) {
              const data = chunk
                .split("\n")
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trim())
                .join("\n");
              if (!data) continue;
              const event = JSON.parse(data);
              // run.status is a state snapshot carrying the last progress
              // sequence, not a progress event: never drop it as a replay.
              const progress = event.type !== "run.status";
              if (progress && event.sequence && event.sequence <= after)
                continue;
              if (progress && event.sequence) after = event.sequence;
              onEvent(event);
              if (
                event.type === "run.status" &&
                !["running", "memory_written"].includes(event.status)
              )
                terminal = true;
            }
          }
          if (terminal) return;
          reconnects = 0;
          if (controller.signal.aborted)
            throw new DOMException("Observer detached", "AbortError");
        } catch (error) {
          if (controller.signal.aborted || error.code || ++reconnects > 3)
            throw error;
          await new Promise((resolve) =>
            setTimeout(resolve, 250 * 2 ** reconnects),
          );
        }
      }
    } finally {
      observers.delete(controller);
      signal?.removeEventListener("abort", abort);
    }
  }
  return { rpc, watch, pending };
}
