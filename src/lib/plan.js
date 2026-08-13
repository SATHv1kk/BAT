// Pure plan/runner helpers — shared by the service-worker runner and the
// panel's run_control tool, and testable in plain Node.

import { compileGuardedRegex } from './regex-guard.js';

export function fillTemplate(template, vars = {}, page = null) {
  let url = String(template || '');
  for (const [k, v] of Object.entries(vars || {})) {
    url = url.split('{' + k + '}').join(encodeURIComponent(String(v)));
  }
  if (page != null) url = url.split('{page}').join(String(page));
  return url;
}

// Filtering/flagging is plan configuration, not extractor logic.
export function applyRules(rows, rules = []) {
  if (!rules?.length) return rows;
  // Compile (and safety-check, see regex-guard.js) once per rule, not once
  // per row × rule — rules.matches is model-authored, so every compile now
  // also runs a real safety analysis, and rows can number in the thousands.
  const compiled = rules.map((rule) => ({ rule, ...compileGuardedRegex(rule.matches) }));
  const kept = [];
  for (const row of rows) {
    let excluded = false;
    let out = row;
    for (const { rule, ok, re } of compiled) {
      if (!ok) continue; // invalid or unsafe pattern — same soft-skip as before
      if (!re.test(String(out[rule.field] ?? ''))) continue;
      if (rule.action === 'exclude') { excluded = true; break; }
      if (rule.action === 'flag') out = { ...out, ...(rule.set || { Flag: '*' }) };
    }
    if (!excluded) kept.push(out);
  }
  return kept;
}

// Per-unit content stop condition ("postings older than a week") — checked on
// the RAW rows so an excluded row still terminates the unit.
export function rowsMatchStop(rows, stopWhen) {
  if (!stopWhen?.field || !stopWhen?.matches) return false;
  const { ok, re } = compileGuardedRegex(stopWhen.matches);
  if (!ok) return false;
  return rows.some((r) => re.test(String(r[stopWhen.field] ?? '')));
}

// Plan-level rules ALWAYS apply; unit rules add to them. (Overriding meant a
// unit with its own rules silently lost the global exclusions.)
// Ready-made stop_when patterns for relative "Posted" strings. A model
// improvising these gets the boundaries wrong (matching "1 day ago" or missing
// "30+ days ago"), and the cost of a wrong stop rule is a truncated or runaway
// collection. Deliberately inclusive at the boundary — exactly one week does
// NOT stop the unit, so ambiguity collects more rather than less.
export const STOP_PATTERNS = {
  // Older than one week: 8+ days, 2+ weeks, any months/years, "30+ days".
  older_than_1_week:
    '\\b(?:[89]|[1-9]\\d+)\\+?\\s*days?\\s+ago\\b|\\b(?:[2-9]|[1-9]\\d+)\\s*weeks?\\s+ago\\b|\\b\\d*\\s*months?\\s+ago\\b|\\byears?\\s+ago\\b|\\b30\\+\\s*days?\\b|\\blast month\\b',
  older_than_1_month:
    '\\b(?:3[1-9]|[4-9]\\d|\\d{3,})\\+?\\s*days?\\s+ago\\b|\\b(?:[5-9]|[1-9]\\d+)\\s*weeks?\\s+ago\\b|\\b(?:[2-9]|[1-9]\\d+)\\s*months?\\s+ago\\b|\\byears?\\s+ago\\b'
};

export function mergeRules(planRules, unitRules) {
  return [...(planRules || []), ...(unitRules || [])];
}

const FAILURE_OUTCOMES = new Set(['error', 'invalid', 'synth_failed', 'stalled', 'blocked_site', 'halted']);
// Outcomes that end the unit regardless of the page budget.
const TERMINAL_OUTCOMES = new Set(['empty', 'halted', 'blocked_site']);

// The runner's state-machine transition, as a pure function so it can be
// tested without a browser. Returns the next position and why the unit ended.
//   pos: { page, pageCount }, unit: { pages:{start,step,max} }
export function decideUnitProgress({ outcome, stopHit, pos, unit, failStreak, failLimit = 3 }) {
  const isFailure = FAILURE_OUTCOMES.has(outcome);
  const nextFailStreak = isFailure ? (failStreak || 0) + 1 : 0;
  // 'invalid' retries the SAME page after re-synthesis, so it must not consume
  // the page budget or advance the cursor.
  const retrySamePage = outcome === 'invalid';
  const pageCount = retrySamePage ? (pos.pageCount || 0) : (pos.pageCount || 0) + 1;
  const maxPages = unit.pages?.max ?? 1;

  let reason = null;
  if (stopHit) reason = 'stop_condition';
  else if (TERMINAL_OUTCOMES.has(outcome)) reason = outcome;
  else if (nextFailStreak >= failLimit) reason = 'fail_limit';
  else if (pageCount >= maxPages) reason = 'page_budget';

  const unitDone = reason !== null;
  const blocked = unitDone && (reason === 'fail_limit' || reason === 'halted' || reason === 'blocked_site');
  return {
    unitDone,
    blocked,
    reason,
    failStreak: unitDone ? 0 : nextFailStreak,
    nextPage: unitDone ? null : (retrySamePage ? pos.page : pos.page + (unit.pages?.step ?? 1)),
    nextPageCount: unitDone ? 0 : pageCount
  };
}

// Ownership rule for the runner's checkpoint, as a pure function.
//
// The loop reads a run, works a page for up to ~25s, then writes back. Anything
// that changed the record in between (a pause, an external status edit) would be
// clobbered by that write — the user pressed Pause, was told "paused", and the
// run kept going. Split ownership instead:
//   • the LOOP owns progress (pos, counts, tabId, pendingExport) — that work
//     really happened and must not be lost;
//   • the CALLER owns control (status, note) — an external transition wins, and
//     the loop must stop.
//
// `latest === null` means the run was DELETED mid-page. That is the caller's
// most decisive control move of all — resurrection is never the right recovery,
// and the loop re-saving its in-memory copy used to bring a deleted run back to
// life as `running` and keep processing it. Stop, and let the caller drop the
// record for real.
export function reconcileCheckpoint(loopRun, latest) {
  if (!latest) return { record: loopRun, stop: true, externalStatus: 'deleted' };
  const externallyChanged = latest.status !== 'running' && latest.status !== loopRun.status;
  if (!externallyChanged) return { record: loopRun, stop: false, externalStatus: null };
  return {
    record: { ...loopRun, status: latest.status, note: latest.note ?? loopRun.note },
    stop: true,
    externalStatus: latest.status
  };
}

export function validatePlan(plan) {
  if (!plan || typeof plan !== 'object') return 'plan object required';
  if (!plan.filename) return 'plan.filename required';
  if (!Array.isArray(plan.dedup_fields) || !plan.dedup_fields.length) return 'plan.dedup_fields required, e.g. ["Company","Title"]';
  if (!Array.isArray(plan.units) || !plan.units.length) return 'plan.units[] required';
  for (let i = 0; i < plan.units.length; i++) {
    const u = plan.units[i];
    if (!u || typeof u !== 'object') return `units[${i}] must be an object`;
    if (!u.url_template) return `units[${i}].url_template required`;
    if (!u.id) u.id = 'unit_' + (i + 1);
  }
  return null;
}
