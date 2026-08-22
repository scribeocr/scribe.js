import { calcColumnBounds } from '../utils/detectTables.js';

// Graphics-heavy pages (figures, maps, charts) can carry hundreds of thousands of vector paths.
// Skip these pages to avoid severe performance issues.
const MAX_TABLE_DETECTION_PATHS = 20000;

const isNumToken = (t) => /^[\d,$%.()+-]+$/.test(t);
const isNumWord = (t) => isNumToken(t) && (/\d/.test(t) || t === '-');

/**
 * Detect rows where a label is followed by 3+ right-clustered numeric tokens.
 * @param {Array<{text: string}>} words
 */
function isRightClusteredNumeric(words) {
  if (words.length < 4) return false;
  let numW = 0;
  for (const w of words) if (isNumWord(w.text)) numW++;
  if (numW < 3) return false;
  let lastTextIdx = -1;
  for (let i = 0; i < words.length; i++) {
    if (!isNumToken(words[i].text)) lastTextIdx = i;
  }
  let numAfterText = 0;
  for (let i = lastTextIdx + 1; i < words.length; i++) {
    if (!isNumToken(words[i].text)) return false;
    if (isNumWord(words[i].text)) numAfterText++;
  }
  return numAfterText >= 3;
}

/**
 * @typedef {{left: number, right: number, y: number, y0?: number, y1?: number, segments?: Array<{left: number, right: number}>}} HLine - Horizontal line in display coords (y-down, DPI-scaled).
 * @typedef {{top: number, bottom: number, x: number, x0?: number, x1?: number}} VLine - Vertical line in display coords.
 * On both, `y`/`x` is the ink midline.
 * Only `extractGridSegments` records the band bounds `y0`/`y1` and `x0`/`x1`, so lines from other producers omit them.
 * @typedef {{left: number, top: number, right: number, bottom: number, color: number[]}} FilledRect
 * @typedef {{hLines: HLine[], vLines: VLine[], filledRects: FilledRect[]}} TablePathData
 */

/**
 * @typedef {{
 *   bbox: {left: number, top: number, right: number, bottom: number},
 *   rows: Array<{lineIndices: number[], y: number}>,
 *   colSeparators: number[],
 *   hLines: HLine[],
 *   vLines: VLine[],
 *   rowBandRegion?: RowBandRegion,
 *   detectionMethod?: string,
 *   headerFill?: {left: number, top: number, right: number, bottom: number} | null,
 *   headers?: HeaderInfo | null,
 *   title?: { text: string, bbox: {left: number, top: number, right: number, bottom: number} } | null,
 *   splitTopLocked?: boolean,
 * }} DetectedTable
 */

/**
 * Detect tables in a page. Designed for minimal overhead on non-table pages:
 * Phase 0 exits immediately for single-column text, Phase 1 exits for multi-column text.
 *
 * @param {import('../objects/ocrObjects.js').OcrPage} pageObj - Page with lines already built
 * @param {Array<import('./parsePdfPaths.js').PaintedPath>} paths - Raw vector paths from parsePagePaths
 * @param {number} scale - DPI scale factor (pixels per point)
 * @param {number} visualHeightPts - Page height in points (for coordinate conversion)
 * @param {number} [boxOriginX=0] - X origin of the effective page box (CropBox/MediaBox) in points
 * @param {number} [boxOriginY=0] - Y origin of the effective page box in points
 * @returns {DetectedTable[]}
 */
export function detectTableRegions(pageObj, paths, scale, visualHeightPts, boxOriginX = 0, boxOriginY = 0) {
  const lines = pageObj.lines;
  if (lines.length < 3) return [];

  if (paths.length > MAX_TABLE_DETECTION_PATHS) paths = [];

  // === Phase 0: Quick bail-out ===
  // Dot-leader rows emit each visual row as one line, so a table of them produces zero same-y line pairs.
  // Requiring a cluster keeps the scattered dot-leader citations of a table of authorities from reopening the bail-out.
  let sameYPairs = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    if (Math.abs(lines[i].bbox.top - lines[i + 1].bbox.top) < 5) {
      sameYPairs++;
    }
  }
  let hasDotLeaderCluster = false;
  if (sameYPairs === 0) {
    const dotLeaderYs = [];
    for (const line of lines) {
      if (isRightClusteredNumeric(line.words)) dotLeaderYs.push(line.bbox.top);
    }
    dotLeaderYs.sort((a, b) => a - b);
    for (let i = 0; i + 2 < dotLeaderYs.length; i++) {
      if (dotLeaderYs[i + 2] - dotLeaderYs[i] < 300) {
        hasDotLeaderCluster = true;
        break;
      }
    }
  }
  if (sameYPairs === 0 && !hasDotLeaderCluster) {
    const strictEarly = detectStrictGrids(pageObj, paths, scale, visualHeightPts, boxOriginX, boxOriginY)
      .filter((t) => t.colSeparators.length > 0);
    const segEarly = detectSegmentedHLineGrids(pageObj, paths, scale, visualHeightPts, boxOriginX, boxOriginY);
    for (const st of segEarly) {
      let blocked = false;
      for (const v of strictEarly) {
        if (bboxOverlap(v.bbox, st.bbox) > 0.3) { blocked = true; break; }
      }
      if (!blocked) strictEarly.push(st);
    }
    const pathDataEarly = classifyPaths(paths, scale, visualHeightPts, pageObj, boxOriginX, boxOriginY);
    const headerRuleEarly = detectHeaderRuleTables(pathDataEarly.hLines, pageObj);
    for (const ht of headerRuleEarly) {
      let blocked = false;
      for (const v of strictEarly) {
        if (bboxOverlap(v.bbox, ht.bbox) > 0.3) { blocked = true; break; }
      }
      if (!blocked) strictEarly.push(ht);
    }
    return strictEarly;
  }

  // === Phase 1: Row analysis and table-like row identification ===
  const rows = groupLinesIntoRows(lines);
  const tableLikeRows = [];

  for (const row of rows) {
    if (row.lineIndices.length < 2) {
      if (row.lineIndices.length === 1 && isRightClusteredNumeric(lines[row.lineIndices[0]].words)) {
        tableLikeRows.push({ ...row, hasNumbers: true });
      }
      continue;
    }

    // A table's cells at one y are consecutive in the lines array, while multi-column page text at the same y is written column by column and lands far apart.
    const indices = row.lineIndices;
    let maxGap = 0;
    for (let i = 1; i < indices.length; i++) {
      const gap = indices[i] - indices[i - 1];
      if (gap > maxGap) maxGap = gap;
    }
    const isConsecutive = maxGap <= 2;
    if (!isConsecutive) {
      const subRows = [];
      let currentSub = [indices[0]];
      for (let j = 1; j < indices.length; j++) {
        if (indices[j] - indices[j - 1] <= 2) {
          currentSub.push(indices[j]);
        } else {
          subRows.push(currentSub);
          currentSub = [indices[j]];
        }
      }
      subRows.push(currentSub);

      // A table can be written column by column, one cell per line, so its rows fail the consecutiveness test above.
      // Requiring bare numeric tokens is what keeps ordinary two-column page text out, since its fragments are word-rich.
      if (subRows.length >= 4) {
        let pureNumericSubs = 0;
        for (const sub of subRows) {
          if (sub.length === 1) {
            const w = lines[sub[0]].words;
            if (w.length === 1 && /^[\d,$%.()+-]+$/.test(w[0].text) && /\d/.test(w[0].text)) {
              pureNumericSubs++;
            }
          }
        }
        if (pureNumericSubs >= 3) {
          tableLikeRows.push({ y: row.y, lineIndices: indices.slice(), hasNumbers: true });
          continue;
        }
      }

      for (const sub of subRows) {
        if (sub.length < 2) {
          if (sub.length === 1 && isRightClusteredNumeric(lines[sub[0]].words)) {
            tableLikeRows.push({ y: lines[sub[0]].bbox.top, lineIndices: sub, hasNumbers: true });
          }
          continue;
        }
        let subNumericCount = 0;
        for (const idx of sub) {
          for (const word of lines[idx].words) {
            if (/^[\d,$%.()+-]+$/.test(word.text) && /\d/.test(word.text)) subNumericCount++;
          }
        }
        if (subNumericCount >= 1 || sub.length >= 3) {
          const subY = sub.reduce((sum, idx) => sum + lines[idx].bbox.top, 0) / sub.length;
          tableLikeRows.push({ y: subY, lineIndices: sub, hasNumbers: subNumericCount >= 1 });
        }
      }
      continue;
    }

    let numericWordCount = 0;
    for (const idx of indices) {
      for (const word of lines[idx].words) {
        if (/^[\d,$%.()+-]+$/.test(word.text) && /\d/.test(word.text)) {
          numericWordCount++;
        }
      }
    }
    const hasNumbers = numericWordCount >= 1;

    if (hasNumbers || indices.length >= 3) {
      tableLikeRows.push({ ...row, hasNumbers });
    }
  }

  if (tableLikeRows.length === 0) {
    const strictFallback = detectStrictGrids(pageObj, paths, scale, visualHeightPts, boxOriginX, boxOriginY)
      .filter((t) => t.colSeparators.length > 0);
    const segFallback = detectSegmentedHLineGrids(pageObj, paths, scale, visualHeightPts, boxOriginX, boxOriginY);
    for (const st of segFallback) {
      let blocked = false;
      for (const v of strictFallback) {
        if (bboxOverlap(v.bbox, st.bbox) > 0.3) { blocked = true; break; }
      }
      if (!blocked) strictFallback.push(st);
    }
    const pathDataFallback = classifyPaths(paths, scale, visualHeightPts, pageObj, boxOriginX, boxOriginY);
    const headerRuleFallback = detectHeaderRuleTables(pathDataFallback.hLines, pageObj);
    for (const ht of headerRuleFallback) {
      let blocked = false;
      for (const v of strictFallback) {
        if (bboxOverlap(v.bbox, ht.bbox) > 0.3) { blocked = true; break; }
      }
      if (!blocked) strictFallback.push(ht);
    }
    return strictFallback;
  }

  // === Phase 2: Group table-like rows into candidate regions ===
  const candidates = groupRowsIntoCandidates(tableLikeRows, lines, pageObj);
  if (candidates.length === 0) {
    const strictFallback = detectStrictGrids(pageObj, paths, scale, visualHeightPts, boxOriginX, boxOriginY)
      .filter((t) => t.colSeparators.length > 0);
    const segFallback = detectSegmentedHLineGrids(pageObj, paths, scale, visualHeightPts, boxOriginX, boxOriginY);
    for (const st of segFallback) {
      let blocked = false;
      for (const v of strictFallback) {
        if (bboxOverlap(v.bbox, st.bbox) > 0.3) { blocked = true; break; }
      }
      if (!blocked) strictFallback.push(st);
    }
    const pathDataFallback = classifyPaths(paths, scale, visualHeightPts, pageObj, boxOriginX, boxOriginY);
    const headerRuleFallback = detectHeaderRuleTables(pathDataFallback.hLines, pageObj);
    for (const ht of headerRuleFallback) {
      let blocked = false;
      for (const v of strictFallback) {
        if (bboxOverlap(v.bbox, ht.bbox) > 0.3) { blocked = true; break; }
      }
      if (!blocked) strictFallback.push(ht);
    }
    return strictFallback;
  }

  // === Phase 3: Path data classification ===
  const pathData = classifyPaths(paths, scale, visualHeightPts, pageObj, boxOriginX, boxOriginY);

  for (const candidate of candidates) {
    correlatePathsWithCandidate(candidate, pathData);
  }

  // === Phase 3.5: Structural row-band extraction ===
  const rowBandRegions = extractRowBandStructure(pathData.filledRects, lines);

  // === Phase 4: Validation ===
  const validated = candidates.filter((c) => validateCandidate(c, lines));

  // A grid with no interior separator is just a box, and letting it replace an overlapping text table would destroy a valid detection.
  const strictGrids = detectStrictGrids(pageObj, paths, scale, visualHeightPts, boxOriginX, boxOriginY)
    .filter((t) => t.colSeparators.length > 0);
  const segGrids = detectSegmentedHLineGrids(pageObj, paths, scale, visualHeightPts, boxOriginX, boxOriginY);
  const gridTables = [...strictGrids];
  for (const st of segGrids) {
    let blocked = false;
    for (const v of strictGrids) {
      if (bboxOverlap(v.bbox, st.bbox) > 0.3) { blocked = true; break; }
    }
    if (!blocked) gridTables.push(st);
  }
  for (const gt of gridTables) {
    for (let i = validated.length - 1; i >= 0; i--) {
      if (bboxOverlap(validated[i].bbox, gt.bbox) > 0.3) {
        validated.splice(i, 1);
      }
    }
    validated.push(gt);
  }

  for (const table of validated) {
    if (!table.detectionMethod) table.detectionMethod = 'text';
  }

  const pageWidthForRbr = pageObj.dims.width;
  /** @type {RowBandRegion[]} */
  const usableRowBandRegions = rowBandRegions.filter(
    (rbr) => (rbr.right - rbr.left) >= pageWidthForRbr * 0.3,
  );

  /** @type {Map<RowBandRegion, DetectedTable[]>} */
  const regionMatches = new Map();
  for (const rbr of usableRowBandRegions) {
    const matches = [];
    for (const cand of validated) {
      if (bboxOverlap(cand.bbox, {
        left: rbr.left, top: rbr.top, right: rbr.right, bottom: rbr.bottom,
      }) > 0.3) {
        matches.push(cand);
      }
    }
    regionMatches.set(rbr, matches);
  }
  /** @type {Map<DetectedTable, RowBandRegion[]>} */
  const candToRegions = new Map();
  for (const [rbr, cands] of regionMatches) {
    for (const c of cands) {
      let arr = candToRegions.get(c);
      if (!arr) { arr = []; candToRegions.set(c, arr); }
      arr.push(rbr);
    }
  }

  const candsToRemove = new Set();
  const candsToAdd = [];

  for (const [cand, regions] of candToRegions) {
    if (regions.length !== 1) continue;
    const rbr = regions[0];
    if (cand.detectionMethod === 'grid-strong') continue;
    cand.rowBandRegion = rbr;
    const prevTop = cand.bbox.top;
    const prevBottom = cand.bbox.bottom;
    const prevLeft = cand.bbox.left;
    const prevRight = cand.bbox.right;
    cand.bbox.top = Math.min(cand.bbox.top, rbr.top);
    cand.bbox.bottom = Math.max(cand.bbox.bottom, rbr.bottom);
    cand.bbox.left = Math.min(cand.bbox.left, rbr.left);
    cand.bbox.right = Math.max(cand.bbox.right, rbr.right);
    // Path-derived column structures do not model the label column, so the old bbox.left was its boundary with the first data column and has to survive as a separator.
    if (cand.bbox.left < prevLeft - 5
        && (cand.detectionMethod === 'header-rule'
            || cand.detectionMethod === 'segmented-hline')) {
      const seps = cand.colSeparators ? [...cand.colSeparators] : [];
      seps.unshift(prevLeft);
      seps.sort((a, b) => a - b);
      cand.colSeparators = seps;
    }
    if (cand.bbox.top < prevTop || cand.bbox.bottom > prevBottom
        || cand.bbox.left < prevLeft - 5 || cand.bbox.right > prevRight + 5) {
      cand.rows = collectRowsInBbox(cand.bbox, lines);
    }
  }

  // A drawn grid outranks these shading-derived regions, so sectioned row coloring must not split a grid-strong table.
  for (const [cand, regions] of candToRegions) {
    if (regions.length < 2) continue;
    if (cand.detectionMethod === 'grid-strong') continue;
    const allHaveFiveBands = regions.every((r) => r.rowYs.length >= 5);
    const allHaveTwoBands = regions.every((r) => r.rowYs.length >= 2);
    const sortedByTop = [...regions].sort((a, b) => a.top - b.top);
    let shouldSplit = false;
    if (regions.length >= 3 && allHaveFiveBands) {
      shouldSplit = true;
    } else if (allHaveTwoBands) {
      // A new column-header row between two banded sections means the second is its own table, while sub-sections of one table run on with no new header.
      let allSeparatedByHeader = true;
      for (let ri = 1; ri < sortedByTop.length; ri++) {
        const gapTop = sortedByTop[ri - 1].bottom;
        const gapBottom = sortedByTop[ri].top;
        /** @type {Array<{y: number, count: number}>} */
        const yGroups = [];
        for (const line of lines) {
          if (line.bbox.top < gapTop || line.bbox.top >= gapBottom) continue;
          if (line.bbox.right < cand.bbox.left || line.bbox.left > cand.bbox.right) continue;
          let matched = false;
          for (const g of yGroups) {
            if (Math.abs(g.y - line.bbox.top) < 5) {
              g.count++;
              matched = true;
              break;
            }
          }
          if (!matched) yGroups.push({ y: line.bbox.top, count: 1 });
        }
        const hasHeaderRow = yGroups.some((g) => g.count >= 2);
        if (!hasHeaderRow) { allSeparatedByHeader = false; break; }
      }
      if (allSeparatedByHeader) shouldSplit = true;
    }
    // An internal break within one table always carries content, so a gap holding no text at all separates sibling tables.
    if (!shouldSplit && regions.length >= 2 && regions.every((r) => r.rowYs.length >= 5)) {
      let allGapsEmpty = true;
      for (let ri = 1; ri < sortedByTop.length; ri++) {
        const gapTop = sortedByTop[ri - 1].bottom;
        const gapBottom = sortedByTop[ri].top;
        if (gapBottom - gapTop < 5) { allGapsEmpty = false; break; }
        for (const line of lines) {
          const yC = (line.bbox.top + line.bbox.bottom) / 2;
          if (yC <= gapTop || yC >= gapBottom) continue;
          if (line.bbox.right < cand.bbox.left || line.bbox.left > cand.bbox.right) continue;
          allGapsEmpty = false;
          break;
        }
        if (!allGapsEmpty) break;
      }
      if (allGapsEmpty) shouldSplit = true;
    }
    if (!shouldSplit) continue;
    candsToRemove.add(cand);
    for (const rbr of regions) {
      for (const c of makeRowBandCandidates(rbr, cand, lines)) candsToAdd.push(c);
    }
  }

  // A region with no matching candidate is a table that coheres by row shading rather than by column-aligned text, so text clustering missed it.
  for (const [rbr, cands] of regionMatches) {
    if (cands.length === 0 && rbr.rowYs.length >= 8) {
      for (const c of makeRowBandCandidates(rbr, null, lines)) candsToAdd.push(c);
    }
  }

  for (const c of candsToRemove) {
    const idx = validated.indexOf(c);
    if (idx >= 0) validated.splice(idx, 1);
  }
  for (const c of candsToAdd) validated.push(c);

  // Header detection runs before column inference and top refinement, which both read table.headers.
  for (const table of validated) {
    table.headers = detectHeaders(table, lines);
  }
  for (const table of validated) {
    extractStructure(table, lines);
  }

  // Runs after extractStructure so the text tables compared against here already have their colSeparators.
  const headerRuleTables = detectHeaderRuleTables(pathData.hLines, pageObj);
  // A column too tight to hold a label or a full numeric value is the signature of text clustering splitting a currency glyph into a column of its own.
  const hasNarrowTextColumn = (table) => {
    const seps = [table.bbox.left, ...table.colSeparators, table.bbox.right];
    for (let i = 1; i < seps.length; i++) {
      if (seps[i] - seps[i - 1] < 100) return true;
    }
    return false;
  };
  for (const ht of headerRuleTables) {
    let blocked = false;
    /** @type {DetectedTable[]} */
    const overlappingText = [];
    for (const v of validated) {
      if (v.detectionMethod === 'grid-strong' || v.detectionMethod === 'segmented-hline') {
        if (bboxOverlap(v.bbox, ht.bbox) > 0.3) { blocked = true; break; }
      } else if (bboxOverlap(v.bbox, ht.bbox) > 0.3) {
        overlappingText.push(v);
      }
    }
    if (blocked) continue;
    if (overlappingText.length > 0) {
      const htCols = ht.colSeparators.length + 1;
      const maxTextCols = Math.max(...overlappingText.map((t) => t.colSeparators.length + 1));
      const anyNarrow = overlappingText.some(hasNarrowTextColumn);
      // A tie goes to the header-rule table, whose bbox is more often right because it does not truncate the top header rows.
      if (maxTextCols > htCols && !anyNarrow) continue;
    }
    for (let i = validated.length - 1; i >= 0; i--) {
      const v = validated[i];
      if (v.detectionMethod === 'grid-strong' || v.detectionMethod === 'segmented-hline') continue;
      if (bboxOverlap(v.bbox, ht.bbox) > 0.3) {
        validated.splice(i, 1);
      }
    }
    validated.push(ht);
  }

  // === Phase 5.4: Re-attach row-band regions to header-rule tables ===
  for (const cand of validated) {
    if (cand.rowBandRegion) continue;
    /** @type {RowBandRegion[]} */
    const matches = [];
    for (const rbr of rowBandRegions) {
      if (bboxOverlap(cand.bbox, {
        left: rbr.left, top: rbr.top, right: rbr.right, bottom: rbr.bottom,
      }) > 0.3) {
        matches.push(rbr);
      }
    }
    if (matches.length !== 1) continue;
    const rbr = matches[0];
    if (cand.detectionMethod === 'grid-strong') continue;
    cand.rowBandRegion = rbr;
    const prevTop = cand.bbox.top;
    const prevBottom = cand.bbox.bottom;
    const prevLeft = cand.bbox.left;
    const prevRight = cand.bbox.right;
    cand.bbox.top = Math.min(cand.bbox.top, rbr.top);
    cand.bbox.bottom = Math.max(cand.bbox.bottom, rbr.bottom);
    cand.bbox.left = Math.min(cand.bbox.left, rbr.left);
    cand.bbox.right = Math.max(cand.bbox.right, rbr.right);
    if (cand.bbox.left < prevLeft - 5
        && (cand.detectionMethod === 'header-rule'
            || cand.detectionMethod === 'segmented-hline')) {
      const seps = cand.colSeparators ? [...cand.colSeparators] : [];
      seps.unshift(prevLeft);
      seps.sort((a, b) => a - b);
      cand.colSeparators = seps;
    }
    if (cand.bbox.top < prevTop || cand.bbox.bottom > prevBottom
        || cand.bbox.left < prevLeft - 5 || cand.bbox.right > prevRight + 5) {
      cand.rows = collectRowsInBbox(cand.bbox, lines);
    }
  }

  // Sibling sub-tables such as Assets and Liabilities commonly share one header rule and one banded stripe even though they are structurally separate.
  /** @type {Array<{cand: DetectedTable, splits: DetectedTable[]}>} */
  const splitWork = [];
  for (const cand of validated) {
    if (!cand.rowBandRegion) continue;
    if (!cand.rows || cand.rows.length < 4) continue;
    const sorted = [...cand.rows].sort((a, b) => a.y - b.y);
    const spacings = [];
    for (let i = 1; i < sorted.length; i++) spacings.push(sorted[i].y - sorted[i - 1].y);
    const sortedSpacings = [...spacings].sort((a, b) => a - b);
    const median = sortedSpacings[Math.floor(sortedSpacings.length / 2)];
    /** @type {Array<{start: number, end: number}>} */
    const groups = [{ start: 0, end: 0 }];
    for (let i = 1; i < sorted.length; i++) {
      if (spacings[i - 1] > median * 2 && spacings[i - 1] > 50) {
        groups.push({ start: i, end: i });
      } else {
        groups[groups.length - 1].end = i;
      }
    }
    // Three or more groups are usually internal sub-sections of one larger table, and splitting those would fragment it.
    if (groups.length !== 2) continue;
    // A gap alone is weak evidence, so each group must also close with a Total row to count as a complete table.
    /** @param {{lineIndices: number[], y: number}} rowSpec */
    const endsInTotal = (rowSpec) => {
      for (const li of rowSpec.lineIndices) {
        const text = lines[li].words.map((w) => w.text).join(' ').trim();
        if (/^Total\b/i.test(text)) return true;
      }
      return false;
    };
    const firstEnd = sorted[groups[0].end];
    const secondEnd = sorted[groups[1].end];
    if (!endsInTotal(firstEnd) || !endsInTotal(secondEnd)) continue;
    const splits = [];
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      if (g.end - g.start < 1) continue;
      const groupRows = sorted.slice(g.start, g.end + 1);
      let groupTop;
      let groupBottom;
      if (gi === 0) {
        groupTop = cand.bbox.top;
      } else {
        groupTop = groupRows[0].y;
      }
      if (gi === groups.length - 1) {
        groupBottom = cand.bbox.bottom;
      } else {
        let maxBot = -Infinity;
        for (const r of groupRows) {
          for (const li of r.lineIndices) {
            if (lines[li].bbox.bottom > maxBot) maxBot = lines[li].bbox.bottom;
          }
        }
        groupBottom = maxBot + 5;
      }
      splits.push({
        bbox: {
          left: cand.bbox.left,
          top: groupTop,
          right: cand.bbox.right,
          bottom: groupBottom,
        },
        rows: groupRows,
        colSeparators: [...(cand.colSeparators || [])],
        hLines: cand.hLines || [],
        vLines: cand.vLines || [],
        detectionMethod: cand.detectionMethod,
        rowBandRegion: cand.rowBandRegion,
        // Without this, refineTableTop's gap scan chains upward through the previous split's data rows and pulls bbox.top to the shared column-header band.
        splitTopLocked: gi > 0,
      });
    }
    if (splits.length >= 2) splitWork.push({ cand, splits });
  }
  for (const { cand, splits } of splitWork) {
    const idx = validated.indexOf(cand);
    if (idx >= 0) validated.splice(idx, 1, ...splits);
  }

  // === Phase 5.5: Refine table top boundaries using header detection ===
  // A path-derived bbox.top comes from drawn geometry and needs no scan, except when a row band marks the first data row and leaves the header rows above it unclaimed.
  // Grid-strong is exempt either way, since its stroked outer rectangle is the table's true top.
  for (const table of validated) {
    const hasBand = !!table.rowBandRegion;
    if (table.splitTopLocked) continue;
    if (table.detectionMethod === 'grid-strong') continue;
    if (!hasBand && table.detectionMethod === 'segmented-hline') continue;
    if (!hasBand && table.detectionMethod === 'header-rule') continue;
    // A stacked sibling whose data rows resemble headers would otherwise chain the upward scan through the entire neighbor, stopping only at its intro prose.
    // The floor keys on this table's first data row because groupRowsIntoCandidates inflated bbox.top by three row heights, so sibling bboxes overlap where their data rows do not.
    const myFirstRowY = table.rows.length > 0
      ? Math.min(...table.rows.map((r) => r.y))
      : table.bbox.top;
    let topFloor = 0;
    for (const other of validated) {
      if (other === table) continue;
      if (other.bbox.bottom <= myFirstRowY
          && other.bbox.bottom > topFloor
          && other.bbox.right >= table.bbox.left
          && other.bbox.left <= table.bbox.right) {
        topFloor = other.bbox.bottom;
      }
    }
    refineTableTop(table, lines, topFloor);
  }

  // === Phase 5.55: Detect table titles ===
  for (const table of validated) {
    table.title = detectTableTitle(table, lines);
  }

  // A column too narrow to hold cell content comes from word clustering on noise, a stray footnote marker or page number pulled into a column of its own.
  const multiCol = validated.filter((t) => {
    if (t.colSeparators.length === 0) return false;
    if (t.detectionMethod !== 'text') return true;
    const seps = [t.bbox.left, ...t.colSeparators, t.bbox.right];
    for (let i = 1; i < seps.length; i++) {
      if (seps[i] - seps[i - 1] < 30) return false;
    }
    return true;
  });

  // === Phase 5.6: Extend tables to adjacent structural content ===
  // Runs after the multiCol filter, since the separator and rows the extension adds would otherwise promote a single-column or sub-3-row non-table into a valid one.
  for (const table of multiCol) {
    if (table.detectionMethod === 'grid-strong') continue;
    if (table.detectionMethod === 'segmented-hline') continue;
    if (table.detectionMethod === 'header-rule') continue;
    extendTableToAdjacentContent(table, lines, multiCol);
  }

  // === Phase 5.7: Refine text-table column structure from rule clusters ===
  const ruleClusters = findDisjointRuleClusters(pathData.hLines, pageObj);
  for (const table of multiCol) {
    if (table.detectionMethod !== 'text') continue;
    /** @type {{y: number, cols: Array<{left: number, right: number}>} | null} */
    let bestCluster = null;
    for (const cluster of ruleClusters) {
      if (cluster.y < table.bbox.top - 30 || cluster.y > table.bbox.bottom + 30) continue;
      const ruleLeft = cluster.cols[0].left;
      const ruleRight = cluster.cols[cluster.cols.length - 1].right;
      if (ruleLeft < table.bbox.left - 30) continue;
      if (ruleRight > table.bbox.right + 30) continue;
      if (!bestCluster || cluster.cols.length > bestCluster.cols.length) {
        bestCluster = cluster;
      }
    }
    if (!bestCluster) continue;
    // A rule set can underline only the major groupings while text clustering sees the sub-columns, so a higher text column count wins.
    const wouldSynthesizeLabel = table.bbox.left < bestCluster.cols[0].left - 20;
    const newColCount = bestCluster.cols.length + (wouldSynthesizeLabel ? 1 : 0);
    const currentColCount = table.colSeparators.length + 1;
    if (currentColCount > newColCount) continue;
    const newSeps = [];
    if (wouldSynthesizeLabel) newSeps.push(bestCluster.cols[0].left);
    for (let i = 1; i < bestCluster.cols.length; i++) {
      newSeps.push((bestCluster.cols[i - 1].right + bestCluster.cols[i].left) / 2);
    }
    newSeps.sort((a, b) => a - b);
    table.colSeparators = newSeps;
  }

  // === Phase 6: Stream order validation ===
  return multiCol.filter((t) => t.detectionMethod === 'grid-strong' || validateStreamOrder(t, lines));
}

