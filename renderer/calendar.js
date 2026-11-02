'use strict';

const CELLS = 42;
const DAY_HEIGHT = 22;
const CHIP_HEIGHT = 18;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

const api = window.memoCalendar;
const $ = (id) => document.getElementById(id);
const grid = $('grid');
const panel = $('panel');
const opacityInput = $('opacity');

let today = '';
let eventsByDate = new Map();
let viewYear = 0;
let viewMonth = 0;
let selected = null;
let opacityTimer = null;

const pad = (value) => String(value).padStart(2, '0');
const dateKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

function makeChip(event) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'chip';
  chip.dataset.color = event.color;
  chip.textContent = event.title;
  chip.title = `${event.title} (메모 열기)`;
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    api.openNote(event.noteId);
  });
  return chip;
}

function selectDay(key) {
  selected = selected === key ? null : key;
  render();
}

function makeCell(date, maxChips) {
  const key = dateKey(date);
  const cell = document.createElement('div');
  cell.className = 'cell';
  cell.dataset.date = key;
  cell.dataset.outside = String(date.getMonth() !== viewMonth);
  cell.dataset.selected = String(key === selected);
  cell.addEventListener('click', () => selectDay(key));

  const events = eventsByDate.get(key) || [];
  const day = document.createElement('button');
  day.type = 'button';
  day.className = 'day';
  if (date.getDay() === 0) day.classList.add('sun');
  if (date.getDay() === 6) day.classList.add('sat');
  day.dataset.today = String(key === today);
  day.textContent = String(date.getDate());
  day.setAttribute('aria-label', `${date.getMonth() + 1}월 ${date.getDate()}일 ${WEEKDAYS[date.getDay()]}요일, 일정 ${events.length}개`);
  cell.append(day);

  // 칸에 다 들어가지 않으면 마지막 줄을 "+개수"로 바꾼다.
  const visible = events.length > maxChips ? Math.max(0, maxChips - 1) : events.length;
  for (const event of events.slice(0, visible)) cell.append(makeChip(event));
  if (events.length > visible) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'more';
    more.textContent = `+${events.length - visible}`;
    more.title = `일정 ${events.length}개 모두 보기`;
    cell.append(more);
  }
  return cell;
}

function renderDayList() {
  const box = $('day-list');
  box.hidden = !selected;
  if (!selected) return;
  const [year, month, day] = selected.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(year, month - 1, day).getDay()];
  $('day-title').textContent = `${month}월 ${day}일 (${weekday})`;
  const list = $('day-events');
  list.replaceChildren();
  const events = eventsByDate.get(selected) || [];
  if (!events.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = '일정이 없습니다. 메모에 "' + month + '월 ' + day + '일 할 일"처럼 적으면 표시됩니다.';
    list.append(empty);
    return;
  }
  for (const event of events) {
    const item = document.createElement('li');
    item.append(makeChip(event));
    list.append(item);
  }
}

function render() {
  $('month-title').textContent = `${viewYear}년 ${viewMonth + 1}월`;
  // 날짜별 목록의 높이에 따라 칸 높이가 달라지므로 목록을 먼저 그린다.
  renderDayList();
  const cellHeight = (grid.clientHeight - 7) / 6;
  const maxChips = Math.max(1, Math.floor((cellHeight - DAY_HEIGHT - 2) / CHIP_HEIGHT));
  const first = new Date(viewYear, viewMonth, 1);
  const cells = [];
  for (let i = 0; i < CELLS; i += 1) {
    cells.push(makeCell(new Date(viewYear, viewMonth, 1 - first.getDay() + i), maxChips));
  }
  grid.replaceChildren(...cells);
}

function moveMonth(delta) {
  const date = new Date(viewYear, viewMonth + delta, 1);
  viewYear = date.getFullYear();
  viewMonth = date.getMonth();
  selected = null;
  render();
}

function goToday() {
  const [year, month] = today.split('-').map(Number);
  viewYear = year;
  viewMonth = month - 1;
  selected = null;
  render();
}

function showOpacity(opacity) {
  const transparency = Math.round((1 - opacity) * 100);
  document.documentElement.style.setProperty('--alpha', String(opacity));
  document.documentElement.style.setProperty('--outline-alpha', String(Math.min(1, (1 - opacity) * 2.5)));
  opacityInput.value = String(transparency);
  $('opacity-value').value = `${transparency}%`;
}

function showState(state) {
  if (!state) return;
  const first = !today;
  today = state.today;
  eventsByDate = new Map();
  for (const event of state.events) {
    if (!eventsByDate.has(event.date)) eventsByDate.set(event.date, []);
    eventsByDate.get(event.date).push(event);
  }
  if (!opacityTimer) showOpacity(state.opacity);
  $('btn-top').setAttribute('aria-pressed', String(state.alwaysOnTop));
  if (first) goToday();
  else render();
}

$('btn-prev').addEventListener('click', () => moveMonth(-1));
$('btn-next').addEventListener('click', () => moveMonth(1));
$('btn-today').addEventListener('click', goToday);
$('btn-top').addEventListener('click', () => api.toggleTop());
$('btn-hide').addEventListener('click', () => api.hide());
$('btn-style').addEventListener('click', () => {
  panel.hidden = !panel.hidden;
  $('btn-style').setAttribute('aria-expanded', String(!panel.hidden));
  render();
});

opacityInput.addEventListener('input', () => {
  const opacity = 1 - Number(opacityInput.value) / 100;
  showOpacity(opacity);
  clearTimeout(opacityTimer);
  opacityTimer = setTimeout(() => {
    opacityTimer = null;
    api.setOpacity(opacity);
  }, 300);
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (selected) selectDay(selected);
  else if (!panel.hidden) $('btn-style').click();
});

let resizeFrame = null;
new ResizeObserver(() => {
  if (!today || resizeFrame) return;
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = null;
    render();
  });
}).observe(document.querySelector('.calendar'));

attachResize(api);
api.onState(showState);
api.get().then(showState);
