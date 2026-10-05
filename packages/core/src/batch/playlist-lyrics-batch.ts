import type { CancelSignal, Clock, IdGenerator, ServiceTrackRef } from '../ports.js';
import type { LyricsKind, Song } from '../model.js';
import { buildLyricsVersion } from '../lyrics/lyrics-version.js';
import type { LyricsProvider } from '../lyrics/lyrics-provider.js';
import { decideMatch, parseTitle, serviceKeyOf } from '../matching/track-identity.js';
import type { Logger } from '../security/logger.js';
import type { LyricsStore } from '../storage/lyrics-store.js';

/**
 * 플레이리스트 가사 원문 일괄 받기(REQ-LY-05, docs/plan.md D-31).
 *
 * 곡마다 재생해서 받던 가사 원문을 플레이리스트 단위로 미리 받아 저장한다. 나중에 그 곡을 재생하면
 * 지금 재생 화면은 저장본을 쓰므로 네트워크 조회 없이 바로 가사가 나온다.
 *
 * 규칙
 * - 가사 원문만 받는다. AI(번역·발음)는 부르지 않는다 — 이 클래스는 번역 서비스에 의존하지 않는다.
 * - 이미 가사가 저장된 곡은 건너뛴다(사용자가 고른 판본·번역을 바꾸지 않음, REQ-LY-04).
 * - 곡 식별은 지금 재생과 같은 규칙(불변조건 6). 저장된 다른 곡과 같은 녹음인지 불확실하면(후보) 곡을 만들지 않고
 *   "확인 필요"로 남긴다 → 재생할 때 지금 재생 화면에서 사용자가 확인한다.
 * - 가사 후보만 있고 확정하지 못한 경우(가수 표기가 다름 등)도 자동 적용하지 않고 "가사 선택 필요"로 남긴다.
 * - 순차 처리(LRCLIB 클라이언트가 요청 간격·Retry-After를 지킴). 429면 짧은 대기는 기다렸다 같은 곡을 한 번 더 시도하고,
 *   길면 멈춘다. 오프라인이면 멈춘다. 다시 실행하면 저장된 곡은 건너뛰므로 이어서 받는 것과 같다.
 * - 취소하면 다음 곡으로 넘어가기 전에 멈춘다(이미 저장한 곡은 그대로 둔다). 저장은 곡마다 원자적이다.
 */

export type BatchItemStatus =
  /** 새로 받아 저장함 */
  | 'saved'
  /** 이미 저장된 가사가 있어 건너뜀(네트워크 조회 없음) */
  | 'already-saved'
  /** 저장된 다른 곡과 같은 녹음인지 불확실 → 재생할 때 확인 */
  | 'needs-song-confirmation'
  /** 가사 후보는 있지만 같은 곡인지 확정 못 함 → 재생할 때 직접 고름 */
  | 'needs-lyrics-choice'
  /** LRCLIB에 이 녹음의 가사가 없음 */
  | 'not-found'
  /** 찾은 가사가 다른 버전(라이브·리믹스·길이 차이)이라 쓰지 않음 */
  | 'incompatible-version'
  /** 같은 플레이리스트 안의 중복 곡 */
  | 'duplicate'
  /** 서버 오류 등으로 이 곡만 실패 */
  | 'error';

export type BatchStopReason = 'completed' | 'cancelled' | 'offline' | 'rate-limited' | 'too-many-errors';

export interface BatchItemResult {
  /** 입력 목록에서의 위치 */
  index: number;
  title: string;
  artist: string;
  status: BatchItemStatus;
  songId: string | null;
  /** saved일 때 가사 종류 */
  kind?: LyricsKind;
}

export type BatchCounts = Record<BatchItemStatus, number>;

