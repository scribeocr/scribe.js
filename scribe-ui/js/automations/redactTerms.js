// The "Redact terms" automation: stage a redaction mark over every occurrence of the listed terms.
import scribe from '../../../scribe.js';
import { redactWords } from '../viewerRedactions.js';

/**
 * A word token with edge punctuation stripped, for whole-word comparison.
 * Interior punctuation stays, so hyphenated and possessive terms still match exactly.
 * @param {string} text
 */
const trimPunct = (text) => text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

/**
 * Every non-overlapping occurrence of `term` on a page, as runs of matched words.
 * Multi-word terms match consecutive words in reading order, like the find bar.
 * @param {OcrPage} page
 * @param {string} term
 * @param {{wholeWords: boolean, matchCase: boolean}} opts
 * @returns {Array<Array<OcrWord>>}
 */
function findOccurrences(page, term, opts) {
  const norm = (s) => (opts.matchCase ? s : s.toLowerCase());
  const termTokens = norm(term.trim()).split(/\s+/);
  if (!termTokens.length || !termTokens[0]) return [];
  const words = scribe.utils.ocr.getPageWords(page);
  const occurrences = [];
  for (let i = 0; i <= words.length - termTokens.length; i++) {
    const cand = words.slice(i, i + termTokens.length);
    let hit;
    if (opts.wholeWords) {
      hit = cand.every((w, j) => norm(trimPunct(w.text)) === termTokens[j]);
    } else if (termTokens.length === 1) {
      hit = norm(cand[0].text).includes(termTokens[0]);
    } else {
      hit = norm(cand.map((w) => w.text).join(' ')).includes(termTokens.join(' '));
    }
    if (hit) {
      occurrences.push(cand);
      i += termTokens.length - 1;
    }
  }
  return occurrences;
}

/**
 * @param {import('./registry.js').AutomationHost} host
 * @param {{terms?: Array<string>}} [prefill]
 */
export function buildForm(host, prefill) {
  const formElem = document.createElement('div');
  formElem.className = 'scribe-am-form';

  const label = document.createElement('div');
  label.className = 'scribe-am-label';
  label.textContent = 'Terms';

  const chipsWrap = document.createElement('div');
  chipsWrap.className = 'scribe-am-terms';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'scribe-am-terms-input';
  input.placeholder = 'Add a term…';
  input.setAttribute('aria-label', 'Add a term');
  chipsWrap.appendChild(input);

  /** @type {Array<string>} */
  const terms = [];
  const addChip = (raw) => {
    const term = raw.trim().replace(/\s+/g, ' ');
    if (!term || terms.includes(term)) return;
    terms.push(term);
    const chip = document.createElement('span');
    chip.className = 'scribe-am-chip';
    const text = document.createElement('span');
    text.textContent = term;
    const x = document.createElement('span');
    x.className = 'scribe-am-chip-x';
    x.textContent = '×';
    x.role = 'button';
    x.title = 'Remove term';
    x.addEventListener('click', () => {
      terms.splice(terms.indexOf(term), 1);
      chip.remove();
    });
    chip.append(text, x);
    chipsWrap.insertBefore(chip, input);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      // Enter with a term in flight commits it; Enter with none falls through to the panel's Run.
      if (!input.value.trim()) return;
      e.preventDefault();
      e.stopPropagation();
      addChip(input.value);
      input.value = '';
    } else if (e.key === 'Backspace' && !input.value && terms.length) {
      terms.pop();
      chipsWrap.children[chipsWrap.children.length - 2].remove();
    }
  });
  chipsWrap.addEventListener('click', () => input.focus());
  for (const t of prefill?.terms || []) addChip(t);

  const optsRow = document.createElement('div');
  optsRow.className = 'scribe-am-opts';
  const makeCheck = (text, checked) => {
    const lab = document.createElement('label');
    lab.className = 'scribe-am-check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = checked;
    lab.append(box, document.createTextNode(text));
    return { lab, box };
  };
  const whole = makeCheck('Whole words', true);
  const caseSens = makeCheck('Match case', false);
  optsRow.append(whole.lab, caseSens.lab);

  formElem.append(label, chipsWrap, optsRow);

  return {
    formElem,
    focus: () => input.focus(),
    getParams: () => {
      // Typing one term and hitting Run should not need a separate commit, so a term still in the input counts.
      if (input.value.trim()) {
        addChip(input.value);
        input.value = '';
      }
      if (!terms.length) {
        input.focus();
        return null;
      }
      return { terms: [...terms], wholeWords: whole.box.checked, matchCase: caseSens.box.checked };
    },
  };
}

