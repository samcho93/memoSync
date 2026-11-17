'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readPdfText } = require('../main/pdfText');
const { findPersonSchedules, scheduleMemo } = require('../main/pdfSchedule');
const { parseSchedules } = require('../main/schedule');

// 시험 PDF는 scripts/make-test-pdfs.js로 만든다.
const fixture = (name) => readPdfText(path.join(__dirname, 'fixtures', name));
const find = (pages, person) => findPersonSchedules(pages, person, 2026);
const brief = (result) => result.events.map((event) => `${event.date} ${event.title}`);

test('달력형: 칸의 날짜와 이름이 든 줄을 찾고, 다음 달 칸과 띄어 쓴 이름도 읽는다', async () => {
  const pages = await fixture('month-grid.pdf');
  const result = find(pages, '홍길동');
  assert.deepEqual(result.layouts, [{ page: 1, layout: 'grid', month: '2026-11' }]);
  assert.deepEqual(brief(result), [
    '2026-11-03 주간: 홍길동',
    '2026-11-10 야간: 홍 길 동',
    '2026-11-17 교육 홍길동 외 2명',
    '2026-12-01 주간: 홍길동',
  ]);
  assert.deepEqual(brief(find(pages, '이영희')), ['2026-11-05 주간: 김철수, 이영희', '2026-11-27 주간: 이영희']);
});

test('달력형: 요일 머리글 없이 날짜가 칸 오른쪽에 있고 마지막 주에 하루만 있어도 읽는다', async () => {
  const pages = await fixture('month-grid-right.pdf');
  const result = find(pages, '홍길동');
  assert.deepEqual(result.layouts, [{ page: 1, layout: 'grid', month: '2027-02' }]);
  assert.deepEqual(brief(result), ['2027-02-07 홍길동 당직', '2027-02-15 홍길동', '2027-02-28 홍길동 반차']);
  assert.deepEqual(brief(find(pages, '김철수')), ['2027-02-14 김철수 당직']);
});

test('근무표형: 이름 행에서 날짜 열마다 근무 기호를 읽는다', async () => {
  const pages = await fixture('roster.pdf');
  const result = find(pages, '홍길동');
  assert.deepEqual(result.layouts, [{ page: 1, layout: 'roster', month: '2026-12' }]);
  assert.deepEqual(brief(result), [
    '2026-12-01 홍길동 D', '2026-12-02 홍길동 D', '2026-12-07 홍길동 N',
    '2026-12-08 홍길동 N', '2026-12-15 홍길동 연', '2026-12-31 홍길동 E',
  ]);
  assert.deepEqual(brief(find(pages, '이영희')), ['2026-12-02 이영희 E', '2026-12-09 이영희 D']);
});

test('목록형: 날짜가 있는 줄과 날짜 제목 아래 항목을 읽고, 연도는 문서 머리의 연도를 쓴다', async () => {
  const pages = await fixture('list.pdf');
  assert.deepEqual(brief(find(pages, '홍길동')), ['2027-01-06 홍길동 출장 (부산)', '2027-01-12 오후 외근: 홍길동, 김철수']);
  assert.deepEqual(brief(find(pages, '김철수')), ['2027-01-08 김철수 휴가', '2027-01-12 오후 외근: 홍길동, 김철수']);
  assert.deepEqual(brief(find(pages, '이영희')), ['2027-01-12 오전 회의: 이영희', '2027-01-13 신규 교육: 이영희']);
});

test('주간 시간표형: 날짜 열과 교시 행에서 담당 교시를 찾아 하루 일정 하나로 묶는다', async () => {
  const pages = await fixture('timetable.pdf');
  const result = find(pages, '홍길동');
  assert.deepEqual(result.layouts.map((entry) => entry.layout), ['timetable', 'timetable', 'timetable']);
  assert.deepEqual(brief(result), [
    '2026-11-18 1~5교시 종합실습 · 6~7교시 AI응용실습',
    // 칸 너비를 넘겨 두 줄로 나뉜 과목명을 잇는다.
    '2026-11-23 1~7교시 웹프론트엔드프로그래밍',
    // 다음 쪽으로 이어진 9교시도 같은 날 일정에 합친다. 칸 높이가 짧아도 교시를 맞게 잡는다.
    '2026-11-24 1~7교시 엣지컴퓨팅 · 9교시 보충수업',
  ]);
});

test('주간 시간표형: 쪽마다 있는 바닥글의 이름과 날짜는 일정으로 읽지 않는다', async () => {
  const pages = await fixture('timetable.pdf');
  assert.ok(pages[0].items.some((item) => item.str.includes('홍길동 2026-11-17')));
  assert.ok(!find(pages, '홍길동').events.some((event) => event.date === '2026-11-17'));
  assert.deepEqual(brief(find(pages, '김철수')), [
    '2026-11-16 1~7교시 프로젝트실습', '2026-11-17 1~7교시 프로젝트실습',
    '2026-11-19 1~7교시 프로젝트실습', '2026-11-20 1~7교시 프로젝트실습',
  ]);
});

test('없는 사람은 빈 목록이고 이름의 띄어쓰기는 무시한다', async () => {
  const pages = await fixture('month-grid.pdf');
  assert.deepEqual(find(pages, '박민수').events, []);
  assert.equal(find(pages, ' 홍 길동 ').events.length, 4);
});

test('글자마다 조각이 나뉜 목록도 한 줄로 붙여 읽는다', () => {
  const chars = (text, x, y) => [...text].map((ch, i) => ({ str: ch, x: x + i * 10, y, w: 9.5, size: 10 }));
  const pages = [{ items: [...chars('3월 5일 홍길동 출장', 50, 100), ...chars('3월 6일 김철수 휴가', 50, 120)] }];
  assert.deepEqual(brief(find(pages, '홍길동')), ['2026-03-05 홍길동 출장']);
});

test('글자가 없는 쪽(스캔한 PDF)은 empty로 알린다', () => {
  const result = find([{ items: [] }], '홍길동');
  assert.deepEqual(result.layouts, [{ page: 1, layout: 'empty', month: null }]);
  assert.deepEqual(result.events, []);
});

test('연월을 찾지 못한 달력은 건너뛰고 month를 null로 알린다', async () => {
  const pages = await fixture('month-grid.pdf');
  const withoutTitle = pages.map((page) => ({ ...page, items: page.items.filter((item) => !item.str.includes('년')) }));
  const result = find(withoutTitle, '홍길동');
  assert.deepEqual(result.layouts, [{ page: 1, layout: 'grid', month: null }]);
  assert.deepEqual(result.events, []);
});

test('가져온 일정 메모는 연도를 적고, 다시 읽으면 같은 일정이 된다', () => {
  const events = [{ date: '2026-12-01', title: '홍길동 D' }, { date: '2027-01-06', title: '홍길동 출장 (부산)' }];
  const memo = scheduleMemo('홍길동', '근무표.pdf', events);
  assert.equal(memo, '홍길동 일정 (근무표.pdf)\n2026년 12월 1일 홍길동 D\n2027년 1월 6일 홍길동 출장 (부산)');
  assert.deepEqual(parseSchedules(memo, 2030), events);
});

test('파일 이름에 날짜가 있으면 제목 줄이 일정으로 읽히지 않게 뺀다', () => {
  const memo = scheduleMemo('홍길동', '11월 5일 행사.pdf', [{ date: '2026-11-05', title: '홍길동 진행' }]);
  assert.equal(memo.split('\n')[0], '홍길동 일정 (PDF)');
  assert.equal(parseSchedules(memo, 2026).length, 1);
});
