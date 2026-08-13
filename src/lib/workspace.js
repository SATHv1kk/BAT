// Workspace — the ONE fixed location the agent's files live in.
//
// The location is decided once and then never moves on its own. There are
// exactly two possible fixed locations, and an install is in one of them:
//
//   • No folder ever chosen (the zero-setup default) — files live in embedded
//     storage (embedded-storage.js, IndexedDB-backed, no OS permission, never
//     expires). This is a real, permanent location, not a degraded mode.
//   • A folder chosen once via showDirectoryPicker — THAT folder is the
//     location from then on. The handle is kept in IndexedDB so it survives
//     panel close and browser restarts.
//
// What this file deliberately does NOT do any more is silently switch between
// the two. Chrome's File System Access grant is not reliably persistent across
// restarts/extension reloads (a real platform behavior, not something BAT
// controls), and the old code responded by transparently redirecting writes to
// embedded storage whenever the grant lapsed. That kept writes succeeding, but
// it meant "where is my data?" had no stable answer: half a collection could
// land in the folder and half in the extension, with only a settings line to
// say so. A fixed location that occasionally needs one click to reconnect is
// more useful than a moving one that never asks.
//
// So: once a folder is pinned, file operations either use that folder or fail
// with an actionable error naming it. They never quietly write somewhere else.
// Rows are never lost either way — the state store (state-store.js) is the
// authority for collected data and the file is only a projection of it, so a
// lapsed grant costs an export_rows, not a collection.

import { embeddedRoot } from './embedded-storage.js';

const DB_NAME = 'bat-workspace';
const STORE = 'handles';
const KEY = 'workspace-dir';
const MAX_READ_CHARS = 30000;

// Test-only in-memory handle store. Mock handles (e.g. from the integration test)
// contain async functions that cannot survive IndexedDB's structuredClone.
// When active, loadHandle/useEmbeddedStorage/pickWorkspace route through this
// instead of the real IndexedDB so the real keys are never touched by test fixtures.
const _testHandleStore = new Map();
let _testHandleActive = false;

// Identifies which backend answered. output-writer.js keys its file-state cache
// on this: a cached header/row-count from one location must never be applied to
// a same-named file in the other just because the byte sizes happened to match.
export const EMBEDDED_BACKEND_ID = 'embedded';

export async function _setHandleForTest(handle) {
  _testHandleStore.set(KEY, handle);
  _testHandleActive = true;
}
export async function _clearHandleForTest() {
  _testHandleStore.delete(KEY);
  _testHandleActive = false;
}

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
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(key) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// A missing record means "nothing was ever pinned" — that is a real answer and
// resolves to embedded storage. An IndexedDB *failure* is not that answer, and
// used to be flattened into it by a bare `catch { return null }`: a transient
// read error silently reported "no folder is pinned", so writes went to
// embedded storage while a folder was pinned all along. That is precisely the
// location drift this module exists to prevent, arrived at through the error
// path instead of the fallback path. Fail loudly instead.
async function loadHandle() {
  if (_testHandleActive) return _testHandleStore.get(KEY) || null;
  try {
    return (await idbGet(KEY)) || null;
  } catch (e) {
    const err = new Error(
      'Could not read which workspace folder is pinned (IndexedDB error: '
      + (e?.message || String(e)) + '). Nothing was written, because writing '
      + 'somewhere other than the pinned folder is never the right recovery. '
      + 'Reload the extension and retry — collected rows are safe in BAT\'s store.'
    );
    err.workspaceUnavailable = true;
    throw err;
  }
}

// Can THIS JavaScript context hold a File System Access grant at all?
//
// It genuinely differs by context, and conflating the two produced the single
// most confusing symptom this extension had. A grant is bound to the document
// that requested it: the side panel has one, the MV3 service worker does not.
// A handle restored from IndexedDB inside the worker therefore reports
// 'prompt' forever, and there is no user gesture in a worker to re-request
// with — so the background runner's every page-write failed with "press
// Reconnect folder", while the panel sitting next to it was fully connected.
// The user saw a folder that "kept disconnecting" and reconnected it over and
// over; nothing was ever wrong with the grant.
// Probes for the service worker specifically rather than for the absence of a
// document: Node (where this module is unit-tested) also has no document, and
// treating that as "cannot hold a grant" quietly flipped the tests onto the
// worker branch and away from the panel semantics they exist to pin down.
// `ServiceWorkerGlobalScope` is only defined inside a service worker.
export function canHoldFsaGrant() {
  // Read off globalThis rather than as a bare identifier: the constructor only
  // exists inside a worker, so naming it directly is an undefined reference
  // everywhere else (and a lint error).
  const SW = globalThis.ServiceWorkerGlobalScope;
  return !(typeof SW === 'function' && globalThis instanceof SW);
}

// queryPermission/requestPermission only exist where the File System Access API
// does — the side panel, not the service worker. Treat their absence as "not
// currently usable from here" rather than letting a TypeError escape.
async function permissionState(handle) {
  if (typeof handle?.queryPermission !== 'function') return 'unavailable';
  try {
    return await handle.queryPermission({ mode: 'readwrite' });
  } catch {
    return 'unavailable';
  }
}

