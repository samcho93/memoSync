'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const chokidar = require('chokidar');
const { SyncStore } = require('./SyncStore');
const crypto = require('node:crypto');
const { atomicWriteFile, renameWithRetry } = require('./atomicWrite');
const { UUID_PATTERN, UUID_RE, normalizeRecord, serializeRecord, hashText } = require('./record');
const { sanitizeName, isValidName, isIgnoredName, numberedName } = require('./attachmentNames');

const ATTACHMENTS_DIR = 'attachments';
const MAX_ATTACHMENT_SIZE = 500 * 1024 * 1024;
const ATTACHMENT_EVENT_DEBOUNCE_MS = 200;
const MAX_NAME_ATTEMPTS = 1000;

const MAIN_FILE_RE = new RegExp(`^(${UUID_PATTERN})\\.json$`, 'i');
// 예: "{uuid} (충돌 사본).json", "{uuid} (PC's conflicted copy 2026-01-01).json", "{uuid}-PC이름.json", "{uuid} (1).json"
const CONFLICT_FILE_RE = new RegExp(`^(${UUID_PATTERN})(.+)\\.json$`, 'i');
const STALE_TMP_MS = 60 * 60 * 1000;

function classify(name) {
  const main = MAIN_FILE_RE.exec(name);
  if (main) return { kind: 'main', id: main[1].toLowerCase() };
  const conflict = CONFLICT_FILE_RE.exec(name);
  if (conflict) return { kind: 'conflict', id: conflict[1].toLowerCase() };
  return null;
}

/** 메모 1개 = {uuid}.json 파일 1개로 클라우드 동기화 폴더에 저장한다. */
class FolderStore extends SyncStore {
  constructor({ folder, watchOptions = {}, log = console }) {
    super();
    this.folder = folder;
    this.watchOptions = watchOptions;
    this.log = log;
    this.watcher = null;
    // 파일 이름 → 마지막으로 쓰거나 읽은 내용의 해시. 자기 쓰기와 중복 이벤트를 걸러낸다.
    this.seen = new Map();
    this.queues = new Map();
    this.attachmentWatcher = null;
    this.attachmentTimers = new Map();
  }

  get attachmentsRoot() {
    return path.join(this.folder, ATTACHMENTS_DIR);
  }

  get location() {
    return path.resolve(this.folder);
  }

  _pathOf(id) {
    return path.join(this.folder, `${id}.json`);
  }

  async start() {
    await fs.mkdir(this.folder, { recursive: true });
    if (this.watcher) return;
    this.watcher = chokidar.watch(this.folder, {
      depth: 0,
      ignoreInitial: true,
      ignored: (p, stats) => (stats ? stats.isFile() && !classify(path.basename(p)) : false),
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
      ...this.watchOptions,
    });
    this.watcher.on('add', (p) => this._onFile(p));
    this.watcher.on('change', (p) => this._onFile(p));
    this.watcher.on('unlink', (p) => this._onUnlink(p));
    this.watcher.on('error', (err) => this.emit('error', err));
    await new Promise((resolve) => this.watcher.once('ready', resolve));
    await this._watchAttachments();
  }

