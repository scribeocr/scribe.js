import { ScribeViewer, pdfViewer, handleHighlights, handleLoadFile } from './pdf-viewer.js';

// Set up frameless window drag regions
pdfViewer.toolbarElem.style.webkitAppRegion = 'drag';
pdfViewer.toolbarElemStart.style.webkitAppRegion = 'drag';
pdfViewer.toolbarElemEnd.style.webkitAppRegion = 'drag';

pdfViewer.toolbarElem.setAttribute('data-tauri-drag-region', '');
pdfViewer.toolbarElemStart.setAttribute('data-tauri-drag-region', '');
pdfViewer.toolbarElemEnd.setAttribute('data-tauri-drag-region', '');

const toolbarButtons = pdfViewer.toolbarElem.querySelector('.col-md');
if (toolbarButtons) toolbarButtons.style.webkitAppRegion = 'no-drag';

// Add close button
const closeBtn = document.createElement('button');
closeBtn.innerHTML = '&#x2715;';
closeBtn.title = 'Close';
closeBtn.style.cssText = 'background:none;border:none;color:#fff;font-size:20px;cursor:pointer;padding:8px 16px;-webkit-app-region:no-drag;';
closeBtn.addEventListener('mouseenter', () => { closeBtn.style.background = '#e81123'; });
closeBtn.addEventListener('mouseleave', () => { closeBtn.style.background = 'none'; });
closeBtn.addEventListener('click', () => window.__TAURI__.window.getCurrentWindow().close());
pdfViewer.toolbarElemEnd.appendChild(closeBtn);

const { listen } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;

const readFileTauri = async (filePath) => {
  const bytes = await invoke('read_file', { path: filePath });
  const name = filePath.split(/[\\/]/).pop();
  return { buffer: new Uint8Array(bytes), name };
};

// Use a queue to ensure events are processed sequentially and fully awaited.
let eventQueue = Promise.resolve();
const enqueue = (fn) => { eventQueue = eventQueue.then(fn); };

listen('load-file', (event) => enqueue(() => handleLoadFile(event.payload.file, event.payload.page, readFileTauri)));
listen('viewer-navigate', (event) => enqueue(() => ScribeViewer.displayPage(event.payload.page, true, false)));
listen('viewer-highlight', (event) => enqueue(() => handleHighlights(event.payload.highlights)));

// Pull initial args (the Rust backend stores them so we avoid race conditions).
const initial = await invoke('get_initial_args');
if (initial.event === 'load-file') {
  await handleLoadFile(initial.data.file, initial.data.page, readFileTauri);
} else if (initial.event === 'viewer-navigate') {
  await ScribeViewer.displayPage(initial.data.page, true, false);
} else if (initial.event === 'viewer-highlight') {
  await handleHighlights(initial.data.highlights);
}
