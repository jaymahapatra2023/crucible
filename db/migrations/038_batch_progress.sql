-- 038 — Durable batch progress and its configuration (E10-S02, E10-S03, E10-S05).
--
-- Progress is already published over the websocket as the run proceeds. That is live progress,
-- and it is gone the moment a browser reloads — which is exactly when an operator checking an
-- overnight run needs it (E10-S05 acceptance 2). So the current position is written down too.
--
-- One row per run, updated in place. The stage RESULTS are the record of what happened and stay
-- append-style in `run_stage_result`; this row only answers "where is it now", which has no
-- history worth keeping and would cost a row per submission if it did.

CREATE TABLE IF NOT EXISTS run_progress (
  run_id         BIGINT       PRIMARY KEY REFERENCES run (run_id) ON DELETE CASCADE,

  stage          TEXT         NOT NULL,
  -- What is being worked on right now, for the operator watching (acceptance 1).
  current_subject TEXT,
  current_label  TEXT,

  completed      INTEGER      NOT NULL DEFAULT 0 CHECK (completed >= 0),
  total          INTEGER      NOT NULL DEFAULT 0 CHECK (total >= 0),

  -- Estimated finish, from measured per-submission durations (E10-S02 acceptance 3). NULL until
  -- there is something real to estimate from — an invented estimate is worse than none, because
  -- an operator plans around it.
  estimated_finish_at TIMESTAMPTZ,
  /* Projected total spend, from the run so far (E10-S03 acceptance 3). NULL for the same reason. */
  projected_cost_usd  NUMERIC(12,6),

  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- The three concurrency limits are NOT declared here: migration 006 already declares them, and
-- a second declaration with the same key is either dead (ON CONFLICT DO NOTHING) or a silent
-- disagreement about the default. One declaration per thing (P1.5).
--
-- What is new is the budget, which E10-S03 introduces.
INSERT INTO app_config (key, value, value_type, description, module, editable) VALUES

('batch.cost_ceiling_usd', '250'::jsonb, 'number',
 'Spend at which a run PAUSES rather than continuing (E10-S03 acceptance 2). It pauses rather than failing: the work already done is worth keeping, and an operator who raises the ceiling should be able to resume rather than start again.',
 'batch', TRUE),

('batch.projection_after', '10'::jsonb, 'number',
 'Submissions that must complete before a projected total is shown (E10-S03 acceptance 3). Projecting from fewer says more about which submission happened to run first than about the run.',
 'batch', TRUE)

ON CONFLICT (key) DO NOTHING;
