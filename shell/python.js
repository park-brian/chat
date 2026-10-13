// python3, pip and pytest for the shell: Pyodide in a Worker the tab keeps for its project, started on the first
// Python command. Each job brings the shell's files under its roots; only those that changed since the last job are
// written, and what Python wrote or removed goes back. Pyodide's files and the wheels pip fetches are cached in Cache
// Storage, so a second boot reads nothing from the network. A figure shown or left open, and an image file written,
// come back as images.
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/";
const CACHE = "shell-pyodide-314.0.7";
// Wheels and the package lock: the runtime (.wasm, .js) stays in the HTTP cache, where Chromium keeps its compiled code.
const CACHED = /^https:\/\/(cdn\.jsdelivr\.net\/pyodide\/|files\.pythonhosted\.org\/).*(\.whl|\.zip|\.tar|pyodide-lock\.json)$/;
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const IMAGE_MAX = 3.75e6;

// Packages with no build for Python in the browser, and what to use instead.
const NN = "For neural networks use TensorFlow.js (npm install @tensorflow/tfjs) or ONNX Runtime Web (npm install onnxruntime-web, for a PyTorch model exported to ONNX), or jax-js, from node; for models in Python use scikit-learn, xgboost or lightgbm.";
const NO_BUILD = {
  torch: NN, pytorch: NN, torchvision: NN, torchaudio: NN, tensorflow: NN, "tensorflow-cpu": NN, "tensorflow-gpu": NN, keras: NN, jax: NN, jaxlib: NN, flax: NN,
  rdkit: "There is no Pyodide build of RDKit.", "rdkit-pypi": "There is no Pyodide build of RDKit.",
  scanpy: "Scanpy isn't in Pyodide's package index; numpy, scipy, pandas and scikit-learn are.",
  openmm: "OpenMM has no Pyodide build.",
};
const realFetch = fetch;
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : input != null ? String(input) : "";
  if (!url || !CACHED.test(url) || (init?.method && init.method !== "GET")) return realFetch(input, init);
  const cache = await caches.open(CACHE).catch(() => null);
  const hit = await cache?.match(url);
  if (hit) return hit;
  const res = await realFetch(input, init);
  if (res.ok && cache) await cache.put(url, res.clone()).catch(() => {});
  return res;
};

let py = null, booting = null, micropip = null;
const known = new Map(); // path -> content key last synced in either direction
let out = { 1: "", 2: "" };
const BACKEND = `
import io
from matplotlib.backends.backend_agg import FigureCanvasAgg as FigureCanvas
from matplotlib.backend_bases import FigureManagerBase as FigureManager
import matplotlib.figure as _figure
shown = []
_savefig = _figure.Figure.savefig
def _marked(self, *a, **k):
    self._shell_saved = True
    return _savefig(self, *a, **k)
_figure.Figure.savefig = _marked
def capture(include_saved):
    import matplotlib.pyplot as plt
    for num in plt.get_fignums():
        fig = plt.figure(num)
        if include_saved or not getattr(fig, "_shell_saved", False):
            buf = io.BytesIO()
            _savefig(fig, buf, format="png", dpi=100)
            shown.append(buf.getvalue())
    plt.close("all")
def show(*args, **kwargs):
    capture(False)
`;
const RUNNER = `
import sys, os, io, runpy, traceback
def __shell_run(mode, arg, argv, cwd, stdin, env):
    os.chdir(cwd)
    os.environ.update(env)
    sys.argv = list(argv)
    sys.stdin = io.StringIO(stdin)
    try:
        if mode == "c":
            exec(compile(arg, "<string>", "exec"), {"__name__": "__main__"})
        elif mode == "m":
            if cwd not in sys.path: sys.path.insert(0, cwd)
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
        if "shell_mpl_backend" in sys.modules:
            try: sys.modules["shell_mpl_backend"].capture(False)
            except Exception: pass
`;

async function boot() {
  const { loadPyodide } = await import(PYODIDE + "pyodide.mjs");
  py = await loadPyodide({ indexURL: PYODIDE, env: { HOME: "/home/user", MPLBACKEND: "module://shell_mpl_backend" } });
  const td = new TextDecoder();
  const writer = fd => ({ write: buf => { out[fd] += td.decode(buf, { stream: true }); return buf.length; } });
  py.setStdout(writer(1));
  py.setStderr(writer(2));
  py.FS.mkdirTree("/lib/shell");
  py.FS.writeFile("/lib/shell/shell_mpl_backend.py", BACKEND);
  py.runPython(`import sys; sys.path.append("/lib/shell")\n` + RUNNER);
}

