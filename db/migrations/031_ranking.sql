-- 031 — The persisted ranking (E07-S02 acceptance 3, E07-S04 acceptance 1).
--
-- Both acceptance criteria say "stored", and they are right to. A ranking recomputed on every
-- read is not evidence: re-normalising against a cohort that has since changed can hand an
-- appeal a different number than the one the team was ranked by, and nobody can tell which was
-- shown at the time.
--
-- So ranking is an explicit, repeatable OPERATION whose result is written down. `scores_counted`
-- records how many criterion scores it was computed from, which is what makes staleness
-- detectable: if the run now holds more scores than the ranking was built from, the ranking is
-- out of date and the API says so rather than serving it as current.

CREATE TABLE IF NOT EXISTS submission_composite (
  id                  BIGSERIAL    PRIMARY KEY,
  run_index_id        BIGINT       NOT NULL REFERENCES score_run (run_index_id) ON DELETE CASCADE,
  submission_id       BIGINT       NOT NULL,
  challenge_id        BIGINT       NOT NULL,

  composite           NUMERIC(6,3) NOT NULL,

  -- BOTH are kept. The raw value must remain visible for appeals (E07-S02 acceptance 3):
  -- a normalised standing answers "how did they compare", and only the raw score answers
  -- "how well did they actually address the brief".
  fidelity_raw        NUMERIC(6,3),
  fidelity_normalised NUMERIC(6,3),
  cohort_size         INTEGER      NOT NULL DEFAULT 0,
  normalisation_method TEXT        NOT NULL
                        CHECK (normalisation_method IN
                          ('PERCENTILE', 'ABSOLUTE_FALLBACK', 'DEGENERATE_UNIFORM', 'UNSCORED')),

  rank_global         INTEGER      NOT NULL CHECK (rank_global >= 1),
  rank_in_challenge   INTEGER      NOT NULL CHECK (rank_in_challenge >= 1),
  tied                BOOLEAN      NOT NULL DEFAULT FALSE,

  -- How much of the rubric's weight could actually be scored, and what was missing.
  weight_covered      NUMERIC(4,3) NOT NULL DEFAULT 0,
  missing_dimensions  TEXT[]       NOT NULL DEFAULT '{}',
  partial             BOOLEAN      NOT NULL DEFAULT FALSE,

  -- E07-S06. `in_cut_band` means "close enough to the line that a person must look"; it does
  -- NOT mean selected, and nothing in this schema does.
  in_cut_band         BOOLEAN      NOT NULL DEFAULT FALSE,
  -- True when removing the advisory originality dimension would move this submission across the
  -- cut line (E06-S05 acceptance 3, E07-S06 acceptance 3).
  advisory_decided    BOOLEAN      NOT NULL DEFAULT FALSE,

  computed_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (run_index_id, submission_id),
  -- One rank per position within a run, so a ranking cannot contain two firsts.
  UNIQUE (run_index_id, rank_global)
);

CREATE INDEX IF NOT EXISTS idx_submission_composite_rank
  ON submission_composite (run_index_id, rank_global);
CREATE INDEX IF NOT EXISTS idx_submission_composite_band
  ON submission_composite (run_index_id) WHERE in_cut_band;

-- What each ranking was computed from, so staleness is detectable rather than assumed.
CREATE TABLE IF NOT EXISTS ranking_snapshot (
  run_index_id    BIGINT       PRIMARY KEY REFERENCES score_run (run_index_id) ON DELETE CASCADE,
  scores_counted  INTEGER      NOT NULL,
  submissions     INTEGER      NOT NULL,
  cut_line_used   INTEGER      NOT NULL,
  band_size_used  INTEGER      NOT NULL,
  min_cohort_size INTEGER      NOT NULL,
  computed_by     TEXT,
  computed_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Published read model (P1.3): E08 reads this, never the table.
CREATE OR REPLACE VIEW v_scoring_ranking AS
SELECT sc.run_index_id,
       sr.cohort_key,
       sc.submission_id,
       sc.challenge_id,
       sub.team_name,
       sc.composite,
       sc.fidelity_raw,
       sc.fidelity_normalised,
       sc.cohort_size,
       sc.normalisation_method,
       sc.rank_global,
       sc.rank_in_challenge,
       sc.tied,
       sc.weight_covered,
       sc.missing_dimensions,
       sc.partial,
       sc.in_cut_band,
       sc.advisory_decided,
       sc.computed_at
FROM submission_composite sc
JOIN score_run sr ON sr.run_index_id = sc.run_index_id
LEFT JOIN v_submissions_submission sub ON sub.submission_id = sc.submission_id;
