/**
 * 소리로 싱크 맞추기 수용 테스트(AT-25, REQ-SY-06·07, docs/plan.md D-44).
 * 가짜 재생기(FakeClock으로 위치가 흐름) + 가짜 듣기 모듈(네이티브와 같은 원시 값) + 실제 core 객체·SQLite.
 * - 사용자가 시작한 경우에만 듣고, 시간 정보 없는 가사에만, 결과는 "소리로 맞춘 싱크"(method auto) 새 버전.
 * - 탭으로 기록한 싱크는 확인 없이 바꾸지 않는다(일괄은 항상 건너뜀). AI·네트워크 호출 0회.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, tempDbPath, type Harness } from '../support/harness.js';
import { NodeSqliteDriver } from '../support/node-sqlite-driver.js';
import { LyricsStore } from '../../src/storage/lyrics-store.js';
import {
  EN_SONG,
  FakeListener,
  FakeMusicPlayer,
  hearSong,
  JA_SONG,
  singTimeline,
  type SimTrack,
  type SongTimeline,
} from '../support/auto-sync-sim.js';
import { AutoSyncRunner, type AutoSyncState } from '../../src/sync/auto-sync-runner.js';
import { parseUserLyrics } from '../../src/lyrics/user-lyrics.js';
import { timingTargets } from '../../src/sync/user-timing.js';
import { parseBackup } from '../../src/backup/backup-file.js';
import { getSchemaVersion, LATEST_SCHEMA_VERSION, migrate, MIGRATIONS } from '../../src/storage/migrations.js';
import type { PlaybackSnapshot, ServiceTrackRef } from '../../src/ports.js';

const open: Harness[] = [];
async function harness(): Promise<Harness> {
  const h = await createHarness();
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

/** 합성 LRC 텍스트 */
function buildLrc(lines: Array<{ text: string; startMs: number }>): string {
  const ts = (ms: number) => {
    const m = Math.floor(ms / 60_000);
    const sec = (ms - m * 60_000) / 1000;
    return `[${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}]`;
  };
  return lines.map((l) => `${ts(l.startMs)}${l.text}`).join('\n');
}

const JA = singTimeline(JA_SONG);
const EN = singTimeline(EN_SONG, { unitMs: 380 });

function ref(id: string, title: string, song: SongTimeline): ServiceTrackRef {
  return {
    service: 'apple-music',
    serviceTrackId: id,
    title,
    artist: 'Synthetic Band',
    album: 'Test Album',
    durationMs: song.durationMs,
    isrc: null,
  };
}

const JA_REF = ref('2001', '合成の朝', JA);
const EN_REF = ref('2002', 'Paper Boats', EN);

/** LRCLIB에 없는 곡(합성)에 가사를 직접 등록(D-40 경로) */
async function register(h: Harness, r: ServiceTrackRef, text: string): Promise<void> {
  await h.session.onTrackChanged(r);
  await h.session.idle();
  const parsed = parseUserLyrics(text);
  const saved = await h.session.saveUserLyrics(parsed, 'typed');
  expect(saved.ok).toBe(true);
  await h.session.idle();
}

function setup(h: Harness) {
  const player = new FakeMusicPlayer(h.clock);
  const listener = new FakeListener(h.clock, player);
  const runner = new AutoSyncRunner({
    store: h.store,
    session: h.session,
    playback: player,
    listener,
    clock: h.clock,
    ids: h.ids,
    logger: h.logger,
  });
  return { player, listener, runner };
}

/** 시계를 0.5초씩 진행하며 듣기 모듈이 표본을 재게 한다 */
async function drive(h: Harness, listener: FakeListener, done: () => boolean, maxSteps = 4_000): Promise<void> {
  for (let i = 0; i < maxSteps && !done(); i++) {
    h.clock.advance(500);
    listener.tick();
    for (let k = 0; k < 25; k++) await new Promise<void>((r) => setImmediate(r));
  }
  for (let k = 0; k < 50 && !done(); k++) await new Promise<void>((r) => setImmediate(r));
}

