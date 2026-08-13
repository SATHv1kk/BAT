// Single source of truth for the sensitive-value redaction policy.
//
// Everything the agent reads from a page can end up in a model request, so any
// path that serialises page state has to run values past this policy first.
// Pure and DOM-free so the policy itself is unit-testable in plain Node
// (test/redaction.test.mjs) instead of only being exercisable in a live tab.
//
// src/content/accessibility-tree.js carries an inline MIRROR of
// SENSITIVE_AUTOCOMPLETE / REDACTED / isSensitiveField — keep in sync; the
// mirror is duplicated only because a classic content script cannot import an
// ES module, and test/redaction.test.mjs asserts the two have not drifted.

// Autocomplete tokens that mark a field whose value must never leave the page.
// Note `cc-exp` already subsumes `cc-exp-month`/`cc-exp-year` under substring
// matching; they are listed anyway so the policy reads as the full set it means.
export const SENSITIVE_AUTOCOMPLETE = [
  'current-password',
  'new-password',
  'one-time-code',
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year'
];

// What the accessibility tree prints in place of a sensitive value. The model
// still learns the field is filled — just not with what.
export const REDACTED = '[value redacted]';

// Placeholder substituted into serialised markup (see redactMarkup).
const REDACTED_ATTR = '[redacted]';

/**
 * Is this field one whose value must never be serialised?
 *
 * Substring (not equality) matching on autocomplete: real forms ship
 * space-separated and section-prefixed tokens, e.g.
 * autocomplete="section-billing cc-number".
 *
 * @param {{type?: string, autocomplete?: string}} [field]
 * @returns {boolean}
 */
export function isSensitiveField(field) {
  const { type, autocomplete, name, id } = field || {};
  const t = String(type ?? '').toLowerCase();
  // type=hidden counts: hidden inputs are where CSRF tokens and session values
  // live, and they are invisible to the user who would otherwise notice.
  if (t === 'password' || t === 'hidden') return true;
  const ac = String(autocomplete ?? '').toLowerCase();
  if (SENSITIVE_AUTOCOMPLETE.some((token) => ac.includes(token))) return true;
  // A name/id that names the secret is as damning as an autocomplete token — a
  // <input type="text" name="cc-number"> holds a card number even though its
  // type/autocomplete are both innocuous. Mirrors the accessibility-tree copy.
  const hay = String(name ?? '') + ' ' + String(id ?? '');
  return /(?:cc|card|cardnumber|cvv|cvc|expiry|exp-month|exp_year|otp|one.?time|passwd|passphrase|secret|token|pin)\b/i.test(hay);
}

