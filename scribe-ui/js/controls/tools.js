// Document interaction tools shared by the viewer and editor apps: text highlighting
// (toggle, color picker, comment icons), the upload drop zone, and the file-to-ScribeDoc loader.
import scribeLib from '../../../scribe.js';
import { makeIconButton } from './toolbar.js';
import { applyHighlight } from '../viewerHighlights.js';
import { createNote, focusNoteEditor } from '../viewerNotes.js';
import { filesFromDropEvent } from '../dragAndDrop.js';

// Filled highlighter-marker glyph (Material).
// The head path (`.scribe-hl-tip`) is filled with the selected highlight color to preview the active swatch (see `setTipColor`), while the base bar underneath stays the default ink color.
const HIGHLIGHT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" height="20" width="20" viewBox="0 -960 960 960" fill="currentColor">
<path class="scribe-hl-tip" d="M280-320v-440q0-33 23.5-56.5T360-840q9 0 18 2t17 6l240 119q20 10 32.5 29.5T680-641v321H280Z"/>
<path d="M160-120l22-65q8-25 29-40t47-15h444q26 0 47 15t29 40l22 65H160Z"/>
</svg>`;
// eslint-disable-next-line max-len
const HIGHLIGHT_CURSOR = 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' height=\'24\' width=\'24\' viewBox=\'0 -960 960 960\'%3E%3Cpath fill=\'white\' stroke=\'black\' stroke-width=\'30\' d=\'m268-212-56-56q-12-12-12-28.5t12-28.5l423-423q12-12 28.5-12t28.5 12l56 56q12 12 12 28.5T748-635L324-212q-11 11-28 11t-28-11Z\'/%3E%3C/svg%3E") 12 12, auto';
// Placed raw at 11px without a `.cr-icon` wrapper, so it needs its own inline size and a heavier 2.2 stroke to stay crisp that small.
// eslint-disable-next-line max-len
const HIGHLIGHT_CARET_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="display:block;width:11px;height:11px;pointer-events:none;" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

/**
 * Build the highlight tool: toggle button, optional color picker, overlay-word highlighting, highlighter cursor, and comment icons.
 * The toolbar DOM is built immediately. The selection/comment behaviors are wired by `installBehaviors()` after `scribe.init`.
 * @param {import('../../viewer.js').ScribeViewer} scribe
 * @param {HTMLElement} rootElem - The app's root element (for selection scope and cursor CSS).
 * @param {object} cfg
 * @param {string[]} cfg.colors - One or more hex colors.
 * @param {string} cfg.defaultColor - Initial color (must be in `colors`).
 * @param {string} cfg.rootClass - The app's root class (for scoping the cursor rule).
 * @returns {{
 *   highlightElem: HTMLSpanElement, toolbarElem: HTMLSpanElement,
 *   getSelectedOverlayWords: () => Array<import('../viewerWordObjects.js').UiOcrWord>, updateCommentIcons: () => void,
 *   installBehaviors: () => (() => void)
 * }}
 */
export function createHighlightTool(scribe, rootElem, { colors, defaultColor, rootClass }) {
  let highlightMode = false;
  let highlightColor = defaultColor;
  // Expose the active color to the core viewer so its right-click "Highlight" item can use it (see viewer._highlightColor).
  scribe._highlightColor = highlightColor;
  /** @type {?HTMLStyleElement} */
  let cursorStyleElem = null;
  /** @type {?HTMLDivElement} */
  let commentTooltip = null;
  /**
   * Opens the editable comment popover for a highlight group, anchored to `words[0]`.
   * Assigned by `installBehaviors`.
   * Called from the comment icon and (via `scribe._openCommentEditor`) the context menu.
   * @type {?(words: Array<import('../viewerWordObjects.js').UiOcrWord>, pageIndex: number) => void}
   */
  let openCommentEditor = null;

  const highlightElem = makeIconButton('Highlight', HIGHLIGHT_SVG);
  const tipPath = highlightElem.querySelector('.scribe-hl-tip');
  const setTipColor = (c) => { if (tipPath && c) tipPath.style.fill = c; };
  setTipColor(highlightColor);

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

  /** UiOcrWord objects under the current browser text selection (via the HTML overlay). */
  function getSelectedOverlayWords() {
    return scribe.getWordsUnderTextSelection();
  }

  function applyToSelection() {
    const matchedWords = getSelectedOverlayWords();
    if (matchedWords.length === 0 || !highlightColor) return false;
    applyHighlight(scribe, matchedWords, scribe.state.cp.n, highlightColor, 0.5);
    window.getSelection()?.removeAllRanges();
    return true;
  }

  highlightElem.addEventListener('click', () => {
    if (applyToSelection()) return;
    highlightMode = !highlightMode;
    highlightElem.classList.toggle('active', highlightMode);
    updateHighlightCursorStyle();
  });

  // Color-picker swatches and the popover that holds them, plus the factory that builds each swatch button.
  const colorBtnElems = [];
  /** @type {?HTMLSpanElement} */ let paletteElem = null;
  /** @type {?HTMLSpanElement} */ let caretElem = null;
  const closePalette = () => {
    if (paletteElem) paletteElem.classList.remove('open');
    if (caretElem) caretElem.classList.remove('active');
  };
  /** @param {string} color @returns {HTMLSpanElement} */
  const makeColorBtn = (color) => {
    const btn = document.createElement('span');
    btn.className = 'highlight-color-btn';
    btn.style.backgroundColor = color;
    if (color === highlightColor) btn.classList.add('active');
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      highlightColor = color;
      scribe._highlightColor = color;
      setTipColor(color);
      colorBtnElems.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      closePalette();
      // Choosing a color highlights the current selection if there is one, but never arms paint mode on its own (only the marker does that).
      applyToSelection();
    });
    return btn;
  };

  // The element placed in the toolbar: the split control when there is a palette, otherwise the bare marker.
  /** @type {HTMLSpanElement} */
  let toolbarElem = highlightElem;
  if (colors.length > 1) {
    const split = document.createElement('span');
    split.className = 'scribe-hl-split';
    highlightElem.classList.add('scribe-hl-mark');

    paletteElem = document.createElement('span');
    paletteElem.className = 'scribe-hl-pop';
    for (const color of colors) {
      const btn = makeColorBtn(color);
      colorBtnElems.push(btn);
      paletteElem.appendChild(btn);
    }

    // A slim caret (not a full icon button) so the dropdown half stays visually subordinate to the marker.
    caretElem = document.createElement('span');
    caretElem.className = 'cr-icon-button scribe-hl-caret';
    caretElem.title = 'Highlight color';
    caretElem.role = 'button';
    caretElem.tabIndex = 0;
    caretElem.ariaLabel = 'Choose highlight color';
    caretElem.innerHTML = HIGHLIGHT_CARET_SVG;
    caretElem.addEventListener('mousedown', (e) => e.preventDefault());
    caretElem.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = !paletteElem.classList.contains('open');
      paletteElem.classList.toggle('open', willOpen);
      caretElem.classList.toggle('active', willOpen);
    });

    split.append(highlightElem, caretElem, paletteElem);
    toolbarElem = split;
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
    icon.addEventListener('click', (e) => {
      e.stopPropagation();
      if (openCommentEditor) openCommentEditor([kw], kw.word.line.page.n);
    });

    viewerElem.appendChild(icon);
  };

  /** Rebuild the comment icons: one per highlight group that carries a comment. */
  function updateCommentIcons() {
    const viewerElem = scribe.elem;
    if (!viewerElem) return;
    viewerElem.querySelectorAll('.highlight-comment-icon').forEach((el) => el.remove());

    const allWords = scribe.getUiWords();
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

    // Close the color palette on an outside click or Escape (only wired when the split button built a palette).
    const paletteOutsideClick = (event) => {
      if (!paletteElem || !paletteElem.classList.contains('open')) return;
      const t = event.target;
      if (t instanceof Node && (paletteElem.contains(t) || (caretElem && caretElem.contains(t)))) return;
      closePalette();
    };
    const paletteKeydown = (event) => { if (event.key === 'Escape') closePalette(); };
    if (paletteElem) {
      document.addEventListener('click', paletteOutsideClick);
      document.addEventListener('keydown', paletteKeydown);
    }

    commentTooltip = document.createElement('div');
    commentTooltip.className = 'highlight-comment-tooltip';
    commentTooltip.style.display = 'none';
    scribe.elem.appendChild(commentTooltip);

    // Editable comment popover, shared by highlight comments and freestanding notes.
    // A generic `showEditor` drives it for either target, differing only in the save/delete callbacks.
    // Mounted on the unzoomed outer element and positioned from the anchor's screen rect, so it lands correctly at any zoom.
    const commentEditor = document.createElement('div');
    commentEditor.className = 'scribe-comment-editor';
    commentEditor.style.display = 'none';
    const editorText = document.createElement('textarea');
    editorText.className = 'scribe-comment-editor-text';
    editorText.rows = 3;
    editorText.placeholder = 'Add a comment…';
    const editorMeta = document.createElement('div');
    editorMeta.className = 'scribe-comment-editor-meta';
    const editorBtns = document.createElement('div');
    editorBtns.className = 'scribe-comment-editor-btns';
    const editorDelete = document.createElement('button');
    editorDelete.type = 'button';
    editorDelete.className = 'scribe-comment-editor-delete';
    editorDelete.textContent = 'Delete';
    const editorSave = document.createElement('button');
    editorSave.type = 'button';
    editorSave.className = 'scribe-comment-editor-save';
    editorSave.textContent = 'Save';
    editorBtns.append(editorDelete, editorSave);
    commentEditor.append(editorText, editorMeta, editorBtns);
    // Keep interactions inside the editor from reaching the outside-click closer.
    commentEditor.addEventListener('mousedown', (e) => e.stopPropagation());
    const editorHost = scribe.outerElem || scribe.elem;
    editorHost.appendChild(commentEditor);

    /** @type {?(v: string) => void} */ let editorOnSave = null;
    /** @type {?() => void} */ let editorOnDelete = null;
    const closeCommentEditor = () => {
      commentEditor.style.display = 'none';
      editorOnSave = null;
      editorOnDelete = null;
    };
    const metaLine = (annot) => {
      const parts = [];
      if (annot && annot.author) parts.push(annot.author);
      if (annot && annot.createdAt) parts.push(new Date(annot.createdAt).toLocaleString());
      return parts.join(' · ');
    };

    /**
     * Open the popover anchored above `anchorEl`, prefilled with `text` + `meta`.
     * @param {{ text: string, meta: string, anchorEl: ?Element, onSave: (v: string) => void, onDelete: () => void }} d
     */
    const showEditor = (d) => {
      editorText.value = d.text || '';
      editorMeta.textContent = d.meta || '';
      editorMeta.style.display = d.meta ? '' : 'none';
      editorOnSave = d.onSave;
      editorOnDelete = d.onDelete;
      if (commentTooltip) commentTooltip.style.display = 'none';
      commentEditor.style.display = '';
      if (d.anchorEl) {
        const a = d.anchorEl.getBoundingClientRect();
        const h = editorHost.getBoundingClientRect();
        commentEditor.style.left = `${a.left - h.left}px`;
        commentEditor.style.top = `${a.top - h.top - commentEditor.offsetHeight - 8}px`;
      }
      editorText.focus();
      editorText.select();
    };

    openCommentEditor = (words, pageIndex) => {
      if (!words || words.length === 0) return;
      const first = words[0];
      const annot = (scribe.doc.annotations.pages[pageIndex] || []).find(
        (a) => a.groupId && a.groupId === first.highlightGroupId,
      );
      showEditor({
        text: first.highlightComment || '',
        meta: metaLine(annot),
        anchorEl: scribe.elem.querySelector(`.scribe-word[id="${first.word.id}"]`),
        onSave: (v) => scribe.modifyHighlightComment(words, pageIndex, v),
        onDelete: () => scribe.modifyHighlightComment(words, pageIndex, ''),
      });
    };
    scribe._openCommentEditor = openCommentEditor;
    // Let other surfaces (the Comments panel) refresh the on-page comment icons after editing a comment.
    scribe._updateCommentIcons = updateCommentIcons;
    // A freestanding note is edited inline in its margin card, so opening its editor just places the cursor there.
    scribe._openNoteEditor = (annot, pageIndex) => focusNoteEditor(scribe, pageIndex, annot);

    editorSave.addEventListener('click', () => {
      if (editorOnSave) editorOnSave(editorText.value.trim());
      closeCommentEditor();
      updateCommentIcons();
    });
    editorDelete.addEventListener('click', () => {
      if (editorOnDelete) editorOnDelete();
      closeCommentEditor();
      updateCommentIcons();
    });
    editorText.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeCommentEditor(); } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); editorSave.click(); }
    });
    const editorOutsideClick = (event) => {
      if (commentEditor.style.display === 'none') return;
      const t = event.target;
      if (t instanceof Node && commentEditor.contains(t)) return;
      closeCommentEditor();
    };
    document.addEventListener('mousedown', editorOutsideClick);

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
      if (paletteElem) {
        document.removeEventListener('click', paletteOutsideClick);
        document.removeEventListener('keydown', paletteKeydown);
      }
      commentObserver.disconnect();
      document.removeEventListener('mousedown', editorOutsideClick);
      if (commentEditor.parentNode) commentEditor.parentNode.removeChild(commentEditor);
      scribe._openCommentEditor = null;
      scribe._openNoteEditor = null;
      scribe._updateCommentIcons = null;
      openCommentEditor = null;
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
    toolbarElem,
    getSelectedOverlayWords,
    updateCommentIcons,
    installBehaviors,
  };
}

// A speech-bubble-with-plus glyph for the note tool.
// eslint-disable-next-line max-len
const NOTE_TOOL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" height="20" width="20" viewBox="0 0 24 24" fill="currentColor"><path d="M4 3h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9l-4 4v-4H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm7 3v3H8v2h3v3h2v-3h3V9h-3V6h-2z"/></svg>';

/**
 * Build the freestanding-note tool: a toolbar button that drops a note at the top-right of the current page and puts the cursor in its inline editor.
 * The user drags the note's mark to reposition it rather than clicking to place it.
 * @param {import('../../viewer.js').ScribeViewer} scribe
 * @returns {{ toolbarElem: HTMLSpanElement, installBehaviors: () => (() => void) }}
 */
export function createNoteTool(scribe) {
  const toolbarElem = makeIconButton('Add note', NOTE_TOOL_SVG);

  toolbarElem.addEventListener('click', () => {
    const n = scribe.state?.cp?.n ?? 0;
    const pm = scribe.doc.pageMetrics[n];
    if (!pm) return;
    // Place the mark at the top-right of the page, clear of the edge, so the card renders in the right margin.
    const x = Math.max(0, pm.dims.width - 46);
    const annot = createNote(scribe, n, x, 22);
    scribe.renderNotes(n);
    focusNoteEditor(scribe, n, annot);
  });

  // Placement is immediate, so there are no page-level behaviors to install.
  function installBehaviors() { return () => {}; }

  return { toolbarElem, installBehaviors };
}

/**
 * Build the upload drop zone overlay.
 * @param {object} cfg
 * @param {number} cfg.width - Zone width in px.
 * @param {number} cfg.height - Zone height in px.
 * @param {number} cfg.top - Zone top offset in px (below the toolbar).
 * @param {(files: File[]) => (void | Promise<void>)} cfg.onFiles - Called with all chosen/dropped files.
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

  // Swapped in for `content` (via the `loading` class) while the dropped file opens, so the wait reads as progress.
  const loading = document.createElement('div');
  loading.className = 'scribe-drop-loading';
  loading.innerHTML = '<div class="scribe-drop-spinner"></div><div class="scribe-drop-loading-text">Opening…</div>';

  const region = document.createElement('div');
  region.className = 'scribe-drop-region';
  region.append(content, loading);
  dropZone.appendChild(region);

  openFileInputElem.addEventListener('change', async () => {
    if (!openFileInputElem.files || openFileInputElem.files.length === 0) return;
    dropZone.classList.add('loading');
    try {
      await onFiles([...openFileInputElem.files]);
    } finally {
      dropZone.classList.remove('loading');
    }
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
    // Switch to the loading state as soon as the drop is accepted, since the page does not render for ~1s.
    dropZone.classList.remove('highlight');
    dropZone.classList.add('loading');
    try {
      await onFiles(files);
    } finally {
      dropZone.classList.remove('loading');
    }
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
