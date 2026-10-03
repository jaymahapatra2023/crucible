-- 046 — Correct the evaluation date's stored default (E11-S04).
--
-- Migration 045 declared `event.evaluation_date` as a string and stored JSON `null` as its
-- default, which the config service correctly refuses: a key declared `string` read through the
-- string accessor must hold one. The empty string is the right "not set yet" value here — the
-- dry-run report tests it for emptiness and reports the lead time as unknown.
--
-- Corrected forward rather than by editing 045: applied migrations are checksummed, and a
-- migration that changes after it has run is how two databases silently diverge.

UPDATE app_config SET value = '""'::jsonb
 WHERE key = 'event.evaluation_date' AND value = 'null'::jsonb;
