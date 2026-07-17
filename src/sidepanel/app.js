import '../lib/browser-tools.js';
import '../lib/page-tools.js';
import accessibilityTreeScript from '../content/accessibility-tree.js?script';
import {
  DEEPSEEK_API,
  DEFAULT_MODEL,
  DEEPSEEK_DEFAULT_KEY,
  MODEL_OPTIONS,
  MAX_STUCK,
  MAX_STEPS,
  FOCUS_TREE_CHARS,
  FOCUS_QUIZ_TREE_CHARS,
  FOCUS_TEXT_CHARS,
  API_TIMEOUT_MS,
  RESUME_DIALOG_WAIT_MS,
  SUBMIT_CLICK_RE,
  QUIZ_FAIL_RE,
  QUIZ_PASS_RE,
  RESUME_DIALOG_RE,
  ACTIVITY_PHASES
} from '../shared/constants.js';
import { parseAgentResponse, normalizeAction } from '../agent/parse.js';

// Side panel entry: renders the chat UI and runs the agent loop.

// ── State ─────────────────────────────────────────────────────────
let currentModel    = DEFAULT_MODEL;
let apiKey          = '';
let session         = [];   // unified chat + tool-call history (persists across sends)
let nativeToolsEnabled = true; // flips to false if the model rejects the tools param
let currentGoal       = '';
let debugLog          = [];
let currentRunId      = null;
let currentTab      = null;
let isProcessing    = false;
let stopRequested   = false;
let apiAbortController = null;
let agentTabIdActive = null;
let visionEnabled   = true;  // flips to false if the model rejects image content
let allowedSites    = [];    // empty = act on any site
let usageTotals     = { prompt: 0, completion: 0, requests: 0 };
let uiLog           = [];    // rendered transcript, persisted for panel reopen
let restoringUi     = false;

// Maps tabId → { globalRef → { frameId, localRef, label? } }
// Each iframe assigns ref_1, ref_2… independently; we renumber on merge so clicks hit the right frame.
const tabRefRegistry = new Map();

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
const allowedSitesInput = document.getElementById('allowedSitesInput');
const saveSitesBtn  = document.getElementById('saveSitesBtn');
const sitesStatusEl = document.getElementById('sitesStatus');

// ── Helpers ───────────────────────────────────────────────────────
const delay = ms => new Promise(r => setTimeout(r, ms));

function getActiveKey() {
  return apiKey || DEEPSEEK_DEFAULT_KEY || null;
}

function updateSendEnabled() {
  const hasKey = !!getActiveKey();
  const hasText = !!(promptInput?.value.trim());
  if (sendBtn) sendBtn.disabled = !hasKey || isProcessing || !hasText;
  if (promptInput) promptInput.disabled = !hasKey || isProcessing;
  if (stopBtn) stopBtn.classList.toggle('visible', isProcessing);
  if (modelSelect) modelSelect.disabled = isProcessing;
}

// ── Unified system prompt + native tool definitions ───────────────
const LEGACY_PROTOCOL = `
TOOL PROTOCOL (fallback — native tool calling unavailable): reply with a short "Thought:" line, then exactly ONE JSON object, e.g.
{"action":"left_click","ref":"ref_5","text":"Check button"}
Actions: left_click(ref), form_input(ref,value), type(ref,value), key(key), scroll_down, scroll_up, scroll_to(ref), find(value), navigate(url), go_back, go_forward, refresh, javascript(value), wait, batch(actions:[...]), done(text).`;

function buildSystemPrompt() {
  return `You are BAT, an assistant in a Chrome side panel. You chat normally AND can control a browser tab with tools. You are pinned to the tab where the task started (the user may be viewing a different tab — that is fine and does not affect your work). If the page opens a new tab, you follow it automatically.
Current model: ${getModelLabel()} (API id: ${currentModel}). If asked which model you run, state that — do not guess.

Deciding when to act: if the user asks a question, answer it (read the page first when the question is about the current page). If they ask you to do something on a page, use tools until the goal is complete.

PAGE OBSERVATIONS
- Pages are presented as an accessibility tree with [ref_N] ids on interactive elements; pass those refs to click/input tools.
- After every action the tool result includes a fresh snapshot: URL, title, dialog/quiz hints, checkbox state, and the tree (or "UNCHANGED" when nothing changed).
- read_page with ref_id zooms into one element (use when the full tree is truncated); get_page_text returns readable text; find searches for text and returns matching refs.
- Canvas-rendered pages (empty tree): use screenshot to see the page, then click_coords to act on it.
- Tabs: list_tabs / open_tab / switch_tab let you work across tabs; new tabs open in the background so the user is not interrupted.
- Debugging a broken page: read_console for JS errors, read_network for failed requests.

WORKING STYLE
- Handle popups/dialogs first. SCORM/Storyline Resume dialog: click Resume once and wait; if still open after 2 tries, click Restart instead — never click Resume 3 times.
- Quiz pages: select answer(s) → click Check/Submit → read the feedback → only then Next/Continue. Prefer form_input for checkboxes. If feedback says incorrect, change answers before re-submitting.
- If a snapshot says UNCHANGED, your action likely missed: scroll_to the target, use find, try a different ref, or run_javascript as a last resort.
- Chain independent steps as multiple tool calls in one turn; they execute in order.
- Keep user-facing text brief; narrate only key findings or strategy changes.
- Call done (with a summary) only when the goal is fully achieved.${nativeToolsEnabled ? '' : '\n' + LEGACY_PROTOCOL}`;
}

