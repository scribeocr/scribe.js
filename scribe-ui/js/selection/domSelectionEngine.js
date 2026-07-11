import scribe from '../../../scribe.js';
import { ScribeViewer } from '../../viewer.js';
import { findViewerForTarget } from '../viewerRuntime.js';

/**
 * The invisible-text (DOM) selection engine: word/filler spans plus the browser's native selection.
 *
 * Importing this module is the build-time opt-in; see `customSelectionEngine.js` for the split.
 * The shared span *painting* machinery stays in the viewer core, used under either engine.
 */

/** @type {Set<DomSelectionEngine>} Live engine instances, for the document-level handlers. */
const engines = new Set();

let documentHandlersInstalled = false;

/**
 * The ids of the word spans a native selection range covers.
 * @param {Range} range
 * @returns {Array<string>}
 */
function getElementIdsInRange(range) {
  const elementIds = [];
  // Non-word elements return FILTER_SKIP, not FILTER_REJECT, so the walker descends into the `.scribe-line` wrappers to reach the nested word spans.
  const selRects = [...range.getClientRects()];
  // Test each word's centre, not mere overlap, so the copied set matches the highlight and excludes words the selection only grazes at an edge.
  const selected = (r) => {
    const cx = (r.left + r.right) / 2;
    const cy = (r.top + r.bottom) / 2;
    return selRects.some((s) => cx >= s.left && cx <= s.right && cy >= s.top && cy <= s.bottom);
  };
  const treeWalker = document.createTreeWalker(
    range.commonAncestorContainer,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node) {
        if (node instanceof HTMLElement && node.classList && node.classList.contains('scribe-word')) {
          return selected(node.getBoundingClientRect()) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_SKIP;
      },
    },
  );

  while (treeWalker.nextNode()) {
    const node = treeWalker.currentNode;
    if (node instanceof HTMLElement && node.id) {
      elementIds.push(node.id);
    }
  }

  return elementIds;
}

function installDocumentHandlers() {
  if (documentHandlersInstalled) return;
  documentHandlersInstalled = true;

  const hideBackstops = () => {
    for (const e of engines) {
      if (e.viewer.enableHTMLOverlay && e.backstopEl) e.backstopEl.style.display = 'none';
    }
  };
  document.addEventListener('mouseup', hideBackstops);
  document.addEventListener('touchend', hideBackstops);

  const endSelectionGesture = () => {
    for (const e of engines) e.dragPointerDown = false;
    hideBackstops();
  };
  document.addEventListener('pointerup', endSelectionGesture);
  document.addEventListener('pointercancel', endSelectionGesture);

  const routeSelectionEvent = (event) => {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const focusNode = selection.focusNode;
    if (!focusNode) return;
    const target = focusNode.nodeType === Node.ELEMENT_NODE ? focusNode : focusNode.parentNode;
    if (!target) return;
    const v = findViewerForTarget(target);
    const engine = /** @type {any} */ (v)?._selEngine;
    if (engine?.kind === 'dom') engine.onNativeSelection(event);
  };
  document.addEventListener('selectionchange', routeSelectionEvent);
  document.addEventListener('mousedown', routeSelectionEvent);

  // Word spans are absolutely positioned, so native triple-click paragraph selection does not pick up the `.scribe-line` wrapper.
  // Select the line explicitly, on `click` as the gesture's last event so nothing collapses the selection afterward.
  document.addEventListener('click', (event) => {
    if (event.detail < 3 || event.button !== 0) return;
    const target = /** @type {any} */ (event.target);
    const lineElem = target?.closest?.('.scribe-word')?.closest('.scribe-line');
    if (!lineElem || !findViewerForTarget(lineElem)) return;
    const sel = document.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(lineElem);
    sel.removeAllRanges();
    sel.addRange(range);
  });

  document.addEventListener('copy', (e) => {
    for (const eng of engines) eng.endScrollHide();

    const sel = /** @type {Selection} */ (window.getSelection());
    const clipboardData = e.clipboardData;

    if (sel.rangeCount === 0 || !clipboardData) return;

    const range = sel.getRangeAt(0);

    const ids = getElementIdsInRange(range);

    if (ids.length === 0) return;

    // Route to the viewer that owns the selection's anchor.
    const anchorNode = sel.anchorNode;
    if (!anchorNode) return;
    const anchorTarget = anchorNode.nodeType === Node.ELEMENT_NODE ? anchorNode : anchorNode.parentNode;
    if (!anchorTarget) return;
    const v = findViewerForTarget(anchorTarget);
    if (!v) return;

    v.textGroupsRenderIndices.sort((a, b) => a - b);

    // writeText prefixes every line with '\n', so trim each page and drop empty ones to keep stray blank lines out of the clipboard.
    const pageTexts = [];
    for (const n of v.textGroupsRenderIndices) {
      const pageText = scribe.utils.writeText({
        ocrCurrent: v.doc.ocr.active,
        pageArr: [n],
        wordIds: ids,
      }).trim();
      if (pageText) pageTexts.push(pageText);
    }
    const text = pageTexts.join('\n\n');

    if (!text) return;

    clipboardData.setData('text/plain', text);
    e.preventDefault();
  });
}

