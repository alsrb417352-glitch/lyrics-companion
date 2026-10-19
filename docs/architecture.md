# 아키텍처

## §1 개요 — 보조 앱
```
[스트리밍 앱] --재생 정보--> [PlaybackSource 어댑터(네이티브)] --> [core: NowPlayingSession]
                                                                     |  곡 식별 → 가사(저장본 우선) → 번역 정책
[LRCLIB] <--LyricsProvider-- core --TranslationProvider--> [사용자 AI 제공자]
                                     |
                                [LyricsStore(SQLite)]  +  [SecretStore(Keychain/Keystore)]
                                     |
                              [가사 화면(React Native)]
```
- 음악 재생은 스트리밍 앱이 한다. 우리 앱은 **현재 곡의 가사를 보여주는 화면**이다.
- 모든 판단 로직(어떤 가사·번역을 보여줄지, 언제 AI를 부를지, 어떤 행이 현재 행인지)은 **플랫폼 독립 core**(`packages/core`)에 있고 자동 테스트로 검증한다.
- UI와 OS 연동(재생 정보·보안 저장소·SQLite 드라이버·HTTP)은 앱 계층(`apps/mobile`, Phase 1 이후)에서 core 포트를 구현한다.

## §2 기술 선택 (상세: [ADR-0001](decisions/ADR-0001-tech-stack.md))
| 영역 | 선택 | 이유 요약 |
|---|---|---|
| 앱 | React Native + Expo(SDK 56, 개발 빌드) + TypeScript | 한 코드로 Android·iOS. 네이티브 연동은 Expo Modules(Kotlin/Swift)로 작성. |
| core | 순수 TypeScript, 런타임 의존성 0 | Windows에서 Node만으로 테스트. 앱에서도 같은 코드 사용. |
| 저장소 | SQLite(앱: expo-sqlite, 테스트: node:sqlite) | 같은 SQL·마이그레이션을 테스트에서 실제로 실행. 트랜잭션으로 원자적 저장. |
| 비밀 저장 | expo-secure-store(Android Keystore 암호화 / iOS Keychain) | OS 보안 저장소 사용 요구사항. |
| 검사 | Prettier, ESLint(+아키텍처 경계 규칙), tsc, Vitest, 자체 비밀정보 검사·추적성 검사·뮤테이션 스모크 | `npm run check` 하나로 재현. |

## §3 모듈 경계와 포트
`packages/core/src/`

| 모듈 | 책임 | 주요 파일 |
|---|---|---|
| ports | 교체 가능한 외부 의존성: `Clock`(시간), `HttpClient`, `SecretStore`, `LogSink`, `IdGenerator`, `PlaybackSource`(재생 정보 제공자) | `ports.ts` |
| lyrics | LRC 파싱, 판본 생성(행 ID·해시), LRCLIB 클라이언트, 가사 제공자 포트 `LyricsProvider` | `lyrics/*` |
| matching | 곡 식별·녹음 버전 태그·후보 판정 | `matching/track-identity.ts` |
| sync | 재생 위치 추정·현재 행 계산(순수 함수) | `sync/sync-engine.ts` |
| display | 화면 행 구성·접근성 라벨(순수 함수) | `display/compose.ts` |
| translation | 번역 제공자 포트 `TranslationProvider`, 프롬프트, 응답 검증, 선택 우선순위, **TranslationService(불변조건 강제)**, OpenAI 호환 어댑터 | `translation/*` |
| pronunciation | 가나→한글 독음 규칙 | `pronunciation/kana-to-hangul.ts` |
| storage | `SqlDriver` 포트, 마이그레이션, `LyricsStore` | `storage/*` |
| security | 키 관리(`ApiKeyManager`), 마스킹, 로거 | `security/*` |
| import | 사용자 번역 TXT/LRC 미리보기·검증 | `import/user-translation-import.ts` |
| session | 현재 곡 세션 조립(`NowPlayingSession`) | `session/now-playing-session.ts` |

교체 가능한 다섯 축(요구사항): **재생 정보 제공자**(`PlaybackSource`), **가사 제공자**(`LyricsProvider`), **번역 제공자**(`TranslationProvider` + `TranslationProviderRegistry`), **저장소**(`SqlDriver`), **시간 공급자**(`Clock`). 테스트는 모두 가짜 구현을 쓴다(`packages/core/test/support/`).

경계 규칙(ESLint로 강제): `core/src`에서 `node:*`·`react-native`·`expo*` import 금지, 전역 `fetch`·`Date`·`setTimeout`·`console` 사용 금지(포트 사용).

