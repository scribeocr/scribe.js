// An append-only record of one conversation, written as each event happens so a turn that throws still leaves a full record.
// The panel's log export and the experiment harness both read it through `buildTraceEnvelope`, so a field shaped for one has to stay readable by the other.

const MAX_ENTRIES = 2000;

/**
 * @typedef {Object} AssistantTrace
 * @property {string} startedAt
 * @property {Array<Object>} entries
 * @property {number} dropped
 * @property {(type: string, data?: Object) => void} add
 */

/** @returns {AssistantTrace} */
export function makeAssistantTrace() {
  const now = () => (globalThis.performance ? globalThis.performance.now() : Date.now());
  const t0 = now();
  const trace = {
    startedAt: new Date().toISOString(),
    entries: [],
    dropped: 0,
    add(type, data) {
      if (trace.entries.length >= MAX_ENTRIES) {
        // Wire entries are the bulkiest and the most reconstructible, so they age out first.
        const i = trace.entries.findIndex((e) => e.type.startsWith('wire-'));
        trace.entries.splice(i >= 0 ? i : 0, 1);
        trace.dropped++;
      }
      trace.entries.push({ t: Math.round(now() - t0), type, ...data });
    },
  };
  return trace;
}

/**
 * Assemble the versioned envelope the log export and harness artifacts both write.
 * @param {AssistantTrace} trace
 * @param {Object} opts
 * @param {?Object} [opts.adapter] - The adapter the conversation ran on.
 * @param {?{baseName: string, pageCount: number}} [opts.doc]
 * @param {?Object} [opts.flags]
 * @param {?{id: string, revision?: ?string}} [opts.scenario] - Harness runs only.
 * @param {?Array<Object>} [opts.messages] - The live thread, as the next turn would send it.
 */
export function buildTraceEnvelope(trace, {
  adapter, doc, flags, scenario, messages,
}) {
  return {
    format: 'scribe-assistant-trace',
    version: 1,
    startedAt: trace.startedAt,
    exportedAt: new Date().toISOString(),
    userAgent: globalThis.navigator?.userAgent ?? null,
    // The adapter holds the API key, so this picks named fields rather than spreading it.
    adapter: adapter ? {
      name: adapter.constructor?.name ?? null,
      model: adapter.model ?? null,
      maxTokens: adapter.maxTokens ?? null,
      baseUrl: adapter.baseUrl ?? null,
    } : null,
    doc: doc ?? null,
    flags: flags ?? null,
    ...(scenario ? { scenario } : {}),
    dropped: trace.dropped,
    entries: trace.entries,
    conversationAtExport: messages ?? null,
  };
}
