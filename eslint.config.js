// @ts-check
/**
 * Flat ESLint config.
 *
 * P1.4 max-lines overrides are DERIVED from file-size-limits.json rather than restated here,
 * so there is exactly one declaration of "what is the limit for this file" (P1.5 clause 6).
 */
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import { loadLimits } from './scripts/lib/limits.mjs'

/*
 * Turn the shared declaration into per-glob max-lines blocks.
 *
 * REVERSED, and that is the whole subtlety. The declaration's rule is "first matching pattern
 * wins", which is how `limitFor()` reads it. ESLint flat config is the opposite: every matching
 * block applies and the LAST one wins. Emitting the rows in declaration order therefore gave
 * ESLint the least specific limit - the web-component glob beating the test-file glob for a test
 * that happens to live under apps/web/src - while the guard applied the most specific one.
 *
 * Two derivations of one declaration that disagree is exactly the failure P1.5 clause 6 exists
 * to prevent, so the order is inverted here to make ESLint's semantics match the declaration's.
 * `scripts/limits-agree.test.mjs` asserts the two stay in step.
 */
const sizeOverrides = loadLimits()
  .filter((row) => /\.(ts|tsx)$/.test(row.pattern))
  .reverse()
  .map((row) => ({
    files: [row.pattern],
    rules: {
      'max-lines': [
        'error',
        { max: row.max, skipBlankLines: true, skipComments: true },
      ],
    },
  }))

export default tseslint.config(
  {
    ignores: [
      '**/dist/**', '**/node_modules/**', '**/coverage/**', '**/build/**',
      '**/playwright-report/**', '**/test-results/**', '**/.tmp/**',
      'apps/web/dist/**',
      // A standalone package with its own dependencies and tsconfig (docs/DEPLOYMENT_AWS.md).
      'deploy/aws/cdk/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2023 },
    },
    rules: {
      // P10.2 gate 1 — zero untyped `any`.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // P9.1 — structured logs only; no console string interpolation.
      'no-console': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'max-params': ['error', 4],
      complexity: ['error', 15],
    },
  },
  // P9.1 exemption: the logger itself and CLI entry points are the console boundary.
  {
    files: ['**/lib/logger.ts', '**/db/cli/**/*.ts', 'scripts/**/*.mjs'],
    rules: { 'no-console': 'off' },
  },
  // The web app runs in a browser, not in Node.
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.es2023 },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The UI talks to the API only through lib/apiClient.ts; console there would bypass the
      // error states P5.4 requires.
      'no-console': 'error',
    },
  },
  // E2E specs drive a browser from Node and legitimately touch both environments.
  {
    files: ['e2e/**/*.ts', 'playwright.config.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  // Tests may use looser typing for fixtures and doubles.
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'max-params': 'off',
      complexity: 'off',
    },
  },
  ...sizeOverrides,
)
