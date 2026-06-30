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
  toolbarElemEnd.style.paddingRight = '8px';

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
  pageNumElem.style.width = '3.4em';
  pageNumElem.style.display = 'inline-block';
  pageNumElem.style.fontVariantNumeric = 'tabular-nums';

  const pageCountElem = document.createElement('span');
  pageCountElem.style.display = 'inline-block';
  pageCountElem.style.minWidth = '2.6em';
  pageCountElem.style.textAlign = 'left';
  pageCountElem.style.fontSize = '14px';
  pageCountElem.style.fontVariantNumeric = 'tabular-nums';
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

  zoomInElem.addEventListener('click', () => scribe.zoom(1.1, scribe.getViewportCenter()));
  zoomOutElem.addEventListener('click', () => scribe.zoom(0.9, scribe.getViewportCenter()));

  return { zoomControls, zoomInElem, zoomOutElem };
}

const ROTATE_LEFT_SVG = `<svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" focusable="false" role="none" style="pointer-events: none; display: block; width: 100%; height: 100%;">
<path d="M7.11 8.53L5.7 7.11C4.8 8.27 4.24 9.61 4.07 11h2.02c.14-.87.49-1.72 1.02-2.47zM6.09 13H4.07c.17 1.39.72 2.73 1.62 3.89l1.41-1.42c-.52-.75-.87-1.59-1.01-2.47zm1.01 5.32c1.16.9 2.51 1.44 3.9 1.61V17.9c-.87-.15-1.71-.49-2.46-1.03L7.1 18.32zM13 4.07V1L8.45 5.55 13 10V6.09c2.84.48 5 2.94 5 5.91s-2.16 5.43-5 5.91v2.02c3.95-.49 7-3.85 7-7.93s-3.05-7.44-7-7.93z"></path></svg>`;
const ROTATE_RIGHT_SVG = `<svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" focusable="false" role="none" style="pointer-events: none; display: block; width: 100%; height: 100%;">
<path d="M15.55 5.55L11 1v3.07C7.06 4.56 4 7.92 4 12s3.05 7.44 7 7.93v-2.02c-2.84-.48-5-2.94-5-5.91s2.16-5.43 5-5.91V10l4.55-4.45zM19.93 11c-.17-1.39-.72-2.73-1.62-3.89l-1.42 1.42c.54.75.88 1.6 1.02 2.47h2.02zM13 17.9v2.02c1.39-.17 2.74-.71 3.9-1.61l-1.44-1.44c-.75.54-1.59.89-2.46 1.03zm3.89-2.42l1.42 1.41c.9-1.16 1.45-2.5 1.62-3.89h-2.02c-.14.87-.48 1.72-1.02 2.47z"></path></svg>`;

/**
 * Build the rotate-left/rotate-right control group, wired to `scribe.rotatePage` on the current page.
 * @param {import('../../viewer.js').ScribeViewer} scribe
 * @returns {{ rotateControls: HTMLSpanElement, rotateLeftElem: HTMLSpanElement, rotateRightElem: HTMLSpanElement }}
 */
export function createRotateControls(scribe) {
  const rotateControls = document.createElement('span');
  const rotateLeftElem = makeIconButton('Rotate left', ROTATE_LEFT_SVG);
  const rotateRightElem = makeIconButton('Rotate right', ROTATE_RIGHT_SVG);

  rotateControls.appendChild(rotateLeftElem);
  rotateControls.appendChild(rotateRightElem);

  rotateLeftElem.addEventListener('click', () => scribe.rotatePage(scribe.state.cp.n, -90));
  rotateRightElem.addEventListener('click', () => scribe.rotatePage(scribe.state.cp.n, 90));

  return { rotateControls, rotateLeftElem, rotateRightElem };
}

let printing = false;

/**
 * Export `scribe.doc` to PDF and hand it to the browser's print dialog.
 * @param {import('../../viewer.js').ScribeViewer} scribe
 * @param {object} [opts]
 * @param {?Array<number>} [opts.pageArr=null] - 0-based page indices to print; null prints the whole document.
 * @returns {Promise<boolean>} Whether the print dialog was opened.
 */
