# 운영체제·스트리밍 서비스별 연동 지원 근거

- 확인 날짜: **2026-10-04** (원자료: [`research/2026-10-04-integration-research.md`](research/2026-10-04-integration-research.md))
- 상태 표기
  - **문서 확인**: 공식 문서 본문으로 확인
  - **문서 일부**: 공식 문서로 일부만 확인, 나머지는 추정
  - **미확인**: 근거 부족, 실기기 확인 필요
  - **실기기 확인**: 실제 기기에서 확인(현재 0건)
- 원칙: 모든 OS·서비스에서 같은 방식으로 현재 곡과 재생 위치를 읽을 수 있다고 가정하지 않는다. 자동 연동이 안 되면 **수동 흐름**(곡 검색·선택 + 수동 싱크)으로 동작해야 한다.

> **범위(2026-10-04, docs/plan.md D-17): Apple Music 전용.** 아래 Spotify·YouTube Music 행은 조사 기록으로만 남긴다(지원 안 함).

## 1. 요약 매트릭스

| 조합 | 현재 곡 정보 | 재생 위치·상태·곡 변경 | 재생 제어 | 방식 | 근거 상태 | 실기기 |
|---|---|---|---|---|---|---|
| Android × Apple Music | 제목·아티스트·앨범·길이 기대, 서비스 곡 ID는 앱 정의(없을 수 있음), ISRC 없음 | 위치·속도·마지막 갱신 시각·상태, 세션 변경 콜백 | 세션이 허용한 명령(`getActions`) | OS MediaSession + 알림 리스너 권한 | 문서 확인(OS API) / 앱별 제공 필드는 미확인 | 미확인 |
| Android × Spotify | 위와 같음 | 위와 같음 | 위와 같음 | OS MediaSession(권장). Spotify SDK는 정책 위험으로 보류 | 문서 확인(OS API) / 정책 검토 필요 | 미확인 |
| Android × YouTube Music | 위와 같음 | 위와 같음 | 위와 같음 | OS MediaSession | 문서 확인(OS API) / 앱 동작 미확인 | 미확인 |
| iOS × Apple Music | `nowPlayingItem`(제목·아티스트·앨범·길이·스토어 ID) | `playbackState`, 곡 변경 알림, `currentPlaybackTime` 조회 | 재생·일시정지·다음/이전·대기열 설정(우리 앱에서 곡 선택 가능) | MediaPlayer `systemMusicPlayer` / MusicKit `SystemMusicPlayer` | 문서 일부 | 미확인 |
| iOS × Spotify | 공개 OS API 없음. Spotify iOS SDK(App Remote)로 가능하나 **정책상 싱크 금지 위험** | 같음 | 같음 | **수동 흐름 기본**, SDK는 권리 검토 후 결정 | 문서 확인(정책) | 미확인 |
| iOS × YouTube Music | 공개 API 없음 | 없음 | 없음 | **수동 흐름만** | 미확인(공식 API 부재) | 미확인 |

## 2. 조합별 상세

### 2.1 Android 공통 (MediaSession)
- **API**: `MediaSessionManager.getActiveSessions(listenerComponent)`, `addOnActiveSessionsChangedListener`, `MediaController.getMetadata()`, `getPlaybackState()`, `registerCallback()`.
  문서: https://developer.android.com/reference/android/media/session/MediaSessionManager , https://developer.android.com/reference/android/media/session/PlaybackState (페이지 갱신 2026-08-03)
