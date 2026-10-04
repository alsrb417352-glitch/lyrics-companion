import { describe, expect, it } from 'vitest';
import { LrclibClient } from '../../src/lyrics/lrclib-client.js';
import { classifyLrclibRecord } from '../../src/lyrics/lyrics-provider.js';
import { buildLyricsVersion } from '../../src/lyrics/lyrics-version.js';
import { parseLrc } from '../../src/lyrics/lrc.js';
import { previewLrcImport, previewTxtImport, validateUserMapping } from '../../src/import/user-translation-import.js';
import { redactText, redactValue, REDACTED } from '../../src/security/redact.js';
import { composeLyricsView } from '../../src/display/compose.js';
import { FakeClock, FakeHttp, jsonResponse } from '../support/fakes.js';
import { fixture, fixtureJson } from '../support/harness.js';
import { validateRecord } from '../../src/lyrics/lrclib-client.js';
import { Logger } from '../../src/security/logger.js';
import { SecretRegistry } from '../../src/security/redact.js';
import { MemorySink } from '../support/fakes.js';

function client(http: FakeHttp, clock = new FakeClock(), minIntervalMs = 300) {
  return { c: new LrclibClient({ http, clock, clientId: 'LyricsCompanion/0.1 (test)', minIntervalMs }), clock };
}

