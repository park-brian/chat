// uvu/assert on node:assert/strict, so the original test files run unchanged (see uvu.js).
import assert from "node:assert/strict";

const typeOf = v => (v === null ? "null" : typeof v);

export function ok(value, msg) { assert.ok(value, msg); }
export function is(actual, expects, msg) { assert.strictEqual(actual, expects, msg); }
export function equal(actual, expects, msg) { assert.deepStrictEqual(actual, expects, msg); }
export function type(value, kind, msg) { assert.strictEqual(typeOf(value), kind, msg ?? `Expected "${typeOf(value)}" to be "${kind}"`); }
export function instance(value, Ctor, msg) { assert.ok(value instanceof Ctor, msg ?? `Expected value to be an instance of ${Ctor.name}`); }
export function match(value, expects, msg) {
  if (typeof expects === "string") assert.ok(value.includes(expects), msg ?? `Expected ${JSON.stringify(value)} to include ${JSON.stringify(expects)}`);
  else assert.match(value, expects, msg);
}
export function snapshot(actual, expects, msg) { assert.strictEqual(actual, expects, msg); }
export function fixture(actual, expects, msg) { assert.strictEqual(actual, expects, msg); }
export function throws(fn, expects, msg) {
  let threw = false, error;
  try { fn(); } catch (e) { threw = true; error = e; }
  assert.ok(threw, msg ?? "Expected function to throw");
  if (typeof expects === "string") assert.ok(String(error?.message).includes(expects), msg ?? `Expected error message to include ${JSON.stringify(expects)}`);
  else if (expects instanceof RegExp) assert.match(String(error?.message), expects, msg);
  else if (typeof expects === "function") assert.ok(expects(error), msg ?? "Expected the thrown error to satisfy the predicate");
}
export function unreachable(msg) { assert.fail(msg ?? "Expected not to be reached!"); }

export function not(value, msg) { assert.ok(!value, msg); }
not.ok = not;
not.equal = (actual, expects, msg) => assert.notDeepStrictEqual(actual, expects, msg);
not.type = (value, kind, msg) => assert.notStrictEqual(typeOf(value), kind, msg);
not.instance = (value, Ctor, msg) => assert.ok(!(value instanceof Ctor), msg ?? `Expected value not to be an instance of ${Ctor.name}`);
not.match = (value, expects, msg) => {
  if (typeof expects === "string") assert.ok(!value.includes(expects), msg);
  else assert.doesNotMatch(value, expects, msg);
};
not.snapshot = not.fixture = (actual, expects, msg) => assert.notStrictEqual(actual, expects, msg);
not.throws = (fn, msg) => { try { fn(); } catch (e) { assert.fail(msg ?? `Expected function not to throw: ${e?.message ?? e}`); } };
is.not = (actual, expects, msg) => assert.notStrictEqual(actual, expects, msg);
