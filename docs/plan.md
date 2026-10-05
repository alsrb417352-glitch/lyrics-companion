# 구현 계획·결정 사항·남은 작업

## 1. 단계별 계획
각 단계는 **완료 조건**을 모두 만족해야 끝난다. 모든 단계 공통 조건: `npm run check` 통과, 관련 요구사항 상태(`docs/requirements.json`) 갱신, `npm run trace:update`, 이 문서의 결정·남은 작업 갱신.

| 단계 | 내용 | 완료 조건 | 상태 |
|---|---|---|---|
| **Phase 0** 기반 | 요구사항·연동 조사·지침·core 최소 구현·검증 하네스·CI 설정 | AT-01~14 자동 통과, 뮤테이션 12/12 검출, 문서 작성 | **완료(2026-10-04)** — 단, Windows 실기 실행·CI 실제 실행은 미확인(§4) |
| **Phase 1** iOS 앱 골격 + Music 앱 연동 (2026-10-04 재배치, ADR-0002) | `apps/mobile` Expo 앱(Release 빌드), 어댑터(ExpoSqliteDriver·ExpoSecretStore·FetchHttpClient·SystemClock), Swift 모듈 `now-playing`(systemMusicPlayer 읽기·제어·`setQueue`), 곡 검색(iTunes Search·보관함), 가사 자동 조회(현지화 표기 대응·후보 확인, D-18), 자동 싱크(0.5초 재조회, D-19), 가사 화면, 설정(제공자·키·자동 번역 동의), GitHub Actions 무서명 IPA 빌드 | GitHub Actions에서 IPA 빌드 성공, Sideloadly로 iPhone 설치, MV-PB-IOS-01·02·03, MV-IOS-INSTALL-01 기록 | **진행 중** — GitHub Actions 첫 빌드 성공(2026-10-04, IPA 8.15MB; 당시 워크플로가 xcodebuild 실패를 가릴 수 있어 D-24로 수정, 다음 빌드에서 재확인). 사용자 PC에 Sideloadly·iTunes·iCloud(웹 버전)·GitHub Desktop 설치 확인(2026-10-05). **iPhone 설치·실기기 미확인** |
| **Phase 2** 번역 실사용·동의 | 제공자 실제 호출(MV-AI-01), 실패·결과 미확인 UX 다듬기, Anthropic Messages 등 추가 어댑터 | MV-AI-01, MV-SEC-01 | 대기(AI 제공자 선택 필요) |
| **Phase 3** 가사 화면 완성 | 자동 스크롤·접근성 다듬기, 수동 싱크 보정 저장 UX, 위치 정확도 보정 | MV-UI-01·02, MV-SY-01 | **일부 앞당김(2026-10-05)**: 수동 싱크 탭 기록(D-28, core 검증 AT-18, 뮤턴트 M23~M26). 실기기 미확인 |
| **Phase 4** 편집·판본 관리 | 사용자 번역 편집기, TXT/LRC 가져오기, 발음 수정, 원문 갱신, 내보내기/가져오기, 긴 가사 분할 번역 | REQ-ED-*, REQ-LY-04, REQ-ST-04, MV-ED-01, MV-ST-02 | **일부 앞당겨 진행(2026-10-05)** — AI 제공자 미정이라 Phase 2 대신 먼저: 번역 직접 입력·고치기, 붙여넣기(TXT·LRC), 발음 고치기, 백업 내보내기·가져오기(core 검증 AT-15·16, 뮤턴트 M16~M19). **2026-10-05 추가**: 원문 TXT 내보내기(D-29), 플레이리스트 가사 원문 일괄 받기(D-31, core 검증 AT-19, 뮤턴트 M27~M29). 남음: TXT/LRC **파일** 가져오기·행 수동 연결 화면, 곡별·전체 삭제, 긴 가사 분할 번역 |
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
| D-21 | 백업 가져오기는 **병합**: 같은 ID는 건너뜀(두 번 가져와도 같음), 기존 데이터 삭제·수정 없음. 스트리밍 곡 연결이 다른 곡을 가리키면 저장 번역 가치(사용자 2 > AI 1 > 없음)가 큰 쪽으로 연결, 같으면 기존 유지. 보정값은 새 곡에만. 표시·자동 번역 설정은 가져오지 않음 | 재설치 후 먼저 재생해 AI 번역이 생긴 경우에도 백업의 사용자 번역이 보여야 하고(불변조건 2·3), 어느 쪽 데이터도 잃지 않아야 함. 자동 번역 동의는 기기에서 다시 받아야 함(REQ-SEC-05) | 사용자가 "백업으로 덮어쓰기"를 원하면 별도 옵션 |
| D-22 | 번역 편집 화면은 **현재 보이는 번역(내 번역 또는 AI 번역)으로 칸을 채워 시작**, 저장하면 화면 내용 전체가 새 "내 번역" 버전 | 사용자 번역은 AI 번역보다 통째로 우선하므로(불변조건 2·3), 빈 칸으로 시작하면 한 줄만 고쳐도 나머지 줄 번역이 사라져 보인다. AI 결과를 사용자가 확인·채택하는 것은 명시 행동 | — |
| D-23 | 파일 선택은 `expo-file-system`의 `File.pickFileAsync`, 내보내기는 `expo-sharing` 공유 시트("파일에 저장"). `expo-document-picker`·공유 확장(share extension)·App Group·iCloud 권한은 쓰지 않음(`expo install`이 넣은 `expo-sharing` 설정 플러그인도 제거) | 무료 Apple ID 서명은 App Group·iCloud 권한·추가 번들 ID(확장)에 제약이 있음(ADR-0002). 필요한 기능은 위 두 모듈로 충분 | 유료 계정 전환 시 재검토 |
| D-24 | iOS 빌드 워크플로: xcodebuild 종료 코드를 그대로 실패로 처리(`\|\| true` 제거), `** BUILD SUCCEEDED **`·실행 파일·`main.jsbundle` 존재 검사 단계 추가, `upload-artifact@v6`(Node 24) | 이전 설정은 `grep ... \|\| true`가 파이프라인 전체 실패를 가려, 컴파일 실패 시에도 빈 `.app` 폴더로 IPA가 만들어질 수 있었음 | — |
| D-25 | **싱크 지연 줄이기**: ① 위치 측정 필터(core `PositionFilter`) — 최근 3초 측정 중 "위치 − 측정 시각"이 가장 큰(가장 덜 늦은) 것을 기준으로 삼음, 앞으로 0.7초 이상 튀면 즉시·뒤로는 연속 2회일 때만 탐색으로 인정. ② 측정 시각은 응답 받은 시각(중간값 대신) → 필터가 앞서가는 값을 고르지 않음. ③ 재조회 0.5초 → 0.25초, 위치만 바뀐 측정으로는 화면을 다시 그리지 않음. ④ 250ms 고정 주기 대신 다음 행 시작 시각에 맞춘 타이머(`nextChangeInMs`). ⑤ 가사 목록 불필요한 재렌더 제거. ⑥ Swift에서 재생 위치를 마지막에 읽음 | 사용자 보고(2026-10-05): "가사 싱크가 너무 느리다". systemMusicPlayer 위치는 다른 프로세스 값이라 읽을 때마다 늦은 정도가 다르고, 이전 방식은 늦은 값을 그대로 쓰고 최대 250ms 화면 갱신 지연이 더해졌음. 필터는 받은 측정값 중 하나에 근거하므로 진행을 꾸며내지 않음(불변조건 5, AT-17) | 실기기 측정(MV-PB-IOS-01) 결과 |
| D-26 | **전체 싱크 보정**(설정 › 가사 싱크, 모든 곡 공통, 0.05초 단위) 추가, 기본값 **+0.25초**(가사를 0.25초 먼저 넘김). 곡별 보정은 0.5초 → 0.1초 단위, 버튼 이름 "가사 늦게/빨리". 줄 탭 이동도 두 보정을 합쳐 계산 | LRC 시각은 노래 시작 순간이라 그때 바뀌면 읽기가 늦게 느껴짐(Apple Music 가사도 약간 먼저 넘어감). 원문 타임스탬프는 그대로 두는 표시용 보정 | 사용자가 설정에서 변경 |
| D-27 | OpenAI 추론 모델 지원: 제공자 설정에 **추론 강도**(보내지 않음/Low/Medium/High/Extra high = `reasoning_effort`) 추가. 강도를 정하면 `max_completion_tokens`(번역 한도 + 강도별 추론 여유분) + `reasoning_effort`로 보내고 `temperature`는 생략. 시간 초과는 강도별 60초~7분. 출력 한도에서 잘린 응답(`finish_reason: length`)은 과금 가능 실패(자동 재요청 없음) | 사용자 선택(2026-10-05): ChatGPT "Luna Extra high" → API 모델 `gpt-6-luna` + `xhigh`(OpenAI 모델 문서 확인). 추론 모델은 `max_tokens`·`temperature`를 받지 않음. 실제 호출은 미확인(MV-AI-01) | 실제 호출 결과 |
| D-28 | **수동 싱크 = 탭 기록**(2026-10-05 사용자 요청 "자동 싱크가 안 될 경우 수동 싱크"·방식 선택 "탭으로 싱크 기록"). 노래를 들으며 각 줄이 시작될 때 큰 버튼을 누르면 그 순간(onPressIn)의 Music 앱 재생 위치를 기록. 새 테이블 `user_timings`(스키마 v3, 추가 전용, `cleared`로 되돌리기)에 행 ID→ms로 저장하고 **가사 판본은 바꾸지 않음**. 싱크 계산은 `effectiveTiming`(기록 우선, 없으면 원문). 빈 행은 기록 대상 아님(다음 기록 행과 같은 시각), 일부만 기록하면 나머지 행은 +∞(강조 안 함). 저장 시 곡별 보정 0. 백업에 포함(`userTimings`, 이전 형식 허용, 판본 기준 검증). 불변조건 5를 "원문 타임스탬프 **또는 사용자가 직접 기록한 시간**"으로 확장(사용자 확인) | 새 가사 판본으로 저장하면 번역·발음이 이전 판본에 남아 사라져 보임(§7 규칙상 자동 연결 금지). 시간만 따로 두면 번역 연결이 유지되고 원래 시간으로 쉽게 되돌릴 수 있음. 사람이 들은 시간이라 AI 생성 금지 원칙과 충돌하지 않음. 반응 지연은 전체 싱크 보정(D-26)으로 보정 | 실기기 기록 정확도(MV-SY-01) |
| D-29 | **원문 TXT 내보내기**(2026-10-05 사용자 요청, 방식 선택 "원문 txt 내보내기"): 한 줄 = 한 행, 연 구분 빈 줄 하나로, 시간·번역·발음 없음, 제목은 파일 이름에만(본문에 넣으면 붙여넣기 행 수가 어긋남). 공유 시트로 내보냄(D-23과 같은 방식) | 바깥(ChatGPT 등)에서 번역 → "번역 직접 입력"에 붙여 넣으면 `previewTxtImport` 규칙(빈 행 제외 행 수 일치)으로 그대로 맞춰짐 | — |
| D-30 | **플레이리스트 탭**(2026-10-05 사용자 요청 "애플 뮤직 플레이리스트 가져오기", "앱에서 플레이리스트 재생 버튼 → 바로 듣기"): MediaPlayer `MPMediaQuery.playlists()`로 **보관함** 플레이리스트만(직접 만든 것 + 보관함에 추가한 Apple Music 플레이리스트). 재생은 `MPMusicPlayerMediaItemQueueDescriptor`(startItem) + `systemMusicPlayer.setQueue`/`prepareToPlay`/`play`, 셔플은 `shuffleMode`. 탭 순서: 지금 재생·플레이리스트·검색·설정 | MusicKit `MusicLibraryRequest`·카탈로그 API는 개발자 토큰(App ID의 MusicKit 서비스)이 필요해 무료 서명에서 못 씀(ADR-0002, D-13). systemMusicPlayer는 Music 앱이 백그라운드 재생하므로 앱 전환이 없음. 한계: 보관함에 추가하지 않은 플레이리스트는 안 보임, 셔플 설정은 Music 앱 설정을 바꿈 | 유료 계정 전환 시 MusicKit으로 확대 검토 |
| D-31 | **플레이리스트 가사 원문 일괄 받기**(2026-10-05 사용자 요청 "가사 원문 받기를 곡마다 하는 게 불편 → 플레이리스트 곡 일괄 받기"): 플레이리스트 화면에 버튼 하나. core `PlaylistLyricsBatch`가 곡마다 지금 재생과 **같은 곡 식별**(serviceKey → ISRC → 후보) → 저장본 있으면 건너뜀 → 없을 때만 `AppleMusicLyricsProvider` 조회 → 새 판본 저장(활성). **원문만, AI 호출 없음**(번역 서비스에 의존하지 않음). 저장된 다른 곡과 같은 녹음인지 불확실(후보)하면 곡을 만들지 않고 "확인 필요", 가사 후보만 있으면 "가사 선택 필요"로 남김(불변조건 6 — 재생할 때 지금 재생 화면에서 고름). 순차 처리(같은 LRCLIB 클라이언트라 요청 간격·Retry-After 공유), 429는 30초 이하면 기다렸다 같은 곡 1회 재시도·길면 멈춤, 오프라인이면 멈춤, 곡별 오류 3번 연속이면 멈춤, 취소는 다음 곡 전에. 다시 실행 = 저장된 곡 건너뛰므로 이어 받기. 앱 전체에서 실행기 하나(`services.playlistBatch`)라 다른 탭으로 옮겨도 계속, 실행 중에는 화면 꺼짐 방지(expo-keep-awake). 곡 목록에 ✓ 가사·확인 필요 표시 | 재생할 때마다 받으면 첫 재생에 가사가 늦게 뜨고 곡마다 기다려야 함. 미리 받아 두면 재생 즉시 표시(오프라인에서도). 번역까지 일괄로 하면 AI 비용이 곡 수만큼 한 번에 생기므로 원문만(번역은 재생할 때 기존 자동 번역 정책·동의대로). 보관함 곡 → `ServiceTrackRef` 변환을 `mapIosTrack`과 같은 값(스토어 ID·제목·가수·앨범·길이)으로 만들어 재생 시 같은 곡으로 찾음(테스트로 고정) | iOS는 백그라운드에서 JS를 멈추므로 앱을 켜 둬야 함(MV-LY-01에서 확인). 확인 필요 곡을 목록에서 바로 고르는 화면은 남은 작업 |
| D-32 | **아이콘 중심 UI 개편**(2026-10-05 사용자 요청 "글자 위주 → 재생·±10초는 이미지로, 보통 스트리밍 앱처럼"): `react-native-svg`(Expo SDK 57 호환 15.15.4, 자동 링크)로 **직접 그린** 아이콘 세트(`ui/icons.tsx`: 재생·일시정지·이전/다음·10초 앞/뒤·셔플·탭 아이콘 등). 지금 재생: 아트 타일+곡 정보 헤더, 도구는 ⋯ 버튼 → 아이콘 타일 메뉴, 진행 막대(탭하면 이동)·경과/남은 시간, 원형 재생 버튼 중심 컨트롤(`PlaybackBar`). 탭 바: 아이콘+작은 글자. 플레이리스트: 큰 아트 타일 헤더·재생/셔플 알약 버튼·곡 행 아트 타일·가사 저장 ✓. 검색: 아이콘 검색창·결과 행 아트 타일. 아트 타일은 이름으로 색이 정해지는 자체 디자인(실제 앨범 아트 아님) | 다른 서비스 아이콘·로고는 쓰지 않음(REQ-UI-06). 아이콘 폰트(@expo/vector-icons)는 폰트 로딩이 필요해 SVG로 선택. 위치를 모르면 진행 막대를 비워 둠(불변조건 5) | 실기기 확인(MV-UI-01·02 — 큰 글자·VoiceOver에서 아이콘 버튼 이름 읽기). 실제 앨범 아트는 Swift에서 MPMediaItemArtwork를 넘기는 작업이 필요(남은 작업) |
| D-33 | **LRCLIB 일시 오류 자동 재시도**(2026-10-06 사용자 보고 "가사 원문 받기 오류가 잦고 중간에 계속 멈춤" — 실기기 화면: 32/56곡에서 오류 10·"가사 서버 오류가 계속되어 멈췄습니다"). **원인**: 실제 LRCLIB가 부하가 몰리면 요청의 약 17~20%에 `503 ServerOverloaded` + `Retry-After: 1`을 돌려줌(2026-10-06 클라우드에서 실측, 1초 뒤 같은 요청은 성공). 기존 코드는 503을 곧바로 곡 오류로 처리했고, 일본 곡은 현지화 표기 때문에 곡당 요청이 최대 7번(get·lookup·get×3·search×n)이라 곡당 실패 확률이 더 커짐 → 오류가 3곡 연속이면 일괄 받기가 멈춤. **수정**: ① `LrclibClient`가 503·502·504·Cloudflare 520~524를 Retry-After(없으면 1·2·4초)만큼 기다렸다 같은 GET을 최대 3번 다시 보냄. 대기 중에는 줄 선 다른 요청도 같이 쉼(`pausedUntil`). Retry-After가 10초보다 길면 다시 보내지 않고 그동안 요청 차단. 시간 초과는 1번만 다시. 429는 그대로(호출자 판단). ② `AppleMusicLyricsProvider` 제목 검색이 서버 오류로 끝나면 "가사 없음" 대신 오류로 알림(잘못된 "못 찾음" 방지). ③ 일괄 받기의 "연속 오류 멈춤"은 서버·네트워크 오류만 셈(잘못된 LRC 같은 곡 자체 문제는 기록만). 실측 A/B(실제 LRCLIB, 30곡 /api/get): 재시도 없음 오류 5·요청 30 → 재시도 있음 오류 0·요청 34 | LRCLIB 조회는 서버 상태를 바꾸지 않는 GET이라 다시 보내도 중복 과금·중복 저장 위험이 없음(불변조건 7은 결과를 알 수 없는 AI 요청 대상). 서버가 Retry-After로 정해 준 간격을 지키므로 LRCLIB 요청 예절(docs 권장)과도 맞음. 뮤턴트 M30~M32 | 실기기 확인(MV-LY-01) — 같은 플레이리스트를 다시 받아 오류 수 확인. LRCLIB가 503 대신 다른 형태(예: 긴 Retry-After)로 바꾸면 재검토 |
| D-34 | **플레이리스트 번역 묶음 파일**(2026-10-06 사용자 요청 "수십 곡을 일일이 눌러 번역 가사를 적용하기 힘들다 → 수작업 번역을 플레이리스트에 일괄로", 방식 선택 "플레이리스트 묶음 파일", 이미 내 번역 있는 곡 "건너뛰기"): 플레이리스트 화면 "번역 한꺼번에 넣기". ① core `buildTranslationBundle`이 저장소만 읽어 가사 원문이 있고 내 번역이 없는 곡을 TXT 한 파일로 만듦 — 곡마다 `### n. 제목 — 가수  {lv:판본ID}` + `[원문]`(빈 행 뺀 원문) + 빈 `[번역]`. 공유 시트로 내보냄(`shareTextFile`, D-23과 같은 방식). ② 사용자가 [번역] 칸을 채움(직접 또는 바깥 AI — 앱은 AI를 부르지 않음). ③ 파일 선택 또는 붙여넣기 → `parseTranslationBundle`(판본 ID 형식 `[A-Za-z0-9_-]`만, 4MB·1000곡 제한, CRLF·BOM·코드 블록·굵게 표시·머리글 기호 빠짐 허용, 첫 머리글 앞 설명 무시) → `previewTranslationBundle`이 곡마다 `previewTxtImport`와 같은 규칙(빈 행 제외 줄 수 일치)으로 매핑, 상태 표시(저장/이미 내 번역/비어 있음/줄 수 다름/원문 그대로/깨진 글자/없는 판본/바뀐 판본/중복) → 사용자가 "n곡 저장" → `applyTranslationBundle`이 곡마다 저장 직전 다시 확인(내 번역 생김·활성 판본 바뀜이면 건너뜀) 후 `saveUserTranslation`(새 버전, 원자적). 지금 재생 중인 곡이면 `reloadCurrent`. `AppServices`에 `ids`·`logger` 추가 | 곡 식별을 제목이 아니라 판본 ID로 하면 한국 Apple Music 현지화 표기·라이브/리믹스 혼동이 없음(불변조건 6). 판본 ID에 붙이므로 행 ID 연결이 정확하고, 다른 판본으로 바뀐 곡에 저장하면 화면에 안 보이므로 건너뜀. 줄 수가 다르면 자동으로 끼워 맞추지 않음(REQ-ED-02). 내보낼 때 AI 번역을 칸에 미리 채우지 않음 — 손대지 않은 AI 번역이 일괄로 "내 번역"이 되는 것을 막음. 원문을 그대로 둔 곡은 번역 안 한 것으로 봄. 한국어 곡은 내보내지 않음. 기존 "원문 TXT 내보내기"(D-29)·"번역 직접 입력" 규칙을 그대로 써서 곡별 흐름과 결과가 같음 | 실기기 확인(MV-ED-03: 파일 앱 .txt 선택·ChatGPT 붙여넣기 형태). 곡이 많은 묶음에서 미리보기 속도 |
| D-15 | 앱(`apps/mobile`)은 루트 npm 워크스페이스에 넣지 않고 별도 패키지로 둔다(core는 `file:` 의존성 + Metro 설정으로 연결) | 루트 `npm ci`·`npm run check`가 React Native 설치 없이 Windows에서 가볍게 돌도록 | 워크스페이스 통합이 필요해지면 재검토 |
| D-16 | (D-17로 폐기, 수동 모드 코드 제거) iOS에서 Spotify·YouTube Music은 수동 모드: LRCLIB 검색 → 들리는 줄 탭 → 앱 시계로 진행, 화면에 "수동 싱크" 표시 | 공개 API 없음(platform-support §2.5), 진행을 꾸며내지 않는다는 불변조건 5 | — |

