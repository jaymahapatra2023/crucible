import { defineConfig } from 'vitest/config'

/** Root config — coverage policy only. Projects are declared in vitest.workspace.ts. */
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['packages/*/src/**/*.ts', 'apps/api/src/**/*.ts', 'apps/web/src/**/*.tsx'],
      exclude: [
        '**/*.test.ts', '**/*.test.tsx', '**/dist/**', '**/types/**', '**/*.d.ts',
        '**/db/cli/**', '**/index.ts', '**/main.tsx', '**/App.tsx',
        '**/*.config.ts', 'apps/web/src/test/**',
      ],
      thresholds: { lines: 80, functions: 80, branches: 70, statements: 80 },
    },
  },
})
