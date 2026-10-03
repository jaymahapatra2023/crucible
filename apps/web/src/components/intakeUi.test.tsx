/**
 * The team submission and challenge-setup surfaces (E02, E03-S01).
 *
 * Two failures these exist to prevent, both of which only show up after a deadline has passed:
 * a team submitting a build configuration that cannot work, and an organiser generating a rubric
 * from a brief whose text was never read.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BuildFields, IntakeBanner, SubmissionProblems } from './BuildFields.js'
import { ArtifactList, NewChallengeForm, RubricList } from './ChallengeSetup.js'
import { submissionProblems, type SubmissionDraft } from '../lib/submitApi.js'
import type { Artifact } from '../lib/challengeApi.js'

const draft = (over: Partial<SubmissionDraft> = {}): SubmissionDraft => ({
  contactEmail: 'team@example.com', challengeId: 1,
  repoUrl: 'https://github.com/team/project', buildMethod: 'DOCKERFILE',
  dockerfilePath: 'Dockerfile', artifactUrls: [], ...over,
})

describe('what a team must get right before submitting', () => {
  it('accepts a complete entry', () => {
    expect(submissionProblems(draft(), 'a-token')).toEqual([])
  })

  it('asks for the submission token, and says where it came from', () => {
    expect(submissionProblems(draft(), '').join(' '))
      .toMatch(/token your organiser sent with your team invitation/i)
  })

  it('requires a Dockerfile path when the build method is DOCKERFILE', () => {
    expect(submissionProblems(draft({ dockerfilePath: '' }), 't').join(' '))
      .toMatch(/path to your Dockerfile/i)
  })

  it('requires a build command when the build method is COMMAND', () => {
    expect(submissionProblems(draft({ buildMethod: 'COMMAND' }), 't').join(' '))
      .toMatch(/command that builds and starts/i)
  })

  it('does not demand a Dockerfile path when the method is COMMAND', () => {
    const problems = submissionProblems(
      draft({ buildMethod: 'COMMAND', buildCommand: 'npm start', dockerfilePath: '' }), 't')
    expect(problems).toEqual([])
  })

  it('accepts an ssh remote as well as https', () => {
    expect(submissionProblems(draft({ repoUrl: 'git@github.com:team/project.git' }), 't'))
      .toEqual([])
  })

  it('rejects a repository that is not a URL at all', () => {
    expect(submissionProblems(draft({ repoUrl: 'team/project' }), 't').join(' '))
      .toMatch(/starting with https:\/\/ or git@/)
  })

  it('asks which challenge is being entered', () => {
    expect(submissionProblems(draft({ challengeId: 0 }), 't').join(' '))
      .toMatch(/Choose the challenge/i)
  })
})

describe('the build fields', () => {
  it('swaps to a command field when the method changes', async () => {
    const onChange = vi.fn()
    render(<BuildFields draft={draft()} onChange={onChange} />)
    await userEvent.selectOptions(screen.getByLabelText(/How your project builds/), 'COMMAND')
    expect(onChange).toHaveBeenCalledWith('buildMethod', 'COMMAND')
  })

  it('shows the command field for a COMMAND build and no Dockerfile field', () => {
    render(<BuildFields draft={draft({ buildMethod: 'COMMAND' })} onChange={vi.fn()} />)
    expect(screen.getByLabelText(/Build and start command/)).toBeInTheDocument()
    expect(screen.queryByLabelText(/Dockerfile path/)).not.toBeInTheDocument()
  })

  it('says what getting the build method wrong costs', () => {
    render(<BuildFields draft={draft()} onChange={vi.fn()} />)
    expect(screen.getByText(/difference between 'runs' and 'could not be built'/i))
      .toBeInTheDocument()
  })
})

describe('the intake banner', () => {
  it('states the window before a team fills anything in', () => {
    render(<IntakeBanner state="OPEN" message="Entries are being accepted." closesAt={null} />)
    expect(screen.getByRole('status')).toHaveTextContent('OPEN')
  })

  it('does not advertise a closing time for a window that is not open', () => {
    render(<IntakeBanner state="LOCKED" message="Intake is locked."
      closesAt="2026-01-01T00:00:00Z" />)
    expect(screen.getByRole('status')).not.toHaveTextContent(/Entries close/)
  })
})

describe('submission problems', () => {
  it('renders nothing before there is anything to say', () => {
    const { container } = render(<SubmissionProblems problems={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('is announced, because a team that cannot see it misses the deadline', () => {
    render(<SubmissionProblems problems={['Enter your team name.']} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Enter your team name.')
  })
})

const artifact = (over: Partial<Artifact> = {}): Artifact => ({
  artifactId: 1, challengeId: 1, kind: 'BRIEF', filename: 'brief.pdf',
  mediaType: 'application/pdf', bytes: 1024, extractionStatus: 'EXTRACTED',
  extractionError: null, extractedAt: null, ...over,
})

describe('challenge setup', () => {
  it('says the brief comes first, because criteria are derived from it', () => {
    render(<ArtifactList artifacts={[]} />)
    expect(screen.getByText(/Criteria are derived from the brief, so this comes first/i))
      .toBeInTheDocument()
  })

  it('shows extraction status per document, not as one summary', () => {
    // A brief that could not be read produces no criteria; an organiser who sees only an
    // aggregate will generate a rubric from whichever documents happened to work.
    render(<ArtifactList artifacts={[
      artifact({ artifactId: 1, filename: 'brief.pdf' }),
      artifact({ artifactId: 2, filename: 'scan.pdf', extractionStatus: 'FAILED',
        extractionError: 'No text layer.' }),
    ]} />)
    expect(screen.getByText('EXTRACTED')).toBeInTheDocument()
    expect(screen.getByText('FAILED')).toBeInTheDocument()
    expect(screen.getByText(/No text layer\./)).toBeInTheDocument()
  })

  it('explains why a rubric cannot be generated from an unread brief', () => {
    render(<RubricList rubrics={[]} />)
    expect(screen.getByText(/cite passages nobody can check/i)).toBeInTheDocument()
  })

  it('will not create a challenge without a name', async () => {
    const onCreate = vi.fn()
    render(<NewChallengeForm busy={false} onCreate={onCreate} onCancel={vi.fn()} />)
    expect(screen.getByRole('button', { name: /create challenge/i })).toBeDisabled()
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('creates a challenge from a name alone', async () => {
    const onCreate = vi.fn()
    render(<NewChallengeForm busy={false} onCreate={onCreate} onCancel={vi.fn()} />)
    await userEvent.type(screen.getByLabelText(/Name/), 'Rostering')
    await userEvent.click(screen.getByRole('button', { name: /create challenge/i }))
    expect(onCreate).toHaveBeenCalledWith({ name: 'Rostering', description: '' })
  })
})
