import { randomUUID } from "node:crypto";

// A disposable Cognito identity on a live stack. Everything the identity owns
// lives in its USER#sub partition and under its S3 prefixes, so cleanup removes
// exactly that, plus the account-owner record if this identity claimed it.
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
    s3Api,
    { randomUUID, randomBytes },
  ] = await Promise.all([
    import("@aws-sdk/credential-providers"),
    import("@aws-sdk/client-cloudformation"),
    import("@aws-sdk/client-cognito-identity-provider"),
    import("@aws-sdk/client-dynamodb"),
    import("@aws-sdk/client-s3"),
    import("node:crypto"),
  ]);
  const credentials = profile ? fromIni({ profile }) : undefined;
  const cf = new cloudformation.CloudFormationClient({ region, credentials });
  const idp = new cognito.CognitoIdentityProviderClient({ region, credentials });
  const db = new dynamodb.DynamoDBClient({ region, credentials });
  const s3 = new s3Api.S3Client({ region, credentials });
  const stack = (
    await cf.send(new cloudformation.DescribeStacksCommand({ StackName: stackName }))
  ).Stacks?.[0];
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
  const table = outputs.DataTable;
  const email = "smoke-" + randomUUID().slice(0, 12) + "@example.com";
  const password = "A1!" + randomBytes(22).toString("base64url");
  const pool = outputs.UserPoolId;
  const entry = new URL(outputs.ApplicationEntryUrl);
  const local = new URL(parameters.LocalUrl || "http://localhost:8000/agentcore/");
  entry.protocol = local.protocol;
  entry.host = local.host;
  entry.pathname = local.pathname;
  let created = false;
  let sub;
  const runtimeSessions = new Set();
  let stoppedRuntimeSessions = 0;
  let runtimeStopToken;

  // JWT-authorized Runtimes are stopped with the bearer endpoint; SigV4
  // StopRuntimeSession is rejected as an auth-method mismatch.
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
  const partition = async (prefix) => {
    const items = [];
    let start;
    do {
      const page = await db.send(
        new dynamodb.QueryCommand({
          TableName: table,
          KeyConditionExpression:
            "pk = :pk" + (prefix ? " AND begins_with(sk, :prefix)" : ""),
          ExpressionAttributeValues: {
            ":pk": { S: `USER#${sub}` },
            ...(prefix && { ":prefix": { S: prefix } }),
          },
          ConsistentRead: true,
          ExclusiveStartKey: start,
        }),
      );
      items.push(...(page.Items || []));
      start = page.LastEvaluatedKey;
    } while (start);
    return items;
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
      for (const prefix of [`users/${sub}/`, `pending/${sub}/`, `runs/${sub}/`]) {
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
          for (const object of [...(page.Versions || []), ...(page.DeleteMarkers || [])])
            await s3.send(
              new s3Api.DeleteObjectCommand({
                Bucket: outputs.SharedBucket,
                Key: object.Key,
                VersionId: object.VersionId,
              }),
            );
          KeyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
          VersionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
        } while (KeyMarker);
      }
      for (const item of await partition())
        await db.send(
          new dynamodb.DeleteItemCommand({
            TableName: table,
            Key: { pk: item.pk, sk: item.sk },
          }),
        );
      await db
        .send(
          new dynamodb.DeleteItemCommand({
            TableName: table,
            Key: { pk: { S: "ACCOUNT" }, sk: { S: "OWNER" } },
            ConditionExpression: "ownerSub = :sub",
            ExpressionAttributeValues: { ":sub": { S: sub } },
          }),
        )
        .catch((error) => {
          if (error.name !== "ConditionalCheckFailedException") throw error;
        });
    }
    if (created) {
      await idp.send(
        new cognito.AdminDeleteUserCommand({ UserPoolId: pool, Username: email }),
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
  const getItem = async (sk) =>
    (
      await db.send(
        new dynamodb.GetItemCommand({
          TableName: table,
          Key: { pk: { S: `USER#${sub}` }, sk: { S: sk } },
          ConsistentRead: true,
        }),
      )
    ).Item;
  return {
    sub,
    outputs,
    entryUrl: entry.href,
    publicEntryUrl: outputs.ApplicationEntryUrl,
    email,
    password,
    cleanup,
    controllerUrl: outputs.ControllerArn
      ? `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/${encodeURIComponent(outputs.ControllerArn)}/invocations?qualifier=DEFAULT`
      : null,
    hasGemini: Boolean(outputs.GeminiCredentialArn),
    hasScriptedModel: parameters.EnableScriptedModel === "true",
    setEnabled: (enabled) =>
      idp.send(
        new (enabled ? cognito.AdminEnableUserCommand : cognito.AdminDisableUserCommand)({
          UserPoolId: pool,
          Username: sub,
        }),
      ),
    readProfile: () => getItem("PROFILE"),
    readAgent: (agentId, projectId = "main") => getItem(`AGENT#${projectId}#${agentId}`),
    readOwnedRecords: () => partition(),
    // A conversation's saved turns, one row per committed turn.
    readTurns: (conversationId, projectId = "main") =>
      partition(`TURN#${projectId}#${conversationId}#`),
    readUsage: async () => ({ Items: await partition("USAGE#") }),
    trackRuntimeSession: (id) => runtimeSessions.add(id),
    setRuntimeStopToken: (token) => {
      runtimeStopToken = token;
    },
    stopRuntimeSession,
    createPeer: (peerRole = "Members") =>
      createLiveFixture({ stackName, profile, region, role: peerRole }),
  };
}

// The catalog models every live inference check expects, by display name.
export const catalogModelNames = [
  "Claude Haiku 5.5",
  "Claude Sonnet 5.5",
  "Claude Opus 5.5",
  "Claude Fable 5.1",
  "GPT-6.1 Sol",
  "GPT-6 Luna",
  "Gemini 3.8 Flash",
];

// Fills the Cognito managed sign-in form after the page's Sign in button.
export async function submitHostedSignIn(page, identity) {
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .locator('input[type="password"]')
    .first()
    .waitFor({ timeout: 30000 });
  await page
    .locator('input[type="email"], input[name="username"]')
    .first()
    .fill(identity.email);
  await page.locator('input[type="password"]').first().fill(identity.password);
  await page
    .locator('button[type="submit"], input[type="submit"]')
    .first()
    .click();
}

// The signed-in page's tokens and Runtime session id.
export const readSession = (page) =>
  page.evaluate(() => {
    const config = JSON.parse(sessionStorage.getItem("agentcore:deployment"));
    return {
      config,
      ...JSON.parse(
        sessionStorage.getItem(
          `agentcore:session:${config.runtime}:${config.client}`,
        ),
      ),
    };
  });

// One Runtime command from Node as the signed-in identity; returns the envelope.
export const transport =
  (identity, auth) =>
  async (command, input = {}) => {
    const response = await fetch(identity.controllerUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + auth.tokens.access_token,
        "x-amzn-bedrock-agentcore-runtime-session-id": auth.runtimeSessionId,
      },
      body: JSON.stringify({ v: 1, command, requestId: randomUUID(), input }),
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw Error(command + " HTTP " + response.status);
    return await response.json();
  };
