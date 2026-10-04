import { describe, expect, it } from 'vitest';
import { ItunesCatalogClient, parseCatalogResponse } from '../../src/catalog/itunes-catalog.js';
import {
  mapIosAuthorization,
  mapIosSnapshot,
  mapIosState,
  normalizeStoreId,
  sameIosTrack,
} from '../../src/playback/ios-system-player.js';
import { computeSync } from '../../src/sync/sync-engine.js';
import {
  validateProviderConfig,
  parseProviderConfig,
  serializeProviderConfig,
} from '../../src/translation/provider-config.js';
import { HttpError } from '../../src/ports.js';
import { FakeClock, FakeHttp } from '../support/fakes.js';
import { createHarness, fixture } from '../support/harness.js';

const RAW_PLAYING = {
  hasItem: true,
  title: '夜明けのホーム',
  artist: 'Synthetic Band',
  album: 'Test Album',
  durationSec: 210.4,
  storeId: '900000001',
  state: 'playing',
  positionSec: 12.5,
  rate: 1,
};

function textResponse(status: number, body: string) {
  return { status, headers: { 'content-type': 'text/javascript; charset=utf-8' }, bodyText: body };
}

describe('iOS systemMusicPlayer 값 변환', () => {
  it('[REQ-PB-01] 재생 중 곡·위치·상태를 core 스냅샷으로 바꾼다(초→ms, 스토어 ID 유지)', () => {
    const s = mapIosSnapshot(RAW_PLAYING, 5000);
    expect(s.track).toEqual({
      service: 'apple-music',
      serviceTrackId: '900000001',
      title: '夜明けのホーム',
      artist: 'Synthetic Band',
      album: 'Test Album',
      durationMs: 210_400,
      isrc: null,
    });
    expect(s.status).toBe('playing');
    expect(s.positionMs).toBe(12_500);
    expect(s.capturedAtMonotonicMs).toBe(5000);
    expect(s.rate).toBe(1);
  });

  it('[REQ-PB-01] 스토어 ID "0"·빈 값·숫자 아님은 ID 없음으로 처리한다(라이브러리 전용 곡)', () => {
    expect(normalizeStoreId('0')).toBeNull();
    expect(normalizeStoreId('')).toBeNull();
    expect(normalizeStoreId('12a')).toBeNull();
    expect(normalizeStoreId(123)).toBeNull();
    expect(normalizeStoreId(' 1490256995 ')).toBe('1490256995');
    expect(mapIosSnapshot({ ...RAW_PLAYING, storeId: '0' }, 0).track?.serviceTrackId).toBeNull();
  });

  it('[REQ-PB-01][REQ-SY-02] 위치가 NaN·음수면 위치 모름으로 두고 진행을 꾸며내지 않는다', () => {
    const s = mapIosSnapshot({ ...RAW_PLAYING, positionSec: Number.NaN }, 0);
    expect(s.positionMs).toBeNull();
    const sync = computeSync({
      kind: 'synced',
      lines: [{ id: 'l1', text: 'a', startMs: 0 }],
      snapshot: s,
      nowMonotonicMs: 1000,
      offsetMs: 0,
    });
    expect(sync).toEqual({ mode: 'unknown', reason: 'no-position' });
    expect(mapIosSnapshot({ ...RAW_PLAYING, positionSec: -3 }, 0).positionMs).toBeNull();
  });

  it('[REQ-PB-01] 곡이 없거나 제목이 없으면 track=null, 상태는 stopped', () => {
    expect(mapIosSnapshot({ hasItem: false }, 0)).toMatchObject({ track: null, status: 'stopped', positionMs: null });
    expect(mapIosSnapshot({ ...RAW_PLAYING, title: '   ' }, 0).track).toBeNull();
    expect(mapIosSnapshot({ ...RAW_PLAYING, hasItem: 'yes' }, 0).track).toBeNull();
  });

  it('[REQ-PB-01][REQ-SY-02] 상태 매핑: 중단→일시정지, 탐색 중→진행 추정 안 함, 알 수 없는 값→unknown', () => {
    expect(mapIosState('interrupted')).toBe('paused');
    expect(mapIosState('seekingForward')).toBe('buffering');
    expect(mapIosState('weird')).toBe('unknown');
    const paused = mapIosSnapshot({ ...RAW_PLAYING, state: 'paused', rate: 1 }, 0);
    expect(paused.rate).toBe(0);
    const badRate = mapIosSnapshot({ ...RAW_PLAYING, rate: Number.POSITIVE_INFINITY }, 0);
    expect(badRate.rate).toBe(1);
  });

  it('[REQ-PB-01] 권한 상태 매핑', () => {
    expect(mapIosAuthorization('authorized')).toBe('granted');
    expect(mapIosAuthorization('restricted')).toBe('denied');
    expect(mapIosAuthorization('notDetermined')).toBe('not-determined');
    expect(mapIosAuthorization(undefined)).toBe('unsupported');
  });

  it('[REQ-PB-01] 곡 변경 판단: ID가 있으면 ID로, 없으면 메타데이터로 비교', () => {
    const a = mapIosSnapshot(RAW_PLAYING, 0).track;
    const b = mapIosSnapshot({ ...RAW_PLAYING, positionSec: 99 }, 0).track;
    const c = mapIosSnapshot({ ...RAW_PLAYING, storeId: '900000009' }, 0).track;
    const libA = mapIosSnapshot({ ...RAW_PLAYING, storeId: '0' }, 0).track;
    const libB = mapIosSnapshot({ ...RAW_PLAYING, storeId: '0', title: '다른 곡' }, 0).track;
    expect(sameIosTrack(a, b)).toBe(true);
    expect(sameIosTrack(a, c)).toBe(false);
    expect(sameIosTrack(libA, libB)).toBe(false);
    expect(sameIosTrack(null, null)).toBe(true);
    expect(sameIosTrack(a, null)).toBe(false);
  });

  it('[REQ-PB-01][REQ-ST-01] iOS 스냅샷으로 세션을 열면 저장된 가사를 쓰고 싱크 화면을 만든다', async () => {
    const h = await createHarness();
    const snap = mapIosSnapshot(RAW_PLAYING, h.clock.monotonicMs());
    await h.session.onTrackChanged(snap.track!);
    await h.session.idle();
    expect(h.session.current.phase).toBe('ready');
    const view = h.session.screen(snap);
    expect(view?.mode).toBe('synced');
    const lrclibCalls = h.http.calls.length;
    // 같은 곡 재진입: 네트워크 재조회 없음
    await h.session.onTrackChanged(snap.track!);
    await h.session.idle();
    expect(h.http.calls.length).toBe(lrclibCalls);
    await h.close();
  });
});

