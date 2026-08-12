// Full-screen library surface for the basic viewer: connect a folder, browse and search it, open documents into tabs, and keep edits flowing back into `.scribe` sidecars.
// Loaded by dynamic import behind the `library` option, so viewers without it never fetch this module or its styles.

import scribeLib from '../../scribe.js';
import { filesFromDropEvent } from '../js/dragAndDrop.js';
import { LibraryStore, folderNameProblem, titleOf } from './libraryStore.js';
import { LibraryIndex } from './librarySearch.js';
import { LibraryIngest } from './libraryIngest.js';
import { DocSessions } from './docSession.js';
import { buildPreviewSplit, createPreviewPanes } from './libraryPreviewPane.js';
import { createResultsView } from './libraryResultsView.js';
import { createDragReorder } from './libraryDragReorder.js';

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
const FOLDER_PLUS_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2.5h8a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M12 10.75v5M9.5 13.25h5"/></svg>';
// eslint-disable-next-line max-len
const REFRESH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M17.3 3v3.7H13.6"/></svg>';
// eslint-disable-next-line max-len
const IMPORT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v9M8.5 9.5 12 13l3.5-3.5"/><path d="M4.5 15.5V18a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-2.5"/></svg>';
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
const COLS_STORAGE_KEY = 'scribe-library-cols';

/**
 * List-view columns, left to right, per view mode.
 * Name carries no `def` because it is sized to fill whatever the other columns leave.
 */
const LIST_COLUMNS = {
  list: [{ min: 180 }, { min: 56, def: 90 }, { min: 56, def: 130 }, { min: 56, def: 130 }],
  compact: [{ min: 140 }, { min: 56, def: 80 }, { min: 56, def: 110 }, { min: 56, def: 120 }, { min: 56, def: 120 }],
};

/**
 * Column indexes in the order the layout drops them when there is no room left, least useful first.
 * A page count is the least of these, and Name is absent because it is the column everything else yields to.
 */
const COL_DROP_ORDER = { list: [1, 3, 2], compact: [1, 4, 3, 2] };

const SORT_DEFAULT_DIR = {
  name: 1, added: -1, opened: -1, pages: 1, custom: 1,
};

