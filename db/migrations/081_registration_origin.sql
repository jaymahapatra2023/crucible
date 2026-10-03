-- 081 — A team the participants formed themselves says so (E44).
--
-- `team.origin` records how a record came to exist, because a reader deciding how much to trust
-- a link needs to tell an inference from a binding (063). A team registered through the public
-- link is a fourth way: neither an organiser's act nor a token's side effect, but the
-- participants' own. Collapsing it into ORGANISER would misattribute the act.

ALTER TABLE team DROP CONSTRAINT IF EXISTS team_origin_check;
ALTER TABLE team ADD CONSTRAINT team_origin_check
  CHECK (origin IN ('TOKEN', 'ORGANISER', 'BACKFILL', 'REGISTRATION'));
