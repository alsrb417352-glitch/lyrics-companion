import * as SQLite from 'expo-sqlite';
import type { SqlDriver, SqlValue } from '@lyrics-companion/core';

/**
 * core SqlDriver 포트의 expo-sqlite 구현.
 * DB 파일은 앱 문서 영역(iOS: Documents/SQLite)에 생긴다 → 캐시 정리로 지워지지 않는다(REQ-ST-03).
 * 트랜잭션 직렬화는 core(LyricsStore의 SerialQueue)가 담당한다.
 */
export class ExpoSqliteDriver implements SqlDriver {
  private constructor(private readonly db: SQLite.SQLiteDatabase) {}

  static async open(name = 'lyrics-companion.db'): Promise<ExpoSqliteDriver> {
    const db = await SQLite.openDatabaseAsync(name);
    await db.execAsync('PRAGMA foreign_keys = ON;');
    return new ExpoSqliteDriver(db);
  }

  async exec(sql: string): Promise<void> {
    await this.db.execAsync(sql);
  }

  async run(sql: string, params: readonly SqlValue[] = []): Promise<{ changes: number }> {
    const r = await this.db.runAsync(sql, [...params]);
    return { changes: r.changes };
  }

  async get<T = Record<string, SqlValue>>(sql: string, params: readonly SqlValue[] = []): Promise<T | undefined> {
    const r = await this.db.getFirstAsync<T>(sql, [...params]);
    return r ?? undefined;
  }

  async all<T = Record<string, SqlValue>>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    return this.db.getAllAsync<T>(sql, [...params]);
  }

  async close(): Promise<void> {
    await this.db.closeAsync();
  }
}
