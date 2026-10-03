/**
 * Originality signals (E06-S05 acceptance 1).
 *
 * Three facts, measured rather than judged: how much of the repository is scaffold, which
 * generator produced it, and what the git history says about when the work happened.
 *
 * This module deliberately does NOT conclude anything. "70% scaffold" is a measurement; whether
 * that means a team coasted or that they chose a sensible framework and spent their time on the
 * 30% that mattered is a judgement, and one a heuristic has no business making. That is why the
 * dimension is advisory, carries the lowest weight, and is barred by E07-S06 from being the sole
 * reason anyone falls below the cut.
 *
 * The honest limit: template detection recognises generators it has been taught. A repository
 * scaffolded by something not in the registry reads as fully substantive, and a team who
 * genuinely wrote their own framework files reads as scaffold. Both errors are reported as
 * measurements with their basis attached, so a reviewer can see what was matched and disagree.
 */
import type { Provenance, ScanResult, ScannedFile } from '@crucible/scanner'

export interface TemplateMarker {
  id: string
  name: string
  /** Paths whose presence indicates this generator ran. Matched against the repo-relative path. */
  paths: RegExp[]
  /** Content fragments that confirm it, checked only in the files `paths` matched. */
  confirms?: string[]
  /** Files this generator writes that a team is not expected to have authored. */
  generated: RegExp[]
}

/**
 * The template registry — one declaration per generator (P1.5).
 *
 * Adding a generator is adding a row here. Nothing else in the system enumerates scaffolds.
 */
export const TEMPLATE_MARKERS: readonly TemplateMarker[] = [
  {
    id: 'create-react-app',
    name: 'Create React App',
    paths: [/^src\/reportWebVitals\.[jt]sx?$/, /^src\/setupTests\.[jt]sx?$/],
    confirms: ['react-scripts', 'reportWebVitals'],
    generated: [
      /^src\/reportWebVitals\.[jt]sx?$/, /^src\/setupTests\.[jt]sx?$/,
      /^src\/App\.test\.[jt]sx?$/, /^src\/logo\.svg$/, /^public\/manifest\.json$/,
    ],
  },
  {
    id: 'vite-starter',
    name: 'Vite starter template',
    paths: [/^vite\.config\.[jt]s$/],
    confirms: ['defineConfig'],
    generated: [/^src\/vite-env\.d\.ts$/, /^public\/vite\.svg$/, /^src\/assets\/react\.svg$/],
  },
  {
    id: 'next-starter',
    name: 'Next.js starter',
    paths: [/^next\.config\.[jmt]s$/],
    generated: [/^app\/favicon\.ico$/, /^next-env\.d\.ts$/],
  },
  {
    id: 'spring-initializr',
    name: 'Spring Initializr',
    paths: [/^src\/main\/resources\/application\.(properties|ya?ml)$/],
    confirms: ['spring-boot'],
    generated: [
      /^mvnw(\.cmd)?$/, /^gradlew(\.bat)?$/,
      /^\.mvn\//, /^gradle\/wrapper\//,
    ],
  },
  {
    id: 'django-startproject',
    name: 'Django startproject',
    paths: [/^manage\.py$/],
    confirms: ['DJANGO_SETTINGS_MODULE'],
    generated: [/^manage\.py$/, /\/(wsgi|asgi)\.py$/, /\/migrations\/0001_initial\.py$/],
  },
  {
    id: 'rails-new',
    name: 'Rails new',
    paths: [/^config\/application\.rb$/],
    confirms: ['Rails::Application'],
    generated: [/^config\/(boot|environment|puma)\.rb$/, /^bin\/(rails|rake|setup)$/],
  },
  {
    id: 'cargo-new',
    name: 'cargo new',
    paths: [/^Cargo\.toml$/],
    generated: [],
  },
  {
    id: 'dotnet-new',
    name: 'dotnet new',
    paths: [/\.csproj$/],
    generated: [/^Properties\/launchSettings\.json$/, /^(Program|Startup)\.cs$/],
  },
]

export interface TemplateMatch {
  id: string
  name: string
  /** The file that gave it away — so a reviewer can check rather than trust. */
  matchedOn: string
}

export function detectTemplates(files: readonly ScannedFile[]): TemplateMatch[] {
  const matches: TemplateMatch[] = []
  for (const marker of TEMPLATE_MARKERS) {
    const hit = files.find((f) =>
      marker.paths.some((p) => p.test(f.path))
      && (!marker.confirms || marker.confirms.some((c) => f.content.includes(c))))
    if (hit) matches.push({ id: marker.id, name: marker.name, matchedOn: hit.path })
  }
  return matches
}

/**
 * Files a generator writes, which a team is not expected to have authored.
 *
 * Only generators actually detected in this repository contribute. Treating every registry entry
 * as live would count a `Program.cs` in a Python project as scaffold.
 */
export function generatedPaths(
  files: readonly ScannedFile[], matches: readonly TemplateMatch[],
): Set<string> {
  const live = TEMPLATE_MARKERS.filter((m) => matches.some((match) => match.id === m.id))
  const paths = new Set<string>()
  for (const file of files) {
    if (live.some((m) => m.generated.some((g) => g.test(file.path)))) paths.add(file.path)
  }
  return paths
}

