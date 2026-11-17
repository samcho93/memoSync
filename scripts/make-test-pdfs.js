'use strict';

// 일정 PDF 가져오기 테스트에 쓰는 PDF를 만든다. 실행: npx electron scripts/make-test-pdfs.js
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const OUT = path.join(__dirname, '..', 'test', 'fixtures');
const STYLE = `<style>
  body { font-family: "Malgun Gothic", sans-serif; margin: 24px; }
  table { border-collapse: collapse; width: 100%; table-layout: fixed; }
  td, th { border: 1px solid #555; vertical-align: top; padding: 3px; font-size: 11px; }
  .grid td { height: 82px; }
  .roster td, .roster th { text-align: center; padding: 2px 0; font-size: 10px; }
  .roster td:first-child, .roster th:first-child { width: 56px; }
</style>`;

// 2026년 11월 달력형: 칸마다 날짜와 그날 근무자. 앞뒤로 10월·12월 날짜가 회색으로 들어간다.
function monthGrid() {
  const duties = {
    3: ['주간: 홍길동', '야간: 김철수'],
    5: ['주간: 김철수, 이영희'],
    10: ['야간: 홍 길 동'],
    17: ['교육 홍길동 외 2명'],
    27: ['주간: 이영희'],
  };
  const first = new Date(2026, 10, 1).getDay();
  const cells = [];
  for (let i = 0; i < 35; i += 1) {
    const date = new Date(2026, 10, 1 - first + i);
    const inMonth = date.getMonth() === 10;
    const lines = inMonth ? duties[date.getDate()] || [] : [];
    const extra = !inMonth && date.getDate() === 1 ? ['주간: 홍길동'] : [];
    cells.push(`<td style="${inMonth ? '' : 'color:#aaa'}"><b>${date.getDate()}</b>${[...lines, ...extra].map((l) => `<div>${l}</div>`).join('')}</td>`);
  }
  const rows = [];
  for (let r = 0; r < 5; r += 1) rows.push(`<tr>${cells.slice(r * 7, r * 7 + 7).join('')}</tr>`);
  return `${STYLE}<h2>2026년 11월 근무 일정</h2>
    <table class="grid"><tr>${'일월화수목금토'.split('').map((d) => `<th>${d}</th>`).join('')}</tr>${rows.join('')}</table>`;
}

// 2027년 2월 달력형 변형: 요일 머리글이 없고 날짜 숫자가 칸 오른쪽에 붙으며 다른 달 칸은 비어 있다.
function monthGridRight() {
  const duties = { 7: ['홍길동 당직'], 14: ['김철수 당직'], 15: ['• 홍길동', '• 이영희'], 28: ['홍길동 반차'] };
  const first = new Date(2027, 1, 1).getDay();
  const cells = [];
  for (let i = 0; i < 35; i += 1) {
    const date = new Date(2027, 1, 1 - first + i);
    const inMonth = date.getMonth() === 1;
    const lines = inMonth ? duties[date.getDate()] || [] : [];
    cells.push(inMonth
      ? `<td><div style="text-align:right">${date.getDate()}</div>${lines.map((l) => `<div>${l}</div>`).join('')}</td>`
      : '<td></td>');
  }
  const rows = [];
  for (let r = 0; r < 5; r += 1) rows.push(`<tr>${cells.slice(r * 7, r * 7 + 7).join('')}</tr>`);
  return `${STYLE}<h2>2027.02 일정표</h2><table class="grid">${rows.join('')}</table>`;
}