## §4 대체 흐름
- `PlaybackSource.access()`가 `denied/unsupported`이면 앱은 수동 모드: 사용자가 고른 곡을 `ServiceTrackRef{service:'unknown', serviceTrackId:null}`로 세션에 전달.
- 세션은 저장된 곡과 메타데이터가 맞으면 `needs-confirmation`(후보) 상태로 멈추고, 사용자가 `confirmCandidate`/`rejectCandidates`를 호출한다.
- 위치 정보가 없으므로 `syncFor(null)` → `unknown` → 화면은 `position-unknown`(강조 없음).
- 자동 싱크가 안 되는 가사(시간 정보 없음·시간이 틀림)는 **수동 싱크 기록**(§8, D-28)으로 해결한다. 재생 위치는 계속 Music 앱에서 읽고, 줄 시작 시각만 사용자가 탭으로 기록한다(앱 내부 시계로 진행을 만드는 방식은 쓰지 않는다).

## §5 가사 조회 (LRCLIB)
- `LrclibClient`: 식별 헤더(`User-Agent`, `Lrclib-Client`), 순차 큐 + 최소 간격(기본 300ms), 429/503 `Retry-After` 동안 네트워크 요청 없이 `rate_limited` 반환, Content-Type·크기·필드 검증, HTTPS만 허용.
- 자동 조회(`AppleMusicLyricsProvider`, iPhone·PC·Android 공통): ① Music 앱 표기로 `/api/get`(LRCLIB가 제목·가수·길이 ±2초를 맞춰 줌) ② 못 찾았고 스토어 ID가 있으면 iTunes Lookup의 jp·us·kr 표기로 `/api/get` ③ 가수까지 맞는 레코드를 찾았으면 그 표기(제목+가수)로 `/api/search` 1회 더 — 같은 곡의 다른 업로드 비교용(실패해도 이미 찾은 것으로 정함). 가장 나은 것이 아직 "싱크 + 원문"이 아니면(로마자 싱크·시간 정보 없는 가사 등) 스토어 ID의 다른 나라 표기도 얻어 표기마다 제목+가수로 검색 ④ 아무것도 못 찾았으면 제목으로 `/api/search`(길이 ±2초·버전·제목이 맞는 것만). 이보다 나을 수 없는 레코드(같은 곡·싱크·원문·뜻·발음)를 찾으면 바로 멈춘다.
- **가사 후보 순위**(`rankLyricsRecords`, D-43 사용자 결정): ① 곡 일치 — `same`(제목·버전 태그·길이 ±2초 + 가수 확인: `/api/get` 결과 또는 알려진 가수 표기) > `probable`(가수 표기만 다름 → 자동 적용 없이 후보) > `mismatch`(자동·후보 제외, 직접 검색 목록 맨 아래) ② 싱크 가사(파싱 성공) ③ 원문 가사(곡 원어 문자: 일본어 곡이면 가나·한자 줄이 원문 줄의 20% 이상 — 로마자·번역만 있으면 원문 없음, 한국어 곡이면 한글, 그 밖은 한글 아닌 글자. 곡 언어는 곡 정보의 가나·곡이 맞는 후보 내용으로 추정) ④ 한국어 뜻 ⑤ 한글 발음(④⑤는 가사에 원문과 번갈아 들어 있는 한국어 줄이 원문 줄의 절반 이상에 붙어 있을 때) ⑥ 같으면 다른 언어 줄(로마자·외국어 번역)이 번갈아 끼지 않은 것 → 길이 차이 → 레코드 ID. 연주곡 버전을 재생 중이면 ① 다음에 연주곡 레코드를 앞에. 가사 고르기 화면(iPhone·PC)도 같은 순위로 정렬하고 `summarizeLyricsCandidate` 문구(있는 것·경고·첫 원문 줄)를 보인다.
- **가사에 포함된 한국어 줄 나누기**(`splitEmbeddedKorean`, D-43): 원문 줄 대부분(일본어 70%·그 밖 90% 이상)이 같은 개수(1~2개)의 한국어 줄을 바로 뒤(또는 앞)에 달고 있을 때만 나눈다. 일본어 원문이면 원문 가나의 한글 독음 음절이 순서대로 들어 있는지(최장 공통 부분열 50% 이상) + 일본어 독음 음절 모양(70% 이상)으로 발음을 가리고, 곡 전체 다수결로 "몇 번째 줄이 발음인지"를 정한다(갈리면 나누지 않음). 일본어가 아닌 원문은 8줄 이상·한 줄씩 붙은 경우만 뜻으로. 원문 줄 시간·빈 줄(간주·끝 시각)은 그대로 두고 한국어 줄 시간은 쓰지 않는다(불변조건 5). 어느 원문에도 붙지 않은 한국어 줄(머리말 등)은 버린다. 나눈 뜻·발음은 `buildFetchedLyrics`가 origin `lyrics` 번역·발음 버전으로 만들어 `saveLyricsVersion(..., { embedded })`로 판본과 한 트랜잭션에 저장한다(세션·일괄 받기·직접 고르기 모두).
- `classifyLrclibRecord`: `instrumental` → 연주곡 / `syncedLyrics` 파싱 성공 → 싱크 / 실패 + `plainLyrics` → 일반(알림 `invalid-synced`) / 실패만 → 오류(저장 안 함) / 둘 다 없음 → 없음.
- 받은 레코드가 버전 태그·길이(±2초)와 맞지 않으면 사용하지 않는다(`incompatible-version`).
- 같은 곡에 저장본이 있으면 **LRCLIB를 다시 조회하지 않는다**(오프라인 우선). 원문 갱신은 사용자 요청 기능(Phase 5).

