/**
 * LRCLIB 일시 오류(503 ServerOverloaded 등) 재시도 — docs/plan.md D-33.
 * 실제 LRCLIB는 부하가 몰리면 요청 일부에 503 + Retry-After: 1을 돌려주고, 1초 뒤 같은 요청은 대부분 성공한다.
 * 합성 응답·FakeClock만 쓴다(실제 네트워크 없음).
 */
import { describe, expect, it } from 'vitest';
import { LrclibClient, type LrclibRecord } from '../../src/lyrics/lrclib-client.js';
import { AppleMusicLyricsProvider } from '../../src/lyrics/apple-music-lyrics-provider.js';
import { HttpError, type HttpRequest } from '../../src/ports.js';
import { FakeClock, FakeHttp, jsonResponse } from '../support/fakes.js';

const RECORD: LrclibRecord = {
  id: 7,
  trackName: '合成の歌',
  artistName: '合成バンド',
  albumName: 'Test Album',
  duration: 200,
  instrumental: false,
  plainLyrics: '一行目\n二行目',
  syncedLyrics: '[00:01.00]一行目\n[00:05.00]二行目',
  hasWordSync: false,
};

const OVERLOADED = () =>
  jsonResponse(
    503,
    { message: 'The server is busy, please retry in a moment', name: 'ServerOverloaded', statusCode: 503 },
    { 'retry-after': '1' },
  );

function client(http: FakeHttp, clock: FakeClock) {
  return new LrclibClient({ http, clock, clientId: 'LyricsCompanion-test/0.1 (test)', minIntervalMs: 0 });
}

/** 대기(sleep)를 FakeClock으로 진행시키며 결과를 기다린다 */
async function settle<T>(p: Promise<T>, clock: FakeClock): Promise<T> {
  let done = false;
  let value!: T;
  void p.then((v) => {
    done = true;
    value = v;
  });
  for (let i = 0; i < 200 && !done; i++) {
    await new Promise<void>((r) => setImmediate(r));
    await clock.flushSleeps();
  }
  if (!done) throw new Error('settle timeout');
  return value;
}

