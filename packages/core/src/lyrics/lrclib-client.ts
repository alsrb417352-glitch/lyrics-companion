import { HttpError, type Clock, type HttpClient, type HttpResponse } from '../ports.js';

/**
 * LRCLIB API 클라이언트 (https://lrclib.net/docs, 2026-10-04 확인).
 * - 클라이언트 식별 헤더(User-Agent, 대체 헤더 Lrclib-Client)를 보낸다.
 * - 요청은 순차 처리하고 요청 간 최소 간격을 둔다(문서 권장 200–500ms).
 * - 429의 Retry-After를 지킨다. 대기 시간 동안은 네트워크 요청 없이 rate_limited를 반환한다.
 * - 일시 오류는 클라이언트 안에서 다시 시도한다(D-33). 실제 LRCLIB는 부하가 몰리면 요청의 상당수(2026-10-06
 *   측정 약 20%)에 503 ServerOverloaded + Retry-After: 1을 돌려주고, 1초 뒤 같은 요청은 대부분 성공한다.
 *   - 503·502·504·Cloudflare 520~524: Retry-After(없으면 1·2·4초…)만큼 기다렸다 같은 요청을 최대 maxTransientRetries번 다시 보낸다.
 *     기다리는 동안 다른 요청도 같이 쉰다(pausedUntil). Retry-After가 maxTransientWaitMs보다 길면 다시 시도하지 않는다.
 *   - 시간 초과는 1번만 다시 시도한다(GET 조회라 서버 상태를 바꾸지 않음 — 불변조건 7은 AI 요청 대상).
 *   - 429는 다시 시도하지 않는다(호출자가 Retry-After를 보고 판단).
 * - 429 응답 본문은 JSON이 아닐 수 있으므로 상태 코드와 헤더만 신뢰한다.
 * - 응답은 신뢰하지 않는 데이터로 보고 형식·크기를 검증한다.
 */

export interface LrclibRecord {
  id: number;
  trackName: string;
  artistName: string;
  albumName: string;
  /** 초 단위 */
  duration: number;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
  hasWordSync: boolean;
}

export type LrclibErrorKind = 'offline' | 'timeout' | 'server' | 'bad_request' | 'invalid_response' | 'aborted';

export type LrclibLookup =
  | { status: 'found'; record: LrclibRecord }
  | { status: 'not_found' }
  | { status: 'rate_limited'; retryAfterMs: number }
  | { status: 'error'; kind: LrclibErrorKind; message: string };

export type LrclibSearch =
  | { status: 'ok'; records: LrclibRecord[] }
  | { status: 'rate_limited'; retryAfterMs: number }
  | { status: 'error'; kind: LrclibErrorKind; message: string };

export interface LrclibClientOptions {
  http: HttpClient;
  clock: Clock;
  /** 예: "LyricsCompanion/0.1.0 (https://example.invalid/contact)" */
  clientId: string;
  baseUrl?: string;
  minIntervalMs?: number;
  timeoutMs?: number;
  maxBodyChars?: number;
  defaultRetryAfterMs?: number;
  /** 503 등 일시 오류를 다시 보낼 최대 횟수(기본 3) */
  maxTransientRetries?: number;
  /** 일시 오류에서 이보다 오래 기다리라고 하면 다시 시도하지 않는다(기본 10초) */
  maxTransientWaitMs?: number;
  /** Retry-After가 없을 때 첫 대기 시간(기본 1초, 다음부터 2배) */
  transientBackoffMs?: number;
}

/** 다시 보내면 성공할 가능성이 높은 서버 상태(과부하·게이트웨이 오류) */
function isTransientStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 524);
}

export interface LrclibSignature {
  trackName: string;
  artistName: string;
  albumName?: string | null;
  durationSec?: number | null;
}

const MAX_LYRICS_CHARS = 256 * 1024;

