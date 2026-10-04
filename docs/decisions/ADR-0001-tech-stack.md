# ADR-0001 기술 스택: React Native(Expo) 앱 + 플랫폼 독립 TypeScript core

- 상태: 채택 (2026-10-04)
- 관련: docs/architecture.md §2, docs/plan.md D-01·D-02·D-09

## 배경
- Android·iOS 모두 필요하지만, 재생 정보 연동은 OS별로 완전히 다르다(Android MediaSession, iOS systemMusicPlayer). 즉 **네이티브 코드는 어차피 두 벌** 필요하다.
- 핵심 위험은 번역 정책·저장·싱크 로직이며, 이것은 공통이다.
- 사용자 PC는 Windows(경로에 공백·한글 포함). 하네스는 이 환경에서 바로 돌아야 한다. iOS 빌드는 macOS가 필요하다.

## 검토한 선택지
| 선택지 | 장점 | 단점 |
|---|---|---|
| **React Native + Expo(개발 빌드) + TS core** | UI 한 벌, Expo Modules로 Kotlin/Swift 네이티브 모듈 작성 쉬움, expo-secure-store·expo-sqlite 등 필요한 모듈 존재, **core를 Node만으로 테스트**(Windows 즉시 실행) | 네이티브 모듈 디버깅에 Android Studio/Xcode 필요, JS 브리지 계층 |
| Flutter + Dart core | 렌더링 성능·애니메이션 우수, 단일 코드 | 플랫폼 채널로 네이티브 두 벌은 동일하게 필요, Windows 한글 경로에서 SDK·테스트 경로 이슈 보고 이력, 이번 세션에서 실행 검증이 어려움 |
| Kotlin Multiplatform + 네이티브 UI(Compose/SwiftUI) | 플랫폼 경험 최상, 공통 로직 공유 | UI 두 벌, 빌드 도구 무거움(Gradle+Xcode), 1인 개발 부담 |
| 완전 네이티브 두 벌 | 제약 최소 | 로직 중복 → 불변조건을 두 번 구현·검증해야 함 |

## 결정
- 앱: React Native + Expo SDK 56(개발 빌드, Expo Go 사용 안 함 — 알림 리스너 등 네이티브 모듈 필요).
- core: `packages/core`, 런타임 의존성 0, `ports.ts`로 외부 의존성 주입. ESLint로 Node/RN API 사용을 금지해 앱·테스트에서 같은 코드가 돈다.
- 저장소: SQLite. 앱은 expo-sqlite, 테스트는 node:sqlite로 **같은 SQL**을 실행(D-02).
- 검사 도구: Prettier, ESLint(typescript-eslint, 타입 기반 규칙 포함), TypeScript 6.0.x, Vitest 5.
- Node 요구 버전: 22.13+ (node:sqlite 플래그 없이 사용, Vitest 5·ESLint 10 요구사항).

## 결과
- 장점: Phase 0에서 실기기 없이 AT-01~14를 실제 로직으로 검증. 앱 계층은 포트 구현만 추가하면 된다.
- 주의: expo-sqlite와 node:sqlite의 차이(비동기 트랜잭션, JSON 함수 지원)는 Phase 1에서 어댑터 계약 테스트로 확인한다. Android 빌드는 비ASCII 경로 문제를 피하기 위해 ASCII 가상 드라이브(`subst`)를 권장한다.
