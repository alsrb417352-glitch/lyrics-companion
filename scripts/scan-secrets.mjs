#!/usr/bin/env node
// 저장소 비밀정보 검사: 키 형태 문자열, .env·키 파일 존재 여부를 검사한다. 발견 시 종료 코드 1.
// 사용: node scripts/scan-secrets.mjs [--json]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from './lib/common.mjs';
import { isForbiddenFileName, scanText } from './lib/secret-patterns.mjs';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.tmp', 'local-data']);
const MAX_BYTES = 5 * 1024 * 1024;

export function scanRepository(root = ROOT) {
  const findings = [];
  let files = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(root, full).split('\\').join('/');
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const forbidden = isForbiddenFileName(entry.name);
      if (forbidden) findings.push({ file: rel, rule: forbidden, line: 0, preview: '파일 자체가 금지 대상' });
      if (statSync(full).size > MAX_BYTES) continue;
      const buf = readFileSync(full);
      if (buf.subarray(0, 8192).includes(0)) continue; // 바이너리
      files++;
      for (const f of scanText(buf.toString('utf8'))) findings.push({ file: rel, ...f });
    }
  };
  walk(root);
  return { files, findings };
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const { files, findings } = scanRepository();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ files, findings }, null, 2));
  } else if (findings.length === 0) {
    console.log(`비밀정보 검사 통과: ${files}개 텍스트 파일, 발견 0건`);
  } else {
    console.error(`비밀정보 의심 ${findings.length}건 (${files}개 파일 검사):`);
    for (const f of findings) console.error(`  ${f.file}:${f.line}  [${f.rule}]  ${f.preview}`);
    console.error('실제 키라면 즉시 폐기·재발급하고 파일에서 제거하세요. 테스트용 가짜 값은 실행 중에 조립하세요.');
  }
  process.exit(findings.length === 0 ? 0 : 1);
}
