/**
 * 교체 가능한 외부 의존성(포트) 정의.
 * core는 이 인터페이스만 알고, 실제 구현(React Native, 네이티브 모듈, Node 테스트 더블)은 바깥에서 주입한다.
 * 규칙: 이 파일과 core/src 어디에서도 Node·React Native·DOM 전용 API를 import 하지 않는다.
 */

/** 취소 신호. AbortSignal과 구조적으로 호환된다. */
export interface CancelSignal {
  readonly aborted: boolean;
}

/** 시간 공급자. 테스트에서는 FakeClock으로 교체한다. */
export interface Clock {
  /** 벽시계 시각(epoch ms). 기록·표시·일일 사용량 집계에만 사용한다. */
  nowEpochMs(): number;
  /** 단조 증가 시각(ms). 재생 위치 추정 등 경과 시간 계산에 사용한다. */
  monotonicMs(): number;
  sleep(ms: number, signal?: CancelSignal): Promise<void>;
}

/** 고유 ID 생성기. 앱에서는 암호학적 난수 UUID, 테스트에서는 순차 ID를 쓴다. */
export interface IdGenerator {
  next(prefix: string): string;
}

// ---------------------------------------------------------------- HTTP

export interface HttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  signal?: CancelSignal;
}

export interface HttpResponse {
  status: number;
  /** 헤더 이름은 소문자로 정규화한다. */
  headers: Record<string, string>;
  bodyText: string;
}

export type HttpErrorKind = 'offline' | 'timeout' | 'tls' | 'aborted' | 'network';

/**
 * 전송 계층 오류.
 * requestSent: 서버가 요청을 받았을 가능성. 'unknown'이면 과금·처리 여부를 확정할 수 없다.
 */
export class HttpError extends Error {
  constructor(
    readonly kind: HttpErrorKind,
    message: string,
    readonly requestSent: 'no' | 'unknown',
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface HttpClient {
  send(request: HttpRequest): Promise<HttpResponse>;
}

// ---------------------------------------------------------------- 보안 저장소

/** OS 보안 저장소(Android Keystore 기반 암호화, iOS Keychain) 추상화. 일반 설정 저장소와 분리한다. */
export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

// ---------------------------------------------------------------- 로그

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  event: string;
  data?: Record<string, unknown>;
  atEpochMs: number;
}

export interface LogSink {
  write(entry: LogEntry): void;
}

// ---------------------------------------------------------------- 재생 정보

export type StreamingService = 'apple-music' | 'spotify' | 'youtube-music' | 'unknown';

/** 스트리밍 앱이 알려준 곡 정보. 필드는 플랫폼·서비스별로 비어 있을 수 있다. */
export interface ServiceTrackRef {
  service: StreamingService;
  /** 서비스 고유 곡 ID. Android MediaSession 등에서는 없을 수 있다. */
  serviceTrackId: string | null;
  title: string;
  artist: string;
  album: string | null;
  durationMs: number | null;
  isrc: string | null;
}

export type PlaybackStatus = 'playing' | 'paused' | 'stopped' | 'buffering' | 'unknown';

/** 특정 시점의 재생 상태. 위치를 모르면 positionMs = null. */
export interface PlaybackSnapshot {
  track: ServiceTrackRef | null;
  status: PlaybackStatus;
  positionMs: number | null;
  /** positionMs를 측정한 단조 시각(Clock.monotonicMs 기준) */
  capturedAtMonotonicMs: number;
  /** 재생 속도. 일반 재생은 1 */
  rate: number;
}

export type PlaybackAccess = 'granted' | 'denied' | 'unsupported' | 'not-determined';

export interface PlaybackControl {
  play(): Promise<void>;
  pause(): Promise<void>;
  seekTo(positionMs: number): Promise<void>;
  skipNext(): Promise<void>;
  skipPrevious(): Promise<void>;
}

/** 재생 정보 제공자. Android MediaSession, iOS MusicKit, 수동 모드 등이 구현한다. */
export interface PlaybackSource {
  readonly id: string;
  access(): Promise<PlaybackAccess>;
  current(): Promise<PlaybackSnapshot | null>;
  subscribe(listener: (snapshot: PlaybackSnapshot) => void): () => void;
  /** 재생 제어를 지원하지 않는 소스는 undefined */
  readonly control?: PlaybackControl;
}
