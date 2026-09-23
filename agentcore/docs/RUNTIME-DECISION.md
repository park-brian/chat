# Why the application backend should be an AgentCore CodeZip Runtime

> Superseded decision record. The team subsequently chose Runtime-only, with a direct Bedrock Converse loop and no managed Harness. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the current rationale and implementation.

Decision (2026-09-22): replace the foundation's Lambda/API Gateway broker with **one small, deterministic AgentCore Runtime**, deployed as a Node.js 22 ZIP from the existing shared S3 bucket. Keep **one managed Harness per durable agent** for chat. A Harness is the agent loop; the Runtime is the product control boundary. This is the target architecture, **not yet the deployed implementation**. [STATUS.md](./STATUS.md) records what actually works today.

## Why not call the Harness directly for everything?

Direct browser invocation is technically plausible: a live `OPTIONS` request from the GitHub Pages origin to both AgentCore `/harnesses/invoke` and `/runtimes/.../invocations` returned HTTP 200 with `Access-Control-Allow-Origin: *` and the requested authorization, content-type, and session headers. AgentCore also supports Cognito JWT inbound auth and a Node.js 22 ZIP Runtime. An authenticated POST and streaming browser read still require a live end-to-end test.

But the managed Harness is probabilistic and prompt-driven. It must not decide who is an administrator, change a budget, disclose a secret, choose an AWS control-plane operation, or decide whether a request is admitted. Its built-in tools and `allowedTools` control LLM tool selection; they do not turn it into a deterministic application API. Harness lifecycle hooks do not replace that API: the only synchronous hook target currently documented in the installed SDK is Lambda; EventBridge and SNS targets are asynchronous. If a user can invoke a JWT-enabled Harness directly, they can bypass an application's pre-invocation budget gate. An unguessable ARN is not authorization.

Therefore the browser calls **only the controller Runtime** with a Cognito access token. The Runtime authenticates with an AgentCore custom JWT authorizer, allowlists the `Authorization` header into its code, derives `sub` and exactly one account group from that validated token, and routes a small allowlist of control commands. It strongly reads committed spend before invoking the Harness, then records measured usage after. The Harness has **IAM inbound auth**, and only the controller execution role receives invoke permission. The browser never receives Harness IAM credentials or a permission to invoke it. The Runtime never accepts an actor ID, role, Harness ARN, owner ID, or model override from a chat request.

This introduces an explicit tradeoff: AWS says IAM/SigV4 Harness calls do not propagate end-user identity into AgentCore Identity's user-scoped OAuth vault. We must not silently claim that per-user OAuth works in this topology. App-managed, user/agent-scoped API keys through a guarded controller and narrowly scoped Gateway targets are a possible first credential slice, subject to live proof; **native user-delegated OAuth through the Harness remains a design gate**. Before enabling it, prove a service-enforced path that both forwards the caller JWT to the Harness and prevents direct user invocation, or retain a separate narrowly scoped gateway/identity path. Do not substitute a client-supplied `runtimeUserId` as proof of identity. If that gate cannot be met, document the feature as unavailable rather than weakening budget enforcement.

## Minimal resource shape

```text
GitHub Pages index.html + tests.js
  -> Cognito managed login (PKCE)
  -> one JWT-protected AgentCore CodeZip Runtime (deterministic control + chat admission)
       -> Cognito admin APIs, one DynamoDB control/ledger table
       -> one IAM-only managed Harness per durable agent
            -> shared AgentCore Memory, Browser, Code Interpreter, governed Gateway
       -> one private shared S3 bucket for ZIP, skills, and user objects
```

The same CloudFormation foundation owns Cognito, the table, bucket, Memory, Gateway/Policy, controller role, and Runtime. Harnesses are dynamic AWS resources created by the controller and tagged with stack, owner `sub`, project, and agent ID; the table stores only membership/binding and accounting facts AWS does not own. Actor ID is `<Cognito sub>/<project ID>`, with `main` as the default project. The controller's ZIP is a content-addressed object in the **same** bucket, not a second artifact bucket. CloudFormation must reference the exact ZIP key, so code updates are visible as stack updates rather than hidden drift.

