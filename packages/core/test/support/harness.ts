/**
 * 테스트 하네스: 실제 core 객체를 가짜 제공자·가짜 시계·실제 SQLite(node:sqlite) 파일로 조립한다.
 * DB 파일은 저장소 안 .tmp/test-runs/ 에 만든다(공백·한글 경로에서도 동작하는지 함께 검증).
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HttpRequest, IdGenerator, ServiceTrackRef } from '../../src/ports.js';
import { LrclibClient } from '../../src/lyrics/lrclib-client.js';
import { LrclibLyricsProvider } from '../../src/lyrics/lyrics-provider.js';
import { ApiKeyManager } from '../../src/security/api-keys.js';
import { Logger } from '../../src/security/logger.js';
import { SecretRegistry } from '../../src/security/redact.js';
import { LyricsStore } from '../../src/storage/lyrics-store.js';
import { TranslationService, type TranslationPolicy } from '../../src/translation/translation-service.js';
import { NowPlayingSession } from '../../src/session/now-playing-session.js';
import {
  FakeClock,
  FakeHttp,
  FakeTranslationProvider,
  jsonResponse,
  MemorySecretStore,
  MemorySink,
  SeqIds,
  StaticRegistry,
} from './fakes.js';
import { NodeSqliteDriver } from './node-sqlite-driver.js';

export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const FIXTURES_DIR = join(REPO_ROOT, 'fixtures');

export function fixture(rel: string): string {
  return readFileSync(join(FIXTURES_DIR, ...rel.split('/')), 'utf8');
}

export function fixtureJson<T = unknown>(rel: string): T {
  return JSON.parse(fixture(rel)) as T;
}

let counter = 0;
export function tempDbPath(name: string): string {
  const dir = join(REPO_ROOT, '.tmp', 'test-runs');
  mkdirSync(dir, { recursive: true });
  counter += 1;
  const p = join(dir, `${name}-${process.pid}-${counter}.sqlite`);
  rmSync(p, { force: true });
  return p;
}

/** LRCLIB 가짜 라우팅: track_name → 픽스처 파일 */
export const LRCLIB_FIXTURES: Record<string, string> = {
  夜明けのホーム: 'lrclib/get-ja-synced.json',
  'Paper Lanterns': 'lrclib/get-en-synced.json',
  'Paper Lanterns (Live at Hall)': 'lrclib/get-en-live.json',
  雨上がりのメモ: 'lrclib/get-ja-plain-only.json',
  'Interlude No.3': 'lrclib/get-instrumental.json',
  'Broken Clock': 'lrclib/get-malformed-with-plain.json',
  'Broken Clock Only': 'lrclib/get-malformed-only.json',
  'Word Steps': 'lrclib/get-word-sync.json',
  'Odd Lines': 'lrclib/get-injection.json',
};

export function installLrclibRoutes(http: FakeHttp): void {
  http.on(
    (r: HttpRequest) => r.url.startsWith('https://lrclib.net/api/get?'),
    (r) => {
      const url = new URL(r.url);
      const file = LRCLIB_FIXTURES[url.searchParams.get('track_name') ?? ''];
      if (!file) return jsonResponse(404, fixtureJson('lrclib/error-404.json'));
      return jsonResponse(200, fixtureJson(file));
    },
  );
}

export const TRACKS = {
  jaStudio: {
    service: 'apple-music',
    serviceTrackId: 'am.1001',
    title: '夜明けのホーム',
    artist: 'Synthetic Band',
    album: 'Test Album',
    durationMs: 210_000,
    isrc: 'JPZZ02600001',
  },
  enStudio: {
    service: 'spotify',
    serviceTrackId: 'sp:track:paper',
    title: 'Paper Lanterns',
    artist: 'Imaginary Duo',
    album: 'Lantern EP',
    durationMs: 200_000,
    isrc: 'USZZ02600002',
  },
  enLive: {
    service: 'spotify',
    serviceTrackId: 'sp:track:paper-live',
    title: 'Paper Lanterns (Live at Hall)',
    artist: 'Imaginary Duo',
    album: 'Live at Hall',
    durationMs: 245_000,
    isrc: 'USZZ02600003',
  },
  enRemix: {
    service: 'youtube-music',
    serviceTrackId: null,
    title: 'Paper Lanterns (Night Remix)',
    artist: 'Imaginary Duo',
    album: 'Remixes',
    durationMs: 230_000,
    isrc: null,
  },
  jaPlain: {
    service: 'youtube-music',
    serviceTrackId: null,
    title: '雨上がりのメモ',
    artist: 'Synthetic Band',
    album: 'Test Album',
    durationMs: 180_000,
    isrc: null,
  },
  instrumental: {
    service: 'apple-music',
    serviceTrackId: 'am.1005',
    title: 'Interlude No.3',
    artist: 'Synthetic Band',
    album: 'Test Album',
    durationMs: 95_000,
    isrc: null,
  },
} satisfies Record<string, ServiceTrackRef>;

