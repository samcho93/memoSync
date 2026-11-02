'use strict';

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { atomicWriteFile } = require('./sync/atomicWrite');
const { pickWinner, resolveConflict } = require('./sync/merge');
const { normalizeRecord, sameRecord, DEFAULT_COLOR, DEFAULT_OPACITY } = require('./sync/record');

const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_DEBOUNCE_MS = 200;
const REMOVED_DEBOUNCE_MS = 1500;

/**
 * 메모 상태의 기준. 로컬 캐시와 SyncStore 사이를 last-write-wins로 맞춘다.
 * Electron에 의존하지 않아 창 없이 테스트할 수 있다.
 *
 * 이벤트: 'created' (record, {local}), 'updated' (record, {local}), 'removed' (id, {local}), 'status' (status)
 */
class NoteManager extends EventEmitter {
  constructor({ deviceId, cachePath, scanIntervalMs = 60_000, now = Date.now, log = console }) {
    super();
    this.deviceId = deviceId;
    this.cachePath = cachePath;
    this.scanIntervalMs = scanIntervalMs;
    this.now = now;
    this.log = log;
    this.notes = new Map();
    // 아직 저장소에 올리지 못한 메모의 id
    this.dirty = new Set();
    this.store = null;
    this.cachedLocation = null;
    this.status = { state: 'starting', pending: 0, lastSyncAt: null, lastError: null };
    this.scanning = null;
    this.scanTimer = null;
    this.removedTimer = null;
    this.cacheTimer = null;
    this.cacheWrite = Promise.resolve();
    this.storeListeners = null;
  }

  // ---- 조회 ----

  get(id) {
    return this.notes.get(id) || null;
  }

  active() {
    return [...this.notes.values()].filter((note) => !note.deleted);
  }

  // ---- 로컬 캐시 ----

