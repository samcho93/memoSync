'use strict';

const { localDateKey, removePastSchedules } = require('./schedule');

const CHECK_MS = 60_000;

/**
 * 날짜가 지난 일정 줄을 메모에서 지운다. 일정만 있던 메모는 메모째 지운다.
 * 시작할 때와 날짜가 바뀔 때 한 번씩 실행한다. 입력하는 동안 지난 날짜를 쳤다고 바로 지우지 않기 위해서다.
 * 지운 결과도 보통 편집처럼 동기화되므로, 동기화 폴더를 최신으로 읽은(online) 뒤에만 실행해
 * 오래 꺼져 있던 PC가 옛 내용으로 다른 PC의 편집을 덮어쓰지 않게 한다.
 */
class PastScheduleCleaner {
  constructor({ notes, windows, settings, refreshNote, today = () => localDateKey() }) {
    this.notes = notes;
    this.windows = windows;
    this.settings = settings;
    this.refreshNote = refreshNote;
    this.today = today;
    // 이 날짜까지는 모든 메모를 정리했다. 편집 중이라 건너뛴 메모가 있으면 비워 두고 다시 시도한다.
    this.doneDay = null;
    this.timer = null;
  }

  get enabled() {
    return this.settings.get('removePastSchedules') !== false;
  }

  start() {
    this.timer = setInterval(() => this.check(), CHECK_MS);
    this.check();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  // 오늘 아직 정리하지 않았으면 정리한다. 지운 메모 수를 돌려준다.
  check({ force = false } = {}) {
    if (!this.enabled || this.notes.status.state !== 'online') return 0;
    const today = this.today();
    if (!force && this.doneDay === today) return 0;
    let changed = 0;
    let skipped = false;
    for (const note of this.notes.active()) {
      const result = removePastSchedules(note.content, today);
      if (!result.removed) continue;
      if (this.windows.isEditing(note.id)) {
        skipped = true;
        continue;
      }
      if (result.empty) {
        this.notes.remove(note.id);
      } else {
        this.notes.update(note.id, { content: result.content });
        this.refreshNote(note.id);
      }
      changed += 1;
    }
    this.doneDay = skipped ? null : today;
    return changed;
  }
}

module.exports = { PastScheduleCleaner };
