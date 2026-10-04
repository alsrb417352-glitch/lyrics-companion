import { describe, expect, it } from 'vitest';
import { ItunesCatalogClient } from '../../src/catalog/itunes-catalog.js';
import { AppleMusicLyricsProvider } from '../../src/lyrics/apple-music-lyrics-provider.js';
import { LrclibClient, type LrclibRecord } from '../../src/lyrics/lrclib-client.js';
import type { HttpRequest, HttpResponse } from '../../src/ports.js';
import { FakeClock, FakeHttp, jsonResponse } from '../support/fakes.js';
import { createHarness } from '../support/harness.js';

/**
 * 합성 데이터만 사용한다(실제 곡 가사 없음).
 * 상황: 한국 Apple Music이 일본 곡 표기를 현지화해 보여 준다.
 *   Music 앱(kr): "Morning Platform" / "Synthetic Band KR"   ← LRCLIB에 없음
 *   jp 표기:      "夜明けのホーム"    / "合成バンド"          ← LRCLIB에 있음
 */
const STORE_ID = '900000101';
const DURATION_MS = 210_000;

function rec(over: Partial<LrclibRecord> & { id: number }): LrclibRecord {
  return {
    trackName: '夜明けのホーム',
    artistName: '合成バンド',
    albumName: 'Test Album',
    duration: 210,
    instrumental: false,
    plainLyrics: '一行目\n二行目',
    syncedLyrics: '[00:01.00]一行目\n[00:05.00]二行目',
    hasWordSync: false,
    ...over,
  };
}

function lookupBody(country: string): unknown {
  const names: Record<string, [string, string]> = {
    jp: ['夜明けのホーム', '合成バンド'],
    us: ['Yoake no Home', 'Gosei Band'],
    kr: ['Morning Platform', 'Synthetic Band KR'],
  };
  const [t, a] = names[country] ?? ['?', '?'];
  return {
    resultCount: 1,
    results: [
      {
        wrapperType: 'track',
        kind: 'song',
        trackId: Number(STORE_ID),
        trackName: t,
        artistName: a,
        collectionName: 'Test Album',
        trackTimeMillis: DURATION_MS,
      },
    ],
  };
}

interface World {
  http: FakeHttp;
  /** LRCLIB /api/get 이 찾아 주는 (제목|가수) */
  getIndex: Map<string, LrclibRecord>;
  /** LRCLIB /api/search 결과(track_name 기준) */
  searchIndex: Map<string, LrclibRecord[]>;
}

function world(): World {
  const http = new FakeHttp();
  const w: World = { http, getIndex: new Map(), searchIndex: new Map() };
  http.on(
    (r: HttpRequest) => r.url.startsWith('https://itunes.apple.com/lookup?'),
    (r): HttpResponse => {
      const c = new URL(r.url).searchParams.get('country') ?? '';
      return { status: 200, headers: { 'content-type': 'text/javascript' }, bodyText: JSON.stringify(lookupBody(c)) };
    },
  );
  http.on(
    (r) => r.url.startsWith('https://lrclib.net/api/get?'),
    (r) => {
      const u = new URL(r.url);
      const hit = w.getIndex.get(`${u.searchParams.get('track_name')}|${u.searchParams.get('artist_name')}`);
      return hit ? jsonResponse(200, hit) : jsonResponse(404, { statusCode: 404, name: 'TrackNotFound', message: 'x' });
    },
  );
  http.on(
    (r) => r.url.startsWith('https://lrclib.net/api/search?'),
    (r) => jsonResponse(200, w.searchIndex.get(new URL(r.url).searchParams.get('track_name') ?? '') ?? []),
  );
  return w;
}

function provider(w: World) {
  const clock = new FakeClock();
  const lrclib = new LrclibClient({ http: w.http, clock, clientId: 'LyricsCompanion-test', minIntervalMs: 0 });
  const catalog = new ItunesCatalogClient({ http: w.http, clock, minIntervalMs: 0 });
  return new AppleMusicLyricsProvider({ lrclib, catalog });
}

