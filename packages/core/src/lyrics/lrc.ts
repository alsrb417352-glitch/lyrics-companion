import { sanitizeMultiline } from '../util/text.js';

/**
 * LRC 파서.
 * - 행 단위 타임스탬프 [mm:ss.xx] / [mm:ss.xxx] / [mm:ss] 를 지원한다. 한 행에 여러 타임스탬프가 있으면 행을 복제한다.
 * - [offset:±ms] 태그를 적용한다(양수면 가사가 더 일찍 표시됨, 일반적인 LRC 관례).
 * - 단어 단위 태그 <mm:ss.xx> 는 제거하고 hadWordTimings=true 로만 기록한다(단어 싱크를 표시하지 않음).
 * - 시간 없는 가사 행이 섞여 있으면 잘못된 LRC로 본다. 임의로 시간을 끼워 맞추지 않는다.
 */

export const LRC_LIMITS = {
  maxChars: 256 * 1024,
  maxLines: 5000,
  maxTimeMs: 6 * 60 * 60 * 1000,
} as const;

export type LrcIssueCode =
  | 'TOO_LARGE'
  | 'TOO_MANY_LINES'
  | 'NO_TIMESTAMPS'
  | 'UNTIMED_LINE'
  | 'INVALID_TIMESTAMP'
  | 'UNSORTED'
  | 'INVALID_OFFSET';

export interface LrcIssue {
  code: LrcIssueCode;
  /** 1부터 시작하는 원본 줄 번호(해당될 때) */
  lineNumber?: number;
  detail?: string;
}

export interface TimedText {
  startMs: number;
  text: string;
}

export interface LrcParseResult {
  ok: boolean;
  lines: TimedText[];
  offsetMs: number;
  hadWordTimings: boolean;
  metadata: Record<string, string>;
  errors: LrcIssue[];
  warnings: LrcIssue[];
}

const TIME_TAG = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;
const META_TAG = /^\[([A-Za-z#]+):([^\]]*)\]\s*$/;
const WORD_TAG = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;

function toMs(min: string, sec: string, frac: string | undefined): number | null {
  const m = Number(min);
  const s = Number(sec);
  if (!Number.isInteger(m) || !Number.isInteger(s) || s >= 60) return null;
  let ms = 0;
  if (frac !== undefined) {
    if (frac.length === 1) ms = Number(frac) * 100;
    else if (frac.length === 2) ms = Number(frac) * 10;
    else ms = Number(frac);
  }
  const total = (m * 60 + s) * 1000 + ms;
  return total <= LRC_LIMITS.maxTimeMs ? total : null;
}

export function parseLrc(input: string): LrcParseResult {
  const result: LrcParseResult = {
    ok: false,
    lines: [],
    offsetMs: 0,
    hadWordTimings: false,
    metadata: {},
    errors: [],
    warnings: [],
  };
  if (input.length > LRC_LIMITS.maxChars) {
    result.errors.push({ code: 'TOO_LARGE', detail: `${input.length} chars` });
    return result;
  }
  const rawLines = sanitizeMultiline(input).split('\n');
  if (rawLines.length > LRC_LIMITS.maxLines) {
    result.errors.push({ code: 'TOO_MANY_LINES', detail: `${rawLines.length}` });
    return result;
  }

  const timed: Array<TimedText & { order: number }> = [];
  let order = 0;
  rawLines.forEach((raw, idx) => {
    const lineNumber = idx + 1;
    const line = raw.trim();
    if (line === '') return;

    const meta = META_TAG.exec(line);
    if (meta && !TIME_TAG.test(line)) {
      const key = (meta[1] ?? '').toLowerCase();
      const value = (meta[2] ?? '').trim();
      if (key === 'offset') {
        const n = Number(value);
        if (Number.isFinite(n) && Math.abs(n) <= 60_000) result.offsetMs = Math.trunc(n);
        else result.errors.push({ code: 'INVALID_OFFSET', lineNumber, detail: value });
      } else {
        result.metadata[key] = value;
      }
      return;
    }

    const stamps: number[] = [];
    let rest = line;
    let m: RegExpExecArray | null;
    while ((m = TIME_TAG.exec(rest)) !== null) {
      const ms = toMs(m[1] ?? '', m[2] ?? '', m[3]);
      if (ms === null) {
        result.errors.push({ code: 'INVALID_TIMESTAMP', lineNumber, detail: m[0] });
        return;
      }
      stamps.push(ms);
      rest = rest.slice(m[0].length);
    }
    if (stamps.length === 0) {
      // 시간 없는 가사 행: 싱크 가사로 신뢰할 수 없다.
      result.errors.push({ code: 'UNTIMED_LINE', lineNumber });
      return;
    }
    if (WORD_TAG.test(rest)) {
      result.hadWordTimings = true;
      rest = rest.replace(WORD_TAG, '');
    }
    WORD_TAG.lastIndex = 0;
    const text = rest.replace(/\s+/g, ' ').trim();
    for (const s of stamps) timed.push({ startMs: s, text, order: order++ });
  });

  if (timed.length === 0 && !result.errors.some((e) => e.code !== 'UNTIMED_LINE')) {
    result.errors.push({ code: 'NO_TIMESTAMPS' });
  }

  const sorted = [...timed].sort((a, b) => a.startMs - b.startMs || a.order - b.order);
  if (sorted.some((t, i) => t !== timed[i])) result.warnings.push({ code: 'UNSORTED' });

  result.lines = sorted.map((t) => ({
    startMs: Math.max(0, t.startMs - result.offsetMs),
    text: t.text,
  }));
  result.ok = result.errors.length === 0 && result.lines.length > 0;
  return result;
}

/** 일반 가사(시간 정보 없음) 파싱. 앞뒤 빈 행은 제거하고 중간 빈 행은 단락 구분으로 유지한다. */
export function parsePlainLyrics(input: string): string[] {
  const lines = sanitizeMultiline(input)
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim());
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
