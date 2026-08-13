// Guarded regex compilation for patterns that are NOT authored by this
// codebase — model/plan-authored filter rules (run_control rule.matches,
// stop_when.matches), ats_fetch's location_filter, and read_console/
// read_network's pattern/filter args. All four get compiled with
// `new RegExp` and tested against page- or API-derived strings.
//
// Why this exists: V8's regex engine has no built-in protection against
// catastrophic backtracking, and JS gives no way to interrupt a synchronous
// RegExp.test() call once it starts. A single adversarially-shaped pattern —
// the classic nested-quantifier form `(a+)+` — hangs whichever context runs
// it. Verified directly: `/(a+)+$/.test('a'.repeat(35) + '!')` did not
// return within 5 seconds. Run in the background service worker (plan.js's
// applyRules/rowsMatchStop, called from every page the runner processes),
// that is a hang of the ENTIRE extension, not just one tool call — and per
// the project's own threat model, "a model that goes wrong" (adversarially
// steered by prompt injection, or simply mistaken) is explicitly in scope,
// so treating an arbitrary model-supplied regex as trustworthy input is the
// same category of mistake `extract_rows` used to make with page markup.
//
// safe-regex (built on regexp-tree's real parser, not a text heuristic) is
// used as the gate, tuned to `limit: 25` — see test/regex-guard.test.mjs for
// why: a lower limit started rejecting this project's OWN built-in
// STOP_PATTERNS (dense but non-catastrophic — no nested quantifiers, just
// several independent ones side by side), which would have broken a real
// feature to fix a risk that pattern doesn't actually pose.
//
// KNOWN GAP, stated plainly: safe-regex catches the classic nested-quantifier
// shape, which is the large majority of real-world ReDoS reports, but not
// every catastrophic shape — alternation-based blowup (`(a|a)*`) slips past
// it (verified: still hangs for over 500ms at just 25 input characters, and
// far worse beyond that). An input-length cap does not meaningfully help
// here either — the blowup is steep enough at very short lengths that a cap
// tight enough to matter would reject ordinary inputs (e.g. real location
// strings). Closing this fully needs a hard execution timeout — running the
// match in a Worker and terminating it if it overruns — which turns every
// call site from synchronous to async; not done here. This mitigates the
// common case and makes the attempt fail with a clear message instead of a
// silent hang; it does not prove every pattern is safe.
import safe from 'safe-regex';

const MAX_PATTERN_CHARS = 500;
const SAFE_REGEX_LIMIT = 25;

/**
 * @param {string} pattern
 * @param {string} [flags]
 * @returns {{ok: true, re: RegExp} | {ok: false, reason: string}}
 */
export function compileGuardedRegex(pattern, flags = 'i') {
  const p = String(pattern ?? '');
  if (!p) return { ok: false, reason: 'empty pattern' };
  if (p.length > MAX_PATTERN_CHARS) {
    return { ok: false, reason: `pattern is ${p.length} chars (limit ${MAX_PATTERN_CHARS}) — simplify it` };
  }
  let isSafe;
  try {
    isSafe = safe(p, { limit: SAFE_REGEX_LIMIT });
  } catch {
    // A broken analysis must fail CLOSED (reject), same reasoning as
    // extractor-screen.js: this is a safety gate, not a best-effort hint.
    return { ok: false, reason: 'could not analyze pattern safety — simplify it' };
  }
  if (!isSafe) {
    return {
      ok: false,
      reason: 'pattern has nested repetition that could hang on certain input (catastrophic backtracking) — use a simpler pattern'
    };
  }
  try {
    return { ok: true, re: new RegExp(p, flags) };
  } catch (e) {
    return { ok: false, reason: `invalid regex: ${e.message}` };
  }
}
