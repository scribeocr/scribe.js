import scribe from '../../scribe.js';
import { ScribeViewer } from '../viewer.js';
// Both engines are imported so `ScribeViewer.customSelection` can toggle between them at runtime.
// Import only one for a slimmer build.
import '../js/selection/customSelectionEngine.js';
import '../js/selection/domSelectionEngine.js';
import { applyHighlight } from '../js/viewerHighlights.js';
import { destroyContextMenu } from '../js/viewerCanvasInteraction.js';
import {
  addControlStyles, makeToolbarShell, makeSeparator, makeIconButton, createPageNav, createZoomControls, createRotateControls, createPrintControls, createOpenControls, createTabStrip, createSearchBar,
  createAppMenu, OPEN_SVG, PRINT_SVG, ROTATE_LEFT_SVG, ROTATE_RIGHT_SVG,
} from '../js/controls/toolbar.js';
import { createThumbnailPanel, createScrollbars, THUMB_SVG } from '../js/controls/panels.js';
import { createCompanionStrip } from '../js/controls/companionStrip.js';
import { createPagesMorph } from '../js/controls/pagesMorph.js';
import { createBookmarksPanel } from '../js/controls/bookmarksPanel.js';
import { createCommentsPanel } from '../js/controls/commentsPanel.js';
import {
  createHighlightTool, createNoteTool, createDropZone, openDocumentFromFile, createRedactTool,
} from '../js/controls/tools.js';
import { filesFromDropEvent } from '../js/dragAndDrop.js';
import { mergePdfs } from '../../js/export/pdf/mergePdfs.js';
import { concatOutlines, outlineSplitSegments } from '../../js/objects/outlineObjects.js';
import { selectOcrPages } from '../../js/pdf/ocrPageSelection.js';
import { DEBUG_MENU } from '../devFlags.js';

/** Root class used to scope this app's control styles. */
const ROOT_CLASS = 'scribe-pdf-viewer';

// Toolbar height bounds (px).
const TOOLBAR_HEIGHT_DEFAULT = 40;
const TOOLBAR_HEIGHT_MIN = 24;
const TOOLBAR_HEIGHT_MAX = 80;

/** Height of the document tab strip (shown only with 2+ open tabs), in px. */
const TAB_STRIP_HEIGHT = 30;

const SHEET_PLUS_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 6v12M6 12h12"/></svg>';

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

/** localStorage key for the persisted theme setting ('system' | 'light' | 'dark'). */
const THEME_STORAGE_KEY = 'scribe-theme';

/** Chevron-down for the Recognize Text split button's language caret. */
const CARET_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M7 10l5 5 5-5z" fill="currentColor"/></svg>';

/**
 * Wrap SVG path markup in a stroked 24x24 icon, matching the toolbar's line-icon style.
 * @param {string} inner - Inner SVG markup (paths, shapes) placed inside the icon.
 * @param {number} [w] - Stroke width.
 * @returns {string}
 */
