import { scribeDocDefaults } from '../containers/scribeDocDefaults.js';
import { calcWordMetrics } from '../utils/fontUtils.js';
import ocr, { parIsFurniture, parMarkerInText } from '../objects/ocrObjects.js';
import { assignParagraphs, hyphenatedCompounds, lineJoin } from '../utils/reflowPars.js';
import { extractTableContent } from '../extractTables.js';
import { calcTableBbox } from '../objects/layoutObjects.js';
import { calcBoxOverlap } from '../utils/miscUtils.js';

const formatNum = (num) => (num.toFixed(5).replace(/\.?0+$/, ''));

const LINE_END_HYPHEN_RE = /[-‐­]$/;

export const ARTICLE_RULES = `  .scribe-article {
    position:relative;
    box-sizing:border-box;
    max-width:720px;
    margin:0 auto;
    padding:56px 24px 96px;
    font-family:Charter,Georgia,'Times New Roman',serif;
    font-size:19px;
    line-height:1.65;
    color:#1a1a1a;
    overflow-wrap:break-word;
  }
  .scribe-article h1 {
    font-size:2.1em;
    line-height:1.15;
    letter-spacing:-.01em;
    margin:0 0 .6em;
  }
  .scribe-article h1 ~ h1, .scribe-article h2 {
    font-size:1.45em;
    line-height:1.25;
    letter-spacing:0;
    margin:1.8em 0 .5em;
  }
  .scribe-article h3 {
    font-size:1.2em;
    line-height:1.3;
    margin:1.5em 0 .4em;
  }
  .scribe-article h4, .scribe-article h5, .scribe-article h6 {
    font-size:1.05em;
    margin:1.3em 0 .3em;
  }
  .scribe-article p {
    margin:0 0 1.25em;
  }
  .scribe-article ul, .scribe-article ol {
    margin:0 0 1.25em;
    padding-left:1.6em;
  }
  .scribe-article li {
    margin:0 0 .4em;
  }
  .scribe-article li > ul, .scribe-article li > ol {
    margin:.4em 0 0;
  }
  .scribe-article blockquote {
    margin:0 0 1.25em;
    padding:0 0 0 1.2em;
    border-left:3px solid #d9d9d9;
    color:#444;
  }
  .scribe-article blockquote p {
    margin:0;
  }
  .scribe-article pre {
    margin:0 0 1.25em;
    padding:1em 1.2em;
    background:#f5f5f3;
    border-radius:6px;
    font:.82em/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    overflow-x:auto;
  }
  .scribe-article .scribe-table {
    margin:0 0 1.5em;
    overflow-x:auto;
  }
  .scribe-article table {
    width:100%;
    border-collapse:collapse;
    font-size:.9em;
    line-height:1.4;
  }
  .scribe-article th {
    padding:.55em .7em;
    border-bottom:2px solid #c9c9c9;
    text-align:left;
    vertical-align:bottom;
  }
  .scribe-article td {
    padding:.55em .7em;
    border-bottom:1px solid #e4e4e4;
    vertical-align:top;
  }
  .scribe-article .scribe-page-header, .scribe-article .scribe-page-footer, .scribe-article .scribe-page-number, .scribe-article .scribe-line-number {
    font-size:.8em;
    color:#777;
  }
  .scribe-article .scribe-fnref a, .scribe-article .scribe-fnback {
    text-decoration:none;
  }
  .scribe-article .scribe-notes {
    margin-top:3em;
    padding-top:1.2em;
    border-top:1px solid #ddd;
    font-size:.85em;
    color:#444;
  }
  .scribe-article .scribe-notes ol {
    list-style:none;
    padding-left:0;
  }
  .scribe-article .scribe-notes li {
    margin:0 0 .6em;
  }
  .scribe-article .scribe-fnlabel {
    font-weight:700;
    margin-right:.4em;
  }
  @media (max-width:600px) {
    .scribe-article {
      font-size:17px;
      padding:32px 18px 64px;
    }
  }
`;

/**
 * Calculate the font metrics for a given font and font size.
 * This is used to get metrics that match `ctx.measureText`, but without requiring a canvas.
 * @param {FontContainerFont} fontI
 * @param {number} fontSize
 */
const calcFontMetrics = (fontI, fontSize) => {
  const os2 = fontI.opentype.tables.os2;
  const unitsPerEm = fontI.opentype.unitsPerEm;

  // Bit 7: Use_Typo_Metrics (1 = Yes)
  if (os2.fsSelection >> 7 & 1) {
    return {
      fontBoundingBoxAscent: Math.round(os2.sTypoAscender * (fontSize / unitsPerEm)),
      fontBoundingBoxDescent: Math.abs(Math.round(os2.sTypoDescender * (fontSize / unitsPerEm))),
    };
  }

  return {
    fontBoundingBoxAscent: Math.round(os2.usWinAscent * (fontSize / unitsPerEm)),
    fontBoundingBoxDescent: Math.round(os2.usWinDescent * (fontSize / unitsPerEm)),
  };
};

/**
 *
 * @param {string} text
 * @param {number} fontSizeHTMLSmallCaps
 */
