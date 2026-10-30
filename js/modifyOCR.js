import ocr from './objects/ocrObjects.js';
import { layoutBoxIncludes } from './objects/layoutObjects.js';
import { getRandomAlphanum } from './utils/miscUtils.js';

/**
 * Adds lines from a new page to an existing page.
 * Based on overlap between bounding boxes, lines may be added or combined with existing lines.
 * @param {OcrPage} pageA - New page
 * @param {OcrPage} pageB - Existing page
 * @param {PageMetrics} pageMetricsObj - Page metrics
 * @param {boolean} replaceFontSize - Whether font size stats in the new line(s) should be replaced by font size in previous line.
 *  This option is used when the user manually adds a word, as the manually-drawn box will only roughly correspond to font size.
 * @param {boolean} editWordIds - Edit word IDs in `pageB` by appending random characters to the end.
 *  As word ID values must be unique, this is useful when `pageB` may contain duplicative values.
 */
export function combineOCRPage(pageA, pageB, pageMetricsObj, replaceFontSize = false, editWordIds = true) {
  const linesNew = pageA.lines;

  for (let i = 0; i < linesNew.length; i++) {
    const lineNew = linesNew[i];

    if (lineNew.words.length === 0) continue;

    const lineNewRot = ocr.cloneLine(lineNew);
    if (pageMetricsObj.angle) ocr.rotateLine(lineNewRot, pageMetricsObj.angle * -1, pageMetricsObj.dims);

    // Identify the OCR line a bounding box is in (or closest line if no match exists)
    // (1) If the new line's bounding box has significant overlap with an existing line's bounding box, add to that line.
    // (2) If the new line's bounding box has vertical overlap with 1+ existing line's bounding box, add to the closest such line.
    // (3) Otherwise, create a new line.
    let match;
    let matchXOverlap = 0;
    let matchXDist = 1e6;

    let closestI = -1;
    let closestMetric = 1e6;
    let afterClosest = true;
    let yDistMin = 1e6;

    for (let lineI = 0; lineI < pageB.lines.length; lineI++) {
      const line = pageB.lines[lineI];

      // Skip lines that are not horizontal for now.
      // Horizontal lines should not be combined with vertical lines,
      // and combining vertical lines likely brings up some edge cases we have not considered.
      if (line.words.length === 0 || line.orientation !== 0) continue;

      const lineRot = ocr.cloneLine(line);
      if (pageMetricsObj.angle) ocr.rotateLine(lineRot, pageMetricsObj.angle * -1, pageMetricsObj.dims);

      const left = Math.max(lineRot.bbox.left, lineNewRot.bbox.left);
      const top = Math.max(lineRot.bbox.top, lineNewRot.bbox.top);
      const right = Math.min(lineRot.bbox.right, lineNewRot.bbox.right);
      const bottom = Math.min(lineRot.bbox.bottom, lineNewRot.bbox.bottom);

      const width = right - left;
      const height = bottom - top;

      const yOverlap = height < 0 ? 0 : height / (lineNewRot.bbox.bottom - lineNewRot.bbox.top);

      // A majority of the new line must fall within the existing line to be considered a match
      if (yOverlap >= 0.5) {
        const xOverlap = width < 0 ? 0 : width / (lineNewRot.bbox.right - lineNewRot.bbox.left);
        // If the lines overlap more horizontally than any previous comparison, make this line the new working hypothesis
        if (xOverlap > matchXOverlap) {
          matchXOverlap = xOverlap;
          match = line;
          // If this line has no horizontal overlap, but no other line has either, then we check the distance to the nearest line
        } else if (xOverlap === 0 && matchXOverlap === 0) {
          const xDist = Math.min(Math.abs(lineRot.bbox.right - lineNewRot.bbox.left), Math.abs(lineRot.bbox.left - lineNewRot.bbox.right));
          // If this is the closest line (so far), make this line the new working hypothesis
          if (xDist < matchXDist) {
            matchXDist = xDist;
            match = line;
          }
        }
        // The closest non-matching line is tracked over the whole page, since a match can still be rejected below and the new line then goes beside the closest line.
      } else {
        // An ad-hoc distance metric is used, as the standard geometric distance would likely produce worse results for multi-column layouts.
        // xDist is 0 when there is overlap between x coordinates, and otherwise equal to the distance between the x coordinates.
        // yDist is calculated similarly, however is weighted 3x more.  The sum of xMetric and yMetric represents the total distance/penalty.
        const xOverlap = width < 0 ? 0 : width / (lineNewRot.bbox.right - lineNewRot.bbox.left);
        const xDist = xOverlap > 0 ? 0 : Math.min(Math.abs(lineRot.bbox.right - lineNewRot.bbox.left), Math.abs(lineRot.bbox.left - lineNewRot.bbox.right));
        const yDist = yOverlap > 0 ? 0 : Math.min(Math.abs(lineRot.bbox.bottom - lineNewRot.bbox.top), Math.abs(lineRot.bbox.top - lineNewRot.bbox.bottom));

        if (yDist < yDistMin) yDistMin = yDist;

        const totalMetric = xDist + yDist * 3;
        if (totalMetric < closestMetric) {
          closestMetric = totalMetric;
          closestI = lineI;
          afterClosest = lineNewRot.bbox.top > lineRot.bbox.top;
        }
      }
    }

    // The selected match is rejected (and assumed to be in another column) if
    // (1) the horizontal gap between matched lines >5% the width of the entire page and
    // (2) the horizontal gap between matched lines is >2x the vertical gap to the nearest preceding/following line.
    // This is intended to eliminate cases when new words are inserted into the wrong column and/or floating element
    // (possibly on the other side of the page) just because vertical overlap exists.
    if (match && matchXOverlap === 0 && matchXDist > 2 * yDistMin && pageB.dims.width * 0.05 < matchXDist) match = undefined;

    if (match) {
      const { words } = match;

      for (let j = 0; j < lineNew.words.length; j++) {
        const wordNew = lineNew.words[j];
        wordNew.line = match;
        const wordBoxNew = wordNew.bbox;

        // Identify closest word on existing line
        let word; let wordBox; let
          wordIndex;
        let k = 0;
        do {
          wordIndex = k;
          word = words[k];
          wordBox = word.bbox;
          k += 1;
        } while (wordBox.right < wordBoxNew.left && k < words.length);

        // Replace id (which is likely duplicative) with unique id
        if (editWordIds) wordNew.id = word.id + getRandomAlphanum(3);

        // Add to page data
        // Note: Words will appear correctly on the canvas (and in the pdf) regardless of whether they are in the right order.
        // However, it is still important to get the order correct (this makes evaluation easier, improves copy/paste functionality in some pdf readers, etc.)
        if (wordBoxNew.left > wordBox.left) {
          words.splice(wordIndex + 1, 0, wordNew);
        } else {
          words.splice(wordIndex, 0, wordNew);
        }
      }

      // Short lines often contain baseline slope measurements that are inaccurate when the width of the line is extended (by adding more words).
      // Therefore, when adding words to short lines, the slope is replaced with the median slope for the entire page.
      if (match.bbox.right - match.bbox.left < 300) {
        const pageAngleRad = pageB.angle * (Math.PI / 180);
        const pageSlope = Math.tan(pageAngleRad);
        match.baseline[0] = pageSlope;
      }

      // Recalculate bounding box for line
      ocr.updateLineBbox(match);
    } else {
      for (let j = 0; j < lineNew.words.length; j++) {
        const wordNew = lineNew.words[j];

        // Replace id (which is likely duplicative) with unique id
        if (editWordIds) wordNew.id += getRandomAlphanum(3);
      }

      const at = closestI < 0 ? pageB.lines.length : (afterClosest ? closestI + 1 : closestI);

      if (replaceFontSize) {
        // If this is the first/last line on the page, assume the textbox height is the "A" height.
        // This is done because when a first/last line is added manually, it is often page numbers,
        // and is often not the same font size as other lines.
        if (at === 0 || at === pageB.lines.length) {
          lineNew.ascHeight = lineNew.bbox.bottom - lineNew.bbox.top;
          lineNew.xHeight = null;

          // If the new line is between two existing lines, use metrics from nearby line to determine text size
        } else {
          const closestLine = pageB.lines[closestI];
          lineNew.ascHeight = closestLine.ascHeight;
          lineNew.xHeight = closestLine.xHeight;

          // If the previous line's font size is clearly incorrect, we instead revert to assuming the textbox height is the "A" height.
          const lineHeight = lineNew.bbox.bottom - lineNew.bbox.top;
          if (lineNew.ascHeight > lineHeight * 1.5) {
            lineNew.ascHeight = lineNew.bbox.bottom - lineNew.bbox.top;
            lineNew.xHeight = null;
          }
        }
      }

      lineNew.page = pageB;
      pageB.lines.splice(at, 0, lineNew);
    }
  }
}

