import type { Clock, PlaybackSnapshot, PlaybackStatus, ServiceTrackRef } from '../ports.js';
import { sameServiceTrack } from './musickit-web.js';
import { PositionFilter } from '../sync/position-filter.js';

/**
 * 백그라운드에서 가사 찾기·자동 번역(REQ-PB-09, docs/plan.md D-45).
 *
 * iPhone은 소리를 내지 않는 앱을 백그라운드에서 곧 멈춘다(우리 앱은 음악을 Music 앱에 맡기므로 해당).
 * 그래서 사용자가 켜 두면(기본 켜짐) Music 앱이 재생하는 동안 우리 앱이 **소리 없는 오디오**를 다른 소리와 섞어
 * 재생해 백그라운드에서도 계속 실행된다. 그동안 곡이 바뀌면 지금처럼 곡 식별 → 가사 조회 → (자동 번역이 켜져 있으면) 번역이
 * 이어서 진행된다. 이 파일은 "언제 깨어 있을지"와 "얼마나 자주 재생 상태를 읽을지"만 정한다(순수 로직, 테스트로 고정).
 *
 * 규칙
 * - 사용자가 끄면 유지하지 않는다.
 * - 소리로 싱크 맞추기(D-44)가 듣는 동안은 유지하지 않는다(그 기능이 오디오 세션을 쓰고, 그동안 앱은 화면에 켜져 있다).
 * - 재생 중이거나 재생이 멈춘 지 idleMs(10분)가 지나지 않았으면 유지, 그보다 오래 멈춰 있으면 놓는다
 *   (멈춘 음악 때문에 배터리를 쓰지 않게. 다시 재생해도 앱을 열기 전에는 따라가지 않는다).
 * - 아직 한 번도 재생을 보지 못했으면 유지하지 않는다.
 * - 재생 상태를 모르는 측정(위치 모름 등)은 마지막 재생 시각을 늘리지도 지우지도 않는다.
 */

export const BACKGROUND_RULES = {
  /** 재생이 멈춘 뒤 이 시간이 지나면 백그라운드 유지를 놓는다 */
  idleMs: 10 * 60_000,
  /** 백그라운드 유지 중 재생 상태를 다시 읽는 간격(곡 변경 알림을 놓쳐도 따라가도록) */
  backgroundPollMs: 3_000,
} as const;

export type KeepAliveReason =
  /** 설정에서 끔 */
  | 'disabled'
  /** 소리로 싱크 맞추기가 듣는 중 */
  | 'auto-sync'
  /** 재생 중 */
  | 'playing'
  /** 멈춘 지 얼마 안 됨 */
  | 'recently-playing'
  /** 오래 멈춰 있음 */
  | 'idle'
  /** 아직 재생을 보지 못함 */
  | 'never-played';

export interface KeepAliveDecision {
  on: boolean;
  reason: KeepAliveReason;
}

const ACTIVE: readonly PlaybackStatus[] = ['playing', 'buffering'];

export class KeepAlivePolicy {
  private lastActiveAt: number | null = null;
  private playingNow = false;

  /** 재생 상태 측정(또는 알림)을 넣는다. nowMs는 단조 시각 */
  observe(snapshot: PlaybackSnapshot | null, nowMs: number): void {
    if (!snapshot) {
      this.playingNow = false;
      return;
    }
    if (snapshot.status === 'unknown') return;
    const active = snapshot.track !== null && ACTIVE.includes(snapshot.status);
    if (active) this.lastActiveAt = nowMs;
    else if (this.playingNow) this.lastActiveAt = nowMs; // 방금 멈춤: 여기서부터 idle 시간을 잰다
    this.playingNow = active;
  }

  decide(opts: { enabled: boolean; autoSyncRunning: boolean }, nowMs: number): KeepAliveDecision {
    if (!opts.enabled) return { on: false, reason: 'disabled' };
    if (opts.autoSyncRunning) return { on: false, reason: 'auto-sync' };
    if (this.playingNow) return { on: true, reason: 'playing' };
    if (this.lastActiveAt === null) return { on: false, reason: 'never-played' };
    if (nowMs - this.lastActiveAt <= BACKGROUND_RULES.idleMs) return { on: true, reason: 'recently-playing' };
    return { on: false, reason: 'idle' };
  }
}

/**
 * 재생 상태를 다시 읽을 간격(ms). null이면 읽지 않는다.
 * - 화면에 보이면 foregroundMs(가사 강조용 짧은 간격)
 * - 백그라운드면 유지 중일 때만 backgroundPollMs(곡 변경을 따라가는 데 필요한 만큼만), 아니면 읽지 않음
 */
export function playbackPollMs(opts: { appActive: boolean; keepAlive: boolean; foregroundMs: number }): number | null {
  if (opts.appActive) return opts.foregroundMs;
  return opts.keepAlive ? BACKGROUND_RULES.backgroundPollMs : null;
}

/** 저장된 설정 값 해석(없으면 켜짐) */
export function parseKeepAliveSetting(v: string | null): boolean {
  return v !== 'false';
}

/**
 * 재생 상태 따라가기: 측정·알림을 받아 늦게 읽힌 위치를 거르고(D-25), 곡이 바뀌면 세션에 알리고, 백그라운드 유지 정책에 넣는다.
 * 앱 화면(usePlayback)과 백그라운드에서 같은 경로를 쓴다 — 그래서 백그라운드에서도 곡 식별·가사 조회·자동 번역 정책이 그대로다.
 */
export class PlaybackFollower {
  private readonly filter = new PositionFilter();
  private lastTrack: ServiceTrackRef | null = null;
  private lastChange: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: {
      session: { onTrackChanged(ref: ServiceTrackRef): Promise<void> };
      clock: Clock;
      policy?: KeepAlivePolicy;
    },
  ) {}

  /** 측정(또는 알림)을 넣는다. 걸러 낸 스냅샷을 돌려주고, 곡이 바뀌었으면 세션에 알린다(기다리지 않음). */
  push(raw: PlaybackSnapshot | null): PlaybackSnapshot | null {
    const snap = raw ? this.filter.push(raw) : null;
    if (!raw) this.filter.reset();
    this.deps.policy?.observe(snap, this.deps.clock.monotonicMs());
    const track = snap?.track ?? null;
    if (!sameServiceTrack(this.lastTrack, track)) {
      this.lastTrack = track;
      if (track) this.lastChange = this.deps.session.onTrackChanged(track).catch(() => undefined);
    }
    return snap;
  }

  /** 마지막 곡 변경 처리가 끝날 때까지(테스트·종료용) */
  async idle(): Promise<void> {
    await this.lastChange;
  }

  /** 측정 기록을 버린다(탐색 직후·백그라운드에서 돌아올 때) */
  reset(): void {
    this.filter.reset();
  }
}