Cold bootstrap has one unavoidable two-phase edge: the ZIP cannot be uploaded into a bucket before CloudFormation creates that bucket. The smallest repeatable workflow is (1) create the foundation with the bucket and auth/control resources but no controller Runtime, (2) bundle/ZIP/upload code to that bucket, (3) update the same stack with `ControllerCodeKey`, creating the Runtime. Subsequent iterations reuse the stack and change only that key. A deployment command should own these steps, wait for the actual Runtime status, and print a non-secret application URL. Test teardown removes only exact disposable resources and all versions of that stack's retained bucket after confirming ownership. No persistent second bootstrap stack.

## Runtime contract and safety invariants

- The ZIP has one `.js` entry point: `GET /ping` and `POST /invocations` on port 8080. `POST` carries `{v, command, input, requestId}`; chat is a command whose response streams Harness events. No generic AWS-operation proxy and no LLM execution in the controller.
- AgentCore validates the JWT before forwarding it. Code checks issuer, client, token-use, expiry, group cardinality, and `sub`; it never logs the token, request body for secret routes, or third-party API keys. Native `Authorization` header propagation and authenticated POST must be tested against a disposable Runtime before the Lambda path is removed.
- CORS preflight is supported by the AgentCore front door in the live check. The browser still restricts endpoint hosts and uses an allowlisted deployment descriptor. A controller response never broadens token access by reflecting arbitrary origins.
- The controller role gets explicit service/action/resource permissions. The Harness role gets only the tools and storage it requires. No admin AWS credentials are exposed to the normal app. Deployment-administrator CloudFormation mode remains a separate short-lived browser session, if implemented.
- Each chat request derives its binding from the authenticated `sub` and project membership, strongly reads the user's current-period committed total, and admits only if below limit. There is no pending-cost lock. Overdraft due to concurrency is forgiven. Usage events are idempotent per request/tool/meter and never fabricated when telemetry is absent.
- Keep normal tests fast: local pure contract tests plus one reusable live disposable stack and Cognito smoke user. Only model inference may use the scripted echo model. Test the real AgentCore Runtime, Harness, Cognito, DynamoDB, and browser boundaries. `test.js` owns generic browser stories and `_screenshot` remains available. Clean every smoke user, Harness, binding, object, and stack at the end of development.

## Migration sequence and gates

1. Keep the current Lambda stack functional while adding the controller entry point and ZIP build. Bundle a single `.js` file with pinned AWS SDKs; verify its ZIP contents and local `/ping`, invalid token, role, and command behavior. Do not add a framework unless the native Node HTTP server becomes harder to maintain.
2. Add a **disposable** Runtime using the shared-bucket code key and Cognito authorizer; test a real browser `OPTIONS`, authenticated `session.get`, denied/no-group user, and a control mutation read back from DynamoDB. If AgentCore does not forward the validated token as documented or browser streaming fails, stop the migration and keep API Gateway/Lambda.
3. Switch the app's non-secret deployment descriptor to the Runtime ARN/URL and remove the Lambda/API Gateway resources only after parity of current account/users/models/usage stories. Keep the old stack revision recoverable until this gate passes.
4. Add native Harness create/read/update/delete and actor/binding lifecycle. Start with one approved Bedrock model and tool-less Harness. Prove duplicate create, lost response, orphan repair, delete, and authorization with live AWS.
5. Add chat admission, streaming, memory, measured model/tool events and budget display; verify the browser cannot invoke a Harness directly with its Cognito token. Then add skills, governed tools, credentials, projects, and detailed cost reconciliation in slices. Resolve the user-delegated OAuth gate before claiming that feature.

## Sources checked

- [Node.js direct CodeZip deployment](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-code-deploy-node.html)
- [Runtime CloudFormation resource](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-bedrockagentcore-runtime.html)
- [Inbound JWT and caller-token forwarding](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-oauth.html)
- [Harness security and IAM/JWT identity tradeoff](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-security.html)
- [Harness tools and direct command caveat](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-tools.html)
- [AgentCore Runtime header allowlist](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-header-allowlist.html)
