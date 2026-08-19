// The "Generate bookmarks" automation: replace the outline with bookmarks built from the document's detected headings.
// The optional AI cleanup sends only the detected heading titles, never page text.
import { detectHeadingBookmarks, nestHeadingOutline } from '../../../js/objects/outlineObjects.js';

const lineIcon = (inner) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"'
  + ` style="pointer-events:none;display:block;width:100%;height:100%;" aria-hidden="true">${inner}</svg>`;
const INFO_SVG = lineIcon('<circle cx="12" cy="12" r="8"/><path d="M12 11v5M12 8v.01"/>');
const FLAG_SVG = lineIcon('<path d="M6 21V4.5"/><path d="M6 5h11l-2.5 3.5L17 12H6z"/>');
const SPIN_SVG = lineIcon('<path d="M12 4.5a7.5 7.5 0 1 0 7.5 7.5"/>');

/**
 * One icon-plus-text block for the staged form.
 * @param {string} svg
 * @param {string} text
 * @param {boolean} [quiet] - Bare row instead of the bordered note.
 */
function noteBlock(svg, text, quiet) {
  const note = document.createElement('div');
  note.className = `scribe-am-note${quiet ? ' quiet' : ''}`;
  const ic = document.createElement('span');
  ic.className = 'scribe-am-note-ic';
  ic.innerHTML = svg;
  const tx = document.createElement('span');
  tx.textContent = text;
  note.append(ic, tx);
  return note;
}

/**
 * The preflight wording for a settled candidate list.
 * @param {Array<{level: ?number}>} candidates
 */
function preflightText(candidates) {
  if (candidates.length < 3) return 'Fewer than 3 usable headings detected — running will change nothing.';
  const leveled = candidates.filter((h) => h.level != null).length;
  return `${candidates.length} headings detected · ${leveled < 3
    ? 'no level structure found — bookmarks will be a flat list.'
    : 'nested from the detected levels.'}`;
}

/**
 * @param {import('./registry.js').AutomationHost} host
 * @param {{boost?: boolean}} [prefill]
 */
export function buildForm(host, prefill) {
  const doc = host.viewer.doc;
  const formElem = document.createElement('div');
  formElem.className = 'scribe-am-form';

  let pre;
  if (doc._textReadySettle) {
    pre = noteBlock(SPIN_SVG, 'Detecting headings…');
    pre.querySelector('.scribe-am-note-ic').style.color = 'var(--scribe-accent)';
    doc.textReady.then(() => {
      if (host.viewer.doc !== doc || !formElem.isConnected) return;
      const settled = noteBlock(INFO_SVG, preflightText(detectHeadingBookmarks(doc)));
      pre.replaceWith(settled);
      pre = settled;
    }).catch(() => {});
  } else {
    pre = noteBlock(INFO_SVG, preflightText(detectHeadingBookmarks(doc)));
  }
  formElem.appendChild(pre);

  const existing = doc.outline.length;
  if (existing > 0) {
    formElem.appendChild(noteBlock(FLAG_SVG,
      `Replaces the ${existing} existing bookmark${existing === 1 ? '' : 's'}. One undo restores them.`, true));
  }

  const boost = document.createElement('div');
  boost.className = 'scribe-am-boost';
  const check = document.createElement('label');
  check.className = 'scribe-am-check';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = !!prefill?.boost;
  check.append(box, document.createTextNode('Clean up with AI'));
  const hint = document.createElement('div');
  hint.className = 'scribe-am-boost-hint';
  hint.textContent = 'Drops entries that aren’t real headings and fixes levels. Only the detected heading titles are sent.';
  boost.append(check, hint);
  formElem.appendChild(boost);

  host.app.getAssistantAdapter().then((adapter) => {
    if (adapter || !formElem.isConnected) return;
    box.checked = false;
    box.disabled = true;
    check.classList.add('off');
    hint.textContent = 'Needs an API key — add one below.';
    const card = document.createElement('div');
    card.className = 'scribe-as-key';
    const explain = document.createElement('span');
    explain.style.color = 'var(--scribe-ink-2)';
    explain.style.fontSize = '12px';
    explain.textContent = 'Paste an Anthropic API key to use AI cleanup. Calls go directly from this browser to Anthropic; the key is never sent anywhere else.';
    const input = document.createElement('input');
    input.type = 'password';
    input.placeholder = 'sk-ant-…';
    const error = document.createElement('span');
    error.className = 'scribe-as-key-error';
    error.style.display = 'none';
    const foot = document.createElement('div');
    foot.className = 'scribe-am-foot';
    const grow = document.createElement('span');
    grow.className = 'scribe-am-foot-grow';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'scribe-am-run';
    save.textContent = 'Save key';
    const submit = async () => {
      const key = input.value.trim();
      if (!key) { input.focus(); return; }
      try {
        await host.app.setAssistantKey(key);
      } catch (err) {
        error.textContent = err instanceof Error ? err.message : String(err);
        error.style.display = '';
        return;
      }
      card.remove();
      box.disabled = false;
      box.checked = true;
      check.classList.remove('off');
      hint.textContent = 'Drops entries that aren’t real headings and fixes levels. Only the detected heading titles are sent.';
    };
    save.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    foot.append(grow, save);
    const note = document.createElement('span');
    note.className = 'scribe-as-key-note';
    note.textContent = 'The key is saved in this browser until you remove it.';
    card.append(explain, input, error, foot, note);
    formElem.appendChild(card);
  });

  return {
    formElem,
    focus: () => box.focus(),
    getParams: () => ({
      boost: box.checked && !box.disabled,
      candCount: doc._textReadySettle ? null : detectHeadingBookmarks(doc).length,
    }),
  };
}

