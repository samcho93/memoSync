'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRY_DELAYS_MS = [50, 150, 400, 1000];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Windows에서는 클라우드 클라이언트나 백신이 대상 파일을 잠깐 잡고 있으면 rename이 실패하므로 재시도한다.
async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      if (!RETRY_CODES.has(err.code) || attempt >= RETRY_DELAYS_MS.length) throw err;
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

// 같은 폴더의 임시 파일에 쓴 뒤 rename한다. 읽는 쪽은 항상 완전한 파일만 보게 된다.
async function atomicWriteFile(filePath, text) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmp = path.join(dir, `.${base}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    await fs.writeFile(tmp, text, 'utf8');
    await renameWithRetry(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

module.exports = { atomicWriteFile, renameWithRetry };
