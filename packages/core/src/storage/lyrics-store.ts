import type {
  DisplaySettings,
  JobFailure,
  JobKind,
  JobStatus,
  LyricLine,
  LyricsVersion,
  PronunciationLine,
  PronunciationVersion,
  Provenance,
  Song,
  TranslationJob,
  TranslationSettings,
  TranslationVersion,
} from '../model.js';
import { DEFAULT_DISPLAY_SETTINGS, DEFAULT_TRANSLATION_SETTINGS } from '../model.js';
import type { StreamingService } from '../ports.js';
import { migrate } from './migrations.js';
import { inTransaction, SerialQueue, type SqlDriver, type SqlValue } from './sql-driver.js';
import {
  parseProviderConfig,
  serializeProviderConfig,
  validateProviderConfig,
  type ProviderConfig,
} from '../translation/provider-config.js';

/**
 * 로컬 영구 저장소(SQLite). 네트워크 없이 저장본을 열람할 수 있어야 한다.
 * - 가사 판본은 불변. 번역·발음은 판본 ID + 행 ID에 연결된다.
 * - 번역은 덮어쓰지 않고 새 행(버전)으로 추가한다. 표시 우선순위는 selectTranslation()이 결정한다.
 * - AI 결과 저장과 작업 완료 표시는 하나의 트랜잭션으로 처리한다.
 * - API 키 등 비밀정보는 이 저장소에 저장하지 않는다.
 */

export interface NewTranslation {
  id: string;
  lyricsVersionId: string;
  origin: 'user' | 'ai';
  lines: Record<string, string>;
  sourceTextHash: string;
  provenance: Provenance | null;
  createdAtEpochMs: number;
}

export interface NewPronunciation {
  id: string;
  lyricsVersionId: string;
  origin: 'user' | 'ai';
  lines: Record<string, PronunciationLine>;
  sourceTextHash: string;
  provenance: Provenance | null;
  createdAtEpochMs: number;
}

export interface AiCommit {
  jobId: string;
  translation: NewTranslation | null;
  pronunciation: NewPronunciation | null;
  /** 일부만 성공했을 때 남길 실패 정보(예: 읽기만 실패) */
  partialFailure: JobFailure | null;
  atEpochMs: number;
}

export interface UserDataExport {
  format: 'lyrics-companion-export';
  schemaVersion: number;
  exportedAtEpochMs: number;
  songs: Song[];
  lyricsVersions: LyricsVersion[];
  translations: TranslationVersion[];
  pronunciations: PronunciationVersion[];
  syncOffsets: Array<{ songId: string; offsetMs: number }>;
  settings: { display: DisplaySettings; translation: TranslationSettings };
}

type Row = Record<string, SqlValue>;

function str(v: SqlValue | undefined): string {
  if (typeof v !== 'string') throw new Error('저장소 데이터 형식 오류(string)');
  return v;
}
function strOrNull(v: SqlValue | undefined): string | null {
  return typeof v === 'string' ? v : null;
}
function num(v: SqlValue | undefined): number {
  if (typeof v !== 'number') throw new Error('저장소 데이터 형식 오류(number)');
  return v;
}
function numOrNull(v: SqlValue | undefined): number | null {
  return typeof v === 'number' ? v : null;
}
function parseJson<T>(v: SqlValue | undefined, guard: (x: unknown) => x is T): T {
  const parsed: unknown = JSON.parse(str(v));
  if (!guard(parsed)) throw new Error('저장소 JSON 형식 오류');
  return parsed;
}
const isStringArray = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === 'string');
const isStringMap = (x: unknown): x is Record<string, string> =>
  typeof x === 'object' && x !== null && !Array.isArray(x) && Object.values(x).every((v) => typeof v === 'string');
