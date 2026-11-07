const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectFiles: () => ipcRenderer.invoke('dialog:selectFiles'),
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  probeFiles: (filePaths) => ipcRenderer.invoke('ffmpeg:probeFiles', filePaths),
  startQueue: (items, settings) => ipcRenderer.invoke('ffmpeg:startQueue', { items, settings }),
  cancelItem: (id) => ipcRenderer.invoke('ffmpeg:cancelItem', id),
  cancelAll: () => ipcRenderer.invoke('ffmpeg:cancelAll'),
  openPath: (targetPath) => ipcRenderer.invoke('shell:openPath', targetPath),
  showItemInFolder: (targetPath) => ipcRenderer.invoke('shell:showItemInFolder', targetPath),
  deleteOriginal: (filePath) => ipcRenderer.invoke('fs:deleteOriginal', filePath),
  getSystemInfo: () => ipcRenderer.invoke('system:info'),
  onProgress: (callback) => {
    const subscription = (_event, data) => callback(data);
    ipcRenderer.on('ffmpeg:progress', subscription);
    return () => ipcRenderer.removeListener('ffmpeg:progress', subscription);
  },
  onItemStatus: (callback) => {
    const subscription = (_event, data) => callback(data);
    ipcRenderer.on('ffmpeg:itemStatus', subscription);
    return () => ipcRenderer.removeListener('ffmpeg:itemStatus', subscription);
  },
  onQueueFinished: (callback) => {
    const subscription = (_event, data) => callback(data);
    ipcRenderer.on('ffmpeg:queueFinished', subscription);
    return () => ipcRenderer.removeListener('ffmpeg:queueFinished', subscription);
  }
});