const makeSmallCapsDivs = (text, fontSizeHTMLSmallCaps) => {
  const textDivs0 = text.match(/([a-z]+)|([^a-z]+)/g);
  if (!textDivs0) return '';
  const textDivs = textDivs0.map((x) => {
    const lower = /[a-z]/.test(x);
    const styleStr = lower ? `style="font-size:${fontSizeHTMLSmallCaps}px"` : '';
    return `<span class="input-sub" ${styleStr}>${x}</span>`;
  });
  return textDivs.join('');
};

/**
 * Write the pages as the HTML file's body and its stylesheet rules, without the file's head and font faces.
 *
 * @param {Object} params
 * @param {Array<OcrPage>} params.ocrPages -
 * @param {Array<ImageWrapper>} [params.images] -
 * @param {?Array<import('../objects/layoutObjects.js').LayoutDataTablePage>} [params.layoutPageArr] - Table layout data per page, for the article's tables.
 * @param {?Array<number>} [params.pageArr=null] - Array of 0-based page indices to include. Overrides minpage/maxpage when provided.
 * @param {number} [params.minpage=0] - The first page to include in the document.
 * @param {number} [params.maxpage=-1] - The last page to include in the document.
 * @param {boolean} [params.reflowText=false] - Write the text as an article that reflows to the window, instead of each page's exact layout.
 * @param {boolean} [params.dropPageHeadersFooters=false] - Leave page headers and footers, with page numbers and margin line numbers, out of the article.
 * @param {boolean} [params.removeMargins=false] - Remove the margins from the text.
 * @param {?Array<string>} [params.wordIds] - An array of word IDs to include in the document.
 *    If omitted, all words are included.
 * @param {import('../containers/fontContainer.js').DocFonts} [params.docFonts] - Per-document fonts.
 *    Required; no active-document fallback.
 * @param {Array<PageMetrics>} [params.pageMetrics] - This document's page metrics. Required.
 * @param {('invis'|'ebook'|'eval'|'proof'|'annot')} [params.displayMode] - Defaults to `scribeDocDefaults.displayMode`.
 * @param {number} [params.confThreshHigh] - Defaults to `scribeDocDefaults.confThreshHigh`.
 * @param {number} [params.confThreshMed] - Defaults to `scribeDocDefaults.confThreshMed`.
 * @param {number} [params.overlayOpacity] - Defaults to `scribeDocDefaults.overlayOpacity`.
 * @param {boolean} [params.kerning] - Defaults to `scribeDocDefaults.kerning`.
 * @param {boolean} [params.autoRotate] - Whether the page images are deskewed, in which case the text is not turned by the page's angle.
 *    Defaults to `scribeDocDefaults.autoRotate`.
 * @param {boolean} [params.parIds=false] - Mark each line of the exact layout with its paragraph's id, as `data-par`.
 *    Mark each block of the article with its paragraph's id and page, as `data-par` and `data-page`.
 * @param {boolean} [params.runFonts=false] - Mark each run of the article with the font its words record, as `data-font`.
 * @param {?import('../containers/scribeDoc.js').ScribeDoc} [params.doc=null] - Owning document for
 *    progress reporting.
 * @returns {{body: string, style: string, fontsUsed: Set<FontContainerFont>, title?: string}} The body's markup, the stylesheet rules, the fonts the markup names, and the article's title.
 */
