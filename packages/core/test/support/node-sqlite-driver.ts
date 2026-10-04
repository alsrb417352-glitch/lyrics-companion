/**
 * node:sqlite 기반 SqlDriver (테스트 전용). 앱의 expo-sqlite 어댑터와 같은 SQL을 실행한다.
 * Node 22.13+ 에서는 플래그 없이 사용 가능(실험 기능 경고가 출력될 수 있음).
 */
import { DatabaseSync } from 'node:sqlite';
import type { SqlDriver, SqlValue } from '../../src/storage/sql-driver.js';

export class NodeSqliteDriver implements SqlDriver {
  private readonly db: DatabaseSync;
  /** 테스트에서 저장 실패를 주입하기 위한 훅: true를 반환하면 해당 SQL 실행 시 예외 */
  failWhen: ((sql: string) => boolean) | null = null;
  /** 테스트에서 특정 SQL 실행 전에 대기를 넣어 비동기 경쟁 상황을 재현하기 위한 훅 */
  beforeQuery: ((sql: string) => Promise<void> | undefined) | null = null;

  constructor(readonly path: string) {
    this.db = new DatabaseSync(path);
  }

  private check(sql: string): void {
    if (this.failWhen?.(sql)) throw new Error('injected storage failure (disk full)');
  }

  async exec(sql: string): Promise<void> {
    await this.beforeQuery?.(sql);
    this.check(sql);
    this.db.exec(sql);
  }

  async run(sql: string, params: readonly SqlValue[] = []): Promise<{ changes: number }> {
    await this.beforeQuery?.(sql);
    this.check(sql);
    const r = this.db.prepare(sql).run(...params);
    return { changes: Number(r.changes) };
  }

  async get<T>(sql: string, params: readonly SqlValue[] = []): Promise<T | undefined> {
    await this.beforeQuery?.(sql);
    this.check(sql);
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  async all<T>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    await this.beforeQuery?.(sql);
    this.check(sql);
    return this.db.prepare(sql).all(...params) as T[];
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
