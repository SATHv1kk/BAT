# Security model

BAT is a browser agent holding `debugger` and `<all_urls>` in a browser that is already
logged into your accounts. That is a large amount of authority, so it is worth being
precise about what protects what — and what does not.

## Threat model

**In scope**

1. **A malicious or compromised page.** Page content reaches the model on every turn.
   A page can attempt prompt injection: instructions in markup, hidden text, or fake
   "system" messages trying to redirect the agent, exfiltrate data, or get code run.
2. **A model that goes wrong.** Whether adversarially steered or simply mistaken, the
   model can emit a tool call that acts on the wrong element, the wrong site, or writes
   code that does more than it should.
3. **Accidental data egress.** Page content is uploaded to a third-party API. Anything
   visible in the DOM — including filled form fields on a logged-in page — could leave
   the browser unless something stops it.

**Out of scope**

- A compromised local machine or browser profile. The API key is in
  `chrome.storage.local` in plaintext; anything with disk access can read it, and no
  in-extension measure changes that.
- The upstream model provider's handling of data you send it.
- A malicious build of the extension itself.

## Boundaries

### 1. The allowlist (authority)

Page-changing tools — `left_click`, `click_coords`, `form_input`, `type`, `press_key`,
`run_javascript`, `extract_rows` — run only on origins you have approved. **An empty
allowlist permits none of them**, and empty is the default on a fresh install.

Reading, scrolling and navigating remain available on any site, deliberately: the agent
must be able to tell you where it is and ask to be let in, rather than failing opaquely.

Non-`http(s)` schemes (`chrome://`, `file://`, `data:`, `javascript:`) are refused
regardless of settings, **including** under *Allow all sites* — that toggle is consent
about sites, not about privileged browser surfaces.

Enforced in `src/lib/allowlist.js`, shared by the panel and the background runner, with the
decision function unit-tested in `test/allowlist.test.mjs`.

> Understand the residual risk: approving a site where you are signed in authorizes the
> agent to act **as you** on that site. The allowlist limits *where*, not *what*.

### 2. Extractor screening (code execution)

`extract_rows` is the one place model-authored code becomes running code. On CSP-strict
sites it runs through CDP in the page's own realm, which bypasses the page's CSP by
design — those are the sites the feature exists for.

The code is written by the model *from page markup*, so injection reaches it directly. And
the existing validity checks cannot help: an extractor that steals a cookie and also
returns tidy rows passes every one of them.

`src/lib/extractor-screen.js` therefore requires an extractor to be a pure, synchronous
DOM reader, checked by TWO independent layers run together — a text-based denylist, and a
real static analysis over the parsed AST (`src/lib/extractor-ast-screen.js`) that tracks
which local names become aliases of a dangerous global through actual assignment,
destructuring, or parameter binding. The AST layer exists because the text layer can only
refuse spellings it was told about: `var w = window; w.fetch(...)` reads as ordinary
identifier use to anything matching text, but the AST layer knows `w` IS `window` and
flags it the same as `window.fetch(...)`. Together they refuse:

| Refused | Examples |
| --- | --- |
| Network egress | `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon` |
| Credential surfaces | `document.cookie`, `localStorage`, `sessionStorage`, `indexedDB`, `caches`, `navigator.credentials` |
| Dynamic code | `eval` (including `window.eval`), `Function(...)` (with or without `new`), `import()`, `importScripts` |
| Prototype-chain / receiver escapes | `.constructor` (the standard non-keyword route to `Function`), bare `this` (a function built this way and called with no receiver runs with `this` bound to the global object) |
| Dynamic global access | bracket/computed access on `window`/`self`/`globalThis`/`top`/`parent`/`frames`, plus `Reflect.*` and `getOwnPropertyDescriptor(s)` (both retrieve a named global, e.g. `Reflect.get(globalThis, "fetch")`, without ever writing `.fetch` or `["fetch"]`) |
| Extension APIs | any `chrome.*` |
| Deferred execution | `setTimeout`, `setInterval`, `requestIdleCallback`, `Worker` |
| Acting, not reading | `.click()`, `.submit()`, `window.open`, `location.href =`, `document.write`, `postMessage` |

Screening runs in the panel, in the runner, and again inside `runExtractor` — three call
sites, one policy (both layers), so no path can skip it. Rejected source is surfaced to
you in full and logged. Covered by `test/extractor-screen.test.mjs` and
`test/extractor-ast-screen.test.mjs`.

The "prototype-chain / receiver escapes" and "dynamic global access" rows exist because a
keyword denylist can't be closed one spelling at a time: `(fn).constructor` reaches
`Function` without ever containing the text "Function" or "eval", and a function compiled
by `new Function(src)`/`Function(src)` and invoked with no receiver — exactly how the
extractor runner calls it — has `this` bound to the global object, so bare `this` reaches
`fetch`/`document`/`eval` without naming any of them. The AST layer closes the same class
of hole one level further: it resolves `var w = window; w["fetch"](...)`,
`var {fetch: f} = window; f(...)`, `var [w] = [window]; w.fetch(...)`, and
`(function(w){ Object.values(w) })(window)` back to what they actually reach, across
chained aliases (`var a=window; var b=a; var c=b.fetch;`), not just the literal spellings
the text layer matches.

