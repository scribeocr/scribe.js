const DEFAULT_MODEL = 'claude-opus-5';
// Thinking counts against max_tokens alongside the reply, so this is sized for the API's streaming guidance rather than expected reply length.
// Lowering it toward a plausible reply length silently truncates hard turns into all-thinking, no-content responses.
const DEFAULT_MAX_TOKENS = 64000;

/** The models this adapter offers. Labels and hints are user-facing copy, shown in the picker. */
const MODELS = [
  { id: 'claude-opus-5', label: 'Opus 5', hint: 'Best for edits and long documents — default' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', hint: 'Quick finds, highlights, and summaries' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', hint: 'Instant lookups on a page or two' },
];

/**
 * Anthropic adapter for the Automate panel's assistant.
 * Hand-rolled fetch and SSE rather than the Anthropic SDK, so the class runs in the browser.
 */
export class AssistantAdapterAnthropic {
  /** The offered models, exposed statically so a host can validate a stored choice before constructing. */
  static MODELS = MODELS;

  /**
   * @param {Object} opts
   * @param {string} opts.apiKey
   * @param {string} [opts.model]
   * @param {number} [opts.maxTokens]
   * @param {number} [opts.idleTimeoutMs] - Abort a stream when nothing arrives for this long.
   *   The API sends periodic SSE pings, so a healthy connection never goes quiet for the full window even while the model thinks.
   * @param {string} [opts.baseUrl]
   */
  constructor({
    apiKey, model = DEFAULT_MODEL, maxTokens = DEFAULT_MAX_TOKENS, idleTimeoutMs = 90000, baseUrl = 'https://api.anthropic.com',
  }) {
    if (!apiKey) throw new Error('An Anthropic API key is required.');
    this.apiKey = apiKey;
    this.model = model;
    this.models = MODELS;
    this.maxTokens = maxTokens;
    this.idleTimeoutMs = idleTimeoutMs;
    this.baseUrl = baseUrl;
  }

