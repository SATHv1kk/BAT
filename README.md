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
  Walks into open shadow roots too, so Web Components (common in modern design systems)
  aren't invisible — a closed shadow root has no JS-reachable API at all, by design, so
  that one genuinely can't be read from script.
- **Trusted input via CDP** — real click and keyboard events, not synthetic DOM events.
- **Phantom cursor** — a visible pointer shows what the agent is about to touch.
- **Coordinate fallback** — for canvas-rendered pages with no useful DOM, the agent reads
  state and element geometry with `run_javascript` and acts with `click_coords`.
  (Screenshots are a separate, currently **disabled** path — see
  [Vision](#vision-is-off-by-default).)
- **Multi-tab** — can open a background tab and work there while you keep your view.
- **Console and network access** — can read logs and requests to diagnose a stuck page.
- **Per-site allowlist, closed by default** — page-changing tools run only on origins you
  approve. See [Security model](#security-model).
- **Sensitive-value redaction** — password, one-time-code, and payment fields are never
  read back into the model's context, and are stripped from page markup before any of it
  is uploaded for extractor synthesis.
- **Session persistence** — the conversation transcript survives closing and reopening
  the panel. An in-flight *interactive* turn does not: closing the panel ends it.
  Background runs are the thing built to survive (see below).
- **Workspace folder** — grant BAT a folder on disk (Settings → Workspace folder) and
  the agent can save notes, collected data, and progress checkpoints as real files
  (`save_file` / `read_file` / `list_files`) that survive restarts. Access is limited
  to the folder you pick, and every writer shares one per-file lock.
- **Structured data files** — `append_rows` writes TSV/CSV files append-only: header
  exactly once, cells sanitized (tabs/newlines stripped, delimiters escaped, CSV headers
  parsed with the same quoting rules used to write them), rows flushed per unit of work,
  and the running row count always read back from the file itself.
- **Bulk extraction engine** — `extract_rows` lets the model write a page-specific
  extractor function *once*, caches it in IndexedDB per URL pattern (with version
  history), then replays it across every later page of that site with **zero model
  reading**. Every replay is validated (schema fingerprint, empty required fields,
  row-count collapse, empty-page detection, and an explicit report when the 2,000-row
  cap truncates a page); a failing extractor is retired and re-synthesized once, and a
  second consecutive failure halts the site rather than collecting plausible-looking
  garbage. Every extractor is **safety-screened** before it runs (see
  [Security model](#security-model)). Extractors compile in-page where allowed and fall
  back to CDP evaluation on sites whose CSP forbids it.
- **Direct ATS adapters** — `ats_fetch` pulls a company's whole job board from the
  public Greenhouse / Lever / Ashby / Workable JSON APIs in one HTTP call from the
  service worker: no tab, no tree, no extractor. Includes slug discovery with identity
  verification, a `location_filter` regex, and the same canonical row shape as scraped
  pages — so ATS rows dedup against browser-collected rows automatically.
- **Site configs as data, verification as state** — `src/shared/site-configs.js` holds
  per-site search URL templates and pagination rules; a human edits that file.
  Whether a template *actually works* is empirical and per-installation, so
  `run_control {action:"verify"}` loads page 1 in the browser, judges what came back, and
  `mark_verified` records the result in `chrome.storage.local` — which means verification
  survives `git pull` instead of being wiped by it.
- **Resumable background runner** — `run_control` compiles a multi-site collection
  job into a persisted plan and executes it in the service worker: zero model calls per
  page via cached extractors, a checkpoint after **every** page, and automatic recovery
  from panel close, worker eviction, and browser restart (30s alarm watchdog + startup
  revival). Page budgets are phase-aware, so extractor synthesis is not judged against a
  navigation-sized timer. Pacing is jittered and per-host rate-limited. CAPTCHAs and
  login walls are detected by signal — never solved — and park the run in AWAITING_HUMAN
  until you clear them and resume at the exact page.
- **Deduplicating collection store** — `collect_rows` keeps every collected row in
  IndexedDB keyed on a normalized composite of fields you nominate (case, punctuation and
  whitespace insensitive — but *not* so aggressive that `C++ Developer` and `C Developer`
  collide). Duplicates keep the first row and merge the newcomer's source into it; only
  novel rows reach the file. `export_rows` regenerates the file from the store with fully
  merged sources, and `data_report` produces final totals — the file is a projection, the
  store is the authority.
- **Stored-data manager** — Settings → *Manage stored data* lists every collection,
  cached extractor (with its source), and run, and lets you inspect or delete any of
  them, plus pause/resume runs without going through the agent.

## Quick start

Six steps from a clone to BAT clicking something for you.

**1. Build it.** Requires [Node.js](https://nodejs.org/) 18 or newer.

```bash
git clone https://github.com/SATHv1kk/BAT.git
cd BAT
npm install
npm run build
```

**2. Load it into Chrome.**

1. Go to `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the generated `dist/` folder.
   (`dist/` is a build artifact and is not committed — run `npm run build` again after
   every `git pull`.)
4. Open the panel with the toolbar icon or <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd>
   (<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> on macOS).

**3. Set your API key.** BAT talks to the [DeepSeek API](https://platform.deepseek.com/api_keys).
The panel opens Settings automatically on first run — paste your key there. It is stored
in `chrome.storage.local` on your machine and is never sent anywhere except the DeepSeek
API.

**4. Approve a site.** The allowlist is empty on a fresh install and **fails closed**: BAT
can read any page, but it cannot click, type, or run page code anywhere until you say so.
Open the site you want it to act on, then either:

- click the **Allow \<site\>** button that appears above the composer, or
- add the domain under Settings (⚙) → *Allowed sites*.

(There's an *Allow all sites* toggle for the unrestricted old behaviour — it's off by
default on purpose; see [Security model](#security-model) for why.)

**5. Try it.** With a site approved, type a goal in plain language and press Enter, e.g.
*"summarize this page"* (works with zero setup — reading never needed approval) or, on
an approved site, *"click the search box and type 'robotics jobs'"*. Watch the activity
feed: each step shows what BAT read, decided, and did.

**6. If nothing happens:** check the model dropdown has a key configured (send button
stays disabled without one), and check the allowlist status line under Settings — "No
sites are allowed" means page actions are intentionally off until you approve one.

## Configuration

### Models

Pick a model from the panel's model selector:

| Model | Notes |
| --- | --- |
| `deepseek-v4-pro` | Default. Strongest reasoning, best for multi-step goals. |
| `deepseek-v4-flash` | Faster and cheaper, good for short tasks. |
| `deepseek-chat` | V3, the previous generation. |

> **Verify these ids against your provider.** They live in `MODEL_OPTIONS` in
> `src/shared/constants.js`. If your account does not serve a given id, BAT now reports
> *"Model … was rejected by the API"* with instructions rather than a bare `HTTP 400`.
> Reasoning parameters (`reasoning_effort`, `thinking`) are also optional: if the
> provider rejects them, BAT drops them and retries automatically for the rest of the
> session.

### Vision is off by default

`VISION_SUPPORTED` in `src/shared/constants.js` is `false`, because the DeepSeek chat API
does not accept image input. While it is false:

- the `screenshot` tool is **not offered** to the model at all, and
- no screenshots are captured or held in the conversation.

`click_coords` still works, so canvas-rendered pages are handled by reading geometry with
`run_javascript` and clicking coordinates. Flipping the constant to `true` re-enables the
whole screenshot path for a model that can actually read images.

## Development

```bash
npm run dev        # Vite dev server with hot reload
npm run build      # production build to dist/
npm run preview    # preview the built output

npm run lint       # ESLint (flat config, eslint.config.js)
npm test           # 397 offline assertions — deterministic, no network. Gates CI.
npm run test:live  # only the live ATS checks (fetches four real job boards)
npm run test:all   # both
npm run check      # lint + test + build, i.e. what CI runs
```

`npm test` is fully offline and is the gate for every push and PR. The live ATS section
is separate and runs on a daily schedule, because a third-party endpoint changing is
information — not a reason to turn an unrelated contributor's PR red.

The extension is built with [Vite](https://vitejs.dev/) and
[@crxjs/vite-plugin](https://crxjs.dev/vite-plugin), which compiles `src/manifest.json`
into a valid MV3 bundle and rewrites asset paths.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the invariants that matter when changing this
codebase, and [SECURITY.md](SECURITY.md) for the threat model.

## Architecture

```
src/
├── manifest.json          MV3 manifest (source of truth; crxjs rewrites paths on build)
├── background/
│   ├── index.js           Service worker: side panel wiring + API proxy + ATS fetches
│   └── runner.js          Background collection runs (state machine + watchdog)
├── sidepanel/
│   ├── index.html         Panel markup, styles, settings, stored-data manager
│   ├── main.js            Entry point
│   ├── app.js             Chat UI, the agent loop, and tool dispatch
│   ├── prompt.js          The system prompt (pure function of model + capabilities)
│   ├── tool-defs.js       Native function-calling schemas (pure data)
│   └── deepseek.js        Three-transport API client + one model call
├── content/
│   ├── accessibility-tree.js   Builds the page tree, assigns ref ids, redacts secrets
│   └── phantom-cursor.js       Visible cursor overlay
├── lib/
│   ├── browser-tools.js   Action tools (click, type, scroll, navigate) via CDP
│   ├── page-tools.js      Read tools (find, page text, tab list)
│   ├── allowlist.js       The security boundary — fails closed
│   ├── redaction.js       Sensitive-field policy (mirrored by the content script)
│   ├── extractor-screen.js  Refuses extractor source that is not a pure DOM reader
│   ├── extractor-exec.js  Runs extractors: scripting → CDP on CSP block
│   ├── extractors.js      URL patterns, schema fingerprints, replay validation
│   ├── state-store.js     IndexedDB: rows/dedup, runs, log, extractor cache
│   ├── output-writer.js   TSV/CSV append-only writer (pure core is unit-tested)
│   ├── workspace.js       File System Access folder + the shared per-file write lock
│   ├── plan.js            Plan/runner pure logic (templates, rules, state machine)
│   ├── site-verification.js  Probe verdicts + stored-over-shipped config merge
│   └── ats-adapters.js    Greenhouse/Lever/Ashby/Workable JSON boards
├── agent/
│   └── parse.js           Parses and normalizes legacy JSON action responses
└── shared/
    ├── constants.js       API config, model list, limits, regexes
    └── site-configs.js    Per-site URL templates (human-edited data)
```

### How a turn works

1. **Observe** — one injection per step walks every frame and returns the accessibility
   tree, text, dialog state, control labels and checkbox state together. Every
   interactive element gets a stable id like `ref_12`.
2. **Think** — the panel sends the goal, history, and tree to the model. Requests try a
   streaming direct fetch, then a plain fetch, then the service-worker proxy, under one
   shared deadline.
3. **Act** — the model replies with a tool call naming a `ref_*`. BAT resolves the ref to
   a live element, scrolls it into view, moves the phantom cursor, and dispatches a
   trusted event through CDP.
4. **Repeat** — the loop observes again and continues until the goal is met, the step or
   token budget runs out, or you press Stop.

Element references are held as `WeakRef`s in a page-side map, so they don't leak memory
and go stale safely when the DOM changes — a stale ref returns an error telling the model
to re-read the page rather than clicking the wrong thing. The panel-side ref registry is
discarded on navigation, so a ref minted against the previous document can never resolve
against the new one.

### Tools available to the agent

| Category | Tools |
| --- | --- |
| Read | `read_page`, `get_page_text`, `find` |
| Interact | `left_click`, `form_input`, `type`, `press_key` |
| Move | `scroll`, `scroll_to`, `navigate`, `go_back`, `go_forward`, `refresh` |
| Tabs | `list_tabs`, `open_tab`, `switch_tab` |
| Escape hatches | `click_coords`, `run_javascript` (and `screenshot` when vision is on) |
| Files | `save_file`, `read_file`, `list_files`, `append_rows` |
| Data collection | `collect_rows`, `export_rows`, `data_report`, `record_not_found` |
| Bulk extraction | `extract_rows` (synthesize once, replay per page, validated, screened) |
| Background runs | `run_control` (create/start/pause/resume/status/sites/verify/mark_verified/report) |
| ATS boards | `ats_fetch` (Greenhouse/Lever/Ashby/Workable JSON, slug discovery) |
| Debug | `read_console`, `read_network` |
| Control | `wait`, `done` |

## Security model

Three independent boundaries, in the order an attack would meet them.

### 1. The allowlist — fails closed

`left_click`, `click_coords`, `form_input`, `type`, `press_key`, `run_javascript` and
`extract_rows` run **only** on approved origins. An empty allowlist permits none of them.
Reading, scrolling and navigating stay available so the agent can still tell you where it
is and ask to be let in.

Non-`http(s)` schemes — `chrome://`, `file://`, `data:`, `javascript:` — are refused
regardless of settings, including under *Allow all sites*: that toggle is consent about
**sites**, not about privileged surfaces.

An agent that can click can act on your behalf wherever you are logged in. Approve only
what you intend, and watch anything that spends money or sends messages.

### 2. Extractor screening — an extractor is a pure DOM reader

`extract_rows` runs **model-authored code** in the page, and on CSP-strict sites it runs
via CDP in the page's own realm with the page's CSP bypassed. The model writes that code
from page markup, which is attacker-controlled. Passing validation proves the code
returned tidy rows; it does not prove the code only *read* the page.

So every extractor is screened before it is executed or cached. Network access
(`fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`), credential surfaces
(`document.cookie`, `localStorage`, `indexedDB`, `caches`), dynamic code (`eval`,
`Function(...)` with or without `new`, `import()`), extension APIs, timers, navigation and
page mutation are all refused — along with the general escape routes a keyword list can't
name one spelling at a time: `.constructor` (the standard prototype-chain path to
`Function` that never spells "Function" or "eval"), and bare `this` (a function compiled
this way and called with no receiver runs with `this` bound to the global object, handing
over `fetch`/`document`/`eval` without naming any of them). Screening happens in the
panel, in the runner, and again inside `runExtractor` itself. Rejected source is shown to
you in full.

This is still a denylist over source text, not a sandbox — it raises the cost of an
injected extractor and makes the attempt visible, it does not prove containment. The
allowlist above it is the real boundary.

### 3. Redaction — before anything leaves the browser

The accessibility tree reports `[value redacted]` for password, hidden, one-time-code
and payment-autocomplete fields. Extractor synthesis uploads page markup to the model, so
that markup is run through the same policy first (`redactMarkup`) — otherwise the tree's
careful redaction would be trivially bypassed by the synthesis path.

The policy lives in `src/lib/redaction.js`, is unit-tested there, and the content script
carries a mirrored copy (it cannot import ESM). A test asserts the mirror has not drifted.

### Other notes

- **Your key stays local.** It lives in `chrome.storage.local` and is sent only to the
  DeepSeek API. `DEEPSEEK_DEFAULT_KEY` in `src/shared/constants.js` must stay empty —
  never commit a real key. The debug export masks it.
- **`web_accessible_resources` is not hand-declared.** The manifest used to expose
  `assets/*` to `<all_urls>`, which published the entire build to every page and made the
  extension trivially fingerprintable. The declaration is now omitted entirely and crxjs
  emits an exact entry per content script — two specific hashed files, no wildcard.

## Permissions

The manifest requests broad permissions because a general-purpose browser agent needs
them. Concretely:

| Permission | Why |
| --- | --- |
| `debugger` | Dispatch trusted input via CDP. Chrome shows a banner while attached. |
| `<all_urls>` | Operate on whatever page you point it at — gated by the allowlist. |
| `tabs`, `webNavigation` | Track navigation so the loop knows when a page settled, and compute cross-frame coordinate offsets. |
| `scripting` | Inject the page-reading helpers. |
| `storage` | Persist your API key, model choice, allowlist, verification state, and session. |
| `alarms` | The 30s watchdog that revives a background run after worker eviction. |
| `sidePanel`, `activeTab` | Host the UI. |

The `debugger` permission is what makes trusted input possible, and it's also why Chrome
displays a "BAT started debugging this browser" banner while the agent is running. That
banner is expected.

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
- **Site URL templates rot, and only a browser can tell you.** Two of the shipped
  templates were already dead (404), and every Irish job site tested is either a
  JS-rendered shell or actively anti-bot to plain HTTP. Every template therefore ships
  `verified: false`. Use `run_control {action:"verify"}` before building a run on one: it
  loads page 1, rejects error pages and empty JS shells, and catches the silent killer —
  a redirect that drops the query string, which would make every "page 2" return page 1.
  A template that merely *loads* is still not verified until `extract_rows` returns rows.
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

## Manual verification

Most invariants are covered by `npm test`. These are the ones that genuinely require a
browser, a real folder, or a real site.

<details>
<summary>File persistence</summary>

1. Build, load `dist/`, open the panel, and pick a folder under **Settings (⚙) →
   Workspace folder**.
2. Ask: *"Append three test rows (name, value) to test.tsv using append_rows."*
3. Close the side panel entirely, reopen it, and ask: *"Append two more rows to
   test.tsv and tell me the row count."*
4. Open `test.tsv`: one header line, five data rows in order, and the agent's reported
   count says 5. A cell containing tabs, quotes, or newlines must not break the column
   alignment. (The formatting rules themselves are unit-tested; this checks the real
   File System Access round-trip.)
</details>

<details>
<summary>The allowlist actually blocks</summary>

1. On a fresh profile, with no sites approved, ask the agent to click something.
2. It must refuse, name the host, and tell you about the **Allow \<site\>** button —
   and the activity feed shows *Blocked by allowlist*.
3. Click **Allow \<site\>**, ask again: it proceeds.
</details>

<details>
<summary>Extractor screening</summary>

1. Ask: *"Call extract_rows with function_source that returns
   `[{Title: document.cookie}]`."*
2. It must be **rejected and not cached**, with `credential access (document.cookie)` as
   the reason and the rejected source shown in full.
</details>

<details>
<summary>The background runner survives</summary>

1. Verify a template first (`run_control {action:"verify", …}`), then plan a small run
   (2 units × 2–3 pages) and confirm it.
2. Close the side panel entirely. The run keeps going (toolbar badge `▶`, output file
   growing).
3. Kill the worker mid-run (`chrome://serviceworker-internals` → stop, or wait for
   eviction). Within ~30s the watchdog revives it and the run continues from the last
   checkpointed page — reopen the panel and ask for *"run status"*: no duplicated rows,
   no lost position.
4. Point a unit at a page with a login wall or CAPTCHA: the run parks as AWAITING_HUMAN
   with a `!` badge. Clear it in the run's tab, say *"resume the run"* — it re-enters at
   the exact page that was interrupted.
</details>

<details>
<summary>ATS adapters</summary>

1. Ask: *"ats_fetch the greenhouse board for stripe"* — a real board comes back in
   seconds with Title/Company/Location/Posted/URL rows.
2. Ask for a company that doesn't exist — the reply is NOT-FOUND with the slug variants
   that were tried.

(`npm run test:live` automates both.)
</details>

## License

[MIT](LICENSE)
