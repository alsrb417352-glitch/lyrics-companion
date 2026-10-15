import { Platform } from 'react-native';
import {
  androidPlayerOf,
  androidSupports,
  mapAndroidAccess,
  mapAndroidQueue,
  mapAndroidSnapshot,
  pickAndroidSession,
  type AndroidAction,
  type AndroidPlayerApp,
  type AndroidQueueTrack,
  type AndroidSessionRaw,
  type Clock,
  type PlaybackAccess,
  type PlaybackControl,
  type PlaybackSnapshot,
  type PlaybackSource,
} from '@lyrics-companion/core';
import { AndroidMediaSessions, type PlayFromSearchResult } from '../../modules/now-playing';

export interface AndroidQueue {
  app: AndroidPlayerApp;
  /** 앱이 알려 준 재생 목록 이름(플레이리스트·앨범 이름 등), 없으면 null */
  title: string | null;
  tracks: AndroidQueueTrack[];
  activeQueueId: string | null;
}

/**
 * Android 재생 앱(Spotify·YouTube Music·Apple Music) 재생 소스(docs/plan.md D-41).
 * - OS MediaSession을 알림 접근 권한으로 읽는다. 여러 앱이 세션을 가지면 core pickAndroidSession이 따를 앱을 정한다.
 * - 재생 제어·재생 목록·검색 재생은 지금 따르는 앱으로 보낸다.
 * - 측정 시각 = 응답을 받은 시각. 위치는 네이티브가 읽은 순간 기준이라 그 사이만큼 뒤처질 뿐 앞서가지 않는다(D-25).
 */
export class AndroidMediaPlayback implements PlaybackSource {
  readonly id = 'android-media-session';
  readonly platform = 'android' as const;
  /** 지금 따르는 앱 패키지(재생이 멈춰도 유지) */
  private followed: string | null = null;
  private lastRaw: AndroidSessionRaw | null = null;

  constructor(private readonly clock: Clock) {}

  static available(): boolean {
    return Platform.OS === 'android' && AndroidMediaSessions !== null;
  }

  async access(): Promise<PlaybackAccess> {
    if (!AndroidMediaSessions) return 'unsupported';
    return mapAndroidAccess(await AndroidMediaSessions.accessStatus());
  }

  /** 설정 › 알림 접근 화면을 연다. 허용 여부는 앱으로 돌아왔을 때 access()로 다시 확인한다. */
  async requestAccess(): Promise<PlaybackAccess> {
    if (!AndroidMediaSessions) return 'unsupported';
    await AndroidMediaSessions.openAccessSettings();
    return this.access();
  }

  /** 앱 정보 화면(Android 13+ 사이드로드 앱은 여기서 "제한된 설정 허용"을 해야 알림 접근을 켤 수 있다) */
  async openAppDetails(): Promise<void> {
    await AndroidMediaSessions?.openAppDetails();
  }

  async current(): Promise<PlaybackSnapshot | null> {
    if (!AndroidMediaSessions) return null;
    const r = await AndroidMediaSessions.sessions();
    const now = this.clock.monotonicMs();
    if (!r.granted) return null;
    const raw = pickAndroidSession(r.sessions as AndroidSessionRaw[], this.followed);
    this.lastRaw = raw;
    if (!raw) return { track: null, status: 'stopped', positionMs: null, capturedAtMonotonicMs: now, rate: 0 };
    this.followed = typeof raw.packageName === 'string' ? raw.packageName : this.followed;
    return mapAndroidSnapshot(raw, now);
  }

  subscribe(listener: (snapshot: PlaybackSnapshot) => void): () => void {
    if (!AndroidMediaSessions) return () => undefined;
    // 이벤트는 "바뀌었다"만 알린다 → 세션을 다시 읽어 core가 해석한다
    const sub = AndroidMediaSessions.addListener('onChange', () => {
      this.current().then(
        (s) => {
          if (s) listener(s);
        },
        () => undefined,
      );
    });
    return () => sub.remove();
  }

  /** 지금 따르는 앱(아직 없으면 null) */
  followedApp(): AndroidPlayerApp | null {
    return androidPlayerOf(this.followed);
  }

  /** 지금 따르는 앱 세션이 그 동작을 지원한다고 알렸는지(앱이 알리지 않아도 명령은 보낼 수 있다) */
  supports(action: AndroidAction): boolean {
    return androidSupports(this.lastRaw, action);
  }

  private target(): string {
    return this.followed ?? '';
  }

  readonly control: PlaybackControl = {
    play: async () => {
      await AndroidMediaSessions?.play(this.target());
    },
    pause: async () => {
      await AndroidMediaSessions?.pause(this.target());
    },
    seekTo: async (positionMs: number) => {
      await AndroidMediaSessions?.seekTo(this.target(), Math.max(0, Math.round(positionMs)));
    },
    skipNext: async () => {
      await AndroidMediaSessions?.skipNext(this.target());
    },
    skipPrevious: async () => {
      await AndroidMediaSessions?.skipPrevious(this.target());
    },
  };

  /** 지금 따르는 앱의 재생 목록(대기열). 앱이 알려 주지 않으면 곡 0개 */
  async queue(): Promise<AndroidQueue | null> {
    const app = this.followedApp();
    if (!AndroidMediaSessions || !app) return null;
    const r = await AndroidMediaSessions.queue(app.packageName);
    return {
      app,
      title: typeof r.title === 'string' && r.title.trim() ? r.title.trim().slice(0, 200) : null,
      tracks: mapAndroidQueue(app.packageName, r.items),
      activeQueueId: typeof r.activeQueueItemId === 'string' ? r.activeQueueItemId : null,
    };
  }

  /** 재생 목록의 그 곡부터 재생 */
  async playQueueItem(queueId: string): Promise<boolean> {
    if (!AndroidMediaSessions || !this.followed) return false;
    return AndroidMediaSessions.skipToQueueItem(this.followed, queueId);
  }

  /** 셔플 켜기·끄기(앱이 지원할 때만 효과가 있다) */
  async setShuffle(enabled: boolean): Promise<boolean> {
    if (!AndroidMediaSessions || !this.followed) return false;
    return AndroidMediaSessions.setShuffle(this.followed, enabled);
  }

  /** 지원 앱 중 이 기기에 설치된 앱 */
  async installedApps(): Promise<AndroidPlayerApp[]> {
    if (!AndroidMediaSessions) return [];
    const pkgs = await AndroidMediaSessions.installedPlayers();
    return pkgs.map((p) => androidPlayerOf(p)).filter((a): a is AndroidPlayerApp => a !== null);
  }

  /** 그 앱에서 검색해 재생(검색 결과의 첫 곡을 앱이 고른다). 재생이 시작되면 그 앱을 따른다. */
  async playFromSearch(
    app: AndroidPlayerApp,
    query: string,
    hint: { title?: string; artist?: string } = {},
  ): Promise<PlayFromSearchResult> {
    if (!AndroidMediaSessions) return 'unavailable';
    const r = await AndroidMediaSessions.playFromSearch(
      app.packageName,
      query,
      hint.title ?? null,
      hint.artist ?? null,
    );
    if (r !== 'unavailable') this.followed = app.packageName;
    return r;
  }
}
