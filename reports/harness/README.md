# reports/harness — 검사 실행 결과

| 파일 | 생성 | 내용 |
|---|---|---|
| `latest.md`, `latest.json` | `npm run check` | 마지막 실행의 단계별 결과·환경(경로에 공백·한글 포함 여부) |
| `history.jsonl` | `npm run check` | 실행 이력(한 줄에 한 번) |
| `traceability-run.md` | `npm run check` | 요구사항별 최근 테스트 통과/실패 수 |
| `mutation-latest.md` | `npm run check:mutation` | 뮤테이션 스모크 결과 |
| `vitest-results.json` | `npm run check` | Vitest 원시 결과(git 제외) |
| `2026-10-04-phase0-execution-log.md` | 수동 작성 | Phase 0에서 실제로 실행한 것과 실행하지 못한 것 |
