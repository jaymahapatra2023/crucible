-- 067 — Rooms, coaches, and what each team was given (E27-S02, E27-S03).
--
-- Both lists are loaded before the day and edited on it. Neither decides a score, so neither is
-- versioned: P7.1 reserves append-only history for state an appeal turns on, and where a team sat
-- is not that. Every change records an audit event, which answers the question actually asked —
-- who moved them, and when.
--
-- `team_logistics` lives HERE rather than as columns on `team`, because `team` belongs to the
-- submissions module. Per ADR 0002 a cross-module reference is a plain column, not a foreign key,
-- so this module owns the table and holds `team_id` as a plain column; `room_id` and `coach_id`
-- are real foreign keys because they are within the module.

CREATE TABLE IF NOT EXISTS room (
  room_id    BIGSERIAL    PRIMARY KEY,
  label      TEXT         NOT NULL CHECK (length(btrim(label)) >= 1),
  -- Building, floor, wing — whatever the venue calls it.
  location   TEXT         NOT NULL DEFAULT '',
  capacity   INTEGER      CHECK (capacity IS NULL OR capacity > 0),

  -- Taken out of use rather than deleted: a room used yesterday still has to exist for the
  -- record of where a team sat to resolve.
  in_use     BOOLEAN      NOT NULL DEFAULT TRUE,

  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_by TEXT,
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_room_label ON room (lower(btrim(label)));

CREATE TABLE IF NOT EXISTS coach (
  coach_id     BIGSERIAL    PRIMARY KEY,
  full_name    TEXT         NOT NULL CHECK (length(btrim(full_name)) >= 2),
  email        TEXT         NOT NULL CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  organisation TEXT,
  active       BOOLEAN      NOT NULL DEFAULT TRUE,

  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_by   TEXT,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_coach_email ON coach (lower(btrim(email)));

/*
 * A coach is NOT a participant.
 *
 * Separate table, no membership, and nothing that could put one on a team as a member. Stated
 * here because the two lists look alike and the distinction is the point: a coach helps produce
 * the work, so counting one as a participant would put them inside the thing being judged.
 */

CREATE TABLE IF NOT EXISTS team_logistics (
  team_id    BIGINT       PRIMARY KEY,
  room_id    BIGINT       REFERENCES room (room_id),
  coach_id   BIGINT       REFERENCES coach (coach_id),

  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_by TEXT
);

-- A room holds at most one team. Two teams in one room is a problem in the physical world, so it
-- is refused here rather than reported later.
CREATE UNIQUE INDEX IF NOT EXISTS uq_logistics_room
  ON team_logistics (room_id) WHERE room_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_logistics_coach
  ON team_logistics (coach_id) WHERE coach_id IS NOT NULL;

/*
 * Published read models (P1.3).
 *
 * `v_roster_team_logistics` resolves the labels so a caller needs one read rather than three —
 * and so that no other module has to know the shape of `room` or `coach`.
 */
CREATE OR REPLACE VIEW v_roster_room AS
SELECT room_id, label, location, capacity, in_use FROM room;

CREATE OR REPLACE VIEW v_roster_coach AS
SELECT coach_id, full_name, email, organisation, active FROM coach;

CREATE OR REPLACE VIEW v_roster_team_logistics AS
SELECT l.team_id,
       l.room_id,
       r.label      AS room_label,
       r.location   AS room_location,
       l.coach_id,
       c.full_name  AS coach_name,
       c.email      AS coach_email
FROM team_logistics l
LEFT JOIN room  r ON r.room_id  = l.room_id
LEFT JOIN coach c ON c.coach_id = l.coach_id;
