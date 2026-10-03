import { useEffect, useState } from 'react'
import { similarTeams } from '../lib/intakeApi.js'
import type { Team, TeamListing } from '../lib/intakeApi.js'

/**
 * The advisory pieces of the token panel, in their own file so the panel stays within the
 * component size limit once reissue-with-reason and team editing joined it (P1.4).
 */

/**
 * Names already in use, in all but punctuation.
 *
 * Asked of the server rather than computed here, so "the same name" has one definition — the
 * database function the stored column is generated from.
 */
export function useSimilarTeams(name: string): Team[] {
  const [similar, setSimilar] = useState<Team[]>([])

  useEffect(() => {
    let live = true
    // Everything goes through the debounce, including clearing: setting state synchronously in
    // an effect body cascades renders on every keystroke, which is what the debounce is for.
    const timer = setTimeout(() => {
      const trimmed = name.trim()
      if (trimmed.length < 2) { if (live) setSimilar([]); return }

      similarTeams(trimmed)
        .then((found) => { if (live) setSimilar(found) })
        // An advisory that cannot be fetched is an advisory that is absent, not an error the
        // organiser should be stopped by.
        .catch(() => { if (live) setSimilar([]) })
    }, 300)

    return () => { live = false; clearTimeout(timer) }
  }, [name])

  return similar
}

export function SimilarWarning({ similar }: { similar: Team[] }) {
  if (similar.length === 0) return null

  return (
    <p role="status" style={{ color: 'var(--warn)' }}>
      <strong>{similar.length === 1 ? 'A team' : 'Teams'} already registered under
      {similar.length === 1 ? ' this name' : ' these names'}: </strong>
      {similar.map((t) => t.displayName).join(', ')}.
      {' '}Issuing a second one creates a second team, and the two will rank separately. Choose
      the existing team above if this is them.
    </p>
  )
}

/**
 * Teams that cannot submit.
 *
 * A team whose only token was revoked, or whose token predates identity and could not be
 * resolved, still appears everywhere else as a team — it simply cannot enter. That is a silent
 * failure that surfaces at a deadline, when it is no longer fixable, so it is said here where
 * the fix is one button away.
 */
export function StrandedTeams({ teams }: { teams: TeamListing[] }) {
  const stranded = teams.filter((t) => t.activeTokens === 0)
  if (stranded.length === 0) return null

  return (
    <p role="status" style={{ color: 'var(--danger)' }}>
      <strong>
        {stranded.length === 1 ? 'One team has' : `${stranded.length} teams have`} no working
        token and cannot submit:{' '}
      </strong>
      {stranded.map((t) => t.displayName).join(', ')}. Choose them above and issue a replacement.
    </p>
  )
}