const TOOL_DEFS = [
  { type: 'function', function: { name: 'read_page', description: 'Read the current page accessibility tree with [ref_N] ids on interactive elements. No arguments = whole page. Pass ref_id (and optional depth) to zoom into one element and see detail hidden by truncation.', parameters: { type: 'object', properties: { filter: { type: 'string', enum: ['all', 'interactive'], description: 'interactive = only clickable/input elements' }, ref_id: { type: 'string', description: 'Zoom into this element, e.g. "ref_12"' }, depth: { type: 'integer', description: 'Max tree depth when zooming (default 10)' } } } } },
  { type: 'function', function: { name: 'get_page_text', description: 'Read the visible text of the page from all frames. Better than read_page for reading course content, questions, and feedback messages.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'find', description: 'Search the page for text; returns matching elements with their refs.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'left_click', description: 'Click an element by ref.', parameters: { type: 'object', properties: { ref: { type: 'string' }, description: { type: 'string', description: 'Visible label of the target — used as fallback matching if the ref went stale' } }, required: ['ref'] } } },
  { type: 'function', function: { name: 'form_input', description: 'Set a checkbox/radio/select/input by ref. For checkboxes pass "true" or "false"; for selects/inputs pass the value. More reliable than clicking on SCORM/LMS pages.', parameters: { type: 'object', properties: { ref: { type: 'string' }, value: { type: 'string' } }, required: ['ref', 'value'] } } },
  { type: 'function', function: { name: 'type', description: 'Type text into an input by ref (replaces the existing value).', parameters: { type: 'object', properties: { ref: { type: 'string' }, text: { type: 'string' } }, required: ['ref', 'text'] } } },
  { type: 'function', function: { name: 'press_key', description: 'Press a keyboard key: Enter, Tab, Escape, ArrowDown, ArrowUp, Space…', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } } },
  { type: 'function', function: { name: 'scroll', description: 'Scroll the page up or down.', parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['down', 'up'] } }, required: ['direction'] } } },
  { type: 'function', function: { name: 'scroll_to', description: 'Scroll an element into view by ref. Do this before clicking below-the-fold elements.', parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] } } },
  { type: 'function', function: { name: 'navigate', description: 'Go to a URL in the current tab.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'go_back', description: 'Browser history back.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'go_forward', description: 'Browser history forward.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'refresh', description: 'Reload the current page.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'run_javascript', description: 'Run a JavaScript expression in the page and return its result. Use to read state the tree misses, or as a last-resort interaction.', parameters: { type: 'object', properties: { code: { type: 'string' }, ref: { type: 'string', description: 'Optional ref whose frame the code should run in' } }, required: ['code'] } } },
  { type: 'function', function: { name: 'wait', description: 'Wait ~1.5 seconds for the page to load/settle, then observe it.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'screenshot', description: 'Capture a screenshot of the working tab, attached as an image after the tool results. Use when the page is canvas-rendered (Storyline/Captivate) or the tree/text is too weak to act on.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'click_coords', description: 'Click at viewport coordinates (from a screenshot). Use when no ref exists for the target, e.g. canvas-rendered pages.', parameters: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' }, button: { type: 'string', enum: ['left', 'right'] }, double: { type: 'boolean', description: 'true = double-click' } }, required: ['x', 'y'] } } },
  { type: 'function', function: { name: 'list_tabs', description: 'List all open browser tabs with ids. The tab you are working in is marked with →.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'open_tab', description: 'Open a URL in a NEW background tab and start working in it (the user keeps their current view).', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'switch_tab', description: 'Move your work to another open tab by id (see list_tabs).', parameters: { type: 'object', properties: { tab_id: { type: 'integer' } }, required: ['tab_id'] } } },
  { type: 'function', function: { name: 'read_console', description: 'Read console logs/errors from the working tab (starts capturing on first call). Optional regex pattern filter.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, limit: { type: 'integer' } } } } },
  { type: 'function', function: { name: 'read_network', description: 'Read network requests from the working tab: method, status, URL, failures (starts capturing on first call). Optional regex url filter.', parameters: { type: 'object', properties: { filter: { type: 'string' }, limit: { type: 'integer' } } } } },
  { type: 'function', function: { name: 'done', description: "Declare the user's goal fully achieved (e.g. end of course reached).", parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } } }
];

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
  chrome.storage.local.set({ bat_model: modelId }).catch(() => {});
  if (modelSelect) modelSelect.value = modelId;
  updateModelHint();
}

// ── Agent loop: read_page tree + left_click by ref via CDP ────────
function normalizeTreeFingerprint(tree) {
  return (tree || '')
    .replace(/\[ref_\d+\]/g, '[ref]')
    .replace(/\bref_\d+\b/g, 'ref')
    .replace(/--- iframe[^)]*\) ---/g, '--- iframe ---')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 3500);
}

