/**
 * 실패 상황 수용 테스트 (AT-11, AT-12).
 * 오프라인·권한 거부·인증 오류·요청 제한·타임아웃·앱 종료·잘못된 AI 응답·저장 실패.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { providerErrors } from '../support/fakes.js';
import { createHarness, fixture, TRACKS, type Harness } from '../support/harness.js';
import { waitFor } from '../support/wait.js';
import type { ServiceTrackRef } from '../../src/ports.js';

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

/** ja 곡을 번역까지 저장해 둔 하네스 */
async function withStoredJa(): Promise<Harness> {
  const h = await harness({ autoTranslate: true });
  await h.session.onTrackChanged(TRACKS.jaStudio);
  await h.session.idle();
  expect(h.session.current.translation).not.toBeNull();
  return h;
}

describe('AT-11 장애 상황에서도 저장본 유지', () => {
  it('[AT-11][REQ-ST-02] 오프라인: 저장된 곡은 가사·번역을 그대로 보여주고, 새 곡은 가사 없음으로 표시', async () => {
    const h = await withStoredJa();
    const stored = h.session.current.translation;
    const h2 = await h.restart();
    open.push(h2);
    h2.http.offline = true;
    h2.provider.throwOnce(providerErrors.offline());

    await h2.session.onTrackChanged(TRACKS.jaStudio);
    await h2.session.idle();
    expect(h2.session.current.phase).toBe('ready');
    expect(h2.session.current.translation?.id).toBe(stored?.id);
    expect(h2.http.calls).toHaveLength(0);
    expect(h2.provider.calls).toHaveLength(0);

    await h2.session.onTrackChanged(TRACKS.enStudio);
    await h2.session.idle();
    expect(h2.session.current.phase).toBe('no-lyrics');
    expect(h2.session.current.notices).toContain('offline');
    // 기존 저장본 영향 없음
    const jaSong = (await h2.store.listSongs()).find((s) => s.title === '夜明けのホーム')!;
    expect(await h2.store.listTranslations(jaSong.activeLyricsVersionId!)).toHaveLength(1);
  });

  it('[AT-11][REQ-PB-02][REQ-LY-03] 재생 정보 권한 거부: 수동 선택한 곡이 후보 확인을 거쳐 저장본에 연결된다', async () => {
    const h = await withStoredJa();
    const calls = h.provider.calls.length;
    const manual: ServiceTrackRef = {
      service: 'unknown',
      serviceTrackId: null,
      title: '夜明けのホーム',
      artist: 'Synthetic Band',
      album: null,
      durationMs: null,
      isrc: null,
    };
    await h.session.onTrackChanged(manual);
    expect(h.session.current.phase).toBe('needs-confirmation');
    expect(h.session.current.candidates).toHaveLength(1);
    await h.session.confirmCandidate(h.session.current.candidates[0]!.song.id);
    await h.session.idle();
    expect(h.session.current.translation?.origin).toBe('ai');
    expect(h.provider.calls.length).toBe(calls);
    // 위치 정보가 없으므로 진행을 만들어 내지 않는다
    expect(h.session.screen(null)?.mode).toBe('position-unknown');
  });

  it('[AT-11][REQ-TR-10][REQ-SEC-01] 인증 오류: 실패로 기록하고 자동 재시도하지 않으며 기존 저장본은 유지', async () => {
    const h = await withStoredJa();
    h.provider.throwOnce(providerErrors.auth('Incorrect API key provided'));
    await h.session.onTrackChanged(TRACKS.enStudio);
    await h.session.idle();
    expect(h.session.current.translationStatus).toBe('failed');
    const lv = h.session.current.lyrics!;
    const jobs = await h.store.listJobs({ lyricsVersionId: lv.id });
    expect(jobs.map((j) => j.status)).toEqual(['failed']);
    expect(jobs[0]?.failure?.retryScope).toBe('none');
    expect(await h.store.listTranslations(lv.id)).toHaveLength(0);
    const calls = h.provider.calls.length;
    await h.session.onTrackChanged(TRACKS.jaStudio);
    await h.session.idle();
    expect(h.session.current.translation).not.toBeNull();
    expect(h.provider.calls.length).toBe(calls);
  });

  it('[AT-11][REQ-LY-01][REQ-TR-13] 요청 제한: AI 429는 실패로 기록, LRCLIB 429는 Retry-After 동안 재요청하지 않는다', async () => {
    const h = await harness({ autoTranslate: true });
    h.provider.throwOnce(providerErrors.rateLimited());
    await h.session.onTrackChanged(TRACKS.enStudio);
    await h.session.idle();
    const out = h.session.current.lastOutcome;
    expect(out?.kind === 'failed' && out.failure.kind).toBe('rate_limited');
    expect(out?.kind === 'failed' && out.failure.retryAfterMs).toBe(20_000);

    // LRCLIB 429 (본문이 JSON이 아님)
    const h2 = await harness({ autoTranslate: false });
    let lrclibHits = 0;
    h2.http.prepend(
      (r) => r.url.includes('lrclib.net'),
      () => {
        lrclibHits++;
        return {
          status: 429,
          headers: { 'retry-after': '30', 'content-type': 'text/html' },
          bodyText: fixture('lrclib/rate-limited-429.txt'),
        };
      },
    );
    await h2.session.onTrackChanged(TRACKS.jaStudio);
    expect(h2.session.current.notices).toContain('rate-limited');
    await h2.session.onTrackChanged(TRACKS.enStudio);
    expect(lrclibHits).toBe(1); // 차단 시간 동안 네트워크 요청 없음
    h2.clock.advance(31_000);
    await h2.session.onTrackChanged(TRACKS.enStudio);
    expect(lrclibHits).toBe(2);
  });

  it('[AT-11][REQ-TR-10] 타임아웃: 결과 미확인으로 기록하고 자동 재요청하지 않으며, 사용자 확인 후에만 재요청', async () => {
    const h = await harness({ autoTranslate: true });
    h.provider.throwOnce(providerErrors.timeout());
    await h.session.onTrackChanged(TRACKS.enStudio);
    await h.session.idle();
    const lv = h.session.current.lyrics!;
    expect((await h.store.listJobs({ lyricsVersionId: lv.id }))[0]?.status).toBe('unknown_outcome');

    await h.session.onTrackChanged(TRACKS.enStudio); // 재생 → 자동 재요청 없음
    await h.session.idle();
    expect(h.provider.calls).toHaveLength(1);
    const noAck = await h.session.requestTranslation();
    expect(noAck).toEqual({ kind: 'skipped', reason: 'unknown-outcome-pending' });
    expect(h.provider.calls).toHaveLength(1);
    const ack = await h.session.requestTranslation({ acknowledgeUnknownOutcome: true });
    expect(ack?.kind).toBe('created');
    expect(h.provider.calls).toHaveLength(2);
  });

  it('[AT-11][REQ-TR-10] 앱이 요청 중 종료되면 재실행 시 결과 미확인으로 전환하고 다시 보내지 않는다', async () => {
    const h = await createHarness({ autoTranslate: true }); // 종료를 흉내 내기 위해 close하지 않음
    h.provider.deferNext(); // 응답이 오지 않음
    await h.session.onTrackChanged(TRACKS.jaStudio);
    await waitFor(() => h.provider.calls.length === 1, 'request in flight');

    const h2 = await harness({ dbPath: h.dbPath, autoTranslate: true }); // 같은 DB로 새 프로세스 시작
    const lvId = (await h2.store.listSongs())[0]!.activeLyricsVersionId!;
    expect((await h2.store.listJobs({ lyricsVersionId: lvId }))[0]?.status).toBe('unknown_outcome');
    await h2.session.onTrackChanged(TRACKS.jaStudio);
    await h2.session.idle();
    expect(h2.provider.calls).toHaveLength(0);
    expect(h2.session.current.lastOutcome).toEqual({ kind: 'skipped', reason: 'unknown-outcome-pending' });
    await h.driver.close();
  });

  it('[AT-11][REQ-TR-13] 일일 요청 상한을 넘으면 자동 번역하지 않는다', async () => {
    const h = await harness({ autoTranslate: true, policy: { maxRequestsPerDay: 1 } });
    await h.session.onTrackChanged(TRACKS.jaStudio);
    await h.session.idle();
    await h.session.onTrackChanged(TRACKS.enStudio);
    await h.session.idle();
    expect(h.provider.calls).toHaveLength(1);
    expect(h.session.current.lastOutcome).toEqual({ kind: 'skipped', reason: 'budget' });
  });

  it('[AT-11][REQ-TR-13][REQ-SEC-05] 자동 번역은 기본값이 꺼져 있고, 켜기 전에는 AI를 호출하지 않는다', async () => {
    const h = await harness();
    expect((await h.store.getTranslationSettings()).autoTranslate).toBe(false);
    await h.session.onTrackChanged(TRACKS.jaStudio);
    await h.session.idle();
    expect(h.provider.calls).toHaveLength(0);
    expect(h.session.current.lastOutcome).toEqual({ kind: 'skipped', reason: 'auto-disabled' });
  });
});

