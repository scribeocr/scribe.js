const {
  app, BrowserWindow, ipcMain, powerMonitor, nativeTheme, Menu, shell, protocol, net, screen, session,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// Module workers must be same-origin under COEP, and file:// origins are opaque, so every worker dies at spawn.
// Serving the bundle over a registered scheme gives the app a real origin, which is what makes crossOriginIsolated PDF sharing possible.
const APP_SCHEME = 'app';
// Both dev (repo checkout) and the packaged staging tree keep main.js at scribe-ui/basic-viewer/electron/, three levels below the bundle root.
const APP_ROOT = path.join(__dirname, '..', '..', '..');
protocol.registerSchemesAsPrivileged([{
  scheme: APP_SCHEME,
  privileges: {
    standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true,
  },
}]);

/** @typedef {import('../pdf-viewer.js').MenuState} MenuState */
/**
 * One open window and what the shell tracks about it.
 * @typedef {{win: import('electron').BrowserWindow, shuttingDown: boolean, rendererReady: boolean,
 *   menuState: ?MenuState, folderName: ?string, finish: ?(() => void)}} WindowState
 */
/** @type {Map<number, WindowState>} */
const windows = new Map();
/** @type {?number} */
let lastFocusedId = null;
let quitting = false;
/**
 * Whether a window is wanted once the ones tearing down have closed.
 * Opening it sooner would race the closing window's teardown, which still holds its folder's lock and has yet to write the resume record.
 * @type {boolean}
 */
let reopenPending = false;
/** @type {?string} */
let pendingMenuAction = null;
// The launch arguments reach the first window only, so a window reopened later does not reload the launch file.
let launchArgs = parseArgs(process.argv);
// macOS delivers file opens (double-click, "Open With", drag onto the Dock icon) as events rather than argv, and they can arrive before a renderer has its listeners.
/** @type {?string} */
let pendingOpenFile = null;

const liveWindows = () => [...windows.values()].filter((s) => !s.shuttingDown);
/**
 * The window a command or file goes to.
 * @returns {?WindowState}
 */
function targetWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  const byFocus = focused ? windows.get(focused.id) : null;
  if (byFocus && !byFocus.shuttingDown) return byFocus;
  const last = lastFocusedId !== null ? windows.get(lastFocusedId) : null;
  if (last && !last.shuttingDown) return last;
  return liveWindows()[0] ?? null;
}
/** @param {import('electron').WebContents} webContents */
const stateOf = (webContents) => {
  const win = BrowserWindow.fromWebContents(webContents);
  return win ? windows.get(win.id) ?? null : null;
};
/** @typedef {{'recent-files': Array<{label: string, dir: string}>, 'power-changed': {onBattery: boolean}}} BroadcastPayloads */
/**
 * @template {keyof BroadcastPayloads} K
 * @param {K} channel
 * @param {BroadcastPayloads[K]} payload
 */
const broadcast = (channel, payload) => {
  for (const s of windows.values()) if (!s.win.isDestroyed()) s.win.webContents.send(channel, payload);
};
function pushFoldersOpenElsewhere() {
  const open = [...windows.values()].filter((s) => !s.win.isDestroyed());
  for (const s of open) s.win.webContents.send('folders-open-elsewhere', open.filter((o) => o !== s && o.folderName).map((o) => o.folderName));
}

// The Linux window is transparent so the renderer can round its corners the way GNOME rounds every window.
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-transparent-visuals');

// The bounds and maximize flag of the window last moved, resized or closed, and the recent-files list, survive relaunches here.
const shellStatePath = path.join(app.getPath('userData'), 'shell-state.json');
let shellState = {
  bounds: null,
  isMaximized: false,
  recentFiles: [],
  recentFolders: [],
};
try {
  shellState = { ...shellState, ...JSON.parse(fs.readFileSync(shellStatePath, 'utf8')) };
} catch { /* First run, or an unreadable state file: start from the defaults. */ }
function saveShellState() {
  try { fs.writeFileSync(shellStatePath, JSON.stringify(shellState)); } catch { /* A failed save only loses state memory. */ }
}

// The values of the app's --scribe-surface/--scribe-ink tokens, so the Windows caption buttons sit on the bar seamlessly.
// Electron takes literals here, so a token change must be mirrored.
const overlayColors = (dark) => (dark
  ? { color: '#1c2028', symbolColor: '#e8ebf2' }
  : { color: '#ffffff', symbolColor: '#1f2530' });

