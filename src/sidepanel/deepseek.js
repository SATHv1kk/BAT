// DeepSeek transport + one model call.
//
// Extracted from app.js. Three transports are tried in order — streaming direct
// fetch, plain direct fetch, then the service-worker proxy — because each fails
// in a different way: the panel CSP can block a direct fetch outright, and a
// provider may reject `stream`. The cascade shares ONE overall deadline so
// retries can never stack into a multi-minute stall on a single step.
//
// Panel state is injected as `ctx` rather than reached for: the transports need
// the abort signal, the stop flag, the usage accumulator, the debug log, and
// whether reasoning params are still believed to work. Making that explicit is
// the difference between a module and a fragment.
//   ctx = { abortSignal(), isStopRequested(), debug(type, data), maskKey(key),
//           reasoningEnabled(model), onUsage(usage) }
import { DEEPSEEK_API, API_TIMEOUT_MS } from '../shared/constants.js';

const delay = (ms) => new Promise((r) => { setTimeout(r, ms); });

function deepSeekViaBackground(ctx, key, body) {
  return new Promise((resolve, reject) => {
    // Honor Stop: the worker fetch itself can't be aborted over messaging, but
    // rejecting here lets the loop wind down immediately instead of hanging 180s.
    const signal = ctx.abortSignal();
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal?.addEventListener('abort', onAbort, { once: true });
    let settled = false;
    const done = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(val);
    };
    const timer = setTimeout(() => done(reject, new Error('Background worker timed out after 30s — reload the extension')), 30000);
    chrome.runtime.sendMessage({ type: 'BAT_DEEPSEEK_API', key, body }, (res) => {
      if (chrome.runtime.lastError) {
        done(reject, new Error(chrome.runtime.lastError.message || 'Extension messaging failed'));
        return;
      }
      if (!res) {
        done(reject, new Error('No response from background worker — reload the extension'));
        return;
      }
      done(resolve, res);
    });
  });
}

