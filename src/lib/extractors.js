// Pure logic for the extract_rows meta-tool: URL patterns, schema
// fingerprints, and replay validation. Orchestration (running code in the
// page, the cache, the file pipeline) lives with the tool handler — everything
// in this file is deliberately testable in plain Node.

// Cache key: origin + path with numeric segments wildcarded, query dropped —
// page 1 and page 7 of the same results list share one extractor.
export function patternForUrl(url) {
  const u = new URL(url);
  const path = u.pathname
    .split('/')
    .map(seg => (/^\d+$/.test(seg) ? '*' : seg))
    .join('/')
    .replace(/\/+$/, '') || '/';
  return u.origin + path;
}

// Sorted key names of the first row — a markup change that renames or drops a
// column shows up here even when the extractor still "works".
export function schemaFingerprintOf(rows) {
  if (!Array.isArray(rows) || !rows.length) return '';
  const keys = new Set();
  for (const row of rows) Object.keys(row).forEach(k => keys.add(k));
  return Array.from(keys).sort().join('|');
}

export const REPLAY_DEFAULTS = {
  requiredFields: ['title', 'url'],
  maxEmptyFraction: 0.34,      // more than this fraction with empty required fields → invalid
  collapseFraction: 0.3,       // count below this × trailing average → suspicious
  minHistoryForCollapse: 3,    // need this many prior counts before collapse checks
  minPageTextForContent: 800   // page text length above this = "visibly has content"
};

function getFieldCaseInsensitive(row, name) {
  if (name in row) return row[name];
  const key = Object.keys(row).find(k => k.toLowerCase() === name.toLowerCase());
  return key !== undefined ? row[key] : undefined;
}

// The validation matrix that keeps a silently-wrong extractor from poisoning
// the output file. Verdicts: 'valid' (optionally with a suspicious flag),
// 'empty' (0 rows on a page that really is empty), 'invalid' (retire it).
export function validateReplay({ rows, pageTextLen = 0, cachedFingerprint = '', recentCounts = [], requiredFields, opts = {} }) {
  const cfg = { ...REPLAY_DEFAULTS, ...opts };
  const required = requiredFields?.length ? requiredFields : cfg.requiredFields;

  if (!Array.isArray(rows)) {
    return { verdict: 'invalid', reason: 'extractor did not return an array' };
  }
  if (!rows.length) {
    return pageTextLen >= cfg.minPageTextForContent
      ? { verdict: 'invalid', reason: 'zero rows on a page that visibly has content' }
      : { verdict: 'empty', reason: 'page appears empty — 0 rows accepted' };
  }

  const fp = schemaFingerprintOf(rows);
  if (cachedFingerprint && fp !== cachedFingerprint) {
    return { verdict: 'invalid', reason: `schema changed: expected [${cachedFingerprint}], got [${fp}]` };
  }

  const emptyCount = rows.filter(r =>
    required.some(f => !String(getFieldCaseInsensitive(r, f) ?? '').trim())
  ).length;
  if (emptyCount / rows.length > cfg.maxEmptyFraction) {
    return {
      verdict: 'invalid',
      reason: `${emptyCount}/${rows.length} rows have empty required field(s) [${required.join(', ')}]`
    };
  }

  let suspicious = null;
  if (recentCounts.length >= cfg.minHistoryForCollapse) {
    const avg = recentCounts.reduce((a, b) => a + b, 0) / recentCounts.length;
    if (avg >= 10 && rows.length < avg * cfg.collapseFraction) {
      suspicious = `row count ${rows.length} collapsed vs trailing average ${avg.toFixed(1)} — batch flagged for review`;
    }
  }
  return { verdict: 'valid', suspicious };
}
