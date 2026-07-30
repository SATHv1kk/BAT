// Plan runner — a service-worker state machine that executes collection runs
// with zero model calls per page (cached extractor replay). Position and
// counts are checkpointed to IndexedDB after EVERY page, so panel close,
// worker eviction, or a browser restart never loses more than the page in
// flight. The model is consulted only to synthesize an extractor when a site
// has none.
//
// Keepalive: we do not fight worker eviction. The work itself keeps the worker
// alive while processing; a 30s chrome.alarms watchdog revives the loop if the
// worker was killed mid-run; onStartup recovers after a browser restart.
// Eviction is a non-event by design, not a battle.
//
// Run states (all persisted): draft → running → done, with awaiting_human
// (captcha/login — never solved automatically), paused (user), and failed.
// STALLED pages are skipped and logged; a unit with repeated failures is
// abandoned (logged as blocked) while the run itself stays alive.

import { DEEPSEEK_API, DEFAULT_MODEL } from '../shared/constants.js';
import * as Store from '../lib/state-store.js';
import * as Extractors from '../lib/extractors.js';
import { appendRows as writerAppendRows } from '../lib/output-writer.js';
import { safeName } from '../lib/workspace.js';
import { fillTemplate, applyRules, rowsMatchStop, mergeRules, decideUnitProgress, reconcileCheckpoint } from '../lib/plan.js';
import { runExtractor } from '../lib/extractor-exec.js';
import { RUNNER_TOKEN_BUDGET, SYNTHESIS_MODEL } from '../shared/constants.js';
import { writeFile, removeFile } from '../lib/workspace.js';

const PAGE_TIMEOUT_MS = 25000;  // hard budget per page → STALLED beyond this
const PAGE_DELAY_MS = 1200;     // politeness delay between pages
const UNIT_FAIL_LIMIT = 3;      // consecutive failures → unit abandoned (BLOCKED)
const WATCHDOG_ALARM = 'bat-runner-watchdog';

const activeLoops = new Set();  // runIds with a live loop in THIS worker instance
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Chrome-side helpers ───────────────────────────────────────────
async function isUrlAllowed(url) {
  const s = await chrome.storage.local.get(['bat_allowed_sites']);
  const sites = Array.isArray(s.bat_allowed_sites) ? s.bat_allowed_sites : [];
  if (!sites.length) return true;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return sites.some((p) => host === p || host.endsWith('.' + p));
  } catch {
    return false;
  }
}

function notifyPanel(event) {
  try {
    chrome.runtime.sendMessage({ type: 'BAT_RUN_EVENT', ...event }).catch(() => {});
  } catch (_) {}
}

async function setBadge(text) {
  try { await chrome.action.setBadgeText({ text }); } catch (_) {}
}

async function ensureRunTab(run) {
  if (run.tabId) {
    const tab = await chrome.tabs.get(run.tabId).catch(() => null);
    if (tab) return run.tabId;
  }
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  run.tabId = tab.id;
  return tab.id;
}

// The runner's own tab is an implementation detail — don't leave it behind.
async function closeRunTab(run) {
  if (run.tabId == null) return;
  await chrome.tabs.remove(run.tabId).catch(() => {});
  run.tabId = null;
}

function waitForComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish(true);
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete') finish(true); }).catch(() => finish(false));
  });
}

async function navigate(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  await delay(400); // let status flip to loading before watching for complete
  await waitForComplete(tabId, 20000);
  await delay(800); // settle for client-side rendering
}

// Human-intervention detection by SIGNAL: captcha iframes/markers, visible
// password fields, auth-wall URL patterns. Never solved automatically.
async function probePage(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: () => {
        const bodyText = (document.body?.innerText || '');
        const captcha = !!document.querySelector(
          'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], [class*="captcha" i], #challenge-running, #challenge-form'
        ) || /verify you are human|unusual traffic|are you a robot|security check to access/i.test(bodyText.slice(0, 3000));
        // A visible password box alone is not a wall — plenty of sites keep a
        // header sign-in form on a working results page. Require either an auth
        // URL or a prominent password field on a page with little content.
        const pw = document.querySelector('input[type="password"]');
        const pwProminent = !!pw && pw.offsetWidth > 80 && pw.offsetHeight > 15;
        const authUrl = /\/(login|signin|sign-in|authwall|checkpoint|account\/login)\b/i.test(location.pathname);
        const login = authUrl || (pwProminent && bodyText.length < 4000);
        return { textLen: bodyText.length, captcha, login, url: location.href, title: document.title || '' };
      }
    });
    return res?.result || { textLen: 0, captcha: false, login: false, url: '', title: '' };
  } catch (e) {
    return { textLen: 0, captcha: false, login: false, url: '', title: '', error: e.message };
  }
}