/**
 * Collect lines whose bbox sits inside `bbox` and group them into rows.
 * @param {{left: number, top: number, right: number, bottom: number}} bbox
 * @param {any[]} lines
 */
function collectRowsInBbox(bbox, lines) {
  /** @type {number[]} */
  const regionLineIndices = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.bbox.top >= bbox.top - 5 && line.bbox.bottom <= bbox.bottom + 5
        && line.bbox.left >= bbox.left - 10 && line.bbox.right <= bbox.right + 10) {
      regionLineIndices.push(i);
    }
  }
  const regionLines = regionLineIndices.map((i) => lines[i]);
  const rowGroups = groupLinesIntoRows(regionLines);
  return rowGroups.map((rg) => ({
    lineIndices: rg.lineIndices.map((i) => regionLineIndices[i]),
    y: rg.y,
  }));
}

/**
 * Build synthetic table candidates seeded from a row-band region.
 *
 * @param {RowBandRegion} rbr
 * @param {DetectedTable | null} baseCand
 * @param {any[]} lines
 * @returns {DetectedTable[]}
 */
function makeRowBandCandidates(rbr, baseCand, lines) {
  const left = baseCand ? Math.min(baseCand.bbox.left, rbr.left) : rbr.left;
  const right = baseCand ? Math.max(baseCand.bbox.right, rbr.right) : rbr.right;
  const bbox = {
    left, top: rbr.top, right, bottom: rbr.bottom,
  };
  const rows = collectRowsInBbox(bbox, lines);
  if (rows.length < 3) {
    return [{
      bbox,
      rows,
      colSeparators: [],
      hLines: [],
      vLines: [],
      detectionMethod: 'row-band',
      rowBandRegion: rbr,
    }];
  }
  const sorted = [...rows].sort((a, b) => a.y - b.y);
  const spacings = [];
  for (let i = 1; i < sorted.length; i++) spacings.push(sorted[i].y - sorted[i - 1].y);
  const sortedSpacings = [...spacings].sort((a, b) => a - b);
  const medianSpacing = sortedSpacings[Math.floor(sortedSpacings.length / 2)];
  /** @type {Array<{startIdx: number, endIdx: number}>} */
  const groups = [{ startIdx: 0, endIdx: 0 }];
  for (let i = 1; i < sorted.length; i++) {
    const last = groups[groups.length - 1];
    if (spacings[i - 1] > medianSpacing * 2 && spacings[i - 1] > 50) {
      groups.push({ startIdx: i, endIdx: i });
    } else {
      last.endIdx = i;
    }
  }
  if (groups.length === 1) {
    return [{
      bbox,
      rows,
      colSeparators: [],
      hLines: [],
      vLines: [],
      detectionMethod: 'row-band',
      rowBandRegion: rbr,
    }];
  }
  return groups
    .filter((g) => g.endIdx - g.startIdx >= 2)
    .map((g) => {
      const groupRows = sorted.slice(g.startIdx, g.endIdx + 1);
      let groupBottom = -Infinity;
      for (const r of groupRows) {
        for (const li of r.lineIndices) {
          if (lines[li].bbox.bottom > groupBottom) groupBottom = lines[li].bbox.bottom;
        }
      }
      // The first group keeps the band region's top so header rows above the first data row stay inside.
      // A later group starts at its own first row so its bbox does not reach back into the previous group.
      const subBbox = {
        left,
        top: g.startIdx === 0 ? bbox.top : groupRows[0].y,
        right,
        bottom: g.endIdx === sorted.length - 1 ? bbox.bottom : groupBottom + 5,
      };
      return {
        bbox: subBbox,
        rows: collectRowsInBbox(subBbox, lines),
        colSeparators: [],
        hLines: [],
        vLines: [],
        detectionMethod: 'row-band',
        rowBandRegion: rbr,
      };
    });
}

/**
 * Group lines into rows by y-proximity (within 5pt tolerance).
 * Returns rows sorted by y position, each containing the line indices.
 */
function groupLinesIntoRows(lines) {
  /** @type {Array<{y: number, lineIndices: number[]}>} */
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const top = lines[i].bbox.top;
    let added = false;
    for (const row of rows) {
      if (Math.abs(top - row.y) <= 5) {
        row.lineIndices.push(i);
        // Update average y
        row.y = row.lineIndices.reduce((sum, idx) => sum + lines[idx].bbox.top, 0) / row.lineIndices.length;
        added = true;
        break;
      }
    }
    if (!added) {
      rows.push({ y: top, lineIndices: [i] });
    }
  }
  rows.sort((a, b) => a.y - b.y);
  return rows;
}

/**
 * Find runs of consecutive table-like rows to form candidate regions.
 * Requires 3+ consecutive rows with numbers, or 4+ without numbers.
 */
function groupRowsIntoCandidates(tableLikeRows, lines, pageObj) {
  // Sort by y
  tableLikeRows.sort((a, b) => a.y - b.y);

  // Compute a dynamic y-gap threshold from the median spacing between table-like rows.
  // This adapts to the DPI scale (coordinates may be in pixels at 300 DPI, not points).
  let yGapThreshold = 150; // fallback
  if (tableLikeRows.length >= 3) {
    const spacings = [];
    for (let i = 1; i < tableLikeRows.length; i++) {
      spacings.push(tableLikeRows[i].y - tableLikeRows[i - 1].y);
    }
    spacings.sort((a, b) => a - b);
    const medianSpacing = spacings[Math.floor(spacings.length / 2)];
    yGapThreshold = Math.max(medianSpacing * 3, 150);
  }
  const pageHeight = pageObj && pageObj.dims ? pageObj.dims.height : Infinity;
  yGapThreshold = Math.min(yGapThreshold, pageHeight * 0.2);

  /** @type {DetectedTable[]} */
  const candidates = [];
  let runStart = 0;

  for (let i = 1; i <= tableLikeRows.length; i++) {
    // A section header between two table rows must not end the run, so a gap that a short chain of intervening lines steps across still counts as continuous.
    let isContinuation = false;
    if (i < tableLikeRows.length) {
      const directGap = tableLikeRows[i].y - tableLikeRows[i - 1].y;
      if (directGap < yGapThreshold) {
        isContinuation = true;
      } else {
        const yLow = tableLikeRows[i - 1].y;
        const yHigh = tableLikeRows[i].y;

        // Widening this beyond the two rows bracketing the gap would pull in rows from other page columns, letting unrelated prose inflate the intervening-line count.
        let runLeft = Infinity;
        let runRight = -Infinity;
        for (const ri of [i - 1, i]) {
          for (const idx of tableLikeRows[ri].lineIndices) {
            if (lines[idx].bbox.left < runLeft) runLeft = lines[idx].bbox.left;
            if (lines[idx].bbox.right > runRight) runRight = lines[idx].bbox.right;
          }
        }

        const runWidth = runRight - runLeft;
        const xTol = Math.max(50, runWidth * 0.05);
        const bracketSet = new Set();
        for (const ri of [i - 1, i]) {
          for (const idx of tableLikeRows[ri].lineIndices) bracketSet.add(idx);
        }
        const bridgeYs = [yLow];
        let anyWide = false;
        for (let li = 0; li < lines.length; li++) {
          if (bracketSet.has(li)) continue;
          const ly = lines[li].bbox.top;
          if (ly > yLow && ly < yHigh) {
            // A section header sits left of the data at the label-column indent, so the window reaches left of the rows but not right.
            const lx = lines[li].bbox.left;
            if (lx >= runLeft - xTol && lx <= runRight) {
              bridgeYs.push(ly);
              // Section headers are short; paragraph/footnote text spans most of the width.
              const lineWidth = lines[li].bbox.right - lines[li].bbox.left;
              if (lineWidth > runWidth * 0.6) anyWide = true;
            }
          }
        }
        const interveningCount = bridgeYs.length - 1;
        if (interveningCount > 0 && interveningCount <= 3 && !anyWide) {
          bridgeYs.push(yHigh);
          bridgeYs.sort((a, b) => a - b);

          let maxStep = 0;
          for (let s = 1; s < bridgeYs.length; s++) {
            const step = bridgeYs[s] - bridgeYs[s - 1];
            if (step > maxStep) maxStep = step;
          }
          if (maxStep < yGapThreshold) {
            isContinuation = true;
          }
        }
      }
    }

    if (!isContinuation) {
      const run = tableLikeRows.slice(runStart, i);
      const hasAnyNumbers = run.some((r) => r.hasNumbers);
      const minRows = hasAnyNumbers ? 3 : 4;

      if (run.length >= minRows) {
        // Tables in different page columns can sit close enough vertically to form a single run.
        const rowExtents = run.map((r) => {
          let left = Infinity;
          let right = -Infinity;
          for (const idx of r.lineIndices) {
            if (lines[idx].bbox.left < left) left = lines[idx].bbox.left;
            if (lines[idx].bbox.right > right) right = lines[idx].bbox.right;
          }
          return { left, right };
        });

        const parent = run.map((_, idx) => idx);
        const find = (idx) => { while (parent[idx] !== idx) { parent[idx] = parent[parent[idx]]; idx = parent[idx]; } return idx; };
        const unite = (a, b) => { parent[find(a)] = find(b); };

        for (let a = 0; a < run.length; a++) {
          for (let b = a + 1; b < run.length; b++) {
            if (rowExtents[a].right > rowExtents[b].left + 10 && rowExtents[b].right > rowExtents[a].left + 10) {
              unite(a, b);
            }
          }
        }

        const clusters = {};
        for (let j = 0; j < run.length; j++) {
          const root = find(j);
          if (!clusters[root]) clusters[root] = [];
          clusters[root].push(run[j]);
        }

        for (const cluster of Object.values(clusters)) {
          if (cluster.length < minRows) continue;
          cluster.sort((a, b) => a.y - b.y);

          // The first bridge test measured width against a cross-column x-extent, so paragraph text filling a single column did not look wide enough to block the bridge.
          // Now that x-clustering has separated the columns, the same test against the cluster's own width splits the merged tables.
          let clusterLeft = Infinity;
          let clusterRight = -Infinity;
          for (const r of cluster) {
            for (const idx of r.lineIndices) {
              if (lines[idx].bbox.left < clusterLeft) clusterLeft = lines[idx].bbox.left;
              if (lines[idx].bbox.right > clusterRight) clusterRight = lines[idx].bbox.right;
            }
          }
          const clusterWidth = clusterRight - clusterLeft;
          const clusterXTol = Math.max(50, clusterWidth * 0.05);

          const splitPoints = [0];
          for (let k = 1; k < cluster.length; k++) {
            const gap = cluster[k].y - cluster[k - 1].y;
            if (gap <= yGapThreshold) continue;

            const yLow = cluster[k - 1].y;
            const yHigh = cluster[k].y;
            const bracketSet2 = new Set();
            for (const ki of [k - 1, k]) {
              for (const idx of cluster[ki].lineIndices) bracketSet2.add(idx);
            }
            const bridgeYs = [yLow];
            let anyWide = false;
            for (let li = 0; li < lines.length; li++) {
              if (bracketSet2.has(li)) continue;
              const ly = lines[li].bbox.top;
              if (ly > yLow && ly < yHigh) {
                const lx = lines[li].bbox.left;
                if (lx >= clusterLeft - clusterXTol && lx <= clusterRight) {
                  bridgeYs.push(ly);
                  const lineWidth = lines[li].bbox.right - lines[li].bbox.left;
                  if (lineWidth > clusterWidth * 0.6) anyWide = true;
                }
              }
            }
            const interveningCount = bridgeYs.length - 1;
            let bridgeOK = false;
            if (interveningCount > 0 && interveningCount <= 3 && !anyWide) {
              bridgeYs.push(yHigh);
              bridgeYs.sort((a, b) => a - b);
              let maxStep = 0;
              for (let s = 1; s < bridgeYs.length; s++) {
                const step = bridgeYs[s] - bridgeYs[s - 1];
                if (step > maxStep) maxStep = step;
              }
              if (maxStep < yGapThreshold) bridgeOK = true;
            }
            if (!bridgeOK) splitPoints.push(k);
          }
          splitPoints.push(cluster.length);

          for (let si = 0; si < splitPoints.length - 1; si++) {
            const subCluster = cluster.slice(splitPoints[si], splitPoints[si + 1]);
            if (subCluster.length < minRows) continue;
            const allLineIndices = subCluster.flatMap((r) => r.lineIndices);
            const bbox = computeBboxFromLineIndices(allLineIndices, lines);
            const avgRowHeight = (bbox.bottom - bbox.top) / subCluster.length;
            // Expanded generously to give path correlation room, since Phase 5.5 refines the real top once hLine data exists.
            bbox.top = Math.max(0, bbox.top - avgRowHeight * 3);

            candidates.push({
              bbox,
              rows: subCluster.map((r) => ({ lineIndices: r.lineIndices, y: r.y })),
              colSeparators: [],
              hLines: [],
              vLines: [],
            });
          }
        }
      }
      runStart = i;
    }
  }

  return candidates;
}

