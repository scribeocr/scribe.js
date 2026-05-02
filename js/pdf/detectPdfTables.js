import { calcColumnBounds } from '../utils/detectTables.js';

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
 * @typedef {{left: number, right: number, y: number, segments?: Array<{left: number, right: number}>}} HLine - Horizontal line in display coords (y-down, DPI-scaled)
 * @typedef {{top: number, bottom: number, x: number}} VLine - Vertical line in display coords
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

  // === Phase 0: Quick bail-out ===
  // Dot-leader rows ("Gold Star ......... 68,300 63,700 58,800") emit each
  // visual row as one OCR line, so they produce zero same-y line pairs but
  // are still tables. The ≥3-rows-within-300pt cluster check distinguishes
  // them from scattered Table-of-Authorities citations.
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
    // Path-only fallback: grid + header-rule.
    const gridOnly = detectGridTables(pageObj, paths, scale, visualHeightPts, boxOriginX, boxOriginY)
      .filter((t) => t.colSeparators.length > 0);
    const pathDataEarly = classifyPaths(paths, scale, visualHeightPts, pageObj, boxOriginX, boxOriginY);
    const headerRuleEarly = detectHeaderRuleTables(pathDataEarly.hLines, pageObj);
    for (const ht of headerRuleEarly) {
      let blocked = false;
      for (const v of gridOnly) {
        if (bboxOverlap(v.bbox, ht.bbox) > 0.3) { blocked = true; break; }
      }
      if (!blocked) gridOnly.push(ht);
    }
    return gridOnly;
  }

  // === Phase 1: Row analysis and table-like row identification ===
  // Group lines into rows by y-proximity. Only examine rows with 2+ lines.
  // Single-line rows can also qualify if they contain a text label followed by 3+ numbers
  // (e.g., "Total physical volumes (BBtue/d) 51,715 32,429 27,308"). These are table data rows
  // where the PDF produced a single line object containing both the label and all number columns.
  const rows = groupLinesIntoRows(lines);
  const tableLikeRows = [];

  for (const row of rows) {
    if (row.lineIndices.length < 2) {
      // Single-fragment row: check if it's a single-line table row (label + numbers).
      if (row.lineIndices.length === 1 && isRightClusteredNumeric(lines[row.lineIndices[0]].words)) {
        tableLikeRows.push({ ...row, hasNumbers: true });
      }
      continue;
    }

    // Signal A: Stream-order consecutiveness.
    // Table cells at the same y are consecutive in the lines array (row-major).
    // Multi-column text segments at the same y are far apart (column-major).
    const indices = row.lineIndices;
    let maxGap = 0;
    for (let i = 1; i < indices.length; i++) {
      const gap = indices[i] - indices[i - 1];
      if (gap > maxGap) maxGap = gap;
    }
    const isConsecutive = maxGap <= 2;
    if (!isConsecutive) {
      // On multi-column pages, lines from different page columns at the same y
      // get grouped into one row, creating large index gaps. Split the row into
      // consecutive sub-sequences and test each independently.
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

      // Column-major stream layout: each cell is its own line, scattered across
      // the stream (label column first, then col-1 body, col-2 body, ...). This
      // produces a row with N single-line subs. If 3+ subs are pure-numeric
      // singletons, accept the whole row as a single multi-segment table row.
      // (Plain multi-column page text won't pass — its fragments are word-rich
      // text, not single numeric tokens.)
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
          // Single-fragment sub-row: check if it's a single-line table row (label + numbers).
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

    // Signal B: Numeric content.
    let numericWordCount = 0;
    for (const idx of indices) {
      for (const word of lines[idx].words) {
        if (/^[\d,$%.()+-]+$/.test(word.text) && /\d/.test(word.text)) {
          numericWordCount++;
        }
      }
    }
    const hasNumbers = numericWordCount >= 1;

    // A row is "table-like" if consecutive in stream order AND
    // (has numbers OR has 3+ segments).
    if (hasNumbers || indices.length >= 3) {
      tableLikeRows.push({ ...row, hasNumbers });
    }
  }

  if (tableLikeRows.length === 0) {
    const gridFallback = detectGridTables(pageObj, paths, scale, visualHeightPts, boxOriginX, boxOriginY)
      .filter((t) => t.colSeparators.length > 0);
    const pathDataFallback = classifyPaths(paths, scale, visualHeightPts, pageObj, boxOriginX, boxOriginY);
    const headerRuleFallback = detectHeaderRuleTables(pathDataFallback.hLines, pageObj);
    for (const ht of headerRuleFallback) {
      let blocked = false;
      for (const v of gridFallback) {
        if (bboxOverlap(v.bbox, ht.bbox) > 0.3) { blocked = true; break; }
      }
      if (!blocked) gridFallback.push(ht);
    }
    return gridFallback;
  }

  // === Phase 2: Group table-like rows into candidate regions ===
  const candidates = groupRowsIntoCandidates(tableLikeRows, lines);
  if (candidates.length === 0) {
    // Fallback: try grid detection from paths alone (for text-only tables with full grid)
    const gridFallback = detectGridTables(pageObj, paths, scale, visualHeightPts, boxOriginX, boxOriginY)
      .filter((t) => t.colSeparators.length > 0);
    const pathDataFallback = classifyPaths(paths, scale, visualHeightPts, pageObj, boxOriginX, boxOriginY);
    const headerRuleFallback = detectHeaderRuleTables(pathDataFallback.hLines, pageObj);
    for (const ht of headerRuleFallback) {
      let blocked = false;
      for (const v of gridFallback) {
        if (bboxOverlap(v.bbox, ht.bbox) > 0.3) { blocked = true; break; }
      }
      if (!blocked) gridFallback.push(ht);
    }
    return gridFallback;
  }

  // === Phase 3: Path data classification ===
  const pathData = classifyPaths(paths, scale, visualHeightPts, pageObj, boxOriginX, boxOriginY);

  // Correlate paths with candidates
  for (const candidate of candidates) {
    correlatePathsWithCandidate(candidate, pathData);
  }

  // === Phase 3.5: Structural row-band extraction ===
  // Extract regions where filled rectangles form a row-banding pattern with
  // a consistent disjoint-x column structure. These regions directly encode
  // both row boundaries and column positions of tables that use row
  // highlighting or per-cell cell backgrounds.
  const rowBandRegions = extractRowBandStructure(pathData.filledRects);

  // === Phase 4: Validation ===
  const validated = candidates.filter((c) => validateCandidate(c, lines));

  // Grid-based tables override text-based tables in overlapping regions.
  // Grid detection (from hLines + vLines) provides exact column positions,
  // which is more reliable than text-alignment-based column inference.
  // Only consider grid tables with 1+ interior column separators — a 0-column
  // grid is just a box, and allowing it to replace a text-based table would destroy valid detections.
  const gridTables = detectGridTables(pageObj, paths, scale, visualHeightPts, boxOriginX, boxOriginY)
    .filter((t) => t.colSeparators.length > 0);
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
    cand.rowBandRegion = rbr;
    if (cand.detectionMethod === 'grid') continue;
    const prevTop = cand.bbox.top;
    const prevBottom = cand.bbox.bottom;
    const prevLeft = cand.bbox.left;
    const prevRight = cand.bbox.right;
    cand.bbox.top = Math.min(cand.bbox.top, rbr.top);
    cand.bbox.bottom = Math.max(cand.bbox.bottom, rbr.bottom);
    cand.bbox.left = Math.min(cand.bbox.left, rbr.left);
    cand.bbox.right = Math.max(cand.bbox.right, rbr.right);
    // When extending leftward and the candidate's column structure was
    // derived from path geometry (header-rule / segmented-hline), the old
    // bbox.left was the boundary between an unmodeled label column and the
    // first data column — preserve it as a separator so the new label
    // segment doesn't merge into the first data column.
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

  // Multi-region candidates: split into one candidate per region.
  //
  // Two paths trigger a split:
  //   (a) 3+ regions and every region carries 5+ bands — typical multi-year
  //       financial summary where each fiscal year is its own banded block
  //       and section breaks between them are too subtle (just a section
  //       label) to detect as narrative.
  //   (b) Adjacent regions are separated by a wide single-segment narrative
  //       line (paragraph, footnote, or intro prose) — a clear authorial
  //       section break that confirms the regions belong to different
  //       tables. Applies for any region count ≥2 (with ≥2 bands each), so
  //       sibling tables stacked vertically with brief paragraphs between
  //       them split correctly even when each side has few banded rows.
  //
  // Single tables whose internal sub-sections happen to span multiple
  // banded regions (multi-year reconciliations, segment breakdowns) typically
  // have narrow section labels between regions, not wide narrative lines —
  // they remain merged.
  for (const [cand, regions] of candToRegions) {
    if (regions.length < 2) continue;
    const allHaveFiveBands = regions.every((r) => r.rowYs.length >= 5);
    const allHaveTwoBands = regions.every((r) => r.rowYs.length >= 2);
    // Sibling tables stacked vertically have their own column layouts;
    // sub-sections of one table share columns. Compare adjacent regions'
    // colXs (column anchors inferred from band rectangles) — distinct
    // anchors signal distinct tables (e.g. p39's stock-option transaction
    // table with 4 numeric cols vs the weighted-averages table with 3
    // cols below it), while matching anchors signal one logical table
    // split by a tall row or warning text (e.g. 560863 p30's
    // troubleshooting list whose two banded sections share identical
    // column structure).
    const sortedByTop = [...regions].sort((a, b) => a.top - b.top);
    let shouldSplit = false;
    if (regions.length >= 3 && allHaveFiveBands) {
      shouldSplit = true;
    } else if (allHaveTwoBands) {
      // Sibling tables stacked vertically have THEIR OWN header rows
      // between the banded sections — column-aligned text cells (multi-
      // segment row) introducing the next table's columns. Sub-sections
      // of one table separated by a tall data row or wraparound prose
      // have NO new column header between sections — the columns continue.
      let allSeparatedByHeader = true;
      for (let ri = 1; ri < sortedByTop.length; ri++) {
        const gapTop = sortedByTop[ri - 1].bottom;
        const gapBottom = sortedByTop[ri].top;
        // Group lines in the gap by y (5pt tolerance). A y-group with 2+
        // line-fragments overlapping the candidate's x-range is a multi-
        // segment row, characteristic of a new table's column-header band.
        /** @type {Array<{y: number, count: number}>} */
        const yGroups = [];
        for (const line of lines) {
          if (line.bbox.top < gapTop || line.bbox.top >= gapBottom) continue;
          if (line.bbox.right < cand.bbox.left || line.bbox.left > cand.bbox.right) continue;
          let matched = false;
          for (const g of yGroups) {
            if (Math.abs(g.y - line.bbox.top) < 5) { g.count++; matched = true; break; }
          }
          if (!matched) yGroups.push({ y: line.bbox.top, count: 1 });
        }
        const hasHeaderRow = yGroups.some((g) => g.count >= 2);
        if (!hasHeaderRow) { allSeparatedByHeader = false; break; }
      }
      if (allSeparatedByHeader) shouldSplit = true;
    }
    if (!shouldSplit) continue;
    candsToRemove.add(cand);
    for (const rbr of regions) {
      for (const c of makeRowBandCandidates(rbr, cand, lines)) candsToAdd.push(c);
    }
  }

  // Unattached regions: synthesize candidates from band geometry.
  // Text clustering missed these because the table relies on row-shading rather
  // than on column-aligned text patterns to cohere.
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

  //
  // Header detection runs FIRST. Downstream passes (column inference in
  // extractStructure, bbox refinement in refineTableTop) consult
  // table.headers as a first-class signal rather than re-deriving header
  // information ad-hoc. See detectHeaders() for the rule set.
  for (const table of validated) {
    table.headers = detectHeaders(table, lines);
  }
  for (const table of validated) {
    extractStructure(table, lines);
  }

  // Header-rule tables (column-spanning underlines). Yield to grid/segmented-hline
  // (stronger path geometry). Yield to text-derived tables too, except when the
  // text table has anomalously narrow columns — a sign that text-clustering split
  // a $ currency glyph into its own column. In that case the header-rule's column
  // count is more reliable. Runs AFTER extractStructure so text tables have their
  // colSeparators populated for the comparison.
  const headerRuleTables = detectHeaderRuleTables(pathData.hLines, pageObj);
  // A "narrow" text column is one that's too tight to hold a label or full
  // numeric value — the typical signature of a $ currency glyph split into
  // its own column. Threshold tuned to catch the $-split pattern (~10–80px)
  // without flagging legitimate tight numeric columns (>120px).
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
      if (v.detectionMethod === 'grid' || v.detectionMethod === 'segmented-hline') {
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
      // Keep text only when it found strictly more columns AND none of them
      // are narrow ($-glyph-split signature). Equal column counts let
      // header-rule win because its bbox is more often correct (it doesn't
      // truncate the top header rows).
      if (maxTextCols > htCols && !anyNarrow) continue;
    }
    for (let i = validated.length - 1; i >= 0; i--) {
      const v = validated[i];
      if (v.detectionMethod === 'grid' || v.detectionMethod === 'segmented-hline') continue;
      if (bboxOverlap(v.bbox, ht.bbox) > 0.3) {
        validated.splice(i, 1);
      }
    }
    validated.push(ht);
  }

  // Phase 5.4: Re-attach row-band regions to header-rule tables
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
    cand.rowBandRegion = rbr;
    if (cand.detectionMethod === 'grid') continue;
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

  // Split row-band-attached candidates when their data rows have a big
  // y-gap — sibling sub-tables (e.g. Assets / Liabilities) commonly share a
  // single header rule and a single banded stripe even though they're
  // structurally separate. Split candidates inherit column structure.
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
    // Only split when exactly two groups appear. Three-or-more groups are
    // typically internal sub-sections of one larger table (e.g. plan-asset
    // categories) rather than truly sibling tables — splitting those would
    // fragment a single logical table.
    if (groups.length !== 2) continue;
    // Only split when both groups close with a "Total …" row.
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
        // Non-first groups must not extend their bbox.top above their own
        // first row — refineTableTop's gap-scan would otherwise chain upward
        // through the previous split's data rows and pull bbox.top to the
        // shared column-header band.
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
  // Now that hLine data is available (from Phase 3 path correlation), replace the
  // generous expansion from Phase 2 with an intelligent header scan. This determines
  // where the table actually starts by looking for header-like content above the
  // first detected data row, using hLines as the primary signal and multi-segment /
  // width analysis as fallback.
  //
  // Path-derived methods (segmented-hline, header-rule) carry authoritative
  // bbox.top from drawn vector geometry and are exempt — except when a row-band
  // region was attached, which means the band marks the first data row and any
  // header rows still need to be picked up above it.
  for (const table of validated) {
    const hasBand = !!table.rowBandRegion;
    if (table.splitTopLocked) continue;
    if (!hasBand && table.detectionMethod === 'segmented-hline') continue;
    if (!hasBand && table.detectionMethod === 'header-rule') continue;
    // Lines belonging to another table's bbox must not pull this table's top
    // upward. Without a floor, a stacked sibling whose data rows visually
    // resemble headers (multi-segment numerics) chains the upward scan
    // through the entire neighbor and stops only at its intro prose.
    let topFloor = 0;
    for (const other of validated) {
      if (other === table) continue;
      if (other.bbox.bottom <= table.bbox.top
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

  // Filter out single-column tables (0 column separators) and text-detected
  // tables with sliver columns. A column too narrow to hold cell content
  // (≤30px) almost always comes from word-clustering on noise — a stray
  // footnote marker, page-number, or sidebar element pulled into its own
  // "column" — not from a real data column. Path-derived methods (grid,
  // segmented-hline, header-rule) carry authoritative column geometry from
  // the PDF itself and are exempt.
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
  // Grid detection derives bbox.left from drawn vector lines, which may not
  // reach a table's leftmost label column (labels rarely carry stroked borders).
  // Summary rows (e.g. "Previous Year") drawn just below the last stroked grid
  // line get similarly excluded. This pass rescues both patterns using text
  // geometry. A purely text-based candidate whose bbox already spans the label
  // column is unaffected — nothing sits left of bbox.left to extend into.
  //
  // Run AFTER the multiCol filter: the extension adds a column separator on
  // left extension and can add rows on bottom extension, but we don't want
  // those additions to promote a single-column or sub-3-row non-table into a
  // valid table. Extending only confirmed multi-column tables keeps this
  // pass orthogonal from validation.
  for (const table of multiCol) {
    if (table.detectionMethod === 'segmented-hline') continue;
    if (table.detectionMethod === 'header-rule') continue;
    extendTableToAdjacentContent(table, lines);
  }

  // === Phase 5.7: Refine text-table column structure from rule clusters ===
  // Rule clusters carry authoritative column geometry; word-clustering is a
  // fallback. Override text seps with rule-gap midpoints when a cluster sits
  // inside the table; synthesize a label-column sep if the table extends
  // left of the leftmost rule.
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
    // Text > rule col count: rule likely encodes only major groupings while
    // text captures sub-columns. Keep text.
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
  return multiCol.filter((t) => validateStreamOrder(t, lines));
}

/**
 * Collect lines whose bbox sits inside `bbox` and group them into rows.
 * Used by row-band candidate construction and post-snap row repopulation.
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
 * Build synthetic table candidate(s) seeded from a row-band region. Used both
 * for unattached regions (no text candidate covered the band) and to split a
 * text candidate that spans several disjoint regions.
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
      // First group keeps the original band-region top so that header rows
      // above the first data row stay inside; later groups start at their own
      // first-row y so they don't pull bbox.top back into the previous group.
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
function groupRowsIntoCandidates(tableLikeRows, lines) {
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

  /** @type {DetectedTable[]} */
  const candidates = [];
  let runStart = 0;

  for (let i = 1; i <= tableLikeRows.length; i++) {
    // Check if this row is vertically close to the previous one.
    // When the direct gap exceeds the threshold, check if non-table lines (e.g., section headers
    // in financial tables) bridge the gap — if every step through intervening lines is small, continue.
    let isContinuation = false;
    if (i < tableLikeRows.length) {
      const directGap = tableLikeRows[i].y - tableLikeRows[i - 1].y;
      if (directGap < yGapThreshold) {
        isContinuation = true;
      } else {
        // Check if a small number of non-table lines bridge the gap (section headers in financial
        // tables are typically 1-2 lines). Only count lines in the same x-region as the table rows
        // (on two-column pages, lines from the other column shouldn't count as bridges).
        const yLow = tableLikeRows[i - 1].y;
        const yHigh = tableLikeRows[i].y;

        // Compute x-extent using only the two rows bracketing the gap.
        // Using the full run's x-extent would include rows from other columns on multi-column
        // pages, causing unrelated cross-column prose to inflate the intervening line count.
        let runLeft = Infinity;
        let runRight = -Infinity;
        for (const ri of [i - 1, i]) {
          for (const idx of tableLikeRows[ri].lineIndices) {
            if (lines[idx].bbox.left < runLeft) runLeft = lines[idx].bbox.left;
            if (lines[idx].bbox.right > runRight) runRight = lines[idx].bbox.right;
          }
        }

        const runWidth = runRight - runLeft;
        // Tolerance scales with table width: section headers in wide tables can sit
        // 50-100pt left of the data column due to label-column indentation. Fixed
        // 50pt is too tight for tables wider than ~1000pt.
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
            // Only count lines whose x-position overlaps the table's x-region.
            const lx = lines[li].bbox.left;
            if (lx >= runLeft - xTol && lx <= runRight) {
              bridgeYs.push(ly);
              // Section headers are short; paragraph/footnote text spans most of the width.
              const lineWidth = lines[li].bbox.right - lines[li].bbox.left;
              if (lineWidth > runWidth * 0.6) anyWide = true;
            }
          }
        }
        const interveningCount = bridgeYs.length - 1; // exclude yLow
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
      // End of run from runStart to i-1
      const run = tableLikeRows.slice(runStart, i);
      const hasAnyNumbers = run.some((r) => r.hasNumbers);
      const minRows = hasAnyNumbers ? 3 : 4;

      if (run.length >= minRows) {
        // Split run into x-region groups if rows occupy non-overlapping horizontal regions.
        // On multi-column pages, tables in different columns can be vertically close enough
        // to form a single run. Splitting by x-overlap separates them into distinct candidates.
        const rowExtents = run.map((r) => {
          let left = Infinity;
          let right = -Infinity;
          for (const idx of r.lineIndices) {
            if (lines[idx].bbox.left < left) left = lines[idx].bbox.left;
            if (lines[idx].bbox.right > right) right = lines[idx].bbox.right;
          }
          return { left, right };
        });

        // Cluster rows by x-overlap using union-find
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

          // Re-check y-gaps within this cluster using cluster-specific dimensions.
          // During run formation (Stage B), left-column rows can mask gaps between right-column
          // rows (and vice versa). Now that x-clustering has separated columns, re-evaluate
          // gaps using the cluster's column width — paragraph text that fills the column (>60%)
          // will correctly block the bridge, splitting merged tables.
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
            // Expand generously for path correlation — the final bbox.top will be
            // refined in Phase 5.5 (refineTableTop) after hLine data is available.
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
 * Classify vector paths into horizontal lines, vertical lines, and filled rectangles.
 * Applies filtering to remove page borders, margin rules, and underlines.
 */
function classifyPaths(paths, scale, visualHeightPts, pageObj, boxOriginX = 0, boxOriginY = 0) {
  const pageHeight = pageObj.dims.height;
  const pageWidth = pageObj.dims.width;

  // Minimum hLine width derived from the page's body text size (in PDF points).
  // A table cell border must be at least as wide as the typical line height,
  // which approximates one character width. This adapts to the document's
  // font size rather than using a fixed-point threshold.
  const lineHeightsPts = pageObj.lines
    .map((l) => (l.bbox.bottom - l.bbox.top) / scale)
    .filter((h) => h > 2 && h < 100);
  lineHeightsPts.sort((a, b) => a - b);
  const minHLineWidthPts = lineHeightsPts.length > 0
    ? lineHeightsPts[Math.floor(lineHeightsPts.length / 2)]
    : 30;

  // Table grid lines are black or gray (achromatic). Chart bars, decorative
  // designs, and colored elements are chromatic (saturated colors). Filter
  // chromatic paths from contributing hLines/vLines so that colored chart
  // content cannot form phantom grids.
  // Achromatic = all color components roughly equal (gray scale) or near zero
  // (black). For CMYK, achromatic means C≈M≈Y≈0 with any K value.
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

  // Pre-pass: identify stroked rectangles that tile (share edges with neighbors).
  // Table cells drawn with `re S` tile perfectly — adjacent cells share their
  // common border. Org chart boxes, diagram outlines, and other non-table rects
  // are isolated with gaps. Only tiling rects should be decomposed into edges.
  const tilingRectSet = new Set();
  const strokedRectBounds = [];
  for (let pi = 0; pi < paths.length; pi++) {
    const path = paths[pi];
    if (!path.stroke) continue;
    const cmds = path.commands;
    if (cmds.length !== 5 || cmds[0].type !== 'M' || cmds[4].type !== 'Z') continue;
    let rMinX = Infinity; let rMaxX = -Infinity; let rMinY = Infinity; let rMaxY = -Infinity;
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

    let minX = Infinity; let maxX = -Infinity;
    let minY = Infinity; let maxY = -Infinity;
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

    // Decompose stroked paths containing many M-L segments into individual lines.
    // Some PDFs draw table grids as many discrete M-L line segments within a single
    // stroked path, rather than using separate paths or rectangle operators. Each
    // M-L pair is an individual grid line (horizontal or vertical cell edge).
    // Also handles occasional M-L-L polyline segments mixed in.
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

    // Decompose batched filled paths into per-cell FilledRects.
    // Some PDFs draw alternating row backgrounds — or per-cell cell fills — as a single fill
    // path containing many M-L-L-L-Z subpath rectangles.
    if (path.fill && cmds.length >= 10 && isRowBandColor(path.fillColor)) {
      const subRects = [];
      for (let k = 0; k + 4 < cmds.length; k++) {
        if (cmds[k].type !== 'M') continue;
        if (cmds[k + 1].type !== 'L' || cmds[k + 2].type !== 'L'
            || cmds[k + 3].type !== 'L' || cmds[k + 4].type !== 'Z') continue;
        const p0 = cmds[k]; const p1 = cmds[k + 1];
        const p2 = cmds[k + 2]; const p3 = cmds[k + 3];
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

    // Decompose stroked rectangular paths (M-L-L-L-Z) into individual line segments,
    // but only when the rect tiles with its neighbors (shares an edge). Table cells
    // drawn with `re S` tile perfectly — adjacent cells share their common border.
    // Org chart boxes, diagram outlines, and other non-table rects are isolated
    // (no shared edges) and must not be decomposed — their edges create false
    // hLine/vLine matches that cluster into phantom grids.
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
      // Horizontal line candidate
      const displayY = (visualHeightPts - ((minY + maxY) / 2 - boxOriginY)) * scale;

      // Filter: skip page border lines (top/bottom 5% of page with nothing nearby)
      if (displayY < pageHeight * 0.05 || displayY > pageHeight * 0.95) continue;

      hLines.push({ left: displayLeft, right: displayRight, y: displayY });
    } else if (w < 2 && h > 10 && isPathAchromatic(path)) {
      // Vertical line candidate
      const displayX = ((minX + maxX) / 2 - boxOriginX) * scale;
      const vLineHeight = displayBottom - displayTop;

      // Filter: skip page-spanning margin rules (>80% of page height)
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
      // Larger filled region — potential table header background.
      // Too tall for row-band detection but structurally marks a header area.
      headerFills.push({
        left: displayLeft,
        top: displayTop,
        right: displayRight,
        bottom: displayBottom,
        color: path.fillColor || [],
      });
    }
  }

  // Reconstitute dashed/dotted lines rendered as many discrete short segments.
  // Some PDFs draw dashed lines not via the PDF dash-array operator but as separate
  // stroked paths (e.g., 61 segments of h≈10pt with 0.3pt gaps). These segments
  // individually fall below the h>10 / w>30 thresholds above, but collectively
  // represent a single logical line. Detect the pattern and emit reconstituted lines.
  reconstituteDashedLines(paths, hLines, vLines, scale, visualHeightPts, boxOriginX, boxOriginY, pageHeight);

  // Identify ruling-row members: ≥2 hLines at the same y with mutually
  // disjoint x-extents. Together they form a column-spanning rule (header
  // underlines or column underlines), not text underlines. Exempt them from
  // the underline filter below — column-rule lines individually look like
  // word underlines but together encode the table's column geometry.
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

  // Filter underline horizontal lines: if an hLine's x-extent closely matches
  // a single text line directly above it, it's an underline, not a table border.
  const filteredHLines = hLines.filter((hl) => {
    if (rulingRowMembers.has(hl)) return true;
    for (const line of pageObj.lines) {
      const lineBottom = line.bbox.bottom;
      const yDist = Math.abs(hl.y - lineBottom);
      // Within 5pt vertically of the line's bottom (baseline area)
      if (yDist > 5) continue;
      const lineLeft = line.bbox.left;
      const lineRight = line.bbox.right;
      // Check if hLine x-extent matches this single line (within 10pt)
      if (Math.abs(hl.left - lineLeft) < 10 && Math.abs(hl.right - lineRight) < 10) {
        return false; // It's an underline
      }
    }
    return true;
  });

  // Merge collinear hLine segments at the same y-position.
  // Per-cell borders produce separate hLine segments for each cell edge at the
  // same y-coordinate. Merging recovers full-row lines, which is critical for
  // x-extent clustering — without merging, the rightmost column's segments can
  // form a separate cluster, losing the column from the table.
  const mergedHLines = mergeCollinearSegments(filteredHLines, 'y', 'left', 'right', 5, 10);

  // Merge collinear vLine segments at the same x-position.
  // Some PDFs draw per-cell vertical borders as separate segments rather than
  // full-column-height lines. Merging recovers the logical column separators
  // that would otherwise be rejected by downstream overlap filters.
  // Use tight tolerance (5px) for grouping by x-position, and 10px gap
  // tolerance to bridge header/data cell border gaps (typically 6-7px).
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
 * A RowBandRegion describes a set of filled rectangles that together form a
 * table-like row-banding pattern. `rowYs` is the list of distinct row-band
 * y-intervals (each interval is one row). `colXs` is the set of column
 * boundary positions inferred from the dominant disjoint-x pattern observed
 * across the bands.
 */

/**
 * Extract structural row-band regions from filled rectangles.
 *
 * Many tables use alternating row highlighting or per-cell background fills.
 * When the fills decompose into bands at consistent y intervals — and the
 * per-band disjoint-x patterns agree — the fills directly encode both the row
 * boundaries and the column boundaries of the table. This function returns
 * those structural regions.
 *
 * The decomposition happens in two passes:
 *
 * 1. Group fills by (top,bottom) y-interval. A y-group with N+ fills whose
 *    disjoint-x ranges form a repeated pattern is a "row-band row candidate".
 *
 * 2. Collect row candidates into contiguous vertical regions (regular y
 *    intervals, overlapping x extent). A region is accepted as a structural
 *    table if it has 3+ rows whose dominant column positions agree — the
 *    column x-boundaries are computed from the column positions that appear
 *    in a majority of the region's rows.
 *
 * @param {FilledRect[]} filledRects
 * @returns {RowBandRegion[]}
 */
function extractRowBandStructure(filledRects) {
  if (!filledRects || filledRects.length < 3) return [];

  // Step 1: group fills by y-range (tolerance 2 display pt)
  const yGroups = [];
  for (const f of filledRects) {
    const g = yGroups.find((gg) => Math.abs(gg.top - f.top) < 2 && Math.abs(gg.bottom - f.bottom) < 2);
    if (g) g.items.push(f);
    else yGroups.push({ top: f.top, bottom: f.bottom, items: [f] });
  }

  // Step 2: within each y-group, compute disjoint x-ranges and keep the raw
  // per-cell extents.
  // A disjoint range is a maximal set of adjacent/overlapping fills. Cells
  // with a true x-gap between them (fills not touching) produce multiple
  // disjoint ranges, one per column. The merged ranges drive row-bbox geometry;
  // the raw per-cell extents drive column inference (touching cells share
  // boundaries that are real column separators, even though they merge into a
  // single contiguous range).
  /** @type {Array<{top: number, bottom: number, ranges: Array<{left: number, right: number}>, cells: Array<{left: number, right: number}>}>} */
  const rowCandidates = [];
  for (const g of yGroups) {
    g.items.sort((a, b) => a.left - b.left);
    const ranges = [];
    const cells = [];
    for (const f of g.items) {
      cells.push({ left: f.left, right: f.right });
      const last = ranges[ranges.length - 1];
      // Fills exactly touching (last.right === f.left) are merged: adjacent
      // cells typically share a border in the PDF. Use a tiny numeric
      // tolerance (0.5pt) for float precision.
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

  // Filter: keep only candidates that look like table row bands.
  // A useful row band either has 2+ disjoint cells (direct column evidence)
  // OR is a single wide band (contributes row-position evidence only).
  const bands = rowCandidates.filter((c) => {
    if (c.ranges.length === 0) return false;
    const width = c.ranges[c.ranges.length - 1].right - c.ranges[0].left;
    return width > 50; // reject trivially small fills (icons, bullets, etc.)
  });

  if (bands.length < 3) return [];

  // Step 3: Cluster bands into contiguous vertical regions.
  // Two bands belong to the same region if their y-intervals are close
  // (gap less than ~2× the typical band height) and their x-extents overlap.
  bands.sort((a, b) => a.top - b.top);

  /** @type {Array<typeof bands>} */
  const regions = [];
  for (const b of bands) {
    const bLeft = b.ranges[0].left;
    const bRight = b.ranges[b.ranges.length - 1].right;
    let added = false;
    for (const r of regions) {
      const last = r[r.length - 1];
      const lastBottom = last.bottom;
      const lastHeight = last.bottom - last.top;
      const gap = b.top - lastBottom;
      // Bands in the same region are either contiguous (gap < 2× typical
      // band height) or within the previous band (y-overlap).
      const vertClose = gap <= Math.max(lastHeight * 2, 10);
      const lastLeft = last.ranges[0].left;
      const lastRight = last.ranges[last.ranges.length - 1].right;
      const hOverlap = bRight > lastLeft && bLeft < lastRight;
      if (vertClose && hOverlap) {
        r.push(b);
        added = true;
        break;
      }
    }
    if (!added) regions.push([b]);
  }

  // Step 4: For each region, decide if its column pattern is consistent
  // enough to contribute column evidence, and produce a RowBandRegion.
  /** @type {RowBandRegion[]} */
  const results = [];
  for (const region of regions) {
    if (region.length < 3) continue;

    const anchorTol = 3;
    const leftAnchors = [];
    const rightAnchors = [];
    for (const b of region) {
      for (const c of b.cells) {
        leftAnchors.push(c.left);
        rightAnchors.push(c.right);
      }
    }
    // Cluster anchors within tolerance
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

    // Keep column anchors that appear in at least half the bands. This is
    // the "dominant pattern": cells that appear consistently across the
    // region, as opposed to subtotal-row merged cells that only appear in
    // one row.
    const minCount = Math.ceil(region.length / 2);
    const dominantLefts = leftClusters
      .filter((c) => c.values.length >= minCount)
      .map((c) => c.mean)
      .sort((a, b) => a - b);
    const dominantRights = rightClusters
      .filter((c) => c.values.length >= minCount)
      .map((c) => c.mean)
      .sort((a, b) => a - b);

    if (dominantLefts.length < 1) continue;

    // The column boundaries (separators) are the midpoints between adjacent
    // dominant right/left pairs. Pair each right with the next left.
    const colXs = [];
    for (let i = 0; i < dominantLefts.length - 1; i++) {
      const thisRight = dominantRights[i];
      const nextLeft = dominantLefts[i + 1];
      if (thisRight === undefined || nextLeft === undefined) continue;
      colXs.push((thisRight + nextLeft) / 2);
    }

    // Region bbox: from first band top to last band bottom, full x-span of
    // dominant columns.
    const left = dominantLefts[0];
    const right = dominantRights[dominantRights.length - 1];
    const top = region[0].top;
    const bottom = region[region.length - 1].bottom;

    // Row boundaries: one per band.
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
 * Some PDFs render dashed lines as many individual stroked segments (e.g., 61 segments
 * of h≈10pt with 0.3pt gaps) rather than using the PDF dash-array operator. These
 * segments are too short to pass the normal h>10 / w>30 thresholds individually.
 * This function detects the pattern and emits reconstituted full-length lines.
 *
 * Dashed-line signature (all must be true):
 * - 5+ collinear segments at the same position (x within 2pt for vertical, y within 2pt for horizontal)
 * - Median gap between consecutive segments < 2pt
 */
function reconstituteDashedLines(paths, hLines, vLines, scale, visualHeightPts, boxOriginX, boxOriginY, pageHeight) {
  // Collect thin 2-cmd stroked segments in raw PDF coordinates (no size filter)
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

  // Check 1: At least 3 rows with 2+ segments. A single-line row counts as
  // multi-segment-equivalent when it matches the right-clustered-numeric
  // pattern (label + leader/junk + 3+ trailing numeric tokens) — financial
  // statements with leader dots emit each visual row as one OCR line, so the
  // segments are inside the line, not across multiple lines.
  const rowIsMultiSeg = (r) => r.lineIndices.length >= 2
    || (r.lineIndices.length === 1 && isRightClusteredNumeric(lines[r.lineIndices[0]].words));
  const multiSegRows = rows.filter(rowIsMultiSeg);
  if (multiSegRows.length < 3) return false;

  // Check 2: Column alignment consistency
  // Cluster left-edge and right-edge x-positions across all rows.
  // Right-aligned numeric columns have varying left edges but consistent right edges,
  // so both edge types must be checked to avoid rejecting financial/statistical tables.
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

  // Check 3: Segment count consistency.
  // Real tables have rows with similar segment counts. Adjacent cells can
  // coalesce into a single line object when their x-gap is small, so a row
  // that visually has N cells may emit N-1, N, or N+1 segments.
  //
  // Two regimes by sample size: with many rows, allow a ±1 cluster around
  // the mode (the variability is plausibly coalescence noise). With few
  // rows, require the modal count to dominate — variability there is more
  // likely heterogeneous content (a form, not a table) than noise.
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

  // Check 4: Content width — reject candidates dominated by tiny text fragments.
  // Mathematical equations render subscripts, superscripts, and operators as
  // separate lines that are individually very narrow (<70px ≈ 2 chars at normal
  // text size). Real table cells contain words or numbers that are wider.
  // Typical real tables: <60% tiny. Equation false positives: >85% tiny.
  // Note: this threshold is intentionally absolute (not text-relative). Equation
  // fragments are small in an absolute sense regardless of surrounding text size;
  // a text-relative threshold would become too lenient on small-text pages.
  let tinyCount = 0;
  let totalLines = 0;
  for (const row of rows) {
    for (const idx of row.lineIndices) {
      totalLines++;
      if (lines[idx].bbox.right - lines[idx].bbox.left < 70) tinyCount++;
    }
  }
  if (totalLines > 0 && tinyCount / totalLines > 0.7) return false;

  // Check 5: Prose-cell content — reject candidates whose "row cells" contain
  // sentence-like prose rather than atomic table cells. Feature diagrams and
  // infographics frequently sit at aligned y-positions with step-number
  // badges and surrounding paragraphs of description, getting grouped into
  // a candidate despite lacking column structure.
  //
  // A cell qualifies as prose when it has 3+ alphabetic words AND zero
  // numeric tokens. The zero-numeric requirement matters: employee
  // directories, financial schedules, and similar multi-column listings
  // often merge a multi-word label with its numeric values into one line
  // object. Those cells carry 3+ alphabetic words but also carry numeric
  // data — they're data cells, not prose. Pure-prose cells (contact info,
  // paragraph text, section headers) carry only text.
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
    for (const idx of row.lineIndices) {
      if (cellIsProse(idx)) proseCells++;
    }
    if (proseCells >= 2) proseRowCount++;
  }
  if (proseRowCount > rows.length * 0.4) return false;

  // Check 6: Narrative-layout content — reject candidates whose multi-segment
  // rows are dominated by cells that are all multi-word textual fragments of
  // similar width.
  //
  // Real data tables anchor each row with at least one ATOMIC cell — a short
  // label or numeric/unit value that's narrow relative to surrounding text.
  // Narrative layouts (side-by-side address blocks, stacked contact-info
  // pairs) have NO atomic cell: every cell is a full multi-word textual
  // fragment of comparable width to its neighbours.
  //
  // A cell is "narrative" if it has 2+ words including at least one
  // alphabetic word. A row is rejected if every cell is narrative AND no
  // cell has a width less than half the widest cell in the row — the
  // half-width floor lets a narrow value cell break the pattern even when
  // its neighbour is a long name or sentence cell.
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
 * Detect tables from stroked paths that collectively form a complete rectangular
 * grid. The grid may be in a single path (Excel/Word pattern) or split across
 * multiple paths (horizontal rules in one `S`, vertical rules in separate `S`
 * commands). The structural signal is: a set of horizontal M-L segments all
 * sharing the same x-extent, and a set of vertical M-L segments all sharing
 * the same y-extent, where the extents are compatible (they form a rectangle).
 * Because the grid is identified from explicit vector geometry, it is unambiguous
 * and bypasses hLine clustering (which can merge it with chart lines).
 *
 * @returns {DetectedTable[]}
 */
function detectSelfContainedGridPaths(paths, scale, visualHeightPts, boxOriginX, boxOriginY, pageObj) {
  const allHSegs = [];
  const allVSegs = [];
  const addSeg = (p1x, p1y, p2x, p2y) => {
    const segW = Math.abs(p2x - p1x);
    const segH = Math.abs(p2y - p1y);
    if (segH < 2 && segW > 10) {
      allHSegs.push({ left: Math.min(p1x, p2x), right: Math.max(p1x, p2x), y: (p1y + p2y) / 2 });
    } else if (segW < 2 && segH > 10) {
      allVSegs.push({ x: (p1x + p2x) / 2, top: Math.min(p1y, p2y), bottom: Math.max(p1y, p2y) });
    }
  };
  for (const path of paths) {
    if (!path.stroke) continue;
    const cmds = path.commands;
    // Extract edges from stroked rectangles (M-L-L-L-Z from `re S`).
    if (cmds.length === 5 && cmds[0].type === 'M' && cmds[4].type === 'Z'
        && cmds[1].type === 'L' && cmds[2].type === 'L' && cmds[3].type === 'L') {
      const pts = [cmds[0], cmds[1], cmds[2], cmds[3]];
      for (let k = 0; k < 4; k++) {
        addSeg(pts[k].x, pts[k].y, pts[(k + 1) % 4].x, pts[(k + 1) % 4].y);
      }
      continue;
    }
    for (let k = 0; k < cmds.length - 1; k++) {
      if (cmds[k].type !== 'M' || cmds[k + 1].type !== 'L') continue;
      addSeg(cmds[k].x, cmds[k].y, cmds[k + 1].x, cmds[k + 1].y);
    }
  }

  const hGroups = [];
  for (const seg of allHSegs) {
    let added = false;
    for (const g of hGroups) {
      if (Math.abs(seg.left - g.left) < 5 && Math.abs(seg.right - g.right) < 5) {
        g.segs.push(seg);
        added = true;
        break;
      }
    }
    if (!added) hGroups.push({ left: seg.left, right: seg.right, segs: [seg] });
  }

  const results = [];
  for (const hGroup of hGroups) {
    if (hGroup.segs.length < 3) continue;

    const hLeft = hGroup.left;
    const hRight = hGroup.right;
    const hYMin = Math.min(...hGroup.segs.map((s) => s.y));
    const hYMax = Math.max(...hGroup.segs.map((s) => s.y));
    const matchingVSegs = allVSegs.filter((s) => s.x >= hLeft - 5 && s.x <= hRight + 5
      && s.top <= hYMax + 5 && s.bottom >= hYMin - 5);
    if (matchingVSegs.length < 3) continue;

    const vTop = matchingVSegs[0].top;
    const vBot = matchingVSegs[0].bottom;
    if (!matchingVSegs.every((s) => Math.abs(s.top - vTop) < 5 && Math.abs(s.bottom - vBot) < 5)) {
      // Multiple y-extents: check for stacked tables (same column structure
      // repeated vertically). Group vSegs by y-extent, require all groups to
      // have the same vSeg count at matching x-positions.
      const vGroups = [];
      for (const vs of matchingVSegs) {
        let added = false;
        for (const vg of vGroups) {
          if (Math.abs(vs.top - vg.top) < 5 && Math.abs(vs.bottom - vg.bottom) < 5) {
            vg.segs.push(vs); added = true; break;
          }
        }
        if (!added) vGroups.push({ top: vs.top, bottom: vs.bottom, segs: [vs] });
      }
      // Require each group to have 3+ vSegs AND at least 5 hSegs within its
      // y-range. Stacked tables with every cell outlined have many row
      // separators per table. Chart frames with axis marks have only 2-3.
      const validGroups = vGroups.filter((g) => {
        if (g.segs.length < 3) return false;
        const subH = hGroup.segs.filter((s) => s.y >= g.top - 5 && s.y <= g.bottom + 5);
        return [...new Set(subH.map((s) => s.y))].length >= 5;
      });
      if (validGroups.length >= 2) {
        const refXs = validGroups[0].segs.map((s) => s.x).sort((a, b) => a - b);
        const allMatch = validGroups.every((g) => {
          if (g.segs.length !== refXs.length) return false;
          const gXs = g.segs.map((s) => s.x).sort((a, b) => a - b);
          return gXs.every((x, i) => Math.abs(x - refXs[i]) < 10);
        });
        if (allMatch) {
          for (const vg of validGroups) {
            const vgLeft = Math.min(...vg.segs.map((s) => s.x));
            const vgRight = Math.max(...vg.segs.map((s) => s.x));
            const dL = (vgLeft - boxOriginX) * scale;
            const dR = (vgRight - boxOriginX) * scale;
            const dT = (visualHeightPts - (vg.bottom - boxOriginY)) * scale;
            const dB = (visualHeightPts - (vg.top - boxOriginY)) * scale;
            if ((dR - dL) < pageObj.dims.width * 0.2) continue;
            const subH = hGroup.segs.filter((s) => s.y >= vg.top - 5 && s.y <= vg.bottom + 5);
            const subYs = [...new Set(subH.map((s) => s.y))].sort((a, b) => a - b);
            if (subYs.length < 3) continue;
            const rh = []; for (let ri = 1; ri < subYs.length; ri++) rh.push(Math.abs(subYs[ri] - subYs[ri - 1]));
            if (Math.min(...rh) > 0 && Math.max(...rh) / Math.min(...rh) > 4) continue;
            const vXs = clusterValues(vg.segs.map((s) => (s.x - boxOriginX) * scale), 10);
            const cs = vXs.filter((x) => x > dL + 5 && x < dR - 5).sort((a, b) => a - b);
            if (cs.length < 1) continue;
            const hl = subH.map((s) => ({ left: (s.left - boxOriginX) * scale, right: (s.right - boxOriginX) * scale, y: (visualHeightPts - (s.y - boxOriginY)) * scale }));
            const vl = vg.segs.map((s) => ({ x: (s.x - boxOriginX) * scale, top: (visualHeightPts - (s.bottom - boxOriginY)) * scale, bottom: (visualHeightPts - (s.top - boxOriginY)) * scale }));
            const bbox = {
              left: dL, top: dT - 5, right: dR, bottom: dB + 5,
            };
            const rli = [];
            for (let i = 0; i < pageObj.lines.length; i++) {
              const ln = pageObj.lines[i];
              if (ln.bbox.top >= bbox.top - 5 && ln.bbox.bottom <= bbox.bottom + 5
                && ln.bbox.left >= bbox.left - 10 && ln.bbox.right <= bbox.right + 10) {
                rli.push(i);
              }
            }
            if (rli.length < 2) continue;
            const rg = groupLinesIntoRows(rli.map((i) => pageObj.lines[i]));
            const mr = rg.map((r) => ({ lineIndices: r.lineIndices.map((i) => rli[i]), y: r.y }));
            if (mr.length < 2) continue;
            results.push({
              bbox, rows: mr, colSeparators: cs, hLines: hl, vLines: vl, detectionMethod: 'grid',
            });
          }
        }
      }
      continue;
    }

    const dispLeft = (hLeft - boxOriginX) * scale;
    const dispRight = (hRight - boxOriginX) * scale;
    const dispTop = (visualHeightPts - (vBot - boxOriginY)) * scale;
    const dispBottom = (visualHeightPts - (vTop - boxOriginY)) * scale;

    if ((dispRight - dispLeft) < pageObj.dims.width * 0.2) continue;

    const vXs = clusterValues(matchingVSegs.map((s) => (s.x - boxOriginX) * scale), 10);
    const colSeps = vXs.filter((x) => x > dispLeft + 5 && x < dispRight - 5);
    colSeps.sort((a, b) => a - b);
    if (colSeps.length < 1) continue;

    // Guard against chart frames and diagrams where horizontal lines and
    // vertical segments form a pseudo-grid. The original check rejects 3+
    // hLines with non-uniform row heights, but that also rejects legitimate
    // header-divider-only tables (rectangle + column separators + one rule
    // under the header). Skip the uniformity check only when the column
    // separators span (close to) the full hGroup vertical extent — i.e., when
    // the verticals are real cell-spanning column lines, not cosmetic edges
    // of inner boxes that float between bracketing horizontal lines.
    const hSpan = Math.max(...hGroup.segs.map((s) => s.y)) - Math.min(...hGroup.segs.map((s) => s.y));
    const vSpan = vBot - vTop;
    const vSegsSpanFullHeight = hSpan > 0 && vSpan / hSpan >= 0.85;
    if (!(colSeps.length >= 2 && vSegsSpanFullHeight)) {
      const hYs = [...new Set(hGroup.segs.map((s) => s.y))].sort((a, b) => a - b);
      if (hYs.length >= 3) {
        const rowHeights = [];
        for (let ri = 1; ri < hYs.length; ri++) rowHeights.push(Math.abs(hYs[ri] - hYs[ri - 1]));
        if (Math.min(...rowHeights) > 0 && Math.max(...rowHeights) / Math.min(...rowHeights) > 4) continue;
      }
    }

    const hLines = hGroup.segs.map((s) => ({
      left: (s.left - boxOriginX) * scale,
      right: (s.right - boxOriginX) * scale,
      y: (visualHeightPts - (s.y - boxOriginY)) * scale,
    }));
    const vLines = matchingVSegs.map((s) => ({
      x: (s.x - boxOriginX) * scale,
      top: (visualHeightPts - (s.bottom - boxOriginY)) * scale,
      bottom: (visualHeightPts - (s.top - boxOriginY)) * scale,
    }));

    let headerTop = dispTop;
    if (hLines.length >= 4) {
      const typicalRowH = (dispBottom - dispTop) / (hLines.length - 1);
      const headerLimit = dispTop - typicalRowH * 2;
      const tableWidth = dispRight - dispLeft;
      for (const line of pageObj.lines) {
        if (line.bbox.bottom > dispTop || line.bbox.top < headerLimit) continue;
        if (line.bbox.right < dispLeft + 10 || line.bbox.left > dispRight - 10) continue;
        if ((line.bbox.right - line.bbox.left) < tableWidth * 0.3) continue;
        if (line.bbox.top < headerTop) headerTop = line.bbox.top;
      }
    }

    const bbox = {
      left: dispLeft, top: headerTop - 5, right: dispRight, bottom: dispBottom + 5,
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

    results.push({
      bbox, rows: mappedRows, colSeparators: colSeps, hLines, vLines, detectionMethod: 'grid',
    });
  }

  return results;
}

/**
 * Detect tables using grid structure from paths (fallback for text-only tables).
 * If 2+ hLines and 2+ non-page-spanning vLines form a grid, it's a table.
 */
function detectGridTables(pageObj, paths, scale, visualHeightPts, boxOriginX = 0, boxOriginY = 0) {
  const pathData = classifyPaths(paths, scale, visualHeightPts, pageObj, boxOriginX, boxOriginY);

  const selfContainedGrids = detectSelfContainedGridPaths(paths, scale, visualHeightPts, boxOriginX, boxOriginY, pageObj);

  if (pathData.hLines.length < 3) return selfContainedGrids;

  // Cluster hLines by x-extent overlap
  const hLineClusters = clusterHLinesByXExtent(pathData.hLines);

  const tables = [];
  // Process each hLine cluster. Split clusters with large y-gaps into sub-clusters
  // so that decorative outlier hLines (e.g., page title underlines) don't poison
  // the grid detection for the actual table.
  /** @type {HLine[][]} */
  const processedClusters = [];
  for (const cluster of hLineClusters) {
    if (cluster.length < 3) continue;
    const subClusters = splitClusterByYGap(cluster);
    for (const sub of subClusters) {
      if (sub.length >= 3) processedClusters.push(sub);
    }
  }

  for (const cluster of processedClusters) {
    // Find the bounding x-extent
    let clusterLeft = cluster.reduce((m, h) => Math.min(m, h.left), Infinity);
    let clusterRight = cluster.reduce((m, h) => Math.max(m, h.right), -Infinity);
    let clusterTop = cluster.reduce((m, h) => Math.min(m, h.y), Infinity);
    let clusterBottom = cluster.reduce((m, h) => Math.max(m, h.y), -Infinity);

    // Find vLines that fall within this region
    let regionVLines = pathData.vLines.filter((vl) => vl.x >= clusterLeft - 5
      && vl.x <= clusterRight + 5
      && vl.top <= clusterBottom + 5
      && vl.bottom >= clusterTop - 5);

    // Exclude vLines that don't participate in the grid.
    // Two structural checks:
    // 1. A real column separator crosses 2+ row lines in the cluster.
    //    A page-layout divider or decorative rule intersects 0–1.
    // 2. A real column separator has a y-span proportional to the hLine
    //    cluster's span. A page-layout column divider that passes through
    //    the table area has a y-span far exceeding the cluster — it was
    //    drawn for the page layout, not for the table.
    const hClusterSpan = clusterBottom - clusterTop;
    if (regionVLines.length > 0) {
      regionVLines = regionVLines.filter((vl) => {
        const vSpan = vl.bottom - vl.top;
        if (hClusterSpan > 0 && vSpan > hClusterSpan * 3) return false;
        let count = 0;
        for (const hl of cluster) {
          if (hl.y >= vl.top - 5 && hl.y <= vl.bottom + 5
              && hl.left <= vl.x + 5 && hl.right >= vl.x - 5) {
            count++;
            if (count >= 2) return true;
          }
        }
        return false;
      });
    }

    // Trim cluster x-extent to only hLines that touch a vLine position.
    // On pages with charts adjacent to tables, chart gridlines get clustered
    // with table hLines (via full-width bridging lines). The vLines define
    // the actual table structure — hLines not touching any vLine are likely
    // chart gridlines or decorative elements.
    if (regionVLines.length >= 2) {
      const vLineXPositions = regionVLines.map((vl) => vl.x);
      const touchesVLine = (hl) => vLineXPositions.some((vx) => Math.abs(hl.left - vx) < 15 || Math.abs(hl.right - vx) < 15);
      const touchingHLines = cluster.filter(touchesVLine);
      // Only trim if it actually reduces the extent (some hLines are untouched).
      // Don't trim if all or nearly all hLines touch vLines — this means the
      // entire cluster is a valid grid and trimming would only lose precision.
      const untouchedCount = cluster.length - touchingHLines.length;
      if (touchingHLines.length >= 3 && untouchedCount > cluster.length * 0.1) {
        clusterLeft = touchingHLines.reduce((m, h) => Math.min(m, h.left), Infinity);
        clusterRight = touchingHLines.reduce((m, h) => Math.max(m, h.right), -Infinity);
      }
    }

    // Require 3+ vLines (left + right + at least one interior column separator).
    // If fewer than 3 vLines, fall back to segmented-hLine detection:
    // consistent break points in the horizontal line segments can encode
    // implicit column separators without explicit vertical lines.
    if (regionVLines.length < 3) {
      const segTables = detectSegmentedHLineTables(
        cluster, pathData.headerFills, pageObj,
      );
      for (const st of segTables) tables.push(st);
      continue;
    }

    // Use vLine y-extent as the grid boundary. When interior column separators
    // are shorter than border vLines (e.g., border extends into a footnote area
    // with no interior columns), trim to the interior extent instead. This
    // prevents decorative areas from inflating the coverage denominator.
    const allVLineXPositions = clusterValues(regionVLines.map((vl) => vl.x), 10);
    const interiorVLineXs = allVLineXPositions.filter((x) => x > clusterLeft + 5 && x < clusterRight - 5);

    // Compute interior vLine extent (where actual columns exist)
    let intTop = Infinity;
    let intBot = -Infinity;
    for (const sep of interiorVLineXs) {
      for (const vl of regionVLines) {
        if (Math.abs(vl.x - sep) < 15) {
          if (vl.top < intTop) intTop = vl.top;
          if (vl.bottom > intBot) intBot = vl.bottom;
        }
      }
    }

    // Also compute full vLine extent (including borders)
    const allTop = regionVLines.reduce((m, vl) => Math.min(m, vl.top), Infinity);
    const allBot = regionVLines.reduce((m, vl) => Math.max(m, vl.bottom), -Infinity);

    // Use interior extent when available, fall back to full vLine extent
    const hLineExtent = clusterBottom - clusterTop;
    if (Number.isFinite(intTop) && (intBot - intTop) > hLineExtent * 0.3) {
      clusterTop = intTop;
      clusterBottom = intBot;
    } else if ((allBot - allTop) > hLineExtent * 0.3) {
      clusterTop = allTop;
      clusterBottom = allBot;
    }

    // Validate grid structure: at least one interior column separator position
    // must have vLines that collectively span >=70% of the grid height.
    const gridHeight = clusterBottom - clusterTop;
    if (gridHeight > 50) {
      let maxInteriorSpan = 0;
      for (const sep of interiorVLineXs) {
        const colVLines = regionVLines.filter((vl) => Math.abs(vl.x - sep) < 15);
        let span = 0;
        for (const vl of colVLines) span += vl.bottom - vl.top;
        if (span > maxInteriorSpan) maxInteriorSpan = span;
      }
      if (maxInteriorSpan < gridHeight * 0.7) continue;
    }

    // Reject small grids that are likely diagrams, not tables.
    // A real table grid spans a meaningful portion of the page.
    const gridWidth = clusterRight - clusterLeft;
    if (gridWidth < pageObj.dims.width * 0.3) continue;

    // Reject grids that extend significantly beyond page bounds (decorative artifacts).
    if (clusterLeft < -pageObj.dims.width * 0.1 || clusterRight > pageObj.dims.width * 1.1
        || clusterTop < -pageObj.dims.height * 0.1 || clusterBottom > pageObj.dims.height * 1.1) continue;

    // We have a grid! Build the table.
    // Expand top boundary to include header text lines above the grid.
    // Compute row height from the MEDIAN hLine spacing — this is the actual
    // structural row pitch. Anchor the expansion from the topmost hLine that
    // is within a reasonable distance of the main cluster body. An hLine
    // separated by a gap much larger than the median spacing (e.g., a section
    // separator above the table) should not pull the header expansion upward.
    let headerTop = clusterTop;
    const sortedHLineYs = [...new Set(cluster.map((h) => h.y))].sort((a, b) => a - b);
    let typicalRowH;
    if (sortedHLineYs.length > 1) {
      const spacings = [];
      for (let i = 1; i < sortedHLineYs.length; i++) spacings.push(sortedHLineYs[i] - sortedHLineYs[i - 1]);
      spacings.sort((a, b) => a - b);
      typicalRowH = spacings[Math.floor(spacings.length / 2)];
    } else {
      typicalRowH = (clusterBottom - clusterTop) / Math.max(1, cluster.length - 1);
    }
    // Find the anchor: walk down from the top of sortedHLineYs, skipping
    // hLines that are outliers (gap to the next > 3× median).
    let headerAnchorY = sortedHLineYs[0];
    for (let hi = 0; hi < sortedHLineYs.length - 1; hi++) {
      if (sortedHLineYs[hi + 1] - sortedHLineYs[hi] > typicalRowH * 3) {
        headerAnchorY = sortedHLineYs[hi + 1];
      } else {
        break;
      }
    }
    const headerLimit = headerAnchorY - typicalRowH * 2;
    const tableWidth = clusterRight - clusterLeft;
    for (const line of pageObj.lines) {
      if (line.bbox.bottom > clusterTop || line.bbox.top < headerLimit) continue;
      if (line.bbox.right < clusterLeft + 10 || line.bbox.left > clusterRight - 10) continue;
      // Header lines must span a meaningful fraction of the table width.
      // Page headers like "ICC.1:2022" are narrow and shouldn't be included.
      const lineWidth = line.bbox.right - line.bbox.left;
      if (lineWidth < tableWidth * 0.3) continue;
      if (line.bbox.top < headerTop) headerTop = line.bbox.top;
    }
    const bbox = {
      left: clusterLeft,
      top: headerTop - 5,
      right: clusterRight,
      bottom: clusterBottom + 5,
    };

    // Find lines within this region
    const regionLineIndices = [];
    for (let i = 0; i < pageObj.lines.length; i++) {
      const line = pageObj.lines[i];
      if (line.bbox.top >= bbox.top - 5 && line.bbox.bottom <= bbox.bottom + 5
        && line.bbox.left >= bbox.left - 10 && line.bbox.right <= bbox.right + 10) {
        regionLineIndices.push(i);
      }
    }

    if (regionLineIndices.length < 2) continue;

    // Group these lines into rows
    const regionLines = regionLineIndices.map((i) => pageObj.lines[i]);
    const rowGroups = groupLinesIntoRows(regionLines);

    // Map back to original indices
    const mappedRows = rowGroups.map((rg) => ({
      lineIndices: rg.lineIndices.map((i) => regionLineIndices[i]),
      y: rg.y,
    }));

    if (mappedRows.length < 2) continue;

    // Validate: text must demonstrate column structure within the grid.
    // A grid table organizes text into rows and columns. If the text within
    // the grid region never appears at the same y-position in multiple columns,
    // the grid isn't organizing text — it's likely a diagram, chart, or
    // decorative element whose vector paths happen to form a grid pattern.
    // Require at least 2 rows with 2+ text segments as evidence of column use.
    const multiSegGridRows = mappedRows.filter((r) => r.lineIndices.length >= 2).length;
    if (multiSegGridRows < 2) continue;

    // Extract column separators from vLines
    const vLineXPositions = clusterValues(regionVLines.map((vl) => vl.x), 10);
    // Filter out border lines (leftmost and rightmost)
    const colSeps = vLineXPositions.filter((x) => x > clusterLeft + 5 && x < clusterRight - 5);
    colSeps.sort((a, b) => a - b);

    // Drop empty columns. A border vLine that survives the tolerance filter
    // creates an ultra-narrow "column" between itself and the cluster edge;
    // that column contains no words. This is a direct structural test for
    // border-vs-separator: a real column contains at least one word inside
    // its bounds (center-of-word inside [left, right]). If the first or last
    // column of the computed grid is empty, the outer vLine is a border
    // artifact, not a separator — drop it.
    //
    // Only the outermost columns are checked because an empty interior
    // column can legitimately occur (a data cell blank in every row) and
    // shouldn't be stripped. Borders only ever shave off the extremes.
    const allBoundaries = [clusterLeft, ...colSeps, clusterRight];
    const wordCenterInRange = (w, l, r) => {
      const cx = (w.bbox.left + w.bbox.right) / 2;
      return cx > l && cx < r;
    };
    const columnHasWord = (l, r) => {
      for (const i of regionLineIndices) {
        for (const word of pageObj.lines[i].words) {
          if (wordCenterInRange(word, l, r)) return true;
        }
      }
      return false;
    };
    // Trim from left
    while (colSeps.length >= 1) {
      const leftColLeft = allBoundaries[0];
      const leftColRight = allBoundaries[1];
      if (columnHasWord(leftColLeft, leftColRight)) break;
      colSeps.shift();
      allBoundaries.splice(1, 1); // drop the first separator from boundaries
    }
    // Trim from right
    while (colSeps.length >= 1) {
      const rightColLeft = allBoundaries[allBoundaries.length - 2];
      const rightColRight = allBoundaries[allBoundaries.length - 1];
      if (columnHasWord(rightColLeft, rightColRight)) break;
      colSeps.pop();
      allBoundaries.splice(allBoundaries.length - 2, 1);
    }

    tables.push({
      bbox,
      rows: mappedRows,
      colSeparators: colSeps,
      hLines: cluster,
      vLines: regionVLines,
      detectionMethod: 'grid',
    });
  }

  // Merge horizontally adjacent grid tables that share vertical alignment.
  // Some PDFs draw table grid lines in separate column groups (e.g., one set of
  // hLines for the label column, another for data columns). These produce
  // separate sub-tables that should be merged into one.
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < tables.length && !merged; i++) {
      for (let j = i + 1; j < tables.length && !merged; j++) {
        const a = tables[i];
        const b = tables[j];
        // Check vertical overlap (>50% of the smaller table's height)
        const overlapTop = Math.max(a.bbox.top, b.bbox.top);
        const overlapBot = Math.min(a.bbox.bottom, b.bbox.bottom);
        const vOverlap = Math.max(0, overlapBot - overlapTop);
        const minHeight = Math.min(a.bbox.bottom - a.bbox.top, b.bbox.bottom - b.bbox.top);
        if (minHeight <= 0 || vOverlap / minHeight < 0.5) continue;
        // Check horizontal adjacency (gap < 30px between them)
        const hGap = Math.max(a.bbox.left, b.bbox.left) - Math.min(a.bbox.right, b.bbox.right);
        if (hGap > 30) continue;
        // Merge b into a
        const mergedBbox = {
          left: Math.min(a.bbox.left, b.bbox.left),
          top: Math.min(a.bbox.top, b.bbox.top),
          right: Math.max(a.bbox.right, b.bbox.right),
          bottom: Math.max(a.bbox.bottom, b.bbox.bottom),
        };
        // Combine rows (deduplicate by lineIndices)
        const seenLines = new Set(a.rows.flatMap((r) => r.lineIndices));
        const combinedRows = [...a.rows];
        for (const row of b.rows) {
          if (!row.lineIndices.some((li) => seenLines.has(li))) {
            combinedRows.push(row);
          }
        }
        combinedRows.sort((x, y) => x.y - y.y);
        // Re-cluster vLines from both sub-tables
        const allVLines = [...a.vLines, ...b.vLines];
        const vLineXPositions = clusterValues(allVLines.map((vl) => vl.x), 10);
        const colSeps = vLineXPositions.filter((x) => x > mergedBbox.left + 5 && x < mergedBbox.right - 5);
        tables[i] = {
          bbox: mergedBbox,
          rows: combinedRows,
          colSeparators: colSeps.sort((x, y) => x - y),
          hLines: [...a.hLines, ...b.hLines],
          vLines: allVLines,
          detectionMethod: 'grid',
        };
        tables.splice(j, 1);
        merged = true;
      }
    }
  }

  // Self-contained grids (complete grid in explicit vector paths) are higher
  // confidence than hLine-cluster-based grids. When they overlap, the
  // self-contained grid replaces the cluster-based result.
  for (const scg of selfContainedGrids) {
    for (let i = tables.length - 1; i >= 0; i--) {
      if (bboxOverlap(tables[i].bbox, scg.bbox) > 0.3) tables.splice(i, 1);
    }
    tables.push(scg);
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
 * Detect the header band for a candidate table and extract column anchors
 * from whichever header row carries the strongest column-position signal.
 * Headers often sit in a structured pattern (repeated labels, numeral
 * indices, stacked year labels) whose x-positions provide stronger column
 * evidence than sparse data rows. Both `extractStructure` and
 * `refineTableTop` consume the result.
 *
 * Returns `bandTop` (topmost y of header-candidate rows above the data) and
 * `columnAnchors` (x-centers of cells in the primary header row). Confidence
 * is 'strong' when the primary row carries enough cells for unambiguous
 * column evidence; downstream consumers should only OVERRIDE existing column
 * signals on 'strong'.
 *
 * @param {object} table - A validated candidate with .bbox and .rows
 * @param {Array} lines - pageObj.lines
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

  // Group by y (5pt tolerance).
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
    // Looser gap tolerance than data-row clustering. Header text ("Not
    // Quoted") is often set with wider inter-word spacing than a data-row
    // phrase, and the larger tolerance keeps a two-word header cell from
    // splitting into two spurious anchors.
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

  // Annotate each y-group with its cells and whether it's an all-text row.
  yGroups.sort((a, b) => b.y - a.y); // descending — walk from near-data upward
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

  // Pick the primary column-header row: the all-text y-group with the most
  // cells. This is the row whose cell x-positions will become column anchors.
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

  // Compute bandTop as the topmost y of ADJACENT header-like rows above the
  // first data row. The walk descends from near firstRowY and accepts rows
  // that look like column headers or compact section titles; it rejects
  // narrative sentence rows like "The provision for income taxes consisted
  // of the following:" that happen to sit above the table.
  //
  // A row is header-like when it is all-text AND one of:
  //   - 2+ cells (a real multi-column header like "2000 1999 1998"), OR
  //   - 1 cell carrying ≤4 alphabetic words (a compact section title or
  //     unit marker like "(Rs. in Crores)", "Long Term", "FIXED ASSETS").
  // A row with a single cell carrying 5+ alphabetic words is paragraph text
  // and breaks the chain.
  //
  // Adjacent = each successive accepted row within 2×avgRowHeight of the
  // previous one. A page title floating far above (e.g., a letter-spaced
  // "F i n a n c i a l" title 300pt up) doesn't become bbox.top.
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

  // Rule 2: Stacked 2-cell header. When no single row has 3+ cells, check
  // whether 2+ rows each with exactly 2 cells share the same x-positions
  // (within tolerance). Stacked year/unit headers are common in annual
  // reports: "As at" + "31st March, 2006 31st March, 2005" + "(Rs. in
  // Crores) (Rs. in Crores)" — each row has 2 cells placed over the same
  // two numeric columns. The cross-row alignment is a strong structural
  // signal that individual rows (at 2 cells each) don't carry alone.
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

  // Filter cells by data-row alignment. A cell is kept only if at least one
  // data row has a word whose x-center lies WITHIN that cell's x-range. This
  // rejects spurious cells from over-split headers — a stray currency symbol
  // sitting between data columns, or a letter-spaced page title where each
  // single-character cell lands on blank space between data columns.
  // Checking cell RANGE (not just anchor-center proximity) handles cases
  // where header text is offset from its data column's x-center (e.g. a
  // centered header over a right-aligned numeric column).
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

  // Strong confidence gating differs by rule:
  //   - Rule 1 (single dense row): 4+ aligned cells — a single 3-cell row
  //     might be a coincidental phrase trio, 4+ is structurally unambiguous.
  //   - Rule 2 (stacked cross-row): 2+ aligned cells — the cross-row
  //     alignment IS the structural evidence (each 2-cell row alone would be
  //     ambiguous, but 2+ rows at matching x-positions is not).
  // Both require at least half the primary row's cells surviving alignment.
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
 * Extract column and row structure for a validated table.
 */
function extractStructure(table, lines) {
  // If we already have colSeparators (from grid detection), keep them
  if (table.colSeparators.length > 0) return;

  // Try vLine-based column detection
  if (table.vLines.length >= 2) {
    const vLineXPositions = clusterValues(table.vLines.map((vl) => vl.x), 10);
    const interior = vLineXPositions.filter((x) => x > table.bbox.left + 5 && x < table.bbox.right - 5);
    if (interior.length > 0) {
      table.colSeparators = interior.sort((a, b) => a - b);
      return;
    }
  }

  // Header-anchor-based column detection. When a strong header row is present,
  // compute the column separators it WOULD produce and defer the decision:
  // we'll compare against the word-clustering result below and prefer the
  // header-based seps ONLY if they produce a larger column count than the
  // data-word clustering does. This handles SPARSE tables (e.g. a
  // Quoted/Not-Quoted investment schedule where most rows populate only 1-2
  // of the 4 numeric sub-columns) where data-word clustering under-counts,
  // while leaving well-populated tables' column structure alone.
  //
  // Separators are midpoints between consecutive anchors. If data rows have
  // content clearly left of the first anchor, an additional label column is
  // synthesized with a separator placed at first-anchor minus half an
  // anchor-to-anchor spacing.
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

  // Word-level column detection with two row-level preprocessors:
  //
  // 1. Phrase merge — within a row, consecutive non-currency words whose inter-word
  //    gap is small (relative to line height) are merged into a single bbox. This
  //    prevents a narrow label like "Income taxes (net of refunds)" from producing
  //    five spurious columns while still keeping tight number columns (e.g.
  //    "$58,736   $48,221   $38,046") separated at their large inter-column gaps.
  //
  // 2. Chain-currency merge — a currency symbol (or run of coincident duplicate
  //    currency glyphs) is always merged with the following non-currency word in
  //    the same row. Handles "$ $ 1,223" (duplicated $ glyphs at the same x) and
  //    broken rows where the $ is emitted as a separate line object upstream of
  //    its number.
  //
  // Rows are processed at row level (not line level) because broken rows can
  // split a single logical cell across several line objects.
  const isCurrencySymbol = (text) => /^[$€£¥¢]+$/.test(text);
  const allWordBboxes = [];
  // Reject paragraph-like rows that sneak into the candidate (e.g., a footnote
  // row appended just below the data). A row is considered paragraph-like when
  // one of its lines is both (a) wider than half the candidate bbox and
  // (b) long-form prose — 6+ words with fewer than 2 numeric tokens. A data
  // row containing "$21,458 $19,918 $11,860 $10,509" is wide but almost
  // entirely numeric, so it stays in.
  const candidateWidth = table.bbox.right - table.bbox.left;
  const isNarrativeLine = (line) => {
    // Skip leader-filler dots
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
  // Identify header rows so they can be excluded from column inference.
  //
  // Header rows contain cell-spanning text ("Change", "2017 vs. 2016") whose
  // word bboxes sit between the data column boundaries; calcColumnBounds
  // greedily merges those header bboxes with adjacent data cells, collapsing
  // multiple data columns into one. The structural distinction: header rows
  // contain only year-like 4-digit numbers (1900-2099) plus optional text,
  // while real data rows contain monetary or count values that are typically
  // outside that range, or contain currency symbols. The first row matching
  // the data-row signature marks the start of the data area; everything above
  // it is treated as header.
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
    // Process phrases in spatial order, not PDF stream order. Streamed rows can
    // interleave words from different spatial columns (e.g., a line containing
    // "Country" emitted before a line containing "Amount (mil.)"), which would
    // otherwise cause the phrase merger to span across columns via the backward x-jump between them.
    rowWords.sort((a, b) => a.bbox.left - b.bbox.left);
    const avgLineHeight = hCount > 0 ? hSum / hCount : 20;
    // Gap threshold must be small enough that multi-column headers with narrow
    // gaps (e.g., 15px apart in different columns) are NOT merged, but large
    // enough that intra-label word spacing (~9px) IS merged.
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
        // Chain through consecutive currency glyphs, then absorb the first
        // non-currency word that follows.
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
        // Phrase merge: absorb subsequent purely-textual words with small x-gap.
        // Numeric-containing words are never merged into a phrase — they represent
        // independent numeric cells and legitimate column boundaries can sit
        // between them with gaps as small as a space character.
        //
        // Long narrative rows (footnotes) are filtered out earlier by the
        // paragraph-row check, so no chain-length cap is needed here — long
        // legitimate labels like "Card Member loans evaluated individually
        // for impairment (a)" (8 words) must merge into one label phrase.
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

    // Remove columns with very low row coverage. A real table column should
    // have content in a significant fraction of rows. Low-coverage columns
    // are typically artifacts from outlier label text that extends into the
    // gap between label and data columns (e.g., a parenthetical aside in a
    // long row label that happens to overlap an unused x-region).
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
      // Header rows that sit inside table.rows but before firstDataRowIdx.
      if (firstDataRowIdx > 0) {
        for (let ri = 0; ri < firstDataRowIdx; ri++) {
          if (table.rows[ri].lineIndices.length < 2) continue;
          for (const i of table.rows[ri].lineIndices) {
            for (const word of lines[i].words) addHeaderWord(word);
          }
        }
      }
      // Header lines above table.bbox.top (typical for row-band candidates
      // whose bbox starts at the first banded data row).
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

  // Header-anchor override. Two cases where header-derived separators
  // should replace word-clustering results:
  //
  // Case 1 (sparse under-count): word-clustering produced fewer than 4
  // columns AND header has more. Tables where each row populates only a
  // subset of columns leave data-word clustering with collapsed columns
  // that the header row still names.
  //
  // Case 2 (over-split correction): word-clustering produced MANY MORE
  // columns than the header AND the excess is at least 2×. This means
  // long sentences in a label column (or other wide text) created spurious
  // column boundaries; the header's column count, derived from structured
  // cell positions in the header band, is the better answer. The 2×
  // threshold avoids overriding tables where header and data disagree by
  // only one column (which could be a legitimate sub-column the header
  // didn't name rather than a data over-split).
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

  // Reconcile with structural row-band evidence when both are available.
  //
  // Text-based inference and fill-based structural evidence are independent
  // signals. When they agree, the answer is clear. When they disagree, one of
  // them is wrong, and the disagreement itself reveals which:
  //
  //   * Text over-splits when a single logical cell emits multiple phrases
  //     with enough x-gap to cross the phrase-merge threshold (e.g., "22.0 %"
  //     in a non-GAAP reconciliation table). The resulting spurious columns
  //     are narrow outliers relative to the legitimate columns in the table.
  //
  //   * Fills under-split when adjacent cells share a continuous fill strip
  //     with no intervening gap (e.g., the 3m p25 Issuer Purchases table
  //     where visual styling places cells flush against each other).
  //
  // The reconciliation: use the text-inferred column positions unless they
  // contain a narrow-outlier column (width less than ~30% of the median
  // column width), which is a direct structural indicator of over-splitting.
  // In that case, prefer the fill-inferred positions.
  if (table.rowBandRegion && table.rowBandRegion.colXs.length > 0 && table.colSeparators.length > 0) {
    const fillSeps = table.rowBandRegion.colXs.slice().sort((a, b) => a - b);
    const textSeps = table.colSeparators;

    // Compute text-inferred column widths (bbox.left → first sep → ... → bbox.right).
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
 * Replaces the generous Phase 2 expansion with a precise boundary based on:
 * 1. hLines (strongest signal): a horizontal line between header and data marks the boundary
 * 2. Header scanning (fallback): chain upward from detected rows accepting header-like lines
 *
 * @param {DetectedTable} table
 * @param {Array} lines - All page lines
 * @param {number} [topFloor=0] - Lower bound for the refined top
 */
function refineTableTop(table, lines, topFloor = 0) {
  const rows = table.rows;
  if (rows.length === 0) return;

  // If header detection identified a STRONG header (≥4 aligned column
  // anchors), use its bandTop directly. detectHeaders's scan reaches
  // farther upward than this function's gap chain (up to ~10×avgRowHeight
  // vs ~0.45×), so the bandTop is the authoritative answer when we trust
  // the header. Weak-confidence headers fall through to the existing scan —
  // they might point at a real header row, but without enough column
  // alignment evidence to anchor trust, we'd rather let refineTableTop's
  // conservative gap-based logic decide whether to reach them.
  if (table.headers && table.headers.confidence === 'strong') {
    let strongTop = Math.max(topFloor, table.headers.bandTop - 5);
    // Even with a strong header, push past any colon-ending prose lines
    // between strongTop and the first data row.
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
  // Use the MEDIAN inter-row spacing as the row height. The mean is biased
  // upward by large gaps from section-break bridging, which makes the
  // proximity threshold too permissive when scanning back into the header.
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

  // Determine the scanning anchor: the best starting point for upward header scanning.
  // If hLines exist above the first detected row, the CLOSEST one (largest y < firstRowY)
  // marks the header/data boundary (e.g., top border of a table rectangle). Using the
  // closest rather than the highest avoids picking up decorative lines or section dividers
  // that are unrelated to the table. The anchor gives the scanner a head start, reaching
  // headers that are above the boundary.
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

  // Compute the leftmost x of detected row content. Lines whose left edge is
  // significantly left of this are page-margin content (section headers, paragraph
  // text at the body indent) rather than table content (which is indented further).
  let dataLeftEdge = Infinity;
  for (const r of rows) {
    for (const idx of r.lineIndices) {
      if (lines[idx].bbox.left < dataLeftEdge) dataLeftEdge = lines[idx].bbox.left;
    }
  }

  // Scan upward from the anchor, accepting lines that look like table headers.
  // The scan chains from the CURRENT headerTop — each accepted line becomes the
  // new anchor for the next iteration. This lets the scan thread past narrow
  // section labels like "Current:" or "Deferred:" to reach the real column
  // header rows sitting above them.
  let headerTop = scanAnchor;

  // Collect non-table lines above the first detected row. The search window
  // slides upward with headerTop, so pull in every line above firstRowY that
  // overlaps the table's x-range and let the per-line proximity check decide
  // how far the chain can reach.
  const aboveLines = [];
  for (let li = 0; li < lines.length; li++) {
    if (allLineIndicesSet.has(li)) continue;
    const line = lines[li];
    if (line.bbox.top >= firstRowY) continue;
    if (line.bbox.bottom <= topFloor) continue;
    if (line.bbox.right < table.bbox.left || line.bbox.left > table.bbox.right) continue;
    aboveLines.push({ idx: li, line });
  }
  aboveLines.sort((a, b) => b.line.bbox.top - a.line.bbox.top); // bottom-up

  // Track the running x-extent of consecutive single-segment header lines.
  /** @type {{left: number, right: number} | null} */
  let singleSegRange = null;

  for (const { idx, line } of aboveLines) {
    const lineWidth = line.bbox.right - line.bbox.left;

    // Check if multi-segment (another line at the same y within the table's x-range).
    let isMultiSegment = false;
    for (let lj = 0; lj < lines.length; lj++) {
      if (lj === idx) continue;
      if (Math.abs(lines[lj].bbox.top - line.bbox.top) < 5
          && lines[lj].bbox.right >= table.bbox.left && lines[lj].bbox.left <= table.bbox.right) {
        isMultiSegment = true;
        break;
      }
    }

    // Multi-segment rows chain from the CURRENT headerTop with a generous
    // 2.5× gap, letting the scan thread upward through stacked header rows.
    // Single-segment rows also chain from headerTop, with a tighter 0.45× gap
    // — small enough that an oversized page title above
    // the header band is rejected, but large enough to thread through stacked narrow header rows.
    // `continue` rather than `break` so a misaligned narrow outlier doesn't
    // terminate the chain prematurely.
    // Lines ending with "follows:" are introductory prose ("...as follows:",
    // "...were as follows:"). Stop the upward scan. Only "follows:" is
    // checked — short labels like "Deferred:" or "Current:" are legitimate
    // table sub-headers that must not terminate the scan.
    const lineText = line.words.length > 0 ? line.words[line.words.length - 1].text : '';
    if (lineText === 'follows:') break;

    const gapToHeader = headerTop - line.bbox.bottom;
    if (isMultiSegment) {
      if (gapToHeader > avgRowHeight * 2.5) break;
      headerTop = Math.min(headerTop, line.bbox.top);
      singleSegRange = null;
      continue;
    }
    if (gapToHeader > avgRowHeight * 0.45) continue;

    // Single-segment: reject wide lines (>60% of table width) — those are
    // paragraph text above the table, not header labels.
    if (lineWidth > candidateWidth * 0.6) break;

    // Single-segment: reject lines whose left edge is significantly left of the
    // table content (page-margin section headers vs indented table content).
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

  // Post-scan cleanup: push finalTop past any non-header lines that overlap
  // the region between finalTop and the first detected row. This handles:
  // (a) Tall lines that straddle the boundary (top above, bottom below finalTop)
  // (b) Wide paragraph text fully inside the region (above data but below the scan break point)
  let pushed = true;
  while (pushed) {
    pushed = false;
    for (let li = 0; li < lines.length; li++) {
      if (allLineIndicesSet.has(li)) continue;
      const line = lines[li];
      if (line.bbox.right < table.bbox.left || line.bbox.left > table.bbox.right) continue;
      // Check if line overlaps with [finalTop, firstRowY]
      if (line.bbox.bottom <= finalTop || line.bbox.top >= firstRowY) continue;

      // Straddling line (top above finalTop, bottom inside)
      if (line.bbox.top < finalTop) {
        finalTop = line.bbox.bottom + 1;
        pushed = true;
        continue;
      }

      // Line ending with "follows:" is introductory prose (e.g., "...as follows:").
      const lastWord = line.words.length > 0 ? line.words[line.words.length - 1].text : '';
      if (lastWord === 'follows:') {
        finalTop = line.bbox.bottom + 1;
        pushed = true;
        continue;
      }

      // Line fully inside — reject if wide single-segment (paragraph text)
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

  // Final pass: push past any "follows:"-ending lines at the very top of the table.
  // These are introductory prose ("...as follows:") captured during candidate
  // formation because they share the y-position of the first header row.
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
 * Detect tables anchored to a "ruling row" — a y-band containing 2+ horizontal
 * paths whose x-extents are mutually disjoint.
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
    // ≥3 lines guards against 2-line decorative coincidences (form-field
    // underlines, callout boxes). All real financial table rules in the
    // training set have ≥3 column rules including the label-column rule.
    if (g.lines.length < 3) continue;
    const sorted = [...g.lines].sort((a, b) => a.left - b.left);
    let disjoint = true;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].left < sorted[i - 1].right - 1) { disjoint = false; break; }
    }
    if (!disjoint) continue;
    // The combined x-span must cover a significant fraction of the page.
    // Reject decorative lines clustered in a corner or footnote area.
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

  // For each primary, precompute geometry shared between passes.
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

  // Pass 1: upward header scan for each primary, bounded above by the
  // previous primary's rule.y. Uses a tight top-to-top gap (1.5× median row
  // spacing) so a section break or the previous primary's data block stops
  // the scan.
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

    // Estimate row spacing from the lines just above the rule (header rows
    // are tighter; falls back to a reasonable default if too few lines).
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

  // Pass 2: downward data scan for each primary, bounded below by the next
  // primary's header top (so adjacent tables on the same page don't leak
  // into each other).
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

    // Estimate row spacing from the first few rows (most likely table data,
    // before any prose break). A gap >2.5× this stops the scan — catches
    // post-table prose that fits inside the column extent.
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

    // Validate that rows actually distribute numeric content across multiple
    // columns. A sequence of prose paragraphs that happens to sit below a
    // 3-line decorative rule lays words out continuously, with at most one
    // number per row scattered through prose. A real data row places a
    // numeric value in each numeric column. Two checks:
    //   1. ≥5 rows where 2+ distinct columns each contain a numeric word.
    //   2. ≥1 non-label column contains numeric content in ≥50% of rows
    //      (column-consistency — prose lacks this; real tables have it
    //      because each metric's column is filled in every row).
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
 * Group hLines into y-bands of ≥2 disjoint horizontal segments spanning ≥20%
 * of page width. Used to refine column boundaries of overlapping text tables.
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
 * Detect a table from an hLine cluster whose horizontal lines are segmented at
 * consistent break points but lacks the 3+ vLines required for full grid detection.
 * The break points in the segmented hLines encode implicit column separators.
 *
 * @param {HLine[]} cluster - hLines with consistent x-extent
 * @param {Array<{left: number, top: number, right: number, bottom: number}>} headerFills
 * @param {import('../objects/ocrObjects.js').OcrPage} pageObj
 * @returns {DetectedTable[]}
 */
function detectSegmentedHLineTables(cluster, headerFills, pageObj) {
  // Extract break points from each hLine's pre-merge segments.
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

  // Group rows by break pattern. A cluster may contain hLines from multiple
  // tables with different column structures — each distinct break pattern
  // forms a separate table candidate.
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
      if (consistent) { group.push(rb); matched = true; break; }
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

    // Find a matching header fill whose x-extent aligns with this group's
    // hLines and sits at or above the topmost hLine.
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
 * @param {Array} lines - All page lines
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
 * Extend a table's bbox to include structurally adjacent content not captured
 * by the original detection.
 *
 * Grid detection derives bbox.left from the cluster of drawn stroked lines,
 * which may not reach a table's leftmost label column — labels rarely carry
 * stroked cell borders. Summary rows drawn just below the last stroked grid
 * line get similarly excluded. This pass rescues both patterns using text
 * geometry:
 *   - If a majority of detected rows have a text line whose left edge sits
 *     before bbox.left, treat that as a label column: widen bbox.left and
 *     insert a separator at the prior bbox.left. Lines that straddle the old
 *     boundary (label text merged with the first numeric value in a single
 *     stream object) are added to the row's lineIndices via their left edge,
 *     not by being entirely left of the boundary.
 *   - If the row immediately below bbox.bottom places its line segments
 *     within the existing column structure, treat it as a continuation row
 *     (Total / Previous Year) and widen bbox.bottom.
 *   - If the left extension fires, scan for a heading line inside the new
 *     label-column strip above bbox.top and raise bbox.top to include it
 *     (e.g. the "6. FIXED ASSETS" schedule heading that sits above the
 *     header band in the label column).
 *
 * Unconditional for all detected tables; a text-based candidate whose bbox
 * already spans the label column will find nothing before bbox.left and the
 * extension is a no-op.
 *
 * @param {DetectedTable} table
 * @param {Array} lines
 */
function extendTableToAdjacentContent(table, lines) {
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
  // Qualifying line for a LABEL column:
  //   (a) Right edge sits clearly before bbox.left — this keeps the line
  //       from being a data row whose content merely extends past the
  //       existing bbox.left (e.g. a long name under a short "Name" header).
  //   (b) Width is smaller than half the current bbox width — a label column
  //       is, by construction, a smaller column than the table body; wide
  //       text (a paragraph, a caption) at the same y as a table row isn't
  //       a label, it's unrelated page content that happens to overlap.
  //   (c) Left edge matches the candidate label-column left (within 10 pt of
  //       the minimum left across qualifying lines) — a real label column
  //       has a consistent left alignment.
  //
  // We also track "row-overlap lines" separately: these start before
  // bbox.left but extend into the bbox (parsePdfDoc sometimes emits a label
  // and its first numeric value as one stream line, e.g. "Trademarks &
  // Goodwill 10.82"). These don't CONFIRM a label column (their right edge
  // doesn't stay in the label strip), but once a label column has been
  // confirmed by condition-a lines, they should be added to their row so
  // getTableLines finds the label text.
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
    for (const arr of leftAdjByRow.values()) {
      for (const { line } of arr) {
        if (line.bbox.left < newLeft) newLeft = line.bbox.left;
        if (line.bbox.right > maxRight) maxRight = line.bbox.right;
      }
    }
    // Aggregate-width guard: the candidate label column's TOTAL horizontal
    // span (from leftmost qualifying-line left to rightmost qualifying-line
    // right) must be narrower than half the current bbox width. This keeps
    // a side-by-side table in the OTHER page column from being absorbed as
    // a label column on multi-column page layouts: a parallel table body
    // is comparable in width to the current table, not narrow like a
    // label strip.
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
      // Attach row-overlap lines (label-merged-with-first-value) to their
      // matching rows too. These don't satisfy the confirmation criteria
      // alone, but once the label column is confirmed by independent left-
      // of-bbox lines, they're the row's label content and should be
      // included so downstream consumers (e.g. getTableLines) find them.
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

  // === Top extension (only after left extension) ===
  // Scan for a heading line sitting inside the newly-included label-column
  // strip above current bbox.top. The heading must fit within the label
  // column's x-range and be within ~2 median row heights of bbox.top.
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
  // A row just below bbox.bottom whose line segments land within the
  // existing column structure is treated as a continuation data row
  // (Total / Previous Year). Single-line rows below the grid are skipped
  // (likely a footnote); the loop breaks once it hits a row whose segments
  // do NOT align with the table's columns (the table has ended).
  const colBoundaries = [table.bbox.left, ...table.colSeparators, table.bbox.right];
  const belowLimit = table.bbox.bottom + medianSpacing * 1.5;
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
  // Note: row-to-row stream order is NOT checked. On two-column pages, rows from
  // both columns (with interleaved line indices) form valid table candidates.
  // The row-to-row check would reject these because left-column rows (low indices)
  // alternate with right-column rows (high indices) at similar y-positions.

  // Remove rows where spatial left-to-right order doesn't match stream order.
  // A single bad row (e.g., chart labels accidentally included) shouldn't reject
  // the entire table — just remove the offending row.
  // Skip the check for column-major rows (lineIndices scattered across the stream
  // by large gaps): in these layouts, each cell is a separate stream segment, so
  // stream order does not match spatial order by design.
  for (let i = table.rows.length - 1; i >= 0; i--) {
    const row = table.rows[i];
    if (row.lineIndices.length < 2) continue;
    let maxGap = 0;
    for (let k = 1; k < row.lineIndices.length; k++) {
      const g = row.lineIndices[k] - row.lineIndices[k - 1];
      if (g > maxGap) maxGap = g;
    }
    if (maxGap > 2) continue; // column-major row, skip spatial check
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

function computeBboxFromLineIndices(indices, lines) {
  let left = Infinity; let top = Infinity;
  let right = -Infinity; let bottom = -Infinity;
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
 * Recursively splits at the largest gap when the gap ratio exceeds the threshold.
 * Returns an array of sub-clusters (each is an array of hLines).
 */
function splitClusterByYGap(cluster) {
  const sorted = [...cluster].sort((a, b) => a.y - b.y);

  // Deduplicate y-positions for gap analysis. Per-cell hLine segments at the
  // same y produce many zero-gaps that corrupt the median. Use unique y-values
  // to compute meaningful gap statistics, but split the full sorted array.
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
  // Large clusters provide a more reliable median, so a tighter ratio is safe.
  // A gap > 4× the median row spacing strongly indicates a table boundary.
  const gapRatioLimit = uniqueYEntries.length >= 10 ? 4 : 5;

  if (medianGap <= 0 || maxEntry.gap <= medianGap * gapRatioLimit) {
    return [cluster]; // cluster is consistent
  }

  // Split at the largest gap and recurse on each half
  const left = sorted.slice(0, maxEntry.index);
  const right = sorted.slice(maxEntry.index);
  return [...splitClusterByYGap(left), ...splitClusterByYGap(right)];
}

/**
 * Cluster horizontal lines by overlapping x-extent (>50% overlap).
 */
function clusterHLinesByXExtent(hLines) {
  /** @type {Array<{lines: HLine[], left: number, right: number}>} */
  const clusters = [];
  for (const hl of hLines) {
    let added = false;
    for (const cluster of clusters) {
      // Check overlap against the cluster's union extent (not just the first member).
      // This ensures that a partial-width hLine (e.g., spanning only the left half of
      // a table) joins the cluster if it overlaps substantially with ANY full-width member,
      // even if the first member happened to be partial.
      const overlapLeft = Math.max(hl.left, cluster.left);
      const overlapRight = Math.min(hl.right, cluster.right);
      const overlap = Math.max(0, overlapRight - overlapLeft);
      const hlWidth = hl.right - hl.left;
      const clusterWidth = cluster.right - cluster.left;
      const minWidth = Math.min(hlWidth, clusterWidth);
      // Also check adjacency: segmented grids (e.g., per-cell border segments)
      // produce hLines that touch at column boundaries but don't overlap.
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
