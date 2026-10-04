import { HttpError, type Clock, type HttpClient } from '../ports.js';

/**
 * Apple Music 곡 검색(iTunes Search API, 키 불필요).
 * 목적: iOS에서 우리 앱 안에서 곡을 고르고, 그 스토어 ID로 Music 앱 재생 대기열을 설정한다
 * (MPMusicPlayerController.setQueue(with: storeIDs)). Apple Music API(개발자 토큰·유료 개발자 계정)를 쓰지 않는다.
 *
 * 확인한 사실(2026-10-04, 클라우드에서 직접 호출):
 * - country=kr 은 결과 0건, country=jp 는 결과 있음 → 저장소(storefront)를 순서대로 시도한다.
 * - Content-Type이 application/json이 아니라 text/javascript 이다.
 * 미확인: 다른 storefront의 스토어 ID로 한국 계정에서 재생되는지(MV-PB-IOS-03).
 *
 * 응답은 불신 데이터: 크기·형식을 검증하고, 필요한 필드만 꺼낸다.
 */

export interface CatalogTrack {
  /** Apple Music 스토어 ID(trackId) */
  storeId: string;
  title: string;
  artist: string;
  album: string | null;
  durationMs: number | null;
  artworkUrl: string | null;
  /** 검색에 성공한 storefront(국가 코드) */
  storefront: string;
}

export type CatalogLookupResult =
  | { status: 'ok'; variants: CatalogTrack[] }
  | { status: 'error'; kind: 'offline' | 'timeout' | 'rate_limited' | 'server' | 'invalid_response' | 'bad_request' };

export type CatalogSearchResult =
  | { status: 'ok'; tracks: CatalogTrack[] }
  | { status: 'error'; kind: 'offline' | 'timeout' | 'rate_limited' | 'server' | 'invalid_response' | 'bad_request' };

export interface ItunesCatalogOptions {
  http: HttpClient;
  clock: Clock;
  /** 검색에 시도할 storefront 순서. 기본 ['kr', 'jp', 'us'] */
  storefronts?: readonly string[];
  /**
   * 스토어 ID로 다른 표기를 조회할 storefront. 기본 ['jp', 'us', 'kr'].
   * 한국 Apple Music은 일본 곡 제목·가수를 한글·영문으로 바꿔 표시한다(예: 米津玄師 → 요네즈 켄시,
   * マリーゴールド → Marigold, 2026-10-04 확인). LRCLIB 레코드는 원어·영문·한글 표기가 섞여 있어 여러 표기로 찾는다.
   */
  lookupStorefronts?: readonly string[];
  limit?: number;
  timeoutMs?: number;
  /** 요청 간 최소 간격(공개 API 예절). 기본 1000ms */
  minIntervalMs?: number;
}

const MAX_BODY_CHARS = 1024 * 1024;
const STOREFRONT = /^[a-z]{2}$/;

function isStr(v: unknown, max = 512): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

/** 검색 응답 한 건 검증. 곡(song)이 아니거나 필수 필드가 없으면 null */
export function parseCatalogItem(v: unknown, storefront: string): CatalogTrack | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o['kind'] !== 'song' || o['wrapperType'] !== 'track') return null;
  const id = o['trackId'];
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return null;
  const title = o['trackName'];
  const artist = o['artistName'];
  if (!isStr(title) || !isStr(artist)) return null;
  const album = isStr(o['collectionName']) ? o['collectionName'] : null;
  const ms = o['trackTimeMillis'];
  const durationMs =
    typeof ms === 'number' && Number.isFinite(ms) && ms > 0 && ms < 4 * 3600_000 ? Math.round(ms) : null;
  const art = o['artworkUrl100'];
  const artworkUrl = isStr(art, 2048) && art.startsWith('https://') ? art : null;
  return { storeId: String(id), title, artist, album, durationMs, artworkUrl, storefront };
}

/** 응답 본문 전체 검증. 형식이 틀리면 null */
export function parseCatalogResponse(bodyText: string, storefront: string): CatalogTrack[] | null {
  if (bodyText.length > MAX_BODY_CHARS) return null;
  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null) return null;
  const results = (json as Record<string, unknown>)['results'];
  if (!Array.isArray(results)) return null;
  const out: CatalogTrack[] = [];
  const seen = new Set<string>();
  for (const item of results.slice(0, 100)) {
    const t = parseCatalogItem(item, storefront);
    if (t && !seen.has(t.storeId)) {
      seen.add(t.storeId);
      out.push(t);
    }
  }
  return out;
}