/**
 * Applies a page's layout regions to its text.
 * `order` boxes assign reading-order priorities, and `exclude` boxes remove the text they cover.
 * An `exclude` box drops individual words at the `'word'` default, or whole lines when its `inclusionLevel` is `'line'`.
 * Reading order is a line-level concept, so `order` boxes always match whole lines.
 * @param {OcrPage} page
 * @param {boolean} applyExclude
 * @param {boolean} editInPlace
 */
export function reorderOcrPage(page, layoutObj, applyExclude = true, editInPlace = false) {
  const pageInt = editInPlace ? page : structuredClone(page);

  if (!layoutObj?.boxes || Object.keys(layoutObj?.boxes).length === 0) return pageInt;

  const hocrALines = pageInt.lines;
  const linesNew = [];

  const orderArr = Array(hocrALines.length);

  // All assigned priorities are assumed to be 0-99.
  // 100 should be lower priority than every assigned value.
  orderArr.fill(100);

  /** @type {Set<string>} */
  const excludeWordIds = new Set();

  // Layout boxes are drawn against the deskew-adjusted page, so membership is tested on derotated copies.
  const derotate = Math.abs(pageInt.angle || 0) > 0.05;

  for (let i = 0; i < hocrALines.length; i++) {
    let lineTest = hocrALines[i];
    if (derotate) {
      lineTest = ocr.cloneLine(lineTest);
      ocr.rotateLine(lineTest, pageInt.angle * -1, pageInt.dims);
    }

    for (const obj of Object.values(layoutObj.boxes)) {
      if (obj.type === 'order') {
        if (layoutBoxIncludes(lineTest.bbox, obj)) orderArr[i] = obj.order;
      } else if (obj.type === 'exclude' && applyExclude) {
        if ((obj.inclusionLevel ?? 'word') === 'line') {
          // Priority "101" is used to remove lines
          if (layoutBoxIncludes(lineTest.bbox, obj)) orderArr[i] = 101;
        } else {
          for (const word of lineTest.words) {
            if (layoutBoxIncludes(word.bbox, obj)) excludeWordIds.add(word.id);
          }
        }
      }
    }
  }

  for (let i = 0; i <= 100; i++) {
    for (let j = 0; j < orderArr.length; j++) {
      if (orderArr[j] === i) {
        linesNew.push(hocrALines[j]);
      }
    }
  }

  pageInt.lines = linesNew;

  if (excludeWordIds.size > 0) ocr.deletePageWords(pageInt, [...excludeWordIds]);

  return pageInt;
}

