-- 063 — A team is a record, and a token belongs to one (E17-S01, E17-S02; G4, G13, G14).
--
-- Until now a team's identity was `submission.team_name TEXT`, unique per challenge among
-- current submissions. Three consequences followed from that and all three are defects:
--
--   * "Night Shift" and "The Night Shift" are different teams and neither knows it.
--   * A team that corrects its name between versions starts a second lineage, because the
--     uniqueness key it was matched on changed.
--   * A submission token is labelled with a team name that is never reconciled against the name
--     typed into the form, so the audit trail cannot answer *did this team submit with their own
--     token?* — the one question a disputed entry turns on.
--
-- This migration does NOT build a roster or a registration flow. Teams still have no Crucible
-- account and no password (P8.2); issuing fifty accounts for one evening remains all risk and no
-- benefit. Identity is bound to the token that already exists.

/*
 * The comparable form of a team name: lower-cased, a leading "the" dropped, punctuation and
 * spacing removed.
 *
 * Declared ONCE, here, and used by both the stored column below and every query that looks a
 * team up by name (P1.5 clause 6). The alternative — the same expression written out in the
 * table definition and again in the application — is two declarations that agree until the day
 * one of them is edited.
 */
CREATE OR REPLACE FUNCTION team_normalise(name TEXT) RETURNS TEXT AS $$
  SELECT regexp_replace(
           regexp_replace(lower(btrim(name)), '^the\s+', ''),
           '[^a-z0-9]', '', 'g')
$$ LANGUAGE sql IMMUTABLE STRICT;

