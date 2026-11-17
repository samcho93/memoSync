'use strict';

const { findDate, restOf, toDateKey } = require('./schedule');

// PDF에서 읽은 글자 조각(readPdfText 결과)으로 특정인의 일정을 찾는다. 세 가지 꼴을 쪽마다 알아본다.
// - 근무표형: 한 줄에 날짜 1~31이 늘어선 머리행이 있고, 아래 행마다 이름과 날짜 칸별 근무가 있다.
// - 달력형: 칸마다 날짜 숫자와 그날 일정이 있는 월간 달력
// - 목록형: "3월 5일 홍길동 출장"처럼 줄마다 날짜가 있거나, 날짜 제목 줄 아래에 항목이 이어진다.

const DAY_RE = /^(\d{1,2})\s*일?\s*(?:\([월화수목금토일]\))?$/;
const WEEKDAY_RE = /^(?:([일월화수목금토])(?:요일)?|(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?)$/i;
const YEAR_MONTH_RES = [
  /(\d{4})\s*년\s*(\d{1,2})\s*월/,
  /(?<![\d.])(\d{4})\s*[.\-/]\s*(\d{1,2})(?!\d)/,
];
const MONTH_RE = /(?<!\d)(\d{1,2})\s*월(?!\s*\d{1,2}\s*일)/;
const MIN_ROSTER_DAYS = 20;
const MIN_GRID_DAYS = 20;
const MIN_GRID_WEEKS = 4;
const MAX_TITLE_LENGTH = 80;

const squash = (text) => text.replace(/\s+/g, '');
const center = (item) => item.x + item.w / 2;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function dayOf(item) {
  const match = DAY_RE.exec(item.str.trim());
  const day = match ? Number(match[1]) : 0;
  return day >= 1 && day <= 31 ? day : null;
}

// 기준선이 거의 같은 조각을 한 줄로 묶는다. 줄은 위에서 아래로, 줄 안은 왼쪽부터
function groupLines(items) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const item of sorted) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(item.y - line.y) <= Math.max(line.size, item.size) * 0.4) line.items.push(item);
    else lines.push({ y: item.y, size: item.size, items: [item] });
  }
  for (const line of lines) line.items.sort((a, b) => a.x - b.x);
  return lines;
}

// 조각 사이가 떨어져 있으면 띄어 쓴다. 글자마다 조각이 나뉜 PDF도 붙여서 읽는다.
function joinText(items) {
  let text = '';
  let end = null;
  for (const item of items) {
    if (end !== null && item.x - end > item.size * 0.25) text += ' ';
    text += item.str;
    end = item.x + item.w;
  }
  return text.replace(/\s+/g, ' ').trim();
}