function detectResumeDialog(pageData) {
  const blob = [
    pageData?.accessibilityTree,
    pageData?.text,
    pageData?.enrichedText
  ].filter(Boolean).join('\n');
  const lower = blob.toLowerCase();
  const hasResumeBtn = /\bbutton\s+"resume"/i.test(blob)
    || /\b"resume"\s*\[ref/i.test(blob)
    || /\bresume\b[^\n]{0,40}\[ref_\d+\]/i.test(blob);
  const hasRestartBtn = /\bbutton\s+"restart"/i.test(blob)
    || /\brestart\b[^\n]{0,40}\[ref_\d+\]/i.test(blob);
  const open = (hasResumeBtn || hasRestartBtn)
    && (/resume|restart/i.test(lower) || RESUME_DIALOG_RE.test(lower) || /pop.?up|dialog|alertdialog/i.test(lower));
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
  const dialog = pageData?.resumeDialog || detectResumeDialog(pageData);
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
  const blob = [
    pageData?.accessibilityTree,
    pageData?.enrichedText,
    pageData?.text
  ].filter(Boolean).join('\n');
  const lower = blob.toLowerCase();
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
  const quiz = pageData?.quizInfo || detectQuizPage(pageData);
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
  const quiz = pageData?.quizInfo || detectQuizPage(pageData);
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
  } catch (_) {}
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
  } catch {
    return { text: '', failed: false, passed: false, snippet: '' };
  }
}

function getBatchStepDelay(currentStep, nextStep, tabId) {
  if (nextStep && isSubmitLikeClick(nextStep, tabId)) return 1400;
  if (currentStep?.action === 'form_input') return 700;
  return 450;
}