async function printDocument(scribe, { pageArr = null } = {}) {
  const doc = scribe?.doc;
  if (!doc || printing) return false;
  printing = true;
  try {
    // Match the editor's Export defaults: keep the original page content and append edits as an invisible layer,
    // so print fidelity equals what a saved PDF would show.
    const options = { displayMode: 'invis', addOverlay: true };
    if (pageArr) options.pageArr = pageArr;
    const bytes = await doc.exportData('pdf', options);

    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));

    // Safari does not reliably print a PDF loaded in an iframe via contentWindow.print().
    // Open the PDF in a new tab instead (the originating click is a user gesture, so this is not pop-up-blocked)
    // and let the user print from there.
    const isSafari = typeof navigator !== 'undefined'
      && /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent);
    if (isSafari) {
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return true;
    }

    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.position = 'fixed';
    iframe.style.left = '-10000px';
    iframe.style.top = '0';
    iframe.style.width = '1px';
    iframe.style.height = '1px';
    iframe.style.border = '0';

    // `afterprint` is unreliable across browsers, so a timeout backstops the cleanup.
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      URL.revokeObjectURL(url);
      iframe.remove();
    };

    iframe.addEventListener('load', () => {
      const win = iframe.contentWindow;
      if (!win) { cleanup(); return; }
      win.addEventListener('afterprint', cleanup);
      try {
        win.focus();
        win.print();
      } catch (err) {
        console.error('print() failed:', err);
        cleanup();
      }
    }, { once: true });

    // Set src before attaching. A srcless iframe, once connected, fires a load for its initial about:blank document,
    // which would consume this one-shot listener and print a blank page.
    iframe.src = url;
    document.body.appendChild(iframe);
    setTimeout(cleanup, 60000);
    return true;
  } catch (err) {
    console.error('Print failed:', err);
    return false;
  } finally {
    printing = false;
  }
}

const PRINT_SVG = `<svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" focusable="false" role="none" style="pointer-events: none; display: block; width: 100%; height: 100%;">
<path d="M19 8H5c-1.66 0-3 1.34-3 3v6h4v4h12v-4h4v-6c0-1.66-1.34-3-3-3zm-3 11H8v-5h8v5zm3-7c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm-1-9H6v4h12V3z"></path></svg>`;

/**
 * Build the print control and its Ctrl/Cmd+P shortcut, wired to export the current document and open the browser print dialog.
 * @param {import('../../viewer.js').ScribeViewer} scribe
 * @param {HTMLElement} rootElem - The app's root element (used to scope the Ctrl/Cmd+P shortcut).
 * @returns {{ printControls: HTMLSpanElement, printElem: HTMLSpanElement, installPrintShortcut: () => (() => void) }}
 */