async function runExtractorInTab(tabId, source) {
  try {
    return await runExtractor(tabId, source); // shared executor: scripting → CDP on CSP block
  } catch (e) {
    return { ok: false, error: e.message, rows: [], pageTextLen: 0 };
  }
}

// ── Model call (synthesis only — the runner's sole model dependency) ──
async function callModel(content) {
  const s = await chrome.storage.local.get(['deepseek_key', 'bat_model']);
  if (!s.deepseek_key) throw new Error('no API key configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const resp = await fetch(DEEPSEEK_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.deepseek_key },
      body: JSON.stringify({
        // Writing an extractor from raw markup is the strong-model case the
        // whole design leans on — don't inherit a cheap interactive default.
        model: SYNTHESIS_MODEL || s.bat_model || DEFAULT_MODEL,
        messages: [{ role: 'user', content }],
        max_tokens: 4000,
        reasoning_effort: 'high'
      }),
      signal: controller.signal
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data?.error?.message || 'HTTP ' + resp.status);
    return {
      text: data.choices?.[0]?.message?.content || '',
      tokens: (data.usage?.prompt_tokens || 0) + (data.usage?.completion_tokens || 0)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function synthesizeExtractor(run, tabId) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func: () => {
      const text = (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 3000);
      let html = document.body ? document.body.outerHTML : '';
      html = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/\s+/g, ' ')
        .slice(0, 12000);
      return { text, html, url: location.href };
    }
  });
  const sample = res?.result;
  if (!sample) throw new Error('could not read page for synthesis');
  const cols = run.plan.columns?.join(', ') || 'the fields this job needs';
  const prompt = 'You write DOM data extractors. Reply with ONLY a JavaScript function BODY '
    + '(no markdown fences, no "function" wrapper) that runs in a browser page, takes no arguments, '
    + `reads document, and returns an array of plain objects — one per result row on the page — with EXACTLY these keys: ${cols}. `
    + 'Values are strings copied verbatim from the page (no date conversion or reformatting; empty string when absent). '
    + 'Return [] when nothing matches. Never throw.\n\n'
    + `Page URL: ${sample.url}\n\nVisible text sample:\n${sample.text}\n\nSanitized HTML:\n${sample.html}`;
  const completion = await callModel(prompt);
  return {
    source: completion.text.trim().replace(/^```(?:javascript|js)?\s*/i, '').replace(/\s*```\s*$/, ''),
    tokens: completion.tokens
  };
}

