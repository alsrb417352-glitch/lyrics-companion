import type { ServiceTrackRef } from '../ports.js';

/**
 * iOS 보관함 플레이리스트 원시 값 → 앱 모델 변환(순수 함수, docs/plan.md D-30).
 * 네이티브 모듈(Swift, MPMediaQuery.playlists())은 값을 가공하지 않고 넘기고, 검증·정리는 여기서 테스트로 고정한다.
 *
 * - MediaPlayer 보관함 API만 쓴다(MusicKit 카탈로그 API·개발자 토큰 불필요 → 무료 서명 가능, ADR-0002).
 *   그래서 보이는 것은 "보관함에 있는" 플레이리스트다(직접 만든 것 + 보관함에 추가한 Apple Music 플레이리스트).
 * - persistentId는 UInt64를 10진수 문자열로 받는다(JS number로는 정밀도가 깨짐).
 * - 이름·곡 정보는 기기 데이터지만 형식·길이를 검증한다(불변조건 9의 방어적 처리).
 */

export interface LibraryPlaylist {
  persistentId: string;
  name: string;
  /** 곡 수(네이티브가 준 값, 모르면 null) */
  count: number | null;
  /** 스마트·지니어스 등 자동 플레이리스트 여부(표시용) */
  smart: boolean;
}

export interface LibraryTrack {
  persistentId: string;
  title: string;
  artist: string;
  album: string | null;
  durationMs: number | null;
  /** Apple Music 카탈로그 ID(없으면 null) */
  storeId: string | null;
}

export const LIBRARY_LIMITS = { maxPlaylists: 1_000, maxTracks: 5_000, maxText: 300 } as const;

const PID = /^[0-9]{1,20}$/;

function pid(v: unknown): string | null {
  return typeof v === 'string' && PID.test(v) && v !== '0' ? v : null;
}

function text(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  return t.length > 0 ? [...t].slice(0, LIBRARY_LIMITS.maxText).join('') : null;
}

function storeId(v: unknown): string | null {
  return typeof v === 'string' && /^[0-9]{1,20}$/.test(v) && !/^0+$/.test(v) ? v : null;
}

export function mapLibraryPlaylists(raw: unknown): LibraryPlaylist[] {
  if (!Array.isArray(raw)) return [];
  const out: LibraryPlaylist[] = [];
  const seen = new Set<string>();
  for (const r of raw.slice(0, LIBRARY_LIMITS.maxPlaylists)) {
    if (typeof r !== 'object' || r === null) continue;
    const o = r as Record<string, unknown>;
    const id = pid(o['persistentId']);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const c = o['count'];
    out.push({
      persistentId: id,
      name: text(o['name']) ?? '(이름 없는 플레이리스트)',
      count: typeof c === 'number' && Number.isInteger(c) && c >= 0 ? c : null,
      smart: o['smart'] === true,
    });
  }
  return out;
}

export function mapLibraryTracks(raw: unknown): LibraryTrack[] {
  if (!Array.isArray(raw)) return [];
  const out: LibraryTrack[] = [];
  for (const r of raw.slice(0, LIBRARY_LIMITS.maxTracks)) {
    if (typeof r !== 'object' || r === null) continue;
    const o = r as Record<string, unknown>;
    const id = pid(o['persistentId']);
    if (!id) continue;
    const dur = o['durationSec'];
    out.push({
      persistentId: id,
      title: text(o['title']) ?? '(제목 없음)',
      artist: text(o['artist']) ?? '',
      album: text(o['album']),
      durationMs: typeof dur === 'number' && Number.isFinite(dur) && dur > 0 ? Math.round(dur * 1000) : null,
      storeId: storeId(o['storeId']),
    });
  }
  return out;
}

/**
 * 보관함 곡 → 재생 곡 정보(ServiceTrackRef). 지금 재생(mapIosTrack)과 같은 MPMediaItem 값으로 만들므로
 * 같은 곡이면 serviceKey가 같다(스토어 ID가 있으면 ID, 없으면 같은 메타데이터 지문).
 * 그래서 플레이리스트에서 미리 받은 가사를 나중에 재생할 때 그대로 찾는다(REQ-LY-05).
 */
export function libraryTrackToRef(t: LibraryTrack): ServiceTrackRef {
  return {
    service: 'apple-music',
    serviceTrackId: t.storeId,
    title: t.title,
    artist: t.artist,
    album: t.album,
    durationMs: t.durationMs,
    isrc: null,
  };
}

/** 플레이리스트 이름 검색(대소문자·공백 무시, 부분 일치) */
export function filterPlaylists(list: readonly LibraryPlaylist[], query: string): LibraryPlaylist[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [...list];
  return list.filter((p) => p.name.toLocaleLowerCase().includes(q));
}
