-- 060 — Discovery as a run, and as a batch stage (E15, G3/G7/G11).
--
-- Discovery ran seven sequential model calls inside one HTTP request — up to twenty minutes
-- against a thirty-second platform timeout — and opened no ledger run at all. Three consequences
-- followed from that one omission:
--
--   * No progress and no resumability. A dropped connection lost the visibility even though the
--     work continued, so an operator could not tell a hung run from a finished one.
--   * Its spend sat outside every cost ceiling, because a ceiling is enforced against a run.
--   * It could not be a batch stage, so a fifty-team cohort needed fifty manual triggers — and
--     any that were missed produced submissions scored on LESS context than their competitors,
--     silently, in the same ranking.
--
-- The third is the fairness problem and the reason this is not merely an ergonomics fix.

ALTER TABLE run DROP CONSTRAINT IF EXISTS run_kind_check;
ALTER TABLE run ADD CONSTRAINT run_kind_check
  CHECK (kind IN ('SCAN', 'PROBE', 'SCORE', 'COHORT', 'CALIBRATION', 'DRY_RUN', 'DISCOVERY'));

-- Provider-bound rather than disk- or container-bound, so it gets its own limit: sharing the
-- scan limit would either starve the provider or flood it.
INSERT INTO app_config (key, value, value_type, description, module, editable) VALUES
('batch.discovery_concurrency', '3'::jsonb, 'number',
 'Submissions discovered at once during a batch. Lower than scanning: each one makes seven sequential model calls, so the real limit is the provider rather than local IO.',
 'batch', TRUE),
('discovery.cost_ceiling_usd', '40'::jsonb, 'number',
 'Most a discovery run may spend before it PAUSES. Pauses rather than fails, like every other ceiling: the concerns already extracted are worth keeping, and an operator who raises this should resume rather than restart.',
 'discovery', TRUE)
ON CONFLICT (key) DO NOTHING;

-- Both are operational: they decide whether and how fast a run finishes, not what any
-- submission scores. Pinning them would stop an operator acting on a run in flight (E14).
UPDATE app_config SET affects_outcome = FALSE
 WHERE key IN ('batch.discovery_concurrency', 'discovery.cost_ceiling_usd');

/*
 * Coverage: how much of a cohort was described, and how evenly.
 *
 * The question this exists to answer is not "how many were discovered" but "were they all
 * treated alike". A cohort where NOBODY was discovered is consistent and therefore fair; one
 * where some were and some were not is neither, and until now nothing said so.
 */
CREATE OR REPLACE VIEW v_discovery_coverage AS
SELECT s.challenge_id,
       COUNT(*)                                             AS submissions,
       COUNT(dr.discovery_id)                               AS discovered,
       COUNT(*) FILTER (WHERE dr.status = 'COMPLETED')      AS completed,
       COUNT(*) - COUNT(dr.discovery_id)                    AS undiscovered
FROM submission s
LEFT JOIN discovery_run dr
       ON dr.submission_id = s.submission_id AND dr.superseded_at IS NULL
WHERE s.is_current
GROUP BY s.challenge_id;
