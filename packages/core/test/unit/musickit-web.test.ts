import { describe, expect, it } from 'vitest';
import {
  mapMusicKitQueue,
  mapMusicKitSnapshot,
  mapMusicKitState,
  mapMusicKitTrack,
  normalizeIsrc,
  pickMusicKitPositionSec,
  remoteCaptureMonotonic,
  sameServiceTrack,
  type MusicKitItemRaw,
  type MusicKitSnapshotRaw,
} from '../../src/playback/musickit-web.js';
import { mapIosTrack } from '../../src/playback/ios-system-player.js';
import { serviceKeyOf } from '../../src/matching/track-identity.js';

/** 페이지에서 확인한 MediaItem 모양을 본뜬 합성 값(실제 곡 아님) */
const ITEM: MusicKitItemRaw = {
  id: '900000001',
  type: 'song',
  title: '夜明けのホーム',
  artist: 'Synthetic Band',
  album: 'Test Album',
  durationMs: 210_000,
  isrc: 'JPZZ02600001',
  playParamsId: '900000001',
  playParamsKind: 'song',
  catalogId: '900000001',
};

const PLAYING: MusicKitSnapshotRaw = {
  item: ITEM,
  state: 2,
  mkTimeSec: 13,
  elementTimeSec: 12.734,
  elementRate: 1,
  mkRate: 1,
  previewOnly: false,
};

