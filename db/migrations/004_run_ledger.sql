-- 004 — Run ledger (E01-S05).
--
-- Every long-running operation records per-stage outcomes so a failed batch can be diagnosed
-- and RESUMED rather than restarted (E10-S04). The ledger lives in the database, not in memory,
-- because the requirement is explicitly that stage results survive a process restart
-- (E01-S05 acceptance 2) — and because P11.4 forbids in-process state that is not in the DB.

CREATE TABLE IF NOT EXISTS run (
  run_id         BIGSERIAL    PRIMARY KEY,
  kind           TEXT         NOT NULL
                   CHECK (kind IN ('SCAN', 'PROBE', 'SCORE', 'COHORT', 'CALIBRATION', 'DRY_RUN')),
  status         TEXT         NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING', 'RUNNING', 'PAUSED', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  -- Free-form scope of the run: which cohort, which rubric versions, which submissions.
  params         JSONB        NOT NULL DEFAULT '{}'::jsonb,
  -- P4.4: the model is pinned per run; a config change must not affect an in-flight run.
  pinned_config  JSONB        NOT NULL DEFAULT '{}'::jsonb,
  correlation_id TEXT         NOT NULL,
  started_by     TEXT,
  started_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ,
  -- Cost accounting for E10-S03; accumulated from llm_call_log as the run proceeds.
  cost_usd       NUMERIC(12,6) NOT NULL DEFAULT 0,
  error          TEXT
);

CREATE INDEX IF NOT EXISTS idx_run_status ON run (status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_kind   ON run (kind, started_at DESC);

-- One row per (run, subject, stage). `subject_id` is nullable so a run-level stage
-- ("resolve cohort") and a per-submission stage ("scan") share one ledger shape.
CREATE TABLE IF NOT EXISTS run_stage_result (
  id           BIGSERIAL    PRIMARY KEY,
  run_id       BIGINT       NOT NULL REFERENCES run (run_id) ON DELETE CASCADE,
  stage        TEXT         NOT NULL,
  subject_type TEXT         NOT NULL DEFAULT 'RUN',
  subject_id   TEXT,
  -- The four outcomes E01-S05 acceptance 1 requires.
  outcome      TEXT         NOT NULL
                 CHECK (outcome IN ('ok', 'failed', 'skipped', 'warning')),
  message      TEXT,
  detail       JSONB        NOT NULL DEFAULT '{}'::jsonb,
  attempt      INTEGER      NOT NULL DEFAULT 1,
  started_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  duration_ms  INTEGER
);

-- Resume must be idempotent with no duplicate rows (E10-S04 acceptance 3): one result per
-- (run, stage, subject, attempt).
CREATE UNIQUE INDEX IF NOT EXISTS uq_run_stage_subject_attempt
  ON run_stage_result (run_id, stage, subject_type, COALESCE(subject_id, ''), attempt);

CREATE INDEX IF NOT EXISTS idx_run_stage_run ON run_stage_result (run_id, stage);
CREATE INDEX IF NOT EXISTS idx_run_stage_failed
  ON run_stage_result (run_id) WHERE outcome = 'failed';

-- Published read model (P1.3): other modules read run progress through this view, never by
-- joining run_stage_result themselves.
CREATE OR REPLACE VIEW v_platform_run_progress AS
SELECT r.run_id,
       r.kind,
       r.status,
       r.started_at,
       r.finished_at,
       r.cost_usd,
       COUNT(s.id)                                             AS stage_results,
       COUNT(*) FILTER (WHERE s.outcome = 'ok')                AS ok_count,
       COUNT(*) FILTER (WHERE s.outcome = 'failed')            AS failed_count,
       COUNT(*) FILTER (WHERE s.outcome = 'skipped')           AS skipped_count,
       COUNT(*) FILTER (WHERE s.outcome = 'warning')           AS warning_count
FROM run r
LEFT JOIN run_stage_result s ON s.run_id = r.run_id
GROUP BY r.run_id;
