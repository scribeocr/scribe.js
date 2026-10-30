// eslint-disable-next-line import/no-cycle
import { ScribeViewer } from '../viewer.js';
import scribe from '../../scribe.js';
import { UiText, UiOcrWord } from './viewerWordObjects.js';
import { readingsListKey } from './viewerReadings.js';
import { IS_MAC } from './platform.js';
import {
  deleteSelectedWord, modifySelectedWordBbox, modifySelectedWordStyle,
} from './viewerModifySelectedWords.js';

/**
 * Bring a stepped-to word into view without ever scrolling back toward the word the step left.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {UiOcrWord} kw
 * @param {?UiOcrWord} [from] - The word the step leaves, or null when nothing was selected.
 */
const scrollIntoView = (viewer, kw, from = null) => {
  // Words on one line differ in height, so a difference smaller than a word's height is no travel at all.
  let travel = 0;
  if (from && !from._destroyed) {
    const a = from.getClientRect();
    const b = kw.getClientRect();
    const dy = (b.y + b.height / 2) - (a.y + a.height / 2);
    if (Math.abs(dy) >= Math.min(a.height, b.height)) travel = Math.sign(dy);
  }
  if (viewer.proofFollow) { viewer.proofFollow(kw, travel); return; }
  viewer.scrollToWord(kw, { glide: true, ifNeeded: true, travel });
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
    scrollIntoView(_viewer, nextUiWord, selectedWord);
    _viewer.CanvasSelection.addWords(nextUiWord);
    UiOcrWord.addControls(nextUiWord);
    nextUiWord.select();
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
    scrollIntoView(_viewer, prevUiWord, selectedWord);
    _viewer.CanvasSelection.addWords(prevUiWord);
    UiOcrWord.addControls(prevUiWord);
    prevUiWord.select();
    UiOcrWord.updateUI();
  }
}

/**
 * The words still to check in proofreading, in reading order across the document.
 * A word is still to check while its confidence is at or below the high threshold.
 * @param {import('../../js/containers/scribeDoc.js').ScribeDoc} doc
 * @returns {Array<OcrWord>}
 */
export function wordsToCheck(doc) {
  const thresh = scribe.ScribeDoc.defaults.confThreshHigh;
  /** @type {Array<OcrWord>} */
  const words = [];
  for (const page of doc.ocr.active || []) {
    if (!page) continue;
    for (const line of page.lines) {
      for (const word of line.words) if (word.text && word.conf <= thresh) words.push(word);
    }
  }
  return words;
}

/**
 * Select the next or previous word to check.
 * The search starts from the selected word, or from the current page when nothing is selected, and wraps at the ends.
 * A target on another page shows that page first.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {1|-1} dir
 */
