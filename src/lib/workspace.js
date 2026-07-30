// Workspace folder — persistent file storage for the agent.
// The user MAY grant a real directory once via showDirectoryPicker (a user
// gesture in the side panel); the handle is kept in IndexedDB so it survives
// panel close and browser restarts. But that grant's permission is not
// reliably persistent across Chrome restarts/extension reloads — a real
// platform behavior (see pickWorkspace below), not something BAT controls —
// so every read/write here goes through getActiveDir(), which transparently
// falls back to embedded-storage.js (IndexedDB-backed, no OS permission,
// never expires) whenever the real folder isn't currently usable. File
// operations therefore never hard-fail on a permission hiccup; only the
// "real files on disk" upgrade is conditional on that grant.

import { embeddedRoot } from './embedded-storage.js';

const DB_NAME = 'bat-workspace';
const STORE = 'handles';
const KEY = 'workspace-dir';
const MAX_READ_CHARS = 30000;

let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
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

async function idbGet(key) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    /* connection cached */
  }
}

async function idbSet(key, value) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    /* connection cached */
  }
}

async function loadHandle() {
  try {
    return (await idbGet(KEY)) || null;
  } catch {
    return null;
  }
}

// Must be called from a user gesture (settings button). Re-grants permission on
// the stored handle when possible so the user doesn't have to re-pick the folder.
// Opting into a real folder is optional — see getActiveDir(): file tools work
// via embedded storage with no folder set at all.
export async function pickWorkspace() {
  const existing = await loadHandle();
  if (existing) {
    try {
      if ((await existing.requestPermission({ mode: 'readwrite' })) === 'granted') return existing;
    } catch (_) {}
  }
  // showDirectoryPicker's availability inside a Chrome extension SIDE PANEL
  // (as opposed to a popup or a full tab) is genuinely inconsistent across
  // Chrome versions/builds — this is a documented platform quirk (see
  // Chromium issue 40240444 and WICG/file-system-access#314), not something
  // a retry or a different call shape fixes. Detect it up front so the
  // failure is a clear, actionable message instead of a raw
  // "showDirectoryPicker is not a function" TypeError.
  if (typeof window.showDirectoryPicker !== 'function') {
    throw new Error(
      'This Chrome build/version does not expose the folder picker inside the side panel '
      + '(a known Chrome platform limitation, not a BAT bug). Try updating Chrome to the '
      + 'latest version (chrome://settings/help), then reload the extension. This only '
      + 'affects real files on disk — the agent keeps working via embedded storage either way.'
    );
  }
  const handle = await window.showDirectoryPicker({ id: 'bat-workspace', mode: 'readwrite' });
  await idbSet(KEY, handle);
  return handle;
}

// The single source of truth for which backend is live right now. Prefers a
// real, currently-permitted folder (a deliberate user choice, and nicer —
// actual files you can open elsewhere); falls back to embedded storage
// whenever that isn't available, rather than throwing. This is what makes
// file tools "always just work": nothing downstream ever needs to know or
// care which backend answered.
async function getActiveDir() {
  const handle = await loadHandle();
  if (handle) {
    try {
      if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') {
        return { dir: handle, embedded: false };
      }
    } catch (_) { /* fall through to embedded */ }
  }
  return { dir: embeddedRoot, embedded: true };
}

export async function getWorkspaceDir() {
  const { dir } = await getActiveDir();
  return dir;
}

export async function getStatus() {
  const handle = await loadHandle();
  if (!handle) {
    return {
      ok: true, embedded: true,
      text: 'Using embedded storage (extension-only) — Choose folder for real files on disk instead'
    };
  }
  try {
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') return { ok: true, text: `Folder: ${handle.name}` };
    return {
      ok: true, embedded: true, degraded: true,
      text: `"${handle.name}" needs reconnecting — using embedded storage meanwhile (click Choose folder)`
    };
  } catch {
    return {
      ok: true, embedded: true, degraded: true,
      text: `"${handle.name}" unavailable — using embedded storage meanwhile (click Choose folder)`
    };
  }
}

// ── Per-file write serialization ──────────────────────────────────
// File System Access writables are swap-file based: two overlapping writers each
// copy the file and the LAST close() silently discards the other's data. This
// lock used to live only in output-writer.js, so `save_file mode:"append"`
// racing `append_rows` on the same filename lost rows with no error anywhere.
// The lock belongs at the file layer, where every writer passes through it —
// and it protects the embedded backend the same way, since nothing about the
// race is specific to real files.
const fileLocks = new Map();

export function withFileLock(name, fn) {
  const prev = fileLocks.get(name) || Promise.resolve();
  const run = prev.then(fn, fn);
  fileLocks.set(name, run.then(() => {}, () => {}));
  return run;
}

export function safeName(name) {
  const clean = String(name || '').trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 80);
  if (!clean) throw new Error('Invalid filename');
  return clean;
}

export function writeFile(filename, content, opts = {}) {
  const name = safeName(filename);
  return withFileLock(name, () => writeFileUnlocked(name, content, opts));
}

async function writeFileUnlocked(name, content, { append = false } = {}) {
  const dir = await getWorkspaceDir();
  const fh = await dir.getFileHandle(name, { create: true });
  const position = append ? (await fh.getFile()).size : 0;
  const writable = await fh.createWritable({ keepExistingData: append });
  if (append) await writable.write({ type: 'write', position, data: content });
  else await writable.write(content);
  await writable.close();
  const size = (await fh.getFile()).size;
  // bytes was `content.length` — a character count reported as bytes, which is
  // wrong for any non-ASCII content the agent saves.
  return { name, bytes: new TextEncoder().encode(content).byteLength, size };
}

export async function readFile(filename) {
  const dir = await getWorkspaceDir();
  const fh = await dir.getFileHandle(safeName(filename));
  const text = await (await fh.getFile()).text();
  if (!text) return '(empty file)';
  return text.length > MAX_READ_CHARS
    ? text.slice(0, MAX_READ_CHARS) + `\n[truncated — file is ${text.length} chars total]`
    : text;
}

export async function removeFile(filename) {
  const dir = await getWorkspaceDir();
  await dir.removeEntry(safeName(filename));
}

export async function listFiles() {
  const dir = await getWorkspaceDir();
  const out = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'file') continue;
    const f = await handle.getFile();
    out.push({ name, size: f.size, modified: f.lastModified });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
