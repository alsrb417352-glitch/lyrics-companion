import { kanaToHangul } from '../pronunciation/kana-to-hangul.js';
import { hasHangul, hasJapaneseScript, hasKana } from '../util/text.js';

/**
 * 가사 안에 함께 들어 있는 한국어 줄(한국어 뜻·한글 발음) 나누기 (docs/plan.md D-43).
 *
 * LRCLIB에는 "원문 / 한글 발음 / 한국어 뜻"을 줄마다 번갈아 적은 가사가 있다(2026-10-19 실제 레코드 확인).
 * 이런 가사를 그대로 원문으로 저장하면 한 소절이 세 줄로 보이고 AI 번역에 한국어 줄까지 보내게 되므로,
 * 구조가 확실할 때만 원문 줄과 한국어 줄을 나눠 원문 줄 번호에 붙인다.
 *
 * 원칙(보수적)
 * - 줄 구조가 일정할 때만 나눈다: 원문 줄 대부분(70% 이상, 일본어가 아니면 90%)이 같은 개수(1개 또는 2개)의
 *   한국어 줄을 바로 뒤(또는 바로 앞)에 달고 있어야 한다. 아니면 나누지 않고 입력을 그대로 둔다.
 * - 한글 발음/한국어 뜻 구분은 일본어 원문에서만 한다: 원문의 가나를 한글 독음으로 바꾼 음절이 한국어 줄에
 *   순서대로 들어 있는지(최장 공통 부분열) + 일본어 독음에 쓰이는 음절 모양인지로 판정하고,
 *   곡 전체에서 다수결로 "몇 번째 줄이 발음인지"를 정한다. 판정이 갈리면 나누지 않는다.
 * - 일본어가 아닌 원문(영어 등)은 한 줄씩 붙은 한국어 줄을 뜻으로만 본다(발음 구분 안 함).
 * - 시간 정보는 원문 줄의 것만 남긴다(한국어 줄의 시간으로 원문 시간을 만들거나 바꾸지 않음 — 불변조건 5).
 * - 어느 원문에도 붙지 않은 한국어 줄(머리말·출처 표기 등)은 나눌 때 버린다.
 * - 가사 속 글은 데이터로만 다룬다(불변조건 9).
 */

export interface EmbeddedKorean {
  /** 나눈 뒤 원문 행 순번(0부터) → 한국어 뜻 */
  meaning: Record<number, string>;
  /** 나눈 뒤 원문 행 순번(0부터) → 한글 발음 */
  pronunciation: Record<number, string>;
}

export interface EmbeddedSplit<T> {
  /** 나눈 뒤의 원문 행(나누지 않았으면 입력 그대로) */
  lines: T[];
  /** null이면 나누지 않음 */
  embedded: EmbeddedKorean | null;
}

type Kind = 'blank' | 'korean' | 'original';

const LETTER = /\p{L}/u;

function kindOf(text: string): Kind {
  const t = text.trim();
  if (t === '') return 'blank';
  if (hasHangul(t) && !hasJapaneseScript(t)) return 'korean';
  return 'original';
}

// ------------------------------------------------------------------ 한글 음절 판정

const HANGUL_FIRST = 0xac00;
const HANGUL_LAST = 0xd7a3;

function syllables(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c >= HANGUL_FIRST && c <= HANGUL_LAST) out.push(c - HANGUL_FIRST);
  }
  return out;
}

const initialOf = (s: number) => Math.floor(s / 588);
const medialOf = (s: number) => Math.floor((s % 588) / 28);
const finalOf = (s: number) => s % 28;

/** 일본어 한글 독음에 쓰이는 모음: ㅏ ㅑ ㅔ ㅖ ㅗ ㅘ ㅛ ㅜ ㅝ ㅞ ㅟ ㅠ ㅣ (ㅡ는 스·즈·츠·쯔·쓰만) */
const JA_MEDIALS = new Set([0, 2, 5, 7, 8, 9, 12, 13, 14, 15, 16, 17, 20]);
const SIBILANT_INITIALS = new Set([9, 10, 12, 13, 14]);
/** 받침: 없음, ㄱ ㄴ ㄷ ㅁ ㅂ ㅅ ㅇ (ん·っ 표기) */
const JA_FINALS = new Set([0, 1, 4, 7, 16, 17, 19, 21]);

function isJapaneseLikeSyllable(s: number): boolean {
  const m = medialOf(s);
  const okMedial = JA_MEDIALS.has(m) || (m === 18 && SIBILANT_INITIALS.has(initialOf(s)));
  return okMedial && JA_FINALS.has(finalOf(s));
}

