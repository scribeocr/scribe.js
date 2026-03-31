const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

/**
 * Parse --key=value arguments from an argv array.
 */
function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const match = arg.match(/^--(\w+)=(.+)$/);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 1100,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'electron.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    sendArgsToRenderer(parseArgs(process.argv));
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

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
  mainWindow.webContents.send('load-file', {
    file: path.resolve(args.file),
    page: parseInt(args.page || '0', 10),
  });
}

// Handle file reads from the renderer process.
ipcMain.handle('read-file', async (_event, filePath) => {
  return fs.readFileSync(filePath);
});

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

  app.whenReady().then(createWindow);

  app.on('window-all-closed', () => {
    app.quit();
  });
}
