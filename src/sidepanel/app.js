import '../lib/browser-tools.js';
import '../lib/page-tools.js';
import accessibilityTreeScript from '../content/accessibility-tree.js?script';
import {
  DEFAULT_MODEL,
  DEEPSEEK_DEFAULT_KEY,
  MODEL_OPTIONS,
  MAX_STUCK,
  MAX_STEPS,
  FOCUS_TREE_CHARS,
  FOCUS_QUIZ_TREE_CHARS,
  FOCUS_TEXT_CHARS,
  RESUME_DIALOG_WAIT_MS,
  SUBMIT_CLICK_RE,
  QUIZ_FAIL_RE,
  QUIZ_PASS_RE,
  RESUME_DIALOG_RE,
  ACTIVITY_PHASES,
  VISION_SUPPORTED,
  RUN_TOKEN_BUDGET
} from '../shared/constants.js';
import { parseAgentResponse, normalizeAction } from '../agent/parse.js';
import * as Workspace from '../lib/workspace.js';
import { appendRows as writerAppendRows, writeAll as writerWriteAll } from '../lib/output-writer.js';
import * as Store from '../lib/state-store.js';
import * as Extractors from '../lib/extractors.js';
import { runExtractor } from '../lib/extractor-exec.js';
import { validatePlan, STOP_PATTERNS, fillTemplate } from '../lib/plan.js';
import { SITE_CONFIGS } from '../shared/site-configs.js';
import * as Allowlist from '../lib/allowlist.js';
import { screenExtractorSource } from '../lib/extractor-screen.js';
import { compileGuardedRegex } from '../lib/regex-guard.js';
import * as SiteVerify from '../lib/site-verification.js';
import { buildSystemPrompt } from './prompt.js';
import { activeToolDefs } from './tool-defs.js';
import { callDeepSeekAPI } from './deepseek.js';

// Side panel entry: renders the chat UI and runs the agent loop.

// ── State ─────────────────────────────────────────────────────────
let currentModel    = DEFAULT_MODEL;
let apiKey          = '';
let session         = [];   // unified chat + tool-call history (persists across sends)
let nativeToolsEnabled = true; // flips to false if the model rejects the tools param
let reasoningParamsSupported = true; // flips to false if the model rejects reasoning_effort/thinking
let currentGoal       = '';
let debugLog          = [];
let currentRunId      = null;
let currentTab      = null;
let isProcessing    = false;
let stopRequested   = false;
let apiAbortController = null;
let agentTabIdActive = null;
let visionEnabled   = VISION_SUPPORTED; // DeepSeek cannot read images — off unless the constant flips
let allowedSites    = [];    // empty = act on NO site (fails closed)
let allowAllSites   = false; // explicit opt-out of the allowlist entirely
let usageTotals     = { prompt: 0, completion: 0, requests: 0 };
let uiLog           = [];    // rendered transcript, persisted for panel reopen
let restoringUi     = false;
let queuedMessages  = [];    // messages typed while the agent is running

// Maps tabId → { globalRef → { frameId, localRef, label? } }
// Each iframe assigns ref_1, ref_2… independently; we renumber on merge so clicks hit the right frame.
const tabRefRegistry = new Map();

// Persistent per-tab numbering: the same (frameId, localRef) keeps the same
// global ref across observations, so refs the model already knows stay valid
// instead of silently pointing at a different element after each re-read.
const tabRefNumbering = new Map(); // tabId → { byKey: Map('frameId:localRef' → globalRef), counter }

function getRefNumbering(tabId) {
  let n = tabRefNumbering.get(tabId);
  if (!n) {
    n = { byKey: new Map(), counter: 0 };
    tabRefNumbering.set(tabId, n);
  }
  return n;
}

// A top-level navigation makes a new document whose local refs restart at 1 —
// reset the numbering so old globals can't be recycled onto unrelated elements.
//
// The REGISTRY has to go too. It used to survive navigation (only cleared on tab
// close), so between a navigation and the next observation, resolveRefTarget
// would happily return a (frameId, localRef) pair from the PREVIOUS document —
// and since local refs restart at 1 in the new one, a click could silently land
// on a completely unrelated element. Losing the registry costs one "ref not
// found, re-read the page"; keeping a stale one costs a wrong click.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') {
    tabRefNumbering.delete(tabId);
    tabRefRegistry.delete(tabId);
    tabCourseMode.delete(tabId);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  tabRefRegistry.delete(tabId);
  tabRefNumbering.delete(tabId);
  tabCourseMode.delete(tabId);
});

// find returns frame-LOCAL refs — translate them into the global ref space the
// model uses (a local "ref_5" could otherwise collide with an unrelated global
// ref_5 and click the wrong element). Mints stable globals for new elements.
function globalizeFindHits(tabId, hits) {
  const numbering = getRefNumbering(tabId);
  const registry = tabRefRegistry.get(tabId) || {};
  const out = [];
  for (const h of hits || []) {
    if (!h.ref) { out.push(h); continue; }
    const frameId = h.frameId ?? 0;
    const key = frameId + ':' + h.ref;
    let globalRef = numbering.byKey.get(key);
    if (!globalRef) {
      globalRef = 'ref_' + (++numbering.counter);
      numbering.byKey.set(key, globalRef);
    }
    if (!registry[globalRef]) {
      registry[globalRef] = { frameId, localRef: h.ref, label: h.label || '', role: h.role || '' };
    }
    out.push({ ...h, ref: globalRef });
  }
  tabRefRegistry.set(tabId, registry);
  return out;
}

// ── Page mode: course (SCORM/quiz) vs general ─────────────────────
// The quiz/resume machinery is expensive and actively harmful on general pages
// (job sites have "Resume" buttons and checkbox filters), so it only runs when
// the page shows a strong course signature. Detected per tab, per document.
const tabCourseMode = new Map(); // tabId → bool

const COURSE_MODE_RE = /scorm|storyline|captivate|articulate|\brise 360\b|progress check|click check to|single choice question|answer the question below|would you like to resume/i;

const pageBlobCache = new WeakMap();
function pageBlob(pageData) {
  let cached = pageBlobCache.get(pageData);
  if (!cached) {
    const blob = [
      pageData?.accessibilityTree,
      pageData?.text,
      pageData?.enrichedText
    ].filter(Boolean).join('\n');
    cached = { blob, lower: blob.toLowerCase() };
    pageBlobCache.set(pageData, cached);
  }
  return cached;
}

function updateCourseMode(tabId, pageData) {
  const { lower } = pageBlob(pageData);
  const probe = lower + ' ' + (pageData?.url || '').toLowerCase();
  const on = COURSE_MODE_RE.test(probe) || RESUME_DIALOG_RE.test(lower);
  tabCourseMode.set(tabId, on);
  return on;
}

const EMPTY_QUIZ = Object.freeze({
  isQuiz: false, multi: false, checked: 0, total: 0,
  feedback: Object.freeze({ failed: false, passed: false, snippet: '' }),
  selectedInTree: 0
});

// ── DOM refs ──────────────────────────────────────────────────────
const chatEl        = document.getElementById('chat');
const promptInput   = document.getElementById('promptInput');
const sendBtn       = document.getElementById('sendBtn');
const stopBtn       = document.getElementById('stopBtn');
const clearChatBtn  = document.getElementById('clearChatBtn');
const copyDebugBtn  = document.getElementById('copyDebugBtn');
const debugStatusEl = document.getElementById('debugStatus');
const modelSelect   = document.getElementById('modelSelect');
const modelHintEl   = document.getElementById('modelHint');
const settingsBtn   = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settingsPanel');
const keyInput      = document.getElementById('keyInput');
const saveKeyBtn    = document.getElementById('saveKeyBtn');
const keyStatusEl   = document.getElementById('keyStatus');
const sitesStatusEl = document.getElementById('sitesStatus');
const workspaceBtn  = document.getElementById('workspaceBtn');
const workspaceStatusEl = document.getElementById('workspaceStatus');
const allowAllToggle = document.getElementById('allowAllToggle');
const allowCurrentBtn = document.getElementById('allowCurrentBtn');
const dataBtn       = document.getElementById('dataBtn');
const dataPanel     = document.getElementById('dataPanel');
const dataBody      = document.getElementById('dataBody');
const dataCloseBtn  = document.getElementById('dataCloseBtn');
const dataStatusEl  = document.getElementById('dataStatus');

// ── Helpers ───────────────────────────────────────────────────────
const delay = (ms) => new Promise((r) => { setTimeout(r, ms); });

function getActiveKey() {
  return apiKey || DEEPSEEK_DEFAULT_KEY || null;
}

function updateSendEnabled() {
  const hasKey = !!getActiveKey();
  const hasText = !!(promptInput?.value.trim());
  // Typing stays enabled during a run — messages sent mid-run are queued and
  // delivered to the agent at its next step.
  if (sendBtn) sendBtn.disabled = !hasKey || !hasText;
  if (promptInput) promptInput.disabled = !hasKey;
  if (stopBtn) stopBtn.classList.toggle('visible', isProcessing);
  if (modelSelect) modelSelect.disabled = isProcessing;
}

// System prompt and tool schemas now live in their own modules.

function getModelLabel(modelId = currentModel) {
  return MODEL_OPTIONS.find(m => m.id === modelId)?.label || modelId;
}

function modelSupportsThinking(modelId) {
  return modelId === 'deepseek-v4-pro' || modelId === 'deepseek-v4-flash';
}

function updateModelHint() {
  if (modelHintEl) {
    modelHintEl.textContent = `${getModelLabel()} · Ask anything · Command to control page`;
  }
}

async function loadModel() {
  const s = await chrome.storage.local.get(['bat_model']);
  const saved = s.bat_model;
  if (saved && MODEL_OPTIONS.some(m => m.id === saved)) {
    currentModel = saved;
  }
  if (modelSelect) {
    modelSelect.value = currentModel;
    modelSelect.disabled = isProcessing;
  }
  updateModelHint();
}

function saveModel(modelId) {
  currentModel = modelId;
  chrome.storage.local.set({ bat_model: modelId })
    .catch((e) => debugEntry('save_model_failed', { modelId, error: e?.message }));
  if (modelSelect) modelSelect.value = modelId;
  updateModelHint();
}

// ── Agent loop: read_page tree + left_click by ref via CDP ────────
function normalizeTreeFingerprint(tree) {
  // Compare the WHOLE normalized tree — slicing here made changes below the
  // cut-off read as UNCHANGED, sending the model into false stuck-escalation.
  return (tree || '')
    .replace(/\[ref_\d+\]/g, '[ref]')
    .replace(/\bref_\d+\b/g, 'ref')
    .replace(/--- iframe[^)]*\) ---/g, '--- iframe ---')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectResumeDialog(pageData) {
  const { blob, lower } = pageBlob(pageData);
  const hasResumeBtn = /\bbutton\s+"resume"/i.test(blob)
    || /\b"resume"\s*\[ref/i.test(blob)
    || /\bresume\b[^\n]{0,40}\[ref_\d+\]/i.test(blob);
  const hasRestartBtn = /\bbutton\s+"restart"/i.test(blob)
    || /\brestart\b[^\n]{0,40}\[ref_\d+\]/i.test(blob);
  // Strict: a bare "Resume" button (job sites, CV uploads) must NOT count as a
  // SCORM dialog. Require the dialog phrasing, or BOTH buttons inside a dialog.
  const open = (hasResumeBtn || hasRestartBtn)
    && (RESUME_DIALOG_RE.test(lower)
      || (hasResumeBtn && hasRestartBtn && /pop.?up|dialog|alertdialog/i.test(lower)));
  return { open, hasResume: hasResumeBtn, hasRestart: hasRestartBtn };
}

function findDialogButtonRefs(tabId) {
  const registry = tabRefRegistry.get(tabId);
  if (!registry) return { resume: null, restart: null };
  let resume = null;
  let restart = null;
  for (const [ref, entry] of Object.entries(registry)) {
    const lab = (entry.label || '').replace(/\s+/g, ' ').trim();
    const low = lab.toLowerCase();
    if (!resume && low === 'resume') resume = { ref, ...entry };
    if (!restart && low === 'restart') restart = { ref, ...entry };
  }
  return { resume, restart };
}

function buildResumeDialogHint(pageData, tabId, resumeClickStreak) {
  const dialog = pageData?.resumeDialog || { open: false };
  if (!dialog.open) return '';
  const refs = findDialogButtonRefs(tabId);
  let hint = 'resume_dialog: OPEN — dismiss before course content.\n';
  if (refs.resume) hint += `Resume button: ${refs.resume.ref}\n`;
  if (refs.restart) hint += `Restart button: ${refs.restart.ref}\n`;
  if (resumeClickStreak >= 2) {
    const alt = refs.restart ? `left_click ${refs.restart.ref} (Restart)` : 'Next Slide or scroll_down';
    hint += `WARNING: Resume failed ${resumeClickStreak} times — try ${alt}. Do NOT click Resume again.\n`;
  } else {
    hint += 'Click Resume once, wait for SCORM to load. If dialog stays, click Restart.\n';
  }
  return hint;
}

function getClickLabel(action, tabId) {
  const parts = [(action?.text || '')];
  const reg = tabRefRegistry.get(tabId);
  if (action?.ref && reg?.[action.ref]?.label) parts.push(reg[action.ref].label);
  return parts.join(' ').toLowerCase();
}

function isSubmitLikeClick(action, tabId) {
  if (!action || action.action !== 'left_click') return false;
  return SUBMIT_CLICK_RE.test(getClickLabel(action, tabId));
}

function isCheckClick(action, tabId) {
  if (!action || action.action !== 'left_click') return false;
  return /\bcheck\b/i.test(getClickLabel(action, tabId));
}

function isResumeLikeClick(action, tabId) {
  if (!action || action.action !== 'left_click') return false;
  const lab = getClickLabel(action, tabId).replace(/\s+/g, ' ').trim();
  return /^resume\b/i.test(lab) || /\bclick resume\b/i.test(lab);
}

function isRestartLikeClick(action, tabId) {
  if (!action || action.action !== 'left_click') return false;
  const lab = getClickLabel(action, tabId).replace(/\s+/g, ' ').trim();
  return /^restart\b/i.test(lab) || /\bclick restart\b/i.test(lab);
}

function isDialogNavClick(action, tabId) {
  return isResumeLikeClick(action, tabId) || isRestartLikeClick(action, tabId);
}

function detectQuizPage(pageData) {
  const { blob, lower } = pageBlob(pageData);
  const total = pageData?.checkboxSummary?.length || 0;
  const checked = pageData?.checkboxSummary?.filter(c => c.checked).length || 0;
  const isQuiz = /progress check|click check|select the \d+|single choice|answer the question/i.test(lower)
    || (total >= 2 && /checkbox/i.test(lower));
  const multi = /select (?:the )?\d+|multi[- ]?select|select all/i.test(lower) || total >= 4;
  const feedback = analyzePageFeedback(blob);
  const selectedInTree = countAnsweredInTree(pageData?.accessibilityTree || '', pageData);
  return { isQuiz, multi, checked, total, feedback, selectedInTree };
}

function countAnsweredInTree(tree, pageData) {
  const selected = (tree.match(/\(selected\)|\(checked\)/gi) || []).length;
  const checked = pageData?.checkboxSummary?.filter(c => c.checked).length || 0;
  return Math.max(selected, checked);
}

function scoreTreeSection(section) {
  const lower = section.toLowerCase();
  let score = 0;
  if (/progress check|click check/i.test(lower)) score += 50;
  score += (section.match(/checkbox/gi) || []).length * 3;
  score += (section.match(/radio/gi) || []).length * 2;
  score += (section.match(/\[ref_\d+\]/g) || []).length;
  return score;
}

function extractFocusedTree(tree, pageData) {
  if (!tree) return '';
  const quiz = pageData?.quizInfo || EMPTY_QUIZ;
  const limit = quiz.isQuiz ? FOCUS_QUIZ_TREE_CHARS : FOCUS_TREE_CHARS;
  const parts = tree.split(/(?=--- iframe)/i);
  if (!quiz.isQuiz || parts.length <= 1) {
    return tree.length > limit ? tree.slice(0, limit) + '\n[truncated]' : tree;
  }
  let best = parts[0];
  let bestScore = scoreTreeSection(parts[0]);
  for (let i = 1; i < parts.length; i++) {
    const s = scoreTreeSection(parts[i]);
    if (s > bestScore) { bestScore = s; best = parts[i]; }
  }
  const focused = (bestScore >= 8 ? best : tree).slice(0, limit);
  return `--- quiz frame (focused) ---\n${focused}${focused.length >= limit ? '\n[truncated]' : ''}`;
}

function extractFocusedText(text, pageData) {
  if (!text) return '';
  const quiz = pageData?.quizInfo || EMPTY_QUIZ;
  if (!quiz.isQuiz) return text.slice(0, FOCUS_TEXT_CHARS);
  const parts = text.split(/(?=--- iframe)/i);
  if (parts.length <= 1) return text.slice(0, FOCUS_TEXT_CHARS);
  let best = parts[0];
  let bestScore = scoreTreeSection(parts[0]);
  for (let i = 1; i < parts.length; i++) {
    const s = scoreTreeSection(parts[i]);
    if (s > bestScore) { bestScore = s; best = parts[i]; }
  }
  const chunk = (bestScore >= 8 ? best : text).slice(0, FOCUS_TEXT_CHARS);
  return `--- quiz text (focused) ---\n${chunk}`;
}

async function scrollQuizIntoView(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      injectImmediately: true,
      world: 'ISOLATED',
      func: () => {
        const kw = /progress check|click check|select the \d+/i;
        const body = document.body?.innerText || '';
        if (!kw.test(body.slice(0, 4000))) return false;
        const pick = document.querySelector(
          'input[type="checkbox"], [role="checkbox"], input[type="radio"], [role="radio"], button, [role="button"]'
        );
        const block = pick?.closest('div, section, form, article, main') || pick;
        if (block) {
          block.scrollIntoView({ behavior: 'instant', block: 'start' });
          window.scrollBy(0, -60);
          return true;
        }
        window.scrollTo(0, 0);
        return true;
      }
    });
    await delay(450);
  } catch (e) {
    debugEntry('scroll_quiz_failed', { tabId, error: e?.message || String(e) });
  }
}

function analyzePageFeedback(text) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  const lower = t.toLowerCase();
  const failed = QUIZ_FAIL_RE.test(lower);
  const passed = !failed && QUIZ_PASS_RE.test(lower);
  return { failed, passed, snippet: t.slice(0, 240) };
}

