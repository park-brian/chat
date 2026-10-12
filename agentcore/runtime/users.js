// People and account limits, for administrators. Identity lives in Cognito
// (email, enabled, one group); limits and usage live in the person's PROFILE.
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  defaults,
  effectiveLimits,
  emailOf,
  forgetAuthorization,
  owner,
  roles,
  subOf,
} from "./accounts.js";
import { idp } from "./aws.js";
import {
  accountPk,
  expression,
  fail,
  get,
  getMany,
  key,
  patterns,
  revised,
  sk,
  update,
  userKey,
} from "./db.js";

const pool = () => process.env.POOL;
const subjectOf = (sub) => {
  if (!patterns.id.test(sub || "")) fail("VALIDATION_FAILED");
  return sub;
};
const cognito = (command) =>
  idp.send(command).catch((error) => {
    if (error.name === "UserNotFoundException") fail("NOT_FOUND");
    throw error;
  });
const groupsOf = async (sub) =>
  (
    await cognito(
      new AdminListGroupsForUserCommand({
        UserPoolId: pool(),
        Username: sub,
        Limit: 10,
      }),
    )
  ).Groups.map((group) => group.GroupName);

const person = (user, groups, profile, base, ownerSub) => {
  const sub = subOf(user);
  return {
    sub,
    email: emailOf(user),
    enabled: user.Enabled,
    status: user.UserStatus,
    role: groups[0] || null,
    protected: sub === ownerSub,
    ...effectiveLimits(profile, base),
  };
};
const nullableAmount = (value) =>
  value === null || (Number.isSafeInteger(value) && value >= 0);
const period = (value) => ["daily", "weekly", "monthly"].includes(value);

