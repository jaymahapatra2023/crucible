-- 047 — Repository discovery (E12).
--
-- What a submission IS, as distinct from how well it scores: its API surface, data model,
-- capabilities, integrations and security observations. See docs/adr/0003-repository-discovery.md
-- for what this takes from the reference implementation and what it deliberately does not.
--
-- One run per (submission, scan). Re-scanning supersedes rather than accumulating, for the same
-- reason scans and probes do: two descriptions of a repository with no way to choose between
-- them is worse than one.

CREATE TABLE IF NOT EXISTS discovery_run (
  discovery_id   BIGSERIAL    PRIMARY KEY,
  submission_id  BIGINT       NOT NULL,
  -- The scan this describes. Discovery reads persisted scan output; it never clones.
  scan_id        BIGINT       NOT NULL,
  commit_sha     TEXT,

  status         TEXT         NOT NULL DEFAULT 'RUNNING'
                   CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
  -- Per-concern outcomes, so one failed extractor does not read as "this repository has none".
  concerns       JSONB        NOT NULL DEFAULT '{}'::jsonb,

  model          TEXT,
  cost_usd       NUMERIC(12,6) NOT NULL DEFAULT 0,
  ledger_run_id  BIGINT,
  started_by     TEXT,
  started_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ,
  error          TEXT,

  superseded_at  TIMESTAMPTZ,
  superseded_by  BIGINT       REFERENCES discovery_run (discovery_id)
);

-- One current discovery per submission. A superseded run keeps its findings as evidence.
CREATE UNIQUE INDEX IF NOT EXISTS uq_discovery_current
  ON discovery_run (submission_id) WHERE superseded_at IS NULL;

/*
 * Findings, one row per thing found, whatever kind it is.
 *
 * A polymorphic table rather than six: the kinds share every column that matters — where it was
 * found, how confident, what the excerpt was — and differ only in a `detail` payload the UI
 * renders per kind. Six near-identical tables would mean six near-identical queries, and the
 * joins that assemble a team's page would multiply for no gain.
 */
CREATE TABLE IF NOT EXISTS discovery_finding (
  finding_id     BIGSERIAL    PRIMARY KEY,
  discovery_id   BIGINT       NOT NULL REFERENCES discovery_run (discovery_id) ON DELETE CASCADE,
  submission_id  BIGINT       NOT NULL,

  kind           TEXT         NOT NULL CHECK (kind IN
                   ('ENDPOINT', 'ENTITY', 'CAPABILITY', 'INTEGRATION', 'SECURITY', 'STACK')),
  -- A short label: the route, the entity name, the capability. What a list shows.
  label          TEXT         NOT NULL CHECK (length(trim(label)) > 0),
  summary        TEXT         NOT NULL DEFAULT '',
  -- The kind-specific payload: methods, fields, protocols, severities.
  detail         JSONB        NOT NULL DEFAULT '{}'::jsonb,

  -- P0 constraint 2: file AND line. The reference implementation records only the file, which
  -- is not enough to check a finding without reading the whole of it.
  path           TEXT         NOT NULL,
  line_start     INTEGER      CHECK (line_start IS NULL OR line_start >= 1),
  line_end       INTEGER      CHECK (line_end IS NULL OR line_end >= 1),
  excerpt        TEXT         NOT NULL DEFAULT '',

  confidence     TEXT         NOT NULL DEFAULT 'MEDIUM'
                   CHECK (confidence IN ('HIGH', 'MEDIUM', 'LOW')),
  found_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_discovery_finding_run
  ON discovery_finding (discovery_id, kind);
CREATE INDEX IF NOT EXISTS idx_discovery_finding_submission
  ON discovery_finding (submission_id, kind);

/*
 * Where the repository's own documentation claims something its code does not appear to do.
 *
 * Advisory, and worded as such. A claim may be true of code the scan never read, so this is a
 * prompt for a reviewer to look — never a finding of dishonesty.
 */
CREATE TABLE IF NOT EXISTS discovery_claim_conflict (
  conflict_id    BIGSERIAL    PRIMARY KEY,
  discovery_id   BIGINT       NOT NULL REFERENCES discovery_run (discovery_id) ON DELETE CASCADE,
  submission_id  BIGINT       NOT NULL,

  claim          TEXT         NOT NULL,
  claim_path     TEXT         NOT NULL,
  claim_line     INTEGER,
  -- What was looked for in the code, and what was found instead.
  expected       TEXT         NOT NULL,
  observed       TEXT         NOT NULL,
  confidence     TEXT         NOT NULL DEFAULT 'MEDIUM'
                   CHECK (confidence IN ('HIGH', 'MEDIUM', 'LOW')),
  found_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_discovery_conflict_run
  ON discovery_claim_conflict (discovery_id);

-- Published read models (P1.3): E08 reads these, never the tables.
CREATE OR REPLACE VIEW v_discovery_current AS
SELECT dr.discovery_id, dr.submission_id, dr.scan_id, dr.commit_sha, dr.status,
       dr.concerns, dr.model, dr.cost_usd, dr.started_at, dr.finished_at, dr.error
FROM discovery_run dr
WHERE dr.superseded_at IS NULL;

CREATE OR REPLACE VIEW v_discovery_findings AS
SELECT f.discovery_id, f.submission_id, f.kind, f.label, f.summary, f.detail,
       f.path, f.line_start, f.line_end, f.excerpt, f.confidence
FROM discovery_finding f
JOIN discovery_run dr ON dr.discovery_id = f.discovery_id
WHERE dr.superseded_at IS NULL;