describe('LRCLIB 클라이언트', () => {
  it('[REQ-LY-01] 식별 헤더·쿼리 인코딩·duration 반올림을 적용한다', async () => {
    const http = new FakeHttp().on(
      () => true,
      () => jsonResponse(200, fixtureJson('lrclib/get-ja-synced.json')),
    );
    const { c } = client(http);
    const r = await c.get({
      trackName: '夜明けのホーム',
      artistName: 'Synthetic Band',
      albumName: 'Test Album',
      durationSec: 209.6,
    });
    expect(r.status).toBe('found');
    const req = http.calls[0]!;
    expect(req.headers['User-Agent']).toContain('LyricsCompanion');
    expect(req.headers['Lrclib-Client']).toContain('LyricsCompanion');
    const url = new URL(req.url);
    expect(url.pathname).toBe('/api/get');
    expect(url.searchParams.get('track_name')).toBe('夜明けのホーム');
    expect(url.searchParams.get('duration')).toBe('210');
  });

  it('[REQ-LY-01] 요청을 순차 처리하고 최소 간격을 둔다', async () => {
    const http = new FakeHttp().on(
      () => true,
      () => jsonResponse(404, fixtureJson('lrclib/error-404.json')),
    );
    const { c, clock } = client(http);
    const p1 = c.get({ trackName: 'a', artistName: 'b' });
    const p2 = c.get({ trackName: 'c', artistName: 'd' });
    await p1;
    await Promise.resolve();
    expect(http.calls).toHaveLength(1); // 두 번째 요청은 300ms 대기 중
    await clock.flushSleeps();
    expect((await p2).status).toBe('not_found');
    expect(http.calls).toHaveLength(2);
  });

  it('[REQ-LY-01] 429(본문 JSON 아님): Retry-After 동안 요청을 보내지 않는다', async () => {
    const http = new FakeHttp().on(
      () => true,
      () => ({
        status: 429,
        headers: { 'retry-after': '5', 'content-type': 'text/html' },
        bodyText: fixture('lrclib/rate-limited-429.txt'),
      }),
    );
    const { c, clock } = client(http, new FakeClock(), 0);
    expect(await c.get({ trackName: 'a', artistName: 'b' })).toEqual({ status: 'rate_limited', retryAfterMs: 5000 });
    expect((await c.get({ trackName: 'a', artistName: 'b' })).status).toBe('rate_limited');
    expect(http.calls).toHaveLength(1);
    clock.advance(5001);
    await c.get({ trackName: 'a', artistName: 'b' });
    expect(http.calls).toHaveLength(2);
  });

  it('[REQ-LY-01][REQ-SEC-07] 400 일반 텍스트·잘못된 레코드·오프라인을 오류로 분류한다', async () => {
    const http = new FakeHttp()
      .on(
        (r) => r.url.includes('bad'),
        () => ({
          status: 400,
          headers: { 'content-type': 'text/plain' },
          bodyText: 'Failed to deserialize query string',
        }),
      )
      .on(
        (r) => r.url.includes('shape'),
        () => jsonResponse(200, fixtureJson('lrclib/get-invalid-shape.json')),
      )
      .on(
        (r) => r.url.includes('html'),
        () => ({ status: 200, headers: { 'content-type': 'text/html' }, bodyText: '<html>' }),
      );
    const { c } = client(http, new FakeClock(), 0);
    expect(await c.get({ trackName: 'bad', artistName: 'x' })).toMatchObject({ status: 'error', kind: 'bad_request' });
    expect(await c.get({ trackName: 'shape', artistName: 'x' })).toMatchObject({
      status: 'error',
      kind: 'invalid_response',
    });
    expect(await c.get({ trackName: 'html', artistName: 'x' })).toMatchObject({
      status: 'error',
      kind: 'invalid_response',
    });
    http.offline = true;
    expect(await c.get({ trackName: 'x', artistName: 'y' })).toMatchObject({ status: 'error', kind: 'offline' });
  });

  it('[REQ-LY-01] 검색: 잘못된 레코드는 걸러내고 버전 정보는 그대로 둔다', async () => {
    const http = new FakeHttp().on(
      () => true,
      () => jsonResponse(200, fixtureJson('lrclib/search-paper-lanterns.json')),
    );
    const { c } = client(http, new FakeClock(), 0);
    const r = await c.search({ q: 'paper lanterns' });
    expect(r.status === 'ok' && r.records.map((x) => x.id)).toEqual([1002, 1003]);
    expect((await c.search({})).status).toBe('error');
  });

  it('[REQ-LY-02] 레코드 분류: 싱크/일반/연주곡/빈 레코드', () => {
    const rec = (f: string) => validateRecord(fixtureJson(f))!;
    expect(classifyLrclibRecord(rec('lrclib/get-ja-synced.json'))).toMatchObject({ status: 'found', kind: 'synced' });
    expect(classifyLrclibRecord(rec('lrclib/get-ja-plain-only.json'))).toMatchObject({
      status: 'found',
      kind: 'plain',
    });
    expect(classifyLrclibRecord(rec('lrclib/get-instrumental.json'))).toMatchObject({
      status: 'found',
      kind: 'instrumental',
    });
    expect(classifyLrclibRecord({ ...rec('lrclib/get-ja-plain-only.json'), plainLyrics: '  ' })).toEqual({
      status: 'not_found',
      reason: 'empty',
    });
  });
});

describe('사용자 번역 가져오기', () => {
  const lv = buildLyricsVersion({
    id: 'lv',
    songId: 's',
    source: 'lrclib',
    sourceRef: null,
    kind: 'synced',
    timed: parseLrc(fixture('lyrics/ja-synced.lrc')).lines,
    createdAtEpochMs: 0,
  });

  it('[REQ-ED-02] TXT 행 수가 같으면 제안 매핑, 다르면 자동으로 끼워 맞추지 않는다', () => {
    const ok = previewTxtImport(lv, fixture('import/user-ja-full.txt'));
    expect(ok.requiresManualMapping).toBe(false);
    expect(ok.proposed?.['l0005']).toBe('랄라라 둘이서');
    const bad = previewTxtImport(lv, fixture('import/user-ja-mismatch.txt'));
    expect(bad.proposed).toBeNull();
    expect(bad.requiresManualMapping).toBe(true);
    expect(bad.issues[0]).toMatchObject({ code: 'LINE_COUNT_MISMATCH' });
  });

  it('[REQ-ED-02] LRC는 시간이 일치하는 행만 제안하고 나머지는 수동 연결로 넘긴다', () => {
    const r = previewLrcImport(lv, fixture('import/user-ja-partial.lrc'));
    expect(r.proposed).toEqual({ l0001: '새벽의 역에서 너를 기다려', l0003: '빛 속으로 달려 나가' });
    expect(r.unmatched).toEqual(['존재하지 않는 시간의 행']);
    expect(r.requiresManualMapping).toBe(true);
  });

  it('[REQ-ED-01][REQ-ED-02][REQ-SEC-08] 확정 매핑 검증: 모르는 행 ID 거부, 부분 번역 허용', () => {
    expect(validateUserMapping(lv, { l9999: 'x' })).toMatchObject({ ok: false });
    expect(validateUserMapping(lv, { l0001: '하나' })).toMatchObject({ ok: true, coverage: 'partial' });
    expect(previewTxtImport(lv, '깨진�문자').issues.map((i) => i.code)).toContain('ENCODING_SUSPECT');
  });
});

