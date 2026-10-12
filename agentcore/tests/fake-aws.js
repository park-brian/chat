// In-memory stand-ins for the AWS calls the Runtime makes. The DynamoDB fake
// evaluates the real condition, update and key expressions, applies
// transactions atomically with per-item cancellation reasons, and rejects two
// operations on one item in a transaction, as DynamoDB does.
const clone = (value) => structuredClone(value);
const itemId = (key) => `${key.pk.S}|${key.sk.S}`;

// ---- Expression evaluation -------------------------------------------------
function tokenize(text) {
  const tokens = [];
  const pattern =
    /\s*(<>|<=|>=|=|<|>|\(|\)|,|\+|#\w+|:\w+|[A-Za-z_][\w.]*)/y;
  let match;
  pattern.lastIndex = 0;
  while (pattern.lastIndex < text.length && (match = pattern.exec(text)))
    tokens.push(match[1]);
  if (pattern.lastIndex < text.trimEnd().length)
    throw Error("Unparsed expression: " + text.slice(pattern.lastIndex));
  return tokens;
}
const scalar = (value) =>
  value === undefined
    ? undefined
    : value.N !== undefined
      ? Number(value.N)
      : value.S ?? value.BOOL ?? (value.NULL ? null : value);
const sizeOf = (value) =>
  value?.SS?.length ?? value?.L?.length ?? value?.S?.length ?? 0;

function evaluate(expression, item, names = {}, values = {}) {
  const tokens = tokenize(expression);
  let index = 0;
  const peek = () => tokens[index],
    next = () => tokens[index++],
    expect = (token) => {
      if (next() !== token) throw Error(`Expected ${token} in ${expression}`);
    };
  const path = (token) => (token.startsWith("#") ? names[token] : token);
  const operand = () => {
    const token = next();
    if (token.startsWith(":")) return values[token];
    if (token === "size") {
      expect("(");
      const name = path(next());
      expect(")");
      return { N: String(sizeOf(item?.[name])) };
    }
    return item?.[path(token)];
  };
  const compare = (left, operator, right) => {
    const a = scalar(left),
      b = scalar(right);
    if (operator === "=") return JSON.stringify(left) === JSON.stringify(right);
    if (operator === "<>") return JSON.stringify(left) !== JSON.stringify(right);
    if (a === undefined || b === undefined) return false;
    return operator === "<"
      ? a < b
      : operator === "<="
        ? a <= b
        : operator === ">"
          ? a > b
          : a >= b;
  };
  const primary = () => {
    if (peek() === "(") {
      next();
      const value = or();
      expect(")");
      return value;
    }
    if (peek() === "NOT") {
      next();
      return !primary();
    }
    if (["attribute_exists", "attribute_not_exists"].includes(peek())) {
      const fn = next();
      expect("(");
      const name = path(next());
      expect(")");
      return (item?.[name] !== undefined) === (fn === "attribute_exists");
    }
    if (peek() === "begins_with") {
      next();
      expect("(");
      const name = path(next());
      expect(",");
      const prefix = operand();
      expect(")");
      return String(scalar(item?.[name]) ?? "").startsWith(scalar(prefix));
    }
    const left = operand();
    const operator = next();
    if (operator === "BETWEEN") {
      const low = operand();
      expect("AND");
      const high = operand();
      return compare(left, ">=", low) && compare(left, "<=", high);
    }
    return compare(left, operator, operand());
  };
  const and = () => {
    let value = primary();
    while (peek() === "AND") {
      next();
      value = primary() && value;
    }
    return value;
  };
  const or = () => {
    let value = and();
    while (peek() === "OR") {
      next();
      value = and() || value;
    }
    return value;
  };
  const result = or();
  if (index !== tokens.length) throw Error("Trailing tokens in " + expression);
  return result;
}

function applyUpdate(item, expression, names = {}, values = {}) {
  const clauses = expression.split(/\b(?=SET |ADD |REMOVE |DELETE )/);
  const path = (token) => (token.startsWith("#") ? names[token] : token);
  for (const clause of clauses) {
    const [keyword, ...rest] = clause.trim().split(/\s+/);
    const body = rest.join(" ");
    const parts = body.split(/,\s*(?![^()]*\))/);
    for (const part of parts) {
      if (keyword === "SET") {
        const [target, source] = part.split(/\s*=\s*(.+)/);
        const ifMissing = /^if_not_exists\((\S+),\s*(:\w+)\)$/.exec(source.trim());
        const name = path(target.trim());
        if (ifMissing) {
          if (item[name] === undefined) item[name] = clone(values[ifMissing[2]]);
        } else item[name] = clone(values[source.trim()]);
      } else if (keyword === "REMOVE") delete item[path(part.trim())];
      else {
        const [target, placeholder] = part.trim().split(/\s+/);
        const name = path(target),
          value = values[placeholder];
        if (keyword === "ADD") {
          if (value.N !== undefined)
            item[name] = {
              N: String(Number(item[name]?.N || 0) + Number(value.N)),
            };
          else
            item[name] = {
              SS: [...new Set([...(item[name]?.SS || []), ...value.SS])],
            };
        } else {
          const kept = (item[name]?.SS || []).filter(
            (member) => !value.SS.includes(member),
          );
          if (kept.length) item[name] = { SS: kept };
          else delete item[name];
        }
      }
    }
  }
  return item;
}

