/* eslint-disable import/no-cycle */
import { UiOcrWord } from './viewerWordObjects.js';

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
 * @param {import('../viewer.js').ScribeViewer} viewer
 */
export function updateHighlightGroupOutline(viewer) {
  for (const rect of viewer._highlightOutlineRects) rect.remove();
  viewer._highlightOutlineRects.length = 0;

  const selectedWords = viewer.CanvasSelection.getUiWords();
  if (!selectedWords || selectedWords.length === 0) return;

  const firstWord = selectedWords[0];
  if (!firstWord.highlightGroupId) return;

  const groupId = firstWord.highlightGroupId;
  const allWords = viewer.getUiWords();
  const groupWords = allWords.filter((kw) => kw.highlightGroupId === groupId);
  if (groupWords.length === 0) return;

  const pageMap = new Map();
  for (const kw of groupWords) {
    const pageN = kw.word.line.page.n;
    if (!pageMap.has(pageN)) pageMap.set(pageN, []);
    pageMap.get(pageN).push(kw);
  }

  for (const [pageN, pageWords] of pageMap) {
    const lineMap = new Map();
    for (const kw of pageWords) {
      const lineId = kw.word.line.id;
      if (!lineMap.has(lineId)) lineMap.set(lineId, []);
      lineMap.get(lineId).push(kw);
    }

    const group = viewer.getTextGroup(pageN);
    const pad = pageWords[0].height() * 0.2;

    for (const lineWords of lineMap.values()) {
      lineWords.sort((a, b) => a.x() - b.x());
      const first = lineWords[0];
      const last = lineWords[lineWords.length - 1];
      const left = first.x() - first.highlightGapLeft;
      const right = last.x() + last.width() + last.highlightGapRight;
      const top = first.y() - pad;
      const height = first.height() + pad * 2;

      const rect = document.createElement('div');
      Object.assign(rect.style, {
        position: 'absolute',
        left: `${left}px`,
        top: `${top}px`,
        width: `${right - left}px`,
        height: `${height}px`,
        border: 'calc(2px / var(--scribe-zoom, 1)) dashed rgba(40,123,181,0.8)',
        boxSizing: 'border-box',
        pointerEvents: 'none',
        zIndex: '2',
      });
      group.appendChild(rect);
      viewer._highlightOutlineRects.push(rect);
    }
  }
}

/**
 * Recalculates highlight gap extensions for words on the same lines as the given words.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {Array<InstanceType<typeof UiOcrWord>>} changedWords
 */
