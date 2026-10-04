import type { LyricsVersion } from '../model.js';
import { parseLrc, parsePlainLyrics } from '../lyrics/lrc.js';
import { translatableLines } from '../lyrics/lyrics-version.js';
import { sanitizeLine } from '../util/text.js';

/**
 * 사용자 번역 가져오기(TXT/LRC/붙여넣기) 미리보기.
 * 원칙: 행 개수나 시간이 맞지 않으면 자동으로 끼워 맞추지 않는다.
 *  - 정확히 맞는 경우에만 "제안" 매핑을 만들고, 저장은 사용자가 미리보기에서 확인한 뒤 한다.
 *  - 맞지 않으면 requiresManualMapping=true 로 행 연결 화면으로 보낸다.
 */

export const IMPORT_LIMITS = { maxChars: 512 * 1024, maxLineChars: 1000 } as const;

export type ImportIssueCode =
  | 'TOO_LARGE'
  | 'ENCODING_SUSPECT'
  | 'EMPTY'
  | 'LINE_COUNT_MISMATCH'
  | 'INVALID_LRC'
  | 'UNMATCHED_TIMESTAMP'
  | 'ORIGINAL_NOT_SYNCED'
  | 'LINE_TOO_LONG';

export interface ImportIssue {
  code: ImportIssueCode;
  detail?: string;
}

export interface ImportPreview {
  format: 'txt' | 'lrc';
  /** 제안 매핑(lineId → 번역). 확신할 수 없으면 null */
  proposed: Record<string, string> | null;
  /** 수동 연결이 필요한 번역 행들 */
  unmatched: string[];
  issues: ImportIssue[];
  requiresManualMapping: boolean;
}

function commonChecks(text: string): ImportIssue[] {
  const issues: ImportIssue[] = [];
  if (text.length > IMPORT_LIMITS.maxChars) issues.push({ code: 'TOO_LARGE' });
  if (text.includes('�')) issues.push({ code: 'ENCODING_SUSPECT', detail: 'UTF-8로 저장된 파일인지 확인하세요' });
  return issues;
}

export function previewTxtImport(lyrics: LyricsVersion, text: string): ImportPreview {
  const issues = commonChecks(text);
  if (issues.some((i) => i.code === 'TOO_LARGE')) {
    return { format: 'txt', proposed: null, unmatched: [], issues, requiresManualMapping: true };
  }
  const tLines = parsePlainLyrics(text).filter((l) => l !== '');
  const targets = translatableLines(lyrics);
  if (tLines.length === 0) issues.push({ code: 'EMPTY' });
  if (tLines.some((l) => l.length > IMPORT_LIMITS.maxLineChars)) issues.push({ code: 'LINE_TOO_LONG' });
  if (tLines.length !== targets.length) {
    issues.push({ code: 'LINE_COUNT_MISMATCH', detail: `원문 ${targets.length}행 / 번역 ${tLines.length}행` });
    return { format: 'txt', proposed: null, unmatched: tLines, issues, requiresManualMapping: true };
  }
  const proposed: Record<string, string> = {};
  targets.forEach((t, i) => {
    proposed[t.id] = sanitizeLine(tLines[i] ?? '').slice(0, IMPORT_LIMITS.maxLineChars);
  });
  return { format: 'txt', proposed, unmatched: [], issues, requiresManualMapping: issues.length > 0 };
}

export function previewLrcImport(lyrics: LyricsVersion, text: string, toleranceMs = 50): ImportPreview {
  const issues = commonChecks(text);
  const parsed = parseLrc(text);
  if (!parsed.ok) {
    issues.push({ code: 'INVALID_LRC', detail: parsed.errors.map((e) => e.code).join(',') });
    return { format: 'lrc', proposed: null, unmatched: [], issues, requiresManualMapping: true };
  }
  if (lyrics.kind !== 'synced') {
    issues.push({ code: 'ORIGINAL_NOT_SYNCED' });
    return {
      format: 'lrc',
      proposed: null,
      unmatched: parsed.lines.map((l) => l.text).filter((t) => t !== ''),
      issues,
      requiresManualMapping: true,
    };
  }
  const proposed: Record<string, string> = {};
  const unmatched: string[] = [];
  const used = new Set<string>();
  for (const t of parsed.lines) {
    if (t.text === '') continue;
    const target = lyrics.lines.find(
      (l) =>
        l.startMs !== null && !used.has(l.id) && l.text.trim() !== '' && Math.abs(l.startMs - t.startMs) <= toleranceMs,
    );
    if (!target) {
      unmatched.push(t.text);
      continue;
    }
    used.add(target.id);
    proposed[target.id] = sanitizeLine(t.text).slice(0, IMPORT_LIMITS.maxLineChars);
  }
  if (unmatched.length > 0) issues.push({ code: 'UNMATCHED_TIMESTAMP', detail: `${unmatched.length}행` });
  return {
    format: 'lrc',
    proposed: Object.keys(proposed).length > 0 ? proposed : null,
    unmatched,
    issues,
    requiresManualMapping: unmatched.length > 0 || issues.length > 0,
  };
}

/** 사용자가 확정한 매핑을 저장 가능한 형태로 검증한다. 존재하지 않는 행 ID는 거부한다. */
export function validateUserMapping(
  lyrics: LyricsVersion,
  mapping: Record<string, string>,
): { ok: true; lines: Record<string, string>; coverage: 'full' | 'partial' } | { ok: false; error: string } {
  const ids = new Set(lyrics.lines.map((l) => l.id));
  const lines: Record<string, string> = {};
  for (const [id, text] of Object.entries(mapping)) {
    if (!ids.has(id)) return { ok: false, error: `알 수 없는 행 ID: ${id}` };
    const clean = sanitizeLine(text).trim();
    if (clean.length > IMPORT_LIMITS.maxLineChars) return { ok: false, error: `행이 너무 깁니다: ${id}` };
    if (clean !== '') lines[id] = clean;
  }
  if (Object.keys(lines).length === 0) return { ok: false, error: '저장할 번역이 없습니다' };
  const needed = translatableLines(lyrics).map((l) => l.id);
  const coverage = needed.every((id) => id in lines) ? 'full' : 'partial';
  return { ok: true, lines, coverage };
}