// 자음은 예사·거센·된소리를 묶고(か→카/까/가), 모음은 ㅐ→ㅔ, ㅡ→ㅜ로 묶어 비교한다.
// prettier-ignore
const INITIAL_CLASS = ['K','K','N','T','T','R','M','P','P','S','S','','C','C','C','K','T','P','H'];
// prettier-ignore
const MEDIAL_CLASS = ['a','e','ya','ye','eo','e','yeo','ye','o','wa','wae','oe','yo','u','wo','we','wi','yu','u','ui','i'];

function keyOf(s: number): string {
  return `${INITIAL_CLASS[initialOf(s)] ?? '?'}${MEDIAL_CLASS[medialOf(s)] ?? '?'}`;
}

/** 조사 は·へ를 わ·え로 읽어 적는 표기 허용 */
function keyMatches(expected: string, actual: string): boolean {
  return expected === actual || (expected === 'Ha' && actual === 'wa') || (expected === 'He' && actual === 'e');
}

/** 원문의 가나 부분을 한글 독음 음절 키로(한자는 읽기를 모르므로 건너뜀) */
function expectedKeys(original: string): string[] {
  const runs = original.normalize('NFKC').match(/[぀-ゟ゠-ヿ]+/gu) ?? [];
  const keys: string[] = [];
  for (const run of runs) for (const s of syllables(kanaToHangul(run))) keys.push(keyOf(s));
  return keys;
}

function lcsLength(a: readonly string[], b: readonly string[]): number {
  let prev = new Array<number>(b.length + 1).fill(0);
  for (const x of a) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      cur[j] = keyMatches(x, b[j - 1] as string)
        ? (prev[j - 1] as number) + 1
        : Math.max(prev[j] as number, cur[j - 1] as number);
    }
    prev = cur;
  }
  return prev[b.length] as number;
}

/** 한국어 줄이 일본어 원문 줄의 한글 발음처럼 보이는지 */
export function looksLikePronunciation(korean: string, original: string): boolean {
  const syl = syllables(korean);
  if (syl.length === 0) return false;
  const compat = syl.filter(isJapaneseLikeSyllable).length / syl.length;
  const expected = expectedKeys(original);
  if (expected.length >= 3) {
    const ratio = lcsLength(expected, syl.map(keyOf)) / expected.length;
    return ratio >= 0.5 && compat >= 0.7;
  }
  // 가나가 거의 없는 줄(한자·영어 위주)은 음절 모양만으로 판단
  return compat >= 0.9 && syl.length >= 2;
}

// ------------------------------------------------------------------ 구조 분석

type Direction = 'after' | 'before';

interface Attachment {
  dir: Direction;
  /** 원문 줄 index → 붙은 한국어 줄 index 목록(원래 순서) */
  groups: Map<number, number[]>;
  unattached: number;
  /** 가장 흔한 한국어 줄 개수 */
  modal: number;
  consistency: number;
  coverage: number;
  /** 발음으로 보이는 줄이 붙은 원문 수(일본어만) */
  pronGroups: number;
}

function attach(
  texts: readonly string[],
  kinds: readonly Kind[],
  counted: readonly number[],
  dir: Direction,
  japanese: boolean,
): Attachment {
  const groups = new Map<number, number[]>();
  let unattached = 0;
  const order = kinds.map((_, i) => i);
  if (dir === 'before') order.reverse();
  let anchor = -1;
  for (const i of order) {
    const k = kinds[i];
    if (k === 'original') {
      anchor = i;
      if (!groups.has(i)) groups.set(i, []);
    } else if (k === 'korean') {
      if (anchor < 0) unattached++;
      else groups.get(anchor)?.push(i);
    }
  }
  if (dir === 'before') for (const g of groups.values()) g.reverse();

  const freq = new Map<number, number>();
  for (const o of counted) {
    const n = groups.get(o)?.length ?? 0;
    freq.set(n, (freq.get(n) ?? 0) + 1);
  }
  let modal = 0;
  let best = -1;
  for (const [n, c] of freq) {
    if (c > best || (c === best && n > modal)) {
      modal = n;
      best = c;
    }
  }
  const total = Math.max(1, counted.length);
  const covered = counted.filter((o) => (groups.get(o)?.length ?? 0) > 0).length;
  let pronGroups = 0;
  if (japanese) {
    for (const o of counted) {
      const g = groups.get(o) ?? [];
      if (g.some((k) => looksLikePronunciation(texts[k] ?? '', texts[o] ?? ''))) pronGroups++;
    }
  }
  return { dir, groups, unattached, modal, consistency: best / total, coverage: covered / total, pronGroups };
}

