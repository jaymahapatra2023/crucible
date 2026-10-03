import { useState } from 'react'
import { TextInput } from './FormField.js'
import { DataTable } from './DataTable.js'
import { ParticipantRow } from './ParticipantRow.js'
import type { Participant, PeopleQuery } from '../lib/rosterApi.js'

/**
 * The participant list, added to and corrected by hand (E31-S01).
 *
 * The import loads two hundred people before the day. This is for the one who registered on the
 * morning, and for the address that was typed wrong — both certain at this volume, and neither
 * worth re-importing a whole file to fix.
 *
 * The add form is at the top and stays open: adding one person is usually adding three, and a
 * form that collapses after each save turns three additions into six interactions.
 */
export function PeoplePanel({
  people, total, busy, query, onQuery, onAdd, onSave, onRemove,
}: {
  people: readonly Participant[]
  /** The real backend count under the current search (P5.7). */
  total: number
  busy: boolean
  /**
   * Search, sort and page — held by the page, not here.
   *
   * Searching now asks the server rather than filtering the rows in hand: at two hundred
   * participants across pages, filtering the page you were given searches a quarter of the
   * roster and reports confidently that nobody matches.
   */
  query: PeopleQuery
  onQuery: (next: PeopleQuery) => void
  onAdd: (input: {
    fullName: string; email: string; organisation: string | null; discordUsername: string | null
  }) => void
  onSave: (participantId: number, changes: Partial<Participant>) => void
  onRemove: (participantId: number, reason: string) => void
}) {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [organisation, setOrganisation] = useState('')
  const [discord, setDiscord] = useState('')

  const ready = fullName.trim().length >= 2 && /.+@.+\..+/.test(email.trim())

  return (
    <section>
      <h2 style={{ fontSize: 15 }}>Participants</h2>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!ready) return
          onAdd({
            fullName: fullName.trim(),
            email: email.trim(),
            organisation: organisation.trim() === '' ? null : organisation.trim(),
            discordUsername: discord.trim() === '' ? null : discord.trim(),
          })
          setFullName(''); setEmail(''); setOrganisation(''); setDiscord('')
        }}
        style={{
          display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center',
          border: '1px solid var(--border)', borderRadius: 8, padding: 10, marginBottom: 12,
        }}
      >
        <TextInput aria-label="Full name" placeholder="Full name" value={fullName}
          style={{ width: 180 }} onChange={(e) => setFullName(e.target.value)} />
        <TextInput aria-label="Email" type="email" placeholder="Email" value={email}
          style={{ width: 220 }} onChange={(e) => setEmail(e.target.value)} />
        <TextInput aria-label="Organisation" placeholder="Organisation (optional)"
          value={organisation} style={{ width: 180 }}
          onChange={(e) => setOrganisation(e.target.value)} />
        <TextInput aria-label="Discord username" placeholder="Discord (optional)"
          value={discord} style={{ width: 150 }}
          onChange={(e) => setDiscord(e.target.value)} />
        <button type="submit" disabled={busy || !ready}>Add participant</button>
      </form>

      <TextInput
        aria-label="Search participants" placeholder="Search name, address or organisation"
        value={query.search ?? ''} style={{ marginBottom: 8 }}
        // Asks the server. Filtering the page in hand would search a quarter of the roster and
        // report confidently that nobody matches.
        onChange={(e) => onQuery({ ...query, search: e.target.value, page: 1 })}
      />

      <DataTable
        caption="Participants on the roster"
        rows={people} keyOf={(p) => p.participantId} busy={busy}
        state={{
          ...(query.sort !== undefined && { sort: query.sort }),
          page: query.page ?? 1, pageSize: 25, total,
        }}
        columns={[
          { key: 'name', header: 'Name', sortKey: 'name', render: (p) => p.fullName },
          { key: 'email', header: 'Email', sortKey: 'email', render: (p) => p.email },
          { key: 'org', header: 'Organisation', sortKey: 'organisation',
            render: (p) => p.organisation ?? '—' },
          // Not sortable: ordering by phone number answers nothing anybody asks.
          { key: 'phone', header: 'Phone', render: (p) => p.phone ?? '—' },
          { key: 'discord', header: 'Discord', render: (p) => p.discordUsername ?? '—' },
          { key: 'actions', header: 'Actions', align: 'right', render: () => null },
        ]}
        renderRow={(person) => (
          <ParticipantRow
            person={person} busy={busy}
            onSave={(changes) => onSave(person.participantId, changes)}
            onRemove={(reason) => onRemove(person.participantId, reason)}
          />
        )}
        empty={(query.search ?? '') === ''
          ? 'Nobody on the roster yet. Add one above, or load a file below.'
          : 'Nobody matches that.'}
        onSort={(sort) => onQuery({ ...query, sort: sort as PeopleQuery['sort'], page: 1 })}
        onPage={(page) => onQuery({ ...query, page })}
      />

    </section>
  )
}

