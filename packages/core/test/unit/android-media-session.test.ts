import { describe, expect, it } from 'vitest';
import {
  androidPositionMs,
  androidSupports,
  androidTrackId,
  cleanYouTubeMusicMeta,
  mapAndroidAccess,
  mapAndroidQueue,
  mapAndroidSnapshot,
  mapAndroidState,
  mapAndroidTrack,
  pickAndroidSession,
  streamingServiceLabel,
  type AndroidSessionRaw,
} from '../../src/playback/android-media-session.js';
import { sameServiceTrack } from '../../src/playback/musickit-web.js';
import { serviceKeyOf } from '../../src/matching/track-identity.js';
import { computeSync } from '../../src/sync/sync-engine.js';

/** 합성 값(실제 곡 아님). Spotify 곡 ID는 22자 base62 형식만 맞춘 가짜 값 */
const SPOTIFY: AndroidSessionRaw = {
  packageName: 'com.spotify.music',
  hasMetadata: true,
  title: '夜明けのホーム',
  artist: 'Synthetic Band',
  album: 'Test Album',
  durationMs: 210_000,
  mediaId: 'spotify:track:0SyntheticTrackId00001',
  state: 3,
  positionMs: 17_000,
  lastPositionUpdateTime: 1_000_000,
  speed: 1,
  readAtElapsedMs: 1_000_500,
  actions: 4 + 2 + 16 + 32 + 256 + 4096,
};

const YTM: AndroidSessionRaw = {
  packageName: 'com.google.android.apps.youtube.music',
  hasMetadata: true,
  title: 'Paper Lanterns',
  artist: 'Imaginary Duo',
  album: 'Lantern EP',
  durationMs: 200_000,
  mediaId: 'AbCdEf12_-Z',
  state: 2,
  positionMs: 40_000,
  lastPositionUpdateTime: 5_000,
  speed: 0,
  readAtElapsedMs: 900_000,
};

