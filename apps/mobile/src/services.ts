import {
  AppleMusicLyricsProvider,
  ApiKeyManager,
  createOpenAiCompatibleProvider,
  ItunesCatalogClient,
  LrclibClient,
  Logger,
  LyricsStore,
  NowPlayingSession,
  SecretRegistry,
  TranslationService,
  type TranslationProvider,
  type TranslationProviderRegistry,
} from '@lyrics-companion/core';
import { FetchHttpClient } from './adapters/http';
import { IosMusicPlaybackSource } from './adapters/ios-playback-source';
import { ExpoSecretStore } from './adapters/secure-store';
import { ExpoSqliteDriver } from './adapters/sqlite-driver';
import { RingLogSink, SystemClock, UuidIds } from './adapters/system';

/** LRCLIB 문서가 요구하는 클라이언트 식별 문자열(앱 이름·버전·용도) */
export const LRCLIB_CLIENT_ID = 'LyricsCompanion/0.1.0 (personal-use iOS app)';

/**
 * 앱 조립 지점(composition root). core 객체에 포트 구현을 주입한다.
 * 판단 로직은 모두 core에 있고, 여기서는 연결만 한다.
 */
export interface AppServices {
  clock: SystemClock;
  store: LyricsStore;
  keys: ApiKeyManager;
  translation: TranslationService;
  session: NowPlayingSession;
  lrclib: LrclibClient;
  catalog: ItunesCatalogClient;
  playback: IosMusicPlaybackSource | null;
  logs: RingLogSink;
}

class ConfiguredProviderRegistry implements TranslationProviderRegistry {
  constructor(
    private readonly deps: {
      store: LyricsStore;
      keys: ApiKeyManager;
      http: FetchHttpClient;
      logger: Logger;
      secrets: SecretRegistry;
    },
  ) {}

  async active(): Promise<TranslationProvider | null> {
    const cfg = await this.deps.store.getProviderConfig();
    if (!cfg) return null;
    if (!(await this.deps.keys.has(cfg.providerId))) return null;
    return createOpenAiCompatibleProvider({
      providerId: cfg.providerId,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      structuredOutput: cfg.structuredOutput,
      http: this.deps.http,
      keys: this.deps.keys,
      logger: this.deps.logger,
      secrets: this.deps.secrets,
    });
  }
}

export async function createAppServices(): Promise<AppServices> {
  const clock = new SystemClock();
  const ids = new UuidIds();
  const http = new FetchHttpClient();
  const logs = new RingLogSink();
  const secrets = new SecretRegistry();
  const logger = new Logger(logs, clock, secrets);
  const driver = await ExpoSqliteDriver.open();
  const store = await LyricsStore.open(driver);
  const keys = new ApiKeyManager(new ExpoSecretStore(), secrets);
  const translation = new TranslationService({
    store,
    providers: new ConfiguredProviderRegistry({ store, keys, http, logger, secrets }),
    clock,
    ids,
    logger,
    secrets,
  });
  const lrclib = new LrclibClient({ http, clock, clientId: LRCLIB_CLIENT_ID });
  const catalog = new ItunesCatalogClient({ http, clock });
  // 한국 Apple Music의 현지화 표기(예: 요네즈 켄시)로 못 찾으면 스토어 ID로 원어 표기를 얻어 다시 찾는다.
  const session = new NowPlayingSession({
    store,
    lyrics: new AppleMusicLyricsProvider({ lrclib, catalog }),
    translation,
    clock,
    ids,
    logger,
  });
  await session.start();
  const playback = IosMusicPlaybackSource.available() ? new IosMusicPlaybackSource(clock) : null;
  return { clock, store, keys, translation, session, lrclib, catalog, playback, logs };
}
