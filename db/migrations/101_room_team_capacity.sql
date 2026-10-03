-- 101 — A room holds a number of PEOPLE and a number of TEAMS, and they are not the same number.
--
-- `capacity` has always meant people: how many bodies the fire code allows. The venue plan for
-- codeLinc 11 gives a second, independent figure per room — how many teams fit at its tables —
-- and the two do not derive from each other. The Dining Room seats 100 people but takes 12
-- teams; room 418 seats 8 and takes 1. Dividing one by the other would invent a number nobody
-- gave us and would be wrong in both directions.
--
-- Nullable, like `capacity`. A room whose team figure nobody has worked out is a real state, and
-- a default of 1 would read as a decision that had been made.
--
-- Advisory, like the people figure. `v_roster_room_load` reports being over either limit; nothing
-- refuses. An organiser who puts a thirteenth team in the Dining Room at 11pm because the
-- Mezzanine lost power is making the right call, and the system's job is to show it, not to
-- block it (P5.4: say it in words, never by colour alone).

ALTER TABLE room ADD COLUMN team_capacity integer;

ALTER TABLE room ADD CONSTRAINT room_team_capacity_check
  CHECK (team_capacity IS NULL OR team_capacity > 0);

COMMENT ON COLUMN room.capacity IS
  'How many PEOPLE the room holds. Advisory.';
COMMENT ON COLUMN room.team_capacity IS
  'How many TEAMS the room holds, independent of the people figure (migration 101). Advisory.';

-- Recreated to carry the second limit, and to say which limit is exceeded rather than one
-- boolean that could mean either.
DROP VIEW IF EXISTS v_roster_room_load;

CREATE VIEW v_roster_room_load AS
  SELECT r.room_id,
         r.label,
         r.location,
         r.capacity,
         r.team_capacity,
         r.in_use,
         count(DISTINCT l.team_id)::integer           AS teams,
         count(m.participant_id)::integer             AS people,
         CASE WHEN r.capacity IS NULL THEN FALSE
              ELSE count(m.participant_id) > r.capacity END
                                                      AS over_capacity,
         CASE WHEN r.team_capacity IS NULL THEN FALSE
              ELSE count(DISTINCT l.team_id) > r.team_capacity END
                                                      AS over_team_capacity
    FROM room r
    LEFT JOIN team_logistics l ON l.room_id = r.room_id
    LEFT JOIN team_member    m ON m.team_id = l.team_id
   GROUP BY r.room_id, r.label, r.location, r.capacity, r.team_capacity, r.in_use;

COMMENT ON VIEW v_roster_room_load IS
  'Published read for room occupancy (P1.3): teams and people against both limits.';
