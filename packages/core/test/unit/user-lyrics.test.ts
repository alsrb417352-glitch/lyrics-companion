import { describe, expect, it } from 'vitest';
import {
  describeUserLyricsError,
  describeUserLyricsWarning,
  parseUserLyrics,
  USER_LYRICS_LIMITS,
} from '../../src/lyrics/user-lyrics.js';

// 합성 가사만 사용한다(실제 곡 가사 없음).

describe('직접 등록 가사 해석(D-40)', () => {
  it('[REQ-LY-06][REQ-LY-02] 시간 표시가 없으면 일반 가사: 앞뒤 빈 줄 제거·중간 빈 줄 유지·BOM·CRLF 처리', () => {
    const r = parseUserLyrics('﻿\r\n一行目\r\n二行目\r\n\r\n三行目\r\n\r\n');
    expect(r.ok && r.kind).toBe('plain');
    if (!r.ok || r.kind !== 'plain') return;
    expect(r.plain).toEqual(['一行目', '二行目', '', '三行目']);
    expect(r.lineCount).toBe(3);
    expect(r.warnings).toEqual([]);
  });

  it('[REQ-LY-06][REQ-SY-04] 행 시간 표시가 있으면 LRC(싱크 가사) — offset·머리 정보 처리, 시간은 입력 값 그대로', () => {
    const r = parseUserLyrics(
      '[ti:합성 곡]\n[ar:합성 가수]\n[offset:500]\n[00:12.00]一行目\n[00:17.50]二行目\n[00:23.00]',
      {
        durationMs: 60_000,
      },
    );
    expect(r.ok && r.kind).toBe('synced');
    if (!r.ok || r.kind !== 'synced') return;
    expect(r.timed).toEqual([
      { startMs: 11_500, text: '一行目' },
      { startMs: 17_000, text: '二行目' },
      { startMs: 22_500, text: '' },
    ]);
    expect(r.lineCount).toBe(2);
    expect(r.warnings).toEqual([]);
  });

  it('[REQ-LY-06][REQ-SY-04] 단어 단위 시간은 지우고 경고, 뒤섞인 순서는 정렬 경고, 곡 길이보다 뒤면 경고', () => {
    const r = parseUserLyrics('[00:30.00]<00:30.00>二<00:31.00>行目\n[00:10.00]一行目', { durationMs: 20_000 });
    expect(r.ok && r.kind).toBe('synced');
    if (!r.ok || r.kind !== 'synced') return;
    expect(r.timed.map((t) => t.text)).toEqual(['一行目', '二行目']);
    expect(r.hasWordTiming).toBe(true);
    expect(r.warnings).toEqual(['word-sync-ignored', 'unsorted', 'beyond-duration']);
  });

  it('[REQ-LY-06][REQ-SY-04] 시간 없는 줄이 섞인 LRC는 저장 불가 — 시간을 끼워 맞추지 않고, "시간 정보 없이"를 고르면 시간을 지운 일반 가사', () => {
    const input = '[ti:합성]\n[00:01.00]一行目\n二行目\n[00:09.00]<00:09.00>三行目';
    const r = parseUserLyrics(input);
    expect(r).toEqual({
      ok: false,
      error: { code: 'INVALID_LRC', issue: 'UNTIMED_LINE', lineNumber: 3, canUseAsPlain: true },
    });
    if (!r.ok) expect(describeUserLyricsError(r.error)).toContain('3번째 줄');

    const plain = parseUserLyrics(input, { format: 'plain' });
    expect(plain.ok && plain.kind).toBe('plain');
    if (!plain.ok || plain.kind !== 'plain') return;
    expect(plain.plain).toEqual(['一行目', '二行目', '三行目']);
    expect(plain.warnings).toEqual(['timestamps-removed']);
  });

  it('[REQ-LY-06] 틀린 시간 표시는 저장 불가', () => {
    const r = parseUserLyrics('[00:75.00]一行目');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: 'INVALID_LRC', issue: 'INVALID_TIMESTAMP', lineNumber: 1 });
  });

  it('[REQ-LY-06] "[Chorus]" 같은 가사 줄은 머리 정보로 지우지 않는다', () => {
    const r = parseUserLyrics('[Chorus]\n一行目\n[Verse 1: 합성]\n二行目');
    expect(r.ok && r.kind === 'plain' && r.plain).toEqual(['[Chorus]', '一行目', '[Verse 1: 합성]', '二行目']);
  });

  it('[REQ-LY-06][REQ-SEC-07] 빈 입력·너무 큼·너무 많은 줄·너무 긴 줄은 거부, 제어 문자는 지움', () => {
    expect(parseUserLyrics('  \n\n ')).toEqual({ ok: false, error: { code: 'EMPTY' } });
    expect(parseUserLyrics('[00:01.00]\n[00:02.00]  ')).toEqual({ ok: false, error: { code: 'EMPTY' } });
    expect(parseUserLyrics('a'.repeat(USER_LYRICS_LIMITS.maxChars + 1))).toEqual({
      ok: false,
      error: { code: 'TOO_LARGE' },
    });
    const many = Array.from({ length: USER_LYRICS_LIMITS.maxLines + 1 }, (_, i) => `행${i}`).join('\n');
    expect(parseUserLyrics(many)).toMatchObject({ ok: false, error: { code: 'TOO_MANY_LINES' } });
    const long = parseUserLyrics(`一行目\n${'あ'.repeat(USER_LYRICS_LIMITS.maxLineChars + 1)}`);
    expect(long).toEqual({ ok: false, error: { code: 'LINE_TOO_LONG', lineNumber: 2 } });

    const ctrl = parseUserLyrics('一\u0007行目\n二行目\u0000');
    expect(ctrl.ok && ctrl.kind === 'plain' && ctrl.plain).toEqual(['一行目', '二行目']);
  });

  it('[REQ-LY-06] 깨진 글자(�)가 있으면 경고', () => {
    const r = parseUserLyrics('一行目\n��目');
    expect(r.ok && r.warnings).toEqual(['replacement-chars']);
  });

  it('[REQ-LY-06] 모든 오류·경고에 한국어 안내가 있다', () => {
    for (const w of [
      'word-sync-ignored',
      'unsorted',
      'beyond-duration',
      'replacement-chars',
      'timestamps-removed',
    ] as const) {
      expect(describeUserLyricsWarning(w).length).toBeGreaterThan(5);
    }
    expect(describeUserLyricsError({ code: 'EMPTY' })).toContain('없습니다');
    expect(describeUserLyricsError({ code: 'TOO_MANY_LINES', lines: 3000 })).toContain('3000');
  });
});
