#!/usr/bin/env node
// PC 확장 프로그램 빌드: src → dist/ (Chrome·Edge에서 "압축해제된 확장 프로그램 로드"로 이 폴더를 고른다)
//   node build.mjs            확장 프로그램 빌드(dist/)
//   node build.mjs --demo     화면 확인용 데모 빌드(../../.tmp/pc-demo/, 확장 프로그램에 포함되지 않음)
//   node build.mjs --demo --serve   데모를 http://127.0.0.1:5178 에서 연다
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import * as esbuild from 'esbuild';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const demo = args.includes('--demo');
const serve = args.includes('--serve');
const OUT = demo ? join(HERE, '..', '..', '.tmp', 'pc-demo') : join(HERE, 'dist');
const SQL_DIST = join(HERE, 'node_modules', 'sql.js', 'dist');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const common = {
  bundle: true,
  target: 'chrome116',
  format: 'iife',
  charset: 'utf8',
  legalComments: 'none',
  logLevel: 'warning',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  minify: !demo,
  sourcemap: demo ? 'inline' : false,
};

if (demo) {
  await esbuild.build({
    ...common,
    entryPoints: [join(HERE, 'src', 'demo', 'demo-main.tsx')],
    outfile: join(OUT, 'panel.js'),
  });
  copyFileSync(join(HERE, 'static', 'panel.css'), join(OUT, 'panel.css'));
  writeFileSync(join(OUT, 'index.html'), readFileSync(join(HERE, 'static', 'panel.html'), 'utf8'));
} else {
  await esbuild.build({ ...common, entryPoints: [join(HERE, 'src', 'panel.tsx')], outfile: join(OUT, 'panel.js') });
  await esbuild.build({
    ...common,
    entryPoints: [join(HERE, 'src', 'background.ts')],
    outfile: join(OUT, 'background.js'),
  });
  await esbuild.build({
    ...common,
    entryPoints: [join(HERE, 'src', 'content', 'page-bridge.ts')],
    outfile: join(OUT, 'page-bridge.js'),
  });
  await esbuild.build({
    ...common,
    entryPoints: [join(HERE, 'src', 'content', 'relay.ts')],
    outfile: join(OUT, 'relay.js'),
  });
  for (const f of ['manifest.json', 'panel.html', 'panel.css']) copyFileSync(join(HERE, 'static', f), join(OUT, f));
  mkdirSync(join(OUT, 'icons'), { recursive: true });
  for (const size of [16, 32, 48, 128]) writeFileSync(join(OUT, 'icons', `icon-${size}.png`), iconPng(size));
}
// SQLite(WebAssembly). 브라우저용 빌드를 그대로 복사한다(eval 없음, wasm-unsafe-eval만 필요).
copyFileSync(join(SQL_DIST, 'sql-wasm-browser.js'), join(OUT, 'sql-wasm.js'));
copyFileSync(join(SQL_DIST, 'sql-wasm-browser.wasm'), join(OUT, 'sql-wasm-browser.wasm'));
console.log(`빌드 완료: ${OUT}`);

if (serve) {
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };
  const port = 5178;
  createServer((req, res) => {
    const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^([/\\])+/, '');
    const file = join(OUT, path === '' ? 'index.html' : path);
    if (!file.startsWith(OUT) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  }).listen(port, '127.0.0.1', () => console.log(`데모: http://127.0.0.1:${port}/`));
}

// ---------------------------------------------------------------- 아이콘(직접 그린 PNG: 둥근 사각형 + 음표 + 가사 줄)

function iconPng(size) {
  const S = 4; // 슈퍼샘플링
  const px = new Uint8Array(size * size * 4);
  const bg = [91, 76, 224];
  const inside = (x, y) => {
    // 0..1 좌표
    const r = 0.22;
    const cx = Math.min(Math.max(x, r), 1 - r);
    const cy = Math.min(Math.max(y, r), 1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  const note = (x, y) => {
    const head = ((x - 0.36) / 0.13) ** 2 + ((y - 0.68) / 0.1) ** 2 <= 1;
    const stem = x >= 0.45 && x <= 0.51 && y >= 0.24 && y <= 0.68;
    const flag = y >= 0.24 && y <= 0.36 && x >= 0.45 && x <= 0.72 && y - 0.24 <= (0.72 - x) * 0.55 + 0.04;
    const line1 = x >= 0.58 && x <= 0.8 && y >= 0.52 && y <= 0.57;
    const line2 = x >= 0.58 && x <= 0.74 && y >= 0.64 && y <= 0.69;
    return head || stem || flag || line1 || line2;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cover = 0;
      let white = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const u = (x + (sx + 0.5) / S) / size;
          const v = (y + (sy + 0.5) / S) / size;
          if (inside(u, v)) {
            cover++;
            if (note(u, v)) white++;
          }
        }
      }
      const i = (y * size + x) * 4;
      const a = cover / (S * S);
      const w = cover ? white / cover : 0;
      px[i] = Math.round(bg[0] * (1 - w) + 255 * w);
      px[i + 1] = Math.round(bg[1] * (1 - w) + 255 * w);
      px[i + 2] = Math.round(bg[2] * (1 - w) + 255 * w);
      px[i + 3] = Math.round(a * 255);
    }
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(px.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 비트 깊이
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
