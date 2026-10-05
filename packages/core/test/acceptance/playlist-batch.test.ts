/**
 * 플레이리스트 가사 원문 일괄 받기(REQ-LY-05, AT-19) 수용 테스트.
 * 가짜 LRCLIB(합성 픽스처)·FakeClock만 쓰고 실제 네트워크·AI 호출은 없다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, TRACKS, type Harness } from '../support/harness.js';
import { jsonResponse } from '../support/fakes.js';
import { waitFor } from '../support/wait.js';
import { LrclibClient } from '../../src/lyrics/lrclib-client.js';
import { LrclibLyricsProvider } from '../../src/lyrics/lyrics-provider.js';
import { PlaylistLyricsBatch, summarizeBatch, type BatchState } from '../../src/batch/playlist-lyrics-batch.js';
import { libraryTrackToRef, mapLibraryTracks } from '../../src/playback/ios-library.js';
import { mapIosTrack } from '../../src/playback/ios-system-player.js';
import { serviceKeyOf } from '../../src/matching/track-identity.js';
import type { HttpRequest, ServiceTrackRef } from '../../src/ports.js';

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

function batchFor(h: Harness, opts: { maxAutoWaitMs?: number } = {}): PlaylistLyricsBatch {
  const lrclib = new LrclibClient({
    http: h.http,
    clock: h.clock,
    clientId: 'LyricsCompanion-test/0.1.0 (test)',
    minIntervalMs: 0,
  });
  return new PlaylistLyricsBatch({
    store: h.store,
    lyrics: new LrclibLyricsProvider(lrclib),
    clock: h.clock,
    ids: h.ids,
    logger: h.logger,
    ...opts,
  });
}

const lrclibGets = (h: Harness) => h.http.calls.filter((c: HttpRequest) => c.url.includes('/api/get'));

/** 합성 곡(가사 픽스처 없음) */
const UNKNOWN: ServiceTrackRef = {
  service: 'apple-music',
  serviceTrackId: '9009',
  title: 'No Such Song Anywhere',
  artist: 'Nobody',
  album: null,
  durationMs: 120_000,
  isrc: null,
};

/** 같은 곡 이름·길이지만 LRCLIB 레코드(200초)와 길이가 크게 다른 녹음 */
const LONG_VERSION: ServiceTrackRef = { ...TRACKS.enStudio, serviceTrackId: 'am.long', durationMs: 260_000 };