// Prefer dedicated feedback/alert regions — scanning the whole body makes
// instructional text like "if this is incorrect…" read as a failed submit.
async function readPageFeedback(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      injectImmediately: true,
      world: 'ISOLATED',
      func: () => {
        const sel = '[role="alert"], [role="status"], [aria-live="polite"], [aria-live="assertive"], '
          + '[class*="feedback"], [class*="Feedback"], [id*="feedback"], '
          + '[class*="quiz-result"], [class*="review-area"], [class*="response-area"]';
        const parts = [];
        for (const el of document.querySelectorAll(sel)) {
          const s = window.getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden') continue;
          const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
          if (t.length > 2) parts.push(t);
        }
        const scopedText = [...new Set(parts)].join('\n').slice(0, 4000);
        if (scopedText.length >= 8) return { scoped: true, text: scopedText };
        return {
          scoped: false,
          text: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 10000)
        };
      }
    });
    const frames = (results || []).map(r => r.result).filter(Boolean);
    const scoped = frames.filter(f => f.scoped);
    const text = (scoped.length ? scoped : frames).map(f => f.text).join('\n');
    return { text, ...analyzePageFeedback(text) };
  } catch (e) {
    debugEntry('read_feedback_failed', { tabId, error: e?.message || String(e) });
    return { text: '', failed: false, passed: false, snippet: '' };
  }
}

function getBatchStepDelay(currentStep, nextStep, tabId) {
  const courseMode = tabCourseMode.get(tabId) === true;
  if (courseMode && nextStep && isSubmitLikeClick(nextStep, tabId)) return 1400;
  if (currentStep?.action === 'form_input') return courseMode ? 700 : 350;
  return 350;
}

function buildQuizPhaseHint(pageData) {
  const quiz = pageData?.quizInfo || EMPTY_QUIZ;
  if (!quiz.isQuiz) return '';
  if (quiz.feedback.failed) return 'quiz_phase: FAILED — change answers, click Check\n';
  if (quiz.multi && quiz.checked > 0 && /click check|progress check/i.test((pageData?.accessibilityTree || '').toLowerCase())) {
    return 'quiz_phase: SELECTED — click Check next (do not click Next yet)\n';
  }
  if (quiz.selectedInTree === 0 && quiz.checked === 0) return 'quiz_phase: READ — select answer(s) first\n';
  if (quiz.feedback.passed) return 'quiz_phase: PASSED — you may click Next\n';
  return 'quiz_phase: ACTIVE — answer → Check → then Next\n';
}

async function executeAgentAction(tabId, action) {
  if (stopRequested) return { success: false, error: 'stopped' };

  const BT = window.BrowserTools;
  const PT = window.PageTools;
  if (!BT) return { success: false, error: 'BrowserTools not loaded' };

  switch (action.action) {
    case 'batch': {
      const steps = action.actions || [];
      const notes = [];
      for (let i = 0; i < steps.length; i++) {
        if (stopRequested) return { success: false, error: 'stopped', detail: notes.join('; ') };
        const r = await executeAgentAction(tabId, steps[i]);
        notes.push(`${steps[i].action}: ${r.success ? 'ok' : r.error || 'fail'}`);
        if (!r.success) return { success: false, error: r.error, detail: notes.join('; ') };
        if (i < steps.length - 1) {
          await BT.delay(getBatchStepDelay(steps[i], steps[i + 1], tabId));
        }
      }
      return { success: true, detail: notes.join('; ') };
    }
    case 'left_click': {
      const courseMode = tabCourseMode.get(tabId) === true;
      const dialogNav = courseMode && (isDialogNavClick(action, tabId) || !!extractDialogTargetLabel(action.text));
      let result = await clickByRef(tabId, action.ref, action.text, { preferCdp: dialogNav, forceCdp: !!action.forceCdp });
      if (result.success) {
        if (dialogNav) {
          await BT.delay(RESUME_DIALOG_WAIT_MS);
        } else {
          await BT.waitForPageIdle(tabId);
        }
        if (dialogNav) {
          const pageCheck = await getPageContent(tabId);
          if (pageCheck && detectResumeDialog(pageCheck).open) {
            if (result.method !== 'cdp') {
              const retry = await clickByRef(tabId, action.ref, action.text, { forceCdp: true });
              if (retry.success) {
                result = retry;
                await BT.delay(RESUME_DIALOG_WAIT_MS);
              }
            }
            const recheck = await getPageContent(tabId);
            if (recheck && detectResumeDialog(recheck).open) {
              result.dialogStillOpen = true;
              result.detail = (result.detail ? result.detail + ' — ' : '') + 'dialog still open after click';
            }
          }
        }
      }
      if (result.success && courseMode && (isSubmitLikeClick(action, tabId) || isCheckClick(action, tabId))) {
        await BT.delay(isCheckClick(action, tabId) ? 1200 : 900);
        const feedback = await readPageFeedback(tabId);
        if (feedback.failed) {
          return {
            success: false,
            error: 'Submit/check rejected by page',
            label: result.label,
            detail: feedback.snippet || 'incorrect or try again'
          };
        }
        if (feedback.passed) {
          result.detail = (result.detail ? result.detail + ' — ' : '') + 'quiz passed: ' + feedback.snippet;
        }
      }
      return result;
    }
    case 'form_input': {
      const { frameId, localRef } = await resolveRefTarget(tabId, action.ref);
      const result = await BT.formSetRef(tabId, frameId, localRef, action.value);
      if (result.success) await BT.delay(250);
      return result;
    }
    case 'scroll_to': {
      const { frameId, localRef } = await resolveRefTarget(tabId, action.ref);
      return BT.scrollToRef(tabId, frameId, localRef);
    }
    case 'scroll_down':
      return BT.scroll(tabId, 'down');
    case 'scroll_up':
      return BT.scroll(tabId, 'up');
    case 'scroll_bottom':
      return BT.scrollToEnd ? BT.scrollToEnd(tabId) : BT.scroll(tabId, 'down');
    case 'find': {
      if (!PT?.findOnPage) return { success: false, error: 'PageTools not loaded' };
      const rawHits = await PT.findOnPage(tabId, action.value || action.text);
      const hits = globalizeFindHits(tabId, rawHits);
      return {
        success: true,
        detail: hits.length ? `found ${hits.length} match(es)` : 'no matches',
        label: hits.slice(0, 5).map(h => (h.ref || '?') + ': ' + h.label).join('; ')
      };
    }
    case 'type': {
      const coords = await getRefCoordinates(tabId, action.ref);
      if (!coords) {
        const { frameId, localRef } = await resolveRefTarget(tabId, action.ref);
        const domResult = await BT.typeIntoRef(tabId, frameId, localRef, action.value, true);
        if (domResult.success) await BT.waitForPageIdle(tabId);
        return domResult;
      }
      const onCursor = (x, y, a) => updatePhantomCursor(tabId, x, y, a);
      const result = await BT.typeAtCoords(tabId, coords.x, coords.y, action.value, onCursor);
      if (result.success) await BT.waitForPageIdle(tabId);
      return result;
    }
    case 'click_coords': {
      if (!Number.isFinite(action.x) || !Number.isFinite(action.y)) {
        return { success: false, error: 'click_coords needs numeric x and y' };
      }
      try {
        const onCursor = (x, y, a) => updatePhantomCursor(tabId, x, y, a);
        await BT.cdpClick(tabId, action.x, action.y, onCursor, { button: action.button, double: action.double });
        await BT.waitForPageIdle(tabId);
        return {
          success: true,
          detail: `clicked at (${action.x}, ${action.y})`
            + (action.double ? ' double' : '') + (action.button === 'right' ? ' right-button' : '')
        };
      } catch (e) {
        return { success: false, error: e.message || 'coordinate click failed' };
      }
    }
    case 'key':
      return BT.keyPress(tabId, action.key);
    case 'navigate':
      return BT.navigate(tabId, action.url);
    case 'go_back':
      return BT.goBack(tabId);
    case 'go_forward':
      return BT.goForward(tabId);
    case 'refresh':
      return BT.refresh(tabId);
    case 'javascript': {
      let frameId = null;
      if (action.ref) {
        const t = await resolveRefTarget(tabId, action.ref);
        frameId = t.frameId;
      }
      return BT.runJavaScript(tabId, action.value, frameId);
    }
    case 'wait':
      await BT.delay(1500);
      return { success: true, detail: 'waited' };
    default:
      return { success: false, error: 'Unknown action: ' + action.action };
  }
}

function countRefsInTree(tree) {
  if (!tree) return 0;
  const m = tree.match(/\[ref_\d+\]/g);
  return m ? m.length : 0;
}

// ── Unified agent loop: native tool calling, full history, budget pruning ──
const CONTEXT_CHAR_BUDGET = 100000;   // compaction trigger
const COMPACT_TARGET_CHARS = 60000;   // compact well below the trigger in ONE pass
const KEEP_RECENT_MESSAGES = 12;      // newest messages are never touched

function messageContentLength(c) {
  if (typeof c === 'string') return c.length;
  if (Array.isArray(c)) {
    // Screenshot messages: count text parts AND the base64 image payload —
    // otherwise a 300KB screenshot is invisible to the budget.
    return c.reduce((n, p) => n + (p?.text?.length || 0) + (p?.image_url?.url?.length || 0), 0);
  }
  return 0;
}

// DeepSeek bills cached-prefix input ~10× cheaper, and the cache keys on a
// byte-stable message prefix — so compaction must be RARE and CHUNKY. A
// per-step trickle of in-place edits would invalidate the prefix on every
// call exactly when the context is biggest. Instead: when the budget trips,
// compact well below it in one pass (oldest first), then leave the prefix
// untouched until the next trip.
// A dropped span is replaced by ONE marker, so the model is told history was
// removed rather than being left to infer it from a gap.
const DROP_MARKER = '__batDropped';

function pruneSessionForBudget() {
  // Running total, not a rescan. sessionSize() used to be recomputed INSIDE the
  // trim loop — O(messages²) work on the largest contexts, i.e. exactly when the
  // panel could least afford it.
  let total = session.reduce((n, m) => n + messageContentLength(m.content), 0);
  if (total <= CONTEXT_CHAR_BUDGET) return;

  const trimEnd = session.length - KEEP_RECENT_MESSAGES;

  // Pass 1 — trim oldest-first, as before.
  for (let i = 0; i < trimEnd && total > COMPACT_TARGET_CHARS; i++) {
    const m = session[i];
    if (m.pruned || typeof m.content !== 'string') continue;
    let replacement = null;
    if ((m.role === 'tool' || m.legacyToolResult) && m.content.length > 400) {
      replacement = m.content.slice(0, 250) + '\n[older observation trimmed — call read_page for current state]';
    } else if ((m.role === 'user' || m.role === 'assistant') && m.content.length > 600) {
      replacement = m.content.slice(0, 400) + '\n[older message trimmed]';
    }
    if (replacement == null) continue;
    total -= m.content.length - replacement.length;
    m.content = replacement;
    m.pruned = true;
  }

  // Pass 2 — trimming alone could not converge. Every already-trimmed message
  // keeps ~250 chars, so a long run accumulated a floor ABOVE the target: the
  // loop then re-walked the whole session every step and never got under it.
  // Once trimming is exhausted the only honest move is to drop history.
  if (total <= COMPACT_TARGET_CHARS) return;
  dropOldestMessages(total);
}

// Drops the oldest messages outright, keeping the tool_call/tool_result pairing
// intact — an assistant message with tool_calls whose results were dropped makes
// the next API call fail outright, so a call and its results move together.
function dropOldestMessages(total) {
  const keepFrom = session.length - KEEP_RECENT_MESSAGES;
  let cut = 0;
  let droppedChars = 0;
  let droppedCount = 0;

  while (cut < keepFrom && total - droppedChars > COMPACT_TARGET_CHARS) {
    const m = session[cut];
    // An assistant turn takes its tool results with it.
    let span = 1;
    if (m.role === 'assistant' && m.tool_calls?.length) {
      while (cut + span < keepFrom && session[cut + span].role === 'tool') span++;
    } else if (m.role === 'tool') {
      // A stray tool result whose assistant turn already went — drop it, it is
      // unanswerable on its own.
      span = 1;
    }
    if (cut + span > keepFrom) break;
    for (let i = cut; i < cut + span; i++) {
      droppedChars += messageContentLength(session[i].content);
      droppedCount++;
    }
    cut += span;
  }

  if (!cut) return;
  // A tool result whose assistant turn is gone makes the API reject the whole
  // request, so never let the surviving history begin with one.
  while (cut < session.length && session[cut].role === 'tool') cut++;
  const marker = {
    role: 'user',
    [DROP_MARKER]: true,
    pruned: true,
    content: `[${droppedCount} older message(s) dropped to stay within the context budget. `
      + `Earlier history is gone — re-read the page or a workspace file if you need it. `
      + `Anything that must survive belongs in save_file / collect_rows, not in this conversation.]`
  };
  session = [marker, ...session.slice(cut)];
  debugEntry('session_dropped', { messages: droppedCount, chars: droppedChars, remaining: session.length });
}

// Every assistant tool_call must be followed by a matching tool result, or the
// next API call is rejected. Backfill stubs for calls interrupted by Stop/errors.
function repairSessionToolCalls() {
  const fixed = [];
  for (let i = 0; i < session.length; i++) {
    const m = session[i];
    fixed.push(m);
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const answered = new Set();
      let j = i + 1;
      while (j < session.length && session[j].role === 'tool') {
        answered.add(session[j].tool_call_id);
        fixed.push(session[j]);
        j++;
      }
      for (const tc of m.tool_calls) {
        if (!answered.has(tc.id)) {
          fixed.push({ role: 'tool', tool_call_id: tc.id, content: 'Interrupted — no result.' });
        }
      }
      i = j - 1;
    }
  }
  session = fixed;
}

function sanitizeAssistantMessage(msg) {
  return {
    role: 'assistant',
    content: msg.content || '',
    ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {})
  };
}

function pushToolResult(tc, content) {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  if (tc.legacy) {
    session.push({ role: 'user', content: `Tool result (${tc.function.name}):\n${text}`, legacyToolResult: true });
  } else {
    session.push({ role: 'tool', tool_call_id: tc.id, content: text });
  }
  persistSession();
}

function summarizeArgs(args) {
  try {
    const s = JSON.stringify(args);
    return s.length > 200 ? s.slice(0, 200) + '…' : s;
  } catch { return ''; }
}

// Legacy fallback: model wrote a JSON action in plain text instead of a tool call
function legacyActionToToolCall(a, i) {
  const mk = (name, args) => ({ legacy: true, id: 'legacy_' + i, function: { name, arguments: JSON.stringify(args) } });
  switch (a.action) {
    case 'left_click':  return mk('left_click', { ref: a.ref, description: a.text || '' });
    case 'form_input':  return mk('form_input', { ref: a.ref, value: String(a.value) });
    case 'type':        return mk('type', { ref: a.ref, text: String(a.value ?? '') });
    case 'key':         return mk('press_key', { key: a.key });
    case 'scroll_down': return mk('scroll', { direction: 'down' });
    case 'scroll_up':   return mk('scroll', { direction: 'up' });
    case 'scroll_to':   return mk('scroll_to', { ref: a.ref });
    case 'find':        return mk('find', { query: a.value || a.text || '' });
    case 'navigate':    return mk('navigate', { url: a.url });
    case 'go_back':     return mk('go_back', {});
    case 'go_forward':  return mk('go_forward', {});
    case 'refresh':     return mk('refresh', {});
    case 'javascript':  return mk('run_javascript', { code: a.value || '' });
    case 'wait':        return mk('wait', {});
    case 'done':        return mk('done', { summary: a.text || '' });
    default: return null;
  }
}

