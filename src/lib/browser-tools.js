// Browser action execution — tool handlers backed by CDP + the scripting API.
// Loaded before sidebar.js; exposes window.BrowserTools.

(function () {
  const EXECUTE_TIMEOUT_MS = 10000;
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  const debuggerAttached = new Set();

  // `text` makes CDP synthesize the character / keypress (Enter needs '\r' to submit)
  const KEY_MAP = {
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
    Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
    Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
    Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
    Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
    Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
    ' ': { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' }
  };

  const idleWaiters = new Map();

  function cancelIdleWait(tabId) {
    const w = idleWaiters.get(tabId);
    if (!w) return;
    chrome.tabs.onUpdated.removeListener(w.listener);
    clearTimeout(w.timer);
    idleWaiters.delete(tabId);
  }

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

  function isAlreadyAttachedError(err) {
    const msg = (err?.message || String(err)).toLowerCase();
    return msg.includes('already attached') || msg.includes('another debugger');
  }

  async function ensureDebugger(tabId) {
    if (debuggerAttached.has(tabId)) return true;
    return new Promise((res, rej) => {
      chrome.debugger.attach({ tabId }, '1.3', () => {
        if (chrome.runtime.lastError) {
          const err = chrome.runtime.lastError;
          if (isAlreadyAttachedError(err)) {
            res(false);
            return;
          }
          rej(err);
          return;
        }
        debuggerAttached.add(tabId);
        res(true);
      });
    });
  }

  async function releaseDebugger(tabId) {
    if (!debuggerAttached.has(tabId)) return;
    await new Promise((res) => chrome.debugger.detach({ tabId }, () => res()));
    debuggerAttached.delete(tabId);
    const m = tabMonitors.get(tabId);
    if (m) m.enabled = false; // CDP domains disable on detach
  }

  // ── Console + network monitors (CDP event buffers per tab) ──────
  const tabMonitors = new Map(); // tabId → { console: [], network: [], reqIndex: Map, enabled }

  function getMonitor(tabId) {
    let m = tabMonitors.get(tabId);
    if (!m) {
      m = { console: [], network: [], reqIndex: new Map(), enabled: false };
      tabMonitors.set(tabId, m);
    }
    return m;
  }

  chrome.debugger.onDetach.addListener((source) => {
    const m = tabMonitors.get(source.tabId);
    if (m) m.enabled = false;
    debuggerAttached.delete(source.tabId);
  });

  chrome.debugger.onEvent.addListener((source, method, params) => {
    const m = tabMonitors.get(source.tabId);
    if (!m) return;
    if (method === 'Runtime.consoleAPICalled') {
      const text = (params.args || [])
        .map(a => (a.value !== undefined ? String(a.value) : (a.description || a.type || '')))
        .join(' ');
      m.console.push({ ts: Date.now(), level: params.type || 'log', text: text.slice(0, 500) });
    } else if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails;
      m.console.push({
        ts: Date.now(),
        level: 'error',
        text: ('Uncaught ' + (d?.exception?.description || d?.text || 'exception')).slice(0, 500)
      });
    } else if (method === 'Log.entryAdded') {
      const e = params.entry || {};
      m.console.push({ ts: Date.now(), level: e.level || 'info', text: (e.text || '').slice(0, 500) });
    } else if (method === 'Network.requestWillBeSent') {
      const entry = {
        ts: Date.now(),
        method: params.request?.method || 'GET',
        url: (params.request?.url || '').slice(0, 300),
        type: params.type || '',
        status: null,
        error: null
      };
      m.reqIndex.set(params.requestId, entry);
      m.network.push(entry);
    } else if (method === 'Network.responseReceived') {
      const e = m.reqIndex.get(params.requestId);
      if (e) { e.status = params.response?.status; e.mime = params.response?.mimeType; }
    } else if (method === 'Network.loadingFailed') {
      const e = m.reqIndex.get(params.requestId);
      if (e) e.error = params.errorText || 'failed';
    }
    if (m.console.length > 300) m.console.splice(0, m.console.length - 300);
    if (m.network.length > 400) m.network.splice(0, m.network.length - 400);
    if (m.reqIndex.size > 600) {
      for (const key of [...m.reqIndex.keys()].slice(0, m.reqIndex.size - 400)) m.reqIndex.delete(key);
    }
  });

  async function enableMonitoring(tabId) {
    const m = getMonitor(tabId);
    if (m.enabled) return false;
    await withDebugger(tabId, async (cmd) => {
      await cmd('Runtime.enable');
      await cmd('Log.enable');
      await cmd('Network.enable');
    });
    m.enabled = true;
    return true;
  }

  async function readConsole(tabId, pattern, limit = 40) {
    const first = await enableMonitoring(tabId);
    let entries = getMonitor(tabId).console;
    if (pattern) {
      try {
        const re = new RegExp(pattern, 'i');
        entries = entries.filter(e => re.test(e.text));
      } catch (_) {}
    }
    return { first, entries: entries.slice(-limit) };
  }

  async function readNetwork(tabId, filter, limit = 40) {
    const first = await enableMonitoring(tabId);
    let entries = getMonitor(tabId).network;
    if (filter) {
      try {
        const re = new RegExp(filter, 'i');
        entries = entries.filter(e => re.test(e.url));
      } catch (_) {}
    }
    return { first, entries: entries.slice(-limit) };
  }

  async function withDebugger(tabId, fn) {
    const owned = await ensureDebugger(tabId);
    const cmd = (method, params) =>
      new Promise((res, rej) =>
        chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
          const err = chrome.runtime.lastError;
          if (!err) return res(result);
          let msg = err.message || String(err);
          if (!owned && /not attached|detached/i.test(msg)) {
            msg += ' — another debugger (e.g. DevTools) is attached to this tab; close it and retry';
          }
          rej(new Error(msg));
        })
      );
    return fn(cmd, owned);
  }

  async function waitForPageIdle(tabId, timeoutMs = 5000) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') {
      await delay(300);
      return true;
    }
    cancelIdleWait(tabId);
    return new Promise((resolve) => {
      const cleanup = () => {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        idleWaiters.delete(tabId);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
      const listener = (id, info) => {
        if (id === tabId && info.status === 'complete') {
          cleanup();
          delay(300).then(() => resolve(true));
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      idleWaiters.set(tabId, { listener, timer });
    });
  }

  async function getViewportCenter(tabId) {
    const results = await executeScript(
      { tabId },
      () => ({ x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 2) })
    );
    return results?.[0]?.result || { x: 400, y: 400 };
  }

  async function domScroll(tabId, direction) {
    const delta = direction === 'up' ? -450 : 450;
    await executeScript({ tabId, allFrames: true }, (dy) => {
      const scrollEl = (el) => {
        if (!el) return false;
        const before = el.scrollTop;
        el.scrollBy(0, dy);
        return el.scrollTop !== before;
      };
      const targets = [
        document.scrollingElement,
        document.documentElement,
        document.body,
        ...document.querySelectorAll('[class*="scroll"], [style*="overflow"]')
      ];
      for (const el of targets) {
        if (scrollEl(el)) return { scrolled: true };
      }
      window.scrollBy(0, dy);
      return { scrolled: true };
    }, [delta]);
    await delay(400);
    return { success: true, detail: 'scrolled ' + direction + ' (DOM)' };
  }

  async function cdpClick(tabId, x, y, onCursor, opts = {}) {
    const button = opts.button === 'right' ? 'right' : 'left';
    const buttonsMask = button === 'right' ? 2 : 1;
    const clicks = opts.double ? 2 : 1;
    if (onCursor) await onCursor(x, y, 'move');
    await withDebugger(tabId, async (cmd) => {
      await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', modifiers: 0 });
      await delay(80);
      if (onCursor) onCursor(x, y, 'click').catch(() => {});
      for (let i = 1; i <= clicks; i++) {
        await cmd('Input.dispatchMouseEvent', {
          type: 'mousePressed', x, y, button, clickCount: i, buttons: buttonsMask, modifiers: 0
        });
        await delay(12);
        await cmd('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x, y, button, clickCount: i, buttons: 0, modifiers: 0
        });
        if (i < clicks) await delay(60);
      }
    });
  }

  async function cdpInsertText(tabId, text) {
    await withDebugger(tabId, async (cmd) => {
      await cmd('Input.insertText', { text });
    });
  }

  // Works on unfocused tabs (unlike chrome.tabs.captureVisibleTab)
  async function cdpScreenshot(tabId) {
    return withDebugger(tabId, async (cmd) => {
      const r = await cmd('Page.captureScreenshot', { format: 'jpeg', quality: 60 });
      return r?.data ? 'data:image/jpeg;base64,' + r.data : null;
    });
  }

  async function cdpScroll(tabId, deltaY) {
    const { x, y } = await getViewportCenter(tabId);
    await withDebugger(tabId, async (cmd) => {
      await cmd('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers: 0
      });
    });
  }

  async function cdpKey(tabId, keyName) {
    const k = { ...(KEY_MAP[keyName] || { key: keyName, code: keyName, windowsVirtualKeyCode: 0 }) };
    if (!k.text && k.key.length === 1) k.text = k.key; // printable char
    const { text, ...base } = k;
    await withDebugger(tabId, async (cmd) => {
      const down = { type: 'keyDown', ...base, modifiers: 0 };
      if (text) down.text = text;
      await cmd('Input.dispatchKeyEvent', down);
      await delay(20);
      await cmd('Input.dispatchKeyEvent', { type: 'keyUp', ...base, modifiers: 0 });
    });
  }

  async function clickRef(tabId, frameId, localRef) {
    const target = frameId != null ? { tabId, frameIds: [frameId] } : { tabId, allFrames: true };
    const results = await executeScript(target, (ref) => {
      function findEl(r) {
        const maps = [window.__batElementMap];
        for (const map of maps) {
          if (!map?.[r]) continue;
          const w = map[r];
          const el = typeof w.deref === 'function' ? w.deref() : w;
          if (el && document.contains(el)) return el;
          if (el && !document.contains(el)) delete map[r];
        }
        return document.querySelector('[data-ext-ref="' + r + '"]');
      }

      const el = findEl(ref);
      if (!el) return { success: false, error: 'element not found' };

      el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
      const label = (el.innerText || el.textContent || el.getAttribute('aria-label') || '')
        .replace(/\s+/g, ' ').trim().slice(0, 120);
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || '';
      const isCheckable = tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')
        || role === 'checkbox' || role === 'radio';

      if (typeof el.click === 'function') {
        el.click();
      } else {
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));
      }

      if (isCheckable) {
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      return {
        success: true,
        label,
        checked: !!el.checked,
        isCheckable
      };
    }, [localRef]);

    const hit = frameId != null
      ? results?.[0]?.result
      : (results || []).find((r) => r.result?.success)?.result;
    return hit || { success: false, error: 'click missed' };
  }

  async function scrollToRef(tabId, frameId, localRef) {
    const target = frameId != null ? { tabId, frameIds: [frameId] } : { tabId, allFrames: true };
    const results = await executeScript(target, (ref) => {
      function findEl(r) {
        const map = window.__batElementMap;
        if (map?.[r]) {
          const w = map[r];
          const el = typeof w.deref === 'function' ? w.deref() : w;
          if (el && document.contains(el)) return el;
        }
        return document.querySelector('[data-ext-ref="' + r + '"]');
      }
      const el = findEl(ref);
      if (!el) return { success: false };
      el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
      const label = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      return { success: true, label };
    }, [localRef]);
    const hit = frameId != null
      ? results?.[0]?.result
      : (results || []).find((r) => r.result?.success)?.result;
    await delay(400);
    return hit || { success: false, error: 'scroll_to missed' };
  }

  async function formSetRef(tabId, frameId, localRef, value) {
    const target = frameId != null ? { tabId, frameIds: [frameId] } : { tabId, allFrames: true };
    const results = await executeScript(target, (ref, val) => {
      function findEl(r) {
        const map = window.__batElementMap;
        if (map?.[r]) {
          const w = map[r];
          const el = typeof w.deref === 'function' ? w.deref() : w;
          if (el && document.contains(el)) return el;
        }
        return document.querySelector('[data-ext-ref="' + r + '"]');
      }
      const el = findEl(ref);
      if (!el) return { success: false, error: 'element not found' };

      el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || '';
      const type = (el.getAttribute('type') || '').toLowerCase();
      const strVal = val == null ? '' : String(val);
      const boolVal = val === true || val === 'true' || val === '1' || val === 1;

      if (type === 'checkbox' || role === 'checkbox') {
        if (!!el.checked !== boolVal) {
          if (typeof el.click === 'function') el.click();
          else el.checked = boolVal;
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, label: (el.closest('label')?.innerText || '').slice(0, 80), checked: !!el.checked };
      }

      if (type === 'radio' || role === 'radio') {
        if (!el.checked) el.click();
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, label: strVal.slice(0, 80), checked: true };
      }

      if (tag === 'select') {
        const opts = [...el.options];
        const match = opts.find(o =>
          o.value === strVal || o.text.replace(/\s+/g, ' ').trim().toLowerCase() === strVal.toLowerCase()
        );
        if (match) {
          el.value = match.value;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true, label: match.text.slice(0, 80) };
        }
        return { success: false, error: 'option not found' };
      }

      el.focus();
      if (tag === 'input' || tag === 'textarea') {
        const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, strVal);
        else el.value = strVal;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, label: strVal.slice(0, 80) };
      }

      return { success: false, error: 'unsupported form element' };
    }, [localRef, value]);

    const hit = frameId != null ? results?.[0]?.result : (results || []).find((r) => r.result?.success)?.result;
    return hit || { success: false, error: 'form_input failed' };
  }

  async function runJavaScript(tabId, code, frameId) {
    const target = frameId != null ? { tabId, frameIds: [frameId] } : { tabId };
    const evaluator = (src) => {
      try {
        // eslint-disable-next-line no-eval
        const v = eval(src); // handles statements and expressions alike
        return v === undefined ? null : v;
      } catch (e) {
        return { __bat_error: e.message };
      }
    };
    const runIn = async (world) => {
      let timer;
      try {
        return await Promise.race([
          chrome.scripting.executeScript({ target, injectImmediately: true, world, func: evaluator, args: [code] }),
          new Promise((_, rej) => {
            timer = setTimeout(() => rej(new Error('executeScript timed out')), EXECUTE_TIMEOUT_MS);
          })
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    // MAIN world sees the page's own JS (e.g. SCORM/course player state);
    // fall back to the isolated world when the page CSP blocks eval there.
    let result;
    try {
      result = (await runIn('MAIN'))?.[0]?.result;
    } catch (e) {
      result = { __bat_error: e.message || 'MAIN world execution failed' };
    }
    if (result?.__bat_error && /security policy|unsafe-eval|evalerror|blocked/i.test(result.__bat_error)) {
      try {
        result = (await runIn('ISOLATED'))?.[0]?.result;
      } catch (e) {
        result = { __bat_error: e.message || 'execution failed' };
      }
    }
    if (result?.__bat_error) return { success: false, error: result.__bat_error };
    let detail;
    try { detail = JSON.stringify(result); } catch { detail = String(result); }
    return { success: true, detail: (detail ?? String(result)).slice(0, 500) };
  }

  async function typeIntoRef(tabId, frameId, localRef, text, clickFirst) {
    const target = frameId != null ? { tabId, frameIds: [frameId] } : { tabId, allFrames: true };
    const results = await executeScript(target, (ref, value, doClick) => {
      let el = null;
      const map = window.__batElementMap;
      if (map?.[ref]) {
        const w = map[ref];
        el = typeof w.deref === 'function' ? w.deref() : w;
        if (el && !document.contains(el)) { delete map[ref]; el = null; }
      }
      if (!el) el = document.querySelector('[data-ext-ref="' + ref + '"]');
      if (!el) return { success: false };

      if (doClick) {
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));
      }

      const tag = el.tagName.toLowerCase();
      el.focus();
      if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
        el.textContent = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (tag === 'input' || tag === 'textarea') {
        const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, value);
        else el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        el.textContent = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return { success: true, label: (el.innerText || el.value || '').slice(0, 80) };
    }, [localRef, text, clickFirst]);

    const hit = frameId != null ? results?.[0]?.result : (results || []).find((r) => r.result?.success)?.result;
    return hit || { success: false };
  }

  window.BrowserTools = {
    delay,
    waitForPageIdle,
    cdpClick,
    cdpScroll,
    cdpKey,
    cdpScreenshot,
    readConsole,
    readNetwork,
    clickRef,
    scrollToRef,
    formSetRef,
    runJavaScript,
    domScroll,
    releaseDebugger,
    typeIntoRef,

    async typeAtCoords(tabId, x, y, text, onCursor) {
      try {
        await cdpClick(tabId, x, y, onCursor);
        await delay(120);
        await cdpInsertText(tabId, text);
        await delay(200);
        return { success: true, label: text.slice(0, 80), detail: 'typed via CDP' };
      } catch (e) {
        return { success: false, error: e.message || 'CDP type failed' };
      }
    },

    async scroll(tabId, direction) {
      try {
        return await domScroll(tabId, direction);
      } catch (_) {
        try {
          const delta = direction === 'up' ? -500 : 500;
          await cdpScroll(tabId, delta);
          await delay(400);
          return { success: true, detail: 'scrolled ' + direction + ' (CDP)' };
        } catch (e) {
          return { success: false, error: e.message || 'scroll failed' };
        }
      }
    },

    async navigate(tabId, url) {
      let target = (url || '').trim();
      if (!target) return { success: false, error: 'No URL' };
      if (!/^https?:\/\//i.test(target)) target = 'https://' + target;
      await chrome.tabs.update(tabId, { url: target });
      await waitForPageIdle(tabId, 15000);
      return { success: true, detail: 'navigated to ' + target };
    },

    async goBack(tabId) {
      await chrome.tabs.goBack(tabId);
      await waitForPageIdle(tabId, 8000);
      return { success: true, detail: 'went back' };
    },

    async goForward(tabId) {
      await chrome.tabs.goForward(tabId);
      await waitForPageIdle(tabId, 8000);
      return { success: true, detail: 'went forward' };
    },

    async refresh(tabId) {
      await chrome.tabs.reload(tabId);
      await waitForPageIdle(tabId, 12000);
      return { success: true, detail: 'refreshed' };
    },

    async keyPress(tabId, key) {
      if (!key) return { success: false, error: 'No key specified' };
      try {
        await cdpKey(tabId, key);
        await delay(300);
        return { success: true, detail: 'pressed ' + key };
      } catch (e) {
        return { success: false, error: e.message || 'key press failed' };
      }
    }
  };
})();