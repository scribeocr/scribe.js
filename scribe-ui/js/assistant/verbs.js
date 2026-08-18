// Each verb's `run` calls the same document function the UI calls, so its edits land on the ordinary undo timeline.

import scribe from '../../../scribe.js';
import { buildStructuredPageText } from '../../../js/utils/structuredText.js';
import { bboxToPageSpace, TEXT_MARKUP_ANNOT_TYPES } from '../../../js/addHighlights.js';
import { calcBboxUnion } from '../../../js/utils/miscUtils.js';
import { isScanPage } from '../../../js/pdf/ocrPageSelection.js';
import { removeRedactionGroup } from '../viewerRedactions.js';

/** @typedef {import('../automations/registry.js').AutomationHost} AssistantHost */

/**
 * The navigable record of one verb call, rendered in the thread as a row that jumps to its target.
 * @typedef {Object} VerbReceipt
 * @property {string} label
 * @property {number} [page] - Navigation target (0-based).
 * @property {bbox} [bbox] - Passage shown when the receipt navigates, in page coordinates.
 * @property {Array<string>} [wordIds] - The passage's words, for centering and flashing on navigation.
 *   Words that no longer exist (deleted or replaced text) simply degrade navigation to the page.
 * @property {string} [quote] - The text the act verified against the live page.
 * @property {{label: string, run: () => void}} [remove] - The act's ordinary removal, offered on the receipt row.
 *   Runs the same deletion the user could do by hand, recorded on the undo timeline like any edit.
 * @property {VerbBatch} [batch] - Present when a run of consecutive receipts may fold into one batch row.
 */

/**
 * How a run of consecutive receipts folds into one thread row.
 * @typedef {Object} VerbBatch
 * @property {string} key - Receipts fold together only while this matches (e.g. underlines never join a highlight run).
 * @property {number} [units] - This receipt's contribution to the batch count (default 1).
 * @property {(n: number, span: string) => string} label - Batch-row text, e.g. "Highlighted 62 passages · pages 127–130".
 * @property {string} [removeAllLabel] - Undo-timeline label for removing the whole batch as one grouped entry.
 */

/**
 * @typedef {Object} VerbResult
 * @property {Object} result - JSON payload returned to the model as the tool result.
 * @property {boolean} [isError] - True when `result` describes a failure the model should correct, e.g. a quote that no longer matches.
 * @property {VerbReceipt} [receipt]
 */

/**
 * @typedef {Object} VerbEntry
 * @property {string} name
 * @property {string} description - Sent to the model as the tool description.
 * @property {Object} params - JSON schema for the verb's parameters, sent to the model as the tool input schema.
 * @property {0|1|2} tier - Trust tier: 0 = pure UI (read, navigate, find), 1 = reversible document state, 2 = stage-and-stop.
 * @property {(params: Object) => string} [caption] - Working phrasing shown while the verb runs, e.g. "Reading page 3…".
 * @property {(host: AssistantHost, params: Object) => Promise<VerbResult>} run
 */

/** 1-based page label for captions, tolerant of malformed model input. */
const pageLabel = (page) => (Number.isInteger(page) ? String(page + 1) : '?');

/**
 * The page's active text, or a fail-closed error when the index is out of range or the page has no text.
 * @param {import('../../../js/containers/scribeDoc.js').ScribeDoc} doc
 * @param {number} page
 * @returns {{pageObj?: OcrPage, error?: string}}
 */
function requirePage(doc, page) {
  if (!Number.isInteger(page) || page < 0 || page >= doc.pageMetrics.length) {
    return { error: `Page ${page} is out of range; the document has ${doc.pageMetrics.length} pages (0-based).` };
  }
  const pageObj = doc.ocr.active[page];
  if (!pageObj || pageObj.lines.length === 0) return { error: `Page ${page} has no text layer to work with.` };
  return { pageObj };
}

