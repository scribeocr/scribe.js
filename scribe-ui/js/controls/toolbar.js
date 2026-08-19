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

const TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const WEEKDAY_FMT = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const MONTH_DAY_FMT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const MONTH_DAY_YEAR_FMT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const FULL_FMT = new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeStyle: 'short' });

/**
 * Render a timestamp at the specificity its age warrants.
 * A time today, a weekday for the rest of the week, then month and day, then month, day, and year.
 * @param {string} iso - UTC ISO-8601 instant.
 * @param {number} [now] - Epoch ms to measure the age against.
 * @returns {string} Empty when the timestamp is missing or unparseable.
 */
export function formatTimestamp(iso, now = Date.now()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const nowDate = new Date(now);
  // Counting whole local days rather than elapsed ms keeps the tier right when a daylight-saving shift makes the day 23 hours long.
  const days = Math.floor(Date.UTC(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()) / 86400000)
    - Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
  if (days === 0) return TIME_FMT.format(d);
  if (days >= 1 && days <= 6) return WEEKDAY_FMT.format(d);
  return d.getFullYear() === nowDate.getFullYear() ? MONTH_DAY_FMT.format(d) : MONTH_DAY_YEAR_FMT.format(d);
}

/**
 * Fill an element with a timestamp.
 * The full date and time goes in the element's title.
 * Leaves the element untouched when the timestamp is missing or unparseable.
 * @param {HTMLElement} elem
 * @param {string} iso - UTC ISO-8601 instant.
 * @param {string} [prefix] - Separator text drawn ahead of the timestamp.
 */
export function setTimestamp(elem, iso, prefix = '') {
  const text = formatTimestamp(iso);
  if (!text) return;
  elem.textContent = prefix + text;
  elem.title = FULL_FMT.format(new Date(iso));
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
  toolbarElem.style.boxSizing = 'border-box';
  toolbarElem.style.alignItems = 'center';
  toolbarElem.style.color = 'var(--scribe-ink)';
  toolbarElem.style.display = 'flex';
  toolbarElem.style.position = 'relative';
  // The toolbar is a stacking context, so its dropdowns can never out-stack a sibling overlay.
  // This must stay above the library surface at z-index 30, or the app menu opens invisibly behind it.
  toolbarElem.style.zIndex = '40';
  toolbarElem.style.lineHeight = `${iconSize}px`;
  toolbarElem.style.backgroundColor = 'var(--scribe-surface)';
  toolbarElem.style.borderBottom = '1px solid var(--scribe-line)';

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

/**
 * Wrap SVG shape markup in a 24x24 stroked line-icon (the toolbar's shared stroked-icon style) sized to fill its icon button.
 * The sidebar-toggle glyphs stay filled by design.
 * @param {string} inner - Path/shape markup.
 * @returns {string} The SVG markup for the icon.
 */
const lineIcon = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none;display:block;width:100%;height:100%;" aria-hidden="true">${inner}</svg>`;

export const EDIT_PAGES_SVG = lineIcon('<rect x="3.5" y="3.5" width="8" height="10.5" rx="1"/><rect x="12.5" y="10" width="8" height="10.5" rx="1"/>'
  + '<path d="M14 5.5h4"/><path d="M18 3.9 21 5.5 18 7.1Z" fill="currentColor" stroke="none"/>'
  + '<path d="M10 18.5H6"/><path d="M6 16.9 3 18.5 6 20.1Z" fill="currentColor" stroke="none"/>');

/** Scan corners around a letterform, for the Recognize Text mode. */
export const RECOGNIZE_SVG = lineIcon('<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/>'
  + '<path d="M9 15V9.8A0.8 0.8 0 0 1 9.8 9h4.4a0.8 0.8 0 0 1 0.8 0.8V15M9 12.6h6"/>');

const NAV_PREV_SVG = lineIcon('<path d="M15 6l-6 6 6 6"/>');
const NAV_NEXT_SVG = lineIcon('<path d="M9 6l6 6-6 6"/>');

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
  pageInputGroup.style.verticalAlign = 'middle';
  // Center the items on the cross axis so the "/" text node and page-count span align with the input's vertically centered value.
  // Under the default stretch they top-align their glyphs and the "/ N" total rides visibly higher than the page number.
  pageInputGroup.style.alignItems = 'center';

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
  pageCountElem.style.fontSize = '13px';
  pageCountElem.style.fontVariantNumeric = 'tabular-nums';
  pageCountElem.style.paddingLeft = '0.5rem';

  const pageSepElem = document.createElement('span');
  pageSepElem.className = 'scribe-page-sep';
  pageSepElem.textContent = '/';
  pageInputGroup.appendChild(pageNumElem);
  pageInputGroup.appendChild(pageSepElem);
  pageInputGroup.appendChild(pageCountElem);

  /**
   * @param {HTMLElement} btn
   * @param {number} dir - -1 for previous (slide left), 1 for next (slide right).
   */
  const slideIcon = (btn, dir) => {
    const icon = btn.querySelector('.cr-icon');
    if (!icon || !icon.animate) return;
    icon.animate(
      [{ transform: 'translateX(0)' }, { transform: `translateX(${dir * 2}px)`, offset: 0.5 }, { transform: 'translateX(0)' }],
      { duration: 220, easing: 'cubic-bezier(.4, 0, .2, 1)' },
    );
  };

  // Step by row, not page, so in two-page view "next" always moves the view (the facing page is already on screen).
  nextElem.addEventListener('click', () => { slideIcon(nextElem, 1); scribe.displayPage(scribe.rowStep(scribe.state.cp.n, 1), true, false); });
  prevElem.addEventListener('click', () => { slideIcon(prevElem, -1); scribe.displayPage(scribe.rowStep(scribe.state.cp.n, -1), true, false); });
  pageNumElem.addEventListener('keyup', (event) => {
    if (event.key === 'Enter') scribe.displayPage(parseInt(pageNumElem.value, 10) - 1, true, false);
  });

  return {
    prevElem, nextElem, pageInputGroup, pageNumElem, pageCountElem,
  };
}

export const ZOOM_OUT_SVG = lineIcon('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5M8.5 11h5"/>');
export const ZOOM_IN_SVG = lineIcon('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5M11 8.5v5M8.5 11h5"/>');

/**
 * Build the zoom-out/zoom-in control group, wired to `scribe.zoom` about the stage center.
 * @param {import('../../viewer.js').ScribeViewer} scribe
 * @returns {{ zoomControls: HTMLSpanElement, zoomInElem: HTMLSpanElement, zoomOutElem: HTMLSpanElement }}
 */
export function createZoomControls(scribe) {
  const zoomControls = document.createElement('span');
  zoomControls.style.display = 'inline-flex';
  zoomControls.style.alignItems = 'center';
  const zoomOutElem = makeIconButton('Zoom out', ZOOM_OUT_SVG);
  const zoomInElem = makeIconButton('Zoom in', ZOOM_IN_SVG);

  zoomControls.appendChild(zoomOutElem);
  zoomControls.appendChild(zoomInElem);

  zoomInElem.addEventListener('click', () => scribe.zoom(1.1, scribe.getViewportCenter()));
  zoomOutElem.addEventListener('click', () => scribe.zoom(0.9, scribe.getViewportCenter()));

  return { zoomControls, zoomInElem, zoomOutElem };
}

export const ROTATE_LEFT_SVG = lineIcon('<path d="M5.5 8.25A7.5 7.5 0 1 0 12 4.5"/><path d="M8.5 4.5 12 2.8 12 6.2Z" fill="currentColor" stroke="none"/>');
export const ROTATE_RIGHT_SVG = lineIcon('<path d="M18.5 8.25A7.5 7.5 0 1 1 12 4.5"/><path d="M15.5 4.5 12 2.8 12 6.2Z" fill="currentColor" stroke="none"/>');

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

  /**
   * Play a brief rotation animation on `btn`'s icon.
   * @param {HTMLElement} btn
   * @param {number} dir - -1 for rotate-left (counter-clockwise), 1 for rotate-right.
   */
  const nudgeIcon = (btn, dir) => {
    const icon = btn.querySelector('.cr-icon');
    if (!icon || !icon.animate) return;
    icon.animate(
      [{ transform: 'rotate(0deg)' }, { transform: `rotate(${dir * 22}deg)`, offset: 0.5 }, { transform: 'rotate(0deg)' }],
      { duration: 240, easing: 'cubic-bezier(.4, 0, .2, 1)' },
    );
  };

  rotateLeftElem.addEventListener('click', () => { nudgeIcon(rotateLeftElem, -1); scribe.rotatePage(scribe.state.cp.n, -90); });
  rotateRightElem.addEventListener('click', () => { nudgeIcon(rotateRightElem, 1); scribe.rotatePage(scribe.state.cp.n, 90); });

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

export const PRINT_SVG = lineIcon('<path d="M6 9V4h12v5M6 18H5a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-1M7 15h10v5H7z"/>');

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

export const OPEN_SVG = lineIcon('<path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>');

export const RECENT_SVG = lineIcon('<circle cx="12" cy="12" r="7.5"/><path d="M12 8.6v3.9l2.7 2"/>');

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

const MENU_SVG = lineIcon('<path d="M4 7h16M4 12h16M4 17h16"/>');

/**
 * Build the far-left app menu: a hamburger button whose dropdown collects document- and app-level actions.
 * The viewer seeds it with its own actions (Open, Print), and the returned extension API lets the editor append more (Combine, Split, a dark-mode toggle) without knowing the menu internals.
 * @param {string} rootClass - The owning app's root class, unused today but kept for symmetry with the other factories.
 * @returns {{
 *   menuWrap: HTMLSpanElement, triggerElem: HTMLSpanElement, menuElem: HTMLDivElement,
 *   addAction: (label: string, iconSvg: string, onClick: () => void, accel?: string) => HTMLDivElement,
 *   addToggle: (label: string, iconSvg: string, getState: () => boolean, onToggle: () => void) => { item: HTMLDivElement, sync: () => void },
 *   addSubmenu: (label: string, iconSvg: string) => { wrap: HTMLDivElement, setItems: (rows: Array<'sep' | { label: string, onClick: () => void }>) => void },
 *   addSeparator: () => HTMLDivElement, close: () => void, destroy: () => void,
 * }}
 */
// eslint-disable-next-line no-unused-vars
export function createAppMenu(rootClass) {
  const menuWrap = document.createElement('span');
  menuWrap.className = 'scribe-app-menu-wrap';

  const triggerElem = makeIconButton('Menu', MENU_SVG);
  const menuElem = document.createElement('div');
  menuElem.className = 'scribe-app-menu';
  menuElem.style.display = 'none';
  menuWrap.append(triggerElem, menuElem);

  /** @type {Array<() => void>} Toggle-item sync functions. */
  const toggleSyncs = [];
  const isOpen = () => menuElem.style.display !== 'none';
  const open = () => {
    for (const sync of toggleSyncs) sync();
    menuElem.style.display = 'block';
    triggerElem.classList.add('active');
  };
  const close = () => {
    menuElem.style.display = 'none';
    triggerElem.classList.remove('active');
    for (const w of menuElem.querySelectorAll('.scribe-app-menu-subwrap.sub-open')) w.classList.remove('sub-open');
  };
  triggerElem.addEventListener('click', (e) => { e.stopPropagation(); if (isOpen()) close(); else open(); });
  const onDocClick = (e) => {
    const target = /** @type {Node} */ (e.target);
    if (!isOpen() || menuElem.contains(target) || triggerElem.contains(target)) return;
    close();
  };
  document.addEventListener('click', onDocClick);

  const makeRow = (label, iconSvg) => {
    const item = document.createElement('div');
    item.className = 'scribe-app-menu-item';
    item.role = 'button';
    item.tabIndex = 0;
    const ic = document.createElement('span');
    ic.className = 'scribe-app-menu-ic';
    ic.innerHTML = iconSvg;
    item.append(ic, document.createTextNode(label));
    item.addEventListener('mousedown', (e) => e.preventDefault());
    return item;
  };

  const addAction = (label, iconSvg, onClick, accel) => {
    const item = makeRow(label, iconSvg);
    if (accel) {
      const accelElem = document.createElement('span');
      accelElem.className = 'scribe-app-menu-accel';
      accelElem.textContent = accel;
      item.appendChild(accelElem);
    }
    item.addEventListener('click', (e) => { e.stopPropagation(); close(); onClick(); });
    menuElem.appendChild(item);
    return item;
  };

  const addSubmenu = (label, iconSvg) => {
    const wrap = document.createElement('div');
    wrap.className = 'scribe-app-menu-subwrap';
    const row = makeRow(label, iconSvg);
    const chev = document.createElement('span');
    chev.className = 'scribe-app-menu-subchev';
    chev.textContent = '›';
    row.appendChild(chev);
    const sub = document.createElement('div');
    sub.className = 'scribe-app-menu scribe-app-menu-sub';
    wrap.append(row, sub);
    // Click as well as hover, for keyboards and touch.
    row.addEventListener('click', (e) => { e.stopPropagation(); wrap.classList.toggle('sub-open'); });
    wrap.addEventListener('mouseenter', () => wrap.classList.add('sub-open'));
    wrap.addEventListener('mouseleave', () => wrap.classList.remove('sub-open'));
    const setItems = (rows) => {
      sub.textContent = '';
      for (const r of rows) {
        if (r === 'sep') {
          const sep = document.createElement('div');
          sep.className = 'scribe-app-menu-sep';
          sub.appendChild(sep);
          continue;
        }
        const item = document.createElement('div');
        item.className = 'scribe-app-menu-item';
        item.role = 'button';
        item.tabIndex = 0;
        item.textContent = r.label;
        item.addEventListener('mousedown', (e) => e.preventDefault());
        item.addEventListener('click', (e) => { e.stopPropagation(); close(); r.onClick(); });
        sub.appendChild(item);
      }
      // An empty submenu hides its whole row rather than opening onto nothing.
      wrap.style.display = rows.length ? '' : 'none';
    };
    setItems([]);
    menuElem.appendChild(wrap);
    return { wrap, setItems };
  };

  const addToggle = (label, iconSvg, getState, onToggle) => {
    const item = makeRow(label, iconSvg);
    item.classList.add('scribe-app-menu-toggle');
    const sw = document.createElement('span');
    sw.className = 'scribe-app-menu-switch';
    item.appendChild(sw);
    const sync = () => item.classList.toggle('on', !!getState());
    // Toggling leaves the menu open so the switch is seen to flip.
    item.addEventListener('click', (e) => { e.stopPropagation(); onToggle(); sync(); });
    menuElem.appendChild(item);
    toggleSyncs.push(sync);
    sync();
    return { item, sync };
  };

  const addSeparator = () => {
    const sep = document.createElement('div');
    sep.className = 'scribe-app-menu-sep';
    menuElem.appendChild(sep);
    return sep;
  };

  const destroy = () => document.removeEventListener('click', onDocClick);

  return {
    menuWrap, triggerElem, menuElem, addAction, addToggle, addSubmenu, addSeparator, close, destroy,
  };
}

/**
 * Build the document tab strip: one chip per open document, each with a close button, for switching between them.
 * @param {object} cfg
 * @param {(index: number) => void} cfg.onSelect - Called when a tab is clicked.
 * @param {(index: number) => void} cfg.onClose - Called when a tab's close button is clicked.
 * @returns {{ tabStripElem: HTMLDivElement, render: (tabs: Array<{ name: string, asleep?: boolean, waking?: boolean }>, activeIndex: number) => void,
 *   setPinnedTab: (elem: ?HTMLElement) => void, setPinnedActive: (on: boolean) => void }}
 */
