#!/usr/bin/env node
// 요구사항 추적성 검사·생성.
//   --check  : docs/requirements.json ↔ 테스트 태그 ↔ 문서 ↔ 구현 경로 일관성 검사, docs/traceability.md 최신 여부 확인
//   --write  : docs/traceability.md 재생성
//   --results <vitest-json> : 최신 테스트 결과로 요구사항별 통과/실패 집계(reports/harness/traceability-run.md)
// 규칙:
//   - core 상태가 verified/partial이면 [REQ-ID] 태그가 붙은 자동 테스트가 1개 이상 있어야 하고, 결과가 있으면 모두 통과해야 한다.
//   - 테스트 태그는 레지스트리에 있는 ID만 쓸 수 있다.
//   - AT-01~AT-14는 모두 테스트로 존재하고 통과해야 한다.
//   - implementation 경로가 실제로 있어야 하고, manual ID는 docs/testing.md에 정의되어 있어야 한다.
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from './lib/common.mjs';

const args = process.argv.slice(2);
const mode = args.includes('--write') ? 'write' : 'check';
const resultsPath = args.includes('--results') ? args[args.indexOf('--results') + 1] : null;

const reg = JSON.parse(readFileSync(join(ROOT, 'docs', 'requirements.json'), 'utf8'));
const errors = [];
const err = (m) => errors.push(m);

