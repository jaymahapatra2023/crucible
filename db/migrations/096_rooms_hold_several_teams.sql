-- 096 — A room holds more than one team.
--
-- `uq_logistics_room` enforced one team per room. That was wrong for this event: the organisers
-- are putting several teams in a hall and want the room to say so, with its capacity, rather than
-- inventing a separate "room" row per table to work around a constraint.
--
-- Capacity is NOT enforced here, deliberately. It is how many people the room seats, and the
-- honest check needs the teams' actual membership, which does not exist until teams register. So
-- the number is surfaced beside the headcount and the organiser decides. Refusing an assignment
-- on the morning of an event because a room is nominally one seat over would be obstructive, and
-- the person doing it can see the room.
DROP INDEX IF EXISTS uq_logistics_room;

CREATE INDEX IF NOT EXISTS idx_logistics_room
  ON team_logistics (room_id) WHERE room_id IS NOT NULL;

-- Published (P1.3): how full each room is, in teams and in people, against what it seats.
CREATE OR REPLACE VIEW v_roster_room_load AS
SELECT r.room_id,
       r.label,
       r.location,
       r.capacity,
       r.in_use,
       COUNT(DISTINCT l.team_id)::int                       AS teams,
       COUNT(m.participant_id)::int                         AS people,
       CASE WHEN r.capacity IS NULL THEN FALSE
            ELSE COUNT(m.participant_id) > r.capacity END    AS over_capacity
  FROM room r
  LEFT JOIN team_logistics l ON l.room_id = r.room_id
  LEFT JOIN team_member    m ON m.team_id = l.team_id
 GROUP BY r.room_id, r.label, r.location, r.capacity, r.in_use;

COMMENT ON VIEW v_roster_room_load IS
  'Published (P1.3): per room, how many teams and people are in it and whether that is over the '
  'capacity recorded for it. Advisory — nothing refuses an assignment on these numbers.';
