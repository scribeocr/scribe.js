const DEFAULT_MODEL = 'claude-opus-5';
const DEFAULT_MAX_TOKENS = 4096;

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
   * @param {string} [opts.baseUrl]
   */
  constructor({
    apiKey, model = DEFAULT_MODEL, maxTokens = DEFAULT_MAX_TOKENS, baseUrl = 'https://api.anthropic.com',
  }) {
    if (!apiKey) throw new Error('An Anthropic API key is required.');
    this.apiKey = apiKey;
    this.model = model;
    this.models = MODELS;
    this.maxTokens = maxTokens;
    this.baseUrl = baseUrl;
  }

  /**
   * One model turn, streamed.
   * @param {import('../../scribe-ui/js/assistant/assistant.js').AdapterRequest} request
   * @returns {AsyncGenerator<import('../../scribe-ui/js/assistant/assistant.js').AdapterEvent>}
   */
  async* send({
    system, messages, tools, signal,
  }) {
    const body = {
      model: this.model,
      max_tokens: this.maxTokens,
      system,
      stream: true,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.params })),
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content.map((block) => {
          if (block.type === 'text') return { type: 'text', text: block.text };
          if (block.type === 'tool_call') {
            return {
              type: 'tool_use', id: block.call.id, name: block.call.name, input: block.call.params,
            };
          }
          return {
            type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(block.result), is_error: block.isError,
          };
        }),
      })),
    };

    const resp = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok) {
      let message = `Anthropic API error ${resp.status}`;
      try {
        const err = await resp.json();
        if (err?.error?.message) message += `: ${err.error.message}`;
      } catch { /* non-JSON error body */ }
      throw new Error(message);
    }

    // Tool-call parameters arrive as partial JSON deltas and are only parseable at the block's stop event.
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    /** @type {Object<number, {id: string, name: string, json: string}>} */
    const toolBlocks = {};
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const ev = JSON.parse(line.slice(5));
        if (ev.type === 'error') throw new Error(`Anthropic API error: ${ev.error?.message || 'unknown'}`);
        if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
          toolBlocks[ev.index] = { id: ev.content_block.id, name: ev.content_block.name, json: '' };
        } else if (ev.type === 'content_block_delta') {
          if (ev.delta?.type === 'text_delta') yield { type: 'text', text: ev.delta.text };
          else if (ev.delta?.type === 'input_json_delta' && toolBlocks[ev.index]) toolBlocks[ev.index].json += ev.delta.partial_json;
        } else if (ev.type === 'content_block_stop' && toolBlocks[ev.index]) {
          const t = toolBlocks[ev.index];
          delete toolBlocks[ev.index];
          yield { type: 'tool_call', call: { id: t.id, name: t.name, params: t.json ? JSON.parse(t.json) : {} } };
        }
      }
    }
    yield { type: 'done' };
  }
}
