import type { LyricLine, LyricsKind } from '../model.js';
import type { PlaybackSnapshot } from '../ports.js';

/**
 * 가사 싱크 계산(순수 함수).
 * - 기준은 원문 타임스탬프뿐이다. 번역·발음은 같은 행 ID로 따라온다.
 * - 행 단위로만 강조한다(단어 단위 싱크를 흉내 내지 않는다).
 * - 재생 위치를 모르면 'unknown'을 반환하고 임의 진행을 만들지 않는다.
 * - 오프셋: 표시 기준 시각 = 재생 위치 + offsetMs (양수면 가사가 더 일찍 넘어감).
 */

export interface SyncConfig {
  /** 마지막 측정 후 이 시간이 지나면 추정을 멈추고 새 측정을 기다린다(백그라운드 복귀 등). */
  maxExtrapolationMs: number;
}

export const DEFAULT_SYNC_CONFIG: SyncConfig = { maxExtrapolationMs: 60_000 };

export type SyncResult =
  | { mode: 'static'; reason: 'plain' | 'instrumental' }
  | { mode: 'unknown'; reason: 'no-snapshot' | 'no-position' | 'stale' | 'status-unknown' | 'track-mismatch' }
  | { mode: 'synced'; positionMs: number; activeIndex: number | null; isPlaying: boolean };

/** 측정값과 경과 시간으로 현재 위치 추정. 추정 불가면 null */
export function estimatePositionMs(
  snapshot: PlaybackSnapshot,
  nowMonotonicMs: number,
  cfg: SyncConfig = DEFAULT_SYNC_CONFIG,
): { positionMs: number } | { unknown: 'no-position' | 'stale' | 'status-unknown' } {
  if (snapshot.positionMs === null) return { unknown: 'no-position' };
  if (snapshot.status === 'unknown') return { unknown: 'status-unknown' };
  if (snapshot.status !== 'playing') return { positionMs: Math.max(0, snapshot.positionMs) };
  const elapsed = nowMonotonicMs - snapshot.capturedAtMonotonicMs;
  if (elapsed < 0 || elapsed > cfg.maxExtrapolationMs) return { unknown: 'stale' };
  const rate = Number.isFinite(snapshot.rate) && snapshot.rate > 0 ? snapshot.rate : 1;
  let pos = snapshot.positionMs + elapsed * rate;
  const dur = snapshot.track?.durationMs;
  if (dur != null && pos > dur) pos = dur;
  return { positionMs: Math.max(0, pos) };
}

/** startMs가 t 이하인 마지막 행(이진 탐색). 첫 행 이전이면 null */
export function findActiveIndex(lines: readonly LyricLine[], t: number): number | null {
  let lo = 0;
  let hi = lines.length - 1;
  let ans: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = lines[mid]?.startMs;
    if (s == null) return null;
    if (s <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export function computeSync(input: {
  kind: LyricsKind;
  lines: readonly LyricLine[];
  snapshot: PlaybackSnapshot | null;
  nowMonotonicMs: number;
  offsetMs: number;
  /** 화면에 표시 중인 곡과 스냅샷 곡이 같은지(호출자가 판단) */
  trackMatches?: boolean;
  config?: SyncConfig;
}): SyncResult {
  if (input.kind === 'instrumental') return { mode: 'static', reason: 'instrumental' };
  if (input.kind === 'plain') return { mode: 'static', reason: 'plain' };
  if (!input.snapshot) return { mode: 'unknown', reason: 'no-snapshot' };
  if (input.trackMatches === false) return { mode: 'unknown', reason: 'track-mismatch' };
  const est = estimatePositionMs(input.snapshot, input.nowMonotonicMs, input.config);
  if ('unknown' in est) return { mode: 'unknown', reason: est.unknown };
  const t = est.positionMs + input.offsetMs;
  return {
    mode: 'synced',
    positionMs: est.positionMs,
    activeIndex: findActiveIndex(input.lines, t),
    isPlaying: input.snapshot.status === 'playing',
  };
}
