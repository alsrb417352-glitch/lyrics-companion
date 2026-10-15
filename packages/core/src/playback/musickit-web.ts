import type { PlaybackSnapshot, PlaybackStatus, ServiceTrackRef } from '../ports.js';
import { normalizeStoreId } from './ios-system-player.js';

/**
 * Apple Music 웹 플레이어(music.apple.com, MusicKit JS v3) 원시 값 → core 재생 스냅샷 변환(순수 함수).
 * PC 확장 프로그램(apps/pc-extension)의 페이지 스크립트는 값을 가공하지 않고 그대로 넘기고,
 * 해석 규칙은 여기 한 곳에서 테스트로 고정한다(iOS의 ios-system-player.ts와 같은 방식).
 *
 * 값의 근거(2026-10-06, music.apple.com 페이지에서 직접 확인 — docs/platform-support.md §2.8):
 * - `MusicKit.getInstance()`: `nowPlayingItem`(MediaItem), `playbackState`(숫자), `currentPlaybackTime`(초, **정수로 반올림됨**),
 *   `playbackRate`, `previewOnly`, `seekToTime(초)`, `play/pause/skipToNextItem/skipToPreviousItem`, `queue.items`.
 * - MediaItem: `id`, `type`('songs' 등), `attributes{name, artistName, albumName, durationInMillis, isrc, playParams{id, kind, catalogId?}}`.
 *   보관함 곡은 `id`가 'i.…' 형식이고 카탈로그 ID는 `playParams.catalogId`에 있다.
 * - 실제 소리를 내는 `<audio id="apple-music-player">`의 `currentTime`은 소수점까지 정확하다(같은 순간 MusicKit 값은 정수).
 * - 로그인·구독 없이 재생하면 30초 미리듣기(`previewOnly`)다. 미리듣기는 곡 중간 구간이라 위치가 곡 위치와 다르다.
 */

/** 페이지 스크립트가 넘기는 원시 값. 모든 필드는 신뢰하지 않고 검증한다. */
export interface MusicKitItemRaw {
  id?: unknown;
  type?: unknown;
  title?: unknown;
  artist?: unknown;
  album?: unknown;
  durationMs?: unknown;
  isrc?: unknown;
  /** attributes.playParams.id */
  playParamsId?: unknown;
  /** attributes.playParams.kind ('song' 등) */
  playParamsKind?: unknown;
  /** attributes.playParams.catalogId(보관함 곡) 또는 MediaItem.catalogId */
  catalogId?: unknown;
}

export interface MusicKitSnapshotRaw {
  item?: MusicKitItemRaw | null;
  /** MusicKit.PlaybackStates 숫자 */
  state?: unknown;
  /** MusicKit currentPlaybackTime(초, 정수) */
  mkTimeSec?: unknown;
  /** <audio id="apple-music-player">.currentTime(초, 소수) — 없으면 null */
  elementTimeSec?: unknown;
  /** <audio>.playbackRate */
  elementRate?: unknown;
  /** MusicKit playbackRate */
  mkRate?: unknown;
  /** 미리듣기(30초)만 재생 가능한 상태 */
  previewOnly?: unknown;
}

/** MusicKit.PlaybackStates (페이지에서 확인한 값): 0 none, 1 loading, 2 playing, 3 paused, 4 stopped, 5 ended, 6 seeking, 8 waiting, 9 stalled, 10 completed */
export function mapMusicKitState(v: unknown): PlaybackStatus {
  switch (v) {
    case 2:
      return 'playing';
    case 3:
      return 'paused';
    case 0:
    case 4:
    case 5:
    case 10:
      return 'stopped';
    case 1:
    case 6:
    case 8:
    case 9:
      // 불러오기·탐색·버퍼링 중에는 위치가 일정한 속도로 움직이지 않으므로 진행을 추정하지 않는다.
      return 'buffering';
    default:
      return 'unknown';
  }
}

function text(v: unknown, max = 512): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 && t.length <= max ? t : null;
}