describe('Android 미디어 세션 값 변환', () => {
  it('[REQ-PB-07] Spotify 세션을 곡 정보로 바꾼다(22자 곡 ID, ISRC 없음)', () => {
    const s = mapAndroidSnapshot(SPOTIFY, 7_000);
    expect(s.track).toEqual({
      service: 'spotify',
      serviceTrackId: '0SyntheticTrackId00001',
      title: '夜明けのホーム',
      artist: 'Synthetic Band',
      album: 'Test Album',
      durationMs: 210_000,
      isrc: null,
    });
    expect(s.status).toBe('playing');
    expect(s.capturedAtMonotonicMs).toBe(7_000);
    expect(s.rate).toBe(1);
  });

  it('[REQ-PB-07][REQ-SY-02] 재생 중 위치 = 앱이 알린 위치 + (읽은 시각 − 갱신 시각) × 속도, 멈춤이면 그대로', () => {
    // 갱신 0.5초 뒤에 읽음 → 17.5초
    expect(mapAndroidSnapshot(SPOTIFY, 0).positionMs).toBe(17_500);
    // 2배속
    expect(mapAndroidSnapshot({ ...SPOTIFY, speed: 2 }, 0).positionMs).toBe(18_000);
    // 일시정지: 오래전 갱신이어도 위치는 움직이지 않는다
    expect(mapAndroidSnapshot(YTM, 0)).toMatchObject({ status: 'paused', positionMs: 40_000, rate: 0 });
  });

  it('[REQ-PB-07][REQ-SY-02] 위치 모름(-1)·숫자 아님·오래된 재생 상태·곡 길이 초과는 위치 모름으로 두고 진행을 꾸며내지 않는다', () => {
    expect(mapAndroidSnapshot({ ...SPOTIFY, positionMs: -1 }, 0).positionMs).toBeNull();
    expect(mapAndroidSnapshot({ ...SPOTIFY, positionMs: '17000' }, 0).positionMs).toBeNull();
    // 7시간 전 갱신된 "재생 중"
    expect(mapAndroidSnapshot({ ...SPOTIFY, readAtElapsedMs: 1_000_000 + 7 * 3_600_000 }, 0).positionMs).toBeNull();
    // 계산 결과가 곡 길이(210초)를 3초 넘게 지남 → 앱이 상태를 갱신하지 않은 것
    expect(mapAndroidSnapshot({ ...SPOTIFY, readAtElapsedMs: 1_000_000 + 200_000 }, 0).positionMs).toBeNull();
    // 곡 끝 근처는 곡 길이로 자름
    expect(mapAndroidSnapshot({ ...SPOTIFY, readAtElapsedMs: 1_000_000 + 194_000 }, 0).positionMs).toBe(210_000);
    const sync = computeSync({
      kind: 'synced',
      lines: [{ id: 'l1', text: 'a', startMs: 0 }],
      snapshot: mapAndroidSnapshot({ ...SPOTIFY, positionMs: -1 }, 0),
      nowMonotonicMs: 1000,
      offsetMs: 0,
    });
    expect(sync).toEqual({ mode: 'unknown', reason: 'no-position' });
  });

  it('[REQ-PB-07][REQ-SY-02] 갱신 시각을 모르거나 읽은 시각보다 미래면 경과를 더하지 않는다(앞서가지 않음)', () => {
    expect(androidPositionMs({ ...SPOTIFY, lastPositionUpdateTime: 0 }, 'playing', 210_000)).toBe(17_000);
    expect(androidPositionMs({ ...SPOTIFY, lastPositionUpdateTime: undefined }, 'playing', 210_000)).toBe(17_000);
    expect(androidPositionMs({ ...SPOTIFY, readAtElapsedMs: 999_000 }, 'playing', 210_000)).toBe(17_000);
    expect(androidPositionMs({ ...SPOTIFY, readAtElapsedMs: Number.NaN }, 'playing', null)).toBe(17_000);
  });

  it('[REQ-PB-07] PlaybackState 정수 상태를 core 상태로 바꾼다(버퍼링·건너뛰는 중은 진행 추정 안 함)', () => {
    expect(mapAndroidState(3)).toBe('playing');
    expect(mapAndroidState(2)).toBe('paused');
    for (const v of [0, 1, 7]) expect(mapAndroidState(v)).toBe('stopped');
    for (const v of [4, 5, 6, 8, 9, 10, 11]) expect(mapAndroidState(v)).toBe('buffering');
    expect(mapAndroidState(99)).toBe('unknown');
    expect(mapAndroidState('3')).toBe('unknown');
    const buffering = mapAndroidSnapshot({ ...SPOTIFY, state: 6 }, 0);
    expect(buffering).toMatchObject({ status: 'buffering', positionMs: 17_000, rate: 0 });
  });

  it('[REQ-PB-07][REQ-SEC-06] 지원하지 않는 앱·곡 정보 없음·노래가 아닌 항목(광고·팟캐스트)은 곡으로 보지 않는다', () => {
    expect(mapAndroidTrack({ ...SPOTIFY, packageName: 'com.example.chat' })).toBeNull();
    expect(mapAndroidTrack({ ...SPOTIFY, hasMetadata: false })).toBeNull();
    expect(mapAndroidTrack({ ...SPOTIFY, title: '  ' })).toBeNull();
    expect(mapAndroidTrack({ ...SPOTIFY, mediaId: 'spotify:ad:000000000000000000000000' })).toBeNull();
    expect(mapAndroidTrack({ ...SPOTIFY, mediaId: 'spotify:episode:0SyntheticEpisode00001' })).toBeNull();
    const none = mapAndroidSnapshot({ ...SPOTIFY, mediaId: 'spotify:ad:x' }, 0);
    expect(none).toMatchObject({ track: null, status: 'stopped', positionMs: null });
  });

  it('[REQ-PB-07][REQ-LY-03] 곡 ID는 형식을 확신할 때만 쓴다(Android Apple Music의 MEDIA_ID는 스토어 ID로 쓰지 않음)', () => {
    expect(androidTrackId('spotify', 'spotify:track:0SyntheticTrackId00001')).toBe('0SyntheticTrackId00001');
    expect(androidTrackId('spotify', 'spotify:track:short')).toBeNull();
    expect(androidTrackId('spotify', 'spotify:local:a:b:c:200')).toBeNull();
    expect(androidTrackId('youtube-music', 'AbCdEf12_-Z')).toBe('AbCdEf12_-Z');
    expect(androidTrackId('youtube-music', 'not a video id')).toBeNull();
    expect(androidTrackId('apple-music', '900000001')).toBeNull();
    const am = mapAndroidTrack({ ...SPOTIFY, packageName: 'com.apple.android.music', mediaId: '900000001' })!;
    expect(am.service).toBe('apple-music');
    expect(am.serviceTrackId).toBeNull();
    // 같은 서비스(iPhone 스토어 ID 900000001)와 키가 겹치지 않는다
    expect(serviceKeyOf(am)).not.toBe('id:900000001');
  });

  it('[REQ-PB-07][REQ-LY-03] YouTube Music 동영상 표기는 정리하되 녹음 버전 표시(Live 등)는 남긴다', () => {
    expect(cleanYouTubeMusicMeta('Paper Lanterns (Official Music Video)', 'Imaginary Duo - Topic')).toEqual({
      title: 'Paper Lanterns',
      artist: 'Imaginary Duo',
    });
    expect(cleanYouTubeMusicMeta('Imaginary Duo - Paper Lanterns [MV]', 'Imaginary Duo').title).toBe('Paper Lanterns');
    expect(cleanYouTubeMusicMeta('Synthetic Band「夜明けのホーム」Official Music Video', 'Synthetic Band').title).toBe(
      '夜明けのホーム',
    );
    expect(cleanYouTubeMusicMeta('夜明けのホーム【公式】', 'Synthetic Band - 주제')).toEqual({
      title: '夜明けのホーム',
      artist: 'Synthetic Band',
    });
    // 버전 표시는 지우지 않는다
    expect(cleanYouTubeMusicMeta('Paper Lanterns (Official Live Video)', 'Imaginary Duo').title).toBe(
      'Paper Lanterns (Official Live Video)',
    );
    expect(cleanYouTubeMusicMeta('Paper Lanterns (Night Remix)', 'Imaginary Duo').title).toBe(
      'Paper Lanterns (Night Remix)',
    );
    // 정리할 것이 없으면 그대로, 정리 결과가 비면 원래 값
    expect(cleanYouTubeMusicMeta('Paper Lanterns', 'Imaginary Duo').title).toBe('Paper Lanterns');
    expect(cleanYouTubeMusicMeta('(Official Video)', 'Imaginary Duo').title).toBe('(Official Video)');
    // 가수가 다른 "A - B"는 지우지 않는다
    expect(cleanYouTubeMusicMeta('Someone Else - Paper Lanterns', 'Imaginary Duo').title).toBe(
      'Someone Else - Paper Lanterns',
    );
    // Spotify에는 적용하지 않는다
    expect(mapAndroidTrack({ ...SPOTIFY, title: 'Song (Official Video)' })!.title).toBe('Song (Official Video)');
    expect(mapAndroidTrack({ ...YTM, title: 'Paper Lanterns (Official Video)' })!.title).toBe('Paper Lanterns');
  });

  it('[REQ-PB-07] 알림 접근 상태 변환', () => {
    expect(mapAndroidAccess('granted')).toBe('granted');
    expect(mapAndroidAccess('not-granted')).toBe('not-determined');
    expect(mapAndroidAccess('unsupported')).toBe('unsupported');
    expect(mapAndroidAccess(undefined)).toBe('unsupported');
    expect(streamingServiceLabel('spotify')).toBe('Spotify');
    expect(streamingServiceLabel('youtube-music')).toBe('YouTube Music');
    expect(streamingServiceLabel('unknown')).toBe('재생 앱');
  });

  it('[REQ-PB-07] 재생 제어 가능 여부(actions 비트)', () => {
    expect(androidSupports(SPOTIFY, 'seekTo')).toBe(true);
    expect(androidSupports(SPOTIFY, 'skipToQueueItem')).toBe(true);
    expect(androidSupports(SPOTIFY, 'playFromSearch')).toBe(false);
    expect(androidSupports({ ...SPOTIFY, actions: 2_097_152 + 2048 }, 'setShuffleMode')).toBe(true);
    // 2^31을 넘는 비트가 있어도 판정이 깨지지 않는다
    expect(androidSupports({ ...SPOTIFY, actions: 2 ** 40 + 256 }, 'seekTo')).toBe(true);
    expect(androidSupports({ ...SPOTIFY, actions: 'x' }, 'seekTo')).toBe(false);
    expect(androidSupports(null, 'play')).toBe(false);
  });
});

