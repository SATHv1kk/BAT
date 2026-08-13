# BAT — Browser Automation Tool

Static GitHub Pages home for the **BAT** Chrome extension (Manifest V3): a browser
automation agent that runs in the side panel, reads any page through an accessibility
tree, reasons over it with DeepSeek, and drives the browser with ~30 native tool calls.

**Live site:** https://sathv1kk.github.io/BAT/

## The project

BAT is built for one thing: getting a capable model to do real work in a real
browser — clicking, typing, navigating, answering course quizzes, and bulk-collecting
structured data into TSV/CSV files.

- **Reads pages for the model** — every frame is serialized (at `document_start`)
  into a fenced PAGE REPORT: accessibility tree with live `[ref_N]` handles, page text,
  checkbox state, and JSON-LD product data. No screenshots, no guessing.
- **Drives the browser natively** — ~30 tools executed via CDP + the scripting API:
  `left_click`, `type`, `form_input`, `navigate`, `scroll`, `run_javascript`,
  `get_links`, `find`, and more.
- **Collects data to files** — an IndexedDB dedup store (first row wins, duplicate
  sources merge) feeds TSV/CSV into one fixed workspace: a pinned on-disk folder or
  embedded storage. `give_file` hands the result into the chat.
- **Runs in the background** — a service-worker plan runner walks page-by-page with
  cached extractors (zero model calls per page), checkpoints after every page, and
  survives panel close and browser restart.
- **Keeps itself on track** — a model-maintained checklist plus a per-run event log
  injected into context every turn.
- **Whole job boards via ATS** — Greenhouse, Lever, Ashby and Workable public JSON
  APIs in one HTTP call, with slug identity verification.

## Security

Model-authored code (extractors, `run_javascript`) is treated as untrusted:

- **Two-layer safety screen** — a regex denylist plus AST alias tracking (acorn)
  before code runs in the page realm.
- **Sensitive-value redaction** — password/OTP/card fields caught by type,
  autocomplete token, name and id; redacted before upload.
- **Site allowlist** — page-changing tools fail closed; allow-all is an explicit
  opt-in; redirects off-list stop a run.
- **Guarded regexes** — model-authored patterns are analyzed for catastrophic
  backtracking before compile.

## Development

This repo is pure static HTML/CSS/JS — no build step. Open `index.html` in a browser,
or just push to `main` and GitHub Pages serves it.

```
index.html           the whole site (single page, inline CSS + JS)
assets/bat-icon.svg  icon / favicon
```

## License

MIT
