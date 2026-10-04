# 구현 계획·결정 사항·남은 작업

## 1. 단계별 계획
각 단계는 **완료 조건**을 모두 만족해야 끝난다. 모든 단계 공통 조건: `npm run check` 통과, 관련 요구사항 상태(`docs/requirements.json`) 갱신, `npm run trace:update`, 이 문서의 결정·남은 작업 갱신.

| 단계 | 내용 | 완료 조건 | 상태 |
|---|---|---|---|
| **Phase 0** 기반 | 요구사항·연동 조사·지침·core 최소 구현·검증 하네스·CI 설정 | AT-01~14 자동 통과, 뮤테이션 12/12 검출, 문서 작성 | **완료(2026-10-04)** — 단, Windows 실기 실행·CI 실제 실행은 미확인(§4) |
| **Phase 1** iOS 앱 골격 + Music 앱 연동 (2026-10-04 재배치, ADR-0002) | `apps/mobile` Expo 앱(Release 빌드), 어댑터(ExpoSqliteDriver·ExpoSecretStore·FetchHttpClient·SystemClock), Swift 모듈 `now-playing`(systemMusicPlayer 읽기·제어·`setQueue`), 곡 검색(iTunes Search·보관함), 가사 자동 조회(현지화 표기 대응·후보 확인, D-18), 자동 싱크(0.5초 재조회, D-19), 가사 화면, 설정(제공자·키·자동 번역 동의), GitHub Actions 무서명 IPA 빌드 | GitHub Actions에서 IPA 빌드 성공, Sideloadly로 iPhone 설치, MV-PB-IOS-01·02·03, MV-IOS-INSTALL-01 기록 | **진행 중** — 코드·문서 작성, 앱 타입 검사·JS 번들(Metro)·prebuild·자동링크 확인. **Swift 컴파일·실기기 미확인** |
| **Phase 2** 번역 실사용·동의 | 제공자 실제 호출(MV-AI-01), 실패·결과 미확인 UX 다듬기, Anthropic Messages 등 추가 어댑터 | MV-AI-01, MV-SEC-01 | 대기(AI 제공자 선택 필요) |
| **Phase 3** 가사 화면 완성 | 자동 스크롤·접근성 다듬기, 수동 싱크 보정 저장 UX, 위치 정확도 보정 | MV-UI-01·02 | 대기 |
| **Phase 4** 편집·판본 관리 | 사용자 번역 편집기, TXT/LRC 가져오기, 발음 수정, 원문 갱신, 내보내기/가져오기, 긴 가사 분할 번역 | REQ-ED-*, REQ-LY-04 | 대기 |
| **Phase 5** 유료 계정 전환(선택) | Apple Developer Program 가입 시 EAS Build·TestFlight로 전환(7일 재서명 해소) | 설치 1년 유지 | 사용자 결정 대기 |
| **Phase 6** Android(Apple Music 앱만) | Expo 모듈(Kotlin): NotificationListenerService + MediaSessionManager → PlaybackSource | MV-PB-AND-01·02, MV-PB-CTL-01 | 나중(사용자 결정 2026-10-04) |
| **Phase 7** 배포 준비 | 약관·권리 검토, 오버레이 검토, 개인정보 처리방침, 스토어 정책 | MV-LEGAL-01, MV-OVL-01, 보안 체크리스트(docs/security.md §10) | 대기 |

## 2. 첫 구현 대상과 근거 (Phase 0에서 한 일)
**core 도메인 로직 + 검증 하네스**를 먼저 만들었다.
- 이 프로젝트의 위험은 UI보다 **"언제 AI를 부르고 무엇을 저장·표시하느냐"**(중복 과금, 사용자 번역 덮어쓰기, 다른 녹음 혼동, 잘못된 싱크)에 있다. 이 부분은 실기기 없이도 완전히 검증할 수 있다.
- 사용자 PC(Windows)에서 Node만으로 실행 가능하고, 실제 계정·키·유료 호출이 필요 없다.
- 앱 계층은 포트만 구현하면 되므로, Android·iOS 연동 결과(실기기 확인)에 따라 core를 바꾸지 않아도 된다.

