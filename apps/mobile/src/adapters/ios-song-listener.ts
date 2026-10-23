import { Platform } from 'react-native';
import { mapListenReadiness, type ListenReadiness, type SongListener } from '@lyrics-companion/core';
import { SongListener as Native } from '../../modules/song-listener';

/**
 * iPhone 듣기 포트(소리로 싱크 맞추기, docs/plan.md D-44): 마이크 + 기기 안 음성 인식(iOS 26 이상).
 * 원시 값은 그대로 core로 넘기고(검사·해석은 core heard-audio.ts·auto-sync-runner.ts) 여기서는 연결만 한다.
 */
export class IosSongListener implements SongListener {
  static available(): boolean {
    return Platform.OS === 'ios' && Native !== null;
  }

  /** 시작 전 확인만(권한을 묻거나 내려받지 않음) — 화면 안내용 */
  async check(locale: string): Promise<ListenReadiness> {
    if (!Native) return { ok: false, reason: 'unsupported' };
    try {
      return mapListenReadiness(await Native.check(locale));
    } catch {
      return { ok: false, reason: 'unsupported' };
    }
  }

  async prepare(locale: string): Promise<ListenReadiness> {
    if (!Native) return { ok: false, reason: 'unsupported' };
    try {
      return mapListenReadiness(await Native.prepare(locale));
    } catch {
      return { ok: false, reason: 'unsupported' };
    }
  }

  async start(opts: { locale: string; hints: readonly string[] }): Promise<void> {
    if (!Native) throw new Error('듣기 모듈이 없습니다');
    await Native.start(opts.locale, [...opts.hints]);
  }

  async drain(): Promise<unknown> {
    return Native ? await Native.drain() : null;
  }

  async stop(): Promise<unknown> {
    return Native ? await Native.stop() : null;
  }

  async cancel(): Promise<void> {
    await Native?.cancel();
  }
}
