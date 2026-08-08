import {
  ScribeViewer, pdfViewer, handleHighlights, handleLoadFile,
} from '../example-app.js';
import { scribe } from '../pdf-viewer.js';

// The shell serves COOP/COEP headers, so PDF bytes can be shared across workers instead of cloned per worker.
scribe.opt.usePdfSharedBuffer = true;

// Controls move in and out of the start and end zones at runtime, so the exemption covers whatever is in a zone rather than a fixed list of the controls present today.
// It reaches every descendant because the mode drop-down and its rows sit inside wrapper spans that a children-only selector would not pass through.
pdfViewer.toolbarElem.style.webkitAppRegion = 'drag';
pdfViewer.toolbarElemStart.classList.add('scribe-shell-drag-zone');
pdfViewer.toolbarElemEnd.classList.add('scribe-shell-drag-zone');
const dragOptOut = document.createElement('style');
dragOptOut.textContent = '.scribe-shell-drag-zone > *, .scribe-shell-drag-zone > * *, .col-md, .col-md *, '
  + '.scribe-search-group, .scribe-search-group * { -webkit-app-region: no-drag; }';
document.head.appendChild(dragOptOut);

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
  closeBtn.addEventListener('click', () => window.close());
  pdfViewer.toolbarElemEnd.appendChild(closeBtn);
}

const readFileElectron = async (filePath) => {
  const { buffer, name } = await window.electronAPI.readFile(filePath);
  return { buffer, name };
};

// Use a queue to ensure events are processed sequentially and fully awaited.
let eventQueue = Promise.resolve();
const enqueue = (fn) => { eventQueue = eventQueue.then(fn); };

window.electronAPI.onLoadFile(({ file, page }) => enqueue(() => handleLoadFile(file, page, readFileElectron)));
window.electronAPI.onNavigate(({ page }) => enqueue(() => ScribeViewer.displayPage(page, true, false)));
window.electronAPI.onHighlight(({ highlights }) => enqueue(() => handleHighlights(highlights)));

if (isMac) {
  // Native menu items route back through the same command handlers the in-window menu uses, and their enabled/checked state follows the app.
  window.electronAPI.onMenuAction((id) => enqueue(() => pdfViewer.runMenuCommand(id)));
  const pushMenuState = () => window.electronAPI.sendMenuState(pdfViewer.getMenuState());
  document.addEventListener('scribe-menu-state-change', pushMenuState);
  pushMenuState();
}
