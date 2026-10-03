import { defineConfig, devices } from '@playwright/test'

/**
 * E2E configuration (P10.1).
 *
 * Boots the real API and the real web app against the test database, so a run exercises the
 * full stack — UI, HTTP, auth, and database state — rather than a mocked approximation.
 */
const API_PORT = 3199
const WEB_PORT = 5199
const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgresql://localhost:5432/crucible_test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 30_000,
  expect: { timeout: 7_000 },

  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: [
    {
      command: 'pnpm --filter @crucible/api dev',
      port: API_PORT,
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
      env: {
        NODE_ENV: 'test',
        PORT: String(API_PORT),
        HOST: '127.0.0.1',
        LOG_LEVEL: 'error',
        DATABASE_URL: TEST_DATABASE_URL,
        JWT_SECRET: 'e2e-only-jwt-secret-at-least-thirty-two-chars',
        // A throwaway 32-byte key so the reveal journey can run; never a real one.
        TOKEN_REVEAL_KEY: '5BD+shCS/pZM/IFy9vvBoN1FTEqzKAfgsgEhCT7c4WI=',
        // No real model provider. The journeys assert what the app says when scoring cannot
        // reach one; inheriting a developer's key or CLI would make them slow, billable, and
        // dependent on that machine's configuration. Empty means "not configured".
        ANTHROPIC_API_KEY: '',
        LLM_CLI_BINARY: '',
        // Nor a real mail provider: the journeys assert what the delivery panel says when nothing
        // can be transmitted, and a developer's SMTP settings would send to real people.
        MAIL_PROVIDER: 'record',
        MAIL_API_KEY: '',
        SMTP_HOST: '',
        SMTP_USER: '',
        SMTP_PASSWORD: '',
        // Nor a real Discord bot: the suite would resolve usernames against the live event
        // server and DM real people (integrationSetup.ts has the longer note).
        DISCORD_BOT_TOKEN: '',
        DISCORD_GUILD_ID: '',
      },
    },
    {
      // --host 127.0.0.1 is required: vite's default `localhost` binding resolves to ::1 on macOS,
      // while Playwright probes 127.0.0.1 and would report the server as never starting.
      command: `pnpm --filter @crucible/web exec vite --port ${WEB_PORT} --strictPort --host 127.0.0.1`,
      port: WEB_PORT,
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
      env: { VITE_API_PORT: String(API_PORT) },
    },
  ],
})
