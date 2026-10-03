-- 020 — Score runs, criterion scores and variance (E06).
--
-- Every score row cites the rubric and version it ran under (E06-S02 acceptance 4). Without
-- that, "what standard was this team judged by" is unanswerable the moment a rubric is
-- re-versioned, and an appeal becomes unanswerable with it.

CREATE TABLE IF NOT EXISTS score_run (
  run_index_id   BIGSERIAL    PRIMARY KEY,
  -- 1 or 2: each cohort is scored twice and disagreement is flagged (E06-S06).
  run_index      INTEGER      NOT NULL CHECK (run_index IN (1, 2)),
  cohort_key     TEXT         NOT NULL,
  -- Rubric versions in force, per challenge, pinned for the life of the run (P4.4).
  rubric_versions JSONB       NOT NULL DEFAULT '{}'::jsonb,
  model          TEXT         NOT NULL,
  ledger_run_id  BIGINT,
  status         TEXT         NOT NULL DEFAULT 'RUNNING'
                   CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  started_by     TEXT,
  started_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ,
  cost_usd       NUMERIC(12,6) NOT NULL DEFAULT 0,
  error          TEXT,
  UNIQUE (cohort_key, run_index)
);

CREATE INDEX IF NOT EXISTS idx_score_run_cohort ON score_run (cohort_key, run_index);

CREATE TABLE IF NOT EXISTS criterion_score (
  id             BIGSERIAL    PRIMARY KEY,
  run_index_id   BIGINT       NOT NULL REFERENCES score_run (run_index_id) ON DELETE CASCADE,
  submission_id  BIGINT       NOT NULL,
  criterion_id   BIGINT       NOT NULL,
  dimension      TEXT         NOT NULL,

  -- The rubric this score was judged by (acceptance 4).
  rubric_id      BIGINT       NOT NULL,
  rubric_version INTEGER      NOT NULL,
  rubric_hash    CHAR(64)     NOT NULL,

  -- 0–4, or NULL when a non-score applies. NEVER defaulted to zero (acceptance 3).
  raw_score      INTEGER      CHECK (raw_score IS NULL OR raw_score BETWEEN 0 AND 4),
  non_score      TEXT         CHECK (non_score IS NULL OR non_score IN
                     ('INSUFFICIENT_EVIDENCE', 'SCORING_FAILED', 'NOT_APPLICABLE')),
  confidence     INTEGER      NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 100),
  rationale      TEXT         NOT NULL DEFAULT '',
  -- The anchor the score was matched against, quoted for the reviewer.
  anchor_matched TEXT,
  -- [{ path, lineStart, lineEnd, text, reason }] — file-and-line evidence (P0 constraint 2).
  evidence       JSONB        NOT NULL DEFAULT '[]'::jsonb,

  -- Context accounting, so cost and coverage are explicable per score (E06-S01 acceptance 3).
  context_bytes  INTEGER      NOT NULL DEFAULT 0,
  context_truncated BOOLEAN   NOT NULL DEFAULT FALSE,
  files_searched INTEGER      NOT NULL DEFAULT 0,

  model          TEXT,
  attempts       INTEGER      NOT NULL DEFAULT 1,
  cost_usd       NUMERIC(12,6) NOT NULL DEFAULT 0,
  scored_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),

  -- Exactly one of a score or a non-score. A row with neither, or both, is a defect.
  CONSTRAINT chk_score_xor_nonscore
    CHECK ((raw_score IS NOT NULL AND non_score IS NULL)
        OR (raw_score IS NULL AND non_score IS NOT NULL)),
  UNIQUE (run_index_id, submission_id, criterion_id)
);

CREATE INDEX IF NOT EXISTS idx_criterion_score_submission
  ON criterion_score (submission_id, run_index_id);
CREATE INDEX IF NOT EXISTS idx_criterion_score_nonscore
  ON criterion_score (non_score) WHERE non_score IS NOT NULL;

-- Published read model (P1.3): E07 aggregates from this, never from the table.
CREATE OR REPLACE VIEW v_scoring_criterion_scores AS
SELECT cs.run_index_id,
       sr.run_index,
       sr.cohort_key,
       cs.submission_id,
       cs.criterion_id,
       cs.dimension,
       cs.raw_score,
       cs.non_score,
       cs.confidence,
       cs.rubric_id,
       cs.rubric_version,
       jsonb_array_length(cs.evidence) AS evidence_count
FROM criterion_score cs
JOIN score_run sr ON sr.run_index_id = cs.run_index_id;
