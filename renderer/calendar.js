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
  if (!lastPerson) lastPerson = state.importPerson || '';
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

// ---- PDF에서 일정 가져오기 ----

const importBox = $('import');
const personInput = $('import-person');
const importStatus = $('import-status');
const importList = $('import-events');
const importAll = $('import-all');
const importAdd = $('import-add');
const MIN_PERSON_CHARS = 2;
const PERSON_DEBOUNCE_MS = 500;

let importPath = '';
let importResult = null;
let importSeq = 0;
let importBusy = false;
let personTimer = null;
let lastPerson = '';

function setImportStatus(text, kind = '') {
  importStatus.textContent = text;
  importStatus.dataset.kind = kind;
}

function checkedEvents() {
  if (!importResult) return [];
  return [...importList.querySelectorAll('input[type="checkbox"]')]
    .filter((box) => box.checked)
    .map((box) => importResult.events[Number(box.dataset.index)]);
}

function updateImportCount() {
  const total = importResult ? importResult.events.length : 0;
  const count = checkedEvents().length;
  $('import-count').textContent = `전체 ${total}개 중 ${count}개 선택`;
  importAll.checked = total > 0 && count === total;
  importAll.indeterminate = count > 0 && count < total;
  importAdd.disabled = importBusy || count === 0;
}

function eventLabel(date) {
  const [year, month, day] = date.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(year, month - 1, day).getDay()];
  const yearText = String(year) === today.slice(0, 4) ? '' : `${year}년 `;
  return `${yearText}${month}월 ${day}일 (${weekday})`;
}

function showImportResult(result) {
  importResult = result;
  importList.replaceChildren();
  result.events.forEach((event, index) => {
    const item = document.createElement('li');
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = true;
    box.dataset.index = String(index);
    box.addEventListener('change', updateImportCount);
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = eventLabel(event.date);
    const what = document.createElement('span');
    what.className = 'what';
    what.textContent = event.title;
    label.append(box, when, what);
    item.append(label);
    importList.append(item);
  });
  $('import-list').hidden = result.events.length === 0;

  const skipped = result.noMonthPages.length ? ` ${result.noMonthPages.join(', ')}쪽은 연월을 찾지 못해 건너뛰었습니다.` : '';
  if (result.textless) setImportStatus('글자를 읽을 수 없는 PDF입니다. 스캔한 이미지로 된 PDF는 지원하지 않습니다.', 'error');
  else if (!result.events.length) setImportStatus(`${result.pageCount}쪽에서 '${result.person}'의 일정을 찾지 못했습니다.${skipped}`, 'error');
  else setImportStatus(`'${result.person}'의 일정 ${result.events.length}개를 찾았습니다. 추가할 일정을 고르세요.${skipped}`);
  updateImportCount();
}

function clearImportResult() {
  importResult = null;
  importList.replaceChildren();
  $('import-list').hidden = true;
  updateImportCount();
}

async function readImport() {
  clearTimeout(personTimer);
  if (!importPath) return;
  const person = personInput.value.trim();
  if (person.replace(/\s/g, '').length < MIN_PERSON_CHARS) {
    clearImportResult();
    setImportStatus('이름을 두 글자 이상 입력하세요.', 'error');
    personInput.focus();
    return;
  }
  const seq = ++importSeq;
  importBusy = true;
  clearImportResult();
  setImportStatus('PDF를 읽는 중…', 'busy');
  const result = await api.readPdf(importPath, person);
  // 읽는 동안 이름이나 파일을 바꿨으면 이전 결과는 버린다.
  if (seq !== importSeq) return;
  importBusy = false;
  if (!result || result.error) {
    setImportStatus(result ? result.error : 'PDF를 읽지 못했습니다.', 'error');
    updateImportCount();
    return;
  }
  lastPerson = result.person;
  showImportResult(result);
}

function setImportFile(filePath) {
  importPath = filePath;
  $('import-file-name').textContent = filePath.split(/[\\/]/).pop();
  $('import-file-name').title = filePath;
  readImport();
}

function setImportOpen(open) {
  importBox.hidden = !open;
  $('btn-import').setAttribute('aria-expanded', String(open));
  if (!open) return;
  if (!personInput.value) personInput.value = lastPerson;
  if (!personInput.value) personInput.focus();
  else $('import-pick').focus();
}

$('btn-import').addEventListener('click', () => setImportOpen(importBox.hidden));
$('import-close').addEventListener('click', () => setImportOpen(false));
$('import-pick').addEventListener('click', async () => {
  const filePath = await api.pickPdf();
  if (filePath) setImportFile(filePath);
});

personInput.addEventListener('input', () => {
  clearTimeout(personTimer);
  if (importPath) personTimer = setTimeout(readImport, PERSON_DEBOUNCE_MS);
});
personInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') readImport();
});

importAll.addEventListener('change', () => {
  for (const box of importList.querySelectorAll('input[type="checkbox"]')) box.checked = importAll.checked;
  updateImportCount();
});

importAdd.addEventListener('click', async () => {
  const events = checkedEvents();
  if (!importResult || !events.length) return;
  importBusy = true;
  updateImportCount();
  const result = await api.addPdfEvents(importResult.person, importResult.fileName, events);
  importBusy = false;
  if (!result || result.error) {
    setImportStatus(result ? result.error : '메모를 만들지 못했습니다.', 'error');
    updateImportCount();
    return;
  }
  // 새 메모가 달력에 반영되면 첫 일정이 있는 달을 보여 준다.
  const [year, month] = events.map((event) => event.date).sort()[0].split('-').map(Number);
  viewYear = year;
  viewMonth = month - 1;
  selected = null;
  importPath = '';
  $('import-file-name').textContent = '';
  clearImportResult();
  setImportStatus('');
  setImportOpen(false);
  render();
});

// PDF를 달력 창에 끌어다 놓으면 가져오기를 연다.
const dropHint = $('drop-hint');
const hasFiles = (event) => event.dataTransfer && [...event.dataTransfer.types].includes('Files');
document.addEventListener('dragover', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  dropHint.hidden = false;
});
document.addEventListener('dragleave', (event) => {
  if (!event.relatedTarget) dropHint.hidden = true;
});
document.addEventListener('drop', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dropHint.hidden = true;
  const file = event.dataTransfer.files[0];
  if (!file) return;
  setImportOpen(true);
  if (!/\.pdf$/i.test(file.name)) {
    setImportStatus('PDF 파일만 읽을 수 있습니다.', 'error');
    return;
  }
  setImportFile(api.pathForFile(file));
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!importBox.hidden) setImportOpen(false);
  else if (selected) selectDay(selected);
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
