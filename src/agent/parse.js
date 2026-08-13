/** Parse model JSON action responses into normalized action objects. */

// Scan for complete top-level JSON blobs (object or array) in a string,
// respecting strings/escapes. Returns the LAST complete blob: a model reply
// can carry an example array before its real payload ("do [..] like this,
// then {"action":..}") — the real payload comes last, so executing the
// example would be a wrong click.
function lastJsonBlob(s) {
  let best = null;
  let sawTrailingIncomplete = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch !== '{' && ch !== '[') { i++; continue; }
    const close = ch === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let j = i;
    for (; j < s.length; j++) {
      const c = s[j];
      if (inStr) {
        if (c === '\\') { j++; continue; }
        if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === ch) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth === 0 && j > i) {
      best = s.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    // This blob never closed — it is the LAST thing the model wrote. The whole
    // reason this scans for the "real payload comes last" is that examples
    // precede the real call; if the real (last) payload is malformed, executing
    // the earlier example would be a wrong click based on intent that was
    // present but truncated. Signal "degrade to wait" instead.
    sawTrailingIncomplete = true;
    i = j + 1;
  }
  return sawTrailingIncomplete ? null : best;
}

export function parseAgentResponse(raw) {
  try {
    let s = raw.trim();
    const blob = lastJsonBlob(s);
    if (blob) s = blob;
    s = s.replace(/^```(?:json)?\s*/im, '').replace(/\s*```\s*$/m, '').trim();
    s = stripTrailingCommas(s);
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) {
      return { action: 'batch', actions: parsed, text: '' };
    }
    if (Array.isArray(parsed.actions) && !parsed.action) {
      return { action: 'batch', actions: parsed.actions, text: parsed.text || '' };
    }
    return parsed;
  } catch {
    return { action: 'wait', text: raw };
  }
}

// Remove trailing commas (`{ "a": 1, }`) that models sometimes emit. A plain
// regex replace corrupts JSON that has `,}` or `,]` INSIDE a string value —
// e.g. a model reply containing the literal text "...}", which then fails
// JSON.parse and degrades the whole action to a wait. Only strip a comma that
// actually sits outside string literals.
function stripTrailingCommas(s) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += s[i + 1] || ''; i++; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === ',') {
      // Peek ahead (skipping whitespace) for the closing brace/bracket.
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === '}' || s[j] === ']') { i = j - 1; continue; }
    }
    out += c;
  }
  return out;
}

// Action names normalizeAction understands. An entry here that fails its own
// argument check is a MALFORMED call, not an invitation to guess a click.
const KNOWN_ACTIONS = new Set([
  'left_click', 'form_input', 'type', 'key', 'find', 'javascript', 'navigate',
  'scroll_down', 'scroll_up', 'scroll_to', 'go_back', 'go_forward', 'refresh',
  'wait', 'done', 'batch'
]);

export function normalizeAction(parsed) {
  let action = (parsed.action || parsed.type || '').toLowerCase().replace(/-/g, '_');
  const ref = parsed.ref || parsed.targetRef || null;
  const text = parsed.text || parsed.description || '';
  // Falsy is meaningful here: `value: 0` (a search box needing "0") and
  // `value: ""` (explicitly clearing a field) must not be replaced by '' via
  // `||`. The old `parsed.value || parsed.text_to_type || parsed.input || ''`
  // silently turned both into "no value", so a clear-form action fell through
  // to the incomplete/wait path instead of doing its job. `explicitValue`
  // records whether the model named a value at all, so a genuine `value: ""`
  // (a clear) is distinguishable from "no value given" (an incomplete call).
  const explicitValue = hasOwn(parsed, 'value') || hasOwn(parsed, 'text_to_type') || hasOwn(parsed, 'input');
  const value = hasOwn(parsed, 'value') ? parsed.value
    : hasOwn(parsed, 'text_to_type') ? parsed.text_to_type
    : hasOwn(parsed, 'input') ? parsed.input
    : text;
  const key = parsed.key || parsed.keypress || '';
  const url = parsed.url || '';

  if (action === 'click') action = 'left_click';
  if (action === 'type_text' || action === 'fill') action = 'type';
  if (action === 'key_press' || action === 'press_key') action = 'key';
  if (action === 'scroll') action = parsed.direction === 'up' ? 'scroll_up' : 'scroll_down';
  if (action === 'form' || action === 'set_value') action = 'form_input';
  if (action === 'js' || action === 'javascript_tool' || action === 'javascript_exec') action = 'javascript';
  if (action === 'back') action = 'go_back';
  if (action === 'forward') action = 'go_forward';
  if (action === 'reload') action = 'refresh';

  if (action === 'batch' && Array.isArray(parsed.actions)) {
    const actions = parsed.actions.map(a => normalizeAction(typeof a === 'object' ? a : { action: 'wait' }));
    return { action: 'batch', ref, text, value, key, url, actions };
  }

  if (action === 'done' || text.includes('COURSE_COMPLETE')) return { action: 'done', ref, text, value, key, url };
  if (action === 'wait') return { action: 'wait', ref, text, value, key, url };
  if (action === 'scroll_down' || action === 'scroll_up') return { action, ref, text, value, key, url };
  if (action === 'scroll_to' && ref) return { action: 'scroll_to', ref, text, value, key, url };
  if (action === 'go_back' || action === 'go_forward' || action === 'refresh') return { action, ref, text, value, key, url };
  if (action === 'navigate' && url) return { action: 'navigate', ref, text, value, key, url };
  if (action === 'key' && key) return { action: 'key', ref, text, value, key, url };
  if (action === 'find' && (explicitValue ? value != null : value)) return { action: 'find', ref, text, value: value == null ? text : value, key, url };
  if (action === 'javascript' && (explicitValue ? value != null : value)) return { action: 'javascript', ref, text, value: value == null ? text : value, key, url };
  if (action === 'form_input' && ref) {
    // form_input needs a value to be meaningful — a checkbox unset / no-op
    // action would otherwise look well-formed and do nothing.
    if (value == null || (!explicitValue && value === '')) {
      return { action: 'wait', ref, text, value, key, url, incomplete: action };
    }
    return { action: 'form_input', ref, text, value, key, url };
  }
  if (action === 'type' && ref) {
    // A present-but-empty or zero value is deliberate: `value: 0` (a search
    // box needing "0") and `value: ""` (clearing a field) are real actions.
    // Only a genuinely absent value (null/undefined, or never named) is an
    // incomplete call.
    if (value == null || (!explicitValue && value === '')) {
      return { action: 'wait', ref, text, value, key, url, incomplete: action };
    }
    return { action: 'type', ref, text, value: String(value), key, url };
  }
  if (action === 'left_click' && ref) return { action: 'left_click', ref, text, value, key, url };

  // The generic "anything carrying a ref is a click" fallback is deliberately
  // kept — sloppy models emit `{type:"action", ref:"ref_5"}` and clicking is the
  // right guess there. But it must only apply to UNRECOGNIZED actions. It used to
  // catch recognized-but-incomplete ones too, so `{"action":"type","ref":"ref_1"}`
  // with no text silently CLICKED the field instead of reporting that the model
  // forgot the text — a different action than the one that was asked for.
  if (KNOWN_ACTIONS.has(action)) {
    return { action: 'wait', ref, text, value, key, url, incomplete: action };
  }
  if (parsed.type === 'action' && ref) return { action: 'left_click', ref, text, value, key, url };
  if (ref) return { action: 'left_click', ref, text, value, key, url };
  return { action: 'wait', ref: null, text, value, key, url };
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}