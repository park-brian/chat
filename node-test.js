// node:test and node:assert for the browser, so a project's test files run here as `node --test` runs them. run_app
// on a test file (or a folder of them) serves a page whose import map points node:test, node:assert,
// node:assert/strict, assert, uvu, uvu/assert and tape at this module, imports each file, and calls runFiles. Each test
// logs "PASS: name" or "FAIL: name\n   message (at file:line:col)"; the totals go to window.TESTS_DONE, which the run
// report reads. The swe tier's repositories carry a copy as test/browser/node-test.js (evals/swe.js).
// Counts follow Node's: every test and subtest is one, a parent fails when a subtest does, suites aren't counted.

// #region assert
export class AssertionError extends Error {
  constructor({ message, actual, expected, operator } = {}) {
    super(message ?? `${show(actual)} ${operator} ${show(expected)}`);
    Object.assign(this, { name: "AssertionError", actual, expected, operator, code: "ERR_ASSERTION", generatedMessage: message == null });
  }
}

function show(v) {
  try {
    if (typeof v === "string") return JSON.stringify(v);
    if (typeof v === "function") return `[Function ${v.name || "anonymous"}]`;
    if (typeof v === "symbol" || typeof v === "bigint" || v === undefined || Number.isNaN(v)) return String(v);
    if (v instanceof Map) return `Map(${JSON.stringify([...v])})`;
    if (v instanceof Set) return `Set(${JSON.stringify([...v])})`;
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    if (v instanceof RegExp) return String(v);
    const text = JSON.stringify(v, (k, x) => (x === undefined ? "undefined" : typeof x === "bigint" ? String(x) : x));
    return text === undefined ? String(v) : text.length > 400 ? text.slice(0, 400) + "…" : text;
  } catch { return String(v); }
}

// What Node says when an assertion has no message of its own.
const SAYS = {
  strictEqual: ["Expected values to be strictly equal:", "!=="],
  notStrictEqual: ['Expected "actual" to be strictly unequal to:', "==="],
  deepStrictEqual: ["Expected values to be strictly deep-equal:", "!=="],
  notDeepStrictEqual: ['Expected "actual" not to be strictly deep-equal to:', "==="],
  deepEqual: ["Expected values to be loosely deep-equal:", "!="],
  notDeepEqual: ['Expected "actual" not to be loosely deep-equal to:', "=="],
  "==": ["Expected values to be loosely equal:", "!="],
  "!=": ['Expected "actual" to be loosely unequal to:', "=="],
};

const fail = (message, actual, expected, operator) => {
  if (message instanceof Error) throw message;
  const says = SAYS[operator];
  throw new AssertionError({ message: message ?? (says && `${says[0]} ${show(actual)} ${says[1]} ${show(expected)}`), actual, expected, operator });
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
  const match = (s, re, m) => { if (!re.test(s)) fail(m ?? `The input did not match the regular expression ${re}. Input: ${show(s)}`, s, re, "match"); };
  const doesNotMatch = (s, re, m) => { if (re.test(s)) fail(m ?? `The input was expected to not match the regular expression ${re}. Input: ${show(s)}`, s, re, "doesNotMatch"); };
  const ifError = value => { if (value !== null && value !== undefined) { if (value instanceof Error) throw value; fail(`ifError got unwanted exception: ${show(value)}`, value, null, "ifError"); } };
  const assert = (value, message) => ok(value, message);
  Object.assign(assert, {
    ok, strictEqual, notStrictEqual, deepStrictEqual, notDeepStrictEqual, throws, doesNotThrow, rejects, doesNotReject, match, doesNotMatch, ifError, AssertionError,
    equal: strict ? strictEqual : looseEqual,
    notEqual: strict ? notStrictEqual : looseNotEqual,
    deepEqual: strict ? deepStrictEqual : looseDeepEqual,
    notDeepEqual: strict ? notDeepStrictEqual : looseNotDeepEqual,
    fail: message => fail(message ?? "Failed", undefined, undefined, "fail"),
  });
  return assert;
}