describe('LRCLIB 일시 오류 재시도(D-33)', () => {
  it('[REQ-LY-01] 503 + Retry-After: 1이면 1초 기다렸다 같은 요청을 다시 보내 가사를 받는다', async () => {
    const clock = new FakeClock();
    let n = 0;
    const http = new FakeHttp().on(
      () => true,
      () => (n++ === 0 ? OVERLOADED() : jsonResponse(200, RECORD)),
    );
    const start = clock.monotonicMs();
    const r = await settle(client(http, clock).get({ trackName: 'a', artistName: 'b' }), clock);
    expect(r.status).toBe('found');
    expect(http.calls).toHaveLength(2);
    expect(http.calls[1]!.url).toBe(http.calls[0]!.url);
    expect(clock.monotonicMs() - start).toBeGreaterThanOrEqual(1000);
  });

  it('[REQ-LY-01] 502·504·Cloudflare 52x도 일시 오류로 다시 시도한다(Retry-After 없으면 1·2초…)', async () => {
    for (const status of [502, 504, 522]) {
      const clock = new FakeClock();
      let n = 0;
      const http = new FakeHttp().on(
        () => true,
        () => (n++ < 2 ? { status, headers: {}, bodyText: 'bad gateway' } : jsonResponse(200, RECORD)),
      );
      const start = clock.monotonicMs();
      const r = await settle(client(http, clock).get({ trackName: 'a', artistName: 'b' }), clock);
      expect(r.status).toBe('found');
      expect(http.calls).toHaveLength(3);
      expect(clock.monotonicMs() - start).toBeGreaterThanOrEqual(3000);
    }
  });

  it('[REQ-LY-01] 계속 503이면 정해진 횟수(3번)만 다시 보내고 서버 오류로 끝낸다', async () => {
    const clock = new FakeClock();
    const http = new FakeHttp().on(() => true, OVERLOADED);
    const r = await settle(client(http, clock).get({ trackName: 'a', artistName: 'b' }), clock);
    expect(r).toMatchObject({ status: 'error', kind: 'server' });
    expect(http.calls).toHaveLength(4);
  });

  it('[REQ-LY-01] 503 Retry-After가 길면 다시 시도하지 않고, 그동안 요청을 보내지 않는다', async () => {
    const clock = new FakeClock();
    const http = new FakeHttp().on(
      () => true,
      () => jsonResponse(503, { message: 'maintenance' }, { 'retry-after': '120' }),
    );
    const c = client(http, clock);
    expect(await c.get({ trackName: 'a', artistName: 'b' })).toMatchObject({ status: 'error', kind: 'server' });
    expect(await c.get({ trackName: 'a', artistName: 'b' })).toMatchObject({ status: 'rate_limited' });
    expect(http.calls).toHaveLength(1);
  });

  it('[REQ-LY-01] 429는 클라이언트가 다시 보내지 않는다(호출자가 Retry-After를 보고 판단)', async () => {
    const clock = new FakeClock();
    const http = new FakeHttp().on(
      () => true,
      () => ({ status: 429, headers: { 'retry-after': '1' }, bodyText: '' }),
    );
    expect(await client(http, clock).get({ trackName: 'a', artistName: 'b' })).toEqual({
      status: 'rate_limited',
      retryAfterMs: 1000,
    });
    expect(http.calls).toHaveLength(1);
  });

  it('[REQ-LY-01] 503 대기 중에는 줄 서 있던 다른 요청도 같이 쉰다', async () => {
    const clock = new FakeClock();
    let n = 0;
    const http = new FakeHttp().on(
      () => true,
      () => (n++ === 0 ? OVERLOADED() : jsonResponse(200, RECORD)),
    );
    const c = client(http, clock);
    const p1 = c.get({ trackName: 'a', artistName: 'b' });
    const p2 = c.get({ trackName: 'c', artistName: 'd' });
    await new Promise<void>((r) => setImmediate(r));
    expect(http.calls).toHaveLength(1); // 1초 대기 중: 두 번째 요청도 아직 안 보냄
    const [r1, r2] = await Promise.all([settle(p1, clock), settle(p2, clock)]);
    expect(r1.status).toBe('found');
    expect(r2.status).toBe('found');
    expect(http.calls).toHaveLength(3);
  });

  it('[REQ-LY-01] 시간 초과는 한 번만 다시 보낸다', async () => {
    const clock = new FakeClock();
    let n = 0;
    const flaky = new FakeHttp();
    flaky.send = async (req: HttpRequest) => {
      flaky.calls.push(req);
      if (n++ === 0) throw new HttpError('timeout', 'timed out', 'unknown');
      return jsonResponse(200, RECORD);
    };
    expect((await settle(client(flaky, clock).get({ trackName: 'a', artistName: 'b' }), clock)).status).toBe('found');
    expect(flaky.calls).toHaveLength(2);

    const always = new FakeHttp();
    always.send = async (req: HttpRequest) => {
      always.calls.push(req);
      throw new HttpError('timeout', 'timed out', 'unknown');
    };
    const r = await settle(client(always, clock).get({ trackName: 'a', artistName: 'b' }), clock);
    expect(r).toMatchObject({ status: 'error', kind: 'timeout' });
    expect(always.calls).toHaveLength(2);
  });

  it('[REQ-LY-01][REQ-LY-03] 제목 검색이 서버 오류로 끝나면 "가사 없음"이 아니라 오류로 알린다', async () => {
    const clock = new FakeClock();
    const http = new FakeHttp()
      .on(
        (r) => r.url.startsWith('https://lrclib.net/api/get?'),
        () => jsonResponse(404, { statusCode: 404, name: 'TrackNotFound', message: 'x' }),
      )
      .on((r) => r.url.startsWith('https://lrclib.net/api/search?'), OVERLOADED);
    const lrclib = client(http, clock);
    const provider = new AppleMusicLyricsProvider({ lrclib, catalog: null });
    const r = await settle(
      provider.fetch({ title: '合成の歌', artist: '合成バンド', album: null, durationMs: 200_000 }),
      clock,
    );
    expect(r).toMatchObject({ status: 'error', kind: 'server' });
  });
});
