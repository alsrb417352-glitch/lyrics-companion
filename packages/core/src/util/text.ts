import type { Lang } from '../model.js';

/** 제어 문자 제거(탭은 공백으로), BOM 제거, 줄바꿈 LF 통일 */
export function sanitizeMultiline(input: string): string {
  return (
    input
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      .replace(/\t/g, ' ')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
  );
}

/** 한 줄 텍스트 정리(줄바꿈 포함 제어 문자 제거) */
export function sanitizeLine(input: string): string {
  return sanitizeMultiline(input).replace(/\n/g, ' ');
}

const KANA = /[぀-ゟ゠-ヿㇰ-ㇿｦ-ﾟ]/u;
const KANJI = /[㐀-䶿一-鿿豈-﫿]/u;
const HANGUL = /[가-힯ᄀ-ᇿ㄰-㆏]/u;
const LATIN = /[A-Za-z]/;

/** 행에 일본어 문자(가나 또는 한자)가 있는지 */
export function hasJapaneseScript(text: string): boolean {
  return KANA.test(text) || KANJI.test(text);
}

export function hasKanji(text: string): boolean {
  return KANJI.test(text);
}

/**
 * 곡 단위 언어 추정(문자 체계 비율 기반 휴리스틱).
 * 가나가 하나라도 있으면 일본어 곡으로 본다(일본어 곡 안의 영어 행 허용).
 * 한자만 있고 가나가 없으면 중국어일 수 있으므로 unknown.
 */
export function detectLanguage(lines: readonly string[]): Lang {
  let kana = 0;
  let kanji = 0;
  let hangul = 0;
  let latin = 0;
  for (const line of lines) {
    for (const ch of line) {
      if (KANA.test(ch)) kana++;
      else if (KANJI.test(ch)) kanji++;
      else if (HANGUL.test(ch)) hangul++;
      else if (LATIN.test(ch)) latin++;
    }
  }
  const total = kana + kanji + hangul + latin;
  if (total === 0) return 'unknown';
  if (kana > 0) return hangul / total > 0.3 ? 'mixed' : 'ja';
  if (hangul / total > 0.5) return 'ko';
  if (latin / total > 0.8) return 'en';
  if (hangul > 0 && latin > 0) return 'mixed';
  return 'unknown';
}
