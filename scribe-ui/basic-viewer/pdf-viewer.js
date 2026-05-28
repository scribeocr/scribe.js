import scribe from '../../scribe.js';
import { ScribeViewer } from '../viewer.js';
import { applyHighlight } from '../js/viewerHighlights.js';

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
   * @param {boolean} [options.showToolbar=true] - Render the chrome toolbar (page nav, zoom,
   *   highlight controls). When false the viewer fills the container with the canvas only.
   * @param {boolean} [options.showDropZone=true] - Render the drag-and-drop file upload zone.
   *   When false, consumers must load documents via `importFile` or `attachDocument`.
   * @param {FitMode} [options.fit='height'] - How to size the first page when a document opens.
   *   `'width'` fits page width to the viewer. `'height'` (default) fits page height. `'page'` fits
   *   the whole page. A function receives the page dims and viewer dims and returns `{zoom, x?, y?}`.
   * @param {boolean} [options.autoResize=true] - Install a ResizeObserver on `container` and
   *   resize the viewer to match its dimensions whenever they change.
   * @param {ScribeViewer} [options.scribe] - Attach to an existing `ScribeViewer` instance instead
   *   of creating a new one. Use to share state with an already-instantiated viewer.
   */
  constructor(container, options = {}) {
    const {
      width = 'auto',
      height = 'auto',
      highlight = true,
      showToolbar = true,
      showDropZone = true,
      fit = 'height',
      autoResize = true,
    } = options;

    this.container = container;
    this.showToolbar = showToolbar;
    this.showDropZone = showDropZone;
    /** @type {?import('../../js/containers/scribeDoc.js').ScribeDoc} */
    this.doc = null;

    /**
     * The `ScribeViewer` instance backing this viewer. Each `ScribePDFViewer` owns its own
     * `ScribeViewer`, so multiple `ScribePDFViewer` instances can coexist on the page without
     * sharing state. Pass `options.scribe` to attach to an existing instance.
     * @type {ScribeViewer}
     */
    this.scribe = options.scribe || new ScribeViewer();

    const initWidth = width === 'auto' ? (container.clientWidth || 800) : width;
    const initHeight = height === 'auto' ? (container.clientHeight || 1000) : height;

    this.scribe.enableHTMLOverlay = true;
    scribe.ScribeDoc.defaults.displayMode = 'invis';

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

    ScribePDFViewer.addIconButtonStyles();

    this.pdfViewerElem = document.createElement('div');
    this.pdfViewerElem.className = 'scribe-pdf-viewer';
    this.pdfViewerElem.style.width = `${initWidth}px`;
    this.pdfViewerElem.style.height = `${initHeight}px`;
    this.pdfViewerElem.style.backgroundColor = 'rgb(82, 86, 89)';
    this.pdfViewerElem.style.fontFamily = '\'Segoe UI\', Tahoma, sans-serif';

    this.toolbarHeight = showToolbar ? 56 : 0;

    if (showToolbar) {
      const toolbarElem = document.createElement('div');
      toolbarElem.className = 'scribe-pdf-viewer-toolbar';
      toolbarElem.style.width = '100%';
      toolbarElem.style.height = `${this.toolbarHeight}px`;
      toolbarElem.style.alignItems = 'center';
      toolbarElem.style.color = '#fff';
      toolbarElem.style.display = 'flex';
      toolbarElem.style.position = 'relative';
      toolbarElem.style.zIndex = '10';
      toolbarElem.style.lineHeight = '32px';
      toolbarElem.style.backgroundColor = '#323639';

      const toolbarElemStart = document.createElement('div');
      toolbarElemStart.style.flex = '1';

      const center = document.createElement('div');

      const toolbarElemEnd = document.createElement('div');
      toolbarElemEnd.style.flex = '1';
      toolbarElemEnd.style.display = 'flex';
      toolbarElemEnd.style.justifyContent = 'flex-end';
      toolbarElemEnd.style.alignItems = 'center';

      const toolbarButtons = document.createElement('div');
      toolbarButtons.className = 'col-md order-2 my-auto';

      const prevElem = document.createElement('span');
      prevElem.className = 'cr-icon-button';
      prevElem.setAttribute('iron-icon', 'pdf:add');
      prevElem.title = 'Previous page';
      prevElem.role = 'button';
      prevElem.tabIndex = 0;
      prevElem.ariaDisabled = 'false';
      prevElem.ariaLabel = 'Previous page';

      const prevIcon = document.createElement('span');
      prevIcon.className = 'cr-icon';
      prevIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px">
      <path d="m313-440 224 224-57 56-320-320 320-320 57 56-224 224h487v80H313Z" /></svg>`;
      prevElem.appendChild(prevIcon);

      const nextElem = document.createElement('span');
      nextElem.className = 'cr-icon-button';
      nextElem.setAttribute('iron-icon', 'pdf:add');
      nextElem.title = 'Next page';
      nextElem.role = 'button';
      nextElem.tabIndex = 0;
      nextElem.ariaDisabled = 'false';
      nextElem.ariaLabel = 'Next page';

      const nextIcon = document.createElement('span');
      nextIcon.className = 'cr-icon';
      nextIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px">
      <path d="M647-440H160v-80h487L423-744l57-56 320 320-320 320-57-56 224-224Z"/></svg>`;
      nextElem.appendChild(nextIcon);

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

      const verticalSeparator1 = document.createElement('span');
      verticalSeparator1.className = 'vertical-separator';

      const zoomControls = document.createElement('span');

      const zoomOutElem = document.createElement('span');
      zoomOutElem.className = 'cr-icon-button';
      zoomOutElem.setAttribute('iron-icon', 'pdf:remove');
      zoomOutElem.title = 'Zoom out';
      zoomOutElem.role = 'button';
      zoomOutElem.tabIndex = 0;
      zoomOutElem.ariaDisabled = 'false';

      const zoomOutIcon = document.createElement('span');
      zoomOutIcon.className = 'cr-icon';
      zoomOutIcon.innerHTML = `<svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" focusable="false" role="none" style="pointer-events: none; display: block; width: 100%; height: 100%;">
      <g><path d="M19 13H5v-2h14v2z"></path></g></svg>`;
      zoomOutElem.appendChild(zoomOutIcon);

      const zoomInElem = document.createElement('span');
      zoomInElem.className = 'cr-icon-button';
      zoomInElem.setAttribute('iron-icon', 'pdf:add');
      zoomInElem.title = 'Zoom in';
      zoomInElem.role = 'button';
      zoomInElem.tabIndex = 0;
      zoomInElem.ariaDisabled = 'false';

      const zoomInIcon = document.createElement('span');
      zoomInIcon.className = 'cr-icon';
      zoomInIcon.innerHTML = `<svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" focusable="false" role="none" style="pointer-events: none; display: block; width: 100%; height: 100%;">
      <g><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"></path></g></svg>`;
      zoomInElem.appendChild(zoomInIcon);

      zoomControls.appendChild(zoomOutElem);
      zoomControls.appendChild(zoomInElem);

      const verticalSeparator2 = document.createElement('span');
      verticalSeparator2.className = 'vertical-separator';

      let colorContainer = null;
      let highlightElem = null;
      if (highlightColors) {
        this.highlightMode = false;
        this.highlightColor = defaultHighlightColor;
        // eslint-disable-next-line max-len
        this.highlightCursor = 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' height=\'24\' width=\'24\' viewBox=\'0 -960 960 960\'%3E%3Cpath fill=\'white\' stroke=\'black\' stroke-width=\'30\' d=\'m268-212-56-56q-12-12-12-28.5t12-28.5l423-423q12-12 28.5-12t28.5 12l56 56q12 12 12 28.5T748-635L324-212q-11 11-28 11t-28-11Z\'/%3E%3C/svg%3E") 12 12, auto';

        highlightElem = document.createElement('span');
        highlightElem.className = 'cr-icon-button';
        highlightElem.title = 'Highlight';
        highlightElem.role = 'button';
        highlightElem.tabIndex = 0;

        const highlightIcon = document.createElement('span');
        highlightIcon.className = 'cr-icon';
        highlightIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" height="20" width="20" viewBox="0 -960 960 960" fill="currentColor">
        <path d="M280-320v-440q0-33 23.5-56.5T360-840q9 0 18 2t17 6l240 119q20 10 32.5 29.5T680-641v321H280Zm80-80h240v-241L360-760v360ZM160-120l22-65q8-25 29-40t47-15h444q26 0 47 15t29 40l22 65H160Zm200-280h240-240Z"/>
        </svg>`;
        highlightElem.appendChild(highlightIcon);

        const localHighlightElem = highlightElem;
        localHighlightElem.addEventListener('mousedown', (e) => e.preventDefault());
        localHighlightElem.addEventListener('click', () => {
          this.highlightMode = !this.highlightMode;
          localHighlightElem.classList.toggle('active', this.highlightMode);
          this.updateHighlightCursorStyle();
        });

        if (highlightColors.length > 1) {
          colorContainer = document.createElement('span');
          colorContainer.style.display = 'inline-flex';
          colorContainer.style.alignItems = 'center';
          colorContainer.style.gap = '4px';
          colorContainer.style.marginLeft = '4px';

          this.colorBtnElems = [];
          for (const color of highlightColors) {
            const btn = document.createElement('span');
            btn.className = 'highlight-color-btn';
            btn.style.backgroundColor = color;
            if (color === this.highlightColor) btn.classList.add('active');
            btn.addEventListener('mousedown', (e) => e.preventDefault());
            btn.addEventListener('click', () => {
              this.highlightColor = color;
              this.colorBtnElems.forEach((b) => b.classList.remove('active'));
              btn.classList.add('active');

              const matchedWords = this.getSelectedOverlayWords();
              if (matchedWords.length > 0) {
                const n = this.scribe.state.cp.n;
                applyHighlight(this.scribe, matchedWords, n, this.highlightColor, 0.5);
                window.getSelection()?.removeAllRanges();
                this.scribe.deleteHTMLOverlay();
                this.scribe.renderHTMLOverlay();
              } else if (!this.highlightMode) {
                this.highlightMode = true;
                localHighlightElem.classList.add('active');
                this.updateHighlightCursorStyle();
              }
            });
            this.colorBtnElems.push(btn);
            colorContainer.appendChild(btn);
          }
        }
      }

      toolbarButtons.appendChild(prevElem);
      toolbarButtons.appendChild(nextElem);
      toolbarButtons.appendChild(pageInputGroup);
      toolbarButtons.appendChild(verticalSeparator1);
      toolbarButtons.appendChild(zoomControls);
      if (highlightElem) {
        toolbarButtons.appendChild(verticalSeparator2);
        toolbarButtons.appendChild(highlightElem);
        if (colorContainer) toolbarButtons.appendChild(colorContainer);
      }

      center.appendChild(toolbarButtons);

      toolbarElem.appendChild(toolbarElemStart);
      toolbarElem.appendChild(center);
      toolbarElem.appendChild(toolbarElemEnd);

      this.pdfViewerElem.appendChild(toolbarElem);

      nextElem.addEventListener('mousedown', (e) => e.preventDefault());
      nextElem.addEventListener('click', () => this.scribe.displayPage(this.scribe.state.cp.n + 1, true, false));
      prevElem.addEventListener('mousedown', (e) => e.preventDefault());
      prevElem.addEventListener('click', () => this.scribe.displayPage(this.scribe.state.cp.n - 1, true, false));

      pageNumElem.addEventListener('keyup', (event) => {
        if (event.key === 'Enter') {
          this.scribe.displayPage(parseInt(pageNumElem.value) - 1, true, false);
        }
      });

      zoomInElem.addEventListener('mousedown', (e) => e.preventDefault());
      zoomInElem.addEventListener('click', () => {
        this.scribe.zoom(1.1, this.scribe.getStageCenter());
      });

      zoomOutElem.addEventListener('mousedown', (e) => e.preventDefault());
      zoomOutElem.addEventListener('click', () => {
        this.scribe.zoom(0.9, this.scribe.getStageCenter());
      });

      this.toolbarElem = toolbarElem;
      this.toolbarElemStart = toolbarElemStart;
      this.toolbarElemEnd = toolbarElemEnd;
      this.prevElem = prevElem;
      this.nextElem = nextElem;
      this.pageNumElem = pageNumElem;
      this.pageCountElem = pageCountElem;
      this.zoomInElem = zoomInElem;
      this.zoomOutElem = zoomOutElem;
      if (highlightElem) this.highlightElem = highlightElem;
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
      const dropZone = document.createElement('div');
      dropZone.className = 'upload_dropZone text-center p-4';
      dropZone.style.zIndex = '8';
      dropZone.style.top = `${this.toolbarHeight}px`;
      dropZone.style.position = 'absolute';
      dropZone.style.height = `${initHeight - this.toolbarHeight}px`;
      dropZone.style.width = `${initWidth - 6}px`;

      const uploadDiv = document.createElement('div');
      uploadDiv.style.position = 'relative';
      uploadDiv.style.top = '35%';
      uploadDiv.style.color = '#dddddd';

      const instructions = document.createElement('p');
      instructions.className = 'small';
      instructions.innerHTML = 'Drag &amp; drop files inside dashed region<br><i>or</i>';

      const openFileInputElem = document.createElement('input');
      openFileInputElem.type = 'file';
      openFileInputElem.multiple = true;
      openFileInputElem.style.visibility = 'hidden';
      openFileInputElem.style.position = 'absolute';

      const fileInputLabel = document.createElement('label');
      fileInputLabel.className = 'btn btn-info mb-3';
      fileInputLabel.style.minWidth = '8rem';
      fileInputLabel.style.border = '1px solid';
      fileInputLabel.style.padding = '0.4rem';
      fileInputLabel.textContent = 'Select Files';
      fileInputLabel.appendChild(openFileInputElem);

      const uploadGallery1 = document.createElement('div');
      uploadGallery1.className = 'upload_gallery d-flex flex-wrap justify-content-center gap-3 mb-0';
      uploadGallery1.style.display = 'inline!important';

      const uploadGallery2 = document.createElement('div');
      uploadGallery2.className = 'upload_gallery d-flex flex-wrap justify-content-center gap-3 mb-0';

      uploadDiv.appendChild(instructions);
      uploadDiv.appendChild(fileInputLabel);
      uploadDiv.appendChild(uploadGallery1);
      uploadDiv.appendChild(uploadGallery2);

      dropZone.appendChild(uploadDiv);
      this.pdfViewerElem.appendChild(dropZone);

      openFileInputElem.addEventListener('change', () => {
        if (!openFileInputElem.files || openFileInputElem.files.length === 0) return;
        this.importFile(openFileInputElem.files[0]);
      });

      this.highlightActiveCt = 0;
      dropZone.addEventListener('dragover', (event) => {
        event.preventDefault();
        dropZone.classList.add('highlight');
        this.highlightActiveCt++;
      });

      dropZone.addEventListener('dragleave', (event) => {
        event.preventDefault();
        const highlightActiveCtNow = this.highlightActiveCt;
        setTimeout(() => {
          if (highlightActiveCtNow === this.highlightActiveCt) {
            dropZone.classList.remove('highlight');
          }
        }, 100);
      });

      dropZone.addEventListener('drop', async (event) => {
        event.preventDefault();
        if (!event.dataTransfer) return;
        const items = await ScribeViewer.getAllFileEntries(event.dataTransfer.items);
        const filesPromises = await Promise.allSettled(items.map((x) => new Promise((resolve, reject) => {
          if (x instanceof File) {
            resolve(x);
          } else {
            x.file(resolve, reject);
          }
        })));
        const files = filesPromises
          .filter(/** @returns {x is PromiseFulfilledResult<File>} */(x) => x.status === 'fulfilled')
          .map((x) => x.value);
        if (files.length === 0) return;
        dropZone.classList.remove('highlight');
        this.importFile(files[0]);
      });

      this.dropZone = dropZone;
      this.openFileInputElem = openFileInputElem;
    }

    this._installFit(fit);

    this.scribe.init(this.viewerContainer, initWidth, initHeight - this.toolbarHeight);

    if (highlightColors) {
      document.addEventListener('mouseup', (event) => {
        if (!this.highlightMode) return;
        if (!(event.target instanceof Node) || !this.pdfViewerElem.contains(event.target)) return;

        const matchedWords = this.getSelectedOverlayWords();
        if (matchedWords.length === 0) return;
        if (!this.highlightColor) return;

        const n = this.scribe.state.cp.n;
        applyHighlight(this.scribe, matchedWords, n, this.highlightColor, 0.5);

        window.getSelection()?.removeAllRanges();
        this.scribe.deleteHTMLOverlay();
        this.scribe.renderHTMLOverlay();
      });
    }

    // Backup mouseup listener on the document to clear selection state
    // if mouseup happens outside of the Konva stage (e.g. on an HTML overlay element).
    document.addEventListener('mouseup', () => {
      if (this.scribe.selecting) {
        this.scribe.selecting = false;
        this.scribe.selectingRectangle?.visible(false);
        this.scribe.layerText?.batchDraw();
      }
    });

    this.commentTooltip = document.createElement('div');
    this.commentTooltip.className = 'highlight-comment-tooltip';
    this.commentTooltip.style.display = 'none';
    this.scribe.elem.appendChild(this.commentTooltip);

    let commentIconTimer = null;
    const isWordOrLine = (n) => n instanceof HTMLElement
      && (n.classList.contains('scribe-word') || n.classList.contains('scribe-line'));
    const observer = new MutationObserver((mutations) => {
      const hasRemoved = mutations.some((m) => [...m.removedNodes].some(isWordOrLine));
      if (hasRemoved) {
        this.scribe.elem?.querySelectorAll('.highlight-comment-icon').forEach((el) => el.remove());
        this.commentTooltip.style.display = 'none';
      }
      const hasAdded = mutations.some((m) => [...m.addedNodes].some(isWordOrLine));
      if (!hasAdded) return;
      if (commentIconTimer) clearTimeout(commentIconTimer);
      commentIconTimer = setTimeout(() => this.updateCommentIcons(), 100);
    });
    observer.observe(this.scribe.elem, { childList: true });

    const origCallback = this.scribe.displayPageCallback;
    this.scribe.displayPageCallback = () => {
      if (origCallback) origCallback();
      if (this.pageNumElem) this.pageNumElem.value = (this.scribe.state.cp.n + 1).toString();
      setTimeout(() => this.updateCommentIcons(), 250);
    };

    container.appendChild(this.pdfViewerElem);

    if (autoResize && typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w > 0 && h > 0) this.resize(w, h);
      });
      this.resizeObserver.observe(container);
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
    if (!this.scribe.stage) return;
    const current = this.scribe.stage.scaleX() || 1;
    this.scribe.zoom(scale / current, this.scribe.getStageCenter());
  }

  /**
   * Attach an existing `ScribeDoc` to the viewer instead of importing fresh bytes.
   * Use when the parent application already has a parsed document (e.g. from a prior text-extraction
   * step) so the viewer can skip re-parsing, re-rendering fonts, and re-running OCR.
   * Terminates the previously attached document if it differs from `doc`.
   * @param {import('../../js/containers/scribeDoc.js').ScribeDoc} doc
   * @param {number} [initialPage=0]
   */
  async attachDocument(doc, initialPage = 0) {
    if (this.doc && this.doc !== doc) await this.doc.terminate();
    this.doc = doc;
    this.scribe.doc = doc;

    for (let i = 0; i < doc.inputData.pageCount; i++) {
      if (!doc.annotations.pages[i]) doc.annotations.pages[i] = [];
    }

    if (this.pageCountElem) this.pageCountElem.textContent = doc.inputData.pageCount.toString();
    if (this.pageNumElem) this.pageNumElem.value = (initialPage + 1).toString();

    this.scribe.runSetInitial = true;
    await this.scribe.displayPage(initialPage, initialPage > 0);

    if (this.dropZone) this.dropZone.style.display = 'none';
  }

  /**
   * Import a document into the viewer.
   * Accepts a `File`, `Blob`, `ArrayBuffer`, `Uint8Array`, or a filesystem path string (Node only).
   * Raw byte inputs (`ArrayBuffer`, `Uint8Array`, non-File `Blob`) are treated as PDFs.
   * @param {File | Blob | ArrayBuffer | Uint8Array | string} file
   * @param {number} [initialPage=0]
   */
  async importFile(file, initialPage = 0) {
    let doc;
    if (this.doc) await this.doc.terminate();

    if (file instanceof ArrayBuffer) {
      doc = await scribe.openDocument({ pdfFiles: [file] });
    } else if (typeof Uint8Array !== 'undefined' && file instanceof Uint8Array) {
      const ab = /** @type {ArrayBuffer} */ (file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
      doc = await scribe.openDocument({ pdfFiles: [ab] });
    } else if (typeof File !== 'undefined' && file instanceof File) {
      doc = await scribe.openDocument([file]);
    } else if (typeof Blob !== 'undefined' && file instanceof Blob) {
      doc = await scribe.openDocument({ pdfFiles: [await file.arrayBuffer()] });
    } else if (typeof file === 'string') {
      doc = await scribe.openDocument([file]);
    } else {
      throw new Error('importFile: input must be File, Blob, ArrayBuffer, Uint8Array, or a filesystem path string.');
    }

    this.doc = doc;
    this.scribe.doc = doc;

    for (let i = 0; i < doc.inputData.pageCount; i++) {
      if (!doc.annotations.pages[i]) doc.annotations.pages[i] = [];
    }

    if (this.pageCountElem) this.pageCountElem.textContent = doc.inputData.pageCount.toString();
    if (this.pageNumElem) this.pageNumElem.value = (initialPage + 1).toString();

    this.scribe.runSetInitial = true;
    await this.scribe.displayPage(initialPage, initialPage > 0);

    if (this.dropZone) this.dropZone.style.display = 'none';
  }

  /**
   * Resize the viewer to new pixel dimensions.
   * @param {number} width
   * @param {number} height
   */
  resize(width, height) {
    this.pdfViewerElem.style.width = `${width}px`;
    this.pdfViewerElem.style.height = `${height}px`;
    if (this.dropZone) {
      this.dropZone.style.width = `${width - 6}px`;
      this.dropZone.style.height = `${height - this.toolbarHeight}px`;
    }
    this.scribe.resize(width, height - this.toolbarHeight);
  }

  /**
   * Tear down the viewer, disconnect observers, terminate the document, and remove the DOM.
   */
  async destroy() {
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.doc) {
      try { await this.doc.terminate(); } catch { /* ignore */ }
      this.doc = null;
    }
    if (this.pdfViewerElem.parentNode) this.pdfViewerElem.parentNode.removeChild(this.pdfViewerElem);
  }

  /**
   * Install a `setInitialPositionZoom` implementation on `ScribeViewer` based on the requested fit mode.
   * @param {FitMode} fitMode
   */
  _installFit(fitMode) {
    this.scribe.setInitialPositionZoom = (imgDims) => {
      this.scribe.runSetInitial = false;
      const stageW = this.scribe.stage.width();
      const stageH = this.scribe.stage.height();

      if (typeof fitMode === 'function') {
        const r = fitMode(imgDims, { width: stageW, height: stageH });
        this.scribe.stage.scaleX(r.zoom);
        this.scribe.stage.scaleY(r.zoom);
        this.scribe.stage.x(r.x ?? (stageW - imgDims.width * r.zoom) / 2);
        this.scribe.stage.y(r.y ?? 30);
        return;
      }

      let zoom;
      let y;
      if (fitMode === 'width') {
        zoom = stageW / imgDims.width;
        y = 30;
      } else if (fitMode === 'page') {
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

      this.scribe.stage.scaleX(zoom);
      this.scribe.stage.scaleY(zoom);
      this.scribe.stage.x((stageW - imgDims.width * zoom) / 2);
      this.scribe.stage.y(y);
    };
  }

  /**
   * Returns KonvaOcrWord objects corresponding to the current browser text selection
   * based on the HTML text overlay.
   */
  getSelectedOverlayWords() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return [];

    const range = sel.getRangeAt(0);
    const wordElems = this.pdfViewerElem.querySelectorAll('.scribe-word');
    const selectedIds = [];
    for (const elem of wordElems) {
      if (range.intersectsNode(elem)) {
        selectedIds.push(elem.id);
      }
    }
    if (selectedIds.length === 0) return [];

    const allKonvaWords = this.scribe.getKonvaWords();
    const idSet = new Set(selectedIds);
    return allKonvaWords.filter((kw) => idSet.has(kw.word.id));
  }

  /**
   * Adds or removes a style rule that changes the cursor on `.scribe-word` overlay elements
   * to the highlighter icon when highlight mode is active.
   */
  updateHighlightCursorStyle() {
    if (!this.highlightCursorStyleElem) {
      this.highlightCursorStyleElem = document.createElement('style');
      document.head.appendChild(this.highlightCursorStyleElem);
    }
    if (this.highlightMode) {
      this.highlightCursorStyleElem.textContent = `.scribe-word { cursor: ${this.highlightCursor} !important; }`;
    } else {
      this.highlightCursorStyleElem.textContent = '';
    }
  }

  /**
   * Places a small comment icon at the start of each highlight group that has a comment.
   * Hovering the icon shows a tooltip with the comment text.
   */
  updateCommentIcons() {
    this.scribe.elem?.querySelectorAll('.highlight-comment-icon').forEach((el) => el.remove());

    const allWords = this.scribe.getKonvaWords();
    if (!allWords || allWords.length === 0) return;

    const groupFirstWord = new Map();
    for (const kw of allWords) {
      if (!kw.highlightGroupId || !kw.highlightComment) continue;
      if (!groupFirstWord.has(kw.highlightGroupId)) {
        groupFirstWord.set(kw.highlightGroupId, kw);
      } else {
        const existing = groupFirstWord.get(kw.highlightGroupId);
        // Pick the topmost, then leftmost word as the anchor
        if (kw.word.bbox.top < existing.word.bbox.top
          || (kw.word.bbox.top === existing.word.bbox.top && kw.word.bbox.left < existing.word.bbox.left)) {
          groupFirstWord.set(kw.highlightGroupId, kw);
        }
      }
    }

    const viewerElem = this.scribe.elem;

    for (const [, kw] of groupFirstWord) {
      const wordElem = viewerElem.querySelector(`.scribe-word[id="${kw.word.id}"]`);
      if (!wordElem) continue;

      const wordLeft = parseFloat(/** @type {HTMLElement} */ (wordElem).style.left) || 0;
      const wordTop = parseFloat(/** @type {HTMLElement} */ (wordElem).style.top) || 0;

      const icon = document.createElement('span');
      icon.className = 'highlight-comment-icon';
      icon.textContent = '💬';
      icon.style.left = `${wordLeft - 16}px`;
      icon.style.top = `${wordTop - 14}px`;

      icon.addEventListener('mouseover', () => {
        this.commentTooltip.textContent = kw.highlightComment;
        this.commentTooltip.style.visibility = 'hidden';
        this.commentTooltip.style.display = '';
        const iconLeft = parseFloat(icon.style.left) || 0;
        const iconTop = parseFloat(icon.style.top) || 0;
        this.commentTooltip.style.left = `${iconLeft}px`;
        this.commentTooltip.style.top = `${iconTop - this.commentTooltip.offsetHeight - 4}px`;
        this.commentTooltip.style.visibility = '';
      });

      icon.addEventListener('mouseout', () => {
        this.commentTooltip.style.display = 'none';
      });

      viewerElem.appendChild(icon);
    }
  }

  static styleAdded = false;

  /** Adds the required CSS styles to the document. */
  static addIconButtonStyles = () => {
    if (ScribePDFViewer.styleAdded) return;
    ScribePDFViewer.styleAdded = true;
    const style = document.createElement('style');
    style.type = 'text/css';

    const css = `
    .scribe-pdf-viewer .cr-icon {
      align-items: center;
      display: inline-flex;
      justify-content: center;
      position: relative;
      vertical-align: middle;
      fill: currentcolor;
      stroke: none;
      width: 32px;
      height: 32px;
    }

    .scribe-pdf-viewer .cr-icon-button {
      -webkit-tap-highlight-color: transparent;
      border-radius: 50%;
      cursor: pointer;
      display: inline-flex;
      flex-shrink: 0;
      height: 32px;
      outline: 0px;
      overflow: hidden;
      position: relative;
      user-select: none;
      vertical-align: middle;
      width: 32px;
    }

    .scribe-pdf-viewer .cr-icon-button:hover {
      background: rgba(255, 255, 255, .08);
      border-radius: 50%;
    }

    .scribe-pdf-viewer .cr-icon-button.active {
      background: rgba(255, 255, 255, .2);
    }

    .scribe-pdf-viewer .highlight-color-btn {
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

    .scribe-pdf-viewer .highlight-color-btn:hover {
      border-color: rgba(255, 255, 255, .5);
    }

    .scribe-pdf-viewer .highlight-color-btn.active {
      border-color: #fff;
    }

    .scribe-pdf-viewer .highlight-comment-icon {
      position: absolute;
      font-size: 14px;
      cursor: default;
      z-index: 15;
      user-select: none;
      pointer-events: auto;
    }

    .scribe-pdf-viewer .highlight-comment-tooltip {
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

    .scribe-pdf-viewer .vertical-separator {
      background: rgba(255, 255, 255, .3);
      height: 15px;
      width: 1px;
      margin-left: 10px;
      margin-right: 10px;
      display: inline-block;
    }

    .scribe-pdf-viewer .upload_dropZone {
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

    .scribe-pdf-viewer .upload_dropZone.highlight {
      outline-offset: -4px;
      outline-color: #191b1d;
      background-color: rgb(106, 111, 114);
    }

    .scribe-pdf-viewer-toolbar input {
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
  `;

    style.appendChild(document.createTextNode(css));
    document.head.appendChild(style);
  };
}

// Auto-instantiate the basic-viewer demo when the page provides `#pdfViewerCont`.
// This is the entry point used by `index.html`, `tauri-entry.js`, and `electron-entry.js`.
// When importing this module from a page without that element (e.g. when embedding `ScribePDFViewer` in your own container),
// no side effects fire and you can construct an instance yourself.
const pdfViewerContElem = /** @type {HTMLDivElement|null} */(document.getElementById('pdfViewerCont'));

const buildBootstrapViewer = () => {
  if (!pdfViewerContElem) return null;
  if (!pdfViewerContElem.style.width) pdfViewerContElem.style.width = '100vw';
  if (!pdfViewerContElem.style.height) pdfViewerContElem.style.height = '100vh';
  const v = new ScribePDFViewer(pdfViewerContElem);
  // Exposing important modules for debugging and testing purposes.
  // These should not be relied upon in code--import/export should be used instead.
  globalThis.df = {
    scribe,
    ScribeCanvas: ScribeViewer,
    applyHighlight,
    pdfViewer: v,
  };
  return v;
};

/** @type {ScribePDFViewer|null} */
const pdfViewer = buildBootstrapViewer();

let currentFile = null;
async function handleLoadFile(file, page, readFileFn) {
  if (!pdfViewer) throw new Error('handleLoadFile requires the auto-instantiated viewer. Use ScribePDFViewer + importFile directly when embedding.');
  if (pdfViewer.dropZone) pdfViewer.dropZone.style.display = 'none';

  if (currentFile === file) {
    await pdfViewer.scribe.displayPage(page, true, false);
    return;
  }
  const { buffer, name } = await readFileFn(file);
  const fileObj = new File([buffer], name, { type: 'application/pdf' });
  await pdfViewer.importFile(fileObj, page || 0);
  currentFile = file;
}

async function handleHighlights(highlights) {
  if (!pdfViewer) throw new Error('handleHighlights requires the auto-instantiated viewer.');
  const sv = pdfViewer.scribe;
  for (const highlight of highlights) {
    const pageNum = highlight.page;
    const page = sv.doc.ocr.active[pageNum];
    if (!page) continue;

    const lines = highlight.lines;
    if (!lines || lines.length === 0) continue;

    if (sv.state.cp.n !== pageNum) {
      await sv.displayPage(pageNum, true, false);
    }

    const allWords = sv.getKonvaWords();
    const matchedWords = [];

    for (let i = 0; i < lines.length; i++) {
      const lineNum = lines[i];
      const line = page.lines[lineNum];
      if (!line) continue;

      let lineKonvaWords = allWords.filter((kw) => line.words.includes(kw.word));

      if (i === 0 && highlight.startText) {
        const startIdx = lineKonvaWords.findIndex((kw) => kw.word.text.includes(highlight.startText));
        if (startIdx >= 0) lineKonvaWords = lineKonvaWords.slice(startIdx);
      }

      if (i === lines.length - 1 && highlight.endText) {
        const endIdx = lineKonvaWords.findIndex((kw) => kw.word.text.includes(highlight.endText));
        if (endIdx >= 0) lineKonvaWords = lineKonvaWords.slice(0, endIdx + 1);
      }

      matchedWords.push(...lineKonvaWords);
    }

    if (matchedWords.length > 0) {
      applyHighlight(sv, matchedWords, pageNum, highlight.color || '#ffff00', highlight.opacity || 0.4);
    }
  }
}

export {
  scribe, ScribeViewer, applyHighlight, pdfViewer, ScribePDFViewer, handleLoadFile, handleHighlights,
};
