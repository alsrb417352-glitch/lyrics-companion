import { createRoot } from 'react-dom/client';
import type { SqlJsStatic } from 'sql.js';
import {
  type LyricsFetchResult,
  type LyricsProvider,
  type LyricsQuery,
  type MusicKitQueueTrack,
  type PlaybackControl,
  type PlaybackSnapshot,
  type ServiceTrackRef,
} from '@lyrics-companion/core';
import { MemorySecretStore } from '../adapters/native-secret-store';
import { MemoryFileStore } from '../adapters/sqljs-driver';
import type { WebPlayback, WebPlaybackStatus } from '../adapters/web-playback';
import { createAppServices } from '../services';
import { App, type BootState } from '../ui/App';

/**
 * 화면 확인용 데모(확장 프로그램에 포함되지 않음, `npm run demo`로 localhost에서만 연다).
 * 네트워크·실제 가사·실제 키를 쓰지 않는다: 가짜 재생기 + 합성 가사(이 파일에서 직접 지은 문장, 실제 곡 아님) + 메모리 저장소.
 */

declare global {
  interface Window {
    initSqlJs?: (config: { locateFile: (file: string) => string }) => Promise<SqlJsStatic>;
  }
}

const TRACKS: ServiceTrackRef[] = [
  {
    service: 'apple-music',
    serviceTrackId: '900000101',
    title: '合成テストの朝',
    artist: '데모 밴드',
    album: '합성 앨범',
    durationMs: 64_000,
    isrc: null,
  },
  {
    service: 'apple-music',
    serviceTrackId: '900000102',
    title: 'Synthetic Evening',
    artist: '데모 밴드',
    album: '합성 앨범',
    durationMs: 48_000,
    isrc: null,
  },
  {
    service: 'apple-music',
    serviceTrackId: '900000103',
    title: '시간 없는 합성 곡',
    artist: '데모 밴드',
    album: '합성 앨범',
    durationMs: 40_000,
    isrc: null,
  },
];

/** 합성 가사(테스트용으로 지은 문장) */
const LYRICS: Record<string, LyricsFetchResult> = {
  '900000101': {
    status: 'found',
    kind: 'synced',
    sourceRef: 'demo:1',
    hasWordTiming: false,
    notices: [],
    timed: [
      { startMs: 3_000, text: 'テストの窓をあける' },
      { startMs: 8_000, text: 'ことばは まだ ねむい' },
      { startMs: 13_000, text: '合成の空に 線をひく' },
      { startMs: 18_000, text: '' },
      { startMs: 20_000, text: 'ラララ デモのうた' },
      { startMs: 25_000, text: 'Hello 試験 また明日' },
      { startMs: 31_000, text: '画面の向こうで 待っている' },
      { startMs: 37_000, text: 'ラララ デモのうた' },
      { startMs: 43_000, text: 'おわりの合図を 聞かせて' },
    ],
  },
  '900000102': {
    status: 'found',
    kind: 'synced',
    sourceRef: 'demo:2',
    hasWordTiming: false,
    notices: [],
    timed: [
      { startMs: 2_000, text: 'A synthetic line to test the view' },
      { startMs: 8_000, text: 'Nothing here is from a real song' },
      { startMs: 14_000, text: 'Just placeholders moving down' },
      { startMs: 20_000, text: 'Until the demo track is done' },
    ],
  },
  '900000103': {
    status: 'found',
    kind: 'plain',
    sourceRef: 'demo:3',
    hasWordTiming: false,
    notices: [],
    plain: ['시간 정보가 없는 합성 가사 첫 줄', '수동 싱크 기록 화면을 시험하는 줄', '', '마지막 합성 줄'],
  },
};

class DemoLyrics implements LyricsProvider {
  readonly id = 'demo';
  async fetch(q: LyricsQuery): Promise<LyricsFetchResult> {
    await new Promise((r) => setTimeout(r, 300));
    return (q.storeId && LYRICS[q.storeId]) || { status: 'not_found', reason: 'no-record' };
  }
}

/** 시계로 진행하는 가짜 웹 플레이어(실제 Apple Music 탭 대신) */
class DemoPlayback implements WebPlayback {
  readonly id = 'demo';
  private index = 0;
  private playing = true;
  private basePos = 0;
  private baseAt = performance.now();
  private readonly listeners = new Set<(s: PlaybackSnapshot) => void>();
  private readonly statusListeners = new Set<(s: WebPlaybackStatus) => void>();

  constructor() {
    setInterval(() => {
      const s = this.snap();
      const dur = TRACKS[this.index]!.durationMs ?? 0;
      if (this.playing && s.positionMs !== null && s.positionMs >= dur) {
        this.go((this.index + 1) % TRACKS.length);
        return;
      }
      for (const l of this.listeners) l(s);
    }, 250);
  }

  private pos(): number {
    return this.playing ? this.basePos + (performance.now() - this.baseAt) : this.basePos;
  }

  private snap(): PlaybackSnapshot {
    const now = performance.now();
    return {
      track: TRACKS[this.index]!,
      status: this.playing ? 'playing' : 'paused',
      positionMs: Math.round(this.pos()),
      capturedAtMonotonicMs: now,
      rate: this.playing ? 1 : 0,
    };
  }

  private set(pos: number, playing: boolean): void {
    this.basePos = Math.max(0, pos);
    this.baseAt = performance.now();
    this.playing = playing;
    const s = this.snap();
    for (const l of this.listeners) l(s);
  }

  private go(i: number): void {
    this.index = i;
    this.set(0, true);
    this.emitStatus();
  }

  status(): WebPlaybackStatus {
    const queue: MusicKitQueueTrack[] = TRACKS.map((ref, index) => ({ index, ref }));
    return { tabs: 1, unconnectedTabs: 0, musicKit: 'ready', queue, queuePosition: this.index };
  }
  onStatus(l: (s: WebPlaybackStatus) => void) {
    this.statusListeners.add(l);
    return () => this.statusListeners.delete(l);
  }
  private emitStatus() {
    for (const l of this.statusListeners) l(this.status());
  }
  async playQueueIndex(index: number) {
    this.go(index);
  }
  async openAppleMusic() {}
  async reconnect() {}
  async access() {
    return 'granted' as const;
  }
  async current() {
    return this.snap();
  }
  subscribe(l: (s: PlaybackSnapshot) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  readonly control: PlaybackControl = {
    play: async () => this.set(this.pos(), true),
    pause: async () => this.set(this.pos(), false),
    seekTo: async (ms) => this.set(ms, this.playing),
    skipNext: async () => this.go((this.index + 1) % TRACKS.length),
    skipPrevious: async () => this.go((this.index + TRACKS.length - 1) % TRACKS.length),
  };
}

async function boot(): Promise<BootState> {
  if (!window.initSqlJs) throw new Error('SQLite 모듈을 불러오지 못했습니다');
  const sqlJs = await window.initSqlJs({ locateFile: (f) => f });
  const services = await createAppServices({
    sqlJs,
    files: new MemoryFileStore(),
    secrets: new MemorySecretStore(),
    secretStatus: async () => 'missing',
    playback: new DemoPlayback(),
    http: {
      send: () => Promise.reject(new Error('데모에서는 네트워크를 쓰지 않습니다')),
    },
    permissions: { has: async () => false, request: async () => false },
    lyricsOverride: new DemoLyrics(),
    echoLogs: true,
  });
  return { kind: 'ready', services };
}

createRoot(document.getElementById('root')!).render(<App boot={boot} />);
