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

let mainWindow;
let shuttingDown = false;

// The Linux window is transparent so the renderer can round its corners the way GNOME rounds every window.
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-transparent-visuals');

// Window bounds, the maximize flag, and the recent-files list survive relaunches here.
const shellStatePath = path.join(app.getPath('userData'), 'shell-state.json');
let shellState = { bounds: null, isMaximized: false, recentFiles: [] };
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

function pushRecentFiles() {
  if (!mainWindow) return;
  mainWindow.webContents.send('recent-files', shellState.recentFiles.map((f) => ({ label: path.basename(f) })));
}

// Feeds the macOS Open Recent menu, the Windows jump list, and the in-window menu's Open recent submenu.
function recordRecentFile(file) {
  // Windows paths compare case-insensitively, so a re-open with different casing must not duplicate the entry.
  const key = process.platform === 'win32' ? file.toLowerCase() : file;
  shellState.recentFiles = [file, ...shellState.recentFiles
    .filter((f) => (process.platform === 'win32' ? f.toLowerCase() : f) !== key)].slice(0, 10);
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

function createWindow() {
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
  const { workArea } = screen.getPrimaryDisplay();
  mainWindow = new BrowserWindow({
    width: restoredBounds ? restoredBounds.width : 900,
    // The portrait default must still fit a 1080p work area on first run.
    height: restoredBounds ? restoredBounds.height : Math.min(1100, workArea.height - 40),
    ...(restoredBounds ? { x: restoredBounds.x, y: restoredBounds.y } : {}),
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
      additionalArguments: app.isPackaged ? ['--scribe-packaged'] : [],
    },
  });
  if (shellState.isMaximized) mainWindow.maximize();
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  let saveTimer = null;
  const noteBounds = () => {
    if (!mainWindow) return;
    shellState.bounds = mainWindow.getNormalBounds();
    shellState.isMaximized = mainWindow.isMaximized();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveShellState, 500);
  };
  mainWindow.on('resize', noteBounds);
  mainWindow.on('move', noteBounds);
  // The Linux caption trio swaps its maximize glyph for a restore glyph while maximized, and the rounded corners square off.
  mainWindow.on('maximize', () => { noteBounds(); mainWindow?.webContents.send('window-maximized', true); });
  mainWindow.on('unmaximize', () => { noteBounds(); mainWindow?.webContents.send('window-maximized', false); });
  mainWindow.on('enter-full-screen', () => mainWindow?.webContents.send('window-fullscreen', true));
  mainWindow.on('leave-full-screen', () => mainWindow?.webContents.send('window-fullscreen', false));
  mainWindow.on('close', (event) => {
    clearTimeout(saveTimer);
    if (mainWindow) {
      shellState.bounds = mainWindow.getNormalBounds();
      shellState.isMaximized = mainWindow.isMaximized();
    }
    saveShellState();
    // A quit re-closes the window while teardown is already under way.
    // Restarting the pass would re-send the IPC and re-arm the failsafe, so let the scheduled destroy finish the job.
    if (shuttingDown) {
      event.preventDefault();
      return;
    }
    // The renderer flushes dirty library sidecars while their documents are still alive, then winds down its worker pools.
    // Hiding first keeps the close feeling instant.
    // The failsafe destroys the window regardless, so a stuck renderer cannot turn the close into a hang.
    shuttingDown = true;
    event.preventDefault();
    mainWindow.hide();
    mainWindow.webContents.send('app-teardown');
    let failsafe = null;
    const finish = () => {
      if (failsafe) clearTimeout(failsafe);
      ipcMain.removeListener('app-teardown-done', finish);
      mainWindow?.destroy();
    };
    failsafe = setTimeout(finish, 3000);
    ipcMain.once('app-teardown-done', finish);
  });

  // A remote page navigated into this window would inherit the preload bridge.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(`${APP_SCHEME}://`)) return;
    event.preventDefault();
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });

  // Native cut/copy/paste menu in editable fields, which Electron does not provide on its own.
  // Scoped to editables: the app draws its own menus elsewhere (bookmarks, comments, layout boxes).
  mainWindow.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable) return;
    Menu.buildFromTemplate([
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
      { type: 'separator' }, { role: 'selectAll' },
    ]).popup();
  });

  mainWindow.loadURL(`${APP_SCHEME}://bundle/scribe-ui/basic-viewer/electron/electron.html`);

  mainWindow.webContents.on('did-finish-load', () => {
    rendererReady = true;
    pushRecentFiles();
    if (pendingOpenFile) {
      sendArgsToRenderer({ file: pendingOpenFile });
      pendingOpenFile = null;
    } else {
      sendArgsToRenderer(parseArgs(process.argv));
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// macOS delivers file opens (double-click, "Open With", drag onto the Dock icon) as events rather than argv, and they can arrive before the renderer has its listeners.
let pendingOpenFile = null;
let rendererReady = false;
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (rendererReady && mainWindow) sendArgsToRenderer({ file: filePath });
  else pendingOpenFile = filePath;
});

function sendArgsToRenderer(args) {
  if (!mainWindow) return;

  const action = args.action || 'load';

  if (action === 'navigate') {
    mainWindow.webContents.send('viewer-navigate', {
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
    mainWindow.webContents.send('viewer-highlight', { highlights });
    return;
  }

  // Default: load file
  if (!args.file) return;
  const file = path.resolve(args.file);
  // Main reads the bytes itself, so no IPC channel accepts a filesystem path from the renderer.
  // The path still rides along because the renderer uses it as the identity key for same-file navigation.
  fs.promises.readFile(file).then((bytes) => {
    if (!mainWindow) return;
    recordRecentFile(file);
    mainWindow.webContents.send('load-file', {
      file,
      name: path.basename(file),
      bytes,
      page: parseInt(args.page || '0', 10),
    });
  }).catch((err) => console.error(`Could not read ${file}: ${err.message}`));
}

// The renderer pushes menu state whenever it changes, so the macOS menu items grey and check to match the app.
// The Windows overlay follows the app's own dark-mode setting, which the OS theme does not track.
ipcMain.on('menu-state', (_event, state) => {
  if (process.platform === 'win32' && mainWindow) mainWindow.setTitleBarOverlay(overlayColors(!!state.darkChecked));
  const menu = Menu.getApplicationMenu();
  if (!menu) return;
  const set = (id, props) => {
    const item = menu.getMenuItemById(id);
    if (item) Object.assign(item, props);
  };
  set('print', { enabled: state.docOpen });
  set('export-pdf', { enabled: state.docOpen });
  set('rotate-left', { enabled: state.docOpen });
  set('rotate-right', { enabled: state.docOpen });
  set('recognize', { enabled: state.recognize });
  set('combine', { enabled: state.combine });
  set('split', { enabled: state.split });
  set('cover-alone', { enabled: state.coverEnabled, checked: state.coverChecked });
  set('highlight-fields', { enabled: state.fieldsEnabled, checked: state.fieldsChecked });
  set('dark-mode', { checked: state.darkChecked });
});

// Power state feeds the library's warm-lane gate, so speculative rendering never runs on battery.
ipcMain.handle('power-state', () => ({ onBattery: powerMonitor.isOnBatteryPower() }));

ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize-toggle', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window-fullscreen-toggle', () => mainWindow?.setFullScreen(!mainWindow.isFullScreen()));

// The renderer names recents by index into the main-owned list, never by path.
ipcMain.on('open-recent', (_event, index) => {
  if (!Number.isInteger(index)) return;
  const file = shellState.recentFiles[index];
  if (file) sendArgsToRenderer({ file });
});
ipcMain.on('clear-recent', () => {
  shellState.recentFiles = [];
  saveShellState();
  app.clearRecentDocuments();
  pushRecentFiles();
});

// A main process that stalls on the way out is invisible yet still owns the single-instance lock, so every relaunch bounces off it and dies silently.
// Shell state reached disk in the window's close handler, so forcing the exit loses nothing.
app.on('will-quit', () => {
  setTimeout(() => app.exit(0), 4000).unref();
});

// Single-instance lock: if another instance is launched, forward its args
// to the existing window instead of opening a second window.
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  let relaunchScheduled = false;
  app.on('second-instance', (_event, argv) => {
    const args = parseArgs(argv);
    if (shuttingDown || !mainWindow) {
      if (!shuttingDown) {
        // A second launch can arrive before the window exists, so hold the file for did-finish-load to deliver.
        if (args.file) pendingOpenFile = args.file;
        return;
      }
      // The window is gone but this process still holds the lock, so the launch that just bounced off it would otherwise vanish with no window and no error.
      // app.relaunch hands it to a fresh instance, which Electron spawns once this process exits.
      if (!relaunchScheduled) {
        relaunchScheduled = true;
        app.relaunch({ args: argv.slice(1) });
      }
      // Exiting while teardown is still running would cut off in-flight sidecar writes, so only the already-torn-down case exits early.
      // The other case exits through the teardown-done or failsafe path instead.
      if (!mainWindow) app.exit(0);
      return;
    }
    sendArgsToRenderer(args);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    // macOS gets a real application menu carrying the app's commands; the in-window menu button is hidden there.
    // Other platforms keep the in-window menu, and their window styling is unchanged.
    if (process.platform === 'darwin') {
      const send = (id) => () => mainWindow?.webContents.send('menu-action', id);
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { role: 'appMenu' },
        {
          label: 'File',
          submenu: [
            { id: 'open', label: 'Open…', accelerator: 'CmdOrCtrl+O', click: send('open') },
            { label: 'Open Recent', role: 'recentDocuments', submenu: [{ label: 'Clear Menu', role: 'clearRecentDocuments' }] },
            { type: 'separator' },
            { role: 'close' },
            { type: 'separator' },
            { id: 'recognize', label: 'Recognize Text…', enabled: false, click: send('recognize') },
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
            { role: 'undo' }, { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
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
      ]));
    } else {
      // Electron otherwise installs its default menu, whose accelerators fire even though a frameless window never draws it.
      // Ctrl+W quits, Ctrl+R reloads and loses the session, and Ctrl+0 and Ctrl+plus/minus drive Chromium page zoom over the app's own.
      Menu.setApplicationMenu(null);
    }
    // Electron grants renderer permission requests by default when no handler is installed.
    // The app's only permission-gated API is clipboard writes, so everything else is denied.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'clipboard-sanitized-write');
    });
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
    powerMonitor.on('on-battery', () => mainWindow?.webContents.send('power-changed', { onBattery: true }));
    powerMonitor.on('on-ac', () => mainWindow?.webContents.send('power-changed', { onBattery: false }));
    createWindow();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
