'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_PAGES = 60;

const PDFJS_DIR = path.dirname(require.resolve('pdfjs-dist/package.json'));
let pdfjsPromise = null;

// pdf.js는 ES 모듈만 제공하므로 처음 쓸 때 불러온다.
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(pathToFileURL(path.join(PDFJS_DIR, 'legacy', 'build', 'pdf.mjs')).href);
  }
  return pdfjsPromise;
}

// pdf.js는 Node에서 이 경로를 fs로 읽는다. 끝에 '/'가 있어야 한다.
const dirUrl = (name) => `${path.join(PDFJS_DIR, name).split(path.sep).join('/')}/`;

class PdfReadError extends Error {}

/**
 * PDF의 쪽마다 글자 조각과 위치를 읽는다. y는 쪽 위에서부터 잰 글자 기준선이다.
 * @returns {Promise<{ width: number, height: number, items: { str: string, x: number, y: number, w: number, size: number }[] }[]>}
 */
async function readPdfText(filePath) {
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_PDF_BYTES) throw new PdfReadError('50MB보다 큰 PDF는 읽지 않습니다.');
  const data = new Uint8Array(await fs.readFile(filePath));
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data,
    // 한글 글꼴은 CMap이 있어야 글자로 바뀐다.
    cMapUrl: dirUrl('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: dirUrl('standard_fonts'),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    if (err && err.name === 'PasswordException') throw new PdfReadError('암호가 걸린 PDF는 읽을 수 없습니다.');
    if (err && err.name === 'InvalidPDFException') throw new PdfReadError('PDF를 열지 못했습니다. 손상되었거나 PDF가 아닌 파일입니다.');
    throw new PdfReadError(`PDF를 열지 못했습니다: ${err && err.message ? err.message : err}`);
  }
  try {
    const pages = [];
    for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n += 1) {
      const page = await doc.getPage(n);
      // 화면 좌표(위가 0)로 바꾸면 쪽 회전과 여백 원점도 함께 반영된다.
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = [];
      for (const item of content.items) {
        if (!item.str || !item.str.trim()) continue;
        const [a, b, c, d, x, y] = pdfjs.Util.transform(viewport.transform, item.transform);
        // 기울거나 세로로 쓴 글자는 표 위치 계산을 흐트러뜨리므로 뺀다.
        if (Math.abs(b) > 0.01 * Math.abs(a) || Math.abs(c) > 0.01 * Math.abs(d)) continue;
        items.push({ str: item.str, x, y, w: item.width, size: Math.abs(d) || item.height || 10 });
      }
      const { width, height } = viewport;
      pages.push({ width, height, items });
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

module.exports = { readPdfText, PdfReadError, MAX_PAGES };
