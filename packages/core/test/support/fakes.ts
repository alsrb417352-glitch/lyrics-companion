/**
 * 테스트 더블. 실제 계정·API 키·유료 호출 없이 core 로직을 검증하기 위한 가짜 제공자와 가짜 시계.
 */
import {
  HttpError,
  type CancelSignal,
  type Clock,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
  type IdGenerator,
  type LogEntry,
  type LogSink,
  type SecretStore,
} from '../../src/ports.js';
import {
  ProviderError,
  type TranslationProvider,
  type TranslationProviderRegistry,
  type TranslationProviderRequest,
  type TranslationProviderResponse,
} from '../../src/translation/provider.js';

export class FakeClock implements Clock {
  private epoch: number;
  private mono = 1_000_000;
  private sleepers: Array<{ at: number; resolve: () => void }> = [];

  constructor(startIso = '2026-10-04T00:00:00.000Z') {
    this.epoch = Date.parse(startIso);
  }

  nowEpochMs(): number {
    return this.epoch;
  }
  monotonicMs(): number {
    return this.mono;
  }
  sleep(ms: number, _signal?: CancelSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => this.sleepers.push({ at: this.mono + ms, resolve }));
  }
  advance(ms: number): void {
    this.mono += ms;
    this.epoch += ms;
    const due = this.sleepers.filter((s) => s.at <= this.mono);
    this.sleepers = this.sleepers.filter((s) => s.at > this.mono);
    for (const s of due) s.resolve();
  }
  /** 대기 중인 sleep을 즉시 끝까지 진행(시간 제한 대기 우회용) */
  async flushSleeps(): Promise<void> {
    for (let i = 0; i < 100 && this.sleepers.length > 0; i++) {
      const next = Math.min(...this.sleepers.map((s) => s.at));
      this.advance(next - this.mono);
      await Promise.resolve();
    }
  }
}

export class SeqIds implements IdGenerator {
  private n = 0;
  next(prefix: string): string {
    this.n += 1;
    return `${prefix}_${String(this.n).padStart(4, '0')}`;
  }
}

export type HttpHandler = (req: HttpRequest) => HttpResponse | Promise<HttpResponse>;

/** 라우팅 가능한 가짜 HTTP. 모든 요청을 기록한다. */
export class FakeHttp implements HttpClient {
  readonly calls: HttpRequest[] = [];
  offline = false;
  private routes: Array<{ match: (req: HttpRequest) => boolean; handler: HttpHandler }> = [];

  on(match: (req: HttpRequest) => boolean, handler: HttpHandler): this {
    this.routes.push({ match, handler });
    return this;
  }

  /** 기존 라우트보다 우선하는 라우트 추가 */
  prepend(match: (req: HttpRequest) => boolean, handler: HttpHandler): this {
    this.routes.unshift({ match, handler });
    return this;
  }

  async send(req: HttpRequest): Promise<HttpResponse> {
    this.calls.push(req);
    if (this.offline) throw new HttpError('offline', 'network unreachable', 'no');
    const route = this.routes.find((r) => r.match(req));
    if (!route) return { status: 599, headers: {}, bodyText: 'no fake route' };
    return route.handler(req);
  }
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  return { status, headers: { 'content-type': 'application/json', ...headers }, bodyText: JSON.stringify(body) };
}

type Behavior =
  | { type: 'respond'; rawText: string; refused?: boolean }
  | { type: 'throw'; error: Error }
  | { type: 'deferred'; deferred: Deferred<TranslationProviderResponse> };

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * 가짜 번역 제공자. 요청 내용으로부터 "정상" 응답을 자동 생성하거나, 지정한 동작(오류·지연)을 순서대로 수행한다.
 */
export class FakeTranslationProvider implements TranslationProvider {
  readonly calls: TranslationProviderRequest[] = [];
  private behaviors: Behavior[] = [];

  constructor(
    readonly providerId = 'fake-ai',
    readonly model = 'fake-model-1',
  ) {}

  respondWith(rawText: string, refused = false): this {
    this.behaviors.push({ type: 'respond', rawText, refused });
    return this;
  }
  throwOnce(error: Error): this {
    this.behaviors.push({ type: 'throw', error });
    return this;
  }
  deferNext(): Deferred<TranslationProviderResponse> {
    const d = deferred<TranslationProviderResponse>();
    this.behaviors.push({ type: 'deferred', deferred: d });
    return d;
  }

  /** 요청 JSON으로 정상 응답 생성: ko = "[번역] 원문", reading = 원문 가나 그대로(한자 없는 합성 가사 기준) */
  static autoAnswer(req: TranslationProviderRequest): string {
    const payload = JSON.parse(req.user) as {
      lines: Array<{ id: string; text: string }>;
      reading_required_ids: string[];
      task: string;
    };
    const wantKo = !payload.task.includes('읽기(reading)만');
    const need = new Set(payload.reading_required_ids);
    const wantReading = 'reading' in ((req.responseSchema['properties'] as any).lines.items.properties as object);
    return JSON.stringify({
      status: 'ok',
      lines: payload.lines.map((l) => ({
        id: l.id,
        ko: wantKo ? `[번역] ${l.text}` : '',
        ...(wantReading ? { reading: need.has(l.id) ? (FAKE_READINGS[l.text] ?? l.text) : '' } : {}),
      })),
    });
  }

  async translate(req: TranslationProviderRequest): Promise<TranslationProviderResponse> {
    this.calls.push(req);
    const b = this.behaviors.shift();
    if (!b) return { rawText: FakeTranslationProvider.autoAnswer(req) };
    if (b.type === 'respond') return { rawText: b.rawText, refused: b.refused ?? false };
    if (b.type === 'throw') throw b.error;
    return b.deferred.promise;
  }
}

/** 합성 가사의 한자 포함 행에 대한 가짜 읽기 */
export const FAKE_READINGS: Record<string, string> = {
  夜明けの駅で君を待つ: 'よあけのえきできみをまつ',
  光の中へ走り出す: 'ひかりのなかえはしりだす',
  同じ空を見上げてた: 'おなじそらをみあげてた',
  'Hello さよなら また明日': 'Hello さよなら またあした',
};

export class StaticRegistry implements TranslationProviderRegistry {
  constructor(public provider: TranslationProvider | null) {}
  async active(): Promise<TranslationProvider | null> {
    return this.provider;
  }
}

export class MemorySecretStore implements SecretStore {
  readonly data = new Map<string, string>();
  async get(name: string): Promise<string | null> {
    return this.data.get(name) ?? null;
  }
  async set(name: string, value: string): Promise<void> {
    this.data.set(name, value);
  }
  async delete(name: string): Promise<void> {
    this.data.delete(name);
  }
}

export class MemorySink implements LogSink {
  readonly entries: LogEntry[] = [];
  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
  dump(): string {
    return this.entries.map((e) => JSON.stringify(e)).join('\n');
  }
}

export const providerErrors = {
  timeout: () => new ProviderError('timeout', 'request timed out', 'possible'),
  auth: (msg = 'invalid api key') => new ProviderError('auth', msg, 'none'),
  rateLimited: () => new ProviderError('rate_limited', 'HTTP 429', 'none', 20_000),
  offline: () => new ProviderError('offline', 'offline', 'none'),
};