const conditionFailure = () =>
  Object.assign(new Error("The conditional request failed"), {
    name: "ConditionalCheckFailedException",
  });

export function createDynamo() {
  const items = new Map(),
    tokens = new Map();
  const passes = (existing, input) =>
    !input.ConditionExpression ||
    evaluate(
      input.ConditionExpression,
      existing,
      input.ExpressionAttributeNames,
      input.ExpressionAttributeValues,
    );
  // One write, given whether its condition must be enforced here.
  const write = (type, input) => {
    const key = input.Key || { pk: input.Item.pk, sk: input.Item.sk };
    const existing = items.get(itemId(key));
    if (!passes(existing, input)) throw conditionFailure();
    if (type === "Put") items.set(itemId(key), clone(input.Item));
    if (type === "Delete") items.delete(itemId(key));
    if (type === "Update") {
      const next = applyUpdate(
        clone(existing || { pk: key.pk, sk: key.sk }),
        input.UpdateExpression,
        input.ExpressionAttributeNames,
        input.ExpressionAttributeValues,
      );
      items.set(itemId(key), next);
      return next;
    }
  };
  const query = (input) => {
    const gsi = Boolean(input.IndexName);
    const [hash, range] = gsi ? ["gsi1pk", "gsi1sk"] : ["pk", "sk"];
    const values = input.ExpressionAttributeValues;
    let rows = [...items.values()]
      .filter((row) => row[hash] && row[range])
      .filter((row) => evaluate(input.KeyConditionExpression, row, {}, values))
      .sort((a, b) =>
        a[range].S < b[range].S ? -1 : a[range].S > b[range].S ? 1 : 0,
      );
    if (input.ScanIndexForward === false) rows.reverse();
    if (input.ExclusiveStartKey) {
      const at = rows.findIndex(
        (row) => itemId(row) === itemId(input.ExclusiveStartKey),
      );
      rows = rows.slice(at + 1);
    }
    const limit = input.Limit ?? Infinity;
    const examined = rows.slice(0, limit);
    const more = rows.length > limit;
    const last = examined.at(-1);
    return {
      Items: examined
        .filter(
          (row) =>
            !input.FilterExpression ||
            evaluate(
              input.FilterExpression,
              row,
              input.ExpressionAttributeNames,
              values,
            ),
        )
        .map(clone),
      ...(more && {
        LastEvaluatedKey: {
          pk: last.pk,
          sk: last.sk,
          ...(gsi && { gsi1pk: last.gsi1pk, gsi1sk: last.gsi1sk }),
        },
      }),
    };
  };
  const interceptors = [];
  const fake = {
    items,
    // The next command matching `match` runs as `action(apply)` instead, so a
    // test can fail it, delay it, or act before or after it lands.
    once: (match, action) => interceptors.push({ match, action }),
    async send(command) {
      const at = interceptors.findIndex(({ match }) => match(command));
      if (at < 0) return fake.apply(command);
      const [{ action }] = interceptors.splice(at, 1);
      return action(() => fake.apply(command));
    },
    async apply(command) {
      const input = command.input;
      switch (command.constructor.name) {
        case "GetItemCommand":
          return { Item: clone(items.get(itemId(input.Key))) };
        case "BatchGetItemCommand": {
          const [table, request] = Object.entries(input.RequestItems)[0];
          return {
            Responses: {
              [table]: request.Keys.map((key) => items.get(itemId(key)))
                .filter(Boolean)
                .map(clone),
            },
          };
        }
        case "PutItemCommand":
          write("Put", input);
          return {};
        case "DeleteItemCommand":
          write("Delete", input);
          return {};
        case "UpdateItemCommand":
          return { Attributes: clone(write("Update", input)) };
        case "QueryCommand":
          return query(input);
        case "TransactWriteItemsCommand": {
          // The Runtime must always supply its own token (see db.transact);
          // reusing one with different contents is DynamoDB's mismatch error.
          if (!input.ClientRequestToken)
            throw Error("Transaction without an explicit ClientRequestToken");
          const contents = JSON.stringify(input.TransactItems);
          const seen = tokens.get(input.ClientRequestToken);
          if (seen !== undefined && seen !== contents)
            throw Object.assign(new Error("Token reused with different parameters"), {
              name: "IdempotentParameterMismatchException",
            });
          tokens.set(input.ClientRequestToken, contents);
          const operations = input.TransactItems.map((entry) => {
            const [type, operation] = Object.entries(entry)[0];
            return { type, operation };
          });
          const keys = operations.map(({ operation }) =>
            itemId(operation.Key || operation.Item),
          );
          if (new Set(keys).size !== keys.length)
            throw Object.assign(
              new Error("Transaction request cannot include multiple operations on one item"),
              { name: "ValidationException" },
            );
          const reasons = operations.map(({ operation }, position) => ({
            Code: passes(items.get(keys[position]), operation)
              ? "None"
              : "ConditionalCheckFailed",
          }));
          if (reasons.some((reason) => reason.Code !== "None"))
            throw Object.assign(new Error("Transaction cancelled"), {
              name: "TransactionCanceledException",
              CancellationReasons: reasons,
            });
          for (const { type, operation } of operations)
            if (type !== "ConditionCheck")
              write(type, { ...operation, ConditionExpression: undefined });
          return {};
        }
        default:
          throw Error("Fake DynamoDB does not support " + command.constructor.name);
      }
    },
  };
  return fake;
}

