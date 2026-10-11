// Who is calling, what they may spend and store, and the account owner.
import {
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { idp } from "./aws.js";
import {
  accountPk,
  expression,
  get,
  key,
  sk,
  update,
  userKey,
} from "./db.js";

export const roles = ["Administrators", "Members", "Auditors"];
const pool = () => process.env.POOL;

// Claim extraction, not signature verification: the AgentCore custom JWT
// authorizer is the trust boundary, so never expose this server directly.
export function caller(authorization) {
  const token =
    /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(
      authorization || "",
    )?.[1];
  if (!token) return null;
  let claims;
  try {
    claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url"));
  } catch {
    return null;
  }
  const groups = claims["cognito:groups"];
  if (
    claims.iss !== process.env.ISSUER ||
    claims.client_id !== process.env.CLIENT ||
    claims.token_use !== "access" ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= Date.now() / 1000 ||
    !/^[0-9a-f-]{36}$/i.test(claims.sub || "") ||
    !Array.isArray(groups) ||
    groups.length !== 1 ||
    !roles.includes(groups[0])
  )
    return null;
  return { sub: claims.sub, role: groups[0] };
}

// A token stays valid after its user is disabled or regrouped, so access is
// re-checked against Cognito. A successful check is reused for 15 seconds,
// which bounds how long a revoked user keeps access.
const verified = new Map();
// Access changes made on this worker take effect here immediately.
export const forgetAuthorization = (sub) => {
  for (const cached of verified.keys())
    if (cached.startsWith(sub + ":")) verified.delete(cached);
};
export async function stillAuthorized(identity) {
  const cacheKey = `${identity.sub}:${identity.role}`;
  if ((verified.get(cacheKey) || 0) > Date.now()) return true;
  try {
    const [user, groups] = await Promise.all([
      idp.send(
        new AdminGetUserCommand({ UserPoolId: pool(), Username: identity.sub }),
      ),
      idp.send(
        new AdminListGroupsForUserCommand({
          UserPoolId: pool(),
          Username: identity.sub,
          Limit: 10,
        }),
      ),
    ]);
    const names = (groups.Groups || []).map((group) => group.GroupName);
    const ok =
      user.Enabled && names.length === 1 && names[0] === identity.role;
    if (ok) verified.set(cacheKey, Date.now() + 15000);
    else verified.delete(cacheKey);
    return ok;
  } catch (error) {
    if (error.name === "UserNotFoundException") return false;
    throw error;
  }
}

export const emailOf = (user) =>
  (user.Attributes || user.UserAttributes)?.find(
    (attribute) => attribute.Name === "email",
  )?.Value || "";
export const subOf = (user) =>
  (user.Attributes || user.UserAttributes)?.find(
    (attribute) => attribute.Name === "sub",
  )?.Value;

// The protected administrator: the configured bootstrap email, or else the
// first administrator to ask. Recorded once; it cannot be demoted or disabled.
export async function owner(adminSub) {
  const existing = await get(key(accountPk, "OWNER"));
  if (existing?.ownerSub) return existing.ownerSub;
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  let ownerSub = adminSub;
  if (email) {
    const found = await idp.send(
      new ListUsersCommand({
        UserPoolId: pool(),
        Filter: `email = "${email.replaceAll('"', "")}"`,
        Limit: 10,
      }),
    );
    ownerSub = subOf(
      found.Users?.find((user) => emailOf(user).toLowerCase() === email) || {},
    );
    if (!ownerSub) return null;
  }
  const saved = await update(
    key(accountPk, "OWNER"),
    expression({ init: { ownerSub } }),
  );
  return saved.ownerSub;
}

// Account-wide defaults, created from the stack parameters on first read.
export async function defaults() {
  const existing = await get(key(accountPk, "DEFAULTS"));
  if (existing?.revision !== undefined) return publicDefaults(existing);
  const saved = await update(
    key(accountPk, "DEFAULTS"),
    expression({
      init: {
        budgetMicroUsd: Number(process.env.BUDGET),
        storageBytes: Number(process.env.STORAGE),
        period: "daily",
        revision: 0,
      },
    }),
  );
  return publicDefaults(saved);
}
const publicDefaults = ({ budgetMicroUsd, storageBytes, period, revision }) => ({
  budgetMicroUsd,
  storageBytes,
  period,
  revision,
});

// A person's limits are account defaults unless an administrator overrode them.
export async function limits(sub) {
  const [base, profile] = await Promise.all([
    defaults(),
    get(userKey(sub, sk.profile)),
  ]);
  return effectiveLimits(profile, base);
}
export function effectiveLimits(profile, base) {
  return {
    budgetMicroUsd: profile?.budgetOverrideMicroUsd ?? base.budgetMicroUsd,
    storageBytes: profile?.storageOverrideBytes ?? base.storageBytes,
    period: profile?.periodOverride ?? base.period,
    budgetEpoch: profile?.budgetEpoch ?? 0,
    budgetInherited: profile?.budgetOverrideMicroUsd == null,
    storageInherited: profile?.storageOverrideBytes == null,
    periodInherited: profile?.periodOverride == null,
    storageUsedBytes: profile?.storageUsedBytes ?? 0,
  };
}
export async function storage(sub) {
  const current = await limits(sub);
  return {
    limitBytes: current.storageBytes,
    usedBytes: current.storageUsedBytes,
  };
}
