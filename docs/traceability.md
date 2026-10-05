# 요구사항 추적표 (자동 생성 — 직접 수정하지 말 것)

원본: `docs/requirements.json` · 생성: `npm run trace:update` · 검사: `npm run trace`

> **core 자동검증**은 플랫폼 독립 로직을 가짜 제공자·가짜 시계·실제 SQLite로 검증했다는 뜻이다. 실제 스트리밍 앱 연동, 실기기, 실제 AI 호출 성공을 뜻하지 않는다. **앱 부분**은 코드가 있다는 뜻이며 실기기 확인 전에는 완료로 표시하지 않는다.

요약: 요구사항 49개 — core 자동검증 30, 부분 11, 미구현 2, 해당없음 6 / 앱 완료 0, 앱 부분 21

| ID | 요구사항 | core | 앱 | 설계 | 구현 위치 | 자동 테스트 | 수동 검증 |
|---|---|---|---|---|---|---|---|
| REQ-APP-01 | Apple Music(Music 앱)이 재생하고 우리 앱은 현재 곡 가사를 자동 싱크로 보여주는 보조 앱으로 동작 | 해당없음 | 부분 | docs/architecture.md §1 | `packages/core/src/ports.ts`<br>`apps/mobile/src/services.ts`<br>`apps/mobile/src/ui/Root.tsx`<br>`apps/mobile/README.md` | - | MV-UI-01 |
| REQ-PB-01 | 지원 플랫폼에서 현재 곡·재생 위치·재생 상태 자동 감지 | 부분 | 부분 | docs/platform-support.md, docs/architecture.md §3 | `packages/core/src/ports.ts`<br>`packages/core/src/session/now-playing-session.ts`<br>`packages/core/src/playback/ios-system-player.ts`<br>`apps/mobile/modules/now-playing/ios/NowPlayingModule.swift`<br>`apps/mobile/src/adapters/ios-playback-source.ts`<br>`apps/mobile/src/ui/usePlayback.ts` | 10건 (acceptance/sync.test.ts, unit/apple-music-lyrics.test.ts, unit/ios-and-catalog.test.ts) | MV-IOS-INSTALL-01, MV-PB-AND-01, MV-PB-AND-02, MV-PB-IOS-01 |
| REQ-PB-02 | 권한 거부 시 안내, 가사 자동 조회가 확정하지 못하면 후보·직접 검색으로 사용자가 선택 | 부분 | 부분 | docs/product.md 흐름 F3, docs/architecture.md §4 | `packages/core/src/session/now-playing-session.ts`<br>`packages/core/src/lyrics/lrclib-client.ts`<br>`packages/core/src/lyrics/apple-music-lyrics-provider.ts`<br>`apps/mobile/src/ui/LyricsPicker.tsx` | 1건 (acceptance/failure-handling.test.ts) | MV-PB-IOS-02 |
| REQ-PB-03 | 지원 플랫폼에서 재생·일시정지·탐색·이전/다음 제어 | 미구현 | 부분 | docs/platform-support.md 재생 제어 | `packages/core/src/ports.ts`<br>`apps/mobile/modules/now-playing/ios/NowPlayingModule.swift`<br>`apps/mobile/src/ui/NowPlayingScreen.tsx` | - | MV-PB-CTL-01 |
| REQ-PB-04 | 다른 앱 위 오버레이는 OS 지원 확인 후 별도 기능으로 제공 | 해당없음 | 미구현 | docs/platform-support.md 오버레이 | `docs/platform-support.md` | - | MV-OVL-01 |
| REQ-PB-05 | 앱 안에서 곡 검색·선택 → 스트리밍 앱 재생(iOS Apple Music, 유료 개발자 계정 없이) | 부분 | 부분 | docs/platform-support.md §2.6, docs/decisions/ADR-0002-ios-without-mac.md | `packages/core/src/catalog/itunes-catalog.ts`<br>`apps/mobile/modules/now-playing/ios/NowPlayingModule.swift`<br>`apps/mobile/src/ui/SearchScreen.tsx` | 6건 (unit/apple-music-lyrics.test.ts, unit/ios-and-catalog.test.ts) | MV-PB-IOS-03 |
| REQ-LY-01 | LRCLIB 조회: 식별 헤더, 순차·간격 요청, 429 Retry-After 준수, 응답 검증 | 자동검증 | 미구현 | docs/architecture.md §5 | `packages/core/src/lyrics/lrclib-client.ts` | 7건 (acceptance/failure-handling.test.ts, acceptance/lyrics-and-matching.test.ts, unit/clients-and-import.test.ts) | - |
| REQ-LY-02 | 가사 없음·일반 가사·싱크 가사·연주곡·잘못된 LRC 상태 구분 | 자동검증 | 미구현 | docs/architecture.md §5 | `packages/core/src/lyrics/lyrics-provider.ts`<br>`packages/core/src/lyrics/lrc.ts` | 10건 (acceptance/lyrics-and-matching.test.ts, unit/apple-music-lyrics.test.ts, unit/clients-and-import.test.ts, unit/parsing.test.ts) | - |
| REQ-LY-03 | 서비스 ID·ISRC·아티스트·길이·녹음 버전으로 곡 식별, 불확실하면 후보 확인 | 자동검증 | 미구현 | docs/architecture.md §6 | `packages/core/src/matching/track-identity.ts`<br>`packages/core/src/session/now-playing-session.ts`<br>`packages/core/src/lyrics/apple-music-lyrics-provider.ts` | 15건 (acceptance/failure-handling.test.ts, acceptance/lyrics-and-matching.test.ts, unit/apple-music-lyrics.test.ts) | MV-PB-IOS-02 |
| REQ-LY-04 | 원문이 달라지면 기존 판본·번역 보존, 연결 상태를 사용자가 확인 | 부분 | 부분 | docs/architecture.md §7 | `packages/core/src/storage/lyrics-store.ts`<br>`packages/core/src/lyrics/lyrics-version.ts`<br>`apps/mobile/src/ui/LyricsPicker.tsx` | 2건 (acceptance/versions.test.ts, unit/apple-music-lyrics.test.ts) | - |
| REQ-SY-01 | 원문 타임스탬프 기준 행 단위 싱크, AI는 시간 정보를 만들거나 바꾸지 못함, 단어 싱크 흉내 금지 | 자동검증 | 미구현 | docs/architecture.md §8 | `packages/core/src/sync/sync-engine.ts`<br>`packages/core/src/lyrics/lrc.ts` | 8건 (acceptance/backup.test.ts, acceptance/lyrics-and-matching.test.ts, acceptance/sync.test.ts, unit/parsing.test.ts) | - |
| REQ-SY-02 | 재생·일시정지·탐색·곡 변경·백그라운드 복귀 처리, 위치를 모르면 진행 표시 안 함 | 자동검증 | 부분 | docs/architecture.md §8 | `packages/core/src/sync/sync-engine.ts`<br>`packages/core/src/session/now-playing-session.ts`<br>`apps/mobile/src/ui/usePlayback.ts` | 3건 (acceptance/sync.test.ts, unit/ios-and-catalog.test.ts) | MV-PB-AND-02 |
| REQ-SY-03 | 곡별 시간 보정값 저장 | 자동검증 | 부분 | docs/architecture.md §8 | `packages/core/src/storage/lyrics-store.ts` | 2건 (acceptance/sync.test.ts) | - |
| REQ-SY-04 | 시간 정보가 없으면 일반 가사 화면 | 자동검증 | 미구현 | docs/architecture.md §8 | `packages/core/src/display/compose.ts` | 2건 (acceptance/lyrics-and-matching.test.ts, unit/parsing.test.ts) | - |
| REQ-UI-01 | 큰 글자·여백·현재 행 강조·부드러운 자동 스크롤·충분한 대비(자체 디자인) | 해당없음 | 미구현 | docs/product.md 가사 화면 | `apps/mobile/README.md` | - | MV-UI-01 |
| REQ-UI-02 | 원문·발음·번역을 같은 행 묶음으로 표시, 원문은 항상 표시 | 자동검증 | 부분 | docs/architecture.md §9 | `packages/core/src/display/compose.ts`<br>`apps/mobile/src/ui/LyricsList.tsx` | 2건 (acceptance/translation-cache.test.ts, unit/clients-and-import.test.ts) | MV-UI-01 |
| REQ-UI-03 | 번역·발음 표시를 독립적으로 켜고 끔, 재실행 후 유지 | 자동검증 | 부분 | docs/architecture.md §9 | `packages/core/src/session/now-playing-session.ts`<br>`packages/core/src/storage/lyrics-store.ts`<br>`apps/mobile/src/ui/NowPlayingScreen.tsx` | 2건 (acceptance/security-and-migration.test.ts, acceptance/translation-cache.test.ts) | - |
| REQ-UI-04 | 글자 크기 조절·화면 읽기·동작 줄이기 대응 | 부분 | 미구현 | docs/product.md 접근성 | `packages/core/src/display/compose.ts` | 1건 (unit/clients-and-import.test.ts) | MV-UI-02 |
| REQ-UI-05 | 직접 스크롤 시 자동 추적 일시 중지, 현재 가사로 돌아오기 | 미구현 | 부분 | docs/product.md 가사 화면 | `apps/mobile/README.md`<br>`apps/mobile/src/ui/LyricsList.tsx` | - | MV-UI-01 |
| REQ-UI-06 | Apple 로고·전용 자산을 복제하지 않는 자체 디자인 | 해당없음 | 미구현 | docs/product.md 가사 화면 | `docs/product.md` | - | MV-UI-01, MV-LEGAL-01 |
| REQ-TR-01 | 사용자가 AI 제공자와 API 키 등록, 특정 제공자·모델 비종속 | 부분 | 부분 | docs/architecture.md §10 | `packages/core/src/translation/provider.ts`<br>`packages/core/src/translation/openai-compatible-provider.ts`<br>`packages/core/src/security/api-keys.ts`<br>`packages/core/src/translation/provider-config.ts`<br>`apps/mobile/src/ui/SettingsScreen.tsx` | 3건 (acceptance/security-and-migration.test.ts, unit/ios-and-catalog.test.ts) | MV-AI-01 |
| REQ-TR-02 | 영어: 원문+번역, 일본어: 원문+발음+번역 | 자동검증 | 미구현 | docs/product.md 표시 규칙 | `packages/core/src/util/text.ts`<br>`packages/core/src/translation/translation-service.ts` | 2건 (unit/parsing.test.ts, unit/translation-contract.test.ts) | - |
| REQ-TR-03 | 일본어 발음 = 한국어 사용자를 위한 한글 독음(가정 명시), 사용자 수정 가능 | 부분 | 미구현 | docs/product.md 발음 정의 | `packages/core/src/pronunciation/kana-to-hangul.ts` | 4건 (acceptance/backup.test.ts, acceptance/versions.test.ts, unit/parsing.test.ts) | MV-AI-02 |
| REQ-TR-04 | 가사 선택 우선순위: 사용자 번역 → 저장된 AI 번역 → 원문 → 조건 충족 시 신규 AI 번역 | 자동검증 | 미구현 | docs/architecture.md §11 | `packages/core/src/translation/selection.ts`<br>`packages/core/src/translation/translation-service.ts` | 3건 (acceptance/translation-cache.test.ts, unit/translation-contract.test.ts) | - |
| REQ-TR-05 | 저장된 번역이 있으면 재생·재시작·표시 변경·모델/프롬프트/제공자 변경으로 AI 호출 안 함 | 자동검증 | 미구현 | docs/architecture.md §11 INV-1, INV-2 | `packages/core/src/translation/translation-service.ts` | 3건 (acceptance/backup.test.ts, acceptance/translation-cache.test.ts) | - |
| REQ-TR-06 | 사용자 번역(부분 포함)은 자동 수정·보완·덮어쓰기 금지 | 자동검증 | 미구현 | docs/architecture.md §11 INV-3 | `packages/core/src/translation/selection.ts`<br>`packages/core/src/storage/lyrics-store.ts` | 6건 (acceptance/backup.test.ts, acceptance/translation-cache.test.ts, acceptance/versions.test.ts) | - |
| REQ-TR-07 | 발음이 없다는 이유로 번역을 재생성하지 않음, 발음 생성은 별도 요청 | 자동검증 | 미구현 | docs/architecture.md §11 INV-4 | `packages/core/src/translation/translation-service.ts` | 2건 (acceptance/backup.test.ts, acceptance/failure-handling.test.ts) | - |
| REQ-TR-08 | 재번역은 명시 요청 시에만, 사용자 저장본 보존, 새 결과는 별도 버전 | 자동검증 | 미구현 | docs/architecture.md §11 INV-5 | `packages/core/src/translation/translation-service.ts`<br>`packages/core/src/translation/selection.ts` | 2건 (acceptance/versions.test.ts, unit/translation-contract.test.ts) | - |
| REQ-TR-09 | 동시 요청 합치기, 원자적 저장, 늦은 응답·이전 곡 응답이 현재 화면·사용자 저장본을 덮지 않음 | 자동검증 | 미구현 | docs/architecture.md §11 INV-6, INV-7, §12 | `packages/core/src/translation/translation-service.ts`<br>`packages/core/src/session/now-playing-session.ts`<br>`packages/core/src/storage/lyrics-store.ts` | 5건 (acceptance/backup.test.ts, acceptance/translation-cache.test.ts) | - |
| REQ-TR-10 | 처리 여부가 불확실한 타임아웃·앱 종료 후 자동 재요청 금지, 중복 과금 경계 기록 | 자동검증 | 미구현 | docs/architecture.md §11 INV-8, docs/security.md 비용 | `packages/core/src/translation/translation-service.ts`<br>`packages/core/src/storage/lyrics-store.ts` | 3건 (acceptance/failure-handling.test.ts) | MV-AI-01 |
| REQ-TR-11 | 행 ID 구조화 응답 검증, 불완전·거절 결과를 완료로 저장하지 않음, 재시도 범위 구분 | 자동검증 | 미구현 | docs/architecture.md §10 | `packages/core/src/translation/validate.ts`<br>`packages/core/src/translation/translation-service.ts` | 10건 (acceptance/failure-handling.test.ts, unit/parsing.test.ts, unit/translation-contract.test.ts) | - |
| REQ-TR-12 | 곡 전체 문맥·화자·정서·반복 보존, 원문에 없는 내용 추가 금지, 혼합 언어·빈 행·긴 가사 처리 | 부분 | 미구현 | docs/architecture.md §10 | `packages/core/src/translation/prompt.ts` | 1건 (unit/translation-contract.test.ts) | MV-AI-02 |
| REQ-TR-13 | 자동 번역 동의(기본 꺼짐), 일일 요청 상한, 크기 상한, 호출 제한 | 자동검증 | 부분 | docs/security.md 비용·호출 제한 | `packages/core/src/translation/translation-service.ts`<br>`packages/core/src/storage/lyrics-store.ts`<br>`apps/mobile/src/ui/SettingsScreen.tsx` | 3건 (acceptance/failure-handling.test.ts) | - |
| REQ-ED-01 | 사용자 번역 직접 입력·붙여넣기·수정·저장 | 자동검증 | 부분 | docs/product.md 흐름 F5 | `packages/core/src/session/now-playing-session.ts`<br>`packages/core/src/import/user-translation-import.ts`<br>`apps/mobile/src/ui/EditScreen.tsx` | 2건 (acceptance/translation-cache.test.ts, unit/clients-and-import.test.ts) | MV-ED-01 |
| REQ-ED-02 | TXT/LRC 가져오기, 행 수·시간 불일치 시 자동 끼워 맞추지 않고 미리보기·수동 연결 | 자동검증 | 부분 | docs/product.md 흐름 F5 | `packages/core/src/import/user-translation-import.ts`<br>`apps/mobile/src/ui/EditScreen.tsx` | 3건 (unit/clients-and-import.test.ts) | MV-ED-01 |
| REQ-ED-03 | 일본어 발음(한글 독음) 행별 사용자 수정 | 자동검증 | 부분 | docs/product.md 발음 정의 | `packages/core/src/storage/lyrics-store.ts`<br>`packages/core/src/import/user-pronunciation.ts`<br>`packages/core/src/session/now-playing-session.ts`<br>`apps/mobile/src/ui/EditScreen.tsx` | 3건 (acceptance/backup.test.ts, acceptance/versions.test.ts) | MV-ED-01 |
| REQ-ST-01 | 원문·발음·번역·싱크 정보를 기기에 영구 저장, 같은 곡 재생 시 저장본 사용 | 자동검증 | 부분 | docs/architecture.md §7 | `packages/core/src/storage/lyrics-store.ts`<br>`packages/core/src/storage/migrations.ts`<br>`apps/mobile/src/adapters/sqlite-driver.ts` | 7건 (acceptance/backup.test.ts, acceptance/failure-handling.test.ts, acceptance/translation-cache.test.ts, acceptance/versions.test.ts, unit/apple-music-lyrics.test.ts, unit/ios-and-catalog.test.ts) | MV-ST-01 |
| REQ-ST-02 | 저장된 데이터는 네트워크 없이 열람 가능 | 자동검증 | 미구현 | docs/architecture.md §7 | `packages/core/src/session/now-playing-session.ts` | 2건 (acceptance/failure-handling.test.ts, acceptance/translation-cache.test.ts) | - |
| REQ-ST-03 | 캐시 정리·앱 업데이트로 저장본이 사라지지 않음(영구 저장 위치, 안전한 마이그레이션) | 자동검증 | 미구현 | docs/architecture.md §7, docs/security.md 저장·백업 | `packages/core/src/storage/migrations.ts` | 3건 (acceptance/security-and-migration.test.ts) | MV-ST-01 |
| REQ-ST-04 | 사용자 데이터 백업 내보내기·가져오기: 불신 파일 검증(해시·참조·크기), 기존 데이터 보존 병합, 원자적 저장, 키·동의 미포함 | 자동검증 | 부분 | docs/architecture.md §7, docs/security.md 저장·백업 | `packages/core/src/backup/backup-file.ts`<br>`packages/core/src/storage/lyrics-store.ts`<br>`apps/mobile/src/adapters/backup-files.ts`<br>`apps/mobile/src/ui/BackupSection.tsx` | 8건 (acceptance/backup.test.ts) | MV-ST-02 |
| REQ-SEC-01 | API 키는 OS 보안 저장소에만, 소스·설정·로그·오류·테스트 데이터·내보내기에 포함 금지 | 자동검증 | 부분 | docs/security.md 키 관리 | `packages/core/src/security/api-keys.ts`<br>`packages/core/src/security/redact.ts`<br>`packages/core/src/security/logger.ts`<br>`apps/mobile/src/adapters/secure-store.ts` | 6건 (acceptance/backup.test.ts, acceptance/failure-handling.test.ts, acceptance/security-and-migration.test.ts, unit/clients-and-import.test.ts, unit/ios-and-catalog.test.ts) | MV-SEC-01 |
| REQ-SEC-02 | 개발자 공용 비밀 키를 앱에 넣지 않음, 저장소 비밀정보 검사 | 자동검증 | 해당없음 | docs/security.md 키 관리 | `scripts/scan-secrets.mjs`<br>`scripts/lib/secret-patterns.mjs` | 4건 (scripts/test/scan-secrets.test.mjs) | - |
| REQ-SEC-03 | 키 등록·교체·삭제 제공, 키를 채팅·문서에 붙여 넣게 하지 않음 | 자동검증 | 미구현 | docs/security.md 키 관리 | `packages/core/src/security/api-keys.ts` | 2건 (acceptance/security-and-migration.test.ts) | MV-SEC-01 |
| REQ-SEC-04 | HTTPS·인증서 검증 사용, 인증이 필요하면 공식 모바일 인증 흐름과 최소 권한 | 부분 | 부분 | docs/security.md 전송 | `packages/core/src/translation/openai-compatible-provider.ts`<br>`packages/core/src/lyrics/lrclib-client.ts`<br>`apps/mobile/src/adapters/http.ts` | 2건 (acceptance/security-and-migration.test.ts, unit/ios-and-catalog.test.ts) | MV-SEC-01 |
| REQ-SEC-05 | AI로 보내는 데이터·예상 비용·자동 번역 동작을 사용자가 이해하고 선택 | 부분 | 미구현 | docs/security.md 외부 전송 | `packages/core/src/translation/translation-service.ts` | 2건 (acceptance/backup.test.ts, acceptance/failure-handling.test.ts) | MV-AI-01 |
| REQ-SEC-06 | 재생 감지에 필요 없는 알림 내용·사용자 데이터 저장·전송 금지 | 해당없음 | 미구현 | docs/security.md 권한 | `docs/security.md` | - | MV-PB-AND-01, MV-SEC-01 |
| REQ-SEC-07 | 외부 가사·파일·AI 응답 불신: 크기·형식·인코딩 검증, 가사 속 지시문을 명령으로 실행하지 않음 | 자동검증 | 미구현 | docs/security.md 입력 검증 | `packages/core/src/lyrics/lrc.ts`<br>`packages/core/src/translation/validate.ts`<br>`packages/core/src/translation/prompt.ts`<br>`packages/core/src/catalog/itunes-catalog.ts` | 9건 (acceptance/backup.test.ts, acceptance/security-and-migration.test.ts, unit/clients-and-import.test.ts, unit/ios-and-catalog.test.ts, unit/parsing.test.ts, unit/translation-contract.test.ts) | - |
| REQ-SEC-08 | 사용자 파일 안전한 읽기, 로컬 저장소 접근 보호·백업·삭제 정책 | 부분 | 부분 | docs/security.md 저장·백업 | `packages/core/src/import/user-translation-import.ts`<br>`packages/core/src/storage/lyrics-store.ts`<br>`packages/core/src/backup/backup-file.ts`<br>`apps/mobile/src/adapters/backup-files.ts` | 1건 (unit/clients-and-import.test.ts) | MV-SEC-01, MV-ST-02 |
| REQ-LEGAL-01 | 가사 조회·번역·저장·표시와 스트리밍 연동의 약관·권리 조건 확인(배포 권한 별도) | 해당없음 | 해당없음 | docs/platform-support.md 약관·권리 | `docs/platform-support.md` | - | MV-LEGAL-01 |

