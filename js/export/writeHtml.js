import { scribeDocDefaults } from '../containers/scribeDocDefaults.js';
import { calcWordMetrics } from '../utils/fontUtils.js';
import ocr, {
  clonePage, isNoteLeader, parIsFurniture, parMarkerInText, splitNoteReference,
} from '../objects/ocrObjects.js';
import { assignParagraphs, lineEndEvidence, lineJoin } from '../utils/reflowPars.js';
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
  .scribe-article li.scribe-own-marker[data-marker]::before, .scribe-article h1[data-marker]::before, .scribe-article h2[data-marker]::before, .scribe-article h3[data-marker]::before,
  .scribe-article h4[data-marker]::before, .scribe-article h5[data-marker]::before, .scribe-article h6[data-marker]::before {
    content:attr(data-marker) " ";
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
  .scribe-article li.scribe-own-marker {
    list-style-type:none;
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
  .scribe-article .scribe-fnref a {
    text-decoration:none;
    color:inherit;
  }
  .scribe-article .scribe-fnback {
    text-decoration:none;
    color:#777;
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
 * Write pages as an HTML body fragment and CSS rules without document wrapper tags or `@font-face` declarations.
 * @param {Omit<Parameters<typeof writeHtmlChunks>[0], 'embedFonts' | 'htmlFitWindow' | 'fragment'>} params
 * @returns {{body: string, style: string, fontsUsed: Set<FontContainerFont>, title?: string}}
 */
export function writeHtmlFragment(params) {
  const chunks = writeHtmlChunks({ ...params, fragment: true });
  let body = '';
  let next = chunks.next();
  for (; !next.done; next = chunks.next()) body += next.value;
  return { body, ...next.value };
}

/**
 * Write pages as an HTML document, yielding markup one page at a time.
 * Pages in `ocrPages` are neither mutated nor retained, so callers may pass a lazy array view.
 *
 * @param {Object} params
 * @param {Array<OcrPage>} params.ocrPages
 * @param {Array<ImageWrapper>} [params.images]
 * @param {?Array<import('../objects/layoutObjects.js').LayoutDataTablePage>} [params.layoutPageArr] - Per-page table data for `reflowText` mode.
 * @param {?Array<Array<Annotation>>} [params.annotations=null] - Per-page annotations whose link entries are emitted as `<a>` elements.
 * @param {?Array<number>} [params.pageArr=null] - Zero-based page indices to export, overriding `minpage` and `maxpage`.
 * @param {number} [params.minpage=0] - First 0-based page index to export.
 * @param {number} [params.maxpage=-1] - Inclusive last 0-based page index to export, or `-1` for the last page.
 * @param {boolean} [params.reflowText=false] - Emit reflowable `<article>` markup when `true`, or positioned per-page layout when `false`.
 * @param {boolean} [params.dropPageHeadersFooters=false] - Omit headers, footers, page numbers, and margin line numbers in `reflowText` mode.
 * @param {boolean} [params.removeMargins=false] - Trim outer page margins when `reflowText` is `false`.
 * @param {?Array<string>} [params.wordIds=null] - Subset of word IDs to include.
 * @param {import('../containers/fontContainer.js').DocFonts} params.docFonts
 * @param {Array<PageMetrics>} params.pageMetrics
 * @param {('invis'|'ebook'|'eval'|'proof'|'annot')} [params.displayMode] - Defaults to `scribeDocDefaults.displayMode`.
 * @param {number} [params.confThreshHigh] - Defaults to `scribeDocDefaults.confThreshHigh`.
 * @param {number} [params.confThreshMed] - Defaults to `scribeDocDefaults.confThreshMed`.
 * @param {number} [params.overlayOpacity] - Defaults to `scribeDocDefaults.overlayOpacity`.
 * @param {boolean} [params.kerning] - Defaults to `scribeDocDefaults.kerning`.
 * @param {boolean} [params.autoRotate] - Whether page images are already deskewed so text needs no skew rotation.
 *    Defaults to `scribeDocDefaults.autoRotate`.
 * @param {boolean} [params.parIds=false] - Emit `data-par` on positioned lines, and `data-par` and `data-page` on reflowed blocks.
 * @param {boolean} [params.runFonts=false] - Emit `data-font` on text runs in `reflowText` mode.
 * @param {boolean} [params.gatherNotes=true] - Collect footnotes and endnotes into linked note sections in `reflowText` mode.
 * @param {boolean} [params.notesPerPage=false] - Emit each page's gathered notes after that page's body blocks.
 * @param {('page'|'sequential')} [params.noteNumbers='page'] - Keep printed labels on numeric notes for `'page'`, or renumber them sequentially in reference order for `'sequential'`.
 * @param {boolean} [params.embedFonts] - Inline `@font-face` sources as base64 `data:` URIs when `true`, or link to the CDN when `false`.
 *    Defaults to `scribeDocDefaults.embedFonts`.
 * @param {boolean} [params.htmlFitWindow=false] - Add a CSS rule scaling positioned pages down to fit narrower viewports.
 * @param {boolean} [params.fragment=false] - Yield only inner body markup, omitting the document head, `@font-face` declarations, and wrapper tags.
 * @param {?import('../containers/scribeDoc.js').ScribeDoc} [params.doc=null] - Owning document for progress reporting.
 * @returns {Generator<string, {style: string, fontsUsed: Set<FontContainerFont>, title?: string}, void>}
 */
export function* writeHtmlChunks({
  ocrPages, images, layoutPageArr = null, annotations = null, pageArr = null, minpage = 0, maxpage = -1,
  reflowText = false, dropPageHeadersFooters = false, removeMargins = false, wordIds = null, docFonts, pageMetrics,
  displayMode = scribeDocDefaults.displayMode,
  confThreshHigh = scribeDocDefaults.confThreshHigh,
  confThreshMed = scribeDocDefaults.confThreshMed,
  overlayOpacity = scribeDocDefaults.overlayOpacity,
  kerning = scribeDocDefaults.kerning,
  autoRotate = scribeDocDefaults.autoRotate,
  parIds = false,
  runFonts = false,
  gatherNotes = true,
  notesPerPage = false,
  noteNumbers = 'page',
  embedFonts = scribeDocDefaults.embedFonts,
  htmlFitWindow = false,
  fragment = false,
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

  /**
   * Build the HTML document `<head>` and opening `<body>` wrapper.
   * @param {string} style
   * @param {string} title
   */
  const fileHead = (style, title) => {
    let styleStr = `<style>\n${style}`;

    if (htmlFitWindow && !reflowText) {
      // The tangent of the arctangent is how CSS divides one length by another into a plain number.
      const widest = Math.max(0, ...pageArr.map((g) => pageMetrics[g]?.dims.width || 0));
      styleStr += `  body {\n    zoom:min(1, tan(atan2(calc(100vw - 20px), ${widest}px)));\n  }\n`;
    }

    for (const fontI of fontsUsed) {
      let fontSrc;
      if (embedFonts) {
        const fontBytes = new Uint8Array(fontI.src);
        const isWoff = fontBytes[0] === 0x77 && fontBytes[1] === 0x4F
          && fontBytes[2] === 0x46 && fontBytes[3] === 0x46;
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
      return `<!doctype html>\n<html>\n<head>\n${metaStr}${styleStr}</head>\n<body>\n<main>\n`;
    }
    return `<!doctype html>\n<html>\n<head>\n${metaStr}${styleStr}</head>\n<body>\n`;
  };

  /**
   * The link target of each linked word of page `g`, by word id.
   * @param {number} g
   * @returns {Map<string, string>}
   */
  const linkHrefs = (g) => {
    /** @type {Map<string, string>} */
    const hrefs = new Map();
    const links = (annotations?.[g] || []).filter(/** @returns {a is AnnotationLink} */ (a) => a.type === 'link');
    if (links.length === 0 || !ocrPages[g]) return hrefs;
    const words = ocr.getPageWords(ocrPages[g]);
    for (const link of links) {
      let href = null;
      if (link.uri) {
        const uri = link.uri.trim();
        // A PDF can carry a javascript: URI, so only allowlisted schemes are written.
        if (/^(https?:|mailto:)/i.test(uri)) href = uri;
      } else if (link.dest && !reflowText) {
        // Only the exact layout writes the page anchors an internal jump targets.
        href = `#page${link.dest.pageIndex}`;
      }
      if (!href) continue;
      for (const word of words) {
        if (!hrefs.has(word.id) && calcBoxOverlap(word.bbox, link.bbox) > 0.5) hrefs.set(word.id, href);
      }
    }
    return hrefs;
  };

  if (reflowText) {
    const esc = ocr.escapeXml;
    const evidence = lineEndEvidence(ocrPages);
    /** @type {Map<string, string>} */
    const fnLabelById = new Map();
    /** @type {Map<string, string>} */
    const fnPageLabelById = new Map();
    /** @type {Map<string, ?string>} The marker of each note paragraph, by its id. */
    const noteMarkers = new Map();
    /** @type {Array<{parId: string, label: string}>} Note references in reading order, with target paragraph ID and the reference word's label. */
    const refs = [];
    /** @type {Array<{id: string, marker: string}>} Footnotes whose marker is not part of their text. */
    const ownMarkerNotes = [];
    let title = '';
    for (const g of pageArr) {
      const pageObj = ocrPages[g];
      if (!pageObj) continue;
      if (gatherNotes) {
        for (const par of pageObj.pars) {
          if (par.type === 'footnote' || par.type === 'endnote') noteMarkers.set(par.id, par.marker);
          else noteMarkers.delete(par.id);
          if (par.type === 'footnote' && par.marker && /^[^\s\]]+$/.test(par.marker) && !parMarkerInText(par)) ownMarkerNotes.push({ id: par.id, marker: par.marker });
        }
        for (const lineObj of pageObj.lines) {
          for (const word of lineObj.words) {
            if (word && word.footnoteParId && (!wordIds || wordIds.includes(word.id))) refs.push({ parId: word.footnoteParId, label: splitNoteReference(word).label });
          }
        }
      }
      if (title) continue;
      const layoutPage = layoutPageArr?.[g];
      /** @type {Array<bbox>} */
      const tableBboxes = [];
      for (let t = 0; t < (layoutPage?.tables.length || 0); t++) {
        if (layoutPage.tables[t].boxes.length > 0) tableBboxes.push(calcTableBbox(layoutPage.tables[t]));
      }
      /** @type {?Array<OcrLine>} */
      let heading = null;
      for (const lineObj of [...pageObj.lines, null]) {
        const inTable = !!lineObj && tableBboxes.some((tb) => calcBoxOverlap(lineObj.bbox, tb) > 0.5);
        if (lineObj && !inTable && dropPageHeadersFooters && parIsFurniture(lineObj.par)) continue;
        if (heading && (!lineObj || inTable || lineObj.par !== heading[0].par)) {
          title = heading.flatMap((line) => line.words.map((w) => w.text)).join(' ');
          heading = null;
          if (title) break;
        }
        if (!lineObj || inTable) continue;
        if (heading) heading.push(lineObj);
        else if (lineObj.par && lineObj.par.type === 'title' && lineObj.par.debug.sourceStyle !== 'HTMLPreformatted') heading = [lineObj];
      }
    }
    let numberedNotes = 0;
    for (const { parId, label } of refs) {
      if (!noteMarkers.has(parId) || fnLabelById.has(parId)) continue;
      const marker = noteMarkers.get(parId);
      const own = marker && /^[^\s\]]+$/.test(marker) ? marker : label;
      if (!own) continue;
      const shown = noteNumbers === 'sequential' && !/\D/.test(own) ? String(++numberedNotes) : own;
      fnLabelById.set(parId, shown);
      if (shown !== own) fnPageLabelById.set(parId, own);
    }
    // A Word or Markdown footnote is gathered even when nothing links to it, or writePar would take its metadata label for a list marker.
    for (const { id, marker } of ownMarkerNotes) {
      if (!fnLabelById.has(id)) fnLabelById.set(id, marker);
    }

    if (!fragment) yield fileHead(ARTICLE_RULES, title);
    const referenced = new Set();
    /** @type {Map<string, string>} */
    let hrefs = new Map();
    /**
     * Write lines of words as inline markup.
     * @param {Array<{words: Array<?OcrWord>}>} lines
     */
    const inline = (lines, { plainBold = false, stripLeader = false } = {}) => {
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
      // Bold that sets a whole link apart from the words beside it is the link's cue, which the anchor replaces.
      const parWords = lines.flatMap((line) => line.words.filter(/** @returns {w is OcrWord} */ (w) => !!w && !!w.text && (!wordIds || wordIds.includes(w.id))));
      const cueBoldIds = new Set();
      for (let i = 0; i < parWords.length; i++) {
        const href = hrefs.get(parWords[i].id);
        if (!href || (i > 0 && hrefs.get(parWords[i - 1].id) === href)) continue;
        let end = i;
        while (end + 1 < parWords.length && hrefs.get(parWords[end + 1].id) === href) end++;
        const linked = parWords.slice(i, end + 1);
        if (linked.every((w) => w.style.bold) && !parWords[i - 1]?.style.bold && !parWords[end + 1]?.style.bold) linked.forEach((w) => cueBoldIds.add(w.id));
      }
      let openHref = '';
      let prevJoin = false;
      let first = true;
      for (let li = 0; li < lines.length; li++) {
        const words = lines[li].words.filter(/** @returns {w is OcrWord} */ (w) => !!w && !!w.text && (!wordIds || wordIds.includes(w.id)));
        const lastWritten = words.length > 0 && words[words.length - 1] === lines[li].words[lines[li].words.length - 1];
        const { joinNext, dropHyphen } = lastWritten && lines[li + 1] ? lineJoin(lines[li], lines[li + 1], evidence) : { joinNext: false, dropHyphen: false };
        for (let i = 0; i < words.length; i++) {
          const word = words[i];
          if (stripLeader && first && isNoteLeader(word, lines[li].par || null)) continue;
          let sep = first || (i === 0 && prevJoin) ? '' : ' ';
          first = false;
          const label = word.footnoteParId ? fnLabelById.get(word.footnoteParId) : undefined;
          const ref = label !== undefined ? splitNoteReference(word) : null;
          const text = ref ? ref.head : i === words.length - 1 && dropHyphen ? word.text.replace(LINE_END_HYPHEN_RE, '') : word.text;
          // A reference with no text of its own leaves the open anchor to the reference branch below.
          const href = text ? hrefs.get(word.id) || '' : openHref;
          if (href !== openHref) {
            closeRun();
            runKey = '';
            if (openHref) out += '</a>';
            out += sep;
            sep = '';
            if (href) out += `<a href="${esc(href)}">`;
            openHref = href;
          }
          const segments = ocr.getWordStyleSegments(word) || [{ start: 0, end: text.length, style: word.style }];
          for (let k = 0; k < segments.length; k++) {
            const segment = segments[k];
            const piece = text.slice(segment.start, segment.end);
            if (!piece) continue;
            const key = `${segment.style?.bold && !plainBold && !cueBoldIds.has(word.id) ? 'b' : ''}${segment.style?.italic ? 'i' : ''}${segment.style?.sup ? 's' : ''}${runFonts && segment.style?.font ? `|${segment.style.font}` : ''}`;
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
          if (ref) {
            closeRun();
            runKey = '';
            if (openHref) {
              out += '</a>';
              openHref = '';
            }
            const firstRef = !referenced.has(word.footnoteParId);
            referenced.add(word.footnoteParId);
            // The reference stays attached to the word before it.
            const refHtml = `<sup class="scribe-fnref"><a href="#scribe-fn-${word.footnoteParId}"${firstRef ? ` id="scribe-fnref-${word.footnoteParId}"` : ''}>${esc(label)}</a></sup>${esc(ref.tail)}`;
            out += runFonts && word.style.font ? `<span data-font="${esc(word.style.font)}">${refHtml}</span>` : refHtml;
          }
        }
        prevJoin = joinNext;
      }
      closeRun();
      if (openHref) out += '</a>';
      return out;
    };

    let body = '<article class="scribe-article">\n';
    /** @type {Array<{depth: number, tag: string, item: boolean}>} */
    const openLists = [];
    /** @param {number} depth */
    const closeLists = (depth) => {
      while (openLists.length > 0 && openLists[openLists.length - 1].depth >= depth) {
        const list = /** @type {{depth: number, tag: string, item: boolean}} */ (openLists.pop());
        body += `${list.item ? '</li>\n' : ''}</${list.tag}>\n`;
      }
    };
    /** @type {Array<{id: string, label: string, own?: string, font?: string, html: string, n: number}>} */
    const notes = [];
    /** @param {Array<{id: string, label: string, own?: string, font?: string, html: string, n: number}>} list */
    const notesHtml = (list) => {
      let s = '<section class="scribe-notes">\n<ol>\n';
      for (const note of list) {
        const back = referenced.has(note.id) ? ` <a class="scribe-fnback" href="#scribe-fnref-${note.id}">↩</a>` : '';
        s += `<li id="scribe-fn-${note.id}"${parIds ? ` data-par="${note.id}" data-page="${note.n}"` : ''}${note.own ? ` data-own-label="${esc(note.own)}"` : ''}><span class="scribe-fnlabel"${note.font ? ` data-font="${esc(note.font)}"` : ''}>${esc(note.label)}</span>${note.html}${back}</li>\n`;
      }
      return `${s}</ol>\n</section>\n`;
    };
    let pageN = 0;
    let lastBodyEnd = 0;
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
        lastBodyEnd = body.length;
        return;
      }
      if (par && par.type === 'title') {
        closeLists(0);
        const level = Math.min(Math.max(par.headingLevel || 1, 1), 6);
        const marker = par.marker && !parMarkerInText(par) ? ` data-marker="${esc(par.marker)}"` : '';
        body += `<h${level}${marker}${attrs(par)}>${inline(lines, { plainBold: true })}</h${level}>\n`;
        lastBodyEnd = body.length;
        return;
      }
      if (par && par.type === 'blockquote') {
        closeLists(0);
        const marker = par.marker && !parMarkerInText(par) ? `${esc(par.marker)} ` : '';
        body += `<blockquote${attrs(par)}><p>${marker}${inline(lines)}</p></blockquote>\n`;
        lastBodyEnd = body.length;
        return;
      }
      if (par && fnLabelById.has(par.id)) {
        const hadList = openLists.length > 0;
        closeLists(0);
        if (hadList) lastBodyEnd = body.length;
        notes.push({
          id: par.id,
          label: /** @type {string} */ (fnLabelById.get(par.id)),
          own: fnPageLabelById.get(par.id),
          font: runFonts ? lines[0]?.words[0]?.style.font : undefined,
          html: inline(lines, { stripLeader: true }),
          n: pageN,
        });
        return;
      }
      if (par && par.marker && !parMarkerInText(par)) {
        const { marker } = par;
        // A bare number, as a Word import records it, is not left to the browser, whose "1." would not match the "1.1" beside it.
        const numbered = /^\d+[.)]$/.test(marker);
        const ownMarker = !numbered && marker !== '•';
        const tag = /[\p{L}\p{N}]/u.test(marker) ? 'ol' : 'ul';
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
        body += `<li${value}${ownMarker ? ' class="scribe-own-marker"' : ''}${markerAttr}${attrs(par)}>${glyph}${inline(lines)}`;
        lastBodyEnd = body.length;
        top.item = true;
        return;
      }
      const hadList = openLists.length > 0;
      closeLists(0);
      /** @type {Partial<Record<import('../objects/ocrObjects.js').ParType, string>>} */
      const roleClasses = {
        header: 'scribe-page-header',
        footer: 'scribe-page-footer',
        pagenum: 'scribe-page-number',
        linenum: 'scribe-line-number',
      };
      const roleClass = roleClasses[par?.type];
      const cls = roleClass ? ` class="${roleClass}"` : '';
      // A list the page's notes follow must close before them, so the notes do not land inside its last item.
      if (roleClass && hadList) lastBodyEnd = body.length;
      body += `<p${cls}${attrs(par)}>${inline(lines)}</p>\n`;
      if (!roleClass) lastBodyEnd = body.length;
    };
    for (const g of pageArr) {
      let pageObj = ocrPages[g];
      if (!pageObj || pageObj.lines.length === 0) continue;
      pageN = g;
      hrefs = linkHrefs(g);
      const pageNotesStart = notes.length;
      lastBodyEnd = body.length;

      if (pageObj.pars.length === 0) {
        pageObj = clonePage(pageObj);
        assignParagraphs(pageObj, pageMetricsArr[g]?.angle || 0);
      }

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
              lastBodyEnd = body.length;
            }
          }
          const orphans = lineObj.words.filter((w) => !!w && !!w.text && (!wordIds || wordIds.includes(w.id)) && !cellWordIds.has(w.id));
          if (orphans.length > 0) {
            closeLists(0);
            body += `<p${attrs(lineObj.par)}>${inline([{ words: orphans }])}</p>\n`;
            lastBodyEnd = body.length;
          }
          continue;
        }
        if (dropPageHeadersFooters && parIsFurniture(lineObj.par)) continue;
        if (parLines.length > 0 && lineObj.par !== parLines[0].par) writePar();
        parLines.push(lineObj);
      }
      writePar();
      if (notesPerPage && notes.length > pageNotesStart) {
        // The notes go before any header, footer or number line the reading order puts after the page's last body block.
        if (openLists.length > 0) {
          closeLists(0);
          lastBodyEnd = body.length;
        }
        body = body.slice(0, lastBodyEnd) + notesHtml(notes.splice(pageNotesStart)) + body.slice(lastBodyEnd);
      }
      doc?.progressHandler({ n: g, type: 'export', info: {} });
      yield body;
      body = '';
    }
    closeLists(0);
    if (notes.length > 0) body += notesHtml(notes);
    body += '</article>\n';
    yield body;
    if (!fragment) yield '</main>\n</body>\n</html>';
    return { style: ARTICLE_RULES, fontsUsed, title };
  }

  let exactStyle = '  .scribe-word {\n';

  exactStyle += '    z-index:1;\n';
  exactStyle += '    white-space:nowrap;\n';
  if (kerning) {
    exactStyle += '    font-kerning:normal;\n';
  } else {
    exactStyle += '    font-kerning:none;\n';
  }

  exactStyle += '  }\n';

  exactStyle += '  .scribe-line {\n';
  exactStyle += '    position:absolute;\n';
  exactStyle += '    white-space:nowrap;\n';
  exactStyle += '  }\n';

  exactStyle += '  .scribe-page {\n';
  exactStyle += '    text-decoration-skip-ink:none;\n';
  exactStyle += '  }\n';

  exactStyle += '  .scribe-page a {\n';
  exactStyle += '    color:inherit;\n';
  exactStyle += '    text-decoration:none;\n';
  exactStyle += '  }\n';

  exactStyle += '  .scribe-image {\n';
  exactStyle += '    position:absolute;\n';
  exactStyle += '    user-select:none;\n';
  exactStyle += '    pointer-events:none;\n';
  exactStyle += '  }\n';

  const enableOptSaved = fonts.state.enableOpt;
  fonts.state.enableOpt = false;
  try {
    for (const g of pageArr) {
      for (const lineObj of ocrPages[g]?.lines || []) {
        for (const wordObj of lineObj.words) {
          if (wordObj && wordObj.text && (!wordIds || wordIds.includes(wordObj.id))) fontsUsed.add(docFonts.getWordFont(wordObj));
        }
      }
    }

    if (!fragment) yield fileHead(exactStyle, '');

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
      /** @type {string} */
      href: '',
    };

    /** @type {Map<number, string>} */
    let groups = new Map();

    const addLine = () => {
      if (activeLine.href) {
        activeLine.bodyWordsStr += '</a>';
        activeLine.href = '';
      }
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

      const hrefs = linkHrefs(g);
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

          // CSS `font-variant: small-caps` cannot set the small-caps size to match `font.smallCapsMult`.
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
              spaceAdj = advanceDiffPrev;
            }

            leftPad = (wordObj.bbox.left - wordObjPrev.bbox.right - spaceAdj - charSpacingHTMLPrev) / Math.cos(angle);
          }

          styleStr += `letter-spacing:${formatNum(charSpacingHTML)}px;`;

          styleStr += `font-weight:${font.fontFaceWeight};`;
          styleStr += `font-style:${font.fontFaceStyle};`;

          // Prevent CSS `line-height: normal` leading from shifting the baseline.
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

          const href = hrefs.get(wordObj.id) || '';
          if (activeLine.href && href !== activeLine.href) {
            activeLine.bodyWordsStr += '</a>';
            activeLine.href = '';
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

            if (underlinePrev && wordObj.style.underline && opacity !== 0) {
              styleStrSpace += `color:${fill};`;
              styleStrSpace += `opacity:${opacity};`;
              styleStrSpace += 'text-decoration:underline;';
              styleStrSpace += `text-decoration-color:${fill};`;
              styleStrSpace += `text-decoration-thickness:${Math.ceil(fontSizeHTML / 12)}px;`;
              styleStrSpace += `text-underline-offset:${Math.ceil(fontSizeHTML / 12) + Math.ceil(fontSizeHTML / 24)}px;`;
            }

            activeLine.bodyWordsStr += `<span class="scribe-space" style=${styleStrSpace}> </span>`;
          }

          if (href && href !== activeLine.href) {
            activeLine.bodyWordsStr += `<a href="${ocr.escapeXml(href)}">`;
            activeLine.href = href;
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
      yield bodyStr;
      bodyStr = '';
    }
  } finally {
    fonts.state.enableOpt = enableOptSaved;
  }

  if (!fragment) yield '</body>\n</html>';
  return { style: exactStyle, fontsUsed };
}
