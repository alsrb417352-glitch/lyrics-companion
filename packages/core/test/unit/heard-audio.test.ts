/**
 * 소리로 싱크 맞추기 — 네이티브 원시 값 검사와 "오디오 시각 → 재생 위치" 대응(REQ-SY-06, D-44).
 */
import { describe, expect, it } from 'vitest';
import { LISTEN_LIMITS, ListenLog, parseListenChunk } from '../../src/sync/heard-audio.js';
import { rng } from '../support/auto-sync-sim.js';

/** Music 앱 원시 값(스토어 ID 숫자) */
function now(storeId: string, positionMs: number, state = 'playing') {
  return {
    hasItem: true,
    title: `곡 ${storeId}`,
    artist: '합성 가수',
    durationSec: 200,
    storeId,
    state,
    rate: 1,
    positionSec: positionMs / 1000,
  };
}

/** 재생 위치 = 오디오 시각 + offset 으로 0.5초마다 잰 표본(늦게 읽힘 0~lateMs) */
function samples(from: number, to: number, offset: number, storeId = '3001', lateMs = 0, seed = 1, state = 'playing') {
  const r = rng(seed);
  const out: Array<{ audioMs: number; now: Record<string, unknown> }> = [];
  for (let a = from; a <= to; a += 500) out.push({ audioMs: a, now: now(storeId, a + offset - r() * lateMs, state) });
  return out;
}

describe('원시 값 검사', () => {
  it('[REQ-SY-06][REQ-SEC-07] 형식이 틀린 항목은 버리고, 들은 말은 정리·길이 제한, 경로·소리 크기는 아는 값만', () => {
    const c = parseListenChunk({
      segments: [
        { text: 'こんにちは\u0000', startMs: 1_000, endMs: 1_500 },
        { text: 'x'.repeat(1_000), startMs: 2_000, endMs: 2_100 },
        { text: '거꾸로', startMs: 3_000, endMs: 2_000 },
        { text: 123, startMs: 0, endMs: 1 },
        { text: '음수', startMs: -5, endMs: 1 },
        { text: '   ', startMs: 1, endMs: 2 },
        'nope',
      ],
      samples: [{ audioMs: 500, now: now('3001', 1_000) }, { audioMs: Number.NaN, now: {} }, { now: now('1', 1) }],
      audioMs: 4_000,
      levelDb: -30,
      route: 'speaker',
      error: null,
    });
    expect(c.segments.map((s) => s.text.length)).toEqual([5, LISTEN_LIMITS.maxSegmentChars]);
    expect(c.samples).toHaveLength(1);
    expect(c.samples[0]).toMatchObject({ audioMs: 500, key: 'id:3001', status: 'playing', positionMs: 1_000 });
    expect(c.levelDb).toBe(-30);
    expect(c.route).toBe('speaker');
    const junk = parseListenChunk({ route: 'satellite', levelDb: 5, audioMs: -1, error: '  ' });
    expect(junk).toMatchObject({ route: 'unknown', levelDb: null, audioMs: 0, error: null, segments: [], samples: [] });
    expect(parseListenChunk(null).segments).toEqual([]);
  });
});

