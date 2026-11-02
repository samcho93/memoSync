'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { NoteManager, TOMBSTONE_TTL_MS } = require('../main/notes');
const { FolderStore, classify } = require('../main/sync/FolderStore');
const { pickWinner, resolveConflict } = require('../main/sync/merge');
const { normalizeRecord, serializeRecord } = require('../main/sync/record');
const { sanitizeName, isValidName, isRiskyName } = require('../main/sync/attachmentNames');

const quiet = { warn() {}, log() {}, error() {} };

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(process.env.MEMOSYNC_TEST_DIR || os.tmpdir(), 'memosync-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

async function device(t, root, name, folder, options = {}) {
  const manager = new NoteManager({
    deviceId: name,
    cachePath: path.join(root, `${name}-cache.json`),
    scanIntervalMs: 0,
    log: quiet,
    ...options,
  });
  await manager.load();
  await manager.setStore(new FolderStore({ folder, log: quiet }));
  t.after(() => manager.stop());
  return manager;
}

async function waitFor(check, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`시간 초과: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

function record(fields = {}) {
  return {
    id: crypto.randomUUID(),
    content: '',
    color: 'yellow',
    opacity: 0.85,
    createdAt: 1000,
    updatedAt: 1000,
    deleted: false,
    deviceId: 'a',
    ...fields,
  };
}

test('LWW: 시각이 큰 쪽이 이기고 같으면 deviceId로 결정한다', () => {
  const older = record({ updatedAt: 1, deviceId: 'z' });
  const newer = record({ updatedAt: 2, deviceId: 'a' });
  assert.equal(pickWinner(older, newer), newer);
  const a = record({ updatedAt: 5, deviceId: 'a' });
  const b = record({ updatedAt: 5, deviceId: 'b' });
  assert.equal(pickWinner(a, b), b);
  assert.equal(pickWinner(b, a), b);
});

test('충돌 병합: 진 쪽 글을 보존하고 어느 쪽에서 실행해도 결과가 같다', () => {
  const id = crypto.randomUUID();
  const a = record({ id, content: '가', updatedAt: 10, deviceId: 'a' });
  const b = record({ id, content: '나', updatedAt: 20, deviceId: 'b' });
  const ab = resolveConflict(a, b);
  const ba = resolveConflict(b, a);
  assert.deepEqual(ab, ba);
  assert.ok(ab.content.startsWith('나'));
  assert.ok(ab.content.endsWith('가'));
  assert.equal(ab.updatedAt, 21);
  // 이미 병합된 본문에 같은 사본이 또 오면 변화가 없어야 한다.
  assert.equal(resolveConflict(ab, a), ab);
});

test('충돌 병합: 삭제가 얽히면 순수 LWW로 처리한다', () => {
  const id = crypto.randomUUID();
  const edited = record({ id, content: '글', updatedAt: 10 });
  const tombstone = record({ id, content: '다른 글', updatedAt: 20, deleted: true });
  assert.equal(resolveConflict(edited, tombstone), tombstone);
  const later = record({ id, content: '글', updatedAt: 30 });
  assert.equal(resolveConflict(tombstone, later), later);
});

test('파일 이름 분류: 본문, 각 클라우드의 충돌 사본, 관계없는 파일', () => {
  const id = crypto.randomUUID();
  assert.deepEqual(classify(`${id}.json`), { kind: 'main', id });
  for (const name of [`${id} (충돌 사본).json`, `${id} (PC's conflicted copy 2026-01-01).json`, `${id}-DESKTOP.json`, `${id} (1).json`]) {
    assert.deepEqual(classify(name), { kind: 'conflict', id });
  }
  for (const name of ['readme.json', `.${id}.json.abcd.tmp`, `${id}.txt`, 'desktop.ini']) {
    assert.equal(classify(name), null);
  }
});

test('레코드 검증: 깨진 값은 거부하거나 안전한 값으로 바꾼다', () => {
  const id = crypto.randomUUID();
  assert.equal(normalizeRecord(null), null);
  assert.equal(normalizeRecord({ id: '../evil', updatedAt: 1 }), null);
  assert.equal(normalizeRecord({ id, updatedAt: 'x' }), null);
  assert.equal(normalizeRecord({ id, updatedAt: 1 }, crypto.randomUUID()), null);
  const fixed = normalizeRecord({ id, updatedAt: 1, color: 'url(x)', opacity: 99, content: 5, deleted: 'yes' });
  assert.equal(fixed.color, 'yellow');
  assert.equal(fixed.opacity, 1);
  assert.equal(fixed.content, '');
  assert.equal(fixed.deleted, false);
});

