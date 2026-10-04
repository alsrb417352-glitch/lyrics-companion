import { HttpError, type Clock, type HttpClient, type HttpResponse } from '../ports.js';

/**
 * LRCLIB API 클라이언트 (https://lrclib.net/docs, 2026-10-04 확인).
 * - 클라이언트 식별 헤더(User-Agent, 대체 헤더 Lrclib-Client)를 보낸다.
 * - 요청은 순차 처리하고 요청 간 최소 간격을 둔다(문서 권장 200–500ms).
 * - 429/503의 Retry-After를 지킨다. 대기 시간 동안은 네트워크 요청 없이 rate_limited를 반환한다.
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
  private nextAllowedAt = 0;
  private blockedUntil = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: LrclibClientOptions) {
    this.baseUrl = (opts.baseUrl ?? 'https://lrclib.net').replace(/\/+$/, '');
    if (!this.baseUrl.startsWith('https://')) throw new Error('LRCLIB baseUrl은 https여야 합니다');
    this.minIntervalMs = opts.minIntervalMs ?? 300;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxBodyChars = opts.maxBodyChars ?? 2 * 1024 * 1024;
    this.defaultRetryAfterMs = opts.defaultRetryAfterMs ?? 60_000;
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
    if (r.status === 429 || r.status === 503) {
      const retryAfterMs = this.parseRetryAfter(r.headers['retry-after']);
      this.blockedUntil = this.opts.clock.monotonicMs() + retryAfterMs;
      if (r.status === 429) return { status: 'rate_limited', retryAfterMs };
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

  /** 순차 큐 + 최소 간격 + Retry-After 차단을 적용한 요청 */
  private request(
    path: string,
    params: Record<string, string>,
  ): Promise<
    | { response: HttpResponse }
    | { status: 'rate_limited'; retryAfterMs: number }
    | { status: 'error'; kind: LrclibErrorKind; message: string }
  > {
    const run = async () => {
      const clock = this.opts.clock;
      const now = clock.monotonicMs();
      if (now < this.blockedUntil) {
        return { status: 'rate_limited' as const, retryAfterMs: this.blockedUntil - now };
      }
      const wait = this.nextAllowedAt - now;
      if (wait > 0) await clock.sleep(wait);
      const qs = Object.entries(params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
      const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;
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
