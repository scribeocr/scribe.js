// eslint-disable-next-line import/no-cycle
import { ScribeViewer } from '../viewer.js';
import scribe from '../../scribe.js';
import { UiText, UiOcrWord } from './viewerWordObjects.js';
import {
  deleteSelectedWord, modifySelectedWordBbox, modifySelectedWordStyle,
} from './viewerModifySelectedWords.js';

/**
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {UiText} uiObject
 */
const scrollIntoView = (viewer, uiObject) => {
  const sc = viewer.scrollContainer;
  const zoom = viewer.zoomLevel || 1;
  // `getClientRect` is content space; multiply by zoom to get the on-screen position relative to the scroll origin.
  const r = uiObject.getClientRect();
  const topPx = r.y * zoom - sc.scrollTop;
  const bottomPx = (r.y + r.height) * zoom - sc.scrollTop;
  const leftPx = r.x * zoom - sc.scrollLeft;
  const rightPx = (r.x + r.width) * zoom - sc.scrollLeft;

  const margin = 30;

  if (bottomPx > sc.clientHeight - margin) {
    sc.scrollTop += bottomPx - (sc.clientHeight - margin);
  } else if (topPx < 150) {
    // Top gets more padding to account for the toolbar.
    sc.scrollTop -= (200 - topPx);
  }

  if (rightPx > sc.clientWidth - margin) {
    sc.scrollLeft += rightPx - (sc.clientWidth - margin);
  } else if (leftPx < margin) {
    sc.scrollLeft -= (margin - leftPx);
  }

  viewer.updateCurrentPage();
};

/**
 * Moves the selection to the next word in the text, using the internal logical ordering of the words.
 * This is different from `selectRightWord`, which selects the word to the visual right of the current selection.
 * @param {import('../viewer.js').ScribeViewer} viewer
 */
export function selectNextWord(viewer) {
  const _viewer = viewer || ScribeViewer.getDefault();
  const words = _viewer.getUiWords();
  const selectedWords = _viewer.CanvasSelection.getUiWords();
  if (selectedWords.length !== 1) return;
  let nextWord;
  const selectedWord = selectedWords[0];
  const selectedWordIndex = selectedWord.word.line.words.findIndex((word) => word.id === selectedWord.word.id);
  if (selectedWordIndex + 1 < selectedWord.word.line.words.length) {
    nextWord = selectedWord.word.line.words[selectedWordIndex + 1];
  } else {
    const nextLine = scribe.utils.ocr.getNextLine(selectedWord.word.line);
    if (nextLine) {
      nextWord = nextLine.words[0];
    }
  }

  if (nextWord) {
    _viewer.destroyControls(true);
    const nextUiWord = words.filter((x) => x.word.id === nextWord.id)[0];
    scrollIntoView(_viewer, nextUiWord);
    _viewer.CanvasSelection.addWords(nextUiWord);
    UiOcrWord.addControls(nextUiWord);
    UiOcrWord.updateUI();
  }
}

/**
 * Moves the selection to the previous word in the text, using the internal logical ordering of the words.
 * @param {import('../viewer.js').ScribeViewer} viewer
 */
export function selectPrevWord(viewer) {
  const _viewer = viewer || ScribeViewer.getDefault();
  const words = _viewer.getUiWords();
  const selectedWords = _viewer.CanvasSelection.getUiWords();
  if (selectedWords.length !== 1) return;
  let prevWord;
  const selectedWord = selectedWords[0];
  const selectedWordIndex = selectedWord.word.line.words.findIndex((word) => word.id === selectedWord.word.id);
  if (selectedWordIndex - 1 >= 0) {
    prevWord = selectedWord.word.line.words[selectedWordIndex - 1];
  } else {
    const prevLine = scribe.utils.ocr.getPrevLine(selectedWord.word.line);
    if (prevLine) {
      prevWord = prevLine.words[prevLine.words.length - 1];
    }
  }

  if (prevWord) {
    _viewer.destroyControls(true);
    const prevUiWord = words.filter((x) => x.word.id === prevWord.id)[0];
    scrollIntoView(_viewer, prevUiWord);
    _viewer.CanvasSelection.addWords(prevUiWord);
    UiOcrWord.addControls(prevUiWord);
    UiOcrWord.updateUI();
  }
}

