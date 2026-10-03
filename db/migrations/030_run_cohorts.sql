-- 030 — Cohort sizes, recorded BEFORE scoring (E07-S03 acceptance 1).
--
-- "Computed and stored before scoring" is not a filing detail. Fidelity is normalised within a
-- challenge's cohort, so the cohort a submission was judged against is part of what its score
-- means. Deriving it later from whatever happens to be in the database would silently re-answer
-- the question every time a submission is superseded or a scan is deleted — and an appeal would
-- get a different cohort size than the run actually used.

CREATE TABLE IF NOT EXISTS run_cohort (
  id             BIGSERIAL    PRIMARY KEY,
  run_index_id   BIGINT       NOT NULL REFERENCES score_run (run_index_id) ON DELETE CASCADE,
  challenge_id   BIGINT       NOT NULL,

  -- Submissions in this challenge that the run set out to score.
  cohort_size    INTEGER      NOT NULL CHECK (cohort_size >= 0),
  -- The floor in force when the run started, so the decision stays explicable after retuning.
  floor_used     INTEGER      NOT NULL CHECK (floor_used >= 0),
  -- Derived at write time rather than compared on read: the comparison must use the floor that
  -- applied then, not the floor that applies now.
  below_floor    BOOLEAN      NOT NULL,

  recorded_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (run_index_id, challenge_id)
);

CREATE INDEX IF NOT EXISTS idx_run_cohort_run ON run_cohort (run_index_id);

-- Published read model (P1.3).
CREATE OR REPLACE VIEW v_scoring_run_cohorts AS
SELECT rc.run_index_id,
       sr.cohort_key,
       sr.run_index,
       rc.challenge_id,
       rc.cohort_size,
       rc.floor_used,
       rc.below_floor,
       rc.recorded_at
FROM run_cohort rc
JOIN score_run sr ON sr.run_index_id = rc.run_index_id;
