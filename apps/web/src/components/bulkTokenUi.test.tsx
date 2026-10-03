/**
 * Registering a cohort from a file (E20).
 *
 * Two properties matter here and neither is about layout. The check must write nothing — an
 * operator has to be able to look before fifty teams exist. And once tokens have been issued the
 * page must make saving them unmissable, because only their hashes are stored and there is no
 * second chance to read them.
 */
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BulkTokenPanel } from './BulkTokenPanel.js'
import * as api from '../lib/intakeApi.js'
import type { BulkPlan, BulkRow } from '../lib/intakeApi.js'

vi.mock('../lib/intakeApi.js', async (original) => ({
  ...(await original<typeof import('../lib/intakeApi.js')>()),
  bulkTokens: vi.fn(),
}))

const row = (over: Partial<BulkRow> = {}): BulkRow => ({
  line: 2, teamName: 'The Night Shift', contactEmail: 'night@team.test',
  outcome: 'NEW', detail: null, teamId: null, token: null, tokenId: null, ...over,
})

const plan = (over: Partial<BulkPlan> = {}): BulkPlan => ({
  rows: [row()],
  summary: { total: 1, new: 1, existing: 0, invalid: 0, duplicate: 0 },
  issued: false,
  refusal: null,
  ...over,
})

const mocked = () => vi.mocked(api.bulkTokens)
const FILE = 'team_name,contact_email\nThe Night Shift,night@team.test'

/**
 * The panel as the page drives it.
 *
 * The file and the plan are owned by the page, because the intake page blanks to a loading state
 * whenever it refetches and an unmounted panel would take every issued plaintext with it. This
 * harness wires it the same way, so what these tests exercise is what actually runs.
 */
function Harness({
  onSaved = () => {}, onRunForTeams = () => {},
}: {
  onSaved?: () => void
  onRunForTeams?: (confirm: boolean) => void
}) {
  const [csv, setCsv] = useState('')
  const [plan, setPlan] = useState<BulkPlan | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function run(confirm: boolean) {
    setBusy(true)
    setFailure(null)
    try {
      setPlan(await api.bulkTokens(csv, confirm))
    } catch (err) {
      setPlan(null)
      setFailure(err instanceof Error ? err.message : 'That file could not be read.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <BulkTokenPanel
      csv={csv} plan={plan} busy={busy} failure={failure}
      onCsvChange={(next) => { setCsv(next); setPlan(null); setFailure(null) }}
      onRun={(confirm) => void run(confirm)}
      onRunForTeams={onRunForTeams}
      onSaved={onSaved}
    />
  )
}

/**
 * Capture what the download would contain.
 *
 * jsdom's `Blob` has no `.text()`, so the content is read back through `FileReader` — the one
 * reader it does implement. Asserting on the bytes matters more here than anywhere else in this
 * file: the downloaded file is the only place these tokens will ever exist.
 */
function captureDownload(): () => Promise<string> {
  const blobs: Blob[] = []
  URL.createObjectURL = vi.fn((blob: Blob) => { blobs.push(blob); return 'blob:fake' })

  return () => new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('could not read the downloaded file'))
    reader.readAsText(blobs[0]!)
  })
}

async function paste(text = FILE) {
  await userEvent.type(screen.getByLabelText('Teams'), text.replace(/\n/g, '{enter}'))
}

beforeEach(() => {
  mocked().mockReset()
  // The tokens are saved from memory rather than fetched — there is no endpoint that could
  // serve them again — so the download goes through a blob URL, which jsdom does not implement.
  // Only these two are stubbed: replacing the whole URL global breaks jsdom's own machinery.
  URL.createObjectURL = vi.fn(() => 'blob:fake')
  URL.revokeObjectURL = vi.fn()
})

