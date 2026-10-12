// node:assert for the browser, enough for this repository's tests: test/index.html maps "node:assert" here and
// "node:assert/strict" to assert-strict.js. Same names and the same rules as Node's, more or less.
export class AssertionError extends Error {
  constructor({ message, actual, expected, operator } = {}) {
    super(message ?? `${show(actual)} ${operator} ${show(expected)}`);
    Object.assign(this, { name: "AssertionError", actual, expected, operator, code: "ERR_ASSERTION" });
  }
}

function show(v) {
  try {
    if (typeof v === "string") return JSON.stringify(v);
    if (typeof v === "function") return `[Function ${v.name || "anonymous"}]`;
    if (typeof v === "symbol" || typeof v === "bigint") return String(v);
    if (v instanceof Map) return `Map(${JSON.stringify([...v])})`;
    if (v instanceof Set) return `Set(${JSON.stringify([...v])})`;
    return JSON.stringify(v) ?? String(v);
  } catch { return String(v); }
}

const fail = (message, actual, expected, operator) => {
  if (message instanceof Error) throw message;
  throw new AssertionError({ message, actual, expected, operator });
};

const tag = v => Object.prototype.toString.call(v);

export function isDeepEqual(a, b, strict, seen = new Map()) {
  if (strict ? Object.is(a, b) : a == b || (a !== a && b !== b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (tag(a) !== tag(b)) return false;
  if (seen.get(a) === b) return true;
  seen.set(a, b);
  if (a instanceof Date) { if (a.getTime() !== b.getTime()) return false; }
  else if (a instanceof RegExp) { if (a.source !== b.source || a.flags !== b.flags || a.lastIndex !== b.lastIndex) return false; }
  else if (a instanceof Error) { if (a.message !== b.message || a.name !== b.name) return false; }
  else if (ArrayBuffer.isView(a) || a instanceof ArrayBuffer) {
    const x = new Uint8Array(a.buffer ?? a, a.byteOffset ?? 0, a.byteLength), y = new Uint8Array(b.buffer ?? b, b.byteOffset ?? 0, b.byteLength);
    if (x.length !== y.length || x.some((v, i) => v !== y[i])) return false;
    if (ArrayBuffer.isView(a) && !(a instanceof DataView)) return true;
  } else if (a instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (b.has(k)) { if (!isDeepEqual(v, b.get(k), strict, seen)) return false; continue; }
      if (typeof k !== "object" || k === null) return false;
      if (![...b].some(([k2, v2]) => isDeepEqual(k, k2, strict, seen) && isDeepEqual(v, v2, strict, seen))) return false;
    }
  } else if (a instanceof Set) {
    if (a.size !== b.size) return false;
    for (const v of a) {
      if (b.has(v)) continue;
      if (typeof v !== "object" || v === null) return false;
      if (![...b].some(w => isDeepEqual(v, w, strict, seen))) return false;
    }
  }
  if (Array.isArray(a) && a.length !== b.length) return false;
  const keys = o => [...Object.keys(o), ...(strict ? Object.getOwnPropertySymbols(o).filter(s => Object.prototype.propertyIsEnumerable.call(o, s)) : [])];
  const ka = keys(a), kb = keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!isDeepEqual(a[k], b[k], strict, seen)) return false;
  }
  return true;
}

function matches(error, expected) {
  if (expected === undefined) return true;
  if (expected instanceof RegExp) return expected.test(String(error?.message ?? error)) || expected.test(String(error));
  if (typeof expected === "function") {
    if (expected.prototype !== undefined && error instanceof expected) return true;
    if (Error.isPrototypeOf(expected) || expected === Error) return false;
    return expected.call({}, error) === true;
  }
  if (typeof expected === "object" && expected) {
    return Object.keys(expected).every(k => (expected[k] instanceof RegExp && typeof error?.[k] === "string" ? expected[k].test(error[k]) : isDeepEqual(error?.[k], expected[k], true)));
  }
  return true;
}