function updateHighlightGaps(viewer, changedWords) {
  const allWords = viewer.getUiWords();
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
 * Removes the highlight and annotation data from the given words.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {Array<InstanceType<typeof UiOcrWord>>} selectedWords
 */
export function removeHighlight(viewer, selectedWords) {
  if (!selectedWords || selectedWords.length === 0) return;

  for (const kw of selectedWords) {
    kw.highlightColor = null;
    kw.highlightOpacity = 1;
  }
  for (const kw of selectedWords) {
    const n = kw.word.line.page.n;
    const wb = kw.word.bbox;
    viewer.doc.annotations.pages[n] = viewer.doc.annotations.pages[n].filter(
      (annot) => !annotMatchesWord(annot, wb),
    );
  }
  updateHighlightGaps(viewer, selectedWords);
  updateHighlightGroupOutline(viewer);
  for (const p of new Set(selectedWords.map((kw) => kw.word.line.page.n))) viewer.renderHighlights(p);
  UiOcrWord.updateUI();
}

/**
 * Applies highlight color and annotation data to the given words.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {Array<InstanceType<typeof UiOcrWord>>} selectedWords
 * @param {string} color
 * @param {number} opacity
 */
export function applyHighlight(viewer, selectedWords, color, opacity) {
  if (!selectedWords || selectedWords.length === 0) return;

  const pageWordsMap = new Map();
  for (const kw of selectedWords) {
    const n = kw.word.line.page.n;
    if (!pageWordsMap.has(n)) pageWordsMap.set(n, []);
    pageWordsMap.get(n).push(kw);
  }

  for (const [pageIndex, pageSelWords] of pageWordsMap) {
    for (const kw of pageSelWords) {
      const wb = kw.word.bbox;
      const existingAnnot = viewer.doc.annotations.pages[pageIndex].find(
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

    const wordsWithoutAnnot = pageSelWords.filter((kw) => {
      const wb = kw.word.bbox;
      return !viewer.doc.annotations.pages[pageIndex].some(
        (annot) => annotMatchesWord(annot, wb),
      );
    });

    if (wordsWithoutAnnot.length > 0) {
      const allWords = viewer.getUiWords();
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

      const lineRuns = [];
      for (const [lineId, words] of lineMap) {
        const lineAllWords = allWords.filter((kw) => kw.word.line.id === lineId);
        lineAllWords.sort((a, b) => a.x() - b.x());

        let currentRun = [words[0]];
        for (let i = 1; i < words.length; i++) {
          const prev = words[i - 1];
          const curr = words[i];
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
            viewer.doc.annotations.pages[pageIndex].push({
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
  }

  updateHighlightGaps(viewer, selectedWords);
  updateHighlightGroupOutline(viewer);
  for (const p of pageWordsMap.keys()) viewer.renderHighlights(p);
  UiOcrWord.updateUI();
}

/**
 * The page index and annotations of the highlight containing `uiWord`:
 * the word's group when it has a group id, else the annotations covering its bbox
 * (a PDF-imported highlight may be group-less).
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {InstanceType<typeof UiOcrWord>} uiWord
 */
function groupAnnotations(viewer, uiWord) {
  const n = uiWord.word.line.page.n;
  const groupId = uiWord.highlightGroupId || null;
  const pageAnnotations = viewer.doc.annotations.pages[n] || [];
  const annots = groupId
    ? pageAnnotations.filter((annot) => annot.groupId === groupId)
    : pageAnnotations.filter((annot) => annotMatchesWord(annot, uiWord.word.bbox));
  return { n, groupId, annots };
}

/**
 * Remove the whole highlight containing `uiWord`.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {InstanceType<typeof UiOcrWord>} uiWord
 */
export function removeHighlightGroup(viewer, uiWord) {
  if (!uiWord || !uiWord.highlightColor) return;
  const { n, groupId, annots } = groupAnnotations(viewer, uiWord);
  viewer.doc.annotations.pages[n] = (viewer.doc.annotations.pages[n] || []).filter((annot) => !annots.includes(annot));

  for (const kw of viewer.getUiWords()) {
    // Only clear words on the page whose annotations we removed.
    // A pasted copy of this page has identical word geometry, so without this scope the bbox match below would also clear the copy's (independent) highlight.
    if (kw.word.line.page.n !== n) continue;
    const covered = kw === uiWord
      || (groupId && kw.highlightGroupId === groupId)
      || annots.some((annot) => annotMatchesWord(annot, kw.word.bbox));
    if (!covered) continue;
    kw.highlightColor = null;
    kw.highlightOpacity = 1;
    kw.highlightGroupId = null;
    kw.highlightComment = '';
    kw.highlightGapLeft = 0;
    kw.highlightGapRight = 0;
  }

  updateHighlightGroupOutline(viewer);
  viewer.renderHighlights(n);
  UiOcrWord.updateUI();
}

/**
 * Recolor the whole highlight containing `uiWord`. Group ids and comments are untouched.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {InstanceType<typeof UiOcrWord>} uiWord
 * @param {string} color
 */
export function recolorHighlightGroup(viewer, uiWord, color) {
  if (!uiWord || !uiWord.highlightColor) return;
  const { n, groupId, annots } = groupAnnotations(viewer, uiWord);
  for (const annot of annots) annot.color = color;

  for (const kw of viewer.getUiWords()) {
    // Page scope for the same reason as `removeHighlightGroup`: a pasted copy has identical word geometry.
    if (kw.word.line.page.n !== n) continue;
    const covered = kw === uiWord
      || (groupId && kw.highlightGroupId === groupId)
      || annots.some((annot) => annotMatchesWord(annot, kw.word.bbox));
    if (covered) kw.highlightColor = color;
  }

  viewer.renderHighlights(n);
  UiOcrWord.updateUI();
}

/**
 * Set the comment on the highlight group containing the first selected word.
 * Author and creation time are set on the first non-empty comment, kept through later edits, and removed when it is cleared.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {Array<InstanceType<typeof UiOcrWord>>} selectedWords
 * @param {string} comment
 */
export function modifyHighlightComment(viewer, selectedWords, comment) {
  if (!selectedWords || selectedWords.length === 0) return;
  const pageIndex = selectedWords[0].word.line.page.n;
  const wb = selectedWords[0].word.bbox;
  const matchingAnnot = viewer.doc.annotations.pages[pageIndex].find(
    (annot) => annotMatchesWord(annot, wb),
  );
  if (!matchingAnnot || !matchingAnnot.groupId) return;
  const author = viewer.opt.commentAuthor || '';
  const now = new Date().toISOString();
  for (const annot of viewer.doc.annotations.pages[pageIndex]) {
    if (annot.groupId !== matchingAnnot.groupId) continue;
    annot.comment = comment;
    if (comment) {
      if (author && !annot.author) annot.author = author;
      if (!annot.createdAt) annot.createdAt = now;
    } else {
      delete annot.author;
      delete annot.createdAt;
    }
  }
  for (const kw of viewer.getUiWords()) {
    if (kw.highlightGroupId === matchingAnnot.groupId) {
      kw.highlightComment = comment;
    }
  }
}