## 4. 아직 확인하지 못한 것
**실행·환경**
- 사용자 Windows PC에서 `npm ci && npm run check` 실제 실행: 미확인(이번 세션의 로컬 셸이 Windows 업데이트 문제로 폴더를 마운트하지 못함). 클라우드 Linux에서 공백·한글·괄호 경로 사본으로 실행해 통과함.
- GitHub Actions CI(Windows·한글 경로 잡 포함): 설정만 작성(`ci/github-actions-ci.yml` — 원격 도구로 `.github/`에 쓸 수 없어 별도 위치에 둠), 원격 저장소가 없어 실행하지 않음.
- Android Gradle의 한글 경로 문제: 커뮤니티 근거만 있음, Phase 1에서 확인.

**iOS 빌드·설치(2026-10-04 추가)**
- Swift 모듈 컴파일: GitHub Actions 첫 빌드(2026-10-04, run 37206780465)가 성공하고 IPA(8.15MB)를 만들었다. 다만 그 워크플로는 xcodebuild 실패를 가릴 수 있었으므로(D-24) **수정한 워크플로의 다음 빌드에서 `BUILD SUCCEEDED`·실행 파일·JS 번들 검사가 통과해야 확정**.
- 편집·백업 화면(2026-10-05): 앱 타입 검사·iOS JS 번들(Metro, 710 모듈)·`expo prebuild` 통과(클라우드 Linux). 실기기 미확인(MV-ED-01, MV-ST-02).
- 확인한 것: 앱 TypeScript 타입 검사 통과, `expo export --platform ios`(Metro로 core 포함 JS 번들 생성) 성공, `expo prebuild --platform ios` 성공(Info.plist 권한 문구 반영), 자동링크가 `NowPlaying` 모듈을 찾음.
- Sideloadly 무료 서명 설치·7일 재서명 후 데이터·Keychain 유지 여부: 미확인(MV-IOS-INSTALL-01).
- iTunes Search의 jp·us 스토어 ID로 한국 계정에서 `setQueue` 재생 가능 여부: 미확인(MV-PB-IOS-03).

