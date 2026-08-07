// Full-screen library surface for the basic viewer: connect a folder, browse and search it, open documents into tabs, and keep edits flowing back into `.scribe` sidecars.
// Loaded by dynamic import behind the `library` option, so viewers without it never fetch this module or its styles.

import scribeLib from '../../scribe.js';
import { ZOOM_IN_SVG, ZOOM_OUT_SVG } from '../js/controls/toolbar.js';
import { openDocumentFromFile } from '../js/controls/tools.js';
import { findText, goToMatch } from '../js/viewerSearch.js';
import { REORDER_SLIDE_MS } from '../js/controls/pageReorder.js';
import { filesFromDropEvent } from '../js/dragAndDrop.js';
import { LibraryStore } from './libraryStore.js';
import { LibraryIndex } from './librarySearch.js';
import { LibraryIngest, PAGE_RASTER_WIDTH } from './libraryIngest.js';
import { DocSessions } from './docSession.js';

// Filled rather than stroked because outlined spines collapse into double-line mush at the pinned tab's 16px.
// eslint-disable-next-line max-len
const LIBRARY_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" style="pointer-events:none;display:block;width:100%;height:100%;" aria-hidden="true"><rect x="3" y="3.5" width="3.8" height="17" rx="0.9"/><rect x="8.8" y="3.5" width="3.8" height="17" rx="0.9"/><path d="M13.7 3.9 17.4 3.1 20.9 19.7 17.2 20.5Z"/></svg>';
// eslint-disable-next-line max-len
const FOLDER_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none;display:block;width:100%;height:100%;" aria-hidden="true"><path d="M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2.5h8a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z"/></svg>';
// eslint-disable-next-line max-len
const FILE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none;display:block;width:100%;height:100%;" aria-hidden="true"><path d="M6.5 3.5h7l5 5v11a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z"/><path d="M13.5 3.5v5h5"/></svg>';

// eslint-disable-next-line max-len
const FIELD_SEARCH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>';
const FIELD_CLEAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>';
// eslint-disable-next-line max-len
const SORT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 5v14M7 19l-3-3.2M7 19l3-3.2M17 19V5M17 5l-3 3.2M17 5l3 3.2"/></svg>';
// eslint-disable-next-line max-len
const CHEVRON_SVG = '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
const PLUS_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 6v12M6 12h12"/></svg>';
// eslint-disable-next-line max-len
const REFRESH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M17.3 3v3.7H13.6"/></svg>';
// eslint-disable-next-line max-len
const MENU_CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 12.5l4.3 4.3L18.5 7.5"/></svg>';
// eslint-disable-next-line max-len
const VIEW_GRID_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/></svg>';
// eslint-disable-next-line max-len
const VIEW_LIST_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4.5" width="6.5" height="6.5" rx="1"/><path d="M14 6h6M14 9h4"/><rect x="4" y="13" width="6.5" height="6.5" rx="1"/><path d="M14 14.5h6M14 17.5h4"/></svg>';
// eslint-disable-next-line max-len
const VIEW_COMPACT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16M4 9.7h16M4 14.3h16M4 19h16"/></svg>';
// eslint-disable-next-line max-len
const PREVIEW_PANEL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M13.5 4.5v15"/></svg>';

// Display names are always the file name, never PDF metadata.
// Info Titles in the wild are word-processor template paths, "untitled", and similar junk.
/** @param {string} relPath */
const titleOf = (relPath) => (relPath.split('/').pop() || relPath).replace(/\.pdf$/i, '');

// Card drag thresholds, matching the Pages-view gesture grammar so the two surfaces feel identical.
const DRAG_THRESHOLD = 5;
const LIFT_HOLD_MS = 250;
const LIFT_MOVE_SLOP = 9;
const MENU_SLOP = 8;
const GAP_HYSTERESIS = 12;
const AUTOSCROLL_EDGE = 36;
const AUTOSCROLL_SPEED = 14;

// ScribeDoc methods that mutate persisted state.
const MUTATOR_METHODS = [
  'addHighlights', 'addFreeText', 'addShapes', 'addTextAnnots', 'addRedactions', 'removeRedactions',
  'clearHighlights', 'clearShapes', 'clearTextAnnots', 'addLinks', 'removeLinks',
  'addBookmark', 'renameBookmark', 'setBookmarkDest', 'moveBookmark', 'removeBookmarks', 'replaceOutline',
  'deletePage', 'deletePages', 'movePage', 'movePages', 'copyPages', 'duplicatePages', 'insertPages', 'rotatePages',
  'deleteTextLines', 'replaceTextLine', 'setFormValue',
  'addInk', 'addStamp', 'addFillText', 'syncFillText',
  'undo', 'redo', 'recognize',
];

const PREVIEW_STORAGE_KEY = 'scribe-library-preview';
const VIEW_STORAGE_KEY = 'scribe-library-view';
const OTHERS_STORAGE_KEY = 'scribe-library-others';

const SORT_DEFAULT_DIR = {
  name: 1, added: -1, opened: -1, pages: 1, custom: 1,
};

const AUTOSAVE_INTERVAL_MS = 60000;
const RESULT_DOC_LIMIT = 20;
const RESULT_PAGES_PER_DOC = 4;
const SNIPPET_RADIUS = 70;
/**
 * Compressed-sidecar byte cap for background hit warming.
 * Importing a document restores its whole sidecar, so documents past this only get rasters from a preview or open the user asked for.
 */
const WARM_SIDECAR_LIMIT = 8 * 1024 * 1024;