describe('마스킹·표시 구성', () => {
  it('[REQ-SEC-01] 등록된 키·알려진 키 형식·민감 필드 이름을 가린다', () => {
    const k = ['sk', 'ant', 'api03', 'Q'.repeat(30)].join('-');
    expect(redactText(`key=${k}`)).toBe(`key=${REDACTED}`);
    expect(redactText('my custom secret value 12345', ['custom secret value'])).toBe(`my ${REDACTED} 12345`);
    expect(redactValue({ headers: { Authorization: 'Bearer abc.def.ghi' }, n: 1 })).toEqual({
      headers: { Authorization: REDACTED },
      n: 1,
    });
  });

  it('[REQ-SEC-01] Logger는 싱크에 쓰기 전에 등록된 키와 민감 필드를 가린다', () => {
    const secrets = new SecretRegistry();
    const key = ['user', 'provided', 'key', 'value', '7'.repeat(10)].join('_');
    secrets.register(key);
    const sink = new MemorySink();
    const logger = new Logger(sink, new FakeClock(), secrets);
    logger.error('provider.error', {
      message: `rejected key ${key}`,
      headers: { Authorization: `Bearer ${key}`, 'x-api-key': key },
      nested: [{ note: key }],
    });
    expect(sink.dump()).not.toContain(key);
    expect(sink.entries[0]?.data).toEqual({
      message: `rejected key ${REDACTED}`,
      headers: { Authorization: REDACTED, 'x-api-key': REDACTED },
      nested: [{ note: REDACTED }],
    });
  });

  it('[REQ-UI-04][REQ-UI-02] 접근성 라벨은 원문·발음·번역을 한 묶음으로 읽는다', () => {
    const lv = buildLyricsVersion({
      id: 'lv',
      songId: 's',
      source: 'user',
      sourceRef: null,
      kind: 'plain',
      plain: ['光の中へ'],
      createdAtEpochMs: 0,
    });
    const view = composeLyricsView({
      lyrics: lv,
      translation: {
        id: 't',
        lyricsVersionId: 'lv',
        origin: 'user',
        lines: { l0001: '빛 속으로' },
        sourceTextHash: '',
        provenance: null,
        createdAtEpochMs: 0,
        seq: 1,
      },
      pronunciation: {
        id: 'p',
        lyricsVersionId: 'lv',
        origin: 'ai',
        lines: { l0001: { kana: 'ひかりのなかえ', hangul: '히카리노나카에' } },
        sourceTextHash: '',
        provenance: null,
        createdAtEpochMs: 0,
        seq: 1,
      },
      settings: { showTranslation: true, showPronunciation: true },
      sync: { mode: 'static', reason: 'plain' },
    });
    expect(view.rows[0]?.accessibilityLabel).toBe('光の中へ. 발음 히카리노나카에. 번역 빛 속으로');
    expect(view.mode).toBe('static');
  });
});