export const strict = makeAssert(true);
export const assert = makeAssert(false);
assert.strict = strict.strict = strict;
// #endregion

// #region node:test
const group = (name, parent) => ({ name, parent, tests: [], before: [], after: [], beforeEach: [], afterEach: [], group: true });
let root = group("", null);
let current = root;

// test(name?, options?, fn?) in any of Node's shapes.
function shape(args) {
  let [name, options, fn] = args;
  if (typeof name === "function") [fn, options, name] = [name, {}, name.name || "<anonymous>"];
  else if (typeof name === "object" && name !== null) [fn, options, name] = [options, name, "<anonymous>"];
  if (typeof options === "function") [fn, options] = [options, {}];
  return { name: String(name ?? "<anonymous>"), options: options ?? {}, fn };
}

function addTest(parent, args, extra = {}) {
  const { name, options, fn } = shape(args);
  const node = { name, fn, parent, ...options, ...extra };
  parent.tests.push(node);
  return node;
}

function addSuite(args, extra = {}) {
  const { name, options, fn } = shape(args);
  const node = Object.assign(group(name, current), options, extra);
  current.tests.push(node);
  const outer = current;
  current = node;
  try { node.ready = fn?.({ name, signal: new AbortController().signal }); }
  catch (e) { node.error = e; }
  finally { current = outer; }
  return node;
}

const variants = (fn, extra) => Object.assign(fn, {
  skip: (...a) => extra(a, { skip: true }),
  todo: (...a) => extra(a, { todo: true }),
  only: (...a) => extra(a, { only: true }),
});
export const test = variants((...a) => void addTest(current, a), (a, x) => void addTest(current, a, x));
export const it = test;
export const describe = variants((...a) => void addSuite(a), (a, x) => void addSuite(a, x));
export const suite = describe;
export const before = fn => void current.before.push(fn);
export const after = fn => void current.after.push(fn);
export const beforeEach = fn => void current.beforeEach.push(fn);
export const afterEach = fn => void current.afterEach.push(fn);

// mock.fn and mock.method, the parts tests reach for most.
function mockFn(original = () => {}, implementation = original) {
  let impl = implementation;
  const calls = [];
  const fn = function (...args) {
    const call = { arguments: args, this: this, result: undefined, error: undefined };
    calls.push(call);
    try { return (call.result = new.target ? Reflect.construct(impl, args, new.target) : impl.apply(this, args)); }
    catch (e) { call.error = e; throw e; }
  };
  fn.mock = {
    calls,
    callCount: () => calls.length,
    mockImplementation: next => { impl = next; },
    mockImplementationOnce: next => { const prev = impl; impl = function (...a) { impl = prev; return next.apply(this, a); }; },
    resetCalls: () => { calls.length = 0; },
    restore: () => { impl = original; },
  };
  return fn;
}
const restorers = [];
export const mock = {
  fn: mockFn,
  method(object, name, implementation) {
    const original = object[name];
    const fn = mockFn(original, implementation ?? original);
    object[name] = fn;
    const restore = () => { object[name] = original; };
    fn.mock.restore = restore;
    restorers.push(restore);
    return fn;
  },
  reset() { this.restoreAll(); },
  restoreAll() { while (restorers.length) restorers.pop()(); },
};

const chain = node => { const out = []; for (let n = node.parent; n; n = n.parent) out.unshift(n); return out; };
const title = node => [...chain(node).map(n => n.name).filter(Boolean), node.name].join(" > ");
const hasOnly = node => node.only || (node.tests ?? []).some(hasOnly);

