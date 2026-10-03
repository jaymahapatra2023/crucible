-- 042 — The calibration bypass, and its default (E11-S03).
--
-- Ranking refuses until the gate has been passed. That is right for the event and wrong for
-- everything before it: development, rehearsal, the dry run itself and the calibration run all
-- need to rank before any gate decision exists.
--
-- So there is a flag, and its default is ON. That deserves stating plainly rather than being
-- buried: shipping it OFF would mean every test and every rehearsal began by failing, and the
-- first thing anybody did would be to turn it on and forget it. Defaulting it ON and making the
-- pre-event checklist turn it OFF puts the decision in front of a person at the moment it
-- matters, instead of at the moment it is an obstacle.
--
-- The service logs a warning on every ranking performed while it is on, so a run that skipped
-- the gate is visible afterwards rather than indistinguishable from one that passed it.

INSERT INTO feature_flag (key, enabled, description) VALUES
('feature.calibration.bypass_gate', TRUE,
 'Allow ranking without a passed go/no-go gate. ON by default so development, rehearsal and the calibration run itself can rank. TURN THIS OFF BEFORE THE REAL EVALUATION: with it on, an uncalibrated system will rank submissions, which is exactly what E11-S03 exists to prevent. Every ranking performed while it is on is logged as such.')
ON CONFLICT (key) DO NOTHING;
