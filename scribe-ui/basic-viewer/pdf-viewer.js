import scribe from '../../scribe.js';
import { ScribeViewer } from '../viewer.js';
import { applyHighlight } from '../js/viewerHighlights.js';
import { destroyContextMenu } from '../js/viewerCanvasInteraction.js';
import {
  addControlStyles, makeToolbarShell, makeSeparator, createPageNav, createZoomControls, createRotateControls, createPrintControls, createOpenControls, createTabStrip, createSearchBar,
} from '../js/controls/toolbar.js';
import { createThumbnailPanel, createScrollbars } from '../js/controls/panels.js';
import { createHighlightTool, createDropZone, openDocumentFromFile } from '../js/controls/tools.js';
import { filesFromDropEvent } from '../js/dragAndDrop.js';

/** Root class used to scope this app's control styles. */
const ROOT_CLASS = 'scribe-pdf-viewer';

// Toolbar height bounds (px).
const TOOLBAR_HEIGHT_DEFAULT = 40;
const TOOLBAR_HEIGHT_MIN = 24;
const TOOLBAR_HEIGHT_MAX = 80;

/** Height of the document tab strip (shown only with 2+ open tabs), in px. */
const TAB_STRIP_HEIGHT = 30;

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
   * @param {number} [options.toolbarHeight=40] - Height of the toolbar in px. Clamped to [24, 80].
   * @param {boolean} [options.showDropZone=true] - Render the drag-and-drop file upload zone.
   *   When false, consumers must load documents via `importFile` or `attachDocument`.
   * @param {boolean} [options.showScrollbars=true] - Render scrollbars.
   * @param {boolean} [options.showThumbnails=true] - Render the collapsible page-thumbnails side panel, with a toolbar toggle.
   *   Thumbnails render lazily: only on-screen rows, at low DPI.
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
     * Open documents, one per tab. The app owns these docs and terminates them on close / `destroy`.
     * @type {Array<{ doc: import('../../js/containers/scribeDoc.js').ScribeDoc, name: string, lastPage: number }>}
     */
    this._tabs = [];
    /** Index of the active tab in `_tabs`, or -1 when none is open. */
    this._activeTab = -1;
    /** Whether the tab strip currently occupies layout space (shown only with 2+ tabs). */
    this._tabStripVisible = false;

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
    // Current viewer pixel size, kept in sync by `resize` so `_relayout` can recompute canvas height when the tab strip shows/hides.
    this._width = initWidth;
    this._height = initHeight;

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
    // The px size above can momentarily exceed the container, so cap it to the content box.
    // Otherwise overflow toggles the scrollbars, which shrink the measured size and oscillate into a layout-shift loop.
    this.pdfViewerElem.style.maxWidth = '100%';
    this.pdfViewerElem.style.maxHeight = '100%';
    this.pdfViewerElem.style.boxSizing = 'border-box';
    // Clip oversized children to the component box.
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
    // Icons/page-input/text are sized 12px shorter than the bar (~6px of vertical air above and below), clamped to [16, 32].
    const toolbarIconSize = Math.max(16, Math.min(32, this.toolbarHeight - 12));

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
    /** @type {?ReturnType<typeof createPrintControls>} */
    this._print = null;
    /** @type {?ReturnType<typeof createOpenControls>} */
    this._open = null;
    /** @type {?ReturnType<typeof createTabStrip>} */
    this._tabStrip = null;
    /** @type {?HTMLDivElement} */
    this._tabStripElem = null;

    /** @type {?ReturnType<typeof createThumbnailPanel>} */
    this._thumbnailPanel = showThumbnails
      ? createThumbnailPanel(this.scribe, {
        onSelect: (n) => this.scribe.displayPage(n, true, false),
        onExtract: (pageIndices) => this.newDocumentFromPages(pageIndices),
        // The panel's width (or hiding it) changed, so re-inset the document into the area beside it.
        onResize: () => { if (this.scribe.scrollContainer) this._relayout(); },
      })
      : null;
    this._thumbnailsVisible = showThumbnails;

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
      const rotate = createRotateControls(this.scribe);
      const print = createPrintControls(this.scribe, this.pdfViewerElem);
      this._print = print;
      const open = createOpenControls(this.scribe, this.pdfViewerElem, (files) => this.openFiles(files));
      this._open = open;

      toolbarButtons.appendChild(open.openControls);
      toolbarButtons.appendChild(makeSeparator());
      toolbarButtons.appendChild(pageNav.prevElem);
      toolbarButtons.appendChild(pageNav.nextElem);
      toolbarButtons.appendChild(pageNav.pageInputGroup);
      toolbarButtons.appendChild(makeSeparator());
      toolbarButtons.appendChild(rotate.rotateControls);
      toolbarButtons.appendChild(makeSeparator());
      toolbarButtons.appendChild(zoom.zoomControls);
      toolbarButtons.appendChild(makeSeparator());
      toolbarButtons.appendChild(print.printControls);
      if (this._highlightTool) {
        toolbarButtons.appendChild(makeSeparator());
        toolbarButtons.appendChild(this._highlightTool.highlightElem);
        if (this._highlightTool.colorContainer) toolbarButtons.appendChild(this._highlightTool.colorContainer);
      }

      // Find / search controls (right-aligned).
      this._searchBar = createSearchBar(this.scribe, this.pdfViewerElem);
      // The find bar floats (absolute) under the toolbar, so it must hang off `toolbarElem` (the positioned ancestor) rather than the right-zone flex row.
      // Otherwise showing it would reflow the other controls.
      toolbarElem.appendChild(this._searchBar.findGroupElem);
      toolbarElemEnd.appendChild(this._searchBar.searchElem);

      center.appendChild(toolbarButtons);
      this.pdfViewerElem.appendChild(toolbarElem);

      // Tab strip sits in normal flow directly below the toolbar (so the canvas flows beneath it).
      // It starts hidden and only takes layout space once a second document is opened.
      const tabStrip = createTabStrip({
        onSelect: (i) => this._activateTab(i),
        onClose: (i) => this._closeTab(i),
      });
      this._tabStrip = tabStrip;
      this._tabStripElem = tabStrip.tabStripElem;
      this._tabStripElem.style.height = `${TAB_STRIP_HEIGHT}px`;
      this._tabStripElem.style.display = 'none';
      this.pdfViewerElem.appendChild(this._tabStripElem);

      this.toolbarElem = toolbarElem;
      this.toolbarElemStart = toolbarElemStart;
      this.toolbarElemEnd = toolbarElemEnd;
      this.pageNumElem = pageNav.pageNumElem;
      this.pageCountElem = pageNav.pageCountElem;
      this.prevElem = pageNav.prevElem;
      this.nextElem = pageNav.nextElem;
    }

    this.viewerContainer = document.createElement('div');
    this.viewerContainer.style.position = 'relative';
    this.viewerContainer.style.overflow = 'hidden';

    const viewer = document.createElement('div');
    viewer.style.position = 'relative';
    viewer.style.overflow = 'hidden';

    this.viewerContainer.appendChild(viewer);
    this.pdfViewerElem.appendChild(this.viewerContainer);

    if (showDropZone) {
      const { dropZone, openFileInputElem } = createDropZone({
        width: initWidth - 6,
        height: initHeight - this.toolbarHeight,
        top: this.toolbarHeight,
        onFiles: (files) => this.openFiles(files),
      });
      this.pdfViewerElem.appendChild(dropZone);
      this.dropZone = dropZone;
      this.openFileInputElem = openFileInputElem;
    }

    if (this._thumbnailPanel) {
      const panel = this._thumbnailPanel.panelElem;
      panel.style.top = `${this.toolbarHeight}px`;
      panel.style.height = `${initHeight - this.toolbarHeight}px`;
      this.pdfViewerElem.appendChild(panel);
    }

    this._installFit(fit);

    this.scribe.init(this.viewerContainer, initWidth, initHeight - this.toolbarHeight);

    /** @type {?(() => void)} */
    this._updateScrollbars = null;
    if (this.showScrollbars) {
      const bars = createScrollbars(this.scribe, this.viewerContainer);
      this._updateScrollbars = bars.updateScrollbars;
      this._vScrollTrack = bars.vTrack;
      this._vScrollThumb = bars.vThumb;
      this._hScrollTrack = bars.hTrack;
      this._hScrollThumb = bars.hThumb;
    }

    // Document-level listeners, retained so `destroy()` can remove them.
    /** @type {Array<() => void>} */
    this._teardownCallbacks = [];

    // Selection-driven highlighting + comment icons (needs `scribe.elem`, so wired after init).
    if (this._highlightTool) {
      this._teardownCallbacks.push(this._highlightTool.installBehaviors());
    }

    // Backup mouseup listener on the document to clear selection state if mouseup happens outside the scroll container.
    const selectionResetMouseupHandler = () => {
      if (this.scribe.selecting) {
        this.scribe.selecting = false;
        if (this.scribe.selectingRectangle) this.scribe.selectingRectangle.style.display = 'none';
      }
    };
    document.addEventListener('mouseup', selectionResetMouseupHandler);
    this._teardownCallbacks.push(() => document.removeEventListener('mouseup', selectionResetMouseupHandler));

    // Ctrl/Cmd+F opens the find bar (scoped by keyboardScope).
    if (this._searchBar) {
      this._teardownCallbacks.push(this._searchBar.installFindShortcut());
    }

    // Ctrl/Cmd+P prints (scoped by keyboardScope), replacing the browser's print-the-page default.
    if (this._print) {
      this._teardownCallbacks.push(this._print.installPrintShortcut());
    }

    // Ctrl/Cmd+O opens the file picker (scoped by keyboardScope), replacing the browser's open default.
    if (this._open) {
      this._teardownCallbacks.push(this._open.installOpenShortcut());
    }

    // A loaded document hides the empty-state drop zone, so it can't catch a dropped PDF.
    // Show a dedicated drag-over overlay during a file drag instead, and open the dropped PDF in a new tab.
    if (showDropZone) {
      const dragOverlay = document.createElement('div');
      dragOverlay.className = 'scribe-drag-overlay';
      dragOverlay.innerHTML = '<div class="scribe-drag-frame"></div><div class="scribe-drag-pill">'
        + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>'
        + '<span>Drop to open in a new tab</span></div>';
      this.pdfViewerElem.appendChild(dragOverlay);

      // `dragenter`/`dragleave` bubble per descendant, so a bare `dragleave` fires mid-drag.
      // The depth counter instead reaches 0 only when the cursor truly leaves the component.
      this._fileDragDepth = 0;
      // `types` includes 'Files' only for external file drags, so this ignores internal text-selection drags.
      // (`dataTransfer.files` is empty until `drop`, so we must check `types` instead.)
      /** @param {DragEvent} event */
      const isFileDrag = (event) => !!(event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files'));
      const hideDragOverlay = () => { this._fileDragDepth = 0; dragOverlay.style.opacity = '0'; };
      /** @param {DragEvent} event */
      const onDragEnter = (event) => {
        if (!this.doc || !isFileDrag(event)) return;
        this._fileDragDepth++;
        if (this._fileDragDepth !== 1) return;
        dragOverlay.style.top = `${this._chromeTop()}px`; // sit below the toolbar and tab strip, leaving them visible
        dragOverlay.style.opacity = '1';
      };
      /** @param {DragEvent} event */
      const onDragOver = (event) => {
        if (!this.doc || !isFileDrag(event)) return;
        event.preventDefault(); // allow the drop (otherwise the browser navigates to the dropped file)
      };
      /** @param {DragEvent} event */
      const onDragLeave = (event) => {
        if (!this.doc || !isFileDrag(event)) return;
        this._fileDragDepth = Math.max(0, this._fileDragDepth - 1);
        if (this._fileDragDepth === 0) dragOverlay.style.opacity = '0';
      };
      // A drop fires no matching `dragleave`, so hide here. The overlay is `pointer-events:none`, so the drop
      // lands on the canvas and bubbles to this root listener, which opens the dropped PDFs as new tabs.
      /** @param {DragEvent} event */
      const onDrop = async (event) => {
        if (!this.doc || !isFileDrag(event)) return;
        event.preventDefault();
        hideDragOverlay();
        const files = await filesFromDropEvent(event);
        if (files.length > 0) this.openFiles(files);
      };
      // Listen on the viewer's own root, never `window`/`document`, so the embedded component adds no global side effects.
      this.pdfViewerElem.addEventListener('dragenter', onDragEnter);
      this.pdfViewerElem.addEventListener('dragover', onDragOver);
      this.pdfViewerElem.addEventListener('dragleave', onDragLeave);
      this.pdfViewerElem.addEventListener('drop', onDrop);
      this._teardownCallbacks.push(() => {
        this.pdfViewerElem.removeEventListener('dragenter', onDragEnter);
        this.pdfViewerElem.removeEventListener('dragover', onDragOver);
        this.pdfViewerElem.removeEventListener('dragleave', onDragLeave);
        this.pdfViewerElem.removeEventListener('drop', onDrop);
      });
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

    // The toolbar's thumbnails-toggle button: slide the panel in or out.
    if (this._thumbnailPanel && this.toolbarElem) {
      const panel = this._thumbnailPanel;
      panel.toggleElem.addEventListener('click', () => {
        this._thumbnailsVisible = !this._thumbnailsVisible;
        panel.setVisible(this._thumbnailsVisible);
        this._animatePanelInset();
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

    // Apply the initial document inset for the visible panel.
    if (this._thumbnailPanel) this._relayout();
  }

  /** Currently displayed page index (0-based). */
  get currentPage() {
    return this.scribe.state.cp.n;
  }

  /** Number of pages in the currently loaded document, or 0 if none is loaded. */
  get pageCount() {
    return this.doc?.inputData?.pageCount ?? 0;
  }

  /** The find-bar container element (hidden until search is opened), or undefined when there is no toolbar. */
  get findGroupElem() {
    return this._searchBar?.findGroupElem;
  }

  /** The find-bar text input element, or undefined when there is no toolbar. */
  get searchInputElem() {
    return this._searchBar?.searchInputElem;
  }

  /** The find-bar "current/total" counter element, or undefined when there is no toolbar. */
  get searchCounterElem() {
    return this._searchBar?.searchCounterElem;
  }

  /** Reposition and show/hide the overlay scrollbars for the current scroll position (no-op if disabled). */
  updateScrollbars() {
    if (this._updateScrollbars) this._updateScrollbars();
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
    if (!this.scribe.scrollContainer) return;
    const current = this.scribe.zoomLevel || 1;
    this.scribe.zoom(scale / current, this.scribe.getViewportCenter());
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
   * The outgoing document's view is reset by the `scribe.doc` setter (which calls `clear()`) regardless.
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
    this.scribe.doc = doc;
    this.resetSearch();

    for (let i = 0; i < doc.inputData.pageCount; i++) {
      if (!doc.annotations.pages[i]) doc.annotations.pages[i] = [];
    }

    if (this.pageCountElem) this.pageCountElem.textContent = doc.inputData.pageCount.toString();
    if (this.pageNumElem) this.pageNumElem.value = (initialPage + 1).toString();
    // Pass the initial page so the rail mounts and renders the window around it from the first paint, rather than mounting the top,
    // then jumping (and re-rendering) once the main view's `displayPage` lands on the active page.
    if (this._thumbnailPanel) this._thumbnailPanel.rebuild(initialPage);

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

    this.scribe.doc = new scribe.ScribeDoc(); // empty doc -> setter fires clear(): view cleared
    this.doc = null;
    this._ownsDoc = false;
    this.resetSearch();

    if (this.pageCountElem) this.pageCountElem.textContent = '0';
    if (this.pageNumElem) this.pageNumElem.value = '1';
    if (this.dropZone) this.dropZone.style.display = '';
    if (this._thumbnailPanel) this._thumbnailPanel.rebuild();

    if (terminatePrev) prev.terminate().catch(() => {});

    return prev;
  }

  /**
   * Open one or more files as tabs. Each PDF becomes its own document/tab.
   * All non-PDF files (images, OCR, `.scribe`) are opened together into a single document/tab, the way the core import combines them.
   * The last opened tab becomes active.
   * @param {File[] | FileList} files
   * @returns {Promise<void>}
   */
  async openFiles(files) {
    const list = Array.from(files || []);
    if (list.length === 0) return;

    /** @param {File} f */
    const isPdf = (f) => /\.pdf$/i.test(f.name || '') || f.type === 'application/pdf';
    const pdfs = list.filter(isPdf);
    const others = list.filter((f) => !isPdf(f));

    /** @type {Array<{ doc: import('../../js/containers/scribeDoc.js').ScribeDoc, name: string }>} */
    const opened = [];
    for (const pdf of pdfs) {
      try {
        const doc = await openDocumentFromFile(pdf);
        opened.push({ doc, name: pdf.name || 'Document' });
      } catch (err) {
        console.error(`Failed to open ${pdf.name}:`, err);
      }
    }
    if (others.length > 0) {
      try {
        const doc = await scribe.openDocument(others);
        const name = others.length === 1 ? others[0].name : `${others[0].name} +${others.length - 1}`;
        opened.push({ doc, name });
      } catch (err) {
        console.error('Failed to open files:', err);
      }
    }
    if (opened.length === 0) return;

    for (const t of opened) this._tabs.push({ doc: t.doc, name: t.name, lastPage: 0 });
    await this._activateTab(this._tabs.length - 1);
  }

  /**
   * Open a new document (tab) built from `pageIndices` of the active document.
   * The pages are exported to PDF (original page content plus the edited text as an invisible layer), then re-imported.
   * The round-trip yields a self-contained document that shares none of the source's fonts or image scheduler.
   * @param {Array<number>} pageIndices - 0-based page indices to extract.
   * @returns {Promise<void>}
   */
  async newDocumentFromPages(pageIndices) {
    const srcDoc = this.scribe.doc;
    if (!srcDoc) return;
    const pageArr = [...new Set(pageIndices)].filter((n) => n >= 0 && n < srcDoc.pageMetrics.length).sort((a, b) => a - b);
    if (pageArr.length === 0) return;
    try {
      const bytes = await srcDoc.exportData('pdf', { displayMode: 'invis', addOverlay: true, pageArr });
      const doc = await openDocumentFromFile(new Blob([bytes], { type: 'application/pdf' }));
      const baseName = (this._activeTab >= 0 && this._tabs[this._activeTab]?.name) || 'Document';
      const name = `${baseName.replace(/\.pdf$/i, '')} (extract)`;
      this._tabs.push({ doc, name, lastPage: 0 });
      await this._activateTab(this._tabs.length - 1);
    } catch (err) {
      console.error('Failed to create a document from the selected pages:', err);
    }
  }

  /**
   * Make tab `i` the active document, first saving the outgoing tab's current page so returning to it restores position.
   * Retains the outgoing document (tabs stay loaded until closed).
   * @param {number} i
   * @returns {Promise<void>}
   */
  async _activateTab(i) {
    if (i < 0 || i >= this._tabs.length) return;
    if (this._activeTab >= 0 && this._activeTab < this._tabs.length) {
      this._tabs[this._activeTab].lastPage = this.scribe.state.cp.n;
    }
    const tab = this._tabs[i];
    this._activeTab = i;
    this._renderTabs();
    await this.attachDocument(tab.doc, tab.lastPage, { terminatePrevious: false });
  }

  /**
   * Close tab `i`: terminate its document and, if it was active, activate the next tab
   * (or return to the empty drop-zone state when none remain).
   * @param {number} i
   */
  _closeTab(i) {
    if (i < 0 || i >= this._tabs.length) return;
    const wasActive = i === this._activeTab;
    const [removed] = this._tabs.splice(i, 1);
    removed.doc.terminate().catch(() => {});

    if (this._tabs.length === 0) {
      this._activeTab = -1;
      this._renderTabs();
      this.detachDoc({ terminate: false });
      return;
    }
    if (wasActive) {
      // The removed tab is gone. Clear the active marker so `_activateTab` doesn't save a page into it.
      this._activeTab = -1;
      this._activateTab(Math.min(i, this._tabs.length - 1));
    } else {
      if (i < this._activeTab) this._activeTab -= 1;
      this._renderTabs();
    }
  }

  /** Re-render the tab strip and toggle its visibility (shown only with 2+ tabs). */
  _renderTabs() {
    this._setTabStripVisible(this._tabs.length >= 2);
    if (this._tabStrip) this._tabStrip.render(this._tabs, this._activeTab);
  }

  /**
   * Show or hide the tab strip, relaying out the canvas so the strip never overlaps page content.
   * @param {boolean} visible
   */
  _setTabStripVisible(visible) {
    if (this._tabStripVisible === visible || !this._tabStripElem) return;
    this._tabStripVisible = visible;
    this._tabStripElem.style.display = visible ? '' : 'none';
    this._relayout();
  }

  /** Height of the fixed top chrome (toolbar plus the tab strip when visible), in px. */
  _chromeTop() {
    return this.toolbarHeight + (this._tabStripVisible ? TAB_STRIP_HEIGHT : 0);
  }

  /** Re-apply canvas and thumbnail-panel sizing from the current dimensions and chrome height. */
  _relayout() {
    if (!this.scribe.scrollContainer) return;
    const top = this._chromeTop();
    if (this._thumbnailPanel) {
      this._thumbnailPanel.panelElem.style.top = `${top}px`;
      this._thumbnailPanel.panelElem.style.height = `${this._height - top}px`;
    }
    // Inset the document by the visible panel's width so it centers in the area beside it rather than under it.
    // Keep at least a sliver of document if the panel is wider than the viewport (e.g. a very narrow window).
    const panelW = this._thumbnailPanel && this._thumbnailsVisible
      ? (parseFloat(this._thumbnailPanel.panelElem.style.width) || 0) : 0;
    const inset = Math.min(panelW, Math.max(0, this._width - 80));
    this.scribe.scrollContainer.style.marginLeft = `${inset}px`;
    this.scribe.resize(this._width - inset, this._height - top);
    if (this._updateScrollbars) this._updateScrollbars();
  }

  /**
   * Animate the document inset to follow the panel's slide on a toolbar toggle, so the viewer re-centers smoothly instead of snapping.
   * Each frame samples the panel's live `translateX` rather than running a timed animation,
   * so the inset tracks the CSS slide without knowing its duration or easing.
   */
  _animatePanelInset() {
    if (!this._thumbnailPanel || !this.scribe.scrollContainer) return;
    if (this._insetAnim) cancelAnimationFrame(this._insetAnim);
    const panel = this._thumbnailPanel.panelElem;
    const panelW = parseFloat(panel.style.width) || 0;
    const top = this._chromeTop();
    const target = this._thumbnailsVisible ? panelW : 0;
    const setInset = (raw) => {
      const inset = Math.min(Math.max(0, raw), Math.max(0, this._width - 80));
      this.scribe.scrollContainer.style.marginLeft = `${inset}px`;
      this.scribe.resize(this._width - inset, this._height - top);
      if (this._updateScrollbars) this._updateScrollbars();
    };
    // `setVisible` already snapped the inset to its target.
    // Restart from the pre-toggle value so the first frame sits at the panel's current edge rather than jumping there.
    setInset(this._thumbnailsVisible ? 0 : panelW);
    const step = () => {
      const tf = getComputedStyle(panel).transform;
      const tx = tf && tf !== 'none' ? new DOMMatrix(tf).m41 : 0; // -panelW when hidden, 0 when shown
      const inset = panelW + tx;
      setInset(inset);
      if (Math.abs(inset - target) <= 0.5) { this._insetAnim = null; this._relayout(); } else this._insetAnim = requestAnimationFrame(step);
    };
    this._insetAnim = requestAnimationFrame(step);
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
    this._width = width;
    this._height = height;
    this.pdfViewerElem.style.width = `${width}px`;
    this.pdfViewerElem.style.height = `${height}px`;
    // The drop zone is only shown in the empty state, where the tab strip is hidden, so it tracks the toolbar.
    if (this.dropZone) {
      this.dropZone.style.width = `${width - 6}px`;
      this.dropZone.style.height = `${height - this.toolbarHeight}px`;
    }
    // _relayout sizes the canvas and panel (its width is user-owned) and insets the document by the panel's width.
    this._relayout();
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
    // The app owns every tab's document (opened via attachDocument with owns=false), so terminate them all here.
    for (const tab of this._tabs) {
      try { await tab.doc.terminate(); } catch { /* ignore */ }
    }
    this._tabs = [];
    this._activeTab = -1;
    if (this.doc) {
      if (terminateDoc ?? this._ownsDoc) {
        try { await this.doc.terminate(); } catch { /* ignore */ }
      }
      this.doc = null;
    }
    // Remove the underlying viewer from the global registry and tear it down.
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
      const sc = this.scribe.scrollContainer;
      const stageW = sc.clientWidth;
      const stageH = sc.clientHeight;

      let zoom;
      // `y` is the desired gap, in screen px, from the top of the viewport to the top of the first page.
      let y;
      if (typeof fitMode === 'function') {
        const r = fitMode(imgDims, { width: stageW, height: stageH });
        zoom = r.zoom;
        y = r.y ?? 30;
      } else if (fitMode === 'width') {
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

      this.scribe.zoomLevel = zoom;
      this.scribe._applyZoomTransform(zoom);
      this.scribe._updateContentSize();
      const page0 = this.scribe.getPageStop(0) ?? 0;
      sc.scrollTop = Math.max(0, page0 * zoom - y);
      sc.scrollLeft = Math.max(0, (this.scribe._contentWidth * zoom - stageW) / 2);
    };
  }

  /** Adds the required CSS styles to the document. Retained for backward compatibility. */
  static addIconButtonStyles = () => addControlStyles(ROOT_CLASS);
}

export {
  scribe, ScribeViewer, applyHighlight, ScribePDFViewer,
};
