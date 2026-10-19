import type { ItunesCatalogClient } from '../catalog/itunes-catalog.js';
import { durationClose, isLyricsRecordCompatible, normalizeArtist, parseTitle } from '../matching/track-identity.js';
import type { LrclibClient, LrclibRecord } from './lrclib-client.js';
import {
  classifyLrclibRecord,
  type LyricsFetchResult,
  type LyricsProvider,
  type LyricsQuery,
} from './lyrics-provider.js';
import { isBestPossible, rankLyricsRecords, type RankingTrack } from './lyrics-ranking.js';

/**
 * 가사 자동 조회(LRCLIB). 한국 Apple Music은 일본 곡 제목·가수를 현지화해 보여 주므로
 * (예: マリーゴールド/あいみょん → Marigold/aimyon, 米津玄師 → 요네즈 켄시) 한 가지 표기로는 자주 못 찾는다.
 * iPhone·PC·Android(스토어 ID 없음) 모두 이 제공자를 쓴다.
 *
 * 후보 모으기
 * 1) Music 앱이 준 표기로 LRCLIB /api/get (LRCLIB가 제목·가수·길이 ±2초를 맞춰 줌 → 가수 확인된 후보)
 * 2) 못 찾았고 스토어 ID가 있으면 iTunes Lookup으로 jp·us·kr 표기를 얻어 각각 /api/get(찾으면 멈춤)
 * 3) 가수까지 맞는 후보를 찾았으면 그 표기(제목+가수)로 /api/search 한 번 더 → 같은 곡의 다른 업로드
 *    (싱크 여부·원문 문자·한국어 뜻·발음 포함 여부가 업로드마다 다르다)
 *    찾은 것 중 가장 나은 것이 아직 "싱크 + 원문"이 아니면(예: 로마자 싱크·시간 정보 없는 가사) 스토어 ID의
 *    다른 표기도 얻어 표기마다 제목+가수로 검색한다(다른 가수 표기로 올라온 싱크 원문을 찾기 위해).
 *    로마자가 원문이 아닌지는 곡 정보·같은 곡 후보에 가나가 있을 때만 알 수 있다(곡 언어 추정).
 * 4) 아무것도 못 찾았으면 제목으로 /api/search(표기별) — 길이 ±2초·버전 태그·제목이 맞는 레코드만
 * 고르기: rankLyricsRecords 순위(곡 일치 → 싱크 → 원문 → 한국어 뜻 → 발음, D-43)
 *    - 가수까지 맞는 후보(same)만 자동 적용
 *    - 가수 표기가 다른 후보(probable)뿐이면 자동 적용하지 않고 후보로 돌려 사용자 확인(불변조건 6)
 * 이보다 나을 수 없는 후보(같은 곡 + 싱크·원문·뜻·발음 모두)를 찾으면 바로 멈춘다.
 * 3)의 추가 검색이 요청 한도·오류로 실패하면 이미 찾은 후보로 정한다(찾은 가사를 잃지 않음).
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

type Failure = Extract<LyricsFetchResult, { status: 'rate_limited' } | { status: 'error' }>;

export class AppleMusicLyricsProvider implements LyricsProvider {
  readonly id = 'lrclib-apple-music';
  private readonly maxCandidates: number;

  constructor(private readonly opts: AppleMusicLyricsProviderOptions) {
    this.maxCandidates = opts.maxCandidates ?? 5;
  }

  async fetch(q: LyricsQuery): Promise<LyricsFetchResult> {
    const { lrclib } = this.opts;
    const variants: Variant[] = [{ title: q.title, artist: q.artist, album: q.album }];
    const pool = new Map<number, LrclibRecord>();
    const verified = new Set<number>();
    const track = (): RankingTrack => ({ variants, durationMs: q.durationMs, verifiedIds: verified });
    const ranked = () => rankLyricsRecords([...pool.values()], track()).filter((r) => r.match !== 'mismatch');
    const bestSame = () => ranked().find((r) => r.match === 'same') ?? null;
    /** 앞의 두 기준(싱크·원문)까지 갖춘 후보가 있으면 다른 표기까지 찾지 않는다 */
    const goodEnough = () => {
      const top = bestSame();
      return !!top && top.features.synced && top.features.hasOriginal;
    };
    const st: { fallback: LyricsFetchResult; matched: Variant | null } = {
      /** 끝까지 못 찾았을 때 돌려줄 결과(Music 앱 표기 조회 결과 기준) */
      fallback: { status: 'not_found', reason: 'no-record' },
      /** 가수까지 맞춘 표기(3단계 검색에 씀) */
      matched: null,
    };

    /** /api/get. 실패(요청 한도·오류)는 그대로 돌려준다. */
    const getExact = async (v: Variant): Promise<Failure | 'found' | 'none'> => {
      const res = await lrclib.get({
        trackName: v.title,
        artistName: v.artist,
        albumName: v.album,
        durationSec: q.durationMs == null ? null : q.durationMs / 1000,
      });
      if (res.status === 'rate_limited') return res;
      if (res.status === 'error') return { status: 'error', kind: res.kind, message: res.message };
      if (res.status === 'not_found') return 'none';
      const rec = res.record;
      const compatible = isLyricsRecordCompatible(
        { title: v.title, album: v.album, durationMs: q.durationMs },
        { trackName: rec.trackName, albumName: rec.albumName, durationSec: rec.duration },
      );
      const isFirst = v === variants[0];
      if (!compatible) {
        if (isFirst) st.fallback = { status: 'not_found', reason: 'incompatible-version' };
        return 'none';
      }
      if (!hasLyrics(rec)) {
        // 빈 레코드도 "가사 없음" 상태로 알린다(기존 분류와 같음)
        const c = classifyLrclibRecord(rec);
        if (isFirst && c.status !== 'found') st.fallback = c;
        return 'none';
      }
      pool.set(rec.id, rec);
      verified.add(rec.id);
      st.matched ??= v;
      return 'found';
    };

    const done = (): LyricsFetchResult | null => {
      const top = bestSame();
      return top && isBestPossible(top) ? classifyLrclibRecord(top.record, top.content) : null;
    };

    // 1) Music 앱 표기
    const first = await getExact(variants[0] as Variant);
    if (typeof first === 'object') return first;
    const early = done();
    if (early) return early;

    /** 스토어 ID로 다른 나라 표기를 모은다(한 번만). getEach면 표기마다 /api/get(찾으면 그 뒤로는 모으기만) */
    let looked = false;
    const lookupVariants = async (getEach: boolean): Promise<Failure | null> => {
      if (looked || !q.storeId || !this.opts.catalog) return null;
      looked = true;
      const res = await this.opts.catalog.lookup(q.storeId);
      if (res.status !== 'ok') return null;
      const seen = new Set(variants.map(variantKey));
      for (const t of res.variants) {
        // 길이가 크게 다르면 같은 녹음이 아닐 수 있으므로 쓰지 않는다
        if (durationClose(q.durationMs, t.durationMs) === false) continue;
        const v: Variant = { title: t.title, artist: t.artist, album: t.album };
        const k = variantKey(v);
        if (seen.has(k)) continue;
        seen.add(k);
        variants.push(v);
        if (!getEach || st.matched) continue; // 이미 찾았으면 표기만 모은다(가수 확인·검색용)
        const r = await getExact(v);
        if (typeof r === 'object') return r;
      }
      return null;
    };

    // 2) 못 찾았으면 다른 storefront 표기로 정확 조회
    if (first === 'none') {
      const failed = await lookupVariants(true);
      if (failed) return failed;
      const found = done();
      if (found) return found;
    }

    /** 검색 결과 중 이 곡일 수 있는 레코드(길이 ±2초·버전·제목)만 모은다 */
    const addSearch = (records: readonly LrclibRecord[]) => {
      for (const rec of records) {
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
    };

    let searchError: Extract<LyricsFetchResult, { status: 'error' }> | null = null;
    const mv = st.matched;
    if (mv) {
      // 3) 같은 곡의 다른 업로드 비교(검색이 실패해도 이미 찾은 후보로 정한다).
      //    가장 나은 것이 아직 싱크 원문이 아니면 다른 나라 표기로도 검색한다.
      const searched = new Set<string>();
      const searchAs = async (v: Variant) => {
        const k = variantKey(v);
        if (searched.has(k)) return;
        searched.add(k);
        const res = await lrclib.search({ trackName: v.title, artistName: v.artist });
        if (res.status === 'ok') addSearch(res.records);
      };
      await searchAs(mv);
      if (!goodEnough()) {
        await lookupVariants(false);
        for (const v of [...variants]) {
          if (goodEnough()) break;
          await searchAs(v);
        }
      }
    } else {
      // 4) 제목 검색
      const titles = [...new Map(variants.map((v) => [parseTitle(v.title).core, v])).values()];
      for (const v of titles) {
        const res = await lrclib.search({ trackName: v.title });
        if (res.status === 'rate_limited') return res;
        if (res.status === 'error') {
          searchError = { status: 'error', kind: res.kind, message: res.message };
          break;
        }
        addSearch(res.records);
      }
    }

    const list = ranked();
    const sure = list.find((r) => r.match === 'same');
    if (sure) return classifyLrclibRecord(sure.record, sure.content);
    if (list.length > 0) {
      return {
        status: 'not_found',
        reason: 'no-record',
        candidates: list.slice(0, this.maxCandidates).map((r) => r.record),
      };
    }
    // 검색이 서버 오류로 끝났으면 "가사 없음"이 아니라 오류로 알린다(다시 받기에서 재시도되도록, D-33)
    if (searchError) return searchError;
    return st.fallback;
  }
}
