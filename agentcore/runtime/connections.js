export function createConnections({
  projectIdOf,
  projectPattern,
  uuidPattern,
  project,
  invalid,
  missing,
  credentialStore,
}) {
  return async (body, identity) => {
    if (body.command === "connections.test") {
      const projectId = projectIdOf(body.input);
      if (
        !projectPattern.test(projectId) ||
        !uuidPattern.test(body.input.id || "")
      )
        return invalid();
      if (!(await project(identity, projectId))) return missing();
      if (identity.role === "Auditors")
        return {
          status: 403,
          data: { ok: false, error: { code: "FORBIDDEN" } },
        };
      const connection = (
        await credentialStore.resolve(identity, [body.input.id])
      )[body.input.id];
      if (!connection) return missing();
      const jira = connection.kind === "jira";
      const host = jira ? new URL(connection.jiraUrl) : null;
      // Never turn a user-supplied Jira URL into an authenticated SSRF probe.
      if (
        jira &&
        (host.protocol !== "https:" ||
          host.port ||
          !/^[a-z0-9-]+\.atlassian\.net$/i.test(host.hostname))
      )
        return {
          status: 400,
          data: { ok: false, error: { code: "CONNECTION_TEST_UNAVAILABLE" } },
        };
      const url = jira
        ? new URL("/rest/api/3/myself", host).href
        : "https://api.github.com/user";
      let checked;
      try {
        const result = await fetch(url, {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(8000),
          headers: {
            Accept: "application/json",
            Authorization: jira
              ? "Basic " +
                Buffer.from(
                  connection.jiraEmail + ":" + connection.apiKey,
                ).toString("base64")
              : "Bearer " + connection.apiKey,
            ...(!jira && { "User-Agent": "agentcore-chat-connection-check" }),
          },
        });
        const connected = result.status === 200;
        let account = null;
        if (connected) {
          const length = Number(result.headers.get("content-length") || 0);
          if (length > 16384) throw Error("Connection response too large");
          const raw = await result.text();
          if (raw.length > 16384) throw Error("Connection response too large");
          const data = JSON.parse(raw);
          const label = jira ? data.displayName : data.login;
          if (typeof label === "string") account = label.slice(0, 120);
        } else await result.body?.cancel();
        checked = { connected, account, httpStatus: result.status };
      } catch {
        checked = { connected: false, account: null, httpStatus: null };
      }
      return { status: 200, data: { ok: true, data: checked } };
    }
  };
}
