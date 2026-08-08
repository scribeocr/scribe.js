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

const { platform } = window.electronAPI;

if (platform === 'darwin') {
  // The macOS window is decorated with the native traffic lights overlaying the toolbar, so inset the leading cluster clear of them.
  pdfViewer.toolbarElemStart.style.paddingLeft = '96px';
  // The system menu bar carries the app commands there, so the in-window menu button retires.
  pdfViewer.setMenuButtonVisible(false);
} else if (platform === 'win32') {
  // Windows draws the native caption buttons over the bar (Window Controls Overlay), so the end zone stays clear of them.
  // The env() fallback keeps the bar's stock 8px inset anywhere the overlay is off.
  pdfViewer.toolbarElemEnd.style.paddingRight = 'calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, calc(100vw - 8px)))';
} else {
  // Frameless on Linux, so the shell supplies GNOME-style rounded corners and circular caption buttons itself.
  // The window is transparent, and this wrapper radius is what actually shapes it.
  const capStyle = document.createElement('style');
  capStyle.textContent = 'html, body { background: transparent; }'
    + ' #pdfViewerCont { border-radius: 12px; overflow: hidden; box-sizing: border-box; border: 1px solid rgba(0, 0, 0, .18); background: #f4f6fa; }'
    + ' body.shell-dark #pdfViewerCont { border-color: rgba(255, 255, 255, .14); background: #12151b; }'
    + ' body.shell-square #pdfViewerCont { border-radius: 0; border-color: transparent; }'
    + ' .scribe-shell-corner { display: inline-flex; align-items: center; align-self: center; gap: 6px; margin-left: 8px; padding-right: 8px; }'
    + ' .scribe-shell-capbtn { width: 24px; height: 24px; border-radius: 50%; border: none; padding: 0; cursor: default;'
    + ' color: var(--scribe-ink); background: color-mix(in srgb, var(--scribe-ink) 8%, transparent);'
    + ' display: inline-flex; align-items: center; justify-content: center; -webkit-app-region: no-drag; }'
    + ' .scribe-shell-capbtn:hover { background: color-mix(in srgb, var(--scribe-ink) 14%, transparent); }'
    + ' .scribe-shell-capbtn:active { background: color-mix(in srgb, var(--scribe-ink) 20%, transparent); }'
    + ' .scribe-shell-capbtn:focus-visible { outline: 2px solid var(--scribe-accent-ring); outline-offset: 1px; }';
  document.head.appendChild(capStyle);
  const glyph = (paths) => '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"'
    + ` stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const maximizeGlyph = glyph('<rect x="5.5" y="5.5" width="13" height="13" rx="2"/>');
  const restoreGlyph = glyph('<rect x="5" y="8" width="11" height="11" rx="2"/><path d="M8.5 8v-.5A2.5 2.5 0 0 1 11 5h5.5A2.5 2.5 0 0 1 19 7.5V13a2.5 2.5 0 0 1-2.5 2.5H16"/>');
  const corner = document.createElement('span');
  corner.className = 'scribe-shell-corner';
  const capBtn = (title, svg, onClick) => {
    const btn = document.createElement('button');
    btn.className = 'scribe-shell-capbtn';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.innerHTML = svg;
    btn.addEventListener('click', onClick);
    corner.appendChild(btn);
    return btn;
  };
  capBtn('Minimize', glyph('<path d="M5 12h14"/>'), () => window.electronAPI.minimize());
  const maxBtn = capBtn('Maximize', maximizeGlyph, () => window.electronAPI.toggleMaximize());
  capBtn('Close', glyph('<path d="M6 6l12 12M18 6L6 18"/>'), () => window.close());
  // GNOME squares maximized and fullscreen windows, so the radius follows the window state.
  let winMaximized = false;
  let winFullScreen = false;
  const syncSquare = () => document.body.classList.toggle('shell-square', winMaximized || winFullScreen);
  window.electronAPI.onMaximizedChange((on) => {
    winMaximized = on;
    syncSquare();
    maxBtn.innerHTML = on ? restoreGlyph : maximizeGlyph;
    maxBtn.title = on ? 'Restore' : 'Maximize';
    maxBtn.setAttribute('aria-label', maxBtn.title);
  });
  window.electronAPI.onFullScreenChange((on) => {
    winFullScreen = on;
    syncSquare();
  });
  // The wrapper sits outside the viewer's theme tokens, so the effective theme is mirrored onto the body by hand.
  const syncShellDark = () => document.body.classList.toggle('shell-dark', pdfViewer.getMenuState().darkChecked);
  document.addEventListener('scribe-menu-state-change', syncShellDark);
  syncShellDark();
  pdfViewer.toolbarElemEnd.appendChild(corner);
}

if (platform !== 'darwin') {
  // No application menu exists on these platforms, so the window shortcuts live here.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F11') {
      e.preventDefault();
      window.electronAPI.toggleFullScreen();
      return;
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.key === 'w' || e.key === 'W')) {
      e.preventDefault();
      if (!pdfViewer.closeActiveDocument()) window.close();
    }
  });
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

if (platform === 'darwin') {
  window.electronAPI.onMenuAction((id) => enqueue(() => pdfViewer.runMenuCommand(id)));
}

// Pushed on every platform, not just the one with native menus, because Windows tints its caption-button overlay from this state.
const pushMenuState = () => window.electronAPI.sendMenuState(pdfViewer.getMenuState());
document.addEventListener('scribe-menu-state-change', pushMenuState);
pushMenuState();

// The shell owns the recent-files list, since the web build cannot reopen paths.
// Reopening routes through the main process so the list re-orders and the OS recents stay in step.
window.electronAPI.onRecentFiles((files) => pdfViewer.setRecentFiles(
  files.map((f) => ({ label: f.label, open: () => window.electronAPI.openRecent(f.path) })),
  () => window.electronAPI.clearRecent(),
));
