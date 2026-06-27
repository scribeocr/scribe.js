import scribe from '../../scribe.js';
import { ScribeViewer } from '../viewer.js';
import { applyHighlight } from '../js/viewerHighlights.js';
import { destroyContextMenu } from '../js/viewerCanvasInteraction.js';
import {
  addControlStyles, makeToolbarShell, makeSeparator, createPageNav, createZoomControls, createSearchBar,
} from '../js/controls/toolbar.js';
import { createThumbnailPanel, createScrollbars } from '../js/controls/panels.js';
import { createHighlightTool, createDropZone, openDocumentFromFile } from '../js/controls/tools.js';

/** Root class used to scope this app's control styles. */
const ROOT_CLASS = 'scribe-pdf-viewer';

// Toolbar height bounds (px).
const TOOLBAR_HEIGHT_DEFAULT = 32;
const TOOLBAR_HEIGHT_MIN = 24;
const TOOLBAR_HEIGHT_MAX = 80;

/**
 * @typedef {object} FitResult
 * @property {number} zoom
 * @property {number} [x]
 * @property {number} [y]
 */

/**
 * @typedef {'width' | 'height' | 'page' | ((imgDims: {width: number, height: number}, viewerDims: {width: number, height: number}) => FitResult)} FitMode
 */

class ScribePDFViewer {
  /**
   * @param {HTMLElement} container - Element the viewer mounts into. The viewer fills it.
   * @param {object} [options]
   * @param {number | 'auto'} [options.width='auto'] - Initial viewer width in px, or 'auto' to
   *   fill the container's current clientWidth.
   * @param {number | 'auto'} [options.height='auto'] - Initial viewer height in px, or 'auto' to
   *   fill the container's current clientHeight.
   * @param {boolean | { colors: string[], defaultColor?: string }} [options.highlight=true]
   *   Controls the highlight toolbar. `true` renders the toggle and all built-in colors. `false`
   *   removes the toggle and color picker from the toolbar entirely. An object restricts the picker
   *   to the given hex colors. Disabling the toolbar does not block programmatic `applyHighlight` calls.
   * @param {boolean} [options.showToolbar=true] - Render the toolbar (page nav, zoom, highlight controls).
   *   When false the viewer fills the container with the canvas only.
   * @param {number} [options.toolbarHeight=32] - Height of the toolbar in px. Clamped to [24, 80].
   * @param {boolean} [options.showDropZone=true] - Render the drag-and-drop file upload zone.
   *   When false, consumers must load documents via `importFile` or `attachDocument`.
   * @param {boolean} [options.showScrollbars=true] - Render scrollbars.
   * @param {boolean} [options.showThumbnails=true] - Render the collapsible page-thumbnails side panel, with a toolbar toggle.
   *   Thumbnails render lazily: only on-screen rows, at low DPI.
   * @param {number} [options.thumbnailWidth=150] - Thumbnail image width in px.
   * @param {FitMode} [options.fit='height'] - How to size the first page when a document opens.
   *   `'width'` fits page width to the viewer. `'height'` (default) fits page height. `'page'` fits
   *   the whole page. A function receives the page dims and viewer dims and returns `{zoom, x?, y?}`.
   * @param {boolean} [options.autoResize=true] - Install a ResizeObserver on `container` and
   *   resize the viewer to match its dimensions whenever they change.
   * @param {'focused'|'global'|'off'} [options.keyboardScope='focused'] - How far this viewer's keyboard shortcuts reach.
   *   `'focused'` (default) handles keystrokes only when interaction is inside this viewer
   *   (safe beside host UI and for multiple viewers on one page).
   *   `'global'` handles them anywhere on the page when this is the active viewer,
   *   for a full-screen single-viewer app. `'off'` disables them.
   * @param {ScribeViewer} [options.scribe] - Attach to an existing `ScribeViewer` instance instead
   *   of creating a new one. Use to share state with an already-instantiated viewer.
   */
  constructor(container, options = {}) {
    const {
      width = 'auto',
      height = 'auto',
      highlight = true,
      showToolbar = true,
      toolbarHeight = TOOLBAR_HEIGHT_DEFAULT,
      showDropZone = true,
      showScrollbars = true,
      showThumbnails = true,
      thumbnailWidth = 150,
      fit = 'height',
      autoResize = true,
      keyboardScope = 'focused',
    } = options;

    this.container = container;
    this.showToolbar = showToolbar;
    this.showDropZone = showDropZone;
    this.showScrollbars = showScrollbars;
    this.showThumbnails = showThumbnails;
    /** @type {?import('../../js/containers/scribeDoc.js').ScribeDoc} */
    this.doc = null;
    /**
     * Whether the doc should be terminated with the viewer.
     * @type {boolean}
     */
    this._ownsDoc = false;

    /**
     * The `ScribeViewer` instance backing this viewer. Each `ScribePDFViewer` owns its own
     * `ScribeViewer`, so multiple `ScribePDFViewer` instances can coexist on the page without
     * sharing state. Pass `options.scribe` to attach to an existing instance.
     * @type {ScribeViewer}
     */
    this.scribe = options.scribe || new ScribeViewer();
    this.scribe.opt.keyboardScope = keyboardScope;

    const initWidth = width === 'auto' ? (container.clientWidth || 800) : width;
    const initHeight = height === 'auto' ? (container.clientHeight || 1000) : height;

    this.scribe.enableHTMLOverlay = true;
    this.scribe.state.displayMode = 'invis';

    let highlightColors = null;
    let defaultHighlightColor;
    if (highlight === false) {
      highlightColors = null;
    } else if (highlight === true) {
      highlightColors = ['#ffe93b', '#4dd0e1', '#81c784', '#ffb74d'];
      defaultHighlightColor = '#ffe93b';
    } else if (typeof highlight === 'object' && highlight !== null) {
      if (!Array.isArray(highlight.colors) || highlight.colors.length === 0) {
        throw new Error('options.highlight.colors must be a non-empty array. Use highlight: false to disable highlighting entirely.');
      }
      highlightColors = highlight.colors;
      defaultHighlightColor = highlight.defaultColor ?? highlight.colors[0];
      if (!highlightColors.includes(defaultHighlightColor)) {
        throw new Error('options.highlight.defaultColor must be one of options.highlight.colors.');
      }
    } else {
      throw new Error('options.highlight must be true, false, or an object with a colors array.');
    }

    addControlStyles(ROOT_CLASS);

    this.pdfViewerElem = document.createElement('div');
    this.pdfViewerElem.className = ROOT_CLASS;
    // The component's outer element (toolbar + canvas).
    // Lets the viewer treat a click on its own controls as "still inside the viewer" when deciding whether to relinquish keyboard focus.
    this.scribe.outerElem = this.pdfViewerElem;
    this.pdfViewerElem.style.width = `${initWidth}px`;
    this.pdfViewerElem.style.height = `${initHeight}px`;
    // Clip oversized children (a wide toolbar, a stale-sized overlay) to the component box,
    // so a spill-out can't add document scrollbars that change the size the component re-reads each ResizeObserver tick,
    // re-firing it in a jitter feedback loop.
    // `relative` extends the clip over absolute children and anchors them to the component (correct when embedded).
    this.pdfViewerElem.style.position = 'relative';
    this.pdfViewerElem.style.overflow = 'hidden';
    this.pdfViewerElem.style.backgroundColor = 'rgb(82, 86, 89)';
    this.pdfViewerElem.style.fontFamily = '\'Segoe UI\', Tahoma, sans-serif';

    const toolbarHeightNum = Number(toolbarHeight);
    const toolbarHeightResolved = Number.isFinite(toolbarHeightNum)
      ? Math.min(TOOLBAR_HEIGHT_MAX, Math.max(TOOLBAR_HEIGHT_MIN, toolbarHeightNum))
      : TOOLBAR_HEIGHT_DEFAULT;
    this.toolbarHeight = showToolbar ? toolbarHeightResolved : 0;
    // Icons/page-input/text are sized to the bar.
    const toolbarIconSize = Math.max(16, Math.min(32, this.toolbarHeight - 4));

    // The highlight subsystem is created whenever highlighting is enabled, independent of the toolbar,
    // so selection-driven highlighting still works with `showToolbar: false`.
    /** @type {?ReturnType<typeof createHighlightTool>} */
    this._highlightTool = highlightColors
      ? createHighlightTool(this.scribe, this.pdfViewerElem, {
        colors: highlightColors, defaultColor: defaultHighlightColor ?? highlightColors[0], rootClass: ROOT_CLASS,
      })
      : null;

    /** @type {?ReturnType<typeof createSearchBar>} */
    this._searchBar = null;

    /** @type {?ReturnType<typeof createThumbnailPanel>} */
    this._thumbnailPanel = showThumbnails
      ? createThumbnailPanel(this.scribe, {
        width: thumbnailWidth,
        onSelect: (n) => this.scribe.displayPage(n, true, false),
      })
      : null;
    this._thumbnailsVisible = showThumbnails;
    // Expanded panel width = thumbnail image width + room for padding and the panel's own scrollbar.
    this._thumbPanelWidth = thumbnailWidth + 30;
    this.thumbnailPanelWidth = this._thumbnailPanel ? this._thumbPanelWidth : 0;

    if (showToolbar) {
      // The shared CSS sizes `.cr-icon`/`.cr-icon-button` from this var, scoped to this instance's root.
      this.pdfViewerElem.style.setProperty('--scribe-icon-size', `${toolbarIconSize}px`);

      const {
        toolbarElem, toolbarElemStart, center, toolbarElemEnd,
      } = makeToolbarShell(ROOT_CLASS, this.toolbarHeight, toolbarIconSize);

      const toolbarButtons = document.createElement('div');
      toolbarButtons.className = 'col-md order-2 my-auto';

      if (this._thumbnailPanel) {
        toolbarButtons.appendChild(this._thumbnailPanel.toggleElem);
        toolbarButtons.appendChild(makeSeparator());
      }

      const pageNav = createPageNav(this.scribe);
      const zoom = createZoomControls(this.scribe);

      toolbarButtons.appendChild(pageNav.prevElem);
      toolbarButtons.appendChild(pageNav.nextElem);
      toolbarButtons.appendChild(pageNav.pageInputGroup);
      toolbarButtons.appendChild(makeSeparator());
      toolbarButtons.appendChild(zoom.zoomControls);
      if (this._highlightTool) {
        toolbarButtons.appendChild(makeSeparator());
        toolbarButtons.appendChild(this._highlightTool.highlightElem);
        if (this._highlightTool.colorContainer) toolbarButtons.appendChild(this._highlightTool.colorContainer);
      }

      // Find / search controls (right-aligned).
      this._searchBar = createSearchBar(this.scribe, this.pdfViewerElem);
      toolbarElemEnd.appendChild(this._searchBar.findGroupElem);
      toolbarElemEnd.appendChild(this._searchBar.searchElem);

      center.appendChild(toolbarButtons);
      this.pdfViewerElem.appendChild(toolbarElem);

      this.toolbarElem = toolbarElem;
      this.toolbarElemStart = toolbarElemStart;
      this.toolbarElemEnd = toolbarElemEnd;
      this.pageNumElem = pageNav.pageNumElem;
      this.pageCountElem = pageNav.pageCountElem;
    }

    this.viewerContainer = document.createElement('div');
    this.viewerContainer.style.position = 'relative';
    this.viewerContainer.style.overflow = 'hidden';
    // Offset the canvas area to the right of the thumbnails panel.
    // As a normal-flow block with `width:auto` it then fills exactly the remaining width.
    this.viewerContainer.style.marginLeft = `${this.thumbnailPanelWidth}px`;

    const viewer = document.createElement('div');
    viewer.style.position = 'relative';
    viewer.style.overflow = 'hidden';

    this.viewerContainer.appendChild(viewer);
    this.pdfViewerElem.appendChild(this.viewerContainer);

    if (showDropZone) {
      const { dropZone, openFileInputElem } = createDropZone({
        width: initWidth - this.thumbnailPanelWidth - 6,
        height: initHeight - this.toolbarHeight,
        top: this.toolbarHeight,
        onFile: (file) => this.importFile(file),
      });
      dropZone.style.left = `${this.thumbnailPanelWidth}px`;
      this.pdfViewerElem.appendChild(dropZone);
      this.dropZone = dropZone;
      this.openFileInputElem = openFileInputElem;
    }

    if (this._thumbnailPanel) {
      const panel = this._thumbnailPanel.panelElem;
      panel.style.top = `${this.toolbarHeight}px`;
      panel.style.width = `${this.thumbnailPanelWidth}px`;
      panel.style.height = `${initHeight - this.toolbarHeight}px`;
      this.pdfViewerElem.appendChild(panel);
    }

    this._installFit(fit);

    this.scribe.init(this.viewerContainer, initWidth - this.thumbnailPanelWidth, initHeight - this.toolbarHeight);

    /** @type {?(() => void)} */
    this._updateScrollbars = null;
    if (this.showScrollbars) {
      this._updateScrollbars = createScrollbars(this.scribe, this.viewerContainer).updateScrollbars;
    }

    // Document-level listeners, retained so `destroy()` can remove them.
    /** @type {Array<() => void>} */
    this._teardownCallbacks = [];

    // Selection-driven highlighting + comment icons (needs `scribe.elem`, so wired after init).
    if (this._highlightTool) {
      this._teardownCallbacks.push(this._highlightTool.installBehaviors());
    }

    // Backup mouseup listener on the document to clear selection state
    // if mouseup happens outside of the Konva stage (e.g. on an HTML overlay element).
    const selectionResetMouseupHandler = () => {
      if (this.scribe.selecting) {
        this.scribe.selecting = false;
        this.scribe.selectingRectangle?.visible(false);
        this.scribe.layerText?.batchDraw();
      }
    };
    document.addEventListener('mouseup', selectionResetMouseupHandler);
    this._teardownCallbacks.push(() => document.removeEventListener('mouseup', selectionResetMouseupHandler));

    // Ctrl/Cmd+F opens the find bar (scoped by keyboardScope).
    if (this._searchBar) {
      this._teardownCallbacks.push(this._searchBar.installFindShortcut());
    }

    const origCallback = this.scribe.displayPageCallback;
    this.scribe.displayPageCallback = () => {
      if (origCallback) origCallback();
      if (this.pageNumElem) this.pageNumElem.value = (this.scribe.state.cp.n + 1).toString();
      if (this._updateScrollbars) this._updateScrollbars();
      if (this._thumbnailPanel) this._thumbnailPanel.setActive(this.scribe.state.cp.n);
      if (this._highlightTool) {
        const ht = this._highlightTool;
        setTimeout(() => ht.updateCommentIcons(), 250);
      }
    };

    container.appendChild(this.pdfViewerElem);

    // Toolbar toggle: collapse/expand the thumbnails panel and reflow the canvas to fill the gap.
    if (this._thumbnailPanel && this.toolbarElem) {
      const panel = this._thumbnailPanel;
      panel.toggleElem.addEventListener('click', () => {
        this._thumbnailsVisible = !this._thumbnailsVisible;
        this.thumbnailPanelWidth = this._thumbnailsVisible ? this._thumbPanelWidth : 0;
        panel.setVisible(this._thumbnailsVisible);
        this.resize(
          parseFloat(this.pdfViewerElem.style.width) || this.container.clientWidth,
          parseFloat(this.pdfViewerElem.style.height) || this.container.clientHeight,
        );
      });
    }

    if (autoResize && typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w > 0 && h > 0) this.resize(w, h);
      });
      this.resizeObserver.observe(container);
    }
  }

  /** Currently displayed page index (0-based). */
  get currentPage() {
    return this.scribe.state.cp.n;
  }

  /** Number of pages in the currently loaded document, or 0 if none is loaded. */
  get pageCount() {
    return this.doc?.inputData?.pageCount ?? 0;
  }

  /**
   * Navigate to a page by 0-based index.
   * @param {number} n
   */
  async goToPage(n) {
    await this.scribe.displayPage(n, true, false);
  }

  /**
   * Set the canvas to an absolute zoom level. A scale of `1` means 1 PDF point = 1 CSS pixel.
   * @param {number} scale
   */
  zoomTo(scale) {
    if (!this.scribe.stage) return;
    const current = this.scribe.stage.scaleX() || 1;
    this.scribe.zoom(scale / current, this.scribe.getStageCenter());
  }

  /**
   * Attach an existing `ScribeDoc` to the viewer for display.
   * The viewer does **not** take ownership. The document remains the caller's to terminate.
   * @param {import('../../js/containers/scribeDoc.js').ScribeDoc} doc
   * @param {number} [initialPage=0]
   * @param {object} [options]
   * @param {boolean} [options.terminatePrevious] - Force-terminate (`true`) or force-retain (`false`) the outgoing document,
   *   overriding the default (terminate only a document the viewer created).
   * @returns {Promise<?import('../../js/containers/scribeDoc.js').ScribeDoc>} The displaced document, or `null` if there was none.
   */
  async attachDocument(doc, initialPage = 0, { terminatePrevious } = {}) {
    return this._setDoc(doc, initialPage, false, terminatePrevious);
  }

  /**
   * Import a document into the viewer.
   * The viewer creates and **owns** the resulting document,
   * so it is terminated automatically on the next import, on `detachDoc`, or on `destroy`.
   * Accepts a `File`, `Blob`, `ArrayBuffer`, `Uint8Array`, or a filesystem path string (Node only).
   * Raw byte inputs (`ArrayBuffer`, `Uint8Array`, non-File `Blob`) are treated as PDFs.
   * @param {File | Blob | ArrayBuffer | Uint8Array | string} file
   * @param {number} [initialPage=0]
   * @param {object} [options]
   * @param {boolean} [options.terminatePrevious] - Force-terminate (`true`) or force-retain (`false`) the outgoing document,
   *   overriding the default (terminate only a document the viewer created).
   * @returns {Promise<?import('../../js/containers/scribeDoc.js').ScribeDoc>} The displaced document, or `null` if there was none.
   */
  async importFile(file, initialPage = 0, { terminatePrevious } = {}) {
    const doc = await openDocumentFromFile(file);
    return this._setDoc(doc, initialPage, true, terminatePrevious);
  }

  /**
   * Wire `doc` into the viewer and display `initialPage`, deciding the outgoing document's fate.
   * Shared by `attachDocument` (`owns=false`) and `importFile` (`owns=true`).
   *
   * The outgoing document's view is reset by the `scribe.doc` setter (`_resetDocState`) regardless.
   * Its resources are terminated only when `terminatePrevious` says so, defaulting to "terminate iff
   * the viewer owned it". Termination is always non-blocking, so the new page never waits on teardown.
   * @param {import('../../js/containers/scribeDoc.js').ScribeDoc} doc
   * @param {number} initialPage
   * @param {boolean} owns - Whether the viewer created `doc`.
   * @param {boolean | undefined} terminatePrevious - Explicit override of the outgoing-doc terminate.
   * @returns {Promise<?import('../../js/containers/scribeDoc.js').ScribeDoc>} The displaced document.
   */
  async _setDoc(doc, initialPage, owns, terminatePrevious) {
    const prev = this.doc;
    const displaced = prev && prev !== doc ? prev : null;
    const terminatePrev = terminatePrevious ?? this._ownsDoc;

    this.doc = doc;
    this._ownsDoc = owns;
    this.scribe.doc = doc; // fires _resetDocState(): resets the outgoing document's view only
    this.resetSearch();

    for (let i = 0; i < doc.inputData.pageCount; i++) {
      if (!doc.annotations.pages[i]) doc.annotations.pages[i] = [];
    }

    if (this.pageCountElem) this.pageCountElem.textContent = doc.inputData.pageCount.toString();
    if (this.pageNumElem) this.pageNumElem.value = (initialPage + 1).toString();
    if (this._thumbnailPanel) this._thumbnailPanel.rebuild();

    // Off the critical path: the displaced document's workers die asynchronously while the new page renders.
    // Safe because each document's workers and fonts are namespaced by a unique docId.
    if (terminatePrev && displaced) displaced.terminate().catch(() => {});

    this.scribe.runSetInitial = true;
    await this.scribe.displayPage(initialPage, initialPage > 0);

    if (this.dropZone) this.dropZone.style.display = 'none';

    return displaced;
  }

  /**
   * Stop displaying the current document and return the viewer to its empty state (drop zone shown), without destroying the viewer.
   * Terminates the detached document only if the viewer owns it (created it via `importFile`) or `terminate` forces the choice.
   * @param {object} [options]
   * @param {boolean} [options.terminate] - Force-terminate (`true`) or force-retain (`false`) the detached document,
   *   overriding the default (terminate only a document the viewer created).
   * @returns {?import('../../js/containers/scribeDoc.js').ScribeDoc} The detached document (for the caller to cache or terminate),
   *   or `null` if no document was attached.
   */
  detachDoc({ terminate } = {}) {
    const prev = this.doc;
    if (!prev) return null;
    const terminatePrev = terminate ?? this._ownsDoc;

    this.scribe.doc = new scribe.ScribeDoc(); // empty doc -> setter fires _resetDocState(): view cleared
    this.doc = null;
    this._ownsDoc = false;
    this.resetSearch();
    if (this.scribe.stage) this.scribe.stage.batchDraw(); // flush the now-empty layers

    if (this.pageCountElem) this.pageCountElem.textContent = '0';
    if (this.pageNumElem) this.pageNumElem.value = '1';
    if (this.dropZone) this.dropZone.style.display = '';
    if (this._thumbnailPanel) this._thumbnailPanel.rebuild();

    if (terminatePrev) prev.terminate().catch(() => {});

    return prev;
  }

  /** Open the find bar, enable search highlighting, and focus the input. */
  openSearch() {
    this._searchBar?.openSearch();
  }

  /** Close the find bar and clear the query (which drops all match highlights). */
  closeSearch() {
    this._searchBar?.closeSearch();
  }

  /**
   * Run a query: highlight all matches across the document and jump to the first one.
   * @param {string} query
   * @returns {Promise<void>}
   */
  runSearch(query) {
    return this._searchBar ? this._searchBar.runSearch(query) : Promise.resolve();
  }

  /** Refresh the "current/total" match counter from the viewer's search state. */
  updateSearchCounter() {
    this._searchBar?.updateSearchCounter();
  }

  /** Reset the find bar UI: hide it, clear the input, and exit search mode. */
  resetSearch() {
    this._searchBar?.resetSearch();
  }

  /**
   * Resize the viewer to new pixel dimensions.
   * @param {number} width
   * @param {number} height
   */
  resize(width, height) {
    const panelW = this.thumbnailPanelWidth;
    this.pdfViewerElem.style.width = `${width}px`;
    this.pdfViewerElem.style.height = `${height}px`;
    if (this._thumbnailPanel) {
      this._thumbnailPanel.panelElem.style.width = `${panelW}px`;
      this._thumbnailPanel.panelElem.style.height = `${height - this.toolbarHeight}px`;
    }
    if (this.viewerContainer) this.viewerContainer.style.marginLeft = `${panelW}px`;
    if (this.dropZone) {
      this.dropZone.style.left = `${panelW}px`;
      this.dropZone.style.width = `${width - panelW - 6}px`;
      this.dropZone.style.height = `${height - this.toolbarHeight}px`;
    }
    this.scribe.resize(width - panelW, height - this.toolbarHeight);
    if (this._updateScrollbars) this._updateScrollbars();
  }

  /**
   * Tear down the viewer, disconnect observers, terminate the document if the viewer owns it, and remove the DOM.
   * @param {object} [options]
   * @param {boolean} [options.terminateDoc] - Force-terminate (`true`) or force-retain (`false`) the attached document,
   *   overriding the default (terminate only a document the viewer created).
   */
  async destroy({ terminateDoc } = {}) {
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this._thumbnailPanel) this._thumbnailPanel.destroy();
    // Teardown callbacks remove the document-level listeners and the highlight tool's observer/tooltip/cursor style.
    for (const cb of this._teardownCallbacks) cb();
    this._teardownCallbacks = [];
    if (this.doc) {
      if (terminateDoc ?? this._ownsDoc) {
        try { await this.doc.terminate(); } catch { /* ignore */ }
      }
      this.doc = null;
    }
    // Remove the underlying viewer from the global registry and destroy its Konva stage.
    // Once the last viewer is gone, drop the shared context menu so nothing of ours remains in the host.
    this.scribe.destroy();
    if (ScribeViewer.getAllViewers().size === 0) destroyContextMenu();
    if (this.pdfViewerElem.parentNode) this.pdfViewerElem.parentNode.removeChild(this.pdfViewerElem);
  }

  /**
   * Install a `setInitialPositionZoom` implementation on `ScribeViewer` based on the requested fit mode.
   * @param {FitMode} fitMode
   */
  _installFit(fitMode) {
    this.scribe.setInitialPositionZoom = (imgDims) => {
      this.scribe.runSetInitial = false;
      const stageW = this.scribe.stage.width();
      const stageH = this.scribe.stage.height();

      if (typeof fitMode === 'function') {
        const r = fitMode(imgDims, { width: stageW, height: stageH });
        this.scribe.stage.scaleX(r.zoom);
        this.scribe.stage.scaleY(r.zoom);
        this.scribe.stage.x(r.x ?? (stageW - imgDims.width * r.zoom) / 2);
        this.scribe.stage.y(r.y ?? 30);
        return;
      }

      let zoom;
      let y;
      if (fitMode === 'width') {
        zoom = stageW / imgDims.width;
        y = 30;
      } else if (fitMode === 'page') {
        const wZoom = stageW / imgDims.width;
        const hZoom = (stageH - 60) / imgDims.height;
        zoom = Math.min(wZoom, hZoom);
        y = Math.max(30, (stageH - imgDims.height * zoom) / 2);
      } else {
        const interfaceHeight = 100;
        const bottomMarginHeight = 50;
        zoom = (stageH - interfaceHeight - bottomMarginHeight) / imgDims.height;
        y = interfaceHeight;
      }

      this.scribe.stage.scaleX(zoom);
      this.scribe.stage.scaleY(zoom);
      this.scribe.stage.x((stageW - imgDims.width * zoom) / 2);
      this.scribe.stage.y(y);
    };
  }

  /** Adds the required CSS styles to the document. Retained for backward compatibility. */
  static addIconButtonStyles = () => addControlStyles(ROOT_CLASS);
}

export {
  scribe, ScribeViewer, applyHighlight, ScribePDFViewer,
};
