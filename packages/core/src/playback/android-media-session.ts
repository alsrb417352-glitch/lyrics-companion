import type { PlaybackAccess, PlaybackSnapshot, PlaybackStatus, ServiceTrackRef, StreamingService } from '../ports.js';
import { hasVersionMarker, normalizeArtist } from '../matching/track-identity.js';

/**
 * Android 미디어 세션(MediaSession) 원시 값 → core 재생 스냅샷 변환(순수 함수, docs/plan.md D-41).
 * 네이티브 모듈(apps/mobile/modules/now-playing/android, Kotlin)은 값을 가공하지 않고 그대로 넘기고,
 * 해석 규칙(어느 앱인지·곡 ID·재생 위치·어느 세션을 따를지)은 여기 한 곳에서 테스트로 고정한다(iOS ios-system-player.ts와 같은 방식).
 *
 * 값의 근거(docs/platform-support.md §2.1, Android 문서):
 * - `MediaSessionManager.getActiveSessions(알림 리스너)` → `MediaController` 목록(중요한 순서).
 * - `MediaMetadata`: TITLE·ARTIST·ALBUM·DURATION(ms, 모르면 0)·MEDIA_ID(형식은 앱마다 다름).
 * - `PlaybackState`: state(정수), position(ms, 모르면 -1), lastPositionUpdateTime(elapsedRealtime ms), playbackSpeed, actions(비트).
 *   위치는 "lastPositionUpdateTime 시각에 position이었고 그 뒤 speed로 움직인다"는 뜻이다(앱이 매 순간 갱신하지 않음).
 * 앱별 MEDIA_ID 형식·대기열 제공 여부는 실기기에서 확인하지 않았다(MV-PB-AND-01).
 */

export interface AndroidPlayerApp {
  packageName: string;
  service: StreamingService;
  label: string;
}

/**
 * 따라가는 재생 앱(이 목록 밖 앱의 미디어 정보는 네이티브 모듈이 읽지도 넘기지도 않는다 — 개인정보, docs/security.md §3).
 * Kotlin 쪽 목록(MediaSessionsModule.SUPPORTED)과 같아야 한다.
 */
export const ANDROID_PLAYER_APPS: readonly AndroidPlayerApp[] = [
  { packageName: 'com.spotify.music', service: 'spotify', label: 'Spotify' },
  { packageName: 'com.google.android.apps.youtube.music', service: 'youtube-music', label: 'YouTube Music' },
  { packageName: 'com.apple.android.music', service: 'apple-music', label: 'Apple Music' },
];

export function androidPlayerOf(packageName: unknown): AndroidPlayerApp | null {
  return ANDROID_PLAYER_APPS.find((a) => a.packageName === packageName) ?? null;
}

/** 서비스 표시 이름(화면용) */
export function streamingServiceLabel(service: StreamingService): string {
  return ANDROID_PLAYER_APPS.find((a) => a.service === service)?.label ?? '재생 앱';
}

/** 네이티브 모듈이 넘기는 세션 하나의 원시 값. 모든 필드는 신뢰하지 않고 검증한다. */
export interface AndroidSessionRaw {
  packageName?: unknown;
  hasMetadata?: unknown;
  title?: unknown;
  artist?: unknown;
  albumArtist?: unknown;
  album?: unknown;
  durationMs?: unknown;
  mediaId?: unknown;
  /** PlaybackState.getState() */
  state?: unknown;
  /** PlaybackState.getPosition() — 모르면 -1 */
  positionMs?: unknown;
  /** PlaybackState.getLastPositionUpdateTime() — elapsedRealtime 기준 ms */
  lastPositionUpdateTime?: unknown;
  /** PlaybackState.getPlaybackSpeed() */
  speed?: unknown;
  /** PlaybackState.getActions() */
  actions?: unknown;
  /** 값을 읽은 순간의 SystemClock.elapsedRealtime() — 위치 계산 기준 */
  readAtElapsedMs?: unknown;
  /** MediaController.getQueueTitle() */
  queueTitle?: unknown;
}

export type AndroidAccessRaw = 'granted' | 'not-granted' | 'unsupported';

/** 알림 접근이 꺼져 있으면 사용자가 켜기 전까지 "아직 허용 안 함"으로 본다(거부·미설정을 구분할 수 없음). */
export function mapAndroidAccess(v: unknown): PlaybackAccess {
  if (v === 'granted') return 'granted';
  if (v === 'not-granted') return 'not-determined';
  return 'unsupported';
}

// ---------------------------------------------------------------- 상태·위치