test('글꼴 검증: CSS를 깨는 이름은 버리고 크기는 범위 안으로 맞춘다', () => {
  const id = crypto.randomUUID();
  const ok = normalizeRecord({ id, updatedAt: 1, font: '맑은 고딕', fontSize: 99 });
  assert.equal(ok.font, '맑은 고딕');
  assert.equal(ok.fontSize, 40);
  assert.equal(normalizeRecord({ id, updatedAt: 1, fontSize: 1 }).fontSize, 10);
  for (const font of ['a"; background:url(x)', 'x{y}', 5, '']) {
    assert.equal(normalizeRecord({ id, updatedAt: 1, font }).font, undefined);
  }
  // 글꼴을 고르지 않은 메모는 파일에 필드가 생기지 않는다.
  assert.equal('font' in JSON.parse(serializeRecord(normalizeRecord({ id, updatedAt: 1 }))), false);
});

test('동기화 파일에는 기본적으로 위치 필드가 들어가지 않는다', async (t) => {
  const root = await tempDir(t);
  const folder = path.join(root, 'sync');
  const a = await device(t, root, 'a', folder);
  const note = a.create({ content: '위치 없음' });
  await waitFor(() => fs.access(path.join(folder, `${note.id}.json`)).then(() => true, () => false), '파일 생성');
  await a.store.drain();
  const onDisk = JSON.parse(await fs.readFile(path.join(folder, `${note.id}.json`), 'utf8'));
  for (const key of ['x', 'y', 'w', 'h', 'alwaysOnTop']) assert.equal(onDisk[key], undefined);
  assert.equal(onDisk.content, '위치 없음');
});

test('두 기기: 추가·편집·삭제가 서로 반영되고 쓰기 루프가 없다', async (t) => {
  const root = await tempDir(t);
  const folder = path.join(root, 'sync');
  const a = await device(t, root, 'a', folder);
  const b = await device(t, root, 'b', folder);

  const created = [];
  b.on('created', (r) => created.push(r.id));
  const note = a.create({ content: '첫 글' });
  await waitFor(() => b.get(note.id), 'B에 생성');
  assert.deepEqual(created, [note.id]);

  b.update(note.id, { content: 'B가 고침', color: 'blue', opacity: 0.4 });
  await waitFor(() => a.get(note.id).content === 'B가 고침', 'A에 편집 반영');
  assert.equal(a.get(note.id).color, 'blue');
  assert.equal(a.get(note.id).opacity, 0.4);

  // 안정된 뒤에는 파일이 더 이상 다시 쓰이지 않아야 한다.
  const file = path.join(folder, `${note.id}.json`);
  await new Promise((resolve) => setTimeout(resolve, 700));
  const before = (await fs.stat(file)).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal((await fs.stat(file)).mtimeMs, before, '쓰기 루프 발생');

  const removed = [];
  b.on('removed', (id) => removed.push(id));
  a.remove(note.id);
  await waitFor(() => b.get(note.id).deleted, 'B에 삭제 반영');
  assert.deepEqual(removed, [note.id]);
  const onDisk = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(onDisk.deleted, true);
  assert.equal(b.active().length, 0);
});

test('새 기기와 재시작: 캐시에서 복원하고 꺼져 있는 동안의 변경을 받아온다', async (t) => {
  const root = await tempDir(t);
  const folder = path.join(root, 'sync');
  const a = await device(t, root, 'a', folder);
  const note = a.create({ content: '원본' });
  await waitFor(() => fs.access(path.join(folder, `${note.id}.json`)).then(() => true, () => false), '파일');
  await a.stop();

  const b = await device(t, root, 'b', folder);
  assert.equal(b.get(note.id).content, '원본');
  b.update(note.id, { content: 'A가 꺼진 동안 수정' });
  await b.store.drain();

  const a2 = new NoteManager({ deviceId: 'a', cachePath: path.join(root, 'a-cache.json'), scanIntervalMs: 0, log: quiet });
  await a2.load();
  assert.equal(a2.get(note.id).content, '원본', '캐시 복원');
  const updates = [];
  a2.on('updated', (r) => updates.push(r.content));
  await a2.setStore(new FolderStore({ folder, log: quiet }));
  t.after(() => a2.stop());
  assert.deepEqual(updates, ['A가 꺼진 동안 수정']);
});

