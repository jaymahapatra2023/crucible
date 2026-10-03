-- 016 — Allow a forced re-scan without losing the previous one (E04-S03 acceptance 3).
--
-- The unique index on (submission_id, commit_sha) correctly stopped a second completed scan at
-- the same commit — which also made `force` impossible. Dropping the index would remove the
-- guarantee; overwriting would destroy evidence. A scan is evidence (P7.1), so the previous one
-- is superseded and kept, and the index now guarantees one *current* scan per commit.

ALTER TABLE scan ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;
ALTER TABLE scan ADD COLUMN IF NOT EXISTS superseded_by BIGINT;

DROP INDEX IF EXISTS uq_scan_submission_commit;
CREATE UNIQUE INDEX IF NOT EXISTS uq_scan_submission_commit_current
  ON scan (submission_id, commit_sha)
  WHERE status = 'COMPLETED' AND commit_sha IS NOT NULL AND superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_scan_superseded
  ON scan (submission_id) WHERE superseded_at IS NOT NULL;

-- The published views describe the CURRENT scan only; superseded rows stay queryable for an
-- appeal but must not be mistaken for the scan a score was based on.
CREATE OR REPLACE VIEW v_scans_latest AS
SELECT DISTINCT ON (submission_id)
       scan_id, submission_id, commit_sha, depth,
       files_analyzed, files_total, budget_truncated,
       total_lines, code_lines, comment_lines, languages,
       has_tests, test_file_count, has_ci, has_dockerfile, has_readme, dependency_count,
       content_hash, finished_at
FROM scan
WHERE status = 'COMPLETED' AND superseded_at IS NULL
ORDER BY submission_id, finished_at DESC;
