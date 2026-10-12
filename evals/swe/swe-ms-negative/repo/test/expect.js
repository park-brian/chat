// expect.js's API (the part these tests use) on node:assert/strict, so the original tests run unchanged under
// `node --test` (and in test/index.html). Only the lines that required expect.js and ms became imports.
import assert from "node:assert/strict";

export default function expect(actual) {
  const throwError = expected => assert.throws(actual, expected);
  return {
    to: {
      be: expected => assert.strictEqual(actual, expected),
      equal: expected => assert.strictEqual(actual, expected),
      eql: expected => assert.deepStrictEqual(actual, expected),
      throwError, throwException: throwError,
      not: {
        be: expected => assert.notStrictEqual(actual, expected),
        equal: expected => assert.notStrictEqual(actual, expected),
        eql: expected => assert.notDeepStrictEqual(actual, expected),
        throwError: () => assert.doesNotThrow(actual),
        throwException: () => assert.doesNotThrow(actual),
      },
    },
  };
}
