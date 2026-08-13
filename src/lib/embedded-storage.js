// Embedded, extension-only file storage — IndexedDB-backed, needs no OS-level
// permission grant, and never expires or needs re-granting the way a real
// on-disk folder (workspace.js's File System Access path) can. This is the
// automatic fallback — and now the default — backend for save_file/read_file/
// list_files/append_rows/collect_rows's file projection, used transparently
// whenever a real folder isn't set or its permission has lapsed.
//
// Why this exists: the File System Access directory picker's permission grant
// is not reliably persistent across Chrome restarts/extension reloads (a real
// platform behavior, not a BAT bug — see workspace.js), so a
// user could ask for a large, long-running collection job and have it stall
// on "please re-grant folder access" partway through. Collected data must
// never be blocked on an OS permission dialog; only writing it out as a real
// file on disk should be.
//
// Exposes a MINIMAL, duck-typed subset of the FileSystemDirectoryHandle API
// (getFileHandle/entries/removeEntry, and file handles with getFile/
// createWritable) so workspace.js's own callers and output-writer.js work
// completely unchanged regardless of which backend is active — neither has
// to know or care which one it's talking to.

const DB_NAME = 'bat-embedded-storage';
const STORE = 'files';
const encoder = new TextEncoder();

let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'name' });
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => { dbPromise = null; };
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

const p = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const txDone = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
});

async function getRecord(name) {
  const db = await openDb();
  return p(db.transaction(STORE, 'readonly').objectStore(STORE).get(name));
}

async function putRecord(rec) {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(rec);
  await txDone(tx);
}

async function deleteRecord(name) {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).delete(name);
  await txDone(tx);
}

async function allRecords() {
  const db = await openDb();
  return p(db.transaction(STORE, 'readonly').objectStore(STORE).getAll());
}

// Pure — what should this file's content become after a write() call, given
// what it holds now? Exported so this, the one genuinely tricky part of the
// shim, is unit-testable without a real IndexedDB (see test/embedded-storage.test.mjs).
// Every actual call site in this codebase only ever writes a full string
// (overwrite) or a chunk at position 0 or at the current end of the file
// (append) — real random-access writes at an arbitrary offset are never used
// here, so this deliberately does not support them.
export function resolveWrite(currentContent, data) {
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object' && data.type === 'write') {
    const before = encoder.encode(currentContent).byteLength;
    if (data.position === 0) return data.data;
    if (data.position >= before) return currentContent + data.data;
    throw new Error(`embedded-storage: write position ${data.position} is neither 0 nor end-of-file (${before}) — only overwrite and append are supported`);
  }
  throw new Error('embedded-storage: unsupported write() argument');
}

// A File-like object: only what this codebase's callers actually use.
function fileOf(rec) {
  const content = rec?.content ?? '';
  return {
    size: encoder.encode(content).byteLength,
    lastModified: rec?.modified ?? Date.now(),
    async text() { return content; }
  };
}

function writableFor(name, initialContent) {
  let content = initialContent;
  return {
    async write(data) {
      content = resolveWrite(content, data);
    },
    async close() {
      await putRecord({ name, content, modified: Date.now() });
    }
  };
}

function fileHandleFor(name) {
  return {
    kind: 'file',
    name,
    async getFile() {
      const rec = await getRecord(name);
      if (!rec) throw new DOMException(`embedded-storage: "${name}" not found`, 'NotFoundError');
      return fileOf(rec);
    },
    async createWritable({ keepExistingData = false } = {}) {
      let initial = '';
      if (keepExistingData) {
        const rec = await getRecord(name);
        initial = rec?.content ?? '';
      }
      return writableFor(name, initial);
    }
  };
}

// Duck-typed FileSystemDirectoryHandle. `name` mirrors the `.name` a real
// folder handle exposes — used only for display text in Settings.
export const embeddedRoot = {
  kind: 'directory',
  name: 'Embedded storage (extension-only)',
  async getFileHandle(name, { create = false } = {}) {
    const rec = await getRecord(name);
    if (!rec) {
      // A real FileSystemDirectoryHandle materializes an empty file the
      // instant getFileHandle({create:true}) is called, before any write —
      // callers rely on being able to getFile() a freshly "created" handle
      // and see size 0, not a NotFoundError. Match that here.
      if (!create) throw new DOMException(`embedded-storage: "${name}" not found`, 'NotFoundError');
      await putRecord({ name, content: '', modified: Date.now() });
    }
    return fileHandleFor(name);
  },
  async removeEntry(name) {
    await deleteRecord(name);
  },
  async *entries() {
    for (const rec of await allRecords()) {
      yield [rec.name, fileHandleFor(rec.name)];
    }
  }
};
