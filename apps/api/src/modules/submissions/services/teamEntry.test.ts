/**
 * What a team is told about their own entry (E17-S03 acceptance 3).
 *
 * The text is the feature. A team reading this has no access to logs, no intake dashboard and
 * no account — they have a repository they can change and a deadline. Each line therefore has
 * to name an action, and "something went wrong" names none.
 */
import { describe, expect, it } from 'vitest'
import { remedyFor } from './teamEntry.js'
import { VALIDATION_STATUSES } from '../types/submissionTypes.js'

describe('what a team is told to do', () => {
  it('says nothing when there is nothing to do', () => {
    expect(remedyFor('VALID', null)).toBeNull()
  })

  it('names an action for every outcome that is not VALID', () => {
    // Asserted across the whole enum rather than one case at a time: a status added later with
    // no guidance behind it would be a team told their entry is broken and not told why.
    for (const status of VALIDATION_STATUSES) {
      if (status === 'VALID') continue
      expect(remedyFor(status, 'detail'), status).not.toBeNull()
    }
  })

  it('tells a team with a private repository the two ways out of it', () => {
    const remedy = remedyFor('PRIVATE', null)!
    expect(remedy).toMatch(/public/i)
    expect(remedy).toMatch(/re-grant access/i)
    expect(remedy).toMatch(/submit again/i)
  })

  it('distinguishes unreachable from private — they need different fixes', () => {
    expect(remedyFor('UNREACHABLE', null)).not.toEqual(remedyFor('PRIVATE', null))
    expect(remedyFor('UNREACHABLE', null)).toMatch(/address/i)
  })

  it('carries the specific reason into a rejection, not a generic one', () => {
    expect(remedyFor('REJECTED', 'Repositories must be hosted on github.com.'))
      .toMatch(/must be hosted on github\.com/)
  })

  it('still says something useful when a rejection carries no detail', () => {
    expect(remedyFor('REJECTED', null)).toMatch(/could not be used/)
  })

  it('does not tell a team to act while we are still looking', () => {
    // PENDING is our state, not theirs. Telling them to fix something would be wrong.
    expect(remedyFor('PENDING', null)).toMatch(/Check back/i)
  })
})