/**
 * Classify vector paths into horizontal lines, vertical lines, filled rectangles, and header fills.
 * Applies filtering to remove page borders, margin rules, and underlines.
 * @param {Array<import('./parsePdfPaths.js').PaintedPath>} paths
 * @param {number} scale
 * @param {number} visualHeightPts
 * @param {import('../objects/ocrObjects.js').OcrPage} pageObj
 * @param {number} [boxOriginX]
 * @param {number} [boxOriginY]
 */
function classifyPaths(paths, scale, visualHeightPts, pageObj, boxOriginX = 0, boxOriginY = 0) {
  const pageHeight = pageObj.dims.height;
  const pageWidth = pageObj.dims.width;

  // A cell border is at least as wide as one character, which the median line height approximates.
  const lineHeightsPts = pageObj.lines
    .map((l) => (l.bbox.bottom - l.bbox.top) / scale)
    .filter((h) => h > 2 && h < 100);
  lineHeightsPts.sort((a, b) => a - b);
  const minHLineWidthPts = lineHeightsPts.length > 0
    ? lineHeightsPts[Math.floor(lineHeightsPts.length / 2)]
    : 30;

  // Table grid lines are black or gray while chart bars and decorative elements are saturated, so filtering chromatic paths keeps colored chart content from forming phantom grids.
  const isAchromaticColor = (color) => {
    if (!color || color.length === 0) return true;
    if (color.length === 1) return true;
    if (color.length === 3) {
      const maxC = Math.max(color[0], color[1], color[2]);
      const minC = Math.min(color[0], color[1], color[2]);
      return (maxC - minC) < 0.15;
    }
    if (color.length === 4) return color[0] < 0.15 && color[1] < 0.15 && color[2] < 0.15;
    return true;
  };
  const isPathAchromatic = (path) => isAchromaticColor(path.stroke ? path.strokeColor : path.fillColor);

  /** @param {number[] | null | undefined} color */
  const isRowBandColor = (color) => {
    if (isAchromaticColor(color)) return true;
    if (!color) return false;
    if (color.length === 3) return color[0] >= 0.5 && color[1] >= 0.5 && color[2] >= 0.5;
    return false;
  };

  // Table cells drawn with `re S` tile perfectly, sharing a border with each neighbor, while org chart boxes and diagram outlines sit isolated with gaps.
  const tilingRectSet = new Set();
  const strokedRectBounds = [];
  for (let pi = 0; pi < paths.length; pi++) {
    const path = paths[pi];
    if (!path.stroke) continue;
    const cmds = path.commands;
    if (cmds.length !== 5 || cmds[0].type !== 'M' || cmds[4].type !== 'Z') continue;
    let rMinX = Infinity;
    let rMaxX = -Infinity;
    let rMinY = Infinity;
    let rMaxY = -Infinity;
    for (const c of cmds) {
      if (c.type === 'Z') continue;
      if (c.x < rMinX) rMinX = c.x; if (c.x > rMaxX) rMaxX = c.x;
      if (c.y < rMinY) rMinY = c.y; if (c.y > rMaxY) rMaxY = c.y;
    }
    if (rMaxX - rMinX > 10 && rMaxY - rMinY > 5) {
      strokedRectBounds.push({
        idx: pi, left: rMinX, right: rMaxX, top: rMinY, bottom: rMaxY,
      });
    }
  }
  for (let i = 0; i < strokedRectBounds.length; i++) {
    if (tilingRectSet.has(strokedRectBounds[i].idx)) continue;
    const a = strokedRectBounds[i];
    for (let j = i + 1; j < strokedRectBounds.length; j++) {
      const b = strokedRectBounds[j];
      const xOverlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const yOverlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      const sharedH = xOverlap > 5 && (Math.abs(a.top - b.bottom) < 2 || Math.abs(a.bottom - b.top) < 2);
      const sharedV = yOverlap > 5 && (Math.abs(a.left - b.right) < 2 || Math.abs(a.right - b.left) < 2);
      if (sharedH || sharedV) {
        tilingRectSet.add(a.idx);
        tilingRectSet.add(b.idx);
      }
    }
  }

  /** @type {HLine[]} */
  const hLines = [];
  /** @type {VLine[]} */
  const vLines = [];
  /** @type {FilledRect[]} */
  const filledRects = [];
  const headerFills = [];

  for (let pathIdx = 0; pathIdx < paths.length; pathIdx++) {
    const path = paths[pathIdx];
    if (!path.fill && !path.stroke) continue;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const cmd of path.commands) {
      if (cmd.type === 'Z') continue;
      if (cmd.x < minX) minX = cmd.x;
      if (cmd.x > maxX) maxX = cmd.x;
      if (cmd.y < minY) minY = cmd.y;
      if (cmd.y > maxY) maxY = cmd.y;
    }
    if (!isFinite(minX)) continue;

    const w = maxX - minX;
    const h = maxY - minY;

    // A PDF can draw a whole table grid as many discrete M-L segments inside one stroked path rather than as separate paths or rectangles.
    const cmds = path.commands;
    if (path.stroke && cmds.length >= 4) {
      let mlSegments = 0;
      for (let k = 0; k < cmds.length - 1; k++) {
        if (cmds[k].type === 'M' && cmds[k + 1].type === 'L') mlSegments++;
      }
      if (mlSegments >= 6 && isPathAchromatic(path)) {
        for (let k = 0; k < cmds.length - 1; k++) {
          if (cmds[k].type !== 'M' && cmds[k].type !== 'L') continue;
          if (cmds[k + 1].type !== 'L') continue;
          const p1 = cmds[k];
          const p2 = cmds[k + 1];
          const segW = Math.abs(p2.x - p1.x);
          const segH = Math.abs(p2.y - p1.y);
          if (segH < 2 && segW >= minHLineWidthPts) {
            const segY = (visualHeightPts - ((p1.y + p2.y) / 2 - boxOriginY)) * scale;
            if (segY >= pageHeight * 0.05 && segY <= pageHeight * 0.95) {
              hLines.push({
                left: (Math.min(p1.x, p2.x) - boxOriginX) * scale,
                right: (Math.max(p1.x, p2.x) - boxOriginX) * scale,
                y: segY,
              });
            }
          } else if (segW < 2 && segH > 10) {
            const segX = ((p1.x + p2.x) / 2 - boxOriginX) * scale;
            const segTop = (visualHeightPts - (Math.max(p1.y, p2.y) - boxOriginY)) * scale;
            const segBot = (visualHeightPts - (Math.min(p1.y, p2.y) - boxOriginY)) * scale;
            if ((segBot - segTop) <= pageHeight * 0.8) {
              vLines.push({ top: segTop, bottom: segBot, x: segX });
            }
          }
        }
        continue;
      }
    }

    // A PDF can draw alternating row backgrounds, or per-cell fills, as a single fill path holding many M-L-L-L-Z subpath rectangles.
    if (path.fill && cmds.length >= 10 && isRowBandColor(path.fillColor)) {
      const subRects = [];
      for (let k = 0; k + 4 < cmds.length; k++) {
        if (cmds[k].type !== 'M') continue;
        if (cmds[k + 1].type !== 'L' || cmds[k + 2].type !== 'L'
            || cmds[k + 3].type !== 'L' || cmds[k + 4].type !== 'Z') continue;
        const p0 = cmds[k];
        const p1 = cmds[k + 1];
        const p2 = cmds[k + 2];
        const p3 = cmds[k + 3];
        const tol = 0.01;
        const horizFirst = Math.abs(p0.y - p1.y) < tol && Math.abs(p2.y - p3.y) < tol
                        && Math.abs(p0.x - p3.x) < tol && Math.abs(p1.x - p2.x) < tol;
        const vertFirst = Math.abs(p0.x - p1.x) < tol && Math.abs(p2.x - p3.x) < tol
                       && Math.abs(p0.y - p3.y) < tol && Math.abs(p1.y - p2.y) < tol;
        if (!horizFirst && !vertFirst) continue;
        const sMinX = Math.min(p0.x, p1.x, p2.x, p3.x);
        const sMaxX = Math.max(p0.x, p1.x, p2.x, p3.x);
        const sMinY = Math.min(p0.y, p1.y, p2.y, p3.y);
        const sMaxY = Math.max(p0.y, p1.y, p2.y, p3.y);
        subRects.push({
          minX: sMinX, maxX: sMaxX, minY: sMinY, maxY: sMaxY,
        });
        k += 4;
      }
      if (subRects.length >= 2) {
        for (const sr of subRects) {
          const sw = sr.maxX - sr.minX;
          const sh = sr.maxY - sr.minY;
          if (sw <= minHLineWidthPts) continue;
          if (sh <= minHLineWidthPts * 0.3 || sh >= minHLineWidthPts * 5) continue;
          filledRects.push({
            left: (sr.minX - boxOriginX) * scale,
            top: (visualHeightPts - (sr.maxY - boxOriginY)) * scale,
            right: (sr.maxX - boxOriginX) * scale,
            bottom: (visualHeightPts - (sr.minY - boxOriginY)) * scale,
            color: path.fillColor || [],
          });
        }
        continue;
      }
    }

    // An isolated rect must not be decomposed, since its four edges cluster into a phantom grid.
    if (path.stroke && cmds.length === 5
        && cmds[0].type === 'M' && cmds[1].type === 'L'
        && cmds[2].type === 'L' && cmds[3].type === 'L'
        && cmds[4].type === 'Z'
        && w > 10 && h > 5
        && tilingRectSet.has(pathIdx)) {
      const pts = [cmds[0], cmds[1], cmds[2], cmds[3]];
      for (let k = 0; k < 4; k++) {
        const p1 = pts[k];
        const p2 = pts[(k + 1) % 4];
        const segW = Math.abs(p2.x - p1.x);
        const segH = Math.abs(p2.y - p1.y);
        if (segH < 2 && segW >= minHLineWidthPts) {
          const segY = (visualHeightPts - ((p1.y + p2.y) / 2 - boxOriginY)) * scale;
          if (segY >= pageHeight * 0.05 && segY <= pageHeight * 0.95) {
            hLines.push({
              left: (Math.min(p1.x, p2.x) - boxOriginX) * scale,
              right: (Math.max(p1.x, p2.x) - boxOriginX) * scale,
              y: segY,
            });
          }
        } else if (segW < 2 && segH > 10) {
          const segX = ((p1.x + p2.x) / 2 - boxOriginX) * scale;
          const segTop = (visualHeightPts - (Math.max(p1.y, p2.y) - boxOriginY)) * scale;
          const segBot = (visualHeightPts - (Math.min(p1.y, p2.y) - boxOriginY)) * scale;
          if ((segBot - segTop) <= pageHeight * 0.8) {
            vLines.push({ top: segTop, bottom: segBot, x: segX });
          }
        }
      }
      continue;
    }

    // Convert from PDF coords (y-up) to display coords (y-down), scaled to DPI
    const displayLeft = (minX - boxOriginX) * scale;
    const displayRight = (maxX - boxOriginX) * scale;
    const displayTop = (visualHeightPts - (maxY - boxOriginY)) * scale;
    const displayBottom = (visualHeightPts - (minY - boxOriginY)) * scale;

    if (h < 2 && w >= minHLineWidthPts && isPathAchromatic(path)) {
      const displayY = (visualHeightPts - ((minY + maxY) / 2 - boxOriginY)) * scale;

      // A rule in the top or bottom 5% of the page is a border, not a table line.
      if (displayY < pageHeight * 0.05 || displayY > pageHeight * 0.95) continue;

      hLines.push({ left: displayLeft, right: displayRight, y: displayY });
    } else if (w < 2 && h > 10 && isPathAchromatic(path)) {
      const displayX = ((minX + maxX) / 2 - boxOriginX) * scale;
      const vLineHeight = displayBottom - displayTop;

      // A rule spanning most of the page height is a margin rule.
      if (vLineHeight > pageHeight * 0.8) continue;

      vLines.push({ top: displayTop, bottom: displayBottom, x: displayX });
    } else if (path.fill && w > minHLineWidthPts && h > minHLineWidthPts * 0.5 && h < minHLineWidthPts * 5
        && isRowBandColor(path.fillColor)) {
      filledRects.push({
        left: displayLeft,
        top: displayTop,
        right: displayRight,
        bottom: displayBottom,
        color: path.fillColor || [],
      });
    } else if (path.fill && w > minHLineWidthPts * 5 && h >= minHLineWidthPts * 3 && h < pageHeight * 0.3
        && isPathAchromatic(path)) {
      // A fill too tall to be a row band can still mark a header area.
      headerFills.push({
        left: displayLeft,
        top: displayTop,
        right: displayRight,
        bottom: displayBottom,
        color: path.fillColor || [],
      });
    }
  }

  reconstituteDashedLines(paths, hLines, vLines, scale, visualHeightPts, boxOriginX, boxOriginY, pageHeight);

  // A column rule's segments individually look like word underlines, so they are exempted from the underline filter below that would otherwise delete the table's column geometry.
  const rulingRowMembers = new Set();
  {
    const yGroups = [];
    for (const hl of hLines) {
      let group = null;
      for (const g of yGroups) {
        if (Math.abs(g.y - hl.y) <= 3) { group = g; break; }
      }
      if (group) {
        group.lines.push(hl);
        group.y = group.lines.reduce((s, l) => s + l.y, 0) / group.lines.length;
      } else {
        yGroups.push({ y: hl.y, lines: [hl] });
      }
    }
    for (const g of yGroups) {
      if (g.lines.length < 2) continue;
      const sorted = [...g.lines].sort((a, b) => a.left - b.left);
      let disjoint = true;
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].left < sorted[i - 1].right - 1) { disjoint = false; break; }
      }
      if (!disjoint) continue;
      for (const hl of g.lines) rulingRowMembers.add(hl);
    }
  }

  // An hLine whose x-extent matches a single text line just above it is that line's underline, not a table border.
  const filteredHLines = hLines.filter((hl) => {
    if (rulingRowMembers.has(hl)) return true;
    for (const line of pageObj.lines) {
      const lineBottom = line.bbox.bottom;
      const yDist = Math.abs(hl.y - lineBottom);
      if (yDist > 5) continue;
      const lineLeft = line.bbox.left;
      const lineRight = line.bbox.right;
      if (Math.abs(hl.left - lineLeft) < 10 && Math.abs(hl.right - lineRight) < 10) {
        return false;
      }
    }
    return true;
  });

  // Per-cell borders emit a separate segment per cell edge, and unmerged the rightmost column's segments cluster on their own and the column is lost.
  // Ruling-row members merge only among themselves, since the 5px merge tolerance is looser than the 3px ruling-row grouping and a separate full-width rule just below can land in the same group.
  // Such a rule overlaps every underline, so merging would fuse the ruling row into one full-width line and erase the column geometry its disjoint segments encode.
  const rulingHLines = filteredHLines.filter((hl) => rulingRowMembers.has(hl));
  const nonRulingHLines = filteredHLines.filter((hl) => !rulingRowMembers.has(hl));
  const mergedHLines = [
    ...mergeCollinearSegments(rulingHLines, 'y', 'left', 'right', 5, 10),
    ...mergeCollinearSegments(nonRulingHLines, 'y', 'left', 'right', 5, 10),
  ];

  // Per-cell vertical borders arrive as separate segments, and unmerged they are rejected by the downstream overlap filters instead of serving as column separators.
  const mergedVLines = mergeCollinearSegments(vLines, 'x', 'top', 'bottom', 5, 10);

  return {
    hLines: mergedHLines, vLines: mergedVLines, filledRects, headerFills,
  };
}

/**
 * @typedef {{
 *   top: number,
 *   bottom: number,
 *   left: number,
 *   right: number,
 *   colXs: number[],
 *   rowYs: Array<{top: number, bottom: number}>,
 * }} RowBandRegion
 *
 * A set of filled rectangles that together form a table-like row-banding pattern.
 * `rowYs` holds one y-interval per row.
 * `colXs` holds the column boundary positions inferred from the dominant disjoint-x pattern across the bands.
 */

/**
 * Extract structural row-band regions from filled rectangles.
 *
 * @param {FilledRect[]} filledRects
 * @param {import('../objects/ocrObjects.js').OcrLine[]} pageLines
 * @returns {RowBandRegion[]}
 */