describe('오디오 시각 → 재생 위치', () => {
  it('[REQ-SY-06][REQ-SY-02] 재생 중 차이가 일정하면 그대로 옮기고, 늦게 읽힌 위치(0~0.3초)에 끌려가지 않는다', () => {
    const log = new ListenLog();
    // 곡을 처음부터 재생: 재생 위치 = 오디오 시각 − 2초(듣기를 2초 먼저 시작)
    log.append(
      parseListenChunk({
        samples: samples(2_000, 60_000, -2_000, '3001', 300),
        segments: [{ text: 'あいう', startMs: 12_000, endMs: 12_600 }],
        audioMs: 60_000,
      }),
    );
    const occ = log.lastOccurrence('id:3001');
    expect(occ).not.toBeNull();
    const w = log.window(occ!);
    expect(w.heard).toHaveLength(1);
    expect(Math.abs(w.heard[0]!.startMs - 10_000)).toBeLessThanOrEqual(100);
    expect(w.coverage!.startMs).toBeLessThanOrEqual(600);
    expect(w.durationMs).toBe(200_000);
  });

  it('[REQ-SY-06][REQ-SY-02] 일시정지 동안 들은 말은 버리고, 다시 재생한 뒤는 바뀐 차이로 옮긴다', () => {
    const log = new ListenLog();
    log.append(
      parseListenChunk({
        samples: [
          ...samples(0, 30_000, 0),
          ...samples(30_500, 40_000, 0, '3001', 0, 1, 'paused').map((s) => ({
            ...s,
            now: now('3001', 30_000, 'paused'),
          })),
          // 10초 쉬고 다시 재생: 위치 = 오디오 − 10초
          ...samples(40_500, 70_000, -10_000),
        ],
        segments: [
          { text: 'まえ', startMs: 20_000, endMs: 20_500 },
          { text: 'ていし', startMs: 35_000, endMs: 35_500 }, // 일시정지 중(잡음)
          { text: 'あと', startMs: 50_000, endMs: 50_500 },
        ],
        audioMs: 70_000,
      }),
    );
    const w = log.window(log.lastOccurrence('id:3001')!);
    expect(w.heard.map((h) => [h.text, Math.round(h.startMs)])).toEqual([
      ['まえ', 20_000],
      ['あと', 40_000],
    ]);
  });

  it('[REQ-SY-06][REQ-PB-01] 다른 곡이 재생되던 동안 들은 말은 쓰지 않고, 뒤로 탐색해 다시 들은 부분은 나중 것을 쓴다', () => {
    const log = new ListenLog();
    log.append(
      parseListenChunk({
        samples: [
          ...samples(0, 20_000, 5_000, '4001'), // 다른 곡
          ...samples(20_500, 50_000, -20_500, '3001'), // 이 곡 처음부터(0 ~ 29.5초)
          ...samples(50_500, 70_000, -40_500, '3001'), // 10초로 되돌아감(10 ~ 29.5초를 다시)
        ],
        segments: [
          { text: 'ほかのきょく', startMs: 10_000, endMs: 10_500 },
          { text: 'いっかいめ', startMs: 35_500, endMs: 36_000 }, // 위치 15초
          { text: 'にかいめ', startMs: 56_000, endMs: 56_500 }, // 위치 15.5초
          { text: 'まえぶぶん', startMs: 25_500, endMs: 26_000 }, // 위치 5초(다시 듣지 않은 부분)
        ],
        audioMs: 70_000,
      }),
    );
    const w = log.window(log.lastOccurrence('id:3001')!);
    expect(w.heard.map((h) => h.text)).toEqual(['まえぶぶん', 'にかいめ']);
    expect(log.lastOccurrence('id:9999')).toBeNull();
    // 다른 곡 구간은 따로 볼 수 있다
    const other = log.window(log.lastOccurrence('id:4001')!);
    expect(other.heard.map((h) => h.text)).toEqual(['ほかのきょく']);
  });

  it('[REQ-SY-06][REQ-PB-01] 같은 곡을 다른 곡 뒤에 다시 들으면 가장 최근에 이어서 들은 구간만 쓴다', () => {
    const log = new ListenLog();
    log.append(
      parseListenChunk({
        samples: [
          ...samples(0, 30_000, 0, '3001'), // 처음 재생(0~30초)
          ...samples(30_500, 50_000, -30_500, '4001'), // 다른 곡
          ...samples(50_500, 60_000, -50_500, '3001'), // 다시 처음부터(0~9.5초만)
        ],
        segments: [
          { text: 'まえのさいせい', startMs: 20_000, endMs: 20_500 }, // 처음 재생의 20초
          { text: 'いまのさいせい', startMs: 55_000, endMs: 55_500 }, // 다시 재생의 4.5초
        ],
        audioMs: 60_000,
      }),
    );
    const occ = log.lastOccurrence('id:3001')!;
    expect(occ.fromAudioMs).toBe(50_500);
    expect(log.window(occ).heard.map((h) => h.text)).toEqual(['いまのさいせい']);
  });

  it('[REQ-SY-06] 표본이 두세 개뿐인 짧은 구간(탐색 직후 늦게 읽힌 값)은 믿지 않는다', () => {
    const log = new ListenLog();
    log.append(
      parseListenChunk({
        samples: [
          { audioMs: 0, now: now('3001', 95_000) }, // 처음으로 돌리기 전 위치가 한 번 읽힘
          ...samples(500, 30_000, -500),
        ],
        segments: [{ text: 'はじめ', startMs: 200, endMs: 400 }],
        audioMs: 30_000,
      }),
    );
    const w = log.window(log.lastOccurrence('id:3001')!);
    expect(w.heard).toEqual([]);
    expect(w.coverage!.endMs).toBeLessThan(31_000);
  });
});
