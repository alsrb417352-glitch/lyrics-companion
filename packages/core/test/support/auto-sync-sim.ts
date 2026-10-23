/**
 * 소리로 싱크 맞추기(D-44) 테스트용 합성 곡·가짜 재생기·가짜 듣기 모듈.
 * - 가사는 테스트용으로 지어낸 문장이다(실제 곡 가사 아님).
 * - "들은 말"은 실제 줄 시각에서 만들고, 빠짐·바뀜·시각 흔들림·간주 잡음을 시드 고정 난수로 넣는다.
 * - 가짜 재생기는 FakeClock 기준으로 위치가 흐르고, 곡이 끝나면 다음 곡으로 넘어간다.
 * - 가짜 듣기 모듈은 실제 네이티브 모듈과 같은 원시 값 형식(segments·samples·audioMs·route)을 돌려준다.
 */
import type { PlaybackControl, PlaybackSnapshot, PlaybackSource, ServiceTrackRef } from '../../src/ports.js';
import { mapIosSnapshot } from '../../src/playback/ios-system-player.js';
import { matchUnits, type HeardSegment } from '../../src/sync/auto-sync.js';
import type { ListenReadiness, SongListener } from '../../src/sync/auto-sync-runner.js';
import type { ListenRoute } from '../../src/sync/heard-audio.js';
import type { FakeClock } from './fakes.js';

/** 시드 고정 난수(mulberry32) */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 지어낸 일본어 가사(빈 줄 = 연 구분). 후렴(2연)이 4연에서 반복된다. */
export const JA_SONG: string[] = [
  '白い風が窓を叩く',
  'とおい街のあかりを数えて',
  'ぼくらはまだ眠らない',
  'あしたの色をさがしている',
  '',
  'ひかりの中へ走りだせ',
  'なまえのないうたを歌おう',
  'こえが届くまでなんども',
  'このそらに描いてゆく',
  '',
  'ちいさな手紙をひらいて',
  'ポケットにしまったことば',
  'あめのにおいが残るみちで',
  'きみのわらいごえを思いだす',
  '',
  'ひかりの中へ走りだせ',
  'なまえのないうたを歌おう',
  'こえが届くまでなんども',
  'このそらに描いてゆく',
  '',
  'どこまでも',
  'ひかりの中へ',
];

/** 지어낸 다른 일본어 가사(엉뚱한 소리 시험용) */
export const JA_OTHER_SONG: string[] = [
  'かわべりのベンチで待っている',
  'ゆうやけが少しずつ溶けてゆく',
  'だれもいない駅のホームに',
  'わたしの影だけが伸びている',
  '',
  'さよならを言えないまま',
  'つめたい手をにぎりしめた',
  'いつかまた会えるのなら',
  'そのときは笑っていてね',
  '',
  'かぜがふく夜のむこうに',
  'ちいさな星がまたたいて',
  'わすれないよと言ったきみの',
  'こえがまだ耳にのこる',
  '',
  'さよならを言えないまま',
  'つめたい手をにぎりしめた',
];

/** 지어낸 영어 가사 */
export const EN_SONG: string[] = [
  'Paper boats are sailing down the gutter',
  'Counting every window in the rain',
  "We don't need a reason to keep walking",
  'Every corner hums a quiet name',
  '',
  'Hold the lantern higher',
  'Let the morning find us here',
  'Hold the lantern higher',
  'Till the shadows disappear',
  '',
  'Somewhere in the static there is music',
  'Somewhere in the noise a steady drum',
  '',
  'Hold the lantern higher',
  'Let the morning find us here',
];

export interface SongTimeline {
  /** 가사 전체(빈 줄 포함) */
  lines: string[];
  /** 빈 줄을 뺀 줄의 실제 시작 시각(ms) */
  truth: number[];
  /** 단위(글자·단어) 하나 부르는 시간(기본값) */
  unitMs: number;
  /** 줄마다 단위 하나 부르는 시간(빠르기가 바뀌는 곡) */
  unitMsOf: number[];
  durationMs: number;
}

