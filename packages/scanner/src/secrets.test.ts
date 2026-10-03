/**
 * Committed-credential detection (E46-S01).
 *
 * The property that matters most is the last describe: a finding never contains the secret.
 */
import { describe, expect, it } from 'vitest'
import { describeSecret, findCommittedSecrets } from './secrets.js'

const file = (path: string, content: string) => ({ path, content })

describe('what is found', () => {
  it('finds a PEM private key', () => {
    const found = findCommittedSecrets([file('deploy/id_rsa', '-----BEGIN RSA PRIVATE KEY-----\nMIIE...')])
    expect(found).toEqual([{ path: 'deploy/id_rsa', line: 1, kind: 'private key' }])
  })

  it('finds an AWS access key id and says which line', () => {
    const found = findCommittedSecrets([file('src/config.js', `const region = 'eu-west-1'\nconst key = 'AKIAIOSFODNN7EXAMPLX'\n`)])
    expect(found).toEqual([{ path: 'src/config.js', line: 2, kind: 'AWS access key id' }])
  })

  it('finds a GitHub token', () => {
    const token = 'ghp_' + 'a'.repeat(36)
    expect(findCommittedSecrets([file('ci.sh', `export GH=${token}`)])[0]?.kind).toBe('GitHub token')
  })

  it('finds a connection string that carries a password', () => {
    const found = findCommittedSecrets([file('src/db.ts', "const url = 'postgres://app:s3cretpass@db.internal:5432/app'")])
    expect(found[0]?.kind).toBe('connection string with password')
  })

  it('reports one finding per line, not one per matching pattern', () => {
    const line = `AKIAIOSFODNN7EXAMPLX ghp_${'b'.repeat(36)}`
    expect(findCommittedSecrets([file('a.txt.js', line)])).toHaveLength(1)
  })
})

describe('what is deliberately not found', () => {
  it('ignores documentation of the format', () => {
    expect(findCommittedSecrets([file('README.md', 'Set AWS_KEY to AKIAIOSFODNN7EXAMPLX')])).toEqual([])
    expect(findCommittedSecrets([file('.env.example', 'STRIPE=sk_live_' + 'x'.repeat(24))])).toEqual([])
  })

  it('ignores a line that says it is a placeholder', () => {
    expect(findCommittedSecrets([file('src/config.js', `key: 'AKIAIOSFODNN7EXAMPLX' // example only`)]))
      .toEqual([])
  })

  it('does not fire on an ordinary short identifier', () => {
    expect(findCommittedSecrets([file('src/a.ts', `const sk = 'sk-short'\nconst id = 'AC12'`)])).toEqual([])
  })
})

describe('a finding never contains the secret', () => {
  it('describes the place and the kind only', () => {
    const secret = 'AKIAIOSFODNN7EXAMPLX'
    const found = findCommittedSecrets([file('src/config.js', `key = '${secret}'`)])
    const text = JSON.stringify(found) + describeSecret(found[0]!)
    expect(text).not.toContain(secret)
    expect(describeSecret(found[0]!)).toBe('src/config.js line 1: looks like a AWS access key id')
  })
})