describe('checking a file', () => {
  it('cannot be checked while it is empty', () => {
    render(<Harness />)
    expect(screen.getByRole('button', { name: /check the file/i })).toBeDisabled()
  })

  it('checks WITHOUT confirming, so nothing is written', async () => {
    mocked().mockResolvedValue(plan())
    render(<Harness />)
    await paste()
    await userEvent.click(screen.getByRole('button', { name: /check the file/i }))

    expect(mocked()).toHaveBeenCalledWith(expect.stringContaining('team_name'), false)
  })

  it('shows every row, including the ones that are fine', async () => {
    // "Nothing wrong with this row" has to be visible too; a list of only problems leaves an
    // operator unable to tell a checked file from an unchecked one.
    mocked().mockResolvedValue(plan())
    render(<Harness />)
    await paste()
    await userEvent.click(screen.getByRole('button', { name: /check the file/i }))

    expect(await screen.findByRole('table', { name: /teams in this file/i })).toBeInTheDocument()
    expect(screen.getByText('The Night Shift')).toBeInTheDocument()
    expect(screen.getByText('new team')).toBeInTheDocument()
  })

  it('names the state in words, not only in colour (P5.5)', async () => {
    mocked().mockResolvedValue(plan({
      rows: [row({ outcome: 'INVALID', detail: '"nope" is not an email address.' })],
      summary: { total: 1, new: 0, existing: 0, invalid: 1, duplicate: 0 },
    }))
    render(<Harness />)
    await paste()
    await userEvent.click(screen.getByRole('button', { name: /check the file/i }))

    expect(await screen.findByText('cannot be read')).toBeInTheDocument()
    expect(screen.getByText(/is not an email address/)).toBeInTheDocument()
  })

  it('REFUSES to register while any row cannot be acted on', async () => {
    mocked().mockResolvedValue(plan({
      rows: [row(), row({ line: 3, outcome: 'DUPLICATE', detail: 'Appears on line 2.' })],
      summary: { total: 2, new: 1, existing: 0, invalid: 0, duplicate: 1 },
    }))
    render(<Harness />)
    await paste()
    await userEvent.click(screen.getByRole('button', { name: /check the file/i }))

    expect(await screen.findByRole('button', { name: /register 2 teams/i })).toBeDisabled()
    expect(screen.getByText(/Fix the 1 row below first/i)).toBeInTheDocument()
  })

  it('says a row matches a team that already exists, before creating a second', async () => {
    mocked().mockResolvedValue(plan({
      rows: [row({
        outcome: 'EXISTING', teamId: 7,
        detail: 'Already registered as "Night Shift". This issues a REPLACEMENT token.',
      })],
      summary: { total: 1, new: 0, existing: 1, invalid: 0, duplicate: 0 },
    }))
    render(<Harness />)
    await paste()
    await userEvent.click(screen.getByRole('button', { name: /check the file/i }))

    expect(await screen.findByText('already registered')).toBeInTheDocument()
    expect(screen.getByText(/REPLACEMENT token/)).toBeInTheDocument()
  })

  it('reports a file it cannot read as an error, not as an empty plan', async () => {
    mocked().mockRejectedValue(new Error('Line 1: The header row is missing team_name.'))
    render(<Harness />)
    await paste('nonsense')
    await userEvent.click(screen.getByRole('button', { name: /check the file/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/header row is missing/)
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('discards a stale plan as soon as the file is edited', async () => {
    // A plan shown beside a file it was not computed from is worse than no plan.
    mocked().mockResolvedValue(plan())
    render(<Harness />)
    await paste()
    await userEvent.click(screen.getByRole('button', { name: /check the file/i }))
    expect(await screen.findByRole('table')).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText('Teams'), 'x')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})

describe('after the tokens exist', () => {
  const issued = plan({
    rows: [row({ token: 'crs_abc123', teamId: 7 })],
    issued: true,
  })

  it('says plainly that this is the only chance to read them', async () => {
    mocked().mockResolvedValueOnce(plan()).mockResolvedValueOnce(issued)
    render(<Harness />)
    await paste()
    await userEvent.click(screen.getByRole('button', { name: /check the file/i }))
    await userEvent.click(await screen.findByRole('button', { name: /register 1 team/i }))

    expect(await screen.findByText(/Save them now/i)).toBeInTheDocument()
    expect(screen.getByText(/only time they can be read/i)).toBeInTheDocument()
  })

  it('confirms before issuing, and only then', async () => {
    mocked().mockResolvedValueOnce(plan()).mockResolvedValueOnce(issued)
    render(<Harness />)
    await paste()
    await userEvent.click(screen.getByRole('button', { name: /check the file/i }))
    await userEvent.click(await screen.findByRole('button', { name: /register 1 team/i }))

    expect(mocked().mock.calls.map((c) => c[1])).toEqual([false, true])
  })

  it('tells the page ONLY once the tokens are in a file', async () => {
    // Refreshing at issue time would unmount this panel and destroy the only copy of them —
    // which is precisely what happened the first time this was wired up.
    const onSaved = vi.fn()
    mocked().mockResolvedValueOnce(plan()).mockResolvedValueOnce(issued)
    render(<Harness onSaved={onSaved} />)
    await paste()
    await userEvent.click(screen.getByRole('button', { name: /check the file/i }))
    await userEvent.click(await screen.findByRole('button', { name: /register 1 team/i }))
    expect(onSaved).not.toHaveBeenCalled()

    await userEvent.click(await screen.findByRole('button', { name: /download the tokens/i }))
    expect(onSaved).toHaveBeenCalledOnce()
  })

  it('puts the TOKENS in the downloaded file, beside the team and the contact', async () => {
    // The one artifact that matters. A file of team names with an empty token column is the
    // failure this whole path exists to avoid, and nothing else would reveal it.
    const saved = captureDownload()

    mocked().mockResolvedValueOnce(plan()).mockResolvedValueOnce(issued)
    render(<Harness />)
    await paste()
    await userEvent.click(screen.getByRole('button', { name: /check the file/i }))
    await userEvent.click(await screen.findByRole('button', { name: /register 1 team/i }))
    await userEvent.click(await screen.findByRole('button', { name: /download the tokens/i }))

    const text = await saved()
    // Every cell quoted — the shared writer's format, so this file matches the server's.
    expect(text.split('\n')[0]).toBe('"team_name","contact_email","token","status"')
    expect(text).toContain('"The Night Shift","night@team.test","crs_abc123","new"')
  })

  it('marks a replaced token as a replacement, so the old one is known to be superseded', async () => {
    const saved = captureDownload()

    mocked().mockResolvedValueOnce(plan()).mockResolvedValueOnce(plan({
      rows: [row({ outcome: 'EXISTING', teamId: 7, token: 'crs_replaced' })],
      summary: { total: 1, new: 0, existing: 1, invalid: 0, duplicate: 0 },
      issued: true,
    }))
    render(<Harness />)
    await paste()
    await userEvent.click(screen.getByRole('button', { name: /check the file/i }))
    await userEvent.click(await screen.findByRole('button', { name: /register 1 team/i }))
    await userEvent.click(await screen.findByRole('button', { name: /download the tokens/i }))

    expect(await saved()).toContain('"crs_replaced","replacement"')
  })

  it('offers no register button once they are issued — it would issue a second set', async () => {
    mocked().mockResolvedValueOnce(plan()).mockResolvedValueOnce(issued)
    render(<Harness />)
    await paste()
    await userEvent.click(screen.getByRole('button', { name: /check the file/i }))
    await userEvent.click(await screen.findByRole('button', { name: /register 1 team/i }))

    expect(await screen.findByText(/Save them now/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^register/i })).not.toBeInTheDocument()
  })

  it('shows the refusal when the file was rejected whole', async () => {
    mocked().mockResolvedValue(plan({
      rows: [row({ outcome: 'INVALID', detail: 'Bad.' })],
      summary: { total: 1, new: 0, existing: 0, invalid: 1, duplicate: 0 },
      refusal: 'Nothing was issued. 1 of 1 rows cannot be acted on.',
    }))
    render(<Harness />)
    await paste()
    await userEvent.click(screen.getByRole('button', { name: /check the file/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/Nothing was issued/)
  })
})

describe('issuing for the teams that already exist (E29-S01)', () => {
  it('offers it without a file, because the roster has already built them', async () => {
    const onRunForTeams = vi.fn()
    render(<Harness onRunForTeams={onRunForTeams} />)

    await userEvent.click(screen.getByRole('button', { name: /check teams without a token/i }))
    expect(onRunForTeams).toHaveBeenCalledWith(false)
  })

  it('says a file is only for teams that do not exist yet', () => {
    render(<Harness />)
    expect(screen.getByText(/need no file/i)).toBeInTheDocument()
  })
})
