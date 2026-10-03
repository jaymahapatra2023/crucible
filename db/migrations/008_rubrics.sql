-- 008 — Rubrics and their criteria (E02-S03 storage, E02-S07 freeze).
--
-- The load-bearing rule: once status = 'FROZEN', the rubric and its criteria are immutable, and
-- that is enforced by a TRIGGER rather than by application code. E02-S07 acceptance 2 is explicit
-- that writes must be refused "at the database level, not only in the application", and P8.5 says
-- no layer trusts the layer above it. A rubric that can be edited after scoring began would make
-- every score unappealable.

CREATE TABLE IF NOT EXISTS rubric (
  rubric_id         BIGSERIAL    PRIMARY KEY,
  challenge_id      BIGINT       NOT NULL,
  version           INTEGER      NOT NULL CHECK (version >= 1),
  status            TEXT         NOT NULL DEFAULT 'DRAFT'
                      CHECK (status IN ('DRAFT', 'IN_REVIEW', 'APPROVED', 'FROZEN', 'SUPERSEDED')),
  -- Computed at freeze over the normalised criteria and dimension weights (E02-S07 acceptance 4).
  content_hash      CHAR(64),
  dimension_weights JSONB        NOT NULL,
  generated_by      TEXT,
  generated_at      TIMESTAMPTZ,
  approved_by       TEXT,
  approved_at       TIMESTAMPTZ,
  frozen_at         TIMESTAMPTZ,
  published_at      TIMESTAMPTZ,
  -- Version chain (P7.2): which rubric this one supersedes.
  previous_id       BIGINT,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (challenge_id, version),
  CONSTRAINT chk_frozen_has_hash
    CHECK (status <> 'FROZEN' OR (content_hash IS NOT NULL AND frozen_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_rubric_challenge ON rubric (challenge_id, version DESC);
-- At most one live (non-superseded) rubric per challenge in a terminal state.
CREATE UNIQUE INDEX IF NOT EXISTS uq_rubric_frozen_per_challenge
  ON rubric (challenge_id) WHERE status = 'FROZEN';

CREATE TABLE IF NOT EXISTS rubric_criterion (
  criterion_id  BIGSERIAL    PRIMARY KEY,
  rubric_id     BIGINT       NOT NULL REFERENCES rubric (rubric_id) ON DELETE CASCADE,
  dimension     TEXT         NOT NULL
                  CHECK (dimension IN ('CHALLENGE_FIDELITY', 'ENGINEERING_QUALITY',
                                       'PRINCIPLES_STANDARDS', 'RUNS', 'ORIGINALITY')),
  name          TEXT         NOT NULL,
  description   TEXT         NOT NULL DEFAULT '',
  weight        NUMERIC(9,6) NOT NULL CHECK (weight >= 0 AND weight <= 1),
  evidence_spec TEXT         NOT NULL CHECK (length(btrim(evidence_spec)) > 0),
  anchor_0      TEXT         NOT NULL CHECK (length(btrim(anchor_0)) > 0),
  anchor_1      TEXT         NOT NULL CHECK (length(btrim(anchor_1)) > 0),
  anchor_2      TEXT         NOT NULL CHECK (length(btrim(anchor_2)) > 0),
  anchor_3      TEXT         NOT NULL CHECK (length(btrim(anchor_3)) > 0),
  anchor_4      TEXT         NOT NULL CHECK (length(btrim(anchor_4)) > 0),
  source_ref    TEXT,
  sort_order    INTEGER      NOT NULL DEFAULT 0,
  -- Quality-gate outcome (E02-S05). A criterion the gate could not repair is surfaced to the
  -- reviewer marked NEEDS_REWRITE rather than dropped (acceptance 2).
  needs_rewrite BOOLEAN      NOT NULL DEFAULT FALSE,
  gate_notes    JSONB        NOT NULL DEFAULT '[]'::jsonb,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- Traceability is mandatory for fidelity criteria (plan §II.3).
  CONSTRAINT chk_source_ref_for_fidelity
    CHECK (dimension <> 'CHALLENGE_FIDELITY' OR length(btrim(COALESCE(source_ref, ''))) > 0)
);

CREATE INDEX IF NOT EXISTS idx_criterion_rubric ON rubric_criterion (rubric_id, sort_order);

-- ── Freeze immutability ──────────────────────────────────────────────────────────────────────
-- A FROZEN rubric accepts exactly one further change: being marked SUPERSEDED when a new version
-- replaces it. Everything else is refused.

CREATE OR REPLACE FUNCTION rubric_freeze_guard() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('FROZEN', 'SUPERSEDED') THEN
      RAISE EXCEPTION
        'rubric % is % and cannot be deleted (E02-S07): a change creates a new version',
        OLD.rubric_id, OLD.status USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'FROZEN' THEN
    -- The only permitted transition out of FROZEN.
    IF NEW.status = 'SUPERSEDED'
       AND NEW.content_hash IS NOT DISTINCT FROM OLD.content_hash
       AND NEW.dimension_weights IS NOT DISTINCT FROM OLD.dimension_weights
       AND NEW.version = OLD.version
       AND NEW.challenge_id = OLD.challenge_id THEN
      RETURN NEW;
    END IF;
    -- Recording publication does not change what the rubric says.
    IF NEW.status = 'FROZEN'
       AND NEW.content_hash IS NOT DISTINCT FROM OLD.content_hash
       AND NEW.dimension_weights IS NOT DISTINCT FROM OLD.dimension_weights
       AND NEW.version = OLD.version THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION
      'rubric % is FROZEN and is immutable (E02-S07): edit creates a new version, not an update',
      OLD.rubric_id USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_rubric_freeze_guard ON rubric;
CREATE TRIGGER trg_rubric_freeze_guard
  BEFORE UPDATE OR DELETE ON rubric
  FOR EACH ROW EXECUTE FUNCTION rubric_freeze_guard();

CREATE OR REPLACE FUNCTION rubric_criterion_freeze_guard() RETURNS TRIGGER AS $$
DECLARE
  parent_status TEXT;
  parent_id     BIGINT;
BEGIN
  parent_id := COALESCE(NEW.rubric_id, OLD.rubric_id);
  SELECT status INTO parent_status FROM rubric WHERE rubric_id = parent_id;

  IF parent_status IN ('FROZEN', 'SUPERSEDED') THEN
    RAISE EXCEPTION
      'rubric % is % — its criteria are immutable (E02-S07); create a new version instead',
      parent_id, parent_status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_criterion_freeze_guard ON rubric_criterion;
CREATE TRIGGER trg_criterion_freeze_guard
  BEFORE INSERT OR UPDATE OR DELETE ON rubric_criterion
  FOR EACH ROW EXECUTE FUNCTION rubric_criterion_freeze_guard();
