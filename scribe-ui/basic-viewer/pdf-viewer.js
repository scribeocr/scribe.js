import scribe from '../../scribe.js';
import { ScribeViewer } from '../viewer.js';
import { applyHighlight } from '../js/viewerHighlights.js';
import { destroyContextMenu } from '../js/viewerCanvasInteraction.js';
import {
  addControlStyles, makeToolbarShell, makeSeparator, createPageNav, createZoomControls, createRotateControls, createPrintControls, createOpenControls, createTabStrip, createSearchBar,
  createAppMenu, OPEN_SVG, PRINT_SVG,
} from '../js/controls/toolbar.js';
import { createThumbnailPanel, createScrollbars } from '../js/controls/panels.js';
import { createBookmarksPanel } from '../js/controls/bookmarksPanel.js';
import { createCommentsPanel } from '../js/controls/commentsPanel.js';
import {
  createHighlightTool, createNoteTool, createDropZone, openDocumentFromFile,
} from '../js/controls/tools.js';
import { filesFromDropEvent } from '../js/dragAndDrop.js';
import { mergePdfs } from '../../js/export/pdf/mergePdfs.js';
import { concatOutlines, outlineSplitSegments } from '../../js/objects/outlineObjects.js';

/** Root class used to scope this app's control styles. */
const ROOT_CLASS = 'scribe-pdf-viewer';

/**
 * Compile-time gate for the developer-only Debug menu; commit it as `false`.
 * A literal `false` makes the guarded `import('.../debugMenu.js')` below dead code, so public builds tree-shake the debug module out.
 */
const DEBUG_MENU = false;

// Toolbar height bounds (px).
const TOOLBAR_HEIGHT_DEFAULT = 40;
const TOOLBAR_HEIGHT_MIN = 24;
const TOOLBAR_HEIGHT_MAX = 80;

/** Height of the document tab strip (shown only with 2+ open tabs), in px. */
const TAB_STRIP_HEIGHT = 30;

/** Height of the dismissible message banner (shown below the chrome), in px. */
const MESSAGE_BANNER_HEIGHT = 40;

/** Close glyph for the message banner's dismiss button. */
const BANNER_CLOSE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

/** File extensions the viewer can open (PDF, images, OCR sidecars, and .scribe projects). */
const SUPPORTED_OPEN_EXT = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'hocr', 'xml', 'html', 'htm', 'json', 'scribe']);

/**
 * Duration (ms) of the left-sidebar open/close/switch animation.
 * Matches the thumbnail panel's own slide (`SLIDE_MS` in panels.js) so both views animate identically.
 */
