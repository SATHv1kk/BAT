// Structured row writer — TSV/CSV appends into the workspace folder.
// Append-only by design: the header is written exactly once (when the file is
// created or empty), every later call appends at end-of-file, and cells are
// sanitized so one bad value can't break column alignment. The file itself is
// the authority for the running row count — never a counter the model holds.

import { getWorkspaceDir, safeName } from './workspace.js';

// filename → { columns, rowCount, size } — cache so we don't re-read the whole
// file on every flush; invalidated automatically when the size doesn't match
// (external edit, another writer, or a fresh panel session).
const writerState = new Map();
const encoder = new TextEncoder();

// FSA writables are swap-file based: two overlapping writers would each copy
// the file and the last close() would silently drop the other's chunk. All
// writes to one file are serialized through a per-file promise chain.
const fileLocks = new Map();
function withFileLock(name, fn) {
  const prev = fileLocks.get(name) || Promise.resolve();
  const run = prev.then(fn, fn);
  fileLocks.set(name, run.then(() => {}, () => {}));
  return run;
}

function assertRowObjects(rows, label) {
  if (!Array.isArray(rows) || !rows.length) {
    throw new Error(`${label} needs a non-empty array of row objects`);
  }
  const bad = rows.findIndex(r => !r || typeof r !== 'object' || Array.isArray(r));
  if (bad !== -1) {
    throw new Error(`rows[${bad}] is not an object — each row must be {column: value, ...}`);
  }
}

function delimiterFor(filename, format) {
  if (format === 'csv') return ',';
  if (format === 'tsv') return '\t';
  return /\.csv$/i.test(filename) ? ',' : '\t';
}

// Strip tabs/newlines/CR from every cell; CSV additionally quotes the
// delimiter and doubles embedded quotes.
function sanitizeCell(value, delimiter) {
  let s = value == null ? '' : String(value);
  s = s.replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (delimiter === ',' && /[",]/.test(s)) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function formatRow(row, columns, delimiter) {
  return columns.map(c => sanitizeCell(row[c], delimiter)).join(delimiter);
}

async function readFileState(fh, delimiter) {
  const file = await fh.getFile();
  const text = await file.text();
  const lines = text.split('\n').filter(l => l.trim().length);
  return {
    size: file.size,
    endsWithNewline: text.length === 0 || text.endsWith('\n'),
    header: lines.length ? lines[0].split(delimiter).map(h => h.replace(/^"|"$/g, '')) : null,
    rowCount: Math.max(0, lines.length - 1)
  };
}

export function appendRows(filename, rows, opts = {}) {
  assertRowObjects(rows, 'appendRows');
  const name = safeName(filename);
  return withFileLock(name, () => appendRowsUnlocked(name, rows, opts));
}

async function appendRowsUnlocked(name, rows, { format, columns } = {}) {
  const dir = await getWorkspaceDir();
  const delimiter = delimiterFor(name, format);
  const fh = await dir.getFileHandle(name, { create: true });

  const file = await fh.getFile();
  let state = writerState.get(name);
  if (!state || state.size !== file.size) {
    state = await readFileState(fh, delimiter);
  }

  // Column order: an existing header always wins; a new file takes the caller's
  // order, falling back to the first row's keys.
  const cols = state.header || (columns?.length ? columns : Object.keys(rows[0]));
  const droppedKeys = [...new Set(rows.flatMap(r => Object.keys(r)))].filter(k => !cols.includes(k));

  let chunk = '';
  if (!state.endsWithNewline) chunk += '\n'; // externally edited file missing trailing newline
  if (!state.header) chunk += cols.map(c => sanitizeCell(c, delimiter)).join(delimiter) + '\n';
  chunk += rows.map(r => formatRow(r, cols, delimiter)).join('\n') + '\n';

  const writable = await fh.createWritable({ keepExistingData: true });
  await writable.write({ type: 'write', position: file.size, data: chunk });
  await writable.close();

  const rowCount = state.rowCount + rows.length;
  writerState.set(name, {
    size: file.size + encoder.encode(chunk).byteLength,
    endsWithNewline: true,
    header: cols,
    rowCount
  });
  return { name, appended: rows.length, rowCount, columns: cols, droppedKeys };
}

// Regenerate the whole file from a row set — used to export the state store's
// projection (e.g. with fully merged sources) over whatever was appended so far.
export function writeAll(filename, rows, opts = {}) {
  const name = safeName(filename);
  return withFileLock(name, () => writeAllUnlocked(name, rows, opts));
}

async function writeAllUnlocked(name, rows, { format, columns } = {}) {
  const dir = await getWorkspaceDir();
  const delimiter = delimiterFor(name, format);
  const cols = columns?.length ? columns : (rows.length ? Object.keys(rows[0]) : null);
  if (!cols) throw new Error('writeAll needs columns or at least one row');

  let text = cols.map(c => sanitizeCell(c, delimiter)).join(delimiter) + '\n';
  if (rows.length) text += rows.map(r => formatRow(r, cols, delimiter)).join('\n') + '\n';

  const fh = await dir.getFileHandle(name, { create: true });
  const writable = await fh.createWritable(); // truncates
  await writable.write(text);
  await writable.close();

  writerState.set(name, {
    size: encoder.encode(text).byteLength,
    endsWithNewline: true,
    header: cols,
    rowCount: rows.length
  });
  return { name, rowCount: rows.length, columns: cols };
}

// Authoritative count straight from the file (ignores the cache on purpose).
export async function getRowCount(filename, { format } = {}) {
  const dir = await getWorkspaceDir();
  const name = safeName(filename);
  const delimiter = delimiterFor(name, format);
  const fh = await dir.getFileHandle(name);
  const state = await readFileState(fh, delimiter);
  writerState.set(name, { ...state, endsWithNewline: state.endsWithNewline });
  return { name, rowCount: state.rowCount, columns: state.header || [] };
}