// Where an error was thrown in the workspace's files: the first stack frame under base, as path:line:col.
function where(error, base) {
  if (!base) return "";
  for (const line of String(error?.stack ?? "").split("\n")) {
    const m = /((?:https?|file):\/\/[^\s()]+?):(\d+):(\d+)/.exec(line);
    if (m && m[1].startsWith(base)) return `${decodeURIComponent(m[1].slice(base.length))}:${m[2]}:${m[3]}`;
  }
  return "";
}
const describeError = (e, base) => {
  // A workspace file goes by its path in it ("Failed to fetch dynamically imported module: test/a.test.js").
  const message = (base ? String(e?.message ?? e).split(base).join("") : String(e?.message ?? e)).trim() || String(e?.name ?? "Error");
  const at = where(e, base);
  return (e?.name && e.name !== "Error" && e.name !== "AssertionError" && !message.startsWith(e.name) ? `${e.name}: ` : "") + message + (at ? ` (at ${at})` : "");
};

// A function that takes (t, done) finishes when done is called; timeout: the test's own limit, in ms.
function call(fn, ctx, timeout) {
  const run = fn.length >= 2 ? new Promise((resolve, reject) => { try { fn(ctx, e => (e ? reject(e) : resolve())); } catch (e) { reject(e); } }) : Promise.resolve().then(() => fn(ctx));
  if (!(timeout > 0 && timeout < Infinity)) return run;
  let timer;
  return Promise.race([run, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`test timed out after ${timeout}ms`)), timeout); })]).finally(() => clearTimeout(timer));
}

function createRun({ base = "", log = console.log } = {}) {
  const tally = { passed: 0, failed: 0, skipped: 0, todo: 0 };
  let only = false;

  // One test, its hooks and its subtests. Answers whether it passed.
  async function runTest(node, hooks) {
    const name = title(node);
    if (node.skip) { tally.skipped++; return true; }
    if (!node.fn && node.todo) { tally.todo++; return true; }
    const sub = group(node.name, node.parent);
    sub.test = node;
    let queue = Promise.resolve(), subFailed = 0, skipped = false, todo = !!node.todo;
    const ctx = {
      name: node.name,
      fullName: name,
      signal: new AbortController().signal,
      assert: strict,
      mock,
      test: (...a) => {
        const child = addTest(sub, a);
        const done = queue.then(() => runTest(child, [...hooks, sub]));
        queue = done.then(ok => { if (!ok) subFailed++; }, () => { subFailed++; });
        return done.then(() => undefined);
      },
      skip: () => { skipped = true; },
      todo: () => { todo = true; },
      diagnostic: m => log("# " + m),
      plan() {},
      before: fn => sub.before.push(fn),
      after: fn => sub.after.push(fn),
      beforeEach: fn => sub.beforeEach.push(fn),
      afterEach: fn => sub.afterEach.push(fn),
    };
    let error = null;
    try {
      for (const g of hooks) for (const fn of g.beforeEach) await fn(ctx);
      await call(node.fn ?? (() => {}), ctx, node.timeout);
      await queue;
    } catch (e) { error = e; }
    try { for (const g of [...hooks].reverse()) for (const fn of g.afterEach) await fn(ctx); }
    catch (e) { error ??= e; }
    if (!error && subFailed) error = new Error(`${subFailed} subtest${subFailed > 1 ? "s" : ""} failed`);
    if (skipped && !error) { tally.skipped++; return true; }
    if (todo) { tally.todo++; return true; }
    if (error) { tally.failed++; log(`FAIL: ${name}\n   ${describeError(error, base)}`); return false; }
    tally.passed++;
    log("PASS: " + name);
    return true;
  }

  const count = n => (n.group ? n.tests.reduce((s, t) => s + count(t), 0) : 1);
  // focus: with only in the file, whether everything in this suite runs (it is marked only, or inside one that is).
  async function runGroup(node, hooks, focus) {
    if (node.ready) { try { await node.ready; } catch (e) { node.error ??= e; } }
    if (node.error) { tally.failed++; log(`FAIL: ${title(node)}\n   ${describeError(node.error, base)}`); return; }
    if (node.skip || node.todo) { if (node.todo) tally.todo += count(node); else tally.skipped += count(node); return; }
    const scope = [...hooks, node];
    try { for (const fn of node.before) await fn(); }
    catch (e) { tally.failed++; log(`FAIL: ${title(node) || "before"}\n   ${describeError(e, base)}`); return; }
    // Inside a focused suite, only its focused tests run when some are; else all of them.
    const narrowed = node.tests.some(hasOnly);
    for (const child of node.tests) {
      const runs = !only || child.only || (child.group && hasOnly(child)) || (focus && !narrowed);
      if (!runs) { tally.skipped += count(child); continue; }
      if (child.group) await runGroup(child, scope, !only || child.only || (focus && !narrowed));
      else await runTest(child, scope);
    }
    try { for (const fn of node.after) await fn(); }
    catch (e) { tally.failed++; log(`FAIL: ${title(node) || "after"}\n   ${describeError(e, base)}`); }
  }

  return {
    tally,
    async run(top) {
      only = hasOnly(top);
      await runGroup(top, [], !only);
      mock.restoreAll();
      return tally;
    },
  };
}