- **권한·조건**: `MEDIA_CONTENT_CONTROL`은 시스템 권한이라 일반 앱은 불가 → **알림 리스너 서비스(NotificationListenerService) 등록 + 사용자가 설정에서 "알림 접근" 허용**. Android 13+ 사이드로드 앱은 "제한된 설정 허용"이 추가로 필요할 수 있음(실기기 확인 MV-PB-AND-01).
- **재생 위치**: `PlaybackState.getPosition()` + `getLastPositionUpdateTime()`(elapsedRealtime) + `getPlaybackSpeed()` → 앱이 현재 위치를 계산. `PLAYBACK_POSITION_UNKNOWN(-1)`이면 위치 모름으로 처리(core `positionMs = null`).
- **곡 식별**: 제목·아티스트·앨범·길이는 대부분 제공할 것으로 예상, `MEDIA_ID`는 앱마다 형식이 다르고 없을 수 있음, ISRC는 표준 키가 없음 → core는 서비스 ID가 없으면 메타데이터 지문을 쓰고, 다른 서비스와는 후보 확인을 거친다.
- **백그라운드·화면 잠금**: 알림 리스너 서비스는 시스템이 바인딩해 백그라운드에서 콜백을 받을 수 있음[지식]. 우리 앱 화면이 꺼져 있을 때는 가사를 그릴 필요가 없으므로, 복귀 시 현재 상태를 다시 조회하는 것을 기본으로 한다. 제조사별 배터리 최적화로 서비스가 끊길 수 있음(MV-PB-AND-02).
- **호출 제한**: OS API라 서비스 호출 제한 없음. 콜백 기반으로 처리하고 폴링은 화면 표시 중에만 최소화.
- **개인정보**: 알림 리스너는 모든 알림을 받을 수 있으므로 **알림 내용은 읽지도 저장하지도 않는다**(docs/security.md §3).

### 2.2 Android × Spotify 추가 사항
- Spotify Android SDK(App Remote)와 Web API는 Spotify Developer Terms/Policy 적용 대상. 정책에 "Do not synchronize any sound recordings with any visual media", 엔드포인트 문서에 "Do not synchronize Spotify content" 문구가 있음 → **가사 싱크 목적의 Spotify Platform 사용은 보류**.
  문서: https://developer.spotify.com/policy (2025-05-15 시행), https://developer.spotify.com/documentation/web-api/reference/get-the-users-currently-playing-track
- 2026-02 개발 모드 변경: 소유자 Premium 필수, 사용자 5명 제한 → 일반 배포에는 확장 할당 심사가 필요. https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide
- OS MediaSession 경로는 Spotify Platform을 쓰지 않지만, 서비스 이용약관 측면은 **권리 검토 대상(MV-LEGAL-01)**.