describe('AT-19 플레이리스트 가사 원문 일괄 받기', () => {
  it('[AT-19][REQ-LY-05][REQ-TR-05] 여러 곡의 원문을 한 번에 저장하고, AI는 부르지 않으며, 나중에 재생하면 다시 조회하지 않는다', async () => {
    const h = await harness({ autoTranslate: true });
    const batch = batchFor(h);
    const tracks = [TRACKS.jaStudio, TRACKS.jaPlain, TRACKS.instrumental, UNKNOWN, LONG_VERSION];
    const progress: BatchState[] = [];
    batch.subscribe((s) => progress.push(s));

    const end = await batch.start({ label: '테스트 플레이리스트', tracks });

    expect(end?.stoppedBy).toBe('completed');
    expect(end?.items.map((i) => i.status)).toEqual(['saved', 'saved', 'saved', 'not-found', 'incompatible-version']);
    expect(end?.items.slice(0, 3).map((i) => i.kind)).toEqual(['synced', 'plain', 'instrumental']);
    expect(end?.done).toBe(5);
    expect(summarizeBatch(end!)).toBe('5/5곡 · 새로 저장 3 · 못 찾음 2');
    expect(progress.some((s) => s.running && s.current?.index === 2)).toBe(true);
    // 일괄 받기는 가사 원문만: AI 호출 0회(자동 번역이 켜져 있어도)
    expect(h.provider.calls).toHaveLength(0);
    // 로그에 제목·가사가 남지 않는다
    expect(h.sink.dump()).not.toContain('夜明け');

    // 나중에 재생: 저장본 사용, LRCLIB 추가 조회 0회
    const before = lrclibGets(h).length;
    await h.session.onTrackChanged(TRACKS.jaStudio);
    await h.session.idle();
    expect(h.session.current.phase).toBe('ready');
    expect(h.session.current.lyrics?.id).toBeDefined();
    expect(h.session.current.lyrics?.kind).toBe('synced');
    expect(lrclibGets(h).length).toBe(before);
  });

  it('[AT-19][REQ-LY-05][REQ-LY-04] 이미 가사가 있는 곡은 조회하지 않고 건너뛴다 — 다시 실행하면 남은 곡만 이어서 받는다', async () => {
    const h = await harness({ autoTranslate: false });
    // 재생으로 먼저 받은 곡 + 사용자 번역
    await h.session.onTrackChanged(TRACKS.jaStudio);
    await h.session.idle();
    const lv = h.session.current.lyrics!;
    const first = lv.lines.find((l) => l.text.trim() !== '')!;
    expect((await h.session.saveUserTranslation({ [first.id]: '내 번역' })).ok).toBe(true);
    const callsBefore = lrclibGets(h).length;

    const batch = batchFor(h);
    const end = await batch.start({ label: 'p', tracks: [TRACKS.jaStudio, TRACKS.jaPlain] });
    expect(end?.items.map((i) => i.status)).toEqual(['already-saved', 'saved']);
    expect(lrclibGets(h).length).toBe(callsBefore + 1); // jaPlain 한 곡만 조회
    // 기존 판본·사용자 번역은 그대로
    const song = await h.store.getSong(h.session.current.song!.id);
    expect(song?.activeLyricsVersionId).toBe(lv.id);
    const tr = await h.store.listTranslations(lv.id);
    expect(tr.map((t) => t.origin)).toEqual(['user']);

    // 두 번째 실행: 모두 저장되어 네트워크 0회
    const again = await batch.start({ label: 'p', tracks: [TRACKS.jaStudio, TRACKS.jaPlain] });
    expect(again?.items.map((i) => i.status)).toEqual(['already-saved', 'already-saved']);
    expect(lrclibGets(h).length).toBe(callsBefore + 1);
    expect(await batch.savedIndexes([TRACKS.jaStudio, UNKNOWN, TRACKS.jaPlain])).toEqual(new Set([0, 2]));
  });

  it('[AT-19][REQ-LY-03] 저장된 곡과 같은 녹음인지 불확실하면 곡을 만들지도 조회하지도 않고 "확인 필요"로 남긴다', async () => {
    const h = await harness({ autoTranslate: false });
    await h.session.onTrackChanged(TRACKS.jaPlain); // ID 없는 서비스에서 저장된 곡
    await h.session.idle();
    const songsBefore = (await h.store.listSongs()).length;
    const callsBefore = lrclibGets(h).length;
    // 같은 제목·가수·길이지만 다른 서비스 ID(같은 녹음인지 모름)
    const maybeSame: ServiceTrackRef = { ...TRACKS.jaPlain, service: 'youtube-music', serviceTrackId: 'yt.other' };

    const end = await batchFor(h).start({ label: 'p', tracks: [maybeSame] });

    expect(end?.items[0]?.status).toBe('needs-song-confirmation');
    expect(end?.items[0]?.songId).toBeNull();
    expect((await h.store.listSongs()).length).toBe(songsBefore);
    expect(lrclibGets(h).length).toBe(callsBefore);
    expect(summarizeBatch(end!)).toBe('1/1곡 · 확인 필요 1');
  });

  it('[AT-19][REQ-LY-05] 같은 곡이 두 번 있으면 한 번만 조회한다', async () => {
    const h = await harness();
    const end = await batchFor(h).start({ label: 'p', tracks: [TRACKS.jaStudio, TRACKS.jaStudio] });
    expect(end?.items.map((i) => i.status)).toEqual(['saved', 'duplicate']);
    expect(lrclibGets(h)).toHaveLength(1);
  });

  it('[AT-19][REQ-LY-05] 실행 중에 다시 시작하면 거절하고, 취소하면 다음 곡 전에 멈추며 저장한 곡은 남는다', async () => {
    const h = await harness();
    const batch = batchFor(h);
    batch.subscribe((s) => {
      if (s.running && s.done === 1) batch.cancel();
    });
    const p = batch.start({ label: 'p', tracks: [TRACKS.jaStudio, TRACKS.jaPlain, TRACKS.instrumental] });
    expect(batch.start({ label: 'q', tracks: [UNKNOWN] })).toBeNull();
    const end = await p;
    expect(end?.stoppedBy).toBe('cancelled');
    expect(end?.done).toBe(1);
    expect(lrclibGets(h)).toHaveLength(1);
    expect(await batch.savedIndexes([TRACKS.jaStudio, TRACKS.jaPlain])).toEqual(new Set([0]));
    expect(batch.current.running).toBe(false);
  });

  it('[AT-19][REQ-LY-05][REQ-SEC-06] 오프라인이면 남은 곡을 오류로 만들지 않고 멈춘다', async () => {
    const h = await harness();
    h.http.offline = true;
    const end = await batchFor(h).start({ label: 'p', tracks: [TRACKS.jaStudio, TRACKS.jaPlain] });
    expect(end?.stoppedBy).toBe('offline');
    expect(end?.done).toBe(0);
    expect(lrclibGets(h)).toHaveLength(1);
  });

  it('[AT-19][REQ-LY-05] 서버 오류가 연속되면 멈춘다(곡별 오류는 기록)', async () => {
    const h = await harness();
    h.http.prepend(
      (r) => r.url.includes('/api/get'),
      () => jsonResponse(500, { message: 'synthetic error' }),
    );
    const tracks = [TRACKS.jaStudio, TRACKS.jaPlain, TRACKS.instrumental, UNKNOWN];
    const end = await batchFor(h).start({ label: 'p', tracks });
    expect(end?.stoppedBy).toBe('too-many-errors');
    expect(end?.items.map((i) => i.status)).toEqual(['error', 'error', 'error']);
  });

  it('[AT-19][REQ-LY-05] 요청 제한(429): 짧으면 기다렸다 같은 곡을 다시 받고, 길면 멈추고 남은 시간을 알린다', async () => {
    const h = await harness();
    let limited = 1;
    h.http.prepend(
      (r) => r.url.includes('/api/get') && limited > 0,
      () => {
        limited -= 1;
        return { status: 429, headers: { 'retry-after': '5' }, bodyText: 'Too Many Requests' };
      },
    );
    const batch = batchFor(h);
    const p = batch.start({ label: 'p', tracks: [TRACKS.jaStudio, TRACKS.jaPlain] });
    await waitFor(() => batch.current.waitingMs === 5000);
    h.clock.advance(5000);
    const end = await p;
    expect(end?.stoppedBy).toBe('completed');
    expect(end?.items.map((i) => i.status)).toEqual(['saved', 'saved']);
    expect(lrclibGets(h)).toHaveLength(3);

    // 긴 Retry-After → 기다리지 않고 멈춤
    const h2 = await harness();
    h2.http.prepend(
      (r) => r.url.includes('/api/get'),
      () => ({ status: 429, headers: { 'retry-after': '120' }, bodyText: '' }),
    );
    const end2 = await batchFor(h2).start({ label: 'p', tracks: [TRACKS.jaStudio, TRACKS.jaPlain] });
    expect(end2?.stoppedBy).toBe('rate-limited');
    expect(end2?.retryAfterMs).toBe(120_000);
    expect(end2?.done).toBe(0);
    expect(lrclibGets(h2)).toHaveLength(1);
  });
});

describe('보관함 곡 → 재생 곡 정보', () => {
  it('[REQ-LY-05][REQ-PB-06] 플레이리스트 곡과 지금 재생 곡은 같은 serviceKey가 된다(스토어 ID 유무 모두)', () => {
    const raw = { title: '夜明けのホーム', artist: 'Synthetic Band', album: 'Test Album', durationSec: 210.4 };
    for (const storeId of ['1440833098', '0']) {
      const [lib] = mapLibraryTracks([{ persistentId: '7', ...raw, storeId }]);
      const now = mapIosTrack({ hasItem: true, ...raw, storeId });
      expect(serviceKeyOf(libraryTrackToRef(lib!))).toBe(serviceKeyOf(now!));
      expect(libraryTrackToRef(lib!).service).toBe(now!.service);
    }
  });
});