// ── One page of one unit ──────────────────────────────────────────
// eslint-disable-next-line complexity
async function processPage(run, unit, token = { cancelled: false }) {
  const stop = () => { if (token.cancelled) throw new Error('__cancelled__'); };
  const url = fillTemplate(unit.url_template, unit.vars, run.pos.page);
  if (!(await isUrlAllowed(url))) {
    return { outcome: 'blocked_site', note: 'URL not in allowlist: ' + url };
  }
  const tabId = await ensureRunTab(run);
  await navigate(tabId, url);
  stop();

  const probe = await probePage(tabId);

  // Re-check the origin we ACTUALLY landed on: a redirect or interstitial can
  // move us off the approved site between the pre-navigation check and running
  // model-authored code. The allowlist is a safety boundary, not a hint.
  const landedUrl = probe.url || url;
  if (landedUrl !== url && !(await isUrlAllowed(landedUrl))) {
    return { outcome: 'blocked_site', note: `redirected off the allowlist: ${url} → ${landedUrl}` };
  }

  if (probe.captcha || probe.login) {
    return {
      outcome: 'human',
      note: `${probe.captcha ? 'CAPTCHA/anti-bot check' : 'Login wall'} at ${url}`
    };
  }

  const pattern = Extractors.patternForUrl(url);
  let record = await Store.getExtractor(pattern);
  let synthesized = false;
  let suspicious = null;
  let exec;

  if (record?.status === 'halted') {
    return { outcome: 'halted', note: 'extractor halted for ' + pattern + ' — ' + (record.lastFailure || '') };
  }

  if (!record?.current) {
    let src;
    try {
      const synth = await synthesizeExtractor(run, tabId);
      src = synth.source;
      run.counts.tokens = (run.counts.tokens || 0) + synth.tokens;
    } catch (e) {
      return { outcome: 'synth_failed', note: 'synthesis failed: ' + e.message };
    }
    stop();
    exec = await runExtractorInTab(tabId, src);
    const check = exec.ok
      ? Extractors.validateReplay({ rows: exec.rows, pageTextLen: exec.pageTextLen, requiredFields: unit.required_fields })
      : { verdict: 'invalid', reason: exec.error };
    if (check.verdict === 'invalid') {
      return { outcome: 'synth_failed', note: 'fresh extractor rejected: ' + check.reason };
    }
    record = {
      pattern,
      status: 'active',
      current: {
        source: src,
        builtFromUrl: url,
        createdAt: Date.now(),
        schemaFingerprint: Extractors.schemaFingerprintOf(exec.rows),
        sampleRows: exec.rows.slice(0, 3)
      },
      history: [...(record?.history || [])].slice(-10),
      recentCounts: [],
      consecutiveFailures: 0
    };
    await Store.putExtractor(record);
    synthesized = true;
    // Persist the audit trail: with the panel closed, notifyPanel goes nowhere,
    // and "I must be able to read what actually ran" has to survive that.
    await Store.logEvent(run.id, { kind: 'extractor_synthesized', unitId: unit.id, pattern, source: src });
    notifyPanel({ event: 'extractor_synthesized', runId: run.id, pattern, source: src });
    if (check.verdict === 'empty') return { outcome: 'empty', rowsFound: 0, synthesized };
  } else {
    exec = await runExtractorInTab(tabId, record.current.source);
    const check = exec.ok
      ? Extractors.validateReplay({
          rows: exec.rows,
          pageTextLen: exec.pageTextLen,
          cachedFingerprint: record.current.schemaFingerprint,
          recentCounts: record.recentCounts || [],
          requiredFields: unit.required_fields
        })
      : { verdict: 'invalid', reason: exec.error };

    if (check.verdict === 'invalid') {
      record.consecutiveFailures = (record.consecutiveFailures || 0) + 1;
      record.lastFailure = check.reason;
      record.history = [...(record.history || []), { ...record.current, retiredAt: Date.now(), retiredReason: check.reason }].slice(-10);
      record.current = null;
      if (record.consecutiveFailures >= 2) record.status = 'halted';
      await Store.putExtractor(record);
      return {
        outcome: record.status === 'halted' ? 'halted' : 'invalid',
        note: check.reason
      };
    }
    if (check.verdict === 'empty') return { outcome: 'empty', rowsFound: 0 };
    suspicious = check.suspicious || null;
    record.consecutiveFailures = 0;
    record.recentCounts = [...(record.recentCounts || []), exec.rows.length].slice(-10);
    await Store.putExtractor(record);
  }
  stop();

  let rows = exec.rows;
  if (unit.set_fields) rows = rows.map((r) => ({ ...r, ...unit.set_fields }));
  rows = applyRules(rows, mergeRules(run.plan.rules, unit.rules));
  const stopHit = rowsMatchStop(exec.rows, unit.stop_when);

  let fresh = 0;
  let merged = 0;
  if (rows.length) {
    const sourceField = run.plan.source_field || 'source';
    const res = await Store.addRows(safeName(run.plan.filename), rows, {
      dedupFields: run.plan.dedup_fields,
      sourceField
    });
    fresh = res.fresh.length;
    merged = res.merged;
    if (fresh) {
      try {
        await writerAppendRows(run.plan.filename, res.fresh.map((f) => Store.projectRow(f, sourceField)), {
          columns: run.plan.columns,
          format: run.plan.format
        });
        run.pendingExport = false;
      } catch (e) {
        // Rows are safe in the store (the authority); the file catches up via
        // export_rows from the panel. Never fail the run over the projection —
        // but say so LOUDLY once: silent divergence between store and file is
        // exactly the failure mode this design exists to prevent.
        if (!run.pendingExport) {
          run.pendingExport = true;
          run.writeError = e.message;
          await Store.logEvent(run.id, { kind: 'file_write_failed', unitId: unit.id, note: e.message });
          notifyPanel({ event: 'file_write_failed', runId: run.id, note: e.message });
        }
      }
    }
  }
  return { outcome: 'ok', rowsFound: exec.rows.length, fresh, merged, stopHit, suspicious, synthesized, via: exec.via };
}

