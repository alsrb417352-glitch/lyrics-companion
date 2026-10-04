# 연동 타당성 조사 기록 (2026-10-04)

조사자: Claude (Cowork 세션) · 방법: 공식 문서를 브라우저로 직접 열람, 일부는 웹 검색 결과로 존재만 확인
이 문서는 **원자료 기록**이다. 결론과 지원 매트릭스는 [`../platform-support.md`](../platform-support.md)에 정리한다.

표기: **[열람]** 공식 문서 본문을 직접 읽음 · **[검색]** 검색 결과로 존재만 확인(본문 미열람) · **[지식]** 기존 지식, 이번에 확인하지 않음

## 1. LRCLIB — https://lrclib.net/docs [열람]

- API 키 불필요, 익명 사용 가능. 선택적으로 앱 등록(`Lrclib-App-Id` 헤더) 가능하나 아직 강제하지 않음.
- **클라이언트 식별 필수**: `User-Agent`에 앱 이름·버전·홈페이지(또는 이메일). 설정 불가하면 `X-User-Agent` 또는 `Lrclib-Client`.
- **호출 제한**: 초과 시 `429` + `Retry-After`(초). 반드시 지킬 것, 무시하면 일시 차단 가능. 제한은 네트워크 엣지에서 적용되어 **429 본문은 JSON이 아닐 수 있음** → 상태 코드·헤더만 신뢰.
- **요청 조절 권장**: 요청을 순차로 보내고 요청 사이 200–500ms 지연.
- 오류 형식: `{message, name, statusCode}`. 400 `ValidationError`, 404 `TrackNotFound`, 429, 500 `UnknownError`, 503 `ServerOverloaded`(Retry-After, 보통 1초). 쿼리 형식 오류는 **일반 텍스트** 응답 → Content-Type 확인 필요.
- `GET /api/get?track_name&artist_name[&album_name][&duration]`: 최적 일치 1건. **duration이 DB 값과 ±2초 이내일 때만 반환**. 없으면 404(이후 백그라운드 수집으로 생길 수 있음). duration 범위 1–3600.
- `GET /api/get/{id}`, `GET /api/search?q|track_name[&artist_name][&album_name]`: 최대 20건, 페이지 없음.
- 레코드 필드: `id, name, trackName, artistName, albumName, duration(초), instrumental, hasWordSync, plainLyrics|null, syncedLyrics|null, lyricsfile(YAML)`.
- `hasWordSync`: lyricsfile에 단어 단위 타이밍이 있을 때 true. 우리 앱은 현재 행 단위만 표시.
- 게시(`POST /api/publish`, `/api/flag`)는 작업증명 토큰 필요 — 이번 범위에서는 사용하지 않음.
- **문서에 가사 저작권·라이선스·배포 권리에 대한 언급 없음** → 권리 검토 대상으로 남김.
- 참고: 과거 문서의 `/api/get-cached`는 현재 문서에 없음 → 사용하지 않음.

## 2. Android

### MediaSessionManager — https://developer.android.com/reference/android/media/session/MediaSessionManager [열람, 페이지 최종 갱신 2026-08-03]
- `getActiveSessions(ComponentName)`: 모든 활성 세션의 `MediaController` 목록(우선순위 순). `MEDIA_CONTENT_CONTROL`(시스템 권한) **또는** 사용자가 활성화한 **알림 리스너**의 ComponentName 필요.
- `addOnActiveSessionsChangedListener(...)`: 같은 조건으로 세션 목록 변경 감지.
- API 37: `getActiveSessionsForPackage` 추가, MediaSession2 관련 API 폐기.

### PlaybackState — https://developer.android.com/reference/android/media/session/PlaybackState [열람, 2026-08-03]
- `getPosition()`(ms), `getLastPositionUpdateTime()`(elapsedRealtime, 미설정 시 0), `getPlaybackSpeed()`(일시정지 0, 되감기 음수), `getState()`(PLAYING/PAUSED/BUFFERING/…), `PLAYBACK_POSITION_UNKNOWN = -1`.
- `getActions()`: 세션이 지원하는 명령(재생·일시정지·탐색·다음·이전) 비트마스크 → 재생 제어 가능 여부를 앱별로 판단.
- → 현재 위치 = position + (now − lastPositionUpdateTime) × speed 로 계산 가능. 우리 core `estimatePositionMs`와 같은 모델.