const AUTOSAVE_INTERVAL_MS = 60000;

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
/* Verb and crumb menus show their row icons outright, unlike the sort menu's hidden-until-checked marks. */
.scribe-pdf-viewer .scribe-library-new-menu .scribe-library-menu-item svg, .scribe-pdf-viewer .scribe-library-crumb-menu .scribe-library-menu-item svg { visibility: visible; color: var(--scribe-ink-2); }
.scribe-pdf-viewer .scribe-library-crumb-menu { left: 0; right: auto; }
.scribe-pdf-viewer .scribe-library-seg { display: inline-flex; height: 28px; border: 1px solid var(--scribe-line-strong); border-radius: 7px; overflow: hidden; background: var(--scribe-sunken); }
.scribe-pdf-viewer .scribe-library-seg button { width: 32px; border: none; background: none; color: var(--scribe-ink-3); padding: 5px 0; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
.scribe-pdf-viewer .scribe-library-seg button svg { width: 16px; height: 16px; }
.scribe-pdf-viewer .scribe-library-seg button:hover { color: var(--scribe-ink); }
.scribe-pdf-viewer .scribe-library-seg button.on { background: var(--scribe-surface); color: var(--scribe-accent); box-shadow: inset 0 0 0 1px var(--scribe-line-strong); }
.scribe-pdf-viewer .scribe-library-btn { padding: 6px 12px; border-radius: 6px; border: 1px solid color-mix(in srgb, var(--scribe-ink) 25%, transparent); background: var(--scribe-surface); color: var(--scribe-ink); cursor: pointer; font: inherit; font-size: 13px; }
.scribe-pdf-viewer .scribe-library-btn:hover { background: color-mix(in srgb, var(--scribe-ink) 8%, var(--scribe-surface)); }
.scribe-pdf-viewer .scribe-library-btn.primary { background: var(--scribe-accent); border-color: var(--scribe-accent); color: #fff; }
.scribe-pdf-viewer .scribe-library-progress { display: none; position: relative; height: 34px; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 0 12px 0 18px; font-size: 13px; background: var(--scribe-surface); border-bottom: 1px solid var(--scribe-line); }
.scribe-pdf-viewer .scribe-library-progress-count { font-weight: 600; color: var(--scribe-ink); white-space: nowrap; font-variant-numeric: tabular-nums; }
.scribe-pdf-viewer .scribe-library-progress-name { color: var(--scribe-ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.scribe-pdf-viewer .scribe-library-progress-stop { height: 24px; padding: 0 9px; border: none; border-radius: 7px; background: none; color: var(--scribe-ink-2); font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; }
.scribe-pdf-viewer .scribe-library-progress-stop:hover { background: var(--scribe-hover); color: var(--scribe-ink); }
.scribe-pdf-viewer .scribe-library-progress-stop:focus-visible { outline: 2px solid var(--scribe-accent); outline-offset: 1px; }
.scribe-pdf-viewer .scribe-library-progress-hair { position: absolute; left: 0; bottom: -1px; height: 2px; background: var(--scribe-accent); transition: width 0.28s ease; }
.scribe-pdf-viewer .scribe-library-body { flex: 1; overflow-y: auto; padding: 16px 18px; }
.scribe-pdf-viewer .scribe-library-body::-webkit-scrollbar { width: 7px; }
.scribe-pdf-viewer .scribe-library-body::-webkit-scrollbar-track { background: transparent; }
.scribe-pdf-viewer .scribe-library-body::-webkit-scrollbar-thumb { background: var(--scribe-scrollbar); border-radius: 6px; }
.scribe-pdf-viewer .scribe-library-section-label { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.6; margin: 4px 0 10px; }
.scribe-pdf-viewer .scribe-library-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 190px)); justify-content: center; gap: 14px; margin-bottom: 22px; position: relative; }
.scribe-pdf-viewer .scribe-library-card { border: 1px solid color-mix(in srgb, var(--scribe-ink) 14%, transparent); border-radius: 8px; background: var(--scribe-surface); cursor: pointer; overflow: hidden; display: flex; flex-direction: column; position: relative; touch-action: pan-y; user-select: none; }
/* The lifted item vacates its place rather than being removed, so the slot it held stays open for the length of the drag. */
.scribe-pdf-viewer .scribe-library-card.dragging, .scribe-pdf-viewer .scribe-library-row.dragging { visibility: hidden; }
/* A cloned list row brings no background of its own, so without this the ghost renders as bare floating text. */
.scribe-library-ghost { position: fixed; z-index: 100; pointer-events: none; background: var(--scribe-surface); box-shadow: 0 12px 28px rgba(0, 0, 0, 0.35); border-radius: 8px; overflow: hidden; font-size: 14px; color: var(--scribe-ink); transition: opacity 0.12s ease; }
.scribe-library-ghost.over-drop { opacity: 0.7; }
.scribe-pdf-viewer .scribe-library-insert-line { position: absolute; width: 3px; border-radius: 2px; background: var(--scribe-accent); z-index: 5; pointer-events: none; }
/* The :where() guard costs no specificity, so suppressing hover mid-drag cannot outrank the selected and drop rules below. */
.scribe-pdf-viewer .scribe-library-card:hover:where(.scribe-library-surface:not(.card-drag) *), .scribe-pdf-viewer .scribe-library-card:focus-visible { border-color: var(--scribe-accent); outline: none; }
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
.scribe-pdf-viewer .scribe-library-card:hover:where(.scribe-library-surface:not(.card-drag) *) .actions, .scribe-pdf-viewer .scribe-library-card:focus-within .actions { display: flex; }
.scribe-pdf-viewer .scribe-library-card .actions button { border: none; border-radius: 5px; background: rgba(20, 20, 20, 0.65); color: #fff; cursor: pointer; font-size: 12px; padding: 3px 7px; }
.scribe-pdf-viewer .scribe-library-body.list-mode { padding: 0; }
.scribe-pdf-viewer .scribe-library-lhead { position: sticky; top: 0; z-index: 2; display: grid; grid-template-columns: var(--scribe-library-cols, minmax(240px, 1fr) 70px 110px 110px 120px); min-width: min-content; align-items: stretch; height: 30px; padding: 0 8px; border-bottom: 1px solid var(--scribe-line); background: var(--scribe-surface); color: var(--scribe-ink-2); font-size: 12px; font-weight: 600; user-select: none; }
.scribe-pdf-viewer .scribe-library-lhead.cols-cf { grid-template-columns: var(--scribe-library-cols, minmax(260px, 1fr) 90px 130px 130px); }
/* The 8px edge and the 10px cell inset add up to the 18px gutter the rest of the library uses. */
.scribe-pdf-viewer .scribe-library-lhead > * { position: relative; display: flex; align-items: center; gap: 4px; min-width: 0; padding: 0 10px; white-space: nowrap; }
.scribe-pdf-viewer .scribe-library-lhead > [data-sort-key] { cursor: pointer; }
.scribe-pdf-viewer .scribe-library-lhead > [data-sort-key]:hover { background: var(--scribe-hover); color: var(--scribe-ink); }
.scribe-pdf-viewer .scribe-library-lhead > [data-sort-key]:focus-visible { outline: 2px solid var(--scribe-accent); outline-offset: -2px; }
.scribe-pdf-viewer .scribe-library-lhead .lbl { overflow: hidden; text-overflow: ellipsis; }
.scribe-pdf-viewer .scribe-library-lhead .ar { font-size: 10px; flex-shrink: 0; }
.scribe-pdf-viewer .scribe-library-lhead > .on { color: var(--scribe-ink); }
.scribe-pdf-viewer .scribe-library-hres { position: absolute; top: 0; right: -4px; width: 9px; height: 100%; z-index: 3; cursor: col-resize; touch-action: none; }
.scribe-pdf-viewer .scribe-library-hres::before { content: ''; position: absolute; left: 4px; top: 0; bottom: 0; width: 1px; background: var(--scribe-line); }
.scribe-pdf-viewer .scribe-library-hres:hover::before, .scribe-pdf-viewer .scribe-library-hres.drag::before { left: 3px; width: 3px; background: var(--scribe-accent); }
.scribe-pdf-viewer .scribe-library-hres:focus-visible { outline: 2px solid var(--scribe-accent); outline-offset: -1px; }
.scribe-pdf-viewer .scribe-library-cols-drag { user-select: none; }
.scribe-pdf-viewer .scribe-library-cols-drag * { cursor: col-resize !important; }
.scribe-pdf-viewer.scribe-coarse .scribe-library-hres { display: none; }
.scribe-pdf-viewer .scribe-library-row { display: grid; grid-template-columns: var(--scribe-library-cols, minmax(240px, 1fr) 70px 110px 110px 120px); min-width: min-content; align-items: center; height: 34px; padding: 0 8px; cursor: pointer; border-bottom: 1px solid color-mix(in srgb, var(--scribe-line) 55%, transparent); font-size: 13px; user-select: none; touch-action: pan-y; }
.scribe-pdf-viewer .scribe-library-row > * { min-width: 0; padding: 0 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.scribe-pdf-viewer .scribe-library-row:hover:where(.scribe-library-surface:not(.card-drag) *) { background: var(--scribe-hover); }
.scribe-pdf-viewer .scribe-library-row.selected { background: var(--scribe-active); box-shadow: inset 2px 0 0 var(--scribe-accent); }
.scribe-pdf-viewer .scribe-library-row.context { outline: 1px solid var(--scribe-accent); outline-offset: -1px; }
.scribe-pdf-viewer .scribe-library-row:focus-visible { outline: 2px solid var(--scribe-accent); outline-offset: -2px; }
.scribe-pdf-viewer .scribe-library-row .nm { display: flex; align-items: center; gap: 10px; min-width: 0; }
.scribe-pdf-viewer .scribe-library-row .nm .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 550; }
.scribe-pdf-viewer .scribe-library-row.cf { grid-template-columns: var(--scribe-library-cols, minmax(260px, 1fr) 90px 130px 130px); height: 64px; }
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
/* Columns the layout dropped to keep the name readable.
   Their tracks are gone, so the cells have to go with them. */
.scribe-pdf-viewer .scribe-library-cols-drop-1 .scribe-library-lhead > :nth-child(2), .scribe-pdf-viewer .scribe-library-cols-drop-1 .scribe-library-row > :nth-child(2) { display: none; }
.scribe-pdf-viewer .scribe-library-cols-drop-2 .scribe-library-lhead > :nth-child(3), .scribe-pdf-viewer .scribe-library-cols-drop-2 .scribe-library-row > :nth-child(3) { display: none; }
.scribe-pdf-viewer .scribe-library-cols-drop-3 .scribe-library-lhead > :nth-child(4), .scribe-pdf-viewer .scribe-library-cols-drop-3 .scribe-library-row > :nth-child(4) { display: none; }
.scribe-pdf-viewer .scribe-library-cols-drop-4 .scribe-library-lhead > :nth-child(5), .scribe-pdf-viewer .scribe-library-cols-drop-4 .scribe-library-row > :nth-child(5) { display: none; }
/* Dividers move width between columns, which is meaningless once the layout is dropping them to fit. */
.scribe-pdf-viewer .scribe-library-cols-dropped .scribe-library-hres { display: none; }
.scribe-pdf-viewer .scribe-library-results { flex: 1; display: flex; min-height: 0; min-width: 0; font-size: 13px; }
.scribe-pdf-viewer .scribe-library-rlist { width: clamp(280px, var(--scribe-library-rlist-w, 400px), calc(100% - 320px)); box-sizing: border-box; flex-shrink: 0; overflow-y: auto; border-right: 1px solid var(--scribe-line); background: var(--scribe-surface); outline: none; }
.scribe-pdf-viewer .scribe-library-rlist::-webkit-scrollbar { width: 5px; }
.scribe-pdf-viewer .scribe-library-rlist::-webkit-scrollbar-track { background: transparent; }
.scribe-pdf-viewer .scribe-library-rlist::-webkit-scrollbar-thumb { background: var(--scribe-scrollbar); border-radius: 6px; }
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
.scribe-pdf-viewer .scribe-library-pv-head { display: flex; align-items: center; gap: 8px; height: 40px; flex-shrink: 0; box-sizing: border-box; padding: 0 12px; background: var(--scribe-surface); border-bottom: 1px solid var(--scribe-line); }
.scribe-pdf-viewer .scribe-library-pv-head .t { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.scribe-pdf-viewer .scribe-library-pv-head .m { color: var(--scribe-ink-3); white-space: nowrap; }
.scribe-pdf-viewer .scribe-library-pv-head .grow { flex: 1; }
.scribe-pdf-viewer .scribe-library-pv-open { display: inline-flex; align-items: center; gap: 7px; height: 28px; padding: 0 10px; border-radius: 7px; border: none; background: none; color: var(--scribe-ink-2); font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; }
.scribe-pdf-viewer .scribe-library-pv-open:hover { background: var(--scribe-hover); color: var(--scribe-ink); }
.scribe-pdf-viewer .scribe-library-pv-open:disabled { opacity: 0.6; cursor: default; background: none; color: var(--scribe-ink-2); }
.scribe-pdf-viewer .scribe-library-pv-open svg { width: 15px; height: 15px; }
.scribe-pdf-viewer .scribe-library-pv-x { width: 28px; height: 28px; flex-shrink: 0; padding: 5px; border-radius: 7px; border: none; background: none; color: var(--scribe-ink-2); cursor: pointer; }
.scribe-pdf-viewer .scribe-library-pv-x:hover { background: var(--scribe-hover); color: var(--scribe-ink); }
.scribe-pdf-viewer .scribe-library-pv-x svg { width: 100%; height: 100%; display: block; }
.scribe-pdf-viewer .scribe-library-pv-zoom { width: 28px; height: 28px; flex-shrink: 0; padding: 5px; border-radius: 7px; border: none; background: none; color: var(--scribe-ink-2); cursor: pointer; }
.scribe-pdf-viewer .scribe-library-pv-zoom:hover { background: var(--scribe-hover); color: var(--scribe-ink); }
.scribe-pdf-viewer .scribe-library-pv-zoom svg { width: 100%; height: 100%; display: block; }
.scribe-pdf-viewer .scribe-library-pv-find { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 8px; background: var(--scribe-sunken); border: 1px solid var(--scribe-line-strong); border-radius: 5px; box-sizing: border-box; flex: 0 1 auto; min-width: 76px; }
.scribe-pdf-viewer .scribe-library-pv-find:focus-within { border-color: var(--scribe-accent); }
.scribe-pdf-viewer .scribe-library-pv-find > svg { width: 15px; height: 15px; color: var(--scribe-ink-3); flex-shrink: 0; }
.scribe-pdf-viewer .scribe-library-pv-find input { border: none; background: none; outline: none; color: var(--scribe-ink); font: inherit; font-size: 13px; width: 96px; min-width: 0; padding: 0; caret-color: var(--scribe-accent); }
.scribe-pdf-viewer .scribe-library-pv-find input::placeholder { color: var(--scribe-ink-3); }
.scribe-pdf-viewer .scribe-library-pv-stage { flex: 1; overflow: hidden; display: flex; position: relative; }
.scribe-pdf-viewer .scribe-library-pv-viewer { flex: 1; min-width: 0; min-height: 0; position: relative; }
.scribe-pdf-viewer .scribe-library-pv.scribe-library-pv-live .scribe-cmt-card { display: none !important; }
.scribe-pdf-viewer .scribe-library-pv-veil { position: absolute; inset: 0; z-index: 5; background-color: var(--scribe-canvas); background-size: 100% 100%; transition: opacity 0.15s; pointer-events: none; }
.scribe-pdf-viewer .scribe-library-pv-empty { color: var(--scribe-ink-3); font-size: 13px; margin: auto; }
.scribe-pdf-viewer .scribe-library-pv-loading { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: var(--scribe-ink-3); font-size: 13px; pointer-events: none; }
.scribe-pdf-viewer .scribe-library-pv-loading-spin { width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--scribe-ink-3); border-top-color: transparent; animation: scribe-library-pv-spin 0.8s linear infinite; }
@keyframes scribe-library-pv-spin { to { transform: rotate(360deg); } }
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
/* The folder name outranks its tally, so the tally gives up all of its width before the name gives up any. */
.scribe-pdf-viewer .scribe-library-row.folder .cnt { display: inline-flex; align-items: baseline; gap: 5px; color: var(--scribe-ink-3); font-size: 12.5px; flex-shrink: 1000; min-width: 0; overflow: hidden; white-space: nowrap; }
.scribe-pdf-viewer .scribe-library-row .fi { width: 18px; height: 18px; color: var(--scribe-ink-2); flex-shrink: 0; }
.scribe-pdf-viewer .scribe-library-row.cf .fthumb { width: 40px; height: 52px; display: flex; align-items: center; justify-content: center; color: var(--scribe-ink-2); flex-shrink: 0; }
.scribe-pdf-viewer .scribe-library-row.cf .fthumb .fi { width: 26px; height: 26px; }
.scribe-pdf-viewer .scribe-library-card.folder.drop { background: color-mix(in srgb, var(--scribe-accent) 14%, var(--scribe-surface)); border-color: var(--scribe-accent); box-shadow: inset 0 0 0 1px var(--scribe-accent); }
.scribe-pdf-viewer .scribe-library-row.folder.drop { background: color-mix(in srgb, var(--scribe-accent) 14%, var(--scribe-surface)); box-shadow: inset 0 0 0 2px var(--scribe-accent); }
.scribe-pdf-viewer .scribe-library-rename { font: inherit; color: var(--scribe-ink); background: var(--scribe-canvas); border: 1px solid var(--scribe-accent); border-radius: 4px; outline: none; box-sizing: border-box; padding: 0 3px; margin: -1px 0; min-width: 0; }
.scribe-pdf-viewer .scribe-library-card .title .scribe-library-rename { width: calc(100% - 20px); }
.scribe-pdf-viewer .scribe-library-row .scribe-library-rename { flex: 1 1 auto; width: 100%; }
.scribe-pdf-viewer .scribe-library-card.other { cursor: default; opacity: .55; }
.scribe-pdf-viewer .scribe-library-card.other:hover { border-color: color-mix(in srgb, var(--scribe-ink) 14%, transparent); }
.scribe-pdf-viewer .scribe-library-card.other .fthumb { aspect-ratio: 3 / 4; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--scribe-ink) 5%, var(--scribe-canvas)); color: var(--scribe-ink-3); }
.scribe-pdf-viewer .scribe-library-card.other .fthumb .fi { width: 46px; height: 46px; }
.scribe-pdf-viewer .scribe-library-row.other { cursor: default; opacity: .55; }
.scribe-pdf-viewer .scribe-library-row.other:hover { background: none; }
/* Placed after the inert-item rungs above so a live drag still reads as a drag over them. */
.scribe-pdf-viewer .scribe-library-surface.card-drag, .scribe-pdf-viewer .scribe-library-surface.card-drag * { cursor: grabbing; }
/* Keep these rungs last in the stylesheet, since a base rule declared later out-cascades one at equal specificity. */
.scribe-pdf-viewer .scribe-library-pv-head { container: scribe-pv / inline-size; }
/* A pane dragged toward its 320px minimum would otherwise push Close past the right edge. */
@container scribe-pv (max-width: 470px) {
  .scribe-pdf-viewer .scribe-library-pv-head .m { display: none; }
}
@container scribe-pv (max-width: 400px) {
  .scribe-pdf-viewer .scribe-library-pv-head .vertical-separator { display: none; }
}
@container scribe-pv (max-width: 350px) {
  .scribe-pdf-viewer .scribe-library-pv-find { min-width: 58px; }
  .scribe-pdf-viewer .scribe-library-pv-find > svg { display: none; }
}
.scribe-pdf-viewer .scribe-library-bar { container: scribe-bar / inline-size; }
@container scribe-bar (max-width: 820px) {
  .scribe-pdf-viewer .scribe-library-sort-lbl { display: none; }
}
@container scribe-bar (max-width: 730px) {
  .scribe-pdf-viewer .scribe-library-add-lbl { display: none; }
  .scribe-pdf-viewer .scribe-library-new svg.chev { display: none; }
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
  /** @type {{list: ?number[], compact: ?number[]}} List column widths in px, null until the first list render sizes them. */
  const colWidths = { list: null, compact: null };
  /** Whether the user has resized a column in each mode, which a seeded width alone does not set. */
  const colSized = { list: false, compact: false };
  try {
    const stored = JSON.parse(window.localStorage.getItem(COLS_STORAGE_KEY) || '{}');
    for (const mode of ['list', 'compact']) {
      const w = stored[mode];
      if (Array.isArray(w) && w.length === LIST_COLUMNS[mode].length && w.every((n) => Number.isFinite(n) && n > 0)) {
        colWidths[mode] = w.map((n) => Math.round(n));
        colSized[mode] = true;
      }
    }
  } catch { /* localStorage unavailable, or the stored value is not JSON. */ }
  let colDragActive = false;
  let colRenderPending = false;
  let colSuppressClickUntil = 0;
  /** @type {?ResizeObserver} Repaints the list columns when the panel around them changes width. */
  let colsObserver = null;
  let colSettleTimer = 0;
  let colProjectRaf = 0;
  let filterText = '';
  /** Directory shown while browsing, relative to the library root; '' is the root itself. */
  let currentDir = '';
  /** @type {?Array<{hash: string, pages: number[]}>} Full-text results, or null for the browse grid. */
  let fullTextResults = null;
  let fullTextQuery = '';
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
  /**
   * A folder create or rename in flight.
   * Refresh scans, new drags, and further folder operations wait for it.
   */
  let fsOpBusy = false;
  /** Set while a folder-rename editor is mounted, so a second editor cannot open over it. */
  let renameEditing = false;
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

  // The label and chevron shed at the bar's narrow rung, leaving the plain icon form.
  const newWrap = document.createElement('span');
  newWrap.className = 'scribe-library-sort scribe-library-new';
  const newBtn = document.createElement('button');
  newBtn.className = 'scribe-library-hbtn';
  newBtn.innerHTML = `${PLUS_SVG}<span class="scribe-library-add-lbl">New</span>${CHEVRON_SVG}`;
  newBtn.title = 'New';
  newBtn.setAttribute('aria-label', 'New');
  newBtn.setAttribute('aria-haspopup', 'menu');
  const newMenu = document.createElement('div');
  newMenu.className = 'scribe-library-menu scribe-library-new-menu';
  newMenu.setAttribute('role', 'menu');
  newMenu.style.display = 'none';
  const newFolderItem = document.createElement('div');
  newFolderItem.className = 'scribe-library-menu-item';
  newFolderItem.setAttribute('role', 'menuitem');
  newFolderItem.innerHTML = FOLDER_PLUS_SVG;
  newFolderItem.appendChild(document.createTextNode('New folder'));
  newMenu.appendChild(newFolderItem);
  const newMenuSep = document.createElement('div');
  newMenuSep.className = 'scribe-library-menu-sep';
  newMenu.appendChild(newMenuSep);
  const addPdfsItem = document.createElement('div');
  addPdfsItem.className = 'scribe-library-menu-item';
  addPdfsItem.setAttribute('role', 'menuitem');
  addPdfsItem.innerHTML = IMPORT_SVG;
  addPdfsItem.appendChild(document.createTextNode('Add PDFs…'));
  newMenu.appendChild(addPdfsItem);
  newWrap.appendChild(newBtn);
  newWrap.appendChild(newMenu);
  header.appendChild(newWrap);

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
  const progressCount = document.createElement('span');
  progressCount.className = 'scribe-library-progress-count';
  progressElem.appendChild(progressCount);
  const progressName = document.createElement('span');
  progressName.className = 'scribe-library-progress-name';
  progressElem.appendChild(progressName);
  const stopBtn = document.createElement('button');
  stopBtn.className = 'scribe-library-progress-stop';
  stopBtn.textContent = 'Stop';
  progressElem.appendChild(stopBtn);
  const progressHair = document.createElement('div');
  progressHair.className = 'scribe-library-progress-hair';
  progressElem.appendChild(progressHair);

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
    // A phone-layout boot re-homes the app menu into the dock, so only anchor on it while it is still in the start zone.
    const menuInBar = viewer._appMenu && viewer._appMenu.menuWrap.parentElement === viewer.toolbarElemStart;
    viewer.toolbarElemStart.insertBefore(barTitle, menuInBar ? viewer._appMenu.menuWrap.nextSibling : viewer.toolbarElemStart.firstChild);
    barControls = document.createElement('span');
    barControls.className = 'scribe-library-bar-controls';
    barControls.style.display = 'none';
    for (const el of [searchField, viewSeg, sortWrap, previewBtn, headerSep, newWrap, refreshBtn]) barControls.appendChild(el);
    // A desktop shell's window controls stay the end zone's last element, so the library bar mounts before them.
    viewer.toolbarElemEnd.insertBefore(barControls, viewer.toolbarElemEnd.querySelector('.scribe-shell-corner'));
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

  /** Replace the toolbar's document controls with the library's own fragments, leaving the app menu and any shell window controls in place. */
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
      if (el !== barControls && !el.classList.contains('scribe-shell-corner')) hide(/** @type {HTMLElement} */ (el));
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
    swapBarIn();
    viewer._tabStrip?.setPinnedActive(true);
    surface.style.display = 'flex';
    // A show that arrived while the surface was hidden only recorded its target, so replay it now that the pane has real dimensions.
    panes.mounted()?.reshow();
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
      if (entry) panes.persistRasterWindow(tab.doc, entry, /** @type {any} */ (tab).lastPage ?? 0);
    }
    if (!tab || !tab.libraryHash || !tab.libraryDirty || tab.librarySaving || !store) return;
    tab.librarySaving = true;
    tab.libraryDirty = false;
    try {
      // Sidecars are this application's session store, so they carry app-side state (pending text edits, native-text metadata) that a default export drops.
      const data = await /** @type {any} */ (tab.doc).exportData('scribe', { scribeSession: true, includeCharBoxesScribe: false });
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
    const addSep = () => {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '›';
      crumbsElem.appendChild(sep);
    };
    // Collapsed ancestors stop being drop targets, the tradeoff for bounding the crumb width at any depth.
    const hidden = segs.length >= 3 ? segs.length - 2 : 0;
    if (hidden) {
      addSep();
      const midWrap = document.createElement('span');
      midWrap.className = 'scribe-library-sort';
      const midBtn = document.createElement('button');
      midBtn.className = 'scribe-library-crumb';
      midBtn.textContent = '…';
      midBtn.title = segs.slice(0, hidden).join(' › ');
      midBtn.setAttribute('aria-label', 'Hidden folders');
      midBtn.setAttribute('aria-haspopup', 'menu');
      const midMenu = document.createElement('div');
      midMenu.className = 'scribe-library-menu scribe-library-crumb-menu';
      midMenu.setAttribute('role', 'menu');
      midMenu.style.display = 'none';
      /** @param {PointerEvent} e */
      const onMidOutside = (e) => {
        if (!midWrap.contains(/** @type {Node} */ (e.target))) closeMid();
      };
      /** @param {KeyboardEvent} e */
      const onMidKey = (e) => {
        if (e.key === 'Escape') closeMid();
      };
      const closeMid = () => {
        midMenu.style.display = 'none';
        document.removeEventListener('pointerdown', onMidOutside);
        document.removeEventListener('keydown', onMidKey);
      };
      for (let i = 0; i < hidden; i++) {
        const item = document.createElement('div');
        item.className = 'scribe-library-menu-item';
        item.setAttribute('role', 'menuitem');
        item.innerHTML = FOLDER_SVG;
        // The shared folder glyph carries inline 100% sizing for card use, which would balloon in a menu row.
        /** @type {SVGElement} */ (item.querySelector('svg')).style.cssText = 'width:15px;height:15px;';
        item.appendChild(document.createTextNode(segs[i]));
        const path = segs.slice(0, i + 1).join('/');
        item.addEventListener('click', () => {
          closeMid();
          openDir(path);
        });
        midMenu.appendChild(item);
      }
      midBtn.addEventListener('click', () => {
        if (midMenu.style.display !== 'none') {
          closeMid();
          return;
        }
        midMenu.style.display = '';
        document.addEventListener('pointerdown', onMidOutside);
        document.addEventListener('keydown', onMidKey);
      });
      midWrap.appendChild(midBtn);
      midWrap.appendChild(midMenu);
      crumbsElem.appendChild(midWrap);
    }
    for (let i = hidden; i < segs.length; i++) {
      addSep();
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

  /** View identity of the last render, so a same-view rebuild can restore its scroll. */
  let lastRenderKey = '';

  /**
   * Rebuild the library surface for the current mode and state.
   * @param {{revealSelection?: boolean}} [opts] - `revealSelection` scrolls the previewed (or first selected) item into view, for returns from a doc tab.
   */
  const render = (opts) => {
    // A rebuild mid-drag would pull the dragged card out from under the pointer.
    if (drag.deferRender()) return;
    // A rebuild also replaces the header a column divider is sizing.
    if (colDragActive) {
      colRenderPending = true;
      return;
    }
    // A rebuild would tear down a mounted rename editor mid-typing.
    // Every editor exit ends in a render, so nothing is lost by skipping this one.
    if (renameEditing) return;
    // A settle pending from the outgoing list would commit its layout onto whatever mode renders next.
    window.clearTimeout(colSettleTimer);
    closeCardMenu();
    syncCrumbs();
    // The retained results view snapshots its scroll state before the detach below, so a reattach can restore it.
    results.snapshot();
    // The body wipe detaches a kept list pane, and a detached scroll container forgets its offset.
    const keptPane = !fullTextResults && listPreviewOn && viewMode !== 'grid' ? panes.mounted() : null;
    const keptPaneSc = keptPane && keptPane.kind === 'list' ? keptPane.viewerRef()?.scribe.scrollContainer : null;
    const keptPaneSpot = keptPaneSc ? { top: keptPaneSc.scrollTop, left: keptPaneSc.scrollLeft, doc: keptPane.viewerRef().doc } : null;
    const renderKey = fullTextResults
      ? 'results'
      : `browse|${currentDir}|${viewMode}|${listPreviewOn ? 1 : 0}|${sortMode}|${sortDir}|${filterText.trim().toLowerCase()}`;
    const keepScroll = !fullTextResults && renderKey === lastRenderKey;
    const priorBodyTop = keepScroll ? body.scrollTop : 0;
    const priorListTop = keepScroll ? (body.querySelector('.scribe-library-rlist')?.scrollTop ?? 0) : 0;
    lastRenderKey = renderKey;
    const revealSelection = !!(opts && opts.revealSelection);
    const restoreScroll = () => {
      if (keepScroll) {
        body.scrollTop = priorBodyTop;
        const rlist = body.querySelector('.scribe-library-rlist');
        if (rlist) rlist.scrollTop = priorListTop;
      }
      if (revealSelection) {
        const item = (listPreviewPath && body.querySelector(`[data-rel-path="${CSS.escape(listPreviewPath)}"]`))
          || body.querySelector('[data-rel-path].selected');
        item?.scrollIntoView({ block: 'nearest' });
      }
    };
    body.textContent = '';
    body.classList.remove('results-mode', 'list-mode', 'split-mode');
    listPane = null;
    // Tearing the pane down drops the embedded viewer and its painted pages, so it survives every re-render of a view that still hosts it.
    const pane = panes.mounted();
    if (pane && !fullTextResults && !(listPreviewOn && viewMode !== 'grid')) pane.destroy();
    if (!fullTextResults) results.dispose();
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
      results.render();
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
      empty.textContent = 'No PDFs in this folder yet. Drop files here or use “New › Add PDFs”.';
      body.appendChild(empty);
      return;
    }

    if (viewMode === 'list' || viewMode === 'compact') {
      drag.setMainGrid(null, []);
      const host = renderList(shownDirs, shown, shownOthers);
      if (keptPaneSpot && panes.mounted() === keptPane && keptPane.viewerRef()?.doc === keptPaneSpot.doc) {
        // renderList's re-show of the same spot takes the same-place fast path, which repaints nothing, so only this write-back restores the scroll.
        const sc = keptPane.viewerRef().scribe.scrollContainer;
        sc.scrollTop = keptPaneSpot.top;
        sc.scrollLeft = keptPaneSpot.left;
      }
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
      restoreScroll();
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
    drag.setMainGrid(grid, shown.map(([p]) => p));
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
    restoreScroll();
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
    if (drag.clickSuppressed()) return;
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
      addItem('Rename', false, () => startFolderRename(relPath.slice(0, -1), card));
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
    if (draggable) card.addEventListener('pointerdown', (e) => drag.beginCardDrag(e, relPath, card));

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
      if (drag.clickSuppressed()) return;
      openEntry(relPath, entry);
    };
    // Touch keeps tap-to-open; select-then-double-click is a pointer-and-keyboard scheme.
    card.addEventListener('click', (e) => {
      if (viewer._coarsePointer) {
        open();
        return;
      }
      if (drag.clickSuppressed()) return;
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
      if (drag.active() || drag.touchDragRecent()) return;
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
      if (drag.clickSuppressed()) return;
      openDir(dirPath);
    };
    card.addEventListener('click', (e) => {
      if (viewer._coarsePointer) {
        open();
        return;
      }
      if (drag.clickSuppressed()) return;
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
      else if (e.key === 'F2') {
        e.preventDefault();
        startFolderRename(dirPath, card);
      }
    });
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (drag.active()) return;
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
    row.addEventListener('pointerdown', (e) => drag.beginCardDrag(e, relPath, row));

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
      if (drag.clickSuppressed()) return;
      openEntry(relPath, entry);
    };
    row.addEventListener('click', (e) => {
      if (viewer._coarsePointer) {
        open();
        return;
      }
      if (drag.clickSuppressed()) return;
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
      if (drag.active() || drag.touchDragRecent()) return;
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
      if (drag.clickSuppressed()) return;
      openDir(dirPath);
    };
    row.addEventListener('click', (e) => {
      if (viewer._coarsePointer) {
        open();
        return;
      }
      if (drag.clickSuppressed()) return;
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
      else if (e.key === 'F2') {
        e.preventDefault();
        startFolderRename(dirPath, row);
      }
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (drag.active()) return;
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

  // --- Folder operations --------------------------------------------------

  /**
   * Swap the folder's title text for an input, committing on Enter or blur and cancelling on Escape.
   * A `fresh` folder was just created under a placeholder name, so cancelling removes it again while it is still empty.
   * @param {string} dirPath
   * @param {HTMLElement} hostElem - The folder's grid card or list row.
   * @param {boolean} [fresh]
   */
  const startFolderRename = (dirPath, hostElem, fresh = false) => {
    if (renameEditing || fsOpBusy) return;
    const target = hostElem.classList.contains('scribe-library-card')
      ? [...(hostElem.querySelector('.body .title')?.childNodes ?? [])].find((n) => n.nodeType === Node.TEXT_NODE)
      : hostElem.querySelector('.nm .t');
    if (!target) return;
    renameEditing = true;
    // The folder must not take drops mid-edit.
    // Every exit path below rebuilds, which restores the attribute.
    delete hostElem.dataset.dirTarget;
    const oldName = dirPath.split('/').pop() || dirPath;
    const input = document.createElement('input');
    input.className = 'scribe-library-rename';
    input.value = oldName;
    input.setAttribute('aria-label', 'Folder name');
    target.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    /** @param {boolean} save @param {boolean} [viaEnter] */
    const finish = async (save, viaEnter = false) => {
      if (done) return;
      const name = input.value.trim();
      if (save && name && name !== oldName) {
        const problem = folderNameProblem(name);
        if (!problem) {
          done = true;
          /** @type {HTMLInputElement} */ (input).disabled = true;
          renameEditing = false;
          await commitFolderRename(dirPath, name);
          return;
        }
        viewer._showToast(`Couldn't rename “${oldName}” — ${problem}.`);
        if (viaEnter) {
          // The reader is mid-typing, so an invalid Enter keeps the editor open for a correction.
          input.select();
          return;
        }
      }
      done = true;
      renameEditing = false;
      if (fresh && !save) {
        // The removal is non-recursive, so it refuses if anything landed inside while the editor was open.
        try {
          const cut = dirPath.lastIndexOf('/');
          const parent = await store?.dirAt(cut < 0 ? '' : dirPath.slice(0, cut));
          await parent?.removeEntry(dirPath.slice(cut + 1));
          if (manifest?.dirs) manifest.dirs = manifest.dirs.filter((d) => d !== dirPath);
          saveManifestSoon();
        } catch { /* The folder gained contents, so it stays under its placeholder name. */ }
      }
      render();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true, true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
      e.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
    for (const type of ['click', 'dblclick', 'pointerdown']) input.addEventListener(type, (e) => e.stopPropagation());
    input.addEventListener('contextmenu', (e) => e.stopPropagation());
  };

  /**
   * Rename the folder on disk, then re-key every path-shaped record that pointed under it.
   * Entry objects move to their new keys untouched, so hashes, statuses, and custom order survive and nothing re-ingests.
   * @param {string} oldDirPath
   * @param {string} newName
   */
  const commitFolderRename = async (oldDirPath, newName) => {
    if (!store || !manifest || fsOpBusy) {
      render();
      return;
    }
    fsOpBusy = true;
    // A drag armed by the same pointerdown that blurred the editor must die before the disk move it could race.
    drag.cancel();
    if (ingest) ingest.paused = true;
    const cut = oldDirPath.lastIndexOf('/');
    const newDirPath = cut < 0 ? newName : `${oldDirPath.slice(0, cut)}/${newName}`;
    const oldName = oldDirPath.slice(cut + 1);
    /** @type {Map<string, number>} */
    let mtimes;
    try {
      mtimes = await store.renameDir(oldDirPath, newDirPath);
    } catch (err) {
      viewer._showToast(`Couldn't rename “${oldName}” — ${err instanceof Error ? err.message : 'the folder could not be renamed'}.`);
      if (ingest) {
        ingest.paused = false;
        // The failure may have left a partial transfer, and a scan reconciles whatever state the disk is in.
        await ingest.scan().catch(() => {});
      }
      fsOpBusy = false;
      render();
      ingest?.start();
      return;
    }
    /** @param {string} p */
    const rekey = (p) => {
      if (p === oldDirPath) return newDirPath;
      return p.startsWith(`${oldDirPath}/`) ? newDirPath + p.slice(oldDirPath.length) : p;
    };
    // No await may land inside this re-key, or the artifact sweep could observe an entry-less hash and delete its data files.
    for (const p of Object.keys(manifest.docs)) {
      const np = rekey(p);
      if (np === p) continue;
      const entry = manifest.docs[p];
      delete manifest.docs[p];
      manifest.docs[np] = entry;
      // The transfer stamps a fresh file time, and without the matching entry time the next scan would queue a pointless verify.
      entry.mtime = mtimes.get(np) ?? entry.mtime;
    }
    manifest.dirs = (manifest.dirs ?? []).map(rekey).sort();
    manifest.others = (manifest.others ?? []).map(rekey).sort();
    ingest?.renameDirPrefix(oldDirPath, newDirPath);
    const selected = [...selectedPaths];
    selectedPaths.clear();
    for (const p of selected) selectedPaths.add(p.endsWith('/') ? `${rekey(p.slice(0, -1))}/` : rekey(p));
    if (selAnchor) selAnchor = selAnchor.endsWith('/') ? `${rekey(selAnchor.slice(0, -1))}/` : rekey(selAnchor);
    if (listPreviewPath) listPreviewPath = rekey(listPreviewPath);
    currentDir = rekey(currentDir);
    try {
      await store.writeManifest(manifest);
    } catch {
      saveManifestSoon();
    }
    if (ingest) ingest.paused = false;
    fsOpBusy = false;
    render();
    ingest?.start();
  };

  /** Create a placeholder-named folder in the browsed directory and drop its card straight into rename. */
  const createNewFolder = async () => {
    if (!store || !manifest || fsOpBusy || renameEditing) return;
    // A filter or search hides folder cards, so creating one returns to the browse view first.
    if (fullTextResults || filterText) {
      fullTextResults = null;
      filterText = '';
      searchInput.value = '';
      searchField.classList.remove('has-text');
    }
    fsOpBusy = true;
    let relPath = '';
    try {
      relPath = await store.createDir('New folder', currentDir);
    } catch (err) {
      viewer._showToast(`Couldn't create a folder — ${err instanceof Error ? err.message : 'the folder could not be created'}.`);
      return;
    } finally {
      fsOpBusy = false;
    }
    // The card only mounts for listed dirs, so the manifest learns the path before the render below.
    manifest.dirs = [...(manifest.dirs ?? []), relPath].sort();
    saveManifestSoon();
    render();
    const host = /** @type {?HTMLElement} */ (body.querySelector(`[data-rel-path="${CSS.escape(`${relPath}/`)}"]`));
    if (!host) return;
    host.scrollIntoView({ block: 'nearest' });
    startFolderRename(relPath, host, true);
  };

  /**
   * Open the blank-area menu at the cursor, offering to create a folder in the browsed directory.
   * @param {number} clientX
   * @param {number} clientY
   */
  const openSurfaceMenu = (clientX, clientY) => {
    closeCardMenu();
    menuElem.replaceChildren();
    const item = document.createElement('div');
    item.className = 'scribe-thumb-menu-item';
    item.textContent = 'New folder';
    item.addEventListener('click', () => {
      closeCardMenu();
      createNewFolder();
    });
    menuElem.appendChild(item);
    menuElem.style.display = '';
    const hostRect = surface.getBoundingClientRect();
    const left = Math.min(clientX - hostRect.left, hostRect.width - menuElem.offsetWidth - 4);
    const top = Math.min(clientY - hostRect.top, hostRect.height - menuElem.offsetHeight - 4);
    menuElem.style.left = `${Math.max(4, left)}px`;
    menuElem.style.top = `${Math.max(4, top)}px`;
    setTimeout(() => document.addEventListener('pointerdown', onMenuOutside), 0);
    document.addEventListener('keydown', onMenuKey);
  };

  // Blank-area right-click is the thumbnail view's create gesture.
  // The list views use the New menu instead.
  body.addEventListener('contextmenu', (e) => {
    if (viewMode !== 'grid' || fullTextResults || filterText.trim()) return;
    if (!store || !manifest || fsOpBusy || renameEditing) return;
    if (drag.active() || drag.touchDragRecent()) return;
    if (/** @type {Element} */ (e.target).closest('.scribe-library-card, .scribe-library-row, .scribe-thumb-menu, button, input')) return;
    e.preventDefault();
    openSurfaceMenu(e.clientX, e.clientY);
  });

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
      listPane = panes.ensurePane('list', 'Select a document to preview it here');
      split.wrap.appendChild(listPane.pane);
      const previewEntry = () => (listPreviewPath && manifest ? manifest.docs[listPreviewPath] : null);
      listPane.onOpen = async () => {
        const entry = previewEntry();
        if (!entry || !listPreviewPath) return;
        const pane = listPane;
        if (!pane) return;
        const label = pane.openBtn.innerHTML;
        /** @type {HTMLButtonElement} */ (pane.openBtn).disabled = true;
        pane.openBtn.textContent = 'Opening…';
        try {
          await openEntry(listPreviewPath, entry, { pageN: listPreviewPage });
        } finally {
          pane.openBtn.innerHTML = label;
          /** @type {HTMLButtonElement} */ (pane.openBtn).disabled = false;
        }
      };
      listPane.onClose = () => {
        listPreviewPath = null;
        listPane?.showEmpty();
      };
      host = split.left;
    }
    const head = document.createElement('div');
    head.className = comfortable ? 'scribe-library-lhead cols-cf' : 'scribe-library-lhead';
    const rows = document.createElement('div');
    const cols = LIST_COLUMNS[viewMode];
    // Only a mode the user has resized is written, so the other keeps re-fitting Name to the window on later visits.
    const saveCols = () => {
      try {
        const sized = {};
        for (const mode of ['list', 'compact']) if (colSized[mode]) sized[mode] = colWidths[mode];
        window.localStorage.setItem(COLS_STORAGE_KEY, JSON.stringify(sized));
      } catch { /* localStorage unavailable. */ }
    };
    const availCols = () => host.clientWidth - 16;
    /** @type {?number[]} The widths currently on screen. */
    let colLaid = null;
    /** @type {?number[]} Content widths per column. */
    let colFits = null;
    /** @type {Set<number>} Columns dropped because showing them would have cost the name its width. */
    let colHidden = new Set();
    /** Width the middle row's name needs. */
    let colNameTypical = 0;
    const applyCols = (eff) => {
      colLaid = eff;
      host.style.setProperty('--scribe-library-cols', eff.filter((n, j) => !colHidden.has(j)).map((n) => `${n}px`).join(' '));
      for (let j = 1; j < cols.length; j++) host.classList.toggle(`scribe-library-cols-drop-${j}`, colHidden.has(j));
      host.classList.toggle('scribe-library-cols-dropped', colHidden.size > 0);
      [...head.children].forEach((cell, j) => cell.querySelector('.scribe-library-hres')?.setAttribute('aria-valuenow', String(eff[j])));
    };
    /**
     * Lay the stored widths out across the visible width.
     * The result always adds up to it exactly, so nothing can scroll sideways.
     * Any squeeze is display-only, so a width the reader chose returns once there is room.
     * @param {number} avail
     * @param {number} slackIdx - Column that gives and takes the difference first.
     * @returns {?number[]} The widths as laid out.
     */
    const paintCols = (avail, slackIdx) => {
      const stored = colWidths[viewMode];
      if (!stored || avail <= 0) {
        host.style.removeProperty('--scribe-library-cols');
        colLaid = null;
        return null;
      }
      const eff = stored.map((n, j) => Math.max(cols[j].min, Math.round(n)));
      let diff = avail - eff.reduce((sum, n) => sum + n, 0);
      const take = Math.max(cols[slackIdx].min - eff[slackIdx], diff);
      eff[slackIdx] += take;
      diff -= take;
      for (let j = eff.length - 1; j >= 0 && diff < 0; j--) {
        if (j !== slackIdx) {
          const give = Math.max(cols[j].min - eff[j], diff);
          eff[j] += give;
          diff -= give;
        }
      }
      applyCols(eff);
      return eff;
    };
    // Each row is its own grid, so all of them have to be read.
    const measureFits = () => {
      // A cell left hidden by the previous pass measures zero, so every column has to be on screen before reading.
      colHidden = new Set();
      for (let j = 1; j < cols.length; j++) host.classList.remove(`scribe-library-cols-drop-${j}`);
      host.classList.remove('scribe-library-cols-dropped');
      host.style.setProperty('--scribe-library-cols', cols.map(() => 'max-content').join(' '));
      const fit = cols.map(() => 0);
      const measure = (rowEl) => [...rowEl.children].forEach((cell, j) => {
        fit[j] = Math.max(fit[j], cell.getBoundingClientRect().width);
      });
      measure(head);
      const nameWidths = [];
      for (const row of rows.children) {
        measure(row);
        nameWidths.push(row.children[0].getBoundingClientRect().width);
      }
      // The widest name is one outlier away from being useless as a threshold, so the middle one stands in for the rows.
      nameWidths.sort((a, b) => a - b);
      colNameTypical = nameWidths.length ? Math.ceil(nameWidths[Math.floor(nameWidths.length / 2)]) : 0;
      return fit.map(Math.ceil);
    };
    /**
     * Fit the stored widths to the visible width outside a drag.
     * Extra room first restores columns squeezed below their content width, rightmost first, and the rest goes to Name.
     * A shortfall comes out of the whitespace each column holds above its content, in proportion to how much that is.
     * When that is not enough, whole columns are dropped rather than the name being cut.
     * @param {number} avail
     * @returns {?number[]} The widths as laid out.
     */
    const projectCols = (avail) => {
      const stored = colWidths[viewMode];
      if (!stored || avail <= 0) {
        host.style.removeProperty('--scribe-library-cols');
        colLaid = null;
        return null;
      }
      colHidden = new Set();
      const eff = stored.map((n, j) => Math.max(cols[j].min, Math.round(n)));
      let diff = avail - eff.reduce((sum, n) => sum + n, 0);
      if (diff !== 0 && !colFits) colFits = measureFits();
      const fits = colFits;
      if (diff > 0 && fits) {
        for (let j = eff.length - 1; j >= 1 && diff > 0; j--) {
          const give = Math.min(diff, Math.max(0, fits[j] - eff[j]));
          eff[j] += give;
          diff -= give;
        }
      }
      if (diff > 0) {
        eff[0] += diff;
      } else if (diff < 0) {
        let need = -diff;
        // A column showing a two-digit page count holds far more whitespace than a title that is already clipped, so spend whitespace before anything truncates.
        const air = eff.map((n, j) => (fits ? Math.max(0, n - Math.max(cols[j].min, fits[j])) : 0));
        const airTotal = air.reduce((sum, n) => sum + n, 0);
        if (airTotal > 0) {
          const spend = Math.min(need, airTotal);
          let acc = 0;
          let spent = 0;
          for (let j = 0; j < eff.length; j++) {
            acc += air[j];
            const give = Math.min(air[j], Math.round((acc * spend) / airTotal) - spent);
            eff[j] -= give;
            spent += give;
          }
          need -= spent;
        }
        // A page count squeezed to a stub is worth less than the name it would cost, so drop it whole instead.
        for (const j of COL_DROP_ORDER[viewMode]) {
          if (need <= 0) break;
          colHidden.add(j);
          need -= eff[j];
          eff[j] = 0;
        }
        // A drop usually frees more than was needed, and the name is where the surplus belongs.
        eff[0] = Math.max(cols[0].min, eff[0] - need);
      }
      // A page count is worth less than the name text it displaces even when it fits, so it also goes once half the names are cut off.
      if (fits && !colHidden.has(1) && eff[0] < colNameTypical) {
        colHidden.add(1);
        eff[0] += eff[1];
        eff[1] = 0;
      }
      applyCols(eff);
      return eff;
    };
    // A squeeze must not rewrite what the reader chose, so only growth settles into the stored widths.
    const settleColsIfGrown = () => {
      const stored = colWidths[viewMode];
      if (!stored || !colSized[viewMode] || !colLaid || colDragActive || colHidden.size) return;
      if (colLaid.reduce((sum, n) => sum + n, 0) >= stored.reduce((sum, n) => sum + n, 0)) {
        colWidths[viewMode] = colLaid.slice();
        saveCols();
      }
    };
    /**
     * Resize column `i` to `px`.
     * @param {number} i
     * @param {number} px
     * @param {number} avail
     */
    const resizeCol = (i, px, avail) => {
      const stored = colWidths[viewMode];
      if (!stored) return;
      colSized[viewMode] = true;
      let leftSum = 0;
      for (let j = 0; j < i; j++) leftSum += stored[j];
      let rightMin = 0;
      for (let j = i + 1; j < stored.length; j++) rightMin += cols[j].min;
      // Capping at the room the right-hand minimums leave is what keeps the last boundary inside the view.
      stored[i] = Math.max(cols[i].min, Math.min(avail - leftSum - rightMin, Math.round(px)));
      // Only this column is stored mid-gesture, so the squeeze the others take is undone if the drag comes back.
      paintCols(avail, stored.length - 1);
    };
    // Settling on the laid-out widths leaves the total already fitted, so a later re-render cannot shift the table.
    const commitCols = (avail) => {
      const w = colWidths[viewMode];
      if (!w) return;
      const eff = paintCols(avail, w.length - 1);
      if (eff) colWidths[viewMode] = eff;
    };
    const headCols = [['name', 'Name'], ['pages', 'Pages'], ['added', 'Added'], ['opened', 'Last opened']];
    if (!comfortable) headCols.push([null, 'Status']);
    headCols.forEach(([key, label], i) => {
      const cell = document.createElement('span');
      const lbl = document.createElement('span');
      lbl.className = 'lbl';
      lbl.textContent = label;
      cell.appendChild(lbl);
      if (key) {
        cell.tabIndex = 0;
        cell.setAttribute('role', 'button');
        cell.dataset.sortKey = key;
        // Only the sorted column carries an arrow, so the others keep their full width for the label.
        if (sortMode === key) {
          cell.className = 'on';
          const ar = document.createElement('span');
          ar.className = 'ar';
          ar.textContent = sortDir === 1 ? '▲' : '▼';
          cell.appendChild(ar);
        }
      }

      // The last column is the one that flexes to the right edge, so there is no boundary of its own to drag.
      if (i === headCols.length - 1) {
        head.appendChild(cell);
        return;
      }
      const handle = document.createElement('span');
      handle.className = 'scribe-library-hres';
      handle.tabIndex = 0;
      handle.setAttribute('role', 'separator');
      handle.setAttribute('aria-orientation', 'vertical');
      handle.setAttribute('aria-label', `Resize the ${label} column`);
      handle.setAttribute('aria-valuemin', String(cols[i].min));
      /** @param {number} px */
      const setW = (px) => resizeCol(i, px, availCols());
      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || !colWidths[viewMode]) return;
        e.preventDefault();
        // The screen can sit below the stored widths, so a drag re-anchors them to what the reader sees.
        if (colLaid) colWidths[viewMode] = colLaid.slice();
        const startX = e.clientX;
        const startW = cell.getBoundingClientRect().width;
        const avail = availCols();
        colDragActive = true;
        handle.classList.add('drag');
        host.classList.add('scribe-library-cols-drag');
        const onMove = (ev) => {
          colSuppressClickUntil = Date.now() + 350;
          resizeCol(i, startW + ev.clientX - startX, avail);
        };
        const onUp = () => {
          colDragActive = false;
          handle.classList.remove('drag');
          host.classList.remove('scribe-library-cols-drag');
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onUp);
          commitCols(avail);
          saveCols();
          if (colRenderPending) {
            colRenderPending = false;
            render();
          }
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
      });
      handle.addEventListener('dblclick', () => {
        if (!colWidths[viewMode]) return;
        if (colLaid) colWidths[viewMode] = colLaid.slice();
        const w = colWidths[viewMode];
        // Each row is its own grid, so all of them have to be read.
        const probe = w.map((n, j) => (j === i ? 'max-content' : `${n}px`));
        host.style.setProperty('--scribe-library-cols', probe.join(' '));
        let fit = cell.getBoundingClientRect().width;
        for (const row of rows.children) {
          const rc = row.children[i];
          if (rc) fit = Math.max(fit, rc.getBoundingClientRect().width);
        }
        setW(Math.ceil(fit));
        commitCols(availCols());
        saveCols();
      });
      handle.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        if (!colWidths[viewMode]) return;
        if (colLaid) colWidths[viewMode] = colLaid.slice();
        const w = colWidths[viewMode];
        setW(w[i] + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 4 : 16));
        commitCols(availCols());
        saveCols();
      });
      cell.appendChild(handle);
      head.appendChild(cell);
    });
    const onHeaderActivate = (e) => {
      if (!(e.target instanceof Element) || e.target.closest('.scribe-library-hres')) return;
      // A divider drag that starts and ends inside one cell still fires a click on it.
      if (Date.now() < colSuppressClickUntil) return;
      const cell = e.target.closest('[data-sort-key]');
      if (!(cell instanceof HTMLElement)) return;
      const key = cell.dataset.sortKey ?? 'name';
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
    for (const dir of shownDirs) rows.appendChild(buildFolderRow(dir));
    for (const [relPath, entry] of shown) rows.appendChild(buildRow(relPath, entry));
    for (const relPath of shownOthers) rows.appendChild(buildOtherRow(relPath));
    host.appendChild(rows);
    // Measure the scrolling host, never the header, which reports its own overflow once it carries wide tracks.
    const avail = availCols();
    if (avail > 0 && (!colSized[viewMode] || !colWidths[viewMode])) {
      // A flat default hands a one-to-three-digit page count the same width as a date, so the data columns are sized to their own content instead.
      if (!colFits) colFits = measureFits();
      const rest = cols.slice(1).map((c, j) => (colFits ? Math.max(c.min, colFits[j + 1]) : c.def));
      colWidths[viewMode] = [Math.max(cols[0].min, Math.round(avail - rest.reduce((sum, n) => sum + n, 0))), ...rest];
    }
    projectCols(avail);
    settleColsIfGrown();
    // The sash and the window resize without a render, so width changes reach the columns through this observer.
    colsObserver?.disconnect();
    colsObserver = new ResizeObserver(() => {
      if (colDragActive) return;
      // Painting inside the observer callback re-triggers it in the same delivery, which the browser reports as a resize-loop error.
      cancelAnimationFrame(colProjectRaf);
      colProjectRaf = requestAnimationFrame(() => {
        if (!colDragActive) projectCols(availCols());
      });
      window.clearTimeout(colSettleTimer);
      colSettleTimer = window.setTimeout(settleColsIfGrown, 250);
    });
    colsObserver.observe(host);
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

  /** @type {?Object} Preview pane mounted by the list views, or null when absent. */
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
      meta: `Page ${pageN + 1} of ${pages}`,
      jump,
    });
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

  /** Hashes (or paths, for legacy entries) with an open in flight, so a click storm during a slow load cannot stack duplicate imports. */
  const openingDocs = new Set();

  /**
   * @param {string} relPath
   * @param {import('./libraryStore.js').LibraryDocEntry} entry
   * @param {{pageN?: number, query?: string}} [target]
   */
  const openEntry = async (relPath, entry, target = {}) => {
    if (!store || !manifest) return;
    const openKey = entry.hash || relPath;
    if (openingDocs.has(openKey)) return;
    openingDocs.add(openKey);
    try {
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
        panes.persistRasterWindow(pooled, entry, target.pageN ?? 0);
        if (target.query && viewer._searchBar) {
          viewer._searchBar.openSearch();
          viewer._searchBar.searchInputElem.value = target.query;
          await viewer._searchBar.runSearch(target.query, target.pageN);
        }
        return;
      }
      // A pane already showing this document hands its loaded copy to the tab, so opening never re-imports.
      const pane = panes.mounted();
      if (pane && pane.shownHash() === entry.hash) {
        try {
          await pane.finishHydration();
          const handoffDoc = pane.takeHydratedDoc();
          if (handoffDoc) {
            entry.lastOpened = Date.now();
            saveManifestSoon();
            const tab = await viewer._openDocAsTab(handoffDoc, titleOf(relPath), { libraryHash: entry.hash, lastPage: target.pageN ?? 0 });
            if (pane.takeDirty()) tab.libraryDirty = true;
            wrapMutators(handoffDoc, tab);
            panes.persistRasterWindow(handoffDoc, entry, target.pageN ?? 0);
            if (target.query && viewer._searchBar) {
              viewer._searchBar.openSearch();
              viewer._searchBar.searchInputElem.value = target.query;
              await viewer._searchBar.runSearch(target.query, target.pageN);
            }
            return;
          }
        } catch { /* Promotion failed; the seeded open below covers it. */ }
      }
      // Stored page dims, rasters, and sidecar pages paint immediately while the real document hydrates behind them.
      // The tab also exists from the first click, so repeats activate it instead of starting another import.
      if (entry.pageDims) {
        entry.lastOpened = Date.now();
        saveManifestSoon();
        const seed = await panes.makeSeed(relPath, entry, target.pageN ?? 0);
        panes.beginUserLoad();
        /** @type {{primed: Promise<void>, hydrated: Promise<void>, cancel: () => void}} */
        let handle;
        try {
          handle = await viewer.openProvisional({ ...seed, hydration: 'eager' });
        } catch (err) {
          panes.endUserLoad();
          throw err;
        }
        handle.hydrated.catch(() => {}).finally(panes.endUserLoad);
        const tab = viewer._tabs[viewer._activeTab];
        tab.libraryHash = entry.hash;
        // At adoption time rather than on `hydrated`, so no edit can slip between the swap and dirty tracking.
        tab.onDocHydrated = (d) => wrapMutators(d, tab);
        if (target.query && viewer._searchBar) {
          viewer._searchBar.openSearch();
          viewer._searchBar.searchInputElem.value = target.query;
        }
        handle.hydrated.then(() => {
          panes.persistRasterWindow(tab.doc, entry, target.pageN ?? 0);
          // The swap re-attaches the document, and attaching resets the find bar, so the query primes again here.
          if (target.query && viewer._searchBar) {
            viewer._searchBar.openSearch();
            viewer._searchBar.searchInputElem.value = target.query;
            viewer._searchBar.runSearch(target.query, target.pageN);
          }
        }).catch(() => {});
        return;
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
      panes.beginUserLoad();
      try {
        doc = await scribeLib.openDocument(files, { deferText: true });
      } catch (err) {
        viewer._showToast(`Couldn't open “${titleOf(relPath)}” — ${err instanceof Error ? err.message : 'the file could not be loaded'}.`);
        return;
      } finally {
        panes.endUserLoad();
      }
      entry.lastOpened = Date.now();
      saveManifestSoon();
      // Opening straight at the target page, since a `lastPage: 0` open followed by a jump would visibly double-paint.
      const tab = await viewer._openDocAsTab(doc, titleOf(relPath), { libraryHash: entry.hash, lastPage: target.pageN ?? 0 });
      wrapMutators(doc, tab);
      panes.persistRasterWindow(doc, entry, target.pageN ?? 0);
      if (target.query && viewer._searchBar) {
        viewer._searchBar.openSearch();
        viewer._searchBar.searchInputElem.value = target.query;
        await viewer._searchBar.runSearch(target.query, target.pageN);
      }
    } finally {
      openingDocs.delete(openKey);
    }
  };

  // --- Subsystems ---------------------------------------------------------

  // Constructed here rather than beside their first use, because they capture `render`, `openCardMenu`, and `openEntry` by value.
  const panes = createPreviewPanes({
    viewer,
    sessions,
    getStore: () => store,
    getManifest: () => manifest,
    onRastersStored: () => results.repump(),
  });

  const results = createResultsView({
    body,
    sessions,
    panes,
    getStore: () => store,
    getManifest: () => manifest,
    getResults: () => /** @type {Array<{hash: string, pages: number[]}>} */ (fullTextResults),
    getQuery: () => fullTextQuery,
    openEntry,
    onBack: () => {
      fullTextResults = null;
      searchInput.value = '';
      searchField.classList.remove('has-text');
      filterText = '';
      render();
    },
  });

  const drag = createDragReorder({
    viewer,
    surface,
    body,
    selectedPaths,
    getManifest: () => manifest,
    getStore: () => store,
    saveManifestSoon,
    render,
    openCardMenu,
    dragAllowed: () => !fullTextResults && !filterText.trim() && !fsOpBusy,
    reorderAllowed: () => sortMode === 'custom' && viewMode === 'grid',
  });

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
          // The queue also drains here after idle ticks and warm-only passes, which change nothing a card or row displays.
          if (done > 0) render();
          // Warmed rasters can fill result rows that were blank at pump time.
          else results.repump();
          return;
        }
        progressElem.style.display = 'grid';
        progressCount.textContent = `Indexing ${done} of ${total}`;
        progressName.textContent = current.split('/').pop() || current;
        progressHair.style.width = `${(done / total) * 100}%`;
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
    render({ revealSelection: true });
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
      results.dispose();
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

  const closeNewMenu = () => {
    newMenu.style.display = 'none';
    document.removeEventListener('pointerdown', onNewOutside);
    document.removeEventListener('keydown', onNewKey);
  };
  /** @param {PointerEvent} e */
  const onNewOutside = (e) => {
    if (!newWrap.contains(/** @type {Node} */ (e.target))) closeNewMenu();
  };
  /** @param {KeyboardEvent} e */
  const onNewKey = (e) => {
    if (e.key !== 'Escape') return;
    closeNewMenu();
    newBtn.focus();
  };
  newBtn.addEventListener('click', () => {
    if (newMenu.style.display !== 'none') {
      closeNewMenu();
      return;
    }
    newMenu.style.display = '';
    document.addEventListener('pointerdown', onNewOutside);
    document.addEventListener('keydown', onNewKey);
  });
  newFolderItem.addEventListener('click', () => {
    closeNewMenu();
    createNewFolder();
  });
  addPdfsItem.addEventListener('click', () => {
    closeNewMenu();
    if (store) fileInput.click();
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.length) startIngestFiles([...fileInput.files]);
    fileInput.value = '';
  });

  refreshBtn.addEventListener('click', async () => {
    // A scan over a half-renamed tree would mint duplicate entries, so refresh waits out any folder operation.
    if (!ingest || fsOpBusy) return;
    await ingest.scan();
    render();
    ingest.start();
  });

  stopBtn.addEventListener('click', () => {
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
    const pane = panes.mounted();
    paneEngaged = !!(pane && e.target instanceof Node && pane.pane.contains(e.target));
  };
  surface.addEventListener('pointerdown', trackEngagement, true);
  surface.addEventListener('focusin', trackEngagement, true);

  // While the library has the window, this claims the shortcut ahead of the toolbar's find bar.
  const onFindShortcut = (e) => {
    if (!visible) return;
    if (!((e.key === 'f' || e.key === 'F') && (e.ctrlKey || e.metaKey) && !e.altKey)) return;
    e.preventDefault();
    e.stopPropagation();
    const pane = panes.mounted();
    const paneFind = paneEngaged && pane
      ? /** @type {?HTMLInputElement} */ (pane.pane.querySelector('.scribe-library-pv-find input'))
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
        render({ revealSelection: true });
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
      drag.cancel();
      if (visible) hideSurface();
      closeCardMenu();
      ingest?.cancel();
      resizeObserver.disconnect();
      hintObserver.disconnect();
      colsObserver?.disconnect();
      window.clearTimeout(colSettleTimer);
      cancelAnimationFrame(colProjectRaf);
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
      panes.mounted()?.destroy();
      sessions.reset();
      results.dispose();
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
