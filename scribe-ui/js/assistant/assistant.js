import { VERBS, runVerb } from './verbs.js';

/**
 * @typedef {Object} AdapterToolCall
 * @property {string} id - Provider call id, echoed back in the matching tool result.
 * @property {string} name
 * @property {Object} params
 */

/**
 * One streamed event from an adapter turn.
 * Text arrives as deltas; a tool call arrives whole once its parameters are complete.
 * @typedef {{type: 'text', text: string} | {type: 'tool_call', call: AdapterToolCall} | {type: 'done'}} AdapterEvent
 */

/**
 * A verb's outcome, answering the assistant's `tool_call` block with the same id.
 * @typedef {Object} ToolResultBlock
 * @property {'tool_result'} type
 * @property {string} id
 * @property {Object} result
 * @property {boolean} isError
 */

/**
 * One block of a message's content.
 * @typedef {{type: 'text', text: string} | {type: 'tool_call', call: AdapterToolCall} | ToolResultBlock} AssistantContentBlock
 */

/**
 * One message in the vendor-neutral thread format.
 * `tool_result` blocks answer the assistant's `tool_call` blocks and ride a user-role message.
 * @typedef {Object} AssistantMessage
 * @property {'user'|'assistant'} role
 * @property {Array<AssistantContentBlock>} content
 */

/**
 * The request one adapter turn receives.
 * @typedef {Object} AdapterRequest
 * @property {string} system
 * @property {Array<AssistantMessage>} messages
 * @property {Array<{name: string, description: string, params: Object}>} tools - Generated from the verb registry.
 * @property {AbortSignal} [signal]
 * @property {import('./trace.js').AssistantTrace} [trace] - When present, adapters may record wire-level entries into it.
 */

/**
 * One model an adapter offers, surfaced by the panel's picker.
 * @typedef {Object} AssistantModelOption
 * @property {string} id - The provider's model identifier.
 * @property {string} label - Short user-facing name.
 * @property {string} [hint] - One line on when to pick it, in document-task terms.
 */

/**
 * The injected LLM connection.
 * @typedef {Object} AssistantAdapter
 * @property {(request: AdapterRequest) => AsyncGenerator<AdapterEvent>} send
 * @property {Array<AssistantModelOption>} [models] - Offered models. When absent, the panel shows no picker.
 * @property {string} [model] - The model the next send uses, assignable between turns.
 */

/** Model turns per user ask, so a confused model cannot loop the tool cycle forever. */
const MAX_STEPS = 24;

const SYSTEM_PROMPT = 'You are the document assistant inside a PDF editor, acting on the document open next to this conversation. '
  + 'Work only through the provided tools and never invent document content: read before you claim, quote exactly before you change anything. '
  + 'Page and line indices are 0-based. Start an unfamiliar document with get_overview. '
  + 'Mutating tools verify your quote against the live text and refuse on any mismatch; when refused, re-read the page and retry with the exact text. '
  + 'When asked for something no tool covers, say so and name what you can do instead. '
  + 'Keep replies short; the user watches the document while you work.';

/**
 * Run one assistant turn: the user's ask, then as many model/tool cycles as the model needs.
 * @param {Object} opts
 * @param {import('../automations/registry.js').AutomationHost} opts.host
 * @param {AssistantAdapter} opts.adapter
 * @param {Array<AssistantMessage>} opts.messages - The thread so far; not mutated.
 * @param {string} opts.ask - The user's message.
 * @param {AbortSignal} [opts.signal] - Stops between events; the thread may then end on unanswered tool calls, which the next turn must not resend.
 * @param {import('./trace.js').AssistantTrace} [opts.trace] - Records the turn's events as they happen, so even a thrown turn leaves a full record.
 * @param {number} [opts.maxSteps] - Overrides the model-turn cap, for harness runs studying pathological loops.
 * @param {(delta: string) => void} [opts.onText] - Streamed reply text.
 * @param {(info: {call: AdapterToolCall, caption: string}) => void} [opts.onVerbStart] - Fired as each verb begins; `caption` is the registry's working phrasing.
 * @param {(info: {call: AdapterToolCall, res: import('./verbs.js').VerbResult}) => void} [opts.onVerbEnd] - Fired as each verb settles, success or refusal.
 * @param {(receipt: import('./verbs.js').VerbReceipt) => void} [opts.onReceipt] - Fired after onVerbEnd when the verb produced a receipt.
 * @returns {Promise<Array<AssistantMessage>>} The extended thread, ready for the next turn.
 */
export async function runAssistantTurn({
  host, adapter, messages, ask, signal, trace, maxSteps, onText, onVerbStart, onVerbEnd, onReceipt,
}) {
  const tools = VERBS.map((v) => ({ name: v.name, description: v.description, params: v.params }));
  const thread = [...messages, { role: 'user', content: [{ type: 'text', text: ask }] }];
  trace?.add('turn-start', { ask });

  let reason = 'max-steps';
  try {
    let sentLen = 0;
    for (let step = 0; step < (maxSteps || MAX_STEPS); step++) {
      if (signal?.aborted) break;
      // The recorded suffix reconstructs the thread exactly only because the loop appends to it and never rewrites earlier messages.
      trace?.add('request', { step, messages: thread.slice(step === 0 ? 0 : sentLen) });
      sentLen = thread.length;
      /** @type {AssistantMessage['content']} */
      const assistantContent = [];
      /** @type {Array<AdapterToolCall>} */
      const calls = [];
      for await (const ev of adapter.send({
        system: SYSTEM_PROMPT, messages: thread, tools, signal, trace,
      })) {
        if (ev.type === 'text') {
          const last = assistantContent[assistantContent.length - 1];
          if (last && last.type === 'text') last.text += ev.text;
          else assistantContent.push({ type: 'text', text: ev.text });
          if (onText) onText(ev.text);
        } else if (ev.type === 'tool_call') {
          assistantContent.push({ type: 'tool_call', call: ev.call });
          calls.push(ev.call);
        }
      }
      if (assistantContent.length > 0) {
        thread.push({ role: 'assistant', content: assistantContent });
        trace?.add('assistant-message', { content: assistantContent });
      }
      if (calls.length === 0) {
        reason = 'completed';
        break;
      }

      /** @type {AssistantMessage['content']} */
      const results = [];
      for (const call of calls) {
        if (signal?.aborted) break;
        if (onVerbStart || trace) {
          const entry = VERBS.find((v) => v.name === call.name);
          let caption = 'Working…';
          try { if (entry?.caption) caption = entry.caption(call.params || {}); } catch { /* malformed params; the verb's own error follows */ }
          if (onVerbStart) onVerbStart({ call, caption });
          trace?.add('verb-start', { name: call.name, params: call.params, caption });
        }
        const verbT0 = Date.now();
        const res = await runVerb(host, call.name, call.params);
        trace?.add('verb-end', {
          name: call.name, ms: Date.now() - verbT0, isError: !!res.isError, result: res.result, receipt: res.receipt ?? null,
        });
        if (onVerbEnd) onVerbEnd({ call, res });
        if (res.receipt && onReceipt) onReceipt(res.receipt);
        results.push({
          type: 'tool_result', id: call.id, result: res.result, isError: res.isError || false,
        });
      }
      if (results.length > 0) thread.push({ role: 'user', content: results });
      if (signal?.aborted) break;
    }
    if (signal?.aborted) reason = 'aborted';
    trace?.add('turn-end', { reason });
    return thread;
  } catch (err) {
    trace?.add('turn-end', {
      reason: signal?.aborted ? 'aborted' : 'error',
      error: { message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack ?? null : null },
    });
    throw err;
  }
}
