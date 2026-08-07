// parse.js is the legacy fallback path: it turns free-form model text into
// ACTIONS. Untested, that made it the easiest place for a malformed reply to
// become a real click. It had no coverage.
const B = new URL('../src/', import.meta.url).href;
const { parseAgentResponse, normalizeAction } = await import(B + 'agent/parse.js');

export default function run(t) {
  const norm = (s) => normalizeAction(parseAgentResponse(s));

  // ── JSON extraction ──
  t('plain json parsed', parseAgentResponse('{"action":"left_click","ref":"ref_5"}').action === 'left_click');
  t('fenced json parsed', parseAgentResponse('```json\n{"action":"wait"}\n```').action === 'wait');
  t('json after a Thought line parsed', parseAgentResponse('Thought: I will click\n{"action":"left_click","ref":"ref_2"}').ref === 'ref_2');
  t('trailing comma tolerated', parseAgentResponse('{"action":"wait",}').action === 'wait');
  t('prose around json tolerated', parseAgentResponse('sure thing {"action":"refresh"} done').action === 'refresh');
  t('unparseable text degrades to wait', parseAgentResponse('no json here').action === 'wait');
  t('degraded wait keeps the raw text', parseAgentResponse('hello there').text === 'hello there');
  t('actions array becomes a batch', parseAgentResponse('{"actions":[{"action":"wait"}]}').action === 'batch');
  t('top-level array of objects becomes a batch', parseAgentResponse('[{"action":"wait"},{"action":"scroll_down"}]').action === 'batch');
  t('example array before real json ignored', parseAgentResponse('Example: [{"action":"left_click","ref":"ref_1"}] then real: {"action":"refresh"}').action === 'refresh');
  t('empty string degrades to wait', parseAgentResponse('').action === 'wait');

  // ── alias normalization ──
  t('click aliases to left_click', norm('{"action":"click","ref":"ref_1"}').action === 'left_click');
  t('type_text aliases to type', norm('{"action":"type_text","ref":"ref_1","value":"x"}').action === 'type');
  t('fill aliases to type', norm('{"action":"fill","ref":"ref_1","value":"x"}').action === 'type');
  t('key_press aliases to key', norm('{"action":"key_press","key":"Enter"}').action === 'key');
  t('press_key aliases to key', norm('{"action":"press_key","key":"Tab"}').action === 'key');
  t('set_value aliases to form_input', norm('{"action":"set_value","ref":"ref_1","value":"y"}').action === 'form_input');
  t('back aliases to go_back', norm('{"action":"back"}').action === 'go_back');
  t('forward aliases to go_forward', norm('{"action":"forward"}').action === 'go_forward');
  t('reload aliases to refresh', norm('{"action":"reload"}').action === 'refresh');
  t('js aliases to javascript', norm('{"action":"js","value":"1+1"}').action === 'javascript');
  t('hyphens normalized to underscores', norm('{"action":"go-back"}').action === 'go_back');
  t('action case normalized', norm('{"action":"LEFT_CLICK","ref":"ref_1"}').action === 'left_click');

  // ── scroll direction ──
  t('scroll defaults to down', norm('{"action":"scroll"}').action === 'scroll_down');
  t('scroll up honoured', norm('{"action":"scroll","direction":"up"}').action === 'scroll_up');

  // ── field aliasing ──
  t('targetRef accepted as ref', norm('{"action":"click","targetRef":"ref_9"}').ref === 'ref_9');
  t('text_to_type accepted as value', norm('{"action":"type","ref":"ref_1","text_to_type":"hi"}').value === 'hi');
  t('input accepted as value', norm('{"action":"type","ref":"ref_1","input":"hi"}').value === 'hi');
  t('type falls back to text when value absent', norm('{"action":"type","ref":"ref_1","text":"hi"}').value === 'hi');
  t('find takes value', norm('{"action":"find","value":"Submit"}').value === 'Submit');
  t('find falls back to text', norm('{"action":"find","text":"Submit"}').value === 'Submit');

  // ── requirements: an action missing its target must not become a click ──
  t('navigate without url degrades', norm('{"action":"navigate"}').action === 'wait');
  t('navigate with url kept', norm('{"action":"navigate","url":"https://x.com"}').action === 'navigate');
  t('key without key degrades', norm('{"action":"key"}').action === 'wait');
  t('type without ref degrades', norm('{"action":"type","value":"x"}').action === 'wait');
  t('type with ref but no value degrades', norm('{"action":"type","ref":"ref_1"}').action === 'wait');
  t('form_input without ref degrades', norm('{"action":"form_input","value":"x"}').action === 'wait');
  t('left_click without ref degrades', norm('{"action":"left_click"}').action === 'wait');
  t('javascript without code degrades', norm('{"action":"javascript"}').action === 'wait');
  t('find without a query degrades', norm('{"action":"find"}').action === 'wait');

  // ── done ──
  t('done recognized', norm('{"action":"done","text":"finished"}').action === 'done');
  t('COURSE_COMPLETE in text implies done', norm('{"action":"wait","text":"COURSE_COMPLETE"}').action === 'done');

  // ── batch ──
  const batch = norm('{"actions":[{"action":"click","ref":"ref_1"},{"action":"key","key":"Enter"}]}');
  t('batch normalized', batch.action === 'batch' && batch.actions.length === 2);
  t('batch children normalized too', batch.actions[0].action === 'left_click' && batch.actions[1].action === 'key');
  const junkBatch = norm('{"actions":["nonsense",42]}');
  t('non-object batch entries become waits', junkBatch.actions.every(a => a.action === 'wait'));

  // ── the permissive fallback: any object carrying a ref becomes a click. That
  // is load-bearing for sloppy models, so it is asserted deliberately rather
  // than left as an accident — and it must NOT fire without a ref.
  t('unknown action WITH a ref becomes a click', norm('{"action":"frobnicate","ref":"ref_7"}').action === 'left_click');
  t('unknown action WITHOUT a ref becomes wait', norm('{"action":"frobnicate"}').action === 'wait');

  // ── shape guarantees: every consumer reads these fields unconditionally ──
  const shaped = norm('{"action":"left_click","ref":"ref_1"}');
  t('normalized action always has ref key', 'ref' in shaped);
  t('normalized action always has value key', 'value' in shaped);
  t('normalized action always has key key', 'key' in shaped);
  t('normalized action always has url key', 'url' in shaped);
  t('normalized action always has text key', 'text' in shaped);
  t('missing fields normalize to empty string not undefined', shaped.value === '' && shaped.url === '');
}