export async function selectNextToCheck(viewer, dir) {
  const _viewer = viewer || ScribeViewer.getDefault();
  if (!_viewer.doc) return;
  const queue = wordsToCheck(_viewer.doc);
  if (queue.length === 0) return;
  const selected = _viewer.CanvasSelection.getUiWords();
  // Taken before the deselect below empties the selection's own array.
  const from = selected.length === 1 ? selected[0] : null;
  const cur = from ? from.word : null;
  /** @param {OcrWord} w */
  const place = (w) => [w.line.page.n, w.line.page.lines.indexOf(w.line), w.line.words.indexOf(w)];
  /** @param {OcrWord} a @param {OcrWord} b */
  const cmp = (a, b) => { const x = place(a); const y = place(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };
  let target;
  if (cur && queue.includes(cur)) {
    target = queue[(queue.indexOf(cur) + dir + queue.length) % queue.length];
  } else if (cur) {
    target = dir > 0 ? (queue.find((w) => cmp(w, cur) > 0) || queue[0]) : (queue.slice().reverse().find((w) => cmp(w, cur) < 0) || queue[queue.length - 1]);
  } else {
    const n = _viewer.state.cp.n;
    target = dir > 0 ? (queue.find((w) => w.line.page.n >= n) || queue[0]) : (queue.slice().reverse().find((w) => w.line.page.n <= n) || queue[queue.length - 1]);
  }
  const n = target.line.page.n;
  if (n !== _viewer.state.cp.n) await _viewer.displayPage(n, true, false);
  const ui = _viewer.getUiWords().find((x) => x.word === target);
  if (!ui) return;
  _viewer.destroyControls(true);
  scrollIntoView(_viewer, ui, from);
  _viewer.CanvasSelection.addWords(ui);
  UiOcrWord.addControls(ui);
  ui.select();
  UiOcrWord.updateUI();
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
    scrollIntoView(_viewer, nextUiWord, selectedWord);
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
    scrollIntoView(_viewer, nextUiWord, selectedWord);
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
    scrollIntoView(_viewer, aboveUiWord, selectedWord);
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
    scrollIntoView(_viewer, belowUiWord, selectedWord);
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
  // The scan peek is Ctrl+Space, plus Option+Space on a Mac, where macOS claims Ctrl+Space for switching input sources.
  // Alt+Space stays unbound on other platforms, where Windows opens the window menu on it.
  // With Option held a Mac reports the key as a non-breaking space, so the physical key is checked too.
  const peekChord = (event.ctrlKey || (IS_MAC && event.altKey))
    && (event.code === 'Space' || event.key === ' ' || event.key === '\u00a0');
  // Never steal keystrokes destined for a text-editing control: a host `<input>`/`<textarea>`,
  // a `contenteditable` host, or the viewer's own word-edit box, so typing there is unaffected.
  // The peek chord is the one exception, in the word-edit box only, since on a Mac it would otherwise type a non-breaking space into the word.
  if (activeElem && !(peekChord && activeElem === UiText.input) && (activeElem instanceof HTMLInputElement
    || activeElem instanceof HTMLTextAreaElement
    || activeElem.isContentEditable)) return;
  if (activeElem && activeElem instanceof HTMLSelectElement
    && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter'].includes(event.key)) return;

  const selectedWords = _viewer.CanvasSelection.getUiWords();

  // The modifier keys change what `event.key` is for the same button.
  // `+` becomes `=` when shift is pressed, and `×` when control and alt are pressed.
  if ((event.ctrlKey || event.metaKey) && !event.altKey && ['+', '=', '×'].includes(event.key)) {
    _viewer.zoom(1.1);
    event.preventDefault();
    event.stopPropagation();
    _viewer.interactionCallback(event);
    return;
  }

  if ((event.ctrlKey || event.metaKey) && !event.altKey && ['-', '_', '–'].includes(event.key)) {
    _viewer.zoom(0.9);
    event.preventDefault();
    event.stopPropagation();
    _viewer.interactionCallback(event);
    return;
  }

  // A viewer-only app with nothing recorded leaves Ctrl+Z to the browser, so the host page's own undo still works.
  {
    const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
    if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === 'z' || key === 'y')) {
      const history = _viewer.doc?.docHistory;
      if (_viewer.opt.enablePageEditing || (history && (history.canUndo || history.canRedo))) {
        if (key === 'y' || event.shiftKey) _viewer.redo(); else _viewer.undo();
        event.preventDefault();
        event.stopPropagation();
        _viewer.interactionCallback(event);
      }
      return;
    }
  }

  // Proof mode's readings list takes a digit (apply that reading) or Escape (hide it) while it is showing.
  if (readingsListKey(_viewer, event)) {
    event.preventDefault();
    event.stopPropagation();
    _viewer.interactionCallback(event);
    return;
  }

  if (event.key === 'PageUp') {
    _viewer.displayPage(_viewer.rowStep(_viewer.state.cp.n, -1), true, false);
    event.preventDefault();
    return;
  }

  if (event.key === 'PageDown') {
    _viewer.displayPage(_viewer.rowStep(_viewer.state.cp.n, 1), true, false);
    event.preventDefault();
    return;
  }

  // With no words selected, arrows pan the view; with a selection they drive the word move/resize verbs below.
  // In the table preview the arrows belong to the cell selection instead, handled by the tool itself.
  if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
    && !UiText.input && selectedWords.length === 0 && !_viewer.state.tablePreview
    && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
    const step = 40;
    let deltaX = 0;
    let deltaY = 0;
    if (event.key === 'ArrowLeft') deltaX = step;
    else if (event.key === 'ArrowRight') deltaX = -step;
    else if (event.key === 'ArrowUp') deltaY = step;
    else deltaY = -step;
    _viewer.pan({ deltaX, deltaY });
    event.preventDefault();
    return;
  }

  if (event.key === 'Tab') {
    if (activeElem && activeElem.closest('.scribe-field')) return;
    if (UiText.enableEditing) {
      selectNextToCheck(_viewer, event.shiftKey ? -1 : 1);
    } else if (event.shiftKey) {
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
    if (event.ctrlKey || event.metaKey) {
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

  if (peekChord) {
    event.preventDefault();
    event.stopPropagation();
    // A held chord repeats its keydown, which must neither restart the peek nor type into the word.
    if (_viewer.textOverlayHidden) return;
    _viewer.textOverlayHidden = true;
    // Hide every text/overlay group (both use the `scribe-group` class) to reveal the raster underneath.
    _viewer.zoomLayer.querySelectorAll('.scribe-group').forEach((g) => { /** @type {HTMLElement} */ (g).style.display = 'none'; });
    if (_viewer.proofTextOnly) _viewer.elem.classList.add('scribe-proof-peek');
    const opacityOrig = UiText.input ? UiText.input.style.opacity : '0.8';
    if (UiText.input) UiText.input.style.opacity = '0';
    // Hiding the text layer blurs the word-edit box inside it, so the box gets its focus and caret back on release.
    const editBox = activeElem && activeElem === UiText.input ? activeElem : null;
    const sel = window.getSelection();
    const caret = editBox && sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
    _viewer.interactionCallback(event);

    const handleKeyUp = (keyupEvent) => {
      if (['Control', 'Alt', ' ', '\u00a0'].includes(keyupEvent.key) || keyupEvent.code === 'Space') {
        _viewer.zoomLayer.querySelectorAll('.scribe-group').forEach((g) => { /** @type {HTMLElement} */ (g).style.display = ''; });
        _viewer.elem.classList.remove('scribe-proof-peek');
        if (UiText.input) UiText.input.style.opacity = opacityOrig;
        if (editBox && editBox === UiText.input && editBox.isConnected) {
          editBox.focus({ preventScroll: true });
          if (caret && sel) {
            sel.removeAllRanges();
            sel.addRange(caret);
          }
        }
        document.removeEventListener('keyup', handleKeyUp);
        _viewer.textOverlayHidden = false;
      }
    };

    document.addEventListener('keyup', handleKeyUp);
    return;
  }

  if (event.key === 'ArrowLeft' && !UiText.input && selectedWords.length > 0) {
    if (event.ctrlKey || event.metaKey) {
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

  if (event.key === 'i' && (event.ctrlKey || event.metaKey) && selectedWords.length > 0) {
    modifySelectedWordStyle(_viewer, {
      italic: !selectedWords[0].word.style.italic,
    });
    event.preventDefault();
    event.stopPropagation();
    _viewer.interactionCallback(event);
    return;
  }

  if (event.key === 'b' && (event.ctrlKey || event.metaKey) && selectedWords.length > 0) {
    modifySelectedWordStyle(_viewer, {
      bold: !selectedWords[0].word.style.bold,
    });
    event.preventDefault();
    event.stopPropagation();
    _viewer.interactionCallback(event);
    return;
  }

  if (event.key === 'u' && (event.ctrlKey || event.metaKey) && selectedWords.length > 0) {
    modifySelectedWordStyle(_viewer, {
      underline: !selectedWords[0].word.style.underline,
    });
    event.preventDefault();
    event.stopPropagation();
    _viewer.interactionCallback(event);
    return;
  }

  // A Mac keyboard's Delete key reports Backspace.
  // On other platforms Backspace is excluded because the deletion cannot be undone.
  if ((event.key === 'Delete' || (IS_MAC && event.key === 'Backspace')) && selectedWords.length > 0) {
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
