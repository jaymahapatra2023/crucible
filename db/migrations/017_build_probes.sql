-- 017 — Build probe results (E05-S04, E05-S05).
--
-- The log is stored in the database rather than on disk. It is capped at a few hundred KB, and
-- an appeal packet (E09-S02) must be reproducible months later without depending on a
-- filesystem that a retention policy (OD-6) may have cleared. `log_uri` is kept for a future
-- external store; today it is null and `log` holds the text.

CREATE TABLE IF NOT EXISTS build_probe (
  probe_id          BIGSERIAL    PRIMARY KEY,
  submission_id     BIGINT       NOT NULL,
  scan_id           BIGINT,

  method            TEXT         NOT NULL CHECK (method IN ('DOCKERFILE', 'COMMAND')),
  outcome           TEXT         NOT NULL
                      CHECK (outcome IN ('RUNS', 'BUILDS_ONLY', 'BUILD_FAILED',
                                         'UNSUPPORTED_STACK', 'TIMED_OUT',
                                         'RESOURCE_EXCEEDED', 'PROBE_ERROR')),
  -- The deterministic grade derived from the outcome. No model participates (E05-S04 #3).
  runs_grade        TEXT         NOT NULL
                      CHECK (runs_grade IN ('RUNS', 'BUILDS_ONLY', 'FAILS_TO_BUILD', 'UNSUPPORTED')),
  runs_score        INTEGER      NOT NULL,
  grade_reason      TEXT         NOT NULL,

  exit_code         INTEGER,
  build_duration_ms INTEGER      NOT NULL DEFAULT 0,
  stayed_up         BOOLEAN      NOT NULL DEFAULT FALSE,
  run_duration_ms   INTEGER      NOT NULL DEFAULT 0,
  duration_ms       INTEGER      NOT NULL DEFAULT 0,
  timed_out         BOOLEAN      NOT NULL DEFAULT FALSE,
  resource_exceeded BOOLEAN      NOT NULL DEFAULT FALSE,

  log               TEXT         NOT NULL DEFAULT '',
  log_uri           TEXT,
  log_truncated     BOOLEAN      NOT NULL DEFAULT FALSE,
  log_bytes         INTEGER      NOT NULL DEFAULT 0,

  base_image        TEXT,
  -- Egress permitted for this probe, recorded so a later reader knows what it could reach
  -- (E05-S01 acceptance 3).
  egress_allowed    TEXT[]       NOT NULL DEFAULT '{}',
  -- The policy actually in force, so an appeal can see the constraints the build ran under.
  policy            JSONB        NOT NULL DEFAULT '{}'::jsonb,

  probe_error       TEXT,
  run_id            BIGINT,
  superseded_at     TIMESTAMPTZ,
  ran_at            TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_probe_submission ON build_probe (submission_id, ran_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_probe_current
  ON build_probe (submission_id) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_probe_outcome ON build_probe (outcome);

-- E05-S05: reading a build log is an audited action, so the audit table carries it. Nothing
-- extra is needed here.

-- Published read model (P1.3). Scoring reads the Runs dimension from this view and never
-- touches the probe table directly.
CREATE OR REPLACE VIEW v_probes_current AS
SELECT submission_id,
       probe_id,
       method,
       outcome,
       runs_grade,
       runs_score,
       grade_reason,
       exit_code,
       stayed_up,
       timed_out,
       resource_exceeded,
       log_truncated,
       base_image,
       ran_at
FROM build_probe
WHERE superseded_at IS NULL;

CREATE OR REPLACE VIEW v_probes_health AS
SELECT outcome,
       COUNT(*)::int AS count
FROM build_probe
WHERE superseded_at IS NULL
GROUP BY outcome;
