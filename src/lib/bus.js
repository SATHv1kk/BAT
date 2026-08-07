// Lightweight message bus — wraps chrome.runtime.sendMessage with named
// channels so the codebase has one dispatch surface instead of scattered
// raw sendMessage calls.
//
// Channels: panel, bg, cs(tabId), page(tabId)
// Every message is { ch:channel, m:method, d:data, i:requestId }
// Handlers register with bus.on(channel, method, handler).
//
// From Moni's bridge pattern (audit item #3): Moni has 4 bridges with
// ~30 services each. BAT doesn't need that scale — just clean routing.
// This is a thin wrapper, not a refactor. Existing raw sendMessage calls
// still work alongside it.

const listeners = new Map(); // channel:method → Set<handler>

// Returns the listen key: "channel:method"
function key(ch, m) { return ch + ':' + m; }

let _counter = 0;
function nextId() { return String(++_counter) + '_' + Date.now().toString(36); }

// Send a message and get a response. Falls back to raw sendMessage.
export function call(channel, method, data = {}, { tabId = null, timeoutMs = 5000 } = {}) {
  const req = { ch: channel, m: method, d: data, i: nextId() };
  if (tabId != null) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('bus call timeout: ' + channel + '.' + method)), timeoutMs);
      chrome.tabs.sendMessage(tabId, { type: 'BAT_BUS', ...req }, (resp) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) { reject(chrome.runtime.lastError); return; }
        resolve(resp?.d ?? null);
      });
    });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('bus call timeout: ' + channel + '.' + method)), timeoutMs);
    chrome.runtime.sendMessage({ type: 'BAT_BUS', ...req }, (resp) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) { reject(chrome.runtime.lastError); return; }
      resolve(resp?.d ?? null);
    });
  });
}

// Fire-and-forget — no response expected.
export function send(channel, method, data = {}) {
  const req = { type: 'BAT_BUS', ch: channel, m: method, d: data, i: nextId() };
  chrome.runtime.sendMessage(req).catch(() => {});
}

// Register a handler. Returns an unsubscribe function.
export function on(channel, method, handler) {
  const k = key(channel, method);
  if (!listeners.has(k)) listeners.set(k, new Set());
  listeners.get(k).add(handler);
  return () => {
    const set = listeners.get(k);
    if (set) { set.delete(handler); if (!set.size) listeners.delete(k); }
  };
}

// Register a handler for ANY method on this channel.
export function onChannel(channel, handler) {
  return on(channel, '*', handler);
}

// Wire into chrome.runtime.onMessage. Call once per context (panel, bg, cs).
export function install() {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== 'BAT_BUS') return false;
    const ch = msg.ch;
    const m = msg.m;
    const handled = [];

    // Exact match first
    const exact = listeners.get(key(ch, m));
    if (exact) {
      for (const h of exact) {
        try {
          const result = h(msg.d, sender, msg.i);
          handled.push(result);
        } catch (e) { /* handler errors don't kill the bus */ }
      }
    }

    // Wildcard handlers
    const wild = listeners.get(key(ch, '*'));
    if (wild) {
      for (const h of wild) {
        try {
          const result = h(msg.d, sender, msg.i);
          handled.push(result);
        } catch (_) {}
      }
    }

    if (handled.length) {
      // If any handler returned a Promise or value, resolve with it
      const results = handled.filter(r => r !== undefined);
      if (results.length) {
        const first = results[0];
        if (first && typeof first.then === 'function') {
          first.then(v => sendResponse({ d: v })).catch(() => sendResponse({ d: null }));
          return true;
        }
        sendResponse({ d: first });
      } else {
        sendResponse({ d: null });
      }
      return true;
    }
    return false;
  });
}

// Pre-defined channel constants so they can't drift.
export const CH = {
  BG: 'bg',
  PANEL: 'panel',
  CS: 'cs',
  PAGE: 'page'
};