## §6 곡 식별
- 내부 `Song`은 **녹음 단위**다. `versionTags`(live, remix, acoustic, instrumental, tv-size, edit, extended, demo, cover, speed, rerecord, orchestral, unplugged, `version:<언어 등>`)가 다르면 다른 Song.
- 서비스 연결 `service_tracks(service, service_key)`: `service_key = id:<서비스 곡 ID>` 또는 ID가 없을 때 `fp:<핵심제목|태그|아티스트|앨범|길이초>`(같은 서비스 안에서만 의미).
- 판정 순서(`decideMatch`): ① 서비스 키 연결 있음 → 그 곡 ② ISRC 일치 + 버전 태그 일치 + 길이 ±2초(모르면 허용) → 자동 연결(`linked_by=isrc`) ③ 핵심 제목·아티스트·버전 태그 일치 + 길이 ±2초 + ISRC 충돌 없음 → **후보**(사용자 확인) ④ 그 외 → 새 곡.
- 알 수 없는 괄호 내용은 제목 일부로 남겨 보수적으로 비교(잘못된 연결보다 새 곡 생성이 안전). 리마스터·feat.·explicit 표기는 같은 녹음으로 본다.

## §7 저장소와 데이터 모델
SQLite, `PRAGMA user_version`으로 스키마 버전 관리(현재 v4 — v3에서 `user_timings` 추가, v4에서 번역·발음 `origin`에 `lyrics` 추가: 표를 새로 만들어 기존 행을 `seq`까지 그대로 옮김). 앱에서는 **앱 문서 영역**(캐시 아님)에 DB 파일을 둔다.

| 테이블 | 내용 | 규칙 |
|---|---|---|
| songs | 내부 곡(녹음) | `active_lyrics_version_id`는 사용자 확인 또는 최초 저장 시에만 변경 |
| service_tracks | (서비스, 서비스 키) → 곡 | `linked_by`: created / isrc / user |
| lyrics_versions | 불변 가사 판본: `lines_json`(행 ID·텍스트·시작 ms), `text_hash`, `content_hash`, 출처 | 수정 없음. 원문이 다르면 새 판본 |
| translations | 번역 버전(`origin` user/ai/lyrics, 행 ID→번역, 생성 당시 `source_text_hash`, 제공자·모델·프롬프트 버전 — lyrics는 `lrclib`·`lrclib:<id>`·`embedded-ko/v1`) | 추가만 함(덮어쓰기 없음). `seq`로 최신 판단 |
| pronunciations | 발음 버전(행 ID→{kana, hangul}) | 위와 같음 |
| sync_offsets | 곡별 보정값(ms) | ±30초로 제한 |
| user_timings | 사용자가 탭으로 기록한 행 시작 시각(`kind` timed/cleared, 행 ID→ms) | 추가만 함. 가장 큰 `seq`가 현재 값, `cleared`면 원래 시간. 저장 시 판본 기준 검증 |
| settings | 키-값 설정(`display.*`, `translate.auto`) | 비밀정보 저장 금지 |
| jobs | 번역 작업 상태 | §12 상태 전이 |
| usage_daily | UTC 일자별 요청 수·원문 글자 수 | 요청 전 원자적 예약 |

- 원문 해시·모델·프롬프트 버전은 **이력용**이다. 이 값이 달라졌다는 이유만으로 번역을 무효화·재생성하지 않는다.
- 판본이 바뀌어도 기존 번역은 기존 판본에 남는다(새 판본에 자동으로 붙이지 않음). 같은 `text_hash`면 번역을 그대로 연결할 수 있지만, 연결은 사용자 확인 기능(Phase 5)으로 한다.
- 마이그레이션: 각 버전을 트랜잭션으로 실행, 실패 시 롤백(`MigrationError`). 앱보다 새 스키마는 열지 않는다. 앱 계층은 마이그레이션 전 DB 파일 사본을 만든다(docs/security.md §6).

