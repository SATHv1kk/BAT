// embedded-storage.js's write shim is a duck-typed FileSystemWritableFileStream
// backed by a single IndexedDB record. resolveWrite is the pure decision at
// its core — "what should this file's content become" — pulled out so it's
// testable without a real IndexedDB, the way state-store.js/workspace.js's
// browser-only glue generally isn't.
const B = new URL('../src/', import.meta.url).href;
const { resolveWrite } = await import(B + 'lib/embedded-storage.js');

export default function run(t) {
  // ── plain string write: full overwrite regardless of prior content ──
  t('string write replaces content entirely', resolveWrite('old stuff', 'new content') === 'new content');
  t('string write on empty file', resolveWrite('', 'first content') === 'first content');

  // ── chunk write at position 0: matches how a fresh/truncated file is written ──
  t('chunk at position 0 on empty file sets content', resolveWrite('', { type: 'write', position: 0, data: 'header\n' }) === 'header\n');
  t('chunk at position 0 on non-empty file still sets content (matches real FS: this is how a fresh write starts)',
    resolveWrite('stale', { type: 'write', position: 0, data: 'fresh' }) === 'fresh');

  // ── chunk write at end-of-file: the append case every writer here actually uses ──
  t('chunk at exact end-of-file appends', resolveWrite('a\tb\n', { type: 'write', position: 4, data: '1\t2\n' }) === 'a\tb\n1\t2\n');
  t('append position is measured in BYTES not characters (non-ASCII)', (() => {
    const existing = 'café\n'; // 'é' is 2 bytes in UTF-8, so byte length !== char length
    const byteLen = new TextEncoder().encode(existing).byteLength;
    return resolveWrite(existing, { type: 'write', position: byteLen, data: 'more\n' }) === existing + 'more\n';
  })());

  // ── unsupported shapes must fail loudly, not silently corrupt data ──
  t('mid-file random-access write is rejected, not silently mishandled', (() => {
    try { resolveWrite('abcdef', { type: 'write', position: 2, data: 'XX' }); return false; }
    catch (e) { return /neither 0 nor end-of-file/.test(e.message); }
  })());
  t('unrecognized write argument is rejected', (() => {
    try { resolveWrite('x', 42); return false; }
    catch (e) { return /unsupported write/.test(e.message); }
  })());
  t('null write argument is rejected', (() => {
    try { resolveWrite('x', null); return false; }
    catch { return true; }
  })());
}