/**
 * Selects the word to the visual right of the current selection.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {boolean} selectMultiple
 */
export function selectRightWord(viewer, selectMultiple = false) {
  const _viewer = viewer || ScribeViewer.getDefault();
  const words = _viewer.getUiWords();
  let selectedWord;
  if (selectMultiple) {
    const selectedWords = _viewer.CanvasSelection.getUiWords();
    if (selectedWords.length === 0) return;
    selectedWords.sort((a, b) => a.x() - b.x());
    selectedWord = selectedWords[selectedWords.length - 1];
  } else {
    if (!_viewer.CanvasSelection.selectedWordFirst) return;
    selectedWord = _viewer.CanvasSelection.selectedWordFirst;
  }

  let rightWord;
  const selectedWordIndex = selectedWord.word.line.words.findIndex((word) => word.id === selectedWord.word.id);
  if (selectedWordIndex + 1 < selectedWord.word.line.words.length) {
    rightWord = selectedWord.word.line.words[selectedWordIndex + 1];
  } else {
    /** @type {?OcrLine} */
    let rightLine = null;
    for (let i = 0; i < selectedWord.word.line.page.lines.length; i++) {
      if (selectedWord.word.line.page.lines[i].bbox.left > selectedWord.word.line.bbox.right
                && selectedWord.word.line.page.lines[i].bbox.top < selectedWord.word.bbox.bottom
                && selectedWord.word.line.page.lines[i].bbox.bottom > selectedWord.word.bbox.top) {
        if (!rightLine || selectedWord.word.line.page.lines[i].bbox.left < rightLine.bbox.left) {
          rightLine = selectedWord.word.line.page.lines[i];
        }
      }
    }
    if (rightLine) rightWord = rightLine.words[0];
  }

  if (rightWord) {
    _viewer.destroyControls(!selectMultiple);
    const nextUiWord = words.filter((x) => x.word.id === rightWord.id)[0];
    scrollIntoView(_viewer, nextUiWord);
    nextUiWord.select();
    _viewer.CanvasSelection.addWords(nextUiWord);
    if (!selectMultiple) {
      UiOcrWord.addControls(nextUiWord);
    }
    UiOcrWord.updateUI();
  }
}

/**
 * Selects the word to the visual left of the current selection.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {boolean} selectMultiple
 */
export function selectLeftWord(viewer, selectMultiple = false) {
  const _viewer = viewer || ScribeViewer.getDefault();
  const words = _viewer.getUiWords();

  let selectedWord;
  if (selectMultiple) {
    const selectedWords = _viewer.CanvasSelection.getUiWords();
    if (selectedWords.length === 0) return;
    selectedWords.sort((a, b) => a.x() - b.x());
    selectedWord = selectedWords[0];
  } else {
    if (!_viewer.CanvasSelection.selectedWordFirst) return;
    selectedWord = _viewer.CanvasSelection.selectedWordFirst;
  }

  let leftWord;
  const selectedWordIndex = selectedWord.word.line.words.findIndex((word) => word.id === selectedWord.word.id);
  if (selectedWordIndex > 0) {
    leftWord = selectedWord.word.line.words[selectedWordIndex - 1];
  } else {
    /** @type {?OcrLine} */
    let leftLine = null;
    for (let i = 0; i < selectedWord.word.line.page.lines.length; i++) {
      if (selectedWord.word.line.page.lines[i].bbox.right < selectedWord.word.line.bbox.left
                && selectedWord.word.line.page.lines[i].bbox.top < selectedWord.word.bbox.bottom
                && selectedWord.word.line.page.lines[i].bbox.bottom > selectedWord.word.bbox.top) {
        if (!leftLine || selectedWord.word.line.page.lines[i].bbox.right > leftLine.bbox.right) {
          leftLine = selectedWord.word.line.page.lines[i];
        }
      }
    }
    if (leftLine) leftWord = leftLine.words[leftLine.words.length - 1];
  }

  if (leftWord) {
    _viewer.destroyControls(!selectMultiple);
    const nextUiWord = words.filter((x) => x.word.id === leftWord.id)[0];
    scrollIntoView(_viewer, nextUiWord);
    nextUiWord.select();
    _viewer.CanvasSelection.addWords(nextUiWord);
    if (!selectMultiple) {
      UiOcrWord.addControls(nextUiWord);
    }
    UiOcrWord.updateUI();
  }
}

