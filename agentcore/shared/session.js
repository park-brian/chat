import { createSignal } from "solid-js";
import { baseUrl, safeDestination } from "./navigation.js";

export function parseDeployment(input) {
  try {
    const raw =
      typeof input === "string"
        ? input.trim().startsWith("{")
          ? JSON.parse(input)
          : Object.fromEntries(new URL(input).searchParams)
        : input;
    const { region, stack, pool, client, scope } = raw,
      domain = new URL(raw.domain),
      runtime = raw.runtime;
    if (
      !/^[a-z]{2}-[a-z]+-\d$/.test(region) ||
      !/^[\w-]+$/.test(stack) ||
      !pool?.startsWith(region + "_") ||
      !/^[\w-]+$/.test(client) ||
      !/^[\w/-]+$/.test(scope) ||
      domain.protocol !== "https:" ||
      !domain.hostname.endsWith(`.auth.${region}.amazoncognito.com`) ||
      domain.username ||
      domain.password ||
      domain.port ||
      !new RegExp(
        `^arn:aws:bedrock-agentcore:${region}:[0-9]{12}:runtime/[A-Za-z0-9_-]+$`,
      ).test(runtime || "")
    )
      return null;
    return {
      region,
      stack,
      pool,
      client,
      scope,
      domain: domain.origin,
      runtime,
    };
  } catch {
    return null;
  }
}
const read = (key) => {
  try {
    return JSON.parse(sessionStorage.getItem(key));
  } catch {
    return null;
  }
};
const jwt = (token) =>
  JSON.parse(
    atob(token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/")),
  );
const random = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
const storageKey = (config) =>
  `agentcore:session:${config.runtime}:${config.client}`;

export function createSession() {
  const query = new URL(location.href).searchParams;
  const initial =
    parseDeployment(
      query.has("region")
        ? Object.fromEntries(query)
        : read("agentcore:deployment"),
    ) || parseDeployment(history.state?.deployment);
  const [deployment, setDeployment] = createSignal(initial),
    [session, setSession] = createSignal(null);
  let state = initial ? read(storageKey(initial)) : null,
    refreshing,
    channel;
  const save = () => {
    const config = deployment();
    if (!config) return;
    sessionStorage.setItem("agentcore:deployment", JSON.stringify(config));
    if (state)
      sessionStorage.setItem(storageKey(config), JSON.stringify(state));
    else sessionStorage.removeItem(storageKey(config));
  };
  function clear(broadcast = true) {
    state = null;
    setSession(null);
    save();
    if (broadcast) channel?.postMessage({ type: "signout" });
    window.dispatchEvent(new Event("agentcore:signout"));
  }
  function select(config) {
    channel?.close();
    setDeployment(config);
    state = read(storageKey(config));
    save();
    channel =
      typeof BroadcastChannel === "function"
        ? new BroadcastChannel(storageKey(config))
        : null;
    if (channel)
      channel.onmessage = (event) => {
        if (event.data?.type === "signout") clear(false);
      };
  }
  if (initial) {
    select(initial);
    if (query.has("region")) {
      const url = new URL(location.href);
      for (const name of [
        "region",
        "stack",
        "pool",
        "client",
        "scope",
        "domain",
        "runtime",
      ])
        url.searchParams.delete(name);
      history.replaceState({ deployment: initial }, "", url);
    }
  }
  function validateAccess(token, config) {
    const claims = jwt(token);
    if (
      claims.iss !==
        `https://cognito-idp.${config.region}.amazonaws.com/${config.pool}` ||
      claims.client_id !== config.client ||
      claims.token_use !== "access" ||
      !claims.scope?.split(" ").includes(config.scope) ||
      claims.exp * 1000 <= Date.now()
    )
      throw Error("Session did not match this deployment. Sign in again.");
    return claims;
  }
  async function accessToken() {
    const config = deployment();
    if (!state?.tokens?.access_token || !config)
      throw Error("Sign in to continue.");
    if (jwt(state.tokens.access_token).exp * 1000 > Date.now() + 60000) {
      validateAccess(state.tokens.access_token, config);
      return state.tokens.access_token;
    }
    refreshing ||= (async () => {
      if (!state.tokens.refresh_token)
        throw Error("Session expired. Sign in again.");
      const response = await fetch(new URL("/oauth2/token", config.domain), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: config.client,
          refresh_token: state.tokens.refresh_token,
        }),
      });
      if (!response.ok) throw Error("Session expired. Sign in again.");
      const next = await response.json();
      validateAccess(next.access_token, config);
      state.tokens = { ...state.tokens, ...next };
      save();
      return state.tokens.access_token;
    })()
      .catch((error) => {
        clear();
        throw error;
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }
  async function beginLogin(config = deployment()) {
    if (!config) throw Error("Connect a deployment first.");
    select(config);
    const verifier = random(),
      state = random(),
      nonce = random();
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
    const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    sessionStorage.setItem(
      "agentcore:callback",
      JSON.stringify({
        config,
        verifier,
        state,
        nonce,
        destination: safeDestination(location.href),
        redirectUri: baseUrl.href,
        createdAt: Date.now(),
      }),
    );
    const url = new URL("/oauth2/authorize", config.domain);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: config.client,
      redirect_uri: baseUrl.href,
      scope: "openid email profile " + config.scope,
      code_challenge_method: "S256",
      code_challenge: challenge,
      state,
      nonce,
    });
    location.assign(url.href);
  }
  async function finishLogin() {
    if (!query.has("code") && !query.has("error")) return false;
    const pending = read("agentcore:callback");
    sessionStorage.removeItem("agentcore:callback");
    history.replaceState(history.state, "", baseUrl.href);
    const config = parseDeployment(pending?.config);
    if (query.has("error"))
      throw Error("Sign-in was not completed. Try signing in again.");
    if (
      !config ||
      !query.get("code") ||
      query.get("state") !== pending.state ||
      Date.now() - pending.createdAt > 600000 ||
      pending.redirectUri !== baseUrl.href
    )
      throw Error("Login callback expired or did not match this tab.");
    const destination = safeDestination(pending.destination);
    select(config);
    const response = await fetch(new URL("/oauth2/token", config.domain), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.client,
        redirect_uri: baseUrl.href,
        code: query.get("code"),
        code_verifier: pending.verifier,
      }),
    });
    if (!response.ok) throw Error("Cognito rejected the authorization code.");
    const tokens = await response.json(),
      id = jwt(tokens.id_token);
    validateAccess(tokens.access_token, config);
    if (
      id.nonce !== pending.nonce ||
      id.iss !==
        `https://cognito-idp.${config.region}.amazonaws.com/${config.pool}` ||
      id.aud !== config.client ||
      id.token_use !== "id" ||
      id.exp * 1000 <= Date.now()
    )
      throw Error("Cognito token claims did not match this deployment.");
    state = { tokens, runtimeSessionId: crypto.randomUUID() };
    save();
    if (destination !== baseUrl.href) {
      location.replace(destination);
      return true;
    }
    return false;
  }
  async function signOut() {
    const config = deployment();
    clear();
    if (!config) return;
    const url = new URL("/logout", config.domain);
    url.search = new URLSearchParams({
      client_id: config.client,
      logout_uri: baseUrl.href,
    });
    location.assign(url.href);
  }
  return {
    deployment,
    session,
    setSession,
    accessToken,
    beginLogin,
    finishLogin,
    signOut,
    clear,
    hasTokens: () => Boolean(state?.tokens?.access_token),
    // Display-only identity from tokens this tab already holds; session.get stays authoritative.
    claims: () => {
      try {
        const access = jwt(state.tokens.access_token),
          id = state.tokens.id_token ? jwt(state.tokens.id_token) : {};
        return {
          email: id.email || "",
          role: access["cognito:groups"]?.[0] || null,
        };
      } catch {
        return null;
      }
    },
    runtimeSessionId: () => state?.runtimeSessionId,
    resetRuntimeSession: () => { state.runtimeSessionId = crypto.randomUUID(); save(); },
    dispose: () => channel?.close(),
  };
}
