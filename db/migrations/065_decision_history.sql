-- 065 — Moving a team between shortlist, hold and exclude keeps the earlier decision (E23).
--
-- The three states were already here and a person could already move between them. What did not
-- survive the move was the decision they moved away from: the write was an upsert, so changing
-- SHORTLIST to EXCLUDE overwrote the decision, the reason, the author and the timestamp.
--
-- P7.1 names `review_decision` as one of the entities whose history must be append-only, and
-- this table is the record an appeal is answered from. "Why was this team excluded" had an
-- answer; "who shortlisted them first, who changed it, and what did they say" did not.
--
-- The pattern is the one used everywhere else here: supersede, never overwrite.

ALTER TABLE shortlist_decision
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS superseded_by BIGINT REFERENCES shortlist_decision (id);

-- One STANDING decision per submission. The old constraint permitted one row in total, which is
-- what forced the overwrite.
ALTER TABLE shortlist_decision
  DROP CONSTRAINT IF EXISTS shortlist_decision_shortlist_id_submission_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_shortlist_decision_current
  ON shortlist_decision (shortlist_id, submission_id) WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_shortlist_decision_history
  ON shortlist_decision (shortlist_id, submission_id, decided_at DESC);

/*
 * Append-only while OPEN, immutable once FINAL.
 *
 * Two rules in one trigger because they are two answers to the same question — may this row
 * change — and splitting them across two triggers would make the order of refusal depend on
 * creation order.
 *
 * Superseding is not an edit of the judgement: it records that a LATER decision replaced this
 * one, and the later decision is its own row carrying its own author and reason. So the two
 * supersede columns may move and nothing else may.
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

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'shortlist decisions are append-only (P7.1): supersede this one rather than deleting it';
  END IF;

  IF TG_OP = 'UPDATE'
     AND NOT (NEW.shortlist_id     IS NOT DISTINCT FROM OLD.shortlist_id
          AND NEW.submission_id    IS NOT DISTINCT FROM OLD.submission_id
          AND NEW.decision         IS NOT DISTINCT FROM OLD.decision
          AND NEW.reason           IS NOT DISTINCT FROM OLD.reason
          AND NEW.decided_by       IS NOT DISTINCT FROM OLD.decided_by
          AND NEW.decided_at       IS NOT DISTINCT FROM OLD.decided_at
          AND NEW.rank_at_decision IS NOT DISTINCT FROM OLD.rank_at_decision)
  THEN
    RAISE EXCEPTION
      'shortlist decisions are append-only (P7.1): record a new decision that supersedes this '
      'one rather than editing what was decided';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Published read model (P1.3): the decision that STANDS. A superseded one is history and is
-- read through the history endpoint, not through the surfaces that show what is true now.
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
JOIN shortlist s ON s.shortlist_id = sd.shortlist_id
WHERE sd.superseded_at IS NULL;
