-- 003 — Append-only audit log (E09-S01, P7.1).
--
-- "Append-only" is enforced by a trigger, not by the application declining to write an UPDATE.
-- P8.5: no layer trusts the layer above it for a security-critical decision, and an audit trail
-- an administrator can quietly amend is not an audit trail.

CREATE TABLE IF NOT EXISTS audit_event (
  event_id     BIGSERIAL    PRIMARY KEY,
  actor        TEXT         NOT NULL,
  action       TEXT         NOT NULL,
  subject_type TEXT         NOT NULL,
  subject_id   TEXT         NOT NULL,
  payload      JSONB        NOT NULL DEFAULT '{}'::jsonb,
  correlation_id TEXT,
  at           TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_subject ON audit_event (subject_type, subject_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor   ON audit_event (actor, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action  ON audit_event (action, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_at      ON audit_event (at DESC);

CREATE OR REPLACE FUNCTION audit_event_is_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'audit_event is append-only (P7.1): % on event_id % was refused at the database level',
    TG_OP, COALESCE(OLD.event_id, NEW.event_id)
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_no_update ON audit_event;
CREATE TRIGGER trg_audit_no_update
  BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_is_immutable();

-- Traceability gaps (P7.3): any break in the evidence chain is recorded rather than tolerated.
CREATE TABLE IF NOT EXISTS traceability_gap (
  gap_id       BIGSERIAL    PRIMARY KEY,
  gap_type     TEXT         NOT NULL,
  subject_type TEXT         NOT NULL,
  subject_id   TEXT         NOT NULL,
  detail       TEXT         NOT NULL,
  severity     TEXT         NOT NULL DEFAULT 'MEDIUM'
                 CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  detected_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_traceability_gap_open
  ON traceability_gap (severity, detected_at DESC) WHERE resolved_at IS NULL;