function extractRowBandStructure(filledRects, pageLines) {
  if (!filledRects || filledRects.length < 3) return [];

  // A fill nested inside a same-color fill has no visible edges, so it contributes no row or column boundary.
  // Identical duplicates compare on index so that exactly one of them survives.
  const sameColor = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 0.01);
  const visible = [];
  for (let i = 0; i < filledRects.length; i++) {
    const f = filledRects[i];
    let contained = false;
    for (let j = 0; j < filledRects.length; j++) {
      if (i === j) continue;
      const g = filledRects[j];
      if (!sameColor(f.color, g.color)) continue;
      const inside = f.left >= g.left - 1 && f.right <= g.right + 1 && f.top >= g.top - 1 && f.bottom <= g.bottom + 1;
      if (!inside) continue;
      const identical = g.left >= f.left - 1 && g.right <= f.right + 1 && g.top >= f.top - 1 && g.bottom <= f.bottom + 1;
      if (!identical || j < i) { contained = true; break; }
    }
    if (!contained) visible.push(f);
  }
  filledRects = visible;

  // Step 1: group fills by y-range
  const yGroups = [];
  for (const f of filledRects) {
    const g = yGroups.find((gg) => Math.abs(gg.top - f.top) < 2 && Math.abs(gg.bottom - f.bottom) < 2);
    if (g) g.items.push(f);
    else yGroups.push({ top: f.top, bottom: f.bottom, items: [f] });
  }

  // Step 2: disjoint x-ranges and raw per-cell extents
  // The merged ranges give the row bbox and the raw per-cell extents give the columns.
  // A boundary between two touching cells is still a real column separator even though the two merge into one contiguous range.
  /** @type {Array<{top: number, bottom: number, ranges: Array<{left: number, right: number}>, cells: Array<{left: number, right: number}>}>} */
  const rowCandidates = [];
  for (const g of yGroups) {
    g.items.sort((a, b) => a.left - b.left);
    const ranges = [];
    const cells = [];
    for (const f of g.items) {
      cells.push({ left: f.left, right: f.right });
      const last = ranges[ranges.length - 1];
      if (last && f.left <= last.right + 0.5) {
        last.right = Math.max(last.right, f.right);
      } else {
        ranges.push({ left: f.left, right: f.right });
      }
    }
    rowCandidates.push({
      top: g.top, bottom: g.bottom, ranges, cells,
    });
  }

  const bands = rowCandidates.filter((c) => {
    if (c.ranges.length === 0) return false;
    const width = c.ranges[c.ranges.length - 1].right - c.ranges[0].left;
    return width > 50; // reject trivially small fills (icons, bullets, etc.)
  });

  if (bands.length < 3) return [];

  // Step 3: cluster bands into regions
  // A zebra table leaves alternate rows unpainted, so a gap that matches the painted row height and holds text is materialized as a virtual band with no cells.
  // The empty cells array is what keeps a virtual band out of the painted-band counts below, while rowYs still reports the true row ladder.
  bands.sort((a, b) => a.top - b.top);

  /** @type {Array<typeof bands>} */
  const regions = [];
  for (const b of bands) {
    const bLeft = b.ranges[0].left;
    const bRight = b.ranges[b.ranges.length - 1].right;
    let added = false;
    for (const r of regions) {
      const last = r[r.length - 1];
      const gap = b.top - last.bottom;
      const lastLeft = last.ranges[0].left;
      const lastRight = last.ranges[last.ranges.length - 1].right;
      const hOverlap = bRight > lastLeft && bLeft < lastRight;
      if (!hOverlap) continue;
      if (gap <= 10) {
        r.push(b);
        added = true;
        break;
      }
      const paintedHeights = r.filter((band) => band.cells.length > 0)
        .map((band) => band.bottom - band.top)
        .sort((x, y) => x - y);
      const medH = paintedHeights[Math.floor(paintedHeights.length / 2)];
      const k = Math.round(gap / medH);
      const intervalUnpainted = !bands.some((other) => other !== last && other !== b
        && other.bottom > last.bottom + 1 && other.top < b.top - 1);
      if (intervalUnpainted && k >= 1 && k <= 2 && Math.abs(gap - k * medH) <= medH * 0.4) {
        let rLeft = Infinity;
        let rRight = -Infinity;
        for (const band of r) {
          if (band.ranges[0].left < rLeft) rLeft = band.ranges[0].left;
          if (band.ranges[band.ranges.length - 1].right > rRight) rRight = band.ranges[band.ranges.length - 1].right;
        }
        const hasText = pageLines.some((line) => {
          const yC = (line.bbox.top + line.bbox.bottom) / 2;
          return yC > last.bottom && yC < b.top && line.bbox.right > rLeft && line.bbox.left < rRight;
        });
        if (hasText) {
          for (let vi = 0; vi < k; vi++) {
            r.push({
              top: last.bottom + (gap * vi) / k,
              bottom: last.bottom + (gap * (vi + 1)) / k,
              ranges: [{ left: rLeft, right: rRight }],
              cells: [],
            });
          }
          r.push(b);
          added = true;
          break;
        }
      }
    }
    if (!added) regions.push([b]);
  }

  // Chaining compares a band only against a region's last band, so a narrow rowspan title cell splits off even though the region's later full-width bands cover it.
  for (let i = regions.length - 1; i >= 0; i--) {
    const a = regions[i];
    const aTop = a[0].top;
    const aBottom = a[a.length - 1].bottom;
    const aLeft = Math.min(...a.map((band) => band.ranges[0].left));
    const aRight = Math.max(...a.map((band) => band.ranges[band.ranges.length - 1].right));
    for (let j = 0; j < regions.length; j++) {
      if (i === j) continue;
      const c = regions[j];
      const cTop = c[0].top;
      const cBottom = c[c.length - 1].bottom;
      const cLeft = Math.min(...c.map((band) => band.ranges[0].left));
      const cRight = Math.max(...c.map((band) => band.ranges[band.ranges.length - 1].right));
      const inside = aTop >= cTop - 5 && aBottom <= cBottom + 5 && aLeft >= cLeft - 5 && aRight <= cRight + 5;
      if (inside && c.length > a.length) {
        c.push(...a);
        c.sort((x, y) => x.top - y.top);
        regions.splice(i, 1);
        break;
      }
    }
  }

  // Step 4: emit a RowBandRegion per region whose column pattern is consistent
  /** @type {RowBandRegion[]} */
  const results = [];
  for (const region of regions) {
    const paintedCount = region.filter((band) => band.cells.length > 0).length;
    if (paintedCount < 3) continue;

    const anchorTol = 3;
    const leftAnchors = [];
    const rightAnchors = [];
    for (const b of region) {
      for (const c of b.cells) {
        leftAnchors.push(c.left);
        rightAnchors.push(c.right);
      }
    }
    /** @param {number[]} values */
    const cluster = (values) => {
      values.sort((a, b) => a - b);
      const clusters = [];
      for (const v of values) {
        const last = clusters[clusters.length - 1];
        if (last && v - last.mean < anchorTol) {
          last.values.push(v);
          last.mean = last.values.reduce((s, x) => s + x, 0) / last.values.length;
        } else {
          clusters.push({ values: [v], mean: v });
        }
      }
      return clusters;
    };
    const leftClusters = cluster(leftAnchors);
    const rightClusters = cluster(rightAnchors);

    // A subtotal row's merged cells appear in only one band, so a majority vote keeps them out of the column set.
    const minCount = Math.ceil(paintedCount / 2);
    const dominantLefts = leftClusters
      .filter((c) => c.values.length >= minCount)
      .map((c) => c.mean)
      .sort((a, b) => a - b);
    const dominantRights = rightClusters
      .filter((c) => c.values.length >= minCount)
      .map((c) => c.mean)
      .sort((a, b) => a - b);

    if (dominantLefts.length < 1) continue;

    const colXs = [];
    for (let i = 0; i < dominantLefts.length - 1; i++) {
      const thisRight = dominantRights[i];
      const nextLeft = dominantLefts[i + 1];
      if (thisRight === undefined || nextLeft === undefined) continue;
      colXs.push((thisRight + nextLeft) / 2);
    }

    const left = dominantLefts[0];
    const right = dominantRights[dominantRights.length - 1];
    const top = region[0].top;
    const bottom = region[region.length - 1].bottom;

    const rowYs = region.map((b) => ({ top: b.top, bottom: b.bottom }));

    results.push({
      top, bottom, left, right, colXs, rowYs,
    });
  }

  return results;
}

/**
 * Merge collinear line segments that share the same position (within tolerance).
 * Groups segments by their position key, then within each group merges
 * overlapping or adjacent segments along the extent axis.
 *
 * @param {Array} segments - Array of segment objects
 * @param {string} posKey - Property name for the fixed position (e.g., 'x' for vLines)
 * @param {string} startKey - Property name for the start of extent (e.g., 'top')
 * @param {string} endKey - Property name for the end of extent (e.g., 'bottom')
 * @param {number} tolerance - Max position difference to group segments as collinear
 * @param {number} [gapTolerance] - Max gap along extent axis to merge (defaults to tolerance)
 */
function mergeCollinearSegments(segments, posKey, startKey, endKey, tolerance, gapTolerance) {
  const extentGap = gapTolerance !== undefined ? gapTolerance : tolerance;
  if (segments.length === 0) return segments;

  // Group by position
  const groups = [];
  for (const seg of segments) {
    let added = false;
    for (const group of groups) {
      if (Math.abs(seg[posKey] - group.pos) <= tolerance) {
        group.segs.push(seg);
        added = true;
        break;
      }
    }
    if (!added) {
      groups.push({ pos: seg[posKey], segs: [seg] });
    }
  }

  const result = [];
  for (const group of groups) {
    // Sort by start position
    group.segs.sort((a, b) => a[startKey] - b[startKey]);

    let current = { ...group.segs[0] };
    let currentParts = [{ [startKey]: group.segs[0][startKey], [endKey]: group.segs[0][endKey] }];
    for (let i = 1; i < group.segs.length; i++) {
      const seg = group.segs[i];
      if (seg[startKey] <= current[endKey] + extentGap) {
        // Merge: extend end
        if (seg[endKey] > current[endKey]) current[endKey] = seg[endKey];
        currentParts.push({ [startKey]: seg[startKey], [endKey]: seg[endKey] });
      } else {
        current.segments = currentParts;
        result.push(current);
        current = { ...seg };
        currentParts = [{ [startKey]: seg[startKey], [endKey]: seg[endKey] }];
      }
    }
    current.segments = currentParts;
    result.push(current);
  }

  return result;
}

/**
 * Reconstitute dashed/dotted lines from discrete short path segments.
 *
 * @param {Array<import('./parsePdfPaths.js').PaintedPath>} paths
 * @param {HLine[]} hLines mutated: any reconstituted horizontal lines are pushed here
 * @param {VLine[]} vLines mutated: any reconstituted vertical lines are pushed here
 * @param {number} scale
 * @param {number} visualHeightPts
 * @param {number} boxOriginX
 * @param {number} boxOriginY
 * @param {number} pageHeight
 */
function reconstituteDashedLines(paths, hLines, vLines, scale, visualHeightPts, boxOriginX, boxOriginY, pageHeight) {
  // A PDF can draw a dashed line as one stroked path per dash instead of using the dash-array operator, leaving segments too short for the normal line-length filter.
  /** @type {Array<{x: number, y1: number, y2: number}>} */
  const vCandidates = [];
  /** @type {Array<{y: number, x1: number, x2: number}>} */
  const hCandidates = [];

  for (const path of paths) {
    if (!path.stroke) continue;
    const cmds = path.commands;
    if (cmds.length !== 2 || cmds[0].type !== 'M' || cmds[1].type !== 'L') continue;
    const w = Math.abs(cmds[1].x - cmds[0].x);
    const h = Math.abs(cmds[1].y - cmds[0].y);
    if (w < 2 && h > 1 && h <= 10) {
      vCandidates.push({
        x: (cmds[0].x + cmds[1].x) / 2,
        y1: Math.min(cmds[0].y, cmds[1].y),
        y2: Math.max(cmds[0].y, cmds[1].y),
      });
    } else if (h < 2 && w > 1 && w <= 30) {
      hCandidates.push({
        y: (cmds[0].y + cmds[1].y) / 2,
        x1: Math.min(cmds[0].x, cmds[1].x),
        x2: Math.max(cmds[0].x, cmds[1].x),
      });
    }
  }

  // Process vertical candidates
  if (vCandidates.length >= 5) {
    const groups = groupByPosition(vCandidates, 'x', 2);
    for (const group of groups) {
      if (group.length < 5) continue;
      group.sort((a, b) => a.y1 - b.y1);
      const gaps = [];
      for (let i = 1; i < group.length; i++) {
        gaps.push(group[i].y1 - group[i - 1].y2);
      }
      const sortedGaps = [...gaps].sort((a, b) => a - b);
      const medianGap = sortedGaps[Math.floor(sortedGaps.length / 2)];
      if (medianGap < 0 || medianGap >= 2) continue; // not a dashed line (negative = overlapping segments)

      // Reconstitute as a single vLine
      const minY = group[0].y1;
      const maxY = group[group.length - 1].y2;
      const avgX = group.reduce((s, g) => s + g.x, 0) / group.length;
      const displayX = (avgX - boxOriginX) * scale;
      const displayTop = (visualHeightPts - (maxY - boxOriginY)) * scale;
      const displayBot = (visualHeightPts - (minY - boxOriginY)) * scale;
      if ((displayBot - displayTop) > pageHeight * 0.8) continue; // skip page-spanning
      vLines.push({ top: displayTop, bottom: displayBot, x: displayX });
    }
  }

  // Process horizontal candidates
  if (hCandidates.length >= 5) {
    const groups = groupByPosition(hCandidates, 'y', 2);
    for (const group of groups) {
      if (group.length < 5) continue;
      group.sort((a, b) => a.x1 - b.x1);
      const gaps = [];
      for (let i = 1; i < group.length; i++) {
        gaps.push(group[i].x1 - group[i - 1].x2);
      }
      const sortedGaps = [...gaps].sort((a, b) => a - b);
      const medianGap = sortedGaps[Math.floor(sortedGaps.length / 2)];
      if (medianGap < 0 || medianGap >= 2) continue;

      const minX = group[0].x1;
      const maxX = group[group.length - 1].x2;
      const avgY = group.reduce((s, g) => s + g.y, 0) / group.length;
      const displayLeft = (minX - boxOriginX) * scale;
      const displayRight = (maxX - boxOriginX) * scale;
      const displayY = (visualHeightPts - (avgY - boxOriginY)) * scale;
      if (displayY < pageHeight * 0.05 || displayY > pageHeight * 0.95) continue;
      hLines.push({ left: displayLeft, right: displayRight, y: displayY });
    }
  }
}

/** Group items by a numeric position key, clustering within tolerance. */
function groupByPosition(items, posKey, tolerance) {
  const groups = [];
  for (const item of items) {
    let added = false;
    for (const group of groups) {
      if (Math.abs(item[posKey] - group[0][posKey]) <= tolerance) {
        group.push(item);
        added = true;
        break;
      }
    }
    if (!added) groups.push([item]);
  }
  return groups;
}

/**
 * Correlate classified paths with a candidate table region.
 */
function correlatePathsWithCandidate(candidate, pathData) {
  const b = candidate.bbox;
  const yTol = 15;
  const xOverlapThreshold = 0.3;

  for (const hl of pathData.hLines) {
    // Check if this hLine falls within the candidate region
    if (hl.y < b.top - yTol || hl.y > b.bottom + yTol) continue;
    const overlapLeft = Math.max(hl.left, b.left);
    const overlapRight = Math.min(hl.right, b.right);
    const overlap = Math.max(0, overlapRight - overlapLeft);
    const hlWidth = hl.right - hl.left;
    if (hlWidth > 0 && overlap / hlWidth > xOverlapThreshold) {
      candidate.hLines.push(hl);
    }
  }

  for (const vl of pathData.vLines) {
    if (vl.x < b.left - 5 || vl.x > b.right + 5) continue;
    const overlapTop = Math.max(vl.top, b.top);
    const overlapBottom = Math.min(vl.bottom, b.bottom);
    if (overlapBottom - overlapTop > (b.bottom - b.top) * 0.2) {
      candidate.vLines.push(vl);
    }
  }
}

/**
 * Validate a candidate region to reject false positives.
 */
function validateCandidate(candidate, lines) {
  const rows = candidate.rows;

  // Rows of a leader-dot financial statement arrive as one line each, so their cells sit inside the line instead of across several.
  const rowIsMultiSeg = (r) => r.lineIndices.length >= 2
    || (r.lineIndices.length === 1 && isRightClusteredNumeric(lines[r.lineIndices[0]].words));
  const multiSegRows = rows.filter(rowIsMultiSeg);
  if (multiSegRows.length < 3) return false;

  // Right-aligned numeric columns have varying left edges but consistent right edges, so counting only one edge type would reject financial and statistical tables.
  const leftEdges = [];
  const rightEdges = [];
  for (const row of rows) {
    for (const idx of row.lineIndices) {
      leftEdges.push(Math.round(lines[idx].bbox.left / 5) * 5);
      rightEdges.push(Math.round(lines[idx].bbox.right / 5) * 5);
    }
  }
  const leftCounts = {};
  for (const x of leftEdges) leftCounts[x] = (leftCounts[x] || 0) + 1;
  const rightCounts = {};
  for (const x of rightEdges) rightCounts[x] = (rightCounts[x] || 0) + 1;
  const alignMinCount = Math.max(2, rows.length * 0.3);
  const alignedLeft = Object.values(leftCounts).filter((c) => c >= alignMinCount).length;
  const alignedRight = Object.values(rightCounts).filter((c) => c >= alignMinCount).length;
  if (alignedLeft + alignedRight < 2) return false;

  // Adjacent cells coalesce into one line object when their x-gap is small, so a row of N visual cells can emit N-1, N, or N+1 segments.
  // Counts within 1 of the mode are pooled only when there are many rows, since scattered counts across a handful of rows point to a form rather than to coalescence noise.
  const segCounts = {};
  for (const row of multiSegRows) {
    const n = row.lineIndices.length;
    segCounts[n] = (segCounts[n] || 0) + 1;
  }
  if (multiSegRows.length >= 10) {
    let bestCluster = 0;
    for (const k of Object.keys(segCounts)) {
      const c = Number(k);
      const cluster = (segCounts[c - 1] || 0) + (segCounts[c] || 0) + (segCounts[c + 1] || 0);
      if (cluster > bestCluster) bestCluster = cluster;
    }
    if (bestCluster < multiSegRows.length * 0.4) return false;
  } else {
    const maxSegCount = Object.values(segCounts).reduce((m, v) => Math.max(m, v), -Infinity);
    if (maxSegCount < multiSegRows.length * 0.4) return false;
  }

  // Equations render subscripts, superscripts, and operators as separate lines far narrower than any real table cell.
  // The width threshold stays absolute rather than scaled to the surrounding text size, which would let equations through on small-text pages.
  let tinyCount = 0;
  let totalLines = 0;
  for (const row of rows) {
    for (const idx of row.lineIndices) {
      totalLines++;
      if (lines[idx].bbox.right - lines[idx].bbox.left < 70) tinyCount++;
    }
  }
  if (totalLines > 0 && tinyCount / totalLines > 0.7) return false;

  // Infographics and feature diagrams sit at aligned y-positions with step-number badges and paragraphs of description, so they group into a candidate with no column structure.
  // A cell of several words is still data when it carries numbers, because multi-column listings often merge a multi-word label with its values into one line object.
  // A row needs two numeric cells to escape, since an infographic row still carries the one number in its step badge.
  const hasLetter = (s) => /[a-zA-Z]/.test(s);
  const isNumToken = (s) => /^[\d,$%.()+-]+$/.test(s) && /\d/.test(s);
  const cellIsProse = (lineIdx) => {
    const words = lines[lineIdx].words;
    if (words.length < 3) return false;
    let alpha = 0;
    let numeric = 0;
    for (const w of words) {
      if (hasLetter(w.text)) alpha++;
      if (isNumToken(w.text)) numeric++;
    }
    return alpha >= 3 && numeric === 0;
  };
  let proseRowCount = 0;
  for (const row of rows) {
    if (row.lineIndices.length < 2) continue;
    let proseCells = 0;
    let numericCells = 0;
    for (const idx of row.lineIndices) {
      if (cellIsProse(idx)) proseCells++;
      if (lines[idx].words.some((w) => isNumToken(w.text))) numericCells++;
    }
    if (proseCells >= 2 && numericCells < 2) proseRowCount++;
  }
  if (proseRowCount > rows.length * 0.4) return false;

  // Real tables anchor each row with at least one narrow atomic cell (a short label or value), which narrative layouts like address blocks lack.
  const cellIsTextFragment = (lineIdx) => {
    const words = lines[lineIdx].words;
    if (words.length < 2) return false;
    for (const w of words) if (hasLetter(w.text)) return true;
    return false;
  };
  const multiSegRowCount = rows.filter((r) => r.lineIndices.length >= 2).length;
  if (multiSegRowCount >= 3) {
    let narrativeRowCount = 0;
    for (const row of rows) {
      if (row.lineIndices.length < 2) continue;
      let allNarrative = true;
      let maxWidth = 0;
      for (const idx of row.lineIndices) {
        const w = lines[idx].bbox.right - lines[idx].bbox.left;
        if (w > maxWidth) maxWidth = w;
      }
      for (const idx of row.lineIndices) {
        if (!cellIsTextFragment(idx)) { allNarrative = false; break; }
        const w = lines[idx].bbox.right - lines[idx].bbox.left;
        if (w < maxWidth * 0.5) { allNarrative = false; break; }
      }
      if (allNarrative) narrativeRowCount++;
    }
    if (narrativeRowCount > multiSegRowCount * 0.5) return false;
  }

  return true;
}

/**
 * Extract horizontal and vertical line segments from raw paths for strict-grid detection.
 * Looser than `classifyPaths`, whose tiling filter drops the column separators of tables drawn as per-cell stroked rectangles that do not share an edge.
 *
 * @param {Array<import('./parsePdfPaths.js').PaintedPath>} paths
 * @param {number} scale
 * @param {number} visualHeightPts
 * @param {number} boxOriginX
 * @param {number} boxOriginY
 * @returns {{hLines: HLine[], vLines: VLine[]}}
 */
