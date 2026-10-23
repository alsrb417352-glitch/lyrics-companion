import type { Clock, IdGenerator, PlaybackSource, ServiceTrackRef } from '../ports.js';
import type { LyricsVersion, Song } from '../model.js';
import { serviceKeyOf } from '../matching/track-identity.js';
import type { Logger } from '../security/logger.js';
import type { NowPlayingSession } from '../session/now-playing-session.js';
import type { LyricsStore } from '../storage/lyrics-store.js';
import {
  alignHeardToLyrics,
  autoSyncHints,
  autoSyncLocale,
  type AutoSyncFailure,
  type AutoSyncStats,
} from './auto-sync.js';
import { ListenLog, parseListenChunk, type ListenOccurrence, type ListenRoute } from './heard-audio.js';
import { buildTimingFromTaps, selectUserTiming } from './user-timing.js';

/**
 * 소리로 싱크 맞추기 실행기(REQ-SY-06·07, docs/plan.md D-44) — 지금 곡 하나 또는 플레이리스트의 싱크 없는 곡들.
 *
 * 흐름: 사용자가 시작 → 듣기 준비(마이크 권한·언어 모델·스피커 출력 확인) → 듣기 시작 → 곡을 처음부터 재생
 *       → 곡이 끝나면(다음 곡으로 넘어가면) 들은 말과 가사를 맞춰(alignHeardToLyrics) "소리로 맞춘 싱크"로 저장.
 * 규칙
 * - 사용자가 시작했을 때만 듣는다. 듣는 동안만 마이크를 쓴다. 소리·들은 말은 저장·기록·전송하지 않는다(줄 수만 기록).
 * - 시간 정보 없는 가사(plain)만 대상이다. 원문 타임스탬프가 있는 가사는 건드리지 않는다.
 * - 사용자가 탭으로 기록한 싱크는 덮지 않는다: 한 곡 모드는 사용자가 확인했을 때만, 일괄 모드는 항상 건너뛴다.
 * - 기준점이 너무 적으면 저장하지 않는다(엉뚱한 싱크보다 없는 편이 낫다). 저장은 새 버전(되돌리기 가능).
 * - 저장 직전에 다시 확인한다: 그 사이 가사 판본이 바뀌었거나(일괄 모드) 싱크 기록이 생겼으면 저장하지 않는다.
 * - AI(번역 모델)를 부르지 않는다. 네트워크도 쓰지 않는다(언어 모델 내려받기는 OS가 한다).
 */

export type ListenNotReady =
  /** 이 기기·OS에서 쓸 수 없음 */
  | 'unsupported'
  /** iOS가 너무 오래됨(iOS 26 필요) */
  | 'os-too-old'
  /** 이 언어를 기기 음성 인식이 지원하지 않음 */
  | 'locale-unsupported'
  /** 언어 모델을 내려받지 못함(네트워크·저장 공간) */
  | 'model-download-failed'
  /** 마이크 권한 거부 */
  | 'mic-denied'
  /** 마이크 권한을 아직 묻지 않음(확인만 했을 때) */
  | 'mic-undetermined'
  /** 언어 모델을 아직 내려받지 않음(확인만 했을 때) */
  | 'model-missing'
  /** 이어폰·블루투스로 재생 중(마이크가 소리를 듣지 못함) */
  | 'headphones'
  /** 다른 앱이 마이크를 쓰는 중 등 */
  | 'busy';

export type ListenReadiness = { ok: true; route: ListenRoute } | { ok: false; reason: ListenNotReady };

const NOT_READY: readonly ListenNotReady[] = [
  'unsupported',
  'os-too-old',
  'locale-unsupported',
  'model-download-failed',
  'mic-denied',
  'mic-undetermined',
  'model-missing',
  'headphones',
  'busy',
];

/** 네이티브 준비 상태 원시 값 { ok, reason?, route } 해석(모르는 값은 쓸 수 없음으로) */
export function mapListenReadiness(raw: unknown): ListenReadiness {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const route = parseListenChunk({ route: o['route'] }).route;
  if (o['ok'] === true) return { ok: true, route };
  const reason = NOT_READY.includes(o['reason'] as ListenNotReady) ? (o['reason'] as ListenNotReady) : 'unsupported';
  return { ok: false, reason };
}