export interface Harness {
  dbPath: string;
  clock: FakeClock;
  ids: IdGenerator;
  http: FakeHttp;
  provider: FakeTranslationProvider;
  registry: StaticRegistry;
  driver: NodeSqliteDriver;
  store: LyricsStore;
  secrets: SecretRegistry;
  secretStore: MemorySecretStore;
  keys: ApiKeyManager;
  sink: MemorySink;
  logger: Logger;
  translation: TranslationService;
  session: NowPlayingSession;
  /** 앱 종료 후 재실행: 같은 DB 파일·보안 저장소로 모든 객체를 새로 만든다(메모리 상태 없음). */
  restart(): Promise<Harness>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  dbPath?: string;
  autoTranslate?: boolean;
  withProvider?: boolean;
  policy?: Partial<TranslationPolicy>;
  /** 재실행 시 이어받을 보안 저장소·시계 */
  secretStore?: MemorySecretStore;
  clock?: FakeClock;
  ids?: IdGenerator;
  /** 세션의 전체 싱크 보정 기본값(앱은 D-27 값을 넘긴다) */
  defaultGlobalOffsetMs?: number;
}

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const dbPath = opts.dbPath ?? tempDbPath('harness');
  const clock = opts.clock ?? new FakeClock();
  const ids = opts.ids ?? new SeqIds();
  const http = new FakeHttp();
  installLrclibRoutes(http);
  const provider = new FakeTranslationProvider();
  const registry = new StaticRegistry(opts.withProvider === false ? null : provider);
  const driver = new NodeSqliteDriver(dbPath);
  const store = await LyricsStore.open(driver);
  const secrets = new SecretRegistry();
  const secretStore = opts.secretStore ?? new MemorySecretStore();
  const keys = new ApiKeyManager(secretStore, secrets);
  const sink = new MemorySink();
  const logger = new Logger(sink, clock, secrets);
  if (opts.autoTranslate !== undefined) await store.setTranslationSettings({ autoTranslate: opts.autoTranslate });
  const translation = new TranslationService({
    store,
    providers: registry,
    clock,
    ids,
    logger,
    secrets,
    ...(opts.policy ? { policy: opts.policy } : {}),
  });
  const lrclib = new LrclibClient({ http, clock, clientId: 'LyricsCompanion-test/0.1.0 (test)', minIntervalMs: 0 });
  const session = new NowPlayingSession({
    store,
    lyrics: new LrclibLyricsProvider(lrclib),
    translation,
    clock,
    ids,
    logger,
    ...(opts.defaultGlobalOffsetMs !== undefined ? { defaultGlobalOffsetMs: opts.defaultGlobalOffsetMs } : {}),
  });
  await session.start();
  const h: Harness = {
    dbPath,
    clock,
    ids,
    http,
    provider,
    registry,
    driver,
    store,
    secrets,
    secretStore,
    keys,
    sink,
    logger,
    translation,
    session,
    async restart() {
      await session.idle();
      await store.close();
      return createHarness({
        dbPath,
        secretStore,
        clock,
        ids,
        ...(opts.policy ? { policy: opts.policy } : {}),
        ...(opts.defaultGlobalOffsetMs !== undefined ? { defaultGlobalOffsetMs: opts.defaultGlobalOffsetMs } : {}),
      });
    },
    async close() {
      await session.idle();
      await store.close();
    },
  };
  return h;
}
