/**
 * Android(Spotify·YouTube Music·Apple Music 앱) 미디어 세션 수용 테스트(AT-23, docs/plan.md D-41).
 * 네이티브 모듈(Kotlin)이 넘기는 MediaSession 원시 값(합성)을 core 변환 → 세션 → 싱크까지 그대로 통과시킨다.
 * 가짜 LRCLIB(합성 픽스처)·FakeClock만 쓰고 실제 네트워크·AI 호출은 없다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../support/harness.js';
import { LrclibClient } from '../../src/lyrics/lrclib-client.js';
import { LrclibLyricsProvider } from '../../src/lyrics/lyrics-provider.js';
import { PlaylistLyricsBatch } from '../../src/batch/playlist-lyrics-batch.js';
import {
  mapAndroidQueue,
  mapAndroidSnapshot,
  pickAndroidSession,
  type AndroidSessionRaw,
} from '../../src/playback/android-media-session.js';
import { mapIosTrack } from '../../src/playback/ios-system-player.js';
import { parseBackup } from '../../src/backup/backup-file.js';
import { LATEST_SCHEMA_VERSION } from '../../src/storage/migrations.js';
import type { HttpRequest, IdGenerator } from '../../src/ports.js';

class PrefixedIds implements IdGenerator {
  private n = 0;
  constructor(private readonly tag: string) {}
  next(prefix: string): string {
    this.n += 1;
    return `${prefix}_${this.tag}${this.n}`;
  }
}

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

const lrclibGets = (h: Harness) => h.http.calls.filter((c: HttpRequest) => c.url.includes('/api/get'));

/** 합성 곡(fixtures/lrclib/get-ja-synced.json, 실제 곡 아님): 12.00 / 17.50 / 23.00 / (28.40 빈 행) / 30.00 … */
const SPOTIFY: AndroidSessionRaw = {
  packageName: 'com.spotify.music',
  hasMetadata: true,
  title: '夜明けのホーム',
  artist: 'Synthetic Band',
  album: 'Test Album',
  durationMs: 210_000,
  mediaId: 'spotify:track:0SyntheticTrackId00001',
  state: 3,
  positionMs: 18_000,
  lastPositionUpdateTime: 50_000,
  speed: 1,
  readAtElapsedMs: 50_200, // 갱신 0.2초 뒤에 읽음 → 18.2초
  actions: 4 + 2 + 16 + 32 + 256 + 4096,
};