test('오프라인 편집: 폴더 복구 후 올라가고 더 새로운 쪽이 이긴다', async (t) => {
  const root = await tempDir(t);
  const folder = path.join(root, 'sync');
  const a = await device(t, root, 'a', folder);
  const note = a.create({ content: '처음' });
  await a.store.drain();

  // 저장소 쓰기가 실패하는 상황을 흉내 낸다.
  const put = a.store.put;
  a.store.put = async () => { throw new Error('오프라인'); };
  a.update(note.id, { content: '오프라인에서 수정' });
  await waitFor(() => a.status.state === 'offline', '오프라인 전환');
  assert.ok(a.dirty.has(note.id));
  const onDisk = JSON.parse(await fs.readFile(path.join(folder, `${note.id}.json`), 'utf8'));
  assert.equal(onDisk.content, '처음');

  a.store.put = put;
  await a.scan();
  assert.equal(a.dirty.size, 0);
  assert.equal(a.status.state, 'online');
  const synced = JSON.parse(await fs.readFile(path.join(folder, `${note.id}.json`), 'utf8'));
  assert.equal(synced.content, '오프라인에서 수정');
});

test('충돌 사본: 스캔과 감시 모두에서 병합되고 사본은 지워진다', async (t) => {
  const root = await tempDir(t);
  const folder = path.join(root, 'sync');
  const a = await device(t, root, 'a', folder);
  const note = a.create({ content: '본문' });
  await a.store.drain();

  const copyPath = path.join(folder, `${note.id} (충돌 사본).json`);
  await fs.writeFile(copyPath, serializeRecord({ ...note, content: '사본 글', updatedAt: note.updatedAt - 5, deviceId: 'b' }));
  await waitFor(() => a.get(note.id).content.includes('사본 글'), '감시로 병합');
  await waitFor(() => fs.access(copyPath).then(() => false, () => true), '사본 삭제');
  assert.ok(a.get(note.id).content.startsWith('본문'));
  const onDisk = JSON.parse(await fs.readFile(path.join(folder, `${note.id}.json`), 'utf8'));
  assert.equal(onDisk.content, a.get(note.id).content);

  // 깨진 사본은 건드리지 않는다.
  const broken = path.join(folder, `${note.id} (2).json`);
  await fs.writeFile(broken, '{ 깨진 내용');
  await a.scan();
  await fs.access(broken);
});

test('30일 지난 tombstone은 정리하고 그 전에는 남긴다', async (t) => {
  const root = await tempDir(t);
  const folder = path.join(root, 'sync');
  await fs.mkdir(folder, { recursive: true });
  const old = record({ deleted: true, updatedAt: Date.now() - TOMBSTONE_TTL_MS - 1000 });
  const recent = record({ deleted: true, updatedAt: Date.now() - TOMBSTONE_TTL_MS + 60_000 });
  await fs.writeFile(path.join(folder, `${old.id}.json`), serializeRecord(old));
  await fs.writeFile(path.join(folder, `${recent.id}.json`), serializeRecord(recent));
  const a = await device(t, root, 'a', folder);
  await assert.rejects(fs.access(path.join(folder, `${old.id}.json`)));
  await fs.access(path.join(folder, `${recent.id}.json`));
  assert.equal(a.get(old.id), null);
  assert.equal(a.active().length, 0);
});

test('파일을 지우면 다른 기기에서도 사라지지만, 폴더가 통째로 비면 메모를 되살린다', async (t) => {
  const root = await tempDir(t);
  const folder = path.join(root, 'sync');
  const a = await device(t, root, 'a', folder);
  const one = a.create({ content: '하나' });
  const two = a.create({ content: '둘' });
  await a.store.drain();
  // 감시자가 파일을 인식(쓰기 완료 대기)한 뒤에 지워야 unlink 이벤트가 나온다. 그 전에 지운 경우는 주기 스캔이 처리한다.
  await new Promise((resolve) => setTimeout(resolve, 600));

  await fs.rm(path.join(folder, `${one.id}.json`));
  await waitFor(() => a.get(one.id) === null, '삭제 반영');
  assert.ok(a.get(two.id));

  await fs.rm(path.join(folder, `${two.id}.json`));
  await a.scan();
  assert.equal(a.get(two.id).content, '둘');
  await fs.access(path.join(folder, `${two.id}.json`));
});

