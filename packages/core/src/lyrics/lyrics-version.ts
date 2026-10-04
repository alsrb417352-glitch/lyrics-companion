import type { LyricLine, LyricsKind, LyricsSourceKind, LyricsVersion } from '../model.js';
import { sha256Hex } from '../util/sha256.js';
import { detectLanguage } from '../util/text.js';
import type { TimedText } from './lrc.js';

export interface BuildLyricsVersionInput {
  id: string;
  songId: string;
  source: LyricsSourceKind;
  sourceRef: string | null;
  kind: LyricsKind;
  /** synced이면 timed, plain이면 plain 사용 */
  timed?: readonly TimedText[];
  plain?: readonly string[];
  hasWordTimingSource?: boolean;
  createdAtEpochMs: number;
}

/** 행 ID는 판본 안의 순번으로 만든다. 판본이 불변이므로 ID도 안정적이다. */
export function lineIdFor(index: number): string {
  return `l${String(index + 1).padStart(4, '0')}`;
}

export function computeTextHash(lines: readonly { text: string }[]): string {
  return sha256Hex(lines.map((l) => l.text).join('\n'));
}

export function computeContentHash(lines: readonly LyricLine[]): string {
  return sha256Hex(lines.map((l) => `${l.startMs ?? ''}\t${l.text}`).join('\n'));
}

export function buildLyricsVersion(input: BuildLyricsVersionInput): LyricsVersion {
  let lines: LyricLine[] = [];
  if (input.kind === 'synced') {
    lines = (input.timed ?? []).map((t, i) => ({ id: lineIdFor(i), text: t.text, startMs: t.startMs }));
  } else if (input.kind === 'plain') {
    lines = (input.plain ?? []).map((text, i) => ({ id: lineIdFor(i), text, startMs: null }));
  }
  return {
    id: input.id,
    songId: input.songId,
    source: input.source,
    sourceRef: input.sourceRef,
    kind: input.kind,
    language: detectLanguage(lines.map((l) => l.text)),
    lines,
    textHash: computeTextHash(lines),
    contentHash: computeContentHash(lines),
    hasWordTimingSource: input.hasWordTimingSource ?? false,
    createdAtEpochMs: input.createdAtEpochMs,
  };
}

/** 번역 대상 행(빈 행 제외) */
export function translatableLines(version: LyricsVersion): LyricLine[] {
  return version.lines.filter((l) => l.text.trim() !== '');
}
