import type { LyricLine, LyricsKind, LyricsVersion, UserTimingVersion } from '../model.js';

/**
 * 수동 싱크(사용자가 탭으로 기록한 행 시작 시각, docs/plan.md D-28).
 *
 * 규칙
 * - 시간은 사람이 재생을 들으며 탭한 재생 위치만 쓴다. AI·추정으로 만들지 않는다(불변조건 5).
 * - 가사 판본(원문·행 ID)은 바꾸지 않는다. 그래서 번역·발음 연결이 그대로 유지된다.
 * - 기록 대상은 빈 행이 아닌 행이고, 가사 순서대로 앞에서부터 연속으로 기록한다(중간을 건너뛰지 않음).
 *   빈 행(연 구분)은 다음 기록 행과 같은 시각을 받아 따로 강조되지 않는다.
 * - 끝까지 기록하지 않았으면 기록하지 않은 행은 강조하지 않는다(마지막 기록 행에 머문다). 진행을 꾸며내지 않는다.
 * - 시각은 앞 행보다 작을 수 없다(같은 것은 허용).
 */

export const USER_TIMING_LIMITS = {
  /** 한 행 시각의 최대값(24시간) */
  maxMs: 24 * 3600 * 1000,
} as const;

/** 기록 대상 행(빈 행 제외), 가사 순서 */
export function timingTargets(lyrics: LyricsVersion): LyricLine[] {
  return lyrics.lines.filter((l) => l.text.trim() !== '');
}

export type TimingCheck = { ok: true; lines: Record<string, number> } | { ok: false; error: string };

/**
 * 탭 기록(재생 위치 ms 목록)을 저장할 행 시각으로 만든다.
 * taps[i]는 i번째 기록 대상 행의 시작 시각이다.
 */
export function buildTimingFromTaps(lyrics: LyricsVersion, taps: readonly number[]): TimingCheck {
  if (lyrics.kind === 'instrumental') return { ok: false, error: '연주곡에는 싱크를 기록할 수 없습니다' };
  const targets = timingTargets(lyrics);
  if (taps.length === 0) return { ok: false, error: '기록한 줄이 없습니다' };
  if (taps.length > targets.length) return { ok: false, error: '가사 줄 수보다 많이 기록했습니다' };
  const lines: Record<string, number> = {};
  let prev = -1;
  for (let i = 0; i < taps.length; i++) {
    const t = taps[i];
    if (typeof t !== 'number' || !Number.isFinite(t))
      return { ok: false, error: `${i + 1}번째 기록이 숫자가 아닙니다` };
    const ms = Math.round(t);
    if (ms < 0 || ms > USER_TIMING_LIMITS.maxMs)
      return { ok: false, error: `${i + 1}번째 기록 시각이 범위를 벗어났습니다` };
    if (ms < prev) return { ok: false, error: `${i + 1}번째 줄 시각이 앞 줄보다 이릅니다` };
    prev = ms;
    const target = targets[i];
    if (!target) return { ok: false, error: '가사 줄을 찾지 못했습니다' };
    lines[target.id] = ms;
  }
  return { ok: true, lines };
}

/**
 * 저장·가져오기 전 검증: 행 ID가 이 판본의 빈 행이 아닌 행이고, 앞에서부터 연속이며, 시각이 줄지 않는다.
 * (백업 파일 등 불신 데이터도 이 함수로 확인한다.)
 */
export function validateUserTiming(lyrics: LyricsVersion, lines: Record<string, unknown>): TimingCheck {
  if (lyrics.kind === 'instrumental') return { ok: false, error: '연주곡에는 싱크 기록이 없어야 합니다' };
  const targets = timingTargets(lyrics);
  const known = new Set(lyrics.lines.map((l) => l.id));
  const keys = Object.keys(lines);
  for (const k of keys) {
    if (!known.has(k)) return { ok: false, error: '가사에 없는 행 ID가 있습니다' };
  }
  if (keys.length === 0) return { ok: false, error: '기록한 줄이 없습니다' };
  if (keys.length > targets.length) return { ok: false, error: '기록 대상이 아닌 행이 있습니다' };
  const taps: number[] = [];
  for (let i = 0; i < keys.length; i++) {
    const target = targets[i];
    if (!target || !(target.id in lines)) return { ok: false, error: '기록이 앞에서부터 이어지지 않습니다' };
    const v = lines[target.id];
    if (typeof v !== 'number' || !Number.isInteger(v)) return { ok: false, error: '시각 형식 오류' };
    taps.push(v);
  }
  return buildTimingFromTaps(lyrics, taps);
}

/** 현재 적용할 사용자 싱크: 가장 최근 버전. 최근 버전이 '되돌리기'면 없음 */
export function selectUserTiming(versions: readonly UserTimingVersion[]): UserTimingVersion | null {
  let latest: UserTimingVersion | null = null;
  for (const v of versions) if (!latest || v.seq > latest.seq) latest = v;
  return latest && latest.kind === 'timed' ? latest : null;
}

export interface EffectiveTiming {
  kind: LyricsKind;
  lines: LyricLine[];
  /** 시간 정보의 출처: 원본 가사(LRC) 또는 사용자 기록 */
  source: 'original' | 'user';
}

/** 기록되지 않은 행: 절대 활성화되지 않는 시각(진행을 꾸며내지 않음) */
const NEVER = Number.POSITIVE_INFINITY;

/**
 * 싱크 계산에 쓸 행 시각. 사용자 기록이 있으면 그것을, 없으면 원문 타임스탬프를 쓴다.
 * 행 순서·ID·텍스트는 판본 그대로다(화면 행 번호와 일치).
 */
export function effectiveTiming(lyrics: LyricsVersion, timing: UserTimingVersion | null): EffectiveTiming {
  if (!timing || timing.kind !== 'timed' || lyrics.kind === 'instrumental' || timing.lyricsVersionId !== lyrics.id) {
    return { kind: lyrics.kind, lines: lyrics.lines, source: 'original' };
  }
  const checked = validateUserTiming(lyrics, timing.lines);
  if (!checked.ok) return { kind: lyrics.kind, lines: lyrics.lines, source: 'original' };
  const times = checked.lines;
  const out: LyricLine[] = new Array<LyricLine>(lyrics.lines.length);
  // 뒤에서부터: 빈 행은 다음 기록 행의 시각을 받는다(같은 시각이면 뒤 행이 활성이 되므로 빈 행은 강조되지 않음).
  let next = NEVER;
  for (let i = lyrics.lines.length - 1; i >= 0; i--) {
    const line = lyrics.lines[i] as LyricLine;
    const own = times[line.id];
    const startMs = own !== undefined ? own : line.text.trim() === '' ? next : NEVER;
    if (own !== undefined) next = own;
    out[i] = { id: line.id, text: line.text, startMs };
  }
  return { kind: 'synced', lines: out, source: 'user' };
}
