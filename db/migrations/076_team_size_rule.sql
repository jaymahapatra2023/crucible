-- 076 — The team size rule becomes 3 to 8 (E42-S01).
--
-- The bounds were 2 and 6, chosen when nothing enforced them. The competition rule is 3 to 8, and
-- it is about to become a REFUSAL on a public endpoint rather than a warning on an organiser's
-- checklist — so the numbers have to be the real ones.
--
-- Still `affects_outcome = FALSE`. A team's size decides nothing about how its work scores, and
-- pinning it into runs would make correcting the rule invalidate a calibration gate.
--
-- The distinction E42 rests on, recorded here because both readings are defensible:
--
--   * For PUBLIC self-registration the bounds are a refusal. The rule is the contract with
--     entrants, and an endpoint that accepted a team of two would create a dispute nobody could
--     settle afterwards.
--   * For an ORGANISER assembling teams the bounds stay advisory. A half-formed team at 9am is
--     normal, and a system that refused to record one would be describing a world that does not
--     exist. `rosterReadiness` keeps naming them.

UPDATE app_config
   SET value = '3'::jsonb,
       description = 'Fewest members a team may have (E42). Enforced on public registration, advisory for organiser-assembled teams.',
       updated_by = 'migration',
       updated_at = now()
 WHERE key = 'roster.min_team_size';

UPDATE app_config
   SET value = '8'::jsonb,
       description = 'Most members a team may have (E42). Enforced on public registration, advisory for organiser-assembled teams.',
       updated_by = 'migration',
       updated_at = now()
 WHERE key = 'roster.max_team_size';
