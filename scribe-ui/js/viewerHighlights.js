/* eslint-disable import/no-cycle */
import scribe from '../../scribe.js';

import { ScribeViewer } from '../viewer.js';
import { KonvaOcrWord } from './viewerWordObjects.js';
import Konva from './konva/index.js';

/** @type {Array<InstanceType<typeof Konva.Rect>>} */
const highlightOutlineRects = [];

/**
 * Checks if a word bbox is highlighted by an annotation.
 * Uses bbox containment as a pre-filter, then checks quads overlap if present.
 * @param {AnnotationHighlight} annot
 * @param {bbox} wb - Word bounding box
 */
export function annotMatchesWord(annot, wb) {
  if (!(annot.bbox.left <= wb.left && annot.bbox.right >= wb.right
    && annot.bbox.top <= wb.top && annot.bbox.bottom >= wb.bottom)) return false;
  if (annot.quads) {
    return annot.quads.some((quad) => quad.left < wb.right && quad.right > wb.left
      && quad.top < wb.bottom && quad.bottom > wb.top);
  }
  return true;
}

/**
 * Draws outline rectangles around all words in the same highlight group as the selected word.
 * Clears any previous outlines first.
 */
export function updateHighlightGroupOutline() {
  // Remove existing outlines
  for (const rect of highlightOutlineRects) rect.destroy();
  highlightOutlineRects.length = 0;

  const selectedWords = ScribeViewer.CanvasSelection.getKonvaWords();
  if (!selectedWords || selectedWords.length === 0) {
    ScribeViewer.layerText.batchDraw();
    return;
  }

  const firstWord = selectedWords[0];
  if (!firstWord.highlightGroupId) {
    ScribeViewer.layerText.batchDraw();
    return;
  }

  const groupId = firstWord.highlightGroupId;
  const allWords = ScribeViewer.getKonvaWords();
  const groupWords = allWords.filter((kw) => kw.highlightGroupId === groupId);
  if (groupWords.length === 0) {
    ScribeViewer.layerText.batchDraw();
    return;
  }

  // Group words by page, then by line within each page
  const pageMap = new Map();
  for (const kw of groupWords) {
    const pageN = kw.word.line.page.n;
    if (!pageMap.has(pageN)) pageMap.set(pageN, []);
    pageMap.get(pageN).push(kw);
  }

  const scale = ScribeViewer.layerText.getAbsoluteScale()?.x || 1;

  for (const [pageN, pageWords] of pageMap) {
    const lineMap = new Map();
    for (const kw of pageWords) {
      const lineId = kw.word.line.id;
      if (!lineMap.has(lineId)) lineMap.set(lineId, []);
      lineMap.get(lineId).push(kw);
    }

    const group = ScribeViewer.getTextGroup(pageN);
    const pad = pageWords[0].height() * 0.2;

    for (const lineWords of lineMap.values()) {
      lineWords.sort((a, b) => a.x() - b.x());
      const first = lineWords[0];
      const last = lineWords[lineWords.length - 1];
      const left = first.x() - first.highlightGapLeft;
      const right = last.x() + last.width() + last.highlightGapRight;
      const top = first.y() - pad;
      const height = first.height() + pad * 2;

      const rect = new Konva.Rect({
        x: left,
        y: top,
        width: right - left,
        height,
        stroke: 'rgba(40,123,181,0.8)',
        strokeWidth: 2 / scale,
        dash: [8 / scale, 5 / scale],
        draggable: false,
        listening: false,
      });
      group.add(rect);
      highlightOutlineRects.push(rect);
    }
  }

  ScribeViewer.layerText.batchDraw();
}

/**
 * Recalculates highlight gap extensions for words on the same lines as the given words.
 * @param {Array<InstanceType<typeof KonvaOcrWord>>} changedWords
 */
function updateHighlightGaps(changedWords) {
  const allWords = ScribeViewer.getKonvaWords();
  const affectedLineIds = new Set(changedWords.map((kw) => kw.word.line.id));
  const lineWords = new Map();
  for (const kw of allWords) {
    if (!affectedLineIds.has(kw.word.line.id)) continue;
    if (!lineWords.has(kw.word.line.id)) lineWords.set(kw.word.line.id, []);
    lineWords.get(kw.word.line.id).push(kw);
  }
  for (const words of lineWords.values()) {
    words.sort((a, b) => a.x() - b.x());
    for (let i = 0; i < words.length; i++) {
      const wc = words[i];
      wc.highlightGapLeft = 0;
      wc.highlightGapRight = 0;
      if (!wc.highlightColor) continue;
      if (i > 0 && words[i - 1].highlightColor) {
        wc.highlightGapLeft = (wc.x() - (words[i - 1].x() + words[i - 1].width())) / 2;
      }
      if (i < words.length - 1 && words[i + 1].highlightColor) {
        wc.highlightGapRight = (words[i + 1].x() - (wc.x() + wc.width())) / 2;
      }
    }
  }
}

/**
 * Removes highlight from the given words and their annotation data.
 * @param {Array<InstanceType<typeof KonvaOcrWord>>} selectedWords
 * @param {number} pageIndex
 */
export function removeHighlight(selectedWords, pageIndex) {
  if (!selectedWords || selectedWords.length === 0) return;

  for (const kw of selectedWords) {
    kw.highlightColor = null;
    kw.highlightOpacity = 1;
  }
  for (const kw of selectedWords) {
    const wb = kw.word.bbox;
    scribe.data.annotations.pages[pageIndex] = scribe.data.annotations.pages[pageIndex].filter(
      (annot) => !annotMatchesWord(annot, wb),
    );
  }
  updateHighlightGaps(selectedWords);
  updateHighlightGroupOutline();
  ScribeViewer.layerText.batchDraw();
  KonvaOcrWord.updateUI();
}

