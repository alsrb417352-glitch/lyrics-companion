import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseLrc, parsePlainLyrics } from '../../src/lyrics/lrc.js';
import { sha256Hex } from '../../src/util/sha256.js';
import { detectLanguage } from '../../src/util/text.js';
import { isValidKanaReading, kanaToHangul } from '../../src/pronunciation/kana-to-hangul.js';
import { fixture } from '../support/harness.js';

describe('LRC 파서', () => {
  it('[REQ-LY-02][REQ-SY-01] 합성 일본어 LRC: 메타데이터 무시, 빈 행 유지, 시간 정렬', () => {
    const r = parseLrc(fixture('lyrics/ja-synced.lrc'));
    expect(r.ok).toBe(true);
    expect(r.metadata['ti']).toBe('夜明けのホーム');
    expect(r.lines).toHaveLength(9);
    expect(r.lines[3]).toEqual({ startMs: 28400, text: '' });
  });

  it('[REQ-LY-02] 시간 없는 행·잘못된 초(75초)가 있으면 잘못된 LRC로 판정한다', () => {
    const r = parseLrc(fixture('lyrics/malformed.lrc'));
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code).sort()).toEqual(['INVALID_TIMESTAMP', 'UNTIMED_LINE']);
    expect(r.errors.find((e) => e.code === 'UNTIMED_LINE')?.lineNumber).toBe(2);
  });

  it('[REQ-SY-01] 소수점 1·2·3자리, 한 행 다중 타임스탬프, offset 태그, 역순 정렬', () => {
    const r = parseLrc('[offset:+500]\n[00:10.5][00:20.25]반복\n[00:05.123]처음\n[01:02]분 단위');
    expect(r.ok).toBe(true);
    expect(r.offsetMs).toBe(500);
    expect(r.lines).toEqual([
      { startMs: 4623, text: '처음' },
      { startMs: 10000, text: '반복' },
      { startMs: 19750, text: '반복' },
      { startMs: 61500, text: '분 단위' },
    ]);
    expect(r.warnings.map((w) => w.code)).toContain('UNSORTED');
  });

  it('[REQ-SY-01] 단어 단위 태그는 제거하고 기록만 남긴다', () => {
    const r = parseLrc(fixture('lyrics/word-sync.lrc'));
    expect(r.hadWordTimings).toBe(true);
    expect(r.lines.map((l) => l.text)).toEqual(['Paper lanterns drifting', 'over the river']);
  });

  it('[REQ-SEC-07] 크기 제한·제어 문자·BOM·CRLF 처리', () => {
    expect(parseLrc('x'.repeat(300 * 1024)).errors[0]?.code).toBe('TOO_LARGE');
    const r = parseLrc('﻿[00:01.00]a\u0007b\r\n[00:02.00]c');
    expect(r.lines.map((l) => l.text)).toEqual(['ab', 'c']);
    expect(parseLrc('').errors[0]?.code).toBe('NO_TIMESTAMPS');
  });

  it('[REQ-SY-04] 일반 가사: 앞뒤 빈 행 제거, 중간 빈 행 유지', () => {
    expect(parsePlainLyrics('\n\n가\n\n나\n\n')).toEqual(['가', '', '나']);
  });
});

describe('해시·언어 감지', () => {
  it.each(['', 'abc', '夜明けの駅で君を待つ', '😀 emoji', 'x'.repeat(1000)])(
    'SHA-256이 node:crypto와 같다: %s',
    (s) => {
      expect(sha256Hex(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
    },
  );

  it('[REQ-TR-02] 곡 언어 감지', () => {
    expect(detectLanguage(['夜明けの駅で', 'Hello'])).toBe('ja');
    expect(detectLanguage(['Paper lanterns', 'over the river'])).toBe('en');
    expect(detectLanguage(['안녕 내 사랑'])).toBe('ko');
    expect(detectLanguage(['我爱你'])).toBe('unknown');
    expect(detectLanguage([''])).toBe('unknown');
  });
});

describe('가나 → 한글 독음', () => {
  it.each([
    ['よあけのえきできみをまつ', '요아케노에키데키미오마츠'],
    ['ありがとう', '아리가토우'],
    ['がっこう', '갓코우'],
    ['しんぶん', '신분'],
    ['きょうは', '쿄우하'],
    ['トーキョー', '토-쿄-'],
    ['ファンタジー', '환타지-'],
    ['ちゃんと', '찬토'],
    ['ん', '응'],
    ['Hello さよなら', 'Hello 사요나라'],
    ['ｶﾀｶﾅ', '카타카나'],
    ['まって!', '맛테!'],
  ])('[REQ-TR-03] %s → %s', (kana, hangul) => {
    expect(kanaToHangul(kana)).toBe(hangul);
  });

  it('[REQ-TR-03][REQ-TR-11] 읽기 검증: 한자가 남아 있으면 거부', () => {
    expect(isValidKanaReading('よあけの えき')).toBe(true);
    expect(isValidKanaReading('Hello さよなら')).toBe(true);
    expect(isValidKanaReading('夜明けの駅')).toBe(false);
  });
});
