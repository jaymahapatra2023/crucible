-- 034 — The dimension breakdown behind each composite (E08-S01 acceptance 1, E08-S02).
--
-- Until now only the composite survived the ranking pass; the five dimension scores it was built
-- from were computed and discarded. A reviewer working through a ranked table needs to see WHERE
-- a score came from without opening each team, and an appeal needs the breakdown as it stood.
--
-- Stored alongside the composite, in the same operation, for the same reason (see 031): a
-- breakdown re-derived later can disagree with the composite it is supposed to explain.

CREATE TABLE IF NOT EXISTS submission_dimension_score (
  id             BIGSERIAL    PRIMARY KEY,
  run_index_id   BIGINT       NOT NULL REFERENCES score_run (run_index_id) ON DELETE CASCADE,
  submission_id  BIGINT       NOT NULL,
  dimension      TEXT         NOT NULL,

  -- 0–100, or NULL when nothing in the dimension could be scored. Never zero-filled.
  score          NUMERIC(6,3),
  data_quality   TEXT         NOT NULL
                   CHECK (data_quality IN ('COMPLETE', 'PARTIAL', 'UNSCORED')),
  scored_count   INTEGER      NOT NULL DEFAULT 0,
  total_count    INTEGER      NOT NULL DEFAULT 0,
  weight_covered NUMERIC(4,3) NOT NULL DEFAULT 0,
  -- The rubric weight this dimension carries, so a reviewer can see what moved the composite.
  weight         NUMERIC(4,3) NOT NULL DEFAULT 0,
  -- [{ criterionId, reason }] — what was left out, and why.
  excluded       JSONB        NOT NULL DEFAULT '[]'::jsonb,

  computed_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (run_index_id, submission_id, dimension),

  -- An UNSCORED dimension has no score; a scored one has one. The pair cannot disagree.
  CONSTRAINT chk_dimension_score_quality
    CHECK ((data_quality = 'UNSCORED' AND score IS NULL)
        OR (data_quality <> 'UNSCORED' AND score IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_dimension_score_submission
  ON submission_dimension_score (run_index_id, submission_id);

-- Published read model (P1.3).
CREATE OR REPLACE VIEW v_scoring_dimension_scores AS
SELECT ds.run_index_id,
       ds.submission_id,
       ds.dimension,
       ds.score,
       ds.data_quality,
       ds.scored_count,
       ds.total_count,
       ds.weight_covered,
       ds.weight,
       ds.excluded
FROM submission_dimension_score ds;