test('폴더를 바꾸면 기존 메모가 새 폴더에 병합된다', async (t) => {
  const root = await tempDir(t);
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  const a = await device(t, root, 'a', first);
  const note = a.create({ content: '옮길 글' });
  await a.store.drain();

  await fs.mkdir(second);
  const existing = record({ content: '새 폴더에 있던 글', deviceId: 'b', updatedAt: Date.now() });
  await fs.writeFile(path.join(second, `${existing.id}.json`), serializeRecord(existing));

  await a.setStore(new FolderStore({ folder: second, log: quiet }));
  await fs.access(path.join(second, `${note.id}.json`));
  assert.equal(a.get(existing.id).content, '새 폴더에 있던 글');
  assert.equal(a.active().length, 2);
  await fs.access(path.join(first, `${note.id}.json`));
});

test('읽을 수 없는 본문 파일은 삭제로 취급하지 않는다', async (t) => {
  const root = await tempDir(t);
  const folder = path.join(root, 'sync');
  const a = await device(t, root, 'a', folder);
  const note = a.create({ content: '보존' });
  const other = a.create({ content: '다른 메모' });
  await a.store.drain();
  await fs.writeFile(path.join(folder, `${note.id}.json`), '{ 내려받는 중');
  await a.scan();
  assert.equal(a.get(note.id).content, '보존');
  assert.ok(a.get(other.id));
});

test('파일 이름: 경로와 금지 문자를 없애고 위험한 형식을 구분한다', () => {
  assert.equal(sanitizeName('..\\..\\evil.txt'), 'evil.txt');
  assert.equal(sanitizeName('a/b/c.txt'), 'c.txt');
  assert.equal(sanitizeName('a:b*c?.txt'), 'a_b_c_.txt');
  assert.equal(sanitizeName('이름. . '), '이름');
  assert.equal(sanitizeName('..'), 'file');
  assert.ok(sanitizeName(`${'가'.repeat(500)}.pdf`).endsWith('.pdf'));
  for (const name of ['..', '../x', 'a\\b', 'a:b.txt', 'a.txt.', '']) assert.equal(isValidName(name), false, name);
  assert.equal(isValidName('보고서 (1).pdf'), true);
  for (const name of ['a.exe', 'A.BAT', 'x.ps1', 'x.lnk', 'x.exe. ', 'report.pdf.js']) assert.equal(isRiskyName(name), true, name);
  for (const name of ['a.pdf', 'b.docx', 'c.png', 'exe', 'd.txt']) assert.equal(isRiskyName(name), false, name);
});

test('첨부 파일: 추가하면 다른 기기에 알리고 이름이 겹치면 번호를 붙인다', async (t) => {
  const root = await tempDir(t);
  const folder = path.join(root, 'sync');
  const a = await device(t, root, 'a', folder);
  const b = await device(t, root, 'b', folder);
  const note = a.create({ content: '첨부' });
  await waitFor(() => b.get(note.id), 'B에 메모');

  const source = path.join(root, '보고서.pdf');
  await fs.writeFile(source, 'PDF 내용');
  const events = [];
  b.on('attachments', (id) => events.push(id));

  assert.equal(await a.store.addAttachment(note.id, source), '보고서.pdf');
  assert.equal(await a.store.addAttachment(note.id, source), '보고서 (1).pdf');
  await waitFor(() => events.includes(note.id), 'B에 첨부 알림');
  const listed = await b.store.listAttachments(note.id);
  assert.deepEqual(listed.map((file) => [file.name, file.size]), [
    ['보고서 (1).pdf', Buffer.byteLength('PDF 내용')],
    ['보고서.pdf', Buffer.byteLength('PDF 내용')],
  ]);
  assert.equal(await fs.readFile(await b.store.attachmentPath(note.id, '보고서.pdf'), 'utf8'), 'PDF 내용');

  events.length = 0;
  await b.store.removeAttachment(note.id, '보고서.pdf');
  await waitFor(async () => (await a.store.listAttachments(note.id)).length === 1, 'A 목록 갱신');
  await waitFor(() => events.includes(note.id), '삭제 알림');
  // 원본은 그대로 있어야 한다.
  await fs.access(source);
});

