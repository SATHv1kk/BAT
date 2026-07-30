# BAT — Browser Automation Tool

A Chrome extension that puts an agent in your browser's side panel. Give it a goal in
plain language and it reads the current page, decides what to do, and drives the page
for you — clicking, typing, scrolling, and navigating.

Instead of guessing at pixel coordinates from a screenshot, BAT builds an accessibility
tree of the page and gives every interactive element a stable reference id. The model
picks an element by reference, and clicks are dispatched as trusted input events through
the Chrome DevTools Protocol — so pages react exactly as they would to a real user.

## Features

- **Side panel UI** — chat alongside any page, no separate window.
- **Accessibility-tree page reading** — compact, structured page state instead of raw HTML.
- **Trusted input via CDP** — real click and keyboard events, not synthetic DOM events.
- **Phantom cursor** — a visible pointer shows what the agent is about to touch.
- **Canvas fallback** — screenshots and coordinate clicks for pages with no useful DOM.
- **Multi-tab** — can open a background tab and work there while you keep your view.
- **Console and network access** — can read logs and requests to diagnose a stuck page.
- **Per-site allowlist** — the agent only acts on origins you approve.
- **Sensitive-value redaction** — password, one-time-code, and payment fields are never
  read back into the model's context.
- **Session persistence** — conversations survive closing and reopening the panel.
- **Workspace folder** — grant BAT a folder on disk (Settings → Workspace folder) and
  the agent can save notes, collected data, and progress checkpoints as real files
  (`save_file` / `read_file` / `list_files`) that survive restarts. Access is limited
  to the folder you pick.
- **Structured data files** — `append_rows` writes TSV/CSV files append-only: header
  exactly once, cells sanitized (tabs/newlines stripped, delimiters escaped), rows
  flushed per unit of work, and the running row count always read back from the file
  itself — never from the model's memory. Data collection survives panel close and
  browser restarts.
- **Bulk extraction engine** — `extract_rows` lets the model write a page-specific
  extractor function *once*, caches it in IndexedDB per URL pattern (with version
  history), then replays it across every later page of that site with **zero model
  reading** — rows flow straight into the dedup store and output file. Every replay
  is validated (schema fingerprint, empty required fields, row-count collapse,
  empty-page detection); a failing extractor is retired and re-synthesized once,
  and a second consecutive failure halts the site rather than collecting
  plausible-looking garbage. Synthesized source is logged (activity feed *and* the
  run log, so background runs keep an audit trail) and gated by the same per-site
  allowlist as every other page-modifying tool. Extractors compile in-page where
  allowed and fall back to CDP evaluation on sites whose CSP forbids it — which is
  most of the sites worth scraping.
- **Direct ATS adapters** — `ats_fetch` pulls a company's whole job board from the
  public Greenhouse / Lever / Ashby / Workable JSON APIs in one HTTP call from the
  service worker: no tab, no tree, no extractor. Includes slug discovery (tries
  likely name variants, reports NOT-FOUND with what was tried), a `location_filter`
  regex, and the same canonical row shape as scraped pages — so ATS rows dedup
  against browser-collected rows automatically.
- **Site configs as data** — `src/shared/site-configs.js` holds per-site search URL
  templates ({keyword}/{location}/{page}), pagination start/step/max, and caveats;
  `run_control {action:"sites"}` lists them. A human edits the file; agent logic
  never hardcodes a site.
- **Resumable background runner** — `run_control` compiles a multi-site collection
  job into a persisted plan (URL templates, iteration vars, pagination, stop
  conditions, exclude/flag rules) and executes it in the service worker: zero
  model calls per page via cached extractors (the model is consulted only to
  synthesize a new extractor), a checkpoint after **every** page, and automatic
  recovery from panel close, worker eviction, and browser restart (30s alarm
  watchdog + startup revival). CAPTCHAs and login walls are detected by signal —
  never solved — and park the run in AWAITING_HUMAN until you clear them and
  resume at the exact page. Stalled pages are skipped and logged; a unit that
  fails repeatedly is abandoned while the run stays alive.
