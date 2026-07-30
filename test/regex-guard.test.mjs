// compileGuardedRegex stands between model/plan-authored regex patterns and
// `new RegExp` + `.test()` against page-derived strings — a synchronous call
// V8 cannot interrupt once a catastrophic pattern starts backtracking.
// Every "must reject" assertion here is paired with a wall-clock bound so a
// regression (the gate silently stops working) fails FAST instead of
// hanging the whole test suite the way the original bug would have.
const B = new URL('../src/', import.meta.url).href;
const { compileGuardedRegex } = await import(B + 'lib/regex-guard.js');
const { STOP_PATTERNS } = await import(B + 'lib/plan.js');

function within(ms, fn) {
  const t0 = Date.now();
  const result = fn();
  return { result, elapsed: Date.now() - t0, ok: Date.now() - t0 < ms };
}

export default function run(t) {
  // ── the actual bug: nested-quantifier patterns must be rejected, not run ──
  const catastrophic = ['(a+)+$', '(a*)*', '(a+)*b', '([a-zA-Z]+)*$'];
  for (const pat of catastrophic) {
    const { result, ok } = within(200, () => compileGuardedRegex(pat));
    t(`catastrophic pattern rejected fast: ${pat}`, ok && result.ok === false);
    t(`rejection reason mentions repetition: ${pat}`, ok && /repetition|backtrack/i.test(result.reason || ''));
  }

  // ── legitimate patterns must still compile, INCLUDING this project's own ──
  // built-in stop patterns — a gate that breaks a shipped feature to fix a
  // risk that pattern doesn't pose would be a worse trade than the bug.
  t('plain alternation passes', compileGuardedRegex('Dublin|Cork|Galway').ok === true);
  t('word-boundary rule passes', compileGuardedRegex('\\bSenior\\b|\\bSr\\.').ok === true);
  t('STOP_PATTERNS.older_than_1_week passes', compileGuardedRegex(STOP_PATTERNS.older_than_1_week).ok === true);
  t('STOP_PATTERNS.older_than_1_month passes', compileGuardedRegex(STOP_PATTERNS.older_than_1_month).ok === true);
  t('a passing pattern actually matches', compileGuardedRegex('Dublin').re.test('Dublin, Ireland'));

  // ── degenerate input ──
  t('empty pattern rejected', compileGuardedRegex('').ok === false);
  t('null pattern rejected', compileGuardedRegex(null).ok === false);
  t('invalid regex syntax rejected, not thrown', compileGuardedRegex('(').ok === false);
  t('oversized pattern rejected', compileGuardedRegex('a'.repeat(501)).ok === false);
  t('oversize reason mentions length', /\d+ chars/.test(compileGuardedRegex('a'.repeat(501)).reason));
  t('never throws on garbage input', (() => {
    try { compileGuardedRegex(Symbol('x')); return true; } catch { return false; }
  })());

  // ── KNOWN GAP, tested so it stays a documented gap and not a surprise:  ──
  // alternation-based blowup is NOT caught by this gate (see regex-guard.js).
  // This assertion exists so that if a future safe-regex upgrade starts
  // catching it, this test is what tells us to tighten the docs — not so
  // anyone relies on the current (permissive) behavior.
  t('alternation-based ReDoS is a documented gap, not a silent regression',
    compileGuardedRegex('(a|a)*$').ok === true);
}
