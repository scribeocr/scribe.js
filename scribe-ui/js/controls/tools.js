// Document interaction tools shared by the viewer and editor apps: text highlighting
// (toggle, color picker, comment icons), the upload drop zone, and the file-to-ScribeDoc loader.
import scribeLib from '../../../scribe.js';
import { makeIconButton } from './toolbar.js';
import { applyHighlight } from '../viewerHighlights.js';
import { filesFromDropEvent } from '../dragAndDrop.js';

const HIGHLIGHT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" height="20" width="20" viewBox="0 -960 960 960" fill="currentColor">
<path d="M280-320v-440q0-33 23.5-56.5T360-840q9 0 18 2t17 6l240 119q20 10 32.5 29.5T680-641v321H280Zm80-80h240v-241L360-760v360ZM160-120l22-65q8-25 29-40t47-15h444q26 0 47 15t29 40l22 65H160Zm200-280h240-240Z"/>
</svg>`;
// eslint-disable-next-line max-len
const HIGHLIGHT_CURSOR = 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' height=\'24\' width=\'24\' viewBox=\'0 -960 960 960\'%3E%3Cpath fill=\'white\' stroke=\'black\' stroke-width=\'30\' d=\'m268-212-56-56q-12-12-12-28.5t12-28.5l423-423q12-12 28.5-12t28.5 12l56 56q12 12 12 28.5T748-635L324-212q-11 11-28 11t-28-11Z\'/%3E%3C/svg%3E") 12 12, auto';

/**
 * Build the highlight tool: toggle button, optional color picker, overlay-word highlighting, highlighter cursor, and comment icons.
 * The toolbar DOM is built immediately; the selection/comment behaviors are wired by `installBehaviors()` after `scribe.init`.
 * @param {import('../../viewer.js').ScribeViewer} scribe
 * @param {HTMLElement} rootElem - The app's root element (for selection scope and cursor CSS).
 * @param {object} cfg
 * @param {string[]} cfg.colors - One or more hex colors.
 * @param {string} cfg.defaultColor - Initial color (must be in `colors`).
 * @param {string} cfg.rootClass - The app's root class (for scoping the cursor rule).
 * @returns {{
 *   highlightElem: HTMLSpanElement, colorContainer: ?HTMLSpanElement,
 *   getSelectedOverlayWords: () => Array<any>, updateCommentIcons: () => void,
 *   installBehaviors: () => (() => void)
 * }}
 */
export function createHighlightTool(scribe, rootElem, { colors, defaultColor, rootClass }) {
  let highlightMode = false;
  let highlightColor = defaultColor;
  /** @type {?HTMLStyleElement} */
  let cursorStyleElem = null;
  /** @type {?HTMLDivElement} */
  let commentTooltip = null;

  const highlightElem = makeIconButton('Highlight', HIGHLIGHT_SVG);

  /** Toggle the highlighter cursor on the overlay words when highlight mode is active. */
  function updateHighlightCursorStyle() {
    if (!cursorStyleElem) {
      cursorStyleElem = document.createElement('style');
      document.head.appendChild(cursorStyleElem);
    }
    cursorStyleElem.textContent = highlightMode
      ? `.${rootClass} .scribe-word { cursor: ${HIGHLIGHT_CURSOR} !important; }`
      : '';
  }

  /** KonvaOcrWord objects under the current browser text selection (via the HTML overlay). */
  function getSelectedOverlayWords() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return [];
    const range = sel.getRangeAt(0);
    const wordElems = rootElem.querySelectorAll('.scribe-word');
    const selectedIds = [];
    for (const elem of wordElems) {
      if (range.intersectsNode(elem)) selectedIds.push(elem.id);
    }
    if (selectedIds.length === 0) return [];
    const idSet = new Set(selectedIds);
    return scribe.getKonvaWords().filter((kw) => idSet.has(kw.word.id));
  }

  function applyToSelection() {
    const matchedWords = getSelectedOverlayWords();
    if (matchedWords.length === 0 || !highlightColor) return false;
    applyHighlight(scribe, matchedWords, scribe.state.cp.n, highlightColor, 0.5);
    window.getSelection()?.removeAllRanges();
    scribe.deleteHTMLOverlay();
    scribe.renderHTMLOverlay();
    return true;
  }

  highlightElem.addEventListener('click', () => {
    highlightMode = !highlightMode;
    highlightElem.classList.toggle('active', highlightMode);
    updateHighlightCursorStyle();
  });

  // Color picker. `makeColorBtn` is defined once (not in the loop) so its click closure
  // captures only `color` (a per-call param) plus stable module-scoped state.
  const colorBtnElems = [];
  /** @param {string} color @returns {HTMLSpanElement} */
  const makeColorBtn = (color) => {
    const btn = document.createElement('span');
    btn.className = 'highlight-color-btn';
    btn.style.backgroundColor = color;
    if (color === highlightColor) btn.classList.add('active');
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      highlightColor = color;
      colorBtnElems.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      if (!applyToSelection() && !highlightMode) {
        highlightMode = true;
        highlightElem.classList.add('active');
        updateHighlightCursorStyle();
      }
    });
    return btn;
  };

  /** @type {?HTMLSpanElement} */
  let colorContainer = null;
  if (colors.length > 1) {
    colorContainer = document.createElement('span');
    colorContainer.style.display = 'inline-flex';
    colorContainer.style.alignItems = 'center';
    colorContainer.style.gap = '4px';
    colorContainer.style.marginLeft = '4px';
    for (const color of colors) {
      const btn = makeColorBtn(color);
      colorBtnElems.push(btn);
      colorContainer.appendChild(btn);
    }
  }

  /** Place one comment icon for a highlight group, anchored at its first word's overlay element. */
  const addCommentIcon = (kw, viewerElem) => {
    const wordElem = viewerElem.querySelector(`.scribe-word[id="${kw.word.id}"]`);
    if (!wordElem) return;
    const wordLeft = parseFloat(/** @type {HTMLElement} */ (wordElem).style.left) || 0;
    const wordTop = parseFloat(/** @type {HTMLElement} */ (wordElem).style.top) || 0;

    const icon = document.createElement('span');
    icon.className = 'highlight-comment-icon';
    icon.textContent = '💬';
    icon.style.left = `${wordLeft - 16}px`;
    icon.style.top = `${wordTop - 14}px`;

    icon.addEventListener('mouseover', () => {
      if (!commentTooltip) return;
      commentTooltip.textContent = kw.highlightComment;
      commentTooltip.style.visibility = 'hidden';
      commentTooltip.style.display = '';
      const iconLeft = parseFloat(icon.style.left) || 0;
      const iconTop = parseFloat(icon.style.top) || 0;
      commentTooltip.style.left = `${iconLeft}px`;
      commentTooltip.style.top = `${iconTop - commentTooltip.offsetHeight - 4}px`;
      commentTooltip.style.visibility = '';
    });
    icon.addEventListener('mouseout', () => {
      if (commentTooltip) commentTooltip.style.display = 'none';
    });

    viewerElem.appendChild(icon);
  };

  /** Rebuild the comment icons: one per highlight group that carries a comment. */
  function updateCommentIcons() {
    const viewerElem = scribe.elem;
    if (!viewerElem) return;
    viewerElem.querySelectorAll('.highlight-comment-icon').forEach((el) => el.remove());

    const allWords = scribe.getKonvaWords();
    if (!allWords || allWords.length === 0) return;

    const groupFirstWord = new Map();
    for (const kw of allWords) {
      if (!kw.highlightGroupId || !kw.highlightComment) continue;
      const existing = groupFirstWord.get(kw.highlightGroupId);
      if (!existing
        || kw.word.bbox.top < existing.word.bbox.top
        || (kw.word.bbox.top === existing.word.bbox.top && kw.word.bbox.left < existing.word.bbox.left)) {
        groupFirstWord.set(kw.highlightGroupId, kw);
      }
    }

    for (const [, kw] of groupFirstWord) addCommentIcon(kw, viewerElem);
  }

  /**
   * Wire the selection-driven highlighting, comment tooltip, and overlay observer.
   * Call after `scribe.init` (needs `scribe.elem`).
   * @returns {() => void} teardown
   */
  function installBehaviors() {
    const mouseupHandler = (event) => {
      if (!highlightMode) return;
      if (!(event.target instanceof Node) || !rootElem.contains(event.target)) return;
      applyToSelection();
    };
    document.addEventListener('mouseup', mouseupHandler);

    commentTooltip = document.createElement('div');
    commentTooltip.className = 'highlight-comment-tooltip';
    commentTooltip.style.display = 'none';
    scribe.elem.appendChild(commentTooltip);

    let commentIconTimer = null;
    const isWordOrLine = (n) => n instanceof HTMLElement
      && (n.classList.contains('scribe-word') || n.classList.contains('scribe-line'));
    const commentObserver = new MutationObserver((mutations) => {
      const hasRemoved = mutations.some((m) => [...m.removedNodes].some(isWordOrLine));
      if (hasRemoved) {
        scribe.elem?.querySelectorAll('.highlight-comment-icon').forEach((el) => el.remove());
        commentTooltip.style.display = 'none';
      }
      const hasAdded = mutations.some((m) => [...m.addedNodes].some(isWordOrLine));
      if (!hasAdded) return;
      if (commentIconTimer) clearTimeout(commentIconTimer);
      commentIconTimer = setTimeout(() => updateCommentIcons(), 100);
    });
    commentObserver.observe(scribe.elem, { childList: true });

    return () => {
      document.removeEventListener('mouseup', mouseupHandler);
      commentObserver.disconnect();
      if (commentTooltip && commentTooltip.parentNode) commentTooltip.parentNode.removeChild(commentTooltip);
      commentTooltip = null;
      if (cursorStyleElem) {
        cursorStyleElem.remove();
        cursorStyleElem = null;
      }
    };
  }

  return {
    highlightElem,
    colorContainer,
    getSelectedOverlayWords,
    updateCommentIcons,
    installBehaviors,
  };
}

/**
 * Build the upload drop zone overlay.
 * @param {object} cfg
 * @param {number} cfg.width - Zone width in px.
 * @param {number} cfg.height - Zone height in px.
 * @param {number} cfg.top - Zone top offset in px (below the toolbar).
 * @param {(files: File[]) => void} cfg.onFiles - Called with all chosen/dropped files.
 * @returns {{ dropZone: HTMLDivElement, openFileInputElem: HTMLInputElement }}
 */
export function createDropZone({
  width, height, top, onFiles,
}) {
  const dropZone = document.createElement('div');
  dropZone.className = 'scribe-drop-zone';
  dropZone.style.zIndex = '8';
  dropZone.style.top = `${top}px`;
  dropZone.style.position = 'absolute';
  dropZone.style.height = `${height}px`;
  dropZone.style.width = `${width}px`;

  const icon = document.createElement('div');
  icon.className = 'scribe-drop-icon';
  icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';

  const title = document.createElement('div');
  title.className = 'scribe-drop-title';
  title.textContent = 'Drop a PDF to get started';

  // Hidden native input wrapped by the styled label, so clicking "Choose file" opens the picker.
  const openFileInputElem = document.createElement('input');
  openFileInputElem.type = 'file';
  openFileInputElem.multiple = true;
  openFileInputElem.style.display = 'none';

  const button = document.createElement('label');
  button.className = 'scribe-drop-btn';
  button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M3 7h6l2 2h10v9a2 2 0 0 1-2 2H3z"/></svg><span>Choose file</span>';
  button.appendChild(openFileInputElem);

  const hint = document.createElement('div');
  hint.className = 'scribe-drop-hint';
  hint.textContent = 'or drag a file anywhere';

  const content = document.createElement('div');
  content.className = 'scribe-drop-content';
  content.append(icon, title, button, hint);

  const region = document.createElement('div');
  region.className = 'scribe-drop-region';
  region.appendChild(content);
  dropZone.appendChild(region);

  openFileInputElem.addEventListener('change', () => {
    if (!openFileInputElem.files || openFileInputElem.files.length === 0) return;
    onFiles([...openFileInputElem.files]);
  });

  // Drag-enter/leave can fire repeatedly over child nodes; a counter keeps the highlight stable.
  let highlightActiveCt = 0;
  dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropZone.classList.add('highlight');
    highlightActiveCt++;
  });

  dropZone.addEventListener('dragleave', (event) => {
    event.preventDefault();
    const highlightActiveCtNow = highlightActiveCt;
    setTimeout(() => {
      if (highlightActiveCtNow === highlightActiveCt) dropZone.classList.remove('highlight');
    }, 100);
  });

  dropZone.addEventListener('drop', async (event) => {
    event.preventDefault();
    const files = await filesFromDropEvent(event);
    if (files.length === 0) return;
    dropZone.classList.remove('highlight');
    onFiles(files);
  });

  return { dropZone, openFileInputElem };
}

/**
 * Open a `ScribeDoc` from any supported input. Raw byte inputs (`ArrayBuffer`, `Uint8Array`,
 * non-`File` `Blob`) are treated as PDFs; `File` and path strings are sorted by extension.
 * @param {File | Blob | ArrayBuffer | Uint8Array | string} file
 * @returns {Promise<import('../../../js/containers/scribeDoc.js').ScribeDoc>}
 */
export async function openDocumentFromFile(file) {
  /** @type {Parameters<typeof scribeLib.openDocument>[0]} */
  let input;
  if (file instanceof ArrayBuffer) {
    input = { pdfFiles: [file] };
  } else if (typeof Uint8Array !== 'undefined' && file instanceof Uint8Array) {
    const ab = /** @type {ArrayBuffer} */ (file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
    input = { pdfFiles: [ab] };
  } else if (typeof File !== 'undefined' && file instanceof File) {
    input = [file];
  } else if (typeof Blob !== 'undefined' && file instanceof Blob) {
    input = { pdfFiles: [await file.arrayBuffer()] };
  } else if (typeof file === 'string') {
    input = [file];
  } else {
    throw new Error('openDocumentFromFile: input must be File, Blob, ArrayBuffer, Uint8Array, or a filesystem path string.');
  }

  const doc = await scribeLib.openDocument(input);

  // A pure viewer never runs recognize(), the step that would otherwise populate an image-based PDF's active (selectable) text layer.
  // So when nothing else has filled that layer, fall back to the PDF's own parsed text,
  // carrying over each page's deskew angle so the overlay aligns.
  if (doc.ocr.pdf && !doc.ocr.active.some(Boolean)) {
    doc.ocr.active = doc.ocr.pdf;
    for (let i = 0; i < doc.ocr.pdf.length; i++) {
      if (doc.ocr.pdf[i] && doc.pageMetrics[i]) doc.pageMetrics[i].angle = doc.ocr.pdf[i].angle;
    }
  }
  return doc;
}
