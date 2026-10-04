import type { Clock, LogLevel, LogSink } from '../ports.js';
import { redactValue, type SecretRegistry } from './redact.js';

/**
 * 모든 core 로그는 이 Logger를 거친다. 싱크에 쓰기 전에 마스킹한다.
 * 가사 원문·번역 전문은 로그에 남기지 않는다(개수·길이만 기록).
 */
export class Logger {
  constructor(
    private readonly sink: LogSink,
    private readonly clock: Clock,
    private readonly secrets: SecretRegistry,
  ) {}

  log(level: LogLevel, event: string, data?: Record<string, unknown>): void {
    const safe = data ? (redactValue(data, this.secrets.known()) as Record<string, unknown>) : undefined;
    this.sink.write({ level, event, atEpochMs: this.clock.nowEpochMs(), ...(safe ? { data: safe } : {}) });
  }

  debug(event: string, data?: Record<string, unknown>): void {
    this.log('debug', event, data);
  }
  info(event: string, data?: Record<string, unknown>): void {
    this.log('info', event, data);
  }
  warn(event: string, data?: Record<string, unknown>): void {
    this.log('warn', event, data);
  }
  error(event: string, data?: Record<string, unknown>): void {
    this.log('error', event, data);
  }
}