// 주간 시간표형: 요일·날짜 머리행, 왼쪽 교시, 칸마다 과목·강의실·담당자. 내용 없는 교시는 행이 낮다.
// 둘째 주는 두 쪽에 걸쳐 9교시가 다음 쪽에 있고, 바닥글에는 출력한 사람 이름과 날짜가 있다.
function timetable() {
  const week = (start, cells, periods) => {
    const dates = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    });
    const head = `<tr><th>요일</th>${'일월화수목금토'.split('').map((d) => `<th>${d}</th>`).join('')}</tr>
      <tr><th>교시</th>${dates.map((d) => `<th>(${d})</th>`).join('')}</tr>`;
    const rows = periods.map((p) => `<tr><td class="period">${p}교시</td>${dates.map((_, i) => {
      const cell = cells(i, p);
      return cell ? `<td>${cell.map((line) => `<div>${line}</div>`).join('')}</td>` : '<td></td>';
    }).join('')}</tr>`).join('');
    return `<h2>2026학년도 학과별 주차 시간표</h2><table class="timetable">${head}${rows}</table>
      <p class="footer">교무과 홍길동 2026-11-17 14:46:28</p>`;
  };
  const lesson = (subject, teacher) => [subject, '본관(', '실습실', '1(301호))(301)', teacher];
  const first = week(new Date(2026, 10, 15), (day, p) => {
    if (day === 0 || day === 6 || p > 7) return null;
    if (day === 3) return lesson(p <= 5 ? '종합실습' : 'AI응용실습', '홍길동');
    return lesson('프로젝트실습', '김철수');
  }, [1, 2, 3, 4, 5, 6, 7, 8]);
  const second = week(new Date(2026, 10, 22), (day, p) => {
    if (day < 1 || day > 2 || p > 7) return null;
    return lesson(day === 1 ? '웹프론트엔드프로그래밍' : '엣지컴퓨팅', '홍길동');
  }, [1, 2, 3, 4, 5, 6, 7, 8]);
  const secondRest = week(new Date(2026, 10, 22), (day, p) => (day === 2 && p === 9 ? ['보충수업', '홍길동'] : null), [9, 10]);
  const pageBreak = '<div style="break-after: page"></div>';
  return `${STYLE}<style>
    .timetable td, .timetable th { font-size: 8px; padding: 2px 4px; }
    .timetable .period { width: 40px; vertical-align: middle; }
    .timetable th:first-child { width: 40px; }
    .footer { position: fixed; bottom: 0; right: 0; font-size: 8px; }
  </style>${first}${pageBreak}${second}${pageBreak}${secondRest}`;
}

// 2026년 12월 근무표형: 사람이 행, 날짜가 열이고 칸에 근무 기호가 있다.
function roster() {
  const people = {
    홍길동: { 1: 'D', 2: 'D', 7: 'N', 8: 'N', 15: '연', 31: 'E' },
    김철수: { 1: 'N', 3: 'D', 20: 'E' },
    이영희: { 2: 'E', 9: 'D' },
  };
  const days = Array.from({ length: 31 }, (_, i) => i + 1);
  const head = `<tr><th>이름</th>${days.map((d) => `<th>${d}</th>`).join('')}</tr>`;
  const body = Object.entries(people).map(([name, shifts]) => `<tr><td>${name}</td>${days.map((d) => `<td>${shifts[d] || ''}</td>`).join('')}</tr>`).join('');
  return `${STYLE}<h2>2026년 12월 근무표</h2><p>D: 주간, E: 저녁, N: 야간, 연: 연차</p><table class="roster">${head}${body}</table>`;
}

// 목록형: 날짜가 적힌 줄과, 날짜 제목 아래의 항목 줄이 섞여 있다.
function list() {
  return `${STYLE}<h2>2027년 1월 행사 안내</h2>
    <p>2027년 1월 4일 (월) 시무식 - 전 직원</p>
    <p>1월 6일 홍길동 출장 (부산)</p>
    <p>1/8 김철수 휴가</p>
    <h3>1월 12일 (화)</h3>
    <p>• 오전 회의: 이영희</p>
    <p>• 오후 외근: 홍길동, 김철수</p>
    <h3>1월 13일 (수)</h3>
    <p>• 신규 교육: 이영희</p>`;
}

// 창 하나를 다시 쓴다. 창을 닫고 새로 만들면 다음 loadFile이 ERR_FAILED로 실패한다.
async function save(win, name, html, landscape) {
  const page = path.join(app.getPath('temp'), `memosync-${name}.html`);
  fs.writeFileSync(page, `<!doctype html><meta charset="utf-8">${html}`);
  await win.loadFile(page);
  const pdf = await win.webContents.printToPDF({ landscape, pageSize: 'A4', printBackground: true });
  fs.writeFileSync(path.join(OUT, name), pdf);
  fs.rmSync(page, { force: true });
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({ show: false });
  await save(win, 'month-grid.pdf', monthGrid(), true);
  await save(win, 'month-grid-right.pdf', monthGridRight(), true);
  await save(win, 'roster.pdf', roster(), true);
  await save(win, 'list.pdf', list(), false);
  await save(win, 'timetable.pdf', timetable(), false);
  win.destroy();
  app.quit();
});
