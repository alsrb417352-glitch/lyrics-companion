import type { LyricsVersion, PronunciationLine, PronunciationVersion } from '../model.js';
import { hasJapaneseScript, sanitizeLine } from '../util/text.js';
import { IMPORT_LIMITS } from './user-translation-import.js';

/**
 * 사용자가 수정한 한글 발음(독음)을 저장 가능한 형태로 만든다(REQ-ED-03, REQ-TR-03).
 *  - 일본어 문자가 있는 행만 대상이다(발음은 일본어 행에만 표시된다).
 *  - 기준 판본(현재 표시 중인 발음)의 행과 한글이 같으면 그 행의 가나 읽기를 유지하고,
 *    사용자가 바꾼 행은 가나와 더 이상 맞지 않으므로 kana = null 로 저장한다.
 *  - 빈 칸은 저장하지 않는다(그 행은 발음 없음). AI로 채우지 않는다(불변조건 3·4).
 */
export function buildUserPronunciation(
  lyrics: LyricsVersion,
  edited: Record<string, string>,
  base: PronunciationVersion | null,
): { ok: true; lines: Record<string, PronunciationLine>; changed: number } | { ok: false; error: string } {
  const byId = new Map(lyrics.lines.map((l) => [l.id, l]));
  const lines: Record<string, PronunciationLine> = {};
  let changed = 0;
  for (const [id, raw] of Object.entries(edited)) {
    const line = byId.get(id);
    if (!line) return { ok: false, error: `알 수 없는 행 ID: ${id}` };
    if (!hasJapaneseScript(line.text)) continue;
    const hangul = sanitizeLine(raw).trim();
    if (hangul.length > IMPORT_LIMITS.maxLineChars) return { ok: false, error: `행이 너무 깁니다: ${id}` };
    const prev = base?.lines[id] ?? null;
    if (hangul === '') {
      if (prev) changed++;
      continue;
    }
    if (prev && prev.hangul === hangul) {
      lines[id] = { kana: prev.kana, hangul };
    } else {
      lines[id] = { kana: null, hangul };
      changed++;
    }
  }
  if (Object.keys(lines).length === 0) return { ok: false, error: '저장할 발음이 없습니다' };
  return { ok: true, lines, changed };
}