function extractGridSegments(paths, scale, visualHeightPts, boxOriginX, boxOriginY) {
  /** @type {Array<{pos: number, start: number, end: number, b0: number, b1: number}>} */
  const hPieces = [];
  /** @type {Array<{pos: number, start: number, end: number, b0: number, b1: number}>} */
  const vPieces = [];

  // A piece thin in both directions (a junction or corner stub) goes in both pools, since its ink continues whichever run it abuts.
  /**
   * @param {number} p1x
   * @param {number} p1y
   * @param {number} p2x
   * @param {number} p2y
   * @param {number} halfThick
   */
  const addPiece = (p1x, p1y, p2x, p2y, halfThick) => {
    const segW = Math.abs(p2x - p1x);
    const segH = Math.abs(p2y - p1y);
    if (segH < 2 && segW > 0) {
      const pos = (p1y + p2y) / 2;
      hPieces.push({
        pos, start: Math.min(p1x, p2x), end: Math.max(p1x, p2x), b0: pos - halfThick, b1: pos + halfThick,
      });
    }
    if (segW < 2 && segH > 0) {
      const pos = (p1x + p2x) / 2;
      vPieces.push({
        pos, start: Math.min(p1y, p2y), end: Math.max(p1y, p2y), b0: pos - halfThick, b1: pos + halfThick,
      });
    }
  };

  for (const path of paths) {
    if (!path.fill && !path.stroke) continue;
    const cmds = path.commands;
    const halfStroke = (path.lineWidth || 1) / 2;
    if (path.stroke && cmds.length === 5
        && cmds[0].type === 'M' && cmds[1].type === 'L'
        && cmds[2].type === 'L' && cmds[3].type === 'L' && cmds[4].type === 'Z') {
      // Stroked rectangle: emit all 4 edges.
      const pts = [cmds[0], cmds[1], cmds[2], cmds[3]];
      for (let k = 0; k < 4; k++) {
        addPiece(pts[k].x, pts[k].y, pts[(k + 1) % 4].x, pts[(k + 1) % 4].y, halfStroke);
      }
      continue;
    }
    if (path.stroke) {
      // Stroked polyline: emit each M-L segment individually.
      for (let k = 0; k < cmds.length - 1; k++) {
        if ((cmds[k].type === 'M' || cmds[k].type === 'L') && cmds[k + 1].type === 'L') {
          addPiece(cmds[k].x, cmds[k].y, cmds[k + 1].x, cmds[k + 1].y, halfStroke);
        }
      }
      continue;
    }
    if (path.fill) {
      // Producers batch a whole grid's rules as subpaths of one filled path, so a per-path bbox would aggregate them into one non-thin blob and emit nothing.
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      /** @type {Array<{x: number, y: number}>} */
      let pts = [];
      const emitSubpath = () => {
        if (!Number.isFinite(minX)) { pts = []; return; }
        const w = maxX - minX;
        const h = maxY - minY;
        if (h < 5 && w > 0) {
          hPieces.push({
            pos: (minY + maxY) / 2, start: minX, end: maxX, b0: minY, b1: maxY,
          });
        }
        if (w < 5 && h > 0) {
          vPieces.push({
            pos: (minX + maxX) / 2, start: minY, end: maxY, b0: minX, b1: maxX,
          });
        }
        // A run of connected borders can be drawn as one closed L or U-shaped fill, thin ink inside a bbox that is wide both ways.
        // Mean ink thickness is 2*area/perimeter.
        // Short diagonal edges are the miter stubs at its corners, so only a long one disqualifies the subpath as a chart sliver or a real polygon.
        if (h >= 5 && w >= 5 && pts.length >= 4) {
          let area2 = 0;
          let perim = 0;
          for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            const q = pts[(i + 1) % pts.length];
            area2 += p.x * q.y - q.x * p.y;
            perim += Math.hypot(q.x - p.x, q.y - p.y);
          }
          const t = perim > 0 ? Math.abs(area2) / perim : Infinity;
          let isStrip = t < 5;
          if (isStrip) {
            for (let i = 0; i < pts.length; i++) {
              const p = pts[i];
              const q = pts[(i + 1) % pts.length];
              const dx = Math.abs(q.x - p.x);
              const dy = Math.abs(q.y - p.y);
              if (dx >= 2 && dy >= 2 && Math.hypot(dx, dy) > Math.max(3 * t, 3)) { isStrip = false; break; }
            }
          }
          if (isStrip) {
            for (let i = 0; i < pts.length; i++) {
              const p = pts[i];
              const q = pts[(i + 1) % pts.length];
              const dx = Math.abs(q.x - p.x);
              const dy = Math.abs(q.y - p.y);
              if ((dx < 2 || dy < 2) && Math.max(dx, dy) > Math.max(3 * t, 5)) {
                addPiece(p.x, p.y, q.x, q.y, t / 2);
              }
            }
          }
        }
        pts = [];
        minX = Infinity; maxX = -Infinity; minY = Infinity; maxY = -Infinity;
      };
      for (const c of cmds) {
        if (c.type === 'Z') continue;
        if (c.type === 'M') emitSubpath();
        pts.push({ x: c.x, y: c.y });
        if (c.x < minX) minX = c.x; if (c.x > maxX) maxX = c.x;
        if (c.y < minY) minY = c.y; if (c.y > maxY) maxY = c.y;
      }
      emitSubpath();
    }
  }

  // Only genuinely touching ink may fuse here, or dashes and dot leaders would merge into phantom rules instead of falling to the length filter.
  // Filtering per piece instead would discard the sub-length junction stubs that connect a rule's long pieces, leaving holes in a visually unbroken line.
  /** @param {Array<{pos: number, start: number, end: number, b0: number, b1: number}>} pieces */
  const mergeAbutting = (pieces) => {
    /** @type {Array<{pos: number, segs: typeof pieces}>} */
    const groups = [];
    for (const piece of pieces) {
      let group = null;
      for (const g of groups) {
        if (Math.abs(piece.pos - g.pos) <= 0.5) { group = g; break; }
      }
      if (!group) { group = { pos: piece.pos, segs: [] }; groups.push(group); }
      group.segs.push(piece);
    }
    /** @type {typeof pieces} */
    const runs = [];
    for (const g of groups) {
      g.segs.sort((a, b) => a.start - b.start);
      let cur = { ...g.segs[0] };
      for (let i = 1; i < g.segs.length; i++) {
        const s = g.segs[i];
        if (s.start <= cur.end + 0.5) {
          if (s.end > cur.end) cur.end = s.end;
          if (s.b0 < cur.b0) cur.b0 = s.b0;
          if (s.b1 > cur.b1) cur.b1 = s.b1;
        } else {
          runs.push(cur);
          cur = { ...s };
        }
      }
      runs.push(cur);
    }
    return runs.filter((r) => r.end - r.start > 5);
  };

  const hLines = mergeAbutting(hPieces).map((r) => ({
    left: (r.start - boxOriginX) * scale,
    right: (r.end - boxOriginX) * scale,
    y: (visualHeightPts - (r.pos - boxOriginY)) * scale,
    y0: (visualHeightPts - (r.b1 - boxOriginY)) * scale,
    y1: (visualHeightPts - (r.b0 - boxOriginY)) * scale,
  }));
  const vLines = mergeAbutting(vPieces).map((r) => ({
    x: (r.pos - boxOriginX) * scale,
    top: (visualHeightPts - (r.end - boxOriginY)) * scale,
    bottom: (visualHeightPts - (r.start - boxOriginY)) * scale,
    x0: (r.b0 - boxOriginX) * scale,
    x1: (r.b1 - boxOriginX) * scale,
  }));

  return { hLines, vLines };
}

/**
 * Detect tables that are fully bordered grids.
 * The grid must have an outer rectangle, a horizontal separator at every row boundary, and a vertical separator at every column boundary, all connected.
 *
 * @param {import('../objects/ocrObjects.js').OcrPage} pageObj
 * @param {Array<import('./parsePdfPaths.js').PaintedPath>} paths
 * @param {number} scale
 * @param {number} visualHeightPts
 * @param {number} [boxOriginX=0]
 * @param {number} [boxOriginY=0]
 * @returns {DetectedTable[]}
 */
function detectStrictGrids(pageObj, paths, scale, visualHeightPts, boxOriginX = 0, boxOriginY = 0) {
  const raw = extractGridSegments(paths, scale, visualHeightPts, boxOriginX, boxOriginY);
  const hLines = mergeCollinearSegments(raw.hLines, 'y', 'left', 'right', 5, 10);
  const vLines = mergeCollinearSegments(raw.vLines, 'x', 'top', 'bottom', 5, 10);
  if (hLines.length < 3 || vLines.length < 2) return [];

  const TOL = 6;
  const INK_EPS = 2;
  const N = hLines.length + vLines.length;
  const parent = new Int32Array(N);
  for (let i = 0; i < N; i++) parent[i] = i;
  const find = (i) => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    while (parent[i] !== r) { const next = parent[i]; parent[i] = r; i = next; }
    return r;
  };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[ra] = rb; };

  for (let i = 0; i < hLines.length; i++) {
    const a = hLines[i];
    for (let j = i + 1; j < hLines.length; j++) {
      const b = hLines[j];
      if (Math.abs(a.y - b.y) <= TOL
          && Math.min(a.right, b.right) >= Math.max(a.left, b.left) - TOL) {
        union(i, j);
      }
    }
    for (let j = 0; j < vLines.length; j++) {
      const v = vLines[j];
      // Crossing is decided by the two ink rectangles touching, not by midline proximity.
      // A thick border bar's midline sits half its width from the edge the interior rules actually touch, so midline distance misjudges contact.
      if ((v.x1 ?? v.x) >= a.left - INK_EPS && (v.x0 ?? v.x) <= a.right + INK_EPS
          && (a.y1 ?? a.y) >= v.top - INK_EPS && (a.y0 ?? a.y) <= v.bottom + INK_EPS) {
        union(i, hLines.length + j);
      }
    }
  }
  for (let i = 0; i < vLines.length; i++) {
    const a = vLines[i];
    for (let j = i + 1; j < vLines.length; j++) {
      const b = vLines[j];
      if (Math.abs(a.x - b.x) <= TOL
          && Math.min(a.bottom, b.bottom) >= Math.max(a.top, b.top) - TOL) {
        union(hLines.length + i, hLines.length + j);
      }
    }
  }

  /** @type {Map<number, {hs: HLine[], vs: VLine[]}>} */
  const components = new Map();
  for (let i = 0; i < hLines.length; i++) {
    const r = find(i);
    let c = components.get(r);
    if (!c) { c = { hs: [], vs: [] }; components.set(r, c); }
    c.hs.push(hLines[i]);
  }
  for (let i = 0; i < vLines.length; i++) {
    const r = find(hLines.length + i);
    let c = components.get(r);
    if (!c) { c = { hs: [], vs: [] }; components.set(r, c); }
    c.vs.push(vLines[i]);
  }

  /** @type {DetectedTable[]} */
  const results = [];
  for (const comp of components.values()) {
    if (comp.hs.length < 3 || comp.vs.length < 2) continue;
    const t = tryDetectStrictGrid(comp.hs, comp.vs, pageObj);
    if (t) results.push(t);
  }

  // A table drawn as stacked bordered sections validates as one grid per section.
  // A break between genuinely separate tables carries at least a caption or blank line.
  results.sort((a, b) => a.bbox.top - b.bbox.top);
  for (let i = 0; i + 1 < results.length; i++) {
    const cur = results[i];
    const next = results[i + 1];
    const gap = next.bbox.top - cur.bbox.bottom;
    if (gap < 0 || gap >= 40) continue;
    if (Math.abs(cur.bbox.left - next.bbox.left) > 15 || Math.abs(cur.bbox.right - next.bbox.right) > 15) continue;
    if (cur.colSeparators.length !== next.colSeparators.length) continue;
    let sameCols = true;
    for (let c = 0; c < cur.colSeparators.length; c++) {
      if (Math.abs(cur.colSeparators[c] - next.colSeparators[c]) >= 10) { sameCols = false; break; }
    }
    if (!sameCols) continue;
    cur.bbox.left = Math.min(cur.bbox.left, next.bbox.left);
    cur.bbox.right = Math.max(cur.bbox.right, next.bbox.right);
    cur.bbox.bottom = next.bbox.bottom;
    cur.rows.push(...next.rows);
    cur.hLines.push(...next.hLines);
    cur.vLines.push(...next.vLines);
    results.splice(i + 1, 1);
    i--;
  }
  return results;
}

/**
 * Cluster a list of values into groups where consecutive sorted values are within `tol` of each other.
 * @param {number[]} values
 * @param {number} tol
 * @returns {number[]}
 */
function clusterValuesLocal(values, tol) {
  if (values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  /** @type {number[][]} */
  const clusters = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const last = clusters[clusters.length - 1];
    if (sorted[i] - last[last.length - 1] <= tol) {
      last.push(sorted[i]);
    } else {
      clusters.push([sorted[i]]);
    }
  }
  return clusters.map((c) => c[Math.floor(c.length / 2)]);
}

/**
 * Test whether the union of `segs` covers the closed interval `[left, right]` with no gap larger than `tol`.
 *
 * @param {Array<{left: number, right: number}>} segs sorted ascending by `left`
 * @param {number} left start of the interval to cover
 * @param {number} right end of the interval to cover
 * @param {number} tol gap tolerance applied at both endpoints and between segments
 */
function unionSpansFully(segs, left, right, tol) {
  if (segs.length === 0) return false;
  if (segs[0].left > left + tol) return false;
  let furthest = segs[0].right;
  for (let i = 1; i < segs.length; i++) {
    if (segs[i].left > furthest + tol) return false;
    if (segs[i].right > furthest) furthest = segs[i].right;
  }
  return furthest >= right - tol;
}

/**
 * Validate one connected component as a strict grid and emit the table.
 *
 * @param {HLine[]} hs h-segments in the component
 * @param {VLine[]} vs v-segments in the component
 * @param {{dims: {width: number, height: number}, lines: any[]}} pageObj
 * @returns {DetectedTable | null}
 */
function tryDetectStrictGrid(hs, vs, pageObj) {
  if (hs.length < 3) return null;

  const left = hs.reduce((m, h) => Math.min(m, h.left), Infinity);
  const right = hs.reduce((m, h) => Math.max(m, h.right), -Infinity);
  if ((right - left) < pageObj.dims.width * 0.3) return null;

  const ys = clusterValuesLocal(hs.map((h) => h.y), 5);
  if (ys.length < 3) return null;

  const minY = ys[0];
  const maxY = ys[ys.length - 1];

  const segsByY = new Map();
  for (const py of ys) {
    const segs = hs
      .filter((h) => Math.abs(h.y - py) < 5)
      .map((h) => ({ left: h.left, right: h.right }))
      .sort((a, b) => a.left - b.left);
    segsByY.set(py, segs);
  }

  /** @type {Array<{top: number, bottom: number, xs: number[]}>} */
  const strips = [];
  for (let i = 0; i < ys.length - 1; i++) {
    const top = ys[i];
    const bot = ys[i + 1];
    const stripVs = vs.filter((v) => v.top <= top + 10 && v.bottom >= bot - 10);
    const xs = clusterValuesLocal(stripVs.map((v) => v.x), 10);
    if (xs.length < 2
        || Math.abs(xs[0] - left) > 15
        || Math.abs(xs[xs.length - 1] - right) > 15) return null;
    strips.push({ top, bottom: bot, xs });
  }
  if (strips.length < 2) return null;

  const maxCols = Math.max(...strips.map((s) => s.xs.length));
  const dataStrips = strips.filter((s) => s.xs.length === maxCols);
  if (dataStrips.length < 2) return null;
  const canonicalXs = dataStrips[0].xs;
  for (const s of dataStrips) {
    if (s.xs.length !== canonicalXs.length) return null;
    for (let i = 0; i < s.xs.length; i++) {
      if (Math.abs(s.xs[i] - canonicalXs[i]) >= 10) return null;
    }
  }
  // A header row whose cells span several data columns has fewer boundaries, so a strip may omit a boundary but never add one.
  for (const s of strips) {
    if (s.xs.length === maxCols) continue;
    for (const x of s.xs) {
      if (!canonicalXs.some((cx) => Math.abs(cx - x) < 10)) return null;
    }
  }

  // Cells merged across an interior row boundary leave its rule broken there, so a gap is allowed only when both ends land on canonical column separators.
  for (let i = 0; i < ys.length; i++) {
    const segs = segsByY.get(ys[i]);
    if (i === 0 || i === ys.length - 1) {
      if (!unionSpansFully(segs, left, right, 15)) return null;
      continue;
    }
    if (segs[0].left > left + 15) return null;
    let furthest = segs[0].right;
    for (let j = 1; j < segs.length; j++) {
      if (segs[j].left > furthest + 15) {
        const gapStart = furthest;
        const gapEnd = segs[j].left;
        if (!canonicalXs.some((cx) => Math.abs(cx - gapStart) < 10)
            || !canonicalXs.some((cx) => Math.abs(cx - gapEnd) < 10)) return null;
      }
      if (segs[j].right > furthest) furthest = segs[j].right;
    }
    if (furthest < right - 15) return null;
  }

  const colSeparators = canonicalXs.slice(1, -1);
  const bbox = {
    left, top: minY - 5, right, bottom: maxY + 5,
  };

  /** @type {Array<{lineIndices: number[], y: number}>} */
  const rows = [];
  for (const strip of strips) {
    const idxs = [];
    for (let i = 0; i < pageObj.lines.length; i++) {
      const ln = pageObj.lines[i];
      const yC = (ln.bbox.top + ln.bbox.bottom) / 2;
      if (yC >= strip.top - 5 && yC <= strip.bottom + 5
          && ln.bbox.left >= bbox.left - 10 && ln.bbox.right <= bbox.right + 10) {
        idxs.push(i);
      }
    }
    if (idxs.length === 0) continue;
    const yMean = idxs.reduce((s, i) => s + pageObj.lines[i].bbox.top, 0) / idxs.length;
    rows.push({ lineIndices: idxs, y: yMean });
  }
  if (rows.length < 2) return null;

  // A page break can clip the rule above the first row or below the last, leaving the column borders running past the outermost drawn rule with a borderless row of grid text between.
  const colVs = vs.filter((v) => canonicalXs.some((cx) => Math.abs(cx - v.x) < 10));
  /**
   * @param {number} regionTop
   * @param {number} regionBottom
   * @param {boolean} atTop
   */
  const absorbCutRow = (regionTop, regionBottom, atTop) => {
    const idxs = [];
    for (let i = 0; i < pageObj.lines.length; i++) {
      const ln = pageObj.lines[i];
      const yC = (ln.bbox.top + ln.bbox.bottom) / 2;
      if (yC >= regionTop && yC <= regionBottom
          && ln.bbox.left >= bbox.left - 10 && ln.bbox.right <= bbox.right + 10) {
        idxs.push(i);
      }
    }
    if (idxs.length === 0) return;
    const yMean = idxs.reduce((s, i) => s + pageObj.lines[i].bbox.top, 0) / idxs.length;
    if (atTop) {
      rows.unshift({ lineIndices: idxs, y: yMean });
      bbox.top = regionTop - 5;
    } else {
      rows.push({ lineIndices: idxs, y: yMean });
      bbox.bottom = regionBottom + 5;
    }
  };
  const cutTopVs = colVs.filter((v) => v.top <= minY - 15);
  if (cutTopVs.length >= 2
      && Math.min(...cutTopVs.map((v) => v.x)) <= left + 15
      && Math.max(...cutTopVs.map((v) => v.x)) >= right - 15) {
    absorbCutRow(Math.min(...cutTopVs.map((v) => v.top)), minY, true);
  }
  const cutBotVs = colVs.filter((v) => v.bottom >= maxY + 15);
  if (cutBotVs.length >= 2
      && Math.min(...cutBotVs.map((v) => v.x)) <= left + 15
      && Math.max(...cutBotVs.map((v) => v.x)) >= right - 15) {
    absorbCutRow(maxY, Math.max(...cutBotVs.map((v) => v.bottom)), false);
  }

  return {
    bbox,
    rows,
    colSeparators,
    hLines: hs,
    vLines: vs,
    detectionMethod: 'grid-strong',
  };
}

/**
 * Detect tables whose column structure is encoded by segments of horizontal rules rather than by vertical rules.
 *
 * @param {import('../objects/ocrObjects.js').OcrPage} pageObj
 * @param {Array<import('./parsePdfPaths.js').PaintedPath>} paths
 * @param {number} scale
 * @param {number} visualHeightPts
 * @param {number} [boxOriginX=0]
 * @param {number} [boxOriginY=0]
 * @returns {DetectedTable[]}
 */
