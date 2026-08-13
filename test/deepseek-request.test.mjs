// The request body is the extension's contract with the DeepSeek API, and it
// had no coverage at all — which is how the bug that broke every run shipped:
// `reasoning_content` was stripped from assistant turns while `tools` was sent
// on every request, so the API 400'd from step 2 onward and no test noticed.
//
// These assertions pin the two rules that are easy to "clean up" back into
// breakage: reasoning_content is replayed verbatim, and thinking-off must be
// stated explicitly rather than omitted.
const B = new URL('../src/', import.meta.url).href;
const { buildRequestBody, sanitizeForAPI } = await import(B + 'sidepanel/deepseek.js');
const Constants = await import(B + 'shared/constants.js');
const { THINKING_STAGES, REASONING_EFFORTS, MODEL, SYNTHESIS_MODEL, VISION_SUPPORTED } = Constants;

export default function run(t) {
  const TOOLS = [{ type: 'function', function: { name: 'read_page', parameters: {} } }];
  // The shape a real tool-calling turn produces: assistant thinks, calls a
  // tool, gets a result, and is asked to continue.
  const toolTurn = [
    { role: 'user', content: 'collect the jobs' },
    {
      role: 'assistant',
      content: '',
      reasoning_content: 'I should read the page first.',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_page', arguments: '{}' } }]
    },
    { role: 'tool', tool_call_id: 'call_1', content: '[ref_1] Search' }
  ];

  // ── reasoning_content round-trip: the actual bug ──
  const replayed = sanitizeForAPI(toolTurn);
  t('reasoning_content survives sanitize', replayed[1].reasoning_content === 'I should read the page first.');
  t('reasoning_content is verbatim, not truncated',
    replayed[1].reasoning_content === toolTurn[1].reasoning_content);
  t('tool_calls still survive sanitize', replayed[1].tool_calls?.[0]?.id === 'call_1');
  t('tool_call_id still survives sanitize', replayed[2].tool_call_id === 'call_1');

  // Only assistant turns carry it — a user/tool message with a stray
  // reasoning_content must not smuggle the field onto a role that has no such
  // parameter in the API schema.
  const stray = sanitizeForAPI([{ role: 'user', content: 'hi', reasoning_content: 'nope' }]);
  t('reasoning_content not forwarded on non-assistant roles', stray[0].reasoning_content === undefined);
  t('absent reasoning_content stays absent',
    sanitizeForAPI([{ role: 'assistant', content: 'x' }])[0].reasoning_content === undefined);

  // Bookkeeping props must still be stripped — that part was always correct.
  const book = sanitizeForAPI([{ role: 'tool', tool_call_id: 'c', content: 'r', pruned: true, legacyToolResult: true }]);
  t('bookkeeping props stripped', book[0].pruned === undefined && book[0].legacyToolResult === undefined);
  t('null content becomes empty string', sanitizeForAPI([{ role: 'assistant' }])[0].content === '');

  // A request carrying tools MUST carry the history's reasoning blocks.
  const withTools = buildRequestBody({ model: MODEL, messages: toolTurn, tools: TOOLS, thinking: 'enabled+effort', reasoningEffort: 'high' });
  t('tools request replays reasoning_content',
    withTools.messages.filter((m) => m.reasoning_content).length === 1);
  t('tools forwarded', withTools.tools?.length === 1);

  // ── the thinking ladder ──
  // 'omit' is the only rung that mentions neither field, and it is the terminal
  // rung — so the ladder always ends somewhere these 400s cannot recur.
  const omit = buildRequestBody({ model: MODEL, messages: toolTurn, thinking: 'omit' });
  t('omit sends no thinking field', omit.thinking === undefined);
  t('omit sends no reasoning_effort', omit.reasoning_effort === undefined);

  // Thinking is ON by default server-side, so "disabled" has to be explicit.
  // Omitting the field does NOT turn it off — asserting this is the whole point.
  const off = buildRequestBody({ model: MODEL, messages: toolTurn, thinking: 'disabled' });
  t('disabled states thinking off explicitly', off.thinking?.type === 'disabled');
  t('disabled sends no reasoning_effort', off.reasoning_effort === undefined);

  const on = buildRequestBody({ model: MODEL, messages: toolTurn, thinking: 'enabled' });
  t('enabled states thinking on', on.thinking?.type === 'enabled');
  t('enabled without effort omits reasoning_effort', on.reasoning_effort === undefined);

  const full = buildRequestBody({ model: MODEL, messages: toolTurn, thinking: 'enabled+effort', reasoningEffort: 'low' });
  t('enabled+effort sends both', full.thinking?.type === 'enabled' && full.reasoning_effort === 'low');

  t('ladder ends at omit', THINKING_STAGES[THINKING_STAGES.length - 1] === 'omit');
  t('ladder starts at full effort', THINKING_STAGES[0] === 'enabled+effort');
  t('every ladder rung builds a body', THINKING_STAGES.every((stage) => {
    const b = buildRequestBody({ model: MODEL, messages: toolTurn, tools: TOOLS, thinking: stage, reasoningEffort: 'high' });
    return b.model === MODEL && Array.isArray(b.messages);
  }));

  // ── reasoning_effort enum ──
  // 'medium' is not in the enum; it is silently rewritten to 'high' upstream, so
  // forwarding it would make the debug log lie about the tier actually applied.
  t('medium corrected to high',
    buildRequestBody({ model: MODEL, messages: [], thinking: 'enabled+effort', reasoningEffort: 'medium' }).reasoning_effort === 'high');
  t('unknown effort corrected to high',
    buildRequestBody({ model: MODEL, messages: [], thinking: 'enabled+effort', reasoningEffort: 'bogus' }).reasoning_effort === 'high');
  t('missing effort defaults to high',
    buildRequestBody({ model: MODEL, messages: [], thinking: 'enabled+effort' }).reasoning_effort === 'high');
  t('medium is not a valid enum value', !REASONING_EFFORTS.includes('medium'));
  t('every valid effort is forwarded unchanged', REASONING_EFFORTS.every((e) =>
    buildRequestBody({ model: MODEL, messages: [], thinking: 'enabled+effort', reasoningEffort: e }).reasoning_effort === e));

  // ── body basics ──
  t('max_tokens defaults', buildRequestBody({ model: 'm', messages: [] }).max_tokens === 8192);
  t('max_tokens honoured', buildRequestBody({ model: 'm', messages: [], maxTokens: 100 }).max_tokens === 100);
  t('empty tools array not sent', buildRequestBody({ model: 'm', messages: [], tools: [] }).tools === undefined);
  t('no stream flag in base body', buildRequestBody({ model: 'm', messages: [] }).stream === undefined);

  // ── single model ──
  // BAT ships exactly one id. These assertions exist so that reintroducing a
  // picker, or drifting the synthesis model apart from the interactive one,
  // fails here rather than in a 400 at runtime.
  t('model is V4 Flash', MODEL === 'deepseek-v4-flash');
  t('model is a current, non-retired id',
    MODEL !== 'deepseek-chat' && MODEL !== 'deepseek-reasoner');
  t('synthesis shares the one model', SYNTHESIS_MODEL === MODEL);
  t('constants expose no model list',
    Constants.MODEL_OPTIONS === undefined
    && Constants.DEFAULT_MODEL === undefined
    && Constants.RETIRED_MODELS === undefined);

  // V4 is text-only: DeepSeek documents Tool Calls and JSON Output for it, but
  // no image input. The screenshot path must stay gated.
  t('vision stays disabled for a text-only model', VISION_SUPPORTED === false);

  // The body must carry the one id, whatever the caller passes around it.
  t('request body carries the model id',
    buildRequestBody({ model: MODEL, messages: toolTurn, tools: TOOLS, thinking: 'enabled+effort' }).model === 'deepseek-v4-flash');
}
