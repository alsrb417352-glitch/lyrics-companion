import { durationClose, isLyricsRecordCompatible, normalizeArtist, parseTitle } from '../matching/track-identity.js';
import { hasHangul, hasJapaneseScript, hasKana } from '../util/text.js';
import { embeddedCoverage, splitEmbeddedKorean, type EmbeddedKorean } from './embedded-korean.js';
import { parseLrc, parsePlainLyrics, type TimedText } from './lrc.js';
import type { LrclibRecord } from './lrclib-client.js';

/**
 * 가사 후보 순위 (docs/plan.md D-43, 2026-10-19 사용자 결정).
 *
 *  1. 재생 중인 곡과 맞는지(최우선)
 *     same     = 제목·녹음 버전·길이(±2초)가 맞고 가수도 확인됨(알려진 가수 표기 또는 LRCLIB /api/get이 가수까지 맞춤)
 *     probable = 제목·버전·길이는 맞지만 가수 표기가 다름 → 자동 적용하지 않고 사용자에게 후보로 보임(불변조건 6)
 *     mismatch = 제목·버전·길이 중 하나라도 다름 → 자동 적용·후보 모두 제외(직접 검색 목록에서는 맨 아래)
 *  2. 곡이 맞는 후보끼리: 싱크 가사 → 원문 가사 → 한국어 뜻 → 한글 발음 순서로 "있는 것"을 앞에
 *  3. 그래도 같으면 다른 언어 줄(로마자·외국어 번역)이 원문 줄과 번갈아 끼어 있지 않은 것
 *     → 길이 차이가 작은 것 → 레코드 ID가 작은 것(먼저 올라온 것)
 *
 * "원문 가사"는 곡의 원래 언어 문자로 된 가사다. 일본어 곡이면 가나·한자 줄이 있어야 하고
 * (로마자만·한국어만 있는 가사는 원문 없음), 한국어 곡이면 한글, 그 밖에는 한글이 아닌 글자다.
 * 곡의 언어는 곡 정보(가나 포함 여부)와 곡이 맞는 후보들의 내용으로 추정한다.
 * "한국어 뜻·발음"은 가사 안에 원문과 번갈아 들어 있는 한국어 줄이다(splitEmbeddedKorean으로 나눌 수 있을 때만).
 */

export type LyricsMatchLevel = 'same' | 'probable' | 'mismatch';

export interface LyricsRecordFeatures {
  synced: boolean;
  hasOriginal: boolean;
  hasMeaning: boolean;
  hasPronunciation: boolean;
  instrumental: boolean;
}

/** 레코드 내용 해석(곡 정보와 무관). 가사 저장(classifyLrclibRecord)과 순위가 같은 해석을 쓴다. */
export interface LrclibRecordContent {
  kind: 'synced' | 'plain' | 'instrumental' | 'empty' | 'invalid';
  /** kind=synced: 원문 줄(한국어 줄을 나눴으면 뺀 결과) */
  timed: TimedText[];
  /** kind=plain: 원문 줄 */
  plain: string[];
  embedded: EmbeddedKorean | null;
  hadWordTimings: boolean;
  /** 싱크 가사가 있었지만 형식이 틀려 일반 가사를 씀 */
  invalidSynced: boolean;
  /** 곡 전체에 한국어 뜻·발음이 있는지 */
  meaning: boolean;
  pronunciation: boolean;
  /** 원문 줄 글자 체계(줄 수) */
  stats: { lettered: number; japanese: number; kana: number; korean: number; other: number };
  /** 일본어 줄마다 다른 글자(로마자·외국어 번역) 줄이 번갈아 붙어 있음 — 같은 조건이면 뒤로 */
  foreignInterleaved: boolean;
}

const LETTER = /\p{L}/u;

function statsOf(texts: readonly string[]): LrclibRecordContent['stats'] {
  const s = { lettered: 0, japanese: 0, kana: 0, korean: 0, other: 0 };
  for (const t of texts) {
    if (!LETTER.test(t)) continue;
    s.lettered++;
    if (hasJapaneseScript(t)) {
      s.japanese++;
      if (hasKana(t)) s.kana++;
    } else if (hasHangul(t)) s.korean++;
    else s.other++;
  }
  return s;
}

/** 일본어 줄과 한글이 아닌 다른 글자 줄이 번갈아 나오는지(예: 원문/베트남어 번역, 원문/로마자) */
function isForeignInterleaved(texts: readonly string[]): boolean {
  const kinds = texts
    .filter((t) => LETTER.test(t))
    .map((t) => (hasJapaneseScript(t) ? 'ja' : hasHangul(t) ? 'ko' : 'other'));
  const ja = kinds.filter((k) => k === 'ja').length;
  const others = kinds.flatMap((k, i) => (k === 'other' ? [i] : []));
  if (ja < 4 || others.length < ja * 0.5) return false;
  const nextToJa = others.filter((i) => kinds[i - 1] === 'ja' || kinds[i + 1] === 'ja').length;
  return nextToJa >= others.length * 0.8;
}

