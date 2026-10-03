-- 056 — Declaring which settings decide an outcome (E14-S01, P4.4).
--
-- P4.4 requires that "config changes do not affect an in-flight run". Taken literally that
-- conflicts with E10-S03, where an operator who raises a cost ceiling mid-run is expected to
-- resume rather than restart — and with this system's own caching note, which says a raised
-- ceiling "needs to take effect now, not within a minute".
--
-- Both are right, about different things. A cost ceiling and a concurrency limit decide whether
-- and how fast a run finishes; they do not decide what score anything gets. A context budget, a
-- cut line, a model assignment or a probe timeout decides the outcome itself, and changing one
-- mid-run makes the two halves of a cohort incomparable.
--
-- So the distinction is declared here rather than hand-listed in code, for the reason P1.5
-- clause 6 gives: a hand-listed set silently stops covering settings added later.

ALTER TABLE app_config ADD COLUMN IF NOT EXISTS affects_outcome BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN app_config.affects_outcome IS
  'True when changing this value changes what a submission scores, as opposed to how fast or '
  'whether the run completes. Outcome settings are pinned for the life of a run (P4.4); '
  'operational ones stay live so an operator can act during one.';

-- Everything that shapes a score, a grade or a ranking.
UPDATE app_config SET affects_outcome = TRUE
 WHERE module IN ('scoring', 'discovery', 'probes')
    OR key IN ('llm.default_model', 'llm.max_attempts', 'llm.reviewer_model',
               'scans.default_depth', 'scans.history_depth', 'scans.event_window',
               'scans.provenance_max_out_of_window_pct', 'scans.provenance_max_single_commit_pct');

-- Operational knobs stay live, so an operator can act on a run in flight.
UPDATE app_config SET affects_outcome = FALSE
 WHERE key IN ('llm.concurrency', 'llm.cost_ceiling_usd_per_run', 'llm.retry_base_delay_ms',
               'llm.model_pricing')
    OR module IN ('batch', 'platform', 'submissions', 'event');

-- The scoring run carries the same pin as the ledger run, because the variance comparison joins
-- on score_run and that is where "were these two runs alike?" has to be answerable.
ALTER TABLE score_run ADD COLUMN IF NOT EXISTS pinned_config JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN score_run.pinned_config IS
  'Every outcome-determining setting and every feature flag, as they stood when this run opened. '
  'Two runs whose pins differ are not like-for-like, and the variance comparison says so.';