- **Deduplicating collection store** — `collect_rows` keeps every collected row in
  IndexedDB keyed by a normalized composite of fields you nominate (case,
  punctuation, and whitespace insensitive). Duplicates keep the first row and merge
  the newcomer's source into it; only novel rows reach the file. `export_rows`
  regenerates the file from the store with fully merged sources, and `data_report`
  produces final totals from the store — the file is a projection, the store is the
  authority.

## Install

Requires [Node.js](https://nodejs.org/) 18 or newer.

```bash
git clone https://github.com/SATHv1kk/BAT.git
cd BAT
npm install
npm run build
```

Then load it into Chrome:

1. Go to `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the generated `dist/` folder.
4. Open the panel with the toolbar icon or <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd>
   (<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> on macOS).

`dist/` is a build artifact and is not committed — run `npm run build` after pulling.

## Configuration

BAT talks to the [DeepSeek API](https://platform.deepseek.com/api_keys). On first run,
open the panel's settings and paste your API key. It is stored in
`chrome.storage.local` on your machine and is never committed to the repo.

Pick a model from the panel's model selector:

| Model | Notes |
| --- | --- |
| `deepseek-v4-pro` | Default. Strongest reasoning, best for multi-step goals. |
| `deepseek-v4-flash` | Faster and cheaper, good for short tasks. |
| `deepseek-chat` | V3, the previous generation. |

## Development

```bash
npm run dev      # Vite dev server with hot reload
npm run build    # production build to dist/
npm run preview  # preview the built output
npm test         # 64 assertions: dedup keys, extractor validation, the CDP
                 # extractor fallback, the runner state machine, plan rules,
                 # and live ATS adapter checks
```

`npm test` needs network access for the ATS section — it fetches four real job
boards. Everything else is offline and deterministic.

The extension is built with [Vite](https://vitejs.dev/) and
[@crxjs/vite-plugin](https://crxjs.dev/vite-plugin), which compiles `src/manifest.json`
into a valid MV3 bundle and rewrites asset paths.

## Architecture

```
src/
├── manifest.json          MV3 manifest (source of truth; crxjs rewrites paths on build)
├── background/
│   └── index.js           Service worker: side panel wiring + API proxy
├── sidepanel/
│   ├── index.html         Panel markup and styles
│   ├── main.js            Entry point
│   └── app.js             Chat UI + the agent loop
├── content/
│   ├── accessibility-tree.js   Builds the page tree, assigns ref ids
│   └── phantom-cursor.js       Visible cursor overlay
├── lib/
│   ├── browser-tools.js   Action tools (click, type, scroll, navigate) via CDP
│   └── page-tools.js      Read tools (find, page text, tab list)
├── agent/
│   └── parse.js           Parses and normalizes model responses into actions
└── shared/
    └── constants.js       API config, model list, limits, regexes
```

### How a turn works

1. **Observe** — the content script walks the DOM and emits an accessibility tree.
   Every interactive element gets a stable id like `ref_12`.
2. **Think** — the panel sends the goal, history, and tree to the model. The request is
   proxied through the service worker, which isn't bound by the panel's CSP and outlives
   the panel if it closes mid-request.
3. **Act** — the model replies with a tool call naming a `ref_*`. BAT resolves the ref to
   a live element, scrolls it into view, moves the phantom cursor, and dispatches a
   trusted event through CDP.
4. **Repeat** — the loop observes again and continues until the goal is met, the step
   budget runs out, or you press Stop.

Element references are held as `WeakRef`s in a page-side map, so they don't leak memory
and go stale safely when the DOM changes — a stale ref returns an error telling the model
to re-read the page rather than clicking the wrong thing.

### Tools available to the agent

The model is given these as native function-calling tools.

| Category | Tools |
| --- | --- |
| Read | `read_page`, `get_page_text`, `find` |
| Interact | `left_click`, `form_input`, `type`, `press_key` |
| Move | `scroll`, `scroll_to`, `navigate`, `go_back`, `go_forward`, `refresh` |
| Tabs | `list_tabs`, `open_tab`, `switch_tab` |
| Escape hatches | `screenshot`, `click_coords`, `run_javascript` |
| Files | `save_file`, `read_file`, `list_files`, `append_rows` (workspace folder, once granted) |
| Data collection | `collect_rows`, `export_rows`, `data_report` (dedup store + file projection) |
| Bulk extraction | `extract_rows` (synthesize once, replay per page, validated) |
| Background runs | `run_control` (create/start/pause/resume/status/sites/report — survives restarts) |
| ATS boards | `ats_fetch` (Greenhouse/Lever/Ashby/Workable JSON, slug discovery) |
| Debug | `read_console`, `read_network` |
| Control | `wait`, `done` |

The escape hatches matter for pages the accessibility tree can't describe. Canvas-rendered
content has no meaningful DOM, so BAT falls back to `screenshot` plus `click_coords` to
work by sight, and `run_javascript` to read state the tree misses.

### Verifying file persistence

1. Build, load `dist/`, open the panel, and pick a folder under **Settings (⚙) →
   Workspace folder**.
2. Ask the agent: *"Append three test rows (name, value) to test.tsv using
   append_rows."*
3. Close the side panel entirely, reopen it, and ask: *"Append two more rows to
   test.tsv and tell me the row count."*
4. Open `test.tsv` in the chosen folder: one header line, five data rows in order,
   and the agent's reported count says 5. A cell containing tabs, quotes, or
   newlines must not break the column alignment.

### Verifying deduplication

1. Ask the agent: *"Use collect_rows on jobs.tsv with dedup_fields
   ["company","title"] to store these rows: Acme / Robotics Engineer / source
   SiteA; ACME / robotics engineer! / source SiteB; Acme / Vision Engineer /
   source SiteA."*
2. Expected reply: 2 new rows, 1 duplicate merged.
3. Ask: *"export_rows jobs.tsv, then data_report jobs.tsv."*
4. The file holds two data rows — the Robotics Engineer row's source cell reads
   `SiteA; SiteB` — and the report's totals (2 unique, 1 merged) match the file.

### Verifying bulk extraction

1. On any results-style page (e.g. a job search), ask: *"Set up an extractor for
   this page with extract_rows and save rows to jobs.tsv (dedup on Company+Title)."*
   The agent reads the page once, writes a function, and the activity feed shows
   the synthesized source.
2. Go to page 2 (or another query on the same site) and ask: *"extract_rows again."*
   Rows land in the file with **no page reading** — the tool result reports counts
   only.
3. Break it deliberately: on a page where the extractor finds nothing (or after
   the site changes), the tool reports the extractor invalid, retires it, and asks
   for one fresh synthesis; a second consecutive failure reports the site HALTED
   instead of writing empty or malformed rows.

### Verifying the background runner

1. Ask the agent to plan a small run (2 units × 2–3 pages of a permitted site)
   with `run_control` — it shows the plan; confirm, and it starts.
2. Close the side panel entirely. The run keeps going (watch the toolbar badge
   `▶` and the output file growing).
3. Kill the worker mid-run (`chrome://serviceworker-internals` → stop, or just
   wait for eviction). Within ~30s the watchdog alarm revives it and the run
   continues from the last checkpointed page — reopen the panel and ask for
   *"run status"*: no duplicated rows (dedup store), no lost position.
