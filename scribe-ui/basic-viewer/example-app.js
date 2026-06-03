// Standalone basic-viewer application bootstrap.
// Loaded directly by `index.html` and built on by `tauri-entry.js` and `electron-entry.js`.
// It auto-instantiates a full-screen `ScribePDFViewer` on the page's `#pdfViewerCont` element and wires up the file-loading
// and highlight helpers the desktop shells drive over IPC.
//
// This is NOT the file to import when embedding a viewer in your own page.
// Import `ScribePDFViewer` from `./pdf-viewer.js` and construct it yourself.
// That module is the reusable component and runs no bootstrap,
// instantiates nothing on load, and never writes to `globalThis`.
import {
  scribe, ScribeViewer, ScribePDFViewer, applyHighlight,
} from './pdf-viewer.js';

const pdfViewerContElem = /** @type {HTMLDivElement|null} */(document.getElementById('pdfViewerCont'));

const buildBootstrapViewer = () => {
  if (!pdfViewerContElem) return null;
  if (!pdfViewerContElem.style.width) pdfViewerContElem.style.width = '100vw';
  if (!pdfViewerContElem.style.height) pdfViewerContElem.style.height = '100vh';
  // This is a full-screen, single-viewer app, so it uses document-wide keyboard shortcuts that fire
  // regardless of where focus is on the page.
  const v = new ScribePDFViewer(pdfViewerContElem, { keyboardScope: 'global' });
  // Expose key modules on `globalThis.df` for debugging and tests. Not part of the public API.
  // Use the module imports/exports instead.
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
      applyHighlight(sv, matchedWords, pageNum, highlight.color || '#ffe93b', highlight.opacity || 0.4);
    }
  }
}

export {
  scribe, ScribeViewer, applyHighlight, pdfViewer, ScribePDFViewer, handleLoadFile, handleHighlights,
};