  async load() {
    let cache;
    try {
      cache = JSON.parse(await fs.readFile(this.cachePath, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.warn(`[notes] 캐시를 읽지 못함: ${err.message}`);
      return;
    }
    for (const raw of Array.isArray(cache.notes) ? cache.notes : []) {
      const record = normalizeRecord(raw);
      if (record) this.notes.set(record.id, record);
    }
    for (const id of Array.isArray(cache.dirty) ? cache.dirty : []) {
      if (this.notes.has(id)) this.dirty.add(id);
    }
    this.cachedLocation = typeof cache.location === 'string' ? cache.location : null;
  }

  _scheduleCacheWrite() {
    if (this.cacheTimer) return;
    this.cacheTimer = setTimeout(() => {
      this.cacheTimer = null;
      this._writeCache();
    }, CACHE_DEBOUNCE_MS);
  }

  _writeCache() {
    const text = JSON.stringify({
      location: this.store ? this.store.location : this.cachedLocation,
      notes: [...this.notes.values()],
      dirty: [...this.dirty],
    });
    this.cacheWrite = this.cacheWrite
      .catch(() => {})
      .then(() => atomicWriteFile(this.cachePath, text))
      .catch((err) => this.log.warn(`[notes] 캐시 저장 실패: ${err.message}`));
    return this.cacheWrite;
  }

  // ---- 로컬 변경 ----

  // 다른 PC의 시계가 빨라도 로컬 편집이 항상 이전 값보다 새것이 되게 한다.
  _nextStamp(previous) {
    return Math.max(this.now(), previous ? previous.updatedAt + 1 : 0);
  }

  create(fields = {}) {
    const stamp = this._nextStamp();
    const record = {
      id: crypto.randomUUID(),
      content: '',
      color: DEFAULT_COLOR,
      opacity: DEFAULT_OPACITY,
      createdAt: stamp,
      updatedAt: stamp,
      deleted: false,
      deviceId: this.deviceId,
      ...fields,
    };
    this.notes.set(record.id, record);
    this._touchLocal(record.id);
    this.emit('created', record, { local: true });
    return record;
  }

  update(id, patch) {
    const current = this.notes.get(id);
    if (!current || current.deleted) return null;
    const merged = { ...current, ...patch };
    if (sameRecord(merged, current)) return current;
    const record = { ...merged, updatedAt: this._nextStamp(current), deviceId: this.deviceId };
    this.notes.set(id, record);
    this._touchLocal(id);
    this.emit('updated', record, { local: true });
    return record;
  }

  remove(id) {
    const current = this.notes.get(id);
    if (!current || current.deleted) return;
    this.notes.set(id, {
      ...current,
      deleted: true,
      updatedAt: this._nextStamp(current),
      deviceId: this.deviceId,
    });
    this._touchLocal(id);
    this.emit('removed', id, { local: true });
  }

  _touchLocal(id) {
    this.dirty.add(id);
    this._scheduleCacheWrite();
    this._push(id);
  }

  // ---- 저장소 연결 ----

  async setStore(store) {
    const previous = this.store;
    await this._detachStore();
    this.store = store;
    this.storeListeners = {
      change: (record) => this._applyIncoming(record, { fromScan: false }),
      conflict: (conflict) => this._resolveConflict(conflict).catch((err) => this._onStoreError(err)),
      removed: () => this._scheduleScanAfterRemoval(),
      error: (err) => this._onStoreError(err),
      attachments: (id) => this.emit('attachments', id),
    };
    for (const [event, listener] of Object.entries(this.storeListeners)) store.on(event, listener);

    if (previous && previous.location !== store.location) {
      try {
        await store.start();
        await store.importAttachmentsFrom(previous);
      } catch (err) {
        // 메모 동기화까지 막지는 않는다. 파일은 이전 폴더에 그대로 남아 있다.
        this.log.warn(`[notes] 첨부 파일 이전 실패: ${err.message}`);
      }
    }

    // 폴더가 바뀌었으면 기존 메모를 모두 새 폴더와 병합한다.
    if (this.cachedLocation !== store.location) {
      for (const id of this.notes.keys()) this.dirty.add(id);
    }
    this.cachedLocation = store.location;

    await this.scan();
    if (this.scanIntervalMs > 0) {
      this.scanTimer = setInterval(() => this.scan(), this.scanIntervalMs);
    }
  }

  async _detachStore() {
    clearInterval(this.scanTimer);
    clearTimeout(this.removedTimer);
    this.scanTimer = null;
    this.removedTimer = null;
    if (this.scanning) await this.scanning;
    if (!this.store) return;
    const store = this.store;
    this.store = null;
    for (const [event, listener] of Object.entries(this.storeListeners)) store.off(event, listener);
    await store.stop().catch((err) => this.log.warn(`[notes] 저장소 종료 실패: ${err.message}`));
  }

  _setStatus(patch) {
    this.status = { ...this.status, ...patch, pending: this.dirty.size };
    this.emit('status', this.status);
  }

  _onStoreError(err) {
    this.log.warn(`[notes] 저장소 오류: ${err.message}`);
    this._setStatus({ state: 'offline', lastError: err.message });
  }

  // 클라우드 클라이언트는 파일을 지웠다가 다시 만들기도 하므로 잠시 뒤 폴더 전체를 다시 확인한다.
  _scheduleScanAfterRemoval() {
    clearTimeout(this.removedTimer);
    this.removedTimer = setTimeout(() => this.scan(), REMOVED_DEBOUNCE_MS);
  }

  // ---- 저장소 → 로컬 ----

  _applyIncoming(incoming, { fromScan }) {
    const local = this.notes.get(incoming.id);
    if (!local) {
      this.notes.set(incoming.id, incoming);
      this._scheduleCacheWrite();
      if (!incoming.deleted) this.emit('created', incoming, { local: false });
      return;
    }
    if (sameRecord(local, incoming)) {
      this.dirty.delete(incoming.id);
      return;
    }
    if (pickWinner(local, incoming) === local) {
      // 감시 이벤트로 받은 자기 기기의 옛 버전은 연속 쓰기의 메아리다. 다시 쓰면 불필요한 쓰기만 는다.
      // 전체 스캔에서 발견했다면 정말로 파일이 뒤로 돌아간 것이므로 다시 올린다.
      if (fromScan || incoming.deviceId !== this.deviceId) {
        this.dirty.add(local.id);
        this._push(local.id);
      }
      return;
    }
    this.notes.set(incoming.id, incoming);
    this.dirty.delete(incoming.id);
    this._scheduleCacheWrite();
    if (incoming.deleted) {
      if (!local.deleted) this.emit('removed', incoming.id, { local: false });
    } else if (local.deleted) {
      this.emit('created', incoming, { local: false });
    } else {
      this.emit('updated', incoming, { local: false });
    }
  }

  async _resolveConflict({ id, ref, record }) {
    const store = this.store;
    if (!store) return;
    const local = this.notes.get(id);
    const merged = local ? resolveConflict(local, record) : record;
    if (!local || !sameRecord(merged, local)) {
      this._applyIncoming(merged, { fromScan: true });
      this.dirty.add(id);
    }
    // 합친 결과가 저장소에 들어간 뒤에만 사본을 지운다.
    if (this.dirty.has(id) && !(await this._push(id))) return;
    await store.discardConflict(ref);
  }

  // ---- 로컬 → 저장소 ----

  async _push(id) {
    const store = this.store;
    const record = this.notes.get(id);
    if (!store || !record) return false;
    try {
      await store.put(record);
    } catch (err) {
      this._onStoreError(err);
      return false;
    }
    if (this.notes.get(id) === record) {
      this.dirty.delete(id);
      this._scheduleCacheWrite();
    }
    if (this.status.state === 'offline') this._setStatus({ state: 'online', lastError: null });
    return true;
  }

  // ---- 전체 스캔 ----

  scan() {
    if (!this.store) return Promise.resolve();
    if (!this.scanning) {
      this.scanning = this._scan()
        .catch((err) => this._onStoreError(err))
        .finally(() => { this.scanning = null; });
    }
    return this.scanning;
  }

  async _scan() {
    const store = this.store;
    await store.start();
    const listing = await store.list();
    if (store !== this.store) return;

    for (const record of listing.records) this._applyIncoming(record, { fromScan: true });

    const present = new Set([...listing.records.map((r) => r.id), ...listing.unreadable]);
    const missing = [...this.notes.values()].filter((note) => !present.has(note.id));

    // 폴더가 통째로 비었다면 사용자의 삭제보다 클라우드 쪽 사고(마운트 해제, 재설치 등)일 가능성이 크다.
    // 메모를 잃는 쪽보다 되살리는 쪽을 택한다.
    if (present.size === 0) {
      for (const note of missing) {
        if (!note.deleted) this.dirty.add(note.id);
      }
    }
    for (const note of missing) {
      if (this.dirty.has(note.id)) continue;
      if (await store.exists(note.id)) continue;
      this.notes.delete(note.id);
      this._scheduleCacheWrite();
      if (!note.deleted) this.emit('removed', note.id, { local: false });
    }

    for (const conflict of listing.conflicts) await this._resolveConflict(conflict);
    for (const id of [...this.dirty]) await this._push(id);
    await this._purgeTombstones(store);

    if (this.dirty.size === 0) {
      this._setStatus({ state: 'online', lastSyncAt: this.now(), lastError: null });
    } else {
      this._setStatus({ state: 'offline' });
    }
  }

  async _purgeTombstones(store) {
    const cutoff = this.now() - TOMBSTONE_TTL_MS;
    for (const note of [...this.notes.values()]) {
      if (!note.deleted || note.updatedAt >= cutoff) continue;
      await store.removeAllAttachments(note.id);
      await store.remove(note.id);
      this.notes.delete(note.id);
      this.dirty.delete(note.id);
      this._scheduleCacheWrite();
    }
  }

  // ---- 종료 ----

  async stop() {
    clearTimeout(this.cacheTimer);
    this.cacheTimer = null;
    if (this.store) await this.store.drain();
    await this._detachStore();
    await this._writeCache();
  }
}

module.exports = { NoteManager, TOMBSTONE_TTL_MS };