### 제한된 설정(Restricted settings) — https://support.google.com/android/answer/12623953 [열람(요약)]
- Android 13+: 일부 민감 설정은 사용자가 앱 정보 > 더보기 > "제한된 설정 허용"을 해야 변경 가능. 문서 예시는 접근성.
- 알림 리스너 접근도 사이드로드 앱에서 제한될 수 있다는 보도는 있으나[검색: androidauthority, 9to5google] **공식 문서로 범위를 확인하지 못함** → 실기기 확인 대상(MV-PB-AND-01).

### 기타 [지식]
- MediaMetadata 키: TITLE, ARTIST, ALBUM, DURATION, MEDIA_ID(앱별 형식, 없을 수 있음). ISRC 키는 표준에 없음.
- 알림 리스너 서비스는 알림 내용 전체에 접근 가능 → 우리 앱은 미디어 세션 조회 용도로만 사용하고 알림 내용은 읽지·저장하지 않는다(보안 정책).
- 다른 앱 위 표시: `SYSTEM_ALERT_WINDOW` + `TYPE_APPLICATION_OVERLAY`, 사용자가 설정에서 허용 [지식, 이번에 본문 미열람].

## 3. iOS / Apple Music

### MPMusicPlayerController — https://developer.apple.com/documentation/mediaplayer/mpmusicplayercontroller [열람]
- `systemMusicPlayer`: **Music 앱 상태를 공유·제어**. `nowPlayingItem`, `playbackState`, 반복·셔플 공유. 재생 알림 생성(`beginGeneratingPlaybackNotifications`).
- 재생 제어: `skipToNextItem`, `skipToPreviousItem`, `skipToBeginning`, `setQueue(with: [storeIDs])` 등 → **우리 앱 안에서 곡 선택·재생 제어 가능**(Apple Music 한정).
- 홈 공유 곡은 `nowPlayingItem`이 nil일 수 있음. 메인 스레드에서만 사용.
- MPMediaPlayback 프로토콜 준수 → `currentPlaybackTime` [지식: 탐색 알림이 없어 주기적 조회 필요할 가능성, 실기기 확인 대상].

### MusicKit SystemMusicPlayer — https://developer.apple.com/documentation/musickit/systemmusicplayer [열람]
- iOS 15+. Music 앱 상태 제어(대기열, 재생 상태). 앱이 백그라운드로 가도 음악은 계속 재생.

### MusicKit 개요 — https://developer.apple.com/musickit/ [열람]
- Apple Music API: 카탈로그 검색, 사용자 권한으로 라이브러리 접근. 개발자 토큰은 Certificates, Identifiers & Profiles에서 키를 만들어 서명 → **Apple Developer Program 가입 필요로 판단(가입 조건 세부는 미확인)**.
- **MusicKit for Android**: 인증·재생 라이브러리 제공(우리 앱 안에서 재생). 다른 앱(Apple Music 앱)의 재생 상태를 읽는 기능은 아님.

### 다른 앱의 재생 정보 [검색]
- `MPNowPlayingInfoCenter`는 **자기 앱의** 재생 정보를 시스템에 게시하는 용도. 다른 앱(Spotify·YouTube Music)의 재생 정보를 읽는 공개 API는 확인되지 않음(개발자 포럼 다수 답변). 비공개 MediaRemote 프레임워크 사용은 App Store 심사 위반 위험 → 사용하지 않음.

## 4. Spotify

### iOS SDK — https://developer.spotify.com/documentation/ios [열람]
- Spotify 앱과 통신(App Remote): 재생 제어, 플레이어 상태 구독. 사용자의 원격 제어 권한 필요. Spotify 앱 설치 필수(실기기 필요). 사용 시 Developer Terms 동의.
- 커뮤니티: 일시정지 후 일정 시간이 지나면 연결이 끊긴다는 보고[검색: community.spotify.com] → 백그라운드 지속 연결은 기대하기 어려움(실기기 확인 대상).

### Web API Get Currently Playing — https://developer.spotify.com/documentation/web-api/reference/get-the-users-currently-playing-track [열람]
- `GET /me/player/currently-playing`, scope `user-read-currently-playing`. `progress_ms`, `is_playing`, `timestamp`, `item`. 응답 401/403/429.
- **페이지의 정책 주의 문구: "Do not synchronize Spotify content"**, "Streaming applications may not be commercial".

### 2026년 2월 개발 모드 변경 — https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide [열람]
- 개발 모드 앱: **소유자 Spotify Premium 필수**, 신규 앱 **사용자 5명** 제한(2026-07 클라이언트 ID 한도 25로 상향). 일부 엔드포인트 제거·필드 제거. 확장 할당(Extended Quota)은 별도 심사.

