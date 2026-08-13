// Site-template verification, stored in chrome.storage.local rather than in
// src/shared/site-configs.js.
//
// Every shipped template is `verified: false` and two are outright null, because
// templates rot and cannot be checked outside a real browser. The only way to
// flip one was to hand-edit a source file — which meant verification was lost on
// the next `git pull`, and the "resumable background runner" shipped with zero
// confirmed targets. Verification is per-installation empirical knowledge, so it
// belongs in storage next to the user's other settings.

const KEY = 'bat_site_verification';

// 404 markers plus SPA-shell detection. A 200 that renders an empty shell is the
// single most common way a template "works" while collecting nothing.
export const NOT_FOUND_RE = /\b(404|page not found|not found|no longer available|page you requested)\b/i;
export const MIN_REAL_TEXT = 800;

// Pure: turn a probe of a loaded page into a verdict. Testable without Chrome.
export function judgeProbe({ requestedUrl, finalUrl, title = '', textLen = 0, rowsFound = null }) {
  const reasons = [];
  let ok = true;

  if (!finalUrl) {
    return { ok: false, verdict: 'unreachable', reasons: ['the page never loaded'] };
  }
  if (NOT_FOUND_RE.test(title)) {
    ok = false;
    reasons.push(`title looks like an error page: "${title.slice(0, 80)}"`);
  }
  if (textLen < MIN_REAL_TEXT) {
    ok = false;
    reasons.push(`only ${textLen} chars of text — likely a JS shell that never rendered, or an error page`);
  }
  // A redirect is not automatically fatal (many sites normalize URLs), but losing
  // the query string means the template's parameters were dropped and every
  // "page 2" would silently return page 1.
  try {
    const a = new URL(requestedUrl);
    const b = new URL(finalUrl);
    const sameSite = a.host === b.host || a.host.endsWith('.' + b.host) || b.host.endsWith('.' + a.host);
    if (a.search && !b.search) {
      ok = false;
      reasons.push(`query string was dropped in a redirect (${a.search} → none) — pagination and filters would not apply`);
    } else if (!sameSite) {
      // A genuinely different host is a different site entirely. Subdomain moves
      // (jobs.test → www.jobs.test) and the http→https upgrade are the same site
      // and benign — the old check compared `origin`, which includes the scheme,
      // so every HTTPS upgrade looked like a fatal cross-origin redirect.
      ok = false;
      reasons.push(`redirected to a different site (${a.host} → ${b.host})`);
    } else if (a.href !== b.href) {
      reasons.push(`redirected (${a.href} → ${b.href})${a.protocol !== b.protocol ? ' — HTTPS upgrade, not fatal' : ''}`);
    }
  } catch {
    reasons.push('could not compare requested and final URLs');
  }

  if (rowsFound === 0) {
    ok = false;
    reasons.push('an extractor ran but found 0 rows');
  }

  return {
    ok,
    verdict: ok ? (reasons.length ? 'ok-with-notes' : 'ok') : 'rejected',
    reasons
  };
}

export async function loadVerification() {
  const s = await chrome.storage.local.get([KEY]);
  return (s[KEY] && typeof s[KEY] === 'object') ? s[KEY] : {};
}

export async function markVerified(site, { url_template, finalUrl, rowsFound, note } = {}) {
  const all = await loadVerification();
  all[site] = {
    verified: true,
    url_template: url_template || all[site]?.url_template || null,
    verifiedAt: Date.now(),
    finalUrl: finalUrl || null,
    rowsFound: rowsFound ?? null,
    note: note || ''
  };
  await chrome.storage.local.set({ [KEY]: all });
  return all[site];
}

export async function markBroken(site, reason) {
  const all = await loadVerification();
  all[site] = { ...(all[site] || {}), verified: false, brokenAt: Date.now(), note: reason || '' };
  await chrome.storage.local.set({ [KEY]: all });
  return all[site];
}

export async function clearVerification(site) {
  const all = await loadVerification();
  delete all[site];
  await chrome.storage.local.set({ [KEY]: all });
}

// Pure merge so the precedence rule is testable: stored knowledge wins over the
// shipped default, and a stored template replaces a rotted or null one.
export function mergeConfigs(configs, stored) {
  return configs.map((c) => {
    const v = stored?.[c.site];
    if (!v) return c;
    return {
      ...c,
      verified: !!v.verified,
      url_template: v.url_template || c.url_template,
      verifiedAt: v.verifiedAt || null,
      verificationNote: v.note || ''
    };
  });
}
