// Full-screen library surface for the basic viewer: connect a folder, browse and search it, open documents into tabs, and keep edits flowing back into `.scribe` sidecars.
// Loaded by dynamic import behind the `library` option, so viewers without it never fetch this module or its styles.

import scribeLib from '../../scribe.js';
import { saveAs } from '../../js/utils/miscUtils.js';
import { TEXT_MARKUP_ANNOT_TYPES } from '../../js/addHighlights.js';
import { filesFromDropEvent } from '../js/dragAndDrop.js';
import { shortcutLabel } from '../js/platform.js';
import { MENU_PLATE_CSS, MENU_ROW_CSS, MENU_SEP_CSS } from '../js/controls/menuStyles.js';
import { createDropdown } from '../js/controls/dropdown.js';
import { filesNamedForPdf } from '../js/controls/tools.js';
import {
  LibraryStore, folderNameProblem, sameEntry, titleOf,
} from './libraryStore.js';
import { PortfolioStore } from './portfolioStore.js';
import { createSearchClient } from './search/searchClient.js';
import { LibraryIngest } from './libraryIngest.js';
import { DocSessions } from './docSession.js';
import {
  createPageNav, createZoomControls, makeIconButton, makeSeparator,
} from '../js/controls/toolbar.js';
import { barIcon, slotIcon } from '../js/controls/icons.js';
import { createPreview } from './libraryPreview.js';
import { createResultsView } from './libraryResultsView.js';
import { FOLDER_FLY_MS, createDragReorder } from './libraryDragReorder.js';
import { flyCopies } from '../js/controls/pageReorder.js';

// Filled rather than stroked because outlined spines collapse into double-line mush at the pinned tab's 16px.
// eslint-disable-next-line max-len
const LIBRARY_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" style="pointer-events:none;display:block;width:100%;height:100%;" aria-hidden="true"><rect x="3" y="3.5" width="3.8" height="17" rx="0.9"/><rect x="8.8" y="3.5" width="3.8" height="17" rx="0.9"/><path d="M13.7 3.9 17.4 3.1 20.9 19.7 17.2 20.5Z"/></svg>';
// eslint-disable-next-line max-len
const FOLDER_TAB_SVG = '<svg viewBox="0 0 16 16" fill="currentColor" style="pointer-events:none;display:block;width:100%;height:100%;" aria-hidden="true"><path d="M1 4a1 1 0 0 1 1-1h3.59a1 1 0 0 1 .7.29L8 5h6a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1z"/></svg>';
// Drawn on a 16-unit grid with 1.5px strokes because it is only shown at 15-18px, where a 24-unit outline thins to a hairline and its tab all but disappears.
// eslint-disable-next-line max-len
const FOLDER_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none;display:block;width:100%;height:100%;" aria-hidden="true"><path d="M1.75 4.5a.75.75 0 0 1 .75-.75h3.1l1.75 2h6.15a.75.75 0 0 1 .75.75v6a.75.75 0 0 1-.75.75H2.5a.75.75 0 0 1-.75-.75z"/></svg>';
// eslint-disable-next-line max-len
const FOLDER_ELSEWHERE_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none;display:block;width:100%;height:100%;" aria-hidden="true"><path d="M1.75 4.5a.75.75 0 0 1 .75-.75h3.1l1.75 2h6.15a.75.75 0 0 1 .75.75v6a.75.75 0 0 1-.75.75H2.5a.75.75 0 0 1-.75-.75z"/><rect x="1" y="8" width="7" height="7" rx="1.5" fill="currentColor" stroke="var(--scribe-surface)" stroke-width="1"/><path d="M3.25 12.75l2.5-2.5M3.75 10.25h2v2" stroke="var(--scribe-surface)" stroke-width="1.5"/></svg>';
// eslint-disable-next-line max-len
const FILE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none;display:block;width:100%;height:100%;" aria-hidden="true"><path d="M6.5 3.5h7l5 5v11a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z"/><path d="M13.5 3.5v5h5"/></svg>';
// Matches FOLDER_SVG's grid and stroke, for the start screen, where the two sit side by side.
// eslint-disable-next-line max-len
const FILE_16_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none;display:block;width:100%;height:100%;" aria-hidden="true"><path d="M3.75 2.5a.75.75 0 0 1 .75-.75h4.9l2.85 2.85v8.9a.75.75 0 0 1-.75.75H4.5a.75.75 0 0 1-.75-.75z"/><path d="M9.4 1.75v2.85h2.85"/></svg>';
// eslint-disable-next-line max-len

const FIELD_SEARCH_SVG = slotIcon('search16');
const FIELD_CLEAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>';
const SORT_SVG = slotIcon('sort18');
const CHEVRON_SVG = slotIcon('chevron12', 'chev');
const PLUS_SVG = slotIcon('plus18');
// eslint-disable-next-line max-len
const FOLDER_PLUS_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.75 4.5a.75.75 0 0 1 .75-.75h3.1l1.75 2h6.15a.75.75 0 0 1 .75.75v6a.75.75 0 0 1-.75.75H2.5a.75.75 0 0 1-.75-.75z"/><path d="M8 7.9v3.4M6.3 9.6h3.4"/></svg>';
const REFRESH_SVG = slotIcon('refresh18');
// eslint-disable-next-line max-len
const IMPORT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v9M8.5 9.5 12 13l3.5-3.5"/><path d="M4.5 15.5V18a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-2.5"/></svg>';

// A PDF portfolio, drawn as two stacked sheets.
// Stroked at 24 for rows and cards, and filled at 16 for the pinned tab, as the library's own glyph is.
// eslint-disable-next-line max-len
const PORTFOLIO_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none;display:block;width:100%;height:100%;" aria-hidden="true"><path d="M8 4.5h9a1.5 1.5 0 0 1 1.5 1.5v9.5"/><rect x="4.5" y="8" width="11" height="12" rx="1.5"/><path d="M7.5 12.5h5M7.5 15.5h5"/></svg>';
// eslint-disable-next-line max-len
const PORTFOLIO_TAB_SVG = '<svg viewBox="0 0 16 16" fill="currentColor" style="pointer-events:none;display:block;width:100%;height:100%;" aria-hidden="true"><rect x="5.5" y="2" width="8" height="9" rx="1" opacity=".55"/><rect x="2.5" y="5" width="8" height="9.5" rx="1"/></svg>';
// eslint-disable-next-line max-len
const IMAGE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><circle cx="8.8" cy="9.3" r="1.6"/><path d="M3.5 16.5l5.2-4.6 3.9 3.4 3.1-2.6 4.8 4"/></svg>';
const REVEAL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M8 4.5v5"/></svg>';
const CLOSE_X_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">'
  + '<path d="M7 7l10 10M17 7L7 17"/></svg>';
// eslint-disable-next-line max-len
const MENU_CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 12.5l4.3 4.3L18.5 7.5"/></svg>';
const VIEW_GRID_SVG = slotIcon('grid16');
const VIEW_LIST_SVG = slotIcon('list16');
const VIEW_COMPACT_SVG = slotIcon('compact16');

const STORAGE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<rect x="3.5" y="4.5" width="17" height="6" rx="1.5"/><rect x="3.5" y="13.5" width="17" height="6" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>';
const BACK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>';

// ScribeDoc methods that mutate persisted state.
const MUTATOR_METHODS = [
  'addHighlights', 'addFreeText', 'addShapes', 'addTextAnnots', 'addRedactions', 'removeRedactions',
  'clearHighlights', 'clearShapes', 'clearTextAnnots', 'addLinks', 'removeLinks',
  'addBookmark', 'renameBookmark', 'setBookmarkDest', 'moveBookmark', 'removeBookmarks', 'replaceOutline',
  'deletePage', 'deletePages', 'movePage', 'movePages', 'copyPages', 'duplicatePages', 'insertPages', 'rotatePages',
  'deleteTextLines', 'replaceTextLine', 'deleteGraphics', 'deleteImages', 'setFormValue',
  'addInk', 'addStamp', 'addFillText', 'syncFillText',
  'undo', 'redo', 'recognize',
];

const PREVIEW_STORAGE_KEY = 'scribe-library-preview';
const VIEW_STORAGE_KEY = 'scribe-library-view';
const OTHERS_STORAGE_KEY = 'scribe-library-others';
const COLS_STORAGE_KEY = 'scribe-library-cols';
/** Storage key for the name of the folder that was open when the app last ran. */
const OPEN_FOLDER_KEY = 'scribe-library-open-folder';
const RESUME_STORAGE_KEY = 'scribe-library-resume';

/**
 * @typedef {Object} LibraryInstanceOptions
 * @property {'library'|'portfolio'} kind
 * @property {string} name - The pinned tab's and the root crumb's label.
 * @property {string} glyph - The pinned tab's icon.
 * @property {?Object} [store] - A store to open at once; the library connects its own folder instead.
 * @property {'grid'|'list'|'compact'} [viewDefault]
 * @property {boolean} [previewDefault]
 * @property {boolean} [showOthersDefault]
 * @property {boolean} [persistPrefs] - Read and write the view, column, preview and other-files preferences in localStorage.
 * @property {boolean} [readOnly] - No file drops, folder operations, New menu or Refresh.
 * @property {string} [emptyText]
 * @property {?string} [initialRelPath] - The file to select and preview once the store is open.
 * @property {?string} [libraryHash] - When a library entry opened this instance: that entry's hash, so it is not opened twice.
 * @property {?number} [libraryOwner] - With `libraryHash`, the library instance the entry belongs to.
 * @property {() => void} [onClose] - Mounted as a close control on the pinned tab.
 * @property {?Object} [engineSettings]
 */

/**
 * @typedef {Object} LibraryInstance
 * @property {'library'|'portfolio'} kind
 * @property {?string} libraryHash
 * @property {?number} libraryOwner
 * @property {() => boolean} visible
 * @property {() => void} focusSearch
 * @property {() => void} [close] Closable surfaces only (a portfolio): close it, as its pinned tab's control does.
 * @property {() => boolean} [connected] Document library only: whether a folder is connected.
 * @property {() => Promise<void>} [openFolder] Document library only: pick a folder and open it as the library.
 * @property {() => Promise<void>} [rebuildIndex] Document library only: re-index every document in the connected folder.
 * @property {() => void} [openStorage] Document library only: show the Library Storage sheet for the connected folder.
 * @property {() => Promise<void>} [closeFolder] Document library only: close the folder and the documents open from it.
 * @property {(tab: ?Object) => boolean} [ownsTab] Document library only: whether a tab holds a document from the open folder.
 * @property {() => string} [closeFolderLabel] Document library only: the Close Folder command's label, counting the folder's open documents.
 * @property {() => string} [folderName] Document library only: the open folder's name.
 * @property {() => void} [syncFoldersOpenElsewhere] Document library only: reorder and redraw the Recent list once the folders other windows hold change.
 * @property {(tab: Object, toIndex: ?number) => Promise<void>} [copyTabIntoFolder] Document library only: copy a freestanding tab's PDF into the folder and make the tab one of the folder's.
 * @property {(tab: Object) => void} [showTab] Document library only: show the folder view with the tab's document selected.
 * @property {() => void} show
 * @property {() => void} hide
 * @property {() => boolean} covering Whether the surface covers the document area, as the browse form does and the split form does not.
 * @property {() => void} clearPreview Empty the split form's pane and clear its selection.
 * @property {() => void} pageChanged The viewer moved to another page.
 * @property {() => void} docOpened
 * @property {() => void} emptied
 * @property {(tab: ?Object) => Promise<void>} saveTabIfDirty
 * @property {(options?: {resume?: boolean}) => Promise<void>} saveAllDirty
 * @property {() => void} [syncResume] Document library only: rewrite the keys a relaunch reads from, once this window is the one it resumes.
 * @property {() => Promise<Object>} [searchStats] The search engine's own accounting of what it holds and of its index's shape.
 *   A timing harness outside this repository calls it, though nothing in the app does.
 * @property {() => void} destroy
 */

/**
 * One item a drop or a Move to... moved, kept while the move can be taken back.
 * A folder's `index` is its place among its old siblings, for the placeholder that keeps its slot.
 * @typedef {{kind: 'doc', from: string, to: string, hash: string, arrivedBefore: ?number} | {kind: 'dir', from: string, to: string, index: number}} LibraryMove
 */

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

let instanceCounter = 0;

const AUTOSAVE_INTERVAL_MS = 60000;

