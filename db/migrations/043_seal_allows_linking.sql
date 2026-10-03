-- 043 — A sealed golden set may still be SCORED (E11-S01).
--
-- The seal exists to fix the human judgement: entries, their expected bands, and the hand
-- rankings. It was written to refuse every change, which also refused the one change that
-- necessarily happens AFTER sealing — recording which submission each entry was scored as.
--
-- Sealing is what permits machine scoring, so a trigger that blocks the result of scoring makes
-- the sealed state unusable. The distinction is between changing the judgement and recording
-- what was done with it: `submission_id` is the second, and nothing else on the row may move.

CREATE OR REPLACE FUNCTION refuse_when_sealed() RETURNS TRIGGER AS $$
DECLARE
  set_status TEXT;
BEGIN
  SELECT status INTO set_status FROM golden_set
   WHERE golden_set_id = COALESCE(NEW.golden_set_id, OLD.golden_set_id);

  IF set_status <> 'SEALED' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Linking (or unlinking) the submission an entry was scored as is part of scoring it, not
  -- part of editing the judgement. Permitted only when every other column is unchanged.
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'golden_entry'
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