## §8 싱크
- 입력: 가사 판본(행 시작 ms), `PlaybackSnapshot{status, positionMs|null, capturedAtMonotonicMs, rate}`, 곡별 보정값.
- **행 시작 시각의 출처**(`effectiveTiming`, `sync/user-timing.ts`): 사용자 싱크 기록이 있으면 그것, 없으면 원문 타임스탬프. 사용자 기록은 사람이 재생을 들으며 탭한 재생 위치만 담는다(AI가 만들 수 없음). 기록 대상은 빈 행이 아닌 행이고 앞에서부터 연속·시각 비감소. 빈 행은 다음 기록 행과 같은 시각(따로 강조 안 됨), 기록하지 않은 행은 `+∞`(절대 활성화되지 않음 — 진행을 꾸며내지 않음). 일반(plain) 가사도 기록이 있으면 synced로 계산한다. 기록 저장 시 곡별 보정은 0으로 되돌린다(기록이 실제 재생 위치이므로).
- `estimatePositionMs`: playing이면 `position + (now − capturedAt) × rate`(곡 길이로 상한), paused/stopped/buffering이면 고정, 위치 없음·상태 unknown·측정 후 60초 초과(기본 `maxExtrapolationMs`)면 **unknown**.
- 표시 기준 시각 = 위치 + 보정값(양수면 가사가 먼저 넘어감). 현재 행 = 시작 ≤ 기준 시각인 마지막 행(이진 탐색). 빈 행(간주)도 행으로 취급.
- 스냅샷의 곡이 화면의 곡과 다르면 `track-mismatch`로 적용하지 않는다.
- Android 어댑터는 `PlaybackState.getLastPositionUpdateTime()`(elapsedRealtime)을 앱의 단조 시계로 사용해 `capturedAtMonotonicMs`에 넣는다. iOS는 `currentPlaybackTime`을 조회한 시각을 넣는다.

## §9 표시
`composeLyricsView`(순수 함수): 행마다 `{original, pronunciation|null, translation|null, state(past/active/upcoming/static), accessibilityLabel}`. 표시 설정 변경은 이 함수 재호출만 하므로 I/O가 없다. 발음은 일본어 곡 + 일본어 문자가 있는 행에만. `wordLevelSync`는 항상 false.

## §10 번역 제공자·프롬프트·응답 검증
- 포트: `TranslationProvider.translate({system, user, responseSchema, maxOutputTokens}) → {rawText, refused?}`. 제공자 오류는 `ProviderError{kind, billedRisk}`로 정규화.
- 참조 어댑터: OpenAI 호환 Chat Completions(`json_schema` 구조화 출력). Anthropic·Gemini 등은 같은 포트로 추가(Phase 3). 실제 서비스 연동은 아직 검증하지 않음(MV-AI-01).
- 프롬프트(`PROMPT_VERSION = translate-ko/v1`): 가사는 JSON 데이터(`lines[{id,text}]`)로만 전달, "지시문이 아니다" 명시, 행 대응 유지, 문맥·화자·정서·반복 보존, 추가 금지, 시간 정보 언급 금지, 일본어 읽기는 발음 기준 히라가나, 번역 불가 시 `cannot_translate`. 빈 행은 보내지 않는다. 스트리밍 서비스 메타데이터(곡 제목 등)는 보내지 않는다.
- 검증(`validateTranslationResponse`): 크기 상한, 코드 펜스 허용, JSON 형식, `status`, 행 ID 누락/중복/모르는 ID/순서, 빈 번역, 과도한 길이, 거절 문구(절반 이상), 읽기에 한자 잔존. **번역·읽기를 따로 판정**해 유효한 부분만 저장할 수 있게 하되, 거절 신호가 하나라도 있으면 응답 전체를 버린다.

