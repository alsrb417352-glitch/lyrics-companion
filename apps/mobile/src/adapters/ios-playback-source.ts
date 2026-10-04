import { Platform } from 'react-native';
import {
  mapIosAuthorization,
  mapIosSnapshot,
  type Clock,
  type PlaybackAccess,
  type PlaybackControl,
  type PlaybackSnapshot,
  type PlaybackSource,
} from '@lyrics-companion/core';
import { NowPlaying } from '../../modules/now-playing';

/**
 * iOS Music 앱(systemMusicPlayer) 재생 소스. Apple Music·보관함 곡만 해당한다.
 * 지원 범위는 Apple Music(Music 앱)뿐이다(docs/plan.md D-17).
 * 탐색(seek) 알림이 없을 수 있어, 화면 표시 중에는 호출자가 current()를 주기적으로 다시 읽는다.
 */
export class IosMusicPlaybackSource implements PlaybackSource {
  readonly id = 'ios-system-music';

  constructor(private readonly clock: Clock) {}

  static available(): boolean {
    return Platform.OS === 'ios' && NowPlaying !== null;
  }

  async access(): Promise<PlaybackAccess> {
    if (!NowPlaying) return 'unsupported';
    return mapIosAuthorization(await NowPlaying.authorizationStatus());
  }

  async requestAccess(): Promise<PlaybackAccess> {
    if (!NowPlaying) return 'unsupported';
    return mapIosAuthorization(await NowPlaying.requestAuthorization());
  }

  async current(): Promise<PlaybackSnapshot | null> {
    if (!NowPlaying) return null;
    // 측정 시각 = 호출 전후의 중간(네이티브 왕복 지연의 절반만큼 보정)
    const before = this.clock.monotonicMs();
    const raw = await NowPlaying.current();
    const after = this.clock.monotonicMs();
    return mapIosSnapshot(raw, before + (after - before) / 2);
  }

  subscribe(listener: (snapshot: PlaybackSnapshot) => void): () => void {
    if (!NowPlaying) return () => undefined;
    const sub = NowPlaying.addListener('onChange', (raw) => listener(mapIosSnapshot(raw, this.clock.monotonicMs())));
    return () => sub.remove();
  }

  readonly control: PlaybackControl = {
    play: async () => {
      await NowPlaying?.play();
    },
    pause: async () => {
      await NowPlaying?.pause();
    },
    seekTo: async (positionMs: number) => {
      await NowPlaying?.seekTo(Math.max(0, positionMs) / 1000);
    },
    skipNext: async () => {
      await NowPlaying?.skipNext();
    },
    skipPrevious: async () => {
      await NowPlaying?.skipPrevious();
    },
  };
}
