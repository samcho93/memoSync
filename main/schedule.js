'use strict';

const MAX_TITLE_LENGTH = 80;
const DEFAULT_TITLE = '일정';

// 위쪽 형식부터 먼저 찾는다. 연도가 있는 형식이 앞서야 "2026년 11월 5일"이 월일 형식으로 잡히지 않는다.
// 숫자만 있는 월일(11/5, 11.5, 11-5)은 "버전 1.5" 같은 오인식을 막기 위해 줄 맨 앞에서만 인정한다.
const FORMATS = [
  { re: /(?<!\d)(\d{4}|\d{2})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/, year: 1, month: 2, day: 3 },
  { re: /(?<![\d.])(\d{4})\s*([-./])\s*(\d{1,2})\s*\2\s*(\d{1,2})(?!\d)\.?/, year: 1, month: 3, day: 4 },
  { re: /(?<!\d)(\d{1,2})\s*월\s*(\d{1,2})\s*일/, month: 1, day: 2 },
  { re: /^(\s*(?:[-*•·▶□☐■]\s*)?)(\d{1,2})[-./](\d{1,2})일?\.?(?=[\s,:(]|$)/, prefix: 1, month: 2, day: 3 },
];

// 충돌 병합 구분선(--- ... ---)에도 날짜가 들어 있으므로 일정으로 읽지 않는다.
const SEPARATOR_RE = /^\s*---/;
const LEADING_BULLET_RE = /^[\s\-*•·▶□☐■,:;~–]+/;
const TRAILING_PUNCT_RE = /[\s,:;~–-]+$/;
const WEEKDAY_RE = /^\s*(?:\([월화수목금토일](?:요일)?\)|[월화수목금토일]요일)/;

function toDateKey(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  // 2월 30일처럼 없는 날짜는 Date가 다음 달로 넘기므로 되돌려 비교해 걸러낸다.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function localDateKey(now = new Date()) {
  return toDateKey(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

function cleanTitle(before, after, fallback = DEFAULT_TITLE) {
  const rest = after.replace(WEEKDAY_RE, '');
  const title = `${before} ${rest}`
    .replace(LEADING_BULLET_RE, '')
    .replace(TRAILING_PUNCT_RE, '')
    .replace(/\s+/g, ' ');
  return (title || fallback).slice(0, MAX_TITLE_LENGTH);
}

// 한 줄에서 첫 날짜와 그 앞뒤 글자를 찾는다. 날짜가 없거나 없는 날짜면 null
function findDate(line, currentYear) {
  if (SEPARATOR_RE.test(line)) return null;
  for (const format of FORMATS) {
    const match = format.re.exec(line);
    if (!match) continue;
    let year = format.year ? Number(match[format.year]) : currentYear;
    if (format.year && match[format.year].length === 2) year += 2000;
    const date = toDateKey(year, Number(match[format.month]), Number(match[format.day]));
    if (!date) return null;
    return { date, before: line.slice(0, match.index), after: line.slice(match.index + match[0].length) };
  }
  return null;
}

// 날짜를 빼고 남은 글자. 요일·글머리표만 있으면 빈 문자열
function restOf(found) {
  return cleanTitle(found.before, found.after, '');
}

// 한 줄에서 일정 하나를 읽는다. 날짜가 없거나 없는 날짜면 null
function parseLine(line, currentYear) {
  const found = findDate(line, currentYear);
  return found && { date: found.date, title: cleanTitle(found.before, found.after) };
}

function parseSchedules(text, currentYear) {
  return text.split(/\r?\n/).map((line) => parseLine(line, currentYear)).filter(Boolean);
}

// 메모 순서(만든 순)와 줄 순서를 유지한 일정 목록을 돌려준다.
function collectEvents(notes, currentYear) {
  const sorted = [...notes].sort((a, b) => a.createdAt - b.createdAt);
  return sorted.flatMap((note) => parseSchedules(note.content, currentYear).map((schedule) => ({
    ...schedule,
    noteId: note.id,
    color: note.color,
  })));
}

// PDF 가져오기로 만든 메모의 첫 줄("홍길동 일정 (근무표.pdf)")
const IMPORT_HEADER_RE = /^\S.* 일정 \(.+\)$/;

/**
 * 오늘보다 앞선 날짜의 일정 줄을 지운다. 일정이 아닌 줄은 그대로 둔다.
 * @returns {{ content: string, removed: number, empty: boolean }} empty: 남은 글이 없거나 PDF 가져오기 제목 줄뿐이다.
 */
function removePastSchedules(content, today) {
  const currentYear = Number(today.slice(0, 4));
  const lines = content.split(/(?<=\n)/);
  const kept = lines.filter((line) => {
    const schedule = parseLine(line.replace(/\r?\n$/, ''), currentYear);
    return !schedule || schedule.date >= today;
  });
  const removed = lines.length - kept.length;
  let next = kept.join('');
  // 마지막 줄을 지워 끝에 줄바꿈만 남으면 원래처럼 줄바꿈 없이 끝낸다.
  if (removed && !/\n$/.test(content)) next = next.replace(/\r?\n$/, '');
  const rest = next.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return {
    content: next,
    removed,
    empty: removed > 0 && (rest.length === 0 || (rest.length === 1 && IMPORT_HEADER_RE.test(rest[0]))),
  };
}

module.exports = { findDate, restOf, toDateKey, parseLine, parseSchedules, collectEvents, localDateKey, removePastSchedules };