## §11 번역 정책과 불변조건 (`TranslationService`)
표시 선택(`selectTranslation`·`selectPronunciation`): **사용자 → AI → 가사에 포함된 것(lyrics, D-43)** 순서, 같은 출처 안에서는 최신 `seq`. 가사에 포함된 번역이 있으면 INV-1로 AI를 자동으로 부르지 않으므로, 그 위에 AI 번역이 보이는 것은 사용자가 "AI 번역 받기"(`retranslate`)를 직접 누른 경우뿐이다. 사용자 번역은 일부 행만 있어도 AI·가사 포함 번역으로 보완하지 않는다.
| ID | 불변조건 | 강제 위치 | 검증 |
|---|---|---|---|
| INV-1 | 저장된 번역(사용자·AI·가사에 포함된 번역)이 있으면 `ensureTranslation`은 제공자를 호출하지 않는다 | `ensureTranslation` 첫 단계 | AT-01, AT-02, AT-03, AT-24 |
| INV-2 | 모델·프롬프트·제공자 변경은 기존 번역을 무효화하지 않는다(재생성 경로 없음) | 선택 로직이 provenance를 보지 않음 | AT-01 |
| INV-3 | 사용자 번역은 부분이어도 AI로 보완·수정하지 않는다 | `selectTranslation` + 추가 전용 저장 | AT-03, AT-06 |
| INV-4 | 발음이 없다는 이유로 번역을 재생성하지 않는다. 발음은 `requestPronunciation`(명시 요청)으로만 | 작업 종류 분리 | AT-12 |
| INV-5 | 재번역은 `retranslate`(명시 요청)로만, 새 버전 | API 분리 | versions.test |
| INV-6 | 같은 판본·같은 종류 동시 요청은 하나의 작업 | `start()`의 in-flight 맵(검사·등록 사이 await 없음) | AT-05 |
| INV-7 | 결과 저장과 작업 완료는 한 트랜잭션. 검증 실패·저장 실패는 완료가 아님 | `commitAiResult` | AT-12 |
| INV-8 | 결과 미확인(타임아웃·앱 종료)은 자동 재요청 금지, 사용자 확인 후에만 | `unknown_outcome` 검사, 시작 시 `markInterruptedJobs` | AT-11 |
| INV-9 | 자동 번역은 사용자가 켠 경우에만, 일일 상한 안에서만 | `run()` 조건 검사, `reserveUsage` | AT-11 |

신규 AI 번역 실행 조건(모두 충족): 저장 번역 없음 · 연주곡 아님 · 번역할 행 있음 · 한국어 곡 아님 · 크기 상한 이내 · (자동이면) 자동 번역 켜짐 · 결과 미확인 작업 없음(또는 사용자 확인) · 활성 제공자와 키 있음 · 일일 상한 이내.

## §12 상태 전이
**세션(`NowPlayingSession.phase`)**
```
idle → resolving → (needs-confirmation → [confirm|reject]) → loading-lyrics → ready | no-lyrics
곡 변경 시 언제든 → resolving (generation +1, 이전 generation의 모든 갱신 무시)
```
번역 상태(`translationStatus`): none → pending → available | failed | skipped. 사용자 저장 시 즉시 available(user).

**작업(`jobs.status`)**
```
(생성) in_flight ─성공+저장──────────→ completed (부분 실패 정보 포함 가능)
          ├─검증 실패/확정 오류(401·429·400·오프라인 전송 전)→ failed (retryScope: none|translation|pronunciation|all)
          ├─타임아웃·5xx·전송 후 오류(billedRisk=possible)→ unknown_outcome ──사용자 확인──→ 새 작업
          ├─취소─────────────────────→ cancelled
          └─앱 종료(다음 시작 시)──────→ unknown_outcome
```

