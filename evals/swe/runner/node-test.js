// node:test for the browser, enough for this repository's tests: test/index.html maps "node:test" here, imports
// every test file, then calls run(). Each test logs PASS or FAIL, and window.TESTS_DONE holds the totals.
const root = { name: "", tests: [], beforeEach: [], afterEach: [], before: [], after: [] };
let current = root;

function add(name, options, fn) {
  if (typeof name === "function") [fn, name] = [name, name.name || "test"];
  if (typeof options === "function") fn = options;
  const node = { name: String(name), fn, parent: current, skip: options?.skip || options?.todo };
  current.tests.push(node);
}

export function test(name, options, fn) { add(name, options, fn); }
export const it = test;

export function describe(name, options, fn) {
  if (typeof options === "function") fn = options;
  const group = { name: String(name), tests: [], beforeEach: [], afterEach: [], before: [], after: [], parent: current, group: true };
  current.tests.push(group);
  const outer = current;
  current = group;
  try { fn?.(); } finally { current = outer; }
}
export const suite = describe;

export const beforeEach = fn => current.beforeEach.push(fn);
export const afterEach = fn => current.afterEach.push(fn);
export const before = fn => current.before.push(fn);
export const after = fn => current.after.push(fn);

const chain = node => { const out = []; for (let n = node.parent; n; n = n.parent) out.unshift(n); return out; };
const title = node => [...chain(node).map(n => n.name).filter(Boolean), node.name].join(" > ");

// A test with a second parameter is called with (t, done) and finishes when done is called.
function call(fn, t) {
  if (fn.length < 2) return fn(t);
  return new Promise((resolve, reject) => fn(t, e => (e ? reject(e) : resolve())));
}

// broken: test files that failed to load, counted as failures.
export async function run({ broken = 0 } = {}) {
  let passed = 0, failed = broken;
  const walk = async group => {
    for (const fn of group.before) await fn();
    for (const node of group.tests) {
      if (node.group) { await walk(node); continue; }
      if (node.skip) continue;
      const t = { name: node.name, test: (n, o, f) => add(n, o, f), diagnostic: m => console.log("# " + m), skip() {}, todo() {} };
      try {
        for (const g of chain(node)) for (const fn of g.beforeEach) await fn();
        await call(node.fn, t);
        for (const g of chain(node).reverse()) for (const fn of g.afterEach) await fn();
        passed++;
        console.log("PASS: " + title(node));
      } catch (e) {
        failed++;
        console.log("FAIL: " + title(node) + "\n   " + (e?.message ?? e));
      }
    }
    for (const fn of group.after) await fn();
  };
  await walk(root);
  window.TESTS_DONE = { passed, failed };
  return { passed, failed };
}

export default test;