export class ItunesCatalogClient {
  private readonly storefronts: readonly string[];
  private readonly lookupStorefronts: readonly string[];
  private readonly limit: number;
  private readonly timeoutMs: number;
  private readonly minIntervalMs: number;
  private nextAllowedAt = 0;

  constructor(private readonly opts: ItunesCatalogOptions) {
    const fronts = opts.storefronts ?? ['kr', 'jp', 'us'];
    if (fronts.length === 0 || !fronts.every((s) => STOREFRONT.test(s))) throw new Error('잘못된 storefront');
    this.storefronts = fronts;
    const lookups = opts.lookupStorefronts ?? ['jp', 'us', 'kr'];
    if (!lookups.every((x) => STOREFRONT.test(x))) throw new Error('잘못된 storefront');
    this.lookupStorefronts = lookups;
    this.limit = Math.max(1, Math.min(opts.limit ?? 25, 50));
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.minIntervalMs = opts.minIntervalMs ?? 1000;
  }

  /** 첫 결과가 있는 storefront의 결과를 반환한다. 모두 0건이면 빈 목록. */
  async search(term: string): Promise<CatalogSearchResult> {
    const q = term.trim();
    if (q.length === 0 || q.length > 200) return { status: 'error', kind: 'bad_request' };
    for (const front of this.storefronts) {
      const r = await this.searchIn(q, front);
      if (r.status === 'error') return r;
      if (r.tracks.length > 0) return r;
    }
    return { status: 'ok', tracks: [] };
  }

  /**
   * 스토어 ID의 storefront별 표기(제목·가수·앨범·길이). 같은 표기는 하나로 합친다.
   * 일부 storefront가 실패해도 얻은 결과는 반환한다. 모두 실패하면 첫 오류를 반환한다.
   */
  async lookup(storeId: string): Promise<CatalogLookupResult> {
    if (!/^[0-9]{1,20}$/.test(storeId)) return { status: 'error', kind: 'bad_request' };
    const variants: CatalogTrack[] = [];
    const seen = new Set<string>();
    let firstError: CatalogLookupResult | null = null;
    for (const front of this.lookupStorefronts) {
      const r = await this.request(`https://itunes.apple.com/lookup?id=${storeId}&country=${front}&entity=song`, front);
      if (r.status === 'error') {
        firstError ??= r;
        if (r.kind === 'rate_limited' || r.kind === 'offline') break;
        continue;
      }
      for (const t of r.tracks) {
        if (t.storeId !== storeId) continue;
        const key = `${t.title}\u0000${t.artist}`;
        if (!seen.has(key)) {
          seen.add(key);
          variants.push(t);
        }
      }
    }
    if (variants.length === 0 && firstError) return firstError;
    return { status: 'ok', variants };
  }

  private searchIn(term: string, storefront: string): Promise<CatalogSearchResult> {
    const qs = [
      ['term', term],
      ['country', storefront],
      ['media', 'music'],
      ['entity', 'song'],
      ['limit', String(this.limit)],
    ]
      .map(([k, v]) => `${encodeURIComponent(k ?? '')}=${encodeURIComponent(v ?? '')}`)
      .join('&');
    return this.request(`https://itunes.apple.com/search?${qs}`, storefront);
  }

  private async request(url: string, storefront: string): Promise<CatalogSearchResult> {
    const { clock, http } = this.opts;
    const wait = this.nextAllowedAt - clock.monotonicMs();
    if (wait > 0) await clock.sleep(wait);
    try {
      const res = await http.send({
        url,
        method: 'GET',
        headers: { Accept: 'application/json, text/javascript' },
        timeoutMs: this.timeoutMs,
      });
      if (res.status === 429 || res.status === 403) return { status: 'error', kind: 'rate_limited' };
      if (res.status !== 200) return { status: 'error', kind: 'server' };
      const tracks = parseCatalogResponse(res.bodyText, storefront);
      if (!tracks) return { status: 'error', kind: 'invalid_response' };
      return { status: 'ok', tracks };
    } catch (e) {
      if (e instanceof HttpError) {
        return {
          status: 'error',
          kind: e.kind === 'offline' ? 'offline' : e.kind === 'timeout' ? 'timeout' : 'server',
        };
      }
      return { status: 'error', kind: 'server' };
    } finally {
      this.nextAllowedAt = clock.monotonicMs() + this.minIntervalMs;
    }
  }
}