/** 기기 듣기 포트(iPhone: 마이크 + 기기 안 음성 인식). 반환 원시 값은 parseListenChunk로 검사한다. */
export interface SongListener {
  /** 사용자가 시작을 누른 뒤에만: 필요하면 마이크 권한을 묻고 언어 모델을 내려받는다 */
  prepare(locale: string): Promise<ListenReadiness>;
  /** 듣기 시작. 이미 듣는 중이면 언어·힌트만 바꾼다(오디오 시각은 처음부터 이어짐) */
  start(opts: { locale: string; hints: readonly string[] }): Promise<void>;
  /** 지금까지 쌓인 결과를 넘기고 비운다 */
  drain(): Promise<unknown>;
  /** 듣기를 끝내고(인식 마무리까지) 남은 결과를 넘긴다 */
  stop(): Promise<unknown>;
  /** 결과 없이 바로 끝낸다 */
  cancel(): Promise<void>;
}

export type AutoSyncItemStatus =
  /** 소리로 맞춘 싱크 저장 */
  | 'saved'
  | AutoSyncFailure
  /** 저장된 가사가 없음(먼저 "가사 원문 일괄 받기") */
  | 'no-lyrics'
  /** 이미 원문 타임스탬프가 있는 가사 */
  | 'already-synced'
  /** 이미 싱크 기록(탭·소리)이 있음 */
  | 'has-timing'
  /** 기기 음성 인식이 지원하지 않는 언어(또는 언어를 알 수 없음) */
  | 'unsupported-language'
  /** 이 곡 언어의 듣기 준비 실패 */
  | 'not-ready'
  /** 듣는 동안 가사 판본·싱크 기록이 바뀜 */
  | 'changed'
  /** 끝까지 듣기 전에 멈춤 */
  | 'cancelled'
  /** 재생되지 않음(일괄 실행이 먼저 끝남) */
  | 'not-played'
  | 'duplicate'
  | 'error';

export interface AutoSyncItem {
  /** 일괄 모드의 목록 위치(한 곡 모드는 null) */
  index: number | null;
  title: string;
  status: AutoSyncItemStatus;
  stats: AutoSyncStats | null;
  /** 대상이 아니라 처음부터 건너뛴 곡(일괄 모드) */
  skipped?: boolean;
}

export type AutoSyncStop =
  'completed' | 'cancelled' | 'not-ready' | 'headphones' | 'listener-error' | 'track-changed' | 'nothing-to-do';

export interface AutoSyncState {
  running: boolean;
  mode: 'single' | 'batch' | null;
  label: string | null;
  /** 어떤 목록의 실행인지(플레이리스트 persistentId 등) */
  key: string | null;
  phase: 'idle' | 'preparing' | 'listening' | 'aligning';
  /** 지금 듣는 곡 */
  current: { index: number | null; title: string; heardWords: number; positionMs: number | null } | null;
  /** 최근 소리 크기(dBFS). 너무 작으면 화면에서 알려 준다 */
  levelDb: number | null;
  /** 일괄 모드 대상 곡 수 */
  total: number;
  items: AutoSyncItem[];
  stoppedBy: AutoSyncStop | null;
  notReady: ListenNotReady | null;
  /** 인식기 오류 문구(정리된 짧은 문구) */
  error: string | null;
}

export interface AutoSyncRunnerDeps {
  store: LyricsStore;
  session: NowPlayingSession;
  playback: PlaybackSource;
  listener: SongListener;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  /** 확인 간격(기본 1초) */
  pollMs?: number;
  /** 곡이 끝난 뒤 늦게 오는 인식 결과를 기다리는 최대 시간(기본 6초) */
  settleMs?: number;
}

