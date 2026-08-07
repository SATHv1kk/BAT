// Element locator — generates searchable identifiers from tree-registry
// entries so the model can find elements by label when refs go stale.
//
// HARPA's `locatorAi` (audit item #4) generates 10+ fallback selectors per
// element. This is the BAT-sized version: from a registry entry (which already
// has label, role, tag, frameId), mint stable identifiers that find() and
// click resolution use as fallbacks. No extra page round-trips needed.

// Best-effort label normalization: lower, collapse whitespace, strip punctuation
// that doesn't carry meaning ("Men's" → "mens").
export function normalizeLabel(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[''']/g, '\'')
    .replace(/[""″]/g, '"')
    .replace(/[-–—]/g, ' ')
    .trim();
}

// How well two labels match. 1.0 = identical after normalization.
export function labelSimilarity(a, b) {
  const na = normalizeLabel(a);
  const nb = normalizeLabel(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1.0;
  // "Levi's Men's Trucker Jacket" ≈ "mens trucker jacket"
  if (na.includes(nb)) return nb.length / na.length;
  if (nb.includes(na)) return na.length / nb.length;
  // Word-level Jaccard
  const wa = new Set(na.split(' ').filter(w => w.length > 1));
  const wb = new Set(nb.split(' ').filter(w => w.length > 1));
  if (!wa.size || !wb.size) return 0;
  let intersection = 0;
  for (const w of wa) { if (wb.has(w)) intersection++; }
  return intersection / Math.max(wa.size, wb.size);
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
