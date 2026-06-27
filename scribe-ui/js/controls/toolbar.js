// Toolbar building blocks shared by the viewer and editor apps: the icon-button and separator
// primitives and the three-zone shell, the toolbar-resident controls (page navigation, zoom, find),
// and the shared control stylesheet injected once per app.
import { ScribeViewer } from '../../viewer.js';
import {
  findText, nextMatch, prevMatch, goToMatch,
} from '../viewerSearch.js';

/**
 * Build a round icon button matching the control stylesheet's `.cr-icon-button`.
 * Suppresses the default mousedown (so clicking a button never steals canvas selection focus).
 * @param {string} title - Tooltip / accessible title.
 * @param {string} svgInnerHTML - SVG markup for the glyph.
 * @param {string} [ariaLabel] - Optional ARIA label (defaults to `title`).
 * @returns {HTMLSpanElement}
 */
export function makeIconButton(title, svgInnerHTML, ariaLabel) {
  const el = document.createElement('span');
  el.className = 'cr-icon-button';
  el.title = title;
  el.role = 'button';
  el.tabIndex = 0;
  el.ariaLabel = ariaLabel ?? title;

  const icon = document.createElement('span');
  icon.className = 'cr-icon';
  icon.innerHTML = svgInnerHTML;
  el.appendChild(icon);

  el.addEventListener('mousedown', (e) => e.preventDefault());
  return el;
}

/** @returns {HTMLSpanElement} A thin vertical toolbar separator. */
export function makeSeparator() {
  const sep = document.createElement('span');
  sep.className = 'vertical-separator';
  return sep;
}

/**
 * Build the three-zone toolbar shell. The caller fills `start`, `center`, and `end`.
 * @param {string} rootClass - The owning app's root class (used for the toolbar's scoped class).
 * @param {number} toolbarHeight - Bar height in px.
 * @param {number} iconSize - Icon size in px (sets the bar's line-height).
 * @returns {{ toolbarElem: HTMLDivElement, toolbarElemStart: HTMLDivElement, center: HTMLDivElement, toolbarElemEnd: HTMLDivElement }}
 */
export function makeToolbarShell(rootClass, toolbarHeight, iconSize) {
  const toolbarElem = document.createElement('div');
  toolbarElem.className = `${rootClass}-toolbar`;
  toolbarElem.style.width = '100%';
  toolbarElem.style.height = `${toolbarHeight}px`;
  toolbarElem.style.alignItems = 'center';
  toolbarElem.style.color = '#fff';
  toolbarElem.style.display = 'flex';
  toolbarElem.style.position = 'relative';
  toolbarElem.style.zIndex = '10';
  toolbarElem.style.lineHeight = `${iconSize}px`;
  toolbarElem.style.backgroundColor = '#323639';

  const toolbarElemStart = document.createElement('div');
  toolbarElemStart.style.flex = '1';

  const center = document.createElement('div');

  const toolbarElemEnd = document.createElement('div');
  toolbarElemEnd.style.flex = '1';
  toolbarElemEnd.style.display = 'flex';
  toolbarElemEnd.style.justifyContent = 'flex-end';
  toolbarElemEnd.style.alignItems = 'center';

  toolbarElem.appendChild(toolbarElemStart);
  toolbarElem.appendChild(center);
  toolbarElem.appendChild(toolbarElemEnd);

  return {
    toolbarElem, toolbarElemStart, center, toolbarElemEnd,
  };
}