export interface BatchState {
  running: boolean;
  /** 표시용 이름(플레이리스트 이름) */
  label: string | null;
  /** 어떤 목록의 실행인지(플레이리스트 persistentId 등). 화면이 자기 결과인지 구분하는 데 쓴다 */
  key: string | null;
  total: number;
  /** 처리한 곡 수(결과가 정해진 곡) */
  done: number;
  counts: BatchCounts;
  items: BatchItemResult[];
  /** 지금 처리 중인 곡 */
  current: { index: number; title: string } | null;
  /** 요청 제한으로 기다리는 중이면 남은 대략 시간(ms) */
  waitingMs: number | null;
  stoppedBy: BatchStopReason | null;
  /** 멈춘 경우 요청 제한 해제까지 남은 시간(ms) */
  retryAfterMs: number | null;
}

export interface BatchInput {
  label: string;
  key?: string | null;
  tracks: readonly ServiceTrackRef[];
}

export interface PlaylistLyricsBatchDeps {
  store: LyricsStore;
  lyrics: LyricsProvider;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  /** 429 Retry-After가 이보다 짧으면 기다렸다 이어서 받는다(기본 30초) */
  maxAutoWaitMs?: number;
  /** 연속으로 이만큼 곡별 오류가 나면 멈춘다(기본 3) */
  maxConsecutiveErrors?: number;
}

export function emptyCounts(): BatchCounts {
  return {
    saved: 0,
    'already-saved': 0,
    'needs-song-confirmation': 0,
    'needs-lyrics-choice': 0,
    'not-found': 0,
    'incompatible-version': 0,
    duplicate: 0,
    error: 0,
  };
}

const IDLE: BatchState = {
  running: false,
  label: null,
  key: null,
  total: 0,
  done: 0,
  counts: emptyCounts(),
  items: [],
  current: null,
  waitingMs: null,
  stoppedBy: null,
  retryAfterMs: null,
};

type Step =
  | { kind: 'result'; status: BatchItemStatus; songId: string | null; lyricsKind?: LyricsKind }
  | { kind: 'stop'; reason: BatchStopReason; retryAfterMs?: number };

export class PlaylistLyricsBatch {
  private state: BatchState = IDLE;
  private readonly listeners = new Set<(s: BatchState) => void>();
  private cancelToken: { aborted: boolean } | null = null;
  private readonly maxAutoWaitMs: number;
  private readonly maxConsecutiveErrors: number;

  constructor(private readonly deps: PlaylistLyricsBatchDeps) {
    this.maxAutoWaitMs = deps.maxAutoWaitMs ?? 30_000;
    this.maxConsecutiveErrors = deps.maxConsecutiveErrors ?? 3;
  }

  get current(): BatchState {
    return this.state;
  }

