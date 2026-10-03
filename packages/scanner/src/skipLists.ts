/**
 * What the scanner does not read.
 *
 * A blacklist, not a whitelist: an unfamiliar language should still be scanned, and a hackathon
 * will produce stacks nobody anticipated. The lists exclude things that are definitionally not
 * the team's own work — dependencies, build output, binaries, lockfiles — because including
 * them would spend the file budget on code the team did not write and dilute every metric.
 */

/** Directories never descended into. */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  // Dependencies
  'node_modules', 'bower_components', 'vendor', 'jspm_packages', '.pnpm', '.yarn',
  'site-packages', '.venv', 'venv', 'env', 'virtualenv', '.tox',
  'Pods', 'Carthage', '.gradle', '.m2', 'target/dependency',
  // Build output
  'dist', 'build', 'out', 'output', 'bin', 'obj', '.next', '.nuxt', '.svelte-kit',
  '.output', '.parcel-cache', '.turbo', '.cache', '__pycache__', '.pytest_cache',
  '.mypy_cache', '.ruff_cache', 'coverage', 'htmlcov', '.nyc_output',
  // Tooling and VCS
  '.git', '.svn', '.hg', '.idea', '.vscode', '.vs', '.settings', '.history',
  '.terraform', '.serverless', '.aws-sam', '.dart_tool',
  // Assets that are not code
  'node', 'fonts', 'images', 'img', 'assets/images', 'screenshots',
])

/** Extensions never read. Lowercase, including the dot. */
export const SKIP_EXTENSIONS: ReadonlySet<string> = new Set([
  // Images, video, audio
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg', '.avif', '.tiff',
  '.mp4', '.mov', '.avi', '.webm', '.mkv', '.mp3', '.wav', '.ogg', '.flac',
  // Fonts
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  // Archives and binaries
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar', '.jar', '.war', '.ear',
  '.exe', '.dll', '.so', '.dylib', '.a', '.o', '.obj', '.class', '.pyc', '.pyo',
  '.wasm', '.node', '.bin', '.dat', '.db', '.sqlite', '.sqlite3', '.mdb',
  // Documents and data dumps
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.psd', '.ai', '.sketch',
  '.csv', '.tsv', '.parquet', '.avro',
  // Source maps and minified output
  '.map', '.min.js', '.min.css',
  // Certificates and keys — never read, never logged
  '.pem', '.key', '.crt', '.cer', '.p12', '.pfx', '.jks', '.keystore',
])

/** Exact filenames never read. */
export const SKIP_FILENAMES: ReadonlySet<string> = new Set([
  // Lockfiles: enormous, machine-written, and not the team's work. Their *presence* is a
  // signal the metrics record; their contents are not worth a slot in the file budget.
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'npm-shrinkwrap.json',
  'Gemfile.lock', 'Cargo.lock', 'poetry.lock', 'Pipfile.lock', 'composer.lock',
  'go.sum', 'gradle.lockfile', 'packages.lock.json', 'mix.lock', 'pubspec.lock',
  // Noise
  '.DS_Store', 'Thumbs.db', 'desktop.ini', '.gitkeep', '.keep',
  // Secrets — a real `.env` must never be read into a scan result or a prompt (P8.3).
  '.env', '.env.local', '.env.production', '.env.development',
])

/** Files whose presence is a signal even though the contents are skipped. */
export const LOCKFILES: ReadonlySet<string> = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
  'Gemfile.lock', 'Cargo.lock', 'poetry.lock', 'Pipfile.lock', 'composer.lock',
  'go.sum', 'gradle.lockfile', 'mix.lock', 'pubspec.lock',
])

/** Manifests always read if present, regardless of the budget — they describe the project. */
export const MANIFEST_FILES: readonly string[] = [
  'package.json', 'pyproject.toml', 'requirements.txt', 'Pipfile', 'setup.py',
  'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'Gemfile', 'composer.json', 'mix.exs', 'pubspec.yaml', 'Package.swift',
  'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'Makefile',
  'README.md', 'README.rst', 'README.txt', 'readme.md',
  '.env.example', '.env.sample', '.env.template',
]

/** Paths that indicate continuous integration is configured. */
export const CI_MARKERS: readonly string[] = [
  '.github/workflows', '.gitlab-ci.yml', '.circleci/config.yml', 'azure-pipelines.yml',
  'Jenkinsfile', '.travis.yml', 'bitbucket-pipelines.yml', '.drone.yml',
]

export function shouldSkipDir(name: string): boolean {
  return SKIP_DIRS.has(name) || (name.startsWith('.') && !name.startsWith('.github'))
}

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot <= 0 ? '' : filename.slice(dot).toLowerCase()
}

export function shouldSkipFile(filename: string): boolean {
  if (SKIP_FILENAMES.has(filename)) return true
  const ext = extensionOf(filename)
  if (SKIP_EXTENSIONS.has(ext)) return true
  // Minified bundles carry no reviewable signal and eat the byte budget.
  return /\.(min|bundle|chunk)\.(js|css|mjs)$/i.test(filename)
}