/** 줄 시작 시각 만들기: 전주 → 줄마다 단위 수 × unitMs + 숨 고르기, 연 사이 간주 */
export function singTimeline(
  lines: string[],
  opts: {
    introMs?: number;
    unitMs?: number;
    lineGapMs?: number;
    /** 연 사이 간주. 배열이면 n번째 간주 길이 */
    stanzaGapMs?: number | number[];
    outroMs?: number;
    /** 줄마다 빠르기를 0.7~1.4배로 바꾸고 줄 끝 음을 길게 끄는 정도(시드) */
    tempoSeed?: number;
  } = {},
): SongTimeline {
  const unitMs = opts.unitMs ?? 230;
  const lineGap = opts.lineGapMs ?? 450;
  const gaps = opts.stanzaGapMs ?? 9_000;
  const r = opts.tempoSeed !== undefined ? rng(opts.tempoSeed) : null;
  let t = opts.introMs ?? 12_000;
  const truth: number[] = [];
  const unitMsOf: number[] = [];
  let pendingStanza = false;
  let stanza = 0;
  for (const l of lines) {
    if (l.trim() === '') {
      if (truth.length > 0) pendingStanza = true;
      continue;
    }
    if (pendingStanza) {
      t += Array.isArray(gaps) ? (gaps[stanza] ?? 9_000) : gaps;
      stanza++;
    }
    pendingStanza = false;
    truth.push(Math.round(t));
    const u = r ? unitMs * (0.7 + r() * 0.7) : unitMs;
    unitMsOf.push(u);
    const hold = r ? r() * 1_500 : 0;
    t += Math.max(1, matchUnits(l).units.length) * u + lineGap + hold;
  }
  return { lines, truth, unitMs, unitMsOf, durationMs: Math.round(t + (opts.outroMs ?? 10_000)) };
}

const NOISE_KANA = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわん';
const NOISE_WORDS = ['oh', 'yeah', 'the', 'and', 'baby', 'la', 'na'];

export interface HearOptions {
  seed?: number;
  /** 단위가 빠질 확률 */
  drop?: number;
  /** 단위가 엉뚱한 글자로 바뀔 확률 */
  sub?: number;
  /** 들린 시각 흔들림(±ms) */
  jitterMs?: number;
  /** 이 줄(빈 줄 제외 순번)은 전혀 알아듣지 못함 */
  deafLines?: ReadonlySet<number>;
  /** 간주 동안 잡음 인식(재생 위치 ms, 글) */
  noise?: Array<{ atMs: number; text: string }>;
  /** 이 재생 위치 이후는 듣지 않음 */
  untilMs?: number;
  /** 인식기 시각이 한쪽으로 치우침(ms, 양수면 늦게) */
  biasMs?: number;
}

/** 실제 시각에서 "알아들은 말"(재생 위치 기준) 만들기 */
export function hearSong(song: SongTimeline, opts: HearOptions = {}): HeardSegment[] {
  const r = rng(opts.seed ?? 1);
  const out: HeardSegment[] = [];
  const targets = song.lines.filter((l) => l.trim() !== '');
  targets.forEach((text, k) => {
    if (opts.deafLines?.has(k)) return;
    const mu = matchUnits(text);
    const wordy = mu.words > mu.units.length / 2;
    let chunk: Array<{ u: string; t: number }> = [];
    const flush = () => {
      if (chunk.length === 0) return;
      const first = chunk[0] as { t: number };
      const last = chunk[chunk.length - 1] as { t: number };
      out.push({
        text: chunk.map((c) => c.u).join(wordy ? ' ' : ''),
        startMs: first.t,
        endMs: last.t + (song.unitMsOf[k] ?? song.unitMs),
      });
      chunk = [];
    };
    mu.units.forEach((u, p) => {
      const um = song.unitMsOf[k] ?? song.unitMs;
      const t = (song.truth[k] as number) + p * um + (r() * 2 - 1) * (opts.jitterMs ?? 0) + (opts.biasMs ?? 0);
      if (opts.untilMs !== undefined && t > opts.untilMs) return;
      const x = r();
      if (x < (opts.drop ?? 0)) {
        flush();
        return;
      }
      const v =
        x < (opts.drop ?? 0) + (opts.sub ?? 0)
          ? wordy
            ? (NOISE_WORDS[Math.floor(r() * NOISE_WORDS.length)] as string)
            : (NOISE_KANA[Math.floor(r() * NOISE_KANA.length)] as string)
          : u;
      chunk.push({ u: v, t: Math.max(0, t) });
      if (chunk.length >= 2 + Math.floor(r() * 3)) flush();
    });
    flush();
  });
  for (const n of opts.noise ?? []) out.push({ text: n.text, startMs: n.atMs, endMs: n.atMs + 600 });
  return out.sort((a, b) => a.startMs - b.startMs);
}