/** @param {?{boost: boolean, candCount: ?number}} params */
export function describeParams(params) {
  if (!params) return '';
  return `From ${params.candCount != null ? `${params.candCount} detected headings` : 'detected headings'} · ${params.boost ? 'AI cleanup' : 'all pages'}`;
}

/** The one tool the curation call may use, forcing a structured reply. */
const SUBMIT_TOOL = {
  name: 'submit_bookmarks',
  description: 'Submit the curated bookmark list. Call exactly once, listing every kept entry in the original order.',
  params: {
    type: 'object',
    properties: {
      keep: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer', description: 'The kept candidate\'s number from the list.' },
            level: { type: 'integer', minimum: 1, description: 'Heading level, 1 = top. Only when the hierarchy is clear.' },
            title: { type: 'string', description: 'Cleaned title. Only when the original carries obvious junk.' },
          },
          required: ['index'],
        },
      },
    },
    required: ['keep'],
  },
};

const CURATE_SYSTEM = 'You are cleaning up a list of heading candidates that a PDF layout detector produced for one document; '
  + 'the kept entries become the document\'s bookmarks. Drop entries that are not document headings: figure and diagram labels, '
  + 'chart words, page furniture, stray fragments. Keep real headings, including the document title. '
  + 'Set level (1 = top) only where numbering or wording clearly implies hierarchy; omit it otherwise. '
  + 'Rewrite a title only to strip obvious junk; never change its meaning. '
  + 'Call submit_bookmarks exactly once, listing every kept entry in the original order.';

/**
 * Run one curation call and return the model's keep-list.
 * @param {import('../assistant/assistant.js').AssistantAdapter} adapter
 * @param {Array<{title: string, pageIndex: number}>} candidates
 * @returns {Promise<?Array<{index: number, level?: number, title?: string}>>} Null when the model never called the tool.
 */
async function curateWithModel(adapter, candidates) {
  const list = candidates.map((c, i) => `${i}. [page ${c.pageIndex + 1}] ${c.title}`).join('\n');
  const request = {
    system: CURATE_SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: `Candidates:\n${list}` }] }],
    tools: [SUBMIT_TOOL],
  };
  let call = null;
  for await (const ev of adapter.send(request)) {
    if (ev.type === 'tool_call' && ev.call.name === 'submit_bookmarks' && !call) call = ev.call;
    if (ev.type === 'done') break;
  }
  if (!call || !Array.isArray(call.params?.keep)) return null;
  return call.params.keep;
}

