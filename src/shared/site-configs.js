// Site configs as DATA — one entry per site describing how to construct a
// search URL directly, so runs never click through filter dropdowns. Humans
// edit this file; agent logic never hardcodes a site.
//
// Templates use {keyword}, {location}, and {page}. pages.step is the
// pagination increment ({page} counts 0,10,20… on offset-paged sites).
// verified:false = best-effort template — confirm one page in the browser
// before building a large run on it (templates rot; this file is where they
// get fixed).
//
// `probe` records what a non-browser HTTP request saw (2026-07-29). It is
// diagnostic only: every one of these sites is a JS-rendered SPA and/or
// bot-hostile, so a plain fetch proves little — 'anti-bot' means a headless
// scraper is blocked where BAT (real Chrome, trusted input) still works, and
// only `verified:true` (checked in the browser) should be trusted for a large
// run. Resolve these in Chrome, then set verified and fix the template here.
export const SITE_CONFIGS = [
  {
    site: 'ie.indeed.com',
    name: 'Indeed Ireland',
    url_template: 'https://ie.indeed.com/jobs?q={keyword}&l={location}&sort=date&start={page}',
    pages: { start: 0, step: 10, max: 5 },
    verified: false,
    probe: 'HTTP 403 anti-bot to non-browser requests',
    account_risk: true,
    note: 'aggressive anti-bot — expect AWAITING_HUMAN; drive in a real browser'
  },
  {
    site: 'linkedin.com',
    name: 'LinkedIn Jobs',
    url_template: 'https://www.linkedin.com/jobs/search/?keywords={keyword}&location={location}&sortBy=DD&start={page}',
    pages: { start: 0, step: 25, max: 5 },
    verified: false,
    probe: 'HTTP 200 but requires JS/cookies (anti-bot markers)',
    account_risk: true,
    note: 'auth wall likely when logged out — expect AWAITING_HUMAN. Automating a logged-in session risks the ACCOUNT, not just an IP: confirm with the user first'
  },
  {
    site: 'irishjobs.ie',
    name: 'IrishJobs',
    url_template: 'https://www.irishjobs.ie/jobs?q={keyword}&sort=recent&page={page}',
    pages: { start: 1, step: 1, max: 5 },
    verified: false,
    probe: 'HTTP 200 but empty shell (JS-rendered); repeat requests timed out (rate limiting)',
    note: 'confirm the query/sort/page params in Chrome before a multi-page run'
  },
  {
    site: 'jobs.workable.com',
    name: 'Workable public board',
    url_template: 'https://jobs.workable.com/search?query={keyword}&location={location}',
    pages: { start: 1, step: 1, max: 1 },
    verified: false,
    probe: 'HTTP 200 but requires JS (anti-bot markers)',
    note: 'infinite scroll — drive interactively: scroll to:"bottom" then extract_rows'
  },
  {
    site: 'gradireland.com',
    name: 'GradIreland',
    url_template: null,
    verified: false,
    probe: 'HTTP 404 for /search-jobs and /jobs-and-graduate-programmes; /search returns 200 but an empty SPA shell',
    note: 'TEMPLATE BROKEN — find the real search URL in Chrome (watch the address bar while searching), put it here, then use it'
  },
  {
    site: 'jobsireland.ie',
    name: 'JobsIreland',
    url_template: null,
    verified: false,
    probe: 'HTTP 404 for /en-US/SearchJobs, /en-US/SearchJobs?keyword=, /en-US/general-search',
    note: 'TEMPLATE BROKEN — search UI appears to POST; capture the real request in Chrome DevTools, or drive interactively with extract_rows'
  },
  {
    site: 'glassdoor.ie',
    name: 'Glassdoor Ireland',
    url_template: null,
    verified: false,
    account_risk: true,
    note: 'search URLs are token-encoded — drive interactively with extract_rows'
  },
  {
    site: 'jobs.ashbyhq.com',
    name: 'Ashby public board',
    url_template: 'https://jobs.ashbyhq.com/{keyword}',
    pages: { start: 1, step: 1, max: 1 },
    verified: false,
    note: 'per-company boards — prefer ats_fetch provider "ashby" instead'
  }
];
