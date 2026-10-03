-- 058 — The gate records the configuration it vouched for (E14-S03, P4.4).
--
-- The go/no-go gate says this system is fit to eliminate teams. It says so on the evidence of a
-- calibration report produced under one configuration — and, until now, without recording which.
--
-- That leaves a gap wide enough to drive a cohort through: pass the gate, change the cut line or
-- a context budget or the discovery flag, and the gate's verdict still reads as vouching for the
-- run that follows. It does not. A gate is only evidence about the configuration it was measured
-- under, and the only way to say so later is to have written it down.
--
-- Append-only like the rest of the gate: the trigger installed in 041 refuses updates, so this
-- column is set at insert and never moves.

ALTER TABLE gate_decision
  ADD COLUMN IF NOT EXISTS pinned_config JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN gate_decision.pinned_config IS
  'Every outcome-determining setting and every feature flag as they stood when this decision was '
  'taken. A ranking computed under a materially different configuration is not covered by this '
  'verdict, and the ranking says so rather than relying on the verdict silently.';