function snapAt(h: Harness, r: ServiceTrackRef, positionMs: number): PlaybackSnapshot {
  return { track: r, status: 'paused', positionMs, capturedAtMonotonicMs: h.clock.monotonicMs(), rate: 0 };
}

async function runSingle(
  h: Harness,
  s: ReturnType<typeof setup>,
  track: SimTrack,
  opts: { replaceTap?: boolean; until?: (st: AutoSyncState) => boolean; onStep?: () => void } = {},
): Promise<AutoSyncState> {
  s.player.load([track]);
  await s.player.control.seekTo(45_000); // 곡 중간을 듣던 중
  const p = s.runner.startSingle(opts.replaceTap ? { replaceTap: true } : {});
  expect(p).not.toBeNull();
  await drive(h, s.listener, () => {
    opts.onStep?.();
    return !s.runner.current.running;
  });
  return p!;
}

describe('AT-25 한 곡 소리로 맞추기', () => {
  it('[AT-25][REQ-SY-06][REQ-SY-01] 시간 정보 없는 가사: 처음부터 다시 들으며 맞춰 "소리로 맞춘 싱크"로 저장, 현재 행 강조, 재실행 후에도 유지, AI·네트워크 0회', async () => {
    const h = await harness();
    await register(h, JA_REF, JA_SONG.join('\n'));
    expect(h.session.current.lyrics?.kind).toBe('plain');
    await h.session.setOffset(-1_500);
    const s = setup(h);
    const ai = h.provider.calls.length;
    const http = h.http.calls.length;

    const st = await runSingle(h, s, {
      ref: JA_REF,
      heard: hearSong(JA, { seed: 3, drop: 0.4, sub: 0.1, jitterMs: 120 }),
    });
    expect(st.stoppedBy).toBe('completed');
    expect(st.items).toHaveLength(1);
    expect(st.items[0]!.status).toBe('saved');
    expect(st.items[0]!.stats!.heardLines).toBeGreaterThan(JA.truth.length / 2);
    // 처음으로 돌려 재생했다
    expect(s.player.seeks).toBeGreaterThanOrEqual(2);
    expect(s.listener.calls).toContain('prepare:ja-JP');
    expect(s.listener.calls).toContain('start:ja-JP');
    expect(s.listener.hintsSeen[0]).toBeGreaterThan(0);
    // AI·네트워크 0회
    expect(h.provider.calls.length).toBe(ai);
    expect(h.http.calls.length).toBe(http);

    const timing = h.session.current.timing!;
    expect(timing.method).toBe('auto');
    expect(timing.auto).toMatchObject({ engine: 'apple-speech/ja-JP' });
    expect(h.session.timingView()?.source).toBe('auto');
    expect(h.session.current.offsetMs).toBe(0); // 실제 재생 위치 기준이라 곡별 보정 0
    // 가사 판본은 그대로(번역 연결 유지)
    const lines = h.session.current.lyrics!.lines;
    const targets = timingTargets(h.session.current.lyrics!);
    for (const k of [0, 5, 12]) {
      const r = h.session.syncFor(snapAt(h, JA_REF, (JA.truth[k] as number) + 1_200));
      expect(r.mode).toBe('synced');
      if (r.mode === 'synced') expect(lines[r.activeIndex!]?.text, `줄 ${k}`).toBe(targets[k]?.text);
    }

    const h2 = await h.restart();
    open.push(h2);
    await h2.session.onTrackChanged(JA_REF);
    await h2.session.idle();
    expect(h2.session.current.timing?.method).toBe('auto');
    expect(h2.session.syncFor(snapAt(h2, JA_REF, (JA.truth[3] as number) + 500)).mode).toBe('synced');
    // 원래대로(시간 정보 없음) 되돌리기
    await h2.session.clearUserTiming();
    expect(h2.session.syncFor(snapAt(h2, JA_REF, 30_000)).mode).toBe('static');
  });

  it('[AT-25][REQ-SY-06][REQ-ST-04] 백업에 소리로 맞춘 싱크가 표시와 함께 들어가고, 새 설치본에서 같은 싱크', async () => {
    const a = await harness();
    await register(a, JA_REF, JA_SONG.join('\n'));
    const s = setup(a);
    await runSingle(a, s, { ref: JA_REF, heard: hearSong(JA, { seed: 1, drop: 0.3 }) });
    const exported = await a.store.exportUserData(LATEST_SCHEMA_VERSION, a.clock.nowEpochMs());
    expect(exported.userTimings[0]).toMatchObject({ method: 'auto', kind: 'timed' });
    const parsed = parseBackup(JSON.stringify(exported), LATEST_SCHEMA_VERSION);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.userTimings[0]?.auto?.engine).toBe('apple-speech/ja-JP');
    const b = await harness();
    await b.store.importUserData(parsed.data, b.clock.nowEpochMs());
    await b.session.onTrackChanged(JA_REF);
    await b.session.idle();
    expect(b.session.current.timing?.method).toBe('auto');
    // 이전 형식(method 없음) 기록은 탭 기록으로 읽는다
    const legacy = JSON.parse(JSON.stringify(exported)) as { userTimings: Array<Record<string, unknown>> };
    delete legacy.userTimings[0]!['method'];
    delete legacy.userTimings[0]!['auto'];
    const old = parseBackup(JSON.stringify(legacy), LATEST_SCHEMA_VERSION);
    expect(old.ok && old.data.userTimings[0]?.method).toBe('tap');
    const bad = JSON.parse(JSON.stringify(exported)) as { userTimings: Array<Record<string, unknown>> };
    bad.userTimings[0]!['method'] = 'ai';
    expect(parseBackup(JSON.stringify(bad), LATEST_SCHEMA_VERSION).ok).toBe(false);
  });

  it('[AT-25][REQ-SY-06][REQ-SY-05] 탭으로 기록한 싱크는 확인 없이 바꾸지 않는다(듣지도 않음). 확인하면 새 버전으로, 이전 기록은 보존', async () => {
    const h = await harness();
    await register(h, JA_REF, JA_SONG.join('\n'));
    const n = timingTargets(h.session.current.lyrics!).length;
    expect((await h.session.saveUserTiming(Array.from({ length: n }, (_, i) => 5_000 + i * 3_000))).ok).toBe(true);
    const s = setup(h);
    const st = await runSingle(h, s, { ref: JA_REF, heard: hearSong(JA, { seed: 2 }) });
    expect(st.items[0]!.status).toBe('has-timing');
    expect(s.listener.calls.some((c) => c.startsWith('start'))).toBe(false);
    expect(h.session.current.timing?.method).toBe('tap');

    const st2 = await runSingle(h, s, { ref: JA_REF, heard: hearSong(JA, { seed: 2 }) }, { replaceTap: true });
    expect(st2.items[0]!.status).toBe('saved');
    expect(h.session.current.timing?.method).toBe('auto');
    const all = await h.store.listUserTimings(h.session.current.lyrics!.id);
    expect(all.map((t) => t.method)).toEqual(['tap', 'auto']);
    // 소리로 맞춘 싱크는 확인 없이 다시 맞출 수 있다
    const st3 = await runSingle(h, s, { ref: JA_REF, heard: hearSong(JA, { seed: 4 }) });
    expect(st3.items[0]!.status).toBe('saved');
  });

  it('[AT-25][REQ-SY-06][REQ-SEC-01] 준비 실패(마이크 거부)·이어폰 재생이면 듣지 않고, 듣는 중 이어폰을 연결하면 저장 없이 멈춘다', async () => {
    const h = await harness();
    await register(h, JA_REF, JA_SONG.join('\n'));
    const s = setup(h);
    s.listener.readiness = { ok: false, reason: 'mic-denied' };
    const st = await runSingle(h, s, { ref: JA_REF, heard: hearSong(JA) });
    expect(st).toMatchObject({ stoppedBy: 'not-ready', notReady: 'mic-denied' });
    expect(s.listener.calls.some((c) => c.startsWith('start'))).toBe(false);
    expect(s.player.seeks).toBe(1); // 테스트가 넣은 탐색뿐(앱은 재생 위치를 건드리지 않음)

    s.listener.readiness = { ok: false, reason: 'headphones' };
    expect((await runSingle(h, s, { ref: JA_REF, heard: hearSong(JA) })).stoppedBy).toBe('headphones');

    s.listener.readiness = { ok: true, route: 'speaker' };
    let steps = 0;
    const st3 = await runSingle(
      h,
      s,
      { ref: JA_REF, heard: hearSong(JA) },
      {
        onStep: () => {
          if (++steps === 80) s.listener.route = 'bluetooth';
        },
      },
    );
    expect(st3.stoppedBy).toBe('headphones');
    expect(s.listener.calls).toContain('cancel');
    expect(h.session.current.timing).toBeNull();
  });

  it('[AT-25][REQ-SY-06] 소리를 못 들었으면(이어폰·음소거) 저장하지 않고 이유를 알린다', async () => {
    const h = await harness();
    await register(h, JA_REF, JA_SONG.join('\n'));
    const s = setup(h);
    const st = await runSingle(h, s, { ref: JA_REF, heard: [] });
    expect(st.items[0]!.status).toBe('nothing-heard');
    expect(h.session.current.timing).toBeNull();
    expect(await h.store.listUserTimings(h.session.current.lyrics!.id)).toEqual([]);
  });

  it('[AT-25][REQ-SY-06][REQ-SY-01] 중간에 "여기까지 저장"하면 들은 곳까지만 시간을 만들고 뒤 줄은 강조하지 않는다', async () => {
    const h = await harness();
    await register(h, JA_REF, JA_SONG.join('\n'));
    const s = setup(h);
    const stopAt = (JA.truth[10] as number) + 500;
    const st = await runSingle(
      h,
      s,
      { ref: JA_REF, heard: hearSong(JA, { seed: 5, drop: 0.3 }) },
      {
        onStep: () => {
          if (s.runner.current.phase === 'listening' && s.player.positionMs() >= stopAt) s.runner.finishNow();
        },
      },
    );
    expect(st.items[0]!.status).toBe('saved');
    const stats = st.items[0]!.stats!;
    expect(stats.untimedLines).toBeGreaterThan(0);
    expect(stats.totalLines - stats.untimedLines).toBeLessThanOrEqual(12);
    const lines = h.session.current.lyrics!.lines;
    const r = h.session.syncFor(snapAt(h, JA_REF, JA.durationMs - 5_000));
    expect(r.mode).toBe('synced');
    if (r.mode === 'synced') {
      const targets = timingTargets(h.session.current.lyrics!);
      const lastTimed = targets[stats.totalLines - stats.untimedLines - 1]!;
      expect(lines[r.activeIndex!]?.id).toBe(lastTimed.id);
    }
  });
});

