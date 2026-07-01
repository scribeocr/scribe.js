// Scribe PDF Editor. A thin editor app built on top of the viewer.
//
// `ScribePDFEditor` extends `ScribePDFViewer` (which composes the shared controls).
// It inherits rendering, page nav, zoom, search, highlights, scrollbars, drag-drop loading, and the desktop wiring for free.
// On top of that it turns on page editing (`enablePageEditing`) and recognition, and adds a toolbar for text recognition and PDF export.
// Word (OCR) text editing is a 'proof' mode feature that is not part of this editor, so the viewer's text-selection/editing gates stay off and invisible text keeps the native browser selection.
// No new editing logic lives here.
// Every control calls an existing method/flag/mode.
import { ScribePDFViewer, ScribeViewer } from '../basic-viewer/pdf-viewer.js';
import { makeSeparator } from '../js/controls/toolbar.js';
import { selectOcrPages } from '../../js/pdf/ocrPageSelection.js';

const EDITOR_ROOT_CLASS = 'scribe-pdf-editor';

/** Chevron-down for the OCR split button's language caret. */
const CARET_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M7 10l5 5 5-5z" fill="currentColor"/></svg>';

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

    if (this.showToolbar) this._buildEditToolbar();
  }

  /**
   * Build a flat text button styled by the editor CSS.
   * @param {string} label
   * @param {string} title
   * @param {string} [extraClass]
   * @returns {HTMLSpanElement}
   */
  // eslint-disable-next-line class-methods-use-this
  _makeTextBtn(label, title, extraClass) {
    const btn = document.createElement('span');
    btn.className = extraClass ? `scribe-edit-btn ${extraClass}` : 'scribe-edit-btn';
    btn.textContent = label;
    btn.title = title;
    btn.role = 'button';
    btn.tabIndex = 0;
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    return btn;
  }

  /**
   * Build the edit toolbar's right zone: a Recognize Text split button (the main face runs recognition and the caret opens a language menu) and an Export PDF button.
   * Page delete/reorder lives in the thumbnail panel.
   * Find is the viewer's floating search bar.
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
    ocrCaret.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = langMenu.style.display !== 'none';
      langMenu.style.display = open ? 'none' : 'block';
      ocrCaret.classList.toggle('active', !open);
    });
    // Dismiss the open menu on any click outside it.
    // The caret's own handler stops propagation, so toggling it never reaches here.
    // Clicking the main OCR face, like anywhere else, closes the menu.
    const onDocClick = (e) => {
      if (langMenu.style.display === 'none' || langMenu.contains(/** @type {Node} */ (e.target))) return;
      langMenu.style.display = 'none';
      ocrCaret.classList.remove('active');
    };
    document.addEventListener('click', onDocClick);
    this._teardownCallbacks.push(() => document.removeEventListener('click', onDocClick));
    ocrSplit.append(ocrBtn, ocrCaret, langMenu);

    const exportBtn = this._makeTextBtn('Export PDF', 'Export a searchable PDF');
    exportBtn.addEventListener('click', async () => {
      if (!this.doc) return;
      exportBtn.classList.add('busy');
      try {
        await this.doc.download('pdf', this._baseName(), { displayMode: 'invis', addOverlay: true });
      } catch (err) {
        console.error('Export failed:', err);
      } finally {
        exportBtn.classList.remove('busy');
      }
    });

    const rightGroup = document.createElement('span');
    rightGroup.className = 'scribe-edit-group';
    rightGroup.append(ocrSplit, exportBtn, makeSeparator());
    this.toolbarElemEnd.insertBefore(rightGroup, this.toolbarElemEnd.firstChild);

    // A subtle recognition progress line along the toolbar's bottom edge, hidden until OCR runs.
    const progressBar = document.createElement('div');
    progressBar.className = 'scribe-ocr-progress';
    this._ocrProgress = progressBar;
    this.toolbarElemEnd.parentElement?.appendChild(progressBar);

    this._updateRecognizeButton();
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
    const { pageStats, pageCount, pdfType } = doc.inputData;
    if (doc.ocr?.['User Upload'] || !pageStats || pageStats.length !== pageCount) return pageCount;
    return selectOcrPages(pageStats, pdfType, 'autoDeep').filter(Boolean).length;
  }

  /** Show the Recognize Text button only when deep OCR would actually recognize at least one page. */
  _updateRecognizeButton() {
    if (this._ocrSplit) this._ocrSplit.style.display = this._deepOcrPageCount() > 0 ? '' : 'none';
  }

  /**
   * Wire a document into the viewer, then refresh the Recognize Text button for the new document's contents.
   * @param {...any} args - Forwarded to `ScribePDFViewer._setDoc`.
   * @returns {Promise<?import('../../js/containers/scribeDoc.js').ScribeDoc>} The displaced document.
   */
  async _setDoc(...args) {
    const displaced = await super._setDoc(...args);
    this._updateRecognizeButton();
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
        padding: 0 10px;
        height: var(--scribe-icon-size, 28px);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        font-size: 13px;
        color: #e8eaed;
        white-space: nowrap;
      }
      .scribe-pdf-editor .scribe-edit-btn:hover { background: rgba(255, 255, 255, .1); }
      .scribe-pdf-editor .scribe-edit-btn.active { background: rgba(255, 255, 255, .2); }
      .scribe-pdf-editor .scribe-edit-btn.busy { opacity: .6; pointer-events: none; }

      /* OCR split button: one pill with a main face and a caret, divided by a hairline. */
      .scribe-pdf-editor .scribe-edit-split { position: relative; display: inline-flex; align-items: stretch; }
      .scribe-pdf-editor .scribe-edit-split-main { border-radius: 6px 0 0 6px; padding: 0 8px 0 10px; }
      .scribe-pdf-editor .scribe-edit-split-caret { border-radius: 0 6px 6px 0; padding: 0 5px; }
      .scribe-pdf-editor .scribe-edit-split-caret::before {
        content: ''; position: absolute; left: 0; top: 6px; bottom: 6px; width: 1px; background: rgba(255, 255, 255, .18);
      }
      .scribe-pdf-editor .scribe-edit-split-caret svg { display: block; }

      /* Language menu under the recognition-language caret. */
      .scribe-pdf-editor .scribe-edit-menu {
        position: absolute; top: calc(100% + 6px); right: 0; min-width: 150px; padding: 4px;
        background: #3c4043; border: 1px solid rgba(255, 255, 255, .12); border-radius: 8px;
        box-shadow: 0 6px 20px rgba(0, 0, 0, .45); z-index: 30;
      }
      .scribe-pdf-editor .scribe-edit-menu-item {
        position: relative; display: flex; align-items: center; padding: 6px 10px 6px 26px;
        border-radius: 4px; font-size: 13px; color: #e8eaed; cursor: pointer; white-space: nowrap;
      }
      .scribe-pdf-editor .scribe-edit-menu-item:hover { background: rgba(255, 255, 255, .08); }
      .scribe-pdf-editor .scribe-edit-menu-item.selected::before {
        content: ''; position: absolute; left: 10px; top: 50%; width: 5px; height: 9px;
        border: solid #6aa9e0; border-width: 0 2px 2px 0; transform: translate(0, -60%) rotate(45deg);
      }

      /* Subtle recognition progress line: a 3px accent fill along the toolbar's bottom edge, scaled by progress. */
      .scribe-pdf-editor .scribe-ocr-progress {
        position: absolute; left: 0; bottom: 0; width: 100%; height: 3px;
        background: #287bb5; transform: scaleX(0); transform-origin: left;
        opacity: 0; pointer-events: none; z-index: 25;
        transition: transform .2s ease, opacity .3s ease;
      }
    `));
    document.head.appendChild(style);
  }
}

export { ScribePDFEditor, ScribeViewer };