function buildQuizPhaseHint(pageData) {
  const quiz = pageData?.quizInfo || detectQuizPage(pageData);
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
      const dialogNav = isDialogNavClick(action, tabId) || !!extractDialogTargetLabel(action.text);
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
      if (result.success && (isSubmitLikeClick(action, tabId) || isCheckClick(action, tabId))) {
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
      if (result.success) await BT.delay(350);
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
    case 'find': {
      if (!PT?.findOnPage) return { success: false, error: 'PageTools not loaded' };
      const hits = await PT.findOnPage(tabId, action.value || action.text);
      return {
        success: true,
        detail: hits.length ? `found ${hits.length} match(es)` : 'no matches',
        label: hits.slice(0, 3).map(h => (h.ref || '?') + ': ' + h.label).join('; ')
      };
    }
    case 'type': {
      let coords = await getRefCoordinates(tabId, action.ref);
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
const CONTEXT_CHAR_BUDGET = 100000;   // prune old tool results past this
const KEEP_FULL_TOOL_RESULTS = 3;     // most recent tool results kept verbatim

const READ_ONLY_TOOLS = new Set(['read_page', 'get_page_text', 'find']);

function pruneSessionForBudget() {
  const sessionSize = () =>
    session.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);
  if (sessionSize() <= CONTEXT_CHAR_BUDGET) return;

  // Pass 1: shrink old tool results (biggest payloads)
  const toolIdx = [];
  for (let i = 0; i < session.length; i++) {
    if (session[i].role === 'tool' || session[i].legacyToolResult) toolIdx.push(i);
  }
  for (const i of toolIdx.slice(0, Math.max(0, toolIdx.length - KEEP_FULL_TOOL_RESULTS))) {
    const m = session[i];
    if (!m.pruned && typeof m.content === 'string' && m.content.length > 400) {
      m.content = m.content.slice(0, 300) + '\n[older observation trimmed — call read_page for current state]';
      m.pruned = true;
    }
  }
  if (sessionSize() <= CONTEXT_CHAR_BUDGET) return;

  // Pass 2: trim old user/assistant prose too (keep the most recent exchanges intact)
  for (let i = 0; i < session.length - 8; i++) {
    const m = session[i];
    if ((m.role === 'user' || m.role === 'assistant') && !m.pruned
      && typeof m.content === 'string' && m.content.length > 600) {
      m.content = m.content.slice(0, 400) + '\n[older message trimmed]';
      m.pruned = true;
      if (sessionSize() <= CONTEXT_CHAR_BUDGET) return;
    }
  }
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
  if (!/\{[\s\S]*"action"/.test(content || '')) return [];
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
    case 'scroll':         return { action: args.direction === 'up' ? 'scroll_up' : 'scroll_down' };
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
  return buildSnapshot(state, { force: true });
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

async function runTool(state, name, args, step) {
  if (name === 'read_page') return readPageTool(state, args);
  if (name === 'get_page_text') return getPageTextTool(state);

  if (name === 'screenshot') {
    if (!visionEnabled) return 'Screenshot unavailable — the model rejected image input earlier in this session. Use read_page/get_page_text/run_javascript instead.';
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
      const head = r.first
        ? 'Capture just started — entries accumulate from now on; interact with the page and call again to see more.\n'
        : '';
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

  const action = toolCallToAction(name, args);
  if (!action) return `Unknown tool: ${name}`;

  if (SITE_GUARDED_TOOLS.has(name) && !(await isTabAllowed(state.tabId))) {
    return 'Blocked: this site is not in the allowed-sites list (extension Settings), so page-modifying tools are disabled here. Read, scroll, and navigate tools still work.';
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
    pendingScreenshot: null
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
  }
  debugEntry('run_start', { goal: userText, tabId: state.tabId, url: tab?.url });
  repairSessionToolCalls();
  session.push({ role: 'user', content: userText });
  persistSession();

  let step = 0;
  try {
    while (step < MAX_STEPS && !stopRequested) {
      step++;
      pruneSessionForBudget();
      const messages = [{ role: 'system', content: buildSystemPrompt() }, ...session];

      let result;
      const liveBubble = addStreamingBubble();
      try {
        result = await callDeepSeekAPI(getActiveKey(), currentModel, messages, {
          max_tokens: 8192,
          step,
          tools: nativeToolsEnabled ? TOOL_DEFS : undefined,
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
        // Model/endpoint doesn't accept the tools param → fall back to JSON protocol
        if (nativeToolsEnabled && err.apiStatus === 400 && /tool/i.test(err.message || '')) {
          nativeToolsEnabled = false;
          debugEntry('tools_fallback', { step, reason: err.message });
          addActivity(step, 'warn', 'Native tool calling unavailable', 'Falling back to JSON action protocol.', 'warn');
          step--;
          continue;
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
      for (const tc of toolCalls) {
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
        const output = await withAgentTab(state, () => runTool(state, name, args, step), {
          allowDeadTab: name === 'list_tabs' || name === 'open_tab' || name === 'switch_tab'
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
  await chrome.storage.local.set({ deepseek_key: v }).catch(() => {});
  if (keyInput) keyInput.value = '';
  updateKeyStatus();
  if (keyStatusEl) keyStatusEl.classList.add('ok');
  setTimeout(() => keyStatusEl?.classList.remove('ok'), 2000);
  updateSendEnabled();
}

// ── Site allowlist: page-modifying tools only run on listed domains ──
const SITE_GUARDED_TOOLS = new Set(['left_click', 'click_coords', 'form_input', 'type', 'press_key', 'run_javascript']);

function parseAllowedSites(text) {
  return [...new Set((text || '')
    .split(/[\r\n,]+/)
    .map(s => s.trim().toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^\*\./, '')
      .replace(/\/.*$/, ''))
    .filter(Boolean))];
}

async function loadAllowedSites() {
  const s = await chrome.storage.local.get(['bat_allowed_sites']);
  allowedSites = Array.isArray(s.bat_allowed_sites) ? s.bat_allowed_sites : [];
  if (allowedSitesInput) allowedSitesInput.value = allowedSites.join('\n');
  updateSitesStatus();
}

function updateSitesStatus() {
  if (sitesStatusEl) {
    sitesStatusEl.textContent = allowedSites.length
      ? `${allowedSites.length} site(s) allowed`
      : 'All sites allowed';
  }
}

async function saveAllowedSites() {
  allowedSites = parseAllowedSites(allowedSitesInput?.value);
  await chrome.storage.local.set({ bat_allowed_sites: allowedSites }).catch(() => {});
  if (allowedSitesInput) allowedSitesInput.value = allowedSites.join('\n');
  updateSitesStatus();
}

async function isTabAllowed(tabId) {
  if (!allowedSites.length) return true;
  try {
    const tab = await chrome.tabs.get(tabId);
    const host = new URL(tab.url || '').hostname.toLowerCase();
    return allowedSites.some(p => host === p || host.endsWith('.' + p));
  } catch {
    return false;
  }
}

// ── Session persistence (survives side-panel close, cleared on browser exit) ──
let persistTimer = null;
function persistSession() {
  if (restoringUi) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    chrome.storage.session.set({
      bat_session: session,
      bat_goal: currentGoal,
      bat_ui: uiLog.slice(-300),
      bat_usage: usageTotals
    }).catch(() => {});
  }, 300);
}

async function restoreSession() {
  try {
    const s = await chrome.storage.session.get(['bat_session', 'bat_goal', 'bat_ui', 'bat_usage']);
    if (!Array.isArray(s.bat_session) || !s.bat_session.length) return false;
    session = s.bat_session;
    currentGoal = s.bat_goal || '';
    if (s.bat_usage) usageTotals = s.bat_usage;
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
  return {
    update(text, kind) {
      div.textContent = kind === 'reasoning' ? '💭 ' + text.slice(-600) : text;
      chatEl.scrollTop = chatEl.scrollHeight;
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
  chrome.storage.session.remove(['bat_session', 'bat_goal', 'bat_ui', 'bat_usage']).catch(() => {});
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
function renumberTreeRefs(tree, frameId, registry, counter) {
  if (!tree) return { tree: '', counter };
  const lines = tree.split('\n');
  const out = [];
  for (const line of lines) {
    const m = line.match(/\[ref_(\d+)\]/);
    if (!m) { out.push(line); continue; }
    const localRef = 'ref_' + m[1];
    const globalRef = 'ref_' + (++counter);
    const labelMatch = line.match(/"([^"]+)"/);
    registry[globalRef] = {
      frameId,
      localRef,
      label: labelMatch?.[1] || '',
      role: (line.match(/^\s*(\w+)/) || [])[1] || ''
    };
    out.push(line.replace(/\[ref_\d+\]/, '[' + globalRef + ']'));
  }
  return { tree: out.join('\n'), counter };
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

async function probeFrames(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      injectImmediately: true,
      world: 'ISOLATED',
      func: () => ({
        url: location.href,
        ready: document.readyState,
        hasTree: typeof window.__generateAccessibilityTree === 'function',
        textLen: (document.body?.innerText || '').length,
        isFrame: window !== window.top
      })
    });
    return results || [];
  } catch {
    return [];
  }
}

async function injectTreeScript(tabId, frameIds) {
  const target = frameIds?.length ? { tabId, frameIds } : { tabId, allFrames: true };
  try {
    await chrome.scripting.executeScript({
      target,
      files: [accessibilityTreeScript],
      injectImmediately: true,
      world: 'ISOLATED'
    });
  } catch (_) {}
}

async function readAccessibilityTrees(tabId) {
  try {
    return await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      injectImmediately: true,
      world: 'ISOLATED',
      func: TREE_READ_FUNC
    });
  } catch {
    return [];
  }
}

function mergeTreeResults(treeResults) {
  const registry = {};
  let refCounter = 0;
  const mergedTrees = [];

  const mainEntry = treeResults?.find(r => !r.result?.isFrame);
  if (mainEntry?.result?.tree) {
    const { tree, counter } = renumberTreeRefs(mainEntry.result.tree, mainEntry.frameId ?? 0, registry, refCounter);
    refCounter = counter;
    mergedTrees.push(tree);
  }

  const iframeEntries = (treeResults || [])
    .filter(r => r.result?.isFrame && r.result?.tree)
    .sort((a, b) => (b.result.tree?.length || 0) - (a.result.tree?.length || 0));

  for (const entry of iframeEntries) {
    const frameUrl = entry.result?.frameUrl || '';
    const { tree, counter } = renumberTreeRefs(entry.result.tree, entry.frameId, registry, refCounter);
    refCounter = counter;
    mergedTrees.push(`--- iframe${frameUrl ? ' (' + frameUrl + ')' : ''} ---\n` + tree);
  }

  return { registry, accessibilityTree: mergedTrees.join('\n'), refCounter };
}

async function getPageContent(tabId) {
  try {
    const BT = window.BrowserTools;
    if (BT) await BT.waitForPageIdle(tabId, 3000);
    await delay(250);

    // 1. Raw text from all frames
    const pageResults = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      injectImmediately: true,
      world: 'ISOLATED',
      func: () => ({
        title: document.title || '',
        url: location.href || '',
        text: (document.body?.innerText || '').substring(0, 12000),
        isFrame: window !== window.top
      })
    });
    if (!pageResults?.length) return null;

    let frameProbe = await probeFrames(tabId);
    const missingTreeFrames = frameProbe
      .filter(r => !r.result?.hasTree)
      .map(r => r.frameId)
      .filter(id => id != null);

    if (missingTreeFrames.length) {
      await injectTreeScript(tabId, missingTreeFrames);
      await delay(350);
      frameProbe = await probeFrames(tabId);
    }

    await refreshElementMaps(tabId);
    let treeResults = await readAccessibilityTrees(tabId);

    let totalTreeLen = (treeResults || []).reduce((n, r) => n + (r.result?.tree?.length || 0), 0);
    if (totalTreeLen < 20) {
      await injectTreeScript(tabId, null);
      await delay(500);
      await refreshElementMaps(tabId);
      treeResults = await readAccessibilityTrees(tabId);
      totalTreeLen = (treeResults || []).reduce((n, r) => n + (r.result?.tree?.length || 0), 0);
    }

    const main = pageResults.find(r => !r.result?.isFrame) || pageResults[0];
    const framePages = pageResults
      .filter(r => r.result?.isFrame && (r.result?.text?.length || 0) > 20)
      .sort((a, b) => (b.result?.text?.length || 0) - (a.result?.text?.length || 0));

    const { registry, accessibilityTree } = mergeTreeResults(treeResults);
    tabRefRegistry.set(tabId, registry);

    let text = main?.result?.text || '';
    if (framePages.length) {
      text += '\n\n' + framePages.map(f => {
        const u = f.result?.url ? ` (${f.result.url})` : '';
        return `--- iframe${u} ---\n${f.result.text}`;
      }).join('\n\n');
      text = text.substring(0, 20000);
    }

    let frameMeta = [];
    try {
      const navFrames = await chrome.webNavigation.getAllFrames({ tabId });
      frameMeta = (navFrames || []).map(f => ({ id: f.frameId, url: f.url, parentId: f.parentFrameId }));
    } catch (_) {}

    return {
      title: main?.result?.title || '',
      url: main?.result?.url || '',
      text,
      accessibilityTree,
      frameCount: frameProbe.length,
      frameMeta,
      treeFrameCount: (treeResults || []).filter(r => r.result?.tree?.length > 0).length
    };
  } catch (_) {
    return null;
  }
}

async function getCheckboxStateSummary(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      injectImmediately: true,
      world: 'ISOLATED',
      func: () => {
        const items = [];
        const inputs = document.querySelectorAll('input[type="checkbox"], [role="checkbox"]');
        for (const el of inputs) {
          const s = window.getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden') continue;
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) continue;
          const label = (el.getAttribute('aria-label')
            || el.closest('label')?.innerText
            || el.parentElement?.innerText
            || '').replace(/\s+/g, ' ').trim().slice(0, 100);
          if (!label) continue;
          const checked = el.checked || el.getAttribute('aria-checked') === 'true';
          items.push({ label, checked });
        }
        return items;
      }
    });
    const all = (results || []).flatMap(r => r.result || []);
    const seen = new Set();
    return all.filter(item => {
      const key = item.label.slice(0, 60);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } catch {
    return [];
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
  } catch {
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

// Observe: scroll quiz into view → read_page tree + enriched text.
// skipAutoScroll: after an explicit scroll action, don't yank the page back to the quiz.
async function observePage(tabId, resumeClickStreak = 0, autoDismissAttempted = false, skipAutoScroll = false) {
  if (!skipAutoScroll) await scrollQuizIntoView(tabId);
  const data = await getPageContent(tabId);
  if (!data) return null;

  const PT = window.PageTools;
  data.checkboxSummary = await getCheckboxStateSummary(tabId);
  data.quizInfo = detectQuizPage(data);
  data.resumeDialog = detectResumeDialog(data);

  if (data.resumeDialog.open && !autoDismissAttempted) {
    const dismiss = await tryDismissResumeDialog(tabId, resumeClickStreak);
    if (dismiss.dismissed) {
      const refreshed = await observePage(tabId, resumeClickStreak, true, skipAutoScroll);
      if (refreshed) refreshed.autoDismissed = dismiss.label;
      return refreshed;
    }
  }

  if (PT?.getEnrichedPageText && (data.quizInfo.isQuiz || data.resumeDialog.open || needsEnrichedRead(data))) {
    data.enrichedText = await PT.getEnrichedPageText(tabId, FOCUS_TEXT_CHARS + 2000);
  }

  if (PT?.mapCheckboxRefs) {
    const registry = tabRefRegistry.get(tabId);
    data.checkboxRefs = await PT.mapCheckboxRefs(tabId, registry);
  }

  // Canvas-rendered course (Storyline/Captivate): tree+text stay weak even after
  // enrichment — capture a CDP screenshot so a vision-capable model can still see it.
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
  } catch (_) {}
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

async function refreshElementMaps(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    injectImmediately: true,
    world: 'ISOLATED',
    func: () => {
      if (typeof window.__generateAccessibilityTree === 'function') {
        window.__generateAccessibilityTree('all');
      }
    }
  });
}

async function syncRefRegistry(tabId) {
  await refreshElementMaps(tabId);
  await delay(200);
  const treeResults = await readAccessibilityTrees(tabId);
  const { registry } = mergeTreeResults(treeResults);
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
    if (!lab || /^question\s*[\(:]/i.test(lab) || /single choice question/i.test(lab)) continue;
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
        if (/^question\s*[\(:]/i.test(lower) || /single choice question/i.test(lower)) continue;
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

  let resolved = await resolveClickTarget(tabId, refId, hintText);
  if (!resolved.coords && !options.registrySynced) {
    await syncRefRegistry(tabId);
    resolved = await resolveClickTarget(tabId, refId, hintText);
  }

  const { coords, frameId, localRef, dialogLabel } = resolved;
  const useCdp = forceCdp || preferCdp || !!dialogLabel;

  if (!useCdp && BT.clickRef) {
    const domResult = await BT.clickRef(tabId, frameId, localRef);
    if (domResult.success) {
      await delay(350);
      return {
        success: true,
        label: domResult.label,
        detail: domResult.isCheckable ? (domResult.checked ? 'checked' : 'unchecked') : 'DOM click',
        method: 'dom'
      };
    }
  }

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
  } catch (_) {}
}

// ── handleSend: one unified loop — the model decides chat vs tools ──
async function handleSend() {
  const promptText = promptInput.value.trim();
  if (!promptText || !getActiveKey() || isProcessing) return;

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
  const quiz = pageData?.quizInfo || detectQuizPage(pageData);

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

function deepSeekViaBackground(key, body) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'BAT_DEEPSEEK_API', key, body }, (res) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || 'Extension messaging failed'));
        return;
      }
      if (!res) {
        reject(new Error('No response from background worker — reload the extension'));
        return;
      }
      resolve(res);
    });
  });
}

