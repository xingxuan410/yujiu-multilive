const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get').then(r => (r && r.data) || r),
  onState: (cb) => { const h = (_e, data) => cb(data); ipcRenderer.on('state:change', h); return () => ipcRenderer.removeListener('state:change', h); },
  resolveRoom: (input) => ipcRenderer.invoke('streamer:resolve', input),
  addStreamer: (p) => ipcRenderer.invoke('streamer:add', p),
  removeStreamer: (id) => ipcRenderer.invoke('streamer:remove', id),
  renameStreamer: (p) => ipcRenderer.invoke('streamer:rename', p),
  moveStreamer: (p) => ipcRenderer.invoke('streamer:move', p),
  addGroup: (name) => ipcRenderer.invoke('group:add', name),
  removeGroup: (id) => ipcRenderer.invoke('group:remove', id),
  renameGroup: (p) => ipcRenderer.invoke('group:rename', p),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  openRoom: (roomId) => ipcRenderer.invoke('room:open', roomId),
  closeRoom: (roomId) => ipcRenderer.invoke('room:close', roomId),
  setMute: (p) => ipcRenderer.invoke('room:mute', p),
  toggleChat: (roomId) => ipcRenderer.invoke('room:toggle-chat', roomId),
  focusRoom: (roomId) => ipcRenderer.invoke('room:focus', roomId),
  onRooms: (cb) => { const h = (_e, list) => cb(list); ipcRenderer.on('rooms:change', h); return () => ipcRenderer.removeListener('rooms:change', h); },
  onActiveRoom: (cb) => { const h = (_e, rid) => cb(rid); ipcRenderer.on('rooms:active', h); return () => ipcRenderer.removeListener('rooms:active', h); },
  testNotify: () => ipcRenderer.invoke('notify:test'),
  setOverlay: (show) => ipcRenderer.invoke('ui:overlay', show)
});
