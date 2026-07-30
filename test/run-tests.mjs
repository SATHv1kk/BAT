// Test runner.
//
// Split into OFFLINE and LIVE sections on purpose. The suite used to be one
// blob that fetched four real job boards, which meant it could not gate CI —
// so CI ran only `npm run build` and every logic regression merged green.
//   npm test        → offline only, deterministic, gates CI
//   npm run test:live → adds the live ATS checks (needs network)
//   npm run test:all  → both
const LIVE = process.argv.includes('--live') || process.env.BAT_TEST_LIVE === '1';
const ONLY_LIVE = process.argv.includes('--only-live');

const B = new URL('../src/', import.meta.url).href;
const { dedupKeyFor, projectRow } = await import(B + 'lib/state-store.js');
const { patternForUrl, schemaFingerprintOf, validateReplay } = await import(B + 'lib/extractors.js');
const { fillTemplate, applyRules, rowsMatchStop, validatePlan, mergeRules, decideUnitProgress, reconcileCheckpoint } = await import(B + 'lib/plan.js');
const { slugCandidates, nameMatches, fetchBoard, discoverBoard } = await import(B + 'lib/ats-adapters.js');
const { SITE_CONFIGS } = await import(B + 'shared/site-configs.js');

let pass = 0, fail = 0;
const failures = [];
const t = (n, c) => { c ? pass++ : (fail++, failures.push(n), console.log('  FAIL:', n)); };

