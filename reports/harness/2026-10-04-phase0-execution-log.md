# Phase 0 실행 기록 (2026-10-04)

이 폴더의 `latest.*`, `traceability-run.md`, `mutation-latest.md`는 아래 환경에서 실제로 실행한 결과다.

## 실행한 것
| # | 환경 | 명령 | 결과 |
|---|---|---|---|
| 1 | 클라우드 Linux, Node v22.22.0, 경로 `/home/claude/ai data/노래가사앱(로컬)`(공백·한글·괄호) | `npm ci` → `npm run check` | 7단계 모두 통과, 테스트 119/119 |
| 2 | 같은 환경 | `npm run check:mutation` | 뮤턴트 12/12 검출 |
| 3 | 같은 환경(ASCII 경로 사본) | 하네스 음성 검사: `.env` 생성 시 비밀정보 검사 실패, 없는 REQ 태그 사용 시 추적성 검사 실패 | 의도대로 실패(종료 코드 1) 후 원복 |
| 4 | 개발 중 | 뮤테이션 스모크가 처음에 2개(M04 곡 변경 가드, M07 로그 마스킹)를 놓침 → 테스트 2개 보강 후 12/12 | 기록용 |

## 실행하지 못한 것
- **사용자 Windows PC(`E:\ai data\노래가사앱(로컬)`)에서의 실행**: 이번 세션의 로컬 셸이 Windows 업데이트 관련 문제로 폴더를 마운트하지 못해 실행하지 못했다. 파일만 이 폴더에 복사했다. → `npm ci` 후 `npm run check`를 직접 실행해 확인 필요.
- **GitHub Actions CI**(Ubuntu·Windows × Node 22·24, Windows 한글 경로 잡, 뮤테이션 잡): 설정 파일만 작성(`ci/github-actions-ci.yml`), 원격 저장소가 없어 실행하지 않았다.
- **Node 24**: 실행하지 않았다(CI 매트릭스에만 포함).
- 실기기·실제 스트리밍 앱·실제 AI 호출: 0건(docs/testing.md §5 수동 절차 대상).
