/**
 * Presence checks for files whose *existence* is a signal even when their contents are skipped.
 *
 * Lockfiles are the case that motivated this: they are excluded from the file budget because
 * they are enormous and machine-written, but "are dependencies pinned" is a real signal for
 * E06-S04. Deriving markers from the gathered-file list meant every skipped marker silently
 * reported absent — a metric that was confidently wrong rather than unknown.
 *
 * Checked directly on the filesystem, so a marker is found whether or not the walk would have
 * reached it.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { CI_MARKERS, LOCKFILES } from './skipLists.js'

export interface RepoMarkers {
  hasReadme: boolean
  hasLockfile: boolean
  lockfiles: string[]
  hasCi: boolean
  ciSystems: string[]
  hasDockerfile: boolean
  dockerfilePaths: string[]
  hasDockerCompose: boolean
  hasLicense: boolean
  hasGitignore: boolean
}

const README = /^readme(\.(md|rst|txt|adoc))?$/i
const LICENSE = /^(licen[cs]e|copying)(\.|$)/i
const DOCKERFILE = /^dockerfile(\..+)?$/i

export function findMarkers(rootPath: string): RepoMarkers {
  let rootEntries: string[] = []
  try {
    rootEntries = readdirSync(rootPath)
  } catch {
    return emptyMarkers()
  }

  const lockfiles = rootEntries.filter((e) => LOCKFILES.has(e)).sort()
  const dockerfilePaths = rootEntries.filter((e) => DOCKERFILE.test(e)).sort()

  // A Dockerfile is often one level down (docker/, build/, deploy/, apps/*/).
  for (const dir of ['docker', 'build', 'deploy', 'infra', 'infrastructure', '.docker']) {
    const candidate = join(rootPath, dir)
    if (!existsSync(candidate)) continue
    try {
      for (const entry of readdirSync(candidate)) {
        if (DOCKERFILE.test(entry)) dockerfilePaths.push(`${dir}/${entry}`)
      }
    } catch {
      // Unreadable directory — absence of a marker is the honest answer.
    }
  }

  const ciSystems = CI_MARKERS.filter((marker) => {
    const full = join(rootPath, marker)
    if (!existsSync(full)) return false
    try {
      // `.github/workflows` counts only if it actually contains a workflow.
      return statSync(full).isDirectory() ? readdirSync(full).length > 0 : true
    } catch {
      return false
    }
  })

  return {
    hasReadme: rootEntries.some((e) => README.test(e)),
    hasLockfile: lockfiles.length > 0,
    lockfiles,
    hasCi: ciSystems.length > 0,
    ciSystems,
    hasDockerfile: dockerfilePaths.length > 0,
    dockerfilePaths: [...new Set(dockerfilePaths)].sort(),
    hasDockerCompose: rootEntries.some((e) => /^docker-compose\.ya?ml$/i.test(e)),
    hasLicense: rootEntries.some((e) => LICENSE.test(e)),
    hasGitignore: rootEntries.includes('.gitignore'),
  }
}

function emptyMarkers(): RepoMarkers {
  return {
    hasReadme: false, hasLockfile: false, lockfiles: [],
    hasCi: false, ciSystems: [], hasDockerfile: false, dockerfilePaths: [],
    hasDockerCompose: false, hasLicense: false, hasGitignore: false,
  }
}
