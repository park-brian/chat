// Read-only migration audit: node scripts/audit-limits.js <stack> [profile] [region].
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { CognitoIdentityProviderClient, ListUsersCommand } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { fromIni } from "@aws-sdk/credential-providers";

const stack = process.argv[2];
if (!stack) throw Error("Pass an exact stack name");
const config = { region: process.argv[4] || "us-east-1",
  credentials: fromIni({ profile: process.argv[3] || "eaap" }) };
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
const budget = Number(defaults?.baselineBudgetMicroUsd?.N ??
  defaults?.budgetMicroUsd?.N ?? 5000000);
const storage = Number(defaults?.baselineStorageBytes?.N ??
  defaults?.storageBytes?.N ?? 5000000000);
const summary = { users: 0, budgetInherited: 0, budgetOverrides: 0,
  storageInherited: 0, storageOverrides: 0, existingV2: 0 };
let PaginationToken;
do {
  const page = await idp.send(new ListUsersCommand({ UserPoolId: pool,
    Limit: 60, PaginationToken }));
  for (const user of page.Users || []) {
    const sub = user.Attributes?.find((item) => item.Name === "sub")?.Value;
    if (!sub) continue;
    const row = await read(`USER#${sub}`, "CONTROL");
    summary.users++;
    const v2 = row?.limitsVersion?.N === "2";
    if (v2) summary.existingV2++;
    if (v2 ? row.budgetOverrideMicroUsd?.NULL === true :
      row?.budgetMicroUsd?.N === undefined || Number(row.budgetMicroUsd.N) === budget)
      summary.budgetInherited++;
    else summary.budgetOverrides++;
    if (v2 ? row.storageOverrideBytes?.NULL === true :
      row?.storageBytes?.N === undefined || Number(row.storageBytes.N) === storage)
      summary.storageInherited++;
    else summary.storageOverrides++;
  }
  PaginationToken = page.PaginationToken;
} while (PaginationToken);
console.log(JSON.stringify({ stack, baselineBudgetMicroUsd: budget,
  baselineStorageBytes: storage, ...summary }, null, 2));