## §13 앱 계층 (`apps/mobile`, iOS 우선 — 2026-10-04 구현 시작)
- 구조: Expo SDK 57(React Native 0.86) 별도 패키지. core는 `file:../../packages/core` 의존성 + `metro.config.js`(core 내부 `.js` import를 `.ts`로 해석)로 연결(D-15).
- `src/adapters/`: `ExpoSqliteDriver`(SqlDriver, 문서 영역 DB), `ExpoSecretStore`(Keychain, THIS_DEVICE_ONLY), `FetchHttpClient`(https만, 타임아웃, POST 결과 미확인 분류), `SystemClock`(performance.now), `UuidIds`(expo-crypto), `RingLogSink`(메모리 200건), `IosMusicPlaybackSource`(PlaybackSource + PlaybackControl).
- `modules/now-playing`(로컬 Expo 모듈, Swift): `systemMusicPlayer`의 원시 값 전달·재생 제어·`setQueue(storeIDs)`·보관함 검색. 값 해석은 core `playback/ios-system-player.ts`(테스트로 고정).
- `src/services.ts`: 조립 지점. 번역 제공자 레지스트리는 SQLite의 제공자 설정(`provider.config`, 비밀 아님) + Keychain 키가 모두 있을 때만 OpenAI 호환 어댑터를 만든다.
- 화면(`src/ui/`): 지금 재생(가사·원문/발음/번역·보정·재생 제어·번역 요청·곡/가사 후보 확인·가사 바꾸기), 검색(Apple Music·보관함), 설정(제공자·키·자동 번역 동의·오늘 사용량).
- 재생 갱신: 곡 변경 알림 + 화면 표시 중 0.5초 재조회(탐색 반영, 측정 시각은 왕복 중간값, D-19), 백그라운드에서는 조회하지 않음. 화면 계산은 250ms 주기로 활성 행이 바뀔 때만 다시 그린다.
- Apple Music 전용(D-17). 가사 조회는 core `AppleMusicLyricsProvider`(D-18), 확정 못 한 후보는 `NowPlayingSession.lyricsCandidates` → 사용자가 `chooseLyricsRecord`로 선택. 줄 탭 → Music 앱 탐색(D-20).
- 편집(2026-10-05): `EditScreen` — 번역 직접 입력·고치기(현재 보이는 번역으로 채워 시작, 붙여넣기 TXT·LRC는 core `previewTxtImport`/`previewLrcImport`가 정확히 맞을 때만 칸 채움), 발음(한글 독음) 고치기(core `buildUserPronunciation`: 바꾼 행만 kana=null). 저장은 `NowPlayingSession.saveUserTranslation`/`saveUserPronunciation`(새 버전 추가, AI 호출 없음).
- 백업(2026-10-05): `adapters/backup-files.ts`(expo-file-system 쓰기·파일 선택 + expo-sharing 공유 시트) → core `parseBackup`(검증) → `LyricsStore.importUserData`(원자적 병합) → `NowPlayingSession.reloadCurrent()`. 공유 확장(share extension)·iCloud 권한은 쓰지 않는다(무료 서명, D-23).
- 플레이리스트(2026-10-05, D-30): Swift `listPlaylists`·`playlistItems`(MPMediaQuery.playlists, persistentID는 10진 문자열) → core `mapLibraryPlaylists`/`mapLibraryTracks`(검증) → `PlaylistsScreen`. 재생은 `playPlaylist(id, 시작 곡, 셔플)` = `MPMusicPlayerMediaItemQueueDescriptor`(startItem) + `systemMusicPlayer.setQueue` → `prepareToPlay` → `play`. Music 앱이 백그라운드에서 재생하므로 앱 전환이 없다.
- 가사 원문 일괄 받기(2026-10-05, D-31): `PlaylistsScreen` → `PlaylistLyricsBatchPanel` → core `PlaylistLyricsBatch`(`services.playlistBatch`, 앱에 하나). 보관함 곡은 `libraryTrackToRef`로 지금 재생과 같은 `ServiceTrackRef`가 되어 같은 곡 행·serviceKey를 쓴다. 곡 식별 → 저장본 확인 → 없을 때만 LRCLIB 조회 → 판본 저장(곡마다 원자적). 번역 서비스에 의존하지 않으므로 AI 호출 경로가 없다.
- UI 부품(2026-10-05, D-32): `ui/icons.tsx`(react-native-svg로 직접 그린 아이콘), `common.tsx`의 `IconButton`·`ArtworkTile`·아이콘 붙은 `Button`, `PlaybackBar`(진행 막대·시간·재생 컨트롤). 아이콘만 있는 버튼은 접근성 이름을 필수로 받는다.
- 원문 TXT 내보내기(D-29): core `lyricsToPlainText`·`plainTextFileName` → `adapters/text-export.ts`(캐시에 쓰고 공유 시트, 끝나면 삭제).
- 수동 싱크(D-28): `SyncRecordScreen`(버튼 onPressIn 순간의 `estimatePositionMs`를 기록, 되돌리기 시 3초 앞으로 이동) → `NowPlayingSession.saveUserTiming`/`clearUserTiming`. 줄 탭 이동은 `session.lineStartMs(i)`(기록이 있으면 기록 시각).
- 지금 재생 하단: 자주 쓰지 않는 기능(가사 바꾸기·번역 입력·발음 고치기·원문 txt·싱크 기록·되돌리기)은 "도구" 버튼 안에 모았다. 시간 정보 없는 가사면 "싱크 직접 기록"을 바로 보인다.
- Android(2026-10-14, D-41): 아래 §15. 화면은 같은 파일을 쓰고 `services.android`가 있을 때만 갈라진다(권한 안내 `AndroidAccess.tsx`, 플레이리스트 탭 `QueueScreen.tsx`, 검색 탭의 앱 고르기·검색 재생, 지금 재생 헤더의 앱 이름).
- 남은 것: TXT/LRC **파일** 가져오기·행 수동 연결 화면, 곡별·전체 삭제(Phase 4).

