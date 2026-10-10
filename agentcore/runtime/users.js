import {
  AdminGetUserCommand,
  AdminCreateUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminListGroupsForUserCommand,
  AdminEnableUserCommand,
  AdminDisableUserCommand,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";

export function createUsers(context) {
  const {
    idp,
    db,
    S,
    N,
    key,
    unpack,
    protectedAdministrator,
    defaults,
    invalid,
    missing,
    effectiveLimits,
    uuidPattern,
  } = context;
  async function profile(user, limits, ownerSub) {
    const sub = (user.Attributes || user.UserAttributes)?.find(
      (attribute) => attribute.Name === "sub",
    )?.Value;
    const [row, groups] = await Promise.all([
      db.send(
        new GetItemCommand({
          TableName: process.env.TABLE,
          Key: key(`USER#${sub}`, "CONTROL"),
        }),
      ),
      idp.send(
        new AdminListGroupsForUserCommand({
          UserPoolId: process.env.POOL,
          Username: sub,
          Limit: 10,
        }),
      ),
    ]);
    return {
      sub,
      email: (user.Attributes || user.UserAttributes)?.find(
        (attribute) => attribute.Name === "email",
      )?.Value,
      enabled: user.Enabled,
      status: user.UserStatus,
      role: (groups.Groups || []).map((group) => group.GroupName)[0] || null,
      protected: sub === ownerSub,
      ...effectiveLimits(row.Item, limits),
      budgetInherited:
        row.Item?.limitsVersion?.N === "2"
          ? row.Item.budgetOverrideMicroUsd?.N === undefined
          : row.Item?.budgetMicroUsd?.N === undefined ||
            Number(row.Item.budgetMicroUsd.N) === limits.baselineBudgetMicroUsd,
      storageInherited:
        row.Item?.limitsVersion?.N === "2"
          ? row.Item.storageOverrideBytes?.N === undefined
          : row.Item?.storageBytes?.N === undefined ||
            Number(row.Item.storageBytes.N) === limits.baselineStorageBytes,
      periodInherited: !row.Item?.periodOverride?.S,
      storageUsedBytes: Number(row.Item?.storageUsedBytes?.N || 0),
    };
  }
  return async function users(body, identity) {
    if (body.command === "users.get") {
      const sub = body.input.userSub || identity.sub;
      if (!uuidPattern.test(sub)) return invalid();
      if (sub !== identity.sub && identity.role !== "Administrators")
        return {
          status: 403,
          data: { ok: false, error: { code: "FORBIDDEN" } },
        };
      let user;
      try {
        user = await idp.send(
          new AdminGetUserCommand({
            UserPoolId: process.env.POOL,
            Username: sub,
          }),
        );
      } catch (error) {
        if (error.name === "UserNotFoundException") return missing();
        throw error;
      }
      const limits = await defaults();
      const ownerSub =
        identity.role === "Administrators"
          ? await protectedAdministrator(identity.sub)
          : null;
      return {
        status: 200,
        data: {
          ok: true,
          data: {
            user: await profile(user, limits, ownerSub),
            defaults: limits,
          },
        },
      };
    }
    const admin = identity.role === "Administrators";
    if (
      [
        "users.list",
        "users.invite",
        "users.setLimits",
        "users.setRole",
        "users.setEnabled",
        "users.startNewBudgetPeriod",
        "defaults.get",
        "defaults.set",
      ].includes(body.command) &&
      !admin
    )
      return { status: 403, data: { ok: false, error: { code: "FORBIDDEN" } } };
    if (body.command === "users.list") {
      if (
        body.input.cursor !== undefined &&
        (typeof body.input.cursor !== "string" ||
          body.input.cursor.length > 4096)
      )
        return invalid();
      const page = await idp.send(
        new ListUsersCommand({
          UserPoolId: process.env.POOL,
          Limit: 20,
          PaginationToken: body.input.cursor || undefined,
        }),
      );
      const [limits, ownerSub] = await Promise.all([
        defaults(),
        protectedAdministrator(identity.sub),
      ]);
      const items = await Promise.all(
        page.Users.map((user) => profile(user, limits, ownerSub)),
      );
      return {
        status: 200,
        data: {
          ok: true,
          data: {
            items,
            cursor: page.PaginationToken || null,
            defaults: limits,
          },
        },
      };
    }
    if (body.command === "users.invite") {
      const { email, role } = body.input;
      if (
        !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || "") ||
        !["Members", "Auditors", "Administrators"].includes(role)
      )
        return {
          status: 400,
          data: { ok: false, error: { code: "VALIDATION_FAILED" } },
        };
      await idp.send(
        new AdminCreateUserCommand({
          UserPoolId: process.env.POOL,
          Username: email,
          UserAttributes: [
            { Name: "email", Value: email },
            { Name: "email_verified", Value: "true" },
          ],
        }),
      );
      await idp.send(
        new AdminAddUserToGroupCommand({
          UserPoolId: process.env.POOL,
          Username: email,
          GroupName: role,
        }),
      );
      return { status: 200, data: { ok: true, data: { invited: true } } };
    }
    if (body.command === "users.setLimits") {
      const { sub, budgetMicroUsd, storageBytes, period = null } = body.input;
      if (
        !/^[0-9a-f-]{36}$/i.test(sub || "") ||
        (budgetMicroUsd !== null &&
          (!Number.isSafeInteger(budgetMicroUsd) || budgetMicroUsd < 0)) ||
        (storageBytes !== null &&
          (!Number.isSafeInteger(storageBytes) || storageBytes < 0)) ||
        (period !== null && !["daily", "weekly", "monthly"].includes(period))
      )
        return {
          status: 400,
          data: { ok: false, error: { code: "VALIDATION_FAILED" } },
        };
      await idp.send(
        new AdminGetUserCommand({
          UserPoolId: process.env.POOL,
          Username: sub,
        }),
      );
      const limits = await defaults();
      await db.send(
        new UpdateItemCommand({
          TableName: process.env.TABLE,
          Key: key(`USER#${sub}`, "CONTROL"),
          UpdateExpression:
            "SET limitsVersion = :version, budgetOverrideMicroUsd = :budgetOverride, storageOverrideBytes = :storageOverride, budgetMicroUsd = :budget, storageBytes = :storage, periodOverride = :period",
          ExpressionAttributeValues: {
            ":version": N(2),
            ":budgetOverride":
              budgetMicroUsd === null ? { NULL: true } : N(budgetMicroUsd),
            ":storageOverride":
              storageBytes === null ? { NULL: true } : N(storageBytes),
            ":budget": N(budgetMicroUsd ?? limits.budgetMicroUsd),
            ":storage": N(storageBytes ?? limits.storageBytes),
            ":period": period === null ? { NULL: true } : S(period),
          },
        }),
      );
      return { status: 200, data: { ok: true, data: { updated: true } } };
    }
    if (body.command === "users.startNewBudgetPeriod") {
      const { sub } = body.input;
      if (!/^[0-9a-f-]{36}$/i.test(sub || "")) return invalid();
      await idp.send(
        new AdminGetUserCommand({
          UserPoolId: process.env.POOL,
          Username: sub,
        }),
      );
      const row = await db.send(
        new UpdateItemCommand({
          TableName: process.env.TABLE,
          Key: key(`USER#${sub}`, "CONTROL"),
          UpdateExpression: "ADD budgetEpoch :one",
          ExpressionAttributeValues: { ":one": N(1) },
          ReturnValues: "ALL_NEW",
        }),
      );
      return {
        status: 200,
        data: {
          ok: true,
          data: { budgetEpoch: Number(row.Attributes.budgetEpoch.N) },
        },
      };
    }
    if (["users.setRole", "users.setEnabled"].includes(body.command)) {
      const { sub } = body.input;
      if (!/^[0-9a-f-]{36}$/i.test(sub || "")) return invalid();
      if (sub === (await protectedAdministrator(identity.sub)))
        return {
          status: 403,
          data: { ok: false, error: { code: "PROTECTED_ADMIN" } },
        };
      await idp.send(
        new AdminGetUserCommand({
          UserPoolId: process.env.POOL,
          Username: sub,
        }),
      );
      if (body.command === "users.setEnabled") {
        if (typeof body.input.enabled !== "boolean") return invalid();
        await idp.send(
          new (body.input.enabled
            ? AdminEnableUserCommand
            : AdminDisableUserCommand)({
            UserPoolId: process.env.POOL,
            Username: sub,
          }),
        );
        return {
          status: 200,
          data: { ok: true, data: { enabled: body.input.enabled } },
        };
      }
      const role = body.input.role;
      if (!["Administrators", "Members", "Auditors"].includes(role))
        return invalid();
      const groups = await idp.send(
        new AdminListGroupsForUserCommand({
          UserPoolId: process.env.POOL,
          Username: sub,
          Limit: 10,
        }),
      );
      const old = (groups.Groups || []).map((group) => group.GroupName);
      if (
        old.length !== 1 ||
        !["Administrators", "Members", "Auditors"].includes(old[0])
      )
        return {
          status: 409,
          data: { ok: false, error: { code: "ROLE_CONFLICT" } },
        };
      if (old[0] !== role) {
        await idp.send(
          new AdminAddUserToGroupCommand({
            UserPoolId: process.env.POOL,
            Username: sub,
            GroupName: role,
          }),
        );
        try {
          await idp.send(
            new AdminRemoveUserFromGroupCommand({
              UserPoolId: process.env.POOL,
              Username: sub,
              GroupName: old[0],
            }),
          );
        } catch (error) {
          await idp
            .send(
              new AdminRemoveUserFromGroupCommand({
                UserPoolId: process.env.POOL,
                Username: sub,
                GroupName: role,
              }),
            )
            .catch(() =>
              console.error("Role update needs administrator repair"),
            );
          throw error;
        }
      }
      return { status: 200, data: { ok: true, data: { role } } };
    }
    if (body.command === "defaults.get")
      return { status: 200, data: { ok: true, data: await defaults() } };
    if (body.command === "defaults.set") {
      const { budgetMicroUsd, storageBytes, period, revision } = body.input;
      if (
        !Number.isSafeInteger(budgetMicroUsd) ||
        budgetMicroUsd < 0 ||
        !Number.isSafeInteger(storageBytes) ||
        storageBytes < 0 ||
        !["daily", "weekly", "monthly"].includes(period) ||
        !Number.isSafeInteger(revision)
      )
        return {
          status: 400,
          data: { ok: false, error: { code: "VALIDATION_FAILED" } },
        };
      const row = await db.send(
        new UpdateItemCommand({
          TableName: process.env.TABLE,
          Key: key("ACCOUNT#CONTROL", "DEFAULTS"),
          UpdateExpression:
            "SET budgetMicroUsd = :budget, storageBytes = :storage, #period = :period, revision = revision + :one",
          ConditionExpression: "revision = :revision",
          ExpressionAttributeNames: { "#period": "period" },
          ExpressionAttributeValues: {
            ":budget": N(budgetMicroUsd),
            ":storage": N(storageBytes),
            ":period": S(period),
            ":revision": N(revision),
            ":one": N(1),
          },
          ReturnValues: "ALL_NEW",
        }),
      );
      return { status: 200, data: { ok: true, data: unpack(row.Attributes) } };
    }
  };
}
