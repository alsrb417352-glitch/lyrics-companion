import {
  AppleMusicLyricsProvider,
  ApiKeyManager,
  AutoSyncRunner,
  createOpenAiCompatibleProvider,
  ItunesCatalogClient,
  LrclibClient,
  Logger,
  listProviderModels,
  LyricsStore,
  NowPlayingSession,
  PlaylistLyricsBatch,
  SecretRegistry,
  TranslationService,
  type ProviderModelListResult,
  type TranslationProvider,
  type TranslationProviderRegistry,
} from '@lyrics-companion/core';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { FetchHttpClient } from './adapters/http';
import { AndroidMediaPlayback } from './adapters/android-playback-source';
import { IosMusicPlaybackSource } from './adapters/ios-playback-source';
import { IosSongListener } from './adapters/ios-song-listener';
import { ExpoSecretStore } from './adapters/secure-store';
import { ExpoSqliteDriver } from './adapters/sqlite-driver';
import { RingLogSink, SystemClock, UuidIds } from './adapters/system';

/**
 * 전체 싱크 보정 기본값: 가사를 0.25초 먼저 넘긴다(D-26). LRC 시각은 노래가 시작되는 순간이라, 그때 바뀌면
 * 읽기 시작이 늦게 느껴진다. 원문 타임스탬프는 바꾸지 않는 표시용 보정이며 설정에서 바꿀 수 있다.
 */
export const DEFAULT_LYRICS_LEAD_MS = 250;

/** LRCLIB 문서가 요구하는 클라이언트 식별 문자열(앱 이름·버전·용도) */
export const LRCLIB_CLIENT_ID = 'LyricsCompanion/0.1.0 (personal-use mobile app)';

/**
 * 재생 앱 연동. iPhone은 Music 앱(Apple Music), Android는 Spotify·YouTube Music·Apple Music 앱(MediaSession, D-41).
 * 둘 다 PlaybackSource + 재생 제어 + 권한 요청을 제공하고, 플랫폼 전용 기능은 platform으로 구분한다.
 */
export type AppPlayback = IosMusicPlaybackSource | AndroidMediaPlayback;

/**
 * 앱 조립 지점(composition root). core 객체에 포트 구현을 주입한다.
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
  catalog: ItunesCatalogClient;
  playback: AppPlayback | null;
  /** Android 재생 앱 연동(재생 목록·검색 재생·앱 정보 화면). iPhone이면 null */
  android: AndroidMediaPlayback | null;
  /** 플레이리스트 가사 원문 일괄 받기(D-31). 화면을 옮겨도 계속되도록 앱 전체에서 하나만 둔다. */
  playlistBatch: PlaylistLyricsBatch;
  /**
   * 소리로 싱크 맞추기(D-44): iPhone 마이크 + 기기 안 음성 인식. 지금 곡·플레이리스트 일괄 모두 이 하나로(동시에 하나만).
   * iPhone이 아니거나 듣기 모듈이 없으면 null(Android·PC는 아직 지원하지 않음).
   */
  autoSync: AutoSyncRunner | null;
  /** 시작 전 준비 상태 확인용(권한을 묻지 않음) */
  songListener: IosSongListener | null;
  logs: RingLogSink;
  /**
   * 이 키로 쓸 수 있는 AI 모델 ID 목록(D-39). 설정 화면의 "모델 목록 불러오기"용.
   * GET {baseUrl}/models — 번역 요청이 아니므로 가사를 보내지 않고 과금도 없다. 키는 보안 저장소에서 읽어 헤더에만 넣는다.
   */
  listProviderModels(providerId: string, baseUrl: string): Promise<ProviderModelListResult>;
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
      reasoningEffort: cfg.reasoningEffort,
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
  const lyrics = new AppleMusicLyricsProvider({ lrclib, catalog });
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
  const android = AndroidMediaPlayback.available() ? new AndroidMediaPlayback(clock) : null;
  const playback: AppPlayback | null = IosMusicPlaybackSource.available() ? new IosMusicPlaybackSource(clock) : android;
  // 같은 LRCLIB 클라이언트를 써서 요청 간격·Retry-After를 지금 재생 조회와 함께 지킨다. AI는 쓰지 않는다.
  const playlistBatch = new PlaylistLyricsBatch({ store, lyrics, clock, ids, logger });
  // 받는 동안 화면이 꺼지면 OS가 앱을 멈추거나 늦추므로 화면 꺼짐을 막는다(끝나면 해제).
  let awake = false;
  playlistBatch.subscribe((s) => {
    if (s.running === awake) return;
    awake = s.running;
    if (awake) void activateKeepAwakeAsync('playlist-batch').catch(() => undefined);
    else void deactivateKeepAwake('playlist-batch').catch(() => undefined);
  });
  // 소리로 싱크 맞추기: iPhone Music 앱 연동 + 듣기 모듈이 있을 때만. 듣는 동안 화면이 꺼지면 마이크가 멈추므로 화면 꺼짐을 막는다.
  const songListener = playback?.platform === 'ios' && IosSongListener.available() ? new IosSongListener() : null;
  const autoSync =
    songListener && playback
      ? new AutoSyncRunner({ store, session, playback, listener: songListener, clock, ids, logger })
      : null;
  let listening = false;
  autoSync?.subscribe((s) => {
    if (s.running === listening) return;
    listening = s.running;
    if (listening) void activateKeepAwakeAsync('auto-sync').catch(() => undefined);
    else void deactivateKeepAwake('auto-sync').catch(() => undefined);
  });
  return {
    clock,
    ids,
    logger,
    store,
    keys,
    translation,
    session,
    lrclib,
    catalog,
    playback,
    android,
    playlistBatch,
    autoSync,
    songListener,
    logs,
    listProviderModels: (providerId, baseUrl) =>
      listProviderModels({ providerId, baseUrl, http, keys, secrets, logger }),
  };
}
