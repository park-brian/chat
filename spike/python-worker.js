// E11 spike: Pyodide in its own Worker, started on the first python3/pip/pytest call and kept for the session.
// Before each command the shell worker sends the files that changed since the last sync; after it, this worker
// sends back what Python wrote or removed under the synced roots.
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/";
let py, booting;
const known = new Map(); // path -> content key last synced in either direction
const roots = new Set();
let out = { 1: "", 2: "" };

async function boot() {
  const t0 = performance.now();
  const { loadPyodide } = await import(PYODIDE + "pyodide.mjs");
  py = await loadPyodide({ indexURL: PYODIDE, env: { HOME: "/home/user", MPLBACKEND: "Agg" } });
  const td = new TextDecoder();
  const writer = fd => ({ write: buf => { out[fd] += td.decode(buf, { stream: true }); return buf.length; } });
  py.setStdout(writer(1));
  py.setStderr(writer(2));
  py.runPython(`
import sys, os, runpy, traceback
def __shell_run(mode, arg, argv, cwd):
    os.chdir(cwd)
    sys.argv = list(argv)
    try:
        if mode == "c":
            exec(compile(arg, "<string>", "exec"), {"__name__": "__main__"})
        elif mode == "m":
            runpy.run_module(arg, run_name="__main__", alter_sys=True)
        else:
            sys.path.insert(0, os.path.dirname(os.path.abspath(arg)))
            runpy.run_path(arg, run_name="__main__")
        return 0
    except SystemExit as e:
        c = e.code
        if c is None: return 0
        if isinstance(c, int): return c
        print(c, file=sys.stderr)
        return 1
    except BaseException:
        traceback.print_exc()
        return 1
    finally:
        sys.stdout.flush(); sys.stderr.flush()
`);
  return Math.round(performance.now() - t0);
}

const key = b => b.length + ":" + (b.length ? b[0] + "," + b[b.length >> 1] + "," + b[b.length - 1] : "") + ":" + hash(b);
function hash(b) { let h = 2166136261; for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 16777619); return h >>> 0; }

function syncIn(files, dirs) {
  const FS = py.FS;
  const mkdirp = p => { let cur = ""; for (const s of p.split("/").filter(Boolean)) { cur += "/" + s; try { FS.mkdir(cur); } catch {} } };
  for (const d of dirs) { mkdirp(d); roots.add("/" + d.split("/")[1]); }
  let n = 0;
  for (const [p, bytes] of files) {
    roots.add("/" + p.split("/")[1]);
    const k = key(bytes);
    if (known.get(p) === k) continue;
    mkdirp(p.slice(0, p.lastIndexOf("/")) || "/");
    FS.writeFile(p, bytes);
    known.set(p, k); n++;
  }
  // Files removed in the shell since the last sync.
  const present = new Set(files.map(([p]) => p));
  for (const p of [...known.keys()]) if (!present.has(p)) { try { FS.unlink(p); } catch {} known.delete(p); }
  return n;
}

function syncOut() {
  const FS = py.FS, changed = [], seen = new Set();
  const walk = dir => {
    let names;
    try { names = FS.readdir(dir); } catch { return; }
    for (const name of names) {
      if (name === "." || name === ".." || name === "__pycache__" || name === ".pytest_cache") continue;
      const p = dir === "/" ? "/" + name : dir + "/" + name;
      const st = FS.stat(p);
      if (FS.isDir(st.mode)) walk(p);
      else if (FS.isFile(st.mode)) {
        seen.add(p);
        const bytes = FS.readFile(p), k = key(bytes);
        if (known.get(p) !== k) { known.set(p, k); changed.push([p, bytes]); }
      }
    }
  };
  for (const r of roots) walk(r);
  for (const p of [...known.keys()]) if (!seen.has(p)) { known.delete(p); changed.push([p, null]); }
  return changed;
}

onmessage = async ({ data }) => {
  const t0 = performance.now();
  let bootMs = 0;
  try {
    if (!py) bootMs = await (booting ??= boot());
    out = { 1: "", 2: "" };
    const synced = syncIn(data.files, data.dirs);
    let code = 0;
    if (data.op === "pip") {
      await py.loadPackage("micropip");
      const micropip = py.pyimport("micropip");
      try { await micropip.install(data.packages); out[1] += `Successfully installed ${data.packages.join(" ")}\n`; }
      catch (e) { out[2] += String(e.message ?? e).split("\n").slice(-3).join("\n") + "\n"; code = 1; }
    } else {
      // Pyodide-built packages imported by the code are loaded first, as `import numpy` would need.
      if (data.code) await py.loadPackagesFromImports(data.code);
      code = py.globals.get("__shell_run")(data.mode, data.arg, py.toPy(data.argv), data.cwd);
    }
    const changed = syncOut();
    postMessage({ type: "exit", code, stdout: out[1], stderr: out[2], changed, bootMs, synced, ms: Math.round(performance.now() - t0), resources: performance.getEntriesByType("resource").map(e => ({ name: e.name, transfer: e.transferSize, body: e.encodedBodySize, decoded: e.decodedBodySize })) });
  } catch (e) {
    postMessage({ type: "exit", code: 1, stdout: out[1], stderr: out[2] + String(e?.message ?? e) + "\n", changed: [], bootMs });
  }
};
