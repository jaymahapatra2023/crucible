-- 095 — Pre-provisioned team slots.
--
-- The organisers want the floor plan to exist before anyone arrives: "Team 7 — Ada Room — coach
-- Margaret" printed and taped to a door, every room and coach settled the day before. A
-- registering team then takes the next free slot and inherits its room and coach with no matching
-- step on the day.
--
-- Implemented as a team row that is claimed rather than as a separate table, because a slot
-- becomes the team. Two rows and a transfer would mean two tokens, two identities, and an
-- orphan for every team that registered — and the submission token IS the team's identity
-- (E17-S01), so it must not be reissued under a different row half way through an event.
--
-- `slot_label` is kept after the claim on purpose. It is what the sign on the door says, and on
-- the day somebody will need to walk from "Team 7" to whatever that team called itself.
ALTER TABLE team
  ADD COLUMN IF NOT EXISTS slot_label TEXT,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

COMMENT ON COLUMN team.slot_label IS
  'The label this team was provisioned as, when it began as a pre-provisioned slot ("Team 7"). '
  'Kept after the claim: it is what the printed sign says.';
COMMENT ON COLUMN team.claimed_at IS
  'When a registration took this slot. NULL with a slot_label means the slot is still available.';

-- Slot labels are unique among slots, so two signs cannot say "Team 7".
CREATE UNIQUE INDEX IF NOT EXISTS uq_team_slot_label
  ON team (slot_label) WHERE slot_label IS NOT NULL;

-- The claim reads this: the lowest unclaimed slot, locked and skipped under concurrency.
CREATE INDEX IF NOT EXISTS idx_team_slot_available
  ON team (team_id) WHERE slot_label IS NOT NULL AND claimed_at IS NULL;

-- Published (P1.3): what the roster has provisioned and what is left, for any module that needs
-- to say "41 of 50 slots claimed" without reaching into the roster's tables.
CREATE OR REPLACE VIEW v_roster_team_slot AS
SELECT t.team_id,
       t.slot_label,
       t.display_name,
       t.claimed_at,
       (t.claimed_at IS NULL) AS available,
       r.label    AS room_label,
       c.full_name AS coach_name,
       c.email     AS coach_email
  FROM team t
  LEFT JOIN team_logistics l ON l.team_id = t.team_id
  LEFT JOIN room  r ON r.room_id  = l.room_id
  LEFT JOIN coach c ON c.coach_id = l.coach_id
 WHERE t.slot_label IS NOT NULL;

COMMENT ON VIEW v_roster_team_slot IS
  'Published (P1.3): every pre-provisioned team slot with its room and coach, and whether a '
  'registration has claimed it yet.';