/** PlaybackState.STATE_* */
export function mapAndroidState(v: unknown): PlaybackStatus {
  switch (v) {
    case 3: // PLAYING
      return 'playing';
    case 2: // PAUSED
      return 'paused';
    case 0: // NONE
    case 1: // STOPPED
    case 7: // ERROR
      return 'stopped';
    case 4: // FAST_FORWARDING
    case 5: // REWINDING
    case 6: // BUFFERING
    case 8: // CONNECTING
    case 9: // SKIPPING_TO_PREVIOUS
    case 10: // SKIPPING_TO_NEXT
    case 11: // SKIPPING_TO_QUEUE_ITEM
      // 위치가 일정한 속도로 움직이지 않으므로 진행을 추정하지 않는다.
      return 'buffering';
    default:
      return 'unknown';
  }
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function rateOf(v: unknown): number {
  const r = finite(v);
  return r !== null && r > 0 && r <= 4 ? r : 1;
}

/** 갱신 시각이 이보다 오래된 "재생 중" 상태는 믿지 않는다(앱이 멈췄는데 상태를 안 바꾼 경우 등) */
export const ANDROID_MAX_POSITION_AGE_MS = 6 * 60 * 60 * 1000;
/** 계산한 위치가 곡 길이를 이만큼 넘으면 오래된 상태로 본다 */
export const ANDROID_PAST_END_TOLERANCE_MS = 3_000;

/**
 * 값을 읽은 순간의 재생 위치(ms). 진행을 꾸며내지 않는다(불변조건 5):
 * - position이 -1(PLAYBACK_POSITION_UNKNOWN)이거나 숫자가 아니면 위치 모름.
 * - 재생 중이면 앱이 알려 준 "갱신 시각의 위치 + 경과 × 속도"(PlaybackState의 정의). 갱신 시각을 모르거나
 *   읽은 시각보다 미래면 경과를 0으로 본다(뒤처질 수는 있어도 앞서가지 않음, D-25와 같은 원칙).
 * - 경과가 지나치게 길거나 계산 결과가 곡 길이를 넘으면 오래된 상태라 위치 모름.
 */
export function androidPositionMs(
  raw: AndroidSessionRaw,
  status: PlaybackStatus,
  durationMs: number | null,
): number | null {
  const p = finite(raw.positionMs);
  if (p === null || p < 0) return null;
  let pos = p;
  if (status === 'playing') {
    const updated = finite(raw.lastPositionUpdateTime);
    const readAt = finite(raw.readAtElapsedMs);
    if (updated !== null && readAt !== null && updated > 0) {
      const age = readAt - updated;
      if (age > ANDROID_MAX_POSITION_AGE_MS) return null;
      if (age > 0) pos = p + age * rateOf(raw.speed);
    }
  }
  if (durationMs !== null) {
    if (pos > durationMs + ANDROID_PAST_END_TOLERANCE_MS) return null;
    pos = Math.min(pos, durationMs);
  }
  return Math.round(pos);
}

// ---------------------------------------------------------------- 곡 정보

function text(v: unknown, max = 512): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  return t.length > 0 && t.length <= max ? t : null;
}

/**
 * 노래가 아닌 항목(광고·팟캐스트 에피소드·오디오북)은 곡으로 보지 않는다.
 * Spotify의 MEDIA_ID는 `spotify:<종류>:<ID>` 형식으로 알려져 있다(실기기 미확인).
 */
function isSongItem(service: StreamingService, mediaId: string | null): boolean {
  if (service === 'spotify' && mediaId) {
    return !/^spotify:(?:ad|ads|advert|advertisement|episode|show|audiobook|chapter)(?::|$)/i.test(mediaId);
  }
  return true;
}

/**
 * 서비스 곡 ID(같은 서비스 안에서 곡을 가리키는 키). 형식을 확신할 수 있을 때만 쓰고, 아니면 null(메타데이터 지문으로 식별).
 * - Spotify: `spotify:track:<22자 base62>` → 22자 ID.
 * - YouTube Music: 11자 동영상 ID 형식일 때만.
 * - Apple Music(Android 앱): 형식 미확인 → 쓰지 않는다. iPhone·PC의 스토어 ID와 같은 `apple-music` 서비스라,
 *   다른 뜻의 숫자를 ID로 쓰면 백업을 옮겼을 때 다른 곡에 연결될 수 있다(불변조건 6).
 */
export function androidTrackId(service: StreamingService, mediaId: string | null): string | null {
  if (!mediaId) return null;
  if (service === 'spotify') {
    const m = /^spotify:track:([0-9A-Za-z]{22})$/.exec(mediaId);
    return m ? m[1]! : null;
  }
  if (service === 'youtube-music') return /^[A-Za-z0-9_-]{11}$/.test(mediaId) ? mediaId : null;
  return null;
}