/**
 * Locate an exact quote as runs of consecutive words on a page.
 * @param {OcrPage} pageObj
 * @param {string} quote
 * @param {Object} [opts]
 * @param {number} [opts.startLine] - Line the quote starts on, consulted only when it matches more than once.
 * @param {boolean} [opts.unique] - Require exactly one occurrence; false accepts several.
 * @returns {{ok: true, occurrences: Array<{words: Array<OcrWord>, startLine: number, endLine: number, bbox: bbox}>} | {ok: false, error: string}}
 */
function resolveQuote(pageObj, quote, { startLine, unique = true } = {}) {
  const tokens = String(quote ?? '').trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return { ok: false, error: 'The quote is empty.' };
  const words = scribe.utils.ocr.getPageWords(pageObj);

  /** @type {Array<Array<OcrWord>>} */
  const runs = [];
  for (let i = 0; i <= words.length - tokens.length; i++) {
    const cand = words.slice(i, i + tokens.length);
    if (cand.every((w, j) => w.text === tokens[j])) {
      runs.push(cand);
      i += tokens.length - 1;
    }
  }

  if (runs.length === 0) {
    // A case-only miss gets the live text echoed back, so the model can retry without another read.
    let ciRun = null;
    for (let i = 0; i <= words.length - tokens.length && !ciRun; i++) {
      const cand = words.slice(i, i + tokens.length);
      if (cand.every((w, j) => w.text.toLowerCase() === tokens[j].toLowerCase())) ciRun = cand;
    }
    if (ciRun) {
      return { ok: false, error: `The quote is not on page ${pageObj.n} as written; the page has "${ciRun.map((w) => w.text).join(' ')}". Quote the live text exactly.` };
    }
    return { ok: false, error: `The quote was not found on page ${pageObj.n}. Re-read the page with read_pages and quote its text exactly, including punctuation.` };
  }

  const occurrences = runs.map((run) => ({
    words: run,
    startLine: pageObj.lines.indexOf(run[0].line),
    endLine: pageObj.lines.indexOf(run[run.length - 1].line),
    bbox: calcBboxUnion(run.map((w) => bboxToPageSpace(w.bbox, w.line.orientation, pageObj.dims))),
  }));

  if (unique && occurrences.length > 1) {
    const picked = startLine != null ? occurrences.filter((o) => o.startLine === startLine) : [];
    if (picked.length === 1) return { ok: true, occurrences: picked };
    return { ok: false, error: `The quote appears ${occurrences.length} times on page ${pageObj.n} (starting on lines ${occurrences.map((o) => o.startLine).join(', ')}). Pass startLine to pick one.` };
  }
  return { ok: true, occurrences };
}

/**
 * Verify that `quote` reproduces the complete current text of lines start..end.
 * A whole-line mutation can then never remove text the model did not cite.
 * @param {OcrPage} pageObj
 * @param {number} start
 * @param {number} end
 * @param {string} quote
 * @returns {{lines?: Array<OcrLine>, words?: Array<OcrWord>, bbox?: bbox, error?: string}}
 */
function verifyLineRange(pageObj, start, end, quote) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= pageObj.lines.length) {
    return { error: `Line range ${start}–${end} is invalid; page ${pageObj.n} has ${pageObj.lines.length} lines (0-based).` };
  }
  const lines = pageObj.lines.slice(start, end + 1);
  const words = lines.flatMap((l) => l.words);
  const current = words.map((w) => w.text).join(' ');
  const given = String(quote ?? '').trim().split(/\s+/).join(' ');
  if (current !== given) {
    return { error: `The quote does not match the current text of lines ${start}–${end} on page ${pageObj.n}, which read: "${current}". Quote those lines exactly, or adjust the line range.` };
  }
  const bbox = calcBboxUnion(words.map((w) => bboxToPageSpace(w.bbox, w.line.orientation, pageObj.dims)));
  return { lines, words, bbox };
}

/**
 * Bring a run of words into view, optionally flashing it in the find bar's active-match style.
 * @param {import('../../viewer.js').ScribeViewer} viewer
 * @param {number} page
 * @param {Array<OcrWord>} words
 * @param {boolean} flash
 */
