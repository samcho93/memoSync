'use strict';

const { serializeRecord } = require('./record');

// last-write-wins. 시각이 같으면 deviceId, 그래도 같으면 직렬화 결과로 정해
// 모든 기기가 같은 승자를 고르게 한다.
function pickWinner(a, b) {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  if (a.deviceId !== b.deviceId) return a.deviceId > b.deviceId ? a : b;
  return serializeRecord(a) >= serializeRecord(b) ? a : b;
}

function formatUtc(ms) {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

// 본문 파일과 클라우드 충돌 사본을 합친 레코드를 돌려준다.
// 진 쪽 글도 잃지 않도록 본문에 덧붙이며, 입력이 같으면 어느 기기에서 실행해도 결과가 같다.
function resolveConflict(main, copy) {
  const winner = pickWinner(main, copy);
  const loser = winner === main ? copy : main;

  // 삭제가 얽혔거나 진 쪽 글이 이미 포함되어 있으면 합칠 것이 없다.
  if (winner.deleted || loser.deleted) return winner;
  if (!loser.content.trim() || winner.content.includes(loser.content)) return winner;

  const separator = `--- 충돌 사본에서 병합됨 (${formatUtc(loser.updatedAt)}) ---`;
  return {
    ...winner,
    content: winner.content.trim()
      ? `${winner.content}\n\n${separator}\n${loser.content}`
      : loser.content,
    createdAt: Math.min(winner.createdAt, loser.createdAt),
    updatedAt: winner.updatedAt + 1,
  };
}

module.exports = { pickWinner, resolveConflict };
