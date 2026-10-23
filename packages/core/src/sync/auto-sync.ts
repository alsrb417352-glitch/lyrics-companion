import type { LyricsVersion } from '../model.js';
import { timingTargets } from './user-timing.js';

/**
 * 소리로 싱크 맞추기(REQ-SY-06, docs/plan.md D-44) — 들은 말과 가사 줄을 맞춰 줄 시작 시각을 만든다(순수 함수).
 *
 * 입력은 기기 음성 인식이 재생 소리(스피커 → 마이크)를 듣고 돌려준 "알아들은 말 + 그 말이 들린 재생 위치"다.
 * 노래는 말보다 알아듣기 어려우므로 인식 결과는 틀리고 빠지는 것이 보통이다. 그래서
 *  1. 가사와 들은 말을 글자(일본어·한국어) 또는 단어(영어) 단위로 정렬(순서 유지, 끝부분 자유)해 같은 글자만 짝으로 쓴다.
 *  2. 한 줄에서 충분히 많이 맞은 줄만 "들은 줄"(기준점)로 삼고, 시각이 거꾸로 가는 기준점은 버린다.
 *  3. 기준점 사이의 줄은 글자 수(부르는 시간)와 연(빈 줄) 구분, 그 사이에 들린 소리로 채운다("채운 줄").
 *  4. 기준점이 너무 적으면 저장하지 않는다(엉뚱한 싱크보다 없는 편이 낫다).
 *  5. 소리를 듣지 않은 구간(중간에 멈춤) 뒤의 줄에는 시간을 만들지 않는다(진행을 꾸며내지 않음, 불변조건 5).
 * AI(번역 모델)는 이 과정에 관여하지 않는다. 결과는 "소리로 맞춘 싱크"(method 'auto')로 따로 표시·저장되고,
 * 사용자는 탭 기록으로 고치거나 원래대로 되돌릴 수 있다.
 */

export interface HeardSegment {
  /** 기기 음성 인식이 알아들은 말(불신 데이터: 가사와 비교에만 쓰고 저장·표시·전송하지 않는다) */
  text: string;
  /** 재생 위치 기준 시작·끝(ms) */
  startMs: number;
  endMs: number;
}

export interface AutoSyncInput {
  lyrics: LyricsVersion;
  heard: readonly HeardSegment[];
  /** 실제로 소리를 들은 재생 위치 구간. 이 구간 뒤의 줄에는 시간을 만들지 않는다. */
  coverage: { startMs: number; endMs: number };
  /** 곡 길이(알면). 줄 시각의 상한 */
  durationMs: number | null;
}

export type AutoSyncFailure =
  /** 연주곡 */
  | 'instrumental'
  /** 맞출 줄이 없음 */
  | 'no-lines'
  /** 알아들은 말이 거의 없음(이어폰으로 재생·소리가 작음·마이크 막힘 등) */
  | 'nothing-heard'
  /** 알아들은 말이 가사와 충분히 맞지 않음(다른 곡·잡음·인식 실패) */
  | 'too-few-matches'
  /** 가사·인식 결과가 너무 길어 계산 한도를 넘음 */
  | 'too-long';

export interface AutoSyncStats {
  /** 시간을 맞출 대상 줄(빈 줄 제외) */
  totalLines: number;
  /** 소리로 직접 찾은 줄(기준점) */
  heardLines: number;
  /** 기준점 사이를 글자 수·연 구분으로 채운 줄 */
  filledLines: number;
  /** 시간을 만들지 않은 줄(소리를 듣지 않은 뒤쪽) */
  untimedLines: number;
}

export type AutoSyncResult =
  | ({ ok: true; /** 대상 줄 순서대로 시작 ms(앞에서부터 연속, 비감소) */ taps: number[] } & AutoSyncStats)
  | ({ ok: false; reason: AutoSyncFailure } & AutoSyncStats);