export class DomSelectionEngine {
  /** @param {ScribeViewer} viewer */
  constructor(viewer) {
    this.kind = 'dom';
    this.viewer = viewer;
    /** @type {?HTMLDivElement} */
    this.backstopEl = null;
    /** Gates the backstop to an in-flight drag; the document gesture-end handlers clear it. */
    this.dragPointerDown = false;
    /** @type {?Range} */
    this.prevRange = null;
    this.scrollHideEngaged = false;
    /** @type {?ReturnType<typeof setTimeout>} */
    this.scrollHideTimer = null;
    this.scrollGestureDist = 0;
  }

  install() {
    // Selection points in the dead space between and beside pages would otherwise resolve to the content-layer start and invert the selection to everything above the anchor.
    // z-index -1 keeps it below the per-page fillers so it catches only those gaps, not within-page dead space.
    this.backstopEl = document.createElement('div');
    this.backstopEl.className = 'endOfContent';
    Object.assign(this.backstopEl.style, {
      position: 'absolute',
      left: '-100%',
      top: '-100%',
      width: '300%',
      height: '300%',
      display: 'none',
      pointerEvents: 'auto',
      zIndex: '-1',
    });
    // Legacy facade name, kept so embedders that reached for it keep working.
    this.viewer.HTMLOverlayBackstopElem = this.backstopEl;

    this.viewer.scrollContainer.addEventListener('pointerdown', (event) => {
      if (event.button === 0) this.dragPointerDown = true;
    });

    engines.add(this);
    installDocumentHandlers();
  }

  uninstall() {
    engines.delete(this);
    this.backstopEl?.remove();
    this.backstopEl = null;
  }

  /** Drop the native selection. */
  clear() {
    window.getSelection()?.removeAllRanges();
  }