// ---------------------------------------------------------------- 가짜 재생기

export interface SimTrack {
  ref: ServiceTrackRef;
  /** 들은 말(재생 위치 기준). 없으면 아무것도 들리지 않음 */
  heard: HeardSegment[];
}

/** iPhone Music 앱처럼 동작하는 가짜 재생기(FakeClock 기준). 스토어 ID는 숫자여야 한다(ios-system-player 규칙). */
export class FakeMusicPlayer implements PlaybackSource {
  readonly id = 'fake-music';
  queue: SimTrack[] = [];
  index = -1;
  playing = false;
  private basePos = 0;
  private baseMono = 0;
  seeks = 0;

  constructor(private readonly clock: FakeClock) {}

  load(queue: SimTrack[], startIndex = 0): void {
    this.queue = queue;
    this.index = queue.length > 0 ? startIndex : -1;
    this.basePos = 0;
    this.baseMono = this.clock.monotonicMs();
    this.playing = true;
  }

  get track(): SimTrack | null {
    this.advanceIfEnded();
    return this.queue[this.index] ?? null;
  }

  positionMs(): number {
    this.advanceIfEnded();
    return this.playing ? this.basePos + (this.clock.monotonicMs() - this.baseMono) : this.basePos;
  }

  private advanceIfEnded(): void {
    for (;;) {
      const cur = this.queue[this.index];
      if (!cur || !this.playing) return;
      const dur = cur.ref.durationMs ?? Number.POSITIVE_INFINITY;
      const pos = this.basePos + (this.clock.monotonicMs() - this.baseMono);
      if (pos < dur) return;
      // 다음 곡으로(남은 시간만큼 이미 재생됨)
      this.baseMono = this.clock.monotonicMs() - (pos - dur);
      this.basePos = 0;
      this.index++;
      if (this.index >= this.queue.length) {
        this.playing = false;
        this.index = this.queue.length;
        return;
      }
    }
  }

  /** 네이티브 모듈 snapshot()과 같은 원시 값 */
  raw(latenessMs = 0): Record<string, unknown> {
    const t = this.track;
    if (!t) return { state: 'stopped', hasItem: false };
    return {
      state: this.playing ? 'playing' : 'paused',
      hasItem: true,
      title: t.ref.title,
      artist: t.ref.artist,
      album: t.ref.album ?? undefined,
      durationSec: (t.ref.durationMs ?? 0) / 1000,
      storeId: t.ref.serviceTrackId ?? '0',
      rate: 1,
      positionSec: Math.max(0, this.positionMs() - latenessMs) / 1000,
    };
  }

  access() {
    return Promise.resolve('granted' as const);
  }

  current(): Promise<PlaybackSnapshot | null> {
    return Promise.resolve(mapIosSnapshot(this.raw(), this.clock.monotonicMs()));
  }

  subscribe(): () => void {
    return () => undefined;
  }

  readonly control: PlaybackControl = {
    play: () => {
      if (!this.playing) {
        this.baseMono = this.clock.monotonicMs();
        this.playing = this.queue[this.index] !== undefined;
      }
      return Promise.resolve();
    },
    pause: () => {
      this.basePos = this.positionMs();
      this.playing = false;
      return Promise.resolve();
    },
    seekTo: (ms: number) => {
      this.seeks++;
      this.basePos = Math.max(0, ms);
      this.baseMono = this.clock.monotonicMs();
      return Promise.resolve();
    },
    skipNext: () => {
      this.index++;
      this.basePos = 0;
      this.baseMono = this.clock.monotonicMs();
      return Promise.resolve();
    },
    skipPrevious: () => Promise.resolve(),
  };
}

// ---------------------------------------------------------------- 가짜 듣기 모듈

