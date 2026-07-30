// Extractor execution — ONE implementation shared by the side panel and the
// service-worker runner (this is the most security-sensitive code in the
// project; two copies would drift).
//
// Two execution paths, in order:
//   1. chrome.scripting.executeScript into the ISOLATED world, compiling the
//      source with new Function(). Fast, no debugger banner.
//   2. CDP Runtime.evaluate via chrome.debugger. Compilation inside the page's
//      own realm is subject to the PAGE's CSP: sites that forbid unsafe-eval
//      (LinkedIn, Indeed, Glassdoor and friends) break path 1, and those are
//      exactly the sites BAT exists for. CDP ignores page CSP, so it is the
//      fallback rather than the default — used only when path 1 reports an
//      eval/CSP failure.
//
// Both paths return the same shape: { ok, rows, pageTextLen, error?, via }.

const MAX_ROWS = 2000;
const EVAL_BLOCKED_RE = /content security policy|unsafe-eval|evalerror|blocked|refused to evaluate|csp/i;

// Runs IN the page. Kept as a standalone function so both paths inject the
// identical logic and the row sanitation cannot diverge.
function extractInPage(src, maxRows) {
  const pageTextLen = (document.body && document.body.innerText || '').length;
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(src);
    const out = fn();
    if (!Array.isArray(out)) {
      return { ok: false, error: 'extractor must return an array of row objects', rows: [], pageTextLen };
    }
    const rows = [];
    for (const r of out.slice(0, maxRows)) {
      if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
      const clean = {};
      for (const k of Object.keys(r)) {
        const v = r[k];
        if (typeof v === 'string') clean[k] = v;
        else if (typeof v === 'number' || typeof v === 'boolean') clean[k] = String(v);
        else clean[k] = '';
      }
      rows.push(clean);
    }
    return { ok: true, rows, pageTextLen };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), rows: [], pageTextLen };
  }
}

async function viaScripting(tabId, source) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func: extractInPage,
    args: [source, MAX_ROWS]
  });
  return res?.result || { ok: false, error: 'no result from page', rows: [], pageTextLen: 0 };
}

// Attach tolerantly: another debugger (DevTools) or our own panel session may
// already own the tab. Only detach what WE attached.
async function withDebugger(tabId, fn) {
  let owned = false;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    owned = true;
  } catch (e) {
    if (!/already attached/i.test(e?.message || '')) throw e;
  }
  try {
    return await fn((method, params) => chrome.debugger.sendCommand({ tabId }, method, params));
  } finally {
    if (owned) await chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

// Exported so tests can prove the generated expression is valid JS and behaves
// correctly — the CDP path only fires on CSP-strict sites, so a syntax error
// here would otherwise stay hidden until it mattered most.
export function buildCdpExpression(source, maxRows = MAX_ROWS) {
  return `(function(){
      var __src = ${JSON.stringify(source)};
      var __max = ${maxRows};
      return (${extractInPage.toString()})(__src, __max);
    })()`;
}

async function viaCdp(tabId, source) {
  return withDebugger(tabId, async (cmd) => {
    await cmd('Runtime.enable').catch(() => {});
    const expression = buildCdpExpression(source);
    const r = await cmd('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: false,
      timeout: 15000
    });
    if (r?.exceptionDetails) {
      return {
        ok: false,
        rows: [],
        pageTextLen: 0,
        error: r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'CDP evaluation failed'
      };
    }
    const v = r?.result?.value;
    if (!v || typeof v !== 'object') {
      return { ok: false, rows: [], pageTextLen: 0, error: 'CDP returned no value' };
    }
    return v;
  });
}

export async function runExtractor(tabId, source) {
  let first;
  try {
    first = await viaScripting(tabId, source);
  } catch (e) {
    first = { ok: false, error: e?.message || 'injection failed', rows: [], pageTextLen: 0 };
  }
  if (first.ok) return { ...first, via: 'scripting' };

  // Only escalate for eval/CSP problems — a genuinely broken extractor must
  // report its own error, not be retried through a heavier path.
  if (!EVAL_BLOCKED_RE.test(first.error || '')) return { ...first, via: 'scripting' };

  try {
    const second = await viaCdp(tabId, source);
    return { ...second, via: 'cdp', note: 'page CSP blocked in-page compilation — ran via CDP' };
  } catch (e) {
    return {
      ok: false,
      rows: [],
      pageTextLen: first.pageTextLen || 0,
      via: 'cdp',
      error: `page CSP blocked compilation and CDP fallback failed: ${e?.message || e}`
    };
  }
}
