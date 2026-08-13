// The allowlist is the security boundary for every page-changing tool, and it
// used to fail OPEN by default. These assertions exist to make sure it can never
// silently go back to that.
const B = new URL('../src/', import.meta.url).href;
const { decideAccess, parseAllowedSites, normalizeHostPattern, blockedMessage } = await import(B + 'lib/allowlist.js');

export default function run(t) {
  // ── THE regression: empty list must deny, not allow ──
  const empty = decideAccess('https://example.com/x', [], false);
  t('empty allowlist DENIES', empty.ok === false);
  t('empty allowlist says so explicitly', empty.empty === true);
  t('empty allowlist still reports the host', empty.host === 'example.com');

  // ── explicit opt-out ──
  t('allowAll permits an unlisted host', decideAccess('https://anything.test/', [], true).ok === true);
  t('allowAll permits even a bad host', decideAccess('https://x.test/', ['other.com'], true).ok === true);

  // ── matching ──
  t('exact host matches', decideAccess('https://acme.com/a', ['acme.com'], false).ok === true);
  t('subdomain matches parent', decideAccess('https://jobs.acme.com/a', ['acme.com'], false).ok === true);
  t('deep subdomain matches parent', decideAccess('https://a.b.acme.com/', ['acme.com'], false).ok === true);
  t('unrelated host denied', decideAccess('https://evil.com/', ['acme.com'], false).ok === false);
  // Suffix matching must not be a substring match: notacme.com is NOT acme.com.
  t('suffix confusion rejected', decideAccess('https://notacme.com/', ['acme.com'], false).ok === false);
  t('parent does not match a listed subdomain', decideAccess('https://acme.com/', ['jobs.acme.com'], false).ok === false);
  t('case-insensitive host match', decideAccess('https://ACME.com/', ['acme.com'], false).ok === true);
  t('port is ignored when matching', decideAccess('https://acme.com:8443/x', ['acme.com'], false).ok === true);
  t('one of several entries matches', decideAccess('https://b.com/', ['a.com', 'b.com', 'c.com'], false).ok === true);

  // ── schemes: model-authored URLs must not reach privileged pages ──
  t('http allowed', decideAccess('http://acme.com/', ['acme.com'], false).ok === true);
  t('chrome:// denied even if listed', decideAccess('chrome://settings', ['settings'], false).ok === false);
  t('file:// denied', decideAccess('file:///C:/secrets.txt', [''], false).ok === false);
  t('javascript: denied', decideAccess('javascript:alert(1)', [], false).ok === false);
  t('data: denied', decideAccess('data:text/html,<h1>x', [], false).ok === false);
  t('chrome-extension:// denied', decideAccess('chrome-extension://abc/page.html', [], false).ok === false);
  t('scheme rejection names the scheme', /unsupported scheme/.test(decideAccess('file:///x', [], false).reason));
  // allowAll is an explicit user choice about SITES; it must not unlock schemes
  // the extension has no business driving. (This assertion caught a real hole:
  // the allowAll shortcut originally ran BEFORE the scheme check.)
  t('allowAll does NOT unlock chrome://', decideAccess('chrome://settings', [], true).ok === false);
  t('allowAll does NOT unlock file://', decideAccess('file:///C:/x', [], true).ok === false);
  t('allowAll does NOT unlock javascript:', decideAccess('javascript:alert(1)', [], true).ok === false);
  t('allowAll still permits normal https', decideAccess('https://anything.test/', [], true).ok === true);

  // ── malformed input ──
  t('garbage URL denied', decideAccess('not a url', ['acme.com'], false).ok === false);
  t('empty URL denied', decideAccess('', ['acme.com'], false).ok === false);
  t('null URL denied', decideAccess(null, ['acme.com'], false).ok === false);
  t('unparseable URL has null host', decideAccess('???', [], false).host === null);

  // ── pattern normalization ──
  t('scheme stripped', normalizeHostPattern('https://acme.com') === 'acme.com');
  t('leading wildcard stripped', normalizeHostPattern('*.acme.com') === 'acme.com');
  t('path stripped', normalizeHostPattern('acme.com/jobs/x') === 'acme.com');
  t('query string stripped', normalizeHostPattern('acme.com?utm_source=x') === 'acme.com');
  t('fragment stripped', normalizeHostPattern('acme.com#section') === 'acme.com');
  t('query after path stripped', normalizeHostPattern('acme.com/jobs?page=2') === 'acme.com');
  t('port stripped', normalizeHostPattern('acme.com:8080') === 'acme.com');
  t('case lowered', normalizeHostPattern('ACME.com') === 'acme.com');
  t('whitespace trimmed', normalizeHostPattern('  acme.com  ') === 'acme.com');
  t('empty stays empty', normalizeHostPattern('') === '');
  t('null tolerated', normalizeHostPattern(null) === '');
  // www. is the same site: granting one form must cover both directions. The
  // normalization happens at storage time (parseAllowedSites/grantHost), so the
  // decision layer sees the normalized bare form either way.
  t('www prefix stripped', normalizeHostPattern('www.acme.com') === 'acme.com');
  t('granting bare domain covers www host', decideAccess('https://www.acme.com/', ['acme.com'], false).ok === true);
  t('www parse collapses to bare form', parseAllowedSites('www.acme.com')[0] === 'acme.com');
  t('stored www-form list covers bare host', decideAccess('https://acme.com/', parseAllowedSites('www.acme.com'), false).ok === true);

  // ── list parsing ──
  t('newline separated', parseAllowedSites('a.com\nb.com').length === 2);
  t('comma separated', parseAllowedSites('a.com, b.com').length === 2);
  t('mixed separators', parseAllowedSites('a.com,\n b.com\tc.com').length === 3);
  t('blank lines dropped', parseAllowedSites('a.com\n\n\nb.com').length === 2);
  t('duplicates collapsed', parseAllowedSites('a.com\nA.COM\nhttps://a.com').length === 1);
  t('empty input yields empty list', parseAllowedSites('').length === 0);
  t('null input yields empty list', parseAllowedSites(null).length === 0);
  t('parsed entries are normalized', parseAllowedSites('https://*.Acme.com/jobs')[0] === 'acme.com');

  // ── refusal message has to be actionable, not just negative ──
  const msg = blockedMessage(decideAccess('https://acme.com/', [], false), 'left_click');
  t('refusal names the tool', /left_click/.test(msg));
  t('refusal names the affordance', /Allow/.test(msg));
  t('refusal says reads still work', /read/i.test(msg));
  t('refusal for unlisted host names the host', /acme\.com/.test(blockedMessage(decideAccess('https://acme.com/', ['x.com'], false), 'type')));
}