export const AUTO_SYNC_RULES = {
  /** 알아들은 단위(글자·단어)가 이보다 적으면 "들은 것 없음" */
  minHeardUnits: 8,
  /** 기준점(들은 줄)이 시간을 준 줄의 이 비율 이상이어야 저장 */
  minAnchorRatio: 0.2,
  /** 기준점 최소 개수(대상 줄이 이보다 적으면 대상 줄 수) */
  minAnchors: 3,
  /** 한 줄의 글자(단어) 중 이 비율 이상(최소 2개) 맞아야 기준점 */
  lineMatchRatio: 0.2,
  /** 바른 순서로 맞은 수가 뒤집은 가사로 맞은 수(우연 수준)의 이 배 이상이고 */
  minOrderGain: 1.4,
  /** 이만큼 이상 많아야 한다 */
  minOrderMargin: 8,
  /** 곡 안의 상대 위치가 이보다 멀면 같은 글자라도 짝짓지 않는다(전주·간주로 생기는 어긋남을 넉넉히 허용) */
  bandWidth: 0.3,
  /** 정렬 표 크기 상한(가사 단위 수 × 들은 단위 수) */
  maxCells: 16_000_000,
  /** 줄과 줄 사이 숨 고르기(채울 때) */
  lineGapMs: 300,
  /** 연(빈 줄)과 연 사이 기본 간격(채울 때, 들린 소리가 없을 때) */
  stanzaGapMs: 1_500,
  /** 단위 길이를 측정하지 못했을 때: 글자 하나 / 단어 하나 부르는 시간 */
  defaultCharMs: 220,
  defaultWordMs: 380,
} as const;

const MATCH = 6;
const SUB = -3;
const GAP = -2;
const DIAG = 1;
const UP = 2;
const LEFT = 3;
const SUBST = 4;

// ---------------------------------------------------------------- 글자 단위

