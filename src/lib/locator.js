// Element locator — generates searchable identifiers from tree-registry
// entries so the model can find elements by label when refs go stale.
//
// HARPA's `locatorAi` (audit item #4) generates 10+ fallback selectors per
// element. This is the BAT-sized version: from a registry entry (which already
// has label, role, tag, frameId), mint stable identifiers that find() and
// click resolution use as fallbacks. No extra page round-trips needed.

// Best-effort label normalization: lower, strip punctuation that doesn't carry
// meaning ("Men's" → "mens"), collapse whitespace.
//
// Every character class here is written with \u escapes on purpose. They used to
// contain the literal typographic characters, and an encoding round-trip
// flattened the curly quotes to ASCII — which silently turned both quote
// replaces into no-ops (`replace(/[''']/g, "'")` replaces an apostrophe with an
// apostrophe). Real pages write "Men's" with U+2019, so label matching was
// receiving no normalization at all on exactly the punctuation it was written to
// handle. An escape sequence cannot be mangled by a re-encode.
export function normalizeLabel(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    // Quotes and apostrophes are STRIPPED, not normalized: "Men's" and "Mens"
    // are the same label to a reader and must score as identical. Merely
    // unifying the apostrophe left them as distinct one-word tokens, so a
    // single-word label like "Men's" scored 0 against "Mens" and fell under the
    // 0.2 floor — the relocation simply found nothing.
    .replace(/['\u2018\u2019\u02BC\u2032"\u201C\u201D\u2033]/g, '')
    // Dashes → space BEFORE collapsing whitespace. Collapsing first left
    // "a — b" as "a   b", and those extra spaces broke both the exact-match and
    // the substring comparison, leaving only the word-level fallback working.
    .replace(/[-\u2013\u2014\u2212]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// How well two labels match. 1.0 = identical after normalization.
//
// The 1.0 ceiling is a contract, not a formality: findBestRef hands its top hit
// straight to a click, so a score of 1.0 on labels that are NOT the same element
// is indistinguishable from a correct relocation. Two rules protect that:
// single-character tokens count, and a substring match can never reach 1.0.
export function labelSimilarity(a, b) {
  const na = normalizeLabel(a);
  const nb = normalizeLabel(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1.0;

  // "Levi's Men's Trucker Jacket" ≈ "mens trucker jacket".
  // Capped below 1.0 (0.99) so a containment match can never tie a real exact
  // match, and requiring a word boundary so "Question 1" does not read as a
  // 0.91 match for "Question 10" — a near-certain wrong click on a numbered
  // quiz page, scored as near-certainty.
  const containment = (shortStr, longStr) => {
    const i = longStr.indexOf(shortStr);
    if (i === -1) return 0;
    const before = i === 0 || longStr[i - 1] === ' ';
    const after = i + shortStr.length === longStr.length || longStr[i + shortStr.length] === ' ';
    if (!before || !after) return 0;
    return Math.min(0.99, shortStr.length / longStr.length);
  };
  const contained = na.length < nb.length ? containment(na, nb) : containment(nb, na);
  if (contained) return contained;

  // Word-level Jaccard. Single-character tokens are KEPT: the filter used to be
  // `w.length > 1`, which discarded exactly the character that distinguishes
  // "Question 1" from "Question 2" (and "Option A" from "Option B"), so those
  // pairs scored a perfect 1.0 and findBestRef confidently returned the wrong
  // element. On the quiz/SCORM pages this project targets that is a click on the
  // wrong radio button, reported as a clean hit.
  const tokens = (s) => new Set(s.split(' ').filter(Boolean));
  const wa = tokens(na);
  const wb = tokens(nb);
  if (!wa.size || !wb.size) return 0;
  let intersection = 0;
  for (const w of wa) { if (wb.has(w)) intersection++; }
  // Union, not max(): with max() a label whose tokens are a strict subset of the
  // other's scored 1.0 ("question" vs "question 1" → 1/1), re-creating the same
  // false-certainty through a different route. Jaccard over the union caps
  // every non-identical pair strictly below 1.0.
  const union = new Set([...wa, ...wb]).size;
  return intersection / union;
}

// Given a registry (ref → {label, role, tag, frameId}), return every ref
// ordered by how well its label matches the target text. Only returns refs
// with similarity > 0.2. If roleHint is given (e.g. "button", "link"),
// results matching that role get boosted.
export function rankByLabel(registry, targetText, { roleHint = null, maxResults = 10 } = {}) {
  if (!registry || !targetText) return [];
  const ranked = [];
  for (const [ref, entry] of Object.entries(registry)) {
    const sim = labelSimilarity(entry.label || '', targetText);
    if (sim < 0.2) continue;
    let score = sim;
    if (roleHint && (entry.role || '').toLowerCase() === roleHint.toLowerCase()) score += 0.3;
    ranked.push({ ref, ...entry, score });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, maxResults);
}

// Generate the best matching ref for a model-provided description.
// Falls back through: exact label match → partial label match → role match.
export function findBestRef(registry, targetText, { roleHint = null } = {}) {
  const hits = rankByLabel(registry, targetText, { roleHint, maxResults: 1 });
  return hits.length ? hits[0] : null;
}