async function deepSeekDirectFetch(key, body, timeoutMs = API_TIMEOUT_MS) {
  const controller = new AbortController();
  const onAgentAbort = () => controller.abort();
  if (apiAbortController?.signal) {
    if (apiAbortController.signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    apiAbortController.signal.addEventListener('abort', onAgentAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(DEEPSEEK_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + key
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const raw = await resp.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = { error: { message: raw.slice(0, 200) } };
    }

    return { ok: resp.ok, status: resp.status, data, via: 'sidebar' };
  } catch (err) {
    if (err?.name === 'AbortError' && stopRequested) throw err;
    const msg = err?.name === 'AbortError'
      ? `Request timed out after ${timeoutMs / 1000}s`
      : (err?.message || 'Failed to fetch');
    return { ok: false, status: 0, error: msg, data: null, via: 'sidebar' };
  } finally {
    clearTimeout(timer);
    if (apiAbortController?.signal) {
      apiAbortController.signal.removeEventListener('abort', onAgentAbort);
    }
  }
}

// Streaming (SSE) fetch — shows tokens as they arrive; accumulates tool-call deltas.
async function deepSeekStreamFetch(key, body, timeoutMs = API_TIMEOUT_MS, onDelta) {
  const controller = new AbortController();
  const onAgentAbort = () => controller.abort();
  if (apiAbortController?.signal) {
    if (apiAbortController.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    apiAbortController.signal.addEventListener('abort', onAgentAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(DEEPSEEK_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + key
      },
      body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
      signal: controller.signal
    });

    if (!resp.ok) {
      const raw = await resp.text();
      let data = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch { data = { error: { message: raw.slice(0, 200) } }; }
      return { ok: false, status: resp.status, data, via: 'sidebar-stream' };
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let content = '';
    let reasoning = '';
    const toolAcc = [];
    let finishReason = null;
    let usage = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') continue;
        let chunk;
        try { chunk = JSON.parse(payload); } catch { continue; }
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const d = choice.delta || {};
        if (d.content) {
          content += d.content;
          onDelta?.(content, 'content');
        }
        if (d.reasoning_content) {
          reasoning += d.reasoning_content;
          if (!content) onDelta?.(reasoning, 'reasoning');
        }
        if (Array.isArray(d.tool_calls)) {
          for (const tc of d.tool_calls) {
            const i = tc.index ?? 0;
            if (!toolAcc[i]) toolAcc[i] = { id: tc.id || 'call_' + i, type: 'function', function: { name: '', arguments: '' } };
            if (tc.id) toolAcc[i].id = tc.id;
            if (tc.function?.name) toolAcc[i].function.name += tc.function.name;
            if (tc.function?.arguments) toolAcc[i].function.arguments += tc.function.arguments;
          }
        }
      }
    }

    const message = { role: 'assistant', content, reasoning_content: reasoning };
    const toolCalls = toolAcc.filter(Boolean);
    if (toolCalls.length) message.tool_calls = toolCalls;
    return {
      ok: true,
      status: 200,
      data: { choices: [{ message, finish_reason: finishReason }], usage },
      via: 'sidebar-stream'
    };
  } catch (err) {
    if (err?.name === 'AbortError' && stopRequested) throw err;
    const msg = err?.name === 'AbortError'
      ? `Request timed out after ${timeoutMs / 1000}s`
      : (err?.message || 'Failed to fetch');
    return { ok: false, status: 0, error: msg, data: null, via: 'sidebar-stream' };
  } finally {
    clearTimeout(timer);
    if (apiAbortController?.signal) {
      apiAbortController.signal.removeEventListener('abort', onAgentAbort);
    }
  }
}

const API_RETRY_STATUSES = new Set([0, 429, 502, 503, 504]);
const API_MAX_RETRIES = 3;

async function fetchDeepSeekWithTransport(key, body, step, onDelta) {
  // 1. streaming direct fetch → 2. plain direct fetch → 3. background worker
  let res = await deepSeekStreamFetch(key, body, API_TIMEOUT_MS, onDelta);
  const streamRejected = !res.ok && res.status === 400
    && /stream/i.test(res.data?.error?.message || res.error || '');
  if (!res.ok && (res.status === 0 || streamRejected)) {
    debugEntry('api_fallback', { step, reason: res.error || res.data?.error?.message, from: res.via });
    res = await deepSeekDirectFetch(key, body);
  }
  if (!res.ok && res.status === 0) {
    debugEntry('api_fallback', { step, reason: res.error, from: res.via });
    try {
      res = await deepSeekViaBackground(key, body);
    } catch (err) {
      return { ok: false, status: 0, error: err.message || 'Failed to reach DeepSeek API', data: null, via: 'background' };
    }
  }
  return res;
}

// Strip our bookkeeping props (legacyToolResult, pruned) before sending
function sanitizeForAPI(messages) {
  return messages.map(m => {
    const out = { role: m.role, content: m.content ?? '' };
    if (m.tool_calls) out.tool_calls = m.tool_calls;
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    return out;
  });
}

async function callDeepSeekAPI(key, model, messages, opts = {}) {
  if (!key) throw new Error('No DeepSeek API key configured');
  const body = {
    model,
    messages: sanitizeForAPI(messages),
    max_tokens: opts.max_tokens ?? 8192
  };
  if (opts.tools?.length) {
    body.tools = opts.tools;
  }
  if (modelSupportsThinking(model)) {
    body.reasoning_effort = opts.reasoning_effort ?? 'high';
    body.thinking = { type: 'enabled' };
  }

  const payloadSize = JSON.stringify(body).length;
  debugEntry('api_request', {
    step: opts.step,
    model,
    messageCount: messages.length,
    payloadBytes: payloadSize,
    key: maskKey(key)
  });

  let res = null;
  for (let attempt = 0; attempt < API_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
      debugEntry('api_retry', { step: opts.step, attempt: attempt + 1, backoffMs: backoff });
      await delay(backoff);
    }
    res = await fetchDeepSeekWithTransport(key, body, opts.step, opts.onDelta);
    if (res.ok) break;
    if (!API_RETRY_STATUSES.has(res.status)) break;
  }

  if (!res.ok) {
    const d = res.data || {};
    let msg = res.status ? `DeepSeek HTTP ${res.status}` : 'DeepSeek network error';
    if (res.status === 401) msg += ' — Invalid key';
    else if (res.status === 402) msg += ' — Insufficient balance';
    else if (res.status === 429) msg += ' — Rate limit (retried)';
    else if (res.status >= 500) msg += ' — Server error (retried)';
    else if (res.error) msg += ' — ' + res.error;
    if (res.via) msg += ` (${res.via})`;
    if (API_RETRY_STATUSES.has(res.status) || res.status === 0) {
      msg += ` — failed after ${API_MAX_RETRIES} attempts`;
    }
    debugEntry('api_error', {
      step: opts.step,
      status: res.status,
      error: msg,
      via: res.via,
      apiMessage: d.error?.message || null,
      retries: API_MAX_RETRIES
    });
    const err = new Error(msg + (d.error?.message ? `: ${d.error.message}` : ''));
    err.apiStatus = res.status;
    throw err;
  }

  const data = res.data || {};
  if (data.error) {
    debugEntry('api_error', { step: opts.step, error: data.error.message });
    throw new Error('DeepSeek: ' + data.error.message);
  }

  if (data.usage) {
    usageTotals.prompt += data.usage.prompt_tokens || 0;
    usageTotals.completion += data.usage.completion_tokens || 0;
    usageTotals.requests++;
    updateDebugStatus();
  }

  const choice = data.choices?.[0]?.message || {};
  const content = (choice.content || '').trim();
  const reasoning = (choice.reasoning_content || '').trim();
  const toolCalls = Array.isArray(choice.tool_calls) ? choice.tool_calls : [];

  debugEntry('api_response', {
    step: opts.step,
    status: res.status,
    via: res.via,
    finishReason: data.choices?.[0]?.finish_reason,
    contentLen: content.length,
    reasoningLen: reasoning.length,
    toolCalls: toolCalls.map(tc => tc.function?.name),
    usage: data.usage || null,
    preview: (content || reasoning).slice(0, 500)
  });

  // Never replay reasoning_content back to the API — store content + tool_calls only.
  const finalContent = content || (toolCalls.length ? '' : reasoning);
  const message = {
    role: 'assistant',
    content: finalContent,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {})
  };
  return { content: finalContent, message };
}

// ── Event wiring (Send + Stop) ────────────────────────────────────
sendBtn.addEventListener('click', handleSend);
promptInput.addEventListener('input', updateSendEnabled);
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
if (saveSitesBtn) saveSitesBtn.addEventListener('click', saveAllowedSites);

// Stop button
if (stopBtn) {
  stopBtn.addEventListener('click', () => { requestStop('User clicked Stop'); });
}

// ── Init ──────────────────────────────────────────────────────────
(async function init() {
  await loadKeys();
  await loadAllowedSites();
  await loadModel();
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

  try { await getActiveTab(); } catch (_) {}
  promptInput.focus();
  updateSendEnabled();
})();
