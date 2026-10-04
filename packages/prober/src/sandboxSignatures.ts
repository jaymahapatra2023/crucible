/**
 * Telling "this application does not work" apart from "our sandbox would not let it work".
 *
 * The sandbox denies three things an ordinary application does without thinking: reaching the
 * network, writing outside its own directory, and writing to a read-only path. A team that trips
 * one of those has not written a broken application — they have written one that assumes a
 * normal machine, which is what almost every tutorial, framework and deployment guide assumes
 * too. Grading that the same as a crash says something untrue about their work.
 *
 * So a container that dies carrying one of these signatures is recorded as blocked by the
 * sandbox rather than as failing, and the runs dimension takes one point off four instead of
 * all of them. One point, not none: declaring a build that does not start in a documented
 * environment is still the team's to own. It is a deduction, not an exemption.
 *
 * These are matched against the container's own output, which is the team's text, so the
 * matching is deliberately narrow. Each pattern is something only the containment can cause:
 *
 *   - name resolution and unreachable networks, which `--network none` guarantees;
 *   - permission denied on an ABSOLUTE path, which `--user 1000:1000` causes on any
 *     root-owned directory. A relative path is excluded: that is the team's own tree, which
 *     they can write to, and a failure there is theirs;
 *   - read-only filesystems.
 *
 * A false positive costs one point of one dimension and raises a flag a person reads. A false
 * negative costs a team the whole dimension. The asymmetry is the reason these patterns err
 * towards matching.
 */

export interface SandboxBlock {
  /** Which control did it, for the grade reason and the review flag. */
  control: 'NO_NETWORK' | 'UNPRIVILEGED_USER' | 'READ_ONLY_PATH'
  /** The line that matched, trimmed, so a reviewer can see the evidence itself. */
  evidence: string
}

interface Signature {
  control: SandboxBlock['control']
  pattern: RegExp
}

const SIGNATURES: readonly Signature[] = [
  // `--network none`: there is no resolver and no route. Nothing a team writes can produce
  // these messages when the network is present.
  { control: 'NO_NETWORK', pattern: /getaddrinfo\s+(EAI_AGAIN|ENOTFOUND)/i },
  // npm prints the syscall and the code on SEPARATE lines, and these are matched a line at a
  // time, so the bare code has to be a signature of its own. It is a safe one: every one of
  // these comes from name resolution or routing, which only the sandbox removes.
  { control: 'NO_NETWORK', pattern: /\b(EAI_AGAIN|ENOTFOUND)\b/ },
  { control: 'NO_NETWORK', pattern: /request to https?:\/\/\S+ failed/i },
  { control: 'NO_NETWORK', pattern: /Temporary failure in name resolution/i },
  { control: 'NO_NETWORK', pattern: /Could not resolve host/i },
  { control: 'NO_NETWORK', pattern: /Network is unreachable/i },
  { control: 'NO_NETWORK', pattern: /ENETUNREACH/ },
  // npm and pip say it their own way before they say it in errno terms.
  { control: 'NO_NETWORK', pattern: /network.{0,40}(unreachable|not reachable|request to .* failed)/i },
  { control: 'NO_NETWORK', pattern: /Failed to establish a new connection.*Name or service not known/i },

  // `--user 1000:1000` against a root-owned directory. The absolute path is the discriminator:
  // see the note above on why a relative one is not matched.
  { control: 'UNPRIVILEGED_USER', pattern: /(EACCES|[Pp]ermission denied)[^\n]{0,80}['"`\s]\/[^\s'"`]+/ },
  { control: 'UNPRIVILEGED_USER', pattern: /cannot create directory\s*['"`‘]?\/[^\s'"`’]+/i },
  { control: 'UNPRIVILEGED_USER', pattern: /mkdir[^\n]{0,40}\/[^\s'"`]+[^\n]{0,40}[Pp]ermission denied/ },
  { control: 'UNPRIVILEGED_USER', pattern: /open\s*\(?['"`]?\/[^\s'"`]+['"`]?\)?[^\n]{0,40}EACCES/ },

  { control: 'READ_ONLY_PATH', pattern: /EROFS/ },
  { control: 'READ_ONLY_PATH', pattern: /[Rr]ead-only file system/ },
]

/**
 * The first containment signature in the output, or null.
 *
 * Returns the matching LINE rather than the whole log: the grade reason is read by a person, and
 * a reason carrying four hundred lines of stack trace is not read at all.
 */
export function sandboxBlockedBy(output: string): SandboxBlock | null {
  if (output.trim() === '') return null

  for (const line of output.split('\n')) {
    for (const signature of SIGNATURES) {
      if (signature.pattern.test(line)) {
        return { control: signature.control, evidence: line.trim().slice(0, 300) }
      }
    }
  }
  return null
}

/** What the grade says, in a sentence a team and a reviewer read the same way. */
export function describeBlock(block: SandboxBlock): string {
  const cause = {
    NO_NETWORK:
      'it tried to reach the network, which the sandbox denies while an entry is running',
    UNPRIVILEGED_USER:
      'it tried to write outside its own directory, which the sandbox denies by running as an '
      + 'unprivileged user',
    READ_ONLY_PATH: 'it tried to write to a path the sandbox keeps read-only',
  }[block.control]

  return `The application started but stopped because ${cause}. This is a limitation of the `
    + `environment it was given rather than a fault in the work, so it costs one point of four `
    + `on this dimension rather than the whole of it. Evidence: ${block.evidence}`
}