## 필수 자동 검증 사례(AT)

| ID | 사례 | 테스트 수 |
|---|---|---|
| AT-01 | 최초 번역 저장 후 다시 재생하면 AI 추가 호출 0회 | 2건 |
| AT-02 | 앱 종료 후 재실행해도 저장된 번역 사용 | 1건 |
| AT-03 | 사용자 번역(부분 포함)이 있으면 AI 호출 0회 | 2건 |
| AT-04 | 번역·발음 표시 토글 시 네트워크 요청 없음 | 1건 |
| AT-05 | 같은 곡 동시 요청은 하나의 번역 작업 | 1건 |
| AT-06 | AI 응답보다 사용자 저장이 먼저면 사용자 저장본 유지 | 1건 |
| AT-07 | 곡 변경 후 이전 곡 응답이 현재 화면을 덮지 않음 | 2건 |
| AT-08 | 라이브·리믹스 등 다른 녹음의 가사·번역 혼동 없음 | 7건 |
| AT-09 | 일반·싱크·연주곡·가사 없음·잘못된 LRC 처리 | 7건 |
| AT-10 | 일시정지·탐색·곡 변경·시간 보정 시 올바른 행 표시 | 3건 |
| AT-11 | 오프라인·권한 거부·인증 오류·요청 제한·타임아웃에서 저장본 유지 | 9건 |
| AT-12 | 잘못된 AI 응답·저장 실패를 완료로 처리하지 않음 | 5건 |
| AT-13 | 로그·내보내기·저장소에 비밀 키 노출 없음 | 4건 |
| AT-14 | 저장소 마이그레이션 후 사용자 번역·설정 유지 | 3건 |
| AT-15 | 백업을 새 설치본에 가져오면 AI·가사 요청 없이 같은 번역 표시, 사용자 번역 우선 병합 | 5건 |
| AT-16 | 손상·변조된 백업 거부, 가져오기 실패 시 부분 반영 없음 | 3건 |
