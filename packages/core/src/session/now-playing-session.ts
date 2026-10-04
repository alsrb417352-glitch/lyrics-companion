import type { Clock, IdGenerator, PlaybackSnapshot, ServiceTrackRef } from '../ports.js';
import type { DisplaySettings, LyricsVersion, PronunciationVersion, Song, TranslationVersion } from '../model.js';
import { buildLyricsVersion } from '../lyrics/lyrics-version.js';
import {
  classifyLrclibRecord,
  type LyricsFetchResult,
  type LyricsNotice,
  type LyricsProvider,
} from '../lyrics/lyrics-provider.js';
import type { LrclibRecord } from '../lyrics/lrclib-client.js';
import { decideMatch, parseTitle, serviceKeyOf, type MatchCandidate } from '../matching/track-identity.js';
import type { Logger } from '../security/logger.js';
import type { LyricsStore } from '../storage/lyrics-store.js';
import { computeSync, type SyncConfig, type SyncResult } from '../sync/sync-engine.js';
import { selectPronunciation, selectTranslation } from '../translation/selection.js';
import type { TranslationOutcome, TranslationService } from '../translation/translation-service.js';
import { composeLyricsView, type LyricsScreenView } from '../display/compose.js';
import { validateUserMapping } from '../import/user-translation-import.js';

/**
 * 현재 곡 세션: 재생 정보 → 곡 식별 → 가사(저장본 우선) → 번역 정책 → 화면 상태.
 * 곡이 바뀌면 generation을 올려, 이전 곡의 늦은 응답이 현재 화면에 섞이지 않게 한다.
 */

export type SessionPhase = 'idle' | 'resolving' | 'needs-confirmation' | 'loading-lyrics' | 'ready' | 'no-lyrics';

export type TranslationStatus = 'none' | 'available' | 'pending' | 'failed' | 'skipped';

export interface SessionState {
  generation: number;
  phase: SessionPhase;
  track: ServiceTrackRef | null;
  song: Song | null;
  candidates: MatchCandidate[];
  /** 자동으로 확정하지 못한 가사 후보(사용자가 골라야 적용) */
  lyricsCandidates: LrclibRecord[];
  lyrics: LyricsVersion | null;
  translation: TranslationVersion | null;
  pronunciation: PronunciationVersion | null;
  display: DisplaySettings;
  offsetMs: number;
  translationStatus: TranslationStatus;
  lastOutcome: TranslationOutcome | null;
  notices: Array<LyricsNotice | 'offline' | 'rate-limited' | 'lyrics-error' | 'incompatible-version'>;
}

export interface SessionDeps {
  store: LyricsStore;
  lyrics: LyricsProvider;
  translation: TranslationService;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  sync?: SyncConfig;
}

