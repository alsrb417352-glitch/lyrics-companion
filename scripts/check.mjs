#!/usr/bin/env node
// 통합 검사 하네스: 포맷 → 린트 → 타입 → 테스트 → 빌드 → 비밀정보 → 추적성
// 사용: npm run check            (전체)
//       npm run check -- --only test,lint
//       npm run check:fix        (포맷 자동 수정 + 추적성 문서 갱신 후 전체 검사)
// 결과: reports/harness/latest.md, latest.json, history.jsonl
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { binPath, hasNonAscii, ROOT, runNode } from './lib/common.mjs';

const args = process.argv.slice(2);
const fix = args.includes('--fix');
const onlyArg = args.indexOf('--only');
const only = onlyArg >= 0 ? new Set((args[onlyArg + 1] ?? '').split(',').filter(Boolean)) : null;
const REPORT_DIR = join(ROOT, 'reports', 'harness');
const VITEST_JSON = join(REPORT_DIR, 'vitest-results.json');

const steps = [
  {
    name: 'format',
    label: '포맷(Prettier)',
    run: () => runNode(binPath('prettier'), [fix ? '--write' : '--check', '.']),
  },
  {
    name: 'lint',
    label: '정적 분석(ESLint, 아키텍처 경계 포함)',
    run: () => runNode(binPath('eslint'), ['.', '--max-warnings=0']),
  },
  {
    name: 'typecheck',
    label: '타입 검사(테스트 포함)',
    run: () => runNode(binPath('typescript', 'tsc'), ['-p', 'packages/core/tsconfig.json']),
  },
  {
    name: 'test',
    label: '핵심 테스트(Vitest: 단위·수용, 가짜 제공자·가짜 시계·실제 SQLite)',
    run: () => {
      rmSync(join(ROOT, '.tmp', 'test-runs'), { recursive: true, force: true });
      return runNode(binPath('vitest'), [
        'run',
        '--reporter=default',
        '--reporter=json',
        `--outputFile.json=${VITEST_JSON}`,
      ]);
    },
  },
  {
    name: 'build',
    label: '빌드(core, 플랫폼 타입 없이 컴파일)',
    run: () => {
      rmSync(join(ROOT, 'packages', 'core', 'dist'), { recursive: true, force: true });
      return runNode(binPath('typescript', 'tsc'), ['-p', 'packages/core/tsconfig.build.json']);
    },
  },
  {
    name: 'app',
    label: '앱 타입 검사(apps/mobile, 의존성 설치 시에만)',
    run: () => {
      const appDir = join(ROOT, 'apps', 'mobile');
      const tsc = join(appDir, 'node_modules', 'typescript', 'bin', 'tsc');
      if (!existsSync(tsc)) {
        console.log(
          '건너뜀: apps/mobile 의존성이 설치되지 않았습니다(cd apps/mobile && npm ci). 결과는 "skip"으로 기록합니다.',
        );
        return { code: 0, durationMs: 0, skipped: true };
      }
      return runNode(tsc, ['--noEmit', '-p', join(appDir, 'tsconfig.json')]);
    },
  },
  {
    name: 'secrets',
    label: '비밀정보 검사',
    run: () => runNode(join(ROOT, 'scripts', 'scan-secrets.mjs'), []),
  },
  {
    name: 'trace',
    label: '요구사항 추적성(요구사항↔테스트↔문서)',
    run: () =>
      runNode(join(ROOT, 'scripts', 'traceability.mjs'), [fix ? '--write' : '--check', '--results', VITEST_JSON]),
  },
];

mkdirSync(REPORT_DIR, { recursive: true });
const startedAt = new Date();
const results = [];
for (const step of steps) {
  if (only && !only.has(step.name)) continue;
  console.log(`\n━━ [${step.name}] ${step.label}`);
  let r;
  try {
    r = step.run();
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    r = { code: 1, durationMs: 0 };
  }
  results.push({
    name: step.name,
    label: step.label,
    status: r.skipped ? 'skip' : r.code === 0 ? 'pass' : 'fail',
    durationMs: r.durationMs,
  });
  console.log(`   → ${r.skipped ? '건너뜀' : r.code === 0 ? '통과' : '실패'} (${r.durationMs}ms)`);
}

let tests = null;
try {
  const v = JSON.parse(readFileSync(VITEST_JSON, 'utf8'));
  if (!only || only.has('test')) {
    tests = {
      total: v.numTotalTests,
      passed: v.numPassedTests,
      failed: v.numFailedTests,
      skipped: v.numPendingTests + v.numTodoTests,
    };
  }
} catch {
  // 테스트 단계를 실행하지 않은 경우
}

const failed = results.filter((r) => r.status === 'fail');
const summary = {
  startedAt: startedAt.toISOString(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  root: ROOT,
  rootHasSpace: ROOT.includes(' '),
  rootHasNonAscii: hasNonAscii(ROOT),
  only: only ? [...only] : null,
  steps: results,
  tests,
  ok: failed.length === 0,
  scope:
    '자동 검사는 core 도메인 로직(가짜 제공자·가짜 시계·실제 SQLite)과 앱 TypeScript 타입만 검증한다. 실기기, 실제 스트리밍 앱 연동, 실제 AI 호출, iOS 네이티브(Swift) 빌드는 포함하지 않는다(iOS 빌드는 GitHub Actions ios-unsigned-ipa, 실기기는 docs/testing.md 수동 절차).',
};
writeFileSync(join(REPORT_DIR, 'latest.json'), JSON.stringify(summary, null, 2) + '\n');
appendFileSync(join(REPORT_DIR, 'history.jsonl'), JSON.stringify({ ...summary, root: undefined }) + '\n');
const md = [
  '# 하네스 실행 결과 (자동 생성)',
  '',
  `- 실행 시각: ${summary.startedAt}`,
  `- 환경: Node ${summary.node}, ${summary.platform}`,
  `- 경로에 공백: ${summary.rootHasSpace ? '예' : '아니오'}, 비ASCII 문자: ${summary.rootHasNonAscii ? '예' : '아니오'}`,
  `- 결과: ${summary.ok ? '**통과**' : `**실패** (${failed.map((f) => f.name).join(', ')})`}`,
  tests
    ? `- 테스트: ${tests.passed}/${tests.total} 통과, 실패 ${tests.failed}, 건너뜀 ${tests.skipped}`
    : '- 테스트: 실행 안 함',
  '',
  '| 단계 | 내용 | 결과 | 시간(ms) |',
  '|---|---|---|---|',
  ...results.map(
    (r) =>
      `| ${r.name} | ${r.label} | ${r.status === 'pass' ? '통과' : r.status === 'skip' ? '건너뜀' : '실패'} | ${r.durationMs} |`,
  ),
  '',
  `> ${summary.scope}`,
  '',
  '요구사항별 통과 현황: `reports/harness/traceability-run.md`',
  '',
].join('\n');
writeFileSync(join(REPORT_DIR, 'latest.md'), md);
console.log(
  `\n${summary.ok ? '✔ 모든 검사 통과' : `✖ 실패: ${failed.map((f) => f.name).join(', ')}`}  (보고서: reports/harness/latest.md)`,
);
process.exit(summary.ok ? 0 : 1);
