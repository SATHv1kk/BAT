// Data/run state store — IndexedDB is the single source of truth for collected
// rows; the output file is only a projection of it. Deduplication happens here,
// BEFORE any write, because an append-only text file can't merge duplicates.
// Tables: rows (per-collection, dedup-keyed), runs, log (schema ready for the
// plan runner; rows is the one exercised today).

const DB_NAME = 'bat-data';
const DB_VERSION = 2; // v2: extractors table

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('rows')) {
        const rows = db.createObjectStore('rows', { keyPath: ['collection', 'dedupKey'] });
        rows.createIndex('byCollection', 'collection');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta');
      }
      if (!db.objectStoreNames.contains('runs')) {
        db.createObjectStore('runs', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('log')) {
        const log = db.createObjectStore('log', { autoIncrement: true });
        log.createIndex('byRun', 'runId');
      }
      if (!db.objectStoreNames.contains('extractors')) {
        db.createObjectStore('extractors', { keyPath: 'pattern' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => { dbPromise = null; };
      // Another context (e.g. the future service-worker runner) bumping
      // DB_VERSION must never be blocked by our held-open connection.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

const p = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

// Awaiting a transaction is not the same as awaiting its last request: only
// oncomplete proves the data is durable. Anything that must survive a reload
// waits on this.
const txDone = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
});

// Normalized composite key: lowercase, trimmed, whitespace collapsed,
// punctuation stripped — so "Sr. Engineer — Vision" and "sr engineer vision"
// collide on purpose.
//
// Except: stripping ALL punctuation over-merged real, distinct rows. "C++
// Developer" and "C Developer" became the same key, as did "C#"/"C", ".NET"/
// "NET" and "Node.js"/"Nodejs" against their neighbours — and because the first
// row wins, the loser was discarded silently. Tech names carry meaning in their
// punctuation, so `+ # .` are transliterated to word-safe markers BEFORE the
// strip rather than being erased by it.
// A dot is only meaningful INSIDE a token ("Node.js", ".NET"). An abbreviating
// dot ("Sr. Engineer") is punctuation and must still be erased, or every
// abbreviation would grow a spurious "dot" segment.
const TECH_TOKENS = [
  [/\+\+/g, ' plusplus '],
  [/\+/g, ' plus '],
  [/#/g, ' sharp '],
  [/(?<=[\p{L}\p{N}])\.(?=[\p{L}\p{N}])/gu, ' dot '],
  [/(?<![\p{L}\p{N}])\.(?=[\p{L}\p{N}])/gu, ' dot ']
];

export function dedupKeyFor(row, fields) {
  return fields.map(f => {
    let s = String(row?.[f] ?? '').toLowerCase().normalize('NFKD');
    for (const [re, sub] of TECH_TOKENS) s = s.replace(re, sub);
    return s
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
  }).join('|');
}

// Insert rows with dedup. On collision the FIRST record wins; the new row's
// source is merged into the existing record's source list. Returns the fresh
// (novel) records in insertion order plus the merge count.
export async function addRows(collection, rows, { dedupFields, sourceField = 'source' } = {}) {
  if (!Array.isArray(dedupFields) || !dedupFields.length) {
    throw new Error('dedupFields is required, e.g. ["company", "title"]');
  }
  if (!Array.isArray(rows) || !rows.length) {
    throw new Error('addRows needs a non-empty array of row objects');
  }
  const badRow = rows.findIndex(r => !r || typeof r !== 'object' || Array.isArray(r));
  if (badRow !== -1) {
    throw new Error(`rows[${badRow}] is not an object — each row must be {column: value, ...}`);
  }
  const db = await openDb();

  // Phase 1 — READ only the keys this batch needs, in ONE transaction.
  //
  // Two constraints shape this. Awaiting BETWEEN requests inside a transaction
  // lets it auto-commit mid-loop (TransactionInactiveError), so every request
  // must be issued in the same tick and awaited together. And loading the whole
  // collection (getAll) would cost O(collection) on every page write — 20k
  // records to insert 100 rows. Issue N point lookups up front, await once.
  const seqKey = 'seq:' + collection;
  const countKey = 'count:' + collection;
  const mergedKey = 'merged:' + collection;

  // Compute keys first so the read set is known before the transaction opens.
  const prepared = [];
  const wantedKeys = new Set();
  for (const data of rows) {
    const dedupKey = dedupKeyFor(data, dedupFields);
    const blank = !dedupKey.replace(/\|/g, '').trim();
    prepared.push({ data, dedupKey, blank });
    if (!blank) wantedKeys.add(dedupKey);
  }
  const keyList = [...wantedKeys];

  const t0 = db.transaction(['rows', 'meta'], 'readonly');
  const rowsStore0 = t0.objectStore('rows');
  const metaStore0 = t0.objectStore('meta');
  const lookups = keyList.map((k) => p(rowsStore0.get([collection, k])));
  const [seq, cnt, mrg, ...found] = await Promise.all([
    p(metaStore0.get(seqKey)),
    p(metaStore0.get(countKey)),
    p(metaStore0.get(mergedKey)),
    ...lookups
  ]);

  const keyed = new Map();
  found.forEach((rec, i) => { if (rec) keyed.set(keyList[i], rec); });

  let nextSeq = seq || 0;
  let totalCount = cnt;
  let totalMerged = mrg;
  if (totalCount == null) {
    // Pre-counter data (or a collection written before counters existed): pay
    // the O(n) scan exactly once and persist the result below.
    const all = await getRows(collection);
    totalCount = all.length;
    totalMerged = all.reduce((n, r) => n + (r.mergedCount || 0), 0);
  }

  // Phase 2 — decide everything in memory (no IDB, no awaits).
  const fresh = [];
  const updated = [];
  let merged = 0;
  for (const item of prepared) {
    const data = item.data;
    // Rows with every dedup field empty must not all collapse onto one key.
    const dedupKey = item.blank ? '__blank__:' + nextSeq : item.dedupKey;
    const src = String(data?.[sourceField] ?? '').replace(/\s+/g, ' ').trim();
    const existing = keyed.get(dedupKey);
    if (existing) {
      if (src && !existing.sources.includes(src)) existing.sources.push(src);
      existing.mergedCount = (existing.mergedCount || 0) + 1;
      if (!updated.includes(existing)) updated.push(existing);
      merged++;
      totalMerged++;
    } else {
      const rec = {
        collection,
        dedupKey,
        seq: nextSeq++,
        data,
        sources: src ? [src] : [],
        mergedCount: 0,
        firstSeenAt: Date.now()
      };
      keyed.set(dedupKey, rec);
      fresh.push(rec);
      totalCount++;
    }
  }

  // Phase 3 — WRITE everything in one transaction, no awaits in between.
  const t = db.transaction(['rows', 'meta'], 'readwrite');
  const rowsStore = t.objectStore('rows');
  const metaStore = t.objectStore('meta');
  for (const rec of fresh) rowsStore.put(rec);
  for (const rec of updated) rowsStore.put(rec);
  metaStore.put(nextSeq, seqKey);
  metaStore.put(totalCount, countKey);
  metaStore.put(totalMerged, mergedKey);
  await txDone(t);
  return { fresh, merged };
}

export async function getRows(collection) {
  const db = await openDb();
  try {
    const store = db.transaction('rows', 'readonly').objectStore('rows');
    const all = await p(store.index('byCollection').getAll(collection));
    return all.sort((a, b) => a.seq - b.seq);
  } finally {
    /* connection cached — kept open */
  }
}

// O(1) counts from the meta counters — called after every page write, so it
// must NOT read the whole collection (that was ~5,000 records per write at
// 5,000 rows collected).
export async function getCounts(collection) {
  const db = await openDb();
  const store = db.transaction('meta', 'readonly').objectStore('meta');
  const [cnt, mrg] = await Promise.all([
    p(store.get('count:' + collection)),
    p(store.get('merged:' + collection))
  ]);
  if (cnt == null) {
    // Pre-counter data: scan once, then PERSIST so this never repeats. The write
    // must be AWAITED — returning before oncomplete meant the transaction could
    // still abort, and then "this never repeats" quietly became "this repeats
    // every single write", which is the O(n) scan this counter exists to avoid.
    const rows = await getRows(collection);
    const counts = {
      uniqueRows: rows.length,
      duplicatesMerged: rows.reduce((n, r) => n + (r.mergedCount || 0), 0)
    };
    const wt = db.transaction('meta', 'readwrite');
    wt.objectStore('meta').put(counts.uniqueRows, 'count:' + collection);
    wt.objectStore('meta').put(counts.duplicatesMerged, 'merged:' + collection);
    await txDone(wt);
    return counts;
  }
  return { uniqueRows: cnt, duplicatesMerged: mrg || 0 };
}

// The full report comes from the store — never from the model's recollection.
// Reads every row on purpose (per-source breakdown); call it at the END of a
// job, not per page.
export async function getReport(collection) {
  const rows = await getRows(collection);
  const perSource = {};
  let duplicatesMerged = 0;
  for (const r of rows) {
    duplicatesMerged += r.mergedCount;
    for (const s of (r.sources.length ? r.sources : ['(no source)'])) {
      perSource[s] = (perSource[s] || 0) + 1;
    }
  }
  return { collection, uniqueRows: rows.length, duplicatesMerged, perSource };
}

// Project a stored record back to a flat row, with all merged sources joined
// into the source cell.
export function projectRow(rec, sourceField = 'source') {
  const out = { ...rec.data };
  if (rec.sources.length) out[sourceField] = rec.sources.join('; ');
  return out;
}

// ── Extractor cache (extract_rows meta-tool) ─────────────────────
// One record per URL pattern: the active version, retired version history
// (so a regression can be diffed against what used to work), trailing row
// counts for collapse detection, and the failure streak that drives halting.
export async function getExtractor(pattern) {
  const db = await openDb();
  return p(db.transaction('extractors', 'readonly').objectStore('extractors').get(pattern));
}

export async function listExtractors() {
  const db = await openDb();
  const all = await p(db.transaction('extractors', 'readonly').objectStore('extractors').getAll());
  return all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function deleteExtractor(pattern) {
  const db = await openDb();
  const tx = db.transaction('extractors', 'readwrite');
  tx.objectStore('extractors').delete(pattern);
  await txDone(tx);
}

export async function putExtractor(record) {
  const db = await openDb();
  const t = db.transaction('extractors', 'readwrite');
  await p(t.objectStore('extractors').put({ ...record, updatedAt: Date.now() }));
}

// ── Run + log tables (consumed by the plan runner; minimal API for now) ──
export async function saveRun(run) {
  const db = await openDb();
  try {
    const t = db.transaction('runs', 'readwrite');
    await p(t.objectStore('runs').put({ ...run, updatedAt: Date.now() }));
  } finally {
    /* connection cached — kept open */
  }
}

export async function getRun(id) {
  const db = await openDb();
  try {
    return await p(db.transaction('runs', 'readonly').objectStore('runs').get(id));
  } finally {
    /* connection cached — kept open */
  }
}

export async function listRuns() {
  const db = await openDb();
  return p(db.transaction('runs', 'readonly').objectStore('runs').getAll());
}

// ── Inventory + deletion, for the stored-data manager ─────────────
// Collected rows, cached extractors and run logs used to be invisible and
// permanent: "Clear chat" only wiped chrome.storage.session, so a user had no way
// to see what BAT had kept about them, let alone remove it.
export async function listCollections() {
  const db = await openDb();
  const store = db.transaction('rows', 'readonly').objectStore('rows');
  const keys = await p(store.index('byCollection').getAllKeys());
  const tally = new Map();
  for (const k of keys) {
    const name = Array.isArray(k) ? k[0] : k;
    tally.set(name, (tally.get(name) || 0) + 1);
  }
  const out = [];
  for (const [name, rowCount] of tally) {
    const counts = await getCounts(name).catch(() => ({ uniqueRows: rowCount, duplicatesMerged: 0 }));
    out.push({ collection: name, ...counts });
  }
  return out.sort((a, b) => a.collection.localeCompare(b.collection));
}

export async function deleteCollection(collection) {
  const db = await openDb();
  const keys = await p(
    db.transaction('rows', 'readonly').objectStore('rows').index('byCollection').getAllKeys(collection)
  );
  const tx = db.transaction(['rows', 'meta'], 'readwrite');
  const rows = tx.objectStore('rows');
  for (const k of keys) rows.delete(k);
  const meta = tx.objectStore('meta');
  for (const prefix of ['seq:', 'count:', 'merged:', 'notfound:']) meta.delete(prefix + collection);
  await txDone(tx);
  return keys.length;
}

export async function deleteRun(runId) {
  const db = await openDb();
  const logKeys = await p(db.transaction('log', 'readonly').objectStore('log').index('byRun').getAllKeys(runId));
  const tx = db.transaction(['runs', 'log'], 'readwrite');
  tx.objectStore('runs').delete(runId);
  const log = tx.objectStore('log');
  for (const k of logKeys) log.delete(k);
  await txDone(tx);
  return logKeys.length;
}

export async function logEvent(runId, entry) {
  const db = await openDb();
  try {
    const t = db.transaction('log', 'readwrite');
    await p(t.objectStore('log').add({ runId, ts: Date.now(), ...entry }));
  } finally {
    /* connection cached — kept open */
  }
}

// NOT-FOUND bookkeeping. Keyed by collection (the output filename) so it works
// for interactive sweeps too, where there is no run id — otherwise the report's
// NOT-FOUND section would read from a log nothing ever writes.
// Read-modify-write inside ONE transaction. It previously opened a readwrite
// transaction, awaited a get on it, then opened a SECOND transaction to do the
// put — so two concurrent calls (easy: a sweep records several misses in
// parallel) both read the same list and the second write erased the first.
// IndexedDB serializes overlapping readwrite transactions on the same store, so
// keeping it to one makes the update atomic.
export async function recordNotFound(collection, label, detail = '') {
  const db = await openDb();
  const key = 'notfound:' + collection;
  const tx = db.transaction('meta', 'readwrite');
  const store = tx.objectStore('meta');
  const existing = (await p(store.get(key))) || [];
  if (!existing.some((e) => e.label === label)) existing.push({ label, detail, ts: Date.now() });
  store.put(existing, key);
  await txDone(tx);
  return existing.length;
}

export async function getNotFound(collection) {
  const db = await openDb();
  const store = db.transaction('meta', 'readonly').objectStore('meta');
  return (await p(store.get('notfound:' + collection))) || [];
}

// The end-of-job report, assembled from the log + rows tables. This is what
// gets reported to the user — the model is never asked to remember a run.
export async function buildRunReport(runId) {
  const run = await getRun(runId);
  if (!run) return null;
  const log = await getRunLog(runId);

  const perUnit = new Map();
  const notFound = [];
  const synthesized = [];
  const problems = [];
  for (const e of log) {
    if (e.kind === 'page') {
      const u = perUnit.get(e.unitId) || { pages: 0, rows: 0, outcomes: {} };
      u.pages++;
      u.rows += e.fresh || 0;
      u.outcomes[e.outcome] = (u.outcomes[e.outcome] || 0) + 1;
      perUnit.set(e.unitId, u);
      if (['stalled', 'invalid', 'synth_failed', 'error'].includes(e.outcome)) {
        problems.push(`${e.unitId} p${e.page}: ${e.outcome}${e.note ? ' — ' + e.note : ''}`);
      }
    } else if (e.kind === 'unit_blocked') {
      problems.push(`${e.unitId}: ABANDONED (${e.reason || 'repeated failures'})${e.note ? ' — ' + e.note : ''}`);
    } else if (e.kind === 'not_found') {
      notFound.push(e.note || e.unitId);
    } else if (e.kind === 'extractor_synthesized') {
      synthesized.push(e.pattern);
    } else if (e.kind === 'file_write_failed' || e.kind === 'budget_stop') {
      problems.push(`${e.kind}: ${e.note || ''}`);
    }
  }

  const collection = run.plan.filename ? safeCollection(run.plan.filename) : runId;
  const report = await getReport(collection);
  for (const nf of await getNotFound(collection)) {
    notFound.push(nf.detail ? `${nf.label} (${nf.detail})` : nf.label);
  }
  const emptyUnits = run.plan.units
    .filter(u => !(perUnit.get(u.id)?.rows))
    .map(u => u.id);

  return {
    runId,
    status: run.status,
    filename: run.plan.filename,
    totalRows: report.uniqueRows,
    duplicatesMerged: report.duplicatesMerged,
    pagesVisited: run.counts.pages,
    tokensSpent: run.counts.tokens || 0,
    perUnit: [...perUnit.entries()].map(([id, v]) => ({ unitId: id, ...v })),
    perSource: report.perSource,
    unitsWithNoRows: emptyUnits,
    notFound,
    extractorsSynthesized: [...new Set(synthesized)],
    problems,
    pendingExport: !!run.pendingExport
  };
}

// Mirror of workspace.safeName for collection keys (kept local so the store
// has no dependency on the workspace module).
function safeCollection(name) {
  return String(name || '').trim().replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '').slice(0, 80);
}

export async function getRunLog(runId) {
  const db = await openDb();
  try {
    const store = db.transaction('log', 'readonly').objectStore('log');
    return await p(store.index('byRun').getAll(runId));
  } finally {
    /* connection cached — kept open */
  }
}
