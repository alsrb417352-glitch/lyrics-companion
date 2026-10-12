import { sanitizeMultiline } from '../util/text.js';
import { LRC_LIMITS, parseLrc, parsePlainLyrics, type LrcIssueCode, type TimedText } from './lrc.js';

/**
 * 사용자가 직접 등록하는 원문 가사(LRCLIB에서 찾지 못한 곡, D-40).
 * 입력은 TXT/LRC 파일 내용 또는 붙여넣은 텍스트이며 불신 데이터다(불변조건 9 — 가사 속 문장은 글자일 뿐 명령이 아니다).
 * - 행 앞에 [mm:ss.xx] 시간 표시가 있으면 LRC(싱크 가사)로 읽는다. 시간은 사용자가 준 값만 쓰고 만들어 내지 않는다(불변조건 5).
 * - 시간 없는 행이 섞인 LRC는 틀린 것으로 보고 저장하지 않는다. 사용자가 "시간 정보 없이 저장"을 고르면 시간 표시를 지우고
 *   일반 가사로 읽는다(시간을 끼워 맞추지 않음).
 * - 저장 결과가 백업 파일 한도(판본당 행 수·행 길이) 안에 들도록 같은 한도로 막는다.
 */

export const USER_LYRICS_LIMITS = {
  maxChars: LRC_LIMITS.maxChars,
  /** 백업 파일 BACKUP_LIMITS.maxLinesPerVersion과 같게 */
  maxLines: 2_000,
  /** 백업 파일 BACKUP_LIMITS.maxLineChars와 같게 */
  maxLineChars: 1_000,
} as const;

export type UserLyricsFormat = 'auto' | 'plain';

export type UserLyricsWarning =
  /** 단어 단위 시간 표시를 지움(행 단위로만 표시) */
  | 'word-sync-ignored'
  /** 시간 순서가 뒤섞여 있어 시간 순으로 정렬함 */
  | 'unsorted'
  /** 마지막 시간 표시가 곡 길이보다 뒤(다른 버전 가사일 수 있음) */
  | 'beyond-duration'
  /** 깨진 글자(�)가 있음 — 파일 인코딩 문제일 수 있음 */
  | 'replacement-chars'
  /** "시간 정보 없이 저장"으로 시간 표시를 지움 */
  | 'timestamps-removed';

export type UserLyricsError =
  | { code: 'EMPTY' }
  | { code: 'TOO_LARGE' }
  | { code: 'TOO_MANY_LINES'; lines: number }
  | { code: 'LINE_TOO_LONG'; lineNumber: number }
  /** 시간 표시가 있지만 LRC로 읽을 수 없음. canUseAsPlain이면 시간 없이 일반 가사로 저장할 수 있다. */
  | { code: 'INVALID_LRC'; issue: LrcIssueCode; lineNumber: number | null; canUseAsPlain: boolean };

export type ParsedUserLyrics =
  | {
      ok: true;
      kind: 'synced';
      timed: TimedText[];
      /** 빈 행을 뺀 가사 행 수 */
      lineCount: number;
      hasWordTiming: boolean;
      warnings: UserLyricsWarning[];
    }
  | { ok: true; kind: 'plain'; plain: string[]; lineCount: number; hasWordTiming: false; warnings: UserLyricsWarning[] }
  | { ok: false; error: UserLyricsError };

