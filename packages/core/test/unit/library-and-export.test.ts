/**
 * 보관함 플레이리스트 원시 값 해석(REQ-PB-06)과 원문 TXT 내보내기(REQ-ED-04) 단위 테스트.
 */
import { describe, expect, it } from 'vitest';
import { filterPlaylists, mapLibraryPlaylists, mapLibraryTracks } from '../../src/playback/ios-library.js';
import { lyricsToPlainText, plainTextFileName } from '../../src/lyrics/plain-text-export.js';
import { buildLyricsVersion } from '../../src/lyrics/lyrics-version.js';
import { previewTxtImport } from '../../src/import/user-translation-import.js';

describe('보관함 플레이리스트', () => {
  it('[REQ-PB-06][REQ-SEC-07] 잘못된 ID·중복·형식 오류는 버리고, 이름·곡 정보를 정리한다', () => {
    const list = mapLibraryPlaylists([
      { persistentId: '18446744073709551615', name: '  드라이브  ', count: 12, smart: false },
      { persistentId: '18446744073709551615', name: '중복' },
      { persistentId: 12345, name: '숫자 ID(정밀도 손실 위험)' },
      { persistentId: '0', name: '빈 ID' },
      { persistentId: '77', name: '\u0007제어\n문자', count: -1, smart: true },
      { persistentId: '78' },
      null,
      'x',
    ]);
    expect(list).toEqual([
      { persistentId: '18446744073709551615', name: '드라이브', count: 12, smart: false },
      { persistentId: '77', name: '제어 문자', count: null, smart: true },
      { persistentId: '78', name: '(이름 없는 플레이리스트)', count: null, smart: false },
    ]);
    expect(mapLibraryPlaylists({})).toEqual([]);
  });

  it('[REQ-PB-06] 곡: 길이 초→ms, 스토어 ID "0"은 없음, 제목 없으면 대체 문구', () => {
    const tracks = mapLibraryTracks([
      { persistentId: '1', title: '夜明け', artist: 'A', album: 'X', durationSec: 210.4, storeId: '1440833098' },
      { persistentId: '2', title: '', artist: null, durationSec: Number.NaN, storeId: '0' },
      { persistentId: 'abc', title: 'bad' },
    ]);
    expect(tracks).toEqual([
      { persistentId: '1', title: '夜明け', artist: 'A', album: 'X', durationMs: 210_400, storeId: '1440833098' },
      { persistentId: '2', title: '(제목 없음)', artist: '', album: null, durationMs: null, storeId: null },
    ]);
  });

  it('[REQ-PB-06] 이름 검색은 대소문자 무시 부분 일치', () => {
    const list = mapLibraryPlaylists([
      { persistentId: '1', name: 'J-Pop Mix' },
      { persistentId: '2', name: '운동' },
    ]);
    expect(filterPlaylists(list, 'pop').map((p) => p.persistentId)).toEqual(['1']);
    expect(filterPlaylists(list, '  ')).toHaveLength(2);
  });
});

describe('원문 TXT 내보내기', () => {
  const synced = buildLyricsVersion({
    id: 'lv',
    songId: 's',
    source: 'lrclib',
    sourceRef: null,
    kind: 'synced',
    timed: [
      { startMs: 0, text: '' },
      { startMs: 1000, text: '夜明けの駅で' },
      { startMs: 2000, text: 'まだ ねむい' },
      { startMs: 3000, text: '' },
      { startMs: 3500, text: '  ' },
      { startMs: 4000, text: 'ラララ' },
      { startMs: 5000, text: '' },
    ],
    createdAtEpochMs: 0,
  });

  it('[REQ-ED-04] 시간 정보 없이 원문만, 연 구분 빈 줄은 하나로, 앞뒤 빈 줄 없음', () => {
    expect(lyricsToPlainText(synced)).toBe('夜明けの駅で\nまだ ねむい\n\nラララ\n');
  });

  it('[REQ-ED-04][REQ-ED-02] 내보낸 줄 순서대로 번역한 TXT를 붙여 넣으면 그대로 행에 맞춰진다', () => {
    const exported = lyricsToPlainText(synced);
    const translated = exported
      .split('\n')
      .map((l) => (l === '' ? '' : `번역:${l}`))
      .join('\n');
    const preview = previewTxtImport(synced, translated);
    expect(preview.requiresManualMapping).toBe(false);
    expect(Object.values(preview.proposed ?? {})).toEqual(['번역:夜明けの駅で', '번역:まだ ねむい', '번역:ラララ']);
  });

  it('[REQ-ED-04] 연주곡은 빈 문자열, 파일 이름은 금지 문자 제거', () => {
    const inst = buildLyricsVersion({
      id: 'i',
      songId: 's',
      source: 'lrclib',
      sourceRef: null,
      kind: 'instrumental',
      createdAtEpochMs: 0,
    });
    expect(lyricsToPlainText(inst)).toBe('');
    expect(plainTextFileName({ title: 'A/B:C?', artist: 'X*Y' })).toBe('A_B_C_ - X_Y (원문).txt');
    expect(plainTextFileName({ title: '  ', artist: '' })).toBe('가사 (원문).txt');
    expect(plainTextFileName({ title: '..hidden', artist: '' })).toBe('hidden (원문).txt');
  });
});
