/**
 * What the holistic evaluator shows the model.
 *
 * The experiment's whole claim is that it sends the repository rather than a selection, so the
 * part worth pinning is the budget: what goes, what is left out, and whether the row says so.
 * A comparison that quietly sent all of one repository and half of another would prove nothing.
 */
import { describe, expect, it } from 'vitest'
import { wholeRepoSpans } from './holisticEvaluator.js'

const file = (path: string, bytes: number, truncated = false) => ({
  path, content: 'x'.repeat(bytes), truncated,
})

describe('what is sent', () => {
  it('sends every file when the budget allows, in the order the scanner chose', () => {
    const files = [file('README.md', 100), file('src/a.js', 200), file('src/b.js', 300)]
    const out = wholeRepoSpans(files, { budgetBytes: 10_000, maxFiles: 50 })

    expect(out.spans.map((s) => s.label)).toEqual(['README.md', 'src/a.js', 'src/b.js'])
    expect(out.bytes).toBe(600)
    expect(out.truncated).toBe(false)
  })

  it('stops at the byte budget and SAYS it was truncated', () => {
    const files = [file('a.js', 400), file('b.js', 400), file('c.js', 400)]
    const out = wholeRepoSpans(files, { budgetBytes: 900, maxFiles: 50 })

    expect(out.spans).toHaveLength(2)
    expect(out.bytes).toBe(800)
    expect(out.truncated).toBe(true)
  })

  it('keeps going past one oversized file rather than stopping the repository at it', () => {
    // A vendored bundle or a large data file should not cost the model every file after it.
    const files = [file('small.js', 100), file('huge.json', 5_000), file('also-small.js', 100)]
    const out = wholeRepoSpans(files, { budgetBytes: 1_000, maxFiles: 50 })

    expect(out.spans.map((s) => s.label)).toEqual(['small.js', 'also-small.js'])
    expect(out.truncated).toBe(true)
  })

  it('stops at the file count and says so, even when the bytes would have fitted', () => {
    const files = [file('a.js', 10), file('b.js', 10), file('c.js', 10)]
    const out = wholeRepoSpans(files, { budgetBytes: 10_000, maxFiles: 2 })

    expect(out.spans).toHaveLength(2)
    expect(out.truncated).toBe(true)
  })

  it('labels a file the scan itself cut short, so the model is not told it has the whole file', () => {
    const out = wholeRepoSpans([file('big.js', 50, true)], { budgetBytes: 10_000, maxFiles: 50 })
    expect(out.spans[0]?.label).toBe('big.js (cut short by the scan)')
  })

  it('sends nothing, and claims nothing, for an empty scan', () => {
    const out = wholeRepoSpans([], { budgetBytes: 10_000, maxFiles: 50 })
    expect(out).toEqual({ spans: [], bytes: 0, truncated: false })
  })

  it('carries the file content verbatim — selection is the thing being removed', () => {
    const out = wholeRepoSpans([{ path: 'x.js', content: 'const a = 1\nconst b = 2', truncated: false }],
      { budgetBytes: 1_000, maxFiles: 10 })
    expect(out.spans[0]?.content).toBe('const a = 1\nconst b = 2')
  })
})
