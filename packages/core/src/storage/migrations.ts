import { inTransaction, type SqlDriver } from './sql-driver.js';

/**
 * 스키마 마이그레이션. PRAGMA user_version으로 버전을 관리한다.
 * 규칙:
 * - 마이그레이션은 추가만 한다. 이미 배포된 마이그레이션은 수정하지 않는다.
 * - 각 마이그레이션은 트랜잭션 안에서 실행되고, 실패하면 이전 상태로 롤백된다.
 * - 사용자 번역·설정·싱크 보정값을 삭제하는 마이그레이션은 금지한다(테스트 AT-14로 검증).
 * - 앱 계층은 마이그레이션 전에 DB 파일 백업 사본을 만든다(docs/security.md 저장 정책).
 */

export interface Migration {
  version: number;
  description: string;
  statements: string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: '초기 스키마: 곡·서비스 연결·가사 판본·번역·발음·싱크 보정·설정',
    statements: [
      `CREATE TABLE songs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        album TEXT,
        duration_ms INTEGER,
        version_tags TEXT NOT NULL DEFAULT '[]',
        isrc TEXT,
        active_lyrics_version_id TEXT,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE service_tracks (
        service TEXT NOT NULL,
        service_key TEXT NOT NULL,
        song_id TEXT NOT NULL REFERENCES songs(id),
        linked_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (service, service_key)
      )`,
      `CREATE TABLE lyrics_versions (
        id TEXT PRIMARY KEY,
        song_id TEXT NOT NULL REFERENCES songs(id),
        source TEXT NOT NULL,
        source_ref TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('synced','plain','instrumental')),
        language TEXT NOT NULL,
        lines_json TEXT NOT NULL,
        text_hash TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        has_word_timing_source INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE translations (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        lyrics_version_id TEXT NOT NULL REFERENCES lyrics_versions(id),
        origin TEXT NOT NULL CHECK (origin IN ('user','ai')),
        lines_json TEXT NOT NULL,
        source_text_hash TEXT NOT NULL,
        provider_id TEXT,
        model TEXT,
        prompt_version TEXT,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE pronunciations (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        lyrics_version_id TEXT NOT NULL REFERENCES lyrics_versions(id),
        origin TEXT NOT NULL CHECK (origin IN ('user','ai')),
        lines_json TEXT NOT NULL,
        source_text_hash TEXT NOT NULL,
        provider_id TEXT,
        model TEXT,
        prompt_version TEXT,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE sync_offsets (song_id TEXT PRIMARY KEY REFERENCES songs(id), offset_ms INTEGER NOT NULL)`,
      // v1에서는 표시 설정을 JSON 한 덩어리('display')로 저장했다.
      `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    ],
  },
  {
    version: 2,
    description: '작업 상태·사용량 테이블 추가, 표시 설정을 키 단위로 분리, 조회 인덱스',
    statements: [
      `CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        lyrics_version_id TEXT NOT NULL REFERENCES lyrics_versions(id),
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        failure_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE usage_daily (day TEXT PRIMARY KEY, requests INTEGER NOT NULL, source_chars INTEGER NOT NULL)`,
      `CREATE INDEX idx_lyrics_song ON lyrics_versions(song_id)`,
      `CREATE INDEX idx_translations_lv ON translations(lyrics_version_id)`,
      `CREATE INDEX idx_pronunciations_lv ON pronunciations(lyrics_version_id)`,
      `CREATE INDEX idx_jobs_status ON jobs(status)`,
      `INSERT OR REPLACE INTO settings(key, value)
        SELECT 'display.show_translation',
               CASE WHEN json_extract(value, '$.showTranslation') = 0 THEN 'false' ELSE 'true' END
        FROM settings WHERE key = 'display'`,
      `INSERT OR REPLACE INTO settings(key, value)
        SELECT 'display.show_pronunciation',
               CASE WHEN json_extract(value, '$.showPronunciation') = 0 THEN 'false' ELSE 'true' END
        FROM settings WHERE key = 'display'`,
      `DELETE FROM settings WHERE key = 'display'`,
    ],
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

export class MigrationError extends Error {
  constructor(
    readonly version: number,
    cause: unknown,
  ) {
    super(`마이그레이션 v${version} 실패: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'MigrationError';
  }
}

export async function getSchemaVersion(db: SqlDriver): Promise<number> {
  const row = await db.get<{ user_version: number }>('PRAGMA user_version');
  return row?.user_version ?? 0;
}

/** targetVersion까지 순서대로 적용한다. 앱보다 새 스키마(다운그레이드)는 거부한다. */
export async function migrate(
  db: SqlDriver,
  migrations: readonly Migration[] = MIGRATIONS,
  targetVersion?: number,
): Promise<{ from: number; to: number }> {
  const target = targetVersion ?? migrations[migrations.length - 1]?.version ?? 0;
  const from = await getSchemaVersion(db);
  if (from > target) {
    throw new MigrationError(from, new Error(`DB 스키마(v${from})가 앱이 아는 버전(v${target})보다 새롭습니다`));
  }
  await db.exec('PRAGMA foreign_keys = ON');
  for (const m of migrations) {
    if (m.version <= from || m.version > target) continue;
    try {
      await inTransaction(db, async () => {
        for (const sql of m.statements) await db.exec(sql);
        await db.exec(`PRAGMA user_version = ${m.version}`);
      });
    } catch (e) {
      throw new MigrationError(m.version, e);
    }
  }
  return { from, to: await getSchemaVersion(db) };
}