  // 메모 파일과 섞이지 않도록 첨부 폴더는 따로 감시한다. 큰 파일은 내려받는 데 오래 걸려 안정 시간을 길게 둔다.
  async _watchAttachments() {
    await fs.mkdir(this.attachmentsRoot, { recursive: true });
    this.attachmentWatcher = chokidar.watch(this.attachmentsRoot, {
      depth: 1,
      ignoreInitial: true,
      ignored: (p, stats) => (stats ? stats.isFile() && isIgnoredName(path.basename(p)) : false),
      awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 100 },
      ...this.watchOptions,
    });
    const onEvent = (p) => this._onAttachmentEvent(p);
    for (const event of ['add', 'change', 'unlink', 'unlinkDir']) this.attachmentWatcher.on(event, onEvent);
    this.attachmentWatcher.on('error', (err) => this.emit('error', err));
    await new Promise((resolve) => this.attachmentWatcher.once('ready', resolve));
  }

  _onAttachmentEvent(filePath) {
    const [id] = path.relative(this.attachmentsRoot, filePath).split(path.sep);
    if (!UUID_RE.test(id)) return;
    const noteId = id.toLowerCase();
    clearTimeout(this.attachmentTimers.get(noteId));
    this.attachmentTimers.set(noteId, setTimeout(() => {
      this.attachmentTimers.delete(noteId);
      this.emit('attachments', noteId);
    }, ATTACHMENT_EVENT_DEBOUNCE_MS));
  }

  async stop() {
    await this.drain();
    for (const timer of this.attachmentTimers.values()) clearTimeout(timer);
    this.attachmentTimers.clear();
    if (this.attachmentWatcher) {
      const watcher = this.attachmentWatcher;
      this.attachmentWatcher = null;
      await watcher.close();
    }
    if (this.watcher) {
      const watcher = this.watcher;
      this.watcher = null;
      await watcher.close();
    }
  }

  async _read(name) {
    const filePath = path.join(this.folder, name);
    const text = await fs.readFile(filePath, 'utf8');
    return { filePath, text, hash: hashText(text) };
  }

  _parse(text, id) {
    try {
      return normalizeRecord(JSON.parse(text), id);
    } catch {
      return null;
    }
  }

  async _onFile(filePath) {
    const name = path.basename(filePath);
    const info = classify(name);
    if (!info) return;
    try {
      const { text, hash } = await this._read(name);
      if (this.seen.get(name) === hash) return;
      const record = this._parse(text, info.id);
      if (!record) {
        // 아직 내려받는 중일 수 있다. seen에 넣지 않았으므로 다음 스캔 때 다시 읽는다.
        this.log.warn(`[FolderStore] 읽을 수 없는 파일 무시: ${name}`);
        return;
      }
      this.seen.set(name, hash);
      if (info.kind === 'main') this.emit('change', record);
      else this.emit('conflict', { id: info.id, ref: name, record });
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.warn(`[FolderStore] 읽기 실패: ${name}: ${err.message}`);
    }
  }

  _onUnlink(filePath) {
    const name = path.basename(filePath);
    const info = classify(name);
    if (!info) return;
    this.seen.delete(name);
    if (info.kind === 'main') this.emit('removed', info.id);
  }

  async list() {
    await this.drain();
    const entries = await fs.readdir(this.folder, { withFileTypes: true });
    const result = { records: [], conflicts: [], unreadable: [] };
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name.endsWith('.tmp')) {
        await this._removeStaleTmp(entry.name);
        continue;
      }
      const info = classify(entry.name);
      if (!info) continue;
      let record = null;
      try {
        const { text, hash } = await this._read(entry.name);
        record = this._parse(text, info.id);
        if (record) this.seen.set(entry.name, hash);
      } catch (err) {
        if (err.code === 'ENOENT') continue;
        this.log.warn(`[FolderStore] 읽기 실패: ${entry.name}: ${err.message}`);
      }
      if (info.kind === 'main') {
        if (record) result.records.push(record);
        else result.unreadable.push(info.id);
      } else if (record) {
        result.conflicts.push({ id: info.id, ref: entry.name, record });
      }
    }
    return result;
  }

  async _removeStaleTmp(name, dir = this.folder) {
    if (!name.startsWith('.')) return;
    const filePath = path.join(dir, name);
    try {
      const stat = await fs.stat(filePath);
      if (Date.now() - stat.mtimeMs > STALE_TMP_MS) await fs.rm(filePath, { force: true });
    } catch {
      // 다른 기기가 이미 지웠을 수 있다.
    }
  }

  // 같은 메모의 쓰기는 순서대로 실행한다.
  _enqueue(id, task) {
    const previous = this.queues.get(id) || Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    this.queues.set(id, run);
    run.catch(() => {}).finally(() => {
      if (this.queues.get(id) === run) this.queues.delete(id);
    });
    return run;
  }

  put(record) {
    const name = `${record.id}.json`;
    return this._enqueue(record.id, async () => {
      const text = serializeRecord(record);
      const previous = this.seen.get(name);
      // rename 직후 감시 이벤트가 먼저 도착해도 걸러지도록 쓰기 전에 기록한다.
      this.seen.set(name, hashText(text));
      try {
        await atomicWriteFile(path.join(this.folder, name), text);
      } catch (err) {
        if (previous) this.seen.set(name, previous);
        else this.seen.delete(name);
        throw err;
      }
    });
  }

  remove(id) {
    return this._enqueue(id, async () => {
      await fs.rm(this._pathOf(id), { force: true });
      this.seen.delete(`${id}.json`);
    });
  }

  async exists(id) {
    try {
      await fs.stat(this._pathOf(id));
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
  }

  async discardConflict(ref) {
    // ref는 파일 이름이다. 충돌 사본 형식일 때만, 이 폴더 안에서만 지운다.
    const name = path.basename(ref);
    const info = classify(name);
    if (!info || info.kind !== 'conflict') return;
    await fs.rm(path.join(this.folder, name), { force: true });
    this.seen.delete(name);
  }

  async drain() {
    await Promise.allSettled([...this.queues.values()]);
  }

  // ---- 첨부 파일 ----
  // 파일 목록의 기준은 폴더 자체다. 메모 JSON에 넣지 않으므로 메모 내용의 LWW로 첨부가 사라지지 않고,
  // 클라우드가 만든 충돌 사본도 별도 파일로 그대로 보인다.

  _attachmentDir(id) {
    if (!UUID_RE.test(id)) throw new Error('잘못된 메모 id');
    return path.join(this.attachmentsRoot, id.toLowerCase());
  }

  async attachmentPath(id, name) {
    if (!isValidName(name)) throw new Error('잘못된 파일 이름');
    return path.join(this._attachmentDir(id), name);
  }

  async listAttachments(id) {
    const dir = this._attachmentDir(id);
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name.endsWith('.tmp')) {
        await this._removeStaleTmp(entry.name, dir);
        continue;
      }
      if (isIgnoredName(entry.name)) continue;
      try {
        const stat = await fs.stat(path.join(dir, entry.name));
        files.push({ name: entry.name, size: stat.size, modifiedAt: stat.mtimeMs });
      } catch (err) {
        if (err.code !== 'ENOENT') this.log.warn(`[FolderStore] 첨부 정보 읽기 실패: ${entry.name}: ${err.message}`);
      }
    }
    return files.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  }

  async _freeAttachmentName(dir, name) {
    for (let number = 0; number < MAX_NAME_ATTEMPTS; number += 1) {
      const candidate = number === 0 ? name : numberedName(name, number);
      try {
        await fs.access(path.join(dir, candidate));
      } catch (err) {
        if (err.code === 'ENOENT') return candidate;
        throw err;
      }
    }
    throw new Error('같은 이름의 파일이 너무 많습니다.');
  }

  async addAttachment(id, sourcePath) {
    const dir = this._attachmentDir(id);
    const stat = await fs.stat(sourcePath);
    if (!stat.isFile()) throw new Error('폴더는 공유할 수 없습니다. 파일을 선택하세요.');
    if (stat.size > MAX_ATTACHMENT_SIZE) throw new Error('500MB보다 큰 파일은 공유할 수 없습니다.');
    await fs.mkdir(dir, { recursive: true });
    const name = await this._freeAttachmentName(dir, sanitizeName(path.basename(sourcePath)));
    // 다른 PC에 반쯤 복사된 파일이 보이지 않도록 임시 이름으로 복사한 뒤 rename한다.
    const tmp = path.join(dir, `.${crypto.randomBytes(6).toString('hex')}.tmp`);
    try {
      await fs.copyFile(sourcePath, tmp);
      await renameWithRetry(tmp, path.join(dir, name));
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    return name;
  }

  async removeAttachment(id, name) {
    await fs.rm(await this.attachmentPath(id, name), { force: true });
    // 비어 있을 때만 지워진다.
    await fs.rmdir(this._attachmentDir(id)).catch(() => {});
  }

  async removeAllAttachments(id) {
    await fs.rm(this._attachmentDir(id), { recursive: true, force: true });
  }

  async importAttachmentsFrom(store) {
    await fs.mkdir(this.attachmentsRoot, { recursive: true });
    try {
      await fs.cp(store.attachmentsRoot, this.attachmentsRoot, {
        recursive: true,
        force: false,
        filter: (source) => !source.endsWith('.tmp'),
      });
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

module.exports = { FolderStore, classify };