describe('Android 세션 고르기', () => {
  const other = { ...SPOTIFY, packageName: 'com.example.video', state: 3 };
  it('[REQ-PB-07] 재생 중인 지원 앱을 따르고, 지원하지 않는 앱의 세션은 쓰지 않는다', () => {
    expect(pickAndroidSession([other, YTM], null)?.packageName).toBe(YTM.packageName);
    expect(pickAndroidSession([other], null)).toBeNull();
    expect(pickAndroidSession([YTM, SPOTIFY], null)?.packageName).toBe(SPOTIFY.packageName);
  });

  it('[REQ-PB-07] 둘 다 재생 중이면 지금 따르는 앱을 유지하고, 모두 멈추면 따르던 앱 그대로(가사 화면이 오가지 않음)', () => {
    const ytmPlaying = { ...YTM, state: 3 };
    expect(pickAndroidSession([SPOTIFY, ytmPlaying], 'com.google.android.apps.youtube.music')?.packageName).toBe(
      YTM.packageName,
    );
    expect(pickAndroidSession([SPOTIFY, ytmPlaying], null)?.packageName).toBe(SPOTIFY.packageName);
    const spotifyPaused = { ...SPOTIFY, state: 2 };
    expect(pickAndroidSession([YTM, spotifyPaused], 'com.spotify.music')?.packageName).toBe(SPOTIFY.packageName);
    expect(pickAndroidSession([{ ...YTM, hasMetadata: false }, spotifyPaused], null)?.packageName).toBe(
      SPOTIFY.packageName,
    );
  });

  it('[REQ-PB-07][REQ-LY-03] 서비스가 다르면 같은 제목이어도 다른 곡으로 본다(곡 변경 감지)', () => {
    const a = mapAndroidTrack(SPOTIFY)!;
    // 곡 ID 문자열이 같아도 서비스가 다르면 다른 곡
    expect(sameServiceTrack(a, { ...a, service: 'youtube-music' })).toBe(false);
    expect(
      sameServiceTrack({ ...a, serviceTrackId: null }, { ...a, serviceTrackId: null, service: 'apple-music' }),
    ).toBe(false);
    expect(sameServiceTrack(a, { ...a })).toBe(true);
  });
});