interface Roles {
  meaning: Map<number, string>;
  pronunciation: Map<number, string>;
}

function joinLines(texts: readonly string[], idx: readonly number[]): string {
  return idx
    .map((i) => (texts[i] ?? '').replace(/\s+/g, ' ').trim())
    .filter((t) => t !== '')
    .join(' ');
}

function assignRoles(texts: readonly string[], a: Attachment, japanese: boolean): Roles | null {
  const meaning = new Map<number, string>();
  const pronunciation = new Map<number, string>();
  const like = (k: number, o: number) => japanese && looksLikePronunciation(texts[k] ?? '', texts[o] ?? '');

  if (!japanese) {
    if (a.modal !== 1) return null;
    for (const [o, g] of a.groups) if (g.length > 0) meaning.set(o, joinLines(texts, g));
    return { meaning, pronunciation };
  }

  if (a.modal === 1) {
    let pron = 0;
    let all = 0;
    for (const [o, g] of a.groups) {
      for (const k of g) {
        all++;
        if (like(k, o)) pron++;
      }
    }
    const frac = all === 0 ? 0 : pron / all;
    if (frac > 0.3 && frac < 0.7) return null; // 발음인지 뜻인지 갈림 → 나누지 않음
    const target = frac >= 0.7 ? pronunciation : meaning;
    for (const [o, g] of a.groups) if (g.length > 0) target.set(o, joinLines(texts, g));
    return { meaning, pronunciation };
  }

  if (a.modal === 2) {
    // 두 줄 묶음에서 몇 번째 줄이 발음인지 다수결
    const votes = [0, 0];
    let pairs = 0;
    for (const [o, g] of a.groups) {
      if (g.length !== 2) continue;
      pairs++;
      const l0 = like(g[0] as number, o);
      const l1 = like(g[1] as number, o);
      if (l0 && !l1) votes[0] = (votes[0] ?? 0) + 1;
      if (l1 && !l0) votes[1] = (votes[1] ?? 0) + 1;
    }
    const v0 = votes[0] ?? 0;
    const v1 = votes[1] ?? 0;
    const slot = v0 > v1 ? 0 : v1 > v0 ? 1 : -1;
    if (slot < 0 || Math.max(v0, v1) < pairs * 0.5) return null;
    for (const [o, g] of a.groups) {
      if (g.length === 0) continue;
      if (g.length === 1) {
        const k = g[0] as number;
        (like(k, o) ? pronunciation : meaning).set(o, joinLines(texts, [k]));
        continue;
      }
      const p = g[slot] as number;
      const rest = g.filter((k) => k !== p);
      if (like(p, o)) pronunciation.set(o, joinLines(texts, [p]));
      else rest.unshift(p);
      rest.sort((x, y) => x - y);
      const m = joinLines(texts, rest);
      if (m !== '') meaning.set(o, m);
    }
    return { meaning, pronunciation };
  }
  return null;
}

/**
 * 원문 줄과 한국어 줄이 번갈아 적힌 가사를 나눈다. 확실하지 않으면 embedded=null, lines=입력 그대로.
 * @param blanks 'keep' — 원문 묶음 사이 빈 줄을 모두 둔다(싱크 가사: 빈 줄도 시각을 가짐),
 *               'stanza' — 묶음 사이 빈 줄이 평소보다 많은 곳에만 빈 줄 하나를 둔다(일반 가사)
 */
