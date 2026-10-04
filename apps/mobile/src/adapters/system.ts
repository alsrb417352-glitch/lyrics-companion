import { randomUUID } from 'expo-crypto';
import type { CancelSignal, Clock, IdGenerator, LogEntry, LogSink } from '@lyrics-companion/core';

/** 실제 시계. 경과 시간 계산에는 단조 시계(performance.now)를 쓴다. */
export class SystemClock implements Clock {
  nowEpochMs(): number {
    return Date.now();
  }
  monotonicMs(): number {
    return performance.now();
  }
  sleep(ms: number, signal?: CancelSignal): Promise<void> {
    return new Promise((resolve) => {
      if (ms <= 0 || signal?.aborted) {
        resolve();
        return;
      }
      setTimeout(resolve, ms);
    });
  }
}

/** 암호학적 난수 UUID 기반 ID */
export class UuidIds implements IdGenerator {
  next(prefix: string): string {
    return `${prefix}_${randomUUID()}`;
  }
}

/**
 * 로그 싱크: 최근 200건만 메모리에 둔다(파일·서버로 보내지 않음).
 * core Logger가 싱크에 쓰기 전에 키를 마스킹한다. 개발 빌드에서만 콘솔에도 출력한다.
 */
export class RingLogSink implements LogSink {
  readonly entries: LogEntry[] = [];
  write(entry: LogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > 200) this.entries.shift();
    if (__DEV__) console.log(`[${entry.level}] ${entry.event}`, entry.data ?? '');
  }
}