CREATE TABLE IF NOT EXISTS team (
  team_id        BIGSERIAL    PRIMARY KEY,
  display_name   TEXT         NOT NULL CHECK (length(btrim(display_name)) >= 2),
  contact_email  TEXT         NOT NULL,

  -- Derived, never hand-maintained: a stored generated column cannot drift from the name it is
  -- derived from.
  normalised_name TEXT        GENERATED ALWAYS AS (team_normalise(display_name)) STORED,

  -- How this record came to exist. A BACKFILL row was INFERRED from a name typed into a form
  -- before teams had identity, and an inference is not the same fact as a token binding — a
  -- reader deciding how much to trust the link needs to be able to tell them apart (P5.1).
  origin         TEXT         NOT NULL DEFAULT 'TOKEN'
                   CHECK (origin IN ('TOKEN', 'ORGANISER', 'BACKFILL')),

  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_by     TEXT,
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Deliberately NOT unique. The backfill below can legitimately produce two rows with the same
-- normalised name — one per challenge — because nothing in the old data proves they were the
-- same people. Collapsing them here would be inventing a fact.
CREATE INDEX IF NOT EXISTS idx_team_normalised ON team (normalised_name);

-- ── A token belongs to exactly one team (E17-S01 acceptance 2) ─────────────────────────────
ALTER TABLE access_token ADD COLUMN IF NOT EXISTS team_id BIGINT REFERENCES team (team_id);

CREATE INDEX IF NOT EXISTS idx_access_token_team
  ON access_token (team_id) WHERE kind = 'SUBMISSION' AND revoked_at IS NULL;

-- ── A submission belongs to a team, and records how it arrived (E17-S02) ───────────────────
ALTER TABLE submission
  ADD COLUMN IF NOT EXISTS team_id            BIGINT REFERENCES team (team_id),
  ADD COLUMN IF NOT EXISTS submitted_token_id BIGINT REFERENCES access_token (token_id),
  ADD COLUMN IF NOT EXISTS submitted_via      TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK (submitted_via IN ('TEAM_TOKEN', 'ORGANISER', 'UNKNOWN'));

COMMENT ON COLUMN submission.submitted_via IS
  'TEAM_TOKEN: the team presented their own token. ORGANISER: entered on their behalf, by the '
  'named organiser in submitted_by. UNKNOWN exists only for rows written before this migration; '
  'nothing writes it.';

COMMENT ON COLUMN submission.team_name IS
  'The name as the team gave it AT THIS VERSION. A historical snapshot, not identity — identity '
  'is team_id, and the current name is team.display_name.';

-- ── Backfill: every existing submission acquires a team, and nothing else about it changes ──
--
-- One team per distinct (lower(team_name), challenge_id). Conservative on purpose: the same
-- name under two challenges becomes two teams, because the old data cannot show they were the
-- same people and a migration must not decide that they were.
DO $$
DECLARE
  grp        RECORD;
  new_team   BIGINT;
BEGIN
  FOR grp IN
    SELECT lower(btrim(team_name)) AS key,
           challenge_id,
           max(submission_id)      AS newest
      FROM submission
     GROUP BY 1, 2
  LOOP
    -- The newest entry's spelling and contact win: it is the most recent thing the team said
    -- about itself.
    INSERT INTO team (display_name, contact_email, origin, created_by)
    SELECT btrim(team_name), contact_email, 'BACKFILL', 'migration:063'
      FROM submission WHERE submission_id = grp.newest
    RETURNING team_id INTO new_team;

    UPDATE submission
       SET team_id = new_team
     WHERE lower(btrim(team_name)) = grp.key
       AND challenge_id = grp.challenge_id;
  END LOOP;
END $$;

-- Every submission carries a team_name, so the backfill above is total. No existing submission
-- is orphaned or rewritten beyond acquiring this key (E17-S01 acceptance 3).
ALTER TABLE submission ALTER COLUMN team_id SET NOT NULL;

-- ── Bind existing tokens to a team, where the label says so UNAMBIGUOUSLY ───────────────────
--
-- A label matching exactly one team is bound. A label matching two — the same name under two
-- challenges — is left unbound, because picking one would be a guess recorded as a fact. The
-- organiser surface shows an unbound token as unbound so it can be fixed by a person.
WITH candidate AS (
  SELECT t.token_id,
         tm.team_id,
         count(*) OVER (PARTITION BY t.token_id) AS matches
    FROM access_token t
    JOIN team tm ON lower(btrim(tm.display_name)) = lower(btrim(t.label))
   WHERE t.kind = 'SUBMISSION' AND t.team_id IS NULL
)
UPDATE access_token t
   SET team_id = c.team_id
  FROM candidate c
 WHERE c.token_id = t.token_id AND c.matches = 1;

-- Newly issued submission tokens MUST name a team. Declared NOT VALID so the rows above that
-- could not be resolved survive and stay visible rather than blocking the migration — the
-- constraint governs everything written from here on, which is the part that matters.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_submission_token_has_team'
  ) THEN
    ALTER TABLE access_token
      ADD CONSTRAINT chk_submission_token_has_team
      CHECK (kind <> 'SUBMISSION' OR team_id IS NOT NULL) NOT VALID;
  END IF;
END $$;

-- ── Uniqueness moves from the string to the identity (E17-S02 acceptance 5) ────────────────
--
-- One current submission per (team, challenge). The old index keyed on lower(team_name), which
-- is exactly what made a rename start a second lineage.
DROP INDEX IF EXISTS uq_submission_current;

CREATE UNIQUE INDEX IF NOT EXISTS uq_submission_current_team
  ON submission (team_id, challenge_id) WHERE is_current;

-- ── Published read models (P1.3) ───────────────────────────────────────────────────────────
--
-- Columns are APPENDED. `v_submissions_submission` is read by scans, probes, scoring, batch,
-- review, governance and readiness, and two further views are built on it; replacing it with a
-- different column order would break all of them at once.
CREATE OR REPLACE VIEW v_submissions_submission AS
SELECT s.submission_id,
       s.team_name,
       s.challenge_id,
       s.repo_url,
       s.build_method,
       s.dockerfile_path,
       s.build_command,
       s.validation_status,
       s.locked_commit_sha,
       s.submitted_at,
       s.team_id,
       t.display_name AS team_display_name,
       s.submitted_via
FROM submission s
JOIN team t ON t.team_id = s.team_id
WHERE s.is_current;

CREATE OR REPLACE VIEW v_submissions_team AS
SELECT team_id, display_name, normalised_name, contact_email, origin, created_at
FROM team;
