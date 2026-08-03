export const DEEPSEEK_API = 'https://api.deepseek.com/chat/completions';
export const DEFAULT_MODEL = 'deepseek-v4-pro';

// Set your key through the side panel UI. Leave this empty — never commit a real key.
// Get one at https://platform.deepseek.com/api_keys
export const DEEPSEEK_DEFAULT_KEY = '';

export const MODEL_OPTIONS = [
  { id: 'deepseek-v4-pro', label: 'V4 Pro' },
  { id: 'deepseek-v4-flash', label: 'V4 Flash' },
  { id: 'deepseek-chat', label: 'V3' }
];

export const MAX_STUCK = 20;
// A page that fails to read at all (executeScript errors, a Chrome error
// interstitial) is a stronger, faster dead-end signal than an unchanged tree
// — the latter can legitimately repeat during a slow multi-step form flow,
// the former means there is no page there to act on. Lower than MAX_STUCK on
// purpose: this used to have no ceiling at all, and a single bad URL could
// burn a run's entire token budget in a blind retry loop before anything
// stopped it.
export const MAX_UNREADABLE = 12;
export const MAX_STEPS = 1000;

// DeepSeek's chat API does not accept image input — the whole screenshot path
// (CDP capture, base64 in session, screenshot tool) stays off until this flips.
export const VISION_SUPPORTED = false;

// Hard ceiling for one interactive conversation turn-loop, warning at 80%.
// Measured in BILLABLE tokens (non-cached prompt + completion), not raw
// prompt+completion — see onUsage in sidepanel/app.js. DeepSeek resends the
// whole growing conversation every step and reports the same repeated prefix
// as prompt_tokens whether or not it was a cache hit (billed at roughly
// 1/10th–1/100th the cache-miss rate), so a raw-token ceiling would measure
// "how long this conversation has gotten" more than real cost, and
// increasingly penalize exactly the long, many-step bulk-collection runs
// this project exists for as the cached prefix grows.
export const RUN_TOKEN_BUDGET = 4000000;

// Separate pool for a background collection run: its only model spend is
// extractor synthesis, so this bounds "how many sites may I learn" rather than
// "how long may I converse".
export const RUNNER_TOKEN_BUDGET = 2000000;

// Extractor synthesis is the strong-model case; routine work is not.
export const SYNTHESIS_MODEL = 'deepseek-v4-pro';
export const FOCUS_TREE_CHARS = 14000;
export const FOCUS_QUIZ_TREE_CHARS = 12000;
export const FOCUS_TEXT_CHARS = 5000;
export const API_TIMEOUT_MS = 180000;
export const RESUME_DIALOG_WAIT_MS = 4000;

export const SUBMIT_CLICK_RE = /\b(check|submit|next|continue|finish|confirm)\b/i;
export const QUIZ_FAIL_RE = /\b(incorrect|not correct|wrong answer|try again|please try again|that is not|you must select|not quite|failed the|unsuccessful)\b/i;
export const QUIZ_PASS_RE = /\b(correct|well done|that'?s right|that is correct|you may continue|click next to continue|passed this|great job|nice work)\b/i;
export const RESUME_DIALOG_RE = /\b(resume|restart)\b.*\b(where you left|previous session|continue where|pick up|left off)\b|\bwould you like to resume\b|\bresume\s*[–\-–]\s*restart\b/i;

export const ACTIVITY_PHASES = {
  info:    { title: 'Info' },
  observe: { title: 'Observing page' },
  think:   { title: 'Thinking' },
  plan:    { title: 'Plan' },
  act:     { title: 'Executing' },
  result:  { title: 'Result' },
  warn:    { title: 'Warning' },
  error:   { title: 'Error' },
  done:    { title: 'Done' }
};