/** 동영상 표기(공식 뮤직비디오·가사 영상 등)만 든 괄호인지. 녹음 버전 표시(live 등)가 있으면 지우지 않는다. */
const VIDEO_WORDS =
  /official|music|video|audio|lyrics?|visuali[sz]er|m\s*\/\s*v|\bmv\b|\bhd\b|\bhq\b|\b4k\b|公式|オフィシャル|ミュージック|ビデオ|歌詞|뮤직|비디오|뮤비|공식|가사/giu;

function isVideoNote(inner: string): boolean {
  const n = inner.normalize('NFKC').trim();
  if (n === '' || hasVersionMarker(n)) return false;
  return n.replace(VIDEO_WORDS, '').replace(/[\s\p{P}\p{S}]/gu, '') === '';
}

const TRAILING_VIDEO_NOTE =
  /\s*(?:[-–—|/]\s*)?(?:official\s+)?(?:music\s+video|lyric\s+video|video|audio|mv|m\/v|visuali[sz]er)\s*$/i;

/**
 * YouTube Music 동영상 항목의 제목·가수 정리. 노래(음원) 항목은 이미 깔끔해서 바뀌지 않는다.
 * - 가수: 자동 생성 채널 표시(" - Topic", " - 주제", " - トピック") 제거.
 * - 제목: 동영상 표기만 든 괄호·끝의 "Official Video" 등 제거, "가수 - 제목"이면 앞의 가수 제거,
 *   "가수「제목」" 꼴이면 따옴표 안 제목. 버전 표시(Live 등)는 남긴다(다른 녹음과 혼동 금지, 불변조건 6).
 * 정리 결과가 비면 원래 값을 쓴다.
 */
export function cleanYouTubeMusicMeta(title: string, artist: string): { title: string; artist: string } {
  const a = artist.replace(/\s*[-–—]\s*(?:topic|주제|トピック)\s*$/i, '').trim() || artist;
  let t = title.normalize('NFC');
  t = t.replace(/[([【]([^)\]】]*)[)\]】]/g, (m, inner: string) => (isVideoNote(inner) ? ' ' : m));
  const trailing = TRAILING_VIDEO_NOTE.exec(t);
  if (trailing && !hasVersionMarker(trailing[0])) t = t.slice(0, trailing.index);
  t = t.replace(/\s+/g, ' ').trim();
  const dash = /^(.+?)\s[-–—]\s(.+)$/.exec(t);
  if (dash && a && normalizeArtist(dash[1]!) === normalizeArtist(a)) t = dash[2]!.trim();
  const quoted = /^(.*?)[「『](.+?)[」』](.*)$/.exec(t);
  if (quoted) {
    const outside = `${quoted[1]!}${quoted[3]!}`;
    const rest = a ? normalizeArtist(outside).replace(normalizeArtist(a), '') : normalizeArtist(outside);
    if (rest.replace(/\s/g, '') === '') t = quoted[2]!.trim();
  }
  return { title: t || title, artist: a };
}

/** 세션 원시 값 → 곡 정보. 지원 앱이 아니거나 노래가 아니면 null */
export function mapAndroidTrack(raw: AndroidSessionRaw): ServiceTrackRef | null {
  const app = androidPlayerOf(raw.packageName);
  if (!app || raw.hasMetadata !== true) return null;
  const rawTitle = text(raw.title);
  if (!rawTitle) return null;
  const mediaId = text(raw.mediaId);
  if (!isSongItem(app.service, mediaId)) return null;
  let title = rawTitle;
  let artist = text(raw.artist) ?? text(raw.albumArtist) ?? '';
  if (app.service === 'youtube-music') ({ title, artist } = cleanYouTubeMusicMeta(title, artist));
  const dur = finite(raw.durationMs);
  return {
    service: app.service,
    serviceTrackId: androidTrackId(app.service, mediaId),
    title,
    artist,
    album: text(raw.album),
    durationMs: dur !== null && dur > 0 ? Math.round(dur) : null,
    isrc: null,
  };
}

export function mapAndroidSnapshot(raw: AndroidSessionRaw, capturedAtMonotonicMs: number): PlaybackSnapshot {
  const track = mapAndroidTrack(raw);
  const status = track ? mapAndroidState(raw.state) : 'stopped';
  return {
    track,
    status,
    // 측정 시각 = 응답을 받은 시각(호출자). 위치는 네이티브가 읽은 순간 기준이라 그 사이만큼 뒤처질 뿐 앞서가지 않는다.
    positionMs: track ? androidPositionMs(raw, status, track.durationMs) : null,
    capturedAtMonotonicMs,
    rate: status === 'playing' ? rateOf(raw.speed) : 0,
  };
}

