'use strict';

const SAVE_DEBOUNCE_MS = 500;
const COLORS = [
  ['yellow', '노랑'],
  ['pink', '분홍'],
  ['green', '초록'],
  ['blue', '파랑'],
  ['purple', '보라'],
  ['gray', '회색'],
];

const DEFAULT_FONT = 'Malgun Gothic';
const DEFAULT_FONT_SIZE = 14;
const FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 40];
// Windows 한글 환경의 기본 글꼴. 설치된 글꼴을 읽지 못해도 이 목록은 고를 수 있다.
const BASE_FONTS = [
  ['Malgun Gothic', '맑은 고딕'],
  ['Gulim', '굴림'],
  ['Dotum', '돋움'],
  ['Batang', '바탕'],
  ['Gungsuh', '궁서'],
  ['Consolas', 'Consolas (고정폭)'],
];

const api = window.memoNote;
const $ = (id) => document.getElementById(id);
const note = $('note');
const textarea = $('content');
const panel = $('panel');
const confirmBox = $('confirm');
const opacityInput = $('opacity');

let saveTimer = null;
let opacityTimer = null;
let composing = false;

function saveContent() {
  clearTimeout(saveTimer);
  saveTimer = null;
  api.update({ content: textarea.value });
}

function saveOpacity() {
  clearTimeout(opacityTimer);
  opacityTimer = null;
  api.update({ opacity: 1 - Number(opacityInput.value) / 100 });
}

function flush() {
  if (saveTimer) saveContent();
  if (opacityTimer) saveOpacity();
}

function showColor(color) {
  note.dataset.color = color;
  for (const swatch of document.querySelectorAll('.swatch')) {
    swatch.setAttribute('aria-pressed', String(swatch.dataset.swatch === color));
  }
}

function showOpacity(opacity) {
  const transparency = Math.round((1 - opacity) * 100);
  document.documentElement.style.setProperty('--note-alpha', String(opacity));
  document.documentElement.style.setProperty('--outline-alpha', String(Math.min(1, (1 - opacity) * 2.5)));
  opacityInput.value = String(transparency);
  $('opacity-value').value = `${transparency}%`;
}

function addFontOption(value, label = value) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  $('font').append(option);
}

function showFont(font, fontSize) {
  const family = font || DEFAULT_FONT;
  const size = fontSize || DEFAULT_FONT_SIZE;
  // 다른 PC에서 고른 글꼴이 이 PC에 없으면 목록에 넣어 값은 유지하고, 화면은 기본 글꼴로 대체한다.
  if (![...$('font').options].some((option) => option.value === family)) addFontOption(family);
  $('font').value = family;
  $('font-size').value = String(size);
  const style = document.documentElement.style;
  style.setProperty('--note-font', `"${family}", "Malgun Gothic", "Segoe UI", sans-serif`);
  style.setProperty('--note-font-size', `${size}px`);
}

let installedFontsLoaded = false;

// 설치된 글꼴은 사용자 조작이 있어야 읽을 수 있어 패널을 처음 열 때 불러온다.
async function loadInstalledFonts() {
  if (installedFontsLoaded || !window.queryLocalFonts) return;
  installedFontsLoaded = true;
  try {
    const fonts = await window.queryLocalFonts();
    const known = new Set([...$('font').options].map((option) => option.value));
    const families = [...new Set(fonts.map((font) => font.family))]
      .filter((family) => !known.has(family))
      .sort((a, b) => a.localeCompare(b, 'ko'));
    for (const family of families) addFontOption(family);
  } catch (err) {
    console.warn('설치된 글꼴을 읽지 못했습니다', err);
  }
}

function showContent(content) {
  // 입력 중이면 덮어쓰지 않는다. 저장되면 더 새로운 쪽이 되어 다른 PC에 반영된다.
  // 한글 조합 중에 값을 바꾸면 입력이 깨지므로 조합이 끝나기를 기다린다.
  if (saveTimer || composing || textarea.value === content) return;
  const { selectionStart, selectionEnd, scrollTop } = textarea;
  textarea.value = content;
  textarea.setSelectionRange(selectionStart, selectionEnd);
  textarea.scrollTop = scrollTop;
}

function showState(state) {
  if (!state) return;
  showContent(state.content);
  showColor(state.color);
  if (!opacityTimer) showOpacity(state.opacity);
  showFont(state.font, state.fontSize);
  $('btn-top').setAttribute('aria-pressed', String(state.alwaysOnTop));
}

function togglePanel(open) {
  panel.hidden = !open;
  $('btn-style').setAttribute('aria-expanded', String(open));
}

let confirmAction = null;

function toggleConfirm(open, text, action) {
  confirmBox.hidden = !open;
  confirmAction = open ? action : null;
  if (open) {
    $('confirm-text').textContent = text;
    togglePanel(false);
    $('confirm-no').focus();
  }
}

// ---- 공유 파일 ----

const FILE_ICONS = {
  save: 'M8 2.500v7.500M4.800 7 8 10.200 11.200 7M3 13h10',
  remove: 'm4.500 4.500 7 7M11.500 4.500l-7 7',
};

let files = [];
let copying = 0;
let messageTimer = null;

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function showFileMessage(text, kind = 'info') {
  const box = $('file-message');
  clearTimeout(messageTimer);
  box.hidden = !text;
  box.textContent = text || '';
  box.dataset.kind = kind;
  // 오류는 읽을 수 있게 남겨 두고, 안내만 잠시 뒤 지운다.
  if (text && kind === 'info' && !copying) messageTimer = setTimeout(() => showFileMessage(''), 5000);
}