## 3. 결정 사항
| ID | 결정 | 근거 | 되돌리는 조건 |
|---|---|---|---|
| D-01 | 앱은 React Native + Expo(개발 빌드) + TypeScript, core는 의존성 없는 TS 패키지 | [ADR-0001](decisions/ADR-0001-tech-stack.md) | 네이티브 연동 비중이 압도적으로 커지면 KMP/네이티브 재검토 |
| D-02 | 저장소는 SQLite, 테스트도 실제 SQLite(node:sqlite)로 같은 SQL 실행 | 원자적 저장·마이그레이션을 실제로 검증 | expo-sqlite와 동작 차이 발견 시 어댑터 계약 테스트 추가 |
| D-03 | ~~Android 먼저~~ → **iPhone 먼저**(2026-10-04 사용자 결정: 주 사용 기기 iPhone, Mac 없음, 유료 개발자 계정 보류, Android는 나중) | [ADR-0002](decisions/ADR-0002-ios-without-mac.md) | 사용자 결정 변경 |
| D-04 | (D-17로 대체: Spotify 지원 안 함) Spotify 공식 SDK/Web API로 가사 싱크하지 않음. Android는 OS MediaSession, iOS Spotify는 수동 흐름 | Spotify Developer Policy의 싱크 금지·AI 입력 금지 조항, 2026-02 개발 모드 제한 | Spotify의 서면 허가 또는 정책 변경 |
| D-05 | 발음 = 한글 독음. AI는 발음 기준 히라가나를 만들고, 한글 변환은 앱 규칙 | 가정 A-1~A-3, 검증 가능성 | 사용자가 로마자 등 다른 표기를 원하면 표기 옵션 추가(번역 재생성 없이 가나에서 재변환) |
| D-06 | 자동 번역 기본 꺼짐, 일일 30회 상한, 자동 재시도 없음 | 비용·동의 요구사항, 중복 과금 경계 | 사용자 설정으로 변경 가능 |
| D-07 | 개인 사용 목적으로만 개발·검증, 배포는 권리 검토 후 | LRCLIB 가사 권리·번역물 권리·서비스 약관 미확인 | MV-LEGAL-01 결론 |
| D-08 | 개발자 공용 키 없음. 공용 키가 필요한 기능(Apple Music API 개발자 토큰 등)은 서버 구조로 별도 설계 | 보안 요구사항 | — |
| D-09 | TypeScript 6.0.x 고정 | typescript-eslint 8.71이 TS <6.1만 지원 | 린트 도구가 TS 7 지원 시 |
| D-10 | 문서·하네스·데이터를 모두 `E:\ai data\노래가사앱(로컬)` 아래에 둠: 문서 `docs/`, 합성 데이터 `fixtures/`, 실행 결과 `reports/`, 임시 `.tmp/`, 개인 실제 데이터 `local-data/`(git 제외) | 사용자 요청 | — |
| D-11 | 화면은 Apple Music 경험을 참고한 자체 디자인, Apple 자산 미사용 | 요구사항 | — |
| D-12 | iOS 빌드: GitHub Actions `macos-26` 러너에서 무서명 Release IPA → Windows Sideloadly + 무료 Apple ID로 서명·설치 | ADR-0002 | 유료 계정 가입 시 EAS Build |
| D-13 | MusicKit 카탈로그 API를 쓰지 않음. 곡 검색은 iTunes Search API(키 불필요), 재생은 MediaPlayer `setQueue(with: storeIDs)` | 무료 서명에서 MusicKit App Service 불가, D-08 | 유료 계정 + 서버 토큰 구조 |
| D-14 | iTunes Search는 storefront `kr → jp → us` 순서로 시도 | `country=kr` 결과 0건(2026-10-04 확인) | MV-PB-IOS-03 결과 |
| D-17 | **Apple Music 전용**(2026-10-04 사용자 결정: "YouTube Music·Spotify는 포기, Apple Music 호환만"). 사용자는 Apple Music 구독 중. 수동 싱크·다른 앱 검색 UI 제거 | iOS에서 다른 앱 자동 싱크는 공개 API 없음·정책 위험 | 사용자 결정 변경 |
| D-18 | 가사 자동 조회 3단계: Music 앱 표기로 LRCLIB get → 스토어 ID로 jp·us·kr 표기 조회 후 get → 제목 검색(버전·제목·길이 ±2초 일치). 검색 결과는 **가수 표기가 알려진 표기와 같을 때만 자동 적용**, 아니면 후보를 사용자에게 보여 준다(불변조건 6) | 한국 Apple Music이 일본 곡 제목·가수를 현지화(예: マリーゴールド/あいみょん → Marigold/aimyon, 米津玄師 → 요네즈 켄시) — research §8 | 실기기 적중률(MV-PB-IOS-02) |
| D-19 | 재생 위치: 화면 표시 중 0.5초 재조회 + 측정 시각을 네이티브 호출 왕복의 중간값으로 보정 | 탐색 알림 없음 대비, 왕복 지연 보정 | 실기기 오차 측정 결과 |
| D-20 | 가사 줄을 탭하면 Music 앱을 그 줄 위치로 이동(원문 타임스탬프 − 보정값) | Apple Music 가사 화면과 같은 사용 경험 | — |
| D-15 | 앱(`apps/mobile`)은 루트 npm 워크스페이스에 넣지 않고 별도 패키지로 둔다(core는 `file:` 의존성 + Metro 설정으로 연결) | 루트 `npm ci`·`npm run check`가 React Native 설치 없이 Windows에서 가볍게 돌도록 | 워크스페이스 통합이 필요해지면 재검토 |
| D-16 | (D-17로 폐기, 수동 모드 코드 제거) iOS에서 Spotify·YouTube Music은 수동 모드: LRCLIB 검색 → 들리는 줄 탭 → 앱 시계로 진행, 화면에 "수동 싱크" 표시 | 공개 API 없음(platform-support §2.5), 진행을 꾸며내지 않는다는 불변조건 5 | — |

