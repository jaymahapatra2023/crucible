/**
 * Committed-credential detection (E46-S01).
 *
 * Runs over the files a scan already read — never over the working tree — so it costs no clone
 * and sees exactly what the evaluator will see. A finding names the file, the line and the KIND
 * of credential. It never carries the matched text: a report that quoted the secret would be a
 * second place it was committed (P8.3).
 *
 * Deliberately a short list of high-precision patterns rather than an entropy scan. A false
 * positive here emails a team that they leaked something they did not, on the one weekend they
 * cannot afford the detour; a miss is caught by a human reading the file. Precision wins.
 */

export interface SecretFinding {
  path: string
  /** 1-based. */
  line: number
  kind: string
}

interface Pattern {
  kind: string
  test: RegExp
}

/** Provider-issued formats with fixed prefixes, and PEM private-key headers. */
const PATTERNS: readonly Pattern[] = [
  { kind: 'private key', test: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/ },
  { kind: 'AWS access key id', test: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: 'GitHub token', test: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { kind: 'GitHub fine-grained token', test: /\bgithub_pat_[A-Za-z0-9_]{80,}\b/ },
  { kind: 'GitLab token', test: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { kind: 'Slack token', test: /\bxox[abpr]-[0-9A-Za-z-]{10,}\b/ },
  { kind: 'Stripe live key', test: /\b[sr]k_live_[0-9A-Za-z]{20,}\b/ },
  { kind: 'Anthropic API key', test: /\bsk-ant-[A-Za-z0-9_-]{30,}\b/ },
  { kind: 'OpenAI API key', test: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/ },
  { kind: 'Google API key', test: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'SendGrid API key', test: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/ },
  { kind: 'Twilio account SID', test: /\bAC[0-9a-f]{32}\b/ },
  { kind: 'npm token', test: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { kind: 'connection string with password', test: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:/@]+:[^\s@/]{6,}@[^\s]+/i },
]

/**
 * Lines that are plainly documentation of the format rather than a value: a placeholder, an
 * example, or the pattern spelled out in a comment. Judged per line, so a real key on the next
 * line is still found.
 */
const PLACEHOLDER = /\b(?:example|placeholder|your[_-]?(?:key|token|secret)|xxxx|<[^>]+>|redacted|dummy|sample)\b/i

/** Files whose whole purpose is to hold examples of the format. */
const EXAMPLE_PATHS = /(?:^|\/)(?:\.env\.(?:example|sample|template)|[^/]*\.(?:md|rst|txt))$/i

export function findCommittedSecrets(
  files: ReadonlyArray<{ path: string; content: string }>,
): SecretFinding[] {
  const findings: SecretFinding[] = []

  for (const file of files) {
    if (EXAMPLE_PATHS.test(file.path)) continue
    const lines = file.content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (PLACEHOLDER.test(line)) continue
      for (const pattern of PATTERNS) {
        if (pattern.test.test(line)) {
          findings.push({ path: file.path, line: i + 1, kind: pattern.kind })
          break
        }
      }
    }
  }

  return findings
}

/** One line per finding, for a team. Names the place and the kind; never the value. */
export function describeSecret(finding: SecretFinding): string {
  return `${finding.path} line ${finding.line}: looks like a ${finding.kind}`
}
