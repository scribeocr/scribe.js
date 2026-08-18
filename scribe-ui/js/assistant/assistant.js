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
 * Thinking and redacted-thinking blocks arrive whole and opaque.
 * `done` carries the provider's stop reason when it reports one (e.g. 'max_tokens', 'refusal').
 * @typedef {{type: 'text', text: string} | {type: 'tool_call', call: AdapterToolCall}
 *   | {type: 'thinking', thinking: string, signature: string} | {type: 'redacted_thinking', data: string}
 *   | {type: 'done', stopReason?: ?string}} AdapterEvent
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
 * Thinking and redacted-thinking blocks are opaque and must be stored and echoed back verbatim, which the provider's multi-turn tool contract requires.
 * @typedef {{type: 'text', text: string} | {type: 'tool_call', call: AdapterToolCall}
 *   | {type: 'thinking', thinking: string, signature: string} | {type: 'redacted_thinking', data: string}
 *   | ToolResultBlock} AssistantContentBlock
 */

/**
 * One message in the vendor-neutral thread format.
 * `tool_result` blocks answer the assistant's `tool_call` blocks and ride a user-role message.
 * @typedef {Object} AssistantMessage
 * @property {'user'|'assistant'} role
 * @property {string} [model] - Model that produced an assistant message, letting adapters drop model-tied reasoning blocks after a switch.
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
 * @param {AbortSignal} [opts.signal] - Stops between events; calls the stop leaves unanswered are closed with interrupted error results so the thread stays valid.
 * @param {import('./trace.js').AssistantTrace} [opts.trace] - Records the turn's events as they happen, so even a thrown turn leaves a full record.
 * @param {number} [opts.maxSteps] - Overrides the model-turn cap, for harness runs studying pathological loops.
 * @param {(delta: string) => void} [opts.onText] - Streamed reply text.
 * @param {(info: {call: AdapterToolCall, caption: string}) => void} [opts.onVerbStart] - Fired as each verb begins; `caption` is the registry's working phrasing.
 * @param {(info: {call: AdapterToolCall, res: import('./verbs.js').VerbResult}) => void} [opts.onVerbEnd] - Fired as each verb settles, success or refusal.
 * @param {(receipt: import('./verbs.js').VerbReceipt) => void} [opts.onReceipt] - Fired after onVerbEnd when the verb produced a receipt.
 * @param {(info: {reason: 'completed'|'max-tokens'|'refusal'|'aborted'|'max-steps'}) => void} [opts.onTurnEnd] - Fired once as the turn settles, distinguishing a clean finish from the other exits.
 *   A thrown turn skips it, since the error is the signal there.
 * @returns {Promise<Array<AssistantMessage>>} The extended thread, ready for the next turn.
 *   A failed turn rethrows its error with the settled partial thread attached as `thread`, so the caller can keep the exchange.
 */
export async function runAssistantTurn({
  host, adapter, messages, ask, signal, trace, maxSteps, onText, onVerbStart, onVerbEnd, onReceipt, onTurnEnd,
}) {
  const tools = VERBS.map((v) => ({ name: v.name, description: v.description, params: v.params }));
  const thread = [...messages, { role: 'user', content: [{ type: 'text', text: ask }] }];
  trace?.add('turn-start', { ask });

  let reason = 'max-steps';
  // The in-flight step's pieces live at function scope so the catch below can settle them onto the thread.
  /** @type {AssistantMessage['content']} */
  let assistantContent = [];
  /** @type {Array<AdapterToolCall>} */
  let calls = [];
  /** @type {AssistantMessage['content']} */
  let results = [];
  let contentPushed = false;
  let resultsPushed = false;
  try {
    let sentLen = 0;
    for (let step = 0; step < (maxSteps || MAX_STEPS); step++) {
      if (signal?.aborted) break;
      // The recorded suffix reconstructs the thread exactly only because the loop appends to it and never rewrites earlier messages.
      trace?.add('request', { step, messages: thread.slice(step === 0 ? 0 : sentLen) });
      sentLen = thread.length;
      assistantContent = [];
      calls = [];
      results = [];
      contentPushed = false;
      resultsPushed = false;
      let stopReason = null;
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
        } else if (ev.type === 'thinking' || ev.type === 'redacted_thinking') {
          assistantContent.push(ev.type === 'thinking'
            ? { type: 'thinking', thinking: ev.thinking, signature: ev.signature }
            : { type: 'redacted_thinking', data: ev.data });
        } else if (ev.type === 'done') {
          stopReason = ev.stopReason ?? null;
        }
      }
      if (assistantContent.length > 0) {
        thread.push({ role: 'assistant', ...(adapter.model ? { model: adapter.model } : {}), content: assistantContent });
        trace?.add('assistant-message', { content: assistantContent });
        contentPushed = true;
      }
      if (calls.length === 0) {
        // Only a response with no calls ends on its stop reason, since a truncated step that still delivered complete calls self-heals by running them.
        reason = stopReason === 'max_tokens' ? 'max-tokens' : stopReason === 'refusal' ? 'refusal' : 'completed';
        break;
      }

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
      // A stop mid-verbs leaves later calls unanswered; close them so every tool_use has its tool_result.
      while (results.length < calls.length) {
        results.push({
          type: 'tool_result', id: calls[results.length].id, result: { error: 'Interrupted before completion.' }, isError: true,
        });
      }
      if (results.length > 0) {
        thread.push({ role: 'user', content: results });
        resultsPushed = true;
      }
      if (signal?.aborted) break;
    }
    if (signal?.aborted) reason = 'aborted';
    trace?.add('turn-end', { reason });
    if (onTurnEnd) onTurnEnd({ reason });
    return thread;
  } catch (err) {
    // Settling the partial step keeps the failed exchange on the thread, so the caller's next turn is not missing work the user watched happen.
    if (!contentPushed && assistantContent.length > 0) {
      thread.push({ role: 'assistant', ...(adapter.model ? { model: adapter.model } : {}), content: assistantContent });
      trace?.add('assistant-message', { content: assistantContent });
    }
    if (calls.length > 0 && !resultsPushed) {
      while (results.length < calls.length) {
        results.push({
          type: 'tool_result', id: calls[results.length].id, result: { error: 'Interrupted before completion.' }, isError: true,
        });
      }
      thread.push({ role: 'user', content: results });
    }
    if (err instanceof Error) /** @type {Error & {thread?: Array<AssistantMessage>}} */ (err).thread = thread;
    trace?.add('turn-end', {
      reason: signal?.aborted ? 'aborted' : 'error',
      error: { message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack ?? null : null },
    });
    throw err;
  }
}
