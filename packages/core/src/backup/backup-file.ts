import type {
  DisplaySettings,
  LyricLine,
  LyricsVersion,
  PronunciationLine,
  PronunciationVersion,
  Provenance,
  Song,
  TranslationVersion,
  UserTimingVersion,
} from '../model.js';
import type { StreamingService } from '../ports.js';
import { computeContentHash, computeTextHash } from '../lyrics/lyrics-version.js';
import { sanitizeLine } from '../util/text.js';
import { validateUserTiming } from '../sync/user-timing.js';

/**
 * 백업 파일(내보내기 JSON) 형식과 가져오기 전 검증.
 *
 * 백업 파일은 사용자가 고른 외부 파일이므로 불신 데이터다(불변조건 9, REQ-SEC-07·08).
 *  - 크기·개수·문자열 길이 상한, 형식(타입) 검사, 내부 참조(곡↔가사↔번역) 일관성 검사.
 *  - 가사 판본의 해시를 다시 계산해 원문·타임스탬프가 손상·변조되지 않았는지 확인한다
 *    (싱크는 원문 타임스탬프만 기준 — 불변조건 5).
 *  - 하나라도 틀리면 전체를 거부한다(일부만 들어가는 일 없음).
 *  - API 키·제공자 설정·자동 번역 동의는 백업에 없고, 있어도 읽지 않는다(불변조건 8, REQ-SEC-05).
 */

export const BACKUP_FORMAT = 'lyrics-companion-export';

export const BACKUP_LIMITS = {
  /** 파일 전체 문자 수 */
  maxChars: 48 * 1024 * 1024,
  maxSongs: 20_000,
  maxLyricsVersions: 60_000,
  maxTranslations: 200_000,
  maxLinesPerVersion: 2_000,
  maxLineChars: 1_000,
  maxIdChars: 200,
  maxMetaChars: 500,
} as const;

export interface ServiceTrackLink {
  service: StreamingService;
  serviceKey: string;
  songId: string;
  linkedBy: 'created' | 'isrc' | 'user';
}

export interface UserDataExport {
  format: typeof BACKUP_FORMAT;
  /** 내보낸 앱의 DB 스키마 버전 */
  schemaVersion: number;
  exportedAtEpochMs: number;
  songs: Song[];
  /** 스트리밍 앱 곡 ↔ 내부 곡 연결(재설치 후 같은 곡을 다시 찾는 데 필요) */
  serviceTracks: ServiceTrackLink[];
  lyricsVersions: LyricsVersion[];
  translations: TranslationVersion[];
  pronunciations: PronunciationVersion[];
  /** 사용자 싱크 기록(수동 싱크). 이전 형식 백업에는 없다(빈 배열로 읽음). */
  userTimings: UserTimingVersion[];
  syncOffsets: Array<{ songId: string; offsetMs: number }>;
  settings: { display: DisplaySettings };
}

export interface BackupSummary {
  songs: number;
  lyricsVersions: number;
  userTranslations: number;
  aiTranslations: number;
  userPronunciations: number;
  aiPronunciations: number;
  userTimings: number;
  exportedAtEpochMs: number;
}

export type BackupParseResult =
  { ok: true; data: UserDataExport; summary: BackupSummary } | { ok: false; error: string };

class BackupFormatError extends Error {}

function fail(msg: string): never {
  throw new BackupFormatError(msg);
}

type Obj = Record<string, unknown>;

