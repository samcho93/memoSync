'use strict';

const api = window.memoSettings;
const $ = (id) => document.getElementById(id);

function statusText(status) {
  if (status.state === 'offline') {
    const detail = status.lastError ? ` (${status.lastError})` : '';
    return status.pending > 0
      ? `폴더에 연결할 수 없어 ${status.pending}개가 대기 중입니다. 연결되면 자동으로 올립니다.${detail}`
      : `폴더에 연결할 수 없습니다.${detail}`;
  }
  if (status.state === 'starting') return '동기화 준비 중입니다.';
  if (status.lastSyncAt) return `정상입니다. 마지막 확인: ${new Date(status.lastSyncAt).toLocaleTimeString('ko-KR')}`;
  return '정상입니다.';
}

function showStatus(status) {
  $('status').dataset.state = status.state;
  $('status').textContent = statusText(status);
}

function show(view) {
  $('folder').textContent = view.syncFolder;
  $('folder-note').textContent = view.isCustomFolder
    ? ''
    : '아직 이 PC 안의 기본 폴더를 쓰고 있어 다른 PC와 동기화되지 않습니다.';
  $('reset').disabled = !view.isCustomFolder;
  $('sync-position').checked = view.syncPosition;
  $('auto-start').checked = view.autoStart;
  $('device').textContent = view.deviceId;
  showStatus(view.status);
}

$('choose').addEventListener('click', async () => show(await api.chooseFolder()));
$('reset').addEventListener('click', async () => show(await api.resetFolder()));
$('open').addEventListener('click', () => api.openFolder());
$('sync-position').addEventListener('change', async (event) => show(await api.setSyncPosition(event.target.checked)));
$('auto-start').addEventListener('change', async (event) => show(await api.setAutoStart(event.target.checked)));

api.onStatus(showStatus);
api.get().then(show);