/**
 * Applies highlight color to the given words and creates/updates annotation data.
 * @param {Array<InstanceType<typeof KonvaOcrWord>>} selectedWords
 * @param {number} pageIndex
 * @param {string} color
 * @param {number} opacity
 */
export function applyHighlight(selectedWords, pageIndex, color, opacity) {
  if (!selectedWords || selectedWords.length === 0) return;

  // Update existing annotations (preserve groupId and comment)
  for (const kw of selectedWords) {
    const wb = kw.word.bbox;
    const existingAnnot = scribe.data.annotations.pages[pageIndex].find(
      (annot) => annotMatchesWord(annot, wb),
    );
    if (existingAnnot) {
      existingAnnot.color = color;
      existingAnnot.opacity = opacity;
      if (!existingAnnot.groupId) {
        existingAnnot.groupId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        existingAnnot.comment = existingAnnot.comment || '';
      }
    }
    kw.highlightColor = color;
    kw.highlightOpacity = opacity;
  }

  // Add annotation data for words that don't already have one
  const wordsWithoutAnnot = selectedWords.filter((kw) => {
    const wb = kw.word.bbox;
    return !scribe.data.annotations.pages[pageIndex].some(
      (annot) => annotMatchesWord(annot, wb),
    );
  });

  if (wordsWithoutAnnot.length > 0) {
    // Split new words into contiguous runs and assign groupIds
    const allWords = ScribeViewer.getKonvaWords();
    const selectedSet = new Set(wordsWithoutAnnot.map((kw) => kw.word.id));

    const lineMap = new Map();
    for (const kw of wordsWithoutAnnot) {
      const lineId = kw.word.line.id;
      if (!lineMap.has(lineId)) lineMap.set(lineId, []);
      lineMap.get(lineId).push(kw);
    }

    for (const words of lineMap.values()) {
      words.sort((a, b) => a.x() - b.x());
    }

    // For each line, split into contiguous runs (no unselected word between selected words)
    const lineRuns = [];
    for (const [lineId, words] of lineMap) {
      const lineAllWords = allWords.filter((kw) => kw.word.line.id === lineId);
      lineAllWords.sort((a, b) => a.x() - b.x());

      let currentRun = [words[0]];
      for (let i = 1; i < words.length; i++) {
        const prev = words[i - 1];
        const curr = words[i];
        // Check if there's an unselected word between prev and curr
        const hasGap = lineAllWords.some((kw) => !selectedSet.has(kw.word.id)
          && kw.x() > prev.x() && kw.x() < curr.x());
        if (hasGap) {
          lineRuns.push({ lineId, words: currentRun });
          currentRun = [curr];
        } else {
          currentRun.push(curr);
        }
      }
      lineRuns.push({ lineId, words: currentRun });
    }

    lineRuns.sort((a, b) => a.words[0].word.line.bbox.top - b.words[0].word.line.bbox.top);

    // Assign groupIds: merge vertically adjacent line runs into the same group
    const groups = [[lineRuns[0]]];
    for (let i = 1; i < lineRuns.length; i++) {
      const prevGroup = groups[groups.length - 1];
      const prevRun = prevGroup[prevGroup.length - 1];
      const currRun = lineRuns[i];
      const prevBottom = prevRun.words[0].word.line.bbox.bottom;
      const currTop = currRun.words[0].word.line.bbox.top;
      const lineHeight = prevRun.words[0].word.line.bbox.bottom - prevRun.words[0].word.line.bbox.top;
      if (currTop - prevBottom < lineHeight * 2) {
        prevGroup.push(currRun);
      } else {
        groups.push([currRun]);
      }
    }

    for (const group of groups) {
      const groupId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      for (const run of group) {
        for (const kw of run.words) {
          const wb = kw.word.bbox;
          scribe.data.annotations.pages[pageIndex].push({
            bbox: {
              left: wb.left, top: wb.top, right: wb.right, bottom: wb.bottom,
            },
            color,
            opacity,
            groupId,
            comment: '',
          });
          kw.highlightGroupId = groupId;
          kw.highlightComment = '';
        }
      }
    }
  }

  updateHighlightGaps(selectedWords);
  updateHighlightGroupOutline();
  ScribeViewer.layerText.batchDraw();
  KonvaOcrWord.updateUI();
}

/**
 * Updates the comment on the highlight group of the first selected word.
 * @param {Array<InstanceType<typeof KonvaOcrWord>>} selectedWords
 * @param {number} pageIndex
 * @param {string} comment
 */
export function modifyHighlightComment(selectedWords, pageIndex, comment) {
  if (!selectedWords || selectedWords.length === 0) return;
  const wb = selectedWords[0].word.bbox;
  const matchingAnnot = scribe.data.annotations.pages[pageIndex].find(
    (annot) => annotMatchesWord(annot, wb),
  );
  if (!matchingAnnot || !matchingAnnot.groupId) return;
  for (const annot of scribe.data.annotations.pages[pageIndex]) {
    if (annot.groupId === matchingAnnot.groupId) {
      annot.comment = comment;
    }
  }
  for (const kw of ScribeViewer.getKonvaWords()) {
    if (kw.highlightGroupId === matchingAnnot.groupId) {
      kw.highlightComment = comment;
    }
  }
  ScribeViewer.layerText.batchDraw();
}