function obj(x: unknown, where: string): Obj {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) fail(`${where}: 객체가 아닙니다`);
  return x as Obj;
}
function arr(x: unknown, where: string, max: number): unknown[] {
  if (!Array.isArray(x)) fail(`${where}: 배열이 아닙니다`);
  if (x.length > max) fail(`${where}: 항목이 너무 많습니다(${x.length} > ${max})`);
  return x;
}
function id(x: unknown, where: string): string {
  if (typeof x !== 'string' || x.length === 0 || x.length > BACKUP_LIMITS.maxIdChars) fail(`${where}: ID 형식 오류`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(x)) fail(`${where}: ID에 제어 문자가 있습니다`);
  return x;
}
function text(x: unknown, where: string, max: number): string {
  if (typeof x !== 'string') fail(`${where}: 문자열이 아닙니다`);
  const clean = sanitizeLine(x);
  if (clean.length > max) fail(`${where}: 너무 깁니다`);
  return clean;
}
function textOrNull(x: unknown, where: string, max: number): string | null {
  return x === null || x === undefined ? null : text(x, where, max);
}
function int(x: unknown, where: string, min: number, max: number): number {
  if (typeof x !== 'number' || !Number.isInteger(x) || x < min || x > max) fail(`${where}: 숫자 범위 오류`);
  return x;
}
function intOrNull(x: unknown, where: string, min: number, max: number): number | null {
  return x === null || x === undefined ? null : int(x, where, min, max);
}
function bool(x: unknown, where: string): boolean {
  if (typeof x !== 'boolean') fail(`${where}: true/false가 아닙니다`);
  return x;
}
function oneOf<T extends string>(x: unknown, allowed: readonly T[], where: string): T {
  if (typeof x !== 'string' || !(allowed as readonly string[]).includes(x)) fail(`${where}: 허용되지 않는 값`);
  return x as T;
}

const MAX_EPOCH = 8_640_000_000_000_000;
const MAX_MS = 24 * 3600 * 1000;
const SERVICES = ['apple-music', 'spotify', 'youtube-music', 'unknown'] as const;

function parseProvenance(x: unknown, where: string): Provenance | null {
  if (x === null || x === undefined) return null;
  const o = obj(x, where);
  return {
    providerId: text(o['providerId'], `${where}.providerId`, BACKUP_LIMITS.maxMetaChars),
    model: text(o['model'], `${where}.model`, BACKUP_LIMITS.maxMetaChars),
    promptVersion: text(o['promptVersion'], `${where}.promptVersion`, BACKUP_LIMITS.maxMetaChars),
  };
}

function parseSong(x: unknown, i: number): Song {
  const w = `songs[${i}]`;
  const o = obj(x, w);
  const tags = arr(o['versionTags'], `${w}.versionTags`, 20).map((t, j) => text(t, `${w}.versionTags[${j}]`, 50));
  return {
    id: id(o['id'], `${w}.id`),
    title: text(o['title'], `${w}.title`, BACKUP_LIMITS.maxMetaChars),
    artist: text(o['artist'], `${w}.artist`, BACKUP_LIMITS.maxMetaChars),
    album: textOrNull(o['album'], `${w}.album`, BACKUP_LIMITS.maxMetaChars),
    durationMs: intOrNull(o['durationMs'], `${w}.durationMs`, 0, MAX_MS),
    versionTags: tags,
    isrc: textOrNull(o['isrc'], `${w}.isrc`, 20),
    activeLyricsVersionId: o['activeLyricsVersionId'] == null ? null : id(o['activeLyricsVersionId'], `${w}.active`),
    createdAtEpochMs: int(o['createdAtEpochMs'], `${w}.createdAtEpochMs`, 0, MAX_EPOCH),
  };
}