## §14 PC 확장 프로그램 (`apps/pc-extension`, Windows Chrome/Edge — 2026-10-06, D-36)
```
[music.apple.com 탭]
  page-bridge.js (MAIN world: MusicKit 인스턴스·<audio id="apple-music-player">에서 원시 값만 읽음, 재생 명령 실행)
        │ window.postMessage (TAG lc-v1, 같은 출처만)
  relay.js (ISOLATED world: 패널이 열려 있을 때만 Port 'lc-tab' 연결)
        │ chrome.runtime Port
[사이드 패널 panel.html / 따로 띄운 창 panel.html?window=1]  ← Web Locks로 한 곳만 저장소를 연다
  TabsPlayback(PlaybackSource) → core mapMusicKitSnapshot / remoteCaptureMonotonic → usePlayback(PositionFilter) → NowPlayingSession
  SqlJsDriver(SqlDriver, sql.js WASM) ⇄ IndexedDB('lyrics-companion'/files/main: DB 파일 통째)
  NativeSecretStore(SecretStore) ⇄ 네이티브 메시징 com.lyrics_companion.secret_store (secret-host.ps1, DPAPI)
  FetchHttpClient → LRCLIB · iTunes(host_permissions) · AI 제공자(optional_host_permissions, 사용자 허용)
```
- **판단 로직은 iPhone 앱과 같은 core**를 쓴다(`services.ts`의 조립 구조도 `apps/mobile/src/services.ts`와 같음). PC 전용 core 코드는 웹 플레이어 값 해석 `playback/musickit-web.ts` 하나(AT-21, unit/musickit-web).
- **재생 정보**: MusicKit `currentPlaybackTime`은 정수 초로 반올림돼 있어(2026-10-06 페이지에서 확인) 실제 소리를 내는 `<audio>`의 `currentTime`을 쓴다. 둘이 1.5초 넘게 다르면 다른 미디어로 보고 MusicKit 값을 쓴다. 미리듣기(`previewOnly`)면 위치 모름. 측정 시각은 페이지의 `performance.timeOrigin + now()`를 받아 전달 지연(0~1초)만큼만 앞당기고, 그 밖이면 받은 시각(위치를 앞서 추정하지 않음, D-25와 같은 원칙). 재생 중 0.25초·멈춤 1초 간격 + MusicKit 이벤트(곡·상태·속도·대기열 변경) 즉시 전송, 패널이 없으면 읽지 않는다.
- **곡 식별**: MediaItem의 카탈로그 ID(보관함 곡은 `playParams.catalogId`)를 `serviceTrackId`로, ISRC도 검증해 넣는다. iOS와 같은 `service: 'apple-music'`·스토어 ID라 백업을 옮기면 같은 곡으로 연결된다. 노래가 아닌 항목(뮤직비디오·라디오)은 곡으로 보지 않는다.
- **여러 탭**: 가장 최근 재생 중이던 탭을 따르고 재생 명령도 그 탭으로 보낸다. 설치 전에 열린 탭은 패널이 열릴 때 `chrome.scripting`으로 스크립트를 넣는다(가드로 중복 실행 방지).
- **저장소**: sql.js 메모리 DB + **쓰기 끝날 때마다**(트랜잭션 밖 쓰기 또는 COMMIT) DB 파일 전체를 IndexedDB에 `durability: 'strict'`로 저장한 뒤 돌아간다 → "작업 in_flight 기록 → AI 요청" 순서가 디스크에서도 지켜진다(INV-7·INV-8). ROLLBACK이면 마지막 저장본 그대로. 마이그레이션 전에는 `main.bak-v<n>` 사본 1개. `unlimitedStorage` + `navigator.storage.persist()`로 브라우저 정리 대상에서 뺀다. Chrome·Edge·프로필마다 저장소가 따로다.
- **한 곳에서만 열기**: 사이드 패널과 따로 띄운 창은 같은 확장 프로그램 출처의 같은 IndexedDB를 쓰므로 Web Locks(`lyrics-companion-db`)로 하나만 연다(둘이 열리면 마지막 저장이 앞의 저장을 덮어쓸 수 있음). "따로 띄운 창으로 열기"는 창을 연 뒤 패널을 닫아 잠금을 넘긴다.
- **화면**(`src/ui`, React DOM): 지금 재생(가사·발음/번역 토글·곡별 보정·번역 요청·후보 확인·도구: 가사 바꾸기·번역 직접 입력·발음 고치기·원문 TXT·싱크 직접 기록(스페이스바·Enter로도 기록)·원래 싱크로), 대기열(iPhone 플레이리스트 탭 대신: 웹 플레이어의 현재 대기열, 곡 클릭 재생, 가사 원문 일괄 받기, 번역 묶음), 설정(전체 싱크 보정·제공자·키·자동 번역·백업). 파일은 다운로드 폴더로 내보내고 파일 선택 창으로 가져온다(downloads 권한 없음).
- **데모**: `npm run demo` — 가짜 재생기·합성 가사·메모리 저장소로 화면만 확인(네트워크 없음, 확장 프로그램에 포함되지 않음, `.tmp/pc-demo`).
- **빌드**: esbuild(IIFE, chrome116) → `dist/`. sql.js 브라우저 빌드를 복사(eval 없음, CSP `wasm-unsafe-eval`만 추가). 아이콘은 `build.mjs`가 직접 그린 PNG. 매니페스트 `key`로 확장 프로그램 ID 고정(`ggohabnpccimkbiclbehihpgiocjedhd`, 보안 저장소 도우미의 `allowed_origins`).
- 남은 것: 실제 Apple Music 웹 연동 확인(MV-PC-01), 보관함 플레이리스트 목록(웹 플레이어 대기열로 대신함), 확장 프로그램 패키징(.crx)·스토어 배포(배포 전 권리 검토, D-07).