/**
 * @typedef {Object} ConsensusStats
 * @property {number} total - Base words scored.
 * @property {number} high - Words every comparator corroborated.
 * @property {number} medium - Words some (but not all) comparators corroborated.
 * @property {number} low - Words no comparator corroborated.
 * @property {number} replaced - Words whose text a comparator plurality overwrote.
 * @property {number} added - Words a comparator read where the base layer had none, added to the output.
 * @property {number} spanned - Comparator readings that covered several base words of one line.
 * @property {number} crossLine - Comparator words that straddled three or more base lines, kept out of every word's readings.
 */

/**
 * Build a consensus OCR layer from `base`, in which each word carries every layer's reading of it and a confidence set by how many comparators read it the same way.
 *
 * Words are matched by position, so all layers must share one coordinate space, as `doc.ocr[*]` layers do.
 *
 * @param {Array<OcrPage>} base - The authoritative OCR layer (one page per document page).
 * @param {Array<Array<OcrPage>>} comparators - One or more comparator OCR layers, same page order.
 * @param {Object} [options]
 * @param {string} [options.baseName] - The base layer's source name in `readings`.
 *  Defaults to each page's reading source, its `textSource` with the built-in engine's labels folded to 'scribe'.
 * @param {Array<string>} [options.names] - The comparators' source names in `readings`, in order.
 *  Each defaults to its page's reading source.
 * @param {number} [options.confHigh=100] - Confidence for full corroboration.
 * @param {number} [options.confMed=80] - Confidence for partial corroboration.
 * @param {number} [options.confLow=50] - Confidence for none, and for an added word.
 * @param {number} [options.replaceMinAgree=2] - Min comparators agreeing on one reading to override the text of a base word that no comparator matches.
 *  0 never overrides.
 * @param {boolean} [options.addMissing=true] - Add comparator words at no base word to the output.
 * @returns {{ ocr: Array<OcrPage>, stats: ConsensusStats }}
 */
