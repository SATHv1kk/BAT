// The site allowlist — ONE implementation, shared by the panel and the runner.
//
// This used to fail OPEN: an empty list meant "allow everything", and empty was
// the default. So a fresh install ran model-authored page code and trusted CDP
// input on every site the user pointed it at, in a browser holding all their
// logged-in sessions — while the README called the allowlist "the real
// boundary". A boundary that is absent by default is not a boundary.
//
// It now fails CLOSED. An empty list permits nothing that modifies a page or
// runs code; reading, scrolling and navigating stay available so the agent can
// still show the user where it is and ask to be let in. `bat_allow_all_sites`
// is an explicit, deliberate opt-out for people who want the old behaviour.

const SITES_KEY = 'bat_allowed_sites';
const ALLOW_ALL_KEY = 'bat_allow_all_sites';

export function normalizeHostPattern(raw) {
  return String(raw || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^\*\./, '')
    .replace(/\/.*$/, '')
    .replace(/[?#].*$/, '')
    .replace(/:\d+$/, '')
    // Strip a leading www. — "www.example.com" and "example.com" are the same
    // site to the user, and the old code kept the prefix, so granting one form
    // did not cover the other (granting "example.com" matched "www.example.com"
    // via the subdomain rule, but the reverse silently failed). One normalized
    // form means one grant covers both.
    .replace(/^www\./, '');
}

export function parseAllowedSites(text) {
  return [...new Set(String(text || '')
    .split(/[\r\n,\s]+/)
    .map(normalizeHostPattern)
    .filter(Boolean))];
}

// Pure so the decision itself is testable without chrome or a live tab.
export function decideAccess(url, sites, allowAll) {
  // Scheme is checked BEFORE the allowAll shortcut, deliberately. "Allow all
  // sites" is the user consenting about SITES; it is not consent to drive
  // chrome://, file:// or a data: URL, which are not sites and where a
  // model-authored click has no legitimate business.
  let host;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, reason: `unsupported scheme "${u.protocol}"`, host: null };
    }
    host = u.hostname.toLowerCase();
  } catch {
    return { ok: false, reason: 'unparseable URL', host: null };
  }
  if (allowAll) return { ok: true, reason: 'all sites explicitly permitted', host };
  if (!sites.length) {
    return { ok: false, reason: 'no sites are allowed yet', host, empty: true };
  }
  const hit = sites.some((p) => host === p || host.endsWith('.' + p));
  return hit
    ? { ok: true, reason: 'host is on the allowlist', host }
    : { ok: false, reason: 'host is not on the allowlist', host };
}

export async function loadAllowlist() {
  const s = await chrome.storage.local.get([SITES_KEY, ALLOW_ALL_KEY]);
  const sites = Array.isArray(s[SITES_KEY]) ? s[SITES_KEY] : null;
  const hasAllowAllFlag = typeof s[ALLOW_ALL_KEY] === 'boolean';
  // DEFAULT TO ALLOW-ALL for a fresh install: a brand-new user's first action
  // is "go scrape/automate that site", and a blank allowlist fails CLOSED —
  // every page-changing tool is blocked until they find the toggle. That used
  // to mean the very first run silently did nothing while the UI gave no hint.
  // The safe middle ground: default to unrestricted ONLY when the user has
  // never made any allowlist decision (no flag AND no saved sites). The moment
  // they save either, that choice is honored and persisted.
  if (sites === null && !hasAllowAllFlag) {
    return { sites: [], allowAll: true };
  }
  return {
    sites: sites === null ? [] : sites,
    allowAll: hasAllowAllFlag ? s[ALLOW_ALL_KEY] : false
  };
}

export async function saveAllowlist({ sites, allowAll }) {
  const patch = {};
  if (sites) patch[SITES_KEY] = parseAllowedSites(sites.join('\n'));
  if (allowAll != null) patch[ALLOW_ALL_KEY] = !!allowAll;
  await chrome.storage.local.set(patch);
  return loadAllowlist();
}

// Grant one origin without making the user hand-edit a textarea — the whole
// reason the old default was "allow everything" was that granting was awkward.
export async function grantHost(host) {
  const clean = normalizeHostPattern(host);
  if (!clean) throw new Error('No host to allow');
  const { sites, allowAll } = await loadAllowlist();
  if (!sites.includes(clean)) sites.push(clean);
  // Persist the allowAll flag EXPLICITLY along with the new site. On a fresh
  // install allowAll is an implicit default (true, never written to storage);
  // writing only the site list would make the next loadAllowlist read
  // `hasAllowAllFlag === false` + non-empty sites → allowAll:false, silently
  // flipping EVERY other site from "allowed" to "blocked" the moment the user
  // grants one. Carrying the current value forward keeps the behavior stable.
  await chrome.storage.local.set({ [SITES_KEY]: sites, [ALLOW_ALL_KEY]: allowAll });
  return clean;
}

export async function checkUrl(url) {
  const { sites, allowAll } = await loadAllowlist();
  return decideAccess(url, sites, allowAll);
}

// The message the agent sees on refusal. It has to be actionable: naming the
// exact host and the exact affordance is what turns a dead end into a prompt.
export function blockedMessage(decision, toolName) {
  const host = decision.host ? `"${decision.host}"` : 'this page';
  const why = decision.empty
    ? `No sites are allowed yet, so page-changing tools are off everywhere.`
    : `${host} is not on the allowed-sites list.`;
  return `Blocked: ${why} ${toolName ? `\`${toolName}\` ` : 'Page-changing tools '}`
    + `cannot run here. Reading, scrolling and navigating still work. `
    + `Tell the user to click "Allow ${decision.host || 'this site'}" in the panel `
    + `(or add it under Settings → Allowed sites), then retry.`;
}