## §15 Android 재생 앱 연동 (`apps/mobile` Android, Spotify·YouTube Music·Apple Music — 2026-10-14, D-41)
```
[Spotify · YouTube Music · Apple Music 앱] ── MediaSession ──▶ MediaSessionManager.getActiveSessions(알림 리스너 자격)
  modules/now-playing/android  MediaSessionsModule.kt (Expo 모듈 'AndroidMediaSessions')
    · 세 앱 세션만 남김 → MediaMetadata·PlaybackState·읽은 시각(elapsedRealtime) 원시 값
    · 변경 콜백(세션 목록·곡·상태·재생 목록) → 'onChange'(값 없이 "바뀜"만)
    · TransportControls(재생·일시정지·탐색·이전/다음·재생 목록 곡), 셔플(compat 사용자 지정 동작), 검색 재생
  LyricsNotificationListener.kt  알림 콜백은 비워 둠(알림 내용 미사용)
        │
  src/adapters/android-playback-source.ts  AndroidMediaPlayback(PlaybackSource + 제어 + 재생 목록 + 검색 재생)
        │ core: pickAndroidSession → mapAndroidSnapshot / mapAndroidQueue (playback/android-media-session.ts)
  usePlayback(PositionFilter, 0.5초 재조회) → NowPlayingSession   ← iPhone·PC와 같은 core
```
- **판단 로직은 iPhone 앱과 같은 core**. Android 전용 core 코드는 값 해석 `playback/android-media-session.ts` 하나(AT-23, unit/android-media-session).
- **재생 위치**: 앱은 위치를 매 순간 갱신하지 않으므로 PlaybackState 정의대로 `position + (읽은 시각 − 갱신 시각) × 속도`를 네이티브가 읽은 순간 기준으로 계산하고, 측정 시각은 JS가 응답 받은 시각(뒤처질 수는 있어도 앞서가지 않음, D-25). position -1·오래된 상태·곡 길이 초과는 위치 모름(불변조건 5).
- **곡 식별**: `service`는 앱으로 정한다(spotify / youtube-music / apple-music). 곡 ID는 Spotify·YouTube Music만, Android Apple Music은 메타데이터 지문(같은 서비스의 iPhone 스토어 ID와 섞이지 않게). 서비스가 다르면 같은 제목이어도 곡 변경으로 본다(`sameServiceTrack`). 다른 서비스의 같은 곡은 기존 후보 확인(§6 ③).
- **여러 앱**: 재생 중인 앱을 따르고, 둘 다 재생 중이면 지금 따르는 앱을 유지, 모두 멈추면 따르던 앱 유지. 제어·재생 목록·검색 재생은 따르는 앱으로 보낸다.
- **플레이리스트 탭**: `MediaController.getQueue()` → `mapAndroidQueue`(지금 재생과 같은 곡 정보 규칙) → iPhone "플레이리스트 안" 화면 모양(재생·셔플·곡부터 재생·`PlaylistLyricsBatchPanel`·`TranslationBundlePanel`). 일괄 작업 키는 `queue:<패키지>:<곡 수>:<해시>`.
- **검색 탭**: `ItunesCatalogClient.search`로 곡 정보를 찾고 고른 앱에 `playFromSearch`(세션이 지원하면 앱 전환 없음) 또는 `MEDIA_PLAY_FROM_SEARCH` 인텐트. 실제 재생된 곡은 다시 미디어 세션으로 식별한다.
- **권한·매니페스트**: 알림 리스너 서비스(`BIND_NOTIFICATION_LISTENER_SERVICE`), `<queries>` 세 앱. app.json `blockedPermissions`로 SYSTEM_ALERT_WINDOW·저장소·진동 제거. 보안 저장소는 expo-secure-store(Android Keystore, 자동 백업 제외 규칙).
- **빌드**: GitHub Actions `ci/android-apk.yml`(D-42) — prebuild → `assembleRelease` → APK 검사 → 아티팩트. 서명은 템플릿 디버그 키(덮어 설치 가능, 개인용).
