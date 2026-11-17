'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { removePastSchedules } = require('../main/schedule');
const { PastScheduleCleaner } = require('../main/pastSchedules');

const TODAY = '2026-11-17';

test('오늘보다 앞선 일정 줄만 지우고 오늘·앞으로의 일정과 일반 글은 남긴다', () => {
  const content = '할 일\n11월 16일 치과\n11월 17일 회의\n2026-11-18 출장\n2025년 12월 1일 작년 일\n메모 끝';
  assert.deepEqual(removePastSchedules(content, TODAY), {
    content: '할 일\n11월 17일 회의\n2026-11-18 출장\n메모 끝',
    removed: 2,
    empty: false,
  });
});

test('지울 일정이 없으면 그대로 두고, 충돌 병합 구분선은 일정이 아니다', () => {
  const content = '--- 2026-11-01 다른 PC ---\n11월 20일 회의';
  assert.deepEqual(removePastSchedules(content, TODAY), { content, removed: 0, empty: false });
});

test('마지막 줄을 지워도 끝에 빈 줄을 남기지 않고, CRLF도 처리한다', () => {
  assert.equal(removePastSchedules('메모\n11/1 지난 일', TODAY).content, '메모');
  assert.equal(removePastSchedules('메모\r\n11/1 지난 일\r\n끝\r\n', TODAY).content, '메모\r\n끝\r\n');
});

test('일정만 있던 메모나 PDF 가져오기 제목 줄만 남은 메모는 empty로 알린다', () => {
  assert.equal(removePastSchedules('11/1 지난 일\n\n11/2 또 지난 일\n', TODAY).empty, true);
  assert.equal(removePastSchedules('홍길동 일정 (시간표.pdf)\n2026년 11월 16일 1~7교시 실습', TODAY).empty, true);
  assert.equal(removePastSchedules('회의 메모\n11/1 지난 일', TODAY).empty, false);
  // 지운 것이 없으면 원래 비어 있던 메모라도 건드리지 않는다.
  assert.equal(removePastSchedules('', TODAY).empty, false);
});

function fakeApp({ notes, state = 'online', enabled = true, editing = [] }) {
  const log = [];
  const store = new Map(notes.map((note) => [note.id, { ...note }]));
  const app = {
    log,
    store,
    notes: {
      status: { state },
      active: () => [...store.values()],
      update: (id, patch) => { Object.assign(store.get(id), patch); log.push(['update', id]); },
      remove: (id) => { store.delete(id); log.push(['remove', id]); },
    },
    windows: { isEditing: (id) => editing.includes(id) },
    settings: { get: (key) => (key === 'removePastSchedules' ? enabled : undefined) },
    refreshNote: (id) => log.push(['refresh', id]),
  };
  app.cleaner = new PastScheduleCleaner({ ...app, today: () => app.today || TODAY });
  return app;
}

test('정리기: 지난 일정을 지우고 창을 갱신하며, 일정만 있던 메모는 지운다', () => {
  const app = fakeApp({ notes: [
    { id: 'a', content: '장보기\n11/1 지난 일' },
    { id: 'b', content: '11/2 지난 일' },
    { id: 'c', content: '11/30 다음 일' },
  ] });
  assert.equal(app.cleaner.check(), 2);
  assert.deepEqual(app.log, [['update', 'a'], ['refresh', 'a'], ['remove', 'b']]);
  assert.equal(app.store.get('a').content, '장보기');
  assert.equal(app.store.get('c').content, '11/30 다음 일');
  // 같은 날에는 다시 돌지 않는다.
  app.store.get('c').content = '11/3 새로 적은 지난 날짜';
  assert.equal(app.cleaner.check(), 0);
  // 날짜가 바뀌면 다시 정리한다.
  app.today = '2026-11-18';
  assert.equal(app.cleaner.check(), 1);
});

test('정리기: 동기화 폴더를 최신으로 읽기 전이나 설정을 끄면 아무것도 하지 않는다', () => {
  for (const options of [{ state: 'starting' }, { state: 'offline' }, { enabled: false }]) {
    const app = fakeApp({ notes: [{ id: 'a', content: '11/1 지난 일' }], ...options });
    assert.equal(app.cleaner.check(), 0, JSON.stringify(options));
    assert.deepEqual(app.log, []);
  }
});

test('정리기: 편집 중인 메모는 건너뛰고 다음 확인 때 다시 시도한다', () => {
  const app = fakeApp({ notes: [{ id: 'a', content: '메모\n11/1 지난 일' }], editing: ['a'] });
  assert.equal(app.cleaner.check(), 0);
  app.windows.isEditing = () => false;
  assert.equal(app.cleaner.check(), 1);
  assert.equal(app.store.get('a').content, '메모');
});
