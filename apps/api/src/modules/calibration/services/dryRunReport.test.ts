/**
 * Grouping dry-run failure causes (E11-S04 acceptance 2).
 *
 * A rehearsal's value is in discovering what KIND of thing goes wrong. Messages carry
 * specifics — a repository URL, a submission id — so grouping on the whole string would report
 * fifty distinct causes for one problem and hide exactly the pattern being looked for.
 */
import { describe, expect, it } from 'vitest'
import { groupCauses } from './dryRunReport.js'

describe('grouping failure causes', () => {
  it('collapses the same KIND of failure despite differing specifics', () => {
    const result = groupCauses([
      'Clone failed: repository github.com/a/b is unreachable',
      'Clone failed: repository github.com/c/d is unreachable',
      'Build timed out after 600s',
    ])

    expect(result[0]).toEqual({ cause: 'Clone failed', count: 2 })
    expect(result[1]?.count).toBe(1)
  })

  it('orders the commonest cause first', () => {
    const result = groupCauses([
      'Rare thing happened', 'Common thing: x', 'Common thing: y', 'Common thing: z',
    ])
    expect(result[0]?.cause).toBe('Common thing')
    expect(result[0]?.count).toBe(3)
  })

  it('does not merge genuinely different causes', () => {
    expect(groupCauses(['Clone failed: x', 'Build failed: y'])).toHaveLength(2)
  })

  it('labels an empty message rather than dropping it', () => {
    expect(groupCauses([''])).toEqual([{ cause: 'Unspecified', count: 1 }])
  })

  it('handles no failures at all', () => {
    expect(groupCauses([])).toEqual([])
  })

  it('truncates a very long cause rather than making it the whole key', () => {
    const long = `${'x'.repeat(300)}: detail`
    expect(groupCauses([long])[0]!.cause.length).toBeLessThanOrEqual(120)
  })
})
