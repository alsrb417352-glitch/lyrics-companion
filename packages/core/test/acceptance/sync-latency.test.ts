/**
 * 싱크 지연 줄이기(AT-17): 늦게 읽힌 위치 측정 걸러내기, 다음 행 전환 시각 계산, 전체 보정값.
 * 실제 기기의 오차는 MV-PB-IOS-01에서 화면 녹화로 잰다. 여기서는 합성 측정값으로 규칙만 고정한다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, TRACKS, type Harness } from '../support/harness.js';
import { PositionFilter } from '../../src/sync/position-filter.js';
import { computeSync } from '../../src/sync/sync-engine.js';
import type { PlaybackSnapshot } from '../../src/ports.js';

const open: Harness[] = [];
afterEach(async () => {
  while (open.length)
    await open
      .pop()
      ?.close()
      .catch(() => undefined);
});

const TRACK = TRACKS.jaStudio;

function snap(at: number, positionMs: number | null, status: PlaybackSnapshot['status'] = 'playing'): PlaybackSnapshot {
  return { track: TRACK, status, positionMs, capturedAtMonotonicMs: at, rate: status === 'playing' ? 1 : 0 };
}

/** 결정적 의사 난수(0~1) */
function rng(seed: number): () => number {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}

describe('AT-17 위치 측정 필터', () => {
  it('[AT-17][REQ-SY-02][REQ-SY-01] 측정마다 0~400ms 늦게 읽혀도, 필터 결과는 실제 위치보다 앞서지 않고 오차가 작다', () => {
    const f = new PositionFilter();
    const rand = rng(7);
    const truth = (t: number) => t - 1_000; // 곡 시작 시각 = 단조 시각 1000ms
    let rawWorst = 0;
    let filteredWorst = 0;
    for (let i = 0; i < 80; i++) {
      const at = 2_000 + i * 250;
      const stale = Math.round(rand() * 400);
      const raw = snap(at, truth(at) - stale);
      const out = f.push(raw);
      const err = out.positionMs! - truth(at);
      expect(err, `#${i}`).toBeLessThanOrEqual(0); // 꾸며서 앞서가지 않는다
      if (i >= 12) {
        rawWorst = Math.max(rawWorst, stale);
        filteredWorst = Math.max(filteredWorst, -err);
      }
    }
    expect(rawWorst).toBeGreaterThan(300);
    expect(filteredWorst).toBeLessThan(120);
  });

  it('[AT-17][REQ-SY-02] 한 번 크게 늦은 값은 무시하고, 연속으로 뒤로 가면 탐색으로 보고 따른다', () => {
    const f = new PositionFilter();
    for (let at = 0; at <= 2_000; at += 250) f.push(snap(at, 10_000 + at));
    // 한 번만 1.5초 늦은 값 → 무시
    expect(f.push(snap(2_250, 10_750)).positionMs).toBe(12_250);
    expect(f.push(snap(2_500, 12_500)).positionMs).toBe(12_500);
    // 뒤로 탐색(5초 지점) → 두 번째 측정에서 따른다
    f.push(snap(2_750, 5_000));
    expect(f.push(snap(3_000, 5_250)).positionMs).toBe(5_250);
    // 앞으로 탐색은 바로 따른다
    expect(f.push(snap(3_250, 60_000)).positionMs).toBe(60_000);
  });

  it('[AT-17][REQ-SY-02] 일시정지·위치 없음은 그대로 전달하고 기록을 버린다', () => {
    const f = new PositionFilter();
    for (let at = 0; at <= 1_000; at += 250) f.push(snap(at, 30_000 + at));
    expect(f.push(snap(1_250, 31_000, 'paused')).positionMs).toBe(31_000);
    expect(f.push(snap(1_500, null)).positionMs).toBeNull();
    // 재개 후에는 새 측정 기준
    expect(f.push(snap(5_000, 31_000)).positionMs).toBe(31_000);
  });
});

describe('AT-17 줄 전환 시각·전체 보정', () => {
  it('[AT-17][REQ-SY-01] 다음 행까지 남은 시간을 계산해 화면이 그 순간 다시 그릴 수 있다', () => {
    const lines = [
      { id: 'l0001', text: 'a', startMs: 1_000 },
      { id: 'l0002', text: 'b', startMs: 4_000 },
    ];
    const r = computeSync({
      kind: 'synced',
      lines,
      snapshot: snap(0, 2_500),
      nowMonotonicMs: 100,
      offsetMs: 300,
    });
    expect(r).toMatchObject({ mode: 'synced', activeIndex: 0, nextChangeInMs: 4_000 - (2_600 + 300) });
    const paused = computeSync({
      kind: 'synced',
      lines,
      snapshot: snap(0, 2_500, 'paused'),
      nowMonotonicMs: 100,
      offsetMs: 0,
    });
    expect(paused).toMatchObject({ mode: 'synced', nextChangeInMs: null });
  });

  it('[AT-17][REQ-SY-03][REQ-SY-01] 전체 보정 기본값이 적용되고, 바꾼 값은 재실행 후에도 유지되며 곡별 보정과 더해진다', async () => {
    const h = await createHarness({ autoTranslate: false, defaultGlobalOffsetMs: 300 });
    open.push(h);
    await h.session.onTrackChanged(TRACK);
    await h.session.idle();
    const lines = h.session.current.lyrics!.lines;
    const second = lines.find((l, i) => i > 0 && l.startMs !== null)!;
    const idx = lines.indexOf(second);
    const at = (pos: number) => h.session.syncFor({ ...snap(h.clock.monotonicMs(), pos) });

    expect(h.session.current.globalOffsetMs).toBe(300);
    // 기본 300ms 먼저: 시작 290ms 전에 이미 그 행
    const r1 = at(second.startMs! - 290);
    expect(r1.mode === 'synced' && r1.activeIndex).toBe(idx);
    const r2 = at(second.startMs! - 310);
    expect(r2.mode === 'synced' && r2.activeIndex).toBe(idx - 1);

    await h.session.setGlobalOffset(0);
    await h.session.setOffset(200);
    const r3 = at(second.startMs! - 190);
    expect(r3.mode === 'synced' && r3.activeIndex).toBe(idx);
    const r4 = at(second.startMs! - 210);
    expect(r4.mode === 'synced' && r4.activeIndex).toBe(idx - 1);

    const h2 = await h.restart();
    open.push(h2);
    // restart는 기본값을 넘기지 않지만, 사용자가 정한 0이 저장되어 있어야 한다
    expect(h2.session.current.globalOffsetMs).toBe(0);
  });
});
