// What the shell keeps that isn't the project's text: node_modules, .git, caches, binary files and npx's cache. One
// IndexedDB database beside the app's own, keyed by project and absolute path, read when a shell starts and written
// after each command. Why not the workspace: versions keep every state of every file, and the file list, the
// <workspace> block, run_app's served files and test discovery all walk the heads; typescript alone is 20 MB in
// ~100 files, lodash 600. These are rebuilt by npm install from package.json and the lockfile, which are versioned.
export function openStore(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("files", { keyPath: ["project", "path"] }).createIndex("project", "project");
      db.createObjectStore("meta", { keyPath: ["project", "key"] });
    };
    request.onsuccess = () => resolve(wrap(request.result));
    request.onerror = () => reject(request.error);
  });
}

function wrap(db) {
  const tx = (stores, mode, fn) => new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let value;
    const request = fn(t);
    if (request) request.onsuccess = () => (value = request.result);
    t.oncomplete = () => resolve(value);
    t.onerror = t.onabort = () => reject(t.error);
  });
  const key = project => project ?? 0;
  return {
    // [[path, bytes]] for a project.
    load: project => tx("files", "readonly", t => t.objectStore("files").index("project").getAll(key(project)))
      .then(rows => rows.map(r => [r.path, r.bytes])),
    apply: (project, puts = [], dels = []) => (puts.length || dels.length) && tx("files", "readwrite", t => {
      const s = t.objectStore("files");
      for (const path of dels) s.delete([key(project), path]);
      for (const [path, bytes] of puts) s.put({ project: key(project), path, bytes });
    }),
    getMeta: (project, name) => tx("meta", "readonly", t => t.objectStore("meta").get([key(project), name])).then(r => r?.value),
    setMeta: (project, name, value) => tx("meta", "readwrite", t => void t.objectStore("meta").put({ project: key(project), key: name, value })),
    clear: project => tx(["files", "meta"], "readwrite", t => {
      for (const s of ["files", "meta"]) s === "files"
        ? t.objectStore(s).index("project").openKeyCursor(IDBKeyRange.only(key(project))).onsuccess = e => { const c = e.target.result; if (c) { t.objectStore(s).delete(c.primaryKey); c.continue(); } }
        : t.objectStore(s).delete(IDBKeyRange.bound([key(project)], [key(project), []]));
    }),
    close: () => db.close(),
  };
}
