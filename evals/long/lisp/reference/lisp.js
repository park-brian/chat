// The reference interpreter for the long-lisp task: the spec in evals/long.js, written to pass every hidden program.
// The grader's offline test (evals/long.test.js) runs the hidden suite against it and expects 100%.
// Data: numbers, strings and booleans are JavaScript's; symbols are interned Sym objects; lists are Pairs ending in NIL.

class Sym { constructor(name) { this.name = name; } }
const SYMBOLS = new Map();
const sym = name => { let s = SYMBOLS.get(name); if (!s) SYMBOLS.set(name, (s = new Sym(name))); return s; };
class Pair { constructor(car, cdr) { this.car = car; this.cdr = cdr; } }
const NIL = Object.freeze({ nil: true });
const UNSPECIFIED = Object.freeze({ unspecified: true });
class Lambda { constructor(params, body, env) { Object.assign(this, { params, body, env }); } }
class Macro { constructor(params, body, env) { Object.assign(this, { params, body, env }); } }
class LispError extends Error {}
const fail = message => { throw new LispError(message); };

class Env {
  constructor(outer = null) { this.vars = new Map(); this.outer = outer; }
  lookup(s) {
    for (let e = this; e; e = e.outer) if (e.vars.has(s)) return e.vars.get(s);
    return fail(`unbound variable: ${s.name}`);
  }
  define(s, v) { this.vars.set(s, v); }
  set(s, v) {
    for (let e = this; e; e = e.outer) if (e.vars.has(s)) return void e.vars.set(s, v);
    fail(`set! of unbound variable: ${s.name}`);
  }
}

const list = (...xs) => xs.reduceRight((tail, x) => new Pair(x, tail), NIL);
function toArray(x) {
  const out = [];
  for (; x instanceof Pair; x = x.cdr) out.push(x.car);
  if (x !== NIL) fail("not a proper list");
  return out;
}

