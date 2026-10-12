import type { Database, SqlJsStatic } from 'sql.js';
import type { SqlDriver, SqlValue } from '@lyrics-companion/core';

/**
 * DB 파일 바이트를 통째로 보관하는 저장소. 확장 프로그램에서는 IndexedDB(IdbFileStore),
 * 데모·테스트에서는 메모리(MemoryFileStore).
 */
export interface FileStore {
  get(key: string): Promise<Uint8Array | null>;
  /** 한 번의 쓰기로 원자적으로 바꾼다(중간 상태가 남지 않음). */
  put(key: string, bytes: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/**
 * core SqlDriver 포트의 sql.js(WebAssembly SQLite) 구현.
 * - 같은 SQL·마이그레이션을 그대로 실행한다(iOS expo-sqlite, 테스트 node:sqlite와 같은 SQLite).
 * - sql.js는 메모리 DB이므로, **쓰기가 끝날 때마다**(트랜잭션 밖의 쓰기, 또는 COMMIT) DB 전체를 FileStore에 저장한 뒤에
 *   호출자에게 돌아간다. 그래서 "작업을 in_flight로 기록 → AI 요청" 순서가 디스크에서도 지켜진다(불변조건 7, INV-8).
 * - 트랜잭션 중간 상태는 저장하지 않는다(COMMIT 뒤에만 저장, ROLLBACK이면 마지막 저장본이 그대로).
 * - 트랜잭션 직렬화는 core(LyricsStore의 SerialQueue)가 담당한다.
 */
export class SqlJsDriver implements SqlDriver {
  private inTx = false;
  private dirty = false;

  private constructor(
    private readonly db: Database,
    private readonly files: FileStore,
    private readonly key: string,
  ) {}

  static async open(sql: SqlJsStatic, files: FileStore, key = 'main'): Promise<SqlJsDriver> {
    const bytes = await files.get(key);
    const db = bytes ? new sql.Database(bytes) : new sql.Database();
    db.exec('PRAGMA foreign_keys = ON');
    return new SqlJsDriver(db, files, key);
  }

  /** 지금 DB 바이트(마이그레이션 전 사본용) */
  snapshot(): Uint8Array {
    const bytes = this.db.export();
    // export()는 DB를 닫았다 다시 열어 PRAGMA가 기본값으로 돌아간다.
    this.db.exec('PRAGMA foreign_keys = ON');
    return bytes;
  }

  private async flush(): Promise<void> {
    if (!this.dirty) return;
    await this.files.put(this.key, this.snapshot());
    this.dirty = false;
  }

  private async afterWrite(): Promise<void> {
    this.dirty = true;
    if (!this.inTx) await this.flush();
  }

  async exec(sql: string): Promise<void> {
    const head = sql.trim().slice(0, 16).toUpperCase();
    this.db.exec(sql);
    if (head.startsWith('BEGIN')) {
      this.inTx = true;
      return;
    }
    if (head.startsWith('COMMIT') || head.startsWith('END')) {
      this.inTx = false;
      await this.flush();
      return;
    }
    if (head.startsWith('ROLLBACK')) {
      // 트랜잭션 밖 쓰기는 이미 저장됐으므로, 남은 변경은 방금 되돌린 트랜잭션 것뿐이다.
      this.inTx = false;
      this.dirty = false;
      return;
    }
    // 값을 읽기만 하는 PRAGMA(예: PRAGMA user_version)는 저장할 필요가 없다.
    if (head.startsWith('PRAGMA') && !sql.includes('=')) return;
    await this.afterWrite();
  }

  async run(sql: string, params: readonly SqlValue[] = []): Promise<{ changes: number }> {
    const stmt = this.db.prepare(sql);
    try {
      stmt.run([...params]);
    } finally {
      stmt.free();
    }
    const changes = this.db.getRowsModified();
    await this.afterWrite();
    return { changes };
  }

  async get<T = Record<string, SqlValue>>(sql: string, params: readonly SqlValue[] = []): Promise<T | undefined> {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind([...params]);
      return stmt.step() ? (stmt.getAsObject() as T) : undefined;
    } finally {
      stmt.free();
    }
  }

  async all<T = Record<string, SqlValue>>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind([...params]);
      const rows: T[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as T);
      return rows;
    } finally {
      stmt.free();
    }
  }

  async close(): Promise<void> {
    await this.flush();
    this.db.close();
  }
}

/** IndexedDB에 DB 파일을 키-값으로 보관한다. 확장 프로그램 출처 전용 저장소(다른 사이트는 읽을 수 없음). */
export class IdbFileStore implements FileStore {
  private constructor(private readonly idb: IDBDatabase) {}

  static open(name = 'lyrics-companion'): Promise<IdbFileStore> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('files')) req.result.createObjectStore('files');
      };
      req.onsuccess = () => resolve(new IdbFileStore(req.result));
      req.onerror = () => reject(req.error ?? new Error('저장소를 열지 못했습니다'));
    });
  }

  private tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const t = this.idb.transaction('files', mode, { durability: 'strict' });
      const req = fn(t.objectStore('files'));
      let value: T;
      req.onsuccess = () => {
        value = req.result;
      };
      // 트랜잭션이 디스크에 반영된 뒤(complete)에 끝난 것으로 본다.
      t.oncomplete = () => resolve(value);
      t.onerror = () => reject(t.error ?? new Error('저장에 실패했습니다'));
      t.onabort = () => reject(t.error ?? new Error('저장이 취소되었습니다'));
    });
  }

  async get(key: string): Promise<Uint8Array | null> {
    const v = await this.tx('readonly', (s) => s.get(key) as IDBRequest<unknown>);
    return v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : null;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    await this.tx('readwrite', (s) => s.put(bytes, key));
  }

  async delete(key: string): Promise<void> {
    await this.tx('readwrite', (s) => s.delete(key));
  }

  async keys(): Promise<string[]> {
    const ks = await this.tx('readonly', (s) => s.getAllKeys());
    return ks.filter((k): k is string => typeof k === 'string');
  }
}

export class MemoryFileStore implements FileStore {
  private readonly m = new Map<string, Uint8Array>();
  async get(key: string) {
    return this.m.get(key) ?? null;
  }
  async put(key: string, bytes: Uint8Array) {
    this.m.set(key, bytes.slice());
  }
  async delete(key: string) {
    this.m.delete(key);
  }
  async keys() {
    return [...this.m.keys()];
  }
}