export function readLrclibRecord(rec: LrclibRecord): LrclibRecordContent {
  const base: LrclibRecordContent = {
    kind: 'empty',
    timed: [],
    plain: [],
    embedded: null,
    hadWordTimings: false,
    invalidSynced: false,
    meaning: false,
    pronunciation: false,
    stats: { lettered: 0, japanese: 0, kana: 0, korean: 0, other: 0 },
    foreignInterleaved: false,
  };
  if (rec.instrumental) return { ...base, kind: 'instrumental' };
  if (rec.syncedLyrics && rec.syncedLyrics.trim() !== '') {
    const parsed = parseLrc(rec.syncedLyrics);
    if (parsed.ok) {
      const split = splitEmbeddedKorean(parsed.lines, 'keep');
      const cov = embeddedCoverage(split.lines, split.embedded);
      return {
        ...base,
        kind: 'synced',
        timed: split.lines,
        embedded: split.embedded,
        hadWordTimings: parsed.hadWordTimings || rec.hasWordSync,
        meaning: cov.meaning,
        pronunciation: cov.pronunciation,
        stats: statsOf(split.lines.map((l) => l.text)),
        foreignInterleaved: isForeignInterleaved(split.lines.map((l) => l.text)),
      };
    }
    base.invalidSynced = true;
  }
  if (rec.plainLyrics && rec.plainLyrics.trim() !== '') {
    const split = splitEmbeddedKorean(
      parsePlainLyrics(rec.plainLyrics).map((text) => ({ text })),
      'stanza',
    );
    const cov = embeddedCoverage(split.lines, split.embedded);
    const plain = split.lines.map((l) => l.text);
    return {
      ...base,
      kind: 'plain',
      plain,
      embedded: split.embedded,
      meaning: cov.meaning,
      pronunciation: cov.pronunciation,
      stats: statsOf(plain),
      foreignInterleaved: isForeignInterleaved(plain),
    };
  }
  return { ...base, kind: base.invalidSynced ? 'invalid' : 'empty' };
}

export type SongScript = 'ja' | 'ko' | 'other';

/** 곡의 원래 언어 문자 추정: 곡 정보에 가나가 있거나 곡이 맞는 후보 중 일본어 가사가 있으면 일본어 */
export function inferSongScript(contents: readonly LrclibRecordContent[], hints: readonly string[]): SongScript {
  if (hints.some((h) => hasKana(h))) return 'ja';
  if (contents.some((c) => c.stats.kana > 0 && c.stats.japanese >= (c.stats.japanese + c.stats.other) * 0.5)) {
    return 'ja';
  }
  const withText = contents.filter((c) => c.stats.lettered > 0);
  const korean = withText.filter((c) => c.stats.korean >= c.stats.lettered * 0.5);
  if (withText.length > 0 && korean.length * 2 > withText.length) return 'ko';
  return 'other';
}

export function hasOriginalLyrics(c: LrclibRecordContent, script: SongScript): boolean {
  const s = c.stats;
  if (s.lettered === 0) return false;
  if (script === 'ja') return s.japanese >= 1 && s.japanese >= (s.japanese + s.other) * 0.2;
  if (script === 'ko') return s.korean >= s.lettered * 0.5;
  const nonKorean = s.lettered - s.korean;
  return nonKorean >= 1 && nonKorean >= s.lettered * 0.5;
}

export interface RankingTrack {
  /** 같은 곡의 표기들(Music 앱 표기, 다른 나라 스토어 표기 등) */
  variants: ReadonlyArray<{ title: string; artist: string; album: string | null }>;
  durationMs: number | null;
  /** 가수까지 맞춰 찾은 레코드(LRCLIB /api/get 결과) */
  verifiedIds?: ReadonlySet<number>;
}

export interface RankedLyricsRecord {
  record: LrclibRecord;
  match: LyricsMatchLevel;
  features: LyricsRecordFeatures;
  /** 곡 길이와의 차이(ms). 모르면 null */
  durationDiffMs: number | null;
  content: LrclibRecordContent;
}

export function matchLevel(rec: LrclibRecord, track: RankingTrack): LyricsMatchLevel {
  const compatible = track.variants.some((v) =>
    isLyricsRecordCompatible(
      { title: v.title, album: v.album, durationMs: track.durationMs },
      { trackName: rec.trackName, albumName: rec.albumName, durationSec: rec.duration },
    ),
  );
  if (!compatible) return 'mismatch';
  if (durationClose(track.durationMs, Math.round(rec.duration * 1000)) === false) return 'mismatch';
  const known = new Set(track.variants.map((v) => normalizeArtist(v.artist)));
  if (track.verifiedIds?.has(rec.id) || known.has(normalizeArtist(rec.artistName))) return 'same';
  return 'probable';
}

const MATCH_ORDER: Record<LyricsMatchLevel, number> = { same: 0, probable: 1, mismatch: 2 };

