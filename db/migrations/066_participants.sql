-- 066 — The people at the event (E27-S01).
--
-- Participants register elsewhere; Crucible learns about them as a list. They are records, not
-- users: no password, nothing to sign in to. That is the same choice P8.2 makes for teams and it
-- is made for the same reason — 200 accounts for one weekend is all risk and no benefit.
--
-- What differs from teams is that this is unambiguously PERSONAL DATA. Two consequences are in
-- the schema rather than in a service: a soft delete carrying a reason code including
-- GDPR_ERASURE (P7.4), and no exposure on any public route.

CREATE TABLE IF NOT EXISTS participant (
  participant_id BIGSERIAL    PRIMARY KEY,
  full_name      TEXT         NOT NULL CHECK (length(btrim(full_name)) >= 2),
  email          TEXT         NOT NULL CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),

  -- Recorded because organisers ask for them; neither decides anything.
  organisation   TEXT,
  phone          TEXT,
  notes          TEXT         NOT NULL DEFAULT '',

  -- P7.4. `deleted_at` without a reason is exactly the ambiguity the reason code exists to close.
  deleted_at     TIMESTAMPTZ,
  deleted_by     TEXT,
  delete_reason  TEXT
                   CHECK (delete_reason IS NULL OR delete_reason IN
                     ('USER_REQUEST', 'ADMIN_ACTION', 'GDPR_ERASURE', 'CASCADE', 'DEDUP',
                      'SUPERSEDED')),

  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_by     TEXT,
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT chk_participant_delete_reason CHECK (
    (deleted_at IS NULL AND deleted_by IS NULL AND delete_reason IS NULL)
    OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL AND delete_reason IS NOT NULL))
);

-- One live participant per address. Scoped to the living rows so an erased participant does not
-- block a later re-registration of the same person.
CREATE UNIQUE INDEX IF NOT EXISTS uq_participant_email
  ON participant (lower(btrim(email))) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_participant_name
  ON participant (lower(full_name)) WHERE deleted_at IS NULL;

/*
 * Published read model (P1.3).
 *
 * Deliberately narrow. The assignment surface needs a name and an address to search on; nothing
 * outside this module needs a phone number, and a view that exposed one would make it available
 * to every future caller by default.
 */
CREATE OR REPLACE VIEW v_roster_participant AS
SELECT participant_id,
       full_name,
       email,
       organisation
FROM participant
WHERE deleted_at IS NULL;
