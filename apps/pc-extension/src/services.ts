import type { SqlJsStatic } from 'sql.js';
import {
  AppleMusicLyricsProvider,
  ApiKeyManager,
  createOpenAiCompatibleProvider,
  getSchemaVersion,
  ItunesCatalogClient,
  LATEST_SCHEMA_VERSION,
  listProviderModels,
  LrclibClient,
  Logger,
  LyricsStore,
  NowPlayingSession,
  PlaylistLyricsBatch,
  SecretRegistry,
  TranslationService,
  type HttpClient,
  type LyricsProvider,
  type ProviderModelListResult,
  type SecretStore,
  type TranslationProvider,
  type TranslationProviderRegistry,
} from '@lyrics-companion/core';
import type { SecretHostStatus } from './adapters/native-secret-store';
import { SqlJsDriver, type FileStore } from './adapters/sqljs-driver';
import { RingLogSink, SystemClock, UuidIds } from './adapters/system';
import type { WebPlayback } from './adapters/web-playback';

/**
 * 전체 싱크 보정 기본값: 가사를 0.25초 먼저 넘긴다(D-26, iPhone 앱과 같은 값).
 * 원문 타임스탬프는 바꾸지 않는 표시용 보정이며 설정에서 바꿀 수 있다.
 */
export const DEFAULT_LYRICS_LEAD_MS = 250;

/** LRCLIB 문서가 요구하는 클라이언트 식별 문자열(앱 이름·버전·용도) */
export const LRCLIB_CLIENT_ID = 'LyricsCompanion/0.1.0 (personal-use Windows browser extension)';

/** AI 제공자 주소 접근 허용(확장 프로그램 선택 권한). 설정에서 사용자가 허용한 주소만 요청이 나간다. */
export interface HostPermissions {
  has(origin: string): Promise<boolean>;
  /** 사용자 동작(클릭) 안에서만 호출한다 */
  request(origin: string): Promise<boolean>;
}

export interface PlatformDeps {
  sqlJs: SqlJsStatic;
  files: FileStore;
  secrets: SecretStore;
  secretStatus: () => Promise<SecretHostStatus>;
  playback: WebPlayback;
  http: HttpClient;
  permissions: HostPermissions;
  /** 데모: 네트워크 없이 합성 가사를 주는 제공자 */
  lyricsOverride?: LyricsProvider;
  echoLogs?: boolean;
}

/**
 * 앱 조립 지점(composition root). core 객체에 포트 구현을 주입한다(iPhone 앱 services.ts와 같은 구성).
 * 판단 로직은 모두 core에 있고, 여기서는 연결만 한다.
 */
export interface AppServices {
  clock: SystemClock;
  ids: UuidIds;
  logger: Logger;
  store: LyricsStore;
  keys: ApiKeyManager;
  translation: TranslationService;
  session: NowPlayingSession;
  lrclib: LrclibClient;
  playback: WebPlayback;
  /** 대기열 가사 원문 일괄 받기(D-31과 같은 core 실행기). 패널 안에서 하나만 둔다. */
  playlistBatch: PlaylistLyricsBatch;
  logs: RingLogSink;
  permissions: HostPermissions;
  secretStatus: () => Promise<SecretHostStatus>;
  /** 마이그레이션 전에 만든 사본이 있으면 그 스키마 버전 */
  migratedFrom: number | null;
  /**
   * 이 키로 쓸 수 있는 AI 모델 ID 목록(D-39, iPhone과 같은 core 함수). GET {baseUrl}/models —
   * 번역 요청이 아니므로 가사를 보내지 않고 과금도 없다. 호출 전에 그 주소 접근 허용이 필요하다.
   */
  listProviderModels(providerId: string, baseUrl: string): Promise<ProviderModelListResult>;
}

