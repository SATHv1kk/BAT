export const DEEPSEEK_API = 'https://api.deepseek.com/chat/completions';

// Set your key through the side panel UI. Leave this empty — never commit a real key.
// Get one at https://platform.deepseek.com/api_keys
export const DEEPSEEK_DEFAULT_KEY = '';

// BAT runs on exactly ONE model. Not a default that a picker overrides — the
// only id the extension will ever send.
//
// This replaced a model dropdown, and the dropdown was a genuine source of
// breakage rather than a feature: its <option> list was hardcoded in
// index.html, so it drifted out of sync with the ids the code believed were
// valid (it went on offering the retired `deepseek-chat` as "V3" after that id
// had been removed from the source list), and the save path never validated the
// chosen id at all — so one click could pin an install to a model the API
// refuses to serve, on every request, until someone thought to look at the
// dropdown. One constant cannot drift from itself.
export const MODEL = 'deepseek-v4-flash';

// reasoning_effort accepts exactly low | high | max. `medium` and `xhigh` are
// only tolerated as compatibility aliases that the API silently rewrites to
// `high`, so sending them buys nothing and misreports intent — the routine-step
// path used to send `medium` believing it was a middle tier between low and
// high, when it was in fact the same as asking for high on every single step.
export const REASONING_EFFORTS = ['low', 'high', 'max'];

// MODEL supports thinking mode, and it is ON by default server-side. That
// default is load-bearing for the reasoning_content contract — see
// THINKING_STAGES. (There is no per-model capability table any more: with one
// id there is nothing to look up.)
//
// THE contract that broke this extension, stated once so no call site has to
// rediscover it:
//
//   "for requests carrying the `tools` parameter, the `reasoning_content` must
//    be fully passed back to the API in all subsequent requests. If your code
//    does not correctly pass back `reasoning_content`, the API will return a
//    400 error."
//
// BAT sends `tools` on every interactive request, so EVERY assistant turn that
// made a tool call must carry its verbatim reasoning_content on the next call.
// It must never be truncated (the requirement is "fully"), only dropped whole
// alongside the message it belongs to.
//
// The old degradation ladder could not recover from a rejected reasoning field:
// it stopped SENDING `thinking`/`reasoning_effort`, but thinking is enabled by
// default server-side, so the model kept emitting reasoning_content that the
// request kept omitting — a permanent 400 loop. Turning thinking off requires
// saying so explicitly. Hence an ordered ladder, advanced one rung per
// reasoning-related 400, ending in a configuration that cannot 400 on these
// fields at all:
//   0 enabled+effort → 1 enabled → 2 disabled (no reasoning_content at all) → 3 omit
export const THINKING_STAGES = ['enabled+effort', 'enabled', 'disabled', 'omit'];

export const MAX_STUCK = 10;
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

// Extractor synthesis used to be routed to a deliberately stronger tier
// (`deepseek-v4-pro`) on the reasoning that writing a DOM extractor from raw
// markup is the hardest thing the project asks of a model, while routine page
// stepping is not. There is only one model now, so that split is gone and
// synthesis runs on MODEL like everything else.
//
// This is the one real capability trade-off in going single-model: a weaker
// extractor is not a silent loss, because every replay is validated (schema
// fingerprint, required fields, row-count collapse) and a failing extractor is
// retired — so the cost shows up as more synthesis attempts and possibly a
// HALTED site, not as quietly wrong rows. If extractor quality regresses on
// hard sites, this is the first thing to reconsider.
export const SYNTHESIS_MODEL = MODEL;
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
