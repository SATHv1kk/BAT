// Redaction policy — the one piece of behaviour where a bug leaks a password or
// card number into a model request, so it gets its own test module.
// The content script (src/content/accessibility-tree.js) carries a literal
// mirror of this policy; these tests are the mirror's only coverage.
//
// Contract: default-export a run(t) taking the runner's assertion helper.

import { readFileSync } from 'node:fs';
import {
  SENSITIVE_AUTOCOMPLETE,
  REDACTED,
  isSensitiveField,
  redactMarkup
} from '../src/lib/redaction.js';

export default function run(t) {
  // --- the mirror must not drift ------------------------------------------
  // The content script cannot import this module, so it carries a copy. Drift
  // there is silent and leaks values, so assert the copy still spells out the
  // whole policy verbatim.
  let contentScript = '';
  try {
    contentScript = readFileSync(new URL('../src/content/accessibility-tree.js', import.meta.url), 'utf8');
  } catch { /* leave empty; the assertions below will fail loudly */ }
  t('content script readable', contentScript.length > 0);
  t('content script points back here', contentScript.includes('MIRROR of src/lib/redaction.js'));
  t('mirror has every token', SENSITIVE_AUTOCOMPLETE.every((tok) => contentScript.includes("'" + tok + "'")));
  t('mirror has no extra tokens', (contentScript.match(/'(?:current-password|new-password|one-time-code|cc-[a-z-]+)'/g) || []).length === SENSITIVE_AUTOCOMPLETE.length);
  t('mirror has the placeholder', contentScript.includes("'" + REDACTED + "'"));
  t('mirror keeps password/hidden check', /type === 'password' \|\| type === 'hidden'/.test(contentScript));

  // --- policy shape -------------------------------------------------------
  t('policy lists the 8 sensitive tokens', SENSITIVE_AUTOCOMPLETE.length === 8);
  t('redaction placeholder unchanged', REDACTED === '[value redacted]');

  // --- every token redacts ------------------------------------------------
  for (const token of SENSITIVE_AUTOCOMPLETE) {
    t(`autocomplete=${token} redacts`, isSensitiveField({ type: 'text', autocomplete: token }) === true);
  }

  // --- substring / prefixed tokens ---------------------------------------
  t('section-prefixed token redacts', isSensitiveField({ type: 'text', autocomplete: 'section-x current-password' }) === true);
  t('billing cc-number redacts', isSensitiveField({ autocomplete: 'section-billing shipping cc-number' }) === true);
  t('token mid-list redacts', isSensitiveField({ autocomplete: 'billing cc-csc extra' }) === true);

  // --- type-based redaction ----------------------------------------------
  t('type=password redacts', isSensitiveField({ type: 'password' }) === true);
  t('type=hidden redacts', isSensitiveField({ type: 'hidden' }) === true);
  t('password wins over benign autocomplete', isSensitiveField({ type: 'password', autocomplete: 'off' }) === true);

  // --- name/id naming the secret redacts even when type/autocomplete don't ----
  t('name=cc-number redacts', isSensitiveField({ type: 'text', name: 'cc-number' }) === true);
  t('name=cardnumber redacts', isSensitiveField({ type: 'text', name: 'cardnumber' }) === true);
  t('id=cvv redacts', isSensitiveField({ type: 'text', id: 'cvv' }) === true);
  t('name=otp redacts', isSensitiveField({ type: 'text', name: 'otp' }) === true);
  t('name=secret-answer redacts', isSensitiveField({ type: 'text', name: 'secret-answer' }) === true);
  t('name=pin redacts', isSensitiveField({ type: 'text', name: 'pin' }) === true);
  t('markup redacts name=cc-number value', !redactMarkup('<input type="text" name="cc-number" value="4111111111111111">').includes('4111111111111111'));
  t('markup redacts name=pin value', !redactMarkup('<input type="text" name="pin" value="1234">').includes('1234'));
  t('benign name does not redact', isSensitiveField({ type: 'text', name: 'username' }) === false);
  t('benign id does not redact', isSensitiveField({ type: 'text', id: 'searchbox' }) === false);

  // --- ordinary fields must NOT redact ------------------------------------
  t('type=text does not redact', isSensitiveField({ type: 'text' }) === false);
  t('autocomplete=email does not redact', isSensitiveField({ type: 'email', autocomplete: 'email' }) === false);
  t('autocomplete=name does not redact', isSensitiveField({ type: 'text', autocomplete: 'name' }) === false);
  t('autocomplete=off does not redact', isSensitiveField({ type: 'text', autocomplete: 'off' }) === false);
  t('empty autocomplete does not redact', isSensitiveField({ type: 'text', autocomplete: '' }) === false);
  t('type=checkbox does not redact', isSensitiveField({ type: 'checkbox' }) === false);
  t('lookalike token does not redact', isSensitiveField({ autocomplete: 'password-hint' }) === false);
  t('bare "password" autocomplete does not redact', isSensitiveField({ type: 'text', autocomplete: 'password' }) === false);

  // --- case insensitivity -------------------------------------------------
  t('TYPE=PASSWORD redacts', isSensitiveField({ type: 'PASSWORD' }) === true);
  t('mixed-case type=Hidden redacts', isSensitiveField({ type: 'Hidden' }) === true);
  t('uppercase autocomplete redacts', isSensitiveField({ type: 'text', autocomplete: 'CC-NUMBER' }) === true);
  t('mixed-case token redacts', isSensitiveField({ autocomplete: 'One-Time-Code' }) === true);

  // --- hostile / missing input must not throw ------------------------------
  const safe = (fn) => { try { return { ok: true, value: fn() }; } catch { return { ok: false }; } };
  t('no argument does not throw', safe(() => isSensitiveField()).ok);
  t('no argument is not sensitive', isSensitiveField() === false);
  t('null argument does not throw', safe(() => isSensitiveField(null)).ok);
  t('null argument is not sensitive', isSensitiveField(null) === false);
  t('undefined fields do not throw', safe(() => isSensitiveField({ type: undefined, autocomplete: undefined })).ok);
  t('null fields are not sensitive', isSensitiveField({ type: null, autocomplete: null }) === false);
  t('empty object is not sensitive', isSensitiveField({}) === false);
  t('non-string type does not throw', safe(() => isSensitiveField({ type: 7, autocomplete: [] })).ok);

  // --- redactMarkup: the basic guarantee ----------------------------------
  const pw = redactMarkup('<input type="password" name="p" value="hunter2">');
  t('markup drops password value', !pw.includes('hunter2'));
  t('markup marks the redaction', pw.includes('[redacted]'));
  t('markup keeps the tag and other attrs', pw.includes('<input') && pw.includes('name="p"'));

  const txt = redactMarkup('<input type="text" name="q" value="dublin">');
  t('markup keeps ordinary input value', txt.includes('value="dublin"'));
  t('markup leaves ordinary input untouched', txt === '<input type="text" name="q" value="dublin">');

  t('markup redacts hidden input', !redactMarkup('<input type="hidden" value="csrf-token-abc">').includes('csrf-token-abc'));
  t('markup redacts by autocomplete', !redactMarkup('<input type="text" autocomplete="cc-number" value="4111111111111111">').includes('4111111111111111'));
  t('markup redacts one-time-code', !redactMarkup('<input type="text" autocomplete="one-time-code" value="123456">').includes('123456'));
  t('markup redacts section-prefixed autocomplete', !redactMarkup('<input autocomplete="section-b cc-csc" value="999">').includes('999'));

  const mixed = redactMarkup('<form><input type="text" value="alice"><input type="password" value="s3cr3t"></form>');
  t('markup redacts only the sensitive input', mixed.includes('value="alice"') && !mixed.includes('s3cr3t'));
  t('markup preserves surrounding structure', mixed.startsWith('<form>') && mixed.endsWith('</form>'));

  // --- redactMarkup: attribute-syntax variants ----------------------------
  t('single-quoted value redacted', !redactMarkup("<input type='password' value='s3cret'>").includes('s3cret'));
  t('single-quoted type detected', redactMarkup("<input type='password' value='s3cret'>").includes('[redacted]'));
  t('unquoted value redacted', !redactMarkup('<input type=password value=s3cret>').includes('s3cret'));
  t('unquoted autocomplete detected', !redactMarkup('<input autocomplete=cc-number value=4111>').includes('4111'));
  t('uppercase tag/attrs redacted', !redactMarkup('<INPUT TYPE="PASSWORD" VALUE="s3cret">').includes('s3cret'));
  t('spaces around equals redacted', !redactMarkup('<input type = "password" value = "s3cret">').includes('s3cret'));
  t('mirrored data-value redacted on sensitive input', !redactMarkup('<input type="password" data-value="s3cret" value="s3cret">').includes('s3cret'));
  t('data-type is not read as type', redactMarkup('<input data-type="password" value="keep">').includes('value="keep"'));

  // --- redactMarkup: malformed input must not throw or leak ---------------
  t('unclosed tag redacted', !redactMarkup('<input type="password" value="s3cret"').includes('s3cret'));
  t('unterminated quote does not throw', safe(() => redactMarkup('<input type="password" value="s3cret')).ok);
  t('unterminated quote redacted', !redactMarkup('<input type="password" value="s3cret').includes('s3cret'));
  t('garbage tag soup does not throw', safe(() => redactMarkup('<input <<>> type=password value=x <<')).ok);
  t('empty string returns empty string', redactMarkup('') === '');
  t('null input does not throw', safe(() => redactMarkup(null)).ok);
  t('undefined input does not throw', safe(() => redactMarkup(undefined)).ok);
  t('non-string input yields empty string', redactMarkup(null) === '' && redactMarkup(42) === '');
  t('markup without inputs is unchanged', redactMarkup('<p>hello value="x"</p>') === '<p>hello value="x"</p>');
  t('bare <input redacts nothing but survives', safe(() => redactMarkup('<input')).ok);

  // --- redactMarkup: <textarea> text-content values ------------------------
  // A textarea's value lives between its tags, invisible to the input pass. A
  // sensitive one (autocomplete=one-time-code etc.) would leak the whole body
  // to the model. Each case below is a regression: the value must not survive.
  t('sensitive textarea body is redacted', !redactMarkup('<textarea autocomplete="one-time-code">123456</textarea>').includes('123456'));
  t('sensitive textarea keeps its tag and attrs', redactMarkup('<textarea autocomplete="one-time-code">123456</textarea>').includes('autocomplete="one-time-code"'));
  t('sensitive textarea body is marked', redactMarkup('<textarea autocomplete="one-time-code">123456</textarea>').includes('[redacted]'));
  t('sensitive multiline textarea is redacted', !redactMarkup('<textarea autocomplete="one-time-code">line1\nline2\n</textarea>').includes('line1'));
  t('plain textarea is untouched', redactMarkup('<textarea>hello world</textarea>') === '<textarea>hello world</textarea>');
  t('password-class textarea redacts', !redactMarkup('<textarea class="x">keep-me-out</textarea>')?.length === false && redactMarkup('<textarea autocomplete="new-password">keep-me-out</textarea>').includes('keep-me-out') === false);
  t('mixed input+textarea markup redacts both', !redactMarkup('<input type="password" value="v1"><textarea autocomplete="one-time-code">v2</textarea>').includes('v1') && !redactMarkup('<input type="password" value="v1"><textarea autocomplete="one-time-code">v2</textarea>').includes('v2'));
  // A sensitive textarea whose CONTENT contains "</" must not leak after it.
  t('textarea body containing </ is fully redacted', !redactMarkup('<textarea autocomplete="one-time-code">secret</code> more</textarea>').includes('secret'));
  t('textarea body containing </ keeps its closing tag', redactMarkup('<textarea autocomplete="one-time-code">a</b></textarea>').includes('</textarea>'));
  // Unterminated textarea at end of input must still be redacted (truncated doc).
  t('unterminated sensitive textarea is redacted', !redactMarkup('<textarea autocomplete="one-time-code">OTP-12345').includes('OTP-12345'));
}