/** @param {NodeJS.ErrnoException} err */
const isGone = (err) => err.code === 'ENOENT' || err.code === 'ENOTDIR';
/** @param {string} file */
const fileKey = (file) => (process.platform === 'win32' ? file.toLowerCase() : file);

// macOS's Open Recent and the Windows jump list take additions only, so a removal rebuilds them from the kept list.
/** @param {string[]} files */
function setRecentFiles(files) {
  shellState.recentFiles = files;
  saveShellState();
  app.clearRecentDocuments();
  for (const f of [...files].reverse()) app.addRecentDocument(f);
}

async function pushRecentFiles() {
  const present = [];
  for (const f of shellState.recentFiles) {
    try {
      await fs.promises.access(f);
      present.push(f);
    } catch (err) {
      if (!isGone(err)) present.push(f);
    }
  }
  if (present.length !== shellState.recentFiles.length) setRecentFiles(present);
  const home = app.getPath('home');
  broadcast('recent-files', present.map((f) => {
    const dir = path.dirname(f);
    return { label: path.basename(f), dir: dir === home || dir.startsWith(home + path.sep) ? `~${dir.slice(home.length)}` : dir };
  }));
}

// Feeds the macOS Open Recent menu, the Windows jump list, and the in-window menu's Open recent submenu.
function recordRecentFile(file) {
  shellState.recentFiles = [file, ...shellState.recentFiles.filter((f) => fileKey(f) !== fileKey(file))].slice(0, 10);
  saveShellState();
  app.addRecentDocument(file);
  pushRecentFiles();
}

/**
 * Parse --key=value arguments from an argv array.
 * A bare positional .pdf/.scribe path is a file to open (what a double-clicked file association passes on Windows and Linux).
 * @param {string[]} argv
 * @returns {Object<string, string>}
 */
function parseArgs(argv) {
  const args = {};
  for (const arg of argv.slice(1)) {
    const match = arg.match(/^--(\w+)=(.+)$/);
    if (match) args[match[1]] = match[2];
    else if (!args.file && /\.(pdf|scribe)$/i.test(arg) && fs.existsSync(arg)) args.file = arg;
  }
  return args;
}

/**
 * @param {object} [options]
 * @param {boolean} [options.fresh] - Start empty instead of resuming the last folder and tabs.
 */
