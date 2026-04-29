import scribe from '../../scribe.js';
import { ScribeViewer } from '../viewer.js';
import { applyHighlight } from '../js/viewerHighlights.js';

ScribeViewer.enableHTMLOverlay = true;

scribe.opt.displayMode = 'invis';

class ScribePDFViewer {
  constructor(container, width = 800, height = 1000) {
    ScribePDFViewer.addIconButtonStyles();

    // Create the root div
    this.pdfViewerElem = document.createElement('div');
    this.pdfViewerElem.style.width = `${width}px`;
    this.pdfViewerElem.style.height = `${height}px`;
    this.pdfViewerElem.style.backgroundColor = 'rgb(82, 86, 89)';
    this.pdfViewerElem.style.fontFamily = '\'Segoe UI\', Tahoma, sans-serif';

    // Create toolbar div
    const toolbarHeight = 56;
    this.toolbarElem = document.createElement('div');
    this.toolbarElem.style.width = '100%';
    this.toolbarElem.style.height = `${toolbarHeight}px`;

    this.toolbarElem.style.alignItems = 'center';
    this.toolbarElem.style.color = '#fff';
    this.toolbarElem.style.display = 'flex';
    this.toolbarElem.style.position = 'relative';
    this.toolbarElem.style.zIndex = '10';
    this.toolbarElem.style.lineHeight = '32px';
    this.toolbarElem.style.backgroundColor = '#323639';
    // Start, Center, and End containers
    this.toolbarElemStart = document.createElement('div');
    this.toolbarElemStart.style.flex = '1';

    const center = document.createElement('div');

    this.toolbarElemEnd = document.createElement('div');
    this.toolbarElemEnd.style.flex = '1';
    this.toolbarElemEnd.style.display = 'flex';
    this.toolbarElemEnd.style.justifyContent = 'flex-end';
    this.toolbarElemEnd.style.alignItems = 'center';

    // Toolbar buttons container
    const toolbarButtons = document.createElement('div');
    toolbarButtons.className = 'col-md order-2 my-auto';

    // Previous button
    this.prevElem = document.createElement('span');
    this.prevElem.className = 'cr-icon-button';
    this.prevElem.setAttribute('iron-icon', 'pdf:add');
    this.prevElem.title = 'Zoom in';
    this.prevElem.role = 'button';
    this.prevElem.tabIndex = 0;
    this.prevElem.ariaDisabled = 'false';
    this.prevElem.ariaLabel = 'Zoom in';

    const prevIcon = document.createElement('span');
    prevIcon.className = 'cr-icon';
    prevIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px">
    <path d="m313-440 224 224-57 56-320-320 320-320 57 56-224 224h487v80H313Z" /></svg>`;

    this.prevElem.appendChild(prevIcon);

    // Next button
    this.nextElem = document.createElement('span');
    this.nextElem.className = 'cr-icon-button';
    this.nextElem.setAttribute('iron-icon', 'pdf:add');
    this.nextElem.title = 'Zoom in';
    this.nextElem.role = 'button';
    this.nextElem.tabIndex = 0;
    this.nextElem.ariaDisabled = 'false';
    this.nextElem.ariaLabel = 'Zoom in';

    const nextIcon = document.createElement('span');
    nextIcon.className = 'cr-icon';
    nextIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px">
    <path d="M647-440H160v-80h487L423-744l57-56 320 320-320 320-57-56 224-224Z"/></svg>`;

    this.nextElem.appendChild(nextIcon);

    // Page input group
    const pageInputGroup = document.createElement('div');
    pageInputGroup.className = 'btn-group';
    pageInputGroup.style.display = 'inline-flex';

    this.pageNumElem = document.createElement('input');
    this.pageNumElem.type = 'text';
    this.pageNumElem.className = 'form-control btn-sm';
    this.pageNumElem.name = 'pageNum';
    this.pageNumElem.autocomplete = 'off';
    this.pageNumElem.style.width = '3em';
    this.pageNumElem.style.display = 'inline-block';

    this.pageCountElem = document.createElement('span');
    this.pageCountElem.style.display = 'inline-block';
    this.pageCountElem.style.minWidth = '0.5rem';
    this.pageCountElem.style.fontSize = '14px';
    this.pageCountElem.style.paddingLeft = '0.5rem';

    pageInputGroup.appendChild(this.pageNumElem);
    pageInputGroup.appendChild(document.createTextNode(' / '));
    pageInputGroup.appendChild(this.pageCountElem);

    // Vertical separator
    const verticalSeparator1 = document.createElement('span');
    verticalSeparator1.className = 'vertical-separator';

    // Zoom controls
    const zoomControls = document.createElement('span');

    this.zoomOutElem = document.createElement('span');
    this.zoomOutElem.className = 'cr-icon-button';
    this.zoomOutElem.setAttribute('iron-icon', 'pdf:remove');
    this.zoomOutElem.title = 'Zoom out';
    this.zoomOutElem.role = 'button';
    this.zoomOutElem.tabIndex = 0;
    this.zoomOutElem.ariaDisabled = 'false';

    const zoomOutIcon = document.createElement('span');
    zoomOutIcon.className = 'cr-icon';
    zoomOutIcon.innerHTML = `<svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" focusable="false" role="none" style="pointer-events: none; display: block; width: 100%; height: 100%;">
    <g><path d="M19 13H5v-2h14v2z"></path></g></svg>`;

    this.zoomOutElem.appendChild(zoomOutIcon);

    // A zoom level input element is currently not included, as we do not have any mechanism to update it for all of the ways zoom can be changed.
    // Most notably, the zoom level can be changed by the user scrolling the mouse wheel over the canvas, which is handled by the viewer code rather than here.
    // this.zoomLevelElem = document.createElement('input');
    // this.zoomLevelElem.type = 'text';
    // this.zoomLevelElem.value = '100%';
    // this.zoomLevelElem.ariaLabel = 'Zoom level';

    this.zoomInElem = document.createElement('span');
    this.zoomInElem.className = 'cr-icon-button';
    this.zoomInElem.setAttribute('iron-icon', 'pdf:add');
    this.zoomInElem.title = 'Zoom in';
    this.zoomInElem.role = 'button';
    this.zoomInElem.tabIndex = 0;
    this.zoomInElem.ariaDisabled = 'false';

    const zoomInIcon = document.createElement('span');
    zoomInIcon.className = 'cr-icon';
    zoomInIcon.innerHTML = `<svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" focusable="false" role="none" style="pointer-events: none; display: block; width: 100%; height: 100%;">
    <g><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"></path></g></svg>`;

    this.zoomInElem.appendChild(zoomInIcon);

    zoomControls.appendChild(this.zoomOutElem);
    // zoomControls.appendChild(this.zoomLevelElem);
    zoomControls.appendChild(this.zoomInElem);

    // Vertical separator 2
    const verticalSeparator2 = document.createElement('span');
    verticalSeparator2.className = 'vertical-separator';

    // Highlight tool
    this.highlightMode = false;
    this.highlightColor = '#ffe93b';
    // Custom highlighter cursor (SVG data URI). Hotspot at center of icon (12, 12).
    this.highlightCursor = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' height='24' width='24' viewBox='0 -960 960 960'%3E%3Cpath fill='white' stroke='black' stroke-width='30' d='m268-212-56-56q-12-12-12-28.5t12-28.5l423-423q12-12 28.5-12t28.5 12l56 56q12 12 12 28.5T748-635L324-212q-11 11-28 11t-28-11Z'/%3E%3C/svg%3E") 12 12, auto`;

    this.highlightElem = document.createElement('span');
    this.highlightElem.className = 'cr-icon-button';
    this.highlightElem.title = 'Highlight';
    this.highlightElem.role = 'button';
    this.highlightElem.tabIndex = 0;

    const highlightIcon = document.createElement('span');
    highlightIcon.className = 'cr-icon';
    highlightIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" height="20" width="20" viewBox="0 -960 960 960" fill="currentColor">
    <path d="M280-320v-440q0-33 23.5-56.5T360-840q9 0 18 2t17 6l240 119q20 10 32.5 29.5T680-641v321H280Zm80-80h240v-241L360-760v360ZM160-120l22-65q8-25 29-40t47-15h444q26 0 47 15t29 40l22 65H160Zm200-280h240-240Z"/>
    </svg>`;

    this.highlightElem.appendChild(highlightIcon);

    this.highlightElem.addEventListener('mousedown', (e) => e.preventDefault());
    this.highlightElem.addEventListener('click', () => {
      this.highlightMode = !this.highlightMode;
      this.highlightElem.classList.toggle('active', this.highlightMode);
      this.updateHighlightCursorStyle();
    });

    // Color preset buttons
    const colorContainer = document.createElement('span');
    colorContainer.style.display = 'inline-flex';
    colorContainer.style.alignItems = 'center';
    colorContainer.style.gap = '4px';
    colorContainer.style.marginLeft = '4px';

    const colors = ['#ffe93b', '#4dd0e1', '#81c784', '#ffb74d'];
    this.colorBtnElems = [];
    for (const color of colors) {
      const btn = document.createElement('span');
      btn.className = 'highlight-color-btn';
      btn.style.backgroundColor = color;
      if (color === this.highlightColor) btn.classList.add('active');
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => {
        this.highlightColor = color;
        this.colorBtnElems.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');

        // If there is an active text selection, highlight it immediately with this color.
        const matchedWords = this.getSelectedOverlayWords();
        if (matchedWords.length > 0) {
          const n = ScribeViewer.state.cp.n;
          applyHighlight(matchedWords, n, this.highlightColor, 0.5);
          window.getSelection()?.removeAllRanges();
          ScribeViewer.deleteHTMLOverlay();
          ScribeViewer.renderHTMLOverlay();
        } else if (!this.highlightMode) {
          // No selection — activating a color also enables highlight mode
          this.highlightMode = true;
          this.highlightElem.classList.add('active');
          this.updateHighlightCursorStyle();
        }
      });
      this.colorBtnElems.push(btn);
      colorContainer.appendChild(btn);
    }

    // Append buttons to toolbarButtons
    toolbarButtons.appendChild(this.prevElem);
    toolbarButtons.appendChild(this.nextElem);
    toolbarButtons.appendChild(pageInputGroup);
    toolbarButtons.appendChild(verticalSeparator1);
    toolbarButtons.appendChild(zoomControls);
    toolbarButtons.appendChild(verticalSeparator2);
    toolbarButtons.appendChild(this.highlightElem);
    toolbarButtons.appendChild(colorContainer);

    center.appendChild(toolbarButtons);

    // Add start, center, and end to toolbar
    this.toolbarElem.appendChild(this.toolbarElemStart);
    this.toolbarElem.appendChild(center);
    this.toolbarElem.appendChild(this.toolbarElemEnd);

    // Viewer container
    this.viewerContainer = document.createElement('div');
    this.viewerContainer.style.position = 'relative';
    this.viewerContainer.style.overflow = 'hidden';

    const viewer = document.createElement('div');
    viewer.style.position = 'relative';
    viewer.style.overflow = 'hidden';

    this.viewerContainer.appendChild(viewer);

    // Append toolbar and viewer container to root
    this.pdfViewerElem.appendChild(this.toolbarElem);
    this.pdfViewerElem.appendChild(this.viewerContainer);

    this.dropZone = document.createElement('div');
    this.dropZone.className = 'upload_dropZone text-center p-4';
    this.dropZone.style.zIndex = '8';
    this.dropZone.style.top = `${toolbarHeight}px`;
    this.dropZone.style.position = 'absolute';
    this.dropZone.style.height = `${height - toolbarHeight}px`;
    this.dropZone.style.width = `${width - 6}px`;

    // Create the root div
    const uploadDiv = document.createElement('div');
    uploadDiv.style.position = 'relative';
    uploadDiv.style.top = '35%';
    uploadDiv.style.color = '#dddddd';

    // Create the paragraph element with instructions
    const instructions = document.createElement('p');
    instructions.className = 'small';
    instructions.innerHTML = 'Drag &amp; drop files inside dashed region<br><i>or</i>';

    // Create the hidden file input
    this.openFileInputElem = document.createElement('input');
    this.openFileInputElem.type = 'file';
    this.openFileInputElem.multiple = true;
    this.openFileInputElem.style.visibility = 'hidden';
    this.openFileInputElem.style.position = 'absolute';

    // Create the label for the file input
    const fileInputLabel = document.createElement('label');
    fileInputLabel.className = 'btn btn-info mb-3';
    // fileInputLabel.htmlFor = 'openFileInput';
    fileInputLabel.style.minWidth = '8rem';
    fileInputLabel.style.border = '1px solid';
    fileInputLabel.style.padding = '0.4rem';
    fileInputLabel.textContent = 'Select Files';
    fileInputLabel.appendChild(this.openFileInputElem);

    // Create the first upload gallery div
    const uploadGallery1 = document.createElement('div');
    uploadGallery1.className = 'upload_gallery d-flex flex-wrap justify-content-center gap-3 mb-0';
    uploadGallery1.style.display = 'inline!important';

    // Create the second upload gallery div
    const uploadGallery2 = document.createElement('div');
    uploadGallery2.className = 'upload_gallery d-flex flex-wrap justify-content-center gap-3 mb-0';

    // Append all elements to the root div
    uploadDiv.appendChild(instructions);
    // uploadDiv.appendChild(this.openFileInputElem);
    uploadDiv.appendChild(fileInputLabel);
    uploadDiv.appendChild(uploadGallery1);
    uploadDiv.appendChild(uploadGallery2);

    this.dropZone.appendChild(uploadDiv);
    this.pdfViewerElem.appendChild(this.dropZone);

    this.importFile = async (file, initialPage = 0) => {
      await scribe.importFiles([file]);

      // Initialize annotation pages array for each page
      for (let i = 0; i < scribe.inputData.pageCount; i++) {
        if (!scribe.data.annotations.pages[i]) scribe.data.annotations.pages[i] = [];
      }

      this.pageCountElem.textContent = scribe.inputData.pageCount.toString();
      this.pageNumElem.value = (initialPage + 1).toString();

      await ScribeViewer.displayPage(initialPage, initialPage > 0);

      // This should run after importFiles so if that function fails the dropzone is not removed
      pdfViewer.dropZone.style.display = 'none';
    };

    this.openFileInputElem.addEventListener('change', async () => {
      if (!this.openFileInputElem.files || this.openFileInputElem.files.length === 0) return;

      this.importFile(this.openFileInputElem.files[0]);
    });

    this.highlightActiveCt = 0;
    this.dropZone.addEventListener('dragover', (event) => {
      event.preventDefault();
      pdfViewer.dropZone.classList.add('highlight');
      this.highlightActiveCt++;
    });

    this.dropZone.addEventListener('dragleave', (event) => {
      event.preventDefault();
      // Only remove the highlight after 0.1 seconds, and only if it has not since been re-activated.
      // This avoids flickering.
      const highlightActiveCtNow = this.highlightActiveCt;
      setTimeout(() => {
        if (highlightActiveCtNow === this.highlightActiveCt) {
          pdfViewer.dropZone.classList.remove('highlight');
        }
      }, 100);
    });

    // Add various event listners to HTML elements
    this.nextElem.addEventListener('mousedown', (e) => e.preventDefault());
    this.nextElem.addEventListener('click', () => ScribeViewer.displayPage(ScribeViewer.state.cp.n + 1, true, false));
    this.prevElem.addEventListener('mousedown', (e) => e.preventDefault());
    this.prevElem.addEventListener('click', () => ScribeViewer.displayPage(ScribeViewer.state.cp.n - 1, true, false));

    this.pageNumElem.addEventListener('keyup', (event) => {
      if (event.keyCode === 13) {
        ScribeViewer.displayPage(parseInt(this.pageNumElem.value) - 1, true, false);
      }
    });

    this.zoomInElem.addEventListener('mousedown', (e) => e.preventDefault());
    this.zoomInElem.addEventListener('click', () => {
      ScribeViewer.zoom(1.1, ScribeViewer.getStageCenter());
      // this.zoomLevelElem.value = `${Math.round(ScribeCanvas.layerText.scaleX() * 100)}%`;
    });

    this.zoomOutElem.addEventListener('mousedown', (e) => e.preventDefault());
    this.zoomOutElem.addEventListener('click', () => {
      ScribeViewer.zoom(0.9, ScribeViewer.getStageCenter());
      // this.zoomLevelElem.value = `${Math.round(ScribeCanvas.layerText.scaleX() * 100)}%`;
    });

    this.openFileInputElem.addEventListener('change', () => {
      if (!pdfViewer.openFileInputElem.files || pdfViewer.openFileInputElem.files.length === 0) return;

      this.importFile(pdfViewer.openFileInputElem.files[0]);
    });

    // This is where the drop is handled.
    this.dropZone.addEventListener('drop', async (event) => {
      // Prevent navigation.
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
      const files = filesPromises.map((x) => x.value);

      if (files.length === 0) return;

      pdfViewer.dropZone.classList.remove('highlight');

      this.importFile(files[0]);
    });

    ScribeViewer.init(this.viewerContainer, width, height - toolbarHeight);

    document.addEventListener('mouseup', (event) => {
      if (!this.highlightMode) return;
      if (!(event.target instanceof Node) || !this.pdfViewerElem.contains(event.target)) return;

      const matchedWords = this.getSelectedOverlayWords();
      if (matchedWords.length === 0) return;

      const n = ScribeViewer.state.cp.n;
      applyHighlight(matchedWords, n, this.highlightColor, 0.5);

      window.getSelection()?.removeAllRanges();
      ScribeViewer.deleteHTMLOverlay();
      ScribeViewer.renderHTMLOverlay();
    });

    // Backup mouseup listener on the document to clear selection state 
    // if mouseup happens outside of the Konva stage (e.g. on an HTML overlay element).
    document.addEventListener('mouseup', () => {
      if (ScribeViewer.selecting) {
        ScribeViewer.selecting = false;
        ScribeViewer.selectingRectangle?.visible(false);
        ScribeViewer.layerText?.batchDraw();
      }
    });

    // Comment icon tooltip (shared, shown on icon hover)
    this.commentTooltip = document.createElement('div');
    this.commentTooltip.className = 'highlight-comment-tooltip';
    this.commentTooltip.style.display = 'none';
    ScribeViewer.elem.appendChild(this.commentTooltip);

    // Watch for overlay re-renders to update comment icons.
    // When .scribe-word elements are removed (scroll/zoom), hide icons immediately.
    // When .scribe-word elements are added (re-render), recreate icons after debounce.
    let commentIconTimer = null;
    const isWordOrLine = (n) => n instanceof HTMLElement
      && (n.classList.contains('scribe-word') || n.classList.contains('scribe-line'));
    const observer = new MutationObserver((mutations) => {
      const hasRemoved = mutations.some((m) => [...m.removedNodes].some(isWordOrLine));
      if (hasRemoved) {
        ScribeViewer.elem?.querySelectorAll('.highlight-comment-icon').forEach((el) => el.remove());
        this.commentTooltip.style.display = 'none';
      }
      const hasAdded = mutations.some((m) => [...m.addedNodes].some(isWordOrLine));
      if (!hasAdded) return;
      if (commentIconTimer) clearTimeout(commentIconTimer);
      commentIconTimer = setTimeout(() => this.updateCommentIcons(), 100);
    });
    observer.observe(ScribeViewer.elem, { childList: true });

    // Also update on page change
    const origCallback = ScribeViewer.displayPageCallback;
    ScribeViewer.displayPageCallback = () => {
      if (origCallback) origCallback();
      this.pageNumElem.value = (ScribeViewer.state.cp.n + 1).toString();
      setTimeout(() => this.updateCommentIcons(), 250);
    };

    container.appendChild(this.pdfViewerElem);
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

    const allKonvaWords = ScribeViewer.getKonvaWords();
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
    // Remove existing icons
    ScribeViewer.elem?.querySelectorAll('.highlight-comment-icon').forEach((el) => el.remove());

    const allWords = ScribeViewer.getKonvaWords();
    if (!allWords || allWords.length === 0) return;

    // Collect unique groups with non-empty comments
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

    // Append icons to the same container as .scribe-word elements (ScribeViewer.elem)
    // using the same coordinate system (absolute position matching overlay elements).
    const viewerElem = ScribeViewer.elem;

    for (const [, kw] of groupFirstWord) {
      const wordElem = viewerElem.querySelector(`.scribe-word[id="${kw.word.id}"]`);
      if (!wordElem) continue;

      // Use the overlay element's own position (same coordinate system as other overlays)
      const wordLeft = parseFloat(/** @type {HTMLElement} */ (wordElem).style.left) || 0;
      const wordTop = parseFloat(/** @type {HTMLElement} */ (wordElem).style.top) || 0;

      const icon = document.createElement('span');
      icon.className = 'highlight-comment-icon';
      icon.textContent = '\uD83D\uDCAC';
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

  /**
   * Adds the required CSS styles to the document.
   */
  static addIconButtonStyles = () => {
    if (ScribePDFViewer.styleAdded) return;
    ScribePDFViewer.styleAdded = true;
    const style = document.createElement('style');
    style.type = 'text/css';

    const css = `
    .cr-icon {
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

    .cr-icon-button {
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

    .cr-icon-button:hover {
      background: rgba(255, 255, 255, .08);
      border-radius: 50%;
    }

    .cr-icon-button.active {
      background: rgba(255, 255, 255, .2);
    }

    .highlight-color-btn {
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

    .highlight-color-btn:hover {
      border-color: rgba(255, 255, 255, .5);
    }

    .highlight-color-btn.active {
      border-color: #fff;
    }

    .highlight-comment-icon {
      position: absolute;
      font-size: 14px;
      cursor: default;
      z-index: 15;
      user-select: none;
      pointer-events: auto;
    }

    .highlight-comment-tooltip {
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

    .vertical-separator {
      background: rgba(255, 255, 255, .3);
      height: 15px;
      width: 1px;
      margin-left: 10px;
      margin-right: 10px;
      display: inline-block;
    }

    .upload_dropZone {
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

    .upload_dropZone.highlight {
      outline-offset: -4px;
      outline-color: #191b1d;
      background-color: rgb(106, 111, 114);
    }

    input {
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

const pdfViewerContElem = /** @type {HTMLDivElement} */(document.getElementById('pdfViewerCont'));

const pdfViewer = new ScribePDFViewer(pdfViewerContElem, window.innerWidth, window.innerHeight);

// Exposing important modules for debugging and testing purposes.
// These should not be relied upon in code--import/export should be used instead.
globalThis.df = {
  scribe,
  ScribeCanvas: ScribeViewer,
  applyHighlight,
  pdfViewer,
};

let currentFile = null;
async function handleLoadFile(file, page, readFileFn) {
  // Hide the upload prompt immediately when loading a file via MCP/desktop.
  pdfViewer.dropZone.style.display = 'none';

  if (currentFile === file) {
    await ScribeViewer.displayPage(page, true, false);
    return;
  }
  const { buffer, name } = await readFileFn(file);
  const fileObj = new File([buffer], name, { type: 'application/pdf' });
  await pdfViewer.importFile(fileObj, page || 0);
  currentFile = file;
}

async function handleHighlights(highlights) {
  for (const highlight of highlights) {
    const pageNum = highlight.page;
    const page = scribe.data.ocr.active[pageNum];
    if (!page) continue;

    const lines = highlight.lines;
    if (!lines || lines.length === 0) continue;

    // Only switch pages if not already on the correct page.
    // Always await to ensure words are fully rendered before querying.
    if (ScribeViewer.state.cp.n !== pageNum) {
      await ScribeViewer.displayPage(pageNum, true, false);
    }

    const allWords = ScribeViewer.getKonvaWords();
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
      applyHighlight(matchedWords, pageNum, highlight.color || '#ffff00', highlight.opacity || 0.4);
    }
  }
}

export { scribe, ScribeViewer, applyHighlight, pdfViewer, ScribePDFViewer, handleLoadFile, handleHighlights };
