-- 059 — The gate's published read model carries the configuration it vouched for (E14-S03).
--
-- Split from 058 because that migration had already been applied, and the runner checksums
-- every migration: editing an applied one makes the recorded checksum disagree with the file,
-- which is exactly the tamper-detection it exists to provide.
--
-- DROP and recreate rather than CREATE OR REPLACE: the new column sits between existing ones,
-- and REPLACE cannot reorder a view's columns.

DROP VIEW IF EXISTS v_gate_status;

CREATE VIEW v_gate_status AS
SELECT d.decision_id,
       d.decision,
       d.rationale,
       d.decided_by,
       d.decided_at,
       -- The verdict and its scope travel together, so nothing can read one without the other.
       d.pinned_config,
       r.report_id,
       r.golden_set_id,
       r.rank_correlation,
       c.criteria_id,
       c.fallback_plan
FROM gate_decision d
JOIN calibration_report r ON r.report_id = d.report_id
JOIN gate_criteria c ON c.criteria_id = r.criteria_id
ORDER BY d.decided_at DESC;
