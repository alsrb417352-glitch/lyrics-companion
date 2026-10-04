// ESLint flat config. 아키텍처 경계(core는 플랫폼 독립)를 린트 규칙으로 강제한다.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '.tmp/**',
      'reports/**',
      'coverage/**',
      'apps/mobile/.tmp/**',
      'apps/mobile/.expo/**',
      'apps/mobile/ios/**',
      'apps/mobile/android/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['scripts/**/*.mjs', '*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // 앱 빌드 설정 파일(metro.config.js 등, CommonJS). 앱 TS 코드는 apps/mobile에서 tsc로 검사한다.
    files: ['apps/mobile/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
  },
  ...tseslint.configs.recommendedTypeChecked.map((c) => ({ ...c, files: ['packages/**/*.ts'] })),
  {
    files: ['packages/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // 비동기 경쟁 조건 방지: 처리하지 않은 Promise 금지
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // core 앱 코드: Node/React Native/DOM 의존 금지, console 금지(Logger 사용)
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-console': 'error',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'crypto', 'os', 'child_process'],
              message: 'core/src는 플랫폼 독립이어야 합니다. 포트(ports.ts)로 주입하세요.',
            },
            { group: ['react', 'react-native', 'expo*', 'expo-*'], message: 'UI·플랫폼 의존은 apps/mobile에 둡니다.' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'HttpClient 포트를 사용하세요.' },
        { name: 'Date', message: 'Clock 포트를 사용하세요(날짜 포맷 등 순수 계산은 eslint-disable 사유를 남길 것).' },
        { name: 'setTimeout', message: 'Clock.sleep을 사용하세요.' },
      ],
    },
  },
  {
    files: ['packages/core/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
