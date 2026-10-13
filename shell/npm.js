// npm and npx for the shell: packages from the registry's tarballs (registry.npmjs.org allows any origin), unpacked
// into node_modules with Node's hoisting, a package-lock.json, and a shim per bin. Scripts run through the shell.
// Install scripts don't run (there is no native toolchain), and the output says which packages had one.
import { gzipBytes, untar } from "./archive.js";

const SEMVER = "https://esm.sh/semver@7.7.2";
const DEFAULT_REGISTRY = "https://registry.npmjs.org/";
const td = new TextDecoder();
// Bins whose package has another name, for npx.
// tsc is TypeScript 5: 7 is the native (Go) compiler, which runs no JavaScript.
const BIN_PACKAGES = { tsc: "typescript@5", tsserver: "typescript@5", "ts-node": "ts-node", eslint: "eslint", prettier: "prettier", vitest: "vitest", jest: "jest", mocha: "mocha", http_server: "http-server", serve: "serve", esbuild: "esbuild", rollup: "rollup", vite: "vite" };

export function npmCommands({ defineCommand, result, runNode, fs, ROOT, NPM_CACHE, binTarget, stdinText }) {
  let semver = null;
  const join = (...ps) => ps.join("/").replace(/\/+/g, "/");
  const readJson = async p => JSON.parse(await fs.readFile(p));
  const exists = p => fs.exists(p);
  const writeJson = (p, v) => fs.writeFile(p, JSON.stringify(v, null, 2) + "\n");

  async function registryOf(ctx, root) {
    const env = ctx.env.get("NPM_CONFIG_REGISTRY") ?? ctx.env.get("npm_config_registry");
    if (env) return env.replace(/\/?$/, "/");
    for (const p of [join(root, ".npmrc"), "/home/user/.npmrc"]) {
      const m = (await exists(p)) && /^\s*registry\s*=\s*(\S+)/m.exec(await fs.readFile(p));
      if (m) return m[1].replace(/\/?$/, "/");
    }
    return DEFAULT_REGISTRY;
  }
  // The folder with the package.json the command is for: the nearest one up from cwd.
  async function projectRoot(cwd) {
    for (let d = cwd; ; d = d.slice(0, d.lastIndexOf("/")) || "/") {
      if (await exists(join(d, "package.json"))) return d;
      if (d === "/" || d === ROOT) return cwd;
    }
  }
  const parseSpec = s => {
    if (/^(file:|\.{0,2}\/|~\/)|\.(tgz|tar\.gz)$/.test(s)) return [null, s];
    const at = s.lastIndexOf("@");
    return at > 0 ? [s.slice(0, at), s.slice(at + 1) || "latest"] : [s, "latest"];
  };

  async function sha(algo, bytes) {
    const digest = new Uint8Array(await crypto.subtle.digest(algo, bytes));
    return btoa(String.fromCharCode(...digest));
  }
  async function verify(bytes, integrity, name) {
    const [algo, want] = String(integrity ?? "").split(/-(.*)/s);
    const names = { sha512: "SHA-512", sha384: "SHA-384", sha256: "SHA-256", sha1: "SHA-1" };
    if (!names[algo]) return;
    if ((await sha(names[algo], bytes)) !== want) throw new Error(`npm: ${name}: the tarball's integrity doesn't match the registry's`);
  }

  // Installs specs (or the package.json's dependencies, at the lockfile's versions when there is one) into root.
  async function install(ctx, root, specs, { dev = false, save = true } = {}) {
    semver ??= (await import(SEMVER)).default;
    const t0 = performance.now();
    const registry = await registryOf(ctx, root);
    const pjPath = join(root, "package.json");
    const pj = (await exists(pjPath)) ? await readJson(pjPath) : { name: root.split("/").pop() || "project", version: "1.0.0" };
    const lockPath = join(root, "package-lock.json");
    const existing = (await exists(lockPath)) ? await readJson(lockPath).catch(() => null) : null;
    // With no packages named, the lockfile says what to install; otherwise it is kept and added to.
    const lock = !specs.length ? existing : null;
    const packuments = new Map(), placed = new Map(), entries = {}, scripts = new Set(), native = new Set();
    let added = 0, bytes = 0;
    const packument = name => {
      if (!packuments.has(name)) packuments.set(name, (async () => {
        const r = await fetch(registry + name.replace("/", "%2f"), { headers: { Accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8" } })
          .catch(e => { throw new Error(`npm: could not reach ${registry} for ${name}: ${e.message}`); });
        if (r.status === 404) throw new Error(`npm error 404 Not Found - ${name} is not in the npm registry.`);
        if (!r.ok) throw new Error(`npm: ${name}: ${r.status} from the registry`);
        return r.json();
      })());
      return packuments.get(name);
    };
    const installedVersion = async dir => (await exists(join(dir, "package.json"))) ? (await readJson(join(dir, "package.json")).catch(() => ({}))).version : null;

    async function unpack(tgz, target) {
      const tar = tgz[0] === 0x1f && tgz[1] === 0x8b ? await gzipBytes(tgz, true) : tgz;
      await fs.rm(target, { recursive: true, force: true });
      for (const [p, body] of untar(tar)) {
        if (!body) continue;
        const dest = join(target, p.replace(/^[^/]+\//, ""));
        await fs.mkdir(dest.slice(0, dest.lastIndexOf("/")), { recursive: true });
        await fs.writeFile(dest, body);
      }
    }
    async function linkBins(name, dir, bin, binRoot) {
      if (!bin) return;
      const bins = typeof bin === "string" ? { [name.split("/").pop()]: bin } : bin;
      const binDir = join(binRoot, "node_modules/.bin");
      await fs.mkdir(binDir, { recursive: true });
      const rel = dir.slice(binRoot.length + "/node_modules/".length);
      for (const [b, p] of Object.entries(bins))
        await fs.writeFile(join(binDir, b), `#!/bin/sh\n# npm's shim for ${name}: runs it with node\nexec node "$(dirname "$0")/../${rel}/${String(p).replace(/^\.\//, "")}" "$@"\n`);
    }
    // One package at a version range, under the folder whose node_modules it goes in, hoisted when it can be.
    async function visit(name, range, parentDir, exact = null) {
      const top = join(root, "node_modules", name);
      const have = await installedVersion(top);
      semver ??= (await import(SEMVER)).default;
      // Already there and good enough: no network.
      if (!exact && have && (range === "latest" ? placed.get(name) === have : semver.validRange(range) && semver.satisfies(have, range))) {
        if (!placed.has(name)) { placed.set(name, have); await visitDeps(top); }
        return have;
      }
      const doc = await packument(name);
      const version = exact ?? doc["dist-tags"]?.[range] ?? semver.maxSatisfying(Object.keys(doc.versions ?? {}), range);
      if (!version || !doc.versions[version]) throw new Error(`npm error notarget No matching version found for ${name}@${range}.`);
      let target;
      if (!placed.has(name) || placed.get(name) === version) {
        if (placed.get(name) === version) return version;
        target = top;
        placed.set(name, version);
      } else target = join(parentDir, "node_modules", name);
      const meta = doc.versions[version];
      if (name === "typescript" && semver.major(version) >= 7) native.add("typescript@7 (the Go compiler: install typescript@5 for tsc)");
      if (meta.hasInstallScript || meta.scripts?.install || meta.scripts?.postinstall) scripts.add(name);
      if (meta.gypfile || /node-gyp|prebuild/.test(`${meta.scripts?.install ?? ""} ${meta.scripts?.postinstall ?? ""}`)) native.add(name);
      if ((await installedVersion(target)) !== version) {
        const r = await fetch(meta.dist.tarball).catch(e => { throw new Error(`npm: could not fetch ${name}@${version}: ${e.message}`); });
        if (!r.ok) throw new Error(`npm: ${name}@${version}: ${r.status} fetching its tarball`);
        const tgz = new Uint8Array(await r.arrayBuffer());
        await verify(tgz, meta.dist.integrity, `${name}@${version}`);
        bytes += tgz.length;
        await unpack(tgz, target);
        added++;
      }
      await linkBins(name, target, meta.bin, root);
      entries[target.slice(root.length + 1)] = { version, resolved: meta.dist.tarball, integrity: meta.dist.integrity, ...(meta.dependencies && { dependencies: meta.dependencies }), ...(meta.bin && { bin: meta.bin }) };
      await Promise.all([
        ...Object.entries(meta.dependencies ?? {}).map(([d, r]) => visit(d, r, target)),
        ...Object.entries(meta.optionalDependencies ?? {}).map(([d, r]) => visit(d, r, target).catch(() => null)),
      ]);
      return version;
    }
    // A package already in node_modules: its dependencies, as its own package.json names them.
    async function visitDeps(dir) {
      const own = await readJson(join(dir, "package.json")).catch(() => ({}));
      const lockEntry = lock?.packages?.[dir.slice(root.length + 1)];
      entries[dir.slice(root.length + 1)] = lockEntry ?? { version: own.version, ...(own.dependencies && { dependencies: own.dependencies }) };
      await linkBins(own.name ?? dir.split("node_modules/").pop(), dir, own.bin, root);
      await Promise.all(Object.entries(own.dependencies ?? {}).map(([d, r]) => visit(d, r, dir)));
    }
    // A tarball or folder on disk: npm install ./pkg.tgz, npm install ../lib.
    async function local(spec) {
      const path = ctx.fs.resolvePath(ctx.cwd, spec.replace(/^file:/, ""));
      let tmp = path;
      if (/\.(tgz|tar\.gz|tar)$/.test(path)) {
        tmp = `/tmp/npm-local-${Date.now()}`;
        await unpack(await fs.readFileBuffer(path), tmp);
      }
      const own = await readJson(join(tmp, "package.json")).catch(() => { throw new Error(`npm: ${spec} has no package.json`); });
      const target = join(root, "node_modules", own.name);
      await fs.rm(target, { recursive: true, force: true });
      await fs.cp(tmp, target, { recursive: true });
      placed.set(own.name, own.version);
      added++;
      await visitDeps(target);
      return [own.name, spec.startsWith("file:") || /\.(tgz|tar\.gz|tar)$/.test(spec) ? (spec.startsWith("file:") ? spec : `file:${spec}`) : `file:${spec}`];
    }

    let wanted;
    if (specs.length) wanted = specs.map(parseSpec);
    else if (lock?.packages) {
      // The lockfile's tree, as it was: each package at its path and version.
      const paths = Object.keys(lock.packages).filter(p => p.startsWith("node_modules/")).sort((a, b) => a.split("node_modules/").length - b.split("node_modules/").length);
      for (const p of paths) {
        const e = lock.packages[p], name = p.split("node_modules/").pop(), dir = join(root, p);
        if (placed.has(p)) continue;
        placed.set(p, e.version);
        if (!p.slice("node_modules/".length).includes("/node_modules/")) placed.set(name, e.version);
        if ((await installedVersion(dir)) !== e.version) {
          const doc = await packument(name);
          const meta = doc.versions?.[e.version];
          if (!meta) throw new Error(`npm: ${name}@${e.version} from the lockfile is not in the registry`);
          const r = await fetch(meta.dist.tarball);
          const tgz = new Uint8Array(await r.arrayBuffer());
          await verify(tgz, meta.dist.integrity, `${name}@${e.version}`);
          bytes += tgz.length;
          await unpack(tgz, dir);
          added++;
          await linkBins(name, dir, meta.bin, root);
        } else await linkBins(name, dir, e.bin ?? (await readJson(join(dir, "package.json")).catch(() => ({}))).bin, root);
        entries[p] = e;
      }
      // What package.json names and the lockfile hasn't yet.
      wanted = Object.entries({ ...pj.dependencies, ...pj.devDependencies }).filter(([n]) => !lock.packages["node_modules/" + n]);
    } else wanted = Object.entries({ ...pj.dependencies, ...pj.devDependencies });
    const results = await Promise.all(wanted.map(([n, r]) => n ? visit(n, r, root).then(v => [n, v]) : local(r)));
    if (specs.length && save) {
      const field = dev ? "devDependencies" : "dependencies";
      pj[field] = { ...pj[field] };
      for (const [n, v] of results) pj[field][n] = v.startsWith?.("file:") ? v : "^" + v;
      if (dev && pj.dependencies) for (const [n] of results) delete pj.dependencies[n];
      await writeJson(pjPath, pj);
    } else if (!(await exists(pjPath))) await writeJson(pjPath, pj);
    const lockfile = { name: pj.name, version: pj.version, lockfileVersion: 3, requires: true, packages: { "": { name: pj.name, version: pj.version, ...(pj.dependencies && { dependencies: pj.dependencies }), ...(pj.devDependencies && { devDependencies: pj.devDependencies }) }, ...Object.fromEntries(Object.entries(existing?.packages ?? {}).filter(([k]) => k)), ...entries } };
    await writeJson(lockPath, lockfile);
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    const notes = [
      scripts.size && `npm warn: install scripts were not run (no native toolchain here) for: ${[...scripts].join(", ")}`,
      native.size && `npm warn: ${[...native].join(", ")} ${native.size > 1 ? "have" : "has"} native code, which can't build here; requiring ${native.size > 1 ? "them" : "it"} will likely fail`,
    ].filter(Boolean);
    return result(`${added ? `added ${added} package${added > 1 ? "s" : ""}` : "up to date"} in ${secs}s${bytes ? ` (${Math.round(bytes / 1024)} KB of tarballs)` : ""}\n`, notes.map(n => n + "\n").join(""), 0);
  }

  async function uninstall(root, names) {
    const pjPath = join(root, "package.json");
    const pj = (await exists(pjPath)) ? await readJson(pjPath) : {};
    for (const n of names) {
      await fs.rm(join(root, "node_modules", n), { recursive: true, force: true });
      for (const f of ["dependencies", "devDependencies", "optionalDependencies"]) if (pj[f]) delete pj[f][n];
    }
    await writeJson(pjPath, pj);
    return result(`removed ${names.length} package${names.length > 1 ? "s" : ""}\n`);
  }

  async function ls(root, all) {
    const pj = (await exists(join(root, "package.json"))) ? await readJson(join(root, "package.json")) : {};
    const lines = [`${pj.name ?? "project"}@${pj.version ?? ""} ${root}`];
    const deps = Object.keys({ ...pj.dependencies, ...pj.devDependencies, ...pj.optionalDependencies }).sort();
    const names = all && (await exists(join(root, "node_modules")))
      ? (await fs.readdir(join(root, "node_modules"))).filter(n => !n.startsWith(".")).flatMap(n => n.startsWith("@") ? [] : [n]) : deps;
    let missing = 0;
    for (const [i, n] of names.entries()) {
      const v = (await exists(join(root, "node_modules", n, "package.json"))) ? (await readJson(join(root, "node_modules", n, "package.json"))).version : null;
      if (!v) missing++;
      lines.push(`${i === names.length - 1 ? "└──" : "├──"} ${v ? `${n}@${v}` : `UNMET DEPENDENCY ${n}`}`);
    }
    if (!names.length) lines.push("└── (empty)");
    return result(lines.join("\n") + "\n", missing ? `npm error missing: ${missing} dependenc${missing > 1 ? "ies" : "y"}; run npm install\n` : "", missing ? 1 : 0);
  }

  async function runScript(ctx, root, name, extra = []) {
    const pjPath = join(root, "package.json");
    if (!(await exists(pjPath))) return result("", `npm error enoent Could not read package.json in ${root}\n`, 254);
    const pj = await readJson(pjPath);
    const scripts = pj.scripts ?? {};
    if (!name) return result(Object.keys(scripts).length ? `Scripts available in ${pj.name ?? "the project"} via \`npm run\`:\n` + Object.entries(scripts).map(([k, v]) => `  ${k}\n    ${v}`).join("\n") + "\n" : "", "", 0);
    if (!scripts[name]) {
      if (name === "test") return result("", 'npm error Missing script: "test"\n', 1);
      if (name === "start" && (await exists(join(root, "server.js")))) scripts.start = "node server.js";
      else return result("", `npm error Missing script: "${name}"\n\nTo see a list of scripts, run:\n  npm run\n`, 1);
    }
    let out = "", err = "";
    const env = { npm_package_name: pj.name ?? "", npm_package_version: pj.version ?? "", npm_lifecycle_event: name, PATH: `${root}/node_modules/.bin:${ctx.env.get("PATH") ?? ""}`, INIT_CWD: ctx.cwd };
    for (const step of [`pre${name}`, name, `post${name}`]) {
      if (!scripts[step]) continue;
      const line = scripts[step] + (step === name && extra.length ? " " + extra.map(a => (/^[\w./=:@%+-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(" ") : "");
      out += `\n> ${pj.name ?? "project"}@${pj.version ?? ""} ${step}\n> ${line}\n\n`;
      const r = await ctx.exec(line, { cwd: root, env });
      out += r.stdout; err += r.stderr;
      if (r.exitCode !== 0) return result(out, err + `npm error Lifecycle script \`${step}\` failed with error:\nnpm error code ${r.exitCode}\n`, r.exitCode);
    }
    return result(out, err, 0);
  }

  const npm = defineCommand("npm", async (args, ctx) => {
    const [cmd, ...rest] = args;
    const root = await projectRoot(ctx.cwd);
    const named = rest.filter(a => !a.startsWith("-"));
    try {
      switch (cmd) {
        case "-v": case "--version": case "version": return result("10.9.3\n");
        case "install": case "i": case "add": case "ci": case "isntall": {
          if (rest.includes("-g") || rest.includes("--global")) return result("", "npm: global installs aren't available here; install into the project, or run a package's bin with npx\n", 1);
          if (cmd === "ci") await fs.rm(join(root, "node_modules"), { recursive: true, force: true });
          return await install(ctx, root, cmd === "ci" ? [] : named, { dev: rest.includes("-D") || rest.includes("--save-dev"), save: !rest.includes("--no-save") });
        }
        case "uninstall": case "remove": case "rm": case "un": return await uninstall(root, named);
        case "ls": case "list": case "ll": return await ls(root, rest.includes("--all") || rest.includes("-a") || rest.some(a => a.startsWith("--depth")));
        case "test": case "t": case "tst": return await runScript(ctx, root, "test", rest);
        case "start": case "stop": case "restart": return await runScript(ctx, root, cmd, rest);
        case "run": case "run-script": {
          const dash = rest.indexOf("--");
          return await runScript(ctx, root, named[0], dash >= 0 ? rest.slice(dash + 1) : rest.slice(rest.indexOf(named[0]) + 1));
        }
        case "init": case "create": {
          if (cmd === "create" || (named[0] && !rest.includes("-y"))) return result("", "npm: npm init <initializer> isn't available here; npm init -y writes a package.json\n", 1);
          const pjPath = join(ctx.cwd, "package.json");
          if (await exists(pjPath)) return result(await fs.readFile(pjPath));
          const pj = { name: ctx.cwd.split("/").pop() || "project", version: "1.0.0", description: "", main: "index.js", scripts: { test: "node --test" }, keywords: [], author: "", license: "ISC" };
          await writeJson(pjPath, pj);
          return result(`Wrote to ${pjPath}:\n\n${JSON.stringify(pj, null, 2)}\n`);
        }
        case "view": case "info": case "show": case "v": {
          const [spec, field] = named;
          const [name, range] = parseSpec(spec ?? "");
          const registry = await registryOf(ctx, root);
          const r = await fetch(registry + name.replace("/", "%2f"));
          if (!r.ok) return result("", `npm error 404 ${name} is not in the npm registry\n`, 1);
          const doc = await r.json();
          semver ??= (await import(SEMVER)).default;
          const version = doc["dist-tags"]?.[range] ?? semver.maxSatisfying(Object.keys(doc.versions ?? {}), range);
          const meta = doc.versions?.[version] ?? {};
          if (field === "versions") return result(JSON.stringify(Object.keys(doc.versions ?? {})) + "\n");
          if (field) { const v = field.split(".").reduce((o, k) => o?.[k], { ...meta, "dist-tags": doc["dist-tags"], time: doc.time }); return result((typeof v === "string" ? v : JSON.stringify(v, null, 2)) + "\n"); }
          return result(`${name}@${version} | ${meta.license ?? ""} | deps: ${Object.keys(meta.dependencies ?? {}).length}\n${meta.description ?? ""}\n${meta.homepage ?? ""}\n\ndist-tags: ${Object.entries(doc["dist-tags"] ?? {}).map(([k, v]) => `${k}: ${v}`).join("  ")}\n`);
        }
        case "exec": case "x": return npx.execute(rest, ctx);
        case "root": return result(join(root, "node_modules") + "\n");
        case "prefix": return result(root + "\n");
        case "config": return result(rest[0] === "get" && rest[1] === "registry" ? (await registryOf(ctx, root)) + "\n" : "");
        case "help": case undefined: return result("npm <command>\n\nThis shell has: install (i, add, ci), uninstall, ls, test, start, run, init -y, view, exec, root, prefix, -v\n");
        default: return result("", `npm: \`${cmd}\` isn't available in this shell (install, uninstall, ls, test, start, run, init -y, view, exec)\n`, 1);
      }
    } catch (e) { return result("", String(e?.message ?? e) + "\n", 1); }
  });

  // npx: a bin from node_modules up the tree, else the package installed into npx's cache and run from there.
  const npx = defineCommand("npx", async (rawArgs, ctx) => {
    const args = [...rawArgs];
    let pkg = null;
    while (args[0]?.startsWith("-")) {
      const a = args.shift();
      if (a === "-p" || a === "--package") pkg = args.shift();
      else if (a.startsWith("--package=")) pkg = a.slice(10);
    }
    const [cmd, ...rest] = args;
    if (!cmd) return result("", "npx: usage: npx [-p package] <command> [args]\n", 1);
    const [cmdName] = parseSpec(cmd);
    let target = !pkg && (await binTarget(cmdName, ctx.cwd));
    if (!target) {
      const mapped = BIN_PACKAGES[cmdName];
      const spec = pkg ?? (!mapped ? cmd : cmd === cmdName ? mapped : mapped.replace(/@[^@]*$/, "") + cmd.slice(cmdName.length));
      const [name] = parseSpec(spec);
      const dir = join(NPM_CACHE, "_npx", name.replace("/", "+"));
      await fs.mkdir(dir, { recursive: true });
      if (!(await exists(join(dir, "node_modules", name, "package.json")))) {
        await writeJson(join(dir, "package.json"), { name: "npx-cache", version: "1.0.0" });
        const r = await install(ctx, dir, [spec], { save: true });
        if (r.exitCode) return r;
      }
      target = await binTarget(cmdName, dir);
      if (!target) {
        const own = await readJson(join(dir, "node_modules", name, "package.json"));
        const bins = typeof own.bin === "string" ? { [name.split("/").pop()]: own.bin } : own.bin ?? {};
        const only = Object.keys(bins).length === 1 && Object.keys(bins)[0];
        if (only) target = await binTarget(only, dir);
        if (!target) return result("", `npx: ${name} has no bin named ${cmdName}${Object.keys(bins).length ? ` (it has: ${Object.keys(bins).join(", ")})` : ""}\n`, 1);
      }
    }
    return runNode({ mode: "file", file: target, argv: ["/usr/local/bin/node", target, ...rest] }, ctx);
  });

  return [npm, npx];
}