describe('Apple Music 곡 검색(iTunes Search)', () => {
  it('[REQ-PB-05][REQ-SEC-07] 곡만 남기고 형식이 틀린 항목·중복·비 https 이미지·이상한 길이를 거른다', () => {
    const tracks = parseCatalogResponse(fixture('catalog/itunes-search-jp.json'), 'jp');
    expect(tracks).toEqual([
      {
        storeId: '900000001',
        title: '夜明けのホーム',
        artist: 'Synthetic Band',
        album: 'Test Album',
        durationMs: 210_000,
        artworkUrl: 'https://example.invalid/art/100x100bb.jpg',
        storefront: 'jp',
      },
      {
        storeId: '900000004',
        title: '雨上がりのメモ (Live)',
        artist: 'Synthetic Band',
        album: 'Test Album',
        durationMs: null,
        artworkUrl: null,
        storefront: 'jp',
      },
    ]);
  });

  it('[REQ-SEC-07] JSON 아님·results 없음·과대 본문은 거부한다', () => {
    expect(parseCatalogResponse('<html>', 'jp')).toBeNull();
    expect(parseCatalogResponse('{"x":1}', 'jp')).toBeNull();
    expect(parseCatalogResponse(`{"results":[${'0,'.repeat(600_000)}0]}`, 'jp')).toBeNull();
  });

  it('[REQ-PB-05] kr 결과가 0건이면 다음 storefront(jp)를 시도한다(text/javascript 응답 허용)', async () => {
    const clock = new FakeClock();
    const http = new FakeHttp().on(
      () => true,
      (r) => {
        const country = new URL(r.url).searchParams.get('country');
        return textResponse(
          200,
          fixture(country === 'jp' ? 'catalog/itunes-search-jp.json' : 'catalog/itunes-search-empty.json'),
        );
      },
    );
    const c = new ItunesCatalogClient({ http, clock, minIntervalMs: 0 });
    const r = await c.search('  夜明け  ');
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.tracks[0]?.storefront).toBe('jp');
    expect(http.calls.map((x) => new URL(x.url).searchParams.get('country'))).toEqual(['kr', 'jp']);
    const u = new URL(http.calls[0]!.url);
    expect(u.origin + u.pathname).toBe('https://itunes.apple.com/search');
    expect(u.searchParams.get('term')).toBe('夜明け');
    expect(u.searchParams.get('entity')).toBe('song');
  });

  it('[REQ-PB-05] 빈 검색어는 요청하지 않고, 오류·제한은 다음 storefront로 넘기지 않고 바로 알린다', async () => {
    const clock = new FakeClock();
    const http = new FakeHttp().on(
      () => true,
      () => textResponse(403, 'denied'),
    );
    const c = new ItunesCatalogClient({ http, clock, minIntervalMs: 0 });
    expect(await c.search('   ')).toEqual({ status: 'error', kind: 'bad_request' });
    expect(http.calls).toHaveLength(0);
    expect(await c.search('a')).toEqual({ status: 'error', kind: 'rate_limited' });
    expect(http.calls).toHaveLength(1);
  });

  it('[REQ-PB-05] 오프라인이면 offline 오류', async () => {
    const http = new FakeHttp().on(
      () => true,
      () => {
        throw new HttpError('offline', 'no network', 'no');
      },
    );
    const c = new ItunesCatalogClient({ http, clock: new FakeClock(), minIntervalMs: 0 });
    expect(await c.search('a')).toEqual({ status: 'error', kind: 'offline' });
  });

  it('[REQ-PB-05] 요청 간 최소 간격을 지킨다', async () => {
    const clock = new FakeClock();
    const http = new FakeHttp().on(
      () => true,
      () => textResponse(200, fixture('catalog/itunes-search-empty.json')),
    );
    const c = new ItunesCatalogClient({ http, clock, storefronts: ['kr', 'jp'], minIntervalMs: 1000 });
    const p = c.search('a');
    await Promise.resolve();
    await Promise.resolve();
    expect(http.calls).toHaveLength(1);
    await clock.flushSleeps();
    expect(await p).toEqual({ status: 'ok', tracks: [] });
    expect(http.calls).toHaveLength(2);
  });
});