describe('AT-25 플레이리스트 소리로 맞추기', () => {
  it('[AT-25][REQ-SY-07][REQ-SY-05] 싱크 없는 곡만 차례로 재생하며 맞춤: 싱크 가사·탭 기록·가사 없음·중복은 건너뛰고, 곡 언어로 바꿔 듣는다', async () => {
    const h = await harness();
    const SYNCED_REF = ref('2003', '合成の夜', JA);
    const TAP_REF = ref('2004', 'Tapped Song', EN);
    const NONE_REF = ref('2005', '가사 없는 곡', JA);
    await register(h, JA_REF, JA_SONG.join('\n'));
    await register(h, EN_REF, EN_SONG.join('\n'));
    await register(
      h,
      SYNCED_REF,
      buildLrc(JA_SONG.filter((l) => l.trim() !== '').map((text, i) => ({ text, startMs: 10_000 + i * 3_000 }))),
    );
    await register(h, TAP_REF, EN_SONG.join('\n'));
    const n = timingTargets(h.session.current.lyrics!).length;
    expect((await h.session.saveUserTiming(Array.from({ length: n }, (_, i) => 2_000 + i * 2_000))).ok).toBe(true);
    const tapLyricsId = h.session.current.lyrics!.id;

    const s = setup(h);
    const sims: Record<string, SimTrack> = {
      '2001': { ref: JA_REF, heard: hearSong(JA, { seed: 11, drop: 0.35 }) },
      '2002': { ref: EN_REF, heard: hearSong(EN, { seed: 12, drop: 0.3 }) },
    };
    const tracks = [JA_REF, SYNCED_REF, TAP_REF, NONE_REF, EN_REF, JA_REF];
    let played: number[] = [];
    const ai = h.provider.calls.length;
    const http = h.http.calls.length;
    const p = s.runner.startBatch({
      label: '합성 목록',
      key: 'pl-1',
      tracks,
      play: (idx) => {
        played = idx;
        s.player.load(idx.map((i) => sims[tracks[i]!.serviceTrackId!]!));
        return Promise.resolve();
      },
    });
    expect(p).not.toBeNull();
    // 실행 중에는 다시 시작할 수 없다
    expect(s.runner.startBatch({ label: 'x', key: null, tracks, play: () => Promise.resolve() })).toBeNull();
    await drive(h, s.listener, () => !s.runner.current.running);
    const st = await p!;
    expect(played).toEqual([0, 4]);
    expect(st.stoppedBy).toBe('completed');
    const byIndex = new Map(st.items.map((i) => [i.index, i.status]));
    expect(byIndex.get(0)).toBe('saved');
    expect(byIndex.get(4)).toBe('saved');
    expect(byIndex.get(1)).toBe('already-synced');
    expect(byIndex.get(2)).toBe('has-timing');
    expect(byIndex.get(3)).toBe('no-lyrics');
    expect(byIndex.get(5)).toBe('duplicate');
    expect(s.listener.calls).toEqual(expect.arrayContaining(['prepare:ja-JP', 'prepare:en-US', 'start:en-US']));
    expect(h.provider.calls.length).toBe(ai);
    expect(h.http.calls.length).toBe(http);
    // 탭 기록은 그대로
    expect((await h.store.listUserTimings(tapLyricsId)).map((t) => t.method)).toEqual(['tap']);
    // 나중에 재생하면 소리로 맞춘 싱크
    await h.session.onTrackChanged(EN_REF);
    await h.session.idle();
    expect(h.session.current.timing?.method).toBe('auto');
    expect(h.session.syncFor(snapAt(h, EN_REF, (EN.truth[4] as number) + 500)).mode).toBe('synced');
    // 다시 실행하면 이미 맞춘 곡은 건너뛴다
    const plan = await s.runner.plan(tracks);
    expect(plan.filter((x) => x.status === 'target')).toEqual([]);
  });

  it('[AT-25][REQ-SY-07] 중간에 멈추면 끝까지 들은 곡만 저장하고 듣던 곡은 저장하지 않는다. 듣는 동안 가사가 바뀐 곡도 저장하지 않는다', async () => {
    const h = await harness();
    const JA2 = ref('2006', '合成の昼', JA);
    await register(h, JA_REF, JA_SONG.join('\n'));
    await register(h, EN_REF, EN_SONG.join('\n'));
    await register(h, JA2, JA_SONG.join('\n'));
    const s = setup(h);
    const tracks = [JA_REF, EN_REF, JA2];
    const sims = [
      { ref: JA_REF, heard: hearSong(JA, { seed: 21, drop: 0.3 }) },
      { ref: EN_REF, heard: hearSong(EN, { seed: 22, drop: 0.3 }) },
      { ref: JA2, heard: hearSong(JA, { seed: 23, drop: 0.3 }) },
    ];
    const p = s.runner.startBatch({
      label: '합성 목록',
      key: 'pl-2',
      tracks,
      play: (idx) => {
        s.player.load(idx.map((i) => sims[i]!));
        return Promise.resolve();
      },
    });
    let changed = false;
    await drive(h, s.listener, () => {
      const cur = s.player.track?.ref.serviceTrackId;
      // 둘째 곡을 듣는 동안 첫 곡은 끝났고, 둘째 곡 가사를 사용자가 바꿈 → 셋째 곡 도중 멈춤
      if (!changed && cur === '2002' && s.player.positionMs() > 30_000) {
        changed = true;
        void (async () => {
          await h.session.onTrackChanged(EN_REF);
          await h.session.idle();
          await h.session.saveUserLyrics(parseUserLyrics([...EN_SONG, 'One more synthetic line'].join('\n')), 'typed');
        })();
      }
      if (cur === '2006' && s.player.positionMs() > 20_000) s.runner.cancel();
      return !s.runner.current.running;
    });
    const st = await p!;
    expect(st.stoppedBy).toBe('cancelled');
    const byIndex = new Map(st.items.map((i) => [i.index, i.status]));
    expect(byIndex.get(0)).toBe('saved');
    expect(byIndex.get(1)).toBe('changed');
    expect(byIndex.get(2)).toBe('cancelled');
    const ja2 = await h.store.findSongByServiceKey('apple-music', 'id:2006');
    expect(await h.store.listUserTimings(ja2!.activeLyricsVersionId!)).toEqual([]);
  });
});

