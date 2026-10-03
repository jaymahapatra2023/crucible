import { describe, expect, it } from 'vitest'
import { envFilePath, migrationsDir, seedDir, workspaceRoot } from './paths.js'
import { existsSync } from 'node:fs'

describe('workspace path resolution', () => {
  it('finds the workspace root by its marker file', () => {
    expect(existsSync(`${workspaceRoot()}/pnpm-workspace.yaml`)).toBe(true)
  })

  it('resolves the migrations directory, which must actually exist', () => {
    expect(migrationsDir().endsWith('/db/migrations')).toBe(true)
    expect(existsSync(migrationsDir())).toBe(true)
  })

  it('resolves the seed directory', () => {
    expect(seedDir().endsWith('/db/seed')).toBe(true)
  })

  it('resolves .env at the workspace root, not the working directory', () => {
    // A pnpm filtered script runs with its package as cwd, so a cwd-relative lookup would miss
    // the root .env and the process would fail to boot for a misleading reason.
    expect(envFilePath()).toBe(`${workspaceRoot()}/.env`)
  })

  it('caches the root so repeated calls do not re-walk the tree', () => {
    expect(workspaceRoot()).toBe(workspaceRoot())
  })
})