export function writeHtmlFragment({
  ocrPages, images, layoutPageArr = null, pageArr = null, minpage = 0, maxpage = -1,
  reflowText = false, dropPageHeadersFooters = false, removeMargins = false, wordIds = null, docFonts, pageMetrics,
  displayMode = scribeDocDefaults.displayMode,
  confThreshHigh = scribeDocDefaults.confThreshHigh,
  confThreshMed = scribeDocDefaults.confThreshMed,
  overlayOpacity = scribeDocDefaults.overlayOpacity,
  kerning = scribeDocDefaults.kerning,
  autoRotate = scribeDocDefaults.autoRotate,
  parIds = false,
  runFonts = false,
  doc = null,
}) {
  /** @type {Set<FontContainerFont>} */
  const fontsUsed = new Set();
  const fonts = docFonts;
  const pageMetricsArr = pageMetrics;

  if (!pageArr) {
    if (maxpage === -1) maxpage = ocrPages.length - 1;
    pageArr = [];
    for (let i = minpage; i <= maxpage; i++) pageArr.push(i);
  }

  if (reflowText) {
    const esc = ocr.escapeXml;
    const compounds = hyphenatedCompounds(ocrPages);
    // A marker can appear before its definition, so which footnotes become notes is settled before any block is written.
    /** @type {Map<string, string>} */
    const fnLabelById = new Map();
    for (const g of pageArr) {
      if (!ocrPages[g]) continue;
      for (const par of ocrPages[g].pars) {
        if (par.type === 'footnote' && par.marker && /^[^\s\]]+$/.test(par.marker) && !parMarkerInText(par)) fnLabelById.set(par.id, par.marker);
      }
    }
    const referenced = new Set();
    /**
     * Write lines of words as inline markup.
     * @param {Array<{words: Array<?OcrWord>}>} lines
     */
    const inline = (lines, { plainBold = false } = {}) => {
      let out = '';
      let runKey = '';
      let run = '';
      const closeRun = () => {
        if (!run) return;
        let s = run;
        const [flags, font] = runKey.split('|');
        if (flags.includes('b')) s = `<b>${s}</b>`;
        if (flags.includes('i')) s = `<i>${s}</i>`;
        if (flags.includes('s')) s = `<sup>${s}</sup>`;
        if (font) s = `<span data-font="${esc(font)}">${s}</span>`;
        out += s;
        run = '';
      };
      let prevJoin = false;
      for (let li = 0; li < lines.length; li++) {
        const { joinNext, dropHyphen } = lines[li + 1] ? lineJoin(lines[li], lines[li + 1], compounds) : { joinNext: false, dropHyphen: false };
        const words = lines[li].words.filter((w) => !!w && !!w.text && (!wordIds || wordIds.includes(w.id)));
        for (let i = 0; i < words.length; i++) {
          const word = words[i];
          const sep = (li === 0 && i === 0) || (i === 0 && prevJoin) ? '' : ' ';
          const label = word.footnoteParId ? fnLabelById.get(word.footnoteParId) : undefined;
          if (label !== undefined && word.text === label && word.footnoteParId) {
            closeRun();
            runKey = '';
            const first = !referenced.has(word.footnoteParId);
            referenced.add(word.footnoteParId);
            out += `${sep}<sup class="scribe-fnref"><a href="#scribe-fn-${word.footnoteParId}"${first ? ` id="scribe-fnref-${word.footnoteParId}"` : ''}>${esc(label)}</a></sup>`;
            continue;
          }
          const text = i === words.length - 1 && dropHyphen ? word.text.replace(LINE_END_HYPHEN_RE, '') : word.text;
          const segments = ocr.getWordStyleSegments(word) || [{ start: 0, end: text.length, style: word.style }];
          for (let k = 0; k < segments.length; k++) {
            const segment = segments[k];
            const piece = text.slice(segment.start, segment.end);
            if (!piece) continue;
            const key = `${segment.style?.bold && !plainBold ? 'b' : ''}${segment.style?.italic ? 'i' : ''}${segment.style?.sup ? 's' : ''}${runFonts && segment.style?.font ? `|${segment.style.font}` : ''}`;
            const lead = k === 0 ? sep : '';
            if (key === runKey) {
              run += lead + esc(piece);
              continue;
            }
            closeRun();
            out += lead;
            runKey = key;
            run = esc(piece);
          }
        }
        prevJoin = joinNext;
      }
      closeRun();
      return out;
    };

    let body = '<article class="scribe-article">\n';
    let title = '';
    /** @type {Array<{depth: number, tag: string, item: boolean}>} */
    const openLists = [];
    /** @param {number} depth */
    const closeLists = (depth) => {
      while (openLists.length > 0 && openLists[openLists.length - 1].depth >= depth) {
        const list = /** @type {{depth: number, tag: string, item: boolean}} */ (openLists.pop());
        body += `${list.item ? '</li>\n' : ''}</${list.tag}>\n`;
      }
    };
    /** @type {Array<{id: string, label: string, html: string, n: number}>} */
    const notes = [];
    let pageN = 0;
    /** @type {Array<number>} The left edges the page's list items start at, one per nesting depth. */
    let depthLefts = [];
    /** @param {?OcrPar} par */
    const attrs = (par) => (parIds ? `${par ? ` data-par="${par.id}"` : ''} data-page="${pageN}"` : '');
    /** @type {Array<OcrLine>} The lines of the paragraph being written. */
    let parLines = [];
    const writePar = () => {
      if (parLines.length === 0) return;
      const lines = parLines;
      parLines = [];
      const { par } = lines[0];
      if (par && par.debug.sourceStyle === 'HTMLPreformatted') {
        closeLists(0);
        const text = lines.map((line) => line.words.filter((w) => !!w).map((w) => esc(w.text)).join(' ')).join('\n');
        body += `<pre${attrs(par)}><code>${text}</code></pre>\n`;
        return;
      }
      if (par && par.type === 'title') {
        closeLists(0);
        const level = Math.min(Math.max(par.headingLevel || 1, 1), 6);
        if (!title) title = lines.flatMap((line) => line.words.map((w) => w.text)).join(' ');
        body += `<h${level}${attrs(par)}>${inline(lines, { plainBold: true })}</h${level}>\n`;
        return;
      }
      if (par && par.type === 'blockquote') {
        closeLists(0);
        const marker = par.marker && !parMarkerInText(par) ? `${esc(par.marker)} ` : '';
        body += `<blockquote${attrs(par)}><p>${marker}${inline(lines)}</p></blockquote>\n`;
        return;
      }
      if (par && fnLabelById.has(par.id)) {
        closeLists(0);
        notes.push({
          id: par.id, label: /** @type {string} */ (fnLabelById.get(par.id)), html: inline(lines), n: pageN,
        });
        return;
      }
      if (par && par.marker && !parMarkerInText(par)) {
        const { marker } = par;
        const numbered = /^\d+[.)]$/.test(marker);
        const tag = numbered ? 'ol' : 'ul';
        let depth = 0;
        for (let d = 1; d < depthLefts.length && depthLefts[d] <= par.bbox.left + 5; d++) depth = d;
        depth = Math.min(depth, 3);
        closeLists(depth + 1);
        let top = openLists[openLists.length - 1];
        if (top && top.depth === depth && top.tag !== tag) {
          closeLists(depth);
          top = openLists[openLists.length - 1];
        }
        if (top && top.depth === depth) {
          body += '</li>\n';
          top.item = false;
        } else {
          // A deeper list nests inside the open item above it.
          if (top && top.item) body += '\n';
          openLists.push({ depth, tag, item: false });
          top = openLists[openLists.length - 1];
          body += `<${tag}>\n`;
        }
        const value = numbered ? ` value="${parseInt(marker, 10)}"` : '';
        const glyph = marker === '☐' || marker === '☑' ? `${marker} ` : '';
        const markerAttr = glyph ? '' : ` data-marker="${esc(marker)}"`;
        body += `<li${value}${markerAttr}${attrs(par)}>${glyph}${inline(lines)}`;
        top.item = true;
        return;
      }
      closeLists(0);
      const roleClass = {
        header: 'scribe-page-header',
        footer: 'scribe-page-footer',
        pagenum: 'scribe-page-number',
        linenum: 'scribe-line-number',
      }[par?.type];
      const cls = roleClass ? ` class="${roleClass}"` : '';
      body += `<p${cls}${attrs(par)}>${inline(lines)}</p>\n`;
    };
    for (const g of pageArr) {
      const pageObj = ocrPages[g];
      if (!pageObj || pageObj.lines.length === 0) continue;
      pageN = g;

      if (pageObj.pars.length === 0) assignParagraphs(pageObj, pageMetricsArr[g]?.angle || 0);

      const layoutPage = layoutPageArr?.[g];
      const tableWordObj = layoutPage && layoutPage.tables.length > 0 ? extractTableContent(pageObj, layoutPage) : {};
      // The table takes only the words inside its column boxes, so a word of a consumed line that no cell holds is written on its own.
      const cellWordIds = new Set(Object.values(tableWordObj).flatMap((table) => (table?.rowWordArr || []).flat(2)).filter(Boolean).map((w) => w.id));
      /** @type {Array<{key: string, bbox: bbox}>} */
      const tableBboxes = [];
      for (let t = 0; t < (layoutPage?.tables.length || 0); t++) {
        if (layoutPage.tables[t].boxes.length > 0) tableBboxes.push({ key: String(t), bbox: calcTableBbox(layoutPage.tables[t]) });
      }
      const tablesWritten = new Set();

      // No paragraph field records list depth, so it is recovered from geometry.
      const listLefts = [...new Set(pageObj.pars
        .filter((par) => par.marker && par.type !== 'blockquote' && par.type !== 'footnote' && !parMarkerInText(par))
        .map((par) => par.bbox.left))].sort((a, b) => a - b);
      depthLefts = listLefts.filter((left, i) => i === 0 || left - listLefts[i - 1] > 5);

      for (const lineObj of pageObj.lines) {
        const inTable = tableBboxes.find((tb) => calcBoxOverlap(lineObj.bbox, tb.bbox) > 0.5);
        if (inTable) {
          writePar();
          if (!tablesWritten.has(inTable.key)) {
            tablesWritten.add(inTable.key);
            closeLists(0);
            const rows = tableWordObj[inTable.key]?.rowWordArr;
            if (rows && rows.length > 0) {
              const numCols = Math.max(...rows.map((row) => row.length));
              body += `<div class="scribe-table"${parIds ? ` data-page="${g}"` : ''}>\n<table>\n`;
              for (let r = 0; r < rows.length; r++) {
                const cell = r === 0 ? 'th' : 'td';
                body += '<tr>';
                for (let c = 0; c < numCols; c++) body += `<${cell}>${inline([{ words: rows[r][c] || [] }], { plainBold: r === 0 })}</${cell}>`;
                body += '</tr>\n';
              }
              body += '</table>\n</div>\n';
            }
          }
          const orphans = lineObj.words.filter((w) => !!w && !!w.text && (!wordIds || wordIds.includes(w.id)) && !cellWordIds.has(w.id));
          if (orphans.length > 0) {
            closeLists(0);
            body += `<p${attrs(lineObj.par)}>${inline([{ words: orphans }])}</p>\n`;
          }
          continue;
        }
        if (dropPageHeadersFooters && parIsFurniture(lineObj.par)) continue;
        if (parLines.length > 0 && lineObj.par !== parLines[0].par) writePar();
        parLines.push(lineObj);
      }
      writePar();
      doc?.progressHandler({ n: g, type: 'export', info: {} });
    }
    closeLists(0);
    if (notes.length > 0) {
      body += '<section class="scribe-notes">\n<ol>\n';
      for (const note of notes) {
        const back = referenced.has(note.id) ? ` <a class="scribe-fnback" href="#scribe-fnref-${note.id}">↩</a>` : '';
        body += `<li id="scribe-fn-${note.id}"${parIds ? ` data-par="${note.id}" data-page="${note.n}"` : ''}><span class="scribe-fnlabel">${esc(note.label)}</span>${note.html}${back}</li>\n`;
      }
      body += '</ol>\n</section>\n';
    }
    body += '</article>\n';
    return {
      body, style: ARTICLE_RULES, fontsUsed, title,
    };
  }

  const enableOptSaved = fonts.state.enableOpt;
  fonts.state.enableOpt = false;

  if (images && images.length === 0) images = undefined;

  let bodyStr = '';

  let newLine = false;

  const activeLine = {
    left: 0,
    y1: 0,
    maxFontBoundingBoxAscentLine: 0,
    bodyWordsStr: '',
    /** @type {?string} */
    parId: null,
    orientation: 0,
  };

  /** @type {Map<number, string>} */
  let groups = new Map();

  const addLine = () => {
    if (activeLine.bodyWordsStr !== '') {
      const topHTML = Math.round((activeLine.y1 - activeLine.maxFontBoundingBoxAscentLine) * 1000) / 1000;
      const parAttr = parIds && activeLine.parId ? ` data-par="${activeLine.parId}"` : '';
      let lineStr = `    <div class="scribe-line"${parAttr} style="left:${activeLine.left}px;top:${topHTML}px;">\n`;
      lineStr += '        ';
      lineStr += activeLine.bodyWordsStr;
      lineStr += '<br>\n';
      lineStr += '    </div>\n';
      groups.set(activeLine.orientation, (groups.get(activeLine.orientation) || '') + lineStr);
    }
    activeLine.bodyWordsStr = '';
    activeLine.maxFontBoundingBoxAscentLine = 0;
    activeLine.y1 = 0;
    activeLine.left = 0;
    activeLine.parId = null;
    activeLine.orientation = 0;
  };

  let top = 0;

  for (const g of pageArr) {
    // TODO: change this when an image is included.
    if (!ocrPages[g] || ocrPages[g].lines.length === 0) continue;

    const pageObj = ocrPages[g];

    let minLeft = 0;
    let minTop = 0;
    let maxBottom = 0;
    if (removeMargins) {
      const wordArr = ocr.getPageWords(pageObj);
      for (let h = 0; h < wordArr.length; h++) {
        const wordObj = wordArr[h];
        if (wordIds && !wordIds.includes(wordObj.id)) continue;
        if (minLeft === 0 || wordObj.bbox.left < minLeft) minLeft = wordObj.bbox.left;
        if (minTop === 0 || wordObj.bbox.top < minTop) minTop = wordObj.bbox.top;
        if (wordObj.bbox.bottom > maxBottom) maxBottom = wordObj.bbox.bottom;
      }
    }

    bodyStr += `  <div class="scribe-page" id="page${g}" style="position:absolute;top:${top}px;">\n`;

    const imageObj = images ? images[g] : null;
    if (imageObj) {
      // Materialize `src` in case this is a viewer-rendered bitmap-backed wrapper (no-op otherwise).
      bodyStr += `  <img class="scribe-image" src="${imageObj.ensureSrc()}">\n`;
    }

    const { dims } = pageMetricsArr[g];
    const userRotation = pageMetricsArr[g].rotation || 0;
    const disp = userRotation % 180 === 90 ? { width: dims.height, height: dims.width } : dims;
    const textRotation = autoRotate ? 0 : (pageMetricsArr[g].angle || 0);

    if (removeMargins) {
      top += Math.min((maxBottom - minTop) + 200, disp.height + 10);
    } else {
      top += disp.height + 10;
    }

    groups = new Map();
    let wordObjPrev = /** @type {?OcrWord} */ (null);
    let advanceDiffPrev = 0;
    let rightSideBearingPrev = 0;
    let charSpacingHTMLPrev = 0;

    for (let h = 0; h < pageObj.lines.length; h++) {
      const lineObj = pageObj.lines[h];

      newLine = true;

      let underlinePrev = false;

      for (let i = 0; i < lineObj.words.length; i++) {
        const wordObj = lineObj.words[i];
        if (!wordObj || !wordObj.text) continue;

        if (wordIds && !wordIds.includes(wordObj.id)) continue;

        if (newLine) {
          wordObjPrev = null;

          addLine();

          const scale = 1;

          const { leftSideBearing } = calcWordMetrics(wordObj, docFonts);

          activeLine.y1 = wordObj.line.bbox.bottom + wordObj.line.baseline[1] - minTop;

          activeLine.left = wordObj.bbox.left - minLeft;
          if (wordObj.visualCoords) activeLine.left -= leftSideBearing * scale;
          activeLine.parId = wordObj.line.par ? wordObj.line.par.id : null;
          activeLine.orientation = wordObj.line.orientation || 0;
        }

        newLine = false;

        const scale = 1;
        const angle = 0;

        const {
          charSpacing, leftSideBearing, rightSideBearing, fontSize, charArr, advanceArr, kerningArr, font,
        } = calcWordMetrics(wordObj, docFonts);

        fontsUsed.add(font);

        const wordStr = charArr.join('');

        const charSpacingHTML = charSpacing * scale;

        const y1 = wordObj.line.bbox.bottom + wordObj.line.baseline[1] - minTop;

        const fontSizeHTML = fontSize * scale;

        const metrics = calcFontMetrics(font, fontSizeHTML);

        const fontSizeHTMLSmallCaps = fontSize * scale * font.smallCapsMult;

        if (metrics.fontBoundingBoxAscent > activeLine.maxFontBoundingBoxAscentLine) {
          activeLine.maxFontBoundingBoxAscentLine = metrics.fontBoundingBoxAscent;
        }

        // Align with baseline
        const topHTML = Math.round((y1 - metrics.fontBoundingBoxAscent) * 1000) / 1000;

        let styleStr = '';

        styleStr += `font-size:${fontSizeHTML}px;`;
        styleStr += `font-family:${font.fontFaceName};`;

        if (Math.abs(angle ?? 0) > 0.05) {
          styleStr += `transform-origin:left ${y1 - topHTML}px;`;
          styleStr += `transform:rotate(${angle}deg);`;
        }

        const { fill, opacity } = ocr.getWordFillOpacity(wordObj, displayMode,
          confThreshMed, confThreshHigh, overlayOpacity);

        // Text with opacity 0 is not selectable, so we make it transparent instead.
        if (opacity === 0) {
          styleStr += 'color:transparent;';
          styleStr += 'opacity:1;';
        } else {
          styleStr += `color:${fill};`;
          styleStr += `opacity:${opacity};`;
        }

        // We cannot make the text uppercase in the input field, as this would result in the text being saved as uppercase.
        // Additionally, while there is a small-caps CSS property, it does not allow for customizing the size of the small caps.
        // Therefore, we handle small caps by making all text print as uppercase using the `text-transform` CSS property,
        // and then wrapping each letter in a span with a smaller font size.
        let innerHTML;
        if (wordObj.style.smallCaps) {
          styleStr += 'text-transform:uppercase;';
          innerHTML = makeSmallCapsDivs(wordStr, fontSizeHTMLSmallCaps);
        } else {
          const styleSegments = ocr.getWordStyleSegments(wordObj);
          if (styleSegments) {
            innerHTML = styleSegments.map((segment) => {
              const fontSegment = docFonts.getFont(segment.style, wordObj.lang);
              return `<span style="font-style:${fontSegment.fontFaceStyle};font-weight:${fontSegment.fontFaceWeight};">${wordStr.slice(segment.start, segment.end)}</span>`;
            }).join('');
          } else {
            innerHTML = wordStr;
          }
        }

        let leftPad = 0;
        if (wordObjPrev) {
          let spaceAdj = 0;
          if (wordObj.visualCoords) {
            spaceAdj = leftSideBearing + rightSideBearingPrev;
          } else {
            // This is usually 0, however can be non-zero when the PDF glyph advances
            // are different from the HTML glyph advances.
            spaceAdj = advanceDiffPrev;
          }

          leftPad = (wordObj.bbox.left - wordObjPrev.bbox.right - spaceAdj - charSpacingHTMLPrev) / Math.cos(angle);
        }

        styleStr += `letter-spacing:${formatNum(charSpacingHTML)}px;`;

        styleStr += `font-weight:${font.fontFaceWeight};`;
        styleStr += `font-style:${font.fontFaceStyle};`;

        // Line height must match the height of the font bounding box for the font metrics to be accurate.
        styleStr += `line-height:${metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent}px;`;

        if (wordObj.style.sup) {
          const supOffset = Math.round(wordObj.line.bbox.bottom + wordObj.line.baseline[1] - wordObj.bbox.bottom);
          styleStr += `vertical-align:${supOffset}px;`;
        }

        if (wordObj.style.underline && opacity !== 0) {
          styleStr += 'text-decoration:underline;';
          styleStr += `text-decoration-color:${fill};`;
          styleStr += `text-decoration-thickness:${Math.ceil(fontSizeHTML / 12)}px;`;
          styleStr += `text-underline-offset:${Math.ceil(fontSizeHTML / 12) + Math.ceil(fontSizeHTML / 24)}px;`;
        }

        if (i > 0) {
          let styleStrSpace = '';
          const spaceAdvance = font.opentype.charToGlyph(' ').advanceWidth || font.opentype.unitsPerEm * 0.35;
          const spaceAdvancePx = (spaceAdvance / font.opentype.unitsPerEm);
          const fontSizeHTMLSpace = leftPad / spaceAdvancePx;
          if (fontSizeHTMLSpace > fontSizeHTML * 3) {
            styleStrSpace += `font-size:${fontSizeHTML}px;`;

            const leftPadFinal = leftPad - spaceAdvancePx * fontSizeHTML;

            styleStrSpace += `padding-left:${leftPadFinal}px;`;
          } else {
            styleStrSpace += `font-size:${fontSizeHTML}px;`;
            const leftPadFinal = leftPad - spaceAdvancePx * fontSizeHTML;
            styleStrSpace += `word-spacing:${formatNum(leftPadFinal)}px;`;
          }

          styleStrSpace += `font-family:${font.fontFaceName};`;
          styleStrSpace += `font-style:${font.fontFaceStyle};`;
          styleStrSpace += `font-weight:${font.fontFaceWeight};`;

          if (underlinePrev && opacity !== 0) {
            styleStrSpace += `color:${fill};`;
            styleStrSpace += `opacity:${opacity};`;
            styleStrSpace += 'text-decoration:underline;';
            styleStrSpace += `text-decoration-color:${fill};`;
            styleStrSpace += `text-decoration-thickness:${Math.ceil(fontSizeHTML / 12)}px;`;
            styleStrSpace += `text-underline-offset:${Math.ceil(fontSizeHTML / 12) + Math.ceil(fontSizeHTML / 24)}px;`;
          }

          activeLine.bodyWordsStr += `<span class="scribe-space" style=${styleStrSpace}> </span>`;
        }

        activeLine.bodyWordsStr += `<span class="scribe-word" id="${wordObj.id}" style="${styleStr}">${innerHTML}</span>`;

        underlinePrev = wordObj.style.underline;

        const advanceTotalHTML = advanceArr.reduce((a, b) => a + b, 0)
          + kerningArr.reduce((a, b) => a + b, 0)
          + charSpacingHTML * (charArr.length - 1);
        advanceDiffPrev = advanceTotalHTML - (wordObj.bbox.right - wordObj.bbox.left);

        wordObjPrev = wordObj;
        rightSideBearingPrev = rightSideBearing;
        charSpacingHTMLPrev = charSpacingHTML;
      }
    }

    addLine();
    // Lines that display rotated go in a group with the same box and rotation as the viewer's text group for their orientation.
    for (const orientation of [...groups.keys()].sort((a, b) => a - b)) {
      const lines = groups.get(orientation) || '';
      const rotation = textRotation + orientation * 90 + userRotation;
      if (!rotation) {
        bodyStr += lines;
        continue;
      }
      const localW = orientation % 2 === 1 ? dims.height : dims.width;
      const localH = orientation % 2 === 1 ? dims.width : dims.height;
      bodyStr += `    <div class="scribe-group" style="position:absolute;left:${disp.width / 2 - localW / 2}px;top:${disp.height / 2 - localH / 2}px;`
        + `width:${localW}px;height:${localH}px;transform-origin:${localW / 2}px ${localH / 2}px;transform:rotate(${rotation}deg);">\n`;
      bodyStr += lines;
      bodyStr += '    </div>\n';
    }
    bodyStr += '  </div>\n';

    doc?.progressHandler({ n: g, type: 'export', info: {} });
  }

  let styleStr = '  .scribe-word {\n';

  styleStr += '    z-index:1;\n';
  styleStr += '    white-space:nowrap;\n';
  if (kerning) {
    styleStr += '    font-kerning:normal;\n';
  } else {
    styleStr += '    font-kerning:none;\n';
  }

  styleStr += '  }\n';

  styleStr += '  .scribe-line {\n';
  styleStr += '    position:absolute;\n';
  styleStr += '    white-space:nowrap;\n';
  styleStr += '  }\n';

  styleStr += '  .scribe-page {\n';
  styleStr += '    text-decoration-skip-ink:none;\n';
  styleStr += '  }\n';

  styleStr += '  .scribe-image {\n';
  styleStr += '    position:absolute;\n';
  styleStr += '    user-select:none;\n';
  styleStr += '    pointer-events:none;\n';
  styleStr += '  }\n';

  fonts.state.enableOpt = enableOptSaved;

  return { body: bodyStr, style: styleStr, fontsUsed };
}

