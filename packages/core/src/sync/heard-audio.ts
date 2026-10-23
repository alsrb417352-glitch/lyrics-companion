import type { PlaybackStatus } from '../ports.js';
import { mapIosSnapshot } from '../playback/ios-system-player.js';
import { serviceKeyOf } from '../matching/track-identity.js';
import { sanitizeLine } from '../util/text.js';
import type { HeardSegment } from './auto-sync.js';

/**
 * 소리로 싱크 맞추기(D-44)에서 네이티브 듣기 모듈이 넘기는 원시 값 해석과, "오디오 시각 → 재생 위치" 대응.
 *
 * 네이티브 모듈은 마이크 소리를 기기 안 음성 인식기에 넣고, 알아들은 말을 **녹음 시작부터의 오디오 시각**으로 돌려준다.
 * 같은 시계로 Music 앱의 재생 상태(곡·위치)를 주기적으로 함께 재 둔다(표본). 재생 중에는
 * "재생 위치 − 오디오 시각"이 일정하므로, 표본으로 이 차이를 구해 들은 말의 시각을 재생 위치로 바꾼다.
 *  - 일시정지·탐색·곡 변경이 있으면 차이가 바뀐다 → 구간을 나눠 각각 대응시킨다. 재생 중이 아닌 표본은 쓰지 않는다.
 *  - 다른 곡이 재생되던 동안 들은 말은 이 곡에 쓰지 않는다(곡 키로 구분).
 *  - 위치 읽기는 늦게 읽히는 일만 있으므로(D-25) 구간 안에서 가장 덜 늦은 쪽(상위 10%)을 쓴다.
 * 모든 원시 값은 불신 데이터로 검사한다. 들은 말은 메모리에서 정렬에만 쓰고 저장·기록·전송하지 않는다.
 */

export const LISTEN_LIMITS = {
  maxSegmentsPerChunk: 5_000,
  maxSamplesPerChunk: 5_000,
  maxSegmentChars: 300,
  /** 로그에 쌓아 둘 최대 개수(이보다 많으면 오래된 것부터 버림) */
  maxSegments: 40_000,
  maxSamples: 40_000,
  /** 오디오 시각 상한(12시간) */
  maxAudioMs: 12 * 3600 * 1000,
} as const;

export type ListenRoute = 'speaker' | 'headphones' | 'bluetooth' | 'airplay' | 'receiver' | 'other' | 'unknown';

export interface ListenSample {
  audioMs: number;
  /** 그때 재생 중이던 곡 키(serviceKeyOf). 곡이 없으면 null */
  key: string | null;
  status: PlaybackStatus;
  positionMs: number | null;
  durationMs: number | null;
}

export interface ListenChunk {
  /** 오디오 시각 기준 알아들은 말 */
  segments: HeardSegment[];
  samples: ListenSample[];
  /** 지금까지 들은 오디오 길이(ms) */
  audioMs: number;
  /** 최근 입력 소리 크기(dBFS, 0에 가까울수록 큼). 모르면 null */
  levelDb: number | null;
  route: ListenRoute;
  /** 인식기 오류(이미 정리된 짧은 문구). 없으면 null */
  error: string | null;
}

const ROUTES: readonly ListenRoute[] = ['speaker', 'headphones', 'bluetooth', 'airplay', 'receiver', 'other'];

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function ms(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= LISTEN_LIMITS.maxAudioMs ? v : null;
}

