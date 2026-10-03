-- 069 — Team size bounds (E28-S04).
--
-- Advisory, and deliberately so: a half-formed team at 9am on the day is normal, and a system
-- that refused to record it would be describing a world that does not exist. The readiness
-- report names the teams outside the bounds; nothing refuses them.
--
-- `affects_outcome` is FALSE. How many people were on a team does not change how their code is
-- scored, so changing this mid-event invalidates no run (P4.4, E14).

INSERT INTO app_config (key, value, value_type, description, module, editable, affects_outcome)
VALUES
('roster.min_team_size', '2'::jsonb, 'number',
 'Fewest members a team is expected to have. Advisory — the readiness report names teams below it rather than refusing them.',
 'roster', TRUE, FALSE),
('roster.max_team_size', '6'::jsonb, 'number',
 'Most members a team is expected to have. Advisory, for the same reason.',
 'roster', TRUE, FALSE)

ON CONFLICT (key) DO NOTHING;