export interface AutoSyncBatchInput {
  label: string;
  key: string | null;
  tracks: readonly ServiceTrackRef[];
  /** 대상 곡(목록 위치)만 순서대로 재생 대기열에 넣고 처음부터 재생한다(앱이 구현) */
  play: (indexes: number[]) => Promise<void>;
}

export interface AutoSyncPlanEntry {
  index: number;
  title: string;
  status: 'target' | Exclude<AutoSyncItemStatus, 'saved'>;
  locale: string | null;
}

const IDLE: AutoSyncState = {
  running: false,
  mode: null,
  label: null,
  key: null,
  phase: 'idle',
  current: null,
  levelDb: null,
  total: 0,
  items: [],
  stoppedBy: null,
  notReady: null,
  error: null,
};

interface Target {
  index: number | null;
  title: string;
  key: string;
  song: Song;
  lyrics: LyricsVersion;
  locale: string;
  /** 사용자가 탭 기록을 바꿔도 된다고 확인함(한 곡 모드) */
  replaceTap: boolean;
}

interface Pending {
  target: Target;
  occ: ListenOccurrence | null;
  dueAt: number;
}

const BLOCKED_ROUTES: readonly ListenRoute[] = ['headphones', 'bluetooth'];

export class AutoSyncRunner {
  private state: AutoSyncState = IDLE;
  private readonly listeners = new Set<(s: AutoSyncState) => void>();
  private request: 'none' | 'finish' | 'cancel' = 'none';
  private readonly pollMs: number;
  private readonly settleMs: number;

  constructor(private readonly deps: AutoSyncRunnerDeps) {
    this.pollMs = deps.pollMs ?? 1_000;
    this.settleMs = deps.settleMs ?? 6_000;
  }

  get current(): AutoSyncState {
    return this.state;
  }