/**
 * 가짜 듣기 모듈: tick()마다(테스트가 시계를 진행한 뒤 호출) 재생기 상태를 표본으로 재고,
 * 그 사이 재생된 구간의 "들은 말"을 인식 지연(latencyMs) 뒤에 돌려준다. 오디오 시각은 start() 때부터.
 */
export class FakeListener implements SongListener {
  route: ListenRoute = 'speaker';
  readiness: ListenReadiness | ((locale: string) => ListenReadiness) = { ok: true, route: 'speaker' };
  readonly calls: string[] = [];
  readonly locales: string[] = [];
  hintsSeen: number[] = [];
  error: string | null = null;
  /** 위치 읽기 지연(0~이 값, 시드 난수) */
  latenessMs = 0;
  latencyMs = 1_500;
  private active = false;
  private audioStartMono = 0;
  private lastMono = 0;
  private lastPos: number | null = null;
  private lastTrack: SimTrack | null = null;
  private pendingSegs: Array<HeardSegment & { releaseAt: number }> = [];
  private samples: Array<{ audioMs: number; now: Record<string, unknown> }> = [];
  private readonly r = rng(7);

  constructor(
    private readonly clock: FakeClock,
    private readonly player: FakeMusicPlayer,
  ) {}

  get listening(): boolean {
    return this.active;
  }

  prepare(locale: string): Promise<ListenReadiness> {
    this.calls.push(`prepare:${locale}`);
    return Promise.resolve(typeof this.readiness === 'function' ? this.readiness(locale) : this.readiness);
  }

  start(opts: { locale: string; hints: readonly string[] }): Promise<void> {
    this.calls.push(`start:${opts.locale}`);
    this.locales.push(opts.locale);
    this.hintsSeen.push(opts.hints.length);
    if (!this.active) {
      this.active = true;
      this.audioStartMono = this.clock.monotonicMs();
      this.lastMono = this.audioStartMono;
      this.lastPos = null;
      this.lastTrack = null;
    }
    return Promise.resolve();
  }

  private audioNow(): number {
    return this.clock.monotonicMs() - this.audioStartMono;
  }

  /** 테스트가 시계를 진행한 뒤 부른다 */
  tick(): void {
    if (!this.active) return;
    const now = this.clock.monotonicMs();
    const track = this.player.track;
    const pos = this.player.playing ? this.player.positionMs() : null;
    const audioNow = this.audioNow();
    if (track && pos !== null && this.lastTrack === track && this.lastPos !== null && pos > this.lastPos) {
      const from = this.lastPos;
      const audioFrom = this.lastMono - this.audioStartMono;
      for (const s of track.heard) {
        if (s.startMs <= from || s.startMs > pos) continue;
        const a = audioFrom + (s.startMs - from);
        this.pendingSegs.push({
          text: s.text,
          startMs: a,
          endMs: a + (s.endMs - s.startMs),
          releaseAt: a + (s.endMs - s.startMs) + this.latencyMs,
        });
      }
    }
    this.samples.push({ audioMs: audioNow, now: this.player.raw(this.r() * this.latenessMs) });
    this.lastTrack = track;
    this.lastPos = pos;
    this.lastMono = now;
  }

  private take(all: boolean): Record<string, unknown> {
    const audioNow = this.audioNow();
    const ready = this.pendingSegs.filter((s) => all || s.releaseAt <= audioNow);
    this.pendingSegs = this.pendingSegs.filter((s) => !(all || s.releaseAt <= audioNow));
    const samples = this.samples;
    this.samples = [];
    return {
      segments: ready.map((s) => ({ text: s.text, startMs: s.startMs, endMs: s.endMs })),
      samples,
      audioMs: audioNow,
      levelDb: -20,
      route: this.route,
      error: this.error,
    };
  }

  drain(): Promise<unknown> {
    this.calls.push('drain');
    return Promise.resolve(this.active ? this.take(false) : { segments: [], samples: [], audioMs: 0 });
  }

  stop(): Promise<unknown> {
    this.calls.push('stop');
    const out = this.active ? this.take(true) : { segments: [], samples: [], audioMs: 0 };
    this.active = false;
    return Promise.resolve(out);
  }

  cancel(): Promise<void> {
    this.calls.push('cancel');
    this.active = false;
    this.pendingSegs = [];
    this.samples = [];
    return Promise.resolve();
  }
}
