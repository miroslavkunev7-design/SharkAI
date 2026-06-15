const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sharkai', {
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  isElectron: true,
});
