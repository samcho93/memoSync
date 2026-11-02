'use strict';

const { EventEmitter } = require('node:events');

/**
 * 저장 계층 인터페이스. NoteManager는 이 인터페이스만 알고 있으므로
 * 같은 동작을 구현하면 FolderStore를 서버 방식(Cloudflare Workers + D1 등)으로 교체할 수 있다.
 *
 * 이벤트
 * - 'change'   (record)            다른 쪽에서 레코드가 추가·변경됨. 자기 쓰기는 내보내지 않는다.
 * - 'conflict' ({ id, ref, record }) 병합이 필요한 충돌 레코드가 발견됨
 * - 'removed'  (id)                레코드가 저장소에서 사라짐
 * - 'error'    (err)               감시 중 발생한 오류
 * - 'attachments' (id)             해당 메모의 첨부 파일 목록이 바뀌었을 수 있음
 */
class SyncStore extends EventEmitter {
  /** 저장소를 식별하는 문자열. 바뀌면 NoteManager가 모든 메모를 다시 올린다. */
  get location() { throw new Error('구현되지 않음'); }

  /** 연결·감시를 시작한다. 여러 번 호출해도 안전해야 하며 사용할 수 없으면 reject한다. */
  async start() { throw new Error('구현되지 않음'); }

  async stop() { throw new Error('구현되지 않음'); }

  /**
   * 전체 내용을 읽는다.
   * @returns {Promise<{records: object[], conflicts: {id: string, ref: any, record: object}[], unreadable: string[]}>}
   * unreadable은 존재하지만 지금 읽을 수 없는 레코드의 id다. 삭제된 것으로 취급하면 안 된다.
   */
  async list() { throw new Error('구현되지 않음'); }

  /** 레코드를 저장한다. 반쯤 쓰인 상태가 다른 쪽에 보이면 안 된다. */
  async put(_record) { throw new Error('구현되지 않음'); }

  /** 레코드를 완전히 지운다(보관 기간이 지난 tombstone 정리용). */
  async remove(_id) { throw new Error('구현되지 않음'); }

  async exists(_id) { throw new Error('구현되지 않음'); }

  /** 병합이 끝난 충돌 레코드를 버린다. ref는 'conflict' 이벤트로 받은 값이다. */
  async discardConflict(_ref) { throw new Error('구현되지 않음'); }

  /** 진행 중인 쓰기가 끝날 때까지 기다린다. */
  async drain() { throw new Error('구현되지 않음'); }

  /** 메모의 첨부 파일을 읽는다. @returns {Promise<{name: string, size: number, modifiedAt: number}[]>} */
  async listAttachments(_id) { throw new Error('구현되지 않음'); }

  /** 로컬 파일을 첨부로 복사한다. 이름이 겹치면 번호를 붙이고 실제 이름을 돌려준다. */
  async addAttachment(_id, _sourcePath) { throw new Error('구현되지 않음'); }

  async removeAttachment(_id, _name) { throw new Error('구현되지 않음'); }

  /** 메모의 첨부 파일을 모두 지운다(보관 기간이 지난 tombstone 정리용). */
  async removeAllAttachments(_id) { throw new Error('구현되지 않음'); }

  /** 첨부 파일을 이 PC에서 열 수 있는 경로를 돌려준다. */
  async attachmentPath(_id, _name) { throw new Error('구현되지 않음'); }

  /** 저장소를 옮길 때 이전 저장소의 첨부 파일을 가져온다. 이미 있는 파일은 덮어쓰지 않는다. */
  async importAttachmentsFrom(_store) { throw new Error('구현되지 않음'); }
}

module.exports = { SyncStore };
