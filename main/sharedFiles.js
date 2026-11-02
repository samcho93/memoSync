'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { app, dialog, shell } = require('electron');
const { isRiskyName } = require('./sync/attachmentNames');

function describeError(err) {
  switch (err.code) {
    case 'ENOENT': return '파일을 찾을 수 없습니다.';
    case 'EACCES':
    case 'EPERM':
    case 'EBUSY': return '파일이 사용 중이거나 권한이 없습니다.';
    case 'ENOSPC': return '저장 공간이 부족합니다.';
    default: return err.message;
  }
}

/** 메모에 첨부된 공유 파일의 추가·열기·저장·삭제와 메모 창 목록 갱신을 맡는다. */
class SharedFiles {
  constructor({ notes, windows }) {
    this.notes = notes;
    this.windows = windows;
    // 메모 id → 창에 마지막으로 보낸 목록. 바뀌었을 때만 다시 보낸다.
    this.sent = new Map();
  }

  get store() {
    if (!this.notes.store) throw new Error('동기화 폴더에 연결되어 있지 않습니다.');
    return this.notes.store;
  }

  async list(id) {
    try {
      const files = await this.store.listAttachments(id);
      this.sent.set(id, JSON.stringify(files));
      return files;
    } catch (err) {
      console.warn(`[sharedFiles] 목록 읽기 실패: ${err.message}`);
      return [];
    }
  }

  async refresh(id) {
    if (!this.windows.has(id)) return;
    const previous = this.sent.get(id);
    const files = await this.list(id);
    if (JSON.stringify(files) !== previous) this.windows.send(id, 'note:attachments', files);
  }

  // 감시 이벤트를 놓친 경우를 대비해 주기 스캔 때마다 호출된다.
  async refreshAll() {
    for (const id of this.windows.ids) await this.refresh(id);
  }

  forget(id) {
    this.sent.delete(id);
  }

  async addPaths(id, paths) {
    const errors = [];
    for (const sourcePath of paths) {
      try {
        await this.store.addAttachment(id, sourcePath);
      } catch (err) {
        errors.push({ name: path.basename(sourcePath), message: describeError(err) });
      }
    }
    await this.refresh(id);
    return { errors };
  }

  async addViaDialog(id) {
    const result = await dialog.showOpenDialog(this.windows.windowOf(id), {
      title: '공유할 파일 선택',
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled) return { errors: [] };
    return this.addPaths(id, result.filePaths);
  }

  // 실행될 수 있는 형식은 다른 PC에서 온 파일이 클릭만으로 실행되지 않도록 폴더에서 보여 주기만 한다.
  async open(id, name) {
    try {
      const filePath = await this.store.attachmentPath(id, name);
      await fs.access(filePath);
      if (isRiskyName(name)) {
        shell.showItemInFolder(filePath);
        return { notice: '실행될 수 있는 파일이라 바로 열지 않고 폴더에서 보여 줍니다.' };
      }
      const error = await shell.openPath(filePath);
      return error ? { error: `파일을 열 수 없습니다: ${error}` } : {};
    } catch (err) {
      return { error: describeError(err) };
    }
  }

  async saveAs(id, name) {
    try {
      const filePath = await this.store.attachmentPath(id, name);
      const result = await dialog.showSaveDialog(this.windows.windowOf(id), {
        title: '다른 이름으로 저장',
        defaultPath: path.join(app.getPath('downloads'), name),
      });
      if (result.canceled || !result.filePath) return {};
      await fs.copyFile(filePath, result.filePath);
      return { notice: '저장했습니다.' };
    } catch (err) {
      return { error: describeError(err) };
    }
  }

  async remove(id, name) {
    try {
      await this.store.removeAttachment(id, name);
      await this.refresh(id);
      return {};
    } catch (err) {
      return { error: describeError(err) };
    }
  }
}

module.exports = { SharedFiles };