function tryParseLegacyAction(content) {
  const t = (content || '').trim();
  // With native tools available, only treat the reply as a legacy action when it
  // IS the action (optionally after a Thought: line) — otherwise a JSON example
  // quoted inside a normal answer would get executed as a real click.
  if (nativeToolsEnabled && !/^(Thought:[^\n]*\n\s*)?(```(?:json)?\s*)?\{/i.test(t)) return [];
  if (!/\{[\s\S]*"action"/.test(t)) return [];
  const parsed = normalizeAction(parseAgentResponse(content));
  if (!parsed) return [];
  if (parsed.action === 'batch') {
    return (parsed.actions || []).map((a, i) => legacyActionToToolCall(a, i)).filter(Boolean);
  }
  // parseAgentResponse falls back to {action:'wait'} on failure — only accept an explicit wait
  if (parsed.action === 'wait' && !/"action"\s*:\s*"wait"/.test(content)) return [];
  const tc = legacyActionToToolCall(parsed, 0);
  return tc ? [tc] : [];
}

function coerceFormValue(v) {
  if (v === true || v === false) return v;
  const s = String(v ?? '').trim().toLowerCase();
  if (['true', 'checked', 'check', 'on', 'yes'].includes(s)) return true;
  if (['false', 'unchecked', 'uncheck', 'off', 'no'].includes(s)) return false;
  return v;
}

function toolCallToAction(name, args) {
  switch (name) {
    case 'left_click':     return { action: 'left_click', ref: args.ref, text: args.description || '' };
    case 'form_input':     return { action: 'form_input', ref: args.ref, value: coerceFormValue(args.value) };
    case 'type':           return { action: 'type', ref: args.ref, value: String(args.text ?? '') };
    case 'press_key':      return { action: 'key', key: args.key };
    case 'scroll':         return args.to === 'bottom'
      ? { action: 'scroll_bottom' }
      : { action: args.direction === 'up' ? 'scroll_up' : 'scroll_down' };
    case 'scroll_to':      return { action: 'scroll_to', ref: args.ref };
    case 'navigate':       return { action: 'navigate', url: args.url };
    case 'go_back':        return { action: 'go_back' };
    case 'go_forward':     return { action: 'go_forward' };
    case 'refresh':        return { action: 'refresh' };
    case 'run_javascript': return { action: 'javascript', value: args.code, ref: args.ref || null };
    case 'wait':           return { action: 'wait' };
    case 'find':           return { action: 'find', value: args.query };
    case 'click_coords':   return { action: 'click_coords', x: Number(args.x), y: Number(args.y), button: args.button === 'right' ? 'right' : 'left', double: !!args.double };
    default: return null;
  }
}

// Snapshot after actions: full context on change, tiny note when nothing changed.
async function buildSnapshot(state, { force = false, skipAutoScroll = false } = {}) {
  const pageData = await observePage(state.tabId, state.resumeClickStreak, false, skipAutoScroll);
  if (!pageData) return 'Could not read the page (tab may be loading or protected).';

  let out = '';
  if (pageData.autoDismissed) {
    state.resumeClickStreak = 0;
    out += `note: auto-dismissed dialog via "${pageData.autoDismissed}"\n`;
    addActivity(null, 'act', 'Auto-dismissed resume dialog', `Clicked "${pageData.autoDismissed}"`, 'success');
  }

  if (pageData.screenshotDataUrl) {
    state.pendingScreenshot = pageData.screenshotDataUrl;
    out += 'note: page is hard to read as text — a screenshot follows after the tool results.\n';
  }

  const fp = normalizeTreeFingerprint(pageData.accessibilityTree);
  if (!force && fp && fp === state.lastFingerprint) {
    state.unchangedStreak++;
    out += `Page: ${pageData.title} (${pageData.url})\n`;
    out += `Accessibility tree UNCHANGED since previous observation (${state.unchangedStreak}× in a row) — your action may not have taken effect.\n`;
    if (state.unchangedStreak >= 4) {
      out += 'escalation: still stuck — try refresh, go_back, or run_javascript directly on the target element.\n';
    } else if (state.unchangedStreak >= 2) {
      out += 'escalation: your action may be missing its target — use find to locate it, scroll_to it, then retry; prefer form_input over clicking for checkboxes/radios.\n';
    }
    out += buildResumeDialogHint(pageData, state.tabId, state.resumeClickStreak);
    out += buildQuizPhaseHint(pageData);
    if (pageData.checkboxSummary?.length) {
      out += 'checkbox state:\n' + pageData.checkboxSummary.map((c, i) =>
        `${i + 1}. [${c.checked ? 'CHECKED' : 'unchecked'}] ${c.label}`).join('\n');
    }
  } else {
    if (fp !== state.lastFingerprint) state.unchangedStreak = 0;
    state.lastFingerprint = fp;
    state.lastSnapshotAt = Date.now();
    out += buildPageContext(null, pageData, state.tabId, state.resumeClickStreak);
  }
  return out;
}

async function readPageTool(state, args = {}) {
  if (args.ref_id) {
    try {
      const { frameId, localRef } = await resolveRefTarget(state.tabId, args.ref_id);
      const target = frameId != null ? { tabId: state.tabId, frameIds: [frameId] } : { tabId: state.tabId };
      const [res] = await chrome.scripting.executeScript({
        target, injectImmediately: true, world: 'ISOLATED',
        func: (filter, depth, refId) => {
          if (typeof window.__generateAccessibilityTree !== 'function') return { error: 'tree generator missing' };
          return window.__generateAccessibilityTree(filter || 'all', depth ?? 10, 20000, refId);
        },
        args: [args.filter || 'all', args.depth ?? 10, localRef]
      });
      const r = res?.result;
      if (!r || r.error) return `read_page error: ${r?.error || 'no result'}`;
      // Map the frame's local refs back to the global refs the model knows
      const registry = tabRefRegistry.get(state.tabId) || {};
      const rev = {};
      for (const [g, e] of Object.entries(registry)) {
        if (e.frameId === (frameId ?? 0)) rev[e.localRef] = g;
      }
      const tree = (r.pageContent || '').replace(/\[ref_(\d+)\]/g, (m, n) => rev['ref_' + n] ? '[' + rev['ref_' + n] + ']' : m);
      return tree || '(empty subtree)';
    } catch (e) {
      return `read_page error: ${e.message}`;
    }
  }
  // If a full snapshot was delivered moments ago, let the fingerprint decide —
  // an act-then-read pattern shouldn't pay for a second identical observation.
  const recent = state.lastSnapshotAt && (Date.now() - state.lastSnapshotAt < 15000);
  return buildSnapshot(state, { force: !recent });
}

async function getPageTextTool(state) {
  const PT = window.PageTools;
  if (PT?.getEnrichedPageText) {
    const t = await PT.getEnrichedPageText(state.tabId, 16000);
    if (t) return t;
  }
  const data = await getPageContent(state.tabId);
  return (data?.text || '').slice(0, 16000) || '(no visible text)';
}

// Shared sink for collected rows: dedup store first, only novel rows to the
// file, authoritative counts back. Used by collect_rows and extract_rows.
async function pipeRowsToCollection(args, rows, step, label) {
  const collection = Workspace.safeName(args.filename);
  const sourceField = args.source_field || 'source';
  const { fresh, merged } = await Store.addRows(collection, rows, {
    dedupFields: args.dedup_fields,
    sourceField
  });
  let fileNote = 'nothing new to append';
  if (fresh.length) {
    const r = await writerAppendRows(args.filename, fresh.map(f => Store.projectRow(f, sourceField)), {
      columns: args.columns,
      format: args.format
    });
    fileNote = `file now holds ${r.rowCount} data rows`;
  }
  const counts = await Store.getCounts(collection); // O(1) — not a full re-read
  addActivity(step, 'result', label,
    `${collection}: +${fresh.length} new, ${merged} duplicate(s) merged → ${counts.uniqueRows} unique`, 'success');
  return { fresh: fresh.length, merged, uniqueRows: counts.uniqueRows, fileNote };
}

// ── run_control: plan compiler front-end + runner remote control ──
async function latestRunId() {
  const runs = await Store.listRuns();
  if (!runs.length) return null;
  return runs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0].id;
}

function sendRunCmd(cmd, runId) {
  return chrome.runtime.sendMessage({ type: 'BAT_RUN_CMD', cmd, runId })
    .catch((e) => ({ ok: false, error: e.message || 'worker unreachable — reload the extension' }));
}

// Load a candidate template URL in the working tab and report what actually
// came back. A template can only be judged in a real browser — that is the whole
// reason every shipped config starts unverified.
async function probeTemplateUrl(state, url) {
  const BT = window.BrowserTools;
  try {
    await BT.navigate(state.tabId, url);
    await BT.waitForDomQuiet(state.tabId, { quietMs: 400, maxMs: 2500 });
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: state.tabId },
      world: 'ISOLATED',
      func: () => ({
        finalUrl: location.href,
        title: (document.title || '').slice(0, 200),
        textLen: (document.body?.innerText || '').length
      })
    });
    return res?.result || { finalUrl: '', title: '', textLen: 0 };
  } catch (e) {
    debugEntry('template_probe_failed', { url, error: e?.message || String(e) });
    return { finalUrl: '', title: '', textLen: 0, error: e?.message || String(e) };
  }
}

async function runControlTool(state, args, step) {
  const action = args.action;

  if (action === 'create') {
    const plan = args.plan;
    // Substitute the vetted age patterns so a hand-written regex can't silently
    // truncate (or fail to end) a keyword's pagination.
    for (const u of plan?.units || []) {
      const m = u.stop_when?.matches;
      if (m === '$OLDER_THAN_1_WEEK') u.stop_when.matches = STOP_PATTERNS.older_than_1_week;
      else if (m === '$OLDER_THAN_1_MONTH') u.stop_when.matches = STOP_PATTERNS.older_than_1_month;
    }
    const err = validatePlan(plan);
    if (err) return `Plan invalid: ${err}`;
    const id = 'run_' + Date.now().toString(36);
    const run = {
      id,
      plan,
      status: 'draft',
      pos: { unitIndex: 0, page: null },
      counts: { pages: 0, rows: 0 },
      createdAt: Date.now()
    };
    await Store.saveRun(run);
    const summary = plan.units.map((u, i) => {
      const start = u.pages?.start ?? 1;
      const max = u.pages?.max ?? 1;
      return `${i + 1}. [${u.id}] ${u.url_template}`
        + (max > 1 ? ` (pages ${start}–${start + max - 1})` : '')
        + (u.stop_when ? ` · stop when ${u.stop_when.field} ~ /${u.stop_when.matches}/` : '');
    }).join('\n');
    addActivity(step, 'plan', `Run plan created: ${id}`,
      `file: ${plan.filename} · dedup: ${plan.dedup_fields.join('+')} · ${plan.units.length} unit(s)\n${summary}`, 'success');

    // Surfaced once, clearly, before anything starts — and not blocking.
    const risky = [...new Set(plan.units.flatMap(u => {
      const t = String(u.url_template || '');
      return SITE_CONFIGS.filter(c => c.account_risk && t.includes(c.site)).map(c => c.name);
    }))];
    let warning = '';
    if (risky.length) {
      addActivity(step, 'warn', 'Account risk on this run',
        `This plan targets ${risky.join(', ')}. Their terms forbid automated collection, and if you are signed in there, `
        + `automated activity can put the ACCOUNT at risk — not just your IP address. BAT will not stop you; just make sure this is what you intend.`, 'warn');
      warning = ` IMPORTANT — tell the user plainly before they confirm: this plan targets ${risky.join(', ')}, whose terms forbid automated collection; if they are signed in there, the account itself (not just the IP) is at risk. Do not refuse, just make sure they know.`;
    }

    return `Run ${id} created as DRAFT (${plan.units.length} units → ${plan.filename}). `
      + `Now SHOW the user the plan summary and wait for explicit confirmation, then call run_control {action:"start", run_id:"${id}"}. `
      + `The runner works in the background — the panel can be closed — and checkpoints after every page.${warning}`;
  }

  const runId = args.run_id || (await latestRunId());
  if (!runId) return 'No run found — create one first.';

  if (action === 'start' || action === 'resume') {
    // Prove the worker can write BEFORE a long unattended run.
    const write = await sendRunCmd('check_write', runId);
    if (write && write.ok === false) {
      addActivity(step, 'warn', 'Background file writes unavailable', write.note || write.error, 'warn');
    }
    const res = await sendRunCmd('start', runId);
    if (!res.ok) return `Could not ${action} run ${runId}: ${res.error}`;
    return `Run ${runId} ${action === 'resume' ? 'resumed' : 'started'} — ${res.note || 'running in the background'}. `
      + (write && write.ok === false
        ? `NOTE for the user: ${write.note}. Rows are never lost — finish with export_rows to write the file. `
        : '')
      + 'Use run_control {action:"status"} for progress and {action:"report"} at the end.';
  }
  if (action === 'pause') {
    const res = await sendRunCmd('pause', runId);
    return res.ok ? `Run ${runId} paused (${res.note}).` : `Could not pause: ${res.error}`;
  }
  if (action === 'report') {
    const rep = await Store.buildRunReport(runId);
    if (!rep) return `No run ${runId}.`;
    const lines = [
      `RUN REPORT — ${rep.runId} (${rep.status.toUpperCase()})`,
      `File: ${rep.filename}`,
      `Total unique rows: ${rep.totalRows} (${rep.duplicatesMerged} duplicate(s) merged)`,
      `Pages visited: ${rep.pagesVisited} · synthesis tokens: ${rep.tokensSpent}`,
      '',
      'Rows per unit:',
      ...rep.perUnit.map(u => `  ${u.unitId}: ${u.rows} rows over ${u.pages} page(s) [${Object.entries(u.outcomes).map(([k, v]) => k + '×' + v).join(', ')}]`),
      '',
      'Rows per source:',
      ...Object.entries(rep.perSource).sort((a, b) => b[1] - a[1]).map(([s, n]) => `  ${s}: ${n}`)
    ];
    if (rep.unitsWithNoRows.length) lines.push('', `Units that returned nothing: ${rep.unitsWithNoRows.join(', ')}`);
    if (rep.notFound.length) lines.push('', `NOT-FOUND: ${rep.notFound.join(', ')}`);
    if (rep.extractorsSynthesized.length) lines.push('', `Extractors synthesized: ${rep.extractorsSynthesized.length}`);
    if (rep.problems.length) lines.push('', 'Skipped / unfinished / problems:', ...rep.problems.map(p => '  ' + p));
    if (rep.pendingExport) lines.push('', 'WARNING: some rows are in the store but not the file — run export_rows.');
    return lines.join('\n') + '\n\nReport these figures to the user as-is; they come from the store, not from memory.';
  }

  if (action === 'sites') {
    const merged = SiteVerify.mergeConfigs(SITE_CONFIGS, await SiteVerify.loadVerification());
    const unverified = merged.filter(c => !c.verified && c.url_template).map(c => c.site);
    return 'Known site configs (shipped defaults from src/shared/site-configs.js, overlaid with what THIS install has verified):\n'
      + merged.map(c =>
        `- ${c.name} (${c.site}): ${c.url_template || '(no template — drive interactively)'}`
        + (c.pages ? ` · pages start ${c.pages.start}, step ${c.pages.step}, max ${c.pages.max}` : '')
        + (c.verified
          ? ` · VERIFIED${c.verifiedAt ? ' on ' + new Date(c.verifiedAt).toISOString().slice(0, 10) : ''}`
          : ' · UNVERIFIED')
        + (c.note ? ` · ${c.note}` : '')
        + (c.verificationNote ? ` · ${c.verificationNote}` : '')
      ).join('\n')
      + (unverified.length
        ? `\n\nBefore building a large run on any UNVERIFIED template, verify it: run_control {action:"verify", site:"${unverified[0]}", vars:{...}}. `
          + 'It loads page 1 in the working tab and reports whether the template actually returns a results page. '
          + 'Unverified: ' + unverified.join(', ') + '.'
        : '');
  }

  // ── verify / mark_verified: prove a template before betting a run on it ──
  if (action === 'verify') {
    const site = args.site;
    const cfg = SITE_CONFIGS.find(c => c.site === site);
    const template = args.url_template || cfg?.url_template;
    if (!template) {
      return `No URL template for "${site || '(none given)'}". `
        + 'Find the real search URL in Chrome (watch the address bar while searching), then pass it as url_template.';
    }
    const page = args.page ?? cfg?.pages?.start ?? 1;
    const url = fillTemplate(template, args.vars || {}, page);
    const decision = await Allowlist.checkUrl(url);
    if (!decision.ok) return Allowlist.blockedMessage(decision, 'run_control verify');

    const probe = await probeTemplateUrl(state, url);
    const verdict = SiteVerify.judgeProbe({
      requestedUrl: url, finalUrl: probe.finalUrl, title: probe.title, textLen: probe.textLen
    });
    addActivity(step, verdict.ok ? 'result' : 'warn', `Template ${verdict.verdict}: ${site}`,
      `${url}\n→ ${probe.finalUrl || '(never loaded)'}\n${probe.title}\n${probe.textLen} chars of text`
      + (verdict.reasons.length ? '\n- ' + verdict.reasons.join('\n- ') : ''),
      verdict.ok ? 'success' : 'warn');

    if (!verdict.ok) {
      await SiteVerify.markBroken(site, verdict.reasons.join('; '));
      return `Template REJECTED for ${site} (${verdict.verdict}):\n- ${verdict.reasons.join('\n- ')}\n\n`
        + `URL tried: ${url}\nLanded on: ${probe.finalUrl || '(never loaded)'}\nTitle: ${probe.title}\n\n`
        + 'Do NOT build a run on this template. Find the working search URL in the browser and verify that instead.';
    }
    return `Template loaded a real page for ${site}: ${probe.textLen} chars, title "${probe.title}".`
      + (verdict.reasons.length ? `\nNotes:\n- ${verdict.reasons.join('\n- ')}` : '')
      + `\n\nNOT yet marked verified — a page that loads is not proof it lists results. Now call extract_rows on it. `
      + `If rows come back, confirm with run_control {action:"mark_verified", site:"${site}", url_template:"${template}"} `
      + `(pass rows_found so the record says how many). If extraction finds nothing, the template is wrong even though it loaded.`;
  }

  if (action === 'mark_verified') {
    if (!args.site) return 'mark_verified needs site.';
    if (args.rows_found === 0) {
      await SiteVerify.markBroken(args.site, 'extractor found 0 rows on page 1');
      return `Not marked verified: you reported 0 rows. A template that loads but lists nothing is not usable.`;
    }
    const rec = await SiteVerify.markVerified(args.site, {
      url_template: args.url_template,
      rowsFound: args.rows_found ?? null,
      note: args.note || ''
    });
    addActivity(step, 'result', `Template verified: ${args.site}`,
      `${rec.url_template || '(template unchanged)'}${rec.rowsFound != null ? ` · ${rec.rowsFound} row(s) on page 1` : ''}`, 'success');
    return `${args.site} marked VERIFIED for this installation${rec.rowsFound != null ? ` (${rec.rowsFound} rows on page 1)` : ''}. `
      + 'run_control {action:"sites"} will show it as verified from now on, and it survives updates because it is stored, not hardcoded.';
  }
  if (action === 'status') {
    const res = await sendRunCmd('status', runId);
    if (!res.ok) return `Status unavailable: ${res.error}`;
    const r = res.run;
    const recent = (res.recent || [])
      .map((e) => e.kind === 'page'
        ? `  ${e.unitId} p${e.page}: ${e.outcome}${e.fresh ? ` +${e.fresh}` : ''}${e.note ? ` (${String(e.note).slice(0, 80)})` : ''}`
        : `  ${e.kind}${e.unitId ? ' ' + e.unitId : ''}${e.note ? ': ' + String(e.note).slice(0, 80) : ''}`)
      .join('\n');
    return `Run ${r.id}: ${r.status.toUpperCase()}${r.note ? ' — ' + r.note : ''}\n`
      + `Unit ${Math.min(r.unitIndex + 1, r.units)}/${r.units}${r.page != null ? `, page ${r.page}` : ''} · ${r.counts.pages} pages processed · ${r.counts.rows} rows collected → ${r.filename}`
      + (r.pendingExport ? '\nNOTE: some rows are in the store but not yet in the file — run export_rows to sync.' : '')
      + (recent ? `\nRecent:\n${recent}` : '');
  }
  return `Unknown action: ${action}`;
}

// ── ats_fetch: whole company boards via public ATS JSON APIs ─────
async function atsFetchTool(args, step) {
  const provider = args.provider;
  if (!provider) return 'provider required: greenhouse | lever | ashby | workable';

  let res;
  if (args.slug) {
    res = await chrome.runtime.sendMessage({ type: 'BAT_ATS_CMD', cmd: 'fetch', provider, slug: args.slug })
      .catch(e => ({ ok: false, error: e.message || 'worker unreachable' }));
  } else if (args.company) {
    res = await chrome.runtime.sendMessage({ type: 'BAT_ATS_CMD', cmd: 'discover', provider, company: args.company })
      .catch(e => ({ ok: false, error: e.message || 'worker unreachable' }));
  } else {
    return 'Pass slug (known board) or company (auto-discover the slug).';
  }

  if (!res?.ok) {
    const label = args.company || args.slug || provider;
    addActivity(step, 'warn', `ATS ${provider}: NOT-FOUND`, res?.error || 'no response', 'warn');
    // Persist it so the end-of-job report can list NOT-FOUND companies instead
    // of relying on the model to remember them.
    if (args.filename) {
      await Store.recordNotFound(Workspace.safeName(args.filename), label, provider).catch(() => {});
    }
    return `NOT-FOUND — ${res?.error || 'no response from worker'}`
      + (args.filename ? ' (recorded for the final report)' : '');
  }

  let rows = res.rows;
  const total = rows.length;
  if (args.location_filter) {
    const { ok, re, reason } = compileGuardedRegex(args.location_filter);
    if (!ok) return `Invalid location_filter: ${reason}`;
    rows = rows.filter(r => re.test(r.Location || ''));
  }
  if (args.set_fields && typeof args.set_fields === 'object' && !Array.isArray(args.set_fields)) {
    rows = rows.map(r => ({ ...r, ...args.set_fields }));
  }

  const msg = `${provider}/${res.slug}: board found${res.boardName ? ` ("${res.boardName}")` : ''} — ${total} job(s)`
    + (args.location_filter ? `, ${rows.length} after location filter` : '')
    + (res.tried && res.tried.length > 1 ? ` (slug resolved via: ${res.tried.join(' → ')})` : '')
    + '.'
    + (res.warning ? ` WARNING: ${res.warning}.` : '');
  if (!rows.length) return msg + ' Nothing to save.';

  if (args.filename) {
    if (!Array.isArray(args.dedup_fields) || !args.dedup_fields.length) {
      return msg + ' Rows NOT saved: dedup_fields is required with filename (e.g. ["Company","Title"]).';
    }
    // A slug guessed without an identity check can belong to a DIFFERENT
    // company with the same short name — saving those rows would poison the
    // file invisibly. Never auto-save an unverified discovery.
    if (res.confidence === 'unverified' && !args.slug) {
      return msg + `\nRows NOT saved — this slug was guessed and the board exposes no company name, so it may belong to a different "${args.company}". `
        + `Check the sample below (locations/titles should fit the company you meant); if it is right, call ats_fetch again with slug:"${res.slug}" to save.\n`
        + JSON.stringify(rows.slice(0, 5)).slice(0, 1500);
    }
    const r = await pipeRowsToCollection(args, rows, step, 'ATS rows collected');
    return msg + ` Stored ${r.fresh} new, merged ${r.merged} duplicate(s); collection holds ${r.uniqueRows} unique rows (${r.fileNote}).`;
  }
  return msg + `\nRows (first ${Math.min(rows.length, 15)} — pass filename+dedup_fields to save all):\n`
    + JSON.stringify(rows.slice(0, 15)).slice(0, 5000);
}

// ── extract_rows: synthesize / replay / validate / halt ──────────
async function extractRowsTool(state, args, step) {
  const access = await checkTabAccess(state.tabId);
  if (!access.ok) {
    addActivity(step, 'warn', 'Blocked by allowlist', `extract_rows on ${access.host || 'this page'}: ${access.reason}`, 'warn');
    renderAllowCurrentSite();
    return Allowlist.blockedMessage(access, 'extract_rows')
      + ' (extract_rows runs model-authored code in the page, so it is gated like every other page-changing tool.)';
  }
  const tab = await chrome.tabs.get(state.tabId).catch(() => null);
  if (!tab?.url) return 'Cannot read the tab URL.';
  let pattern;
  try {
    pattern = Extractors.patternForUrl(tab.url);
  } catch {
    return 'Unsupported URL for extraction: ' + (tab.url || '(unknown)');
  }

  let record = await Store.getExtractor(pattern);
  if (args.force_reset && record) {
    record.status = 'active';
    record.consecutiveFailures = 0;
    await Store.putExtractor(record);
    addActivity(step, 'warn', 'Extractor halt cleared', pattern, 'warn');
  }
  const requiredFields = Array.isArray(args.required_fields) && args.required_fields.length
    ? args.required_fields : undefined;

  // ── Synthesize / refresh ──
  if (args.function_source) {
    const src = String(args.function_source);
    // Screened BEFORE it runs and before it is cached. The source is authored by
    // the model from untrusted page markup, and the CDP path runs it in the
    // page's own realm with the page CSP bypassed — so "it produced valid rows"
    // is not evidence that it only read the page.
    const screened = screenExtractorSource(src);
    if (!screened.ok) {
      addActivity(step, 'error', 'Extractor rejected by safety screen', `${screened.reason}\n--- rejected source ---\n${src}`, 'error');
      debugEntry('extractor_screen_rejected', { pattern, reason: screened.reason });
      return `Extractor REJECTED and not cached — ${screened.reason}. An extractor must be a pure synchronous DOM reader: `
        + 'walk the document, return an array of row objects, nothing else. No network, no eval, no storage, no timers, no clicking.';
    }
    const run = await runExtractor(state.tabId, src);
    if (!run.ok) return `Extractor failed on this page (NOT cached): ${run.error}. Fix the function body and retry.`;
    const check = Extractors.validateReplay({
      rows: run.rows, pageTextLen: run.pageTextLen, requiredFields
    });
    if (check.verdict === 'invalid') {
      return `Extractor rejected (NOT cached): ${check.reason}. Fix the function body and retry.`;
    }
    const version = {
      source: src,
      builtFromUrl: tab.url,
      createdAt: Date.now(),
      schemaFingerprint: Extractors.schemaFingerprintOf(run.rows),
      sampleRows: run.rows.slice(0, 3)
    };
    record = {
      pattern,
      status: 'active',
      current: version,
      history: [...(record?.history || []), ...(record?.current ? [{ ...record.current, retiredAt: Date.now(), retiredReason: 'replaced by new synthesis' }] : [])].slice(-10),
      recentCounts: [],
      consecutiveFailures: 0
    };
    await Store.putExtractor(record);
    debugEntry('extractor_synthesized', { pattern, sourceLen: src.length });
    // B.8: the source that will run unattended must be user-readable.
    addActivity(step, 'act', 'Extractor synthesized', `${pattern}\n--- function source ---\n${src}`, 'success');
    if (check.verdict === 'empty') {
      return `Extractor cached for ${pattern}, but this page appears empty (0 rows). Replay it on a real results page.`;
    }
    return finishExtraction(args, run.rows, record, { synthesized: true, step, via: run.via, note: run.note, truncationWarning: run.truncationWarning });
  }

  // ── Replay ──
  if (!record?.current) {
    return `No cached extractor for ${pattern}. Read this page ONCE (read_page/get_page_text), then call extract_rows with function_source — a JS function body returning an array of row objects from document.`;
  }
  if (record.status === 'halted') {
    return `Extraction HALTED for ${pattern} (${record.consecutiveFailures} consecutive failures; last: ${record.lastFailure || 'unknown'}). Stop this site and report it to the user. Pass force_reset:true only after the user approves retrying.`;
  }

  const run = await runExtractor(state.tabId, record.current.source);
  const check = run.ok
    ? Extractors.validateReplay({
        rows: run.rows,
        pageTextLen: run.pageTextLen,
        cachedFingerprint: record.current.schemaFingerprint,
        recentCounts: record.recentCounts || [],
        requiredFields
      })
    : { verdict: 'invalid', reason: run.error };

  if (check.verdict === 'invalid') {
    record.consecutiveFailures = (record.consecutiveFailures || 0) + 1;
    record.lastFailure = check.reason;
    record.history = [...(record.history || []), { ...record.current, retiredAt: Date.now(), retiredReason: check.reason }].slice(-10);
    record.current = null;
    if (record.consecutiveFailures >= 2) record.status = 'halted';
    await Store.putExtractor(record);
    debugEntry('extractor_invalid', { pattern, reason: check.reason, failures: record.consecutiveFailures });
    addActivity(step, 'warn', 'Extractor invalidated', `${pattern}: ${check.reason}`, 'warn');
    if (record.status === 'halted') {
      return `Extractor invalid (${check.reason}) — second consecutive failure, extraction for ${pattern} is HALTED. Stop this site and report it to the user rather than collecting doubtful data.`;
    }
    return `Extractor invalid: ${check.reason}. The stale version was retired (kept in history). Read this page once and call extract_rows with a FRESH function_source — this is the single retry; another failure halts this site.`;
  }

  if (check.verdict === 'empty') {
    return 'Page appears empty (little text, 0 rows) — accepted as a genuinely empty results page.';
  }
  return finishExtraction(args, run.rows, record, { synthesized: false, step, suspicious: check.suspicious, via: run.via, note: run.note, truncationWarning: run.truncationWarning });
}

async function finishExtraction(args, rows, record, { synthesized, step, suspicious, via, note, truncationWarning }) {
  if (via === 'cdp') {
    addActivity(step, 'info', 'Extractor ran via CDP', note || 'page CSP blocked in-page compilation', 'warn');
  }
  // Silent truncation used to make an incomplete page look like a complete one.
  if (truncationWarning) {
    addActivity(step, 'warn', 'Extractor output truncated', truncationWarning, 'warn');
  }
  record.consecutiveFailures = 0;
  record.status = 'active';
  record.recentCounts = [...(record.recentCounts || []), rows.length].slice(-10);
  await Store.putExtractor(record);

  if (args.set_fields && typeof args.set_fields === 'object' && !Array.isArray(args.set_fields)) {
    rows = rows.map(r => ({ ...r, ...args.set_fields }));
  }

  let msg = `${synthesized ? 'Extractor synthesized and cached — extracted' : 'Replayed cached extractor —'} ${rows.length} row(s) from this page.`;
  if (suspicious) msg += `\nWARNING (batch flagged): ${suspicious}`;
  if (truncationWarning) msg += `\nWARNING (incomplete page): ${truncationWarning}`;

  if (args.filename) {
    if (!Array.isArray(args.dedup_fields) || !args.dedup_fields.length) {
      return msg + '\nRows NOT saved: dedup_fields is required with filename (e.g. ["Company","Title"]).';
    }
    const r = await pipeRowsToCollection(args, rows, step, 'Rows extracted');
    msg += `\nStored ${r.fresh} new, merged ${r.merged} duplicate(s); collection holds ${r.uniqueRows} unique rows (${r.fileNote}).`;
    msg += `\nSample row: ${JSON.stringify(rows[0]).slice(0, 300)}`;
    return msg;
  }

  const sample = rows.slice(0, 20);
  return msg + `\nRows (first ${sample.length} shown — pass filename+dedup_fields to save all without listing them):\n`
    + JSON.stringify(sample).slice(0, 6000);
}

async function runTool(state, name, args, step, opts = {}) {
  if (name === 'read_page') return readPageTool(state, args);
  if (name === 'get_page_text') return getPageTextTool(state);

  if (name === 'screenshot') {
    if (!visionEnabled) return 'Screenshots are disabled: the DeepSeek API cannot read images. Use read_page/get_page_text/run_javascript instead.';
    const shot = window.BrowserTools?.cdpScreenshot
      ? await window.BrowserTools.cdpScreenshot(state.tabId).catch(() => null)
      : null;
    if (!shot) return 'Screenshot failed (tab may be protected or discarded).';
    state.pendingScreenshot = shot;
    return 'Screenshot captured — attached as an image after these tool results.';
  }

  if (name === 'list_tabs') {
    const tabs = await chrome.tabs.query({});
    const lines = tabs.filter(t => t.id != null).map(t =>
      `${t.id === state.tabId ? '→' : ' '} [${t.id}] ${(t.title || '(untitled)').slice(0, 60)} — ${(t.url || '').slice(0, 100)}`
    );
    return lines.join('\n') || 'No tabs open.';
  }

  if (name === 'open_tab') {
    let url = (args.url || '').trim();
    if (!url) return 'open_tab needs a url.';
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    const t = await chrome.tabs.create({ url, active: false }).catch(() => null);
    if (!t?.id) return 'Could not open tab.';
    await switchAgentTab(state, t.id, 'Opened new background tab');
    await window.BrowserTools?.waitForPageIdle?.(t.id, 15000).catch(() => {});
    const snapshot = await buildSnapshot(state, { force: true });
    return `Opened background tab [${t.id}] ${url} — now working there.\n\n${snapshot}`;
  }

  if (name === 'switch_tab') {
    const id = Number(args.tab_id);
    const t = Number.isFinite(id) ? await chrome.tabs.get(id).catch(() => null) : null;
    if (!t) return `Tab ${args.tab_id} not found — call list_tabs for current ids.`;
    await switchAgentTab(state, id, 'Agent switched working tab');
    const snapshot = await buildSnapshot(state, { force: true });
    return `Now working in tab [${id}] ${(t.title || t.url || '').slice(0, 80)}.\n\n${snapshot}`;
  }

  if (name === 'read_console' || name === 'read_network') {
    const BT = window.BrowserTools;
    const fn = name === 'read_console' ? BT?.readConsole : BT?.readNetwork;
    if (!fn) return 'Monitoring unavailable — BrowserTools not loaded.';
    try {
      const r = await fn(state.tabId, args.pattern || args.filter, Math.min(args.limit || 40, 100));
      const head = (r.first
        ? 'Capture just started — entries accumulate from now on; interact with the page and call again to see more.\n'
        : '') + (r.filterError ? r.filterError + ' — showing unfiltered entries instead.\n' : '');
      if (!r.entries.length) {
        return head + 'No entries captured' + ((args.pattern || args.filter) ? ' matching the filter.' : ' yet.');
      }
      const lines = name === 'read_console'
        ? r.entries.map(e => `[${e.level}] ${e.text}`)
        : r.entries.map(e => `${e.method} ${e.status ?? (e.error ? 'FAILED(' + e.error + ')' : '…')} ${e.url}`);
      return (head + lines.join('\n')).slice(0, 6000);
    } catch (e) {
      return `${name} failed: ${e.message}`;
    }
  }

  if (name === 'extract_rows') {
    try {
      return await extractRowsTool(state, args, step);
    } catch (e) {
      return `extract_rows error: ${e.message}`;
    }
  }

  if (name === 'run_control') {
    try {
      return await runControlTool(state, args, step);
    } catch (e) {
      return `run_control error: ${e.message}`;
    }
  }

  if (name === 'ats_fetch') {
    try {
      return await atsFetchTool(args, step);
    } catch (e) {
      return `ats_fetch error: ${e.message}`;
    }
  }

  if (name === 'record_not_found') {
    try {
      const n = await Store.recordNotFound(Workspace.safeName(args.filename), args.label, args.detail || '');
      addActivity(step, 'warn', `NOT-FOUND: ${args.label}`, args.detail || '', 'warn');
      return `Recorded NOT-FOUND for "${args.label}" (${n} total). It will appear in the final report.`;
    } catch (e) {
      return `record_not_found error: ${e.message}`;
    }
  }

  if (name === 'collect_rows' || name === 'export_rows' || name === 'data_report') {
    try {
      const collection = Workspace.safeName(args.filename);
      const sourceField = args.source_field || 'source';

      if (name === 'collect_rows') {
        const r = await pipeRowsToCollection(args, args.rows, step, 'Rows collected');
        return `Stored ${r.fresh} new row(s), merged ${r.merged} duplicate(s) into existing rows. `
          + `Collection now holds ${r.uniqueRows} unique rows (${r.fileNote}). `
          + (r.merged ? 'Sources merged on collisions are reflected in the file after export_rows. ' : '');
      }

      if (name === 'export_rows') {
        const recs = await Store.getRows(collection);
        if (!recs.length) return `No rows stored for ${collection} — collect_rows first.`;
        const rows = recs.map(rec => Store.projectRow(rec, sourceField));
        const r = await writerWriteAll(args.filename, rows, { columns: args.columns, format: args.format });
        addActivity(step, 'result', 'File exported', `${r.name}: ${r.rowCount} unique rows`, 'success');
        return `Exported ${r.rowCount} unique rows to ${r.name} with merged sources (columns: ${r.columns.join(', ')}).`;
      }

      const report = await Store.getReport(collection);
      const perSource = Object.entries(report.perSource)
        .sort((a, b) => b[1] - a[1])
        .map(([s, n]) => `  ${s}: ${n}`)
        .join('\n');
      const nf = await Store.getNotFound(collection);
      return `Report for ${report.collection} (from the store):\n`
        + `Unique rows: ${report.uniqueRows}\n`
        + `Duplicates merged: ${report.duplicatesMerged}\n`
        + `Rows per source:\n${perSource || '  (none)'}`
        + (nf.length ? `\nNOT-FOUND (${nf.length}): ${nf.map(e => e.label).join(', ')}` : '');
    } catch (e) {
      return `${name} error: ${e.message}`;
    }
  }

  if (name === 'append_rows') {
    try {
      const r = await writerAppendRows(args.filename, args.rows, { format: args.format, columns: args.columns });
      addActivity(step, 'result', 'Rows appended', `${r.name}: +${r.appended} → ${r.rowCount} data rows`, 'success');
      let msg = `Appended ${r.appended} row(s) to ${r.name} — the file now holds ${r.rowCount} data rows (columns: ${r.columns.join(', ')}).`;
      if (r.droppedKeys.length) {
        msg += ` WARNING: keys not in the header were dropped: ${r.droppedKeys.join(', ')}.`;
      }
      return msg;
    } catch (e) {
      return `append_rows error: ${e.message}`;
    }
  }

  if (name === 'save_file' || name === 'read_file' || name === 'list_files') {
    try {
      if (name === 'save_file') {
        const append = args.mode === 'append';
        const r = await Workspace.writeFile(args.filename, args.content ?? '', { append });
        addActivity(step, 'result', append ? 'Appended to file' : 'Saved file', `${r.name} — now ${r.size} bytes`, 'success');
        return `${append ? 'Appended to' : 'Saved'} ${r.name} (${r.bytes} chars written, file is now ${r.size} bytes).`;
      }
      if (name === 'read_file') {
        return await Workspace.readFile(args.filename);
      }
      const files = await Workspace.listFiles();
      return files.length
        ? files.map(f => `${f.name} (${f.size} bytes)`).join('\n')
        : 'Workspace folder is empty.';
    } catch (e) {
      return `Workspace error: ${e.message}`;
    }
  }

  const action = toolCallToAction(name, args);
  if (!action) return `Unknown tool: ${name}`;

  if (SITE_GUARDED_TOOLS.has(name)) {
    const access = await checkTabAccess(state.tabId);
    if (!access.ok) {
      addActivity(step, 'warn', 'Blocked by allowlist', `${name} on ${access.host || 'this page'}: ${access.reason}`, 'warn');
      renderAllowCurrentSite();
      return Allowlist.blockedMessage(access, name);
    }
  }

  // Escalation: repeated no-effect turns → force trusted CDP clicks instead of DOM clicks
  if (name === 'left_click' && state.unchangedStreak >= 2) {
    action.forceCdp = true;
  }

  if (name === 'find') {
    const r = await executeAgentAction(state.tabId, action);
    return r.success
      ? (r.label ? `Matches:\n${r.label}` : r.detail || 'No matches found')
      : `find failed: ${r.error || 'unknown error'}`;
  }

  const result = await executeAgentAction(state.tabId, action);

  if (name === 'left_click' && isResumeLikeClick(action, state.tabId)) {
    state.resumeClickStreak = result.dialogStillOpen ? state.resumeClickStreak + 1 : 0;
  } else if (name === 'left_click' && isRestartLikeClick(action, state.tabId) && !result.dialogStillOpen) {
    state.resumeClickStreak = 0;
  }

  const line = result.success
    ? `${name} OK${result.label ? ` — ${result.label}` : ''}${result.detail ? ` (${result.detail})` : ''}`
    : `${name} FAILED — ${result.error || 'unknown error'}${result.detail ? ` (${result.detail})` : ''}`;

  addActivity(step, 'result', result.success ? 'Action succeeded' : 'Action failed', line, result.success ? 'success' : 'error');
  debugEntry('action_result', { step, tool: name, success: result.success, result: line });
  state.lastActionFailed = !result.success;

  // In a multi-action turn only the LAST page action carries a full snapshot —
  // intermediate snapshots would be stale before the model ever read them.
  if (opts.skipSnapshot) {
    return `${line}\n(page snapshot follows after the last action in this batch)`;
  }

  const snapshot = await buildSnapshot(state, {
    skipAutoScroll: name === 'scroll' || name === 'scroll_to'
  });
  return `${line}\n\n${snapshot}`;
}

// The agent is PINNED to the tab where the run started — it does not follow the
// user's focus, so you can browse other tabs while it works. The one exception:
// if the pinned page itself opens a new tab (e.g. SCORM "Launch course" popups),
// the agent follows that child tab.
async function switchAgentTab(state, newTabId, note) {
  if (state.tabId != null && state.tabId !== newTabId) {
    // Detach from the old tab so its "being debugged" infobar doesn't linger
    await window.BrowserTools?.releaseDebugger?.(state.tabId).catch(() => {});
    if (state.borderShown) await showAgentBorder(state.tabId, false).catch(() => {});
  }
  state.tabId = newTabId;
  state.lastFingerprint = '';
  state.borderShown = false;
  agentTabIdActive = newTabId;
  renderAllowCurrentSite();
  if (note) addActivity(null, 'info', note, '', 'success');
}

async function withAgentTab(state, fn, { allowDeadTab = false } = {}) {
  if (state.tabId == null) {
    const tab = await getActiveTab().catch(() => null);
    if (!tab?.id) return 'No active browser tab available.';
    state.tabId = tab.id;
  }

  // Follow a tab the pinned page opened itself (course launch popup)
  if (state.pendingChildTabId != null) {
    const childId = state.pendingChildTabId;
    state.pendingChildTabId = null;
    const child = await chrome.tabs.get(childId).catch(() => null);
    if (child) {
      await switchAgentTab(state, childId, 'Following tab opened by the page');
      await window.BrowserTools?.waitForPageIdle?.(childId, 8000).catch(() => {});
    }
  }

  // Pinned tab gone (user closed it) → let the model relocate via list_tabs/switch_tab
  const tabAlive = await chrome.tabs.get(state.tabId).then(() => true).catch(() => false);
  if (!tabAlive && !allowDeadTab) {
    addActivity(null, 'warn', 'Working tab was closed', 'The agent can continue in another tab via list_tabs/switch_tab.', 'warn');
    return 'The tab you were working in has been closed. Call list_tabs, then switch_tab to continue in another tab (or open_tab for a fresh one), or done if the goal is complete.';
  }

  if (tabAlive && !state.borderShown) {
    state.borderShown = true;
    agentTabIdActive = state.tabId;
    await showAgentBorder(state.tabId, true).catch(() => {});
  }
  try {
    return await fn();
  } catch (e) {
    return `Tool error: ${e.message}`;
  }
}

async function runAgentLoop(userText) {
  isProcessing = true;
  stopRequested = false;
  apiAbortController = new AbortController();
  updateSendEnabled();
  currentRunId = 'run_' + Date.now().toString(36);
  currentGoal = userText;

  const tab = await getActiveTab().catch(() => null);
  const state = {
    tabId: tab?.id ?? null,
    lastFingerprint: '',
    unchangedStreak: 0,
    resumeClickStreak: 0,
    borderShown: false,
    pendingChildTabId: null,
    pendingScreenshot: null,
    lastActionFailed: false
  };

  // Follow only tabs opened BY the pinned page (openerTabId), never the user's focus
  const onTabCreated = (created) => {
    if (created.openerTabId != null && created.openerTabId === state.tabId) {
      state.pendingChildTabId = created.id;
    }
  };
  chrome.tabs.onCreated.addListener(onTabCreated);

  if (tab?.id) {
    addActivity(null, 'info', 'Pinned to tab', `${tab.title || tab.url || 'current tab'} — you can browse other tabs while I work.`);
    agentTabIdActive = tab.id;
    renderAllowCurrentSite();
  }
  debugEntry('run_start', { goal: userText, tabId: state.tabId, url: tab?.url });
  repairSessionToolCalls();
  session.push({ role: 'user', content: userText });
  persistSession();

  let step = 0;
  const runStartTokens = usageTotals.prompt + usageTotals.completion;
  let budgetWarned = false;
  try {
    while (step < MAX_STEPS && !stopRequested) {
      step++;

      // Per-run cost ceiling — checked BEFORE the next API call so we never
      // leave a dangling tool_call when we stop.
      const runTokens = (usageTotals.prompt + usageTotals.completion) - runStartTokens;
      if (runTokens >= RUN_TOKEN_BUDGET) {
        addActivity(step, 'warn', 'Run token budget reached',
          `${formatTokens(runTokens)} tokens spent this run — stopping. Send a new message to continue.`, 'warn');
        break;
      }
      if (!budgetWarned && runTokens >= RUN_TOKEN_BUDGET * 0.8) {
        budgetWarned = true;
        addActivity(step, 'warn', 'Token budget 80% used',
          `${formatTokens(runTokens)} of ${formatTokens(RUN_TOKEN_BUDGET)} for this run.`, 'warn');
      }

      // Deliver messages the user typed while the agent was working — safe
      // here because the previous iteration's tool results are all closed out.
      if (queuedMessages.length) {
        for (const q of queuedMessages) session.push({ role: 'user', content: q });
        queuedMessages = [];
        persistSession();
      }

      pruneSessionForBudget();
      const messages = [{
        role: 'system',
        content: buildSystemPrompt({
          modelLabel: getModelLabel(), modelId: currentModel, visionEnabled, nativeToolsEnabled
        })
      }, ...session];

      // Route reasoning effort by difficulty: full effort for the opening plan
      // and for recovery (stuck page / failed action); medium for routine steps.
      const effort = (step === 1 || state.unchangedStreak > 0 || state.lastActionFailed) ? 'high' : 'medium';

      let result;
      const liveBubble = addStreamingBubble();
      try {
        result = await callDeepSeekAPI(apiCtx, getActiveKey(), currentModel, messages, {
          max_tokens: 8192,
          step,
          reasoning_effort: effort,
          tools: nativeToolsEnabled ? activeToolDefs({ visionEnabled }) : undefined,
          onDelta: liveBubble.update
        });
      } catch (err) {
        if (stopRequested || err.name === 'AbortError') break;
        // Model doesn't accept image content → strip screenshots, go text-only
        if (visionEnabled && err.apiStatus === 400 && session.some(m => m.screenshotMsg)) {
          visionEnabled = false;
          for (const m of session) {
            if (m.screenshotMsg) { m.content = '[screenshot omitted — model does not accept images]'; delete m.screenshotMsg; }
          }
          debugEntry('vision_fallback', { step, reason: err.message });
          addActivity(step, 'warn', 'Vision not supported by model', 'Continuing text-only.', 'warn');
          step--;
          continue;
        }
        // Model/endpoint doesn't accept the reasoning params → drop them and retry.
        // Checked BEFORE the tools fallback: an "unknown parameter" 400 that
        // happens to mention tools would otherwise disable native tool calling
        // for the whole session over an unrelated rejected field.
        if (reasoningParamsSupported && err.apiStatus === 400
            && /reasoning_effort|thinking|unknown (?:field|parameter|argument)|unrecognized|unexpected key/i.test(err.message || '')) {
          reasoningParamsSupported = false;
          debugEntry('reasoning_params_fallback', { step, reason: err.message });
          addActivity(step, 'warn', 'Model rejected reasoning parameters',
            'Retrying without reasoning_effort/thinking — the model still works, just without explicit effort control.', 'warn');
          step--;
          continue;
        }
        // Model/endpoint doesn't accept the tools param → fall back to JSON protocol
        if (nativeToolsEnabled && err.apiStatus === 400 && /tool/i.test(err.message || '')) {
          nativeToolsEnabled = false;
          debugEntry('tools_fallback', { step, reason: err.message });
          addActivity(step, 'warn', 'Native tool calling unavailable', 'Falling back to JSON action protocol.', 'warn');
          step--;
          continue;
        }
        // An unknown/unavailable model is a configuration error, not a transient
        // one — say so in words the user can act on instead of "HTTP 400".
        if (err.apiStatus === 400 || err.apiStatus === 404) {
          if (/model/i.test(err.message || '')) {
            addActivity(step, 'error', `Model "${currentModel}" was rejected by the API`,
              `${err.message}\n\nPick a different model in the header dropdown, or correct MODEL_OPTIONS in src/shared/constants.js `
              + 'to match the ids your provider actually serves.', 'error');
            break;
          }
        }
        addActivity(step, 'error', 'API failed', err.message, 'error');
        break;
      } finally {
        liveBubble.remove();
      }
      if (stopRequested) break;

      session.push(sanitizeAssistantMessage(result.message));
      persistSession();

      let toolCalls = result.message.tool_calls || [];
      if (!toolCalls.length && result.content) {
        toolCalls = tryParseLegacyAction(result.content);
      }

      if (result.content) {
        if (toolCalls.length && toolCalls[0].legacy) {
          const thought = result.content.match(/Thought:\s*(.+?)(?=\n\{|$)/is)?.[1]?.trim();
          if (thought) addActivity(step, 'think', 'Thought', thought.slice(0, 400));
        } else {
          addMessage('assistant', result.content);
        }
      }

      if (!toolCalls.length) break; // plain reply — chat answer or final report

      let doneCalled = false;
      // Snapshot only after the last page-affecting call in this batch.
      const PAGE_ACTION_TOOLS = new Set(['left_click', 'click_coords', 'form_input', 'type', 'press_key',
        'scroll', 'scroll_to', 'navigate', 'go_back', 'go_forward', 'refresh', 'run_javascript', 'wait']);
      let lastPageActionIdx = -1;
      toolCalls.forEach((c, i) => {
        if (PAGE_ACTION_TOOLS.has(c.function?.name)) lastPageActionIdx = i;
      });
      for (let ti = 0; ti < toolCalls.length; ti++) {
        const tc = toolCalls[ti];
        if (stopRequested) { pushToolResult(tc, 'Interrupted by user.'); continue; }
        const name = tc.function?.name || '';
        let args = {};
        let argsBad = false;
        try { args = JSON.parse(tc.function?.arguments || '{}'); } catch (_) { argsBad = true; }
        if (argsBad) {
          // Usually a response truncated at max_tokens — don't run the tool with {}
          pushToolResult(tc, `Arguments for ${name} were malformed or truncated — re-issue the call with valid JSON.`);
          addActivity(step, 'warn', 'Malformed tool arguments', `${name}: ${String(tc.function?.arguments || '').slice(0, 120)}`, 'warn');
          continue;
        }

        if (name === 'done') {
          pushToolResult(tc, 'Acknowledged — goal marked complete.');
          addActivity(step, 'done', 'Goal complete', args.summary || 'Task finished.', 'success');
          doneCalled = true;
          continue;
        }

        addActivity(step, 'act', `Tool: ${name}`, summarizeArgs(args));
        const skipSnapshot = PAGE_ACTION_TOOLS.has(name) && ti !== lastPageActionIdx;
        const output = await withAgentTab(state, () => runTool(state, name, args, step, { skipSnapshot }), {
          allowDeadTab: ['list_tabs', 'open_tab', 'switch_tab', 'save_file', 'read_file', 'list_files',
            'append_rows', 'collect_rows', 'export_rows', 'data_report', 'run_control', 'ats_fetch', 'record_not_found'].includes(name)
        });
        pushToolResult(tc, output);
      }
      if (doneCalled) break;

      // Page unreadable as text/tree → hand the model a screenshot (newest only)
      if (visionEnabled && state.pendingScreenshot) {
        for (const m of session) {
          if (m.screenshotMsg) { m.content = '[older screenshot removed]'; delete m.screenshotMsg; }
        }
        session.push({
          role: 'user',
          screenshotMsg: true,
          content: [
            { type: 'text', text: 'Screenshot of the pinned tab (the page could not be read as text/tree — likely canvas-rendered):' },
            { type: 'image_url', image_url: { url: state.pendingScreenshot } }
          ]
        });
        state.pendingScreenshot = null;
        persistSession();
      }

      if (state.unchangedStreak >= MAX_STUCK) {
        addActivity(step, 'warn', 'Stopping — page not responding to actions',
          'Send a new instruction or take over manually.', 'warn');
        break;
      }
    }
  } finally {
    // Messages queued after the last drain still belong in history — the next
    // run will answer them.
    if (queuedMessages.length) {
      for (const q of queuedMessages) session.push({ role: 'user', content: q });
      queuedMessages = [];
      persistSession();
    }
    chrome.tabs.onCreated.removeListener(onTabCreated);
    apiAbortController = null;
    if (state.tabId != null && window.BrowserTools?.releaseDebugger) {
      await window.BrowserTools.releaseDebugger(state.tabId).catch(() => {});
    }
    if (state.borderShown) await showAgentBorder(state.tabId, false).catch(() => {});
    agentTabIdActive = null;
    isProcessing = false;
    if (stopBtn) {
      stopBtn.disabled = false;
      stopBtn.textContent = '■ Stop';
    }
    updateSendEnabled();
    debugEntry('run_end', { steps: step, stopped: stopRequested });
    if (stopRequested) {
      addActivity(null, 'warn', 'Agent stopped by user', `Completed ${step} step(s).`, 'warn');
    }
  }
}

// Note: does NOT reset isProcessing — runAgentLoop's finally block is the only
// place that flips it, so a second run can't start while the loop is winding down.
async function requestStop(reason = 'stopped') {
  stopRequested = true;
  if (stopBtn) {
    stopBtn.disabled = true;
    stopBtn.textContent = 'Stopping…';
  }
  if (apiAbortController) {
    try { apiAbortController.abort(); } catch (_) {}
  }
  if (agentTabIdActive != null && window.BrowserTools?.releaseDebugger) {
    await window.BrowserTools.releaseDebugger(agentTabIdActive).catch(() => {});
  }
  debugEntry('stop_requested', { reason });
  addActivity(null, 'warn', 'Stop requested', reason, 'warn');
}

function needsEnrichedRead(pageData) {
  const treeLen = (pageData?.accessibilityTree || '').length;
  const refCount = countRefsInTree(pageData?.accessibilityTree);
  return treeLen < 800 || refCount < 8;
}

// ── Key management + settings ─────────────────────────────────────
async function loadKeys() {
  const s = await chrome.storage.local.get(['deepseek_key']);
  apiKey = s.deepseek_key || DEEPSEEK_DEFAULT_KEY;
  updateKeyStatus();
}

function updateKeyStatus() {
  if (!keyStatusEl) return;
  const key = getActiveKey();
  keyStatusEl.textContent = key ? `Current key: ${maskKey(key)}` : 'No key set — get one at platform.deepseek.com';
}

async function saveKeyFromInput() {
  const v = (keyInput?.value || '').trim();
  if (!v) {
    if (keyStatusEl) keyStatusEl.textContent = 'Enter a key first';
    return;
  }
  apiKey = v;
  await chrome.storage.local.set({ deepseek_key: v })
    .catch((e) => debugEntry('save_key_failed', { error: e?.message }));
  if (keyInput) keyInput.value = '';
  updateKeyStatus();
  if (keyStatusEl) keyStatusEl.classList.add('ok');
  setTimeout(() => keyStatusEl?.classList.remove('ok'), 2000);
  updateSendEnabled();
}

// ── Site allowlist: page-modifying tools only run on approved origins ──
// Fails CLOSED (see lib/allowlist.js). Reading/scrolling/navigating stay open so
// the agent can still tell the user where it is and ask to be let in.
const SITE_GUARDED_TOOLS = new Set(['left_click', 'click_coords', 'form_input', 'type', 'press_key', 'run_javascript', 'extract_rows']);

async function loadAllowedSites() {
  const state = await Allowlist.loadAllowlist();
  allowedSites = state.sites;
  allowAllSites = state.allowAll;
  if (allowAllToggle) allowAllToggle.checked = allowAllSites;
  updateSitesStatus();
}

function updateSitesStatus() {
  if (!sitesStatusEl) return;
  sitesStatusEl.textContent = allowAllSites
    ? 'All sites allowed (unrestricted)'
    : allowedSites.length
      ? `${allowedSites.length} site(s) allowed: ${allowedSites.join(', ')}`
      : 'No sites allowed — page actions are off';
  sitesStatusEl.classList.toggle('warn', allowAllSites || !allowedSites.length);
}

// The bulk textarea editor is gone — day-to-day site approval is the one-click
// "Allow <site>" button (renderAllowCurrentSite/Allowlist.grantHost). This is the
// one remaining settings-driven write: the "Allow all sites" toggle, which never
// touches the sites LIST itself (Allowlist.saveAllowlist skips SITES_KEY when
// `sites` is omitted), only the separate unrestricted-mode flag.
async function saveAllowAllToggle() {
  const state = await Allowlist.saveAllowlist({ allowAll: !!allowAllToggle?.checked });
  allowedSites = state.sites;
  allowAllSites = state.allowAll;
  updateSitesStatus();
  renderAllowCurrentSite();
}

async function checkTabAccess(tabId) {
  let url = '';
  try {
    url = (await chrome.tabs.get(tabId)).url || '';
  } catch (e) {
    debugEntry('allowlist_tab_unreadable', { tabId, error: e.message });
    return { ok: false, reason: 'the working tab could not be read', host: null };
  }
  return Allowlist.decideAccess(url, allowedSites, allowAllSites);
}

// One-click grant for the tab the agent is actually on. The old default was
// "allow everything" largely because granting meant hand-editing a textarea;
// making the safe path the easy path is what lets the default be safe at all.
async function renderAllowCurrentSite() {
  if (!allowCurrentBtn) return;
  const tabId = agentTabIdActive ?? currentTab?.id ?? (await getActiveTab().catch(() => null))?.id;
  let host = null;
  if (tabId != null) {
    try { host = new URL((await chrome.tabs.get(tabId)).url || '').hostname.toLowerCase(); } catch (_) { host = null; }
  }
  const alreadyOk = !host || allowAllSites || allowedSites.some(p => host === p || host.endsWith('.' + p));
  allowCurrentBtn.hidden = !host || alreadyOk;
  allowCurrentBtn.textContent = host ? `Allow ${host}` : 'Allow this site';
  allowCurrentBtn.dataset.host = host || '';
}

// ── Session persistence (survives side-panel close, cleared on browser exit) ──
let persistTimer = null;
function flushSessionNow() {
  clearTimeout(persistTimer);
  persistTimer = null;
  chrome.storage.session.set({
    bat_session: session,
    bat_goal: currentGoal,
    bat_ui: uiLog.slice(-300),
    bat_usage: usageTotals,
    // Truncate details hard — a fat debug payload must never risk the quota
    // that conversation persistence depends on.
    bat_debug: debugLog.slice(-200).map(e =>
      typeof e.detail === 'string' && e.detail.length > 300 ? { ...e, detail: e.detail.slice(0, 300) } : e)
  }).catch(() => {});
}

function persistSession() {
  if (restoringUi) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(flushSessionNow, 300);
}

// The debounce loses the last write if the panel closes within 300ms — flush
// synchronously on pagehide so a fast close can't drop the newest messages.
window.addEventListener('pagehide', () => {
  if (persistTimer) flushSessionNow();
});

async function restoreSession() {
  try {
    const s = await chrome.storage.session.get(['bat_session', 'bat_goal', 'bat_ui', 'bat_usage', 'bat_debug']);
    if (!Array.isArray(s.bat_session) || !s.bat_session.length) return false;
    session = s.bat_session;
    currentGoal = s.bat_goal || '';
    if (s.bat_usage) usageTotals = s.bat_usage;
    if (Array.isArray(s.bat_debug)) debugLog = s.bat_debug;
    restoringUi = true;
    for (const e of s.bat_ui || []) {
      if (e.kind === 'message') addMessage(e.role, e.text);
      else if (e.kind === 'activity') addActivity(e.step, e.phase, e.title, e.detail, e.tone);
    }
    restoringUi = false;
    uiLog = Array.isArray(s.bat_ui) ? s.bat_ui : [];
    updateDebugStatus();
    return true;
  } catch {
    restoringUi = false;
    return false;
  }
}

// ── Chat UI ───────────────────────────────────────────────────────
function addMessage(role, text) {
  const div = document.createElement('div');
  div.className = `message ${role}`;
  div.textContent = text;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  if (!restoringUi) {
    uiLog.push({ kind: 'message', role, text: String(text).slice(0, 4000) });
    persistSession();
  }
  return div;
}

// Live bubble updated with streamed tokens, removed when the turn finalizes
function addStreamingBubble() {
  const div = document.createElement('div');
  div.className = 'message assistant streaming';
  div.textContent = 'Thinking…';
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  // Throttle to one DOM write per frame — per-token full-text rewrites are
  // O(n²) over a long completion.
  let pending = null;
  let scheduled = false;
  const apply = () => {
    scheduled = false;
    if (pending != null) {
      div.textContent = pending;
      chatEl.scrollTop = chatEl.scrollHeight;
      pending = null;
    }
  };
  return {
    update(text, kind) {
      pending = kind === 'reasoning' ? '💭 ' + text.slice(-600) : text;
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(apply);
      }
    },
    remove() { div.remove(); }
  };
}

function maskKey(key) {
  if (!key || key.length < 8) return '(none)';
  return '...' + key.slice(-4);
}

function debugEntry(type, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    runId: currentRunId,
    type,
    ...data
  };
  debugLog.push(entry);
  if (debugLog.length > 600) debugLog = debugLog.slice(-500);
  updateDebugStatus();
  return entry;
}

function formatTokens(n) {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

function updateDebugStatus() {
  if (!debugStatusEl) return;
  const tok = usageTotals.prompt + usageTotals.completion;
  debugStatusEl.textContent = `Debug: ${debugLog.length} events`
    + (tok ? ` · ${formatTokens(usageTotals.prompt)} in / ${formatTokens(usageTotals.completion)} out` : '');
  debugStatusEl.classList.remove('ok');
}

function addActivity(step, phase, title, detail, tone = '') {
  const meta = ACTIVITY_PHASES[phase] || ACTIVITY_PHASES.info;
  if (!restoringUi) {
    debugEntry('activity', {
      step,
      phase,
      title: title || meta.title,
      detail: detail ? String(detail).slice(0, 8000) : ''
    });
    uiLog.push({ kind: 'activity', step, phase, title, detail: detail ? String(detail).slice(0, 2000) : '', tone });
    persistSession();
  }

  const div = document.createElement('div');
  div.className = 'message activity' + (tone ? ' ' + tone : '');

  const top = document.createElement('div');
  top.className = 'activity-top';

  if (step != null) {
    const stepEl = document.createElement('span');
    stepEl.className = 'activity-step';
    stepEl.textContent = String(step);
    top.appendChild(stepEl);
  }

  const phaseEl = document.createElement('span');
  phaseEl.className = 'activity-phase';
  phaseEl.textContent = meta.title;
  top.appendChild(phaseEl);

  const titleEl = document.createElement('span');
  titleEl.className = 'activity-title';
  titleEl.textContent = title || '';
  top.appendChild(titleEl);

  div.appendChild(top);

  if (detail) {
    const detailEl = document.createElement('div');
    detailEl.className = 'activity-detail' + (detail.length > 280 ? ' collapsed' : '');
    detailEl.textContent = detail;
    div.appendChild(detailEl);

    if (detail.length > 280) {
      const expandBtn = document.createElement('button');
      expandBtn.className = 'activity-expand';
      expandBtn.textContent = 'Show more';
      expandBtn.onclick = () => {
        detailEl.classList.toggle('collapsed');
        expandBtn.textContent = detailEl.classList.contains('collapsed') ? 'Show more' : 'Show less';
      };
      div.appendChild(expandBtn);
    }
  }

  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  return div;
}

function buildDebugReport() {
  const runs = {};
  for (const e of debugLog) {
    const id = e.runId || 'unknown';
    if (!runs[id]) runs[id] = { events: 0, errors: 0 };
    runs[id].events++;
    if (e.phase === 'error' || e.type === 'api_error') runs[id].errors++;
  }

  return JSON.stringify({
    app: 'BAT',
    version: chrome.runtime.getManifest().version,
    model: currentModel,
    exportedAt: new Date().toISOString(),
    goal: currentGoal || null,
    apiKey: maskKey(getActiveKey()),
    activeTab: currentTab ? { id: currentTab.id, url: currentTab.url, title: currentTab.title } : null,
    sessionLength: session.length,
    usage: usageTotals,
    allowedSites,
    visionEnabled,
    nativeToolsEnabled,
    isProcessing,
    stopRequested,
    runsSummary: runs,
    log: debugLog
  }, null, 2);
}

async function copyDebugLog() {
  const report = buildDebugReport();
  try {
    await navigator.clipboard.writeText(report);
    if (debugStatusEl) {
      debugStatusEl.textContent = 'Copied! Paste into chat for help';
      debugStatusEl.classList.add('ok');
      setTimeout(() => updateDebugStatus(), 4000);
    }
    addActivity(null, 'info', 'Debug log copied to clipboard', 'Paste it in support chat so issues can be diagnosed.', 'success');
  } catch (err) {
    debugEntry('copy_error', { error: err.message });
    addActivity(null, 'error', 'Could not copy debug log', err.message, 'error');
  }
}

function clearChat() {
  if (isProcessing) {
    addMessage('system', 'Stop the agent before clearing the chat.');
    return;
  }
  session = [];
  currentGoal = '';
  debugLog = [];
  currentRunId = null;
  uiLog = [];
  usageTotals = { prompt: 0, completion: 0, requests: 0 };
  chrome.storage.session.remove(['bat_session', 'bat_goal', 'bat_ui', 'bat_usage', 'bat_debug'])
    .catch((e) => debugEntry('clear_session_failed', { error: e?.message }));
  chatEl.innerHTML = '';
  updateDebugStatus();
  addMessage('system', 'Chat cleared.');
}

// ── Tab helper ────────────────────────────────────────────────────
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  return tab;
}

// ── Global ref renumbering (one ref ID space across all frames) ───
function renumberTreeRefs(tree, frameId, registry, numbering) {
  if (!tree) return '';
  const lines = tree.split('\n');
  const out = [];
  for (const line of lines) {
    const m = line.match(/\[ref_(\d+)\]/);
    if (!m) { out.push(line); continue; }
    const localRef = 'ref_' + m[1];
    const key = frameId + ':' + localRef;
    let globalRef = numbering.byKey.get(key);
    if (!globalRef) {
      globalRef = 'ref_' + (++numbering.counter);
      numbering.byKey.set(key, globalRef);
    }
    const labelMatch = line.match(/"([^"]+)"/);
    registry[globalRef] = {
      frameId,
      localRef,
      label: labelMatch?.[1] || '',
      role: (line.match(/^\s*(\w+)/) || [])[1] || ''
    };
    out.push(line.replace(/\[ref_\d+\]/, '[' + globalRef + ']'));
  }
  return out.join('\n');
}

// ── Page content (text + accessibility tree) ──────────────────────
const TREE_READ_FUNC = () => {
  function getDialogSummary() {
    const selectors = [
      '[role="dialog"]', '[role="alertdialog"]',
      '[aria-modal="true"]',
      '[class*="modal"]:not([class*="modaloverlay"]):not([class*="modal-overlay"])',
      '[class*="popup"]', '[class*="lightbox"]', '[class*="overlay"][class*="active"]'
    ];
    for (const sel of selectors) {
      try {
        for (const el of document.querySelectorAll(sel)) {
          const s = window.getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden') continue;
          const r = el.getBoundingClientRect();
          if (r.width < 50 || r.height < 50) continue;
          const text = (el.innerText || '').replace(/\s+/g, ' ').trim().substring(0, 200);
          if (text.length < 5) continue;
          return `\n⚠️ POPUP/DIALOG DETECTED: "${text}" — click its button before anything else\n`;
        }
      } catch (_) {}
    }
    return '';
  }

  if (typeof window.__generateAccessibilityTree === 'function') {
    try {
      const result = window.__generateAccessibilityTree('all');
      const tree = result.pageContent || '';
      const dialog = getDialogSummary();
      return { tree: dialog + tree, isFrame: window !== window.top, frameUrl: location.href };
    } catch (err) {
      return { tree: null, isFrame: window !== window.top, frameUrl: location.href, error: String(err) };
    }
  }
  return { tree: null, isFrame: window !== window.top, frameUrl: location.href, missingTreeFn: true };
};

async function injectTreeScript(tabId, frameIds) {
  const target = frameIds?.length ? { tabId, frameIds } : { tabId, allFrames: true };
  try {
    await chrome.scripting.executeScript({
      target,
      files: [accessibilityTreeScript],
      injectImmediately: true,
      world: 'ISOLATED'
    });
  } catch (e) {
    debugEntry('inject_tree_failed', { tabId, frameIds, error: e?.message || String(e) });
  }
}

async function readAccessibilityTrees(tabId) {
  try {
    return await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      injectImmediately: true,
      world: 'ISOLATED',
      func: TREE_READ_FUNC
    });
  } catch (e) {
    debugEntry('read_trees_failed', { tabId, error: e?.message || String(e) });
    return [];
  }
}

function mergeTreeResults(treeResults, tabId) {
  const registry = {};
  const numbering = getRefNumbering(tabId);
  const mergedTrees = [];

  const mainEntry = treeResults?.find(r => !r.result?.isFrame);
  if (mainEntry?.result?.tree) {
    mergedTrees.push(renumberTreeRefs(mainEntry.result.tree, mainEntry.frameId ?? 0, registry, numbering));
  }

  const iframeEntries = (treeResults || [])
    .filter(r => r.result?.isFrame && r.result?.tree)
    .sort((a, b) => (b.result.tree?.length || 0) - (a.result.tree?.length || 0));

  for (const entry of iframeEntries) {
    const frameUrl = entry.result?.frameUrl || '';
    const tree = renumberTreeRefs(entry.result.tree, entry.frameId, registry, numbering);
    mergedTrees.push(`--- iframe${frameUrl ? ' (' + frameUrl + ')' : ''} ---\n` + tree);
  }

  return { registry, accessibilityTree: mergedTrees.join('\n') };
}

// Single-pass observer: title + url + text + tree + (course-mode) checkboxes
// from every frame in ONE injection. Generating the tree also refreshes the
// element maps, so no separate refresh pass exists any more.
const OBSERVE_FUNC = (courseMode) => {
  function getDialogSummary() {
    const selectors = [
      '[role="dialog"]', '[role="alertdialog"]',
      '[aria-modal="true"]',
      '[class*="modal"]:not([class*="modaloverlay"]):not([class*="modal-overlay"])',
      '[class*="popup"]', '[class*="lightbox"]', '[class*="overlay"][class*="active"]'
    ];
    for (const sel of selectors) {
      try {
        for (const el of document.querySelectorAll(sel)) {
          const s = window.getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden') continue;
          const r = el.getBoundingClientRect();
          if (r.width < 50 || r.height < 50) continue;
          const text = (el.innerText || '').replace(/\s+/g, ' ').trim().substring(0, 200);
          if (text.length < 5) continue;
          return `\n⚠️ POPUP/DIALOG DETECTED: "${text}" — click its button before anything else\n`;
        }
      } catch (_) {}
    }
    return '';
  }

  const out = {
    url: location.href || '',
    title: document.title || '',
    isFrame: window !== window.top,
    hasTreeFn: typeof window.__generateAccessibilityTree === 'function',
    tree: null,
    text: (document.body?.innerText || '').substring(0, 12000),
    checkboxes: [],
    extras: []
  };

  // Gathered unconditionally in THIS pass. It used to require a second
  // all-frames injection (PageTools.getEnrichedPageText) decided after the
  // observation came back — so a weak page paid for two full cross-frame
  // round-trips per agent step. Collecting it is cheap; deciding whether to
  // SHOW it is free.
  try {
    const seen = Object.create(null);
    for (const el of document.querySelectorAll('[aria-label], img[alt], [title]')) {
      const s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      const raw = el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || '';
      const clean = raw.replace(/\s+/g, ' ').trim();
      if (clean.length > 2 && clean.length < 200 && !seen[clean]) {
        seen[clean] = 1;
        out.extras.push(clean);
        if (out.extras.length >= 200) break;
      }
    }
  } catch (_) { /* extras are an enrichment, never a reason to fail the read */ }

  if (out.hasTreeFn) {
    try {
      const result = window.__generateAccessibilityTree('all');
      out.tree = getDialogSummary() + (result.pageContent || '');
    } catch (err) {
      out.treeError = String(err);
    }
  }

  if (courseMode) {
    try {
      for (const el of document.querySelectorAll('input[type="checkbox"], [role="checkbox"]')) {
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        const label = (el.getAttribute('aria-label')
          || el.closest('label')?.innerText
          || el.parentElement?.innerText
          || '').replace(/\s+/g, ' ').trim().slice(0, 100);
        if (!label) continue;
        out.checkboxes.push({ label, checked: el.checked || el.getAttribute('aria-checked') === 'true' });
      }
    } catch (_) {}
  }
  return out;
};

async function getPageContent(tabId) {
  try {
    const BT = window.BrowserTools;
    if (BT) await BT.waitForPageIdle(tabId, 3000);
    if (BT?.waitForDomQuiet) await BT.waitForDomQuiet(tabId, { quietMs: 200, maxMs: 600 });

    const courseMode = tabCourseMode.get(tabId) === true;
    const observe = () => chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      injectImmediately: true,
      world: 'ISOLATED',
      func: OBSERVE_FUNC,
      args: [courseMode]
    }).catch(() => []);

    let results = await observe();
    if (!results?.length) return null;

    // Frames created after page load miss the declared content script — inject
    // it only where the observer reported it absent, then re-observe once.
    const missing = results.filter(r => r.result && !r.result.hasTreeFn)
      .map(r => r.frameId)
      .filter(id => id != null);
    if (missing.length) {
      await injectTreeScript(tabId, missing);
      await delay(250);
      results = await observe();
    }

    const frames = (results || []).filter(r => r.result);
    const main = frames.find(r => !r.result.isFrame) || frames[0];
    if (!main) return null;

    const { registry, accessibilityTree } = mergeTreeResults(
      frames.map(r => ({
        frameId: r.frameId,
        result: { isFrame: r.result.isFrame, tree: r.result.tree, frameUrl: r.result.url }
      })),
      tabId
    );
    tabRefRegistry.set(tabId, registry);

    let text = main.result.text || '';
    const framePages = frames
      .filter(r => r.result.isFrame && (r.result.text?.length || 0) > 20)
      .sort((a, b) => (b.result.text?.length || 0) - (a.result.text?.length || 0));
    if (framePages.length) {
      text += '\n\n' + framePages.map(f =>
        `--- iframe (${f.result.url}) ---\n${f.result.text}`
      ).join('\n\n');
      text = text.substring(0, 20000);
    }

    const seen = new Set();
    const checkboxSummary = frames.flatMap(r => r.result.checkboxes || []).filter(c => {
      const key = c.label.slice(0, 60);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const extras = [...new Set(frames.flatMap(r => r.result.extras || []))];

    return {
      title: main.result.title,
      url: main.result.url,
      text,
      accessibilityTree,
      checkboxSummary,
      extras,
      frameCount: frames.length,
      treeFrameCount: frames.filter(r => (r.result.tree?.length || 0) > 0).length
    };
  } catch (e) {
    // Returning bare null for any of a dozen distinct failures made the single
    // most common "the agent can't see the page" complaint undiagnosable — and
    // "Copy debug log" is this project's entire support story.
    debugEntry('observe_failed', { tabId, error: e?.message || String(e) });
    return null;
  }
}

const DIALOG_BUTTON_SCAN_FUNC = (label) => {
  const want = (label || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!want) return null;
  const isVisible = (el) => {
    const s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2;
  };
  const norm = (t) => (t || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const selectors = 'button, a, [role="button"], input[type="button"], input[type="submit"], .slide-object, .acc-button, .cs-button, [class*="btn"], [class*="Button"]';
  let best = null;
  for (const el of document.querySelectorAll(selectors)) {
    if (!isVisible(el)) continue;
    const text = norm(el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '');
    if (text !== want) continue;
    const r = el.getBoundingClientRect();
    best = { x: r.left + r.width / 2, y: r.top + r.height / 2, label: text.slice(0, 120) };
    break;
  }
  return best;
};

async function findDialogButtonByDom(tabId, label) {
  if (!label) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      injectImmediately: true,
      world: 'ISOLATED',
      func: DIALOG_BUTTON_SCAN_FUNC,
      args: [label]
    });
    const hits = (results || []).filter(r => r.result?.x != null);
    if (!hits.length) return null;
    const best = hits.reduce((a, b) => {
      const al = (a.result.label || '').length;
      const bl = (b.result.label || '').length;
      return bl > al ? b : a;
    });
    const offset = await getFrameChainOffset(tabId, best.frameId);
    return {
      x: Math.round(best.result.x + offset.left),
      y: Math.round(best.result.y + offset.top),
      label: best.result.label
    };
  } catch (e) {
    debugEntry('dialog_button_scan_failed', { tabId, label, error: e?.message || String(e) });
    return null;
  }
}

async function tryDismissResumeDialog(tabId, resumeClickStreak = 0) {
  const BT = window.BrowserTools;
  if (!BT) return { dismissed: false };
  const label = resumeClickStreak >= 2 ? 'Restart' : 'Resume';
  let coords = await findDialogButtonByDom(tabId, label);
  if (!coords && label === 'Resume') {
    coords = await findDialogButtonByDom(tabId, 'Restart');
  }
  if (!coords) return { dismissed: false };
  try {
    await BT.cdpClick(tabId, coords.x, coords.y, (x, y, action) => updatePhantomCursor(tabId, x, y, action));
    await BT.delay(RESUME_DIALOG_WAIT_MS);
    const check = await getPageContent(tabId);
    const stillOpen = check ? detectResumeDialog(check).open : true;
    return { dismissed: !stillOpen, label: coords.label, method: 'auto-dismiss' };
  } catch {
    return { dismissed: false };
  }
}

// Assemble the enriched read from data the observation pass already returned.
// Same output shape PageTools.getEnrichedPageText produced, minus the extra
// all-frames injection it used to cost.
function buildEnrichedText(data, maxChars) {
  const chunks = [];
  if (data.title) chunks.push('Title: ' + data.title);
  const body = (data.text || '').replace(/\s+/g, ' ').trim();
  if (body) chunks.push(body);

  const labels = [...(data.extras || [])];
  for (const c of data.checkboxSummary || []) {
    labels.push(`[checkbox ${c.checked ? 'ON' : 'off'}] ${c.label}`);
  }
  if (labels.length) chunks.push('--- labels & controls ---\n' + [...new Set(labels)].join('\n'));
  return chunks.join('\n\n').slice(0, maxChars);
}

// Observe: (course mode) scroll quiz into view → single-pass read → gated hints.
// skipAutoScroll: after an explicit scroll action, don't yank the page back to the quiz.
async function observePage(tabId, resumeClickStreak = 0, autoDismissAttempted = false, skipAutoScroll = false) {
  const wasCourse = tabCourseMode.get(tabId) === true;
  if (wasCourse && !skipAutoScroll) await scrollQuizIntoView(tabId);
  const data = await getPageContent(tabId);
  if (!data) return null;

  const PT = window.PageTools;
  const courseMode = updateCourseMode(tabId, data);
  data.courseMode = courseMode;
  data.quizInfo = courseMode ? detectQuizPage(data) : EMPTY_QUIZ;
  data.resumeDialog = courseMode ? detectResumeDialog(data) : { open: false, hasResume: false, hasRestart: false };

  if (courseMode && data.resumeDialog.open && !autoDismissAttempted) {
    const dismiss = await tryDismissResumeDialog(tabId, resumeClickStreak);
    if (dismiss.dismissed) {
      const refreshed = await observePage(tabId, resumeClickStreak, true, skipAutoScroll);
      if (refreshed) refreshed.autoDismissed = dismiss.label;
      return refreshed;
    }
  }

  // Built from what the single observation pass already returned — no second
  // cross-frame injection. Only assembled when the tree/text is actually too
  // weak to act on, so a normal page pays nothing for it.
  if (data.quizInfo.isQuiz || data.resumeDialog.open || needsEnrichedRead(data)) {
    data.enrichedText = buildEnrichedText(data, FOCUS_TEXT_CHARS + 2000);
  }

  if (courseMode && PT?.mapCheckboxRefs) {
    const registry = tabRefRegistry.get(tabId);
    data.checkboxRefs = await PT.mapCheckboxRefs(tabId, registry);
  }

  // Canvas-rendered page: tree+text stay weak even after enrichment — capture a
  // screenshot only when the active model can actually read images.
  if (visionEnabled && needsEnrichedRead(data) && (data.enrichedText || '').length < 400) {
    const BT = window.BrowserTools;
    data.screenshotDataUrl = BT?.cdpScreenshot
      ? await BT.cdpScreenshot(tabId).catch(() => null)
      : null;
  }

  return data;
}

// ── Click by ref: element-map lookup + CDP trusted click ──────────

async function updatePhantomCursor(tabId, x, y, action) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'UPDATE_PHANTOM_CURSOR', x, y, action });
  } catch (_) {
    // Expected and harmless: the cursor content script is absent on
    // chrome:// pages, PDFs, and frames that block injection. Purely cosmetic.
  }
}

function lookupRefInFrame(localRef) {
  try {
    let el = null;
    const maps = [window.__batElementMap];
    for (const map of maps) {
      if (!map || !map[localRef]) continue;
      const w = map[localRef];
      el = typeof w.deref === 'function' ? w.deref() : w;
      if (el && !document.contains(el)) { delete map[localRef]; el = null; }
      if (el) break;
    }
    if (!el) el = document.querySelector('[data-ext-ref="' + localRef + '"]');
    if (!el) return { success: false };
    el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return { success: false };
    const label = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    return { success: true, x: r.left + r.width / 2, y: r.top + r.height / 2, label };
  } catch (_) { return { success: false }; }
}

// Walk the frame tree from the parent side (webNavigation), so offsets are
// correct even across cross-origin boundaries where frameElement is null.
async function getFrameOffsetViaParents(tabId, frameId) {
  let frames;
  try { frames = await chrome.webNavigation.getAllFrames({ tabId }); } catch { return null; }
  if (!frames?.length) return null;
  const byId = new Map(frames.map(f => [f.frameId, f]));
  let left = 0, top = 0;
  let current = byId.get(frameId);
  let hops = 0;
  while (current && current.frameId !== 0 && hops++ < 8) {
    const parentId = current.parentFrameId;
    if (parentId == null || parentId < 0) break;
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [parentId] },
      injectImmediately: true,
      world: 'ISOLATED',
      func: (childUrl) => {
        const frames = document.querySelectorAll('iframe, frame');
        let el = null;
        for (const f of frames) {
          try {
            if (f.contentWindow && f.contentWindow.location.href === childUrl) { el = f; break; }
          } catch (_) { /* cross-origin — can't read location */ }
        }
        if (!el) {
          for (const f of frames) {
            try {
              const src = f.getAttribute('src');
              if (src && new URL(src, location.href).href === childUrl) { el = f; break; }
            } catch (_) {}
          }
        }
        if (!el && frames.length === 1) el = frames[0];
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top };
      },
      args: [current.url || '']
    });
    const r = res?.result;
    if (!r) return null;
    left += r.left;
    top += r.top;
    current = byId.get(parentId);
  }
  return { left, top };
}

async function getFrameChainOffset(tabId, frameId) {
  if (!frameId) return { left: 0, top: 0 };
  const viaParents = await getFrameOffsetViaParents(tabId, frameId).catch(() => null);
  if (viaParents) return viaParents;
  // Same-origin fallback: walk frameElement from inside the frame
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      injectImmediately: true,
      world: 'ISOLATED',
      func: () => {
        let left = 0, top = 0;
        let win = window;
        while (win !== win.top) {
          const fe = win.frameElement;
          if (!fe) break;
          const r = fe.getBoundingClientRect();
          left += r.left;
          top += r.top;
          win = win.parent;
        }
        return { left, top };
      }
    });
    return res?.result || { left: 0, top: 0 };
  } catch {
    return { left: 0, top: 0 };
  }
}

async function resolveRefTarget(tabId, refId) {
  const registry = tabRefRegistry.get(tabId);
  if (registry?.[refId]) {
    return { frameId: registry[refId].frameId, localRef: registry[refId].localRef };
  }
  return { frameId: null, localRef: refId };
}

async function getRefCoordinatesInFrame(tabId, frameId, localRef) {
  const target = frameId != null ? { tabId, frameIds: [frameId] } : { tabId, allFrames: true };
  const results = await chrome.scripting.executeScript({
    target,
    injectImmediately: true,
    func: lookupRefInFrame,
    args: [localRef],
    world: 'ISOLATED'
  });

  if (frameId != null) {
    const hit = results?.[0]?.result;
    if (!hit?.success) return null;
    const offset = await getFrameChainOffset(tabId, frameId);
    return {
      x: Math.round(hit.x + offset.left),
      y: Math.round(hit.y + offset.top),
      label: hit.label
    };
  }

  const hits = (results || []).filter(r => r.result?.success);
  if (!hits.length) return null;
  const best = hits.reduce((a, b) => {
    const al = (a.result.label || '').length;
    const bl = (b.result.label || '').length;
    return bl > al ? b : a;
  });
  const hit = best.result;
  const offset = await getFrameChainOffset(tabId, best.frameId);
  return {
    x: Math.round(hit.x + offset.left),
    y: Math.round(hit.y + offset.top),
    label: hit.label
  };
}

async function syncRefRegistry(tabId) {
  // Reading the trees regenerates the element maps as a side effect — no
  // separate refresh pass needed.
  const treeResults = await readAccessibilityTrees(tabId);
  const { registry } = mergeTreeResults(treeResults, tabId);
  tabRefRegistry.set(tabId, registry);
  return registry;
}

async function findCoordsByRegistryLabel(tabId, needle) {
  const registry = tabRefRegistry.get(tabId);
  if (!registry || !needle) return null;
  const lower = needle.replace(/\s+/g, ' ').trim().toLowerCase();
  let best = null;
  let bestScore = 0;

  for (const [globalRef, entry] of Object.entries(registry)) {
    const lab = (entry.label || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!lab || /^question\s*[(:]/i.test(lab) || /single choice question/i.test(lab)) continue;
    if (lab.length > 140 && entry.role !== 'radio' && entry.role !== 'checkbox') continue;
    if ((lower === 'resume' || lower === 'restart') && lab !== lower) continue;
    const score = lab === lower ? 1000
      : lab.includes(lower) ? lower.length + 100
      : lower.includes(lab.slice(0, 40)) ? lab.length : 0;
    if (score <= bestScore) continue;
    const coords = await getRefCoordinatesInFrame(tabId, entry.frameId, entry.localRef);
    if (coords) { bestScore = score; best = { ...coords, matchedRef: globalRef }; }
  }
  return best;
}

async function getRefCoordinatesByText(tabId, text) {
  const dialogLabel = extractDialogTargetLabel(text);
  if (dialogLabel) {
    const dialogRefs = findDialogButtonRefs(tabId);
    const entry = dialogLabel === 'restart' ? dialogRefs.restart : dialogRefs.resume;
    if (entry) {
      const coords = await getRefCoordinatesInFrame(tabId, entry.frameId, entry.localRef);
      if (coords) return { ...coords, matchedRef: entry.ref };
    }
    const registryHit = await findCoordsByRegistryLabel(tabId, dialogLabel);
    if (registryHit) return registryHit;
  }

  const needle = (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (needle.length < 4) return null;

  const registryHit = await findCoordsByRegistryLabel(tabId, needle);
  if (registryHit) return registryHit;

  const exactDialog = needle === 'resume' || needle === 'restart';
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    injectImmediately: true,
    world: 'ISOLATED',
    func: (needle, exactDialog) => {
      const candidates = document.querySelectorAll(
        'button, a, input, label, div, span, li, [role="button"], [role="radio"], [role="checkbox"], [class*="option"], [class*="answer"], [class*="choice"], [class*="selectable"]'
      );
      let best = null;
      let bestScore = 0;
      for (const el of candidates) {
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        const label = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
        const lower = label.toLowerCase();
        if (/^question\s*[(:]/i.test(lower) || /single choice question/i.test(lower)) continue;
        if (label.length > 140 && !/\b(option|answer|choice)\b/i.test(el.className || '')) continue;
        if (exactDialog) {
          if (lower !== needle) continue;
        } else if (!lower.includes(needle) && !(needle.length >= 5 && lower.length >= 4 && needle.includes(lower))) {
          continue;
        }
        let score = lower === needle ? 1000 : lower.includes(needle) ? needle.length + 50 : lower.length;
        if (/\b(option|answer|choice|selectable)\b/i.test(el.className || '')) score += 80;
        if (el.type === 'radio' || el.getAttribute('role') === 'radio') score += 60;
        if (score > bestScore) {
          bestScore = score;
          best = { x: r.left + r.width / 2, y: r.top + r.height / 2, label: label.slice(0, 120) };
        }
      }
      return best;
    },
    args: [needle.slice(0, 120), exactDialog]
  });

  const hits = (results || []).filter(r => r.result);
  if (!hits.length) return null;
  const best = hits.reduce((a, b) => ((a.result.label || '').length > (b.result.label || '').length ? a : b));
  const offset = await getFrameChainOffset(tabId, best.frameId);
  return {
    x: Math.round(best.result.x + offset.left),
    y: Math.round(best.result.y + offset.top),
    label: best.result.label
  };
}

async function getRefCoordinates(tabId, refId) {
  const { frameId, localRef } = await resolveRefTarget(tabId, refId);
  let coords = await getRefCoordinatesInFrame(tabId, frameId, localRef);
  if (!coords && frameId != null) {
    coords = await getRefCoordinatesInFrame(tabId, null, localRef);
  }
  return coords;
}

function extractDialogTargetLabel(text) {
  const t = (text || '').toLowerCase();
  if (/\brestart\b/.test(t)) return 'restart';
  if (/\bresume\b/.test(t)) return 'resume';
  return '';
}

function extractClickHint(text) {
  const dialog = extractDialogTargetLabel(text);
  if (dialog) return dialog;
  if (!text) return '';
  const quoted = text.match(/['"]([^'"]{3,})['"]/);
  if (quoted) return quoted[1];
  const select = text.match(/(?:select|click|choose)\s+(.+)/i);
  return (select?.[1] || text).replace(/^\[.*?\]\s*/, '').trim();
}

async function resolveClickTarget(tabId, refId, hintText) {
  const dialogLabel = extractDialogTargetLabel(hintText);
  if (dialogLabel) {
    const domLabel = dialogLabel === 'restart' ? 'Restart' : 'Resume';
    const domHit = await findDialogButtonByDom(tabId, domLabel);
    if (domHit) {
      return { coords: domHit, frameId: null, localRef: refId, targetRef: refId, dialogLabel };
    }
  }

  let targetRef = refId;
  let coords = await getRefCoordinates(tabId, refId);
  let { frameId, localRef } = await resolveRefTarget(tabId, refId);

  if (coords && dialogLabel && coords.label) {
    const clicked = coords.label.replace(/\s+/g, ' ').trim().toLowerCase();
    if (clicked !== dialogLabel && !clicked.includes(dialogLabel)) {
      coords = null;
    }
  }

  if (!coords && dialogLabel) {
    const dialogRefs = findDialogButtonRefs(tabId);
    const entry = dialogLabel === 'restart' ? dialogRefs.restart : dialogRefs.resume;
    if (entry) {
      targetRef = entry.ref;
      frameId = entry.frameId;
      localRef = entry.localRef;
      coords = await getRefCoordinatesInFrame(tabId, frameId, localRef);
    }
  }

  const hint = extractClickHint(hintText);
  if (!coords && hint) coords = await getRefCoordinatesByText(tabId, hint);
  if (!coords && hint) {
    const byLabel = await findCoordsByRegistryLabel(tabId, hint);
    if (byLabel) {
      coords = byLabel;
      if (byLabel.matchedRef) {
        targetRef = byLabel.matchedRef;
        ({ frameId, localRef } = await resolveRefTarget(tabId, targetRef));
      }
    }
  }

  return { coords, frameId, localRef, targetRef, dialogLabel };
}

async function clickByRef(tabId, refId, hintText, options = {}) {
  const BT = window.BrowserTools;
  if (!BT) return { success: false, error: 'BrowserTools not loaded' };
  const { forceCdp = false, preferCdp = false } = options;
  const wantCdp = forceCdp || preferCdp || !!extractDialogTargetLabel(hintText);

  // Fast path: a plain DOM click needs only the ref→frame mapping — resolving
  // CDP coordinates (extra injections + frame-offset walks) is deferred until
  // the CDP path is actually taken.
  let registrySynced = !!options.registrySynced;
  if (!wantCdp && BT.clickRef) {
    let { frameId, localRef } = await resolveRefTarget(tabId, refId);
    let domResult = await BT.clickRef(tabId, frameId, localRef);
    if (!domResult.success) {
      await syncRefRegistry(tabId);
      registrySynced = true;
      ({ frameId, localRef } = await resolveRefTarget(tabId, refId));
      domResult = await BT.clickRef(tabId, frameId, localRef);
    }
    if (domResult.success) {
      await delay(250);
      return {
        success: true,
        label: domResult.label,
        detail: domResult.isCheckable ? (domResult.checked ? 'checked' : 'unchecked') : 'DOM click',
        method: 'dom'
      };
    }
  }

  let resolved = await resolveClickTarget(tabId, refId, hintText);
  if (!resolved.coords && !registrySynced) {
    await syncRefRegistry(tabId);
    resolved = await resolveClickTarget(tabId, refId, hintText);
  }

  const { coords, dialogLabel } = resolved;

  if (!coords) {
    return { success: false, error: 'Element ' + refId + ' not found' };
  }

  if (dialogLabel && coords.label) {
    const clicked = coords.label.replace(/\s+/g, ' ').trim().toLowerCase();
    if (clicked !== dialogLabel && !clicked.includes(dialogLabel)) {
      return {
        success: false,
        error: `Wrong target "${coords.label}" — expected ${dialogLabel}`
      };
    }
  }

  try {
    const onCursor = (x, y, action) => updatePhantomCursor(tabId, x, y, action);
    await BT.cdpClick(tabId, coords.x, coords.y, onCursor);
    return { success: true, label: coords.label, detail: 'CDP click', method: 'cdp' };
  } catch (e) {
    return { success: false, error: e.message || 'CDP click failed' };
  }
}

async function showAgentBorder(tabId, show) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (show) => {
        const BORDER_ID = '__ext_agent_border';
        const STYLE_ID = '__ext_agent_style';
        if (!show) {
          document.getElementById(BORDER_ID)?.remove();
          document.getElementById(STYLE_ID)?.remove();
          return;
        }
        if (document.getElementById(BORDER_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = '@keyframes __ext_pulse{0%,100%{box-shadow:inset 0 0 0 3px rgba(217,119,87,0.7)}50%{box-shadow:inset 0 0 0 4px rgba(217,119,87,1)}}';
        (document.head || document.documentElement).appendChild(style);
        const div = document.createElement('div');
        div.id = BORDER_ID;
        div.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483645;animation:__ext_pulse 2s ease-in-out infinite;';
        document.body.appendChild(div);
      },
      args: [show]
    });
  } catch (e) {
    debugEntry('agent_border_failed', { tabId, show, error: e?.message || String(e) });
  }
}

// ── handleSend: one unified loop — the model decides chat vs tools ──
async function handleSend() {
  const promptText = promptInput.value.trim();
  if (!promptText || !getActiveKey()) return;

  if (isProcessing) {
    addMessage('user', promptText);
    queuedMessages.push(promptText);
    debugEntry('user_message_queued', { text: promptText.slice(0, 500) });
    addActivity(null, 'info', 'Message queued', 'The agent will see it at its next step.');
    promptInput.value = '';
    updateSendEnabled();
    return;
  }

  addMessage('user', promptText);
  debugEntry('user_message', { text: promptText.slice(0, 500) });
  promptInput.value = '';

  try {
    await runAgentLoop(promptText);
  } catch (err) {
    if (stopRequested || err.name === 'AbortError') return;
    debugEntry('fatal_error', { error: err.message });
    addActivity(null, 'error', 'Unexpected error', err.message, 'error');
    isProcessing = false;
    updateSendEnabled();
  }
}

// ── AI: focused read_page context (smaller, quiz-aware) ────────────
function buildPageContext(goal, pageData, tabId = null, resumeClickStreak = 0) {
  const {
    title = '', url = '', accessibilityTree = '', text = '',
    enrichedText = '', checkboxSummary = [], checkboxRefs = []
  } = pageData || {};
  const quiz = pageData?.quizInfo || EMPTY_QUIZ;

  let ctx = buildResumeDialogHint(pageData, tabId, resumeClickStreak);
  ctx += buildQuizPhaseHint(pageData);
  ctx += `Title: ${title}\nURL: ${url}\n`;
  if (quiz.isQuiz) ctx += `Mode: quiz (${quiz.multi ? 'multi-select' : 'single'})\n`;
  ctx += '\n';

  if (accessibilityTree) {
    ctx += `read_page:\n${extractFocusedTree(accessibilityTree, pageData)}`;
  } else {
    ctx += `read_page: (empty — use page_text below)`;
  }

  const pageText = enrichedText || text;
  if (pageText) {
    ctx += `\n\npage_text:\n${extractFocusedText(pageText, pageData)}`;
  }

  if (checkboxRefs.length) {
    ctx += '\n\ncheckbox refs:\n' + checkboxRefs.map(c =>
      `${c.ref}: ${c.label}`
    ).join('\n');
  }

  if (checkboxSummary.length) {
    ctx += '\n\ncheckbox state:\n' + checkboxSummary.map((c, i) =>
      `${i + 1}. [${c.checked ? 'CHECKED' : 'unchecked'}] ${c.label}`
    ).join('\n');
  }

  if (goal) ctx += `\n\nGoal: ${goal}`;
  return ctx;
}

// ── The one seam between the panel and the transport layer ────────
// Everything the DeepSeek client needs from the panel, named explicitly. The
// transports used to reach directly into module-level mutable state, which is
// why they could not be moved or tested.
const apiCtx = {
  abortSignal: () => apiAbortController?.signal || null,
  isStopRequested: () => stopRequested,
  debug: (type, data) => debugEntry(type, data),
  maskKey: (key) => maskKey(key),
  // Both conditions matter: the model must support reasoning AND the provider
  // must not have already rejected the parameters this session.
  reasoningEnabled: (model) => modelSupportsThinking(model) && reasoningParamsSupported,
  onUsage: (usage) => {
    usageTotals.prompt += usage.prompt_tokens || 0;
    usageTotals.completion += usage.completion_tokens || 0;
    usageTotals.requests++;
    updateDebugStatus();
  }
};

// DeepSeek transport now lives in ./deepseek.js

// ── Background runner events: one in-place progress line + real entries ──
let runProgressEl = null;
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'BAT_RUN_EVENT') return;
  const ev = message.event;
  if (ev === 'progress') {
    const text = `Run ${message.runId}: unit ${Math.min((message.unitIndex ?? 0) + 1, message.units || 1)}/${message.units || '?'}`
      + `${message.page != null ? `, page ${message.page}` : ''} · ${message.counts?.pages ?? 0} pages · ${message.counts?.rows ?? 0} rows (${message.outcome})`;
    const titleEl = runProgressEl?.isConnected ? runProgressEl.querySelector('.activity-title') : null;
    if (titleEl) {
      titleEl.textContent = text;
    } else {
      runProgressEl = addActivity(null, 'info', text, '');
    }
    return;
  }
  runProgressEl = null; // next progress starts a fresh line under this event
  if (ev === 'awaiting_human') {
    addActivity(null, 'warn', 'Run needs you — AWAITING HUMAN', `${message.note}\nSolve it in the run's tab, then say "resume the run".`, 'warn');
  } else if (ev === 'unit_blocked') {
    addActivity(null, 'warn', `Unit ${message.unitId} abandoned (BLOCKED)`, message.note || 'repeated failures — run continues with the next unit', 'warn');
  } else if (ev === 'run_done') {
    addActivity(null, 'done', 'Background run complete', `${message.counts?.pages ?? 0} pages · ${message.counts?.rows ?? 0} rows collected. Ask for data_report / export_rows for final totals.`, 'success');
  } else if (ev === 'extractor_synthesized') {
    addActivity(null, 'act', 'Runner synthesized extractor', `${message.pattern}\n--- function source ---\n${message.source || ''}`, 'success');
  }
});

