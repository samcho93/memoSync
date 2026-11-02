'use strict';

const path = require('node:path');

const MAX_NAME_LENGTH = 180;
const IGNORED_NAMES = new Set(['desktop.ini', 'thumbs.db', '.ds_store']);
// 다른 PC에서 온 파일이 클릭 한 번으로 실행되면 안 되는 형식
const RISKY_EXTENSIONS = new Set([
  'application', 'appx', 'appxbundle', 'bat', 'cmd', 'com', 'cpl', 'dll', 'exe', 'gadget', 'hta', 'inf', 'jar', 'js', 'jse',
  'lnk', 'msc', 'msi', 'msix', 'msp', 'pif', 'ps1', 'psm1', 'reg', 'scf', 'scr', 'sys', 'url', 'vb', 'vbe', 'vbs', 'ws',
  'wsc', 'wsf', 'wsh',
]);

// Windows에서 파일 이름으로 쓸 수 없는 문자를 바꾸고, 경로가 될 수 있는 부분을 없앤다.
function sanitizeName(name) {
  const base = String(name).split(/[\\/]/).pop();
  const cleaned = base
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/[. ]+$/, '')
    .replace(/^ +/, '');
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'file';
  if (cleaned.length <= MAX_NAME_LENGTH) return cleaned;
  const ext = path.extname(cleaned).slice(0, 20);
  return cleaned.slice(0, MAX_NAME_LENGTH - ext.length) + ext;
}

function isValidName(name) {
  return typeof name === 'string' && name.length > 0 && sanitizeName(name) === name;
}

// 쓰는 중인 임시 파일과 시스템 파일은 공유 파일로 보이지 않게 한다.
function isIgnoredName(name) {
  return name.endsWith('.tmp') || IGNORED_NAMES.has(name.toLowerCase());
}

function isRiskyName(name) {
  const ext = path.extname(name.replace(/[. ]+$/, '')).slice(1).toLowerCase();
  return RISKY_EXTENSIONS.has(ext);
}

// report.pdf → report (1).pdf
function numberedName(name, number) {
  const ext = path.extname(name);
  return `${name.slice(0, name.length - ext.length)} (${number})${ext}`;
}

module.exports = { sanitizeName, isValidName, isIgnoredName, isRiskyName, numberedName };
