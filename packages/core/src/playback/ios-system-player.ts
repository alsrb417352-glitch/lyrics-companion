import type { PlaybackAccess, PlaybackSnapshot, PlaybackStatus, ServiceTrackRef } from '../ports.js';

/**
 * iOS Music 앱(systemMusicPlayer) 원시 값 → core 재생 스냅샷 변환(순수 함수).
 * 네이티브 모듈(apps/mobile/modules/now-playing, Swift)은 값을 가공하지 않고 그대로 넘기고,
 * 해석 규칙은 여기 한 곳에서 테스트로 고정한다.
 *
 * 네이티브 값의 근거: MPMusicPlayerController / MPMediaItem 문서(docs/research/2026-10-04-integration-research.md §3).
 * - playbackStoreID: Apple Music 카탈로그 곡이 아니면 "0" 또는 빈 문자열일 수 있다.
 * - currentPlaybackTime: 초 단위. 알 수 없으면 NaN일 수 있다.
 * - 홈 공유 곡 등은 nowPlayingItem이 없다(hasItem=false).
 */

export type IosAuthorization = 'authorized' | 'denied' | 'restricted' | 'notDetermined' | 'unknown';

export type IosPlaybackState =
  'playing' | 'paused' | 'stopped' | 'interrupted' | 'seekingForward' | 'seekingBackward' | 'unknown';

/** 네이티브 모듈이 넘기는 원시 값. 모든 필드는 신뢰하지 않고 검증한다. */
export interface IosNowPlayingRaw {
  hasItem?: unknown;
  title?: unknown;
  artist?: unknown;
  album?: unknown;
  durationSec?: unknown;
  storeId?: unknown;
  state?: unknown;
  positionSec?: unknown;
  rate?: unknown;
}

const STATES: readonly IosPlaybackState[] = [
  'playing',
  'paused',
  'stopped',
  'interrupted',
  'seekingForward',
  'seekingBackward',
];

function text(v: unknown, max = 512): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 && t.length <= max ? t : null;
}

function finiteNonNeg(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

export function mapIosAuthorization(v: unknown): PlaybackAccess {
  switch (v) {
    case 'authorized':
      return 'granted';
    case 'denied':
    case 'restricted':
      return 'denied';
    case 'notDetermined':
      return 'not-determined';
    default:
      return 'unsupported';
  }
}

export function mapIosState(v: unknown): PlaybackStatus {
  const s = STATES.includes(v as IosPlaybackState) ? (v as IosPlaybackState) : 'unknown';
  switch (s) {
    case 'playing':
      return 'playing';
    case 'paused':
    case 'interrupted':
      return 'paused';
    case 'stopped':
      return 'stopped';
    case 'seekingForward':
    case 'seekingBackward':
      // 탐색 중에는 위치가 일정한 속도로 움직이지 않으므로 진행을 추정하지 않는다.
      return 'buffering';
    default:
      return 'unknown';
  }
}

/** Apple Music 스토어 ID: 숫자 문자열만 인정, "0"은 없음 */
export function normalizeStoreId(v: unknown): string | null {
  const t = text(v, 32);
  if (!t || !/^[0-9]+$/.test(t) || /^0+$/.test(t)) return null;
  return t;
}

export function mapIosTrack(raw: IosNowPlayingRaw): ServiceTrackRef | null {
  if (raw.hasItem !== true) return null;
  const title = text(raw.title);
  if (!title) return null;
  const dur = finiteNonNeg(raw.durationSec);
  return {
    service: 'apple-music',
    serviceTrackId: normalizeStoreId(raw.storeId),
    title,
    artist: text(raw.artist) ?? '',
    album: text(raw.album),
    durationMs: dur !== null && dur > 0 ? Math.round(dur * 1000) : null,
    isrc: null,
  };
}

export function mapIosSnapshot(raw: IosNowPlayingRaw, capturedAtMonotonicMs: number): PlaybackSnapshot {
  const track = mapIosTrack(raw);
  const status = track ? mapIosState(raw.state) : 'stopped';
  const pos = finiteNonNeg(raw.positionSec);
  const rateRaw = typeof raw.rate === 'number' && Number.isFinite(raw.rate) && raw.rate > 0 ? raw.rate : 1;
  return {
    track,
    status,
    positionMs: track && pos !== null ? Math.round(pos * 1000) : null,
    capturedAtMonotonicMs,
    // systemMusicPlayer의 재생 속도 값은 신뢰도 미확인 → 재생 중이 아니면 0, 재생 중이면 양수만 사용
    rate: status === 'playing' ? rateRaw : 0,
  };
}

/** 같은 곡인지(곡 변경 이벤트 판단용). 스토어 ID가 있으면 ID로, 없으면 메타데이터로 비교한다. */
export function sameIosTrack(a: ServiceTrackRef | null, b: ServiceTrackRef | null): boolean {
  if (!a || !b) return a === b;
  if (a.serviceTrackId || b.serviceTrackId) return a.serviceTrackId === b.serviceTrackId;
  return a.title === b.title && a.artist === b.artist && a.album === b.album && a.durationMs === b.durationMs;
}
