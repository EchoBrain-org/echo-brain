import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  {
    ignores: ['node_modules/**', '**/dist/**', 'coverage/**'],
  },
  {
    files: [
      'src/**/*.ts',
      'tests/**/*.ts',
      'packages/*/src/**/*.ts',
      'packages/*/test/**/*.ts',
      'services/*/src/**/*.ts',
      'services/*/test/**/*.ts',
      'vitest.config.ts',
      'vitest.package.config.ts',
    ],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-empty': 'off',
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
];