/**
 * Convert an array of ocrPage objects to HTML.
 *
 * @param {Object} params
 * @param {Array<OcrPage>} params.ocrPages -
 * @param {Array<ImageWrapper>} [params.images] -
 * @param {?Array<import('../objects/layoutObjects.js').LayoutDataTablePage>} [params.layoutPageArr] - Table layout data per page, for the article's tables.
 * @param {?Array<number>} [params.pageArr=null] - Array of 0-based page indices to include. Overrides minpage/maxpage when provided.
 * @param {number} [params.minpage=0] - The first page to include in the document.
 * @param {number} [params.maxpage=-1] - The last page to include in the document.
 * @param {boolean} [params.reflowText=false] - Write the text as an article that reflows to the window, instead of each page's exact layout.
 * @param {boolean} [params.dropPageHeadersFooters=false] - Leave page headers and footers, with page numbers and margin line numbers, out of the article.
 * @param {boolean} [params.removeMargins=false] - Remove the margins from the text.
 * @param {?Array<string>} [params.wordIds] - An array of word IDs to include in the document.
 *    If omitted, all words are included.
 * @param {import('../containers/fontContainer.js').DocFonts} [params.docFonts] - Per-document fonts.
 *    Required; no active-document fallback.
 * @param {Array<PageMetrics>} [params.pageMetrics] - This document's page metrics. Required.
 * @param {('invis'|'ebook'|'eval'|'proof'|'annot')} [params.displayMode] - Defaults to `scribeDocDefaults.displayMode`.
 * @param {number} [params.confThreshHigh] - Defaults to `scribeDocDefaults.confThreshHigh`.
 * @param {number} [params.confThreshMed] - Defaults to `scribeDocDefaults.confThreshMed`.
 * @param {number} [params.overlayOpacity] - Defaults to `scribeDocDefaults.overlayOpacity`.
 * @param {boolean} [params.kerning] - Defaults to `scribeDocDefaults.kerning`.
 * @param {boolean} [params.autoRotate] - Whether the page images are deskewed, in which case the text is not turned by the page's angle.
 *    Defaults to `scribeDocDefaults.autoRotate`.
 * @param {boolean} [params.embedFonts] - Embed fonts inline as base64 `data:` URIs instead of referencing the CDN.
 *    Defaults to `scribeDocDefaults.embedFonts`.
 * @param {boolean} [params.htmlFitWindow=false] - Add a rule scaling the exact layout's pages down to the window's width.
 * @param {?import('../containers/scribeDoc.js').ScribeDoc} [params.doc=null] - Owning document for progress reporting.
 */
