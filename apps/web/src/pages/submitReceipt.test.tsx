/**
 * What a team is told about their commit (E38).
 *
 * The receipt had two states — a locked commit, or "the repository could not be read" — and
 * showed the second whenever no commit was locked. But commits are locked when the intake window
 * CLOSES, not at submit time, so every team who submitted successfully before the deadline was
 * told their repository could not be read.
 *
 * That is the worst kind of false alarm: on the one screen entrants see, at the moment they have
 * just succeeded, telling them to fix something that is not broken.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CommitLine } from './SubmitPage.js'
import type { SubmissionReceipt } from '../lib/submitApi.js'

const receipt = (over: Partial<SubmissionReceipt> = {}): SubmissionReceipt => ({
  submissionId: 1, teamName: 'Demo Team', challengeId: 8,
  repoUrl: 'https://github.com/a/b', version: 1,
  validationStatus: 'VALID', validationDetail: 'The repository is public and was cloned successfully.',
  lockedCommitSha: null, ...over,
} as SubmissionReceipt)

describe('a validated entry before the window closes', () => {
  it('reassures rather than warning — this is the ordinary successful path', () => {
    render(<CommitLine receipt={receipt()} />)

    expect(screen.getByText(/read successfully/)).toBeInTheDocument()
    expect(screen.getByText(/taken when intake closes/)).toBeInTheDocument()
    // The false alarm that sent teams chasing permissions that were always correct.
    expect(screen.queryByText(/could not be read/)).not.toBeInTheDocument()
  })

  it('tells them to keep working, because their later commits still count', () => {
    render(<CommitLine receipt={receipt()} />)
    expect(screen.getByText(/keep working/)).toBeInTheDocument()
  })
})

describe('an entry whose repository really could not be read', () => {
  it('still says so plainly', () => {
    render(<CommitLine receipt={receipt({
      validationStatus: 'PRIVATE', lockedCommitSha: null,
    })} />)

    expect(screen.getByText(/could not be read/)).toBeInTheDocument()
    expect(screen.getByText(/submit again/)).toBeInTheDocument()
  })

  it('says the entry is recorded regardless, so nobody thinks they have lost it', () => {
    render(<CommitLine receipt={receipt({ validationStatus: 'UNREACHABLE' })} />)
    expect(screen.getByText(/entry is recorded/)).toBeInTheDocument()
  })
})

describe('an entry whose checks ran out of time (E45-S02)', () => {
  it('says the checks will run again, and does not tell the team to fix anything', () => {
    render(<CommitLine receipt={receipt({ validationStatus: 'PENDING' })} />)

    expect(screen.getByText(/run again/)).toBeInTheDocument()
    expect(screen.getByText(/nothing for you to fix/)).toBeInTheDocument()
    expect(screen.queryByText(/could not be read/)).not.toBeInTheDocument()
  })
})

describe('once the window has closed', () => {
  it('names the exact commit and says later pushes will not change it', () => {
    render(<CommitLine receipt={receipt({ lockedCommitSha: 'a'.repeat(40) })} />)

    expect(screen.getByText('a'.repeat(40))).toBeInTheDocument()
    expect(screen.getByText(/Pushing more work will not change it/)).toBeInTheDocument()
  })
})