function addMonths({ year, month }, delta) {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

// 쪽 위쪽부터 "2026년 11월", "2026.11", "11월"을 찾아 그 쪽의 연월로 쓴다.
function findMonth(lines, fallbackYear) {
  for (const line of lines) {
    for (const re of YEAR_MONTH_RES) {
      const match = re.exec(line);
      if (match && Number(match[2]) >= 1 && Number(match[2]) <= 12) return { year: Number(match[1]), month: Number(match[2]) };
    }
  }
  for (const line of lines) {
    const match = MONTH_RE.exec(line);
    if (match && Number(match[1]) >= 1 && Number(match[1]) <= 12) return { year: fallbackYear, month: Number(match[1]) };
  }
  return null;
}

// 날짜 숫자가 앞 숫자보다 작아지면 다음 달로 넘어간 것으로 본다.
function withMonthOffsets(days, startOffset) {
  let offset = startOffset;
  return days.map((entry, index) => {
    if (index > 0 && entry.day < days[index - 1].day) offset += 1;
    return { ...entry, offset };
  });
}

function dateIn(month, offset, day) {
  const { year, month: m } = addMonths(month, offset);
  return toDateKey(year, m, day);
}

function cleanTitle(text) {
  return text.replace(/^[\s\-*•·▶□☐■,:;~–]+/, '').replace(/[\s,:;~–-]+$/, '').replace(/\s+/g, ' ').slice(0, MAX_TITLE_LENGTH);
}

// ---- 주간 시간표형 ----
// 머리행에 "(2026-11-16)"처럼 열마다 날짜가 있고 왼쪽에 "1교시" 같은 행 이름이 있다. 칸에는 과목·강의실·담당자가 여러 줄로 있다.

const PERIOD_RE = /^(\d{1,2})교시$/;

function findTimetable(lines, year) {
  for (let index = 0; index < lines.length; index += 1) {
    const dated = lines[index].items
      .map((item) => ({ item, found: findDate(item.str, year) }))
      .filter((entry) => entry.found);
    if (dated.length < 3) continue;
    const columns = dated.map(({ item, found }) => ({ date: found.date, x: center(item) }));
    if (columns.some((col, i) => i > 0 && col.date <= columns[i - 1].date)) continue;
    const pitch = median(columns.slice(1).map((col, i) => col.x - columns[i].x));
    if (pitch > 0) return { index, columns, pitch };
  }
  return null;
}

function timetableEntries(lines, table, name) {
  const { columns, pitch } = table;
  const left = columns[0].x - pitch / 2;
  // 바닥글처럼 여러 열에 걸친 긴 글은 칸 내용이 아니다.
  const body = lines.slice(table.index + 1).flatMap((line) => line.items).filter((item) => item.w <= pitch * 1.5);
  const leftItems = body.filter((item) => center(item) < left).sort((a, b) => a.y - b.y);
  // "1교시"처럼 번호가 있는 행 이름이 있으면 그것만 쓴다. 머리글의 "교시" 같은 글은 행이 아니다.
  const periods = leftItems.filter((item) => PERIOD_RE.test(squash(item.str)));
  const labels = periods.length ? periods : leftItems;
  const gap = labels.length > 1 ? median(labels.slice(1).map((label, i) => label.y - labels[i].y)) : Infinity;
  // 마지막 행보다 한참 아래(쪽 번호 등)는 칸 내용이 아니다.
  const bottom = labels.length ? labels[labels.length - 1].y + gap : Infinity;
  const cells = body.filter((item) => center(item) >= left && item.y <= bottom);

  // 교시 경계는 모든 열의 줄을 합쳐 한 번에 정한다. 내용이 가장 긴 칸이 행 높이를 정하고, 짧은 칸은 그 안에 있다.
  const rowOf = new Map();
  if (labels.length) {
    splitRows(groupLines(cells), labels).forEach((block, row) => {
      for (const line of block) for (const item of line.items) rowOf.set(item, row);
    });
  }

  const entries = [];
  for (const col of columns) {
    const items = cells.filter((item) => Math.abs(center(item) - col.x) <= pitch / 2);
    const rows = labels.length ? labels.map((_, row) => items.filter((item) => rowOf.get(item) === row)) : [items];
    rows.forEach((rowItems, row) => {
      if (!rowItems.length) return;
      const block = groupLines(rowItems);
      const texts = block.map((line) => joinText(line.items));
      if (!squash(texts.join('')).includes(name)) return;
      entries.push({ date: col.date, label: labels.length ? labels[row].str.trim() : '', subject: subjectOf(block, texts, name, pitch) });
    });
  }
  return entries;
}

// 행 높이가 교시마다 달라 행 이름 사이의 가운데를 경계로 쓸 수 없다. 행 이름은 행의 세로 가운데에 있으므로
// 줄들을 위에서부터 행마다 이어지게 나누되, 덩어리 가운데와 행 이름 높이의 차이 합이 가장 작게 나눈다.
function splitRows(lines, labels) {
  const n = lines.length;
  const centers = labels.map((label) => label.y - label.size * 0.35);
  // 덩어리 가운데와 행 이름 높이의 차이. 다른 행 이름 높이를 넘는 덩어리는 만들지 않는다.
  const costOf = (from, to, row) => {
    const top = lines[from].y - lines[from].size;
    const bottom = lines[to - 1].y;
    if (centers.some((c, m) => m !== row && c > top && c < bottom)) return Infinity;
    return Math.abs((top + bottom) / 2 - centers[row]);
  };
  // best[k][i]: 앞의 i줄을 앞의 k행에 나눈 최소 비용
  const best = Array.from({ length: labels.length + 1 }, () => new Array(n + 1).fill(Infinity));
  const choice = Array.from({ length: labels.length + 1 }, () => new Array(n + 1).fill(0));
  best[0][0] = 0;
  for (let k = 1; k <= labels.length; k += 1) {
    for (let i = 0; i <= n; i += 1) {
      for (let j = 0; j <= i; j += 1) {
        if (best[k - 1][j] === Infinity) continue;
        const cost = best[k - 1][j] + (j === i ? 0 : costOf(j, i, k - 1));
        if (cost < best[k][i]) {
          best[k][i] = cost;
          choice[k][i] = j;
        }
      }
    }
  }
  const blocks = new Array(labels.length);
  let end = n;
  for (let k = labels.length; k >= 1; k -= 1) {
    const start = choice[k][end];
    blocks[k - 1] = lines.slice(start, end);
    end = start;
  }
  return blocks;
}

// 칸의 첫 줄(이름이 없는 줄)을 과목으로 본다. 칸 너비를 채워 줄이 바뀐 과목명("프론트엔드프로그" + "래밍")은 잇는다.
function subjectOf(block, texts, name, pitch) {
  const index = texts.findIndex((text) => !squash(text).includes(name));
  if (index < 0) return texts.join(' ');
  const line = block[index];
  const width = line.items[line.items.length - 1].x + line.items[line.items.length - 1].w - line.items[0].x;
  const next = texts[index + 1];
  const wrapped = next && width >= pitch - 8 - line.size && /^[가-힣A-Za-z0-9]{1,4}$/.test(next) && !squash(next).includes(name);
  return wrapped ? `${texts[index]}${next}` : texts[index];
}

// 같은 날 연속한 교시의 같은 과목은 "1~4교시 과목"으로 묶는다.
function timetableTitle(entries) {
  const period = (label) => {
    const match = PERIOD_RE.exec(squash(label));
    return match ? Number(match[1]) : null;
  };
  const sorted = [...entries].sort((a, b) => (period(a.label) ?? 99) - (period(b.label) ?? 99));
  const groups = [];
  for (const entry of sorted) {
    const n = period(entry.label);
    const last = groups[groups.length - 1];
    if (last && n !== null && last.to !== null && n === last.to + 1 && last.subject === entry.subject) last.to = n;
    else groups.push({ from: n, to: n, label: entry.label, subject: entry.subject });
  }
  return groups.map((group) => {
    if (group.from === null) return group.label ? `${group.label} ${group.subject}` : group.subject;
    const range = group.from === group.to ? `${group.from}교시` : `${group.from}~${group.to}교시`;
    return `${range} ${group.subject}`;
  }).join(' · ');
}

// ---- 근무표형 ----

function findRosterHeaders(lines) {
  const headers = [];
  lines.forEach((line, index) => {
    const days = line.items.map((item) => ({ item, day: dayOf(item) })).filter((entry) => entry.day);
    if (days.length < MIN_ROSTER_DAYS) return;
    let steps = 0;
    for (let i = 1; i < days.length; i += 1) {
      const prev = days[i - 1].day;
      if (days[i].day === prev + 1 || (days[i].day === 1 && prev >= 28)) steps += 1;
    }
    if (steps < (days.length - 1) * 0.8) return;
    const columns = withMonthOffsets(days, 0).map(({ item, day, offset }) => ({ day, offset, x: center(item) }));
    const pitch = median(columns.slice(1).map((col, i) => col.x - columns[i].x));
    headers.push({ index, columns, pitch });
  });
  return headers;
}

function rosterEvents(lines, headers, month, name) {
  const events = [];
  headers.forEach((header, h) => {
    const end = h + 1 < headers.length ? headers[h + 1].index : lines.length;
    const firstX = header.columns[0].x;
    for (const line of lines.slice(header.index + 1, end)) {
      const label = line.items.filter((item) => center(item) < firstX - header.pitch / 2);
      if (!squash(joinText(label)).includes(name)) continue;
      const cells = new Map();
      for (const item of line.items) {
        if (label.includes(item)) continue;
        let best = null;
        for (const col of header.columns) {
          const distance = Math.abs(center(item) - col.x);
          if (distance <= header.pitch * 0.6 && (!best || distance < best.distance)) best = { col, distance };
        }
        if (!best) continue;
        if (!cells.has(best.col)) cells.set(best.col, []);
        cells.get(best.col).push(item);
      }
      for (const [col, items] of cells) {
        const date = dateIn(month, col.offset, col.day);
        if (date) events.push({ date, title: cleanTitle(`${name} ${joinText(items)}`) });
      }
    }
  });
  return events;
}

// ---- 달력형 ----

function findGrid(lines) {
  const candidates = [];
  for (const line of lines) {
    const days = line.items.filter((item) => dayOf(item));
    if (days.length >= 1 && days.length <= 7 && days.length * 2 >= line.items.length) candidates.push({ line, days });
  }
  const full = candidates.filter((week) => week.days.length >= 3);
  if (full.length < MIN_GRID_WEEKS - 1) return null;
  // 날짜가 1~2개뿐인 첫 주·마지막 주는 다른 주와 같은 간격으로 붙어 있을 때만 넣는다. 쪽 번호 같은 숫자를 막는다.
  const step = median(full.slice(1).map((week, i) => week.line.y - full[i].line.y));
  const near = (week, y) => Math.abs(week.line.y - y) < step * 0.3;
  const before = candidates.find((week) => week.days.length < 3 && near(week, full[0].line.y - step));
  const after = candidates.find((week) => week.days.length < 3 && near(week, full[full.length - 1].line.y + step));
  const weeks = [...(before ? [before] : []), ...full, ...(after ? [after] : [])];
  const total = weeks.reduce((sum, week) => sum + week.days.length, 0);
  if (weeks.length < MIN_GRID_WEEKS || total < MIN_GRID_DAYS) return null;

  const firstWeek = lines.indexOf(weeks[0].line);
  // 요일 머리글이 있으면 그 가운데를 칸 가운데로 쓴다. 날짜 숫자는 칸 왼쪽·오른쪽 어디에나 붙을 수 있다.
  let columns = null;
  for (const line of lines.slice(0, firstWeek).reverse()) {
    const names = line.items.filter((item) => WEEKDAY_RE.test(item.str.trim()));
    if (names.length >= 5 && names.length * 2 >= line.items.length) {
      columns = names.map(center);
      break;
    }
  }
  const centers = weeks.flatMap((week) => week.days.map(center));
  const minX = Math.min(...centers);
  const pitch = columns && columns.length > 1
    ? (columns[columns.length - 1] - columns[0]) / (columns.length - 1)
    : (Math.max(...centers) - minX) / 6;
  if (!(pitch > 0)) return null;
  // 머리글이 없으면 달력 맨 왼쪽 글자를 첫 칸의 왼쪽 끝으로 본다.
  const left = columns
    ? columns[0] - pitch / 2
    : Math.min(...weeks.flatMap((week) => lines.slice(lines.indexOf(week.line)).flatMap((line) => line.items.map((item) => item.x))));
  return { weeks, left, pitch };
}

function gridEvents(lines, grid, month, name) {
  const { weeks, left, pitch } = grid;
  const column = (x) => Math.max(0, Math.min(6, Math.floor((x - left) / pitch)));
  const ordered = weeks.flatMap((week) => week.days
    .map((item) => ({ item, day: dayOf(item), col: column(center(item)), week }))
    .sort((a, b) => a.col - b.col));
  const cells = withMonthOffsets(ordered, ordered.length && ordered[0].day > 7 ? -1 : 0);
  const rowPitch = weeks.length > 1 ? median(weeks.slice(1).map((week, i) => week.line.y - weeks[i].line.y)) : Infinity;
  const tokens = new Set(cells.map((cell) => cell.item));

  const events = [];
  weeks.forEach((week, w) => {
    const top = week.line.y - week.line.size * 0.5;
    const bottom = w + 1 < weeks.length ? weeks[w + 1].line.y - weeks[w + 1].line.size * 0.5 : week.line.y + rowPitch;
    const inRow = lines.flatMap((line) => (line.y >= top && line.y < bottom ? line.items : [])).filter((item) => !tokens.has(item));
    for (const cell of cells.filter((c) => c.week === week)) {
      // 칸 안의 글은 대개 왼쪽 정렬이므로 조각의 왼쪽 끝(조금 안쪽)으로 칸을 정한다.
      const items = inRow.filter((item) => column(item.x + Math.min(item.w, pitch) * 0.1) === cell.col);
      if (!items.length) continue;
      const date = dateIn(month, cell.offset, cell.day);
      if (!date) continue;
      const cellLines = groupLines(items).map((line) => joinText(line.items));
      const matched = cellLines.filter((text) => squash(text).includes(name));
      if (matched.length) for (const text of matched) events.push({ date, title: cleanTitle(text) });
      else if (squash(cellLines.join('')).includes(name)) events.push({ date, title: cleanTitle(cellLines.join(' ')) });
    }
  });
  return events;
}

// ---- 목록형 ----

function listEvents(texts, year, name) {
  const events = [];
  let heading = null;
  for (const text of texts) {
    const found = findDate(text, year);
    if (found) {
      const rest = restOf(found);
      // "1월 12일 (화)"처럼 날짜뿐인 줄은 아래 항목들의 날짜가 된다.
      heading = rest ? null : found.date;
      if (rest && squash(text).includes(name)) events.push({ date: found.date, title: cleanTitle(rest) });
    } else if (heading && squash(text).includes(name)) {
      events.push({ date: heading, title: cleanTitle(text) });
    }
  }
  return events;
}

/**
 * @param {{ items: object[] }[]} pages readPdfText 결과
 * @param {string} person 찾을 이름. 띄어쓰기는 무시한다.
 * @param {number} currentYear 연도가 없는 "11월" 등에 쓸 연도
 */
function findPersonSchedules(pages, person, currentYear) {
  const name = squash(person);
  const events = [];
  const layouts = [];
  // 시간표는 한 주가 여러 쪽에 걸칠 수 있어 날짜별로 모았다가 마지막에 일정 하나로 만든다.
  const lessons = new Map();
  let month = null;
  pages.forEach((page, index) => {
    const lines = groupLines(page.items);
    const texts = lines.map((line) => joinText(line.items));
    month = findMonth(texts, currentYear) || month;
    const pageNo = index + 1;
    const add = (found) => events.push(...found.map((event) => ({ ...event, page: pageNo })));

    const table = findTimetable(lines, month ? month.year : currentYear);
    if (table) {
      layouts.push({ page: pageNo, layout: 'timetable', month: table.columns[0].date.slice(0, 7) });
      for (const entry of timetableEntries(lines, table, name)) {
        if (!lessons.has(entry.date)) lessons.set(entry.date, { page: pageNo, entries: [] });
        const day = lessons.get(entry.date);
        if (!day.entries.some((known) => known.label === entry.label && known.subject === entry.subject)) day.entries.push(entry);
      }
      return;
    }

    const headers = findRosterHeaders(lines);
    const grid = headers.length ? null : findGrid(lines);
    if (headers.length || grid) {
      const layout = headers.length ? 'roster' : 'grid';
      if (!month) {
        layouts.push({ page: pageNo, layout, month: null });
        return;
      }
      layouts.push({ page: pageNo, layout, month: `${month.year}-${String(month.month).padStart(2, '0')}` });
      add(headers.length ? rosterEvents(lines, headers, month, name) : gridEvents(lines, grid, month, name));
      return;
    }
    layouts.push({ page: pageNo, layout: page.items.length ? 'list' : 'empty', month: null });
    add(listEvents(texts, month ? month.year : currentYear, name));
  });

  for (const [date, day] of lessons) {
    events.push({ date, title: cleanTitle(timetableTitle(day.entries)), page: day.page });
  }

  const seen = new Set();
  const unique = events.filter((event) => {
    const key = `${event.date}\n${event.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => a.date.localeCompare(b.date) || a.page - b.page);
  return { events: unique, layouts };
}

// 가져온 일정을 메모 본문으로 만든다. 연도를 늘 적어 해가 바뀌어도 날짜가 그대로다.
function scheduleMemo(person, fileName, events) {
  const lines = events.map((event) => {
    const [year, month, day] = event.date.split('-').map(Number);
    return `${year}년 ${month}월 ${day}일 ${event.title}`;
  });
  const withFile = `${person.trim()} 일정 (${fileName})`;
  // 파일 이름에 날짜가 있으면 제목 줄도 일정으로 읽히므로 뺀다.
  const header = findDate(withFile, 2000) ? `${person.trim()} 일정 (PDF)` : withFile;
  return [header, ...lines].join('\n');
}

module.exports = { findPersonSchedules, scheduleMemo };
