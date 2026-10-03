-- 014 — Scan results and provenance (E04-S05, E04-S06).
--
-- `raw_result` holds the scanner's output verbatim so scoring can be re-run without re-scanning
-- (acceptance 1 and 2). Metrics are ALSO extracted to typed columns — not instead — because a
-- dashboard that has to parse JSON to count long files will eventually disagree with the JSON.

CREATE TABLE IF NOT EXISTS scan (
  scan_id            BIGSERIAL    PRIMARY KEY,
  submission_id      BIGINT       NOT NULL,
  commit_sha         CHAR(40),
  head_committed_at  TIMESTAMPTZ,

  depth              TEXT         NOT NULL
                       CHECK (depth IN ('standard', 'deep', 'exhaustive')),
  -- Both persisted, so coverage differences between submissions are visible (E04-S04 #2).
  files_analyzed     INTEGER      NOT NULL DEFAULT 0,
  files_total        INTEGER      NOT NULL DEFAULT 0,
  budget_truncated   BOOLEAN      NOT NULL DEFAULT FALSE,

  -- Typed metric columns, for queries and dashboards.
  total_lines        INTEGER      NOT NULL DEFAULT 0,
  code_lines         INTEGER      NOT NULL DEFAULT 0,
  comment_lines      INTEGER      NOT NULL DEFAULT 0,
  languages          TEXT[]       NOT NULL DEFAULT '{}',
  has_tests          BOOLEAN      NOT NULL DEFAULT FALSE,
  test_file_count    INTEGER      NOT NULL DEFAULT 0,
  has_ci             BOOLEAN      NOT NULL DEFAULT FALSE,
  has_dockerfile     BOOLEAN      NOT NULL DEFAULT FALSE,
  has_readme         BOOLEAN      NOT NULL DEFAULT FALSE,
  dependency_count   INTEGER      NOT NULL DEFAULT 0,

  -- The scanner's output verbatim, including file contents (acceptance 1).
  raw_result         JSONB        NOT NULL,
  -- SHA-256 over raw_result, so an identical re-scan is detectable (P7.2).
  content_hash       CHAR(64)     NOT NULL,

  status             TEXT         NOT NULL DEFAULT 'COMPLETED'
                       CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
  error              TEXT,
  run_id             BIGINT,
  started_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  finished_at        TIMESTAMPTZ,
  duration_ms        INTEGER
);

CREATE INDEX IF NOT EXISTS idx_scan_submission ON scan (submission_id, started_at DESC);
-- One completed scan per (submission, commit): re-scanning the same code is detected and
-- skipped unless forced (E04-S03 acceptance 3).
CREATE UNIQUE INDEX IF NOT EXISTS uq_scan_submission_commit
  ON scan (submission_id, commit_sha) WHERE status = 'COMPLETED' AND commit_sha IS NOT NULL;

CREATE TABLE IF NOT EXISTS provenance (
  submission_id            BIGINT       PRIMARY KEY,
  scan_id                  BIGINT       NOT NULL,
  first_commit_at          TIMESTAMPTZ,
  last_commit_at           TIMESTAMPTZ,
  total_commits            INTEGER      NOT NULL DEFAULT 0,
  commits_in_window        INTEGER      NOT NULL DEFAULT 0,
  commits_out_of_window    INTEGER      NOT NULL DEFAULT 0,
  distinct_authors         INTEGER      NOT NULL DEFAULT 0,
  authors                  TEXT[]       NOT NULL DEFAULT '{}',
  largest_single_commit_pct NUMERIC(5,1) NOT NULL DEFAULT 0,
  history_truncated        BOOLEAN      NOT NULL DEFAULT FALSE,
  -- Flags raised for human review. Never an exclusion (E04-S06 acceptance 2).
  flags                    JSONB        NOT NULL DEFAULT '[]'::jsonb,
  analysed_at              TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_provenance_flagged
  ON provenance ((jsonb_array_length(flags))) WHERE jsonb_array_length(flags) > 0;

-- Published read models (P1.3). Scoring reads scans through these, and never triggers a scan.
CREATE OR REPLACE VIEW v_scans_latest AS
SELECT DISTINCT ON (submission_id)
       scan_id, submission_id, commit_sha, depth,
       files_analyzed, files_total, budget_truncated,
       total_lines, code_lines, comment_lines, languages,
       has_tests, test_file_count, has_ci, has_dockerfile, has_readme, dependency_count,
       content_hash, finished_at
FROM scan
WHERE status = 'COMPLETED'
ORDER BY submission_id, finished_at DESC;

CREATE OR REPLACE VIEW v_scans_coverage AS
SELECT submission_id,
       files_analyzed,
       files_total,
       budget_truncated,
       CASE WHEN files_total = 0 THEN 0
            ELSE round((files_analyzed::numeric / files_total) * 100, 1) END AS coverage_pct
FROM v_scans_latest;
