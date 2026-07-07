// Scribe PDF Editor. A thin editor app built on top of the viewer.
//
// `ScribePDFEditor` extends `ScribePDFViewer` (which composes the shared controls).
// It inherits rendering, page nav, zoom, search, highlights, scrollbars, drag-drop loading, and the desktop wiring for free.
// On top of that it turns on page editing (`enablePageEditing`) and recognition, and adds a toolbar for text recognition and PDF export.
// Word (OCR) text editing is a 'proof' mode feature that is not part of this editor, so the viewer's text-selection/editing gates stay off and invisible text keeps the native browser selection.
// No new editing logic lives here.
// Every control calls an existing method/flag/mode.
import { ScribePDFViewer, ScribeViewer } from '../basic-viewer/pdf-viewer.js';
import { selectOcrPages } from '../../js/pdf/ocrPageSelection.js';
import { outlineSplitSegments } from '../../js/objects/outlineObjects.js';

const EDITOR_ROOT_CLASS = 'scribe-pdf-editor';

/** localStorage key for the persisted theme setting ('system' | 'light' | 'dark'). */
const THEME_STORAGE_KEY = 'scribe-theme';

/** Chevron-down for the OCR split button's language caret. */
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

class ScribePDFEditor extends ScribePDFViewer {
  /**
   * @param {HTMLElement} container
   * @param {object} [options] - Same options as `ScribePDFViewer`.
   */
  constructor(container, options = {}) {
    super(container, options);

    // Word (OCR) text editing is a 'proof' mode feature, not part of the basic editor.
    // `enableCanvasSelection` and `UiText.enableEditing` are deliberately left off, so invisible text uses native browser selection.
    this.scribe.opt.enableRecognition = true;
    // Show the thumbnail panel's per-page edit controls (delete / drag-reorder).
    // The viewer leaves this off.
    this.scribe.opt.enablePageEditing = true;

    // Keep the inherited `scribe-pdf-viewer` class (so the shared control styles apply) and add the editor class so editor-only controls can be scoped to it.
    this.pdfViewerElem.classList.add(EDITOR_ROOT_CLASS);
    ScribePDFEditor._addEditorStyles();

    this._initTheme();

    if (this.showToolbar) this._buildEditToolbar();

    // A bookmark edit can change how many top-level bookmarks exist, so refresh the Split button after any edit.
    const prevEditCallback = this.scribe.onEditCallback;
    this.scribe.onEditCallback = () => {
      if (prevEditCallback) prevEditCallback();
      this._updateSplitButton();
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
  // eslint-disable-next-line class-methods-use-this
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
    const ocrSplit = document.createElement('span');
    ocrSplit.className = 'scribe-edit-split';
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
      // Export the searchable PDF, the editor's primary output. The menu closes on click and the browser's own download UI is the progress cue,
      // so the `busy` class only matters if the menu is kept open, matching the Combine / Split siblings.
      const exportItem = appMenu.addAction('Export PDF', ICON_EXPORT, async () => {
        // No-op at 0 pages (e.g. every page removed) rather than throwing deep in the PDF writer.
        if (!this.doc || this.doc.pageMetrics.length === 0) return;
        exportItem.classList.add('busy');
        try {
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
    const progressBar = document.createElement('div');
    progressBar.className = 'scribe-ocr-progress';
    this._ocrProgress = progressBar;
    this.toolbarElemEnd.parentElement?.appendChild(progressBar);

    this._updateRecognizeButton();
    this._updateCombineButton();
    this._updateSplitButton();
  }

  /**
   * Number of pages deep OCR would recognize for the current document, or 0 when there is none.
   * Mirrors `recognize`'s `'autoDeep'` page mask, falling back to the whole document when per-page stats are missing or OCR was user-uploaded.
   * Drives the Recognize Text button's visibility and the progress bar's page total.
   * @returns {number}
   */
  _deepOcrPageCount() {
    const doc = this.doc;
    if (!doc) return 0;
    // While a deferred import's stats are still extracting, return 0 so the Recognize button stays hidden rather than flashing on and then vanishing for text-native docs.
    // `_setDoc` re-runs this once `textReady` lands.
    if (doc._textReadySettle) return 0;
    const { pageStats, pageCount, pdfType } = doc.inputData;
    if (doc.ocr?.['User Upload'] || !pageStats || pageStats.length !== pageCount) return pageCount;
    return selectOcrPages(pageStats, pdfType, 'autoDeep').filter(Boolean).length;
  }

  /** Show the Recognize Text button only when deep OCR would actually recognize at least one page. */
  _updateRecognizeButton() {
    if (this._ocrSplit) this._ocrSplit.style.display = this._deepOcrPageCount() > 0 ? '' : 'none';
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

  /** Refresh the Combine and Split buttons whenever the tab strip re-renders, so their visibility tracks the current tabs and active document. */
  _renderTabs() {
    super._renderTabs();
    this._updateCombineButton();
    this._updateSplitButton();
  }

  /**
   * Wire a document into the viewer, then refresh the Recognize Text button for the new document's contents.
   * @param {...any} args - Forwarded to `ScribePDFViewer._setDoc`.
   * @returns {Promise<?import('../../js/containers/scribeDoc.js').ScribeDoc>} The displaced document.
   */
  async _setDoc(...args) {
    const displaced = await super._setDoc(...args);
    this._updateRecognizeButton();
    this._updateSplitButton();
    // The Recognize verdict depends on the page stats a deferred import produces, so re-evaluate it once they land.
    const doc = args[0];
    if (doc && doc._textReadySettle) {
      doc.textReady.then(() => {
        if (this.doc === doc) this._updateRecognizeButton();
      });
    }
    return displaced;
  }

  /**
   * Detach the current document, then hide the Recognize Text button for the now-empty viewer.
   * @param {object} [options] - Forwarded to `ScribePDFViewer.detachDoc`.
   * @returns {?import('../../js/containers/scribeDoc.js').ScribeDoc} The detached document.
   */
  detachDoc(options) {
    const detached = super.detachDoc(options);
    this._updateRecognizeButton();
    return detached;
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

    // Track recognized pages by counting scribe.js `convert` progress events, one per page as its OCR lands.
    // Key strictly on `convert` (deduped by page index) so the faster pre-render `render` events do not inflate the bar.
    // The bar runs from a 0.04 sliver to 0.9, reserving the last tenth for the compare/optimize tail (no page index), which the snap-to-full fills on success.
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

  static styleAdded = false;

  /** Inject the editor-only control styles once (base control styles come from the viewer). */
  static _addEditorStyles() {
    if (ScribePDFEditor.styleAdded) return;
    ScribePDFEditor.styleAdded = true;
    const style = document.createElement('style');
    style.appendChild(document.createTextNode(`
      .scribe-pdf-editor .scribe-edit-group {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin-right: 6px;
      }
      .scribe-pdf-editor .scribe-edit-btn {
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
      .scribe-pdf-editor .scribe-edit-btn:hover { background: var(--scribe-hover); }
      .scribe-pdf-editor .scribe-edit-btn.active { background: var(--scribe-active); }
      .scribe-pdf-editor .scribe-edit-btn.busy { opacity: .6; pointer-events: none; }
      .scribe-pdf-editor .scribe-edit-btn-ic { display: inline-flex; align-items: center; }
      .scribe-pdf-editor .scribe-edit-btn-ic svg { width: 16px; height: 16px; display: block; color: var(--scribe-ink-2); }

      /* OCR split button: one pill with a main face and a caret, divided by a hairline. */
      .scribe-pdf-editor .scribe-edit-split { position: relative; display: inline-flex; align-items: stretch; }
      .scribe-pdf-editor .scribe-edit-split-main { border-radius: 6px 0 0 6px; padding: 0 8px 0 10px; }
      .scribe-pdf-editor .scribe-edit-split-caret { border-radius: 0 6px 6px 0; padding: 0 5px; }
      .scribe-pdf-editor .scribe-edit-split-caret::before {
        content: ''; position: absolute; left: 0; top: 6px; bottom: 6px; width: 1px; background: var(--scribe-line-strong);
      }
      .scribe-pdf-editor .scribe-edit-split-caret svg { display: block; }

      /* Language menu under the recognition-language caret. */
      .scribe-pdf-editor .scribe-edit-menu {
        position: absolute; top: calc(100% + 6px); right: 0; min-width: 150px; padding: 4px;
        background: var(--scribe-surface); border: 1px solid var(--scribe-line); border-radius: 8px;
        box-shadow: var(--scribe-menu-shadow); z-index: 30;
      }
      .scribe-pdf-editor .scribe-edit-menu-item {
        position: relative; display: flex; align-items: center; padding: 6px 10px 6px 26px;
        border-radius: 4px; font-size: 13px; color: var(--scribe-ink); cursor: pointer; white-space: nowrap;
      }
      .scribe-pdf-editor .scribe-edit-menu-item:hover { background: var(--scribe-hover); }
      .scribe-pdf-editor .scribe-edit-menu-item.selected::before {
        content: ''; position: absolute; left: 10px; top: 50%; width: 5px; height: 9px;
        border: solid var(--scribe-accent); border-width: 0 2px 2px 0; transform: translate(0, -60%) rotate(45deg);
      }

      /* Subtle recognition progress line: a 3px accent fill along the toolbar's bottom edge, scaled by progress. */
      .scribe-pdf-editor .scribe-ocr-progress {
        position: absolute; left: 0; bottom: 0; width: 100%; height: 3px;
        background: var(--scribe-accent); transform: scaleX(0); transform-origin: left;
        opacity: 0; pointer-events: none; z-index: 25;
        transition: transform .2s ease, opacity .3s ease;
      }

    `));
    document.head.appendChild(style);
  }
}

export { ScribePDFEditor, ScribeViewer };
