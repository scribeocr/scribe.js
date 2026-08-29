import scribe from '../../scribe.js';
import { nativeTextForPage } from '../../js/textEdits.js';
import { pageImagePlacements, pagePathPlacements, pagePathsIneligible } from '../../js/fillSign.js';
import { ScribeViewer } from '../viewer.js';
// Both engines are imported so `ScribeViewer.customSelection` can toggle between them at runtime.
// Import only one for a slimmer build.
import '../js/selection/customSelectionEngine.js';
import '../js/selection/domSelectionEngine.js';
import { applyHighlight } from '../js/viewerHighlights.js';
import { getHighlightFields, setHighlightFields, docHasFormFields } from '../js/viewerFormFields.js';
import {
  signIntoField, selectedFillItem, deleteSelectedFillItem, deselectFillItem,
} from '../js/viewerFillSign.js';
import {
  destroyContextMenu, graphicsDeleteLabel, CM_COPY_SVG, CM_EDIT_SVG, CM_BOLD_SVG, CM_ITALIC_SVG, CM_TRASH_SVG,
} from '../js/viewerCanvasInteraction.js';
import {
  addControlStyles, makeToolbarShell, makeSeparator, makeIconButton, createPageNav, createZoomControls, createRotateControls, createPrintControls, createOpenControls, createTabStrip, createSearchBar,
  createAppMenu, OPEN_SVG, PRINT_SVG, RECENT_SVG, ROTATE_LEFT_SVG, ROTATE_RIGHT_SVG, UNDO_SVG, REDO_SVG,
} from '../js/controls/toolbar.js';
import { MENU_PLATE_CSS } from '../js/controls/menuStyles.js';
import { createThumbnailPanel, createScrollbars } from '../js/controls/panels.js';
import { createCompanionStrip } from '../js/controls/companionStrip.js';
import { createPagesMorph } from '../js/controls/pagesMorph.js';
import { createBookmarksPanel, BOOKMARK_SVG } from '../js/controls/bookmarksPanel.js';
import { createCommentsPanel, COMMENT_SVG } from '../js/controls/commentsPanel.js';
import {
  createHighlightTool, createDropZone, openDocumentFromFile, createRedactTool, createEditTextTool,
  createGraphicsEditTool, createFillSignTool, createEditPagesTool, createRecognizeTextTool, createExtractTablesTool,
} from '../js/controls/tools.js';
import { filesFromDropEvent } from '../js/dragAndDrop.js';
import { SeedDoc } from '../js/seedDoc.js';
import { IOS_WEBKIT } from '../js/viewerImageCache.js';
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
const DOCK_PANELS_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"'
  + ' stroke-linejoin="round" style="pointer-events:none;display:block;width:100%;height:100%" aria-hidden="true">'
  + '<path d="M8.5 6h11.5M8.5 12h11.5M8.5 18h7M4 6h1.2M4 12h1.2M4 18h1.2"/></svg>';
// Broken selection corners, for the verb bar's Deselect.
const DOCK_DESELECT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"'
  + ' stroke-linejoin="round" style="pointer-events:none;display:block;width:100%;height:100%" aria-hidden="true">'
  + '<path d="M5 8V6.5A1.5 1.5 0 0 1 6.5 5H8M16 5h1.5A1.5 1.5 0 0 1 19 6.5V8M19 16v1.5a1.5 1.5 0 0 1-1.5 1.5H16M8 19H6.5A1.5 1.5 0 0 1 5 17.5V16"/>'
  + '<path d="M9.6 9.6l4.8 4.8M14.4 9.6l-4.8 4.8"/></svg>';
// Lines with a pencil, for the dock's Edit slot.
const DOCK_EDIT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"'
  + ' stroke-linejoin="round" style="pointer-events:none;display:block;width:100%;height:100%" aria-hidden="true">'
  + '<path d="M4 5.5h16"/><path d="M4 10h9.5"/><path d="M4 14.5h5.5"/><path d="M16.6 9.4l3.6 3.6-7.2 7.2-4.3.7.7-4.3z"/></svg>';

const SIDEBAR_TOGGLE_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"'
  + ' stroke-linejoin="round" style="pointer-events:none;display:block" aria-hidden="true">'
  + '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/></svg>';

/** Contact-sheet grid for the sidebar's thumbnails tab. */
const SIDEBAR_PAGES_SVG = '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="currentColor">'
  + '<rect x="2.3" y="2.3" width="5.1" height="5.1" rx="1"/><rect x="8.6" y="2.3" width="5.1" height="5.1" rx="1"/>'
  + '<rect x="2.3" y="8.6" width="5.1" height="5.1" rx="1"/><rect x="8.6" y="8.6" width="5.1" height="5.1" rx="1"/></svg>';

/** Height of the sidebar's view-switch strip, in px, matching its CSS. */
const SIDEBAR_TABS_HEIGHT = 36;

/** Height of the mode bar (the strip carrying the active tool mode's identity, description, and controls), in px, matching its CSS. */
const MODE_BANNER_HEIGHT = 40;

/** Air required to keep the rotate pair in the centered viewing cluster. */
const ROTATE_MIN_AIR = 80;

// The up/down pair is the macOS marker for a pop-up showing the current choice, where a single chevron would mean a pull-down menu of actions.
const TRACK_MENU_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"'
  + ' stroke-linejoin="round" style="pointer-events:none;display:block;width:100%;height:100%" aria-hidden="true">'
  + '<path d="M8.4 9.7 12 6.1l3.6 3.6M8.4 14.3 12 17.9l3.6-3.6"/></svg>';

/**
 * Pointer glyph for the mode drop-down's View item.
 * The path sits off the box's geometric center so the arrow's ink centroid lands on the optical center.
 */
const TRACK_VIEW_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"'
  + ' stroke-linejoin="round" style="pointer-events:none;display:block;width:100%;height:100%" aria-hidden="true">'
  + '<path d="M8.4 4.4v12.6l3.2-2.9 2.1 4.9 2.5-1.1-2.1-4.8h4.3z"/></svg>';

/** Height of the dismissible message banner, in px, matching its CSS. */
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

/** localStorage key for the page-layout preference: 'single' | 'double', with an optional '-cover' suffix remembering book pairing. */
const PAGE_LAYOUT_STORAGE_KEY = 'scribe-page-layout';

/** localStorage key for the assistant's user-pasted API key, deliberately persisted until the key card's Forget action clears it. */
const ASSISTANT_KEY_STORAGE_KEY = 'scribe-assistant-api-key';

/** localStorage key for the assistant's chosen model, holding the provider's model id rather than its display label. */
const ASSISTANT_MODEL_STORAGE_KEY = 'scribe-assistant-model';

/** Chevron-down for the Recognize Text mode's language button. */
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
const ICON_FIELDS = editIcon('<rect x="3.5" y="7.5" width="17" height="9" rx="1.2"/><path d="M7 12h5"/>');
/** Open book for the toolbar's two-page (side-by-side) view toggle. */
const ICON_TWO_PAGE = editIcon('<path d="M12 6.1C10.4 4.8 7.9 4.3 4.5 4.5v13.7c3.4-.2 5.9.3 7.5 1.7 1.6-1.4 4.1-1.9 7.5-1.7V4.5c-3.4-.2-5.9.3-7.5 1.6Z"/><path d="M12 6.1v13.8"/>');
/** Facing-page pair for the app menu's cover-page row. */
const ICON_COVER_ALONE = editIcon('<rect x="3.5" y="5" width="7.6" height="14" rx="1"/><rect x="12.9" y="5" width="7.6" height="14" rx="1"/>');
/** Scan corners around a letterform, for the touch-only Recognize text menu row. */
// eslint-disable-next-line max-len
const ICON_RECOGNIZE = editIcon('<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><path d="M9 15V9.8A0.8 0.8 0 0 1 9.8 9h4.4a0.8 0.8 0 0 1 0.8 0.8V15M9 12.6h6"/>');
// The Automate glyph, duplicated here (like the other app-menu icons) so the menu row needs no import from the flag-gated panel module.
const ICON_AUTOMATE = editIcon('<path d="M5 7.2l5.6 4.8L5 16.8z"/><path d="M14 7.5h5.5M14 12h5.5M14 16.5h3.5"/>');

/**
 * @typedef {object} FitResult
 * @property {number} zoom
 * @property {number} [x]
 * @property {number} [y]
 */

/**
 * @typedef {'width' | 'height' | 'page' | ((imgDims: {width: number, height: number}, viewerDims: {width: number, height: number}) => FitResult)} FitMode
 */

// A release still travelling down this fast, in px/ms, closes the panel.
const FLICK_SPEED = 0.45;
const FLICK_WINDOW_MS = 100;
const FLICK_MIN_TRAVEL = 24;
// Two samples a fraction of a millisecond apart divide out to any speed at all, so a release measured over less than a frame cannot be read as a flick.
const FLICK_MIN_INTERVAL_MS = 8;

/**
 * The release decision shared by the phone's pull-down panels.
 * A quick flick closes a panel just as a long deliberate pull does.
 */
function createPullDismiss() {
  let startY = 0;
  /** @type {Array<{t: number, y: number}>} */
  const samples = [];
  return {
    begin(y) {
      startY = y;
      samples.length = 0;
    },
    /**
     * Record a move.
     * Chrome reports a cancel at (0, 0), so only real moves may be fed here.
     */
    track(y) {
      const t = performance.now();
      samples.push({ t, y });
      // Two samples always remain, because a speed needs a delta to measure.
      // A stale one is safe, since it only lengthens the interval that speed is measured over.
      while (samples.length > 2 && t - samples[0].t > FLICK_WINDOW_MS) samples.shift();
    },
    /**
     * Whether letting go here closes the panel.
     * @param {number} down - How far the panel rode down, in px.
     * @param {number} travel - The panel's full travel, in px.
     */
    dismisses(down, travel) {
      if (down > Math.min(140, travel * 0.25)) return true;
      const last = samples[samples.length - 1];
      if (!last || last.y - startY < FLICK_MIN_TRAVEL || performance.now() - last.t > FLICK_WINDOW_MS) return false;
      const dt = last.t - samples[0].t;
      return dt >= FLICK_MIN_INTERVAL_MS && (last.y - samples[0].y) / dt >= FLICK_SPEED;
    },
  };
}

/**
 * Make a bottom sheet's header its drag handle.
 * @param {HTMLElement} sheet
 * @param {HTMLElement} handle - The sheet's header, whose whole box is the drag surface.
 * @param {object} opts
 * @param {HTMLElement} opts.host - Element the resize is measured against.
 * @param {boolean} opts.resizable - Whether the pull resizes the sheet as it goes, or only dismisses it.
 * @param {() => void} opts.onDismiss - Close the sheet. The dragged height and transform are left for it to clear.
 * @param {HTMLElement} [opts.body] - The sheet's content box, pinned at its rest height while a resize drag runs.
 * @param {() => void} [opts.onEngage] - Runs once per drag, as it passes the slop.
 * @param {() => void} [opts.onSettle] - Runs on the release of a drag that kept the sheet open.
 */