test('첨부 파일: 메모 내용을 동시에 고쳐도 목록이 사라지지 않는다', async (t) => {
  const root = await tempDir(t);
  const folder = path.join(root, 'sync');
  const a = await device(t, root, 'a', folder);
  const b = await device(t, root, 'b', folder);
  const note = a.create({ content: '처음' });
  await waitFor(() => b.get(note.id), 'B에 메모');
  const source = path.join(root, 'a.txt');
  await fs.writeFile(source, 'x');
  await a.store.addAttachment(note.id, source);
  b.update(note.id, { content: 'B가 나중에 수정' });
  await waitFor(() => a.get(note.id).content === 'B가 나중에 수정', 'A 반영');
  assert.equal((await a.store.listAttachments(note.id)).length, 1);
});

test('첨부 파일: 메모로 오인하지 않고 임시·시스템 파일과 잘못된 입력을 거른다', async (t) => {
  const root = await tempDir(t);
  const folder = path.join(root, 'sync');
  const a = await device(t, root, 'a', folder);
  const note = a.create({ content: '본문' });
  await a.store.drain();

  // 첨부 폴더 안의 uuid.json 파일은 메모가 아니다.
  const dir = path.join(folder, 'attachments', note.id);
  await fs.mkdir(dir, { recursive: true });
  const fake = record({ content: '가짜 메모' });
  await fs.writeFile(path.join(dir, `${fake.id}.json`), serializeRecord(fake));
  await fs.writeFile(path.join(dir, '.abc.tmp'), 'x');
  await fs.writeFile(path.join(dir, 'desktop.ini'), 'x');
  await new Promise((resolve) => setTimeout(resolve, 600));
  await a.scan();
  assert.equal(a.get(fake.id), null);
  assert.deepEqual((await a.store.listAttachments(note.id)).map((file) => file.name), [`${fake.id}.json`]);

  await assert.rejects(a.store.attachmentPath(note.id, '../../secret.txt'));
  await assert.rejects(a.store.attachmentPath('../..', 'x.txt'));
  await assert.rejects(a.store.removeAttachment(note.id, '..\\x'));
  await assert.rejects(a.store.addAttachment(note.id, root), /폴더는 공유할 수 없습니다/);
  assert.deepEqual(await a.store.listAttachments(crypto.randomUUID()), []);
});

test('첨부 파일: 폴더를 바꾸면 함께 옮기고 tombstone 정리 때 지운다', async (t) => {
  const root = await tempDir(t);
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  const a = await device(t, root, 'a', first);
  const note = a.create({ content: '첨부 메모' });
  await a.store.drain();
  const source = path.join(root, 'a.txt');
  await fs.writeFile(source, '첫 폴더');
  await a.store.addAttachment(note.id, source);

  // 새 폴더에 이미 있는 같은 이름의 파일은 덮어쓰지 않는다.
  const other = crypto.randomUUID();
  await fs.mkdir(path.join(second, 'attachments', other), { recursive: true });
  await fs.writeFile(path.join(second, 'attachments', other, 'keep.txt'), '유지');

  await a.setStore(new FolderStore({ folder: second, log: quiet }));
  assert.equal(await fs.readFile(await a.store.attachmentPath(note.id, 'a.txt'), 'utf8'), '첫 폴더');
  assert.equal(await fs.readFile(await a.store.attachmentPath(other, 'keep.txt'), 'utf8'), '유지');
  await fs.access(path.join(first, 'attachments', note.id, 'a.txt'));

  // 30일이 지나면 메모 파일과 함께 첨부도 정리된다.
  const old = record({ deleted: true, updatedAt: Date.now() - TOMBSTONE_TTL_MS - 1000 });
  await fs.writeFile(path.join(second, `${old.id}.json`), serializeRecord(old));
  await a.store.addAttachment(old.id, source);
  await a.scan();
  await assert.rejects(fs.access(path.join(second, 'attachments', old.id)));
});

test('다른 기기의 시계가 빨라도 이후의 로컬 편집이 이긴다', async (t) => {
  const root = await tempDir(t);
  const folder = path.join(root, 'sync');
  const a = await device(t, root, 'a', folder);
  const b = await device(t, root, 'b', folder, { now: () => Date.now() + 3_600_000 });
  const note = b.create({ content: '미래 시각' });
  await waitFor(() => a.get(note.id), 'A에 생성');
  a.update(note.id, { content: '나중에 고친 글' });
  await waitFor(() => b.get(note.id).content === '나중에 고친 글', 'B에 반영');
});