**2026-10-05 추가 기능(플레이리스트·원문 TXT·수동 싱크)**
- 확인한 것(클라우드 Linux): core 테스트 198개·뮤테이션 32/32(2026-10-06 D-33 반영 후), 앱 타입 검사, iOS JS 번들(Metro), `expo prebuild --platform ios`.
- Swift 추가 코드(`listPlaylists`·`playlistItems`·`playPlaylist`) 컴파일: **GitHub Actions `ios-unsigned-ipa` #3 성공**(2026-10-05, 커밋 f488594, run 37282179703, 6분 3초, IPA 아티팩트 8.27MB). D-24 검사(`BUILD SUCCEEDED`·실행 파일·JS 번들)를 포함한 워크플로라 D-17 이후 Swift 모듈 전체 컴파일이 확인됨. `ci` #3도 성공.
- 보관함에 추가한 Apple Music 플레이리스트의 다운로드하지 않은 곡이 `MPMediaQuery`·`setQueue`로 재생되는지, 셔플·시작 곡 지정 동작: 실기기 미확인(MV-PB-IOS-04).
- 탭 기록 정확도(사람 반응 지연)와 전체 보정으로 맞출 수 있는지: 미확인(MV-SY-01). 원문 TXT 공유 시트·파일 인코딩: 미확인(MV-ED-02).