function createWindow({ fresh = false } = {}) {
  reopenPending = false;
  // A remembered position must still be mostly on some connected display, or the window comes back stranded off-screen.
  let restoredBounds = shellState.bounds;
  if (restoredBounds) {
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return restoredBounds.x < a.x + a.width - 40 && restoredBounds.x + restoredBounds.width > a.x + 40
        && restoredBounds.y >= a.y - 20 && restoredBounds.y < a.y + a.height - 40;
    });
    if (!visible) restoredBounds = null;
  }
  const front = targetWindow()?.win;
  const cascade = front && !front.isDestroyed() ? front.getNormalBounds() : null;
  const bounds = cascade ? {
    x: cascade.x + 28, y: cascade.y + 28, width: cascade.width, height: cascade.height,
  } : restoredBounds;
  const { workArea } = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    width: bounds ? bounds.width : 900,
    // The portrait default must still fit a 1080p work area on first run.
    height: bounds ? bounds.height : Math.min(1100, workArea.height - 40),
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 620,
    minHeight: 440,
    // macOS: decorated window with the native traffic lights overlaying the toolbar.
    // Windows: hidden title bar with the native caption buttons, which is what keeps the Snap Layouts flyout.
    // Linux: frameless, with the caption trio the renderer supplies.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' }
      : process.platform === 'win32' ? {
        titleBarStyle: 'hidden',
        titleBarOverlay: { height: 40, ...overlayColors(nativeTheme.shouldUseDarkColors) },
      } : {
        frame: false,
        transparent: true,
        // The renderer draws the corners, since native rounding does not reach every desktop.
        // Leaving it on would clip those corners where it does engage.
        roundedCorners: false,
      }),
    title: '21 Viewer',
    // Match the app's canvas token so the first paint does not flash a mismatched color.
    // Linux stays fully transparent, since any opaque fill would square off the renderer's rounded corners.
    backgroundColor: process.platform === 'linux' ? '#00000000'
      : nativeTheme.shouldUseDarkColors ? '#12151b' : '#f4f6fa',
    // Windows and Linux take the window icon from here.
    // macOS ignores it and uses the icon from the app bundle instead.
    icon: path.join(__dirname, '../icons/icon-512.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      // The renderer parses untrusted documents, so the OS sandbox stays on.
      // The preload only uses ipcRenderer and contextBridge, which sandboxed preloads keep.
      sandbox: true,
      // Lets the preload tell the renderer whether it runs from a packaged app, which carries its own OCR language data.
      additionalArguments: [
        ...(app.isPackaged ? ['--scribe-packaged'] : []),
        ...(pendingOpenFile || launchArgs.file ? ['--scribe-launch-file'] : []),
        ...(fresh ? ['--scribe-fresh-window'] : []),
      ],
    },
  });
  /** @type {WindowState} */
  const state = {
    win, shuttingDown: false, rendererReady: false, menuState: null, folderName: null, finish: null,
  };
  windows.set(win.id, state);
  if (shellState.isMaximized && !cascade) win.maximize();
  win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });

  let saveTimer = null;
  const noteBounds = () => {
    if (win.isDestroyed()) return;
    shellState.bounds = win.getNormalBounds();
    shellState.isMaximized = win.isMaximized();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveShellState, 500);
  };
  win.on('resize', noteBounds);
  win.on('move', noteBounds);
  // The Linux caption trio swaps its maximize glyph for a restore glyph while maximized, and the rounded corners square off.
  win.on('maximize', () => { noteBounds(); win.webContents.send('window-maximized', true); });
  win.on('unmaximize', () => { noteBounds(); win.webContents.send('window-maximized', false); });
  win.on('enter-full-screen', () => win.webContents.send('window-fullscreen', true));
  win.on('leave-full-screen', () => win.webContents.send('window-fullscreen', false));
  win.on('close', (event) => {
    clearTimeout(saveTimer);
    shellState.bounds = win.getNormalBounds();
    shellState.isMaximized = win.isMaximized();
    saveShellState();
    // A quit re-closes the window while teardown is already under way.
    // Restarting the pass would re-send the IPC and re-arm the failsafe, so let the scheduled destroy finish the job.
    if (state.shuttingDown) {
      event.preventDefault();
      return;
    }
    // The renderer flushes dirty library sidecars while their documents are still alive, then winds down its worker pools.
    // Hiding first keeps the close feeling instant.
    // The failsafe destroys the window regardless, so a stuck renderer cannot turn the close into a hang.
    state.shuttingDown = true;
    event.preventDefault();
    win.hide();
    // A relaunch resumes a single window, the last one standing or, at a quit, the one focused last.
    const resume = quitting ? win.id === lastFocusedId : liveWindows().length === 0;
    win.webContents.send('app-teardown', { resume });
    let failsafe = null;
    state.finish = () => {
      if (failsafe) clearTimeout(failsafe);
      state.finish = null;
      if (!win.isDestroyed()) win.destroy();
    };
    failsafe = setTimeout(state.finish, 3000);
  });

  // A remote page navigated into this window would inherit the preload bridge.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(`${APP_SCHEME}://`)) return;
    event.preventDefault();
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });

  // Native cut/copy/paste menu in editable fields, which Electron does not provide on its own.
  // Scoped to editables: the app draws its own menus elsewhere (bookmarks, comments, layout boxes).
  win.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable) return;
    Menu.buildFromTemplate([
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
      { type: 'separator' }, { role: 'selectAll' },
    ]).popup();
  });

  win.loadURL(`${APP_SCHEME}://bundle/scribe-ui/basic-viewer/electron/electron.html`);

  win.webContents.on('did-finish-load', () => {
    state.rendererReady = true;
    pushRecentFiles();
    // A focus change that arrived before the renderer listened was lost, so the window's role is restated here.
    win.webContents.send('window-focused', win.isFocused());
    pushFoldersOpenElsewhere();
    if (pendingOpenFile) {
      sendArgsToRenderer({ file: pendingOpenFile }, state);
      pendingOpenFile = null;
    } else {
      sendArgsToRenderer(launchArgs, state);
    }
    launchArgs = {};
    if (pendingMenuAction) {
      win.webContents.send('menu-action', pendingMenuAction);
      pendingMenuAction = null;
    }
  });

  win.on('closed', () => {
    windows.delete(win.id);
    pushFoldersOpenElsewhere();
    if (quitting || process.platform !== 'darwin' || windows.size) return;
    // No renderer is left to push menu state, so the menu resets here.
    setAppMenu('Close Folder', false);
    if (reopenPending || pendingOpenFile || pendingMenuAction) createWindow();
  });
}

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  const target = targetWindow();
  if (target?.rendererReady) {
    sendArgsToRenderer({ file: filePath }, target);
    return;
  }
  pendingOpenFile = filePath;
  // Before the app is ready, the first window delivers the held file.
  if (app.isReady() && !windows.size && !quitting) createWindow();
  else if (windows.size && !liveWindows().length) reopenPending = true;
});