4. Point a unit at a page with a login wall or CAPTCHA: the run parks as
   AWAITING_HUMAN with a `!` badge and a panel notice naming what was hit and
   where. Clear it in the run's tab, say *"resume the run"* — it re-enters at
   the exact page that was interrupted.

### Verifying ATS adapters

1. Ask: *"ats_fetch the greenhouse board for stripe"* — a real board comes back
   in seconds with Title/Company/Location/Posted/URL rows.
2. Ask: *"Pull the Lever board for Highspot into jobs.tsv (dedup Company+Title,
   Source 'Lever')"* — rows land in the same store as browser-collected rows and
   dedup against them.
3. Ask for a company that doesn't exist — the reply is NOT-FOUND with the slug
   variants that were tried.

## Known limits of bulk collection

Measured, not assumed — from a full sweep of 35 Irish tech companies and a probe
of every site template in `src/shared/site-configs.js` (2026-07-29):

- **Most non-US companies are not on a public ATS.** Of 35 Irish employers
  (SMEs, universities, research centres), 2 had a verifiable Greenhouse/Lever/
  Ashby/Workable board. The adapters work — they pull Stripe, Highspot, OpenAI
  and Blueground correctly — but for a list like this, `ats_fetch` mostly
  returns NOT-FOUND and the browser path does the real work. Budget accordingly.