// Runs the tests registered so far (by files already imported) and starts afresh. broken: files that failed to load,
// counted as failures. Sets window.TESTS_DONE, as test/index.html in the swe repositories expects. log: where each
// PASS and FAIL line goes (the shell's node --test prints them as Node does).
export async function run({ broken = 0, base = "", log = console.log } = {}) {
  const top = root;
  root = current = group("", null);
  const { passed, failed, skipped, todo } = await createRun({ base, log }).run(top);
  const result = { passed, failed: failed + broken, skipped, todo };
  if (typeof window !== "undefined") window.TESTS_DONE = result;
  return result;
}

// How many tests and suites are registered and not yet run: `node file.test.js` runs them when the file settles.
export const registered = () => root.tests.length;

// Imports each file (a URL relative to base) and runs its tests before the next, as `node --test` runs each file on
// its own. Answers the totals, and each file's when there are several.
export async function runFiles(files, { base = "" } = {}) {
  const sum = { passed: 0, failed: 0, skipped: 0, todo: 0 }, each = [];
  for (const file of files) {
    root = current = group("", null);
    let counts;
    try {
      await import(new URL(file, base || location.href).href);
      counts = await createRun({ base }).run(root);
    } catch (e) {
      console.log(`FAIL: ${file.replace(/^\.\//, "")} failed to load\n   ${describeError(e, base)}`);
      counts = { passed: 0, failed: 1, skipped: 0, todo: 0 };
    }
    for (const k of Object.keys(sum)) sum[k] += counts[k];
    each.push({ file: file.replace(/^\.\//, ""), passed: counts.passed, failed: counts.failed });
  }
  root = current = group("", null);
  return { ...sum, ...(files.length > 1 && { files: each }) };
}

export default test;
// #endregion

// #region other runners, on the same tests
// uvu: suite(name, context) and test, each test called with the suite's context.
export function uvuSuite(name = "", context = {}) {
  const it = (title, fn) => test(name ? `${name} > ${title}` : title, () => fn(context));
  it.only = (title, fn) => test.only(name ? `${name} > ${title}` : title, () => fn(context));
  it.skip = title => test.skip(name ? `${name} > ${title}` : title, () => {});
  it.before = fn => before(() => fn(context));
  it.after = fn => after(() => fn(context));
  it.before.each = fn => beforeEach(() => fn(context));
  it.after.each = fn => afterEach(() => fn(context));
  it.run = () => {};
  return it;
}
export const uvuTest = uvuSuite();

const typeOf = v => (v === null ? "null" : typeof v);
const not = (value, msg) => strict.ok(!value, msg);
Object.assign(not, {
  ok: not,
  equal: (a, b, msg) => strict.notDeepStrictEqual(a, b, msg),
  type: (value, kind, msg) => strict.notStrictEqual(typeOf(value), kind, msg),
  instance: (value, Ctor, msg) => strict.ok(!(value instanceof Ctor), msg ?? `Expected value not to be an instance of ${Ctor.name}`),
  match: (value, expects, msg) => (typeof expects === "string" ? strict.ok(!value.includes(expects), msg) : strict.doesNotMatch(value, expects, msg)),
  snapshot: (a, b, msg) => strict.notStrictEqual(a, b, msg),
  fixture: (a, b, msg) => strict.notStrictEqual(a, b, msg),
  throws: (fn, msg) => { try { fn(); } catch (e) { strict.fail(msg ?? `Expected function not to throw: ${e?.message ?? e}`); } },
});
const is = (a, b, msg) => strict.strictEqual(a, b, msg);
is.not = (a, b, msg) => strict.notStrictEqual(a, b, msg);
export const uvuAssert = {
  ok: (value, msg) => strict.ok(value, msg),
  is,
  equal: (a, b, msg) => strict.deepStrictEqual(a, b, msg),
  type: (value, kind, msg) => strict.strictEqual(typeOf(value), kind, msg ?? `Expected "${typeOf(value)}" to be "${kind}"`),
  instance: (value, Ctor, msg) => strict.ok(value instanceof Ctor, msg ?? `Expected value to be an instance of ${Ctor.name}`),
  match: (value, expects, msg) => (typeof expects === "string" ? strict.ok(value.includes(expects), msg ?? `Expected ${JSON.stringify(value)} to include ${JSON.stringify(expects)}`) : strict.match(value, expects, msg)),
  snapshot: (a, b, msg) => strict.strictEqual(a, b, msg),
  fixture: (a, b, msg) => strict.strictEqual(a, b, msg),
  throws(fn, expects, msg) {
    let threw = false, error;
    try { fn(); } catch (e) { threw = true; error = e; }
    strict.ok(threw, msg ?? "Expected function to throw");
    if (typeof expects === "string") strict.ok(String(error?.message).includes(expects), msg ?? `Expected error message to include ${JSON.stringify(expects)}`);
    else if (expects instanceof RegExp) strict.match(String(error?.message), expects, msg);
    else if (typeof expects === "function") strict.ok(expects(error), msg ?? "Expected the thrown error to satisfy the predicate");
  },
  unreachable: msg => strict.fail(msg ?? "Expected not to be reached!"),
  not,
  Assertion: AssertionError,
};

// tape: test(name, t => { t.equal(...); t.end(); }).
export function tape(name, options, fn) {
  if (typeof options === "function") fn = options;
  test(name, () => new Promise((resolve, reject) => {
    let planned = null, count = 0, ended = false;
    const counted = f => (...a) => { count++; f(...a); if (planned != null && count >= planned) end(); };
    const end = e => { if (ended) return; ended = true; e ? reject(e) : resolve(); };
    const t = {
      equal: counted(strict.strictEqual), equals: counted(strict.strictEqual), is: counted(strict.strictEqual), strictEqual: counted(strict.strictEqual),
      notEqual: counted(strict.notStrictEqual), isNot: counted(strict.notStrictEqual),
      deepEqual: counted(strict.deepStrictEqual), same: counted(strict.deepStrictEqual), deepLooseEqual: counted(assert.deepEqual),
      notDeepEqual: counted(strict.notDeepStrictEqual), notSame: counted(strict.notDeepStrictEqual),
      ok: counted(strict.ok), true: counted(strict.ok), notOk: counted((v, m) => strict.ok(!v, m)), false: counted((v, m) => strict.ok(!v, m)),
      throws: counted(strict.throws), doesNotThrow: counted(strict.doesNotThrow), match: counted(strict.match),
      error: counted((e, m) => { if (e) throw e instanceof Error ? e : new Error(m ?? String(e)); }),
      pass: counted(() => {}), fail: m => strict.fail(m), plan: n => { planned = n; }, end: e => end(e), comment() {},
    };
    try {
      const out = fn(t);
      // An async test ends when it returns; a sync one when it calls end, plans out, or returns without either.
      Promise.resolve(out).then(() => { if (out instanceof Promise || planned == null) end(); }, end);
    } catch (e) { end(e); }
  }));
}
// #endregion