describe('Apple Music 웹 플레이어(MusicKit JS) 값 변환', () => {
  it('[REQ-PC-01][REQ-PB-01] 재생 중 곡·위치·상태를 core 스냅샷으로 바꾼다(<audio> 소수 위치 사용, ISRC 유지)', () => {
    const s = mapMusicKitSnapshot(PLAYING, 5000);
    expect(s.track).toEqual({
      service: 'apple-music',
      serviceTrackId: '900000001',
      title: '夜明けのホーム',
      artist: 'Synthetic Band',
      album: 'Test Album',
      durationMs: 210_000,
      isrc: 'JPZZ02600001',
    });
    expect(s.status).toBe('playing');
    // MusicKit 값(13초, 정수 반올림) 대신 실제 오디오 요소 위치
    expect(s.positionMs).toBe(12_734);
    expect(s.capturedAtMonotonicMs).toBe(5000);
    expect(s.rate).toBe(1);
  });

  it('[REQ-PC-01][REQ-SY-02] 미리듣기(로그인·구독 없음)는 곡의 몇 초인지 모르므로 위치를 만들지 않는다', () => {
    const s = mapMusicKitSnapshot({ ...PLAYING, previewOnly: true }, 0);
    expect(s.track?.title).toBe('夜明けのホーム');
    expect(s.positionMs).toBeNull();
    expect(pickMusicKitPositionSec({ ...PLAYING, previewOnly: true })).toBeNull();
  });

  it('[REQ-PC-01][REQ-SY-02] <audio> 위치가 MusicKit 위치와 크게 다르면(다른 미디어) MusicKit 값을 쓴다', () => {
    expect(pickMusicKitPositionSec({ ...PLAYING, mkTimeSec: 90, elementTimeSec: 3.2 })).toBe(90);
    // 반올림 차이(최대 0.5초)는 같은 미디어로 본다
    expect(pickMusicKitPositionSec({ ...PLAYING, mkTimeSec: 13, elementTimeSec: 12.51 })).toBe(12.51);
    // 오디오 요소가 없으면 MusicKit 값
    expect(pickMusicKitPositionSec({ ...PLAYING, elementTimeSec: null })).toBe(13);
    // 둘 다 없거나 잘못된 값이면 위치 모름
    expect(pickMusicKitPositionSec({ ...PLAYING, mkTimeSec: NaN, elementTimeSec: -1 })).toBeNull();
    expect(mapMusicKitSnapshot({ ...PLAYING, mkTimeSec: 'x', elementTimeSec: undefined }, 0).positionMs).toBeNull();
  });

  it('[REQ-PC-01] MusicKit 재생 상태 숫자를 해석한다(불러오기·탐색·대기는 진행을 추정하지 않음)', () => {
    expect(mapMusicKitState(2)).toBe('playing');
    expect(mapMusicKitState(3)).toBe('paused');
    for (const n of [0, 4, 5, 10]) expect(mapMusicKitState(n)).toBe('stopped');
    for (const n of [1, 6, 8, 9]) expect(mapMusicKitState(n)).toBe('buffering');
    expect(mapMusicKitState(7)).toBe('unknown');
    expect(mapMusicKitState('playing')).toBe('unknown');
    // 재생 중이 아니면 속도 0(진행 없음)
    expect(mapMusicKitSnapshot({ ...PLAYING, state: 3 }, 0).rate).toBe(0);
  });

  it('[REQ-PC-01][REQ-PB-04] 보관함 곡(id가 i.…)은 카탈로그 ID를 쓰고, 카탈로그 ID가 없으면 ID 없음(메타데이터로 식별)', () => {
    const lib = mapMusicKitTrack({ ...ITEM, id: 'i.AbC123', playParamsId: 'i.AbC123', catalogId: '900000002' });
    expect(lib?.serviceTrackId).toBe('900000002');
    const upload = mapMusicKitTrack({ ...ITEM, id: 'i.AbC123', playParamsId: 'i.AbC123', catalogId: undefined });
    expect(upload?.serviceTrackId).toBeNull();
    expect(upload && serviceKeyOf(upload)).toMatch(/^fp\|/);
  });

  it('[REQ-PC-01][REQ-PB-04] iPhone(Music 앱)과 PC(웹 플레이어)는 같은 곡을 같은 serviceKey로 식별한다', () => {
    const web = mapMusicKitTrack(ITEM)!;
    const ios = mapIosTrack({
      hasItem: true,
      title: '夜明けのホーム',
      artist: 'Synthetic Band',
      album: 'Test Album',
      durationSec: 210,
      storeId: '900000001',
    })!;
    expect(web.service).toBe(ios.service);
    expect(serviceKeyOf(web)).toBe(serviceKeyOf(ios));
  });

  it('[REQ-PC-01][REQ-PB-04] 노래가 아닌 항목(뮤직비디오·라디오)·제목 없음·잘못된 모양은 곡으로 보지 않는다', () => {
    expect(mapMusicKitTrack({ ...ITEM, playParamsKind: 'musicVideo' })).toBeNull();
    expect(mapMusicKitTrack({ ...ITEM, playParamsKind: 'radioStation' })).toBeNull();
    expect(mapMusicKitTrack({ ...ITEM, playParamsKind: undefined, type: 'music-videos' })).toBeNull();
    expect(mapMusicKitTrack({ ...ITEM, playParamsKind: undefined, type: 'library-songs' })?.title).toBe(
      '夜明けのホーム',
    );
    expect(mapMusicKitTrack({ ...ITEM, title: '   ' })).toBeNull();
    expect(mapMusicKitTrack({ ...ITEM, title: 'x'.repeat(600) })).toBeNull();
    expect(mapMusicKitTrack(null)).toBeNull();
    const none = mapMusicKitSnapshot({ item: null, state: 2, mkTimeSec: 10, elementTimeSec: 10 }, 0);
    expect(none).toMatchObject({ track: null, status: 'stopped', positionMs: null, rate: 0 });
  });

  it('[REQ-PC-01] ISRC는 형식이 맞을 때만 쓴다(소문자·하이픈 정리)', () => {
    expect(normalizeIsrc('jp-zz0-26-00001')).toBe('JPZZ02600001');
    expect(normalizeIsrc('JPZZ0260000')).toBeNull();
    expect(normalizeIsrc('<script>')).toBeNull();
    expect(normalizeIsrc(12)).toBeNull();
    expect(mapMusicKitTrack({ ...ITEM, isrc: 'bad' })?.isrc).toBeNull();
  });

  it('[REQ-PC-01] 길이·속도의 잘못된 값은 버린다', () => {
    expect(mapMusicKitTrack({ ...ITEM, durationMs: -5 })?.durationMs).toBeNull();
    expect(mapMusicKitTrack({ ...ITEM, durationMs: '210000' })?.durationMs).toBeNull();
    expect(mapMusicKitSnapshot({ ...PLAYING, elementRate: 0, mkRate: 1.25 }, 0).rate).toBe(1.25);
    expect(mapMusicKitSnapshot({ ...PLAYING, elementRate: 99, mkRate: NaN }, 0).rate).toBe(1);
  });

  it('[REQ-PC-01][REQ-LY-05] 대기열 항목을 곡 목록으로 바꾸고 원래 위치를 남긴다', () => {
    const q = mapMusicKitQueue([
      ITEM,
      { ...ITEM, playParamsKind: 'musicVideo' },
      { ...ITEM, id: '900000003', catalogId: '900000003', title: 'Paper Lanterns' },
    ]);
    expect(q.map((t) => [t.index, t.ref.title])).toEqual([
      [0, '夜明けのホーム'],
      [2, 'Paper Lanterns'],
    ]);
    expect(mapMusicKitQueue('nope')).toEqual([]);
    expect(mapMusicKitQueue(Array.from({ length: 1200 }, () => ITEM))).toHaveLength(1000);
  });

  it('[REQ-PC-01] 곡 변경 판단: 스토어 ID가 있으면 ID로, 없으면 메타데이터로 비교', () => {
    const a = mapMusicKitTrack(ITEM)!;
    expect(sameServiceTrack(a, { ...a, title: '다른 표기' })).toBe(true);
    expect(sameServiceTrack(a, { ...a, serviceTrackId: '900000009' })).toBe(false);
    const noId = { ...a, serviceTrackId: null };
    expect(sameServiceTrack(noId, { ...noId })).toBe(true);
    expect(sameServiceTrack(noId, { ...noId, durationMs: 1 })).toBe(false);
    expect(sameServiceTrack(null, null)).toBe(true);
    expect(sameServiceTrack(a, null)).toBe(false);
  });

  it('[REQ-PC-01][REQ-SY-02] 다른 탭에서 잰 측정 시각은 전달 지연만큼만 앞당기고, 받은 시각보다 늦게 만들지 않는다', () => {
    const base = { receivedAtEpochMs: 1_000_000, receivedAtMonotonicMs: 50_000 };
    expect(remoteCaptureMonotonic({ ...base, sentAtEpochMs: 999_990 })).toBe(49_990);
    // 미래 시각(시계 불일치)·너무 오래된 값·잘못된 값은 받은 시각
    expect(remoteCaptureMonotonic({ ...base, sentAtEpochMs: 1_000_050 })).toBe(50_000);
    expect(remoteCaptureMonotonic({ ...base, sentAtEpochMs: 990_000 })).toBe(50_000);
    expect(remoteCaptureMonotonic({ ...base, sentAtEpochMs: 'x' })).toBe(50_000);
    expect(remoteCaptureMonotonic({ ...base, sentAtEpochMs: 998_000, maxAgeMs: 5_000 })).toBe(48_000);
  });
});