/** 네이티브 듣기 모듈의 한 번 받아 온 값(drain/stop 결과)을 검사·정리한다. 형식이 틀린 항목은 버린다. */
export function parseListenChunk(raw: unknown): ListenChunk {
  const o = obj(raw) ?? {};
  const segments: HeardSegment[] = [];
  const segsRaw = Array.isArray(o['segments']) ? (o['segments'] as unknown[]) : [];
  for (const x of segsRaw.slice(0, LISTEN_LIMITS.maxSegmentsPerChunk)) {
    const s = obj(x);
    if (!s || typeof s['text'] !== 'string') continue;
    const start = ms(s['startMs']);
    const end = ms(s['endMs']);
    if (start === null || end === null || end < start) continue;
    const text = sanitizeLine(s['text']).trim().slice(0, LISTEN_LIMITS.maxSegmentChars);
    if (!text) continue;
    segments.push({ text, startMs: start, endMs: end });
  }
  const samples: ListenSample[] = [];
  const smpRaw = Array.isArray(o['samples']) ? (o['samples'] as unknown[]) : [];
  for (const x of smpRaw.slice(0, LISTEN_LIMITS.maxSamplesPerChunk)) {
    const s = obj(x);
    if (!s) continue;
    const audioMs = ms(s['audioMs']);
    const now = obj(s['now']);
    if (audioMs === null || !now) continue;
    // 재생 정보 해석은 지금 재생과 같은 규칙(ios-system-player.ts)
    const snap = mapIosSnapshot(now, 0);
    samples.push({
      audioMs,
      key: snap.track ? serviceKeyOf(snap.track) : null,
      status: snap.status,
      positionMs: snap.positionMs,
      durationMs: snap.track?.durationMs ?? null,
    });
  }
  const level = o['levelDb'];
  const route = ROUTES.includes(o['route'] as ListenRoute) ? (o['route'] as ListenRoute) : 'unknown';
  const err =
    typeof o['error'] === 'string' && o['error'].trim() !== '' ? sanitizeLine(o['error']).slice(0, 200) : null;
  return {
    segments,
    samples,
    audioMs: ms(o['audioMs']) ?? 0,
    levelDb: typeof level === 'number' && Number.isFinite(level) && level <= 0 && level >= -200 ? level : null,
    route,
    error: err,
  };
}

/** 한 곡이 이어서 재생되던 오디오 구간 */
export interface ListenOccurrence {
  key: string;
  fromAudioMs: number;
  toAudioMs: number;
}

export interface SongWindow {
  /** 재생 위치로 바꾼 들은 말(재생 위치 순) */
  heard: HeardSegment[];
  /** 소리를 들은 재생 위치 구간. 재생 중 표본이 없으면 null */
  coverage: { startMs: number; endMs: number } | null;
  durationMs: number | null;
}

/** 구간을 나누는 기준: 차이가 이만큼 바뀌면 일시정지·탐색으로 본다 */
const JUMP_MS = 700;
/** 표본 사이가 이보다 비면 구간을 나눈다(앱이 멈췄던 동안 등) */
const SAMPLE_GAP_MS = 3_000;
/** 구간 앞뒤로 들은 말을 받아 주는 여유 */
const EDGE_MS = 600;
/** 한 구간으로 인정할 최소 표본 수(네이티브는 0.5초마다 잰다) */
const MIN_RUN_SAMPLES = 3;

function percentile(xs: readonly number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)));
  return s[i] ?? 0;
}

/**
 * 들은 말·재생 표본 누적(한 번의 듣기 세션). 오디오 시각은 세션 안에서 계속 늘어난다.
 */
export class ListenLog {
  private segments: HeardSegment[] = [];
  private samples: ListenSample[] = [];
  private latestAudioMs = 0;

  append(chunk: ListenChunk): void {
    this.segments.push(...chunk.segments);
    this.samples.push(...chunk.samples);
    this.samples.sort((a, b) => a.audioMs - b.audioMs);
    if (this.segments.length > LISTEN_LIMITS.maxSegments)
      this.segments.splice(0, this.segments.length - LISTEN_LIMITS.maxSegments);
    if (this.samples.length > LISTEN_LIMITS.maxSamples)
      this.samples.splice(0, this.samples.length - LISTEN_LIMITS.maxSamples);
    this.latestAudioMs = Math.max(this.latestAudioMs, chunk.audioMs);
  }

  get audioMs(): number {
    return this.latestAudioMs;
  }

  /** 지금까지 받은 들은 말 중 가장 늦게 끝난 오디오 시각(인식 결과가 어디까지 왔는지) */
  get heardUntilAudioMs(): number {
    let m = 0;
    for (const s of this.segments) if (s.endMs > m) m = s.endMs;
    return m;
  }

  get segmentCount(): number {
    return this.segments.length;
  }