async function deepSeekDirectFetch(ctx, key, body, timeoutMs = API_TIMEOUT_MS) {
  const controller = new AbortController();
  const onAgentAbort = () => controller.abort();
  const agentSignal = ctx.abortSignal();
  if (agentSignal) {
    if (agentSignal.aborted) throw new DOMException('Aborted', 'AbortError');
    agentSignal.addEventListener('abort', onAgentAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(DEEPSEEK_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + key
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const raw = await resp.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = { error: { message: raw.slice(0, 200) } };
    }

    return { ok: resp.ok, status: resp.status, data, via: 'sidebar' };
  } catch (err) {
    if (err?.name === 'AbortError' && ctx.isStopRequested()) throw err;
    const msg = err?.name === 'AbortError'
      ? `Request timed out after ${timeoutMs / 1000}s`
      : (err?.message || 'Failed to fetch');
    return { ok: false, status: 0, error: msg, data: null, via: 'sidebar' };
  } finally {
    clearTimeout(timer);
    if (agentSignal) agentSignal.removeEventListener('abort', onAgentAbort);
  }
}

// Streaming (SSE) fetch — shows tokens as they arrive; accumulates tool-call deltas.
async function deepSeekStreamFetch(ctx, key, body, timeoutMs = API_TIMEOUT_MS, onDelta) {
  const controller = new AbortController();
  const onAgentAbort = () => controller.abort();
  const agentSignal = ctx.abortSignal();
  if (agentSignal) {
    if (agentSignal.aborted) throw new DOMException('Aborted', 'AbortError');
    agentSignal.addEventListener('abort', onAgentAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(DEEPSEEK_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + key
      },
      body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
      signal: controller.signal
    });

    if (!resp.ok) {
      const raw = await resp.text();
      let data = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch { data = { error: { message: raw.slice(0, 200) } }; }
      return { ok: false, status: resp.status, data, via: 'sidebar-stream' };
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let content = '';
    let reasoning = '';
    const toolAcc = [];
    let finishReason = null;
    let usage = null;

    const consume = (line) => {
      const t = line.trim();
      if (!t.startsWith('data:')) return;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') return;
      let chunk;
      try { chunk = JSON.parse(payload); } catch { return; }
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const d = choice.delta || {};
      if (d.content) {
        content += d.content;
        onDelta?.(content, 'content');
      }
      if (d.reasoning_content) {
        reasoning += d.reasoning_content;
        if (!content) onDelta?.(reasoning, 'reasoning');
      }
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const i = tc.index ?? 0;
          if (!toolAcc[i]) toolAcc[i] = { id: tc.id || 'call_' + i, type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) toolAcc[i].id = tc.id;
          if (tc.function?.name) toolAcc[i].function.name += tc.function.name;
          if (tc.function?.arguments) toolAcc[i].function.arguments += tc.function.arguments;
        }
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) consume(line);
    }
    // The tail was discarded when the loop ended, so a final SSE event that
    // arrived without a trailing newline was dropped. Usually harmless on a
    // content delta; on the last tool_call fragment it silently truncated the
    // arguments JSON, and the loop then reported "malformed tool arguments" for
    // a response the model had sent correctly.
    buf += decoder.decode();
    if (buf.trim()) consume(buf);

    const message = { role: 'assistant', content, reasoning_content: reasoning };
    const toolCalls = toolAcc.filter(Boolean);
    if (toolCalls.length) message.tool_calls = toolCalls;
    return {
      ok: true,
      status: 200,
      data: { choices: [{ message, finish_reason: finishReason }], usage },
      via: 'sidebar-stream'
    };
  } catch (err) {
    if (err?.name === 'AbortError' && ctx.isStopRequested()) throw err;
    const msg = err?.name === 'AbortError'
      ? `Request timed out after ${timeoutMs / 1000}s`
      : (err?.message || 'Failed to fetch');
    return { ok: false, status: 0, error: msg, data: null, via: 'sidebar-stream' };
  } finally {
    clearTimeout(timer);
    if (agentSignal) agentSignal.removeEventListener('abort', onAgentAbort);
  }
}

const API_RETRY_STATUSES = new Set([0, 429, 502, 503, 504]);
const API_MAX_RETRIES = 3;

async function fetchDeepSeekWithTransport(ctx, key, body, step, onDelta, timeoutMs = API_TIMEOUT_MS) {
  // 1. streaming direct fetch → 2. plain direct fetch → 3. background worker
  let res = await deepSeekStreamFetch(ctx, key, body, timeoutMs, onDelta);
  const streamRejected = !res.ok && res.status === 400
    && /stream/i.test(res.data?.error?.message || res.error || '');
  if (!res.ok && (res.status === 0 || streamRejected)) {
    ctx.debug('api_fallback', { step, reason: res.error || res.data?.error?.message, from: res.via });
    res = await deepSeekDirectFetch(ctx, key, body, timeoutMs);
  }
  if (!res.ok && res.status === 0) {
    ctx.debug('api_fallback', { step, reason: res.error, from: res.via });
    try {
      res = await deepSeekViaBackground(ctx, key, body);
    } catch (err) {
      if (err?.name === 'AbortError') throw err; // Stop pressed — don't convert into a retryable status-0
      return { ok: false, status: 0, error: err.message || 'Failed to reach DeepSeek API', data: null, via: 'background' };
    }
  }
  return res;
}

// Strip our bookkeeping props (legacyToolResult, pruned) before sending
function sanitizeForAPI(messages) {
  return messages.map(m => {
    const out = { role: m.role, content: m.content ?? '' };
    if (m.tool_calls) out.tool_calls = m.tool_calls;
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    return out;
  });
}