export function createTabStrip({ onSelect, onClose }) {
  const tabStripElem = document.createElement('div');
  tabStripElem.className = 'scribe-tab-strip';

  const laneElem = document.createElement('div');
  laneElem.className = 'scribe-tab-lane';

  /**
   * @param {string} icon
   * @param {string} label
   * @param {number} dir
   */
  const makePaddle = (icon, label, dir) => {
    const paddle = document.createElement('span');
    paddle.className = 'scribe-tab-paddle';
    paddle.innerHTML = icon;
    paddle.role = 'button';
    paddle.ariaLabel = label;
    paddle.addEventListener('click', () => {
      // iOS Safari does not clamp smooth programmatic scrolls, so edge taps would strand the lane on blank space past the tabs.
      const target = Math.max(0, Math.min(
        laneElem.scrollWidth - laneElem.clientWidth,
        laneElem.scrollLeft + dir * laneElem.clientWidth * 0.8,
      ));
      laneElem.scrollTo({ left: target });
    });
    return paddle;
  };
  const fadeLeft = document.createElement('span');
  fadeLeft.className = 'scribe-tab-fade left';
  const fadeRight = document.createElement('span');
  fadeRight.className = 'scribe-tab-fade right';
  tabStripElem.appendChild(makePaddle(NAV_PREV_SVG, 'Scroll tabs left', -1));
  tabStripElem.appendChild(fadeLeft);
  tabStripElem.appendChild(laneElem);
  tabStripElem.appendChild(fadeRight);
  tabStripElem.appendChild(makePaddle(NAV_NEXT_SVG, 'Scroll tabs right', 1));

  // A vertical wheel scrolls the lane horizontally (trackpad horizontal deltas already work natively).
  laneElem.addEventListener('wheel', (event) => {
    if (event.deltaY && !event.deltaX) {
      laneElem.scrollLeft += event.deltaY;
      event.preventDefault();
    }
  }, { passive: false });

  /** @type {?HTMLSpanElement} */
  let pinnedWrap = null;

  const syncOverflow = () => {
    tabStripElem.classList.toggle('overflowing', laneElem.scrollWidth > laneElem.clientWidth + 1);
    // The left fade's CSS offset reads this width, so it starts at the lane instead of under the pinned tab.
    if (pinnedWrap) tabStripElem.style.setProperty('--scribe-tab-pin-w', `${pinnedWrap.offsetWidth}px`);
  };
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(syncOverflow).observe(laneElem);

  /**
   * Mount `elem` as a pinned tab ahead of the scroll lane.
   * Pass null to unmount it.
   * @param {?HTMLElement} elem
   */
  function setPinnedTab(elem) {
    if (pinnedWrap) {
      pinnedWrap.remove();
      pinnedWrap = null;
      tabStripElem.style.removeProperty('--scribe-tab-pin-w');
    }
    if (!elem) return;
    pinnedWrap = document.createElement('span');
    pinnedWrap.className = 'scribe-tab-pin';
    pinnedWrap.appendChild(elem);
    const sep = document.createElement('span');
    sep.className = 'scribe-tab-pin-sep';
    pinnedWrap.appendChild(sep);
    tabStripElem.insertBefore(pinnedWrap, tabStripElem.firstChild);
    syncOverflow();
  }

  /**
   * Light the pinned tab as the active one.
   * While on, the lane's active chip renders inactive, since the pinned tab's surface covers the document.
   * @param {boolean} on
   */
  function setPinnedActive(on) {
    tabStripElem.classList.toggle('pin-active', on);
  }

  // Mounted on the viewer root lazily, since the strip has no parent yet at build time.
  const menuElem = document.createElement('div');
  menuElem.className = 'scribe-tab-menu';
  menuElem.style.display = 'none';

  function closeTabMenu() {
    menuElem.style.display = 'none';
    document.removeEventListener('pointerdown', onTabMenuOutside);
    document.removeEventListener('keydown', onTabMenuKey);
  }
  /** @param {PointerEvent} e */
  function onTabMenuOutside(e) {
    if (menuElem.contains(/** @type {Node} */ (e.target))) return;
    closeTabMenu();
  }
  /** @param {KeyboardEvent} e */
  function onTabMenuKey(e) {
    if (e.key === 'Escape') closeTabMenu();
  }

  /**
   * Open the tab context menu at the cursor.
   * @param {number} clientX @param {number} clientY
   * @param {string} name - The tab's document name.
   */
  function openTabMenu(clientX, clientY, name) {
    const host = tabStripElem.parentElement;
    if (!host) return;
    if (menuElem.parentElement !== host) host.appendChild(menuElem);
    menuElem.replaceChildren();
    const item = document.createElement('div');
    item.className = 'scribe-tab-menu-item';
    item.textContent = 'Copy name';
    item.addEventListener('click', () => {
      closeTabMenu();
      navigator.clipboard?.writeText(name);
    });
    menuElem.appendChild(item);
    // Show first so the menu has measurable dimensions, then clamp it inside the host.
    menuElem.style.display = '';
    const hostRect = host.getBoundingClientRect();
    const left = Math.min(clientX - hostRect.left, hostRect.width - menuElem.offsetWidth - 4);
    const top = Math.min(clientY - hostRect.top, hostRect.height - menuElem.offsetHeight - 4);
    menuElem.style.left = `${Math.max(4, left)}px`;
    menuElem.style.top = `${Math.max(4, top)}px`;
    // Deferred so the pointer sequence that opened the menu cannot immediately dismiss it.
    setTimeout(() => {
      document.addEventListener('pointerdown', onTabMenuOutside);
      document.addEventListener('keydown', onTabMenuKey);
    }, 0);
  }

  /**
   * Rebuild the chips from the current tab list.
   * @param {Array<{ name: string, asleep?: boolean, waking?: boolean }>} tabs
   * @param {number} activeIndex
   */
  function render(tabs, activeIndex) {
    // A menu left open over the rebuilt strip would still copy the name it captured from the old chip.
    closeTabMenu();
    laneElem.textContent = '';
    tabs.forEach((tab, i) => {
      const chip = document.createElement('div');
      chip.className = i === activeIndex ? 'scribe-tab active' : 'scribe-tab';
      if (tab.asleep) chip.classList.add('asleep');
      chip.title = tab.asleep && !tab.waking ? `${tab.name} — asleep to save memory` : tab.name;
      chip.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        openTabMenu(event.clientX, event.clientY, tab.name);
      });

      const name = document.createElement('span');
      name.className = 'scribe-tab-name';
      name.textContent = tab.name;
      chip.appendChild(name);

      if (tab.waking) {
        const spin = document.createElement('span');
        spin.className = 'scribe-tab-spin';
        chip.appendChild(spin);
      } else {
        const close = document.createElement('span');
        close.className = 'scribe-tab-close';
        close.textContent = '×';
        close.role = 'button';
        close.ariaLabel = `Close ${tab.name}`;
        chip.appendChild(close);
        // Stop the click reaching the chip, so closing a tab never also selects it.
        close.addEventListener('click', (event) => {
          event.stopPropagation();
          onClose(i);
        });
      }

      chip.addEventListener('click', () => onSelect(i));
      laneElem.appendChild(chip);
    });
    syncOverflow();
    const activeChip = laneElem.children[activeIndex];
    if (activeChip) activeChip.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  return {
    tabStripElem, render, setPinnedTab, setPinnedActive,
  };
}

const SEARCH_SVG = lineIcon('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>');
const SEARCH_PREV_SVG = lineIcon('<path d="M6 15l6-6 6 6"/>');
const SEARCH_NEXT_SVG = lineIcon('<path d="M6 9l6 6 6-6"/>');
const CLOSE_SVG = lineIcon('<path d="M6 6l12 12M18 6L6 18"/>');

