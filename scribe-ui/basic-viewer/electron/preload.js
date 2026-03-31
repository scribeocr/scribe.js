const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');

contextBridge.exposeInMainWorld('electronAPI', {
  readFile: async (filePath) => {
    const data = await ipcRenderer.invoke('read-file', filePath);
    return { buffer: data, name: path.basename(filePath) };
  },
  onLoadFile: (callback) => ipcRenderer.on('load-file', (_event, data) => callback(data)),
  onNavigate: (callback) => ipcRenderer.on('viewer-navigate', (_event, data) => callback(data)),
  onHighlight: (callback) => ipcRenderer.on('viewer-highlight', (_event, data) => callback(data)),
});
