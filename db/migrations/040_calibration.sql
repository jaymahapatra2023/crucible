-- 040 — Golden set, calibration and the go/no-go gate (E11).
--
-- Two acceptance criteria in this epic are about ORDER OF EVENTS, and order of events is the one
-- thing a document cannot enforce:
--
--   E11-S01 #3: hand-ranked independently by at least two people BEFORE any machine scoring.
--   E11-S03 #1: gate criteria written down BEFORE the report is produced.
--
-- Both exist because the failure they prevent is not dishonesty, it is drift: a threshold set
-- after seeing the number it must clear, a hand ranking adjusted once the machine's answer is
-- known. Nobody decides to do that; it happens. So the schema makes it impossible rather than
-- discouraged — the golden set SEALS, and the criteria are append-only and timestamped.

CREATE TABLE IF NOT EXISTS golden_set (
  golden_set_id BIGSERIAL    PRIMARY KEY,
  name          TEXT         NOT NULL,
  description   TEXT         NOT NULL DEFAULT '',
  -- OPEN accepts entries and hand rankings; SEALED accepts neither and permits machine scoring.
  status        TEXT         NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'SEALED')),
  sealed_at     TIMESTAMPTZ,
  sealed_by     TEXT,
  created_by    TEXT,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT chk_sealed_has_actor CHECK (
    (status = 'OPEN' AND sealed_at IS NULL AND sealed_by IS NULL)
    OR (status = 'SEALED' AND sealed_at IS NOT NULL AND sealed_by IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS golden_entry (
  entry_id      BIGSERIAL    PRIMARY KEY,
  golden_set_id BIGINT       NOT NULL REFERENCES golden_set (golden_set_id) ON DELETE CASCADE,
  label         TEXT         NOT NULL,
  repo_url      TEXT         NOT NULL,
  -- The band the committee expects, recorded before scoring so "we always thought that one was
  -- weak" cannot be claimed afterwards.
  expected_band TEXT         NOT NULL CHECK (expected_band IN ('STRONG', 'MIDDLING', 'WEAK')),
  -- E11-S01 #2's edge cases. NULL means an ordinary repository.
  edge_case     TEXT         CHECK (edge_case IS NULL OR edge_case IN
                   ('SCAFFOLD_ONLY', 'WRONG_PROBLEM', 'FAILS_TO_BUILD', 'VERY_LARGE')),
  notes         TEXT         NOT NULL DEFAULT '',
  -- The submission created for it, once the set is scored.
  submission_id BIGINT,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (golden_set_id, label)
);

-- One row per (ranker, entry). Independence is enforced by the service, which refuses to show
-- one ranker another's positions while the set is OPEN.
CREATE TABLE IF NOT EXISTS golden_ranking (
  id            BIGSERIAL    PRIMARY KEY,
  golden_set_id BIGINT       NOT NULL REFERENCES golden_set (golden_set_id) ON DELETE CASCADE,
  entry_id      BIGINT       NOT NULL REFERENCES golden_entry (entry_id) ON DELETE CASCADE,
  ranker        TEXT         NOT NULL,
  position      INTEGER      NOT NULL CHECK (position >= 1),
  rationale     TEXT         NOT NULL DEFAULT '',
  submitted_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (golden_set_id, ranker, entry_id),
  -- One entry per position per ranker: a ranking with two firsts is not a ranking.
  UNIQUE (golden_set_id, ranker, position)
);

/*
 * A sealed set is immutable, entries and rankings alike.
 *
 * This is the enforcement of "before any machine scoring". Sealing is what permits scoring, so a
 * ranking added afterwards is refused by the database rather than by whoever remembers the rule.
 */
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

DROP TRIGGER IF EXISTS trg_entry_sealed ON golden_entry;
CREATE TRIGGER trg_entry_sealed
  BEFORE INSERT OR UPDATE OR DELETE ON golden_entry
  FOR EACH ROW EXECUTE FUNCTION refuse_when_sealed();

DROP TRIGGER IF EXISTS trg_ranking_sealed ON golden_ranking;
CREATE TRIGGER trg_ranking_sealed
  BEFORE INSERT OR UPDATE OR DELETE ON golden_ranking
  FOR EACH ROW EXECUTE FUNCTION refuse_when_sealed();

CREATE INDEX IF NOT EXISTS idx_golden_entry_set ON golden_entry (golden_set_id);
CREATE INDEX IF NOT EXISTS idx_golden_ranking_set ON golden_ranking (golden_set_id, ranker);
