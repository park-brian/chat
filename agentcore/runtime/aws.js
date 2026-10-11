// One client per AWS service, shared by every module. Tests replace `send`.
import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";

export const dynamo = new DynamoDBClient({});
export const s3 = new S3Client({});
export const idp = new CognitoIdentityProviderClient({});
export const agentcore = new BedrockAgentCoreClient({});
export const bedrock = new BedrockRuntimeClient({});
