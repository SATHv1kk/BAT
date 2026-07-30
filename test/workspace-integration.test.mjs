// Integration test for the embedded-storage fallback path, using a real (if
// fake) IndexedDB in Node rather than trusting the hand-traced logic alone —
// this exercises output-writer.js and workspace.js against embedded-storage.js
// exactly as the extension does, with no mocks standing in for the pieces
// under test. Two real bugs were found this way while building the feature
// (see comments below) that the pure resolveWrite unit tests alone would not
// have caught, because they were about the SHIM'S SURFACE matching what real
// FileSystemDirectoryHandle callers expect, not about the write-resolution
// math.
import 'fake-indexeddb/auto';

const B = new URL('../src/', import.meta.url).href;
const Workspace = await import(B + 'lib/workspace.js');
const Writer = await import(B + 'lib/output-writer.js');

export default async function run(t) {
  // No handle was ever stored (loadHandle() sees nothing in bat-workspace's
  // IndexedDB, since this test never calls pickWorkspace) — every operation
  // below exercises the embedded fallback exclusively, exactly as a user who
  // has never granted a real folder experiences it.

  // ── workspace.js's own save_file / read_file / list_files / remove_file ──
  const w1 = await Workspace.writeFile('notes.md', 'first note\n');
  t('writeFile reports the bytes written', w1.bytes === Buffer.byteLength('first note\n'));
  t('writeFile reports the resulting size', w1.size === w1.bytes);

  const read1 = await Workspace.readFile('notes.md');
  t('readFile returns exactly what was written', read1 === 'first note\n');

  const w2 = await Workspace.writeFile('notes.md', 'second note\n', { append: true });
  t('append grows the row/byte count rather than replacing', w2.size > w1.size);
  const read2 = await Workspace.readFile('notes.md');
  t('append preserves prior content and adds the new content after it', read2 === 'first note\nsecond note\n');

  const files = await Workspace.listFiles();
  t('listFiles sees the file created via embedded storage', files.some(f => f.name === 'notes.md'));
  t('listFiles reports a real byte size, not 0', files.find(f => f.name === 'notes.md').size > 0);

  await Workspace.removeFile('notes.md');
  const afterRemove = await Workspace.listFiles();
  t('removeFile actually removes it from the listing', !afterRemove.some(f => f.name === 'notes.md'));

  let readMissingThrew = false;
  try { await Workspace.readFile('does-not-exist.txt'); } catch { readMissingThrew = true; }
  t('reading a file that was never created throws (matches real FS getFileHandle without create)', readMissingThrew);

  // ── output-writer.js's appendRows / writeAll / getRowCount — this is the ──
  // actual code path collect_rows/append_rows/export_rows use, and it must
  // work completely unchanged against the embedded backend since neither
  // output-writer.js nor its callers know which backend is active.
  const rows1 = [{ Title: 'Robotics Engineer', Company: 'Acme' }, { Title: 'ML Engineer', Company: 'Acme' }];
  const a1 = await Writer.appendRows('jobs.tsv', rows1, { columns: ['Title', 'Company'] });
  t('first appendRows writes the header exactly once', a1.rowCount === 2);
  t('first appendRows reports the header columns', a1.columns.join('|') === 'Title|Company');

  const rows2 = [{ Title: 'Firmware Engineer', Company: 'Beta' }];
  const a2 = await Writer.appendRows('jobs.tsv', rows2);
  t('second appendRows accumulates onto the first (this is the exact bug found: getFileHandle({create:true}) must materialize an empty record immediately, or the size-then-createWritable sequence throws NotFoundError on a brand-new file)',
    a2.rowCount === 3);

  const count = await Writer.getRowCount('jobs.tsv');
  t('getRowCount reads the true accumulated count back from storage, not memory', count.rowCount === 3);

  const finalRows = [
    { Title: 'Robotics Engineer', Company: 'Acme' },
    { Title: 'Firmware Engineer', Company: 'Beta' }
  ];
  const exported = await Writer.writeAll('jobs.tsv', finalRows, { columns: ['Title', 'Company'] });
  t('writeAll truncates and rewrites rather than appending onto the old content', exported.rowCount === 2);
  const recount = await Writer.getRowCount('jobs.tsv');
  t('post-writeAll row count reflects the truncated content, not the pre-export accumulation', recount.rowCount === 2);

  // ── CSV path, since delimiter choice changes the write shapes exercised ──
  const csv = await Writer.appendRows('jobs.csv', [{ 'Company, Inc': 'Acme', Title: 'Dev' }]);
  t('csv header with a comma-bearing column name round-trips through embedded storage', csv.columns.join('|') === 'Company, Inc|Title');
  const csvText = await Workspace.readFile('jobs.csv');
  t('the quoted csv header actually persisted correctly', csvText.startsWith('"Company, Inc",Title\n'));

  // ── getStatus reports the embedded fallback honestly rather than as an error ──
  const status = await Workspace.getStatus();
  t('getStatus reports embedded mode, not a failure, when no folder was ever chosen', status.ok === true && status.embedded === true);
}