  /** 이 곡이 가장 최근에 이어서 재생된 구간(다른 곡 표본이 끼면 끊김) */
  lastOccurrence(key: string): ListenOccurrence | null {
    let to = -1;
    let from = -1;
    for (let i = this.samples.length - 1; i >= 0; i--) {
      const s = this.samples[i] as ListenSample;
      if (s.key === key) {
        if (to < 0) to = s.audioMs;
        from = s.audioMs;
      } else if (to >= 0 && s.key !== null) break;
    }
    return to < 0 ? null : { key, fromAudioMs: from, toAudioMs: to };
  }

  /** 한 곡 구간의 들은 말을 재생 위치로 바꾼다 */
  window(occ: ListenOccurrence): SongWindow {
    const smp = this.samples.filter(
      (s) =>
        s.key === occ.key &&
        s.audioMs >= occ.fromAudioMs &&
        s.audioMs <= occ.toAudioMs &&
        s.status === 'playing' &&
        s.positionMs !== null,
    );
    let durationMs: number | null = null;
    for (const s of this.samples)
      if (s.key === occ.key && s.durationMs !== null && s.audioMs >= occ.fromAudioMs && s.audioMs <= occ.toAudioMs)
        durationMs = s.durationMs;
    // 차이(재생 위치 − 오디오 시각)가 이어지는 구간으로 나눈다
    const runs: Array<{ first: number; last: number; ds: number[]; ref: number }> = [];
    for (const s of smp) {
      const d = (s.positionMs as number) - s.audioMs;
      const r = runs[runs.length - 1];
      if (r && Math.abs(d - r.ref) <= JUMP_MS && s.audioMs - r.last <= SAMPLE_GAP_MS) {
        r.ds.push(d);
        r.last = s.audioMs;
        if (d > r.ref) r.ref = d;
      } else {
        runs.push({ first: s.audioMs, last: s.audioMs, ds: [d], ref: d });
      }
    }
    // 표본이 너무 적은 구간(탐색 직후 한두 번 늦게 읽힌 값 등)은 믿지 않는다
    for (let ri = runs.length - 1; ri >= 0; ri--)
      if ((runs[ri] as { ds: number[] }).ds.length < MIN_RUN_SAMPLES) runs.splice(ri, 1);
    let heard: HeardSegment[] = [];
    let covStart = Number.POSITIVE_INFINITY;
    let covEnd = Number.NEGATIVE_INFINITY;
    for (let ri = 0; ri < runs.length; ri++) {
      const r = runs[ri] as { first: number; last: number; ds: number[] };
      const offset = percentile(r.ds, 0.9);
      const prevLast = ri > 0 ? (runs[ri - 1] as { last: number }).last : Number.NEGATIVE_INFINITY;
      const nextFirst = ri + 1 < runs.length ? (runs[ri + 1] as { first: number }).first : Number.POSITIVE_INFINITY;
      const lo = Math.max(r.first - EDGE_MS, (prevLast + r.first) / 2);
      const hi = Math.min(r.last + EDGE_MS, (r.last + nextFirst) / 2);
      const posLo = r.first + offset;
      const posHi = r.last + offset;
      const mapped: HeardSegment[] = [];
      for (const seg of this.segments) {
        const mid = (seg.startMs + seg.endMs) / 2;
        if (mid < lo || mid > hi || seg.startMs + offset < 0) continue;
        mapped.push({ text: seg.text, startMs: seg.startMs + offset, endMs: seg.endMs + offset });
      }
      // 뒤로 탐색해 같은 부분을 다시 들었으면 나중에 들은 것을 쓴다
      heard = heard.filter((h) => h.startMs < posLo - EDGE_MS || h.startMs > posHi + EDGE_MS);
      heard.push(...mapped);
      covStart = Math.min(covStart, posLo);
      covEnd = Math.max(covEnd, posHi);
    }
    heard.sort((a, b) => a.startMs - b.startMs);
    return {
      heard,
      coverage: runs.length > 0 ? { startMs: Math.max(0, covStart), endMs: Math.max(0, covEnd) } : null,
      durationMs,
    };
  }

  /** 이 오디오 시각 이전 기록을 버린다(일괄 실행에서 끝난 곡 정리) */
  pruneBefore(audioMs: number): void {
    this.segments = this.segments.filter((s) => s.endMs >= audioMs);
    this.samples = this.samples.filter((s) => s.audioMs >= audioMs);
  }

  clear(): void {
    this.segments = [];
    this.samples = [];
    this.latestAudioMs = 0;
  }
}
