import { AppState, Platform } from 'react-native';
import {
  KeepAlivePolicy,
  type AutoSyncRunner,
  type Clock,
  type KeepAliveDecision,
  type Logger,
  type LyricsStore,
  type PlaybackSnapshot,
} from '@lyrics-companion/core';
import { NowPlaying } from '../../modules/now-playing';

/** 켜기에 실패하면(전화 중 등) 이만큼 지난 뒤 다시 시도 */
const RETRY_MS = 30_000;
/** 재생 측정이 없어도(백그라운드) 오래 멈춤을 알아채도록 다시 판단하는 간격 */
const TICK_MS = 30_000;

export interface BackgroundStatus {
  enabled: boolean;
  /** 지금 소리 없는 오디오로 깨어 있음 */
  active: boolean;
  decision: KeepAliveDecision;
  /** 마지막으로 켜기에 실패했는지 */
  failed: boolean;
}

/**
 * 백그라운드에서 가사 찾기·자동 번역(D-45) — iPhone.
 * 언제 깨어 있을지는 core KeepAlivePolicy가 정하고(재생 중·멈춘 지 10분 안, 설정 켜짐, 소리로 싱크 맞추기 중 아님),
 * 여기서는 그 결정을 네이티브(NowPlaying.setKeepAlive — 소리 없는 오디오를 다른 소리와 섞어 재생)에 반영만 한다.
 * 깨어 있는 동안 usePlayback이 백그라운드에서도 재생 상태를 읽어 곡 변경을 세션에 알린다(가사 조회·자동 번역 정책은 그대로).
 */
export class BackgroundKeeper {
  readonly policy = new KeepAlivePolicy();
  private enabled = true;
  private active = false;
  private failedAt: number | null = null;
  private chain: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly deps: { store: LyricsStore; clock: Clock; logger: Logger; autoSync: AutoSyncRunner | null },
  ) {}

  static available(): boolean {
    return Platform.OS === 'ios' && NowPlaying !== null;
  }

  async start(): Promise<void> {
    this.enabled = await this.deps.store.getBackgroundKeepAlive();
    this.deps.autoSync?.subscribe(() => this.apply());
    this.timer = setInterval(() => {
      this.verify();
      this.apply();
    }, TICK_MS);
    // 앱이 화면으로 돌아오면 바로 다시 판단(멈춘 동안 놓쳤을 수 있음)
    AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        this.verify();
        this.apply();
      }
    });
    this.apply();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get status(): BackgroundStatus {
    return { enabled: this.enabled, active: this.active, decision: this.decide(), failed: this.failedAt !== null };
  }

  /** 지금 깨어 있는지(백그라운드 재조회 여부 판단용) */
  get isActive(): boolean {
    return this.active;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 재생 측정·알림(usePlayback이 넣음) */
  observe(snapshot: PlaybackSnapshot | null): void {
    this.policy.observe(snapshot, this.deps.clock.monotonicMs());
    this.apply();
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.deps.store.setBackgroundKeepAlive(enabled);
    this.enabled = enabled;
    this.failedAt = null;
    this.apply();
    this.emit();
  }

  private decide(): KeepAliveDecision {
    return this.policy.decide(
      { enabled: this.enabled, autoSyncRunning: this.deps.autoSync?.current.running ?? false },
      this.deps.clock.monotonicMs(),
    );
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  /**
   * 켜 둔 줄 알았는데 OS가 무음 재생을 멈춘 경우(다른 앱이 오디오 세션을 끔 등)를 알아챈다.
   * 멈췄으면 꺼진 것으로 바꿔 다음 apply에서 다시 켠다.
   */
  private verify(): void {
    this.chain = this.chain
      .then(async () => {
        if (!this.active || !NowPlaying) return;
        const s = await NowPlaying.keepAliveStatus().catch(() => 'failed');
        if (s === 'on') return;
        this.active = false;
        this.deps.logger.info('background.keep_alive', { on: false, reason: 'lost', result: s });
        this.emit();
      })
      .catch(() => undefined);
  }

  /** 결정이 바뀐 경우에만 네이티브를 부른다(차례대로 하나씩) */
  private apply(): void {
    this.chain = this.chain
      .then(async () => {
        const d = this.decide();
        if (d.on === this.active) return;
        const now = this.deps.clock.monotonicMs();
        if (d.on && this.failedAt !== null && now - this.failedAt < RETRY_MS) return;
        let result = 'failed';
        try {
          result = NowPlaying ? await NowPlaying.setKeepAlive(d.on) : 'failed';
        } catch {
          result = 'failed';
        }
        this.active = result === 'on';
        this.failedAt = d.on && result !== 'on' ? now : null;
        this.deps.logger.info('background.keep_alive', { on: this.active, reason: d.reason, result });
        this.emit();
      })
      .catch(() => undefined);
  }
}
