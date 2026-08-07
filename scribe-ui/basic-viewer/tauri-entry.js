import {
  ScribeViewer, pdfViewer, handleHighlights, handleLoadFile,
} from './example-app.js';

// Set up frameless window drag regions
pdfViewer.toolbarElem.style.webkitAppRegion = 'drag';
pdfViewer.toolbarElemStart.style.webkitAppRegion = 'drag';
pdfViewer.toolbarElemEnd.style.webkitAppRegion = 'drag';

pdfViewer.toolbarElem.setAttribute('data-tauri-drag-region', '');
pdfViewer.toolbarElemStart.setAttribute('data-tauri-drag-region', '');
pdfViewer.toolbarElemEnd.setAttribute('data-tauri-drag-region', '');

const toolbarButtons = pdfViewer.toolbarElem.querySelector('.col-md');
if (toolbarButtons) toolbarButtons.style.webkitAppRegion = 'no-drag';

const isMac = navigator.platform.startsWith('Mac');
if (isMac) {
  // The macOS window is decorated with the native traffic lights overlaying the toolbar, so inset the leading cluster clear of them.
  pdfViewer.toolbarElemStart.style.paddingLeft = '96px';
  // On macOS the system menu bar carries the app commands and one toggle opens the sidebar, matching how Mac viewers lay out this corner.
  pdfViewer.setUnifiedSidebar(true);
  pdfViewer.setMenuButtonVisible(false);
  pdfViewer.setModeTrack(true);
} else {
  // Frameless on Windows and Linux, so the shell supplies the close button.
  const closeBtn = document.createElement('button');
  closeBtn.innerHTML = '&#x2715;';
  closeBtn.title = 'Close';
  // The glyph inherits the toolbar ink so it stays legible in both themes, and flips to white only over the red hover fill.
  closeBtn.style.cssText = 'background:none;border:none;color:inherit;font-size:20px;cursor:pointer;padding:8px 16px;-webkit-app-region:no-drag;';
  closeBtn.addEventListener('mouseenter', () => { closeBtn.style.background = '#e81123'; closeBtn.style.color = '#fff'; });
  closeBtn.addEventListener('mouseleave', () => { closeBtn.style.background = 'none'; closeBtn.style.color = 'inherit'; });
  closeBtn.addEventListener('click', () => window.__TAURI__.window.getCurrentWindow().close());
  pdfViewer.toolbarElemEnd.appendChild(closeBtn);
}

const { listen } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;

// Tauri does not mirror `document.title` onto the native window, so the app layer's title has to be pushed across by hand.
// The window is frameless, so the title surfaces in the taskbar and window switcher rather than on a title bar.
const titleElem = document.querySelector('title');
if (titleElem) {
  new MutationObserver(() => window.__TAURI__.window.getCurrentWindow().setTitle(document.title))
    .observe(titleElem, { childList: true });
}

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

if (isMac) {
  // Native menu items route back through the same command handlers the in-window menu uses, and their enabled/checked state follows the app.
  listen('menu-action', (event) => enqueue(() => pdfViewer.runMenuCommand(event.payload)));
  const pushMenuState = () => { invoke('sync_menu', { state: pdfViewer.getMenuState() }).catch(() => {}); };
  document.addEventListener('scribe-menu-state-change', pushMenuState);
  pushMenuState();
}

// Pull initial args (the Rust backend stores them so we avoid race conditions).
const initial = await invoke('get_initial_args');
if (initial.event === 'load-file') {
  await handleLoadFile(initial.data.file, initial.data.page, readFileTauri);
} else if (initial.event === 'viewer-navigate') {
  await ScribeViewer.displayPage(initial.data.page, true, false);
} else if (initial.event === 'viewer-highlight') {
  await handleHighlights(initial.data.highlights);
}
