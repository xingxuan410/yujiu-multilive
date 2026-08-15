const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('popup', {
  open: (roomId) => ipcRenderer.send('popup:open', roomId),
  close: () => ipcRenderer.send('popup:close')
});
