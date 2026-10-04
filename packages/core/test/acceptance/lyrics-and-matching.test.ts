/**
 * 곡 식별(AT-08)과 가사 상태(AT-09) 수용 테스트.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, fixtureJson, TRACKS, type Harness } from '../support/harness.js';
import { jsonResponse } from '../support/fakes.js';
import { decideMatch, isLyricsRecordCompatible, parseTitle } from '../../src/matching/track-identity.js';
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

describe('AT-08 다른 녹음 버전을 혼동하지 않는다', () => {
  it.each([
    ['Paper Lanterns', null, []],
    ['Paper Lanterns (Live at Hall)', null, ['live']],
    ['Paper Lanterns - Live', null, ['live']],
    ['Paper Lanterns (Night Remix)', null, ['remix']],
    ['夜明けのホーム (TV Size)', null, ['tv-size']],
    ['夜明けのホーム (English ver.)', null, ['version:english']],
    ['夜明けのホーム (Instrumental)', null, ['instrumental']],
    ['夜明けのホーム - 2019 Remaster', null, []],
    ['Paper Lanterns (feat. Someone)', null, []],
    ['Live Forever', null, []],
    ['Paper Lanterns', 'Live at Budokan', ['live']],
  ])('[AT-08][REQ-LY-03] 버전 태그 추출: %s / 앨범 %s → %j', (title, album, tags) => {
    expect(parseTitle(title, album).versionTags).toEqual(tags);
  });

  it('[AT-08][REQ-LY-03] 라이브 녹음은 스튜디오 저장본·번역을 쓰지 않고 별도 곡으로 관리된다', async () => {
    const h = await harness({ autoTranslate: true });
    await h.session.onTrackChanged(TRACKS.enStudio);
    await h.session.idle();
    const studio = h.session.current;
    await h.session.onTrackChanged(TRACKS.enLive);
    await h.session.idle();
    const live = h.session.current;
    expect(live.song?.id).not.toBe(studio.song?.id);
    expect(live.song?.versionTags).toEqual(['live']);
    expect(live.lyrics?.sourceRef).toBe('lrclib:1003');
    expect(live.translation?.lyricsVersionId).toBe(live.lyrics?.id);
    expect(h.provider.calls).toHaveLength(2);
  });

  it('[AT-08][REQ-LY-03] ID 없는 리믹스는 스튜디오 곡에 연결되지 않고, 가사를 찾지 못하면 AI도 호출하지 않는다', async () => {
    const h = await harness({ autoTranslate: true });
    await h.session.onTrackChanged(TRACKS.enStudio);
    await h.session.idle();
    await h.session.onTrackChanged(TRACKS.enRemix);
    await h.session.idle();
    expect(h.session.current.phase).toBe('no-lyrics');
    expect(h.session.current.song?.versionTags).toEqual(['remix']);
    expect(h.provider.calls).toHaveLength(1);
  });

  it('[AT-08][REQ-LY-03] 다른 서비스의 같은 녹음은 ISRC로 기존 저장본에 연결된다(추가 조회·번역 없음)', async () => {
    const h = await harness({ autoTranslate: true });
    await h.session.onTrackChanged(TRACKS.enStudio);
    await h.session.idle();
    const http = h.http.calls.length;
    const sameOnApple: ServiceTrackRef = {
      ...TRACKS.enStudio,
      service: 'apple-music',
      serviceTrackId: 'am.paper',
      durationMs: 200_900,
    };
    await h.session.onTrackChanged(sameOnApple);
    await h.session.idle();
    expect(h.session.current.phase).toBe('ready');
    expect(h.session.current.translation).not.toBeNull();
    expect(h.http.calls.length).toBe(http);
    expect(h.provider.calls).toHaveLength(1);
  });

  it('[AT-08][REQ-LY-03] ISRC 없이 메타데이터만 같으면 후보로 제시하고, 사용자가 거절하면 새 곡으로 관리한다', async () => {
    const h = await harness({ autoTranslate: false });
    await h.session.onTrackChanged(TRACKS.enStudio);
    await h.session.idle();
    const ytm: ServiceTrackRef = { ...TRACKS.enStudio, service: 'youtube-music', serviceTrackId: null, isrc: null };
    await h.session.onTrackChanged(ytm);
    expect(h.session.current.phase).toBe('needs-confirmation');
    await h.session.rejectCandidates();
    await h.session.idle();
    expect((await h.store.listSongs()).length).toBe(2);
  });

  it('[AT-08][REQ-LY-03] 길이가 2초 넘게 다르거나 ISRC가 다르면 후보에서도 제외한다', () => {
    const song = {
      id: 's1',
      title: 'Paper Lanterns',
      artist: 'Imaginary Duo',
      album: 'Lantern EP',
      durationMs: 200_000,
      versionTags: [],
      isrc: 'USZZ02600002',
      activeLyricsVersionId: null,
      createdAtEpochMs: 0,
    };
    expect(decideMatch({ ...TRACKS.enStudio, isrc: null, durationMs: 203_500 }, [song]).kind).toBe('new');
    expect(decideMatch({ ...TRACKS.enStudio, isrc: 'USZZ09999999' }, [song]).kind).toBe('new');
    expect(decideMatch({ ...TRACKS.enStudio, isrc: null, durationMs: 201_500 }, [song]).kind).toBe('candidates');
  });

  it('[AT-08][REQ-LY-03][REQ-LY-01] 가사 API가 다른 버전(라이브) 레코드를 주면 저장하지 않는다', async () => {
    expect(
      isLyricsRecordCompatible(
        { title: 'Paper Lanterns', album: 'Lantern EP', durationMs: 200_000 },
        { trackName: 'Paper Lanterns (Live at Hall)', albumName: 'Live at Hall', durationSec: 200 },
      ),
    ).toBe(false);
    const h = await harness({ autoTranslate: true });
    h.http.prepend(
      (r) => r.url.includes('/api/get?') && r.url.includes('Paper'),
      () => jsonResponse(200, { ...fixtureJson<Record<string, unknown>>('lrclib/get-en-live.json'), duration: 200 }),
    );
    await h.session.onTrackChanged(TRACKS.enStudio);
    await h.session.idle();
    expect(h.session.current.phase).toBe('no-lyrics');
    expect(h.session.current.notices).toContain('incompatible-version');
    expect(h.provider.calls).toHaveLength(0);
  });
});

describe('AT-09 가사 상태 구분', () => {
  async function load(track: ServiceTrackRef, autoTranslate = true): Promise<Harness> {
    const h = await harness({ autoTranslate });
    await h.session.onTrackChanged(track);
    await h.session.idle();
    return h;
  }

  it('[AT-09][REQ-LY-02][REQ-SY-01] 싱크 가사: 행 단위 시간 정보로 저장된다', async () => {
    const h = await load(TRACKS.jaStudio);
    const lv = h.session.current.lyrics!;
    expect(lv.kind).toBe('synced');
    expect(lv.language).toBe('ja');
    expect(lv.lines.map((l) => l.startMs)).toEqual([12000, 17500, 23000, 28400, 30000, 35200, 41000, 46800, 205000]);
  });

  it('[AT-09][REQ-LY-02][REQ-SY-04] 일반 가사만 있으면 정적 가사 화면으로 표시한다', async () => {
    const h = await load({ ...TRACKS.jaPlain });
    expect(h.session.current.lyrics?.kind).toBe('plain');
    expect(
      h.session.screen({
        track: TRACKS.jaPlain,
        status: 'playing',
        positionMs: 5000,
        capturedAtMonotonicMs: h.clock.monotonicMs(),
        rate: 1,
      })?.mode,
    ).toBe('static');
  });

  it('[AT-09][REQ-LY-02] 연주곡: 번역을 요청하지 않는다', async () => {
    const h = await load(TRACKS.instrumental);
    expect(h.session.current.lyrics?.kind).toBe('instrumental');
    expect(h.session.screen(null)?.mode).toBe('instrumental');
    expect(h.provider.calls).toHaveLength(0);
  });

  it('[AT-09][REQ-LY-02] 가사 없음: no-lyrics 상태, AI 호출 없음', async () => {
    const h = await load({ ...TRACKS.enStudio, title: 'Unknown Song', serviceTrackId: 'sp:unknown', isrc: null });
    expect(h.session.current.phase).toBe('no-lyrics');
    expect(h.provider.calls).toHaveLength(0);
  });

  it('[AT-09][REQ-LY-02] 잘못된 LRC + 일반 가사: 일반 가사로 대체하고 알림을 남긴다', async () => {
    const h = await load({
      ...TRACKS.enStudio,
      title: 'Broken Clock',
      serviceTrackId: 'sp:broken',
      isrc: null,
      durationMs: 150_000,
    });
    expect(h.session.current.lyrics?.kind).toBe('plain');
    expect(h.session.current.notices).toContain('invalid-synced');
  });

  it('[AT-09][REQ-LY-02] 잘못된 LRC만 있으면 저장하지 않고 오류로 표시한다', async () => {
    const h = await load({
      ...TRACKS.enStudio,
      title: 'Broken Clock Only',
      serviceTrackId: 'sp:broken2',
      isrc: null,
      durationMs: 150_000,
    });
    expect(h.session.current.phase).toBe('no-lyrics');
    expect(h.session.current.notices).toContain('lyrics-error');
    expect(await h.store.listSongs()).toHaveLength(1);
    expect((await h.store.listSongs())[0]?.activeLyricsVersionId).toBeNull();
  });

  it('[AT-09][REQ-SY-01] 단어 단위 싱크가 있어도 행 단위로만 표시하고 그렇다고 표시한다', async () => {
    const h = await load(
      { ...TRACKS.enStudio, title: 'Word Steps', serviceTrackId: 'sp:word', isrc: null, durationMs: 120_000 },
      false,
    );
    const lv = h.session.current.lyrics!;
    expect(lv.kind).toBe('synced');
    expect(lv.hasWordTimingSource).toBe(true);
    expect(lv.lines.map((l) => l.text)).toEqual(['Paper lanterns drifting', 'over the river']);
    expect(h.session.current.notices).toContain('word-sync-ignored');
    expect(h.session.screen(null)?.wordLevelSync).toBe(false);
  });
});