/**
 * @param {import('./registry.js').AutomationHost} host
 * @param {{boost: boolean, candCount: ?number}} params
 * @param {(frac: number, caption: string) => void} progress
 * @returns {Promise<import('./registry.js').AutomationOutcome>}
 */
export async function run(host, params, progress) {
  const doc = host.viewer.doc;
  // A freshly-opened PDF may still be extracting text, so detecting before it settles would miss every heading.
  if (doc._textReadySettle) {
    progress(0, 'Waiting for text extraction…');
    await doc.textReady;
    if (host.viewer.doc !== doc) return { rows: [{ kind: 'info', text: 'The document changed before the run started.' }] };
  }
  progress(0.1, 'Detecting headings…');
  const candidates = detectHeadingBookmarks(doc);
  if (candidates.length < 3) {
    return { rows: [{ kind: 'info', text: 'Fewer than 3 usable headings — no change' }] };
  }

  let kept = candidates;
  let removed = 0;
  if (params?.boost) {
    const adapter = await host.app.getAssistantAdapter();
    progress(0.3, 'Cleaning up with AI…');
    let keepList = null;
    if (adapter) {
      try {
        keepList = await curateWithModel(adapter, candidates);
      } catch (err) {
        console.error('The bookmark AI cleanup failed:', err);
      }
    }
    // Falling back to the mechanical result here would misstate what ran, so a failed cleanup changes nothing.
    if (!keepList) {
      return {
        rows: [
          { kind: 'flag', text: 'AI cleanup didn’t finish — nothing changed' },
          { kind: 'info', text: 'Run again, or switch the cleanup off' },
        ],
      };
    }
    const seen = new Set();
    const curated = [];
    for (const k of keepList) {
      if (!Number.isInteger(k.index) || k.index < 0 || k.index >= candidates.length || seen.has(k.index)) continue;
      seen.add(k.index);
      const src = candidates[k.index];
      curated.push({
        index: k.index,
        title: typeof k.title === 'string' && k.title.trim() && k.title.trim().length <= 150 ? k.title.trim() : src.title,
        pageIndex: src.pageIndex,
        yFrac: src.yFrac,
        level: Number.isInteger(k.level) && k.level >= 1 && k.level <= 9 ? k.level : src.level,
      });
    }
    if (curated.length === 0) {
      return { rows: [{ kind: 'info', text: 'AI found no real headings — nothing changed' }] };
    }
    curated.sort((a, b) => a.index - b.index);
    kept = curated;
    removed = candidates.length - curated.length;
  }

  progress(0.9, 'Building bookmarks…');
  const prev = doc.replaceOutline(nestHeadingOutline(kept));
  if (host.viewer.doc === doc) host.app._bookmarksPanel?.rebuild();

  /** @type {Array<import('./registry.js').AutomationOutcomeRow>} */
  const rows = [];
  let offer;
  if (params?.boost) {
    rows.push({ kind: 'ok', text: `Added ${kept.length} bookmarks from ${candidates.length} detected` });
    if (removed > 0) rows.push({ kind: 'info', text: `Removed ${removed} entr${removed === 1 ? 'y that isn’t a heading' : 'ies that aren’t headings'}` });
  } else {
    const flat = kept.filter((h) => h.level != null).length < 3;
    rows.push({ kind: 'ok', text: `Added ${kept.length} bookmark${kept.length === 1 ? '' : 's'}${flat ? ' (flat list)' : ''}` });
    if (await host.app.getAssistantAdapter()) {
      offer = {
        text: 'Some of these may not be real headings — AI can drop entries that don’t belong and fix levels. Only the detected titles are sent.',
        actionLabel: 'Clean up with AI',
        params: { ...params, boost: true },
      };
    }
  }
  progress(1, '');
  return {
    rows,
    offer,
    review: {
      label: 'Show bookmarks',
      onClick: () => {
        if (host.app._activeSidebar !== 'bookmarks') host.app._requestSidebar('bookmarks');
      },
    },
    undo: {
      label: 'Undo',
      undoneText: 'Bookmarks restored to the previous set',
      onClick: () => {
        doc.replaceOutline(prev);
        if (host.viewer.doc === doc) host.app._bookmarksPanel?.rebuild();
      },
    },
  };
}
