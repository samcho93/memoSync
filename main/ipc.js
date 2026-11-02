'use strict';

const path = require('node:path');
const { ipcMain } = require('electron');
const { COLORS, MAX_CONTENT_LENGTH, clampOpacity, cleanFont, cleanFontSize } = require('./sync/record');

const RESIZE_EDGES = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);

// 메모 id는 렌더러가 보낸 값을 믿지 않고 보낸 창에서 찾는다.
function registerIpc({ notes, windows, calendar, sharedFiles, controller, isSettingsSender }) {
  const calendarHandler = (handler) => (event, ...args) => {
    if (calendar.isSender(event.sender)) return handler(...args);
    return undefined;
  };
  const noteHandler = (handler) => (event, ...args) => {
    const id = windows.idOf(event.sender);
    if (id) return handler(id, ...args);
    return undefined;
  };
  const settingsHandler = (handler) => (event, ...args) => {
    if (isSettingsSender(event.sender)) return handler(...args);
    return undefined;
  };

  ipcMain.handle('note:get', noteHandler((id) => controller.noteView(id)));

  ipcMain.on('note:update', noteHandler((id, patch) => {
    if (!patch || typeof patch !== 'object') return;
    const clean = {};
    if (typeof patch.content === 'string') clean.content = patch.content.slice(0, MAX_CONTENT_LENGTH);
    if (COLORS.includes(patch.color)) clean.color = patch.color;
    if (typeof patch.opacity === 'number') clean.opacity = clampOpacity(patch.opacity);
    if (cleanFont(patch.font)) clean.font = cleanFont(patch.font);
    if (cleanFontSize(patch.fontSize)) clean.fontSize = cleanFontSize(patch.fontSize);
    notes.update(id, clean);
  }));

  ipcMain.on('note:toggle-top', noteHandler((id) => controller.toggleAlwaysOnTop(id)));
  ipcMain.on('note:delete', noteHandler((id) => notes.remove(id)));
  ipcMain.on('note:new', noteHandler(() => controller.newNote()));
  ipcMain.on('note:flushed', noteHandler((id) => windows.flushed(id)));

  ipcMain.on('note:resize-start', noteHandler((id) => windows.beginResize(id)));
  ipcMain.on('note:resize-move', noteHandler((id, edge, dx, dy) => {
    if (RESIZE_EDGES.has(edge) && Number.isFinite(dx) && Number.isFinite(dy)) windows.resize(id, edge, dx, dy);
  }));
  ipcMain.on('note:resize-end', noteHandler((id) => windows.endResize(id)));

  const isName = (value) => typeof value === 'string';
  ipcMain.handle('note:files-list', noteHandler((id) => sharedFiles.list(id)));
  ipcMain.handle('note:files-pick', noteHandler((id) => sharedFiles.addViaDialog(id)));
  ipcMain.handle('note:files-add', noteHandler((id, paths) => {
    const valid = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && path.isAbsolute(p)) : [];
    return sharedFiles.addPaths(id, valid);
  }));
  ipcMain.handle('note:files-open', noteHandler((id, name) => (isName(name) ? sharedFiles.open(id, name) : {})));
  ipcMain.handle('note:files-save', noteHandler((id, name) => (isName(name) ? sharedFiles.saveAs(id, name) : {})));
  ipcMain.handle('note:files-remove', noteHandler((id, name) => (isName(name) ? sharedFiles.remove(id, name) : {})));

  ipcMain.handle('calendar:get', calendarHandler(() => calendar.view()));
  ipcMain.on('calendar:set-opacity', calendarHandler((value) => {
    if (typeof value === 'number') calendar.setOpacity(value);
  }));
  ipcMain.on('calendar:toggle-top', calendarHandler(() => calendar.toggleAlwaysOnTop()));
  ipcMain.on('calendar:hide', calendarHandler(() => calendar.setEnabled(false)));
  ipcMain.on('calendar:open-note', calendarHandler((id) => {
    if (typeof id === 'string' && windows.has(id)) windows.focus(id);
  }));
  ipcMain.on('calendar:resize-start', calendarHandler(() => calendar.beginResize()));
  ipcMain.on('calendar:resize-move', calendarHandler((edge, dx, dy) => {
    if (RESIZE_EDGES.has(edge) && Number.isFinite(dx) && Number.isFinite(dy)) calendar.resize(edge, dx, dy);
  }));
  ipcMain.on('calendar:resize-end', calendarHandler(() => calendar.endResize()));

  ipcMain.handle('settings:get', settingsHandler(() => controller.settingsView()));
  ipcMain.handle('settings:choose-folder', settingsHandler(() => controller.chooseSyncFolder()));
  ipcMain.handle('settings:reset-folder', settingsHandler(() => controller.setSyncFolder('')));
  ipcMain.handle('settings:set-sync-position', settingsHandler((value) => controller.setSyncPosition(value === true)));
  ipcMain.handle('settings:set-auto-start', settingsHandler((value) => controller.setAutoStart(value === true)));
  ipcMain.handle('settings:open-folder', settingsHandler(() => controller.openSyncFolder()));
}

module.exports = { registerIpc };