describe('AT-25 저장소', () => {
  it('[AT-25][AT-14][REQ-ST-03] v4 → v5 마이그레이션: 기존 탭 기록은 그대로(seq 유지) tap으로 읽히고, 소리로 맞춘 기록은 auto로 저장된다', async () => {
    const path = tempDbPath('migration-v5');
    const d = new NodeSqliteDriver(path);
    await migrate(d, MIGRATIONS, 4);
    await d.run(`INSERT INTO songs(id,title,artist,album,duration_ms,version_tags,isrc,active_lyrics_version_id,created_at)
      VALUES ('s1','t','a',NULL,1000,'[]',NULL,'lv1',1)`);
    await d.run(`INSERT INTO lyrics_versions(id,song_id,source,source_ref,kind,language,lines_json,text_hash,content_hash,has_word_timing_source,created_at)
      VALUES ('lv1','s1','user',NULL,'plain','ja','[{"id":"l0001","text":"あ","startMs":null},{"id":"l0002","text":"い","startMs":null}]','h','c',0,1)`);
    await d.run(
      `INSERT INTO user_timings(seq,id,lyrics_version_id,kind,lines_json,source_text_hash,created_at) VALUES (7,'tm1','lv1','timed','{"l0001":1000}','h',1)`,
    );
    await d.close();
    const d2 = new NodeSqliteDriver(path);
    const store = await LyricsStore.open(d2);
    expect(await getSchemaVersion(d2)).toBe(LATEST_SCHEMA_VERSION);
    expect(await store.listUserTimings('lv1')).toEqual([
      expect.objectContaining({ id: 'tm1', seq: 7, method: 'tap', auto: null, lines: { l0001: 1000 } }),
    ]);
    await store.saveUserTiming({
      id: 'tm2',
      lyricsVersionId: 'lv1',
      kind: 'timed',
      lines: { l0001: 900, l0002: 2000 },
      method: 'auto',
      auto: { engine: 'apple-speech/ja-JP', heardLines: 1, filledLines: 1 },
      sourceTextHash: 'h',
      createdAtEpochMs: 2,
    });
    // 되돌리기 기록은 method를 auto로 줘도 tap으로 저장(만든 방법이 없는 기록)
    await store.saveUserTiming({
      id: 'tm3',
      lyricsVersionId: 'lv1',
      kind: 'cleared',
      lines: {},
      method: 'auto',
      sourceTextHash: 'h',
      createdAtEpochMs: 3,
    });
    const all = await store.listUserTimings('lv1');
    expect(all.map((t) => [t.id, t.method, t.auto?.heardLines ?? null])).toEqual([
      ['tm1', 'tap', null],
      ['tm2', 'auto', 1],
      ['tm3', 'tap', null],
    ]);
    expect(all[1]!.seq).toBeGreaterThan(7);
    await store.close();
  });
});