const KR_QUERY = {
  title: 'Morning Platform',
  artist: 'Synthetic Band KR',
  album: 'Test Album',
  durationMs: DURATION_MS,
  storeId: STORE_ID,
};

const urls = (w: World) => w.http.calls.map((c) => new URL(c.url).pathname);

describe('Apple Music 가사 자동 조회(현지화 표기 대응)', () => {
  it('[REQ-LY-03][REQ-PB-01] Music 앱 표기로 바로 찾으면 다른 표기를 조회하지 않는다', async () => {
    const w = world();
    w.getIndex.set('Morning Platform|Synthetic Band KR', rec({ id: 1, trackName: 'Morning Platform' }));
    const r = await provider(w).fetch(KR_QUERY);
    expect(r).toMatchObject({ status: 'found', kind: 'synced', sourceRef: 'lrclib:1' });
    expect(urls(w)).toEqual(['/api/get']);
  });

  it('[REQ-LY-03][REQ-PB-01] 한국 표기로 없으면 스토어 ID로 일본 표기를 얻어 다시 찾는다', async () => {
    const w = world();
    w.getIndex.set('夜明けのホーム|合成バンド', rec({ id: 2 }));
    const r = await provider(w).fetch(KR_QUERY);
    expect(r).toMatchObject({ status: 'found', kind: 'synced', sourceRef: 'lrclib:2' });
    expect(urls(w)).toEqual(['/api/get', '/lookup', '/lookup', '/lookup', '/api/get']);
  });

  it('[REQ-LY-03] get이 모두 실패하면 제목 검색에서 알려진 가수 표기·길이·버전이 맞는 레코드를 자동 적용', async () => {
    const w = world();
    w.searchIndex.set('夜明けのホーム', [
      rec({ id: 10, artistName: '다른 가수', duration: 210 }),
      rec({ id: 11, artistName: 'Gosei Band', duration: 211 }), // us 표기 가수 = 알려진 표기
      rec({ id: 12, artistName: '合成バンド', duration: 240 }), // 길이 불일치 → 제외
    ]);
    const r = await provider(w).fetch(KR_QUERY);
    expect(r).toMatchObject({ status: 'found', sourceRef: 'lrclib:11' });
  });

  it('[REQ-LY-03][AT-11] 가수 표기가 알려진 것과 다르면 자동 적용하지 않고 후보로 사용자에게 묻는다', async () => {
    const w = world();
    w.searchIndex.set('夜明けのホーム', [
      rec({ id: 20, artistName: '모르는 표기', duration: 210, syncedLyrics: null }),
      rec({ id: 21, artistName: 'Unknown Romanization', duration: 209 }),
      rec({ id: 22, trackName: '夜明けのホーム (Live)', artistName: '合成バンド', duration: 210 }), // 버전 다름 → 제외
    ]);
    const r = await provider(w).fetch(KR_QUERY);
    expect(r.status).toBe('not_found');
    if (r.status !== 'not_found') return;
    // 싱크 가사 우선 정렬, 버전이 다른 레코드는 후보에도 넣지 않음
    expect(r.candidates?.map((c) => c.id)).toEqual([21, 20]);
  });

  it('[REQ-LY-03] 길이가 크게 다른 storefront 표기는 다른 녹음일 수 있어 쓰지 않는다', async () => {
    const w = world();
    w.getIndex.set('夜明けのホーム|合成バンド', rec({ id: 30 }));
    const r = await provider(w).fetch({ ...KR_QUERY, durationMs: 250_000 });
    expect(r.status).toBe('not_found');
    expect(urls(w).filter((u) => u === '/api/get')).toHaveLength(1);
  });

  it('[REQ-LY-03] 스토어 ID가 없으면 다른 표기 조회 없이 검색으로 넘어간다', async () => {
    const w = world();
    const r = await provider(w).fetch({ ...KR_QUERY, storeId: null });
    expect(r.status).toBe('not_found');
    expect(urls(w)).toEqual(['/api/get', '/api/search']);
  });

  it('[REQ-PB-05] 스토어 ID 표기 조회: 같은 표기는 합치고, 일부 storefront 실패는 건너뛴다', async () => {
    const http = new FakeHttp().on(
      () => true,
      (r) => {
        const c = new URL(r.url).searchParams.get('country');
        if (c === 'us') return { status: 500, headers: {}, bodyText: '' };
        return { status: 200, headers: {}, bodyText: JSON.stringify(lookupBody(c === 'kr' ? 'jp' : (c ?? ''))) };
      },
    );
    const c = new ItunesCatalogClient({ http, clock: new FakeClock(), minIntervalMs: 0 });
    const r = await c.lookup(STORE_ID);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.variants.map((v) => v.artist)).toEqual(['合成バンド']);
    expect(await c.lookup('12a')).toEqual({ status: 'error', kind: 'bad_request' });
  });
});