function detectSegmentedHLineGrids(pageObj, paths, scale, visualHeightPts, boxOriginX = 0, boxOriginY = 0) {
  const pathData = classifyPaths(paths, scale, visualHeightPts, pageObj, boxOriginX, boxOriginY);
  if (pathData.hLines.length < 3) return [];

  const hLineClusters = clusterHLinesByXExtent(pathData.hLines);
  /** @type {HLine[][]} */
  const processed = [];
  for (const cluster of hLineClusters) {
    if (cluster.length < 3) continue;
    for (const sub of splitClusterByYGap(cluster)) {
      if (sub.length >= 3) processed.push(sub);
    }
  }

  /** @type {DetectedTable[]} */
  const tables = [];
  for (const cluster of processed) {
    const clusterLeft = cluster.reduce((m, h) => Math.min(m, h.left), Infinity);
    const clusterRight = cluster.reduce((m, h) => Math.max(m, h.right), -Infinity);
    const clusterTop = cluster.reduce((m, h) => Math.min(m, h.y), Infinity);
    const clusterBottom = cluster.reduce((m, h) => Math.max(m, h.y), -Infinity);
    const regionVLines = pathData.vLines.filter((vl) => vl.x >= clusterLeft - 5
      && vl.x <= clusterRight + 5
      && vl.top <= clusterBottom + 5
      && vl.bottom >= clusterTop - 5);
    if (regionVLines.length >= 3) continue;
    const segTables = detectSegmentedHLineTables(cluster, pathData.headerFills, pageObj);
    for (const st of segTables) tables.push(st);
  }
  return tables;
}

/**
 * @typedef {{
 *   columnAnchors: number[],   // x-centers of cells in the primary header row
 *   bandTop: number,            // topmost y of the detected header band
 *   bandBottom: number,         // first-data-row y (end of header band)
 *   confidence: 'strong'|'weak',
 * }} HeaderInfo
 */

/**
 * Detect the header band for a candidate table and extract column anchors from whichever header row carries the strongest column-position signal.
 * Consumers should override an existing column signal only on 'strong' confidence.
 *
 * @param {object} table - A validated candidate with .bbox and .rows
 * @param {import('../objects/ocrObjects.js').OcrLine[]} lines - pageObj.lines
 * @returns {HeaderInfo|null}
 */
function detectHeaders(table, lines) {
  if (table.rows.length === 0) return null;

  const sortedRowYs = table.rows.map((r) => r.y).sort((a, b) => a - b);
  let avgRowHeight = 50;
  if (sortedRowYs.length > 1) {
    const spacings = [];
    for (let i = 1; i < sortedRowYs.length; i++) spacings.push(sortedRowYs[i] - sortedRowYs[i - 1]);
    spacings.sort((a, b) => a - b);
    avgRowHeight = spacings[Math.floor(spacings.length / 2)];
  }

  const firstRowY = sortedRowYs[0];
  const lookbackLimit = firstRowY - avgRowHeight * 10;
  const existingLineSet = new Set(table.rows.flatMap((r) => r.lineIndices));

  const aboveLines = [];
  for (let i = 0; i < lines.length; i++) {
    if (existingLineSet.has(i)) continue;
    const line = lines[i];
    if (line.bbox.top >= firstRowY) continue;
    if (line.bbox.top < lookbackLimit) continue;
    if (line.bbox.right < table.bbox.left || line.bbox.left > table.bbox.right) continue;
    aboveLines.push({ idx: i, line });
  }
  if (aboveLines.length === 0) return null;

  const yGroups = [];
  for (const al of aboveLines) {
    let found = null;
    for (const g of yGroups) {
      if (Math.abs(g.y - al.line.bbox.top) < 5) { found = g; break; }
    }
    if (found) {
      found.items.push(al);
    } else {
      yGroups.push({ y: al.line.bbox.top, items: [al] });
    }
  }

  const isDataValueToken = (t) => /^[\d,$%.()+-]+$/.test(t) && /\d/.test(t) && !/^(?:19|20)\d\d$/.test(t);

  const extractCells = (items) => {
    const allWords = [];
    for (const { line } of items) {
      for (const w of line.words) allWords.push(w);
    }
    if (allWords.length === 0) return [];
    allWords.sort((a, b) => a.bbox.left - b.bbox.left);
    let heightSum = 0;
    for (const w of allWords) heightSum += w.bbox.bottom - w.bbox.top;
    const avgH = heightSum / allWords.length;
    // Header text is often set with wider inter-word spacing than a data-row phrase, so a tighter gap would split a two-word header cell into two spurious anchors.
    const gapThreshold = avgH * 0.6;
    const cells = [];
    let current = {
      left: allWords[0].bbox.left,
      right: allWords[0].bbox.right,
      words: [allWords[0]],
    };
    for (let i = 1; i < allWords.length; i++) {
      const w = allWords[i];
      const gap = w.bbox.left - current.right;
      if (gap < gapThreshold) {
        current.right = Math.max(current.right, w.bbox.right);
        current.words.push(w);
      } else {
        cells.push(current);
        current = { left: w.bbox.left, right: w.bbox.right, words: [w] };
      }
    }
    cells.push(current);
    return cells;
  };

  yGroups.sort((a, b) => b.y - a.y); // Descending y walks upward from the data, which is what lets the band walk below stop at the first gap.
  const annotated = [];
  for (const g of yGroups) {
    const cells = extractCells(g.items);
    let allText = true;
    let alphaCount = 0;
    let dataCount = 0;
    for (const c of cells) {
      for (const w of c.words) {
        if (isDataValueToken(w.text)) {
          allText = false;
          dataCount++;
        } else if (/[a-zA-Z]/.test(w.text)) {
          alphaCount++;
        }
      }
    }
    const mostlyText = alphaCount > dataCount;
    annotated.push({
      y: g.y, cells, allText, mostlyText,
    });
  }

  let bestGroup = null;
  let bestCells = null;
  for (const a of annotated) {
    if (!a.allText) continue;
    if (a.cells.length < 3) continue;
    if (!bestCells || a.cells.length > bestCells.length) {
      bestGroup = a;
      bestCells = a.cells;
    }
  }

  // A lone cell of up to four alphabetic words is a section title or unit marker, while a longer one is a paragraph and no part of the band.
  const countAlpha = (cell) => {
    let n = 0;
    for (const w of cell.words) if (/[a-zA-Z]/.test(w.text)) n++;
    return n;
  };
  const isHeaderLikeRow = (a) => {
    if (a.cells.length >= 2) return a.allText;
    if (a.cells.length === 1) return a.mostlyText && countAlpha(a.cells[0]) <= 4;
    return false;
  };
  let bandTop = firstRowY;
  let lastAcceptedY = firstRowY;
  const gapLimit = avgRowHeight * 2;
  for (const a of annotated) {
    if (!isHeaderLikeRow(a)) continue;
    if (lastAcceptedY - a.y > gapLimit) break;
    bandTop = a.y;
    lastAcceptedY = a.y;
  }

  // A header can be stacked as several 2-cell rows over the same two columns, as an annual report stacks a date row above a units row.
  // Two cells alone are ambiguous, but the same two x-positions repeating across rows is structural evidence.
  let fromStackedRule = false;
  if (!bestGroup || !bestCells) {
    const twoCellRows = annotated.filter((a) => a.allText && a.cells.length === 2);
    if (twoCellRows.length >= 2) {
      const bboxW = table.bbox.right - table.bbox.left;
      const xTol = bboxW * 0.15;
      const ref = twoCellRows[0];
      const refLC = (ref.cells[0].left + ref.cells[0].right) / 2;
      const refRC = (ref.cells[1].left + ref.cells[1].right) / 2;
      let matchCount = 0;
      let anchorSumL = 0;
      let anchorSumR = 0;
      for (const r of twoCellRows) {
        const lc = (r.cells[0].left + r.cells[0].right) / 2;
        const rc = (r.cells[1].left + r.cells[1].right) / 2;
        if (Math.abs(lc - refLC) < xTol && Math.abs(rc - refRC) < xTol) {
          anchorSumL += lc;
          anchorSumR += rc;
          matchCount++;
        }
      }
      if (matchCount >= 2) {
        const avgL = anchorSumL / matchCount;
        const avgR = anchorSumR / matchCount;
        fromStackedRule = true;
        bestGroup = twoCellRows[0];
        bestCells = [
          {
            left: avgL - 50,
            right: avgL + 50,
            words: [{
              text: '',
              bbox: {
                left: avgL - 50, right: avgL + 50, top: 0, bottom: 0,
              },
            }],
          },
          {
            left: avgR - 50,
            right: avgR + 50,
            words: [{
              text: '',
              bbox: {
                left: avgR - 50, right: avgR + 50, top: 0, bottom: 0,
              },
            }],
          },
        ];
      }
    }
  }

  if (!bestGroup || !bestCells) {
    if (bandTop >= firstRowY) return null;
    return {
      columnAnchors: [],
      bandTop,
      bandBottom: firstRowY,
      confidence: 'weak',
    };
  }

  // A header cell survives only when some data word falls in its x-range, which drops the cells of an over-split header that land on blank space between columns.
  // The test is the range and not the center, since a centered header sits off the x-center of a right-aligned numeric column.
  const alignedCells = [];
  for (const c of bestCells) {
    let aligned = false;
    for (const r of table.rows) {
      if (aligned) break;
      for (const i of r.lineIndices) {
        if (aligned) break;
        for (const w of lines[i].words) {
          const wc = (w.bbox.left + w.bbox.right) / 2;
          if (wc >= c.left - 5 && wc <= c.right + 5) { aligned = true; break; }
        }
      }
    }
    if (aligned) alignedCells.push(c);
  }

  // A single header row needs four aligned cells rather than the three that qualified it, since three can be a coincidental phrase trio.
  // A stacked header needs only two, its evidence being the repetition across rows.
  const alignedAnchors = alignedCells.map((c) => (c.left + c.right) / 2);
  const minAnchors = fromStackedRule ? 2 : 4;
  const confidence = (alignedAnchors.length >= minAnchors && alignedCells.length >= bestCells.length * 0.5)
    ? 'strong'
    : 'weak';

  return {
    columnAnchors: alignedAnchors,
    bandTop,
    bandBottom: firstRowY,
    confidence,
  };
}

/**
 * Extract column structure for a validated table.
 * @param {DetectedTable} table
 * @param {import('../objects/ocrObjects.js').OcrLine[]} lines
 */
function extractStructure(table, lines) {
  if (table.colSeparators.length > 0) return;

  if (table.vLines.length >= 2) {
    const vLineXPositions = clusterValues(table.vLines.map((vl) => vl.x), 10);
    const interior = vLineXPositions.filter((x) => x > table.bbox.left + 5 && x < table.bbox.right - 5);
    if (interior.length > 0) {
      table.colSeparators = interior.sort((a, b) => a - b);
      return;
    }
  }

  // A header rarely labels the row-label column, so anchors that start right of the row labels leave that column to be synthesized.
  let headerSeps = null;
  if (table.headers && table.headers.confidence === 'strong'
      && table.headers.columnAnchors.length >= 2) {
    const anchors = [...table.headers.columnAnchors].sort((a, b) => a - b);
    const seps = [];
    for (let i = 0; i < anchors.length - 1; i++) {
      seps.push((anchors[i] + anchors[i + 1]) / 2);
    }
    let hasLabelCol = false;
    const leftGuard = anchors[0] - 10;
    for (const r of table.rows) {
      for (const i of r.lineIndices) {
        if (lines[i].bbox.right < leftGuard) { hasLabelCol = true; break; }
      }
      if (hasLabelCol) break;
    }
    if (hasLabelCol) {
      const halfSpacing = (anchors[1] - anchors[0]) / 2;
      const labelSep = anchors[0] - halfSpacing;
      if (labelSep > table.bbox.left + 5
          && anchors[0] - table.bbox.left > halfSpacing * 2) {
        seps.unshift(labelSep);
      }
    }
    seps.sort((a, b) => a - b);
    headerSeps = seps;
  }

  // Words are pooled per row rather than per line, since a broken row splits one logical cell across line objects.
  const isCurrencySymbol = (text) => /^[$€£¥¢]+$/.test(text);
  const allWordBboxes = [];
  // A footnote row appended just below the data sneaks into the candidate, and its wide prose line would otherwise be clustered as table content.
  const candidateWidth = table.bbox.right - table.bbox.left;
  const isNarrativeLine = (line) => {
    let totalCount = 0;
    let numericCount = 0;
    for (const word of line.words) {
      if (/^[*.]+$/.test(word.text)) continue;
      totalCount++;
      if (/^[\d,$%.()+-]+$/.test(word.text) && /\d/.test(word.text)) numericCount++;
      else if (/^[$€£¥¢]+$/.test(word.text)) numericCount++;
    }
    if (totalCount <= 6) return false;
    return numericCount / totalCount < 0.5;
  };
  // Header text often spans several columns, putting its word bboxes between the data column boundaries.
  // calcColumnBounds greedily merges such a bbox with the adjacent data cells and collapses several columns into one, so the rows above the data are skipped here.
  const isYearLike = (text) => /^(?:19|20)\d\d$/.test(text);
  /** @param {string} text */
  const isFootnoteMarker = (text) => /^\(\d\)$/.test(text);
  const isDataValueWord = (text) => /^[\d,$%.()+-]+$/.test(text) && /\d/.test(text) && !isYearLike(text) && !isFootnoteMarker(text);
  let firstDataRowIdx = -1;
  for (let ri = 0; ri < table.rows.length; ri++) {
    const r = table.rows[ri];
    let dataValueCount = 0;
    let hasCurrency = false;
    for (const i of r.lineIndices) {
      for (const word of lines[i].words) {
        if (isDataValueWord(word.text)) dataValueCount++;
        if (isCurrencySymbol(word.text)) hasCurrency = true;
      }
    }
    if (dataValueCount >= 2 || hasCurrency) {
      firstDataRowIdx = ri;
      break;
    }
  }
  for (let ri = 0; ri < table.rows.length; ri++) {
    const r = table.rows[ri];
    if (firstDataRowIdx >= 0 && ri < firstDataRowIdx) continue;
    /** @param {any} line */
    const lineIsPureText = (line) => {
      for (const word of line.words) {
        if (/^[\d,$%.()+-]+$/.test(word.text) && /\d/.test(word.text)) return false;
        if (/^[$€£¥¢]+$/.test(word.text)) return false;
      }
      return true;
    };
    let hasNarrativeLine = false;
    for (const i of r.lineIndices) {
      const lw = lines[i].bbox.right - lines[i].bbox.left;
      if (candidateWidth > 0 && lw > candidateWidth * 0.5 && isNarrativeLine(lines[i])) {
        if (r.lineIndices.length > 1 && lineIsPureText(lines[i])) {
          let otherHasNumeric = false;
          for (const j of r.lineIndices) {
            if (j === i) continue;
            for (const word of lines[j].words) {
              if (/^[\d,$%.()+-]+$/.test(word.text) && /\d/.test(word.text)) { otherHasNumeric = true; break; }
              if (/^[$€£¥¢]+$/.test(word.text)) { otherHasNumeric = true; break; }
            }
            if (otherHasNumeric) break;
          }
          if (otherHasNumeric) continue;
        }
        hasNarrativeLine = true;
        break;
      }
    }
    if (hasNarrativeLine) continue;
    const rowWords = [];
    let hSum = 0;
    let hCount = 0;
    for (const i of r.lineIndices) {
      const line = lines[i];
      const lineH = line.bbox.bottom - line.bbox.top;
      if (lineH > 0) { hSum += lineH; hCount++; }
      for (const word of line.words) rowWords.push(word);
    }
    // PDF stream order can interleave words from different columns, and the backward x-jump between them reads as a small gap that the phrase merger would swallow.
    rowWords.sort((a, b) => a.bbox.left - b.bbox.left);
    const avgLineHeight = hCount > 0 ? hSum / hCount : 20;
    const gapThreshold = avgLineHeight * 0.4;

    const expand = (box, b) => ({
      left: Math.min(box.left, b.left),
      top: Math.min(box.top, b.top),
      right: Math.max(box.right, b.right),
      bottom: Math.max(box.bottom, b.bottom),
    });

    let w = 0;
    while (w < rowWords.length) {
      if (isCurrencySymbol(rowWords[w].text)) {
        // A PDF can emit a currency symbol as its own line object, and can repeat coincident copies of the glyph, either of which would otherwise become a column of its own.
        let current = { ...rowWords[w].bbox };
        let j = w + 1;
        while (j < rowWords.length && isCurrencySymbol(rowWords[j].text)) {
          current = expand(current, rowWords[j].bbox);
          j++;
        }
        if (j < rowWords.length) {
          current = expand(current, rowWords[j].bbox);
          j++;
        }
        allWordBboxes.push(current);
        w = j;
      } else {
        // A digit ends the phrase whatever the gap, since a real boundary between numeric cells can be as narrow as a space character.
        let current = { ...rowWords[w].bbox };
        let j = w + 1;
        const hasDigit = (s) => /\d/.test(s);
        const isLeaderFiller = (s) => s.length >= 3 && /^[*.]+$/.test(s);
        const currentHasDigit = hasDigit(rowWords[w].text);
        while (j < rowWords.length && !isCurrencySymbol(rowWords[j].text)) {
          if (isLeaderFiller(rowWords[j].text)) {
            current = expand(current, rowWords[j].bbox);
            j++;
            continue;
          }
          if (currentHasDigit || hasDigit(rowWords[j].text)) break;
          const gap = rowWords[j].bbox.left - current.right;
          if (gap > gapThreshold) break;
          current = expand(current, rowWords[j].bbox);
          j++;
        }
        allWordBboxes.push(current);
        w = j;
      }
    }
  }
  if (allWordBboxes.length >= 2) {
    const wordColumnBounds = calcColumnBounds(allWordBboxes);

    // A low-coverage column is usually an artifact of outlier label text reaching into the gap between the label and data columns.
    if (wordColumnBounds.length > 2) {
      const yTol = 10;
      const yRows = [];
      for (const bbox of allWordBboxes) {
        let matched = false;
        for (const row of yRows) {
          if (Math.abs(bbox.top - row.y) < yTol) {
            row.bboxes.push(bbox);
            matched = true;
            break;
          }
        }
        if (!matched) yRows.push({ y: bbox.top, bboxes: [bbox] });
      }
      const dataRowCount = yRows.length;
      /** @type {Array<{y: number, bboxes: any[]}>} */
      const headerYRows = [];
      const addHeaderWord = (/** @type {{bbox: any}} */ w) => {
        let matched = false;
        for (const row of headerYRows) {
          if (Math.abs(w.bbox.top - row.y) < yTol) {
            row.bboxes.push(w.bbox);
            matched = true;
            break;
          }
        }
        if (!matched) headerYRows.push({ y: w.bbox.top, bboxes: [w.bbox] });
      };
      if (firstDataRowIdx > 0) {
        for (let ri = 0; ri < firstDataRowIdx; ri++) {
          if (table.rows[ri].lineIndices.length < 2) continue;
          for (const i of table.rows[ri].lineIndices) {
            for (const word of lines[i].words) addHeaderWord(word);
          }
        }
      }
      // A row-band candidate's bbox starts at the first banded data row, leaving its header lines above the top edge.
      if (table.headers
          && typeof table.headers.bandTop === 'number'
          && typeof table.headers.bandBottom === 'number') {
        const hTop = table.headers.bandTop;
        const hBottom = table.headers.bandBottom;
        for (const line of lines) {
          if (line.bbox.top < hTop || line.bbox.top >= hBottom) continue;
          if (line.bbox.top >= table.bbox.top) continue;
          if (line.bbox.right < table.bbox.left || line.bbox.left > table.bbox.right) continue;
          for (const word of line.words) addHeaderWord(word);
        }
      }

      const coverageFloor = Math.max(2, dataRowCount * 0.25);
      const colContains = (/** @type {{left: number, right: number}} */ col, /** @type {any} */ b) => {
        const center = (b.left + b.right) / 2;
        return center >= col.left && center <= col.right;
      };
      for (let c = wordColumnBounds.length - 1; c >= 0; c--) {
        if (wordColumnBounds.length <= 2) break;
        let dataRowsHere = 0;
        for (const row of yRows) {
          if (row.bboxes.some((b) => colContains(wordColumnBounds[c], b))) dataRowsHere++;
        }
        let headerRowsHere = 0;
        for (const row of headerYRows) {
          if (row.bboxes.some((b) => colContains(wordColumnBounds[c], b))) headerRowsHere++;
        }
        const totalRowsHere = dataRowsHere + headerRowsHere;
        if (dataRowsHere === 0 || totalRowsHere < coverageFloor) {
          if (c === 0) {
            wordColumnBounds[1].left = wordColumnBounds[0].left;
          } else {
            wordColumnBounds[c - 1].right = wordColumnBounds[c].right;
          }
          wordColumnBounds.splice(c, 1);
        }
      }
    }

    const seps = [];
    for (let i = 0; i < wordColumnBounds.length - 1; i++) {
      seps.push((wordColumnBounds[i].right + wordColumnBounds[i + 1].left) / 2);
    }
    table.colSeparators = seps;
  }

  // Rows that populate only some of their columns leave clustering with columns collapsed together that the header still names.
  // Over-split wants twice the header's column count, since a single extra column may be a real sub-column the header did not name.
  if (headerSeps) {
    const sparseUnderCount = headerSeps.length > table.colSeparators.length
      && table.colSeparators.length < 3;
    const overSplit = headerSeps.length < table.colSeparators.length
      && headerSeps.length >= 2
      && headerSeps.length <= table.colSeparators.length * 0.5;
    const rowBandOverSplit = table.detectionMethod === 'row-band'
      && headerSeps.length >= 2
      && headerSeps.length < table.colSeparators.length;
    if (sparseUnderCount || overSplit || rowBandOverSplit) {
      table.colSeparators = headerSeps;
    }
  }

  // A text column far narrower than the median means text over-split one cell into phrases, so the fill positions are the better guide.
  if (table.rowBandRegion && table.rowBandRegion.colXs.length > 0 && table.colSeparators.length > 0) {
    const fillSeps = table.rowBandRegion.colXs.slice().sort((a, b) => a - b);
    const textSeps = table.colSeparators;

    const textColWidths = [];
    let prev = table.bbox.left;
    for (const s of textSeps) { textColWidths.push(s - prev); prev = s; }
    textColWidths.push(table.bbox.right - prev);
    textColWidths.sort((a, b) => a - b);
    const medianWidth = textColWidths[Math.floor(textColWidths.length / 2)];
    const minWidth = textColWidths[0];

    const textHasNarrowOutlier = medianWidth > 0 && minWidth < medianWidth * 0.3;
    if (textHasNarrowOutlier && fillSeps.length + 1 >= 3) {
      table.colSeparators = fillSeps;
    }
  }
}

