/** 도메인 모델. 저장소 스키마와 1:1은 아니며, 저장소는 이 타입으로 읽고 쓴다. */

export type Lang = 'ja' | 'en' | 'ko' | 'mixed' | 'unknown';

/** synced: 행 단위 타임스탬프 있음, plain: 시간 정보 없음, instrumental: 연주곡 */
export type LyricsKind = 'synced' | 'plain' | 'instrumental';

export interface LyricLine {
  /** 가사 판본 안에서 안정적인 행 ID. 번역·발음은 이 ID에만 연결된다. */
  id: string;
  text: string;
  /** synced 판본에서만 값이 있다. AI는 이 값을 만들거나 바꿀 수 없다. */
  startMs: number | null;
}

/** 내부 곡 식별자 단위. 녹음 버전(라이브·리믹스 등)이 다르면 다른 Song이다. */
export interface Song {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  durationMs: number | null;
  /** 정규화된 녹음 버전 태그(live, remix, tv-size 등). 매칭 시 반드시 일치해야 한다. */
  versionTags: string[];
  isrc: string | null;
  activeLyricsVersionId: string | null;
  createdAtEpochMs: number;
}

export type LyricsSourceKind = 'lrclib' | 'user';

/** 불변 가사 판본. 원문이 달라지면 새 판본을 만들고 기존 판본은 보존한다. */
export interface LyricsVersion {
  id: string;
  songId: string;
  source: LyricsSourceKind;
  /** LRCLIB 레코드 ID 등 */
  sourceRef: string | null;
  kind: LyricsKind;
  language: Lang;
  lines: LyricLine[];
  /** 행 텍스트만으로 계산한 SHA-256. 번역 호환성 판단에 사용 */
  textHash: string;
  /** 텍스트+타임스탬프로 계산한 SHA-256 */
  contentHash: string;
  /** 원본에 단어 단위 싱크가 있었는지(현재 표시에는 사용하지 않음) */
  hasWordTimingSource: boolean;
  createdAtEpochMs: number;
}

export interface Provenance {
  providerId: string;
  model: string;
  promptVersion: string;
}

export type TranslationOrigin = 'user' | 'ai';

export interface TranslationVersion {
  id: string;
  lyricsVersionId: string;
  origin: TranslationOrigin;
  /** lineId → 한국어 번역. 사용자 번역은 일부 행만 있을 수 있다. */
  lines: Record<string, string>;
  /** 생성 당시 원문 textHash. 이력용이며 이것만으로 무효화하지 않는다. */
  sourceTextHash: string;
  provenance: Provenance | null;
  createdAtEpochMs: number;
  /** 저장 순서. 같은 origin 안에서 최신 판본 선택에 사용 */
  seq: number;
}

export interface PronunciationLine {
  /** 발음 기준 가나 읽기(AI 생성 시). 사용자가 한글만 입력하면 null */
  kana: string | null;
  /** 한국어 사용자를 위한 한글 독음 */
  hangul: string;
}

export interface PronunciationVersion {
  id: string;
  lyricsVersionId: string;
  origin: TranslationOrigin;
  lines: Record<string, PronunciationLine>;
  sourceTextHash: string;
  provenance: Provenance | null;
  createdAtEpochMs: number;
  seq: number;
}

/**
 * 사용자가 직접 기록한 행 시작 시각(수동 싱크, docs/plan.md D-28).
 * - 사람이 노래를 들으며 탭해서 만든 시간만 저장한다. AI는 이 값을 만들거나 바꿀 수 없다(불변조건 5).
 * - 가사 판본은 그대로 두고(번역·발음의 행 ID 연결 유지) 시간만 별도 버전으로 추가한다.
 * - kind='cleared'는 "원래 시간으로 되돌리기"(추가 전용 저장이라 삭제 대신 표시를 남긴다).
 */
export interface UserTimingVersion {
  id: string;
  lyricsVersionId: string;
  kind: 'timed' | 'cleared';
  /** lineId → 시작 ms(빈 행 제외, 가사 순서대로 앞에서부터 연속). cleared면 빈 객체 */
  lines: Record<string, number>;
  /** 기록 당시 원문 textHash(이력용) */
  sourceTextHash: string;
  createdAtEpochMs: number;
  /** 저장 순서. 가장 큰 seq가 현재 값 */
  seq: number;
}

export interface DisplaySettings {
  showTranslation: boolean;
  showPronunciation: boolean;
}

export interface TranslationSettings {
  /** 사용자가 동의해야 켜진다. 기본값 false */
  autoTranslate: boolean;
}

export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
  showTranslation: true,
  showPronunciation: true,
};

export const DEFAULT_TRANSLATION_SETTINGS: TranslationSettings = {
  autoTranslate: false,
};

export type JobKind = 'translation' | 'translation+pronunciation' | 'pronunciation';

/**
 * in_flight: 요청 진행 중(앱 종료 시 unknown_outcome으로 전환)
 * unknown_outcome: 제공자가 처리·과금했는지 확정 불가. 자동 재요청 금지
 * failed: 확정 실패(재시도 범위는 failure.retryScope)
 */
export type JobStatus = 'in_flight' | 'completed' | 'failed' | 'unknown_outcome' | 'cancelled';

export type FailureKind =
  | 'auth'
  | 'rate_limited'
  | 'overloaded'
  | 'bad_request'
  | 'server'
  | 'timeout'
  | 'offline'
  | 'aborted'
  | 'invalid_response'
  | 'refusal'
  | 'storage'
  | 'unknown';

export interface JobFailure {
  kind: FailureKind;
  /** 이미 마스킹된 메시지 */
  message: string;
  /** 다시 요청할 범위. none이면 같은 요청을 반복해도 해결되지 않음 */
  retryScope: 'none' | 'translation' | 'pronunciation' | 'all';
  billedRisk: 'none' | 'possible';
  retryAfterMs?: number;
}

export interface TranslationJob {
  id: string;
  lyricsVersionId: string;
  kind: JobKind;
  status: JobStatus;
  providerId: string;
  model: string;
  promptVersion: string;
  createdAtEpochMs: number;
  updatedAtEpochMs: number;
  failure: JobFailure | null;
}