const isLines = (x: unknown): x is LyricLine[] =>
  Array.isArray(x) &&
  x.every(
    (l) =>
      typeof l === 'object' &&
      l !== null &&
      typeof (l as LyricLine).id === 'string' &&
      typeof (l as LyricLine).text === 'string' &&
      ((l as LyricLine).startMs === null || typeof (l as LyricLine).startMs === 'number'),
  );
const isPronMap = (x: unknown): x is Record<string, PronunciationLine> =>
  typeof x === 'object' &&
  x !== null &&
  Object.values(x).every(
    (v) =>
      typeof v === 'object' &&
      v !== null &&
      typeof (v as PronunciationLine).hangul === 'string' &&
      ((v as PronunciationLine).kana === null || typeof (v as PronunciationLine).kana === 'string'),
  );
const isFailure = (x: unknown): x is JobFailure =>
  typeof x === 'object' && x !== null && typeof (x as JobFailure).kind === 'string';

function provenanceOf(r: Row): Provenance | null {
  const providerId = strOrNull(r['provider_id']);
  if (!providerId) return null;
  return { providerId, model: strOrNull(r['model']) ?? '', promptVersion: strOrNull(r['prompt_version']) ?? '' };
}

export class LyricsStore {
  private readonly q = new SerialQueue();

  private constructor(private readonly db: SqlDriver) {}

  /** 저장소를 열고 최신 스키마로 마이그레이션한다. */
  static async open(db: SqlDriver): Promise<LyricsStore> {
    await migrate(db);
    return new LyricsStore(db);
  }

  close(): Promise<void> {
    return this.q.run(() => this.db.close());
  }

  // ------------------------------------------------------------ 곡

