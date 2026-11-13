import { OcrPar } from '../objects/ocrObjects.js';
import { calcBboxUnion, quantile } from './miscUtils.js';

// The hyphen a typesetter breaks a word with: a hyphen-minus, a Unicode hyphen or a soft hyphen after a letter or digit.
const LINE_END_HYPHEN_RE = /[\p{L}\p{N}][-‐­]$/u;
const LINE_END_DASH_RE = /[-\u2010\u2011\u2012\u2013\u2014\u00AD\u00AC]$/;
const OPENERS_RE = /^[\p{Ps}\p{Pi}"'`*_§¶†‡•·]*$/u;
const CLOSERS_RE = /^[\p{Pe}\p{Pf}"'`.,;:!?*_†‡]*$/u;
const POSSESSIVE_RE = /^['\u2019]s?[\p{Pe}\p{Pf}"'.,;:!?]*$/u;
const URL_LIKE_RE = /:\/\/|\bwww\.|[\w.]@[\w-]+\.|\.(com|org|net|gov|edu|mil|io|co|us|uk|de|fr|ca|au|info|biz)(\/|\b)|\.(pdf|html?|aspx?|php|jsp)\b|^https?\b|[\\/][^\\/]*[\\/]/i;
const EXPLICIT_URL_RE = /^[\p{Ps}\p{Pi}"'<]*(?:https?:\/\/|www\.)/iu;
const URL_CHARS_RE = /^[A-Za-z0-9\-._~:/?#@!$&'()*+,;=%]+$/;
const URL_TRIM_RE = /^[\p{Ps}\p{Pi}"'<]+|[\p{Pe}\p{Pf}"'.,;:!?>]+$/gu;
// Words that follow a suspended hyphen ("pre- and post-trial"), where the space belongs to the text.
const COORDINATORS = new Set(['and', 'or', 'nor', 'to', 'versus', 'und', 'oder']);
// Hyphenated words that are a different word from their closed form, as "re-sign" is from "resign".
const HOMOGRAPH_RE = /^(?:re-(?:act|claim|coil|collect|count|cover|creat|dress|fin|form|fund|fus|lay|leas|mark|pair|pos|present|press|prov|sent|serv|sign|solv|sort|sound|stor|strain|tir|trac|treat)(?:e|es|ed|d|ing|s)?|re-creations?|re-laid|un-ioni[sz](?:e|es|ed|ing)|multi-ply|co-ops?)$/;
const LETTERS_RE = /\p{L}+/gu;
const HYPHENATED_PAIR_RE = /(\p{L}+)[-\u2010\u2011](?=(\p{L}+))/gu;

/**
 * Gets the letters on each side of a line-end hyphen and whether they have the shape of a word a typesetter broke.
 * @param {string} last - The line's last word, with its hyphen.
 * @param {string} first - The next line's first word.
 * @returns {{left: string, right: string, breakShape: boolean}} The letters in lowercase, empty on a side where no letter touches the hyphen.
 */
function hyphenSides(last, first) {
  const body = last.slice(0, -1);
  const left = body.match(/\p{L}+$/u)?.[0] || '';
  const right = first.match(/^\p{L}+/u)?.[0] || '';
  const after = first.slice(right.length);
  const breakShape = left.length >= 2 && right.length >= 2
    && OPENERS_RE.test(body.slice(0, body.length - left.length)) && (CLOSERS_RE.test(after) || POSSESSIVE_RE.test(after))
    && !URL_LIKE_RE.test(last) && !URL_LIKE_RE.test(first)
    && ((right === right.toLowerCase() && right !== right.toUpperCase())
      || (right === right.toUpperCase() && right !== right.toLowerCase() && left === left.toUpperCase() && left !== left.toLowerCase()));
  return { left: left.toLowerCase(), right: right.toLowerCase(), breakShape };
}

/**
 * Collects the evidence that decides how a line ending in a hyphen joins the next line.
 * @param {Array<?OcrPage>} pages
 * @returns {{words: Set<string>, pairs: Set<string>, urls: Set<string>, brokenWordsByPage: Map<number, Set<string>>}}
 */
export function lineEndEvidence(pages) {
  /** @type {Set<string>} */
  const words = new Set();
  /** @type {Set<string>} */
  const pairs = new Set();
  /** @type {Set<string>} */
  const urls = new Set();
  for (const page of pages) {
    if (!page) continue;
    let afterDash = false;
    for (const line of page.lines) {
      const lineWords = line.words.filter((word) => !!word);
      const endsInDash = lineWords.length > 0 && LINE_END_DASH_RE.test(lineWords[lineWords.length - 1].text);
      for (let i = 0; i < lineWords.length; i++) {
        // The word a line-end dash ends and the word after it are what the evidence decides, so they are not evidence themselves.
        if ((i === 0 && afterDash) || (i === lineWords.length - 1 && endsInDash)) continue;
        const text = lineWords[i].text.toLowerCase();
        for (const match of text.matchAll(LETTERS_RE)) words.add(match[0]);
        for (const match of text.matchAll(HYPHENATED_PAIR_RE)) pairs.add(`${match[1]}-${match[2]}`);
        if (/:\/\/|www\./.test(text)) urls.add(lineWords[i].text.replace(URL_TRIM_RE, ''));
      }
      afterDash = endsInDash;
    }
  }

  /** @type {Map<number, Set<string>>} */
  const brokenWordsByPage = new Map();
  for (const page of pages) {
    if (!page) continue;
    /** @type {Set<string>} */
    const brokenWords = new Set();
    // Every line end counts, in or out of a paragraph, so the evidence is the same before and after an export assigns paragraphs.
    for (let h = 0; h < page.lines.length - 1; h++) {
      const last = page.lines[h].words[page.lines[h].words.length - 1];
      const first = page.lines[h + 1].words[0];
      if (!last || !first || !LINE_END_HYPHEN_RE.test(last.text)) continue;
      const { left, right, breakShape } = hyphenSides(last.text, first.text);
      if (breakShape && words.has(left + right) && !pairs.has(`${left}-${right}`)) brokenWords.add(left + right);
    }
    if (brokenWords.size > 0) brokenWordsByPage.set(page.n, brokenWords);
  }

  return {
    words, pairs, urls, brokenWordsByPage,
  };
}

/**
 * Decide how a line that ends in a hyphen joins the next line of its paragraph when a reflow export removes the line break.
 * @param {{words: Array<?OcrWord>}} line
 * @param {?{words: Array<?OcrWord>}} next - The next line of the same paragraph, or null at the paragraph's end.
 * @param {ReturnType<typeof lineEndEvidence>} evidence
 * @returns {{joinNext: boolean, dropHyphen: boolean}} Whether the next line's first word follows with no space, and whether the line's last word loses its hyphen.
 */
export function lineJoin(line, next, evidence) {
  const none = { joinNext: false, dropHyphen: false };
  if (!next) return none;
  const last = line.words[line.words.length - 1];
  const first = next.words[0];
  if (!last || !first || !LINE_END_HYPHEN_RE.test(last.text)) return none;

  const { left, right, breakShape } = hyphenSides(last.text, first.text);
  const joined = left + right;
  const pair = `${left}-${right}`;

  // Other words broken on this page or the two beside it show a typesetter that breaks words here.
  const pageN = last.line.page.n;
  let brokenNearby = 0;
  for (const n of [pageN - 1, pageN, pageN + 1]) {
    for (const word of evidence.brokenWordsByPage.get(n) || []) if (word !== joined) brokenNearby++;
  }

  // A document prints both sides of a compound as words of their own, which tells a compound it also spells closed from a broken word.
  if (breakShape && evidence.words.has(joined) && !evidence.pairs.has(pair) && !(evidence.words.has(left) && evidence.words.has(right))
    && brokenNearby > 0 && !HOMOGRAPH_RE.test(pair)) return { joinNext: true, dropHyphen: true };

  if (left && right && evidence.pairs.has(pair) && !COORDINATORS.has(first.text.replace(/[\p{P}\p{S}]+$/u, '').toLowerCase())) return { joinNext: true, dropHyphen: false };

  if (EXPLICIT_URL_RE.test(last.text) && URL_CHARS_RE.test(first.text.replace(URL_TRIM_RE, ''))) {
    // A typesetter that breaks words adds a hyphen where it splits a web address, so the address loses the hyphen where the document prints it whole elsewhere.
    if (evidence.brokenWordsByPage.size > 0 && evidence.urls.has(last.text.slice(0, -1).replace(URL_TRIM_RE, '') + first.text.replace(URL_TRIM_RE, ''))) return { joinNext: true, dropHyphen: true };
    // Where no word is broken nearby, the hyphen a web address wraps at is its own.
    if (brokenNearby === 0) return { joinNext: true, dropHyphen: false };
  }

  return none;
}

/**
 * Assigns paragraphs based on our own heuristics.
 * This function assumes that the lines are already sorted according to their reading order,
 * and simply decides where to split paragraphs.
 * This limits the power of the function, but also eliminates the potential for a catastrophic failure,
 * where correct text becomes unreadable due to lines being move around.
 *
 * @param {OcrPage} page
 * @param {number} angle
 */
export function assignParagraphs(page, angle) {
  let endsEarlyPrev = false;
  let startsLatePrev = false;
  let bulletPrev = false;
  let letterEndPrev = false;

  // First line is always a new paragraph
  let newPar = true;
  let reason = 'first line';

  const sinAngle = Math.sin(angle * (Math.PI / 180));
  const cosAngle = Math.cos(angle * (Math.PI / 180));

  /** @type {Array<OcrPar>} */
  const parArr = [];

  const lineLeftArr = /** @type {Array<number>} */([]);
  const lineRightArr = /** @type {Array<number>} */([]);
  const lineWidthArr = /** @type {Array<number>} */([]);
  const lineCenterArr = /** @type {Array<number>} */([]);
  const lineSpaceArr = /** @type {Array<number>} */([]);

  /** @type {?number} */
  let y2Prev = null;
  for (let h = 0; h < page.lines.length; h++) {
    const line = page.lines[h];
    if (!line) continue;

    lineSpaceArr.push(line.bbox.bottom - y2Prev);

    const x1Rot = line.bbox.left * cosAngle - sinAngle * line.bbox.bottom;
    const x2Rot = line.bbox.right * cosAngle - sinAngle * line.bbox.bottom;

    lineLeftArr.push(x1Rot);
    lineRightArr.push(x2Rot);

    lineWidthArr.push(line.bbox.right - line.bbox.left);

    lineCenterArr.push((x1Rot + x2Rot) / 2);

    y2Prev = line.bbox.bottom;
  }

  // Ideally, we compare the current line to the next 5 lines.
  // When there are fewer than 5 lines after the current line, we add previous lines to the window.
  // Previous lines must be above the current line, and next lines must be below the current line.
  // This avoids comparing lines that are not in the same column.
  const windowSize = 5;
  const medianScratch = /** @type {number[]} */ ([]);
  /**
   * Median of `arr` over the indices [lo1, hi1] and [lo2, hi2].
   * @param {number[]} arr
   * @param {number} lo1
   * @param {number} hi1
   * @param {number} lo2
   * @param {number} hi2
   */
  const windowMedian = (arr, lo1, hi1, lo2, hi2) => {
    let n = 0;
    const insert = (v) => {
      let k = n++;
      while (k > 0 && medianScratch[k - 1] > v) { medianScratch[k] = medianScratch[k - 1]; k--; }
      medianScratch[k] = v;
    };
    for (let x = lo1; x <= hi1; x++) insert(arr[x]);
    for (let x = lo2; x <= hi2; x++) insert(arr[x]);
    return medianScratch[Math.floor(n / 2)];
  };

  /**
   * Calculates expected line start and end positions based on surrounding lines.
   * If this line varies from those values, it may be the first or last line of a paragraph.
   * @param {number} lineIndex - Index of the line to calculate the expected values for.
   * @returns
   */
  const calcExpected = (lineIndex) => {
    const bottom = page.lines[lineIndex].bbox.bottom;
    // These checks only size the window, so it can include lines that fail them.
    let prevQualifying = 0;
    for (let x = Math.max(0, lineIndex - windowSize); x < lineIndex; x++) if (page.lines[x].bbox.bottom <= bottom) prevQualifying++;
    let linesNextN = 0;
    for (let x = lineIndex + 1; x <= lineIndex + windowSize && x < page.lines.length; x++) if (page.lines[x].bbox.bottom >= bottom) linesNextN++;
    const linesPrevN = Math.min(windowSize - linesNextN, prevQualifying);
    if (!linesPrevN && !linesNextN) return null;

    const lo1 = lineIndex - linesPrevN;
    const hi1 = lineIndex - 1;
    const lo2 = lineIndex + 1;
    const hi2 = lineIndex + linesNextN;
    return {
      lineLeftMedian: windowMedian(lineLeftArr, lo1, hi1, lo2, hi2),
      lineRightMedian: windowMedian(lineRightArr, lo1, hi1, lo2, hi2),
      lineWidthMedian: windowMedian(lineWidthArr, lo1, hi1, lo2, hi2),
      lineSpaceMedian: windowMedian(lineSpaceArr, lo1, hi1, lo2, hi2),
    };
  };

  for (let h = 0; h < page.lines.length; h++) {
    const line = page.lines[h];
    let endsEarlyInt = false;
    let startsLate = false;

    if (h > 0 && line.orientation !== page.lines[h - 1].orientation) {
      newPar = true;
      reason = 'orientation change';
    }

    // `bullet` is the lenient signal (used to suppress `indented` on the next line).
    // `isRealListItem` is the stricter signal that actually triggers a new paragraph.
    let bullet = /^([•◦▪▫●○◼◻➢«»]|((i+|\d+|[a-z])(\.|\)))$)/.test(line.words[0].text);
    // `v.` is a case-name connector, never a list marker.
    if (bullet && line.words[0].text === 'v.') bullet = false;
    let isRealListItem = bullet;
    if (isRealListItem && h > 0) {
      const prevLine = page.lines[h - 1];
      const prevLineLast = prevLine.words[prevLine.words.length - 1].text;
      if (!/[.!?:]$/.test(prevLineLast)) isRealListItem = false;
      else {
        // The `.` at end of prev line may be an abbreviation inside a citation
        // whose paren is still open (`…(MD Tenn.` → `1959) (per curiam)`).
        const prevText = prevLine.words.map((w) => w.text).join('');
        const lastOpen = prevText.lastIndexOf('(');
        const lastClose = prevText.lastIndexOf(')');
        if (lastOpen > lastClose) isRealListItem = false;
      }
    }
    // This will not work with non-English alphabets.  Should be replaced with a more general solution at some point.
    const lowerStart = /[a-z]/.test(line.words[0].text.slice(0, 1));
    const letterEnd = /\w/.test(line.words[line.words.length - 1].text.slice(-1));
    // If one line ends with a non-punctuation character and the next line starts with a lowercase letter,
    // they are likely part of the same paragraph.
    // This heuristic can override some but not all other heuristics that would otherwise split the paragraph.
    const lowerConnection = lowerStart && letterEndPrev;

    if (isRealListItem && h > 0) {
      newPar = true;
      reason = 'bullet/list item';
    }

    const firstWordSup = line.words[0].style && line.words[0].style.sup;
    if (firstWordSup && h > 0) {
      newPar = true;
      reason = 'superscript/footnote';
    }

    let parLineIndices = /** @type {?Array<number>} */[];
    if (parArr[parArr.length - 1] && parArr[parArr.length - 1].lines.length > 0) {
      // Get indices of lines in the current paragraph.
      parLineIndices = parArr[parArr.length - 1].lines.map((line) => page.lines.indexOf(line));

      if (parArr[parArr.length - 1].lines.length > 2 && !bulletPrev) {
        const parLeftMedian = quantile(parLineIndices.map((x) => lineLeftArr[x]), 0.5);
        const parWidthMedian = quantile(parLineIndices.map((x) => lineWidthArr[x]), 0.5);

        const leftChangeThresh = Math.max(parWidthMedian * 0.05, 50);

        if (parLeftMedian && parWidthMedian && lineLeftArr[h]
            && Math.abs(lineLeftArr[h] - lineLeftArr[h - 1]) > leftChangeThresh && Math.abs(lineLeftArr[h] - parLeftMedian) > leftChangeThresh
            && Math.abs(lineLeftArr[h + 1] - parLeftMedian) > leftChangeThresh) {
          newPar = true;
          reason = 'left change';
        }
      }
    }

    const expected = calcExpected(h);

    if (!expected) {
      newPar = true;
      reason = 'default value (unable to calculate)';
    } else {
      const {
        lineLeftMedian, lineRightMedian, lineWidthMedian, lineSpaceMedian,
      } = expected;

      // `indented` does not require the line to start right of the previous line, because an indented first line after a centered heading usually starts left of the heading.
      const parInProgress = parArr[parArr.length - 1];
      const parFirstLineLeft = parLineIndices && parLineIndices.length > 0
        ? lineLeftArr[parLineIndices[0]] : null;
      const continuesPrevIndent = parInProgress
        && parInProgress.lines.length >= 2
        && lineLeftArr[h - 1] !== undefined
        && Math.abs(lineLeftArr[h] - lineLeftArr[h - 1]) < (lineWidthMedian * 0.025)
        && parFirstLineLeft !== null
        && parFirstLineLeft < lineLeftArr[h] - (lineWidthMedian * 0.025);
      const continuesAtSameIndent = parInProgress
        && parInProgress.lines.length >= 1
        && parInProgress.lines[parInProgress.lines.length - 1] === page.lines[h - 1]
        && lineLeftArr[h - 1] !== undefined
        && Math.abs(lineLeftArr[h] - lineLeftArr[h - 1]) < (lineWidthMedian * 0.025);
      const indented = lineLeftMedian && (h + 1) < page.lines.length
        && lineLeftArr[h] > (lineLeftMedian + lineWidthMedian * 0.025)
        && lineLeftArr[h] > lineLeftArr[h + 1]
        && !continuesPrevIndent
        && !continuesAtSameIndent;

      const centerAlignedPrev = parLineIndices && parLineIndices.map((x) => lineCenterArr[x]).every((x) => Math.abs(x - lineCenterArr[h - 1]) < (lineWidthMedian * 0.0125));

      // Fully justified text trivially shares a center too.
      let trulyCenterAlignedPrev = false;
      if (centerAlignedPrev && parLineIndices) {
        if (parLineIndices.length > 1) {
          trulyCenterAlignedPrev = parLineIndices.map((x) => lineWidthArr[x])
            .some((x) => Math.abs(x - lineWidthArr[h - 1]) > (lineWidthMedian * 0.05));
        } else if (parLineIndices.length === 1) {
          const prevIdx = parLineIndices[0];
          const sharedCenter = Math.abs(lineCenterArr[prevIdx] - lineCenterArr[h]) < (lineWidthMedian * 0.0125);
          const widthDiffers = Math.abs(lineWidthArr[prevIdx] - lineWidthArr[h]) > (lineWidthMedian * 0.05);
          trulyCenterAlignedPrev = sharedCenter && widthDiffers;
        }
      }

      // Line `h` and `h-1` have the same center point.
      const centerAligned = lineCenterArr[h - 1] && Math.abs(lineCenterArr[h - 1] - lineCenterArr[h]) < (lineWidthMedian * 0.0125);

      // Line `h` and `h+1` have the same center point.
      const centerAlignedNext = lineCenterArr[h + 1] && Math.abs(lineCenterArr[h + 1] - lineCenterArr[h]) < (lineWidthMedian * 0.0125);

      const centerAlignedStart = !centerAlignedPrev && !centerAligned && centerAlignedNext;

      const centerAlignedEnd = centerAlignedPrev && !centerAligned;

      // New paragraph on change in alignment.
      // At a high level, this triggers if all the previous lines in the paragraph have the same alignment, the current line does not match that alignment,
      // and the current line matches the alignment of the next line.
      // The restrictions imposed for this rule to trigger are intentionally strict, as switching between center-aligned and left-aligned text is less common.
      // Note that this rule is intended to capture *paragraphs* that switch alignment, not individual section header or footer lines, which are often centered.
      // These should be handled by other rules.
      if (parLineIndices && lineCenterArr[h - 1] && (centerAlignedStart || centerAlignedEnd)) {
        // To be confident that the previous lines are center-aligned, there must be some variation in the line widths.
        // If there is not, then the center points may match because the text is justified, or left-aligned lines are the same width due to chance.
        const widthVariationPrev = parLineIndices && parLineIndices.length > 1 && parLineIndices.map((x) => lineWidthArr[x]).some((x) => Math.abs(x - lineWidthArr[h - 1]) > (lineWidthMedian * 0.05));

        const widthVariation = lineRightArr[h - 1] && Math.abs(lineRightArr[h] - lineRightArr[h - 1]) > (lineWidthMedian * 0.05);
        const widthVariationNext = lineRightArr[h + 1] && Math.abs(lineRightArr[h] - lineRightArr[h + 1]) > (lineWidthMedian * 0.05);

        // The line must start/end at different points compared to the previous line.
        // If this rule did not exist, the last line of a justified paragraph could trigger a new paragraph
        // if followed by centered footer content.
        const leftChange = lineLeftArr[h - 1] && Math.abs(lineLeftArr[h - 1] - lineLeftArr[h]) > (lineWidthMedian * 0.025);
        const rightChange = lineRightArr[h - 1] && Math.abs(lineRightArr[h - 1] - lineRightArr[h]) > (lineWidthMedian * 0.025);

        if (leftChange && rightChange && widthVariationPrev && widthVariation && widthVariationNext) {
          newPar = true;
          reason = 'alignment change';
        }
      }

      // Weaker version of other conditions, which may be used in combination of other evidence but are not strong enough on their own.
      const indentedWeak = lineLeftArr[h] > (lineLeftArr[h - 1] + 1);
      const lineSpaceWeak = lineSpaceArr[h - 1] > 0 && lineSpaceArr[h] > 1.1 * lineSpaceArr[h - 1];

      // Flag lines that likely end early.
      // A line likely ends early if all of the following conditions are met:
      // (1) it ends at least 10% before the median line end,
      // (2) it ends at least 10% before the previous line end, and
      // (3) the first word on the next line could fit on the current line.
      // The latter condition is necessary because long words, URLs, etc. may cause the line to end early without a new paragraph.
      const lineNextFirstWord = page.lines[h + 1] && page.lines[h + 1].words[0];
      endsEarlyInt = lineRightMedian - lineRightArr[h] > (lineWidthMedian * 0.1)
          && !!lineRightArr[h - 1] && (lineRightArr[h - 1] - lineRightArr[h]) > (lineWidthMedian * 0.1)
          && lineNextFirstWord && (lineNextFirstWord.bbox.right - lineNextFirstWord.bbox.left) < (lineRightMedian - lineRightArr[h]);
      // Similarly, flag lines that start late (with >=20% of the line empty)
      // This is intended to capture floating elements (such as titles and page numbers) and not lines that are indented.
      startsLate = lineLeftArr[h] > (lineLeftMedian + lineWidthMedian * 0.2)
          && !!lineLeftArr[h - 1] && lineLeftArr[h] - lineLeftArr[h - 1] > (lineWidthMedian * 0.2);

      // Add a line break if the previous line ended early
      if (endsEarlyPrev && !lowerConnection && (lineSpaceWeak || indentedWeak)) {
        newPar = true;
        reason = 'prev line ends early';
      } else if (startsLatePrev && !lowerConnection && !centerAlignedPrev) {
        newPar = true;
        reason = 'prev line starts late';

        // Add a line break if this line is indented
      } else if (indented && !bulletPrev && !lowerConnection && !trulyCenterAlignedPrev) {
        newPar = true;
        reason = 'indentation';

        // For the second line on the page, create a new paragraph if the preceding line space is significantly larger than the median line space in the window.
        // This is necessary because the 'large space (relative)' rule only starts working on line 3.
      } else if (h === 1 && lineSpaceArr[h] > 1.5 * lineSpaceMedian) {
        newPar = true;
        reason = 'large space (first line)';
      }
    }

    // Apply additional rules that do not depend on the rolling medians.
    // Create new paragraph if the line spacing is negative, indicating the next line is part of a different column.
    // A threshold is used to prevent a small change in line spacing from creating a new paragraph.
    const lineHeight = line.bbox.bottom - line.bbox.top;
    if (lineSpaceArr[h] && lineSpaceArr[h] < (lineHeight * -1)) {
      newPar = true;
      reason = 'new column';
    }

    // Create new paragraph if the current line space is significantly larger than the preceding line space.
    const lineSpaceIncrease = lineSpaceArr[h - 1] > 0 && lineSpaceArr[h] > 1.5 * lineSpaceArr[h - 1];
    const lineSpaceDecrease = lineSpaceArr[h + 1] > 0 && lineSpaceArr[h] > 1.5 * lineSpaceArr[h + 1];
    if (lineSpaceIncrease || lineSpaceDecrease) {
      newPar = true;
      reason = 'large space (relative)';
    }

    const bbox = line.bbox;
    const bboxPrev = page.lines[h - 1]?.bbox;

    // Create new paragraph if the space between lines is >2.5x the line height.
    // Even if the space before this line is standard for the rolling window, if it is large in absolute terms, it is likely a new paragraph.
    const height = bbox.bottom - bbox.top;
    const width = bbox.right - bbox.left;
    const heightRot = height * cosAngle - sinAngle * width;
    if (lineSpaceArr[h] && lineSpaceArr[h] > 3 * heightRot) {
      newPar = true;
      reason = 'large space (absolute)';
    }

    // Create new paragraph if there is no horizontal or vertical overlap with the previous line.
    // The vertical overlap condition is necessary lines sometimes are improperly split in input data despite being on the same baseline.
    if (bboxPrev && (bboxPrev.right < bbox.left || bboxPrev.left > bbox.right)
          && (bboxPrev.bottom < bbox.top || bboxPrev.top > bbox.bottom)) {
      newPar = true;
      reason = 'no overlap';
    }

    if (newPar) {
      const par = new OcrPar(page, {
        left: 0, top: 0, right: 0, bottom: 0,
      });
      par.reason = reason;
      parArr.push(par);

      reason = '';
    }

    parArr[parArr.length - 1].lines.push(line);

    // The first line of a paragraph is not allowed to "end early" even if the other conditions are met.
    endsEarlyPrev = endsEarlyInt && !newPar;
    startsLatePrev = startsLate;
    bulletPrev = bullet;
    letterEndPrev = letterEnd;
    newPar = false;
  }

  parArr.forEach((parObj) => {
    parObj.lines.forEach((lineObj) => {
      lineObj.par = parObj;
    });
    parObj.bbox = calcBboxUnion(parObj.lines.map((x) => x.bbox));
  });

  page.pars = parArr;
}
