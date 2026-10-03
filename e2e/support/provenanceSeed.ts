/**
 * E2E fixture: a commit history flagged for a person to look at.
 *
 * Written straight to the database. The journey under test is an operator working through the
 * queue, and making it depend on a real clone-and-analyse would make the test about the network.
 */
import pg from 'pg'

function pool(): pg.Pool {
  return new pg.Pool({
    connectionString:
      process.env['TEST_DATABASE_URL'] ?? 'postgresql://localhost:5432/crucible_test',
  })
}

export async function seedFlaggedProvenance(
  submissionId: number, largestSingleCommitPct: number,
): Promise<void> {
  const db = pool()
  try {
    await db.query(
      `INSERT INTO provenance
         (submission_id, scan_id, total_commits, commits_in_window, commits_out_of_window,
          distinct_authors, authors, largest_single_commit_pct, history_truncated, flags)
       VALUES ($1, $1, 12, 8, 4, 2, ARRAY['a','b'], $2, FALSE,
               '[{"code":"SINGLE_COMMIT","message":"One commit contributed most of the code."}]'::jsonb)
       ON CONFLICT (submission_id) DO UPDATE
         SET largest_single_commit_pct = EXCLUDED.largest_single_commit_pct`,
      [submissionId, largestSingleCommitPct])
  } finally {
    await db.end()
  }
}

/** Clear the queue, so the empty state can be exercised. */
export async function clearProvenance(): Promise<void> {
  const db = pool()
  try {
    await db.query('TRUNCATE TABLE provenance_resolution, provenance CASCADE')
  } finally {
    await db.end()
  }
}