/**
 * Build the find/search bar and its behaviors.
 * @param {import('../../viewer.js').ScribeViewer} scribe
 * @param {HTMLElement} rootElem - The app's root element (used to scope the Ctrl/Cmd+F shortcut).
 * @returns {{
 *   searchElem: HTMLSpanElement, findGroupElem: HTMLSpanElement,
 *   searchInputElem: HTMLInputElement, searchCounterElem: HTMLSpanElement,
 *   openSearch: () => void, closeSearch: () => void, runSearch: (q: string, targetPageN?: number, navigate?: boolean) => Promise<void>,
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

  /**
   * @param {string} query
   * @param {number} [targetPageN] - Land on this page's first match instead of the document's
   *   first, so a search primed from a known hit page doesn't yank the reader elsewhere.
   * @param {boolean} [navigate] - Pass false to refresh the matches and highlights without moving the view.
   */
  async function runSearch(query, targetPageN, navigate = true) {
    const doc = scribe.doc;
    if (!doc || doc.pageMetrics.length === 0) return;
    // Deferred-import text may still be extracting, so searching now would falsely report "No results".
    // The await can span a document switch, so bail if the active doc changed.
    if (doc._textReadySettle) {
      await doc.textReady;
      if (scribe.doc !== doc) return;
    }
    scribe.state.searchMode = true;
    findText(scribe, query);
    updateSearchCounter();
    if (!navigate) return;
    const { matchList } = scribe._searchState;
    if (matchList.length) {
      const onTarget = targetPageN != null ? matchList.findIndex((m) => m.pageN === targetPageN) : -1;
      await goToMatch(scribe, onTarget >= 0 ? onTarget : 0);
      updateSearchCounter();
    }
  }

  function openSearch() {
    if (!scribe.doc || !scribe.doc.pageMetrics || scribe.doc.pageMetrics.length === 0) return;
    findGroupElem.style.display = 'inline-flex';
    searchElem.classList.add('active');
    scribe.state.searchMode = true;
    searchInputElem.focus();
    searchInputElem.select();
    // A retained query gets its highlights back, but the view must not move until the user types or steps through matches.
    if (searchInputElem.value.trim()) runSearch(searchInputElem.value, undefined, false);
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
    /* Design tokens. Light is the default, and [data-theme="dark"] swaps to the dark palette.
       The document page itself is never themed, only the chrome. */
    .${r} {
      /* Pinch-zoom consults the whole ancestor chain, so this single declaration keeps Safari's page zoom from engaging on any touch inside the app.
         Engaged page zoom re-rasters the content-sized layer tree at gesture scale and jetsams the tab on iPhones.
         The document viewer's own pinch runs on touch events, which touch-action does not suppress. */
      touch-action: pan-x pan-y;
      --scribe-surface: #ffffff;
      --scribe-canvas: #f4f6fa;
      --scribe-sunken: #eef1f6;
      --scribe-line: #e4e8ef;
      --scribe-line-strong: #d7dce4;
      --scribe-hover: rgba(28, 42, 68, .06);
      --scribe-active: rgba(28, 98, 212, .10);
      --scribe-ink: #1f2530;
      --scribe-ink-2: #586170;
      --scribe-ink-3: #98a1b0;
      --scribe-accent: #1c62d4;
      --scribe-accent-hover: #1550ad;
      --scribe-accent-ink: #ffffff;
      --scribe-accent-soft: #e8f0fd;
      --scribe-accent-ring: rgba(28, 98, 212, .30);
      --scribe-note: #f4d06a;
      --scribe-danger: #d1493d;
      --scribe-danger-soft: #fbe9e7;
      --scribe-scrollbar: rgba(28, 42, 68, .26);
      --scribe-shadow-pop: 0 8px 28px rgba(20, 30, 60, .17);
      --scribe-menu-shadow: 0 4px 14px rgba(20, 30, 60, .13);
      --scribe-page-shadow: 0 1px 3px rgba(30, 26, 16, .18);
      --scribe-lift-shadow: 0 10px 24px rgba(20, 30, 60, .30);
      --scribe-plate: rgba(28, 42, 68, .09);
    }
    .${r}[data-theme="dark"] {
      --scribe-surface: #1c2028;
      --scribe-canvas: #12151b;
      --scribe-sunken: #262b34;
      --scribe-line: #2b313c;
      --scribe-line-strong: #3a4150;
      --scribe-hover: rgba(255, 255, 255, .06);
      --scribe-active: rgba(79, 139, 240, .16);
      --scribe-ink: #e8ebf2;
      --scribe-ink-2: #9aa4b3;
      --scribe-ink-3: #6b7482;
      --scribe-accent: #4f8bf0;
      --scribe-accent-hover: #6a9df3;
      --scribe-accent-ink: #ffffff;
      --scribe-accent-soft: #1e2c44;
      --scribe-accent-ring: rgba(79, 139, 240, .38);
      --scribe-note: #f0cd68;
      --scribe-danger: #ef7a6c;
      --scribe-danger-soft: #33201d;
      --scribe-scrollbar: rgba(255, 255, 255, .26);
      --scribe-shadow-pop: 0 10px 30px rgba(0, 0, 0, .55);
      --scribe-menu-shadow: 0 4px 14px rgba(0, 0, 0, .45);
      --scribe-page-shadow: 0 1px 3px rgba(0, 0, 0, .5);
      --scribe-lift-shadow: 0 12px 28px rgba(0, 0, 0, .7);
      --scribe-plate: rgba(255, 255, 255, .09);
    }

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
      border-radius: 7px;
      color: var(--scribe-ink-2);
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
      background: var(--scribe-hover);
      color: var(--scribe-ink);
      border-radius: 7px;
    }

    .${r} .cr-icon-button.active {
      background: var(--scribe-active);
      color: var(--scribe-accent);
    }

    /* An icon button grown to carry a text label, for toggles that name their mode. */
    .${r} .cr-labeled-button {
      width: auto;
      padding-right: 10px;
      align-items: center;
    }

    .${r} .cr-labeled-button .cr-btn-label {
      font-size: 12.5px;
      line-height: 1;
      white-space: nowrap;
    }

    .${r} .cr-icon-button.busy {
      opacity: .5;
      pointer-events: none;
    }

    /* A control that needs an open document is dimmed in place rather than hidden, so the bar never re-flows. */
    .${r} .cr-icon-button.disabled {
      color: color-mix(in srgb, var(--scribe-ink-2) 50%, var(--scribe-ink-3));
      cursor: default;
      pointer-events: none;
    }

    /* Far-left app menu: document/app actions in a dropdown, shared by the viewer and editor. */
    .${r} .scribe-app-menu-wrap {
      position: relative;
      display: inline-flex;
      align-items: center;
      /* Match the sibling .cr-icon-buttons (vertical-align: middle), since the default baseline value would otherwise make this wrap ride ~9px high. */
      vertical-align: middle;
    }
    .${r} .scribe-app-menu {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      z-index: 30;
      min-width: 214px;
      padding: 5px;
      background: var(--scribe-surface);
      border: 1px solid var(--scribe-line);
      border-radius: 10px;
      box-shadow: var(--scribe-menu-shadow);
    }
    .${r} .scribe-app-menu-item {
      display: flex;
      align-items: center;
      gap: 11px;
      padding: 8px 11px;
      border-radius: 6px;
      font-size: 13px;
      color: var(--scribe-ink);
      cursor: pointer;
      white-space: nowrap;
      user-select: none;
    }
    .${r} .scribe-app-menu-item:hover { background: var(--scribe-hover); }
    .${r} .scribe-app-menu-item.busy { opacity: .6; pointer-events: none; }
    .${r} .scribe-app-menu-item.disabled { color: var(--scribe-ink-3); cursor: default; }
    .${r} .scribe-app-menu-item.disabled:hover { background: none; }
    .${r} .scribe-app-menu-accel { margin-left: auto; padding-left: 26px; font-size: 12px; color: var(--scribe-ink-3); }
    .${r} .scribe-app-menu-subwrap { position: relative; }
    .${r} .scribe-app-menu-subchev { margin-left: auto; padding-left: 26px; font-size: 14px; line-height: 1; color: var(--scribe-ink-3); }
    .${r} .scribe-app-menu-sub { display: none; left: calc(100% - 6px); top: -5px; min-width: 190px; }
    .${r} .scribe-app-menu-subwrap.sub-open .scribe-app-menu-sub { display: block; }

    /* Fill & Sign: FS2b floating pill palette (draggable; phone raises it above the dock). */
    .${r} .scribe-fs-pal { position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%); z-index: 30;
      background: var(--scribe-surface); border: 1px solid var(--scribe-line); border-radius: 10px;
      box-shadow: var(--scribe-menu-shadow); padding: 4px; display: flex; gap: 2px; align-items: center; cursor: grab; }
    .${r} .scribe-fs-grip { width: 18px; height: 24px; color: var(--scribe-ink-3); display: flex; align-items: center; justify-content: center; }
    .${r} .scribe-fs-grip svg { width: 16px; height: 16px; fill: currentColor; }
    .${r}.scribe-phone .scribe-fs-pal { bottom: 74px; }
    .${r} .scribe-fs-menu { position: absolute; bottom: calc(100% + 6px); right: 0; min-width: 210px;
      background: var(--scribe-surface); border: 1px solid var(--scribe-line); border-radius: 8px;
      box-shadow: var(--scribe-menu-shadow); padding: 4px; z-index: 31; }
    .${r} .scribe-fs-menu-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 5px;
      cursor: pointer; color: var(--scribe-ink); font-size: 12.5px; }
    .${r} .scribe-fs-menu-item:hover { background: var(--scribe-hover); }
    .${r} .scribe-fs-menu-prev { flex: 1; height: 30px; display: flex; align-items: center; }
    .${r} .scribe-fs-menu-prev svg, .${r} .scribe-fs-menu-prev img { max-width: 150px; max-height: 30px; }
    .${r} .scribe-fs-menu-del { width: 20px; height: 20px; border-radius: 4px; display: flex; align-items: center;
      justify-content: center; color: var(--scribe-ink-3); font-size: 14px; }
    .${r} .scribe-fs-menu-del:hover { background: var(--scribe-hover); color: #d1493d; }
    .${r} .scribe-fs-menu-ic { width: 18px; height: 18px; display: flex; }
    .${r} .scribe-fs-menu-ic svg { width: 16px; height: 16px; }

    /* Fill & Sign: FS3a centered signature dialog. The drawing/preview surfaces stay paper-white in
       both themes — a signature is made on paper. */
    .${r} .scribe-fs-scrim { position: absolute; inset: 0; background: rgba(15, 18, 26, .42); z-index: 60;
      display: flex; align-items: center; justify-content: center; }
    .${r} .scribe-fs-dialog { width: min(620px, calc(100% - 32px)); background: var(--scribe-surface);
      border: 1px solid var(--scribe-line); border-radius: 12px; box-shadow: var(--scribe-menu-shadow);
      padding: 16px; color: var(--scribe-ink); }
    .${r} .scribe-fs-dlg-title { font-size: 15px; font-weight: 650; margin-bottom: 10px; }
    .${r} .scribe-fs-dlg-body { display: grid; }
    .${r} .scribe-fs-dlg-body > * { grid-area: 1 / 1; }
    .${r} .scribe-fs-pane-off { visibility: hidden; pointer-events: none; }
    .${r} .scribe-fs-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--scribe-line); margin-bottom: 12px; }
    .${r} .scribe-fs-tab { appearance: none; background: none; border: none; padding: 7px 12px; font-size: 13px;
      color: var(--scribe-ink-2); cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; }
    .${r} .scribe-fs-tab.active { color: var(--scribe-accent); border-bottom-color: var(--scribe-accent); font-weight: 650; }
    .${r} .scribe-fs-draw { width: 560px; max-width: 100%; height: 180px; border: 1px dashed var(--scribe-line-strong);
      border-radius: 8px; background: #fff; cursor: crosshair; display: block; touch-action: none; }
    .${r} .scribe-fs-btn { appearance: none; background: none; border: 1px solid var(--scribe-line-strong);
      border-radius: 7px; padding: 7px 14px; font-size: 13px; color: var(--scribe-ink); cursor: pointer; margin-top: 8px; }
    .${r} .scribe-fs-btn:hover { background: var(--scribe-hover); }
    .${r} .scribe-fs-btn-primary { background: var(--scribe-accent); border-color: var(--scribe-accent); color: #fff; font-weight: 650; }
    .${r} .scribe-fs-dlg-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
    .${r} .scribe-fs-type-input { width: 100%; box-sizing: border-box; font-size: 14px; padding: 8px 10px;
      border: 1px solid var(--scribe-line-strong); border-radius: 7px; background: var(--scribe-surface); color: var(--scribe-ink); }
    .${r} .scribe-fs-fonts { display: flex; gap: 6px; margin: 10px 0; flex-wrap: wrap; }
    .${r} .scribe-fs-font { appearance: none; background: none; border: 1px solid var(--scribe-line); border-radius: 7px;
      padding: 0 10px; font-size: 16px; color: var(--scribe-ink); cursor: pointer;
      height: 34px; line-height: 1; display: inline-flex; align-items: center; }
    .${r} .scribe-fs-font.active { border-color: var(--scribe-accent); box-shadow: 0 0 0 2px var(--scribe-accent-ring); }
    .${r} .scribe-fs-type-preview { height: 88px; box-sizing: border-box; line-height: 1.2;
      display: flex; align-items: center; justify-content: center;
      font-size: 44px; border: 1px dashed var(--scribe-line-strong); border-radius: 8px; background: #fff;
      color: #101010; padding: 8px; overflow: hidden; }
    .${r} .scribe-fs-bgtoggle { display: flex; gap: 6px; align-items: center; font-size: 12.5px;
      color: var(--scribe-ink-2); margin: 8px 0; }
    /* Capped so a tall upload cannot outgrow the drawing pane and resize the dialog under the user.
       Only the displayed size shrinks — the saved PNG comes from the canvas backing store. */
    .${r} .scribe-fs-img-preview { background: repeating-conic-gradient(#eceff4 0 25%, #fff 0 50%) 0 0/16px 16px;
      border: 1px dashed var(--scribe-line-strong); border-radius: 8px; display: block; max-width: 100%;
      max-height: 150px; }
    .${r} .scribe-fs-file { font-size: 12.5px; color: var(--scribe-ink-2); display: block; margin-bottom: 4px; }
    /* Coarse-pointer (touch-primary) sizing: platform-minimum 44px targets, and 16px input fonts because iOS zooms the page when focusing any input smaller.
       Keyed on the state class the app constructor sets rather than a media query, so embedders and tests can force either mode. */
    .${r}.scribe-coarse .scribe-app-menu-item { min-height: 44px; }
    .${r}.scribe-coarse input,
    .${r}.scribe-coarse textarea,
    .${r}.scribe-coarse [contenteditable] { font-size: 16px; }
    /* A long press starts the platform's own text selection, which sweeps the zoom layer's unscaled text layout and jetsams the tab on iPhones.
       The custom engine owns document selection, so native selection and the long-press callout stay off everywhere on touch devices. */
    .${r}.scribe-coarse,
    .${r}.scribe-coarse * {
      -webkit-user-select: none;
      user-select: none;
      -webkit-touch-callout: none;
    }
    .${r}.scribe-coarse input,
    .${r}.scribe-coarse textarea,
    .${r}.scribe-coarse [contenteditable] {
      -webkit-user-select: auto;
      user-select: auto;
    }
    .${r}.scribe-coarse .scribe-drop-btn { min-height: 44px; }
    /* The panel resize strips are invisible hit areas (cursor only), so widening them costs nothing visually. */
    .${r}.scribe-coarse .scribe-thumb-resize,
    .${r}.scribe-coarse .scribe-bm-resize,
    .${r}.scribe-coarse .scribe-am-resize,
    .${r}.scribe-coarse .scribe-cm-resize { width: 18px; }

    /* Touch priority: controls whose job lives in a gesture on touch (zoom = pinch/double-tap) or is rare enough for the app menu (rotate) leave the bar, so a single row fits tablet widths at 44px targets.
       The app-menu rows that replace them show only then. */
    .${r}.scribe-coarse .scribe-touch-hide,
    .${r}.scribe-phone .scribe-touch-hide { display: none !important; }
    /* Phone-only hide, for a control tablets keep. The phone layout forces single-page view, so only it drops the two-page toggle. */
    .${r}.scribe-phone .scribe-phone-hide { display: none !important; }
    .${r} .scribe-app-menu-item.scribe-touch-row { display: none; }
    .${r}.scribe-coarse .scribe-app-menu-item.scribe-touch-row,
    .${r}.scribe-phone .scribe-app-menu-item.scribe-touch-row { display: flex; }

    /* ---- Phone layout (scribe-phone): the thumb dock replaces the top toolbar. ----
       The dock carries the irreducible set (menu, find, page pill, panels) at the bottom in thumb reach, above the home indicator.
       No bars above the document. */
    .${r} .scribe-dock {
      position: absolute;
      left: 0; right: 0; bottom: 0;
      /* Above the sheet (z-index 25), which slides up from behind the dock.
         Without this the rising sheet covers the dock mid-animation and the dock pops back over it at the end. */
      z-index: 26;
      display: none;
      align-items: center;
      justify-content: space-evenly;
      /* 56px of controls + the home-indicator safe area; border-box so offsetHeight is exactly the dock's height. */
      height: calc(56px + env(safe-area-inset-bottom, 0px));
      box-sizing: border-box;
      padding-bottom: env(safe-area-inset-bottom, 0px);
      background: var(--scribe-surface);
      border-top: 1px solid var(--scribe-line);
      color: var(--scribe-ink);
    }
    .${r}.scribe-phone .scribe-dock { display: flex; }
    /* Dock targets are 44px regardless of pointer: this bar exists only in the phone layout. */
    .${r} .scribe-dock .cr-icon-button { width: 44px; height: 44px; }
    /* The page-number pill: information first, tap to go to a page.
       44px tall: the input inside is interactive, so the pill is a touch target like its dock siblings.
       "2 / 14" must read as one piece of text, not an input beside a label. */
    .${r} .scribe-dock .btn-group {
      height: 44px;
      box-sizing: border-box;
      padding: 0 16px;
      border-radius: 999px;
      background: var(--scribe-sunken);
      border: 1px solid var(--scribe-line);
      font-size: 16px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    /* font: inherit is load-bearing: an input does not inherit font on its own, and the "-toolbar input" font rules do not match inside the dock, so the page number would render in the browser's default font. */
    .${r} .scribe-dock .btn-group input {
      font: inherit;
      border: none;
      background: transparent;
      color: var(--scribe-ink);
      text-align: right;
      padding: 0;
      margin: 0;
    }
    /* The count span's min-width/padding are inline styles from the desktop toolbar, so zeroing them here needs !important. */
    .${r} .scribe-dock .btn-group span { font-size: 16px !important; min-width: 0 !important; padding-left: 0 !important; }
    .${r} .scribe-dock .btn-group .scribe-page-sep { color: var(--scribe-ink-3); font-weight: 500; margin: 0 5px; }

    /* The app menu opens upward from the dock.
       The app sets --scribe-phone-menu-max to the height above the dock, so a long menu scrolls in place instead of leaving the top edge. */
    .${r}.scribe-phone .scribe-app-menu {
      top: auto;
      bottom: calc(100% + 10px);
      max-height: var(--scribe-phone-menu-max, calc(100dvh - 140px));
      overflow-y: auto;
    }

    /* Phone find bar: a full-width surface at the bottom, the mobile convention of sitting just above the keyboard.
       The app tracks the keyboard overlap into --scribe-kb-inset (visualViewport), and the bar rides just above it, or 8px above the dock when no keyboard is up.
       The input row wraps below the controls so it sits nearest the keyboard. */
    .${r}.scribe-phone .scribe-search-group {
      top: auto;
      bottom: max(calc(64px + env(safe-area-inset-bottom, 0px)), calc(var(--scribe-kb-inset, 0px) + 8px));
      left: 8px;
      right: 8px;
      flex-wrap: wrap;
      gap: 4px;
      padding: 8px;
    }
    .${r}.scribe-phone input.scribe-search-input {
      flex: 1 1 100%;
      order: 2;
      height: 40px;
      box-sizing: border-box;
      padding: 0 10px;
      border: 1px solid var(--scribe-line-strong);
      border-radius: 6px;
      background: var(--scribe-surface);
      color: var(--scribe-ink);
      font-size: 16px;
      text-align: left;
    }
    .${r}.scribe-phone .scribe-search-count { margin-right: auto; }

    /* Toasts clear the dock instead of hiding behind it. */
    .${r}.scribe-phone .scribe-toast-stack { bottom: calc(72px + env(safe-area-inset-bottom, 0px)); }

    /* ---- Phone panels: one bottom sheet hosts pages/bookmarks/comments. ----
       There is no scrim: opening the sheet reflows the document into the space above it (_docBottomInset), so the page stays interactive and the dock stays visible to toggle the sheet closed.
       The scrim element below is retained but never shown. */
    .${r} .scribe-sheet-scrim {
      position: absolute;
      inset: 0;
      z-index: 24;
      background: rgba(12, 16, 26, 0.42);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.22s ease;
    }
    .${r} .scribe-sheet-scrim.open { opacity: 1; pointer-events: auto; }
    .${r} .scribe-sheet {
      position: absolute;
      left: 0; right: 0;
      bottom: calc(56px + env(safe-area-inset-bottom, 0px));
      z-index: 25;
      height: 50%;
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      background: var(--scribe-surface);
      border-radius: 18px 18px 0 0;
      box-shadow: var(--scribe-shadow-pop);
      /* The hidden transform adds the dock offset: the sheet rests one dock-height above the bottom edge, so a bare 102% would leave it peeking over the dock. */
      transform: translateY(calc(102% + 56px + env(safe-area-inset-bottom, 0px)));
      transition: transform 0.26s cubic-bezier(0.3, 0.9, 0.3, 1), height 0.26s cubic-bezier(0.3, 0.9, 0.3, 1);
    }
    .${r} .scribe-sheet.open { transform: translateY(0); }
    .${r} .scribe-sheet.dragging { transition: none; }
    @media (prefers-reduced-motion: reduce) {
      .${r} .scribe-sheet, .${r} .scribe-sheet-scrim { transition: none; }
    }
    /* One-row sheet header: pill cap on the top edge, tabs left, the active panel's actions right. */
    .${r} .scribe-sheet-hd {
      position: relative;
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 0 0 auto;
      padding: 10px 10px 5px 12px;
      cursor: grab;
      touch-action: none;
    }
    .${r} .scribe-sheet-pill {
      position: absolute;
      top: 5px;
      left: 50%;
      transform: translateX(-50%);
      width: 40px;
      height: 4.5px;
      border-radius: 3px;
      background: var(--scribe-ink-3);
      opacity: 0.55;
      pointer-events: none;
    }
    .${r} .scribe-sheet-seg { display: flex; gap: 4px; min-width: 0; }
    .${r} .scribe-sheet-seg button {
      min-height: 36px;
      padding: 0 12px;
      border: 0;
      border-radius: 8px;
      background: none;
      cursor: pointer;
      font: 600 13px/1 -apple-system, system-ui, 'Segoe UI', sans-serif;
      color: var(--scribe-ink-2);
      white-space: nowrap;
    }
    .${r}.scribe-coarse .scribe-sheet-seg button { min-height: 44px; font-size: 14px; }
    .${r} .scribe-sheet-seg button.on { background: var(--scribe-active); color: var(--scribe-accent); }
    .${r} .scribe-sheet-acts { display: flex; align-items: center; gap: 5px; margin-left: auto; }
    /* Bookmarks Move session, not a sheet drag. */
    .${r} .scribe-sheet-movehd { display: none; align-items: center; gap: 8px; flex: 1 1 auto; min-width: 0; }
    .${r} .scribe-sheet.scribe-sheet-moving .scribe-sheet-seg,
    .${r} .scribe-sheet.scribe-sheet-moving .scribe-sheet-acts { display: none; }
    .${r} .scribe-sheet.scribe-sheet-moving .scribe-sheet-movehd { display: flex; }
    .${r} .scribe-sheet-moving-title {
      font: 600 14px/1.25 -apple-system, system-ui, 'Segoe UI', sans-serif;
      color: var(--scribe-ink);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    .${r} .scribe-sheet-moving-done {
      margin-left: auto;
      flex: 0 0 auto;
      border: 0;
      background: none;
      color: var(--scribe-accent);
      cursor: pointer;
      font: 600 14px/1 -apple-system, system-ui, 'Segoe UI', sans-serif;
      min-height: 44px;
      padding: 0 10px;
      border-radius: 8px;
    }
    .${r} .scribe-sheet-act {
      width: 36px;
      height: 36px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      border: 0;
      border-radius: 8px;
      background: none;
      color: var(--scribe-ink-2);
      cursor: pointer;
    }
    .${r} .scribe-sheet-act:hover { background: var(--scribe-hover); }
    .${r} .scribe-sheet-act svg { width: 16px; height: 16px; }
    .${r}.scribe-coarse .scribe-sheet-act { width: 44px; height: 44px; }
    .${r} .scribe-sheet-content { position: relative; flex: 1; min-height: 0; overflow: hidden; }

    /* Panels docked in the sheet: neutralize the rail geometry so each panel fills the sheet body.
       The !important is load-bearing: the rail code positions the panels with inline styles. */
    .${r} .scribe-sheet-content .scribe-bookmarks-panel,
    .${r} .scribe-sheet-content .scribe-comments-panel {
      top: 0 !important;
      height: 100% !important;
      width: 100% !important;
      left: 0 !important;
      transform: none !important;
      border-right: none;
      background: transparent;
      transition: none;
      /* The rail slide-in's will-change must not ride into the sheet: a composited layer filling the sheet re-allocates its backing on every frame of a height drag, which jetsams the tab on iPhones. */
      will-change: auto;
    }
    /* The desktop panel title bars are redundant under a tab that already names the panel; their actions live in the sheet header. */
    .${r} .scribe-sheet-content .scribe-bm-hd,
    .${r} .scribe-sheet-content .scribe-cm-hd { display: none; }
    .${r} .scribe-sheet-content .scribe-bm-has-header .scribe-bm-tree { top: 0; }
    .${r} .scribe-sheet-content .scribe-cm-list { top: 0; }
    .${r} .scribe-sheet-content .scribe-bm-resize,
    .${r} .scribe-sheet-content .scribe-cm-resize { display: none; }

    /* ---- Full-height Pages room: the companion strip's expanded state. ----
       Slides up from behind the dock like the sheet: a header over the re-homed thumbnail panel, whose compact grid spreads across the room's full width. */
    .${r} .scribe-pages-room {
      position: absolute;
      left: 0; right: 0; top: 0;
      bottom: calc(56px + env(safe-area-inset-bottom, 0px));
      z-index: 25;
      display: flex;
      flex-direction: column;
      background: var(--scribe-canvas);
      transform: translateY(calc(103% + 56px + env(safe-area-inset-bottom, 0px)));
      transition: transform 0.26s cubic-bezier(0.3, 0.9, 0.3, 1);
    }
    .${r} .scribe-pages-room.open { transform: translateY(0); }
    .${r} .scribe-pages-room.dragging { transition: none; }
    /* Mid-morph the room is one stretching panel: overflow clips the parked reveal row, and the hairline makes the band it starts as pixel-identical to the strip it covers.
       The line is an inset shadow because a border would consume 1px of the content box and shift everything down relative to the settled room. */
    .${r} .scribe-pages-room.morphing {
      overflow: hidden;
      box-shadow: inset 0 1px 0 0 var(--scribe-line);
      will-change: transform;
    }
    .${r} .scribe-pages-room.sinking {
      box-shadow: var(--scribe-shadow-pop), inset 0 1px 0 0 var(--scribe-line);
      will-change: transform;
    }
    @media (prefers-reduced-motion: reduce) {
      .${r} .scribe-pages-room { transition: none; }
    }
    .${r} .scribe-room-hd {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: 0 0 auto;
      padding: 10px 6px 10px 14px;
      background: var(--scribe-surface);
      border-bottom: 1px solid var(--scribe-line);
      /* Above the morph layer (z 3), so a stand-in cell riding under the header's band slides beneath it rather than painting over it, matching the settled room where the grid lives below the header. */
      position: relative;
      z-index: 4;
      /* Nothing native pans from the header, so the drag-down close gesture owns every touch that starts here. */
      touch-action: none;
    }
    .${r} .scribe-room-title { font: 700 15px/1 -apple-system, system-ui, 'Segoe UI', sans-serif; color: var(--scribe-ink); }
    .${r} .scribe-room-count {
      font: 600 12px/1 -apple-system, system-ui, 'Segoe UI', sans-serif;
      font-variant-numeric: tabular-nums;
      color: var(--scribe-ink-3);
    }
    .${r} .scribe-room-done {
      margin-left: auto;
      min-height: 36px;
      padding: 0 12px;
      border: 0;
      border-radius: 8px;
      background: none;
      color: var(--scribe-accent);
      font: 700 13.5px/1 -apple-system, system-ui, 'Segoe UI', sans-serif;
      cursor: pointer;
    }
    .${r} .scribe-room-done:hover { background: var(--scribe-hover); }
    .${r}.scribe-coarse .scribe-room-done { min-height: 44px; }
    .${r} .scribe-room-body { position: relative; flex: 1; min-height: 0; overflow: hidden; }
    .${r} .scribe-room-body .scribe-thumb-panel {
      top: 0 !important;
      height: 100% !important;
      width: 100% !important;
      left: 0 !important;
      transform: none !important;
      border-right: none;
      background: transparent;
      transition: none;
      /* The rail slide-in's will-change is dropped here too: the panel never transforms inside the room, so promotion would only pin a panel-sized backing store. */
      will-change: auto;
    }
    .${r} .scribe-room-body .scribe-thumb-resize { display: none; }

    /* Room modes: browse is read-only, and Edit-to-Save carries all mutation.
       Entering Edit swaps the button's label to Save and hides the room-close Done, so the mode exits only through Save or Discard. */
    .${r} .scribe-room-edit {
      margin-left: auto;
      min-height: 36px;
      padding: 0 12px;
      border: 0;
      border-radius: 8px;
      background: none;
      color: var(--scribe-accent);
      font: 600 13.5px/1 -apple-system, system-ui, 'Segoe UI', sans-serif;
      cursor: pointer;
    }
    .${r} .scribe-room-edit:hover:not(:disabled) { background: var(--scribe-hover); }
    /* Save is disabled until the session has changes to commit. */
    .${r} .scribe-room-edit:disabled { color: var(--scribe-ink-3); cursor: default; }
    .${r}.scribe-coarse .scribe-room-edit { min-height: 44px; }
    /* The Edit button owns the flexible gap while present; Done then hugs it. */
    .${r} .scribe-room-edit ~ .scribe-room-done { margin-left: 0; }
    .${r} .scribe-pages-room.editing .scribe-room-edit { font-weight: 700; }
    .${r} .scribe-pages-room.editing .scribe-room-hd { box-shadow: inset 0 -2px 0 0 var(--scribe-accent); }

    /* Discard-the-session: shown in Edit mode only, live for the whole session (it is also the mode's cancel).
       Save keeps the flexible gap, and Discard hugs it at the right edge. */
    .${r} .scribe-room-revert {
      min-height: 36px;
      padding: 0 12px;
      border: 0;
      border-radius: 8px;
      background: none;
      color: var(--scribe-accent);
      font: 600 13.5px/1 -apple-system, system-ui, 'Segoe UI', sans-serif;
      cursor: pointer;
      display: none;
    }
    .${r} .scribe-room-revert:hover:not(:disabled) { background: var(--scribe-hover); }
    .${r} .scribe-room-revert:disabled { color: var(--scribe-ink-3); cursor: default; }
    .${r}.scribe-coarse .scribe-room-revert { min-height: 44px; }
    .${r} .scribe-pages-room.editing .scribe-room-revert { display: block; }

    /* Edit-mode selection checkbox overhanging each page's top-left corner.
       The check glyph is always in the markup: color transparent hides it at rest, and .selected turns it white. */
    .${r} .scribe-thumb-chk {
      position: absolute;
      top: -5px;
      left: -3px;
      width: 22px;
      height: 22px;
      padding: 0;
      /* A checkbox press starts the range-paint gesture, never a scroll.
         Declared in CSS because iOS only honors touch-action set before the touchstart.
         WebKit cancels the pointer stream of any moving touch that could still pan, and no listener-side preventDefault can win it back. */
      touch-action: none;
      /* Some mobile browsers flash their rectangular tap highlight over the round badge. */
      -webkit-tap-highlight-color: transparent;
      border-radius: 50%;
      background: var(--scribe-surface);
      border: 1px solid var(--scribe-line-strong);
      box-shadow: var(--scribe-page-shadow);
      color: transparent;
      display: none;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 3;
    }
    .${r} .scribe-thumb-chk svg { width: 13px; height: 13px; }
    /* Invisible hit halo: a press near the corner counts as the checkbox, so a near-miss can never wobble into a drag lift.
       It reaches much further right and down than up and left, because the badge overhangs the corner and a miss lands on the page below or beside it, never off the tile. */
    .${r} .scribe-thumb-chk::before {
      content: '';
      position: absolute;
      inset: -8px -26px -26px -8px;
    }
    .${r} .scribe-pages-room.editing .scribe-thumb-chk,
    .${r} .scribe-thumb-editmode .scribe-thumb-chk { display: flex; }
    .${r} .scribe-thumb.selected .scribe-thumb-chk {
      background: var(--scribe-accent);
      border-color: var(--scribe-accent);
      color: #fff;
    }

    /* A press on a selected page grabs it outright (the lift starts at the press), so no touch that lands there may become a pan.
       Same iOS constraint as the checkbox above: touch-action must be set in CSS before the touchstart, or WebKit pointercancels the drag on the first finger movement.
       Unselected pages keep their default touch-action, which is what lets the Edit grid still scroll. */
    .${r} .scribe-pages-room .scribe-thumb.selected { touch-action: none; }

    /* Room-Edit selection: the page wears the accent ring, not the desktop lift + tint, which reads as a wash at phone cell sizes.
       While anything is selected the active page's ring stands down to a neutral hairline, so accent means exactly one thing in the grid: selected. */
    .${r} .scribe-pages-room .scribe-thumb.selected .scribe-thumb-box {
      transform: none;
      box-shadow: var(--scribe-page-shadow);
      outline: 2.5px solid var(--scribe-accent);
    }
    .${r} .scribe-pages-room .scribe-thumb.selected .scribe-thumb-box::after { content: none; }
    .${r} .scribe-pages-room .scribe-thumb-hassel .scribe-thumb.active:not(.selected) .scribe-thumb-box {
      outline: 1px solid var(--scribe-line-strong);
    }

    /* Floating selection bar: the room-Edit batch surface, rising over the grid's bottom edge while anything is selected. */
    .${r} .scribe-thumb-selbar {
      position: absolute;
      left: 10px;
      right: 10px;
      bottom: 10px;
      height: 46px;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 0 6px 0 14px;
      box-sizing: border-box;
      background: var(--scribe-surface);
      border: 1px solid var(--scribe-line);
      border-radius: 12px;
      box-shadow: var(--scribe-menu-shadow);
      /* Above in-rail decorations (insert line 50, marquee 40), below the page context menu (60). */
      z-index: 55;
      font: 600 13px/1 -apple-system, system-ui, 'Segoe UI', sans-serif;
      color: var(--scribe-ink-2);
      opacity: 0;
      transform: translateY(6px);
      transition: opacity .16s, transform .16s;
      pointer-events: none;
    }
    .${r} .scribe-thumb-selbar.on { opacity: 1; transform: none; pointer-events: auto; }
    .${r} .scribe-thumb-selbar-count { margin-right: 2px; }
    .${r} .scribe-thumb-selbar-clear {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 34px;
      height: 34px;
      margin-right: auto;
      padding: 0;
      border: 0;
      border-radius: 8px;
      background: none;
      color: var(--scribe-ink-3);
      cursor: pointer;
    }
    .${r} .scribe-thumb-selbar-clear svg { width: 15px; height: 15px; }
    .${r} .scribe-thumb-selbar-btn {
      display: flex;
      align-items: center;
      gap: 6px;
      height: 38px;
      padding: 0 11px;
      border: 0;
      border-radius: 9px;
      background: none;
      color: var(--scribe-accent);
      font: 600 13px/1 -apple-system, system-ui, 'Segoe UI', sans-serif;
      cursor: pointer;
    }
    .${r} .scribe-thumb-selbar-btn svg { width: 16px; height: 16px; }
    .${r} .scribe-thumb-selbar-btn:hover, .${r} .scribe-thumb-selbar-clear:hover { background: var(--scribe-hover); }
    .${r} .scribe-thumb-selbar-delete { color: var(--scribe-danger); }
    @media (prefers-reduced-motion: reduce) {
      .${r} .scribe-thumb-selbar { transition: none; }
    }

    /* Browse-mode page peek: a buttonless preview that lives only under a held finger.
       pointer-events: none throughout: nothing in it is pressable, and the scrub hit-test must pass through to the cells beneath.
       The hidden state also needs visibility: hidden.
       A merely transparent full-panel overlay still claims the compositor's touch hit-test, and pointer-events: none does not remove it.
       Chrome then treats every touch on the panel as non-cancelable scrolling, which pointercancels any hold gesture on the first movement. */
    .${r} .scribe-thumb-scrim {
      position: absolute;
      inset: 0;
      background: rgba(12, 16, 26, .35);
      /* Above the selection bar: the peek dims everything in the panel, the bar included. */
      z-index: 56;
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transition: opacity .16s, visibility 0s .16s;
    }
    .${r} .scribe-thumb-scrim.on { opacity: 1; visibility: visible; transition: opacity .16s; }
    .${r} .scribe-thumb-peek {
      position: absolute;
      left: 50%;
      top: 42%;
      transform: translate(-50%, -50%) scale(.94);
      transition: transform .16s;
    }
    .${r} .scribe-thumb-scrim.on .scribe-thumb-peek { transform: translate(-50%, -50%) scale(1); }
    .${r} .scribe-thumb-peek-box {
      position: relative;
      background: #fff;
      border-radius: 4px;
      box-shadow: var(--scribe-shadow-pop);
      outline: 1px solid rgba(0, 0, 0, .14);
      overflow: hidden;
    }
    .${r} .scribe-thumb-peek-box img {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: contain;
    }
    .${r} .scribe-thumb-peek-cap {
      margin-top: 8px;
      text-align: center;
      font: 600 12px/1 -apple-system, system-ui, 'Segoe UI', sans-serif;
      color: #fff;
      text-shadow: 0 1px 2px rgba(0, 0, 0, .45);
    }
    @media (prefers-reduced-motion: reduce) {
      .${r} .scribe-thumb-scrim, .${r} .scribe-thumb-peek { transition: none; }
    }

    /* Empty state on touch: dragging a file is not a phone gesture, so the copy leads with opening. */
    .${r} .scribe-drop-title-touch { display: none; }
    .${r}.scribe-coarse .scribe-drop-title-touch { display: inline; }
    .${r}.scribe-coarse .scribe-drop-title-full { display: none; }
    .${r}.scribe-coarse .scribe-drop-hint { display: none; }
    /* Size the container, not the svg: the Open/Print lineIcons carry inline width:100% that would override a width set on the svg. */
    .${r} .scribe-app-menu-ic { display: inline-flex; flex: 0 0 auto; width: 16px; height: 16px; color: var(--scribe-ink-2); }
    .${r} .scribe-app-menu-ic svg { width: 100%; height: 100%; display: block; }
    .${r} .scribe-app-menu-sep { height: 1px; background: var(--scribe-line); margin: 5px 8px; }
    /* Dark-mode toggle: a pill switch pushed to the row's right edge. */
    .${r} .scribe-app-menu-switch {
      margin-left: auto;
      flex: 0 0 auto;
      width: 30px;
      height: 17px;
      border-radius: 9px;
      background: var(--scribe-line-strong);
      position: relative;
      transition: background .15s ease;
    }
    .${r} .scribe-app-menu-switch::after {
      content: '';
      position: absolute;
      top: 2px;
      left: 2px;
      width: 13px;
      height: 13px;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 1px 2px rgba(0, 0, 0, .3);
      transition: transform .15s ease;
    }
    .${r} .scribe-app-menu-toggle.on .scribe-app-menu-switch { background: var(--scribe-accent); }
    .${r} .scribe-app-menu-toggle.on .scribe-app-menu-switch::after { transform: translateX(13px); }

    .${r} .scribe-tab-strip {
      display: flex;
      align-items: stretch;
      width: 100%;
      background: var(--scribe-canvas);
      border-bottom: 1px solid var(--scribe-line);
      position: relative;
    }

    .${r} .scribe-tab-lane {
      display: flex;
      align-items: stretch;
      flex: 1 1 auto;
      overflow-x: auto;
      overflow-y: hidden;
      scroll-behavior: smooth;
      scrollbar-width: none;
      /* Safari permits out-of-range scroll offsets while its edge bounce is enabled, so hard-stop the lane's edges. */
      overscroll-behavior-x: none;
    }
    .${r} .scribe-tab-lane::-webkit-scrollbar { display: none; }
    @media (prefers-reduced-motion: reduce) {
      .${r} .scribe-tab-lane { scroll-behavior: auto; }
    }

    .${r} .scribe-tab-paddle {
      flex: none;
      width: 26px;
      display: none;
      align-items: center;
      justify-content: center;
      color: var(--scribe-ink-2);
      cursor: pointer;
      user-select: none;
      z-index: 2;
    }
    .${r} .scribe-tab-paddle svg { width: 16px; height: 16px; }
    .${r} .scribe-tab-paddle:hover { color: var(--scribe-ink); background: var(--scribe-hover); }
    .${r} .scribe-tab-strip.overflowing .scribe-tab-paddle { display: flex; }

    .${r} .scribe-tab-fade {
      position: absolute;
      top: 0;
      bottom: 1px;
      width: 26px;
      pointer-events: none;
      display: none;
      z-index: 1;
    }
    .${r} .scribe-tab-fade.left { left: calc(26px + var(--scribe-tab-pin-w, 0px)); background: linear-gradient(90deg, var(--scribe-canvas), transparent); }
    .${r} .scribe-tab-fade.right { right: 26px; background: linear-gradient(-90deg, var(--scribe-canvas), transparent); }
    .${r} .scribe-tab-strip.overflowing .scribe-tab-fade { display: block; }

    .${r} .scribe-tab {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 140px;
      max-width: 200px;
      padding: 0 10px;
      color: var(--scribe-ink-2);
      font-size: 13px;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      user-select: none;
    }

    .${r} .scribe-tab.asleep .scribe-tab-name { color: var(--scribe-ink-3); }

    .${r} .scribe-tab-pin { display: flex; align-items: stretch; flex: none; }
    .${r} .scribe-tab-pin .scribe-tab { min-width: 0; }
    .${r} .scribe-tab-pin-sep { width: 1px; background: var(--scribe-line-strong); margin: 6px 4px; flex-shrink: 0; }
    .${r} .scribe-tab-icon { width: 16px; height: 16px; flex-shrink: 0; display: inline-flex; }
    .${r} .scribe-tab-icon svg { width: 100%; height: 100%; display: block; }
    .${r} .scribe-tab-strip.pin-active .scribe-tab-pin .scribe-tab {
      background: var(--scribe-surface);
      color: var(--scribe-accent);
      border-bottom-color: var(--scribe-accent);
    }
    .${r} .scribe-tab-strip.pin-active .scribe-tab-pin .scribe-tab-name { text-shadow: 0 0 .4px currentColor; }
    .${r} .scribe-tab-strip.pin-active .scribe-tab-lane .scribe-tab.active {
      background: none;
      color: var(--scribe-ink-2);
      border-bottom-color: transparent;
    }
    .${r} .scribe-tab-strip.pin-active .scribe-tab-lane .scribe-tab.active .scribe-tab-name { text-shadow: none; }

    .${r} .scribe-tab-spin {
      flex: none;
      width: 12px;
      height: 12px;
      border: 1.6px solid var(--scribe-ink-3);
      border-top-color: transparent;
      border-radius: 50%;
      animation: scribe-tab-spin .7s linear infinite;
    }
    @keyframes scribe-tab-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) {
      .${r} .scribe-tab-spin { animation: none; opacity: .5; }
    }

    .${r} .scribe-tab:hover {
      color: var(--scribe-ink);
    }

    .${r} .scribe-tab.active {
      background: var(--scribe-surface);
      color: var(--scribe-ink);
      border-bottom-color: var(--scribe-accent);
    }

    .${r} .scribe-tab.active .scribe-tab-name {
      /* Fake the heavier weight with a shadow, not font-weight, whose per-glyph advance widths would slide the title's characters sideways as a tab activates. */
      text-shadow: 0 0 0.4px currentColor;
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
      color: var(--scribe-ink-3);
    }

    .${r} .scribe-tab-close:hover {
      background: var(--scribe-hover);
      color: var(--scribe-ink);
    }

    /* Right-click menu on a document tab, mounted on the viewer root and placed at the cursor by JS. */
    .${r} .scribe-tab-menu {
      position: absolute;
      min-width: 150px;
      padding: 4px;
      background: var(--scribe-surface);
      border: 1px solid var(--scribe-line);
      border-radius: 8px;
      box-shadow: var(--scribe-menu-shadow);
      z-index: 60;
      font-size: 13px;
      color: var(--scribe-ink);
      user-select: none;
    }
    .${r} .scribe-tab-menu-item { padding: 7px 12px; border-radius: 5px; cursor: pointer; white-space: nowrap; }
    .${r} .scribe-tab-menu-item:hover { background: var(--scribe-hover); }

    .${r} .highlight-color-btn {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      cursor: pointer;
      border: 2px solid transparent;
      box-sizing: border-box;
      display: block;
      flex: 0 0 auto;
    }

    .${r} .highlight-color-btn:hover {
      border-color: var(--scribe-ink-3);
    }

    .${r} .highlight-color-btn.active {
      border-color: var(--scribe-ink);
    }

    /* Highlighter split button: the marker (the primary control, applying the current color and arming paint mode) sits flush against a slim caret that opens the color palette, so the two read as one control.
       Corner radii are split so only the outer corners round, leaving the touching edges square so the marker and caret merge into a single pill. */
    .${r} .scribe-hl-split {
      position: relative;
      display: inline-flex;
      align-items: center;
      vertical-align: middle;
    }

    .${r} .scribe-hl-split .scribe-hl-mark,
    .${r} .scribe-hl-split .scribe-hl-mark:hover {
      border-radius: 7px 0 0 7px;
    }

    .${r} .scribe-hl-split .scribe-hl-caret,
    .${r} .scribe-hl-split .scribe-hl-caret:hover {
      border-radius: 0 7px 7px 0;
    }

    .${r} .scribe-hl-split .scribe-hl-caret {
      width: 16px;
      align-items: center;
      justify-content: center;
      color: var(--scribe-ink-3);
    }
    /* Slim is fine for a mouse; a finger needs the platform-minimum width on the dropdown half too. */
    .${r}.scribe-coarse .scribe-hl-split .scribe-hl-caret { width: 44px; }

    /* Seam divider hairline whose 14px height stays under the 15px group separators, so it reads as an intra-control line. */
    .${r} .scribe-hl-split .scribe-hl-caret::before {
      content: '';
      position: absolute;
      left: 0;
      top: 50%;
      transform: translateY(-50%);
      width: 1px;
      height: 14px;
      background: var(--scribe-line-strong);
      pointer-events: none;
    }

    /* Palette popover under the split button, matching the app menu and find widget surface. */
    .${r} .scribe-hl-pop {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      z-index: 30;
      display: none;
      gap: 8px;
      padding: 9px 10px;
      background: var(--scribe-surface);
      border: 1px solid var(--scribe-line);
      border-radius: 10px;
      box-shadow: var(--scribe-menu-shadow);
    }

    .${r} .scribe-hl-pop.open {
      display: inline-flex;
    }

    .${r} .scribe-cmt-card {
      position: absolute;
      width: 210px;
      box-sizing: border-box;
      background: var(--scribe-surface);
      border: 1px solid var(--scribe-line);
      border-radius: 8px;
      box-shadow: var(--scribe-menu-shadow);
      padding: 9px 11px;
      font-size: 12.5px;
      line-height: 1.45;
      color: var(--scribe-ink);
      z-index: 21;
    }
    .${r} .scribe-cmt-card.pinned {
      border-color: var(--scribe-accent);
      box-shadow: 0 0 0 2px var(--scribe-accent-ring), var(--scribe-menu-shadow);
    }
    .${r} .scribe-cmt-meta { display: flex; align-items: center; gap: 7px; margin-bottom: 5px; }
    /* position: relative anchors the swatch shelf under the header.
       The min-height is the verb button's, reserved even unpinned so the verbs appearing cannot push the thread down. */
    .${r} .scribe-cmt-quote-row { display: flex; align-items: stretch; gap: 7px; min-height: 20px; margin-bottom: 5px; cursor: grab; position: relative; }
    .${r} .scribe-cmt-quote {
      min-width: 0;
      font-size: 11px;
      font-style: italic;
      color: var(--scribe-ink-3);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    /* The comment is edited in place: a seamless textarea that reads as the card's text. */
    .${r} .scribe-cmt-text {
      display: block;
      box-sizing: border-box;
      width: 100%;
      margin: 0;
      padding: 0;
      border: 0;
      outline: none;
      resize: none;
      overflow: hidden;
      background: transparent;
      font: inherit;
      line-height: inherit;
      color: inherit;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .${r} .scribe-cmt-text::placeholder { color: var(--scribe-ink-3); }
    .${r} .scribe-cmt-thread { display: flex; flex-direction: column; gap: 7px; max-height: 320px; overflow-y: auto; }
    .${r} .scribe-cmt-msg .scribe-cmt-meta { margin-bottom: 2px; }
    .${r} .scribe-cmt-mtext { white-space: pre-wrap; overflow-wrap: anywhere; }
    .${r} .scribe-cmt-card.pinned .scribe-cmt-mtext { cursor: text; }
    .${r} .scribe-cmt-mtext.editing { outline: none; border-radius: 3px; box-shadow: 0 0 0 2px var(--scribe-accent-ring); }
    .${r} .scribe-cmt-more { font-size: 11px; color: var(--scribe-ink-3); }
    .${r} .scribe-cmt-card.pinned .scribe-cmt-more { display: none; }
    .${r} .scribe-cmt-card:not(.pinned) .scribe-cmt-msg.scribe-cmt-old { display: none; }
    .${r} .scribe-cmt-reply { display: flex; align-items: flex-start; gap: 7px; }
    .${r} .scribe-cmt-reply .scribe-cm-ava { margin-top: 1px; }
    .${r} .scribe-cmt-reply .scribe-cmt-text { flex: 1 1 auto; width: auto; min-width: 0; }
    .${r} .scribe-cmt-card:not(.pinned) .scribe-cmt-reply { display: none; }
    .${r} .scribe-cmt-foot { display: flex; align-items: baseline; gap: 10px; margin-top: 1px; }
    .${r} .scribe-cmt-reply-btn {
      margin: 0;
      padding: 0;
      border: 0;
      background: none;
      font: inherit;
      font-size: 11px;
      font-weight: 500;
      color: var(--scribe-accent);
      cursor: pointer;
    }
    .${r} .scribe-cmt-reply-btn:hover { text-decoration: underline; }
    .${r} .scribe-cmt-card:not(.pinned) .scribe-cmt-reply-btn { display: none; }
    /* Header verbs: shown pinned only, since the preview shows content, never controls. */
    .${r} .scribe-cmt-hd-verbs { display: none; align-items: center; align-self: center; gap: 2px; flex: 0 0 auto; }
    .${r} .scribe-cmt-card.pinned .scribe-cmt-hd-verbs { display: flex; }
    .${r} .scribe-cmt-vb {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      padding: 0;
      border: 0;
      border-radius: 5px;
      background: none;
      color: var(--scribe-ink-3);
      cursor: pointer;
      flex: 0 0 auto;
    }
    .${r} .scribe-cmt-vb:hover { background: var(--scribe-hover); color: var(--scribe-ink); }
    .${r} .scribe-cmt-vb.scribe-cmt-vb-del:hover { color: var(--scribe-danger); }
    .${r} .scribe-cmt-vb svg { width: 16px; height: 16px; display: block; }
    /* The panel verb is only a reveal shortcut, and on phones it would sit one small glyph from Delete, so it hides there (the sheet stays a dock tap away). */
    .${r}.scribe-phone .scribe-cmt-vb-panel { display: none; }

    /* The quote bar doubles as the recolor control on highlight/markup cards (cmtFill arms it). */
    .${r} .scribe-cmt-bar-ctl { cursor: pointer; }
    .${r} .scribe-cmt-bar-ctl:hover, .${r} .scribe-cmt-bar-ctl:focus-visible { box-shadow: 0 0 0 2px var(--scribe-accent-ring); outline: none; }
    .${r} .scribe-cmt-shelf {
      position: absolute;
      left: 8px;
      top: calc(100% + 4px);
      display: none;
      align-items: center;
      gap: 6px;
      background: var(--scribe-surface);
      border: 1px solid var(--scribe-line);
      border-radius: 99px;
      padding: 5px 9px;
      box-shadow: var(--scribe-menu-shadow);
      z-index: 3;
    }
    .${r} .scribe-cmt-shelf.open { display: inline-flex; }


    /* The notes layer is scaled by the zoom, so dividing it back out holds a constant on-screen size. */
    .${r} .scribe-note-icon {
      position: absolute;
      width: calc(14px / var(--scribe-zoom, 1));
      height: calc(14px / var(--scribe-zoom, 1));
      color: var(--scribe-note);
      pointer-events: auto;
      cursor: grab;
      user-select: none;
      z-index: 3;
      filter: drop-shadow(0 1px 2px rgba(30, 26, 16, .3));
    }
    .${r} .scribe-note-icon svg { width: 100%; height: 100%; display: block; }
    .${r} .scribe-note-icon:active { cursor: grabbing; }
    .${r} .scribe-note-icon:focus-visible { outline: 2px solid var(--scribe-accent); outline-offset: 1px; border-radius: 3px; }

    .${r} .vertical-separator {
      background: var(--scribe-line-strong);
      height: 15px;
      width: 1px;
      margin-left: 10px;
      margin-right: 10px;
      display: inline-block;
      vertical-align: middle;
    }

    /* Empty-state drop zone shown when no document is loaded. */
    .${r} .scribe-drop-region {
      position: absolute;
      inset: 30px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1.5px dashed var(--scribe-line-strong);
      border-radius: 14px;
      transition: border-color .05s ease-out, background-color .05s ease-out;
    }

    .${r} .scribe-drop-zone.highlight .scribe-drop-region {
      border-color: var(--scribe-accent);
      background-color: var(--scribe-accent-soft);
    }

    .${r} .scribe-drop-content {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
    }

    .${r} .scribe-drop-icon { color: var(--scribe-ink-3); margin-bottom: 20px; }

    .${r} .scribe-drop-icon svg { width: 42px; height: 42px; }

    .${r} .scribe-drop-title {
      font-size: 17px;
      font-weight: 600;
      color: var(--scribe-ink);
      letter-spacing: .2px;
    }

    .${r} .scribe-drop-btn {
      margin-top: 22px;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 9px 18px;
      border-radius: 8px;
      background: var(--scribe-accent);
      border: 1px solid var(--scribe-accent);
      color: var(--scribe-accent-ink);
      font-size: 13.5px;
      font-weight: 550;
      cursor: pointer;
      transition: background-color .15s ease-out;
    }

    .${r} .scribe-drop-btn:hover { background: var(--scribe-accent-hover); border-color: var(--scribe-accent-hover); }

    .${r} .scribe-drop-btn svg { width: 16px; height: 16px; }

    .${r} .scribe-drop-hint {
      font-size: 12.5px;
      color: var(--scribe-ink-3);
      margin-top: 14px;
    }

    .${r} .scribe-drop-loading { display: none; flex-direction: column; align-items: center; }

    .${r} .scribe-drop-zone.loading .scribe-drop-content { display: none; }

    .${r} .scribe-drop-zone.loading .scribe-drop-loading { display: flex; }

    .${r} .scribe-drop-spinner {
      width: 34px;
      height: 34px;
      border: 3px solid var(--scribe-line);
      border-top-color: var(--scribe-accent);
      border-radius: 50%;
      animation: scribe-drop-spin .7s linear infinite;
    }

    @keyframes scribe-drop-spin { to { transform: rotate(360deg); } }

    .${r} .scribe-drop-loading-text {
      margin-top: 18px;
      font-size: 14px;
      color: var(--scribe-ink-3);
      letter-spacing: .2px;
    }

    /* Shown/hidden by toggling opacity (not display) so it can fade in and out.
       pointer-events:none keeps it click-through. */
    .${r} .scribe-drag-overlay {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      opacity: 0;
      pointer-events: none;
      z-index: 9;
      background: var(--scribe-accent-soft);
      transition: opacity .06s ease-out;
    }

    .${r} .scribe-drag-frame {
      position: absolute;
      inset: 14px;
      border: 2px dashed var(--scribe-accent);
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
      background: var(--scribe-accent);
      color: var(--scribe-accent-ink);
      font-size: 13.5px;
      font-weight: 500;
      letter-spacing: .2px;
      white-space: nowrap;
      box-shadow: var(--scribe-shadow-pop);
    }

    .${r} .scribe-drag-pill svg {
      width: 17px;
      height: 17px;
    }

    /* Margins, not text spaces: a leading space in the flex row collapses asymmetrically. */
    .${r} .scribe-page-sep { margin: 0 4px; }

    .${r}-toolbar input {
      background: var(--scribe-sunken);
      border: 1px solid var(--scribe-line-strong);
      border-radius: 5px;
      caret-color: var(--scribe-accent);
      color: var(--scribe-ink);
      font-family: inherit;
      font-size: 13px;
      /* Without an explicit height the inherited line-height inflates the field to 34px, off the bar's 28px control line. */
      height: 28px;
      box-sizing: border-box;
      line-height: 22px;
      margin: 0 4px;
      outline: 0;
      padding: 2px 4px;
      text-align: center;
      vertical-align: middle;
      width: 5ch;
    }
    .${r}-toolbar .scribe-page-sep { font-size: 13px; }
    /* The mode-button overflow fold measures these children, so they must never flex-shrink below their natural widths. */
    .${r}-toolbar .col-md > * { flex: 0 0 auto; }

    .${r}-toolbar {
      -webkit-user-select: none;
      user-select: none;
    }
    .${r}-toolbar input,
    .${r}-toolbar textarea,
    .${r}-toolbar [contenteditable] {
      -webkit-user-select: auto;
      user-select: auto;
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
      background: var(--scribe-surface);
      border: 1px solid var(--scribe-line);
      border-radius: 8px;
      box-shadow: var(--scribe-menu-shadow);
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
      background: var(--scribe-scrollbar);
      border-radius: 6px;
      transition: background 0.15s ease-in-out;
    }

    .${r} .scribe-scrollbar-thumb:hover,
    .${r} .scribe-scrollbar-thumb.dragging {
      background: var(--scribe-scrollbar);
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
      background: var(--scribe-canvas);
      border-right: 1px solid var(--scribe-line);
      z-index: 7;
      transition: transform 180ms ease;
      will-change: transform;
      /* The panel is focusable so it can be the active pane.
         Its focus is shown by the active page's accent, not a default outline on the whole panel. */
      outline: none;
      /* On the panel root so it cascades to every thumbnail image and caption, preventing a click-drag across the rail from selecting them. */
      -webkit-user-select: none;
      user-select: none;
      /* Also inherited by every page image: without it, iOS Safari's long-press save-image callout hijacks the hold-to-preview and hold-to-reorder gestures. */
      -webkit-touch-callout: none;
    }

    /* The resize handle is a sibling of this inner scroll container so it stays at the edge while the container scrolls. */
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

    /* Thin custom bar rather than a thicker native bar. */
    .${r} .scribe-thumb-scroll::-webkit-scrollbar {
      width: 7px;
    }

    .${r} .scribe-thumb-scroll::-webkit-scrollbar-track {
      background: transparent;
    }

    .${r} .scribe-thumb-scroll::-webkit-scrollbar-thumb {
      background: var(--scribe-scrollbar);
      border-radius: 6px;
    }

    .${r} .scribe-thumb-scroll::-webkit-scrollbar-thumb:hover {
      background: var(--scribe-scrollbar);
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
      background: var(--scribe-hover);
    }

    .${r} .scribe-thumb {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 3px;
      padding: 6px 4px;
    }

    /* Tighter rows for the compact phone grid.
       Keep the overhead in sync with COMPACT_ROW_OVERHEAD (3 pad + 2 gap + 13 label + 3 pad = 21). */
    .${r} .scribe-thumb-compact .scribe-thumb {
      gap: 2px;
      padding: 3px 4px;
    }

    .${r} .scribe-thumb-box {
      position: relative;
      background: #fff;
      box-shadow: var(--scribe-page-shadow);
      overflow: hidden;
      box-sizing: border-box;
      cursor: pointer;
      transition: transform .13s ease, box-shadow .13s ease;
    }

    .${r} .scribe-thumb-box img {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: contain;
    }

    /* The page's highlight bands drawn over the thumbnail raster (which never includes the highlight layer).
       Multiply blend keeps the tiny glyphs legible through the band, exactly like the main view's fill layer. */
    .${r} .scribe-thumb-hl {
      position: absolute;
      pointer-events: none;
      mix-blend-mode: multiply;
    }

    .${r} .scribe-thumb-hl span {
      position: absolute;
    }

    /* Redaction marks over the thumbnail raster: solid black bars previewing what export bakes in, not the on-page red mark. */
    .${r} .scribe-thumb-redact {
      position: absolute;
      pointer-events: none;
    }

    .${r} .scribe-thumb-redact span {
      position: absolute;
      background: #000;
    }

    .${r} .scribe-thumb-label {
      color: var(--scribe-ink-3);
      font-size: 13px;
      line-height: 1;
      text-align: center;
    }

    .${r} .scribe-thumb-box:hover {
      outline: 2px solid var(--scribe-line-strong);
    }

    /* Current page while the rail is not the active pane: a subtle accent ring. */
    .${r} .scribe-thumb.active .scribe-thumb-box {
      outline: 3px solid var(--scribe-accent);
    }

    /* While the rail has keyboard focus it is the active pane, so the current page's ring gains an outer accent glow cueing that keystrokes land here.
       The box-shadow re-lists the drop shadow so the glow adds to it rather than replacing it. */
    .${r} .scribe-thumb-panel:focus-within .scribe-thumb.active .scribe-thumb-box {
      outline-color: var(--scribe-accent);
      box-shadow: 0 0 0 5px var(--scribe-accent-ring), var(--scribe-page-shadow);
    }

    .${r} .scribe-thumb.active .scribe-thumb-label {
      color: var(--scribe-ink);
      font-weight: 600;
    }

    .${r} .scribe-thumb-armed .scribe-thumb-box {
      cursor: grab;
    }

    .${r} .scribe-thumb.dragging .scribe-thumb-box {
      opacity: .3;
    }

    /* Touch reorder: a press swells the page a touch before it lifts, then the source hides under the carried ghost. */
    .${r} .scribe-thumb.prelift .scribe-thumb-box {
      transform: scale(1.06);
    }

    .${r} .scribe-thumb.lifting {
      opacity: 0;
      pointer-events: none;
    }

    /* Pages caught in a sweep-gathered run, before they collapse into the clump in hand. */
    .${r} .scribe-thumb.inrun .scribe-thumb-box {
      outline: 2.5px solid var(--scribe-accent);
      outline-offset: -1px;
    }

    .${r} .scribe-thumb.inrun .scribe-thumb-label {
      color: var(--scribe-accent);
      font-weight: 700;
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
      background: var(--scribe-accent);
      border-radius: 2px;
      box-shadow: 0 0 6px var(--scribe-accent-ring);
      pointer-events: none;
      z-index: 50;
    }

    /* Grid reorder: the same accent runs vertically in the gap between cells (left/top/height are set inline). */
    .${r} .scribe-thumb-insert.vertical {
      right: auto;
      width: 3px;
      margin-top: 0;
      margin-left: -1.5px;
    }

    /* Drop-slot placeholder: a dashed outline marking a reorder drag's opened gap as the drop destination.
       Kept before the rows in the DOM so the sliding crowd passes over it, never under. */
    .${r} .scribe-thumb-slot {
      position: absolute;
      border: 1.5px dashed var(--scribe-line-strong);
      border-radius: 3px;
      box-sizing: border-box;
      pointer-events: none;
    }

    /* Drag-select rubber band: a translucent accent-blue box over the rail, sized inline as the pointer drags. */
    .${r} .scribe-thumb-marquee {
      position: absolute;
      z-index: 40;
      /* Translucent accent fill (not the opaque accent-soft) so the thumbnails under the drag rectangle stay visible. */
      background: var(--scribe-accent-ring);
      border: 1px solid var(--scribe-accent);
      pointer-events: none;
    }

    /* Selection is shown by a lift and a translucent tint, never an outline: the outline marks the current page alone.
       The lift is a purely visual transform (translateY, no scaling), so the rail layout never reflows. */
    .${r} .scribe-thumb.selected .scribe-thumb-box {
      transform: translateY(-6px);
      box-shadow: var(--scribe-lift-shadow);
    }

    .${r} .scribe-thumb.selected .scribe-thumb-box::after {
      content: '';
      position: absolute;
      inset: 0;
      background: var(--scribe-accent);
      opacity: .18;
      pointer-events: none;
    }

    /* Floating vertical action strip that pops up beside the rail, next to the selection (JS sets its left/top). */
    .${r} .scribe-thumb-batch {
      position: absolute;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      padding: 6px 5px;
      box-sizing: border-box;
      background: var(--scribe-surface);
      border: 1px solid var(--scribe-line);
      border-radius: 10px;
      box-shadow: var(--scribe-menu-shadow);
      z-index: 20;
    }

    .${r} .scribe-thumb-batch-count {
      color: var(--scribe-ink-2);
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
      color: var(--scribe-ink-2);
      cursor: pointer;
      transition: background-color .12s ease-out;
    }

    .${r} .scribe-thumb-batch-btn svg {
      width: 20px;
      height: 20px;
    }

    .${r} .scribe-thumb-batch-btn:hover {
      background: var(--scribe-hover);
      color: var(--scribe-ink);
    }

    .${r} .scribe-thumb-batch-delete:hover {
      background: var(--scribe-danger);
      color: #fff;
    }

    /* Right-click page context menu, mounted on the viewer root and placed at the cursor by JS. */
    .${r} .scribe-thumb-menu {
      position: absolute;
      min-width: 150px;
      padding: 4px;
      background: var(--scribe-surface);
      border: 1px solid var(--scribe-line);
      border-radius: 8px;
      box-shadow: var(--scribe-menu-shadow);
      z-index: 60;
      font-size: 13px;
      color: var(--scribe-ink);
      user-select: none;
    }

    .${r} .scribe-thumb-menu-item {
      padding: 7px 12px;
      border-radius: 5px;
      cursor: pointer;
      white-space: nowrap;
    }

    .${r} .scribe-thumb-menu-item:hover {
      background: var(--scribe-hover);
    }

    .${r} .scribe-thumb-menu-item.danger { color: var(--scribe-danger); }

    .${r} .scribe-thumb-menu-item.danger:hover {
      background: var(--scribe-danger-soft);
    }

    .${r} .scribe-thumb-menu-item.disabled {
      color: var(--scribe-ink-3);
      pointer-events: none;
    }

    .${r} .scribe-thumb-menu-header {
      padding: 5px 12px 6px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: .04em;
      text-transform: uppercase;
      color: var(--scribe-ink-3);
    }

    .${r} .scribe-thumb-menu-divider {
      height: 0;
      margin: 4px 6px;
      border: none;
      border-top: 1px solid var(--scribe-line);
    }

    /* Mirrors the thumbnail panel's dock geometry, chrome, and slide: the two form one sidebar. */
    /* One toolbar button opens the sidebar, and this strip picks which view it shows. */

    /* A desktop shell whose native menus carry the app commands hides the in-window menu button.
       Hidden by class rather than inline style, because the library's bar swap snapshots and restores inline display and would resurface it. */
    .${r}.scribe-menu-button-hidden .scribe-app-menu-wrap,
    .${r}.scribe-menu-button-hidden .scribe-menu-sep { display: none; }

    /* The library home swaps the bar over to its own controls, so the sidebar toggle sits that state out like the other document controls. */
    .${r} .scribe-library-bar .scribe-sidebar-toggle { display: none; }

    /* View-switch strip pinned above the open sidebar view. */
    .${r} .scribe-sbtabs {
      position: absolute;
      left: 0;
      height: 36px;
      box-sizing: border-box;
      padding: 4px 6px;
      background: var(--scribe-canvas);
      border-right: 1px solid var(--scribe-line);
      border-bottom: 1px solid var(--scribe-line);
      z-index: 8;
      will-change: transform;
    }

    .${r} .scribe-sbtabs-track {
      display: flex;
      gap: 2px;
      height: 100%;
      box-sizing: border-box;
      background: var(--scribe-sunken);
      border-radius: 7px;
      padding: 2px;
    }

    .${r} .scribe-sbtab {
      flex: 1 1 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 5px;
      color: var(--scribe-ink-3);
      cursor: pointer;
    }

    .${r} .scribe-sbtab:hover { color: var(--scribe-ink); }

    .${r} .scribe-sbtab.on {
      background: var(--scribe-surface);
      color: var(--scribe-accent);
      box-shadow: 0 1px 2px rgba(20, 30, 60, .14);
    }

    .${r} .scribe-sbtab svg {
      width: 15px;
      height: 15px;
      display: block;
      pointer-events: none;
    }

    .${r} .scribe-bookmarks-panel {
      position: absolute;
      left: 0;
      overflow: hidden;
      box-sizing: border-box;
      background: var(--scribe-canvas);
      border-right: 1px solid var(--scribe-line);
      z-index: 7;
      color: var(--scribe-ink);
      font-size: 13px;
      transition: transform 180ms ease;
      will-change: transform;
      outline: none;
    }

    /* Persistent header (editor mode): an uppercase title and an always-present add button.
       Full width so its bottom border spans the panel.
       The add button is inset well clear of the resize handle at the right edge. */
    .${r} .scribe-bm-hd {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 36px;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 8px 0 12px;
      border-bottom: 1px solid var(--scribe-line);
      background: var(--scribe-canvas);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: .06em;
      text-transform: uppercase;
      color: var(--scribe-ink-2);
      z-index: 2;
    }
    .${r} .scribe-bm-hd-title { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .${r} .scribe-bm-add {
      flex: 0 0 auto;
      width: 26px;
      height: 26px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      margin: 0;
      color: var(--scribe-ink-2);
      background: none;
      border: none;
      border-radius: 6px;
      cursor: pointer;
    }
    .${r} .scribe-bm-add:hover { background: var(--scribe-hover); color: var(--scribe-ink); }
    .${r} .scribe-bm-add svg { width: 16px; height: 16px; display: block; }

    /* Fills the panel but for a 6px right gutter, so the tree's scrollbar clears the resize handle (as the rail's does). */
    .${r} .scribe-bm-tree {
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
    /* When the header is present, drop the tree below it (36px header + 1px border). */
    .${r} .scribe-bm-has-header .scribe-bm-tree { top: 37px; }

    /* Right-edge resize handle, matching the thumbnail rail's. */
    .${r} .scribe-bm-resize {
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      width: 6px;
      cursor: ew-resize;
      z-index: 8;
      touch-action: none;
    }

    .${r} .scribe-bm-resize:hover {
      background: var(--scribe-hover);
    }

    .${r} .scribe-bm-tree::-webkit-scrollbar { width: 5px; }
    .${r} .scribe-bm-tree::-webkit-scrollbar-track { background: transparent; }
    .${r} .scribe-bm-tree::-webkit-scrollbar-thumb { background: var(--scribe-scrollbar); border-radius: 6px; }

    .${r} .scribe-bm-row {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4.5px 8px 4.5px 0;
      cursor: pointer;
      white-space: nowrap;
      border-radius: 4px;
      user-select: none;
      -webkit-tap-highlight-color: transparent;
    }

    .${r} .scribe-bm-row:hover { background: var(--scribe-hover); }
    .${r} .scribe-bm-row.active { background: var(--scribe-accent-soft); color: var(--scribe-accent); }
    /* Top-level entries carry more weight, so the hierarchy reads from type alone. */
    .${r} .scribe-bm-row.top > .scribe-bm-label { font-weight: 600; }
    /* A little air above each section label groups it with its children. */
    .${r} .scribe-bm-row.structural { margin-top: 4px; }

    .${r} .scribe-bm-twisty {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      flex: 0 0 16px;
      color: var(--scribe-ink-2);
    }
    .${r} .scribe-bm-twisty svg { width: 12px; height: 12px; display: block; }
    .${r} .scribe-bm-twisty.open svg { transform: rotate(90deg); }
    .${r} .scribe-bm-row:hover .scribe-bm-twisty { color: var(--scribe-ink); }
    .${r} .scribe-bm-row.active .scribe-bm-twisty { color: var(--scribe-accent); }

    .${r} .scribe-bm-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    /* Title-only (structural) parents read as confident section labels, not de-emphasized afterthoughts. */
    .${r} .scribe-bm-label.structural {
      font-size: 10.5px;
      font-weight: 650;
      letter-spacing: .07em;
      text-transform: uppercase;
      color: var(--scribe-ink-2);
    }

    /* Quiet right-aligned page number, TOC-style. */
    .${r} .scribe-bm-page {
      flex: 0 0 auto;
      margin: 0 8px 0 6px;
      font-size: 11px;
      color: var(--scribe-ink-3);
      font-variant-numeric: tabular-nums;
    }
    .${r} .scribe-bm-row.active .scribe-bm-page { color: var(--scribe-accent); }

    /* Inline rename occupies the label's exact box with no border or padding, so editing never changes the row height or nudges the text.
       Focus shows via a paint-only outline that takes no layout space. */
    .${r} .scribe-bm-rename {
      flex: 1 1 auto;
      min-width: 0;
      font: inherit;
      line-height: inherit;
      color: var(--scribe-ink);
      background: transparent;
      border: 0;
      padding: 0;
      margin: 0;
    }
    .${r} .scribe-bm-rename:focus {
      outline: 1px solid var(--scribe-accent);
      outline-offset: 1px;
    }
    /* iOS decides its input zoom at focus, so the rename input starts at the coarse-mode 16px floor and takes this class right after focus(). */
    .${r} .scribe-bm-rename.scribe-bm-rename-live { font-size: inherit; }
    /* The input wears the label styling of the row it replaces, so entering rename never restyles the text. */
    .${r} .scribe-bm-row.top > .scribe-bm-rename { font-weight: 600; }
    .${r} .scribe-bm-rename.structural {
      font-weight: 650;
      letter-spacing: .07em;
      text-transform: uppercase;
      color: var(--scribe-ink-2);
    }
    .${r} .scribe-bm-rename.structural.scribe-bm-rename-live { font-size: 10.5px; }

    .${r} .scribe-bm-empty { padding: 12px; color: var(--scribe-ink-3); font-size: 12px; }

    .${r} .scribe-bm-menu {
      position: absolute;
      min-width: 170px;
      padding: 4px;
      background: var(--scribe-surface);
      border: 1px solid var(--scribe-line);
      border-radius: 8px;
      box-shadow: var(--scribe-menu-shadow);
      z-index: 60;
      font-size: 13px;
      color: var(--scribe-ink);
      user-select: none;
    }

    .${r} .scribe-bm-menu-item { padding: 7px 12px; border-radius: 5px; cursor: pointer; white-space: nowrap; }
    .${r} .scribe-bm-menu-item:hover { background: var(--scribe-hover); }
    .${r} .scribe-bm-menu-item.disabled { color: var(--scribe-ink-3); cursor: default; }
    .${r} .scribe-bm-menu-item.disabled:hover { background: none; }
    .${r} .scribe-bm-menu-item.danger { color: var(--scribe-danger); }
    .${r} .scribe-bm-menu-sep { height: 1px; background: var(--scribe-line); margin: 4px 6px; }
    .${r} .scribe-bm-menu-item.scribe-bm-menu-hand { display: flex; align-items: center; gap: 10px; }
    .${r} .scribe-bm-menu-item.scribe-bm-menu-hand .scribe-bm-autoglyph { margin-left: auto; }
    /* Sized explicitly because the glyph markup carries inline width and height of 100%, which would otherwise inflate it. */
    .${r} .scribe-bm-autoglyph { width: 14px; height: 14px; flex: none; display: inline-flex; color: var(--scribe-ink-3); }
    .${r} .scribe-bm-autoglyph svg { width: 14px; height: 14px; display: block; }

    .${r} .scribe-bm-rails { position: absolute; top: 0; left: 0; right: 0; pointer-events: none; z-index: 8; }
    .${r} .scribe-bm-rails i { position: absolute; top: 0; bottom: 0; border-left: 1px dashed var(--scribe-accent-ring); }
    .${r} .scribe-bm-rails i.on { border-left: 1.5px solid var(--scribe-accent); }
    .${r} .scribe-bm-row.scribe-bm-adopt { background: var(--scribe-accent-soft); }
    .${r} .scribe-bm-row.scribe-bm-adopt .scribe-bm-twisty { color: var(--scribe-accent); }
    /* The menu can open away from its row, so the subject row carries its own wash. */
    .${r} .scribe-bm-row.scribe-bm-menu-subject:not(.active) { background: var(--scribe-hover); }
    /* The plate marks the slot the dragged card will settle into. */
    .${r} .scribe-bm-plate {
      position: absolute;
      z-index: 9;
      border-radius: 8px;
      background: var(--scribe-plate);
      pointer-events: none;
      transition: left 90ms ease, top 90ms ease;
    }

    .${r} .scribe-bm-lift {
      position: absolute;
      z-index: 12;
      pointer-events: none;
    }
    .${r} .scribe-bm-lift.scribe-bm-lift-armed { pointer-events: auto; cursor: grab; }
    .${r} .scribe-bm-lift .scribe-bm-row {
      background: var(--scribe-surface);
      border-radius: 8px;
      box-shadow: 0 0 0 1px var(--scribe-line-strong), var(--scribe-lift-shadow);
    }
    .${r} .scribe-bm-lift-count {
      position: absolute;
      top: -6px;
      right: 4px;
      min-width: 18px;
      height: 18px;
      padding: 0 5px;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 9px;
      background: var(--scribe-accent);
      color: #fff;
      font-size: 11px;
      font-weight: 600;
    }
    /* visibility, not display: the slide offsets are measured against a layout that still contains the lifted subtree's slot. */
    .${r} .scribe-bm-lift-src { visibility: hidden; }
    .${r} .scribe-bm-sliding .scribe-bm-row { transition: transform 160ms ease; }
    .${r} .scribe-bm-dragging .scribe-bm-row { cursor: grabbing; }
    @keyframes scribe-bm-fade-in { from { opacity: 0; } to { opacity: 1; } }
    .${r} .scribe-bm-row.scribe-bm-drop-in .scribe-bm-dots,
    .${r} .scribe-bm-row.scribe-bm-drop-in .scribe-bm-twisty { animation: scribe-bm-fade-in 140ms ease; }
    .${r} .scribe-bm-row.scribe-bm-drop-in-child { animation: scribe-bm-fade-in 140ms ease; }

    .${r} .scribe-bm-dots {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 24px;
      flex: 0 0 auto;
      margin: 0 -6px 0 -8px;
      padding: 0;
      border: 0;
      border-radius: 8px;
      background: none;
      color: var(--scribe-ink-3);
      cursor: pointer;
    }
    .${r} .scribe-bm-dots:hover { background: var(--scribe-hover); color: var(--scribe-ink); }
    .${r} .scribe-bm-dots svg { width: 15px; height: 15px; display: block; }
    .${r}.scribe-coarse .scribe-bm-dots { width: 34px; height: 30px; }

    /* A phone can still deliver hover from a stray fine pointer, so the sheet's rows explicitly take no hover wash. */
    .${r}.scribe-phone .scribe-bm-row { padding-top: 8px; padding-bottom: 8px; font-size: 13.5px; min-height: 30px; }
    .${r}.scribe-phone .scribe-bm-page { font-size: 11.5px; }
    .${r}.scribe-phone .scribe-bm-row:hover { background: transparent; }
    .${r}.scribe-phone .scribe-bm-row.active, .${r}.scribe-phone .scribe-bm-row.active:hover { background: var(--scribe-accent-soft); }

    .${r} .scribe-bm-empty-editor { display: flex; flex-direction: column; align-items: flex-start; gap: 9px; padding: 14px 12px; }
    .${r} .scribe-bm-empty-msg { color: var(--scribe-ink-2); font-size: 12px; }
    .${r} .scribe-bm-empty-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--scribe-line-strong);
      background: var(--scribe-surface);
      color: var(--scribe-ink);
      font: 600 12px/1 -apple-system, system-ui, 'Segoe UI', sans-serif;
      padding: 7px 12px;
      border-radius: 6px;
      cursor: pointer;
      white-space: nowrap;
    }
    .${r} .scribe-bm-empty-btn:hover { background: var(--scribe-hover); }
    .${r} .scribe-bm-empty-btn svg { width: 14px; height: 14px; display: block; }
    .${r}.scribe-coarse .scribe-bm-empty-btn { min-height: 42px; font-size: 13px; padding: 7px 14px; }
    .${r} .scribe-bm-empty-hint { font-size: 11px; color: var(--scribe-ink-3); max-width: 210px; }

    /* Comments panel: a flat list of every comment (highlight-anchored + freestanding notes), a sibling of the rails. */
    .${r} .scribe-comments-panel {
      position: absolute;
      left: 0;
      overflow: hidden;
      box-sizing: border-box;
      background: var(--scribe-canvas);
      border-right: 1px solid var(--scribe-line);
      z-index: 7;
      color: var(--scribe-ink);
      font-size: 13px;
      transition: transform 180ms ease;
      will-change: transform;
      outline: none;
    }
    .${r} .scribe-cm-hd {
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 36px;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 12px;
      border-bottom: 1px solid var(--scribe-line);
      background: var(--scribe-canvas);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: .06em;
      text-transform: uppercase;
      color: var(--scribe-ink-2);
      z-index: 2;
    }
    .${r} .scribe-cm-hd-title { flex: 1 1 auto; }
    /* "New note on this page" button in the header. */
    .${r} .scribe-cm-new {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      padding: 0;
      border: 1px solid transparent;
      border-radius: 6px;
      background: transparent;
      color: var(--scribe-ink-2);
      cursor: pointer;
    }
    .${r} .scribe-cm-new:hover { background: var(--scribe-hover); color: var(--scribe-ink); }
    .${r} .scribe-cm-new svg { width: 15px; height: 15px; display: block; }
    /* List fills below the header, with a 6px right gutter so its scrollbar clears the resize handle. */
    .${r} .scribe-cm-list {
      position: absolute;
      top: 37px; left: 0; bottom: 0; right: 6px;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 6px;
      box-sizing: border-box;
    }
    .${r} .scribe-cm-list::-webkit-scrollbar { width: 5px; }
    .${r} .scribe-cm-list::-webkit-scrollbar-track { background: transparent; }
    .${r} .scribe-cm-list::-webkit-scrollbar-thumb { background: var(--scribe-scrollbar); border-radius: 6px; }
    .${r} .scribe-cm-resize {
      position: absolute;
      top: 0; right: 0; bottom: 0;
      width: 6px;
      cursor: ew-resize;
      z-index: 8;
      touch-action: none;
    }
    .${r} .scribe-cm-resize:hover { background: var(--scribe-hover); }

    /* Sticky page-group headers: rows group per page; the current page's header carries the accent. */
    .${r} .scribe-cm-grp {
      position: sticky;
      top: -6px;
      z-index: 2;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 4px 5px;
      background: var(--scribe-canvas);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: .08em;
      text-transform: uppercase;
      color: var(--scribe-ink-3);
    }
    .${r} .scribe-cm-grp::after { content: ""; flex: 1 1 auto; height: 1px; background: var(--scribe-line); }
    .${r} .scribe-cm-grp.active { color: var(--scribe-accent); }

    /* Rail comment cards share the surface-on-canvas figure-ground of the pages and floating card. */
    .${r} .scribe-cm-row {
      background: var(--scribe-surface);
      border: 1px solid var(--scribe-line);
      border-radius: 8px;
      padding: 9px 10px;
      margin-bottom: 6px;
      cursor: pointer;
      /* The fold animation drives height from measured border-box rects. */
      box-sizing: border-box;
    }
    .${r} .scribe-cm-row:hover { border-color: var(--scribe-line-strong); }
    /* Hover-sync: the row whose highlight the pointer is over in the viewer. */
    .${r} .scribe-cm-row.lit { border-color: var(--scribe-accent); box-shadow: 0 0 0 1px var(--scribe-accent-ring); }
    /* The row morphed into the editor signals focus on the card itself, like the on-page card. */
    .${r} .scribe-cm-row.editing {
      cursor: default;
      border-color: var(--scribe-accent);
      box-shadow: 0 0 0 2px var(--scribe-accent-ring);
    }

    /* Bulk selection (Ctrl/Cmd+A) in the bookmarks and comments panels: an accent wash plus a left accent bar. */
    .${r} .scribe-bm-row.selected, .${r} .scribe-cm-row.selected {
      background: var(--scribe-accent-soft);
      box-shadow: inset 3px 0 0 var(--scribe-accent);
    }

    /* The card's own header row. */
    .${r} .scribe-cm-top { display: flex; align-items: center; gap: 7px; min-height: 20px; }
    .${r} .scribe-cm-meta {
      display: flex;
      align-items: center;
      gap: 7px;
      flex: 1 1 auto;
      min-width: 0;
      font-size: 12px;
      color: var(--scribe-ink-3);
    }
    .${r} .scribe-cm-ava {
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: var(--scribe-accent-soft);
      color: var(--scribe-accent);
      font-size: 9px;
      font-weight: 700;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
    }
    .${r} .scribe-cm-who {
      font-weight: 600;
      color: var(--scribe-ink);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .${r} .scribe-cm-when {
      font-size: 11px;
      color: var(--scribe-ink-3);
      white-space: nowrap;
    }

    /* Right slot of the lead line, holding the date. */
    .${r} .scribe-cm-right { flex: 0 0 auto; margin-left: auto; align-self: center; }

    /* Anchor line: the quoted highlight behind a mini-swatch bar of its raw color (set inline), or the note mark. */
    .${r} .scribe-cm-anchor { display: flex; align-items: stretch; gap: 7px; margin-top: 6px; min-width: 0; }
    .${r} .scribe-cm-anchor:first-child { margin-top: 0; }
    .${r} .scribe-cm-bar { flex: 0 0 3px; width: 3px; border-radius: 2px; }
    .${r} .scribe-cm-quote {
      flex: 1 1 auto;
      min-width: 0;
      font-size: 11.5px;
      font-style: italic;
      color: var(--scribe-ink-3);
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }
    /* Double-click on the quote swaps the two-line clamp for the full quoted text (and back).
       A very tall quote gets .scroll (max-height set inline from QUOTE_SCROLL_MAX_PX) and scrolls inside. */
    .${r} .scribe-cm-quote.expanded { display: block; }
    .${r} .scribe-cm-quote.expanded.scroll { overflow-y: auto; overscroll-behavior: contain; }
    .${r} .scribe-cm-quote.expanded.scroll::-webkit-scrollbar { width: 5px; }
    .${r} .scribe-cm-quote.expanded.scroll::-webkit-scrollbar-track { background: transparent; }
    .${r} .scribe-cm-quote.expanded.scroll::-webkit-scrollbar-thumb { background: var(--scribe-scrollbar); border-radius: 6px; }
    /* Firefox lacks ::-webkit-scrollbar and shows a fat native bar in this narrow box.
       Scope the standard thin-scrollbar fallback to non-webkit engines: setting scrollbar-width
       unconditionally would make Chrome drop the 7px custom bar above for a wider native one. */
    @supports not selector(::-webkit-scrollbar) {
      .${r} .scribe-cm-quote.expanded.scroll { scrollbar-width: thin; scrollbar-color: var(--scribe-scrollbar) transparent; }
    }
    /* Only note rows get a kind label (the note mark); a markup row's quote wears its markup instead. */
    .${r} .scribe-cm-kind {
      flex: 1 1 auto;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      font-weight: 500;
      color: var(--scribe-ink-3);
    }
    .${r} .scribe-cm-kind svg { width: 12px; height: 12px; color: var(--scribe-note); flex: 0 0 auto; }
    /* The wash (--scribe-cm-wash) is theme-scaled down (dark 22%) because a full-strength yellow reads mustard on dark.
       The text lifts one ink step so the wash never costs contrast.
       box-decoration-break: clone wraps the wash/hatch onto each clamped line like a real mark. */
    .${r} .scribe-cm-qmark {
      --scribe-cm-wash: 35%;
      color: var(--scribe-ink-2);
      padding: 0 3px;
      border-radius: 2px;
      -webkit-box-decoration-break: clone;
      box-decoration-break: clone;
    }
    .${r}[data-theme="dark"] .scribe-cm-qmark { --scribe-cm-wash: 22%; }
    /* line-height 1.55 leaves room for the offset underline; the clamp box's overflow:hidden would otherwise clip it below the last line's baseline. */
    .${r} .scribe-cm-q-ul { text-decoration: underline; text-decoration-thickness: 1.5px; text-underline-offset: 2.5px; line-height: 1.55; }
    .${r} .scribe-cm-q-st { text-decoration: line-through; text-decoration-thickness: 1.5px; line-height: 1.55; }
    /* Redaction quotes sit on the on-page mark's own hatch (panel-scale stroke). */
    .${r} .scribe-cm-q-rd {
      background: repeating-linear-gradient(45deg, rgba(209, 73, 61, .16) 0 1px, transparent 1px 6px);
      box-shadow: inset 0 0 0 1px rgba(209, 73, 61, .38);
    }

    .${r} .scribe-cm-text {
      margin-top: 6px;
      color: var(--scribe-ink);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    /* Reply-thread messages: the row-header identity anatomy again, once per message. */
    .${r} .scribe-cm-msg { margin-top: 8px; }
    .${r} .scribe-cm-msg .scribe-cm-text { margin-top: 2px; }
    /* The reply composer line the Reply ghost morphs into: the author's avatar beside the field, as on the card. */
    .${r} .scribe-cm-reply { display: flex; align-items: flex-start; gap: 7px; margin-top: 6px; }
    .${r} .scribe-cm-reply .scribe-cm-ava { margin-top: 3px; }
    .${r} .scribe-cm-reply .scribe-cm-field { flex: 1 1 auto; min-width: 0; margin-top: 0; }

    /* The visible way into a comment-less row. */
    .${r} .scribe-cm-ghost {
      display: flex;
      align-items: center;
      gap: 6px;
      width: 100%;
      box-sizing: border-box;
      margin-top: 4px;
      padding: 3px 4px;
      border: 0;
      border-radius: 5px;
      background: none;
      color: var(--scribe-ink-3);
      font: inherit;
      font-size: 12.5px;
      cursor: pointer;
      text-align: left;
    }
    .${r} .scribe-cm-ghost:hover { background: var(--scribe-hover); color: var(--scribe-ink-2); }
    .${r} .scribe-cm-ghost svg { width: 13px; height: 13px; flex: 0 0 auto; }

    /* In-place editor: the card is the writing surface (no inner box); the footer slides in below.
       This is the on-page card's comment sheet, hosted by the row. */
    .${r} .scribe-cm-field {
      width: 100%;
      box-sizing: border-box;
      resize: none;
      min-height: 40px;
      max-height: 190px;
      overflow-y: auto;
      margin-top: 4px;
      font: inherit;
      font-size: 13px;
      line-height: 1.45;
      color: var(--scribe-ink);
      background: none;
      border: 0;
      padding: 1px 2px;
      outline: none;
    }
    .${r} .scribe-cm-fold { display: grid; grid-template-rows: 0fr; transition: grid-template-rows .18s ease; }
    .${r} .scribe-cm-row.editing .scribe-cm-fold { grid-template-rows: 1fr; }
    .${r} .scribe-cm-fold > div { overflow: hidden; min-height: 0; }
    /* No Save button: clicking anywhere outside the row saves and folds, so the footer is just the quiet remove link. */
    .${r} .scribe-cm-foot { display: flex; align-items: center; padding-top: 6px; }
    .${r} button.scribe-cm-remove {
      font: inherit;
      font-size: 11.5px;
      color: var(--scribe-ink-3);
      border: 0;
      background: none;
      padding: 2px 0;
      cursor: pointer;
      white-space: nowrap;
      flex: 0 0 auto;
    }
    .${r} button.scribe-cm-remove:hover { color: var(--scribe-danger); }

    .${r} .scribe-cm-empty {
      height: 100%;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 4px;
      text-align: center;
      padding: 18px;
      color: var(--scribe-ink-3);
    }
    .${r} .scribe-cm-empty svg { width: 26px; height: 26px; opacity: .75; margin-bottom: 4px; }
    .${r} .scribe-cm-empty-t { font-size: 13px; font-weight: 600; color: var(--scribe-ink-2); }
    .${r} .scribe-cm-empty-h { font-size: 12px; max-width: 180px; line-height: 1.5; }
    .${r} .scribe-cm-compact .scribe-cm-empty-h { max-width: 34ch; }

    .${r} .scribe-cm-menu {
      position: absolute;
      min-width: 150px;
      padding: 4px;
      background: var(--scribe-surface);
      border: 1px solid var(--scribe-line);
      border-radius: 8px;
      box-shadow: var(--scribe-menu-shadow);
      z-index: 60;
      font-size: 13px;
      color: var(--scribe-ink);
      user-select: none;
    }
    .${r} .scribe-cm-menu-item { padding: 7px 12px; border-radius: 5px; cursor: pointer; white-space: nowrap; }
    .${r} .scribe-cm-menu-item:hover { background: var(--scribe-hover); }

    /* Compact (phone) comments.
       The panel builds these elements only in compact mode (.scribe-cm-compact). */
    /* The gutter is reserved so a row does not narrow the moment expanding or editing pushes the list past its own height. */
    .${r} .scribe-cm-compact .scribe-cm-list { padding: 8px 10px 14px; scrollbar-gutter: stable; }
    .${r} .scribe-cmc-row {
      -webkit-tap-highlight-color: transparent;
      position: relative;
      display: flex;
      border: 1px solid var(--scribe-line);
      border-radius: 10px;
      background: var(--scribe-surface);
      margin: 0 0 8px;
      min-height: 44px;
      box-sizing: border-box;
      cursor: pointer;
      overflow: hidden;
      user-select: none;
    }
    .${r} .scribe-cmc-row.lit { border-color: var(--scribe-accent); box-shadow: 0 0 0 1px var(--scribe-accent-ring); }
    .${r} .scribe-cmc-rail {
      position: absolute;
      left: 0;
      top: 10px;
      bottom: 10px;
      width: 3px;
      border-radius: 0 2px 2px 0;
    }
    .${r} .scribe-cmc-in { flex: 1; min-width: 0; padding: 12px; padding-left: 15px; }
    .${r} .scribe-cmc-ava {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      /* border-box so a ring stays inside the disc and a stack's width stays predictable. */
      box-sizing: border-box;
      background: var(--scribe-accent-soft);
      color: var(--scribe-accent);
      display: flex;
      align-items: center;
      justify-content: center;
      font: 700 8px/1 -apple-system, system-ui, 'Segoe UI', sans-serif;
      flex: 0 0 auto;
    }
    .${r} .scribe-cmc-ava-b { background: #dff0e6; color: #2c6b45; }
    .${r} .scribe-cmc-ava-c { background: #f3e2dc; color: #9a4f38; }
    .${r}[data-theme="dark"] .scribe-cmc-ava-b { background: #1e3527; color: #8fd6ac; }
    .${r}[data-theme="dark"] .scribe-cmc-ava-c { background: #3a2620; color: #e2a68e; }
    .${r} .scribe-cmc-quote {
      font: italic 500 11.5px/1.45 -apple-system, system-ui, 'Segoe UI', sans-serif;
      color: var(--scribe-ink-2);
      display: -webkit-box;
      -webkit-line-clamp: 1;
      -webkit-box-orient: vertical;
      overflow: hidden;
      width: fit-content;
      max-width: 100%;
      padding: 1px 5px;
      border-radius: 4px;
      margin: 8px 0 0;
    }
    .${r} .scribe-cmc-quote.ul { text-decoration: underline 1.5px; text-underline-offset: 2px; }
    .${r} .scribe-cmc-quote.st { text-decoration: line-through 1.5px; }
    .${r} .scribe-cmc-quote.rd { background: repeating-linear-gradient(45deg, rgba(209, 73, 61, .16) 0 1px, transparent 1px 6px); }
    .${r} .scribe-cmc-text {
      font: 400 16px/1.45 -apple-system, system-ui, 'Segoe UI', sans-serif;
      color: var(--scribe-ink);
      overflow: hidden;
      overflow-wrap: anywhere;
    }
    /* The clamp lives on the resting collapsed state only, so the reveal can ease it away. */
    .${r} .scribe-cmc-row:not(.open) .scribe-cmc-text {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }
    .${r} .scribe-cmc-text.gone { font: 600 11.5px/1 -apple-system, system-ui, 'Segoe UI', sans-serif; color: var(--scribe-danger); margin-top: 8px; }
    .${r} .scribe-cmc-hd { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .${r} .scribe-cmc-who { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .${r} .scribe-cmc-pg {
      margin-left: auto;
      flex: 0 0 auto;
      font: 500 11.5px/1 -apple-system, system-ui, 'Segoe UI', sans-serif;
      color: var(--scribe-ink-3);
      font-variant-numeric: tabular-nums;
    }
    .${r} .scribe-cmc-dots {
      flex: 0 0 auto;
      width: 28px;
      height: 24px;
      margin: -2px -6px -2px 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      border: 0;
      border-radius: 8px;
      background: none;
      color: var(--scribe-ink-3);
      cursor: pointer;
    }
    .${r} .scribe-cmc-dots:hover { background: var(--scribe-hover); color: var(--scribe-ink); }
    .${r} .scribe-cmc-dots svg { width: 15px; height: 15px; }
    .${r}.scribe-coarse .scribe-cmc-dots { width: 34px; height: 30px; }
    .${r} .scribe-cmc-root { display: flex; gap: 8px; margin-top: 8px; }
    .${r} .scribe-cmc-rc { flex: 1; min-width: 0; }
    .${r} .scribe-cmc-ft { display: flex; align-items: baseline; gap: 10px; margin-top: 3px; }
    .${r} .scribe-cmc-fd {
      font: 500 11.5px/1.3 -apple-system, system-ui, 'Segoe UI', sans-serif;
      color: var(--scribe-ink-3);
      font-variant-numeric: tabular-nums;
    }
    .${r} .scribe-cmc-fr {
      margin: 0;
      padding: 0;
      border: 0;
      background: none;
      font: 500 11.5px/1.3 -apple-system, system-ui, 'Segoe UI', sans-serif;
      color: var(--scribe-accent);
      cursor: pointer;
      position: relative;
    }
    /* The verb's visual box stays a text label; the tap target extends invisibly around it. */
    .${r} .scribe-cmc-fr::after { content: ''; position: absolute; inset: -10px -8px; }
    .${r} .scribe-cmc-fr:hover { text-decoration: underline; }

    .${r} .scribe-cmc-strip { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
    .${r} .scribe-cmc-row.open .scribe-cmc-strip { height: 0; margin-top: 0; opacity: 0; visibility: hidden; overflow: hidden; }
    .${r} .scribe-cmc-faces { display: flex; flex-direction: row-reverse; flex: 0 0 auto; }
    .${r} .scribe-cmc-faces .scribe-cmc-ava {
      border: 1.5px solid var(--scribe-surface);
      margin-left: -3px;
    }
    .${r} .scribe-cmc-faces .scribe-cmc-ava:last-child { margin-left: 0; }
    .${r} .scribe-cmc-n {
      flex: 0 0 auto;
      font: 600 11.5px/1 -apple-system, system-ui, 'Segoe UI', sans-serif;
      color: var(--scribe-ink-3);
      font-variant-numeric: tabular-nums;
    }

    .${r} .scribe-cmc-row.open {
      background: var(--scribe-sunken);
      border-color: var(--scribe-line-strong);
      cursor: default;
    }
    .${r} .scribe-cmc-row.scribe-cmc-reflow { transition: height .24s cubic-bezier(.3, .8, .3, 1); }
    @media (prefers-reduced-motion: reduce) {
      .${r} .scribe-cmc-row.scribe-cmc-reflow { transition: none; }
    }
    .${r} .scribe-cmc-hd .scribe-cmc-mh { min-width: 0; }
    .${r} .scribe-cmc-mh .scribe-cmc-dots { margin-left: auto; }
    .${r} .scribe-cmc-row:focus-visible {
      outline: 2px solid var(--scribe-accent);
      outline-offset: -2px;
    }
    .${r} .scribe-cmc-drawer { padding: 0; }
    .${r} .scribe-cmc-msg { display: flex; gap: 8px; margin: 12px 0 0; }
    .${r} .scribe-cmc-msg .scribe-cmc-ava { margin-top: 1px; }
    .${r} .scribe-cmc-mb { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    .${r} .scribe-cmc-mh {
      display: flex;
      align-items: center;
      gap: 6px;
      font: 600 13px/1.2 -apple-system, system-ui, 'Segoe UI', sans-serif;
      color: var(--scribe-ink);
    }
    .${r} .scribe-cmc-when {
      font: 500 11.5px/1 -apple-system, system-ui, 'Segoe UI', sans-serif;
      color: var(--scribe-ink-3);
      flex: 0 0 auto;
      font-variant-numeric: tabular-nums;
    }
    /* 16px because the edit field that replaces this text is pinned there, and a message that resized the moment you edited it would be a visible jump. */
    .${r} .scribe-cmc-mt { font: 400 16px/1.45 -apple-system, system-ui, 'Segoe UI', sans-serif; color: var(--scribe-ink); overflow-wrap: anywhere; }
    .${r} .scribe-cmc-comp { display: flex; align-items: flex-end; gap: 8px; margin-top: 16px; }
    .${r} .scribe-cmc-field {
      flex: 1;
      min-height: 40px;
      max-height: 120px;
      resize: none;
      box-sizing: border-box;
      border: 1px solid var(--scribe-line-strong);
      border-radius: 8px;
      background: var(--scribe-surface);
      color: var(--scribe-ink);
      font: 400 16px/1.4 -apple-system, system-ui, 'Segoe UI', sans-serif;
      padding: 8px 12px;
      outline: none;
    }
    .${r} .scribe-cmc-field:focus { border-color: var(--scribe-accent); }
    .${r} .scribe-cmc-send {
      width: 40px;
      height: 40px;
      box-sizing: border-box;
      flex: 0 0 auto;
      border: 0;
      border-radius: 8px;
      background: var(--scribe-accent);
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
    }
    .${r} .scribe-cmc-send:disabled {
      background: none;
      color: var(--scribe-ink-3);
      border: 1px solid var(--scribe-line-strong);
      cursor: default;
    }
    .${r} .scribe-cmc-send svg { width: 17px; height: 17px; }
    .${r}.scribe-coarse .scribe-cmc-send { width: 44px; height: 44px; }
    .${r}.scribe-coarse .scribe-cmc-field { min-height: 44px; }

    .${r} .scribe-cm-menu-danger { color: var(--scribe-danger); }

    /* The edit field must occupy exactly the space the message text did, so its padding is painted with an outward box-shadow, which takes no layout space. */
    .${r} .scribe-cmc-edit { display: flex; flex-direction: column; }
    .${r} .scribe-cmc-ed {
      width: 100%;
      box-sizing: border-box;
      padding: 0;
      border: 0;
      border-radius: 2px;
      resize: none;
      /* JS sizes the field to its content on every keystroke, so it never scrolls its own text. */
      overflow: hidden;
      background: var(--scribe-surface);
      box-shadow: 0 0 0 6px var(--scribe-surface);
      color: var(--scribe-ink);
      /* Must stay identical to .scribe-cmc-mt, or the words move the moment editing begins. */
      font: 400 16px/1.45 -apple-system, system-ui, 'Segoe UI', sans-serif;
      overflow-wrap: anywhere;
      outline: none;
    }

    /* Message surface: transient toasts (self-evident failures) + a persistent banner (away/non-obvious) */
    .${r} .scribe-toast-stack {
      position: absolute; left: 50%; bottom: 20px; transform: translateX(-50%);
      display: flex; flex-direction: column; align-items: center; gap: 8px;
      z-index: 80; pointer-events: none; max-width: calc(100% - 40px);
    }
    .${r} .scribe-toast {
      pointer-events: auto; cursor: pointer; max-width: 460px;
      display: flex; align-items: center; gap: 9px;
      padding: 11px 15px; border-radius: 9px;
      background: var(--scribe-surface); color: var(--scribe-ink);
      border: 1px solid var(--scribe-line); border-left: 3px solid var(--scribe-danger);
      box-shadow: var(--scribe-shadow-pop); font-size: 13px; line-height: 1.35;
      opacity: 0; transform: translateY(8px); transition: opacity .18s ease, transform .18s ease;
    }
    .${r} .scribe-toast.shown { opacity: 1; transform: translateY(0); }
    .${r} .scribe-toast.leaving { opacity: 0; transform: translateY(8px); }
    /* Inline toast action, e.g. Undo after a delete. */
    .${r} .scribe-toast-action {
      flex: 0 0 auto;
      margin: -6px -6px -6px 2px;
      padding: 6px 10px;
      background: none;
      border: none;
      border-radius: 7px;
      color: var(--scribe-accent);
      font: 600 13px/1 inherit;
      font-family: inherit;
      cursor: pointer;
      white-space: nowrap;
    }
    .${r} .scribe-toast-action:hover { background: var(--scribe-hover); }
    .${r}.scribe-coarse .scribe-toast-action { min-height: 40px; padding: 6px 12px; }

    .${r} .scribe-banner {
      position: absolute; left: 0; right: 0; height: 40px; z-index: 35;
      display: flex; align-items: center; gap: 10px; padding: 0 14px;
      background: var(--scribe-danger-soft); border-bottom: 1px solid var(--scribe-line);
      color: var(--scribe-ink); font-size: 13px;
    }
    .${r} .scribe-banner-text { flex: 1 1 auto; }
    .${r} .scribe-banner-close {
      flex: none; display: inline-grid; place-items: center; width: 26px; height: 26px;
      padding: 0; border: none; border-radius: 6px; background: transparent;
      color: var(--scribe-ink-2); cursor: pointer;
    }
    .${r} .scribe-banner-close:hover { background: var(--scribe-hover); color: var(--scribe-ink); }
    .${r} .scribe-banner-close svg { width: 16px; height: 16px; display: block; }

    .${r} .scribe-mode-banner {
      position: absolute; left: 0; right: 0; height: 40px; z-index: 35; box-sizing: border-box;
      display: flex; align-items: center; gap: 8px; padding: 0 10px 0 14px;
      background: var(--scribe-accent-soft); border-bottom: 1px solid var(--scribe-line);
      color: var(--scribe-ink); user-select: none;
    }
    .${r} .scribe-mode-banner-ic { display: inline-flex; width: 17px; height: 17px; color: var(--scribe-accent); flex: none; }
    .${r} .scribe-mode-banner-name { font-size: 12.5px; font-weight: 650; white-space: nowrap; }
    .${r} .scribe-mode-banner-dot { color: var(--scribe-ink-3); }
    .${r} .scribe-mode-banner-hint { font-size: 12px; color: var(--scribe-ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .${r} .scribe-mode-banner-done {
      margin-left: auto; flex: none; display: inline-flex; align-items: center; gap: 6px;
      padding: 3px 12px; border: none; border-radius: 6px; background: transparent;
      font: inherit; font-size: 12.5px; font-weight: 650; color: var(--scribe-accent); cursor: pointer;
    }
    .${r} .scribe-mode-banner-done:hover { background: var(--scribe-active); }
    .${r} .scribe-mode-banner-done kbd {
      font-family: inherit; font-size: 10.5px; font-weight: 600; color: var(--scribe-ink-3);
      border: 1px solid var(--scribe-line-strong); border-radius: 4px; padding: 0 4px; line-height: 1.5;
    }
    .${r} .scribe-mode-banner-tools { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; flex: none; }
    .${r} .scribe-mode-banner-tools + .scribe-mode-banner-done { margin-left: 0; }

    /* The Fill & Sign palette hosted in the mode bar: the pill chrome comes off and the signature menu opens downward. */
    .${r} .scribe-mode-banner .scribe-fs-pal {
      position: relative; left: auto; bottom: auto; transform: none; z-index: auto;
      background: none; border: none; border-radius: 0; box-shadow: none; padding: 0;
      cursor: default; margin-left: auto; flex: none;
    }
    .${r} .scribe-mode-banner .scribe-fs-grip { display: none; }
    .${r} .scribe-mode-banner .scribe-fs-pal + .scribe-mode-banner-done { margin-left: 0; }
    .${r} .scribe-mode-banner .scribe-fs-menu { bottom: auto; top: calc(100% + 6px); right: 0; }
    .${r} .scribe-mode-banner-langwrap { position: relative; display: inline-flex; }
    .${r} .scribe-mode-banner-lang {
      display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border: none; border-radius: 6px;
      background: transparent; font: inherit; font-size: 12px; color: var(--scribe-ink-2); cursor: pointer;
    }
    .${r} .scribe-mode-banner-lang:hover, .${r} .scribe-mode-banner-lang.active { background: var(--scribe-active); }
    .${r} .scribe-mode-banner-lang svg { display: block; }
    .${r} .scribe-mode-banner-run {
      flex: none; display: inline-flex; align-items: center; padding: 2px 12px; border: 1px solid var(--scribe-accent);
      border-radius: 6px; background: transparent; font: inherit; font-size: 12.5px; font-weight: 650; color: var(--scribe-accent); cursor: pointer;
    }
    .${r} .scribe-mode-banner-run:not(:disabled):hover { background: var(--scribe-active); }
    .${r} .scribe-mode-banner-run:disabled { color: var(--scribe-ink-3); border-color: var(--scribe-line-strong); cursor: default; }
    .${r} .scribe-mode-banner-run.busy { opacity: .6; pointer-events: none; }

    /* The mode drop-down: the sidebar strip's material at bar scale. */
    .${r} .scribe-mode-track-wrap { position: relative; display: inline-flex; }
    .${r} .scribe-mode-track-el {
      display: inline-flex; align-items: stretch; height: 28px; box-sizing: border-box;
      background: var(--scribe-sunken); border-radius: 7px; padding: 2px;
    }
    .${r} .scribe-mode-track-row1 { display: inline-flex; gap: 2px; justify-content: space-between; flex: 1 1 auto; }
    .${r} .scribe-mode-track-more { display: none; }
    .${r} .scribe-mode-track-el.open {
      position: absolute; top: 0; right: 0; z-index: 30; height: auto;
      flex-direction: column; align-items: stretch; box-shadow: var(--scribe-menu-shadow);
    }
    .${r} .scribe-mode-track-el.open .scribe-mode-track-more { display: flex; flex-direction: column; gap: 2px; margin-top: 2px; }
    .${r} .scribe-mode-track-row { display: flex; gap: 2px; }
    /* The value cell and the list rows share one left-aligned column, so the icons line up down the open control. */
    .${r} .scribe-mode-track-row1 .cr-icon-button:first-child,
    .${r} .scribe-mode-track-row .cr-icon-button { flex: 1 1 auto; justify-content: flex-start; }
    .${r} .scribe-mode-track-el .cr-icon-button { height: 24px; width: auto; border-radius: 5px; color: var(--scribe-ink-2); align-items: center; }
    .${r} .scribe-mode-track-el .cr-labeled-button { padding: 0 9px 0 5px; gap: 5px; }
    .${r} .scribe-mode-track-row1 .cr-icon-button:first-child:not(.active):not(.disabled) { color: var(--scribe-ink); }
    .${r} .scribe-mode-track-el .cr-icon-button:hover { background: none; color: var(--scribe-ink); }
    /* The track's ink override above outranks the shared .disabled rule, so the dim is restated here. */
    .${r} .scribe-mode-track-el .cr-icon-button.disabled { color: color-mix(in srgb, var(--scribe-ink-2) 50%, var(--scribe-ink-3)); }
    .${r} .scribe-mode-track-el .cr-icon-button.active,
    .${r} .scribe-mode-track-el .cr-icon-button.active:hover {
      background: var(--scribe-surface); color: var(--scribe-accent);
      box-shadow: 0 1px 2px rgba(20, 30, 60, .14);
    }
    .${r} .scribe-mode-track-el .cr-icon { width: 17px; height: 17px; }
    .${r} .scribe-mode-track-el .cr-btn-label { font-size: 13px; }
    .${r} .scribe-mode-track-chev { padding: 0 6px; }
  `;

  style.appendChild(document.createTextNode(css));
  document.head.appendChild(style);
}