if (!ONLY_LIVE) {
  console.log('Phase 2 — dedup store');
  t('near-dup collides', dedupKeyFor({ c: 'ACME Corp.', t: 'Robotics engineer!' }, ['c', 't']) === dedupKeyFor({ c: 'acme corp', t: 'robotics   Engineer' }, ['c', 't']));
  t('distinct stays distinct', dedupKeyFor({ c: 'A', t: 'X' }, ['c', 't']) !== dedupKeyFor({ c: 'A', t: 'Y' }, ['c', 't']));
  t('unicode/punct stripped', dedupKeyFor({ t: 'Sr. Engineer — Vision (m/f/d)' }, ['t']) === 'sr engineer vision mfd');
  t('sources merged into cell', projectRow({ data: { title: 'X', source: 'A' }, sources: ['A', 'B'] }).source === 'A; B');
  // Regression: stripping ALL punctuation silently merged distinct tech roles,
  // and the loser was discarded because first-row-wins.
  t('C++ does not collide with C', dedupKeyFor({ t: 'C++ Developer' }, ['t']) !== dedupKeyFor({ t: 'C Developer' }, ['t']));
  t('C# does not collide with C', dedupKeyFor({ t: 'C# Developer' }, ['t']) !== dedupKeyFor({ t: 'C Developer' }, ['t']));
  t('C++ does not collide with C#', dedupKeyFor({ t: 'C++ Dev' }, ['t']) !== dedupKeyFor({ t: 'C# Dev' }, ['t']));
  t('Node.js does not collide with Nodejs neighbour', dedupKeyFor({ t: 'Node.js Engineer' }, ['t']) !== dedupKeyFor({ t: 'Node Engineer' }, ['t']));
  t('.NET does not collide with NET', dedupKeyFor({ t: '.NET Developer' }, ['t']) !== dedupKeyFor({ t: 'NET Developer' }, ['t']));
  t('abbreviating dot still erased', dedupKeyFor({ t: 'Sr. Engineer' }, ['t']) === dedupKeyFor({ t: 'Sr Engineer' }, ['t']));
  t('C++ still normalizes case/space', dedupKeyFor({ t: '  c++   DEVELOPER ' }, ['t']) === dedupKeyFor({ t: 'C++ Developer' }, ['t']));
  t('empty field yields empty segment', dedupKeyFor({ a: '', b: 'x' }, ['a', 'b']) === '|x');
  t('missing field does not throw', dedupKeyFor({}, ['nope']) === '');

  console.log('Phase 3 — extractors');
  t('pattern wildcards digits', patternForUrl('https://x.ie/jobs/robotics/page/3?q=1') === 'https://x.ie/jobs/robotics/page/*');
  t('pattern stable across pages', patternForUrl('https://x.ie/j?page=1') === patternForUrl('https://x.ie/j?page=9'));
  t('fingerprint sorted', schemaFingerprintOf([{ b: 1, a: 2 }]) === 'a|b');
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ Title: 'T' + i, URL: 'u' + i, Company: 'C' }));
  const FP = 'Company|Title|URL', req = ['Title', 'URL'];
  t('valid replay', validateReplay({ rows: rows(20), pageTextLen: 5000, cachedFingerprint: FP, recentCounts: [20, 22, 19], requiredFields: req }).verdict === 'valid');
  t('zero rows + content = invalid', validateReplay({ rows: [], pageTextLen: 5000, requiredFields: req }).verdict === 'invalid');
  t('zero rows + empty page = empty', validateReplay({ rows: [], pageTextLen: 100, requiredFields: req }).verdict === 'empty');
  t('schema drift = invalid', validateReplay({ rows: [{ Foo: 'x' }], pageTextLen: 5000, cachedFingerprint: FP, requiredFields: req }).verdict === 'invalid');
  t('empty required = invalid', validateReplay({ rows: rows(10).map((r, i) => i < 6 ? { ...r, Title: '' } : r), pageTextLen: 5000, cachedFingerprint: FP, requiredFields: req }).verdict === 'invalid');
  t('required case-insensitive', validateReplay({ rows: rows(5), pageTextLen: 5000, cachedFingerprint: FP, requiredFields: ['title', 'url'] }).verdict === 'valid');
  const col = validateReplay({ rows: rows(3), pageTextLen: 5000, cachedFingerprint: FP, recentCounts: [25, 30, 28], requiredFields: req });
  t('collapse flagged not fatal', col.verdict === 'valid' && !!col.suspicious);
  t('non-array invalid', validateReplay({ rows: 'nope', pageTextLen: 5000 }).verdict === 'invalid');

  console.log('Phase 4 — plan/runner logic');
  t('template vars+page encoded', fillTemplate('https://x/s?q={keyword}&p={page}', { keyword: 'machine learning' }, 3) === 'https://x/s?q=machine%20learning&p=3');
  const jobRows = [{ Title: 'Senior Robotics Engineer', Posted: '2 days ago' }, { Title: 'Lead Vision Engineer', Posted: '3 days ago' }, { Title: 'Graduate Engineer', Posted: '30+ days ago' }];
  const ruled = applyRules(jobRows, [{ field: 'Title', matches: '\\bSenior\\b|\\bSr\\.', action: 'exclude' }, { field: 'Title', matches: 'Lead|Principal|Staff|Head of', action: 'flag', set: { Flag: '*' } }]);
  t('Senior excluded', ruled.length === 2 && !ruled.some(r => /Senior/.test(r.Title)));
  t('Lead flagged and kept', ruled.find(r => /Lead/.test(r.Title))?.Flag === '*');
  t('others untouched', ruled.find(r => /Graduate/.test(r.Title))?.Flag === undefined);
  t('stop condition fires', rowsMatchStop(jobRows, { field: 'Posted', matches: '30\\+ days' }) === true);
  t('stop condition quiet', rowsMatchStop(jobRows.slice(0, 2), { field: 'Posted', matches: '30\\+ days' }) === false);
  t('bad regex safe', rowsMatchStop(jobRows, { field: 'Posted', matches: '(' }) === false);
  t('plan validates', validatePlan({ filename: 'a.tsv', dedup_fields: ['Company', 'Title'], units: [{ url_template: 'https://x/{page}' }] }) === null);
  t('plan rejects missing units', /units/.test(validatePlan({ filename: 'a.tsv', dedup_fields: ['x'] }) || ''));
  t('unit ids auto-assigned', (() => { const p = { filename: 'a', dedup_fields: ['x'], units: [{ url_template: 'u' }] }; validatePlan(p); return p.units[0].id === 'unit_1'; })());

  console.log('Phase 3 — CDP extractor fallback (expression correctness)');
  const { buildCdpExpression } = await import(B + 'lib/extractor-exec.js');
  // Stub just enough DOM for the injected code to run under Node.
  globalThis.document = { body: { innerText: 'x'.repeat(5000) } };
  const evalExpr = (src) => new Function('return ' + buildCdpExpression(src))();
  let out = evalExpr('return [{Title:"A",URL:"u"},{Title:"B",URL:"v"}];');
  t('cdp expression is valid JS and returns rows', out.ok === true && out.rows.length === 2);
  t('cdp reports page text length', out.pageTextLen === 5000);
  out = evalExpr('return "not an array";');
  t('cdp rejects non-array', out.ok === false && /must return an array/.test(out.error));
  out = evalExpr('throw new Error("boom");');
  t('cdp catches extractor throw', out.ok === false && /boom/.test(out.error));
  out = evalExpr('return [{Title:"A",n:5,bad:{deep:1},ok:true}];');
  t('cdp sanitizes to strings', out.rows[0].n === '5' && out.rows[0].bad === '' && out.rows[0].ok === 'true');
  out = evalExpr('return Array.from({length:5000},function(_,i){return {Title:"T"+i};});');
  t('cdp caps row count', out.rows.length === 2000);
  // Regression: the cap used to be silent, so an incomplete page looked complete.
  t('cdp reports how many rows were dropped', out.truncated === 3000 && out.returned === 5000);
  out = evalExpr('return [{Title:"A"}];');
  t('no truncation reported when under the cap', out.truncated === 0 && out.returned === 1);
  out = evalExpr('return [];');
  t('cdp allows empty result', out.ok === true && out.rows.length === 0);
  // Source containing quotes/newlines/backslashes must survive embedding.
  out = evalExpr('var s = "he said \\"hi\\"\\n";\nreturn [{Title: s}];');
  t('cdp survives tricky source escaping', out.ok === true && /he said/.test(out.rows[0].Title));
  delete globalThis.document;

  console.log('Phase 4 — runner state machine (pure)');
  const U = { pages: { start: 1, step: 1, max: 5 } };
  const at = (page, pageCount) => ({ page, pageCount });
  let s = decideUnitProgress({ outcome: 'ok', stopHit: false, pos: at(1, 0), unit: U, failStreak: 0 });
  t('advances a page', !s.unitDone && s.nextPage === 2 && s.nextPageCount === 1);
  s = decideUnitProgress({ outcome: 'ok', stopHit: true, pos: at(2, 1), unit: U, failStreak: 0 });
  t('stop condition ends unit', s.unitDone && s.reason === 'stop_condition' && !s.blocked);
  s = decideUnitProgress({ outcome: 'ok', stopHit: false, pos: at(5, 4), unit: U, failStreak: 0 });
  t('page budget ends unit', s.unitDone && s.reason === 'page_budget');
  s = decideUnitProgress({ outcome: 'invalid', stopHit: false, pos: at(3, 2), unit: U, failStreak: 0 });
  t('invalid retries same page', !s.unitDone && s.nextPage === 3 && s.nextPageCount === 2);
  t('invalid counts a failure', s.failStreak === 1);
  s = decideUnitProgress({ outcome: 'stalled', stopHit: false, pos: at(2, 1), unit: U, failStreak: 2 });
  t('third failure blocks unit', s.unitDone && s.blocked && s.reason === 'fail_limit');
  s = decideUnitProgress({ outcome: 'empty', stopHit: false, pos: at(2, 1), unit: U, failStreak: 0 });
  t('empty page ends unit cleanly', s.unitDone && !s.blocked && s.reason === 'empty');
  s = decideUnitProgress({ outcome: 'halted', stopHit: false, pos: at(1, 0), unit: U, failStreak: 0 });
  t('halted extractor blocks unit', s.unitDone && s.blocked);
  s = decideUnitProgress({ outcome: 'ok', stopHit: false, pos: at(0, 0), unit: { pages: { start: 0, step: 10, max: 5 } }, failStreak: 0 });
  t('offset pagination steps by 10', s.nextPage === 10);
  s = decideUnitProgress({ outcome: 'ok', stopHit: false, pos: at(1, 0), unit: { pages: { start: 1, step: 1, max: 1 } }, failStreak: 0 });
  t('single-page unit ends after one', s.unitDone && s.reason === 'page_budget');
  s = decideUnitProgress({ outcome: 'ok', stopHit: false, pos: at(3, 2), unit: U, failStreak: 2 });
  t('success resets fail streak', s.failStreak === 0);

  // Regression: the loop must not clobber a pause that landed while it worked.
  const loopRun = { id: 'r1', status: 'running', pos: { unitIndex: 2, page: 4 }, counts: { pages: 9, rows: 40 } };
  let rc = reconcileCheckpoint(loopRun, { ...loopRun, status: 'paused', note: 'user paused' });
  t('external pause survives checkpoint', rc.record.status === 'paused' && rc.stop === true);
  t('pause keeps loop progress', rc.record.pos.page === 4 && rc.record.counts.rows === 40);
  t('pause note preserved', rc.record.note === 'user paused');
  rc = reconcileCheckpoint(loopRun, { ...loopRun, status: 'running' });
  t('normal checkpoint continues', rc.stop === false && rc.record.status === 'running');
  rc = reconcileCheckpoint(loopRun, null);
  t('missing latest is safe', rc.stop === false && rc.record === loopRun);
  rc = reconcileCheckpoint({ ...loopRun, status: 'awaiting_human' }, { ...loopRun, status: 'awaiting_human' });
  t('loop-set status is not external', rc.stop === false);

  t('plan rules always apply', mergeRules([{ field: 'a' }], [{ field: 'b' }]).length === 2);
  t('merge tolerates empties', mergeRules(null, null).length === 0);
  const merged = applyRules(jobRows, mergeRules([{ field: 'Title', matches: 'Senior', action: 'exclude' }], [{ field: 'Title', matches: 'Lead', action: 'flag' }]));
  t('merged rules both take effect', merged.length === 2 && merged.find(r => /Lead/.test(r.Title))?.Flag === '*');

  console.log('Phase 5 — site configs');
  t('configs present', SITE_CONFIGS.length >= 8);
  t('none falsely marked verified', SITE_CONFIGS.every(c => c.verified === false));
  t('broken templates nulled', SITE_CONFIGS.filter(c => /gradireland|jobsireland/.test(c.site)).every(c => c.url_template === null));
  t('risky sites flagged by name', ['linkedin.com', 'ie.indeed.com', 'glassdoor.ie'].every(s2 => SITE_CONFIGS.find(c => c.site === s2)?.account_risk === true));

  console.log('Stop patterns (relative dates)');
  const { STOP_PATTERNS } = await import(B + 'lib/plan.js');
  {
    const wk = new RegExp(STOP_PATTERNS.older_than_1_week, 'i');
    const mustStop = ['8 days ago', '30+ days ago', '2 weeks ago', '1 month ago', 'last month', '1 year ago'];
    const mustKeep = ['just posted', 'today', 'yesterday', '2 hours ago', '1 day ago', '7 days ago', '1 week ago', 'Reposted', 'none'];
    t('week rule stops old postings', mustStop.every(x => wk.test(x)));
    t('week rule keeps fresh postings', mustKeep.every(x => !wk.test(x)));
    const mo = new RegExp(STOP_PATTERNS.older_than_1_month, 'i');
    t('month rule boundary', mo.test('45 days ago') && mo.test('2 months ago') && !mo.test('20 days ago') && !mo.test('1 month ago'));
  }

  // ── Modules that had no coverage at all until now ──
  for (const mod of ['redaction.test.mjs', 'allowlist.test.mjs', 'extractor-screen.test.mjs',
    'output-writer.test.mjs', 'parse.test.mjs', 'site-verification.test.mjs']) {
    const label = mod.replace('.test.mjs', '');
    console.log(`Module — ${label}`);
    const { default: run } = await import(new URL('./' + mod, import.meta.url).href);
    await run(t);
  }
}

