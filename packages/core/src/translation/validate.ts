import { isValidKanaReading } from '../pronunciation/kana-to-hangul.js';
import { sanitizeLine } from '../util/text.js';
import type { BuiltTranslationRequest } from './prompt.js';

/**
 * AI 응답 검증. 응답 전체를 신뢰하지 않는 데이터로 취급한다.
 * - 행 ID 누락·중복·순서 오류·모르는 ID·형식 오류를 검사한다.
 * - 거절/번역 불가 응답을 정상 번역으로 받아들이지 않는다.
 * - 번역과 읽기를 따로 판정해, 유효한 부분만 저장할 수 있게 한다.
 */

export const MAX_RAW_RESPONSE_CHARS = 1_000_000;

export type ValidationErrorCode =
  | 'TOO_LARGE'
  | 'NOT_JSON'
  | 'BAD_SHAPE'
  | 'REFUSAL'
  | 'MISSING_LINES'
  | 'EXTRA_LINES'
  | 'DUPLICATE_ID'
  | 'UNKNOWN_ID'
  | 'ORDER_MISMATCH'
  | 'EMPTY_TEXT'
  | 'TEXT_TOO_LONG'
  | 'INVALID_READING';

export interface ValidationIssue {
  code: ValidationErrorCode;
  lineId?: string;
  detail?: string;
}

export type PartResult = { ok: true; lines: Record<string, string> } | { ok: false; issues: ValidationIssue[] };

export interface ValidationResult {
  /** 형식·행 구조 수준 오류(이 경우 translation/reading 모두 실패) */
  structural: ValidationIssue[];
  translation: PartResult | null;
  reading: PartResult | null;
}

const REFUSAL_PATTERNS = [
  /^(i'?m sorry|sorry,|i can(?:no|')t|i am unable|as an ai)/i,
  /(죄송하지만|죄송합니다|번역할 수 없|도와드릴 수 없|제공할 수 없)/,
  /(申し訳ありません|翻訳できません|お答えできません)/,
];

function looksLikeRefusal(s: string): boolean {
  return REFUSAL_PATTERNS.some((re) => re.test(s.trim()));
}

function stripCodeFence(raw: string): string {
  const t = raw.trim();
  const m = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(t);
  return m && m[1] !== undefined ? m[1] : t;
}

export function validateTranslationResponse(
  rawText: string,
  req: Pick<BuiltTranslationRequest, 'expected' | 'wantTranslation' | 'wantReading'>,
  refusedFlag = false,
): ValidationResult {
  const fail = (issue: ValidationIssue): ValidationResult => ({
    structural: [issue],
    translation: req.wantTranslation ? { ok: false, issues: [issue] } : null,
    reading: req.wantReading ? { ok: false, issues: [issue] } : null,
  });

  if (refusedFlag) return fail({ code: 'REFUSAL', detail: 'provider refusal flag' });
  if (rawText.length > MAX_RAW_RESPONSE_CHARS) return fail({ code: 'TOO_LARGE' });

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(rawText));
  } catch {
    return fail({ code: 'NOT_JSON' });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fail({ code: 'BAD_SHAPE' });
  const obj = parsed as Record<string, unknown>;
  if (obj['status'] === 'cannot_translate') return fail({ code: 'REFUSAL', detail: 'cannot_translate' });
  if (obj['status'] !== 'ok' || !Array.isArray(obj['lines'])) return fail({ code: 'BAD_SHAPE' });

  const out = obj['lines'] as unknown[];
  const expectedIds = req.expected.map((e) => e.id);
  const expectedSet = new Set(expectedIds);
  const seen = new Set<string>();
  const structural: ValidationIssue[] = [];
  const items: Array<{ id: string; ko: unknown; reading: unknown }> = [];

  for (const item of out) {
    if (typeof item !== 'object' || item === null) {
      structural.push({ code: 'BAD_SHAPE', detail: 'line item' });
      continue;
    }
    const it = item as Record<string, unknown>;
    const id = it['id'];
    if (typeof id !== 'string') {
      structural.push({ code: 'BAD_SHAPE', detail: 'id' });
      continue;
    }
    if (!expectedSet.has(id)) structural.push({ code: 'UNKNOWN_ID', lineId: id });
    else if (seen.has(id)) structural.push({ code: 'DUPLICATE_ID', lineId: id });
    seen.add(id);
    items.push({ id, ko: it['ko'], reading: it['reading'] });
  }
  const missing = expectedIds.filter((id) => !seen.has(id));
  if (missing.length > 0) structural.push({ code: 'MISSING_LINES', detail: missing.slice(0, 20).join(',') });
  if (items.length > expectedIds.length) structural.push({ code: 'EXTRA_LINES' });
  if (structural.length === 0 && items.some((it, i) => it.id !== expectedIds[i])) {
    structural.push({ code: 'ORDER_MISMATCH' });
  }
  if (structural.length > 0) {
    return {
      structural,
      translation: req.wantTranslation ? { ok: false, issues: structural } : null,
      reading: req.wantReading ? { ok: false, issues: structural } : null,
    };
  }

  // 번역 판정
  let translation: PartResult | null = null;
  if (req.wantTranslation) {
    const issues: ValidationIssue[] = [];
    const lines: Record<string, string> = {};
    let refusalCount = 0;
    req.expected.forEach((e, i) => {
      const ko = items[i]?.ko;
      if (typeof ko !== 'string' || ko.trim() === '') {
        issues.push({ code: 'EMPTY_TEXT', lineId: e.id });
        return;
      }
      const clean = sanitizeLine(ko).trim();
      if (clean.length > Math.max(200, e.text.length * 6)) issues.push({ code: 'TEXT_TOO_LONG', lineId: e.id });
      if (looksLikeRefusal(clean)) refusalCount++;
      lines[e.id] = clean;
    });
    if (refusalCount > 0 && refusalCount >= Math.ceil(req.expected.length / 2)) {
      issues.unshift({ code: 'REFUSAL', detail: `${refusalCount} lines` });
    }
    translation = issues.length === 0 ? { ok: true, lines } : { ok: false, issues };
  }

  // 읽기 판정
  let reading: PartResult | null = null;
  if (req.wantReading) {
    const issues: ValidationIssue[] = [];
    const lines: Record<string, string> = {};
    req.expected.forEach((e, i) => {
      if (!e.needsReading) return;
      const r = items[i]?.reading;
      if (typeof r !== 'string' || r.trim() === '') {
        issues.push({ code: 'INVALID_READING', lineId: e.id, detail: 'missing' });
        return;
      }
      const clean = sanitizeLine(r).trim();
      if (!isValidKanaReading(clean)) {
        issues.push({ code: 'INVALID_READING', lineId: e.id, detail: 'non-kana' });
        return;
      }
      lines[e.id] = clean;
    });
    reading = issues.length === 0 ? { ok: true, lines } : { ok: false, issues };
  }

  return { structural: [], translation, reading };
}
