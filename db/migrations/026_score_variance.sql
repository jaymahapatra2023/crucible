-- 026 — Run-to-run variance (E06-S06).
--
-- Each cohort is scored twice and the two composites are compared. The comparison is PERSISTED
-- rather than recomputed on demand because it is evidence: a flag a reviewer dismissed must
-- still be answerable months later, and a recomputation against a re-normalised cohort would
-- quietly produce a different answer than the one that was dismissed.
--
-- Acceptance 5 — "cannot be dismissed without a recorded reason" — is enforced here rather than
-- in a service, by a CHECK that ties the dismissal to its reason. A service-level rule can be
-- bypassed by the next caller; this one cannot.

CREATE TABLE IF NOT EXISTS score_variance (
  id              BIGSERIAL   PRIMARY KEY,
  cohort_key      TEXT        NOT NULL,
  submission_id   BIGINT      NOT NULL,

  run_a_id        BIGINT      NOT NULL REFERENCES score_run (run_index_id) ON DELETE CASCADE,
  run_b_id        BIGINT      NOT NULL REFERENCES score_run (run_index_id) ON DELETE CASCADE,

  composite_a     NUMERIC(6,3) NOT NULL,
  composite_b     NUMERIC(6,3) NOT NULL,
  -- Absolute difference, in points out of 100 (acceptance 2).
  delta           NUMERIC(6,3) NOT NULL CHECK (delta >= 0),

  rank_a          INTEGER     NOT NULL,
  rank_b          INTEGER     NOT NULL,

  -- The two runs place this submission on opposite sides of the cut (acceptance 3).
  straddles_cut   BOOLEAN     NOT NULL DEFAULT FALSE,
  -- The delta exceeds the configured threshold, wherever the submission sits (acceptance 4).
  exceeds_threshold BOOLEAN   NOT NULL DEFAULT FALSE,
  -- The threshold in force when this row was written, so the flag stays explicable after the
  -- configuration is retuned.
  threshold_used  NUMERIC(6,3) NOT NULL,
  cut_line_used   INTEGER     NOT NULL,

  dismissed_at    TIMESTAMPTZ,
  dismissed_by    TEXT,
  dismissal_reason TEXT,

  computed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (cohort_key, submission_id),

  -- Acceptance 5, at the level that cannot be worked around.
  CONSTRAINT chk_dismissal_has_reason CHECK (
    (dismissed_at IS NULL AND dismissed_by IS NULL AND dismissal_reason IS NULL)
    OR (dismissed_at IS NOT NULL AND dismissed_by IS NOT NULL
        AND dismissal_reason IS NOT NULL AND length(trim(dismissal_reason)) >= 10)
  )
);

CREATE INDEX IF NOT EXISTS idx_score_variance_flagged
  ON score_variance (cohort_key)
  WHERE (straddles_cut OR exceeds_threshold) AND dismissed_at IS NULL;

-- Published read model (P1.3): E08-S03 surfaces flags from this.
CREATE OR REPLACE VIEW v_scoring_variance_flags AS
SELECT sv.cohort_key,
       sv.submission_id,
       sv.composite_a,
       sv.composite_b,
       sv.delta,
       sv.rank_a,
       sv.rank_b,
       sv.straddles_cut,
       sv.exceeds_threshold,
       sv.threshold_used,
       sv.cut_line_used,
       (sv.dismissed_at IS NOT NULL) AS dismissed,
       sv.dismissal_reason,
       sv.computed_at
FROM score_variance sv
WHERE sv.straddles_cut OR sv.exceeds_threshold;