export function createS3() {
  const objects = new Map();
  let version = 0;
  const body = (bytes) => ({
    transformToString: async () => Buffer.from(bytes).toString("utf8"),
  });
  const missing = () =>
    Object.assign(new Error("Not Found"), {
      name: "NotFound",
      $metadata: { httpStatusCode: 404 },
    });
  const latest = (key) => objects.get(key)?.at(-1);
  const put = (key, bytes, contentType) => {
    const saved = {
      VersionId: String(++version),
      Body: Buffer.from(bytes),
      ContentType: contentType,
    };
    objects.set(key, [...(objects.get(key) || []), saved]);
    return saved;
  };
  return {
    objects,
    put,
    async send(command) {
      const input = command.input;
      switch (command.constructor.name) {
        case "PutObjectCommand":
          return { VersionId: put(input.Key, input.Body, input.ContentType).VersionId };
        case "GetObjectCommand": {
          const found = input.VersionId
            ? objects.get(input.Key)?.find((entry) => entry.VersionId === input.VersionId)
            : latest(input.Key);
          if (!found) throw missing();
          return { Body: body(found.Body), ContentLength: found.Body.length };
        }
        case "HeadObjectCommand": {
          const found = latest(input.Key);
          if (!found) throw missing();
          return { ContentLength: found.Body.length, VersionId: found.VersionId };
        }
        case "CopyObjectCommand": {
          const [path, version] = input.CopySource.split("?versionId=");
          const key = path.split("/").slice(1).join("/");
          const source = version
            ? objects.get(key)?.find((entry) => entry.VersionId === version)
            : latest(key);
          if (!source) throw missing();
          return { VersionId: put(input.Key, source.Body, input.ContentType).VersionId };
        }
        case "DeleteObjectCommand":
        case "DeleteObjectsCommand": {
          for (const target of input.Delete?.Objects || [input]) {
            const remaining = (objects.get(target.Key) || []).filter(
              (entry) => target.VersionId && entry.VersionId !== target.VersionId,
            );
            if (remaining.length) objects.set(target.Key, remaining);
            else objects.delete(target.Key);
          }
          return {};
        }
        case "ListObjectsV2Command":
          return {
            Contents: [...objects.keys()]
              .filter((key) => key.startsWith(input.Prefix))
              .map((Key) => ({ Key })),
          };
        case "ListObjectVersionsCommand":
          return {
            Versions: [...objects.entries()]
              .filter(([key]) => key.startsWith(input.Prefix))
              .flatMap(([Key, versions]) =>
                versions.map(({ VersionId }) => ({ Key, VersionId })),
              ),
          };
        default:
          throw Error("Fake S3 does not support " + command.constructor.name);
      }
    },
  };
}

