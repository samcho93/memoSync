'use strict';

const path = require('node:path');
const { Menu, Tray, nativeImage } = require('electron');
const { ROOT } = require('./windows');

function statusLabel(status) {
  if (status.state === 'offline') {
    return status.pending > 0 ? `동기화 대기 중 (${status.pending}개)` : '동기화 폴더에 연결할 수 없음';
  }
  if (status.state === 'starting') return '동기화 준비 중';
  return '동기화 정상';
}

/** actions: newNote, showAll, hideAll, isCalendarEnabled, setCalendarEnabled, openSyncFolder, openSettings, isAutoStart, setAutoStart, quit, getStatus */
function buildTemplate(actions) {
  return [
    { label: '새 메모', click: () => actions.newNote() },
    { type: 'separator' },
    { label: '전체 표시', click: () => actions.showAll() },
    { label: '전체 숨기기', click: () => actions.hideAll() },
    {
      label: '달력 표시',
      type: 'checkbox',
      checked: actions.isCalendarEnabled(),
      click: (item) => actions.setCalendarEnabled(item.checked),
    },
    { type: 'separator' },
    { label: statusLabel(actions.getStatus()), enabled: false },
    { label: '동기화 폴더 열기', click: () => actions.openSyncFolder() },
    { label: '설정', click: () => actions.openSettings() },
    {
      label: '로그인 시 자동 시작',
      type: 'checkbox',
      checked: actions.isAutoStart(),
      click: (item) => actions.setAutoStart(item.checked),
    },
    { type: 'separator' },
    { label: '종료', click: () => actions.quit() },
  ];
}

class AppTray {
  constructor(actions) {
    this.actions = actions;
    this.tray = new Tray(nativeImage.createFromPath(path.join(ROOT, 'assets', 'tray.png')));
    this.tray.setToolTip('memoSync');
    this.tray.on('click', () => this.tray.popUpContextMenu());
    this.refresh();
  }

  // 체크 상태와 상태 문구가 바뀔 때마다 메뉴를 다시 만든다.
  refresh() {
    this.tray.setContextMenu(Menu.buildFromTemplate(buildTemplate(this.actions)));
    this.tray.setToolTip(`memoSync - ${statusLabel(this.actions.getStatus())}`);
  }
}

module.exports = { AppTray, buildTemplate };
