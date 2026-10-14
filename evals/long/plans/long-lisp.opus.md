# Plan: Lisp interpreter `lisp.js`

## 1. Goal
A single file `lisp.js`, an ES module with no dependencies, that exports `run(source)`. `run` evaluates a whole Lisp program and returns everything `display` and `newline` wrote, as a string. If the program fails, the returned string ends with an error line. `run` never throws. The module loads unchanged in Node 22 and in a browser, and touches no DOM, `process`, or `require`.

## 2. Done means
- `node test.mjs` exits 0 and prints `ALL PASS`. `test.mjs` imports `{ run }` from `./lisp.js` and checks each case below with exact string equality.
- `node -e "import('./lisp.js').then(m=>console.log(m.run('(display (+ 1 2))')))"` prints `3`.
- `grep -E "require\(|process\.|document|window" lisp.js` finds nothing.
- Each special form, each builtin, and each error kind in the request has at least one test.
- A tail-recursive count to 100000 passes once for each of: `if`, `cond`, `let`, `begin`, `and`, `or`, and a plain lambda body.
- `(reduce - 0 '(1 2 3))` prints `-6`. `(modulo -7 3)` prints `2`. `(display 2.0)` prints `2`. `(display (/ 1 2))` prints `0.5`. `(display (cons 1 2))` prints `(1 . 2)`. `(display '(1 "a" (2)))` prints `(1 a (2))`.
- A top-level value that is never displayed produces no output: `run("(+ 1 2)") === ""`.

## 3. Fixed facts
- File `lisp.js`, export `run`. Tests go in `test.mjs`. Both files sit in the same directory.
- Representation:
  - Numbers are JS numbers. Strings are JS strings. Booleans are JS `true`/`false`.
  - Symbols are `class Sym {name}`, interned through a `Map`, so `eq?` on symbols is `===`.
  - The empty list is one frozen object, `NIL`.
  - Pairs are `class Pair {car, cdr}`, mutable.
  - User procedures are `class Closure {params, body, env}`. Builtins are `class Builtin {name, fn}`.
- Environments are `class Env {vars: Map, parent}`.
- Only `false` is false.
- Output is collected in an array that is local to each `run` call. There is no module-level state except the symbol table.
- Error result: let `out` be the output so far. Return `out + (out === "" || out.endsWith("\n") ? "" : "\n") + "Error: " + msg`, with no trailing newline.
- Exact error messages:
  - `Unbound variable: NAME`, which also covers `set!` of an unbound name.
  - `Not a procedure: X`, where X is shown the way `display` shows it.
  - `Wrong number of arguments: expected N, got M`. For builtins with a fixed arity, the same text.
  - `NAME: expected TYPE`, for example `+: expected number`, `car: expected pair`, `string-length: expected string`. TYPE is one of: number, pair, list, string, procedure.
  - Parse errors: `Parse error: unexpected )`, `Parse error: unexpected end of input`, `Parse error: unterminated string`.
  - `(error "msg")` gives `msg`. Extra arguments are appended, each separated by a space and shown as `display` shows it.
- Internally, every Lisp error is `class LispError extends Error`. `run` catches everything. A non-LispError, such as a JS RangeError, becomes `Error: ` followed by its message.
- Number parsing: a token matching `/^[+-]?(\d+\.?\d*|\.\d+)$/` is a number. Anything else is a symbol. `+` and `-` alone are symbols.
- Lambdas take a fixed parameter list, and the argument count must match exactly.
- The value of `define`, `set!`, `display`, and `newline` is `NIL`. The value of `if` with a false test and no else is also `NIL`.
- `list?` means a proper list. `pair?` means a Pair. `(length x)` and `append` require proper lists, otherwise `NAME: expected list`.
- `/` with zero arguments, or division by zero: let JS produce Infinity. No special case.

## 4. Order of work
1. **Tokenizer and parser.** Handle parens, `'`, `` ` ``, `,`, `,@`, strings with escapes, and `;` comments. The parser returns an array of forms. Produces: parser code plus parse tests.
2. **Printer.** A `show(v)` function used by `display`. Lists print iteratively, not by deep recursion on the cdr. Produces: printer tests.
3. **Evaluator with trampoline.** `evaluate(x, env)` is a `while(true)` loop. Tail positions reassign `x` and `env` and `continue`. Tail positions are: `if` branches, the last `cond` clause body expression, the last `begin`/`let`/lambda body expression, and the last `and`/`or` operand. A closure call binds a new Env and loops on the body. Body evaluation treats inner `define` as local to that Env. Produces: special-form tests and the seven tail-loop tests.
4. **Builtins.** Add all the listed builtins, with type checks that use the fixed messages. `map`, `filter`, `reduce`, `append`, `reverse`, `length`, and `equal?` on long lists use loops. `map`/`filter`/`reduce` call closures through a helper `apply(f, args)` that runs the evaluator. Produces: builtin tests.
5. **Errors and `run` wrapper.** Produces: error tests, including output printed before the error.
6. **Browser/Node check.** Run the grep from section 2 and the `node -e` import.
7. **Optional, only after steps 1–6 pass.** Add `quasiquote`/`unquote`/`unquote-splicing`, then `define-macro`. The macro is stored as an object `class Macro`. On a call, evaluate its body with the unevaluated arguments bound, then evaluate the result in place, in tail position. Produces: macro tests, such as a `my-unless` macro.

## 5. Traps
- **Treating `0` or `()` as false.** The only test for falsehood is `v === false`.
- **Stack overflow from recursion.** Use the loop in `evaluate` for tail calls. Using JS recursion in `show`, `length`, or `map` over 100000-element lists also overflows, so use loops there.
- **`let` bindings seeing each other.** Evaluate every init in the outer env before creating the new Env.
- **`and`/`or` returning booleans.** They must return the deciding value. `(and)` is `#t`; `(or)` is `#f`.
- **`modulo` using JS `%`.** Use `((a % b) + b) % b`.
- **`-` with one argument.** It must negate.
- **`+` with zero arguments.** It must return `0`. `*` with zero arguments returns `1`.
- **`reduce` argument order.** Call `(f acc x)`, not `(f x acc)`.
- **Strings vs symbols.** Never represent symbols as JS strings.
- **`display` of strings nested in lists.** Print them without quotes.
- **`run` leaking state between calls.** Output and the global env must be fresh on every call.
- **Letting a JS exception escape.** Wrap the whole of `run`, parsing included.
- **Changing an error message or the representation midway.** Section 3 is final.

## 6. When to stop
Stop when `node test.mjs` prints `ALL PASS` and the grep and import checks from section 2 succeed. Do the macro step only if time remains. Then stop and report: the test count, any request item not done, and any test that still fails after three attempts on it. Do not refactor or restyle after the tests pass.
