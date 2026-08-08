const {
  app, BrowserWindow, ipcMain, powerMonitor, nativeTheme, Menu, shell, protocol, net,
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
  mainWindow = new BrowserWindow({
    width: 900,
    height: 1100,
    minWidth: 620,
    minHeight: 440,
    // macOS: decorated window with the native traffic lights overlaying the toolbar.
    // Windows and Linux: frameless, with the close button the renderer supplies.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : { frame: false }),
    title: '21 Viewer',
    // Match the app's canvas token so the first paint does not flash a mismatched color.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#12151b' : '#f4f6fa',
    // Windows and Linux take the window icon from here.
    // macOS ignores it and uses the icon from the app bundle instead.
    icon: path.join(__dirname, '../icons/icon-512.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // A remote page navigated into this window would inherit the preload bridge and its read-any-path IPC.
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
  // Feeds the File menu's native Open Recent submenu on macOS.
  app.addRecentDocument(file);
  mainWindow.webContents.send('load-file', {
    file,
    page: parseInt(args.page || '0', 10),
  });
}

// The renderer pushes menu state whenever it changes, so the macOS menu items grey and check to match the app.
ipcMain.on('menu-state', (_event, state) => {
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

// Handle file reads from the renderer process.
ipcMain.handle('read-file', async (_event, filePath) => {
  return fs.readFileSync(filePath);
});

// Power state feeds the library's warm-lane gate, so speculative rendering never runs on battery.
ipcMain.handle('power-state', () => ({ onBattery: powerMonitor.isOnBatteryPower() }));

// Single-instance lock: if another instance is launched, forward its args
// to the existing window instead of opening a second window.
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const args = parseArgs(argv);
    sendArgsToRenderer(args);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
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
    }
    // These headers make the renderer crossOriginIsolated, which is what lets PDF bytes be shared across workers instead of cloned per worker.
    // The isolation headers must be set only here: adding a webRequest hook as well stacks duplicate values ("require-corp, require-corp"), which silently voids the policies.
    // A webRequest hook cannot replace this either, since it never decorates worker-script responses, which must carry COEP themselves to spawn.
    protocol.handle(APP_SCHEME, async (request) => {
      const { pathname } = new URL(request.url);
      const target = path.normalize(path.join(APP_ROOT, decodeURIComponent(pathname)));
      if (!target.startsWith(APP_ROOT + path.sep)) return new Response('Not found', { status: 404 });
      const res = await net.fetch(pathToFileURL(target).toString());
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
