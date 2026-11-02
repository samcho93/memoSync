'use strict';

const path = require('node:path');
const { app, BrowserWindow, Menu, dialog, screen, shell } = require('electron');
const { NoteManager } = require('./notes');
const { FolderStore } = require('./sync/FolderStore');
const { LAYOUT_FIELDS } = require('./sync/record');
const { Settings } = require('./settings');
const { WindowManager, lockNavigation, PRELOAD, ROOT } = require('./windows');
const { cascadeBounds } = require('./display');
const { CalendarWindow } = require('./calendar');
const { SharedFiles } = require('./sharedFiles');
const { AppTray, buildTemplate } = require('./tray');
const { registerIpc } = require('./ipc');

// --user-data=경로 로 여러 인스턴스를 실행할 수 있다. 단일 인스턴스 잠금보다 먼저 지정해야 한다.
const userDataArg = process.argv.find((arg) => arg.startsWith('--user-data='));
if (userDataArg) app.setPath('userData', path.resolve(userDataArg.slice('--user-data='.length)));

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  start();
}

function start() {
  app.setAppUserModelId('com.memosync.app');

  const settings = new Settings(path.join(app.getPath('userData'), 'settings.json'));
  let notes;
  let windows;
  let calendar;
  let sharedFiles;
  let tray = null;
  let settingsWindow = null;
  let quitState = 'running';

  const syncFolder = () => settings.get('syncFolder') || path.join(app.getPath('userData'), 'notes');

  function loginItemOptions() {
    const args = app.isPackaged ? [] : [app.getAppPath()];
    if (userDataArg) args.push(userDataArg);
    return { path: process.execPath, args, name: 'memoSync' };
  }

  function layoutFor(id, record) {
    const saved = settings.getLayout(id);
    if (saved) return saved;
    const hasPosition = settings.get('syncPosition') && Number.isFinite(record.x) && Number.isFinite(record.y)
      && Number.isFinite(record.w) && Number.isFinite(record.h);
    const layout = hasPosition
      ? { x: record.x, y: record.y, width: record.w, height: record.h, alwaysOnTop: record.alwaysOnTop === true }
      : { ...cascadeBounds(windows.ids.length, screen.getPrimaryDisplay().workArea), alwaysOnTop: false };
    settings.setLayout(id, layout);
    return layout;
  }

  function noteView(id) {
    const record = notes.get(id);
    if (!record) return null;
    const layout = settings.getLayout(id) || {};
    return {
      content: record.content,
      color: record.color,
      opacity: record.opacity,
      font: record.font || null,
      fontSize: record.fontSize || null,
      alwaysOnTop: layout.alwaysOnTop === true,
    };
  }

  function layoutFields(layout) {
    return { x: layout.x, y: layout.y, w: layout.width, h: layout.height, alwaysOnTop: layout.alwaysOnTop === true };
  }

  // ---- 메모 ↔ 창 연결 ----

  function onNoteCreated(record, { local }) {
    windows.open(record.id, layoutFor(record.id, record), { focus: local });
  }

  function onNoteUpdated(record, { local }) {
    if (local) return;
    if (settings.get('syncPosition')) applyRemoteLayout(record);
    windows.send(record.id, 'note:state', noteView(record.id));
  }

  function applyRemoteLayout(record) {
    const hasBounds = LAYOUT_FIELDS.slice(1).every((key) => Number.isFinite(record[key]));
    const current = settings.getLayout(record.id) || {};
    const next = { ...current };
    if (hasBounds) Object.assign(next, { x: record.x, y: record.y, width: record.w, height: record.h });
    if (typeof record.alwaysOnTop === 'boolean') next.alwaysOnTop = record.alwaysOnTop;
    settings.setLayout(record.id, next);
    if (hasBounds) windows.applyBounds(record.id, next);
    windows.setAlwaysOnTop(record.id, next.alwaysOnTop === true);
  }

  function onNoteRemoved(id) {
    windows.close(id);
    settings.removeLayout(id);
    sharedFiles.forget(id);
  }

  function onBoundsChanged(id, bounds) {
    settings.setLayout(id, bounds);
    if (settings.get('syncPosition')) notes.update(id, layoutFields(settings.getLayout(id)));
  }

  // ---- 사용자 동작 ----

  const controller = {
    noteView,

    newNote() {
      if (windows.hiddenAll) controller.showAll();
      return notes.create();
    },

    showAll() {
      windows.showAll();
      calendar.setAllHidden(false);
      settings.set('notesHidden', false);
    },

    hideAll() {
      windows.hideAll();
      calendar.setAllHidden(true);
      settings.set('notesHidden', true);
    },

    isCalendarEnabled: () => calendar.enabled,
    setCalendarEnabled: (value) => calendar.setEnabled(value),

    toggleAlwaysOnTop(id) {
      const layout = settings.getLayout(id) || {};
      const value = layout.alwaysOnTop !== true;
      settings.setLayout(id, { alwaysOnTop: value });
      windows.setAlwaysOnTop(id, value);
      windows.send(id, 'note:state', noteView(id));
      if (settings.get('syncPosition')) notes.update(id, layoutFields(settings.getLayout(id)));
    },

    async openSyncFolder() {
      return shell.openPath(syncFolder());
    },

    openSettings() {
      if (settingsWindow) {
        settingsWindow.show();
        settingsWindow.focus();
        return;
      }
      settingsWindow = new BrowserWindow({
        width: 600,
        height: 680,
        minWidth: 440,
        minHeight: 420,
        title: 'memoSync 설정',
        icon: path.join(ROOT, 'assets', 'icon.ico'),
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
          preload: PRELOAD,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      lockNavigation(settingsWindow);
      settingsWindow.once('ready-to-show', () => settingsWindow.show());
      settingsWindow.on('closed', () => { settingsWindow = null; });
      settingsWindow.loadFile(path.join(ROOT, 'renderer', 'settings.html'));
    },

    settingsView() {
      return {
        syncFolder: syncFolder(),
        isCustomFolder: !!settings.get('syncFolder'),
        syncPosition: settings.get('syncPosition'),
        autoStart: controller.isAutoStart(),
        deviceId: settings.get('deviceId'),
        status: notes.status,
      };
    },

    async chooseSyncFolder() {
      const result = await dialog.showOpenDialog(settingsWindow, {
        title: '동기화 폴더 선택',
        defaultPath: syncFolder(),
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || !result.filePaths[0]) return controller.settingsView();
      return controller.setSyncFolder(result.filePaths[0]);
    },

    async setSyncFolder(folder) {
      settings.set('syncFolder', folder);
      await notes.setStore(new FolderStore({ folder: syncFolder() }));
      return controller.settingsView();
    },

    setSyncPosition(value) {
      settings.set('syncPosition', value);
      // 켜는 순간 다른 PC가 이미 올린 위치가 있으면 따르고, 없으면 이 PC의 위치를 올린다.
      if (value) {
        for (const note of notes.active()) {
          const layout = settings.getLayout(note.id);
          if (Number.isFinite(note.x)) applyRemoteLayout(note);
          else if (layout) notes.update(note.id, layoutFields(layout));
          windows.send(note.id, 'note:state', noteView(note.id));
        }
      }
      return controller.settingsView();
    },

    isAutoStart() {
      // 사용자 지정 name을 쓰면 openAtLogin은 항상 false로 나오므로 launchItems로 판단한다.
      const { name, ...query } = loginItemOptions();
      return app.getLoginItemSettings(query).launchItems.some((item) => item.name === name && item.enabled);
    },

    setAutoStart(value) {
      app.setLoginItemSettings({ ...loginItemOptions(), openAtLogin: value });
      if (tray) tray.refresh();
      return controller.settingsView();
    },

    getStatus: () => notes.status,
    quit: () => app.quit(),
  };

  // ---- 앱 수명 주기 ----

  app.on('second-instance', () => controller.showAll());
  // 창을 모두 닫아도 트레이에 남는다.
  app.on('window-all-closed', () => {});

  app.on('before-quit', async (event) => {
    if (quitState === 'done') return;
    event.preventDefault();
    if (quitState === 'quitting') return;
    quitState = 'quitting';
    try {
      await windows.flushRenderers();
      windows.commitPendingBounds();
      calendar.destroy();
      await notes.stop();
      await settings.flush();
    } catch (err) {
      console.error('[app] 종료 처리 실패', err);
    }
    windows.destroyAll();
    quitState = 'done';
    app.quit();
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    settings.load();

    windows = new WindowManager({ onBoundsChanged });
    windows.hiddenAll = settings.get('notesHidden') === true;
    notes = new NoteManager({
      deviceId: settings.get('deviceId'),
      cachePath: path.join(app.getPath('userData'), 'notes-cache.json'),
    });
    notes.on('created', onNoteCreated);
    notes.on('updated', onNoteUpdated);
    notes.on('removed', onNoteRemoved);
    calendar = new CalendarWindow({
      settings,
      getNotes: () => notes.active(),
      onEnabledChanged: () => { if (tray) tray.refresh(); },
    });
    calendar.hiddenAll = windows.hiddenAll;
    for (const event of ['created', 'updated', 'removed']) {
      notes.on(event, () => calendar.scheduleRefresh());
    }
    sharedFiles = new SharedFiles({ notes, windows });
    notes.on('attachments', (id) => sharedFiles.refresh(id));
    notes.on('status', () => {
      sharedFiles.refreshAll();
      if (tray) tray.refresh();
      if (settingsWindow) settingsWindow.webContents.send('settings:status', notes.status);
    });

    registerIpc({
      notes,
      windows,
      calendar,
      sharedFiles,
      controller,
      isSettingsSender: (sender) => !!settingsWindow && settingsWindow.webContents === sender,
    });

    // 폴더를 읽기 전에 캐시로 먼저 띄워 클라우드 폴더가 느리거나 없어도 메모가 바로 보이게 한다.
    await notes.load();
    for (const note of notes.active()) {
      windows.open(note.id, layoutFor(note.id, note));
    }
    calendar.open();
    tray = new AppTray(controller);

    // 화면 구성이 바뀌면 저장된 위치를 기준으로 다시 맞춘다.
    const refit = () => {
      for (const id of windows.ids) {
        const layout = settings.getLayout(id);
        if (layout) windows.applyBounds(id, layout);
      }
      calendar.refit();
    };
    screen.on('display-added', refit);
    screen.on('display-removed', refit);
    screen.on('display-metrics-changed', refit);

    if (process.env.MEMOSYNC_E2E) {
      globalThis.memoSyncTest = { controller, notes, windows, calendar, settings, tray, trayTemplate: () => buildTemplate(controller) };
    }

    await notes.setStore(new FolderStore({ folder: syncFolder() }));
  });
}
