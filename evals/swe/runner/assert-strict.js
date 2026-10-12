// node:assert/strict for the browser: test/index.html maps it here.
import { makeAssert, AssertionError } from "./assert.js";

const assert = makeAssert(true);
export default assert;
export { AssertionError };
export const { ok, equal, notEqual, strictEqual, notStrictEqual, deepEqual, notDeepEqual, deepStrictEqual, notDeepStrictEqual, throws, doesNotThrow, rejects, doesNotReject, match, doesNotMatch } = assert;