const editIcon = (inner, w = 1.6) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ICON_EXPORT = editIcon('<path d="M12 4v10m0 0l-3.5-3.5M12 14l3.5-3.5M5 19h14"/>');
const ICON_COMBINE = editIcon('<path d="M4 8h9v9H4zM11 5h9v9"/>');
const ICON_SPLIT = editIcon('<circle cx="6" cy="7" r="2.1"/><circle cx="6" cy="17" r="2.1"/><path d="M8 8l11 8M8 16L19 8"/>');
/** Crescent moon for the app menu's Dark mode toggle. */
const ICON_DARK = editIcon('<path d="M20.5 13.5A8 8 0 0 1 10.5 3.5 7 7 0 1 0 20.5 13.5Z"/>');
/** Scan corners around a letterform, for the touch-only Recognize text menu row. */
// eslint-disable-next-line max-len
const ICON_RECOGNIZE = editIcon('<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><path d="M9 15V9.8A0.8 0.8 0 0 1 9.8 9h4.4a0.8 0.8 0 0 1 0.8 0.8V15M9 12.6h6"/>');

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
   * @param {boolean} [options.coarsePointer] - Size controls for a touch-primary device.
   *   Defaults to the `(pointer: coarse)` media query; pass explicitly to override.
   * @param {boolean} [options.edit=true] - Enable editing: page ops (reorder/delete/rotate/insert), text recognition,
   *   redaction, the Export/Combine/Split app-menu actions, and the dark-mode toggle. Pass `false` for a lean read-only viewer.
   * @param {boolean} [options.redact=edit] - Enable redaction marks, reached through the context menu's "Redact".
   *   Defaults to `edit`. Pass `false` to keep editing on but redaction off. Ignored when `edit` is false.
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
      edit = true,
      redact = edit,
    } = options;

    this.container = container;
    this.showToolbar = showToolbar;
    this.showDropZone = showDropZone;
    this.showScrollbars = showScrollbars;
    this.showThumbnails = showThumbnails;
    this._editEnabled = edit;
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
    if (edit) {
      this.scribe.opt.enablePageEditing = true;
      this.scribe.opt.enableRecognition = true;
    }

    /**
     * @type {?{imgDims: {width: number, height: number}, docW: number, zoom: number, isDefaultFit: boolean, widthMode: boolean}}
     *   Last automatic fit, so a resize can re-run it.
     *   `docW` is the widest page, not the first.
     */
    this._autoFit = null;

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

    this._coarsePointer = options.coarsePointer
      ?? !!(typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches);

    /** True while the phone layout is active: the top toolbar is replaced by the bottom dock and the side panels by the bottom sheet. */
    this._phoneChrome = false;
    /** @type {?HTMLDivElement} The phone bottom dock, built on first phone-mode entry. */
    this._dockElem = null;
    /** @type {?ReturnType<typeof createCompanionStrip>} Persistent page filmstrip + scrubber above the dock (phone only). */
    this._companionStrip = null;
    /** @type {?HTMLSpanElement} The dock's Panels button (opens the bottom sheet). */
    this._sheetPanelsBtn = null;
    /** @type {?HTMLDivElement} */
    this._sheetElem = null;
    /** @type {?HTMLDivElement} */
    this._sheetScrimElem = null;
    /** @type {?HTMLDivElement} Sheet body that hosts the re-homed bookmarks/comments panels while the phone layout is active. */
    this._sheetContentElem = null;
    /** @type {Partial<Record<'bookmarks'|'comments', HTMLButtonElement>>} Sheet segmented-control buttons by view. */
    this._sheetSegBtns = {};
    this._sheetOpen = false;
    /** @type {'bookmarks'|'comments'} The sheet view last shown (restored on reopen). */
    this._sheetView = 'bookmarks';
    /** @type {?HTMLButtonElement} The sheet header's action button (+): add bookmark / new note, following the active view. */
    this._sheetActBtn = null;
    /** @type {?(() => void)} Detaches the visual-viewport listeners of an active composer keyboard lift. */
    this._composeLiftOff = null;
    /** Sheet header drag in progress (or its snap still settling): the document lays out full-height behind the sheet. */
    this._sheetDragLayout = false;
    /** @type {?ReturnType<typeof setTimeout>} Timer restoring the sheet inset once the release snap lands. */
    this._sheetRelayoutT = null;
    /** @type {?HTMLDivElement} Full-height Pages room the companion strip expands into, above the dock. */
    this._pagesRoomElem = null;
    /** @type {?HTMLDivElement} Pages-room body that hosts the re-homed thumbnail panel while the phone layout is active. */
    this._roomBodyElem = null;
    /** @type {?HTMLSpanElement} */
    this._roomCountElem = null;
    this._roomOpen = false;
    this._roomEditing = false;
    /** @type {?HTMLButtonElement} Edit/Save mode toggle in the room header. */
    this._roomEditBtn = null;
    /** @type {?HTMLButtonElement} The room-closing Done, hidden while editing (Save and Discard exit the mode). */
    this._roomDoneBtn = null;
    /** @type {?HTMLButtonElement} Discard-the-session button beside Save, shown only while editing. */
    this._roomRevertBtn = null;
    /** Undo-stack depth at Edit entry (-1 outside Edit): Discard unwinds page ops back to exactly this depth. */
    this._roomEditBaseline = -1;
    /** @type {?ReturnType<typeof import('../js/controls/pagesMorph.js').createPagesMorph>} Strip-to-room pull-up morph. */
    this._pagesMorph = null;

    addControlStyles(ROOT_CLASS);

    this.pdfViewerElem = document.createElement('div');
    this.pdfViewerElem.className = ROOT_CLASS;
    // State class, not a media query, so the coarse CSS follows the same override/test hook as the JS sizing.
    if (this._coarsePointer) this.pdfViewerElem.classList.add('scribe-coarse');
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
    let toolbarHeightResolved = Number.isFinite(toolbarHeightNum)
      ? Math.min(TOOLBAR_HEIGHT_MAX, Math.max(TOOLBAR_HEIGHT_MIN, toolbarHeightNum))
      : TOOLBAR_HEIGHT_DEFAULT;
    // 44px touch targets need a 56px bar (icons are sized bar - 12).
    if (this._coarsePointer) toolbarHeightResolved = Math.max(toolbarHeightResolved, 56);
    this.toolbarHeight = showToolbar ? toolbarHeightResolved : 0;
    // Icons/page-input/text are sized 12px shorter than the bar (~6px of vertical air above and below), clamped to [16, 32] ([16, 44] on coarse pointers).
    const toolbarIconSize = Math.max(16, Math.min(this._coarsePointer ? 44 : 32, this.toolbarHeight - 12));

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
        // Browse-mode double-tap: navigate, then close the room that covers the viewer.
        // The await matters: the close morph must anchor its collapse on the new active page, which displayPage updates asynchronously.
        onPageOpen: async (n) => { await this.scribe.displayPage(n, true, false); this._closePagesRoom(); },
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
        onRenameFocus: (focused) => { if (this._phoneChrome) this._sheetComposeLift(focused); },
      })
      : null;

    /** @type {?ReturnType<typeof createCommentsPanel>} */
    this._commentsPanel = (showThumbnails && comments)
      ? createCommentsPanel(this.scribe, {
        onNavigate: (dest) => this.scribe.goToOutlineDest(dest),
        onResize: (w, phase) => this._resizeSidebar(w, phase),
        onComposeFocus: (focused) => this._sheetComposeLift(focused),
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
      // Touch-only rows re-homing the controls the touch layouts drop from the bar.
      appMenu.addAction('Rotate left', ROTATE_LEFT_SVG, () => this.scribe.rotatePage(this.scribe.state.cp.n, -90))
        .classList.add('scribe-touch-row');
      appMenu.addAction('Rotate right', ROTATE_RIGHT_SVG, () => this.scribe.rotatePage(this.scribe.state.cp.n, 90))
        .classList.add('scribe-touch-row');
      if (DEBUG_MENU) {
        import('../js/controls/debugMenu.js')
          .then(({ installDebugMenu }) => installDebugMenu(appMenu, this.scribe, (files) => this.openFiles(files), this))
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
      // On touch, zoom lives in the pinch and double-tap gestures and rotate is rare enough for the app menu, so both clusters and their separators leave the bar.
      const sepBeforeRotate = makeSeparator();
      sepBeforeRotate.classList.add('scribe-touch-hide');
      rotate.rotateControls.classList.add('scribe-touch-hide');
      const sepBeforeZoom = makeSeparator();
      sepBeforeZoom.classList.add('scribe-touch-hide');
      zoom.zoomControls.classList.add('scribe-touch-hide');
      toolbarButtons.appendChild(sepBeforeRotate);
      toolbarButtons.appendChild(rotate.rotateControls);
      toolbarButtons.appendChild(sepBeforeZoom);
      toolbarButtons.appendChild(zoom.zoomControls);
      if (this._highlightTool) {
        toolbarButtons.appendChild(makeSeparator());
        toolbarButtons.appendChild(this._highlightTool.toolbarElem);
      }
      if (this._noteTool) toolbarButtons.appendChild(this._noteTool.toolbarElem);
      // Retained so the editor subclass can extend the center button cluster (e.g. its Redact tool).
      this._toolbarButtonsElem = toolbarButtons;

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
      // Retained because the phone dock borrows the group (`_setPhoneChrome`) and must return it beside `nextElem`.
      this._pageInputGroup = pageNav.pageInputGroup;
      this.pageNumElem.addEventListener('input', () => this._syncDockPageNumWidth());
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

    // Phone layout: the component's own size decides, so a narrow embed in a wide window behaves like a phone.
    // The coarse-pointer height test keeps landscape phones in the phone layout: one-handed reach is about the device, not the orientation.
    this._setPhoneChrome(initWidth <= 480 || (this._coarsePointer && initHeight <= 480));

    this._installFit(fit, options.fit === undefined);

    this.scribe.init(this.viewerContainer, initWidth, initHeight - this._chromeTop() - this._chromeBottom());

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

    // The on-screen keyboard shrinks the visual viewport but not the layout viewport, so bottom-anchored bars (the phone find bar) would sit underneath it.
    // --scribe-kb-inset publishes the keyboard's overlap with this component's bottom edge; the phone CSS lifts the find bar by it.
    if (window.visualViewport) {
      const vv = window.visualViewport;
      const updateKbInset = () => {
        const kbTop = vv.offsetTop + vv.height;
        const inset = Math.max(0, Math.round(this.pdfViewerElem.getBoundingClientRect().bottom - kbTop));
        this.pdfViewerElem.style.setProperty('--scribe-kb-inset', `${inset}px`);
      };
      vv.addEventListener('resize', updateKbInset);
      vv.addEventListener('scroll', updateKbInset);
      this._teardownCallbacks.push(() => {
        vv.removeEventListener('resize', updateKbInset);
        vv.removeEventListener('scroll', updateKbInset);
      });
    }

    // Selection-driven highlighting + comment marks (needs `scribe.elem`, so wired after init).
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
      this._syncDockPageNumWidth();
      // Keep the navbar total in sync with the live page count. Every op that changes the count (paste, insert, delete, move, undo/redo) ends in displayPage, so refreshing here covers them all.
      if (this.pageCountElem && this.doc) this.pageCountElem.textContent = this.doc.inputData.pageCount.toString();
      if (this._updateScrollbars) this._updateScrollbars();
      if (this._thumbnailPanel) this._thumbnailPanel.setActive(this.scribe.state.cp.n);
      if (this._bookmarksPanel) this._bookmarksPanel.setActive(this.scribe.state.cp.n);
      if (this._commentsPanel) this._commentsPanel.setActive(this.scribe.state.cp.n);
      if (this._companionStrip) this._companionStrip.setActive(this.scribe.state.cp.n);
    };

    // The thumbnail panel must fully rebuild after an undo/redo, or stale rows send a later click or delete to the wrong page.
    // Undo/redo only: for ops the panel itself initiates it updates in place, and a rebuild mid-gesture would tear the reorder's DOM out from under the drop animation.
    const origEditCallback = this.scribe.onEditCallback;
    this.scribe.onEditCallback = () => {
      if (origEditCallback) origEditCallback();
      if (this._thumbnailPanel) {
        const len = this.scribe.doc ? this.scribe.doc.pageMetrics.length : 1;
        // The edit invalidated the page indices a pending cut captured, so cancel it.
        this._thumbnailPanel.cancelCut();
        this._thumbnailPanel.rebuild(Math.max(0, Math.min(this.scribe.state.cp.n, len - 1)));
      }
    };

    // Every page-structure or rotation edit must refresh the passive mirrors that render pages by index, or the filmstrip and the bookmarks/comments panels keep showing the pre-edit pages.
    this.scribe.onPageEditCallback = () => {
      if (this._bookmarksPanel) this._bookmarksPanel.rebuild();
      if (this._commentsPanel) this._commentsPanel.rebuild();
      if (this._companionStrip) this._companionStrip.rebuild(this.scribe.state.cp.n);
      // Edits change the counts the sheet and room headers show.
      if (this._sheetOpen) this._syncSheetHeader();
      if (this._roomOpen) this._syncRoomHeader();
      // A bookmark edit can change the top-level bookmark count, so refresh the Split action.
      if (this._editEnabled) this._updateSplitButton();
    };

    // The viewer's right-click "Add bookmark" routes here.
    if (this._bookmarksPanel) {
      this.scribe._addBookmark = (pageIndex) => {
        if (this._phoneChrome) {
          this._openSheet();
          this._showSheetView('bookmarks');
        } else if (this._activeSidebar !== 'bookmarks') this._requestSidebar('bookmarks');
        this._bookmarksPanel.addAtPage(pageIndex);
      };
    }

    // Destructive one-tap actions (the touch callout's delete) report here for a toast with Undo.
    this.scribe._onDestructiveAction = (message, undo) => this._showToast(message, { actionLabel: 'Undo', onAction: undo });

    // The comment card's "show in comments panel" verb routes here.
    if (this._commentsPanel) {
      this.scribe._revealCommentInPanel = /** @param {import('../js/viewerWordObjects.js').UiOcrWord | AnnotationText} target */ (target) => {
        if (this._phoneChrome) {
          this._openSheet();
          this._showSheetView('comments');
        } else if (this._activeSidebar !== 'comments') this._requestSidebar('comments');
        this._commentsPanel.reveal(target);
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

    // Built last: the editing UI extends hooks (app menu, toolbar end zone, find bar, scroll container) that must already exist.
    if (edit) {
      ScribePDFViewer._addEditorStyles();
      this._initTheme();
      if (showToolbar) this._buildEditToolbar();

      /** @type {?ReturnType<typeof createRedactTool>} */
      this._redactTool = null;
      if (redact) {
        // Apply-at-export is the one non-obvious rule, so say it once, at the first mark.
        let redactCueShown = false;
        const onMark = () => {
          if (redactCueShown) return;
          redactCueShown = true;
          this._showToast('Marked for redaction — the content is removed when you export.');
        };
        this._redactTool = createRedactTool(this.scribe, this.pdfViewerElem, { onMark });
        this.scribe._onRedactMark = onMark;
        this._teardownCallbacks.push(this._redactTool.installBehaviors());
      }
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
    if (this._companionStrip) {
      this._companionStrip.rebuild(initialPage);
      this._companionStrip.setVisible(this._phoneChrome);
      // Showing the strip changes the document's bottom inset.
      if (this._phoneChrome && this.scribe.scrollContainer) this._relayout();
    }
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
    // The panel toggles above also decide the phone sheet's tabs.
    this._syncDockPanelsBtn();

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
        // The Recognize verdict depends on the page stats a deferred import produces, so re-evaluate once they land.
        if (this._editEnabled) this._updateRecognizeButton();
        if (this._commentsPanel && this._thumbnailPanel) {
          this._commentsPanel.rebuild();
          const hasCommentsNow = ((doc.annotations && doc.annotations.pages) || []).some((p) => (p || []).some((a) => a.comment || a.type === 'text'));
          // Extraction can only reveal comments, never remove them, so no sidebar fallback is needed here.
          this._commentsPanel.toggleElem.style.display = (hasCommentsNow || this.scribe.opt.enablePageEditing) ? '' : 'none';
          this._syncDockPanelsBtn();
        }
      });
    }

    if (this.dropZone) this.dropZone.style.display = 'none';

    // Refresh the edit actions whose availability depends on the new document (recognizable pages, bookmark count).
    if (this._editEnabled) {
      this._updateRecognizeButton();
      this._updateSplitButton();
    }

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
    this._syncDockPageNumWidth();
    if (this.dropZone) this.dropZone.style.display = '';
    if (this._thumbnailPanel) this._thumbnailPanel.rebuild();
    if (this._bookmarksPanel) this._bookmarksPanel.rebuild();
    if (this._commentsPanel) this._commentsPanel.rebuild();
    if (this._companionStrip) {
      this._companionStrip.rebuild();
      this._companionStrip.setVisible(false);
      // Hiding the strip changes the document's bottom inset.
      if (this._phoneChrome && this.scribe.scrollContainer) this._relayout();
    }

    if (terminatePrev) prev.terminate().catch(() => {});

    // The now-empty viewer has nothing to recognize.
    if (this._editEnabled) this._updateRecognizeButton();

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
    // Combine needs 2+ tabs and Split tracks the active document, so refresh both when the strip changes.
    if (this._editEnabled) {
      this._updateCombineButton();
      this._updateSplitButton();
    }
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
   * Height of the fixed top bars (toolbar, the tab strip when visible, and the message banner when shown), in px.
   * @returns {number}
   */
  _chromeTop() {
    return (this._phoneChrome ? 0 : this.toolbarHeight) + (this._tabStripVisible ? TAB_STRIP_HEIGHT : 0) + this._messageBannerHeight;
  }

  /**
   * Height of the fixed bottom bars (the phone dock plus the visible companion strip), in px, 0 outside the phone layout.
   * @returns {number}
   */
  _chromeBottom() {
    if (!this._phoneChrome || !this._dockElem) return 0;
    // Before the component is attached the dock has no layout yet; 56 is its safe-area-free height.
    const dock = this._dockElem.offsetHeight || 56;
    // The companion strip sits above the dock while visible, so the document insets above it too.
    const strip = this._companionStrip && this._companionStrip.stripElem.classList.contains('on')
      ? this._companionStrip.stripElem.offsetHeight : 0;
    return dock + strip;
  }

  /**
   * Bottom inset for the document area, in px: the fixed bottom bars, grown to the open sheet's top edge in the phone layout.
   * @returns {number}
   */
  _docBottomInset() {
    if (this._phoneChrome && this._sheetOpen && this._sheetElem && this._dockElem) {
      if (this._sheetDragLayout) return this._chromeBottom();
      const dockH = this._dockElem.offsetHeight || 56;
      // Capped at half the viewport so a full-height sheet tucks the page behind it rather than squeezing it to nothing.
      const sheetH = Math.min(this._sheetElem.getBoundingClientRect().height, Math.round(this._height * 0.5));
      return dockH + sheetH;
    }
    return this._chromeBottom();
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
   * @param {object} [options]
   * @param {string} [options.actionLabel] - Label for an inline action button.
   * @param {() => void} [options.onAction] - Runs when the action button is pressed; the toast then dismisses.
   */
  _showToast(message, { actionLabel, onAction } = {}) {
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
    if (actionLabel && onAction) {
      const actionBtn = document.createElement('button');
      actionBtn.type = 'button';
      actionBtn.className = 'scribe-toast-action';
      actionBtn.textContent = actionLabel;
      actionBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        onAction();
        dismiss();
      });
      toast.appendChild(actionBtn);
    }
    toast.addEventListener('click', dismiss);
    this._toastStack.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('shown'));
    setTimeout(dismiss, actionLabel ? 8000 : 6000);
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
    // The phone app menu opens upward from the dock, and this cap keeps long menus scrolling in place instead of running off the top edge.
    if (this._phoneChrome && this._dockElem) {
      this.pdfViewerElem.style.setProperty('--scribe-phone-menu-max', `${Math.max(120, this._height - this._chromeBottom() - 24)}px`);
    }
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
    this.scribe.resize(this._width - inset, this._height - top - this._docBottomInset());
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
    // Crossing the phone threshold switches the layout before the canvas is re-measured.
    this._setPhoneChrome(width <= 480 || (this._coarsePointer && height <= 480));
    if (this.dropZone) {
      const dropTop = this._phoneChrome ? 0 : this.toolbarHeight;
      this.dropZone.style.top = `${dropTop}px`;
      this.dropZone.style.width = `${width - 6}px`;
      this.dropZone.style.height = `${height - dropTop - this._chromeBottom()}px`;
    }
    // _relayout sizes the canvas and panel (its width is user-owned) and insets the document by the panel's width.
    this._relayout();

    // Re-run the automatic fit only when width-fit is involved on either side of the resize and the user is still at that fit, so a user zoom is never overridden.
    // Zooming in place (rather than re-running the fit) keeps the current reading position.
    const af = this._autoFit;
    if (af && af.isDefaultFit && this.scribe.scrollContainer && af.zoom > 0
      && Math.abs(this.scribe.zoomLevel - af.zoom) / af.zoom < 0.05) {
      const sc = this.scribe.scrollContainer;
      const docW = this.scribe._contentWidth || af.docW;
      const hZoom = (sc.clientHeight - 150) / af.imgDims.height;
      const widthMode = this._phoneChrome || hZoom * docW > sc.clientWidth;
      if (widthMode || af.widthMode) {
        const target = widthMode ? sc.clientWidth / docW : hZoom;
        if (target > 0 && Math.abs(target - this.scribe.zoomLevel) / this.scribe.zoomLevel > 0.01) {
          this.scribe.zoom(target / this.scribe.zoomLevel);
          af.zoom = target;
          af.widthMode = widthMode;
        }
      }
    }
  }

  /**
   * Size the page-number input to its value in the dock (a fixed width leaves a lopsided gap beside the right-aligned number); the desktop toolbar keeps its fixed box.
   */
  _syncDockPageNumWidth() {
    if (!this.pageNumElem) return;
    if (this._phoneChrome) this.pageNumElem.style.width = `${Math.max(1, this.pageNumElem.value.length) + 0.4}ch`;
    else this.pageNumElem.style.width = '3.4em';
  }

  /**
   * Enter or leave the phone layout: controls move between the toolbar and the bottom dock, and the panels between the side rail and the sheet / Pages room.
   * @param {boolean} phone
   */
  _setPhoneChrome(phone) {
    if (phone === this._phoneChrome) return;
    this._phoneChrome = phone;
    this.pdfViewerElem.classList.toggle('scribe-phone', phone);
    if (this.toolbarElem && this._appMenu && this._searchBar) {
      if (phone) {
        this._buildPhoneChrome();
        // Close the rail instantly: this runs mid-resize, where a slide would fight the relayout.
        if (this._sidebarAnim) { cancelAnimationFrame(this._sidebarAnim.raf); this._sidebarAnim = null; }
        if (this._activeSidebar) {
          const openPanel = this._panelFor(this._activeSidebar);
          this._activeSidebar = null;
          if (openPanel) openPanel.setVisible(false);
          if (this.scribe.scrollContainer) this.scribe.scrollContainer.style.marginLeft = '0px';
        }
        if (this._thumbnailPanel) this._thumbnailPanel.toggleElem.classList.remove('active');
        if (this._bookmarksPanel) this._bookmarksPanel.toggleElem.classList.remove('active');
        if (this._commentsPanel) this._commentsPanel.toggleElem.classList.remove('active');
        this.toolbarElem.style.display = 'none';
        this._dockElem.appendChild(this._appMenu.menuWrap);
        this._dockElem.appendChild(this._searchBar.searchElem);
        if (this._pageInputGroup) this._dockElem.appendChild(this._pageInputGroup);
        if (this._sheetPanelsBtn) this._dockElem.appendChild(this._sheetPanelsBtn);
        // Re-anchor the find bar from the hidden toolbar to the root, where the phone CSS pins it full-width to the top edge.
        this.pdfViewerElem.appendChild(this._searchBar.findGroupElem);
        // The recognition progress line rides the dock's top edge instead of the toolbar's bottom.
        if (this._ocrProgress) this._dockElem.appendChild(this._ocrProgress);
        if (this._sheetContentElem) {
          for (const p of [this._bookmarksPanel, this._commentsPanel]) {
            if (!p) continue;
            this._sheetContentElem.appendChild(p.panelElem);
            p.panelElem.style.display = 'none';
          }
        }
        // The Pages panel lives in the strip's expanded room, not the sheet.
        if (this._roomBodyElem && this._thumbnailPanel) {
          this._roomBodyElem.appendChild(this._thumbnailPanel.panelElem);
          this._thumbnailPanel.panelElem.style.display = 'none';
        }
        // Compact cells so the room's full width fits several columns (the desktop rail keeps the larger thumbnails).
        // The room opens read-only: mutation waits for Edit.
        if (this._thumbnailPanel) {
          this._thumbnailPanel.setCompact(true);
          this._thumbnailPanel.setRoomMode('browse');
        }
        if (this._commentsPanel) this._commentsPanel.setCompact(true);
        if (this._bookmarksPanel) this._bookmarksPanel.setPhoneMode(true);
        this._syncDockPanelsBtn();
        // Gate on this.doc, not scribe.doc: the latter is a truthy empty ScribeDoc from construction, which would show a blank bar before anything is opened.
        if (this._companionStrip) {
          this._companionStrip.setVisible(!!this.doc);
          if (this.doc) this._companionStrip.rebuild(this.scribe.state.cp.n);
        }
      } else {
        if (this._companionStrip) this._companionStrip.setVisible(false);
        this._closeSheet(true);
        this._closePagesRoom(true);
        this.toolbarElem.style.display = 'flex';
        this.toolbarElemStart.appendChild(this._appMenu.menuWrap);
        if (this._toolbarButtonsElem && this.nextElem && this._pageInputGroup) {
          this._toolbarButtonsElem.insertBefore(this._pageInputGroup, this.nextElem.nextSibling);
        }
        this.toolbarElemEnd.appendChild(this._searchBar.searchElem);
        this.toolbarElem.appendChild(this._searchBar.findGroupElem);
        if (this._ocrProgress) this.toolbarElem.appendChild(this._ocrProgress);
        // The rail hides the thumbnail panel by transform and the other two by display, so only thumbnails get a visible display back.
        for (const p of [this._thumbnailPanel, this._bookmarksPanel, this._commentsPanel]) {
          if (!p) continue;
          this.pdfViewerElem.appendChild(p.panelElem);
          p.panelElem.style.display = p === this._thumbnailPanel ? '' : 'none';
        }
        if (this._thumbnailPanel) {
          this._thumbnailPanel.setCompact(false);
          this._thumbnailPanel.setRoomMode(null);
        }
        if (this._commentsPanel) this._commentsPanel.setCompact(false);
        if (this._bookmarksPanel) this._bookmarksPanel.setPhoneMode(false);
      }
    }
    this._updateRecognizeButton();
    this._syncDockPageNumWidth();
    if (this.scribe.scrollContainer) this._relayout();
  }

  /**
   * Build the phone UI (dock, companion strip, Pages room, bottom sheet) on first phone-mode entry, so desktop-only viewers never pay for it.
   */
  _buildPhoneChrome() {
    if (this._dockElem) return;
    const dock = document.createElement('div');
    dock.className = 'scribe-dock';
    this._dockElem = dock;
    this.pdfViewerElem.appendChild(dock);
    if (!this._thumbnailPanel) return;

    // The companion strip is the phone's whole Pages surface: a tap on its pull tab or an upward drag expands it into the Pages room.
    this._companionStrip = createCompanionStrip(this.scribe, {
      onExpand: (phase, dy) => this._pagesRoomGesture(phase, dy),
    });
    this.pdfViewerElem.appendChild(this._companionStrip.stripElem);

    // The full-height Pages room slides up from behind the dock and covers the document while pages are organized.
    const room = document.createElement('div');
    room.className = 'scribe-pages-room';
    const roomHd = document.createElement('div');
    roomHd.className = 'scribe-room-hd';
    const roomTitle = document.createElement('span');
    roomTitle.className = 'scribe-room-title';
    roomTitle.textContent = 'Pages';
    const roomCount = document.createElement('span');
    roomCount.className = 'scribe-room-count';
    const roomEdit = document.createElement('button');
    roomEdit.type = 'button';
    roomEdit.className = 'scribe-room-edit';
    roomEdit.textContent = 'Edit';
    roomEdit.addEventListener('click', () => this._setRoomEditing(!this._roomEditing));
    this._roomEditBtn = roomEdit;
    // Discard unwinds everything this Edit session did and leaves Edit mode.
    const roomRevert = document.createElement('button');
    roomRevert.type = 'button';
    roomRevert.className = 'scribe-room-revert';
    roomRevert.textContent = 'Discard';
    roomRevert.addEventListener('click', () => {
      const doc = this.scribe.doc;
      if (!this._roomEditing || !doc || this._roomEditBaseline < 0) return;
      const baseline = this._roomEditBaseline;
      // Leave Edit before the unwind, so the badges lose their selected colour and disappear in one style recalc.
      this._setRoomEditing(false);
      // Captured after leaving Edit, so the slide starts in the same layout the rebuilt grid lands in.
      const playSlide = this._thumbnailPanel ? this._thumbnailPanel.beginStructureSlide() : null;
      // Model-level undo for all but the last step, then one viewer-level undo so the view rebuilds and the refresh callbacks fire once.
      while (doc.history.undoStack.length > baseline + 1) {
        if (!doc.undo()) break;
      }
      if (doc.history.undoStack.length > baseline) this.scribe.undo();
      if (playSlide) playSlide();
    });
    this._roomRevertBtn = roomRevert;
    const roomDone = document.createElement('button');
    roomDone.type = 'button';
    roomDone.className = 'scribe-room-done';
    roomDone.textContent = 'Done';
    roomDone.addEventListener('click', () => this._closePagesRoom());
    this._roomDoneBtn = roomDone;
    roomHd.append(roomTitle, roomCount, roomEdit, roomRevert, roomDone);
    const roomBody = document.createElement('div');
    roomBody.className = 'scribe-room-body';
    room.append(roomHd, roomBody);
    this._pagesRoomElem = room;
    this._roomBodyElem = roomBody;
    this._roomCountElem = roomCount;
    this.pdfViewerElem.appendChild(room);

    // The pull morphs the strip's thumbnails into the room's grid rather than sliding the room over them as a separate panel.
    this._pagesMorph = createPagesMorph(this.scribe, {
      roomElem: room, roomHdElem: roomHd, stripElem: this._companionStrip.stripElem, panel: this._thumbnailPanel,
    });

    // Drag-down on the room header is the pull-up's reverse: the open room rides the finger back down into the strip along the same morph.
    // The gesture engages only on a decisively vertical downward pull, so a clean tap still reaches the header's buttons.
    /** @type {?{id: number, y0: number, x0: number, base: number, active: boolean, down: number, travel: number, morph: boolean}} */
    let hdPull = null;
    let hdSwallowClick = false;
    /** @param {PointerEvent} e */
    const hdPullMove = (e) => {
      if (!hdPull || e.pointerId !== hdPull.id) return;
      const p = hdPull;
      const down = e.clientY - p.y0;
      const dx = Math.abs(e.clientX - p.x0);
      if (!p.active) {
        if (!(down > 12 && down > 2 * dx)) return;
        if (!this._roomOpen || (this._pagesMorph && this._pagesMorph.isActive())) return;
        if (this._companionStrip) this._companionStrip.park();
        const morph = this._pagesMorph;
        const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        if (morph && !reduceMotion && morph.beginClose()) {
          p.morph = true;
          p.travel = morph.dyFull();
        } else {
          p.travel = room.offsetHeight || 1;
          room.classList.add('dragging');
        }
        p.active = true;
        p.base = down;
        hdSwallowClick = true;
        return;
      }
      p.down = Math.max(0, down - p.base);
      if (!p.morph) { room.style.transform = `translateY(${Math.min(p.travel, p.down)}px)`; return; }
      if (this._pagesMorph) this._pagesMorph.frame(p.travel - p.down);
    };
    /** @param {PointerEvent} e */
    const hdPullEnd = (e) => {
      if (!hdPull || e.pointerId !== hdPull.id) return;
      const p = hdPull;
      hdPull = null;
      window.removeEventListener('pointermove', hdPullMove);
      window.removeEventListener('pointerup', hdPullEnd);
      window.removeEventListener('pointercancel', hdPullEnd);
      if (!p.active) return;
      // On a cancel Chrome reports coordinates as (0, 0), so end at the last travel a real move reported instead.
      const down = e.type === 'pointercancel' ? p.down : Math.max(0, e.clientY - p.y0 - p.base);
      const commit = down > Math.min(140, p.travel * 0.25);
      if (p.morph) {
        const morph = this._pagesMorph;
        // The close may have flipped the covered strip to the browsed rows, and a parked strip does not glide back on its own.
        if (morph) {
          morph.settle(!commit, (stillOpen) => {
            if (stillOpen) return;
            this._roomOpen = false;
            if (this._companionStrip) this._companionStrip.settle();
          });
        }
        return;
      }
      // Plain-slide release: flush the dragged position so the snap animates from the finger's release point.
      room.getBoundingClientRect();
      room.classList.remove('dragging');
      if (commit) {
        this._roomOpen = false;
        room.classList.remove('open');
      }
      room.style.transform = '';
      if (!commit) return;
      if (this._thumbnailPanel) {
        this._thumbnailPanel.setVisible(false);
        this._thumbnailPanel.panelElem.style.display = 'none';
      }
    };
    roomHd.addEventListener('pointerdown', (e) => {
      hdSwallowClick = false; // a stale flag from a clickless touch drag must not eat this press's tap
      if (hdPull || !this._roomOpen || this._roomEditing) return; // editing exits only through Save or Discard
      if (this._pagesMorph && this._pagesMorph.isActive()) return; // a live scene (an open still settling) owns the room
      hdPull = {
        id: e.pointerId, y0: e.clientY, x0: e.clientX, base: 0, active: false, down: 0, travel: 1, morph: false,
      };
      window.addEventListener('pointermove', hdPullMove);
      window.addEventListener('pointerup', hdPullEnd);
      window.addEventListener('pointercancel', hdPullEnd);
    });
    // Swallow the click an engaged drag can land on a header button (Done firing over the settle would close twice).
    roomHd.addEventListener('click', (e) => {
      if (!hdSwallowClick) return;
      hdSwallowClick = false;
      e.preventDefault();
      e.stopPropagation();
    }, true);

    const panelsBtn = makeIconButton('Panels', THUMB_SVG, 'Bookmarks and comments');
    panelsBtn.addEventListener('click', () => { if (this._sheetOpen) this._closeSheet(); else this._openSheet(); });
    this._sheetPanelsBtn = panelsBtn;

    const scrim = document.createElement('div');
    scrim.className = 'scribe-sheet-scrim';
    scrim.addEventListener('click', () => this._closeSheet());
    this._sheetScrimElem = scrim;

    const sheet = document.createElement('div');
    sheet.className = 'scribe-sheet';
    // One-row sheet header: the hidden desktop title bars' actions move into its right slot.
    const hd = document.createElement('div');
    hd.className = 'scribe-sheet-hd';
    const pill = document.createElement('div');
    pill.className = 'scribe-sheet-pill';
    const seg = document.createElement('div');
    seg.className = 'scribe-sheet-seg';
    for (const [key, label, panel] of /** @type {Array<['bookmarks'|'comments', string, any]>} */ ([
      ['bookmarks', 'Bookmarks', this._bookmarksPanel],
      ['comments', 'Comments', this._commentsPanel],
    ])) {
      if (!panel) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.addEventListener('click', () => this._showSheetView(key));
      seg.appendChild(btn);
      this._sheetSegBtns[key] = btn;
    }
    const acts = document.createElement('div');
    acts.className = 'scribe-sheet-acts';
    const actBtn = document.createElement('button');
    actBtn.type = 'button';
    actBtn.className = 'scribe-sheet-act';
    actBtn.innerHTML = SHEET_PLUS_SVG;
    actBtn.addEventListener('click', () => {
      if (this._sheetView === 'bookmarks' && this._bookmarksPanel) this._bookmarksPanel.addAtPage();
      else if (this._commentsPanel) this._commentsPanel.newNote();
    });
    this._sheetActBtn = actBtn;
    acts.append(actBtn);
    hd.append(pill, seg, acts);
    const content = document.createElement('div');
    content.className = 'scribe-sheet-content';
    this._sheetContentElem = content;
    sheet.append(hd, content);
    this._sheetElem = sheet;
    this.pdfViewerElem.append(scrim, sheet);

    // Header gestures: a drag resizes the sheet live and snaps back to half, or closed, on release.
    // Below the smallest useful height the drag stops resizing and the whole card rides the finger down behind the dock, so a dismissal can be dragged to completion.
    // Capturing under a button would retarget its click to the row, so capture is immediate only off-button and deferred past the slop when the press starts on one.
    let dragActive = false;
    let dragStartY = 0;
    let dragStartH = 0;
    let dragLastH = 0;
    let dragOver = 0;
    let dragMoved = false;
    let dragFromButton = false;
    hd.addEventListener('pointerdown', (e) => {
      // A second concurrent touch must not re-base the gesture mid-drag.
      if (dragActive) return;
      dragActive = true;
      dragStartY = e.clientY;
      dragStartH = sheet.getBoundingClientRect().height;
      dragOver = 0;
      dragMoved = false;
      dragFromButton = !!(e.target instanceof Element && e.target.closest('button'));
      if (!dragFromButton) {
        try { hd.setPointerCapture(e.pointerId); } catch { /* untrusted event: move/up still arrive by bubbling */ }
      }
    });
    hd.addEventListener('pointermove', (e) => {
      if (!dragActive) return;
      const dy = dragStartY - e.clientY;
      if (!dragMoved && Math.abs(dy) < 6) return;
      if (!dragMoved && dragFromButton) {
        try { hd.setPointerCapture(e.pointerId); } catch { /* see above */ }
      }
      if (!dragMoved) {
        // For the gesture's lifetime the document lays out full-height behind the sheet, so a descending sheet reveals live pages instead of the void its inset left.
        if (this._sheetRelayoutT) { clearTimeout(this._sheetRelayoutT); this._sheetRelayoutT = null; }
        this._sheetDragLayout = true;
        this._relayout();
      }
      dragMoved = true;
      sheet.classList.add('dragging');
      const avail = this.pdfViewerElem.clientHeight;
      const targetH = dragStartH + dy;
      // The resize floor doubles as the release-to-close threshold, so the bottom edge detaching announces that letting go dismisses.
      const floorH = Math.max(140, avail * 0.28);
      dragLastH = Math.min(Math.round(avail * 0.5), Math.max(floorH, targetH));
      dragOver = Math.max(0, floorH - targetH);
      sheet.style.height = `${dragLastH}px`;
      sheet.style.transform = dragOver ? `translateY(${dragOver}px)` : '';
    });
    /** Settle a finished drag (release or cancel): snap the sheet back to its half height, or closed. */
    const settleDrag = () => {
      sheet.getBoundingClientRect();
      sheet.classList.remove('dragging');
      if (dragOver > 0) {
        this._closeSheet();
        return;
      }
      sheet.style.height = '';
      this._sheetRelayoutT = setTimeout(() => {
        this._sheetRelayoutT = null;
        this._sheetDragLayout = false;
        this._relayout();
      }, 300);
    };
    hd.addEventListener('pointerup', () => {
      if (!dragActive) return;
      dragActive = false;
      if (!dragMoved) {
        sheet.classList.remove('dragging');
        return;
      }
      settleDrag();
    });
    // A cancelled pointer (browser takeover, palm) must settle like a release, or the sheet strands mid-ride with transitions off.
    // Settle from the tracked geometry, never the event's coordinates: Chrome reports pointercancel at (0,0).
    hd.addEventListener('pointercancel', () => {
      if (!dragActive) return;
      dragActive = false;
      if (dragMoved) settleDrag();
      // No click composes after a cancel, so clear the flag here or the swallow guard below would eat the next real tap.
      dragMoved = false;
    });
    // A drag that began on a tab still composes a click on release (the capture retargets it here), so swallow it or the drag would also switch tabs.
    hd.addEventListener('click', (e) => {
      if (dragMoved) {
        e.stopPropagation();
        e.preventDefault();
        dragMoved = false;
      }
    }, true);
  }

  /** Open the bottom sheet on the last-shown view. */
  _openSheet() {
    if (!this._sheetElem || this._sheetOpen) return;
    // One surface at a time at the bottom edge: the sheet displaces an open Pages room.
    this._closePagesRoom(true);
    this._sheetOpen = true;
    if (this._sheetElem.style.height) {
      this._sheetElem.style.transition = 'none';
      this._sheetElem.style.height = '';
      this._sheetElem.getBoundingClientRect();
      this._sheetElem.style.transition = '';
    }
    // No scrim: the sheet coexists with a lit, interactive document reflowed above it.
    this._sheetElem.classList.add('open');
    if (this._sheetPanelsBtn) this._sheetPanelsBtn.classList.add('active');
    this._relayout();
    // The desktop toggles own per-document visibility, so the tabs mirror them, falling back when the remembered view is unavailable.
    for (const [key, btn] of Object.entries(this._sheetSegBtns)) {
      const panel = this._panelFor(/** @type {'bookmarks'|'comments'} */ (key));
      btn.style.display = panel && panel.toggleElem.style.display === 'none' ? 'none' : '';
    }
    const viewBtn = this._sheetSegBtns[this._sheetView];
    if (!viewBtn || viewBtn.style.display === 'none') {
      const bm = this._sheetSegBtns.bookmarks;
      this._sheetView = (bm && bm.style.display !== 'none') ? 'bookmarks' : 'comments';
    }
    this._showSheetView(this._sheetView);
  }

  /**
   * Close the bottom sheet (no-op when closed).
   * @param {boolean} [instant=false] - Skip the slide-out, for mode flips mid-resize.
   */
  _closeSheet(instant = false) {
    if (!this._sheetElem || !this._sheetOpen) return;
    this._sheetOpen = false;
    if (instant) {
      this._sheetElem.style.transition = 'none';
      this._sheetScrimElem.style.transition = 'none';
      requestAnimationFrame(() => {
        if (this._sheetElem) this._sheetElem.style.transition = '';
        if (this._sheetScrimElem) this._sheetScrimElem.style.transition = '';
      });
    }
    // Closed layout equals the drag's overlay layout, so clearing these here never shifts the document.
    if (this._sheetRelayoutT) { clearTimeout(this._sheetRelayoutT); this._sheetRelayoutT = null; }
    this._sheetDragLayout = false;
    this._sheetScrimElem.classList.remove('open');
    this._sheetElem.classList.remove('open');
    // A keyboard lift's inline translate would hold the closed sheet on screen.
    this._sheetComposeLift(false);
    if (this._sheetPanelsBtn) this._sheetPanelsBtn.classList.remove('active');
    const panel = this._panelFor(this._sheetView);
    if (panel) panel.setVisible(false);
    this._relayout();
  }

  /**
   * Show one view in the open sheet and point the header's action slot at it.
   * @param {'bookmarks'|'comments'} key
   */
  _showSheetView(key) {
    this._sheetView = key;
    for (const [k, btn] of Object.entries(this._sheetSegBtns)) btn.classList.toggle('on', k === key);
    for (const [k, panel] of /** @type {Array<['bookmarks'|'comments', any]>} */ ([
      ['bookmarks', this._bookmarksPanel],
      ['comments', this._commentsPanel],
    ])) {
      if (!panel) continue;
      const on = k === key;
      panel.panelElem.style.display = on ? '' : 'none';
      panel.setVisible(on);
    }
    this._syncSheetHeader();
  }

  /**
   * Keep the sheet's composer clear of the on-screen keyboard while it has focus.
   * @param {boolean} focused
   */
  _sheetComposeLift(focused) {
    const sheet = this._sheetElem;
    if (!sheet) return;
    if (this._composeLiftOff) {
      this._composeLiftOff();
      this._composeLiftOff = null;
    }
    if (!focused || !this._phoneChrome) {
      sheet.style.transform = '';
      return;
    }
    const vv = window.visualViewport;
    let lift = 0;
    const apply = () => {
      const rect = sheet.getBoundingClientRect();
      const restTop = rect.top + lift;
      const restBottom = rect.bottom + lift;
      const keyboardTop = vv ? (vv.offsetTop + vv.height) : window.innerHeight;
      let next = Math.max(0, restBottom - keyboardTop + 10);
      next = Math.min(next, Math.max(0, restTop - 8));
      if (next === lift) return;
      lift = next;
      sheet.style.transform = lift ? `translateY(${-lift}px)` : '';
    };
    apply();
    if (vv) {
      vv.addEventListener('resize', apply);
      vv.addEventListener('scroll', apply);
      this._composeLiftOff = () => {
        vv.removeEventListener('resize', apply);
        vv.removeEventListener('scroll', apply);
      };
    }
  }

  /** Refresh the sheet header's action slot: the +'s target and visibility. */
  _syncSheetHeader() {
    if (this._sheetActBtn) {
      // Creation is an editing act, so the + hides in a read-only viewer.
      this._sheetActBtn.style.display = this.scribe.opt.enablePageEditing ? '' : 'none';
      const label = this._sheetView === 'bookmarks' ? 'Add bookmark at current page' : 'New note on this page';
      this._sheetActBtn.title = label;
      this._sheetActBtn.setAttribute('aria-label', label);
    }
  }

  /** Open the full-height Pages room, sliding it up from behind the dock. */
  _openPagesRoom() {
    if (!this._pagesRoomElem || this._roomOpen || !this._phoneChrome) return;
    this._closeSheet(true);
    this._roomOpen = true;
    this._showPagesRoomContent();
    // Clear any residue of an interrupted drag: a leftover inline transform (or the transition-suppressing drag class) would park the room off-position.
    this._pagesRoomElem.classList.remove('dragging');
    this._pagesRoomElem.style.transform = '';
    this._pagesRoomElem.classList.add('open');
    // The grid's columns derive from the room's full width, so refit once the slide settles.
    setTimeout(() => { if (this._roomOpen && this._thumbnailPanel) this._thumbnailPanel.refit(); }, 300);
  }

  /** Reveal the room's thumbnail grid and set the header count (shared by the tap open and the live drag). */
  _showPagesRoomContent() {
    this._syncRoomHeader();
    if (this._thumbnailPanel) {
      this._thumbnailPanel.panelElem.style.display = '';
      this._thumbnailPanel.setVisible(true);
      this._thumbnailPanel.refit();
    }
  }

  /** Keep the room header's mode-dependent parts current. */
  _syncRoomHeader() {
    const count = this.scribe.doc ? this.scribe.doc.inputData.pageCount : 0;
    if (this._roomCountElem) {
      this._roomCountElem.textContent = this._roomEditing ? 'editing' : (count ? `${count} pages` : '');
    }
    if (this._roomEditBtn) {
      const canEdit = !!(this.scribe.opt && this.scribe.opt.enablePageEditing) && count > 1;
      this._roomEditBtn.style.display = (this._roomEditing || canEdit) ? '' : 'none';
      const doc = this.scribe.doc;
      this._roomEditBtn.disabled = this._roomEditing
        && !(doc && this._roomEditBaseline >= 0 && doc.history.undoStack.length > this._roomEditBaseline);
    }
    if (this._roomRevertBtn) {
      this._roomRevertBtn.disabled = !this._roomEditing;
    }
  }

  /**
   * Enter or leave the room's Edit mode: browse is read-only and Edit carries every page mutation.
   * @param {boolean} on
   */
  _setRoomEditing(on) {
    if (!this._pagesRoomElem || this._roomEditing === on) return;
    this._roomEditing = on;
    this._roomEditBaseline = on && this.scribe.doc ? this.scribe.doc.history.undoStack.length : -1;
    this._pagesRoomElem.classList.toggle('editing', on);
    if (this._roomEditBtn) this._roomEditBtn.textContent = on ? 'Save' : 'Edit';
    if (this._roomDoneBtn) this._roomDoneBtn.style.display = on ? 'none' : '';
    this._syncRoomHeader();
    if (this._thumbnailPanel) this._thumbnailPanel.setRoomMode(on ? 'edit' : 'browse');
  }

  /**
   * Close the Pages room (no-op when closed).
   * @param {boolean} [instant=false] - Skip the slide-out, for mode flips mid-resize.
   */
  _closePagesRoom(instant = false) {
    if (!instant && this._pagesMorph && this._pagesMorph.isActive()) {
      this._setRoomEditing(false);
      this._roomOpen = false;
      this._pagesMorph.settle(false);
      return;
    }
    // Abort before the open-guard below: a close during a live pull arrives with `_roomOpen` still false and would otherwise leave the morph standing.
    if (this._pagesMorph) this._pagesMorph.abort();
    this._setRoomEditing(false);
    if (!this._pagesRoomElem || !this._roomOpen) return;
    this._roomOpen = false;
    // Park the covered strip on the active page first: the close must reveal it at rest, not still gliding after an in-room navigation.
    if (this._companionStrip) this._companionStrip.park();
    if (!instant && this._pagesMorph
      && !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
      && this._pagesMorph.beginClose()) {
      this._pagesMorph.settle(false, () => { if (this._companionStrip) this._companionStrip.settle(); });
      return;
    }
    if (instant) {
      this._pagesRoomElem.style.transition = 'none';
      requestAnimationFrame(() => { if (this._pagesRoomElem) this._pagesRoomElem.style.transition = ''; });
    }
    this._pagesRoomElem.classList.remove('open', 'dragging');
    this._pagesRoomElem.style.transform = '';
    // Release the grid's resources (thumbnails unmount their rows on hide).
    if (this._thumbnailPanel) {
      this._thumbnailPanel.setVisible(false);
      this._thumbnailPanel.panelElem.style.display = 'none';
    }
  }

  /**
   * The companion strip's pull-up gesture: `tap` (the pull tab) toggles the room, and a drag streams `start`/`move`/`end` with its upward travel.
   * @param {'tap'|'start'|'move'|'end'} phase
   * @param {number} dy - Upward travel in px (positive = up).
   */
  _pagesRoomGesture(phase, dy) {
    const room = this._pagesRoomElem;
    if (!room || !this._phoneChrome) return;
    const morph = this._pagesMorph;
    const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const travel = room.offsetHeight || 1;
    // A live morph owns the room exclusively: only its own move/end steer it, and everything else is ignored rather than allowed to fall through to the plain-slide path and clobber the scene.
    if (morph && morph.isActive()) {
      if (phase === 'move' && !morph.settling()) { morph.frame(dy); return; }
      if (phase === 'end' && !morph.settling()) {
        morph.settle(dy > Math.min(140, travel * 0.25), (committed) => { if (committed) this._roomOpen = true; });
      }
      return;
    }
    if (phase === 'tap') {
      if (this._roomOpen) { this._closePagesRoom(); return; }
      if (morph && !reduceMotion) {
        this._closeSheet(true);
        this._showPagesRoomContent();
        if (morph.begin()) {
          morph.frame(0);
          morph.settle(true, (committed) => { if (committed) this._roomOpen = true; });
          return;
        }
      }
      this._openPagesRoom();
      return;
    }
    if (this._roomOpen) return; // drags only open the room
    if (phase === 'start') {
      this._closeSheet(true);
      this._showPagesRoomContent();
      if (morph && !reduceMotion && morph.begin()) {
        morph.frame(dy);
        return;
      }
      room.classList.add('dragging', 'open');
      room.style.transform = `translateY(${Math.max(0, travel - dy)}px)`;
      return;
    }
    if (phase === 'move') {
      // Only a drag this handler started may keep moving the room: a pull whose morph was aborted mid-gesture must not resurrect it through the plain path.
      if (room.classList.contains('dragging')) room.style.transform = `translateY(${Math.max(0, travel - dy)}px)`;
      return;
    }
    // Release.
    const commit = dy > Math.min(140, travel * 0.25);
    if (!room.classList.contains('dragging')) return;
    // Plain-slide path: flush the dragged position so the snap animates from the finger's release point.
    room.getBoundingClientRect();
    room.classList.remove('dragging');
    room.style.transform = '';
    if (commit) {
      this._roomOpen = true;
      setTimeout(() => { if (this._roomOpen && this._thumbnailPanel) this._thumbnailPanel.refit(); }, 300);
    } else {
      room.classList.remove('open');
      if (this._thumbnailPanel) {
        this._thumbnailPanel.setVisible(false);
        this._thumbnailPanel.panelElem.style.display = 'none';
      }
    }
  }

  /** Hide the dock's Panels button when the sheet would have no tabs to show. */
  _syncDockPanelsBtn() {
    if (!this._sheetPanelsBtn) return;
    const any = ['bookmarks', 'comments'].some((k) => {
      const panel = this._panelFor(/** @type {'bookmarks'|'comments'} */ (k));
      return panel && panel.toggleElem.style.display !== 'none';
    });
    this._sheetPanelsBtn.style.display = any ? '' : 'none';
    if (!any && this._sheetOpen) this._closeSheet(true);
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
    if (this._pagesMorph) this._pagesMorph.abort(); // cancels the settle rAF and revokes morph-owned thumbnail URLs
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
   * @param {boolean} [isDefaultFit=false] - `fitMode` is the constructor default, not a caller choice.
   *   Only then may the width-fit override apply.
   */
  _installFit(fitMode, isDefaultFit = false) {
    this.scribe.setInitialPositionZoom = (imgDims) => {
      this.scribe.runSetInitial = false;
      const sc = this.scribe.scrollContainer;
      const stageW = sc.clientWidth;
      const stageH = sc.clientHeight;

      // The scroll extent is the widest page, not the first one, so a document mixing page sizes must fit that width or it opens overflowing horizontally.
      // Only `calcPageStops` computes `_contentWidth`, and on a first load nothing has needed the page stops yet.
      this.scribe.calcPageStops();
      const docW = this.scribe._contentWidth || imgDims.width;

      // The phone takes width-fit either way.
      const heightFitOverflows = ((stageH - 150) / imgDims.height) * docW > stageW;
      const widthFitDefault = isDefaultFit && (this._phoneChrome || heightFitOverflows);
      const effectiveMode = widthFitDefault ? 'width' : fitMode;

      let zoom;
      // `y` is the desired gap, in screen px, from the top of the viewport to the top of the first page.
      let y;
      if (typeof effectiveMode === 'function') {
        const r = effectiveMode(imgDims, { width: stageW, height: stageH });
        zoom = r.zoom;
        y = r.y ?? 30;
      } else if (effectiveMode === 'width') {
        zoom = stageW / docW;
        y = 30;
      } else if (effectiveMode === 'page') {
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

      this._autoFit = {
        imgDims, docW, zoom, isDefaultFit, widthMode: widthFitDefault,
      };
    };
  }

  /**
   * Build a flat text button styled by the editor CSS, optionally with a leading icon.
   * @param {string} label
   * @param {string} title
   * @param {string} [extraClass]
   * @param {string} [iconSvg] - SVG markup for a leading icon.
   * @returns {HTMLSpanElement}
   */
  _makeTextBtn(label, title, extraClass, iconSvg) {
    const btn = document.createElement('span');
    btn.className = extraClass ? `scribe-edit-btn ${extraClass}` : 'scribe-edit-btn';
    if (iconSvg) {
      const ic = document.createElement('span');
      ic.className = 'scribe-edit-btn-ic';
      ic.innerHTML = iconSvg;
      btn.appendChild(ic);
    }
    // A text node (not textContent) so the leading icon survives.
    if (label) btn.appendChild(document.createTextNode(label));
    btn.title = title;
    btn.role = 'button';
    btn.tabIndex = 0;
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    return btn;
  }

  /**
   * Wire a toggle element to open/close a menu, closing it on any outside click.
   * @param {HTMLElement} toggleEl
   * @param {HTMLElement} menuEl
   */
  _wireDropdown(toggleEl, menuEl) {
    toggleEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = menuEl.style.display !== 'none';
      menuEl.style.display = open ? 'none' : 'block';
      toggleEl.classList.toggle('active', !open);
    });
    const onDocClick = (e) => {
      if (menuEl.style.display === 'none' || menuEl.contains(/** @type {Node} */ (e.target))) return;
      menuEl.style.display = 'none';
      toggleEl.classList.remove('active');
    };
    document.addEventListener('click', onDocClick);
    this._teardownCallbacks.push(() => document.removeEventListener('click', onDocClick));
  }

  /**
   * Build the edit toolbar's right zone: a Recognize Text split button whose main face runs recognition and whose caret opens a language menu.
   * Also populate the far-left app menu with Export PDF, Combine, Split, and the dark-mode toggle.
   */
  _buildEditToolbar() {
    // The split button is shown only when deep OCR would actually recognize a page (see `_updateRecognizeButton`), so a fully text-native document offers no recognize action.
    // On touch layouts the split leaves the bar and the app-menu row carries recognition instead.
    const ocrSplit = document.createElement('span');
    ocrSplit.className = 'scribe-edit-split scribe-touch-hide';
    this._ocrSplit = ocrSplit;
    const ocrBtn = this._makeTextBtn('Recognize Text', 'Recognize text on every page', 'scribe-edit-split-main');
    ocrBtn.addEventListener('click', () => this._recognizeAll(ocrBtn));
    const ocrCaret = this._makeTextBtn('', 'Recognition language', 'scribe-edit-split-caret');
    ocrCaret.innerHTML = CARET_SVG;

    const langMenu = document.createElement('div');
    langMenu.className = 'scribe-edit-menu';
    langMenu.style.display = 'none';
    const current = this.scribe.opt.langs?.[0] || 'eng';
    /** @type {Array<HTMLDivElement>} */
    const langItems = [];
    for (const [code, label] of [['eng', 'English'], ['deu', 'German'], ['fra', 'French'], ['spa', 'Spanish'], ['ita', 'Italian']]) {
      const item = document.createElement('div');
      item.className = 'scribe-edit-menu-item';
      item.textContent = label;
      if (code === current) item.classList.add('selected');
      item.addEventListener('mousedown', (e) => e.preventDefault());
      item.addEventListener('click', () => {
        this.scribe.opt.langs = [code];
        for (const it of langItems) it.classList.toggle('selected', it === item);
        langMenu.style.display = 'none';
        ocrCaret.classList.remove('active');
      });
      langItems.push(item);
      langMenu.appendChild(item);
    }
    this._wireDropdown(ocrCaret, langMenu);
    ocrSplit.append(ocrBtn, ocrCaret, langMenu);

    // Export PDF, the document-level actions (Combine / Split), and the Dark mode toggle live in the far-left app menu, which the viewer already seeded with Open / Print.
    const appMenu = this._appMenu;
    if (appMenu) {
      // Touch-only row replacing the bar's split button.
      this._ocrMenuItem = appMenu.addAction('Recognize text', ICON_RECOGNIZE, () => this._recognizeAll(this._ocrMenuItem));
      this._ocrMenuItem.classList.add('scribe-touch-row');
      // The `busy` class barely shows (the menu closes on click; the browser's download UI is the real progress cue) but is kept to match the Combine / Split siblings.
      const exportItem = appMenu.addAction('Export PDF', ICON_EXPORT, async () => {
        // No-op at 0 pages (e.g. every page removed) rather than throwing deep in the PDF writer.
        if (!this.doc || this.doc.pageMetrics.length === 0) return;
        exportItem.classList.add('busy');
        try {
          // The export itself applies the marks, so the toast is the honest cue right when it happens.
          // Never a modal: applying the user's own marks is the expected outcome, not something to confirm.
          const redactGroups = new Set();
          for (const pageAnnots of this.doc.annotations.pages) {
            for (const a of pageAnnots || []) if (a.type === 'redact') redactGroups.add(a.groupId);
          }
          if (redactGroups.size > 0) {
            this._showToast(`Applying ${redactGroups.size} redaction${redactGroups.size === 1 ? '' : 's'} — the marked content is removed from the exported PDF.`);
          }
          await this.doc.download('pdf', this._baseName(), { displayMode: 'invis', addOverlay: true });
        } catch (err) {
          console.error('Export failed:', err);
          this._showToast('Couldn’t export the PDF. Please try again.');
        } finally {
          exportItem.classList.remove('busy');
        }
      });

      // Separator before the document actions, hidden when neither Combine nor Split currently applies.
      this._appMenuDocSep = appMenu.addSeparator();

      // Combine every open document (tab) into one. Shown only when 2+ tabs are open (see `_updateCombineButton`).
      const combineItem = appMenu.addAction('Combine open documents', ICON_COMBINE, async () => {
        combineItem.classList.add('busy');
        try {
          await this.combineOpenDocuments();
        } finally {
          combineItem.classList.remove('busy');
        }
      });
      combineItem.dataset.action = 'combine';
      this._combineItem = combineItem;

      // Split the active document into one file per top-level bookmark. Shown only when it would yield 2+ files (see `_updateSplitButton`).
      const splitItem = appMenu.addAction('Split at bookmarks', ICON_SPLIT, async () => {
        const doc = this.doc;
        if (!doc) return;
        const count = outlineSplitSegments(doc.outline || [], doc.pageMetrics.length).length;
        if (count < 2) return;
        // eslint-disable-next-line no-alert
        if (count > 10 && !window.confirm(`Split into ${count} separate documents (one per bookmark)? Each opens as a new tab.`)) return;
        splitItem.classList.add('busy');
        try {
          await this.splitAtBookmarks();
        } finally {
          splitItem.classList.remove('busy');
        }
      });
      splitItem.dataset.action = 'split';
      this._splitItem = splitItem;

      // Flipping the toggle sets an explicit light/dark preference that overrides the system default.
      // The switch reflects the theme in effect each time the menu opens.
      appMenu.addSeparator();
      appMenu.addToggle('Dark mode', ICON_DARK, () => this._effectiveTheme() === 'dark', () => this._toggleDarkMode());
    }

    const rightGroup = document.createElement('span');
    rightGroup.className = 'scribe-edit-group';
    rightGroup.append(ocrSplit);
    this.toolbarElemEnd.insertBefore(rightGroup, this.toolbarElemEnd.firstChild);

    // A subtle recognition progress line along the toolbar's bottom edge, hidden until OCR runs.
    // In the phone layout it rides the dock's top edge instead (and `_setPhoneChrome` moves it on flips).
    const progressBar = document.createElement('div');
    progressBar.className = 'scribe-ocr-progress';
    this._ocrProgress = progressBar;
    const progressHost = (this._phoneChrome && this._dockElem) ? this._dockElem : this.toolbarElemEnd?.parentElement;
    progressHost?.appendChild(progressBar);

    this._updateRecognizeButton();
    this._updateCombineButton();
    this._updateSplitButton();
  }

  /**
   * Pages deep OCR would recognize for the current document, or 0 when there is none.
   * Drives the Recognize Text button's visibility and the progress bar's page total.
   * @returns {number}
   */
  _deepOcrPageCount() {
    const doc = this.doc;
    if (!doc) return 0;
    // While a deferred import's stats are still extracting, return 0 so the Recognize button stays hidden instead of flashing on then vanishing.
    // `_setDoc` re-runs this once `textReady` lands.
    if (doc._textReadySettle) return 0;
    const { pageStats, pageCount, pdfType } = doc.inputData;
    if (doc.ocr?.['User Upload'] || !pageStats || pageStats.length !== pageCount) return pageCount;
    return selectOcrPages(pageStats, pdfType, 'autoDeep').filter(Boolean).length;
  }

  /** Show the recognition surfaces only when deep OCR would actually recognize at least one page. */
  _updateRecognizeButton() {
    const pages = this._deepOcrPageCount();
    if (this._ocrSplit) this._ocrSplit.style.display = pages > 0 ? '' : 'none';
    if (this._ocrMenuItem) this._ocrMenuItem.style.display = pages > 0 ? '' : 'none';
  }

  /** Show the Combine menu item only when 2+ documents (tabs) are open. Combining one document is a no-op. */
  _updateCombineButton() {
    if (this._combineItem) this._combineItem.style.display = this._tabs.length >= 2 ? '' : 'none';
    this._updateDocSeparator();
  }

  /** Show the Split menu item only when the active document's top-level bookmarks would yield 2+ files. */
  _updateSplitButton() {
    if (this._splitItem) {
      const doc = this.doc;
      const count = doc ? outlineSplitSegments(doc.outline || [], doc.pageMetrics.length).length : 0;
      this._splitItem.style.display = count >= 2 ? '' : 'none';
    }
    this._updateDocSeparator();
  }

  /** Hide the app menu's document-actions separator when neither Combine nor Split applies, so it never leaves a stray rule. */
  _updateDocSeparator() {
    if (!this._appMenuDocSep) return;
    const anyVisible = (this._combineItem && this._combineItem.style.display !== 'none')
      || (this._splitItem && this._splitItem.style.display !== 'none');
    this._appMenuDocSep.style.display = anyVisible ? '' : 'none';
  }

  /**
   * The active tab's display name, for use as the download filename (the exporter adds the extension).
   */
  _baseName() {
    return this._tabs[this._activeTab]?.name
      || this.doc?.inputData?.defaultDownloadFileName
      || 'document';
  }

  /**
   * Recognize the auto-selected (deep) pages, showing a subtle progress line, then re-render the current page so the new text appears.
   * @param {HTMLSpanElement} btn - The button to show a busy state on.
   */
  async _recognizeAll(btn) {
    const doc = this.doc;
    if (!doc) return;
    const label = btn.textContent;
    btn.textContent = 'Recognizing…';
    btn.classList.add('busy');

    // Key the bar strictly on `convert` events (deduped by page index) so the faster pre-render `render` events do not inflate it.
    // It runs from a 0.04 sliver to 0.9, reserving the last tenth for the compare/optimize tail (no page index), which the snap-to-full fills on success.
    const bar = this._ocrProgress;
    const total = this._deepOcrPageCount();
    const seen = new Set();
    if (bar) {
      bar.style.transition = 'none';
      bar.style.transform = 'scaleX(0.04)';
      bar.style.opacity = '1';
      bar.getBoundingClientRect();
      bar.style.transition = '';
    }
    const prevProgress = doc.progressHandler;
    doc.progressHandler = (msg) => {
      prevProgress?.(msg);
      if (msg && msg.type === 'convert' && typeof msg.n === 'number') seen.add(msg.n);
      if (bar && total > 0) bar.style.transform = `scaleX(${Math.max(0.04, 0.9 * Math.min(1, seen.size / total))})`;
    };

    let ok = false;
    try {
      await doc.recognize({ langs: this.scribe.opt.langs, ocrPages: 'autoDeep' });
      ok = true;
      await this.scribe.displayPage(this.scribe.state.cp.n, false, true);
    } catch (err) {
      console.error('OCR failed:', err);
      // A banner, not a toast: recognition is a long async job the user may have stepped away from.
      this._showBanner('Text recognition didn’t finish. The document was left unchanged.');
    } finally {
      doc.progressHandler = prevProgress;
      btn.textContent = label;
      btn.classList.remove('busy');
      if (bar) {
        if (ok) bar.style.transform = 'scaleX(1)';
        setTimeout(() => { bar.style.opacity = '0'; }, ok ? 250 : 0);
        setTimeout(() => { bar.style.transform = 'scaleX(0)'; }, 600);
      }
    }
  }

  /**
   * Read the persisted theme setting.
   * @returns {'system' | 'light' | 'dark'} The stored theme, or 'system' (follow the OS) when nothing is persisted.
   */
  // eslint-disable-next-line class-methods-use-this
  _readThemeSetting() {
    try {
      const v = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (v === 'system' || v === 'light' || v === 'dark') return v;
    } catch { /* localStorage unavailable (private mode / sandbox). Fall through to default. */ }
    return 'system';
  }

  /** Resolve the setting + OS preference, apply `data-theme` to the root, and start tracking OS changes. */
  _initTheme() {
    this._themeSetting = this._readThemeSetting();
    this._osDarkQuery = (typeof window !== 'undefined' && window.matchMedia)
      ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    this._applyTheme();
    if (this._osDarkQuery && this._osDarkQuery.addEventListener) {
      // Reflect live OS light/dark switches, but only while the user's setting defers to the system.
      const onChange = () => { if (this._themeSetting === 'system') this._applyTheme(); };
      this._osDarkQuery.addEventListener('change', onChange);
      this._teardownCallbacks.push(() => this._osDarkQuery.removeEventListener('change', onChange));
    }
  }

  /**
   * The theme actually in effect: the explicit setting, or the OS preference when set to 'system'.
   * @returns {'light' | 'dark'}
   */
  _effectiveTheme() {
    if (this._themeSetting === 'system') return (this._osDarkQuery && this._osDarkQuery.matches) ? 'dark' : 'light';
    return this._themeSetting;
  }

  /** Apply the effective theme to the root. Light is the default (no attribute). Dark sets `data-theme="dark"`. */
  _applyTheme() {
    if (this._effectiveTheme() === 'dark') this.pdfViewerElem.setAttribute('data-theme', 'dark');
    else this.pdfViewerElem.removeAttribute('data-theme');
  }

  /**
   * Change the theme setting: persist it and re-apply.
   * @param {'system' | 'light' | 'dark'} value - The new theme setting to persist.
   */
  _setThemeSetting(value) {
    this._themeSetting = value;
    try { window.localStorage.setItem(THEME_STORAGE_KEY, value); } catch { /* localStorage unavailable. The choice just won't persist. */ }
    this._applyTheme();
  }

  /**
   * Toggle Dark mode: flip to the opposite of the theme currently in effect, taking over from the OS default in the direction the user sees.
   * This becomes an explicit ('light' | 'dark') preference.
   */
  _toggleDarkMode() {
    this._setThemeSetting(this._effectiveTheme() === 'dark' ? 'light' : 'dark');
  }

  static _editStyleAdded = false;

  /** Inject the editor-only control styles once (base control styles come from `addControlStyles`). */
  static _addEditorStyles() {
    if (ScribePDFViewer._editStyleAdded) return;
    ScribePDFViewer._editStyleAdded = true;
    const style = document.createElement('style');
    style.appendChild(document.createTextNode(`
      .scribe-pdf-viewer .scribe-edit-group {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin-right: 6px;
      }
      .scribe-pdf-viewer .scribe-edit-btn {
        cursor: pointer;
        user-select: none;
        box-sizing: border-box;
        gap: 6px;
        padding: 0 10px;
        height: var(--scribe-icon-size, 28px);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        font-size: 13px;
        color: var(--scribe-ink);
        white-space: nowrap;
      }
      .scribe-pdf-viewer .scribe-edit-btn:hover { background: var(--scribe-hover); }
      .scribe-pdf-viewer .scribe-edit-btn.active { background: var(--scribe-active); }
      .scribe-pdf-viewer .scribe-edit-btn.busy { opacity: .6; pointer-events: none; }
      .scribe-pdf-viewer .scribe-edit-btn-ic { display: inline-flex; align-items: center; }
      .scribe-pdf-viewer .scribe-edit-btn-ic svg { width: 16px; height: 16px; display: block; color: var(--scribe-ink-2); }

      /* OCR split button: one pill with a main face and a caret, divided by a hairline. */
      .scribe-pdf-viewer .scribe-edit-split { position: relative; display: inline-flex; align-items: stretch; }
      .scribe-pdf-viewer .scribe-edit-split-main { border-radius: 6px 0 0 6px; padding: 0 8px 0 10px; }
      .scribe-pdf-viewer .scribe-edit-split-caret { border-radius: 0 6px 6px 0; padding: 0 5px; }
      .scribe-pdf-viewer .scribe-edit-split-caret::before {
        content: ''; position: absolute; left: 0; top: 6px; bottom: 6px; width: 1px; background: var(--scribe-line-strong);
      }
      .scribe-pdf-viewer .scribe-edit-split-caret svg { display: block; }

      /* Language menu under the recognition-language caret. */
      .scribe-pdf-viewer .scribe-edit-menu {
        position: absolute; top: calc(100% + 6px); right: 0; min-width: 150px; padding: 4px;
        background: var(--scribe-surface); border: 1px solid var(--scribe-line); border-radius: 8px;
        box-shadow: var(--scribe-menu-shadow); z-index: 30;
      }
      .scribe-pdf-viewer .scribe-edit-menu-item {
        position: relative; display: flex; align-items: center; padding: 6px 10px 6px 26px;
        border-radius: 4px; font-size: 13px; color: var(--scribe-ink); cursor: pointer; white-space: nowrap;
      }
      .scribe-pdf-viewer .scribe-edit-menu-item:hover { background: var(--scribe-hover); }
      .scribe-pdf-viewer .scribe-edit-menu-item.selected::before {
        content: ''; position: absolute; left: 10px; top: 50%; width: 5px; height: 9px;
        border: solid var(--scribe-accent); border-width: 0 2px 2px 0; transform: translate(0, -60%) rotate(45deg);
      }

      /* Subtle recognition progress line: a 3px accent fill along the toolbar's bottom edge, scaled by progress. */
      .scribe-pdf-viewer .scribe-ocr-progress {
        position: absolute; left: 0; bottom: 0; width: 100%; height: 3px;
        background: var(--scribe-accent); transform: scaleX(0); transform-origin: left;
        opacity: 0; pointer-events: none; z-index: 25;
        transition: transform .2s ease, opacity .3s ease;
      }
      /* In the phone dock the line rides the top edge (the dock's bottom is the safe area). */
      .scribe-pdf-viewer .scribe-dock .scribe-ocr-progress { bottom: auto; top: 0; }

    `));
    document.head.appendChild(style);
  }

  /** Adds the required CSS styles to the document. Retained for backward compatibility. */
  static addIconButtonStyles = () => addControlStyles(ROOT_CLASS);
}

export {
  scribe, ScribeViewer, applyHighlight, ScribePDFViewer,
};