export function createPrintControls(scribe, rootElem) {
  const printControls = document.createElement('span');
  const printElem = makeIconButton('Print', PRINT_SVG);
  printControls.appendChild(printElem);

  // Show a busy state while the export runs (a large document takes a moment to assemble).
  const print = async () => {
    if (printElem.classList.contains('busy')) return;
    printElem.classList.add('busy');
    try {
      await printDocument(scribe);
    } finally {
      printElem.classList.remove('busy');
    }
  };

  printElem.addEventListener('click', print);

  /**
   * Install the document-level Ctrl/Cmd+P shortcut that prints (scoped by keyboardScope),
   * in place of the browser's default print-the-whole-page behavior.
   * @returns {() => void} A cleanup function that removes the listener.
   */
  function installPrintShortcut() {
    const handler = (event) => {
      if (!((event.key === 'p' || event.key === 'P') && (event.ctrlKey || event.metaKey) && !event.altKey)) return;
      if (scribe.opt.keyboardScope === 'off') return;
      const target = event.target instanceof Node ? event.target : null;
      const insideThis = !!(target && rootElem.contains(target));
      const isActive = ScribeViewer.getActiveViewer() === scribe;
      const inScope = scribe.opt.keyboardScope === 'global' ? isActive : (insideThis || isActive);
      if (!inScope) return;
      event.preventDefault();
      print();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }

  return { printControls, printElem, installPrintShortcut };
}

const OPEN_SVG = `<svg viewBox="0 -960 960 960" preserveAspectRatio="xMidYMid meet" focusable="false" role="none" style="pointer-events: none; display: block; width: 100%; height: 100%;">
<path d="M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h240l80 80h320q33 0 56.5 23.5T880-640H447l-80-80H160v480l96-320h684L837-217q-8 27-30 42t-49 15H160Zm84-80h516l72-240H316l-72 240Zm0 0 72-240-72 240Z"></path></svg>`;

/**
 * Build the "Open" control: a button (and a hidden multi-file input) that hands the chosen files to `onFiles`,
 * plus a scoped Ctrl/Cmd+O shortcut that opens the same picker.
 * @param {import('../../viewer.js').ScribeViewer} scribe
 * @param {HTMLElement} rootElem - The app's root element (used to scope the Ctrl/Cmd+O shortcut).
 * @param {(files: File[]) => void} onFiles - Called with the chosen files.
 * @returns {{ openControls: HTMLSpanElement, openElem: HTMLSpanElement, installOpenShortcut: () => (() => void) }}
 */
export function createOpenControls(scribe, rootElem, onFiles) {
  const openControls = document.createElement('span');
  const openElem = makeIconButton('Open', OPEN_SVG);
  openControls.appendChild(openElem);

  const inputElem = document.createElement('input');
  inputElem.type = 'file';
  inputElem.multiple = true;
  inputElem.style.display = 'none';
  openControls.appendChild(inputElem);

  openElem.addEventListener('click', () => inputElem.click());
  inputElem.addEventListener('change', () => {
    if (inputElem.files && inputElem.files.length > 0) onFiles([...inputElem.files]);
    // Clear so picking the same file again still fires `change`.
    inputElem.value = '';
  });

  /**
   * Install the document-level Ctrl/Cmd+O shortcut that opens the file picker (scoped by keyboardScope),
   * in place of the browser's default open behavior.
   * @returns {() => void} A cleanup function that removes the listener.
   */
  function installOpenShortcut() {
    const handler = (event) => {
      if (!((event.key === 'o' || event.key === 'O') && (event.ctrlKey || event.metaKey) && !event.altKey)) return;
      if (scribe.opt.keyboardScope === 'off') return;
      const target = event.target instanceof Node ? event.target : null;
      const insideThis = !!(target && rootElem.contains(target));
      const isActive = ScribeViewer.getActiveViewer() === scribe;
      const inScope = scribe.opt.keyboardScope === 'global' ? isActive : (insideThis || isActive);
      if (!inScope) return;
      event.preventDefault();
      inputElem.click();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }

  return { openControls, openElem, installOpenShortcut };
}

/**
 * Build the document tab strip: one chip per open document, each with a close button, for switching between them.
 * @param {object} cfg
 * @param {(index: number) => void} cfg.onSelect - Called when a tab is clicked.
 * @param {(index: number) => void} cfg.onClose - Called when a tab's close button is clicked.
 * @returns {{ tabStripElem: HTMLDivElement, render: (tabs: Array<{ name: string }>, activeIndex: number) => void }}
 */
export function createTabStrip({ onSelect, onClose }) {
  const tabStripElem = document.createElement('div');
  tabStripElem.className = 'scribe-tab-strip';

  /**
   * Rebuild the chips from the current tab list.
   * @param {Array<{ name: string }>} tabs
   * @param {number} activeIndex
   */
  function render(tabs, activeIndex) {
    tabStripElem.textContent = '';
    tabs.forEach((tab, i) => {
      const chip = document.createElement('div');
      chip.className = i === activeIndex ? 'scribe-tab active' : 'scribe-tab';
      chip.title = tab.name;

      const name = document.createElement('span');
      name.className = 'scribe-tab-name';
      name.textContent = tab.name;
      chip.appendChild(name);

      const close = document.createElement('span');
      close.className = 'scribe-tab-close';
      close.textContent = '×';
      close.role = 'button';
      close.ariaLabel = `Close ${tab.name}`;
      chip.appendChild(close);

      chip.addEventListener('click', () => onSelect(i));
      // Stop the click reaching the chip, so closing a tab never also selects it.
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        onClose(i);
      });

      tabStripElem.appendChild(chip);
    });
  }

  return { tabStripElem, render };
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

    .${r} .cr-icon-button.busy {
      opacity: .5;
      pointer-events: none;
    }

    .${r} .scribe-tab-strip {
      display: flex;
      align-items: stretch;
      width: 100%;
      background: #3c4043;
      border-top: 1px solid rgba(255, 255, 255, .08);
      overflow-x: auto;
      overflow-y: hidden;
      white-space: nowrap;
    }

    .${r} .scribe-tab {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 200px;
      padding: 0 8px;
      color: #cfcfcf;
      font-size: 13px;
      cursor: pointer;
      border-right: 1px solid rgba(255, 255, 255, .08);
      user-select: none;
    }

    .${r} .scribe-tab:hover {
      background: rgba(255, 255, 255, .06);
    }

    .${r} .scribe-tab.active {
      background: rgb(82, 86, 89);
      color: #fff;
    }

    .${r} .scribe-tab-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .${r} .scribe-tab-close {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      font-size: 14px;
      line-height: 1;
      color: #aaa;
    }

    .${r} .scribe-tab-close:hover {
      background: rgba(255, 255, 255, .15);
      color: #fff;
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

    /* Empty-state (no document) drop zone: a dashed region with centered "Choose file" content, styled to match
       the monochrome chrome. The dashed border lights up to the accent only on drag-over (the active-drag color). */
    .${r} .scribe-drop-region {
      position: absolute;
      inset: 30px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1.5px dashed rgba(255, 255, 255, .16);
      border-radius: 14px;
      transition: border-color .05s ease-out, background-color .05s ease-out;
    }

    .${r} .scribe-drop-zone.highlight .scribe-drop-region {
      border-color: #6aa0ff;
      background-color: rgba(91, 148, 255, .1);
    }

    .${r} .scribe-drop-content {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
    }

    .${r} .scribe-drop-icon { color: #9ea2a6; margin-bottom: 20px; }

    .${r} .scribe-drop-icon svg { width: 42px; height: 42px; }

    .${r} .scribe-drop-title {
      font-size: 17px;
      font-weight: 500;
      color: #dadce0;
      letter-spacing: .2px;
    }

    .${r} .scribe-drop-btn {
      margin-top: 22px;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 9px 18px;
      border-radius: 8px;
      background: rgba(255, 255, 255, .08);
      border: 1px solid rgba(255, 255, 255, .08);
      color: #e4e6e8;
      font-size: 13.5px;
      font-weight: 500;
      cursor: pointer;
      transition: background-color .15s ease-out;
    }

    .${r} .scribe-drop-btn:hover { background: rgba(255, 255, 255, .13); }

    .${r} .scribe-drop-btn svg { width: 16px; height: 16px; }

    .${r} .scribe-drop-hint {
      font-size: 12.5px;
      color: #83878b;
      margin-top: 14px;
    }

    .${r} .scribe-drop-loading { display: none; flex-direction: column; align-items: center; }

    .${r} .scribe-drop-zone.loading .scribe-drop-content { display: none; }

    .${r} .scribe-drop-zone.loading .scribe-drop-loading { display: flex; }

    .${r} .scribe-drop-spinner {
      width: 34px;
      height: 34px;
      border: 3px solid rgba(255, 255, 255, .12);
      border-top-color: #6aa0ff;
      border-radius: 50%;
      animation: scribe-drop-spin .7s linear infinite;
    }

    @keyframes scribe-drop-spin { to { transform: rotate(360deg); } }

    .${r} .scribe-drop-loading-text {
      margin-top: 18px;
      font-size: 14px;
      color: #9ea2a6;
      letter-spacing: .2px;
    }

    /* Shown/hidden by toggling opacity (not display) so it can fade in and out; pointer-events:none keeps it click-through. */
    .${r} .scribe-drag-overlay {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      opacity: 0;
      pointer-events: none;
      z-index: 9;
      background: rgba(91, 148, 255, .1);
      transition: opacity .06s ease-out;
    }

    .${r} .scribe-drag-frame {
      position: absolute;
      inset: 14px;
      border: 2px dashed #6aa0ff;
      border-radius: 14px;
    }

    .${r} .scribe-drag-pill {
      position: absolute;
      top: 26px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 9px 16px 9px 13px;
      border-radius: 8px;
      background: #2f6fed;
      color: #fff;
      font-size: 13.5px;
      font-weight: 500;
      letter-spacing: .2px;
      white-space: nowrap;
      box-shadow: 0 2px 6px rgba(0, 0, 0, .2);
    }

    .${r} .scribe-drag-pill svg {
      width: 17px;
      height: 17px;
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

    /* Floating find widget: opening it overlays content instead of reflowing the right-zone controls. */
    .${r} .scribe-search-group {
      position: absolute;
      top: calc(100% + 6px);
      right: 10px;
      z-index: 20;
      align-items: center;
      gap: 2px;
      padding: 5px 6px;
      background: #3c4043;
      border: 1px solid rgba(255, 255, 255, .12);
      border-radius: 8px;
      box-shadow: 0 6px 20px rgba(0, 0, 0, .45);
    }

    .${r}-toolbar input.scribe-search-input {
      width: 16ch;
      text-align: left;
      height: 26px;
      border-radius: 4px;
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
      overflow: hidden;
      box-sizing: border-box;
      background: #2b2f31;
      border-right: 1px solid rgba(0, 0, 0, .4);
      z-index: 7;
      transition: transform 180ms ease;
      will-change: transform;
      /* The panel is focusable so it can be the active pane.
         Its focus is shown by the active page's accent, not a default outline on the whole panel. */
      outline: none;
      /* On the panel root so it cascades to every thumbnail image and caption, preventing a click-drag across the rail from selecting them. */
      -webkit-user-select: none;
      user-select: none;
    }

    /* Inner scroll container; the resize handle is its sibling so it stays at the edge while this scrolls. */
    .${r} .scribe-thumb-scroll {
      position: absolute;
      top: 0;
      left: 0;
      bottom: 0;
      right: 6px;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 8px 0;
      box-sizing: border-box;
    }

    .${r} .scribe-thumb-scroll::-webkit-scrollbar {
      width: 10px;
    }

    .${r} .scribe-thumb-scroll::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, .25);
      border-radius: 5px;
    }

    .${r} .scribe-thumb-resize {
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      width: 6px;
      cursor: ew-resize;
      z-index: 8;
      touch-action: none;
    }

    .${r} .scribe-thumb-resize:hover {
      background: rgba(255, 255, 255, .15);
    }

    .${r} .scribe-thumb {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 3px;
      padding: 6px 4px;
    }

    .${r} .scribe-thumb-box {
      position: relative;
      background: #fff;
      box-shadow: 0 1px 3px rgba(0, 0, 0, .5);
      overflow: hidden;
      box-sizing: border-box;
      cursor: pointer;
    }

    .${r} .scribe-thumb-box img {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: contain;
    }

    .${r} .scribe-thumb-label {
      color: #bbb;
      font-size: 13px;
      line-height: 1;
      text-align: center;
    }

    .${r} .scribe-thumb-box:hover {
      outline: 2px solid rgba(255, 255, 255, .4);
    }

    /* Current page while the rail is not the active pane: a clearly visible gray ring (inactive-selection convention). */
    .${r} .scribe-thumb.active .scribe-thumb-box {
      outline: 3px solid #9ea2a6;
    }

    /* While the rail has keyboard focus it is the active pane,
       so the current page's ring switches to accent blue with an outer glow, cueing that keystrokes land here.
       The box-shadow repeats the drop shadow so the glow does not replace it. */
    .${r} .scribe-thumb-panel:focus-within .scribe-thumb.active .scribe-thumb-box {
      outline-color: rgba(40, 123, 181, 1);
      box-shadow: 0 0 0 5px rgba(40, 123, 181, .25), 0 1px 3px rgba(0, 0, 0, .5);
    }

    .${r} .scribe-thumb.active .scribe-thumb-label {
      color: #fff;
    }

    .${r} .scribe-thumb-rotate {
      position: absolute;
      top: 8px;
      right: 8px;
      z-index: 2;
      display: none;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border-radius: 4px;
      color: #fff;
      background: rgba(0, 0, 0, .55);
      cursor: pointer;
    }

    .${r} .scribe-thumb-box:hover .scribe-thumb-rotate {
      display: flex;
    }

    .${r} .scribe-thumb-box.editable {
      cursor: grab;
    }

    .${r} .scribe-thumb.dragging .scribe-thumb-box {
      opacity: .3;
    }

    /* A page held for a pending cut: dimmed until the cut is pasted or canceled (Escape). */
    .${r} .scribe-thumb.cut .scribe-thumb-box {
      opacity: .45;
    }

    .${r} .scribe-thumb-insert {
      position: absolute;
      left: 6px;
      right: 6px;
      height: 3px;
      margin-top: -2px;
      background: rgba(40, 123, 181, 1);
      border-radius: 2px;
      box-shadow: 0 0 6px rgba(40, 123, 181, .8);
      pointer-events: none;
      z-index: 50;
    }

    /* A batch-selected page gets the steel-blue ring the viewer uses for selected words and regions.
       Placed after the active rules so a selected current page stays blue, not gray. */
    .${r} .scribe-thumb.selected .scribe-thumb-box {
      outline: 3px solid rgba(40, 123, 181, 1);
    }

    /* Floating vertical action strip that pops up beside the rail, next to the selection; JS sets its left/top. */
    .${r} .scribe-thumb-batch {
      position: absolute;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      padding: 6px 5px;
      box-sizing: border-box;
      background: rgba(40, 43, 46, .97);
      border: 1px solid rgba(255, 255, 255, .1);
      border-radius: 10px;
      box-shadow: 0 6px 18px rgba(0, 0, 0, .5);
      z-index: 20;
    }

    .${r} .scribe-thumb-batch-count {
      color: #cfcfcf;
      font-size: 12px;
      font-weight: 600;
      padding: 2px 0;
      min-width: 14px;
      text-align: center;
    }

    .${r} .scribe-thumb-batch-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      border: none;
      border-radius: 50%;
      background: transparent;
      color: #e4e6e8;
      cursor: pointer;
      transition: background-color .12s ease-out;
    }

    .${r} .scribe-thumb-batch-btn svg {
      width: 20px;
      height: 20px;
    }

    .${r} .scribe-thumb-batch-btn:hover {
      background: rgba(255, 255, 255, .1);
    }

    .${r} .scribe-thumb-batch-delete:hover {
      background: rgba(217, 48, 37, .85);
      color: #fff;
    }

    /* Right-click page context menu, mounted on the viewer root and placed at the cursor by JS. */
    .${r} .scribe-thumb-menu {
      position: absolute;
      min-width: 150px;
      padding: 4px;
      background: rgba(31, 36, 38, .98);
      border: 1px solid rgba(255, 255, 255, .14);
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, .55);
      z-index: 60;
      font-size: 13px;
      color: #fff;
      user-select: none;
    }

    .${r} .scribe-thumb-menu-item {
      padding: 7px 12px;
      border-radius: 5px;
      cursor: pointer;
      white-space: nowrap;
    }

    .${r} .scribe-thumb-menu-item:hover {
      background: rgba(255, 255, 255, .14);
    }

    .${r} .scribe-thumb-menu-item.danger:hover {
      background: rgba(217, 48, 37, .85);
    }

    .${r} .scribe-thumb-menu-header {
      padding: 5px 12px 6px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: .04em;
      text-transform: uppercase;
      color: #9ea2a6;
    }

    .${r} .scribe-thumb-menu-divider {
      height: 0;
      margin: 4px 6px;
      border: none;
      border-top: 1px solid rgba(255, 255, 255, .1);
    }
  `;

  style.appendChild(document.createTextNode(css));
  document.head.appendChild(style);
}