async function showWords(viewer, page, words, flash) {
  await viewer.displayPage(page, false, false);
  const ids = new Set(words.map((w) => w.id));
  const targets = viewer.getUiWords().filter((kw) => ids.has(kw.word.id));
  if (targets.length === 0) {
    await viewer.displayPage(page, true, false);
    return;
  }
  // `getClientRect` is in content space; multiply by zoom to get the on-screen offset from the scroll origin.
  const rect = targets[0].getClientRect();
  const margin = 30;
  const sc = viewer.scrollContainer;
  const zoom = viewer.zoomLevel || 1;
  sc.scrollTop = (rect.y + rect.height / 2) * zoom - sc.clientHeight / 2;
  const leftPx = rect.x * zoom - sc.scrollLeft;
  const rightPx = (rect.x + rect.width) * zoom - sc.scrollLeft;
  if (rightPx > sc.clientWidth - margin) sc.scrollLeft += rightPx - (sc.clientWidth - margin);
  else if (leftPx < margin) sc.scrollLeft -= margin - leftPx;
  viewer.updateCurrentPage();
  if (flash) {
    for (const kw of targets) kw.activeMatch = true;
    setTimeout(() => { for (const kw of targets) kw.activeMatch = false; }, 1200);
  }
}

/**
 * Navigate the viewer to a receipt's target: its passage when the words still exist, else its page.
 * @param {import('../../viewer.js').ScribeViewer} viewer
 * @param {VerbReceipt} receipt
 */
export async function navigateToReceipt(viewer, receipt) {
  if (receipt.page == null) return;
  const pageObj = viewer.doc?.ocr.active[receipt.page];
  if (pageObj && receipt.wordIds?.length) {
    const ids = new Set(receipt.wordIds);
    const words = scribe.utils.ocr.getPageWords(pageObj).filter((w) => ids.has(w.id));
    if (words.length > 0) {
      await showWords(viewer, receipt.page, words, true);
      return;
    }
  }
  await viewer.displayPage(receipt.page, true, false);
}

/**
 * Refresh pages whose native text changed.
 * @param {import('../../viewer.js').ScribeViewer} viewer
 * @param {Array<number>} pages
 */
function refreshEditedPages(viewer, pages) {
  // These are the refreshes the Edit Text tool runs after its own commit, so a surface added there belongs here too.
  for (const n of new Set(pages)) {
    viewer.refreshPageRaster(n);
    viewer.renderWords(n);
    viewer.renderHighlights?.(n);
    if (viewer.textSel) {
      viewer.textSel.invalidatePage(n);
      viewer.textSel.renderPage(n);
    }
  }
  if (viewer.onEditCallback) viewer.onEditCallback();
}

