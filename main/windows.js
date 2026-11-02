'use strict';

const path = require('node:path');
const { BrowserWindow, screen } = require('electron');
const { MIN_WIDTH, MIN_HEIGHT, fitBounds, resizeBounds } = require('./display');

const BOUNDS_DEBOUNCE_MS = 400;
const FLUSH_TIMEOUT_MS = 1000;

const ROOT = path.join(__dirname, '..');
const PRELOAD = path.join(ROOT, 'preload.js');

function sameBounds(a, b) {
  return !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

// 창이 앱 페이지를 벗어나지 못하게 한다.
function lockNavigation(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
}

/** 메모 1개 = 투명 BrowserWindow 1개를 관리한다. */
class WindowManager {
  constructor({ onBoundsChanged }) {
    this.onBoundsChanged = onBoundsChanged;
    this.entries = new Map();
    this.hiddenAll = false;
    this.flushWaiters = new Map();
  }

  get ids() {
    return [...this.entries.keys()];
  }

  has(id) {
    return this.entries.has(id);
  }

  windowOf(id) {
    const entry = this.entries.get(id);
    return entry ? entry.win : undefined;
  }

  idOf(webContents) {
    for (const [id, entry] of this.entries) {
      if (!entry.win.isDestroyed() && entry.win.webContents === webContents) return id;
    }
    return null;
  }

  open(id, layout, { focus = false } = {}) {
    if (this.entries.has(id)) return;
    const bounds = fitBounds(layout, screen.getAllDisplays());
    const win = new BrowserWindow({
      ...bounds,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      title: 'memoSync 메모',
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      skipTaskbar: true,
      resizable: true,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      alwaysOnTop: !!layout.alwaysOnTop,
      show: false,
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    const entry = { win, applied: bounds, timer: null, resizeStart: null, allowClose: false, focusOnShow: focus };
    this.entries.set(id, entry);
    lockNavigation(win);

    // 모니터 배율이 다르면 생성 시 크기가 어긋날 수 있어 한 번 더 맞춘다.
    if (!sameBounds(win.getBounds(), bounds)) win.setBounds(bounds);
    entry.applied = win.getBounds();

    win.once('ready-to-show', () => {
      if (this.hiddenAll) return;
      if (entry.focusOnShow) win.show();
      else win.showInactive();
    });
    const onBounds = () => this._scheduleBounds(id, entry);
    win.on('move', onBounds);
    win.on('resize', onBounds);
    // Alt+F4 등으로 닫아도 메모가 삭제되면 안 되므로 숨기기만 한다. 트레이의 "전체 표시"로 다시 나타난다.
    win.on('close', (event) => {
      if (entry.allowClose) return;
      event.preventDefault();
      win.hide();
    });
    win.on('closed', () => {
      clearTimeout(entry.timer);
      if (this.entries.get(id) === entry) this.entries.delete(id);
    });
    win.loadFile(path.join(ROOT, 'renderer', 'note.html'));
  }

  _scheduleBounds(id, entry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this._commitBounds(id, entry), BOUNDS_DEBOUNCE_MS);
  }

  _commitBounds(id, entry) {
    entry.timer = null;
    if (entry.win.isDestroyed()) return;
    const bounds = entry.win.getBounds();
    // 프로그램이 옮긴 경우(원격 위치 적용, 화면 보정)는 사용자 변경이 아니므로 저장하지 않는다.
    if (sameBounds(bounds, entry.applied)) return;
    entry.applied = bounds;
    this.onBoundsChanged(id, bounds);
  }

  // 저장된 값이 아닌 보정된 값으로만 창을 옮기므로, 모니터가 다시 연결되면 원래 자리로 돌아간다.
  applyBounds(id, layout) {
    const entry = this.entries.get(id);
    if (!entry) return;
    // 사용자가 옮겼는데 아직 저장 전이면 그 이동을 살린다. 저장되면 더 새로운 쪽이 되어 다른 PC에 반영된다.
    if (entry.resizeStart || !sameBounds(entry.win.getBounds(), entry.applied)) return;
    const bounds = fitBounds(layout, screen.getAllDisplays());
    if (sameBounds(entry.win.getBounds(), bounds)) return;
    entry.applied = bounds;
    entry.win.setBounds(bounds);
    entry.applied = entry.win.getBounds();
  }

  setAlwaysOnTop(id, value) {
    const entry = this.entries.get(id);
    if (entry) entry.win.setAlwaysOnTop(value);
  }

  send(id, channel, payload) {
    const entry = this.entries.get(id);
    if (entry && !entry.win.isDestroyed()) entry.win.webContents.send(channel, payload);
  }

  focus(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.win.webContents.isLoading()) {
      entry.focusOnShow = true;
      return;
    }
    entry.win.show();
    entry.win.focus();
  }

  close(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.allowClose = true;
    clearTimeout(entry.timer);
    entry.win.destroy();
    this.entries.delete(id);
  }

  showAll() {
    this.hiddenAll = false;
    for (const { win } of this.entries.values()) {
      if (!win.webContents.isLoading() && !win.isVisible()) win.showInactive();
    }
  }

  hideAll() {
    this.hiddenAll = true;
    for (const { win } of this.entries.values()) win.hide();
  }

  beginResize(id) {
    const entry = this.entries.get(id);
    if (entry) entry.resizeStart = entry.win.getBounds();
  }

  resize(id, edge, dx, dy) {
    const entry = this.entries.get(id);
    if (!entry || !entry.resizeStart) return;
    entry.win.setBounds(resizeBounds(entry.resizeStart, edge, dx, dy));
  }

  endResize(id) {
    const entry = this.entries.get(id);
    if (entry) entry.resizeStart = null;
  }

  // 각 메모 창의 debounce 중인 입력을 저장하게 하고 응답을 기다린다.
  flushRenderers() {
    const pending = [...this.entries.entries()].map(([id, entry]) => new Promise((resolve) => {
      if (entry.win.isDestroyed()) {
        resolve();
        return;
      }
      this.flushWaiters.set(id, resolve);
      entry.win.webContents.send('note:flush');
    }));
    const timeout = new Promise((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS));
    return Promise.race([Promise.all(pending), timeout]);
  }

  flushed(id) {
    const resolve = this.flushWaiters.get(id);
    if (resolve) {
      this.flushWaiters.delete(id);
      resolve();
    }
  }

  // 끌기가 끝나기 전의 위치 변경도 종료 시 저장한다.
  commitPendingBounds() {
    for (const [id, entry] of this.entries) {
      if (entry.timer) {
        clearTimeout(entry.timer);
        this._commitBounds(id, entry);
      }
    }
  }

  destroyAll() {
    for (const entry of this.entries.values()) {
      entry.allowClose = true;
      clearTimeout(entry.timer);
      if (!entry.win.isDestroyed()) entry.win.destroy();
    }
    this.entries.clear();
  }
}

module.exports = { WindowManager, lockNavigation, sameBounds, PRELOAD, ROOT };
