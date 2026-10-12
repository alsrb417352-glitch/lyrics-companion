# 번역 가사 보조 앱 (Lyrics Companion)

**Apple Music**으로 일본어·영어 노래를 들을 때, 현재 곡의 **한국어 번역 가사**(일본어는 한글 발음 포함)를 보여주는 보조 앱. iPhone(Music 앱) + **Windows PC(Chrome/Edge에서 Apple Music 웹)**.

> 현재 단계: **Phase 1 진행 중 — iPhone 앱**(2026-10-04). core 로직·검증 하네스(Phase 0) 위에 Expo iPhone 앱과 Music 앱 연동 Swift 모듈을 작성했다. Mac 없이 GitHub Actions로 빌드하고 Sideloadly(무료 Apple ID)로 설치한다 → **[iPhone 설치 안내](docs/ios-install.md)**. Swift 컴파일·실기기 확인은 아직 0건이다.
>
> **PC 버전(2026-10-06)**: Windows의 Chrome/Edge 확장 프로그램(`apps/pc-extension`) — music.apple.com 옆 사이드 패널에 가사를 맞춰 보여 준다 → **[PC 설치 안내](docs/pc-install.md)**. 실제 브라우저 설치·Apple Music 웹 연동 확인은 아직 0건이다.

## 빠른 시작 (Windows)
1. [Node.js 22 LTS 또는 24 LTS](https://nodejs.org/) 설치(22.13 이상)
2. PowerShell:
   ```powershell
   cd "E:\ai data\노래가사앱(로컬)"
   npm ci
   npm run check
   ```
3. 결과: `reports\harness\latest.md`

## 폴더 구조 (모든 프로젝트 데이터는 이 폴더 안에 둔다)
```
노래가사앱(로컬)/
├─ CLAUDE.md                 작업 지침(짧은 버전) — 개발 전에 먼저 읽기
├─ README.md
├─ docs/
│  ├─ product.md             사용자 흐름·요구사항·수용 기준
│  ├─ platform-support.md    OS×스트리밍 서비스 지원 근거(확인 날짜·링크)
│  ├─ architecture.md        기술·모듈 경계·데이터 모델·상태 전이·불변조건
│  ├─ security.md            키 관리·권한·외부 전송·저장/백업 정책
│  ├─ testing.md             테스트 종류·실행 방법·수동 검증 절차
│  ├─ plan.md                단계별 계획·결정 사항·남은 작업
│  ├─ ios-install.md         iPhone 설치 안내(Windows + 무료 Apple ID)
│  ├─ pc-install.md          PC(Windows Chrome/Edge) 확장 프로그램 설치 안내
│  ├─ requirements.json      요구사항 레지스트리(단일 원본)
│  ├─ traceability.md        요구사항↔구현↔테스트 추적표(자동 생성)
│  ├─ decisions/             설계 결정 기록(ADR)
│  ├─ research/              조사 원자료(날짜별)
│  └─ manual-verification/   수동 검증 양식·기록
├─ packages/core/            플랫폼 독립 로직(src) + 테스트(test)
├─ apps/mobile/              iPhone 앱(Expo) + Swift 모듈(modules/now-playing)
├─ apps/pc-extension/        Windows PC용 Chrome/Edge 확장 프로그램(Apple Music 웹) + 보안 저장소 도우미(native-host)
├─ fixtures/                 테스트용 합성 데이터(실제 가사·키 금지)
├─ scripts/                  검사 하네스(check, 비밀정보, 추적성, 뮤테이션)
├─ reports/harness/          검사 실행 결과(자동 생성)
├─ ci/                      CI 설정(GitHub 저장소 생성 시 .github/workflows/로 복사): 검사, iOS 무서명 IPA 빌드
├─ .tmp/                     테스트 임시 파일(자동 생성·삭제, git 제외)
└─ local-data/               개인 실제 데이터(실제 가사, 실기기 DB 사본 등, git 제외)
```