const hash = b => { let h = 2166136261; for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 16777619); return h >>> 0; };
const key = b => b.length + ":" + hash(b);
const mkdirp = p => { let cur = ""; for (const s of p.split("/").filter(Boolean)) { cur += "/" + s; try { py.FS.mkdir(cur); } catch {} } };

function syncIn(files, roots) {
  let n = 0;
  for (const [p, bytes] of files) {
    const k = key(bytes);
    if (known.get(p) === k) continue;
    mkdirp(p.slice(0, p.lastIndexOf("/")) || "/");
    py.FS.writeFile(p, bytes);
    known.set(p, k); n++;
  }
  // Files the shell removed since the last job.
  const present = new Set(files.map(([p]) => p));
  for (const p of [...known.keys()]) if (roots.some(r => p.startsWith(r + "/")) && !present.has(p)) { try { py.FS.unlink(p); } catch {} known.delete(p); }
  for (const r of roots) mkdirp(r);
  return n;
}
// What Python wrote or removed under the roots, as the shell's entries.
function syncOut(roots) {
  const FS = py.FS, changed = [], seen = new Set();
  const walk = dir => {
    let names;
    try { names = FS.readdir(dir); } catch { return; }
    for (const name of names) {
      if (name === "." || name === ".." || name === "__pycache__" || name === ".pytest_cache" || name === "node_modules" || name === ".git") continue;
      const p = dir === "/" ? "/" + name : dir + "/" + name;
      const st = FS.stat(p);
      if (FS.isDir(st.mode)) walk(p);
      else if (FS.isFile(st.mode)) {
        seen.add(p);
        const bytes = FS.readFile(p), k = key(bytes);
        if (known.get(p) !== k) { known.set(p, k); changed.push(["f", p, bytes]); }
      }
    }
  };
  for (const r of roots) walk(r);
  for (const p of [...known.keys()]) if (roots.some(r => p.startsWith(r + "/")) && !seen.has(p)) { known.delete(p); changed.push(["x", p]); }
  return changed;
}