// Reading.
function tokenize(source) {
  const tokens = [];
  const re = /\s+|;[^\n]*|(,@|[()'`,])|("(?:[^"\\]|\\.)*")|(")|([^\s()'`,";]+)/gy;
  for (let m; re.lastIndex < source.length && (m = re.exec(source)); ) {
    if (m[1]) tokens.push(m[1]);
    else if (m[2]) tokens.push({ string: m[2].slice(1, -1).replace(/\\(.)/g, (_, c) => ({ n: "\n", t: "\t" })[c] ?? c) });
    else if (m[3]) fail("unterminated string");
    else if (m[4]) tokens.push(m[4]);
  }
  return tokens;
}
const QUOTES = { "'": "quote", "`": "quasiquote", ",": "unquote", ",@": "unquote-splicing" };
function parseAll(source) {
  const tokens = tokenize(source);
  let i = 0;
  const read = () => {
    if (i >= tokens.length) fail("unexpected end of input: missing )");
    const t = tokens[i++];
    if (typeof t === "object") return t.string;
    if (t === "(") {
      const items = [];
      let tail = NIL;
      for (;;) {
        if (i >= tokens.length) fail("unexpected end of input: missing )");
        if (tokens[i] === ")") { i++; break; }
        if (tokens[i] === "." && items.length) { i++; tail = read(); if (tokens[i++] !== ")") fail("bad dotted list"); break; }
        items.push(read());
      }
      return items.reduceRight((rest, x) => new Pair(x, rest), tail);
    }
    if (t === ")") fail("unexpected )");
    if (QUOTES[t]) return list(sym(QUOTES[t]), read());
    if (t === "#t") return true;
    if (t === "#f") return false;
    if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return Number(t);
    return sym(t);
  };
  const forms = [];
  while (i < tokens.length) forms.push(read());
  return forms;
}

// Printing, as display does.
function show(v) {
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  if (v === true) return "#t";
  if (v === false) return "#f";
  if (v instanceof Sym) return v.name;
  if (v === NIL) return "()";
  if (v instanceof Pair) {
    const parts = [];
    let x = v;
    for (; x instanceof Pair; x = x.cdr) parts.push(show(x.car));
    return "(" + parts.join(" ") + (x === NIL ? "" : " . " + show(x)) + ")";
  }
  if (v instanceof Lambda || typeof v === "function") return "#<procedure>";
  if (v instanceof Macro) return "#<macro>";
  return "";
}

const truthy = v => v !== false;
const S = Object.fromEntries(["quote", "quasiquote", "unquote", "unquote-splicing", "if", "define", "define-macro", "set!", "lambda", "begin", "let", "cond", "and", "or", "else"].map(n => [n, sym(n)]));

function bind(f, args) {
  if (args.length !== f.params.length) fail(`expected ${f.params.length} arguments, got ${args.length}`);
  const env = new Env(f.env);
  f.params.forEach((p, i) => env.define(p, args[i]));
  return env;
}
function apply(f, args) {
  if (typeof f === "function") return f(...args);
  if (f instanceof Lambda) return evalBody(f.body, bind(f, args));
  return fail(`not a procedure: ${show(f)}`);
}
function evalBody(body, env) {
  let v = UNSPECIFIED;
  for (const x of body) v = evaluate(x, env);
  return v;
}
function quasi(x, env) {
  if (!(x instanceof Pair)) return x;
  if (x.car === S.unquote) return evaluate(x.cdr.car, env);
  if (x.car instanceof Pair && x.car.car === S["unquote-splicing"]) {
    const spliced = evaluate(x.car.cdr.car, env), rest = quasi(x.cdr, env);
    return toArray(spliced).reduceRight((tail, y) => new Pair(y, tail), rest);
  }
  return new Pair(quasi(x.car, env), quasi(x.cdr, env));
}
const params = x => toArray(x).map(p => (p instanceof Sym ? p : fail("a parameter must be a symbol")));

// Tail positions loop instead of recursing, so a tail call grows no stack.
function evaluate(x, env) {
  for (;;) {
    if (x instanceof Sym) return env.lookup(x);
    if (!(x instanceof Pair)) return x === NIL ? fail("cannot evaluate ()") : x;
    const op = x.car, args = toArray(x.cdr);
    switch (op) {
      case S.quote: return args[0];
      case S.quasiquote: return quasi(args[0], env);
      case S.if:
        if (args.length < 2) fail("if needs a test and a branch");
        if (truthy(evaluate(args[0], env))) x = args[1];
        else if (args.length > 2) x = args[2];
        else return UNSPECIFIED;
        continue;
      case S.define:
      case S["define-macro"]: {
        const Kind = op === S.define ? Lambda : Macro;
        if (args[0] instanceof Pair) env.define(args[0].car, new Kind(params(args[0].cdr), args.slice(1), env));
        else if (args[0] instanceof Sym && op === S.define) env.define(args[0], args.length > 1 ? evaluate(args[1], env) : UNSPECIFIED);
        else fail("bad define");
        return UNSPECIFIED;
      }
      case S["set!"]:
        if (!(args[0] instanceof Sym)) fail("set! needs a symbol");
        env.set(args[0], evaluate(args[1], env));
        return UNSPECIFIED;
      case S.lambda: return new Lambda(params(args[0]), args.slice(1), env);
      case S.begin:
        if (!args.length) return UNSPECIFIED;
        for (const y of args.slice(0, -1)) evaluate(y, env);
        x = args.at(-1);
        continue;
      case S.let: {
        const inner = new Env(env);
        for (const b of toArray(args[0])) {
          const [name, value] = toArray(b);
          inner.define(name, evaluate(value, env));
        }
        const body = args.slice(1);
        if (!body.length) return UNSPECIFIED;
        for (const y of body.slice(0, -1)) evaluate(y, inner);
        x = body.at(-1);
        env = inner;
        continue;
      }
      case S.cond: {
        let next = null;
        for (const clause of args) {
          const [test, ...body] = toArray(clause);
          const v = test === S.else ? true : evaluate(test, env);
          if (!truthy(v)) continue;
          if (!body.length) return v;
          for (const y of body.slice(0, -1)) evaluate(y, env);
          next = body.at(-1);
          break;
        }
        if (next === null) return UNSPECIFIED;
        x = next;
        continue;
      }
      case S.and: {
        if (!args.length) return true;
        let done = false, v;
        for (const y of args.slice(0, -1)) if (!truthy((v = evaluate(y, env)))) { done = true; break; }
        if (done) return v;
        x = args.at(-1);
        continue;
      }
      case S.or: {
        if (!args.length) return false;
        let found = false, v;
        for (const y of args.slice(0, -1)) if (truthy((v = evaluate(y, env)))) { found = true; break; }
        if (found) return v;
        x = args.at(-1);
        continue;
      }
    }
    const f = evaluate(op, env);
    if (f instanceof Macro) {
      x = evalBody(f.body, bind(f, args));
      continue;
    }
    const values = args.map(a => evaluate(a, env));
    if (f instanceof Lambda) {
      env = bind(f, values);
      if (!f.body.length) return UNSPECIFIED;
      for (const y of f.body.slice(0, -1)) evaluate(y, env);
      x = f.body.at(-1);
      continue;
    }
    if (typeof f === "function") return f(...values);
    fail(`not a procedure: ${show(f)}`);
  }
}

// Builtins.
const num = (name, v) => (typeof v === "number" ? v : fail(`${name}: not a number: ${show(v)}`));
const nums = (name, xs) => xs.map(x => num(name, x));
const pair = (name, v) => (v instanceof Pair ? v : fail(`${name}: not a pair: ${show(v)}`));
const proc = v => v instanceof Lambda || typeof v === "function";
const str = (name, v) => (typeof v === "string" ? v : fail(`${name}: not a string: ${show(v)}`));
const arity = (name, n, xs) => { if (xs.length !== n) fail(`${name}: expected ${n} arguments, got ${xs.length}`); };
const compare = (name, ok) => (...xs) => {
  if (xs.length < 2) fail(`${name}: expected at least 2 arguments`);
  nums(name, xs);
  for (let i = 1; i < xs.length; i++) if (!ok(xs[i - 1], xs[i])) return false;
  return true;
};
function equal(a, b) {
  if (a instanceof Pair && b instanceof Pair) return equal(a.car, b.car) && equal(a.cdr, b.cdr);
  return a === b;
}
function isList(v) {
  for (; v instanceof Pair; v = v.cdr);
  return v === NIL;
}

function globals(write) {
  const env = new Env();
  const def = (name, f) => env.define(sym(name), f);
  def("+", (...xs) => nums("+", xs).reduce((a, b) => a + b, 0));
  def("*", (...xs) => nums("*", xs).reduce((a, b) => a * b, 1));
  def("-", (...xs) => {
    if (!xs.length) fail("-: expected at least 1 argument");
    nums("-", xs);
    return xs.length === 1 ? -xs[0] : xs.slice(1).reduce((a, b) => a - b, xs[0]);
  });
  def("/", (...xs) => {
    if (!xs.length) fail("/: expected at least 1 argument");
    nums("/", xs);
    const out = xs.length === 1 ? 1 / xs[0] : xs.slice(1).reduce((a, b) => (b === 0 ? fail("/: division by zero") : a / b), xs[0]);
    if (xs.length === 1 && xs[0] === 0) fail("/: division by zero");
    return out;
  });
  def("modulo", (a, b, ...rest) => {
    arity("modulo", 2, [a, b, ...rest]);
    num("modulo", a), num("modulo", b);
    if (b === 0) fail("modulo: division by zero");
    return ((a % b) + b) % b;
  });
  def("=", compare("=", (a, b) => a === b));
  def("<", compare("<", (a, b) => a < b));
  def(">", compare(">", (a, b) => a > b));
  def("<=", compare("<=", (a, b) => a <= b));
  def(">=", compare(">=", (a, b) => a >= b));
  def("not", v => v === false);
  def("eq?", (a, b) => a === b);
  def("equal?", equal);
  def("number?", v => typeof v === "number");
  def("string?", v => typeof v === "string");
  def("symbol?", v => v instanceof Sym);
  def("procedure?", proc);
  def("list?", isList);
  def("pair?", v => v instanceof Pair);
  def("null?", v => v === NIL);
  def("car", (...xs) => (arity("car", 1, xs), pair("car", xs[0]).car));
  def("cdr", (...xs) => (arity("cdr", 1, xs), pair("cdr", xs[0]).cdr));
  def("cons", (...xs) => (arity("cons", 2, xs), new Pair(xs[0], xs[1])));
  def("list", list);
  def("length", v => (isList(v) ? toArray(v).length : fail(`length: not a list: ${show(v)}`)));
  def("append", (...ls) => {
    if (!ls.length) return NIL;
    return ls.slice(0, -1).reduceRight((tail, l) => toArray(l).reduceRight((t, x) => new Pair(x, t), tail), ls.at(-1));
  });
  def("reverse", l => toArray(l).reduce((tail, x) => new Pair(x, tail), NIL));
  def("map", (f, l) => list(...toArray(l).map(x => apply(f, [x]))));
  def("filter", (f, l) => list(...toArray(l).filter(x => truthy(apply(f, [x])))));
  def("reduce", (f, init, l) => toArray(l).reduce((acc, x) => apply(f, [acc, x]), init));
  def("string-append", (...xs) => xs.map(x => str("string-append", x)).join(""));
  def("string-length", s => str("string-length", s).length);
  def("number->string", n => String(num("number->string", n)));
  def("display", (...xs) => { arity("display", 1, xs); write(show(xs[0])); return UNSPECIFIED; });
  def("newline", () => { write("\n"); return UNSPECIFIED; });
  def("error", (...xs) => fail(xs.map(show).join(" ")));
  return env;
}

export function run(source) {
  let out = "";
  const env = globals(text => { out += text; });
  try {
    for (const form of parseAll(String(source))) evaluate(form, env);
  } catch (e) {
    out += (out && !out.endsWith("\n") ? "\n" : "") + "Error: " + (e instanceof LispError ? e.message : e?.message ?? String(e));
  }
  return out;
}
