-- 068 — Who is on which team (E28-S01).
--
-- The join that turns 200 registered people into ~40 teams. `participant_id` is a real foreign
-- key because `participant` is in this module; `team_id` is a plain column because `team` belongs
-- to submissions and ADR 0002 resolves cross-module references at the service layer.
--
-- Unassigning DELETES the membership row rather than superseding it. Membership is not state an
-- appeal turns on — what a team submitted under is snapshotted on the submission itself — and a
-- superseded row would have to be excluded from the unique index that makes the rule enforceable.
-- The audit trail records every assignment and removal.

CREATE TABLE IF NOT EXISTS team_member (
  member_id      BIGSERIAL    PRIMARY KEY,
  team_id        BIGINT       NOT NULL,
  participant_id BIGINT       NOT NULL REFERENCES participant (participant_id),

  -- The person the team is reached through. Their address becomes the team's contact, so the
  -- value E17 requires is not a second thing for an organiser to type.
  is_contact     BOOLEAN      NOT NULL DEFAULT FALSE,

  assigned_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  assigned_by    TEXT
);

-- A participant is on AT MOST ONE team. Two would make "who submitted this" have two answers,
-- so it is refused here rather than reported later.
CREATE UNIQUE INDEX IF NOT EXISTS uq_member_participant
  ON team_member (participant_id);

-- One point of contact per team. A second would make "who do we email" ambiguous at exactly the
-- moment it matters.
CREATE UNIQUE INDEX IF NOT EXISTS uq_member_contact
  ON team_member (team_id) WHERE is_contact;

CREATE INDEX IF NOT EXISTS idx_member_team ON team_member (team_id);

/*
 * Published read model (P1.3).
 *
 * Carries the participant's name and address because every caller that wants a team's roster
 * wants them, and a view that omitted them would make each caller join `participant` itself —
 * which is the coupling the view exists to prevent.
 */
CREATE OR REPLACE VIEW v_roster_team_member AS
SELECT m.member_id,
       m.team_id,
       m.participant_id,
       p.full_name,
       p.email,
       p.organisation,
       m.is_contact,
       m.assigned_at
FROM team_member m
JOIN participant p ON p.participant_id = m.participant_id
WHERE p.deleted_at IS NULL;

/* Per-team counts, so a surface showing forty teams does not read forty rosters. */
CREATE OR REPLACE VIEW v_roster_team_size AS
SELECT team_id,
       COUNT(*)::int                                        AS members,
       MAX(CASE WHEN is_contact THEN email END)             AS contact_email
FROM v_roster_team_member
GROUP BY team_id;
