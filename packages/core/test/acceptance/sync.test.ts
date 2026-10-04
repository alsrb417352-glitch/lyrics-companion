/**
 * 싱크 수용 테스트(AT-10): 합성 재생 이벤트 스크립트(fixtures/playback)를 가짜 시계로 재생한다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, fixtureJson, TRACKS, type Harness } from '../support/harness.js';
import type { PlaybackSnapshot, PlaybackStatus, ServiceTrackRef } from '../../src/ports.js';

interface Step {
  name: string;
  snapshot?: { status: PlaybackStatus; positionMs: number | null; otherTrack?: boolean };
  setOffsetMs?: number;
  advanceMs: number;
  expect: { mode: 'synced' | 'unknown'; activeLineId?: string | null; reason?: string };
}
interface Script {
  track: ServiceTrackRef;
  steps: Step[];
}

const open: Harness[] = [];
afterEach(async () => {
  while (open.length)
    await open
      .pop()
      ?.close()
      .catch(() => undefined);
});

describe('AT-10 재생 이벤트와 시간 보정', () => {
  it('[AT-10][REQ-SY-01][REQ-SY-02][REQ-SY-03][REQ-PB-01] 일시정지·탐색·백그라운드 복귀·곡 변경·보정에서 올바른 행을 표시한다', async () => {
    const script = fixtureJson<Script>('playback/ja-sync-script.json');
    const h = await createHarness({ autoTranslate: false });
    open.push(h);
    await h.session.onTrackChanged(script.track);
    await h.session.idle();
    const lv = h.session.current.lyrics!;
    let snapshot: PlaybackSnapshot | null = null;

    for (const step of script.steps) {
      if (step.snapshot) {
        snapshot = {
          track: step.snapshot.otherTrack ? { ...TRACKS.enStudio } : script.track,
          status: step.snapshot.status,
          positionMs: step.snapshot.positionMs,
          capturedAtMonotonicMs: h.clock.monotonicMs(),
          rate: 1,
        };
      }
      if (step.setOffsetMs !== undefined) await h.session.setOffset(step.setOffsetMs);
      h.clock.advance(step.advanceMs);
      const r = h.session.syncFor(snapshot);
      expect(r.mode, step.name).toBe(step.expect.mode);
      if (r.mode === 'synced') {
        const id = r.activeIndex === null ? null : lv.lines[r.activeIndex]!.id;
        expect(id, step.name).toBe(step.expect.activeLineId);
        const screen = h.session.screen(snapshot)!;
        const active = screen.rows.filter((row) => row.state === 'active').map((row) => row.lineId);
        expect(active, step.name).toEqual(id ? [id] : []);
      } else if (r.mode === 'unknown') {
        expect(r.reason, step.name).toBe(step.expect.reason);
        expect(
          h.session.screen(snapshot)?.rows.some((row) => row.state === 'active'),
          step.name,
        ).toBe(false);
      }
    }
  });

  it('[AT-10][REQ-SY-03] 곡별 보정값은 저장되어 재실행 후에도 적용되고 다른 곡에는 영향이 없다', async () => {
    const h = await createHarness({ autoTranslate: false });
    open.push(h);
    await h.session.onTrackChanged(TRACKS.jaStudio);
    await h.session.idle();
    await h.session.setOffset(-750);
    await h.session.onTrackChanged(TRACKS.enStudio);
    await h.session.idle();
    expect(h.session.current.offsetMs).toBe(0);
    const h2 = await h.restart();
    open.push(h2);
    await h2.session.onTrackChanged(TRACKS.jaStudio);
    await h2.session.idle();
    expect(h2.session.current.offsetMs).toBe(-750);
  });

  it('[AT-10][REQ-SY-01] AI 응답이 타임스탬프를 포함해도 원문 시간 정보는 바뀌지 않는다', async () => {
    const { fixture } = await import('../support/harness.js');
    const h = await createHarness({ autoTranslate: false });
    open.push(h);
    await h.session.onTrackChanged(TRACKS.jaStudio);
    await h.session.idle();
    const before = h.session.current.lyrics!.lines.map((l) => [l.id, l.startMs]);
    h.provider.respondWith(fixture('ai/ja-timestamp-injection.json'));
    expect((await h.session.requestTranslation())?.kind).toBe('created');
    const lv = await h.store.getLyricsVersion(h.session.current.lyrics!.id);
    expect(lv!.lines.map((l) => [l.id, l.startMs])).toEqual(before);
    expect(Object.keys(h.session.current.translation!.lines).every((k) => /^l\d{4}$/.test(k))).toBe(true);
  });
});