let stylesInjected = false;
const addLibraryStyles = () => {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
.scribe-pdf-viewer .scribe-library-surface { position: absolute; left: 0; right: 0; bottom: 0; z-index: 30; background: var(--scribe-canvas); color: var(--scribe-ink); display: flex; flex-direction: column; overflow: hidden; font-size: 14px; }
.scribe-pdf-viewer .scribe-library-surface { -webkit-user-select: none; user-select: none; }
.scribe-pdf-viewer .scribe-library-surface input, .scribe-pdf-viewer .scribe-library-surface textarea, .scribe-pdf-viewer .scribe-library-surface [contenteditable] { -webkit-user-select: auto; user-select: auto; }
.scribe-pdf-viewer .scribe-library-header { display: flex; align-items: center; gap: 8px; min-height: 44px; box-sizing: border-box; padding: 4px 14px 4px 18px; border-bottom: 1px solid var(--scribe-line); background: var(--scribe-surface); flex-wrap: wrap; }
.scribe-pdf-viewer .scribe-library-header h2 { font-size: 14px; font-weight: 600; margin: 0; }
.scribe-pdf-viewer .scribe-library-bar-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
.scribe-pdf-viewer .scribe-library-bar-controls { display: flex; align-items: center; gap: 8px; min-width: 0; }
/* Only the field yields under bar pressure, so the rungs below decide what else goes. */
.scribe-pdf-viewer .scribe-library-bar-controls > * { flex-shrink: 0; }
.scribe-pdf-viewer .scribe-library-bar-controls .scribe-library-field { flex: 0 1 auto; width: 320px; min-width: 106px; }
.scribe-pdf-viewer .scribe-library-bar-controls .scribe-library-search { width: 100%; min-width: 0; flex: 1; }
.scribe-pdf-viewer .scribe-library-field { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 8px; margin-left: auto; background: var(--scribe-sunken); border: 1px solid var(--scribe-line-strong); border-radius: 5px; box-sizing: border-box; }
.scribe-pdf-viewer .scribe-library-field:focus-within { border-color: var(--scribe-accent); }
.scribe-pdf-viewer .scribe-library-field > svg { width: 16px; height: 16px; color: var(--scribe-ink-3); flex-shrink: 0; }
.scribe-pdf-viewer .scribe-library-search { border: none; background: none; outline: none; color: var(--scribe-ink); font: inherit; font-size: 13px; width: 170px; padding: 0; text-align: left; text-overflow: ellipsis; caret-color: var(--scribe-accent); }
.scribe-pdf-viewer .scribe-library-search::placeholder { color: var(--scribe-ink-3); }
/* The key cap is a block-level flex item here, so without line-height: normal it would size to the toolbar's inherited 28px line-height. */
.scribe-pdf-viewer .scribe-library-hint { display: none; align-items: center; gap: 4px; max-width: 160px; overflow: hidden; line-height: normal; font-size: 11.5px; color: var(--scribe-ink-3); white-space: nowrap; transition: opacity .12s ease-out, max-width .16s ease-out, margin-left .16s ease-out; }
.scribe-pdf-viewer .scribe-library-field.has-text:focus-within .scribe-library-hint { display: inline-flex; }
/* The fold collapses width and opacity rather than switching display, so a phrase takes the room without a jump. */
.scribe-pdf-viewer .scribe-library-field.hint-yield .scribe-library-hint { opacity: 0; max-width: 0; margin-left: -6px; }
@media (prefers-reduced-motion: reduce) { .scribe-pdf-viewer .scribe-library-hint { transition: none; } }
.scribe-pdf-viewer .scribe-library-hint kbd { font-family: inherit; border: 1px solid var(--scribe-line-strong); border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; font-size: 10.5px; color: var(--scribe-ink-2); background: var(--scribe-surface); }
.scribe-pdf-viewer .scribe-library-bar-controls .scribe-library-field.hint-tight .scribe-library-hint { display: none; }
.scribe-pdf-viewer .scribe-library-clear { display: none; width: 17px; height: 17px; padding: 2px; border: none; background: none; color: var(--scribe-ink-3); cursor: pointer; border-radius: 4px; }
.scribe-pdf-viewer .scribe-library-field.has-text .scribe-library-clear { display: block; }
.scribe-pdf-viewer .scribe-library-clear:hover { color: var(--scribe-ink); background: var(--scribe-hover); }
.scribe-pdf-viewer .scribe-library-clear svg { width: 100%; height: 100%; display: block; }
.scribe-pdf-viewer .scribe-library-hbtn { display: inline-flex; align-items: center; gap: 7px; height: 28px; padding: 0 10px; border-radius: 7px; border: none; background: none; color: var(--scribe-ink-2); font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; }
.scribe-pdf-viewer .scribe-library-hbtn:hover { background: var(--scribe-hover); color: var(--scribe-ink); }
.scribe-pdf-viewer .scribe-library-hbtn svg { width: 18px; height: 18px; flex-shrink: 0; }
.scribe-pdf-viewer .scribe-library-hbtn svg.chev { width: 12px; height: 12px; margin-left: -2px; color: var(--scribe-ink-3); }
/* Fills the slack roundBarButtons adds, so the chevron sits against the button's right padding on a whole pixel. */
.scribe-pdf-viewer .scribe-library-sort-lbl { display: inline-grid; text-align: left; flex: 1 1 auto; }
.scribe-pdf-viewer .scribe-library-add-lbl { flex: 1 1 auto; }
.scribe-pdf-viewer .scribe-library-sort-lbl > span { grid-area: 1 / 1; white-space: nowrap; }
.scribe-pdf-viewer .scribe-library-sort-lbl .ghost { visibility: hidden; }
.scribe-pdf-viewer .scribe-library-hicon { width: 28px; height: 28px; padding: 3px; border-radius: 7px; border: none; background: none; color: var(--scribe-ink-2); cursor: pointer; }
.scribe-pdf-viewer .scribe-library-hicon:hover { background: var(--scribe-hover); color: var(--scribe-ink); }
.scribe-pdf-viewer .scribe-library-hicon svg { width: 100%; height: 100%; display: block; }
.scribe-pdf-viewer .scribe-library-hicon.on { color: var(--scribe-accent); background: var(--scribe-active); }
.scribe-pdf-viewer .scribe-library-hicon:disabled { color: var(--scribe-ink-3); opacity: .45; cursor: default; }
.scribe-pdf-viewer .scribe-library-hicon:disabled:hover { background: none; color: var(--scribe-ink-3); }
.scribe-pdf-viewer .scribe-library-sort { position: relative; display: inline-flex; }
.scribe-pdf-viewer .scribe-library-menu { position: absolute; top: calc(100% + 6px); right: 0; z-index: 30; min-width: 178px; ${MENU_PLATE_CSS} }
.scribe-pdf-viewer .scribe-library-menu-item { display: flex; align-items: center; gap: 9px; cursor: pointer; ${MENU_ROW_CSS} }
.scribe-pdf-viewer .scribe-library-menu-item:hover, .scribe-pdf-viewer .scribe-library-menu-item:focus { background: var(--scribe-hover); outline: none; }
.scribe-pdf-viewer .scribe-library-menu-item svg { width: 15px; height: 15px; color: var(--scribe-accent); visibility: hidden; flex-shrink: 0; }
.scribe-pdf-viewer .scribe-library-menu-item.on svg { visibility: visible; }
.scribe-pdf-viewer .scribe-library-menu-sep { ${MENU_SEP_CSS} }
/* Verb and crumb menus show their row icons outright, unlike the sort menu's hidden-until-checked marks. */
.scribe-pdf-viewer .scribe-library-new-menu .scribe-library-menu-item svg, .scribe-pdf-viewer .scribe-library-crumb-menu .scribe-library-menu-item svg { visibility: visible; color: var(--scribe-ink-2); }
.scribe-pdf-viewer .scribe-library-crumb-menu { left: 0; right: auto; }
.scribe-pdf-viewer .scribe-library-seg { display: inline-flex; height: 28px; box-sizing: border-box; border: 1px solid var(--scribe-line-strong); border-radius: 7px; overflow: hidden; background: var(--scribe-sunken); }
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
.scribe-pdf-viewer .scribe-library-body { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 16px 18px; scrollbar-gutter: stable; position: relative; }
.scribe-pdf-viewer .scribe-library-body::-webkit-scrollbar { width: 7px; }
.scribe-pdf-viewer .scribe-library-body::-webkit-scrollbar-track { background: transparent; }
.scribe-pdf-viewer .scribe-library-body::-webkit-scrollbar-thumb { background: var(--scribe-scrollbar); border-radius: 6px; }
.scribe-pdf-viewer .scribe-library-section-label { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.6; margin: 4px 0 10px; }
.scribe-pdf-viewer .scribe-library-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 190px)); justify-content: center; gap: 14px; margin-bottom: 22px; position: relative; }
/* Border-box, because script pins a folder card's measured height, border included, as its min-height when a drag hovers it. */
.scribe-pdf-viewer .scribe-library-card { border: 1px solid color-mix(in srgb, var(--scribe-ink) 14%, transparent); border-radius: 8px; background: var(--scribe-surface); cursor: pointer; overflow: hidden; display: flex; flex-direction: column; position: relative; touch-action: pan-y; user-select: none; box-sizing: border-box; }
.scribe-pdf-viewer .scribe-library-card:not(.folder)::before { content: ''; position: absolute; left: 0; top: 0; width: 100%; aspect-ratio: 3 / 4; z-index: 1; background: color-mix(in srgb, var(--scribe-ink) 5%, var(--scribe-canvas)); outline: 1.5px dashed var(--scribe-accent); outline-offset: -7.5px; border-radius: 2px; opacity: 0; pointer-events: none; }
.scribe-pdf-viewer .scribe-library-card.dragging::before { opacity: 1; transition: opacity 140ms ease; }
@media (prefers-reduced-motion: reduce) { .scribe-pdf-viewer .scribe-library-card.dragging::before, .scribe-pdf-viewer .scribe-library-card.folder.dragging .fstrip::before { transition: none; } }
.scribe-pdf-viewer .scribe-library-row.dragging { opacity: .3; }
.scribe-library-ghost { position: fixed; z-index: 9999; pointer-events: none; font-size: 14px; color: var(--scribe-ink); }
.scribe-library-ghost .row-ghost { position: absolute; left: 0; top: 0; width: 100%; box-sizing: border-box; background: var(--scribe-surface); box-shadow: 0 12px 28px rgba(0, 0, 0, 0.35); border-radius: 8px; overflow: hidden; }
.scribe-library-ghost .row-ghost .scribe-library-row { border-bottom: none; }
.scribe-library-ghost .fold-ghost { position: absolute; left: 0; top: 0; display: block; }
.scribe-library-ghost .fold-ghost > .scribe-library-fold { filter: drop-shadow(0 10px 18px rgba(0, 0, 0, .38)); }
.scribe-library-ghost .fold-label { position: absolute; left: 50%; transform: translateX(-50%); width: max-content; max-width: 190px; padding: 2px 8px; border-radius: 5px; background: var(--scribe-surface); color: var(--scribe-ink); font-size: 12.5px; font-weight: 600; line-height: 18px; box-shadow: 0 1px 2px rgba(20, 30, 60, .14), 0 3px 10px rgba(20, 30, 60, .18); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; z-index: 5; }
.scribe-pdf-viewer .scribe-library-insert-line { position: absolute; width: 3px; border-radius: 2px; background: var(--scribe-accent); z-index: 5; pointer-events: none; }
.scribe-pdf-viewer .scribe-library-marquee { position: absolute; z-index: 5; pointer-events: none; box-sizing: border-box; background: color-mix(in srgb, var(--scribe-accent) 20%, transparent); border: 1px solid var(--scribe-accent); }
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
.scribe-pdf-viewer .scribe-library-lhead .ar.ghost { visibility: hidden; }
.scribe-pdf-viewer .scribe-library-lhead > .on { color: var(--scribe-ink); }
.scribe-pdf-viewer .scribe-library-hres { position: absolute; top: 0; right: -4px; width: 9px; height: 100%; z-index: 3; cursor: col-resize; touch-action: none; }
.scribe-pdf-viewer .scribe-library-hres::before { content: ''; position: absolute; left: 4px; top: 0; bottom: 0; width: 1px; background: var(--scribe-line); }
.scribe-pdf-viewer .scribe-library-hres:hover::before, .scribe-pdf-viewer .scribe-library-hres.drag::before { left: 3px; width: 3px; background: var(--scribe-accent); }
.scribe-pdf-viewer .scribe-library-hres:focus-visible { outline: 2px solid var(--scribe-accent); outline-offset: -1px; }
.scribe-pdf-viewer .scribe-library-cols-drag { user-select: none; }
.scribe-pdf-viewer .scribe-library-cols-drag * { cursor: col-resize !important; }
.scribe-pdf-viewer.scribe-coarse .scribe-library-hres { display: none; }
/* The scroll margin is the sticky column header's height, so a row scrolled into view is not hidden behind it. */
.scribe-pdf-viewer .scribe-library-row { display: grid; grid-template-columns: var(--scribe-library-cols, minmax(240px, 1fr) 70px 110px 110px 120px); min-width: min-content; align-items: center; height: 34px; padding: 0 8px; cursor: pointer; border-bottom: 1px solid color-mix(in srgb, var(--scribe-line) 55%, transparent); font-size: 13px; user-select: none; touch-action: pan-y; scroll-margin-top: 31px; }
.scribe-pdf-viewer .scribe-library-row > * { min-width: 0; padding: 0 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.scribe-pdf-viewer .scribe-library-row:hover:where(.scribe-library-surface:not(.card-drag) *) { background: var(--scribe-hover); }
.scribe-pdf-viewer .scribe-library-row.selected { background: var(--scribe-active); box-shadow: inset 2px 0 0 var(--scribe-accent); }
.scribe-pdf-viewer .scribe-library-row.context { outline: 1px solid var(--scribe-accent); outline-offset: -1px; }
.scribe-pdf-viewer .scribe-library-row:focus-visible { outline: 2px solid var(--scribe-accent); outline-offset: -2px; }
.scribe-pdf-viewer .scribe-library-lgroup { height: 32px; box-sizing: border-box; display: flex; align-items: flex-end; padding: 0 18px 6px; border-bottom: 1px solid color-mix(in srgb, var(--scribe-line) 55%, transparent); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: color-mix(in srgb, var(--scribe-ink) 60%, transparent); user-select: none; }
.scribe-pdf-viewer .scribe-library-row .nm { display: flex; align-items: center; gap: 10px; min-width: 0; }
.scribe-pdf-viewer .scribe-library-row .nm .t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.scribe-pdf-viewer .scribe-library-row.cf { grid-template-columns: var(--scribe-library-cols, minmax(260px, 1fr) 90px 130px 130px); height: 64px; }
.scribe-pdf-viewer .scribe-library-row.cf .nm { gap: 12px; }
.scribe-pdf-viewer .scribe-library-row.cf .nm img { width: 40px; height: 52px; object-fit: cover; object-position: top; border: 1px solid var(--scribe-line); border-radius: 3px; background: #fff; flex-shrink: 0; }
.scribe-pdf-viewer .scribe-library-row .nm .tt { min-width: 0; }
/* The title is inline by default, and only a block can end in an ellipsis. */
.scribe-pdf-viewer .scribe-library-row .nm .tt > .t { display: block; }
.scribe-pdf-viewer .scribe-library-row.cf .nm .t { font-weight: 600; }
.scribe-pdf-viewer .scribe-library-row.cf .nm .m2 { font-size: 12px; color: var(--scribe-ink-3); margin-top: 2px; display: flex; gap: 6px; align-items: center; }
.scribe-pdf-viewer .scribe-library-row .num { font-variant-numeric: tabular-nums; color: var(--scribe-ink-2); }
.scribe-pdf-viewer .scribe-library-row .dt { font-variant-numeric: tabular-nums; color: var(--scribe-ink-2); font-size: 12.5px; }
.scribe-pdf-viewer .scribe-library-row .none { color: var(--scribe-ink-3); }
.scribe-pdf-viewer .scribe-library-empty { text-align: center; opacity: 0.7; padding: 60px 20px; }
.scribe-pdf-viewer .scribe-library-card-wall { max-width: 520px; margin: 60px auto; text-align: center; border: 1px solid color-mix(in srgb, var(--scribe-ink) 14%, transparent); border-radius: 10px; background: var(--scribe-surface); padding: 36px 32px; -webkit-user-select: text; user-select: text; }
.scribe-pdf-viewer .scribe-library-card-wall h3 { margin: 0 0 10px; font-size: 17px; }
.scribe-pdf-viewer .scribe-library-card-wall p { margin: 0 0 20px; opacity: 0.75; line-height: 1.5; }
.scribe-pdf-viewer .scribe-library-doors { display: flex; flex-wrap: wrap; gap: 24px; justify-content: center; align-items: stretch; padding: 40px 22px 0; -webkit-user-select: text; user-select: text; }
.scribe-pdf-viewer .scribe-library-door { width: 370px; max-width: 100%; box-sizing: border-box; border: 1px solid color-mix(in srgb, var(--scribe-ink) 14%, transparent); border-radius: 10px; background: var(--scribe-surface); padding: 30px 28px 26px; display: flex; flex-direction: column; align-items: center; text-align: center; }
.scribe-pdf-viewer .scribe-library-door .ic { width: 38px; height: 38px; color: var(--scribe-ink-3); margin-bottom: 14px; }
.scribe-pdf-viewer .scribe-library-door .ic svg { width: 100%; height: 100%; display: block; }
.scribe-pdf-viewer .scribe-library-door h3 { margin: 0 0 8px; font-size: 17px; font-weight: 700; }
.scribe-pdf-viewer .scribe-library-door p { margin: 0 0 18px; opacity: 0.75; line-height: 1.5; }
.scribe-pdf-viewer .scribe-library-door .grow { flex: 1; }
.scribe-pdf-viewer .scribe-library-door .hint { font-size: 12.5px; color: var(--scribe-ink-3); margin-top: 10px; }
.scribe-pdf-viewer .scribe-library-btn .bi { display: inline-block; width: 15px; height: 15px; vertical-align: -3px; margin-right: 7px; }
.scribe-pdf-viewer .scribe-library-recent { width: 100%; text-align: left; margin: 0 0 16px; border-top: 1px solid var(--scribe-line); }
.scribe-pdf-viewer .scribe-library-recent .h { font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--scribe-ink-3); margin: 12px 0 4px; }
.scribe-pdf-viewer .scribe-library-recent .r { display: flex; align-items: center; gap: 9px; width: calc(100% + 12px); margin: 0 -6px; padding: 5px 6px; border-radius: 6px; color: var(--scribe-ink); font-size: 13px; text-align: left; cursor: pointer; box-sizing: border-box; }
.scribe-pdf-viewer .scribe-library-recent .r:hover { background: var(--scribe-hover); }
.scribe-pdf-viewer .scribe-library-recent .r:focus-visible { outline: 2px solid var(--scribe-accent); outline-offset: -2px; }
.scribe-pdf-viewer .scribe-library-recent .x { flex: none; width: 18px; height: 18px; margin: -2px 0; border: none; border-radius: 4px; padding: 0; background: none; color: var(--scribe-ink-3); font: inherit; font-size: 15px; line-height: 1; cursor: pointer; visibility: hidden; }
.scribe-pdf-viewer .scribe-library-recent .r:hover .x, .scribe-pdf-viewer .scribe-library-recent .r:focus-within .x, .scribe-pdf-viewer.scribe-coarse .scribe-library-recent .x { visibility: visible; }
.scribe-pdf-viewer .scribe-library-recent .x:hover { background: var(--scribe-plate); color: var(--scribe-ink); }
.scribe-pdf-viewer .scribe-library-recent .x:focus-visible { outline: 2px solid var(--scribe-accent); outline-offset: -1px; }
.scribe-pdf-viewer .scribe-library-recent .r.leaving, .scribe-pdf-viewer .scribe-library-recent.leaving { overflow: hidden; pointer-events: none; opacity: 0; transition: opacity .12s ease; box-sizing: border-box; }
.scribe-pdf-viewer .scribe-library-recent .r.leaving.closing { height: 0 !important; padding-top: 0 !important; padding-bottom: 0 !important; transition: height .16s ease, padding .16s ease; }
.scribe-pdf-viewer .scribe-library-sheet .scribe-library-recent.leaving.closing { height: 0 !important; margin-top: 0 !important; border-top-width: 0 !important; transition: height .16s ease, margin-top .16s ease, border-top-width .16s ease; }
@media (prefers-reduced-motion: reduce) { .scribe-pdf-viewer .scribe-library-recent .r.leaving, .scribe-pdf-viewer .scribe-library-recent .r.leaving.closing, .scribe-pdf-viewer .scribe-library-recent.leaving, .scribe-pdf-viewer .scribe-library-sheet .scribe-library-recent.leaving.closing { transition: none; } }
.scribe-pdf-viewer .scribe-library-recent .fi { width: 16px; height: 16px; flex: none; display: inline-flex; color: var(--scribe-ink-3); }
.scribe-pdf-viewer .scribe-library-recent .n { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.scribe-pdf-viewer .scribe-library-recent .p { color: var(--scribe-ink-3); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-left: auto; flex: none; max-width: 55%; }
/* A stable gutter is reserved even under overflow: hidden. */
.scribe-pdf-viewer .scribe-library-body.results-mode { padding: 0; scrollbar-gutter: auto; }
.scribe-pdf-viewer .scribe-library-body.split-mode { padding: 0; overflow: hidden; display: flex; scrollbar-gutter: auto; }
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
.scribe-pdf-viewer .scribe-library-rlist { width: clamp(280px, var(--scribe-library-rlist-w, 400px), calc(100% - 320px)); box-sizing: border-box; flex-shrink: 0; overflow-y: auto; overflow-x: hidden; border-right: 1px solid var(--scribe-line); background: var(--scribe-surface); outline: none; }
.scribe-pdf-viewer .scribe-library-rlist::-webkit-scrollbar { width: 5px; }
.scribe-pdf-viewer .scribe-library-rlist::-webkit-scrollbar-track { background: transparent; }
.scribe-pdf-viewer .scribe-library-rlist::-webkit-scrollbar-thumb { background: var(--scribe-scrollbar); border-radius: 6px; }
.scribe-pdf-viewer .scribe-library-rsplit { flex: 0 0 7px; margin: 0 -3px; position: relative; z-index: 4; cursor: col-resize; touch-action: none; }
.scribe-pdf-viewer .scribe-library-rsplit::before { content: ''; position: absolute; left: 2px; top: 0; bottom: 0; width: 3px; background: var(--scribe-accent); opacity: 0; transition: opacity 0.08s; }
.scribe-pdf-viewer .scribe-library-rsplit:hover::before { opacity: 1; transition-delay: 0.25s; }
.scribe-pdf-viewer .scribe-library-rsplit.drag::before { opacity: 1; transition-delay: 0s; }
.scribe-pdf-viewer .scribe-library-results.rsplit-drag { user-select: none; }
.scribe-pdf-viewer .scribe-library-results.rsplit-drag * { cursor: col-resize !important; }
.scribe-pdf-viewer .scribe-library-rwrap { outline: none; }
.scribe-pdf-viewer .scribe-library-pv { flex: 1; display: flex; flex-direction: column; min-width: 0; }
/* Stacked above the stage, so the find bar that hangs from it paints over the page. */
.scribe-pdf-viewer .scribe-library-pv-head { display: flex; align-items: center; gap: 8px; height: 40px; flex-shrink: 0; box-sizing: border-box; padding: 0 12px; background: var(--scribe-surface); box-shadow: inset 0 -1px 0 var(--scribe-line); position: relative; z-index: 2; }
.scribe-pdf-viewer .scribe-library-pv-head .t { flex: 1 1 0; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.scribe-pdf-viewer .scribe-library-pv-nav, .scribe-pdf-viewer .scribe-library-pv-zoom, .scribe-pdf-viewer .scribe-library-pv-tools { display: inline-flex; align-items: center; flex-shrink: 0; }
.scribe-pdf-viewer .scribe-library-pv-tools { flex: 1 1 0; justify-content: flex-end; gap: 8px; }
.scribe-pdf-viewer .scribe-library-pv-tools .vertical-separator { margin: 0; }
.scribe-pdf-viewer .scribe-library-pv-stage { flex: 1; overflow: hidden; display: flex; position: relative; background: var(--scribe-canvas); }
.scribe-pdf-viewer .scribe-library-pv-stage.live { background: transparent; pointer-events: none; }
.scribe-pdf-viewer .scribe-library-pv-empty { color: var(--scribe-ink-3); font-size: 13px; margin: auto; }
.scribe-pdf-viewer .scribe-library-pv-loading { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: var(--scribe-ink-3); font-size: 13px; pointer-events: none; }
.scribe-pdf-viewer .scribe-library-pv-loading-spin { width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--scribe-ink-3); border-top-color: transparent; animation: scribe-library-pv-spin 0.8s linear infinite; }
@keyframes scribe-library-pv-spin { to { transform: rotate(360deg); } }
.scribe-pdf-viewer .scribe-library-surface.split { background: transparent; }
/* The boxes over the document pass the pointer through to it, and pointer-events is inherited, so every other part of the split form takes it back. */
.scribe-pdf-viewer .scribe-library-surface.split, .scribe-pdf-viewer .scribe-library-surface.split .scribe-library-body, .scribe-pdf-viewer .scribe-library-surface.split .scribe-library-results, .scribe-pdf-viewer .scribe-library-surface.split .scribe-library-pv { pointer-events: none; }
.scribe-pdf-viewer .scribe-library-surface.split > :not(.scribe-library-body), .scribe-pdf-viewer .scribe-library-surface.split .scribe-library-body > :not(.scribe-library-results), .scribe-pdf-viewer .scribe-library-surface.split .scribe-library-results > :not(.scribe-library-pv), .scribe-pdf-viewer .scribe-library-surface.split .scribe-library-pv > :not(.scribe-library-pv-stage), .scribe-pdf-viewer .scribe-library-surface.split .scribe-library-pv-stage:not(.live) { pointer-events: auto; }
.scribe-pdf-viewer .scribe-library-surface.leaving .scribe-library-rlist { opacity: 0; transition: opacity 200ms ease; }
.scribe-pdf-viewer .scribe-library-surface.entering .scribe-library-rlist { opacity: 0; }
.scribe-pdf-viewer .scribe-library-surface.entering.arrived .scribe-library-rlist { opacity: 1; transition: opacity 200ms ease; }
.scribe-pdf-viewer .scribe-library-bar-ghost { position: absolute; box-sizing: border-box; overflow: hidden; pointer-events: none; z-index: 41; color: var(--scribe-ink); line-height: 28px; }
.scribe-pdf-viewer .scribe-library-bar-ghost > * { position: absolute; margin: 0; }
.scribe-pdf-viewer .scribe-library-rsummary { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; padding: 12px 16px 8px; }
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
.scribe-pdf-viewer .scribe-library-rtiers { border-top: 1px solid var(--scribe-line); margin-top: 8px; padding-top: 2px; }
.scribe-pdf-viewer .scribe-library-rtdoc { padding: 10px 16px 4px; font-weight: 600; }
.scribe-pdf-viewer .scribe-library-rtdoc .m { font-weight: 400; color: var(--scribe-ink-3); font-size: 12px; white-space: nowrap; }
.scribe-pdf-viewer .scribe-mark { position: absolute; background: var(--scribe-match); mix-blend-mode: multiply; }
.scribe-pdf-viewer .scribe-mark.act { background: var(--scribe-match-active); }
.scribe-pdf-viewer .scribe-library-crumbs { position: relative; display: flex; align-items: center; gap: 1px; font-size: 14px; font-weight: 600; min-width: 0; white-space: nowrap; }
.scribe-pdf-viewer .scribe-library-crumb { border: none; background: none; padding: 3px 7px; border-radius: 6px; font: inherit; color: var(--scribe-ink-2); cursor: pointer; }
.scribe-pdf-viewer .scribe-library-crumbs > .scribe-library-crumb:first-child { margin-left: -7px; }
.scribe-pdf-viewer .scribe-library-crumb:hover { background: var(--scribe-hover); color: var(--scribe-ink); }
.scribe-pdf-viewer .scribe-library-crumb.drop { background: color-mix(in srgb, var(--scribe-accent) 16%, var(--scribe-surface)); box-shadow: inset 0 0 0 1.5px var(--scribe-accent); color: var(--scribe-ink); }
.scribe-pdf-viewer .scribe-library-crumbs .sep { color: var(--scribe-ink-3); font-weight: 400; padding: 0 2px; }
.scribe-pdf-viewer .scribe-library-crumbs .cur { padding-left: 7px; overflow: hidden; text-overflow: ellipsis; }
.scribe-pdf-viewer .scribe-library-crumbs .scribe-library-crumb-ghost { position: absolute; margin: 0; box-sizing: border-box; pointer-events: none; }
.scribe-pdf-viewer .scribe-library-card.folder .fstrip { display: flex; justify-content: center; align-items: center; min-height: 89px; box-sizing: border-box; padding: 11px 10px 10px; }
.scribe-pdf-viewer .scribe-library-fold { position: relative; display: block; flex: none; --fold-back: color-mix(in srgb, var(--scribe-ink) 12%, var(--scribe-surface)); --fold-front: color-mix(in srgb, var(--scribe-ink) 5%, var(--scribe-surface)); --fold-line: color-mix(in srgb, var(--scribe-ink) 22%, transparent); }
.scribe-pdf-viewer .scribe-library-fold > svg { position: absolute; left: 0; top: 0; display: block; overflow: visible; }
.scribe-pdf-viewer .scribe-library-fold > svg path { fill: var(--fold-back); stroke: var(--fold-line); stroke-width: 1; }
.scribe-pdf-viewer .scribe-library-fold .paper { position: absolute; background: #fff; box-shadow: 0 0 0 1px var(--scribe-line-strong); overflow: hidden; isolation: isolate; transition: left 140ms ease, top 140ms ease, opacity 140ms ease, box-shadow 140ms ease; }
.scribe-pdf-viewer .scribe-library-fold .paper img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: top; transition: opacity 140ms ease, filter 140ms ease; }
.scribe-pdf-viewer .scribe-library-fold .paper::after { content: ''; position: absolute; inset: 0; box-sizing: border-box; pointer-events: none; opacity: 0; transition: opacity 140ms ease; }
/* The flap stays above every paper, the fading copies a strip change leaves behind included. */
.scribe-pdf-viewer .scribe-library-fold .front { position: absolute; left: 0; right: 0; bottom: 0; height: 30px; box-sizing: border-box; z-index: 10; background: var(--fold-front); border: 1px solid var(--fold-line); border-radius: 2px 2px 4px 4px; transform-origin: 50% 100%; transition: transform 160ms ease; }
.scribe-pdf-viewer .scribe-library-fold.mini .front { height: 14px; border-radius: 1.5px 1.5px 2.5px 2.5px; }
.scribe-pdf-viewer .scribe-library-fold.mini .paper { box-shadow: 0 0 0 .5px var(--scribe-line-strong); }
.scribe-pdf-viewer .scribe-library-fold .paper.reserved { box-shadow: 0 0 0 1px transparent; }
.scribe-pdf-viewer .scribe-library-fold .paper.reserved img { opacity: .4; filter: grayscale(.5); }
.scribe-pdf-viewer .scribe-library-fold .paper.reserved::after { opacity: 1; border: 1.5px dashed var(--scribe-accent); background: var(--scribe-accent-wash); }
.scribe-pdf-viewer .scribe-library-fold .paper.leaving { pointer-events: none; }
.scribe-pdf-viewer .scribe-library-card.folder.drop .scribe-library-fold, .scribe-pdf-viewer .scribe-library-row.folder.drop .scribe-library-fold { --fold-back: color-mix(in srgb, var(--scribe-accent) 30%, var(--scribe-surface)); --fold-front: color-mix(in srgb, var(--scribe-accent) 18%, var(--scribe-surface)); --fold-line: var(--scribe-accent); }
.scribe-pdf-viewer .scribe-library-card.folder.drop .scribe-library-fold .front, .scribe-pdf-viewer .scribe-library-row.folder.drop .scribe-library-fold .front { transform: perspective(260px) rotateX(-12deg); }
.scribe-pdf-viewer .scribe-library-card.folder.landed, .scribe-pdf-viewer .scribe-library-row.folder.landed { transition: background-color 400ms ease, border-color 400ms ease, box-shadow 400ms ease; }
/* A drop's undo line that wraps can grow the card while it shows, pushing down everything below. */
.scribe-pdf-viewer .scribe-library-card.folder .meta.live { opacity: 1; color: var(--scribe-ink-2); flex-wrap: nowrap; white-space: nowrap; }
.scribe-pdf-viewer .scribe-library-card.folder .meta.live > .t { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.scribe-pdf-viewer .scribe-library-card.folder .meta.live > .undo { flex: none; }
.scribe-pdf-viewer .scribe-library-card.folder .meta .undo, .scribe-pdf-viewer .scribe-library-row.folder .undo { color: var(--scribe-accent); font-weight: 600; cursor: pointer; }
.scribe-pdf-viewer .scribe-library-card.folder .meta .undo:hover, .scribe-pdf-viewer .scribe-library-row.folder .undo:hover { text-decoration: underline; }
@media (prefers-reduced-motion: reduce) { .scribe-pdf-viewer .scribe-library-fold .paper, .scribe-pdf-viewer .scribe-library-fold .paper img, .scribe-pdf-viewer .scribe-library-fold .paper::after, .scribe-pdf-viewer .scribe-library-fold .front { transition: none; } }
.scribe-pdf-viewer .scribe-library-card.folder .meta.hasatt { opacity: 1; color: var(--scribe-ink-3); }
.scribe-pdf-viewer .scribe-library-card.folder .meta .att, .scribe-pdf-viewer .scribe-library-row.folder .att { color: var(--scribe-ink-2); font-weight: 600; }
.scribe-pdf-viewer .scribe-library-card.folder .meta .att.bad, .scribe-pdf-viewer .scribe-library-row.folder .att.bad { color: var(--scribe-danger); }
.scribe-pdf-viewer .scribe-library-row.folder .roll { color: var(--scribe-ink-3); font-variant-numeric: tabular-nums; font-size: 12.5px; }
.scribe-pdf-viewer .scribe-library-row.folder .roll.pg { font-size: 13px; }
/* The folder name outranks its tally, so the tally gives up all of its width before the name gives up any. */
.scribe-pdf-viewer .scribe-library-row.folder .cnt { display: inline-flex; align-items: baseline; gap: 5px; color: var(--scribe-ink-3); font-size: 12.5px; flex-shrink: 1000; min-width: 0; overflow: hidden; white-space: nowrap; }
.scribe-pdf-viewer .scribe-library-row .fi { width: 18px; height: 18px; color: var(--scribe-ink-2); flex-shrink: 0; }
/* 42px is a page thumbnail's width with its border, so names start on one edge whatever fills the slot. */
.scribe-pdf-viewer .scribe-library-row.cf .fthumb { width: 42px; height: 52px; display: flex; align-items: center; justify-content: center; color: var(--scribe-ink-2); flex-shrink: 0; }
.scribe-pdf-viewer .scribe-library-row.cf .fthumb .fi { width: 26px; height: 26px; }
.scribe-pdf-viewer .scribe-library-card.folder.drop { background: color-mix(in srgb, var(--scribe-accent) 14%, var(--scribe-surface)); border-color: var(--scribe-accent); box-shadow: inset 0 0 0 1px var(--scribe-accent); }
.scribe-pdf-viewer .scribe-library-row.folder.drop { background: color-mix(in srgb, var(--scribe-accent) 14%, var(--scribe-surface)); box-shadow: inset 0 0 0 2px var(--scribe-accent); }
.scribe-pdf-viewer .scribe-library-card.folder .fstrip { position: relative; }
.scribe-pdf-viewer .scribe-library-card.folder .fstrip::before { content: ''; position: absolute; left: calc(50% - 75px); top: 11px; width: 150px; height: 68px; box-sizing: border-box; border: 1.5px dashed var(--scribe-accent); border-radius: 4px; background: color-mix(in srgb, var(--scribe-ink) 5%, var(--scribe-canvas)); opacity: 0; pointer-events: none; }
.scribe-pdf-viewer .scribe-library-card.folder.dragging .fstrip::before { opacity: 1; transition: opacity 140ms ease; }
.scribe-pdf-viewer .scribe-library-card.folder.dragging .fstrip > .scribe-library-fold { visibility: hidden; }
.scribe-pdf-viewer .scribe-library-card.folder.vacated { border-style: dashed; cursor: default; }
.scribe-pdf-viewer .scribe-library-card.folder.vacated:hover { border-color: color-mix(in srgb, var(--scribe-ink) 14%, transparent); }
.scribe-pdf-viewer .scribe-library-card.folder.vacated .scribe-library-fold, .scribe-pdf-viewer .scribe-library-row.folder.vacated .scribe-library-fold { opacity: .35; }
.scribe-pdf-viewer .scribe-library-card.folder.vacated .title, .scribe-pdf-viewer .scribe-library-row.folder.vacated .t { color: var(--scribe-ink-3); }
.scribe-pdf-viewer .scribe-library-row.folder.vacated { cursor: default; }
.scribe-pdf-viewer .scribe-library-row.folder.vacated:hover { background: none; }
.scribe-pdf-viewer .scribe-library-picker { position: absolute; z-index: 66; width: 300px; box-sizing: border-box; background: var(--scribe-surface); border: 1px solid var(--scribe-line); border-radius: 8px; box-shadow: var(--scribe-menu-shadow); font-size: 13px; line-height: 18px; color: var(--scribe-ink); -webkit-user-select: none; user-select: none; }
.scribe-pdf-viewer .scribe-library-picker .pk-head { display: flex; align-items: center; gap: 8px; padding: 9px 8px 7px 12px; cursor: grab; border-bottom: 1px solid var(--scribe-line); }
.scribe-pdf-viewer .scribe-library-picker .pk-head.dragging { cursor: grabbing; }
.scribe-pdf-viewer .scribe-library-picker .pk-title { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.scribe-pdf-viewer .scribe-library-picker .pk-x { width: 22px; height: 22px; border: none; background: none; border-radius: 5px; color: var(--scribe-ink-3); font: inherit; font-size: 16px; line-height: 1; cursor: pointer; }
.scribe-pdf-viewer .scribe-library-picker .pk-x:hover { background: var(--scribe-hover); color: var(--scribe-ink); }
.scribe-pdf-viewer .scribe-library-picker .scribe-library-field { margin: 8px 8px 4px; width: auto; }
.scribe-pdf-viewer .scribe-library-picker .scribe-library-search { width: 100%; }
.scribe-pdf-viewer .scribe-library-picker .pk-tree { max-height: 220px; overflow-y: auto; padding: 2px 4px 4px; }
.scribe-pdf-viewer .scribe-library-picker .pk-row { display: flex; align-items: center; gap: 7px; height: 26px; padding: 0 8px 0 calc(8px + var(--lvl, 0) * 16px); border-radius: 4px; cursor: pointer; white-space: nowrap; }
.scribe-pdf-viewer .scribe-library-picker .pk-row:hover { background: var(--scribe-hover); }
.scribe-pdf-viewer .scribe-library-picker .pk-row.on { background: var(--scribe-active); box-shadow: inset 2px 0 0 var(--scribe-accent); }
.scribe-pdf-viewer .scribe-library-picker .pk-row.off { color: var(--scribe-ink-3); cursor: default; }
.scribe-pdf-viewer .scribe-library-picker .pk-row.off:hover { background: none; }
.scribe-pdf-viewer .scribe-library-picker .pk-row .fi { width: 15px; height: 15px; display: inline-flex; color: var(--scribe-ink-2); flex: none; }
.scribe-pdf-viewer .scribe-library-picker .pk-row.off .fi { color: var(--scribe-ink-3); }
.scribe-pdf-viewer .scribe-library-picker .pk-row .n { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.scribe-pdf-viewer .scribe-library-picker .pk-row .m { margin-left: auto; font-size: 11.5px; color: var(--scribe-ink-3); }
.scribe-pdf-viewer .scribe-library-picker .pk-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 8px; border-top: 1px solid var(--scribe-line); }
.scribe-pdf-viewer .scribe-library-picker .pk-foot .scribe-library-btn { padding: 5px 12px; }
.scribe-pdf-viewer .scribe-library-picker .pk-foot .scribe-library-btn:disabled { opacity: .5; cursor: default; }
.scribe-pdf-viewer .scribe-library-rename { font: inherit; color: var(--scribe-ink); background: var(--scribe-canvas); border: 1px solid var(--scribe-accent); border-radius: 4px; outline: none; box-sizing: border-box; padding: 0 3px; margin: -1px -4px; width: calc(100% + 8px); min-width: 0; }
.scribe-pdf-viewer .scribe-library-card .title:has(> .scribe-library-rename), .scribe-pdf-viewer .scribe-library-row .nm:has(.scribe-library-rename) { overflow: visible; }
.scribe-pdf-viewer .scribe-library-card .title .scribe-library-rename { display: block; field-sizing: content; max-height: calc(2lh + 2px); resize: none; overflow: hidden; }
.scribe-pdf-viewer .scribe-library-row .scribe-library-rename { flex: 1 1 auto; font-weight: 600; }
.scribe-pdf-viewer .scribe-library-row .tt:has(> .scribe-library-rename) { flex-grow: 1; }
.scribe-pdf-viewer .scribe-library-card.other { cursor: default; opacity: .55; }
.scribe-pdf-viewer .scribe-library-card.other:hover { border-color: color-mix(in srgb, var(--scribe-ink) 14%, transparent); }
.scribe-pdf-viewer .scribe-library-card.other .fthumb { aspect-ratio: 3 / 4; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--scribe-ink) 5%, var(--scribe-canvas)); color: var(--scribe-ink-3); }
.scribe-pdf-viewer .scribe-library-card.other .fthumb .fi { width: 46px; height: 46px; }
.scribe-pdf-viewer .scribe-library-card.portfolio > img.thumb { display: none; }
.scribe-pdf-viewer .scribe-library-card.portfolio .fthumb { aspect-ratio: 3 / 4; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--scribe-ink) 5%, var(--scribe-canvas)); color: var(--scribe-ink-2); }
.scribe-pdf-viewer .scribe-library-card.portfolio .fthumb .fi { width: 46px; height: 46px; }
.scribe-pdf-viewer .scribe-library-pv-plate { margin: auto; display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 24px; color: var(--scribe-ink-2); font-size: 13px; text-align: center; }
.scribe-pdf-viewer .scribe-library-pv-plate > .fi { width: 56px; height: 56px; color: var(--scribe-ink-3); }
.scribe-pdf-viewer .scribe-library-pv-plate .n { font-weight: 600; color: var(--scribe-ink); overflow-wrap: anywhere; }
.scribe-pdf-viewer .scribe-library-pv-plate .m { color: var(--scribe-ink-3); }
.scribe-pdf-viewer .scribe-library-pv-plate .scribe-library-btn { margin-top: 8px; }
.scribe-pdf-viewer .scribe-library-pv-plated .scribe-library-pv-nav, .scribe-pdf-viewer .scribe-library-pv-plated .scribe-library-pv-tools { display: none; }
.scribe-pdf-viewer .scribe-library-row.other { cursor: default; opacity: .55; }
.scribe-pdf-viewer .scribe-library-row.other:hover { background: none; }
/* Placed after the inert-item rungs above so a live drag still reads as a drag over them. */
.scribe-pdf-viewer .scribe-library-surface.card-drag, .scribe-pdf-viewer .scribe-library-surface.card-drag * { cursor: grabbing; }
/* Keep these rungs last in the stylesheet, since a base rule declared later out-cascades one at equal specificity. */
.scribe-pdf-viewer .scribe-library-pv-head { container: scribe-pv / inline-size; }
@container scribe-pv (max-width: 472px) {
  .scribe-pdf-viewer .scribe-library-pv-nav .cr-icon-button { display: none; }
}
@container scribe-pv (max-width: 416px) {
  .scribe-pdf-viewer .scribe-library-pv-zoom { display: none; }
  .scribe-pdf-viewer .scribe-library-pv-tools { flex: 0 0 auto; }
}
@container scribe-pv (max-width: 352px) {
  .scribe-pdf-viewer .scribe-library-pv-nav { display: none; }
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
.scribe-pdf-viewer .scribe-library-card .meta.fb { opacity: 1; }
.scribe-pdf-viewer .scribe-library-surface .meta .err, .scribe-pdf-viewer .scribe-library-surface .m2 .err, .scribe-pdf-viewer .scribe-library-row .err { color: var(--scribe-danger); }
.scribe-pdf-viewer .scribe-library-surface .undo { font: inherit; font-size: 12px; font-weight: 600; line-height: inherit; color: var(--scribe-accent); background: none; border: none; padding: 0 5px; margin: 0; border-radius: 4px; cursor: pointer; vertical-align: baseline; }
.scribe-pdf-viewer .scribe-library-surface .undo:hover { background: var(--scribe-hover); }
.scribe-pdf-viewer .scribe-library-card .ocrhair { position: absolute; left: 0; bottom: 0; height: 2px; background: var(--scribe-accent); pointer-events: none; }
/* Revert confirmation: the centered dialog grammar of the Fill & Sign signature dialog. */
.scribe-pdf-viewer .scribe-library-confirm-scrim { position: absolute; inset: 0; z-index: 70; background: rgba(15, 18, 26, .42); display: flex; align-items: center; justify-content: center; }
.scribe-pdf-viewer .scribe-library-confirm { width: min(430px, calc(100% - 32px)); box-sizing: border-box; padding: 16px; background: var(--scribe-surface); border: 1px solid var(--scribe-line); border-radius: 12px; box-shadow: var(--scribe-menu-shadow); color: var(--scribe-ink); font-size: 13px; line-height: 1.5; -webkit-user-select: text; user-select: text; }
.scribe-pdf-viewer .scribe-library-confirm .ttl { font-size: 15px; font-weight: 650; margin-bottom: 10px; }
.scribe-pdf-viewer .scribe-library-confirm .id { display: flex; gap: 10px; align-items: center; padding: 8px; border: 1px solid var(--scribe-line); border-radius: 8px; margin-bottom: 12px; }
.scribe-pdf-viewer .scribe-library-confirm .id img { width: 38px; height: 50px; object-fit: cover; object-position: top; border: 1px solid var(--scribe-line-strong); background: #fff; flex: none; }
.scribe-pdf-viewer .scribe-library-confirm .id .n { font-weight: 600; }
.scribe-pdf-viewer .scribe-library-confirm .id .m { font-size: 12px; color: var(--scribe-ink-2); margin-top: 1px; }
.scribe-pdf-viewer .scribe-library-confirm ul { margin: 8px 0; padding-left: 18px; }
.scribe-pdf-viewer .scribe-library-confirm li { margin: 2px 0; }
.scribe-pdf-viewer .scribe-library-confirm .note { font-size: 12px; color: var(--scribe-ink-2); margin-top: 8px; }
.scribe-pdf-viewer .scribe-library-confirm .foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.scribe-pdf-viewer .scribe-library-confirm .foot button { appearance: none; background: none; border: 1px solid var(--scribe-line-strong); border-radius: 7px; padding: 7px 14px; font: inherit; font-size: 13px; color: var(--scribe-ink); cursor: pointer; }
.scribe-pdf-viewer .scribe-library-confirm .foot button:hover { background: var(--scribe-hover); }
.scribe-pdf-viewer .scribe-library-confirm .foot button:focus-visible { outline: 2px solid var(--scribe-accent-ring); outline-offset: 1px; }
.scribe-pdf-viewer .scribe-library-confirm .foot button.danger { background: var(--scribe-danger); border-color: var(--scribe-danger); color: #fff; font-weight: 650; }
.scribe-pdf-viewer .scribe-library-confirm .foot button.danger:hover { filter: brightness(.94); }
.scribe-pdf-viewer .scribe-library-confirm .id .fth { width: 38px; height: 50px; flex: none; display: flex; align-items: center; justify-content: center; border: 1px solid var(--scribe-line-strong); background: color-mix(in srgb, var(--scribe-ink) 5%, var(--scribe-canvas)); color: var(--scribe-ink-2); }
.scribe-pdf-viewer .scribe-library-confirm .id .fth svg { width: 24px; height: 24px; }
.scribe-pdf-viewer .scribe-library-confirm .chk { display: flex; align-items: flex-start; gap: 8px; margin: 10px 0 2px; cursor: pointer; }
.scribe-pdf-viewer .scribe-library-confirm .chk input { margin: 3px 0 0; accent-color: var(--scribe-accent); flex: none; }
/* The Library Storage sheet, on the same plate as the start sheet. */
.scribe-pdf-viewer .scribe-library-storage { width: 560px; max-width: calc(100% - 44px); margin: 28px auto 0; border: 1px solid color-mix(in srgb, var(--scribe-ink) 14%, transparent); border-radius: 10px; background: var(--scribe-surface); padding: 20px 24px 18px; box-sizing: border-box; font-size: 13px; line-height: 1.5; -webkit-user-select: text; user-select: text; }
.scribe-pdf-viewer .scribe-library-storage .back { display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: 12.5px; font-weight: 600; color: var(--scribe-accent); background: none; border: none; cursor: pointer; padding: 2px 6px 2px 2px; margin: 0 0 10px -2px; border-radius: 5px; white-space: nowrap; }
.scribe-pdf-viewer .scribe-library-storage .back:hover { background: var(--scribe-hover); }
.scribe-pdf-viewer .scribe-library-storage .back svg { width: 14px; height: 14px; flex: none; }
.scribe-pdf-viewer .scribe-library-storage h3 { margin: 0 0 2px; font-size: 15px; font-weight: 650; }
.scribe-pdf-viewer .scribe-library-storage .sub { color: var(--scribe-ink-2); margin-bottom: 12px; }
.scribe-pdf-viewer .scribe-library-storage .row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 4px 14px; align-items: center; padding: 8px 0; border-top: 1px solid var(--scribe-line); }
.scribe-pdf-viewer .scribe-library-storage .row .l { font-weight: 600; }
.scribe-pdf-viewer .scribe-library-storage .row .d { font-size: 12px; color: var(--scribe-ink-2); }
.scribe-pdf-viewer .scribe-library-storage .row .sz { color: var(--scribe-ink-2); font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.scribe-pdf-viewer .scribe-library-storage button.act { font: inherit; font-size: 13px; padding: 5px 11px; border-radius: 7px; border: 1px solid var(--scribe-line-strong); background: none; color: var(--scribe-ink); cursor: pointer; white-space: nowrap; }
.scribe-pdf-viewer .scribe-library-storage button.act:hover { background: var(--scribe-hover); }
.scribe-pdf-viewer .scribe-library-storage button.act:focus-visible { outline: 2px solid var(--scribe-accent-ring); outline-offset: 1px; }
.scribe-pdf-viewer .scribe-library-storage button.act:disabled { color: var(--scribe-ink-3); cursor: default; background: none; }
.scribe-pdf-viewer .scribe-library-storage button.act.danger { color: var(--scribe-danger); border-color: color-mix(in srgb, var(--scribe-danger) 45%, transparent); }
.scribe-pdf-viewer .scribe-library-storage button.act.danger:hover { background: var(--scribe-danger-soft); }
.scribe-pdf-viewer .scribe-library-storage button.act.danger:disabled { color: var(--scribe-ink-3); border-color: var(--scribe-line-strong); background: none; }
.scribe-pdf-viewer .scribe-library-storage button.act.primary { background: var(--scribe-accent); border-color: var(--scribe-accent); color: #fff; font-weight: 650; }
.scribe-pdf-viewer .scribe-library-storage .loc { padding-top: 10px; border-top: 1px solid var(--scribe-line); }
.scribe-pdf-viewer .scribe-library-storage .loc .lt { font-weight: 600; margin-bottom: 6px; }
.scribe-pdf-viewer .scribe-library-storage .opt { display: flex; gap: 9px; align-items: flex-start; padding: 5px 0; cursor: pointer; }
.scribe-pdf-viewer .scribe-library-storage .opt input { margin: 3px 0 0; accent-color: var(--scribe-accent); flex: none; }
.scribe-pdf-viewer .scribe-library-storage .opt .ol { font-weight: 600; }
.scribe-pdf-viewer .scribe-library-storage .opt .od { font-size: 12px; color: var(--scribe-ink-2); }
.scribe-pdf-viewer .scribe-library-storage .mv { display: flex; gap: 8px; align-items: center; justify-content: flex-end; padding: 6px 0 2px; font-size: 12.5px; color: var(--scribe-ink-2); }
.scribe-pdf-viewer .scribe-library-storage .mv[hidden] { display: none; }
.scribe-pdf-viewer .scribe-library-storage .foot { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--scribe-line); }
.scribe-pdf-viewer .scribe-library-storage .foot .tot { color: var(--scribe-ink-2); font-variant-numeric: tabular-nums; }
/* Start screen: one sheet with the two ways in, and one Recent list of folders and files. */
.scribe-pdf-viewer .scribe-library-sheet { width: 560px; max-width: calc(100% - 44px); margin: 44px auto 0; border: 1px solid color-mix(in srgb, var(--scribe-ink) 14%, transparent); border-radius: 10px; background: var(--scribe-surface); padding: 26px 28px 22px; box-sizing: border-box; -webkit-user-select: text; user-select: text; }
.scribe-pdf-viewer .scribe-library-sheet-acts { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.scribe-pdf-viewer .scribe-library-sheet-act { border: 1px solid var(--scribe-line-strong); border-radius: 8px; padding: 14px 14px 12px; display: flex; flex-direction: column; align-items: stretch; gap: 6px; cursor: pointer; background: var(--scribe-surface); color: var(--scribe-ink); font: inherit; text-align: left; }
.scribe-pdf-viewer .scribe-library-sheet-act:hover { border-color: var(--scribe-accent); background: color-mix(in srgb, var(--scribe-accent) 4%, var(--scribe-surface)); }
.scribe-pdf-viewer .scribe-library-sheet-act:focus-visible { outline: 2px solid var(--scribe-accent); outline-offset: 1px; }
.scribe-pdf-viewer .scribe-library-sheet-act .t { display: flex; align-items: center; gap: 8px; font-weight: 650; font-size: 14px; }
.scribe-pdf-viewer .scribe-library-sheet-act .t .ic { display: inline-flex; width: 18px; height: 18px; color: var(--scribe-ink-2); flex-shrink: 0; }
.scribe-pdf-viewer .scribe-library-sheet-act .kbd { margin-left: auto; font-size: 11.5px; font-weight: 400; color: var(--scribe-ink-3); }
.scribe-pdf-viewer .scribe-library-sheet-act .d { font-size: 12.5px; color: var(--scribe-ink-2); line-height: 1.45; }
.scribe-pdf-viewer .scribe-library-sheet .scribe-library-recent { margin: 16px 0 0; }
.scribe-pdf-viewer .scribe-library-sheet-hint { text-align: center; font-size: 12.5px; color: var(--scribe-ink-3); margin-top: 14px; }
@media (max-width: 640px) { .scribe-pdf-viewer .scribe-library-sheet-acts { grid-template-columns: 1fr; } }
/* Just added: the row a drop or Add PDFs… lands in, with a way to take each copy back, until the user is done with it. */
.scribe-pdf-viewer .scribe-library-shelf-label { display: flex; align-items: center; gap: 12px; margin: 4px 0 10px; font-size: 12px; min-width: 0; }
.scribe-pdf-viewer .scribe-library-shelf-label .h { font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--scribe-ink-2); white-space: nowrap; }
.scribe-pdf-viewer .scribe-library-shelf-label .note { color: var(--scribe-ink-2); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.scribe-pdf-viewer .scribe-library-shelf-label .done { margin-left: auto; font: inherit; font-size: 13px; font-weight: 600; color: var(--scribe-accent); background: none; border: none; cursor: pointer; padding: 2px 6px; border-radius: 5px; white-space: nowrap; }
.scribe-pdf-viewer .scribe-library-shelf-label .done:hover { background: var(--scribe-hover); }
.scribe-pdf-viewer .scribe-library-grid.shelf .scribe-library-card { border-color: var(--scribe-accent); }
.scribe-pdf-viewer .scribe-library-card .shelf-act { margin-top: 6px; padding: 0; border: none; background: none; font: inherit; font-size: 12px; font-weight: 600; color: var(--scribe-accent); cursor: pointer; }
.scribe-pdf-viewer .scribe-library-card .shelf-act:hover { text-decoration: underline; }
/* The folder's own menu, reached from its name in the bar and from the chevron on its tab. */
.scribe-pdf-viewer .scribe-library-folder-menu { left: 0; right: auto; min-width: 230px; z-index: 60; }
.scribe-pdf-viewer .scribe-library-folder-menu .scribe-library-menu-item svg { visibility: visible; color: var(--scribe-ink-2); }
.scribe-pdf-viewer .scribe-library-folder-menu .scribe-library-menu-item.disabled { color: var(--scribe-ink-3); cursor: default; }
.scribe-pdf-viewer .scribe-library-folder-menu .scribe-library-menu-item.disabled svg { color: var(--scribe-ink-3); }
.scribe-pdf-viewer .scribe-library-folder-menu .scribe-library-menu-item.disabled:hover { background: none; }
.scribe-pdf-viewer .scribe-library-crumb-root { display: inline-flex; align-items: center; gap: 5px; padding: 2px 6px; margin-left: -6px; border-radius: 6px; border: none; background: none; color: inherit; font: inherit; font-weight: 600; cursor: pointer; min-width: 0; }
.scribe-pdf-viewer .scribe-library-crumb-root:hover { background: var(--scribe-hover); }
.scribe-pdf-viewer .scribe-library-crumb-root .chev { width: 12px; height: 12px; color: var(--scribe-ink-3); flex-shrink: 0; }
.scribe-pdf-viewer .scribe-library-crumb-root .nm { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;
  document.head.appendChild(style);
};

/**
 * The split shell shared by the search results and the list view's preview.
 * It holds a resizable left column, a drag sash, and room for the pane the caller appends.
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
    const onMove = (/** @type {PointerEvent} */ ev) => {
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

/**
 * One library-style surface: the document library over its folder store, or that same surface over another store, such as a PDF portfolio's embedded files.
 * The folder connection, the resume record and the app-menu items exist only for the library kind.
 * @param {import('../basic-viewer/pdf-viewer.js').ScribePDFViewer} viewer
 * @param {LibraryInstanceOptions} opts
 * @returns {LibraryInstance}
 */
export function createLibraryInstance(viewer, opts) {
  addLibraryStyles();
  const isLibrary = opts.kind === 'library';
  const readOnly = !!opts.readOnly;
  const persistPrefs = !!opts.persistPrefs;
  const instanceId = ++instanceCounter;
  /** @param {?{libraryOwner?: number}} tab */
  const ownsTab = (tab) => !!tab && tab.libraryOwner === instanceId;

  const shell = /** @type {any} */ (window).electronAPI;
  // The desktop app's record must survive a relaunch, while each browser tab restores only the documents it had open.
  const resumeStorage = shell ? window.localStorage : window.sessionStorage;
  /** @type {?LibraryStore} */
  let store = null;
  /** @type {?import('./libraryStore.js').LibraryManifest} */
  let manifest = null;
  const engine = createSearchClient(opts.engineSettings || {});
  /** @type {?import('./search/searchClient.js').SearchResponse} */
  let engineResponse = null;
  /** @type {?import('./search/searchClient.js').SearchResponse} */
  let engineTiers = null;
  /** @type {?string} */
  let engineError = null;
  /** @type {?LibraryIngest} */
  let ingest = null;
  let visible = false;
  let sortMode = 'name';
  /** 1 or -1, relative to each key's ascending order. */
  let sortDir = 1;
  /** @type {'grid' | 'list' | 'compact'} */
  let viewMode = opts.viewDefault ?? 'grid';
  if (persistPrefs) {
    try {
      const storedView = window.localStorage.getItem(VIEW_STORAGE_KEY);
      if (storedView === 'list' || storedView === 'compact') viewMode = storedView;
    } catch { /* localStorage unavailable. */ }
  }
  /** Whether the browse views also list the folder's non-PDF files. */
  let showOthers = opts.showOthersDefault ?? false;
  if (persistPrefs) {
    try {
      showOthers = window.localStorage.getItem(OTHERS_STORAGE_KEY) === '1';
    } catch { /* localStorage unavailable. */ }
  }
  /** @type {{list: ?number[], compact: ?number[]}} List column widths in px, null until the first list render sizes them. */
  const colWidths = { list: null, compact: null };
  /** Whether the user has resized a column in each mode, which a seeded width alone does not set. */
  const colSized = { list: false, compact: false };
  if (persistPrefs) {
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
  }
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
  let listPreviewOn = opts.previewDefault ?? false;
  if (persistPrefs) {
    try {
      listPreviewOn = window.localStorage.getItem(PREVIEW_STORAGE_KEY) === '1';
    } catch { /* localStorage unavailable. */ }
  }
  /** @type {?string} The document the list view previews. */
  let listPreviewPath = null;
  let listPreviewPage = 0;
  const sessions = new DocSessions();
  /** @type {?number} */
  let manifestTimer = null;
  let destroyed = false;
  /**
   * The open-tab record the previous page load left in sessionStorage.
   * The first `openLibrary` consumes it, so a later folder switch cannot replay it.
   * @type {?{v: number, dir: string, tabs: Array<{hash: string, relPath: string, page: number}>, active: number,
   *   view: ?{zoom: number, sx: number, sy: number}, lib: number}}
   */
  let resumeRecord = null;
  if (isLibrary && !shell?.freshWindow) {
    try {
      const rawResume = resumeStorage.getItem(RESUME_STORAGE_KEY);
      const parsedResume = rawResume ? JSON.parse(rawResume) : null;
      if (parsedResume?.v === 1 && Array.isArray(parsedResume.tabs)) resumeRecord = parsedResume;
    } catch { /* Storage unavailable, or the record is not JSON. */ }
  }
  /** Set while `openLibrary` is reopening recorded tabs, so interim writes cannot clobber the record mid-restore. */
  let restoringTabs = false;
  /**
   * Whether the record reopens into a document view rather than the library.
   * The drop zone is hidden here rather than in the boot below, so the placeholder never flashes before the restored document paints.
   */
  const viewerRestorePending = !!(resumeRecord && resumeRecord.tabs.length && !resumeRecord.lib);
  if (viewerRestorePending && viewer.dropZone) viewer.dropZone.style.display = 'none';
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
  let storageOpen = false;
  /** @type {?{previews: number, index: number, notes: number}} */
  let storageSizes = null;
  /** Set while the folder's data is being deleted, so closing the folder does not write it back. */
  let discardOnClose = false;

  // --- DOM scaffold -------------------------------------------------------

  const surface = document.createElement('div');
  surface.className = 'scribe-library-surface';
  surface.style.display = 'none';

  const header = document.createElement('div');
  header.className = 'scribe-library-header';
  const crumbsElem = document.createElement('div');
  crumbsElem.className = 'scribe-library-crumbs';
  crumbsElem.textContent = opts.name;
  header.appendChild(crumbsElem);

  const searchField = document.createElement('span');
  searchField.className = 'scribe-library-field';
  searchField.innerHTML = FIELD_SEARCH_SVG;
  const searchInput = document.createElement('input');
  searchInput.className = 'scribe-library-search';
  searchInput.type = 'text';
  searchInput.placeholder = 'Search or filter by name';
  searchInput.setAttribute('aria-label', 'Search documents');
  searchField.appendChild(searchInput);
  const searchHint = document.createElement('span');
  searchHint.className = 'scribe-library-hint';
  searchHint.innerHTML = '<kbd>↵</kbd> search contents';
  searchField.appendChild(searchHint);
  const clearBtn = document.createElement('button');
  clearBtn.className = 'scribe-library-clear';
  clearBtn.setAttribute('aria-label', 'Clear');
  clearBtn.innerHTML = FIELD_CLEAR_SVG;
  searchField.appendChild(clearBtn);
  header.appendChild(searchField);
  const hintMeasure = /** @type {CanvasRenderingContext2D} */ (document.createElement('canvas').getContext('2d'));
  const syncHint = () => {
    if (!searchInput.value || searchField.classList.contains('hint-tight') || document.activeElement !== searchInput) return;
    const style = getComputedStyle(searchInput);
    hintMeasure.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const textWidth = hintMeasure.measureText(searchInput.value).width;
    // The room beside a fully shown hint, read off the live layout so a fold in progress measures the same as a settled one.
    const room = searchInput.clientWidth + searchHint.offsetWidth + parseFloat(getComputedStyle(searchHint).marginLeft) - searchHint.scrollWidth;
    searchField.classList.toggle('hint-yield', textWidth + 8 > room);
  };
  // A container query here would zero the field's contribution to the content-sized bar zone and pin it at its minimum width, so the signal comes from a resize observer.
  const hintObserver = new ResizeObserver((entries) => {
    searchField.classList.toggle('hint-tight', entries[0].contentRect.width < 250);
    syncHint();
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
  previewBtn.innerHTML = slotIcon('preview22');
  previewBtn.title = 'Preview panel';
  previewBtn.setAttribute('aria-label', 'Preview panel');
  header.appendChild(previewBtn);

  const headerSep = document.createElement('span');
  headerSep.className = 'vertical-separator';
  if (!readOnly) header.appendChild(headerSep);

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
  const newPdfItem = document.createElement('div');
  newPdfItem.className = 'scribe-library-menu-item';
  newPdfItem.setAttribute('role', 'menuitem');
  newPdfItem.innerHTML = IMAGE_SVG;
  newPdfItem.appendChild(document.createTextNode('New PDF from images…'));
  newMenu.appendChild(newPdfItem);
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
  if (!readOnly) header.appendChild(newWrap);

  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'scribe-library-hicon';
  refreshBtn.innerHTML = slotIcon('refresh22');
  refreshBtn.title = 'Re-scan the folder for new, changed, or removed files';
  refreshBtn.setAttribute('aria-label', 'Refresh folder');
  if (!readOnly) header.appendChild(refreshBtn);

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.accept = 'application/pdf,.pdf';
  fileInput.style.display = 'none';
  header.appendChild(fileInput);

  const imageInput = document.createElement('input');
  imageInput.type = 'file';
  imageInput.multiple = true;
  imageInput.accept = 'image/png,image/jpeg,.png,.jpg,.jpeg';
  imageInput.style.display = 'none';
  header.appendChild(imageInput);

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
    // A read-only store (a portfolio) has nothing to add or rescan, so its bar ends at the preview toggle.
    for (const el of readOnly ? [searchField, viewSeg, sortWrap, previewBtn] : [searchField, viewSeg, sortWrap, previewBtn, headerSep, newWrap, refreshBtn]) barControls.appendChild(el);
    // A desktop shell's window controls stay the end zone's last element, so the library bar mounts before them.
    viewer.toolbarElemEnd.insertBefore(barControls, viewer.toolbarElemEnd.querySelector('.scribe-shell-corner'));
    surface.appendChild(fileInput);
    surface.appendChild(imageInput);
  } else {
    surface.appendChild(header);
  }
  surface.appendChild(progressElem);
  surface.appendChild(body);
  viewer.pdfViewerElem.appendChild(surface);

  const homeTab = document.createElement('div');
  homeTab.className = 'scribe-tab pinned';
  homeTab.title = opts.name;
  homeTab.innerHTML = `<span class="scribe-tab-icon">${opts.glyph}</span><span class="scribe-tab-name"></span>`;
  /** @type {HTMLElement} */ (homeTab.querySelector('.scribe-tab-name')).textContent = opts.name;
  if (opts.onClose) {
    const close = document.createElement('span');
    close.className = 'scribe-tab-close';
    close.textContent = '×';
    close.role = 'button';
    close.ariaLabel = `Close ${opts.name}`;
    // Stopped so closing never also selects the tab.
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.onClose?.();
    });
    homeTab.appendChild(close);
  }
  /** @type {?HTMLElement} */
  let homeTabChev = null;
  if (isLibrary) {
    const chev = document.createElement('span');
    chev.className = 'scribe-tab-chev';
    chev.innerHTML = CHEVRON_SVG;
    chev.title = 'Folder actions';
    chev.role = 'button';
    chev.tabIndex = 0;
    // Stopped so opening the menu never also selects the tab.
    chev.addEventListener('click', (e) => e.stopPropagation());
    homeTab.appendChild(chev);
    homeTabChev = chev;
  }
  // The library mounts its tab when a folder opens.
  if (viewer._tabStrip && !isLibrary) {
    viewer._tabStrip.addPinnedTab(homeTab);
    viewer._tabStripMinTabs = 1;
    viewer._renderTabs();
  }

  // --- Layout -------------------------------------------------------------

  const positionSurface = () => {
    surface.style.top = `${viewer._topBarsHeight()}px`;
  };
  const resizeObserver = new ResizeObserver(positionSurface);
  resizeObserver.observe(viewer.pdfViewerElem);

  // --- The split form -----------------------------------------------------
  // The main viewer draws the document in the pane's area, under a head whose controls drive it directly.

  /** @type {Array<{el: HTMLElement, display: string}>} */
  let hiddenBarElems = [];
  let barSwapped = false;
  let priorEndZoneFlex = '';
  let resultsListWidth = 400;
  let listPreviewWidth = 700;
  /** @type {?HTMLElement} The split's column, mounted by the render that builds the results or the list. */
  let splitLeft = null;

  const pane = document.createElement('div');
  pane.className = 'scribe-library-pv';
  // The toolbar class applies the toolbar-scoped styles of the find bar and the page input.
  pane.innerHTML = '<div class="scribe-library-pv-head scribe-pdf-viewer-toolbar" style="display:none;">'
    + '<span class="t"></span><span class="scribe-library-pv-tools"></span></div>'
    + '<div class="scribe-library-pv-stage"><div class="scribe-library-pv-empty"></div>'
    + '<div class="scribe-library-pv-loading" style="display:none;"><div class="scribe-library-pv-loading-spin"></div>Loading page…</div></div>';
  const pvHead = /** @type {HTMLElement} */ (pane.querySelector('.scribe-library-pv-head'));
  const pvTitle = /** @type {HTMLElement} */ (pvHead.querySelector('.t'));
  const pvTools = /** @type {HTMLElement} */ (pvHead.querySelector('.scribe-library-pv-tools'));
  const pvStage = /** @type {HTMLElement} */ (pane.querySelector('.scribe-library-pv-stage'));
  const pvEmpty = /** @type {HTMLElement} */ (pane.querySelector('.scribe-library-pv-empty'));
  const pvLoading = /** @type {HTMLElement} */ (pane.querySelector('.scribe-library-pv-loading'));
  const pvPlate = document.createElement('div');
  pvPlate.className = 'scribe-library-pv-plate';
  pvPlate.style.display = 'none';
  pvStage.appendChild(pvPlate);
  const pageNav = createPageNav(viewer.scribe);
  const navWrap = document.createElement('span');
  navWrap.className = 'scribe-library-pv-nav';
  navWrap.append(pageNav.prevElem, pageNav.nextElem, pageNav.pageInputGroup);
  pvTitle.after(navWrap);
  // The title and the tools split the head's leftover width, which can land the page controls on a half pixel.
  let navObserver = null;
  if (typeof ResizeObserver !== 'undefined') {
    navObserver = new ResizeObserver(() => {
      navWrap.style.left = '';
      const x = navWrap.getBoundingClientRect().left - pvHead.getBoundingClientRect().left;
      const frac = x - Math.round(x);
      navWrap.style.position = 'relative';
      navWrap.style.left = Math.abs(frac) > 0.01 ? `${-frac}px` : '';
    });
    navObserver.observe(pvHead);
  }
  pageNav.pageNumElem.addEventListener('focus', () => pageNav.pageNumElem.select());
  // Wrapped because the pair sets its display inline, which would override the width rule that hides it.
  const zoomWrap = document.createElement('span');
  zoomWrap.className = 'scribe-library-pv-zoom';
  zoomWrap.appendChild(createZoomControls(viewer.scribe).zoomControls);
  const pvOpenBtn = makeIconButton('Open', barIcon('openInTab'));
  const pvSep = makeSeparator();
  const pvFindSep = makeSeparator();
  pvFindSep.style.display = 'none';
  pvTools.append(zoomWrap, pvFindSep, pvSep, pvOpenBtn);
  /** Show the viewer's page in the head's page control. */
  const syncPaneNav = () => {
    const d = viewer.doc;
    if (!d || !d.pageMetrics.length) return;
    if (document.activeElement !== pageNav.pageNumElem) pageNav.pageNumElem.value = String(viewer.scribe.state.cp.n + 1);
    pageNav.pageCountElem.textContent = String(d.pageMetrics.length);
  };
  /** @type {?{btnParent: ?HTMLElement, btnNext: ?Node, groupParent: ?HTMLElement, groupNext: ?Node}} Where the viewer's find control and bar came from, while the pane head holds them. */
  let findHome = null;
  /** Move the viewer's find control and bar into the pane head, so the preview's find is the viewer's own. */
  const takeFindBar = () => {
    const bar = viewer._searchBar;
    if (!bar || findHome) return;
    findHome = {
      btnParent: bar.searchElem.parentElement, btnNext: bar.searchElem.nextSibling, groupParent: bar.findGroupElem.parentElement, groupNext: bar.findGroupElem.nextSibling,
    };
    pvTools.insertBefore(bar.searchElem, pvSep);
    bar.searchElem.style.display = '';
    pvFindSep.style.display = '';
    pvHead.appendChild(bar.findGroupElem);
    bar.rehome();
  };
  const returnFindBar = () => {
    const bar = viewer._searchBar;
    if (!bar || !findHome) return;
    const h = findHome;
    findHome = null;
    pvFindSep.style.display = 'none';
    h.btnParent?.insertBefore(bar.searchElem, h.btnNext && h.btnNext.parentNode === h.btnParent ? h.btnNext : null);
    h.groupParent?.insertBefore(bar.findGroupElem, h.groupNext && h.groupNext.parentNode === h.groupParent ? h.groupNext : null);
    // The toolbar's document controls stay hidden while the library bar is in, and the swap out shows them again.
    if (barSwapped) bar.searchElem.style.display = 'none';
  };

  /** Whether the library shows the rows' column beside the pane. */
  const splitForm = () => !!barControls && !viewer._phoneUi && !!store && !!manifest && !storageOpen
    && (!!fullTextResults || (listPreviewOn && viewMode !== 'grid'));

  /** True while Open or a return morphs between the pane and the rail, so the inset sync leaves the inset to it. */
  let morphing = false;
  /** Set ahead of an Open from the pane, so the deactivate the viewer asks for waits for the morph. */
  let morphPending = false;

  /** Inset the document area to the pane while the split form is up, and clear the inset otherwise. */
  const syncDocInset = () => {
    if (morphing) return;
    if (!visible || !splitForm() || !pvStage.isConnected || surface.style.display === 'none') {
      viewer.setDocInset(null);
      return;
    }
    const rootRect = viewer.pdfViewerElem.getBoundingClientRect();
    const r = pvStage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    viewer.setDocInset({ left: Math.round(r.left - rootRect.left), top: Math.round(r.top - rootRect.top) - viewer._topBarsHeight() });
  };
  // Relaying out inside the observer's delivery resizes elements other observers watch in the same cycle, which the browser reports as a resize loop.
  let insetSyncRaf = 0;
  const stageObserver = new ResizeObserver(() => {
    cancelAnimationFrame(insetSyncRaf);
    insetSyncRaf = requestAnimationFrame(() => { insetSyncRaf = 0; syncDocInset(); });
  });
  stageObserver.observe(pvStage);

  /** @type {'empty'|'loading'|'ready'|'error'|'plate'} What the pane shows besides the document. */
  let stageKind = 'empty';

  /** Show the previewed document's name and Open in the pane head, a plate's name alone, or no head without a selection. */
  const syncPaneHead = () => {
    const last = preview.lastTarget();
    const plated = stageKind === 'plate';
    const title = last ? last.title : (plated && listPreviewPath ? (listPreviewPath.split('/').pop() || listPreviewPath) : null);
    pvHead.style.display = title ? '' : 'none';
    pvTitle.textContent = title ?? '';
    pvTitle.title = title ?? '';
    pane.classList.toggle('scribe-library-pv-plated', plated);
    pvOpenBtn.classList.toggle('disabled', !last);
    if (last) syncPaneNav();
  };

  /**
   * Set what the pane shows besides the document.
   * A load over a seeded page shows the page through the stage too, under the spinner.
   * @param {'empty'|'loading'|'ready'|'error'|'plate'} kind
   * @param {string} [text]
   */
  const setStage = (kind, text) => {
    stageKind = kind;
    pvStage.classList.toggle('live', kind === 'ready' || (kind === 'loading' && !!viewer.doc));
    pvLoading.style.display = kind === 'loading' ? '' : 'none';
    pvPlate.style.display = kind === 'plate' ? '' : 'none';
    pvEmpty.style.display = kind === 'empty' || kind === 'error' ? '' : 'none';
    if (kind === 'empty') pvEmpty.textContent = fullTextResults ? 'Select a result to preview it here' : 'Select a document to preview it here';
    else if (kind === 'error') pvEmpty.textContent = text ?? 'This page could not be rendered.';
    syncPaneHead();
    syncDocInset();
  };

  /**
   * Show a file the viewer cannot render, with its name, its kind and the one action that applies to it.
   * @param {{title: string, badge: string, icon: string, note: string, action: string, onAction: () => void}} target
   */
  const showPlate = (target) => {
    pvPlate.replaceChildren();
    pvPlate.insertAdjacentHTML('beforeend', `<span class="fi">${target.icon}</span>`);
    const nameEl = document.createElement('div');
    nameEl.className = 'n';
    nameEl.textContent = target.title;
    const badgeEl = document.createElement('span');
    badgeEl.className = 'scribe-library-badge';
    badgeEl.textContent = target.badge;
    const noteEl = document.createElement('div');
    noteEl.className = 'm';
    noteEl.textContent = target.note;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'scribe-library-btn';
    btn.textContent = target.action;
    btn.addEventListener('click', () => target.onAction());
    pvPlate.append(nameEl, badgeEl, noteEl, btn);
    setStage('plate');
  };

  /**
   * Mount the split's column, sash and pane in the body, and return the column for the rows.
   * @param {'results'|'list'} kind
   */
  const mountSplit = (kind) => {
    const defaultWidth = kind === 'results' ? 400 : 700;
    const { wrap, left } = buildPreviewSplit(
      defaultWidth,
      () => (kind === 'results' ? resultsListWidth : listPreviewWidth),
      (w) => { if (kind === 'results') resultsListWidth = w; else listPreviewWidth = w; },
    );
    wrap.appendChild(pane);
    body.appendChild(wrap);
    body.classList.add('split-mode');
    splitLeft = left;
    return left;
  };

  /** Put the lit library's bar and surface on screen, with the find bar in the pane head in the split form. */
  const applyForm = () => {
    if (!visible) return;
    swapBarIn();
    surface.style.display = 'flex';
    const split = splitForm();
    surface.classList.toggle('split', split);
    if (split) takeFindBar();
    else {
      returnFindBar();
      viewer.setDocInset(null);
    }
    viewer._syncFrontSurface();
  };

  const MORPH_MS = 200;
  const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const railWidth = () => parseFloat(viewer._thumbnailPanel?.panelElem.style.width) || 230;

  /**
   * Run `step(e)` from 0 to 1 over the morph's duration, eased out.
   * @param {(e: number) => void} step
   */
  const runMorph = (step) => new Promise((done) => {
    /** @type {?number} */
    let t0 = null;
    const frame = (/** @type {number} */ ts) => {
      if (t0 === null) t0 = ts;
      const p = destroyed ? 1 : Math.min(1, (ts - t0) / MORPH_MS);
      step(1 - (1 - p) ** 3);
      if (p < 1) requestAnimationFrame(frame);
      else done();
    };
    requestAnimationFrame(frame);
  });

  /**
   * Pin the head at its current width to the pane's right edge.
   * The pane can then widen around it without moving its controls.
   * @returns {() => void} Undoes the pin.
   */
  const pinHead = () => {
    const priorPane = pane.style.position;
    const priorHead = pvHead.style.cssText;
    const width = pvHead.getBoundingClientRect().width;
    pane.style.position = 'relative';
    pvHead.style.position = 'absolute';
    pvHead.style.top = '0';
    pvHead.style.right = '0';
    pvHead.style.width = `${width}px`;
    return () => {
      pvHead.style.cssText = priorHead;
      pane.style.position = priorPane;
    };
  };

  /**
   * Cross-fade the toolbar between its library and viewer forms in place.
   * @param {HTMLElement[]} leaving - The parts on show, which `swap` hides.
   * @param {() => HTMLElement[]} swap - Changes the form and returns the parts it shows.
   * @param {boolean} libraryGhost - Whether `leaving` is the library's parts.
   * @returns {() => void} Ends the fade.
   */
  const crossFadeBar = (leaving, swap, libraryGhost) => {
    const bar = viewer.toolbarElem;
    if (!bar) {
      swap();
      return () => {};
    }
    const rootRect = viewer.pdfViewerElem.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    const ghost = document.createElement('div');
    // The library's parts take their narrow-bar styles from the library bar's container queries, so their ghost must be a container of the same name.
    ghost.className = `scribe-pdf-viewer-toolbar scribe-library-bar-ghost${libraryGhost ? ' scribe-library-bar' : ''}`;
    ghost.setAttribute('aria-hidden', 'true');
    ghost.style.left = `${barRect.left - rootRect.left}px`;
    ghost.style.top = `${barRect.top - rootRect.top}px`;
    ghost.style.width = `${barRect.width}px`;
    ghost.style.height = `${barRect.height}px`;
    for (const el of leaving) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const clone = /** @type {HTMLElement} */ (el.cloneNode(true));
      clone.setAttribute('inert', '');
      clone.removeAttribute('id');
      for (const inner of clone.querySelectorAll('[id]')) inner.removeAttribute('id');
      clone.style.left = `${r.left - barRect.left}px`;
      clone.style.top = `${r.top - barRect.top}px`;
      clone.style.width = `${r.width}px`;
      clone.style.height = `${r.height}px`;
      ghost.appendChild(clone);
    }
    viewer.pdfViewerElem.appendChild(ghost);
    const arriving = swap();
    for (const el of arriving) {
      el.style.transition = 'none';
      el.style.opacity = '0';
    }
    // A layout read commits the start opacities before the transitions arm.
    bar.getBoundingClientRect();
    ghost.style.transition = `opacity ${MORPH_MS}ms ease`;
    ghost.style.opacity = '0';
    for (const el of arriving) {
      el.style.transition = `opacity ${MORPH_MS}ms ease`;
      el.style.opacity = '1';
    }
    return () => {
      ghost.remove();
      for (const el of arriving) {
        el.style.transition = '';
        el.style.opacity = '';
      }
    };
  };

  /** Morph from the pane to the rail for Open. */
  const morphOut = async () => {
    const left = splitLeft;
    const start = viewer._docInset;
    const sc = viewer.scribe.scrollContainer;
    if (!viewer._phoneUi && !viewer._activeSidebar) viewer.showSidebarNow('thumbnails');
    if (left && start && sc && !viewer._phoneUi && !reducedMotion()) {
      morphing = true;
      const toW = railWidth();
      const sash = /** @type {?HTMLElement} */ (left.nextElementSibling);
      if (sash) sash.style.visibility = 'hidden';
      const scrollStart = sc.scrollTop;
      const unpinHead = pinHead();
      // The head's find control is the viewer's own, so it goes back to the toolbar now to fade in with the toolbar's other controls.
      // A stand-in takes its place in the head for the slide.
      const bar = viewer._searchBar;
      const findStand = bar && findHome ? /** @type {HTMLElement} */ (bar.searchElem.cloneNode(true)) : null;
      if (findStand && bar) {
        findStand.setAttribute('inert', '');
        findStand.setAttribute('aria-hidden', 'true');
        bar.searchElem.before(findStand);
      }
      const libraryParts = /** @type {HTMLElement[]} */ ([barTitle, barControls].filter((el) => el));
      const endBarFade = crossFadeBar(libraryParts, () => {
        const shown = hiddenBarElems.filter((h) => h.display !== 'none').map((h) => h.el);
        returnFindBar();
        swapBarOut();
        return shown;
      }, true);
      surface.classList.add('leaving');
      await runMorph((e) => {
        const insetLeft = start.left + (toW - start.left) * e;
        const insetTop = Math.round(start.top * (1 - e));
        left.style.width = `${Math.max(0, insetLeft - 1)}px`;
        pvHead.style.transform = `translateY(${insetTop - start.top}px)`;
        viewer.setDocInset({ left: Math.round(insetLeft), top: insetTop });
        sc.scrollTop = Math.max(0, scrollStart - (start.top - insetTop));
      });
      left.style.width = '';
      if (sash) sash.style.visibility = '';
      findStand?.remove();
      unpinHead();
      endBarFade();
      surface.classList.remove('leaving');
      morphing = false;
      morphPending = false;
      deactivate();
      return;
    }
    morphPending = false;
    const top = viewer._docInset ? viewer._docInset.top : 0;
    deactivate();
    if (sc && top) sc.scrollTop = Math.max(0, sc.scrollTop - top);
  };

  /**
   * Morph from the rail back to the pane for a return.
   * @param {() => void} endBarFade - Ends the bar's cross-fade the activation armed.
   */
  const morphIn = async (endBarFade) => {
    const left = splitLeft;
    const sc = viewer.scribe.scrollContainer;
    if (!left || !sc || viewer._phoneUi || reducedMotion()) {
      endBarFade();
      if (viewer._activeSidebar) viewer.hideSidebarNow();
      syncDocInset();
      return;
    }
    morphing = true;
    const rail = viewer._panelFor(viewer._activeSidebar);
    const fromW = rail ? railWidth() : 0;
    const rootRect = viewer.pdfViewerElem.getBoundingClientRect();
    const r = pvStage.getBoundingClientRect();
    const toLeft = Math.round(r.left - rootRect.left);
    const topInset = Math.round(r.top - rootRect.top) - viewer._topBarsHeight();
    const hadTop = viewer._docInset ? viewer._docInset.top : 0;
    const scrollStart = sc.scrollTop;
    const sash = /** @type {?HTMLElement} */ (left.nextElementSibling);
    if (sash) sash.style.visibility = 'hidden';
    const unpinHead = pinHead();
    surface.classList.add('entering');
    left.style.width = `${Math.max(0, fromW - 1)}px`;
    pvHead.style.transform = `translateY(${hadTop - topInset}px)`;
    viewer.setDocInset({ left: fromW, top: hadTop });
    const strip = viewer._sidebarTabsElem;
    for (const el of [rail?.panelElem, strip]) {
      if (!el) continue;
      el.style.transition = 'opacity 200ms ease';
      el.style.opacity = '0';
    }
    // A layout read commits the start styles before the class arms the fades.
    left.getBoundingClientRect();
    surface.classList.add('arrived');
    await runMorph((e) => {
      const insetLeft = fromW + (toLeft - fromW) * e;
      const insetTop = Math.round(hadTop + (topInset - hadTop) * e);
      left.style.width = `${Math.max(0, insetLeft - 1)}px`;
      pvHead.style.transform = `translateY(${insetTop - topInset}px)`;
      viewer.setDocInset({ left: Math.round(insetLeft), top: insetTop });
      sc.scrollTop = scrollStart + (insetTop - hadTop);
    });
    left.style.width = '';
    if (sash) sash.style.visibility = '';
    unpinHead();
    endBarFade();
    surface.classList.remove('entering', 'arrived');
    if (viewer._activeSidebar) viewer.hideSidebarNow();
    for (const el of [rail?.panelElem, strip]) {
      if (!el) continue;
      el.style.transition = '';
      el.style.opacity = '';
    }
    morphing = false;
    syncDocInset();
  };

  /**
   * Light the library's tab and put its form on screen.
   * @param {{render?: boolean, attach?: boolean, morph?: boolean}} [options] - `render` rebuilds the body afterwards.
   *   `attach` puts the split form's selection in the pane.
   *   `morph` animates the return from a tab's document.
   */
  const activate = ({ render: doRender = true, attach = true, morph = false } = {}) => {
    // One pinned surface shows at a time, so another instance's is hidden before this one takes the bar.
    for (const inst of viewer._libraryInstances) {
      if (inst !== api && inst.visible()) inst.hide();
    }
    visible = true;
    viewer._lastPinned = api;
    positionSurface();
    viewer._tabStrip?.setPinnedActive(true);
    homeTab.classList.add('active');
    const split = splitForm();
    const fromTab = morph && split && !!viewer.doc && viewer._activeTab >= 0 && !viewer._phoneUi;
    if (split) {
      if (attach) {
        // The document area keeps a tab's document from the folder, with its row marked; otherwise it shows the last selection, or nothing.
        const tab = viewer._activeTab >= 0 ? viewer._tabs[viewer._activeTab] : null;
        const tabEntry = tab && tab.doc === viewer.doc && tab.libraryHash && tab.libraryRelPath && manifest ? manifest.docs[tab.libraryRelPath] : null;
        const last = preview.lastTarget();
        if (tabEntry && tab) {
          const pageN = viewer.scribe.state.cp.n;
          const adopted = preview.adoptAttached({
            relPath: tab.libraryRelPath, hash: tab.libraryHash, entry: tabEntry, pageN, query: fullTextResults ? fullTextQuery : null, title: titleOf(tab.libraryRelPath),
          });
          if (adopted) {
            if (fullTextResults) results.select(tab.libraryRelPath, pageN);
            else {
              listPreviewPath = tab.libraryRelPath;
              listPreviewPage = pageN;
              // Without this, rows the reader selected before leaving the library stay marked while the pane shows another document.
              selectedPaths.clear();
              selectedPaths.add(tab.libraryRelPath);
              selAnchor = tab.libraryRelPath;
            }
          }
        } else if (!last) {
          viewer.detachPreview();
          setStage('empty');
        } else if (preview.adoptAttached(last)) {
          results.select(last.relPath, viewer.scribe.state.cp.n);
          if (!fullTextResults) listPreviewPage = viewer.scribe.state.cp.n;
        } else {
          preview.show(last);
        }
      }
    } else {
      viewer._exclusiveToolBtns?.find((b) => b.classList.contains('active'))?.click();
      viewer._searchBar?.closeSearch();
    }
    let endBarFade = () => {};
    if (fromTab && !reducedMotion()) {
      const libraryParts = /** @type {HTMLElement[]} */ ([barTitle, barControls].filter((el) => el));
      endBarFade = crossFadeBar(mainBarParts(), () => {
        applyForm();
        return libraryParts;
      }, false);
    } else applyForm();
    if (doRender) render({ revealSelection: true });
    if (fromTab) morphIn(endBarFade);
  };

  /** Unlight the library's tab, giving a tab's document the front. */
  const deactivate = () => {
    visible = false;
    closeCardMenu();
    returnFindBar();
    swapBarOut();
    viewer._searchBar?.rehome();
    viewer._tabStrip?.setPinnedActive(false);
    homeTab.classList.remove('active');
    surface.style.display = 'none';
    surface.classList.remove('split');
    viewer.setDocInset(null);
    viewer._syncFrontSurface();
  };

  /** Light the library in its split form ahead of a document attaching as the preview, leaving the attach to the caller. */
  const ensureLit = () => {
    if (!visible) activate({ render: false, attach: false });
    else applyForm();
  };

  /** Empty the pane and clear its selection. */
  const clearPreview = () => {
    preview.showEmpty();
    listPreviewPath = null;
    results.select(null, 0);
    syncSelectionUI();
    syncPaneHead();
  };

  pvOpenBtn.addEventListener('click', () => {
    if (pvOpenBtn.classList.contains('disabled')) return;
    const last = preview.lastTarget();
    if (!last || !manifest) return;
    const entry = manifest.docs[last.relPath];
    if (entry) openEntry(last.relPath, entry, { pageN: viewer.scribe.state.cp.n, query: last.query ?? undefined });
  });

  /**
   * This instance as the viewer and the other instances see it.
   * Filled in below, once the pieces it exposes exist.
   * @type {LibraryInstance}
   */
  const api = /** @type {LibraryInstance} */ ({});

  const syncBarForStore = () => {
    if (!barSwapped || !barTitle || !barControls) return;
    barTitle.style.display = store ? '' : 'none';
    barControls.style.display = store ? '' : 'none';
  };
  /** The toolbar's controls that the library's own replace while the library is lit. */
  const mainBarParts = () => {
    /** @type {HTMLElement[]} */
    const parts = [];
    for (const el of [...viewer.toolbarElemStart.children]) {
      if (el !== viewer._appMenu?.menuWrap && el !== barTitle) parts.push(/** @type {HTMLElement} */ (el));
    }
    if (viewer._toolbarButtonsElem) parts.push(viewer._toolbarButtonsElem);
    for (const el of [...viewer.toolbarElemEnd.children]) {
      if (el !== barControls && !el.classList.contains('scribe-shell-corner')) parts.push(/** @type {HTMLElement} */ (el));
    }
    return parts;
  };
  /** Replace the toolbar's document controls with the library's own fragments. */
  // Text buttons measure fractional widths, which would put every glyph to their left in the right-aligned zone on fractional pixels.
  const roundBarButtons = () => {
    for (const el of [sortBtn, newBtn, crumbsElem.querySelector('.scribe-library-crumb-root')]) {
      if (!el) continue;
      el.style.width = '';
      const wd = el.getBoundingClientRect().width;
      if (wd) el.style.width = `${Math.ceil(wd)}px`;
    }
  };
  const swapBarIn = () => {
    if (!barTitle || !barControls || barSwapped) return;
    barSwapped = true;
    for (const el of mainBarParts()) {
      hiddenBarElems.push({ el, display: el.style.display });
      el.style.display = 'none';
    }
    syncBarForStore();
    roundBarButtons();
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

  // --- Persistence helpers ------------------------------------------------

  const saveManifestSoon = () => {
    if (manifestTimer !== null) return;
    manifestTimer = window.setTimeout(() => {
      manifestTimer = null;
      if (store && manifest) store.writeManifest(manifest).catch(() => {});
    }, 1000);
  };

  const buildResumeRecord = () => {
    const activeT = viewer._tabs[viewer._activeTab];
    const libTabs = viewer._tabs.filter((t) => ownsTab(t) && (t.libraryHash || t.libraryRelPath));
    if (!libTabs.length) return null;
    return {
      v: 1,
      // The folder name pins the record to its library, so it cannot replay into a different one.
      dir: store?.root?.name ?? '',
      tabs: libTabs.map((t) => ({
        hash: t.libraryHash || '',
        relPath: t.libraryRelPath || '',
        page: t === activeT ? viewer.scribe.state.cp.n : (t.lastPage ?? 0),
      })),
      active: activeT ? libTabs.indexOf(activeT) : -1,
      view: activeT && libTabs.includes(activeT) ? {
        zoom: viewer.scribe.zoomLevel,
        sx: viewer.scribe.scrollContainer?.scrollLeft ?? 0,
        sy: viewer.scribe.scrollContainer?.scrollTop ?? 0,
      } : null,
      lib: visible ? 1 : 0,
    };
  };
  /**
   * Write the record a reload or relaunch restores from.
   * The `pagehide` call is the authoritative one, since web storage is synchronous and so completes as the page unloads.
   */
  const writeResumeRecord = () => {
    // Only the library's tabs come back after a reload, because a portfolio's members are gone with it.
    if (!isLibrary || restoringTabs || !viewer._resumeOwner) return;
    try {
      const record = buildResumeRecord();
      if (!record) {
        resumeStorage.removeItem(RESUME_STORAGE_KEY);
        return;
      }
      resumeStorage.setItem(RESUME_STORAGE_KEY, JSON.stringify(record));
    } catch { /* Storage unavailable. */ }
  };

  /** @type {?string} */
  let recognizingPath = null;
  let recognizeFrac = 0;
  /** Recognition tasks that ended in an error since the queue last drained. */
  let runRecognizeFailures = 0;
  /** @type {?{relPath: string, phase: 'reverted'|'restored'}} The card's transient post-revert line. */
  let revertFeedback = null;
  /** @type {?number} */
  let revertFeedbackTimer = null;
  /** @type {?{relPath: string, hash: string, editedAt?: number, recognizedAt?: number, phase: 'reverting'|'reverted'|'restoring'}} */
  let revertUndo = null;

  /**
   * Bring the manifest and the search index up to date after a sidecar checkpoint.
   * @param {string} hash
   * @param {import('../../js/containers/scribeDoc.js').ScribeDoc} doc
   * @param {boolean} recognized - Whether a recognition run completed since the previous checkpoint.
   */
  const afterSidecarSaved = async (hash, doc, recognized) => {
    if (!store || !manifest) return;
    const entry = Object.values(manifest.docs).find((e) => e.hash === hash);
    if (!entry) return;
    entry.editedAt = Date.now();
    if (recognized) {
      entry.recognizedAt = Date.now();
      delete entry.ocrError;
    }
    saveManifestSoon();
    try {
      await engine.addDoc(hash, doc.ocr.active);
    } catch { /* The sidecar is saved; a stale index entry is repaired by the next rebuild. */ }
  };

  /**
   * Checkpoint-save one library tab's sidecar when it has unsaved edits.
   * @param {?{doc: Object, libraryHash?: string, libraryDirty?: boolean, librarySaving?: boolean, libraryRecognized?: boolean}} tab
   */
  const saveTabIfDirty = async (tab) => {
    // A tab another instance opened (the library's, or another portfolio's) checkpoints through that instance.
    if (!ownsTab(tab)) return;
    // This checkpoint is the only per-tab exit hook, so clean tabs persist their visited rasters here too.
    if (tab?.libraryHash && store && manifest) {
      const entry = Object.values(manifest.docs).find((e) => e.hash === tab.libraryHash);
      if (entry) preview.persistRasterWindow(tab.doc, entry, /** @type {any} */ (tab).lastPage ?? 0);
    }
    if (!tab || !tab.libraryHash || !tab.libraryDirty || tab.librarySaving || !store) return;
    tab.librarySaving = true;
    tab.libraryDirty = false;
    try {
      // Sidecars are this application's session store, so they carry app-side state (pending text edits, native-text metadata) that a default export drops.
      // They opt into the segmented layout so a session of any size stays reloadable.
      const data = await /** @type {any} */ (tab.doc).exportData('scribe', { scribeSession: true, scribeSegments: true, includeCharBoxesScribe: false });
      await store.writeSidecar(tab.libraryHash, data);
      sessions.dropSidecar(tab.libraryHash);
      const recognized = !!tab.libraryRecognized;
      tab.libraryRecognized = false;
      await afterSidecarSaved(tab.libraryHash, tab.doc, recognized);
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
    const from = currentDir;
    const up = from !== '' && (dirPath === '' || from.startsWith(`${dirPath}/`));
    const came = up ? `${dirPath ? `${dirPath}/` : ''}${from.slice(dirPath ? dirPath.length + 1 : 0).split('/')[0]}/` : '';
    currentDir = dirPath;
    selectedPaths.clear();
    selAnchor = came || null;
    if (came) selectedPaths.add(came);
    fullTextResults = null;
    filterText = '';
    searchInput.value = '';
    searchField.classList.remove('has-text', 'hint-yield');
    crumbFadeDue = true;
    render();
    body.scrollTop = 0;
    const cameElem = came ? /** @type {?HTMLElement} */ (body.querySelector(`[data-rel-path="${CSS.escape(came)}"]`)) : null;
    if (cameElem) {
      cameElem.focus({ preventScroll: true });
      cameElem.scrollIntoView({ block: 'nearest' });
    }
  };

  /** @type {?ReturnType<typeof createDropdown>} */
  let midDropdown = null;
  /** @type {?HTMLButtonElement} */
  let rootMenuBtn = null;
  let crumbFadeDue = false;
  // `currentDir` already names the destination when the old trail is measured, so the trail keeps the directory it was built for.
  let crumbsDir = '';
  /** @returns {Array<{node: Node, key: string, left: number, top: number, width: number, height: number, textLeft: number, color: string, chev: ?DOMRect, chevOnly?: boolean}>} */
  const measureCrumbs = () => {
    const base = crumbsElem.getBoundingClientRect();
    const items = [];
    let seps = 0;
    for (const node of crumbsElem.childNodes) {
      let key = '';
      let rect;
      let color;
      let textLeft;
      /** @type {?DOMRect} */
      let chev = null;
      if (node instanceof Text) {
        const range = document.createRange();
        range.selectNodeContents(node);
        rect = range.getBoundingClientRect();
        color = getComputedStyle(crumbsElem).color;
        textLeft = rect.left;
        key = 'root';
      } else if (node instanceof HTMLElement && !node.classList.contains('scribe-library-crumb-ghost')) {
        const cs = getComputedStyle(node);
        rect = node.getBoundingClientRect();
        color = cs.color;
        textLeft = rect.left + parseFloat(cs.paddingLeft);
        if (node.classList.contains('sep')) key = `sep${++seps}`;
        else if (node.classList.contains('cur')) key = `dir:${crumbsDir}`;
        else if (node.classList.contains('scribe-library-sort')) key = 'dots';
        else if (node.classList.contains('scribe-library-crumb-root')) {
          key = 'root';
          const c = /** @type {SVGElement} */ (node.querySelector('svg')).getBoundingClientRect();
          chev = new DOMRect(c.left - base.left, c.top - base.top, c.width, c.height);
        } else key = node.dataset.dirTarget ? `dir:${node.dataset.dirTarget}` : 'root';
      } else continue;
      items.push({
        node, key, left: rect.left - base.left, top: rect.top - base.top, width: rect.width, height: rect.height, textLeft: textLeft - base.left, color, chev,
      });
    }
    return items;
  };
  /** Rebuild the header breadcrumbs for `currentDir`; ancestors are links and drag-drop targets. */
  const syncCrumbs = () => {
    for (const a of crumbsElem.getAnimations({ subtree: true })) a.finish();
    for (const ghost of crumbsElem.querySelectorAll('.scribe-library-crumb-ghost')) ghost.remove();
    const before = crumbFadeDue && visible && !window.matchMedia('(prefers-reduced-motion: reduce)').matches ? measureCrumbs() : null;
    crumbFadeDue = false;
    crumbsElem.replaceChildren();
    midDropdown?.destroy();
    midDropdown = null;
    const segs = currentDir ? currentDir.split('/') : [];
    const rootLabel = isLibrary && store ? store.root.name : opts.name;
    if (!segs.length && isLibrary) {
      // The folder menu releases a detached trigger only when it opens or closes, so a button built per render would accumulate there with its listeners.
      if (!rootMenuBtn) {
        rootMenuBtn = document.createElement('button');
        rootMenuBtn.type = 'button';
        rootMenuBtn.className = 'scribe-library-crumb-root';
        rootMenuBtn.setAttribute('aria-haspopup', 'menu');
        rootMenuBtn.innerHTML = `<span class="nm"></span>${CHEVRON_SVG}`;
        folderDropdown.attachTrigger(rootMenuBtn);
      }
      rootMenuBtn.title = rootLabel;
      /** @type {HTMLElement} */ (rootMenuBtn.querySelector('.nm')).textContent = rootLabel;
      crumbsElem.appendChild(rootMenuBtn);
      roundBarButtons();
    } else if (!segs.length) {
      crumbsElem.appendChild(document.createTextNode(rootLabel));
    } else {
      const rootBtn = document.createElement('button');
      rootBtn.className = 'scribe-library-crumb';
      rootBtn.textContent = rootLabel;
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
        const dropdown = createDropdown({
          show: () => {
            midMenu.style.display = '';
            return midMenu;
          },
          hide: () => {
            midMenu.style.display = 'none';
          },
          rows: '.scribe-library-menu-item',
        });
        midDropdown = dropdown;
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
            dropdown.close();
            openDir(path);
          });
          midMenu.appendChild(item);
        }
        dropdown.attachTrigger(midBtn);
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
    }
    crumbsDir = currentDir;
    if (!before) return;

    const after = measureCrumbs();
    const beforeBy = new Map(before.map((it) => [it.key, it]));
    const afterBy = new Map(after.map((it) => [it.key, it]));
    // A crumb stays only if its text keeps its place, so a name that moves fades out and back in.
    // Names move only when ancestors collapse into the hidden-folders crumb.
    /** @param {{textLeft: number}} a @param {{textLeft: number} | undefined} b */
    const stays = (a, b) => !!b && Math.abs(a.textLeft - b.textLeft) <= 1;
    const leaving = before.filter((it) => !stays(it, afterBy.get(it.key)));
    const coming = after.filter((it) => !stays(it, beforeBy.get(it.key)));
    for (const it of after) {
      const was = beforeBy.get(it.key);
      if (!stays(it, was) || !was) continue;
      if (was.color !== it.color && it.node instanceof Element) it.node.animate([{ color: was.color }, { color: it.color }], { duration: 160, easing: 'cubic-bezier(.4, 0, .2, 1)' });
      if (was.chev && !it.chev) leaving.push({ ...was, chevOnly: true });
      if (it.chev && !was.chev) coming.push({ ...it, node: /** @type {Element} */ (/** @type {Element} */ (it.node).querySelector('svg')), left: it.chev.x, width: it.chev.width });
    }
    // Where a leaving crumb and an arriving one share space, the arrival waits for the departure, so two names never show through each other.
    /** @param {{left: number, width: number, chev: ?DOMRect, chevOnly?: boolean}} it */
    const span = (it) => (it.chevOnly && it.chev ? [it.chev.x, it.chev.x + it.chev.width] : [it.left, it.left + it.width]);
    const through = leaving.some((l) => coming.some((c) => span(l)[0] < span(c)[1] - 1 && span(c)[0] < span(l)[1] - 1));
    for (const it of leaving) {
      /** @type {HTMLElement} */
      let ghost;
      if (it.node instanceof HTMLElement) {
        ghost = /** @type {HTMLElement} */ (it.node.cloneNode(true));
        if (it.chevOnly) /** @type {HTMLElement} */ (ghost.querySelector('.nm')).style.visibility = 'hidden';
      } else {
        ghost = document.createElement('span');
        ghost.textContent = it.node.textContent;
      }
      ghost.classList.add('scribe-library-crumb-ghost');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.setAttribute('inert', '');
      ghost.style.left = `${it.left}px`;
      ghost.style.top = `${it.top}px`;
      ghost.style.width = `${it.width}px`;
      ghost.style.height = `${it.height}px`;
      ghost.style.color = it.color;
      crumbsElem.appendChild(ghost);
      const fade = ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: through ? 90 : 120, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' });
      fade.finished.then(() => ghost.remove(), () => ghost.remove());
    }
    for (const it of coming) {
      if (it.node instanceof Element) it.node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, delay: through ? 80 : 40, easing: 'cubic-bezier(0, 0, .2, 1)', fill: 'backwards' });
    }
  };

  /**
   * View identity of the last render.
   * A matching pass updates the existing cards and rows in place instead of rebuilding.
   */
  let lastRenderKey = '';
  /**
   * Band and empty-note structure of the last render.
   * A mismatch forces the rebuild path even when the view identity matches.
   */
  let lastRenderSig = '';
  /** @type {?() => void} */
  let listColsRefit = null;

  /**
   * Bring the library surface up to date for the current mode and state.
   * A pass over an unchanged view identity refreshes the existing keyed cards and rows in place.
   * Anything else tears the surface down and rebuilds it.
   * @param {{revealSelection?: boolean}} [renderOpts] - `revealSelection` scrolls the previewed (or first selected) item into view, for returns from a doc tab.
   */
  const render = (renderOpts) => {
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
    const revealSelection = !!(renderOpts && renderOpts.revealSelection);
    const reveal = () => {
      if (!revealSelection) return;
      const previewed = listPreviewOn && viewMode !== 'grid' ? listPreviewPath : null;
      const sel = previewed ? `[data-rel-path="${CSS.escape(previewed)}"]` : '[data-rel-path].selected';
      // Recent and the just-added shelf repeat documents listed below them, so the document's own card or row is the one brought into view.
      const item = /** @type {?HTMLElement} */ (body.querySelector(`[data-band="main-grid"] > ${sel}, [data-band="rows"] > ${sel}`) || body.querySelector(sel));
      if (!item) return;
      item.focus({ preventScroll: true });
      const scroller = /** @type {HTMLElement} */ (item.closest('.scribe-library-rlist') || body);
      const headH = scroller.querySelector('.scribe-library-lhead')?.getBoundingClientRect().height ?? 0;
      const s = scroller.getBoundingClientRect();
      const r = item.getBoundingClientRect();
      if (r.top >= s.top + headH && r.bottom <= s.bottom) return;
      // scrollIntoView would also scroll the viewer root, which clips its overflow, and carry the toolbar and tab strip out of view with it.
      scroller.scrollTop += (r.top + r.bottom - s.top - headH - s.bottom) / 2;
    };

    const dirSet = new Set(manifest?.dirs ?? []);
    if (manifest && currentDir && !dirSet.has(currentDir)) {
      // The browsed folder can vanish when a rescan follows a delete made outside the app.
      currentDir = '';
    }
    syncCrumbs();
    if (manifest) {
      for (const p of selectedPaths) {
        if (!manifest.docs[p] && !(p.endsWith('/') && dirSet.has(p.slice(0, -1))) && !(manifest.others ?? []).includes(p)) selectedPaths.delete(p);
      }
    }
    const entries = manifest ? Object.entries(manifest.docs) : [];
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
      } else d = titleOf(pa).localeCompare(titleOf(pb), undefined, { numeric: true });
      if (d) return d * sortDir;
      return titleOf(pa).localeCompare(titleOf(pb), undefined, { numeric: true });
    });
    const shownDirs = filter ? [] : [...dirSet].filter((dir) => {
      const cut = dir.lastIndexOf('/');
      return (cut < 0 ? '' : dir.slice(0, cut)) === currentDir;
    }).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }) * (sortMode === 'name' ? sortDir : 1));
    const shownOthers = !showOthers || !manifest ? [] : (manifest.others ?? []).filter((p) => {
      if (filter) return p.toLowerCase().includes(filter);
      const cut = p.lastIndexOf('/');
      return (cut < 0 ? '' : p.slice(0, cut)) === currentDir;
    }).sort((a, b) => (a.split('/').pop() || a).localeCompare(b.split('/').pop() || b, undefined, { numeric: true }));
    const recent = viewMode === 'grid' && currentDir === '' && !filter && sortMode !== 'opened'
      ? entries.filter(([, e]) => e.lastOpened > 0).sort(([, a], [, b]) => b.lastOpened - a.lastOpened).slice(0, 5)
      : [];
    justAdded = manifest ? justAdded.filter((a) => manifest.docs[a.relPath]) : [];
    const emptyLib = !!manifest && !entries.length && !dirSet.size && !shownOthers.length;
    let emptyNote = '';
    if (!shown.length && !shownOthers.length && filter) emptyNote = 'filter';
    else if (currentDir && !shownDirs.length && !shown.length && !shownOthers.length) emptyNote = 'dir';

    let renderKey;
    if (!store || !manifest) renderKey = 'wall';
    else if (storageOpen) renderKey = 'storage';
    else if (fullTextResults) renderKey = 'results';
    else renderKey = `browse|${currentDir}|${viewMode}|${listPreviewOn ? 1 : 0}|${sortMode}|${sortDir}|${filter}`;
    const renderSig = emptyLib ? 'empty-lib'
      : `r${recent.length ? 1 : 0}d${shownDirs.length || vacatedHere() ? 1 : 0}m${shown.length ? 1 : 0}o${shownOthers.length ? 1 : 0}e${emptyNote}j${justAdded.map((a) => a.relPath).join('\u0000')}`;

    // Reconciling rather than rebuilding is what lets an open card menu, focus, scroll, and the mounted preview pane survive the renders indexing fires every few hundred ms.
    if (store && manifest && !fullTextResults && !storageOpen && !emptyLib
      && renderKey === lastRenderKey && renderSig === lastRenderSig) {
      if (viewMode === 'grid') {
        /** @param {string} name */
        const band = (name) => /** @type {?HTMLElement} */ (body.querySelector(`[data-band="${name}"]`));
        const recentGrid = band('recent-grid');
        if (recentGrid) {
          syncKeyedChildren(recentGrid, recent, ([p]) => p, ([p, e]) => buildCard(p, e, false), (node, [p, e]) => updateCard(node, p, e));
        }
        const dirGrid = band('folders-grid');
        if (dirGrid) {
          const dirLabel = band('folders-label');
          if (dirLabel) dirLabel.textContent = foldersLabel(shownDirs);
          syncKeyedChildren(dirGrid, withVacated(shownDirs), (d) => (d === VACATED ? VACATED : `${d}/`), (d) => (d === VACATED ? buildVacatedCard() : buildFolderCard(d)), (node, d) => {
            if (d !== VACATED) updateFolderCard(node, d);
          });
        }
        const docLabel = band('docs-label');
        if (docLabel) docLabel.textContent = `Documents · ${shown.length}`;
        const mainGrid = band('main-grid');
        if (mainGrid) {
          syncKeyedChildren(mainGrid, shown, ([p]) => p, ([p, e]) => buildCard(p, e, !filter), (node, [p, e]) => updateCard(node, p, e));
          drag.setMainGrid(mainGrid, shown.map(([p]) => p));
        }
        const otherGrid = band('others-grid');
        if (otherGrid) syncKeyedChildren(otherGrid, shownOthers, (p) => p, (p) => buildOtherCard(p), null);
      } else {
        const rowsElem = /** @type {?HTMLElement} */ (body.querySelector('[data-band="rows"]'));
        if (rowsElem) {
          syncKeyedChildren(rowsElem, listItems(shownDirs, shown, shownOthers), ([kind, v]) => {
            if (kind === 'head') return v[0];
            if (kind === 'vacated') return VACATED;
            if (kind === 'dir') return `${v}/`;
            return kind === 'doc' ? v[0] : v;
          }, buildListItem, (node, [kind, v]) => {
            if (kind === 'head') node.textContent = v[1];
            else if (kind === 'dir') updateFolderRow(node, v);
            else if (kind === 'doc') updateRow(node, v[0], v[1]);
          });
          listColsRefit?.();
        }
      }
      // Only a vanished anchor closes its menu, so a menu over a surviving card stays open through the refresh.
      if (menuTargetElem && !menuTargetElem.isConnected) closeCardMenu();
      reveal();
      return;
    }

    lastRenderKey = renderKey;
    lastRenderSig = renderSig;
    listColsRefit = null;
    // The teardown below destroys any card the open menu is anchored to.
    closeCardMenu();
    // The retained results view snapshots its scroll state before the detach below, so a reattach can restore it.
    results.snapshot();
    body.textContent = '';
    splitLeft = null;
    body.classList.remove('results-mode', 'list-mode', 'split-mode');
    if (!fullTextResults) results.dispose();
    // Leaving the split form lets go of the document it previewed.
    if (!splitForm() && preview.lastTarget()) preview.showEmpty();
    applyForm();
    syncPaneHead();
    if (!store || !manifest) {
      // Only the library can be store-less, waiting at its start screen.
      // Every other instance has its store from birth and waits only for its scan.
      if (!isLibrary) return;
      const sheet = document.createElement('div');
      sheet.className = 'scribe-library-sheet';
      const acts = document.createElement('div');
      acts.className = 'scribe-library-sheet-acts';
      const openAct = document.createElement('button');
      openAct.type = 'button';
      openAct.className = 'scribe-library-sheet-act';
      openAct.innerHTML = `<div class="t"><span class="ic">${FILE_16_SVG}</span><span>Open…</span><span class="kbd"></span></div>`
        + '<div class="d">A PDF or a scanned document. Text in scans is recognized, so you can search and copy it.</div>';
      /** @type {HTMLElement} */ (openAct.querySelector('.kbd')).textContent = shortcutLabel('O');
      openAct.addEventListener('click', () => viewer.runMenuCommand('open'));
      const folderAct = document.createElement('button');
      folderAct.type = 'button';
      folderAct.className = 'scribe-library-sheet-act';
      folderAct.innerHTML = `<div class="t"><span class="ic">${FOLDER_SVG}</span><span>Open Folder…</span></div>`
        + '<div class="d">Browse and search every PDF in a folder on this computer. Nothing is copied or moved.</div>';
      folderAct.addEventListener('click', () => openFolder());
      acts.append(openAct, folderAct);
      sheet.appendChild(acts);
      const recentAll = viewer._recents.list();
      const recentRows = [...recentAll.filter((e) => e.kind === 'folder').slice(0, 3), ...recentAll.filter((e) => e.kind === 'file').slice(0, 5)];
      if (recentRows.length) {
        const list = document.createElement('div');
        list.className = 'scribe-library-recent';
        list.innerHTML = '<div class="h">Recent</div>';
        recentRows.forEach((entry, i) => {
          const elsewhere = entry.kind === 'folder' && viewer._foldersOpenElsewhere.includes(entry.label);
          const row = document.createElement('div');
          row.className = 'r';
          row.role = 'button';
          row.tabIndex = 0;
          row.innerHTML = `<span class="fi">${entry.kind === 'file' ? FILE_16_SVG : elsewhere ? FOLDER_ELSEWHERE_SVG : FOLDER_SVG}</span><span class="n"></span><span class="p"></span>`
            + '<button type="button" class="x" title="Remove from Recent" aria-label="Remove from Recent">×</button>';
          /** @type {HTMLElement} */ (row.querySelector('.n')).textContent = entry.label;
          /** @type {HTMLElement} */ (row.querySelector('.p')).textContent = entry.dir;
          row.title = entry.dir ? `${entry.dir}/${entry.label}` : entry.label;
          const open = () => (elsewhere ? shell?.focusFolderWindow?.(entry.label) : entry.open());
          /** @param {boolean} fromKeyboard */
          const remove = async (fromKeyboard) => {
            if (row.classList.contains('leaving')) return;
            // Asked before the row starts to leave, so a cancel leaves it in place.
            if (entry.confirm && !(await entry.confirm())) return;
            if (!row.isConnected || row.classList.contains('leaving')) return;
            recentExit = exitRecentRow(row).then(() => { recentExit = null; });
            if (fromKeyboard) {
              recentFocusIndex = i;
              const left = /** @type {HTMLElement[]} */ ([...list.querySelectorAll('.r:not(.leaving)')]);
              (left[i] ?? left[left.length - 1])?.focus({ preventScroll: true });
            }
            entry.remove();
          };
          row.addEventListener('click', open);
          row.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              open();
            } else if (e.key === 'Delete' || e.key === 'Backspace') {
              e.preventDefault();
              remove(true);
            }
          });
          row.querySelector('.x').addEventListener('click', (e) => {
            e.stopPropagation();
            remove(false);
          });
          list.appendChild(row);
        });
        sheet.appendChild(list);
      }
      const hint = document.createElement('div');
      hint.className = 'scribe-library-sheet-hint';
      hint.textContent = 'or drop a file here';
      sheet.appendChild(hint);
      body.appendChild(sheet);
      pruneRecents();
      if (recentFocusIndex >= 0) {
        // A removal from the keyboard keeps the focus in the list, on the row that took the removed one's place.
        const rows = sheet.querySelectorAll('.scribe-library-recent .r');
        const next = /** @type {?HTMLElement} */ (rows[Math.min(recentFocusIndex, rows.length - 1)] ?? null);
        recentFocusIndex = -1;
        if (next) next.focus({ preventScroll: true });
      }
      if (!document.activeElement || document.activeElement === document.body) {
        openAct.focus(/** @type {FocusOptions} */ ({ preventScroll: true, focusVisible: false }));
      }
      return;
    }

    if (storageOpen) {
      body.appendChild(buildStorageSheet());
      return;
    }

    if (fullTextResults) {
      body.classList.add('results-mode');
      if (splitForm()) mountSplit('results');
      results.render();
      return;
    }

    if (emptyLib) {
      const empty = document.createElement('div');
      empty.className = 'scribe-library-empty';
      empty.textContent = opts.emptyText ?? 'No PDFs in this folder yet. Drop files here or use “New › Add PDFs”.';
      body.appendChild(empty);
      return;
    }

    if (justAdded.length) {
      const shelfLabel = document.createElement('div');
      shelfLabel.className = 'scribe-library-shelf-label';
      const shelfHead = document.createElement('span');
      shelfHead.className = 'h';
      shelfHead.textContent = `Just added · ${justAdded.length}`;
      const shelfNote = document.createElement('span');
      shelfNote.className = 'note';
      const froms = [...new Set(justAdded.map((a) => a.from).filter(Boolean))];
      shelfNote.textContent = `Copied into this folder${froms.length === 1 ? ` from ${froms[0]}` : ''}. ${justAdded.length === 1 ? 'The original stays where it was.' : 'The originals stay where they were.'}`;
      const shelfDone = document.createElement('button');
      shelfDone.type = 'button';
      shelfDone.className = 'done';
      shelfDone.textContent = 'Done';
      shelfDone.addEventListener('click', () => {
        justAdded = [];
        render();
      });
      shelfLabel.append(shelfHead, shelfNote, shelfDone);
      body.appendChild(shelfLabel);
      const shelfGrid = document.createElement('div');
      shelfGrid.className = 'scribe-library-grid shelf';
      for (const { relPath } of justAdded) {
        const card = buildCard(relPath, manifest.docs[relPath], false);
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'shelf-act';
        removeBtn.textContent = 'Remove from folder';
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          removeJustAdded(relPath);
        });
        card.querySelector('.body')?.appendChild(removeBtn);
        shelfGrid.appendChild(card);
      }
      body.appendChild(shelfGrid);
    }

    if (viewMode === 'list' || viewMode === 'compact') {
      drag.setMainGrid(null, []);
      const host = renderList(shownDirs, shown, shownOthers);
      if (emptyNote) {
        const empty = document.createElement('div');
        empty.className = 'scribe-library-empty';
        empty.textContent = emptyNote === 'filter' ? 'No names match. Press Enter to search inside the documents.' : 'This folder is empty.';
        host.appendChild(empty);
      }
      reveal();
      return;
    }

    if (recent.length) {
      const label = document.createElement('div');
      label.className = 'scribe-library-section-label';
      label.dataset.band = 'recent-label';
      label.textContent = 'Recent';
      body.appendChild(label);
      const grid = document.createElement('div');
      grid.className = 'scribe-library-grid';
      grid.dataset.band = 'recent-grid';
      for (const [relPath, entry] of recent) grid.appendChild(buildCard(relPath, entry, false));
      body.appendChild(grid);
      // With folders present, the branch below labels the document grid itself.
      if (!shownDirs.length) {
        const allLabel = document.createElement('div');
        allLabel.className = 'scribe-library-section-label';
        allLabel.dataset.band = 'all-label';
        allLabel.textContent = 'All documents';
        body.appendChild(allLabel);
      }
    }

    if (shownDirs.length || vacatedHere()) {
      const dirLabel = document.createElement('div');
      dirLabel.className = 'scribe-library-section-label';
      dirLabel.dataset.band = 'folders-label';
      dirLabel.textContent = foldersLabel(shownDirs);
      body.appendChild(dirLabel);
      const dirGrid = document.createElement('div');
      dirGrid.className = 'scribe-library-grid folders';
      dirGrid.dataset.band = 'folders-grid';
      for (const d of withVacated(shownDirs)) dirGrid.appendChild(d === VACATED ? buildVacatedCard() : buildFolderCard(d));
      body.appendChild(dirGrid);
      if (shown.length) {
        const docLabel = document.createElement('div');
        docLabel.className = 'scribe-library-section-label';
        docLabel.dataset.band = 'docs-label';
        docLabel.textContent = `Documents · ${shown.length}`;
        body.appendChild(docLabel);
      }
    }
    const grid = document.createElement('div');
    grid.className = 'scribe-library-grid main';
    grid.dataset.band = 'main-grid';
    for (const [relPath, entry] of shown) grid.appendChild(buildCard(relPath, entry, !filter));
    body.appendChild(grid);
    drag.setMainGrid(grid, shown.map(([p]) => p));
    if (emptyNote) {
      const empty = document.createElement('div');
      empty.className = 'scribe-library-empty';
      empty.textContent = emptyNote === 'filter' ? 'No names match. Press Enter to search inside the documents.' : 'This folder is empty.';
      body.appendChild(empty);
    }
    if (shownOthers.length) {
      // The main grid's drag-reorder math indexes its children against gridPaths, so these cards need a grid of their own.
      const otherLabel = document.createElement('div');
      otherLabel.className = 'scribe-library-section-label';
      otherLabel.dataset.band = 'others-label';
      otherLabel.textContent = 'Other files';
      body.appendChild(otherLabel);
      const otherGrid = document.createElement('div');
      otherGrid.className = 'scribe-library-grid';
      otherGrid.dataset.band = 'others-grid';
      for (const relPath of shownOthers) otherGrid.appendChild(buildOtherCard(relPath));
      body.appendChild(otherGrid);
    }
    reveal();
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

  // The thresholds match the Pages room's band, so the two grids sweep the same way.
  const MARQUEE_THRESHOLD = 4;
  const MARQUEE_EDGE = 36;
  const MARQUEE_SPEED = 14;
  const marqueeElem = document.createElement('div');
  marqueeElem.className = 'scribe-library-marquee';
  /** @type {?{originX: number, originY: number, base: Set<string>, started: boolean, lastX: number, lastY: number, autoDir: number, rafId: number}} */
  let marquee = null;

  /**
   * Grow the band to (curX, curY) and select every card it touches.
   * curX/curY are in the body's content space, so the band and its selection track the cards as the body auto-scrolls under a held pointer.
   * @param {number} curX
   * @param {number} curY
   */
  const updateMarquee = (curX, curY) => {
    if (!marquee) return;
    const l = Math.min(marquee.originX, curX);
    const r = Math.max(marquee.originX, curX);
    const t = Math.min(marquee.originY, curY);
    const b = Math.max(marquee.originY, curY);
    marqueeElem.style.left = `${l}px`;
    marqueeElem.style.top = `${t}px`;
    marqueeElem.style.width = `${r - l}px`;
    marqueeElem.style.height = `${b - t}px`;
    selectedPaths.clear();
    for (const p of marquee.base) selectedPaths.add(p);
    const bodyRect = body.getBoundingClientRect();
    for (const card of body.querySelectorAll('.scribe-library-card[data-rel-path]')) {
      const cr = card.getBoundingClientRect();
      const left = cr.left - bodyRect.left;
      const top = cr.top - bodyRect.top + body.scrollTop;
      if (left < r && left + cr.width > l && top < b && top + cr.height > t) selectedPaths.add(/** @type {HTMLElement} */ (card).dataset.relPath ?? '');
    }
    syncSelectionUI();
  };

  const marqueeAutoScroll = () => {
    if (!marquee || !marquee.started || marquee.autoDir === 0) { if (marquee) marquee.rafId = 0; return; }
    const max = body.scrollHeight - body.clientHeight;
    const next = Math.max(0, Math.min(max, body.scrollTop + marquee.autoDir * MARQUEE_SPEED));
    if (next !== body.scrollTop) {
      body.scrollTop = next;
      const rect = body.getBoundingClientRect();
      updateMarquee(Math.max(0, Math.min(body.clientWidth, marquee.lastX - rect.left)), marquee.lastY - rect.top + body.scrollTop);
      if (next === 0 || next === max) marquee.autoDir = 0;
    }
    marquee.rafId = marquee.autoDir !== 0 ? requestAnimationFrame(marqueeAutoScroll) : 0;
  };

  /** @param {PointerEvent} e */
  const onMarqueeMove = (e) => {
    if (!marquee) return;
    marquee.lastX = e.clientX;
    marquee.lastY = e.clientY;
    const rect = body.getBoundingClientRect();
    const curX = Math.max(0, Math.min(body.clientWidth, e.clientX - rect.left));
    const curY = e.clientY - rect.top + body.scrollTop;
    if (!marquee.started) {
      if (Math.abs(curX - marquee.originX) + Math.abs(curY - marquee.originY) < MARQUEE_THRESHOLD) return;
      marquee.started = true;
    }
    e.preventDefault();
    // A render mid-band rebuilds the body, so the band is put back whenever it has been swept away.
    if (!marqueeElem.isConnected) body.appendChild(marqueeElem);
    updateMarquee(curX, curY);
    const nearTop = e.clientY < rect.top + MARQUEE_EDGE && body.scrollTop > 0;
    const nearBottom = e.clientY > rect.bottom - MARQUEE_EDGE && body.scrollTop < body.scrollHeight - body.clientHeight;
    marquee.autoDir = nearTop ? -1 : (nearBottom ? 1 : 0);
    if (marquee.autoDir !== 0 && !marquee.rafId) marquee.rafId = requestAnimationFrame(marqueeAutoScroll);
  };

  const onMarqueeUp = () => {
    window.removeEventListener('pointermove', onMarqueeMove);
    window.removeEventListener('pointerup', onMarqueeUp);
    window.removeEventListener('pointercancel', onMarqueeUp);
    const m = marquee;
    marquee = null;
    if (!m) return;
    if (m.rafId) cancelAnimationFrame(m.rafId);
    if (!m.started) return;
    marqueeElem.remove();
    drag.suppressClick();
    selAnchor = [...body.querySelectorAll('.scribe-library-card[data-rel-path]')].map((card) => /** @type {HTMLElement} */ (card).dataset.relPath ?? '').find((p) => selectedPaths.has(p)) ?? null;
  };

  body.addEventListener('pointerdown', (e) => {
    // On touch, a drag in the empty space scrolls the grid.
    if (e.pointerType === 'touch') return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (viewMode !== 'grid' || fullTextResults || storageOpen || drag.active()) return;
    if (e.target instanceof Element && e.target.closest(`${SELECTION_KEEP_SELECTOR}, .scribe-library-recent`)) return;
    const rect = body.getBoundingClientRect();
    // clientWidth excludes the scrollbar, so a press at or beyond it is on the scrollbar.
    if (e.clientX - rect.left >= body.clientWidth) return;
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    marquee = {
      originX: Math.max(0, Math.min(body.clientWidth, e.clientX - rect.left)),
      originY: e.clientY - rect.top + body.scrollTop,
      base: additive ? new Set(selectedPaths) : new Set(),
      started: false,
      lastX: e.clientX,
      lastY: e.clientY,
      autoDir: 0,
      rafId: 0,
    };
    window.addEventListener('pointermove', onMarqueeMove);
    window.addEventListener('pointerup', onMarqueeUp);
    window.addEventListener('pointercancel', onMarqueeUp);
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
      // Re-assigning the same src reloads from an object URL that may since have been revoked, blanking the cover.
      if (img.src !== cachedUrl) img.src = cachedUrl;
      return;
    }
    sessions.cover(entry.hash).then((url) => {
      if (!destroyed && url && img.src !== url) img.src = url;
    }).catch(() => {});
  };

  /**
   * Sync `host`'s children to `items` in display order, reusing any child whose `data-key` matches instead of recreating it.
   * Reuse keeps a node's identity, so `update` must refresh everything content-derived.
   * @template T
   * @param {HTMLElement} host
   * @param {T[]} items
   * @param {(item: T) => string} keyOf
   * @param {(item: T) => HTMLElement} build
   * @param {?((node: HTMLElement, item: T) => void)} update
   */
  const syncKeyedChildren = (host, items, keyOf, build, update) => {
    const byKey = new Map();
    const stale = [];
    for (const el of host.children) {
      const key = /** @type {HTMLElement} */ (el).dataset.key;
      if (key === undefined) stale.push(el);
      else byKey.set(key, el);
    }
    let cursor = host.firstElementChild;
    for (const item of items) {
      const key = keyOf(item);
      let node = /** @type {?HTMLElement} */ (byKey.get(key));
      if (node) {
        byKey.delete(key);
        update?.(node, item);
      } else {
        node = build(item);
      }
      if (node === cursor) cursor = node.nextElementSibling;
      else host.insertBefore(node, cursor);
    }
    for (const el of stale) el.remove();
    for (const el of byKey.values()) el.remove();
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
   * Save each listed file as it is stored (a document's source PDF, or a non-PDF file as it is), one download apiece.
   * @param {string[]} relPaths
   */
  const saveCopies = async (relPaths) => {
    if (!store) return;
    for (const p of relPaths) {
      try {
        await saveAs(await store.readFile(p), titleOf(p));
      } catch (err) {
        viewer._showToast(`Couldn't save “${titleOf(p)}” — ${err instanceof Error ? err.message : 'the file could not be read'}.`);
      }
    }
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
        if (item.classList.contains('disabled')) return;
        closeCardMenu();
        fn();
      });
      menuElem.appendChild(item);
      return item;
    };
    /**
     * Add the Index item for the stale documents among `docPaths`: queued, changed on disk, or failed.
     * A healthy document offers nothing here, because rebuilding derived data is a library-level action in the app menu.
     * @param {string[]} docPaths
     */
    const addIndexItem = (docPaths) => {
      const stale = docPaths.filter((p) => ['pending', 'changed', 'error'].includes(manifest?.docs[p]?.status ?? ''));
      if (!stale.length) return;
      addItem('Index', false, async () => {
        if (!ingest) return;
        for (const p of stale) {
          const hash = manifest?.docs[p]?.hash;
          if (hash) sessions.invalidate(hash);
          await ingest.enqueue(p);
        }
        render();
        ingest.start();
      });
    };
    /**
     * Add the Recognize text item for the documents among `docPaths` that recognition can help.
     * Eligibility keys on the deep page selection, so a document is offered only when at least one of its pages would reach the engine.
     * @param {string[]} docPaths
     */
    const addRecognizeItem = (docPaths) => {
      const eligible = docPaths.filter((p) => {
        const e = manifest?.docs[p];
        return !!e && e.status === 'indexed' && !!e.hash && !e.ocrQueued
          && (e.ocrDeep ?? 0) > 0
          && (!e.recognizedAt || (e.editedAt ?? 0) > e.recognizedAt);
      });
      if (!eligible.length) return;
      const label = docPaths.length === 1 ? 'Recognize text'
        : eligible.length === docPaths.length ? `Recognize text (${eligible.length} document${eligible.length === 1 ? '' : 's'})`
          : `Recognize text (${eligible.length} of ${docPaths.length})`;
      addItem(label, false, async () => {
        if (!ingest || !store || !manifest) return;
        for (const p of eligible) await ingest.enqueueRecognize(p, { writeManifest: false });
        await store.writeManifest(manifest);
        render();
        ingest.start();
      });
    };
    if (relPath.endsWith('/')) {
      addItem('Open', false, () => openDir(relPath.slice(0, -1)));
      if (!readOnly) addItem('Rename', false, () => startFolderRename(relPath.slice(0, -1), card));
      if (!readOnly) addItem('Move to…', false, () => openMovePicker(moveSetFor(relPath), card));
      const docsUnder = Object.keys(manifest.docs).filter((p) => p.startsWith(relPath));
      addIndexItem(docsUnder);
      addRecognizeItem(docsUnder);
    } else {
      const multi = selectedPaths.has(relPath) && selectedPaths.size >= 2;
      // Folder keys in a mixed selection drop out here, because these actions are document and file verbs.
      const chosen = multi ? [...selectedPaths] : [relPath];
      const paths = chosen.filter((p) => manifest && manifest.docs[p]);
      const otherPaths = chosen.filter((p) => (manifest?.others ?? []).includes(p));
      const all = [...paths, ...otherPaths];
      if (all.length >= 2) {
        const menuHeader = document.createElement('div');
        menuHeader.className = 'scribe-thumb-menu-header';
        menuHeader.textContent = otherPaths.length ? `${all.length} files` : `${paths.length} documents`;
        menuElem.appendChild(menuHeader);
      }
      const openItem = addItem('Open', false, async () => {
        for (const p of paths) {
          const entry = manifest && manifest.docs[p];
          if (entry) await openEntry(p, entry);
        }
      });
      // Files Scribe cannot open keep the verb in place, greyed, so the menu reads the same on every row.
      if (!paths.length) openItem.classList.add('disabled');
      addItem(all.length === 1 ? 'Save a copy…' : 'Save copies…', false, () => saveCopies(all));
      addItem(all.length === 1 ? 'Copy name' : 'Copy names', false, () => navigator.clipboard?.writeText(all.map(titleOf).join('\n')).catch(() => {}));
      if (!readOnly && paths.length) addItem('Move to…', false, () => openMovePicker(moveSetFor(relPath), card));
      addIndexItem(paths);
      addRecognizeItem(paths);
      const single = paths.length === 1 && !otherPaths.length ? manifest.docs[paths[0]] : null;
      const revertPath = single && single.status === 'indexed' && single.hash && single.editedAt ? paths[0] : null;
      // Removal is the library's own verb, because a portfolio's files are what the portfolio holds.
      const canRemove = isLibrary && paths.length > 0 && !otherPaths.length;
      if (revertPath || canRemove) menuElem.appendChild(document.createElement('hr')).className = 'scribe-thumb-menu-divider';
      if (revertPath) addItem('Revert to original…', true, () => openRevertDialog(revertPath));
      if (canRemove) {
        addItem('Delete notes and edits…', true, async () => {
          if (!store || !manifest) return;
          const msg = paths.length === 1
            ? `Delete the notes and edits saved for “${titleOf(paths[0])}”?\n\nThe document file itself is not touched.`
            : `Delete the notes and edits saved for ${paths.length} documents?\n\nThe document files themselves are not touched.`;
          if (!window.confirm(msg)) return;
          await forgetDocs(paths);
          render();
        });
      }
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
   * The one status badge a document shows, in cards and rows alike.
   * Index state comes first, then recognition state, then the only text fact the library can state before recognizing.
   * An `image` verdict means nothing in the document is selectable or searchable yet.
   * @param {string} relPath
   * @param {import('./libraryStore.js').LibraryDocEntry} entry
   * @returns {?{html: string, title?: string}}
   */
  const badgeFor = (relPath, entry) => {
    if (entry.status === 'missing') return { html: '<span class="scribe-library-badge error">Missing</span>' };
    if (entry.status === 'changed') return { html: '<span class="scribe-library-badge warn">Changed</span>' };
    if (entry.status === 'error') return { html: '<span class="scribe-library-badge error">Failed</span>', title: entry.error };
    if (entry.status === 'pending') return { html: '<span class="scribe-library-badge">Queued</span>' };
    if (recognizingPath === relPath) return { html: '<span class="scribe-library-badge">Recognizing…</span>' };
    if (entry.ocrQueued) return { html: '<span class="scribe-library-badge">Queued</span>' };
    if (entry.pdfType === 'image' && !entry.recognizedAt) return { html: '<span class="scribe-library-badge">No text</span>' };
    return null;
  };

  /**
   * Fill a card's meta line (or a row's status slot) with the transient post-revert line.
   * @param {HTMLElement} host
   */
  const fillRevertFeedback = (host) => {
    if (!revertFeedback) return;
    if (revertFeedback.phase === 'restored') {
      host.appendChild(document.createTextNode('Edits restored.'));
      return;
    }
    host.appendChild(document.createTextNode('Reverted'));
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'undo';
    undo.textContent = 'Undo';
    undo.addEventListener('pointerdown', (e) => e.stopPropagation());
    undo.addEventListener('click', (e) => {
      e.stopPropagation();
      undoRevert();
    });
    host.appendChild(undo);
  };

  /**
   * Refresh everything a doc card shows from `entry`, leaving the shell and its listeners in place.
   * @param {HTMLElement} card
   * @param {string} relPath
   * @param {import('./libraryStore.js').LibraryDocEntry} entry
   */
  const updateCard = (card, relPath, entry) => {
    card.classList.toggle('selected', selectedPaths.has(relPath));
    // A portfolio's cover sheet is never shown, so its card carries the portfolio glyph where the thumbnail would be.
    if (!!entry.portfolio !== card.classList.contains('portfolio')) {
      card.classList.toggle('portfolio', !!entry.portfolio);
      card.querySelector(':scope > .fthumb')?.remove();
      if (entry.portfolio) {
        const icon = document.createElement('div');
        icon.className = 'fthumb';
        icon.innerHTML = `<span class="fi">${PORTFOLIO_SVG}</span>`;
        card.insertBefore(icon, card.firstChild);
      }
    }
    if (!entry.portfolio) setThumbSrc(/** @type {HTMLImageElement} */ (card.querySelector(':scope > img.thumb')), entry);
    const meta = /** @type {HTMLElement} */ (card.querySelector(':scope > .body > .meta'));
    meta.textContent = '';
    meta.removeAttribute('title');
    card.querySelector(':scope > .ocrhair')?.remove();
    if (recognizingPath === relPath) {
      const hair = document.createElement('div');
      hair.className = 'ocrhair';
      hair.style.width = `${Math.round(recognizeFrac * 100)}%`;
      card.appendChild(hair);
    }
    card.querySelector(':scope > .actions')?.remove();
    if (revertFeedback && revertFeedback.relPath === relPath) {
      meta.classList.add('fb');
      fillRevertFeedback(meta);
      return;
    }
    meta.classList.remove('fb');
    if (entry.pageCount) meta.appendChild(document.createTextNode(`${entry.pageCount} page${entry.pageCount === 1 ? '' : 's'}`));
    const badge = badgeFor(relPath, entry);
    if (badge) meta.insertAdjacentHTML('beforeend', badge.html);
    if (badge?.title) meta.title = badge.title;
    // A failed run is a fact about the last attempt, not about the document's text, so it stays out of the badge.
    if (entry.ocrError && !entry.ocrQueued && recognizingPath !== relPath) {
      const err = document.createElement('span');
      err.className = 'err';
      err.textContent = 'Recognition failed';
      meta.appendChild(err);
      meta.title = entry.ocrError;
    }
    if (entry.ocrFileError) {
      const err = document.createElement('span');
      err.className = 'err';
      err.textContent = 'Text data not used';
      meta.appendChild(err);
      meta.title = entry.ocrFileError;
    } else if (entry.ocrFile) {
      const src = document.createElement('span');
      src.textContent = entry.ocrFileNote ? '· Text data auto-aligned' : '· Text data attached';
      meta.appendChild(src);
      if (!meta.title) meta.title = entry.ocrFileNote || entry.ocrFile;
    }
    if (entry.status === 'pending' || entry.status === 'changed' || entry.status === 'error') {
      const actions = document.createElement('div');
      actions.className = 'actions';
      const indexBtn = document.createElement('button');
      indexBtn.textContent = 'Index';
      indexBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const entryNow = manifest?.docs[relPath];
        if (!ingest || !entryNow) return;
        if (entryNow.hash) sessions.invalidate(entryNow.hash);
        await ingest.enqueue(relPath);
        render();
        ingest.start();
      });
      actions.appendChild(indexBtn);
      card.appendChild(actions);
    }
  };

  /**
   * Drop the index entries and derived data of `paths`.
   * The files themselves stay where they are.
   * @param {string[]} paths
   */
  const forgetDocs = async (paths) => {
    if (!store || !manifest) return;
    for (const p of paths) {
      const entry = manifest.docs[p];
      if (!entry) continue;
      delete manifest.docs[p];
      // Identical files share a hash and therefore a sidecar, so the data files go only with the last reference to it.
      const shared = Object.values(manifest.docs).some((e2) => e2.hash === entry.hash);
      if (entry.hash && !shared) {
        await engine.removeDoc(entry.hash).catch(() => {});
        await Promise.all([
          store.deleteSidecar(entry.hash), store.deleteSidecarBackup(entry.hash),
          store.deleteThumb(entry.hash), store.deletePageRasters(entry.hash),
        ]).catch(() => {});
        sessions.invalidate(entry.hash);
      }
    }
    await store.writeManifest(manifest);
  };

  /**
   * Delete a copy the app made in the folder, with its tab and saved data.
   * @param {string} relPath
   */
  const removeJustAdded = async (relPath) => {
    if (!store || !manifest) return;
    if (!(await store.ensureWritable())) {
      viewer._showToast(`Couldn't remove “${titleOf(relPath)}” — editing ${store.root.name} wasn't allowed.`);
      return;
    }
    const name = titleOf(relPath);
    const folderName = store.root.name;
    const entry = manifest.docs[relPath];
    const openIdx = viewer._tabs.findIndex((t) => ownsTab(t) && (t.libraryRelPath === relPath || (entry?.hash && t.libraryHash === entry.hash)));
    if (openIdx >= 0) viewer._closeTab(openIdx);
    await forgetDocs([relPath]);
    try {
      await store.deleteSourceFile(relPath);
    } catch (err) {
      viewer._showToast(`Couldn't remove “${name}” — ${err instanceof Error ? err.message.replace(/\.$/, '') : 'the file could not be deleted'}.`);
    }
    justAdded = justAdded.filter((a) => a.relPath !== relPath);
    render();
    viewer._showToast(`Removed “${name}” from ${folderName}. The original is untouched.`);
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
    card.dataset.key = relPath;
    if (draggable) card.addEventListener('pointerdown', (e) => drag.beginCardDrag(e, relPath, card));

    const img = document.createElement('img');
    img.className = 'thumb';
    img.alt = '';
    // Images are natively draggable.
    // Left on, a press-drag starts an HTML5 image drag that cancels the reorder gesture and lands in the file-drop handlers as a bogus import.
    img.draggable = false;
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
    cardBody.appendChild(meta);
    card.appendChild(cardBody);
    updateCard(card, relPath, entry);

    const open = () => {
      if (drag.clickSuppressed()) return;
      // Resolved at click time: reused nodes outlive the entry object they were built with.
      const entryNow = manifest?.docs[relPath];
      if (entryNow) openEntry(relPath, entryNow);
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
   * Per folder, the cover order its card showed when a drop landed, which redraws keep.
   * @type {Map<string, string[]>}
   */
  const coverOrder = new Map();

  /**
   * Counts, aggregates, ingest-state tallies, and cover entries over a folder's direct children.
   * @param {string} dirPath
   * @param {import('./libraryStore.js').LibraryDocEntry[]} [except] - Children to leave out.
   */
  const dirStatsOf = (dirPath, except = []) => {
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
      noText: 0,
      /** @type {import('./libraryStore.js').LibraryDocEntry[]} */
      covers: [],
    };
    if (!manifest) return stats;
    /** @type {Array<[string, import('./libraryStore.js').LibraryDocEntry]>} */
    const children = [];
    for (const [p, entry] of Object.entries(manifest.docs)) {
      const cut = p.lastIndexOf('/');
      if ((cut < 0 ? '' : p.slice(0, cut)) !== dirPath || except.includes(entry)) continue;
      children.push([p, entry]);
      stats.docs++;
      stats.pages += entry.pageCount || 0;
      if (entry.added > stats.added) stats.added = entry.added;
      if (entry.lastOpened > stats.lastOpened) stats.lastOpened = entry.lastOpened;
      if (entry.status === 'missing') stats.missing++;
      else if (entry.status === 'changed') stats.changed++;
      else if (entry.status === 'error') stats.failed++;
      else if (entry.status === 'pending') stats.queued++;
      else if (entry.pdfType === 'image' && !entry.recognizedAt) stats.noText++;
    }
    for (const dir of manifest.dirs ?? []) {
      const cut = dir.lastIndexOf('/');
      if ((cut < 0 ? '' : dir.slice(0, cut)) === dirPath) stats.subdirs++;
    }
    // Name order keeps the strip from reshuffling whenever the sort mode changes.
    // After a drop the strip keeps the order its landing showed.
    // Otherwise the latest drag arrivals go last, where a drop draws them.
    children.sort(([a], [b]) => titleOf(a).localeCompare(titleOf(b), undefined, { numeric: true }));
    const latest = Math.max(0, ...children.map(([, entry]) => entry.arrived ?? 0));
    const newest = latest ? children.filter(([, entry]) => entry.arrived === latest).slice(0, 3) : [];
    const byName = children.filter((child) => !newest.includes(child));
    /** @type {typeof children} */
    const kept = [];
    for (const hash of coverOrder.get(dirPath) ?? []) {
      const child = children.find(([, entry]) => entry.hash === hash);
      if (child) kept.push(child);
    }
    const ordered = kept.length ? [...new Set([...kept, ...newest, ...byName])] : [...byName.slice(0, 3 - newest.length), ...newest];
    stats.covers = ordered.slice(0, 3).map(([, entry]) => entry);
    return stats;
  };

  /**
   * Draw a folder with its first covers tucked inside.
   * @param {import('./libraryStore.js').LibraryDocEntry[]} covers
   * @param {boolean} [mini] - Draw at the List view's thumbnail-slot size, with two covers.
   * @param {import('./libraryStore.js').LibraryDocEntry[]} [reserved] - Documents a drag carries over the folder, drawn last as reserved slots.
   */
  const buildFold = (covers, mini = false, reserved = []) => {
    const [w, h, pw, ph, gap, tops] = mini ? [40, 32, 14, 18, 4, [8, 7, 8]] : [150, 68, 40, 52, 6, [11, 9, 12]];
    const incoming = reserved.slice(0, mini ? 2 : 3);
    const papers = [...covers.slice(0, (mini ? 2 : 3) - incoming.length), ...incoming];
    const fold = document.createElement('span');
    fold.className = mini ? 'scribe-library-fold mini' : 'scribe-library-fold';
    fold.style.width = `${w}px`;
    fold.style.height = `${h}px`;
    // The back panel and its tab are one path, so the tab's shoulder meets the panel without a seam.
    const r = mini ? 2.5 : 4;
    const tabLen = Math.round(w * 0.29) - r - 4;
    const shoulder = mini ? '2 2.5' : '3.4 4.5';
    fold.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><path d="M.5 ${h - 3.5}V${r + 1.5}a${r} ${r} 0 0 1 ${r}-${r}h${tabLen}`
      + `a${r} ${r} 0 0 1 3.1 1.5l${shoulder}H${w - 0.5 - r}a${r} ${r} 0 0 1 ${r} ${r}V${h - 3.5}a3 3 0 0 1-3 3H3.5a3 3 0 0 1-3-3z"/></svg>`;
    const lift = [tops, [tops[0], tops[2]], [tops[1]]][3 - papers.length] ?? [];
    const left0 = (w - (papers.length * pw + (papers.length - 1) * gap)) / 2;
    papers.forEach((entry, i) => {
      const paper = document.createElement('span');
      paper.className = i >= papers.length - incoming.length ? 'paper reserved' : 'paper';
      paper.dataset.paper = entry.hash ?? '';
      paper.style.cssText = `left:${left0 + i * (pw + gap)}px;top:${lift[i]}px;width:${pw}px;height:${ph}px;`;
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      setThumbSrc(img, entry);
      paper.appendChild(img);
      fold.appendChild(paper);
    });
    const front = document.createElement('span');
    front.className = 'front';
    fold.appendChild(front);
    return fold;
  };

  /**
   * Bring the fold in `strip` to the state of `fold`, animating the change.
   * Papers are matched by document, so a paper in both slides to its new slot and the rest fade in or out where they sit.
   * @param {HTMLElement} strip
   * @param {HTMLElement} fold
   */
  const morphFold = (strip, fold) => {
    const old = strip.firstElementChild;
    if (!old || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      strip.replaceChildren(fold);
      return;
    }
    /** @param {Element} paper */
    const keyOf = (paper) => `${/** @type {HTMLElement} */ (paper).dataset.paper}${paper.classList.contains('reserved') ? ':reserved' : ''}`;
    const leaving = new Map([...old.querySelectorAll('.paper:not(.leaving)')].map((paper) => [keyOf(paper), /** @type {HTMLElement} */ (paper)]));
    /** @type {HTMLElement[]} */
    const arriving = [];
    /** @type {Array<[HTMLElement, string, string]>} */
    const sliding = [];
    // The standing fold stays in place and takes the new papers, so its flap eases into the drop state's tilt.
    const front = /** @type {HTMLElement} */ (old.querySelector('.front'));
    for (const el of fold.querySelectorAll('.paper')) {
      const paper = /** @type {HTMLElement} */ (el);
      const was = leaving.get(keyOf(paper));
      if (!was) {
        paper.style.opacity = '0';
        front.before(paper);
        arriving.push(paper);
        continue;
      }
      leaving.delete(keyOf(paper));
      if (was.style.left !== paper.style.left || was.style.top !== paper.style.top) sliding.push([was, paper.style.left, paper.style.top]);
    }
    for (const [, paper] of leaving) paper.classList.add('leaving');
    // A layout read commits the arrivals' start opacity before the transitions arm.
    old.getBoundingClientRect();
    for (const paper of arriving) paper.style.opacity = '';
    for (const [paper, left, top] of sliding) {
      paper.style.left = left;
      paper.style.top = top;
    }
    for (const [, paper] of leaving) paper.style.opacity = '0';
    setTimeout(() => { for (const [, paper] of leaving) paper.remove(); }, 200);
  };

  /**
   * Folders a drop is landing in, each with the documents still in flight.
   * @type {Map<string, import('./libraryStore.js').LibraryDocEntry[]>}
   */
  const landings = new Map();

  /**
   * The last move, while it can still be taken back.
   * `slot` is the place a moved folder left when its destination is off screen, where a placeholder carries the undo line.
   * @type {?{dir: string, moves: LibraryMove[], slot: ?{dir: string, index: number, name: string, text: string}}}
   */
  let undoInfo = null;
  let undoTimer = 0;
  const clearUndo = () => {
    window.clearTimeout(undoTimer);
    undoTimer = 0;
    undoInfo = null;
  };

  // The vacated slot's key starts with NUL, which no path can contain.
  const VACATED = '\u0000vacated';
  const vacatedHere = () => (undoInfo?.slot && undoInfo.slot.dir === currentDir ? undoInfo.slot : null);
  /** @param {string[]} dirs */
  const withVacated = (dirs) => {
    const slot = vacatedHere();
    if (!slot) return dirs;
    const out = dirs.slice();
    out.splice(Math.max(0, Math.min(slot.index, out.length)), 0, VACATED);
    return out;
  };
  /** @param {string[]} dirs */
  const foldersLabel = (dirs) => (dirs.length ? `Folders · ${dirs.length}` : 'Folders');

  /**
   * @param {HTMLElement} host
   * @param {string} text
   */
  const fillUndoLine = (host, text) => {
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = text;
    t.title = text;
    host.appendChild(t);
    const sep = document.createElement('span');
    sep.textContent = '·';
    host.appendChild(sep);
    const undo = document.createElement('span');
    undo.className = 'undo';
    undo.textContent = 'Undo';
    undo.setAttribute('role', 'button');
    undo.tabIndex = 0;
    undo.addEventListener('pointerdown', (e) => e.stopPropagation());
    undo.addEventListener('click', (e) => {
      e.stopPropagation();
      undoMoves();
    });
    undo.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        undoMoves();
      }
    });
    host.appendChild(undo);
  };

  const buildVacatedCard = () => {
    const slot = /** @type {NonNullable<ReturnType<typeof vacatedHere>>} */ (vacatedHere());
    const card = document.createElement('div');
    card.className = 'scribe-library-card folder vacated';
    card.dataset.key = VACATED;
    const strip = document.createElement('div');
    strip.className = 'fstrip';
    strip.appendChild(buildFold([]));
    card.appendChild(strip);
    const cardBody = document.createElement('div');
    cardBody.className = 'body';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = slot.name;
    cardBody.appendChild(title);
    const meta = document.createElement('div');
    meta.className = 'meta live';
    fillUndoLine(meta, slot.text);
    cardBody.appendChild(meta);
    card.appendChild(cardBody);
    return card;
  };

  const buildVacatedRow = () => {
    const slot = /** @type {NonNullable<ReturnType<typeof vacatedHere>>} */ (vacatedHere());
    const comfortable = viewMode === 'list';
    const row = document.createElement('div');
    row.className = comfortable ? 'scribe-library-row cf folder vacated' : 'scribe-library-row folder vacated';
    row.dataset.key = VACATED;
    const nm = document.createElement('span');
    nm.className = 'nm';
    const title = document.createElement('span');
    title.className = 't';
    title.textContent = slot.name;
    if (comfortable) {
      const thumb = document.createElement('span');
      thumb.className = 'fthumb';
      thumb.appendChild(buildFold([], true));
      nm.appendChild(thumb);
      const stack = document.createElement('span');
      stack.className = 'tt';
      stack.appendChild(title);
      const line = document.createElement('span');
      line.className = 'm2 live';
      fillUndoLine(line, slot.text);
      stack.appendChild(line);
      nm.appendChild(stack);
    } else {
      nm.appendChild(title);
      const line = document.createElement('span');
      line.className = 'cnt live';
      fillUndoLine(line, slot.text);
      nm.appendChild(line);
    }
    row.appendChild(nm);
    for (let i = 0; i < 3; i++) {
      const cell = document.createElement('span');
      cell.className = 'none';
      cell.textContent = '—';
      row.appendChild(cell);
    }
    return row;
  };

  /**
   * Fill a folder's summary slot with its tallies, or with the undo line while its last drop can still be taken back.
   * @param {HTMLElement} host
   * @param {string} dirPath
   * @param {ReturnType<typeof dirStatsOf>} stats
   */
  const fillFolderLine = (host, dirPath, stats) => {
    host.textContent = '';
    host.classList.remove('hasatt', 'live');
    if (undoInfo && undoInfo.dir === dirPath) {
      host.classList.add('live');
      const dirs = undoInfo.moves.filter((m) => m.kind === 'dir').length;
      fillUndoLine(host, dirs === undoInfo.moves.length ? `Moved ${dirs} folder${dirs === 1 ? '' : 's'}` : `Moved ${undoInfo.moves.length} here`);
      return;
    }
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
    if (stats.noText) soft.push(`${stats.noText} without text`);
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
   * Refresh everything a folder card shows, leaving the shell in place.
   * A folder's covers and tallies come from its children, so this runs whenever any of them change.
   * @param {HTMLElement} card
   * @param {string} dirPath
   */
  const updateFolderCard = (card, dirPath) => {
    card.classList.toggle('selected', selectedPaths.has(`${dirPath}/`));
    // A drop landing here keeps the face its hover showed, even on a card rebuilt mid-flight.
    // The files may already have moved, so the tallies leave out the documents in flight.
    const inFlight = landings.get(dirPath);
    const stats = dirStatsOf(dirPath, inFlight);
    if (inFlight) {
      card.classList.add('drop');
      previewFolder(card, dirPath, inFlight);
    } else {
      if (!(undoInfo && undoInfo.dir === dirPath)) card.style.minHeight = '';
      morphFold(/** @type {HTMLElement} */ (card.querySelector(':scope > .fstrip')), buildFold(stats.covers));
    }
    fillFolderLine(/** @type {HTMLElement} */ (card.querySelector(':scope > .body > .meta')), dirPath, stats);
  };

  /**
   * Show a folder's fold as the drag over it will leave it.
   * @param {HTMLElement} elem - The folder's card or row.
   * @param {string} dirPath
   * @param {import('./libraryStore.js').LibraryDocEntry[]} entries - The documents in the hand.
   */
  const previewFolder = (elem, dirPath, entries) => {
    const isCard = elem.classList.contains('scribe-library-card');
    // The card keeps at least its resting height from the hover until the undo line goes.
    // Shrinking it would shift the cards below when the undo line appears.
    if (isCard && !elem.style.minHeight) elem.style.minHeight = `${elem.getBoundingClientRect().height}px`;
    const stats = dirStatsOf(dirPath);
    const strip = /** @type {?HTMLElement} */ (isCard ? elem.querySelector(':scope > .fstrip') : elem.querySelector('.nm > .fthumb'));
    // Once the files move, the carried documents are the folder's own, and must not be drawn twice.
    if (strip) morphFold(strip, buildFold(stats.covers.filter((entry) => !entries.includes(entry)), !isCard, entries));
  };

  /**
   * Begin a drop's landing in a folder.
   * The folder keeps the face its hover showed until the landing finishes.
   * @param {string} dirPath
   * @param {import('./libraryStore.js').LibraryDocEntry[]} entries - The documents in flight.
   */
  const startLanding = (dirPath, entries) => {
    landings.set(dirPath, entries);
  };

  /**
   * Record a landed move and show where it can be taken back.
   * Call it before the render that follows the move, except after a drop on a folder, where it ends the hover face once the flight lands.
   * @param {string} dirPath - The destination.
   * @param {LibraryMove[]} moves - Empty when nothing moved.
   * @param {string} fromDir - The directory the items came from.
   */
  const finishLanding = (dirPath, moves, fromDir) => {
    landings.delete(dirPath);
    const elem = folderElemOf(dirPath);
    const redraw = () => {
      if (elem) (elem.classList.contains('scribe-library-card') ? updateFolderCard : updateFolderRow)(elem, dirPath);
    };
    if (!moves.length) {
      elem?.classList.remove('drop');
      redraw();
      return;
    }
    if (elem) {
      for (const paper of elem.querySelectorAll('.paper.reserved')) {
        const img = /** @type {?HTMLImageElement} */ (paper.querySelector('img'));
        if (img) {
          img.style.opacity = '1';
          img.style.filter = 'none';
        }
        paper.classList.remove('reserved');
      }
      // The papers sit in the DOM in arrival order, so the drawn order is read off their slots.
      if (elem.querySelector('.scribe-library-fold')) coverOrder.set(dirPath, [...elem.querySelectorAll('.paper:not(.leaving)')].sort((a, b) => parseFloat(/** @type {HTMLElement} */ (a).style.left) - parseFloat(/** @type {HTMLElement} */ (b).style.left)).map((paper) => /** @type {HTMLElement} */ (paper).dataset.paper ?? ''));
      elem.classList.add('landed');
      elem.classList.remove('drop');
    }
    const priorDir = undoInfo?.dir;
    clearUndo();
    const firstDir = moves.find((m) => m.kind === 'dir');
    undoInfo = {
      dir: dirPath,
      moves,
      slot: !elem && firstDir && fromDir === currentDir
        ? {
          dir: fromDir,
          index: firstDir.index,
          name: titleOf(firstDir.from),
          text: `Now in ${[store?.root.name ?? opts.name, ...(dirPath ? dirPath.split('/') : [])].join(' › ')}`,
        }
        : null,
    };
    // The folder that showed the last drop's undo line goes back to its tallies, so its Undo cannot take back this drop instead.
    const prior = priorDir !== undefined && priorDir !== dirPath ? folderElemOf(priorDir) : null;
    if (prior) (prior.classList.contains('scribe-library-card') ? updateFolderCard : updateFolderRow)(prior, prior.dataset.dirTarget ?? '');
    undoTimer = window.setTimeout(() => {
      clearUndo();
      // Only a render removes a vacated slot.
      drag.renderWithSlide();
    }, 8000);
    if (elem) {
      window.setTimeout(() => {
        elem.classList.remove('landed');
        redraw();
      }, 420);
    }
  };

  /** @param {string} dirPath */
  const folderElemOf = (dirPath) => /** @type {?HTMLElement} */ (body.querySelector(`.scribe-library-card.folder[data-dir-target="${CSS.escape(dirPath)}"], .scribe-library-row.folder[data-dir-target="${CSS.escape(dirPath)}"]`));

  /** Take back the move the undo line stands for. */
  const undoMoves = async () => {
    const info = undoInfo;
    if (!info || !store || !manifest || fsOpBusy) return;
    clearUndo();
    const order = coverOrder.get(info.dir);
    if (order) coverOrder.set(info.dir, order.filter((hash) => !info.moves.some((move) => move.kind === 'doc' && move.hash === hash)));
    const host = folderElemOf(info.dir);
    /** @type {Map<string, DOMRect>} */
    const starts = new Map();
    if (host) {
      for (const paper of host.querySelectorAll('.paper[data-paper]')) starts.set(/** @type {HTMLElement} */ (paper).dataset.paper ?? '', paper.getBoundingClientRect());
      const fold = host.querySelector('.scribe-library-fold');
      if (fold) starts.set('', fold.getBoundingClientRect());
    }
    /** @type {Array<{hash: string, relPath: string}>} */
    const restored = [];
    /** @type {string[]} */
    const restoredDirs = [];
    if (!(await store.ensureWritable())) {
      viewer._showToast(`Couldn't move them back — editing ${store.root.name} wasn't allowed.`);
      // The undo is spent, so a render takes away its line and any vacated slot.
      drag.renderWithSlide();
      return;
    }
    fsOpBusy = true;
    if (ingest) ingest.paused = true;
    let partial = false;
    for (const move of info.moves) {
      const cut = move.from.lastIndexOf('/');
      const backDir = cut < 0 ? '' : move.from.slice(0, cut);
      if (move.kind === 'dir') {
        try {
          // The folder takes its old name back, unless something else took it meanwhile.
          const back = await store.moveDir(move.to, backDir, titleOf(move.from));
          rekeyDirRecords(move.to, back.relPath, back.mtimes);
          selectedPaths.add(`${back.relPath}/`);
          restoredDirs.push(back.relPath);
        } catch (err) {
          partial = true;
          viewer._showToast(`Couldn't move “${titleOf(move.to)}” back — ${err instanceof Error ? err.message : 'the folder could not be moved'}.`);
        }
        continue;
      }
      const entry = manifest.docs[move.to];
      if (!entry) continue;
      try {
        const back = await store.moveFile(move.to, backDir);
        delete manifest.docs[move.to];
        manifest.docs[back.relPath] = entry;
        entry.mtime = back.mtime;
        if (move.arrivedBefore) entry.arrived = move.arrivedBefore;
        else delete entry.arrived;
        selectedPaths.add(back.relPath);
        restored.push({ hash: entry.hash, relPath: back.relPath });
      } catch (err) {
        viewer._showToast(`Couldn't move “${titleOf(move.to)}” back — ${err instanceof Error ? err.message : 'the file could not be moved'}.`);
      }
    }
    try {
      await store.writeManifest(manifest);
    } catch {
      saveManifestSoon();
    }
    if (ingest) ingest.paused = false;
    // A failed folder transfer may have left a partial tree, and a scan reconciles whatever state the disk is in.
    if (partial) await ingest?.scan().catch(() => { });
    fsOpBusy = false;
    ingest?.start();
    const now = folderElemOf(info.dir);
    if (now) (now.classList.contains('scribe-library-card') ? updateFolderCard : updateFolderRow)(now, info.dir);
    drag.renderWithSlide();
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (const dir of restoredDirs) folderElemOf(dir)?.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: FOLDER_FLY_MS, easing: 'ease' });
    /** @type {Parameters<typeof flyCopies>[0]} */
    const flights = [];
    /** @type {HTMLImageElement[]} */
    const hidden = [];
    for (const { hash, relPath } of restored) {
      const card = /** @type {?HTMLElement} */ (body.querySelector(`[data-band="main-grid"] > [data-rel-path="${CSS.escape(relPath)}"]`));
      const img = /** @type {?HTMLImageElement} */ (card?.querySelector('img.thumb') ?? null);
      const from = starts.get(hash) ?? starts.get('');
      if (!img || !from) continue;
      img.style.opacity = '0';
      hidden.push(img);
      flights.push({
        img, from: { left: from.left, top: from.top, width: from.width, height: from.height }, to: img.getBoundingClientRect(), fit: 'contain',
      });
    }
    await flyCopies(flights, FOLDER_FLY_MS);
    for (const img of hidden) img.style.opacity = '';
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
    card.dataset.key = `${dirPath}/`;
    card.dataset.dirTarget = dirPath;
    card.addEventListener('pointerdown', (e) => drag.beginCardDrag(e, `${dirPath}/`, card));

    const strip = document.createElement('div');
    strip.className = 'fstrip';
    card.appendChild(strip);

    const cardBody = document.createElement('div');
    cardBody.className = 'body';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = dirPath.split('/').pop() || dirPath;
    title.title = dirPath;
    cardBody.appendChild(title);
    const meta = document.createElement('div');
    meta.className = 'meta';
    cardBody.appendChild(meta);
    card.appendChild(cardBody);
    updateFolderCard(card, dirPath);

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
    card.tabIndex = 0;
    card.dataset.relPath = relPath;
    card.dataset.key = relPath;
    card.classList.toggle('selected', selectedPaths.has(relPath));
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
    card.addEventListener('click', (e) => {
      if (drag.clickSuppressed()) return;
      const paths = [...(card.parentElement?.querySelectorAll(':scope > .scribe-library-card') ?? [])]
        .map((el) => /** @type {HTMLElement} */ (el).dataset.relPath ?? '');
      applyClickSelection(e, relPath, paths);
    });
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (drag.active() || drag.touchDragRecent()) return;
      openCardMenu(e.clientX, e.clientY, relPath, card);
    });
    return card;
  };

  /**
   * Refresh everything a doc row's cells show from `entry`, leaving the shell and its listeners in place.
   * @param {HTMLElement} row
   * @param {string} relPath
   * @param {import('./libraryStore.js').LibraryDocEntry} entry
   */
  const updateRow = (row, relPath, entry) => {
    const comfortable = viewMode === 'list';
    row.classList.toggle('selected', selectedPaths.has(relPath));
    const feedback = !!revertFeedback && revertFeedback.relPath === relPath;
    const badgeInfo = feedback ? null : badgeFor(relPath, entry);
    const failed = !feedback && !!entry.ocrError && !entry.ocrQueued && recognizingPath !== relPath;
    const ocrFileHtml = entry.ocrFileError ? '<span class="err">Text data not used</span>' : entry.ocrFile ? `<span>${entry.ocrFileNote ? 'Text data auto-aligned' : 'Text data attached'}</span>` : '';
    const badge = (badgeInfo ? badgeInfo.html : '') + (failed ? '<span class="err">Recognition failed</span>' : '') + (!feedback ? ocrFileHtml : '');
    const badgeTitle = failed ? entry.ocrError : (badgeInfo?.title || entry.ocrFileError || entry.ocrFileNote || entry.ocrFile);
    // A portfolio's cover sheet is never shown, so its row carries the portfolio glyph where the thumbnail or page icon would sit.
    const nm = /** @type {HTMLElement} */ (row.querySelector(':scope > .nm'));
    if (!!entry.portfolio !== !!nm.querySelector(':scope > .pf')) {
      nm.querySelector(':scope > .pf')?.remove();
      if (entry.portfolio) {
        const glyph = document.createElement('span');
        glyph.className = comfortable ? 'fthumb pf' : 'fi pf';
        glyph.innerHTML = comfortable ? `<span class="fi">${PORTFOLIO_SVG}</span>` : PORTFOLIO_SVG;
        nm.insertBefore(glyph, nm.firstChild);
      }
      const img = /** @type {?HTMLElement} */ (nm.querySelector(':scope > img'));
      if (img) img.style.display = entry.portfolio ? 'none' : '';
    }
    if (comfortable) {
      if (!entry.portfolio) setThumbSrc(/** @type {HTMLImageElement} */ (row.querySelector('.nm > img')), entry);
      const stack = /** @type {HTMLElement} */ (row.querySelector('.nm > .tt'));
      stack.querySelector(':scope > .m2')?.remove();
      if (badge || feedback) {
        const meta = document.createElement('span');
        meta.className = 'm2';
        if (feedback) fillRevertFeedback(meta);
        else {
          meta.innerHTML = badge;
          if (badgeTitle) meta.title = badgeTitle;
        }
        stack.appendChild(meta);
      }
    }
    /** @param {number} t */
    const fmtDate = (t) => (t > 0
      ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      : '—');
    const cells = /** @type {HTMLElement[]} */ ([...row.children]);
    cells[1].className = entry.pageCount ? 'num' : 'none';
    cells[1].textContent = entry.pageCount ? String(entry.pageCount) : '—';
    cells[2].className = entry.added > 0 ? 'dt' : 'none';
    cells[2].textContent = fmtDate(entry.added);
    cells[3].className = entry.lastOpened > 0 ? 'dt' : 'none';
    cells[3].textContent = fmtDate(entry.lastOpened);
    if (!comfortable) {
      const statusCell = cells[4];
      statusCell.removeAttribute('title');
      if (feedback) {
        statusCell.className = '';
        statusCell.textContent = '';
        fillRevertFeedback(statusCell);
      } else if (badge) {
        statusCell.className = '';
        statusCell.innerHTML = badge;
        if (badgeTitle) statusCell.title = badgeTitle;
      } else {
        statusCell.className = 'none';
        statusCell.textContent = '—';
      }
    }
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
    row.dataset.key = relPath;
    // Rows drag for moving into folders only; reordering is a grid-under-Custom affair.
    row.addEventListener('pointerdown', (e) => drag.beginCardDrag(e, relPath, row));

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
      nm.appendChild(img);
      const stack = document.createElement('span');
      stack.className = 'tt';
      stack.appendChild(title);
      nm.appendChild(stack);
    } else {
      nm.appendChild(title);
    }
    row.appendChild(nm);
    for (let i = 0; i < (comfortable ? 3 : 4); i++) row.appendChild(document.createElement('span'));
    updateRow(row, relPath, entry);

    const open = () => {
      if (drag.clickSuppressed()) return;
      // Resolved at click time: reused nodes outlive the entry object they were built with.
      const entryNow = manifest?.docs[relPath];
      if (entryNow) openEntry(relPath, entryNow);
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
      const entryNow = manifest?.docs[relPath];
      if (entryNow) showListPreview(relPath, entryNow, 0);
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
   * Refresh everything a folder row's cells show, leaving the shell in place.
   * A folder's tallies come from its children, so this runs whenever any of them change.
   * @param {HTMLElement} row
   * @param {string} dirPath
   */
  const updateFolderRow = (row, dirPath) => {
    const comfortable = viewMode === 'list';
    row.classList.toggle('selected', selectedPaths.has(`${dirPath}/`));
    const inFlight = landings.get(dirPath);
    const stats = dirStatsOf(dirPath, inFlight);
    if (inFlight) {
      row.classList.add('drop');
      previewFolder(row, dirPath, inFlight);
    } else if (comfortable) morphFold(/** @type {HTMLElement} */ (row.querySelector('.nm > .fthumb')), buildFold(stats.covers, true));
    fillFolderLine(/** @type {HTMLElement} */ (row.querySelector(comfortable ? '.nm .m2' : '.nm .cnt')), dirPath, stats);
    /** @param {number} t */
    const fmtDate = (t) => (t > 0
      ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      : '—');
    const cells = /** @type {HTMLElement[]} */ ([...row.children]);
    cells[1].className = stats.pages ? 'roll pg' : 'none';
    cells[1].textContent = stats.pages ? String(stats.pages) : '—';
    cells[2].className = stats.added > 0 ? 'roll' : 'none';
    cells[2].textContent = fmtDate(stats.added);
    cells[3].className = stats.lastOpened > 0 ? 'roll' : 'none';
    cells[3].textContent = fmtDate(stats.lastOpened);
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
    row.dataset.key = `${dirPath}/`;
    row.dataset.dirTarget = dirPath;
    row.addEventListener('pointerdown', (e) => drag.beginCardDrag(e, `${dirPath}/`, row));

    const nm = document.createElement('span');
    nm.className = 'nm';
    const title = document.createElement('span');
    title.className = 't';
    title.textContent = dirPath.split('/').pop() || dirPath;
    title.title = dirPath;
    if (comfortable) {
      const slot = document.createElement('span');
      slot.className = 'fthumb';
      nm.appendChild(slot);
      const stack = document.createElement('span');
      stack.className = 'tt';
      stack.appendChild(title);
      const meta = document.createElement('span');
      meta.className = 'm2';
      stack.appendChild(meta);
      nm.appendChild(stack);
    } else {
      nm.appendChild(title);
      const cnt = document.createElement('span');
      cnt.className = 'cnt';
      nm.appendChild(cnt);
    }
    row.appendChild(nm);
    for (let i = 0; i < 3; i++) row.appendChild(document.createElement('span'));
    updateFolderRow(row, dirPath);

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
    row.tabIndex = 0;
    row.dataset.relPath = relPath;
    row.dataset.key = relPath;
    row.classList.toggle('selected', selectedPaths.has(relPath));
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
    row.addEventListener('click', (e) => {
      if (drag.clickSuppressed()) return;
      const paths = [...(row.parentElement?.querySelectorAll(':scope > .scribe-library-row') ?? [])]
        .map((el) => /** @type {HTMLElement} */ (el).dataset.relPath ?? '');
      // Preview first: syncSelectionUI keeps the previewed file selected, so listPreviewPath must already point at this row.
      showOtherPreview(relPath);
      applyClickSelection(e, relPath, paths);
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (drag.active() || drag.touchDragRecent()) return;
      openCardMenu(e.clientX, e.clientY, relPath, row);
    });
    return row;
  };

  /**
   * The list views' items in display order, with their group headings.
   * @param {string[]} shownDirs
   * @param {Array<[string, import('./libraryStore.js').LibraryDocEntry]>} shown
   * @param {string[]} shownOthers
   */
  const listItems = (shownDirs, shown, shownOthers) => [
    // Heading keys start with NUL, which no path can contain.
    ...(shownDirs.length || vacatedHere() ? [['head', ['\u0000folders', foldersLabel(shownDirs)]]] : []),
    ...withVacated(shownDirs).map((d) => (d === VACATED ? ['vacated', d] : ['dir', d])),
    ...((shownDirs.length || vacatedHere()) && shown.length ? [['head', ['\u0000docs', `Documents · ${shown.length}`]]] : []),
    ...shown.map((pe) => ['doc', pe]),
    ...(shownOthers.length ? [['head', ['\u0000others', 'Other files']]] : []),
    ...shownOthers.map((p) => ['other', p]),
  ];

  /** @param {ReturnType<typeof listItems>[number]} item */
  const buildListItem = ([kind, v]) => {
    if (kind === 'head') {
      const heading = document.createElement('div');
      heading.className = 'scribe-library-lgroup';
      heading.dataset.key = v[0];
      heading.textContent = v[1];
      return heading;
    }
    if (kind === 'vacated') return buildVacatedRow();
    if (kind === 'dir') return buildFolderRow(v);
    return kind === 'doc' ? buildRow(v[0], v[1]) : buildOtherRow(v);
  };

  // --- Folder operations --------------------------------------------------

  /**
   * Swap the folder's title text for a text field.
   * Enter or blur commits the new name, and Escape cancels.
   * A `fresh` folder was just created under a placeholder name, so cancelling removes it again while it is still empty.
   * @param {string} dirPath
   * @param {HTMLElement} hostElem - The folder's grid card or list row.
   * @param {boolean} [fresh]
   */
  const startFolderRename = async (dirPath, hostElem, fresh = false) => {
    if (readOnly || renameEditing || fsOpBusy || !store) return;
    // Asked when the editor opens, since a commit on blur may come without the user gesture a prompt needs.
    if (!(await store.ensureWritable())) {
      viewer._showToast(`Couldn't rename — editing ${store.root.name} wasn't allowed.`);
      return;
    }
    if (renameEditing || fsOpBusy || !hostElem.isConnected) return;
    const inGrid = hostElem.classList.contains('scribe-library-card');
    const target = inGrid
      ? [...(hostElem.querySelector('.body .title')?.childNodes ?? [])].find((n) => n.nodeType === Node.TEXT_NODE)
      : hostElem.querySelector('.nm .t');
    if (!target) return;
    renameEditing = true;
    // The folder must not take drops mid-edit.
    // Dropping the reconcile key forces the next render to rebuild this node, which now hosts the editor in place of its title.
    delete hostElem.dataset.dirTarget;
    delete hostElem.dataset.key;
    const oldName = dirPath.split('/').pop() || dirPath;
    // A grid title wraps, so its field is a textarea that breaks at the same points.
    const input = document.createElement(inGrid ? 'textarea' : 'input');
    input.className = 'scribe-library-rename';
    input.value = oldName;
    input.setAttribute('aria-label', 'Folder name');
    target.replaceWith(input);
    input.focus();
    input.select();
    // Focusing and selecting leave a long name scrolled to its end, but the title showed its start.
    input.scrollLeft = 0;
    input.scrollTop = 0;
    // Unlike an input, a textarea keeps pasted line breaks, which no folder name can hold.
    input.addEventListener('input', () => {
      if (!input.value.includes('\n')) return;
      const { selectionStart, selectionEnd } = input;
      input.value = input.value.replaceAll('\n', ' ');
      input.setSelectionRange(selectionStart, selectionEnd);
    });
    let done = false;
    /** @param {boolean} save @param {boolean} [viaEnter] */
    const finish = async (save, viaEnter = false) => {
      if (done) return;
      const name = input.value.trim();
      if (save && name && name !== oldName) {
        const problem = folderNameProblem(name);
        if (!problem) {
          done = true;
          input.disabled = true;
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
    /** @type {HTMLElement} */ (input).addEventListener('keydown', (e) => {
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
    rekeyDirRecords(oldDirPath, newDirPath, mtimes);
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

  /**
   * Re-key every path-shaped record under `oldDirPath` once the folder lives at `newDirPath` on disk.
   * @param {string} oldDirPath
   * @param {string} newDirPath
   * @param {Map<string, number>} mtimes - Timestamp of every transferred file, keyed by its new relative path.
   */
  const rekeyDirRecords = (oldDirPath, newDirPath, mtimes) => {
    if (!manifest) return;
    /** @param {string} p */
    const rekey = (p) => {
      if (p === oldDirPath) return newDirPath;
      return p.startsWith(`${oldDirPath}/`) ? newDirPath + p.slice(oldDirPath.length) : p;
    };
    /** @param {string} key */
    const rekeyKey = (key) => (key.endsWith('/') ? `${rekey(key.slice(0, -1))}/` : rekey(key));
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
    for (const p of selected) selectedPaths.add(rekeyKey(p));
    if (selAnchor) selAnchor = rekeyKey(selAnchor);
    if (listPreviewPath) listPreviewPath = rekey(listPreviewPath);
    for (const t of viewer._tabs) if (ownsTab(t) && t.libraryRelPath) t.libraryRelPath = rekey(t.libraryRelPath);
    currentDir = rekey(currentDir);
    for (const a of justAdded) a.relPath = rekey(a.relPath);
    for (const [dir, order] of [...coverOrder]) {
      if (rekey(dir) === dir) continue;
      coverOrder.delete(dir);
      coverOrder.set(rekey(dir), order);
    }
    if (undoInfo) {
      undoInfo.dir = rekey(undoInfo.dir);
      for (const m of undoInfo.moves) {
        m.from = rekey(m.from);
        m.to = rekey(m.to);
      }
      if (undoInfo.slot) undoInfo.slot.dir = rekey(undoInfo.slot.dir);
    }
  };

  /**
   * The card or row for `key` in the bands a drag carries from.
   * @param {string} key
   */
  const bandElemOf = (key) => /** @type {?HTMLElement} */ (body.querySelector(['folders-grid', 'main-grid', 'rows'].map((b) => `[data-band="${b}"] > [data-rel-path="${CSS.escape(key)}"]`).join(', ')));

  /**
   * Move the documents and folders behind `keys` into `destDir`.
   * @param {string[]} keys
   * @param {string} destDir
   * @returns {Promise<{moves: LibraryMove[], failed: string[]}>}
   */
  const moveItems = async (keys, destDir) => {
    /** @type {LibraryMove[]} */
    const moves = [];
    if (!store || !manifest || fsOpBusy) return { moves, failed: keys };
    const label = keys.length === 1 ? `“${titleOf(keys[0].endsWith('/') ? keys[0].slice(0, -1) : keys[0])}”` : `${keys.length} items`;
    let writable = false;
    try {
      writable = await store.ensureWritable();
      if (!writable) viewer._showToast(`Couldn't move ${label} — editing ${store.root.name} wasn't allowed.`);
    } catch (err) {
      viewer._showToast(`Couldn't move ${label} — ${err instanceof Error ? err.message : 'the folder could not be edited'}.`);
    }
    if (!writable) return { moves, failed: keys };
    /** @type {string[]} */
    const failed = [];
    fsOpBusy = true;
    if (ingest) ingest.paused = true;
    const stamp = Date.now();
    let partial = false;
    for (const key of keys) {
      if (key.endsWith('/')) {
        const dirPath = key.slice(0, -1);
        // A vacated slot from the last move may still stand in the band, so the index counts real folders only.
        const elem = bandElemOf(key);
        const slotIndex = elem ? [...(elem.parentElement?.children ?? [])].filter((c) => c.classList.contains('folder') && !c.classList.contains('vacated')).indexOf(elem) : -1;
        try {
          const moved = await store.moveDir(dirPath, destDir);
          rekeyDirRecords(dirPath, moved.relPath, moved.mtimes);
          selectedPaths.delete(`${moved.relPath}/`);
          moves.push({
            kind: 'dir', from: dirPath, to: moved.relPath, index: slotIndex,
          });
        } catch (err) {
          partial = true;
          viewer._showToast(`Couldn't move “${titleOf(dirPath)}” — ${err instanceof Error ? err.message : 'the folder could not be moved'}.`);
          failed.push(key);
        }
        continue;
      }
      const entry = manifest.docs[key];
      if (!entry) {
        failed.push(key);
        continue;
      }
      try {
        const moved = await store.moveFile(key, destDir);
        delete manifest.docs[key];
        manifest.docs[moved.relPath] = entry;
        // The copy re-stamps the file; recording the new mtime avoids a pointless verify on the next scan.
        entry.mtime = moved.mtime;
        moves.push({
          kind: 'doc', from: key, to: moved.relPath, hash: entry.hash, arrivedBefore: entry.arrived ?? null,
        });
        entry.arrived = stamp;
        selectedPaths.delete(key);
      } catch (err) {
        viewer._showToast(`Couldn't move “${titleOf(key)}” — ${err instanceof Error ? err.message : 'the file could not be moved'}.`);
        failed.push(key);
      }
    }
    if (moves.length) {
      try {
        await store.writeManifest(manifest);
      } catch {
        saveManifestSoon();
      }
    }
    if (ingest) ingest.paused = false;
    // A failed folder transfer may have left a partial tree, and a scan reconciles whatever state the disk is in.
    if (partial) await ingest?.scan().catch(() => { });
    fsOpBusy = false;
    ingest?.start();
    return { moves, failed };
  };

  /**
   * The documents and folders a menu action on `key` applies to.
   * @param {string} key
   */
  const moveSetFor = (key) => {
    if (!(selectedPaths.has(key) && selectedPaths.size >= 2)) return [key];
    const chosen = [...body.querySelectorAll('[data-band="folders-grid"] > [data-rel-path], [data-band="main-grid"] > [data-rel-path], [data-band="rows"] > [data-rel-path]')]
      .map((el) => /** @type {HTMLElement} */ (el).dataset.relPath ?? '')
      .filter((p) => selectedPaths.has(p) && (p.endsWith('/') || !!manifest?.docs[p]));
    return chosen.includes(key) ? chosen : [key];
  };

  /** @type {?HTMLElement} */
  let movePicker = null;
  const closeMovePicker = () => {
    movePicker?.remove();
    movePicker = null;
  };

  /**
   * @param {string[]} keys
   * @param {string} destDir
   */
  const commitMovePicker = async (keys, destDir) => {
    const fromDir = currentDir;
    const elems = keys.map(bandElemOf).filter((e) => !!e);
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      await Promise.all(elems.map((e) => e.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.9)' }], { duration: 140, easing: 'ease', fill: 'forwards' }).finished));
    }
    const { moves } = await moveItems(keys, destDir);
    if (!moves.length) {
      for (const e of elems) for (const a of e.getAnimations()) a.cancel();
      return;
    }
    finishLanding(destDir, moves, fromDir);
    drag.renderWithSlide();
  };

  /**
   * Open the Move to... picker beside `anchorElem`.
   * @param {string[]} keys
   * @param {HTMLElement} anchorElem
   */
  const openMovePicker = (keys, anchorElem) => {
    closeMovePicker();
    if (!store || !manifest || readOnly || renameEditing) return;
    const fromDir = currentDir;
    const rootName = store.root.name;
    const dirKeys = keys.filter((k) => k.endsWith('/')).map((k) => k.slice(0, -1));
    const panel = document.createElement('div');
    panel.className = 'scribe-library-picker';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Move to');
    const head = document.createElement('div');
    head.className = 'pk-head';
    const title = document.createElement('span');
    title.className = 'pk-title';
    title.textContent = keys.length === 1 ? `Move “${titleOf(keys[0].endsWith('/') ? keys[0].slice(0, -1) : keys[0])}” to` : `Move ${keys.length} items to`;
    head.appendChild(title);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'pk-x';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => closeMovePicker());
    head.appendChild(close);
    panel.appendChild(head);
    const field = document.createElement('div');
    field.className = 'scribe-library-field';
    field.innerHTML = FIELD_SEARCH_SVG;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'scribe-library-search';
    input.placeholder = 'Filter folders';
    input.setAttribute('aria-label', 'Filter folders');
    field.appendChild(input);
    panel.appendChild(field);
    const tree = document.createElement('div');
    tree.className = 'pk-tree';
    tree.setAttribute('role', 'listbox');
    /** @type {Map<string, string[]>} */
    const children = new Map();
    for (const dir of manifest.dirs ?? []) {
      const cut = dir.lastIndexOf('/');
      const parent = cut < 0 ? '' : dir.slice(0, cut);
      children.set(parent, [...(children.get(parent) ?? []), dir]);
    }
    /** @type {HTMLElement[]} */
    const rows = [];
    /** @type {?HTMLElement} */
    let current = null;
    /** @param {?HTMLElement} row */
    const select = (row) => {
      for (const r of rows) r.classList.toggle('on', r === row);
      current = row;
      move.disabled = !row;
      row?.scrollIntoView({ block: 'nearest' });
    };
    const choices = () => rows.filter((r) => !r.hidden && !r.classList.contains('off'));
    const commit = () => {
      if (!current) return;
      const destDir = current.dataset.dir ?? '';
      closeMovePicker();
      commitMovePicker(keys, destDir);
    };
    /** @param {string} dir @param {number} level */
    const addRows = (dir, level) => {
      const row = document.createElement('div');
      row.className = 'pk-row';
      row.style.setProperty('--lvl', String(level));
      row.dataset.dir = dir;
      row.setAttribute('role', 'option');
      const glyph = document.createElement('span');
      glyph.className = 'fi';
      glyph.innerHTML = FOLDER_SVG;
      row.appendChild(glyph);
      const name = document.createElement('span');
      name.className = 'n';
      name.textContent = dir ? titleOf(dir) : rootName;
      row.appendChild(name);
      const why = dir === fromDir ? 'current' : dirKeys.includes(dir) ? 'this folder' : dirKeys.some((d) => dir.startsWith(`${d}/`)) ? 'inside it' : '';
      if (why) {
        row.classList.add('off');
        row.setAttribute('aria-disabled', 'true');
        const m = document.createElement('span');
        m.className = 'm';
        m.textContent = why;
        row.appendChild(m);
      } else {
        row.addEventListener('click', () => select(row));
        row.addEventListener('dblclick', () => commit());
      }
      tree.appendChild(row);
      rows.push(row);
      for (const child of [...(children.get(dir) ?? [])].sort((a, b) => titleOf(a).localeCompare(titleOf(b), undefined, { numeric: true }))) addRows(child, level + 1);
    };
    const foot = document.createElement('div');
    foot.className = 'pk-foot';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'scribe-library-btn';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => closeMovePicker());
    const move = document.createElement('button');
    move.type = 'button';
    move.className = 'scribe-library-btn primary';
    move.textContent = 'Move';
    move.disabled = true;
    move.addEventListener('click', commit);
    foot.append(cancel, move);
    addRows('', 0);
    panel.appendChild(tree);
    panel.appendChild(foot);
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      for (const r of rows) r.hidden = !!q && !(r.querySelector('.n')?.textContent ?? '').toLowerCase().includes(q);
      if (current?.hidden) select(choices()[0] ?? null);
    });
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMovePicker();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const v = choices();
        if (!v.length) return;
        const i = current ? v.indexOf(current) : -1;
        if (i < 0) select(e.key === 'ArrowDown' ? v[0] : v[v.length - 1]);
        else select(v[(i + (e.key === 'ArrowDown' ? 1 : v.length - 1)) % v.length]);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      }
      // Without this, Ctrl+A in the filter selects every card.
      e.stopPropagation();
    });
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target instanceof Element && e.target.closest('button'))) return;
      e.preventDefault();
      head.classList.add('dragging');
      const dx = e.clientX - panel.offsetLeft;
      const dy = e.clientY - panel.offsetTop;
      /** @param {PointerEvent} ev */
      const onMove = (ev) => {
        panel.style.left = `${ev.clientX - dx}px`;
        panel.style.top = `${ev.clientY - dy}px`;
      };
      const onUp = () => {
        head.classList.remove('dragging');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });
    for (const type of ['pointerdown', 'click', 'dblclick', 'contextmenu']) panel.addEventListener(type, (e) => e.stopPropagation());
    surface.appendChild(panel);
    movePicker = panel;
    const hostRect = surface.getBoundingClientRect();
    const a = anchorElem.getBoundingClientRect();
    let left = a.right - hostRect.left + 8;
    if (left + panel.offsetWidth > hostRect.width - 8) left = a.left - hostRect.left - panel.offsetWidth - 8;
    if (left < 8) left = Math.max(8, hostRect.width - panel.offsetWidth - 8);
    const top = Math.max(8, Math.min(a.top - hostRect.top, hostRect.height - panel.offsetHeight - 8));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    input.focus();
  };

  /** Create a placeholder-named folder in the browsed directory and drop its card straight into rename. */
  const createNewFolder = async () => {
    if (readOnly || !store || !manifest || fsOpBusy || renameEditing) return;
    if (!(await store.ensureWritable())) {
      viewer._showToast(`Couldn't create a folder — editing ${store.root.name} wasn't allowed.`);
      return;
    }
    // A filter or search hides folder cards, so creating one returns to the browse view first.
    if (fullTextResults || filterText) {
      fullTextResults = null;
      filterText = '';
      searchInput.value = '';
      searchField.classList.remove('has-text', 'hint-yield');
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
    if (storageOpen) {
      // The browser's menu stays available only for copying selected text.
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) e.preventDefault();
      return;
    }
    if (viewMode !== 'grid' || fullTextResults || filterText.trim()) return;
    if (readOnly || !store || !manifest || fsOpBusy || renameEditing) return;
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
    const host = splitForm() ? mountSplit('list') : body;
    const head = document.createElement('div');
    head.className = comfortable ? 'scribe-library-lhead cols-cf' : 'scribe-library-lhead';
    const rows = document.createElement('div');
    rows.dataset.band = 'rows';
    const cols = LIST_COLUMNS[viewMode];
    // Only a mode the user has resized is written, so the other keeps re-fitting Name to the window on later visits.
    const saveCols = () => {
      if (!persistPrefs) return;
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
      for (const row of rows.querySelectorAll(':scope > .scribe-library-row')) {
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
        // Each column is fitted to its widest cell, the header among them, so an arrow only the sorted column carries would move the tracks on every sort.
        const ar = document.createElement('span');
        const on = sortMode === key;
        ar.className = on ? 'ar' : 'ar ghost';
        ar.textContent = on && sortDir === -1 ? '▼' : '▲';
        if (on) cell.className = 'on';
        cell.appendChild(ar);
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
        for (const row of rows.querySelectorAll(':scope > .scribe-library-row')) {
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
    for (const item of listItems(shownDirs, shown, shownOthers)) rows.appendChild(buildListItem(item));
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
    listColsRefit = () => {
      // An in-place row sync can change a column's content under the retained header, so the cached fits go stale.
      colFits = null;
      projectCols(availCols());
      settleColsIfGrown();
    };
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
    if (splitForm()) {
      const entry = listPreviewPath && manifest ? manifest.docs[listPreviewPath] : null;
      if (entry && listPreviewPath) {
        showListPreview(listPreviewPath, entry, Math.min(listPreviewPage, (entry.pageCount || 1) - 1));
      } else if (listPreviewPath && shownOthers.includes(listPreviewPath)) {
        showOtherPreview(listPreviewPath);
      } else {
        listPreviewPath = null;
      }
    }
    return host;
  };

  /**
   * Show a document as the list view's preview, remembering the spot across re-renders.
   * @param {string} relPath
   * @param {import('./libraryStore.js').LibraryDocEntry} entry
   * @param {number} pageN
   */
  const showListPreview = (relPath, entry, pageN) => {
    if (!splitForm()) return;
    listPreviewPath = relPath;
    listPreviewPage = pageN;
    preview.show({
      relPath,
      hash: entry.hash,
      entry,
      pageN,
      query: null,
      title: titleOf(relPath),
      jump: true,
    });
  };

  /**
   * Show a non-PDF file's plate in the pane, with its name, its kind and the one thing Scribe can do with it.
   * @param {string} relPath
   */
  const showOtherPreview = (relPath) => {
    if (!splitForm()) return;
    listPreviewPath = relPath;
    listPreviewPage = 0;
    const name = relPath.split('/').pop() || relPath;
    const dot = name.lastIndexOf('.');
    preview.showEmpty();
    showPlate({
      title: name,
      badge: dot > 0 ? name.slice(dot + 1).toUpperCase() : 'FILE',
      icon: FILE_SVG,
      note: 'Not a PDF — Scribe can’t open it',
      action: 'Save a copy…',
      onAction: () => saveCopies([relPath]),
    });
  };

  // --- Opening documents --------------------------------------------------

  /**
   * Route every document mutation through a dirty mark so checkpoint saves know the document's owner has edits.
   * @param {import('../../js/containers/scribeDoc.js').ScribeDoc} doc
   * @param {{libraryDirty?: boolean, libraryRecognized?: boolean}} target - The tab or preview record that owns the document's dirty state.
   */
  const wrapMutators = (doc, target) => {
    const d = /** @type {any} */ (doc);
    // The owner can change hands, a preview's record giving way to its tab, so the wrappers read it from the document at call time.
    d._libraryDirtyTarget = target;
    if (d._libraryMutatorsWrapped) return;
    d._libraryMutatorsWrapped = true;
    for (const name of MUTATOR_METHODS) {
      const orig = d[name];
      if (typeof orig !== 'function') continue;
      d[name] = function markDirtyWrap(...args) {
        if (d._libraryDirtyTarget) d._libraryDirtyTarget.libraryDirty = true;
        const result = orig.apply(this, args);
        // A completed recognition is what the next checkpoint stamps as the document's recognition state.
        if (name === 'recognize') Promise.resolve(result).then(() => { if (d._libraryDirtyTarget) d._libraryDirtyTarget.libraryRecognized = true; }).catch(() => {});
        return result;
      };
    }
  };

  /** Hashes (or paths, for legacy entries) with an open in flight, so a click storm during a slow load cannot stack duplicate imports. */
  const openingDocs = new Set();

  /**
   * @param {string} relPath
   * @param {import('./libraryStore.js').LibraryDocEntry} entry
   * @param {{pageN?: number, query?: string, background?: boolean}} [target] - `background` opens the tab without activating it.
   */
  const openEntry = async (relPath, entry, target = {}) => {
    if (!store || !manifest) return;
    const openKey = entry.hash || relPath;
    if (openingDocs.has(openKey)) return;
    openingDocs.add(openKey);
    /** Open the viewer's find bar on the query, landing on its first match on the opened page. */
    const continueFind = async () => {
      const bar = viewer._searchBar;
      if (!target.query || !bar) return;
      bar.searchInputElem.value = '';
      await bar.openSearch();
      bar.searchInputElem.value = target.query;
      await bar.runSearch(target.query, target.pageN);
    };
    // A document opened from the pane is read with its own pages beside it.
    const fromPane = visible && splitForm();
    const afterOpen = () => {
      if (fromPane && !target.background && !viewer._phoneUi && !viewer._activeSidebar) viewer.showSidebarNow('thumbnails');
    };
    try {
      if (entry.portfolio) {
        // A portfolio opens as its own pinned surface, never as a page tab.
        // The file is read plain, with no sidecar and no seed.
        entry.lastOpened = Date.now();
        saveManifestSoon();
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
        /** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
        let doc;
        preview.beginUserLoad();
        try {
          doc = await scribeLib.openDocument([pdfFile], { deferText: true });
        } catch (err) {
          viewer._showToast(`Couldn't open “${titleOf(relPath)}” — ${err instanceof Error ? err.message : 'the file could not be loaded'}.`);
          return;
        } finally {
          preview.endUserLoad();
        }
        await viewer._openPortfolio(doc, titleOf(relPath), { libraryHash: entry.hash, libraryRelPath: relPath, libraryOwner: instanceId });
        return;
      }
      const openIdx = entry.hash ? viewer._tabs.findIndex((t) => t.libraryHash === entry.hash && ownsTab(t)) : -1;
      if (openIdx >= 0) {
        entry.lastOpened = Date.now();
        saveManifestSoon();
        // The tab's document on screen as the preview stays where the reader is; any other lands on the asked page.
        const onScreen = viewer._tabs[openIdx].doc === viewer.doc;
        const morph = onScreen && fromPane;
        if (morph) morphPending = true;
        await viewer._activateTab(openIdx);
        if (morph) {
          await morphOut();
          return;
        }
        if (!onScreen) {
          if (target.pageN != null) await viewer.scribe.displayPage(target.pageN, true, false);
          await continueFind();
        }
        afterOpen();
        return;
      }
      // The library's own preview on screen becomes a tab as it stands, with nothing reloaded.
      const shown = preview.lastTarget();
      if (!target.background && shown && shown.relPath === relPath && viewer.doc && preview.owns(viewer.doc)) {
        morphPending = true;
        const tab = preview.pin(titleOf(relPath), { libraryOwner: instanceId, libraryHash: entry.hash, libraryRelPath: relPath });
        if (tab) {
          entry.lastOpened = Date.now();
          saveManifestSoon();
          preview.persistRasterWindow(tab.doc, entry, viewer.scribe.state.cp.n);
          await morphOut();
          return;
        }
        morphPending = false;
      }
      // The copy a recognition run holds counts as the live copy, so opening mid-run shows its text arriving rather than a second copy.
      const pooled = entry.hash ? (ingest?.adoptRecognizing(entry.hash) ?? sessions.takeLive(entry.hash)) : null;
      if (pooled) {
        entry.lastOpened = Date.now();
        saveManifestSoon();
        const tab = await viewer._openDocAsTab(pooled, titleOf(relPath), {
          libraryOwner: instanceId, libraryHash: entry.hash, libraryRelPath: relPath, lastPage: target.pageN ?? 0, activate: !target.background,
        });
        wrapMutators(pooled, tab);
        preview.persistRasterWindow(pooled, entry, target.pageN ?? 0);
        if (!target.background) await continueFind();
        afterOpen();
        return;
      }
      // Stored page dims, rasters, and sidecar pages paint immediately while the real document hydrates behind them.
      // With no raster for the landing page a seed could only paint blank pages, so the plain open below runs instead.
      // The tab also exists from the first click, so repeats activate it instead of starting another import.
      if (!target.background && entry.pageDims && await store.readPageRaster(entry.hash, target.pageN ?? 0)) {
        entry.lastOpened = Date.now();
        saveManifestSoon();
        const seed = await preview.makeSeed(relPath, entry, target.pageN ?? 0);
        preview.beginUserLoad();
        const t0 = performance.now();
        /** @type {{primed: Promise<void>, hydrated: Promise<void>, cancel: () => void}} */
        let handle;
        try {
          handle = await viewer.openProvisional({ ...seed, hydration: 'eager' });
        } catch (err) {
          preview.endUserLoad();
          throw err;
        }
        handle.hydrated.catch(() => {}).finally(preview.endUserLoad);
        const tab = viewer._tabs[viewer._activeTab];
        tab.libraryOwner = instanceId;
        tab.libraryHash = entry.hash;
        tab.libraryRelPath = relPath;
        // At adoption time rather than on `hydrated`, so no edit can slip between the swap and dirty tracking.
        tab.onDocHydrated = (d) => wrapMutators(d, tab);
        if (target.query && viewer._searchBar) {
          viewer._searchBar.openSearch();
          viewer._searchBar.searchInputElem.value = target.query;
        }
        afterOpen();
        handle.hydrated.then(() => {
          // This hydration ran from a cold open, so open-to-swap is a first paint.
          entry.firstPaintMs = Math.round(performance.now() - t0);
          saveManifestSoon();
          preview.persistRasterWindow(tab.doc, entry, target.pageN ?? 0);
          // The swap re-attaches the document, and attaching resets the find bar, so the query primes again here, on the full document's matches.
          continueFind();
        }).catch(() => {});
        return;
      }
      /** @type {File} */
      let pdfFile;
      const t0 = performance.now();
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
      preview.beginUserLoad();
      try {
        doc = await scribeLib.openDocument(files, { deferText: true });
      } catch (err) {
        viewer._showToast(`Couldn't open “${titleOf(relPath)}” — ${err instanceof Error ? err.message : 'the file could not be loaded'}.`);
        return;
      } finally {
        preview.endUserLoad();
      }
      if (doc.attachments.collection) {
        // An entry indexed before the library recorded portfolios shows its nature only now, so the manifest catches up here.
        entry.portfolio = true;
        entry.lastOpened = Date.now();
        saveManifestSoon();
        await viewer._openPortfolio(doc, titleOf(relPath), { libraryHash: entry.hash, libraryRelPath: relPath, libraryOwner: instanceId });
        return;
      }
      entry.lastOpened = Date.now();
      saveManifestSoon();
      // Opening straight at the target page, since a `lastPage: 0` open followed by a jump would visibly double-paint.
      const tab = await viewer._openDocAsTab(doc, titleOf(relPath), {
        libraryOwner: instanceId, libraryHash: entry.hash, libraryRelPath: relPath, lastPage: target.pageN ?? 0, activate: !target.background,
      });
      entry.firstPaintMs = Math.round(performance.now() - t0);
      saveManifestSoon();
      wrapMutators(doc, tab);
      preview.persistRasterWindow(doc, entry, target.pageN ?? 0);
      if (!target.background) await continueFind();
      afterOpen();
    } finally {
      openingDocs.delete(openKey);
    }
  };

  // --- Revert to original -------------------------------------------------

  /**
   * Show the card's transient post-revert line for `ms`, then restore the normal meta line.
   * @param {string} relPath
   * @param {'reverted'|'restored'} phase
   * @param {number} ms
   */
  const showRevertFeedback = (relPath, phase, ms) => {
    if (revertFeedbackTimer !== null) window.clearTimeout(revertFeedbackTimer);
    revertFeedback = { relPath, phase };
    render();
    revertFeedbackTimer = window.setTimeout(() => {
      revertFeedbackTimer = null;
      revertFeedback = null;
      render();
    }, ms);
  };

  /** Close every viewer tab holding `hash` without a checkpoint, so its edits cannot be written back over the sidecar. */
  const closeTabsFor = (/** @type {string} */ hash) => {
    for (let i = viewer._tabs.length - 1; i >= 0; i--) {
      const tab = viewer._tabs[i];
      if (tab.libraryHash !== hash || !ownsTab(tab)) continue;
      tab.libraryDirty = false;
      viewer._closeTab(i);
    }
    if (preview.shownHash() === hash) clearPreview();
    sessions.invalidate(hash);
  };

  /**
   * Put the document back to the file as it was imported.
   * The old sidecar goes to its one undo slot first, so the feedback line can offer an undo.
   * @param {string} relPath
   */
  const runRevert = async (relPath) => {
    const entry = manifest?.docs[relPath];
    if (!store || !ingest || !entry || !entry.hash) return;
    await store.backupSidecar(entry.hash);
    closeTabsFor(entry.hash);
    revertUndo = {
      relPath, hash: entry.hash, editedAt: entry.editedAt, recognizedAt: entry.recognizedAt, phase: 'reverting',
    };
    await ingest.enqueue(relPath, {}, { resetSidecar: true });
    render();
    ingest.start();
  };

  /** Restore the backed-up sidecar and rebuild the derived data from it. */
  const undoRevert = async () => {
    if (!store || !ingest || !manifest || !revertUndo || revertUndo.phase !== 'reverted') return;
    const {
      relPath, hash, editedAt, recognizedAt,
    } = revertUndo;
    const entry = manifest.docs[relPath];
    if (!entry || entry.hash !== hash) return;
    if (!(await store.restoreSidecarBackup(hash))) return;
    closeTabsFor(hash);
    if (editedAt) entry.editedAt = editedAt;
    if (recognizedAt) entry.recognizedAt = recognizedAt;
    revertUndo.phase = 'restoring';
    if (revertFeedbackTimer !== null) {
      window.clearTimeout(revertFeedbackTimer);
      revertFeedbackTimer = null;
    }
    revertFeedback = null;
    await ingest.enqueue(relPath);
    render();
    ingest.start();
  };

  /** @type {?HTMLElement} */
  let confirmScrim = null;
  /** @type {?() => void} */
  let confirmClose = null;

  /** @param {number} n */
  const fmtBytes = (n) => (n >= 1024 * 1024 * 1024 ? `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
    : n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB`
      : `${n ? Math.max(1, Math.round(n / 1024)) : 0} KB`);

  /**
   * A confirmation dialog for deleting the library's own data.
   * @param {{title: string, name: string, meta: string, intro: string, items: string[], note: string, confirmLabel: string, keep?: string, host?: HTMLElement}} spec
   *   A `keep` label adds a checkbox under the list.
   *   `host` is the element the scrim covers, the library surface by default.
   * @returns {Promise<?{keep: boolean}>} Null when the dialog was dismissed.
   */
  const openStorageConfirm = (spec) => new Promise((resolve) => {
    confirmClose?.();
    const scrim = document.createElement('div');
    scrim.className = 'scribe-library-confirm-scrim';
    const dlg = document.createElement('div');
    dlg.className = 'scribe-library-confirm';
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    const ttl = document.createElement('div');
    ttl.className = 'ttl';
    ttl.id = 'scribe-library-confirm-title';
    ttl.textContent = spec.title;
    dlg.setAttribute('aria-labelledby', ttl.id);
    const id = document.createElement('div');
    id.className = 'id';
    const glyph = document.createElement('span');
    glyph.className = 'fth';
    glyph.innerHTML = FOLDER_SVG;
    const idText = document.createElement('div');
    const n = document.createElement('div');
    n.className = 'n';
    n.textContent = spec.name;
    const m = document.createElement('div');
    m.className = 'm';
    m.textContent = spec.meta;
    idText.append(n, m);
    id.append(glyph, idText);
    const intro = document.createElement('div');
    intro.textContent = spec.intro;
    const list = document.createElement('ul');
    for (const text of spec.items) {
      const li = document.createElement('li');
      li.textContent = text;
      list.appendChild(li);
    }
    /** @type {?HTMLInputElement} */
    let keepBox = null;
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = spec.note;
    const foot = document.createElement('div');
    foot.className = 'foot';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'danger';
    confirm.textContent = spec.confirmLabel;
    foot.append(cancel, confirm);
    dlg.append(ttl, id, intro, list);
    if (spec.keep) {
      const label = document.createElement('label');
      label.className = 'chk';
      keepBox = document.createElement('input');
      keepBox.type = 'checkbox';
      const text = document.createElement('span');
      text.textContent = spec.keep;
      label.append(keepBox, text);
      dlg.appendChild(label);
    }
    dlg.append(note, foot);
    scrim.appendChild(dlg);
    (spec.host ?? surface).appendChild(scrim);
    confirmScrim = scrim;
    /** @param {?{keep: boolean}} result */
    const close = (result) => {
      scrim.remove();
      document.removeEventListener('keydown', onKey, true);
      if (confirmScrim === scrim) {
        confirmScrim = null;
        confirmClose = null;
      }
      resolve(result);
    };
    confirmClose = () => close(null);
    /** @param {KeyboardEvent} e */
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(null);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        const order = /** @type {HTMLElement[]} */ ([keepBox, cancel, confirm].filter((el) => el));
        const at = order.indexOf(/** @type {HTMLElement} */ (document.activeElement));
        order[(at + (e.shiftKey ? -1 : 1) + order.length) % order.length]?.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    scrim.addEventListener('pointerdown', (e) => {
      if (e.target === scrim) close(null);
    });
    cancel.addEventListener('click', () => close(null));
    confirm.addEventListener('click', () => close({ keep: !!keepBox?.checked }));
    cancel.focus();
  });

  const notesWhere = () => (store?.notesBeside ? 'beside the documents' : 'in this app');

  const openStorage = () => {
    if (!store) return;
    const s = store;
    storageOpen = true;
    storageSizes = null;
    if (!visible) activate({ render: false });
    render();
    s.measure().then((sizes) => {
      if (store !== s || !storageOpen) return;
      storageSizes = sizes;
      render();
    }).catch(() => { });
  };
  const closeStorage = () => {
    storageOpen = false;
    render();
  };

  const deleteAllNotes = async () => {
    if (!store || !manifest || !ingest) return;
    const s = store;
    const name = s.root.name;
    const sizes = storageSizes ?? await s.measure();
    const docs = Object.keys(manifest.docs).length;
    const edited = Object.values(manifest.docs).filter((e) => e.editedAt).length;
    const choice = await openStorageConfirm({
      title: 'Delete all notes and edits?',
      name,
      meta: `${docs} document${docs === 1 ? '' : 's'} · ${edited} with notes or edits, kept ${notesWhere()}`,
      intro: 'This discards the saved work for every document in the folder:',
      items: [`Notes, edits and recognized text for ${edited} document${edited === 1 ? '' : 's'} (${fmtBytes(sizes.notes)})`],
      note: s.notesBeside
        ? 'The index and previews in this app are kept; the PDF files are not changed. This cannot be undone.'
        : `The index and previews are kept; nothing in ${name} is changed. This cannot be undone.`,
      confirmLabel: 'Delete notes and edits',
    });
    if (!choice || store !== s || !manifest || !ingest) return;
    for (const entry of Object.values(manifest.docs)) if (entry.hash) closeTabsFor(entry.hash);
    await forgetDocs(Object.keys(manifest.docs));
    storageOpen = false;
    storageSizes = null;
    await ingest.scan();
    render();
    ingest.start();
  };

  const deleteLibraryData = async () => {
    if (!store || !manifest) return;
    const s = store;
    const name = s.root.name;
    const sizes = storageSizes ?? await s.measure();
    const docs = Object.keys(manifest.docs).length;
    const edited = Object.values(manifest.docs).filter((e) => e.editedAt).length;
    const beside = !!s.notesBeside;
    const plural = (/** @type {number} */ count) => (count === 1 ? '' : 's');
    const inApp = sizes.previews + sizes.index + (beside ? 0 : sizes.notes);
    const items = [`Page previews, thumbnails and the search index (${fmtBytes(sizes.previews + sizes.index)})`];
    if (beside) items.push(`The hidden .scribe folder inside ${name}${edited ? `, holding notes, edits and recognized text for ${edited} document${plural(edited)}` : ''} (${fmtBytes(sizes.notes)})`);
    else if (edited) items.push(`Notes, edits and recognized text for ${edited} document${plural(edited)} (${fmtBytes(sizes.notes)})`);
    items.push('Its place in the Recent list');
    const touchesFolder = beside;
    const choice = await openStorageConfirm({
      title: `Delete library data for ${name}?`,
      name,
      meta: beside
        ? `${docs} document${plural(docs)} · ${fmtBytes(inApp)} in this app, ${fmtBytes(sizes.notes)} of notes beside the documents`
        : `${docs} document${plural(docs)} · ${fmtBytes(inApp)} in this app`,
      intro: 'This deletes everything this app keeps for the folder:',
      items,
      keep: edited ? `Keep notes and edits (${edited} document${plural(edited)}, ${fmtBytes(sizes.notes)}${beside ? ', beside the documents' : ''})` : undefined,
      note: touchesFolder ? 'The PDF files are not changed. This cannot be undone.' : `Nothing in ${name} is changed. This cannot be undone.`,
      confirmLabel: 'Delete library data',
    });
    if (!choice || store !== s || !manifest) return;
    if (choice.keep) {
      ingest?.cancel();
      preview.destroy();
      sessions.reset();
      await s.deleteCaches();
      await engine.reset().catch(() => {});
      storageOpen = false;
      storageSizes = null;
      await rebuildIndex();
      return;
    }
    // Asked before the folder closes, while the confirmation's click still counts as a user gesture.
    if (touchesFolder && !(await s.ensureWritable())) viewer._showToast(`Editing ${name} wasn't allowed, so its .scribe folder stays.`);
    const handle = s.root;
    discardOnClose = true;
    try {
      await closeFolder();
    } finally {
      discardOnClose = false;
    }
    await s.deleteAll();
    await LibraryStore.forgetFolder(handle);
    recentFolders = await LibraryStore.recentFolders();
    publishFolders();
    viewer._showToast(`Deleted library data for ${name}.`);
  };

  const buildStorageSheet = () => {
    const s = /** @type {LibraryStore} */ (store);
    const name = s.root.name;
    const sizes = storageSizes;
    const docs = manifest ? Object.keys(manifest.docs).length : 0;
    const edited = manifest ? Object.values(manifest.docs).filter((e) => e.editedAt).length : 0;
    const sheet = document.createElement('div');
    sheet.className = 'scribe-library-storage';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'back';
    back.innerHTML = `${BACK_SVG}<span></span>`;
    /** @type {HTMLElement} */ (back.querySelector('span')).textContent = `Back to ${name}`;
    back.addEventListener('click', closeStorage);
    const heading = document.createElement('h3');
    heading.textContent = 'Library storage';
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = `What this app keeps for ${name}. The PDF files themselves are never touched.`;
    sheet.append(back, heading, sub);
    /**
     * @param {string} label @param {string} detail @param {number} bytes @param {string} action @param {() => void} onAct @param {boolean} [danger]
     */
    const row = (label, detail, bytes, action, onAct, danger = false) => {
      const el = document.createElement('div');
      el.className = 'row';
      const text = document.createElement('div');
      const l = document.createElement('div');
      l.className = 'l';
      l.textContent = label;
      const d = document.createElement('div');
      d.className = 'd';
      d.textContent = detail;
      text.append(l, d);
      const size = document.createElement('div');
      size.className = 'sz';
      size.textContent = sizes ? fmtBytes(bytes) : 'Measuring…';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = danger ? 'act danger' : 'act';
      btn.textContent = action;
      btn.disabled = !sizes || !bytes;
      btn.addEventListener('click', onAct);
      el.append(text, size, btn);
      sheet.appendChild(el);
    };
    row('Page previews', 'Rendered pages, kept so documents open at once. Rendered again as pages are viewed.', sizes?.previews ?? 0, 'Clear', async () => {
      await s.clearPreviews();
      storageSizes = await s.measure();
      if (store === s && storageOpen) render();
    });
    row('Search index and thumbnails', 'Rebuilt from the documents and their notes.', sizes?.index ?? 0, 'Rebuild', () => {
      closeStorage();
      rebuildIndex();
    });
    row('Notes, edits and recognized text', edited
      ? `${edited} of ${docs} document${docs === 1 ? '' : 's'} ${edited === 1 ? 'has' : 'have'} saved work, which cannot be regenerated. Kept ${notesWhere()}.`
      : `No document has saved work. Kept ${notesWhere()}.`, sizes?.notes ?? 0, 'Delete…', deleteAllNotes, true);
    const loc = document.createElement('div');
    loc.className = 'loc';
    const lt = document.createElement('div');
    lt.className = 'lt';
    lt.textContent = `Where this app keeps your notes for ${name}`;
    loc.appendChild(lt);
    const radioName = `scribe-library-notes-${instanceId}`;
    const current = s.notesBeside ? 'beside' : 'app';
    /** @type {HTMLInputElement[]} */
    const radios = [];
    /** @param {'app'|'beside'} value @param {string} label @param {string} detail */
    const option = (value, label, detail) => {
      const el = document.createElement('label');
      el.className = 'opt';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = radioName;
      input.value = value;
      input.checked = value === current;
      const text = document.createElement('span');
      const ol = document.createElement('div');
      ol.className = 'ol';
      ol.textContent = label;
      const od = document.createElement('div');
      od.className = 'od';
      od.textContent = detail;
      text.append(ol, od);
      el.append(input, text);
      radios.push(input);
      loc.appendChild(el);
    };
    option('app', 'In this app', `Nothing is written into ${name}. Notes stay on this computer, in this app.`);
    option('beside', 'Beside the documents', `A hidden .scribe folder inside ${name} holds your notes, so they travel with the folder. Previews and the index stay in this app.${shell ? '' : ' The browser will ask for permission to edit the folder.'}`);
    const mv = document.createElement('div');
    mv.className = 'mv';
    mv.hidden = true;
    const mvText = document.createElement('span');
    const mvCancel = document.createElement('button');
    mvCancel.type = 'button';
    mvCancel.className = 'act';
    mvCancel.textContent = 'Cancel';
    const mvGo = document.createElement('button');
    mvGo.type = 'button';
    mvGo.className = 'act primary';
    mvGo.textContent = 'Move';
    mv.append(mvText, mvCancel, mvGo);
    loc.appendChild(mv);
    const chosen = () => (radios.find((r) => r.checked)?.value === 'beside' ? 'beside' : 'app');
    const resetChoice = () => {
      for (const r of radios) r.checked = r.value === current;
      mv.hidden = true;
    };
    for (const r of radios) {
      r.addEventListener('change', () => {
        if (chosen() === current) {
          mv.hidden = true;
          return;
        }
        mvText.textContent = `Move ${sizes ? fmtBytes(sizes.notes) : 'the'} notes ${chosen() === 'beside' ? 'beside the documents' : 'into this app'}?`;
        mv.hidden = false;
      });
    }
    mvCancel.addEventListener('click', resetChoice);
    mvGo.addEventListener('click', async () => {
      const beside = chosen() === 'beside';
      if (beside && !(await s.ensureWritable())) {
        viewer._showToast(`Couldn't move the notes — editing ${name} wasn't allowed.`);
        resetChoice();
        return;
      }
      mvGo.disabled = true;
      try {
        await s.setNotesBeside(beside);
        sessions.reset();
      } catch (err) {
        viewer._showToast(`Couldn't move the notes — ${err instanceof Error ? err.message.replace(/\.$/, '') : 'the files could not be moved'}.`);
      }
      storageSizes = await s.measure();
      if (store === s && storageOpen) render();
    });
    const foot = document.createElement('div');
    foot.className = 'foot';
    const tot = document.createElement('span');
    tot.className = 'tot';
    tot.textContent = sizes ? `${fmtBytes(sizes.previews + sizes.index + sizes.notes)} in all` : 'Measuring…';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'act danger';
    del.textContent = 'Delete Library Data…';
    del.disabled = !sizes;
    del.addEventListener('click', deleteLibraryData);
    foot.append(tot, del);
    sheet.append(loc, foot);
    return sheet;
  };

  /**
   * The revert confirmation: who the document is, what will be discarded, and that the file itself is untouched.
   * @param {string} relPath
   */
  const openRevertDialog = (relPath) => {
    const entry = manifest?.docs[relPath];
    if (!store || !entry || !entry.hash) return;
    confirmClose?.();
    const scrim = document.createElement('div');
    scrim.className = 'scribe-library-confirm-scrim';
    const dlg = document.createElement('div');
    dlg.className = 'scribe-library-confirm';
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    const ttl = document.createElement('div');
    ttl.className = 'ttl';
    ttl.id = 'scribe-library-confirm-title';
    ttl.textContent = 'Revert to original?';
    dlg.setAttribute('aria-labelledby', ttl.id);
    const id = document.createElement('div');
    id.className = 'id';
    const img = document.createElement('img');
    img.alt = '';
    setThumbSrc(img, entry);
    const idText = document.createElement('div');
    const n = document.createElement('div');
    n.className = 'n';
    n.textContent = titleOf(relPath);
    const m = document.createElement('div');
    m.className = 'm';
    /** @param {number} ts */
    const fmt = (ts) => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const bits = [];
    if (entry.pageCount) bits.push(`${entry.pageCount} page${entry.pageCount === 1 ? '' : 's'}`);
    if (entry.added) bits.push(`added ${fmt(entry.added)}`);
    if (entry.editedAt) bits.push(`last edited ${fmt(entry.editedAt)}`);
    m.textContent = bits.join(' · ');
    idText.append(n, m);
    id.append(img, idText);
    const bodyText = document.createElement('div');
    bodyText.textContent = 'This puts the document back to the file as it was imported. Everything added since is discarded:';
    const list = document.createElement('ul');
    /** @param {string} text */
    const li = (text) => {
      const el = document.createElement('li');
      el.textContent = text;
      list.appendChild(el);
      return el;
    };
    if (entry.recognizedAt) li(`Recognized text (recognition ran ${fmt(entry.recognizedAt)})`);
    const countLine = li('Counting annotations…');
    li('Text edits, page changes, form entries, and bookmarks');
    const note = document.createElement('div');
    note.className = 'note';
    const openTab = viewer._tabs.some((tab) => tab.libraryHash === entry.hash && ownsTab(tab));
    note.textContent = `The PDF file in your folder is not changed. You can undo this right afterward.${openTab ? ' Its open tab will close.' : ''}`;
    const foot = document.createElement('div');
    foot.className = 'foot';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'danger';
    confirm.textContent = 'Revert document';
    foot.append(cancel, confirm);
    dlg.append(ttl, id, bodyText, list, note, foot);
    scrim.appendChild(dlg);
    surface.appendChild(scrim);
    confirmScrim = scrim;
    let token = 0;
    const close = () => {
      token++;
      scrim.remove();
      document.removeEventListener('keydown', onKey, true);
      if (confirmScrim === scrim) {
        confirmScrim = null;
        confirmClose = null;
      }
    };
    confirmClose = close;
    /** @param {KeyboardEvent} e */
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        (document.activeElement === cancel ? confirm : cancel).focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    scrim.addEventListener('pointerdown', (e) => {
      if (e.target === scrim) close();
    });
    cancel.addEventListener('click', close);
    confirm.addEventListener('click', () => {
      close();
      runRevert(relPath);
    });
    cancel.focus();

    const myToken = token;
    const hash = entry.hash;
    const openTabDoc = viewer._tabs.find((tab) => tab.libraryHash === hash && ownsTab(tab))?.doc;
    const docPromise = openTabDoc ? Promise.resolve(openTabDoc)
      : sessions.liveDocOrLoad(hash, async () => {
        const files = [await store.readFile(relPath)];
        const sidecar = await store.readSidecar(hash);
        if (sidecar) files.push(new File([sidecar], `${hash}.scribe`));
        return scribeLib.openDocument(files, { deferText: true, skipFontOpt: true, pdfWorkerN: 1 });
      });
    docPromise.then((doc) => {
      if (myToken !== token) return;
      // A text markup or redaction is stored as one row per word or quad, all sharing a groupId, so it counts once per group.
      const seenGroups = new Set();
      let count = 0;
      (/** @type {any} */ (doc).annotations?.pages || []).forEach((/** @type {any[]} */ pg, /** @type {number} */ i) => {
        for (const a of pg || []) {
          const kind = a.type || 'highlight';
          if (kind !== 'redact' && !TEXT_MARKUP_ANNOT_TYPES.has(kind)) {
            count++;
            continue;
          }
          const key = a.groupId ? `${i}|${kind}|${a.groupId}` : `${i}|${kind}|bbox:${a.bbox?.left}:${a.bbox?.top}:${a.bbox?.right}:${a.bbox?.bottom}`;
          if (seenGroups.has(key)) continue;
          seenGroups.add(key);
          count++;
        }
      });
      if (count > 0) countLine.textContent = `${count} annotation${count === 1 ? '' : 's'} (highlights, notes, shapes, redactions)`;
      else countLine.remove();
    }).catch(() => {
      if (myToken === token) countLine.remove();
    });
  };

  // --- Subsystems ---------------------------------------------------------

  // Constructed here rather than beside their first use, because they capture `render`, `openCardMenu`, and `openEntry` by value.
  const preview = createPreview({
    viewer,
    sessions,
    getStore: () => store,
    getManifest: () => manifest,
    onRastersStored: () => results.repump(),
    onSidecarSaved: (hash, doc) => { afterSidecarSaved(hash, doc, false); },
    saveManifestSoon,
    ensureLit,
    onState: (kind, text) => setStage(kind, text),
    trackEdits: wrapMutators,
  });

  const results = createResultsView({
    host: () => (splitForm() && splitLeft ? splitLeft : body),
    sessions,
    preview,
    selectOpens: () => !splitForm(),
    getStore: () => store,
    getManifest: () => manifest,
    getResults: () => /** @type {Array<{hash: string, pages: number[]}>} */ (fullTextResults),
    getQuery: () => fullTextQuery,
    getEngine: () => engine,
    getEngineResponse: () => engineResponse,
    getEngineTiers: () => engineTiers,
    getEngineError: () => engineError,
    openEntry,
    saveManifestSoon,
    onBack: () => {
      fullTextResults = null;
      searchInput.value = '';
      searchField.classList.remove('has-text', 'hint-yield');
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
    saveManifestSoon,
    render,
    openCardMenu,
    dragAllowed: () => !readOnly && !fullTextResults && !filterText.trim() && !fsOpBusy,
    reorderAllowed: () => sortMode === 'custom' && viewMode === 'grid',
    previewFolder,
    unpreviewFolder: (elem, dirPath) => (elem.classList.contains('scribe-library-card') ? updateFolderCard : updateFolderRow)(elem, dirPath),
    startLanding,
    moveItems,
    foldFor: (dirPath, mini) => buildFold(dirStatsOf(dirPath).covers, mini),
    finishLanding,
  });

  // --- Ingest wiring ------------------------------------------------------

  /** @type {FileSystemDirectoryHandle[]} */
  let recentFolders = [];
  const publishFolders = () => {
    if (!isLibrary) return;
    // A folder open in another window heads the list, so the way to that window is always in sight.
    const held = (/** @type {FileSystemDirectoryHandle} */ h) => Number(viewer._foldersOpenElsewhere.includes(h.name));
    const ordered = [...recentFolders].sort((a, b) => held(b) - held(a));
    viewer._recents.setFolders(ordered.map((h) => ({
      kind: 'folder',
      label: h.name,
      dir: folderDirs.get(h.name) ?? '',
      open: () => openRecentFolder(h),
      // The open folder's data is in use, so only Library Storage deletes it.
      remove: async () => {
        const rec = await LibraryStore.recordFor(h);
        if (rec?.id && !(store && await sameEntry(store.root, h))) await LibraryStore.deleteAppData(rec.id);
        await LibraryStore.forgetFolder(h);
        recentFolders = await LibraryStore.recentFolders();
        publishFolders();
      },
      confirm: async () => {
        const rec = await LibraryStore.recordFor(h);
        // Notes kept beside the documents stay in the folder, so forgetting it loses only caches.
        if (!rec?.id || rec.notesBeside || (store && await sameEntry(store.root, h))) return true;
        const counts = await LibraryStore.countsIn(rec.id);
        if (!counts.edited) return true;
        return !!(await openStorageConfirm({
          title: `Forget ${h.name}?`,
          name: h.name,
          meta: `${counts.docs} document${counts.docs === 1 ? '' : 's'} · notes or edits for ${counts.edited}`,
          intro: 'This removes the folder from Recent and deletes what this app keeps for it:',
          items: ['Page previews, thumbnails and the search index', `Notes, edits and recognized text for ${counts.edited} document${counts.edited === 1 ? '' : 's'}`],
          note: `Nothing in ${h.name} is changed. This cannot be undone.`,
          confirmLabel: 'Forget folder',
          host: visible ? surface : viewer.pdfViewerElem,
        }));
      },
    })), async () => {
      const records = await LibraryStore.recentRecords();
      /** @type {string[]} */
      const names = [];
      let edited = 0;
      for (const r of records) {
        if (!r.id || r.notesBeside || (store && await sameEntry(store.root, r.handle))) continue;
        const counts = await LibraryStore.countsIn(r.id);
        if (!counts.edited) continue;
        edited += counts.edited;
        names.push(r.handle.name);
      }
      if (edited) {
        const ok = await openStorageConfirm({
          title: 'Clear the Recent list?',
          name: names.join(', '),
          meta: `notes or edits for ${edited} document${edited === 1 ? '' : 's'} in ${names.length} folder${names.length === 1 ? '' : 's'}`,
          intro: 'This forgets every listed folder and deletes what this app keeps for them:',
          items: ['Page previews, thumbnails and search indexes', `Notes, edits and recognized text for ${edited} document${edited === 1 ? '' : 's'}`],
          note: 'The folders themselves are not changed. This cannot be undone.',
          confirmLabel: 'Clear and delete',
          host: visible ? surface : viewer.pdfViewerElem,
        });
        if (!ok) return;
      }
      for (const r of records) {
        if (store && await sameEntry(store.root, r.handle)) continue;
        if (r.id) await LibraryStore.deleteAppData(r.id);
        await LibraryStore.forgetFolder(r.handle);
      }
      recentFolders = await LibraryStore.recentFolders();
      publishFolders();
    });
  };
  let recentFocusIndex = -1;
  /** @type {?Promise<void>} */
  let recentExit = null;
  let renderAfterExit = false;
  /**
   * Take a removed row out of the list.
   * @param {HTMLElement} row
   * @returns {Promise<void>}
   */
  const exitRecentRow = (row) => new Promise((resolve) => {
    // The last row takes the whole section with it, heading and rule included, in the one motion.
    const section = /** @type {?HTMLElement} */ (row.closest('.scribe-library-recent'));
    const target = section && section.querySelectorAll('.r:not(.leaving)').length === 1 ? section : row;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      target.remove();
      resolve();
      return;
    }
    target.classList.add('leaving');
    window.setTimeout(() => {
      target.style.height = `${target.getBoundingClientRect().height}px`;
      target.getBoundingClientRect();
      target.classList.add('closing');
      const done = () => {
        target.removeEventListener('transitionend', onEnd);
        target.remove();
        resolve();
      };
      /** @param {TransitionEvent} e */
      const onEnd = (e) => { if (e.target === target && e.propertyName === 'height') done(); };
      target.addEventListener('transitionend', onEnd);
      // A transition that never ends, as in a hidden window, must not hold the list.
      window.setTimeout(() => { if (target.isConnected) done(); }, 400);
    }, 120);
  });

  let recentsPruning = false;
  const pruneRecents = async () => {
    if (recentsPruning) return;
    recentsPruning = true;
    const gone = [];
    try {
      for (const h of recentFolders) if (!(await LibraryStore.folderExists(h))) gone.push(h);
      for (const h of gone) await LibraryStore.forgetFolder(h);
    } finally {
      recentsPruning = false;
    }
    if (destroyed || !gone.length) return;
    recentFolders = recentFolders.filter((h) => !gone.includes(h));
    publishFolders();
  };

  /** Each folder's parent directory, keyed by the folder's name, as the desktop shell reports it. @type {Map<string, string>} */
  const folderDirs = new Map();
  /** The copies the Just added row lists, newest first, each with the name of the directory it came from. @type {Array<{relPath: string, from: string}>} */
  let justAdded = [];

  /** @type {?number} Trailing debounce for grid rebuilds during bulk indexing. */
  let ingestRenderTimer = null;

  const WARM_IDLE_MS = 30 * 1000;
  const WARM_SESSION_PAGES = 150;
  let lastInteraction = Date.now();
  const noteInteraction = () => { lastInteraction = Date.now(); };
  document.addEventListener('pointerdown', noteInteraction, true);
  document.addEventListener('keydown', noteInteraction, true);
  document.addEventListener('wheel', noteInteraction, { capture: true, passive: true });
  /** @type {?boolean} */
  let onBattery = null;
  shell?.getPowerState?.().then((/** @type {any} */ s) => { onBattery = !!s?.onBattery; }).catch(() => {});
  shell?.onPowerChanged?.((/** @type {any} */ s) => {
    onBattery = !!s?.onBattery;
    ingest?.start();
  });
  const onVisibilityChange = () => { ingest?.start(); };
  document.addEventListener('visibilitychange', onVisibilityChange);
  // The gate opening is not an event, so a slow tick is what resumes warm work once the reader goes idle.
  const warmTimer = window.setInterval(() => { ingest?.start(); }, 15 * 1000);

  /** @type {?(() => void)} */
  let releaseFolderLock = null;
  /** @param {string} name */
  const folderLockKey = async (name) => {
    const known = await shell?.getFolderPath?.(name).catch(() => null);
    return `scribe-folder:${known?.path || name}`;
  };

  /**
   * Take the lock that marks a folder open in this window, or report that another window holds it.
   * @param {string} name
   * @returns {Promise<boolean>}
   */
  const holdFolderLock = async (name) => {
    releaseFolderLock?.();
    releaseFolderLock = null;
    if (!navigator.locks) return true;
    const key = await folderLockKey(name);
    return new Promise((resolve) => {
      navigator.locks.request(key, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false);
          return undefined;
        }
        resolve(true);
        // The lock is held as long as this promise is pending, so the release is what settles it.
        return new Promise((release) => { releaseFolderLock = release; });
      }).catch(() => resolve(false));
    });
  };

  /**
   * Whether another window holds a folder.
   * Call it before a pick closes the open folder, so a refusal leaves that folder open.
   * @param {string} name
   * @returns {Promise<boolean>}
   */
  const heldElsewhere = async (name) => {
    if (!isLibrary || !navigator.locks || name === store?.root.name) return false;
    return navigator.locks.request(await folderLockKey(name), { ifAvailable: true }, (lock) => !lock).catch(() => true);
  };
  /** @param {string} name */
  const refuseHeldElsewhere = (name) => {
    viewer._showToast(`“${name}” is already open in another window.`);
    shell?.focusFolderWindow?.(name);
  };
  /**
   * @param {LibraryStore} s
   * @param {{resumed?: boolean}} [opts] - `resumed` marks a launch reopening its last folder: the user asked for nothing, so a failure reports nothing.
   */
  const openLibrary = async (s, { resumed = false } = {}) => {
    if (isLibrary && !(await holdFolderLock(s.root.name))) {
      refuseHeldElsewhere(s.root.name);
      return;
    }
    store = s;
    sessions.connect(s);
    currentDir = '';
    try {
      await store.init();
      manifest = await store.readManifest();
      await engine.open(isLibrary ? store.id : null);
    } catch (err) {
      // A folder that cannot be read must not stay half-open, with the bar and menus acting as if it were open.
      store = null;
      manifest = null;
      sessions.reset();
      releaseFolderLock?.();
      releaseFolderLock = null;
      const gone = err instanceof DOMException && err.name === 'NotFoundError';
      if (gone) {
        await LibraryStore.forgetFolder(s.root);
        recentFolders = await LibraryStore.recentFolders();
        publishFolders();
      }
      if (!resumed) {
        viewer._showToast(gone ? `“${s.root.name}” is no longer there and was removed from Recent.`
          : `Couldn't open “${s.root.name}” — ${err instanceof Error ? err.message.replace(/\.$/, '') : 'the folder is not available'}.`);
      }
      render();
      syncBarForStore();
      viewer._notifyMenuState();
      return;
    }
    ingest = new LibraryIngest(store, manifest, {
      engine,
      onProgress: ({
        done, total, current, kind, pageDone, pageTotal,
      }) => {
        const wasRecognizing = recognizingPath;
        recognizingPath = current && kind === 'recognize' ? current : null;
        recognizeFrac = pageTotal ? Math.min(1, (pageDone || 0) / pageTotal) : 0;
        if (!current) {
          progressElem.style.display = 'none';
          // A banner, like the viewer's own Recognize, because a queue is a long job the user may have stepped away from.
          if (runRecognizeFailures > 0) {
            const n = runRecognizeFailures;
            runRecognizeFailures = 0;
            viewer._showBanner(n === 1
              ? 'Text recognition didn’t finish for 1 document. It was left unchanged.'
              : `Text recognition didn’t finish for ${n} documents. They were left unchanged.`);
          }
          // The queue also drains here after idle ticks and warm-only passes, which change nothing a card or row displays.
          if (done > 0) render();
          // Warmed rasters can fill result rows that were blank at pump time.
          else results.repump();
          return;
        }
        progressElem.style.display = 'grid';
        progressCount.textContent = `${kind === 'recognize' ? 'Recognizing' : 'Indexing'} ${done} of ${total}`;
        progressName.textContent = current.split('/').pop() || current;
        progressHair.style.width = `${(done / total) * 100}%`;
        for (const rp of new Set([recognizingPath, wasRecognizing])) {
          if (!rp) continue;
          const entry = manifest?.docs[rp];
          const el = /** @type {?HTMLElement} */ (body.querySelector(`[data-rel-path="${CSS.escape(rp)}"]`));
          if (!entry || !el) continue;
          if (el.classList.contains('scribe-library-card')) updateCard(el, rp, entry);
          else if (el.classList.contains('scribe-library-row')) updateRow(el, rp, entry);
        }
      },
      onDocDone: (relPath) => {
        const doneEntry = manifest?.docs[relPath];
        // A tab adopted by a copy into the folder learns its hash once the ingest has computed it.
        if (doneEntry?.hash) for (const t of viewer._tabs) if (ownsTab(t) && t.libraryRelPath === relPath && !t.libraryHash) t.libraryHash = doneEntry.hash;
        // Ingest and recognition write sidecars of their own, so cached sidecar pages must not outlive them.
        if (doneEntry?.hash) sessions.dropSidecar(doneEntry.hash);
        if (recognizingPath === relPath && doneEntry?.ocrError) runRecognizeFailures++;
        if (revertUndo && revertUndo.relPath === relPath) {
          if (revertUndo.phase === 'reverting') {
            revertUndo.phase = 'reverted';
            showRevertFeedback(relPath, 'reverted', 10000);
          } else if (revertUndo.phase === 'restoring') {
            revertUndo = null;
            showRevertFeedback(relPath, 'restored', 3000);
          }
        }
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
      // A request made this session runs while the user watches; one resumed after a reload waits for an idle machine like warm work.
      recognizeGate: (explicit) => {
        if (document.visibilityState !== 'visible') return false;
        if (onBattery === true) return false;
        return explicit || Date.now() - lastInteraction >= WARM_IDLE_MS;
      },
      langs: () => viewer.scribe.opt.langs || ['eng'],
      recognizeMode: () => viewer.scribe.opt.recognizeMode,
      liveDoc: async (hash) => {
        const tab = viewer._tabs.find((t) => t.libraryHash === hash && ownsTab(t));
        if (tab) {
          // A seeded tab is still hydrating; recognition needs the real document behind it.
          while (/** @type {any} */ (tab).provisional && viewer._tabs.includes(tab)) await new Promise((r) => { setTimeout(r, 250); });
          if (viewer._tabs.includes(tab)) {
            return {
              doc: tab.doc,
              checkpoint: async (recognized) => {
                tab.libraryDirty = true;
                if (recognized) tab.libraryRecognized = true;
                await saveTabIfDirty(tab);
              },
            };
          }
        }
        const pooled = sessions.takeLive(hash);
        return pooled ? { doc: pooled } : null;
      },
      releaseLiveDoc: (hash, doc) => sessions.adoptLive(hash, doc),
    });
    homeTab.title = store.root.name;
    /** @type {HTMLElement} */ (homeTab.querySelector('.scribe-tab-name')).textContent = store.root.name;
    if (viewer._tabStrip && !homeTab.parentElement) viewer._tabStrip.addPinnedTab(homeTab);
    viewer._tabStripMinTabs = 0;
    if (visible) {
      viewer._tabStrip?.setPinnedActive(true);
      homeTab.classList.add('active');
    }
    viewer._renderTabs();
    positionSurface();
    recentFolders = await LibraryStore.recentFolders();
    publishFolders();
    if (viewer._resumeOwner) {
      try { resumeStorage.setItem(OPEN_FOLDER_KEY, store.root.name); } catch { /* Storage unavailable. */ }
    }
    shell?.getFolderPath?.(store.root.name).then((/** @type {any} */ r) => {
      if (!r?.dir || !store) return;
      folderDirs.set(store.root.name, r.dir);
      publishFolders();
    }).catch(() => {});
    render();
    syncBarForStore();
    syncFolderRows();
    viewer._notifyMenuState();
    // Restore before the folder scan, so restore latency does not scale with library size.
    const record = resumeRecord;
    resumeRecord = null;
    if (record && record.tabs.length && (!record.dir || record.dir === store.root?.name)) {
      restoringTabs = true;
      try {
        // The recorded active tab opens first, so the document being read paints before its neighbors load.
        const toLibrary = !!record.lib;
        const activeRec = !toLibrary && record.active >= 0 ? record.tabs[record.active] : null;
        const ordered = activeRec ? [activeRec, ...record.tabs.filter((t) => t !== activeRec)] : record.tabs;
        const view = record.view && Number.isFinite(record.view.zoom)
          && record.view.zoom > 0.01 && record.view.zoom < 100 ? record.view : null;
        let activeRestored = false;
        for (const rec of ordered) {
          if (destroyed || !manifest) break;
          // The hash finds a document even after a move or rename.
          // The path covers one recorded before ingest hashed it.
          let entryPath = null;
          let entry = null;
          if (rec.hash) {
            for (const [rp, e] of Object.entries(manifest.docs)) {
              if (e.hash === rec.hash) { entryPath = rp; entry = e; break; }
            }
          }
          if (!entry && rec.relPath && manifest.docs[rec.relPath]) { entryPath = rec.relPath; entry = manifest.docs[rec.relPath]; }
          if (!entry || !entryPath) continue;
          if (entry.hash && viewer._tabs.some((t) => t.libraryHash === entry.hash && ownsTab(t))) continue;
          // Never take the foreground from a document that reached it first (e.g. a shell-opened file).
          const background = toLibrary || viewer._activeTab >= 0;
          // Set before the open, so the attach paints at this zoom rather than at a fit.
          if (!background && rec === activeRec && view) viewer._restoreView = { zoom: view.zoom, sx: view.sx, sy: view.sy };
          const tabsBefore = viewer._tabs.length;
          await openEntry(entryPath, entry, { pageN: rec.page || 0, background });
          // An open that failed before attaching must not leak the view onto whatever attaches next.
          viewer._restoreView = null;
          if (!background && rec === activeRec && viewer._tabs.length > tabsBefore) activeRestored = true;
        }
        if (activeRestored) {
          // The background opens bumped the use counter past the active tab, so re-bump it to keep its worker pools warm.
          const activeTab = viewer._tabs[viewer._activeTab];
          if (activeTab) {
            activeTab.lastUse = ++viewer._tabUseCounter;
            viewer._applyTabResourcePolicy();
          }
        }
        if (toLibrary && !visible && !destroyed) activate({ render: false });
      } finally {
        restoringTabs = false;
      }
      writeResumeRecord();
    }
    await ingest.scan();
    render();
    ingest.start();
  };

  /** @param {File[]} files */
  const isImageName = (name) => /\.(png|jpe?g)$/i.test(name || '');

  let creatingPdf = false;

  /**
   * Author a PDF from image files, write it into the browsed folder, and open it as a tab.
   * @param {File[]} files - Non-images are dropped. The rest become pages in name order.
   */
  const createPdfFromImages = async (files) => {
    if (!store || !ingest || creatingPdf) return;
    if (!(await store.ensureWritable())) {
      viewer._showToast(`Couldn't add a PDF — editing ${store.root.name} wasn't allowed.`);
      return;
    }
    // Match the importer's name sort so the derived file name is page 1's image.
    const images = files.filter((f) => isImageName(f.name))
      .sort((a, b) => ((a.name > b.name) ? 1 : ((b.name > a.name) ? -1 : 0)));
    if (!images.length) return;
    creatingPdf = true;
    try {
      let data;
      try {
        const scratch = await scribeLib.openDocument(images);
        try {
          data = await scratch.exportData('pdf');
        } finally {
          await scratch.close();
        }
      } catch (err) {
        viewer._showToast(`Couldn't create a PDF from ${images.length === 1 ? 'the image' : `${images.length} images`} — ${err instanceof Error ? err.message : 'the images could not be read'}.`);
        return;
      }
      const baseName = images[0].name.replace(/\.[^.]+$/, '');
      let relPath;
      try {
        relPath = await store.importSourceFile(`${baseName}.pdf`, new Blob([data], { type: 'application/pdf' }), currentDir);
      } catch (err) {
        viewer._showToast(`Couldn't add “${baseName}.pdf” — ${err instanceof Error ? err.message : 'the file could not be written'}.`);
        return;
      }
      const written = await store.readFile(relPath);
      await ingest.enqueue(relPath, { size: written.size, mtime: written.lastModified });
      selectedPaths.clear();
      selectedPaths.add(relPath);
      selAnchor = relPath;
      render({ revealSelection: true });
      ingest.start();
      await openEntry(relPath, manifest.docs[relPath]);
    } finally {
      creatingPdf = false;
    }
  };

  const startIngestFiles = async (files) => {
    if (!store || !ingest) return;
    if (!(await store.ensureWritable())) {
      viewer._showToast(`Couldn't add the files — editing ${store.root.name} wasn't allowed.`);
      return;
    }
    const pdfs = files.filter((f) => (f.name || '').toLowerCase().endsWith('.pdf'));
    if (!pdfs.length) {
      viewer._showToast('This folder holds PDFs — none of the dropped files were PDFs.');
      return;
    }
    const names = files.map((f) => f.name || '');
    for (const file of pdfs) {
      try {
        const relPath = await store.importSourceFile(file.name, file, currentDir);
        // The OCR file is copied in under the PDF's final name, so a PDF renamed by a name collision still pairs with it.
        const ocrName = filesNamedForPdf(file.name, names).ocrFiles[0];
        const ocrFile = ocrName ? files.find((f) => f.name === ocrName) : null;
        if (ocrFile) {
          const finalStem = relPath.slice(relPath.lastIndexOf('/') + 1).replace(/\.pdf$/i, '');
          await store.importSourceFile(finalStem + ocrName.slice(file.name.replace(/\.pdf$/i, '').length), ocrFile, currentDir);
        }
        await ingest.enqueue(relPath, { size: file.size, mtime: file.lastModified });
        const sourcePath = String(shell?.pathForFile?.(file) || '').replace(/\\/g, '/');
        const sourceDir = sourcePath.slice(0, sourcePath.lastIndexOf('/'));
        justAdded.unshift({ relPath, from: sourceDir.slice(sourceDir.lastIndexOf('/') + 1) });
      } catch (err) {
        viewer._showToast(`Couldn't add “${file.name}” — ${err instanceof Error ? err.message : 'the file could not be written'}.`);
      }
    }
    render();
    ingest.start();
  };

  /**
   * Copy a freestanding tab's PDF into the folder's root and make the tab one of the folder's.
   * A note under the tab offers to undo the copy.
   * @param {Object} tab
   * @param {?number} toIndex - Insertion index in the tab list once the tab is taken out of it, or null for after the folder's last open document.
   */
  const copyTabIntoFolder = async (tab, toIndex) => {
    if (!store || !ingest || !manifest || !tab || ownsTab(tab)) return;
    const folderName = store.root.name;
    if (!(await store.ensureWritable())) {
      viewer._showToast(`Couldn't copy “${tab.name}” into ${folderName} — editing the folder wasn't allowed.`);
      return;
    }
    const bytes = tab.doc?.images?.pdfData;
    if (!bytes) {
      viewer._showToast(`Couldn't copy “${tab.name}” into ${folderName} — its PDF data is not available.`);
      return;
    }
    const fromIndex = viewer._tabs.indexOf(tab);
    if (fromIndex < 0) return;
    const fileName = /\.pdf$/i.test(tab.name) ? tab.name : `${tab.name}.pdf`;
    const file = new File([bytes], fileName, { type: 'application/pdf', lastModified: Date.now() });
    let relPath;
    try {
      relPath = await store.importSourceFile(fileName, file, '');
      await ingest.enqueue(relPath, { size: file.size, mtime: file.lastModified });
    } catch (err) {
      viewer._showToast(`Couldn't copy “${tab.name}” into ${folderName} — ${err instanceof Error ? err.message.replace(/\.$/, '') : 'the file could not be written'}.`);
      return;
    }
    justAdded.unshift({ relPath, from: '' });
    tab.libraryOwner = instanceId;
    tab.libraryRelPath = relPath;
    // The ingest fills in the hash later.
    tab.libraryHash = manifest.docs[relPath]?.hash || undefined;
    wrapMutators(tab.doc, tab);
    let to = toIndex;
    if (to === null || to === undefined) {
      to = 0;
      viewer._tabs.forEach((t, i) => { if (t !== tab && ownsTab(t) && (t.libraryHash || t.libraryRelPath)) to = i - (i > fromIndex ? 1 : 0) + 1; });
    }
    viewer._moveTab(fromIndex, to);
    viewer._renderTabs();
    render();
    ingest.start();
    viewer._tabStrip?.showTabNote(viewer._tabs.indexOf(tab), 'Copied into the folder', {
      actionLabel: 'Undo',
      onAction: () => { undoCopyIntoFolder(tab, relPath, fromIndex).catch(() => {}); },
    });
  };

  /**
   * Reverse a copy into the folder.
   * @param {Object} tab
   * @param {string} relPath
   * @param {number} fromIndex
   */
  const undoCopyIntoFolder = async (tab, relPath, fromIndex) => {
    if (tab.libraryRelPath === relPath) {
      tab.libraryDirty = false;
      delete tab.libraryOwner;
      delete tab.libraryRelPath;
      delete tab.libraryHash;
      const at = viewer._tabs.indexOf(tab);
      if (at >= 0) viewer._moveTab(at, Math.min(fromIndex, viewer._tabs.length - 1));
      viewer._renderTabs();
    }
    justAdded = justAdded.filter((a) => a.relPath !== relPath);
    await forgetDocs([relPath]);
    if (store) {
      try {
        await store.deleteSourceFile(relPath);
      } catch (err) {
        viewer._showToast(`Couldn't remove “${titleOf(relPath)}” — ${err instanceof Error ? err.message.replace(/\.$/, '') : 'the file could not be deleted'}.`);
      }
    }
    render();
  };

  /**
   * Show the folder view with the tab's document selected and scrolled into view.
   * @param {Object} tab
   */
  const showTab = (tab) => {
    if (!store || !manifest) return;
    let relPath = tab?.libraryRelPath;
    // A drag into a folder or a rename outside the app leaves the tab's path stale, so the document is looked up by its hash.
    if ((!relPath || !manifest.docs[relPath]) && tab?.libraryHash) {
      relPath = Object.keys(manifest.docs).find((p) => manifest.docs[p].hash === tab.libraryHash) ?? relPath;
    }
    const entry = relPath ? manifest.docs[relPath] : null;
    if (!relPath || !entry) {
      viewer._showToast(`Couldn't find “${tab?.name ?? 'the document'}” in ${store.root.name}.`);
      return;
    }
    if (!visible) activate({ render: false, attach: false });
    storageOpen = false;
    const previewing = listPreviewOn && viewMode !== 'grid';
    if (previewing) {
      listPreviewPath = relPath;
      listPreviewPage = 0;
    }
    const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
    if (dir !== currentDir) {
      openDir(dir);
    } else {
      fullTextResults = null;
      filterText = '';
      searchInput.value = '';
      searchField.classList.remove('has-text', 'hint-yield');
    }
    selectedPaths.clear();
    selectedPaths.add(relPath);
    selAnchor = relPath;
    render({ revealSelection: true });
    // A render that reconciles the list in place leaves the pane alone, so the preview is asked for directly.
    if (previewing) showListPreview(relPath, entry, 0);
  };

  // --- Event wiring -------------------------------------------------------

  homeTab.addEventListener('click', () => {
    if (visible) return;
    activate({ morph: true });
  });

  /**
   * Prompt for a library folder.
   * @returns {Promise<?LibraryStore>} Null when the picker was dismissed, or when the folder could not be connected, which is shown.
   */
  const pickFolder = async () => {
    try {
      const s = await LibraryStore.connectNew();
      if ((await s.permissionState()) === 'granted') return s;
      viewer._showToast("Couldn't connect the folder — access to it was refused.");
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return null;
      viewer._showToast(`Couldn't connect the folder — ${err instanceof Error ? err.message.replace(/\.$/, '') : 'something went wrong'}.`);
    }
    return null;
  };

  /** Close the open folder, saving and closing the documents open from it. */
  const closeFolder = async () => {
    if (!store) return;
    closeMovePicker();
    const folderTabs = viewer._tabs.filter((t) => ownsTab(t) && (t.libraryHash || t.libraryRelPath));
    for (const tab of folderTabs) await saveTabIfDirty(tab);
    ingest?.cancel();
    storageOpen = false;
    storageSizes = null;
    if (manifestTimer !== null) {
      window.clearTimeout(manifestTimer);
      manifestTimer = null;
      if (manifest && !discardOnClose) store.writeManifest(manifest).catch(() => {});
    }

    engine.close().catch(() => {});

    preview.destroy();
    sessions.reset();
    results.dispose();
    selectedPaths.clear();
    clearUndo();
    selAnchor = null;
    filterText = '';
    searchInput.value = '';
    searchField.classList.remove('has-text', 'hint-yield');
    fullTextResults = null;
    engineResponse = null;
    engineTiers = null;
    engineError = null;
    justAdded = [];
    currentDir = '';
    store = null;
    manifest = null;
    ingest = null;
    releaseFolderLock?.();
    releaseFolderLock = null;
    // A folder's documents save their notes inside it, so they cannot stay open once it closes.
    // The active one closes last, so no document in between is attached only to be closed in turn.
    const activeTab = viewer._tabs[viewer._activeTab];
    for (let i = viewer._tabs.length - 1; i >= 0; i--) {
      if (folderTabs.includes(viewer._tabs[i]) && viewer._tabs[i] !== activeTab) viewer._closeTab(i);
    }
    if (folderTabs.includes(activeTab)) viewer._closeTab(viewer._tabs.indexOf(activeTab));
    if (viewer._tabStrip && homeTab.parentElement) viewer._tabStrip.removePinnedTab(homeTab);
    viewer._tabStripMinTabs = viewer._tabStrip?.pinnedCount() ? 1 : 2;
    viewer._renderTabs();
    positionSurface();
    syncBarForStore();
    syncFolderRows();
    viewer._notifyMenuState();
    writeResumeRecord();
    if (viewer._resumeOwner) {
      try { resumeStorage.removeItem(OPEN_FOLDER_KEY); } catch { /* Storage unavailable. */ }
    }
    if (visible) render();
  };
  const openFolder = async () => {
    const s = await pickFolder();
    if (!s) return;
    if (await heldElsewhere(s.root.name)) {
      refuseHeldElsewhere(s.root.name);
      return;
    }
    await closeFolder();
    activate({ render: false });
    await openLibrary(s);
  };
  /**
   * Open a folder from the start screen's Recent list.
   * The click is the user gesture a stored handle may need to regain its permission.
   * @param {FileSystemDirectoryHandle} handle
   */
  const openRecentFolder = async (handle) => {
    const s = await LibraryStore.forHandle(handle);
    try {
      if ((await s.permissionState()) !== 'granted' && (await s.requestPermission()) !== 'granted') {
        viewer._showToast(`Couldn't open “${handle.name}” — access to the folder was refused.`);
        return;
      }
    } catch (err) {
      viewer._showToast(`Couldn't open “${handle.name}” — ${err instanceof Error ? err.message.replace(/\.$/, '') : 'the folder is not available'}.`);
      return;
    }
    if (await heldElsewhere(handle.name)) {
      refuseHeldElsewhere(handle.name);
      return;
    }
    await closeFolder();
    await LibraryStore.persistHandle(handle);
    activate({ render: false });
    await openLibrary(s);
  };
  // Sidecars are untouched, so rebuilding the derived data cannot lose a user edit.
  const rebuildIndex = async () => {
    if (!store || !manifest || !ingest) return;
    for (const [p, e] of Object.entries(manifest.docs)) {
      if (e.status === 'indexed' && e.hash) await ingest.enqueue(p, {}, { writeManifest: false });
    }
    await store.writeManifest(manifest);
    render();
    ingest.start();
  };
  // --- Folder menu --------------------------------------------------------
  const folderMenu = document.createElement('div');
  folderMenu.className = 'scribe-library-menu scribe-library-folder-menu';
  folderMenu.setAttribute('role', 'menu');
  folderMenu.style.display = 'none';
  const previewClose = (/** @type {boolean} */ on) => viewer._tabStripElem?.classList.toggle('scribe-tab-close-preview', on);
  /** @type {?HTMLElement} */
  let revealItem = null;
  const folderDropdown = createDropdown({
    show: (anchor) => {
      if (!store) return null;
      // The shell learns a folder's location only from the picker, so a folder picked under an earlier version has none.
      if (revealItem) {
        const known = folderDirs.has(store.root.name);
        revealItem.classList.toggle('disabled', !known);
        revealItem.title = known ? '' : 'Available after the folder is picked again with Open Folder…';
      }
      const host = viewer.pdfViewerElem;
      if (folderMenu.parentElement !== host) host.appendChild(folderMenu);
      const hostRect = host.getBoundingClientRect();
      const anchorRect = anchor.getBoundingClientRect();
      folderMenu.style.left = `${Math.max(4, anchorRect.left - hostRect.left)}px`;
      folderMenu.style.top = `${anchorRect.bottom - hostRect.top + 4}px`;
      folderMenu.style.display = '';
      return folderMenu;
    },
    hide: () => {
      folderMenu.style.display = 'none';
      previewClose(false);
    },
    rows: '.scribe-library-menu-item',
  });
  if (homeTabChev) folderDropdown.attachTrigger(homeTabChev);
  /** @param {string} svg @param {string} label @param {() => void} onPick */
  const addFolderMenuItem = (svg, label, onPick) => {
    const item = document.createElement('div');
    item.className = 'scribe-library-menu-item';
    item.setAttribute('role', 'menuitem');
    item.innerHTML = svg;
    const glyph = item.querySelector('svg');
    if (glyph) glyph.style.cssText = 'width:15px;height:15px;';
    item.appendChild(document.createTextNode(label));
    item.addEventListener('click', () => {
      folderDropdown.close();
      onPick();
    });
    folderMenu.appendChild(item);
    return item;
  };
  const addFolderMenuSep = () => {
    const sep = document.createElement('div');
    sep.className = 'scribe-library-menu-sep';
    folderMenu.appendChild(sep);
  };
  if (isLibrary && shell?.revealFolder) {
    revealItem = addFolderMenuItem(REVEAL_SVG, shell.platform === 'darwin' ? 'Reveal in Finder' : shell.platform === 'win32' ? 'Show in Explorer' : 'Show in file manager', () => {
      if (store && folderDirs.has(store.root.name)) shell.revealFolder(store.root.name);
    });
  }
  if (isLibrary) {
    addFolderMenuItem(FOLDER_SVG, 'Open Another Folder…', () => openFolder());
    addFolderMenuSep();
    addFolderMenuItem(REFRESH_SVG, 'Refresh Folder', () => refreshBtn.click());
    addFolderMenuItem(LIBRARY_SVG, 'Rebuild Search Index', () => rebuildIndex());
    addFolderMenuItem(STORAGE_SVG, 'Library Storage…', () => openStorage());
    addFolderMenuSep();
  }
  const folderMenuCloseItem = isLibrary ? addFolderMenuItem(CLOSE_X_SVG, 'Close Folder', () => closeFolder()) : null;
  folderMenuCloseItem?.addEventListener('mouseenter', () => previewClose(true));
  folderMenuCloseItem?.addEventListener('mouseleave', () => previewClose(false));
  /** @type {?HTMLElement} */
  let openFolderItem = null;
  /** @type {?HTMLElement} */
  let closeFolderItem = null;
  /** @type {?HTMLElement} */
  let rebuildItem = null;
  /** @type {?HTMLElement} */
  let storageItem = null;
  if (viewer._appMenu && isLibrary) {
    openFolderItem = viewer._appMenu.addAction('Open folder', FOLDER_SVG, openFolder);
    // Sits directly under "Open file".
    viewer._appMenu.menuElem.insertBefore(openFolderItem, viewer._appMenu.menuElem.children[1] ?? null);
    closeFolderItem = viewer._appMenu.addAction('Close folder', CLOSE_X_SVG, () => { if (store) closeFolder(); });
    viewer._appMenu.menuElem.insertBefore(closeFolderItem, openFolderItem.nextSibling);
    closeFolderItem.addEventListener('mouseenter', () => { if (store) previewClose(true); });
    closeFolderItem.addEventListener('mouseleave', () => previewClose(false));
    rebuildItem = viewer._appMenu.addAction('Rebuild search index', LIBRARY_SVG, () => { if (store) rebuildIndex(); });
    viewer._appMenu.menuElem.insertBefore(rebuildItem, closeFolderItem.nextSibling);
    storageItem = viewer._appMenu.addAction('Library storage…', STORAGE_SVG, () => { if (store) openStorage(); });
    viewer._appMenu.menuElem.insertBefore(storageItem, rebuildItem.nextSibling);
  }
  const folderDocCount = () => viewer._tabs.filter((t) => ownsTab(t) && (t.libraryHash || t.libraryRelPath)).length;
  const closeFolderLabel = () => {
    const n = store ? folderDocCount() : 0;
    return n ? `Close Folder and ${n} Document${n === 1 ? '' : 's'}` : 'Close Folder';
  };
  const syncFolderRows = () => {
    const n = store ? folderDocCount() : 0;
    const relabel = (/** @type {?HTMLElement} */ item, /** @type {string} */ text) => {
      const node = item && [...item.childNodes].find((c) => c.nodeType === Node.TEXT_NODE);
      if (node) node.textContent = text;
    };
    relabel(folderMenuCloseItem, closeFolderLabel());
    relabel(closeFolderItem, n ? `Close folder and ${n} document${n === 1 ? '' : 's'}` : 'Close folder');
    for (const item of [closeFolderItem, rebuildItem, storageItem]) {
      if (!item) continue;
      item.classList.toggle('disabled', !store);
      item.ariaDisabled = store ? 'false' : 'true';
      item.tabIndex = store ? 0 : -1;
    }
  };
  syncFolderRows();
  // Tab opens and closes change the count, and every strip change pushes menu state.
  viewer.pdfViewerElem.addEventListener('scribe-menu-state-change', syncFolderRows);

  searchInput.addEventListener('input', () => {
    filterText = searchInput.value;
    searchField.classList.toggle('has-text', !!filterText);
    if (filterText) syncHint();
    else searchField.classList.remove('hint-yield');
    if (fullTextResults && !filterText) fullTextResults = null;
    if (!fullTextResults) render();
  });
  searchInput.addEventListener('focus', syncHint);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (searchInput.value) {
        searchInput.value = '';
        filterText = '';
        searchField.classList.remove('has-text', 'hint-yield');
        fullTextResults = null;
        render();
        return;
      }
      const first = /** @type {?HTMLElement} */ (body.querySelector('[data-rel-path]'));
      if (first) first.focus();
      else searchInput.blur();
      return;
    }
    if (e.key !== 'Enter') return;
    const query = searchInput.value.trim();
    if (!query) return;
    /** @type {?import('./search/searchClient.js').SearchResponse} */
    let answered = null;
    engine.query(query, undefined, (tiers) => {
      if (destroyed || !tiers || !answered || engineResponse !== answered) return;
      engineTiers = tiers;
      results.appendTiers();
    }).then((response) => {
      if (destroyed || !store) return;
      fullTextQuery = query;
      answered = response;
      engineResponse = response;
      engineTiers = null;
      engineError = null;
      fullTextResults = response.docs.map((d) => ({ hash: d.hash, pages: d.pages.map((p) => p.page) }));
      render();
    }).catch((err) => {
      console.error('Library search failed.', err);
      if (destroyed || !store) return;
      fullTextQuery = query;
      engineResponse = null;
      engineTiers = null;
      engineError = err instanceof Error ? err.message : String(err);
      fullTextResults = [];
      render();
    });
  });
  // A blurred input scrolls back to the head of its value, so the browser's own caret placement would land there.
  searchInput.addEventListener('mousedown', (e) => {
    if (document.activeElement === searchInput) return;
    e.preventDefault();
    searchInput.focus();
    searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
  });
  clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    filterText = '';
    searchField.classList.remove('has-text', 'hint-yield');
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
  const sortDropdown = createDropdown({
    show: () => {
      syncSortUI();
      sortMenu.style.display = '';
      return sortMenu;
    },
    hide: () => {
      sortMenu.style.display = 'none';
    },
    rows: '.scribe-library-menu-item',
  });
  sortDropdown.attachTrigger(sortBtn);
  /** @param {Event} e */
  const onSortItemClick = (e) => {
    sortMode = /** @type {string} */ (/** @type {HTMLElement} */ (e.currentTarget).dataset.mode);
    sortDir = SORT_DEFAULT_DIR[sortMode];
    syncSortUI();
    sortDropdown.close();
    render();
  };
  for (const item of sortItems) item.addEventListener('click', onSortItemClick);
  syncSortUI();
  const syncOthersItem = () => {
    othersItem.classList.toggle('on', showOthers);
    othersItem.setAttribute('aria-checked', String(showOthers));
  };
  syncOthersItem();
  othersItem.addEventListener('click', () => {
    showOthers = !showOthers;
    if (persistPrefs) {
      try {
        window.localStorage.setItem(OTHERS_STORAGE_KEY, showOthers ? '1' : '0');
      } catch { /* localStorage unavailable. */ }
    }
    syncOthersItem();
    sortDropdown.close();
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
    if (persistPrefs) {
      try {
        window.localStorage.setItem(VIEW_STORAGE_KEY, mode);
      } catch { /* localStorage unavailable. */ }
    }
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
    if (persistPrefs) {
      try {
        window.localStorage.setItem(PREVIEW_STORAGE_KEY, listPreviewOn ? '1' : '0');
      } catch { /* localStorage unavailable. */ }
    }
    syncViewUI();
    if (!fullTextResults) render();
  });

  const newDropdown = createDropdown({
    show: () => {
      newMenu.style.display = '';
      return newMenu;
    },
    hide: () => {
      newMenu.style.display = 'none';
    },
    rows: '.scribe-library-menu-item',
  });
  newDropdown.attachTrigger(newBtn);
  newFolderItem.addEventListener('click', () => {
    newDropdown.close();
    createNewFolder();
  });
  // Write permission is asked for before the picker opens, since the picker's dialog ends the gesture a prompt needs.
  newPdfItem.addEventListener('click', async () => {
    newDropdown.close();
    if (store && await store.ensureWritable()) imageInput.click();
  });
  addPdfsItem.addEventListener('click', async () => {
    newDropdown.close();
    if (store && await store.ensureWritable()) fileInput.click();
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.length) startIngestFiles([...fileInput.files]);
    fileInput.value = '';
  });
  imageInput.addEventListener('change', () => {
    if (imageInput.files?.length) createPdfFromImages([...imageInput.files]);
    imageInput.value = '';
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
    recognizingPath = null;
    saveManifestSoon();
    render();
  });

  // `dataTransfer.files` stays empty until the drop, so `types` is the only way to spot a file drag while it is still moving.
  /** @param {DragEvent} e */
  const isFileDrag = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');

  const priorDragLabel = viewer._dragOverlayLabelFor;
  if (!readOnly) {
    viewer._dragOverlayLabelFor = (e) => {
      if (!visible || !store) return priorDragLabel ? priorDragLabel(e) : null;
      // Mid-drag the payload exposes MIME types but never file names, so the count has to go by type.
      let imageN = 0;
      let otherN = 0;
      for (const item of e.dataTransfer?.items ?? []) {
        if (item.kind !== 'file') continue;
        if (item.type === 'image/png' || item.type === 'image/jpeg') imageN += 1;
        else otherN += 1;
      }
      if (imageN && !otherN) return `Drop to create a PDF from ${imageN === 1 ? '1 image' : `${imageN} images`}`;
      return `Copy into ${store.root.name}`;
    };
  }
  /** @type {?number} */
  let dragClearTimer = null;
  surface.addEventListener('dragover', () => {
    if (dragClearTimer === null) return;
    window.clearTimeout(dragClearTimer);
    dragClearTimer = null;
  });
  surface.addEventListener('dragleave', (e) => {
    if (readOnly || !store || !isFileDrag(e)) return;
    // A finished ingest that rebuilds the cards mid-drag loses a dragleave, which would strand the viewer's overlay over the library.
    const r = surface.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX >= r.right || e.clientY < r.top || e.clientY >= r.bottom) {
      viewer._hideDragOverlay?.();
      return;
    }
    // A drag can end without ever leaving (Esc, or a drop another handler claims), reporting a last position inside and then going quiet.
    // The drag model repeats dragover at least every 350ms, so 600ms cannot fire during a live drag.
    if (dragClearTimer === null) {
      dragClearTimer = window.setTimeout(() => {
        dragClearTimer = null;
        viewer._hideDragOverlay?.();
      }, 600);
    }
  });
  surface.addEventListener('drop', async (e) => {
    if (readOnly || !isFileDrag(e)) return;
    if (!store) {
      // A dropped folder is refused, since the viewer would open its files as tabs.
      const items = [...(e.dataTransfer?.items ?? [])];
      if (!items.some((item) => item.kind === 'file' && item.webkitGetAsEntry()?.isDirectory)) return;
      e.preventDefault();
      e.stopPropagation();
      viewer._showToast('Drop a PDF to open it, or use Open Folder… to browse a whole folder.');
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const files = await filesFromDropEvent(e);
    // A drag can name 'Files' and still resolve to nothing, e.g. an empty folder.
    // There is no unsupported file to name, so there is nothing worth saying.
    if (!files.length) return;
    const images = files.filter((f) => isImageName(f.name));
    const pdfs = files.filter((f) => (f.name || '').toLowerCase().endsWith('.pdf'));
    if (!images.length && !pdfs.length) {
      viewer._showToast('This folder holds PDFs — none of the dropped files were PDFs or images.');
      return;
    }
    // A PDF that already lives in this folder opens rather than being copied beside itself.
    const folderPath = String((await shell?.getFolderPath?.(store.root.name).catch(() => null))?.path || '').replace(/\\/g, '/');
    const inside = new Set();
    if (folderPath && ingest) {
      for (const f of pdfs) {
        const p = String(shell.pathForFile(f) || '').replace(/\\/g, '/');
        if (!p.startsWith(`${folderPath}/`)) continue;
        inside.add(f);
        const relPath = p.slice(folderPath.length + 1);
        if (!manifest.docs[relPath]) await ingest.enqueue(relPath, { size: f.size, mtime: f.lastModified });
        await openEntry(relPath, manifest.docs[relPath]);
      }
      if (inside.size) ingest.start();
    }
    const outside = files.filter((f) => !inside.has(f));
    // The whole drop goes along, so an OCR file dropped beside its PDF is copied in with it.
    if (pdfs.some((f) => !inside.has(f))) await startIngestFiles(outside);
    if (images.length) await createPdfFromImages(images);
  });

  // Word-text and comment edits commit through editable elements rather than ScribeDoc methods, so any input event marks the active library tab dirty.
  const onInput = () => {
    const tab = viewer._tabs[viewer._activeTab];
    if (tab?.libraryHash) tab.libraryDirty = true;
  };

  viewer.pdfViewerElem.addEventListener('input', onInput, true);
  const offRecents = viewer._recents.onChange(() => {
    if (!visible || store) return;
    if (!recentExit) {
      render();
      return;
    }
    // A row still on its way out finishes first, so the redraw cannot cut its motion short.
    if (renderAfterExit) return;
    renderAfterExit = true;
    recentExit.then(() => {
      renderAfterExit = false;
      if (visible && !store) render();
    });
  });

  // Two single-slot hooks on the viewer: the first instance sets them, and they mark any instance's tab dirty.
  const ownsEditHooks = !viewer.scribe.onAnnotationsEdited;
  if (ownsEditHooks) {
    // Pointer-made annotations commit without an input event or a ScribeDoc method, so the edit signal is what marks the tab dirty.
    viewer.scribe.onAnnotationsEdited = () => {
      const target = /** @type {any} */ (viewer.doc)?._libraryDirtyTarget;
      if (target) target.libraryDirty = true;
    };
    // A turn can settle after a tab switch, so this hook resolves the owner from the document rather than the active tab.
    viewer.onAssistantHistoryEdited = (doc) => {
      const target = /** @type {any} */ (doc)?._libraryDirtyTarget;
      if (target) target.libraryDirty = true;
    };
  }
  const autosaveTimer = window.setInterval(() => {
    saveTabIfDirty(viewer._tabs[viewer._activeTab]);
    writeResumeRecord();
  }, AUTOSAVE_INTERVAL_MS);

  const onPageHide = () => {
    writeResumeRecord();
    for (const tab of viewer._tabs) saveTabIfDirty(tab);
  };
  window.addEventListener('pagehide', onPageHide);

  // Pointer and focus both feed the flag, since clicks on the page land on non-focusable elements and leave focus where it was.
  let docEngaged = false;
  const trackEngagement = (e) => {
    const sc = viewer.scribe.scrollContainer;
    docEngaged = !!(sc && e.target instanceof Node && (sc.contains(e.target) || viewer._searchBar?.findGroupElem.contains(e.target)));
  };
  viewer.pdfViewerElem.addEventListener('pointerdown', trackEngagement, true);
  viewer.pdfViewerElem.addEventListener('focusin', trackEngagement, true);

  const focusSearch = () => {
    // A reader working in the previewed document gets its find, not the library's search.
    if (docEngaged && splitForm() && viewer.doc && viewer._searchBar) {
      viewer._searchBar.openSearch();
      return;
    }
    searchInput.focus();
    searchInput.select();
  };
  // While the library has the window, this claims the shortcut ahead of the toolbar's find bar.
  const onFindShortcut = (e) => {
    if (!visible) return;
    if (!((e.key === 'f' || e.key === 'F') && (e.ctrlKey || e.metaKey) && !e.altKey)) return;
    e.preventDefault();
    e.stopPropagation();
    focusSearch();
  };
  document.addEventListener('keydown', onFindShortcut, true);
  // The document's keyboard scope is off while the surface is in front, which silences its Ctrl+O, so the surface answers it.
  /** @param {KeyboardEvent} e */
  const onOpenShortcut = (e) => {
    if (!visible) return;
    if (!((e.key === 'o' || e.key === 'O') && (e.ctrlKey || e.metaKey) && !e.altKey)) return;
    e.preventDefault();
    e.stopPropagation();
    viewer.runMenuCommand('open');
  };
  document.addEventListener('keydown', onOpenShortcut, true);

  // Document-level like the find shortcut, so it works with focus anywhere on the surface, never inside a text field.
  /** @param {KeyboardEvent} e */
  const onSelectAll = (e) => {
    if (!visible || docEngaged) return;
    if (!((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey)) return;
    if (e.target instanceof Element && e.target.closest('input, textarea, [contenteditable="true"]')) return;
    const paths = new Set([...body.querySelectorAll('.scribe-library-card[data-rel-path], .scribe-library-row[data-rel-path]')]
      .map((el) => /** @type {HTMLElement} */ (el).dataset.relPath ?? ''));
    if (!paths.size) return;
    e.preventDefault();
    e.stopPropagation();
    selectedPaths.clear();
    for (const p of paths) selectedPaths.add(p);
    selAnchor = null;
    syncSelectionUI();
  };
  document.addEventListener('keydown', onSelectAll, true);

  Object.assign(api, {
    kind: opts.kind,
    libraryHash: opts.libraryHash ?? null,
    libraryOwner: opts.libraryOwner ?? null,
    visible: () => visible,
    covering: () => visible && !splitForm(),
    focusSearch,
    ...(isLibrary ? {
      connected: () => !!store,
      searchStats: () => engine.stats(),
      openFolder,
      rebuildIndex,
      openStorage,
      closeFolder,
      ownsTab: (/** @type {?{libraryHash?: string, libraryRelPath?: string}} */ tab) => ownsTab(tab) && !!(tab?.libraryHash || tab?.libraryRelPath),
      closeFolderLabel,
      folderName: () => store?.root.name ?? '',
      copyTabIntoFolder,
      showTab,
    } : {}),
    ...(opts.onClose ? { close: opts.onClose } : {}),
    show: () => {
      if (visible) return;
      activate({ morph: true });
    },
    hide: () => {
      if (visible) deactivate();
    },
    clearPreview,
    pageChanged: () => {
      if (visible && pvHead.style.display !== 'none') syncPaneNav();
    },
    docOpened: () => {
      // An Open from the pane leaves the surface up for the morph that follows it.
      if (visible && !morphPending) deactivate();
      preview.displaced();
      writeResumeRecord();
    },
    emptied: () => {
      if (!visible) activate();
      writeResumeRecord();
    },
    saveTabIfDirty,
    saveAllDirty: async ({ resume = true } = {}) => {
      // The desktop shell destroys its window without a pagehide, so teardown is the last chance to record the open tabs.
      // The shell's teardown decides which window a relaunch resumes, overriding the role that focus gave.
      viewer._resumeOwner = resume;
      writeResumeRecord();
      for (const tab of viewer._tabs) await saveTabIfDirty(tab);
    },
    ...(isLibrary ? {
      syncResume: () => {
        try {
          if (store) resumeStorage.setItem(OPEN_FOLDER_KEY, store.root.name);
          else resumeStorage.removeItem(OPEN_FOLDER_KEY);
        } catch { /* Storage unavailable. */ }
        writeResumeRecord();
      },
      syncFoldersOpenElsewhere: () => publishFolders(),
    } : {}),
  });
  viewer._libraryInstances.push(api);

  // --- Boot ---------------------------------------------------------------

  (async () => {
    if (!isLibrary) {
      activate({ render: false });
      render();
      await openLibrary(/** @type {LibraryStore} */ (/** @type {unknown} */ (opts.store)));
      if (destroyed) return;
      const first = opts.initialRelPath;
      const firstEntry = first ? manifest?.docs[first] : null;
      if (first && firstEntry) {
        // The author's first file can sit in a folder, so the view opens on that folder and the selection is in sight.
        currentDir = first.slice(0, Math.max(0, first.lastIndexOf('/')));
        selectedPaths.add(first);
        selAnchor = first;
        listPreviewPath = first;
      }
      render({ revealSelection: true });
      // The render above reconciles the list in place, which leaves the pane alone, so the preview is asked for directly.
      if (first && firstEntry) showListPreview(first, firstEntry, 0);
      return;
    }
    recentFolders = await LibraryStore.recentFolders();
    if (destroyed) return;
    publishFolders();
    recentFolders.forEach((h) => {
      shell?.getFolderPath?.(h.name).then((/** @type {any} */ r) => {
        if (!r?.dir || destroyed) return;
        folderDirs.set(h.name, r.dir);
        publishFolders();
      }).catch(() => {});
    });
    // A launch by file opens only that file, and a folder closed before quitting stays closed.
    let openName = null;
    try { openName = resumeStorage.getItem(OPEN_FOLDER_KEY); } catch { /* Storage unavailable. */ }
    const handle = shell?.launchedWithFile || shell?.freshWindow || !openName ? null : (recentFolders.find((h) => h.name === openName) ?? null);
    if (handle) {
      const s = await LibraryStore.forHandle(handle);
      if ((await s.permissionState()) === 'granted') {
        if (viewer._tabs.length === 0 && !viewerRestorePending) {
          activate({ render: false });
          render();
        }
        await openLibrary(s, { resumed: true });
        // A restore that reopened nothing leaves the surface hidden, so fall back to the library rather than a bare drop zone.
        if (viewerRestorePending && !destroyed && viewer._tabs.length === 0) {
          if (viewer.dropZone) viewer.dropZone.style.display = '';
          if (!visible) {
            activate({ render: false });
            render();
          }
        }
        return;
      }
    }
    if (viewer._tabs.length === 0) {
      // No library opens on this path, so the restore never runs and the drop-zone hold is released here.
      if (viewerRestorePending && viewer.dropZone) viewer.dropZone.style.display = '';
      activate({ render: false });
      render();
    }
  })();

  Object.assign(api, {
    destroy() {
      destroyed = true;
      navObserver?.disconnect();
      drag.cancel();
      if (visible) deactivate();
      releaseFolderLock?.();
      releaseFolderLock = null;
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
      document.removeEventListener('keydown', onOpenShortcut, true);
      document.removeEventListener('keydown', onSelectAll, true);
      viewer.pdfViewerElem.removeEventListener('input', onInput, true);
      offRecents();
      if (!readOnly) viewer._dragOverlayLabelFor = priorDragLabel;
      if (manifestTimer !== null) {
        window.clearTimeout(manifestTimer);
        manifestTimer = null;
        if (store && manifest) store.writeManifest(manifest).catch(() => {});
      }
      preview.destroy();
      sessions.reset();
      results.dispose();
      engine.terminate();
      surface.remove();
      stageObserver.disconnect();
      pane.remove();
      viewer.pdfViewerElem.removeEventListener('pointerdown', trackEngagement, true);
      viewer.pdfViewerElem.removeEventListener('focusin', trackEngagement, true);
      barTitle?.remove();
      barControls?.remove();
      if (viewer._tabStrip) {
        viewer._tabStrip.removePinnedTab(homeTab);
        if (!viewer._tabStrip.pinnedCount()) viewer._tabStripMinTabs = 2;
        viewer._renderTabs();
      }
      openFolderItem?.remove();
      closeFolderItem?.remove();
      rebuildItem?.remove();
      storageItem?.remove();
      folderDropdown.destroy();
      sortDropdown.destroy();
      newDropdown.destroy();
      midDropdown?.destroy();
      folderMenu.remove();
      closeMovePicker();
      viewer.pdfViewerElem.removeEventListener('scribe-menu-state-change', syncFolderRows);
      if (ownsEditHooks) viewer.scribe.onAnnotationsEdited = null;
      const at = viewer._libraryInstances.indexOf(api);
      if (at >= 0) viewer._libraryInstances.splice(at, 1);
      if (viewer._lastPinned === api) viewer._lastPinned = null;
    },
  });
  return api;
}

/**
 * Install the document library: the pinned Library tab, its folder connection and the app-menu items that go with it.
 * @param {import('../basic-viewer/pdf-viewer.js').ScribePDFViewer} viewer
 * @param {{settings?: ?Object}} [options] - `settings` adjusts the search engine's defaults, `ENGINE_DEFAULTS` in searchEngine.js.
 */
export function installLibrary(viewer, { settings = null } = {}) {
  return createLibraryInstance(viewer, {
    kind: 'library', name: 'Library', glyph: FOLDER_TAB_SVG, persistPrefs: true, engineSettings: settings,
  });
}

/**
 * Open a PDF portfolio as a pinned tab listing its embedded files, the surface the library shows over a folder, here over the portfolio's own in-memory store.
 * A portfolio already open from the same library entry comes forward instead of opening twice.
 * @param {import('../basic-viewer/pdf-viewer.js').ScribePDFViewer} viewer
 * @param {import('../../js/containers/scribeDoc.js').ScribeDoc} doc - The portfolio document (its cover sheet and its files); the surface owns it from here on.
 * @param {string} name - Display name: the file name, as everywhere in the library.
 * @param {{libraryHash?: string, libraryRelPath?: string, libraryOwner?: number}} [fields] - Where it came from, when a library entry opened it.
 * @returns {Promise<LibraryInstance>}
 */
export async function openPortfolio(viewer, doc, name, fields = {}) {
  const twin = fields.libraryHash
    ? viewer._libraryInstances.find((i) => i.kind === 'portfolio' && i.libraryHash === fields.libraryHash && i.libraryOwner === (fields.libraryOwner ?? null))
    : null;
  if (twin) {
    await doc.close().catch(() => {});
    twin.show();
    return twin;
  }
  const store = new PortfolioStore(doc, name);
  const { collection } = doc.attachments;
  const api = createLibraryInstance(viewer, {
    kind: 'portfolio',
    name,
    glyph: PORTFOLIO_TAB_SVG,
    store,
    viewDefault: 'compact',
    previewDefault: true,
    showOthersDefault: true,
    persistPrefs: false,
    readOnly: true,
    emptyText: 'This portfolio has no files.',
    initialRelPath: collection?.initial ? store.relPathOfKey(collection.initial) : null,
    libraryHash: fields.libraryHash ?? null,
    libraryOwner: fields.libraryOwner ?? null,
    onClose: () => {
      api.destroy();
      store.dispose();
      doc.close().catch(() => {});
    },
  });
  return api;
}
