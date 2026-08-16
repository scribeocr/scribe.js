// The "Extract highlights to Excel" automation: one spreadsheet row per highlight group.
import scribe from '../../../scribe.js';
import { annotMatchesWord } from '../viewerHighlights.js';

/**
 * The text under one highlight group, read the same way the comments panel quotes it.
 * @param {import('../../viewer.js').ScribeViewer} viewer
 * @param {number} pageIndex
 * @param {Array<AnnotationHighlight>} groupAnns
 */
function highlightText(viewer, pageIndex, groupAnns) {
  const ocrPage = viewer.doc.ocr.active[pageIndex];
  if (!ocrPage || !ocrPage.lines) return '';
  const words = [];
  for (const line of ocrPage.lines) {
    for (const word of line.words) {
      if (groupAnns.some((a) => annotMatchesWord(a, word.bbox, 'highlight'))) words.push(word.text);
    }
  }
  return words.join(' ');
}

const DATE_FMT = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * @param {import('./registry.js').AutomationHost} host
 * @param {?Object} params
 * @param {(frac: number, caption: string) => void} progress
 * @returns {Promise<import('./registry.js').AutomationOutcome>}
 */
export async function run(host, params, progress) {
  const { viewer } = host;
  const doc = viewer.doc;
  if (doc._textReadySettle) {
    progress(0, 'Waiting for text extraction…');
    await doc.textReady;
    if (viewer.doc !== doc) return { rows: [{ kind: 'info', text: 'The document changed before the run started.' }] };
  }
  const pageCount = doc.pageMetrics.length;
  const sheetRows = [['Page', 'Highlighted text', 'Comment', 'Author', 'Date']];
  for (let n = 0; n < pageCount; n++) {
    const pageAnnots = doc.annotations.pages[n] || [];
    /** @type {Map<string, Array<AnnotationHighlight>>} */
    const groups = new Map();
    for (const a of pageAnnots) {
      if ((a.type ?? 'highlight') !== 'highlight' || !('groupId' in a) || !('color' in a)) continue;
      const annot = /** @type {AnnotationHighlight} */ (a);
      if (!groups.has(annot.groupId)) groups.set(annot.groupId, []);
      groups.get(annot.groupId).push(annot);
    }
    for (const members of groups.values()) {
      const withComment = members.find((a) => a.comment);
      const withAuthor = members.find((a) => a.author);
      const withDate = members.find((a) => a.createdAt);
      const when = withDate ? new Date(withDate.createdAt) : null;
      sheetRows.push([
        n + 1,
        highlightText(viewer, n, members),
        withComment ? withComment.comment : '',
        withAuthor ? withAuthor.author : '',
        when && !Number.isNaN(when.getTime()) ? DATE_FMT.format(when) : '',
      ]);
    }
    progress((n + 1) / pageCount, `Reading page ${n + 1} of ${pageCount}`);
    if (n % 10 === 9) await new Promise((resolve) => { setTimeout(resolve, 0); });
  }

  const count = sheetRows.length - 1;
  if (count === 0) return { rows: [{ kind: 'info', text: 'This document has no highlights' }] };

  progress(1, 'Writing spreadsheet…');
  const bytes = await scribe.utils.writeXlsxFromRows(sheetRows, { headerRows: 1, autoFilter: true, columnWidths: 'auto' });
  const fileName = `${host.app._baseName().replace(/\.\w{1,6}$/, '')}-highlights.xlsx`;
  await scribe.utils.saveAs(bytes, fileName);

  return {
    rows: [{
      kind: 'file',
      text: `${fileName} · ${count} highlight${count === 1 ? '' : 's'}`,
      action: { label: 'Download again', onClick: () => scribe.utils.saveAs(bytes, fileName) },
    }],
  };
}