/**
 * Refine a table's top boundary using header detection.
 *
 * @param {DetectedTable} table
 * @param {import('../objects/ocrObjects.js').OcrLine[]} lines - All page lines
 * @param {number} [topFloor=0] - Lower bound for the refined top
 */
function refineTableTop(table, lines, topFloor = 0) {
  const rows = table.rows;
  if (rows.length === 0) return;

  // detectHeaders searches a much taller window than the gap chain below, so its bandTop can reach a header row the chain never gets to.
  if (table.headers && table.headers.confidence === 'strong') {
    let strongTop = Math.max(topFloor, table.headers.bandTop - 5);
    const firstDataY = [...rows].sort((a, b) => a.y - b.y)[0].y;
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (line.bbox.top < strongTop || line.bbox.top >= firstDataY) continue;
      if (line.bbox.right < table.bbox.left || line.bbox.left > table.bbox.right) continue;
      const lastWord = line.words.length > 0 ? line.words[line.words.length - 1].text : '';
      if (lastWord === 'follows:' && line.bbox.bottom > strongTop) {
        strongTop = line.bbox.bottom + 1;
      }
    }
    table.bbox.top = strongTop;
    return;
  }

  const sortedRows = [...rows].sort((a, b) => a.y - b.y);
  const candidateWidthForSkip = table.bbox.right - table.bbox.left;
  let firstIdx = 0;
  while (firstIdx < sortedRows.length - 1) {
    const r = sortedRows[firstIdx];
    if (r.lineIndices.length !== 1) break;
    const line = lines[r.lineIndices[0]];
    const lastText = line.words.length > 0 ? line.words[line.words.length - 1].text : '';
    const lastIsNumeric = /^[\d,$%.()+-]+$/.test(lastText) && /\d/.test(lastText) && /[\d)%]$/.test(lastText);
    if (lastIsNumeric) break;
    const wide = (line.bbox.right - line.bbox.left) > candidateWidthForSkip * 0.5;
    const sentenceEnd = /[.!?:]$/.test(lastText) && line.words.length >= 3;
    if (!wide && !sentenceEnd) break;
    firstIdx++;
  }
  const firstRowY = sortedRows[firstIdx].y;
  const lastRowY = sortedRows[sortedRows.length - 1].y;
  // A mean would be pulled up by the large gaps that section-break bridging leaves, making the header scan's proximity threshold too permissive.
  let avgRowHeight = 50;
  if (sortedRows.length > 1) {
    const spacings = [];
    for (let i = 1; i < sortedRows.length; i++) {
      spacings.push(sortedRows[i].y - sortedRows[i - 1].y);
    }
    spacings.sort((a, b) => a - b);
    avgRowHeight = spacings[Math.floor(spacings.length / 2)];
  }
  const allLineIndicesSet = new Set(rows.flatMap((r) => r.lineIndices));
  const candidateWidth = table.bbox.right - table.bbox.left;

  // The horizontal rule closest above the first row is the header/data boundary, while a higher one is more likely a decorative line or a section divider.
  let scanAnchor = firstRowY;
  if (table.hLines.length > 0) {
    const limit = firstRowY - avgRowHeight * 1.5;
    for (const hl of table.hLines) {
      if (hl.y < firstRowY && hl.y > limit) {
        if (scanAnchor === firstRowY || hl.y > scanAnchor) {
          scanAnchor = hl.y;
        }
      }
    }
  }

  let dataLeftEdge = Infinity;
  for (const r of rows) {
    for (const idx of r.lineIndices) {
      if (lines[idx].bbox.left < dataLeftEdge) dataLeftEdge = lines[idx].bbox.left;
    }
  }

  let headerTop = scanAnchor;

  const aboveLines = [];
  for (let li = 0; li < lines.length; li++) {
    if (allLineIndicesSet.has(li)) continue;
    const line = lines[li];
    if (line.bbox.top >= firstRowY) continue;
    if (line.bbox.bottom <= topFloor) continue;
    if (line.bbox.right < table.bbox.left || line.bbox.left > table.bbox.right) continue;
    aboveLines.push({ idx: li, line });
  }
  aboveLines.sort((a, b) => b.line.bbox.top - a.line.bbox.top); // Nearest the data first, which is the order the gap chain below requires.

  /** @type {{left: number, right: number} | null} */
  let singleSegRange = null;

  for (const { idx, line } of aboveLines) {
    const lineWidth = line.bbox.right - line.bbox.left;

    let isMultiSegment = false;
    for (let lj = 0; lj < lines.length; lj++) {
      if (lj === idx) continue;
      if (Math.abs(lines[lj].bbox.top - line.bbox.top) < 5
          && lines[lj].bbox.right >= table.bbox.left && lines[lj].bbox.left <= table.bbox.right) {
        isMultiSegment = true;
        break;
      }
    }

    // A line ending in "follows:" is the introductory prose above a table, and the test stays this narrow because a sub-header like "Deferred:" or "Current:" also ends in a colon.
    const lineText = line.words.length > 0 ? line.words[line.words.length - 1].text : '';
    if (lineText === 'follows:') break;

    const gapToHeader = headerTop - line.bbox.bottom;
    if (isMultiSegment) {
      if (gapToHeader > avgRowHeight * 2.5) break;
      headerTop = Math.min(headerTop, line.bbox.top);
      singleSegRange = null;
      continue;
    }
    // Skipping rather than breaking lets the chain still reach a multi-segment header row above a misaligned narrow outlier.
    if (gapToHeader > avgRowHeight * 0.45) continue;

    // A wide single-segment line above the table is paragraph text, not a header label.
    if (lineWidth > candidateWidth * 0.6) break;

    // Table content is indented past the body text, so a line starting at the page margin is a section header rather than part of the table.
    if (line.bbox.left < dataLeftEdge - 20) break;

    if (singleSegRange
        && (line.bbox.right < singleSegRange.left || line.bbox.left > singleSegRange.right)) {
      break;
    }

    headerTop = Math.min(headerTop, line.bbox.top);
    if (lineWidth <= candidateWidth * 0.5) {
      if (!singleSegRange) {
        singleSegRange = { left: line.bbox.left, right: line.bbox.right };
      } else {
        singleSegRange.left = Math.min(singleSegRange.left, line.bbox.left);
        singleSegRange.right = Math.max(singleSegRange.right, line.bbox.right);
      }
    }
  }

  let finalTop = Math.max(topFloor, headerTop - 5);

  // Each push moves finalTop down over lines that did not overlap before, so the sweep repeats until nothing more does.
  let pushed = true;
  while (pushed) {
    pushed = false;
    for (let li = 0; li < lines.length; li++) {
      if (allLineIndicesSet.has(li)) continue;
      const line = lines[li];
      if (line.bbox.right < table.bbox.left || line.bbox.left > table.bbox.right) continue;
      if (line.bbox.bottom <= finalTop || line.bbox.top >= firstRowY) continue;

      if (line.bbox.top < finalTop) {
        finalTop = line.bbox.bottom + 1;
        pushed = true;
        continue;
      }

      const lastWord = line.words.length > 0 ? line.words[line.words.length - 1].text : '';
      if (lastWord === 'follows:') {
        finalTop = line.bbox.bottom + 1;
        pushed = true;
        continue;
      }

      const lineWidth = line.bbox.right - line.bbox.left;
      let isMulti = false;
      for (let lj = 0; lj < lines.length; lj++) {
        if (lj === li) continue;
        if (Math.abs(lines[lj].bbox.top - line.bbox.top) < 5
            && lines[lj].bbox.right >= table.bbox.left && lines[lj].bbox.left <= table.bbox.right) {
          isMulti = true;
          break;
        }
      }
      if (!isMulti && lineWidth > candidateWidth * 0.6) {
        finalTop = line.bbox.bottom + 1;
        pushed = true;
      }
    }
  }

  // A "follows:" line sharing the first header row's y-position is captured into table.rows during candidate formation, out of reach of the sweep above.
  for (const r of sortedRows) {
    if (r.y > finalTop + avgRowHeight * 1.5) break;
    let allFollows = true;
    for (const idx of r.lineIndices) {
      const words = lines[idx].words;
      if (words.length > 0 && words[words.length - 1].text !== 'follows:') {
        allFollows = false;
        break;
      }
    }
    if (allFollows && r.lineIndices.length > 0) {
      let rowBot = -Infinity;
      for (const idx of r.lineIndices) rowBot = Math.max(rowBot, lines[idx].bbox.bottom);
      if (rowBot > finalTop) finalTop = rowBot + 1;
    } else {
      break;
    }
  }

  table.bbox.top = finalTop;
}

/**
 * Detect tables anchored to a "ruling row", a y-band containing three or more horizontal paths whose x-extents are mutually disjoint.
 *
 * @param {HLine[]} hLines - hLines from classifyPaths (post-filter, post-merge)
 * @param {import('../objects/ocrObjects.js').OcrPage} pageObj
 * @returns {DetectedTable[]}
 */
function detectHeaderRuleTables(hLines, pageObj) {
  const lines = pageObj.lines;
  if (lines.length === 0) return [];

  const yGroups = [];
  for (const hl of hLines) {
    let group = null;
    for (const g of yGroups) {
      if (Math.abs(g.y - hl.y) <= 3) { group = g; break; }
    }
    if (group) {
      group.lines.push(hl);
      group.y = group.lines.reduce((s, l) => s + l.y, 0) / group.lines.length;
    } else {
      yGroups.push({ y: hl.y, lines: [hl] });
    }
  }

  /** @type {Array<{y: number, cols: Array<{left: number, right: number}>, hLines: HLine[]}>} */
  const rulingRows = [];
  const pageWidth = pageObj.dims.width;
  for (const g of yGroups) {
    // Two disjoint rules at one y are commonly a coincidence of form-field underlines or callout boxes rather than a table's column rules.
    if (g.lines.length < 3) continue;
    const sorted = [...g.lines].sort((a, b) => a.left - b.left);
    let disjoint = true;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].left < sorted[i - 1].right - 1) { disjoint = false; break; }
    }
    if (!disjoint) continue;
    // A rule set spanning little of the page is decorative, clustered in a corner or a footnote area.
    const xSpan = sorted[sorted.length - 1].right - sorted[0].left;
    if (xSpan < pageWidth * 0.3) continue;
    rulingRows.push({
      y: g.y,
      cols: sorted.map((l) => ({ left: l.left, right: l.right })),
      hLines: sorted,
    });
  }

  if (rulingRows.length === 0) return [];
  rulingRows.sort((a, b) => a.y - b.y);

  const isSubsetGeometry = (subRow, primaryRow, tol) => {
    for (const c of subRow.cols) {
      let matched = false;
      for (const pc of primaryRow.cols) {
        if (Math.abs(c.left - pc.left) < tol && Math.abs(c.right - pc.right) < tol) {
          matched = true; break;
        }
      }
      if (!matched) return false;
    }
    return true;
  };

  /** @type {number[]} */
  const primaryIndices = [];
  for (let ri = 0; ri < rulingRows.length; ri++) {
    let isSubtotal = false;
    for (const pi of primaryIndices) {
      if (isSubsetGeometry(rulingRows[ri], rulingRows[pi], 5)) { isSubtotal = true; break; }
    }
    if (!isSubtotal) primaryIndices.push(ri);
  }

  const primaries = primaryIndices.map((ri) => {
    const rule = rulingRows[ri];
    const ruleLeft = rule.cols[0].left;
    const ruleRight = rule.cols[rule.cols.length - 1].right;
    return {
      ri,
      rule,
      ruleLeft,
      ruleRight,
      xSlack: Math.max(20, (ruleRight - ruleLeft) * 0.02),
      headerTopY: rule.y,
      headerLineIndices: /** @type {number[]} */ ([]),
    };
  });

  // The upward header scan stops at the previous ruling row so one table's data block is not adopted as the next table's header.
  for (let pii = 0; pii < primaries.length; pii++) {
    const p = primaries[pii];
    const upperBound = pii > 0 ? primaries[pii - 1].rule.y + 5 : 0;
    const linesAbove = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.bbox.bottom > p.rule.y) continue;
      if (l.bbox.bottom < upperBound) continue;
      if (l.bbox.left < p.ruleLeft - p.xSlack) continue;
      if (l.bbox.right > p.ruleRight + p.xSlack) continue;
      linesAbove.push({ idx: i, line: l });
    }
    linesAbove.sort((a, b) => b.line.bbox.top - a.line.bbox.top);

    // Header rows sit tighter than body rows, so the spacing is measured from the lines just above the rule.
    const tops = linesAbove.slice(0, 8).map((x) => x.line.bbox.top).sort((a, b) => b - a);
    const headerSpacings = [];
    for (let i = 1; i < tops.length; i++) headerSpacings.push(tops[i - 1] - tops[i]);
    headerSpacings.sort((a, b) => a - b);
    const medianHeaderSpacing = headerSpacings[Math.floor(headerSpacings.length / 2)] || 30;
    const gapLimit = Math.max(medianHeaderSpacing * 1.5, 45);

    let prevTopU = p.rule.y;
    for (const { idx, line } of linesAbove) {
      const gap = prevTopU - line.bbox.top;
      if (gap > gapLimit) break;
      p.headerLineIndices.push(idx);
      p.headerTopY = line.bbox.top;
      prevTopU = line.bbox.top;
    }
  }

  // The downward data scan stops at the next ruling row's header top so adjacent tables on a page do not leak into each other.
  const results = [];
  for (let pii = 0; pii < primaries.length; pii++) {
    const p = primaries[pii];
    const lowerBound = pii + 1 < primaries.length
      ? primaries[pii + 1].headerTopY - 1
      : pageObj.dims.height;

    const linesBelow = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.bbox.top < p.rule.y) continue;
      if (l.bbox.top > lowerBound) continue;
      if (l.bbox.left < p.ruleLeft - p.xSlack) continue;
      if (l.bbox.right > p.ruleRight + p.xSlack) continue;
      linesBelow.push({ idx: i, line: l });
    }
    linesBelow.sort((a, b) => a.line.bbox.top - b.line.bbox.top);

    if (linesBelow.length < 2) continue;

    // Prose below the table can fall inside the column extent and pass the x filter, so a large vertical gap is what ends the data scan.
    const earlySpacings = [];
    const earlyN = Math.min(linesBelow.length - 1, 5);
    for (let i = 1; i <= earlyN; i++) {
      earlySpacings.push(linesBelow[i].line.bbox.top - linesBelow[i - 1].line.bbox.top);
    }
    earlySpacings.sort((a, b) => a - b);
    const medianDataSpacing = earlySpacings[Math.floor(earlySpacings.length / 2)] || 30;
    const dataGapLimit = Math.max(medianDataSpacing * 2.5, 80);

    const dataIndices = [];
    let prevDataTop = p.rule.y;
    for (const { idx, line } of linesBelow) {
      const gap = line.bbox.top - prevDataTop;
      if (dataIndices.length > 0 && gap > dataGapLimit) break;
      dataIndices.push(idx);
      prevDataTop = line.bbox.top;
    }
    if (dataIndices.length < 2) continue;
    for (const hIdx of p.headerLineIndices) dataIndices.push(hIdx);

    const colSeparators = [];
    for (let i = 1; i < p.rule.cols.length; i++) {
      colSeparators.push((p.rule.cols[i - 1].right + p.rule.cols[i].left) / 2);
    }

    let bboxBottom = p.rule.y;
    for (const idx of dataIndices) {
      if (lines[idx].bbox.bottom > bboxBottom) bboxBottom = lines[idx].bbox.bottom;
    }

    const regionLines = dataIndices.map((i) => lines[i]);
    const rowGroups = groupLinesIntoRows(regionLines);
    const mappedRows = rowGroups.map((rg) => ({
      lineIndices: rg.lineIndices.map((i) => dataIndices[i]),
      y: rg.y,
    }));

    if (mappedRows.length < 3) continue;

    // Prose paragraphs that happen to sit below a decorative rule lay words out continuously, with at most one number per row.
    const colBounds = [p.ruleLeft, ...colSeparators, p.ruleRight];
    const numColsCount = colBounds.length - 1;
    const colNumericRowCount = new Array(numColsCount).fill(0);
    let numericMultiColRows = 0;
    for (const row of mappedRows) {
      const numColsHit = new Set();
      for (const idx of row.lineIndices) {
        for (const word of lines[idx].words) {
          if (!/\d/.test(word.text)) continue;
          if (!/^[\d,$%.()+-]+$/.test(word.text)) continue;
          const cx = (word.bbox.left + word.bbox.right) / 2;
          for (let ci = 0; ci < colBounds.length - 1; ci++) {
            if (cx >= colBounds[ci] && cx < colBounds[ci + 1]) {
              numColsHit.add(ci);
              break;
            }
          }
        }
      }
      if (numColsHit.size >= 2) numericMultiColRows++;
      for (const ci of numColsHit) colNumericRowCount[ci]++;
    }
    if (numericMultiColRows < 5) continue;
    // The consistency check starts past the label column, since numbers there say nothing about column structure.
    let hasConsistentNumCol = false;
    for (let ci = 1; ci < numColsCount; ci++) {
      if (colNumericRowCount[ci] >= mappedRows.length * 0.5) {
        hasConsistentNumCol = true; break;
      }
    }
    if (!hasConsistentNumCol) continue;

    results.push({
      bbox: {
        left: p.ruleLeft, right: p.ruleRight, top: p.headerTopY, bottom: bboxBottom,
      },
      rows: mappedRows,
      colSeparators,
      hLines: p.rule.hLines,
      vLines: [],
      detectionMethod: 'header-rule',
    });
  }

  return results;
}

/**
 * Group hLines into y-bands of 2 or more disjoint horizontal segments spanning at least 20% of page width.
 * @param {HLine[]} hLines
 * @param {import('../objects/ocrObjects.js').OcrPage} pageObj
 */