  subscribe(listener: (s: BatchState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private update(patch: Partial<BatchState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  /** 지난 결과 지우기(실행 중에는 무시) */
  reset(): void {
    if (!this.state.running) this.update(IDLE);
  }

  /** 다음 곡으로 넘어가기 전에 멈춘다. 이미 저장한 곡은 그대로 둔다. */
  cancel(): void {
    if (this.cancelToken) this.cancelToken.aborted = true;
  }

  /**
   * 네트워크 없이 저장소만 보고, 가사가 이미 저장된 곡의 위치를 돌려준다(버튼에 "미저장 n곡" 표시용).
   */
  async savedIndexes(tracks: readonly ServiceTrackRef[]): Promise<Set<number>> {
    const out = new Set<number>();
    for (let i = 0; i < tracks.length; i++) {
      const ref = tracks[i];
      if (!ref) continue;
      const song = await this.deps.store.findSongByServiceKey(ref.service, serviceKeyOf(ref));
      if (song?.activeLyricsVersionId) out.add(i);
    }
    return out;
  }

  /**
   * 일괄 받기 실행. 이미 실행 중이면 null(동시에 두 번 돌지 않음).
   * 결과는 반환값과 current/subscribe로 모두 볼 수 있다.
   */
  start(input: BatchInput): Promise<BatchState> | null {
    if (this.state.running) return null;
    const token = { aborted: false };
    this.cancelToken = token;
    this.update({
      ...IDLE,
      running: true,
      label: input.label,
      key: input.key ?? null,
      total: input.tracks.length,
      counts: emptyCounts(),
    });
    return this.run(input.tracks, token).finally(() => {
      if (this.cancelToken === token) this.cancelToken = null;
    });
  }

  private async run(tracks: readonly ServiceTrackRef[], signal: CancelSignal): Promise<BatchState> {
    const { logger } = this.deps;
    const seen = new Set<string>();
    let consecutiveErrors = 0;
    let stoppedBy: BatchStopReason = 'completed';
    let retryAfterMs: number | null = null;
    logger.info('batch.start', { total: tracks.length });
    try {
      for (let index = 0; index < tracks.length; index++) {
        if (signal.aborted) {
          stoppedBy = 'cancelled';
          break;
        }
        const ref = tracks[index];
        if (!ref) continue;
        this.update({ current: { index, title: ref.title }, waitingMs: null });

        const dedupeKey = `${ref.service}\u0000${serviceKeyOf(ref)}`;
        let step: Step;
        if (seen.has(dedupeKey)) {
          step = { kind: 'result', status: 'duplicate', songId: null };
        } else {
          seen.add(dedupeKey);
          step = await this.processOne(ref, signal);
        }

        if (step.kind === 'stop') {
          stoppedBy = step.reason;
          retryAfterMs = step.retryAfterMs ?? null;
          break;
        }
        consecutiveErrors = step.status === 'error' ? consecutiveErrors + 1 : 0;
        const item: BatchItemResult = {
          index,
          title: ref.title,
          artist: ref.artist,
          status: step.status,
          songId: step.songId,
          ...(step.lyricsKind ? { kind: step.lyricsKind } : {}),
        };
        const counts = { ...this.state.counts, [step.status]: this.state.counts[step.status] + 1 };
        this.update({ items: [...this.state.items, item], counts, done: this.state.done + 1 });
        if (consecutiveErrors >= this.maxConsecutiveErrors) {
          stoppedBy = 'too-many-errors';
          break;
        }
      }
    } catch (e) {
      // 저장소 오류 등 예상하지 못한 실패: 지금까지 저장한 것은 그대로 두고 멈춘다.
      logger.error('batch.failed', { message: e instanceof Error ? e.message.slice(0, 200) : 'unknown' });
      stoppedBy = 'too-many-errors';
    }
    // 가사 원문·제목은 로그에 남기지 않는다(개수만).
    logger.info('batch.end', { stoppedBy, done: this.state.done, total: tracks.length, ...this.state.counts });
    this.update({ running: false, current: null, waitingMs: null, stoppedBy, retryAfterMs });
    return this.state;
  }

  /** 한 곡 처리: 곡 식별 → 저장본 확인 → (없을 때만) 조회 → 저장 */
  private async processOne(ref: ServiceTrackRef, signal: CancelSignal): Promise<Step> {
    const resolved = await this.resolveSong(ref);
    if (resolved.kind === 'needs-confirmation') {
      return { kind: 'result', status: 'needs-song-confirmation', songId: null };
    }
    let song = resolved.song;
    if (song.activeLyricsVersionId) return { kind: 'result', status: 'already-saved', songId: song.id };

    for (let attempt = 0; ; attempt++) {
      const res = await this.deps.lyrics.fetch(
        {
          title: song.title,
          artist: song.artist,
          album: song.album,
          durationMs: song.durationMs,
          storeId: ref.service === 'apple-music' ? ref.serviceTrackId : null,
        },
        signal,
      );
      switch (res.status) {
        case 'found': {
          // 조회하는 동안 지금 재생 화면이 같은 곡의 가사를 저장했으면 덮지 않는다.
          song = (await this.deps.store.getSong(song.id)) ?? song;
          if (song.activeLyricsVersionId) return { kind: 'result', status: 'already-saved', songId: song.id };
          const v = buildLyricsVersion({
            id: this.deps.ids.next('lv'),
            songId: song.id,
            source: 'lrclib',
            sourceRef: res.sourceRef,
            kind: res.kind,
            ...(res.kind === 'synced' ? { timed: res.timed } : {}),
            ...(res.kind === 'plain' ? { plain: res.plain } : {}),
            hasWordTimingSource: res.hasWordTiming,
            createdAtEpochMs: this.deps.clock.nowEpochMs(),
          });
          await this.deps.store.saveLyricsVersion(v, { activate: true });
          return { kind: 'result', status: 'saved', songId: song.id, lyricsKind: res.kind };
        }
        case 'not_found': {
          if (res.candidates && res.candidates.length > 0) {
            return { kind: 'result', status: 'needs-lyrics-choice', songId: song.id };
          }
          const status = res.reason === 'incompatible-version' ? 'incompatible-version' : 'not-found';
          return { kind: 'result', status, songId: song.id };
        }
        case 'rate_limited': {
          if (attempt >= 1 || res.retryAfterMs > this.maxAutoWaitMs) {
            return { kind: 'stop', reason: 'rate-limited', retryAfterMs: res.retryAfterMs };
          }
          this.update({ waitingMs: res.retryAfterMs });
          await this.deps.clock.sleep(res.retryAfterMs, signal);
          if (signal.aborted) return { kind: 'stop', reason: 'cancelled' };
          this.update({ waitingMs: null });
          continue; // 같은 곡을 한 번 더(LRCLIB가 요구한 대기 후의 일반 조회 요청)
        }
        case 'error': {
          if (res.kind === 'offline') return { kind: 'stop', reason: 'offline' };
          if (res.kind === 'aborted' || signal.aborted) return { kind: 'stop', reason: 'cancelled' };
          return { kind: 'result', status: 'error', songId: song.id };
        }
      }
    }
  }

  /** 지금 재생(NowPlayingSession.onTrackChanged)과 같은 곡 식별. 후보면 곡을 만들지 않는다. */
  private async resolveSong(
    ref: ServiceTrackRef,
  ): Promise<{ kind: 'song'; song: Song } | { kind: 'needs-confirmation' }> {
    const { store, clock, ids } = this.deps;
    const key = serviceKeyOf(ref);
    const linked = await store.findSongByServiceKey(ref.service, key);
    if (linked) return { kind: 'song', song: linked };
    const decision = decideMatch(ref, await store.listSongs());
    if (decision.kind === 'auto-link') {
      await store.linkServiceKey(ref.service, key, decision.song.id, 'isrc', clock.nowEpochMs());
      return { kind: 'song', song: decision.song };
    }
    if (decision.kind === 'candidates') return { kind: 'needs-confirmation' };
    const parsed = parseTitle(ref.title, ref.album);
    const song: Song = {
      id: ids.next('song'),
      title: ref.title,
      artist: ref.artist,
      album: ref.album,
      durationMs: ref.durationMs,
      versionTags: parsed.versionTags,
      isrc: ref.isrc,
      activeLyricsVersionId: null,
      createdAtEpochMs: clock.nowEpochMs(),
    };
    await store.createSong(song);
    await store.linkServiceKey(ref.service, key, song.id, 'created', clock.nowEpochMs());
    // 지금 재생 화면이 같은 순간 같은 곡을 먼저 연결했으면(ON CONFLICT DO NOTHING) 그 곡을 쓴다.
    const winner = await store.findSongByServiceKey(ref.service, key);
    return { kind: 'song', song: winner ?? song };
  }
}

/** 결과 요약 문장(화면·접근성용). 0인 항목은 뺀다. */
export function summarizeBatch(s: Pick<BatchState, 'counts' | 'done' | 'total'>): string {
  const c = s.counts;
  const parts: string[] = [];
  if (c.saved) parts.push(`새로 저장 ${c.saved}`);
  if (c['already-saved']) parts.push(`이미 있음 ${c['already-saved']}`);
  const check = c['needs-song-confirmation'] + c['needs-lyrics-choice'];
  if (check) parts.push(`확인 필요 ${check}`);
  const missing = c['not-found'] + c['incompatible-version'];
  if (missing) parts.push(`못 찾음 ${missing}`);
  if (c.error) parts.push(`오류 ${c.error}`);
  if (c.duplicate) parts.push(`중복 ${c.duplicate}`);
  return `${s.done}/${s.total}곡${parts.length ? ` · ${parts.join(' · ')}` : ''}`;
}
