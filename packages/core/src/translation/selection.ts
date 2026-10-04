import type { PronunciationVersion, TranslationVersion } from '../model.js';

/**
 * 표시할 번역 선택(고정 우선순위):
 *   사용자 저장 번역 → 저장된 AI 번역 → (없음: 원문만)
 * 같은 origin 안에서는 가장 최근에 저장된 버전(seq 최대)을 쓴다.
 * 사용자 번역이 일부 행만 있어도 그대로 사용하며, 빈 행을 AI 번역으로 보완하지 않는다.
 */
export function selectTranslation(versions: readonly TranslationVersion[]): TranslationVersion | null {
  return latest(versions.filter((v) => v.origin === 'user')) ?? latest(versions.filter((v) => v.origin === 'ai'));
}

export function selectPronunciation(versions: readonly PronunciationVersion[]): PronunciationVersion | null {
  return latest(versions.filter((v) => v.origin === 'user')) ?? latest(versions.filter((v) => v.origin === 'ai'));
}

function latest<T extends { seq: number }>(items: readonly T[]): T | null {
  let best: T | null = null;
  for (const it of items) if (!best || it.seq > best.seq) best = it;
  return best;
}
