# ADR-0002 Mac·유료 개발자 계정 없이 iPhone에서 실행하기

- 상태: 채택 (2026-10-04)
- 관련: docs/plan.md D-03(변경)·D-12~D-16, docs/ios-install.md, ci/ios-unsigned-ipa.yml

## 배경
- 사용자 결정(2026-10-04): **주 사용 기기는 iPhone**, **Mac 없음(Windows만)**, **Apple Developer Program(연 $99)은 우선 가입하지 않고 무료로 시도**, Android는 나중.
- iOS 앱은 macOS + Xcode로만 빌드할 수 있다. 기기 설치에는 Apple의 코드 서명이 필요하다.
- 원래 목표(앱 안에서 곡 선택·재생 조절, Apple Music 일본어 곡의 번역 가사)는 iOS의 `MPMusicPlayerController.systemMusicPlayer`로 가능하다(docs/platform-support.md §2.4).

## 검토한 선택지
| 선택지 | 비용 | 장점 | 단점 |
|---|---|---|---|
| **A. GitHub Actions macOS 러너로 무서명 IPA 빌드 + Windows Sideloadly로 무료 Apple ID 서명·설치** | 0원(공개 저장소). 비공개 저장소는 macOS 사용량 제한·과금 가능 | Mac·유료 계정 불필요 | 7일마다 재서명, 동시 설치 3개, 빌드 1회 20~40분, 제3자 도구에 Apple ID 로그인 필요 |
| B. EAS Build(Expo 클라우드) + 내부 배포 | Apple Developer Program 필요 | 설치 간편, 1년 유효 | 사용자가 유료 계정 보류 |
| C. 웹앱(PWA) + MusicKit JS | 개발자 토큰 = 유료 계정 필요 | 설치 불필요 | Music 앱 연동 불가, 백그라운드 재생 제약 |
| D. Mac 대여(클라우드 Mac) | 시간당 과금 | Xcode 직접 사용 | 비용·설정 부담, 서명 문제는 동일 |

## 결정
1. **A를 채택**한다. 유료 계정에 가입하면 B로 옮길 수 있게 앱 구조는 Expo 표준(prebuild)으로 유지한다.
2. **MusicKit 카탈로그 API·개발자 토큰을 쓰지 않는다**(무료 서명에서 MusicKit App Service를 켤 수 없고, 공용 키 금지 원칙 D-08). 대신:
   - 현재 곡·재생 위치·재생 제어: MediaPlayer `systemMusicPlayer`(권한 문구 `NSAppleMusicUsageDescription`만 필요).
   - 앱 안 곡 검색: **iTunes Search API**(키 불필요) → 스토어 ID → `setQueue(with: storeIDs)`로 Music 앱 재생.
   - 보관함 곡: `MPMediaQuery`.
3. 빌드는 **Release 구성(JS 번들 내장)** 으로 한다. 개발 클라이언트(Metro 연결)는 무료 서명·Windows 환경에서 디버깅 흐름이 복잡해 쓰지 않는다. 대신 JS 번들은 Windows·클라우드에서 `npx expo export --platform ios`로 미리 검증한다.
4. Spotify·YouTube Music은 iOS에서 재생 정보를 읽을 수 없으므로 **수동 모드**(가사 검색 → 들리는 줄 탭 → 앱 시계로 진행, "수동 싱크" 표시)로 제공한다.

## 결과·위험
- 이 결정으로 **Phase 6(iOS)을 Phase 1로 당긴다**(docs/plan.md).
- 위험
  - Swift 네이티브 모듈은 클라우드(Linux)에서 컴파일할 수 없다 → **첫 GitHub Actions 빌드가 첫 컴파일 확인**이다. 실패하면 로그(`xcodebuild-log` 아티팩트)로 고친다.
  - iTunes Search는 `country=kr` 결과가 0건이다(2026-10-04 직접 확인). jp·us 스토어 ID로 한국 계정에서 재생되는지 미확인(MV-PB-IOS-03).
  - Sideloadly는 Apple 공식 도구가 아니다. **음악 구독 계정과 다른 별도 Apple ID**로 서명할 것을 권장한다(docs/security.md §11).
  - 무료 서명 앱의 Keychain 동작(재서명·재설치 후 키 유지 여부)은 미확인(MV-SEC-01).
  - iTunes Search API 이용 조건(홍보 목적 API)은 개인 사용 범위에서만 쓰고, 배포 전 권리 검토(MV-LEGAL-01)에 포함한다.

## 되돌리는 조건
- 7일 재서명이 너무 번거롭거나 Sideloadly가 동작하지 않으면 → Apple Developer Program 가입 후 B(EAS Build)로 전환.
- 비공개 저장소의 macOS 빌드 사용량이 부족하면 → 저장소 공개(비밀 값 없음) 또는 B로 전환.