describe('AT-23 Android 미디어 세션(Spotify·YouTube Music)', () => {
  it('[AT-23][REQ-PB-07][REQ-SY-01][REQ-SY-02] Spotify 세션 값으로 현재 행을 맞추고, 위치 모름·광고·버퍼링이면 진행을 꾸며내지 않는다', async () => {
    const h = await harness({ autoTranslate: false });
    // 다른 앱(지원 안 함)이 재생 중이어도 Spotify 세션을 따른다
    const other: AndroidSessionRaw = { ...SPOTIFY, packageName: 'com.example.video', title: '다른 앱' };
    const raw = pickAndroidSession([other, SPOTIFY], null)!;
    const snap = mapAndroidSnapshot(raw, h.clock.monotonicMs());
    await h.session.onTrackChanged(snap.track!);
    await h.session.idle();
    const lv = h.session.current.lyrics!;
    expect(h.session.current.phase).toBe('ready');
    expect(h.session.current.track?.service).toBe('spotify');

    // 18.2초 → 둘째 줄(17.50)
    let r = h.session.syncFor(snap);
    expect(r.mode).toBe('synced');
    if (r.mode === 'synced') expect(lv.lines[r.activeIndex!]!.text).toBe('まだ ねむい まちのなか');
    // 5초 뒤 → 셋째 줄(23.00)
    h.clock.advance(5_000);
    r = h.session.syncFor(snap);
    if (r.mode === 'synced') expect(lv.lines[r.activeIndex!]!.text).toBe('光の中へ走り出す');

    // 위치 모름(-1): 강조 없음
    const unknown = mapAndroidSnapshot({ ...SPOTIFY, positionMs: -1 }, h.clock.monotonicMs());
    expect(h.session.syncFor(unknown)).toEqual({ mode: 'unknown', reason: 'no-position' });
    expect(h.session.screen(unknown)!.rows.some((row) => row.state === 'active')).toBe(false);

    // 버퍼링: 시간이 지나도 앞으로 가지 않음
    const buffering = mapAndroidSnapshot({ ...SPOTIFY, state: 6 }, h.clock.monotonicMs());
    const before = h.session.syncFor(buffering);
    h.clock.advance(10_000);
    expect(before).toMatchObject({ mode: 'synced', positionMs: 18_000 });
    expect(h.session.syncFor(buffering)).toMatchObject({ mode: 'synced', positionMs: 18_000, isPlaying: false });

    // 광고: 곡이 아니므로 곡 정보 없음 → 화면의 곡·가사는 바뀌지 않고 AI도 부르지 않는다
    const ad = mapAndroidSnapshot({ ...SPOTIFY, mediaId: 'spotify:ad:000', title: 'Advertisement' }, 0);
    expect(ad.track).toBeNull();
    expect(h.session.current.lyrics?.id).toBe(lv.id);
    expect(h.provider.calls).toHaveLength(0);
  });

  it('[AT-23][REQ-PB-07][REQ-LY-03][REQ-ST-04][REQ-TR-05] iPhone 백업을 가져온 Android에서 같은 곡을 Spotify로 들으면 후보 확인 뒤 내 번역이 보이고(가사·AI 호출 0회), 라이브 영상은 다른 녹음으로 따로 다룬다', async () => {
    // iPhone: Music 앱에서 재생 → 내 번역 저장 → 백업
    const phone = await harness({ ids: new PrefixedIds('i'), autoTranslate: false });
    const iosTrack = mapIosTrack({
      hasItem: true,
      title: '夜明けのホーム',
      artist: 'Synthetic Band',
      album: 'Test Album',
      durationSec: 210,
      storeId: '900000001',
    })!;
    await phone.session.onTrackChanged(iosTrack);
    await phone.session.idle();
    const lv = phone.session.current.lyrics!;
    const mapping: Record<string, string> = {};
    lv.lines.forEach((l, i) => {
      if (l.text.trim()) mapping[l.id] = `내 번역 ${i}`;
    });
    expect((await phone.session.saveUserTranslation(mapping)).ok).toBe(true);
    const backup = JSON.stringify(await phone.store.exportUserData(LATEST_SCHEMA_VERSION, phone.clock.nowEpochMs()));

    // Android: 자동 번역을 켠 새 설치본에 백업을 가져온 뒤 Spotify에서 재생
    const android = await harness({ ids: new PrefixedIds('a'), autoTranslate: true });
    const parsed = parseBackup(backup, LATEST_SCHEMA_VERSION);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    await android.store.importUserData(parsed.data, android.clock.nowEpochMs());

    const snap = mapAndroidSnapshot(SPOTIFY, android.clock.monotonicMs());
    await android.session.onTrackChanged(snap.track!);
    await android.session.idle();
    // 서비스가 달라 곡 ID로는 연결할 수 없으므로(ISRC도 없음) 자동 연결하지 않고 사용자 확인
    expect(android.session.current.phase).toBe('needs-confirmation');
    expect(android.provider.calls).toHaveLength(0);
    const candidate = android.session.current.candidates[0]!;
    await android.session.confirmCandidate(candidate.song.id);
    await android.session.idle();
    expect(android.session.current.phase).toBe('ready');
    expect(android.session.current.translation?.origin).toBe('user');
    expect(android.session.current.lyrics?.id).toBe(lv.id);
    expect(android.http.calls).toHaveLength(0); // LRCLIB 재조회 없음
    expect(android.provider.calls).toHaveLength(0); // AI 호출 없음(자동 번역이 켜져 있어도)
    expect(android.session.screen(snap)!.rows.find((row) => row.state === 'active')?.translation).toBe('내 번역 1');

    // 확인한 연결은 저장된다: 다시 들으면 바로 같은 곡
    await android.session.onTrackChanged({ ...snap.track!, title: snap.track!.title });
    await android.session.idle();
    expect(android.session.current.phase).toBe('ready');
    expect(await android.store.listSongs()).toHaveLength(1);

    // YouTube Music 라이브 영상: 영상 표기는 지우지만 Live 표시는 남아 스튜디오 녹음과 섞이지 않는다
    const live = mapAndroidSnapshot(
      {
        packageName: 'com.google.android.apps.youtube.music',
        hasMetadata: true,
        title: 'Paper Lanterns (Live at Hall) (Official Video)',
        artist: 'Imaginary Duo - Topic',
        album: 'Live at Hall',
        durationMs: 245_000,
        mediaId: 'LiveVideo01',
        state: 3,
        positionMs: 0,
        lastPositionUpdateTime: 1,
        readAtElapsedMs: 1,
      },
      android.clock.monotonicMs(),
    );
    expect(live.track).toMatchObject({ title: 'Paper Lanterns (Live at Hall)', artist: 'Imaginary Duo' });
    await android.session.onTrackChanged(live.track!);
    await android.session.idle();
    expect(android.session.current.phase).toBe('ready');
    expect(android.session.current.song?.versionTags).toContain('live');
    expect(await android.store.listSongs()).toHaveLength(2);
  });

  it('[AT-23][REQ-PB-08][REQ-LY-05][REQ-TR-05] Spotify 재생 목록으로 가사 원문을 일괄로 받아 두면, 그 곡을 재생할 때 다시 조회하지 않고 AI도 부르지 않는다', async () => {
    const h = await harness({ autoTranslate: true });
    const lrclib = new LrclibClient({
      http: h.http,
      clock: h.clock,
      clientId: 'LyricsCompanion-test/0.1.0 (test)',
      minIntervalMs: 0,
    });
    const batch = new PlaylistLyricsBatch({
      store: h.store,
      lyrics: new LrclibLyricsProvider(lrclib),
      clock: h.clock,
      ids: h.ids,
      logger: h.logger,
    });
    const queue = mapAndroidQueue('com.spotify.music', [
      {
        queueId: '1',
        title: '夜明けのホーム',
        subtitle: 'Synthetic Band',
        mediaId: 'spotify:track:0SyntheticTrackId00001',
      },
      {
        queueId: '2',
        title: 'Interlude No.3',
        subtitle: 'Synthetic Band',
        mediaId: 'spotify:track:0SyntheticTrackId00002',
      },
    ]);
    const end = await batch.start({ label: 'Spotify 재생 목록', tracks: queue.map((q) => q.ref) });
    expect(end?.items.map((i) => i.status)).toEqual(['saved', 'saved']);
    expect(h.provider.calls).toHaveLength(0);

    // 재생: 재생 목록과 같은 곡 ID → 같은 곡 연결 → 저장본 사용
    const before = lrclibGets(h).length;
    const snap = mapAndroidSnapshot(SPOTIFY, h.clock.monotonicMs());
    await h.session.onTrackChanged(snap.track!);
    await h.session.idle();
    expect(h.session.current.phase).toBe('ready');
    expect(h.session.current.lyrics?.kind).toBe('synced');
    expect(lrclibGets(h).length).toBe(before);
    // 자동 번역이 켜져 있으므로 번역은 재생할 때 정책대로(일괄 받기 자체는 AI 0회)
    expect(await h.store.listSongs()).toHaveLength(2);
  });
});