function attachSheetDrag(sheet, handle, {
  host, resizable, onDismiss, body, onEngage, onSettle,
}) {
  let dragActive = false;
  let dragStartY = 0;
  let dragStartH = 0;
  let dragOver = 0;
  let dragMoved = false;
  let dragFromButton = false;
  let unpinT = null;
  const pull = createPullDismiss();
  handle.addEventListener('pointerdown', (e) => {
    // A second concurrent touch must not re-base the gesture mid-drag.
    if (dragActive) return;
    dragActive = true;
    if (unpinT) { clearTimeout(unpinT); unpinT = null; }
    pull.begin(e.clientY);
    dragStartY = e.clientY;
    dragStartH = sheet.getBoundingClientRect().height;
    dragOver = 0;
    dragMoved = false;
    dragFromButton = !!(e.target instanceof Element && e.target.closest('button'));
    // An immediate capture under a header button retargets that button's click to the handle, so a press starting on one captures only once the drag passes the slop.
    if (!dragFromButton) {
      try { handle.setPointerCapture(e.pointerId); } catch { /* untrusted event: move/up still arrive by bubbling */ }
    }
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragActive) return;
    pull.track(e.clientY);
    const dy = dragStartY - e.clientY;
    if (!dragMoved && Math.abs(dy) < 6) return;
    if (!dragMoved && dragFromButton) {
      try { handle.setPointerCapture(e.pointerId); } catch { /* see above */ }
    }
    if (!dragMoved && onEngage) onEngage();
    // Without the pin, centered content re-centers as the box shrinks and slides within the card.
    // Measure before flex: none collapses the body to its content height.
    if (!dragMoved && resizable && body) {
      const restH = body.getBoundingClientRect().height;
      body.style.flex = 'none';
      body.style.height = `${restH}px`;
      sheet.style.overflow = 'hidden';
    }
    dragMoved = true;
    sheet.classList.add('dragging');
    if (resizable) {
      const avail = host.clientHeight;
      const targetH = dragStartH + dy;
      // The resize floor doubles as the release-to-close threshold, so the bottom edge detaching announces that letting go dismisses.
      const floorH = Math.max(140, avail * 0.28);
      sheet.style.height = `${Math.min(Math.round(avail * 0.5), Math.max(floorH, targetH))}px`;
      dragOver = Math.max(0, floorH - targetH);
    } else {
      dragOver = Math.max(0, -dy);
    }
    sheet.style.transform = dragOver ? `translateY(${dragOver}px)` : '';
  });
  /** Settle a finished drag from a release or a cancel, snapping the sheet back to its rest position or dismissing it. */
  const settleDrag = () => {
    sheet.getBoundingClientRect();
    sheet.classList.remove('dragging');
    // The pin outlasts the release, since the snap back to rest height re-centers the contents just as the drag did.
    if (resizable && body) {
      unpinT = setTimeout(() => {
        unpinT = null;
        body.style.flex = '';
        body.style.height = '';
        sheet.style.overflow = '';
      }, 300);
    }
    // A resize only overshoots after crossing its floor, so any overshoot at all commits the dismissal.
    // The zero travel passed for a resize is what drops that threshold to nothing.
    // A sheet that hugs its content has no floor to cross, so its ride down must clear a quarter of the card.
    if (pull.dismisses(dragOver, resizable ? 0 : dragStartH)) {
      onDismiss();
      return;
    }
    if (resizable) sheet.style.height = '';
    sheet.style.transform = '';
    if (onSettle) onSettle();
  };
  handle.addEventListener('pointerup', () => {
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
  handle.addEventListener('pointercancel', () => {
    if (!dragActive) return;
    dragActive = false;
    if (dragMoved) settleDrag();
    // No click composes after a cancel, so clear the flag here or the swallow guard below would eat the next real tap.
    dragMoved = false;
  });
  // A drag that began on a button still composes a click on release (the capture retargets it here), so swallow it or the drag would also fire that button.
  handle.addEventListener('click', (e) => {
    if (dragMoved) {
      e.stopPropagation();
      e.preventDefault();
      dragMoved = false;
    }
  }, true);
}

class ScribePDFViewer {
  static _coreErrorsWired = false;

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
   * @param {boolean} [options.showSidebar=true] - Render the collapsible sidebar and its toolbar toggle.
   *   The sidebar holds page thumbnails, bookmarks, and (with `comments`) comments.
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
   * @param {boolean} [options.editText=edit] - Enable the Edit Text tool and its toolbar button.
   *   Defaults to `edit`. Pass `false` to keep editing on but text editing off.
   * @param {boolean} [options.automate=false] - Enable the Automate panel, a right-docked surface for running document automations.
   *   It adds a toolbar opener, an app-menu row, and hand-off rows in the selection menu.
   *   Requires `edit`.
   *   Under construction.
   * @param {?import('../js/assistant/assistant.js').AssistantAdapter} [options.assistantAdapter=null] - The LLM connection
   *   behind the Automate panel's assistant, injected by hosts that hold their own credentials.
   *   Without it, the panel offers in-app key entry and constructs the Anthropic adapter from the pasted key.
   *   An adapter that exposes a `models` roster gets the composer's model picker.
   * @param {boolean} [options.library=false] - Enable the document library: a full-screen surface for browsing,
   *   searching, and managing a user-chosen local folder of PDFs, with edits persisted to `.scribe` sidecar files.
   *   Requires the File System Access API (Chromium); on other browsers the option is silently ignored.
   * @param {number} [options.docMemoryBudgetMB] - Device memory budget for open documents; opening past it is refused.
   *   Defaults to 600 on iOS-class WebKit and unlimited elsewhere.
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
      showSidebar = true,
      fit = 'height',
      autoResize = true,
      keyboardScope = 'focused',
      comments = false,
      edit = true,
      redact = edit,
      editText = edit,
      automate = false,
      assistantAdapter = null,
      library = false,
    } = options;

    // Warm the built-in fonts now, since the word layer of a fast first open (a library seed, a deferText import) otherwise waits on them.
    // Through `init` rather than a bare font load, because fonts that finish loading before any worker pool has started never reach the workers.
    scribe.init({ font: true }).catch(() => {});

    this.container = container;
    this.showToolbar = showToolbar;
    this.showDropZone = showDropZone;
    this.showScrollbars = showScrollbars;
    this.showSidebar = showSidebar;
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
     * `asleep` marks a document whose worker pools are suspended (main-thread state retained).
     * `waking` marks one respawning its pools during activation.
     * `lastUse` orders tabs for the warm set.
     * @type {Array<{ doc: import('../../js/containers/scribeDoc.js').ScribeDoc, name: string, lastPage: number, lastUse: number,
     *   asleep: boolean, waking: boolean, onDocHydrated?: (doc: Object) => void }>}
     */
    this._tabs = [];
    /** Index of the active tab in `_tabs`, or -1 when none is open. */
    this._activeTab = -1;
    /** Last active-document name announced via the `scribe-active-doc-change` event, or null when none was open. */
    this._announcedDocName = null;
    /** Whether the tab strip currently occupies layout space. */
    this._tabStripVisible = false;
    /**
     * Open-tab count at which the strip appears.
     * The library lowers it to 1 so its pinned Library tab has a home.
     */
    this._tabStripMinTabs = 2;
    this._modeTrackOpen = false;
    /** @type {?HTMLElement} */
    this._modeTrackWrap = null;
    /** @type {?HTMLElement} */
    this._modeTrackEl = null;
    /** @type {?HTMLElement} */
    this._modeTrackRow1 = null;
    /** @type {?HTMLElement} */
    this._modeTrackMore = null;
    /** @type {?HTMLElement} */
    this._modeTrackChev = null;
    /** @type {?HTMLElement} */
    this._modeTrackViewBtn = null;
    /** Monotonic counter stamped onto a tab's `lastUse` at creation and on every activation. */
    this._tabUseCounter = 0;
    /**
     * Device memory budget for open documents, in bytes. Opening past it is refused with a toast.
     * Finite by default only on iOS-class WebKit, where jetsam kills the page well before desktop-scale memory use.
     * @type {number}
     */
    this._docBudgetBytes = (options.docMemoryBudgetMB ?? (IOS_WEBKIT ? 600 : Infinity)) * 1024 * 1024;

    /**
     * The `ScribeViewer` instance backing this viewer. Each `ScribePDFViewer` owns its own
     * `ScribeViewer`, so multiple `ScribePDFViewer` instances can coexist on the page without
     * sharing state. Pass `options.scribe` to attach to an existing instance.
     * @type {ScribeViewer}
     */
    this.scribe = options.scribe || new ScribeViewer();
    this.scribe.opt.keyboardScope = keyboardScope;
    // This app uses no pan-style navigation in any view mode, so the middle button autoscrolls everywhere.
    this.scribe.opt.middleClickPan = false;
    this.scribe.opt.enableComments = comments;
    this.scribe.opt.enableForms = true;
    if (edit) {
      this.scribe.opt.enablePageEditing = true;
      this.scribe.opt.enableRecognition = true;
    }

    /**
     * Persisted page-layout preference.
     * The `-cover` suffix survives single-page mode, so re-entering two-page view restores book pairing.
     * @type {'single'|'double'|'single-cover'|'double-cover'}
     */
    this._pageLayoutSetting = this._readPageLayoutSetting();
    this._applyPageLayoutPref();

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
    this._phoneUi = false;
    /** @type {?HTMLElement} Toolbar undo button, absent from read-only builds. */
    this._undoBtnElem = null;
    /** @type {?HTMLElement} Toolbar redo button, absent from read-only builds. */
    this._redoBtnElem = null;
    /** @type {?HTMLElement} Mode the baseline below was captured for, so repeated syncs of one mode do not recapture it. */
    this._modeSessionBtn = null;
    /** @type {number} Unified-history depth at mode entry, or -1 outside an editing-mode session. */
    this._modeBaseline = -1;
    /** @type {?HTMLDivElement} The phone bottom dock, built on first phone-mode entry. */
    this._dockElem = null;
    /** @type {?ReturnType<typeof createCompanionStrip>} Persistent page filmstrip + scrubber above the dock (phone only). */
    this._companionStrip = null;
    /** The session's tucked-bar choice, kept across documents but not across launches. */
    this._stripTucked = false;
    /** Strip tuck/reveal drag in progress: the document lays out full-height so the moving bar rides over live pages. */
    this._stripDragLayout = false;
    /** @type {?ReturnType<typeof setTimeout>} Timer restoring the strip inset once a reveal's glide lands. */
    this._stripRelayoutT = null;
    /** @type {?HTMLSpanElement} The dock's Panels button (opens the bottom sheet). */
    this._sheetPanelsBtn = null;
    /** @type {?HTMLSpanElement} The dock's Edit slot, which raises the mode sheet and lights while a mode runs. */
    this._dockEditBtn = null;
    /** @type {?HTMLDivElement} The sheet listing the tool modes, mirrored from their toolbar buttons. */
    this._modeSheetElem = null;
    /** @type {?HTMLDivElement} The dock's mode bar, shown in place of the navigation row while a mode runs. */
    this._dockModeRow = null;
    /** @type {?{ic: HTMLSpanElement, nm: HTMLSpanElement, status: HTMLSpanElement}} */
    this._dockModeParts = null;
    /** @type {WeakMap<object, string>} Documents recognized this session, keyed to the run's language signature, and never exported. */
    this._recognizeRuns = new WeakMap();
    /** @type {?HTMLDivElement} The docked verb bar for the picked line or placement. */
    this._vbarElem = null;
    this._fsBarOn = false;
    /** @type {?HTMLElement} The Fill & Sign palette's phone undo button. */
    this._fsUndoBtn = null;
    /** @type {?Object<string, HTMLElement>} */
    this._vbarParts = null;
    this._phoneLineEditing = false;
    /** @type {?{zoom: number, left: number, top: number}} The reading position a line edit's zoom must restore. */
    this._phoneEditRestore = null;
    /** The software keyboard's current overlap with this component's bottom edge, in px. */
    this._kbInset = 0;
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
    /** @type {?ReturnType<typeof setTimeout>} Timer releasing the room's grid once its slide-down behind the dock lands. */
    this._roomSlideT = null;
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
    this.pdfViewerElem.style.fontFamily = '-apple-system, system-ui, \'Segoe UI\', sans-serif';

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

    /** @type {?ReturnType<typeof createSearchBar>} */
    this._searchBar = null;
    /** @type {?{destroy: () => void}} Handle from the dynamically imported library feature. */
    this._library = null;
    this._destroyed = false;
    /**
     * Callbacks the library registers so tab lifecycle events can checkpoint-save `.scribe` sidecars.
     * @type {?{docOpened?: () => void, emptied?: () => void, saveTabIfDirty?: (tab: Object) => Promise<void>, saveAllDirty?: () => Promise<void>}}
     */
    this._libraryHooks = null;
    /**
     * Fired when a document's assistant history changes, so the embedder can mark that document's session dirty.
     * The document is passed rather than assumed active, because a turn can settle after the user switches tabs.
     * @type {?(doc: Object) => void}
     */
    this.onAssistantHistoryEdited = null;
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
    this._thumbnailPanel = showSidebar
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
    this._activeSidebar = null;
    /**
     * The view the rail reopens on when a document arrives in the empty viewer.
     * @type {'thumbnails'|'bookmarks'|'comments'|null}
     */
    this._sidebarWhenLoaded = showSidebar ? 'thumbnails' : null;
    // The empty viewer has no pages to list, so the rail starts closed rather than drawing its edge across the drop zone.
    if (this._thumbnailPanel) this._thumbnailPanel.setVisible(false);
    /** @type {?{raf: number}} In-flight sidebar open/close/switch transition (its live rAF handle), or null. */
    this._sidebarAnim = null;
    /** @type {?{min: number, max: number}} Rail width bounds cached for the duration of a bookmarks/comments-view resize drag. */
    this._sidebarResizeBounds = null;
    /** True while a panel resize drag (any sidebar view, or the Automate panel) is in flight, so `_relayout` skips the scrollbar refresh per move. */
    this._sidebarDragActive = false;
    /**
     * The last view that was open, which the sidebar toggle reopens.
     * @type {'thumbnails'|'bookmarks'|'comments'}
     */
    this._lastSidebarView = 'thumbnails';
    /** @type {?HTMLSpanElement} The toolbar's sidebar toggle, or null without a toolbar or sidebar. */
    this._sidebarToggleElem = null;
    /** @type {?HTMLDivElement} The sidebar's view-switch strip, pinned above the open view. */
    this._sidebarTabsElem = null;
    /** @type {Object<string, HTMLSpanElement>} The strip's tabs by view key. */
    this._sidebarTabElems = {};
    /** @type {?ReturnType<typeof import('../js/controls/automatePanel.js').createAutomatePanel>} The Automate panel (right dock), or null until its module loads. */
    this._automatePanel = null;
    /** Whether the Automate surface is on: its toolbar opener, app-menu row, and selection-menu hand-offs. */
    this._automateEnabled = edit && automate;
    /** @type {?import('../js/assistant/assistant.js').AssistantAdapter} The injected or key-constructed LLM connection. */
    this._assistantAdapter = assistantAdapter;
    /** True when the adapter came from the host, so forgetting a stored key never discards it. */
    this._assistantAdapterInjected = !!assistantAdapter;
    /** @type {?Promise<void>} Resolves once the panel exists, so the app-menu row works during the module's load. */
    this._automateReady = null;

    /** @type {?ReturnType<typeof createBookmarksPanel>} */
    this._bookmarksPanel = showSidebar
      ? createBookmarksPanel(this.scribe, {
        // The whole destination, not just the page: goToOutlineDest honors a within-page position when one exists.
        onNavigate: (dest) => this.scribe.goToOutlineDest(dest),
        // Resizing from the bookmarks view drives the shared sidebar width (see `_resizeSidebar`).
        onResize: (w, phase) => this._resizeSidebar(w, phase),
        onRenameFocus: (focused) => { if (this._phoneUi) this._sheetComposeLift(focused); },
        // The Move session swaps the sheet header for a "Moving bookmarks" bar with Done.
        onMoveSession: (active) => { if (this._sheetElem) this._sheetElem.classList.toggle('scribe-sheet-moving', active); },
      })
      : null;

    /** @type {?ReturnType<typeof createCommentsPanel>} */
    this._commentsPanel = (showSidebar && comments)
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
      // Wrapped buttons would spill out of the fixed-height bar and over the document, so this cluster never breaks to a second line.
      // Horizontal overflow is handled in `_syncModeOverflow` instead.
      toolbarButtons.style.whiteSpace = 'nowrap';
      // As an inline line box, the strut's font metrics would push these middle-aligned controls fractions of a pixel off the bar's center line.
      toolbarButtons.style.display = 'flex';
      toolbarButtons.style.alignItems = 'center';

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
      /**
       * The app's command handlers by id, shared between the in-window app menu and a desktop shell's native menus.
       * @type {Object<string, () => (void | Promise<void>)>}
       */
      this._menuCommands = {
        open: () => open.openElem.click(),
        print: () => print.printElem.click(),
        'rotate-left': () => this.scribe.rotatePage(this.scribe.state.cp.n, -90),
        'rotate-right': () => this.scribe.rotatePage(this.scribe.state.cp.n, 90),
      };
      const accelMod = navigator.platform?.startsWith('Mac') ? '⌘' : 'Ctrl+';
      appMenu.addAction('Open file', OPEN_SVG, this._menuCommands.open, `${accelMod}O`);
      // Populated by a desktop shell through `setRecentFiles`, and so left empty and hidden on the web, which cannot reopen paths.
      this._recentFilesSubmenu = appMenu.addSubmenu('Open recent', RECENT_SVG);
      appMenu.addAction('Print', PRINT_SVG, this._menuCommands.print, `${accelMod}P`);
      // Touch-only rows re-homing the controls the touch layouts drop from the bar.
      appMenu.addAction('Rotate left', ROTATE_LEFT_SVG, this._menuCommands['rotate-left'])
        .classList.add('scribe-touch-row');
      appMenu.addAction('Rotate right', ROTATE_RIGHT_SVG, this._menuCommands['rotate-right'])
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
        const startSeparator = makeSeparator();
        // Marker class lets the shells' hidden-menu mode hide the separator by CSS.
        startSeparator.classList.add('scribe-menu-sep');
        toolbarElemStart.appendChild(startSeparator);
        // The panels' own toggle elements never mount, but their `style.display` still says whether a view is offered.
        // That drives the strip's tabs and the phone sheet's buttons.
        const toggle = makeIconButton('Show sidebar', SIDEBAR_TOGGLE_SVG);
        // The marker class sits the toggle out of the library home's swapped bar alongside the other document controls.
        toggle.classList.add('scribe-sidebar-toggle');
        toggle.addEventListener('click', () => {
          if (toggle.classList.contains('disabled')) return;
          if (this._activeSidebar) {
            this._requestSidebar(this._activeSidebar);
            return;
          }
          const last = this._panelFor(this._lastSidebarView);
          this._requestSidebar((last && last.toggleElem.style.display !== 'none') ? this._lastSidebarView : 'thumbnails');
        });
        this._sidebarToggleElem = toggle;
        toolbarElemStart.appendChild(toggle);

        const tabs = document.createElement('div');
        tabs.className = 'scribe-sbtabs';
        tabs.style.display = 'none';
        const track = document.createElement('div');
        track.className = 'scribe-sbtabs-track';
        tabs.appendChild(track);
        /** @type {Array<['thumbnails'|'bookmarks'|'comments', string, string]>} */
        const views = [
          ['thumbnails', 'Page thumbnails', SIDEBAR_PAGES_SVG],
          ['bookmarks', 'Bookmarks', BOOKMARK_SVG],
          ['comments', 'Comments', COMMENT_SVG],
        ];
        for (const [key, label, svg] of views) {
          if (!this._panelFor(key)) continue;
          const tab = document.createElement('span');
          tab.className = 'scribe-sbtab';
          tab.title = label;
          tab.role = 'button';
          tab.tabIndex = 0;
          tab.ariaLabel = label;
          tab.innerHTML = svg;
          tab.addEventListener('click', () => { if (key !== this._activeSidebar) this._requestSidebar(key); });
          this._sidebarTabElems[key] = tab;
          track.appendChild(tab);
        }
        this._sidebarTabsElem = tabs;
        this.pdfViewerElem.appendChild(tabs);
      }

      if (this._editEnabled) {
        const undoBtn = makeIconButton('Undo (Ctrl+Z)', UNDO_SVG);
        undoBtn.classList.add('disabled');
        undoBtn.addEventListener('click', () => { if (!undoBtn.classList.contains('disabled')) this._doUndo(false); });
        const redoBtn = makeIconButton('Redo (Ctrl+Y)', REDO_SVG);
        redoBtn.classList.add('disabled');
        redoBtn.addEventListener('click', () => { if (!redoBtn.classList.contains('disabled')) this._doUndo(true); });
        this._undoBtnElem = undoBtn;
        this._redoBtnElem = redoBtn;
        toolbarElemStart.append(undoBtn, redoBtn);
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
      // Hidden only by the phone layout, which forces single-page view.
      // Tablets keep it, since no gesture covers a layout switch the way pinch covers zoom.
      const twoPageBtn = makeIconButton('Two page view', ICON_TWO_PAGE);
      twoPageBtn.classList.add('scribe-phone-hide');
      twoPageBtn.addEventListener('click', () => this._togglePageLayout());
      toolbarButtons.appendChild(twoPageBtn);
      this._twoPageBtn = twoPageBtn;
      this._rotateControls = rotate.rotateControls;
      this._sepBeforeRotate = sepBeforeRotate;
      if (this._highlightTool) {
        toolbarButtons.appendChild(makeSeparator());
        toolbarButtons.appendChild(this._highlightTool.toolbarElem);
      }
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
        onCloseOthers: async (i) => {
          const kept = this._tabs[i];
          if (!kept) return;
          // Activate the survivor first, so closing the active tab never loads a document that is about to be closed too.
          if (i !== this._activeTab) await this._activateTab(i);
          for (let j = this._tabs.length - 1; j >= 0; j--) {
            if (this._tabs[j] !== kept) this._closeTab(j);
          }
        },
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
      // A two-page range is not a typeable value, so focus swaps in the plain cursor page and blur restores the range.
      this.pageNumElem.addEventListener('focus', () => {
        if (this.doc) this.pageNumElem.value = (this.scribe.state.cp.n + 1).toString();
        this.pageNumElem.select();
      });
      this.pageNumElem.addEventListener('blur', () => this._syncPageNumDisplay());
      this.prevElem = pageNav.prevElem;
      this.nextElem = pageNav.nextElem;
      // Retained because the phone dock borrows the group (`_setPhoneUi`) and must return it beside `nextElem`.
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
    this._setPhoneUi(initWidth <= 480 || (this._coarsePointer && initHeight <= 480));
    // _setPhoneUi above early-returns when the layout does not change, so a desktop boot applies the empty-state dimming here.
    this._syncDocGatedControls();

    this._installFit(fit, options.fit === undefined);

    this.scribe.init(this.viewerContainer, initWidth, initHeight - this._topBarsHeight() - this._bottomBarsHeight());

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
        const changed = inset !== this._kbInset;
        this._kbInset = inset;
        this.pdfViewerElem.style.setProperty('--scribe-kb-inset', `${inset}px`);
        // The keyboard rises after the editor takes focus, so an open line edit re-insets and re-scrolls here.
        if (changed && this._phoneLineEditing) {
          this._relayout();
          this._phoneEditEnsureVisible();
        }
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
        dragOverlay.style.top = `${this._topBarsHeight()}px`; // sit below the toolbar and tab strip, leaving them visible
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
      // A drop fires no matching `dragleave`, so the visuals clean up on the drop itself, in the capture phase.
      // A descendant that claims the drop with stopPropagation (the library surface does) would otherwise strand the armed overlay behind it until the surface hides.
      // Running before the bubble handler is safe because gapAt reads grid geometry, not the indicator visuals.
      /** @param {DragEvent} event */
      const onDropCapture = (event) => {
        if (!isFileDrag(event)) return;
        hideDragOverlay();
        if (this._thumbnailPanel) this._thumbnailPanel.dropIndicator.hide();
      };
      // The overlay is `pointer-events:none`, so the drop lands on the canvas/rail and bubbles to this root listener.
      /** @param {DragEvent} event */
      const onDrop = async (event) => {
        if (!this.doc || !isFileDrag(event)) return;
        event.preventDefault();
        const overRail = overThumbnailRail(event.clientX, event.clientY);
        const gap = overRail ? this._thumbnailPanel.dropIndicator.gapAt(event.clientX, event.clientY) : -1;
        const files = await filesFromDropEvent(event);
        if (files.length === 0) return;
        if (overRail) await this.insertPagesFromFiles(files, gap);
        else await this.openFiles(files);
      };
      // Listen on the viewer's own root, never `window`/`document`, so the embedded component adds no global side effects.
      this.pdfViewerElem.addEventListener('dragenter', onDragEnter);
      this.pdfViewerElem.addEventListener('dragover', onDragOver);
      this.pdfViewerElem.addEventListener('dragleave', onDragLeave);
      this.pdfViewerElem.addEventListener('drop', onDropCapture, true);
      this.pdfViewerElem.addEventListener('drop', onDrop);
      this._teardownCallbacks.push(() => {
        this.pdfViewerElem.removeEventListener('dragenter', onDragEnter);
        this.pdfViewerElem.removeEventListener('dragover', onDragOver);
        this.pdfViewerElem.removeEventListener('dragleave', onDragLeave);
        this.pdfViewerElem.removeEventListener('drop', onDropCapture, true);
        this.pdfViewerElem.removeEventListener('drop', onDrop);
      });
    }

    const origCallback = this.scribe.displayPageCallback;
    this.scribe.displayPageCallback = () => {
      if (origCallback) origCallback();
      this._syncPageNumDisplay();
      this._syncDockPageNumWidth();
      // Keep the navbar total in sync with the live page count. Every op that changes the count (paste, insert, delete, move, undo/redo) ends in displayPage, so refreshing here covers them all.
      if (this.pageCountElem && this.doc) this.pageCountElem.textContent = this.doc.inputData.pageCount.toString();
      if (this._updateScrollbars) this._updateScrollbars();
      if (this._thumbnailPanel) this._thumbnailPanel.setActive(this.scribe.state.cp.n);
      if (this._bookmarksPanel) this._bookmarksPanel.setActive();
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
      this._syncUndoState();
    };

    // Every page-structure or rotation edit must refresh the passive mirrors that render pages by index, or the filmstrip and the bookmarks/comments panels keep showing the pre-edit pages.
    this.scribe.onPageEditCallback = (kind) => {
      // Rotation can originate outside the rail (the page context menu, the touch menu rows), and its thumbs would keep the old aspect.
      // A structural edit's refresh would restyle rows mid-slide, and the rail already updates itself in place for those.
      if (kind === 'rotate' && this._thumbnailPanel) this._thumbnailPanel.refit();
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
        if (this._phoneUi) {
          this._openSheet();
          this._showSheetView('bookmarks');
        } else if (this._activeSidebar !== 'bookmarks') this._requestSidebar('bookmarks');
        this._bookmarksPanel.addAtPage(pageIndex);
      };
    }

    // The phone's undo pair lives in the verb bar, which exists only inside a mode, so a browse-time delete keeps the toast as its one way back.
    this.scribe._onDestructiveAction = (message, undo) => {
      if (this._phoneUi) {
        this._showToast(message, { actionLabel: 'Undo', onAction: undo });
        return;
      }
      this._pulseUndoButton();
    };

    // The history stacks have no change event, so the undo controls re-read them after every pointer release and key.
    const onHistorySettle = () => queueMicrotask(() => this._syncUndoState());
    window.addEventListener('pointerup', onHistorySettle);
    window.addEventListener('keyup', onHistorySettle);
    this._teardownCallbacks.push(() => {
      window.removeEventListener('pointerup', onHistorySettle);
      window.removeEventListener('keyup', onHistorySettle);
    });

    this.scribe._modeSelectionChanged = () => this._syncPhoneVerbBar();
    this.scribe._modeStatus = (text) => { if (this._dockModeParts) this._dockModeParts.status.textContent = text; };
    this.scribe._editTextEditorOpenChanged = (open) => this._onPhoneLineEditorOpen(open);

    // First viewer wins, so embedded pane viewers never steal the app-level error handler.
    if (!ScribePDFViewer._coreErrorsWired) {
      ScribePDFViewer._coreErrorsWired = true;
      let lastCoreToast = '';
      let lastCoreToastAt = 0;
      scribe.opt.errorHandler = (err) => {
        console.error(err);
        const message = typeof err === 'string' ? err : String((err && /** @type {any} */ (err).message) || 'Something went wrong in the document engine.');
        // A broken document can fail once per page, so identical messages collapse into one toast.
        if (message === lastCoreToast && Date.now() - lastCoreToastAt < 10000) return;
        lastCoreToast = message;
        lastCoreToastAt = Date.now();
        this._showToast(message);
      };
    }

    // The comment card's "show in comments panel" verb routes here.
    if (this._commentsPanel) {
      this.scribe._revealCommentInPanel = /** @param {import('../js/viewerWordObjects.js').UiOcrWord | AnnotationText} target */ (target) => {
        if (this._phoneUi) {
          this._openSheet();
          this._showSheetView('comments');
        } else if (this._activeSidebar !== 'comments') this._requestSidebar('comments');
        this._commentsPanel.reveal(target);
      };
      // A quiet rebuild after a comment/note is edited elsewhere (mini toolbar, note card), so an open panel reflects it at once.
      this.scribe._rebuildCommentsPanel = () => this._commentsPanel.rebuild();
    }

    container.appendChild(this.pdfViewerElem);

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

      // Dynamically imported so viewers with the surface off never fetch its code or styles.
      if (this._automateEnabled) {
        this._automateReady = import('../js/controls/automatePanel.js')
          .then(({ createAutomatePanel }) => {
            if (this._destroyed) return;
            this._automatePanel = createAutomatePanel(this, ROOT_CLASS, {
              onLayoutChange: () => this._relayout(),
              onResize: (w, phase) => this._resizeAutomate(w, phase),
              assistantTrace: DEBUG_MENU,
            });
            // The context menu reads the panel off the viewer, like the other editor-installed hooks.
            this.scribe._automatePanel = this._automatePanel;
            this.pdfViewerElem.appendChild(this._automatePanel.panelElem);
            if (this.toolbarElemStart) {
              const automateSep = makeSeparator();
              // Marker class so the library home's swapped bar hides the separator along with the opener.
              automateSep.classList.add('scribe-automate-sep');
              this.toolbarElemStart.appendChild(automateSep);
              this.toolbarElemStart.appendChild(this._automatePanel.toggleElem);
            }
            // The bar's centered cluster is measured against the start zone, which just grew.
            this._syncModeOverflow();
            this._teardownCallbacks.push(() => this._automatePanel?.destroy());
          })
          .catch((err) => console.error('Failed to load the Automate panel.', err));
      }

      // The exclusive tool modes live in a compact drop-down, composed by `_syncModeTrackValue`.
      // The active mode shows in the bar, or View while none is on, and the other modes list one per row beneath it.
      if (this.toolbarElemEnd && this._searchBar) {
        const wrap = document.createElement('span');
        wrap.className = 'scribe-mode-track-wrap';
        const track = document.createElement('span');
        track.className = 'scribe-mode-track-el';
        const row1 = document.createElement('span');
        row1.className = 'scribe-mode-track-row1';
        const more = document.createElement('div');
        more.className = 'scribe-mode-track-more';
        const chev = makeIconButton('More tools', TRACK_MENU_SVG);
        chev.classList.add('scribe-mode-track-chev');
        chev.addEventListener('click', () => this._setModeTrackOpen(!this._modeTrackOpen));
        row1.appendChild(chev);
        track.append(row1, more);
        wrap.appendChild(track);
        this._modeTrackWrap = wrap;
        this._modeTrackEl = track;
        this._modeTrackRow1 = row1;
        this._modeTrackMore = more;
        this._modeTrackChev = chev;
        const view = makeIconButton('View', TRACK_VIEW_SVG);
        view.classList.add('cr-labeled-button');
        const viewLabel = document.createElement('span');
        viewLabel.className = 'cr-btn-label';
        viewLabel.textContent = 'View';
        view.appendChild(viewLabel);
        // In the list, View is the exit pick.
        // In the bar it is the resting value, and the capture handler below owns its clicks.
        view.addEventListener('click', () => {
          if (!more.contains(view)) return;
          const active = (this._exclusiveToolBtns || []).find((b) => b.classList.contains('active'));
          if (active) active.click();
          else this._setModeTrackOpen(false);
        });
        this._modeTrackViewBtn = view;
        // A user click anywhere on the bar control (the value or the chevron) toggles the list instead of triggering the value button's own action.
        // Only trusted events are taken, so the app's own programmatic clicks (mode exits, exclusivity, Escape) still reach the buttons.
        const onValueClick = /** @param {MouseEvent} e */ (e) => {
          if (!e.isTrusted || chev.classList.contains('disabled') || !row1.contains(/** @type {Node} */ (e.target))) return;
          e.stopPropagation();
          e.preventDefault();
          this._setModeTrackOpen(!this._modeTrackOpen);
        };
        wrap.addEventListener('click', onValueClick, true);
        const onDocClick = /** @param {MouseEvent} e */ (e) => {
          if (!this._modeTrackOpen || wrap.contains(/** @type {Node} */ (e.target))) return;
          this._setModeTrackOpen(false);
        };
        document.addEventListener('click', onDocClick);
        this._teardownCallbacks.push(() => document.removeEventListener('click', onDocClick));
        // The capture phase consumes the press before the global mode-exit Escape, so closing the list never also exits the active mode.
        const onKey = (e) => {
          if (e.key !== 'Escape' || e.defaultPrevented || !this._modeTrackOpen) return;
          e.preventDefault();
          this._setModeTrackOpen(false);
        };
        document.addEventListener('keydown', onKey, true);
        this._teardownCallbacks.push(() => document.removeEventListener('keydown', onKey, true));
        // A phone-layout boot has already re-homed the search control into the dock, so only anchor on it while it is still in the end zone.
        const searchAnchor = this._searchBar.searchElem.parentElement === this.toolbarElemEnd ? this._searchBar.searchElem : null;
        this.toolbarElemEnd.insertBefore(wrap, searchAnchor);
        this.toolbarElemEnd.insertBefore(makeSeparator(), searchAnchor);
      }

      /** @type {?ReturnType<typeof createEditTextTool>} */
      this._editTextTool = null;
      if (editText) {
        this._editTextTool = createEditTextTool(this.scribe);
        if (this._modeTrackRow1) this._modeTrackRow1.insertBefore(this._editTextTool.toolbarElem, this._modeTrackChev);
        this._teardownCallbacks.push(this._editTextTool.installBehaviors());
      }

      /** @type {?ReturnType<typeof createGraphicsEditTool>} */
      this._graphicsEditTool = null;
      if (editText) {
        this._graphicsEditTool = createGraphicsEditTool(this.scribe);
        if (this._modeTrackRow1) this._modeTrackRow1.insertBefore(this._graphicsEditTool.toolbarElem, this._modeTrackChev);
        this._teardownCallbacks.push(this._graphicsEditTool.installBehaviors());
      }

      this._fillSignTool = createFillSignTool(this);
      if (this._modeTrackRow1) this._modeTrackRow1.insertBefore(this._fillSignTool.toolbarElem, this._modeTrackChev);
      this._teardownCallbacks.push(this._fillSignTool.installBehaviors());

      /** @type {?ReturnType<typeof createEditPagesTool>} */
      this._editPagesTool = null;
      if (this._modeTrackRow1 && this._thumbnailPanel) {
        this._editPagesTool = createEditPagesTool(this);
        this._modeTrackRow1.insertBefore(this._editPagesTool.toolbarElem, this._modeTrackChev);
      }

      /** @type {?ReturnType<typeof createRecognizeTextTool>} */
      this._recognizeTool = null;
      if (this._modeTrackRow1) {
        this._recognizeTool = createRecognizeTextTool();
        this._modeTrackRow1.insertBefore(this._recognizeTool.toolbarElem, this._modeTrackChev);
      }

      /** @type {?ReturnType<typeof createExtractTablesTool>} */
      this._extractTablesTool = null;
      // The mode's workspace lives in the Automate panel, so the button ships only when that panel does.
      if (this._modeTrackRow1 && this._automateEnabled) {
        this._extractTablesTool = createExtractTablesTool(this);
        this._modeTrackRow1.insertBefore(this._extractTablesTool.toolbarElem, this._modeTrackChev);
      }

      if (this._editTextTool) this._editTextTool.toolbarElem.dataset.modeHint = 'Click a line to select it · double-click to edit';
      if (this._graphicsEditTool) this._graphicsEditTool.toolbarElem.dataset.modeHint = 'Click or drag to select images and shapes · Delete or right-click removes them';
      this._fillSignTool.toolbarElem.dataset.modeHint = 'Place checks, crosses, and signatures';
      if (this._editPagesTool) this._editPagesTool.toolbarElem.dataset.modeHint = 'Drag pages to reorder · select pages to delete';
      if (this._recognizeTool) this._recognizeTool.toolbarElem.dataset.modeHint = 'Makes scanned pages selectable and searchable';
      if (this._extractTablesTool) this._extractTablesTool.toolbarElem.dataset.modeHint = 'Drag column lines to fix a table · click a page-break tab to link or unlink · right-click for table actions';

      const exclusiveToolBtns = [this._redactTool?.toolbarElem, this._editTextTool?.toolbarElem, this._graphicsEditTool?.toolbarElem,
        this._fillSignTool.toolbarElem, this._editPagesTool?.toolbarElem, this._recognizeTool?.toolbarElem,
        this._extractTablesTool?.toolbarElem].filter((b) => !!b);
      this._exclusiveToolBtns = exclusiveToolBtns;
      for (const btn of exclusiveToolBtns) {
        btn.addEventListener('click', () => {
          if (btn.classList.contains('active')) {
            for (const other of exclusiveToolBtns) {
              if (other !== btn && other.classList.contains('active')) other.click();
            }
          }
          this._syncModeBanner();
        });
      }

      // Escape exits the active tool mode, once every closer surface (find bar, editors, menus, selections) has passed on the press.
      // Each of those consumers marks a used Escape with preventDefault, so an unconsumed press is the mode's to take.
      const onModeEscape = (e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        const t = e.target;
        if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
        const activeBtn = exclusiveToolBtns.find((b) => b.classList.contains('active') && b.isConnected);
        if (activeBtn) {
          e.preventDefault();
          activeBtn.click();
        }
      };
      document.addEventListener('keydown', onModeEscape);
      this._teardownCallbacks.push(() => document.removeEventListener('keydown', onModeEscape));

      this.scribe.onSignatureFieldClick = (n, row) => signIntoField(this, n, row);
      // The boot-time sync ran before these tools existed, so apply the empty-viewer gating to them now.
      this._syncDocGatedControls();
      this._syncModeOverflow();
      // A phone boot builds the dock before these tools exist, so the mode controls join it here.
      if (this._phoneUi && this._dockElem) {
        this._buildPhoneModeUi();
        if (this._dockEditBtn) this._dockElem.insertBefore(this._dockEditBtn, this._sheetPanelsBtn || null);
        this._syncDocGatedControls();
      }
    }

    // The library is Chromium-only (File System Access API) and dynamically imported so disabled or unsupported viewers never fetch its code or styles.
    if (library && typeof window !== 'undefined' && 'showDirectoryPicker' in window) {
      import('../library/libraryView.js')
        .then(({ installLibrary }) => {
          if (!this._destroyed) this._library = installLibrary(this);
        })
        .catch((err) => console.error('Failed to load the document library.', err));
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
   * The viewer creates and **owns** the resulting document, so it is terminated automatically on the next import, on `detachDoc`, or on `destroy`.
   * Raw byte inputs (`ArrayBuffer`, `Uint8Array`, non-File `Blob`) are treated as PDFs.
   * @param {File | Blob | ArrayBuffer | Uint8Array | string} file - A filesystem path string is Node only.
   * @param {number} [initialPage=0]
   * @param {object} [options]
   * @param {boolean} [options.terminatePrevious] - Force-terminate (`true`) or force-retain (`false`) the outgoing document, overriding the default (terminate only a document the viewer created).
   * @returns {Promise<?import('../../js/containers/scribeDoc.js').ScribeDoc>} The displaced document, or `null` if there was none.
   */
  async importFile(file, initialPage = 0, { terminatePrevious } = {}) {
    // The trailing `await doc.textReady` keeps a resolved promise meaning fully loaded, since `deferText` lets the UI paint before extraction finishes.
    const doc = await openDocumentFromFile(file, { deferText: true });
    const displaced = await this._setDoc(doc, initialPage, true, terminatePrevious);
    await doc.textReady;
    return displaced;
  }

  /**
   * Open a document provisionally, painting it from pre-rendered assets before the real document exists.
   * The real document later replaces the seed in place, at the same scroll and zoom.
   * Pages outside the seed's window show placeholders until hydration, and scrolling to one forces the load immediately.
   * Resolves at first paint.
   * The returned `primed` settles once the window pages' word geometry has landed, so text is selectable and searchable.
   * `hydrated` settles when the real document has replaced the seed or the load failed, and `cancel` abandons hydration.
   * @param {import('../js/seedDoc.js').ProvisionalSeed} seed
   * @returns {Promise<{primed: Promise<void>, hydrated: Promise<void>, cancel: () => void}>}
   */
  async openProvisional(seed) {
    const seedDoc = new SeedDoc(seed);
    // Fonts back the word-object layer (search marks, carets).
    // The call is memoized process-wide, so it is not awaited here.
    scribe.init({ font: true }).catch(() => {});

    let started = false;
    let cancelled = false;
    /** @type {(doc: any) => void} */
    let resolveReal = () => {};
    /** @type {(err: any) => void} */
    let rejectReal = () => {};
    /** @type {Promise<any>} */
    const realDocP = new Promise((res, rej) => { resolveReal = res; rejectReal = rej; });
    // The public handle reports completion without exposing the document.
    // A cancelled hydration rejects, which is settled state rather than an error worth crashing on.
    realDocP.catch(() => {});
    const hydrated = realDocP.then(() => undefined);
    hydrated.catch(() => {});

    const initialPage = seed.initialPage ?? 0;
    const tab = await this._openDocAsTab(seedDoc, seed.name || 'Document', { provisional: true, lastPage: initialPage });
    // Word geometry lands moments after the raster, so the text layer has to be rebuilt when it does.
    const primed = seedDoc.prime().then(() => {
      if (!cancelled && this.doc === seedDoc) this.scribe.displayPage(this.scribe.state.cp.n, false, true);
    });

    const start = () => {
      if (started) return realDocP;
      started = true;
      (async () => {
        const loaded = await seed.load();
        const realDoc = Array.isArray(loaded) ? await scribe.openDocument(loaded, { deferText: true }) : loaded;
        if (cancelled) {
          realDoc?.close?.().catch(() => {});
          throw new Error('Hydration cancelled.');
        }
        await this._hydrateSwap(tab, seedDoc, realDoc);
        return realDoc;
      })().then(resolveReal, (err) => {
        if (!cancelled) this._showToast(`Couldn't load “${seed.name || 'this document'}” — the preview stays available.`);
        rejectReal(err);
      });
      return realDocP;
    };
    seedDoc._requestHydration = start;

    // Only user-visible navigation accelerates hydration, so the viewer's own render-ahead reaching outside the window resolves to placeholders instead.
    const sc = this.scribe.scrollContainer;
    const onScroll = () => {
      const n = this.scribe.state.cp.n;
      // Through `_requestHydration` rather than `start` directly, so a host that wrapped the hook sees every trigger.
      if (this.doc === seedDoc && (n < seed.window.from || n > seed.window.to)) seedDoc._requestHydration?.();
    };
    sc.addEventListener('scroll', onScroll);
    realDocP.catch(() => {}).finally(() => sc.removeEventListener('scroll', onScroll));

    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      sc.removeEventListener('scroll', onScroll);
      rejectReal(new Error('Hydration cancelled.'));
    };
    // A seed closed by a tab close or a viewer destroy must never go on to hydrate.
    seedDoc._onClose = cancel;

    if ((seed.hydration || 'eager') === 'eager') setTimeout(() => seedDoc._requestHydration?.(), 0);
    return { primed, hydrated, cancel };
  }

  /**
   * Replace a provisional tab's seed with the hydrated document in place.
   * When the seed's geometry was truthful, the swap preserves scroll and zoom exactly and re-anchors a linear text selection whose text survived unchanged.
   * A snapshot of the on-screen canvases veils the viewport until the real render lands.
   * A geometry mismatch degrades to a plain re-open at the current page.
   * @param {object} tab
   * @param {SeedDoc} seedDoc
   * @param {import('../../js/containers/scribeDoc.js').ScribeDoc} realDoc
   */
  async _hydrateSwap(tab, seedDoc, realDoc) {
    tab.doc = realDoc;
    tab.provisional = false;
    // Fired synchronously with the adoption rather than on `hydrated`.
    // A mutation arriving during the swap's paint tail must not escape the host's tracking.
    tab.onDocHydrated?.(realDoc);
    // A successful swap retires the seed on purpose, so its close must not read as a cancel.
    seedDoc._onClose = null;
    // Annotations made on the seed move to the real document, because the pointer UI writes doc.annotations directly.
    // A page whose baseline came from the seed's annots callback replaces the real page wholesale, so removals count.
    // Every other page appends its session additions.
    for (let n = 0; n < seedDoc.annotations.pages.length; n++) {
      const seedPage = seedDoc.annotations.pages[n];
      if (seedDoc._annotBaseline.has(n)) realDoc.annotations.pages[n] = seedPage;
      else if (seedPage.length) realDoc.annotations.pages[n] = (realDoc.annotations.pages[n] || []).concat(seedPage);
    }
    if (this.doc !== seedDoc) {
      // A background tab swaps silently, and activation attaches the real document normally.
      await seedDoc.close();
      return;
    }
    const sc = this.scribe.scrollContainer;
    const zoom = this.scribe.zoomLevel;
    const { scrollTop, scrollLeft } = sc;
    const cpN = this.scribe.state.cp.n;
    const geometryMatches = realDoc.inputData.pageCount === seedDoc.inputData.pageCount
      && Math.abs(realDoc.pageMetrics[0].dims.width - seedDoc.pageMetrics[0].dims.width) < 1
      && Math.abs(realDoc.pageMetrics[0].dims.height - seedDoc.pageMetrics[0].dims.height) < 1;

    const textSel = this.scribe.textSel;
    const sel = geometryMatches && textSel && textSel.range?.kind === 'linear'
      ? { start: { ...textSel.range.start }, end: { ...textSel.range.end }, text: textSel.getText() }
      : null;
    const veil = geometryMatches ? this._buildSwapVeil() : null;

    try {
      await this.attachDocument(realDoc, cpN, { terminatePrevious: false });
      if (geometryMatches) {
        if (this.scribe.zoomLevel !== zoom) {
          this.scribe.zoomLevel = zoom;
          this.scribe._applyZoomTransform(zoom);
          this.scribe.calcPageLayout();
        }
        sc.scrollTop = scrollTop;
        sc.scrollLeft = scrollLeft;
        await this.scribe.displayPage(cpN, false, true);
        if (sel && this.scribe.textSel) {
          const ts = this.scribe.textSel;
          ts.range = { kind: 'linear', start: sel.start, end: sel.end };
          ts._renderAll();
          if (ts.getText() !== sel.text) ts.clear();
        }
      }
      await seedDoc.close();
      if (veil) {
        const pc = this.scribe.imageCache.pageCanvases[cpN];
        if (pc) await Promise.race([pc, new Promise((r) => { setTimeout(r, 2000); })]);
        await new Promise((r) => { requestAnimationFrame(() => r(null)); });
      }
    } finally {
      veil?.remove();
    }
  }

  /**
   * A snapshot of the visible page canvases, absolutely positioned over the viewport.
   * The hydration swap's clear-and-re-render then happens behind an image of exactly what was showing.
   * @returns {?HTMLCanvasElement}
   */
  _buildSwapVeil() {
    const sc = this.scribe.scrollContainer;
    const scRect = sc.getBoundingClientRect();
    if (!scRect.width || !scRect.height) return null;
    const rootRect = this.pdfViewerElem.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(scRect.width * dpr);
    canvas.height = Math.round(scRect.height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = getComputedStyle(sc).backgroundColor || '#fff';
    ctx.fillRect(0, 0, scRect.width, scRect.height);
    for (const el of sc.querySelectorAll('canvas')) {
      const r = el.getBoundingClientRect();
      if (r.bottom < scRect.top || r.top > scRect.bottom || !r.width || !r.height) continue;
      try {
        ctx.drawImage(el, r.left - scRect.left, r.top - scRect.top, r.width, r.height);
      } catch { /* An undrawable (zero-sized) canvas contributes nothing. */ }
    }
    canvas.className = 'scribe-swap-veil';
    canvas.style.cssText = `position:absolute;left:${scRect.left - rootRect.left}px;top:${scRect.top - rootRect.top}px;`
      + `width:${scRect.width}px;height:${scRect.height}px;z-index:20;pointer-events:none;`;
    this.pdfViewerElem.appendChild(canvas);
    return canvas;
  }

  /**
   * Wire `doc` into the viewer and display `initialPage`, deciding the outgoing document's fate.
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
    this._libraryHooks?.docOpened?.();

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
      this._companionStrip.setVisible(this._phoneUi);
      this._companionStrip.setTucked(this._stripTucked, false);
      // Showing the strip changes the document's bottom inset.
      if (this._phoneUi && this.scribe.scrollContainer) this._relayout();
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
    this._syncDocGatedControls();
    // Deferred text extraction can add the first visible native words after load.
    const loadedDoc = this.doc;
    loadedDoc?.textReady?.then(() => { if (this.doc === loadedDoc) this._syncDocGatedControls(); }).catch(() => {});

    // A load is not a user toggle, so the reopened rail lands instantly rather than sliding in.
    if (!prev && !this._phoneUi && this._sidebarWhenLoaded) {
      const wanted = this._panelFor(this._sidebarWhenLoaded);
      const key = wanted && wanted.toggleElem.style.display !== 'none' ? this._sidebarWhenLoaded : 'thumbnails';
      const panel = this._panelFor(key);
      if (panel) {
        this._activeSidebar = key;
        const el = panel.panelElem;
        el.style.transition = 'none';
        panel.setVisible(true);
        requestAnimationFrame(() => { el.style.transition = ''; });
        // setVisible re-insets the document only for the thumbnail view, so the other views need this relayout.
        if (this.scribe.scrollContainer) this._relayout();
      }
    }
    // Loads can change the sidebar's open view and which views a document offers, so the sidebar toggle and strip resync here.
    this._syncSidebarControls();

    // Off the critical path: the displaced document's workers die asynchronously while the new page renders.
    // Safe because each document's workers and fonts are namespaced by a unique docId.
    if (terminatePrev && displaced) displaced.close().catch(() => {});

    this.scribe.runSetInitial = true;
    await this.scribe.displayPage(initialPage, initialPage > 0);

    this._extractTablesTool?.docChanged?.();

    // Deferred import painted the page raster-only, so rebuild the text-dependent surfaces once extraction lands.
    // Text that imported synchronously has no deferred phase and skips this.
    if (doc._textReadySettle) {
      doc.textReady.then(() => {
        if (this.doc !== doc) return;
        this.scribe.displayPage(this.scribe.state.cp.n, false, true);
        // Deferred extraction is what detects layout tables, so the Extract Tables surfaces re-derive now.
        this._extractTablesTool?.docChanged?.();
        // The Recognize verdict depends on the page stats a deferred import produces, so re-evaluate once they land.
        if (this._editEnabled) this._updateRecognizeButton();
        if (this._commentsPanel && this._thumbnailPanel) {
          this._commentsPanel.rebuild();
          const hasCommentsNow = ((doc.annotations && doc.annotations.pages) || []).some((p) => (p || []).some((a) => a.comment || a.type === 'text'));
          // Extraction can only reveal comments, never remove them, so no sidebar fallback is needed here.
          this._commentsPanel.toggleElem.style.display = (hasCommentsNow || this.scribe.opt.enablePageEditing) ? '' : 'none';
          this._syncDockPanelsBtn();
          this._syncSidebarControls();
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

    if (this.pageCountElem) this.pageCountElem.textContent = '';
    if (this.pageNumElem) this.pageNumElem.value = '';
    this._syncDockPageNumWidth();
    if (this.dropZone) this.dropZone.style.display = '';
    if (this._thumbnailPanel) this._thumbnailPanel.rebuild();
    if (this._bookmarksPanel) this._bookmarksPanel.rebuild();
    if (this._commentsPanel) this._commentsPanel.rebuild();
    if (this._companionStrip) {
      this._companionStrip.rebuild();
      this._companionStrip.setVisible(false);
      // Hiding the strip changes the document's bottom inset.
      if (this._phoneUi && this.scribe.scrollContainer) this._relayout();
    }
    if (!this._phoneUi) {
      this._sidebarWhenLoaded = this._activeSidebar;
      const open = this._panelFor(this._activeSidebar);
      this._activeSidebar = null;
      if (open) {
        const el = open.panelElem;
        el.style.transition = 'none';
        open.setVisible(false);
        requestAnimationFrame(() => { el.style.transition = ''; });
      }
      if (this.scribe.scrollContainer) this._relayout();
    }
    this._syncSidebarControls();
    this._syncDocGatedControls();

    if (terminatePrev) prev.close().catch(() => {});

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
      if (!this._roomForAnotherDoc(pdf.size || 0, opened)) {
        const openN = this._tabs.length + opened.length;
        this._showToast(`Couldn’t open “${pdf.name || 'this file'}” — ${openN} ${openN === 1 ? 'document is' : 'documents are'} already open on this device.`);
        continue;
      }
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
        if (doc) await doc.close().catch(() => {});
        this._showToast(`Couldn't open “${pdf.name}” — the file couldn't be loaded.`);
      }
    }
    // Images/OCR/.scribe are opened together into one document, the way the core import combines them.
    if (others.length > 0 && !this._roomForAnotherDoc(others.reduce((a, f) => a + (f.size || 0), 0), opened)) {
      const openN = this._tabs.length + opened.length;
      const label = others.length === 1 ? `“${others[0].name}”` : 'the selected files';
      this._showToast(`Couldn’t open ${label} — ${openN} ${openN === 1 ? 'document is' : 'documents are'} already open on this device.`);
    } else if (others.length > 0) {
      let doc = null;
      try {
        doc = await scribe.openDocument(others);
        if (!doc || doc.inputData.pageCount === 0) throw new Error('no pages');
        const name = others.length === 1 ? others[0].name : `${others[0].name} +${others.length - 1}`;
        opened.push({ doc, name });
      } catch (err) {
        console.error('Failed to open files:', err);
        if (doc) await doc.close().catch(() => {});
        const single = others.length === 1;
        const label = single ? `“${others[0].name}”` : 'the selected files';
        this._showToast(`Couldn't open ${label} — ${single ? 'the file' : 'they'} couldn't be loaded.`);
      }
    }
    if (opened.length === 0) return;

    for (const t of opened) this._tabs.push(this._newTab(t.doc, t.name));
    await this._activateTab(this._tabs.length - 1);
    // The active tab already painted. This await keeps the "openFiles resolved means all documents fully loaded" contract for callers.
    await Promise.all(opened.map((t) => t.doc.textReady));
    // Bulk-opened documents were skipped by the demotion policy while their text extraction was in flight; now it can run.
    this._applyTabResourcePolicy();
  }

  /**
   * A fresh tab record for `doc`, stamped as most recently used.
   * @param {import('../../js/containers/scribeDoc.js').ScribeDoc} doc
   * @param {string} name
   */
  _newTab(doc, name) {
    return {
      doc, name, lastPage: 0, lastUse: ++this._tabUseCounter, asleep: false, waking: false,
    };
  }

  /**
   * Attach an externally opened document as a new tab and activate it.
   * The viewer takes ownership and closes the document when the tab closes.
   * @param {import('../../js/containers/scribeDoc.js').ScribeDoc} doc
   * @param {string} name
   * @param {Object} [extra] - Additional fields carried on the tab (e.g. the library's `libraryHash`).
   * @returns {Promise<Object>} The created tab.
   */
  async _openDocAsTab(doc, name, extra = {}) {
    const tab = { ...this._newTab(doc, name), ...extra };
    this._tabs.push(tab);
    await this._activateTab(this._tabs.length - 1);
    return tab;
  }

  /**
   * Whether another document fits under the device memory budget.
   * @param {number} fileSize - Size of the file about to be opened, in bytes.
   * @param {Array<{ doc: import('../../js/containers/scribeDoc.js').ScribeDoc }>} pending - Documents opened this batch but not yet in `_tabs`.
   */
  _roomForAnotherDoc(fileSize, pending) {
    if (!Number.isFinite(this._docBudgetBytes)) return true;
    let est = 0;
    for (const { doc } of [...this._tabs, ...pending]) {
      est += (doc.images.pdfData?.byteLength || 0) + doc.pageMetrics.length * 300_000 + 8_000_000;
    }
    return est + fileSize * 2 + 16_000_000 <= this._docBudgetBytes;
  }

  /**
   * Suspend the worker pools of documents outside the warm set of most recently used tabs, marking those tabs asleep.
   * A sleeping document keeps its main-thread state (text, edits, undo, thumbnails).
   * Activating its tab respawns the pools.
   */
  _applyTabResourcePolicy() {
    const warmN = this._phoneUi ? 1 : 3;
    const warm = new Set([...this._tabs].sort((a, b) => b.lastUse - a.lastUse).slice(0, warmN));
    // Cross-document page copies share image sources, so a cold tab's source can still feed a warm document's renders.
    const warmSources = new Set();
    for (const tab of warm) for (const src of tab.doc.images.sources.values()) warmSources.add(src);
    let changed = false;
    for (const tab of this._tabs) {
      // Pool teardown would kill an in-flight text extraction, so still-extracting documents stay warm.
      if (warm.has(tab) || tab.waking || tab.doc._textReadySettle) continue;
      let suspendedAny = false;
      for (const src of tab.doc.images.sources.values()) {
        // A source with staged or running jobs drains first, because suspending it drops those renders.
        // The policy re-runs on the next tab switch, so a drained source is suspended then.
        if (!warmSources.has(src) && src.scheduler && !src.scheduler.busy) {
          src.suspend().catch(() => {});
          suspendedAny = true;
        }
      }
      if (suspendedAny && !tab.asleep) {
        tab.asleep = true;
        changed = true;
      }
    }
    if (changed) this._renderTabs();
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
      const name = `${baseName.replace(/\.pdf$/i, '')} (extract).pdf`;
      this._tabs.push(this._newTab(doc, name));
      await this._activateTab(this._tabs.length - 1);
    } catch (err) {
      console.error('Failed to create a document from the selected pages:', err);
    }
  }

  /**
   * Open a new document (tab) that concatenates every open document's pages, in tab order, with their current edits.
   * The source tabs stay open and unchanged.
   * Each source becomes a top-level bookmark named after its tab, with that source's own bookmarks nested beneath.
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
      this._tabs.push(this._newTab(combinedDoc, 'Combined.pdf'));
      await this._activateTab(this._tabs.length - 1);
    } catch (err) {
      console.error('Failed to combine open documents:', err);
    }
  }

  /**
   * Split the active document at its top-level bookmarks, opening each segment as a new tab named after its bookmark.
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
      await Promise.all(pieces.map((p) => p.doc.close().catch(() => {})));
      return;
    }
    const firstNewTab = this._tabs.length;
    for (const p of pieces) this._tabs.push(this._newTab(p.doc, p.name));
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
      if (at > at0 && this._thumbnailPanel) this._thumbnailPanel.insertPagesAt(at0, at - at0, landingCp);
    } catch (err) {
      console.error('Failed to insert pages from file:', err);
      this._showToast('Couldn’t insert the file — it couldn’t be loaded.');
    } finally {
      // Safe because the inserted pages render and export from each throwaway's refcounted source, which outlives this close.
      await Promise.all(temps.map((d) => d.close().catch(() => {})));
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
      // The outgoing tab's sidecar saves in the background, and its document stays alive across the switch.
      this._libraryHooks?.saveTabIfDirty?.(this._tabs[this._activeTab]).catch(() => {});
    }
    const tab = this._tabs[i];
    this._activeTab = i;
    tab.lastUse = ++this._tabUseCounter;
    if (tab.asleep) tab.waking = true;
    this._renderTabs();
    // Respawn the suspended pool before attaching, so the tab chip's spinner covers the slow part and the attach renders against a warm pool.
    // Bounded by a timeout so the spinner always ends.
    // On timeout or failure the attach proceeds and renders retry lazily.
    if (tab.waking && tab.doc.images.pdfData) {
      const respawn = tab.doc.images.getPdfScheduler().catch(() => {
        this._showToast(`Couldn't restart the page renderer for “${tab.name}” — pages will retry as they come into view.`);
      });
      await Promise.race([respawn, new Promise((resolve) => { setTimeout(resolve, 10000); })]);
    }
    await this.attachDocument(tab.doc, tab.lastPage, { terminatePrevious: false });
    if (tab.waking) {
      tab.waking = false;
      tab.asleep = false;
      this._renderTabs();
    }
    this._applyTabResourcePolicy();
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
    // A library tab with unsaved edits writes its sidecar first, and closes only once that settles.
    Promise.resolve(this._libraryHooks?.saveTabIfDirty?.(removed)).catch(() => {})
      .then(() => removed.doc.close().catch(() => {}));

    if (this._tabs.length === 0) {
      this._activeTab = -1;
      this._renderTabs();
      this.detachDoc({ terminate: false });
      this._libraryHooks?.emptied?.();
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

  /** Re-render the tab strip and toggle its visibility. */
  _renderTabs() {
    this._setTabStripVisible(this._tabs.length >= this._tabStripMinTabs);
    if (this._tabStrip) this._tabStrip.render(this._tabs, this._activeTab);
    // Combine needs 2+ tabs and Split tracks the active document, so refresh both when the strip changes.
    if (this._editEnabled) {
      this._updateCombineButton();
      this._updateSplitButton();
    }
    // Every tab mutation passes through here, so this is where the embedding page learns which document is active.
    const activeName = (this._activeTab >= 0 && this._tabs[this._activeTab]?.name) || null;
    if (activeName !== this._announcedDocName) {
      this._announcedDocName = activeName;
      this.container.dispatchEvent(new CustomEvent('scribe-active-doc-change', { detail: { name: activeName }, bubbles: true }));
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
   * Fit the bar to its width, preserving the centered viewing cluster's separation from the edge clusters.
   * The rotate pair sheds when the air runs out.
   */
  _syncModeOverflow() {
    // The phone layout hides the bar, so nothing overflows.
    if (this._phoneUi || !this.toolbarElem) return;
    // The air a truly centered viewing cluster would keep from the nearer edge cluster.
    // The edge zones stretch to fill the bar, so their contents are measured rather than their boxes.
    const air = () => {
      const bar = this.toolbarElem.clientWidth;
      const center = this._toolbarButtonsElem ? this._toolbarButtonsElem.offsetWidth : 0;
      const sLast = this.toolbarElemStart.lastElementChild;
      const startW = sLast ? sLast.getBoundingClientRect().right - this.toolbarElemStart.getBoundingClientRect().left : 0;
      const eFirst = this.toolbarElemEnd.firstElementChild;
      const endW = eFirst ? this.toolbarElemEnd.getBoundingClientRect().right - eFirst.getBoundingClientRect().left : 0;
      return (bar - center) / 2 - Math.max(startW, endW);
    };
    if (this._rotateControls) {
      this._rotateControls.style.display = '';
      if (this._sepBeforeRotate) this._sepBeforeRotate.style.display = '';
      if (air() < ROTATE_MIN_AIR) {
        this._rotateControls.style.display = 'none';
        if (this._sepBeforeRotate) this._sepBeforeRotate.style.display = 'none';
      }
    }
    // The mode drop-down keeps one fixed width at every bar width, so the overflow fit leaves it alone.
    // The exception: a control composed while the library view hid the bar measured zero and is unpinned, so the first sync that sees it laid out re-measures it.
    if (this._modeTrackWrap && this._modeTrackEl && !this._modeTrackEl.style.width && this._modeTrackWrap.offsetWidth) {
      this._syncModeTrackValue();
    }
  }

  /**
   * Height of the fixed top bars (the toolbar and the tab strip when visible), in px.
   * Both banners are excluded: they float over the document area rather than reserving height.
   * @returns {number}
   */
  _topBarsHeight() {
    return (this._phoneUi ? 0 : this.toolbarHeight)
      + (this._tabStripVisible ? TAB_STRIP_HEIGHT : 0);
  }

  /** Stack the overlay banners across the top of the document area, the mode banner above the message banner. */
  _positionBanners() {
    const top = this._topBarsHeight();
    if (this._modeBanner) this._modeBanner.style.top = `${top}px`;
    // The automate panel shares the banner's band, so the banner gives up that width rather than overdrawing it.
    if (this._modeBanner) {
      this._modeBanner.style.right = (!this._phoneUi && this._automatePanel?.isOpen()) ? `${this._automatePanel.width}px` : '0px';
    }
    const modeH = (this._modeBanner && this._modeBanner.style.display !== 'none') ? MODE_BANNER_HEIGHT : 0;
    if (this._banner) this._banner.style.top = `${top + modeH}px`;
    const messageH = (this._banner && this._banner.style.display !== 'none') ? MESSAGE_BANNER_HEIGHT : 0;
    // The banners span the sidebar too, so the rail reserves leading scroll space for them to keep its first row's controls reachable.
    // The view-switch strip's band already holds the rows that much lower, so only the overlap past it needs reserving.
    const stripH = (this._sidebarTabsElem && !this._phoneUi) ? SIDEBAR_TABS_HEIGHT : 0;
    // Edit Pages needs the reserve on desktop, since its selection checkboxes overhang the first row's top edge.
    const railModeH = (this._phoneUi || messageH > 0 || (this._editPagesTool && this._editPagesTool.isActive()))
      ? modeH : 0;
    if (this._thumbnailPanel) this._thumbnailPanel.setTopInset(Math.max(0, railModeH + messageH - stripH));
  }

  /**
   * Height of the fixed bottom bars (the phone dock plus the visible companion strip), in px, 0 outside the phone layout.
   * @returns {number}
   */
  _bottomBarsHeight() {
    if (!this._phoneUi || !this._dockElem) return 0;
    // Before the component is attached the dock has no layout yet; 56 is its safe-area-free height.
    const dock = this._dockElem.offsetHeight || 56;
    const vbar = this._vbarElem && this._vbarElem.classList.contains('on') && !this._phoneLineEditing
      ? this._vbarElem.offsetHeight : 0;
    // The companion strip sits above the dock while visible, so the document insets above it too.
    // It stands down entirely during a line edit, where the keyboard owns the bottom of the screen.
    // The verb bar takes over the palette's slot while a Fill & Sign item is picked, so only one of the two counts.
    const fsPal = this._fsBarOn && this._fillSignTool && !vbar ? this._fillSignTool.paletteElem() : null;
    const fsBar = fsPal ? fsPal.offsetHeight || 52 : 0;
    const cs = this._companionStrip;
    const strip = cs && cs.stripElem.classList.contains('on') && !cs.isTucked() && !this._stripDragLayout
      && !this._phoneLineEditing
      ? cs.stripElem.offsetHeight : 0;
    return dock + vbar + fsBar + strip;
  }

  /**
   * Bottom inset for the document area, in px: the fixed bottom bars, grown to the open sheet's top edge in the phone layout.
   * @returns {number}
   */
  _docBottomInset() {
    // While a line edit is open the editing bar rides the keyboard's top edge, and the document keeps clear of both.
    if (this._phoneUi && this._phoneLineEditing && this._dockElem) {
      const barH = this._vbarElem ? this._vbarElem.offsetHeight || 52 : 52;
      return Math.max(this._bottomBarsHeight(), (this._kbInset || 0) + barH);
    }
    if (this._phoneUi && this._sheetOpen && this._sheetElem && this._dockElem) {
      if (this._sheetDragLayout) return this._bottomBarsHeight();
      const dockH = this._dockElem.offsetHeight || 56;
      // Capped at half the viewport so a full-height sheet tucks the page behind it rather than squeezing it to nothing.
      const sheetH = Math.min(this._sheetElem.getBoundingClientRect().height, Math.round(this._height * 0.5));
      return dockH + sheetH;
    }
    return this._bottomBarsHeight();
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
   * Show a persistent, dismissible banner over the top of the document area.
   * Use when the user may be away from the screen or the failure is not self-evident (e.g. recognition failed while they stepped away): it waits to be acknowledged rather than auto-dismissing.
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
    this._positionBanners();
  }

  /** Hide the message banner and give back the space the banner stack reserved for it. */
  _hideBanner() {
    if (!this._banner) return;
    this._banner.style.display = 'none';
    this._positionBanners();
  }

  /**
   * Reflect the active tool mode in the banner floating over the top of the document area: its name, hint, and Done.
   * The banner is hidden while no mode is on.
   */
  _syncModeBanner() {
    // A tool with no hint (the unmounted Redact button) gets no banner, so the hint doubles as the banner-eligibility test.
    const activeBtn = (this._exclusiveToolBtns || []).find((b) => b.classList.contains('active') && b.dataset.modeHint) || null;
    if (this._automatePanel) this._automatePanel.syncMode(activeBtn ? activeBtn.title : null);
    // The root class lets the stylesheet lift the companion strip above the Fill & Sign bar.
    // That bar changes the bottom inset, so the document lays out again when it comes or goes.
    const fsBarOn = this._phoneUi && !!this._fillSignTool && activeBtn === this._fillSignTool.toolbarElem;
    this.pdfViewerElem.classList.toggle('scribe-fsbar-on', fsBarOn);
    if (fsBarOn !== !!this._fsBarOn) {
      this._fsBarOn = fsBarOn;
      if (this.scribe.scrollContainer) this._relayout();
    }
    if (this._dockEditBtn) this._dockEditBtn.classList.toggle('active', !!activeBtn);
    if (!activeBtn) {
      if (this._modeBanner) this._modeBanner.style.display = 'none';
      if (this._dockElem) this._dockElem.classList.remove('scribe-mode-on');
      if (this._recognizeExtras) this._recognizeExtras.remove();
      // The palette returns to its floating home so the closed bar holds nothing.
      const idlePal = this._fillSignTool?.paletteElem();
      if (idlePal && idlePal.parentElement !== this.pdfViewerElem) this.pdfViewerElem.appendChild(idlePal);
      this._modeBannerBtn = null;
      this._syncModeExitButtons(null);
      if (this._modeTrackWrap) this._syncModeTrackValue();
      this._syncPhoneVerbBar();
      this._positionBanners();
      return;
    }
    // On the phone the dock is the mode's bar, so the top banner stays hidden.
    // A banner would put Done in the top-right corner, out of one-handed reach.
    if (this._phoneUi && this._dockModeRow) {
      if (this._modeBanner) this._modeBanner.style.display = 'none';
      // Crossing from the desktop layout can leave the palette mounted in the now-hidden mode banner.
      const phonePal = this._fillSignTool?.paletteElem();
      if (phonePal && phonePal.parentElement !== this.pdfViewerElem) this.pdfViewerElem.appendChild(phonePal);
      this._modeBannerBtn = activeBtn;
      this._dockElem.classList.add('scribe-mode-on');
      this._dockModeParts.ic.innerHTML = activeBtn.querySelector('.cr-icon')?.innerHTML || '';
      this._dockModeParts.nm.textContent = activeBtn.title;
      // Undo a previous sync's receipt state before the mode-specific branches restate it.
      this._dockModeParts.nm.style.display = '';
      if (this._dockModeParts.status.classList.contains('scribe-recog-done')) {
        this._dockModeParts.status.textContent = '';
        this._dockModeParts.status.classList.remove('scribe-recog-done');
      }
      const recogMode = !!this._recognizeTool && activeBtn === this._recognizeTool.toolbarElem;
      this._dockModeRow.classList.toggle('scribe-mode-recognize', recogMode);
      if (recogMode) {
        if (this._recognizeAlreadyRan()) {
          this._recognizeExtras?.remove();
          this._dockModeParts.nm.style.display = 'none';
          this._dockModeParts.status.textContent = '✓ Recognized — text is selectable';
          this._dockModeParts.status.classList.add('scribe-recog-done');
        } else {
          this._ensureRecognizeExtras();
          const pages = this._deepOcrPageCount();
          this._recognizeRunBtn.disabled = pages === 0;
          if (this._recognizeExtras.parentElement !== this._dockModeRow) {
            this._dockModeRow.insertBefore(this._recognizeExtras, this._dockModeParts.status);
          }
        }
      } else if (this._recognizeExtras) {
        this._recognizeExtras.remove();
      }
      this._syncModeExitButtons(activeBtn);
      if (this._modeTrackWrap) this._syncModeTrackValue();
      this._syncPhoneVerbBar();
      this._positionBanners();
      return;
    }
    if (this._dockElem) this._dockElem.classList.remove('scribe-mode-on');
    if (!this._modeBanner) {
      const banner = document.createElement('div');
      banner.className = 'scribe-mode-banner';
      const ic = document.createElement('span');
      ic.className = 'scribe-mode-banner-ic';
      const name = document.createElement('span');
      name.className = 'scribe-mode-banner-name';
      const dot = document.createElement('span');
      dot.className = 'scribe-mode-banner-dot';
      dot.textContent = '·';
      const hint = document.createElement('span');
      hint.className = 'scribe-mode-banner-hint';
      const done = document.createElement('button');
      done.type = 'button';
      done.className = 'scribe-mode-banner-done';
      done.append('Done', Object.assign(document.createElement('kbd'), { textContent: 'Esc' }));
      done.addEventListener('click', () => { if (this._modeBannerBtn) this._modeBannerBtn.click(); });
      // Esc still exits keeping edits, so its chip rides Save rather than the more conventional Discard.
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'scribe-mode-banner-done scribe-mode-banner-save';
      save.append('Save', Object.assign(document.createElement('kbd'), { textContent: 'Esc' }));
      save.addEventListener('click', () => { if (!save.disabled && this._modeBannerBtn) this._modeBannerBtn.click(); });
      const discard = document.createElement('button');
      discard.type = 'button';
      discard.className = 'scribe-mode-banner-done scribe-mode-banner-discard';
      discard.textContent = 'Discard';
      discard.addEventListener('click', () => this._discardModeSession());
      const exit = document.createElement('span');
      exit.className = 'scribe-mode-banner-exit';
      exit.append(save, discard, done);
      banner.append(ic, name, dot, hint, exit);
      this.pdfViewerElem.appendChild(banner);
      this._modeBanner = banner;
      this._modeBannerParts = {
        ic, name, hint, done, save, discard, exit,
      };
    }
    this._modeBannerBtn = activeBtn;
    this._modeBannerParts.ic.innerHTML = activeBtn.querySelector('.cr-icon')?.innerHTML || '';
    this._modeBannerParts.name.textContent = activeBtn.title;
    this._modeBannerParts.hint.textContent = activeBtn.dataset.modeHint;

    // Fill & Sign's placement palette belongs to the bar: it mounts before Done while its mode is active.
    // The phone layout has no bar, so there the palette keeps its floating pill above the dock.
    const fsPal = this._fillSignTool ? this._fillSignTool.paletteElem() : null;
    if (fsPal) {
      const inBar = activeBtn === this._fillSignTool.toolbarElem && !this._phoneUi;
      if (inBar) {
        if (fsPal.parentElement !== this._modeBanner) this._modeBanner.insertBefore(fsPal, this._modeBannerParts.exit);
      } else if (fsPal.parentElement !== this.pdfViewerElem) {
        this.pdfViewerElem.appendChild(fsPal);
      }
    }

    const xtSeg = this._extractTablesTool ? this._extractTablesTool.viewSegElem() : null;
    if (xtSeg) {
      if (activeBtn === this._extractTablesTool.toolbarElem) {
        if (xtSeg.parentElement !== this._modeBanner) this._modeBanner.insertBefore(xtSeg, this._modeBannerParts.name.nextSibling);
      } else {
        xtSeg.remove();
      }
    }

    // The Recognize Text mode runs from its banner, so the language and Start controls mount while it is the active mode.
    const recogMode = !!this._recognizeTool && activeBtn === this._recognizeTool.toolbarElem;
    this._modeBanner.classList.toggle('scribe-mode-recognize', recogMode);
    if (recogMode) {
      if (this._recognizeAlreadyRan()) {
        this._recognizeExtras?.remove();
        this._modeBannerParts.hint.textContent = '✓ Recognized — text is selectable and searchable';
      } else {
        this._ensureRecognizeExtras();
        const pages = this._deepOcrPageCount();
        if (pages === 0) this._modeBannerParts.hint.textContent = 'Text is already selectable on every page';
        this._recognizeRunBtn.disabled = pages === 0;
        if (this._recognizeExtras.parentElement !== this._modeBanner) this._modeBanner.insertBefore(this._recognizeExtras, this._modeBannerParts.exit);
      }
    } else if (this._recognizeExtras) {
      this._recognizeExtras.remove();
    }

    this._modeBanner.style.display = 'flex';
    this._syncModeExitButtons(activeBtn);
    if (this._modeTrackWrap) this._syncModeTrackValue();
    this._syncPhoneVerbBar();
    this._positionBanners();
  }

  /**
   * Build the Recognize Text working controls (language picker and Start) once.
   * The active surface mounts them, either the desktop mode banner or the phone dock's mode bar.
   */
  _ensureRecognizeExtras() {
    if (this._recognizeExtras) return;
    const tools = document.createElement('span');
    tools.className = 'scribe-mode-banner-tools';
    const langWrap = document.createElement('span');
    langWrap.className = 'scribe-mode-banner-langwrap';
    const langBtn = document.createElement('button');
    langBtn.type = 'button';
    langBtn.className = 'scribe-mode-banner-lang';
    langBtn.title = 'Recognition language';
    const langLabel = document.createElement('span');
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
      if (code === current) { item.classList.add('selected'); langLabel.textContent = label; }
      item.addEventListener('mousedown', (e) => e.preventDefault());
      item.addEventListener('click', () => {
        this.scribe.opt.langs = [code];
        langLabel.textContent = label;
        for (const it of langItems) it.classList.toggle('selected', it === item);
        langMenu.style.display = 'none';
        langBtn.classList.remove('active');
      });
      langItems.push(item);
      langMenu.appendChild(item);
    }
    if (!langLabel.textContent) langLabel.textContent = current;
    const caret = document.createElement('span');
    caret.innerHTML = CARET_SVG;
    langBtn.append(langLabel, caret);
    this._wireDropdown(langBtn, langMenu);
    langWrap.append(langBtn, langMenu);
    const runBtn = document.createElement('button');
    runBtn.type = 'button';
    runBtn.className = 'scribe-mode-banner-run';
    runBtn.textContent = 'Start';
    runBtn.addEventListener('click', () => {
      if (runBtn.classList.contains('busy') || runBtn.disabled) return;
      this._recognizeAll(runBtn);
    });
    this._recognizeRunBtn = runBtn;
    this._recognizeLangWrap = langWrap;
    tools.append(langWrap, runBtn);
    this._recognizeExtras = tools;
  }

  /**
   * Reflect the running mode's target in the phone's docked verb bar.
   * The bar shows the picked lines' editing verbs, the picked placement's delete, or the open line session's toggles.
   * It stays hidden outside the phone layout and outside a mode.
   */
  _syncPhoneVerbBar() {
    const bar = this._vbarElem;
    if (!bar) return;
    const sv = this.scribe;
    const editing = !!sv._editTextLineEditor?.isOpen();
    const kind = !this._phoneUi ? null
      : (editing || sv._editTextActive) ? 'text'
        : sv._graphicsEditActive ? 'graphics'
          : this._fillSignTool?.isOpen() && selectedFillItem(sv) ? 'fill' : null;
    const was = bar.classList.contains('on');
    bar.classList.toggle('on', !!kind);
    this.pdfViewerElem.classList.toggle('scribe-vbar-on', !!kind);
    if (kind) {
      const p = this._vbarParts;
      const sessionOn = kind === 'text' && editing;
      p.undo.style.display = '';
      p.redo.style.display = '';
      p.edit.style.display = kind === 'text' && !sessionOn ? '' : 'none';
      p.bold.style.display = kind === 'text' ? '' : 'none';
      p.italic.style.display = kind === 'text' ? '' : 'none';
      p.copy.style.display = kind === 'text' && !sessionOn ? '' : 'none';
      p.sep.style.display = '';
      const sepAnchor = sessionOn ? p.hint : kind !== 'text' ? p.deselect : p.del;
      if (p.sep.nextSibling !== sepAnchor) bar.insertBefore(p.sep, sepAnchor);
      p.del.style.display = !sessionOn ? '' : 'none';
      p.deselect.style.display = kind !== 'text' ? '' : 'none';
      p.hint.style.display = sessionOn ? '' : 'none';
      p.done.style.display = sessionOn ? '' : 'none';
      if (kind === 'fill') {
        // The bar only appears for a picked item, so its verbs are always live.
        p.del.disabled = false;
        p.deselect.disabled = false;
        p.del.title = 'Delete';
      } else if (kind === 'graphics') {
        const counts = sv._graphicsEditSelectedCounts?.() || { count: 0, images: 0, paths: 0 };
        const has = counts.count > 0;
        p.del.disabled = !has;
        p.deselect.disabled = !has;
        p.del.title = has ? graphicsDeleteLabel(counts) : 'Delete';
      } else if (sessionOn) {
        const line = sv._editTextLineEditor.lineOpen();
        const i = line && line.page ? line.page.lines.indexOf(line) : -1;
        p.hint.textContent = i >= 0 ? `Editing line ${i + 1}` : 'Editing line';
        p.bold.disabled = false;
        p.italic.disabled = false;
        p.bold.classList.remove('active');
        p.italic.classList.remove('active');
      } else {
        const lines = sv._editTextSelectedLines?.() || [];
        const has = lines.length > 0;
        p.edit.disabled = lines.length !== 1;
        p.copy.disabled = !has;
        p.del.disabled = !has;
        p.del.title = 'Delete';
        for (const [prop, btn] of /** @type {Array<['bold'|'italic', HTMLButtonElement]>} */ ([['bold', p.bold], ['italic', p.italic]])) {
          const s = has && sv._editTextStyleState ? sv._editTextStyleState(prop) : null;
          btn.disabled = !s || !s.present || s.locked;
          btn.classList.toggle('active', !!s && s.on);
        }
      }
    }
    this._syncUndoState();
    if (was !== !!kind && this.scribe.scrollContainer) this._relayout();
  }

  /**
   * Undo or redo one step from the UI controls.
   * @param {boolean} redo
   */
  _doUndo(redo) {
    const ed = this.scribe._editTextLineEditor;
    if (ed?.isOpen()) {
      if (redo) ed.redo(); else ed.undo();
    } else if (redo) this.scribe.redo();
    else this.scribe.undo();
    this._syncUndoState();
  }

  /**
   * Reflect the undo/redo stacks and the mode session's dirty state in every undo control.
   * The history has no change event, so call this after anything that can move the stacks.
   */
  _syncUndoState() {
    const doc = this.scribe.doc;
    const ed = this.scribe._editTextLineEditor;
    const session = !!ed?.isOpen();
    const canUndo = session ? ed.canUndo() : !!(doc && doc.canUndo);
    const canRedo = session ? ed.canRedo() : !!(doc && doc.canRedo);
    if (this._undoBtnElem) this._undoBtnElem.classList.toggle('disabled', !canUndo);
    if (this._redoBtnElem) this._redoBtnElem.classList.toggle('disabled', !canRedo);
    if (this._vbarParts) {
      this._vbarParts.undo.disabled = !canUndo;
      this._vbarParts.redo.disabled = !canRedo;
    }
    if (this._fsUndoBtn) this._fsUndoBtn.classList.toggle('disabled', !canUndo);
    const dirty = !!doc && this._modeBaseline >= 0 && doc.docHistory.undoStack.length !== this._modeBaseline;
    if (this._dockModeParts?.save) this._dockModeParts.save.disabled = !dirty;
    if (this._modeBannerParts?.save) this._modeBannerParts.save.disabled = !dirty;
  }

  /** Acknowledge a destructive action with one soft swell of the toolbar undo button. */
  _pulseUndoButton() {
    this._syncUndoState();
    const btn = this._undoBtnElem;
    if (!btn) return;
    if (this._undoSwellT) clearTimeout(this._undoSwellT);
    btn.classList.remove('scribe-undo-swell');
    // Re-adding on the next frame restarts the animation when actions land back to back.
    requestAnimationFrame(() => {
      btn.classList.add('scribe-undo-swell');
      this._undoSwellT = setTimeout(() => {
        this._undoSwellT = null;
        btn.classList.remove('scribe-undo-swell');
      }, 800);
    });
  }

  /**
   * Swap the mode row and banner's exit buttons between Done and Save/Discard.
   * Only Edit Text and Edit Graphics take Save/Discard.
   * Entering one captures the history baseline its dirty state is measured against.
   * @param {?HTMLElement} activeBtn
   */
  _syncModeExitButtons(activeBtn) {
    if (activeBtn !== this._modeSessionBtn) {
      this._modeSessionBtn = activeBtn;
      this._modeBaseline = activeBtn && this.scribe.doc ? this.scribe.doc.docHistory.undoStack.length : -1;
    }
    const sessionExit = !!activeBtn
      && (activeBtn === this._editTextTool?.toolbarElem || activeBtn === this._graphicsEditTool?.toolbarElem);
    for (const parts of [this._dockModeParts, this._modeBannerParts]) {
      if (!parts || !parts.save) continue;
      parts.save.style.display = sessionExit ? '' : 'none';
      parts.discard.style.display = sessionExit ? '' : 'none';
      parts.done.style.display = sessionExit ? 'none' : '';
    }
    this._syncUndoState();
  }

  /**
   * Discard the active editing-mode session.
   * The document history unwinds to the depth captured at mode entry, then the mode exits.
   */
  _discardModeSession() {
    const ed = this.scribe._editTextLineEditor;
    if (ed?.isOpen()) ed.revert();
    const doc = this.scribe.doc;
    if (doc && this._modeBaseline >= 0) {
      let guard = 200;
      while (doc.docHistory.undoStack.length > this._modeBaseline && guard > 0) {
        guard -= 1;
        if (!this.scribe.undo()) break;
      }
      // The depth sits below the baseline when the session undid edits made before it began.
      while (doc.docHistory.undoStack.length < this._modeBaseline && guard > 0) {
        guard -= 1;
        if (!this.scribe.redo()) break;
      }
    }
    if (this._modeBannerBtn) this._modeBannerBtn.click();
    this._syncUndoState();
  }

  /**
   * Track the line editor's open state in the phone layout.
   * Opening reserves space above the software keyboard and zooms the line's column to the screen so the caret is placeable.
   * Closing restores the previous zoom and scroll.
   * @param {boolean} open
   */
  _onPhoneLineEditorOpen(open) {
    if (!this._phoneUi) {
      this._syncPhoneVerbBar();
      return;
    }
    const sv = this.scribe;
    if (open) {
      this._phoneLineEditing = true;
      this.pdfViewerElem.classList.add('scribe-line-editing');
      if (!this._phoneEditRestore) {
        this._phoneEditRestore = {
          zoom: sv.zoomLevel, left: sv.scrollContainer.scrollLeft, top: sv.scrollContainer.scrollTop,
        };
      }
      const line = sv._editTextLineEditor?.lineOpen();
      const canvas = this.pdfViewerElem.querySelector('.scribe-edit-text-editor');
      if (line && line.page && canvas && this.scribe._contentWidth > 0) {
        // The zoom anchors on the editor canvas, so the line holds still instead of drifting with the viewport center.
        const colBox = line.par?.bbox || line.bbox;
        const fitZoom = sv.scrollContainer.clientWidth / this.scribe._contentWidth;
        let target = (sv.scrollContainer.clientWidth - 32) / Math.max(40, colBox.right - colBox.left);
        target = Math.max(fitZoom, Math.min(target, fitZoom * 2.6));
        const r = canvas.getBoundingClientRect();
        sv.zoom(target / sv.zoomLevel, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
      }
      this._relayout();
      this._phoneEditEnsureVisible();
    } else {
      this._phoneLineEditing = false;
      this.pdfViewerElem.classList.remove('scribe-line-editing');
      const r = this._phoneEditRestore;
      this._phoneEditRestore = null;
      this._relayout();
      // The reading position must land exactly where the edit began, or the zoom out loses the user's place.
      if (r && sv.scrollContainer) {
        if (sv.zoomLevel !== r.zoom) sv.zoom(r.zoom / sv.zoomLevel);
        sv.scrollContainer.scrollLeft = r.left;
        sv.scrollContainer.scrollTop = r.top;
      }
    }
    this._syncPhoneVerbBar();
  }

  /**
   * Scroll the open line edit clear of the keyboard and the editing bar.
   * Runs on open and again whenever the keyboard inset changes, since the keyboard rises after the focus.
   */
  _phoneEditEnsureVisible() {
    if (!this._phoneLineEditing) return;
    const sv = this.scribe;
    const canvas = this.pdfViewerElem.querySelector('.scribe-edit-text-editor');
    const cont = sv.scrollContainer;
    if (!canvas || !cont) return;
    const r = canvas.getBoundingClientRect();
    const cr = cont.getBoundingClientRect();
    const dy = (r.top + r.height / 2) - (cr.top + cr.height * 0.4);
    if (Math.abs(dy) > 4) cont.scrollTop += dy;
    const line = sv._editTextLineEditor?.lineOpen();
    if (line && line.page) {
      const colLeft = (line.par?.bbox || line.bbox).left;
      const client = sv.contentToClient(line.page.n, { x: colLeft, y: 0 });
      if (Math.abs(client.x - (cr.left + 16)) > 4) cont.scrollLeft += client.x - (cr.left + 16);
    }
  }

  /** Re-apply canvas and thumbnail-panel sizing from the current dimensions and bar heights. */
  _relayout() {
    if (!this.scribe.scrollContainer) return;
    const top = this._topBarsHeight();
    // The phone app menu opens upward from the dock, and this cap keeps long menus scrolling in place instead of running off the top edge.
    if (this._phoneUi && this._dockElem) {
      this.pdfViewerElem.style.setProperty('--scribe-phone-menu-max', `${Math.max(120, this._height - this._bottomBarsHeight() - 24)}px`);
    }
    this._positionBanners();
    // The view-switch strip owns a band under the toolbar, and every view starts below it.
    const stripH = (this._sidebarTabsElem && !this._phoneUi) ? SIDEBAR_TABS_HEIGHT : 0;
    const panelTop = top + stripH;
    if (this._sidebarTabsElem) this._sidebarTabsElem.style.top = `${top}px`;
    if (this._thumbnailPanel) {
      this._thumbnailPanel.panelElem.style.top = `${panelTop}px`;
      this._thumbnailPanel.panelElem.style.height = `${this._height - panelTop}px`;
    }
    if (this._bookmarksPanel) {
      this._bookmarksPanel.panelElem.style.top = `${panelTop}px`;
      this._bookmarksPanel.panelElem.style.height = `${this._height - panelTop}px`;
    }
    if (this._commentsPanel) {
      this._commentsPanel.panelElem.style.top = `${panelTop}px`;
      this._commentsPanel.panelElem.style.height = `${this._height - panelTop}px`;
    }
    if (this._automatePanel) {
      this._automatePanel.panelElem.style.top = `${top}px`;
      this._automatePanel.panelElem.style.height = `${this._height - top}px`;
      // The panel is desktop-only, so the phone layout reclaims its width.
      // Closing re-enters `_relayout` once with the panel already closed, so the recursion ends there.
      if (this._phoneUi && this._automatePanel.isOpen()) this._automatePanel.close();
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
    if (this._sidebarTabsElem && activePanel) this._sidebarTabsElem.style.width = `${panelW}px`;
    const inset = Math.min(panelW, Math.max(0, this._width - 80));
    const rightW = (this._automatePanel && this._automatePanel.isOpen())
      ? Math.min(this._automatePanel.width, Math.max(0, this._width - inset - 80)) : 0;
    // Both overlay tracks are positioned against the full-width container, so each is moved to the document's edge by hand.
    if (this._vScrollTrack) this._vScrollTrack.style.right = `${rightW}px`;
    if (this._hScrollTrack) this._hScrollTrack.style.left = `${inset}px`;
    this.scribe.scrollContainer.style.marginLeft = `${inset}px`;
    this.scribe.resize(this._width - inset - rightW, this._height - top - this._docBottomInset());
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
    this._syncSidebarControls();
    if (this._automatePanel) this._automatePanel.syncSidebar();
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

  /**
   * Apply an Automate-panel resize dragged from its left edge.
   * @param {number} desiredWidth
   * @param {'start'|'move'|'end'} phase
   */
  _resizeAutomate(desiredWidth, phase) {
    if (!this._automatePanel) return;
    if (phase === 'start') {
      this._beginSidebarResize();
      return;
    }
    this._automatePanel.setWidth(desiredWidth);
    if (phase === 'end') {
      this._endSidebarResize();
      return;
    }
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
    const top = this._topBarsHeight();
    const isSwitch = !!fromPanel && !!toPanel;
    // The strip rides the sidebar: it slides with the view on open/close and holds still through a switch's crossfade.
    const strip = this._phoneUi ? null : this._sidebarTabsElem;

    const setInset = (/** @type {number} */ raw) => {
      const inset = Math.min(Math.max(0, raw), Math.max(0, this._width - 80));
      // The open Automate panel keeps its right inset through the sidebar animation.
      const rightW = (this._automatePanel && this._automatePanel.isOpen())
        ? Math.min(this._automatePanel.width, Math.max(0, this._width - inset - 80)) : 0;
      // Only the document's left edge travels during the slide, so the vertical track keeps the offset `_relayout` gave it.
      if (this._hScrollTrack) this._hScrollTrack.style.left = `${inset}px`;
      this.scribe.scrollContainer.style.marginLeft = `${inset}px`;
      this.scribe.resize(this._width - inset - rightW, this._height - top);
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
      if (strip) {
        strip.style.transform = '';
        strip.style.display = toEl ? '' : 'none';
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
    if (strip) {
      if (toEl) strip.style.width = `${toW}px`;
      if (!isSwitch) {
        strip.style.display = '';
        strip.style.transform = toEl ? `translateX(-${toW}px)` : 'translateX(0)';
      }
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
        if (strip) strip.style.transform = toEl.style.transform;
      } else if (fromEl) {
        fromEl.style.transform = `translateX(-${fromW * e}px)`; // slide the outgoing view out
        if (strip) strip.style.transform = fromEl.style.transform;
      }
      setInset(fromW + (toW - fromW) * e);
      // Keep looping only while this transition is still the current one; an interrupt/destroy replaces or nulls it.
      if (p < 1) { if (this._sidebarAnim === anim) anim.raf = requestAnimationFrame(frame); } else cleanup();
    };
    anim.raf = requestAnimationFrame(frame);
  }

  /** Reflect the sidebar's state on its toggle and view-switch strip (a no-op without a sidebar). */
  _syncSidebarControls() {
    if (!this._sidebarToggleElem) return;
    if (this._activeSidebar) this._lastSidebarView = this._activeSidebar;
    const open = this._activeSidebar !== null;
    this._sidebarToggleElem.classList.toggle('active', open);
    this._sidebarToggleElem.title = open ? 'Hide sidebar' : 'Show sidebar';
    this._sidebarToggleElem.ariaLabel = this._sidebarToggleElem.title;
    for (const [key, tab] of Object.entries(this._sidebarTabElems)) {
      tab.classList.toggle('on', key === this._activeSidebar);
      const panel = this._panelFor(/** @type {'thumbnails'|'bookmarks'|'comments'} */ (key));
      tab.style.display = (panel && panel.toggleElem.style.display !== 'none') ? '' : 'none';
    }
    // A running transition owns the strip's visibility, so only the resting state is set here.
    if (this._sidebarTabsElem && !this._sidebarAnim) {
      this._sidebarTabsElem.style.display = (open && !this._phoneUi) ? '' : 'none';
    }
  }

  /**
   * Show or hide the in-window app menu button (a desktop shell hides it after moving its commands into native menus).
   * @param {boolean} visible
   */
  setMenuButtonVisible(visible) {
    this.pdfViewerElem.classList.toggle('scribe-menu-button-hidden', !visible);
  }

  /**
   * Populate the app menu's "Open recent" submenu, for a desktop shell that can reopen files by path.
   * The row stays hidden while the list is empty, so surfaces that never call this never show it.
   * @param {Array<{label: string, open: () => void}>} files - Most recent first.
   * @param {() => void} [onClear] - Invoked by the submenu's "Clear list" row.
   */
  setRecentFiles(files, onClear) {
    if (!this._recentFilesSubmenu) return;
    /** @type {Array<'sep' | {label: string, onClick: () => void}>} */
    const rows = files.map((f) => ({ label: f.label, onClick: f.open }));
    if (rows.length && onClear) rows.push('sep', { label: 'Clear list', onClick: onClear });
    this._recentFilesSubmenu.setItems(rows);
  }

  /**
   * Close the active document's tab, for a desktop shell's close-tab shortcut.
   * Fewer than two documents open is refused, leaving the caller to close its window instead.
   * @returns {boolean} Whether a tab was closed.
   */
  closeActiveDocument() {
    if (this._tabs.length < 2) return false;
    this._closeTab(this._activeTab);
    return true;
  }

  /**
   * Open or close the drop-down's list.
   * Closing never changes which mode is on.
   * @param {boolean} on
   */
  _setModeTrackOpen(on) {
    const track = this._modeTrackEl;
    const chev = this._modeTrackChev;
    if (!track || !chev || this._modeTrackOpen === on) return;
    if (on && chev.classList.contains('disabled')) return;
    this._modeTrackOpen = on;
    track.classList.toggle('open', on);
    chev.title = on ? 'Hide extra tools' : 'More tools';
  }

  /**
   * Compose the mode drop-down's value and list, and pin its width.
   * The control is sized to its widest possible value, so neither opening nor a new selection changes its width.
   */
  _syncModeTrackValue() {
    const wrap = this._modeTrackWrap;
    const track = this._modeTrackEl;
    const row1 = this._modeTrackRow1;
    const more = this._modeTrackMore;
    const chev = this._modeTrackChev;
    const view = this._modeTrackViewBtn;
    if (!wrap || !track || !row1 || !more || !chev || !view) return;
    this._setModeTrackOpen(false);
    const btns = (this._exclusiveToolBtns || []).filter((b) => b.isConnected);
    const active = btns.find((b) => b.classList.contains('active')) || null;
    // Pull everything back to row one before wiping the old rows, so no button node is discarded with them.
    for (const b of btns) row1.insertBefore(b, chev);
    row1.insertBefore(view, chev);
    more.textContent = '';
    // Measure every candidate as the lone value, out of flow so a tight bar cannot squeeze the sample.
    const candidates = [view, ...btns];
    wrap.style.width = '';
    wrap.style.height = '';
    track.style.width = '';
    track.style.position = 'fixed';
    track.style.visibility = 'hidden';
    for (const b of candidates) b.style.display = 'none';
    let width = 0;
    for (const b of candidates) {
      b.style.display = '';
      width = Math.max(width, Math.ceil(track.getBoundingClientRect().width));
      b.style.display = 'none';
    }
    for (const b of candidates) b.style.display = '';
    const height = track.offsetHeight;
    track.style.position = '';
    track.style.visibility = '';
    // A bar hidden by the library view measures zero, so the control stays unpinned and the first overflow sync that sees it laid out re-measures.
    if (width > 0) {
      track.style.width = `${width}px`;
      wrap.style.width = `${width}px`;
      wrap.style.height = `${height}px`;
    }
    const listRow = (el) => {
      const rowDiv = document.createElement('div');
      rowDiv.className = 'scribe-mode-track-row';
      rowDiv.appendChild(el);
      more.appendChild(rowDiv);
    };
    if (active) listRow(view);
    for (const b of btns) {
      if (b !== active) listRow(b);
    }
  }

  /**
   * Run one of the app's menu commands by id, for a desktop shell routing its native menu items here.
   * Ids unknown or unavailable in this viewer configuration are ignored.
   * @param {string} id
   * @returns {void | Promise<void>}
   */
  runMenuCommand(id) {
    const fn = this._menuCommands?.[id];
    if (fn) return fn();
    return undefined;
  }

  /**
   * The state a desktop shell needs to enable and check its native menu items and tint its window controls.
   * @returns {{docOpen: boolean, recognize: boolean, combine: boolean, split: boolean,
   *   coverEnabled: boolean, coverChecked: boolean, darkChecked: boolean,
   *   fieldsEnabled: boolean, fieldsChecked: boolean}}
   */
  getMenuState() {
    const doc = this.doc;
    return {
      docOpen: !!doc,
      recognize: !!doc && this._deepOcrPageCount() > 0 && !this._recognizeAlreadyRan(),
      combine: this._tabs.length >= 2,
      split: !!doc && outlineSplitSegments(doc.outline || [], doc.pageMetrics.length).length >= 2,
      coverEnabled: this.scribe.state.pagesPerRow === 2,
      coverChecked: !!this.scribe.state.coverAlone,
      darkChecked: this._effectiveTheme() === 'dark',
      fieldsEnabled: !!doc && docHasFormFields(doc),
      fieldsChecked: !!getHighlightFields(),
    };
  }

  /** Broadcast the current menu state so a listening desktop shell can refresh its native menus. */
  _notifyMenuState() {
    if (!this._menuCommands) return;
    this.pdfViewerElem.dispatchEvent(new CustomEvent('scribe-menu-state-change', { detail: this.getMenuState(), bubbles: true }));
  }

  /**
   * The assistant's LLM connection, or null when one cannot be constructed.
   * @returns {Promise<?import('../js/assistant/assistant.js').AssistantAdapter>}
   */
  async getAssistantAdapter() {
    if (this._assistantAdapter) return this._assistantAdapter;
    const key = this.getStoredAssistantKey();
    if (!key) return null;
    try {
      this._assistantAdapter = await this._assistantAdapterFromKey(key);
    } catch (err) {
      console.error('Failed to construct the assistant adapter:', err);
      return null;
    }
    return this._assistantAdapter;
  }

  /** @returns {?string} */
  // eslint-disable-next-line class-methods-use-this
  getStoredAssistantKey() {
    try {
      return window.localStorage.getItem(ASSISTANT_KEY_STORAGE_KEY);
    } catch {
      return null;
    }
  }

  /**
   * Store a user-pasted assistant API key on this device and construct the adapter from it.
   * The key's validity is only proven by the first real call; construction succeeds regardless.
   * @param {string} key
   */
  async setAssistantKey(key) {
    const adapter = await this._assistantAdapterFromKey(key);
    try {
      window.localStorage.setItem(ASSISTANT_KEY_STORAGE_KEY, key);
    } catch { /* localStorage unavailable */ }
    this._assistantAdapter = adapter;
    this._assistantAdapterInjected = false;
  }

  forgetAssistantKey() {
    try {
      window.localStorage.removeItem(ASSISTANT_KEY_STORAGE_KEY);
    } catch { /* localStorage unavailable */ }
    if (!this._assistantAdapterInjected) this._assistantAdapter = null;
  }

  /** @returns {?string} */
  // eslint-disable-next-line class-methods-use-this
  getStoredAssistantModel() {
    try {
      return window.localStorage.getItem(ASSISTANT_MODEL_STORAGE_KEY);
    } catch {
      return null;
    }
  }

  /**
   * Persist the assistant's model choice on this device and apply it to the live adapter.
   * The adapter picks it up on its next send, so switching rebuilds neither the adapter nor the conversation.
   * @param {string} id
   */
  setAssistantModel(id) {
    try {
      window.localStorage.setItem(ASSISTANT_MODEL_STORAGE_KEY, id);
    } catch { /* localStorage unavailable */ }
    if (this._assistantAdapter) this._assistantAdapter.model = id;
  }

  /**
   * Construct the vendor adapter from a key.
   * @param {string} key
   * @returns {Promise<import('../js/assistant/assistant.js').AssistantAdapter>}
   */
  async _assistantAdapterFromKey(key) {
    // Imported on use, so a session that never sets a key never downloads the vendor code.
    const { AssistantAdapterAnthropic } = await import('../../cloud-adapters/anthropic-assistant/AssistantAdapterAnthropic.js');
    const stored = this.getStoredAssistantModel();
    const model = stored && AssistantAdapterAnthropic.MODELS.some((m) => m.id === stored) ? stored : undefined;
    return new AssistantAdapterAnthropic({ apiKey: key, model });
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
    this._setPhoneUi(width <= 480 || (this._coarsePointer && height <= 480));
    this._syncModeOverflow();
    if (this.dropZone) {
      const dropTop = this._phoneUi ? 0 : this.toolbarHeight;
      this.dropZone.style.top = `${dropTop}px`;
      this.dropZone.style.width = `${width - 6}px`;
      this.dropZone.style.height = `${height - dropTop - this._bottomBarsHeight()}px`;
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
      const widthMode = this._phoneUi || hZoom * docW > sc.clientWidth;
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
    if (this._phoneUi) this.pageNumElem.style.width = `${Math.max(1, this.pageNumElem.value.length) + 0.4}ch`;
    else this.pageNumElem.style.width = '3.4em';
  }

  /**
   * Enter or leave the phone layout: controls move between the toolbar and the bottom dock, and the panels between the side rail and the sheet / Pages room.
   * @param {boolean} phone
   */
  _setPhoneUi(phone) {
    if (phone === this._phoneUi) return;
    this._phoneUi = phone;
    // Mirrored onto the viewer because the tool modes read it to pick their touch behavior.
    this.scribe._phoneUi = phone;
    // The phone layout forces single-page view, and leaving it restores the persisted preference.
    this._applyPageLayoutPref();
    this.pdfViewerElem.classList.toggle('scribe-phone', phone);
    if (this.toolbarElem && this._appMenu && this._searchBar) {
      if (phone) {
        this._buildPhoneUi();
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
        if (this._dockEditBtn) this._dockElem.appendChild(this._dockEditBtn);
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
          this._companionStrip.setTucked(this._stripTucked, false);
        }
      } else {
        if (this._companionStrip) this._companionStrip.setVisible(false);
        this._closeSheet(true);
        this._closePagesRoom(true);
        this.toolbarElem.style.display = 'flex';
        this.toolbarElemStart.insertBefore(this._appMenu.menuWrap, this.toolbarElemStart.firstChild);
        if (this._toolbarButtonsElem && this.nextElem && this._pageInputGroup) {
          this._toolbarButtonsElem.insertBefore(this._pageInputGroup, this.nextElem.nextSibling);
        }
        // A desktop shell may have appended its window controls to the end zone, and the search control re-enters before them.
        this.toolbarElemEnd.insertBefore(this._searchBar.searchElem, this.toolbarElemEnd.querySelector('.scribe-shell-corner'));
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
    this._syncSidebarControls();
    this._syncDocGatedControls();
    this._closeModeSheet();
    // A mode can be running through the flip, so its bar moves between the banner and the dock.
    this._syncModeBanner();
    this.scribe._editTextRefreshFrames?.();
    if (this.scribe.scrollContainer) this._relayout();
  }

  /**
   * Build the phone's editing-mode controls.
   * These are the dock's Edit slot and its mode sheet, the dock's mode bar, and the docked verb bar.
   * The dock and the tool modes can be built in either order, so this runs from both paths and returns early once done.
   */
  _buildPhoneModeUi() {
    if (this._dockEditBtn || !this._dockElem) return;
    if (![this._editTextTool, this._graphicsEditTool, this._fillSignTool, this._editPagesTool, this._recognizeTool].some((t) => !!t)) return;
    const dock = this._dockElem;
    // Each row mirrors its toolbar button and drives it with a programmatic click, so mode exclusivity, Escape, and the doc gating keep their one implementation.
    const editBtn = makeIconButton('Edit', DOCK_EDIT_SVG, 'Editing tools');
    this._dockEditBtn = editBtn;
    const sheet = document.createElement('div');
    sheet.className = 'scribe-mode-sheet';
    this._modeSheetElem = sheet;
    const sheetHd = document.createElement('div');
    sheetHd.className = 'scribe-mode-sheet-hd';
    const sheetPill = document.createElement('div');
    sheetPill.className = 'scribe-sheet-pill';
    sheetHd.appendChild(sheetPill);
    const sheetList = document.createElement('div');
    sheetList.className = 'scribe-mode-sheet-list';
    sheet.append(sheetHd, sheetList);
    this.pdfViewerElem.appendChild(sheet);
    attachSheetDrag(sheet, sheetHd, {
      host: this.pdfViewerElem,
      resizable: false,
      onDismiss: () => this._closeModeSheet(),
    });
    editBtn.addEventListener('click', () => {
      if (editBtn.classList.contains('disabled')) return;
      if (sheet.classList.contains('open')) { this._closeModeSheet(); return; }
      sheetList.replaceChildren();
      // Pages are edited in the Pages room on the phone, so that row opens the room's Edit session instead of the desktop rail mode.
      const rows = [
        [this._editTextTool?.toolbarElem, 'Change or remove lines of text', null],
        [this._graphicsEditTool?.toolbarElem, 'Remove pictures and shapes', null],
        [this._fillSignTool?.toolbarElem, 'Place checks, crosses and signatures', null],
        [this._editPagesTool?.toolbarElem, 'Reorder or delete pages', () => {
          if (!this.doc) return;
          if (!this._roomOpen) this._pagesRoomGesture('tap', 0);
          this._setRoomEditing(true);
        }],
        [this._recognizeTool?.toolbarElem, this._recognizeAlreadyRan() ? 'Recognized' : 'Make scanned pages selectable', null],
      ];
      for (const [btn, sub, act] of rows) {
        if (!btn) continue;
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'scribe-mode-sheet-row';
        if (btn.classList.contains('active')) row.classList.add('on');
        if (btn.classList.contains('disabled')) row.disabled = true;
        const ic = document.createElement('span');
        ic.className = 'scribe-mode-sheet-ic';
        ic.innerHTML = btn.querySelector('.cr-icon')?.innerHTML || '';
        const txt = document.createElement('span');
        txt.className = 'scribe-mode-sheet-txt';
        const nm = document.createElement('span');
        nm.className = 'scribe-mode-sheet-nm';
        nm.textContent = btn.title;
        const sb = document.createElement('span');
        sb.className = 'scribe-mode-sheet-sub';
        sb.textContent = sub;
        txt.append(nm, sb);
        row.append(ic, txt);
        row.addEventListener('click', () => {
          this._closeModeSheet();
          if (act) act();
          else btn.click();
        });
        sheetList.appendChild(row);
      }
      sheet.classList.add('open');
    });
    const onModeSheetDocClick = (e) => {
      if (!sheet.classList.contains('open')) return;
      const t = /** @type {Node} */ (e.target);
      if (sheet.contains(t) || editBtn.contains(t)) return;
      this._closeModeSheet();
    };
    document.addEventListener('click', onModeSheetDocClick);
    this._teardownCallbacks.push(() => document.removeEventListener('click', onModeSheetDocClick));
    // Capture plus preventDefault, so closing the sheet never also exits an active mode.
    const onModeSheetKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented || !sheet.classList.contains('open')) return;
      e.preventDefault();
      this._closeModeSheet();
    };
    document.addEventListener('keydown', onModeSheetKey, true);
    this._teardownCallbacks.push(() => document.removeEventListener('keydown', onModeSheetKey, true));

    const modeRow = document.createElement('div');
    modeRow.className = 'scribe-dock-mode';
    const mic = document.createElement('span');
    mic.className = 'scribe-dock-mode-ic';
    const mnm = document.createElement('span');
    mnm.className = 'scribe-dock-mode-nm';
    const mstatus = document.createElement('span');
    mstatus.className = 'scribe-dock-mode-status';
    const mdone = document.createElement('button');
    mdone.type = 'button';
    mdone.className = 'scribe-dock-mode-done';
    mdone.textContent = 'Done';
    mdone.addEventListener('click', () => { if (this._modeBannerBtn) this._modeBannerBtn.click(); });
    const msave = document.createElement('button');
    msave.type = 'button';
    msave.className = 'scribe-dock-mode-save';
    msave.textContent = 'Save';
    msave.addEventListener('click', () => { if (!msave.disabled && this._modeBannerBtn) this._modeBannerBtn.click(); });
    const mdiscard = document.createElement('button');
    mdiscard.type = 'button';
    mdiscard.className = 'scribe-dock-mode-discard';
    mdiscard.textContent = 'Discard';
    mdiscard.addEventListener('click', () => this._discardModeSession());
    modeRow.append(mic, mnm, mstatus, msave, mdiscard, mdone);
    dock.appendChild(modeRow);
    this._dockModeRow = modeRow;
    this._dockModeParts = {
      ic: mic, nm: mnm, status: mstatus, save: msave, discard: mdiscard, done: mdone,
    };

    // The scribe-edit-text-tools class marks the bar for the line editor, whose click-away commit must ignore its presses.
    const vbar = document.createElement('div');
    vbar.className = 'scribe-vbar scribe-edit-text-tools';
    // preventDefault keeps the press from moving focus, which would dismiss the software keyboard mid-edit.
    vbar.addEventListener('pointerdown', (e) => e.preventDefault());
    const vb = (label, svg, extraClass) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `scribe-vbtn${extraClass ? ` ${extraClass}` : ''}`;
      if (svg) {
        const s = document.createElement('span');
        s.className = 'scribe-vbtn-ic';
        s.innerHTML = svg;
        b.appendChild(s);
      }
      const lbl = document.createElement('span');
      lbl.className = 'scribe-vbtn-lbl';
      lbl.textContent = label;
      if (label) b.appendChild(lbl);
      return b;
    };
    const vUndo = vb('', UNDO_SVG);
    vUndo.title = 'Undo';
    const vRedo = vb('', REDO_SVG);
    vRedo.title = 'Redo';
    const vEdit = vb('Edit', CM_EDIT_SVG);
    const vBold = vb('', CM_BOLD_SVG);
    vBold.title = 'Bold';
    const vItalic = vb('', CM_ITALIC_SVG);
    vItalic.title = 'Italic';
    const vCopy = vb('', CM_COPY_SVG);
    vCopy.title = 'Copy';
    const vSep = document.createElement('span');
    vSep.className = 'scribe-vbar-sep';
    const vDel = vb('', CM_TRASH_SVG, 'danger');
    vDel.title = 'Delete';
    const vDeselect = vb('Deselect', DOCK_DESELECT_SVG);
    const vHint = document.createElement('span');
    vHint.className = 'scribe-vbar-hint';
    const vDone = vb('Done', null, 'accent');
    vUndo.addEventListener('click', () => this._doUndo(false));
    vRedo.addEventListener('click', () => this._doUndo(true));
    vEdit.addEventListener('click', () => this.scribe._editTextOpenSelected?.());
    vBold.addEventListener('click', () => {
      if (this.scribe._editTextLineEditor?.isOpen()) this.scribe._editTextLineEditor.toggleStyle('bold');
      else this.scribe._editTextToggleStyle?.('bold');
    });
    vItalic.addEventListener('click', () => {
      if (this.scribe._editTextLineEditor?.isOpen()) this.scribe._editTextLineEditor.toggleStyle('italic');
      else this.scribe._editTextToggleStyle?.('italic');
    });
    vCopy.addEventListener('click', () => this.scribe._editTextCopySelection?.());
    // Deleting stays silent because Save and Discard on the mode row already report whether the session changed anything.
    vDel.addEventListener('click', () => {
      if (this._fillSignTool?.isOpen() && selectedFillItem(this.scribe)) {
        if (!deleteSelectedFillItem(this.scribe)) return;
        this._syncUndoState();
        this._syncPhoneVerbBar();
        return;
      }
      if (this.scribe._graphicsEditActive) {
        const counts = this.scribe._graphicsEditSelectedCounts?.() || { count: 0 };
        if (counts.count === 0 || !this.scribe._graphicsEditDeleteSelection?.()) return;
        this._syncUndoState();
        return;
      }
      const n = this.scribe._editTextSelectedLines?.().length || 0;
      if (n === 0 || !this.scribe._editTextDeleteSelection?.()) return;
      this._syncUndoState();
    });
    vDeselect.addEventListener('click', () => {
      if (this._fillSignTool?.isOpen() && selectedFillItem(this.scribe)) {
        deselectFillItem(this.scribe);
        this._syncPhoneVerbBar();
        return;
      }
      this.scribe._graphicsEditClearSelection?.();
    });
    vDone.addEventListener('click', () => {
      this.scribe._editTextLineEditor?.commit().catch((e) => console.error('Edit Text: commit failed:', e));
    });
    vbar.append(vUndo, vRedo, vEdit, vBold, vItalic, vCopy, vSep, vDel, vDeselect, vHint, vDone);
    this.pdfViewerElem.appendChild(vbar);
    this._vbarElem = vbar;
    this._vbarParts = {
      undo: vUndo, redo: vRedo, edit: vEdit, bold: vBold, italic: vItalic, copy: vCopy, sep: vSep, del: vDel, deselect: vDeselect, hint: vHint, done: vDone,
    };
    // The selection engine has no change seam, so the bar re-reads its target after every release while a mode runs.
    const onVbarSettle = () => {
      if (!this._phoneUi || !this._modeBannerBtn) return;
      queueMicrotask(() => this._syncPhoneVerbBar());
    };
    window.addEventListener('pointerup', onVbarSettle);
    this._teardownCallbacks.push(() => window.removeEventListener('pointerup', onVbarSettle));
  }

  /** Lower the mode sheet. */
  _closeModeSheet() {
    const sheet = this._modeSheetElem;
    if (!sheet) return;
    sheet.classList.remove('open', 'dragging');
    // An inline offset outranks the class transform, so the one a dismissing drag leaves must not survive to the next open.
    sheet.style.transform = '';
  }

  /**
   * Build the phone UI (dock, companion strip, Pages room, bottom sheet) on first phone-mode entry, so desktop-only viewers never pay for it.
   */
  _buildPhoneUi() {
    if (this._dockElem) return;
    const dock = document.createElement('div');
    dock.className = 'scribe-dock';
    this._dockElem = dock;
    this.pdfViewerElem.appendChild(dock);

    this._buildPhoneModeUi();

    if (!this._thumbnailPanel) return;

    // The companion strip is the phone's whole Pages surface: a tap on its pull tab or an upward drag expands it into the Pages room.
    this._companionStrip = createCompanionStrip(this.scribe, {
      onExpand: (phase, dy) => this._pagesRoomGesture(phase, dy),
      tuckPullSurface: dock,
      onTuckLayout: () => {
        if (this._stripRelayoutT) { clearTimeout(this._stripRelayoutT); this._stripRelayoutT = null; }
        this._stripDragLayout = true;
        this._relayout();
      },
      onTuckChange: (t) => {
        this._stripTucked = t;
        this._stripDragLayout = false;
        if (this._stripRelayoutT) { clearTimeout(this._stripRelayoutT); this._stripRelayoutT = null; }
        // A tucked bar keeps the full-height layout it already has.
        // A revealed bar re-insets only after its glide, so the settling strip covers live pages instead of a void.
        if (t) this._relayout();
        else this._stripRelayoutT = setTimeout(() => { this._stripRelayoutT = null; this._relayout(); }, 260);
      },
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

    // The pull morphs the strip's thumbnails into the room's grid rather than sliding the room over them as a separate panel.
    this._pagesMorph = createPagesMorph(this.scribe, {
      roomElem: room, roomHdElem: roomHd, stripElem: this._companionStrip.stripElem, panel: this._thumbnailPanel,
    });

    // Drag-down on the room header is the pull-up's reverse: the open room rides the finger back down into the strip along the same morph.
    // The gesture engages only on a decisively vertical downward pull, so a clean tap still reaches the header's buttons.
    /** @type {?{id: number, y0: number, x0: number, base: number, active: boolean, down: number, travel: number, morph: boolean}} */
    let hdPull = null;
    let hdSwallowClick = false;
    const hdPullDismiss = createPullDismiss();
    /** @param {PointerEvent} e */
    const hdPullMove = (e) => {
      if (!hdPull || e.pointerId !== hdPull.id) return;
      const p = hdPull;
      hdPullDismiss.track(e.clientY);
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
      const commit = hdPullDismiss.dismisses(down, p.travel);
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
      hdPullDismiss.begin(e.clientY);
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

    const panelsBtn = makeIconButton('Panels', DOCK_PANELS_SVG, 'Bookmarks and comments');
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
    // Shown in place of the tabs and action slot while a bookmarks Move session is on.
    const movehd = document.createElement('div');
    movehd.className = 'scribe-sheet-movehd';
    const movingTitle = document.createElement('span');
    movingTitle.className = 'scribe-sheet-moving-title';
    movingTitle.textContent = 'Moving bookmarks';
    const movingDone = document.createElement('button');
    movingDone.type = 'button';
    movingDone.className = 'scribe-sheet-moving-done';
    movingDone.textContent = 'Done';
    movingDone.addEventListener('click', () => { if (this._bookmarksPanel) this._bookmarksPanel.endMoveSession(); });
    movehd.append(movingTitle, movingDone);
    hd.append(pill, seg, movehd, acts);
    const content = document.createElement('div');
    content.className = 'scribe-sheet-content';
    this._sheetContentElem = content;
    sheet.append(hd, content);
    this._sheetElem = sheet;
    this.pdfViewerElem.append(scrim, sheet, room);

    attachSheetDrag(sheet, hd, {
      host: this.pdfViewerElem,
      resizable: true,
      body: content,
      onEngage: () => {
        // For the gesture's lifetime the document lays out full-height behind the sheet, so a descending sheet reveals live pages instead of the void its inset left.
        if (this._sheetRelayoutT) { clearTimeout(this._sheetRelayoutT); this._sheetRelayoutT = null; }
        this._sheetDragLayout = true;
        this._relayout();
      },
      onDismiss: () => this._closeSheet(),
      onSettle: () => {
        this._sheetRelayoutT = setTimeout(() => {
          this._sheetRelayoutT = null;
          this._sheetDragLayout = false;
          this._relayout();
        }, 300);
      },
    });
  }

  /** Open the bottom sheet on the last-shown view. */
  _openSheet() {
    if (!this._sheetElem || this._sheetOpen) return;
    // Switching from an open Pages view, the sheet is placed at rest beneath the room with no transition, and the room's slide-down is what uncovers it.
    const uncover = this._roomOpen;
    if (uncover) this._beginRoomSink();
    else this._closePagesRoom(true);
    this._sheetOpen = true;
    if (this._sheetElem.style.height) {
      this._sheetElem.style.transition = 'none';
      this._sheetElem.style.height = '';
      this._sheetElem.getBoundingClientRect();
      this._sheetElem.style.transition = '';
    }
    // No scrim: the sheet coexists with a lit, interactive document reflowed above it.
    if (uncover) {
      this._sheetElem.style.transition = 'none';
      this._sheetElem.classList.add('open');
      this._sheetElem.getBoundingClientRect();
      requestAnimationFrame(() => { if (this._sheetElem) this._sheetElem.style.transition = ''; });
    } else {
      this._sheetElem.classList.add('open');
    }
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
    if (!focused || !this._phoneUi) {
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
    if (!this._pagesRoomElem || this._roomOpen || !this._phoneUi) return;
    this._cancelRoomSink();
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

  /** Exit the open Pages room by sliding it down behind the dock, uncovering whatever sits beneath it. */
  _beginRoomSink() {
    const room = this._pagesRoomElem;
    if (!room || !this._roomOpen) return;
    if (this._pagesMorph) this._pagesMorph.abort();
    this._setRoomEditing(false);
    this._roomOpen = false;
    if (this._companionStrip) this._companionStrip.park();
    room.classList.add('sinking');
    room.classList.remove('open');
    this._roomSlideT = setTimeout(() => {
      this._roomSlideT = null;
      room.classList.remove('sinking');
      if (this._thumbnailPanel) {
        this._thumbnailPanel.setVisible(false);
        this._thumbnailPanel.panelElem.style.display = 'none';
      }
    }, 320);
  }

  /** Finish an in-flight sink instantly so a reopen (or mode flip) starts from the room's rest state. */
  _cancelRoomSink() {
    if (this._roomSlideT) { clearTimeout(this._roomSlideT); this._roomSlideT = null; }
    const room = this._pagesRoomElem;
    if (!room || !room.classList.contains('sinking')) return;
    room.classList.remove('sinking');
    room.style.transition = 'none';
    requestAnimationFrame(() => { if (this._pagesRoomElem) this._pagesRoomElem.style.transition = ''; });
    if (this._thumbnailPanel) {
      this._thumbnailPanel.setVisible(false);
      this._thumbnailPanel.panelElem.style.display = 'none';
    }
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
    this._cancelRoomSink();
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
    if (!room || !this._phoneUi) return;
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
      // From a tucked bar the room opens as a plain slide, since the morph would have to measure a bar that is not on screen.
      // The bar reveals invisibly beneath the open room, so closing the room lands on the bar rather than back at the tucked state.
      if (this._companionStrip && this._companionStrip.isTucked()) {
        this._openPagesRoom();
        setTimeout(() => {
          if (!this._roomOpen || !this._companionStrip) return;
          this._companionStrip.setTucked(false, false);
          this._stripTucked = false;
          this._relayout();
        }, 320);
        return;
      }
      this._cancelRoomSink();
      if (morph && !reduceMotion) {
        this._showPagesRoomContent();
        if (morph.begin()) {
          morph.frame(0);
          morph.settle(true, (committed) => {
            // The sheet closes only once the grown room covers it, so its relayout does not reflow the document mid-climb.
            if (committed) { this._roomOpen = true; this._closeSheet(true); }
          });
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

  /** Disable the controls that need a document while none is loaded. */
  _syncDocGatedControls() {
    const disabled = !this.doc;
    if (disabled && this._fillSignTool?.isOpen()) this._fillSignTool.close();
    if (disabled && this._editPagesTool?.isActive()) this._editPagesTool.close();
    if (disabled && this._recognizeTool?.isActive()) this._recognizeTool.close();
    if (disabled && this._extractTablesTool?.isActive()) this._extractTablesTool.close();
    for (const el of [
      this._searchBar?.searchElem,
      this._twoPageBtn,
      this._thumbnailPanel?.toggleElem,
      this._bookmarksPanel?.toggleElem,
      this._commentsPanel?.toggleElem,
      this._sidebarToggleElem,
      this._sheetPanelsBtn,
      this._dockEditBtn,
      this._fillSignTool?.toolbarElem,
      this._editPagesTool?.toolbarElem,
      this._recognizeTool?.toolbarElem,
      this._extractTablesTool?.toolbarElem,
      this._modeTrackViewBtn,
      this._modeTrackChev,
    ]) {
      if (!el) continue;
      el.classList.toggle('disabled', disabled);
      el.ariaDisabled = disabled ? 'true' : 'false';
      el.tabIndex = disabled ? -1 : 0;
    }

    const fieldsItem = this._fieldsToggleItem;
    if (fieldsItem) {
      const hasFields = !disabled && docHasFormFields(this.doc);
      fieldsItem.classList.toggle('disabled', !hasFields);
      fieldsItem.ariaDisabled = !hasFields ? 'true' : 'false';
      fieldsItem.tabIndex = !hasFields ? -1 : 0;
    }

    // Deferred text extraction can add visible native text after load, so the load path re-syncs on textReady.
    const editBtn = this._editTextTool?.toolbarElem;
    if (editBtn) {
      const editable = !disabled && !!this.doc.ocr?.active?.some((page) => {
        const nt = this.doc ? nativeTextForPage(this.doc, page) : {};
        return page?.lines?.some((line) => line.words.some((w) => nt[w.id]));
      });
      if (!editable && editBtn.classList.contains('active')) editBtn.click();
      editBtn.classList.toggle('disabled', !editable);
      editBtn.ariaDisabled = !editable ? 'true' : 'false';
      editBtn.tabIndex = !editable ? -1 : 0;
    }
    const graphicsBtn = this._graphicsEditTool?.toolbarElem;
    if (graphicsBtn) {
      // The area cut mirrors the tool's own picker, so the button never enables where nothing can be selected.
      let pathsIneligibleSomewhere = false;
      const hasGraphics = !disabled && !!this.doc?.fillShapes?.pages.some((shapes, n) => {
        const dims = this.doc?.pageMetrics?.[n]?.dims;
        if (!shapes || !dims) return false;
        if (pagePathsIneligible(this.doc, n)) pathsIneligibleSomewhere = true;
        const areaCap = dims.width * dims.height * 0.95;
        return pageImagePlacements(this.doc, n).some((e) => (e.right - e.left) * (e.bottom - e.top) < areaCap)
          || pagePathPlacements(this.doc, n).some((e) => (e.right - e.left) * (e.bottom - e.top) < areaCap);
      });
      if (!disabled && pathsIneligibleSomewhere) {
        graphicsBtn.dataset.modeHint = 'Click or drag to select images and shapes · Some pages have too many shapes to edit';
      } else {
        graphicsBtn.dataset.modeHint = 'Click or drag to select images and shapes · Delete or right-click removes them';
      }
      if (!hasGraphics && graphicsBtn.classList.contains('active')) graphicsBtn.click();
      graphicsBtn.classList.toggle('disabled', !hasGraphics);
      graphicsBtn.ariaDisabled = !hasGraphics ? 'true' : 'false';
      graphicsBtn.tabIndex = !hasGraphics ? -1 : 0;
    }
    // The closes above can end a mode without a button click, so refresh the banner here too.
    this._syncModeBanner();
    this._notifyMenuState();
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
    this._destroyed = true;
    if (this._libraryHooks?.saveAllDirty) {
      // Flush unsaved library sidecars while the docs are still alive.
      try { await this._libraryHooks.saveAllDirty(); } catch { /* Best effort; teardown continues. */ }
    }
    if (this._library) {
      this._library.destroy();
      this._library = null;
    }
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this._sidebarAnim) { cancelAnimationFrame(this._sidebarAnim.raf); this._sidebarAnim = null; }
    if (this._roomSlideT) { clearTimeout(this._roomSlideT); this._roomSlideT = null; }
    if (this._stripRelayoutT) { clearTimeout(this._stripRelayoutT); this._stripRelayoutT = null; }
    if (this._pagesMorph) this._pagesMorph.abort(); // cancels the settle rAF and revokes morph-owned thumbnail URLs
    if (this._thumbnailPanel) this._thumbnailPanel.destroy();
    if (this._bookmarksPanel) this._bookmarksPanel.destroy();
    if (this._commentsPanel) this._commentsPanel.destroy();
    // Teardown callbacks remove the document-level listeners and the highlight tool's observer/tooltip/cursor style.
    for (const cb of this._teardownCallbacks) cb();
    this._teardownCallbacks = [];
    // The app owns every tab's document (opened via attachDocument with owns=false), so close them all here.
    for (const tab of this._tabs) {
      try { await tab.doc.close(); } catch { /* ignore */ }
    }
    this._tabs = [];
    this._activeTab = -1;
    if (this.doc) {
      if (terminateDoc ?? this._ownsDoc) {
        try { await this.doc.close(); } catch { /* ignore */ }
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
      // Only `calcPageLayout` computes `_contentWidth`, and on a first load nothing has needed the page layout yet.
      this.scribe.calcPageLayout();
      const docW = this.scribe._contentWidth || imgDims.width;

      // The phone takes width-fit either way.
      const heightFitOverflows = ((stageH - 150) / imgDims.height) * docW > stageW;
      const widthFitDefault = isDefaultFit && (this._phoneUi || heightFitOverflows);
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
   * Build the edit toolbar's document actions and recognition surfaces.
   * Recognition itself lives in the Recognize Text tool mode; here only the touch app-menu row and the progress line are mounted.
   */
  _buildEditToolbar() {
    // Export PDF, the document-level actions (Combine / Split), and the Dark mode toggle live in the far-left app menu, which the viewer already seeded with Open / Print.
    const appMenu = this._appMenu;
    if (appMenu) {
      // Touch-only row replacing the bar's split button.
      this._menuCommands.recognize = () => { if (this._ocrMenuItem) this._recognizeAll(this._ocrMenuItem); };
      this._ocrMenuItem = appMenu.addAction('Recognize text', ICON_RECOGNIZE, this._menuCommands.recognize);
      this._ocrMenuItem.classList.add('scribe-touch-row');
      // The `busy` class barely shows (the menu closes on click; the browser's download UI is the real progress cue) but is kept to match the Combine / Split siblings.
      this._menuCommands['export-pdf'] = async () => {
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
      };
      const exportItem = appMenu.addAction('Export PDF', ICON_EXPORT, this._menuCommands['export-pdf']);

      // Separator before the document actions, hidden when neither Combine nor Split currently applies.
      this._appMenuDocSep = appMenu.addSeparator();

      // Combine every open document (tab) into one. Shown only when 2+ tabs are open (see `_updateCombineButton`).
      this._menuCommands.combine = async () => {
        combineItem.classList.add('busy');
        try {
          await this.combineOpenDocuments();
        } finally {
          combineItem.classList.remove('busy');
        }
      };
      const combineItem = appMenu.addAction('Combine open documents', ICON_COMBINE, this._menuCommands.combine);
      combineItem.dataset.action = 'combine';
      this._combineItem = combineItem;

      // Split the active document into one file per top-level bookmark. Shown only when it would yield 2+ files (see `_updateSplitButton`).
      this._menuCommands.split = async () => {
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
      };
      const splitItem = appMenu.addAction('Split at bookmarks', ICON_SPLIT, this._menuCommands.split);
      splitItem.dataset.action = 'split';
      this._splitItem = splitItem;

      // The automation surface's single opener; individual automations never get menu rows of their own.
      // Awaiting the load lets a click land during the panel module's fetch.
      if (this._automateEnabled) {
        this._menuCommands.automate = async () => {
          await this._automateReady;
          this._automatePanel?.open();
        };
        appMenu.addAction('Automate…', ICON_AUTOMATE, this._menuCommands.automate);
      }

      // Flipping the toggle sets an explicit light/dark preference that overrides the system default.
      // The switch reflects the theme in effect each time the menu opens.
      appMenu.addSeparator();
      // The row shows only while pages are paired, so it never describes a state that is not on screen.
      this._menuCommands['cover-alone'] = () => this._toggleCoverAlone();
      this._menuCommands['dark-mode'] = () => this._toggleDarkMode();
      this._menuCommands['highlight-fields'] = () => {
        if (this._fieldsToggleItem?.classList.contains('disabled')) return;
        setHighlightFields(this.scribe, !getHighlightFields());
        this._notifyMenuState();
      };
      const coverToggle = appMenu.addToggle('Separate cover page', ICON_COVER_ALONE, () => this.scribe.state.coverAlone, this._menuCommands['cover-alone']);
      this._coverToggleItem = coverToggle.item;
      this._syncPageLayoutControls();
      appMenu.addToggle('Dark mode', ICON_DARK, () => this._effectiveTheme() === 'dark', this._menuCommands['dark-mode']);
      const fieldsToggle = appMenu.addToggle('Highlight fields', ICON_FIELDS, () => getHighlightFields(), this._menuCommands['highlight-fields']);
      this._fieldsToggleItem = fieldsToggle.item;
    }

    // A subtle recognition progress line along the toolbar's bottom edge, hidden until OCR runs.
    // In the phone layout it rides the dock's top edge instead (and `_setPhoneUi` moves it on flips).
    const progressBar = document.createElement('div');
    progressBar.className = 'scribe-ocr-progress';
    this._ocrProgress = progressBar;
    const progressHost = (this._phoneUi && this._dockElem) ? this._dockElem : this.toolbarElemEnd?.parentElement;
    progressHost?.appendChild(progressBar);

    this._updateRecognizeButton();
    this._updateCombineButton();
    this._updateSplitButton();
  }

  /**
   * Pages deep OCR would recognize for the current document, or 0 when there is none.
   * Drives the Recognize Text mode's Start state, the touch menu row's visibility, and the progress bar's page total.
   * @returns {number}
   */
  _deepOcrPageCount() {
    const doc = this.doc;
    if (!doc) return 0;
    // While a deferred import's stats are still extracting, return 0 so the recognition surfaces start quiet instead of flashing on then vanishing.
    // `_setDoc` re-runs this once `textReady` lands.
    if (doc._textReadySettle) return 0;
    const { pageStats, pageCount, pdfType } = doc.inputData;
    if (doc.ocr?.['User Upload'] || !pageStats || pageStats.length !== pageCount) return pageCount;
    return selectOcrPages(pageStats, pdfType, 'autoDeep').filter(Boolean).length;
  }

  /**
   * True when this session already recognized the current document with the current settings, so every
   * surface that would start that identical run again withdraws the offer (the mode shows a receipt instead).
   * @returns {boolean}
   */
  _recognizeAlreadyRan() {
    return !!this.doc && this._recognizeRuns.get(this.doc) === (this.scribe.opt.langs || ['eng']).join('+');
  }

  /** Show the touch app-menu recognition row only when deep OCR would actually recognize at least one page and this session has not already done so. */
  _updateRecognizeButton() {
    if (this._ocrMenuItem) this._ocrMenuItem.style.display = this._deepOcrPageCount() > 0 && !this._recognizeAlreadyRan() ? '' : 'none';
    this._notifyMenuState();
  }

  /** Show the Combine menu item only when 2+ documents (tabs) are open. Combining one document is a no-op. */
  _updateCombineButton() {
    if (this._combineItem) this._combineItem.style.display = this._tabs.length >= 2 ? '' : 'none';
    this._updateDocSeparator();
    this._notifyMenuState();
  }

  /** Show the Split menu item only when the active document's top-level bookmarks would yield 2+ files. */
  _updateSplitButton() {
    if (this._splitItem) {
      const doc = this.doc;
      const count = doc ? outlineSplitSegments(doc.outline || [], doc.pageMetrics.length).length : 0;
      this._splitItem.style.display = count >= 2 ? '' : 'none';
    }
    this._updateDocSeparator();
    this._notifyMenuState();
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
   * Recognize the auto-selected (deep) pages, showing progress, then re-render the current page so the new text appears.
   * @param {HTMLSpanElement} btn - The button to show a busy state on.
   */
  async _recognizeAll(btn) {
    const doc = this.doc;
    if (!doc) return;
    const label = btn.textContent;
    btn.textContent = 'Recognizing…';
    btn.classList.add('busy');
    // Hiding the picker also keeps the busy label from crushing the mode name on the narrow phone row.
    if (this._recognizeLangWrap) this._recognizeLangWrap.style.display = 'none';
    this.pdfViewerElem.classList.add('scribe-recog-alive');

    // Key progress strictly on `convert` events (deduped by page index) so the faster pre-render `render` events do not inflate it.
    // The desktop toolbar line runs from a 0.04 sliver to 0.9, reserving the last tenth for the compare/optimize tail (no page index), which the snap-to-full fills on success.
    const bar = this._ocrProgress;
    const total = this._deepOcrPageCount();
    const langSig = (this.scribe.opt.langs || ['eng']).join('+');
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
      // A one-page job has no wind bar to fill, so the icon and button cues carry its whole run.
      if (seen.size > 0 && total > 1) {
        this.pdfViewerElem.classList.remove('scribe-recog-alive');
        // Mid-run, a tab switch moves this.doc to another document, whose strip must not show this run's band.
        if (this.doc === doc) this._companionStrip?.setRecognition(Math.min(1, seen.size / total));
      }
    };

    let ok = false;
    try {
      await doc.recognize({ langs: this.scribe.opt.langs, ocrPages: 'autoDeep' });
      ok = true;
      this._recognizeRuns.set(doc, langSig);
      await this.scribe.displayPage(this.scribe.state.cp.n, false, true);
    } catch (err) {
      console.error('OCR failed:', err);
      // A banner, not a toast: recognition is a long async job the user may have stepped away from.
      this._showBanner('Text recognition didn’t finish. The document was left unchanged.');
    } finally {
      doc.progressHandler = prevProgress;
      btn.textContent = label;
      btn.classList.remove('busy');
      this.pdfViewerElem.classList.remove('scribe-recog-alive');
      if (this._recognizeLangWrap) this._recognizeLangWrap.style.display = '';
      if (bar) {
        if (ok) bar.style.transform = 'scaleX(1)';
        setTimeout(() => { bar.style.opacity = '0'; }, ok ? 250 : 0);
        setTimeout(() => { bar.style.transform = 'scaleX(0)'; }, 600);
      }
      if (this._companionStrip && this.doc === doc) {
        if (ok && total > 1) this._companionStrip.finishRecognition();
        else this._companionStrip.setRecognition(null);
      }
      // The run ends on its own result: the mode stays open, and these syncs repaint it as the receipt.
      this._updateRecognizeButton();
      this._syncDocGatedControls();
    }
  }

  /**
   * Read the persisted page-layout preference.
   * @returns {'single'|'double'|'single-cover'|'double-cover'}
   */
  // eslint-disable-next-line class-methods-use-this
  _readPageLayoutSetting() {
    try {
      const v = window.localStorage.getItem(PAGE_LAYOUT_STORAGE_KEY);
      if (v === 'single' || v === 'double' || v === 'single-cover' || v === 'double-cover') return v;
    } catch { /* localStorage unavailable (private mode / sandbox). Fall through to default. */ }
    return 'single';
  }

  /** Persist the current page-layout preference. */
  _writePageLayoutSetting() {
    try { window.localStorage.setItem(PAGE_LAYOUT_STORAGE_KEY, this._pageLayoutSetting); } catch { /* localStorage unavailable. The choice just won't persist. */ }
  }

  /** Push the persisted layout preference into the viewer, except that the phone layout always forces single-page. */
  _applyPageLayoutPref() {
    const two = !this._phoneUi && this._pageLayoutSetting.startsWith('double');
    this.scribe.setPagesPerRow(two ? 2 : 1, this._pageLayoutSetting.endsWith('-cover'));
    this._syncPageLayoutControls();
  }

  /** Flip single/two-page view from the toolbar toggle and persist the choice. */
  _togglePageLayout() {
    if (this._twoPageBtn?.classList.contains('disabled')) return;
    const two = this.scribe.state.pagesPerRow !== 2;
    const cover = this._pageLayoutSetting.endsWith('-cover');
    this._pageLayoutSetting = (two ? 'double' : 'single') + (cover ? '-cover' : '');
    this._writePageLayoutSetting();
    this._setPageLayout(two ? 2 : 1, cover);
  }

  /** Flip book pairing from the app menu's cover row and persist it. */
  _toggleCoverAlone() {
    const two = this.scribe.state.pagesPerRow === 2;
    const cover = !this._pageLayoutSetting.endsWith('-cover');
    this._pageLayoutSetting = (two ? 'double' : 'single') + (cover ? '-cover' : '');
    this._writePageLayoutSetting();
    if (two) this._setPageLayout(2, cover);
  }

  /**
   * Apply a page-layout change, refitting the zoom only while the user is still at the automatic fit.
   * A manual zoom survives the switch, with just the cursor's row kept in view.
   * @param {1|2} pagesPerRow
   * @param {boolean} coverAlone
   */
  _setPageLayout(pagesPerRow, coverAlone) {
    const s = this.scribe;
    const af = this._autoFit;
    const atAutoFit = !!(af && af.zoom > 0 && s.scrollContainer && s.zoomLevel > 0
      && Math.abs(s.zoomLevel - af.zoom) / af.zoom < 0.05);
    if (atAutoFit && this.doc) s.runSetInitial = true;
    s.setPagesPerRow(pagesPerRow, coverAlone);
    this._syncPageLayoutControls();
  }

  /** Reflect the current page layout in its controls. */
  _syncPageLayoutControls() {
    const two = this.scribe.state.pagesPerRow === 2;
    if (this._twoPageBtn) this._twoPageBtn.classList.toggle('active', two);
    if (this._coverToggleItem) this._coverToggleItem.style.display = two ? '' : 'none';
    this._syncPageNumDisplay();
    this._notifyMenuState();
  }

  /**
   * Fill the page box with the visible row's page range in two-page view, or with the cursor page otherwise.
   * A focused box is left alone, since focus swaps in the plain cursor number for editing.
   */
  _syncPageNumDisplay() {
    if (!this.pageNumElem) return;
    if (document.activeElement === this.pageNumElem) return;
    if (!this.doc) { this.pageNumElem.value = ''; return; }
    const s = this.scribe;
    const cp = s.state.cp.n;
    let text = (cp + 1).toString();
    if (s.state.pagesPerRow === 2) {
      const row = s.rowOfPage(cp);
      const pages = row === null ? [] : s.rowPages(row);
      if (pages.length > 1) text = `${pages[0] + 1}–${pages[pages.length - 1] + 1}`;
    }
    this.pageNumElem.value = text;
  }

  /**
   * Read the persisted theme setting.
   * Light is the default even when the OS prefers dark, since the document pages are never themed and dark bars would frame a white page.
   * @returns {'system' | 'light' | 'dark'} The stored theme, or 'light' when nothing is persisted.
   */
  // eslint-disable-next-line class-methods-use-this
  _readThemeSetting() {
    try {
      const v = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (v === 'system' || v === 'light' || v === 'dark') return v;
    } catch { /* localStorage unavailable (private mode / sandbox). Fall through to default. */ }
    return 'light';
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
    this._notifyMenuState();
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

  /** Toggle Dark mode, persisting the result as an explicit preference. */
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
      /* Language menu under the Recognize Text mode's language button. */
      .scribe-pdf-viewer .scribe-edit-menu {
        position: absolute; top: calc(100% + 6px); right: 0; min-width: 150px; z-index: 30;
        ${MENU_PLATE_CSS}
      }
      .scribe-pdf-viewer .scribe-edit-menu-item {
        position: relative; display: flex; align-items: center; padding: 4px 10px 4px 26px;
        border-radius: 4px; cursor: pointer; white-space: nowrap;
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
      /* The phone draws recognition progress on the companion strip's wind bar just above the dock, so the dock's own line stays hidden. */
      .scribe-pdf-viewer .scribe-dock .scribe-ocr-progress { display: none; }

      .scribe-pdf-viewer .scribe-dock-mode-status.scribe-recog-done { color: var(--scribe-ink-2); }

      /* Signs of life while a run has no page fraction to draw, on a single-page document or before the first page lands. */
      .scribe-pdf-viewer.scribe-recog-alive .scribe-dock-mode.scribe-mode-recognize .scribe-dock-mode-ic,
      .scribe-pdf-viewer.scribe-recog-alive .scribe-mode-banner.scribe-mode-recognize .scribe-mode-banner-ic { position: relative; }
      .scribe-pdf-viewer.scribe-recog-alive .scribe-dock-mode.scribe-mode-recognize .scribe-dock-mode-ic::after,
      .scribe-pdf-viewer.scribe-recog-alive .scribe-mode-banner.scribe-mode-recognize .scribe-mode-banner-ic::after {
        content: ''; position: absolute; left: 3px; right: 3px; top: 0; height: 2px; border-radius: 1px;
        background: var(--scribe-accent); opacity: .85;
        animation: scribe-recog-scan 1.6s ease-in-out infinite alternate;
      }
      @keyframes scribe-recog-scan { from { transform: translateY(3px); } to { transform: translateY(15px); } }
      .scribe-pdf-viewer.scribe-recog-alive .scribe-mode-banner-run.busy { position: relative; overflow: hidden; }
      .scribe-pdf-viewer.scribe-recog-alive .scribe-mode-banner-run.busy::after {
        content: ''; position: absolute; top: 0; bottom: 0; width: 42%; left: 0;
        background: linear-gradient(100deg, transparent, var(--scribe-accent-soft), transparent);
        animation: scribe-recog-sheen 1.8s ease-in-out infinite;
      }
      @keyframes scribe-recog-sheen { from { transform: translateX(-110%); } to { transform: translateX(340%); } }
      @media (prefers-reduced-motion: reduce) {
        .scribe-pdf-viewer.scribe-recog-alive .scribe-dock-mode.scribe-mode-recognize .scribe-dock-mode-ic::after,
        .scribe-pdf-viewer.scribe-recog-alive .scribe-mode-banner.scribe-mode-recognize .scribe-mode-banner-ic::after,
        .scribe-pdf-viewer.scribe-recog-alive .scribe-mode-banner-run.busy::after { content: none; }
      }

    `));
    document.head.appendChild(style);
  }

  /** Adds the required CSS styles to the document. Retained for backward compatibility. */
  static addIconButtonStyles = () => addControlStyles(ROOT_CLASS);
}

export {
  scribe, ScribeViewer, applyHighlight, ScribePDFViewer,
};
