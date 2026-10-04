-- 104 — Participants correcting their own name and address, from a public page.
--
-- Twenty-three people signed up on paper at the desk and were loaded under placeholder addresses,
-- and several handwritten names are guesses. Those people need a way to say "that is me, and
-- this is my real email" without queueing to speak to an organiser.
--
-- The dangerous version of this feature searches by name and shows the record. That is a
-- directory of everyone present, on a public URL, and worse: changing somebody's address puts
-- you on their team's emails, including the one carrying their submission code. The code is the
-- team's identity (E17-S01), so a public edit box is a route to submitting as another team.
--
-- So nothing is shown and nothing is applied. A submission records what was CLAIMED, the server
-- works out privately whether a participant of that name exists, and an organiser confirms with
-- one click against the before-and-after. The page answers with the same sentence either way, so
-- it cannot be used to find out who is here.

CREATE TABLE participant_correction (
  correction_id   BIGSERIAL PRIMARY KEY,
  -- As typed. Kept verbatim rather than cleaned up: an organiser deciding whether this is the
  -- same person needs to see what the person actually wrote.
  claimed_name    TEXT        NOT NULL,
  claimed_email   TEXT        NOT NULL,
  -- Resolved at submission, privately. NULL means no participant of that name — still recorded,
  -- because a walk-in nobody wrote down is a real case and an organiser can add them.
  participant_id  BIGINT      REFERENCES participant(participant_id) ON DELETE SET NULL,
  status          TEXT        NOT NULL DEFAULT 'PENDING'
                              CHECK (status IN ('PENDING', 'APPLIED', 'REJECTED')),
  -- What the row held when the claim was made, so the queue can show the change and so an
  -- applied correction is auditable after the fact.
  previous_name   TEXT,
  previous_email  TEXT,
  decided_by      TEXT,
  decided_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_correction_pending ON participant_correction (created_at)
  WHERE status = 'PENDING';

COMMENT ON TABLE participant_correction IS
  'Self-service name and address corrections, held for an organiser to confirm (migration 104).';

-- The same normalisation the public form matches on, defined once in the database so the form,
-- the queue and any later report cannot disagree about what "the same name" means.
CREATE OR REPLACE FUNCTION person_normalise(name TEXT) RETURNS TEXT AS $$
  SELECT regexp_replace(lower(btrim(coalesce(name, ''))), '[^a-z0-9]+', '', 'g');
$$ LANGUAGE SQL IMMUTABLE;

CREATE INDEX idx_participant_normalised ON participant (person_normalise(full_name))
  WHERE deleted_at IS NULL;

-- Published read (P1.3): the queue an organiser works through.
CREATE VIEW v_roster_correction AS
  SELECT c.correction_id,
         c.claimed_name,
         c.claimed_email,
         c.participant_id,
         p.full_name   AS current_name,
         p.email       AS current_email,
         p.organisation,
         (p.participant_id IS NOT NULL) AS matched,
         EXISTS (SELECT 1 FROM team_member m WHERE m.participant_id = p.participant_id) AS on_a_team,
         c.status,
         c.created_at
    FROM participant_correction c
    LEFT JOIN participant p
           ON p.participant_id = c.participant_id AND p.deleted_at IS NULL
   ORDER BY c.created_at;

COMMENT ON VIEW v_roster_correction IS
  'Pending and decided participant corrections, with what the roster currently holds.';