const NAV_PREV_SVG = `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px">
<path d="m313-440 224 224-57 56-320-320 320-320 57 56-224 224h487v80H313Z" /></svg>`;
const NAV_NEXT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px">
<path d="M647-440H160v-80h487L423-744l57-56 320 320-320 320-57-56 224-224Z"/></svg>`;

/**
 * Build prev/next buttons and the page-number input group, wired to `scribe.displayPage`.
 * @param {import('../../viewer.js').ScribeViewer} scribe
 * @returns {{ prevElem: HTMLSpanElement, nextElem: HTMLSpanElement, pageInputGroup: HTMLDivElement, pageNumElem: HTMLInputElement, pageCountElem: HTMLSpanElement }}
 */
export function createPageNav(scribe) {
  const prevElem = makeIconButton('Previous page', NAV_PREV_SVG);
  const nextElem = makeIconButton('Next page', NAV_NEXT_SVG);

  const pageInputGroup = document.createElement('div');
  pageInputGroup.className = 'btn-group';
  pageInputGroup.style.display = 'inline-flex';

  const pageNumElem = document.createElement('input');
  pageNumElem.type = 'text';
  pageNumElem.className = 'form-control btn-sm';
  pageNumElem.name = 'pageNum';
  pageNumElem.autocomplete = 'off';
  pageNumElem.style.width = '3em';
  pageNumElem.style.display = 'inline-block';

  const pageCountElem = document.createElement('span');
  pageCountElem.style.display = 'inline-block';
  pageCountElem.style.minWidth = '0.5rem';
  pageCountElem.style.fontSize = '14px';
  pageCountElem.style.paddingLeft = '0.5rem';

  pageInputGroup.appendChild(pageNumElem);
  pageInputGroup.appendChild(document.createTextNode(' / '));
  pageInputGroup.appendChild(pageCountElem);

  nextElem.addEventListener('click', () => scribe.displayPage(scribe.state.cp.n + 1, true, false));
  prevElem.addEventListener('click', () => scribe.displayPage(scribe.state.cp.n - 1, true, false));
  pageNumElem.addEventListener('keyup', (event) => {
    if (event.key === 'Enter') scribe.displayPage(parseInt(pageNumElem.value, 10) - 1, true, false);
  });

  return {
    prevElem, nextElem, pageInputGroup, pageNumElem, pageCountElem,
  };
}

const ZOOM_OUT_SVG = `<svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" focusable="false" role="none" style="pointer-events: none; display: block; width: 100%; height: 100%;">
<g><path d="M19 13H5v-2h14v2z"></path></g></svg>`;
const ZOOM_IN_SVG = `<svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" focusable="false" role="none" style="pointer-events: none; display: block; width: 100%; height: 100%;">
<g><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"></path></g></svg>`;

/**
 * Build the zoom-out/zoom-in control group, wired to `scribe.zoom` about the stage center.
 * @param {import('../../viewer.js').ScribeViewer} scribe
 * @returns {{ zoomControls: HTMLSpanElement, zoomInElem: HTMLSpanElement, zoomOutElem: HTMLSpanElement }}
 */
export function createZoomControls(scribe) {
  const zoomControls = document.createElement('span');
  const zoomOutElem = makeIconButton('Zoom out', ZOOM_OUT_SVG);
  const zoomInElem = makeIconButton('Zoom in', ZOOM_IN_SVG);

  zoomControls.appendChild(zoomOutElem);
  zoomControls.appendChild(zoomInElem);

  zoomInElem.addEventListener('click', () => scribe.zoom(1.1, scribe.getStageCenter()));
  zoomOutElem.addEventListener('click', () => scribe.zoom(0.9, scribe.getStageCenter()));

  return { zoomControls, zoomInElem, zoomOutElem };
}

const SEARCH_SVG = `<svg xmlns="http://www.w3.org/2000/svg" height="20" width="20" viewBox="0 -960 960 960" fill="currentColor">
<path d="M784-120 532-372q-30 24-69 38t-83 14q-109 0-184.5-75.5T120-580q0-109 75.5-184.5T380-840q109 0 184.5 75.5T640-580q0 44-14 83t-38 69l252 252-56 56ZM380-400q75 0 127.5-52.5T560-580q0-75-52.5-127.5T380-760q-75 0-127.5 52.5T200-580q0 75 52.5 127.5T380-400Z"/>
</svg>`;
const SEARCH_PREV_SVG = `<svg xmlns="http://www.w3.org/2000/svg" height="20" width="20" viewBox="0 -960 960 960" fill="currentColor">
<path d="M480-528 296-344l-56-56 240-240 240 240-56 56-184-184Z"/></svg>`;
const SEARCH_NEXT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" height="20" width="20" viewBox="0 -960 960 960" fill="currentColor">
<path d="M480-344 240-584l56-56 184 184 184-184 56 56-240 240Z"/></svg>`;
const CLOSE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" height="20" width="20" viewBox="0 -960 960 960" fill="currentColor">
<path d="m256-200-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z"/></svg>`;