function findDisjointRuleClusters(hLines, pageObj) {
  const yGroups = [];
  for (const hl of hLines) {
    let group = null;
    for (const g of yGroups) {
      if (Math.abs(g.y - hl.y) <= 3) { group = g; break; }
    }
    if (group) {
      group.lines.push(hl);
      group.y = group.lines.reduce((s, l) => s + l.y, 0) / group.lines.length;
    } else {
      yGroups.push({ y: hl.y, lines: [hl] });
    }
  }
  const pageWidth = pageObj.dims.width;
  /** @type {Array<{y: number, cols: Array<{left: number, right: number}>}>} */
  const clusters = [];
  for (const g of yGroups) {
    if (g.lines.length < 2) continue;
    const sorted = [...g.lines].sort((a, b) => a.left - b.left);
    let disjoint = true;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].left < sorted[i - 1].right - 1) { disjoint = false; break; }
    }
    if (!disjoint) continue;
    const xSpan = sorted[sorted.length - 1].right - sorted[0].left;
    if (xSpan < pageWidth * 0.2) continue;
    clusters.push({
      y: g.y,
      cols: sorted.map((l) => ({ left: l.left, right: l.right })),
    });
  }
  return clusters;
}

/**
 * Detect a table from an hLine cluster whose horizontal lines are segmented at consistent break points.
 * The break points encode implicit column separators.
 *
 * @param {HLine[]} cluster - hLines with consistent x-extent
 * @param {Array<{left: number, top: number, right: number, bottom: number}>} headerFills
 * @param {import('../objects/ocrObjects.js').OcrPage} pageObj
 * @returns {DetectedTable[]}
 */
function detectSegmentedHLineTables(cluster, headerFills, pageObj) {
  const rowBreaks = [];
  for (const hl of cluster) {
    if (!hl.segments || hl.segments.length < 2) continue;
    const sorted = [...hl.segments].sort((a, b) => a.left - b.left);
    const breaks = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      breaks.push(Math.round(sorted[i].right));
    }
    rowBreaks.push({
      y: hl.y, breaks, left: sorted[0].left, right: sorted[sorted.length - 1].right, hl,
    });
  }

  if (rowBreaks.length < 3) return [];

  // One cluster can hold hLines from several stacked tables whose column structures differ.
  const breakGroups = [];
  for (const rb of rowBreaks) {
    let matched = false;
    for (const group of breakGroups) {
      const ref = group[0].breaks;
      if (ref.length !== rb.breaks.length) continue;
      let consistent = true;
      for (let j = 0; j < ref.length; j++) {
        if (Math.abs(ref[j] - rb.breaks[j]) > 5) { consistent = false; break; }
      }
      if (consistent) {
        group.push(rb);
        matched = true;
        break;
      }
    }
    if (!matched) breakGroups.push([rb]);
  }

  const results = [];
  for (const group of breakGroups) {
    if (group.length < 3) continue;
    if (group[0].breaks.length < 2) continue;

    const colSeparators = group[0].breaks.map((_, j) => {
      let sum = 0;
      for (const rb of group) sum += rb.breaks[j];
      return sum / group.length;
    });

    const groupLeft = Math.min(...group.map((rb) => rb.left));
    const groupRight = Math.max(...group.map((rb) => rb.right));
    const groupTop = Math.min(...group.map((rb) => rb.y));
    const groupBottom = Math.max(...group.map((rb) => rb.y));
    const gridWidth = groupRight - groupLeft;

    if (gridWidth < pageObj.dims.width * 0.3) continue;

    const groupHLines = group.map((rb) => rb.hl);

    let headerFill = null;
    for (const fill of headerFills) {
      if (Math.abs(fill.left - groupLeft) > 15) continue;
      if (Math.abs(fill.right - groupRight) > 15) continue;
      if (fill.bottom > groupTop + 5) continue;
      if (fill.bottom < groupTop - 200) continue;
      headerFill = {
        left: fill.left, top: fill.top, right: fill.right, bottom: fill.bottom,
      };
      break;
    }

    const typicalRowH = (groupBottom - groupTop) / Math.max(1, group.length - 1);
    const bboxTop = headerFill ? headerFill.top - 5 : groupTop - typicalRowH * 1.5;
    const bbox = {
      left: groupLeft,
      top: Math.max(0, bboxTop),
      right: groupRight,
      bottom: groupBottom + 5,
    };

    const regionLineIndices = [];
    for (let i = 0; i < pageObj.lines.length; i++) {
      const line = pageObj.lines[i];
      if (line.bbox.top >= bbox.top - 5 && line.bbox.bottom <= bbox.bottom + 5
        && line.bbox.left >= bbox.left - 10 && line.bbox.right <= bbox.right + 10) {
        regionLineIndices.push(i);
      }
    }

    if (regionLineIndices.length < 2) continue;

    const regionLines = regionLineIndices.map((i) => pageObj.lines[i]);
    const rowGroups = groupLinesIntoRows(regionLines);
    const mappedRows = rowGroups.map((rg) => ({
      lineIndices: rg.lineIndices.map((i) => regionLineIndices[i]),
      y: rg.y,
    }));

    if (mappedRows.length < 2) continue;

    const multiSegGridRows = mappedRows.filter((r) => r.lineIndices.length >= 2).length;
    if (multiSegGridRows < 2) continue;

    results.push({
      bbox,
      rows: mappedRows,
      colSeparators: colSeparators.sort((a, b) => a - b),
      hLines: groupHLines,
      vLines: [],
      detectionMethod: 'segmented-hline',
      headerFill,
    });
  }

  return results;
}

const TABLE_TITLE_RE = /^Table\s+\d+/i;

/**
 * Detect a table title by scanning for a "Table N" line above or at the top of the table.
 * @param {DetectedTable} table
 * @param {import('../objects/ocrObjects.js').OcrLine[]} lines - All page lines
 * @returns {{ text: string, bbox: {left: number, top: number, right: number, bottom: number} } | null}
 */
function detectTableTitle(table, lines) {
  const maxAboveDist = 50;

  let bestAbove = null;
  for (const line of lines) {
    if (line.bbox.bottom > table.bbox.top) continue;
    if (line.bbox.bottom < table.bbox.top - maxAboveDist) continue;
    if (line.bbox.right < table.bbox.left || line.bbox.left > table.bbox.right) continue;
    const text = line.words.map((w) => w.text).join(' ');
    if (!TABLE_TITLE_RE.test(text)) continue;
    const dist = table.bbox.top - line.bbox.bottom;
    if (!bestAbove || dist < bestAbove.dist) {
      bestAbove = {
        text,
        bbox: {
          left: line.bbox.left, top: line.bbox.top, right: line.bbox.right, bottom: line.bbox.bottom,
        },
        dist,
      };
    }
  }
  if (bestAbove) return { text: bestAbove.text, bbox: bestAbove.bbox };

  let firstInside = null;
  for (const line of lines) {
    if (line.bbox.top < table.bbox.top || line.bbox.top > table.bbox.bottom) continue;
    if (line.bbox.right < table.bbox.left || line.bbox.left > table.bbox.right) continue;
    if (!firstInside || line.bbox.top < firstInside.bbox.top) firstInside = line;
  }
  if (firstInside) {
    const text = firstInside.words.map((w) => w.text).join(' ');
    if (TABLE_TITLE_RE.test(text)) {
      return {
        text,
        bbox: {
          left: firstInside.bbox.left, top: firstInside.bbox.top, right: firstInside.bbox.right, bottom: firstInside.bbox.bottom,
        },
      };
    }
  }

  return null;
}

/**
 * Widen a table's bbox to capture adjacent content that detection missed.
 * That is an unstroked left label column, a summary or continuation row below the last grid line, and a heading above the header band within that label column.
 * @param {DetectedTable} table
 * @param {import('../objects/ocrObjects.js').OcrLine[]} lines
 * @param {DetectedTable[]} [siblings] - Other tables on the page, which clamp the bottom extension so it cannot swallow a stacked sibling's rows.
 */
function extendTableToAdjacentContent(table, lines, siblings) {
  if (table.rows.length < 2) return;

  const sortedRows = [...table.rows].sort((a, b) => a.y - b.y);
  const spacings = [];
  for (let i = 1; i < sortedRows.length; i++) {
    spacings.push(sortedRows[i].y - sortedRows[i - 1].y);
  }
  spacings.sort((a, b) => a - b);
  const medianSpacing = spacings.length > 0 ? spacings[Math.floor(spacings.length / 2)] : 50;
  const yMatch = Math.max(10, medianSpacing * 0.4);

  const existingLineSet = new Set(table.rows.flatMap((r) => r.lineIndices));

  // === Left extension ===
  // A line starting left of the bbox but running into it is a label merged with its first value in one stream line.
  // Such a line cannot confirm a label column on its own, but once independent lines confirm one it carries that row's label text.
  const bboxWidth = table.bbox.right - table.bbox.left;
  const leftAdjByRow = new Map();
  const overlapByRow = new Map();
  for (let i = 0; i < lines.length; i++) {
    if (existingLineSet.has(i)) continue;
    const line = lines[i];
    if (line.bbox.left >= table.bbox.left - 10) continue;
    let matchedRowY = null;
    for (const r of table.rows) {
      if (Math.abs(line.bbox.top - r.y) <= yMatch) {
        matchedRowY = r.y;
        break;
      }
    }
    if (matchedRowY === null) continue;
    const lineWidth = line.bbox.right - line.bbox.left;
    const clearlyLeft = line.bbox.right < table.bbox.left - 10;
    const reasonableWidth = lineWidth < bboxWidth * 0.5;
    if (clearlyLeft && reasonableWidth) {
      if (!leftAdjByRow.has(matchedRowY)) leftAdjByRow.set(matchedRowY, []);
      leftAdjByRow.get(matchedRowY).push({ idx: i, line });
    } else if (!clearlyLeft) {
      if (!overlapByRow.has(matchedRowY)) overlapByRow.set(matchedRowY, []);
      overlapByRow.get(matchedRowY).push({ idx: i, line });
    }
  }

  let extendedLeft = false;
  const oldBBoxLeft = table.bbox.left;
  if (leftAdjByRow.size > table.rows.length * 0.5 && leftAdjByRow.size >= 2) {
    let newLeft = Infinity;
    let maxRight = -Infinity;
    let alphabeticLines = 0;
    for (const arr of leftAdjByRow.values()) {
      for (const { line } of arr) {
        if (line.bbox.left < newLeft) newLeft = line.bbox.left;
        if (line.bbox.right > maxRight) maxRight = line.bbox.right;
        for (const word of line.words) {
          if (/[a-zA-Z]/.test(word.text)) { alphabeticLines++; break; }
        }
      }
    }
    // A line-numbered legal filing puts pure-numeric per-row markers in the left margin, which are narrow and clearly left of the bbox without being a label column.
    if (alphabeticLines === 0) return;
    // Each line of a side-by-side table in the next page column can pass the per-line width test, so only the aggregate span keeps a parallel table body from being absorbed as a label strip.
    const candidateLabelSpan = maxRight - newLeft;
    if (candidateLabelSpan >= bboxWidth * 0.5) return;
    if (newLeft < oldBBoxLeft - 10) {
      table.colSeparators = [oldBBoxLeft, ...table.colSeparators].sort((a, b) => a - b);
      table.bbox.left = newLeft;
      for (const [rowY, arr] of leftAdjByRow) {
        const r = table.rows.find((row) => row.y === rowY);
        if (r) {
          for (const { idx } of arr) {
            if (!r.lineIndices.includes(idx)) r.lineIndices.push(idx);
          }
        }
      }
      for (const [rowY, arr] of overlapByRow) {
        const r = table.rows.find((row) => row.y === rowY);
        if (r) {
          for (const { idx } of arr) {
            if (!r.lineIndices.includes(idx)) r.lineIndices.push(idx);
          }
        }
      }
      extendedLeft = true;
    }
  }

  // === Top extension ===
  if (extendedLeft) {
    const labelColRight = table.colSeparators[0];
    const labelColLeft = table.bbox.left;
    const topLimit = table.bbox.top - medianSpacing * 2;
    for (let i = 0; i < lines.length; i++) {
      if (existingLineSet.has(i)) continue;
      const line = lines[i];
      if (line.bbox.top >= table.bbox.top) continue;
      if (line.bbox.top < topLimit) continue;
      if (line.bbox.left < labelColLeft - 5 || line.bbox.right > labelColRight + 5) continue;
      if (line.bbox.top < table.bbox.top) table.bbox.top = line.bbox.top;
    }
  }

  // === Bottom extension ===
  const colBoundaries = [table.bbox.left, ...table.colSeparators, table.bbox.right];
  let belowLimit = table.bbox.bottom + medianSpacing * 1.5;
  if (siblings) {
    for (const other of siblings) {
      if (other === table || !other.rows || other.rows.length === 0) continue;
      if (other.bbox.right < table.bbox.left || other.bbox.left > table.bbox.right) continue;
      let otherFirstRowY = Infinity;
      for (const r of other.rows) if (r.y < otherFirstRowY) otherFirstRowY = r.y;
      if (otherFirstRowY > table.bbox.bottom && otherFirstRowY - 5 < belowLimit) {
        belowLimit = otherFirstRowY - 5;
      }
    }
  }
  const belowLinesByY = new Map();
  for (let i = 0; i < lines.length; i++) {
    if (existingLineSet.has(i)) continue;
    const line = lines[i];
    const ly = line.bbox.top;
    if (ly <= table.bbox.bottom || ly > belowLimit) continue;
    if (line.bbox.right < table.bbox.left || line.bbox.left > table.bbox.right) continue;
    let matchedY = null;
    for (const y of belowLinesByY.keys()) {
      if (Math.abs(ly - y) < 5) { matchedY = y; break; }
    }
    if (matchedY === null) {
      belowLinesByY.set(ly, [{ idx: i, line }]);
    } else {
      belowLinesByY.get(matchedY).push({ idx: i, line });
    }
  }

  const sortedBelowYs = [...belowLinesByY.keys()].sort((a, b) => a - b);
  for (const y of sortedBelowYs) {
    const arr = belowLinesByY.get(y);
    // A lone line below the grid is more likely a footnote than a continuation row.
    if (arr.length < 2) continue;
    let colHits = 0;
    for (const { line } of arr) {
      for (let c = 0; c < colBoundaries.length - 1; c++) {
        if (line.bbox.right > colBoundaries[c] && line.bbox.left < colBoundaries[c + 1]) {
          colHits++; break;
        }
      }
    }
    if (colHits < 2) break;
    let rowBottom = table.bbox.bottom;
    for (const { line } of arr) {
      if (line.bbox.bottom > rowBottom) rowBottom = line.bbox.bottom;
    }
    table.bbox.bottom = rowBottom;
    table.rows.push({
      y,
      lineIndices: arr.map((a) => a.idx),
    });
  }
}

/**
 * Validate that a table's content follows row-major stream order.
 */
function validateStreamOrder(table, lines) {
  // Order between rows is deliberately unchecked, since on a two-column page the left column's rows (low indices) interleave with the right column's (high indices) at similar y-positions.
  // Failing the whole table over one bad row would lose tables that merely picked up a stray line, so the offending row is dropped instead.
  // A column-major layout emits each cell as its own stream segment, so its rows are scattered across the stream and spatial order never matches.
  for (let i = table.rows.length - 1; i >= 0; i--) {
    const row = table.rows[i];
    if (row.lineIndices.length < 2) continue;
    let maxGap = 0;
    for (let k = 1; k < row.lineIndices.length; k++) {
      const g = row.lineIndices[k] - row.lineIndices[k - 1];
      if (g > maxGap) maxGap = g;
    }
    if (maxGap > 2) continue;
    const sorted = [...row.lineIndices].sort((a, b) => lines[a].bbox.left - lines[b].bbox.left);
    let bad = false;
    for (let j = 1; j < sorted.length; j++) {
      if (sorted[j] < sorted[j - 1]) {
        bad = true;
        break;
      }
    }
    if (bad) table.rows.splice(i, 1);
  }

  return table.rows.length >= 3;
}

// === Utility functions ===

/**
 * @param {number[]} indices
 * @param {import('../objects/ocrObjects.js').OcrLine[]} lines
 */
function computeBboxFromLineIndices(indices, lines) {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const i of indices) {
    const b = lines[i].bbox;
    if (b.left < left) left = b.left;
    if (b.top < top) top = b.top;
    if (b.right > right) right = b.right;
    if (b.bottom > bottom) bottom = b.bottom;
  }
  return {
    left, top, right, bottom,
  };
}

/**
 * @param {{left: number, top: number, right: number, bottom: number}} a
 * @param {{left: number, top: number, right: number, bottom: number}} b
 */
function bboxOverlap(a, b) {
  const overlapLeft = Math.max(a.left, b.left);
  const overlapTop = Math.max(a.top, b.top);
  const overlapRight = Math.min(a.right, b.right);
  const overlapBottom = Math.min(a.bottom, b.bottom);
  if (overlapRight <= overlapLeft || overlapBottom <= overlapTop) return 0;
  const overlapArea = (overlapRight - overlapLeft) * (overlapBottom - overlapTop);
  const aArea = (a.right - a.left) * (a.bottom - a.top);
  const bArea = (b.right - b.left) * (b.bottom - b.top);
  const minArea = Math.min(aArea, bArea);
  return minArea > 0 ? overlapArea / minArea : 0;
}

/**
 * Split an hLine cluster into sub-clusters by finding large y-gaps.
 * @param {HLine[]} cluster
 */
function splitClusterByYGap(cluster) {
  const sorted = [...cluster].sort((a, b) => a.y - b.y);

  // Per-cell hLine segments at the same y produce many zero gaps that would drag the median to zero.
  const uniqueYEntries = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i === 0 || sorted[i].y - sorted[i - 1].y > 2) {
      uniqueYEntries.push({ y: sorted[i].y, index: i });
    }
  }
  if (uniqueYEntries.length < 2) return [cluster];

  const gaps = [];
  for (let i = 1; i < uniqueYEntries.length; i++) {
    gaps.push({ gap: uniqueYEntries[i].y - uniqueYEntries[i - 1].y, index: uniqueYEntries[i].index });
  }

  const sortedGaps = [...gaps].sort((a, b) => a.gap - b.gap);
  const medianGap = sortedGaps[Math.floor((sortedGaps.length - 1) / 2)].gap;
  const maxEntry = sortedGaps[sortedGaps.length - 1];
  const gapRatioLimit = uniqueYEntries.length >= 10 ? 4 : 5;

  if (medianGap <= 0 || maxEntry.gap <= medianGap * gapRatioLimit) {
    return [cluster];
  }

  const left = sorted.slice(0, maxEntry.index);
  const right = sorted.slice(maxEntry.index);
  return [...splitClusterByYGap(left), ...splitClusterByYGap(right)];
}

/**
 * Cluster horizontal lines by x-extent, joining those that overlap substantially or nearly touch.
 * @param {HLine[]} hLines
 */
function clusterHLinesByXExtent(hLines) {
  /** @type {Array<{lines: HLine[], left: number, right: number}>} */
  const clusters = [];
  for (const hl of hLines) {
    let added = false;
    for (const cluster of clusters) {
      const overlapLeft = Math.max(hl.left, cluster.left);
      const overlapRight = Math.min(hl.right, cluster.right);
      const overlap = Math.max(0, overlapRight - overlapLeft);
      const hlWidth = hl.right - hl.left;
      const clusterWidth = cluster.right - cluster.left;
      const minWidth = Math.min(hlWidth, clusterWidth);
      // A grid drawn as per-cell border segments produces hLines that abut at column boundaries without overlapping at all.
      const gap = overlapLeft - overlapRight; // positive = gap, negative = overlap
      if ((minWidth > 0 && overlap / minWidth > 0.5) || (gap >= 0 && gap < 15)) {
        cluster.lines.push(hl);
        if (hl.left < cluster.left) cluster.left = hl.left;
        if (hl.right > cluster.right) cluster.right = hl.right;
        added = true;
        break;
      }
    }
    if (!added) {
      clusters.push({ lines: [hl], left: hl.left, right: hl.right });
    }
  }
  return clusters.map((c) => c.lines);
}

/**
 * Cluster numeric values by proximity (within tolerance).
 * Returns the median of each cluster.
 * @param {number[]} values
 * @param {number} tolerance
 */
function clusterValues(values, tolerance) {
  if (values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const clusters = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const lastCluster = clusters[clusters.length - 1];
    const lastMedian = lastCluster[Math.floor(lastCluster.length / 2)];
    if (sorted[i] - lastMedian <= tolerance) {
      lastCluster.push(sorted[i]);
    } else {
      clusters.push([sorted[i]]);
    }
  }
  return clusters.map((c) => c[Math.floor(c.length / 2)]);
}