// ── Event wiring (Send + Stop) ────────────────────────────────────
sendBtn.addEventListener('click', handleSend);
promptInput.addEventListener('input', () => {
  updateSendEnabled();
  // Auto-grow the composer with its content (CSS max-height caps it at 180px)
  promptInput.style.height = 'auto';
  promptInput.style.height = Math.min(promptInput.scrollHeight, 180) + 'px';
});
promptInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
});
if (modelSelect) {
  modelSelect.addEventListener('change', () => saveModel(modelSelect.value));
}
clearChatBtn.addEventListener('click', clearChat);
if (copyDebugBtn) copyDebugBtn.addEventListener('click', copyDebugLog);
if (settingsBtn && settingsPanel) {
  settingsBtn.addEventListener('click', () => { settingsPanel.hidden = !settingsPanel.hidden; });
}
if (saveKeyBtn) saveKeyBtn.addEventListener('click', saveKeyFromInput);
if (keyInput) {
  keyInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); saveKeyFromInput(); }
  });
}
async function updateWorkspaceStatus() {
  if (!workspaceStatusEl) return;
  const s = await Workspace.getStatus();
  workspaceStatusEl.textContent = s.text;
  workspaceStatusEl.classList.toggle('ok', s.ok);
}

if (workspaceBtn) {
  workspaceBtn.addEventListener('click', async () => {
    try {
      await Workspace.pickWorkspace();
    } catch (e) {
      // AbortError is the user closing the picker — anything else is a real fault.
      if (e?.name !== 'AbortError') {
        debugEntry('workspace_pick_failed', { error: e?.message || String(e) });
        addActivity(null, 'error', 'Could not set the workspace folder', e?.message || String(e), 'error');
      }
    }
    updateWorkspaceStatus();
  });
}

