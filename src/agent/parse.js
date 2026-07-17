/** Parse model JSON action responses into normalized action objects. */

export function parseAgentResponse(raw) {
  try {
    let s = raw.trim();
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a !== -1 && b > a) s = s.slice(a, b + 1);
    s = s.replace(/^```(?:json)?\s*/im, '').replace(/\s*```\s*$/m, '').trim();
    s = s.replace(/,(\s*[}\]])/g, '$1');
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed.actions) && !parsed.action) {
      return { action: 'batch', actions: parsed.actions, text: parsed.text || '' };
    }
    return parsed;
  } catch {
    return { action: 'wait', text: raw };
  }
}

export function normalizeAction(parsed) {
  let action = (parsed.action || parsed.type || '').toLowerCase().replace(/-/g, '_');
  const ref = parsed.ref || parsed.targetRef || null;
  const text = parsed.text || parsed.description || '';
  const value = parsed.value || parsed.text_to_type || parsed.input || '';
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
  if (action === 'find' && (value || text)) return { action: 'find', ref, text, value: value || text, key, url };
  if (action === 'javascript' && (value || text)) return { action: 'javascript', ref, text, value: value || text, key, url };
  if (action === 'form_input' && ref) return { action: 'form_input', ref, text, value, key, url };
  if (action === 'type' && ref) {
    const val = value || text;
    if (val) return { action: 'type', ref, text, value: val, key, url };
  }
  if (action === 'left_click' && ref) return { action: 'left_click', ref, text, value, key, url };
  if (parsed.type === 'action' && ref) return { action: 'left_click', ref, text, value, key, url };
  if (ref) return { action: 'left_click', ref, text, value, key, url };
  return { action: 'wait', ref: null, text, value, key, url };
}