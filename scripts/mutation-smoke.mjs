#!/usr/bin/env node
// 테스트 실효성 점검(뮤테이션 스모크): 핵심 불변조건 코드를 일부러 망가뜨렸을 때 테스트가 실패하는지 확인한다.
// "항상 통과하는 테스트"를 걸러내기 위한 장치. 원본 파일은 각 시도 후 반드시 복원한다.
// 사용: npm run check:mutation   (약 30초~1분)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { binPath, ROOT, runNode } from './lib/common.mjs';

const S = (p) => join(ROOT, 'packages', 'core', 'src', ...p.split('/'));

const MUTANTS = [
  {
    id: 'M01',
    req: 'REQ-TR-04',
    desc: '표시 우선순위에서 사용자 번역보다 AI 번역 우선',
    file: S('translation/selection.ts'),
    find: "return latest(versions.filter((v) => v.origin === 'user')) ?? latest(versions.filter((v) => v.origin === 'ai'));\n}\n\nexport function selectPronunciation",
    replace:
      "return latest(versions.filter((v) => v.origin === 'ai')) ?? latest(versions.filter((v) => v.origin === 'user'));\n}\n\nexport function selectPronunciation",
  },
  {
    id: 'M02',
    req: 'REQ-TR-05',
    desc: '저장된 번역이 있어도 새 번역 요청',
    file: S('translation/translation-service.ts'),
    find: "if (existing) return { kind: 'existing', origin: existing.origin, versionId: existing.id };\n    const isJa",
    replace:
      "if (existing && Math.random() > 2) return { kind: 'existing', origin: existing.origin, versionId: existing.id };\n    const isJa",
  },
  {
    id: 'M03',
    req: 'REQ-TR-09',
    desc: '동시 요청 합치기 제거',
    file: S('translation/translation-service.ts'),
    find: 'if (running) return running;',
    replace: 'if (running && Math.random() > 2) return running;',
  },
  {
    id: 'M04',
    req: 'REQ-TR-09',
    desc: '곡 변경 후 오래된 결과 무시 로직 제거',
    file: S('session/now-playing-session.ts'),
    find: 'if (gen !== undefined && gen !== this.state.generation) return; // 오래된 결과 무시',
    replace: '// mutated',
  },
  {
    id: 'M05',
    req: 'REQ-TR-11',
    desc: 'AI 응답의 누락 행 검사 제거',
    file: S('translation/validate.ts'),
    find: "if (missing.length > 0) structural.push({ code: 'MISSING_LINES'",
    replace: "if (missing.length < 0) structural.push({ code: 'MISSING_LINES'",
  },
  {
    id: 'M06',
    req: 'REQ-TR-10',
    desc: '타임아웃을 확정 실패로 처리(결과 미확인 상태 제거)',
    file: S('translation/translation-service.ts'),
    find: "failure.billedRisk === 'possible' ? 'unknown_outcome' : 'failed'",
    replace: "failure.billedRisk === 'possible' ? 'failed' : 'failed'",
  },
  {
    id: 'M07',
    req: 'REQ-SEC-01',
    desc: '로그 마스킹 제거',
    file: S('security/logger.ts'),
    find: 'const safe = data ? (redactValue(data, this.secrets.known()) as Record<string, unknown>) : undefined;',
    replace: 'const safe = data;',
  },
  {
    id: 'M08',
    req: 'REQ-SY-02',
    desc: '오래된 측정값으로 계속 진행 추정',
    file: S('sync/sync-engine.ts'),
    find: "if (elapsed < 0 || elapsed > cfg.maxExtrapolationMs) return { unknown: 'stale' };",
    replace: "if (elapsed < 0) return { unknown: 'stale' };",
  },
  {
    id: 'M09',
    req: 'REQ-LY-03',
    desc: '후보 판정에서 녹음 버전 태그 비교 제거',
    file: S('matching/track-identity.ts'),
    find: 'if (!sameVersionTags(a.versionTags, b.versionTags)) return false;',
    replace: '// mutated',
  },
  {
    id: 'M10',
    req: 'REQ-ST-03',
    desc: '마이그레이션에서 번역 표시 설정 이전 누락',
    file: S('storage/migrations.ts'),
    find: "SELECT 'display.show_translation',",
    replace: "SELECT 'display.show_translation_lost',",
  },
  {
    id: 'M11',
    req: 'REQ-TR-13',
    desc: '자동 번역 동의 검사 제거',
    file: S('translation/translation-service.ts'),
    find: "if (plan.trigger === 'auto' && !(await store.getTranslationSettings()).autoTranslate) {",
    replace: "if (plan.trigger === 'auto' && Math.random() > 2) {",
  },
  {
    id: 'M12',
    req: 'REQ-LY-01',
    desc: 'LRCLIB Retry-After 차단 제거',
    file: S('lyrics/lrclib-client.ts'),
    find: 'if (now < this.blockedUntil) {',
    replace: 'if (now < this.blockedUntil && Math.random() > 2) {',
  },
  {
    id: 'M13',
    req: 'REQ-SY-02',
    desc: 'iOS 재생 위치를 모를 때 0초로 꾸며냄',
    file: S('playback/ios-system-player.ts'),
    find: 'positionMs: track && pos !== null ? Math.round(pos * 1000) : null,',
    replace: 'positionMs: track ? Math.round((pos ?? 0) * 1000) : null,',
  },
  {
    id: 'M14',
    req: 'REQ-SEC-07',
    desc: '곡 검색 응답에서 곡이 아닌 항목(뮤직비디오 등) 허용',
    file: S('catalog/itunes-catalog.ts'),
    find: "if (o['kind'] !== 'song' || o['wrapperType'] !== 'track') return null;",
    replace: "if (o['wrapperType'] !== 'track') return null;",
  },
  {
    id: 'M15',
    req: 'REQ-LY-03',
    desc: '가수 표기가 다른 검색 결과를 사용자 확인 없이 자동 적용',
    file: S('lyrics/apple-music-lyrics-provider.ts'),
    find: 'const sure = ranked.find((r) => knownArtists.has(normalizeArtist(r.artistName)));',
    replace: 'const sure = ranked[0] ?? (knownArtists.size < 0 ? ranked[1] : undefined);',
  },
  {
    id: 'M16',
    req: 'REQ-ST-04',
    desc: '백업 가져오기에서 가사 해시(원문·타임스탬프 변조) 검사 제거',
    file: S('backup/backup-file.ts'),
    find: 'if (computeTextHash(lines) !== textHash || computeContentHash(lines) !== contentHash) {',
    replace: 'if (computeTextHash(lines) !== textHash && computeContentHash(lines) !== contentHash) {',
  },
  {
    id: 'M17',
    req: 'REQ-TR-06',
    desc: '백업 가져오기에서 기기의 사용자 번역보다 백업의 AI 번역 쪽으로 곡 연결을 바꿈',
    file: S('storage/lyrics-store.ts'),
    find: 'if ((await this.songValue(link.songId)) > (await this.songValue(current))) {',
    replace: 'if ((await this.songValue(link.songId)) >= 0) {',
  },
  {
    id: 'M18',
    req: 'REQ-ST-04',
    desc: '백업 가져오기를 트랜잭션 없이 실행(도중 실패 시 일부만 반영)',
    file: S('storage/lyrics-store.ts'),
    find: 'async importUserData(data: UserDataExport, atEpochMs: number): Promise<ImportReport> {\n    return this.q.run(() =>\n      inTransaction(this.db, async () => {',
    replace:
      'async importUserData(data: UserDataExport, atEpochMs: number): Promise<ImportReport> {\n    return this.q.run(() =>\n      (async (_db: unknown, f: () => Promise<ImportReport>) => f())(this.db, async () => {',
  },
  {
    id: 'M19',
    req: 'REQ-ED-03',
    desc: '사용자가 고친 발음 행에 이전 AI 가나 읽기를 그대로 남김',
    file: S('import/user-pronunciation.ts'),
    find: 'lines[id] = { kana: null, hangul };',
    replace: 'lines[id] = { kana: prev?.kana ?? null, hangul };',
  },
];