/** 순위 비교(음수면 a가 앞). 1) 곡 일치 2) 싱크 3) 원문 4) 한국어 뜻 5) 발음 6) 다른 언어 줄 없음 7) 길이 차이 8) ID */
export function compareRanked(a: RankedLyricsRecord, b: RankedLyricsRecord, wantsInstrumental = false): number {
  const flag = (x: boolean) => (x ? 0 : 1);
  return (
    MATCH_ORDER[a.match] - MATCH_ORDER[b.match] ||
    (wantsInstrumental ? flag(a.features.instrumental) - flag(b.features.instrumental) : 0) ||
    flag(a.features.synced) - flag(b.features.synced) ||
    flag(a.features.hasOriginal) - flag(b.features.hasOriginal) ||
    flag(a.features.hasMeaning) - flag(b.features.hasMeaning) ||
    flag(a.features.hasPronunciation) - flag(b.features.hasPronunciation) ||
    flag(!a.content.foreignInterleaved) - flag(!b.content.foreignInterleaved) ||
    (a.durationDiffMs ?? 0) - (b.durationDiffMs ?? 0) ||
    a.record.id - b.record.id
  );
}

/** 후보를 순위대로 정렬한다(같은 ID는 하나만). 가사 내용 해석 결과(content)를 함께 돌려준다. */
export function rankLyricsRecords(records: readonly LrclibRecord[], track: RankingTrack): RankedLyricsRecord[] {
  const unique = [...new Map(records.map((r) => [r.id, r])).values()];
  const rows = unique.map((record) => {
    const content = readLrclibRecord(record);
    const match = matchLevel(record, track);
    const durationDiffMs =
      track.durationMs == null ? null : Math.abs(Math.round(record.duration * 1000) - track.durationMs);
    return { record, match, content, durationDiffMs };
  });
  const hints = track.variants.flatMap((v) => [v.title, v.artist]);
  const script = inferSongScript(
    rows.filter((r) => r.match !== 'mismatch').map((r) => r.content),
    hints,
  );
  const wantsInstrumental = track.variants.some((v) =>
    parseTitle(v.title, v.album).versionTags.includes('instrumental'),
  );
  const ranked: RankedLyricsRecord[] = rows.map((r) => ({
    ...r,
    features: {
      synced: r.content.kind === 'synced',
      hasOriginal: hasOriginalLyrics(r.content, script),
      hasMeaning: r.content.meaning,
      hasPronunciation: r.content.pronunciation,
      instrumental: r.content.kind === 'instrumental',
    },
  }));
  return ranked.sort((a, b) => compareRanked(a, b, wantsInstrumental));
}

/** 이보다 나은 후보가 있을 수 없는 경우(같은 곡 + 네 가지 모두 있음) — 더 조회하지 않아도 된다 */
export function isBestPossible(r: RankedLyricsRecord): boolean {
  const f = r.features;
  return r.match === 'same' && f.synced && f.hasOriginal && f.hasMeaning && f.hasPronunciation;
}

/** 가사 고르기 화면 한 줄 설명(iPhone·PC 공통 문구) */
export interface LyricsCandidateSummary {
  /** 예: "싱크 가사 · 원문 · 한국어 뜻 · 한글 발음" */
  features: string;
  /** 곡이 다를 수 있다는 경고(없으면 null) */
  warning: string | null;
  /** 첫 원문 줄(한국어 줄을 나눈 뒤) */
  preview: string;
}

export function summarizeLyricsCandidate(r: RankedLyricsRecord, durationMs: number | null): LyricsCandidateSummary {
  const f = r.features;
  const parts: string[] = [];
  if (f.instrumental) parts.push('연주곡');
  else {
    parts.push(f.synced ? '싱크 가사' : '시간 정보 없음');
    parts.push(f.hasOriginal ? '원문' : '원문 없음(로마자·번역만)');
    if (f.hasMeaning) parts.push('한국어 뜻');
    if (f.hasPronunciation) parts.push('한글 발음');
  }
  const diffSec = durationMs == null ? null : Math.round(r.record.duration - durationMs / 1000);
  let warning: string | null = null;
  if (diffSec !== null && Math.abs(diffSec) > 2) {
    warning = `재생 중인 곡과 길이가 ${diffSec > 0 ? '+' : ''}${diffSec}초 달라요 — 다른 버전일 수 있어 싱크가 어긋날 수 있습니다`;
  } else if (r.match === 'mismatch') {
    warning = '제목·버전 표기가 지금 곡과 달라요 — 다른 곡이나 다른 버전일 수 있습니다';
  } else if (r.match === 'probable') {
    warning = '가수 표기가 달라요 — 지금 듣는 곡이 맞는지 확인해 주세요';
  }
  const c = r.content;
  const lines = c.kind === 'synced' ? c.timed.map((l) => l.text) : c.plain;
  const preview = f.instrumental ? '연주곡' : (lines.find((l) => l.trim() !== '') ?? '');
  return { features: parts.join(' · '), warning, preview };
}
