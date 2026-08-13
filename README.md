# BAT — Browser Automation Tool

A Chrome extension (Manifest V3) that runs a browser automation agent in the side panel. It reads pages through an accessibility tree, reasons over them with DeepSeek, and drives them with native tool calls — click, type, navigate, extract, collect.

## How it works

A content script serializes every page into a structured **PAGE REPORT** (accessibility tree + visible text + checkboxes + JSON-LD product data), tagging every interactive element with a stable `[ref_N]` handle. The side panel sends that report and the conversation to DeepSeek, which replies with native tool calls executed against the page via `chrome.scripting` and `chrome.debugger`. Collected data is deduplicated into IndexedDB and projected to TSV/CSV, on disk (if you pick a workspace folder) or in embedded storage (zero setup). A separate service-worker runner can walk a multi-page collection job page-by-page in the background, checkpointing after every page so it survives panel close and browser restart.

## What it does

- **Reads pages for the model** — one clean PAGE REPORT any model can act on reliably, instead of raw HTML.
- **Drives the browser with native tools** — `left_click`, `type`, `form_input`, `navigate`, `scroll`, `run_javascript`, `get_links`, and more.
- **Collects data to files** — dedup store → TSV/CSV, with `give_file` to hand a file to the user right in the chat.
- **Runs background collection plans** — a service-worker runner with cached extractors, per-page checkpoints, and resume after eviction or restart.
- **Keeps the agent on track** — a working checklist (`set_checklist`) plus a per-run event log, injected into context every turn.
- **Persists your work** — chat history and collected data survive panel close and browser shutdown.

## Setup

1. `npm install && npm run build`
2. `chrome://extensions` → Developer mode → **Load unpacked** → select the `dist/` folder (or the project root for unbuilt dev files).
3. Open the BAT side panel, click ⚙, and set your DeepSeek API key (`sk-...`).
4. Optionally pick a workspace folder so collected files land on disk; otherwise they stay in embedded storage.

## Development

```
npm install
npm run dev          # vite dev server
npm run build         # production build → dist/
npm test              # offline unit tests (677)
npm run lint          # eslint
npm run check          # lint + test + build
```

## Structure

```
src/
  background/        service worker: DeepSeek proxy + background plan runner
  content/           accessibility-tree serializer + phantom-cursor overlay
  lib/               shared logic: tools, extractor safety screen, workspace, store, redaction
  sidepanel/         the panel: chat UI, agent loop, DeepSeek transport, prompt
  shared/            constants + site configs
  agent/             JSON tool-call fallback parser — activates live if the model rejects
                      native tool calls; not legacy/dead code
test/                offline unit tests
```

## Security model

- **Site allowlist** gates any page-changing tool. A fresh install defaults to allow-all; the moment you save an allowlist choice, it fails closed to approved sites only.
- **Two-layer safety screen** (regex denylist + AST alias tracking) reviews all model-authored code — `run_javascript` calls and synthesized data extractors — before it can run in the page, blocking network access, storage access, DOM-insertion exfiltration, and navigation hijacks.
- **Regex guard** validates any model- or plan-authored regular expression against catastrophic backtracking before it's compiled.
- **Redaction** strips password/OTP/card fields and their values — by type, autocomplete token, and name/id pattern — from everything the model sees or that gets uploaded for extractor synthesis.

## License

MIT — see [LICENSE](LICENSE).