  /**
   * One model turn, streamed.
   * @param {import('../../scribe-ui/js/assistant/assistant.js').AdapterRequest} request
   * @returns {AsyncGenerator<import('../../scribe-ui/js/assistant/assistant.js').AdapterEvent>}
   */
  async* send({
    system, messages, tools, signal, trace,
  }) {
    const body = {
      model: this.model,
      max_tokens: this.maxTokens,
      system,
      stream: true,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.params })),
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content.flatMap((block) => {
          if (block.type === 'text') return [{ type: 'text', text: block.text }];
          if (block.type === 'tool_call') {
            return [{
              type: 'tool_use', id: block.call.id, name: block.call.name, input: block.call.params,
            }];
          }
          if (block.type === 'thinking' || block.type === 'redacted_thinking') {
            // Reasoning blocks are tied to the model that produced them, and another model silently ignores them while still billing their tokens.
            if (m.model && m.model !== this.model) return [];
            return [block.type === 'thinking'
              ? { type: 'thinking', thinking: block.thinking, signature: block.signature }
              : { type: 'redacted_thinking', data: block.data }];
          }
          return [{
            type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(block.result), is_error: block.isError,
          }];
        }),
      })),
    };

    trace?.add('wire-request', {
      url: `${this.baseUrl}/v1/messages`, model: body.model, maxTokens: body.max_tokens, messageCount: body.messages.length, toolCount: body.tools.length,
    });

    // A wedged connection resolves neither the fetch nor a read, so only an idle timer ends it.
    const watchdog = new AbortController();
    let stalled = false;
    /** @type {ReturnType<typeof setTimeout>} */
    let idleTimer;
    const arm = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { stalled = true; watchdog.abort(); }, this.idleTimeoutMs);
    };
    arm();
    try {
      const resp = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, watchdog.signal]) : watchdog.signal,
      });
      arm();
      trace?.add('wire-status', { status: resp.status });
      if (!resp.ok) {
        let raw = '';
        try { raw = await resp.text(); } catch { /* unreadable body */ }
        let message = `Anthropic API error ${resp.status}`;
        try {
          const err = JSON.parse(raw);
          if (err?.error?.message) message += `: ${err.error.message}`;
        } catch { /* non-JSON error body */ }
        trace?.add('wire-error', { status: resp.status, body: raw });
        throw new Error(message);
      }

      // Tool-call parameters arrive as partial JSON deltas and are only parseable at the block's stop event.
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let stopReason = null;
      /** @type {Object<number, {id: string, name: string, json: string}>} */
      const toolBlocks = {};
      /** @type {Object<number, {type: 'thinking', thinking: string, signature: string} | {type: 'redacted_thinking', data: string}>} */
      const thoughtBlocks = {};
      for (;;) {
        const { done, value } = await reader.read();
        arm();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          let ev;
          try {
            ev = JSON.parse(line.slice(5));
          } catch (parseErr) {
            trace?.add('wire-parse-error', { line });
            throw parseErr;
          }
          if (ev.type === 'error') {
            trace?.add('wire-error', { status: null, body: JSON.stringify(ev.error ?? null) });
            throw new Error(`Anthropic API error: ${ev.error?.message || 'unknown'}`);
          }
          if (ev.type === 'message_start') {
            trace?.add('wire-usage', { usage: ev.message?.usage ?? null, stopReason: ev.message?.stop_reason ?? null });
          } else if (ev.type === 'message_delta') {
            if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
            trace?.add('wire-usage', { usage: ev.usage ?? null, stopReason: ev.delta?.stop_reason ?? null });
          } else if (ev.type === 'content_block_start') {
            trace?.add('wire-block', { index: ev.index, blockType: ev.content_block?.type ?? null });
            if (ev.content_block?.type === 'tool_use') toolBlocks[ev.index] = { id: ev.content_block.id, name: ev.content_block.name, json: '' };
            else if (ev.content_block?.type === 'thinking') thoughtBlocks[ev.index] = { type: 'thinking', thinking: '', signature: '' };
            else if (ev.content_block?.type === 'redacted_thinking') thoughtBlocks[ev.index] = { type: 'redacted_thinking', data: ev.content_block.data || '' };
          } else if (ev.type === 'content_block_delta') {
            const thought = thoughtBlocks[ev.index];
            if (ev.delta?.type === 'text_delta') yield { type: 'text', text: ev.delta.text };
            else if (ev.delta?.type === 'input_json_delta' && toolBlocks[ev.index]) toolBlocks[ev.index].json += ev.delta.partial_json;
            else if (ev.delta?.type === 'thinking_delta' && thought?.type === 'thinking') thought.thinking += ev.delta.thinking;
            else if (ev.delta?.type === 'signature_delta' && thought?.type === 'thinking') thought.signature = ev.delta.signature;
            else if (ev.delta?.data && thought?.type === 'redacted_thinking') thought.data += ev.delta.data;
          } else if (ev.type === 'content_block_stop' && toolBlocks[ev.index]) {
            const t = toolBlocks[ev.index];
            delete toolBlocks[ev.index];
            // The accumulated JSON is recorded before the parse, so a malformed tool input is diagnosable from the trace.
            trace?.add('wire-block', { index: ev.index, blockType: 'tool_use', inputJson: t.json });
            let params;
            try {
              params = t.json ? JSON.parse(t.json) : {};
            } catch {
              // A block cut off at max_tokens ends mid-JSON, and dropping it lets the stop reason end the turn instead of a parse error.
              trace?.add('wire-tool-truncated', { index: ev.index, name: t.name });
              continue;
            }
            yield { type: 'tool_call', call: { id: t.id, name: t.name, params } };
          } else if (ev.type === 'content_block_stop' && thoughtBlocks[ev.index]) {
            const t = thoughtBlocks[ev.index];
            delete thoughtBlocks[ev.index];
            yield t;
          }
        }
      }
      yield { type: 'done', stopReason };
    } catch (err) {
      if (stalled) {
        trace?.add('wire-stall', { idleMs: this.idleTimeoutMs });
        throw new Error(`The connection stalled: nothing arrived from the API for ${Math.round(this.idleTimeoutMs / 1000)} seconds.`);
      }
      throw err;
    } finally {
      clearTimeout(idleTimer);
    }
  }
}