/** Configuration and packaging: real work, but not the work this competition is judging. */
const CONFIG_PATH = new RegExp(
  '(^|/)(' +
  [
    'package\\.json', 'tsconfig(\\.\\w+)?\\.json', 'pyproject\\.toml', 'requirements\\.txt',
    'go\\.mod', 'Cargo\\.toml', 'pom\\.xml', 'build\\.gradle(\\.kts)?', 'Gemfile',
    '\\.eslintrc(\\.\\w+)?', 'eslint\\.config\\.\\w+', '\\.prettierrc(\\.\\w+)?',
    '\\.gitignore', '\\.dockerignore', '\\.editorconfig', '\\.env\\.example',
  ].join('|') +
  ')$',
)

export type FileClass = 'SCAFFOLD' | 'CONFIG' | 'SUBSTANTIVE'

export function classifyFile(file: ScannedFile, generated: Set<string>): FileClass {
  if (generated.has(file.path)) return 'SCAFFOLD'
  if (CONFIG_PATH.test(file.path)) return 'CONFIG'
  return 'SUBSTANTIVE'
}

export interface BoilerplateShare {
  totalLines: number
  scaffoldLines: number
  configLines: number
  substantiveLines: number
  /** Scaffold and config as a percentage of analysed lines, one decimal place. */
  sharePct: number
  scaffoldFiles: string[]
  substantiveFileCount: number
}

export function boilerplateShare(
  files: readonly ScannedFile[], generated: Set<string>,
): BoilerplateShare {
  let scaffoldLines = 0
  let configLines = 0
  let substantiveLines = 0
  const scaffoldFiles: string[] = []
  let substantiveFileCount = 0

  for (const file of files) {
    switch (classifyFile(file, generated)) {
      case 'SCAFFOLD':
        scaffoldLines += file.lines
        scaffoldFiles.push(file.path)
        break
      case 'CONFIG':
        configLines += file.lines
        break
      default:
        substantiveLines += file.lines
        substantiveFileCount++
    }
  }

  const totalLines = scaffoldLines + configLines + substantiveLines
  return {
    totalLines, scaffoldLines, configLines, substantiveLines,
    sharePct: totalLines === 0
      ? 0
      : Math.round(((scaffoldLines + configLines) / totalLines) * 1000) / 10,
    scaffoldFiles,
    substantiveFileCount,
  }
}

export interface OriginalitySignals {
  templates: TemplateMatch[]
  boilerplate: BoilerplateShare
  provenance: Provenance | null
  /** True when the scan read only part of the repository, so shares are over a sample. */
  partialScan: boolean
}

export function originalitySignals(scan: ScanResult): OriginalitySignals {
  const templates = detectTemplates(scan.files)
  return {
    templates,
    boilerplate: boilerplateShare(scan.files, generatedPaths(scan.files, templates)),
    provenance: scan.provenance,
    partialScan: scan.budgetTruncated,
  }
}

/**
 * The signals in prose, for the prompt and for the reviewer who reads the same words.
 *
 * Written as observations with their basis, never as verdicts: "60% of analysed lines are in
 * scaffold or configuration files" is checkable; "this is mostly boilerplate" is not.
 */
export function describeOriginality(signals: OriginalitySignals): string {
  const { boilerplate: b, templates, provenance: p } = signals
  const lines: string[] = []

  lines.push(templates.length === 0
    ? 'No known project generator was recognised. This may mean the repository was set up by ' +
      'hand, or that its generator is not one this system has been taught to recognise.'
    : `Recognised generators: ${templates.map((t) => `${t.name} (from ${t.matchedOn})`).join('; ')}.`)

  lines.push(
    `${b.sharePct}% of the ${b.totalLines} analysed lines sit in generated or configuration ` +
    `files (${b.scaffoldLines} scaffold, ${b.configLines} configuration). The remaining ` +
    `${b.substantiveLines} lines across ${b.substantiveFileCount} files are the team's own work ` +
    `as far as this measurement can tell.`)

  if (b.scaffoldFiles.length > 0) {
    lines.push(`Files counted as generated: ${b.scaffoldFiles.slice(0, 12).join(', ')}` +
      `${b.scaffoldFiles.length > 12 ? `, and ${b.scaffoldFiles.length - 12} more` : ''}.`)
  }

  if (signals.partialScan) {
    lines.push(
      'The scan did not read the whole repository, so these shares describe the files that ' +
      'were analysed rather than the repository as a whole.')
  }

  lines.push(p === null
    ? 'No readable git history, so when the work was done cannot be established.'
    : `Git history: ${p.totalCommits} commits from ${p.distinctAuthors} author(s); ` +
      `${p.commitsInWindow} inside the event window and ${p.commitsOutOfWindow} outside it. ` +
      `The largest single commit contains ${p.largestSingleCommitPct}% of all added lines` +
      `${p.historyTruncated ? ', and history was truncated by the clone depth so these are lower bounds' : ''}.`)

  return lines.join('\n')
}
