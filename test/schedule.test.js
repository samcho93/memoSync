'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLine, parseSchedules, collectEvents, localDateKey } = require('../main/schedule');

const YEAR = 2026;
const parse = (line) => parseLine(line, YEAR);

test('년월일 형식', () => {
  for (const line of ['2027년 3월 5일 회의', '2027년3월5일 회의', '2027-03-05 회의', '2027.3.5 회의', '2027/3/5 회의', '2027. 3. 5. 회의', '27년 3월 5일 회의']) {
    assert.deepEqual(parse(line), { date: '2027-03-05', title: '회의' }, line);
  }
});

test('월일 형식은 올해로 반영한다', () => {
  for (const line of ['3월 5일 회의', '3월5일 회의', '3/5 회의', '3.5 회의', '3-5 회의', '03/05 회의', '3/5일 회의']) {
    assert.deepEqual(parse(line), { date: '2026-03-05', title: '회의' }, line);
  }
});

test('날짜가 줄 중간이나 끝에 있어도 읽는다 (한글·연도 포함 형식)', () => {
  assert.deepEqual(parse('치과 예약 3월 5일 15:00'), { date: '2026-03-05', title: '치과 예약 15:00' });
  assert.deepEqual(parse('마감: 2027-03-05'), { date: '2027-03-05', title: '마감' });
});

test('글머리표와 요일은 제목에서 뺀다', () => {
  assert.deepEqual(parse('- 3/5 회의'), { date: '2026-03-05', title: '회의' });
  assert.deepEqual(parse('• 3월 5일 회의'), { date: '2026-03-05', title: '회의' });
  assert.deepEqual(parse('3/5(목) 회의'), { date: '2026-03-05', title: '회의' });
  assert.deepEqual(parse('3월 5일 목요일 회의'), { date: '2026-03-05', title: '회의' });
  assert.deepEqual(parse('3/5: 회의'), { date: '2026-03-05', title: '회의' });
});

test('제목이 없으면 기본 제목을 쓴다', () => {
  assert.deepEqual(parse('3/5'), { date: '2026-03-05', title: '일정' });
  assert.deepEqual(parse('2027년 3월 5일'), { date: '2027-03-05', title: '일정' });
});

test('없는 날짜는 일정이 아니다', () => {
  for (const line of ['2월 30일 회의', '13월 1일 회의', '2/30 회의', '2026-02-30 회의', '0월 5일', '3월 0일', '2월 29일 회의']) {
    assert.equal(parse(line), null, line);
  }
  assert.deepEqual(parseLine('2월 29일 회의', 2028), { date: '2028-02-29', title: '회의' }, '윤년');
});

test('날짜가 아닌 숫자는 일정으로 읽지 않는다', () => {
  for (const line of [
    '오늘 할 일',
    '1. 첫 번째 항목',
    '1.5시간 작업',
    '2.5배 빨라짐',
    '버전 1.5 배포',
    'v1.2.2026.11.5',
    '가격 3/5 할인',
    '12345/6 번호',
    '26.11.5 메모',
    '010-1234-5678',
    '',
  ]) {
    assert.equal(parse(line), null, line);
  }
});

test('충돌 병합 구분선의 날짜는 일정이 아니다', () => {
  assert.equal(parse('--- 충돌 사본에서 병합됨 (2026-11-02 13:05 UTC) ---'), null);
});

test('여러 줄과 줄바꿈 형식', () => {
  const text = '장보기\r\n3/5 회의\r\n메모\n2027년 1월 2일 여행\n';
  assert.deepEqual(parseSchedules(text, YEAR), [
    { date: '2026-03-05', title: '회의' },
    { date: '2027-01-02', title: '여행' },
  ]);
});

test('일정 모음: 메모 색상과 id를 붙이고 만든 순서로 정렬한다', () => {
  const notes = [
    { id: 'b', content: '3/5 나중 메모', color: 'blue', createdAt: 20 },
    { id: 'a', content: '3/5 먼저 메모\n3/6 둘째 줄', color: 'pink', createdAt: 10 },
  ];
  assert.deepEqual(collectEvents(notes, YEAR), [
    { date: '2026-03-05', title: '먼저 메모', noteId: 'a', color: 'pink' },
    { date: '2026-03-06', title: '둘째 줄', noteId: 'a', color: 'pink' },
    { date: '2026-03-05', title: '나중 메모', noteId: 'b', color: 'blue' },
  ]);
});

test('오늘 날짜 키는 현지 시각 기준이다', () => {
  assert.equal(localDateKey(new Date(2026, 0, 9, 23, 59)), '2026-01-09');
});