/**
 * @param {{file?: string, page?: string, action?: string, highlights?: string}} args
 * @param {?WindowState} [target]
 */
function sendArgsToRenderer(args, target = targetWindow()) {
  if (!target) return;
  const { win } = target;

  const action = args.action || 'load';

  if (action === 'navigate') {
    win.webContents.send('viewer-navigate', {
      page: parseInt(args.page || '0', 10),
    });
    return;
  }

  if (action === 'highlight') {
    let highlights = [];
    try {
      highlights = JSON.parse(args.highlights || '[]');
    } catch (e) {
      // ignore parse errors
    }
    win.webContents.send('viewer-highlight', { highlights });
    return;
  }

  // Default: load file
  if (!args.file) return;
  const file = path.resolve(args.file);
  // Main reads the bytes itself, so no IPC channel accepts a filesystem path from the renderer.
  // The path still rides along because the renderer uses it as the identity key for same-file navigation.
  fs.promises.readFile(file).then((bytes) => {
    if (win.isDestroyed()) return;
    recordRecentFile(file);
    win.webContents.send('load-file', {
      file,
      name: path.basename(file),
      bytes,
      page: parseInt(args.page || '0', 10),
    });
  }).catch((err) => {
    if (!isGone(err)) {
      console.error(`Could not read ${file}: ${err.message}`);
      return;
    }
    const kept = shellState.recentFiles.filter((f) => fileKey(f) !== fileKey(file));
    const listed = kept.length !== shellState.recentFiles.length;
    if (listed) {
      setRecentFiles(kept);
      pushRecentFiles();
    }
    if (!win.isDestroyed()) win.webContents.send('file-missing', { name: path.basename(file), listed });
  });
}

let closeFolderLabel = 'Close Folder';
let closeTabShown = false;
/**
 * Build the macOS application menu.
 * @param {string} closeLabel - The Close Folder item's label.
 * @param {boolean} closeTab - Whether ⌘W closes a tab rather than the window, as in tabbed macOS windows.
 */
