'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const crypto = require('node:crypto');
const { atomicWriteFile } = require('./sync/atomicWrite');

const SAVE_DEBOUNCE_MS = 200;

const DEFAULTS = {
  deviceId: '',
  syncFolder: '',
  syncPosition: false,
  notesHidden: false,
  // id → { x, y, width, height, alwaysOnTop }
  layouts: {},
  // { enabled, opacity, alwaysOnTop, x, y, width, height }
  calendar: {},
};

/** userData의 settings.json. PC마다 다른 값(기기 ID, 동기화 폴더, 창 위치)을 저장한다. */
class Settings {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { ...DEFAULTS };
    this.timer = null;
    this.writing = Promise.resolve();
  }

  load() {
    try {
      const parsed = JSON.parse(fsSync.readFileSync(this.filePath, 'utf8'));
      if (parsed && typeof parsed === 'object') this.data = { ...DEFAULTS, ...parsed };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[settings] 설정 파일을 읽지 못해 기본값을 사용합니다: ${err.message}`);
        fsSync.copyFileSync(this.filePath, `${this.filePath}.broken`);
      }
    }
    if (!this.data.layouts || typeof this.data.layouts !== 'object') this.data.layouts = {};
    if (!this.data.deviceId) {
      this.data.deviceId = crypto.randomUUID();
      this.save();
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }

  getLayout(id) {
    return this.data.layouts[id] || null;
  }

  setLayout(id, layout) {
    this.data.layouts[id] = { ...this.data.layouts[id], ...layout };
    this.save();
  }

  removeLayout(id) {
    if (!this.data.layouts[id]) return;
    delete this.data.layouts[id];
    this.save();
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this._write();
    }, SAVE_DEBOUNCE_MS);
  }

  _write() {
    const text = JSON.stringify(this.data, null, 2);
    this.writing = this.writing
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(require('node:path').dirname(this.filePath), { recursive: true });
        await atomicWriteFile(this.filePath, text);
      })
      .catch((err) => console.warn(`[settings] 저장 실패: ${err.message}`));
    return this.writing;
  }

  async flush() {
    clearTimeout(this.timer);
    this.timer = null;
    await this._write();
  }
}

module.exports = { Settings };