**2026-10-06 추가 기능(플레이리스트 번역 묶음, D-34)**
- 확인한 것(클라우드 Linux): `npm run check` 전체 통과(테스트 204개), 뮤테이션 36/36, 앱 타입 검사, iOS JS 번들(Metro). Swift 변경 없음.
- 실기기 미확인: 공유 시트 내보내기·파일 앱에서 .txt 고르기·붙여넣기, 실제 곡 수십 곡 묶음(MV-ED-03).
- Swift 추가 코드(`listPlaylists`·`playlistItems`·`playPlaylist`) 컴파일: **GitHub Actions `ios-unsigned-ipa` #3 성공**(2026-10-05, 커밋 f488594, run 37282179703, 6분 3초, IPA 아티팩트 8.27MB). D-24 검사(`BUILD SUCCEEDED`·실행 파일·JS 번들)를 포함한 워크플로라 D-17 이후 Swift 모듈 전체 컴파일이 확인됨. `ci` #3도 성공.
- 보관함에 추가한 Apple Music 플레이리스트의 다운로드하지 않은 곡이 `MPMediaQuery`·`setQueue`로 재생되는지, 셔플·시작 곡 지정 동작: 실기기 미확인(MV-PB-IOS-04).
- 탭 기록 정확도(사람 반응 지연)와 전체 보정으로 맞출 수 있는지: 미확인(MV-SY-01). 원문 TXT 공유 시트·파일 인코딩: 미확인(MV-ED-02).