if (allowAllToggle) allowAllToggle.addEventListener('change', saveAllowAllToggle);

if (allowCurrentBtn) {
  allowCurrentBtn.addEventListener('click', async () => {
    const host = allowCurrentBtn.dataset.host;
    if (!host) return;
    try {
      await Allowlist.grantHost(host);
      await loadAllowedSites();
      addActivity(null, 'info', `Allowed ${host}`, 'Page actions are now enabled for this site. Ask the agent to retry.', 'success');
    } catch (e) {
      addActivity(null, 'error', 'Could not allow site', e.message, 'error');
    }
    renderAllowCurrentSite();
  });
}

// ── Stored-data manager ───────────────────────────────────────────
function dataSection(title, rows) {
  const sec = document.createElement('div');
  sec.className = 'data-section';
  const h = document.createElement('h3');
  h.textContent = title;
  sec.appendChild(h);
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'data-empty';
    empty.textContent = 'Nothing stored.';
    sec.appendChild(empty);
  } else {
    for (const r of rows) sec.appendChild(r);
  }
  return sec;
}

function dataRow({ name, meta, actions = [], expandable = null }) {
  const row = document.createElement('div');
  row.className = 'data-row';
  const main = document.createElement('div');
  main.className = 'data-main';
  const nameEl = document.createElement('div');
  nameEl.className = 'data-name';
  nameEl.textContent = name;
  main.appendChild(nameEl);
  if (meta) {
    const metaEl = document.createElement('div');
    metaEl.className = 'data-meta';
    metaEl.textContent = meta;
    main.appendChild(metaEl);
  }
  if (expandable) {
    const btn = document.createElement('button');
    btn.className = 'btn-mini';
    btn.textContent = 'Show source';
    const pre = document.createElement('div');
    pre.className = 'data-src';
    pre.textContent = expandable;
    pre.hidden = true;
    btn.onclick = () => {
      pre.hidden = !pre.hidden;
      btn.textContent = pre.hidden ? 'Show source' : 'Hide source';
    };
    main.appendChild(btn);
    main.appendChild(pre);
  }
  row.appendChild(main);
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.className = 'btn-mini' + (a.danger ? ' danger' : '');
    btn.textContent = a.label;
    btn.onclick = a.onClick;
    row.appendChild(btn);
  }
  return row;
}

