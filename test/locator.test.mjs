// locator.js resolves a model-supplied label back to a ref when the ref it was
// given went stale — and findBestRef's top hit is handed straight to a CLICK.
// It had no coverage, and three separate bugs were living in it:
//
//   1. The quote/apostrophe character classes had been flattened to ASCII by an
//      encoding round-trip, so `replace(/[''']/g, "'")` replaced an apostrophe
//      with an apostrophe — a no-op. Real pages write "Men's" with U+2019.
//   2. Whitespace was collapsed BEFORE dashes became spaces, so "a — b"
//      normalized to "a   b" and broke the exact/substring comparisons.
//   3. Word tokens shorter than 2 chars were discarded, so "Question 1" and
//      "Question 2" scored a PERFECT 1.0 — findBestRef confidently returned the
//      wrong radio button on exactly the numbered quiz pages this project
//      targets.
//
// The invariant worth defending: a score of 1.0 means "the same element". Only
// genuinely identical labels may reach it.
const B = new URL('../src/', import.meta.url).href;
const { normalizeLabel, labelSimilarity, rankByLabel, findBestRef } = await import(B + 'lib/locator.js');

export default function run(t) {
  const APOS = '’';      // ' curly apostrophe, what real pages emit
  const EMDASH = '—';    // —
  const ENDASH = '–';    // –

  // ── normalizeLabel ──
  t('curly apostrophe stripped', normalizeLabel('Men' + APOS + 's') === 'mens');
  t('curly and ascii apostrophes agree',
    normalizeLabel('Men' + APOS + 's') === normalizeLabel("Men's"));
  t('apostrophe removed, not spaced', normalizeLabel("Men's") === 'mens');
  t('curly double quotes stripped', normalizeLabel('“Sale”') === 'sale');
  t('prime stripped', normalizeLabel('5′ tall') === '5 tall');
  t('em dash becomes one space', normalizeLabel('a ' + EMDASH + ' b') === 'a b');
  t('en dash becomes one space', normalizeLabel('a ' + ENDASH + ' b') === 'a b');
  t('hyphen becomes space', normalizeLabel('e-mail') === 'e mail');
  t('dash with no padding still splits', normalizeLabel('a' + EMDASH + 'b') === 'a b');
  t('case folded', normalizeLabel('SUBMIT') === 'submit');
  t('whitespace collapsed and trimmed', normalizeLabel('  a\n\t b  ') === 'a b');
  t('empty input safe', normalizeLabel('') === '' && normalizeLabel(null) === '' && normalizeLabel(undefined) === '');

  // ── labelSimilarity: the 1.0 contract ──
  t('identical is 1.0', labelSimilarity('Submit', 'Submit') === 1);
  t('identical after normalization is 1.0',
    labelSimilarity('Men' + APOS + 's', 'Mens') === 1);
  t('unrelated is 0', labelSimilarity('Submit', 'Cancel') === 0);
  t('empty scores 0', labelSimilarity('', 'x') === 0 && labelSimilarity('x', '') === 0);

  // The core regression: distinct numbered/lettered options must NOT tie.
  t('Question 1 vs Question 2 is not a perfect match',
    labelSimilarity('Question 1', 'Question 2') < 1);
  t('Option A vs Option B is not a perfect match',
    labelSimilarity('Option A', 'Option B') < 1);
  t('Step 3 vs Step 8 is not a perfect match',
    labelSimilarity('Step 3', 'Step 8') < 1);
  t('the distinguishing digit actually counts',
    labelSimilarity('Question 1', 'Question 2') < 0.5);

  // Substring matches are real signal but must stay below an exact match, and
  // must respect word boundaries: "Question 1" inside "Question 10" is not a
  // 0.9-confidence match, it is a different question.
  t('substring match never reaches 1.0',
    labelSimilarity('mens trucker jacket', "Levi's Men's Trucker Jacket") < 1);
  t('substring match is still strong signal',
    labelSimilarity('mens trucker jacket', "Levi's Men's Trucker Jacket") > 0.5);
  t('Question 1 is not a near-match for Question 10',
    labelSimilarity('Question 1', 'Question 10') < 0.5);
  t('subset of tokens never reaches 1.0',
    labelSimilarity('question', 'question 1') < 1);
  t('similarity is symmetric',
    labelSimilarity('Question 1', 'Question 10') === labelSimilarity('Question 10', 'Question 1'));
  t('score never exceeds 1', ['Submit', 'a b c', 'Question 1', "Men's"].every((s) =>
    labelSimilarity(s, s) === 1 && labelSimilarity(s, s + ' x') <= 1));

  // ── rankByLabel / findBestRef ──
  const quiz = {
    ref_1: { label: 'Question 1', role: 'radio' },
    ref_2: { label: 'Question 2', role: 'radio' },
    ref_3: { label: 'Question 3', role: 'radio' }
  };
  t('exact numbered option wins', findBestRef(quiz, 'Question 2')?.ref === 'ref_2');
  t('each numbered option resolves to itself',
    ['1', '2', '3'].every((n, i) => findBestRef(quiz, 'Question ' + n)?.ref === 'ref_' + (i + 1)));

  const mixed = {
    ref_1: { label: 'Search', role: 'textbox' },
    ref_2: { label: 'Search', role: 'button' },
    ref_3: { label: 'Advanced search options', role: 'link' }
  };
  t('roleHint breaks a label tie',
    findBestRef(mixed, 'Search', { roleHint: 'button' })?.ref === 'ref_2');
  t('roleHint is case-insensitive',
    findBestRef(mixed, 'Search', { roleHint: 'BUTTON' })?.ref === 'ref_2');
  t('ranked results are ordered by score', (() => {
    const r = rankByLabel(mixed, 'Search');
    return r.length > 1 && r[0].score >= r[r.length - 1].score;
  })());
  t('weak matches filtered out', rankByLabel(quiz, 'completely unrelated text').length === 0);
  t('maxResults honoured', rankByLabel(quiz, 'Question', { maxResults: 2 }).length <= 2);
  t('ranked entries carry ref and label', (() => {
    const [top] = rankByLabel(quiz, 'Question 1');
    return top?.ref === 'ref_1' && top?.label === 'Question 1' && typeof top.score === 'number';
  })());

  // Degenerate inputs must not throw — this runs mid-click.
  t('empty registry returns nothing', rankByLabel({}, 'x').length === 0);
  t('null registry safe', rankByLabel(null, 'x').length === 0 && findBestRef(null, 'x') === null);
  t('empty target safe', rankByLabel(quiz, '').length === 0 && findBestRef(quiz, '') === null);
  t('entry with no label does not throw',
    rankByLabel({ ref_9: { role: 'button' } }, 'Submit').length === 0);
  t('no match returns null', findBestRef(quiz, 'zzzzz nothing') === null);
}
