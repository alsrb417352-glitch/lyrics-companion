import type { PlaybackSnapshot } from '../ports.js';

/**
 * 재생 위치 측정값 필터(순수 로직, 시간은 스냅샷의 단조 시각만 사용).
 *
 * 문제: Music 앱(systemMusicPlayer)의 currentPlaybackTime은 다른 프로세스 값을 읽어 오므로,
 * 읽는 순간 이미 조금 지난 값(오래된 값)일 수 있고 그 지연이 측정마다 다르다. 측정값을 그대로 쓰면
 * 가사가 늦게 넘어가고, 측정할 때마다 앞뒤로 흔들린다.
 *
 * 방법: 재생 중에는 "위치 − 측정 시각"(= 곡 시작 시각의 추정)이 일정해야 한다. 지연은 위치를 작게만 만들므로,
 * 최근 측정들 중 이 값이 가장 큰 것(가장 덜 늦은 측정)을 고른다(NTP의 최소 지연 표본 선택과 같은 원리).
 *  - 위치를 앞당겨 꾸며내지 않는다: 결과는 항상 실제로 받은 측정값 중 하나에 근거한다.
 *  - 재생 상태·곡·속도가 바뀌거나 값이 크게 튀면(탐색) 기록을 버리고 새로 시작한다.
 *  - 측정이 멈춘 채 들어오면(버퍼링 등) 정체가 jumpMs를 넘는 순간 새 값으로 다시 맞춘다.
 */
export interface PositionFilterConfig {
  /** 이 시간 안의 측정만 비교한다 */
  windowMs: number;
  /** 기준과 이만큼 이상 차이 나면 탐색·정체로 보고 새로 시작한다 */
  jumpMs: number;
}

export const DEFAULT_POSITION_FILTER: PositionFilterConfig = { windowMs: 3_000, jumpMs: 700 };

interface Sample {
  at: number;
  /** positionMs − at × rate */
  origin: number;
}

export class PositionFilter {
  private samples: Sample[] = [];
  private key: string | null = null;
  /** 뒤로 크게 벗어난 측정(탐색일 수도, 한 번 늦게 읽힌 값일 수도 있음). 다음 측정이 같은 쪽이면 확정 */
  private pendingBack: Sample | null = null;

  constructor(private readonly cfg: PositionFilterConfig = DEFAULT_POSITION_FILTER) {}

  /** 우리 앱이 직접 탐색했을 때 등: 기록을 버린다 */
  reset(): void {
    this.samples = [];
    this.key = null;
    this.pendingBack = null;
  }

  /** 새 측정을 넣고, 필터를 거친 스냅샷을 돌려준다(같은 측정 시각 기준의 위치). */
  push(s: PlaybackSnapshot): PlaybackSnapshot {
    if (s.positionMs === null || s.status !== 'playing' || !(s.rate > 0)) {
      this.reset();
      return s;
    }
    const t = s.track;
    const key = `${t?.serviceTrackId ?? ''}|${t?.title ?? ''}|${t?.durationMs ?? ''}|${s.rate}`;
    if (key !== this.key) {
      this.reset();
      this.key = key;
    }
    const origin = s.positionMs - s.capturedAtMonotonicMs * s.rate;
    const sample = { at: s.capturedAtMonotonicMs, origin };
    const best = this.bestOrigin();
    if (best !== null && origin - best >= this.cfg.jumpMs) {
      // 앞으로 크게 이동: 늦은 측정으로는 생길 수 없으므로 탐색(앞으로 감기)으로 보고 바로 따른다.
      this.samples = [];
      this.pendingBack = null;
    } else if (best !== null && best - origin >= this.cfg.jumpMs) {
      // 뒤로 크게 이동: 한 번만 그러면 늦게 읽힌 값일 수 있으니 무시하고, 연속 두 번이면 탐색·정체로 확정한다.
      const prev = this.pendingBack;
      if (!prev || Math.abs(prev.origin - origin) >= this.cfg.jumpMs) {
        this.pendingBack = sample;
        return this.output(s);
      }
      this.samples = [prev];
      this.pendingBack = null;
    } else {
      this.pendingBack = null;
    }
    this.samples.push(sample);
    const cutoff = s.capturedAtMonotonicMs - this.cfg.windowMs;
    this.samples = this.samples.filter((x) => x.at >= cutoff);
    return this.output(s);
  }

  private output(s: PlaybackSnapshot): PlaybackSnapshot {
    const chosen = this.bestOrigin();
    if (chosen === null) return s;
    let pos = chosen + s.capturedAtMonotonicMs * s.rate;
    const dur = s.track?.durationMs;
    if (dur != null && pos > dur) pos = dur;
    return { ...s, positionMs: Math.max(0, Math.round(pos)) };
  }

  private bestOrigin(): number | null {
    let best: number | null = null;
    for (const x of this.samples) if (best === null || x.origin > best) best = x.origin;
    return best;
  }
}