const WORD_CHAR = /[a-z0-9À-ɏ]/u;
const APOSTROPHE = /['’`]/u;
/** 가나·한자·한글(글자 하나가 비교 단위). 장음 기호(ー)·가운뎃점·탁점 단독 기호는 뺀다 */
const CJK_CHAR = /[ぁ-ゖァ-ヺ㐀-䶿一-鿿豈-﫿가-힯]/u;

function toHiragana(ch: string): string {
  const c = ch.codePointAt(0) ?? 0;
  return c >= 0x30a1 && c <= 0x30f6 ? String.fromCodePoint(c - 0x60) : ch;
}

export interface MatchUnits {
  units: string[];
  /** 단어(라틴 문자) 단위 수 */
  words: number;
}

/**
 * 비교 단위로 나눈다: 가나·한자·한글은 글자 하나, 라틴 문자·숫자는 단어 하나. 문장 부호·공백·기호는 버린다.
 * 가타카나는 히라가나로, 전각·반각은 NFKC로, 영문은 소문자로 맞춘다.
 */
export function matchUnits(text: string): MatchUnits {
  const s = text.normalize('NFKC').toLowerCase();
  const units: string[] = [];
  let words = 0;
  let word = '';
  const flush = () => {
    if (word) {
      units.push(word);
      words++;
      word = '';
    }
  };
  for (const ch of s) {
    if (WORD_CHAR.test(ch)) {
      word += ch;
    } else if (APOSTROPHE.test(ch) && word) {
      // don't, I'm → dont, im (인식 결과와 표기를 맞춤)
    } else {
      flush();
      if (CJK_CHAR.test(ch)) units.push(toHiragana(ch));
    }
  }
  flush();
  return { units, words };
}

// ---------------------------------------------------------------- 정렬

/**
 * 가사 단위 L과 들은 단위 H의 정렬(들은 말의 앞뒤 끝은 자유, 가사 단위는 모두 소비, 빠짐은 감점). 같은 단위끼리 짝지은 (i, j) 목록.
 * band가 있으면 곡 안의 상대 위치(0~1)가 width보다 멀리 떨어진 단위끼리는 짝짓지 않는다(반복되는 후렴 혼동 방지).
 * 표가 너무 크면 null.
 */
export function alignUnits(
  L: readonly string[],
  H: readonly string[],
  band?: { lyricPos: readonly number[]; heardPos: readonly number[]; width: number },
): Array<[number, number]> | null {
  const n = L.length;
  const m = H.length;
  if (n === 0 || m === 0) return [];
  const W = m + 1;
  if ((n + 1) * W > AUTO_SYNC_RULES.maxCells) return null;
  const trace = new Uint8Array((n + 1) * W);
  let prev = new Int32Array(W);
  let cur = new Int32Array(W);
  // 들은 말 앞쪽 잡음은 건너뛰어도 감점 없음(0행), 가사는 처음부터 끝까지 모두 소비한다(빠진 단위는 감점).
  // 가사 끝을 공짜로 남기면 뒤쪽 반복 후렴 소리를 앞쪽 후렴 가사에 붙이고 끝내는 쪽이 유리해지기 때문이다.
  for (let j = 1; j <= m; j++) trace[j] = LEFT;
  for (let i = 1; i <= n; i++) {
    cur[0] = i * GAP;
    trace[i * W] = UP;
    const li = L[i - 1];
    const lp = band ? (band.lyricPos[i - 1] ?? 0) : 0;
    for (let j = 1; j <= m; j++) {
      // 곡 안의 대략적인 위치가 너무 다르면(예: 1절 후렴 글자와 2절 후렴 소리) 같은 글자라도 짝으로 보지 않는다
      const eq = li === H[j - 1] && (!band || Math.abs(lp - (band.heardPos[j - 1] ?? 0)) <= band.width);
      let v = (prev[j - 1] ?? 0) + (eq ? MATCH : SUB);
      let d = eq ? DIAG : SUBST;
      const up = (prev[j] ?? 0) + GAP;
      if (up > v) {
        v = up;
        d = UP;
      }
      const left = (cur[j - 1] ?? 0) + GAP;
      if (left > v) {
        v = left;
        d = LEFT;
      }
      cur[j] = v;
      trace[i * W + j] = d;
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  // 가사를 끝까지 쓴 마지막 행에서 가장 좋은 칸(들은 말 뒤쪽 잡음은 감점 없음)
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestJ = 0;
  for (let j = 0; j <= m; j++) {
    const v = prev[j] ?? 0;
    if (v > bestScore) {
      bestScore = v;
      bestJ = j;
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = n;
  let j = bestJ;
  while (i > 0 && j > 0) {
    const d = trace[i * W + j];
    if (d === DIAG || d === SUBST) {
      if (d === DIAG) pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (d === UP) i--;
    else j--;
  }
  pairs.reverse();
  return pairs;
}

// ---------------------------------------------------------------- 도우미

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  if (s.length === 0) return 0;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** 정렬된 배열에서 x 이상인 첫 값 */
function firstAtLeast(sorted: readonly number[], x: number): number | null {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] as number) < x) lo = mid + 1;
    else hi = mid;
  }
  return lo < sorted.length ? (sorted[lo] as number) : null;
}

/** x 이후 처음으로 "노래가 들리기 시작한" 시각: 들린 단위가 4초 안에 3개 이상 모인 첫 자리(외따로 들린 잡음은 무시) */
function firstCluster(sorted: readonly number[], x: number, minCount = 3, spanMs = 4_000): number | null {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] as number) < x) lo = mid + 1;
    else hi = mid;
  }
  for (let a = lo; a + minCount - 1 < sorted.length; a++) {
    if ((sorted[a + minCount - 1] as number) - (sorted[a] as number) <= spanMs) return sorted[a] as number;
  }
  return null;
}

interface Anchor {
  line: number;
  start: number;
  end: number;
  weight: number;
}

// ---------------------------------------------------------------- 본체

