#!/usr/bin/env node
// 테스트 실효성 점검(뮤테이션 스모크): 핵심 불변조건 코드를 일부러 망가뜨렸을 때 테스트가 실패하는지 확인한다.
// "항상 통과하는 테스트"를 걸러내기 위한 장치. 원본 파일은 각 시도 후 반드시 복원한다.
// 사용: npm run check:mutation   (약 1~2분)
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
  {
    id: 'M20',
    req: 'REQ-SY-02',
    desc: '위치 필터가 가장 늦은 측정을 고름(가사 지연)',
    file: S('sync/position-filter.ts'),
    find: 'for (const x of this.samples) if (best === null || x.origin > best) best = x.origin;',
    replace: 'for (const x of this.samples) if (best === null || x.origin < best) best = x.origin;',
  },
  {
    id: 'M21',
    req: 'REQ-SY-02',
    desc: '한 번 늦게 읽힌 값을 탐색으로 보고 바로 따름(가사가 뒤로 튐)',
    file: S('sync/position-filter.ts'),
    find: 'if (!prev || Math.abs(prev.origin - origin) >= this.cfg.jumpMs) {',
    replace: 'if (false as boolean) {',
  },
  {
    id: 'M22',
    req: 'REQ-TR-01',
    desc: '추론 모델 요청에 temperature·max_tokens를 그대로 보냄(제공자 오류)',
    file: S('translation/openai-compatible-provider.ts'),
    find: '  if (opts.reasoningEffort) {',
    replace: '  if (opts.reasoningEffort && Math.random() > 2) {',
  },
  {
    id: 'M23',
    req: 'REQ-SY-05',
    desc: '수동 싱크를 일부만 기록했을 때 기록하지 않은 행을 0초로 꾸며냄(진행 조작)',
    file: S('sync/user-timing.ts'),
    find: 'const NEVER = Number.POSITIVE_INFINITY;',
    replace: 'const NEVER = 0;',
  },
  {
    id: 'M24',
    req: 'REQ-SY-05',
    desc: '탭 기록에서 앞 줄보다 이른 시각을 허용',
    file: S('sync/user-timing.ts'),
    find: 'if (ms < prev) return',
    replace: 'if (ms < prev && Math.random() > 2) return',
  },
  {
    id: 'M25',
    req: 'REQ-SY-05',
    desc: '세션이 사용자 싱크 기록을 무시하고 원문 시각만 사용',
    file: S('session/now-playing-session.ts'),
    find: 'const value = effectiveTiming(lv, this.state.timing);',
    replace: 'const value = effectiveTiming(lv, null);',
  },
  {
    id: 'M26',
    req: 'REQ-ST-04',
    desc: '백업 가져오기에서 싱크 기록 검증(가사 행·순서) 제거',
    file: S('backup/backup-file.ts'),
    find: 'if (!checked.ok) fail(`${w}: ${checked.error}`);\n    lines = checked.lines;',
    replace: 'lines = raw as Record<string, number>;',
  },
  {
    id: 'M27',
    req: 'REQ-LY-05',
    desc: '일괄 받기가 이미 가사가 저장된 곡도 다시 조회·덮어씀',
    file: S('batch/playlist-lyrics-batch.ts'),
    find: "let song = resolved.song;\n    if (song.activeLyricsVersionId) return { kind: 'result', status: 'already-saved', songId: song.id };",
    replace: 'let song = resolved.song;',
  },
  {
    id: 'M28',
    req: 'REQ-LY-03',
    desc: '일괄 받기가 같은 녹음인지 불확실한 곡을 확인 없이 새 곡으로 만들어 조회',
    file: S('batch/playlist-lyrics-batch.ts'),
    find: "if (decision.kind === 'candidates') return { kind: 'needs-confirmation' };",
    replace: '// mutated',
  },
  {
    id: 'M29',
    req: 'REQ-LY-05',
    desc: '일괄 받기가 오프라인에서도 멈추지 않고 곡마다 오류로 계속 진행',
    file: S('batch/playlist-lyrics-batch.ts'),
    find: "if (res.kind === 'offline') return { kind: 'stop', reason: 'offline' };",
    replace: '// mutated',
  },
  {
    id: 'M30',
    req: 'REQ-LY-01',
    desc: 'LRCLIB 503 과부하(Retry-After 짧음)를 다시 시도하지 않고 바로 오류로 돌려줌',
    file: S('lyrics/lrclib-client.ts'),
    find: 'if (isTransientStatus(r.status) && transientTries < this.maxTransientRetries) {',
    replace: 'if (isTransientStatus(r.status) && transientTries < 0) {',
  },
  {
    id: 'M31',
    req: 'REQ-LY-01',
    desc: '제목 검색 서버 오류를 "가사 없음"으로 잘못 분류',
    file: S('lyrics/apple-music-lyrics-provider.ts'),
    find: 'if (searchError) return searchError;',
    replace: '// mutated',
  },
  {
    id: 'M32',
    req: 'REQ-LY-05',
    desc: '일괄 받기가 곡 자체 문제(잘못된 LRC)도 서버 오류 연속으로 세어 멈춤',
    file: S('batch/playlist-lyrics-batch.ts'),
    find: 'if (step.transient) consecutiveErrors++;',
    replace: 'consecutiveErrors++;',
  },
  {
    id: 'M33',
    req: 'REQ-TR-06',
    desc: '번역 묶음 적용 시 저장 직전 "내 번역" 재확인 제거(미리보기 뒤 생긴 내 번역 위에 새 버전 추가)',
    file: S('batch/translation-bundle.ts'),
    find: "if ((await store.listTranslations(lv.id)).some((t) => t.origin === 'user')) {\n        report.skippedNow++;",
    replace: 'if (Math.random() > 2) {\n        report.skippedNow++;',
  },
  {
    id: 'M34',
    req: 'REQ-ED-05',
    desc: '번역 묶음 미리보기가 이미 "내 번역"이 있는 곡을 적용 가능으로 표시',
    file: S('batch/translation-bundle.ts'),
    find: "if (versions.some((t) => t.origin === 'user')) return { ...item, status: 'has-user-translation' };",
    replace: '// mutated',
  },
  {
    id: 'M35',
    req: 'REQ-LY-03',
    desc: '번역 묶음이 활성 판본이 아닌(바뀐) 가사 판본에도 번역을 적용 가능으로 표시',
    file: S('batch/translation-bundle.ts'),
    find: "if (!song || song.activeLyricsVersionId !== lv.id) return { ...item, status: 'lyrics-changed' };",
    replace: '// mutated',
  },
  {
    id: 'M36',
    req: 'REQ-ED-05',
    desc: '번역 묶음 내보내기가 이미 "내 번역"이 있는 곡도 포함',
    file: S('batch/translation-bundle.ts'),
    find: "if ((await store.listTranslations(lv.id)).some((t) => t.origin === 'user')) {\n      counts.hasUserTranslation++;\n      continue;\n    }",
    replace: '// mutated',
  },
  {
    id: 'M37',
    req: 'REQ-ED-03',
    desc: '번역 묶음 [발음] 적용 시 저장 직전 "내 발음" 재확인 제거(미리보기 뒤 생긴 내 발음 위에 새 버전 추가)',
    file: S('batch/translation-bundle.ts'),
    find: "if (versions.some((p) => p.origin === 'user')) {\n        r.skippedNow++;",
    replace: 'if (Math.random() > 2) {\n        r.skippedNow++;',
  },
  {
    id: 'M38',
    req: 'REQ-ED-03',
    desc: '번역 묶음 미리보기가 이미 "내 발음"이 있는 곡의 [발음]을 적용 가능으로 표시',
    file: S('batch/translation-bundle.ts'),
    find: "if (versions.some((p) => p.origin === 'user')) {\n    return { pronunciationStatus: 'has-user-pronunciation', pronunciationLines: null };",
    replace:
      "if (Math.random() > 2) {\n    return { pronunciationStatus: 'has-user-pronunciation', pronunciationLines: null };",
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