/** @param {?{terms: Array<string>, wholeWords: boolean, matchCase: boolean}} params */
export function describeParams(params) {
  if (!params) return '';
  const opts = [params.wholeWords ? 'whole words' : 'partial words', params.matchCase ? 'match case' : null].filter(Boolean);
  return `${params.terms.join(', ')} · ${opts.join(' · ')} · all pages`;
}

/**
 * @param {import('./registry.js').AutomationHost} host
 * @param {{terms: Array<string>, wholeWords: boolean, matchCase: boolean}} params
 * @param {(frac: number, caption: string) => void} progress
 * @returns {Promise<import('./registry.js').AutomationOutcome>}
 */
export async function run(host, params, progress) {
  const { viewer } = host;
  const doc = viewer.doc;
  // A freshly-opened PDF may still be extracting text, so searching before it settles reports false misses.
  if (doc._textReadySettle) {
    progress(0, 'Waiting for text extraction…');
    await doc.textReady;
    if (viewer.doc !== doc) return { rows: [{ kind: 'info', text: 'The document changed before the run started.' }] };
  }
  const pageCount = doc.pageMetrics.length;
  /** @type {Array<Array<OcrWord>>} */
  const found = [];
  for (let n = 0; n < pageCount; n++) {
    const page = doc.ocr.active[n];
    if (page) {
      for (const term of params.terms) {
        for (const occ of findOccurrences(page, term, params)) found.push(occ);
      }
    }
    progress((n + 1) / pageCount, `Scanning page ${n + 1} of ${pageCount}`);
    // Yield between pages so the progress line paints and the app stays responsive on large documents.
    if (n % 5 === 4) await new Promise((resolve) => { setTimeout(resolve, 0); });
  }

  const occurrences = found.length;
  let marks = 0;
  const pagesHit = new Set();
  let firstHitPage = -1;
  // Staging runs after the scan, in one synchronous pass, so the group fold cannot swallow unrelated edits made during a scan yield.
  doc.docHistory.group('Marked for redaction', () => {
    for (const occ of found) {
      // One call per occurrence, so each occurrence becomes its own deletable mark group.
      const added = redactWords(viewer, occ);
      if (added > 0) {
        marks += added;
        const n = occ[0].line.page.n;
        pagesHit.add(n);
        if (firstHitPage < 0) firstHitPage = n;
      }
    }
  });

  /** @type {Array<import('./registry.js').AutomationOutcomeRow>} */
  const rows = [];
  if (marks > 0) {
    rows.push({ kind: 'ok', text: `${marks} mark${marks === 1 ? '' : 's'} staged across ${pagesHit.size} page${pagesHit.size === 1 ? '' : 's'}` });
  } else if (occurrences > 0) {
    rows.push({ kind: 'info', text: 'Every match was already marked — nothing new to stage' });
  } else {
    rows.push({ kind: 'info', text: `No matches for ${params.terms.map((t) => `"${t}"`).join(', ')}` });
  }
  const review = marks > 0 ? {
    label: 'Review marks',
    onClick: async () => {
      // The comments panel is where mark groups are reviewed.
      if (host.app._activeSidebar !== 'comments') host.app._requestSidebar('comments');
      if (firstHitPage >= 0) await viewer.displayPage(firstHitPage, true, false);
    },
  } : undefined;
  return { rows, review };
}
