'use strict';

// 포스트잇 모양 아이콘을 외부 도구 없이 생성한다: assets/icon.ico, tray.png, tray@2x.png
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT = path.join(__dirname, '..', 'assets');
const SUPERSAMPLE = 4;

const NOTE = [255, 214, 74];
const FOLD = [214, 164, 28];
const LINE = [120, 88, 10];

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r ** 2;
}

// 0~1 좌표계의 한 점 색상. 투명이면 null
function colorAt(u, v) {
  const m = 0.06;
  if (!inRoundedRect(u, v, m, m, 1 - m, 1 - m, 0.1)) return null;
  // 오른쪽 아래 접힌 모서리
  const fold = u + v - (2 - 2 * m - 0.34);
  if (fold > 0) return null;
  if (fold > -0.0001 - 0.17 && u > 1 - m - 0.34 && v > 1 - m - 0.34) return FOLD;
  for (const y of [0.3, 0.46, 0.62]) {
    const end = y === 0.62 ? 0.55 : 0.76;
    if (u > 0.22 && u < end && Math.abs(v - y) < 0.045) return LINE;
  }
  return NOTE;
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const n = SUPERSAMPLE;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < n; sy += 1) {
        for (let sx = 0; sx < n; sx += 1) {
          const c = colorAt((x + (sx + 0.5) / n) / size, (y + (sy + 0.5) / n) / size);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 1; }
        }
      }
      const i = (y * size + x) * 4;
      if (a) {
        pixels[i] = Math.round(r / a);
        pixels[i + 1] = Math.round(g / a);
        pixels[i + 2] = Math.round(b / a);
        pixels[i + 3] = Math.round((a / (n * n)) * 255);
      }
    }
  }
  return pixels;
}

function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 작은 크기는 호환성이 좋은 BMP(DIB)로, 256은 PNG로 넣는다.
function encodeDib(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const bgra = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const from = (y * size + x) * 4;
      const to = ((size - 1 - y) * size + x) * 4;
      bgra[to] = rgba[from + 2];
      bgra[to + 1] = rgba[from + 1];
      bgra[to + 2] = rgba[from];
      bgra[to + 3] = rgba[from + 3];
    }
  }
  const maskRow = Math.ceil(size / 32) * 4;
  return Buffer.concat([header, bgra, Buffer.alloc(maskRow * size)]);
}

function encodeIco(sizes) {
  const images = sizes.map((size) => {
    const rgba = render(size);
    return { size, data: size >= 256 ? encodePng(rgba, size) : encodeDib(rgba, size) };
  });
  const dir = Buffer.alloc(6 + images.length * 16);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(images.length, 4);
  let offset = dir.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    dir[e] = size >= 256 ? 0 : size;
    dir[e + 1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([dir, ...images.map((image) => image.data)]);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'tray.png'), encodePng(render(16), 16));
fs.writeFileSync(path.join(OUT, 'tray@2x.png'), encodePng(render(32), 32));
fs.writeFileSync(path.join(OUT, 'icon.ico'), encodeIco([16, 24, 32, 48, 64, 128, 256]));
fs.writeFileSync(path.join(OUT, 'icon.png'), encodePng(render(256), 256));
console.log('아이콘 생성 완료:', OUT);
