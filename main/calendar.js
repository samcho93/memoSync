'use strict';

const path = require('node:path');
const { BrowserWindow, screen } = require('electron');
const { fitBounds, resizeBounds } = require('./display');
const { clampOpacity } = require('./sync/record');
const { lockNavigation, sameBounds, PRELOAD, ROOT } = require('./windows');
const { collectEvents, localDateKey } = require('./schedule');

const MIN_WIDTH = 360;
const MIN_HEIGHT = 340;
const DEFAULT_WIDTH = 480;
const DEFAULT_HEIGHT = 460;
const DEFAULT_OPACITY = 0.6;
const BOUNDS_DEBOUNCE_MS = 400;
const REFRESH_DEBOUNCE_MS = 50;
const DATE_CHECK_MS = 60_000;

/** 메모 내용에서 읽은 일정을 보여 주는 투명 달력 창. 위치·투명도는 PC별 설정이고 일정은 메모에서 매번 계산한다. */
class CalendarWindow {
  constructor({ settings, getNotes, focusNote, onEnabledChanged }) {
    this.settings = settings;
    this.getNotes = getNotes;
    this.focusNote = focusNote;
    this.onEnabledChanged = onEnabledChanged;
    this.win = null;
    this.applied = null;
    this.boundsTimer = null;
    this.refreshTimer = null;
    this.resizeStart = null;
    this.hiddenAll = false;
    this.allowClose = false;
    this.today = localDateKey();
    // 자정과 새해에 오늘 표시와 월일 일정의 연도를 바꾼다.
    this.dateTimer = setInterval(() => {
      if (localDateKey() === this.today) return;
      this.today = localDateKey();
      this.refresh();
    }, DATE_CHECK_MS);
  }

  _state() {
    const { workArea } = screen.getPrimaryDisplay();
    return {
      enabled: true,
      opacity: DEFAULT_OPACITY,
      alwaysOnTop: false,
      x: workArea.x + 40,
      y: workArea.y + 60,
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
      ...this.settings.get('calendar'),
    };
  }

  _save(patch) {
    this.settings.set('calendar', { ...this.settings.get('calendar'), ...patch });
  }

  _bounds(state) {
    const { x, y, width, height } = state;
    return fitBounds({ x, y, width, height }, screen.getAllDisplays());
  }

  get enabled() {
    return this._state().enabled;
  }

  isSender(webContents) {
    return !!this.win && !this.win.isDestroyed() && this.win.webContents === webContents;
  }

  view() {
    const { opacity, alwaysOnTop } = this._state();
    return {
      today: this.today,
      opacity,
      alwaysOnTop,
      events: collectEvents(this.getNotes(), Number(this.today.slice(0, 4))),
    };
  }

  open() {
    if (this.win || !this.enabled) return;
    const state = this._state();
    const bounds = this._bounds(state);
    const win = new BrowserWindow({
      ...bounds,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      title: 'memoSync 달력',
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      skipTaskbar: true,
      resizable: true,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      alwaysOnTop: state.alwaysOnTop,
      show: false,
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    this.win = win;
    this.allowClose = false;
    lockNavigation(win);
    if (!sameBounds(win.getBounds(), bounds)) win.setBounds(bounds);
    this.applied = win.getBounds();

    win.once('ready-to-show', () => {
      if (!this.hiddenAll) win.showInactive();
    });
    const onBounds = () => {
      clearTimeout(this.boundsTimer);
      this.boundsTimer = setTimeout(() => this.commitBounds(), BOUNDS_DEBOUNCE_MS);
    };
    win.on('move', onBounds);
    win.on('resize', onBounds);
    // Alt+F4로 닫으면 끈 것으로 처리한다. 트레이의 "달력 표시"로 다시 켤 수 있다.
    win.on('close', (event) => {
      if (this.allowClose) return;
      event.preventDefault();
      this.setEnabled(false);
    });
    win.on('closed', () => {
      clearTimeout(this.boundsTimer);
      this.boundsTimer = null;
      this.win = null;
    });
    win.loadFile(path.join(ROOT, 'renderer', 'calendar.html'));
  }

  _close() {
    if (!this.win) return;
    this.commitBounds();
    this.allowClose = true;
    this.win.destroy();
    this.win = null;
  }

  setEnabled(value) {
    this._save({ enabled: value });
    if (value) this.open();
    else this._close();
    this.onEnabledChanged();
  }

  commitBounds() {
    clearTimeout(this.boundsTimer);
    this.boundsTimer = null;
    if (!this.win || this.win.isDestroyed()) return;
    const bounds = this.win.getBounds();
    // 화면 보정으로 옮긴 경우는 저장하지 않아 모니터가 다시 연결되면 원래 자리로 돌아간다.
    if (sameBounds(bounds, this.applied)) return;
    this.applied = bounds;
    this._save(bounds);
  }

  refit() {
    if (!this.win || this.resizeStart || !sameBounds(this.win.getBounds(), this.applied)) return;
    const bounds = this._bounds(this._state());
    if (sameBounds(this.win.getBounds(), bounds)) return;
    this.applied = bounds;
    this.win.setBounds(bounds);
    this.applied = this.win.getBounds();
  }

  setAllHidden(hidden) {
    this.hiddenAll = hidden;
    if (!this.win) return;
    if (hidden) this.win.hide();
    else if (!this.win.webContents.isLoading() && !this.win.isVisible()) this.win.showInactive();
  }

  // 메모가 바뀔 때마다 호출된다. 여러 메모가 한꺼번에 바뀌어도 한 번만 보낸다.
  scheduleRefresh() {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  refresh() {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('calendar:state', this.view());
  }

  setOpacity(value) {
    this._save({ opacity: clampOpacity(value) });
  }

  toggleAlwaysOnTop() {
    const value = !this._state().alwaysOnTop;
    this._save({ alwaysOnTop: value });
    if (this.win) this.win.setAlwaysOnTop(value);
    this.refresh();
  }

  beginResize() {
    if (this.win) this.resizeStart = this.win.getBounds();
  }

  resize(edge, dx, dy) {
    if (!this.win || !this.resizeStart) return;
    const next = resizeBounds(this.resizeStart, edge, dx, dy);
    // 왼쪽·위쪽으로 줄일 때 반대쪽 변이 고정되도록 달력 최소 크기를 다시 적용한다.
    const width = Math.max(MIN_WIDTH, next.width);
    const height = Math.max(MIN_HEIGHT, next.height);
    this.win.setBounds({
      x: edge.includes('w') ? this.resizeStart.x + this.resizeStart.width - width : next.x,
      y: edge.includes('n') ? this.resizeStart.y + this.resizeStart.height - height : next.y,
      width,
      height,
    });
  }

  endResize() {
    this.resizeStart = null;
  }

  destroy() {
    clearInterval(this.dateTimer);
    clearTimeout(this.refreshTimer);
    this._close();
  }
}

module.exports = { CalendarWindow };