  /** The viewer's word objects under the native selection. @returns {Array<any>} */
  getWords() {
    const viewer = this.viewer;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !viewer.elem) return [];
    const range = sel.getRangeAt(0);
    const idSet = new Set();
    const wordContents = document.createRange();
    for (const elem of viewer.elem.querySelectorAll('.scribe-word')) {
      // `intersectsNode` counts an edge touch as a hit, so a full-line selection would otherwise include the next line's first word.
      if (!range.intersectsNode(elem)) continue;
      const clamped = range.cloneRange();
      wordContents.selectNodeContents(elem);
      if (clamped.compareBoundaryPoints(Range.START_TO_START, wordContents) < 0) {
        clamped.setStart(wordContents.startContainer, wordContents.startOffset);
      }
      if (clamped.compareBoundaryPoints(Range.END_TO_END, wordContents) > 0) {
        clamped.setEnd(wordContents.endContainer, wordContents.endOffset);
      }
      if (clamped.toString().length > 0) idSet.add(elem.id);
    }
    if (idSet.size === 0) return [];
    return viewer.getUiWords().filter((kw) => idSet.has(kw.word.id));
  }

  hasSelection() {
    return this.getWords().length > 0;
  }

  /** Page indices spanned by the native selection. @returns {Set<number>} */
  pages() {
    const viewer = this.viewer;
    const pages = new Set();
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed) return pages;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < sel.rangeCount; i++) {
      const range = sel.getRangeAt(i);
      for (const node of [range.startContainer, range.endContainer]) {
        const el = /** @type {?HTMLElement} */ (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
        const grp = /** @type {?HTMLDivElement} */ (el?.closest?.('.scribe-layer-text'));
        if (!grp) continue;
        for (const n of viewer.textGroupsRenderIndices) {
          if (Object.values(viewer._textGroups[n] || {}).includes(grp)) {
            lo = Math.min(lo, n);
            hi = Math.max(hi, n);
            break;
          }
        }
      }
    }
    for (let n = lo; n <= hi; n++) pages.add(n);
    return pages;
  }

  /**
   * Keep the drag-time backstop at the focus of a native selection drag.
   * @param {Event} event
   */
  onNativeSelection(event) {
    // selectionchange also fires for keyboard and programmatic selection, which never need the drag-time backstop and would otherwise resurrect it outside a drag.
    if (!this.dragPointerDown) return;
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);

    const focusNodeElem = selection.focusNode?.nodeType === Node.ELEMENT_NODE ? selection.focusNode : selection.focusNode?.parentNode;
    // The drag focus lands on a filler, not just a word.
    // Drop `.scribe-fill` and a drag past the page edge pins the selection at a stale spot.
    const focusWordElem = /** @type {?HTMLElement} */ (/** @type {any} */ (focusNodeElem)?.closest?.('.scribe-word, .scribe-fill'));

    if (!focusWordElem) return;

    /** @type {HTMLDivElement} */ (this.backstopEl).style.display = '';

    focusWordElem.parentNode?.insertBefore(/** @type {HTMLDivElement} */ (this.backstopEl), focusWordElem);

    this.prevRange = range.cloneRange();
  }

  /**
   * Per-line filler territories: each rendered line's share of the page, so the invisible filler spans tile the dead space between and beside words.
   * @param {Array<OcrLine>} renderedLines
   * @param {Map<OcrLine, {left: number, right: number}>} colExtents
   * @param {dims} pageDims
   * @returns {Map<OcrLine, {left: number, right: number, top: number, bottom: number}>}
   */
  computeFillLimits(renderedLines, colExtents, pageDims) {
    /** @type {Map<OcrLine, {left: number, right: number, top: number, bottom: number}>} */
    const fillLimits = new Map();
    // Territories must TILE: overlaps resolve by DOM order (reading order, not geometry), so a filler overhanging a column turns a small overshoot into a selection sweeping everything between.
    // A hole is benign by comparison, only pinning the drag at its focus, which the backstop handles.
    for (const l of renderedLines) {
      const lb = l.bbox;
      const col = colExtents.get(l);
      if (!col) continue;
      const dilate = (lb.bottom - lb.top) * 3;
      const lim = {
        left: 0, right: pageDims.width, top: 0, bottom: pageDims.height,
      };
      for (const m of renderedLines) {
        if (m === l) continue;
        const mb = m.bbox;
        const mc = colExtents.get(m);
        if (!mc) continue;
        if (mb.top < lb.bottom + dilate && mb.bottom > lb.top - dilate) {
          // Side midpoints come from the pair's column extents, so adjacent columns meet at one shared edge and neither overhangs.
          if (mc.left >= col.right) lim.right = Math.min(lim.right, (col.right + mc.left) / 2);
          if (mc.right <= col.left) lim.left = Math.max(lim.left, (mc.right + col.left) / 2);
        }
      }
      fillLimits.set(l, lim);
    }
    for (const l of renderedLines) {
      const lb = l.bbox;
      const lim = fillLimits.get(l);
      if (!lim) continue;
      for (const m of renderedLines) {
        if (m === l) continue;
        const mb = m.bbox;
        // Runs after the side pass so this x-overlap test uses the narrowed side span (lim), not the line's own bbox.
        // An isolated line whose bbox overlaps nothing then stays bounded by the columns its span reaches over, instead of becoming a page-tall slab.
        if (mb.left < lim.right && mb.right > lim.left) {
          if (mb.top >= lb.bottom) lim.bottom = Math.min(lim.bottom, (lb.bottom + mb.top) / 2);
          if (mb.bottom <= lb.top) lim.top = Math.max(lim.top, (mb.bottom + lb.top) / 2);
        }
      }
    }
    return fillLimits;
  }

  /**
   * A per-line filler factory: appends one invisible span covering the dead space [hitL, hitR] across the line band, so the gaps between words become selectable.
   * @param {HTMLDivElement} lineDiv
   * @param {{left: number, right: number, top: number, bottom: number}|undefined} lim
   * @param {{x: number, y: number}} angleAdjLine
   * @param {boolean} selectText
   * @returns {(hitL: number, hitR: number) => void}
   */
  makeLineFiller(lineDiv, lim, angleAdjLine, selectText) {
    return (hitL, hitR) => {
      if (!lim) return;
      const total = hitR - hitL;
      if (total <= 0) return;
      const fill = document.createElement('span');
      // Invariant styles live in the shared `.scribe-fill` rule (see `ensureWordStyleSheet`); only per-filler geometry is set below.
      fill.className = 'scribe-fill';
      // A single space, not empty: it paints nothing yet carries the caret, and copy serializes it as the word break between neighbors.
      fill.textContent = ' ';
      Object.assign(fill.style, {
        left: `${hitL + angleAdjLine.x}px`,
        top: `${lim.top + angleAdjLine.y}px`,
        height: `${Math.max(lim.bottom - lim.top, 1)}px`,
        lineHeight: `${Math.max(lim.bottom - lim.top, 1)}px`,
        paddingLeft: `${total}px`,
      });
      fill.style.userSelect = selectText ? 'text' : 'none';
      fill.style.setProperty('-webkit-user-select', selectText ? 'text' : 'none');
      lineDiv.appendChild(fill);
    };
  }

  /**
   * Hide the built text layers during a sustained scroll.
   * @param {number} speed - Scroll distance (px) since the previous frame.
   */
  onScroll(speed) {
    const viewer = this.viewer;
    this.scrollGestureDist += speed;
    if (this.scrollHideTimer) clearTimeout(this.scrollHideTimer);
    this.scrollHideTimer = setTimeout(() => this.endScrollHide(), ScribeViewer.scrollTextHideSettleMs);

    if (!this.scrollHideEngaged
      && this.scrollGestureDist < viewer._scrollMetrics().clientHeight * ScribeViewer.scrollTextHideDistanceFraction) return;

    const editing = document.activeElement && /** @type {HTMLElement} */ (document.activeElement).isContentEditable
      && viewer.elem?.contains(document.activeElement);
    // Skip (and restore) outside `invis` mode (hiding visible text blanks the page) or during a selection drag (autoscroll reads the live layer).
    // Also skip while an edit input is focused, since `display: none` blurs it and commits the edit.
    if (viewer.state.displayMode !== 'invis' || this.dragPointerDown || editing) {
      this.endScrollHide();
      return;
    }

    // Hiding the layers stops the compositor reprocessing their thousands of elements each scroll frame.
    this.scrollHideEngaged = true;
    const selPages = viewer._selectionPages();
    const vTop = viewer._scrollTop / viewer.zoomLevel;
    const vBottom = (viewer._scrollTop + viewer._scrollMetrics().clientHeight) / viewer.zoomLevel;
    for (const n of viewer.textGroupsRenderIndices) {
      const start = viewer.getPageStop(n);
      const end = viewer.getPageStop(n, false);
      const onScreen = start === null || end === null || (start < vBottom && end > vTop);
      // Pages holding part of the selection stay visible while on-screen.
      const want = onScreen && selPages.has(n) ? '' : 'none';
      for (const grp of Object.values(viewer._textGroups[n] || {})) {
        if (grp.style.display !== want) grp.style.display = want;
      }
    }
  }

  /**
   * Restore every hidden text layer and reset the scroll gesture.
   */
  endScrollHide() {
    if (this.scrollHideTimer) {
      clearTimeout(this.scrollHideTimer);
      this.scrollHideTimer = null;
    }
    this.scrollGestureDist = 0;
    if (!this.scrollHideEngaged) return;
    this.scrollHideEngaged = false;
    // Restore every cached group, not just the pages in `textGroupsRenderIndices`.
    // `destroyText` can drop a page from the indices while its group stays hidden and cached, so a rebuild into it would come back invisible.
    for (const groups of this.viewer._textGroups) {
      if (!groups) continue;
      for (const grp of Object.values(groups)) {
        if (grp.style.display) grp.style.display = '';
      }
    }
  }

  /**
   * Hide the built text layers until `endInteractionTextHide`.
   */
  startInteractionHide() {
    const viewer = this.viewer;
    const editing = document.activeElement && /** @type {HTMLElement} */ (document.activeElement).isContentEditable
      && viewer.elem?.contains(document.activeElement);
    // Hiding visible text blanks the page, display:none blurs a focused edit (committing it), and a selection's layers must stay live.
    if (viewer.state.displayMode !== 'invis' || editing || viewer._selectionPages().size) return;
    // Take over a scroll-hide already in flight: its pending settle would otherwise restore the layers mid-interaction.
    if (this.scrollHideTimer) {
      clearTimeout(this.scrollHideTimer);
      this.scrollHideTimer = null;
    }
    // A host interaction that moves or re-clips the content would otherwise repaint every built word each frame.
    this.scrollHideEngaged = true;
    for (const n of viewer.textGroupsRenderIndices) {
      for (const grp of Object.values(viewer._textGroups[n] || {})) {
        if (grp.style.display !== 'none') grp.style.display = 'none';
      }
    }
  }
}

ScribeViewer.registerSelectionEngine({
  kind: 'dom',
  /** @param {ScribeViewer} viewer */
  attach(viewer) {
    return new DomSelectionEngine(viewer);
  },
});
