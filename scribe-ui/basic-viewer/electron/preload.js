const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  isPackaged: process.argv.includes('--scribe-packaged'),
  readFile: async (filePath) => {
    const data = await ipcRenderer.invoke('read-file', filePath);
    return { buffer: data, name: path.basename(filePath) };
  },
  onLoadFile: (callback) => ipcRenderer.on('load-file', (_event, data) => callback(data)),
  onNavigate: (callback) => ipcRenderer.on('viewer-navigate', (_event, data) => callback(data)),
  onHighlight: (callback) => ipcRenderer.on('viewer-highlight', (_event, data) => callback(data)),
  onMenuAction: (callback) => ipcRenderer.on('menu-action', (_event, id) => callback(id)),
  sendMenuState: (state) => ipcRenderer.send('menu-state', state),
  getPowerState: () => ipcRenderer.invoke('power-state'),
  onPowerChanged: (callback) => ipcRenderer.on('power-changed', (_event, data) => callback(data)),
  minimize: () => ipcRenderer.send('window-minimize'),
  toggleMaximize: () => ipcRenderer.send('window-maximize-toggle'),
  toggleFullScreen: () => ipcRenderer.send('window-fullscreen-toggle'),
  onMaximizedChange: (callback) => ipcRenderer.on('window-maximized', (_event, on) => callback(on)),
  onFullScreenChange: (callback) => ipcRenderer.on('window-fullscreen', (_event, on) => callback(on)),
  onRecentFiles: (callback) => ipcRenderer.on('recent-files', (_event, files) => callback(files)),
  openRecent: (filePath) => ipcRenderer.send('open-recent', filePath),
  clearRecent: () => ipcRenderer.send('clear-recent'),
  onAppTeardown: (callback) => ipcRenderer.on('app-teardown', () => callback()),
  appTeardownDone: () => ipcRenderer.send('app-teardown-done'),
});
