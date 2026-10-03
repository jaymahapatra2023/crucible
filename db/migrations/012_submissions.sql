-- 012 — Team submissions and the intake window (E03).
--
-- Resubmission supersedes and is versioned (E03-S01 acceptance 3) rather than overwriting: the
-- evaluated artifact must be the submitted one, and "which entry did we actually judge" has to
-- stay answerable after the event.

CREATE TABLE IF NOT EXISTS submission_window (
  window_id    BIGSERIAL    PRIMARY KEY,
  name         TEXT         NOT NULL,
  opens_at     TIMESTAMPTZ  NOT NULL,
  closes_at    TIMESTAMPTZ  NOT NULL,
  -- Set when an organiser locks intake. After this, writes are refused (E03-S04).
  locked_at    TIMESTAMPTZ,
  locked_by    TEXT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT chk_window_order CHECK (closes_at > opens_at)
);

-- Exactly one window is current at a time; a second would make "is intake open" ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS uq_window_unlocked
  ON submission_window ((TRUE)) WHERE locked_at IS NULL;

CREATE TABLE IF NOT EXISTS submission (
  submission_id     BIGSERIAL    PRIMARY KEY,
  team_name         TEXT         NOT NULL,
  contact_email     TEXT         NOT NULL,
  challenge_id      BIGINT       NOT NULL,
  repo_url          TEXT         NOT NULL,

  -- E03-S03: the team declares how the project builds, so the prober does not have to guess.
  build_method      TEXT         NOT NULL
                      CHECK (build_method IN ('DOCKERFILE', 'COMMAND')),
  dockerfile_path   TEXT,
  build_command     TEXT,
  artifact_urls     TEXT[]       NOT NULL DEFAULT '{}',

  -- Resubmission chain. `version` increments; only the newest is CURRENT.
  version           INTEGER      NOT NULL DEFAULT 1 CHECK (version >= 1),
  superseded_by     BIGINT,
  is_current        BOOLEAN      NOT NULL DEFAULT TRUE,

  validation_status TEXT         NOT NULL DEFAULT 'PENDING'
                      CHECK (validation_status IN
                        ('PENDING', 'VALID', 'UNREACHABLE', 'PRIVATE', 'REJECTED')),
  -- The specific reason, not a generic error (E03-S02 acceptance 2).
  validation_detail TEXT,
  validated_at      TIMESTAMPTZ,

  -- Recorded at lock (E03-S04 acceptance 2), so the evaluated commit is fixed and citable.
  locked_commit_sha CHAR(40),
  locked_at         TIMESTAMPTZ,

  submitted_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  submitted_by      TEXT,

  CONSTRAINT chk_build_declaration CHECK (
    (build_method = 'DOCKERFILE' AND length(btrim(COALESCE(dockerfile_path, ''))) > 0)
    OR
    (build_method = 'COMMAND' AND length(btrim(COALESCE(build_command, ''))) > 0)
  )
);

-- One CURRENT submission per team per challenge (E03-S01 acceptance 3).
CREATE UNIQUE INDEX IF NOT EXISTS uq_submission_current
  ON submission (lower(team_name), challenge_id) WHERE is_current;

CREATE INDEX IF NOT EXISTS idx_submission_challenge
  ON submission (challenge_id, validation_status) WHERE is_current;
CREATE INDEX IF NOT EXISTS idx_submission_validation
  ON submission (validation_status) WHERE is_current;

-- Validation history: a repo that goes private after submission must be visible as a *change*,
-- not just a current status (E03-S02 acceptance 4, risk R8).
CREATE TABLE IF NOT EXISTS submission_validation_event (
  event_id      BIGSERIAL    PRIMARY KEY,
  submission_id BIGINT       NOT NULL REFERENCES submission (submission_id) ON DELETE CASCADE,
  status        TEXT         NOT NULL,
  detail        TEXT,
  commit_sha    CHAR(40),
  duration_ms   INTEGER,
  checked_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_validation_event_submission
  ON submission_validation_event (submission_id, checked_at DESC);

-- Published read models (P1.3). Scans, probes and scoring read submissions through these only.
CREATE OR REPLACE VIEW v_submissions_submission AS
SELECT submission_id,
       team_name,
       challenge_id,
       repo_url,
       build_method,
       dockerfile_path,
       build_command,
       validation_status,
       locked_commit_sha,
       submitted_at
FROM submission
WHERE is_current;

CREATE OR REPLACE VIEW v_submissions_intake_health AS
SELECT challenge_id,
       COUNT(*)                                                    AS total,
       COUNT(*) FILTER (WHERE validation_status = 'VALID')         AS valid,
       COUNT(*) FILTER (WHERE validation_status = 'PENDING')       AS pending,
       COUNT(*) FILTER (WHERE validation_status = 'UNREACHABLE')   AS unreachable,
       COUNT(*) FILTER (WHERE validation_status = 'PRIVATE')       AS private,
       COUNT(*) FILTER (WHERE validation_status = 'REJECTED')      AS rejected,
       COUNT(*) FILTER (WHERE build_method = 'DOCKERFILE')         AS dockerfile_builds,
       COUNT(*) FILTER (WHERE build_method = 'COMMAND')            AS command_builds
FROM submission
WHERE is_current
GROUP BY challenge_id;
