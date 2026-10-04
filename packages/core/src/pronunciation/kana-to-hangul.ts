/**
 * 가나 → 한글 독음 변환(결정적 규칙).
 *
 * 가정(docs/product.md "발음 정의" 참고):
 * - 입력은 "발음 기준" 가나 읽기다. 조사 は/へ/を는 AI 단계에서 わ/え/お로 이미 바뀌어 있어야 한다.
 * - 목적은 한국어 사용자가 따라 부르기 위한 근사 표기이며, 국립국어원 외래어 표기법과 다르다.
 *   (어두 청음도 격음으로: か→카, た→타 / つ→츠 / ん→ㄴ 받침 / っ→ㅅ 받침 / 장음 ー → '-')
 * - 한자는 변환하지 않는다(읽기에 한자가 남아 있으면 검증 단계에서 거부).
 * - 가나가 아닌 문자(영문, 숫자, 문장부호, 공백)는 그대로 둔다.
 * 사용자는 행별로 한글 독음을 직접 수정할 수 있다.
 */

// prettier-ignore
const BASE: Record<string, string> = {
  あ: '아', い: '이', う: '우', え: '에', お: '오',
  か: '카', き: '키', く: '쿠', け: '케', こ: '코',
  が: '가', ぎ: '기', ぐ: '구', げ: '게', ご: '고',
  さ: '사', し: '시', す: '스', せ: '세', そ: '소',
  ざ: '자', じ: '지', ず: '즈', ぜ: '제', ぞ: '조',
  た: '타', ち: '치', つ: '츠', て: '테', と: '토',
  だ: '다', ぢ: '지', づ: '즈', で: '데', ど: '도',
  な: '나', に: '니', ぬ: '누', ね: '네', の: '노',
  は: '하', ひ: '히', ふ: '후', へ: '헤', ほ: '호',
  ば: '바', び: '비', ぶ: '부', べ: '베', ぼ: '보',
  ぱ: '파', ぴ: '피', ぷ: '푸', ぺ: '페', ぽ: '포',
  ま: '마', み: '미', む: '무', め: '메', も: '모',
  や: '야', ゆ: '유', よ: '요',
  ら: '라', り: '리', る: '루', れ: '레', ろ: '로',
  わ: '와', ゐ: '이', ゑ: '에', を: '오',
  ゔ: '부',
  ぁ: '아', ぃ: '이', ぅ: '우', ぇ: '에', ぉ: '오',
  ゃ: '야', ゅ: '유', ょ: '요', ゎ: '와',
};

/** 요음·외래음 조합(두 글자) */
// prettier-ignore
const DIGRAPH: Record<string, string> = {
  きゃ: '캬', きゅ: '큐', きょ: '쿄', ぎゃ: '갸', ぎゅ: '규', ぎょ: '교',
  しゃ: '샤', しゅ: '슈', しょ: '쇼', じゃ: '자', じゅ: '주', じょ: '조',
  ちゃ: '차', ちゅ: '추', ちょ: '초', ぢゃ: '자', ぢゅ: '주', ぢょ: '조',
  にゃ: '냐', にゅ: '뉴', にょ: '뇨', ひゃ: '햐', ひゅ: '휴', ひょ: '효',
  びゃ: '뱌', びゅ: '뷰', びょ: '뵤', ぴゃ: '퍄', ぴゅ: '퓨', ぴょ: '표',
  みゃ: '먀', みゅ: '뮤', みょ: '묘', りゃ: '랴', りゅ: '류', りょ: '료',
  しぇ: '셰', じぇ: '제', ちぇ: '체', いぇ: '예',
  ふぁ: '화', ふぃ: '휘', ふぇ: '훼', ふぉ: '훠', ふゅ: '휴',
  うぃ: '위', うぇ: '웨', うぉ: '워',
  てぃ: '티', でぃ: '디', とぅ: '투', どぅ: '두', てゅ: '튜', でゅ: '듀',
  ゔぁ: '바', ゔぃ: '비', ゔぇ: '베', ゔぉ: '보',
  つぁ: '차', つぃ: '치', つぇ: '체', つぉ: '초',
  くぁ: '콰', ぐぁ: '과',
};

const HANGUL_BASE = 0xac00;
const JONG_N = 4; // ㄴ
const JONG_S = 19; // ㅅ

/** 가타카나(반각 포함)를 히라가나로 정규화 */
export function toHiragana(input: string): string {
  return input.normalize('NFKC').replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

function isHangulSyllable(ch: string | undefined): boolean {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  return code >= HANGUL_BASE && code <= 0xd7a3;
}

/** 마지막 한글 음절에 받침을 붙인다. 이미 받침이 있으면 false */
function addFinal(out: string[], jong: number): boolean {
  const last = out[out.length - 1];
  if (!isHangulSyllable(last) || last === undefined) return false;
  const code = last.charCodeAt(0) - HANGUL_BASE;
  if (code % 28 !== 0) return false;
  out[out.length - 1] = String.fromCharCode(HANGUL_BASE + code + jong);
  return true;
}

export function kanaToHangul(kana: string): string {
  const s = Array.from(toHiragana(kana));
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    const next = s[i + 1];
    if (ch === 'ん') {
      if (!addFinal(out, JONG_N)) out.push('응');
      continue;
    }
    if (ch === 'っ') {
      // 다음 글자가 가나일 때만 촉음으로 처리(문장 끝 っ는 무시)
      if (next !== undefined && (BASE[next] !== undefined || next === 'ん')) addFinal(out, JONG_S);
      continue;
    }
    if (ch === 'ー') {
      out.push('-');
      continue;
    }
    if (next !== undefined) {
      const di = DIGRAPH[ch + next];
      if (di) {
        out.push(di);
        i++;
        continue;
      }
    }
    const base = BASE[ch];
    out.push(base ?? ch);
  }
  return out.join('');
}

/** 발음 읽기로 허용하는 문자: 가나, 장음, 공백, ASCII, 일반 문장부호 */
const READING_ALLOWED = /^[぀-ゟ゠-ヿｦ-ﾟ\s -~、。「」『』！？・…〜～ー♪☆★（）]*$/u;

export function isValidKanaReading(reading: string): boolean {
  return READING_ALLOWED.test(reading.normalize('NFC'));
}