describe('Android 재생 목록', () => {
  it('[REQ-PB-08][REQ-LY-05] 재생 목록 항목을 지금 재생과 같은 규칙의 곡 정보로 바꿔 같은 곡 연결 키를 쓴다', () => {
    const q = mapAndroidQueue('com.spotify.music', [
      {
        queueId: '11',
        title: '夜明けのホーム',
        subtitle: 'Synthetic Band',
        mediaId: 'spotify:track:0SyntheticTrackId00001',
      },
      { queueId: '12', title: 'Ad', subtitle: '', mediaId: 'spotify:ad:000' },
      { queueId: '13', title: 'Paper Lanterns', subtitle: 'Imaginary Duo • Lantern EP', durationMs: 200_000 },
      { queueId: '11', title: '중복 ID', subtitle: 'x' },
      { queueId: 'abc', title: '잘못된 ID' },
      null,
    ]);
    expect(q.map((x) => x.queueId)).toEqual(['11', '13']);
    expect(serviceKeyOf(q[0]!.ref)).toBe(serviceKeyOf(mapAndroidTrack(SPOTIFY)!));
    expect(q[1]!.ref).toMatchObject({ artist: 'Imaginary Duo', durationMs: 200_000, serviceTrackId: null });
    const ytm = mapAndroidQueue('com.google.android.apps.youtube.music', [
      { queueId: '-5', title: 'Paper Lanterns (Official Video)', subtitle: 'Imaginary Duo', mediaId: 'AbCdEf12_-Z' },
    ]);
    expect(ytm[0]!.ref).toMatchObject({ title: 'Paper Lanterns', serviceTrackId: 'AbCdEf12_-Z' });
    expect(serviceKeyOf(ytm[0]!.ref)).toBe(serviceKeyOf(mapAndroidTrack(YTM)!));
    expect(mapAndroidQueue('com.example.video', [{ queueId: '1', title: 'x' }])).toEqual([]);
    expect(mapAndroidQueue('com.spotify.music', 'not array')).toEqual([]);
  });
});
