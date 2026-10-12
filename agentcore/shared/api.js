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
  RUN_LIMIT: "Too many turns are running. Wait for one to finish.",
  ADMISSION_FAILED: "The turn could not start. Try again.",
  BUDGET_EXHAUSTED: "Your usage budget for this period is used up.",
  STORAGE_EXHAUSTED: "Your file storage is full. Delete files to continue.",
  QUOTA_EXCEEDED: "This would exceed your file storage limit.",
  MODEL_UNAVAILABLE: "This model is not available. Choose another model.",
  TOOL_UNAVAILABLE: "This model or agent cannot use the requested tool.",
  AGENT_ARCHIVED: "This agent is archived. Restore it or choose another.",
  CONNECTION_REVOKED: "This connector's access was revoked. Reconnect it.",
  CONNECTION_UNAVAILABLE: "A selected connector is no longer available.",
  CONNECTION_IN_USE: "Remove this connector from its agents before deleting it.",
  CONNECTION_TEST_UNAVAILABLE: "This connector cannot be tested.",
  SKILL_UNAVAILABLE: "A selected skill is no longer available.",
  SKILL_IN_USE: "Remove this skill from its agents before deleting it.",
  FILE_UNAVAILABLE: "A selected file is no longer available.",
  REQUEST_ID_CONFLICT: "This request was already sent with different content.",
  PROJECT_EXISTS: "A project with this ID already exists.",
  PROJECT_LIMIT: "The project limit has been reached.",
  USER_EXISTS: "A person with this email already exists.",
  UPLOAD_MISSING: "The upload did not arrive. Try uploading again.",
  UPLOAD_SIZE_MISMATCH: "The uploaded file size did not match. Try again.",
  UPLOAD_OUTCOME_UNKNOWN:
    "The upload could not be confirmed. Reload to check your files.",
  HISTORY_INCOMPLETE: "Part of this conversation could not be loaded.",
  OUTCOME_UNKNOWN: "The outcome is unknown. Reload to check.",
  CANCELLED: "Cancelled.",
  ACCESS_REVOKED: "Your access changed. Sign in again.",
  NOT_IMPLEMENTED: "This deployment does not support that action yet.",
  TOO_LARGE: "The request is too large.",
  INTERNAL: "Something went wrong in the Runtime. Try again.",
  SESSION_CHANGED: "Sign in again to refresh your access.",
  UNAUTHENTICATED: "Sign in to continue.",
};
const readJson = async (response) => {
  try {
    return await response.json();
  } catch {
    return {};
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// AgentCore's own authorizer answers 401/403 with { message } and no envelope.
function failure(response, result, fallback, auth) {
  const code =
    result?.error?.code ||
    ([401, 403].includes(response.status) ? "UNAUTHENTICATED" : undefined);
  if (["SESSION_CHANGED", "UNAUTHENTICATED"].includes(code)) auth.clear();
  return Object.assign(
    Error(
      result?.error?.message ||
        messages[code] ||
        result?.message ||
        code ||
        (response.ok ? fallback : `${fallback} (HTTP ${response.status})`),
    ),
    { status: response.status, code },
  );
}
export function createApi(auth, { onWarming } = {}) {
  const observers = new Set();
  // Short RPCs in flight; long-lived chat.watch streams are reported by the run indicator instead.
  const [pending, setPending] = createSignal(0);
  window.addEventListener("agentcore:signout", () => {
    for (const controller of observers) controller.abort();
  });
  window.addEventListener("pagehide", () => {
    for (const controller of observers) controller.abort();
  });
  // AgentCore answers 409 "Session operation in progress" to any call that
  // overlaps creation of a session's microVM. On a session that has not started,
  // the first call goes alone and the rest wait for it; started sessions keep
  // full concurrency.
  let starting = null;
  async function request(command, input = {}, signal) {
    if (!auth.runtimeStarted()) {
      if (starting) await starting.catch(() => {});
      else {
        starting = send(command, input, signal);
        try {
          const response = await starting;
          if (response.ok) auth.markRuntimeStarted();
          return response;
        } finally {
          starting = null;
        }
      }
    }
    return send(command, input, signal);
  }
  async function send(command, input, signal) {
    const requestId = crypto.randomUUID();
    for (let attempt = 0, cold = 0; ; attempt++) {
      const token = await auth.accessToken(),
        config = auth.deployment();
      const response = await fetch(
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
          body: JSON.stringify({ v: 1, command, requestId, input }),
        },
      );
      // 424: usually a cold Runtime that ran nothing. Retried with the same
      // requestId; writes are guarded by ids and revisions if one did run.
      if (response.status === 424 && cold < 3) {
        onWarming?.();
        await sleep(500 * 2 ** cold++);
        continue;
      }
      // A session that expired while idle restarts too. Nothing ran on a 409,
      // and the controller's own failures never reach the browser as 409.
      if (response.status !== 409 || attempt >= 20) return response;
      await sleep(250);
    }
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
      result = await readJson(response);
    if (!response.ok || !result.ok)
      throw failure(response, result, "Operation failed", auth);
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
          )
            throw failure(
              response,
              await readJson(response),
              "Observer could not connect",
              auth,
            );
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
                event.status !== "running"
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
          await sleep(250 * 2 ** reconnects);
        }
      }
    } finally {
      observers.delete(controller);
      signal?.removeEventListener("abort", abort);
    }
  }
  return { rpc, watch, pending };
}