async function renderDataPanel() {
  if (!dataBody) return;
  dataBody.textContent = 'Loading…';
  const confirmed = (msg) => window.confirm(msg);
  try {
    const [collections, extractors, runs] = await Promise.all([
      Store.listCollections().catch((e) => { debugEntry('data_list_collections_failed', { error: e.message }); return []; }),
      Store.listExtractors().catch((e) => { debugEntry('data_list_extractors_failed', { error: e.message }); return []; }),
      Store.listRuns().catch((e) => { debugEntry('data_list_runs_failed', { error: e.message }); return []; })
    ]);
    dataBody.textContent = '';

    dataBody.appendChild(dataSection('Collected data', collections.map((c) => dataRow({
      name: c.collection,
      meta: `${c.uniqueRows} unique row(s) · ${c.duplicatesMerged} duplicate(s) merged`,
      actions: [{
        label: 'Delete', danger: true,
        onClick: async () => {
          if (!confirmed(`Delete all stored rows for "${c.collection}"?\n\nThis removes them from BAT's store. The file on disk is left alone.`)) return;
          const n = await Store.deleteCollection(c.collection);
          addActivity(null, 'info', 'Collection deleted', `${c.collection}: ${n} stored row(s) removed`, 'success');
          renderDataPanel();
        }
      }]
    }))));

    dataBody.appendChild(dataSection('Cached extractors', extractors.map((x) => dataRow({
      name: x.pattern,
      meta: `${x.status}${x.consecutiveFailures ? ` · ${x.consecutiveFailures} consecutive failure(s)` : ''}`
        + `${x.lastFailure ? ` · last: ${String(x.lastFailure).slice(0, 90)}` : ''}`
        + `${x.history?.length ? ` · ${x.history.length} retired version(s)` : ''}`,
      expandable: x.current?.source || null,
      actions: [{
        label: 'Delete', danger: true,
        onClick: async () => {
          if (!confirmed(`Delete the cached extractor for "${x.pattern}"?\n\nThe next run on that site will synthesize a new one.`)) return;
          await Store.deleteExtractor(x.pattern);
          addActivity(null, 'info', 'Extractor deleted', x.pattern, 'success');
          renderDataPanel();
        }
      }]
    }))));

    const sortedRuns = [...runs].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    dataBody.appendChild(dataSection('Runs', sortedRuns.map((r) => {
      const actions = [];
      if (r.status === 'running') {
        actions.push({
          label: 'Pause',
          onClick: async () => {
            const res = await sendRunCmd('pause', r.id);
            addActivity(null, res.ok ? 'info' : 'warn', res.ok ? `Run ${r.id} paused` : 'Could not pause', res.note || res.error || '', res.ok ? 'success' : 'warn');
            renderDataPanel();
          }
        });
      } else if (['paused', 'awaiting_human', 'draft', 'failed'].includes(r.status)) {
        actions.push({
          label: 'Resume',
          onClick: async () => {
            const res = await sendRunCmd('start', r.id);
            addActivity(null, res.ok ? 'info' : 'warn', res.ok ? `Run ${r.id} resumed` : 'Could not resume', res.note || res.error || '', res.ok ? 'success' : 'warn');
            renderDataPanel();
          }
        });
      }
      actions.push({
        label: 'Delete', danger: true,
        onClick: async () => {
          if (r.status === 'running') { window.alert('Pause the run before deleting it.'); return; }
          if (!confirmed(`Delete run ${r.id} and its log?\n\nCollected rows are NOT deleted — remove them under "Collected data" if you want those gone too.`)) return;
          await Store.deleteRun(r.id);
          addActivity(null, 'info', 'Run deleted', r.id, 'success');
          renderDataPanel();
        }
      });
      return dataRow({
        name: `${r.id} — ${String(r.status).toUpperCase()}`,
        meta: `${r.plan?.filename || '(no file)'} · unit ${Math.min((r.pos?.unitIndex ?? 0) + 1, r.plan?.units?.length || 1)}/${r.plan?.units?.length || '?'}`
          + ` · ${r.counts?.pages ?? 0} page(s) · ${r.counts?.rows ?? 0} row(s)${r.note ? ` · ${String(r.note).slice(0, 90)}` : ''}`,
        actions
      });
    })));
  } catch (e) {
    dataBody.textContent = `Could not read stored data: ${e.message}`;
    debugEntry('data_panel_failed', { error: e.message });
  }
}

