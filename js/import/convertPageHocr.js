import ocr from '../objects/ocrObjects.js';

import {
  getTextScript,
  unescapeXml,
  quantile,
  round6,
} from '../utils/miscUtils.js';

import { LayoutDataTablePage } from '../objects/layoutObjects.js';
import { pass2, pass3 } from './convertPageShared.js';

/**
 * Element classes that hold a line of words.
 * Tesseract writes captions, headings and floating text as variants of `ocr_line`.
 */
const LINE_CLASSES = new Set(['ocr_line', 'ocr_caption', 'ocr_header', 'ocr_footer', 'ocr_textfloat']);

const INLINE_TAGS = new Set(['strong', 'em', 'b', 'i', 'u', 'sup', 'sub', 'font']);

/**
 * Encode a line's box, baseline and words as one string.
 * The parser records it when a page is imported and the writer compares it at export, so a line whose string still matches is copied out as uploaded.
 * @param {OcrLine} line
 */
export const hocrLineFingerprint = (line) => {
  const box = (/** @type {bbox} */ b) => `${Math.round(b.left)} ${Math.round(b.top)} ${Math.round(b.right)} ${Math.round(b.bottom)}`;
  const parts = [box(line.bbox), `${round6(line.baseline[0])} ${Math.round(line.baseline[1])}`];
  for (const w of line.words) {
    const s = w.style;
    parts.push([w.id, w.text, box(w.bbox), Math.round(w.conf), s.bold, s.italic, s.underline, s.smallCaps, s.sup, s.dropcap, s.font || '', w.lang || ''].join('\u0001'));
  }
  return parts.join('\u0002');
};

/**
 * @typedef {Object} HocrNode
 * @property {string} tag
 * @property {?string} cls
 * @property {?string} id
 * @property {Object<string, string>} attrs
 * @property {number} start
 * @property {number} openEnd
 * @property {number} closeStart
 * @property {number} end
 * @property {Array<HocrNode>} children
 * @property {string} text - The node's own entity-decoded text, without the text of its `children`.
 * @property {boolean} sup
 */

/**
 * Parse one page of hOCR into an `OcrPage`, plus the page's source markup for re-export.
 * @param {Object} params
 * @param {string} params.ocrStr
 * @param {number} params.n
 * @param {?dims} [params.pageDims]
 */