/**
 * Build the find/search bar and its behaviors.
 * @param {import('../../viewer.js').ScribeViewer} scribe
 * @param {HTMLElement} rootElem - The app's root element (used to scope the Ctrl/Cmd+F shortcut).
 * @returns {{
 *   searchElem: HTMLSpanElement, findGroupElem: HTMLSpanElement,
 *   searchInputElem: HTMLInputElement, searchCounterElem: HTMLSpanElement,
 *   openSearch: () => void, closeSearch: () => void, runSearch: (q: string) => Promise<void>,
 *   updateSearchCounter: () => void, resetSearch: () => void,
 *   installFindShortcut: () => (() => void)
 * }}
 */
export function createSearchBar(scribe, rootElem) {
  const searchElem = makeIconButton('Find', SEARCH_SVG);

  const findGroupElem = document.createElement('span');
  findGroupElem.className = 'scribe-search-group';
  findGroupElem.style.display = 'none';

  const searchInputElem = document.createElement('input');
  searchInputElem.type = 'text';
  searchInputElem.className = 'scribe-search-input';
  searchInputElem.placeholder = 'Find';
  searchInputElem.autocomplete = 'off';
  searchInputElem.spellcheck = false;

  const searchCounterElem = document.createElement('span');
  searchCounterElem.className = 'scribe-search-count';

  const searchPrevElem = makeIconButton('Previous match', SEARCH_PREV_SVG);
  const searchNextElem = makeIconButton('Next match', SEARCH_NEXT_SVG);
  const searchCloseElem = makeIconButton('Close', CLOSE_SVG);

  findGroupElem.appendChild(searchInputElem);
  findGroupElem.appendChild(searchCounterElem);
  findGroupElem.appendChild(searchPrevElem);
  findGroupElem.appendChild(searchNextElem);
  findGroupElem.appendChild(searchCloseElem);

  function updateSearchCounter() {
    const s = scribe._searchState;
    if (!s.search) searchCounterElem.textContent = '';
    else if (!s.matchList.length) searchCounterElem.textContent = 'No results';
    else searchCounterElem.textContent = `${s.activeMatch + 1}/${s.matchList.length}`;
  }

  /** @param {string} query */
  function runSearch(query) {
    if (!scribe.doc || scribe.doc.pageMetrics.length === 0) return Promise.resolve();
    scribe.state.searchMode = true;
    findText(scribe, query);
    updateSearchCounter();
    if (scribe._searchState.matchList.length) return goToMatch(scribe, 0);
    return Promise.resolve();
  }

  function openSearch() {
    findGroupElem.style.display = 'inline-flex';
    searchElem.classList.add('active');
    scribe.state.searchMode = true;
    searchInputElem.focus();
    searchInputElem.select();
    if (searchInputElem.value.trim()) runSearch(searchInputElem.value);
  }

  function closeSearch() {
    findGroupElem.style.display = 'none';
    searchElem.classList.remove('active');
    scribe.state.searchMode = false;
    findText(scribe, '');
    updateSearchCounter();
  }

  function resetSearch() {
    findGroupElem.style.display = 'none';
    searchElem.classList.remove('active');
    searchInputElem.value = '';
    scribe.state.searchMode = false;
    updateSearchCounter();
  }

  searchElem.addEventListener('click', () => {
    if (findGroupElem.style.display === 'none') openSearch();
    else closeSearch();
  });

  let searchDebounce = null;
  searchInputElem.addEventListener('input', () => {
    if (searchDebounce) clearTimeout(searchDebounce);
    const { value } = searchInputElem;
    searchDebounce = setTimeout(() => runSearch(value), 150);
  });
  searchInputElem.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) prevMatch(scribe).then(() => updateSearchCounter());
      else nextMatch(scribe).then(() => updateSearchCounter());
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeSearch();
    }
  });

  searchPrevElem.addEventListener('click', () => prevMatch(scribe).then(() => updateSearchCounter()));
  searchNextElem.addEventListener('click', () => nextMatch(scribe).then(() => updateSearchCounter()));
  searchCloseElem.addEventListener('click', () => closeSearch());

  /**
   * Install the document-level Ctrl/Cmd+F shortcut that opens the bar (scoped by keyboardScope).
   * @returns {() => void} A cleanup function that removes the listener.
   */
  function installFindShortcut() {
    const handler = (event) => {
      if (!((event.key === 'f' || event.key === 'F') && (event.ctrlKey || event.metaKey) && !event.altKey)) return;
      if (scribe.opt.keyboardScope === 'off') return;
      const target = event.target instanceof Node ? event.target : null;
      const insideThis = !!(target && rootElem.contains(target));
      const isActive = ScribeViewer.getActiveViewer() === scribe;
      const inScope = scribe.opt.keyboardScope === 'global' ? isActive : (insideThis || isActive);
      if (!inScope) return;
      event.preventDefault();
      openSearch();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }

  return {
    searchElem,
    findGroupElem,
    searchInputElem,
    searchCounterElem,
    openSearch,
    closeSearch,
    runSearch,
    updateSearchCounter,
    resetSearch,
    installFindShortcut,
  };
}

