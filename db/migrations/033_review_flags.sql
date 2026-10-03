-- 033 — Why a submission needs a person to look at it (E07-S03 acceptance 2, E07-S06 acceptance 2).
--
-- Both stories say "flagged for human review", and until now that was only implicit: a reviewer
-- could infer it from a normalisation method here and a tie there. Inference is not a flag. A
-- submission whose cohort was too small to normalise needs a human eye even when it sits nowhere
-- near the cut line, and nothing in the ranking said so.
--
-- The reasons are stored rather than derived on read for the same reason the ranking is: they
-- describe the state at the moment the ranking was produced, and re-deriving them later against
-- retuned configuration would answer a different question.

ALTER TABLE submission_composite
  ADD COLUMN IF NOT EXISTS requires_review BOOLEAN NOT NULL DEFAULT FALSE,
  -- Plain codes, ordered most-significant first. Empty exactly when requires_review is false.
  ADD COLUMN IF NOT EXISTS review_reasons TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE submission_composite
  ADD CONSTRAINT chk_review_reasons_present
    CHECK (requires_review = (cardinality(review_reasons) > 0));

CREATE INDEX IF NOT EXISTS idx_submission_composite_review
  ON submission_composite (run_index_id) WHERE requires_review;

DROP VIEW IF EXISTS v_scoring_ranking;

CREATE VIEW v_scoring_ranking AS
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
       sc.requires_review,
       sc.review_reasons,
       sc.computed_at
FROM submission_composite sc
JOIN score_run sr ON sr.run_index_id = sc.run_index_id
LEFT JOIN v_submissions_submission sub ON sub.submission_id = sc.submission_id;
