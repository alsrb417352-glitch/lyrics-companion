import type { PronunciationVersion, TranslationOrigin, TranslationVersion } from '../model.js';

/**
 * 표시할 번역 선택(고정 우선순위):
 *   사용자 저장 번역 → 저장된 AI 번역 → 가사에 포함된 번역(lyrics, D-43) → (없음: 원문만)
 * 같은 origin 안에서는 가장 최근에 저장된 버전(seq 최대)을 쓴다.
 * 사용자 번역이 일부 행만 있어도 그대로 사용하며, 빈 행을 AI 번역·가사 제공 번역으로 보완하지 않는다.
 * AI 번역은 저장된 번역(가사 제공 포함)이 있으면 자동으로 만들지 않으므로, lyrics 위에 AI가 보이는 것은
 * 사용자가 "다시 번역"을 직접 요청한 경우뿐이다.
 */
export function selectTranslation(versions: readonly TranslationVersion[]): TranslationVersion | null {
  return pick(versions);
}

export function selectPronunciation(versions: readonly PronunciationVersion[]): PronunciationVersion | null {
  return pick(versions);
}

function pick<T extends { origin: TranslationOrigin; seq: number }>(versions: readonly T[]): T | null {
  return (
    latest(versions.filter((v) => v.origin === 'user')) ??
    latest(versions.filter((v) => v.origin === 'ai')) ??
    latest(versions.filter((v) => v.origin === 'lyrics'))
  );
}

/** 화면 표시용 출처 이름 */
export function originLabel(kind: 'translation' | 'pronunciation', origin: TranslationOrigin): string {
  const what = kind === 'translation' ? '번역' : '발음';
  if (origin === 'user') return `내 ${what}`;
  if (origin === 'ai') return `AI ${what}`;
  return `가사에 포함된 ${what}`;
}

function latest<T extends { seq: number }>(items: readonly T[]): T | null {
  let best: T | null = null;
  for (const it of items) if (!best || it.seq > best.seq) best = it;
  return best;
}