function parseLyrics(x: unknown, i: number): LyricsVersion {
  const w = `lyricsVersions[${i}]`;
  const o = obj(x, w);
  const kind = oneOf(o['kind'], ['synced', 'plain', 'instrumental'] as const, `${w}.kind`);
  const seen = new Set<string>();
  const lines: LyricLine[] = arr(o['lines'], `${w}.lines`, BACKUP_LIMITS.maxLinesPerVersion).map((l, j) => {
    const lo = obj(l, `${w}.lines[${j}]`);
    const lineId = id(lo['id'], `${w}.lines[${j}].id`);
    if (seen.has(lineId)) fail(`${w}: 행 ID 중복`);
    seen.add(lineId);
    const startMs = intOrNull(lo['startMs'], `${w}.lines[${j}].startMs`, 0, MAX_MS);
    if (kind === 'synced' && startMs === null) fail(`${w}: 싱크 가사에 시간 정보가 없는 행`);
    if (kind !== 'synced' && startMs !== null) fail(`${w}: 시간 정보가 없어야 하는 가사에 시간이 있음`);
    // 원문은 바꾸지 않는다(해시 검증 대상). 문자열 형식·길이만 확인한다.
    if (typeof lo['text'] !== 'string' || lo['text'].length > BACKUP_LIMITS.maxLineChars) fail(`${w}: 행 텍스트 오류`);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001F\u007F]/.test(lo['text'])) fail(`${w}: 행 텍스트에 제어 문자가 있습니다`);
    return { id: lineId, text: lo['text'], startMs };
  });
  const textHash = text(o['textHash'], `${w}.textHash`, 128);
  const contentHash = text(o['contentHash'], `${w}.contentHash`, 128);
  // 손상·변조 감지: 원문·타임스탬프로 해시를 다시 계산한다.
  if (computeTextHash(lines) !== textHash || computeContentHash(lines) !== contentHash) {
    fail(`${w}: 가사 해시가 맞지 않습니다(파일 손상 또는 수정됨)`);
  }
  const lang = oneOf(o['language'], ['ja', 'en', 'ko', 'mixed', 'unknown'] as const, `${w}.language`);
  return {
    id: id(o['id'], `${w}.id`),
    songId: id(o['songId'], `${w}.songId`),
    source: oneOf(o['source'], ['lrclib', 'user'] as const, `${w}.source`),
    sourceRef: textOrNull(o['sourceRef'], `${w}.sourceRef`, BACKUP_LIMITS.maxMetaChars),
    kind,
    language: lang,
    lines,
    textHash,
    contentHash,
    hasWordTimingSource: bool(o['hasWordTimingSource'], `${w}.hasWordTimingSource`),
    createdAtEpochMs: int(o['createdAtEpochMs'], `${w}.createdAtEpochMs`, 0, MAX_EPOCH),
  };
}

function parseTextVersionBase(o: Obj, w: string) {
  return {
    id: id(o['id'], `${w}.id`),
    lyricsVersionId: id(o['lyricsVersionId'], `${w}.lyricsVersionId`),
    origin: oneOf(o['origin'], ['user', 'ai'] as const, `${w}.origin`),
    sourceTextHash: text(o['sourceTextHash'], `${w}.sourceTextHash`, 128),
    provenance: parseProvenance(o['provenance'], `${w}.provenance`),
    createdAtEpochMs: int(o['createdAtEpochMs'], `${w}.createdAtEpochMs`, 0, MAX_EPOCH),
    seq: int(o['seq'], `${w}.seq`, 0, Number.MAX_SAFE_INTEGER),
  };
}

function parseTranslation(x: unknown, i: number, lyrics: Map<string, LyricsVersion>): TranslationVersion {
  const w = `translations[${i}]`;
  const o = obj(x, w);
  const base = parseTextVersionBase(o, w);
  const lv = lyrics.get(base.lyricsVersionId) ?? fail(`${w}: 연결된 가사 판본이 파일에 없습니다`);
  const lineIds = new Set(lv.lines.map((l) => l.id));
  const lines: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(o['lines'], `${w}.lines`))) {
    if (!lineIds.has(k)) fail(`${w}: 가사에 없는 행 ID`);
    lines[k] = text(v, `${w}.lines.${k}`, BACKUP_LIMITS.maxLineChars);
  }
  return { ...base, lines };
}

function parsePronunciation(x: unknown, i: number, lyrics: Map<string, LyricsVersion>): PronunciationVersion {
  const w = `pronunciations[${i}]`;
  const o = obj(x, w);
  const base = parseTextVersionBase(o, w);
  const lv = lyrics.get(base.lyricsVersionId) ?? fail(`${w}: 연결된 가사 판본이 파일에 없습니다`);
  const lineIds = new Set(lv.lines.map((l) => l.id));
  const lines: Record<string, PronunciationLine> = {};
  for (const [k, v] of Object.entries(obj(o['lines'], `${w}.lines`))) {
    if (!lineIds.has(k)) fail(`${w}: 가사에 없는 행 ID`);
    const po = obj(v, `${w}.lines.${k}`);
    lines[k] = {
      kana: textOrNull(po['kana'], `${w}.lines.${k}.kana`, BACKUP_LIMITS.maxLineChars),
      hangul: text(po['hangul'], `${w}.lines.${k}.hangul`, BACKUP_LIMITS.maxLineChars),
    };
  }
  return { ...base, lines };
}

