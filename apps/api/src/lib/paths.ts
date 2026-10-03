/**
 * Repository path resolution.
 *
 * Migrations and seed data live at the workspace root (`db/`), not inside `apps/api`, because
 * they describe the whole system's schema rather than one service's. Resolving by walking up to
 * the workspace marker keeps that true whether the API runs from `src/` or from `dist/`.
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const WORKSPACE_MARKER = 'pnpm-workspace.yaml'

let cachedRoot: string | null = null

export function workspaceRoot(): string {
  if (cachedRoot) return cachedRoot
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, WORKSPACE_MARKER))) {
      cachedRoot = dir
      return dir
    }
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  throw new Error(
    `Could not locate the workspace root: no ${WORKSPACE_MARKER} found above ${fileURLToPath(import.meta.url)}`,
  )
}

export function migrationsDir(): string {
  return join(workspaceRoot(), 'db', 'migrations')
}

export function seedDir(): string {
  return join(workspaceRoot(), 'db', 'seed')
}

/**
 * The workspace-root `.env`. Resolved from the root rather than from `process.cwd()` because a
 * pnpm filtered script runs with its package as the working directory — so a root `.env` would
 * be invisible to `apps/api` and the process would fail to boot for a reason that looks like a
 * missing variable rather than a missing file.
 */
export function envFilePath(): string {
  return join(workspaceRoot(), '.env')
}
