-- 105 — Coaches confirming they are at the venue.
--
-- Fourteen of the thirty-four coaches have agreed to take two teams. A coach who does not turn
-- up therefore leaves two teams without anybody, and until now the only way to know was for
-- somebody to walk four floors looking for them.
--
-- `arrived_at` rather than a boolean: WHEN somebody confirmed is the useful fact at 9am. A
-- confirmation from yesterday evening is not the same claim as one from ten minutes ago, and a
-- boolean cannot tell them apart.
--
-- No approval step, unlike a participant correction (migration 104). The worst a false
-- confirmation does is tell an organiser a coach is present who visibly is not, which is
-- discovered by looking at the room. Nothing about it redirects a team's submission code, so
-- the cost of a queue would buy nothing.

ALTER TABLE coach ADD COLUMN arrived_at TIMESTAMPTZ;

COMMENT ON COLUMN coach.arrived_at IS
  'When this coach confirmed they are at the venue (migration 105). Null means not yet.';

-- Published read (P1.3). The question an organiser actually has is not "who is missing" but
-- "how many teams have nobody", so the view answers that directly rather than leaving them to
-- multiply by two in their head while somebody waits.
CREATE VIEW v_roster_coach_arrival AS
  SELECT c.coach_id,
         c.full_name,
         c.email,
         c.organisation,
         c.team_capacity,
         c.arrived_at,
         (c.arrived_at IS NOT NULL) AS arrived,
         count(DISTINCT l.team_id)::integer AS teams_assigned,
         CASE WHEN c.arrived_at IS NULL THEN count(DISTINCT l.team_id) ELSE 0 END::integer
           AS teams_uncovered
    FROM coach c
    LEFT JOIN team_logistics l ON l.coach_id = c.coach_id
   WHERE c.active
   GROUP BY c.coach_id, c.full_name, c.email, c.organisation, c.team_capacity, c.arrived_at;

COMMENT ON VIEW v_roster_coach_arrival IS
  'Which coaches have confirmed they are here, and how many teams are uncovered (migration 105).';