// ---------------------------------------------------------------- 어느 세션을 따를지

/**
 * 여러 앱이 동시에 미디어 세션을 가질 때 따를 세션(지원 앱만):
 * 1) 재생 중(버퍼링 포함)인 세션 — 지금 따르는 앱이 그중에 있으면 그대로(화면이 오가지 않게), 아니면 가장 중요한 것(목록 순서)
 * 2) 아무것도 재생 중이 아니면 지금 따르는 앱 그대로(일시정지해도 가사 화면 유지)
 * 3) 처음이면 곡 정보가 있는 첫 세션
 */
export function pickAndroidSession(
  sessions: readonly AndroidSessionRaw[],
  followedPackage: string | null,
): AndroidSessionRaw | null {
  const supported = sessions.filter((s) => androidPlayerOf(s.packageName) !== null);
  const active = supported.filter((s) => {
    const st = mapAndroidState(s.state);
    return st === 'playing' || st === 'buffering';
  });
  const followed = (list: readonly AndroidSessionRaw[]) =>
    followedPackage ? (list.find((s) => s.packageName === followedPackage) ?? null) : null;
  if (active.length > 0) return followed(active) ?? active[0]!;
  return followed(supported) ?? supported.find((s) => s.hasMetadata === true) ?? supported[0] ?? null;
}

// ---------------------------------------------------------------- 재생 제어 가능 여부

/** PlaybackState.ACTION_* (일부는 androidx MediaSessionCompat 값) */
export const ANDROID_ACTIONS = {
  pause: 2,
  play: 4,
  skipPrevious: 16,
  skipNext: 32,
  seekTo: 256,
  playPause: 512,
  playFromSearch: 2048,
  skipToQueueItem: 4096,
  setShuffleMode: 2_097_152,
} as const;

export type AndroidAction = keyof typeof ANDROID_ACTIONS;

/** actions 비트에 해당 동작이 있는지(2^31을 넘는 값도 안전하게 나눗셈으로 판정) */
export function androidSupports(raw: AndroidSessionRaw | null, action: AndroidAction): boolean {
  const a = finite(raw?.actions);
  if (a === null || a < 0) return false;
  return Math.floor(a / ANDROID_ACTIONS[action]) % 2 === 1;
}

// ---------------------------------------------------------------- 재생 목록(대기열)

/** MediaSession.QueueItem 원시 값 */
export interface AndroidQueueItemRaw {
  /** QueueItem.getQueueId() — long이라 10진 문자열로 받는다 */
  queueId?: unknown;
  title?: unknown;
  subtitle?: unknown;
  mediaId?: unknown;
  /** description extras의 DURATION(있을 때만) */
  durationMs?: unknown;
}

export interface AndroidQueueTrack {
  queueId: string;
  ref: ServiceTrackRef;
}

export const ANDROID_QUEUE_LIMIT = 1_000;

/**
 * 재생 목록 → 곡 목록(가사 원문 일괄 받기·번역 묶음용). 지금 재생과 **같은 규칙**(앱→서비스, 곡 ID 형식, YouTube Music 정리)으로
 * 곡 정보를 만들어, 서비스 곡 ID가 있는 앱(Spotify·YouTube Music)은 재생할 때 같은 곡 연결로 찾는다.
 * 부제는 가수로 쓰되 "가수 • 앨범" 꼴이면 앞부분만. 길이는 앱이 줄 때만 있다(없으면 null — 곡 식별에서 길이를 비교하지 않음).
 */
export function mapAndroidQueue(packageName: unknown, items: unknown): AndroidQueueTrack[] {
  const app = androidPlayerOf(packageName);
  if (!app || !Array.isArray(items)) return [];
  const out: AndroidQueueTrack[] = [];
  const seen = new Set<string>();
  for (const it of items.slice(0, ANDROID_QUEUE_LIMIT)) {
    if (typeof it !== 'object' || it === null) continue;
    const o = it as AndroidQueueItemRaw;
    const queueId = typeof o.queueId === 'string' && /^-?[0-9]{1,20}$/.test(o.queueId) ? o.queueId : null;
    if (!queueId || seen.has(queueId)) continue;
    const sub = text(o.subtitle);
    const artist = sub ? (sub.split(/\s+[•·—]\s+/)[0] ?? sub).trim() : '';
    const ref = mapAndroidTrack({
      packageName: app.packageName,
      hasMetadata: true,
      title: o.title,
      artist,
      mediaId: o.mediaId,
      durationMs: o.durationMs,
    });
    if (!ref) continue;
    seen.add(queueId);
    out.push({ queueId, ref });
  }
  return out;
}