/**
 * Selects the word visually above the current selection.
 * @param {import('../viewer.js').ScribeViewer} viewer
 */
export function selectAboveWord(viewer) {
  const _viewer = viewer || ScribeViewer.getDefault();
  const words = _viewer.getUiWords();
  const selectedWords = _viewer.CanvasSelection.getUiWords();
  if (selectedWords.length === 0) return;
  const selectedWord = selectedWords[0];
  const line = selectedWord.word.line;
  let prevLine = scribe.utils.ocr.getPrevLine(line);
  while (prevLine && !(prevLine.bbox.top < selectedWord.word.bbox.top && prevLine.bbox.left < selectedWord.word.bbox.right
        && prevLine.bbox.right > selectedWord.word.bbox.left)) {
    prevLine = scribe.utils.ocr.getPrevLine(prevLine);
  }
  if (!prevLine) return;
  const selectedWordCenter = (selectedWord.word.bbox.right + selectedWord.word.bbox.left) / 2;
  let bestDist = 5000;
  let aboveWord = prevLine.words[0];
  for (const word of prevLine.words) {
    const wordCenter = (word.bbox.right + word.bbox.left) / 2;
    const dist = Math.abs(selectedWordCenter - wordCenter);
    if (dist < bestDist) {
      bestDist = dist;
      aboveWord = word;
    } else {
      break;
    }
  }

  if (aboveWord) {
    _viewer.destroyControls(true);
    const aboveUiWord = words.filter((x) => x.word.id === aboveWord.id)[0];
    scrollIntoView(_viewer, aboveUiWord);
    aboveUiWord.select();
    _viewer.CanvasSelection.addWords(aboveUiWord);
    UiOcrWord.addControls(aboveUiWord);
    UiOcrWord.updateUI();
  }
}

/**
 * Selects the word visually below the current selection.
 * @param {import('../viewer.js').ScribeViewer} viewer
 */
export function selectBelowWord(viewer) {
  const _viewer = viewer || ScribeViewer.getDefault();
  const words = _viewer.getUiWords();
  const selectedWords = _viewer.CanvasSelection.getUiWords();
  if (selectedWords.length === 0) return;
  const selectedWord = selectedWords[0];
  const line = selectedWord.word.line;
  let nextLine = scribe.utils.ocr.getNextLine(line);
  while (nextLine && !(nextLine.bbox.bottom > selectedWord.word.bbox.bottom && nextLine.bbox.left < selectedWord.word.bbox.right
        && nextLine.bbox.right > selectedWord.word.bbox.left)) {
    nextLine = scribe.utils.ocr.getNextLine(nextLine);
  }
  if (!nextLine) return;
  const selectedWordCenter = (selectedWord.word.bbox.right + selectedWord.word.bbox.left) / 2;
  let bestDist = 5000;
  let belowWord = nextLine.words[0];
  for (const word of nextLine.words) {
    const wordCenter = (word.bbox.right + word.bbox.left) / 2;
    const dist = Math.abs(selectedWordCenter - wordCenter);
    if (dist < bestDist) {
      bestDist = dist;
      belowWord = word;
    } else {
      break;
    }
  }

  if (belowWord) {
    _viewer.destroyControls(true);
    const belowUiWord = words.filter((x) => x.word.id === belowWord.id)[0];
    scrollIntoView(_viewer, belowUiWord);
    belowUiWord.select();
    _viewer.CanvasSelection.addWords(belowUiWord);
    UiOcrWord.addControls(belowUiWord);
    UiOcrWord.updateUI();
  }
}