if (LIVE || ONLY_LIVE) {
  console.log('Phase 5 — ATS adapters (LIVE — needs network)');
  t('slug strips suffixes', slugCandidates('Ubotica Technologies')[0] === 'ubotica');
  t('slug keeps raw variant', slugCandidates('AMD/Xilinx').includes('amdxilinx'));
  t('name match exact', nameMatches('Nimbus', 'Nimbus'));
  t('name match substring', nameMatches('Stripe Inc', 'Stripe'));
  t('wrong company rejected', !nameMatches('Intel Ireland', 'Blueground'));
  const g = await fetchBoard('greenhouse', 'stripe');
  t('greenhouse live', g.ok && g.count > 0 && !!g.rows[0].Title && !!g.rows[0].URL);
  const l = await fetchBoard('lever', 'highspot');
  t('lever live', l.ok && l.count > 0 && !!l.rows[0].Title);
  const a = await fetchBoard('ashby', 'openai');
  t('ashby live', a.ok && a.count > 0 && !!a.rows[0].Title);
  const w = await fetchBoard('workable', 'blueground');
  t('workable live + name', w.ok && w.count > 0 && w.boardName === 'Blueground');
  t('miss fails soft', !(await fetchBoard('greenhouse', 'no-such-board-xyz123')).ok);
  const d = await discoverBoard('greenhouse', 'Stripe Inc');
  t('discovery name-verified', d.ok && d.slug === 'stripe' && d.confidence === 'name-match');
  const wrong = await discoverBoard('workable', 'Intel Ireland');
  t('wrong-company slug rejected', !wrong.ok && /belongs to/.test(wrong.error));
  const unver = await discoverBoard('ashby', 'ADAPT');
  t('unverifiable flagged not trusted', unver.ok && unver.confidence === 'unverified' && !!unver.warning);
} else if (!ONLY_LIVE) {
  console.log('\n(live ATS checks skipped — run `npm run test:live` to include them)');
  // The pure slug/name helpers need no network, so they still gate CI.
  console.log('Phase 5 — ATS helpers (offline)');
  t('slug strips suffixes', slugCandidates('Ubotica Technologies')[0] === 'ubotica');
  t('slug keeps raw variant', slugCandidates('AMD/Xilinx').includes('amdxilinx'));
  t('slug dedups variants', new Set(slugCandidates('Acme')).size === slugCandidates('Acme').length);
  t('slug ignores tiny fragments', slugCandidates('A').length === 0);
  t('name match exact', nameMatches('Nimbus', 'Nimbus'));
  t('name match substring', nameMatches('Stripe Inc', 'Stripe'));
  t('name match ignores punctuation', nameMatches('Blue-Ground', 'Blueground'));
  t('wrong company rejected', !nameMatches('Intel Ireland', 'Blueground'));
  t('empty board name never matches', !nameMatches('Anything', ''));
}

console.log(`\nTOTAL: ${pass} passed, ${fail} failed`);
if (fail) console.log('Failed:\n  - ' + failures.join('\n  - '));
process.exit(fail ? 1 : 0);
