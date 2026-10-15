# apps/mobile — iPhone 앱 (Expo SDK 57)

Music 앱에서 재생 중인 곡을 읽어 원문·한글 발음·한국어 번역 가사를 보여 주고, 앱 안에서 곡을 골라 Music 앱으로 재생한다.
설계: [`../../docs/architecture.md`](../../docs/architecture.md) §13 · 결정: [ADR-0002](../../docs/decisions/ADR-0002-ios-without-mac.md) · 설치: [`../../docs/ios-install.md`](../../docs/ios-install.md)

> 상태(2026-10-04): 코드 작성, 앱 타입 검사·JS 번들·prebuild·자동링크 확인. **Swift 컴파일과 실기기 실행은 아직 확인하지 않았다**(GitHub Actions 첫 빌드에서 확인).

## 구조
```
apps/mobile/
├─ App.tsx, index.ts          진입점
├─ app.json                   앱 이름·번들 ID·iOS 권한 문구(NSAppleMusicUsageDescription)
├─ metro.config.js            ../../packages/core 를 번들에 포함(.js → .ts 해석)
├─ modules/now-playing/       로컬 Expo 모듈(Swift): systemMusicPlayer 읽기·제어·곡 재생·보관함 검색
└─ src/
   ├─ adapters/               core 포트 구현(SQLite·Keychain·fetch·시계·재생 소스)
   ├─ services.ts             조립 지점(core 객체에 어댑터 주입)
   └─ ui/                     화면: 지금 재생 / 검색 / 설정
```
판단 로직(번역 호출 여부, 싱크, 곡 식별, 응답 검증, 재생 값 해석)은 모두 `packages/core`에 있다. 여기서는 연결과 화면만 담당한다.

## 명령 (Windows에서도 동작)
```powershell
cd "E:\ai data\노래가사앱(로컬)\apps\mobile"
npm ci                 # 처음 한 번
npm run typecheck      # 앱 + core 타입 검사
npm run bundle:ios     # iOS용 JS 번들 생성 확인(.tmp/export-ios, Xcode 불필요)
```
루트에서 `npm run check`를 실행하면 앱 의존성이 설치된 경우 앱 타입 검사도 함께 한다.

## iPhone에 설치
Mac이 없으므로 GitHub Actions(macOS 서버)에서 서명 없는 IPA를 만들고, Windows의 Sideloadly가 무료 Apple ID로 서명해 설치한다. 단계별 안내: [`docs/ios-install.md`](../../docs/ios-install.md). 워크플로: [`ci/ios-unsigned-ipa.yml`](../../ci/ios-unsigned-ipa.yml).

## 지원 범위
| 듣는 앱 | 현재 곡 자동 인식 | 재생 위치 싱크 | 앱에서 재생 제어·곡 선택 |
|---|---|---|---|
| Apple Music(Music 앱) | 예 | 예(1초 재조회) | 예 |

iPhone에서 Spotify·YouTube Music은 지원하지 않는다(docs/plan.md D-17).

**Android(2026-10-14, D-41)**: Spotify·YouTube Music·Apple Music 앱을 OS 미디어 세션(알림 접근 권한)으로 따른다. 네이티브 모듈은 `modules/now-playing/android`(Kotlin, `AndroidMediaSessions`), 해석은 core `playback/android-media-session.ts`, 어댑터는 `src/adapters/android-playback-source.ts`. 플레이리스트 탭은 재생 앱의 지금 재생 목록(`src/ui/QueueScreen.tsx`), 검색 탭은 고른 앱에 검색 재생. 빌드는 GitHub Actions(`ci/android-apk.yml`), 설치는 `docs/android-install.md`. 미리 확인: `npm run typecheck && npm run bundle:android`.

가사 자동 조회: Music 앱 표기 → 스토어 ID로 일본어·영어·한국어 표기 → 제목 검색 순서로 찾는다. 가수 표기가 달라 같은 곡인지 확실하지 않으면 자동 적용하지 않고 후보를 보여 준다(지금 재생 › 후보 보고 고르기 / 가사 바꾸기).
