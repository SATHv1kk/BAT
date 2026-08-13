// Direct ATS adapters — public JSON job boards fetched from the SERVICE WORKER
// (the side panel's CSP forbids cross-origin fetch; the panel calls these via
// the BAT_ATS_CMD message). No tab, no tree, no extractor: an entire company
// board in one HTTP round-trip.
//
// Every adapter returns rows in one canonical shape — {Title, Company,
// Location, Posted, URL} — so downstream dedup and writing are identical to
// the scraped path. Posted carries the API's own value verbatim (ISO string or
// epoch); no date conversion here. Endpoints drift occasionally — adapters
// fail soft with the HTTP status so drift is visible, never silent.

const TIMEOUT_MS = 15000;

async function fetchWithRetry(url, opts = {}, retries = 1) {
  let resp = await fetch(url, opts);
  for (let i = 0; i < retries && resp.status === 429; i++) {
    await new Promise(r => { setTimeout(r, 2000 * (i + 1)); });
    resp = await fetch(url, opts);
  }
  return resp;
}

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetchWithRetry(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!resp.ok) return { ok: false, status: resp.status, error: `HTTP ${resp.status}` };
    return { ok: true, data: await resp.json() };
  } catch (e) {
    return { ok: false, status: 0, error: e.message || 'network error' };
  } finally {
    clearTimeout(timer);
  }
}

const str = (v) => (v == null ? '' : String(v));

// parse() returns null when the response shape is not a job board — that is
// reported as an adapter error, never as an empty board.
export const PROVIDERS = {
  greenhouse: {
    boardUrl: (slug) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs`,
    parse(data, slug) {
      const jobs = Array.isArray(data?.jobs) ? data.jobs : null;
      if (!jobs) return null;
      return jobs.map((j) => ({
        Title: str(j.title),
        Company: str(j.company_name) || slug,
        Location: str(j.location?.name),
        Posted: str(j.first_published || j.updated_at || ''),
        URL: str(j.absolute_url)
      }));
    }
  },
  lever: {
    boardUrl: (slug) => `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`,
    parse(data, slug) {
      if (!Array.isArray(data)) return null;
      return data.map((j) => ({
        Title: str(j.text),
        Company: slug,
        Location: str(j.categories?.location),
        Posted: str(j.createdAt ?? ''),
        URL: str(j.hostedUrl)
      }));
    }
  },
  ashby: {
    boardUrl: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`,
    parse(data, slug) {
      const jobs = Array.isArray(data?.jobs) ? data.jobs : null;
      if (!jobs) return null;
      return jobs
        .filter((j) => j.isListed !== false)
        .map((j) => ({
          Title: str(j.title),
          Company: slug,
          Location: str(j.location),
          Posted: str(j.publishedAt || ''),
          URL: str(j.jobUrl || j.applyUrl || '')
        }));
    }
  },
  workable: {
    boardUrl: (slug) => `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}`,
    parse(data, slug) {
      const jobs = Array.isArray(data?.jobs) ? data.jobs : null;
      if (!jobs) return null;
      const company = str(data?.name) || slug;
      return jobs.map((j) => ({
        Title: str(j.title),
        Company: company,
        Location: [str(j.city), str(j.country)].filter(Boolean).join(', '),
        Posted: str(j.published_on || j.created_at || ''),
        URL: str(j.url || (j.shortcode ? `https://apply.workable.com/${slug}/j/${j.shortcode}/` : ''))
      }));
    }
  }
};

// The board's own company name, where the API exposes one — used to verify a
// discovered slug actually belongs to the company we asked about.
function boardNameOf(provider, data) {
  if (provider === 'workable') return str(data?.name);
  if (provider === 'greenhouse') return str(data?.jobs?.[0]?.company_name);
  return ''; // lever/ashby board APIs carry no company name
}

export async function fetchBoard(provider, slug) {
  const p = PROVIDERS[provider];
  if (!p) return { ok: false, error: `unknown provider "${provider}" (greenhouse | lever | ashby | workable)` };
  if (!slug) return { ok: false, error: 'slug required' };
  const url = p.boardUrl(slug);
  const res = await getJson(url);
  if (!res.ok) return { ok: false, error: `${provider}/${slug}: ${res.error}`, status: res.status, url };
  const rows = p.parse(res.data, slug);
  if (!rows) return { ok: false, error: `${provider}/${slug}: unexpected response shape`, url };
  return { ok: true, rows, count: rows.length, slug, url, boardName: boardNameOf(provider, res.data) };
}

// Likely slugs for a company name, best-first: suffix-stripped collapsed
// ("Ubotica Technologies" → ubotica), dashed, raw collapsed, first word.
export function slugCandidates(companyName) {
  const raw = String(companyName || '').toLowerCase().trim();
  const stripped = raw.replace(/\b(ltd|limited|inc|llc|plc|gmbh|technologies|technology|systems|labs|group)\b\.?/g, ' ').trim();
  const collapsed = stripped.replace(/[^a-z0-9]+/g, '');
  const dashed = stripped.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const rawCollapsed = raw.replace(/[^a-z0-9]+/g, '');
  const firstWord = (stripped.match(/[a-z0-9]+/) || [''])[0];
  return [...new Set([collapsed, dashed, rawCollapsed, firstWord].filter((s) => s.length >= 2))];
}

export function nameMatches(companyName, boardName) {
  if (!boardName) return false;
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
  const a = norm(companyName);
  const b = norm(boardName);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

// Discovery must confirm IDENTITY, not just existence — generic slugs
// ("intel", "luna", "insight") often resolve to empty placeholders or entirely
// different companies, and a wrong-company board with real jobs would poison
// the data silently.
//   - board exposes a name → it must match, else the candidate is rejected;
//   - no name available → accept only a NON-EMPTY board, flagged 'unverified'
//     so the caller spot-checks one job URL before trusting it;
//   - empty board with no name → rejected (existence proves nothing).
export async function discoverBoard(provider, companyName) {
  const tried = [];
  const rejected = [];
  for (const slug of slugCandidates(companyName).slice(0, 4)) {
    tried.push(slug);
    const res = await fetchBoard(provider, slug);
    if (!res.ok) continue;
    if (res.boardName) {
      if (nameMatches(companyName, res.boardName)) {
        // A name match confirms IDENTITY, but an EMPTY board still proves
        // nothing — "0 jobs" as a verified hit used to be reported to the model
        // as a successful find, which then stood in for a NOT-FOUND. The name
        // earns the candidate a second look, not a clean pass.
        if (res.count > 0) {
          return { ...res, tried, confidence: 'name-match' };
        }
        rejected.push(`${slug} (name matches "${res.boardName}" but board is empty)`);
        continue;
      }
      rejected.push(`${slug} (belongs to "${res.boardName}")`);
      continue;
    }
    if (res.count > 0) {
      return { ...res, tried, confidence: 'unverified', warning: 'board has no company name to verify — spot-check one job URL before trusting the match' };
    }
    rejected.push(`${slug} (empty board, identity unconfirmable)`);
  }
  return {
    ok: false,
    tried,
    error: `no ${provider} board for "${companyName}" (tried: ${tried.join(', ')}`
      + (rejected.length ? `; rejected: ${rejected.join('; ')}` : '') + ')'
  };
}
