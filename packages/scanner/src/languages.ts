/**
 * Language identification from a file extension.
 *
 * A lookup, not detection: content sniffing would be slower and wrong more often for the short,
 * polyglot repositories a hackathon produces. An unknown extension returns 'other' rather than
 * being guessed at.
 */

const BY_EXTENSION: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.pyi': 'python',
  '.rb': 'ruby', '.rake': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.scala': 'scala', '.groovy': 'groovy',
  '.cs': 'csharp', '.fs': 'fsharp', '.vb': 'visualbasic',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp',
  '.m': 'objectivec', '.mm': 'objectivec', '.swift': 'swift',
  '.php': 'php', '.pl': 'perl', '.lua': 'lua', '.r': 'r', '.jl': 'julia',
  '.ex': 'elixir', '.exs': 'elixir', '.erl': 'erlang', '.clj': 'clojure', '.cljs': 'clojure',
  '.hs': 'haskell', '.ml': 'ocaml', '.dart': 'dart', '.zig': 'zig', '.nim': 'nim',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.fish': 'shell', '.ps1': 'powershell',
  '.sql': 'sql',
  '.html': 'html', '.htm': 'html', '.vue': 'vue', '.svelte': 'svelte', '.astro': 'astro',
  '.css': 'css', '.scss': 'scss', '.sass': 'sass', '.less': 'less',
  '.json': 'json', '.jsonc': 'json', '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'toml',
  '.xml': 'xml', '.md': 'markdown', '.mdx': 'markdown', '.rst': 'restructuredtext',
  '.tf': 'terraform', '.hcl': 'hcl', '.proto': 'protobuf', '.graphql': 'graphql', '.gql': 'graphql',
  '.ipynb': 'notebook',
}

const BY_FILENAME: Record<string, string> = {
  Dockerfile: 'dockerfile',
  'docker-compose.yml': 'yaml',
  'docker-compose.yaml': 'yaml',
  Makefile: 'makefile',
  Rakefile: 'ruby',
  Gemfile: 'ruby',
  Procfile: 'procfile',
  'go.mod': 'gomod',
}

/** Languages whose files count as source code rather than configuration or prose. */
const CODE_LANGUAGES = new Set([
  'typescript', 'javascript', 'python', 'ruby', 'go', 'rust', 'java', 'kotlin', 'scala',
  'groovy', 'csharp', 'fsharp', 'visualbasic', 'c', 'cpp', 'objectivec', 'swift', 'php',
  'perl', 'lua', 'r', 'julia', 'elixir', 'erlang', 'clojure', 'haskell', 'ocaml', 'dart',
  'zig', 'nim', 'shell', 'powershell', 'sql', 'vue', 'svelte', 'astro',
])

export function languageOf(relativePath: string): string {
  const name = relativePath.split('/').pop() ?? relativePath
  const byName = BY_FILENAME[name]
  if (byName) return byName
  if (name.startsWith('Dockerfile')) return 'dockerfile'

  const dot = name.lastIndexOf('.')
  if (dot <= 0) return 'other'
  return BY_EXTENSION[name.slice(dot).toLowerCase()] ?? 'other'
}

export function isCodeLanguage(language: string): boolean {
  return CODE_LANGUAGES.has(language)
}

/** Line-comment prefixes per language, for the code/comment split in the metrics. */
const LINE_COMMENT: Record<string, string[]> = {
  python: ['#'], ruby: ['#'], shell: ['#'], yaml: ['#'], toml: ['#'], r: ['#'],
  perl: ['#'], elixir: ['#'], julia: ['#'], nim: ['#'], makefile: ['#'], dockerfile: ['#'],
  terraform: ['#', '//'], hcl: ['#', '//'], powershell: ['#'],
  sql: ['--'], haskell: ['--'], lua: ['--'],
  erlang: ['%'],
  clojure: [';'],
}
const DEFAULT_LINE_COMMENT = ['//']

export function lineCommentPrefixes(language: string): string[] {
  return LINE_COMMENT[language] ?? DEFAULT_LINE_COMMENT
}
