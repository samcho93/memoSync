'use strict';

const crypto = require('node:crypto');

const COLORS = ['yellow', 'pink', 'green', 'blue', 'purple', 'gray'];
const DEFAULT_COLOR = 'yellow';
const DEFAULT_OPACITY = 0.85;
const MIN_OPACITY = 0.15;
const MAX_CONTENT_LENGTH = 1_000_000;
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 40;
const FONT_RE = /^[^"'\\<>;{}()\r\n]{1,100}$/;

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID_PATTERN}$`, 'i');

// 위치·항상 위는 PC별 값이라 기본적으로 동기화 파일에 넣지 않는다.
const LAYOUT_FIELDS = ['alwaysOnTop', 'x', 'y', 'w', 'h'];

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

function clampOpacity(value) {
  if (!isFiniteNumber(value)) return DEFAULT_OPACITY;
  return Math.min(1, Math.max(MIN_OPACITY, value));
}

// 글꼴 이름은 CSS 문자열에 들어가므로 문법을 깨는 문자가 있으면 버린다.
function cleanFont(value) {
  return typeof value === 'string' && FONT_RE.test(value) ? value : undefined;
}

function cleanFontSize(value) {
  if (!isFiniteNumber(value)) return undefined;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(value)));
}

// 동기화 폴더의 파일은 다른 기기나 프로그램이 쓴 것이므로 그대로 믿지 않고 정규화한다.
// 복구할 수 없을 만큼 깨졌으면 null을 돌려준다.
function normalizeRecord(raw, expectedId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.id !== 'string' || !UUID_RE.test(raw.id)) return null;
  if (expectedId && raw.id.toLowerCase() !== expectedId.toLowerCase()) return null;
  if (!isFiniteNumber(raw.updatedAt)) return null;

  const record = {
    id: raw.id.toLowerCase(),
    content: typeof raw.content === 'string' ? raw.content.slice(0, MAX_CONTENT_LENGTH) : '',
    color: COLORS.includes(raw.color) ? raw.color : DEFAULT_COLOR,
    opacity: clampOpacity(raw.opacity),
    createdAt: isFiniteNumber(raw.createdAt) ? raw.createdAt : raw.updatedAt,
    updatedAt: raw.updatedAt,
    deleted: raw.deleted === true,
    deviceId: typeof raw.deviceId === 'string' ? raw.deviceId : '',
  };
  const font = cleanFont(raw.font);
  const fontSize = cleanFontSize(raw.fontSize);
  if (font) record.font = font;
  if (fontSize) record.fontSize = fontSize;
  if (typeof raw.alwaysOnTop === 'boolean') record.alwaysOnTop = raw.alwaysOnTop;
  for (const key of ['x', 'y', 'w', 'h']) {
    if (isFiniteNumber(raw[key])) record[key] = Math.round(raw[key]);
  }
  return record;
}

// 키 순서를 고정해 같은 레코드는 어느 기기에서나 같은 바이트가 되게 한다.
function serializeRecord(record) {
  const ordered = {};
  for (const key of ['id', 'content', 'color', 'opacity', 'font', 'fontSize', 'alwaysOnTop', 'x', 'y', 'w', 'h',
    'createdAt', 'updatedAt', 'deleted', 'deviceId']) {
    if (record[key] !== undefined) ordered[key] = record[key];
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function hashText(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function sameRecord(a, b) {
  return serializeRecord(a) === serializeRecord(b);
}

module.exports = {
  COLORS,
  DEFAULT_COLOR,
  DEFAULT_OPACITY,
  MIN_OPACITY,
  MAX_CONTENT_LENGTH,
  UUID_PATTERN,
  UUID_RE,
  LAYOUT_FIELDS,
  clampOpacity,
  cleanFont,
  cleanFontSize,
  normalizeRecord,
  serializeRecord,
  hashText,
  sameRecord,
};