export class NowPlayingSession {
  private state: SessionState;
  private readonly listeners = new Set<(s: SessionState) => void>();
  /** 백그라운드 작업 추적(테스트·종료 처리에서 대기용) */
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly deps: SessionDeps) {
    this.state = {
      generation: 0,
      phase: 'idle',
      track: null,
      song: null,
      candidates: [],
      lyricsCandidates: [],
      lyrics: null,
      translation: null,
      pronunciation: null,
      display: { showTranslation: true, showPronunciation: true },
      offsetMs: 0,
      translationStatus: 'none',
      lastOutcome: null,
      notices: [],
    };
  }

  /** 저장된 표시 설정 로드 + 중단된 작업 정리 */
  async start(): Promise<void> {
    await this.deps.translation.recoverInterruptedJobs();
    const display = await this.deps.store.getDisplaySettings();
    this.update({ display });
  }

  get current(): SessionState {
    return this.state;
  }

  subscribe(listener: (s: SessionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 진행 중인 백그라운드 작업이 모두 끝날 때까지 대기(테스트·종료용) */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  private update(patch: Partial<SessionState>, gen?: number): void {
    if (gen !== undefined && gen !== this.state.generation) return; // 오래된 결과 무시
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p)).catch(() => undefined);
    return p;
  }

  // ------------------------------------------------------------ 곡 변경

  async onTrackChanged(ref: ServiceTrackRef): Promise<void> {
    const gen = this.state.generation + 1;
    this.update({
      generation: gen,
      phase: 'resolving',
      track: ref,
      song: null,
      candidates: [],
      lyricsCandidates: [],
      lyrics: null,
      translation: null,
      pronunciation: null,
      offsetMs: 0,
      translationStatus: 'none',
      lastOutcome: null,
      notices: [],
    });
    const { store, clock } = this.deps;
    const key = serviceKeyOf(ref);
    let song = await store.findSongByServiceKey(ref.service, key);
    if (!song) {
      const decision = decideMatch(ref, await store.listSongs());
      if (decision.kind === 'auto-link') {
        song = decision.song;
        await store.linkServiceKey(ref.service, key, song.id, 'isrc', clock.nowEpochMs());
      } else if (decision.kind === 'candidates') {
        this.update({ phase: 'needs-confirmation', candidates: decision.candidates }, gen);
        return;
      } else {
        song = await this.createSong(ref);
      }
    }
    await this.loadSong(song, gen);
  }

  /** 후보 중 같은 녹음을 사용자가 확인한 경우 */
  async confirmCandidate(songId: string): Promise<void> {
    const gen = this.state.generation;
    const ref = this.state.track;
    if (!ref || this.state.phase !== 'needs-confirmation') return;
    const song = await this.deps.store.getSong(songId);
    if (!song) return;
    await this.deps.store.linkServiceKey(ref.service, serviceKeyOf(ref), song.id, 'user', this.deps.clock.nowEpochMs());
    await this.loadSong(song, gen);
  }

  /** 후보가 모두 다른 녹음이라고 사용자가 판단한 경우 */
  async rejectCandidates(): Promise<void> {
    const gen = this.state.generation;
    const ref = this.state.track;
    if (!ref || this.state.phase !== 'needs-confirmation') return;
    const song = await this.createSong(ref);
    await this.loadSong(song, gen);
  }

  private async createSong(ref: ServiceTrackRef): Promise<Song> {
    const { store, clock, ids } = this.deps;
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
    await store.linkServiceKey(ref.service, serviceKeyOf(ref), song.id, 'created', clock.nowEpochMs());
    return song;
  }

  private async loadSong(song: Song, gen: number): Promise<void> {
    const { store } = this.deps;
    const offsetMs = await store.getSyncOffset(song.id);
    this.update({ song, offsetMs, phase: 'loading-lyrics' }, gen);

    let lyrics = song.activeLyricsVersionId ? await store.getLyricsVersion(song.activeLyricsVersionId) : null;
    let notices: SessionState['notices'] = [];
    if (!lyrics) {
      // 저장본이 없을 때만 네트워크 조회
      const track = this.state.track;
      const res = await this.deps.lyrics.fetch({
        title: song.title,
        artist: song.artist,
        album: song.album,
        durationMs: song.durationMs,
        storeId: track?.service === 'apple-music' ? track.serviceTrackId : null,
      });
      if (gen !== this.state.generation) return;
      const saved = await this.saveFetched(song, res);
      if (!saved.lyrics) {
        this.update({ phase: 'no-lyrics', notices: saved.notices, lyricsCandidates: saved.candidates }, gen);
        return;
      }
      lyrics = saved.lyrics;
      notices = saved.notices;
    }
    await this.refreshTexts(lyrics, gen, notices);
    if (gen !== this.state.generation) return;
    if (!this.state.translation && lyrics.kind !== 'instrumental') {
      void this.track(
        this.runTranslation(() => this.deps.translation.ensureTranslation(lyrics.id, { trigger: 'auto' }), gen),
      );
    }
  }

  /** 가사 조회 결과를 새 판본으로 저장(활성화). 찾지 못했으면 알림·후보만 반환한다. */
  private async saveFetched(
    song: Song,
    res: LyricsFetchResult,
  ): Promise<{ lyrics: LyricsVersion | null; notices: SessionState['notices']; candidates: LrclibRecord[] }> {
    const notices: SessionState['notices'] = [];
    if (res.status === 'found') {
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
      notices.push(...res.notices);
      return { lyrics: v, notices, candidates: [] };
    }
    if (res.status === 'rate_limited') notices.push('rate-limited');
    else if (res.status === 'error')
      notices.push(res.kind === 'offline' || res.kind === 'timeout' ? 'offline' : 'lyrics-error');
    else if (res.reason === 'incompatible-version') notices.push('incompatible-version');
    return { lyrics: null, notices, candidates: res.status === 'not_found' ? (res.candidates ?? []) : [] };
  }

  /**
   * 사용자가 고른 가사 레코드를 현재 곡에 적용(후보 확인 또는 직접 검색 결과).
   * 기존 판본·번역은 지우지 않고 새 판본을 활성화한다(REQ-LY-04). AI 호출은 자동 번역 정책을 그대로 따른다.
   */
  async chooseLyricsRecord(record: LrclibRecord): Promise<{ ok: boolean; error?: string }> {
    const gen = this.state.generation;
    const song = this.state.song;
    if (!song) return { ok: false, error: '현재 곡이 없습니다' };
    const res = classifyLrclibRecord(record);
    if (res.status !== 'found') return { ok: false, error: '이 레코드에는 표시할 가사가 없습니다' };
    const saved = await this.saveFetched(song, res);
    if (gen !== this.state.generation || !saved.lyrics) return { ok: false, error: '곡이 바뀌었습니다' };
    const lyrics = saved.lyrics;
    this.update({ lyricsCandidates: [], translation: null, pronunciation: null, translationStatus: 'none' }, gen);
    await this.refreshTexts(lyrics, gen, saved.notices);
    if (gen === this.state.generation && !this.state.translation && lyrics.kind !== 'instrumental') {
      void this.track(
        this.runTranslation(() => this.deps.translation.ensureTranslation(lyrics.id, { trigger: 'auto' }), gen),
      );
    }
    return { ok: true };
  }

  private async refreshTexts(lyrics: LyricsVersion, gen: number, notices?: SessionState['notices']): Promise<void> {
    const { store } = this.deps;
    const translation = selectTranslation(await store.listTranslations(lyrics.id));
    const pronunciation = selectPronunciation(await store.listPronunciations(lyrics.id));
    this.update(
      {
        phase: 'ready',
        lyrics,
        translation,
        pronunciation,
        translationStatus: translation ? 'available' : this.state.translationStatus === 'pending' ? 'pending' : 'none',
        ...(notices ? { notices } : {}),
      },
      gen,
    );
  }

  private async runTranslation(fn: () => Promise<TranslationOutcome>, gen: number): Promise<TranslationOutcome> {
    this.update({ translationStatus: 'pending' }, gen);
    const outcome = await fn();
    // 곡이 바뀌었으면 결과(저장은 이미 완료됨)를 현재 화면에 반영하지 않는다.
    if (gen !== this.state.generation) return outcome;
    const lyrics = this.state.lyrics;
    if (lyrics) await this.refreshTexts(lyrics, gen);
    const status: TranslationStatus = this.state.translation
      ? 'available'
      : outcome.kind === 'skipped'
        ? 'skipped'
        : outcome.kind === 'existing'
          ? 'none'
          : 'failed'; // failed 또는 번역 부분만 실패한 created
    this.update({ translationStatus: status, lastOutcome: outcome }, gen);
    return outcome;
  }

  // ------------------------------------------------------------ 사용자 명령

  /** 사용자가 버튼으로 번역 요청(자동 번역이 꺼져 있어도 실행) */
  requestTranslation(opts: { acknowledgeUnknownOutcome?: boolean } = {}): Promise<TranslationOutcome> | null {
    const lv = this.state.lyrics;
    if (!lv) return null;
    const gen = this.state.generation;
    return this.track(
      this.runTranslation(() => this.deps.translation.ensureTranslation(lv.id, { trigger: 'user', ...opts }), gen),
    );
  }

  retranslate(opts: { acknowledgeUnknownOutcome?: boolean } = {}): Promise<TranslationOutcome> | null {
    const lv = this.state.lyrics;
    if (!lv) return null;
    const gen = this.state.generation;
    return this.track(this.runTranslation(() => this.deps.translation.retranslate(lv.id, opts), gen));
  }

  requestPronunciation(opts: { regenerate?: boolean } = {}): Promise<TranslationOutcome> | null {
    const lv = this.state.lyrics;
    if (!lv) return null;
    const gen = this.state.generation;
    return this.track(this.runTranslation(() => this.deps.translation.requestPronunciation(lv.id, opts), gen));
  }

  async saveUserTranslation(mapping: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
    const lv = this.state.lyrics;
    if (!lv) return { ok: false, error: '가사가 없습니다' };
    const gen = this.state.generation;
    const checked = validateUserMapping(lv, mapping);
    if (!checked.ok) return { ok: false, error: checked.error };
    await this.deps.store.saveUserTranslation({
      id: this.deps.ids.next('tr'),
      lyricsVersionId: lv.id,
      origin: 'user',
      lines: checked.lines,
      sourceTextHash: lv.textHash,
      provenance: null,
      createdAtEpochMs: this.deps.clock.nowEpochMs(),
    });
    await this.refreshTexts(lv, gen);
    return { ok: true };
  }

  /** 표시 설정 변경: 저장 + 화면 재구성만. 네트워크·AI 호출 없음. */
  async setDisplay(patch: Partial<DisplaySettings>): Promise<void> {
    const display = { ...this.state.display, ...patch };
    await this.deps.store.setDisplaySettings(display);
    this.update({ display });
  }

  async setOffset(offsetMs: number): Promise<void> {
    const song = this.state.song;
    if (!song) return;
    await this.deps.store.setSyncOffset(song.id, offsetMs);
    this.update({ offsetMs: await this.deps.store.getSyncOffset(song.id) });
  }

  // ------------------------------------------------------------ 화면

  syncFor(snapshot: PlaybackSnapshot | null): SyncResult {
    const lv = this.state.lyrics;
    if (!lv) return { mode: 'unknown', reason: 'no-snapshot' };
    const cur = this.state.track;
    const matches =
      !snapshot?.track || !cur
        ? undefined
        : serviceKeyOf(snapshot.track) === serviceKeyOf(cur) && snapshot.track.service === cur.service;
    return computeSync({
      kind: lv.kind,
      lines: lv.lines,
      snapshot,
      nowMonotonicMs: this.deps.clock.monotonicMs(),
      offsetMs: this.state.offsetMs,
      ...(matches !== undefined ? { trackMatches: matches } : {}),
      ...(this.deps.sync ? { config: this.deps.sync } : {}),
    });
  }

  screen(snapshot: PlaybackSnapshot | null): LyricsScreenView | null {
    const lv = this.state.lyrics;
    if (!lv) return null;
    return composeLyricsView({
      lyrics: lv,
      translation: this.state.translation,
      pronunciation: this.state.pronunciation,
      settings: this.state.display,
      sync: this.syncFor(snapshot),
    });
  }
}