// Matches one <input ...> tag. The `|$` alternative also catches an unterminated
// tag at end of input, so a truncated document cannot smuggle a value through.
const INPUT_TAG_RE = /<input\b(?:[^>"']*(?:"[^"]*"|'[^']*'))*[^>]*(?:>|$)/gi;

// Matches a <textarea ...> tag INCLUDING its text content, because a textarea's
// value lives between the tags, not in an attribute. The opener itself is
// matched like INPUT_TAG_RE; then the content up to `</textarea>` (the case
// where a `</textarea>` exists). `[^]*` matches across newlines, unlike `.`.
// The `|$` alternative catches an UNTERMINATED textarea at end of input — a
// truncated document with a sensitive textarea would otherwise never match and
// the whole secret passes through unredacted (the input pass has this same
// guard; the textarea pass must too).
const TEXTAREA_TAG_RE = /<textarea\b(?:[^>"']*(?:"[^"]*"|'[^']*'))*[^>]*>[^]*?(?:<\/textarea>|$)/gi;

// What to replace sensitive textarea content with. The tag and its attributes
// are preserved (including autocomplete, so the model still learns the field is
// sensitive); only the value between the tags is removed.
const REDACTED_TEXTAREA_BODY = '\n' + REDACTED_ATTR + '\n';

// Attribute readers. Handle double-quoted, single-quoted and bare values, and
// tolerate a missing closing quote (`"?`) in malformed markup. The leading
// (^|[\s"'/]) guard stops `data-type=` from being read as `type=`.
const TYPE_ATTR_RE = /(?:^|[\s"'/])type\s*=\s*(?:"([^"]*)"?|'([^']*)'?|([^\s>]*))/i;
const AUTOCOMPLETE_ATTR_RE = /(?:^|[\s"'/])autocomplete\s*=\s*(?:"([^"]*)"?|'([^']*)'?|([^\s>]*))/i;
const NAME_ATTR_RE = /(?:^|[\s"'/])name\s*=\s*(?:"([^"]*)"?|'([^']*)'?|([^\s>]*))/i;
const ID_ATTR_RE = /(?:^|[\s"'/])id\s*=\s*(?:"([^"]*)"?|'([^']*)'?|([^\s>]*))/i;
// Deliberately wider than the readers above: this one only ever runs on a tag
// already judged sensitive, so `data-value=` / `x:value=` mirrors of the secret
// (common in framework-hydrated markup) are caught too. `aria-valuenow=` and
// friends are not, since `value` must be followed directly by `=`.
const VALUE_ATTR_RE = /(^|[\s"'/:-])value\s*=\s*(?:"[^"]*"?|'[^']*'?|[^\s>]*)/gi;

function readAttr(tag, re) {
  const m = re.exec(tag);
  if (!m) return '';
  return m[1] ?? m[2] ?? m[3] ?? '';
}

/**
 * Strip sensitive input values out of serialised HTML before it is uploaded to
 * a model. Regex-based rather than DOM-based because the service worker has no
 * DOM, and because it must stay safe on markup that never parsed cleanly.
 *
 * Pure string -> string. Never throws: on anything unexpected it fails CLOSED
 * (returns '') rather than passing the original markup through, since the whole
 * point of the call is that the result is about to be sent off-device.
 *
 * @param {string} html
 * @returns {string}
 */
export function redactMarkup(html) {
  if (typeof html !== 'string') return '';
  if (html === '') return '';
  try {
    const inputOut = html.replace(INPUT_TAG_RE, (tag) => {
      const field = { type: readAttr(tag, TYPE_ATTR_RE), autocomplete: readAttr(tag, AUTOCOMPLETE_ATTR_RE), name: readAttr(tag, NAME_ATTR_RE), id: readAttr(tag, ID_ATTR_RE) };
      if (!isSensitiveField(field)) return tag;
      // Keep the attribute so the markup still parses to the same shape; only
      // the secret goes.
      return tag.replace(VALUE_ATTR_RE, (m, lead) => lead + 'value="' + REDACTED_ATTR + '"');
    });
    // Textareas carry their value as TEXT CONTENT, which the input pass above
    // cannot see. A sensitive textarea (autocomplete="one-time-code" etc.) would
    // otherwise leak the whole secret between its tags — the exact thing this
    // module exists to prevent. Replace the body with a marker, keeping the tag.
    return inputOut.replace(TEXTAREA_TAG_RE, (tag) => {
      const field = { autocomplete: readAttr(tag, AUTOCOMPLETE_ATTR_RE), type: readAttr(tag, TYPE_ATTR_RE), name: readAttr(tag, NAME_ATTR_RE), id: readAttr(tag, ID_ATTR_RE) };
      if (!isSensitiveField(field)) return tag;
      // Split at the FIRST '>' (the end of the opener tag); everything after it
      // is body. The old replacement was `/>[^]*?<\//` — non-greedy, so a
      // sensitive textarea whose content contained `</` anywhere (legal text,
      // e.g. "secret</code>") leaked everything after the first `</`.
      const gt = tag.indexOf('>');
      if (gt === -1) return tag;
      const opener = tag.slice(0, gt + 1);
      const closer = /<\/textarea\s*>$/i.test(tag) ? '</textarea>' : '';
      return opener + REDACTED_TEXTAREA_BODY + closer;
    });
  } catch {
    return '';
  }
}
