/**
 * API entry point.
 *
 * Boot order is deliberate: validate configuration first so a misconfigured deployment stops
 * with a named error rather than starting and misbehaving (E01-S03 acceptance 1); then confirm
 * the schema is current; only then accept traffic.
 */
import { buildServer } from './server.js'
import { ConfigurationError, loadEnv } from './config/env.js'
import { createLogger } from './lib/logger.js'
import { appliedVersions } from './db/migrationRunner.js'
import { closePool } from './db/pool.js'

const log = createLogger('platform', 'boot')

async function main(): Promise<void> {
  const env = loadEnv()

  const versions = await appliedVersions()
  if (versions.length === 0) {
    throw new Error('No migrations have been applied. Run `pnpm migrate` before starting the API.')
  }
  log.info('schema check passed', { migrations: versions.length, latest: versions.at(-1) })

  const app = await buildServer()
  await app.listen({ host: env.HOST, port: env.PORT })
  log.info('api listening', { host: env.HOST, port: env.PORT, env: env.NODE_ENV })

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      log.info('shutting down', { signal })
      void app
        .close()
        .then(() => closePool())
        .then(() => process.exit(0))
        .catch(() => process.exit(1))
    })
  }
}

main().catch(async (err: unknown) => {
  if (err instanceof ConfigurationError) {
    process.stderr.write(`\n${err.message}\n\n`)
  } else {
    log.error('boot failed', { err })
  }
  await closePool().catch(() => undefined)
  process.exit(1)
})
