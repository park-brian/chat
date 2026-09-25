// One-time, non-destructive migration. Run audit-limits.js first, then pass --apply.
// Existing numeric fields stay in place for rollback; version 2 markers own inheritance.
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { CognitoIdentityProviderClient, ListUsersCommand } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { fromIni } from "@aws-sdk/credential-providers";

const [stack, profile = "eaap", region = "us-east-1"] = process.argv.slice(2);
if (!stack || !process.argv.includes("--apply"))
  throw Error("Run audit-limits.js first; then pass <stack> [profile] [region] --apply");
const config = { region, credentials: fromIni({ profile }) };
const described = await new CloudFormationClient(config).send(
  new DescribeStacksCommand({ StackName: stack }));
const output = (name) => described.Stacks?.[0]?.Outputs?.find((item) =>
  item.OutputKey === name)?.OutputValue;
const table = output("DataTable"), pool = output("UserPoolId");
if (!table || !pool) throw Error("Stack has no data table or user pool");
const db = new DynamoDBClient(config), idp = new CognitoIdentityProviderClient(config);
const read = async (pk, sk) => (await db.send(new GetItemCommand({ TableName: table,
  Key: { pk: { S: pk }, sk: { S: sk } }, ConsistentRead: true }))).Item;
const defaults = await read("ACCOUNT#CONTROL", "DEFAULTS");
if (!defaults?.baselineBudgetMicroUsd?.N || !defaults?.baselineStorageBytes?.N)
  throw Error("Invoke the updated Runtime once to freeze the pre-migration baselines");
const baselineBudget = Number(defaults.baselineBudgetMicroUsd.N);
const baselineStorage = Number(defaults.baselineStorageBytes.N);
const summary = { migrated: 0, alreadyV2: 0, absentControl: 0,
  inheritedBudget: 0, inheritedStorage: 0 };
let PaginationToken;
do {
  const page = await idp.send(new ListUsersCommand({ UserPoolId: pool,
    Limit: 60, PaginationToken }));
  for (const user of page.Users || []) {
    const sub = user.Attributes?.find((item) => item.Name === "sub")?.Value;
    if (!sub) continue;
    const pk = `USER#${sub}`, row = await read(pk, "CONTROL");
    if (!row) { summary.absentControl++; continue; }
    if (row.limitsVersion?.N === "2") { summary.alreadyV2++; continue; }
    const oldBudget = row.budgetMicroUsd?.N;
    const oldStorage = row.storageBytes?.N;
    const inheritBudget = oldBudget === undefined || Number(oldBudget) === baselineBudget;
    const inheritStorage = oldStorage === undefined || Number(oldStorage) === baselineStorage;
    const values = { ":two": { N: "2" },
      ":budget": inheritBudget ? { NULL: true } : { N: oldBudget },
      ":storage": inheritStorage ? { NULL: true } : { N: oldStorage } };
    const conditions = ["attribute_exists(pk)", "attribute_not_exists(limitsVersion)"];
    for (const [attribute, oldValue, token] of [
      ["budgetMicroUsd", oldBudget, ":oldBudget"],
      ["storageBytes", oldStorage, ":oldStorage"]]) {
      if (oldValue === undefined) conditions.push(`attribute_not_exists(${attribute})`);
      else { conditions.push(`${attribute} = ${token}`); values[token] = { N: oldValue }; }
    }
    await db.send(new UpdateItemCommand({ TableName: table,
      Key: { pk: { S: pk }, sk: { S: "CONTROL" } },
      UpdateExpression: "SET limitsVersion = :two, budgetOverrideMicroUsd = :budget, storageOverrideBytes = :storage",
      ConditionExpression: conditions.join(" AND "),
      ExpressionAttributeValues: values }));
    const verified = await read(pk, "CONTROL");
    if (verified.limitsVersion?.N !== "2" ||
      verified.budgetMicroUsd?.N !== oldBudget ||
      verified.storageBytes?.N !== oldStorage ||
      Boolean(verified.budgetOverrideMicroUsd?.NULL) !== inheritBudget ||
      Boolean(verified.storageOverrideBytes?.NULL) !== inheritStorage ||
      (!inheritBudget && verified.budgetOverrideMicroUsd?.N !== oldBudget) ||
      (!inheritStorage && verified.storageOverrideBytes?.N !== oldStorage))
      throw Error("Migration verification failed for " + sub);
    summary.migrated++;
    if (inheritBudget) summary.inheritedBudget++;
    if (inheritStorage) summary.inheritedStorage++;
  }
  PaginationToken = page.PaginationToken;
} while (PaginationToken);
console.log(JSON.stringify({ stack, baselineBudget, baselineStorage, ...summary }, null, 2));