const SIDEBAR_ANIM_MS = 180;

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
   * @param {boolean} [options.comments=false] - Enable the note tool, comments side panel, and rendering of imported /Text sticky-note annotations.
   *   The note tool also needs `highlight` enabled.
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
      comments = false,
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
    this.scribe.opt.enableComments = comments;

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
    this.pdfViewerElem.style.backgroundColor = 'var(--scribe-canvas)';
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

    // Freestanding-note tool: opt-in via `comments`, and built on the highlight tool's comment editor.
    /** @type {?ReturnType<typeof createNoteTool>} */
    this._noteTool = (this._highlightTool && comments)
      ? createNoteTool(this.scribe)
      : null;

    /** @type {?ReturnType<typeof createSearchBar>} */
    this._searchBar = null;
    /** @type {?ReturnType<typeof createPrintControls>} */
    this._print = null;
    /** @type {?ReturnType<typeof createOpenControls>} */
    this._open = null;
    /** @type {?ReturnType<typeof createAppMenu>} */
    this._appMenu = null;
    /** @type {?ReturnType<typeof createTabStrip>} */
    this._tabStrip = null;
    /** @type {?HTMLDivElement} */
    this._tabStripElem = null;

    /** @type {?ReturnType<typeof createThumbnailPanel>} */
    this._thumbnailPanel = showThumbnails
      ? createThumbnailPanel(this.scribe, {
        onSelect: (n) => this.scribe.displayPage(n, true, false),
        onExtract: (pageIndices) => this.newDocumentFromPages(pageIndices),
        onInsertFromFile: (index) => this._pickFilesToInsert(index),
        // The panel's width (or hiding it) changed, so re-inset the document into the area beside it.
        onResize: (_width, phase) => {
          if (!this.scribe.scrollContainer) return;
          if (phase === 'start') { this._beginSidebarResize(); return; }
          if (phase === 'end') { this._endSidebarResize(); return; }
          this._relayout();
        },
      })
      : null;
    /**
     * Which of the left sidebar's three mutually-exclusive views is open, or null when it is closed.
     * @type {'thumbnails'|'bookmarks'|'comments'|null}
     */
    this._activeSidebar = showThumbnails ? 'thumbnails' : null;
    /** @type {?{raf: number}} In-flight sidebar open/close/switch transition (its live rAF handle), or null. */
    this._sidebarAnim = null;
    /** @type {?{min: number, max: number}} Rail width bounds cached for the duration of a bookmarks/comments-view resize drag. */
    this._sidebarResizeBounds = null;
    /** True while a sidebar resize drag (any view) is in flight, so `_relayout` skips the scrollbar refresh per move. */
    this._sidebarDragActive = false;

    /** Height the message banner currently claims from the document area (0 when hidden). */
    this._messageBannerHeight = 0;

    /** @type {?ReturnType<typeof createBookmarksPanel>} */
    this._bookmarksPanel = showThumbnails
      ? createBookmarksPanel(this.scribe, {
        // The whole destination, not just the page: goToOutlineDest honors a within-page position when one exists.
        onNavigate: (dest) => this.scribe.goToOutlineDest(dest),
        // Resizing from the bookmarks view drives the shared sidebar width (see `_resizeSidebar`).
        onResize: (w, phase) => this._resizeSidebar(w, phase),
      })
      : null;

    /** @type {?ReturnType<typeof createCommentsPanel>} */
    this._commentsPanel = (showThumbnails && comments)
      ? createCommentsPanel(this.scribe, {
        onNavigate: (n) => this.scribe.displayPage(n, true, false),
        onResize: (w, phase) => this._resizeSidebar(w, phase),
      })
      : null;

    if (showToolbar) {
      // The shared CSS sizes `.cr-icon`/`.cr-icon-button` from this var, scoped to this instance's root.
      this.pdfViewerElem.style.setProperty('--scribe-icon-size', `${toolbarIconSize}px`);

      const {
        toolbarElem, toolbarElemStart, center, toolbarElemEnd,
      } = makeToolbarShell(ROOT_CLASS, this.toolbarHeight, toolbarIconSize);

      const toolbarButtons = document.createElement('div');
      toolbarButtons.className = 'col-md order-2 my-auto';

      const pageNav = createPageNav(this.scribe);
      const zoom = createZoomControls(this.scribe);
      const rotate = createRotateControls(this.scribe);
      const print = createPrintControls(this.scribe, this.pdfViewerElem);
      this._print = print;
      const open = createOpenControls(this.scribe, this.pdfViewerElem, (files) => this.openFiles(files));
      this._open = open;

      // The hidden Open and Print controls stay in the DOM so their file input, Ctrl/Cmd+O and +P shortcuts, and busy state keep working.
      const appMenu = createAppMenu(ROOT_CLASS);
      this._appMenu = appMenu;
      open.openControls.style.display = 'none';
      print.printControls.style.display = 'none';
      appMenu.menuWrap.append(open.openControls, print.printControls);
      appMenu.addAction('Open file', OPEN_SVG, () => open.openElem.click());
      appMenu.addAction('Print', PRINT_SVG, () => print.printElem.click());
      if (DEBUG_MENU) {
        import('../js/controls/debugMenu.js')
          .then(({ installDebugMenu }) => installDebugMenu(appMenu, this.scribe))
          .catch((err) => console.error('Failed to load the debug menu:', err));
      }
      // Style the otherwise-empty start zone as a left-aligned flex row, with an 8px inset mirroring the end zone's, so the menu button sits at the left edge.
      toolbarElemStart.style.display = 'flex';
      toolbarElemStart.style.alignItems = 'center';
      toolbarElemStart.style.paddingLeft = '8px';
      toolbarElemStart.appendChild(appMenu.menuWrap);

      if (this._thumbnailPanel) {
        toolbarButtons.appendChild(this._thumbnailPanel.toggleElem);
        if (this._bookmarksPanel) toolbarButtons.appendChild(this._bookmarksPanel.toggleElem);
        if (this._commentsPanel) toolbarButtons.appendChild(this._commentsPanel.toggleElem);
        toolbarButtons.appendChild(makeSeparator());
      }

      toolbarButtons.appendChild(pageNav.prevElem);
      toolbarButtons.appendChild(pageNav.nextElem);
      toolbarButtons.appendChild(pageNav.pageInputGroup);
      toolbarButtons.appendChild(makeSeparator());
      toolbarButtons.appendChild(rotate.rotateControls);
      toolbarButtons.appendChild(makeSeparator());
      toolbarButtons.appendChild(zoom.zoomControls);
      if (this._highlightTool) {
        toolbarButtons.appendChild(makeSeparator());
        toolbarButtons.appendChild(this._highlightTool.toolbarElem);
      }
      if (this._noteTool) toolbarButtons.appendChild(this._noteTool.toolbarElem);

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

    if (this._bookmarksPanel) {
      const bpanel = this._bookmarksPanel.panelElem;
      bpanel.style.top = `${this.toolbarHeight}px`;
      bpanel.style.height = `${initHeight - this.toolbarHeight}px`;
      this.pdfViewerElem.appendChild(bpanel);
    }

    if (this._commentsPanel) {
      const cpanel = this._commentsPanel.panelElem;
      cpanel.style.top = `${this.toolbarHeight}px`;
      cpanel.style.height = `${initHeight - this.toolbarHeight}px`;
      this.pdfViewerElem.appendChild(cpanel);
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

    // The app menu's outside-click listener is document-level, so retire it on destroy.
    if (this._appMenu) this._teardownCallbacks.push(() => this._appMenu.destroy());

    // Selection-driven highlighting + comment icons (needs `scribe.elem`, so wired after init).
    if (this._highlightTool) {
      this._teardownCallbacks.push(this._highlightTool.installBehaviors());
    }
    if (this._noteTool) {
      this._teardownCallbacks.push(this._noteTool.installBehaviors());
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
      // A file dragged over the (visible, editable) thumbnail rail drops into the document at the hovered gap rather than opening a new tab.
      /** @param {number} clientX @param {number} clientY @returns {boolean} */
      const overThumbnailRail = (clientX, clientY) => {
        if (this._activeSidebar !== 'thumbnails' || !this._thumbnailPanel || !this.scribe.opt.enablePageEditing) return false;
        const r = this._thumbnailPanel.panelElem.getBoundingClientRect();
        return r.width > 0 && clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
      };
      /** @param {DragEvent} event */
      const onDragEnter = (event) => {
        if (!this.doc || !isFileDrag(event)) return;
        this._fileDragDepth++;
        if (this._fileDragDepth !== 1) return;
        dragOverlay.style.top = `${this._chromeTop()}px`; // sit below the toolbar and tab strip, leaving them visible
        // Keep the "open in a new tab" overlay clear of the thumbnail rail: dropping over the rail inserts pages there instead, so covering it would mislabel that region.
        const railW = (this._activeSidebar === 'thumbnails' && this._thumbnailPanel)
          ? (parseFloat(this._thumbnailPanel.panelElem.style.width) || 0) : 0;
        dragOverlay.style.left = `${railW}px`;
        // Show the new-tab overlay only when not entering directly over the rail, where the rail shows its insertion indicator instead.
        if (!overThumbnailRail(event.clientX, event.clientY)) dragOverlay.style.opacity = '1';
      };
      /** @param {DragEvent} event */
      const onDragOver = (event) => {
        if (!this.doc || !isFileDrag(event)) return;
        event.preventDefault(); // allow the drop (otherwise the browser navigates to the dropped file)
        // dragover fires continuously, so it is the source of truth for which indicator shows as the cursor crosses in/out of the rail.
        if (overThumbnailRail(event.clientX, event.clientY)) {
          dragOverlay.style.opacity = '0';
          this._thumbnailPanel.dropIndicator.show(event.clientX, event.clientY);
        } else {
          if (this._thumbnailPanel) this._thumbnailPanel.dropIndicator.hide();
          if (this._fileDragDepth > 0) dragOverlay.style.opacity = '1';
        }
      };
      /** @param {DragEvent} event */
      const onDragLeave = (event) => {
        if (!this.doc || !isFileDrag(event)) return;
        this._fileDragDepth = Math.max(0, this._fileDragDepth - 1);
        if (this._fileDragDepth === 0) {
          dragOverlay.style.opacity = '0';
          if (this._thumbnailPanel) this._thumbnailPanel.dropIndicator.hide();
        }
      };
      // A drop fires no matching `dragleave`, so clean up here.
      // The overlay is `pointer-events:none`, so the drop lands on the canvas/rail and bubbles to this root listener.
      /** @param {DragEvent} event */
      const onDrop = async (event) => {
        if (!this.doc || !isFileDrag(event)) return;
        event.preventDefault();
        // Resolve the target from the drop point before tearing down the drag visuals (the gap geometry is read synchronously).
        const overRail = overThumbnailRail(event.clientX, event.clientY);
        const gap = overRail ? this._thumbnailPanel.dropIndicator.gapAt(event.clientX, event.clientY) : -1;
        hideDragOverlay();
        if (this._thumbnailPanel) this._thumbnailPanel.dropIndicator.hide();
        const files = await filesFromDropEvent(event);
        if (files.length === 0) return;
        if (overRail) await this.insertPagesFromFiles(files, gap);
        else await this.openFiles(files);
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
      // Keep the navbar total in sync with the live page count. Every op that changes the count (paste, insert, delete, move, undo/redo) ends in displayPage, so refreshing here covers them all.
      if (this.pageCountElem && this.doc) this.pageCountElem.textContent = this.doc.inputData.pageCount.toString();
      if (this._updateScrollbars) this._updateScrollbars();
      if (this._thumbnailPanel) this._thumbnailPanel.setActive(this.scribe.state.cp.n);
      if (this._bookmarksPanel) this._bookmarksPanel.setActive(this.scribe.state.cp.n);
      if (this._commentsPanel) this._commentsPanel.setActive(this.scribe.state.cp.n);
      if (this._highlightTool) {
        const ht = this._highlightTool;
        setTimeout(() => ht.updateCommentIcons(), 250);
      }
    };

    // Both panels must fully rebuild after an edit, or stale rows send a later click or delete to the wrong page.
    const origEditCallback = this.scribe.onEditCallback;
    this.scribe.onEditCallback = () => {
      if (origEditCallback) origEditCallback();
      if (this._bookmarksPanel) this._bookmarksPanel.rebuild();
      if (this._commentsPanel) this._commentsPanel.rebuild();
      if (this._thumbnailPanel) {
        const len = this.scribe.doc ? this.scribe.doc.pageMetrics.length : 1;
        // The edit invalidated the page indices a pending cut captured, so cancel it.
        this._thumbnailPanel.cancelCut();
        this._thumbnailPanel.rebuild(Math.max(0, Math.min(this.scribe.state.cp.n, len - 1)));
      }
    };

    // The viewer's right-click "Add bookmark" routes here.
    if (this._bookmarksPanel) {
      this.scribe._addBookmark = (pageIndex) => {
        if (this._activeSidebar !== 'bookmarks') this._requestSidebar('bookmarks');
        this._bookmarksPanel.addAtPage(pageIndex);
      };
    }

    // The highlight card's "show in comments panel" verb routes here.
    if (this._commentsPanel) {
      this.scribe._revealCommentInPanel = (uiWord) => {
        if (this._activeSidebar !== 'comments') this._requestSidebar('comments');
        this._commentsPanel.reveal(uiWord);
      };
      // A quiet rebuild after a comment/note is edited elsewhere (mini toolbar, note card), so an open panel reflects it at once.
      this.scribe._rebuildCommentsPanel = () => this._commentsPanel.rebuild();
    }

    container.appendChild(this.pdfViewerElem);

    // The thumbnails and bookmarks icons are radio-with-deselect toggles for one shared left sidebar.
    if (this.toolbarElem) {
      if (this._thumbnailPanel) this._thumbnailPanel.toggleElem.addEventListener('click', () => this._requestSidebar('thumbnails'));
      if (this._bookmarksPanel) this._bookmarksPanel.toggleElem.addEventListener('click', () => this._requestSidebar('bookmarks'));
      if (this._commentsPanel) this._commentsPanel.toggleElem.addEventListener('click', () => this._requestSidebar('comments'));
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
    // `deferText` paints the first page before text extraction finishes.
    // The trailing `await doc.textReady` keeps this method's "resolved means fully loaded" contract for programmatic callers,
    // even though the UI already painted and never waits on it.
    const doc = await openDocumentFromFile(file, { deferText: true });
    const displaced = await this._setDoc(doc, initialPage, true, terminatePrevious);
    await doc.textReady;
    return displaced;
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
    if (this._bookmarksPanel && this._thumbnailPanel) {
      this._bookmarksPanel.rebuild();
      // Hide the toggle for a document with no bookmarks unless editing (where the user can add them).
      const hasOutline = !!(doc.outline && doc.outline.length);
      this._bookmarksPanel.toggleElem.style.display = (hasOutline || this.scribe.opt.enablePageEditing) ? '' : 'none';
      // A load is not a user toggle: if the new document hides the bookmarks toggle while bookmarks is the open view,
      // fall back to thumbnails immediately (no slide) so the sidebar never shows a view whose toggle is gone.
      if (this._activeSidebar === 'bookmarks' && this._bookmarksPanel.toggleElem.style.display === 'none') {
        this._activeSidebar = 'thumbnails';
        const tEl = this._thumbnailPanel.panelElem;
        tEl.style.transition = 'none';
        this._thumbnailPanel.setVisible(true);
        this._thumbnailPanel.toggleElem.classList.add('active');
        this._bookmarksPanel.setVisible(false);
        this._bookmarksPanel.toggleElem.classList.remove('active');
        requestAnimationFrame(() => { tEl.style.transition = ''; });
      }
    }

    if (this._commentsPanel && this._thumbnailPanel) {
      this._commentsPanel.rebuild();
      // Hide the toggle for a document with no comments unless editing (where the user can add them).
      const hasComments = ((doc.annotations && doc.annotations.pages) || []).some((p) => (p || []).some((a) => a.comment || a.type === 'text'));
      this._commentsPanel.toggleElem.style.display = (hasComments || this.scribe.opt.enablePageEditing) ? '' : 'none';
      // As with bookmarks: if a load hides the comments toggle while comments is the open view, fall back to thumbnails.
      if (this._activeSidebar === 'comments' && this._commentsPanel.toggleElem.style.display === 'none') {
        this._activeSidebar = 'thumbnails';
        const tEl = this._thumbnailPanel.panelElem;
        tEl.style.transition = 'none';
        this._thumbnailPanel.setVisible(true);
        this._thumbnailPanel.toggleElem.classList.add('active');
        this._commentsPanel.setVisible(false);
        this._commentsPanel.toggleElem.classList.remove('active');
        requestAnimationFrame(() => { tEl.style.transition = ''; });
      }
    }

    // Off the critical path: the displaced document's workers die asynchronously while the new page renders.
    // Safe because each document's workers and fonts are namespaced by a unique docId.
    if (terminatePrev && displaced) displaced.terminate().catch(() => {});

    this.scribe.runSetInitial = true;
    await this.scribe.displayPage(initialPage, initialPage > 0);

    // Deferred import painted the page raster-only, so rebuild the text-dependent surfaces once extraction lands.
    // Text that imported synchronously has no deferred phase and skips this.
    if (doc._textReadySettle) {
      doc.textReady.then(() => {
        if (this.doc !== doc) return;
        this.scribe.displayPage(this.scribe.state.cp.n, false, true);
        if (this._commentsPanel && this._thumbnailPanel) {
          this._commentsPanel.rebuild();
          const hasCommentsNow = ((doc.annotations && doc.annotations.pages) || []).some((p) => (p || []).some((a) => a.comment || a.type === 'text'));
          // Extraction can only reveal comments, never remove them, so no sidebar fallback is needed here.
          this._commentsPanel.toggleElem.style.display = (hasCommentsNow || this.scribe.opt.enablePageEditing) ? '' : 'none';
        }
      });
    }

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
    if (this._bookmarksPanel) this._bookmarksPanel.rebuild();
    if (this._commentsPanel) this._commentsPanel.rebuild();

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
    const extOf = (f) => ((f.name || '').match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
    /** @param {File} f */
    const isPdf = (f) => extOf(f) === 'pdf' || f.type === 'application/pdf';
    /**
     * Return the lowercase file extension of a file, without the leading dot.
     * @param {File} f
     * @returns {string}
     */
    const isSupported = (f) => isPdf(f) || SUPPORTED_OPEN_EXT.has(extOf(f)) || (f.type || '').startsWith('image/');

    // Reject unsupported types up front so a `.py`/`.docx`/... does not open as an empty tab.
    for (const f of list.filter((x) => !isSupported(x))) {
      this._showToast(`Can't open “${f.name || 'this file'}” — Scribe opens PDFs, images, and scanned-text files.`);
    }
    const supported = list.filter(isSupported);
    const pdfs = supported.filter(isPdf);
    const others = supported.filter((f) => !isPdf(f));

    /** @type {Array<{ doc: import('../../js/containers/scribeDoc.js').ScribeDoc, name: string }>} */
    const opened = [];
    for (const pdf of pdfs) {
      let doc = null;
      try {
        // deferText: the tab displays immediately. Extraction continues behind `doc.textReady`.
        doc = await openDocumentFromFile(pdf, { deferText: true });
        // A readable PDF yields pages, so zero pages means the bytes were unusable and the open failed.
        if (!doc || doc.inputData.pageCount === 0) throw new Error('no pages');
        opened.push({ doc, name: pdf.name || 'Document' });
      } catch (err) {
        // The cause is unknown here (a read error like NotFound, unusable bytes, an internal format we don't handle, ...), so the message stays generic.
        console.error(`Failed to open ${pdf.name}:`, err);
        if (doc) await doc.terminate().catch(() => {});
        this._showToast(`Couldn't open “${pdf.name}” — the file couldn't be loaded.`);
      }
    }
    // Images/OCR/.scribe are opened together into one document, the way the core import combines them.
    if (others.length > 0) {
      let doc = null;
      try {
        doc = await scribe.openDocument(others);
        if (!doc || doc.inputData.pageCount === 0) throw new Error('no pages');
        const name = others.length === 1 ? others[0].name : `${others[0].name} +${others.length - 1}`;
        opened.push({ doc, name });
      } catch (err) {
        console.error('Failed to open files:', err);
        if (doc) await doc.terminate().catch(() => {});
        const single = others.length === 1;
        const label = single ? `“${others[0].name}”` : 'the selected files';
        this._showToast(`Couldn't open ${label} — ${single ? 'the file' : 'they'} couldn't be loaded.`);
      }
    }
    if (opened.length === 0) return;

    for (const t of opened) this._tabs.push({ doc: t.doc, name: t.name, lastPage: 0 });
    await this._activateTab(this._tabs.length - 1);
    // The active tab already painted. This await keeps the "openFiles resolved means all documents fully loaded" contract for callers.
    await Promise.all(opened.map((t) => t.doc.textReady));
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
   * Open a new document (tab) that concatenates every open document's pages, in tab order.
   * Each source is exported to a self-contained PDF capturing its current edits
   * (page order, rotation, bookmarks, highlights, OCR), the exports are merged object-level (never rasterized), and the result is re-imported as a new tab.
   * The source tabs stay open and unchanged.
   * Each source becomes a top-level bookmark named after its tab, with that source's own bookmarks nested beneath, so combining preserves the inputs' navigation.
   * @returns {Promise<void>}
   */
  async combineOpenDocuments() {
    if (this._tabs.length < 2) return;
    try {
      const buffers = [];
      const outlineParts = [];
      let pageOffset = 0;
      for (const tab of this._tabs) {
        const { doc } = tab;
        buffers.push(await doc.exportData('pdf', { displayMode: 'invis', addOverlay: true }));
        outlineParts.push({
          nodes: doc.outline || [],
          pageOffset,
          wrapperTitle: tab.name.replace(/\.pdf$/i, ''),
        });
        pageOffset += doc.pageMetrics.length;
      }
      const merged = await mergePdfs(buffers, { outline: concatOutlines(outlineParts) });
      const combinedDoc = await openDocumentFromFile(new Blob([merged], { type: 'application/pdf' }));
      this._tabs.push({ doc: combinedDoc, name: 'Combined.pdf', lastPage: 0 });
      await this._activateTab(this._tabs.length - 1);
    } catch (err) {
      console.error('Failed to combine open documents:', err);
    }
  }

  /**
   * Split the active document at its top-level bookmarks: each segment (see `outlineSplitSegments`) is exported to its own self-contained PDF,
   * carrying that range's own nested bookmarks, and opened as a new tab named after its bookmark.
   * The original document stays open.
   * A no-op unless the split would yield 2+ documents.
   * @returns {Promise<void>}
   */
  async splitAtBookmarks() {
    const srcDoc = this.scribe.doc;
    if (!srcDoc) return;
    const leadTitle = `${(this._tabs[this._activeTab]?.name || 'Document').replace(/\.pdf$/i, '')} (front matter)`;
    const segments = outlineSplitSegments(srcDoc.outline || [], srcDoc.pageMetrics.length, leadTitle);
    if (segments.length < 2) return;
    // Build every piece before touching the tab list, so a mid-split failure leaves no partial tabs behind.
    /** @type {Array<{ doc: import('../../js/containers/scribeDoc.js').ScribeDoc, name: string }>} */
    const pieces = [];
    try {
      for (const seg of segments) {
        const bytes = await srcDoc.exportData('pdf', { displayMode: 'invis', addOverlay: true, pageArr: seg.pageArr });
        const doc = await openDocumentFromFile(new Blob([bytes], { type: 'application/pdf' }));
        pieces.push({ doc, name: `${seg.title}.pdf` });
      }
    } catch (err) {
      console.error('Failed to split the document at its bookmarks:', err);
      await Promise.all(pieces.map((p) => p.doc.terminate().catch(() => {})));
      return;
    }
    const firstNewTab = this._tabs.length;
    for (const p of pieces) this._tabs.push({ doc: p.doc, name: p.name, lastPage: 0 });
    await this._activateTab(firstNewTab);
  }

  /**
   * Open a file picker and insert the chosen PDF/image pages into the active document at `index`.
   * @param {number} index - Insertion index in the active document (0..pageCount).
   */
  _pickFilesToInsert(index) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,image/*';
    input.multiple = true;
    input.style.display = 'none';
    input.addEventListener('change', async () => {
      const picked = input.files;
      input.remove();
      if (picked && picked.length) await this.insertPagesFromFiles(picked, index);
    });
    document.body.appendChild(input);
    input.click();
  }

  /**
   * Insert the pages of one or more files (PDFs and/or images) into the active document at `index`, in place.
   * Each file is opened as a throwaway document and its pages are copied in object-level (undoable per file), then the throwaway is terminated.
   * The inserted pages keep rendering and exporting from its retained (refcounted) render source.
   * PDFs are inserted individually, then any images as one grouped block, mirroring the Open button.
   * @param {FileList|Array<File>} files
   * @param {number} index - Insertion index in the active document (0..pageCount).
   * @returns {Promise<void>}
   */
  async insertPagesFromFiles(files, index) {
    const targetDoc = this.scribe.doc;
    const list = Array.from(files || []);
    if (!targetDoc || list.length === 0) return;
    const isPdf = (f) => /\.pdf$/i.test(f.name || '') || f.type === 'application/pdf';
    const pdfs = list.filter(isPdf);
    const images = list.filter((f) => !isPdf(f));
    const at0 = Math.max(0, Math.min(index, targetDoc.pageMetrics.length));
    let at = at0;
    /** @type {Array<import('../../js/containers/scribeDoc.js').ScribeDoc>} */
    const temps = [];
    try {
      for (const pdf of pdfs) temps.push(await openDocumentFromFile(pdf));
      if (images.length > 0) temps.push(await scribe.openDocument(images));
      let landingCp = this.scribe.state.cp.n;
      for (const temp of temps) {
        const bundles = temp.copyPages(temp.pageMetrics.map((_, i) => i));
        if (bundles.length === 0) continue;
        // Inserting must not yank the reader to the new pages: keep the page they were viewing (it shifts down if the block lands at or before it).
        // Mirrors delete/reorder, which also keep the current page.
        const range = this.scribe.pastePages(bundles, at, { keepCurrentPage: true });
        if (range) landingCp = range.cp;
        at += bundles.length;
      }
      // Update the rail in place (shift the rows below the insertion down and mount the new pages) rather than a full `rebuild`, which would blank and re-render every thumbnail and reset the scroll.
      // Use pastePages' returned landing, not state.cp.n (stale here because the rebuild's displayPage is async),
      // so the rail keeps the reader's page highlighted even when the block lands above it and shifts it down.
      if (at > at0 && this._thumbnailPanel) this._thumbnailPanel.insertPagesAt(at0, at - at0, landingCp);
    } catch (err) {
      console.error('Failed to insert pages from file:', err);
      this._showToast('Couldn’t insert the file — it couldn’t be loaded.');
    } finally {
      await Promise.all(temps.map((d) => d.terminate().catch(() => {})));
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

  /**
   * Height of the fixed top chrome (toolbar, the tab strip when visible, and the message banner when shown), in px.
   * @returns {number}
   */
  _chromeTop() {
    return this.toolbarHeight + (this._tabStripVisible ? TAB_STRIP_HEIGHT : 0) + this._messageBannerHeight;
  }

  /**
   * Lazily build the message layer inside the viewer root: a bottom toast stack and a top banner strip.
   */
  _ensureMessageLayer() {
    if (this._toastStack) return;
    const stack = document.createElement('div');
    stack.className = 'scribe-toast-stack';
    this.pdfViewerElem.appendChild(stack);
    this._toastStack = stack;

    const banner = document.createElement('div');
    banner.className = 'scribe-banner';
    banner.style.display = 'none';
    this.pdfViewerElem.appendChild(banner);
    this._banner = banner;
  }

  /**
   * Show a transient toast.
   * Use when the user is looking and the failure is self-evident (a file didn't open, an export didn't download): the message only adds context, so it auto-dismisses and never blocks.
   * Never a modal.
   * @param {string} message
   */
  _showToast(message) {
    this._ensureMessageLayer();
    const toast = document.createElement('div');
    toast.className = 'scribe-toast';
    toast.setAttribute('role', 'status');
    toast.textContent = message;
    let gone = false;
    const dismiss = () => {
      if (gone) return;
      gone = true;
      toast.classList.add('leaving');
      setTimeout(() => toast.remove(), 200);
    };
    toast.addEventListener('click', dismiss);
    this._toastStack.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('shown'));
    setTimeout(dismiss, 6000);
  }

  /**
   * Show a persistent, dismissible banner below the chrome.
   * Use when the user may be away from the screen or the failure is not self-evident (e.g. recognition failed while they stepped away):
   * it resizes the document area and waits to be acknowledged rather than auto-dismissing.
   * Only one banner shows at a time, so a new message replaces the current one.
   * @param {string} message
   */
  _showBanner(message) {
    this._ensureMessageLayer();
    this._banner.textContent = '';
    const text = document.createElement('span');
    text.className = 'scribe-banner-text';
    text.textContent = message;
    const close = document.createElement('button');
    close.className = 'scribe-banner-close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss');
    close.innerHTML = BANNER_CLOSE_SVG;
    close.addEventListener('click', () => this._hideBanner());
    this._banner.append(text, close);
    this._banner.style.display = 'flex';
    this._messageBannerHeight = MESSAGE_BANNER_HEIGHT;
    this._relayout();
  }

  /** Hide the message banner and give its height back to the document area. */
  _hideBanner() {
    if (!this._banner || this._messageBannerHeight === 0) return;
    this._banner.style.display = 'none';
    this._messageBannerHeight = 0;
    this._relayout();
  }

  /** Re-apply canvas and thumbnail-panel sizing from the current dimensions and chrome height. */
  _relayout() {
    if (!this.scribe.scrollContainer) return;
    const top = this._chromeTop();
    // The banner occupies the strip just above the document area (below toolbar + tab strip).
    if (this._messageBannerHeight && this._banner) this._banner.style.top = `${top - this._messageBannerHeight}px`;
    if (this._thumbnailPanel) {
      this._thumbnailPanel.panelElem.style.top = `${top}px`;
      this._thumbnailPanel.panelElem.style.height = `${this._height - top}px`;
    }
    if (this._bookmarksPanel) {
      this._bookmarksPanel.panelElem.style.top = `${top}px`;
      this._bookmarksPanel.panelElem.style.height = `${this._height - top}px`;
    }
    if (this._commentsPanel) {
      this._commentsPanel.panelElem.style.top = `${top}px`;
      this._commentsPanel.panelElem.style.height = `${this._height - top}px`;
    }
    // A sidebar animation owns the document inset and canvas size on its own clock, so don't fight it here.
    // The panel top/height set above are still safe to keep in sync every frame.
    if (this._sidebarAnim) return;
    // Inset the document by the open view's width so it centers in the area beside the sidebar, not under it.
    // Keep at least a sliver of document even if the panel is wider than the viewport.
    const activePanel = this._activeSidebar === 'thumbnails' ? this._thumbnailPanel
      : (this._activeSidebar === 'bookmarks' ? this._bookmarksPanel
        : (this._activeSidebar === 'comments' ? this._commentsPanel : null));
    const panelW = activePanel ? (parseFloat(activePanel.panelElem.style.width) || 0) : 0;
    const inset = Math.min(panelW, Math.max(0, this._width - 80));
    this.scribe.scrollContainer.style.marginLeft = `${inset}px`;
    this.scribe.resize(this._width - inset, this._height - top);
    // The scrollbar refresh rereads the scroll metrics the resize above just invalidated, forcing a synchronous reflow.
    if (this._updateScrollbars && !this._sidebarDragActive) this._updateScrollbars();
  }

  /**
   * The panel handle backing a sidebar view, or null.
   * @param {'thumbnails'|'bookmarks'|'comments'|null} key
   * @returns {?ReturnType<typeof createThumbnailPanel> | ?ReturnType<typeof createBookmarksPanel> | ?ReturnType<typeof createCommentsPanel>}
   */
  _panelFor(key) {
    if (key === 'thumbnails') return this._thumbnailPanel;
    if (key === 'bookmarks') return this._bookmarksPanel;
    if (key === 'comments') return this._commentsPanel;
    return null;
  }

  /**
   * Handle a click on a sidebar view's toolbar icon (the radio group with deselect): open the sidebar to `key`,
   * switch to it in place when the other view is open, or close the sidebar when `key` is already the open view.
   * @param {'thumbnails'|'bookmarks'|'comments'} key
   */
  _requestSidebar(key) {
    if (!this._panelFor(key)) return;
    const prev = this._activeSidebar;
    const next = prev === key ? null : key; // clicking the open view closes the sidebar
    if (next === prev) return;
    this._activeSidebar = next;
    if (this._thumbnailPanel) this._thumbnailPanel.toggleElem.classList.toggle('active', next === 'thumbnails');
    if (this._bookmarksPanel) this._bookmarksPanel.toggleElem.classList.toggle('active', next === 'bookmarks');
    if (this._commentsPanel) this._commentsPanel.toggleElem.classList.toggle('active', next === 'comments');
    this._transitionSidebar(prev, next);
  }

  /**
   * Apply a sidebar resize dragged from the bookmarks or comments view, keeping every view one shared width.
   * @param {number} desiredWidth
   * @param {'start'|'move'|'end'} phase
   */
  _resizeSidebar(desiredWidth, phase) {
    if (!this._thumbnailPanel || !this._bookmarksPanel) return;
    if (phase === 'start') {
      // One layout read here lets every move clamp with pure arithmetic.
      this._sidebarResizeBounds = this._thumbnailPanel.getResizeBounds();
      this._beginSidebarResize();
      return;
    }
    if (phase === 'end') {
      const applied = this._thumbnailPanel.setWidth(desiredWidth);
      this._bookmarksPanel.panelElem.style.width = `${applied}px`;
      if (this._commentsPanel) this._commentsPanel.panelElem.style.width = `${applied}px`;
      this._sidebarResizeBounds = null;
      this._endSidebarResize();
      return;
    }
    const b = this._sidebarResizeBounds;
    const applied = b ? Math.max(b.min, Math.min(b.max, desiredWidth)) : desiredWidth;
    this._bookmarksPanel.panelElem.style.width = `${applied}px`;
    if (this._commentsPanel) this._commentsPanel.panelElem.style.width = `${applied}px`;
    this._relayout();
  }

  /** Enter a sidebar resize drag; paired with `_endSidebarResize` at release. */
  _beginSidebarResize() {
    this._sidebarDragActive = true;
    this.scribe.startInteractionTextHide();
  }

  /** End a sidebar resize drag: settle the document area, then restore the text layers. */
  _endSidebarResize() {
    this._sidebarDragActive = false;
    // Settle while the layers are still hidden so the scrollbar refresh's forced reflow stays cheap.
    this._relayout();
    this.scribe.endInteractionTextHide();
  }

  /**
   * Animate the left sidebar between its states as one coherent motion: open and close slide the view in/out from the dock edge,
   * and a switch crossfades the two views in place.
   * The document inset is tweened from the outgoing width to the incoming width on the same clock, so the page never snaps.
   * @param {'thumbnails'|'bookmarks'|'comments'|null} prevKey - The view that was open (null if the sidebar was closed).
   * @param {'thumbnails'|'bookmarks'|'comments'|null} nextKey - The view to show (null to close the sidebar).
   */
  _transitionSidebar(prevKey, nextKey) {
    if (!this.scribe.scrollContainer) return;
    // Interrupt any in-flight transition by stopping its clock.
    // The new setup overwrites the inline styles it was driving, and its transition settles the panels' shown/hidden state.
    if (this._sidebarAnim) { cancelAnimationFrame(this._sidebarAnim.raf); this._sidebarAnim = null; }

    // A non-thumbnails view adopts the thumbnail view's current width before measuring, so all share one edge.
    if (nextKey === 'bookmarks' && this._thumbnailPanel && this._bookmarksPanel) {
      this._bookmarksPanel.panelElem.style.width = this._thumbnailPanel.panelElem.style.width;
    }
    if (nextKey === 'comments' && this._thumbnailPanel && this._commentsPanel) {
      this._commentsPanel.panelElem.style.width = this._thumbnailPanel.panelElem.style.width;
    }
    const fromPanel = this._panelFor(prevKey);
    const toPanel = this._panelFor(nextKey);
    const fromEl = fromPanel ? fromPanel.panelElem : null;
    const toEl = toPanel ? toPanel.panelElem : null;
    const fromW = fromEl ? (parseFloat(fromEl.style.width) || 0) : 0;
    const toW = toEl ? (parseFloat(toEl.style.width) || 0) : 0;
    const top = this._chromeTop();
    const isSwitch = !!fromPanel && !!toPanel;

    const setInset = (/** @type {number} */ raw) => {
      const inset = Math.min(Math.max(0, raw), Math.max(0, this._width - 80));
      this.scribe.scrollContainer.style.marginLeft = `${inset}px`;
      this.scribe.resize(this._width - inset, this._height - top);
    };

    const cleanup = () => {
      this._sidebarAnim = null;
      // Settle the incoming view at rest (shown, no inline transform/opacity), then hide and tear down the outgoing view.
      // Both snaps run under transition:none so no stray CSS transition fires.
      // Restore transitions next frame, once the resting styles have committed.
      if (toEl) { toEl.style.transition = 'none'; toEl.style.transform = ''; toEl.style.opacity = ''; }
      if (fromPanel && fromEl) {
        fromEl.style.transition = 'none';
        fromPanel.setVisible(false); // releases focus, unmounts thumbnails after its own slide window, snaps off-screen
        fromEl.style.opacity = '';
      }
      requestAnimationFrame(() => {
        if (toEl) toEl.style.transition = '';
        if (fromEl) fromEl.style.transition = '';
      });
      this._relayout();
    };
    // Mark the transition in flight before mounting the incoming view: its `setVisible` fires an onResize -> _relayout
    // that must yield the inset to this tween rather than snapping it.
    const anim = { raf: 0 };
    this._sidebarAnim = anim;

    if (toPanel) toPanel.setVisible(true); // mount + render the incoming view before it fades/slides in
    // Own transform + opacity for the duration; CSS transitions off so the JS clock is the sole driver.
    if (toEl) {
      toEl.style.transition = 'none';
      toEl.style.opacity = isSwitch ? '0' : '1';
      toEl.style.transform = isSwitch ? 'translateX(0)' : `translateX(-${toW}px)`;
    }
    if (fromEl) {
      fromEl.style.transition = 'none';
      fromEl.style.opacity = '1';
      fromEl.style.transform = 'translateX(0)';
    }
    setInset(fromW); // start at the outgoing width (0 when opening from closed)

    /** @type {?number} */
    let startTs = null;
    const frame = (/** @type {number} */ ts) => {
      if (startTs === null) startTs = ts;
      const p = Math.min(1, (ts - startTs) / SIDEBAR_ANIM_MS);
      const e = 1 - (1 - p) ** 3; // ease-out, ~matching the panel's CSS `ease`
      if (isSwitch) {
        if (toEl) toEl.style.opacity = String(e);
        if (fromEl) fromEl.style.opacity = String(1 - e);
      } else if (toEl) {
        toEl.style.transform = `translateX(-${toW * (1 - e)}px)`; // slide the incoming view in
      } else if (fromEl) {
        fromEl.style.transform = `translateX(-${fromW * e}px)`; // slide the outgoing view out
      }
      setInset(fromW + (toW - fromW) * e);
      // Keep looping only while this transition is still the current one; an interrupt/destroy replaces or nulls it.
      if (p < 1) { if (this._sidebarAnim === anim) anim.raf = requestAnimationFrame(frame); } else cleanup();
    };
    anim.raf = requestAnimationFrame(frame);
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
    if (this._sidebarAnim) { cancelAnimationFrame(this._sidebarAnim.raf); this._sidebarAnim = null; }
    if (this._thumbnailPanel) this._thumbnailPanel.destroy();
    if (this._bookmarksPanel) this._bookmarksPanel.destroy();
    if (this._commentsPanel) this._commentsPanel.destroy();
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