export class LrclibClient {
  private readonly baseUrl: string;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly maxBodyChars: number;
  private readonly defaultRetryAfterMs: number;
  private readonly maxTransientRetries: number;
  private readonly maxTransientWaitMs: number;
  private readonly transientBackoffMs: number;
  private nextAllowedAt = 0;
  /** 429: 이 시각까지는 요청을 보내지 않고 rate_limited를 반환 */
  private blockedUntil = 0;
  /** 503 등 짧은 과부하: 이 시각까지 기다렸다 보낸다 */
  private pausedUntil = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: LrclibClientOptions) {
    this.baseUrl = (opts.baseUrl ?? 'https://lrclib.net').replace(/\/+$/, '');
    if (!this.baseUrl.startsWith('https://')) throw new Error('LRCLIB baseUrl은 https여야 합니다');
    this.minIntervalMs = opts.minIntervalMs ?? 300;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxBodyChars = opts.maxBodyChars ?? 2 * 1024 * 1024;
    this.defaultRetryAfterMs = opts.defaultRetryAfterMs ?? 60_000;
    this.maxTransientRetries = opts.maxTransientRetries ?? 3;
    this.maxTransientWaitMs = opts.maxTransientWaitMs ?? 10_000;
    this.transientBackoffMs = opts.transientBackoffMs ?? 1000;
  }

  async get(sig: LrclibSignature): Promise<LrclibLookup> {
    const params: Record<string, string> = {
      track_name: sig.trackName,
      artist_name: sig.artistName,
    };
    if (sig.albumName) params['album_name'] = sig.albumName;
    if (sig.durationSec != null) {
      const d = Math.round(sig.durationSec);
      if (d >= 1 && d <= 3600) params['duration'] = String(d);
    }
    return this.lookup('/api/get', params);
  }

  async getById(id: number): Promise<LrclibLookup> {
    if (!Number.isInteger(id) || id <= 0) {
      return { status: 'error', kind: 'bad_request', message: 'invalid id' };
    }
    return this.lookup(`/api/get/${id}`, {});
  }

  async search(params: {
    q?: string;
    trackName?: string;
    artistName?: string;
    albumName?: string;
  }): Promise<LrclibSearch> {
    const query: Record<string, string> = {};
    if (params.q) query['q'] = params.q;
    if (params.trackName) query['track_name'] = params.trackName;
    if (params.artistName) query['artist_name'] = params.artistName;
    if (params.albumName) query['album_name'] = params.albumName;
    if (!query['q'] && !query['track_name']) {
      return { status: 'error', kind: 'bad_request', message: 'q 또는 trackName 필요' };
    }
    const res = await this.request('/api/search', query);
    if ('status' in res) return res;
    if (res.response.status !== 200) return this.mapError(res.response);
    const json = this.parseJson(res.response);
    if (!Array.isArray(json)) return invalid('search 응답이 배열이 아님');
    const records: LrclibRecord[] = [];
    for (const item of json.slice(0, 50)) {
      const rec = validateRecord(item);
      if (rec) records.push(rec);
    }
    return { status: 'ok', records };
  }

  private async lookup(path: string, params: Record<string, string>): Promise<LrclibLookup> {
    const res = await this.request(path, params);
    if ('status' in res) return res;
    const r = res.response;
    if (r.status === 404) return { status: 'not_found' };
    if (r.status !== 200) return this.mapError(r);
    const rec = validateRecord(this.parseJson(r));
    if (!rec) return invalid('레코드 형식 오류');
    return { status: 'found', record: rec };
  }

  private mapError(r: HttpResponse): Exclude<LrclibLookup, { status: 'found' } | { status: 'not_found' }> {
    if (r.status === 429) {
      const retryAfterMs = this.parseRetryAfter(r.headers['retry-after']);
      this.blockedUntil = this.opts.clock.monotonicMs() + retryAfterMs;
      return { status: 'rate_limited', retryAfterMs };
    }
    if (r.status === 503) {
      // 다시 시도해도 503이 남은 경우. 짧은 대기면 다음 요청이 그만큼 쉬었다 보내고, 길면 그동안 보내지 않는다.
      const retryAfterMs = this.parseRetryAfter(r.headers['retry-after']);
      const until = this.opts.clock.monotonicMs() + retryAfterMs;
      if (retryAfterMs <= this.maxTransientWaitMs) this.pausedUntil = Math.max(this.pausedUntil, until);
      else this.blockedUntil = until;
      return { status: 'error', kind: 'server', message: `HTTP 503 (retry after ${retryAfterMs}ms)` };
    }
    if (r.status >= 400 && r.status < 500) {
      return { status: 'error', kind: 'bad_request', message: `HTTP ${r.status}` };
    }
    return { status: 'error', kind: 'server', message: `HTTP ${r.status}` };
  }

  private parseRetryAfter(value: string | undefined): number {
    if (value === undefined) return this.defaultRetryAfterMs;
    const seconds = Number(value.trim());
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 3_600_000);
    return this.defaultRetryAfterMs; // HTTP-date 형식 등은 보수적으로 기본값
  }

  private parseJson(r: HttpResponse): unknown {
    const ct = r.headers['content-type'] ?? '';
    if (!ct.includes('application/json')) return undefined;
    if (r.bodyText.length > this.maxBodyChars) return undefined;
    try {
      return JSON.parse(r.bodyText) as unknown;
    } catch {
      return undefined;
    }
  }

  /** 일시 오류 대기 시간: Retry-After(초)가 있으면 그것, 없으면 지수 증가 */
  private transientDelayMs(r: HttpResponse | null, attempt: number): number {
    const header = r?.headers['retry-after'];
    if (header !== undefined) {
      const seconds = Number(header.trim());
      if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 3_600_000);
    }
    return this.transientBackoffMs * 2 ** attempt;
  }

  /** 순차 큐 + 최소 간격 + Retry-After 차단 + 일시 오류 재시도를 적용한 요청 */
  private request(
    path: string,
    params: Record<string, string>,
  ): Promise<
    | { response: HttpResponse }
    | { status: 'rate_limited'; retryAfterMs: number }
    | { status: 'error'; kind: LrclibErrorKind; message: string }
  > {
    const clock = this.opts.clock;
    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;

    const sendOnce = async (): Promise<
      { response: HttpResponse } | { status: 'error'; kind: LrclibErrorKind; message: string }
    > => {
      try {
        const response = await this.opts.http.send({
          url,
          method: 'GET',
          headers: {
            'User-Agent': this.opts.clientId,
            'Lrclib-Client': this.opts.clientId,
            Accept: 'application/json',
          },
          timeoutMs: this.timeoutMs,
        });
        return { response };
      } catch (e) {
        if (e instanceof HttpError) {
          const kind: LrclibErrorKind =
            e.kind === 'offline'
              ? 'offline'
              : e.kind === 'timeout'
                ? 'timeout'
                : e.kind === 'aborted'
                  ? 'aborted'
                  : 'server';
          return { status: 'error' as const, kind, message: e.message };
        }
        return { status: 'error' as const, kind: 'server' as const, message: 'unexpected transport error' };
      } finally {
        this.nextAllowedAt = clock.monotonicMs() + this.minIntervalMs;
      }
    };

    const run = async () => {
      let transientTries = 0;
      let networkTries = 0;
      for (;;) {
        const now = clock.monotonicMs();
        if (now < this.blockedUntil) {
          return { status: 'rate_limited' as const, retryAfterMs: this.blockedUntil - now };
        }
        const wait = Math.max(this.nextAllowedAt, this.pausedUntil) - now;
        if (wait > 0) await clock.sleep(wait);

        const res = await sendOnce();
        if ('response' in res) {
          const r = res.response;
          if (isTransientStatus(r.status) && transientTries < this.maxTransientRetries) {
            const delay = this.transientDelayMs(r, transientTries);
            if (delay <= this.maxTransientWaitMs) {
              transientTries++;
              this.pausedUntil = Math.max(this.pausedUntil, clock.monotonicMs() + delay);
              continue;
            }
          }
          return res;
        }
        // 시간 초과는 한 번만 다시 보낸다. 오프라인은 바로 알린다(일괄 받기는 오프라인이면 멈춤).
        if (res.kind === 'timeout' && networkTries < 1) {
          networkTries++;
          this.pausedUntil = Math.max(this.pausedUntil, clock.monotonicMs() + this.transientBackoffMs);
          continue;
        }
        return res;
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }
}

function invalid(message: string): { status: 'error'; kind: 'invalid_response'; message: string } {
  return { status: 'error', kind: 'invalid_response', message };
}

function isStr(v: unknown, max = 1024): v is string {
  return typeof v === 'string' && v.length <= max;
}

/** 외부 응답 레코드 검증. 형식이 맞지 않으면 null */
export function validateRecord(v: unknown): LrclibRecord | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const id = o['id'];
  const duration = o['duration'];
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) return null;
  if (!isStr(o['trackName']) || !isStr(o['artistName'])) return null;
  const album = o['albumName'];
  if (album !== null && album !== undefined && !isStr(album)) return null;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0 || duration > 36_000) return null;
  if (typeof o['instrumental'] !== 'boolean') return null;
  const plain = o['plainLyrics'];
  const synced = o['syncedLyrics'];
  if (plain !== null && plain !== undefined && !isStr(plain, MAX_LYRICS_CHARS)) return null;
  if (synced !== null && synced !== undefined && !isStr(synced, MAX_LYRICS_CHARS)) return null;
  return {
    id,
    trackName: o['trackName'],
    artistName: o['artistName'],
    albumName: typeof album === 'string' ? album : '',
    duration,
    instrumental: o['instrumental'],
    plainLyrics: typeof plain === 'string' ? plain : null,
    syncedLyrics: typeof synced === 'string' ? synced : null,
    hasWordSync: o['hasWordSync'] === true,
  };
}