export function alignHeardToLyrics(input: AutoSyncInput): AutoSyncResult {
  const R = AUTO_SYNC_RULES;
  const targets = input.lyrics.kind === 'instrumental' ? [] : timingTargets(input.lyrics);
  const T = targets.length;
  const fail = (reason: AutoSyncFailure, heardLines = 0): AutoSyncResult => ({
    ok: false,
    reason,
    totalLines: T,
    heardLines,
    filledLines: 0,
    untimedLines: T,
  });
  if (input.lyrics.kind === 'instrumental') return fail('instrumental');
  if (T === 0) return fail('no-lines');

  // 대상 줄의 연 번호(빈 줄을 지날 때마다 1씩)
  const stanzaOf: number[] = [];
  {
    let stanza = 0;
    let sawText = false;
    for (const l of input.lyrics.lines) {
      if (l.text.trim() === '') {
        if (sawText) stanza++;
        sawText = false;
      } else {
        stanzaOf.push(stanza);
        sawText = true;
      }
    }
  }

  // 가사 단위
  const L: string[] = [];
  const lineOf: number[] = [];
  const posOf: number[] = [];
  const lineLen: number[] = [];
  let lyricWords = 0;
  for (let k = 0; k < T; k++) {
    const mu = matchUnits((targets[k] as { text: string }).text);
    lyricWords += mu.words;
    lineLen.push(mu.units.length);
    mu.units.forEach((u, p) => {
      L.push(u);
      lineOf.push(k);
      posOf.push(p);
    });
  }

  // 들은 단위(재생 위치 순)
  const heardUnits: Array<{ u: string; t: number }> = [];
  const segs = input.heard
    .filter((s) => Number.isFinite(s.startMs) && Number.isFinite(s.endMs) && s.endMs >= s.startMs)
    .slice()
    .sort((a, b) => a.startMs - b.startMs);
  for (const s of segs) {
    const units = matchUnits(s.text).units;
    const span = s.endMs - s.startMs;
    units.forEach((u, i) => heardUnits.push({ u, t: s.startMs + (span * i) / units.length }));
  }
  heardUnits.sort((a, b) => a.t - b.t);
  if (heardUnits.length < R.minHeardUnits) return fail('nothing-heard');

  // 곡 안의 대략적인 위치(0~1): 가사는 줄 길이 누적, 들은 말은 곡 길이 기준 시각
  const lyricPos: number[] = [];
  {
    const w = lineLen.map((len) => len + 1.5);
    const total = w.reduce((a, b) => a + b, 0) || 1;
    let acc = 0;
    let idx = 0;
    for (let k = 0; k < T; k++) {
      for (let p = 0; p < (lineLen[k] as number); p++) lyricPos[idx++] = (acc + p) / total;
      acc += w[k] as number;
    }
  }
  const songLen = Math.max(
    1,
    input.durationMs ?? 0,
    input.coverage.endMs,
    heardUnits.length > 0 ? (heardUnits[heardUnits.length - 1] as { t: number }).t : 0,
  );
  const H = heardUnits.map((h) => h.u);
  const band = { lyricPos, heardPos: heardUnits.map((h) => h.t / songLen), width: R.bandWidth };
  const pairs = alignUnits(L, H, band);
  if (pairs === null) return fail('too-long');
  // 우연히 맞은 것인지 확인: 가사 순서를 뒤집어 같은 방법으로 맞춰 본다(글자 분포는 같고 순서만 의미 없음).
  // 진짜 곡이면 바른 순서가 뒤집은 순서보다 훨씬 많이 맞는다. 다른 곡·잡음이면 둘이 비슷하다.
  const reversed = alignUnits([...L].reverse(), H, band);
  const chance = reversed?.length ?? 0;
  if (pairs.length < chance * R.minOrderGain || pairs.length - chance < R.minOrderMargin)
    return fail('too-few-matches');

  // 한 단위를 부르는 시간(같은 줄 안에서 맞은 단위 사이 간격의 중앙값)
  const perUnit: number[] = [];
  for (let x = 1; x < pairs.length; x++) {
    const [pi, pj] = pairs[x - 1] as [number, number];
    const [qi, qj] = pairs[x] as [number, number];
    if (lineOf[pi] !== lineOf[qi]) continue;
    const dp = (posOf[qi] as number) - (posOf[pi] as number);
    const dt = (heardUnits[qj] as { t: number }).t - (heardUnits[pj] as { t: number }).t;
    if (dp > 0 && dt > 0) {
      const v = dt / dp;
      if (v >= 40 && v <= 2_000) perUnit.push(v);
    }
  }
  const wordy = L.length > 0 && lyricWords / L.length > 0.5;
  const u = Math.min(
    1_500,
    Math.max(60, perUnit.length >= 8 ? median(perUnit) : wordy ? R.defaultWordMs : R.defaultCharMs),
  );

  // 줄마다 맞은 단위 → 기준점 후보
  // 가사 안에서 드문 단위(2번 이하로 나오는 한자·단어 등)는 우연히 맞기 어렵다
  const unitCount = new Map<string, number>();
  for (const x of L) unitCount.set(x, (unitCount.get(x) ?? 0) + 1);
  const byLine = new Map<number, Array<{ pos: number; t: number; j: number; rare: boolean }>>();
  for (const [i, j] of pairs) {
    const k = lineOf[i] as number;
    let list = byLine.get(k);
    if (!list) byLine.set(k, (list = []));
    list.push({
      pos: posOf[i] as number,
      t: (heardUnits[j] as { t: number }).t,
      j,
      rare: (unitCount.get(L[i] as string) ?? 0) <= 2,
    });
  }
  const candidates: Anchor[] = [];
  const matchedJ = new Map<number, number>(); // heard index → line
  for (let k = 0; k < T; k++) {
    const len = lineLen[k] as number;
    const ms = byLine.get(k);
    if (!ms || len === 0) continue;
    const need = len <= 2 ? len : Math.max(2, Math.ceil(len * R.lineMatchRatio));
    if (ms.length < need) continue;
    // 맞은 단위마다 "이 줄은 언제 시작했나"를 추정해, 서로 가장 많이 들어맞는 묶음만 쓴다
    // (같은 말이 이웃 줄에도 있어 다른 줄 소리가 섞인 경우를 걸러 냄)
    const tol = Math.max(700, len * u * 0.3);
    const est = ms.map((x) => ({ ...x, s: x.t - x.pos * u })).sort((a, b) => a.s - b.s);
    let bestLo = 0;
    let bestN = 0;
    for (let lo = 0, hi = 0; lo < est.length; lo++) {
      while (hi < est.length && (est[hi] as { s: number }).s - (est[lo] as { s: number }).s <= 2 * tol) hi++;
      if (hi - lo > bestN) {
        bestN = hi - lo;
        bestLo = lo;
      }
    }
    if (bestN < need) continue;
    const kept = est.slice(bestLo, bestLo + bestN).sort((a, b) => a.pos - b.pos);
    // 흔한 글자(の·に·て 등) 두 개만 우연히 맞은 줄은 기준점으로 쓰지 않는다:
    // 둘뿐이면 이어서 맞았거나(가사에서도 들은 말에서도 바로 이웃) 드문 단위(한자·드문 단어)가 있어야 한다.
    let adjacent = 0;
    for (let x = 1; x < kept.length; x++) {
      const a = kept[x - 1] as { pos: number; j: number };
      const b = kept[x] as { pos: number; j: number };
      if (b.pos === a.pos + 1 && b.j === a.j + 1) adjacent++;
    }
    const rare = kept.filter((x) => x.rare).length;
    if (kept.length < 3 && adjacent < 1 && rare < 1) continue;
    const first = kept[0] as { pos: number; t: number };
    const last = kept[kept.length - 1] as { pos: number; t: number };
    const head = kept.slice(0, 3).map((x) => x.t - x.pos * u);
    const start = Math.max(input.coverage.startMs, Math.min(first.t, median(head)));
    const end = Math.max(start, last.t + (len - last.pos) * u);
    candidates.push({ line: k, start, end, weight: kept.length });
    for (const x of kept) matchedJ.set(x.j, k);
  }

  // 시각이 줄 순서대로 늘어나는 기준점만 남긴다(가중 최장 증가 부분열)
  const natural = (k: number) => Math.max(1, lineLen[k] as number) * u + R.lineGapMs;
  const prefixNat: number[] = [0];
  for (let k = 0; k < T; k++) prefixNat.push((prefixNat[k] as number) + natural(k));
  const minSpan = (a: Anchor, b: Anchor) =>
    (b.line - a.line) * 150 + 0.2 * ((prefixNat[b.line] as number) - (prefixNat[a.line] as number));
  const best: number[] = [];
  const back: number[] = [];
  for (let x = 0; x < candidates.length; x++) {
    const cx = candidates[x] as Anchor;
    best[x] = cx.weight;
    back[x] = -1;
    for (let y = 0; y < x; y++) {
      const cy = candidates[y] as Anchor;
      if (cx.start - cy.start < minSpan(cy, cx)) continue;
      const v = (best[y] as number) + cx.weight;
      if (v > (best[x] as number)) {
        best[x] = v;
        back[x] = y;
      }
    }
  }
  let endX = -1;
  for (let x = 0; x < candidates.length; x++) if (endX < 0 || (best[x] as number) > (best[endX] as number)) endX = x;
  const anchors: Anchor[] = [];
  for (let x = endX; x >= 0; x = back[x] as number) anchors.push(candidates[x] as Anchor);
  anchors.reverse();
  if (anchors.length === 0) return fail('too-few-matches');
  const anchored = new Set(anchors.map((a) => a.line));

  // 기준점 줄에 쓰이지 않은 들린 소리(채울 때 "여기서 다시 노래가 시작됐다"는 근거)
  const activity = heardUnits
    .map((h, j) => ({ t: h.t, j }))
    .filter((x) => {
      const k = matchedJ.get(x.j);
      return k === undefined || !anchored.has(k);
    })
    .map((x) => x.t);

  // 기준점이 되지 못한 줄의 약한 근거: 한두 글자라도 맞았으면 그 줄이 시작했을 법한 시각
  const hintOf = new Map<number, number>();
  for (const [k, ms] of byLine) {
    if (anchored.has(k) || ms.length === 0) continue;
    hintOf.set(k, median(ms.map((x) => x.t - x.pos * u)));
  }

  const times: Array<number | null> = new Array<number | null>(T).fill(null);
  for (const a of anchors) times[a.line] = a.start;

  const natSum = (ks: readonly number[]) => ks.reduce((s, k) => s + natural(k), 0);
  const proportional = (ks: readonly number[], from: number, to: number) => {
    const total = natSum(ks);
    let acc = 0;
    for (const k of ks) {
      times[k] = from + ((to - from) * acc) / total;
      acc += natural(k);
    }
  };
  const forward = (ks: readonly number[], from: number): number => {
    let t = from;
    for (const k of ks) {
      times[k] = t;
      t += natural(k);
    }
    return t;
  };
  const backward = (ks: readonly number[], to: number): number => {
    let t = to;
    for (let x = ks.length - 1; x >= 0; x--) {
      const k = ks[x] as number;
      t -= natural(k);
      times[k] = t;
    }
    return t;
  };
  const groupsOf = (ks: readonly number[]): number[][] => {
    const gs: number[][] = [];
    for (const k of ks) {
      const g = gs[gs.length - 1];
      if (g && stanzaOf[g[0] as number] === stanzaOf[k]) g.push(k);
      else gs.push([k]);
    }
    return gs;
  };
  /** 떨어진 연(앞뒤 기준점과 다른 연)들을 [from, to] 안에 놓는다: 들린 소리가 있으면 거기서, 없으면 고르게 */
  /**
   * 한 연(연속 줄)의 시작 시각을 약한 근거들로 추정(줄마다 "연 시작 = 그 줄 근거 − 앞 줄들의 부르는 시간").
   * 근거가 둘 이상이고 서로 1.5초 안에서 맞으면 strong, 하나뿐이면 weak, 서로 어긋나면 쓰지 않는다.
   */
  const hintStart = (ks: readonly number[]): { at: number; strong: boolean } | null => {
    const c: number[] = [];
    let off = 0;
    for (const k of ks) {
      const h = hintOf.get(k);
      if (h !== undefined) c.push(h - off);
      off += natural(k);
    }
    if (c.length === 0) return null;
    if (c.length === 1) return { at: c[0] as number, strong: false };
    const spread = Math.max(...c) - Math.min(...c);
    return spread <= 1_500 ? { at: median(c), strong: true } : null;
  };
  /** 연 시작 고르기: 서로 맞는 약한 근거 → 다시 노래가 들린 곳(묶음) → 근거 하나 → 없음 */
  const stanzaStart = (ks: readonly number[], lo: number, hi: number, cluster: number | null): number | null => {
    const h = hintStart(ks);
    const okH = h !== null && h.at >= lo && h.at <= hi ? h : null;
    if (okH?.strong) return okH.at;
    if (cluster !== null && cluster - 150 <= hi) return Math.max(lo, cluster - 150);
    return okH ? okH.at : null;
  };
  const placeDetached = (gs: readonly number[][], from: number, to: number) => {
    if (gs.length === 0) return;
    const nats = gs.map(natSum);
    const totalNat = nats.reduce((a, b) => a + b, 0);
    if (to - from <= totalNat) {
      proportional(gs.flat(), from, to);
      return;
    }
    const gap = (to - from - totalNat) / (gs.length + 1);
    let cursor = from;
    for (let g = 0; g < gs.length; g++) {
      const ks = gs[g] as number[];
      const rest = nats.slice(g).reduce((a, b) => a + b, 0);
      const latest = to - rest;
      // 그 연의 줄과 조금이라도 맞은 소리 → 다시 노래가 들린 곳 → 고르게
      const start = stanzaStart(ks, cursor, latest, firstCluster(activity, cursor + 300)) ?? cursor + gap;
      cursor = forward(ks, Math.min(start, latest));
    }
  };

  // 기준점 사이
  for (let x = 1; x < anchors.length; x++) {
    const a = anchors[x - 1] as Anchor;
    const b = anchors[x] as Anchor;
    if (b.line - a.line < 2) continue;
    const ks: number[] = [];
    for (let k = a.line + 1; k < b.line; k++) ks.push(k);
    const from = Math.max(a.start, Math.min(a.end, b.start));
    const to = b.start;
    const nat = natSum(ks);
    if (to - from <= nat * 1.6) {
      proportional(ks, from, to);
      continue;
    }
    const gs = groupsOf(ks);
    const sa = stanzaOf[a.line];
    const sb = stanzaOf[b.line];
    const firstG = gs[0] as number[];
    const lastG = gs[gs.length - 1] as number[];
    if (gs.length === 1 && stanzaOf[firstG[0] as number] === sa && sa === sb) {
      // 같은 연 안에서 간격이 긴 경우: 다시 소리가 들린 곳부터
      const heard = firstCluster(activity, from + 300);
      const start = heard !== null && heard < to - nat * 0.5 ? Math.max(from, heard - 150) : from;
      if (to - start <= nat * 1.6) proportional(ks, start, to);
      else forward(ks, start);
      continue;
    }
    let lo = from;
    let hi = to;
    let rest = gs;
    if (stanzaOf[firstG[0] as number] === sa) {
      lo = forward(firstG, from);
      rest = rest.slice(1);
    }
    const restLast = rest[rest.length - 1];
    if (restLast && restLast === lastG && stanzaOf[lastG[0] as number] === sb) {
      hi = backward(lastG, to);
      rest = rest.slice(0, -1);
    }
    if (hi < lo) {
      proportional(ks, from, to);
      continue;
    }
    placeDetached(rest, lo, hi);
  }

  // 첫 기준점 앞: 앞 줄들은 첫 기준점 바로 앞에서 부른다고 보고 거꾸로 놓는다(전주 동안 강조하지 않게).
  // 그보다 훨씬 앞에서 노래(들린 소리 묶음)가 시작됐으면 첫 기준점과 다른 연은 들린 곳부터 놓는다.
  const firstA = anchors[0] as Anchor;
  if (firstA.line > 0) {
    const ks: number[] = [];
    for (let k = 0; k < firstA.line; k++) ks.push(k);
    const floor = Math.max(0, input.coverage.startMs);
    const gs = groupsOf(ks);
    const lastG = gs[gs.length - 1] as number[];
    const attached = stanzaOf[lastG[0] as number] === stanzaOf[firstA.line];
    let t = firstA.start;
    for (let g = gs.length - 1; g >= 0; g--) {
      if (!(attached && g === gs.length - 1)) t -= R.stanzaGapMs;
      t = backward(gs[g] as number[], t);
    }
    const sing = firstCluster(activity, floor);
    if (t < floor) {
      proportional(ks, floor, Math.max(floor, firstA.start));
    } else if (sing !== null && sing < t - 2_000) {
      const hi = attached ? backward(lastG, firstA.start) : firstA.start;
      const rest = attached ? gs.slice(0, -1) : gs;
      if (rest.length > 0 && hi > sing) placeDetached(rest, Math.max(floor, sing - 450), hi);
      else if (rest.length === 0 && sing < firstA.start) {
        const from = Math.max(floor, sing - 150);
        if (firstA.start - from <= natSum(ks) * 1.6) proportional(ks, from, firstA.start);
      }
    }
  }

  // 마지막 기준점 뒤: 같은 연은 이어서, 다음 연은 소리가 다시 들린 곳부터. 듣지 않은 구간은 비워 둔다.
  const lastA = anchors[anchors.length - 1] as Anchor;
  const limit = Math.min(input.coverage.endMs, input.durationMs ?? Number.POSITIVE_INFINITY);
  if (lastA.line < T - 1) {
    const ks: number[] = [];
    for (let k = lastA.line + 1; k < T; k++) ks.push(k);
    let cursor = Math.max(lastA.start, lastA.end);
    let prevStanza = stanzaOf[lastA.line];
    for (const k of ks) {
      if (stanzaOf[k] !== prevStanza) {
        // 다음 연은 그 연과 조금이라도 맞은 소리 → 다시 노래가 들린 곳(묶음, 없으면 외따로 들린 소리) → 기본 간격
        const group = ks.filter((x) => x >= k && stanzaOf[x] === stanzaOf[k]);
        const heard = firstCluster(activity, cursor + 300) ?? firstAtLeast(activity, cursor + 2_000);
        cursor =
          stanzaStart(group, cursor, limit, heard !== null && heard < limit ? heard : null) ?? cursor + R.stanzaGapMs;
        prevStanza = stanzaOf[k];
      }
      if (cursor > limit - 300) break;
      times[k] = cursor;
      cursor += natural(k);
    }
  }

  // 앞에서부터 연속·비감소·정수로 정리
  const taps: number[] = [];
  let prev = 0;
  for (let k = 0; k < T; k++) {
    const t = times[k];
    if (t === null || t === undefined || !Number.isFinite(t)) break;
    const v = Math.max(prev, Math.round(Math.max(0, t)));
    taps.push(v);
    prev = v;
  }
  const heardLines = anchors.filter((a) => a.line < taps.length).length;
  const stats: AutoSyncStats = {
    totalLines: T,
    heardLines,
    filledLines: taps.length - heardLines,
    untimedLines: T - taps.length,
  };
  const need = Math.max(Math.min(R.minAnchors, T), Math.ceil(taps.length * R.minAnchorRatio));
  if (taps.length === 0 || heardLines < need) return { ok: false, reason: 'too-few-matches', ...stats };
  return { ok: true, taps, ...stats };
}