// ---- 테스트 소스 스캔
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') walk(full, out);
    } else if (/\.test\.(ts|mjs)$/.test(e.name)) out.push(full);
  }
  return out;
}
const testFiles = [...walk(join(ROOT, 'packages')), ...walk(join(ROOT, 'scripts', 'test'))];
const TAG_STRING = /(['"`])((?:\[(?:REQ|AT)-[A-Z0-9-]+\])+)[^'"`\n]*\1/g;
const tagIndex = new Map(); // tag -> [{file, title}]
for (const f of testFiles) {
  const src = readFileSync(f, 'utf8');
  let m;
  while ((m = TAG_STRING.exec(src)) !== null) {
    const title = m[0].slice(1, -1);
    for (const t of m[2].match(/(?:REQ|AT)-[A-Z0-9-]+/g)) {
      if (!tagIndex.has(t)) tagIndex.set(t, []);
      tagIndex.get(t).push({ file: relative(ROOT, f).split('\\').join('/'), title });
    }
  }
}

// ---- 테스트 결과
let results = null;
if (resultsPath && existsSync(resultsPath)) {
  const v = JSON.parse(readFileSync(resultsPath, 'utf8'));
  results = new Map(); // tag -> {passed, failed}
  for (const file of v.testResults ?? []) {
    for (const a of file.assertionResults ?? []) {
      const tags = (a.title ?? '').match(/\[((?:REQ|AT)-[A-Z0-9-]+)\]/g) ?? [];
      for (const raw of tags) {
        const t = raw.slice(1, -1);
        const r = results.get(t) ?? { passed: 0, failed: 0, other: 0 };
        if (a.status === 'passed') r.passed++;
        else if (a.status === 'failed') r.failed++;
        else r.other++;
        results.set(t, r);
      }
    }
  }
} else if (resultsPath) {
  err(`테스트 결과 파일이 없습니다: ${resultsPath} (test 단계가 먼저 실행되어야 합니다)`);
}

// ---- 검사
const ids = new Set();
const product = readFileSync(join(ROOT, 'docs', 'product.md'), 'utf8');
const testingDoc = readFileSync(join(ROOT, 'docs', 'testing.md'), 'utf8');
const CORE = new Set(['verified', 'partial', 'not-started', 'n/a']);
const APP = new Set(['done', 'partial', 'not-started', 'n/a']);
for (const r of reg.requirements) {
  if (!/^REQ-[A-Z]+-\d{2}$/.test(r.id)) err(`${r.id}: ID 형식 오류`);
  if (ids.has(r.id)) err(`${r.id}: 중복 ID`);
  ids.add(r.id);
  if (!CORE.has(r.core)) err(`${r.id}: core 상태 값 오류(${r.core})`);
  if (!APP.has(r.app)) err(`${r.id}: app 상태 값 오류(${r.app})`);
  if (!product.includes(r.id)) err(`${r.id}: docs/product.md에 수용 기준이 없습니다`);
  for (const p of r.implementation ?? []) if (!existsSync(join(ROOT, p))) err(`${r.id}: 구현 경로 없음 ${p}`);
  for (const mv of r.manual ?? [])
    if (!testingDoc.includes(mv)) err(`${r.id}: docs/testing.md에 ${mv} 절차가 없습니다`);
  const tests = tagIndex.get(r.id) ?? [];
  if ((r.core === 'verified' || r.core === 'partial') && tests.length === 0) {
    err(`${r.id}: core=${r.core}인데 [${r.id}] 태그가 붙은 자동 테스트가 없습니다`);
  }
  if (results) {
    const res = results.get(r.id);
    if (res?.failed) err(`${r.id}: 실패한 테스트 ${res.failed}건`);
    if ((r.core === 'verified' || r.core === 'partial') && !res?.passed) err(`${r.id}: 통과한 테스트가 없습니다`);
  }
}
const atIds = new Set(reg.acceptanceTests.map((a) => a.id));
for (let i = 1; i <= 14; i++) {
  const id = `AT-${String(i).padStart(2, '0')}`;
  if (!atIds.has(id)) err(`${id}: acceptanceTests에 정의되지 않았습니다`);
  if (!tagIndex.has(id)) err(`${id}: 자동 테스트가 없습니다`);
  if (results) {
    const res = results.get(id);
    if (!res?.passed) err(`${id}: 통과한 테스트가 없습니다`);
    if (res?.failed) err(`${id}: 실패한 테스트 ${res.failed}건`);
  }
}
for (const t of tagIndex.keys()) {
  if (t.startsWith('REQ-') && !ids.has(t)) err(`테스트 태그 ${t}가 레지스트리에 없습니다 (${tagIndex.get(t)[0].file})`);
  if (t.startsWith('AT-') && !atIds.has(t)) err(`테스트 태그 ${t}가 acceptanceTests에 없습니다`);
}

// ---- 문서 생성
const CORE_KO = { verified: '자동검증', partial: '부분', 'not-started': '미구현', 'n/a': '해당없음' };
const APP_KO = { done: '완료', partial: '부분', 'not-started': '미구현', 'n/a': '해당없음' };
function matrix(withResults) {
  const rows = reg.requirements.map((r) => {
    const tests = tagIndex.get(r.id) ?? [];
    const files = [...new Set(tests.map((t) => t.file.replace(/^packages\/core\/test\//, '')))];
    const res = withResults ? results?.get(r.id) : null;
    const auto = tests.length ? `${tests.length}건 (${files.join(', ')})` : '-';
    const runCol = withResults ? ` ${res ? `${res.passed}통과/${res.failed}실패` : '-'} |` : '';
    return `| ${r.id} | ${r.title} | ${CORE_KO[r.core]} | ${APP_KO[r.app]} | ${r.design} | ${(r.implementation ?? []).map((p) => `\`${p}\``).join('<br>')} | ${auto} |${runCol} ${(r.manual ?? []).join(', ') || '-'} |`;
  });
  const head = withResults
    ? '| ID | 요구사항 | core | 앱 | 설계 | 구현 위치 | 자동 테스트 | 최근 실행 | 수동 검증 |\n|---|---|---|---|---|---|---|---|---|'
    : '| ID | 요구사항 | core | 앱 | 설계 | 구현 위치 | 자동 테스트 | 수동 검증 |\n|---|---|---|---|---|---|---|---|';
  const at = reg.acceptanceTests.map((a) => {
    const tests = tagIndex.get(a.id) ?? [];
    const res = withResults ? results?.get(a.id) : null;
    return `| ${a.id} | ${a.title} | ${tests.length}건 |${withResults ? ` ${res ? `${res.passed}통과/${res.failed}실패` : '-'} |` : ''}`;
  });
  const counts = Object.fromEntries(
    Object.keys(CORE_KO).map((k) => [k, reg.requirements.filter((r) => r.core === k).length]),
  );
  return [
    '# 요구사항 추적표 (자동 생성 — 직접 수정하지 말 것)',
    '',
    '원본: `docs/requirements.json` · 생성: `npm run trace:update` · 검사: `npm run trace`',
    '',
    '> **core 자동검증**은 플랫폼 독립 로직을 가짜 제공자·가짜 시계·실제 SQLite로 검증했다는 뜻이다. 실제 스트리밍 앱 연동, 실기기, 실제 AI 호출 성공을 뜻하지 않는다. **앱 부분**은 코드가 있다는 뜻이며 실기기 확인 전에는 완료로 표시하지 않는다.',
    '',
    `요약: 요구사항 ${reg.requirements.length}개 — core 자동검증 ${counts.verified}, 부분 ${counts.partial}, 미구현 ${counts['not-started']}, 해당없음 ${counts['n/a']} / 앱 완료 ${reg.requirements.filter((r) => r.app === 'done').length}, 앱 부분 ${reg.requirements.filter((r) => r.app === 'partial').length}`,
    '',
    head,
    ...rows,
    '',
    '## 필수 자동 검증 사례(AT)',
    '',
    withResults
      ? '| ID | 사례 | 테스트 수 | 최근 실행 |\n|---|---|---|---|'
      : '| ID | 사례 | 테스트 수 |\n|---|---|---|',
    ...at,
    '',
  ].join('\n');
}

const docPath = join(ROOT, 'docs', 'traceability.md');
const generated = matrix(false);
if (mode === 'write') {
  writeFileSync(docPath, generated);
  console.log('docs/traceability.md 갱신');
} else if (!existsSync(docPath) || readFileSync(docPath, 'utf8').replace(/\r\n/g, '\n') !== generated) {
  err('docs/traceability.md가 최신이 아닙니다. "npm run trace:update"를 실행하세요.');
}
if (results) {
  mkdirSync(join(ROOT, 'reports', 'harness'), { recursive: true });
  writeFileSync(
    join(ROOT, 'reports', 'harness', 'traceability-run.md'),
    matrix(true).replace('# 요구사항 추적표', '# 요구사항 추적표 + 최근 실행 결과'),
  );
}

if (errors.length) {
  console.error(`추적성 검사 실패 ${errors.length}건:`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(
  `추적성 검사 통과: 요구사항 ${reg.requirements.length}개, 테스트 파일 ${testFiles.length}개, AT 14개${results ? ', 최근 결과 반영' : ''}`,
);