// ── The loop: fetch state → one page → checkpoint → repeat ────────
async function runLoop(runId) {
  if (activeLoops.has(runId)) return;
  activeLoops.add(runId);
  try {
    for (;;) {
      const run = await Store.getRun(runId);
      if (!run || run.status !== 'running') break;

      // Cost ceiling: extractor synthesis is the runner's only model spend, but
      // a wide run can synthesize many — cap it like the panel loop.
      if ((run.counts.tokens || 0) >= RUNNER_TOKEN_BUDGET) {
        run.status = 'paused';
        run.note = `token budget reached (${run.counts.tokens} tokens) — resume to continue`;
        await Store.saveRun(run);
        await Store.logEvent(runId, { kind: 'budget_stop', note: run.note });
        notifyPanel({ event: 'budget_stop', runId, note: run.note });
        await setBadge('!');
        break;
      }

      const unit = run.plan.units[run.pos.unitIndex];
      if (!unit) {
        run.status = 'done';
        await Store.saveRun(run);
        await Store.logEvent(runId, { kind: 'run_done', pages: run.counts.pages, rows: run.counts.rows });
        notifyPanel({ event: 'run_done', runId, counts: run.counts });
        await closeRunTab(run);
        await setBadge('');
        break;
      }
      if (run.pos.page == null) {
        run.pos.page = unit.pages?.start ?? 1;
        run.pos.pageCount = 0;
      }

      // A stalled page must be ABANDONED, not merely raced: the orphaned
      // processPage would otherwise keep navigating and could write rows or
      // mutate run state after the loop had already moved on.
      const token = { cancelled: false };
      let result;
      try {
        result = await Promise.race([
          processPage(run, unit, token),
          delay(PAGE_TIMEOUT_MS).then(() => {
            token.cancelled = true;
            return { outcome: 'stalled', note: `page exceeded ${PAGE_TIMEOUT_MS / 1000}s budget — skipped` };
          })
        ]);
      } catch (e) {
        result = e.message === '__cancelled__'
          ? { outcome: 'stalled', note: 'page abandoned after timeout' }
          : { outcome: 'error', note: e.message };
      } finally {
        token.cancelled = true; // any late continuation of processPage is a no-op
      }

      run.counts.pages++;
      if (result.fresh) run.counts.rows += result.fresh;
      await Store.logEvent(runId, {
        kind: 'page',
        unitId: unit.id,
        page: run.pos.page,
        outcome: result.outcome,
        rowsFound: result.rowsFound ?? 0,
        fresh: result.fresh ?? 0,
        merged: result.merged ?? 0,
        synthesized: !!result.synthesized,
        note: result.note || result.suspicious || ''
      });

      if (result.outcome === 'human') {
        run.status = 'awaiting_human';
        run.note = result.note;
        await Store.saveRun(run); // resume re-enters at this exact page
        notifyPanel({ event: 'awaiting_human', runId, note: result.note, unitId: unit.id, page: run.pos.page });
        await setBadge('!');
        break;
      }

      const step = decideUnitProgress({
        outcome: result.outcome,
        stopHit: result.stopHit,
        pos: run.pos,
        unit,
        failStreak: run.unitFailStreak,
        failLimit: UNIT_FAIL_LIMIT
      });
      run.unitFailStreak = step.failStreak;

      if (step.unitDone) {
        await Store.logEvent(runId, {
          kind: step.blocked ? 'unit_blocked' : 'unit_done',
          unitId: unit.id,
          page: run.pos.page,
          reason: step.reason,
          note: result.note || ''
        });
        if (step.blocked) notifyPanel({ event: 'unit_blocked', runId, unitId: unit.id, note: result.note || step.reason });
        run.pos.unitIndex++;
      }
      run.pos.page = step.nextPage;
      run.pos.pageCount = step.nextPageCount;

      // Checkpoint after EVERY page — but never clobber a control change (e.g.
      // a pause) that landed while this page was being worked.
      const latest = await Store.getRun(runId);
      const rec = reconcileCheckpoint(run, latest);
      await Store.saveRun(rec.record);
      if (rec.stop) {
        await Store.logEvent(runId, { kind: 'loop_yielded', note: 'external status: ' + rec.externalStatus });
        notifyPanel({ event: 'progress', runId, unitId: unit.id, unitIndex: run.pos.unitIndex, units: run.plan.units.length, page: run.pos.page, counts: run.counts, outcome: result.outcome });
        break; // honour pause/stop immediately
      }
      notifyPanel({ event: 'progress', runId, unitId: unit.id, unitIndex: run.pos.unitIndex, units: run.plan.units.length, page: run.pos.page, counts: run.counts, outcome: result.outcome });
      await delay(PAGE_DELAY_MS);
    }
  } finally {
    activeLoops.delete(runId);
  }
}