function parseUserTiming(x: unknown, i: number, lyrics: Map<string, LyricsVersion>): UserTimingVersion {
  const w = `userTimings[${i}]`;
  const o = obj(x, w);
  const lyricsVersionId = id(o['lyricsVersionId'], `${w}.lyricsVersionId`);
  const lv = lyrics.get(lyricsVersionId) ?? fail(`${w}: 연결된 가사 판본이 파일에 없습니다`);
  const kind = oneOf(o['kind'], ['timed', 'cleared'] as const, `${w}.kind`);
  const raw = obj(o['lines'], `${w}.lines`);
  let lines: Record<string, number> = {};
  if (kind === 'timed') {
    // 사람이 기록한 시간인지 알 수는 없지만, 판본의 행·순서·범위에 맞는지는 확인한다(불변조건 5·9).
    const checked = validateUserTiming(lv, raw);
    if (!checked.ok) fail(`${w}: ${checked.error}`);
    lines = checked.lines;
  } else if (Object.keys(raw).length > 0) {
    fail(`${w}: 되돌리기 기록에 시각이 있습니다`);
  }
  return {
    id: id(o['id'], `${w}.id`),
    lyricsVersionId,
    kind,
    lines,
    sourceTextHash: text(o['sourceTextHash'], `${w}.sourceTextHash`, 128),
    createdAtEpochMs: int(o['createdAtEpochMs'], `${w}.createdAtEpochMs`, 0, MAX_EPOCH),
    seq: int(o['seq'], `${w}.seq`, 0, Number.MAX_SAFE_INTEGER),
  };
}

/**
 * 백업 파일 텍스트를 검증해 가져오기 가능한 데이터로 만든다.
 * @param maxSchemaVersion 이 앱이 아는 최신 DB 스키마 버전(더 새로운 앱에서 만든 백업은 거부)
 */
