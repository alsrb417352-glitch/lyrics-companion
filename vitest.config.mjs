import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'scripts/test/**/*.test.mjs'],
    pool: 'forks',
    environment: 'node',
    testTimeout: 20_000,
    // 실제 네트워크 차단: 테스트는 가짜 HTTP만 사용해야 한다(test/setup에서 fetch를 막는다).
    setupFiles: ['packages/core/test/support/no-network.ts'],
  },
});
