// Safety screen for model-authored extractor source.
//
// Why this exists: an extractor is written BY the model FROM page markup, and
// page markup is attacker-controlled. The CDP path deliberately bypasses the
// page's CSP (that is the point — the sites worth scraping forbid eval), so the
// synthesized function runs in the page's own realm with the page's origin. A
// prompt-injected extractor could therefore read document.cookie or localStorage
// and POST it anywhere, and nothing downstream would notice: it would still
// return well-formed rows and pass every validity check in extractors.js.
//
// So: an extractor is a pure DOM READER. It may walk the document and return
// strings. It may not talk to the network, touch credential storage, schedule
// work, or reach for new code. Anything else is a bug or an attack, and in both
// cases refusing is correct — the failure mode of a false positive is "the model
// writes a simpler extractor", which is cheap.

// Matched against source with string literals and comments still intact. That is
// intentional: a denied token appearing inside a string is itself suspicious
// enough to re-synthesize over, and stripping literals first would just move the
// arms race into the stripper.
//
// A token denylist over source text is fundamentally not a sandbox — it can
// only refuse spellings it was told about. Several rules below (`.constructor`,
// bare `this`, `Reflect`, `getOwnPropertyDescriptor`) exist specifically to
// close general escape routes rather than one keyword at a time: `(fn).
// constructor` reaches the Function constructor without ever naming
// "Function" or "eval"; a function built by `new Function(src)` and invoked
// with no receiver (exactly how extractInPage calls it) runs with `this`
// bound to the global object; and Reflect/getOwnPropertyDescriptor retrieve a
// named global property (e.g. "fetch") without ever writing `.fetch` or
// `["fetch"]` in a form any dot/bracket rule would see.
//
// `screenExtractorSourceAst` (extractor-ast-screen.js) runs right after this
// text pass and closes the aliasing hole this one cannot: it parses the
// source and tracks, by actual assignment/destructuring/parameter binding,
// which local names become aliases of a dangerous global or capability, so
// `var w = window; w.fetch(...)` (invisible to any text-based rule below) is
// caught the same as `window.fetch(...)` would be — including through
// renaming destructuring (`var {fetch: f} = window`) and enumeration of a
// TRACKED alias (`Object.values(w)` once `w` is known to be `window`).
//
// KNOWN REMAINING GAP, stated plainly rather than papered over: the AST pass
// tracks specific, common binding shapes (var/let/const, `=`, destructuring,
// IIFE parameters) — it is not a full points-to analysis. A reference stashed
// somewhere it doesn't model — an arbitrary object-literal field
// (`{w: window}` — "w" isn't a name the analysis knows to treat as
// window-valued), a Map/Set, a value threaded through a separately-declared
// named function rather than an inline IIFE, a Promise, a getter, a Proxy —
// still escapes undetected. Closing THAT fully needs either a real points-to
// analysis (tracks values through arbitrary containers, not just variable
// bindings) or running the extractor somewhere `fetch`/`document` are not
// reachable at all — not another regex, and not more special-cased AST
// shapes either, which is why this file stops adding those and says so.
// Until one of those larger changes lands, treat both screens together as
// raising the cost of an attack and making it visible, never as proof of
// containment. The allowlist above it is the real boundary.
import { screenExtractorSourceAst } from './extractor-ast-screen.js';

