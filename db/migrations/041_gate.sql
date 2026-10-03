-- 041 — Gate criteria, calibration reports and the decision (E11-S02, E11-S03).
--
-- The criteria table is append-only and timestamped because E11-S03 #1 requires them written
-- down BEFORE the report. A threshold that can be edited after the coefficient is known is not
-- a threshold; it is a rationalisation with a schema.

CREATE TABLE IF NOT EXISTS gate_criteria (
  criteria_id      BIGSERIAL    PRIMARY KEY,
  golden_set_id    BIGINT       NOT NULL REFERENCES golden_set (golden_set_id),

  -- The thresholds, stated as numbers so the decision can be checked rather than argued.
  min_rank_correlation NUMERIC(4,3) NOT NULL CHECK (min_rank_correlation BETWEEN -1 AND 1),
  max_material_disagreements INTEGER NOT NULL CHECK (max_material_disagreements >= 0),
  material_rank_gap  INTEGER      NOT NULL CHECK (material_rank_gap >= 1),
  max_run_variance   NUMERIC(6,3) NOT NULL CHECK (max_run_variance >= 0),

  -- What happens if the gate fails, written before anyone knows whether it will (acceptance 3).
  fallback_plan    TEXT         NOT NULL CHECK (length(trim(fallback_plan)) >= 20),
  notes            TEXT         NOT NULL DEFAULT '',

  recorded_by      TEXT         NOT NULL,
  recorded_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS calibration_report (
  report_id        BIGSERIAL    PRIMARY KEY,
  golden_set_id    BIGINT       NOT NULL REFERENCES golden_set (golden_set_id),
  -- The criteria in force when this report was produced. NOT NULL: a report with no criteria to
  -- be judged against is a number looking for a threshold.
  criteria_id      BIGINT       NOT NULL REFERENCES gate_criteria (criteria_id),
  run_index_id     BIGINT       NOT NULL,
  second_run_index_id BIGINT,

  rank_correlation NUMERIC(4,3),
  correlation_note TEXT,
  sample_size      INTEGER      NOT NULL,
  material_disagreements INTEGER NOT NULL DEFAULT 0,
  max_run_variance NUMERIC(6,3),

  -- The full detail, kept so the report can be re-read rather than re-derived.
  detail           JSONB        NOT NULL DEFAULT '{}'::jsonb,
  generated_by     TEXT         NOT NULL,
  generated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gate_decision (
  decision_id      BIGSERIAL    PRIMARY KEY,
  report_id        BIGINT       NOT NULL REFERENCES calibration_report (report_id),
  decision         TEXT         NOT NULL CHECK (decision IN ('GO', 'NO_GO')),
  -- Mandatory either way. "Why did you proceed" is as much a question as "why did you stop".
  rationale        TEXT         NOT NULL CHECK (length(trim(rationale)) >= 20),
  decided_by       TEXT         NOT NULL,
  decided_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

/*
 * Criteria and decisions are append-only (P7.1).
 *
 * Editing either after the fact would make the record agree with whatever happened, which is the
 * precise failure this epic exists to prevent.
 */
CREATE OR REPLACE FUNCTION refuse_gate_change() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (E11-S03): it records what was decided, when', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_criteria_append_only ON gate_criteria;
CREATE TRIGGER trg_criteria_append_only
  BEFORE UPDATE OR DELETE ON gate_criteria
  FOR EACH ROW EXECUTE FUNCTION refuse_gate_change();

DROP TRIGGER IF EXISTS trg_decision_append_only ON gate_decision;
CREATE TRIGGER trg_decision_append_only
  BEFORE UPDATE OR DELETE ON gate_decision
  FOR EACH ROW EXECUTE FUNCTION refuse_gate_change();

-- Published read model (P1.3): the current gate position, which ranking consults.
CREATE OR REPLACE VIEW v_gate_status AS
SELECT d.decision_id,
       d.decision,
       d.rationale,
       d.decided_by,
       d.decided_at,
       r.report_id,
       r.golden_set_id,
       r.rank_correlation,
       c.criteria_id,
       c.fallback_plan
FROM gate_decision d
JOIN calibration_report r ON r.report_id = d.report_id
JOIN gate_criteria c ON c.criteria_id = r.criteria_id
ORDER BY d.decided_at DESC;
