import type { ServiceTrackRef } from '../ports.js';
import type { Song } from '../model.js';

/**
 * 곡 식별 규칙(보수적).
 * - 제목만으로 같은 곡이라고 판단하지 않는다.
 * - 녹음 버전 태그(live, remix 등)가 다르면 절대 같은 곡으로 보지 않는다.
 * - 자동 연결은 (1) 같은 서비스의 같은 곡 ID, (2) ISRC 일치 + 재생 길이 ±2초 + 버전 태그 일치일 때만 한다.
 * - 메타데이터(제목·아티스트·길이)만 일치하면 후보로만 제시하고 사용자 확인을 받는다.
 */

export const DURATION_TOLERANCE_MS = 2000;

const VERSION_PATTERNS: Array<[RegExp, string]> = [
  [/\blive\b|ライブ|라이브/i, 'live'],
  [/\bre-?mix\b|リミックス|리믹스/i, 'remix'],
  [/\bacoustic\b|アコースティック|어쿠스틱/i, 'acoustic'],
  [/\b(instrumental|inst\.?|off\s*vocal|karaoke)\b|オフボーカル|カラオケ|インスト/i, 'instrumental'],
  [/\btv\s*(size|ver\.?|version|edit)\b|tvサイズ/i, 'tv-size'],
  [/\bradio\s*edit\b|\bedit\b/i, 'edit'],
  [/\bextended\b/i, 'extended'],
  [/\bdemo\b/i, 'demo'],
  [/\bcover\b|カバー/i, 'cover'],
  [/\b(sped\s*up|slowed|nightcore)\b/i, 'speed'],
  [/\b(re-?recorded|taylor'?s\s+version)\b/i, 'rerecord'],
  [/\borchestra(l)?\b|オーケストラ/i, 'orchestral'],
  [/\bunplugged\b/i, 'unplugged'],
  [/\b(self-?cover)\b|セルフカバー/i, 'cover'],
];

/** 버전 정보로 보지 않는 괄호 내용(같은 녹음으로 취급) */
const NEUTRAL_PATTERNS = [/\bremaster(ed)?\b|リマスター/i, /\b(feat\.?|ft\.?|featuring)\b/i, /\bexplicit\b|\bclean\b/i];

/** 언어 버전 등 "ver." 표기 */
const VER_PATTERN = /([\p{L}\p{N}]+)\s*(ver\.?|version|バージョン)/iu;

export interface ParsedTitle {
  /** 비교용 핵심 제목(정규화, 버전 괄호 제거) */
  core: string;
  versionTags: string[];
}

export function normalizeForCompare(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’“”'"`´]/g, '')
    .replace(/[~〜～・·•\-–—_/\\.,!?！？:;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 제목(필요하면 앨범명 포함)에서 버전 태그를 추출한다. */
export function parseTitle(title: string, album?: string | null): ParsedTitle {
  const tags = new Set<string>();
  const nfkc = title.normalize('NFKC');
  const groups: string[] = [];
  // 괄호·대시 뒤 부가 정보 수집
  let core = nfkc.replace(/[([{【「『]([^)\]}】」』]*)[)\]}】」』]/g, (_m, inner: string) => {
    groups.push(inner);
    return ' ';
  });
  const dash = /\s[-–—]\s(.+)$/.exec(core);
  if (dash && dash[1]) {
    groups.push(dash[1]);
    core = core.slice(0, dash.index);
  }
  for (const g of groups) {
    let recognized = false;
    for (const [re, tag] of VERSION_PATTERNS) {
      if (re.test(g)) {
        tags.add(tag);
        recognized = true;
      }
    }
    const ver = VER_PATTERN.exec(g);
    if (ver && ver[1] && !/^tv$/i.test(ver[1])) {
      tags.add(`version:${normalizeForCompare(ver[1])}`);
      recognized = true;
    }
    if (!recognized && !NEUTRAL_PATTERNS.some((re) => re.test(g))) {
      // 알 수 없는 괄호 내용은 제목의 일부로 남겨 보수적으로 비교한다.
      core += ` ${g}`;
    }
  }
  // 제목 본문 단어("Live Forever")는 버전 태그로 보지 않는다. 앨범명의 live는 녹음 버전 신호로 사용한다.
  if (album && /\blive\b|ライブ/i.test(album.normalize('NFKC'))) tags.add('live');
  return { core: normalizeForCompare(core), versionTags: [...tags].sort() };
}

export function normalizeArtist(artist: string): string {
  return normalizeForCompare(artist.replace(/\s*(feat\.?|ft\.?|featuring)\s.*$/i, ''));
}

export function sameVersionTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

export function durationClose(a: number | null, b: number | null): boolean | null {
  if (a == null || b == null) return null;
  return Math.abs(a - b) <= DURATION_TOLERANCE_MS;
}

/** 서비스 곡 ID가 없을 때 쓰는 메타데이터 지문(같은 서비스 안에서만 사용) */
export function metadataFingerprint(ref: ServiceTrackRef): string {
  const t = parseTitle(ref.title, ref.album);
  const dur = ref.durationMs == null ? 'na' : String(Math.round(ref.durationMs / 1000));
  return [
    'fp',
    t.core,
    t.versionTags.join('+'),
    normalizeArtist(ref.artist),
    normalizeForCompare(ref.album ?? ''),
    dur,
  ].join('|');
}

export function serviceKeyOf(ref: ServiceTrackRef): string {
  return ref.serviceTrackId && ref.serviceTrackId.trim() !== ''
    ? `id:${ref.serviceTrackId.trim()}`
    : metadataFingerprint(ref);
}

export interface MatchCandidate {
  song: Song;
  reasons: string[];
}

export type MatchDecision =
  | { kind: 'auto-link'; song: Song; reason: 'isrc' }
  | { kind: 'candidates'; candidates: MatchCandidate[] }
  | { kind: 'new' };

/**
 * 서비스 연결이 아직 없는 곡에 대해 기존 저장 곡과의 관계를 판단한다.
 * (서비스 곡 ID 연결은 저장소 조회로 먼저 처리한다.)
 */
export function decideMatch(ref: ServiceTrackRef, songs: readonly Song[]): MatchDecision {
  const parsed = parseTitle(ref.title, ref.album);
  const artist = normalizeArtist(ref.artist);

  if (ref.isrc) {
    const isrc = ref.isrc.trim().toUpperCase();
    const hit = songs.find(
      (s) =>
        s.isrc?.toUpperCase() === isrc &&
        sameVersionTags(s.versionTags, parsed.versionTags) &&
        durationClose(s.durationMs, ref.durationMs) !== false,
    );
    if (hit) return { kind: 'auto-link', song: hit, reason: 'isrc' };
  }

  const candidates: MatchCandidate[] = [];
  for (const s of songs) {
    if (!sameVersionTags(s.versionTags, parsed.versionTags)) continue;
    if (normalizeArtist(s.artist) !== artist) continue;
    if (parseTitle(s.title, s.album).core !== parsed.core) continue;
    const close = durationClose(s.durationMs, ref.durationMs);
    if (close === false) continue;
    // 서로 다른 ISRC가 명시되어 있으면 다른 녹음이다.
    if (s.isrc && ref.isrc && s.isrc.toUpperCase() !== ref.isrc.toUpperCase()) continue;
    const reasons = ['title', 'artist', 'version-tags'];
    if (close === true) reasons.push('duration±2s');
    if (normalizeForCompare(s.album ?? '') === normalizeForCompare(ref.album ?? '')) reasons.push('album');
    candidates.push({ song: s, reasons });
  }
  if (candidates.length > 0) return { kind: 'candidates', candidates };
  return { kind: 'new' };
}

/** 가사 레코드(LRCLIB 등)가 이 곡에 적용 가능한지: 버전 태그 일치 + 길이 ±2초 */
export function isLyricsRecordCompatible(
  track: { title: string; album: string | null; durationMs: number | null },
  record: { trackName: string; albumName: string; durationSec: number },
): boolean {
  const a = parseTitle(track.title, track.album);
  const b = parseTitle(record.trackName, record.albumName);
  if (!sameVersionTags(a.versionTags, b.versionTags)) return false;
  if (a.core !== b.core) return false;
  return durationClose(track.durationMs, Math.round(record.durationSec * 1000)) !== false;
}
