-- 084 — Pre-flight checks per submission (E46-S01, E46-S02).
--
-- Tier 1 (E45) refuses in seconds. Everything that needs minutes — a clone at scan depth, a
-- build, a run, a description — happens here, asynchronously, and blocks nothing: a pre-flight
-- verdict tells a team what to fix while they still can and is advisory to the evaluator.
--
-- Named "preflight" rather than "readiness" because three readiness endpoints already exist
-- (platform, roster, rubrics) and each means something else.
--
-- The QUEUED rows ARE the queue (P11.4): a run is claimed with FOR UPDATE SKIP LOCKED, so two API
-- instances draining at once never run the same one, and a restart loses nothing but a tick.
-- `submission_id` and `team_id` are plain columns, not foreign keys (ADR 0002).

ALTER TABLE run DROP CONSTRAINT IF EXISTS run_kind_check;
ALTER TABLE run ADD CONSTRAINT run_kind_check
  CHECK (kind IN ('SCAN', 'PROBE', 'SCORE', 'COHORT', 'CALIBRATION', 'DRY_RUN', 'DISCOVERY',
                  'PREFLIGHT'));

CREATE TABLE IF NOT EXISTS preflight_run (
  preflight_id   BIGSERIAL    PRIMARY KEY,
  submission_id  BIGINT       NOT NULL,
  team_id        BIGINT       NOT NULL,
  -- The commit the checks looked at. Known once the scan has run; null until then or if it
  -- never got that far.
  commit_sha     TEXT,
  status         TEXT         NOT NULL DEFAULT 'QUEUED'
                   CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED')),
  -- READY: every check passed. PROBLEMS: at least one FAIL. UNKNOWN: no FAIL, but at least one
  -- check the harness could not complete. Null until the run completes; never set on FAILED.
  verdict        TEXT         CHECK (verdict IN ('READY', 'PROBLEMS', 'UNKNOWN')),
  -- [{ key, label, status: PASS|FAIL|UNKNOWN, summary, remedy, detail }]
  checks         JSONB        NOT NULL DEFAULT '[]'::jsonb,
  -- Checks configured not to run (discovery, when the flag is off). Named, so an absence is
  -- visibly a choice rather than a check that silently never happened.
  skipped        TEXT[]       NOT NULL DEFAULT '{}',
  ledger_run_id  BIGINT,
  triggered_by   TEXT         NOT NULL,
  forced         BOOLEAN      NOT NULL DEFAULT FALSE,
  error          TEXT,
  queued_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ
);

-- One live run per submission: a second trigger while one is queued or running joins it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_preflight_live
  ON preflight_run (submission_id) WHERE status IN ('QUEUED', 'RUNNING');
CREATE INDEX IF NOT EXISTS idx_preflight_submission ON preflight_run (submission_id, preflight_id DESC);
CREATE INDEX IF NOT EXISTS idx_preflight_queue ON preflight_run (queued_at) WHERE status = 'QUEUED';

COMMENT ON TABLE preflight_run IS
  'Asynchronous per-submission checks (E46). Advisory: blocks nothing, tells a team what to fix.';

-- Whether the team was told (E46-S03 acceptance 5): the token_delivery pattern, reused. A run
-- with no notice row is a team nobody told — visible, not silent.
CREATE TABLE IF NOT EXISTS preflight_notice (
  notice_id        BIGSERIAL    PRIMARY KEY,
  preflight_id     BIGINT       NOT NULL UNIQUE REFERENCES preflight_run (preflight_id) ON DELETE CASCADE,
  team_id          BIGINT       NOT NULL,
  mail_key         TEXT         NOT NULL,
  -- UNCHANGED: the same commit, verdict and failing checks were already sent for this
  -- submission, so a repeat was deliberately not sent. Recorded, because "we chose not to" and
  -- "we forgot" must never look alike.
  status           TEXT         NOT NULL
                     CHECK (status IN ('SENT', 'PREPARED', 'FAILED', 'UNCHANGED')),
  provider         TEXT         NOT NULL,
  detail           TEXT,
  provider_ref     TEXT,
  template_version INTEGER,
  sent_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_preflight_notice_team ON preflight_notice (team_id);

-- The published read model (P1.3): the latest run per submission, with whether the team was
-- told. The entries table reads this; nothing outside the module reads the tables.
CREATE OR REPLACE VIEW v_preflight_latest AS
SELECT DISTINCT ON (r.submission_id)
       r.preflight_id, r.submission_id, r.team_id, r.commit_sha, r.status, r.verdict,
       r.checks, r.skipped, r.error, r.triggered_by, r.queued_at, r.started_at, r.finished_at,
       n.status AS notice_status, n.detail AS notice_detail, n.sent_at AS notified_at
FROM preflight_run r
LEFT JOIN preflight_notice n ON n.preflight_id = r.preflight_id
ORDER BY r.submission_id, r.preflight_id DESC;

INSERT INTO app_config (key, value, value_type, description, module, editable, affects_outcome)
VALUES
  ('preflight.concurrency', '2'::jsonb, 'number',
   'Submissions pre-flighted at once (E46). Each one may build and run a container, so forty simultaneous submissions must not start forty builds.',
   'preflight', TRUE, FALSE),
  ('preflight.run_timeout_minutes', '30'::jsonb, 'number',
   'A run still RUNNING after this long is recorded FAILED — the process running it went away — so a submission is never stuck in "checking" (E46-S02 acceptance 5).',
   'preflight', TRUE, FALSE)
ON CONFLICT (key) DO NOTHING;

INSERT INTO feature_flag (key, enabled, description) VALUES
('feature.preflight.enabled', TRUE,
 'Run the asynchronous pre-flight checks at all. Off, nothing is queued and nothing drains.'),
('feature.preflight.auto_run', TRUE,
 'Queue a pre-flight run automatically when a submission passes tier 1. Off, an organiser triggers each one.'),
('feature.preflight.discovery', FALSE,
 'Include repository discovery in pre-flight. Roughly seven model calls per submission, so it is a cost decision — and it requires feature.discovery.enabled as well.'),
('feature.preflight.notify', TRUE,
 'Email the team the outcome of each pre-flight run. Off, the run is recorded and the notice records that nobody was told.')
ON CONFLICT (key) DO NOTHING;
