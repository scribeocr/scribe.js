/**
 * A scripted adapter that plays back a fixed sequence of model turns.
 * @param {Array<{text?: string, calls?: Array<{name: string, params: Object}>, stopReason?: string}>} turns
 *   One entry per model turn, in order: optional reply text, then optional tool calls.
 *   `stopReason` rides the turn's done event, mimicking a provider stop like 'max_tokens'.
 *   Turns past the end of the script produce an empty reply, which ends the loop.
 * @param {{delayMs?: number}} [opts] - Delay before each event, so working states last long enough to see and test.
 * @returns {import('./assistant.js').AssistantAdapter & {requests: Array<Object>}}
 *   `requests` records every request the loop sent, oldest first, for assertions.
 */
export function makeScriptedAdapter(turns, { delayMs = 0 } = {}) {
  let turnN = 0;
  let callN = 0;
  const requests = [];
  const wait = (signal) => (delayMs ? new Promise((resolve, reject) => {
    const t = setTimeout(resolve, delayMs);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('Aborted')); }, { once: true });
  }) : null);
  return {
    requests,
    async* send(request) {
      // The loop sends its live thread array, so record a snapshot of what this send actually saw.
      requests.push({ ...request, messages: request.messages.slice() });
      const turn = turns[turnN] || {};
      turnN++;
      if (turn.text) {
        await wait(request.signal);
        yield { type: 'text', text: turn.text };
      }
      for (const c of turn.calls || []) {
        await wait(request.signal);
        callN++;
        yield { type: 'tool_call', call: { id: `call-${callN}`, name: c.name, params: c.params } };
      }
      yield { type: 'done', stopReason: turn.stopReason };
    },
  };
}
