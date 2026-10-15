import { requireOptionalNativeModule, type NativeModule } from 'expo';

/**
 * iOS Music 앱 연동 네이티브 모듈(JS 측 타입). 구현: ios/NowPlayingModule.swift
 * iOS가 아닌 환경(Android·웹)에서는 null 이다.
 */

export type NowPlayingRaw = Record<string, unknown>;

export interface LibraryItemRaw {
  persistentId: string;
  title: string;
  artist: string;
  album?: string;
  durationSec: number;
  storeId: string;
}

/** 플레이리스트·곡 원시 값. 검증·정리는 core mapLibraryPlaylists / mapLibraryTracks */
export type PlaylistRaw = Record<string, unknown>;

type Events = { onChange: (raw: NowPlayingRaw) => void };

export declare class NowPlayingNativeModule extends NativeModule<Events> {
  authorizationStatus(): Promise<string>;
  requestAuthorization(): Promise<string>;
  current(): Promise<NowPlayingRaw>;
  play(): Promise<void>;
  pause(): Promise<void>;
  skipNext(): Promise<void>;
  skipPrevious(): Promise<void>;
  seekTo(seconds: number): Promise<void>;
  playStoreId(storeId: string): Promise<boolean>;
  searchLibrary(term: string): Promise<LibraryItemRaw[]>;
  playLibraryItem(persistentId: string): Promise<boolean>;
  listPlaylists(): Promise<PlaylistRaw[]>;
  playlistItems(playlistId: string): Promise<PlaylistRaw[]>;
  playPlaylist(playlistId: string, startItemId: string | null, shuffle: boolean): Promise<boolean>;
}

export const NowPlaying = requireOptionalNativeModule<NowPlayingNativeModule>('NowPlaying');

// ---------------------------------------------------------------- Android(MediaSession)

/**
 * Android 재생 앱(Spotify·YouTube Music·Apple Music) 연동 네이티브 모듈(JS 측 타입, docs/plan.md D-41).
 * 구현: android/src/main/java/expo/modules/nowplaying/MediaSessionsModule.kt. Android가 아니면 null 이다.
 * 값은 원시 값 그대로이며 해석은 core android-media-session.ts가 한다.
 */
export interface AndroidSessionsResult {
  granted: boolean;
  /** 세션 원시 값(core AndroidSessionRaw) */
  sessions: Array<Record<string, unknown>>;
}

export interface AndroidQueueResult {
  available: boolean;
  title: string | null;
  activeQueueItemId: string | null;
  /** 재생 목록 항목 원시 값(core AndroidQueueItemRaw) */
  items: Array<Record<string, unknown>>;
}

/** 'session' = 앱 세션에 검색 재생을 보냄(앱 전환 없음), 'launched' = 그 앱을 열어 검색 재생, 'unavailable' = 보낼 수 없음 */
export type PlayFromSearchResult = 'session' | 'launched' | 'unavailable';

type AndroidEvents = { onChange: (e: { reason: string }) => void };

export declare class AndroidMediaSessionsModule extends NativeModule<AndroidEvents> {
  accessStatus(): Promise<'granted' | 'not-granted' | 'unsupported'>;
  openAccessSettings(): Promise<boolean>;
  openAppDetails(): Promise<boolean>;
  sessions(): Promise<AndroidSessionsResult>;
  queue(packageName: string): Promise<AndroidQueueResult>;
  play(packageName: string): Promise<boolean>;
  pause(packageName: string): Promise<boolean>;
  skipNext(packageName: string): Promise<boolean>;
  skipPrevious(packageName: string): Promise<boolean>;
  seekTo(packageName: string, positionMs: number): Promise<boolean>;
  skipToQueueItem(packageName: string, queueId: string): Promise<boolean>;
  setShuffle(packageName: string, enabled: boolean): Promise<boolean>;
  playFromSearch(
    packageName: string,
    query: string,
    title: string | null,
    artist: string | null,
  ): Promise<PlayFromSearchResult>;
  installedPlayers(): Promise<string[]>;
  openPlayer(packageName: string): Promise<boolean>;
}

export const AndroidMediaSessions = requireOptionalNativeModule<AndroidMediaSessionsModule>('AndroidMediaSessions');