export function buildConsensusLayer(base, comparators, options = {}) {
  const confHigh = options.confHigh ?? 100;
  const confMed = options.confMed ?? 80;
  const confLow = options.confLow ?? 50;
  const replaceMinAgree = options.replaceMinAgree ?? 2;
  const addMissing = options.addMissing ?? true;

  const nComparators = comparators.length;
  const stats = {
    total: 0, high: 0, medium: 0, low: 0, replaced: 0, added: 0, spanned: 0, crossLine: 0,
  };
  const fold = (/** @type {string} */ t) => ocr.asciiPunctuation(ocr.replaceLigatures(t));
  /** @param {OcrWord} w */
  const core = (w) => {
    // `compareOCRPageImp` trims word boxes by the same amounts.
    const trim = Math.round((w.bbox.bottom - w.bbox.top) * (w.visualCoords ? 0.1 : 0.25));
    return {
      left: w.bbox.left, right: w.bbox.right, top: w.bbox.top + trim, bottom: w.bbox.bottom - trim,
    };
  };
  /** @param {bbox} a @param {bbox} b */
  const overlaps = (a, b) => {
    if (a.top > b.bottom || b.top > a.bottom) return false;
    const common = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    return common > 0 && common >= 0.5 * Math.min(a.right - a.left, b.right - b.left);
  };
  /** @type {Array<OcrPage>} */
  const outPages = [];

  for (let i = 0; i < base.length; i++) {
    const basePage = base[i];
    // A missing base page leaves a hole, matching the sparse layers `doc.ocr[*]` already use.
    if (!basePage) continue;

    // Clone so the source base layer is never mutated. Voting runs on the clone's own words/ids.
    const outPage = ocr.clonePage(basePage);
    const baseName = options.baseName || ocr.readingSource(basePage);
    const baseWords = ocr.getPageWords(outPage);
    const baseCores = baseWords.map(core);
    /** @param {OcrWord} w @param {string} name */
    const choices = (w, name) => (w.readings || []).filter((r) => (r.rank || 1) > 1).map((r) => ({ ...r, source: name }));
    for (const w of baseWords) {
      w.readings = [{ source: baseName, text: w.text, conf: w.conf }, ...choices(w, baseName)];
      // `reached` below reads a set `compTruth` as the mark of an earlier word's span reading, so the clone's flags are cleared before any word is scored.
      w.compTruth = false;
      w.matchTruth = false;
    }

    const perComparator = comparators.map((layer, c) => {
      const compPage = layer[i];
      const name = options.names?.[c] || (compPage ? ocr.readingSource(compPage) : `comparator${c}`);
      /** @type {Map<string, Array<{left: number, text: string, conf: number, choices: Array<import('./objects/ocrObjects.js').Reading>}>>} */
      const pieces = new Map();
      /** @type {Array<{first: string, span: number, text: string, conf: number}>} */
      const spans = [];
      /** @type {Array<OcrWord>} */
      const unmatched = [];
      if (!compPage) {
        return {
          name, pieces, spans, unmatched,
        };
      }
      for (const cWord of ocr.getPageWords(compPage)) {
        const cCore = core(cWord);
        const hits = [];
        for (let k = 0; k < baseWords.length; k++) if (overlaps(cCore, baseCores[k])) hits.push(k);
        if (hits.length === 0) { unmatched.push(cWord); continue; }
        // A comparator word that straddles three or more lines, such as a column of numbers read as one vertical word, is no reading of any of them.
        const lineOverlap = new Map();
        for (const k of hits) {
          const b = baseCores[k];
          const area = Math.max(0, Math.min(cCore.right, b.right) - Math.max(cCore.left, b.left)) * Math.max(0, Math.min(cCore.bottom, b.bottom) - Math.max(cCore.top, b.top));
          lineOverlap.set(baseWords[k].line, (lineOverlap.get(baseWords[k].line) || 0) + area);
        }
        if (lineOverlap.size > 2) { stats.crossLine += 1; continue; }
        const line = [...lineOverlap.entries()].sort((a, b) => b[1] - a[1])[0][0];
        const lineHits = hits.filter((k) => baseWords[k].line === line);
        if (lineHits.length > 1) {
          spans.push({
            first: baseWords[lineHits[0]].id, span: lineHits.length, text: cWord.text, conf: cWord.conf,
          });
          continue;
        }
        hits.splice(0, hits.length, lineHits[0]);
        const { id } = baseWords[hits[0]];
        const arr = pieces.get(id) || [];
        arr.push({
          left: cWord.bbox.left, text: cWord.text, conf: cWord.conf, choices: choices(cWord, name),
        });
        pieces.set(id, arr);
      }
      return {
        name, pieces, spans, unmatched,
      };
    });

    for (let bi = 0; bi < baseWords.length; bi++) {
      const bWord = baseWords[bi];
      stats.total += 1;
      const ownKey = fold(bWord.text);
      let matches = 0;
      let read = 0;
      let spansHere = 0;
      /** @type {Map<string, {text: string, n: number}>} */
      const counts = new Map();
      for (const comp of perComparator) {
        const arr = comp.pieces.get(bWord.id);
        if (arr && arr.length) {
          const text = arr.slice().sort((a, b) => a.left - b.left).map((x) => x.text).join('');
          const conf = Math.round(arr.reduce((a, x) => a + x.conf, 0) / arr.length);
          const extra = arr.length === 1 ? arr[0].choices : [];
          /** @type {Array<import('./objects/ocrObjects.js').Reading>} */ (bWord.readings).push({ source: comp.name, text, conf }, ...extra);
          read += 1;
          const key = fold(text);
          if (key === ownKey) matches += 1;
          else if (counts.has(key)) counts.get(key).n += 1;
          else counts.set(key, { text, n: 1 });
        }
        for (const s of comp.spans) {
          if (s.first !== bWord.id) continue;
          /** @type {Array<import('./objects/ocrObjects.js').Reading>} */ (bWord.readings).push({
            source: comp.name, text: s.text, conf: s.conf, span: s.span,
          });
          spansHere += 1;
          for (let d = 1; d < s.span && bi + d < baseWords.length; d++) {
            baseWords[bi + d].compTruth = true;
            baseWords[bi + d].matchTruth = false;
          }
          stats.spanned += 1;
        }
      }

      const reached = bWord.compTruth;
      bWord.compTruth = reached || read > 0 || spansHere > 0;
      bWord.matchTruth = !reached && read > 0 && counts.size === 0 && spansHere === 0;

      if (matches === nComparators) {
        bWord.conf = confHigh;
        stats.high += 1;
      } else if (matches > 0) {
        bWord.conf = confMed;
        stats.medium += 1;
      } else {
        bWord.conf = confLow;
        stats.low += 1;
        // Replace the base text with the comparators' plurality word, but only if a strict maximum of at least `replaceMinAgree` comparators agree on it.
        if (replaceMinAgree > 0) {
          let bestText = null;
          let bestCount = 0;
          let tie = false;
          for (const { text: t, n: c } of counts.values()) {
            if (c > bestCount) { bestCount = c; bestText = t; tie = false; } else if (c === bestCount) { tie = true; }
          }
          if (bestText !== null && bestCount >= replaceMinAgree && !tie) {
            bWord.text = bestText;
            // The `readings` contract puts the reading equal to `text` first.
            const key = fold(bestText);
            const list = /** @type {Array<import('./objects/ocrObjects.js').Reading>} */ (bWord.readings);
            bWord.readings = [...list.filter((r) => !r.span && fold(r.text) === key), ...list.filter((r) => r.span || fold(r.text) !== key)];
            bWord.chars = null;
            bWord.styleRuns = undefined;
            stats.replaced += 1;
          }
        }
      }
    }

    if (addMissing) {
      /** @type {Array<{word: OcrWord, core: bbox, dissent: boolean}>} */
      const addedWords = [];
      // One counter across comparators, so two layers under one name never give their added words the same id.
      let added = 0;
      for (const comp of perComparator) {
        if (!comp.unmatched.length) continue;
        const extra = new ocr.OcrPage(outPage.n, { ...outPage.dims });
        /** @type {Map<OcrLine, OcrLine>} */
        const linesNew = new Map();
        for (const cWord of comp.unmatched) {
          const cCore = core(cWord);
          const hit = addedWords.find((a) => overlaps(cCore, a.core));
          if (hit) {
            const list = /** @type {Array<import('./objects/ocrObjects.js').Reading>} */ (hit.word.readings);
            list.push({ source: comp.name, text: cWord.text, conf: cWord.conf }, ...choices(cWord, comp.name));
            hit.dissent = hit.dissent || fold(cWord.text) !== fold(hit.word.text);
            hit.word.compTruth = true;
            hit.word.matchTruth = !hit.dissent;
            continue;
          }
          let lineNew = linesNew.get(cWord.line);
          if (!lineNew) {
            lineNew = new ocr.OcrLine(extra, { ...cWord.line.bbox }, cWord.line.baseline.slice(), cWord.line.ascHeight, cWord.line.xHeight);
            linesNew.set(cWord.line, lineNew);
            extra.lines.push(lineNew);
          }
          const wordNew = ocr.cloneWord(cWord);
          wordNew.line = lineNew;
          wordNew.conf = confLow;
          wordNew.compTruth = false;
          wordNew.matchTruth = false;
          added += 1;
          wordNew.id = `word_${outPage.n + 1}_${comp.name}_${added}`;
          wordNew.readings = [{ source: comp.name, text: cWord.text, conf: cWord.conf }, ...choices(cWord, comp.name)];
          lineNew.words.push(wordNew);
          addedWords.push({ word: wordNew, core: core(wordNew), dissent: false });
          stats.added += 1;
        }
        for (const lineNew of extra.lines) ocr.updateLineBbox(lineNew);
        combineOCRPage(extra, outPage, /** @type {PageMetrics} */ ({ angle: outPage.angle || 0, dims: outPage.dims }), false, false);
      }
    }

    outPages[i] = outPage;
  }

  return { ocr: outPages, stats };
}
