// tar and gzip for the shell. just-bash's browser build has no tar, and its gzip needs node:zlib (esm.sh gives a
// stub): the platform's CompressionStream does gzip, and a ustar reader and writer is a few dozen lines.
const td = new TextDecoder(), te = new TextEncoder();

export const gzipBytes = async (bytes, decompress) =>
  new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(decompress ? new DecompressionStream("gzip") : new CompressionStream("gzip"))).arrayBuffer());

// [[name, bytes]] for each regular file; directories are implied by the names.
export function untar(bytes) {
  const out = [];
  let longName = null, paxPath = null;
  const str = (o, n) => td.decode(bytes.subarray(o, o + n)).replace(/\0.*$/s, "");
  for (let o = 0; o + 512 <= bytes.length;) {
    if (bytes.subarray(o, o + 512).every(b => b === 0)) break;
    const size = parseInt(str(o + 124, 12).trim() || "0", 8), type = String.fromCharCode(bytes[o + 156] || 48);
    const prefix = str(o + 345, 155), name = longName ?? paxPath ?? (prefix ? prefix + "/" : "") + str(o, 100);
    const body = bytes.subarray(o + 512, o + 512 + size);
    longName = paxPath = null;
    if (type === "L") longName = td.decode(body).replace(/\0.*$/s, "");
    else if (type === "x") paxPath = /\d+ path=([^\n]*)\n/.exec(td.decode(body))?.[1] ?? null;
    else if (type === "0" || type === "\0" || type === "7") out.push([name, body.slice()]);
    else if (type === "5") out.push([name.replace(/\/?$/, "/"), null]);
    o += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

// entries: [[name, bytes | null for a directory]].
export function tarPack(entries) {
  const blocks = [];
  for (const [name, body] of entries) {
    const h = new Uint8Array(512), put = (s, o, n) => h.set(te.encode(s).subarray(0, n), o);
    let n = name, prefix = "";
    if (n.length > 100) { const cut = n.lastIndexOf("/", 155); prefix = n.slice(0, cut); n = n.slice(cut + 1); }
    put(n, 0, 100); put(body ? "0000644\0" : "0000755\0", 100, 8); put("0001750\0", 108, 8); put("0001750\0", 116, 8);
    put((body?.length ?? 0).toString(8).padStart(11, "0") + "\0", 124, 12); put(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136, 12);
    put("        ", 148, 8); h[156] = body ? 48 : 53; put("ustar\0" + "00", 257, 8); put(prefix, 345, 155);
    put(h.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ", 148, 8);
    blocks.push(h);
    if (body) { const padded = new Uint8Array(Math.ceil(body.length / 512) * 512); padded.set(body); blocks.push(padded); }
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const b of blocks) { out.set(b, o); o += b.length; }
  return out;
}

export function archiveCommands({ defineCommand, result }) {
  const tar = defineCommand("tar", async (args, ctx) => {
    let flags = "", file = null, dir = ctx.cwd;
    const paths = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-C" || a === "--directory") dir = ctx.fs.resolvePath(ctx.cwd, args[++i]);
      else if (a.startsWith("--file=")) file = a.slice(7);
      else if ((i === 0 && !a.startsWith("-")) || /^-[a-zA-Z]+$/.test(a)) { flags += a.replace(/^-/, ""); if (flags.endsWith("f") && file === null) file = args[++i]; }
      else if (a === "--gzip" || a === "-z") flags += "z";
      else paths.push(a);
    }
    try {
      if (!file) return result("", "tar: this shell needs -f FILE\n", 2);
      const archive = ctx.fs.resolvePath(ctx.cwd, file);
      if (flags.includes("c")) {
        const entries = [];
        const add = async rel => {
          const p = ctx.fs.resolvePath(dir, rel), st = await ctx.fs.stat(p);
          if (st.isDirectory) { entries.push([rel.replace(/\/?$/, "/"), null]); for (const n of (await ctx.fs.readdir(p)).sort()) await add(rel.replace(/\/$/, "") + "/" + n); }
          else entries.push([rel, await ctx.fs.readFileBuffer(p)]);
        };
        for (const p of paths) await add(p);
        let bytes = tarPack(entries);
        if (flags.includes("z") || /\.(tgz|tar\.gz)$/.test(file)) bytes = await gzipBytes(bytes);
        await ctx.fs.writeFile(archive, bytes);
        return result(flags.includes("v") ? entries.map(e => e[0]).join("\n") + "\n" : "", "", 0);
      }
      let bytes = await ctx.fs.readFileBuffer(archive);
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await gzipBytes(bytes, true);
      const entries = untar(bytes);
      if (flags.includes("t")) return result(entries.map(e => e[0]).join("\n") + "\n", "", 0);
      for (const [name, body] of entries) {
        const dest = ctx.fs.resolvePath(dir, name);
        if (!body) { await ctx.fs.mkdir(dest, { recursive: true }); continue; }
        await ctx.fs.mkdir(dest.slice(0, dest.lastIndexOf("/")) || "/", { recursive: true });
        await ctx.fs.writeFile(dest, body);
      }
      return result(flags.includes("v") ? entries.map(e => e[0]).join("\n") + "\n" : "", "", 0);
    } catch (e) { return result("", `tar: ${e.message ?? e}\n`, 2); }
  });
  const gzip = (name, decompress) => defineCommand(name, async (args, ctx) => {
    const d = decompress || args.includes("-d"), keep = args.includes("-k"), toStdout = name === "zcat" || args.includes("-c");
    const out = [];
    for (const f of args.filter(a => !a.startsWith("-"))) {
      const p = ctx.fs.resolvePath(ctx.cwd, f);
      try {
        const bytes = await gzipBytes(await ctx.fs.readFileBuffer(p), d);
        if (toStdout) { out.push(bytes); continue; }
        await ctx.fs.writeFile(d ? p.replace(/\.gz$/, "") : p + ".gz", bytes);
        if (!keep) await ctx.fs.rm(p);
      } catch (e) { return result("", `${name}: ${f}: ${e.message ?? e}\n`, 1); }
    }
    if (!out.length) return result("", "", 0);
    const all = new Uint8Array(out.reduce((n, b) => n + b.length, 0));
    let o = 0;
    for (const b of out) { all.set(b, o); o += b.length; }
    return { stdout: Array.from(all, b => String.fromCharCode(b)).join(""), stdoutKind: "bytes", stdoutEncoding: "binary", stderr: "", exitCode: 0 };
  });
  return [tar, gzip("gzip", false), gzip("gunzip", true), gzip("zcat", true)];
}
