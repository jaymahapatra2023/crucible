import { defineWorkspace } from 'vitest/config'

/**
 * Test pyramid projects (P10.1).
 *
 * unit         — pure logic, all I/O mocked, no database, no network
 * integration  — real test database, external APIs mocked
 * api          — HTTP contract tests against a booted Fastify instance
 * web          — React component tests in jsdom
 *
 * E2E (Playwright) is a separate runner — see playwright.config.ts.
 */
export default defineWorkspace([
  {
    test: {
      name: 'unit',
      environment: 'node',
      include: [
        'packages/*/src/**/*.test.ts', 'apps/api/src/**/*.test.ts',
        // Repository-level invariants: the CI guards agreeing with each other (P1.5 clause 6).
        'scripts/**/*.test.mjs',
      ],
      exclude: ['**/node_modules/**', '**/dist/**'],
    },
  },
  {
    test: {
      name: 'integration',
      environment: 'node',
      include: ['apps/api/tests/integration/**/*.test.ts'],
      setupFiles: ['apps/api/tests/setup/integrationSetup.ts'],
      hookTimeout: 120_000,
      testTimeout: 120_000,
      // Every DB-backed file shares one Postgres database and truncates between tests, so they
      // must not run concurrently. `fileParallelism` is a root-level option in Vitest 2 and is
      // ignored inside a workspace project — a single fork is what actually serialises them.
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
    },
  },
  {
    test: {
      name: 'api',
      environment: 'node',
      include: ['apps/api/tests/api/**/*.test.ts'],
      setupFiles: ['apps/api/tests/setup/integrationSetup.ts'],
      // Its own database. This project runs at the same time as `integration`, and sharing one
      // made their resets collide — see the note at the top of the setup file.
      env: { TEST_DB_SUFFIX: '_api' },
      hookTimeout: 120_000,
      testTimeout: 120_000,
      // Every DB-backed file shares one Postgres database and truncates between tests, so they
      // must not run concurrently. `fileParallelism` is a root-level option in Vitest 2 and is
      // ignored inside a workspace project — a single fork is what actually serialises them.
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
    },
  },
  {
    test: {
      name: 'security',
      environment: 'node',
      include: ['packages/prober/tests/**/*.test.ts'],
      // Real containers: builds, pulls and a settle period. Slow by nature.
      hookTimeout: 600_000,
      testTimeout: 600_000,
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
    },
  },
  {
    test: {
      name: 'web',
      environment: 'jsdom',
      include: ['apps/web/src/**/*.test.tsx', 'apps/web/src/**/*.test.ts'],
      setupFiles: ['apps/web/src/test/setup.ts'],
    },
  },
])