/** @type {Set<string>} Root classes already injected, so each is added at most once. */
const injected = new Set();

/**
 * Inject the shared control stylesheet scoped to `rootClass`, once per class.
 * @param {string} [rootClass='scribe-pdf-viewer']
 */
export function addControlStyles(rootClass = 'scribe-pdf-viewer') {
  if (injected.has(rootClass)) return;
  injected.add(rootClass);

  const r = rootClass;
  const style = document.createElement('style');
  style.type = 'text/css';

  const css = `
    .${r} .cr-icon {
      align-items: center;
      display: inline-flex;
      justify-content: center;
      position: relative;
      vertical-align: middle;
      fill: currentcolor;
      stroke: none;
      width: var(--scribe-icon-size, 32px);
      height: var(--scribe-icon-size, 32px);
    }

    /* Glyphs keep their authored size when it fits, but shrink to the icon box on a short toolbar. */
    .${r} .cr-icon svg {
      max-width: 100%;
      max-height: 100%;
    }

    .${r} .cr-icon-button {
      -webkit-tap-highlight-color: transparent;
      border-radius: 50%;
      cursor: pointer;
      display: inline-flex;
      flex-shrink: 0;
      height: var(--scribe-icon-size, 32px);
      outline: 0px;
      overflow: hidden;
      position: relative;
      user-select: none;
      vertical-align: middle;
      width: var(--scribe-icon-size, 32px);
    }

    .${r} .cr-icon-button:hover {
      background: rgba(255, 255, 255, .08);
      border-radius: 50%;
    }

    .${r} .cr-icon-button.active {
      background: rgba(255, 255, 255, .2);
    }

    .${r} .highlight-color-btn {
      width: 18px;
      height: 18px;
      border-radius: 50%;
      cursor: pointer;
      border: 2px solid transparent;
      box-sizing: border-box;
      display: inline-block;
      position: relative;
      top: 3px;
    }

    .${r} .highlight-color-btn:hover {
      border-color: rgba(255, 255, 255, .5);
    }

    .${r} .highlight-color-btn.active {
      border-color: #fff;
    }

    .${r} .highlight-comment-icon {
      position: absolute;
      font-size: 14px;
      cursor: default;
      z-index: 15;
      user-select: none;
      pointer-events: auto;
    }

    .${r} .highlight-comment-tooltip {
      position: absolute;
      background: #333;
      color: #fff;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 13px;
      max-width: 300px;
      white-space: pre-wrap;
      pointer-events: none;
      z-index: 20;
    }

    .${r} .vertical-separator {
      background: rgba(255, 255, 255, .3);
      height: 15px;
      width: 1px;
      margin-left: 10px;
      margin-right: 10px;
      display: inline-block;
    }

    .${r} .upload_dropZone {
      border: solid;
      border-width: 3px;
      outline: 2px dashed #323639;
      outline-offset: -12px;
      text-align: center;
      transition:
        outline-offset 0.2s ease-out,
        outline-color 0.3s ease-in-out,
        background-color 0.2s ease-out;
    }

    .${r} .upload_dropZone.highlight {
      outline-offset: -4px;
      outline-color: #191b1d;
      background-color: rgb(106, 111, 114);
    }

    .${r}-toolbar input {
      background: rgba(0, 0, 0, .5);
      border: none;
      caret-color: currentColor;
      color: inherit;
      font-family: inherit;
      line-height: inherit;
      margin: 0 4px;
      outline: 0;
      padding: 0 4px;
      text-align: center;
      width: 5ch;
    }

    .${r} .scribe-search-group {
      align-items: center;
    }

    .${r}-toolbar input.scribe-search-input {
      width: 14ch;
      text-align: left;
    }

    .${r} .scribe-search-count {
      font-size: 13px;
      min-width: 6ch;
      padding: 0 6px;
      text-align: center;
      white-space: nowrap;
    }

    .${r} .scribe-scrollbar {
      position: absolute;
      z-index: 9;
      touch-action: none;
      user-select: none;
    }

    .${r} .scribe-scrollbar-v {
      top: 0;
      right: 0;
      width: 12px;
    }

    .${r} .scribe-scrollbar-h {
      left: 0;
      bottom: 0;
      height: 12px;
    }

    .${r} .scribe-scrollbar-thumb {
      position: absolute;
      background: rgba(255, 255, 255, .35);
      border-radius: 6px;
      transition: background 0.15s ease-in-out;
    }

    .${r} .scribe-scrollbar-thumb:hover,
    .${r} .scribe-scrollbar-thumb.dragging {
      background: rgba(255, 255, 255, .6);
    }

    .${r} .scribe-scrollbar-v .scribe-scrollbar-thumb {
      left: 2px;
      width: 8px;
    }

    .${r} .scribe-scrollbar-h .scribe-scrollbar-thumb {
      top: 2px;
      height: 8px;
    }

    .${r} .scribe-thumb-panel {
      position: absolute;
      left: 0;
      overflow-y: auto;
      overflow-x: hidden;
      box-sizing: border-box;
      background: #2b2f31;
      border-right: 1px solid rgba(0, 0, 0, .4);
      padding: 8px 0;
      z-index: 7;
    }

    .${r} .scribe-thumb-panel::-webkit-scrollbar {
      width: 10px;
    }

    .${r} .scribe-thumb-panel::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, .25);
      border-radius: 5px;
    }

    .${r} .scribe-thumb {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 3px;
      padding: 6px 4px;
      cursor: pointer;
    }

    .${r} .scribe-thumb-box {
      background: #fff;
      box-shadow: 0 1px 3px rgba(0, 0, 0, .5);
      overflow: hidden;
      box-sizing: border-box;
      border: 2px solid transparent;
    }

    .${r} .scribe-thumb-box img {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: contain;
    }

    .${r} .scribe-thumb-label {
      color: #bbb;
      font-size: 11px;
      line-height: 1;
      text-align: center;
      user-select: none;
    }

    .${r} .scribe-thumb:hover .scribe-thumb-box {
      border-color: rgba(255, 255, 255, .4);
    }

    .${r} .scribe-thumb.active .scribe-thumb-box {
      border-color: #4dd0e1;
    }

    .${r} .scribe-thumb.active .scribe-thumb-label {
      color: #fff;
    }
  `;

  style.appendChild(document.createTextNode(css));
  document.head.appendChild(style);
}