export async function callDeepSeekAPI(ctx, key, model, messages, opts = {}) {
  if (!key) throw new Error('No DeepSeek API key configured');
  const body = {
    model,
    messages: sanitizeForAPI(messages),
    max_tokens: opts.max_tokens ?? 8192
  };
  if (opts.tools?.length) {
    body.tools = opts.tools;
  }
  // Reasoning params are OPTIONAL and provider-specific. There were graceful
  // fallbacks for `stream` and for `tools` but none for these, so a provider (or
  // a model tier) that rejects them failed every single request with a bare
  // "HTTP 400" and no way forward. Once rejected they stay off for the session.
  if (ctx.reasoningEnabled(model)) {
    body.reasoning_effort = opts.reasoning_effort ?? 'high';
    body.thinking = { type: 'enabled' };
  }

  const payloadSize = JSON.stringify(body).length;
  ctx.debug('api_request', {
    step: opts.step,
    model,
    messageCount: messages.length,
    payloadBytes: payloadSize,
    key: ctx.maskKey(key)
  });

  // One overall deadline per model call — the transport cascade and retries
  // must never stack into multi-minute stalls on a single step.
  let res = null;
  const deadline = Date.now() + API_TIMEOUT_MS + 60000;
  for (let attempt = 0; attempt < API_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
      ctx.debug('api_retry', { step: opts.step, attempt: attempt + 1, backoffMs: backoff });
      await delay(backoff);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 5000) break;
    res = await fetchDeepSeekWithTransport(ctx, key, body, opts.step, opts.onDelta, Math.min(API_TIMEOUT_MS, remaining));
    if (res.ok) break;
    if (!API_RETRY_STATUSES.has(res.status)) break;
  }
  if (!res) {
    res = { ok: false, status: 0, error: 'API call deadline exceeded', data: null, via: 'deadline' };
  }

  if (!res.ok) {
    const d = res.data || {};
    let msg = res.status ? `DeepSeek HTTP ${res.status}` : 'DeepSeek network error';
    if (res.status === 401) msg += ' — Invalid key';
    else if (res.status === 402) msg += ' — Insufficient balance';
    else if (res.status === 429) msg += ' — Rate limit (retried)';
    else if (res.status >= 500) msg += ' — Server error (retried)';
    else if (res.error) msg += ' — ' + res.error;
    if (res.via) msg += ` (${res.via})`;
    if (API_RETRY_STATUSES.has(res.status) || res.status === 0) {
      msg += ` — failed after ${API_MAX_RETRIES} attempts`;
    }
    ctx.debug('api_error', {
      step: opts.step,
      status: res.status,
      error: msg,
      via: res.via,
      apiMessage: d.error?.message || null,
      retries: API_MAX_RETRIES
    });
    const err = new Error(msg + (d.error?.message ? `: ${d.error.message}` : ''));
    err.apiStatus = res.status;
    throw err;
  }

  const data = res.data || {};
  if (data.error) {
    ctx.debug('api_error', { step: opts.step, error: data.error.message });
    throw new Error('DeepSeek: ' + data.error.message);
  }

  if (data.usage) {
    ctx.onUsage(data.usage);
  }

  const choice = data.choices?.[0]?.message || {};
  const content = (choice.content || '').trim();
  const reasoning = (choice.reasoning_content || '').trim();
  const toolCalls = Array.isArray(choice.tool_calls) ? choice.tool_calls : [];

  ctx.debug('api_response', {
    step: opts.step,
    status: res.status,
    via: res.via,
    finishReason: data.choices?.[0]?.finish_reason,
    contentLen: content.length,
    reasoningLen: reasoning.length,
    toolCalls: toolCalls.map(tc => tc.function?.name),
    usage: data.usage || null,
    preview: (content || reasoning).slice(0, 500)
  });

  // Never replay reasoning_content back to the API — store content + tool_calls only.
  const finalContent = content || (toolCalls.length ? '' : reasoning);
  const message = {
    role: 'assistant',
    content: finalContent,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {})
  };
  return { content: finalContent, message };
}