/**
 * Maps from generic `KeyboardEvent` when user presses a key to the appropriate action.
 * Routes to the currently-active viewer (last interacted with). For the static-API entry point,
 * call `handleKeyboardEvent(undefined, event)` and the default viewer is used.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {KeyboardEvent} event
 */
export function handleKeyboardEvent(viewer, event) {
  const _viewer = viewer || ScribeViewer.getActiveViewer() || ScribeViewer.getDefault();
  if (!_viewer) return;
  const activeElem = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  // Never steal keystrokes destined for a text-editing control: a host `<input>`/`<textarea>`,
  // a `contenteditable` host, or the viewer's own word-edit box, so typing there is unaffected.
  if (activeElem && (activeElem instanceof HTMLInputElement
    || activeElem instanceof HTMLTextAreaElement
    || activeElem.isContentEditable)) return;
  if (activeElem && activeElem instanceof HTMLSelectElement
    && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter'].includes(event.key)) return;

  const selectedWords = _viewer.CanvasSelection.getUiWords();

  // The modifier keys change what `event.key` is for the same button.
  // `+` becomes `=` when shift is pressed, and `×` when control and alt are pressed.
  if (event.ctrlKey && !event.altKey && ['+', '=', '×'].includes(event.key)) {
    _viewer.zoom(1.1);
    event.preventDefault();
    event.stopPropagation();
    _viewer.interactionCallback(event);
    return;
  }

  if (event.ctrlKey && !event.altKey && ['-', '_', '–'].includes(event.key)) {
    _viewer.zoom(0.9);
    event.preventDefault();
    event.stopPropagation();
    _viewer.interactionCallback(event);
    return;
  }

  // Undo / redo of page operations: Ctrl/Cmd+Z (undo), Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y (redo).
  // Only claimed when the host enabled page editing, so a viewer-only app leaves the browser default alone.
  {
    const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
    if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === 'z' || key === 'y')) {
      if (_viewer.opt.enablePageEditing) {
        if (key === 'y' || event.shiftKey) _viewer.redo(); else _viewer.undo();
        event.preventDefault();
        event.stopPropagation();
        _viewer.interactionCallback(event);
      }
      return;
    }
  }

  if (event.key === 'PageUp') {
    _viewer.displayPage(_viewer.state.cp.n - 1, true, false);
    event.preventDefault();
    return;
  }

  if (event.key === 'PageDown') {
    _viewer.displayPage(_viewer.state.cp.n + 1, true, false);
    event.preventDefault();
    return;
  }

  if (event.key === 'Tab') {
    if (event.shiftKey) {
      selectPrevWord(_viewer);
    } else {
      selectNextWord(_viewer);
    }
    event.preventDefault();
    event.stopPropagation();
    _viewer.interactionCallback(event);
    return;
  }

  if (event.key === 'ArrowRight' && !UiText.input && selectedWords.length > 0) {
    if (event.ctrlKey) {
      if (event.altKey) {
        modifySelectedWordBbox(_viewer, 'right', 1);
      } else {
        modifySelectedWordBbox(_viewer, 'left', 1);
      }
    } else {
      selectRightWord(_viewer, event.shiftKey);
    }

    event.preventDefault();
    event.stopPropagation();
    _viewer.interactionCallback(event);
    return;
  }

  if (event.ctrlKey && event.key === ' ' && !_viewer.textOverlayHidden) {
    _viewer.textOverlayHidden = true;
    // Hide every text/overlay group (both use the `scribe-group` class) to reveal the raster underneath.
    _viewer.zoomLayer.querySelectorAll('.scribe-group').forEach((g) => { /** @type {HTMLElement} */ (g).style.display = 'none'; });
    const opacityOrig = UiText.input ? UiText.input.style.opacity : '0.8';
    if (UiText.input) UiText.input.style.opacity = '0';
    event.preventDefault();
    event.stopPropagation();
    _viewer.interactionCallback(event);

    const handleKeyUp = (keyupEvent) => {
      if (keyupEvent.key === 'Control' || keyupEvent.key === ' ') {
        _viewer.zoomLayer.querySelectorAll('.scribe-group').forEach((g) => { /** @type {HTMLElement} */ (g).style.display = ''; });
        if (UiText.input) UiText.input.style.opacity = opacityOrig;
        document.removeEventListener('keyup', handleKeyUp);
        _viewer.textOverlayHidden = false;
      }
    };

    document.addEventListener('keyup', handleKeyUp);
    return;
  }

  if (event.key === 'ArrowLeft' && !UiText.input && selectedWords.length > 0) {
    if (event.ctrlKey) {
      if (event.altKey) {
        modifySelectedWordBbox(_viewer, 'right', -1);
      } else {
        modifySelectedWordBbox(_viewer, 'left', -1);
      }
    } else {
      selectLeftWord(_viewer, event.shiftKey);
    }
    event.preventDefault();
    event.stopPropagation();
    _viewer.interactionCallback(event);
    return;
  }

  if (event.key === 'ArrowUp' && selectedWords.length > 0) {
    selectAboveWord(_viewer);
    event.preventDefault();
    event.stopPropagation();
    _viewer.interactionCallback(event);
    return;
  }

  if (event.key === 'ArrowDown' && selectedWords.length > 0) {
    selectBelowWord(_viewer);
    event.preventDefault();
    event.stopPropagation();
    _viewer.interactionCallback(event);
    return;
  }

  if (event.key === 'Enter' && !UiText.input) {
    if (selectedWords.length !== 1) return;
    const selectedWord = selectedWords[0];
    const pos = event.altKey ? -1 : 0;
    UiText.addTextInput(selectedWord, pos);
    event.preventDefault();
    event.stopPropagation();
    _viewer.interactionCallback(event);
    return;
  }

  if (event.key === 'i' && event.ctrlKey && selectedWords.length > 0) {
    modifySelectedWordStyle(_viewer, {
      italic: !selectedWords[0].word.style.italic,
    });
    event.preventDefault();
    event.stopPropagation();
    _viewer.interactionCallback(event);
    return;
  }

  if (event.key === 'b' && event.ctrlKey && selectedWords.length > 0) {
    modifySelectedWordStyle(_viewer, {
      bold: !selectedWords[0].word.style.bold,
    });
    event.preventDefault();
    event.stopPropagation();
    _viewer.interactionCallback(event);
    return;
  }

  if (event.key === 'u' && event.ctrlKey && selectedWords.length > 0) {
    modifySelectedWordStyle(_viewer, {
      underline: !selectedWords[0].word.style.underline,
    });
    event.preventDefault();
    event.stopPropagation();
    _viewer.interactionCallback(event);
    return;
  }

  if (event.key === 'Delete' && event.ctrlKey) {
    deleteSelectedWord(_viewer);
    event.preventDefault();
    event.stopPropagation();
    _viewer.interactionCallback(event);
    return;
  }

  if (event.altKey && ['+', '=', '×'].includes(event.key) && !UiText.input && selectedWords.length > 0) {
    const fontSize = selectedWords[0].fontSize + 1;
    modifySelectedWordStyle(_viewer, {
      size: fontSize,
    });
    event.preventDefault();
    event.stopPropagation();
    _viewer.interactionCallback(event);
    return;
  }

  if (event.altKey && ['-', '_', '–'].includes(event.key) && !UiText.input && selectedWords.length > 0) {
    const fontSize = selectedWords[0].fontSize - 1;
    modifySelectedWordStyle(_viewer, {
      size: fontSize,
    });
    event.preventDefault();
    event.stopPropagation();
    _viewer.interactionCallback(event);
  }
}