describe('AT-12 잘못된 AI 응답과 저장 실패는 완료로 처리하지 않는다', () => {
  const invalidFixtures: Array<[string, string]> = [
    ['ai/ja-missing-line.json', 'invalid_response'],
    ['ai/ja-duplicate-id.json', 'invalid_response'],
    ['ai/ja-wrong-order.json', 'invalid_response'],
    ['ai/ja-unknown-id.json', 'invalid_response'],
    ['ai/ja-not-json.txt', 'invalid_response'],
    ['ai/ja-refusal-status.json', 'refusal'],
    ['ai/ja-refusal-text.json', 'refusal'],
  ];

  it.each(invalidFixtures)('[AT-12][REQ-TR-11] %s → 실패(%s), 번역 저장 없음', async (file, kind) => {
    const h = await harness({ autoTranslate: false });
    await h.session.onTrackChanged(TRACKS.jaStudio);
    await h.session.idle();
    const lv = h.session.current.lyrics!;
    h.provider.respondWith(fixture(file));
    const out = await h.session.requestTranslation();
    expect(out?.kind).toBe('failed');
    expect(out?.kind === 'failed' && out.failure.kind).toBe(kind);
    expect(await h.store.listTranslations(lv.id)).toHaveLength(0);
    expect(await h.store.listPronunciations(lv.id)).toHaveLength(0);
    const jobs = await h.store.listJobs({ lyricsVersionId: lv.id });
    expect(jobs.map((j) => j.status)).toEqual(['failed']);
    expect(h.session.current.translation).toBeNull();
  });

  it('[AT-12][REQ-TR-11] 번역 일부 행이 비면 번역은 저장하지 않고, 검증된 발음만 보존하며 재시도 범위를 번역으로 남긴다', async () => {
    const h = await harness({ autoTranslate: false });
    await h.session.onTrackChanged(TRACKS.jaStudio);
    await h.session.idle();
    const lv = h.session.current.lyrics!;
    h.provider.respondWith(fixture('ai/ja-empty-translation.json'));
    const out = await h.session.requestTranslation();
    expect(out?.kind === 'created' && out.translationId).toBe(null);
    expect(out?.kind === 'created' && out.partialFailure?.retryScope).toBe('translation');
    expect(out?.kind === 'created' && out.partialFailure?.message).toContain('EMPTY_TEXT@l0003');
    expect(await h.store.listTranslations(lv.id)).toHaveLength(0);
    expect(await h.store.listPronunciations(lv.id)).toHaveLength(1);
    expect(h.session.current.translationStatus).toBe('failed');
    // 이후 번역 요청은 번역만 다시 요청한다(발음은 이미 있음)
    const again = await h.session.requestTranslation();
    expect(again?.kind).toBe('created');
    expect(h.provider.calls.at(-1)?.responseSchema).not.toHaveProperty('properties.lines.items.properties.reading');
  });

  it('[AT-12][REQ-TR-11][REQ-TR-07] 번역은 유효하고 발음만 잘못되면 번역만 저장하고 발음 재시도 범위를 남긴다', async () => {
    const h = await harness({ autoTranslate: false });
    await h.session.onTrackChanged(TRACKS.jaStudio);
    await h.session.idle();
    const lv = h.session.current.lyrics!;
    h.provider.respondWith(fixture('ai/ja-kanji-in-reading.json'));
    const out = await h.session.requestTranslation();
    expect(out?.kind).toBe('created');
    expect(out?.kind === 'created' && out.partialFailure?.retryScope).toBe('pronunciation');
    expect(await h.store.listTranslations(lv.id)).toHaveLength(1);
    expect(await h.store.listPronunciations(lv.id)).toHaveLength(0);

    // 발음은 별도 요청으로만 생성되고, 번역은 다시 만들지 않는다
    const before = h.provider.calls.length;
    const pr = await h.session.requestPronunciation();
    expect(pr?.kind).toBe('created');
    expect(h.provider.calls.length).toBe(before + 1);
    expect(h.provider.calls.at(-1)?.user).toContain('읽기(reading)만');
    expect(await h.store.listTranslations(lv.id)).toHaveLength(1);
    expect(h.session.current.pronunciation?.lines['l0001']?.hangul).toBe('요아케노에키데키미오마츠');
  });

  it('[AT-12][REQ-TR-11][REQ-ST-01] 저장 실패 시 작업을 완료로 기록하지 않고 부분 데이터도 남기지 않는다', async () => {
    const h = await harness({ autoTranslate: false });
    await h.session.onTrackChanged(TRACKS.jaStudio);
    await h.session.idle();
    const lv = h.session.current.lyrics!;
    h.driver.failWhen = (sql) => sql.includes('INSERT INTO pronunciations');
    const out = await h.session.requestTranslation();
    h.driver.failWhen = null;
    expect(out?.kind === 'failed' && out.failure.kind).toBe('storage');
    expect(await h.store.listTranslations(lv.id)).toHaveLength(0); // 같은 트랜잭션의 번역도 롤백
    expect((await h.store.listJobs({ lyricsVersionId: lv.id }))[0]?.status).toBe('failed');
    // 이후 정상 응답(코드 펜스 포함)은 저장된다
    h.provider.respondWith(fixture('ai/ja-fenced-valid.txt'));
    expect((await h.session.requestTranslation())?.kind).toBe('created');
  });

  it('[AT-12][REQ-TR-11] 제공자 거절 플래그가 있으면 내용과 무관하게 저장하지 않는다', async () => {
    const h = await harness({ autoTranslate: false });
    await h.session.onTrackChanged(TRACKS.jaStudio);
    await h.session.idle();
    h.provider.respondWith(fixture('ai/ja-valid.json'), true);
    const out = await h.session.requestTranslation();
    expect(out?.kind === 'failed' && out.failure.kind).toBe('refusal');
    expect(await h.store.listTranslations(h.session.current.lyrics!.id)).toHaveLength(0);
  });
});