// ---------------------------------------------------------------- 인식 설정

/** 기기 음성 인식에 쓸 언어(가사 언어 기준). 맞출 수 없는 가사면 null */
export function autoSyncLocale(lyrics: LyricsVersion): 'ja-JP' | 'en-US' | 'ko-KR' | null {
  if (lyrics.kind === 'instrumental') return null;
  switch (lyrics.language) {
    case 'ja':
    case 'mixed':
      return lyrics.lines.some((l) => /[ぁ-ゖァ-ヺ]/u.test(l.text)) ? 'ja-JP' : 'ko-KR';
    case 'en':
      return 'en-US';
    case 'ko':
      return 'ko-KR';
    default:
      return null;
  }
}

export const AUTO_SYNC_HINT_LIMITS = { maxHints: 100, maxHintChars: 100 } as const;

/**
 * 인식기에 "이런 말이 나올 수 있다"고 알려 줄 가사 줄(기기 안 인식기에만 전달, 외부 전송 없음).
 * 중복·빈 줄을 빼고 개수·길이를 제한한다.
 */
export function autoSyncHints(lyrics: LyricsVersion): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const l of lyrics.lines) {
    const t = l.text.trim().slice(0, AUTO_SYNC_HINT_LIMITS.maxHintChars);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= AUTO_SYNC_HINT_LIMITS.maxHints) break;
  }
  return out;
}