**Known remaining gap, stated plainly rather than papered over:** the AST layer tracks
specific, common binding shapes — variable declaration, plain `=` assignment,
destructuring, and inline-function (IIFE) parameters — it is not a full points-to
analysis. A global reference stashed somewhere outside those shapes still escapes both
layers: an arbitrary object-literal field (`{w: window}` — "w" isn't a name either screen
knows to treat as window-valued), a value threaded through a separately-declared named
function rather than an inline IIFE, a `Map`/`Set`, a `Promise`, a getter, a `Proxy`. Fully
closing that needs a real points-to analysis (tracing values through arbitrary containers,
not just variable bindings) or running the extractor somewhere `fetch`/`document` are not
reachable at all — not another regex, and not more special-cased AST shapes either, which
is why this file stops adding those here rather than chasing an unbounded list. Until one
of those larger changes lands, treat this screening as raising the cost of an attack and
making it visible, never as proof of containment.

This is a denylist, and a denylist over source text is not a sandbox. It raises the cost of
an injected extractor substantially and makes the attempt visible; it is not a proof of
containment. The real containment is the allowlist above it.

### 3. Regex denial-of-service (self-inflicted hang)

A different kind of model-supplied input compiles into a `RegExp`: `run_control` plan
rules (`rule.matches`, `stop_when.matches`), `ats_fetch`'s `location_filter`, and
`read_console`/`read_network`'s `pattern`/`filter`. All four are tested against
page-or-API-derived strings. V8 has no built-in protection against catastrophic
backtracking, and JavaScript cannot interrupt a synchronous `RegExp.test()` call once it
starts — a single pattern shaped like `(a+)+` hung for more than 5 seconds against a
35-character input in testing. Run from `plan.js` (shared with the background runner),
that is a hang of the whole extension, not one tool call, and per the threat model above
("a model that goes wrong") an arbitrary model-authored pattern is not automatically
trustworthy input.

`src/lib/regex-guard.js` gates every one of those five call sites through a real AST-based
safety check (`safe-regex`, backed by `regexp-tree`) before compiling. It is tuned against
this project's own built-in date-filtering patterns (`STOP_PATTERNS` in `plan.js`) so a
legitimate, already-shipped feature doesn't get rejected as collateral damage.

**Known gap:** the check catches the classic nested-quantifier shape, which is the large
majority of real-world ReDoS reports, but not every catastrophic shape — alternation-based
blowup (`(a|a)*`) is not caught, and an input-length cap doesn't meaningfully help either
(the blowup is steep enough at well under 30 characters that a cap tight enough to matter
would reject ordinary inputs). Fully closing this needs a hard execution timeout — running
the match in a Worker and terminating it on overrun — which turns every call site async;
not done here. Tested and documented as a known gap in `test/regex-guard.test.mjs` rather
than silently relied upon.

### 4. Redaction (data egress)

The accessibility tree never reports the value of a password, hidden, one-time-code, or
payment-autocomplete field — it emits `[value redacted]`.

Extractor synthesis uploads page markup to the model, which would have walked straight
around that. So markup is passed through the same policy (`redactMarkup`) **before** it is
truncated and sent, in `src/background/runner.js`.

One policy, in `src/lib/redaction.js`, unit-tested in `test/redaction.test.mjs`. The
content script carries a mirrored copy because it cannot import ES modules; a test asserts
the mirror has not drifted.

## Other measures

- **`web_accessible_resources`** is no longer hand-declared. It previously exposed
  `assets/*` to `<all_urls>` — the whole build, readable by any page, which also makes the
  extension trivially fingerprintable. The source manifest now omits it and crxjs emits
  one exact entry per content script (two specific hashed files, no wildcard).
- **The system prompt** tells the model that all page content is untrusted data and never
  instructions. That is a mitigation, not a control — it reduces incidence, it does not
  bound behaviour. The layers above do not depend on the model complying.
- **The extension CSP** restricts `connect-src` to the API host.
- **`DEEPSEEK_DEFAULT_KEY`** must remain empty in the repository. The debug export masks
  the key.
- **File storage defaults to embedded (IndexedDB), not a real folder.** `save_file`/
  `read_file`/`list_files`/`append_rows` write into `src/lib/embedded-storage.js` unless
  the user has explicitly granted a real on-disk folder in Settings — meaning by default
  the agent has no filesystem reach at all beyond the extension's own private storage,
  which is already inaccessible to any page or other extension. Granting a real folder is
  an opt-in, narrower-scoped (limited to that one folder) upgrade, never a requirement.

## Reporting a vulnerability

Open an issue at <https://github.com/SATHv1kk/BAT/issues>. For something you believe is
sensitive, say so in the issue without the details and a private channel can be arranged.

Please include the extension version (`src/manifest.json`), the browser version, and a
minimal reproduction. A page that demonstrates an injection reaching a tool call is
especially useful.