let stylesInjected = false;
const addLibraryStyles = () => {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
.scribe-pdf-viewer .scribe-library-surface { position: absolute; left: 0; right: 0; bottom: 0; z-index: 30; background: var(--scribe-canvas); color: var(--scribe-ink); display: flex; flex-direction: column; overflow: hidden; font-size: 14px; }
.scribe-pdf-viewer .scribe-library-header { display: flex; align-items: center; gap: 8px; min-height: 44px; box-sizing: border-box; padding: 4px 14px 4px 18px; border-bottom: 1px solid var(--scribe-line); background: var(--scribe-surface); flex-wrap: wrap; }
.scribe-pdf-viewer .scribe-library-header h2 { font-size: 14px; font-weight: 600; margin: 0; }
.scribe-pdf-viewer .scribe-library-bar-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
.scribe-pdf-viewer .scribe-library-bar-controls { display: flex; align-items: center; gap: 8px; min-width: 0; }
/* Only the field yields under bar pressure, so the rungs below decide what else goes. */
.scribe-pdf-viewer .scribe-library-bar-controls > * { flex-shrink: 0; }
.scribe-pdf-viewer .scribe-library-bar-controls .scribe-library-field { flex: 0 1 196px; min-width: 106px; }
/* A grown flex-basis alone is invisible to the content-sized zone, which sizes the field to its own max-content, so the focus growth comes from a definite input width. */
.scribe-pdf-viewer .scribe-library-bar-controls .scribe-library-field:focus-within { flex: 1 1 320px; max-width: 320px; }
.scribe-pdf-viewer .scribe-library-bar-controls .scribe-library-search { width: 100%; min-width: 0; flex: 1; }
.scribe-pdf-viewer .scribe-library-bar-controls .scribe-library-field:focus-within .scribe-library-search { width: 290px; }
.scribe-pdf-viewer .scribe-library-field { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 8px; margin-left: auto; background: var(--scribe-sunken); border: 1px solid var(--scribe-line-strong); border-radius: 5px; box-sizing: border-box; }
.scribe-pdf-viewer .scribe-library-field:focus-within { border-color: var(--scribe-accent); }
.scribe-pdf-viewer .scribe-library-field > svg { width: 15px; height: 15px; color: var(--scribe-ink-3); flex-shrink: 0; }
.scribe-pdf-viewer .scribe-library-search { border: none; background: none; outline: none; color: var(--scribe-ink); font: inherit; font-size: 13px; width: 170px; padding: 0; caret-color: var(--scribe-accent); }
.scribe-pdf-viewer .scribe-library-search::placeholder { color: var(--scribe-ink-3); }
.scribe-pdf-viewer .scribe-library-hint { display: none; font-size: 11.5px; color: var(--scribe-ink-3); white-space: nowrap; }
.scribe-pdf-viewer .scribe-library-field:focus-within .scribe-library-hint { display: inline; }
.scribe-pdf-viewer .scribe-library-hint kbd { font-family: inherit; border: 1px solid var(--scribe-line-strong); border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; font-size: 10.5px; color: var(--scribe-ink-2); background: var(--scribe-surface); }
.scribe-pdf-viewer .scribe-library-bar-controls .scribe-library-field.hint-tight .scribe-library-hint { display: none; }
.scribe-pdf-viewer .scribe-library-clear { display: none; width: 17px; height: 17px; padding: 2px; border: none; background: none; color: var(--scribe-ink-3); cursor: pointer; border-radius: 4px; }
.scribe-pdf-viewer .scribe-library-field.has-text .scribe-library-clear { display: block; }
.scribe-pdf-viewer .scribe-library-clear:hover { color: var(--scribe-ink); background: var(--scribe-hover); }
.scribe-pdf-viewer .scribe-library-clear svg { width: 100%; height: 100%; display: block; }
.scribe-pdf-viewer .scribe-library-hbtn { display: inline-flex; align-items: center; gap: 7px; height: 28px; padding: 0 10px; border-radius: 7px; border: none; background: none; color: var(--scribe-ink-2); font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; }
.scribe-pdf-viewer .scribe-library-hbtn:hover { background: var(--scribe-hover); color: var(--scribe-ink); }
.scribe-pdf-viewer .scribe-library-hbtn svg { width: 17px; height: 17px; flex-shrink: 0; }
.scribe-pdf-viewer .scribe-library-hbtn svg.chev { width: 13px; height: 13px; margin-left: -2px; color: var(--scribe-ink-3); }
.scribe-pdf-viewer .scribe-library-sort-lbl { display: inline-grid; text-align: left; }
.scribe-pdf-viewer .scribe-library-sort-lbl > span { grid-area: 1 / 1; white-space: nowrap; }
.scribe-pdf-viewer .scribe-library-sort-lbl .ghost { visibility: hidden; }
.scribe-pdf-viewer .scribe-library-hicon { width: 28px; height: 28px; padding: 5px; border-radius: 7px; border: none; background: none; color: var(--scribe-ink-2); cursor: pointer; }
.scribe-pdf-viewer .scribe-library-hicon:hover { background: var(--scribe-hover); color: var(--scribe-ink); }
.scribe-pdf-viewer .scribe-library-hicon svg { width: 100%; height: 100%; display: block; }
.scribe-pdf-viewer .scribe-library-hicon.on { color: var(--scribe-accent); background: var(--scribe-active); }
.scribe-pdf-viewer .scribe-library-hicon:disabled { color: var(--scribe-ink-3); opacity: .45; cursor: default; }
.scribe-pdf-viewer .scribe-library-hicon:disabled:hover { background: none; color: var(--scribe-ink-3); }
.scribe-pdf-viewer .scribe-library-sort { position: relative; display: inline-flex; }
.scribe-pdf-viewer .scribe-library-menu { position: absolute; top: calc(100% + 6px); right: 0; z-index: 30; min-width: 178px; padding: 5px; background: var(--scribe-surface); border: 1px solid var(--scribe-line); border-radius: 10px; box-shadow: var(--scribe-menu-shadow); }
.scribe-pdf-viewer .scribe-library-menu-item { display: flex; align-items: center; gap: 10px; padding: 7px 11px; border-radius: 6px; font-size: 13px; color: var(--scribe-ink); cursor: pointer; white-space: nowrap; user-select: none; }
.scribe-pdf-viewer .scribe-library-menu-item:hover { background: var(--scribe-hover); }
.scribe-pdf-viewer .scribe-library-menu-item svg { width: 15px; height: 15px; color: var(--scribe-accent); visibility: hidden; flex-shrink: 0; }
.scribe-pdf-viewer .scribe-library-menu-item.on svg { visibility: visible; }
.scribe-pdf-viewer .scribe-library-menu-sep { height: 1px; background: var(--scribe-line); margin: 4px 6px; }
.scribe-pdf-viewer .scribe-library-seg { display: inline-flex; height: 28px; border: 1px solid var(--scribe-line-strong); border-radius: 7px; overflow: hidden; background: var(--scribe-sunken); }
.scribe-pdf-viewer .scribe-library-seg button { width: 32px; border: none; background: none; color: var(--scribe-ink-3); padding: 5px 0; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
.scribe-pdf-viewer .scribe-library-seg button svg { width: 16px; height: 16px; }
.scribe-pdf-viewer .scribe-library-seg button:hover { color: var(--scribe-ink); }
.scribe-pdf-viewer .scribe-library-seg button.on { background: var(--scribe-surface); color: var(--scribe-accent); box-shadow: inset 0 0 0 1px var(--scribe-line-strong); }
.scribe-pdf-viewer .scribe-library-btn { padding: 6px 12px; border-radius: 6px; border: 1px solid color-mix(in srgb, var(--scribe-ink) 25%, transparent); background: var(--scribe-surface); color: var(--scribe-ink); cursor: pointer; font-size: 13px; }
.scribe-pdf-viewer .scribe-library-btn:hover { background: color-mix(in srgb, var(--scribe-ink) 8%, var(--scribe-surface)); }
.scribe-pdf-viewer .scribe-library-btn.primary { background: var(--scribe-accent); border-color: var(--scribe-accent); color: #fff; }
.scribe-pdf-viewer .scribe-library-progress { display: none; align-items: center; gap: 10px; padding: 8px 18px; font-size: 13px; background: color-mix(in srgb, var(--scribe-accent) 12%, var(--scribe-surface)); border-bottom: 1px solid color-mix(in srgb, var(--scribe-ink) 12%, transparent); }
.scribe-pdf-viewer .scribe-library-body { flex: 1; overflow-y: auto; padding: 16px 18px; }
.scribe-pdf-viewer .scribe-library-section-label { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.6; margin: 4px 0 10px; }
.scribe-pdf-viewer .scribe-library-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 14px; margin-bottom: 22px; position: relative; }
.scribe-pdf-viewer .scribe-library-card { border: 1px solid color-mix(in srgb, var(--scribe-ink) 14%, transparent); border-radius: 8px; background: var(--scribe-surface); cursor: pointer; overflow: hidden; display: flex; flex-direction: column; position: relative; touch-action: pan-y; user-select: none; }
.scribe-pdf-viewer .scribe-library-card.dragging { opacity: 0.35; }
.scribe-library-ghost { position: fixed; z-index: 100; pointer-events: none; transform: scale(1.03); box-shadow: 0 12px 28px rgba(0, 0, 0, 0.35); border-radius: 8px; overflow: hidden; font-size: 14px; color: var(--scribe-ink); }
.scribe-pdf-viewer .scribe-library-insert-line { position: absolute; width: 3px; border-radius: 2px; background: var(--scribe-accent); z-index: 5; pointer-events: none; }
.scribe-pdf-viewer .scribe-library-card:hover, .scribe-pdf-viewer .scribe-library-card:focus-visible { border-color: var(--scribe-accent); outline: none; }
.scribe-pdf-viewer .scribe-library-card.selected { border-color: var(--scribe-accent); box-shadow: 0 0 0 1px var(--scribe-accent); background: color-mix(in srgb, var(--scribe-accent) 7%, var(--scribe-surface)); }
.scribe-pdf-viewer .scribe-library-card.context { border-color: var(--scribe-accent); }
.scribe-pdf-viewer .scribe-library-card .thumb { width: 100%; aspect-ratio: 3 / 4; object-fit: contain; background: color-mix(in srgb, var(--scribe-ink) 5%, var(--scribe-canvas)); display: block; }
.scribe-pdf-viewer .scribe-library-card .body { padding: 8px 10px; }
.scribe-pdf-viewer .scribe-library-card .title { font-weight: 600; font-size: 13px; line-height: 1.3; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-word; }
.scribe-pdf-viewer .scribe-library-card .meta { font-size: 12px; opacity: 0.65; margin-top: 3px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.scribe-pdf-viewer .scribe-library-badge { font-size: 11px; padding: 1px 6px; border-radius: 8px; background: color-mix(in srgb, var(--scribe-ink) 12%, transparent); }
.scribe-pdf-viewer .scribe-library-badge.warn { background: #c77d0a; color: #fff; }
.scribe-pdf-viewer .scribe-library-badge.error { background: #b3372f; color: #fff; }
.scribe-pdf-viewer .scribe-library-card .actions { position: absolute; top: 6px; right: 6px; display: none; gap: 4px; }
.scribe-pdf-viewer .scribe-library-card:hover .actions, .scribe-pdf-viewer .scribe-library-card:focus-within .actions { display: flex; }
.scribe-pdf-viewer .scribe-library-card .actions button { border: none; border-radius: 5px; background: rgba(20, 20, 20, 0.65); color: #fff; cursor: pointer; font-size: 12px; padding: 3px 7px; }
.scribe-pdf-viewer .scribe-library-body.list-mode { padding: 0; }
.scribe-pdf-viewer .scribe-library-lhead { position: sticky; top: 0; z-index: 2; display: grid; grid-template-columns: minmax(240px, 1fr) 70px 110px 110px 120px; align-items: center; height: 30px; padding: 0 18px; border-bottom: 1px solid var(--scribe-line); background: var(--scribe-surface); color: var(--scribe-ink-2); font-size: 12px; font-weight: 600; user-select: none; }
.scribe-pdf-viewer .scribe-library-lhead.cols-cf { grid-template-columns: minmax(260px, 1fr) 90px 130px 130px; }
.scribe-pdf-viewer .scribe-library-hc { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; border-radius: 4px; padding: 2px 6px; margin-left: -6px; }
.scribe-pdf-viewer .scribe-library-hc:hover { background: var(--scribe-hover); color: var(--scribe-ink); }
.scribe-pdf-viewer .scribe-library-hc .ar { font-size: 10px; visibility: hidden; }
.scribe-pdf-viewer .scribe-library-hc.on { color: var(--scribe-ink); }
.scribe-pdf-viewer .scribe-library-hc.on .ar { visibility: visible; }
.scribe-pdf-viewer .scribe-library-row { display: grid; grid-template-columns: minmax(240px, 1fr) 70px 110px 110px 120px; align-items: center; height: 34px; padding: 0 18px; cursor: pointer; border-bottom: 1px solid color-mix(in srgb, var(--scribe-line) 55%, transparent); font-size: 13px; user-select: none; touch-action: pan-y; }
.scribe-pdf-viewer .scribe-library-row:hover { background: var(--scribe-hover); }
.scribe-pdf-viewer .scribe-library-row.selected { background: var(--scribe-active); box-shadow: inset 2px 0 0 var(--scribe-accent); }
.scribe-pdf-viewer .scribe-library-row.context { outline: 1px solid var(--scribe-accent); outline-offset: -1px; }
.scribe-pdf-viewer .scribe-library-row:focus-visible { outline: 2px solid var(--scribe-accent); outline-offset: -2px; }
.scribe-pdf-viewer .scribe-library-row .nm { display: flex; align-items: center; gap: 10px; min-width: 0; }
.scribe-pdf-viewer .scribe-library-row .nm .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 550; }
.scribe-pdf-viewer .scribe-library-row.cf { grid-template-columns: minmax(260px, 1fr) 90px 130px 130px; height: 64px; }
.scribe-pdf-viewer .scribe-library-row.cf .nm { gap: 12px; }
.scribe-pdf-viewer .scribe-library-row.cf .nm img { width: 40px; height: 52px; object-fit: cover; object-position: top; border: 1px solid var(--scribe-line); border-radius: 3px; background: #fff; flex-shrink: 0; }
.scribe-pdf-viewer .scribe-library-row.cf .nm .tt { min-width: 0; }
.scribe-pdf-viewer .scribe-library-row.cf .nm .t { font-weight: 600; }
.scribe-pdf-viewer .scribe-library-row.cf .nm .m2 { font-size: 12px; color: var(--scribe-ink-3); margin-top: 2px; display: flex; gap: 6px; align-items: center; }
.scribe-pdf-viewer .scribe-library-row .num { font-variant-numeric: tabular-nums; color: var(--scribe-ink-2); }
.scribe-pdf-viewer .scribe-library-row .dt { font-variant-numeric: tabular-nums; color: var(--scribe-ink-2); font-size: 12.5px; }
.scribe-pdf-viewer .scribe-library-row .none { color: var(--scribe-ink-3); }
.scribe-pdf-viewer .scribe-library-empty { text-align: center; opacity: 0.7; padding: 60px 20px; }
.scribe-pdf-viewer .scribe-library-card-wall { max-width: 520px; margin: 60px auto; text-align: center; border: 1px solid color-mix(in srgb, var(--scribe-ink) 14%, transparent); border-radius: 10px; background: var(--scribe-surface); padding: 36px 32px; }
.scribe-pdf-viewer .scribe-library-card-wall h3 { margin: 0 0 10px; font-size: 17px; }
.scribe-pdf-viewer .scribe-library-card-wall p { margin: 0 0 20px; opacity: 0.75; line-height: 1.5; }
.scribe-pdf-viewer .scribe-library-body.results-mode, .scribe-pdf-viewer .scribe-library-body.split-mode { padding: 0; overflow: hidden; display: flex; }
.scribe-pdf-viewer .scribe-library-body.split-mode .scribe-library-rlist { container-type: inline-size; }
@container (max-width: 685px) {
  .scribe-pdf-viewer .scribe-library-lhead, .scribe-pdf-viewer .scribe-library-lhead.cols-cf, .scribe-pdf-viewer .scribe-library-row, .scribe-pdf-viewer .scribe-library-row.cf { grid-template-columns: minmax(120px, 1fr) 70px; }
  .scribe-pdf-viewer .scribe-library-lhead > :nth-child(n+3), .scribe-pdf-viewer .scribe-library-row > :nth-child(n+3) { display: none; }
}
.scribe-pdf-viewer .scribe-library-results { flex: 1; display: flex; min-height: 0; min-width: 0; font-size: 13px; }
.scribe-pdf-viewer .scribe-library-rlist { width: clamp(280px, var(--scribe-library-rlist-w, 400px), calc(100% - 320px)); box-sizing: border-box; flex-shrink: 0; overflow-y: auto; border-right: 1px solid var(--scribe-line); background: var(--scribe-surface); outline: none; }
.scribe-pdf-viewer .scribe-library-rsplit { flex: 0 0 7px; margin: 0 -3px; position: relative; z-index: 4; cursor: col-resize; touch-action: none; }
.scribe-pdf-viewer .scribe-library-rsplit::before { content: ''; position: absolute; left: 2px; top: 0; bottom: 0; width: 3px; background: var(--scribe-accent); opacity: 0; transition: opacity 0.08s; }
.scribe-pdf-viewer .scribe-library-rsplit:hover::before { opacity: 1; transition-delay: 0.25s; }
.scribe-pdf-viewer .scribe-library-rsplit.drag::before { opacity: 1; transition-delay: 0s; }
.scribe-pdf-viewer .scribe-library-results.rsplit-drag { user-select: none; }
.scribe-pdf-viewer .scribe-library-results.rsplit-drag * { cursor: col-resize !important; }
.scribe-pdf-viewer .scribe-library-rsummary { display: flex; align-items: baseline; gap: 10px; padding: 12px 16px 8px; white-space: nowrap; }
.scribe-pdf-viewer .scribe-library-rsummary .n { font-weight: 600; }
.scribe-pdf-viewer .scribe-library-back { margin-left: auto; border: none; background: none; padding: 0; font: inherit; font-size: 12.5px; color: var(--scribe-accent); cursor: pointer; white-space: nowrap; }
.scribe-pdf-viewer .scribe-library-rdoc { padding: 10px 16px 4px; font-weight: 600; }
.scribe-pdf-viewer .scribe-library-rdoc .m { font-weight: 400; color: var(--scribe-ink-3); font-size: 12px; white-space: nowrap; }
.scribe-pdf-viewer .scribe-library-hit { display: flex; gap: 11px; padding: 7px 16px 7px 22px; cursor: pointer; align-items: flex-start; }
.scribe-pdf-viewer .scribe-library-hit:hover { background: var(--scribe-hover); }
.scribe-pdf-viewer .scribe-library-hit.on { background: var(--scribe-active); box-shadow: inset 2px 0 0 var(--scribe-accent); }
.scribe-pdf-viewer .scribe-library-hit .ph { width: 56px; flex-shrink: 0; position: relative; background: color-mix(in srgb, var(--scribe-ink) 5%, var(--scribe-canvas)); box-shadow: var(--scribe-page-shadow); min-height: 73px; }
.scribe-pdf-viewer .scribe-library-hit .ph img { display: block; width: 100%; height: auto; }
.scribe-pdf-viewer .scribe-library-hit .hm { min-width: 0; }
.scribe-pdf-viewer .scribe-library-hit .ht { font-weight: 600; }
.scribe-pdf-viewer .scribe-library-hit .ht .m { font-weight: 400; color: var(--scribe-ink-3); font-size: 12px; }
.scribe-pdf-viewer .scribe-library-hit .sn { display: block; color: var(--scribe-ink-2); line-height: 1.45; margin-top: 1px; }
.scribe-pdf-viewer .scribe-library-hit .sn b { font-weight: 600; color: var(--scribe-ink); background: #4278f550; border-radius: 2px; padding: 0 1px; }
.scribe-pdf-viewer .scribe-library-rmore { display: block; border: none; background: none; padding: 4px 16px 6px 89px; font: inherit; font-size: 12.5px; color: var(--scribe-accent); cursor: pointer; }
.scribe-pdf-viewer .scribe-library-rmore:hover { text-decoration: underline; }
.scribe-pdf-viewer .scribe-mark { position: absolute; background: #4278f550; }
.scribe-pdf-viewer .scribe-mark.act { background: #ff990088; }
.scribe-pdf-viewer .scribe-library-pv { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.scribe-pdf-viewer .scribe-library-pv-head { display: flex; align-items: center; gap: 10px; height: 40px; flex-shrink: 0; box-sizing: border-box; padding: 0 12px; background: var(--scribe-surface); border-bottom: 1px solid var(--scribe-line); }
.scribe-pdf-viewer .scribe-library-pv-head .t { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.scribe-pdf-viewer .scribe-library-pv-head .m { color: var(--scribe-ink-3); white-space: nowrap; }
.scribe-pdf-viewer .scribe-library-pv-head .grow { flex: 1; }
.scribe-pdf-viewer .scribe-library-pv-open { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: 7px; border: none; background: none; color: var(--scribe-ink-2); font: inherit; font-size: 12.5px; cursor: pointer; white-space: nowrap; }
.scribe-pdf-viewer .scribe-library-pv-open:hover { background: var(--scribe-hover); color: var(--scribe-ink); }
.scribe-pdf-viewer .scribe-library-pv-open svg { width: 14px; height: 14px; }
.scribe-pdf-viewer .scribe-library-pv-x { width: 26px; height: 26px; flex-shrink: 0; padding: 5px; border-radius: 7px; border: none; background: none; color: var(--scribe-ink-3); cursor: pointer; }
.scribe-pdf-viewer .scribe-library-pv-x:hover { background: var(--scribe-hover); color: var(--scribe-ink); }
.scribe-pdf-viewer .scribe-library-pv-x svg { width: 100%; height: 100%; display: block; }
.scribe-pdf-viewer .scribe-library-pv-zoom { width: 26px; height: 26px; flex-shrink: 0; padding: 5px; border-radius: 7px; border: none; background: none; color: var(--scribe-ink-2); cursor: pointer; }
.scribe-pdf-viewer .scribe-library-pv-zoom:hover { background: var(--scribe-hover); color: var(--scribe-ink); }
.scribe-pdf-viewer .scribe-library-pv-zoom svg { width: 100%; height: 100%; display: block; }
.scribe-pdf-viewer .scribe-library-pv-find { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 7px; background: var(--scribe-sunken); border: 1px solid var(--scribe-line-strong); border-radius: 5px; box-sizing: border-box; flex: 0 1 auto; min-width: 70px; }
.scribe-pdf-viewer .scribe-library-pv-find:focus-within { border-color: var(--scribe-accent); }
.scribe-pdf-viewer .scribe-library-pv-find > svg { width: 13px; height: 13px; color: var(--scribe-ink-3); flex-shrink: 0; }
.scribe-pdf-viewer .scribe-library-pv-find input { border: none; background: none; outline: none; color: var(--scribe-ink); font: inherit; font-size: 12.5px; width: 96px; min-width: 0; padding: 0; caret-color: var(--scribe-accent); }
.scribe-pdf-viewer .scribe-library-pv-find input::placeholder { color: var(--scribe-ink-3); }
.scribe-pdf-viewer .scribe-library-pv-stage { flex: 1; overflow: hidden; display: flex; position: relative; }
.scribe-pdf-viewer .scribe-library-pv-viewer { flex: 1; min-width: 0; min-height: 0; position: relative; }
.scribe-pdf-viewer .scribe-library-pv-veil { position: absolute; inset: 0; z-index: 5; background-color: var(--scribe-canvas); background-size: 100% 100%; transition: opacity 0.15s; pointer-events: none; }
.scribe-pdf-viewer .scribe-library-pv-empty { color: var(--scribe-ink-3); font-size: 13px; margin: auto; }
.scribe-pdf-viewer .scribe-library-pv-foot { display: flex; align-items: center; gap: 8px; height: 34px; flex-shrink: 0; box-sizing: border-box; padding: 0 12px; background: var(--scribe-surface); border-top: 1px solid var(--scribe-line); font-size: 12.5px; color: var(--scribe-ink-2); }
.scribe-pdf-viewer .scribe-library-pv-foot button { border: none; background: none; color: var(--scribe-ink-2); font: inherit; font-size: 12.5px; cursor: pointer; border-radius: 6px; padding: 3px 8px; }
.scribe-pdf-viewer .scribe-library-pv-foot button:hover { background: var(--scribe-hover); color: var(--scribe-ink); }
.scribe-pdf-viewer .scribe-library-pv-foot .grow { flex: 1; }
.scribe-pdf-viewer .scribe-library-surface.drag-over { outline: 2px dashed var(--scribe-accent); outline-offset: -8px; }
.scribe-pdf-viewer .scribe-library-crumbs { display: flex; align-items: center; gap: 1px; font-size: 14px; font-weight: 600; min-width: 0; white-space: nowrap; }
.scribe-pdf-viewer .scribe-library-crumb { border: none; background: none; padding: 3px 7px; border-radius: 6px; font: inherit; color: var(--scribe-ink-2); cursor: pointer; }
.scribe-pdf-viewer .scribe-library-crumb:first-child { margin-left: -7px; }
.scribe-pdf-viewer .scribe-library-crumb:hover { background: var(--scribe-hover); color: var(--scribe-ink); }
.scribe-pdf-viewer .scribe-library-crumb.drop { background: color-mix(in srgb, var(--scribe-accent) 16%, var(--scribe-surface)); box-shadow: inset 0 0 0 1.5px var(--scribe-accent); color: var(--scribe-ink); }
.scribe-pdf-viewer .scribe-library-crumbs .sep { color: var(--scribe-ink-3); font-weight: 400; padding: 0 2px; }
.scribe-pdf-viewer .scribe-library-crumbs .cur { overflow: hidden; text-overflow: ellipsis; }
.scribe-pdf-viewer .scribe-library-card.folder .fstrip { display: flex; gap: 6px; padding: 10px; background: color-mix(in srgb, var(--scribe-ink) 5%, var(--scribe-canvas)); position: relative; }
.scribe-pdf-viewer .scribe-library-card.folder .fstrip img { width: 52px; height: 69px; object-fit: cover; object-position: top; background: #fff; border: 1px solid var(--scribe-line-strong); box-sizing: border-box; display: block; }
.scribe-pdf-viewer .scribe-library-card.folder .fstrip .empty { height: 69px; display: flex; align-items: center; color: var(--scribe-ink-3); }
.scribe-pdf-viewer .scribe-library-card.folder .fstrip .empty .fi { width: 26px; height: 26px; }
.scribe-pdf-viewer .scribe-library-card.folder.drop .fstrip::after { content: ''; position: absolute; inset: 0; background: color-mix(in srgb, var(--scribe-accent) 26%, transparent); pointer-events: none; }
.scribe-pdf-viewer .scribe-library-card.folder .title .fi { display: inline-block; width: 15px; height: 15px; vertical-align: -3px; margin-right: 5px; color: var(--scribe-ink-2); }
.scribe-pdf-viewer .scribe-library-card.folder .meta.hasatt { opacity: 1; color: var(--scribe-ink-3); }
.scribe-pdf-viewer .scribe-library-card.folder .meta .att, .scribe-pdf-viewer .scribe-library-row.folder .att { color: var(--scribe-ink-2); font-weight: 600; }
.scribe-pdf-viewer .scribe-library-card.folder .meta .att.bad, .scribe-pdf-viewer .scribe-library-row.folder .att.bad { color: var(--scribe-danger); }
.scribe-pdf-viewer .scribe-library-row.folder .roll { color: var(--scribe-ink-3); font-variant-numeric: tabular-nums; font-size: 12.5px; }
.scribe-pdf-viewer .scribe-library-row.folder .roll.pg { font-size: 13px; }
.scribe-pdf-viewer .scribe-library-row.folder .cnt { display: inline-flex; align-items: baseline; gap: 5px; color: var(--scribe-ink-3); font-size: 12.5px; flex-shrink: 0; }
.scribe-pdf-viewer .scribe-library-row .fi { width: 18px; height: 18px; color: var(--scribe-ink-2); flex-shrink: 0; }
.scribe-pdf-viewer .scribe-library-row.cf .fthumb { width: 40px; height: 52px; display: flex; align-items: center; justify-content: center; color: var(--scribe-ink-2); flex-shrink: 0; }
.scribe-pdf-viewer .scribe-library-row.cf .fthumb .fi { width: 26px; height: 26px; }
.scribe-pdf-viewer .scribe-library-card.folder.drop { background: color-mix(in srgb, var(--scribe-accent) 14%, var(--scribe-surface)); border-color: var(--scribe-accent); box-shadow: inset 0 0 0 1px var(--scribe-accent); }
.scribe-pdf-viewer .scribe-library-row.folder.drop { background: color-mix(in srgb, var(--scribe-accent) 14%, var(--scribe-surface)); box-shadow: inset 0 0 0 2px var(--scribe-accent); }
.scribe-pdf-viewer .scribe-library-card.other { cursor: default; opacity: .55; }
.scribe-pdf-viewer .scribe-library-card.other:hover { border-color: color-mix(in srgb, var(--scribe-ink) 14%, transparent); }
.scribe-pdf-viewer .scribe-library-card.other .fthumb { aspect-ratio: 3 / 4; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--scribe-ink) 5%, var(--scribe-canvas)); color: var(--scribe-ink-3); }
.scribe-pdf-viewer .scribe-library-card.other .fthumb .fi { width: 46px; height: 46px; }
.scribe-pdf-viewer .scribe-library-row.other { cursor: default; opacity: .55; }
.scribe-pdf-viewer .scribe-library-row.other:hover { background: none; }
/* Keep these rungs last in the stylesheet, since a base rule declared later out-cascades one at equal specificity. */
.scribe-pdf-viewer .scribe-library-bar { container: scribe-bar / inline-size; }
@container scribe-bar (max-width: 820px) {
  .scribe-pdf-viewer .scribe-library-sort-lbl { display: none; }
}
@container scribe-bar (max-width: 730px) {
  .scribe-pdf-viewer .scribe-library-add-lbl { display: none; }
}
@container scribe-bar (max-width: 560px) {
  .scribe-pdf-viewer .scribe-library-bar-controls { gap: 5px; }
  .scribe-pdf-viewer .scribe-library-bar-controls .vertical-separator { display: none; }
  .scribe-pdf-viewer .scribe-library-bar-controls .scribe-library-field { min-width: 84px; }
  .scribe-pdf-viewer .scribe-library-bar-controls .scribe-library-field > svg { display: none; }
  .scribe-pdf-viewer .scribe-library-bar-controls .scribe-library-seg button { width: 26px; }
  .scribe-pdf-viewer .scribe-library-bar-controls .scribe-library-hbtn { padding: 0 7px; }
}
`;
  document.head.appendChild(style);
};

/**
 * Install the document-library feature on a ScribePDFViewer instance.
 * @param {import('../basic-viewer/pdf-viewer.js').ScribePDFViewer} viewer
 * @returns {{destroy: () => void}}
 */
export function installLibrary(viewer) {
  addLibraryStyles();

  /** @type {?LibraryStore} */
  let store = null;
  /** @type {?import('./libraryStore.js').LibraryManifest} */
  let manifest = null;
  /** @type {LibraryIndex} */
  let index = new LibraryIndex();
  /** @type {?LibraryIngest} */
  let ingest = null;
  let visible = false;
  let sortMode = 'name';
  /** 1 or -1, relative to each key's ascending order. */
  let sortDir = 1;
  /** @type {'grid' | 'list' | 'compact'} */
  let viewMode = 'grid';
  try {
    const storedView = window.localStorage.getItem(VIEW_STORAGE_KEY);
    if (storedView === 'list' || storedView === 'compact') viewMode = storedView;
  } catch { /* localStorage unavailable. */ }
  /** Whether the browse views also list the folder's non-PDF files. */
  let showOthers = false;
  try {
    showOthers = window.localStorage.getItem(OTHERS_STORAGE_KEY) === '1';
  } catch { /* localStorage unavailable. */ }
  let filterText = '';
  /** Directory shown while browsing, relative to the library root; '' is the root itself. */
  let currentDir = '';
  /** @type {?Array<{hash: string, pages: number[]}>} Full-text results, or null for the browse grid. */
  let fullTextResults = null;
  let fullTextQuery = '';
  let resultsListWidth = 400;
  /** Split width while a list view hosts the preview pane. */
  let listPreviewWidth = 700;
  let listPreviewOn = false;
  try {
    listPreviewOn = window.localStorage.getItem(PREVIEW_STORAGE_KEY) === '1';
  } catch { /* localStorage unavailable. */ }
  /** @type {?string} Doc shown in the list-view preview pane. */
  let listPreviewPath = null;
  let listPreviewPage = 0;
  const sessions = new DocSessions();
  /** @type {?number} */
  let manifestTimer = null;
  /** @type {?number} */
  let indexTimer = null;
  let destroyed = false;
  /** @type {?Object} In-flight card drag. */
  let dragState = null;
  /** Render requested while a drag held the grid frozen; replayed when the drag ends. */
  let renderPending = false;
  /** Relative paths in the main grid's current display order (the drag's reorder base). */
  let gridPaths = [];
  /** @type {?HTMLElement} */
  let mainGridElem = null;
  /** Clicks are ignored until this time right after a drag, so the drop doesn't open a card. */
  let suppressClickUntil = 0;
  /** When the last touch drag ended, so the native long-press contextmenu racing it is swallowed. */
  let lastTouchDragT = 0;
  /** @type {Set<string>} Selected cards, keyed by manifest path so a doc's Recent-strip duplicate highlights too. */
  const selectedPaths = new Set();
  /** @type {?string} Pivot card for Shift ranges. */
  let selAnchor = null;

  // --- DOM scaffold -------------------------------------------------------

  const surface = document.createElement('div');
  surface.className = 'scribe-library-surface';
  surface.style.display = 'none';

  const header = document.createElement('div');
  header.className = 'scribe-library-header';
  const crumbsElem = document.createElement('div');
  crumbsElem.className = 'scribe-library-crumbs';
  crumbsElem.textContent = 'Library';
  header.appendChild(crumbsElem);

  const searchField = document.createElement('span');
  searchField.className = 'scribe-library-field';
  searchField.innerHTML = FIELD_SEARCH_SVG;
  const searchInput = document.createElement('input');
  searchInput.className = 'scribe-library-search';
  searchInput.type = 'text';
  searchInput.placeholder = 'Filter';
  searchInput.setAttribute('aria-label', 'Filter documents');
  searchField.appendChild(searchInput);
  const searchHint = document.createElement('span');
  searchHint.className = 'scribe-library-hint';
  searchHint.innerHTML = '<kbd>↵</kbd> search contents';
  searchField.appendChild(searchHint);
  const clearBtn = document.createElement('button');
  clearBtn.className = 'scribe-library-clear';
  clearBtn.setAttribute('aria-label', 'Clear filter');
  clearBtn.innerHTML = FIELD_CLEAR_SVG;
  searchField.appendChild(clearBtn);
  header.appendChild(searchField);
  // A container query here would zero the field's contribution to the content-sized bar zone and pin it at its minimum width, so the signal comes from a resize observer.
  const hintObserver = new ResizeObserver((entries) => {
    searchField.classList.toggle('hint-tight', entries[0].contentRect.width < 250);
  });
  hintObserver.observe(searchField);

  const viewSeg = document.createElement('span');
  viewSeg.className = 'scribe-library-seg';
  viewSeg.setAttribute('role', 'group');
  viewSeg.setAttribute('aria-label', 'View');
  const gridViewBtn = document.createElement('button');
  gridViewBtn.innerHTML = VIEW_GRID_SVG;
  gridViewBtn.title = 'Grid';
  gridViewBtn.setAttribute('aria-label', 'Grid view');
  const listViewBtn = document.createElement('button');
  listViewBtn.innerHTML = VIEW_LIST_SVG;
  listViewBtn.title = 'List';
  listViewBtn.setAttribute('aria-label', 'List view');
  const compactViewBtn = document.createElement('button');
  compactViewBtn.innerHTML = VIEW_COMPACT_SVG;
  compactViewBtn.title = 'Compact';
  compactViewBtn.setAttribute('aria-label', 'Compact list view');
  viewSeg.appendChild(gridViewBtn);
  viewSeg.appendChild(listViewBtn);
  viewSeg.appendChild(compactViewBtn);
  header.appendChild(viewSeg);

  const sortWrap = document.createElement('span');
  sortWrap.className = 'scribe-library-sort';
  const sortBtn = document.createElement('button');
  sortBtn.className = 'scribe-library-hbtn';
  // Every mode's label is stacked invisibly under the current one, so the button keeps the widest label's footprint and the bar never shifts when the sort mode changes.
  sortBtn.innerHTML = `${SORT_SVG}<span class="scribe-library-sort-lbl"><span class="cur">Name</span>`
    + '<span class="ghost" aria-hidden="true">Name</span><span class="ghost" aria-hidden="true">Date added</span>'
    + '<span class="ghost" aria-hidden="true">Last opened</span><span class="ghost" aria-hidden="true">Pages</span>'
    + `<span class="ghost" aria-hidden="true">Custom</span></span>${CHEVRON_SVG}`;
  sortBtn.title = 'Sort';
  sortBtn.setAttribute('aria-label', 'Sort');
  sortBtn.setAttribute('aria-haspopup', 'menu');
  const sortLabelElem = /** @type {HTMLElement} */ (sortBtn.querySelector('.cur'));
  const sortMenu = document.createElement('div');
  sortMenu.className = 'scribe-library-menu';
  sortMenu.setAttribute('role', 'menu');
  sortMenu.style.display = 'none';
  /** @type {HTMLElement[]} */
  const sortItems = [];
  for (const [mode, label] of [['name', 'Name'], ['added', 'Date added'], ['opened', 'Last opened'], ['custom', 'Custom']]) {
    const item = document.createElement('div');
    item.className = 'scribe-library-menu-item';
    item.setAttribute('role', 'menuitemradio');
    item.dataset.mode = mode;
    item.innerHTML = `${MENU_CHECK_SVG}${label}`;
    sortMenu.appendChild(item);
    sortItems.push(item);
  }
  const sortMenuSep = document.createElement('div');
  sortMenuSep.className = 'scribe-library-menu-sep';
  sortMenu.appendChild(sortMenuSep);
  const othersItem = document.createElement('div');
  othersItem.className = 'scribe-library-menu-item';
  othersItem.setAttribute('role', 'menuitemcheckbox');
  othersItem.innerHTML = `${MENU_CHECK_SVG}Show other files`;
  sortMenu.appendChild(othersItem);
  sortWrap.appendChild(sortBtn);
  sortWrap.appendChild(sortMenu);
  header.appendChild(sortWrap);

  const previewBtn = document.createElement('button');
  previewBtn.className = 'scribe-library-hicon';
  previewBtn.innerHTML = PREVIEW_PANEL_SVG;
  previewBtn.title = 'Preview panel';
  previewBtn.setAttribute('aria-label', 'Preview panel');
  header.appendChild(previewBtn);

  const headerSep = document.createElement('span');
  headerSep.className = 'vertical-separator';
  header.appendChild(headerSep);

  const addBtn = document.createElement('button');
  addBtn.className = 'scribe-library-hbtn';
  // The label is a span so the bar's shed rules can hide it on a tight bar.
  addBtn.innerHTML = `${PLUS_SVG}<span class="scribe-library-add-lbl">Add PDFs</span>`;
  addBtn.title = 'Add PDFs';
  addBtn.setAttribute('aria-label', 'Add PDFs');
  header.appendChild(addBtn);

  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'scribe-library-hicon';
  refreshBtn.innerHTML = REFRESH_SVG;
  refreshBtn.title = 'Re-scan the library folder for new, changed, or removed files';
  refreshBtn.setAttribute('aria-label', 'Refresh folder');
  header.appendChild(refreshBtn);

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.accept = 'application/pdf,.pdf';
  fileInput.style.display = 'none';
  header.appendChild(fileInput);

  const progressElem = document.createElement('div');
  progressElem.className = 'scribe-library-progress';
  const progressText = document.createElement('span');
  progressElem.appendChild(progressText);
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'scribe-library-btn';
  cancelBtn.textContent = 'Cancel';
  progressElem.appendChild(cancelBtn);

  const body = document.createElement('div');
  body.className = 'scribe-library-body';

  // With a toolbar present the library takes over that bar, so the header's controls are re-parented into it rather than stacking a second bar.
  /** @type {?HTMLElement} */
  let barTitle = null;
  /** @type {?HTMLElement} */
  let barControls = null;
  if (viewer.toolbarElem) {
    barTitle = document.createElement('span');
    barTitle.className = 'scribe-library-bar-title';
    barTitle.style.display = 'none';
    const barSep = document.createElement('span');
    barSep.className = 'vertical-separator';
    barTitle.appendChild(barSep);
    barTitle.appendChild(crumbsElem);
    // Placed after the app menu so the zone's last child stays visible, which is what the bar's overflow measurement reads.
    viewer.toolbarElemStart.insertBefore(barTitle, viewer._appMenu ? viewer._appMenu.menuWrap.nextSibling : viewer.toolbarElemStart.firstChild);
    barControls = document.createElement('span');
    barControls.className = 'scribe-library-bar-controls';
    barControls.style.display = 'none';
    for (const el of [searchField, viewSeg, sortWrap, previewBtn, headerSep, addBtn, refreshBtn]) barControls.appendChild(el);
    viewer.toolbarElemEnd.appendChild(barControls);
    surface.appendChild(fileInput);
  } else {
    surface.appendChild(header);
  }
  surface.appendChild(progressElem);
  surface.appendChild(body);
  viewer.pdfViewerElem.appendChild(surface);

  const homeTab = document.createElement('div');
  homeTab.className = 'scribe-tab pinned';
  homeTab.title = 'Library';
  homeTab.innerHTML = `<span class="scribe-tab-icon">${LIBRARY_SVG}</span><span class="scribe-tab-name">Library</span>`;
  if (viewer._tabStrip) {
    viewer._tabStrip.setPinnedTab(homeTab);
    viewer._tabStripMinTabs = 1;
    viewer._renderTabs();
  }

  // --- Layout -------------------------------------------------------------

  const updateChrome = () => {
    surface.style.top = `${viewer._chromeTop()}px`;
  };
  const resizeObserver = new ResizeObserver(updateChrome);
  resizeObserver.observe(viewer.pdfViewerElem);

  /** @type {Array<{el: HTMLElement, display: string}>} */
  let hiddenBarElems = [];
  let barSwapped = false;
  let priorEndZoneFlex = '';

  /** Replace the toolbar's document controls with the library's own fragments, leaving the app menu in place. */
  const swapBarIn = () => {
    if (!barTitle || !barControls || barSwapped) return;
    barSwapped = true;
    const hide = (el) => {
      hiddenBarElems.push({ el, display: el.style.display });
      el.style.display = 'none';
    };
    for (const el of [...viewer.toolbarElemStart.children]) {
      if (el !== viewer._appMenu?.menuWrap && el !== barTitle) hide(/** @type {HTMLElement} */ (el));
    }
    if (viewer._toolbarButtonsElem) hide(viewer._toolbarButtonsElem);
    for (const el of [...viewer.toolbarElemEnd.children]) {
      if (el !== barControls) hide(/** @type {HTMLElement} */ (el));
    }
    barTitle.style.display = '';
    barControls.style.display = '';
    // The stock end zone takes half the bar and never shrinks below its content, so a tight bar pushes the library's controls off the edge.
    priorEndZoneFlex = viewer.toolbarElemEnd.style.flex;
    viewer.toolbarElemEnd.style.flex = '0 1 auto';
    viewer.toolbarElemEnd.style.minWidth = '0';
    viewer.toolbarElem?.classList.add('scribe-library-bar');
  };
  const swapBarOut = () => {
    if (!barSwapped) return;
    barSwapped = false;
    /** @type {HTMLElement} */ (barTitle).style.display = 'none';
    /** @type {HTMLElement} */ (barControls).style.display = 'none';
    for (const { el, display } of hiddenBarElems) el.style.display = display;
    hiddenBarElems = [];
    viewer.toolbarElemEnd.style.flex = priorEndZoneFlex;
    viewer.toolbarElemEnd.style.minWidth = '';
    viewer.toolbarElem?.classList.remove('scribe-library-bar');
    // A resize while the bar was swapped measured hidden controls, so re-shed against the restored bar.
    viewer._syncModeOverflow?.();
  };

  const showSurface = () => {
    visible = true;
    updateChrome();
    viewer._exclusiveToolBtns?.find((b) => b.classList.contains('active'))?.click();
    viewer._searchBar?.closeSearch();
    viewer._setModeTrayOpen?.(false);
    swapBarIn();
    viewer._tabStrip?.setPinnedActive(true);
    surface.style.display = 'flex';
  };
  const hideSurface = () => {
    visible = false;
    closeCardMenu();
    swapBarOut();
    viewer._tabStrip?.setPinnedActive(false);
    surface.style.display = 'none';
  };

  // --- Persistence helpers ------------------------------------------------

  const saveManifestSoon = () => {
    if (manifestTimer !== null) return;
    manifestTimer = window.setTimeout(() => {
      manifestTimer = null;
      if (store && manifest) store.writeManifest(manifest).catch(() => {});
    }, 1000);
  };

  const saveIndexSoon = () => {
    if (indexTimer !== null) return;
    indexTimer = window.setTimeout(() => {
      indexTimer = null;
      if (store) store.writeSearchIndex(index.serialize()).catch(() => {});
    }, 2000);
  };

  /**
   * Checkpoint-save one library tab's sidecar when it has unsaved edits.
   * @param {?{doc: Object, libraryHash?: string, libraryDirty?: boolean, librarySaving?: boolean}} tab
   */
  const saveTabIfDirty = async (tab) => {
    // This checkpoint is the only per-tab exit hook, so clean tabs persist their visited rasters here too.
    if (tab?.libraryHash && store && manifest) {
      const entry = Object.values(manifest.docs).find((e) => e.hash === tab.libraryHash);
      if (entry) persistRasterWindow(tab.doc, entry, /** @type {any} */ (tab).lastPage ?? 0);
    }
    if (!tab || !tab.libraryHash || !tab.libraryDirty || tab.librarySaving || !store) return;
    tab.librarySaving = true;
    tab.libraryDirty = false;
    try {
      // Sidecars are this application's session store, so they carry app-side state (pending text edits, native-text metadata) that a default export drops.
      const data = await /** @type {any} */ (tab.doc).exportData('scribe', { scribeSession: true });
      await store.writeSidecar(tab.libraryHash, data);
      sessions.dropSidecar(tab.libraryHash);
    } catch {
      tab.libraryDirty = true;
    } finally {
      tab.librarySaving = false;
    }
  };

  // --- Rendering ----------------------------------------------------------

  /**
   * Navigate the browse view to a directory ('' for the root).
   * Navigating exits any active search.
   * @param {string} dirPath
   */
  const openDir = (dirPath) => {
    currentDir = dirPath;
    selectedPaths.clear();
    selAnchor = null;
    fullTextResults = null;
    filterText = '';
    searchInput.value = '';
    searchField.classList.remove('has-text');
    render();
    body.scrollTop = 0;
  };

  /** Rebuild the header breadcrumbs for `currentDir`; ancestors are links and drag-drop targets. */
  const syncCrumbs = () => {
    crumbsElem.replaceChildren();
    const segs = currentDir ? currentDir.split('/') : [];
    if (!segs.length) {
      crumbsElem.textContent = 'Library';
      return;
    }
    const rootBtn = document.createElement('button');
    rootBtn.className = 'scribe-library-crumb';
    rootBtn.textContent = 'Library';
    rootBtn.dataset.dirTarget = '';
    rootBtn.addEventListener('click', () => openDir(''));
    crumbsElem.appendChild(rootBtn);
    for (let i = 0; i < segs.length; i++) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '›';
      crumbsElem.appendChild(sep);
      if (i === segs.length - 1) {
        const cur = document.createElement('span');
        cur.className = 'cur';
        cur.textContent = segs[i];
        crumbsElem.appendChild(cur);
      } else {
        const btn = document.createElement('button');
        btn.className = 'scribe-library-crumb';
        btn.textContent = segs[i];
        const path = segs.slice(0, i + 1).join('/');
        btn.dataset.dirTarget = path;
        btn.addEventListener('click', () => openDir(path));
        crumbsElem.appendChild(btn);
      }
    }
  };

  const render = () => {
    // A rebuild mid-drag would pull the dragged card out from under the pointer.
    if (dragState && dragState.started) {
      renderPending = true;
      return;
    }
    closeCardMenu();
    syncCrumbs();
    // The retained results view snapshots its scroll state before the detach below, so a reattach can restore it.
    if (resultsView && resultsView.wrap.isConnected) resultsView.snapshot();
    body.textContent = '';
    body.classList.remove('results-mode', 'list-mode', 'split-mode');
    listPane = null;
    // Tearing the pane down drops the embedded viewer and its painted pages, so it survives every re-render of a view that still hosts it.
    if (mountedPane && !fullTextResults && !(listPreviewOn && viewMode !== 'grid')) mountedPane.destroy();
    if (!fullTextResults && resultsView) {
      resultsView.dispose();
      resultsView = null;
    }
    if (!store || !manifest) {
      const card = document.createElement('div');
      card.className = 'scribe-library-card-wall';
      const connectBtn = document.createElement('button');
      connectBtn.className = 'scribe-library-btn primary';
      if (pendingHandle) {
        card.innerHTML = `<h3>Reconnect your library</h3><p>Your browser needs permission again to read “${pendingHandle.name}”. Nothing is lost — one click restores access.</p>`;
        connectBtn.textContent = `Reconnect “${pendingHandle.name}”`;
        connectBtn.addEventListener('click', async () => {
          try {
            const s = new LibraryStore(/** @type {FileSystemDirectoryHandle} */ (pendingHandle));
            if ((await s.requestPermission()) !== 'granted') return;
            pendingHandle = null;
            await openLibrary(s);
          } catch { /* Permission denied or dismissed. */ }
        });
      } else {
        card.innerHTML = '<h3>Set up your library</h3><p>Pick a folder of PDFs. Scribe reads your documents in place and keeps annotations, '
          + 'bookmarks, and text corrections in its own files inside that folder — your PDFs are never modified.</p>';
        connectBtn.textContent = 'Choose a folder…';
        connectBtn.addEventListener('click', async () => {
          try {
            await openLibrary(await LibraryStore.connectNew());
          } catch { /* Picker dismissed. */ }
        });
      }
      card.appendChild(connectBtn);
      body.appendChild(card);
      return;
    }

    const dirSet = new Set(manifest.dirs ?? []);
    if (currentDir && !dirSet.has(currentDir)) {
      // The browsed folder can vanish when a rescan follows a delete made outside the app.
      currentDir = '';
      syncCrumbs();
    }
    const entries = Object.entries(manifest.docs);
    for (const p of selectedPaths) {
      if (!manifest.docs[p] && !(p.endsWith('/') && dirSet.has(p.slice(0, -1)))) selectedPaths.delete(p);
    }

    if (fullTextResults) {
      renderResults();
      return;
    }

    const filter = filterText.trim().toLowerCase();
    const shown = filter
      ? entries.filter(([relPath]) => relPath.toLowerCase().includes(filter))
      : entries.filter(([relPath]) => {
        const cut = relPath.lastIndexOf('/');
        return (cut < 0 ? '' : relPath.slice(0, cut)) === currentDir;
      });
    shown.sort(([pa, a], [pb, b]) => {
      let d = 0;
      if (sortMode === 'added') d = a.added - b.added;
      else if (sortMode === 'opened') d = a.lastOpened - b.lastOpened;
      else if (sortMode === 'pages') d = (a.pageCount || 0) - (b.pageCount || 0);
      else if (sortMode === 'custom') {
        d = (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER);
      } else d = titleOf(pa).localeCompare(titleOf(pb));
      if (d) return d * sortDir;
      return titleOf(pa).localeCompare(titleOf(pb));
    });
    const shownDirs = filter ? [] : [...dirSet].filter((dir) => {
      const cut = dir.lastIndexOf('/');
      return (cut < 0 ? '' : dir.slice(0, cut)) === currentDir;
    }).sort((a, b) => a.localeCompare(b) * (sortMode === 'name' ? sortDir : 1));
    const shownOthers = !showOthers ? [] : (manifest.others ?? []).filter((p) => {
      if (filter) return p.toLowerCase().includes(filter);
      const cut = p.lastIndexOf('/');
      return (cut < 0 ? '' : p.slice(0, cut)) === currentDir;
    }).sort((a, b) => (a.split('/').pop() || a).localeCompare(b.split('/').pop() || b));

    if (!entries.length && !dirSet.size && !shownOthers.length) {
      const empty = document.createElement('div');
      empty.className = 'scribe-library-empty';
      empty.textContent = 'No PDFs in this folder yet. Drop files here or use “Add PDFs”.';
      body.appendChild(empty);
      return;
    }

    if (viewMode === 'list' || viewMode === 'compact') {
      mainGridElem = null;
      gridPaths = [];
      const host = renderList(shownDirs, shown, shownOthers);
      if (!shown.length && !shownOthers.length && filter) {
        const empty = document.createElement('div');
        empty.className = 'scribe-library-empty';
        empty.textContent = 'No names match. Press Enter to search inside the documents.';
        host.appendChild(empty);
      } else if (currentDir && !shownDirs.length && !shown.length && !shownOthers.length) {
        const empty = document.createElement('div');
        empty.className = 'scribe-library-empty';
        empty.textContent = 'This folder is empty.';
        host.appendChild(empty);
      }
      return;
    }

    const recent = currentDir === '' && !filter && sortMode !== 'opened'
      ? entries.filter(([, e]) => e.lastOpened > 0).sort(([, a], [, b]) => b.lastOpened - a.lastOpened).slice(0, 5)
      : [];
    if (recent.length) {
      const label = document.createElement('div');
      label.className = 'scribe-library-section-label';
      label.textContent = 'Recent';
      body.appendChild(label);
      const grid = document.createElement('div');
      grid.className = 'scribe-library-grid';
      for (const [relPath, entry] of recent) grid.appendChild(buildCard(relPath, entry, false));
      body.appendChild(grid);
      // With folders present, the branch below labels the document grid itself.
      if (!shownDirs.length) {
        const allLabel = document.createElement('div');
        allLabel.className = 'scribe-library-section-label';
        allLabel.textContent = 'All documents';
        body.appendChild(allLabel);
      }
    }

    if (shownDirs.length) {
      const dirLabel = document.createElement('div');
      dirLabel.className = 'scribe-library-section-label';
      dirLabel.textContent = `Folders · ${shownDirs.length}`;
      body.appendChild(dirLabel);
      const dirGrid = document.createElement('div');
      dirGrid.className = 'scribe-library-grid folders';
      for (const dir of shownDirs) dirGrid.appendChild(buildFolderCard(dir));
      body.appendChild(dirGrid);
      if (shown.length) {
        const docLabel = document.createElement('div');
        docLabel.className = 'scribe-library-section-label';
        docLabel.textContent = `Documents · ${shown.length}`;
        body.appendChild(docLabel);
      }
    }
    const grid = document.createElement('div');
    grid.className = 'scribe-library-grid main';
    for (const [relPath, entry] of shown) grid.appendChild(buildCard(relPath, entry, !filter));
    body.appendChild(grid);
    mainGridElem = grid;
    gridPaths = shown.map(([p]) => p);
    if (!shown.length && !shownOthers.length && filter) {
      const empty = document.createElement('div');
      empty.className = 'scribe-library-empty';
      empty.textContent = 'No names match. Press Enter to search inside the documents.';
      body.appendChild(empty);
    } else if (currentDir && !shownDirs.length && !shown.length && !shownOthers.length) {
      const empty = document.createElement('div');
      empty.className = 'scribe-library-empty';
      empty.textContent = 'This folder is empty.';
      body.appendChild(empty);
    }
    if (shownOthers.length) {
      // The main grid's drag-reorder math indexes its children against gridPaths, so these cards need a grid of their own.
      const otherLabel = document.createElement('div');
      otherLabel.className = 'scribe-library-section-label';
      otherLabel.textContent = 'Other files';
      body.appendChild(otherLabel);
      const otherGrid = document.createElement('div');
      otherGrid.className = 'scribe-library-grid';
      for (const relPath of shownOthers) otherGrid.appendChild(buildOtherCard(relPath));
      body.appendChild(otherGrid);
    }
  };

  /** Restyle every visible card and list row to the selection set. */
  const syncSelectionUI = () => {
    // The previewed document stays selected through every selection change, since a deselected preview leaves no cue of what the pane shows.
    if (listPreviewOn && viewMode !== 'grid' && listPreviewPath) selectedPaths.add(listPreviewPath);
    for (const el of body.querySelectorAll('.scribe-library-card, .scribe-library-row')) {
      el.classList.toggle('selected', selectedPaths.has(/** @type {HTMLElement} */ (el).dataset.relPath ?? ''));
    }
  };

  const SELECTION_KEEP_SELECTOR = '.scribe-library-card, .scribe-library-row, .scribe-library-lhead, button, input, select';
  body.addEventListener('click', (e) => {
    if (Date.now() < suppressClickUntil) return;
    if (/** @type {Element} */ (e.target).closest(SELECTION_KEEP_SELECTOR)) return;
    if (!selectedPaths.size) return;
    selectedPaths.clear();
    selAnchor = null;
    syncSelectionUI();
  });

  /**
   * Apply the Pages-view click-selection rules to the item at `relPath`.
   * @param {MouseEvent} e
   * @param {string} relPath
   * @param {string[]} paths - The clicked item's siblings in display order, for Shift ranges.
   */
  const applyClickSelection = (e, relPath, paths) => {
    if (e.shiftKey && selAnchor !== null) {
      const ai = paths.indexOf(selAnchor);
      const ci = paths.indexOf(relPath);
      selectedPaths.clear();
      if (ai >= 0 && ci >= 0) {
        for (let i = Math.min(ai, ci); i <= Math.max(ai, ci); i++) selectedPaths.add(paths[i]);
      } else {
        selectedPaths.add(relPath);
        selAnchor = relPath;
      }
    } else if (e.ctrlKey || e.metaKey) {
      if (selectedPaths.has(relPath)) selectedPaths.delete(relPath);
      else selectedPaths.add(relPath);
      selAnchor = relPath;
    } else {
      selectedPaths.clear();
      selectedPaths.add(relPath);
      selAnchor = relPath;
    }
    syncSelectionUI();
  };

  /**
   * Point `img` at the thumbnail for `entry`, loading it from the store on first use.
   * @param {HTMLImageElement} img
   * @param {import('./libraryStore.js').LibraryDocEntry} entry
   */
  const setThumbSrc = (img, entry) => {
    if (!entry.hash) return;
    const cachedUrl = sessions.coverUrlNow(entry.hash);
    if (cachedUrl) {
      img.src = cachedUrl;
      return;
    }
    sessions.cover(entry.hash).then((url) => {
      if (!destroyed && url) img.src = url;
    }).catch(() => {});
  };

  // --- Card context menu --------------------------------------------------

  // Reuses the Pages-view thumb-menu classes so the two grids' menus look identical.
  const menuElem = document.createElement('div');
  menuElem.className = 'scribe-thumb-menu';
  menuElem.style.display = 'none';
  surface.appendChild(menuElem);
  /** @type {?HTMLElement} */
  let menuTargetElem = null;

  const closeCardMenu = () => {
    menuElem.style.display = 'none';
    if (menuTargetElem) {
      menuTargetElem.classList.remove('context');
      menuTargetElem = null;
    }
    document.removeEventListener('pointerdown', onMenuOutside);
    document.removeEventListener('keydown', onMenuKey);
  };
  /** @param {PointerEvent} e */
  const onMenuOutside = (e) => {
    if (!menuElem.contains(/** @type {Node} */ (e.target))) closeCardMenu();
  };
  /** @param {KeyboardEvent} e */
  const onMenuKey = (e) => {
    if (e.key === 'Escape') closeCardMenu();
  };

  /**
   * Open the context menu at the cursor for the doc at `relPath`, or for a folder when the key carries a trailing slash.
   * When a doc card is part of a 2+ selection, the actions apply to every selected document.
   * @param {number} clientX
   * @param {number} clientY
   * @param {string} relPath
   * @param {HTMLElement} card
   */
  const openCardMenu = (clientX, clientY, relPath, card) => {
    if (!store || !manifest) return;
    closeCardMenu();
    card.classList.add('context');
    menuTargetElem = card;
    menuElem.replaceChildren();
    /** @param {string} label @param {boolean} danger @param {() => void} fn */
    const addItem = (label, danger, fn) => {
      const item = document.createElement('div');
      item.className = danger ? 'scribe-thumb-menu-item danger' : 'scribe-thumb-menu-item';
      item.textContent = label;
      item.addEventListener('click', () => {
        closeCardMenu();
        fn();
      });
      menuElem.appendChild(item);
    };
    /**
     * Add the Index or Re-index item for `docPaths`.
     * @param {string[]} docPaths
     */
    const addIndexItem = (docPaths) => {
      const statusOf = (/** @type {string} */ p) => manifest?.docs[p]?.status;
      const stale = docPaths.filter((p) => ['pending', 'changed', 'error'].includes(statusOf(p) ?? ''));
      const targets = stale.length ? stale : docPaths.filter((p) => statusOf(p) === 'indexed');
      if (!targets.length) return;
      addItem(stale.length ? 'Index' : 'Re-index', false, async () => {
        if (!ingest) return;
        for (const p of targets) {
          const hash = manifest?.docs[p]?.hash;
          if (hash) sessions.invalidate(hash);
          await ingest.enqueue(p);
        }
        render();
        ingest.start();
      });
    };
    if (relPath.endsWith('/')) {
      addItem('Open', false, () => openDir(relPath.slice(0, -1)));
      addIndexItem(Object.keys(manifest.docs).filter((p) => p.startsWith(relPath)));
    } else {
      const multi = selectedPaths.has(relPath) && selectedPaths.size >= 2;
      // Folder keys in a mixed selection drop out here: these actions are document verbs.
      const paths = (multi ? [...selectedPaths] : [relPath]).filter((p) => manifest && manifest.docs[p]);
      if (paths.length >= 2) {
        const menuHeader = document.createElement('div');
        menuHeader.className = 'scribe-thumb-menu-header';
        menuHeader.textContent = `${paths.length} documents`;
        menuElem.appendChild(menuHeader);
      }
      addItem('Open', false, async () => {
        for (const p of paths) {
          const entry = manifest && manifest.docs[p];
          if (entry) await openEntry(p, entry);
        }
      });
      addIndexItem(paths);
      menuElem.appendChild(document.createElement('hr')).className = 'scribe-thumb-menu-divider';
      addItem('Remove from library', true, async () => {
        if (!store || !manifest) return;
        const msg = paths.length === 1
          ? `Remove “${titleOf(paths[0])}” from the library?\n\nIts saved annotations and edits are deleted. The document file itself is not touched.`
          : `Remove ${paths.length} documents from the library?\n\nTheir saved annotations and edits are deleted. The document files themselves are not touched.`;
        if (!window.confirm(msg)) return;
        for (const p of paths) {
          const entry = manifest.docs[p];
          if (!entry) continue;
          delete manifest.docs[p];
          // Identical files share a hash and therefore a sidecar; only drop the data files when this was the last reference.
          const shared = Object.values(manifest.docs).some((e2) => e2.hash === entry.hash);
          if (entry.hash && !shared) {
            index.removeDoc(entry.hash);
            await Promise.all([
              store.deleteSidecar(entry.hash), store.deleteTextCache(entry.hash), store.deleteThumb(entry.hash),
              store.deletePageRasters(entry.hash),
            ]).catch(() => {});
            sessions.invalidate(entry.hash);
            saveIndexSoon();
          }
        }
        await store.writeManifest(manifest);
        render();
      });
    }

    // Show first so the menu has measurable dimensions, then clamp it inside the surface.
    menuElem.style.display = '';
    const hostRect = surface.getBoundingClientRect();
    const left = Math.min(clientX - hostRect.left, hostRect.width - menuElem.offsetWidth - 4);
    const top = Math.min(clientY - hostRect.top, hostRect.height - menuElem.offsetHeight - 4);
    menuElem.style.left = `${Math.max(4, left)}px`;
    menuElem.style.top = `${Math.max(4, top)}px`;
    // Deferred so the pointerdown that opened the menu does not immediately close it.
    setTimeout(() => document.addEventListener('pointerdown', onMenuOutside), 0);
    document.addEventListener('keydown', onMenuKey);
  };

  /**
   * @param {string} relPath
   * @param {import('./libraryStore.js').LibraryDocEntry} entry
   * @param {boolean} [draggable] - False for derived views (the Recent strip, a filtered grid).
   */
  const buildCard = (relPath, entry, draggable = true) => {
    const card = document.createElement('div');
    card.className = 'scribe-library-card';
    card.tabIndex = 0;
    card.dataset.relPath = relPath;
    if (selectedPaths.has(relPath)) card.classList.add('selected');
    if (draggable) card.addEventListener('pointerdown', (e) => beginCardDrag(e, relPath, card));

    const img = document.createElement('img');
    img.className = 'thumb';
    img.alt = '';
    // Images are natively draggable.
    // Left on, a press-drag starts an HTML5 image drag that cancels the reorder gesture and lands in the file-drop handlers as a bogus import.
    img.draggable = false;
    setThumbSrc(img, entry);
    card.appendChild(img);

    const cardBody = document.createElement('div');
    cardBody.className = 'body';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = titleOf(relPath);
    title.title = relPath;
    cardBody.appendChild(title);
    const meta = document.createElement('div');
    meta.className = 'meta';
    if (entry.pageCount) meta.appendChild(document.createTextNode(`${entry.pageCount} page${entry.pageCount === 1 ? '' : 's'}`));
    if (entry.status === 'missing') meta.insertAdjacentHTML('beforeend', '<span class="scribe-library-badge error">Missing</span>');
    else if (entry.status === 'changed') meta.insertAdjacentHTML('beforeend', '<span class="scribe-library-badge warn">Changed</span>');
    else if (entry.status === 'error') meta.insertAdjacentHTML('beforeend', '<span class="scribe-library-badge error">Failed</span>');
    else if (entry.status === 'pending') meta.insertAdjacentHTML('beforeend', '<span class="scribe-library-badge">Queued</span>');
    else if (entry.requiresOCR) meta.insertAdjacentHTML('beforeend', '<span class="scribe-library-badge">Scanned</span>');
    if (entry.status === 'error' && entry.error) meta.title = entry.error;
    cardBody.appendChild(meta);
    card.appendChild(cardBody);

    if (entry.status === 'pending' || entry.status === 'changed' || entry.status === 'error') {
      const actions = document.createElement('div');
      actions.className = 'actions';
      const indexBtn = document.createElement('button');
      indexBtn.textContent = 'Index';
      indexBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!ingest) return;
        if (entry.hash) sessions.invalidate(entry.hash);
        await ingest.enqueue(relPath);
        render();
        ingest.start();
      });
      actions.appendChild(indexBtn);
      card.appendChild(actions);
    }

    const open = () => {
      if (Date.now() < suppressClickUntil) return;
      openEntry(relPath, entry);
    };
    // Touch keeps tap-to-open; select-then-double-click is a pointer-and-keyboard scheme.
    card.addEventListener('click', (e) => {
      if (viewer._coarsePointer) {
        open();
        return;
      }
      if (Date.now() < suppressClickUntil) return;
      // The Recent strip repeats documents from the grid below it, so a range spanning both would run over duplicate paths.
      const inBands = !!card.parentElement
        && (card.parentElement.classList.contains('folders') || card.parentElement.classList.contains('main'));
      const paths = (inBands
        ? [...body.querySelectorAll('.scribe-library-grid.folders > .scribe-library-card, .scribe-library-grid.main > .scribe-library-card')]
        : [...(card.parentElement?.querySelectorAll(':scope > .scribe-library-card') ?? [])])
        .map((el) => /** @type {HTMLElement} */ (el).dataset.relPath ?? '');
      applyClickSelection(e, relPath, paths);
    });
    card.addEventListener('dblclick', (e) => {
      if (e.shiftKey || e.ctrlKey || e.metaKey) return;
      open();
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') open();
    });
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // The touch hold-to-lift gesture opens this menu itself on a release-in-place.
      // Swallow the native long-press contextmenu Android fires in parallel so it does not open twice.
      if (dragState || Date.now() - lastTouchDragT < 500) return;
      openCardMenu(e.clientX, e.clientY, relPath, card);
    });
    return card;
  };

  /**
   * Counts, aggregates, ingest-state tallies, and cover entries over a folder's direct children.
   * @param {string} dirPath
   */
  const dirStatsOf = (dirPath) => {
    const stats = {
      docs: 0,
      subdirs: 0,
      pages: 0,
      added: 0,
      lastOpened: 0,
      failed: 0,
      missing: 0,
      queued: 0,
      changed: 0,
      scanned: 0,
      /** @type {import('./libraryStore.js').LibraryDocEntry[]} */
      covers: [],
    };
    if (!manifest) return stats;
    /** @type {Array<[string, import('./libraryStore.js').LibraryDocEntry]>} */
    const children = [];
    for (const [p, entry] of Object.entries(manifest.docs)) {
      const cut = p.lastIndexOf('/');
      if ((cut < 0 ? '' : p.slice(0, cut)) !== dirPath) continue;
      children.push([p, entry]);
      stats.docs++;
      stats.pages += entry.pageCount || 0;
      if (entry.added > stats.added) stats.added = entry.added;
      if (entry.lastOpened > stats.lastOpened) stats.lastOpened = entry.lastOpened;
      // Same ladder as the card badges, so a queued scan counts as queued rather than scanned.
      if (entry.status === 'missing') stats.missing++;
      else if (entry.status === 'changed') stats.changed++;
      else if (entry.status === 'error') stats.failed++;
      else if (entry.status === 'pending') stats.queued++;
      else if (entry.requiresOCR) stats.scanned++;
    }
    for (const dir of manifest.dirs ?? []) {
      const cut = dir.lastIndexOf('/');
      if ((cut < 0 ? '' : dir.slice(0, cut)) === dirPath) stats.subdirs++;
    }
    // Name order keeps the strip from reshuffling whenever the sort mode changes.
    children.sort(([a], [b]) => titleOf(a).localeCompare(titleOf(b)));
    stats.covers = children.slice(0, 3).map(([, entry]) => entry);
    return stats;
  };

  /**
   * Fill `host` with a folder's summary line.
   * @param {HTMLElement} host
   * @param {ReturnType<typeof dirStatsOf>} stats
   */
  const fillFolderSummary = (host, stats) => {
    const parts = [];
    if (stats.docs) parts.push(`${stats.docs} document${stats.docs === 1 ? '' : 's'}`);
    if (stats.subdirs) parts.push(`${stats.subdirs} folder${stats.subdirs === 1 ? '' : 's'}`);
    const base = document.createElement('span');
    base.textContent = parts.length ? parts.join(' · ') : 'Empty';
    host.appendChild(base);
    const danger = [];
    if (stats.failed) danger.push(`${stats.failed} failed`);
    if (stats.missing) danger.push(`${stats.missing} missing`);
    const soft = [];
    if (stats.queued) soft.push(`${stats.queued} queued`);
    if (stats.changed) soft.push(`${stats.changed} changed`);
    if (stats.scanned) soft.push(`${stats.scanned} need${stats.scanned === 1 ? 's' : ''} text recognition`);
    for (const [text, bad] of [[danger.join(' · '), true], [soft.join(' · '), false]]) {
      if (!text) continue;
      const sep = document.createElement('span');
      sep.textContent = '·';
      host.appendChild(sep);
      const att = document.createElement('span');
      att.className = bad ? 'att bad' : 'att';
      att.textContent = /** @type {string} */ (text);
      host.appendChild(att);
    }
    if (danger.length || soft.length) host.classList.add('hasatt');
  };

  /**
   * A subdirectory as a grid card.
   * Folders are keyed in the selection set as `path/`, so the trailing slash keeps them apart from document paths.
   * @param {string} dirPath
   */
  const buildFolderCard = (dirPath) => {
    const card = document.createElement('div');
    card.className = 'scribe-library-card folder';
    card.tabIndex = 0;
    card.dataset.relPath = `${dirPath}/`;
    card.dataset.dirTarget = dirPath;
    if (selectedPaths.has(`${dirPath}/`)) card.classList.add('selected');

    const stats = dirStatsOf(dirPath);
    const strip = document.createElement('div');
    strip.className = 'fstrip';
    if (stats.covers.length) {
      for (const entry of stats.covers) {
        const img = document.createElement('img');
        img.alt = '';
        img.draggable = false;
        setThumbSrc(img, entry);
        strip.appendChild(img);
      }
    } else {
      strip.innerHTML = `<span class="empty"><span class="fi">${FOLDER_SVG}</span></span>`;
    }
    card.appendChild(strip);

    const cardBody = document.createElement('div');
    cardBody.className = 'body';
    const title = document.createElement('div');
    title.className = 'title';
    title.innerHTML = `<span class="fi">${FOLDER_SVG}</span>`;
    title.appendChild(document.createTextNode(dirPath.split('/').pop() || dirPath));
    title.title = dirPath;
    cardBody.appendChild(title);
    const meta = document.createElement('div');
    meta.className = 'meta';
    fillFolderSummary(meta, stats);
    cardBody.appendChild(meta);
    card.appendChild(cardBody);

    const open = () => {
      if (Date.now() < suppressClickUntil) return;
      openDir(dirPath);
    };
    card.addEventListener('click', (e) => {
      if (viewer._coarsePointer) {
        open();
        return;
      }
      if (Date.now() < suppressClickUntil) return;
      const paths = [...body.querySelectorAll('.scribe-library-grid.folders > .scribe-library-card, .scribe-library-grid.main > .scribe-library-card')]
        .map((el) => /** @type {HTMLElement} */ (el).dataset.relPath ?? '');
      applyClickSelection(e, `${dirPath}/`, paths);
    });
    card.addEventListener('dblclick', (e) => {
      if (e.shiftKey || e.ctrlKey || e.metaKey) return;
      open();
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') open();
    });
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (dragState) return;
      openCardMenu(e.clientX, e.clientY, `${dirPath}/`, card);
    });
    return card;
  };

  /**
   * A non-PDF file as an inert grid card.
   * @param {string} relPath
   */
  const buildOtherCard = (relPath) => {
    const name = relPath.split('/').pop() || relPath;
    const card = document.createElement('div');
    card.className = 'scribe-library-card other';
    card.title = 'Not a PDF — Scribe can’t open it';

    const icon = document.createElement('div');
    icon.className = 'fthumb';
    icon.innerHTML = `<span class="fi">${FILE_SVG}</span>`;
    card.appendChild(icon);

    const cardBody = document.createElement('div');
    cardBody.className = 'body';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = name;
    cardBody.appendChild(title);
    const meta = document.createElement('div');
    meta.className = 'meta';
    const extBadge = document.createElement('span');
    extBadge.className = 'scribe-library-badge';
    const dot = name.lastIndexOf('.');
    extBadge.textContent = dot > 0 ? name.slice(dot + 1).toUpperCase() : 'FILE';
    meta.appendChild(extBadge);
    cardBody.appendChild(meta);
    card.appendChild(cardBody);
    return card;
  };

  /**
   * One list row, in the comfortable (thumbnail) or compact layout per the current view mode.
   * @param {string} relPath
   * @param {import('./libraryStore.js').LibraryDocEntry} entry
   */
  const buildRow = (relPath, entry) => {
    const comfortable = viewMode === 'list';
    const row = document.createElement('div');
    row.className = comfortable ? 'scribe-library-row cf' : 'scribe-library-row';
    row.tabIndex = 0;
    row.dataset.relPath = relPath;
    if (selectedPaths.has(relPath)) row.classList.add('selected');
    // Rows drag for moving into folders only; reordering is a grid-under-Custom affair.
    row.addEventListener('pointerdown', (e) => beginCardDrag(e, relPath, row));

    let badge = '';
    if (entry.status === 'missing') badge = '<span class="scribe-library-badge error">Missing</span>';
    else if (entry.status === 'changed') badge = '<span class="scribe-library-badge warn">Changed</span>';
    else if (entry.status === 'error') badge = '<span class="scribe-library-badge error">Failed</span>';
    else if (entry.status === 'pending') badge = '<span class="scribe-library-badge">Queued</span>';
    else if (entry.requiresOCR) badge = '<span class="scribe-library-badge">Scanned</span>';

    const nm = document.createElement('span');
    nm.className = 'nm';
    const title = document.createElement('span');
    title.className = 't';
    title.textContent = titleOf(relPath);
    title.title = relPath;
    if (comfortable) {
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      setThumbSrc(img, entry);
      nm.appendChild(img);
      const stack = document.createElement('span');
      stack.className = 'tt';
      stack.appendChild(title);
      if (badge) {
        const meta = document.createElement('span');
        meta.className = 'm2';
        meta.innerHTML = badge;
        if (entry.status === 'error' && entry.error) meta.title = entry.error;
        stack.appendChild(meta);
      }
      nm.appendChild(stack);
    } else {
      nm.appendChild(title);
    }
    row.appendChild(nm);

    const pagesCell = document.createElement('span');
    pagesCell.className = entry.pageCount ? 'num' : 'none';
    pagesCell.textContent = entry.pageCount ? String(entry.pageCount) : '—';
    row.appendChild(pagesCell);

    /** @param {number} t */
    const fmtDate = (t) => (t > 0
      ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      : '—');
    const addedCell = document.createElement('span');
    addedCell.className = entry.added > 0 ? 'dt' : 'none';
    addedCell.textContent = fmtDate(entry.added);
    row.appendChild(addedCell);
    const openedCell = document.createElement('span');
    openedCell.className = entry.lastOpened > 0 ? 'dt' : 'none';
    openedCell.textContent = fmtDate(entry.lastOpened);
    row.appendChild(openedCell);

    if (!comfortable) {
      const statusCell = document.createElement('span');
      if (badge) statusCell.innerHTML = badge;
      else {
        statusCell.className = 'none';
        statusCell.textContent = '—';
      }
      if (entry.status === 'error' && entry.error) statusCell.title = entry.error;
      row.appendChild(statusCell);
    }

    const open = () => {
      if (Date.now() < suppressClickUntil) return;
      openEntry(relPath, entry);
    };
    row.addEventListener('click', (e) => {
      if (viewer._coarsePointer) {
        open();
        return;
      }
      if (Date.now() < suppressClickUntil) return;
      const paths = [...(row.parentElement?.querySelectorAll(':scope > .scribe-library-row') ?? [])]
        .map((el) => /** @type {HTMLElement} */ (el).dataset.relPath ?? '');
      // Preview first: syncSelectionUI keeps the previewed document selected, so listPreviewPath must already point at this row.
      showListPreview(relPath, entry, 0);
      applyClickSelection(e, relPath, paths);
    });
    row.addEventListener('dblclick', (e) => {
      if (e.shiftKey || e.ctrlKey || e.metaKey) return;
      open();
    });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') open();
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (dragState || Date.now() - lastTouchDragT < 500) return;
      openCardMenu(e.clientX, e.clientY, relPath, row);
    });
    return row;
  };

  /**
   * A subdirectory as a list row.
   * @param {string} dirPath
   */
  const buildFolderRow = (dirPath) => {
    const comfortable = viewMode === 'list';
    const row = document.createElement('div');
    row.className = comfortable ? 'scribe-library-row cf folder' : 'scribe-library-row folder';
    row.tabIndex = 0;
    row.dataset.relPath = `${dirPath}/`;
    row.dataset.dirTarget = dirPath;
    if (selectedPaths.has(`${dirPath}/`)) row.classList.add('selected');
    const stats = dirStatsOf(dirPath);

    const nm = document.createElement('span');
    nm.className = 'nm';
    const title = document.createElement('span');
    title.className = 't';
    title.textContent = dirPath.split('/').pop() || dirPath;
    title.title = dirPath;
    if (comfortable) {
      const icon = document.createElement('span');
      icon.className = 'fthumb';
      icon.innerHTML = `<span class="fi">${FOLDER_SVG}</span>`;
      nm.appendChild(icon);
      const stack = document.createElement('span');
      stack.className = 'tt';
      stack.appendChild(title);
      const meta = document.createElement('span');
      meta.className = 'm2';
      fillFolderSummary(meta, stats);
      stack.appendChild(meta);
      nm.appendChild(stack);
    } else {
      nm.insertAdjacentHTML('beforeend', `<span class="fi">${FOLDER_SVG}</span>`);
      nm.appendChild(title);
      const cnt = document.createElement('span');
      cnt.className = 'cnt';
      fillFolderSummary(cnt, stats);
      nm.appendChild(cnt);
    }
    row.appendChild(nm);

    /** @param {number} t */
    const fmtDate = (t) => (t > 0
      ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      : '—');
    const pagesCell = document.createElement('span');
    pagesCell.className = stats.pages ? 'roll pg' : 'none';
    pagesCell.textContent = stats.pages ? String(stats.pages) : '—';
    row.appendChild(pagesCell);
    const addedCell = document.createElement('span');
    addedCell.className = stats.added > 0 ? 'roll' : 'none';
    addedCell.textContent = fmtDate(stats.added);
    row.appendChild(addedCell);
    const openedCell = document.createElement('span');
    openedCell.className = stats.lastOpened > 0 ? 'roll' : 'none';
    openedCell.textContent = fmtDate(stats.lastOpened);
    row.appendChild(openedCell);
    if (!comfortable) {
      const statusCell = document.createElement('span');
      statusCell.className = 'none';
      statusCell.textContent = '—';
      row.appendChild(statusCell);
    }

    const open = () => {
      if (Date.now() < suppressClickUntil) return;
      openDir(dirPath);
    };
    row.addEventListener('click', (e) => {
      if (viewer._coarsePointer) {
        open();
        return;
      }
      if (Date.now() < suppressClickUntil) return;
      const paths = [...(row.parentElement?.querySelectorAll(':scope > .scribe-library-row') ?? [])]
        .map((el) => /** @type {HTMLElement} */ (el).dataset.relPath ?? '');
      applyClickSelection(e, `${dirPath}/`, paths);
    });
    row.addEventListener('dblclick', (e) => {
      if (e.shiftKey || e.ctrlKey || e.metaKey) return;
      open();
    });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') open();
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (dragState) return;
      openCardMenu(e.clientX, e.clientY, `${dirPath}/`, row);
    });
    return row;
  };

  /**
   * A non-PDF file as an inert list row.
   * @param {string} relPath
   */
  const buildOtherRow = (relPath) => {
    const comfortable = viewMode === 'list';
    const name = relPath.split('/').pop() || relPath;
    const row = document.createElement('div');
    row.className = comfortable ? 'scribe-library-row cf other' : 'scribe-library-row other';
    row.title = 'Not a PDF — Scribe can’t open it';

    const badge = document.createElement('span');
    badge.className = 'scribe-library-badge';
    const dot = name.lastIndexOf('.');
    badge.textContent = dot > 0 ? name.slice(dot + 1).toUpperCase() : 'FILE';

    const nm = document.createElement('span');
    nm.className = 'nm';
    const title = document.createElement('span');
    title.className = 't';
    title.textContent = name;
    if (comfortable) {
      const icon = document.createElement('span');
      icon.className = 'fthumb';
      icon.innerHTML = `<span class="fi">${FILE_SVG}</span>`;
      nm.appendChild(icon);
      const stack = document.createElement('span');
      stack.className = 'tt';
      stack.appendChild(title);
      const meta = document.createElement('span');
      meta.className = 'm2';
      meta.appendChild(badge);
      stack.appendChild(meta);
      nm.appendChild(stack);
    } else {
      nm.insertAdjacentHTML('beforeend', `<span class="fi">${FILE_SVG}</span>`);
      nm.appendChild(title);
    }
    row.appendChild(nm);
    for (let i = 0; i < 3; i++) row.appendChild(document.createElement('span'));
    if (!comfortable) {
      const statusCell = document.createElement('span');
      statusCell.appendChild(badge);
      row.appendChild(statusCell);
    }
    return row;
  };

  /**
   * The list views: a sortable column header, folder rows, one row per document, then any inert non-PDF rows.
   * @param {string[]} shownDirs
   * @param {Array<[string, import('./libraryStore.js').LibraryDocEntry]>} shown
   * @param {string[]} shownOthers
   * @returns {HTMLElement} The element hosting the rows, for the caller's empty-state notes.
   */
  const renderList = (shownDirs, shown, shownOthers) => {
    body.classList.add('list-mode');
    const comfortable = viewMode === 'list';
    /** @type {HTMLElement} */
    let host = body;
    if (listPreviewOn) {
      body.classList.add('split-mode');
      const split = buildPreviewSplit(700, () => listPreviewWidth, (w) => { listPreviewWidth = w; });
      body.appendChild(split.wrap);
      listPane = ensurePane('list', 'Select a document to preview it here', '‹ Previous page', 'Next page ›');
      split.wrap.appendChild(listPane.pane);
      const previewEntry = () => (listPreviewPath && manifest ? manifest.docs[listPreviewPath] : null);
      listPane.onOpen = () => {
        const entry = previewEntry();
        if (entry && listPreviewPath) openEntry(listPreviewPath, entry, { pageN: listPreviewPage });
      };
      listPane.onClose = () => {
        listPreviewPath = null;
        listPane?.showEmpty();
      };
      /** @param {number} d */
      const stepPage = (d) => {
        const entry = previewEntry();
        if (!entry || !listPreviewPath) return;
        const n = listPreviewPage + d;
        if (n < 0 || n >= (entry.pageCount || 1)) return;
        // Stepping is scroll-like: past the seeded window it loads rather than re-seeds.
        showListPreview(listPreviewPath, entry, n, false);
      };
      listPane.onPrev = () => stepPage(-1);
      listPane.onNext = () => stepPage(1);
      host = split.left;
    }
    const head = document.createElement('div');
    head.className = comfortable ? 'scribe-library-lhead cols-cf' : 'scribe-library-lhead';
    for (const [key, label] of [['name', 'Name'], ['pages', 'Pages'], ['added', 'Added'], ['opened', 'Last opened']]) {
      const cell = document.createElement('span');
      const hc = document.createElement('span');
      hc.className = sortMode === key ? 'scribe-library-hc on' : 'scribe-library-hc';
      hc.tabIndex = 0;
      hc.setAttribute('role', 'button');
      hc.dataset.sortKey = key;
      hc.appendChild(document.createTextNode(label));
      const ar = document.createElement('span');
      ar.className = 'ar';
      ar.textContent = sortDir === 1 ? '▲' : '▼';
      hc.appendChild(ar);
      cell.appendChild(hc);
      head.appendChild(cell);
    }
    if (!comfortable) {
      const statusHead = document.createElement('span');
      statusHead.textContent = 'Status';
      head.appendChild(statusHead);
    }
    const onHeaderActivate = (e) => {
      const hc = e.target instanceof Element && e.target.closest('.scribe-library-hc');
      if (!hc || !(hc instanceof HTMLElement)) return;
      const key = hc.dataset.sortKey ?? 'name';
      if (sortMode === key) sortDir = -sortDir;
      else {
        sortMode = key;
        sortDir = SORT_DEFAULT_DIR[key];
      }
      syncSortUI();
      render();
    };
    head.addEventListener('click', onHeaderActivate);
    head.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') onHeaderActivate(e);
    });
    host.appendChild(head);
    const rows = document.createElement('div');
    for (const dir of shownDirs) rows.appendChild(buildFolderRow(dir));
    for (const [relPath, entry] of shown) rows.appendChild(buildRow(relPath, entry));
    for (const relPath of shownOthers) rows.appendChild(buildOtherRow(relPath));
    host.appendChild(rows);
    if (listPane) {
      const entry = listPreviewPath && manifest ? manifest.docs[listPreviewPath] : null;
      if (entry && listPreviewPath) {
        showListPreview(listPreviewPath, entry, Math.min(listPreviewPage, (entry.pageCount || 1) - 1));
      } else {
        listPreviewPath = null;
      }
    }
    return host;
  };

  /**
   * The retained search-results view: the built DOM plus its interaction state.
   * Keeping it lets an unchanged result set reattach instead of rebuilding.
   * @type {?{results: Object, pv: Object, wrap: HTMLElement, snapshot: () => void, attach: () => void, repump: () => void, dispose: () => void}}
   */
  let resultsView = null;
  /** Abandons in-flight result-row work when a fresh results build replaces the old one. */
  let resultsGen = 0;

  /**
   * The pooled live document for a legacy entry that cannot seed (no stored pageDims), loading it on first use.
   * @param {string} relPath
   * @param {string} hash
   */
  const sessionDoc = (relPath, hash) => sessions.liveDocOrLoad(
    hash,
    () => /** @type {LibraryStore} */ (store).readFile(relPath).then((file) => openDocumentFromFile(file)),
  );

  /**
   * Persist the two pages either side of `pageN` from an open document, so the next open of that spot paints instantly.
   * Skipped when the document's pages were edited, since stored rasters are keyed by the ingested page order.
   * @param {Object} doc
   * @param {import('./libraryStore.js').LibraryDocEntry} entry
   * @param {number} pageN
   */
  const persistRasterWindow = (doc, entry, pageN) => {
    const d = /** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */ (doc);
    if (!store || !entry?.hash || !d || d.id < 0) return;
    if (d.pageMetrics.length !== entry.pageCount) return;
    if (store.rasterBytes !== null && store.rasterBytes > store.rasterBudget) return;
    const s = store;
    const { hash, pageCount } = entry;
    (async () => {
      for (let n = Math.max(0, pageN - 2); n <= Math.min(pageCount - 1, pageN + 2); n++) {
        if (await s.readPageRaster(hash, n)) continue;
        const raster = await d.images.renderThumbnail(n, PAGE_RASTER_WIDTH, 0.75, true);
        if (raster) await s.writePageRaster(hash, n, raster);
      }
      // Freshly persisted pages may belong to blank search-result rows.
      resultsView?.repump();
    })().catch(() => {});
  };

  /**
   * Build an `openProvisional` seed for a page of a library document.
   * Hydration stays on-demand so that flipping through documents never pays for a full import.
   * @param {string} relPath
   * @param {import('./libraryStore.js').LibraryDocEntry} entry
   * @param {number} pageN
   * @returns {Promise<import('../js/seedDoc.js').ProvisionalSeed>}
   */
  const makeSeed = async (relPath, entry, pageN) => {
    const load = async () => {
      const pdfFile = await /** @type {LibraryStore} */ (store).readFile(relPath);
      const files = [pdfFile];
      if (entry.hash) {
        const sidecar = await /** @type {LibraryStore} */ (store).readSidecar(entry.hash);
        if (sidecar) files.push(new File([sidecar], `${entry.hash}.scribe`));
      }
      return files;
    };
    if (entry.pageDims && !sessions.hasLive(entry.hash)) {
      const pageCount = entry.pageDims.length;
      const from = Math.max(0, pageN - 2);
      const to = Math.min(pageCount - 1, pageN + 2);
      // One pass warms the whole seed window, so the per-page reads below hit the cache instead of each re-reading the sidecar.
      sessions.sidecarPages(entry.hash, Array.from({ length: to - from + 1 }, (_, i) => from + i)).catch(() => {});
      return {
        pageCount,
        pageDims: entry.pageDims.map(([width, height, rotation]) => ({ width, height, rotation })),
        initialPage: pageN,
        window: { from, to },
        name: titleOf(relPath),
        raster: (n) => /** @type {LibraryStore} */ (store).readPageRaster(entry.hash, n),
        ocr: (n) => sessions.sidecarPages(entry.hash, [n]).then((m) => m.get(n)?.ocr ?? null),
        // Copies, never the cached arrays: seed session edits must not leak into the cache.
        annots: (n) => sessions.sidecarPages(entry.hash, [n]).then((m) => {
          const side = m.get(n);
          return side ? (side.annotations ?? []).map((a) => ({ ...a, bbox: { ...a.bbox } })) : null;
        }),
        load,
        hydration: 'on-demand',
      };
    }
    const doc = await sessionDoc(relPath, entry.hash);
    const pageCount = doc.pageMetrics.length;
    return {
      pageCount,
      pageDims: doc.pageMetrics.map((pm) => ({ width: pm.dims.width, height: pm.dims.height, rotation: pm.rotation || 0 })),
      initialPage: pageN,
      window: { from: Math.max(0, pageN - 2), to: Math.min(pageCount - 1, pageN + 2) },
      name: titleOf(relPath),
      raster: (n) => sessions.pageImage(entry.hash, n),
      ocr: async (n) => (await sessionDoc(relPath, entry.hash)).ocr.active?.[n] ?? null,
      annots: async (n) => ((await sessionDoc(relPath, entry.hash)).annotations.pages[n] ?? [])
        .map((a) => ({ ...a, bbox: { ...a.bbox } })),
      load,
      hydration: 'on-demand',
    };
  };

  /**
   * Word boxes for every occurrence of the query on a page, for painting match marks over a render.
   * Accepts a live `OcrPage` or a raw sidecar page, anything with `lines[].words[].{text, bbox}`.
   * @param {?{lines: Array<Object>, dims?: {width: number, height: number}}} page
   * @param {?{width: number, height: number}} dims - Page dimensions when the page object carries none.
   * @param {string} query
   * @returns {?{dims: {width: number, height: number}, rects: Array<{left: number, top: number, right: number, bottom: number}>, per: number}}
   */
  const getMatchRects = (page, dims, query) => {
    if (!page || !Array.isArray(page.lines) || !dims) return null;
    const tokens = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length);
    if (!tokens.length) return null;
    const words = [];
    for (const line of page.lines) for (const w of (line.words || [])) if (w && w.text && w.bbox) words.push(w);
    const norm = (s) => s.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    const rects = [];
    for (let i = 0; i + tokens.length <= words.length; i++) {
      let ok = true;
      for (let j = 0; j < tokens.length; j++) {
        const t = norm(words[i + j].text);
        if (!(j === tokens.length - 1 ? t.startsWith(tokens[j]) : t === tokens[j])) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      for (let j = 0; j < tokens.length; j++) rects.push(words[i + j].bbox);
    }
    return { dims: page.dims || dims, rects, per: tokens.length };
  };

  /**
   * @param {?ReturnType<typeof getMatchRects>} m
   * @returns {string} Absolutely positioned percent-unit mark spans, the first occurrence in the active color.
   */
  const markOverlayHTML = (m) => {
    if (!m || !m.rects.length) return '';
    let html = '';
    for (let i = 0; i < m.rects.length; i++) {
      const r = m.rects[i];
      const act = i < m.per ? ' act' : '';
      html += `<span class="scribe-mark${act}" style="left:${(r.left / m.dims.width) * 100}%;top:${(r.top / m.dims.height) * 100}%;`
        + `width:${((r.right - r.left) / m.dims.width) * 100}%;height:${((r.bottom - r.top) / m.dims.height) * 100}%;"></span>`;
    }
    return html;
  };

  /**
   * The split shell shared by the search-results view and the list-view preview: a resizable left column, a drag sash, and room for the caller-appended right pane.
   * @param {number} defaultWidth
   * @param {() => number} getWidth
   * @param {(w: number) => void} setWidth
   */
  const buildPreviewSplit = (defaultWidth, getWidth, setWidth) => {
    const wrap = document.createElement('div');
    wrap.className = 'scribe-library-results';
    wrap.style.setProperty('--scribe-library-rlist-w', `${getWidth()}px`);
    const left = document.createElement('div');
    left.className = 'scribe-library-rlist';
    wrap.appendChild(left);
    const sash = document.createElement('div');
    sash.className = 'scribe-library-rsplit';
    sash.setAttribute('role', 'separator');
    sash.setAttribute('aria-orientation', 'vertical');
    sash.setAttribute('aria-label', 'Resize the preview split');
    sash.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;
      const startW = left.getBoundingClientRect().width;
      sash.classList.add('drag');
      wrap.classList.add('rsplit-drag');
      const onMove = (ev) => {
        // Clamp to the same bounds as the CSS width clamp so dragging past an edge has no dead travel on the way back.
        setWidth(Math.round(Math.max(280, Math.min(startW + ev.clientX - startX, wrap.getBoundingClientRect().width - 320))));
        wrap.style.setProperty('--scribe-library-rlist-w', `${getWidth()}px`);
      };
      const onUp = () => {
        sash.classList.remove('drag');
        wrap.classList.remove('rsplit-drag');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });
    sash.addEventListener('dblclick', () => {
      setWidth(defaultWidth);
      wrap.style.setProperty('--scribe-library-rlist-w', `${defaultWidth}px`);
    });
    wrap.appendChild(sash);
    return { wrap, left };
  };

  /** @type {?Object} The single mounted preview pane (results view or list view), or null. */
  let mountedPane = null;

  /**
   * The right-side preview pane shared by search results and the list views.
   * The embedded viewer is read-only and seeded through `openProvisional`, so it paints before the document has been imported.
   * @param {string} emptyText
   * @param {string} prevLabel
   * @param {string} nextLabel
   */
  const buildPreviewPane = (emptyText, prevLabel, nextLabel) => {
    const pane = document.createElement('div');
    pane.className = 'scribe-library-pv';
    pane.innerHTML = '<div class="scribe-library-pv-head" style="display:none;"><span class="t"></span><span class="m"></span><span class="grow"></span>'
      + `<button class="scribe-library-pv-zoom" type="button" data-zoom-out aria-label="Zoom out" title="Zoom out">${ZOOM_OUT_SVG}</button>`
      + `<button class="scribe-library-pv-zoom" type="button" data-zoom-in aria-label="Zoom in" title="Zoom in">${ZOOM_IN_SVG}</button>`
      + `<span class="scribe-library-pv-find">${FIELD_SEARCH_SVG}<input type="text" placeholder="Find" aria-label="Find in the previewed document"></span>`
      + '<span class="vertical-separator"></span>'
      + '<button class="scribe-library-pv-open" type="button">Open<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8"/></svg></button>'
      + '<button class="scribe-library-pv-x" type="button" aria-label="Close preview"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
      + 'stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg></button></div>'
      + `<div class="scribe-library-pv-stage"><div class="scribe-library-pv-empty">${emptyText}</div><div class="scribe-library-pv-viewer" style="display:none;"></div></div>`
      + `<div class="scribe-library-pv-foot" style="display:none;"><button type="button" data-prev>${prevLabel}</button><button type="button" data-next>${nextLabel}</button>`
      + '<span class="grow"></span><span data-pos></span></div>';
    const pvHead = /** @type {HTMLElement} */ (pane.querySelector('.scribe-library-pv-head'));
    const pvEmpty = /** @type {HTMLElement} */ (pane.querySelector('.scribe-library-pv-empty'));
    const pvHost = /** @type {HTMLElement} */ (pane.querySelector('.scribe-library-pv-viewer'));
    const pvFoot = /** @type {HTMLElement} */ (pane.querySelector('.scribe-library-pv-foot'));
    const pvFindInput = /** @type {HTMLInputElement} */ (pane.querySelector('.scribe-library-pv-find input'));
    /** @type {?import('../basic-viewer/pdf-viewer.js').ScribePDFViewer} */
    let paneViewer = null;
    let token = 0;
    /** @type {?{relPath: string, hash: string, pageN: number, query: ?string, handle: ?Object, window: ?{from: number, to: number}}} */
    let current = null;
    /** True when the shown document has session edits that are not yet in its sidecar. */
    let paneDirty = false;
    /** @type {?Object} Last show target, for re-seeding after a doc handoff. */
    let lastTarget = null;

    /**
     * Land on the target page and paint (or clear) the query's match marks.
     * A seeded document only has words for its window pages, so the marks stay partial until hydration re-runs this.
     * @param {{pageN: number, query: ?string}} target
     */
    const applyQueryAndPage = async (target) => {
      const ps = /** @type {NonNullable<typeof paneViewer>} */ (paneViewer).scribe;
      if (target.query) {
        ps.state.searchMode = true;
        findText(ps, target.query);
        const idx = ps._searchState.matchList.findIndex((m) => m.pageN === target.pageN);
        if (idx >= 0) await goToMatch(ps, idx);
        else await ps.displayPage(target.pageN, true, false);
      } else {
        if (ps._searchState.search) findText(ps, '');
        ps.state.searchMode = false;
        await ps.displayPage(target.pageN, true, false);
      }
    };

    /** @type {HTMLElement} */ (pane.querySelector('[data-zoom-in]')).addEventListener('click', () => {
      if (paneViewer?.doc) paneViewer.scribe.zoom(1.1, paneViewer.scribe.getViewportCenter());
    });
    /** @type {HTMLElement} */ (pane.querySelector('[data-zoom-out]')).addEventListener('click', () => {
      if (paneViewer?.doc) paneViewer.scribe.zoom(0.9, paneViewer.scribe.getViewportCenter());
    });
    let pvFindLast = '';
    const pvClearFind = () => {
      pvFindLast = '';
      if (!paneViewer?.doc) return;
      const ps = paneViewer.scribe;
      if (ps._searchState.search) findText(ps, '');
      ps.state.searchMode = false;
    };
    const pvRunFind = async () => {
      if (!paneViewer?.doc) return;
      const ps = paneViewer.scribe;
      const q = pvFindInput.value.trim();
      if (!q) return;
      if (q !== pvFindLast) {
        pvFindLast = q;
        ps.state.searchMode = true;
        findText(ps, q);
        const idx = ps._searchState.matchList.findIndex((m) => m.pageN >= ps.state.cp.n);
        await goToMatch(ps, idx >= 0 ? idx : 0);
      } else {
        await goToMatch(ps, ps._searchState.activeMatch + 1);
      }
    };
    pvFindInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        pvRunFind();
      } else if (e.key === 'Escape' && pvFindInput.value) {
        e.preventDefault();
        e.stopPropagation();
        pvFindInput.value = '';
        pvClearFind();
      }
    });
    pvFindInput.addEventListener('input', () => {
      if (!pvFindInput.value.trim()) pvClearFind();
    });

    /**
     * Release the pane's current document, saving one that holds session edits back to its sidecar.
     * A still-provisional document finishes loading first, since the swap into the real document is what carries its annotations.
     * @param {?string} hash
     */
    const releaseDoc = (hash) => {
      if (!paneViewer || !paneViewer.doc) return;
      const doc = paneViewer.doc;
      const dirty = paneDirty;
      paneDirty = false;
      // A clean hydrated document goes back to the session pool instead of closing, so returning to it is free.
      if (!dirty && hash && doc.id >= 0) {
        paneViewer._tabs.length = 0;
        paneViewer._activeTab = -1;
        paneViewer._renderTabs();
        paneViewer.detachDoc({ terminate: false });
        sessions.adoptLive(hash, doc);
        return;
      }
      if (!dirty || !hash || !store) {
        if (paneViewer._tabs.length) paneViewer._closeTab(0);
        return;
      }
      paneViewer._tabs.length = 0;
      paneViewer._activeTab = -1;
      paneViewer._renderTabs();
      paneViewer.detachDoc({ terminate: false });
      (async () => {
        /** @type {?Object} */
        let real = null;
        try {
          real = doc.id < 0 ? await /** @type {any} */ (doc)._requestHydration() : doc;
          await /** @type {LibraryStore} */ (store).writeSidecar(hash, await /** @type {any} */ (real).exportData('scribe', { scribeSession: true }));
          sessions.dropSidecar(hash);
          sessions.adoptLive(hash, /** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */ (real));
        } catch {
          await /** @type {any} */ (real || doc).close?.();
        }
      })().catch(() => {});
    };

    const showEmpty = () => {
      token++;
      endVeil();
      releaseDoc(current ? current.hash : null);
      current = null;
      lastTarget = null;
      pvHead.style.display = 'none';
      pvFoot.style.display = 'none';
      pvHost.style.display = 'none';
      pvEmpty.textContent = emptyText;
      pvEmpty.style.display = '';
    };

    /**
     * Preview a page in the embedded viewer, painting match marks when a query is given.
     * A `jump` target lands on far pages by re-seeding; without it, a page outside the seeded window accelerates the full load as scrolling there would.
     * @param {{relPath: string, hash: string, entry: import('./libraryStore.js').LibraryDocEntry,
     *   pageN: number, query: ?string, title: string, meta: string, pos: string, jump?: boolean}} target
     */
    /** @type {?number} */
    let dwellTimer = null;
    const DWELL_LOAD_MS = 2500;

    /**
     * Arm the dwell load.
     * Lingering on a page with no stored raster is what loads the image, so rapid flipping stays free.
     * @param {{hash: string, pageN: number}} target
     * @param {number} t
     */
    const armDwell = async (target, t) => {
      if (dwellTimer !== null) {
        clearTimeout(dwellTimer);
        dwellTimer = null;
      }
      if (!store || !paneViewer?.doc || paneViewer.doc.id >= 0) return;
      if (await store.readPageRaster(target.hash, target.pageN)) return;
      if (t !== token) return;
      dwellTimer = window.setTimeout(() => {
        dwellTimer = null;
        if (t === token && paneViewer?.doc && paneViewer.doc.id < 0) /** @type {any} */ (paneViewer.doc)._requestHydration?.();
      }, DWELL_LOAD_MS);
    };

    /** @type {?{elem: HTMLElement, timers: number[]}} */
    let veil = null;

    /**
     * Remove the veil.
     * With `v` given, only when it is still the one that call created.
     * @param {HTMLElement} [v]
     */
    const endVeil = (v) => {
      if (!veil || (v && veil.elem !== v)) return;
      for (const timer of veil.timers) clearTimeout(timer);
      veil.elem.remove();
      veil = null;
    };

    /**
     * Freeze the pane's current pixels while the next target prepares underneath, so the swap reveals already anchored.
     * A dim after 400ms signals a slow preparation, and a 2s cap reveals whatever exists rather than reading as a dead click.
     * @returns {HTMLElement}
     */
    const beginVeil = () => {
      endVeil();
      const cover = document.createElement('div');
      cover.className = 'scribe-library-pv-veil';
      const rect = pvHost.getBoundingClientRect();
      if (rect.width && rect.height) {
        const snap = document.createElement('canvas');
        const dpr = window.devicePixelRatio || 1;
        snap.width = Math.round(rect.width * dpr);
        snap.height = Math.round(rect.height * dpr);
        const ctx = snap.getContext('2d');
        if (ctx) {
          ctx.scale(dpr, dpr);
          let drew = false;
          for (const c of pvHost.querySelectorAll('canvas')) {
            const cr = c.getBoundingClientRect();
            if (!cr.width || !cr.height || cr.bottom < rect.top || cr.top > rect.bottom) continue;
            try {
              ctx.drawImage(c, cr.left - rect.left, cr.top - rect.top, cr.width, cr.height);
              drew = true;
            } catch { /* A zero-sized or unreadable canvas leaves that page blank in the freeze. */ }
          }
          // A background image rather than a canvas child, so anything polling for the viewer's canvases never matches the veil.
          if (drew) cover.style.backgroundImage = `url(${snap.toDataURL()})`;
        }
      }
      const timers = [
        window.setTimeout(() => { cover.style.opacity = '0.5'; }, 400),
        window.setTimeout(() => endVeil(cover), 2000),
      ];
      pvHost.appendChild(cover);
      veil = { elem: cover, timers };
      return cover;
    };

    const show = async (target) => {
      const t = ++token;
      if (!current || current.hash !== target.hash) {
        pvFindInput.value = '';
        pvFindLast = '';
      }
      pvHead.style.display = '';
      pvFoot.style.display = '';
      /** @type {HTMLElement} */ (pvHead.querySelector('.t')).textContent = target.title;
      /** @type {HTMLElement} */ (pvHead.querySelector('.m')).textContent = target.meta;
      /** @type {HTMLElement} */ (pvFoot.querySelector('[data-pos]')).textContent = target.pos;
      pvEmpty.style.display = 'none';
      pvHost.style.display = '';
      if (!paneViewer) {
        paneViewer = new /** @type {any} */ (viewer.constructor)(pvHost, {
          edit: false, showToolbar: false, showDropZone: false, showThumbnails: false, fit: 'width',
        });
        // The pane must never compete with the main viewer for canvas memory.
        /** @type {NonNullable<typeof paneViewer>} */ (paneViewer).scribe.imageCache.canvasCacheBytes = 64 * 1024 * 1024;
        /** @type {any} */ (pvHost).scribeViewer = paneViewer;
        // Annotation gestures and comment text edits in the pane checkpoint like tab edits do.
        /** @type {NonNullable<typeof paneViewer>} */ (paneViewer).scribe.onAnnotationsEdited = () => { paneDirty = true; };
        pvHost.addEventListener('input', () => { paneDirty = true; }, true);
      }
      lastTarget = target;
      try {
        // Clicking a result on a far page of the same provisional document re-seeds around that page instead of forcing the full load.
        const jumpOutsideSeed = !!(current && paneViewer.doc && paneViewer.doc.id < 0
          && target.jump && current.window
          && (target.pageN < current.window.from || target.pageN > current.window.to));
        if (current && current.hash === target.hash && paneViewer.doc && !jumpOutsideSeed) {
          // A re-render landing on the same page and query must leave the reader's scroll and paint untouched.
          const samePlace = current.pageN === target.pageN && current.query === target.query;
          current.pageN = target.pageN;
          current.query = target.query;
          if (samePlace) return;
          if (current.handle) await current.handle.primed;
          if (t !== token) return;
          await applyQueryAndPage(target);
          current.anchorTop = paneViewer.scribe.scrollContainer.scrollTop;
          endVeil();
          const entry = manifest?.docs[target.relPath];
          if (paneViewer.doc && paneViewer.doc.id >= 0 && entry) persistRasterWindow(paneViewer.doc, entry, target.pageN);
          else armDwell(target, t);
          return;
        }
        const pooled = sessions.takeLive(target.hash);
        if (pooled) {
          const cover = beginVeil();
          releaseDoc(current ? current.hash : null);
          current = null;
          await paneViewer._openDocAsTab(pooled, titleOf(target.relPath), { lastPage: target.pageN });
          if (t !== token) return;
          current = {
            relPath: target.relPath, hash: target.hash, pageN: target.pageN, query: target.query, handle: null, window: null,
          };
          await applyQueryAndPage(target);
          current.anchorTop = paneViewer.scribe.scrollContainer.scrollTop;
          endVeil(cover);
          const entry = manifest?.docs[target.relPath];
          if (entry) persistRasterWindow(paneViewer.doc, entry, target.pageN);
          return;
        }
        const seed = await makeSeed(target.relPath, target.entry, target.pageN);
        if (t !== token) return;
        const cover = beginVeil();
        const prevDoc = paneViewer.doc;
        /** @type {?{pages: Array<Array<Object>>, baseline: Set<number>}} */
        let carried = null;
        if (current && current.hash === target.hash && prevDoc && prevDoc.id < 0 && paneDirty) {
          // Re-seeding the same edited document carries its unsaved session annotations into the new seed, and the dirty flag stays for the real save.
          carried = {
            pages: prevDoc.annotations.pages.map((page) => page.map((a) => ({ ...a, bbox: { ...a.bbox } }))),
            baseline: new Set(prevDoc._annotBaseline),
          };
          if (paneViewer._tabs.length) paneViewer._closeTab(0);
        } else {
          releaseDoc(current ? current.hash : null);
        }
        current = null;
        const baseAnnots = seed.annots;
        const carriedPages = carried;
        const handle = await paneViewer.openProvisional(carriedPages ? {
          ...seed,
          annots: (n) => (carriedPages.baseline.has(n) || carriedPages.pages[n].length
            ? Promise.resolve(carriedPages.pages[n].map((a) => ({ ...a, bbox: { ...a.bbox } })))
            : Promise.resolve(baseAnnots ? baseAnnots(n) : null)),
        } : seed);
        if (t !== token) return;
        current = {
          relPath: target.relPath, hash: target.hash, pageN: target.pageN, query: target.query, handle, window: seed.window,
        };
        await handle.primed;
        if (t !== token) return;
        await applyQueryAndPage(target);
        current.anchorTop = paneViewer.scribe.scrollContainer.scrollTop;
        endVeil(cover);
        armDwell(target, t);
        handle.hydrated.then(() => {
          if (!(current && current.handle === handle && paneViewer?.doc)) return;
          const ps = /** @type {NonNullable<typeof paneViewer>} */ (paneViewer).scribe;
          const sc = ps.scrollContainer;
          // Once the reader scrolled away from the anchored spot, hydration must not yank them back.
          const readerMoved = current.anchorTop != null && Math.abs(sc.scrollTop - current.anchorTop) > 2;
          if (current.query) {
            // The swap rebuilt the word objects, so re-derive the matches from the real document at whatever page the reader has reached.
            ps.state.searchMode = true;
            findText(ps, current.query);
            if (!readerMoved) {
              const idx = ps._searchState.matchList.findIndex((m) => m.pageN === ps.state.cp.n);
              if (idx >= 0) {
                Promise.resolve(goToMatch(ps, idx)).then(() => {
                  if (current && current.handle === handle) current.anchorTop = sc.scrollTop;
                }).catch(() => {});
              }
            }
          }
          const entry = manifest?.docs[current.relPath];
          if (entry) persistRasterWindow(paneViewer.doc, entry, ps.state.cp.n);
        }).catch(() => {});
      } catch {
        if (t === token) {
          endVeil();
          pvHost.style.display = 'none';
          pvEmpty.textContent = 'This page could not be rendered.';
          pvEmpty.style.display = '';
        }
      }
    };

    const shownHash = () => (current ? current.hash : null);

    /**
     * Hand the pane's hydrated document to the caller for promotion into a main-viewer tab.
     * Returns null while the pane is still provisional or empty.
     * @returns {?import('../../js/containers/scribeDoc.js').ScribeDoc}
     */
    const takeHydratedDoc = () => {
      if (!paneViewer || !current || !paneViewer.doc || paneViewer.doc.id < 0) return null;
      const doc = paneViewer.doc;
      paneViewer._tabs.length = 0;
      paneViewer._activeTab = -1;
      paneViewer._renderTabs();
      paneViewer.detachDoc({ terminate: false });
      current = null;
      return doc;
    };

    /** Re-seed the last shown target, so the pane is not blank after a doc handoff. */
    const reshow = () => {
      if (lastTarget) show(lastTarget);
    };

    const destroy = () => {
      token++;
      endVeil();
      if (dwellTimer !== null) {
        clearTimeout(dwellTimer);
        dwellTimer = null;
      }
      releaseDoc(current ? current.hash : null);
      current = null;
      if (paneViewer) {
        paneViewer.destroy();
        paneViewer = null;
      }
      if (mountedPane === self) mountedPane = null;
    };

    const self = {
      pane,
      openBtn: /** @type {HTMLElement} */ (pane.querySelector('.scribe-library-pv-open')),
      closeBtn: /** @type {HTMLElement} */ (pane.querySelector('.scribe-library-pv-x')),
      prevBtn: /** @type {HTMLElement} */ (pane.querySelector('[data-prev]')),
      nextBtn: /** @type {HTMLElement} */ (pane.querySelector('[data-next]')),
      /** Which view hosts this pane ('results' | 'list'); reuse is only within a kind. */
      kind: '',
      /** The query the results view last rendered with, so a new search resets the pane. */
      shownQuery: '',
      /** @type {?() => void} Rebound on every host render; a reused pane must never stack listeners. */
      onOpen: null,
      /** @type {?() => void} */
      onClose: null,
      /** @type {?() => void} */
      onPrev: null,
      /** @type {?() => void} */
      onNext: null,
      show,
      showEmpty,
      shownHash,
      takeHydratedDoc,
      reshow,
      destroy,
      /** The embedded viewer, for routing the shared top-bar tools at the previewed doc. */
      viewerRef: () => paneViewer,
      /** Consume the dirty flag; the caller owns the save. */
      takeDirty: () => {
        const d = paneDirty;
        paneDirty = false;
        return d;
      },
      isDirty: () => paneDirty,
      /** Finish a provisional pane's load in place, so promotion adopts the document instead of the tab re-importing it. */
      finishHydration: async () => {
        const doc = /** @type {any} */ (paneViewer?.doc);
        if (doc && doc.id < 0 && doc._requestHydration) {
          await doc._requestHydration().catch(() => {});
        }
      },
    };
    self.openBtn.addEventListener('click', () => self.onOpen?.());
    self.closeBtn.addEventListener('click', () => self.onClose?.());
    self.prevBtn.addEventListener('click', () => self.onPrev?.());
    self.nextBtn.addEventListener('click', () => self.onNext?.());
    mountedPane = self;
    return self;
  };

  /**
   * The pane for a hosting view, reusing the mounted one when the same kind re-renders.
   * A List/Compact switch or an ingest-progress re-render must not tear down the embedded viewer or its painted pages.
   * @param {string} kind
   * @param {string} emptyText
   * @param {string} prevLabel
   * @param {string} nextLabel
   */
  const ensurePane = (kind, emptyText, prevLabel, nextLabel) => {
    if (mountedPane && mountedPane.kind === kind) return mountedPane;
    if (mountedPane) mountedPane.destroy();
    const pv = buildPreviewPane(emptyText, prevLabel, nextLabel);
    pv.kind = kind;
    return pv;
  };

  /** @type {?ReturnType<typeof buildPreviewPane>} Pane mounted by the list views, or null when absent. */
  let listPane = null;

  /**
   * Show a document in the list-view preview pane, remembering the spot across re-renders.
   * @param {string} relPath
   * @param {import('./libraryStore.js').LibraryDocEntry} entry
   * @param {number} pageN
   */
  const showListPreview = (relPath, entry, pageN, jump = true) => {
    if (!listPane) return;
    listPreviewPath = relPath;
    listPreviewPage = pageN;
    const pages = entry.pageCount || 1;
    listPane.show({
      relPath,
      hash: entry.hash,
      entry,
      pageN,
      query: null,
      title: titleOf(relPath),
      meta: `${pages} page${pages === 1 ? '' : 's'}`,
      pos: `Page ${pageN + 1} of ${pages}`,
      jump,
    });
  };

  const renderResults = () => {
    const results = /** @type {Array<{hash: string, pages: number[]}>} */ (fullTextResults);
    // The same result set reattaches the retained view untouched.
    if (resultsView && resultsView.results === results && resultsView.pv === mountedPane) {
      body.classList.add('results-mode');
      body.appendChild(resultsView.wrap);
      resultsView.attach();
      // Rasters may have landed since the rows were built (a preview, a full open), so blank rows retry.
      resultsView.repump();
      return;
    }
    if (resultsView) {
      resultsView.dispose();
      resultsView = null;
    }
    const myGen = ++resultsGen;
    body.classList.add('results-mode');
    const { wrap, left: listEl } = buildPreviewSplit(400, () => resultsListWidth, (w) => { resultsListWidth = w; });
    body.appendChild(wrap);
    listEl.tabIndex = 0;
    listEl.setAttribute('aria-label', 'Search results');

    const summary = document.createElement('div');
    summary.className = 'scribe-library-rsummary';
    const summaryN = document.createElement('span');
    summaryN.className = 'n';
    summaryN.textContent = results.length
      ? `${results.length} document${results.length === 1 ? '' : 's'}`
      : `No results for “${fullTextQuery}”`;
    summary.appendChild(summaryN);
    const backBtn = document.createElement('button');
    backBtn.className = 'scribe-library-back';
    backBtn.textContent = '‹ Back';
    backBtn.addEventListener('click', () => {
      fullTextResults = null;
      searchInput.value = '';
      searchField.classList.remove('has-text');
      filterText = '';
      render();
    });
    summary.appendChild(backBtn);
    listEl.appendChild(summary);

    const pv = ensurePane('results', 'Select a result to preview it here', '‹ Previous result', 'Next result ›');
    if (pv.shownQuery !== fullTextQuery) pv.showEmpty();
    pv.shownQuery = fullTextQuery;
    wrap.appendChild(pv.pane);

    const byHash = new Map();
    if (manifest) for (const [relPath, e] of Object.entries(manifest.docs)) byHash.set(e.hash, { relPath, entry: e });

    /** @type {Array<{relPath: string, entry: import('./libraryStore.js').LibraryDocEntry, hash: string, pageN: number, count: number, row: HTMLElement}>} */
    const hits = [];
    let active = -1;

    const selectHit = (i) => {
      active = i;
      hits.forEach((h, j) => h.row.classList.toggle('on', j === i));
      if (i < 0) {
        pv.showEmpty();
        return;
      }
      const h = hits[i];
      h.row.scrollIntoView({ block: 'nearest' });
      pv.show({
        relPath: h.relPath,
        hash: h.hash,
        entry: h.entry,
        pageN: h.pageN,
        query: fullTextQuery,
        title: titleOf(h.relPath),
        meta: `Page ${h.pageN + 1} · ${h.count} match${h.count === 1 ? '' : 'es'}`,
        pos: `Result ${i + 1} of ${hits.length}`,
        jump: true,
      });
    };

    const openActive = () => {
      if (active < 0) return;
      const h = hits[active];
      openEntry(h.relPath, h.entry, { pageN: h.pageN, query: fullTextQuery });
    };
    pv.onOpen = openActive;
    pv.onClose = () => selectHit(-1);
    pv.onPrev = () => { if (active > 0) selectHit(active - 1); };
    pv.onNext = () => { if (active < hits.length - 1) selectHit(active + 1); };
    listEl.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (active < hits.length - 1) selectHit(active + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (active > 0) selectHit(active - 1);
      } else if (e.key === 'Enter') {
        openActive();
      } else if (e.key === 'Escape') {
        selectHit(-1);
      }
    });

    /**
     * One hit row's thumbnail work item. `marks` caches the overlay HTML after the first sidecar read;
     * `warmed` records that the background warmer already spent its one render attempt on this page.
     * @typedef {{relPath: string, entry: import('./libraryStore.js').LibraryDocEntry, hash: string, pageN: number, img: HTMLElement, marks?: string, warmed?: boolean}} ThumbItem
     */
    /** @type {Array<ThumbItem>} */
    const thumbQueue = [];
    let thumbsRunning = false;
    /** @type {Array<ThumbItem>} Rows whose stored raster was absent at pump time, kept for the warmer and for repump retries. */
    const rasterless = [];
    let warmRunning = false;
    // The pump never imports a document: it paints stored rasters and sidecar marks, and leaves missing rasters to warmHits.
    const pumpThumbs = async () => {
      if (thumbsRunning) return;
      thumbsRunning = true;
      while (thumbQueue.length) {
        if (myGen !== resultsGen) break;
        const first = /** @type {NonNullable<typeof thumbQueue[0]>} */ (thumbQueue.shift());
        // Every queued page of this document reads in one sidecar pass.
        const batch = [first];
        for (let i = 0; i < thumbQueue.length;) {
          if (thumbQueue[i].hash === first.hash) batch.push(thumbQueue.splice(i, 1)[0]);
          else i++;
        }
        const needMarks = batch.filter((b) => b.marks === undefined);
        /** @type {?Map<number, {ocr: ?Object, annotations: ?Array<Object>}>} */
        let side = null;
        if (needMarks.length) {
          try {
            side = await sessions.sidecarPages(first.hash, needMarks.map((b) => b.pageN));
          } catch { /* An unreadable sidecar leaves the marks off. */ }
        }
        for (const t of batch) {
          if (myGen !== resultsGen) break;
          try {
            if (t.marks === undefined) {
              const page = side?.get(t.pageN)?.ocr ?? null;
              const pd = t.entry.pageDims?.[t.pageN];
              t.marks = markOverlayHTML(getMatchRects(page, pd ? { width: pd[0], height: pd[1] } : null, fullTextQuery));
            }
            const url = await sessions.pageImage(t.hash, t.pageN);
            if (myGen !== resultsGen) break;
            if (url || t.marks) t.img.innerHTML = `${url ? `<img alt="" src="${url}">` : ''}${t.marks}`;
            if (!url && !rasterless.includes(t)) rasterless.push(t);
          } catch { /* A failed read leaves the placeholder page blank. */ }
        }
      }
      thumbsRunning = false;
      if (myGen === resultsGen && rasterless.some((r) => !r.warmed)) warmHits();
    };

    // Renders the missing hit-page rasters, one bounded import at a time.
    // Each import restores that document's whole sidecar, so the gates below keep warming from running alongside a load the reader is waiting on.
    const warmHits = async () => {
      if (warmRunning) return;
      warmRunning = true;
      while (myGen === resultsGen && store) {
        if (store.rasterBytes !== null && store.rasterBytes > store.rasterBudget) break;
        if (document.visibilityState !== 'visible') {
          const resume = () => {
            document.removeEventListener('visibilitychange', resume);
            warmHits();
          };
          document.addEventListener('visibilitychange', resume);
          break;
        }
        const paneDoc = pv.viewerRef()?.doc;
        if (paneDoc && paneDoc.id < 0) {
          // A provisional preview can start its full load at any moment, so poll until it settles or closes.
          window.setTimeout(warmHits, 4000);
          break;
        }
        const busyHash = pv.shownHash();
        const idx = rasterless.findIndex((r) => !r.warmed && r.hash !== busyHash);
        if (idx < 0) break;
        const first = /** @type {ThumbItem} */ (rasterless.splice(idx, 1)[0]);
        const batch = [first];
        for (let i = 0; i < rasterless.length;) {
          if (!rasterless[i].warmed && rasterless[i].hash === first.hash) batch.push(rasterless.splice(i, 1)[0]);
          else i++;
        }
        const sidecarBytes = await store.sidecarSize(first.hash);
        if (sidecarBytes !== null && sidecarBytes > WARM_SIDECAR_LIMIT) {
          // Too big to import in the background, but the rows stay tracked so a preview or open can still fill them.
          for (const t of batch) {
            t.warmed = true;
            rasterless.push(t);
          }
          continue;
        }
        /** @type {?import('../../js/containers/scribeDoc.js').ScribeDoc} */
        let doc = null;
        let owned = false;
        try {
          doc = sessions.peekLive(first.hash);
          if (!doc) {
            const files = /** @type {Array<File>} */ ([await store.readFile(first.relPath)]);
            const sidecar = await store.readSidecar(first.hash);
            if (sidecar) files.push(new File([sidecar], `${first.hash}.scribe`));
            if (myGen !== resultsGen) break;
            doc = await scribeLib.openDocument(files, { deferText: true, skipFontOpt: true, pdfWorkerN: 1 });
            owned = true;
          }
          // Stored rasters are keyed by the ingested page order, so a document that no longer matches its entry must stay blank.
          if (doc.pageMetrics.length !== first.entry.pageCount) continue;
          for (const t of batch) {
            if (myGen !== resultsGen) break;
            t.warmed = true;
            if (!(await store.readPageRaster(t.hash, t.pageN))) {
              const raster = await doc.images.renderThumbnail(t.pageN, PAGE_RASTER_WIDTH, 0.75, true);
              if (!raster) continue;
              await store.writePageRaster(t.hash, t.pageN, raster);
            }
            thumbQueue.push(t);
            pumpThumbs();
          }
        } catch { /* A document that fails to open leaves its rows blank. */
        } finally {
          if (owned && doc) await doc.close().catch(() => {});
        }
      }
      warmRunning = false;
    };

    /**
     * @param {{relPath: string, entry: import('./libraryStore.js').LibraryDocEntry, hash: string}} docRef
     * @param {number} pageN
     * @param {{count: number, snippet: DocumentFragment}} info
     * @param {number} insertAt - Position in `hits`, so expanded rows keep list order for stepping.
     * @returns {HTMLElement}
     */
    const buildHitRow = (docRef, pageN, info, insertAt) => {
      const row = document.createElement('div');
      row.className = 'scribe-library-hit';
      const ph = document.createElement('span');
      ph.className = 'ph';
      row.appendChild(ph);
      const hm = document.createElement('span');
      hm.className = 'hm';
      const ht = document.createElement('span');
      ht.className = 'ht';
      ht.append(`Page ${pageN + 1} `);
      const htMeta = document.createElement('span');
      htMeta.className = 'm';
      htMeta.textContent = `· ${info.count} match${info.count === 1 ? '' : 'es'}`;
      ht.appendChild(htMeta);
      hm.appendChild(ht);
      const sn = document.createElement('span');
      sn.className = 'sn';
      sn.appendChild(info.snippet);
      hm.appendChild(sn);
      row.appendChild(hm);
      const hit = {
        relPath: docRef.relPath, entry: docRef.entry, hash: docRef.hash, pageN, count: info.count, row,
      };
      hits.splice(insertAt, 0, hit);
      row.addEventListener('click', () => {
        selectHit(hits.indexOf(hit));
        listEl.focus();
      });
      thumbQueue.push({
        relPath: docRef.relPath, entry: docRef.entry, hash: docRef.hash, pageN, img: ph,
      });
      return row;
    };

    (async () => {
      if (!store || !results.length) return;
      const infos = await Promise.all(results.map(async (result) => {
        const docRef = byHash.get(result.hash);
        if (!docRef) return null;
        const text = await store.readTextCache(result.hash).catch(() => null);
        if (text === null) return null;
        const pagesText = text.split('\f');
        const queryLower = fullTextQuery.toLowerCase();
        const perPage = result.pages.map((pageN) => {
          const pageText = pagesText[pageN] || '';
          const lower = pageText.toLowerCase();
          let needle = queryLower;
          const starts = [];
          let at = lower.indexOf(needle);
          if (at < 0) {
            needle = queryLower.split(/[^\p{L}\p{N}]+/u).find((t) => t.length >= 2) || '';
            at = needle ? lower.indexOf(needle) : -1;
          }
          while (at >= 0) {
            starts.push(at);
            at = lower.indexOf(needle, at + needle.length);
          }
          const snippet = document.createDocumentFragment();
          if (!starts.length) {
            snippet.append(pageText.slice(0, SNIPPET_RADIUS * 2));
          } else {
            const winStart = Math.max(0, starts[0] - SNIPPET_RADIUS);
            const winEnd = Math.min(pageText.length, starts[0] + needle.length + SNIPPET_RADIUS);
            let pos = winStart;
            if (winStart > 0) snippet.append('…');
            for (const s of starts) {
              if (s < winStart || s + needle.length > winEnd) continue;
              snippet.append(pageText.slice(pos, s));
              const bold = document.createElement('b');
              bold.textContent = pageText.slice(s, s + needle.length);
              snippet.appendChild(bold);
              pos = s + needle.length;
            }
            snippet.append(pageText.slice(pos, winEnd));
            if (winEnd < pageText.length) snippet.append('…');
          }
          return { pageN, count: Math.max(starts.length, 1), snippet };
        });
        const total = perPage.reduce((sum, pp) => sum + pp.count, 0);
        return {
          docRef: { relPath: docRef.relPath, entry: docRef.entry, hash: result.hash }, perPage, total,
        };
      }));
      if (myGen !== resultsGen) return;

      const ranked = /** @type {NonNullable<typeof infos[0]>[]} */ (infos.filter(Boolean));
      ranked.sort((a, b) => b.total - a.total);
      const totalMatches = ranked.reduce((sum, r) => sum + r.total, 0);
      summaryN.textContent = `${totalMatches} match${totalMatches === 1 ? '' : 'es'} · ${ranked.length} document${ranked.length === 1 ? '' : 's'}`;

      const appendDocGroup = (info) => {
        const d = info.docRef;
        const head = document.createElement('div');
        head.className = 'scribe-library-rdoc';
        head.append(`${titleOf(d.relPath)} `);
        const meta = document.createElement('span');
        meta.className = 'm';
        const dateMatch = /^(\d{4})-(\d{2})-(\d{2})[ _]/.exec(d.relPath.split('/').pop() || '');
        const datePart = dateMatch
          ? `${new Date(+dateMatch[1], +dateMatch[2] - 1, +dateMatch[3]).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} · `
          : '';
        meta.textContent = `${datePart}${d.entry.pageCount} page${d.entry.pageCount === 1 ? '' : 's'} · ${info.total} match${info.total === 1 ? '' : 'es'} on ${info.perPage.length} page${info.perPage.length === 1 ? '' : 's'}`;
        head.appendChild(meta);
        listEl.appendChild(head);
        const shownNow = info.perPage.slice(0, RESULT_PAGES_PER_DOC);
        for (const pp of shownNow) listEl.appendChild(buildHitRow(d, pp.pageN, pp, hits.length));
        const rest = info.perPage.slice(RESULT_PAGES_PER_DOC);
        if (rest.length) {
          const more = document.createElement('button');
          more.className = 'scribe-library-rmore';
          more.type = 'button';
          more.textContent = `+ ${rest.length} more page${rest.length === 1 ? '' : 's'}`;
          more.addEventListener('click', () => {
            // Anchor on the preceding row at click time: earlier expansions shift positions in `hits`.
            let prev = more.previousElementSibling;
            while (prev && !prev.classList.contains('scribe-library-hit')) prev = prev.previousElementSibling;
            let at = prev ? hits.findIndex((h) => h.row === prev) + 1 : hits.length;
            for (const pp of rest) {
              const row = buildHitRow(d, pp.pageN, pp, at);
              more.before(row);
              at++;
            }
            more.remove();
            pumpThumbs();
          });
          listEl.appendChild(more);
        }
      };

      const firstBatch = ranked.slice(0, RESULT_DOC_LIMIT);
      for (const info of firstBatch) appendDocGroup(info);
      const restDocs = ranked.slice(RESULT_DOC_LIMIT);
      if (restDocs.length) {
        const moreDocs = document.createElement('button');
        moreDocs.className = 'scribe-library-rmore';
        moreDocs.type = 'button';
        moreDocs.style.paddingLeft = '16px';
        moreDocs.textContent = `+ ${restDocs.length} more document${restDocs.length === 1 ? '' : 's'}`;
        moreDocs.addEventListener('click', () => {
          moreDocs.remove();
          for (const info of restDocs) appendDocGroup(info);
          pumpThumbs();
        });
        listEl.appendChild(moreDocs);
      }
      pumpThumbs();
    })();

    const pv2 = mountedPane;
    let listScrollTop = 0;
    let paneScrollTop = 0;
    let paneScrollLeft = 0;
    const paneScroller = () => {
      const host = /** @type {any} */ (pv2 && pv2.pane.querySelector('.scribe-library-pv-viewer'));
      return host?.scribeViewer?.scribe?.scrollContainer ?? null;
    };
    resultsView = {
      results,
      pv: pv2,
      wrap,
      snapshot: () => {
        listScrollTop = listEl.scrollTop;
        const sc = paneScroller();
        if (sc) {
          paneScrollTop = sc.scrollTop;
          paneScrollLeft = sc.scrollLeft;
        }
      },
      attach: () => {
        listEl.scrollTop = listScrollTop;
        const sc = paneScroller();
        if (sc) {
          sc.scrollTop = paneScrollTop;
          sc.scrollLeft = paneScrollLeft;
        }
      },
      repump: () => {
        if (myGen !== resultsGen || !rasterless.length) return;
        thumbQueue.push(...rasterless.splice(0));
        pumpThumbs();
      },
      dispose: () => {
        resultsGen++;
      },
    };
  };

  // --- Drag-to-reorder ----------------------------------------------------

  const blockTouchScroll = (e) => {
    if (dragState?.started) e.preventDefault();
  };

  /**
   * Insertion gap (0..cards.length) for a pointer position.
   * @param {HTMLElement[]} cards
   * @param {number} x
   * @param {number} y
   */
  const gapAt = (cards, x, y) => {
    let best = -1;
    let bestDist = Infinity;
    let bestRect = null;
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      const d = (x - (r.left + r.width / 2)) ** 2 + (y - (r.top + r.height / 2)) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = i;
        bestRect = r;
      }
    }
    if (best < 0) return 0;
    return best + (x > /** @type {DOMRect} */ (bestRect).left + /** @type {DOMRect} */ (bestRect).width / 2 ? 1 : 0);
  };

  const startDragVisuals = (d) => {
    d.started = true;
    const rect = d.cardElem.getBoundingClientRect();
    d.grabDX = d.startX - rect.left;
    d.grabDY = d.startY - rect.top;
    const clone = /** @type {HTMLElement} */ (d.cardElem.cloneNode(true));
    clone.style.width = '100%';
    clone.style.height = '100%';
    clone.style.boxSizing = 'border-box';
    // On document.body the ghost sits outside the viewer root, so it carries the scope class, theme, and font itself for the scoped card rules and tokens to apply.
    d.ghost = document.createElement('div');
    d.ghost.className = 'scribe-library-ghost scribe-pdf-viewer';
    const theme = viewer.pdfViewerElem.getAttribute('data-theme');
    if (theme) d.ghost.setAttribute('data-theme', theme);
    d.ghost.style.fontFamily = getComputedStyle(viewer.pdfViewerElem).fontFamily;
    d.ghost.style.width = `${rect.width}px`;
    d.ghost.style.height = `${rect.height}px`;
    d.ghost.appendChild(clone);
    document.body.appendChild(d.ghost);
    d.cardElem.classList.add('dragging');
    if (d.canReorder && mainGridElem) {
      d.line = document.createElement('div');
      d.line.className = 'scribe-library-insert-line';
      mainGridElem.appendChild(d.line);
      updateGap(d, true);
    }
    positionGhost(d);
    updateDropTarget(d);
  };

  const positionGhost = (d) => {
    if (d.ghost) {
      d.ghost.style.left = `${d.lastX - d.grabDX}px`;
      d.ghost.style.top = `${d.lastY - d.grabDY}px`;
    }
  };

  /**
   * Resolve the folder card, row, or ancestor breadcrumb under the pointer into the drag's move destination.
   * The document's own folder never targets, so dropping there reads as a no-op rather than a move.
   * @param {Object} d
   */
  const updateDropTarget = (d) => {
    const under = document.elementFromPoint(d.lastX, d.lastY);
    const target = under && /** @type {?HTMLElement} */ (under.closest('[data-dir-target]'));
    const cut = d.relPath.lastIndexOf('/');
    const parent = cut < 0 ? '' : d.relPath.slice(0, cut);
    const elem = target && target.dataset.dirTarget !== parent ? target : null;
    if (elem !== d.dropElem) {
      d.dropElem?.classList.remove('drop');
      d.dropElem = elem;
      d.dropElem?.classList.add('drop');
      if (d.line) d.line.style.display = d.dropElem ? 'none' : '';
    }
    d.dropDir = d.dropElem ? (d.dropElem.dataset.dirTarget ?? null) : null;
  };

  /** @param {Object} d @param {boolean} [force] - Commit the derived gap even under the hysteresis threshold. */
  const updateGap = (d, force = false) => {
    if (!mainGridElem || !d.line) return;
    const cards = /** @type {HTMLElement[]} */ ([...mainGridElem.querySelectorAll(':scope > .scribe-library-card:not(.folder)')]);
    const gap = gapAt(cards, d.lastX, d.lastY);
    if (gap !== d.gap && (force || d.sinceGap >= GAP_HYSTERESIS)) {
      d.gap = gap;
      d.sinceGap = 0;
      const anchor = cards[Math.min(gap, cards.length - 1)];
      if (anchor) {
        const before = gap < cards.length;
        d.line.style.left = `${before ? anchor.offsetLeft - 8 : anchor.offsetLeft + anchor.offsetWidth + 5}px`;
        d.line.style.top = `${anchor.offsetTop}px`;
        d.line.style.height = `${anchor.offsetHeight}px`;
      }
    }
  };

  const autoScrollTick = () => {
    const d = dragState;
    if (!d || !d.autoDir) {
      if (d) d.rafId = 0;
      return;
    }
    body.scrollTop += d.autoDir * AUTOSCROLL_SPEED;
    d.sinceGap += AUTOSCROLL_SPEED;
    updateGap(d);
    updateDropTarget(d);
    d.rafId = requestAnimationFrame(autoScrollTick);
  };

  const onDragMove = (e) => {
    const d = dragState;
    if (!d) return;
    d.sinceGap += Math.hypot(e.clientX - d.lastX, e.clientY - d.lastY);
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    if (!d.started) {
      const dist = Math.hypot(e.clientX - d.startX, e.clientY - d.startY);
      if (d.isTouch) {
        // Travel before the hold fires reads as a scroll.
        if (dist > LIFT_MOVE_SLOP) endDrag(false);
        return;
      }
      if (dist <= DRAG_THRESHOLD) return;
      startDragVisuals(d);
    }
    positionGhost(d);
    updateGap(d);
    updateDropTarget(d);
    if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > MENU_SLOP) d.moved = true;
    const bodyRect = body.getBoundingClientRect();
    if (e.clientY < bodyRect.top + AUTOSCROLL_EDGE) d.autoDir = -1;
    else if (e.clientY > bodyRect.bottom - AUTOSCROLL_EDGE) d.autoDir = 1;
    else d.autoDir = 0;
    if (d.autoDir && !d.rafId) d.rafId = requestAnimationFrame(autoScrollTick);
  };

  const onDragUp = () => endDrag(true);
  const onDragCancel = () => endDrag(false);

  /** @param {boolean} commit */
  const endDrag = (commit) => {
    const d = dragState;
    if (!d) return;
    dragState = null;
    window.clearTimeout(d.holdTimer);
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragUp);
    window.removeEventListener('pointercancel', onDragCancel);
    document.removeEventListener('touchmove', blockTouchScroll);
    if (d.rafId) cancelAnimationFrame(d.rafId);
    d.ghost?.remove();
    d.line?.remove();
    d.dropElem?.classList.remove('drop');
    d.cardElem.classList.remove('dragging');
    if (d.started) {
      suppressClickUntil = Date.now() + 350;
      if (d.isTouch) {
        lastTouchDragT = Date.now();
        // A lift released without ever dragging opens the card menu, the touch home for Remove.
        if (commit && !d.moved) {
          if (renderPending) {
            renderPending = false;
            render();
          }
          openCardMenu(d.startX, d.startY, d.relPath, d.cardElem);
          return;
        }
      }
      if (commit && d.dropDir != null && manifest) {
        const { relPath, dropDir } = d;
        renderPending = false;
        (async () => {
          const entry = manifest && manifest.docs[relPath];
          if (!entry || !store || !manifest) return;
          try {
            const moved = await store.moveFile(relPath, dropDir);
            delete manifest.docs[relPath];
            manifest.docs[moved.relPath] = entry;
            // The copy re-stamps the file; recording the new mtime avoids a pointless verify on the next scan.
            entry.mtime = moved.mtime;
            saveManifestSoon();
          } catch (err) {
            viewer._showToast(`Couldn't move “${titleOf(relPath)}” — ${err instanceof Error ? err.message : 'the file could not be moved'}.`);
          }
          selectedPaths.delete(relPath);
          render();
        })();
        return;
      }
      if (commit && d.canReorder && d.gap >= 0 && manifest) {
        const paths = gridPaths.slice();
        const fromIdx = paths.indexOf(d.relPath);
        const to = d.gap > fromIdx ? d.gap - 1 : d.gap;
        if (fromIdx >= 0 && to !== fromIdx) {
          paths.splice(fromIdx, 1);
          paths.splice(to, 0, d.relPath);
          // The displayed order becomes the manual order wholesale, so every doc in the folder gets a concrete position the first time one is placed.
          paths.forEach((p, i) => {
            const entry = manifest.docs[p];
            if (entry) entry.order = i;
          });
          saveManifestSoon();
          const beforeRects = new Map();
          for (const el of mainGridElem?.querySelectorAll(':scope > .scribe-library-card') ?? []) {
            beforeRects.set(/** @type {HTMLElement} */ (el).dataset.relPath, el.getBoundingClientRect());
          }
          renderPending = false;
          render();
          // Slide each card from its old slot so the move reads as a move.
          const moved = [];
          for (const el of mainGridElem?.querySelectorAll(':scope > .scribe-library-card') ?? []) {
            const prev = beforeRects.get(/** @type {HTMLElement} */ (el).dataset.relPath);
            if (!prev) continue;
            const now = el.getBoundingClientRect();
            const dx = prev.left - now.left;
            const dy = prev.top - now.top;
            if (!dx && !dy) continue;
            const elem = /** @type {HTMLElement} */ (el);
            elem.style.transition = 'none';
            elem.style.transform = `translate(${dx}px, ${dy}px)`;
            moved.push(elem);
          }
          // A synchronous layout read commits the translated positions before the slide-back transition arms.
          if (moved.length && mainGridElem) mainGridElem.getBoundingClientRect();
          for (const elem of moved) {
            elem.style.transition = `transform ${REORDER_SLIDE_MS}ms ease`;
            elem.style.transform = '';
            elem.addEventListener('transitionend', () => {
              elem.style.transition = '';
            }, { once: true });
          }
          return;
        }
      }
    }
    if (renderPending) {
      renderPending = false;
      render();
    }
  };

  /**
   * @param {PointerEvent} e
   * @param {string} relPath
   * @param {HTMLElement} card
   */
  const beginCardDrag = (e, relPath, card) => {
    if (dragState || fullTextResults || filterText.trim()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // A sloppy modifier-click must land as a selection click, never arm a reorder drag.
    if (e.shiftKey || e.ctrlKey || e.metaKey) return;
    if (e.target instanceof Element && e.target.closest('.actions')) return;
    const isTouch = e.pointerType !== 'mouse';
    dragState = {
      relPath,
      cardElem: card,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      started: false,
      moved: false,
      canReorder: sortMode === 'custom' && viewMode === 'grid',
      /** @type {?string} Move destination while over a folder or crumb; null means none. */
      dropDir: null,
      /** @type {?HTMLElement} */ dropElem: null,
      /** @type {?HTMLElement} */ ghost: null,
      /** @type {?HTMLElement} */ line: null,
      gap: -1,
      sinceGap: 0,
      autoDir: 0,
      rafId: 0,
      holdTimer: 0,
      isTouch,
      grabDX: 0,
      grabDY: 0,
    };
    if (isTouch) {
      dragState.holdTimer = window.setTimeout(() => {
        const d = dragState;
        if (d && !d.started) {
          startDragVisuals(d);
          document.addEventListener('touchmove', blockTouchScroll, { passive: false });
        }
      }, LIFT_HOLD_MS);
    }
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragUp);
    window.addEventListener('pointercancel', onDragCancel);
  };

  // --- Opening documents --------------------------------------------------

  /**
   * Route every document mutation through a dirty mark so checkpoint saves know this tab has edits.
   * @param {import('../../js/containers/scribeDoc.js').ScribeDoc} doc
   * @param {Object} tab
   */
  const wrapMutators = (doc, tab) => {
    for (const name of MUTATOR_METHODS) {
      const orig = /** @type {any} */ (doc)[name];
      if (typeof orig !== 'function') continue;
      /** @type {any} */ (doc)[name] = function markDirtyWrap(...args) {
        tab.libraryDirty = true;
        return orig.apply(this, args);
      };
    }
  };

  /**
   * @param {string} relPath
   * @param {import('./libraryStore.js').LibraryDocEntry} entry
   * @param {{pageN?: number, query?: string}} [target]
   */
  const openEntry = async (relPath, entry, target = {}) => {
    if (!store || !manifest) return;
    const openIdx = entry.hash ? viewer._tabs.findIndex((t) => t.libraryHash === entry.hash) : -1;
    if (openIdx >= 0) {
      entry.lastOpened = Date.now();
      saveManifestSoon();
      await viewer._activateTab(openIdx);
      if (target.pageN != null) await viewer.scribe.displayPage(target.pageN, true, false);
      if (target.query && viewer._searchBar) {
        viewer._searchBar.openSearch();
        viewer._searchBar.searchInputElem.value = target.query;
        await viewer._searchBar.runSearch(target.query, target.pageN);
      }
      return;
    }
    const pooled = entry.hash ? sessions.takeLive(entry.hash) : null;
    if (pooled) {
      entry.lastOpened = Date.now();
      saveManifestSoon();
      const tab = await viewer._openDocAsTab(pooled, titleOf(relPath), { libraryHash: entry.hash, lastPage: target.pageN ?? 0 });
      wrapMutators(pooled, tab);
      persistRasterWindow(pooled, entry, target.pageN ?? 0);
      if (target.query && viewer._searchBar) {
        viewer._searchBar.openSearch();
        viewer._searchBar.searchInputElem.value = target.query;
        await viewer._searchBar.runSearch(target.query, target.pageN);
      }
      return;
    }
    // Preview promotion: a pane already showing this document finishes its load and hands it to the tab, so Open never re-imports.
    if (mountedPane && mountedPane.shownHash() === entry.hash) {
      try {
        await mountedPane.finishHydration();
        const handoffDoc = mountedPane.takeHydratedDoc();
        if (handoffDoc) {
          entry.lastOpened = Date.now();
          saveManifestSoon();
          const tab = await viewer._openDocAsTab(handoffDoc, titleOf(relPath), { libraryHash: entry.hash, lastPage: target.pageN ?? 0 });
          if (mountedPane.takeDirty()) tab.libraryDirty = true;
          wrapMutators(handoffDoc, tab);
          persistRasterWindow(handoffDoc, entry, target.pageN ?? 0);
          mountedPane.reshow();
          if (target.query && viewer._searchBar) {
            viewer._searchBar.openSearch();
            viewer._searchBar.searchInputElem.value = target.query;
            await viewer._searchBar.runSearch(target.query, target.pageN);
          }
          return;
        }
        if (entry.pageDims) {
          entry.lastOpened = Date.now();
          saveManifestSoon();
          const seed = await makeSeed(relPath, entry, target.pageN);
          const handle = await viewer.openProvisional({ ...seed, hydration: 'eager' });
          const tab = viewer._tabs[viewer._activeTab];
          tab.libraryHash = entry.hash;
          if (target.query && viewer._searchBar) {
            viewer._searchBar.openSearch();
            viewer._searchBar.searchInputElem.value = target.query;
          }
          handle.hydrated.then(() => {
            wrapMutators(tab.doc, tab);
            persistRasterWindow(tab.doc, entry, target.pageN ?? 0);
            if (target.query && viewer._searchBar) viewer._searchBar.runSearch(target.query, target.pageN);
          }).catch(() => {});
          return;
        }
      } catch { /* Promotion failed; the plain open below covers it. */ }
    }
    /** @type {File} */
    let pdfFile;
    try {
      pdfFile = await store.readFile(relPath);
    } catch {
      entry.status = 'missing';
      saveManifestSoon();
      render();
      viewer._showToast(`Couldn't open “${titleOf(relPath)}” — the file is no longer at ${relPath}.`);
      return;
    }
    const files = [pdfFile];
    if (entry.hash) {
      const sidecar = await store.readSidecar(entry.hash);
      if (sidecar) files.push(new File([sidecar], `${entry.hash}.scribe`));
    }
    /** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
    let doc;
    try {
      doc = await scribeLib.openDocument(files, { deferText: true });
    } catch (err) {
      viewer._showToast(`Couldn't open “${titleOf(relPath)}” — ${err instanceof Error ? err.message : 'the file could not be loaded'}.`);
      return;
    }
    entry.lastOpened = Date.now();
    saveManifestSoon();
    // Opening straight at the target page, since a `lastPage: 0` open followed by a jump would visibly double-paint.
    const tab = await viewer._openDocAsTab(doc, titleOf(relPath), { libraryHash: entry.hash, lastPage: target.pageN ?? 0 });
    wrapMutators(doc, tab);
    persistRasterWindow(doc, entry, target.pageN ?? 0);
    if (target.query && viewer._searchBar) {
      viewer._searchBar.openSearch();
      viewer._searchBar.searchInputElem.value = target.query;
      await viewer._searchBar.runSearch(target.query, target.pageN);
    }
  };

  // --- Ingest wiring ------------------------------------------------------

  /** @type {?FileSystemDirectoryHandle} */
  let pendingHandle = null;

  /** @type {?number} Trailing debounce for grid rebuilds during bulk indexing. */
  let ingestRenderTimer = null;

  // Warm-lane gate inputs: the cushion renders only while the app is visible but idle, never on battery, and under a session cap when no power signal exists.
  const WARM_IDLE_MS = 30 * 1000;
  const WARM_SESSION_PAGES = 150;
  let lastInteraction = Date.now();
  const noteInteraction = () => { lastInteraction = Date.now(); };
  document.addEventListener('pointerdown', noteInteraction, true);
  document.addEventListener('keydown', noteInteraction, true);
  document.addEventListener('wheel', noteInteraction, { capture: true, passive: true });
  /** @type {?boolean} */
  let onBattery = null;
  const shell = /** @type {any} */ (window).electronAPI;
  shell?.getPowerState?.().then((/** @type {any} */ s) => { onBattery = !!s?.onBattery; }).catch(() => {});
  shell?.onPowerChanged?.((/** @type {any} */ s) => {
    onBattery = !!s?.onBattery;
    ingest?.start();
  });
  const onVisibilityChange = () => { ingest?.start(); };
  document.addEventListener('visibilitychange', onVisibilityChange);
  // The gate opening is not an event, so a slow tick is what resumes warm work once the reader goes idle.
  const warmTimer = window.setInterval(() => { ingest?.start(); }, 15 * 1000);

  /** @param {LibraryStore} s */
  const openLibrary = async (s) => {
    store = s;
    sessions.connect(s);
    currentDir = '';
    await store.init();
    manifest = await store.readManifest();
    index = LibraryIndex.deserialize(await store.readSearchIndex());
    if (!index.docs.length) {
      for (const entry of Object.values(manifest.docs)) {
        if (entry.status !== 'indexed' || !entry.hash) continue;
        const text = await store.readTextCache(entry.hash);
        if (text !== null) index.addDoc(entry.hash, text.split('\f'));
      }
      if (index.docs.length) saveIndexSoon();
    }
    ingest = new LibraryIngest(store, manifest, index, {
      onProgress: ({ done, total, current }) => {
        if (!current) {
          progressElem.style.display = 'none';
          render();
          return;
        }
        progressElem.style.display = 'flex';
        progressText.textContent = `Indexing ${done}/${total} — ${current}`;
      },
      onDocDone: () => {
        saveIndexSoon();
        // One rebuild per burst rather than per document, and never while results are shown.
        if (!visible || fullTextResults) return;
        if (ingestRenderTimer === null) {
          ingestRenderTimer = window.setTimeout(() => {
            ingestRenderTimer = null;
            if (visible && !fullTextResults) render();
          }, 300);
        }
      },
      warmGate: () => {
        if (document.visibilityState !== 'visible') return false;
        if (Date.now() - lastInteraction < WARM_IDLE_MS) return false;
        if (onBattery === true) return false;
        if (onBattery === null && ingest && ingest.warmPagesDone >= WARM_SESSION_PAGES) return false;
        return true;
      },
    });
    render();
    await ingest.scan();
    render();
    ingest.start();
  };

  /** @param {File[]} files */
  const startIngestFiles = async (files) => {
    if (!store || !ingest) return;
    const pdfs = files.filter((f) => (f.name || '').toLowerCase().endsWith('.pdf'));
    if (!pdfs.length) {
      viewer._showToast('The library holds PDFs — none of the dropped files were PDFs.');
      return;
    }
    for (const file of pdfs) {
      try {
        const relPath = await store.importSourceFile(file.name, file, currentDir);
        await ingest.enqueue(relPath, { size: file.size, mtime: file.lastModified });
      } catch (err) {
        viewer._showToast(`Couldn't add “${file.name}” — ${err instanceof Error ? err.message : 'the file could not be written'}.`);
      }
    }
    render();
    ingest.start();
  };

  // --- Event wiring -------------------------------------------------------

  homeTab.addEventListener('click', () => {
    if (visible) return;
    showSurface();
    render();
  });

  /** @type {?HTMLElement} */
  let openFolderItem = null;
  if (viewer._appMenu) {
    openFolderItem = viewer._appMenu.addAction('Open folder', FOLDER_SVG, async () => {
      /** @type {LibraryStore} */
      let s;
      try {
        s = await LibraryStore.connectNew();
      } catch {
        return; // Picker dismissed.
      }
      for (const tab of viewer._tabs) await saveTabIfDirty(tab);
      ingest?.cancel();
      if (manifestTimer !== null) {
        window.clearTimeout(manifestTimer);
        manifestTimer = null;
        if (store && manifest) store.writeManifest(manifest).catch(() => {});
      }
      if (indexTimer !== null) {
        window.clearTimeout(indexTimer);
        indexTimer = null;
        if (store) store.writeSearchIndex(index.serialize()).catch(() => {});
      }
      // Checkpoint saves write through the current store; tabs from the old folder must not save into the new one.
      for (const tab of viewer._tabs) {
        if (tab.libraryHash) tab.libraryHash = undefined;
      }
      sessions.reset();
      if (resultsView) {
        resultsView.dispose();
        resultsView = null;
      }
      selectedPaths.clear();
      selAnchor = null;
      filterText = '';
      searchInput.value = '';
      searchField.classList.remove('has-text');
      fullTextResults = null;
      pendingHandle = null;
      showSurface();
      await openLibrary(s);
    });
    // Sits directly under "Open file".
    viewer._appMenu.menuElem.insertBefore(openFolderItem, viewer._appMenu.menuElem.children[1] ?? null);
  }

  searchInput.addEventListener('input', () => {
    filterText = searchInput.value;
    searchField.classList.toggle('has-text', !!filterText);
    if (fullTextResults && !filterText) fullTextResults = null;
    if (!fullTextResults) render();
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const query = searchInput.value.trim();
    if (!query) return;
    fullTextQuery = query;
    fullTextResults = index.query(query);
    render();
  });
  clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    filterText = '';
    searchField.classList.remove('has-text');
    fullTextResults = null;
    render();
    searchInput.focus();
  });

  const SORT_LABELS = {
    name: 'Name', added: 'Date added', opened: 'Last opened', pages: 'Pages', custom: 'Custom',
  };
  const syncSortUI = () => {
    sortLabelElem.textContent = SORT_LABELS[sortMode];
    for (const item of sortItems) item.classList.toggle('on', item.dataset.mode === sortMode);
  };
  const closeSortMenu = () => {
    sortMenu.style.display = 'none';
    document.removeEventListener('pointerdown', onSortOutside);
    document.removeEventListener('keydown', onSortKey);
  };
  /** @param {PointerEvent} e */
  const onSortOutside = (e) => {
    if (!sortWrap.contains(/** @type {Node} */ (e.target))) closeSortMenu();
  };
  /** @param {KeyboardEvent} e */
  const onSortKey = (e) => {
    if (e.key !== 'Escape') return;
    closeSortMenu();
    sortBtn.focus();
  };
  sortBtn.addEventListener('click', () => {
    if (sortMenu.style.display !== 'none') {
      closeSortMenu();
      return;
    }
    syncSortUI();
    sortMenu.style.display = '';
    document.addEventListener('pointerdown', onSortOutside);
    document.addEventListener('keydown', onSortKey);
  });
  /** @param {Event} e */
  const onSortItemClick = (e) => {
    sortMode = /** @type {string} */ (/** @type {HTMLElement} */ (e.currentTarget).dataset.mode);
    sortDir = SORT_DEFAULT_DIR[sortMode];
    syncSortUI();
    closeSortMenu();
    sortBtn.focus();
    render();
  };
  for (const item of sortItems) item.addEventListener('click', onSortItemClick);
  const syncOthersItem = () => {
    othersItem.classList.toggle('on', showOthers);
    othersItem.setAttribute('aria-checked', String(showOthers));
  };
  syncOthersItem();
  othersItem.addEventListener('click', () => {
    showOthers = !showOthers;
    try {
      window.localStorage.setItem(OTHERS_STORAGE_KEY, showOthers ? '1' : '0');
    } catch { /* localStorage unavailable. */ }
    syncOthersItem();
    closeSortMenu();
    sortBtn.focus();
    render();
  });

  const syncViewUI = () => {
    gridViewBtn.classList.toggle('on', viewMode === 'grid');
    listViewBtn.classList.toggle('on', viewMode === 'list');
    compactViewBtn.classList.toggle('on', viewMode === 'compact');
    gridViewBtn.setAttribute('aria-pressed', String(viewMode === 'grid'));
    listViewBtn.setAttribute('aria-pressed', String(viewMode === 'list'));
    compactViewBtn.setAttribute('aria-pressed', String(viewMode === 'compact'));
    // Disabled rather than hidden in grid view, since a vanishing button would shift every control on the bar.
    previewBtn.disabled = viewMode === 'grid';
    previewBtn.classList.toggle('on', listPreviewOn && viewMode !== 'grid');
    previewBtn.setAttribute('aria-pressed', String(listPreviewOn));
  };
  syncViewUI();
  /** @param {'grid' | 'list' | 'compact'} mode */
  const setViewMode = (mode) => {
    if (viewMode === mode) return;
    viewMode = mode;
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, mode);
    } catch { /* localStorage unavailable. */ }
    syncViewUI();
    // The results view is mode-independent, so a toggle there must not rebuild anything.
    // The new mode applies when the reader goes back to the grid.
    if (!fullTextResults) render();
  };
  gridViewBtn.addEventListener('click', () => setViewMode('grid'));
  listViewBtn.addEventListener('click', () => setViewMode('list'));
  compactViewBtn.addEventListener('click', () => setViewMode('compact'));
  previewBtn.addEventListener('click', () => {
    listPreviewOn = !listPreviewOn;
    try {
      window.localStorage.setItem(PREVIEW_STORAGE_KEY, listPreviewOn ? '1' : '0');
    } catch { /* localStorage unavailable. */ }
    syncViewUI();
    if (!fullTextResults) render();
  });

  addBtn.addEventListener('click', () => {
    if (!store) return;
    fileInput.click();
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.length) startIngestFiles([...fileInput.files]);
    fileInput.value = '';
  });

  refreshBtn.addEventListener('click', async () => {
    if (!ingest) return;
    await ingest.scan();
    render();
    ingest.start();
  });

  cancelBtn.addEventListener('click', () => {
    ingest?.cancel();
    progressElem.style.display = 'none';
  });

  surface.addEventListener('dragover', (e) => {
    e.preventDefault();
    surface.classList.add('drag-over');
  });
  surface.addEventListener('dragleave', () => surface.classList.remove('drag-over'));
  surface.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    surface.classList.remove('drag-over');
    if (!store) return;
    startIngestFiles(await filesFromDropEvent(e));
  });

  // Word-text and comment edits commit through editable elements rather than ScribeDoc methods, so any input event marks the active library tab dirty.
  const onInput = () => {
    const tab = viewer._tabs[viewer._activeTab];
    if (tab?.libraryHash) tab.libraryDirty = true;
  };
  viewer.pdfViewerElem.addEventListener('input', onInput, true);
  // Pointer-made annotations commit without an input event or a ScribeDoc method, so the edit signal is what marks the tab dirty.
  viewer.scribe.onAnnotationsEdited = () => {
    const tab = viewer._tabs[viewer._activeTab];
    if (tab?.libraryHash) tab.libraryDirty = true;
  };
  const autosaveTimer = window.setInterval(() => {
    saveTabIfDirty(viewer._tabs[viewer._activeTab]);
  }, AUTOSAVE_INTERVAL_MS);

  const onPageHide = () => {
    for (const tab of viewer._tabs) saveTabIfDirty(tab);
  };
  window.addEventListener('pagehide', onPageHide);

  // Pointer and focus both feed the flag, since clicks on the pane's page land on non-focusable elements and leave focus where it was.
  let paneEngaged = false;
  const trackEngagement = (e) => {
    paneEngaged = !!(mountedPane && e.target instanceof Node && mountedPane.pane.contains(e.target));
  };
  surface.addEventListener('pointerdown', trackEngagement, true);
  surface.addEventListener('focusin', trackEngagement, true);

  // While the library has the window, this claims the shortcut ahead of the toolbar's find bar.
  const onFindShortcut = (e) => {
    if (!visible) return;
    if (!((e.key === 'f' || e.key === 'F') && (e.ctrlKey || e.metaKey) && !e.altKey)) return;
    e.preventDefault();
    e.stopPropagation();
    const paneFind = paneEngaged && mountedPane
      ? /** @type {?HTMLInputElement} */ (mountedPane.pane.querySelector('.scribe-library-pv-find input'))
      : null;
    const findTarget = paneFind || searchInput;
    findTarget.focus();
    findTarget.select();
  };
  document.addEventListener('keydown', onFindShortcut, true);

  viewer._libraryHooks = {
    docOpened: () => {
      if (visible) hideSurface();
    },
    emptied: () => {
      if (!visible) {
        showSurface();
        render();
      }
    },
    saveTabIfDirty,
    saveAllDirty: async () => {
      for (const tab of viewer._tabs) await saveTabIfDirty(tab);
    },
  };

  // --- Boot ---------------------------------------------------------------

  (async () => {
    const handle = await LibraryStore.restoreHandle();
    if (destroyed) return;
    if (handle) {
      const s = new LibraryStore(handle);
      if ((await s.permissionState()) === 'granted') {
        if (viewer._tabs.length === 0) {
          showSurface();
          render();
        }
        await openLibrary(s);
        return;
      }
      pendingHandle = handle;
    }
    if (viewer._tabs.length === 0) {
      showSurface();
      render();
    }
  })();

  return {
    destroy() {
      destroyed = true;
      renderPending = false;
      if (dragState) endDrag(false);
      if (visible) hideSurface();
      closeCardMenu();
      ingest?.cancel();
      resizeObserver.disconnect();
      hintObserver.disconnect();
      window.clearInterval(autosaveTimer);
      window.clearInterval(warmTimer);
      if (ingestRenderTimer !== null) {
        window.clearTimeout(ingestRenderTimer);
        ingestRenderTimer = null;
      }
      document.removeEventListener('pointerdown', noteInteraction, true);
      document.removeEventListener('keydown', noteInteraction, true);
      document.removeEventListener('wheel', noteInteraction, { capture: true });
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('keydown', onFindShortcut, true);
      viewer.pdfViewerElem.removeEventListener('input', onInput, true);
      // Flush, don't drop: a cancelled debounce would lose the last manifest/index update.
      if (manifestTimer !== null) {
        window.clearTimeout(manifestTimer);
        manifestTimer = null;
        if (store && manifest) store.writeManifest(manifest).catch(() => {});
      }
      if (indexTimer !== null) {
        window.clearTimeout(indexTimer);
        indexTimer = null;
        if (store) store.writeSearchIndex(index.serialize()).catch(() => {});
      }
      if (mountedPane) mountedPane.destroy();
      sessions.reset();
      if (resultsView) {
        resultsView.dispose();
        resultsView = null;
      }
      surface.remove();
      barTitle?.remove();
      barControls?.remove();
      if (viewer._tabStrip) {
        viewer._tabStrip.setPinnedTab(null);
        viewer._tabStripMinTabs = 2;
        viewer._renderTabs();
      }
      openFolderItem?.remove();
      viewer.scribe.onAnnotationsEdited = null;
      viewer._libraryHooks = null;
    },
  };
}