### Developer Policy (2025-05-15 시행) — https://developer.spotify.com/policy [열람]
우리 앱과 충돌 가능성이 있는 조항(법률 판단 아님, 검토 필요):
- "Do not synchronize any sound recordings with any visual media"
- "Do not create any product or service which is integrated with streams or content from another service."
- "Do not use the Spotify Platform or any Spotify Content to train ... or otherwise ingest Spotify Content into a machine learning or AI model." → Spotify에서 받은 메타데이터를 AI 프롬프트에 넣지 않는 설계 필요.
- 핵심 사용자 경험(Spotify 자체 가사 기능)을 모방·대체하는 제품 금지 조항.
→ **Spotify 공식 SDK/Web API로 재생 위치를 받아 가사를 싱크하는 방식은 정책 위반 위험이 높다고 판단.** Android에서는 OS의 MediaSession(Spotify Platform 아님)으로 접근 가능하나, Spotify 사용자 약관 측면은 별도 검토.

## 5. YouTube Music [검색]
- 재생 상태를 제공하는 공식 공개 API·SDK를 찾지 못함(검색 결과는 비공식 라이브러리 위주). YouTube Data API는 재생 상태를 제공하지 않음[지식].
- Android: MediaSession으로 접근 가능할 것으로 예상(실기기 확인 대상). iOS: 자동 연동 수단 없음.

## 6. AI 제공자 중복 요청 방지 [검색]
- OpenAI·Anthropic 공식 문서에서 **범용 Idempotency-Key 지원을 확인하지 못함**(2026-10-04 검색 기준, 커뮤니티 토론만 확인). → 지원하지 않는다고 가정하고 설계(작업 상태 저장 + 결과 미확인 시 자동 재요청 금지). 제공자별 확인은 MV-AI-01에서 수행.

## 7. 개발 도구
- Expo SDK 56 (2026-05-21): React Native 0.85, 최소 Node 20.19.4, iOS 최소 16.4, Xcode 26.4 이상 [열람: https://expo.dev/changelog/sdk-56.md 요약].
- expo-secure-store: Android Keystore로 암호화해 SharedPreferences 저장(Auto Backup 제외 처리), iOS Keychain. iOS는 재설치 후에도 남을 수 있음, 일부 iOS에서 약 2KB 초과 값 거부 이력 [열람: https://docs.expo.dev/versions/latest/sdk/securestore/].
- Android Gradle Plugin은 **비ASCII 문자가 들어간 프로젝트 경로**에서 빌드 경고/실패를 낼 수 있음(`android.overridePathCheck=true` 우회) [검색: discuss.gradle.org 등, 공식 문서 미확인] → Windows 빌드 시 ASCII 경로(가상 드라이브) 사용 권장.
- typescript-eslint 8.71은 TypeScript `<6.1`만 지원 → TypeScript 6.0.x 고정(TypeScript 7 네이티브 버전은 린트 도구 호환 후 검토).

## 8. 한국 Apple Music 표기와 LRCLIB 적중 (2026-10-04, 클라우드에서 직접 호출) [열람]
- iTunes Search(`country=jp`)로 스토어 ID를 얻고, 같은 ID를 `/lookup?id=…&country=jp|kr|us`로 조회:
  - 1490256995: jp/kr 모두 夜に駆ける / YOASOBI
  - Lemon: jp 米津玄師, kr 요네즈 켄시, us Kenshi Yonezu (길이 256116ms 동일)
  - マリーゴールド/あいみょん: kr·us Marigold / aimyon(Aimyon) (308107ms 동일)
  - Pretender/Official髭男dism: kr·us OFFICIAL HIGE DANDISM
  - First Love/宇多田ヒカル: kr 우타다 히카루, us Hikaru Utada
- `country=kr` Search는 0건이지만 Lookup은 결과 반환.
- LRCLIB `/api/get`(duration 지정) 결과: Marigold/aimyon 적중, マリーゴールド/あいみょん 404, Lemon/요네즈 켄시·Lemon/米津玄師 적중(서로 다른 레코드), Pretender는 두 표기 모두 적중.
- 결론: Music 앱 표기 하나로는 놓치는 곡이 있다 → 여러 표기 순차 조회 + 제목 검색 후보(docs/plan.md D-18). 실제 Music 앱이 주는 표기는 실기기 확인 필요.
