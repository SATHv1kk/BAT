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
```

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
| Debug | `read_console`, `read_network` |
| Control | `wait`, `done` |

The escape hatches matter for pages the accessibility tree can't describe. Canvas-rendered
content has no meaningful DOM, so BAT falls back to `screenshot` plus `click_coords` to
work by sight, and `run_javascript` to read state the tree misses.

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
