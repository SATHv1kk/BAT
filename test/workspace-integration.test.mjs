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

  let readMissingErr = null;
  try { await Workspace.readFile('does-not-exist.txt'); } catch (e) { readMissingErr = e; }
  t('reading a file that was never created throws (matches real FS getFileHandle without create)', !!readMissingErr);
  // Regression: a raw NotFoundError surfaced to the caller as a bare
  // "Workspace error", indistinguishable from a folder whose permission had
  // lapsed — so a simple typo was answered by reconnecting a folder that had
  // never disconnected, repeatedly, for several turns.
  t('a missing file is flagged as a missing FILE, not a workspace failure',
    readMissingErr?.fileNotFound === true && !readMissingErr?.workspaceDisconnected);
  t('the missing-file error says the location itself is fine',
    /not a disconnected folder/i.test(readMissingErr?.message || ''));

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

  // ── getStatus reports the embedded default honestly rather than as an error ──
  const status = await Workspace.getStatus();
  t('getStatus reports embedded mode, not a failure, when no folder was ever chosen', status.ok === true && status.embedded === true);
  t('embedded storage is reported as a pinned-nothing default, not a pinned folder', status.pinned === false);
  t('the embedded default never asks to be reconnected', status.needsReconnect === false);

  // ── A PINNED folder is the fixed location: it is used, or the operation ──
  // fails naming it. What it must never do is quietly redirect the write to
  // embedded storage, which is what the old fallback did — that is how half a
  // collection ended up in a folder and half inside the extension, with nothing
  // but a settings line to say so.
  //
  // Pinning is simulated by writing a handle into the same IndexedDB record
  // pickWorkspace writes, since showDirectoryPicker cannot run in Node.
  // _setHandleForTest uses workspace.js's own cached connection so we never
  // open a second one against the same DB (which fake-indexeddb blocks on).

  await Workspace._setHandleForTest({
    kind: 'directory',
    name: 'pinned-workspace',
    queryPermission: async () => 'prompt',
    requestPermission: async () => 'prompt'
  });

  const disconnected = await Workspace.getStatus();
  t('a pinned but unpermitted folder is reported as needing reconnection', disconnected.needsReconnect === true);
  t('a disconnected folder is NOT reported as ok', disconnected.ok === false);
  t('the disconnected status names the folder so the user knows which one', disconnected.location === 'pinned-workspace');

  let writeErr = null;
  try { await Workspace.writeFile('should-not-exist.txt', 'x'); } catch (e) { writeErr = e; }
  t('writing with a disconnected pinned folder throws instead of silently redirecting', !!writeErr);
  t('the throw is flagged as a disconnection, not a generic failure', writeErr?.workspaceDisconnected === true);
  t('the error names the folder that is disconnected', /pinned-workspace/.test(writeErr?.message || ''));

  // The two reasons a pinned folder can be unwritable are NOT the same problem,
  // and merging them is what made a healthy folder look like it "kept
  // disconnecting": the background service worker can never hold a folder grant
  // (Chrome binds it to the panel document), so every runner write reported a
  // lapsed permission and asked for a reconnect that could not possibly help.
  // Outside a worker — here, and in the panel — it IS a real lapsed grant.
  t('outside a service worker, a context CAN hold a folder grant', Workspace.canHoldFsaGrant() === true);
  t('a lapsed grant in a grant-capable context is not blamed on the context',
    writeErr?.contextCannotHoldGrant === false);
  t('a pinned folder is reported as pinned without touching permissions',
    (await Workspace.isFolderPinned()) === true);

  let appendErr = null;
  try { await Writer.appendRows('jobs.tsv', [{ Title: 'X', Company: 'Y' }]); } catch (e) { appendErr = e; }
  t('appendRows refuses too, rather than writing rows to the other location', appendErr?.workspaceDisconnected === true);

  await Workspace.useEmbeddedStorage();
  const backToEmbedded = await Workspace.getStatus();
  t('useEmbeddedStorage un-pins the folder', backToEmbedded.pinned === false && backToEmbedded.ok === true);
  t('nothing is pinned after switching to embedded storage', (await Workspace.isFolderPinned()) === false);

  // The refused attempts must not have leaked into embedded storage.
  const after = await Workspace.listFiles();
  t('nothing was written to embedded storage while the folder was disconnected', !after.some(f => f.name === 'should-not-exist.txt'));
  const jobsAfter = await Writer.getRowCount('jobs.tsv');
  t('the refused append did not reach the embedded copy of the file', jobsAfter.rowCount === 2);

  // ── A pinned AND granted folder is written to directly, with no detour ──
  // and lands in the folder's data/ subfolder (getActiveDir resolves it lazily).
  const written = [];
  const grantedDataHandle = {
    kind: 'directory',
    name: 'data',
    async getFileHandle(name) {
      return {
        kind: 'file',
        name,
        async getFile() { return { size: 0, lastModified: 0, async text() { return ''; } }; },
        async createWritable() {
          return { async write(d) { written.push([name, d]); }, async close() {} };
        }
      };
    }
  };
  await Workspace._setHandleForTest({
    kind: 'directory',
    name: 'granted-workspace',
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    async getDirectoryHandle(name) {
      if (name !== 'data') throw new Error('unexpected subfolder: ' + name);
      return grantedDataHandle;
    }
  });

  await Workspace.writeFile('pinned.txt', 'hello');
  t('a granted pinned folder receives the write itself', written.some(([n, d]) => n === 'pinned.txt' && d === 'hello'));
  const grantedStatus = await Workspace.getStatus();
  t('a granted pinned folder reports as the fixed location', grantedStatus.ok === true && grantedStatus.location === 'granted-workspace');
  t('a granted pinned folder is not embedded mode', grantedStatus.embedded === false);

  await Workspace.useEmbeddedStorage();
  const embeddedAfterPinnedWrite = await Workspace.listFiles();
  t('the pinned write did not also land in embedded storage', !embeddedAfterPinnedWrite.some(f => f.name === 'pinned.txt'));
}
