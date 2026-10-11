# AgentCore Chat

A private, multi-person chat workspace for configured agents. People sign in
with Cognito, choose a project and an agent (a model, instructions, and the
tools it may use: a code workspace, web search, a browser, saved skills and
granted GitHub or Jira connections), and hold branching conversations that
keep running when they leave the page. Every model and tool step is metered
against a per-person budget, and administrators manage people, limits and
combined usage.

The app is seven buildless SolidJS pages on GitHub Pages and one AgentCore
Runtime, with one DynamoDB table and one S3 bucket.

| Document | For |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How it works: modules, data model, commands, turns, usage, tools, security, latency |
| [RELEASING.md](RELEASING.md) | Checks, the disposable stack, production change sets and the smoke test |
| [CHANGELOG.md](CHANGELOG.md) | Verified releases and what is next |

Published at <https://park-brian.github.io/chat/agentcore/>.