function buildAppMenu(closeLabel, closeTab) {
  const send = (id) => () => {
    const target = targetWindow();
    if (target) {
      target.win.webContents.send('menu-action', id);
      return;
    }
    if (id !== 'open') return;
    pendingMenuAction = id;
    if (windows.size) reopenPending = true;
    else createWindow();
  };
  return Menu.buildFromTemplate([
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        { id: 'new-window', label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createWindow({ fresh: true }) },
        { id: 'open', label: 'Open…', accelerator: 'CmdOrCtrl+O', click: send('open') },
        { label: 'Open Recent', role: 'recentDocuments', submenu: [{ label: 'Clear Menu', role: 'clearRecentDocuments' }] },
        { id: 'open-folder', label: 'Open Folder…', enabled: false, click: send('open-folder') },
        { id: 'close-folder', label: closeLabel, enabled: false, click: send('close-folder') },
        { id: 'rebuild-index', label: 'Rebuild Search Index', enabled: false, click: send('rebuild-index') },
        { type: 'separator' },
        ...(closeTab ? [
          { id: 'close-tab', label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: send('close-tab') },
          { role: 'close', label: 'Close Window', accelerator: 'Shift+CmdOrCtrl+W' },
        ] : [{ role: 'close', label: 'Close Window', accelerator: 'CmdOrCtrl+W' }]),
        { type: 'separator' },
        { id: 'export-pdf', label: 'Export as PDF…', enabled: false, click: send('export-pdf') },
        { id: 'combine', label: 'Combine Open Documents…', enabled: false, click: send('combine') },
        { id: 'split', label: 'Split at Bookmarks', enabled: false, click: send('split') },
        { type: 'separator' },
        { id: 'print', label: 'Print…', accelerator: 'CmdOrCtrl+P', enabled: false, click: send('print') },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        // The undo and redo roles act only on text fields, which would leave the document's history unreachable from the menu.
        { id: 'undo', label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: send('undo') },
        { id: 'redo', label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: send('redo') },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        { id: 'find', label: 'Find…', accelerator: 'CmdOrCtrl+F', click: send('find') },
        { id: 'find-next', label: 'Find Next', accelerator: 'CmdOrCtrl+G', enabled: false, click: send('find-next') },
        { id: 'find-prev', label: 'Find Previous', accelerator: 'Shift+CmdOrCtrl+G', enabled: false, click: send('find-prev') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { id: 'rotate-left', label: 'Rotate Left', accelerator: 'Shift+CmdOrCtrl+L', enabled: false, click: send('rotate-left') },
        { id: 'rotate-right', label: 'Rotate Right', accelerator: 'Shift+CmdOrCtrl+R', enabled: false, click: send('rotate-right') },
        { type: 'separator' },
        { id: 'cover-alone', label: 'Separate Cover Page', type: 'checkbox', enabled: false, click: send('cover-alone') },
        { id: 'highlight-fields', label: 'Highlight Fields', type: 'checkbox', enabled: false, click: send('highlight-fields') },
        { id: 'dark-mode', label: 'Dark Mode', type: 'checkbox', click: send('dark-mode') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [{ label: '21 Viewer Website', click: () => shell.openExternal('https://viewer.21.ai') }],
    },
  ]);
}

/** The menu this shell last installed. */
let appMenu = null;
/**
 * Install the macOS application menu.
 * @param {string} closeLabel
 * @param {boolean} closeTab
 */
function setAppMenu(closeLabel, closeTab) {
  // Electron installs a default menu of its own at ready, so only the menu this shell built counts as installed.
  // Labels are not dynamic in Electron, so a label change rebuilds the menu.
  if (appMenu && Menu.getApplicationMenu() === appMenu && closeLabel === closeFolderLabel && closeTab === closeTabShown) return;
  closeFolderLabel = closeLabel;
  closeTabShown = closeTab;
  appMenu = buildAppMenu(closeLabel, closeTab);
  Menu.setApplicationMenu(appMenu);
}

/** @param {MenuState} state */
function applyMenuState(state) {
  if (process.platform === 'darwin') {
    setAppMenu(
      typeof state.closeFolderLabel === 'string' ? state.closeFolderLabel : closeFolderLabel,
      typeof state.closeTab === 'boolean' ? state.closeTab : closeTabShown,
    );
  }
  const menu = Menu.getApplicationMenu();
  if (!menu) return;
  const set = (id, props) => {
    const item = menu.getMenuItemById(id);
    if (item) Object.assign(item, props);
  };
  set('print', { enabled: state.docOpen });
  set('find-next', { enabled: state.docOpen });
  set('find-prev', { enabled: state.docOpen });
  set('export-pdf', { enabled: state.docOpen });
  set('rotate-left', { enabled: state.docOpen });
  set('rotate-right', { enabled: state.docOpen });
  set('combine', { enabled: state.combine });
  set('split', { enabled: state.split });
  set('cover-alone', { enabled: state.coverEnabled, checked: state.coverChecked });
  set('highlight-fields', { enabled: state.fieldsEnabled, checked: state.fieldsChecked });
  set('dark-mode', { checked: state.darkChecked });
  set('open-folder', { enabled: state.library });
  set('rebuild-index', { enabled: state.libraryConnected });
  set('close-folder', { enabled: state.libraryConnected });
}

// The application menu shows the window in front, so another window's push is kept until that window is focused.
// The Windows overlay follows the app's own dark-mode setting, which the OS theme does not track.
ipcMain.on('menu-state', (event, /** @type {MenuState} */ state) => {
  const s = stateOf(event.sender);
  if (!s) return;
  s.menuState = state;
  const folderName = typeof state.folderName === 'string' && state.folderName ? state.folderName : null;
  const folderChanged = folderName !== s.folderName;
  s.folderName = folderName;
  if (process.platform === 'win32') s.win.setTitleBarOverlay(overlayColors(!!state.darkChecked));
  if (targetWindow() === s) applyMenuState(state);
  if (folderChanged) pushFoldersOpenElsewhere();
});

// The library writes what a relaunch resumes only from the window in front, so every window is told whether it is.
app.on('browser-window-focus', (_event, win) => {
  // Once a quit begins, the window focused last keeps the resume, whatever focus does as the windows close.
  if (quitting) return;
  lastFocusedId = win.id;
  const s = windows.get(win.id);
  for (const other of windows.values()) {
    if (!other.win.isDestroyed()) other.win.webContents.send('window-focused', other === s);
  }
  if (s?.menuState) applyMenuState(s.menuState);
});

ipcMain.on('focus-folder-window', (_event, /** @type {string} */ name) => {
  const s = liveWindows().find((w) => w.folderName === name);
  if (!s) return;
  if (s.win.isMinimized()) s.win.restore();
  s.win.focus();
});
ipcMain.on('new-window', () => createWindow({ fresh: true }));

// These channels take a folder's name, never a path, so the renderer cannot point the shell at arbitrary files.
/** @param {string} name */
const folderPathFor = (name) => (typeof name === 'string' && name ? shellState.recentFolders.find((p) => path.basename(p) === name) ?? null : null);
ipcMain.handle('folder-path', (_event, name) => {
  const p = folderPathFor(name);
  if (!p) return null;
  const home = app.getPath('home');
  const dir = path.dirname(p);
  return { path: p, dir: dir === home || dir.startsWith(home + path.sep) ? `~${dir.slice(home.length)}` : dir };
});
ipcMain.on('reveal-folder', (_event, name) => {
  const p = folderPathFor(name);
  if (p) shell.showItemInFolder(p);
});

// Power state feeds the library's warm-lane gate, so speculative rendering never runs on battery.
ipcMain.handle('power-state', () => ({ onBattery: powerMonitor.isOnBatteryPower() }));

ipcMain.on('window-minimize', (event) => stateOf(event.sender)?.win.minimize());
ipcMain.on('window-maximize-toggle', (event) => {
  const win = stateOf(event.sender)?.win;
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('window-fullscreen-toggle', (event) => {
  const win = stateOf(event.sender)?.win;
  if (win) win.setFullScreen(!win.isFullScreen());
});
ipcMain.on('app-teardown-done', (event) => stateOf(event.sender)?.finish?.());

// The renderer names recents by index into the main-owned list, never by path.
ipcMain.on('open-recent', (event, index) => {
  if (!Number.isInteger(index)) return;
  const file = shellState.recentFiles[index];
  if (file) sendArgsToRenderer({ file }, stateOf(event.sender) ?? targetWindow());
});
ipcMain.on('clear-recent', () => {
  setRecentFiles([]);
  pushRecentFiles();
});
ipcMain.on('remove-recent', (_event, index) => {
  if (!Number.isInteger(index) || !shellState.recentFiles[index]) return;
  setRecentFiles(shellState.recentFiles.filter((_f, i) => i !== index));
  pushRecentFiles();
});

// Preventing a window's close for its teardown aborts Electron's quit, so this flag is what finishes it once the last window closes.
app.on('before-quit', () => { quitting = true; });
// A main process that stalls on the way out is invisible yet still owns the single-instance lock, so every relaunch bounces off it and dies silently.
// Shell state reached disk in the windows' close handlers, so forcing the exit loses nothing.
app.on('will-quit', () => {
  setTimeout(() => app.exit(0), 4000).unref();
});

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  let relaunchScheduled = false;
  app.on('second-instance', (_event, argv) => {
    const args = parseArgs(argv);
    const target = targetWindow();
    if (target) {
      sendArgsToRenderer(args, target);
      if (target.win.isMinimized()) target.win.restore();
      target.win.focus();
      return;
    }
    if (args.file) pendingOpenFile = args.file;
    if (!quitting && !windows.size) {
      // A second launch can arrive before the window exists, so hold the file for did-finish-load to deliver.
      // On macOS it can also arrive with every window closed, and then opens a fresh one.
      if (app.isReady()) createWindow();
      return;
    }
    if (!quitting && process.platform === 'darwin') {
      // Every window is tearing down, but the process lives on, so the closed handler opens the window for this launch.
      reopenPending = true;
      return;
    }
    // The windows are gone but this process still holds the lock, so the launch that just bounced off it would otherwise vanish with no window and no error.
    // app.relaunch hands it to a fresh instance, which Electron spawns once this process exits.
    if (!relaunchScheduled) {
      relaunchScheduled = true;
      app.relaunch({ args: argv.slice(1) });
    }
    // Exiting while teardown is still running would cut off in-flight sidecar writes, so only the already-torn-down case exits early.
    // The other case exits through the teardown-done or failsafe path instead.
    if (!windows.size) app.exit(0);
  });

  app.whenReady().then(() => {
    // macOS gets a real application menu carrying the app's commands; the in-window menu button is hidden there.
    // Other platforms keep the in-window menu, and their window styling is unchanged.
    if (process.platform === 'darwin') {
      setAppMenu(closeFolderLabel, closeTabShown);
    } else {
      // Electron otherwise installs its default menu, whose accelerators fire even though a frameless window never draws it.
      // Ctrl+W quits, Ctrl+R reloads and loses the session, and Ctrl+0 and Ctrl+plus/minus drive Chromium page zoom over the app's own.
      Menu.setApplicationMenu(null);
    }
    // Electron grants renderer permission requests by default when no handler is installed, so everything but the two APIs the app uses is denied here.
    // The File System Access API arrives as `fileSystem` when the library's folder picker asks for write access to the chosen folder; denying it leaves the picker failing silently.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
      // File System Access handles carry no path, so the picker's write request is the only place the shell learns where a folder is.
      const req = /** @type {{filePath?: string, isDirectory?: boolean}} */ (details);
      if (permission === 'fileSystem' && req.isDirectory && req.filePath) {
        shellState.recentFolders = [req.filePath, ...shellState.recentFolders.filter((p) => p !== req.filePath)].slice(0, 10);
        saveShellState();
      }
      callback(permission === 'clipboard-sanitized-write' || permission === 'fileSystem');
    });
    // Without a check handler a folder handle restored from storage reports 'prompt' after a relaunch, and reopening the folder costs a click.
    // A check answered false makes the handle 'denied' for good, with no request to fall back on, so the check cannot be narrowed to recorded paths.
    // Granting every file-system check is safe because the renderer runs only this app's code, which stores handles only from the folder picker.
    // Other checks pass as they do with no handler installed, except the deprecated synchronous clipboard read, which nothing in the app uses.
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission !== 'deprecated-sync-clipboard-read');
    // These headers make the renderer crossOriginIsolated, which is what lets PDF bytes be shared across workers instead of cloned per worker.
    // The isolation headers must be set only here: adding a webRequest hook as well stacks duplicate values ("require-corp, require-corp"), which silently voids the policies.
    // A webRequest hook cannot replace this either, since it never decorates worker-script responses, which must carry COEP themselves to spawn.
    protocol.handle(APP_SCHEME, async (request) => {
      const { pathname } = new URL(request.url);
      const target = path.normalize(path.join(APP_ROOT, decodeURIComponent(pathname)));
      if (!target.startsWith(APP_ROOT + path.sep)) return new Response('Not found', { status: 404 });
      // Without this the inner fetch outlives an abandoned request (window closed mid-load) and its stream holds the main process open on exit.
      const res = await net.fetch(pathToFileURL(target).toString(), { signal: request.signal });
      const headers = new Headers(res.headers);
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      headers.set('Cross-Origin-Resource-Policy', 'same-origin');
      return new Response(res.body, { status: res.status, headers });
    });
    powerMonitor.on('on-battery', () => broadcast('power-changed', { onBattery: true }));
    powerMonitor.on('on-ac', () => broadcast('power-changed', { onBattery: false }));
    createWindow();
    app.on('activate', () => {
      if (quitting || liveWindows().length) return;
      if (windows.size) reopenPending = true;
      else createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // macOS apps stay in the Dock with their windows closed, unless a quit is what closed them; elsewhere the window is the app.
    if (process.platform !== 'darwin' || quitting) app.quit();
  });
}