export function makeAssert(strict) {
  const ok = (value, message) => { if (!value) fail(message ?? `The expression evaluated to a falsy value: ${show(value)}`, value, true, "=="); };
  const strictEqual = (a, b, m) => { if (!Object.is(a, b)) fail(m, a, b, "strictEqual"); };
  const notStrictEqual = (a, b, m) => { if (Object.is(a, b)) fail(m, a, b, "notStrictEqual"); };
  const looseEqual = (a, b, m) => { if (!(a == b || (a !== a && b !== b))) fail(m, a, b, "=="); };
  const looseNotEqual = (a, b, m) => { if (a == b || (a !== a && b !== b)) fail(m, a, b, "!="); };
  const deepStrictEqual = (a, b, m) => { if (!isDeepEqual(a, b, true)) fail(m, a, b, "deepStrictEqual"); };
  const notDeepStrictEqual = (a, b, m) => { if (isDeepEqual(a, b, true)) fail(m, a, b, "notDeepStrictEqual"); };
  const looseDeepEqual = (a, b, m) => { if (!isDeepEqual(a, b, false)) fail(m, a, b, "deepEqual"); };
  const looseNotDeepEqual = (a, b, m) => { if (isDeepEqual(a, b, false)) fail(m, a, b, "notDeepEqual"); };
  const throws = (fn, expected, message) => {
    if (typeof expected === "string") [message, expected] = [expected, undefined];
    let threw = false, error;
    try { fn(); } catch (e) { threw = true; error = e; }
    if (!threw) fail(message ?? "Missing expected exception.", undefined, expected, "throws");
    if (!matches(error, expected)) throw error;
  };
  const doesNotThrow = (fn, message) => { try { fn(); } catch (e) { fail(typeof message === "string" ? message : `Got unwanted exception: ${e?.message ?? e}`, e, undefined, "doesNotThrow"); } };
  const rejects = async (promise, expected, message) => {
    if (typeof expected === "string") [message, expected] = [expected, undefined];
    let threw = false, error;
    try { await (typeof promise === "function" ? promise() : promise); } catch (e) { threw = true; error = e; }
    if (!threw) fail(message ?? "Missing expected rejection.", undefined, expected, "rejects");
    if (!matches(error, expected)) throw error;
  };
  const doesNotReject = async (promise, message) => { try { await (typeof promise === "function" ? promise() : promise); } catch (e) { fail(message ?? `Got unwanted rejection: ${e?.message ?? e}`, e, undefined, "doesNotReject"); } };
  const match = (s, re, m) => { if (!re.test(s)) fail(m ?? `The input did not match ${re}: ${show(s)}`, s, re, "match"); };
  const doesNotMatch = (s, re, m) => { if (re.test(s)) fail(m ?? `The input was expected not to match ${re}: ${show(s)}`, s, re, "doesNotMatch"); };
  const assert = (value, message) => ok(value, message);
  Object.assign(assert, {
    ok, strictEqual, notStrictEqual, deepStrictEqual, notDeepStrictEqual, throws, doesNotThrow, rejects, doesNotReject, match, doesNotMatch, AssertionError,
    equal: strict ? strictEqual : looseEqual,
    notEqual: strict ? notStrictEqual : looseNotEqual,
    deepEqual: strict ? deepStrictEqual : looseDeepEqual,
    notDeepEqual: strict ? notDeepStrictEqual : looseNotDeepEqual,
    fail: message => fail(message ?? "Failed", undefined, undefined, "fail"),
  });
  assert.strict = strict ? assert : null;
  return assert;
}

const assert = makeAssert(false);
export default assert;
export const { ok, equal, notEqual, strictEqual, notStrictEqual, deepEqual, notDeepEqual, deepStrictEqual, notDeepStrictEqual, throws, doesNotThrow, rejects, doesNotReject, match, doesNotMatch } = assert;