// ── Commands ──────────────────────────────────────────────────────
export async function startRun(runId) {
  const run = await Store.getRun(runId);
  if (!run) return { ok: false, error: 'run not found: ' + runId };
  if (run.status === 'running') {
    runLoop(runId);
    return { ok: true, note: 'already running — loop (re)attached' };
  }
  if (!['draft', 'paused', 'awaiting_human', 'failed'].includes(run.status)) {
    return { ok: false, error: 'run is ' + run.status };
  }
  run.status = 'running';
  run.note = '';
  await Store.saveRun(run);
  await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 0.5 });
  await setBadge('▶');
  runLoop(runId);
  return { ok: true, note: 'running from unit ' + (run.pos.unitIndex + 1) + (run.pos.page != null ? ', page ' + run.pos.page : '') };
}

export async function pauseRun(runId) {
  const run = await Store.getRun(runId);
  if (!run) return { ok: false, error: 'run not found' };
  if (run.status !== 'running' && run.status !== 'awaiting_human') return { ok: false, error: 'run is ' + run.status };
  run.status = 'paused';
  await Store.saveRun(run);
  await setBadge('');
  return { ok: true, note: 'paused — fully resumable' };
}

// Can THIS context (the service worker) actually write to the workspace folder?
// Whether a File System Access handle stored by the panel stays writable from a
// worker is environment-dependent, so the runner proves it up front instead of
// discovering it mid-run — a failure means rows accumulate in the store and the
// file only catches up via export_rows, which the user must know BEFORE a long
// unattended run rather than after.
export async function checkWorkerFileAccess() {
  const probe = 'bat-write-probe.tmp';
  try {
    await writeFile(probe, 'worker write ok\n', { append: false });
    await removeFile(probe).catch(() => {}); // don't leave litter in the user's folder
    return { ok: true, note: 'service worker CAN write to the workspace folder' };
  } catch (e) {
    return {
      ok: false,
      error: e.message,
      note: 'service worker CANNOT write files — background runs will keep rows safe in the store, '
        + 'but the output file only updates when you run export_rows from the panel'
    };
  }
}

export async function getRunStatus(runId) {
  const run = await Store.getRun(runId);
  if (!run) return { ok: false, error: 'run not found' };
  const log = await Store.getRunLog(runId);
  return {
    ok: true,
    run: {
      id: run.id,
      status: run.status,
      note: run.note || '',
      unitIndex: run.pos.unitIndex,
      units: run.plan.units.length,
      page: run.pos.page,
      counts: run.counts,
      pendingExport: !!run.pendingExport,
      filename: run.plan.filename
    },
    recent: log.slice(-10)
  };
}

// ── Wiring (extension context only — pure helpers stay Node-testable) ──
if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'BAT_RUN_CMD') return false;
    (async () => {
      try {
        if (message.cmd === 'start' || message.cmd === 'resume') sendResponse(await startRun(message.runId));
        else if (message.cmd === 'pause') sendResponse(await pauseRun(message.runId));
        else if (message.cmd === 'status') sendResponse(await getRunStatus(message.runId));
        else if (message.cmd === 'check_write') sendResponse(await checkWorkerFileAccess());
        else sendResponse({ ok: false, error: 'unknown cmd: ' + message.cmd });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  });

  const reviveRunning = async () => {
    try {
      const runs = await Store.listRuns();
      const running = runs.filter((r) => r.status === 'running');
      if (!running.length) {
        chrome.alarms.clear(WATCHDOG_ALARM).catch(() => {});
        return;
      }
      for (const r of running) runLoop(r.id); // no-op if already looping here
    } catch (_) {}
  };

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === WATCHDOG_ALARM) reviveRunning();
  });
  chrome.runtime.onStartup.addListener(reviveRunning);
  reviveRunning(); // worker woke for any reason → reattach orphaned loops
}