const vitest = binPath('vitest');
const results = [];
for (const m of MUTANTS) {
  const original = readFileSync(m.file, 'utf8');
  if (!original.includes(m.find)) {
    results.push({ ...m, outcome: 'stale' });
    console.error(`${m.id} 대상 코드를 찾을 수 없습니다(코드가 바뀌었으면 뮤턴트를 갱신하세요): ${m.desc}`);
    continue;
  }
  try {
    writeFileSync(m.file, original.replace(m.find, m.replace));
    const r = runNode(vitest, ['run', '--reporter=dot', '--bail=1'], { capture: true });
    results.push({ ...m, outcome: r.code === 0 ? 'survived' : 'killed' });
    console.log(`${m.id} ${r.code === 0 ? '✖ 생존(테스트가 못 잡음)' : '✔ 검출'}  ${m.req}  ${m.desc}`);
  } finally {
    writeFileSync(m.file, original);
  }
}
const bad = results.filter((r) => r.outcome !== 'killed');
console.log(`\n뮤턴트 ${results.length}개 중 검출 ${results.length - bad.length}개`);
const OUT = { killed: '검출', survived: '생존(테스트 보강 필요)', stale: '대상 코드 없음(뮤턴트 갱신 필요)' };
mkdirSync(join(ROOT, 'reports', 'harness'), { recursive: true });
writeFileSync(
  join(ROOT, 'reports', 'harness', 'mutation-latest.md'),
  [
    '# 뮤테이션 스모크 결과 (자동 생성)',
    '',
    `- 실행 시각: ${new Date().toISOString()} · Node ${process.version} · ${process.platform}`,
    `- 결과: ${results.length}개 중 검출 ${results.length - bad.length}개`,
    '',
    '| ID | 요구사항 | 망가뜨린 내용 | 결과 |',
    '|---|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.req} | ${r.desc} | ${OUT[r.outcome]} |`),
    '',
  ].join('\n'),
);
process.exit(bad.length === 0 ? 0 : 1);