export function parseBackup(raw: string, maxSchemaVersion: number): BackupParseResult {
  try {
    if (raw.length > BACKUP_LIMITS.maxChars) fail('파일이 너무 큽니다');
    let json: unknown;
    try {
      json = JSON.parse(raw.replace(/^\uFEFF/, ''));
    } catch {
      fail('JSON 형식이 아닙니다');
    }
    const root = obj(json, '파일');
    if (root['format'] !== BACKUP_FORMAT) fail('이 앱의 백업 파일이 아닙니다');
    const schemaVersion = int(root['schemaVersion'], 'schemaVersion', 1, 10_000);
    if (schemaVersion > maxSchemaVersion) fail('더 새로운 버전의 앱에서 만든 백업입니다. 앱을 먼저 업데이트하세요');
    const exportedAtEpochMs = int(root['exportedAtEpochMs'], 'exportedAtEpochMs', 0, MAX_EPOCH);

    const songs = arr(root['songs'], 'songs', BACKUP_LIMITS.maxSongs).map(parseSong);
    const songIds = new Set<string>();
    for (const s of songs) {
      if (songIds.has(s.id)) fail('곡 ID 중복');
      songIds.add(s.id);
    }

    const lyricsList = arr(root['lyricsVersions'], 'lyricsVersions', BACKUP_LIMITS.maxLyricsVersions).map(parseLyrics);
    const lyrics = new Map<string, LyricsVersion>();
    for (const lv of lyricsList) {
      if (lyrics.has(lv.id)) fail('가사 판본 ID 중복');
      if (!songIds.has(lv.songId)) fail('가사 판본이 파일에 없는 곡을 가리킵니다');
      lyrics.set(lv.id, lv);
    }
    for (const s of songs) {
      if (s.activeLyricsVersionId !== null && lyrics.get(s.activeLyricsVersionId)?.songId !== s.id) {
        fail('곡의 활성 가사 판본이 파일에 없습니다');
      }
    }

    const translations = arr(root['translations'], 'translations', BACKUP_LIMITS.maxTranslations).map((x, i) =>
      parseTranslation(x, i, lyrics),
    );
    const pronunciations = arr(root['pronunciations'], 'pronunciations', BACKUP_LIMITS.maxTranslations).map((x, i) =>
      parsePronunciation(x, i, lyrics),
    );
    for (const list of [translations, pronunciations]) {
      const ids = new Set<string>();
      for (const t of list) {
        if (ids.has(t.id)) fail('번역·발음 ID 중복');
        ids.add(t.id);
      }
    }

    // 이전 형식(userTimings 없음)도 받아들인다.
    const userTimings =
      root['userTimings'] === undefined
        ? []
        : arr(root['userTimings'], 'userTimings', BACKUP_LIMITS.maxTranslations).map((x, i) =>
            parseUserTiming(x, i, lyrics),
          );
    {
      const ids = new Set<string>();
      for (const t of userTimings) {
        if (ids.has(t.id)) fail('싱크 기록 ID 중복');
        ids.add(t.id);
      }
    }

    // 이전 형식(serviceTracks 없음)도 받아들인다.
    const serviceTracks: ServiceTrackLink[] =
      root['serviceTracks'] === undefined
        ? []
        : arr(root['serviceTracks'], 'serviceTracks', BACKUP_LIMITS.maxSongs * 4).map((x, i) => {
            const w = `serviceTracks[${i}]`;
            const o = obj(x, w);
            const link: ServiceTrackLink = {
              service: oneOf(o['service'], SERVICES, `${w}.service`),
              serviceKey: text(o['serviceKey'], `${w}.serviceKey`, BACKUP_LIMITS.maxMetaChars * 2),
              songId: id(o['songId'], `${w}.songId`),
              linkedBy: oneOf(o['linkedBy'], ['created', 'isrc', 'user'] as const, `${w}.linkedBy`),
            };
            if (!songIds.has(link.songId)) fail(`${w}: 파일에 없는 곡을 가리킵니다`);
            return link;
          });

    const syncOffsets = arr(root['syncOffsets'], 'syncOffsets', BACKUP_LIMITS.maxSongs).map((x, i) => {
      const o = obj(x, `syncOffsets[${i}]`);
      const songId = id(o['songId'], `syncOffsets[${i}].songId`);
      if (!songIds.has(songId)) fail(`syncOffsets[${i}]: 파일에 없는 곡을 가리킵니다`);
      return { songId, offsetMs: int(o['offsetMs'], `syncOffsets[${i}].offsetMs`, -30_000, 30_000) };
    });

    const settingsObj = root['settings'] === undefined ? {} : obj(root['settings'], 'settings');
    const displayObj = settingsObj['display'] === undefined ? null : obj(settingsObj['display'], 'settings.display');
    const display: DisplaySettings = displayObj
      ? {
          showTranslation: bool(displayObj['showTranslation'], 'settings.display.showTranslation'),
          showPronunciation: bool(displayObj['showPronunciation'], 'settings.display.showPronunciation'),
        }
      : { showTranslation: true, showPronunciation: true };
    // settings.translation(자동 번역 동의)·제공자 설정은 의도적으로 읽지 않는다.

    const data: UserDataExport = {
      format: BACKUP_FORMAT,
      schemaVersion,
      exportedAtEpochMs,
      songs,
      serviceTracks,
      lyricsVersions: lyricsList,
      translations,
      pronunciations,
      userTimings,
      syncOffsets,
      settings: { display },
    };
    return {
      ok: true,
      data,
      summary: {
        songs: songs.length,
        lyricsVersions: lyricsList.length,
        userTranslations: translations.filter((t) => t.origin === 'user').length,
        aiTranslations: translations.filter((t) => t.origin === 'ai').length,
        userPronunciations: pronunciations.filter((p) => p.origin === 'user').length,
        aiPronunciations: pronunciations.filter((p) => p.origin === 'ai').length,
        userTimings: userTimings.filter((t) => t.kind === 'timed').length,
        exportedAtEpochMs,
      },
    };
  } catch (e) {
    if (e instanceof BackupFormatError) return { ok: false, error: e.message };
    return { ok: false, error: '백업 파일을 읽지 못했습니다' };
  }
}

/** 내보내기 파일 이름(시각은 호출자가 지역 시간 구성요소로 넘긴다) */
export function backupFileName(parts: { y: number; mo: number; d: number; h: number; mi: number }): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `lyrics-companion-backup-${parts.y}${p2(parts.mo)}${p2(parts.d)}-${p2(parts.h)}${p2(parts.mi)}.json`;
}
