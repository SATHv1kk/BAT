// Background service worker — side panel wiring + API proxy.
// The panel fetches through here because the service worker is not subject to
// the side panel's page CSP and survives panel close/reopen mid-request.

import { DEEPSEEK_API, API_TIMEOUT_MS } from '../shared/constants.js';
import './runner.js'; // plan runner: background collection runs (state machine + watchdog)
import { fetchBoard, discoverBoard } from '../lib/ats-adapters.js';

// ATS fetches run HERE because the panel CSP blocks cross-origin fetch.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'BAT_ATS_CMD') return false;
  (async () => {
    try {
      const res = message.cmd === 'discover'
        ? await discoverBoard(message.provider, message.company)
        : await fetchBoard(message.provider, message.slug);
      sendResponse(res);
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});

// Sourced from the manifest so the bundled path can't drift out of sync.
const SIDE_PANEL_PATH = chrome.runtime.getManifest().side_panel.default_path;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setOptions({ path: SIDE_PANEL_PATH });
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error(error));
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'open-sidepanel') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) await chrome.sidePanel.open({ tabId: tab.id });
  } catch (err) {
    console.error('BAT open-sidepanel:', err);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'BAT_DEEPSEEK_API') return false;

  (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const resp = await fetch(DEEPSEEK_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + message.key
        },
        body: JSON.stringify(message.body),
        signal: controller.signal
      });

      const raw = await resp.text();
      let data = {};
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        data = { error: { message: raw.slice(0, 200) } };
      }

      sendResponse({ ok: resp.ok, status: resp.status, data, via: 'background' });
    } catch (err) {
      const msg = err?.name === 'AbortError'
        ? `Request timed out after ${API_TIMEOUT_MS / 1000}s (background worker)`
        : (err?.message || 'Failed to fetch');
      sendResponse({
        ok: false,
        status: 0,
        error: msg,
        data: null,
        via: 'background'
      });
    } finally {
      clearTimeout(timer);
    }
  })();

  return true;
});