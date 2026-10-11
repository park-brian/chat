// Protocol regressions retained from the pre-pages live stories.
export async function runRegression(
  page,
  fixture,
  { story, accessToken, runtimeSessionId },
) {
  if (story === "runtime-roadmap") {
    if (!fixture.hasScriptedModel)
      throw new Error("runtime-roadmap requires scripted inference");
    const setup = await page.evaluate(
      async ({ url, token }) => {
        const headers = {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "x-amzn-bedrock-agentcore-runtime-session-id":
            "roadmap-" + crypto.randomUUID(),
        };
        const call = async (command, input) =>
          await (
            await fetch(url, {
              method: "POST",
              headers,
              body: JSON.stringify({ v: 1, command, input }),
            })
          ).json();
        const send = async (input) => {
          const response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
              v: 1,
              command: "chat.send",
              input: { ...input, requestId: crypto.randomUUID() },
            }),
          });
          const events = (await response.text())
            .split("\n\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => JSON.parse(line.slice(6)));
          return {
            done: events.find((event) => event.type === "message.done"),
            error: events.find((event) => event.type === "error"),
          };
        };
        const agent = await call("agents.put", {
          name: "Durable smoke",
          modelId: "test.echo",
        });
        if (!agent.ok) return { agent };
        const agentId = agent.data.id,
          conversationId = crypto.randomUUID();
        const first = await send({
          agentId,
          conversationId,
          message: "first archive",
          expectedHeadTurnId: null,
        });
        if (!first.done) return { agentId, conversationId, agent, first };
        const second = await send({
          agentId,
          conversationId,
          message: "history?",
          expectedHeadTurnId: first.done.turnId,
        });
        const usage = await call("usage.get", {
          range: "30d",
          includeDaily: true,
        });
        const detail = await call("usage.request", {
          requestId: first.done.requestId,
        });
        const filtered = await call("usage.list", {
          range: "30d",
          requestId: first.done.requestId,
          quality: "estimated",
          status: "completed",
        });
        const people = await call("users.list", {});
        const credential = await call("credentials.put", {
          name: "Private smoke credential",
          kind: "github",
          secret: "disposable-" + crypto.randomUUID(),
        });
        const connection = await call("connections.put", {
          projectId: "main",
          name: "Private smoke credential",
          kind: "github",
          credentialId: credential.data.id,
        });
        const session = await call("session.get", {});
        const protectedRole = await call("users.setRole", {
          sub: session.data.user.sub,
          role: "Members",
        });
        return {
          agentId,
          conversationId,
          agent,
          first,
          second,
          usage,
          detail,
          filtered,
          people,
          connection,
          protectedRole,
          session,
        };
      },
      { url: fixture.controllerUrl, token: accessToken },
    );
    if (
      !setup.first?.done ||
      !setup.second?.done ||
      setup.session?.data?.user?.storageUsedBytes <= 0 ||
      setup.usage?.data?.items?.filter((item) => item.kind === "model")
        .length !== 2 ||
      setup.usage?.data?.daily?.items?.length !== 1 ||
      setup.detail?.data?.steps?.length !== 1 ||
      setup.filtered?.data?.items?.length !== 1 ||
      setup.people?.data?.items?.length !== 1 ||
      !setup.connection?.data?.id ||
      setup.protectedRole?.error?.code !== "PROTECTED_ADMIN"
    )
      throw new Error(
        "Durable admission/metering failed: " +
          JSON.stringify(setup).slice(0, 1800),
      );
    let peer, peerContext;
    try {
      peer = await fixture.createPeer("Members");
      peerContext = await page.context().browser().newContext();
      const peerPage = await peerContext.newPage();
      await peerPage.goto(peer.entryUrl);
      const peerTokenResponse = peerPage.waitForResponse((response) =>
        response.url().includes("/oauth2/token"),
      );
      peerPage.on("request", (request) => {
        if (request.url() === peer.controllerUrl) {
          const id =
            request.headers()["x-amzn-bedrock-agentcore-runtime-session-id"];
          if (id) peer.trackRuntimeSession(id);
        }
      });
      await peerPage
        .getByRole("button", { name: "Sign in", exact: true })
        .click();
      await peerPage.locator('input[type="password"]').waitFor();
      await peerPage
        .locator('input[type="email"], input[name="username"]')
        .first()
        .fill(peer.email);
      await peerPage
        .locator('input[type="password"]')
        .first()
        .fill(peer.password);
      await peerPage
        .locator('button[type="submit"], input[type="submit"]')
        .first()
        .click();
      await peerPage
        .locator('[data-app-state="ready"]')
        .waitFor({ timeout: 45000 });
      const peerToken = (await (await peerTokenResponse).json()).access_token;
      peer.setRuntimeStopToken(peerToken);
      const denied = await peerPage.evaluate(
        async ({
          url,
          token,
          agentId,
          conversationId,
          ownerSub,
          requestId,
          connectionId,
        }) => {
          const call = async (command, input) =>
            await (
              await fetch(url, {
                method: "POST",
                headers: {
                  authorization: "Bearer " + token,
                  "content-type": "application/json",
                  "x-amzn-bedrock-agentcore-runtime-session-id":
                    "peer-" + crypto.randomUUID(),
                },
                body: JSON.stringify({ v: 1, command, input }),
              })
            ).json();
          return {
            conversation: await call("conversations.get", {
              agentId,
              conversationId: conversationId,
            }),
            usage: await call("usage.request", {
              userSub: ownerSub,
              requestId,
            }),
            users: await call("users.list", {}),
            agents: await call("agents.list", {}),
            connection: await call("connections.test", {
              projectId: "main",
              id: connectionId,
            }),
          };
        },
        {
          url: fixture.controllerUrl,
          token: peerToken,
          agentId: setup.agentId,
          conversationId: setup.conversationId,
          ownerSub: setup.session.data.user.sub,
          requestId: setup.first.done.requestId,
          connectionId: setup.connection.data.id,
        },
      );
      if (
        denied.conversation?.error?.code !== "NOT_FOUND" ||
        denied.usage?.error?.code !== "FORBIDDEN" ||
        denied.users?.error?.code !== "FORBIDDEN" ||
        denied.agents?.data?.items?.length ||
        denied.connection?.error?.code !== "NOT_FOUND"
      )
        throw new Error("Cross-user denial failed: " + JSON.stringify(denied));
    } finally {
      await peerContext?.close();
      await peer?.cleanup();
    }
    const continued = await page.evaluate(
      async ({ url, token, agentId, conversationId, headTurnId, sub }) => {
        const headers = {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "x-amzn-bedrock-agentcore-runtime-session-id":
            "roadmap-" + crypto.randomUUID(),
        };
        const call = async (command, input) =>
          await (
            await fetch(url, {
              method: "POST",
              headers,
              body: JSON.stringify({ v: 1, command, input }),
            })
          ).json();
        const reopened = await call("conversations.get", {
          agentId,
          conversationId: conversationId,
        });
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            v: 1,
            command: "chat.send",
            input: {
              agentId,
              conversationId,
              requestId: crypto.randomUUID(),
              message: "history?",
              expectedHeadTurnId: headTurnId,
            },
          }),
        });
        const events = (await response.text())
          .split("\n\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)));
        const third = {
          done: events.find((event) => event.type === "message.done"),
          error: events.find((event) => event.type === "error"),
        };
        const after = await call("conversations.get", {
          agentId,
          conversationId: conversationId,
        });
        const archived = await call("agents.setArchived", {
          id: agentId,
          revision: 0,
          archived: true,
        });
        const deniedResponse = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            v: 1,
            command: "chat.send",
            input: {
              agentId,
              conversationId,
              requestId: crypto.randomUUID(),
              message: "blocked",
            },
          }),
        });
        const denied = await deniedResponse.text();
        const restored = await call("agents.setArchived", {
          id: agentId,
          revision: 1,
          archived: false,
        });
        const failedRequestId = crypto.randomUUID();
        const failedResponse = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            v: 1,
            command: "chat.send",
            input: {
              agentId,
              conversationId: crypto.randomUUID(),
              requestId: failedRequestId,
              message: "scripted-error",
            },
          }),
        });
        const failed = await failedResponse.text();
        const failedDetail = await call("usage.request", {
          requestId: failedRequestId,
        });
        const limits = await call("users.setLimits", {
          sub,
          budgetMicroUsd: null,
          storageBytes: 0,
          period: "weekly",
        });
        const quotaResponse = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            v: 1,
            command: "chat.send",
            input: {
              agentId,
              conversationId: crypto.randomUUID(),
              requestId: crypto.randomUUID(),
              message: "new",
            },
          }),
        });
        const quota = await quotaResponse.text();
        const reset = await call("users.startNewBudgetPeriod", { sub });
        const summary = await call("usage.summary", {});
        const inherit = await call("users.setLimits", {
          sub,
          budgetMicroUsd: null,
          storageBytes: null,
          period: null,
        });
        let deleted;
        for (let attempt = 0; attempt < 10; attempt++) {
          deleted = await call("conversations.delete", {
            agentId,
            conversationId: conversationId,
          });
          if (deleted.data?.deleted) break;
        }
        const afterDelete = await call("session.get", {});
        const missing = await call("conversations.get", {
          agentId,
          conversationId: conversationId,
        });
        const duplicateDelete = await call("conversations.delete", {
          agentId,
          conversationId: conversationId,
        });
        return {
          reopened,
          third,
          after,
          archived,
          denied,
          restored,
          failed,
          failedDetail,
          limits,
          quota,
          reset,
          summary,
          inherit,
          deleted,
          afterDelete,
          missing,
          duplicateDelete,
        };
      },
      {
        url: fixture.controllerUrl,
        token: accessToken,
        agentId: setup.agentId,
        conversationId: setup.conversationId,
        headTurnId: setup.second.done.turnId,
        sub: setup.session.data.user.sub,
      },
    );
    if (
      continued.reopened?.data?.messages?.length !== 4 ||
      !continued.third?.done ||
      continued.after?.data?.messages?.length !== 6 ||
      !continued.archived?.ok ||
      !continued.restored?.ok ||
      !continued.denied?.includes("AGENT_ARCHIVED") ||
      !continued.failed?.includes('"type":"error"') ||
      continued.failedDetail?.data?.request?.status !== "failed" ||
      continued.failedDetail?.data?.steps?.length !== 1 ||
      !continued.quota?.includes("STORAGE_EXHAUSTED") ||
      !continued.limits?.ok ||
      !continued.reset?.ok ||
      !continued.summary?.data?.period?.includes("#E1") ||
      !continued.inherit?.ok ||
      !continued.deleted?.data?.deleted ||
      continued.afterDelete?.data?.user?.storageUsedBytes !== 0 ||
      continued.missing?.error?.code !== "NOT_FOUND" ||
      !continued.duplicateDelete?.data?.deleted
    )
      throw new Error(
        "Durable reopen/reset/archive failed: " +
          JSON.stringify(continued).slice(0, 1800),
      );
    return;
  }
  if (story === "runtime-foundation") {
    if (!fixture.hasScriptedModel)
      throw new Error("runtime-foundation requires scripted inference");
    const result = await page.evaluate(
      async ({ url, token }) => {
        const headers = {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "x-amzn-bedrock-agentcore-runtime-session-id":
            "foundation-" + crypto.randomUUID(),
        };
        const call = async (command, input) => {
          const response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ v: 1, command, input }),
          });
          return response.json();
        };
        const send = async (input) => {
          const response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
              v: 1,
              command: "chat.send",
              input: {
                ...input,
                requestId: crypto.randomUUID(),
              },
            }),
          });
          const raw = await response.text();
          const events = raw.split("\n\n").flatMap((chunk) => {
            const line = chunk
              .split("\n")
              .find((part) => part.startsWith("data:"));
            return line ? [JSON.parse(line.slice(5))] : [];
          });
          return {
            done: events.find((event) => event.type === "message.done"),
            error: events.find((event) => event.type === "error"),
            events,
          };
        };
        const alpha = await call("projects.create", {
          id: "alpha",
          name: "Alpha",
        });
        const beta = await call("projects.create", {
          id: "beta",
          name: "Beta",
        });
        const agent = await call("agents.put", {
          projectId: "alpha",
          name: "Foundation smoke",
          modelId: "test.echo",
        });
        if (!alpha.ok || !beta.ok || !agent.ok) return { alpha, beta, agent };
        const agentId = agent.data.id,
          conversationId = crypto.randomUUID();
        const base = { projectId: "alpha", agentId, conversationId };
        const isolated = await call("agents.list", { projectId: "beta" });
        const first = await send({
          ...base,
          message: "first",
          branchId: "main",
          expectedHeadTurnId: null,
        });
        if (!first.done)
          return { alpha, beta, agent, isolated, first, agentId, conversationId };
        const second = await send({
          ...base,
          message: "history?",
          branchId: "main",
          expectedHeadTurnId: first.done.turnId,
        });
        if (!second.done)
          return {
            alpha,
            beta,
            agent,
            isolated,
            first,
            second,
            agentId,
            conversationId,
          };
        const alternativeId = crypto.randomUUID();
        const alternate = await send({
          ...base,
          message: "edited second",
          branchId: alternativeId,
          forkTurnId: first.done.turnId,
        });
        if (!alternate.done)
          return {
            alpha,
            beta,
            agent,
            isolated,
            first,
            second,
            alternate,
            agentId,
            conversationId,
          };
        const nestedId = crypto.randomUUID();
        const nested = await send({
          ...base,
          message: "history?",
          branchId: nestedId,
          forkTurnId: alternate.done.turnId,
        });
        const firstEditId = crypto.randomUUID();
        const firstEdit = await send({
          ...base,
          message: "rewritten first",
          branchId: firstEditId,
          forkTurnId: null,
        });
        if (!firstEdit.done) return { firstEdit, agentId, conversationId };
        const firstEditChildId = crypto.randomUUID();
        const firstEditChild = await send({
          ...base,
          message: "history?",
          branchId: firstEditChildId,
          forkTurnId: firstEdit.done.turnId,
        });
        const firstEditReopened = await call("conversations.get", {
          projectId: "alpha",
          agentId,
          conversationId: conversationId,
          branchId: firstEditChildId,
        });
        const reopened = await call("conversations.get", {
          projectId: "alpha",
          agentId,
          conversationId: conversationId,
          branchId: nestedId,
        });
        const main = await call("conversations.get", {
          projectId: "alpha",
          agentId,
          conversationId: conversationId,
          branchId: "main",
        });
        const denied = await call("conversations.get", {
          projectId: "beta",
          agentId,
          conversationId: conversationId,
        });
        const stale = await send({
          ...base,
          message: "stale",
          branchId: alternativeId,
          expectedHeadTurnId: first.done.turnId,
        });
        const self = await call("session.get", {});
        const archiveUsed = self.data.user.storageUsedBytes;
        const limits = await call("users.setLimits", {
          sub: self.data.user.sub,
          budgetMicroUsd: null,
          storageBytes: archiveUsed + 5,
        });
        const begin = await call("objects.beginUpload", {
          projectId: "alpha",
          name: "skill.md",
          contentType: "text/plain",
          sizeBytes: 5,
          kind: "skill",
        });
        if (!begin.ok)
          return {
            alpha,
            beta,
            agent,
            isolated,
            first,
            second,
            alternate,
            nested,
            reopened,
            main,
            denied,
            stale,
            limits,
            begin,
            agentId,
            conversationId,
          };
        const fields = new FormData();
        for (const [name, value] of Object.entries(begin.data.upload.fields))
          fields.append(name, value);
        fields.append(
          "file",
          new Blob(["hello"], { type: "text/plain" }),
          "skill.md",
        );
        const posted = await fetch(begin.data.upload.url, {
          method: "POST",
          body: fields,
        });
        const completed = await call("objects.completeUpload", {
          projectId: "alpha",
          id: begin.data.id,
        });
        const listed = await call("objects.list", { projectId: "alpha" });
        const link = await call("objects.get", {
          projectId: "alpha",
          id: begin.data.id,
        });
        const content = link.ok
          ? await (await fetch(link.data.url)).text()
          : "";
        const quota = await call("objects.beginUpload", {
          projectId: "alpha",
          name: "over.txt",
          contentType: "text/plain",
          sizeBytes: 1,
        });
        const skillAgent = await call("agents.put", {
          projectId: "alpha",
          id: agentId,
          revision: 0,
          name: "Foundation smoke",
          modelId: "test.echo",
          skillIds: [begin.data.id],
        });
        await call("users.setLimits", {
          sub: self.data.user.sub,
          budgetMicroUsd: null,
          storageBytes: null,
        });
        const skilled = await send({
          ...base,
          message: "skill-loaded",
          branchId: "main",
          expectedHeadTurnId: second.done.turnId,
        });
        const deleted = await call("objects.delete", {
          projectId: "alpha",
          id: begin.data.id,
        });
        const afterDelete = await call("objects.list", {
          projectId: "alpha",
        });
        const unskilledAgent = await call("agents.put", {
          projectId: "alpha",
          id: agentId,
          revision: 1,
          name: "Foundation smoke",
          modelId: "test.echo",
          skillIds: [],
        });
        const zeroLimit = await call("users.setLimits", {
          sub: self.data.user.sub,
          budgetMicroUsd: null,
          storageBytes: 0,
        });
        const zeroSession = await call("session.get", {});
        const zeroDenied = await call("objects.beginUpload", {
          projectId: "alpha",
          name: "blocked.txt",
          contentType: "text/plain",
          sizeBytes: 1,
        });
        const inheritLimit = await call("users.setLimits", {
          sub: self.data.user.sub,
          budgetMicroUsd: null,
          storageBytes: null,
        });
        const inheritedSession = await call("session.get", {});
        const hidden = await call("projects.setHidden", {
          id: "alpha",
          hidden: true,
          revision: alpha.data.revision,
        });
        const hiddenAgents = await call("agents.list", {
          projectId: "alpha",
        });
        const projects = await call("projects.list", {});
        return {
          alpha,
          beta,
          agent,
          agentId,
          conversationId,
          isolated,
          first,
          second,
          alternate,
          nested,
          firstEdit,
          firstEditChild,
          firstEditReopened,
          reopened,
          main,
          denied,
          stale,
          limits,
          begin,
          archiveUsed,
          posted: posted.status,
          completed,
          listed,
          content,
          quota,
          skillAgent,
          skilled,
          deleted,
          afterDelete,
          unskilledAgent,
          zeroLimit,
          zeroSession,
          zeroDenied,
          inheritLimit,
          inheritedSession,
          hidden,
          hiddenAgents,
          projects,
        };
      },
      { url: fixture.controllerUrl, token: accessToken },
    );
    if (
      !result.alpha?.ok ||
      !result.beta?.ok ||
      !result.agent?.ok ||
      result.isolated?.data?.items?.length ||
      !result.first?.done ||
      !result.second?.done ||
      !result.alternate?.done ||
      !result.nested?.done ||
      !result.firstEdit?.done ||
      !result.firstEditChild?.done ||
      result.firstEditReopened?.data?.messages
        ?.map((item) => item.text)
        .join("|") !==
        "rewritten first|Echo: rewritten first|history?|History: rewritten first | history?" ||
      result.reopened?.data?.messages?.map((item) => item.text).join("|") !==
        "first|Echo: first|edited second|Echo: edited second|history?|History: first | edited second | history?" ||
      result.main?.data?.messages?.map((item) => item.text).join("|") !==
        "first|Echo: first|history?|History: first | history?" ||
      result.denied?.error?.code !== "NOT_FOUND" ||
      result.stale?.error?.code !== "BRANCH_CONFLICT" ||
      !result.limits?.ok ||
      result.posted !== 204 ||
      !result.completed?.ok ||
      result.listed?.data?.usedBytes !== result.archiveUsed + 5 ||
      result.content !== "hello" ||
      result.quota?.error?.code !== "QUOTA_EXCEEDED" ||
      !result.skillAgent?.ok ||
      !result.skilled?.done ||
      !result.deleted?.ok ||
      result.afterDelete?.data?.usedBytes <= result.archiveUsed ||
      !result.unskilledAgent?.ok ||
      !result.zeroLimit?.ok ||
      result.zeroSession?.data?.user?.storageBytes !== 0 ||
      result.zeroDenied?.error?.code !== "QUOTA_EXCEEDED" ||
      !result.inheritLimit?.ok ||
      result.inheritedSession?.data?.user?.storageBytes !== 5000000000 ||
      !result.hidden?.ok ||
      !result.hiddenAgents?.data?.items?.length ||
      !result.projects?.data?.items?.find((item) => item.id === "alpha")?.hidden
    )
      throw new Error(
        "Foundation live contract failed: " +
          JSON.stringify(result, (key, value) =>
            ["upload", "url", "fields"].includes(key) ? "[redacted]" : value,
          ).slice(0, 16000),
      );
    return;
  }
  if (story === "runtime-benchmark") {
    // Prove cleanup permission before opening the fresh-session arm.
    try {
      await fixture.stopRuntimeSession(runtimeSessionId);
    } catch (error) {
      throw new Error(
        "StopRuntimeSession preflight failed: " +
          error.name +
          ": " +
          error.message,
      );
    }
    const samples = await page.evaluate(
      async ({ runtimeUrl, token }) => {
        const stickyId = "bench-" + crypto.randomUUID();
        const samples = [];
        let previousEnd = null;
        const invoke = async (command, conversationId) => {
          const started = performance.now();
          const gapMs = previousEnd === null ? null : started - previousEnd;
          let headersMs, firstByteMs, status;
          try {
            const response = await fetch(runtimeUrl, {
              method: "POST",
              headers: {
                authorization: "Bearer " + token,
                "content-type": "application/json",
                "x-amzn-bedrock-agentcore-runtime-session-id": conversationId,
              },
              body: JSON.stringify({ v: 1, command, input: {} }),
            });
            status = response.status;
            headersMs = performance.now() - started;
            const reader = response.body?.getReader();
            if (!reader) throw Error("Response body missing");
            const first = await reader.read();
            firstByteMs = performance.now() - started;
            if (first.done) throw Error("Response body empty");
            const decoder = new TextDecoder();
            let body = decoder.decode(first.value, { stream: true });
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              body += decoder.decode(next.value, { stream: true });
            }
            body += decoder.decode();
            const completeMs = performance.now() - started;
            const payload = JSON.parse(body);
            if (!response.ok || !payload.ok)
              throw Error(
                command +
                  ": HTTP " +
                  status +
                  " " +
                  (payload.error?.code || "unknown"),
              );
            return { gapMs, headersMs, firstByteMs, completeMs, status };
          } catch (error) {
            return {
              gapMs,
              headersMs,
              firstByteMs,
              completeMs: performance.now() - started,
              status,
              error: String(error.message).slice(0, 160),
            };
          } finally {
            previousEnd = performance.now();
          }
        };
        const warm = await invoke("session.get", stickyId);
        if (warm.error) throw Error("Sticky warm-up failed: " + warm.error);
        for (const command of ["session.get", "workspace.get"])
          for (let pair = 0; pair < 10; pair++)
            for (const arm of pair % 2
              ? ["fresh", "sticky"]
              : ["sticky", "fresh"]) {
              const id =
                arm === "sticky" ? stickyId : "bench-" + crypto.randomUUID();
              samples.push({
                command,
                arm,
                pair,
                ...(await invoke(command, id)),
              });
            }
        return samples;
      },
      { runtimeUrl: fixture.controllerUrl, token: accessToken },
    );
    const rounded = samples.map((sample) =>
      Object.fromEntries(
        Object.entries(sample).map(([key, value]) => [
          key,
          typeof value === "number" && key.endsWith("Ms")
            ? Math.round(value * 10) / 10
            : value,
        ]),
      ),
    );
    const stats = (values) => {
      if (!values.length) return null;
      const sorted = [...values].sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      const median =
        sorted.length % 2
          ? sorted[middle]
          : (sorted[middle - 1] + sorted[middle]) / 2;
      return {
        medianMs: Math.round(median * 10) / 10,
        rangeMs: [
          Math.round(sorted[0] * 10) / 10,
          Math.round(sorted.at(-1) * 10) / 10,
        ],
      };
    };
    const summary = Object.fromEntries(
      ["session.get", "workspace.get"].map((command) => [
        command,
        Object.fromEntries(
          ["sticky", "fresh"].map((arm) => {
            const rows = samples.filter(
              (sample) =>
                sample.command === command &&
                sample.arm === arm &&
                !sample.error,
            );
            return [
              arm,
              {
                successful: rows.length,
                headers: stats(rows.map((row) => row.headersMs)),
                firstByte: stats(rows.map((row) => row.firstByteMs)),
                complete: stats(rows.map((row) => row.completeMs)),
              },
            ];
          }),
        ),
      ]),
    );
    const failures = rounded.filter((sample) => sample.error);
    console.log(
      "BENCHMARK_PAIRED " +
        JSON.stringify({
          origin: new URL(fixture.entryUrl).origin,
          samplesPerArm: 10,
          summary,
          failures,
          samples: rounded,
        }),
    );
    if (failures.length)
      throw new Error(failures.length + " paired Runtime samples failed");
    return;
  }
}
