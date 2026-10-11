# Releasing

A release has two independent parts: the Runtime (a ZIP behind the
`agentcore-chat-prod` CloudFormation stack) and the browser pages (published by
GitHub Pages from `main`). When the API version changes, ship the Runtime
first and push the pages straight after.

## Credentials

Production and disposable stacks live in the account behind the `eaap` AWS
profile. Run every script below with `AWS_PROFILE=eaap`. The repository's `.env`
also holds static keys, which belong to a restricted user in a different
account; without `AWS_PROFILE` the scripts would act there.

In Git Bash, set `MSYS_NO_PATHCONV=1` before AWS CLI calls that take paths such
as `/aws/bedrock-agentcore/...` log groups.

## Local checks

```bash
npm run csp:sync
```

```bash
npm test
```

`npm test` checks the CSP, import maps and boot shells; accounting, models and
the Gemini protocol; the whole Runtime API offline (`tests/runtime.test.js`,
against in-memory AWS fakes that enforce DynamoDB conditions and
transactions); the pages in desktop and mobile browsers against mocked
calls; sign-in; and the shell story.

## Disposable stack

```bash
AWS_PROFILE=eaap node scripts/validation-stack.js bootstrap
```

```bash
node scripts/build-controller.js
```

```bash
AWS_PROFILE=eaap node scripts/validation-stack.js update controller-<hash>.zip
```

`bootstrap` creates a tagged stack with scripted inference enabled and records
it in `.artifacts/pages-validation-stack.json`. `update` deploys the current
template and the named ZIP, and refuses resource replacement. Then run the
live stories against it (`--live-stack` takes the recorded stack name):

```bash
node ../test.js index.html --story runtime-roadmap --live-stack <stack> --profile eaap --region us-east-1
```

```bash
node ../test.js index.html --story runtime-foundation --live-stack <stack> --profile eaap --region us-east-1
```

```bash
AWS_PROFILE=eaap node scripts/test-live-pages.js
```

```bash
AWS_PROFILE=eaap node scripts/test-live-pages.js runtime-web
```

```bash
AWS_PROFILE=eaap node scripts/test-live-pages.js runtime-model
```

`runtime-model` runs real inference on every catalog model (a few cents).
Every story creates temporary Cognito identities and removes them, their
partition, their S3 prefixes and their Runtime sessions in `finally`. When
done:

```bash
AWS_PROFILE=eaap node scripts/validation-stack.js cleanup
```

## Production

Promote only a ZIP that passed on the disposable stack.

```bash
AWS_PROFILE=eaap node scripts/prepare-production-change-set.js controller-<hash>.zip
```

This uploads the ZIP and creates a change set for review; it never executes
one. It refuses replacements. A release that intentionally removes or adds
resources must name them, for example `--remove Data,Memory --add Table`, and
the change set must match exactly. Review `.artifacts/pages-production-review.json`,
then:

```bash
AWS_PROFILE=eaap node scripts/execute-production-change-set.js
```

Execution accepts only the reviewed change set and verifies that every
resource not named for removal or addition keeps its physical identity.

Then push `main` to publish the pages, and run the production smoke:

```bash
AWS_PROFILE=eaap node scripts/test-production-pages.js
```

It checks that the published files match the source, signs in through the
published origin with PKCE, walks every page, exercises the credential
lifecycle, runs one real background turn and one composer turn, records
latencies and screenshots under `.artifacts/`, and cleans up. Use
`--visual-only` to skip inference and credential writes, `--baseline` to
measure the published release without the file comparison, and `--local` to
serve this checkout on the pool's registered `LocalUrl` (port 8000) against the
production Runtime without publishing.

## Runtime snapshots

Runtime V2 restores workers from a snapshot that includes module state and
random state. Anything random or worker-specific must be created at request
time, and every transaction carries an explicit token from `db.uuid()`.
