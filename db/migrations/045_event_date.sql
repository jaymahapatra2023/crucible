-- 045 — When the real evaluation happens (E11-S04 acceptance 4).
--
-- "Run at least one week before the real evaluation" is checkable only if the system knows when
-- the real evaluation is. Without it, the requirement lives in somebody's calendar and the dry
-- run report cannot say whether it was early enough to be worth anything — which is the point of
-- the requirement: a rehearsal the day before leaves no time to act on what it found.

INSERT INTO app_config (key, value, value_type, description, module, editable) VALUES

('event.evaluation_date', 'null'::jsonb, 'string',
 'ISO date of the real evaluation, e.g. "2026-05-18". Set it and the dry-run report will say whether the rehearsal left enough time to act on what it found (E11-S04 acceptance 4). Left unset, the report says the lead time is unknown rather than assuming it was fine.',
 'event', TRUE),

('event.dry_run_lead_days', '7'::jsonb, 'number',
 'Days a full-scale dry run must precede the real evaluation. Seven is the plan''s figure: less than that and a failure found in rehearsal cannot be fixed and re-rehearsed before it matters.',
 'event', TRUE)

ON CONFLICT (key) DO NOTHING;