## 4. 아직 확인하지 못한 것
**실행·환경**
- 사용자 Windows PC에서 `npm ci && npm run check` 실제 실행: 미확인(이번 세션의 로컬 셸이 Windows 업데이트 문제로 폴더를 마운트하지 못함). 클라우드 Linux에서 공백·한글·괄호 경로 사본으로 실행해 통과함.
- GitHub Actions CI(Windows·한글 경로 잡 포함): 설정만 작성(`ci/github-actions-ci.yml` — 원격 도구로 `.github/`에 쓸 수 없어 별도 위치에 둠), 원격 저장소가 없어 실행하지 않음.
- Android Gradle의 한글 경로 문제: 커뮤니티 근거만 있음, Phase 1에서 확인.

**iOS 빌드·설치(2026-10-04 추가)**
- Swift 모듈(`apps/mobile/modules/now-playing/ios/NowPlayingModule.swift`) 컴파일: 미확인(클라우드는 Linux). GitHub Actions 첫 빌드에서 확인.
- 확인한 것: 앱 TypeScript 타입 검사 통과, `expo export --platform ios`(Metro로 core 포함 JS 번들 생성) 성공, `expo prebuild --platform ios` 성공(Info.plist 권한 문구 반영), 자동링크가 `NowPlaying` 모듈을 찾음.
- Sideloadly 무료 서명 설치·7일 재서명 후 데이터·Keychain 유지 여부: 미확인(MV-IOS-INSTALL-01).
- iTunes Search의 jp·us 스토어 ID로 한국 계정에서 `setQueue` 재생 가능 여부: 미확인(MV-PB-IOS-03).

**연동(실기기 0건)**
- 세 서비스 Android 앱이 MediaSession에 제공하는 실제 필드(MEDIA_ID 형식, 위치 갱신 빈도), 사이드로드 시 알림 접근 제한 여부.
- iOS `currentPlaybackTime` 정확도·탐색 반영 지연, 권한 문구 요구사항, MusicKit 사용 조건(유료 개발자 계정 범위).
- Spotify App Remote 백그라운드 연결 유지(정책상 보류 중이라 우선순위 낮음).

**보안·비용**
- 제공자별 중복 요청 방지 키·요청 조회 지원(현재 없다고 가정).
- expo-secure-store의 실제 백업 제외 동작, iOS Keychain 잔존 처리.

**권리·약관** — docs/platform-support.md §5 전체.

## 5. 사용자에게 확인이 필요한 사항
1. ~~주 사용 기기~~ → **답변(2026-10-04)**: iPhone, Mac 없음, 유료 개발자 계정은 우선 무료로 시도, Android는 나중.
2. 사용할 AI 제공자(첫 실제 어댑터 우선순위). 현재 앱은 OpenAI 호환 방식만 지원.
3. 배포 의도(개인 사용 vs 공개 배포) — 권리 검토 범위가 달라진다.
4. GitHub 저장소 공개/비공개 — 비공개면 macOS 빌드 사용량·과금 확인 필요(docs/ios-install.md §1).
