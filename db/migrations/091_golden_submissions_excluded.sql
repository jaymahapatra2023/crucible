-- 091 — A golden entry is not an entrant (calibration).
--
-- `eligibleSubjects` selected every VALID submission for a challenge. Golden-set repositories are
-- entered through the ordinary submission path on purpose — that is what makes calibration measure
-- the real pipeline — so they are VALID submissions against the same challenge as the teams, and a
-- real cohort run would have scored them alongside the entrants and ranked them with them. That
-- corrupts percentile normalisation, the cohort size, the cut line and every position near it.
--
-- The batch module cannot read calibration's tables (P1.3), so calibration publishes the fact.

CREATE OR REPLACE VIEW v_calibration_golden_submission AS
SELECT e.submission_id,
       e.golden_set_id,
       e.entry_id,
       e.label
  FROM golden_entry e
 WHERE e.submission_id IS NOT NULL;

COMMENT ON VIEW v_calibration_golden_submission IS
  'Published (P1.3): submissions that exist only as golden-set reference material. A scoring run '
  'of a real cohort excludes these — a golden entry is reference material, not an entrant.';