export function splitEmbeddedKorean<T extends { text: string }>(
  input: readonly T[],
  blanks: 'keep' | 'stanza',
): EmbeddedSplit<T> {
  const unchanged: EmbeddedSplit<T> = { lines: [...input], embedded: null };
  const texts = input.map((l) => l.text);
  const kinds = texts.map(kindOf);
  const originals = kinds.flatMap((k, i) => (k === 'original' ? [i] : []));
  const koreanCount = kinds.filter((k) => k === 'korean').length;
  // 글자가 있는 원문 줄만 구조 판단에 쓴다(♪·(x2) 같은 줄 제외)
  const counted = originals.filter((i) => LETTER.test(texts[i] ?? ''));
  if (koreanCount === 0 || counted.length < 4) return unchanged;

  const japaneseLines = counted.filter((i) => hasJapaneseScript(texts[i] ?? '')).length;
  const japanese = japaneseLines / counted.length >= 0.5 && counted.some((i) => hasKana(texts[i] ?? ''));
  if (!japanese && counted.length < 8) return unchanged;

  const after = attach(texts, kinds, counted, 'after', japanese);
  const before = attach(texts, kinds, counted, 'before', japanese);
  const score = (a: Attachment) => [a.pronGroups, a.consistency, -a.unattached] as const;
  const sa = score(after);
  const sb = score(before);
  const pickBefore = sb[0] > sa[0] || (sb[0] === sa[0] && (sb[1] > sa[1] || (sb[1] === sa[1] && sb[2] > sa[2])));
  const a = pickBefore ? before : after;

  const minRatio = japanese ? 0.7 : 0.9;
  if (a.modal < 1 || a.modal > 2) return unchanged;
  if (a.consistency < minRatio || a.coverage < minRatio) return unchanged;
  if (a.unattached > Math.max(2, koreanCount * 0.1)) return unchanged;

  const roles = assignRoles(texts, a, japanese);
  if (!roles || (roles.meaning.size === 0 && roles.pronunciation.size === 0)) return unchanged;

  // 다음으로 나오는 글자 있는 줄의 종류(빈 줄 처리용)
  const nextKind: Array<Kind | null> = new Array<Kind | null>(kinds.length).fill(null);
  for (let i = kinds.length - 2; i >= 0; i--) {
    const k = kinds[i + 1] as Kind;
    nextKind[i] = k === 'blank' ? (nextKind[i + 1] ?? null) : k;
  }

  // 'stanza': 원문 묶음 사이 빈 줄 수가 평소(중앙값)보다 많은 곳에만 빈 줄 하나
  const stanzaBreak = new Map<number, number>(); // 원문 줄 → 그 앞에 둘 빈 줄
  if (blanks === 'stanza') {
    const gaps: Array<{ at: number; blanks: number; first: number }> = [];
    let run: number[] = [];
    let prevOriginal = false;
    kinds.forEach((k, i) => {
      if (k === 'blank') run.push(i);
      else if (k === 'korean')
        run = []; // 한국어 줄 앞 빈 줄은 묶음 안 빈 줄
      else {
        if (prevOriginal) gaps.push({ at: i, blanks: run.length, first: run[0] ?? -1 });
        run = [];
        prevOriginal = true;
      }
    });
    const sorted = gaps.map((g) => g.blanks).sort((x, y) => x - y);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    for (const g of gaps) if (g.blanks > median && g.first >= 0) stanzaBreak.set(g.at, g.first);
  }

  const lines: T[] = [];
  const meaning: Record<number, string> = {};
  const pronunciation: Record<number, string> = {};
  kinds.forEach((k, i) => {
    if (k === 'korean') return;
    if (k === 'blank') {
      // 'keep'(싱크): 빈 줄도 시각을 가지므로 한국어 줄 바로 앞(묶음 안)이 아니면 모두 둔다
      if (blanks === 'keep' && nextKind[i] !== 'korean') lines.push(input[i] as T);
      return;
    }
    const br = stanzaBreak.get(i);
    if (br !== undefined && lines.length > 0) lines.push(input[br] as T);
    const at = lines.length;
    lines.push(input[i] as T);
    const m = roles.meaning.get(i);
    const pr = roles.pronunciation.get(i);
    if (m !== undefined) meaning[at] = m;
    if (pr !== undefined) pronunciation[at] = pr;
  });
  return { lines, embedded: { meaning, pronunciation } };
}

/** 나눈 결과의 한국어 뜻·발음이 곡 전체에 걸쳐 있는지(일부 줄만 있으면 "지원"으로 보지 않음) */
export function embeddedCoverage(
  lines: readonly { text: string }[],
  embedded: EmbeddedKorean | null,
): { meaning: boolean; pronunciation: boolean } {
  if (!embedded) return { meaning: false, pronunciation: false };
  const lettered = lines.map((l, i) => [l.text, i] as const).filter(([t]) => LETTER.test(t));
  const japanese = lettered.filter(([t]) => hasJapaneseScript(t));
  const m = lettered.filter(([, i]) => embedded.meaning[i] !== undefined).length;
  const p = japanese.filter(([, i]) => embedded.pronunciation[i] !== undefined).length;
  return {
    meaning: lettered.length > 0 && m >= lettered.length * 0.5,
    pronunciation: japanese.length > 0 && p >= japanese.length * 0.5,
  };
}