  async createSong(song: Song): Promise<void> {
    await this.q.run(() =>
      this.db.run(
        `INSERT INTO songs(id,title,artist,album,duration_ms,version_tags,isrc,active_lyrics_version_id,created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          song.id,
          song.title,
          song.artist,
          song.album,
          song.durationMs,
          JSON.stringify(song.versionTags),
          song.isrc,
          song.activeLyricsVersionId,
          song.createdAtEpochMs,
        ],
      ),
    );
  }

  private static toSong(r: Row): Song {
    return {
      id: str(r['id']),
      title: str(r['title']),
      artist: str(r['artist']),
      album: strOrNull(r['album']),
      durationMs: numOrNull(r['duration_ms']),
      versionTags: parseJson(r['version_tags'], isStringArray),
      isrc: strOrNull(r['isrc']),
      activeLyricsVersionId: strOrNull(r['active_lyrics_version_id']),
      createdAtEpochMs: num(r['created_at']),
    };
  }

  async getSong(id: string): Promise<Song | null> {
    const r = await this.q.run(() => this.db.get<Row>('SELECT * FROM songs WHERE id = ?', [id]));
    return r ? LyricsStore.toSong(r) : null;
  }

  async listSongs(): Promise<Song[]> {
    const rows = await this.q.run(() => this.db.all<Row>('SELECT * FROM songs ORDER BY created_at, id'));
    return rows.map((r) => LyricsStore.toSong(r));
  }

  async findSongByServiceKey(service: StreamingService, serviceKey: string): Promise<Song | null> {
    const r = await this.q.run(() =>
      this.db.get<Row>(
        `SELECT s.* FROM service_tracks t JOIN songs s ON s.id = t.song_id WHERE t.service = ? AND t.service_key = ?`,
        [service, serviceKey],
      ),
    );
    return r ? LyricsStore.toSong(r) : null;
  }

  async linkServiceKey(
    service: StreamingService,
    serviceKey: string,
    songId: string,
    linkedBy: 'created' | 'isrc' | 'user',
    atEpochMs: number,
  ): Promise<void> {
    await this.q.run(() =>
      this.db.run(
        `INSERT INTO service_tracks(service, service_key, song_id, linked_by, created_at) VALUES (?,?,?,?,?)
         ON CONFLICT(service, service_key) DO NOTHING`,
        [service, serviceKey, songId, linkedBy, atEpochMs],
      ),
    );
  }

  async setActiveLyricsVersion(songId: string, lyricsVersionId: string): Promise<void> {
    await this.q.run(() =>
      this.db.run('UPDATE songs SET active_lyrics_version_id = ? WHERE id = ?', [lyricsVersionId, songId]),
    );
  }

  // ------------------------------------------------------------ 가사 판본

  /** 판본 저장 + (선택) 활성 판본 지정을 원자적으로 */
  async saveLyricsVersion(v: LyricsVersion, opts: { activate: boolean }): Promise<void> {
    await this.q.run(() =>
      inTransaction(this.db, async () => {
        await this.db.run(
          `INSERT INTO lyrics_versions(id,song_id,source,source_ref,kind,language,lines_json,text_hash,content_hash,has_word_timing_source,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [
            v.id,
            v.songId,
            v.source,
            v.sourceRef,
            v.kind,
            v.language,
            JSON.stringify(v.lines),
            v.textHash,
            v.contentHash,
            v.hasWordTimingSource ? 1 : 0,
            v.createdAtEpochMs,
          ],
        );
        if (opts.activate) {
          await this.db.run('UPDATE songs SET active_lyrics_version_id = ? WHERE id = ?', [v.id, v.songId]);
        }
      }),
    );
  }

  private static toLyrics(r: Row): LyricsVersion {
    const kind = str(r['kind']);
    if (kind !== 'synced' && kind !== 'plain' && kind !== 'instrumental') throw new Error('kind 형식 오류');
    const source = str(r['source']);
    if (source !== 'lrclib' && source !== 'user') throw new Error('source 형식 오류');
    const lang = str(r['language']);
    return {
      id: str(r['id']),
      songId: str(r['song_id']),
      source,
      sourceRef: strOrNull(r['source_ref']),
      kind,
      language: lang === 'ja' || lang === 'en' || lang === 'ko' || lang === 'mixed' ? lang : 'unknown',
      lines: parseJson(r['lines_json'], isLines),
      textHash: str(r['text_hash']),
      contentHash: str(r['content_hash']),
      hasWordTimingSource: num(r['has_word_timing_source']) === 1,
      createdAtEpochMs: num(r['created_at']),
    };
  }

  async getLyricsVersion(id: string): Promise<LyricsVersion | null> {
    const r = await this.q.run(() => this.db.get<Row>('SELECT * FROM lyrics_versions WHERE id = ?', [id]));
    return r ? LyricsStore.toLyrics(r) : null;
  }

  async listLyricsVersions(songId: string): Promise<LyricsVersion[]> {
    const rows = await this.q.run(() =>
      this.db.all<Row>('SELECT * FROM lyrics_versions WHERE song_id = ? ORDER BY created_at, id', [songId]),
    );
    return rows.map((r) => LyricsStore.toLyrics(r));
  }

  // ------------------------------------------------------------ 번역·발음

  private insertTranslation(t: NewTranslation): Promise<{ changes: number }> {
    return this.db.run(
      `INSERT INTO translations(id,lyrics_version_id,origin,lines_json,source_text_hash,provider_id,model,prompt_version,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        t.id,
        t.lyricsVersionId,
        t.origin,
        JSON.stringify(t.lines),
        t.sourceTextHash,
        t.provenance?.providerId ?? null,
        t.provenance?.model ?? null,
        t.provenance?.promptVersion ?? null,
        t.createdAtEpochMs,
      ],
    );
  }

  private insertPronunciation(p: NewPronunciation): Promise<{ changes: number }> {
    return this.db.run(
      `INSERT INTO pronunciations(id,lyrics_version_id,origin,lines_json,source_text_hash,provider_id,model,prompt_version,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        p.id,
        p.lyricsVersionId,
        p.origin,
        JSON.stringify(p.lines),
        p.sourceTextHash,
        p.provenance?.providerId ?? null,
        p.provenance?.model ?? null,
        p.provenance?.promptVersion ?? null,
        p.createdAtEpochMs,
      ],
    );
  }

  /** 사용자 번역 저장(새 버전 추가). 기존 버전은 보존된다. */
  async saveUserTranslation(t: NewTranslation): Promise<void> {
    if (t.origin !== 'user') throw new Error('saveUserTranslation은 user 번역만 저장합니다');
    await this.q.run(() => inTransaction(this.db, () => this.insertTranslation(t)));
  }

  async saveUserPronunciation(p: NewPronunciation): Promise<void> {
    if (p.origin !== 'user') throw new Error('saveUserPronunciation은 user 발음만 저장합니다');
    await this.q.run(() => inTransaction(this.db, () => this.insertPronunciation(p)));
  }

  private static toTranslation(r: Row): TranslationVersion {
    const origin = str(r['origin']);
    if (origin !== 'user' && origin !== 'ai') throw new Error('origin 형식 오류');
    return {
      id: str(r['id']),
      lyricsVersionId: str(r['lyrics_version_id']),
      origin,
      lines: parseJson(r['lines_json'], isStringMap),
      sourceTextHash: str(r['source_text_hash']),
      provenance: provenanceOf(r),
      createdAtEpochMs: num(r['created_at']),
      seq: num(r['seq']),
    };
  }

  private static toPronunciation(r: Row): PronunciationVersion {
    const origin = str(r['origin']);
    if (origin !== 'user' && origin !== 'ai') throw new Error('origin 형식 오류');
    return {
      id: str(r['id']),
      lyricsVersionId: str(r['lyrics_version_id']),
      origin,
      lines: parseJson(r['lines_json'], isPronMap),
      sourceTextHash: str(r['source_text_hash']),
      provenance: provenanceOf(r),
      createdAtEpochMs: num(r['created_at']),
      seq: num(r['seq']),
    };
  }

  async listTranslations(lyricsVersionId: string): Promise<TranslationVersion[]> {
    const rows = await this.q.run(() =>
      this.db.all<Row>('SELECT * FROM translations WHERE lyrics_version_id = ? ORDER BY seq', [lyricsVersionId]),
    );
    return rows.map((r) => LyricsStore.toTranslation(r));
  }

  async listPronunciations(lyricsVersionId: string): Promise<PronunciationVersion[]> {
    const rows = await this.q.run(() =>
      this.db.all<Row>('SELECT * FROM pronunciations WHERE lyrics_version_id = ? ORDER BY seq', [lyricsVersionId]),
    );
    return rows.map((r) => LyricsStore.toPronunciation(r));
  }

  // ------------------------------------------------------------ 작업 상태

  async createJob(job: TranslationJob): Promise<void> {
    await this.q.run(() =>
      this.db.run(
        `INSERT INTO jobs(id,lyrics_version_id,kind,status,provider_id,model,prompt_version,failure_json,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          job.id,
          job.lyricsVersionId,
          job.kind,
          job.status,
          job.providerId,
          job.model,
          job.promptVersion,
          job.failure ? JSON.stringify(job.failure) : null,
          job.createdAtEpochMs,
          job.updatedAtEpochMs,
        ],
      ),
    );
  }

  async updateJob(id: string, status: JobStatus, failure: JobFailure | null, atEpochMs: number): Promise<void> {
    await this.q.run(() =>
      this.db.run('UPDATE jobs SET status = ?, failure_json = ?, updated_at = ? WHERE id = ?', [
        status,
        failure ? JSON.stringify(failure) : null,
        atEpochMs,
        id,
      ]),
    );
  }

  private static toJob(r: Row): TranslationJob {
    const failureJson = r['failure_json'];
    return {
      id: str(r['id']),
      lyricsVersionId: str(r['lyrics_version_id']),
      kind: str(r['kind']) as JobKind,
      status: str(r['status']) as JobStatus,
      providerId: str(r['provider_id']),
      model: str(r['model']),
      promptVersion: str(r['prompt_version']),
      failure: typeof failureJson === 'string' ? parseJson(failureJson, isFailure) : null,
      createdAtEpochMs: num(r['created_at']),
      updatedAtEpochMs: num(r['updated_at']),
    };
  }

  async listJobs(filter: { lyricsVersionId?: string; status?: JobStatus } = {}): Promise<TranslationJob[]> {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (filter.lyricsVersionId) {
      where.push('lyrics_version_id = ?');
      params.push(filter.lyricsVersionId);
    }
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    const sql = `SELECT * FROM jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, id`;
    const rows = await this.q.run(() => this.db.all<Row>(sql, params));
    return rows.map((r) => LyricsStore.toJob(r));
  }

  /** 앱 시작 시: 진행 중이던 작업은 결과를 알 수 없으므로 unknown_outcome으로 바꾼다(자동 재요청 금지). */
  async markInterruptedJobs(atEpochMs: number): Promise<number> {
    const res = await this.q.run(() =>
      this.db.run(
        `UPDATE jobs SET status = 'unknown_outcome', updated_at = ?,
           failure_json = '{"kind":"unknown","message":"앱 종료로 결과 미확인","retryScope":"all","billedRisk":"possible"}'
         WHERE status = 'in_flight'`,
        [atEpochMs],
      ),
    );
    return res.changes;
  }

  /**
   * AI 결과를 원자적으로 저장하고 작업을 완료 처리한다.
   * 트랜잭션 중 하나라도 실패하면 아무것도 저장되지 않으며 호출자가 작업을 failed로 기록한다.
   */
  async commitAiResult(c: AiCommit): Promise<void> {
    await this.q.run(() =>
      inTransaction(this.db, async () => {
        const job = await this.db.get<Row>('SELECT status FROM jobs WHERE id = ?', [c.jobId]);
        if (!job || job['status'] !== 'in_flight') throw new Error('작업 상태가 in_flight가 아님');
        if (c.translation) await this.insertTranslation(c.translation);
        if (c.pronunciation) await this.insertPronunciation(c.pronunciation);
        await this.db.run('UPDATE jobs SET status = ?, failure_json = ?, updated_at = ? WHERE id = ?', [
          'completed',
          c.partialFailure ? JSON.stringify(c.partialFailure) : null,
          c.atEpochMs,
          c.jobId,
        ]);
      }),
    );
  }

  // ------------------------------------------------------------ 사용량

  /** 요청 전 예약: 일일 상한을 넘으면 false(원자적 검사+증가) */
  async reserveUsage(day: string, sourceChars: number, maxRequests: number): Promise<boolean> {
    return this.q.run(() =>
      inTransaction(this.db, async () => {
        const r = await this.db.get<Row>('SELECT requests FROM usage_daily WHERE day = ?', [day]);
        const used = r ? num(r['requests']) : 0;
        if (used >= maxRequests) return false;
        await this.db.run(
          `INSERT INTO usage_daily(day, requests, source_chars) VALUES (?, 1, ?)
           ON CONFLICT(day) DO UPDATE SET requests = requests + 1, source_chars = source_chars + excluded.source_chars`,
          [day, sourceChars],
        );
        return true;
      }),
    );
  }

  async getUsage(day: string): Promise<{ requests: number; sourceChars: number }> {
    const r = await this.q.run(() => this.db.get<Row>('SELECT * FROM usage_daily WHERE day = ?', [day]));
    return { requests: r ? num(r['requests']) : 0, sourceChars: r ? num(r['source_chars']) : 0 };
  }

  // ------------------------------------------------------------ 설정·싱크 보정

  private async getSetting(key: string): Promise<string | null> {
    const r = await this.q.run(() => this.db.get<Row>('SELECT value FROM settings WHERE key = ?', [key]));
    return r ? str(r['value']) : null;
  }

  private async setSettings(entries: Array<[string, string]>): Promise<void> {
    await this.q.run(() =>
      inTransaction(this.db, async () => {
        for (const [k, v] of entries) {
          await this.db.run(
            'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            [k, v],
          );
        }
      }),
    );
  }

  async getDisplaySettings(): Promise<DisplaySettings> {
    const t = await this.getSetting('display.show_translation');
    const p = await this.getSetting('display.show_pronunciation');
    return {
      showTranslation: t === null ? DEFAULT_DISPLAY_SETTINGS.showTranslation : t === 'true',
      showPronunciation: p === null ? DEFAULT_DISPLAY_SETTINGS.showPronunciation : p === 'true',
    };
  }

  async setDisplaySettings(s: DisplaySettings): Promise<void> {
    await this.setSettings([
      ['display.show_translation', String(s.showTranslation)],
      ['display.show_pronunciation', String(s.showPronunciation)],
    ]);
  }

  async getTranslationSettings(): Promise<TranslationSettings> {
    const a = await this.getSetting('translate.auto');
    return { autoTranslate: a === null ? DEFAULT_TRANSLATION_SETTINGS.autoTranslate : a === 'true' };
  }

  async setTranslationSettings(s: TranslationSettings): Promise<void> {
    await this.setSettings([['translate.auto', String(s.autoTranslate)]]);
  }

  /** AI 제공자 설정(비밀 아님). API 키는 저장하지 않는다. */
  async getProviderConfig(): Promise<ProviderConfig | null> {
    return parseProviderConfig(await this.getSetting('provider.config'));
  }

  async setProviderConfig(c: ProviderConfig | null): Promise<void> {
    if (c === null) {
      await this.q.run(() => this.db.run("DELETE FROM settings WHERE key = 'provider.config'"));
      return;
    }
    const checked = validateProviderConfig(c);
    if (!checked.ok) throw new Error(checked.error);
    await this.setSettings([['provider.config', serializeProviderConfig(checked.config)]]);
  }

  async getSyncOffset(songId: string): Promise<number> {
    const r = await this.q.run(() =>
      this.db.get<Row>('SELECT offset_ms FROM sync_offsets WHERE song_id = ?', [songId]),
    );
    return r ? num(r['offset_ms']) : 0;
  }

  async setSyncOffset(songId: string, offsetMs: number): Promise<void> {
    const clamped = Math.max(-30_000, Math.min(30_000, Math.round(offsetMs)));
    await this.q.run(() =>
      this.db.run(
        'INSERT INTO sync_offsets(song_id, offset_ms) VALUES (?, ?) ON CONFLICT(song_id) DO UPDATE SET offset_ms = excluded.offset_ms',
        [songId, clamped],
      ),
    );
  }

  // ------------------------------------------------------------ 내보내기

  /** 사용자 데이터 내보내기. 비밀정보는 저장소에 없으므로 포함될 수 없다(테스트 AT-13으로 확인). */
  async exportUserData(schemaVersion: number, atEpochMs: number): Promise<UserDataExport> {
    const songs = await this.listSongs();
    const lyricsVersions: LyricsVersion[] = [];
    const translations: TranslationVersion[] = [];
    const pronunciations: PronunciationVersion[] = [];
    const syncOffsets: Array<{ songId: string; offsetMs: number }> = [];
    for (const s of songs) {
      for (const lv of await this.listLyricsVersions(s.id)) {
        lyricsVersions.push(lv);
        translations.push(...(await this.listTranslations(lv.id)));
        pronunciations.push(...(await this.listPronunciations(lv.id)));
      }
      const off = await this.getSyncOffset(s.id);
      if (off !== 0) syncOffsets.push({ songId: s.id, offsetMs: off });
    }
    return {
      format: 'lyrics-companion-export',
      schemaVersion,
      exportedAtEpochMs: atEpochMs,
      songs,
      lyricsVersions,
      translations,
      pronunciations,
      syncOffsets,
      settings: { display: await this.getDisplaySettings(), translation: await this.getTranslationSettings() },
    };
  }
}
