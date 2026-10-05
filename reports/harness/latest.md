# 하네스 실행 결과 (자동 생성)

- 실행 시각: 2026-10-05T02:41:00.120Z
- 환경: Node v22.22.0, linux-x64
- 경로에 공백: 아니오, 비ASCII 문자: 아니오
- 결과: **통과**
- 테스트: 155/155 통과, 실패 0, 건너뜀 0

| 단계 | 내용 | 결과 | 시간(ms) |
|---|---|---|---|
| format | 포맷(Prettier) | 통과 | 3458 |
| lint | 정적 분석(ESLint, 아키텍처 경계 포함) | 통과 | 5973 |
| typecheck | 타입 검사(테스트 포함) | 통과 | 2353 |
| test | 핵심 테스트(Vitest: 단위·수용, 가짜 제공자·가짜 시계·실제 SQLite) | 통과 | 4843 |
| build | 빌드(core, 플랫폼 타입 없이 컴파일) | 통과 | 1545 |
| app | 앱 타입 검사(apps/mobile, 의존성 설치 시에만) | 통과 | 2884 |
| secrets | 비밀정보 검사 | 통과 | 85 |
| trace | 요구사항 추적성(요구사항↔테스트↔문서) | 통과 | 61 |

> 자동 검사는 core 도메인 로직(가짜 제공자·가짜 시계·실제 SQLite)과 앱 TypeScript 타입만 검증한다. 실기기, 실제 스트리밍 앱 연동, 실제 AI 호출, iOS 네이티브(Swift) 빌드는 포함하지 않는다(iOS 빌드는 GitHub Actions ios-unsigned-ipa, 실기기는 docs/testing.md 수동 절차).

요구사항별 통과 현황: `reports/harness/traceability-run.md`