  subscribe(listener: (s: AutoSyncState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private update(patch: Partial<AutoSyncState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  /** 지난 결과 지우기(실행 중에는 무시) */
  reset(): void {
    if (!this.state.running) this.update(IDLE);
  }

  /** 사용자 요청(await 사이에 바뀌므로 매번 다시 읽는다) */
  private requested(): 'none' | 'finish' | 'cancel' {
    return this.request;
  }

  /** 한 곡 모드: 지금까지 들은 것으로 맞춰 저장하고 끝낸다. 일괄 모드: 끝난 곡만 저장하고 멈춘다. */
  finishNow(): void {
    if (this.state.running && this.request === 'none') this.request = 'finish';
  }

  /** 저장하지 않고 멈춘다(일괄 모드에서 이미 끝까지 들은 곡은 저장). */
  cancel(): void {
    if (this.state.running) this.request = 'cancel';
  }

  // ------------------------------------------------------------ 대상 고르기

  /** 이 곡이 대상인지(저장소만 읽음). replaceTap이면 탭 기록이 있어도 대상 */
  private async check(
    ref: ServiceTrackRef,
    replaceTap: boolean,
  ): Promise<{ status: AutoSyncPlanEntry['status']; song?: Song; lyrics?: LyricsVersion; locale?: string }> {
    const { store } = this.deps;
    const song = await store.findSongByServiceKey(ref.service, serviceKeyOf(ref));
    if (!song?.activeLyricsVersionId) return { status: 'no-lyrics' };
    const lyrics = await store.getLyricsVersion(song.activeLyricsVersionId);
    if (!lyrics) return { status: 'no-lyrics' };
    if (lyrics.kind === 'instrumental') return { status: 'instrumental' };
    if (lyrics.kind === 'synced') return { status: 'already-synced' };
    const timing = selectUserTiming(await store.listUserTimings(lyrics.id));
    if (timing && !(replaceTap || timing.method === 'auto')) return { status: 'has-timing' };
    const locale = autoSyncLocale(lyrics);
    if (!locale) return { status: 'unsupported-language' };
    return { status: 'target', song, lyrics, locale };
  }

  /**
   * 플레이리스트에서 대상 곡 고르기(저장소만 읽음, 네트워크·AI 없음): 저장된 가사가 시간 정보 없는 가사이고
   * 싱크 기록(탭·소리)이 없는 곡. 같은 곡이 두 번 있으면 한 번만.
   */
  async plan(tracks: readonly ServiceTrackRef[]): Promise<AutoSyncPlanEntry[]> {
    const out: AutoSyncPlanEntry[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < tracks.length; index++) {
      const ref = tracks[index];
      if (!ref) continue;
      const key = `${ref.service}\u0000${serviceKeyOf(ref)}`;
      if (seen.has(key)) {
        out.push({ index, title: ref.title, status: 'duplicate', locale: null });
        continue;
      }
      seen.add(key);
      const c = await this.check(ref, false);
      // 일괄 모드는 소리로 맞춘 싱크도 다시 맞추지 않는다(이미 있는 싱크 기록은 모두 건너뜀)
      const status = c.status === 'target' && (await this.hasTiming(c.lyrics)) ? 'has-timing' : c.status;
      out.push({ index, title: ref.title, status, locale: status === 'target' ? (c.locale ?? null) : null });
    }
    return out;
  }

  private async hasTiming(lyrics: LyricsVersion | undefined): Promise<boolean> {
    if (!lyrics) return false;
    return selectUserTiming(await this.deps.store.listUserTimings(lyrics.id)) !== null;
  }

  // ------------------------------------------------------------ 시작

  /**
   * 한 곡 모드: 지금 재생 화면의 곡(시간 정보 없는 가사)을 처음부터 재생하며 듣는다. 이미 실행 중이면 null.
   * replaceTap: 탭으로 기록한 싱크가 있어도 바꾼다(사용자가 확인한 경우만).
   */
  startSingle(opts: { replaceTap?: boolean } = {}): Promise<AutoSyncState> | null {
    if (this.state.running) return null;
    this.request = 'none';
    const s = this.deps.session.current;
    this.update({
      ...IDLE,
      running: true,
      mode: 'single',
      label: s.track?.title ?? null,
      phase: 'preparing',
      total: 1,
    });
    return this.runSingle(opts.replaceTap === true);
  }

  /** 일괄 모드: 플레이리스트의 대상 곡만 차례로 재생하며 듣는다. 이미 실행 중이면 null. */
  startBatch(input: AutoSyncBatchInput): Promise<AutoSyncState> | null {
    if (this.state.running) return null;
    this.request = 'none';
    this.update({ ...IDLE, running: true, mode: 'batch', label: input.label, key: input.key, phase: 'preparing' });
    return this.runBatch(input);
  }

  private finish(stoppedBy: AutoSyncStop, patch: Partial<AutoSyncState> = {}): AutoSyncState {
    this.deps.logger.info('autosync.end', {
      mode: this.state.mode,
      stoppedBy,
      saved: this.state.items.filter((i) => i.status === 'saved').length,
      items: this.state.items.length,
    });
    this.update({ running: false, phase: 'idle', current: null, stoppedBy, ...patch });
    return this.state;
  }

  private addItem(item: AutoSyncItem): void {
    this.update({ items: [...this.state.items, item] });
  }

  // ------------------------------------------------------------ 한 곡

  private async runSingle(replaceTap: boolean): Promise<AutoSyncState> {
    const { session, playback, listener, logger } = this.deps;
    try {
      const s = session.current;
      const ref = s.track;
      if (!ref || !s.song || !s.lyrics || s.phase !== 'ready') {
        this.addItem({ index: null, title: ref?.title ?? '', status: 'no-lyrics', stats: null });
        return this.finish('nothing-to-do');
      }
      const c = await this.check(ref, replaceTap);
      if (c.status !== 'target' || !c.song || !c.lyrics || !c.locale || c.lyrics.id !== s.lyrics.id) {
        const status = c.status === 'target' ? 'changed' : c.status;
        this.addItem({ index: null, title: ref.title, status, stats: null });
        return this.finish('nothing-to-do');
      }
      const target: Target = {
        index: null,
        title: ref.title,
        key: serviceKeyOf(ref),
        song: c.song,
        lyrics: c.lyrics,
        locale: c.locale,
        replaceTap,
      };
      const ready = await listener.prepare(target.locale);
      if (!ready.ok)
        return this.finish(ready.reason === 'headphones' ? 'headphones' : 'not-ready', { notReady: ready.reason });
      if (this.requested() === 'cancel') return this.finish('cancelled');

      const log = new ListenLog();
      await listener.start({ locale: target.locale, hints: autoSyncHints(target.lyrics) });
      logger.info('autosync.start', { mode: 'single', lines: target.lyrics.lines.length });
      // 곡을 처음부터(시작 줄부터 들어야 앞에서부터 이어지는 싱크를 만들 수 있다). 처음으로 돌리기 전에 들은 것은 버린다.
      await playback.control?.seekTo(0);
      await playback.control?.play();
      const before = parseListenChunk(await listener.drain());
      log.append(before);
      log.pruneBefore(before.audioMs);
      this.update({ phase: 'listening', current: { index: null, title: target.title, heardWords: 0, positionMs: 0 } });

      const durationMs = target.song.durationMs ?? ref.durationMs;
      const startedAt = this.deps.clock.monotonicMs();
      let maxPos = 0;
      let outcome: 'finish' | 'cancel' | 'headphones' | 'error' = 'finish';
      for (;;) {
        await this.deps.clock.sleep(this.pollMs);
        if (this.requested() === 'cancel') {
          outcome = 'cancel';
          break;
        }
        const chunk = parseListenChunk(await listener.drain());
        log.append(chunk);
        if (BLOCKED_ROUTES.includes(chunk.route)) {
          outcome = 'headphones';
          break;
        }
        if (chunk.error) {
          this.update({ error: chunk.error });
          outcome = 'error';
          break;
        }
        if (this.requested() === 'finish') break;
        const snap = await playback.current().catch(() => null);
        const key = snap?.track ? serviceKeyOf(snap.track) : null;
        const pos = snap?.positionMs ?? null;
        this.update({
          levelDb: chunk.levelDb,
          current: { index: null, title: target.title, heardWords: log.segmentCount, positionMs: pos },
        });
        // 다른 곡으로 넘어감·재생 끝 → 맞추기
        if (key !== null && key !== target.key) break;
        if (snap && snap.status === 'stopped') break;
        if (pos !== null) {
          // 같은 곡 반복 재생: 끝 근처까지 갔다가 처음으로 돌아오면 끝난 것으로 본다
          if (durationMs !== null && maxPos >= durationMs - 2_500 && pos < maxPos - 3_000) break;
          maxPos = Math.max(maxPos, pos);
        }
        // 안전 상한: 곡 길이 + 1분(길이를 모르면 20분)
        const limit = (durationMs ?? 19 * 60_000) + 60_000;
        if (this.deps.clock.monotonicMs() - startedAt > limit) break;
      }

      if (outcome === 'cancel' || outcome === 'headphones') {
        await listener.cancel().catch(() => undefined);
        this.addItem({ index: null, title: target.title, status: 'cancelled', stats: null });
        return this.finish(
          outcome === 'cancel' ? 'cancelled' : 'headphones',
          outcome === 'headphones' ? { notReady: 'headphones' } : {},
        );
      }
      this.update({ phase: 'aligning' });
      log.append(parseListenChunk(await listener.stop().catch(() => null)));
      const item = await this.alignAndSave(target, log, log.lastOccurrence(target.key));
      this.addItem(item);
      return this.finish(outcome === 'error' ? 'listener-error' : 'completed');
    } catch (e) {
      logger.error('autosync.failed', { message: e instanceof Error ? e.message.slice(0, 200) : 'unknown' });
      await listener.cancel().catch(() => undefined);
      return this.finish('listener-error');
    }
  }

  // ------------------------------------------------------------ 일괄

  private async runBatch(input: AutoSyncBatchInput): Promise<AutoSyncState> {
    const { listener, playback, logger, clock } = this.deps;
    try {
      const plan = await this.plan(input.tracks);
      const targets: Target[] = [];
      const skipped: AutoSyncItem[] = [];
      for (const p of plan) {
        if (p.status !== 'target') {
          skipped.push({ index: p.index, title: p.title, status: p.status, stats: null, skipped: true });
          continue;
        }
        const ref = input.tracks[p.index] as ServiceTrackRef;
        const c = await this.check(ref, false);
        if (c.status !== 'target' || !c.song || !c.lyrics || !c.locale) continue;
        targets.push({
          index: p.index,
          title: p.title,
          key: serviceKeyOf(ref),
          song: c.song,
          lyrics: c.lyrics,
          locale: c.locale,
          replaceTap: false,
        });
      }
      this.update({ items: skipped, total: targets.length });
      if (targets.length === 0) return this.finish('nothing-to-do');

      // 언어마다 준비(권한·언어 모델). 준비 못 한 언어의 곡은 빼고 진행
      const readyLocales = new Set<string>();
      let lastNotReady: ListenNotReady | null = null;
      for (const loc of new Set(targets.map((t) => t.locale))) {
        const r = await listener.prepare(loc);
        if (r.ok) readyLocales.add(loc);
        else {
          lastNotReady = r.reason;
          if (r.reason === 'headphones' || r.reason === 'mic-denied') {
            return this.finish(r.reason === 'headphones' ? 'headphones' : 'not-ready', { notReady: r.reason });
          }
        }
        if (this.requested() === 'cancel') return this.finish('cancelled');
      }
      const playable = targets.filter((t) => readyLocales.has(t.locale));
      for (const t of targets)
        if (!readyLocales.has(t.locale))
          this.addItem({ index: t.index, title: t.title, status: 'not-ready', stats: null });
      if (playable.length === 0) return this.finish('not-ready', { notReady: lastNotReady });

      const log = new ListenLog();
      const first = playable[0] as Target;
      await listener.start({ locale: first.locale, hints: autoSyncHints(first.lyrics) });
      logger.info('autosync.start', { mode: 'batch', targets: playable.length });
      await input.play(playable.map((t) => t.index as number));
      this.update({ phase: 'listening' });

      const byKey = new Map(playable.map((t) => [t.key, t] as const));
      const done = new Set<string>();
      const pending: Pending[] = [];
      let active: Target | null = null;
      let idleSince: number | null = null;
      let stop: AutoSyncStop = 'completed';

      const settle = async (force: boolean) => {
        for (let i = 0; i < pending.length;) {
          const p = pending[i] as Pending;
          const caughtUp = p.occ !== null && log.heardUntilAudioMs >= p.occ.toAudioMs;
          if (!force && !caughtUp && clock.monotonicMs() < p.dueAt) {
            i++;
            continue;
          }
          pending.splice(i, 1);
          this.addItem(await this.alignAndSave(p.target, log, p.occ));
          if (p.occ) log.pruneBefore(p.occ.toAudioMs - 2_000);
        }
      };
      const close = (t: Target) => {
        done.add(t.key);
        pending.push({ target: t, occ: log.lastOccurrence(t.key), dueAt: clock.monotonicMs() + this.settleMs });
      };

      for (;;) {
        await clock.sleep(this.pollMs);
        if (this.requested() !== 'none') {
          stop = 'cancelled';
          break;
        }
        const chunk = parseListenChunk(await listener.drain());
        log.append(chunk);
        if (BLOCKED_ROUTES.includes(chunk.route)) {
          stop = 'headphones';
          break;
        }
        if (chunk.error) {
          this.update({ error: chunk.error });
          stop = 'listener-error';
          break;
        }
        const snap = await playback.current().catch(() => null);
        const key = snap?.track ? serviceKeyOf(snap.track) : null;
        const t = key !== null && !done.has(key) ? (byKey.get(key) ?? null) : null;
        if (active && key !== active.key) {
          close(active);
          active = null;
        }
        if (t && t !== active) {
          active = t;
          // 곡 언어·가사 힌트로 바꿔 듣는다(오디오 시각은 이어짐)
          await listener.start({ locale: t.locale, hints: autoSyncHints(t.lyrics) });
        }
        this.update({
          levelDb: chunk.levelDb,
          current: active
            ? {
                index: active.index,
                title: active.title,
                heardWords: log.segmentCount,
                positionMs: snap?.positionMs ?? null,
              }
            : null,
        });
        await settle(false);
        if (done.size === playable.length) break;
        // 대상이 아닌 곡이 재생되거나 재생이 멈춘 채 오래 지나면 끝낸다
        if (!active) {
          idleSince ??= clock.monotonicMs();
          if (clock.monotonicMs() - idleSince > 15_000) {
            stop = 'track-changed';
            break;
          }
        } else idleSince = null;
      }

      // 듣기를 마치고 끝까지 들은 곡만 맞춘다. 듣던 중인 곡은 저장하지 않는다.
      if (stop === 'headphones') await listener.cancel().catch(() => undefined);
      else log.append(parseListenChunk(await listener.stop().catch(() => null)));
      if (stop !== 'headphones') await settle(true);
      else pending.length = 0;
      if (active) this.addItem({ index: active.index, title: active.title, status: 'cancelled', stats: null });
      for (const t of playable) {
        if (!done.has(t.key) && t !== active)
          this.addItem({ index: t.index, title: t.title, status: 'not-played', stats: null });
      }
      return this.finish(stop, stop === 'headphones' ? { notReady: 'headphones' } : {});
    } catch (e) {
      logger.error('autosync.failed', { message: e instanceof Error ? e.message.slice(0, 200) : 'unknown' });
      await listener.cancel().catch(() => undefined);
      return this.finish('listener-error');
    }
  }

  // ------------------------------------------------------------ 맞추기·저장

  private async alignAndSave(target: Target, log: ListenLog, occ: ListenOccurrence | null): Promise<AutoSyncItem> {
    const { store, session, clock, ids, logger } = this.deps;
    const base = { index: target.index, title: target.title };
    if (!occ) return { ...base, status: 'nothing-heard', stats: null };
    const win = log.window(occ);
    if (!win.coverage) return { ...base, status: 'nothing-heard', stats: null };
    const r = alignHeardToLyrics({
      lyrics: target.lyrics,
      heard: win.heard,
      coverage: win.coverage,
      durationMs: target.song.durationMs ?? win.durationMs,
    });
    const stats: AutoSyncStats = {
      totalLines: r.totalLines,
      heardLines: r.heardLines,
      filledLines: r.filledLines,
      untimedLines: r.untimedLines,
    };
    if (!r.ok) {
      logger.info('autosync.not_saved', { reason: r.reason, ...stats });
      return { ...base, status: r.reason, stats };
    }
    // 저장 직전 다시 확인: 가사 판본이 그대로이고, 그 사이 싱크 기록이 생기지 않았는지
    const song = await store.getSong(target.song.id);
    if (song?.activeLyricsVersionId !== target.lyrics.id) return { ...base, status: 'changed', stats };
    const timing = selectUserTiming(await store.listUserTimings(target.lyrics.id));
    if (timing && timing.method === 'tap' && !target.replaceTap) return { ...base, status: 'has-timing', stats };
    if (timing && target.index !== null) return { ...base, status: 'has-timing', stats };
    const built = buildTimingFromTaps(target.lyrics, r.taps);
    if (!built.ok) return { ...base, status: 'error', stats };
    await store.saveUserTiming({
      id: ids.next('tm'),
      lyricsVersionId: target.lyrics.id,
      kind: 'timed',
      lines: built.lines,
      method: 'auto',
      auto: { engine: `apple-speech/${target.locale}`, heardLines: r.heardLines, filledLines: r.filledLines },
      sourceTextHash: target.lyrics.textHash,
      createdAtEpochMs: clock.nowEpochMs(),
    });
    // 기록한 시간은 실제 재생 위치 기준이므로 곡별 보정은 0(탭 기록과 같음)
    await store.setSyncOffset(target.song.id, 0);
    await session.reloadTiming(target.lyrics.id);
    logger.info('autosync.saved', { ...stats });
    return { ...base, status: 'saved', stats };
  }
}
