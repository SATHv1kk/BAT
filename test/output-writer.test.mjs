// output-writer had ZERO automated coverage — the README substituted a manual
// four-step procedure for it. These are the parts that silently corrupt data
// when wrong: cell sanitization, CSV quoting, header parsing, and the append
// position/row-count math.
const B = new URL('../src/', import.meta.url).href;
const {
  delimiterFor, sanitizeCell, formatRow, splitHeader, parseFileState, buildAppendChunk
} = await import(B + 'lib/output-writer.js');

export default function run(t) {
  const TAB = '\t';
  const CSV = ',';

  // ── delimiter selection ──
  t('explicit csv wins', delimiterFor('x.tsv', 'csv') === CSV);
  t('explicit tsv wins', delimiterFor('x.csv', 'tsv') === TAB);
  t('.csv infers comma', delimiterFor('jobs.csv') === CSV);
  t('.CSV infers comma (case-insensitive)', delimiterFor('jobs.CSV') === CSV);
  t('.tsv infers tab', delimiterFor('jobs.tsv') === TAB);
  t('unknown extension defaults to tab', delimiterFor('jobs.txt') === TAB);

  // ── cell sanitization: one bad value must never break column alignment ──
  t('tabs stripped from tsv cell', !sanitizeCell('a\tb', TAB).includes(TAB));
  t('newlines stripped', !/[\r\n]/.test(sanitizeCell('a\nb\r\nc', TAB)));
  t('whitespace collapsed and trimmed', sanitizeCell('  a   b  ', TAB) === 'a b');
  t('null becomes empty', sanitizeCell(null, TAB) === '');
  t('undefined becomes empty', sanitizeCell(undefined, TAB) === '');
  t('zero is preserved not blanked', sanitizeCell(0, TAB) === '0');
  t('false is preserved', sanitizeCell(false, TAB) === 'false');
  t('csv quotes a comma', sanitizeCell('Acme, Inc', CSV) === '"Acme, Inc"');
  t('csv doubles embedded quotes', sanitizeCell('say "hi"', CSV) === '"say ""hi"""');
  t('csv leaves plain text unquoted', sanitizeCell('plain', CSV) === 'plain');
  t('tsv does NOT quote commas', sanitizeCell('Acme, Inc', TAB) === 'Acme, Inc');
  t('tsv leaves quotes alone', sanitizeCell('say "hi"', TAB) === 'say "hi"');
  t('newline inside csv cell cannot split the row', sanitizeCell('a\nb', CSV).split('\n').length === 1);

  // ── row formatting ──
  t('missing key becomes empty cell', formatRow({ a: '1' }, ['a', 'b'], TAB) === '1\t');
  t('column order is respected', formatRow({ b: '2', a: '1' }, ['a', 'b'], TAB) === '1\t2');
  t('extra keys are not emitted', formatRow({ a: '1', z: '9' }, ['a'], TAB) === '1');
  t('cell count always equals column count',
    formatRow({ a: 'x\ty', b: 'p,q' }, ['a', 'b'], TAB).split(TAB).length === 2);

  // ── header parsing ──
  t('tsv header splits on tab', splitHeader('a\tb\tc', TAB).join('|') === 'a|b|c');
  t('csv header splits on comma', splitHeader('a,b,c', CSV).join('|') === 'a|b|c');
  // Regression: sanitizeCell quotes a column name containing a comma, so a naive
  // split saw three columns where two were written and every later append
  // misaligned.
  t('csv header respects quoted comma', splitHeader('"Company, Inc",Title', CSV).join('|') === 'Company, Inc|Title');
  t('csv header unescapes doubled quotes', splitHeader('"say ""hi""",Title', CSV).join('|') === 'say "hi"|Title');
  t('csv header handles trailing empty field', splitHeader('a,b,', CSV).length === 3);
  t('single-column header', splitHeader('only', CSV).join('|') === 'only');

  // ── file state ──
  let st = parseFileState('', 0, TAB);
  t('empty file has no header', st.header === null && st.rowCount === 0);
  t('empty file counts as newline-terminated', st.endsWithNewline === true);
  st = parseFileState('a\tb\n1\t2\n', 8, TAB);
  t('header parsed from first line', st.header.join('|') === 'a|b');
  t('data rows counted excluding header', st.rowCount === 1);
  t('trailing newline detected', st.endsWithNewline === true);
  st = parseFileState('a\tb\n1\t2', 7, TAB);
  t('missing trailing newline detected', st.endsWithNewline === false);
  st = parseFileState('a\tb\n\n\n1\t2\n', 10, TAB);
  t('blank lines ignored in the row count', st.rowCount === 1);
  t('size is carried through verbatim', parseFileState('x', 123, TAB).size === 123);

  // ── append math: the header must be written EXACTLY once ──
  const fresh = parseFileState('', 0, TAB);
  let out = buildAppendChunk(fresh, [{ a: '1', b: '2' }], { delimiter: TAB });
  t('new file gets a header', out.chunk === 'a\tb\n1\t2\n');
  t('new file row count starts at 1', out.rowCount === 1);
  t('new file column order from first row', out.cols.join('|') === 'a|b');

  out = buildAppendChunk(fresh, [{ b: '2', a: '1' }], { delimiter: TAB, columns: ['a', 'b'] });
  t('explicit columns override row key order', out.chunk === 'a\tb\n1\t2\n');

  const existing = parseFileState('a\tb\n1\t2\n', 8, TAB);
  out = buildAppendChunk(existing, [{ a: '3', b: '4' }], { delimiter: TAB });
  t('existing file gets NO second header', out.chunk === '3\t4\n');
  t('row count accumulates', out.rowCount === 2);

  // An existing header wins over caller-supplied columns, or the file would gain
  // a second column order halfway through.
  out = buildAppendChunk(existing, [{ a: '3', b: '4' }], { delimiter: TAB, columns: ['b', 'a'] });
  t('existing header beats requested columns', out.cols.join('|') === 'a|b' && out.chunk === '3\t4\n');

  const noNewline = parseFileState('a\tb\n1\t2', 7, TAB);
  out = buildAppendChunk(noNewline, [{ a: '3', b: '4' }], { delimiter: TAB });
  t('missing trailing newline is repaired before appending', out.chunk === '\n3\t4\n');

  out = buildAppendChunk(existing, [{ a: '3', b: '4', extra: 'x' }], { delimiter: TAB });
  t('keys outside the header are reported as dropped', out.droppedKeys.join('|') === 'extra');
  t('dropped keys do not widen the row', out.chunk.trim().split(TAB).length === 2);
  out = buildAppendChunk(existing, [{ a: '3', b: '4' }], { delimiter: TAB });
  t('no dropped keys when rows match the header', out.droppedKeys.length === 0);

  out = buildAppendChunk(existing, [{ a: '5', b: '6' }, { a: '7', b: '8' }], { delimiter: TAB });
  t('multi-row append is newline separated', out.chunk === '5\t6\n7\t8\n');
  // `existing` holds 1 data row and buildAppendChunk is pure, so 1 + 2 = 3.
  t('multi-row append advances the count by 2', out.rowCount === 3);
  t('every appended chunk ends with a newline', out.chunk.endsWith('\n'));

  // CSV end-to-end through the pure core.
  const csvFresh = parseFileState('', 0, CSV);
  out = buildAppendChunk(csvFresh, [{ 'Company, Inc': 'Acme', Title: 'Dev' }], { delimiter: CSV });
  t('csv header quotes a comma-bearing column name', out.chunk.startsWith('"Company, Inc",Title\n'));
  const reparsed = parseFileState(out.chunk, out.chunk.length, CSV);
  t('written csv header round-trips', reparsed.header.join('|') === 'Company, Inc|Title');
  t('csv round-trip preserves the row count', reparsed.rowCount === 1);
}
