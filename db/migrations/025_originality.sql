-- 025 — The advisory originality assessment (E06-S05).
--
-- Kept in its own table rather than as a `criterion_score` row, for one reason: this dimension
-- is ADVISORY and must be capable of being omitted entirely. A rubric criterion cannot be
-- omitted — it is part of a frozen standard — whereas an originality assessment that did not
-- run leaves no row at all, and E07 reads that absence as "dimension not scored" rather than
-- as a zero.
--
-- The measured signals are stored alongside the judgement so a reviewer can check the basis
-- rather than take the level on trust (P5.1, E08-S03).

CREATE TABLE IF NOT EXISTS originality_assessment (
  id             BIGSERIAL    PRIMARY KEY,
  run_index_id   BIGINT       NOT NULL REFERENCES score_run (run_index_id) ON DELETE CASCADE,
  submission_id  BIGINT       NOT NULL,

  -- 0–4, or NULL with a non-score. Never defaulted.
  level          INTEGER      CHECK (level IS NULL OR level BETWEEN 0 AND 4),
  non_score      TEXT         CHECK (non_score IS NULL OR non_score IN
                     ('INSUFFICIENT_EVIDENCE', 'SCORING_FAILED', 'NOT_APPLICABLE')),
  confidence     INTEGER      NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 100),
  rationale      TEXT         NOT NULL DEFAULT '',
  observations   JSONB        NOT NULL DEFAULT '[]'::jsonb,
  evidence       JSONB        NOT NULL DEFAULT '[]'::jsonb,

  -- The measurements the judgement was made from (E06-S05 acceptance 1), kept verbatim so the
  -- number can be re-derived and disputed.
  boilerplate_share_pct NUMERIC(5,1) NOT NULL DEFAULT 0,
  scaffold_lines INTEGER      NOT NULL DEFAULT 0,
  substantive_lines INTEGER   NOT NULL DEFAULT 0,
  templates      JSONB        NOT NULL DEFAULT '[]'::jsonb,
  provenance_flags JSONB      NOT NULL DEFAULT '[]'::jsonb,

  model          TEXT,
  cost_usd       NUMERIC(12,6) NOT NULL DEFAULT 0,
  assessed_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),

  UNIQUE (run_index_id, submission_id),
  CONSTRAINT chk_originality_xor CHECK (
    (level IS NOT NULL AND non_score IS NULL) OR (level IS NULL AND non_score IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_originality_assessment_sub
  ON originality_assessment (submission_id, run_index_id);

-- Published read model (P1.3). E07 and E08 read this; neither touches the table.
CREATE OR REPLACE VIEW v_scoring_originality AS
SELECT oa.run_index_id,
       sr.run_index,
       sr.cohort_key,
       oa.submission_id,
       oa.level,
       oa.non_score,
       oa.confidence,
       oa.boilerplate_share_pct,
       oa.scaffold_lines,
       oa.substantive_lines,
       jsonb_array_length(oa.templates) AS template_count,
       jsonb_array_length(oa.provenance_flags) AS provenance_flag_count
FROM originality_assessment oa
JOIN score_run sr ON sr.run_index_id = oa.run_index_id;
