import { describe, expect, it } from 'vitest';
import { buildLyricsVersion } from '../../src/lyrics/lyrics-version.js';
import { parseLrc } from '../../src/lyrics/lrc.js';
import { buildTranslationRequest, PROMPT_VERSION } from '../../src/translation/prompt.js';
import { validateTranslationResponse } from '../../src/translation/validate.js';
import { selectTranslation } from '../../src/translation/selection.js';
import type { TranslationVersion } from '../../src/model.js';
import { fixture } from '../support/harness.js';

function jaLyrics() {
  return buildLyricsVersion({
    id: 'lv1',
    songId: 's1',
    source: 'lrclib',
    sourceRef: null,
    kind: 'synced',
    timed: parseLrc(fixture('lyrics/ja-synced.lrc')).lines,
    createdAtEpochMs: 0,
  });
}

describe('번역 요청 계약', () => {
  it('[REQ-TR-12][REQ-SEC-07] 빈 행 제외, 행 ID 포함, 시간 정보 미포함, 읽기 필요 행 표시', () => {
    const req = buildTranslationRequest(jaLyrics(), { wantTranslation: true, wantReading: true });
    const payload = JSON.parse(req.user) as { lines: Array<Record<string, unknown>>; reading_required_ids: string[] };
    expect(payload.lines.map((l) => l['id'])).toEqual(['l0001', 'l0002', 'l0003', 'l0005', 'l0006', 'l0007', 'l0008']);
    expect(payload.lines.every((l) => Object.keys(l).sort().join() === 'id,text')).toBe(true);
    expect(payload.reading_required_ids).toHaveLength(7);
    expect(req.user).not.toMatch(/startMs|\d{2}:\d{2}\.\d{2}/);
    expect(req.system).toContain('원문에 없는 내용을 덧붙이지 않는다');
    expect(PROMPT_VERSION).toMatch(/^translate-ko\/v\d+$/);
  });

  it('[REQ-TR-02] 영어 곡은 읽기 스키마 없이 번역만 요청할 수 있다', () => {
    const en = buildLyricsVersion({
      id: 'lv2',
      songId: 's2',
      source: 'lrclib',
      sourceRef: null,
      kind: 'synced',
      timed: parseLrc(fixture('lyrics/en-synced.lrc')).lines,
      createdAtEpochMs: 0,
    });
    const req = buildTranslationRequest(en, { wantTranslation: true, wantReading: false });
    expect(JSON.stringify(req.responseSchema)).not.toContain('reading');
    expect(req.expected.every((e) => !e.needsReading)).toBe(true);
  });
});

describe('AI 응답 검증', () => {
  const req = buildTranslationRequest(jaLyrics(), { wantTranslation: true, wantReading: true });

  it('[REQ-TR-11] 정상 응답과 코드 펜스 응답을 받아들인다', () => {
    for (const f of ['ai/ja-valid.json', 'ai/ja-fenced-valid.txt']) {
      const v = validateTranslationResponse(fixture(f), req);
      expect(v.structural).toEqual([]);
      expect(v.translation?.ok).toBe(true);
      expect(v.reading?.ok).toBe(true);
    }
  });

  it.each([
    ['ai/ja-missing-line.json', 'MISSING_LINES'],
    ['ai/ja-duplicate-id.json', 'DUPLICATE_ID'],
    ['ai/ja-wrong-order.json', 'ORDER_MISMATCH'],
    ['ai/ja-unknown-id.json', 'UNKNOWN_ID'],
    ['ai/ja-not-json.txt', 'NOT_JSON'],
    ['ai/ja-refusal-status.json', 'REFUSAL'],
  ])('[REQ-TR-11] %s → %s', (file, code) => {
    const v = validateTranslationResponse(fixture(file), req);
    expect(v.structural.map((i) => i.code)).toContain(code);
    expect(v.translation?.ok).toBe(false);
  });

  it('[REQ-TR-11] 사과문으로 채운 응답은 거절로 판정한다', () => {
    const v = validateTranslationResponse(fixture('ai/ja-refusal-text.json'), req);
    expect(v.translation?.ok === false && v.translation.issues[0]?.code).toBe('REFUSAL');
  });

  it('[REQ-TR-11][REQ-SEC-07] 너무 큰 응답·이상한 형태를 거부한다', () => {
    expect(validateTranslationResponse('x'.repeat(1_000_001), req).structural[0]?.code).toBe('TOO_LARGE');
    expect(validateTranslationResponse('[]', req).structural[0]?.code).toBe('BAD_SHAPE');
    expect(validateTranslationResponse('{"status":"ok","lines":[1,2]}', req).structural[0]?.code).toBe('BAD_SHAPE');
  });
});

describe('표시 번역 선택 우선순위', () => {
  const t = (origin: 'user' | 'ai', seq: number): TranslationVersion => ({
    id: `${origin}${seq}`,
    lyricsVersionId: 'lv',
    origin,
    lines: {},
    sourceTextHash: '',
    provenance: null,
    createdAtEpochMs: 0,
    seq,
  });

  it('[REQ-TR-04][REQ-TR-08] 사용자 → 최신 AI → 없음', () => {
    expect(selectTranslation([])).toBeNull();
    expect(selectTranslation([t('ai', 1), t('ai', 3)])?.id).toBe('ai3');
    expect(selectTranslation([t('ai', 5), t('user', 2), t('ai', 9)])?.id).toBe('user2');
    expect(selectTranslation([t('user', 2), t('user', 4)])?.id).toBe('user4');
  });
});