// Must be called from a user gesture (a settings button). Re-grants permission
// on the stored handle when possible so the user does not have to re-pick the
// same folder, and only opens the picker when there is nothing to re-grant or
// the re-grant was refused.
export async function pickWorkspace() {
  const existing = await loadHandle();
  if (existing && typeof existing.requestPermission === 'function') {
    try {
      if ((await existing.requestPermission({ mode: 'readwrite' })) === 'granted') return existing;
    } catch (_) { /* fall through to the picker */ }
  }
  // showDirectoryPicker's availability inside a Chrome extension SIDE PANEL
  // (as opposed to a popup or a full tab) is genuinely inconsistent across
  // Chrome versions/builds — this is a documented platform quirk (see
  // Chromium issue 40240444 and WICG/file-system-access#314), not something
  // a retry or a different call shape fixes. Detect it up front so the
  // failure is a clear, actionable message instead of a raw
  // "showDirectoryPicker is not a function" TypeError.
  if (typeof globalThis.showDirectoryPicker !== 'function') {
    throw new Error(
      'This Chrome build/version does not expose the folder picker inside the side panel '
      + '(a known Chrome platform limitation, not a BAT bug). Try updating Chrome to the '
      + 'latest version (chrome://settings/help), then reload the extension. Files keep '
      + 'working meanwhile — they stay in embedded storage.'
    );
  }
  // The stable `id` is what makes the picker reopen at the SAME place every
  // time, so re-picking after a lapsed grant is one click on an already-
  // highlighted folder rather than navigating the disk again.
  const handle = await globalThis.showDirectoryPicker({ id: 'bat-workspace', mode: 'readwrite' });
  if (_testHandleActive) _testHandleStore.set(KEY, handle);
  else await idbSet(KEY, handle);
  return handle;
}

// Re-grant the pinned folder without opening the picker. Also needs a user
// gesture (Chrome requires activation for requestPermission), which is why this
// is a button in Settings rather than something init can do on its own.
export async function reconnectWorkspace() {
  const handle = await loadHandle();
  if (!handle) return { ok: false, reason: 'no folder is pinned' };
  if (typeof handle.requestPermission !== 'function') {
    return { ok: false, reason: 'the folder API is not available in this context' };
  }
  try {
    const state = await handle.requestPermission({ mode: 'readwrite' });
    return state === 'granted'
      ? { ok: true, name: handle.name }
      : { ok: false, reason: `permission was ${state}` };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  }
}

// Un-pin the folder and go back to embedded storage as the fixed location.
// Without this a lapsed grant on a folder the user no longer has (an unplugged
// drive, a deleted directory) would be an inescapable error on every write.
export async function useEmbeddedStorage() {
  const wasTest = _testHandleActive;
  _testHandleActive = false;
  _testHandleStore.delete(KEY);
  if (!wasTest) await idbDelete(KEY).catch(() => {});
}

// The single source of truth for where files go right now. Either the pinned
// folder, or embedded storage when nothing was ever pinned — and an explicit
// throw when a folder IS pinned but is not currently reachable, because
// answering that case with a different directory is the drift this module
// exists to prevent.
async function getActiveDir() {
  const handle = await loadHandle();
  if (!handle) return { dir: embeddedRoot, backendId: EMBEDDED_BACKEND_ID, embedded: true };

  const perm = await permissionState(handle);
  // Re-check that the handle wasn't un-pinned while permissionState ran.
  // Use .name comparison, not reference identity: IndexedDB may return a
  // different object for the same stored entry via structured clone.
  const latest = await loadHandle();
  if (!latest || latest.name !== handle.name) {
    return { dir: embeddedRoot, backendId: EMBEDDED_BACKEND_ID, embedded: true };
  }
  if (perm === 'granted') {
    // Collected data goes into a "data" subfolder of the pinned folder, never its
    // root: the root may hold source-adjacent files (like this repo's workspace/
    // with its README and change log), and mixing agent output into it makes
    // "where did my file go?" hard to answer. The subfolder is created lazily.
    const dataDir = await handle.getDirectoryHandle('data', { create: true });
    // backendId must uniquely identify THIS folder, and handle.name is only the
    // last path segment — two different folders both named "BAT" produced the
    // same id, so output-writer's per-location state (header + append position)
    // learned from folder A was reapplied to folder B after a re-pin, silently
    // corrupting the file. getUniqueId() is the handle's identity, stable for
    // the handle's lifetime; fall back to the name only where the API is absent
    // (getUniqueId is Chrome 121+).
    let unique;
    try {
      unique = await handle.getUniqueId?.() || handle.name;
    } catch {
      unique = handle.name;
    }
    return { dir: dataDir, backendId: 'folder:' + unique + '/data', embedded: false };
  }
  // Two very different situations reach this point, and telling them apart is
  // the difference between an actionable prompt and a wild goose chase.
  const err = new Error(
    canHoldFsaGrant()
      ? `The workspace folder "${handle.name}" is not connected right now, so nothing was written. `
        + 'Chrome drops folder permission on restart and extension reload; it has to be re-granted by a click. '
        + 'Open Settings (⚙) and press "Reconnect folder", then retry. '
        + '(Collected rows are safe in BAT\'s store either way — re-run export_rows once reconnected. '
        + 'To stop using a folder entirely, press "Use embedded storage" in Settings.)'
      : `This background context cannot write to the pinned folder "${handle.name}" — `
        + 'Chrome binds a folder grant to the side panel that requested it, and a service '
        + 'worker can never hold one. This is NOT a lapsed permission and pressing '
        + '"Reconnect folder" does not address it. Rows are safe in BAT\'s store and the '
        + 'file is written by the panel instead (immediately if it is open, otherwise the '
        + 'next time it opens).'
  );
  err.workspaceDisconnected = true;
  // Set only for the worker case, so callers can route around it instead of
  // telling the user to fix a permission that is not broken.
  err.contextCannotHoldGrant = !canHoldFsaGrant();
  err.folderName = handle.name;
  throw err;
}

