// Page reading helpers — find, enriched text, and tab listing.
(function () {
  const EXECUTE_TIMEOUT_MS = 10000;

  async function executeScript(target, func, args) {
    let timer;
    try {
      return await Promise.race([
        chrome.scripting.executeScript({ target, injectImmediately: true, world: 'ISOLATED', func, args }),
        new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error('executeScript timed out')), EXECUTE_TIMEOUT_MS);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function findOnPage(tabId, query, maxResults = 12) {
    const needle = (query || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (needle.length < 2) return [];

    const results = await executeScript({ tabId, allFrames: true }, (needle, maxResults) => {
      function findEl(ref) {
        const map = window.__batElementMap;
        if (map?.[ref]) {
          const w = map[ref];
          const el = typeof w.deref === 'function' ? w.deref() : w;
          if (el && document.contains(el)) return el;
        }
        return null;
      }

      const hits = [];
      const map = window.__batElementMap || {};
      for (const ref of Object.keys(map)) {
        const el = findEl(ref);
        if (!el) continue;
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') continue;
        const label = (el.innerText || el.textContent || el.getAttribute('aria-label') || '')
          .replace(/\s+/g, ' ').trim();
        if (!label) continue;
        const lower = label.toLowerCase();
        if (!lower.includes(needle) && !needle.includes(lower.slice(0, Math.min(40, lower.length)))) continue;
        const role = el.getAttribute('role') || el.tagName.toLowerCase();
        hits.push({ ref, label: label.slice(0, 140), role, frameUrl: location.href });
        if (hits.length >= maxResults) break;
      }

      if (hits.length < maxResults) {
        const candidates = document.querySelectorAll(
          'button, a, input, label, li, [role="button"], [role="checkbox"], [role="radio"], h1, h2, h3, p, span'
        );
        for (const el of candidates) {
          const s = window.getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden') continue;
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) continue;
          const label = (el.innerText || el.textContent || el.getAttribute('aria-label') || '')
            .replace(/\s+/g, ' ').trim();
          if (!label || label.length < 3) continue;
          const lower = label.toLowerCase();
          if (!lower.includes(needle)) continue;
          // Mint a ref so this hit is actionable — a match the model can't
          // click just costs it a wasted re-read turn.
          //
          // The maps are created here if absent rather than being optionally
          // written to. find runs in EVERY frame, including ones the
          // accessibility-tree content script never reached (it is what
          // normally creates them), and there `__batElementReverseMap?.set(...)`
          // silently did nothing: the forward map grew a new entry on every
          // find while the reverse lookup kept missing, so the same element got
          // a different ref each time and the model's earlier ref went stale
          // for no reason. Storing a bare element instead of a WeakRef was the
          // other half of it — the tree builder's sweep calls .deref() on every
          // entry, so one such entry would throw and take the whole page read
          // down with it.
          if (!window.__batElementMap) window.__batElementMap = {};
          if (!window.__batElementReverseMap) window.__batElementReverseMap = new WeakMap();
          if (!window.__batRefCounter) window.__batRefCounter = 0;
          let ref = window.__batElementReverseMap.get(el) || null;
          if (ref && window.__batElementMap[ref]?.deref() !== el) ref = null;
          if (!ref) {
            ref = 'ref_' + (++window.__batRefCounter);
            window.__batElementMap[ref] = new WeakRef(el);
            window.__batElementReverseMap.set(el, ref);
            try { el.setAttribute('data-ext-ref', ref); } catch (_) {}
          }
          hits.push({
            ref,
            label: label.slice(0, 140),
            role: el.getAttribute('role') || el.tagName.toLowerCase(),
            frameUrl: location.href
          });
          if (hits.length >= maxResults) break;
        }
      }
      return hits;
    }, [needle, maxResults]);

    // Keep the frameId — refs are frame-LOCAL; the caller maps them into the
    // global ref space the model uses.
    return (results || []).flatMap(r => (r.result || []).map(h => ({ ...h, frameId: r.frameId })));
  }

  async function getEnrichedPageText(tabId, maxChars = 12000) {
    const results = await executeScript({ tabId, allFrames: true }, (maxChars) => {
      const chunks = [];
      const title = document.title || '';
      if (title) chunks.push('Title: ' + title);

      const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
      if (bodyText) chunks.push(bodyText);

      const extras = [];
      for (const el of document.querySelectorAll('[aria-label], img[alt], [title]')) {
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') continue;
        const t = el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || '';
        const clean = t.replace(/\s+/g, ' ').trim();
        if (clean.length > 2 && clean.length < 200) extras.push(clean);
      }

      for (const el of document.querySelectorAll('input[type="checkbox"], [role="checkbox"]')) {
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') continue;
        const lab = (el.closest('label')?.innerText || el.parentElement?.innerText || '')
          .replace(/\s+/g, ' ').trim().slice(0, 120);
        if (lab) {
          const on = el.checked || el.getAttribute('aria-checked') === 'true';
          extras.push(`[checkbox ${on ? 'ON' : 'off'}] ${lab}`);
        }
      }

      if (extras.length) chunks.push('--- labels & controls ---\n' + [...new Set(extras)].join('\n'));
      const out = chunks.join('\n\n');
      return {
        text: out.slice(0, maxChars),
        frameUrl: location.href,
        isFrame: window !== window.top
      };
    }, [maxChars]);

    const frames = (results || []).map(r => r.result).filter(Boolean);
    frames.sort((a, b) => (b.text?.length || 0) - (a.text?.length || 0));
    const main = frames.find(f => !f.isFrame) || frames[0];
    let merged = main?.text || '';
    const iframeTexts = frames.filter(f => f.isFrame && f.text?.length > 40);
    if (iframeTexts.length) {
      merged += '\n\n' + iframeTexts.map(f => `--- iframe (${f.frameUrl}) ---\n${f.text}`).join('\n\n');
    }
    return merged.slice(0, maxChars);
  }

  async function mapCheckboxRefs(tabId, registry) {
    if (!registry) return [];
    const entries = Object.entries(registry).filter(([, e]) =>
      e.role === 'checkbox' || /checkbox/i.test(e.label || '')
    );
    return entries.map(([globalRef, e]) => ({
      ref: globalRef,
      label: (e.label || '').slice(0, 120),
      frameId: e.frameId
    }));
  }

  // Bulk link scan — one call returns every visible link on the page with its
  // text, URL and ref so the model never needs to hunt through the DOM manually.
  // Covers `<a href>`, elements with data-url/data-href/data-link attributes,
  // and JS-product-viewer cards that wrap the link around a child element.
  async function getLinks(tabId, { maxResults = 120, hrefContains = null } = {}) {
    const results = await executeScript({ tabId, allFrames: true }, (maxResults, hrefContains) => {
      const hits = [];
      // Mint refs for elements we return so the model can click them
      if (!window.__batElementMap) window.__batElementMap = {};
      if (!window.__batElementReverseMap) window.__batElementReverseMap = new WeakMap();
      if (!window.__batRefCounter) window.__batRefCounter = 0;
      function mintRef(el) {
        let ref = window.__batElementReverseMap.get(el) || null;
        if (ref && window.__batElementMap[ref]?.deref() !== el) ref = null;
        if (!ref) {
          ref = 'ref_' + (++window.__batRefCounter);
          window.__batElementMap[ref] = new WeakRef(el);
          window.__batElementReverseMap.set(el, ref);
          try { el.setAttribute('data-ext-ref', ref); } catch (_) {}
        }
        return ref;
      }

      const seen = new Set();
      const hrefFilter = hrefContains ? hrefContains.toLowerCase() : null;

      // Pass 1: every <a> with an href
      for (const a of document.querySelectorAll('a[href]')) {
        if (hits.length >= maxResults) break;
        const s = window.getComputedStyle(a);
        if (s.display === 'none' || s.visibility === 'hidden') continue;
        const r = a.getBoundingClientRect();
        if (r.width < 2 && r.height < 2) continue;
        let href = (a.href || '').trim();
        if (!href || href.startsWith('javascript:')) continue;
        if (hrefFilter && !href.toLowerCase().includes(hrefFilter)) continue;
        const key = href.slice(0, 2000);
        if (seen.has(key)) continue;
        seen.add(key);
        const text = (a.innerText || a.textContent || a.getAttribute('aria-label') || a.title || '')
          .replace(/\s+/g, ' ').trim().slice(0, 160);
        hits.push({
          ref: mintRef(a), text, href: href.slice(0, 600),
          tag: 'a', frameUrl: location.href
        });
      }

      // Pass 2: elements with data-url / data-href / data-link (product viewer cards)
      if (hits.length < maxResults) {
        for (const el of document.querySelectorAll('[data-url], [data-href], [data-link]')) {
          if (hits.length >= maxResults) break;
          const s = window.getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden') continue;
          const r = el.getBoundingClientRect();
          if (r.width < 2 && r.height < 2) continue;
          const href = (
            el.getAttribute('data-url') || el.getAttribute('data-href') || el.getAttribute('data-link') || ''
          ).trim();
          if (!href) continue;
          if (hrefFilter && !href.toLowerCase().includes(hrefFilter)) continue;
          const key = href.slice(0, 2000);
          if (seen.has(key)) continue;
          seen.add(key);
          const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '')
            .replace(/\s+/g, ' ').trim().slice(0, 100);
          hits.push({
            ref: mintRef(el), text, href: href.slice(0, 600),
            tag: 'data-url', frameUrl: location.href
          });
        }
      }

      return hits;
    }, [maxResults, hrefContains]);

    return (results || []).flatMap(r =>
      (r.result || []).map(h => ({ ...h, frameId: r.frameId }))
    );
  }

  window.PageTools = {
    findOnPage,
    getEnrichedPageText,
    mapCheckboxRefs,
    getLinks
  };
})();