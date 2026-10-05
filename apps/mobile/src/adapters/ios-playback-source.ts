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
    // 측정 시각 = 응답을 받은 시각. 실제로 읽은 순간은 그 이전이므로 위치를 앞당겨 추정하는 일이 없다.
    // (중간값을 쓰면 메인 스레드가 바쁠 때 읽은 순간보다 이른 시각으로 기록되어, 필터가 그 값을 골라 가사가 앞서갈 수 있다 — D-25)
    const raw = await NowPlaying.current();
    return mapIosSnapshot(raw, this.clock.monotonicMs());
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