export const userCommands = {
  "users.get": {
    run: async (input, identity) => {
      const sub = subjectOf(input.userSub || identity.sub);
      if (sub !== identity.sub && identity.role !== "Administrators")
        fail("FORBIDDEN");
      const [user, groups, profile, base, ownerSub] = await Promise.all([
        cognito(new AdminGetUserCommand({ UserPoolId: pool(), Username: sub })),
        groupsOf(sub),
        get(userKey(sub, sk.profile)),
        defaults(),
        identity.role === "Administrators" ? owner(identity.sub) : null,
      ]);
      return {
        user: person(user, groups, profile, base, ownerSub),
        defaults: base,
      };
    },
  },
  "users.list": {
    admin: true,
    run: async (input, identity) => {
      if (
        input.cursor !== undefined &&
        (typeof input.cursor !== "string" || input.cursor.length > 4096)
      )
        fail("VALIDATION_FAILED");
      const [page, base, ownerSub] = await Promise.all([
        idp.send(
          new ListUsersCommand({
            UserPoolId: pool(),
            Limit: 20,
            PaginationToken: input.cursor || undefined,
          }),
        ),
        defaults(),
        owner(identity.sub),
      ]);
      const subs = page.Users.map(subOf);
      const [profiles, groups] = await Promise.all([
        getMany(subs.map((sub) => userKey(sub, sk.profile))),
        Promise.all(subs.map(groupsOf)),
      ]);
      return {
        items: page.Users.map((user, index) =>
          person(user, groups[index], profiles[index], base, ownerSub),
        ),
        cursor: page.PaginationToken || null,
        defaults: base,
      };
    },
  },
  "users.invite": {
    admin: true,
    run: async (input) => {
      if (
        !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email || "") ||
        !roles.includes(input.role)
      )
        fail("VALIDATION_FAILED");
      await idp
        .send(
          new AdminCreateUserCommand({
            UserPoolId: pool(),
            Username: input.email,
            UserAttributes: [
              { Name: "email", Value: input.email },
              { Name: "email_verified", Value: "true" },
            ],
          }),
        )
        .catch((error) => {
          if (error.name === "UsernameExistsException") fail("USER_EXISTS");
          throw error;
        });
      // If this fails the person has no role and cannot sign in until
      // users.setRole gives them one.
      await idp.send(
        new AdminAddUserToGroupCommand({
          UserPoolId: pool(),
          Username: input.email,
          GroupName: input.role,
        }),
      );
      return { invited: true };
    },
  },
  // null means "use the account default" for each limit.
  "users.setLimits": {
    admin: true,
    run: async (input) => {
      const sub = subjectOf(input.sub);
      const { budgetMicroUsd, storageBytes } = input;
      const chosenPeriod = input.period ?? null;
      if (
        !nullableAmount(budgetMicroUsd) ||
        !nullableAmount(storageBytes) ||
        (chosenPeriod !== null && !period(chosenPeriod))
      )
        fail("VALIDATION_FAILED");
      await cognito(new AdminGetUserCommand({ UserPoolId: pool(), Username: sub }));
      const overrides = {
        budgetOverrideMicroUsd: budgetMicroUsd,
        storageOverrideBytes: storageBytes,
        periodOverride: chosenPeriod,
      };
      await update(
        userKey(sub, sk.profile),
        expression({
          set: Object.fromEntries(
            Object.entries(overrides).filter(([, value]) => value !== null),
          ),
          remove: Object.keys(overrides).filter((name) => overrides[name] === null),
        }),
      );
      return { updated: true };
    },
  },
  // Spending starts again from zero now, without editing recorded usage.
  "users.startNewBudgetPeriod": {
    admin: true,
    run: async (input) => {
      const sub = subjectOf(input.sub);
      await cognito(new AdminGetUserCommand({ UserPoolId: pool(), Username: sub }));
      const saved = await update(
        userKey(sub, sk.profile),
        expression({ add: { budgetEpoch: 1 } }),
      );
      return { budgetEpoch: saved.budgetEpoch };
    },
  },
  "users.setEnabled": {
    admin: true,
    run: async (input, identity) => {
      const sub = subjectOf(input.sub);
      if (typeof input.enabled !== "boolean") fail("VALIDATION_FAILED");
      if (sub === (await owner(identity.sub))) fail("PROTECTED_ADMIN");
      await cognito(
        new (input.enabled ? AdminEnableUserCommand : AdminDisableUserCommand)({
          UserPoolId: pool(),
          Username: sub,
        }),
      );
      forgetAuthorization(sub);
      return { enabled: input.enabled };
    },
  },
  // Adds the new group before removing any other, so a failure part-way leaves
  // several groups, which every token check rejects, never a wrong role.
  // Repeating the call repairs any membership, including none.
  "users.setRole": {
    admin: true,
    run: async (input, identity) => {
      const sub = subjectOf(input.sub);
      if (!roles.includes(input.role)) fail("VALIDATION_FAILED");
      if (sub === (await owner(identity.sub))) fail("PROTECTED_ADMIN");
      const current = await groupsOf(sub);
      const membership = (Command, group) =>
        idp.send(new Command({ UserPoolId: pool(), Username: sub, GroupName: group }));
      if (!current.includes(input.role))
        await membership(AdminAddUserToGroupCommand, input.role);
      for (const group of current)
        if (group !== input.role)
          await membership(AdminRemoveUserFromGroupCommand, group);
      forgetAuthorization(sub);
      return { role: input.role };
    },
  },
  "defaults.get": { admin: true, run: () => defaults() },
  "defaults.set": {
    admin: true,
    run: async (input) => {
      const { budgetMicroUsd, storageBytes, revision } = input;
      if (
        !Number.isSafeInteger(budgetMicroUsd) ||
        budgetMicroUsd < 0 ||
        !Number.isSafeInteger(storageBytes) ||
        storageBytes < 0 ||
        !period(input.period) ||
        !Number.isSafeInteger(revision)
      )
        fail("VALIDATION_FAILED");
      await defaults();
      const { pk, sk: sortKey, ...saved } = await revised(
        update(
          key(accountPk, "DEFAULTS"),
          expression({
            set: { budgetMicroUsd, storageBytes, period: input.period },
            add: { revision: 1 },
            condition: "#revision = :revision",
            values: { ":revision": revision },
          }),
        ),
      );
      return saved;
    },
  },
};