const DENIED = [
  { re: /\bfetch\s*\(/,                          why: 'network access (fetch)' },
  { re: /\b(?:fetch|eval|Function|setTimeout|setInterval)\s*`/, why: 'tagged template invocation (no-paren call)' },
  { re: /\bXMLHttpRequest\b/,                    why: 'network access (XMLHttpRequest)' },
  { re: /\bWebSocket\b/,                         why: 'network access (WebSocket)' },
  { re: /\bEventSource\b/,                       why: 'network access (EventSource)' },
  { re: /\bnavigator\s*\.\s*sendBeacon\b/,       why: 'network access (sendBeacon)' },
  { re: /\bimport\s*\(/,                         why: 'dynamic code loading (import())' },
  { re: /\bimportScripts\b/,                     why: 'dynamic code loading (importScripts)' },
  // Bare `Function(...)` constructs a function exactly like `new Function(...)`
  // does — the `new` keyword is optional in JS, so requiring it here let
  // `Function("return fetch")()` sail straight through. Match the call, not the
  // keyword.
  { re: /\bFunction\s*\(/,                       why: 'dynamic code generation (Function constructor)' },
  // Matching only "not preceded by a dot" was meant to spare a custom object's
  // own `.evaluate()`/`.eval()` method, but it also exempted `window.eval(...)`
  // — which IS the global eval, reachable through the one alias this rule
  // happened to whitelist. There is no legitimate reason a DOM-reading
  // extractor calls anything named eval, dotted or not.
  { re: /\beval\s*\(/,                           why: 'dynamic code evaluation (eval)' },
  // `(fn).constructor` (→ Function) and `(fn).constructor.constructor` are the
  // standard prototype-chain routes to the Function constructor that never
  // spell "Function" or "eval" at all. An extractor has no legitimate reason
  // to touch .constructor.
  { re: /\.\s*constructor\b/,                    why: 'prototype-chain access (.constructor) — a common sandbox-escape route' },
  // A function compiled via new Function()/Function() and invoked with no
  // receiver (exactly how extractInPage calls it) runs with `this` bound to
  // the global object — so bare `this` hands over fetch/document/eval etc.
  // without naming any of them. An extractor takes no arguments and has no
  // receiver, so it never legitimately needs `this`.
  { re: /\bthis\b/,                              why: 'reference to `this` — resolves to the global object here and is not needed to read the DOM' },
  // Escaping identifier-based matching by indexing the global object
  // dynamically, e.g. window['fetch'] or self['ev'+'al'].
  { re: /\b(?:window|self|globalThis|top|parent|frames|document)\s*\[/, why: 'dynamic property access on a global object (bracket notation)' },
  // Reflect.get(globalThis, "fetch") and
  // Object.getOwnPropertyDescriptor(globalThis, "fetch").value retrieve a
  // named global property without ever writing `globalThis.fetch` or
  // `globalThis["fetch"]` — neither the dot form nor the bracket-notation
  // rule above sees them. No legitimate DOM-reading extractor needs either.
  { re: /\bReflect\b/,                            why: 'reflection API access (Reflect.*) — can retrieve arbitrary globals by name' },
  { re: /\bgetOwnPropertyDescriptors?\b/,         why: 'property descriptor introspection — can retrieve arbitrary globals by name' },
  { re: /\bdocument\s*\.\s*cookie\b/,            why: 'credential access (document.cookie)' },
  { re: /\b(?:local|session)Storage\b/,           why: 'credential access (web storage)' },
  { re: /\bindexedDB\b/,                         why: 'credential access (IndexedDB)' },
  { re: /\bcaches\b\s*\./,                       why: 'credential access (CacheStorage)' },
  { re: /\bnavigator\s*\.\s*credentials\b/,      why: 'credential access (Credential Management)' },
  { re: /\bchrome\s*\.\s*\w+/,                   why: 'extension API access (chrome.*)' },
  { re: /\bpostMessage\s*\(/,                    why: 'cross-context messaging (postMessage)' },
  { re: /\bset(?:Timeout|Interval)\s*\(/,        why: 'deferred execution (timers) — extractors must be synchronous' },
  { re: /\brequestIdleCallback\s*\(/,            why: 'deferred execution (requestIdleCallback)' },
  { re: /\bWorker\s*\(/,                         why: 'background execution (Worker)' },
  { re: /\bdocument\s*\.\s*write\b/,             why: 'page mutation (document.write)' },
  { re: /\.\s*(?:click|submit|requestSubmit)\s*\(/, why: 'page interaction — an extractor reads, it does not act' },
  { re: /\bwindow\s*\.\s*(?:open|location)\b/,   why: 'navigation (window.open / window.location)' },
  // Navigation via the call form, not just the assignment form. The old rule
  // required `location.href/assign/replace =` (an assignment); `location.replace(u)`
  // and `location.assign(u)` are the CALL form and sailed straight through, as
  // did `document.location = u` and bare `location = u`. An extractor must never
  // navigate anywhere — a redirect is also a phishing/exfil channel.
  { re: /\blocation\s*\.\s*(?:href|assign|replace)\s*(?:=|\(|=)/, why: 'navigation (location.href/assign/replace)' },
  { re: /\b(?:document\.)?location\s*[=;]/,      why: 'navigation (location assignment)' },
  { re: /\bhistory\s*\.\s*(?:back|go|forward|replaceState|pushState)\s*\(/, why: 'navigation (history API)' },
  { re: /\bopen\s*\(/,                           why: 'navigation (bare window.open)' },
  // DOM insertion is the network-exfiltrating escape route: a created element
  // with .src/.href/.innerHTML and appendChild loads a remote script/image with
  // the page's origin, or reflects page text to an attacker URL. Both screens
  // enforce "an extractor reads, it does not act"; element creation is acting.
  { re: /\bcreateElement\b/,                     why: 'DOM construction (createElement) — can load remote resources via .src/.href' },
  { re: /\.\s*(?:append|appendChild|insertBefore|insertAdjacentHTML|prepend|after|before|replaceWith)\s*\(/, why: 'DOM mutation (element insertion)' },
  { re: /\binnerHTML\b/,                         why: 'DOM mutation (innerHTML)' },
  { re: /\.\s*textContent\s*=/,                  why: 'DOM mutation (textContent assignment)' },
  { re: /\bqueueMicrotask\s*\(/,                 why: 'deferred execution (queueMicrotask) — extractors must be synchronous' },
  { re: /\bdebugger\b/,                          why: 'debugger statement' }
];

const MAX_SOURCE_CHARS = 20000;

// The model is told to write "a JS function BODY" but sometimes wraps it in
// `function() { ... }` or markdown fences. Strip those so screening and
// execution see the raw body — the model pays for the turn regardless.
//
// The closing brace is only ever stripped when the matching opening wrapper was
// actually found. A bare function body legitimately ends in `}` (most do —
// `return { ... }`), and stripping it unconditionally turned every such body
// into unbalanced source that the AST screen then rejected as "not valid
// JavaScript", so the model's first attempt always failed with a confusing
// reason and it burned a whole turn re-writing what was already correct.
export function normalizeExtractorSource(src) {
  let s = String(src || '').trim();
  // Markdown fences
  s = s.replace(/^```(?:javascript|js)?\s*\n?/i, '').replace(/\n?\s*```\s*$/i, '');
  // function() { ... } wrapper with optional name — strip both sides ONLY
  // together, so a bare body ending in `}` is never truncated.
  const fnMatch = s.match(/^(?:async\s+)?function\s*(?:\w+\s*)?\s*\(\s*\)\s*\{/);
  if (fnMatch && fnMatch[0].length < s.length) {
    const open = fnMatch[0];
    let rest = s.slice(open.length);
    // Only strip the trailing brace if one is actually there to close the
    // wrapper. A body whose trailing expression ends in `}` (e.g.
    // `return { ... }`) keeps that brace — it closes the expression, not the
    // wrapper.
    if (/\}\s*$/.test(rest)) {
      rest = rest.replace(/\}\s*$/, '');
      s = rest;
    }
  }
  // arrow function wrapper: () => { ... } — same pairing rule.
  const arrowMatch = s.match(/^\(\)\s*=>\s*\{/);
  if (arrowMatch && arrowMatch[0].length < s.length) {
    const rest = s.slice(arrowMatch[0].length);
    if (/\}\s*$/.test(rest)) {
      s = rest.replace(/\}\s*$/, '');
    }
  }
  return s.trim();
}

// Returns { ok:true } or { ok:false, reason } — never throws, so a screen
// failure can never be the thing that breaks a run.
export function screenExtractorSource(src) {
  // Reject non-strings outright rather than coercing: String({}) is
  // "[object Object]", which contains no denied token and would have PASSED the
  // screen before failing confusingly later at compile time.
  if (typeof src !== 'string') {
    return { ok: false, reason: `source must be a string, got ${src === null ? 'null' : typeof src}` };
  }
  const s = src;
  if (!s.trim()) return { ok: false, reason: 'empty source' };
  if (s.length > MAX_SOURCE_CHARS) {
    return { ok: false, reason: `source is ${s.length} chars (limit ${MAX_SOURCE_CHARS}) — an extractor this large is not a row reader` };
  }
  const hits = [];
  for (const rule of DENIED) {
    try {
      if (rule.re.test(s)) hits.push(rule.why);
    } catch { /* a broken rule must not fail the screen */ }
  }

  // Second, independent pass: real identifier/alias tracking over the actual
  // parsed AST, not text. The regex pass above can only refuse spellings it
  // was told about — `var w = window; w.fetch(...)` reads as ordinary
  // identifier use to a text matcher. See extractor-ast-screen.js for why
  // this exists and what it still can't catch (fully dynamic discovery, e.g.
  // enumerating a global's properties by predicate rather than by name).
  // A failure IN the analysis itself (not a rejection FROM it — an unexpected
  // exception) fails CLOSED: this is a security screen, so "the check broke"
  // must reject, not silently pass whatever text showed up.
  let astResult;
  try {
    astResult = screenExtractorSourceAst(s);
  } catch (e) {
    astResult = { ok: false, reason: `AST safety check failed to run: ${e.message}` };
  }
  if (!astResult.ok) hits.push(astResult.reason);

  if (hits.length) {
    return { ok: false, reason: [...new Set(hits)].join('; ') };
  }
  return { ok: true };
}

// Exported for the test suite so the policy itself is assertable.
export const DENIED_REASONS = DENIED.map((d) => d.why);
