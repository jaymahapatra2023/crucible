-- 039 — Attribute each model call to its subject (E10-S03 acceptance 1).
--
-- The acceptance is "cost accumulated per run AND per submission from E01-S04 records", and the
-- E01-S04 record is `llm_call_log`. It carried `run_id` but nothing identifying the submission,
-- so per-submission cost had to be summed from `criterion_score` instead — which under-reports,
-- because a criterion that FAILS after three paid attempts records a cost of zero on its row
-- while the money is gone. A run that retried heavily looked cheap per submission and expensive
-- overall, with no way to reconcile the two.
--
-- Nullable: plenty of calls have no submission (rubric generation, calibration), and inventing
-- one for them would be worse than leaving it absent.

ALTER TABLE llm_call_log
  ADD COLUMN IF NOT EXISTS subject_type TEXT,
  ADD COLUMN IF NOT EXISTS subject_id   TEXT;

CREATE INDEX IF NOT EXISTS idx_llm_log_subject
  ON llm_call_log (subject_type, subject_id)
  WHERE subject_id IS NOT NULL;

-- Published read model (P1.3): spend per subject within a run, which is what a batch reports.
CREATE OR REPLACE VIEW v_llm_subject_cost AS
SELECT run_id,
       subject_type,
       subject_id,
       SUM(cost_usd)                          AS cost_usd,
       COUNT(*)                               AS calls,
       COUNT(*) FILTER (WHERE status <> 'OK') AS failed_calls
FROM llm_call_log
WHERE subject_id IS NOT NULL
GROUP BY run_id, subject_type, subject_id;