// The directory handle plus the id of the location it belongs to, in one call —
// so a caller that caches per-file state can key that cache on the location
// without a second permission round-trip that could disagree with the first.
export async function getActiveLocation() {
  return getActiveDir();
}

export async function getWorkspaceDir() {
  const { dir } = await getActiveDir();
  return dir;
}

export async function getStatus() {
  const handle = await loadHandle();
  if (!handle) {
    return {
      ok: true,
      embedded: true,
      pinned: false,
      needsReconnect: false,
      location: 'Embedded storage (inside the extension)',
      text: 'Fixed location: embedded storage — Choose folder to pin real files on disk instead'
    };
  }
  const perm = await permissionState(handle);
  if (perm === 'granted') {
    return {
      ok: true,
      embedded: false,
      pinned: true,
      needsReconnect: false,
      location: handle.name,
      text: `Fixed location: ${handle.name}`
    };
  }
  // In a context that can never hold the grant (the service worker), "needs
  // reconnect" would be a lie — there is nothing the user can press that helps.
  if (!canHoldFsaGrant()) {
    return {
      ok: false,
      embedded: false,
      pinned: true,
      needsReconnect: false,
      contextCannotHoldGrant: true,
      location: handle.name,
      text: `"${handle.name}" is pinned; this background context cannot write to it (the panel does)`
    };
  }
  return {
    ok: false,
    embedded: false,
    pinned: true,
    needsReconnect: true,
    location: handle.name,
    text: `"${handle.name}" is pinned but disconnected — press Reconnect folder (files are not being written meanwhile)`
  };
}

// Is a folder pinned at all? Answers without touching permissions, so the
// background runner can ask "should I hand this write to the panel?" without
// provoking the disconnection error it is trying to route around.
export async function isFolderPinned() {
  try {
    return !!(await loadHandle());
  } catch {
    return false;
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
  const cleanup = run.then(() => {}, () => {});
  fileLocks.set(name, cleanup);
  cleanup.then(() => { if (fileLocks.get(name) === cleanup) fileLocks.delete(name); });
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
  const name = safeName(filename);
  // A file that does not exist and a location that cannot be reached are
  // completely different problems, and getFileHandle's raw NotFoundError does
  // not say which one it is. Read as "Workspace error: ..." by a caller, a
  // simple typo looked exactly like a dropped folder permission — so the fix
  // attempted was reconnecting a folder that had never disconnected. Name the
  // real cause, and list what IS there so the next call can succeed.
  let fh;
  try {
    fh = await dir.getFileHandle(name);
  } catch (e) {
    if (e?.name !== 'NotFoundError') throw e;
    let available = [];
    try {
      available = (await listFiles()).map(f => f.name);
    } catch (_) { /* listing is a courtesy; the real error is below */ }
    const err = new Error(
      `No file named "${name}" exists in the workspace (the location itself is fine — this is a missing file, not a disconnected folder). `
      + (available.length
        ? `Files present: ${available.join(', ')}.`
        : 'The workspace is empty.')
    );
    err.fileNotFound = true;
    throw err;
  }
  const text = await (await fh.getFile()).text();
  if (!text) return '(empty file)';
  return text.length > MAX_READ_CHARS
    ? text.slice(0, MAX_READ_CHARS) + `\n[truncated — file is ${text.length} chars total]`
    : text;
}

export async function clearFiles() {
  try {
    const dir = await getWorkspaceDir();
    const names = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== 'file') continue;
      names.push(name);
    }
    // Remove each file UNDER its lock: a removal landing between a writer's
    // createWritable and its close() would be silently undone when the swap
    // recreates the file — the clear would report success while leaving the
    // file behind. Serializing per name closes that window.
    await Promise.all(names.map((name) =>
      withFileLock(name, async () => {
        await dir.removeEntry(name).catch(() => {});
      })
    ));
  } catch (_) { /* disconnected — nothing to clear */ }
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
