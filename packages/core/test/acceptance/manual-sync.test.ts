/**
 * 수동 싱크(탭 기록) 수용 테스트(AT-18, REQ-SY-05, docs/plan.md D-28).
 * 자동 싱크가 안 되는 경우(시간 정보 없는 가사, 시간이 틀린 가사)에 사용자가 노래를 들으며 줄마다 탭해 시간을 기록한다.
 * - 기록한 시간만 쓴다(AI·추정으로 시간을 만들지 않음). 가사 판본·번역·발음은 그대로 유지.
 * - 끝까지 기록하지 않았으면 기록하지 않은 행은 강조하지 않는다(진행을 꾸며내지 않음).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, TRACKS, type Harness } from '../support/harness.js';
import { LATEST_SCHEMA_VERSION } from '../../src/storage/migrations.js';
import { parseBackup } from '../../src/backup/backup-file.js';
import {
  buildTimingFromTaps,
  effectiveTiming,
  selectUserTiming,
  timingTargets,
  validateUserTiming,
} from '../../src/sync/user-timing.js';
import type { PlaybackSnapshot, ServiceTrackRef } from '../../src/ports.js';
import type { LyricsVersion, UserTimingVersion } from '../../src/model.js';
import { buildLyricsVersion } from '../../src/lyrics/lyrics-version.js';

const open: Harness[] = [];
async function harness(...args: Parameters<typeof createHarness>): Promise<Harness> {
  const h = await createHarness(...args);
  open.push(h);
  return h;
}
afterEach(async () => {
  while (open.length)
    await open
      .pop()
      ?.close()
      .catch(() => undefined);
});

function snapAt(h: Harness, track: ServiceTrackRef, positionMs: number, status: PlaybackSnapshot['status'] = 'paused') {
  return {
    track,
    status,
    positionMs,
    capturedAtMonotonicMs: h.clock.monotonicMs(),
    rate: status === 'playing' ? 1 : 0,
  } satisfies PlaybackSnapshot;
}

function plainLyrics(): LyricsVersion {
  return buildLyricsVersion({
    id: 'lv_x',
    songId: 'song_x',
    source: 'lrclib',
    sourceRef: null,
    kind: 'plain',
    plain: ['', 'A', 'B', '', 'C', 'D', ''],
    createdAtEpochMs: 0,
  });
}

function timingOf(lv: LyricsVersion, lines: Record<string, number>, seq = 1): UserTimingVersion {
  return {
    id: `tm${seq}`,
    lyricsVersionId: lv.id,
    kind: 'timed',
    lines,
    sourceTextHash: lv.textHash,
    createdAtEpochMs: 0,
    seq,
  };
}

describe('AT-18 탭 기록 규칙(순수 함수)', () => {
  it('[AT-18][REQ-SY-05] 빈 행은 기록 대상이 아니고, 다음 기록 행과 같은 시각이라 따로 강조되지 않는다', () => {
    const lv = plainLyrics();
    expect(timingTargets(lv).map((l) => l.text)).toEqual(['A', 'B', 'C', 'D']);
    const built = buildTimingFromTaps(lv, [1000, 2000, 3000, 4000]);
    expect(built.ok).toBe(true);
    const eff = effectiveTiming(lv, timingOf(lv, built.ok ? built.lines : {}));
    expect(eff.kind).toBe('synced');
    expect(eff.source).toBe('user');
    expect(eff.lines.map((l) => l.startMs)).toEqual([1000, 1000, 2000, 3000, 3000, 4000, Infinity]);
    // 행 ID·텍스트는 판본 그대로(번역·발음 연결 유지)
    expect(eff.lines.map((l) => l.id)).toEqual(lv.lines.map((l) => l.id));
  });

  it('[AT-18][REQ-SY-05][REQ-SY-01] 일부만 기록하면 나머지 행은 절대 활성화되지 않는다(진행을 꾸며내지 않음)', () => {
    const lv = plainLyrics();
    const built = buildTimingFromTaps(lv, [1000, 2000]);
    expect(built.ok).toBe(true);
    const eff = effectiveTiming(lv, timingOf(lv, built.ok ? built.lines : {}));
    expect(eff.lines.slice(4).every((l) => l.startMs === Infinity)).toBe(true);
  });

  it('[AT-18][REQ-SY-05] 앞 줄보다 이른 시각·범위 밖·줄 수 초과·연주곡은 거부한다', () => {
    const lv = plainLyrics();
    expect(buildTimingFromTaps(lv, [2000, 1000]).ok).toBe(false);
    expect(buildTimingFromTaps(lv, [-1]).ok).toBe(false);
    expect(buildTimingFromTaps(lv, [Number.NaN]).ok).toBe(false);
    expect(buildTimingFromTaps(lv, [1, 2, 3, 4, 5]).ok).toBe(false);
    expect(buildTimingFromTaps(lv, []).ok).toBe(false);
    expect(buildTimingFromTaps(lv, [1000, 1000]).ok).toBe(true); // 같은 시각은 허용
    const inst = buildLyricsVersion({
      id: 'i',
      songId: 's',
      source: 'lrclib',
      sourceRef: null,
      kind: 'instrumental',
      createdAtEpochMs: 0,
    });
    expect(buildTimingFromTaps(inst, [1]).ok).toBe(false);
  });

  it('[AT-18][REQ-SY-05][REQ-SEC-07] 저장값 검증: 가사에 없는 행·건너뛴 행·빈 행 기록을 거부한다', () => {
    const lv = plainLyrics();
    const [a, b] = timingTargets(lv);
    expect(validateUserTiming(lv, { [a!.id]: 1, [b!.id]: 2 }).ok).toBe(true);
    expect(validateUserTiming(lv, { nope: 1 }).ok).toBe(false);
    expect(validateUserTiming(lv, { [b!.id]: 2 }).ok).toBe(false); // 첫 행을 건너뜀
    expect(validateUserTiming(lv, { [lv.lines[0]!.id]: 1 }).ok).toBe(false); // 빈 행
    expect(validateUserTiming(lv, { [a!.id]: 1.5 }).ok).toBe(false);
    // 잘못된 기록은 적용하지 않고 원래 시간(여기서는 시간 없음)을 쓴다
    expect(effectiveTiming(lv, timingOf(lv, { [b!.id]: 2 })).source).toBe('original');
  });

  it('[AT-18][REQ-SY-05] 가장 최근 버전이 적용되고, 최근 버전이 되돌리기면 원래 시간', () => {
    const lv = plainLyrics();
    const [a] = timingTargets(lv);
    const t1 = timingOf(lv, { [a!.id]: 1 }, 1);
    const t2 = timingOf(lv, { [a!.id]: 5 }, 2);
    const cleared: UserTimingVersion = { ...t1, id: 'c', kind: 'cleared', lines: {}, seq: 3 };
    expect(selectUserTiming([t2, t1])?.id).toBe(t2.id);
    expect(selectUserTiming([t1, t2, cleared])).toBeNull();
    expect(selectUserTiming([])).toBeNull();
  });
});

describe('AT-18 세션에서 탭 기록 저장·적용', () => {
  it('[AT-18][REQ-SY-05][REQ-SY-04] 시간 없는 가사도 기록 후 현재 행이 강조되고, 재실행 후에도 같은 곡에만 적용된다', async () => {
    const h = await harness();
    const track = TRACKS.jaPlain;
    await h.session.onTrackChanged(track);
    await h.session.idle();
    expect(h.session.current.lyrics?.kind).toBe('plain');
    expect(h.session.syncFor(snapAt(h, track, 5_000)).mode).toBe('static');
    const n = timingTargets(h.session.current.lyrics!).length;
    const taps = Array.from({ length: n }, (_, i) => 10_000 + i * 5_000);
    const callsBefore = h.provider.calls.length;
    const httpBefore = h.http.calls.length;
    expect(await h.session.saveUserTiming(taps)).toEqual({ ok: true });
    // AI·네트워크 호출 없음
    expect(h.provider.calls.length).toBe(callsBefore);
    expect(h.http.calls.length).toBe(httpBefore);

    const r = h.session.syncFor(snapAt(h, track, 16_000));
    expect(r.mode).toBe('synced');
    const lines = h.session.current.lyrics!.lines;
    if (r.mode === 'synced')
      expect(lines[r.activeIndex!]?.text).toBe(timingTargets(h.session.current.lyrics!)[1]?.text);
    expect(h.session.screen(snapAt(h, track, 16_000))?.mode).toBe('synced');
    // 줄 탭 이동에 쓸 시각
    const firstIdx = lines.findIndex((l) => l.text.trim() !== '');
    expect(h.session.lineStartMs(firstIdx)).toBe(10_000);

    const h2 = await h.restart();
    open.push(h2);
    await h2.session.onTrackChanged(track);
    await h2.session.idle();
    expect(h2.session.syncFor(snapAt(h2, track, 16_000)).mode).toBe('synced');
    // 다른 곡에는 적용되지 않는다
    await h2.session.onTrackChanged(TRACKS.jaStudio);
    await h2.session.idle();
    expect(h2.session.current.timing).toBeNull();
  });

  it('[AT-18][REQ-SY-05][REQ-TR-06] 시간이 틀린 싱크 가사: 기록이 원문 시간보다 우선하고, 번역·가사 판본은 그대로, 되돌리기 가능', async () => {
    const h = await harness();
    const track = TRACKS.jaStudio;
    await h.session.onTrackChanged(track);
    await h.session.idle();
    const lv = h.session.current.lyrics!;
    await h.session.saveUserTranslation({ [lv.lines[0]!.id]: '내 번역' });
    await h.session.setOffset(-1500);
    // 원문 시간: 첫 행 12초 → 13초 지점이면 첫 행
    const lines = lv.lines;
    const targets = timingTargets(lv);
    const taps = targets.map((_, i) => 20_000 + i * 4_000);
    expect((await h.session.saveUserTiming(taps)).ok).toBe(true);
    // 기록한 시간은 실제 재생 위치라서 곡별 보정은 0으로
    expect(h.session.current.offsetMs).toBe(0);
    expect(h.session.current.lyrics?.id).toBe(lv.id); // 판본 그대로
    expect(h.session.current.translation?.origin).toBe('user'); // 번역 연결 유지
    let r = h.session.syncFor(snapAt(h, track, 13_000));
    expect(r.mode === 'synced' && r.activeIndex).toBeNull(); // 기록상 첫 줄은 20초부터
    r = h.session.syncFor(snapAt(h, track, 24_500));
    expect(r.mode === 'synced' && lines[r.activeIndex!]?.text).toBe(targets[1]?.text);

    await h.session.clearUserTiming();
    expect(h.session.current.timing).toBeNull();
    r = h.session.syncFor(snapAt(h, track, 13_000));
    expect(r.mode === 'synced' && r.activeIndex).toBe(0); // 원래 시간
    // 기록 이력은 지우지 않는다(추가 전용)
    expect((await h.store.listUserTimings(lv.id)).map((t) => t.kind)).toEqual(['timed', 'cleared']);
  });

  it('[AT-18][REQ-SY-05] 저장소는 가사 판본과 맞지 않는 기록을 거부한다', async () => {
    const h = await harness();
    await h.session.onTrackChanged(TRACKS.jaStudio);
    await h.session.idle();
    const lv = h.session.current.lyrics!;
    await expect(
      h.store.saveUserTiming({
        id: 'bad',
        lyricsVersionId: lv.id,
        kind: 'timed',
        lines: { l9999: 1 },
        sourceTextHash: lv.textHash,
        createdAtEpochMs: 0,
      }),
    ).rejects.toThrow();
    expect(await h.store.listUserTimings(lv.id)).toEqual([]);
  });

  it('[AT-18][REQ-ST-04] 백업에 싱크 기록이 들어가고, 새 설치본에서 같은 싱크가 적용된다. 변조된 기록은 파일 전체 거부', async () => {
    const a = await harness();
    const track = TRACKS.jaPlain;
    await a.session.onTrackChanged(track);
    await a.session.idle();
    const n = timingTargets(a.session.current.lyrics!).length;
    expect((await a.session.saveUserTiming(Array.from({ length: n }, (_, i) => 1_000 + i * 1_000))).ok).toBe(true);
    const exported = await a.store.exportUserData(LATEST_SCHEMA_VERSION, a.clock.nowEpochMs());
    expect(exported.userTimings).toHaveLength(1);
    const text = JSON.stringify(exported);

    const parsed = parseBackup(text, LATEST_SCHEMA_VERSION);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.summary.userTimings).toBe(1);
    const b = await harness();
    const report = await b.store.importUserData(parsed.data, b.clock.nowEpochMs());
    expect(report.timingsAdded).toBe(1);
    // 같은 백업을 다시 가져와도 그대로
    expect((await b.store.importUserData(parsed.data, b.clock.nowEpochMs())).timingsAdded).toBe(0);
    const httpBefore = b.http.calls.length;
    await b.session.onTrackChanged(track);
    await b.session.idle();
    expect(b.http.calls.length).toBe(httpBefore);
    expect(b.session.syncFor(snapAt(b, track, 1_500)).mode).toBe('synced');

    // 변조: 시각 순서를 거꾸로
    const doctored = JSON.parse(text) as { userTimings: Array<{ lines: Record<string, number> }> };
    const t = doctored.userTimings[0]!;
    const keys = Object.keys(t.lines);
    t.lines[keys[0]!] = 99_000;
    const bad = parseBackup(JSON.stringify(doctored), LATEST_SCHEMA_VERSION);
    expect(bad.ok).toBe(false);

    // 이전 형식(userTimings 없음)은 그대로 받아들인다
    const legacy = JSON.parse(text) as Record<string, unknown>;
    delete legacy['userTimings'];
    const old = parseBackup(JSON.stringify(legacy), LATEST_SCHEMA_VERSION);
    expect(old.ok && old.data.userTimings).toEqual([]);
  });
});
