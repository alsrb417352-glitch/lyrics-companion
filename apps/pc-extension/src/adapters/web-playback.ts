import {
  mapMusicKitQueue,
  mapMusicKitSnapshot,
  remoteCaptureMonotonic,
  type Clock,
  type MusicKitQueueTrack,
  type MusicKitSnapshotRaw,
  type PlaybackAccess,
  type PlaybackControl,
  type PlaybackSnapshot,
  type PlaybackSource,
} from '@lyrics-companion/core';
import {
  CONNECT_REQUEST,
  readQueueRaw,
  TAB_PORT,
  type PageCommand,
  type PanelToTab,
  type TabToPanel,
} from '../shared/protocol';

export const APPLE_MUSIC_URL = 'https://music.apple.com/';
const APPLE_MUSIC_MATCH = 'https://music.apple.com/*';
const COMMAND_TIMEOUT_MS = 8_000;

/** 연결 상태(화면 안내용) */
export interface WebPlaybackStatus {
  /** 연결된 Apple Music 탭 수 */
  tabs: number;
  /** 열려 있지만 연결되지 않은 Apple Music 탭 수(새로고침 필요) */
  unconnectedTabs: number;
  /** 지금 가사를 따라가는 탭의 MusicKit 상태 */
  musicKit: 'ready' | 'missing' | 'unknown';
  queue: MusicKitQueueTrack[] | null;
  /** queue.items 안의 지금 재생 위치 */
  queuePosition: number | null;
}

/** 가사 화면이 쓰는 재생 정보 소스(확장 프로그램: Apple Music 탭들, 데모: 가짜 재생기) */
export interface WebPlayback extends PlaybackSource {
  readonly control: PlaybackControl;
  status(): WebPlaybackStatus;
  onStatus(listener: (s: WebPlaybackStatus) => void): () => void;
  /** 대기열 위치(queue.items 기준)의 곡부터 재생 */
  playQueueIndex(index: number): Promise<void>;
  /** Apple Music 웹을 새 탭으로 연다(또는 이미 열린 탭으로 이동) */
  openAppleMusic(): Promise<void>;
  /** Apple Music 탭들에 다시 연결을 요청한다(새로고침 없이 연결되는지 확인) */
  reconnect(): Promise<void>;
}

interface TabState {
  port: chrome.runtime.Port;
  last: PlaybackSnapshot | null;
  updatedAt: number;
  playingAt: number;
  musicKit: 'ready' | 'missing' | 'unknown';
  queue: MusicKitQueueTrack[] | null;
  queuePosition: number | null;
}

/**
 * Apple Music 웹 플레이어 탭들 → 재생 스냅샷(PlaybackSource 포트 구현).
 * - 각 탭의 relay가 Port로 연결해 오면 page-bridge가 보낸 MusicKit 원시 값을 core `mapMusicKitSnapshot`으로 해석한다.
 * - 측정 시각은 core `remoteCaptureMonotonic`으로 이 문서의 단조 시계에 옮긴다(받은 시각보다 늦게 만들지 않음).
 * - 여러 탭이면 가장 최근에 재생 중이던 탭을 따른다. 재생 제어도 그 탭으로 보낸다.
 */