const LEADING_TIME_TAG = /^\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/;
const ALL_TIME_TAGS = /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/g;
const WORD_TAGS = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;
/** LRC 머리 정보 행(제목·가수 등). 가사 행 "[Chorus]"·"[Verse 1: …]"와 헷갈리지 않게 알려진 키만 본다. */
const LRC_META_LINE = /^\s*\[(ti|ar|al|au|by|re|ve|length|offset|#)\s*:[^\]]*\]\s*$/i;

function countNonEmpty(texts: readonly string[]): number {
  return texts.filter((t) => t.trim() !== '').length;
}

function checkSize(texts: readonly string[]): UserLyricsError | null {
  if (countNonEmpty(texts) === 0) return { code: 'EMPTY' };
  if (texts.length > USER_LYRICS_LIMITS.maxLines) return { code: 'TOO_MANY_LINES', lines: texts.length };
  const long = texts.findIndex((t) => t.length > USER_LYRICS_LIMITS.maxLineChars);
  if (long >= 0) return { code: 'LINE_TOO_LONG', lineNumber: long + 1 };
  return null;
}

function hasReplacementChars(texts: readonly string[]): boolean {
  return texts.some((t) => t.includes('�'));
}

/** LRC 머리 정보 행(제목·가수 등)을 뺀다. */
function dropMetaLines(input: string): string {
  return input
    .split('\n')
    .filter((l) => !LRC_META_LINE.test(l))
    .join('\n');
}

/** 시간 표시·단어 시간·LRC 머리 정보를 지우고 일반 가사 행만 남긴다. */
function stripTimestamps(input: string): string {
  return dropMetaLines(input)
    .split('\n')
    .map((l) => l.replace(ALL_TIME_TAGS, '').replace(WORD_TAGS, ''))
    .join('\n');
}

/**
 * 직접 등록할 가사를 해석한다(저장하지 않음 — 미리보기용).
 * @param opts.format 'auto'(시간 표시가 있으면 LRC) | 'plain'(시간 표시를 지우고 일반 가사)
 * @param opts.durationMs 재생 중인 곡 길이(마지막 시간 표시가 이보다 뒤면 경고)
 */
export function parseUserLyrics(
  input: string,
  opts: { format?: UserLyricsFormat; durationMs?: number | null } = {},
): ParsedUserLyrics {
  if (input.length > USER_LYRICS_LIMITS.maxChars) return { ok: false, error: { code: 'TOO_LARGE' } };
  const format = opts.format ?? 'auto';
  const clean = sanitizeMultiline(input);
  const rawLines = clean.split('\n');
  // 줄 수 검사는 해석 전에 한 번(아주 긴 입력을 끝까지 해석하지 않게) — 여유를 두고 원본 줄 수로 막는다.
  if (rawLines.length > LRC_LIMITS.maxLines) {
    return { ok: false, error: { code: 'TOO_MANY_LINES', lines: rawLines.length } };
  }
  const looksTimed = rawLines.some((l) => LEADING_TIME_TAG.test(l));

  if (format === 'auto' && looksTimed) {
    const parsed = parseLrc(clean);
    if (!parsed.ok) {
      const first = parsed.errors[0];
      const issue: LrcIssueCode = first?.code ?? 'NO_TIMESTAMPS';
      const canUseAsPlain = issue !== 'TOO_LARGE' && issue !== 'TOO_MANY_LINES';
      return {
        ok: false,
        error: { code: 'INVALID_LRC', issue, lineNumber: first?.lineNumber ?? null, canUseAsPlain },
      };
    }
    const texts = parsed.lines.map((l) => l.text);
    const sizeError = checkSize(texts);
    if (sizeError) return { ok: false, error: sizeError };
    const warnings: UserLyricsWarning[] = [];
    if (parsed.hadWordTimings) warnings.push('word-sync-ignored');
    if (parsed.warnings.some((w) => w.code === 'UNSORTED')) warnings.push('unsorted');
    const last = parsed.lines[parsed.lines.length - 1];
    if (opts.durationMs != null && last && last.startMs > opts.durationMs) warnings.push('beyond-duration');
    if (hasReplacementChars(texts)) warnings.push('replacement-chars');
    return {
      ok: true,
      kind: 'synced',
      timed: parsed.lines,
      lineCount: countNonEmpty(texts),
      hasWordTiming: parsed.hadWordTimings,
      warnings,
    };
  }

  const plain = parsePlainLyrics(format === 'plain' ? stripTimestamps(clean) : dropMetaLines(clean));
  const sizeError = checkSize(plain);
  if (sizeError) return { ok: false, error: sizeError };
  const warnings: UserLyricsWarning[] = [];
  if (format === 'plain' && looksTimed) warnings.push('timestamps-removed');
  if (hasReplacementChars(plain)) warnings.push('replacement-chars');
  return { ok: true, kind: 'plain', plain, lineCount: countNonEmpty(plain), hasWordTiming: false, warnings };
}

/** 화면에 보여 줄 한국어 안내(오류) */
export function describeUserLyricsError(e: UserLyricsError): string {
  switch (e.code) {
    case 'EMPTY':
      return '가사 내용이 없습니다.';
    case 'TOO_LARGE':
      return '가사가 너무 깁니다(파일이 너무 큼).';
    case 'TOO_MANY_LINES':
      return `줄이 너무 많습니다(${e.lines}줄, 최대 ${USER_LYRICS_LIMITS.maxLines}줄).`;
    case 'LINE_TOO_LONG':
      return `${e.lineNumber}번째 가사 줄이 너무 깁니다(최대 ${USER_LYRICS_LIMITS.maxLineChars}자).`;
    case 'INVALID_LRC': {
      const at = e.lineNumber != null ? `${e.lineNumber}번째 줄: ` : '';
      const why =
        e.issue === 'UNTIMED_LINE'
          ? '시간 표시가 없는 줄이 섞여 있습니다'
          : e.issue === 'INVALID_TIMESTAMP'
            ? '시간 표시 형식이 틀렸습니다'
            : e.issue === 'INVALID_OFFSET'
              ? 'offset 값이 틀렸습니다'
              : '싱크 가사(LRC)로 읽을 수 없습니다';
      return `${at}${why}. 시간을 고치거나 "시간 정보 없이 저장"을 고르세요(시간을 짐작해 채우지 않습니다).`;
    }
  }
}

/** 화면에 보여 줄 한국어 안내(경고) */
export function describeUserLyricsWarning(w: UserLyricsWarning): string {
  switch (w) {
    case 'word-sync-ignored':
      return '단어 단위 시간 표시는 지우고 줄 단위로만 맞춥니다.';
    case 'unsorted':
      return '시간 순서가 뒤섞여 있어 시간 순으로 정렬했습니다.';
    case 'beyond-duration':
      return '마지막 시간이 재생 중인 곡 길이보다 뒤입니다 — 다른 버전 가사일 수 있습니다.';
    case 'replacement-chars':
      return '깨진 글자(�)가 있습니다 — 파일을 UTF-8로 저장했는지 확인하세요.';
    case 'timestamps-removed':
      return '시간 표시를 지우고 시간 정보 없는 가사로 저장합니다(싱크는 "싱크 직접 기록"으로 할 수 있습니다).';
  }
}
