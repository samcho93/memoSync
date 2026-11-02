'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

function listen(channel, callback) {
  ipcRenderer.on(channel, (_event, payload) => callback(payload));
}

contextBridge.exposeInMainWorld('memoNote', {
  get: () => ipcRenderer.invoke('note:get'),
  update: (patch) => ipcRenderer.send('note:update', patch),
  toggleTop: () => ipcRenderer.send('note:toggle-top'),
  remove: () => ipcRenderer.send('note:delete'),
  create: () => ipcRenderer.send('note:new'),
  flushed: () => ipcRenderer.send('note:flushed'),
  resizeStart: () => ipcRenderer.send('note:resize-start'),
  resizeMove: (edge, dx, dy) => ipcRenderer.send('note:resize-move', edge, dx, dy),
  resizeEnd: () => ipcRenderer.send('note:resize-end'),
  listFiles: () => ipcRenderer.invoke('note:files-list'),
  pickFiles: () => ipcRenderer.invoke('note:files-pick'),
  // 끌어다 놓은 File의 실제 경로는 preload에서만 얻을 수 있다.
  pathForFile: (file) => webUtils.getPathForFile(file),
  addFiles: (paths) => ipcRenderer.invoke('note:files-add', paths),
  openFile: (name) => ipcRenderer.invoke('note:files-open', name),
  saveFile: (name) => ipcRenderer.invoke('note:files-save', name),
  removeFile: (name) => ipcRenderer.invoke('note:files-remove', name),
  onFiles: (callback) => listen('note:attachments', callback),
  onState: (callback) => listen('note:state', callback),
  onFlush: (callback) => listen('note:flush', callback),
});

contextBridge.exposeInMainWorld('memoCalendar', {
  get: () => ipcRenderer.invoke('calendar:get'),
  setOpacity: (value) => ipcRenderer.send('calendar:set-opacity', value),
  toggleTop: () => ipcRenderer.send('calendar:toggle-top'),
  hide: () => ipcRenderer.send('calendar:hide'),
  openNote: (id) => ipcRenderer.send('calendar:open-note', id),
  resizeStart: () => ipcRenderer.send('calendar:resize-start'),
  resizeMove: (edge, dx, dy) => ipcRenderer.send('calendar:resize-move', edge, dx, dy),
  resizeEnd: () => ipcRenderer.send('calendar:resize-end'),
  onState: (callback) => listen('calendar:state', callback),
});

contextBridge.exposeInMainWorld('memoSettings', {
  get: () => ipcRenderer.invoke('settings:get'),
  chooseFolder: () => ipcRenderer.invoke('settings:choose-folder'),
  resetFolder: () => ipcRenderer.invoke('settings:reset-folder'),
  setSyncPosition: (value) => ipcRenderer.invoke('settings:set-sync-position', value),
  setAutoStart: (value) => ipcRenderer.invoke('settings:set-auto-start', value),
  openFolder: () => ipcRenderer.invoke('settings:open-folder'),
  onStatus: (callback) => listen('settings:status', callback),
});