function showResult(result) {
  if (!result) return;
  if (result.error) showFileMessage(result.error, 'error');
  else if (result.notice) showFileMessage(result.notice);
}

function fileButton(name, label, icon, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon';
  button.title = label;
  button.setAttribute('aria-label', `${name} ${label}`);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', icon);
  svg.append(path);
  button.append(svg);
  button.addEventListener('click', onClick);
  return button;
}

function renderFiles(list) {
  files = list;
  $('files').hidden = list.length === 0;
  $('file-list').replaceChildren(...list.map(({ name, size }) => {
    const item = document.createElement('li');
    item.className = 'file';

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'file-open';
    open.title = `${name} 열기`;
    const label = document.createElement('span');
    label.className = 'file-name';
    label.textContent = name;
    const sizeLabel = document.createElement('span');
    sizeLabel.className = 'file-size';
    sizeLabel.textContent = formatSize(size);
    open.append(label, sizeLabel);
    open.addEventListener('click', async () => showResult(await api.openFile(name)));

    item.append(
      open,
      fileButton(name, '다른 이름으로 저장', FILE_ICONS.save, async () => showResult(await api.saveFile(name))),
      fileButton(name, '삭제', FILE_ICONS.remove, () => {
        toggleConfirm(true, `"${name}" 파일을 모든 PC에서 삭제할까요?`, async () => {
          toggleConfirm(false);
          showResult(await api.removeFile(name));
        });
      }),
    );
    return item;
  }));
}

// 복사가 끝날 때까지 진행 중임을 보여 주고, 실패한 파일은 이유와 함께 남긴다.
async function runFileCopy(task) {
  copying += 1;
  showFileMessage('파일을 복사하는 중입니다…');
  try {
    const { errors } = await task();
    copying -= 1;
    if (errors.length) {
      showFileMessage(errors.map(({ name, message }) => `${name}: ${message}`).join('\n'), 'error');
    } else if (!copying) {
      showFileMessage('');
    }
  } catch (err) {
    copying -= 1;
    showFileMessage(err.message, 'error');
  }
}

const hasFiles = (event) => event.dataTransfer && [...event.dataTransfer.types].includes('Files');

// 파일을 놓는 동작만 가로챈다. 글자를 끌어 옮기는 동작은 그대로 둔다.
document.addEventListener('dragover', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  $('drop-hint').hidden = false;
}, true);
document.addEventListener('dragleave', (event) => {
  if (!event.relatedTarget) $('drop-hint').hidden = true;
}, true);
document.addEventListener('drop', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  event.stopPropagation();
  $('drop-hint').hidden = true;
  const paths = [...event.dataTransfer.files].map((file) => api.pathForFile(file)).filter(Boolean);
  if (paths.length) runFileCopy(() => api.addFiles(paths));
}, true);

$('btn-attach').addEventListener('click', () => runFileCopy(() => api.pickFiles()));

// ---- 입력 ----

textarea.addEventListener('input', () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveContent, SAVE_DEBOUNCE_MS);
});
textarea.addEventListener('compositionstart', () => { composing = true; });
textarea.addEventListener('compositionend', () => { composing = false; });
textarea.addEventListener('blur', flush);

// ---- 상단 바와 패널 ----

$('btn-new').addEventListener('click', () => api.create());
$('btn-top').addEventListener('click', () => api.toggleTop());
$('btn-style').addEventListener('click', () => {
  togglePanel(panel.hidden);
  if (!panel.hidden) loadInstalledFonts();
});
$('btn-delete').addEventListener('click', () => {
  // 빈 메모는 잃을 것이 없으므로 바로 지운다.
  if (files.length) toggleConfirm(true, '이 메모와 공유 파일을 모든 PC에서 삭제할까요?', () => api.remove());
  else if (textarea.value.trim()) toggleConfirm(true, '이 메모를 모든 PC에서 삭제할까요?', () => api.remove());
  else api.remove();
});
$('confirm-yes').addEventListener('click', () => confirmAction && confirmAction());
$('confirm-no').addEventListener('click', () => {
  toggleConfirm(false);
  textarea.focus();
});

for (const [color, label] of COLORS) {
  const swatch = document.createElement('button');
  swatch.type = 'button';
  swatch.className = 'swatch';
  swatch.dataset.swatch = color;
  swatch.title = label;
  swatch.setAttribute('aria-label', label);
  swatch.addEventListener('click', () => {
    showColor(color);
    api.update({ color });
  });
  $('swatches').append(swatch);
}

for (const [value, label] of BASE_FONTS) addFontOption(value, label);
for (const size of FONT_SIZES) {
  const option = document.createElement('option');
  option.value = String(size);
  option.textContent = String(size);
  $('font-size').append(option);
}
$('font').addEventListener('change', () => {
  showFont($('font').value, Number($('font-size').value));
  api.update({ font: $('font').value });
});
$('font-size').addEventListener('change', () => {
  showFont($('font').value, Number($('font-size').value));
  api.update({ fontSize: Number($('font-size').value) });
});

opacityInput.addEventListener('input', () => {
  showOpacity(1 - Number(opacityInput.value) / 100);
  clearTimeout(opacityTimer);
  opacityTimer = setTimeout(saveOpacity, 300);
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!confirmBox.hidden) toggleConfirm(false);
  else togglePanel(false);
});

// ---- 메인 프로세스 연결 ----

attachResize(api);
api.onFiles(renderFiles);
api.listFiles().then(renderFiles);
api.onState(showState);
api.onFlush(() => {
  flush();
  api.flushed();
});
api.get().then((state) => {
  showState(state);
  if (state && !state.content) textarea.focus();
});
