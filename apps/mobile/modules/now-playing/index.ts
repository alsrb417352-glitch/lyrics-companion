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
}

export const NowPlaying = requireOptionalNativeModule<NowPlayingNativeModule>('NowPlaying');
