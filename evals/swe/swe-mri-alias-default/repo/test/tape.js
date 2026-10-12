// tape's API on node:test, so the original test files run unchanged under `node --test` (and in test/index.html).
// Only the require lines of the tests changed, to imports of this file and ../lib/index.js.
import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";

export default function test(name, fn) {
  nodeTest(name, () => {
    const t = {
      equal: assert.strictEqual, equals: assert.strictEqual, is: assert.strictEqual, strictEqual: assert.strictEqual,
      notEqual: assert.notStrictEqual, isNot: assert.notStrictEqual,
      deepEqual: assert.deepStrictEqual, same: assert.deepStrictEqual,
      notDeepEqual: assert.notDeepStrictEqual, notSame: assert.notDeepStrictEqual,
      ok: assert.ok, true: assert.ok, notOk: (v, m) => assert.ok(!v, m), false: (v, m) => assert.ok(!v, m),
      throws: assert.throws, doesNotThrow: assert.doesNotThrow,
      pass() {}, fail: m => assert.fail(m), plan() {}, end() {}, comment() {},
    };
    fn(t);
  });
}