async function updateDataStatus() {
  if (!dataStatusEl) return;
  try {
    const [collections, extractors, runs] = await Promise.all([
      Store.listCollections(), Store.listExtractors(), Store.listRuns()
    ]);
    const rows = collections.reduce((n, c) => n + c.uniqueRows, 0);
    dataStatusEl.textContent = `${rows} row(s), ${extractors.length} extractor(s), ${runs.length} run(s)`;
  } catch (e) {
    dataStatusEl.textContent = 'unavailable';
    debugEntry('data_status_failed', { error: e.message });
  }
}

if (dataBtn && dataPanel) {
  dataBtn.addEventListener('click', () => {
    dataPanel.hidden = false;
    renderDataPanel();
  });
}
if (dataCloseBtn && dataPanel) {
  dataCloseBtn.addEventListener('click', () => {
    dataPanel.hidden = true;
    updateDataStatus();
  });
}

// Stop button
if (stopBtn) {
  stopBtn.addEventListener('click', () => { requestStop('User clicked Stop'); });
}

// ── Init ──────────────────────────────────────────────────────────
(async function init() {
  await loadKeys();
  await loadAllowedSites();
  await loadModel();
  updateWorkspaceStatus();
  updateDebugStatus();

  const restored = await restoreSession();
  if (restored) {
    addMessage('system', 'Restored previous conversation.');
  } else {
    addMessage('system', `Ask anything (${getModelLabel()}). I can also control this tab — e.g. "complete this course" — using native tool calling.`);
  }

  if (!getActiveKey()) {
    if (settingsPanel) settingsPanel.hidden = false;
    addMessage('system', 'Set your DeepSeek API key in Settings (⚙) to start.');
  }

  try { await getActiveTab(); } catch (e) { debugEntry('init_active_tab_failed', { error: e.message }); }
  updateDataStatus();
  renderAllowCurrentSite();

  // Default-deny is only humane if the user is told, once, why nothing happens.
  if (!allowAllSites && !allowedSites.length) {
    addMessage('system',
      'No sites are approved yet, so I can read pages but not click, type, or run page code. '
      + 'Use the "Allow <site>" button (or Settings → Allowed sites) to let me act on a site.');
  }

  // Surface any background run that survived while the panel was closed.
  try {
    const runs = await Store.listRuns();
    const active = runs
      .filter(r => ['running', 'awaiting_human', 'paused'].includes(r.status))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    if (active) {
      addActivity(null, active.status === 'awaiting_human' ? 'warn' : 'info',
        `Background run ${active.id}: ${active.status.toUpperCase()}`,
        `unit ${Math.min(active.pos.unitIndex + 1, active.plan.units.length)}/${active.plan.units.length} · ${active.counts.rows} rows${active.note ? ' — ' + active.note : ''}. Ask "run status" or "resume the run".`,
        active.status === 'awaiting_human' ? 'warn' : '');
    }
  } catch (_) {}

  promptInput.focus();
  updateSendEnabled();
})();