### 2.3 Android × Apple Music 추가 사항
- MusicKit for Android(https://developer.apple.com/musickit/)는 우리 앱 안에서 Apple Music을 재생하는 라이브러리. "Apple Music 앱이 재생 중인 곡을 읽는" 용도가 아니므로 기본 경로는 MediaSession.
- 우리 앱에서 곡 선택·재생까지 하려면(원래 프로젝트 목표의 "Apple Music을 다시 켜지 않아도 되는" 경험) MusicKit for Android 재생 + 개발자 토큰(서버 서명 필요)이 필요 → Phase 6 이후 별도 검토.

### 2.4 iOS × Apple Music
- **API**: `MPMusicPlayerController.systemMusicPlayer`(iOS 3+), MusicKit `SystemMusicPlayer`(iOS 15+). Music 앱의 Now Playing 항목·재생 상태를 공유하고 제어. https://developer.apple.com/documentation/mediaplayer/mpmusicplayercontroller , https://developer.apple.com/documentation/musickit/systemmusicplayer
- **권한**: 미디어 라이브러리/Apple Music 접근 동의(Info.plist 사용 설명 문구) [지식, MV-PB-IOS-01에서 확인]. 카탈로그 검색(Apple Music API)은 개발자 토큰 필요 → Apple Developer Program 가입 필요로 판단.
- **재생 위치**: `currentPlaybackTime` 조회. 탐색(seek) 알림이 따로 없을 가능성 → 화면 표시 중 주기적 재조회(예: 1초)로 보정 [미확인].
- **곡 선택·제어**: `setQueue(with: storeIDs)`, `play/pause`, `skipToNextItem` 등 → 원래 목표인 "앱 안에서 곡 선택·청취 구간 조절"이 **iOS Apple Music 조합에서는 가능할 것으로 보임**.
- **백그라운드**: 우리 앱은 백그라운드에서 오디오를 재생하지 않으므로 계속 실행되지 않는다. 복귀 시 현재 상태를 다시 읽는다(core: 오래된 측정값이면 위치 미확정).
- **제약**: 홈 공유 곡은 `nowPlayingItem`이 nil. 메인 스레드에서만 사용.

### 2.6 iOS 앱 안 곡 선택 (유료 개발자 계정 없이) — 2026-10-04 확인
- 검색: iTunes Search API `https://itunes.apple.com/search?term=…&country=…&entity=song` (키 불필요). 클라우드에서 직접 호출해 확인: `country=kr` 결과 0건, `country=jp` 결과 있음, 응답 `Content-Type: text/javascript`. → 앱은 `kr → jp → us` 순서로 시도(core `ItunesCatalogClient`).
- 재생: `MPMusicPlayerController.systemMusicPlayer.setQueue(with: [storeID])` → `prepareToPlay` → `play`. 다른 storefront의 스토어 ID가 한국 계정에서 재생되는지 **미확인(MV-PB-IOS-03)**. 실패 시 앱은 오류를 보여 주고 보관함 검색을 안내한다.
- 보관함: `MPMediaQuery.songs()` + 제목 포함 검색 → `setQueue(with: MPMediaItemCollection)`.
- 이용 조건: iTunes Search API는 Apple의 홍보·제휴 목적 API다. 개인 사용 범위에서만 쓰고 배포 전 권리 검토 대상(§5).

### 2.7 한국 Apple Music의 현지화 표기와 가사 조회 — 2026-10-04 확인
같은 스토어 ID를 storefront별로 iTunes Lookup 하면 제목·가수 표기가 다르다(길이는 같음). Music 앱도 한국 계정에서는 현지화 표기를 줄 것으로 예상(실기기 확인 MV-PB-IOS-02).

| 곡(jp 표기) | kr 표기 | us 표기 |
|---|---|---|
| Lemon / 米津玄師 | Lemon / 요네즈 켄시 | Lemon / Kenshi Yonezu |
| マリーゴールド / あいみょん | Marigold / aimyon | Marigold / Aimyon |
| Pretender / Official髭男dism | Pretender / OFFICIAL HIGE DANDISM | 같음(kr) |
| First Love / 宇多田ヒカル | First Love / 우타다 히카루 | First Love / Hikaru Utada |

- iTunes Search는 `country=kr`에서 0건이지만, **Lookup(`/lookup?id=…&country=kr`)은 결과가 있다** → 검색으로 얻은 jp 스토어 ID가 한국 스토어에도 있다는 근거(재생 가능 여부는 MV-PB-IOS-03).
- LRCLIB `/api/get` 적중은 표기마다 다르다(예: Marigold/aimyon 적중, マリーゴールド/あいみょん 미적중; Lemon은 요네즈 켄시·米津玄師 모두 적중). → 여러 표기로 차례로 조회(core `AppleMusicLyricsProvider`, D-18).

### 2.5 iOS × Spotify / YouTube Music (지원 안 함, D-17)
- 다른 앱의 재생 정보를 읽는 공개 OS API가 없음(`MPNowPlayingInfoCenter`는 자기 앱 정보 게시용). 비공개 프레임워크는 사용하지 않는다.
- Spotify iOS SDK(App Remote)는 기술적으로 가능하나 위 정책 문제 + 일시정지 후 연결 끊김 보고 → **기본은 수동 흐름**.
- YouTube Music: 공식 API 없음 → **수동 흐름만**.

## 3. 대체 흐름(자동 연동 불가·권한 거부)
1. 사용자가 곡을 검색(제목/아티스트) → LRCLIB 검색 결과 또는 저장된 곡 목록에서 선택.
2. 저장된 곡과 같을 수 있으면 후보를 보여주고 사용자가 확인(core `needs-confirmation`).
3. 재생 위치를 모르므로 **정적 가사 화면**으로 시작. 사용자가 "지금 이 줄" 탭으로 위치를 맞추면 그때부터 앱 내부 시계로 진행(수동 싱크, Phase 4). 이때 화면에 "수동 싱크" 표시를 해 실제 재생과 연동된 것처럼 보이지 않게 한다.
4. 곡별 보정값을 저장해 다음 재생에 재사용.

## 4. 오버레이(다른 앱 위 표시) — 별도 기능
- 기본 화면은 **우리 앱 안의 가사 화면**이다.
- Android: `SYSTEM_ALERT_WINDOW`(사용자가 "다른 앱 위에 표시" 허용) + `TYPE_APPLICATION_OVERLAY`로 기술적으로 가능 [지식]. Google Play 정책·사용자 신뢰 측면 검토 필요 → MV-OVL-01 후 결정.
- iOS: 다른 앱 위에 임의의 창을 띄우는 공개 API 없음. PiP·Live Activities 활용은 심사·갱신 빈도 제약이 있어 별도 조사 대상.

## 5. 약관·권리 확인 대상 (MV-LEGAL-01)
API를 쓸 수 있다는 것과 배포·표시 권리가 있다는 것은 다르다. 다음은 **확인되지 않은 상태**다.

| 대상 | 확인할 내용 | 현재 상태 |
|---|---|---|
| LRCLIB 가사 | 가사 텍스트의 저작권은 권리자에게 있음. LRCLIB 문서에 이용 조건 명시 없음. 앱 배포 시 가사 표시·기기 저장 허용 범위 | 미확인 |
| AI 번역 | 가사 번역물은 2차적 저작물 가능성. 사용자 기기 내 개인 이용과 공유·배포의 차이. AI 제공자 약관(입력 데이터 사용, 출력 권리) | 미확인 |
| Spotify | Developer Policy(싱크 금지·타 서비스 콘텐츠 통합 금지·AI 입력 금지), 사용자 약관 | 위험 확인, 해석 미확인 |
| Apple Music / MusicKit | Apple Developer Program 약관, Apple Music 식별 자산(로고·명칭) 사용 지침 | 미확인 |
| YouTube Music | 서비스 약관 | 미확인 |
| 앱 스토어 | 알림 리스너·오버레이 권한 사용 정책(Google Play), App Review 지침 | 미확인 |
| iTunes Search API | 홍보·제휴 목적 API의 이용 조건, 호출 제한(약 분당 20회로 알려짐, 미확인) | 미확인 |
| Sideloadly(무료 서명) | 제3자 도구에 Apple ID 로그인 필요, Apple 계정 약관상 개인 개발용 서명 범위 | 미확인 |

**현재 결정**: 개인 사용 목적의 개발·검증까지만 진행한다. 다른 사람에게 배포하기 전에 위 항목을 검토한다(docs/plan.md D-07).

## 6. 개발 환경 제약
- 사용자 PC는 Windows, **Mac 없음**. iOS 빌드에는 macOS + Xcode가 필요(Expo SDK 57, Xcode 26.4+) → **GitHub Actions `macos-26` 러너**(2026-07 이미지 기준 Xcode 26.6 기본)에서 무서명 IPA를 만들고, Windows의 Sideloadly가 무료 Apple ID로 서명·설치한다([ADR-0002](decisions/ADR-0002-ios-without-mac.md), [설치 안내](ios-install.md)).
- 무료 Apple ID 서명 제약: 7일 유효, 동시 설치 3개, MusicKit App Service 등 일부 기능(App ID 서비스) 사용 불가 → MusicKit 카탈로그 API 대신 iTunes Search API + MediaPlayer 사용(§2.6).
- Android Gradle 빌드는 **비ASCII 경로**(예: `노래가사앱(로컬)`)에서 문제가 날 수 있음 → ASCII 가상 드라이브로 빌드 권장: `subst L: "E:\ai data\노래가사앱(로컬)"` 후 `L:\`에서 빌드. (core 검사 `npm run check`는 한글 경로에서 동작하도록 만들었음)