describe('AI 제공자 설정', () => {
  it('[REQ-TR-01][REQ-SEC-04] https 주소·모델·ID 형식을 검사하고 인증정보가 든 주소는 거부한다', () => {
    const ok = validateProviderConfig({
      providerId: 'openai',
      baseUrl: 'https://api.example.com/v1/',
      model: 'some-model',
    });
    expect(ok).toEqual({
      ok: true,
      config: {
        providerId: 'openai',
        baseUrl: 'https://api.example.com/v1',
        model: 'some-model',
        structuredOutput: true,
      },
    });
    expect(validateProviderConfig({ providerId: 'x', baseUrl: 'http://api.example.com', model: 'm' }).ok).toBe(false);
    expect(validateProviderConfig({ providerId: 'x', baseUrl: 'https://user:pw@api.example.com', model: 'm' }).ok).toBe(
      false,
    );
    expect(
      validateProviderConfig({ providerId: 'x', baseUrl: 'https://api.example.com/v1?key=abc', model: 'm' }).ok,
    ).toBe(false);
    expect(validateProviderConfig({ providerId: 'Bad ID', baseUrl: 'https://a.example', model: 'm' }).ok).toBe(false);
    expect(validateProviderConfig({ providerId: 'x', baseUrl: 'https://a.example', model: '' }).ok).toBe(false);
    expect(parseProviderConfig('not json')).toBeNull();
  });

  it('[REQ-TR-01][REQ-SEC-01] 설정은 SQLite에 저장·재시작 후 유지되고, 키 필드는 저장되지 않는다', async () => {
    const h = await createHarness();
    // 가짜 키는 실행 중에 조립한다(비밀정보 검사 규칙)
    const fakeKey = ['sk', 'test', 'SHOULD-NOT-BE-STORED', '123456'].join('-');
    const strayField = { ['api' + 'Key']: fakeKey };
    await h.store.setProviderConfig({
      providerId: 'openai',
      baseUrl: 'https://api.example.com/v1',
      model: 'm1',
      structuredOutput: false,
      // 잘못 섞여 들어온 키 필드는 직렬화에서 제외되어야 한다
      ...strayField,
    });
    const h2 = await h.restart();
    expect(await h2.store.getProviderConfig()).toEqual({
      providerId: 'openai',
      baseUrl: 'https://api.example.com/v1',
      model: 'm1',
      structuredOutput: false,
    });
    const rows = await h2.driver.all<{ value: string }>('SELECT value FROM settings');
    expect(JSON.stringify(rows)).not.toContain('SHOULD-NOT-BE-STORED');
    await h2.store.setProviderConfig(null);
    expect(await h2.store.getProviderConfig()).toBeNull();
    expect(
      serializeProviderConfig({ providerId: 'a', baseUrl: 'https://a.example', model: 'm', structuredOutput: true }),
    ).not.toContain('key');
    await h2.close();
  });
});