- **Slug guessing cannot be trusted on its own.** Generic one-word names resolve
  to unrelated boards (`workable/intel` is Intel Corporation, `ashby/adapt` is a
  San Francisco company, not Ireland's ADAPT centre). Discovery therefore
  verifies the board's own company name where the API exposes one, rejects
  mismatches with an explanation, and refuses to auto-save a board it could not
  verify — it asks you to eyeball a sample first.
- **Site URL templates rot and cannot be validated outside a browser.** Two of
  the shipped templates were already dead (404), and every Irish job site tested
  is either a JS-rendered shell or actively anti-bot to plain HTTP. That is the
  case for BAT rather than a headless scraper — but it means every template
  starts `verified: false` and must be confirmed in Chrome before a large run.
- **Background file writing is verified at run start, not assumed.** Whether a
  File System Access handle granted in the panel stays writable from the service
  worker is environment-dependent, so starting a run probes it first. If the
  worker cannot write, the run still proceeds — rows are never lost, they live in
  the store — but you are told up front that the file only updates when you run
  `export_rows`, rather than discovering the divergence hours later.
- **Expect AWAITING_HUMAN on LinkedIn, Indeed and Glassdoor.** They are flagged
  `account_risk` in the site configs; creating a run that targets them raises a
  one-time warning that automated collection can put the signed-in **account**
  at risk, not just the IP. BAT warns and proceeds — it does not block.

## Permissions

The manifest requests broad permissions because a general-purpose browser agent needs
them. Concretely:

| Permission | Why |
| --- | --- |
| `debugger` | Dispatch trusted input via CDP. Chrome shows a banner while attached. |
| `<all_urls>` | Operate on whatever page you point it at — gated by the allowlist. |
| `tabs`, `webNavigation` | Track navigation so the loop knows when a page settled. |
| `scripting` | Inject the page-reading helpers. |
| `storage` | Persist your API key, model choice, and session. |
| `sidePanel`, `activeTab` | Host the UI. |

The `debugger` permission is what makes trusted input possible, and it's also why Chrome
displays a "BAT started debugging this browser" banner while the agent is running. That
banner is expected.

## Security notes

- **Your key stays local.** It lives in `chrome.storage.local` and is sent only to the
  DeepSeek API. `DEEPSEEK_DEFAULT_KEY` in `src/shared/constants.js` must stay empty —
  never commit a real key.
- **Sensitive fields are redacted.** Password, hidden, one-time-code, and payment
  autocomplete fields report `[value redacted]` instead of their contents.
- **The allowlist is the real boundary.** An agent that can click can act on your behalf
  on sites where you're logged in. Only approve origins you intend it to touch, and watch
  what it does on anything that spends money or sends messages.

## License

[MIT](LICENSE)