describe('가사 후보 선택(세션)', () => {
  it('[REQ-LY-03][REQ-ST-01] 후보가 있으면 no-lyrics + 후보 표시, 사용자가 고르면 저장되어 재시작 후 네트워크 없이 표시', async () => {
    const h = await createHarness({ withProvider: false });
    const track = {
      service: 'apple-music' as const,
      serviceTrackId: '900000777',
      title: '없는 노래',
      artist: '합성 가수',
      album: null,
      durationMs: 200_000,
      isrc: null,
    };
    await h.session.onTrackChanged(track);
    await h.session.idle();
    expect(h.session.current.phase).toBe('no-lyrics');
    const choice = rec({ id: 99, trackName: '없는 노래', artistName: '다른 표기', duration: 200 });
    expect(await h.session.chooseLyricsRecord(choice)).toEqual({ ok: true });
    await h.session.idle();
    expect(h.session.current.phase).toBe('ready');
    expect(h.session.current.lyrics?.sourceRef).toBe('lrclib:99');
    expect(h.session.current.lyricsCandidates).toEqual([]);

    const h2 = await h.restart();
    const before = h2.http.calls.length;
    await h2.session.onTrackChanged(track);
    await h2.session.idle();
    expect(h2.session.current.lyrics?.sourceRef).toBe('lrclib:99');
    expect(h2.http.calls.length).toBe(before);
    await h2.close();
  });

  it('[REQ-LY-04] 다른 가사로 바꿔도 이전 판본은 보존된다', async () => {
    const h = await createHarness({ withProvider: false });
    await h.session.onTrackChanged({
      service: 'apple-music',
      serviceTrackId: 'am.1001',
      title: '夜明けのホーム',
      artist: 'Synthetic Band',
      album: 'Test Album',
      durationMs: 210_000,
      isrc: null,
    });
    await h.session.idle();
    const firstId = h.session.current.lyrics?.id;
    expect(firstId).toBeTruthy();
    await h.session.chooseLyricsRecord(rec({ id: 55, artistName: 'Synthetic Band' }));
    const songId = h.session.current.song!.id;
    const versions = await h.store.listLyricsVersions(songId);
    expect(versions.map((v) => v.id)).toContain(firstId);
    expect(h.session.current.lyrics?.sourceRef).toBe('lrclib:55');
    expect((await h.store.getSong(songId))?.activeLyricsVersionId).toBe(h.session.current.lyrics?.id);
    await h.close();
  });

  it('[REQ-LY-02] 가사가 없는 레코드는 선택해도 적용하지 않는다', async () => {
    const h = await createHarness({ withProvider: false });
    expect(await h.session.chooseLyricsRecord(rec({ id: 1 }))).toEqual({ ok: false, error: '현재 곡이 없습니다' });
    await h.session.onTrackChanged({
      service: 'apple-music',
      serviceTrackId: 'am.1001',
      title: '夜明けのホーム',
      artist: 'Synthetic Band',
      album: 'Test Album',
      durationMs: 210_000,
      isrc: null,
    });
    await h.session.idle();
    const r = await h.session.chooseLyricsRecord(rec({ id: 2, plainLyrics: null, syncedLyrics: null }));
    expect(r.ok).toBe(false);
    await h.close();
  });
});
