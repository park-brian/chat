// uvu's API on node:test, so the original test files run unchanged under `node --test` (and in test/index.html).
// Only the import lines of the tests changed: 'uvu' became './uvu.js', 'uvu/assert' became './uvu-assert.js'.
import { test as nodeTest } from "node:test";

// A suite's context object is passed to each of its tests, as uvu does.
export function suite(name = "", context = {}) {
  const it = (title, fn) => nodeTest(name ? `${name} > ${title}` : title, () => fn(context));
  it.only = it;
  it.skip = () => {};
  it.run = () => {};
  return it;
}

export const test = suite();
