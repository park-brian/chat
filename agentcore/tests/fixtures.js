export async function createLiveFixture({
  stackName,
  profile,
  region,
  role = "Administrators",
}) {
  if (!["Administrators", "Members", "Auditors"].includes(role))
    throw Error("Invalid disposable fixture role");
  const [
    { fromIni },
    cloudformation,
    cognito,
    dynamodb,
    memoryApi,
    s3Api,
    { randomUUID, randomBytes },
  ] = await Promise.all([
    import("@aws-sdk/credential-providers"),
    import("@aws-sdk/client-cloudformation"),
    import("@aws-sdk/client-cognito-identity-provider"),
    import("@aws-sdk/client-dynamodb"),
    import("@aws-sdk/client-bedrock-agentcore"),
    import("@aws-sdk/client-s3"),
    import("node:crypto"),
  ]);
  const credentials = profile ? fromIni({ profile }) : undefined;
  const cf = new cloudformation.CloudFormationClient({ region, credentials });
  const idp = new cognito.CognitoIdentityProviderClient({
    region,
    credentials,
  });
  const db = new dynamodb.DynamoDBClient({ region, credentials });
  const memory = new memoryApi.BedrockAgentCoreClient({ region, credentials });
  const s3 = new s3Api.S3Client({ region, credentials });
  const result = await cf.send(
    new cloudformation.DescribeStacksCommand({ StackName: stackName }),
  );
  const stack = result.Stacks?.[0];
  if (!["CREATE_COMPLETE", "UPDATE_COMPLETE"].includes(stack?.StackStatus))
    throw new Error("Live stack must be stable");
  const outputs = Object.fromEntries(
    stack.Outputs.map(({ OutputKey, OutputValue }) => [OutputKey, OutputValue]),
  );
  const parameters = Object.fromEntries(
    stack.Parameters.map(({ ParameterKey, ParameterValue }) => [
      ParameterKey,
      ParameterValue,
    ]),
  );
  const email = "smoke-" + randomUUID().slice(0, 12) + "@example.com";
  const password = "A1!" + randomBytes(22).toString("base64url");
  const pool = outputs.UserPoolId;
  const entry = new URL(outputs.ApplicationEntryUrl);
  const local = new URL(
    parameters.LocalUrl || "http://localhost:8000/agentcore/",
  );
  entry.protocol = local.protocol;
  entry.host = local.host;
  entry.pathname = local.pathname;
  let created = false;
  let sub;
  const chatSessions = new Map();
  const runtimeSessions = new Set();
  let stoppedRuntimeSessions = 0;
  let runtimeStopToken;
  const stopRuntimeSession = async (runtimeSessionId) => {
    if (!runtimeStopToken) throw new Error("Benchmark OAuth token missing");
    const url = `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/${encodeURIComponent(outputs.ControllerArn)}/stopruntimesession?qualifier=DEFAULT`;
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: "Bearer " + runtimeStopToken,
          "content-type": "application/json",
          "x-amzn-bedrock-agentcore-runtime-session-id": runtimeSessionId,
        },
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok || response.status === 404) {
        runtimeSessions.delete(runtimeSessionId);
        stoppedRuntimeSessions++;
        return;
      }
      if (response.status === 409 && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
        continue;
      }
      throw new Error(
        "StopRuntimeSession HTTP " +
          response.status +
          " " +
          (response.headers.get("x-amzn-errortype") || response.statusText),
      );
    }
  };
  const cleanup = async () => {
    const stopFailures = [];
    for (const id of runtimeSessions)
      try {
        await stopRuntimeSession(id);
      } catch (error) {
        stopFailures.push(`${id}: ${error.message}`);
      }
    if (sub) {
      for (const { projectId, memorySessionIds } of chatSessions.values()) {
        for (const sessionId of memorySessionIds) {
          const scope = {
            memoryId: outputs.MemoryArn,
            actorId: `${sub}/${projectId}`,
            sessionId,
          };
          let nextToken;
          do {
            const page = await memory.send(
              new memoryApi.ListEventsCommand({
                ...scope,
                maxResults: 100,
                nextToken,
              }),
            );
            for (const event of page.events || [])
              await memory.send(
                new memoryApi.DeleteEventCommand({
                  ...scope,
                  eventId: event.eventId,
                }),
              );
            nextToken = page.nextToken;
          } while (nextToken);
        }
      }
      for (const prefix of [`users/${sub}/`, `pending/${sub}/`]) {
        let KeyMarker, VersionIdMarker;
        do {
          const page = await s3.send(
            new s3Api.ListObjectVersionsCommand({
              Bucket: outputs.SharedBucket,
              Prefix: prefix,
              KeyMarker,
              VersionIdMarker,
            }),
          );
          for (const object of [
            ...(page.Versions || []),
            ...(page.DeleteMarkers || []),
          ])
            await s3.send(
              new s3Api.DeleteObjectCommand({
                Bucket: outputs.SharedBucket,
                Key: object.Key,
                VersionId: object.VersionId,
              }),
            );
          KeyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
          VersionIdMarker = page.IsTruncated
            ? page.NextVersionIdMarker
            : undefined;
        } while (KeyMarker);
      }
      const projectRows = await db.send(
        new dynamodb.QueryCommand({
          TableName: outputs.DataTable,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: {
            ":pk": { S: `USER#${sub}` },
            ":prefix": { S: "PROJECT#" },
          },
          ConsistentRead: true,
        }),
      );
      const projectIds = [
        "main",
        ...(projectRows.Items || []).map((item) => item.id.S),
      ];
      for (const pk of [
        `USER#${sub}`,
        ...projectIds.map((id) => `PROJECT#${sub}/${id}`),
      ]) {
        let nextToken;
        do {
          const page = await db.send(
            new dynamodb.QueryCommand({
              TableName: outputs.DataTable,
              KeyConditionExpression: "pk = :pk",
              ExpressionAttributeValues: { ":pk": { S: pk } },
              ExclusiveStartKey: nextToken,
            }),
          );
          for (const item of page.Items || [])
            await db.send(
              new dynamodb.DeleteItemCommand({
                TableName: outputs.DataTable,
                Key: { pk: item.pk, sk: item.sk },
              }),
            );
          nextToken = page.LastEvaluatedKey;
        } while (nextToken);
      }
      const owner = await db.send(
        new dynamodb.GetItemCommand({
          TableName: outputs.DataTable,
          Key: { pk: { S: "ACCOUNT#CONTROL" }, sk: { S: "OWNER" } },
          ConsistentRead: true,
        }),
      );
      if (owner.Item?.ownerSub?.S === sub)
        await db.send(
          new dynamodb.DeleteItemCommand({
            TableName: outputs.DataTable,
            Key: { pk: { S: "ACCOUNT#CONTROL" }, sk: { S: "OWNER" } },
            ConditionExpression: "ownerSub = :sub",
            ExpressionAttributeValues: { ":sub": { S: sub } },
          }),
        );
    }
    if (created) {
      await idp.send(
        new cognito.AdminDeleteUserCommand({
          UserPoolId: pool,
          Username: email,
        }),
      );
      created = false;
    }
    if (stoppedRuntimeSessions)
      console.log(
        "BENCHMARK_CLEANUP " +
          JSON.stringify({
            stopped: stoppedRuntimeSessions,
            remaining: runtimeSessions.size,
          }),
      );
    if (stopFailures.length)
      throw new Error(
        "Could not stop benchmark Runtime sessions: " + stopFailures.join("; "),
      );
  };
  try {
    const createdUser = await idp.send(
      new cognito.AdminCreateUserCommand({
        UserPoolId: pool,
        Username: email,
        MessageAction: "SUPPRESS",
        UserAttributes: [
          { Name: "email", Value: email },
          { Name: "email_verified", Value: "true" },
        ],
      }),
    );
    created = true;
    sub = createdUser.User?.Attributes?.find(
      (attribute) => attribute.Name === "sub",
    )?.Value;
    await idp.send(
      new cognito.AdminSetUserPasswordCommand({
        UserPoolId: pool,
        Username: email,
        Password: password,
        Permanent: true,
      }),
    );
    await idp.send(
      new cognito.AdminAddUserToGroupCommand({
        UserPoolId: pool,
        Username: email,
        GroupName: role,
      }),
    );
  } catch (error) {
    await cleanup();
    throw error;
  }
  const readUserControl = async () =>
    (
      await db.send(
        new dynamodb.GetItemCommand({
          TableName: outputs.DataTable,
          Key: { pk: { S: "USER#" + sub }, sk: { S: "CONTROL" } },
          ConsistentRead: true,
        }),
      )
    ).Item;
  const controllerUrl = outputs.ControllerArn
    ? `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/${encodeURIComponent(outputs.ControllerArn)}/invocations?qualifier=DEFAULT`
    : null;
  return {
    sub,
    outputs,
    entryUrl: entry.href,
    publicEntryUrl: outputs.ApplicationEntryUrl,
    email,
    password,
    cleanup,
    setEnabled: (enabled) =>
      idp.send(
        new (enabled
          ? cognito.AdminEnableUserCommand
          : cognito.AdminDisableUserCommand)({
          UserPoolId: pool,
          Username: sub,
        }),
      ),
    putLegacyConnection: async (connection) =>
      db.send(
        new dynamodb.PutItemCommand({
          TableName: outputs.DataTable,
          Item: {
            pk: { S: `USER#${sub}` },
            sk: { S: "CREDENTIALS" },
            revision: { N: "7" },
            connectionsJson: {
              S: JSON.stringify({ [connection.id]: connection }),
            },
          },
        }),
      ),
    readOwnedRecords: async () =>
      (
        await db.send(
          new dynamodb.QueryCommand({
            TableName: outputs.DataTable,
            KeyConditionExpression: "pk = :pk",
            ExpressionAttributeValues: { ":pk": { S: `USER#${sub}` } },
            ConsistentRead: true,
          }),
        )
      ).Items,
    readUserControl,
    controllerUrl,
    hasGemini: Boolean(outputs.GeminiCredentialArn),
    hasScriptedModel: parameters.EnableScriptedModel === "true",
    trackRuntimeSession: (id) => runtimeSessions.add(id),
    setRuntimeStopToken: (token) => {
      runtimeStopToken = token;
    },
    stopRuntimeSession,
    createPeer: (peerRole = "Members") =>
      createLiveFixture({
        stackName,
        profile,
        region,
        role: peerRole,
      }),
    trackChat: (agentId, sessionId, projectId = "main", rootlessBranchId) => {
      const key = `${projectId}/${sessionId}`;
      const memorySessionId = `a_${agentId}_${sessionId}`;
      const state = chatSessions.get(key) || {
        projectId,
        memorySessionIds: new Set([memorySessionId]),
      };
      if (rootlessBranchId)
        state.memorySessionIds.add(`a_${agentId}_b_${rootlessBranchId}`);
      chatSessions.set(key, state);
    },
    readAgent: async (agentId) =>
      (
        await db.send(
          new dynamodb.GetItemCommand({
            TableName: outputs.DataTable,
            Key: {
              pk: { S: `PROJECT#${sub}/main` },
              sk: { S: `AGENT#${agentId}` },
            },
            ConsistentRead: true,
          }),
        )
      ).Item,
    readChat: async (agentId, sessionId) =>
      memory.send(
        new memoryApi.ListEventsCommand({
          memoryId: outputs.MemoryArn,
          actorId: `${sub}/main`,
          sessionId: `a_${agentId}_${sessionId}`,
          includePayloads: true,
        }),
      ),
    deleteChatMemory: async (agentId, sessionId) => {
      const scope = {
        memoryId: outputs.MemoryArn,
        actorId: `${sub}/main`,
        sessionId: `a_${agentId}_${sessionId}`,
      };
      const events = await memory.send(
        new memoryApi.ListEventsCommand({
          ...scope,
          maxResults: 100,
        }),
      );
      for (const event of events.events || [])
        await memory.send(
          new memoryApi.DeleteEventCommand({
            ...scope,
            eventId: event.eventId,
          }),
        );
      return (events.events || []).length;
    },
    readUsage: async () =>
      db.send(
        new dynamodb.QueryCommand({
          TableName: outputs.DataTable,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :usage)",
          ExpressionAttributeValues: {
            ":pk": { S: `USER#${sub}` },
            ":usage": { S: "USAGE#" },
          },
          ConsistentRead: true,
        }),
      ),
  };
}
