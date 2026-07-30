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
// only refuse spellings it was told about. Two rules below (`.constructor` and
// bare `this`) exist specifically to close the general escape routes rather
// than one keyword at a time: `(fn).constructor` reaches the Function
// constructor without ever naming "Function" or "eval", and a function built
// by `new Function(src)` and invoked with no receiver (exactly how
// extractInPage calls it) runs with `this` bound to the global object, so bare
// `this` hands over fetch/document/eval with no banned identifier in sight.
// Closing both still leaves this a denylist, not a proof of containment — the
// allowlist above it is the real boundary (see SECURITY.md).
const DENIED = [
  { re: /\bfetch\s*\(/,                          why: 'network access (fetch)' },
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
  { re: /\b(?:window|self|globalThis|top|parent|frames)\s*\[/, why: 'dynamic property access on a global object (bracket notation)' },
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
  { re: /\.\s*(?:click|submit)\s*\(/,            why: 'page interaction — an extractor reads, it does not act' },
  { re: /\bwindow\s*\.\s*(?:open|location)\b/,   why: 'navigation (window.open / window.location)' },
  { re: /\blocation\s*\.\s*(?:href|assign|replace)\s*=?/, why: 'navigation (location.href)' },
  { re: /\bdebugger\b/,                          why: 'debugger statement' }
];

const MAX_SOURCE_CHARS = 20000;

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
  if (hits.length) {
    return { ok: false, reason: [...new Set(hits)].join('; ') };
  }
  return { ok: true };
}

// Exported for the test suite so the policy itself is assertable.
export const DENIED_REASONS = DENIED.map((d) => d.why);