export class TabsPlayback implements WebPlayback {
  readonly id = 'apple-music-web';
  private readonly tabs = new Map<number, TabState>();
  private readonly listeners = new Set<(s: PlaybackSnapshot) => void>();
  private readonly statusListeners = new Set<(s: WebPlaybackStatus) => void>();
  private readonly pending = new Map<
    number,
    { resolve: (v: TabToPanel) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private nextId = 1;
  private unconnected = 0;

  constructor(private readonly clock: Clock) {
    chrome.runtime.onConnect.addListener((port) => this.accept(port));
  }

  private accept(port: chrome.runtime.Port): void {
    const tabId = port.sender?.tab?.id;
    if (port.name !== TAB_PORT || tabId === undefined || !port.sender?.url?.startsWith(APPLE_MUSIC_URL)) return;
    const st: TabState = {
      port,
      last: null,
      updatedAt: 0,
      playingAt: 0,
      musicKit: 'unknown',
      queue: null,
      queuePosition: null,
    };
    this.tabs.get(tabId)?.port.disconnect();
    this.tabs.set(tabId, st);
    this.unconnected = Math.max(0, this.unconnected - 1);
    port.onMessage.addListener((m: TabToPanel) => this.onMessage(tabId, st, m));
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (this.tabs.get(tabId) === st) this.tabs.delete(tabId);
      this.emitStatus();
      const snap = this.active()?.last ?? this.emptySnapshot();
      for (const l of this.listeners) l(snap);
    });
    const watch: PanelToTab = { kind: 'watch', on: true };
    port.postMessage(watch);
    this.emitStatus();
  }

  private emptySnapshot(): PlaybackSnapshot {
    return {
      track: null,
      status: 'stopped',
      positionMs: null,
      capturedAtMonotonicMs: this.clock.monotonicMs(),
      rate: 0,
    };
  }

  private onMessage(tabId: number, st: TabState, m: TabToPanel): void {
    if (typeof m !== 'object' || m === null) return;
    if (m.kind === 'state') {
      const nowMono = this.clock.monotonicMs();
      const captured = remoteCaptureMonotonic({
        sentAtEpochMs: m.sentAt,
        receivedAtEpochMs: performance.timeOrigin + performance.now(),
        receivedAtMonotonicMs: nowMono,
      });
      const raw = (typeof m.raw === 'object' && m.raw !== null ? m.raw : {}) as MusicKitSnapshotRaw;
      const snap = mapMusicKitSnapshot(raw, captured);
      st.last = snap;
      st.updatedAt = nowMono;
      if (snap.status === 'playing') st.playingAt = nowMono;
      let statusChanged = false;
      if (m.queue !== undefined) statusChanged = this.setQueue(st, m.queue);
      if (st.musicKit !== 'ready') {
        st.musicKit = 'ready';
        statusChanged = true;
      }
      if (this.activeTabId() === tabId) {
        for (const l of this.listeners) l(snap);
      }
      if (statusChanged) this.emitStatus();
    } else if (m.kind === 'status') {
      st.musicKit = m.musicKit === 'ready' ? 'ready' : m.musicKit === 'missing' ? 'missing' : 'unknown';
      this.emitStatus();
    } else if (m.kind === 'result') {
      const id = typeof m.id === 'number' ? m.id : -1;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (m.queue !== undefined && this.setQueue(st, m.queue)) this.emitStatus();
      if (m.ok === true) p.resolve(m);
      else
        p.reject(
          new Error(typeof m.error === 'string' ? m.error.slice(0, 200) : '웹 플레이어가 명령을 실행하지 못했습니다'),
        );
    }
  }

  private setQueue(st: TabState, v: unknown): boolean {
    const q = readQueueRaw(v);
    if (!q) return false;
    st.queue = mapMusicKitQueue(q.items);
    st.queuePosition = q.position;
    return true;
  }

  private activeTabId(): number | null {
    let best: number | null = null;
    let bestKey = -1;
    for (const [id, st] of this.tabs) {
      // 재생 중이던 탭 우선, 다음은 곡이 있는 탭, 그다음 최근 갱신
      const key = (st.playingAt > 0 ? 2e12 + st.playingAt : 0) + (st.last?.track ? 1e12 : 0) + st.updatedAt;
      if (key > bestKey) {
        bestKey = key;
        best = id;
      }
    }
    return best;
  }

  private active(): TabState | null {
    const id = this.activeTabId();
    return id === null ? null : (this.tabs.get(id) ?? null);
  }

  /** 패널을 열 때: Apple Music 탭들에 연결 요청, 응답 없는 탭에는 스크립트를 넣어 본다(설치 직후 등). */
  async reconnect(): Promise<void> {
    let tabs: chrome.tabs.Tab[] = [];
    try {
      tabs = await chrome.tabs.query({ url: APPLE_MUSIC_MATCH });
    } catch {
      return;
    }
    await Promise.all(
      tabs.map(async (t) => {
        if (t.id === undefined || this.tabs.has(t.id)) return;
        try {
          await chrome.tabs.sendMessage(t.id, CONNECT_REQUEST);
        } catch {
          // 스크립트가 없는 탭(확장 프로그램 설치 전에 열린 탭): 직접 넣는다.
          try {
            await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['page-bridge.js'], world: 'MAIN' });
            await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['relay.js'] });
          } catch {
            // 권한 없음 등
          }
        }
      }),
    );
    await this.clock.sleep(800);
    this.unconnected = tabs.filter((t) => t.id !== undefined && !this.tabs.has(t.id)).length;
    this.emitStatus();
  }

  async openAppleMusic(): Promise<void> {
    const tabs = await chrome.tabs.query({ url: APPLE_MUSIC_MATCH }).catch(() => [] as chrome.tabs.Tab[]);
    const t = tabs[0];
    if (t?.id !== undefined) {
      await chrome.tabs.update(t.id, { active: true });
      if (t.windowId !== undefined) await chrome.windows.update(t.windowId, { focused: true });
      return;
    }
    await chrome.tabs.create({ url: APPLE_MUSIC_URL });
  }

  status(): WebPlaybackStatus {
    const a = this.active();
    return {
      tabs: this.tabs.size,
      unconnectedTabs: this.unconnected,
      musicKit: a?.musicKit ?? 'unknown',
      queue: a?.queue ?? null,
      queuePosition: a?.queuePosition ?? null,
    };
  }

  onStatus(listener: (s: WebPlaybackStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private emitStatus(): void {
    const s = this.status();
    for (const l of this.statusListeners) l(s);
  }

  async access(): Promise<PlaybackAccess> {
    // 웹 플레이어는 OS 권한이 없다. 연결된 탭이 없으면 화면이 "Apple Music 웹 열기"를 안내한다.
    return this.tabs.size > 0 ? 'granted' : 'not-determined';
  }

  async current(): Promise<PlaybackSnapshot | null> {
    return this.active()?.last ?? null;
  }

  subscribe(listener: (snapshot: PlaybackSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private send(cmd: PageCommand, arg?: number): Promise<TabToPanel> {
    const st = this.active();
    if (!st) return Promise.reject(new Error('연결된 Apple Music 탭이 없습니다'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('웹 플레이어가 응답하지 않습니다'));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      const msg: PanelToTab = { kind: 'command', id, cmd, ...(arg !== undefined ? { arg } : {}) };
      try {
        st.port.postMessage(msg);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('Apple Music 탭과 연결이 끊겼습니다'));
      }
    });
  }

  async playQueueIndex(index: number): Promise<void> {
    await this.send('playAt', index);
  }

  readonly control: PlaybackControl = {
    play: async () => {
      await this.send('play');
    },
    pause: async () => {
      await this.send('pause');
    },
    seekTo: async (positionMs: number) => {
      await this.send('seek', Math.max(0, positionMs) / 1000);
    },
    skipNext: async () => {
      await this.send('next');
    },
    skipPrevious: async () => {
      await this.send('prev');
    },
  };
}