export function createCognito() {
  const users = new Map();
  const attributes = (user) => [
    { Name: "sub", Value: user.sub },
    { Name: "email", Value: user.email },
  ];
  const find = (username) => {
    const user =
      users.get(username) ||
      [...users.values()].find((entry) => entry.email === username);
    if (!user)
      throw Object.assign(new Error("User does not exist."), {
        name: "UserNotFoundException",
      });
    return user;
  };
  return {
    users,
    add: (user) => users.set(user.sub, { enabled: true, ...user }),
    async send(command) {
      const input = command.input;
      switch (command.constructor.name) {
        case "AdminGetUserCommand": {
          const user = find(input.Username);
          return {
            Username: user.sub,
            Enabled: user.enabled,
            UserStatus: "CONFIRMED",
            UserAttributes: attributes(user),
          };
        }
        case "AdminListGroupsForUserCommand":
          return {
            Groups: find(input.Username).groups.map((GroupName) => ({ GroupName })),
          };
        case "ListUsersCommand":
          return {
            Users: [...users.values()].map((user) => ({
              Username: user.sub,
              Enabled: user.enabled,
              UserStatus: "CONFIRMED",
              Attributes: attributes(user),
            })),
          };
        case "AdminCreateUserCommand": {
          if ([...users.values()].some((user) => user.email === input.Username))
            throw Object.assign(new Error("User account already exists"), {
              name: "UsernameExistsException",
            });
          const sub = crypto.randomUUID();
          users.set(sub, {
            sub,
            email: input.Username,
            enabled: true,
            groups: [],
          });
          return {};
        }
        case "AdminAddUserToGroupCommand":
          find(input.Username).groups.push(input.GroupName);
          return {};
        case "AdminRemoveUserFromGroupCommand": {
          const user = find(input.Username);
          user.groups = user.groups.filter((group) => group !== input.GroupName);
          return {};
        }
        case "AdminEnableUserCommand":
          find(input.Username).enabled = true;
          return {};
        case "AdminDisableUserCommand":
          find(input.Username).enabled = false;
          return {};
        default:
          throw Error("Fake Cognito does not support " + command.constructor.name);
      }
    },
  };
}