/** @type {Array<VerbEntry>} */
export const VERBS = [
  {
    name: 'get_overview',
    description: 'Overview of the open document: page count, per-page text line counts, scanned pages with no readable text, and the bookmark outline. '
      + 'Page indices are 0-based everywhere. Call this before reading an unfamiliar document.',
    params: { type: 'object', properties: {} },
    tier: 0,
    caption: () => 'Reading the document overview…',
    run: async (host) => {
      const doc = host.viewer.doc;
      const pageCount = doc.pageMetrics.length;
      const lineCounts = [];
      for (let n = 0; n < pageCount; n++) lineCounts.push(doc.ocr.active[n]?.lines.length || 0);
      const stats = doc.inputData.pageStats;
      const scanPages = [];
      if (stats) {
        for (let n = 0; n < pageCount; n++) {
          if (stats[n] && isScanPage(stats[n])) scanPages.push(n);
        }
      }
      /** @type {Array<{title: string, page: ?number, depth: number}>} */
      const outline = [];
      const walk = (nodes, depth) => {
        for (const node of nodes) {
          outline.push({ title: node.title, page: node.dest ? node.dest.pageIndex : null, depth });
          walk(node.children, depth + 1);
        }
      };
      walk(doc.outline, 0);
      return {
        result: {
          pageCount, lineCounts, scanPages, outline,
        },
        receipt: { label: 'Read the document overview' },
      };
    },
  },
  {
    name: 'read_pages',
    description: 'Read the document text as "page:line  text" rows with paragraph and footnote annotations. '
      + 'Reads from startPage until maxChars (default 20000) fills or endPage is reached; the result reports where it stopped. '
      + 'Page and line indices are 0-based and are the addresses every other tool uses.',
    params: {
      type: 'object',
      properties: {
        startPage: { type: 'integer', description: 'First page to read (0-based).' },
        endPage: { type: 'integer', description: 'Last page to read (0-based, inclusive). Defaults to the last page.' },
        maxChars: { type: 'integer', description: 'Stop after roughly this many characters (default 20000).' },
      },
      required: ['startPage'],
    },
    tier: 0,
    caption: (p) => (p.endPage === p.startPage ? `Reading page ${pageLabel(p.startPage)}…` : `Reading from page ${pageLabel(p.startPage)}…`),
    run: async (host, params) => {
      const doc = host.viewer.doc;
      const pageCount = doc.pageMetrics.length;
      const start = params.startPage;
      if (!Number.isInteger(start) || start < 0 || start >= pageCount) {
        return { isError: true, result: { error: `startPage ${start} is out of range; the document has ${pageCount} pages (0-based).` } };
      }
      const last = Math.min(Number.isInteger(params.endPage) ? params.endPage : pageCount - 1, pageCount - 1);
      const limit = params.maxChars || 20000;
      let text = '';
      let endPage = start;
      for (let p = start; p <= last; p++) {
        const pageText = buildStructuredPageText(doc, p, { parAnnots: true, footnoteAnnots: true });
        if (text.length > 0 && text.length + pageText.length > limit) break;
        text += pageText;
        endPage = p;
      }
      return {
        result: {
          startPage: start, endPage, hasMore: endPage < last, pageCount, text,
        },
        receipt: { label: endPage === start ? `Read page ${start + 1}` : `Read pages ${start + 1}–${endPage + 1}`, page: start },
      };
    },
  },
  {
    name: 'search_document',
    description: 'Find every occurrence of a phrase across the whole document (case-insensitive, consecutive words in reading order). '
      + 'Returns up to 50 matches as {page, line, lineText}. Use find_text instead when the user should see the matches in the find bar.',
    params: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    tier: 0,
    caption: (p) => `Searching for "${p.query}"…`,
    run: async (host, params) => {
      const doc = host.viewer.doc;
      const query = String(params.query ?? '').trim();
      if (!query) return { isError: true, result: { error: 'query is empty.' } };
      const matches = scribe.utils.ocr.getDocMatches(query, doc.ocr.active);
      const capped = matches.slice(0, 50);
      /** @type {Map<number, Map<string, OcrWord>>} */
      const wordsById = new Map();
      /** @type {Array<{page: number, line: number, lineText: string}>} */
      const rows = [];
      for (const m of capped) {
        const pageObj = doc.ocr.active[m.pageN];
        if (!wordsById.has(m.pageN)) {
          const byId = new Map();
          for (const w of scribe.utils.ocr.getPageWords(pageObj)) byId.set(w.id, w);
          wordsById.set(m.pageN, byId);
        }
        const anchor = wordsById.get(m.pageN).get(m.wordIds[0]);
        if (!anchor) continue;
        rows.push({
          page: m.pageN,
          line: pageObj.lines.indexOf(anchor.line),
          lineText: anchor.line.words.map((w) => w.text).join(' '),
        });
      }
      return {
        result: { totalMatches: matches.length, truncated: matches.length > capped.length, matches: rows },
        receipt: { label: `Searched for "${query}" (${matches.length} match${matches.length === 1 ? '' : 'es'})` },
      };
    },
  },
  {
    name: 'go_to_page',
    description: 'Scroll the viewer to a page (0-based).',
    params: {
      type: 'object',
      properties: { page: { type: 'integer' } },
      required: ['page'],
    },
    tier: 0,
    caption: (p) => `Going to page ${pageLabel(p.page)}…`,
    run: async (host, params) => {
      const doc = host.viewer.doc;
      const page = params.page;
      if (!Number.isInteger(page) || page < 0 || page >= doc.pageMetrics.length) {
        return { isError: true, result: { error: `Page ${page} is out of range; the document has ${doc.pageMetrics.length} pages (0-based).` } };
      }
      await host.viewer.displayPage(page, true, false);
      return { result: { page }, receipt: { label: `Went to page ${page + 1}`, page } };
    },
  },
  {
    name: 'show_passage',
    description: 'Scroll to a passage and flash it briefly, without changing the document. '
      + 'quote must reproduce the live text exactly (case and punctuation); pass startLine when it appears more than once on the page.',
    params: {
      type: 'object',
      properties: {
        page: { type: 'integer', description: '0-based page index.' },
        quote: { type: 'string', description: 'Exact text of the passage.' },
        startLine: { type: 'integer', description: '0-based line the passage starts on; needed only when the quote is ambiguous.' },
      },
      required: ['page', 'quote'],
    },
    tier: 0,
    caption: (p) => `Showing a passage on page ${pageLabel(p.page)}…`,
    run: async (host, params) => {
      const got = requirePage(host.viewer.doc, params.page);
      if (got.error) return { isError: true, result: { error: got.error } };
      const res = resolveQuote(got.pageObj, params.quote, { startLine: params.startLine });
      if (!res.ok) return { isError: true, result: { error: res.error } };
      const occ = res.occurrences[0];
      await showWords(host.viewer, params.page, occ.words, true);
      return {
        result: { page: params.page, startLine: occ.startLine, endLine: occ.endLine },
        receipt: {
          label: `Showed a passage on page ${params.page + 1}`, page: params.page, bbox: occ.bbox, wordIds: occ.words.map((w) => w.id),
        },
      };
    },
  },
  {
    name: 'find_text',
    description: "Run the viewer's find bar on a phrase the user should see for themselves: opens the bar, highlights every match, and jumps to the first. "
      + "Matching is the find bar's own (case-insensitive, across consecutive words).",
    params: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    tier: 0,
    caption: (p) => `Finding "${p.query}"…`,
    run: async (host, params) => {
      const query = String(params.query ?? '').trim();
      if (!query) return { isError: true, result: { error: 'query is empty.' } };
      if (host.app.searchInputElem) host.app.searchInputElem.value = query;
      host.app.openSearch();
      await host.app.runSearch(query);
      const { matchList } = host.viewer._searchState;
      const pages = [...new Set(matchList.map((m) => m.pageN))];
      return {
        result: { totalMatches: matchList.length, pages },
        receipt: { label: `Found ${matchList.length} match${matchList.length === 1 ? '' : 'es'} for "${query}"`, page: pages[0] },
      };
    },
  },
  {
    name: 'add_highlight',
    description: 'Highlight, underline, or strike out an exact passage, optionally with a comment. '
      + 'quote must reproduce the live text exactly; on a mismatch nothing changes and the error says why. '
      + 'The result is ordinary markup the user can undo or remove.',
    params: {
      type: 'object',
      properties: {
        page: { type: 'integer', description: '0-based page index.' },
        quote: { type: 'string', description: 'Exact text of the passage.' },
        startLine: { type: 'integer', description: '0-based line the passage starts on; needed only when the quote is ambiguous.' },
        comment: { type: 'string' },
        markup: { type: 'string', enum: ['highlight', 'underline', 'strikeout'] },
        color: { type: 'string', description: 'Hex color like #ffe93b.' },
      },
      required: ['page', 'quote'],
    },
    tier: 1,
    caption: (p) => `${p.markup === 'underline' ? 'Underlining' : p.markup === 'strikeout' ? 'Striking out' : 'Highlighting'} a passage on page ${pageLabel(p.page)}…`,
    run: async (host, params) => {
      const doc = host.viewer.doc;
      const got = requirePage(doc, params.page);
      if (got.error) return { isError: true, result: { error: got.error } };
      const res = resolveQuote(got.pageObj, params.quote, { startLine: params.startLine });
      if (!res.ok) return { isError: true, result: { error: res.error } };
      const occ = res.occurrences[0];
      await showWords(host.viewer, params.page, occ.words, false);
      const out = doc.addHighlights([{
        page: params.page,
        startLine: occ.startLine,
        endLine: occ.endLine,
        text: params.quote,
        comment: params.comment,
        markup: params.markup,
        color: params.color,
      }]);
      host.viewer.renderHighlights?.(params.page);
      host.viewer._rebuildCommentsPanel?.();
      const verb = params.markup === 'underline' ? 'Underlined' : params.markup === 'strikeout' ? 'Struck out' : 'Highlighted';
      const group = out.groups[0];
      return {
        result: {
          page: params.page, startLine: occ.startLine, endLine: occ.endLine, highlightsApplied: out.highlightsApplied,
        },
        receipt: {
          label: `${verb} a passage on page ${params.page + 1}`,
          page: params.page,
          bbox: group ? group.bbox : occ.bbox,
          wordIds: occ.words.map((w) => w.id),
          quote: params.quote,
          batch: {
            key: params.markup === 'underline' ? 'underline' : params.markup === 'strikeout' ? 'strikeout' : 'highlight',
            label: (n, span) => `${verb} ${n} passages${span ? ` · ${span}` : ''}`,
            removeAllLabel: params.markup === 'underline' || params.markup === 'strikeout' ? 'Removed markup' : 'Removed highlights',
          },
          remove: group ? {
            label: 'Remove',
            run: () => {
              const undoSnap = doc.docHistory.snapshotAnnots(doc.annotations, [params.page]);
              doc.annotations.pages[params.page] = doc.annotations.pages[params.page]
                .filter((a) => a.groupId !== group.groupId || !TEXT_MARKUP_ANNOT_TYPES.has(a.type ?? 'highlight'));
              doc.docHistory.recordAnnots(undoSnap, params.markup === 'underline' || params.markup === 'strikeout' ? 'Removed markup' : 'Removed highlight');
              host.viewer.renderHighlights?.(params.page);
              host.viewer._rebuildCommentsPanel?.();
            },
          } : undefined,
        },
      };
    },
  },
  {
    name: 'delete_text',
    description: 'Delete whole lines of text the PDF itself draws visibly (born-digital text; OCR text cannot be edited). '
      + 'quote must reproduce the complete current text of every line in the range, exactly; on a mismatch nothing is deleted and the error reports the live text. '
      + 'Undoable.',
    params: {
      type: 'object',
      properties: {
        page: { type: 'integer', description: '0-based page index.' },
        startLine: { type: 'integer', description: 'First line to delete (0-based).' },
        endLine: { type: 'integer', description: 'Last line to delete (inclusive). Defaults to startLine.' },
        quote: { type: 'string', description: 'The complete text of every line in the range.' },
      },
      required: ['page', 'startLine', 'quote'],
    },
    tier: 1,
    caption: (p) => `Deleting lines on page ${pageLabel(p.page)}…`,
    run: async (host, params) => {
      const doc = host.viewer.doc;
      const got = requirePage(doc, params.page);
      if (got.error) return { isError: true, result: { error: got.error } };
      const check = verifyLineRange(got.pageObj, params.startLine, Number.isInteger(params.endLine) ? params.endLine : params.startLine, params.quote);
      if (check.error) return { isError: true, result: { error: check.error } };
      await showWords(host.viewer, params.page, check.words, false);
      const out = doc.deleteTextLines(check.lines);
      refreshEditedPages(host.viewer, out.pages);
      return {
        result: { page: params.page, deletedLines: check.lines.length },
        receipt: { label: `Deleted ${check.lines.length} line${check.lines.length === 1 ? '' : 's'} on page ${params.page + 1}`, page: params.page, bbox: check.bbox },
      };
    },
  },
  {
    name: 'replace_text',
    description: 'Replace one line of text the PDF itself draws visibly (born-digital text; OCR text cannot be edited). '
      + "quote must reproduce the line's complete current text exactly; newText becomes the line's text (empty deletes the line). Undoable.",
    params: {
      type: 'object',
      properties: {
        page: { type: 'integer', description: '0-based page index.' },
        line: { type: 'integer', description: '0-based line index.' },
        quote: { type: 'string', description: "The line's complete current text." },
        newText: { type: 'string' },
      },
      required: ['page', 'line', 'quote', 'newText'],
    },
    tier: 1,
    caption: (p) => `Editing a line on page ${pageLabel(p.page)}…`,
    run: async (host, params) => {
      const doc = host.viewer.doc;
      const got = requirePage(doc, params.page);
      if (got.error) return { isError: true, result: { error: got.error } };
      const check = verifyLineRange(got.pageObj, params.line, params.line, params.quote);
      if (check.error) return { isError: true, result: { error: check.error } };
      await showWords(host.viewer, params.page, check.words, false);
      const out = await doc.replaceTextLine(check.lines[0], String(params.newText ?? ''));
      if (!out) return { result: { page: params.page, line: params.line, unchanged: true } };
      refreshEditedPages(host.viewer, out.pages);
      return {
        result: { page: params.page, line: params.line },
        receipt: { label: `Edited a line on page ${params.page + 1}`, page: params.page, bbox: check.bbox },
      };
    },
  },
  {
    name: 'redact_text',
    description: 'Stage redaction marks over every occurrence of an exact quote on a page. '
      + 'Marks are reviewable annotations, undoable and deletable until export; every export then removes the marked content. '
      + 'quote must exist on the page exactly as written; occurrence matching is case-insensitive.',
    params: {
      type: 'object',
      properties: {
        page: { type: 'integer', description: '0-based page index.' },
        quote: { type: 'string', description: 'Exact text to mark for redaction.' },
      },
      required: ['page', 'quote'],
    },
    tier: 1,
    caption: (p) => `Staging redaction marks on page ${pageLabel(p.page)}…`,
    run: async (host, params) => {
      const doc = host.viewer.doc;
      const got = requirePage(doc, params.page);
      if (got.error) return { isError: true, result: { error: got.error } };
      const res = resolveQuote(got.pageObj, params.quote, { unique: false });
      if (!res.ok) return { isError: true, result: { error: res.error } };
      await showWords(host.viewer, params.page, res.occurrences[0].words, false);
      const out = doc.addRedactions([{ page: params.page, text: params.quote }]);
      host.viewer.renderRedactions?.(params.page);
      host.viewer._rebuildCommentsPanel?.();
      const groupIds = out.groups.map((g) => g.groupId);
      return {
        result: { page: params.page, occurrencesMarked: out.groups.length },
        receipt: {
          label: `Staged ${out.groups.length} redaction mark${out.groups.length === 1 ? '' : 's'} on page ${params.page + 1}`,
          page: params.page,
          bbox: res.occurrences[0].bbox,
          wordIds: res.occurrences[0].words.map((w) => w.id),
          quote: params.quote,
          batch: {
            key: 'redact',
            units: out.groups.length,
            label: (n, span) => `Staged ${n} redaction marks${span ? ` · ${span}` : ''}`,
            removeAllLabel: 'Removed redaction marks',
          },
          remove: out.groups.length ? {
            label: 'Remove marks',
            run: () => {
              doc.docHistory.group('Removed redaction marks', () => {
                for (const gid of groupIds) removeRedactionGroup(host.viewer, gid);
              });
            },
          } : undefined,
        },
      };
    },
  },
];

/**
 * Look up and run one verb.
 * Never throws: every failure comes back as an error result.
 * @param {AssistantHost} host
 * @param {string} name
 * @param {Object} params
 * @returns {Promise<VerbResult>}
 */
export async function runVerb(host, name, params) {
  const entry = VERBS.find((v) => v.name === name);
  if (!entry) return { isError: true, result: { error: `Unknown tool: ${name}` } };
  const doc = host.viewer.doc;
  if (!doc || doc.pageMetrics.length === 0) return { isError: true, result: { error: 'No document is open.' } };
  // A freshly-opened PDF may still be extracting text, so reading or matching before it settles reports false misses.
  if (doc._textReadySettle) await doc.textReady;
  if (host.viewer.doc !== doc) return { isError: true, result: { error: 'The document changed before the tool ran.' } };
  try {
    return await entry.run(host, params || {});
  } catch (e) {
    return { isError: true, result: { error: e instanceof Error ? e.message : String(e) } };
  }
}
