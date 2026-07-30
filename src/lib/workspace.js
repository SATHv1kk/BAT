// Workspace folder — persistent on-disk files for the agent.
// The user grants a directory once via showSaveFilePicker's sibling
// showDirectoryPicker (a user gesture in the side panel); the handle is kept in
// IndexedDB so it survives panel close and browser restarts. The agent then
// reads/writes files inside that folder only — no access outside it.

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
      + 'latest version (chrome://settings/help), then reload the extension. Without a '
      + 'workspace folder, collected rows still stay safe in the extension\'s own store — '
      + 'only writing them out to a file on disk is unavailable.'
    );
  }
  const handle = await window.showDirectoryPicker({ id: 'bat-workspace', mode: 'readwrite' });
  await idbSet(KEY, handle);
  return handle;
}

export async function getWorkspaceDir() {
  return getGrantedHandle();
}

async function getGrantedHandle() {
  const handle = await loadHandle();
  if (!handle) {
    throw new Error('No workspace folder set — ask the user to pick one in Settings (⚙) → Workspace folder.');
  }
  const perm = await handle.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') {
    throw new Error('Workspace permission expired — ask the user to click "Choose folder" in Settings (⚙) to re-grant access.');
  }
  return handle;
}

export async function getStatus() {
  const handle = await loadHandle();
  if (!handle) return { ok: false, text: 'Not set — agent file tools disabled' };
  try {
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    return perm === 'granted'
      ? { ok: true, text: `Folder: ${handle.name}` }
      : { ok: false, text: `"${handle.name}" — click Choose folder to re-grant access` };
  } catch {
    return { ok: false, text: 'Folder unavailable — click Choose folder to pick again' };
  }
}

// ── Per-file write serialization ──────────────────────────────────
// File System Access writables are swap-file based: two overlapping writers each
// copy the file and the LAST close() silently discards the other's data. This
// lock used to live only in output-writer.js, so `save_file mode:"append"`
// racing `append_rows` on the same filename lost rows with no error anywhere.
// The lock belongs at the file layer, where every writer passes through it.
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
  const dir = await getGrantedHandle();
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
  const dir = await getGrantedHandle();
  const fh = await dir.getFileHandle(safeName(filename));
  const text = await (await fh.getFile()).text();
  if (!text) return '(empty file)';
  return text.length > MAX_READ_CHARS
    ? text.slice(0, MAX_READ_CHARS) + `\n[truncated — file is ${text.length} chars total]`
    : text;
}

export async function removeFile(filename) {
  const dir = await getGrantedHandle();
  await dir.removeEntry(safeName(filename));
}

export async function listFiles() {
  const dir = await getGrantedHandle();
  const out = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'file') continue;
    const f = await handle.getFile();
    out.push({ name, size: f.size, modified: f.lastModified });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
