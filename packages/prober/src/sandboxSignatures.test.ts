/**
 * Telling our containment apart from a team's bug.
 *
 * The asymmetry drives these cases: a false positive costs one point of one dimension and
 * raises a flag a person reads; a false negative costs a team the whole dimension. So the
 * patterns err towards matching — but they must still not match an ordinary application crash,
 * because then nothing is ever graded as failing and the dimension measures nothing.
 */
import { describe, expect, it } from 'vitest'
import { describeBlock, sandboxBlockedBy } from './sandboxSignatures.js'

describe('what the sandbox denied', () => {
  it('catches the no-network failure that cost the event its first entry', () => {
    const block = sandboxBlockedBy(
      'npm error code EAI_AGAIN\nnpm error syscall getaddrinfo\n'
      + 'npm error errno EAI_AGAIN\nnpm error request to https://registry.npmjs.org failed',
    )
    expect(block?.control).toBe('NO_NETWORK')
  })

  it('catches the unprivileged-write failure from a real Dockerfile CMD', () => {
    // Verbatim from the second entry checked at the event: `mkdir -p /data` in its CMD.
    const block = sandboxBlockedBy("mkdir: cannot create directory '/data': Permission denied")
    expect(block?.control).toBe('UNPRIVILEGED_USER')
    expect(block?.evidence).toContain('/data')
  })

  it('catches the EACCES form npm produces', () => {
    const block = sandboxBlockedBy(
      "npm error Error: EACCES: permission denied, open '/work/package-lock.json'",
    )
    expect(block?.control).toBe('UNPRIVILEGED_USER')
  })

  it('catches python and curl wording as well as node', () => {
    expect(sandboxBlockedBy('socket.gaierror: [Errno -3] Temporary failure in name resolution')
      ?.control).toBe('NO_NETWORK')
    expect(sandboxBlockedBy('curl: (6) Could not resolve host: api.anthropic.com')
      ?.control).toBe('NO_NETWORK')
    expect(sandboxBlockedBy('OSError: [Errno 101] Network is unreachable')
      ?.control).toBe('NO_NETWORK')
  })

  it('catches a read-only path', () => {
    expect(sandboxBlockedBy('Error: EROFS: read-only file system')?.control)
      .toBe('READ_ONLY_PATH')
  })

  it('does NOT excuse an ordinary crash', () => {
    // The whole dimension depends on these staying unmatched. A system that forgave everything
    // would score every broken entry 3 of 4 and measure nothing at all.
    for (const log of [
      'TypeError: Cannot read properties of undefined (reading \'name\')',
      'Traceback (most recent call last):\n  File "app.py", line 3\nZeroDivisionError: division by zero',
      'Error: listen EADDRINUSE: address already in use :::3000',
      'SyntaxError: Unexpected token }',
      'Error: Cannot find module \'express\'',
      'psql: FATAL: database "app" does not exist',
      '',
      '   ',
    ]) {
      expect(sandboxBlockedBy(log), log.slice(0, 40)).toBeNull()
    }
  })

  it('does NOT excuse a permission error on the team’s OWN relative path', () => {
    // Their own tree is writable; a failure there is theirs. The absolute path is what
    // distinguishes our root-owned directories from their repository.
    expect(sandboxBlockedBy('EACCES: permission denied, open \'build/output.txt\'')).toBeNull()
  })

  it('reports the matching line, not the whole log, and caps it', () => {
    const block = sandboxBlockedBy(`${'noise\n'.repeat(50)}curl: (6) Could not resolve host: x.test`)
    expect(block?.evidence).toBe('curl: (6) Could not resolve host: x.test')

    const long = sandboxBlockedBy(`Could not resolve host: ${'a'.repeat(900)}`)
    expect(long!.evidence.length).toBeLessThanOrEqual(300)
  })

  it('explains the deduction in words a team and a reviewer read the same way', () => {
    const text = describeBlock({ control: 'NO_NETWORK', evidence: 'getaddrinfo EAI_AGAIN' })
    expect(text).toContain('one point of four')
    expect(text).toContain('rather than a fault in the work')
    expect(text).toContain('getaddrinfo EAI_AGAIN')
  })
})
