-- 102 — A coach takes a stated number of teams, and it is not always one.
--
-- The volunteer register for codeLinc 11 asks each primary coach how many teams they will take.
-- Of the 34 who said yes, 20 said one and 14 said two. That is 48 teams of coaching against 52
-- team spaces in the rooms, so the figure decides whether every team has a coach and which
-- rooms can be filled at all. Without it, provisioning would hand a coach five teams and only
-- the coach would find out.
--
-- Nullable, and advisory, for the same reasons as the room limits (migration 101): a coach whose
-- count nobody has asked for is a real state, a default of 1 would read as an answer, and a
-- coach who takes a third team at 9pm because somebody went home is making the right call.

ALTER TABLE coach ADD COLUMN team_capacity integer;

ALTER TABLE coach ADD CONSTRAINT coach_team_capacity_check
  CHECK (team_capacity IS NULL OR team_capacity > 0);

COMMENT ON COLUMN coach.team_capacity IS
  'How many teams this coach will take (migration 102). Advisory; null means not asked.';

-- Published read (P1.3): how many teams each coach actually holds, against what they said.
CREATE VIEW v_roster_coach_load AS
  SELECT c.coach_id,
         c.full_name,
         c.email,
         c.organisation,
         c.team_capacity,
         c.active,
         count(DISTINCT l.team_id)::integer AS teams,
         CASE WHEN c.team_capacity IS NULL THEN FALSE
              ELSE count(DISTINCT l.team_id) > c.team_capacity END AS over_team_capacity
    FROM coach c
    LEFT JOIN team_logistics l ON l.coach_id = c.coach_id
   GROUP BY c.coach_id, c.full_name, c.email, c.organisation, c.team_capacity, c.active;

COMMENT ON VIEW v_roster_coach_load IS
  'Published read for coach load (P1.3): teams held against the number the coach agreed to.';
