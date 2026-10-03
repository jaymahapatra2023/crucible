-- 061 — Setting a security observation aside (E16-S03, G12).
--
-- Every security observation ships with a `benign_explanation` naming what a reviewer should
-- check to rule it out. That is the point of the field. And when the reviewer checked it and it
-- WAS benign, there was nowhere to record that: the observation stayed on the page, the tile
-- stayed amber, and the next reviewer repeated the work.
--
-- Worse than the wasted effort: a checked observation and an unexamined one looked identical.
-- That is the same class of confusion the tile design works hardest to avoid everywhere else.
--
-- Dismissal SUPERSEDES rather than deletes, for the same reason a discovery run does — a finding
-- that vanishes leaves a decision taken while it was on screen unexplainable.

CREATE TABLE IF NOT EXISTS discovery_dismissal (
  dismissal_id   BIGSERIAL    PRIMARY KEY,
  finding_id     BIGINT       NOT NULL REFERENCES discovery_finding (finding_id) ON DELETE CASCADE,
  submission_id  BIGINT       NOT NULL,

  -- Mandatory, and enforced here rather than in a service: the pattern review_flag already
  -- uses, at the level the next caller cannot work around.
  reason         TEXT         NOT NULL CHECK (length(trim(reason)) >= 10),
  dismissed_by   TEXT         NOT NULL,
  dismissed_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),

  -- A superseded dismissal is kept: reinstating an observation is itself a decision.
  withdrawn_at   TIMESTAMPTZ,
  withdrawn_by   TEXT
);

-- One standing dismissal per finding. A second would make "is this set aside?" ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS uq_dismissal_current
  ON discovery_dismissal (finding_id) WHERE withdrawn_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_dismissal_submission
  ON discovery_dismissal (submission_id);

-- Published read model (P1.3): findings with whether they have been set aside, and by whom.
CREATE OR REPLACE VIEW v_discovery_findings_reviewed AS
SELECT f.finding_id, f.discovery_id, f.submission_id, f.kind, f.label, f.summary, f.detail,
       f.path, f.line_start, f.line_end, f.excerpt, f.confidence,
       d.dismissal_id IS NOT NULL AS dismissed,
       d.reason       AS dismissal_reason,
       d.dismissed_by AS dismissed_by,
       d.dismissed_at AS dismissed_at
FROM discovery_finding f
JOIN discovery_run dr ON dr.discovery_id = f.discovery_id
LEFT JOIN discovery_dismissal d
       ON d.finding_id = f.finding_id AND d.withdrawn_at IS NULL
WHERE dr.superseded_at IS NULL;