/** 제공자 주소 → 권한 이름(origin) */
export function originOf(baseUrl: string): string | null {
  const m = /^https:\/\/([^/?#@]+)/.exec(baseUrl);
  return m ? `https://${m[1]}` : null;
}

class ConfiguredProviderRegistry implements TranslationProviderRegistry {
  constructor(
    private readonly deps: {
      store: LyricsStore;
      keys: ApiKeyManager;
      http: HttpClient;
      logger: Logger;
      secrets: SecretRegistry;
      permissions: HostPermissions;
    },
  ) {}

  async active(): Promise<TranslationProvider | null> {
    const cfg = await this.deps.store.getProviderConfig();
    if (!cfg) return null;
    const origin = originOf(cfg.baseUrl);
    // 사용자가 그 주소 접근을 허용하지 않았으면 제공자 없음(요청이 나가지 않음)
    if (!origin || !(await this.deps.permissions.has(origin))) return null;
    if (!(await this.deps.keys.has(cfg.providerId))) return null;
    return createOpenAiCompatibleProvider({
      providerId: cfg.providerId,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      structuredOutput: cfg.structuredOutput,
      reasoningEffort: cfg.reasoningEffort,
      http: this.deps.http,
      keys: this.deps.keys,
      logger: this.deps.logger,
      secrets: this.deps.secrets,
    });
  }
}

/** 마이그레이션 전 사본: 'main.bak-v<n>' 하나만 남긴다(docs/security.md §6). */
async function backupBeforeMigration(driver: SqlJsDriver, files: FileStore): Promise<number | null> {
  const v = await getSchemaVersion(driver);
  if (v === 0 || v >= LATEST_SCHEMA_VERSION) return null;
  const key = `main.bak-v${v}`;
  await files.put(key, driver.snapshot());
  for (const k of await files.keys()) if (k.startsWith('main.bak-') && k !== key) await files.delete(k);
  return v;
}

export async function createAppServices(deps: PlatformDeps): Promise<AppServices> {
  const clock = new SystemClock();
  const ids = new UuidIds();
  const logs = new RingLogSink(deps.echoLogs ?? false);
  const secrets = new SecretRegistry();
  const logger = new Logger(logs, clock, secrets);
  const driver = await SqlJsDriver.open(deps.sqlJs, deps.files);
  const migratedFrom = await backupBeforeMigration(driver, deps.files);
  const store = await LyricsStore.open(driver);
  const keys = new ApiKeyManager(deps.secrets, secrets);
  const translation = new TranslationService({
    store,
    providers: new ConfiguredProviderRegistry({
      store,
      keys,
      http: deps.http,
      logger,
      secrets,
      permissions: deps.permissions,
    }),
    clock,
    ids,
    logger,
    secrets,
  });
  const lrclib = new LrclibClient({ http: deps.http, clock, clientId: LRCLIB_CLIENT_ID });
  const catalog = new ItunesCatalogClient({ http: deps.http, clock });
  // 한국 Apple Music의 현지화 표기(예: 요네즈 켄시)로 못 찾으면 스토어 ID로 원어 표기를 얻어 다시 찾는다(D-18).
  const lyrics = deps.lyricsOverride ?? new AppleMusicLyricsProvider({ lrclib, catalog });
  const session = new NowPlayingSession({
    store,
    lyrics,
    translation,
    clock,
    ids,
    logger,
    defaultGlobalOffsetMs: DEFAULT_LYRICS_LEAD_MS,
  });
  await session.start();
  // 같은 LRCLIB 클라이언트를 써서 요청 간격·Retry-After를 지금 재생 조회와 함께 지킨다. AI는 쓰지 않는다.
  const playlistBatch = new PlaylistLyricsBatch({ store, lyrics, clock, ids, logger });
  return {
    clock,
    ids,
    logger,
    store,
    keys,
    translation,
    session,
    lrclib,
    playback: deps.playback,
    playlistBatch,
    logs,
    permissions: deps.permissions,
    secretStatus: deps.secretStatus,
    migratedFrom,
    listProviderModels: (providerId, baseUrl) =>
      listProviderModels({ providerId, baseUrl, http: deps.http, keys, secrets, logger }),
  };
}