const specName = s => s.split(/[<>=!~\[;@ ]/)[0].trim().toLowerCase().replace(/_/g, "-");
async function pip(job) {
  await py.loadPackage("micropip");
  micropip ??= py.pyimport("micropip");
  if (job.cmd === "list" || job.cmd === "freeze") {
    const list = micropip.list().toJs({ dict_converter: Object.fromEntries });
    const rows = Object.values(list).map(p => [p.name, p.version]).sort((a, b) => a[0].localeCompare(b[0]));
    out[1] += job.cmd === "freeze" ? rows.map(([n, v]) => `${n}==${v}\n`).join("") : "Package    Version\n---------- -------\n" + rows.map(([n, v]) => `${n} ${v}\n`).join("");
    return 0;
  }
  if (job.cmd === "show") {
    const list = micropip.list().toJs({ dict_converter: Object.fromEntries });
    const hits = job.specs.map(s => Object.values(list).find(p => p.name.toLowerCase() === specName(s)));
    for (const [i, p] of hits.entries()) out[p ? 1 : 2] += p ? `Name: ${p.name}\nVersion: ${p.version}\n` : `WARNING: Package(s) not found: ${job.specs[i]}\n`;
    return hits.every(Boolean) ? 0 : 1;
  }
  if (job.cmd === "uninstall") { micropip.uninstall(py.toPy(job.specs)); out[1] += job.specs.map(s => `Successfully uninstalled ${s}\n`).join(""); return 0; }
  if (!job.specs.length) { out[2] += "ERROR: You must give at least one requirement to install\n"; return 1; }
  const blocked = job.specs.filter(s => NO_BUILD[specName(s)]);
  for (const s of blocked) out[2] += `ERROR: ${specName(s)} can't be installed here: Python in this shell is Pyodide (CPython in WebAssembly), and ${specName(s)} has no build for it. ${NO_BUILD[specName(s)]}\n`;
  const rest = job.specs.filter(s => !blocked.includes(s));
  if (rest.length) {
    try {
      await micropip.install.callKwargs(py.toPy(rest), { keep_going: true });
      out[1] += `Successfully installed ${rest.join(" ")}\n`;
      installed.push(...rest);
    } catch (e) {
      const text = String(e?.message ?? e);
      const lines = text.split("\n").filter(l => /Error|Can't find|not find|wheel|pure Python/i.test(l)).slice(-4);
      out[2] += `ERROR: ${(lines.length ? lines : text.split("\n").slice(-3)).join("\n")}\n` +
        (/pure Python 3 wheel|Can't find a pure/i.test(text) ? "Only pure-Python wheels and the packages Pyodide builds install here: no native code compiles in the browser.\n" : "");
      return 1;
    }
  }
  return blocked.length ? 1 : 0;
}
const installed = [];

// Pyodide-built packages the code imports are loaded first, as an install would have put them there.
async function loadImports(job) {
  const texts = job.mode === "c" ? [job.arg] : job.files.filter(([p]) => p.endsWith(".py")).map(([, b]) => new TextDecoder().decode(b));
  const code = texts.join("\n").slice(0, 2e6);
  if (code) await py.loadPackagesFromImports(code, { messageCallback: () => {}, errorCallback: m => (out[2] += m + "\n") }).catch(() => {});
}

// Pyodide's own lines about the packages it loads, said on stdout; not the program's.
const NOISE = /^(Loading |Loaded |No new packages to load|\S+ already loaded from |Didn't find package )/;
async function quiet(fn) {
  const mark = out[1].length;
  try { return await fn(); }
  finally { out[1] = out[1].slice(0, mark) + out[1].slice(mark).split("\n").filter(l => !NOISE.test(l)).join("\n"); }
}

let queue = Promise.resolve();
onmessage = ({ data }) => {
  queue = queue.then(() => handle(data));
};
async function handle({ id, job, reinstall = [] }) {
  const t0 = performance.now();
  let bootMs = 0;
  try {
    if (!py) { const t = performance.now(); await (booting ??= boot()); bootMs = Math.round(performance.now() - t); }
    if (reinstall.length && !installed.length) {
      await py.loadPackage("micropip").catch(() => {});
      micropip ??= py.pyimport("micropip");
      await micropip.install.callKwargs(py.toPy(reinstall), { keep_going: true }).then(() => installed.push(...reinstall), () => {});
    }
    out = { 1: "", 2: "" };
    syncIn(job.files, job.roots);
    let code = 0;
    if (job.op === "pip") code = await quiet(() => pip(job));
    else {
      await quiet(async () => {
        if (job.mode === "m" && job.arg === "pytest") {
          try { py.pyimport("pytest"); } catch { await py.loadPackage("micropip"); micropip ??= py.pyimport("micropip"); await micropip.install("pytest"); installed.push("pytest"); }
        }
        await loadImports(job);
      });
      code = py.globals.get("__shell_run")(job.mode, job.arg, py.toPy(job.argv), job.cwd, job.stdin ?? "", py.toPy(job.env ?? {}));
    }
    const changed = syncOut(job.roots);
    const images = [];
    const backend = py.runPython(`import sys; sys.modules.get("shell_mpl_backend")`);
    if (backend) {
      for (const b of backend.shown.toJs()) images.push({ format: "png", bytes: b instanceof Uint8Array ? b : new Uint8Array(b), name: `figure-${images.length + 1}` });
      backend.shown.clear();
    }
    for (const [kind, p, bytes] of changed) if (kind === "f" && IMAGE.test(p) && bytes.length <= IMAGE_MAX) images.push({ format: p.split(".").pop().toLowerCase().replace("jpg", "jpeg"), bytes, name: p.split("/").pop().replace(/\.\w+$/, "") });
    postMessage({ id, code, stdout: out[1], stderr: out[2], changed, images: images.slice(0, 4), installed: [...installed], bootMs, ms: Math.round(performance.now() - t0) });
  } catch (e) {
    postMessage({ id, code: 1, stdout: out[1], stderr: out[2] + String(e?.message ?? e) + "\n", changed: [], images: [], bootMs });
  }
}
