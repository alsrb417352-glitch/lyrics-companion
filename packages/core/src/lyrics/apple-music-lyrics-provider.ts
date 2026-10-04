import type { ItunesCatalogClient } from '../catalog/itunes-catalog.js';
import { durationClose, isLyricsRecordCompatible, normalizeArtist, parseTitle } from '../matching/track-identity.js';
import type { LrclibClient, LrclibRecord } from './lrclib-client.js';
import {
  classifyLrclibRecord,
  LrclibLyricsProvider,
  type LyricsFetchResult,
  type LyricsProvider,
  type LyricsQuery,
} from './lyrics-provider.js';

/**
 * Apple Music 곡용 가사 조회(LRCLIB). 한국 Apple Music은 일본 곡 제목·가수를 현지화해 보여 주므로
 * (예: マリーゴールド/あいみょん → Marigold/aimyon, 米津玄師 → 요네즈 켄시) 한 가지 표기로는 자주 못 찾는다.
 *
 * 순서
 * 1) Music 앱이 준 표기로 LRCLIB /api/get (길이 ±2초는 LRCLIB가 확인)
 * 2) 스토어 ID가 있으면 iTunes Lookup으로 jp·us·kr 표기를 얻어 각각 /api/get
 * 3) 그래도 없으면 제목으로 /api/search → 버전 태그·제목·길이(±2초)가 맞는 레코드만 남김
 *    - 가수 표기까지 알려진 표기 중 하나와 같으면 자동 적용
 *    - 가수가 다르면(다른 표기일 수도, 다른 곡일 수도 있음) 자동 적용하지 않고 후보로 돌려 사용자 확인(불변조건 6)
 */
export interface AppleMusicLyricsProviderOptions {
  lrclib: LrclibClient;
  catalog: ItunesCatalogClient | null;
  /** 사용자에게 보일 후보 최대 개수 */
  maxCandidates?: number;
}

interface Variant {
  title: string;
  artist: string;
  album: string | null;
}

function variantKey(v: Variant): string {
  return `${parseTitle(v.title).core}\u0000${normalizeArtist(v.artist)}`;
}

function hasLyrics(r: LrclibRecord): boolean {
  return r.instrumental || !!r.syncedLyrics?.trim() || !!r.plainLyrics?.trim();
}

/** 후보 정렬: 싱크 가사 우선, 길이 차이 작은 순 */
function rank(records: LrclibRecord[], durationMs: number | null): LrclibRecord[] {
  const diff = (r: LrclibRecord) => (durationMs == null ? 0 : Math.abs(r.duration * 1000 - durationMs));
  return [...records].sort((a, b) => {
    const sa = a.syncedLyrics ? 0 : 1;
    const sb = b.syncedLyrics ? 0 : 1;
    return sa - sb || diff(a) - diff(b) || a.id - b.id;
  });
}

export class AppleMusicLyricsProvider implements LyricsProvider {
  readonly id = 'lrclib-apple-music';
  private readonly direct: LrclibLyricsProvider;
  private readonly maxCandidates: number;

  constructor(private readonly opts: AppleMusicLyricsProviderOptions) {
    this.direct = new LrclibLyricsProvider(opts.lrclib);
    this.maxCandidates = opts.maxCandidates ?? 5;
  }

  async fetch(q: LyricsQuery): Promise<LyricsFetchResult> {
    // 1) Music 앱 표기
    const first = await this.direct.fetch(q);
    if (first.status !== 'not_found') return first;

    // 2) 다른 storefront 표기
    const variants: Variant[] = [{ title: q.title, artist: q.artist, album: q.album }];
    if (q.storeId && this.opts.catalog) {
      const looked = await this.opts.catalog.lookup(q.storeId);
      if (looked.status === 'ok') {
        const seen = new Set(variants.map(variantKey));
        for (const t of looked.variants) {
          // 길이가 크게 다르면 같은 녹음이 아닐 수 있으므로 쓰지 않는다
          if (durationClose(q.durationMs, t.durationMs) === false) continue;
          const v: Variant = { title: t.title, artist: t.artist, album: t.album };
          const k = variantKey(v);
          if (seen.has(k)) continue;
          seen.add(k);
          variants.push(v);
          const r = await this.direct.fetch({ ...v, durationMs: q.durationMs });
          if (r.status !== 'not_found') return r;
        }
      }
    }

    // 3) 제목 검색
    const knownArtists = new Set(variants.map((v) => normalizeArtist(v.artist)));
    const titles = [...new Map(variants.map((v) => [parseTitle(v.title).core, v])).values()];
    const pool = new Map<number, LrclibRecord>();
    for (const v of titles) {
      const res = await this.opts.lrclib.search({ trackName: v.title });
      if (res.status === 'rate_limited') return res;
      if (res.status === 'error') break;
      for (const rec of res.records) {
        if (!hasLyrics(rec)) continue;
        if (durationClose(q.durationMs, Math.round(rec.duration * 1000)) !== true) continue;
        const ok = variants.some((x) =>
          isLyricsRecordCompatible(
            { title: x.title, album: x.album, durationMs: q.durationMs },
            { trackName: rec.trackName, albumName: rec.albumName, durationSec: rec.duration },
          ),
        );
        if (ok) pool.set(rec.id, rec);
      }
    }
    const ranked = rank([...pool.values()], q.durationMs);
    const sure = ranked.find((r) => knownArtists.has(normalizeArtist(r.artistName)));
    if (sure) return classifyLrclibRecord(sure);
    if (ranked.length > 0) {
      return { status: 'not_found', reason: 'no-record', candidates: ranked.slice(0, this.maxCandidates) };
    }
    return first;
  }
}
