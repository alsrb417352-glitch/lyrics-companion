/**
 * SQLite 드라이버 포트. 앱에서는 expo-sqlite, 테스트에서는 node:sqlite 어댑터가 구현한다.
 * 같은 SQL·마이그레이션을 두 환경에서 그대로 실행해 저장 로직을 실제로 검증한다.
 */
export type SqlValue = string | number | null;

export interface SqlDriver {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: readonly SqlValue[]): Promise<{ changes: number }>;
  get<T = Record<string, SqlValue>>(sql: string, params?: readonly SqlValue[]): Promise<T | undefined>;
  all<T = Record<string, SqlValue>>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  close(): Promise<void>;
}

/** 직렬화 큐: 같은 연결에서 트랜잭션이 다른 작업과 섞이지 않게 한다. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn, fn);
    this.tail = p.catch(() => undefined);
    return p;
  }
}

/** BEGIN IMMEDIATE ~ COMMIT, 실패 시 ROLLBACK. 호출자는 SerialQueue 안에서 사용해야 한다. */
export async function inTransaction<T>(db: SqlDriver, fn: () => Promise<T>): Promise<T> {
  await db.exec('BEGIN IMMEDIATE');
  try {
    const result = await fn();
    await db.exec('COMMIT');
    return result;
  } catch (e) {
    try {
      await db.exec('ROLLBACK');
    } catch {
      // 롤백 실패는 원래 오류를 가리지 않는다.
    }
    throw e;
  }
}