export async function convertPageHocr({
  ocrStr, n, pageDims = null,
}) {
  // Tesseract numbers ids by page within one run, so a file made from one page image says page 1 whatever the page's place in the document.
  // Zero-padded ids, as Archive.org writes them, already carry the right index and are left alone.
  ocrStr = ocrStr.replace(/(\sid=["'](?:page|block|par|line|word)_)([1-9]\d*)((?:_\d+)?["'])/g, (m, pre, p, post) => (Number(p) === n + 1 ? m : `${pre}${n + 1}${post}`));
  ocrStr = ocrStr.replace(/(\bppageno\s+)(\d+)/, (m, pre, p) => (Number(p) === n ? m : `${pre}${n}`));

  /** @type {HocrNode} */
  const root = {
    tag: '', cls: null, id: null, attrs: {}, start: 0, openEnd: 0, closeStart: ocrStr.length, end: ocrStr.length, children: [], text: '', sup: false,
  };
  /** @type {Array<HocrNode>} */
  const stack = [root];
  let supDepth = 0;
  const tokenRe = /<\/([A-Za-z][\w:-]*)\s*>|<([A-Za-z][\w:-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))*)\s*(\/?)>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[?!][^>]*>|([^<]+)/g;
  for (let m = tokenRe.exec(ocrStr); m !== null; m = tokenRe.exec(ocrStr)) {
    if (m[1] !== undefined) {
      const tag = m[1].toLowerCase();
      if (INLINE_TAGS.has(tag)) {
        if (tag === 'sup') supDepth = Math.max(0, supDepth - 1);
        continue;
      }
      let i = stack.length - 1;
      while (i > 0 && stack[i].tag !== tag) i--;
      if (i > 0) {
        for (let j = stack.length - 1; j > i; j--) {
          stack[j].closeStart = m.index;
          stack[j].end = m.index;
        }
        stack[i].closeStart = m.index;
        stack[i].end = m.index + m[0].length;
        stack.length = i;
      }
    } else if (m[2] !== undefined) {
      const tag = m[2].toLowerCase();
      if (INLINE_TAGS.has(tag)) {
        if (tag === 'sup') {
          supDepth++;
          stack[stack.length - 1].sup = true;
        }
        continue;
      }
      /** @type {Object<string, string>} */
      const attrs = {};
      for (const a of m[3].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) attrs[a[1].toLowerCase()] = unescapeXml(a[2] ?? a[3] ?? a[4]);
      const cls = attrs.class ?? null;
      const id = attrs.id ?? null;
      delete attrs.class;
      delete attrs.id;
      const selfClosing = m[4] === '/' || tag === 'meta' || tag === 'br' || tag === 'img' || tag === 'link';
      /** @type {HocrNode} */
      const node = {
        tag, cls, id, attrs, start: m.index, openEnd: m.index + m[0].length, closeStart: m.index + m[0].length, end: m.index + m[0].length, children: [], text: '', sup: false,
      };
      stack[stack.length - 1].children.push(node);
      if (!selfClosing) stack.push(node);
    } else if (m[5] !== undefined) {
      const top = stack[stack.length - 1];
      top.text += unescapeXml(m[5]);
      if (supDepth > 0) top.sup = true;
    }
  }
  for (let j = stack.length - 1; j >= 1; j--) {
    stack[j].closeStart = ocrStr.length;
    stack[j].end = ocrStr.length;
  }

  /**
   * @param {HocrNode} node
   * @param {string} cls
   * @returns {?HocrNode}
   */
  const findClass = (node, cls) => {
    for (const c of node.children) {
      if (c.cls === cls) return c;
      const found = findClass(c, cls);
      if (found) return found;
    }
    return null;
  };
  const pageNode = findClass(root, 'ocr_page');

  /** @param {string} title */
  const parseTitle = (title) => {
    /** @type {Object<string, string>} */
    const props = {};
    // A semicolon inside a double-quoted value, such as an `x_font` name, does not end the property.
    for (const part of title.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
      const s = part.trim();
      if (!s) continue;
      const i = s.search(/\s/);
      props[i < 0 ? s : s.slice(0, i)] = i < 0 ? '' : s.slice(i + 1).trim();
    }
    return props;
  };
  /** @param {string|undefined} value @returns {?bbox} */
  const parseBbox = (value) => {
    if (!value) return null;
    const a = value.trim().split(/\s+/).map(Number);
    if (a.length < 4 || a.slice(0, 4).some((x) => !Number.isFinite(x))) return null;
    return {
      left: a[0], top: a[1], right: a[2], bottom: a[3],
    };
  };

  // If page dimensions are not provided as an argument, we assume that the entire image is being recognized
  // (so the width/height of the image bounding box is the same as the width/height of the image).
  if (!pageDims && pageNode) {
    const pageBbox = parseBbox(parseTitle(pageNode.attrs.title || '').bbox);
    if (pageBbox) pageDims = { height: pageBbox.bottom, width: pageBbox.right };
  }

  if (!pageDims) throw new Error('Failed to parse page dimensions.');

  const pageObj = new ocr.OcrPage(n, pageDims);
  pageObj.textSource = 'hocr';

  /** @type {Array<{open: string, close: string, lineIds: Array<string>}>} */
  const careas = [];
  /** @type {Object<string, {open: string, close: string, lineIds: Array<string>}>} */
  const pars = {};
  /** @type {HocrSourcePage['lines']} */
  const lines = {};
  /** @type {Map<OcrLine, string>} */
  const lineRaw = new Map();
  /** @type {Set<string>} */
  const usedIds = new Set();
  let charMode = false;
  let lineCount = 0;
  let parCount = 0;

  /** @param {HocrNode} nd @returns {boolean} */
  const hasLine = (nd) => nd.children.some((c) => (c.cls !== null && LINE_CLASSES.has(c.cls)) || hasLine(c));
  /**
   * Convert the lines and paragraphs inside a container.
   * Returns the container's inner markup with a placeholder for each line, each paragraph and each carea that holds lines.
   * @param {HocrNode} node
   * @param {?OcrPar} parObj
   * @param {string} parLang
   * @param {?Array<string>} careaLineIds
   */
  const walk = (node, parObj, parLang, careaLineIds) => {
    let template = '';
    let cursor = node.openEnd;
    for (const c of node.children) {
      template += ocrStr.slice(cursor, c.start);
      if (c.cls !== null && LINE_CLASSES.has(c.cls)) {
        lineCount++;
        let lineId = c.id || `line_${n + 1}_${lineCount}`;
        while (usedIds.has(lineId)) lineId = `${lineId}_${lineCount}`;
        usedIds.add(lineId);
        const raw = ocrStr.slice(c.start, c.end);
        const props = parseTitle(c.attrs.title || '');
        const linebox = parseBbox(props.bbox);
        /** @type {?OcrLine} */
        let lineObj = null;
        /** @type {?number} */
        let lineAscHeight = null;
        /** @type {?number} */
        let lineXHeight = null;
        if (linebox) {
          // Tesseract writes a vertical line with `textangle` and no `baseline`.
          const baselineParts = (props.baseline || '').trim().split(/\s+/).map(Number);
          const baseline = baselineParts.length >= 2 && baselineParts.slice(0, 2).every(Number.isFinite) ? baselineParts.slice(0, 2) : [0, 0];

          // Line font size metrics as reported by Tesseract.
          // As these are frequently not correct (as Tesseract calculates them before character recognition),
          // so they may be replaced later by versions we calculate.
          // `x_ascenders 0` means nothing rises above the x-height, so the rest of `x_size` is the x-height.
          const xSize = parseFloat(props.x_size);
          if (Number.isFinite(xSize)) {
            const descenders = parseFloat(props.x_descenders) || 0;
            const ascenders = parseFloat(props.x_ascenders);
            if (ascenders === 0) {
              lineXHeight = xSize - descenders;
            } else {
              lineAscHeight = xSize - descenders;
              if (ascenders > 0) lineXHeight = xSize - descenders - ascenders;
            }
          }

          const lineLang = c.attrs.lang || c.attrs['xml:lang'] || parLang;
          lineObj = new ocr.OcrLine(pageObj, linebox, baseline, lineAscHeight, lineXHeight);
          lineObj.id = lineId;

          /** @type {Array<HocrNode>} */
          const wordNodes = [];
          /** @param {HocrNode} nd */
          const collectWords = (nd) => {
            for (const w of nd.children) {
              if (w.cls === 'ocrx_word') wordNodes.push(w);
              else collectWords(w);
            }
          };
          collectWords(c);

          for (const wordNode of wordNodes) {
            const wordID = wordNode.id || `word_${n + 1}_${pageObj.lines.length + 1}_${lineObj.words.length + 1}`;
            const wordProps = parseTitle(wordNode.attrs.title || '');
            const wordBox = parseBbox(wordProps.bbox);
            if (!wordBox) continue;
            const wordConf = parseInt(wordProps.x_wconf) || 0;
            const wordLang = wordNode.attrs.lang || wordNode.attrs['xml:lang'] || lineLang;
            const fontName = wordProps.x_font ? wordProps.x_font.trim().replace(/^"|"$/g, '') : null;
            const styleStr = wordNode.attrs.style || '';
            const dropcap = wordNode.children.some((ch) => ch.cls === 'ocr_dropcap');

            // `ocrx_cinfo` spans without `x_bboxes` are Tesseract's `lstm_choice_mode` alternatives, not characters.
            /** @type {Array<{text: string, bbox: bbox}>} */
            const charNodes = [];
            for (const ch of wordNode.children) {
              if (ch.cls !== 'ocrx_cinfo') continue;
              const box = parseBbox(parseTitle(ch.attrs.title || '').x_bboxes);
              if (box) charNodes.push({ text: ch.text, bbox: box });
            }

            let text;
            /** @type {?Array<OcrChar>} */
            let chars = null;
            if (charNodes.length > 0) {
              charMode = true;
              let lang = wordLang;
              if (['chi_sim', 'chi_tra'].includes(lang)) {
                const { han: hanChars, latin: latinChars } = getTextScript(charNodes.map((x) => x.text));
                if (hanChars === 0) {
                  // Do not let languages be switched for a word that contains 0 Han characters.
                  if (!['chi_sim', 'chi_tra'].includes(lineLang)) {
                    lang = lineLang;
                  // Do not let language be Chinese for any word that contains no Han characters and >0 non-Chinese characters.
                  // TODO: Assign the appropriate Latin language (not necessarily English).
                  } else if (latinChars > 0) {
                    lang = 'eng';
                  }
                }
              }
              // For Chinese, every "character" in the .hocr should be its own word.
              // Tesseract LSTM already does this, however Tesseract Legacy combines entire lines into the same "word",
              // which makes good alignment impossible.
              if (lang === 'chi_sim') {
                for (let j = 0; j < charNodes.length; j++) {
                  const charWord = new ocr.OcrWord(lineObj, `${wordID}_${j}`, charNodes[j].text, { ...charNodes[j].bbox });
                  charWord.conf = wordConf;
                  charWord.lang = lang;
                  lineObj.words.push(charWord);
                }
                continue;
              }
              // ABBYY-derived character files box the space after each word as a character of its own.
              const kept = charNodes.filter((ch) => ch.text.trim() !== '');
              text = kept.map((ch) => ch.text).join('');
              if (text.trim() === '') continue;
              chars = kept.map((ch) => new ocr.OcrChar(ch.text, { ...ch.bbox }));
            } else {
              text = '';
              let wordCursor = wordNode.openEnd;
              for (const ch of wordNode.children) {
                text += unescapeXml(ocrStr.slice(wordCursor, ch.start).replace(/<[^>]*>/g, ''));
                if (ch.cls === 'ocr_dropcap') text += ch.text;
                wordCursor = ch.end;
              }
              text = (text + unescapeXml(ocrStr.slice(wordCursor, wordNode.closeStart).replace(/<[^>]*>/g, ''))).trim();
              if (text === '') continue;
            }

            const wordObj = new ocr.OcrWord(lineObj, wordID, text, wordBox);
            wordObj.lang = wordLang;
            wordObj.conf = wordConf;
            wordObj.chars = chars;
            if (fontName) wordObj.style.font = fontName;
            // `<strong>` and `<em>` are ignored because Tesseract's are almost always wrong.
            if (/font-style\s*:\s*italic/i.test(styleStr)) wordObj.style.italic = true;
            if (/font-weight\s*:\s*bold/i.test(styleStr)) wordObj.style.bold = true;
            if (/font-variant\s*:\s*small-caps/i.test(styleStr)) wordObj.style.smallCaps = true;
            if (/text-decoration\s*:\s*underline/i.test(styleStr)) wordObj.style.underline = true;
            if (wordNode.sup) wordObj.style.sup = true;
            if (dropcap) wordObj.style.dropcap = true;
            lineObj.words.push(wordObj);
          }

          if (lineObj.words.length === 0) lineObj = null;
        }

        if (lineObj) {
          if (lineAscHeight === null && lineXHeight === null) {
            const heights = [];
            for (const w of lineObj.words) {
              if (!/\p{L}/u.test(w.text)) continue;
              const x = (w.bbox.left + w.bbox.right) / 2;
              const baselineY = lineObj.bbox.bottom + lineObj.baseline[1] + lineObj.baseline[0] * (x - lineObj.bbox.left);
              heights.push(baselineY - w.bbox.top);
            }
            const asc = heights.length > 0 ? quantile(heights, 0.5) : lineObj.bbox.bottom + lineObj.baseline[1] - lineObj.bbox.top;
            if (asc && asc > 0) lineObj.ascHeight = asc;
          }
          pageObj.lines.push(lineObj);
          lineRaw.set(lineObj, raw);
          if (parObj) {
            lineObj.par = parObj;
            parObj.lines.push(lineObj);
          }
        } else {
          lines[lineId] = { raw, dropped: true };
        }

        if (careaLineIds) careaLineIds.push(lineId);
        if (parObj) pars[parObj.id].lineIds.push(lineId);
        template += `\u0000L${lineId}\u0000`;
      } else if (c.cls === 'ocr_par' && !parObj) {
        parCount++;
        let parId = c.id || `par_${n + 1}_${parCount}`;
        while (usedIds.has(parId)) parId = `${parId}_${parCount}`;
        usedIds.add(parId);
        const par = new ocr.OcrPar(pageObj, {
          left: 0, top: 0, right: 0, bottom: 0,
        });
        par.id = parId;
        pars[parId] = { open: ocrStr.slice(c.start, c.openEnd), close: ocrStr.slice(c.closeStart, c.end), lineIds: [] };
        const lang = c.attrs.lang || c.attrs['xml:lang'] || parLang;
        const inner = walk(c, par, lang, careaLineIds);
        if (par.lines.length > 0) {
          par.bbox = {
            left: Math.min(...par.lines.map((l) => l.bbox.left)),
            top: Math.min(...par.lines.map((l) => l.bbox.top)),
            right: Math.max(...par.lines.map((l) => l.bbox.right)),
            bottom: Math.max(...par.lines.map((l) => l.bbox.bottom)),
          };
          pageObj.pars.push(par);
        }
        template += `\u0000P${parId}\u0000${inner}\u0000/P${parId}\u0000`;
      } else if (c.cls === 'ocr_carea' && hasLine(c)) {
        /** @type {Array<string>} */
        const lineIds = [];
        careas.push({ open: ocrStr.slice(c.start, c.openEnd), close: ocrStr.slice(c.closeStart, c.end), lineIds });
        const k = careas.length - 1;
        template += `\u0000C${k}\u0000${walk(c, parObj, parLang, lineIds)}\u0000/C${k}\u0000`;
      } else if (hasLine(c)) {
        template += `${ocrStr.slice(c.start, c.openEnd)}${walk(c, parObj, parLang, careaLineIds)}${ocrStr.slice(c.closeStart, c.end)}`;
      } else {
        template += ocrStr.slice(c.start, c.end);
      }
      cursor = c.end;
    }
    template += ocrStr.slice(cursor, node.closeStart);
    return template;
  };

  const template = pageNode ? walk(pageNode, null, 'eng', null) : '';

  const warn = { char: charMode ? '' : 'char_warning' };

  pass2(pageObj, 0);
  const langSet = pass3(pageObj);

  // Recorded after the shared passes, which change text and boxes, so an untouched line compares equal at export.
  for (const lineObj of pageObj.lines) {
    const raw = lineRaw.get(lineObj);
    if (raw === undefined) continue;
    lines[lineObj.id] = { raw, dropped: false, fp: hocrLineFingerprint(lineObj) };
  }

  const hocrSource = pageNode ? {
    open: ocrStr.slice(pageNode.start, pageNode.openEnd),
    close: ocrStr.slice(pageNode.closeStart, pageNode.end),
    template,
    careas,
    pars,
    lines,
  } : null;

  return {
    pageObj, dataTables: new LayoutDataTablePage(n), warn, langSet, hocrSource,
  };
}
