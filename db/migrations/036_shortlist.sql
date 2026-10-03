-- 036 — Human decisions and the finalised shortlist (E08-S04, E08-S05).
--
-- This is where P0's first constraint becomes a schema. Crucible ranks and flags; the decision
-- is a person's, it carries their name and their reason, and it is recorded as an act rather
-- than as a computed property. Nothing in the scoring tables writes here.
--
-- Reasons are mandatory and enforced by a CHECK, not by a service: the shortlist is the record
-- an appeal is answered from, and "why was this team excluded" must have an answer that was
-- written by a person at the time.

CREATE TABLE IF NOT EXISTS shortlist (
  shortlist_id   BIGSERIAL    PRIMARY KEY,
  run_index_id   BIGINT       NOT NULL REFERENCES score_run (run_index_id) ON DELETE CASCADE,
  name           TEXT         NOT NULL DEFAULT '',
  status         TEXT         NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'FINAL')),

  -- The rubric versions in force when it was locked (E08-S05 acceptance 1). Without these,
  -- "what standard was this shortlist drawn against" is unanswerable after a re-version.
  rubric_versions JSONB       NOT NULL DEFAULT '{}'::jsonb,

  finalised_at   TIMESTAMPTZ,
  finalised_by   TEXT,
  created_by     TEXT,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT chk_final_has_actor CHECK (
    (status = 'OPEN' AND finalised_at IS NULL AND finalised_by IS NULL)
    OR (status = 'FINAL' AND finalised_at IS NOT NULL AND finalised_by IS NOT NULL)),

  -- One shortlist per run. Two would mean two answers to "who presented".
  UNIQUE (run_index_id)
);

CREATE TABLE IF NOT EXISTS shortlist_decision (
  id             BIGSERIAL    PRIMARY KEY,
  shortlist_id   BIGINT       NOT NULL REFERENCES shortlist (shortlist_id) ON DELETE CASCADE,
  submission_id  BIGINT       NOT NULL,

  -- HOLD is a real answer: "we have looked and have not decided". It is distinct from having
  -- no row at all, which means nobody has looked.
  decision       TEXT         NOT NULL CHECK (decision IN ('SHORTLIST', 'EXCLUDE', 'HOLD')),
  reason         TEXT         NOT NULL CHECK (length(trim(reason)) >= 10),

  decided_by     TEXT         NOT NULL,
  decided_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- The rank the submission held when the decision was taken, so a later re-ranking cannot make
  -- a recorded decision look arbitrary.
  rank_at_decision INTEGER,

  UNIQUE (shortlist_id, submission_id)
);

CREATE INDEX IF NOT EXISTS idx_shortlist_decision_list
  ON shortlist_decision (shortlist_id, decision);

/*
 * Immutability after finalisation (E08-S04 acceptance 2).
 *
 * Enforced by a trigger rather than by the service layer. A finalised shortlist is the record
 * of what was decided; a service-level check protects only the callers that remember it, and
 * the next one to write a bulk update will not.
 */
CREATE OR REPLACE FUNCTION refuse_decision_change_when_final() RETURNS TRIGGER AS $$
DECLARE
  list_status TEXT;
BEGIN
  SELECT status INTO list_status FROM shortlist
   WHERE shortlist_id = COALESCE(NEW.shortlist_id, OLD.shortlist_id);

  IF list_status = 'FINAL' THEN
    RAISE EXCEPTION
      'shortlist % is FINAL — its decisions are immutable (E08-S04); reopen it to change one',
      COALESCE(NEW.shortlist_id, OLD.shortlist_id);
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_decision_immutable ON shortlist_decision;
CREATE TRIGGER trg_decision_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON shortlist_decision
  FOR EACH ROW EXECUTE FUNCTION refuse_decision_change_when_final();

-- Published read model (P1.3): an override travels with the submission wherever it appears
-- (E08-S04 acceptance 3).
CREATE OR REPLACE VIEW v_shortlist_decisions AS
SELECT sd.shortlist_id,
       s.run_index_id,
       s.status AS shortlist_status,
       sd.submission_id,
       sd.decision,
       sd.reason,
       sd.decided_by,
       sd.decided_at,
       sd.rank_at_decision
FROM shortlist_decision sd
JOIN shortlist s ON s.shortlist_id = sd.shortlist_id;
