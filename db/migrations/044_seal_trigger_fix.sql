-- 044 — Split the seal trigger by table (E11-S01).
--
-- Migration 043 added the "linking a submission is still allowed" exception, and guarded it with
-- `TG_TABLE_NAME = 'golden_entry'` inside the same boolean expression as `NEW.label`. PL/pgSQL
-- resolves record fields at runtime rather than short-circuiting around them, so the condition
-- raised `record "new" has no field "label"` whenever the trigger fired on `golden_ranking` —
-- turning a refusal into an internal error, which reads to a caller as a bug rather than a rule.
--
-- One function per table. The shared one was false economy: the two tables do not have the same
-- rule, and pretending they did is what produced the fault.

CREATE OR REPLACE FUNCTION refuse_when_sealed() RETURNS TRIGGER AS $$
DECLARE
  set_status TEXT;
BEGIN
  SELECT status INTO set_status FROM golden_set
   WHERE golden_set_id = COALESCE(NEW.golden_set_id, OLD.golden_set_id);

  IF set_status = 'SEALED' THEN
    RAISE EXCEPTION
      'golden set % is SEALED — its entries and hand rankings are fixed (E11-S01)',
      COALESCE(NEW.golden_set_id, OLD.golden_set_id);
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION refuse_entry_change_when_sealed() RETURNS TRIGGER AS $$
DECLARE
  set_status TEXT;
BEGIN
  SELECT status INTO set_status FROM golden_set
   WHERE golden_set_id = COALESCE(NEW.golden_set_id, OLD.golden_set_id);

  IF set_status <> 'SEALED' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Recording which submission an entry was scored as is part of scoring it, not part of
  -- editing the judgement. Allowed only when nothing else on the row moved.
  IF TG_OP = 'UPDATE'
     AND NEW.golden_set_id IS NOT DISTINCT FROM OLD.golden_set_id
     AND NEW.label         IS NOT DISTINCT FROM OLD.label
     AND NEW.repo_url      IS NOT DISTINCT FROM OLD.repo_url
     AND NEW.expected_band IS NOT DISTINCT FROM OLD.expected_band
     AND NEW.edge_case     IS NOT DISTINCT FROM OLD.edge_case
     AND NEW.notes         IS NOT DISTINCT FROM OLD.notes
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'golden set % is SEALED — its entries and hand rankings are fixed (E11-S01)',
    COALESCE(NEW.golden_set_id, OLD.golden_set_id);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_entry_sealed ON golden_entry;
CREATE TRIGGER trg_entry_sealed
  BEFORE INSERT OR UPDATE OR DELETE ON golden_entry
  FOR EACH ROW EXECUTE FUNCTION refuse_entry_change_when_sealed();