function finiteNonNeg(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** ISRC: 국가 2자 + 등록자 3자 + 연도 2자리 + 번호 5자리(하이픈 없이 12자) */
export function normalizeIsrc(v: unknown): string | null {
  const t = text(v, 32);
  if (!t) return null;
  const u = t.replace(/-/g, '').toUpperCase();
  return /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(u) ? u : null;
}

/** 가사를 보여 줄 대상: 노래만(뮤직비디오·라디오 방송·팟캐스트는 위치·곡 식별 규칙이 달라 제외) */
const SONG_TYPES = new Set(['song', 'songs', 'library-songs']);

function isSong(raw: MusicKitItemRaw): boolean {
  const kind = text(raw.playParamsKind, 64);
  const type = text(raw.type, 64);
  if (kind !== null) return kind === 'song';
  return type !== null && SONG_TYPES.has(type);
}

/**
 * MediaItem → 곡 정보. iOS(`mapIosTrack`)와 같은 서비스(apple-music)·같은 스토어 ID를 쓰므로,
 * 같은 곡이면 iPhone 백업을 가져온 PC에서도 같은 곡 연결(serviceKey `id:<스토어 ID>`)로 찾는다.
 */
export function mapMusicKitTrack(raw: MusicKitItemRaw | null | undefined): ServiceTrackRef | null {
  if (!raw || typeof raw !== 'object' || !isSong(raw)) return null;
  const title = text(raw.title);
  if (!title) return null;
  const dur = finiteNonNeg(raw.durationMs);
  // 카탈로그 ID 우선(보관함 곡은 id가 'i.…'), 숫자만 인정
  const storeId = normalizeStoreId(raw.catalogId) ?? normalizeStoreId(raw.playParamsId) ?? normalizeStoreId(raw.id);
  return {
    service: 'apple-music',
    serviceTrackId: storeId,
    title,
    artist: text(raw.artist) ?? '',
    album: text(raw.album),
    durationMs: dur !== null && dur > 0 ? Math.round(dur) : null,
    isrc: normalizeIsrc(raw.isrc),
  };
}

/** `<audio>` 위치가 MusicKit 위치(정수 초)와 이만큼 넘게 다르면 다른 미디어로 보고 쓰지 않는다 */
export const ELEMENT_TIME_TOLERANCE_SEC = 1.5;

/**
 * 재생 위치(초) 고르기. 진행을 꾸며내지 않는다(불변조건 5):
 * - 미리듣기면 위치를 모른다(곡의 몇 초인지 알 수 없음).
 * - `<audio>` 값이 있고 MusicKit 값과 맞으면 그것(정확), 아니면 MusicKit 값(정수 초 — 실제 측정값이지만 거침).
 */
export function pickMusicKitPositionSec(raw: MusicKitSnapshotRaw): number | null {
  if (raw.previewOnly === true) return null;
  const mk = finiteNonNeg(raw.mkTimeSec);
  const el = finiteNonNeg(raw.elementTimeSec);
  if (el !== null && (mk === null || Math.abs(el - mk) <= ELEMENT_TIME_TOLERANCE_SEC)) return el;
  return mk;
}

export function mapMusicKitSnapshot(raw: MusicKitSnapshotRaw, capturedAtMonotonicMs: number): PlaybackSnapshot {
  const track = mapMusicKitTrack(raw.item);
  const status = track ? mapMusicKitState(raw.state) : 'stopped';
  const pos = track ? pickMusicKitPositionSec(raw) : null;
  const rateOf = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 4 ? v : null);
  const rate = rateOf(raw.elementRate) ?? rateOf(raw.mkRate) ?? 1;
  return {
    track,
    status,
    positionMs: pos !== null ? Math.round(pos * 1000) : null,
    capturedAtMonotonicMs,
    rate: status === 'playing' ? rate : 0,
  };
}

/** 대기열(queue.items) → 곡 목록. 노래가 아닌 항목은 빼되 원래 위치(index)를 남긴다(재생 이동용). */
export interface MusicKitQueueTrack {
  /** queue.items 안의 위치 */
  index: number;
  ref: ServiceTrackRef;
}

export const MUSICKIT_QUEUE_LIMIT = 1000;

export function mapMusicKitQueue(items: unknown): MusicKitQueueTrack[] {
  if (!Array.isArray(items)) return [];
  const out: MusicKitQueueTrack[] = [];
  for (let i = 0; i < items.length && i < MUSICKIT_QUEUE_LIMIT; i++) {
    const ref = mapMusicKitTrack(items[i] as MusicKitItemRaw);
    if (ref) out.push({ index: i, ref });
  }
  return out;
}

/**
 * 같은 곡인지(곡 변경 판단용). 서비스가 다르면 다른 곡(Android에서 Spotify → YouTube Music으로 옮긴 경우 등),
 * 서비스 곡 ID가 있으면 ID로, 없으면 메타데이터로 비교한다.
 */
export function sameServiceTrack(a: ServiceTrackRef | null, b: ServiceTrackRef | null): boolean {
  if (!a || !b) return a === b;
  if (a.service !== b.service) return false;
  if (a.serviceTrackId || b.serviceTrackId) return a.serviceTrackId === b.serviceTrackId;
  return a.title === b.title && a.artist === b.artist && a.album === b.album && a.durationMs === b.durationMs;
}

/**
 * 다른 문서(Apple Music 탭)에서 잰 측정 시각을 이 문서의 단조 시계로 옮긴다.
 * 두 문서의 `performance.timeOrigin + performance.now()`는 같은 기준이지만 확신할 수 없으므로,
 * 전달 지연이 0~maxAgeMs 범위일 때만 그만큼 앞당기고, 그 밖이면 받은 시각을 쓴다.
 * 받은 시각보다 늦은 측정 시각은 만들지 않는다 → 위치를 앞서 추정하지 않는다(불변조건 5, D-25와 같은 원칙).
 */
export function remoteCaptureMonotonic(input: {
  sentAtEpochMs: unknown;
  receivedAtEpochMs: number;
  receivedAtMonotonicMs: number;
  maxAgeMs?: number;
}): number {
  const maxAge = input.maxAgeMs ?? 1_000;
  const sent = input.sentAtEpochMs;
  if (typeof sent !== 'number' || !Number.isFinite(sent)) return input.receivedAtMonotonicMs;
  const age = input.receivedAtEpochMs - sent;
  if (!(age >= 0 && age <= maxAge)) return input.receivedAtMonotonicMs;
  return input.receivedAtMonotonicMs - age;
}
