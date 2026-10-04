-- 108 — Record how much of the rubric actually produced a score.
--
-- A dimension averages over the weight it covered, so a criterion that could not be scored is
-- dropped from the denominator rather than counted as zero. That rule is right — scoring an
-- unmeasured criterion as zero would punish a team for our inability to measure it — but it has
-- a consequence nothing recorded until now: the composite of an entry scored over part of the
-- rubric is not comparable with one scored over all of it, and the gap favours the entry with
-- the gap.
--
-- Measured on the calibration set: one entry scored a perfect 100 while the single criterion it
-- failed on was lost to a retry exhaustion. Counting that criterion as zero gives 92. Another
-- went 96.3 instead of 90.5 the same way. Three of eight entries changed rank between two runs
-- of the same model, and restricting the comparison to criteria scored in BOTH runs removed
-- every one of those changes.
--
-- So the figure is stored beside the composite it qualifies. It corrects nothing — the arithmetic
-- is unchanged — and it makes the one question a reviewer needs answerable: how much of this
-- mark rests on what we could not read? `composite × coverage` is exactly the score counting the
-- unscored criteria as zero, which is the bound worth knowing.

ALTER TABLE submission_composite
  ADD COLUMN criterion_coverage numeric(4,3) NOT NULL DEFAULT 1.000
  CHECK (criterion_coverage >= 0 AND criterion_coverage <= 1);

COMMENT ON COLUMN submission_composite.criterion_coverage IS
  'Share of the rubric''s criterion weight that produced a score (migration 108). 1.000 means '
  'every criterion was scored. Distinct from weight_covered, which is about dimensions.';

-- Rebuilt so the published read carries it. Rankings are read through this view, never the table.
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
       sc.criterion_coverage,
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

COMMENT ON VIEW v_scoring_ranking IS
  'Published read for a run''s ranking (P1.3), now carrying criterion coverage (migration 108).';
