/**
 * The documents a team attached, on the page a placement rests on (E36).
 *
 * These links were recorded on every submission since E03 and shown nowhere, so the tests are
 * about them being visible — including the ones that could not be read, which are a worklist
 * rather than an absence.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ArtifactPanel } from './ArtifactPanel.js'
import type { SubmissionArtifact } from '../lib/artifactApi.js'

const artifact = (over: Partial<SubmissionArtifact> = {}): SubmissionArtifact => ({
  artifactId: 1, submissionId: 9, url: 'https://github.com/a/arch.md', status: 'FETCHED',
  contentType: 'text/markdown', bytes: 120, textContent: 'We used an event log.',
  detail: '', fetchedAt: '2026-10-04T00:00:00Z', ...over,
})

const props = { busy: false, onFetch: vi.fn() }

describe('what was read', () => {
  it('shows the document text as quoted evidence', () => {
    render(<ArtifactPanel {...props} artifacts={[artifact()]} />)
    expect(screen.getByText('We used an event log.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /arch.md/ })).toBeInTheDocument()
  })

  it('opens a team-supplied link without handing it the opener', () => {
    // The URL came from a competition entrant; rel keeps the new tab from reaching back.
    render(<ArtifactPanel {...props} artifacts={[artifact()]} />)
    expect(screen.getByRole('link', { name: /arch.md/ }))
      .toHaveAttribute('rel', expect.stringContaining('noopener'))
  })

  it('says when it only read part of a document', () => {
    render(<ArtifactPanel {...props} artifacts={[artifact({
      detail: 'Read the first 40000 characters of 120000.',
    })]} />)
    expect(screen.getByText(/Read the first 40000 characters/)).toBeInTheDocument()
  })
})

describe('what was not read', () => {
  it('lists a refused link with the reason, rather than dropping it', () => {
    render(<ArtifactPanel {...props} artifacts={[artifact({
      status: 'REFUSED', textContent: null, contentType: null,
      detail: 'figma.com is not an allowed host for supporting links.',
    })]} />)

    expect(screen.getByText(/refused/)).toBeInTheDocument()
    expect(screen.getByText(/figma.com is not an allowed host/)).toBeInTheDocument()
  })

  it('distinguishes "nothing attached" from "nothing fetched yet"', () => {
    render(<ArtifactPanel {...props} artifacts={[]} />)
    expect(screen.getByText(/attached no supporting links, or nobody has fetched them yet/))
      .toBeInTheDocument()
  })
})

describe('who may cause a fetch', () => {
  it('offers the control to a reader who may fetch', async () => {
    const onFetch = vi.fn()
    const user = userEvent.setup()
    render(<ArtifactPanel {...props} artifacts={[]} onFetch={onFetch} />)

    await user.click(screen.getByRole('button', { name: 'Fetch attached documents' }))
    expect(onFetch).toHaveBeenCalled()
  })

  it('shows no control at all to a reader who may not', () => {
    // Absent rather than present-and-refused: fetching reaches an address an entrant chose.
    render(<ArtifactPanel {...props} artifacts={[artifact()]} onFetch={null} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    // They still see what was read.
    expect(screen.getByText('We used an event log.')).toBeInTheDocument()
  })
})
