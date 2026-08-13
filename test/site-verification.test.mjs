// Template verification: the probe verdict and the stored-over-shipped merge.
// Both are pure; the point is that "this template works" is an empirical claim
// that must be judged on evidence, not on a checked-in boolean.
const B = new URL('../src/', import.meta.url).href;
const { judgeProbe, mergeConfigs, MIN_REAL_TEXT } = await import(B + 'lib/site-verification.js');

export default function run(t) {
  const good = {
    requestedUrl: 'https://jobs.test/search?q=robotics&page=1',
    finalUrl: 'https://jobs.test/search?q=robotics&page=1',
    title: 'Robotics jobs — JobsTest',
    textLen: 9000
  };

  t('a real results page passes', judgeProbe(good).ok === true);
  t('clean pass has no notes', judgeProbe(good).verdict === 'ok');

  // The single most common failure: HTTP 200 with an empty SPA shell.
  const shell = { ...good, textLen: 120 };
  t('empty JS shell rejected', judgeProbe(shell).ok === false);
  t('shell rejection explains itself', /shell|chars/.test(judgeProbe(shell).reasons.join(' ')));
  t('threshold boundary rejects just under', judgeProbe({ ...good, textLen: MIN_REAL_TEXT - 1 }).ok === false);
  t('threshold boundary accepts at the limit', judgeProbe({ ...good, textLen: MIN_REAL_TEXT }).ok === true);

  // 404s that return 200 with an error title.
  t('404 title rejected', judgeProbe({ ...good, title: '404 Page Not Found' }).ok === false);
  t('"not found" title rejected', judgeProbe({ ...good, title: 'Not Found' }).ok === false);
  t('normal title with the word found is fine', judgeProbe({ ...good, title: 'We found 200 jobs' }).ok === true);

  // A dropped query string is the silent killer: every "page 2" returns page 1.
  const dropped = { ...good, finalUrl: 'https://jobs.test/search' };
  t('dropped query string rejected', dropped && judgeProbe(dropped).ok === false);
  t('dropped query explains pagination risk', /pagination/.test(judgeProbe(dropped).reasons.join(' ')));

  t('cross-origin redirect rejected',
    judgeProbe({ ...good, finalUrl: 'https://other.test/search?q=robotics' }).ok === false);
  const sameSite = { ...good, finalUrl: 'https://jobs.test/search?q=robotics&page=1&ref=x' };
  t('same-origin redirect is a note, not a failure', judgeProbe(sameSite).ok === true);
  t('same-origin redirect is recorded', judgeProbe(sameSite).verdict === 'ok-with-notes');
  // Regression: an http→https upgrade has the SAME host, and used to be
  // flagged as a fatal cross-origin redirect because `origin` includes the
  // scheme. Perfectly good templates were pushed into "rejected" over it.
  t('http to https upgrade is not a failure', judgeProbe({ ...good, requestedUrl: 'http://jobs.test/search?q=robotics', finalUrl: 'https://jobs.test/search?q=robotics' }).ok === true);
  t('same-host different-subdomain is not cross-site', judgeProbe({ ...good, finalUrl: 'https://www.jobs.test/search?q=robotics' }).ok === true);

  t('never loaded is unreachable', judgeProbe({ ...good, finalUrl: '' }).verdict === 'unreachable');
  t('unreachable is not ok', judgeProbe({ ...good, finalUrl: '' }).ok === false);

  // "It loaded" is not "it lists results".
  t('zero extracted rows rejects the template', judgeProbe({ ...good, rowsFound: 0 }).ok === false);
  t('nonzero rows still passes', judgeProbe({ ...good, rowsFound: 25 }).ok === true);
  t('null rows is neutral', judgeProbe({ ...good, rowsFound: null }).ok === true);

  t('malformed urls do not throw', (() => {
    try { judgeProbe({ requestedUrl: '???', finalUrl: '!!!', textLen: 9000 }); return true; } catch { return false; }
  })());

  // ── merge precedence ──
  const shipped = [
    { site: 'a.com', name: 'A', url_template: 'https://a.com/s?q={keyword}', verified: false, note: 'shipped note' },
    { site: 'b.com', name: 'B', url_template: null, verified: false }
  ];
  let m = mergeConfigs(shipped, {});
  t('no stored state leaves configs untouched', m[0].verified === false && m[0].url_template === shipped[0].url_template);
  t('merge preserves array length', m.length === 2);

  m = mergeConfigs(shipped, { 'a.com': { verified: true, verifiedAt: 1000 } });
  t('stored verification wins', m[0].verified === true);
  t('verifiedAt carried through', m[0].verifiedAt === 1000);
  t('shipped template kept when none stored', m[0].url_template === 'https://a.com/s?q={keyword}');
  t('other sites unaffected', m[1].verified === false);

  // A stored template must be able to REPLACE a rotted or null shipped one —
  // that is the whole point of storing it.
  m = mergeConfigs(shipped, { 'b.com': { verified: true, url_template: 'https://b.com/jobs?k={keyword}' } });
  t('stored template fills a null shipped template', m[1].url_template === 'https://b.com/jobs?k={keyword}');
  t('site marked verified once its template is known', m[1].verified === true);

  m = mergeConfigs(shipped, { 'a.com': { verified: false, note: 'template 404s now' } });
  t('stored broken state overrides too', m[0].verified === false);
  t('broken note surfaced separately from the shipped note', m[0].verificationNote === 'template 404s now' && m[0].note === 'shipped note');
  t('unknown stored site does not inject a config', mergeConfigs(shipped, { 'zz.com': { verified: true } }).length === 2);
}