**연동(실기기 0건)**
- 세 서비스 Android 앱이 MediaSession에 제공하는 실제 필드(MEDIA_ID 형식, 위치 갱신 빈도), 사이드로드 시 알림 접근 제한 여부.
- iOS `currentPlaybackTime` 정확도·탐색 반영 지연, 권한 문구 요구사항, MusicKit 사용 조건(유료 개발자 계정 범위).
- Spotify App Remote 백그라운드 연결 유지(정책상 보류 중이라 우선순위 낮음).

**보안·비용**
- 제공자별 중복 요청 방지 키·요청 조회 지원(현재 없다고 가정).
- expo-secure-store의 실제 백업 제외 동작, iOS Keychain 잔존 처리.

**권리·약관** — docs/platform-support.md §5 전체.

## 5. 사용자에게 확인이 필요한 사항
0. 사용자 PC 준비(2026-10-05 확인): Sideloadly, iTunes·iCloud(Apple 웹사이트 버전), GitHub Desktop 설치됨. GitHub 공개 저장소 `alsrb417352-glitch/lyrics-companion`. 다음: iPhone 설치(docs/ios-install.md §2-3~§4).
1. ~~주 사용 기기~~ → **답변(2026-10-04)**: iPhone, Mac 없음, 유료 개발자 계정은 우선 무료로 시도, Android는 나중.
2. 사용할 AI 제공자 → **답변(2026-10-05): OpenAI `gpt-6-luna`, 추론 강도 Extra high(xhigh)**. 앱 설정에서 직접 등록(D-27). API 키는 ChatGPT 구독과 별도(platform.openai.com).
3. 배포 의도(개인 사용 vs 공개 배포) — 권리 검토 범위가 달라진다.
4. GitHub 저장소 공개/비공개 — 비공개면 macOS 빌드 사용량·과금 확인 필요(docs/ios-install.md §1).
