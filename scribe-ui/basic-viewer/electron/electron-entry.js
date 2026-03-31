import { ScribeViewer, pdfViewer, handleHighlights, handleLoadFile } from '../pdf-viewer.js';

// Set up frameless window drag regions
pdfViewer.toolbarElem.style.webkitAppRegion = 'drag';
pdfViewer.toolbarElemStart.style.webkitAppRegion = 'drag';
pdfViewer.toolbarElemEnd.style.webkitAppRegion = 'drag';

const toolbarButtons = pdfViewer.toolbarElem.querySelector('.col-md');
if (toolbarButtons) toolbarButtons.style.webkitAppRegion = 'no-drag';

// Add close button
const closeBtn = document.createElement('button');
closeBtn.innerHTML = '&#x2715;';
closeBtn.title = 'Close';
closeBtn.style.cssText = 'background:none;border:none;color:#fff;font-size:20px;cursor:pointer;padding:8px 16px;-webkit-app-region:no-drag;';
closeBtn.addEventListener('mouseenter', () => { closeBtn.style.background = '#e81123'; });
closeBtn.addEventListener('mouseleave', () => { closeBtn.style.background = 'none'; });
closeBtn.addEventListener('click', () => window.close());
pdfViewer.toolbarElemEnd.appendChild(closeBtn);

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