export function writeHtml({
  ocrPages, images, layoutPageArr = null, pageArr = null, minpage = 0, maxpage = -1,
  reflowText = false, dropPageHeadersFooters = false, removeMargins = false, wordIds = null, docFonts, pageMetrics,
  displayMode = scribeDocDefaults.displayMode,
  confThreshHigh = scribeDocDefaults.confThreshHigh,
  confThreshMed = scribeDocDefaults.confThreshMed,
  overlayOpacity = scribeDocDefaults.overlayOpacity,
  kerning = scribeDocDefaults.kerning,
  autoRotate = scribeDocDefaults.autoRotate,
  embedFonts = scribeDocDefaults.embedFonts,
  htmlFitWindow = false,
  doc = null,
}) {
  if (!pageArr) {
    if (maxpage === -1) maxpage = ocrPages.length - 1;
    pageArr = [];
    for (let i = minpage; i <= maxpage; i++) pageArr.push(i);
  }

  const {
    body, style, fontsUsed, title,
  } = writeHtmlFragment({
    ocrPages,
    images,
    layoutPageArr,
    pageArr,
    reflowText,
    dropPageHeadersFooters,
    removeMargins,
    wordIds,
    docFonts,
    pageMetrics,
    displayMode,
    confThreshHigh,
    confThreshMed,
    overlayOpacity,
    kerning,
    autoRotate,
    doc,
  });

  let styleStr = `<style>\n${style}`;

  if (htmlFitWindow && !reflowText) {
    // The tangent of the arctangent is how CSS divides one length by another into a plain number.
    const widest = Math.max(0, ...pageArr.map((g) => pageMetrics[g]?.dims.width || 0));
    styleStr += `  body {\n    zoom:min(1, tan(atan2(calc(100vw - 20px), ${widest}px)));\n  }\n`;
  }

  for (const fontI of fontsUsed) {
    let fontSrc;
    if (embedFonts) {
      // Embed the font inline as a base64 data URI so the file is self-contained and opens offline / from `file://` without the CDN.
      const fontBytes = new Uint8Array(fontI.src);
      const isWoff = fontBytes[0] === 0x77 && fontBytes[1] === 0x4F
        && fontBytes[2] === 0x46 && fontBytes[3] === 0x46; // 'wOFF'
      const fontMime = isWoff ? 'font/woff' : 'font/ttf';

      let fontBase64;
      if (typeof Buffer !== 'undefined') {
        fontBase64 = Buffer.from(fontBytes.buffer, fontBytes.byteOffset, fontBytes.byteLength).toString('base64');
      } else {
        let binary = '';
        const chunkSize = 8192;
        for (let i = 0; i < fontBytes.length; i += chunkSize) {
          binary += String.fromCharCode.apply(null, fontBytes.subarray(i, i + chunkSize));
        }
        fontBase64 = btoa(binary);
      }

      fontSrc = `url('data:${fontMime};base64,${fontBase64}')`;
    } else {
      const cdnPath = 'https://cdn.jsdelivr.net/npm/scribe.js-ocr@0.8.0/fonts/all/';
      let styleTitleCase = 'Regular';
      if (fontI.style === 'italic') {
        styleTitleCase = 'Italic';
      } else if (fontI.style === 'bold') {
        styleTitleCase = 'Bold';
      } else if (fontI.style === 'boldItalic') {
        styleTitleCase = 'BoldItalic';
      }
      fontSrc = `url('${cdnPath}${fontI.family}-${styleTitleCase}.woff')`;
    }

    styleStr += `  @font-face {
    font-family: '${fontI.fontFaceName}';
    font-style: ${fontI.fontFaceStyle};
    font-weight: ${fontI.fontFaceWeight};
    src: ${fontSrc};
  }\n`;
  }

  if (reflowText) {
    styleStr += '  body {\n    margin:0;\n    background:#fff;\n  }\n';
  }
  styleStr += '</style>\n';

  let metaStr = '<meta charset="UTF-8">\n';
  if (reflowText) {
    metaStr += `<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${ocr.escapeXml(title || 'Document')}</title>\n`;
    return `<!doctype html>\n<html>\n<head>\n${metaStr}${styleStr}</head>\n<body>\n<main>\n${body}</main>\n</body>\n</html>`;
  }

  return `<!doctype html>\n<html>\n<head>\n${metaStr}${styleStr}</head>\n<body>\n${body}</body>\n</html>`;
}
