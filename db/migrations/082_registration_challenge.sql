-- 082 — Which challenge a team registered for (E44-S02 acceptance 6, second look).
--
-- A team is not bound to a challenge until it submits, so the challenge chosen at registration
-- had nowhere to live and was only being written into an audit payload. That makes the dropdown
-- decorative: chosen, then forgotten. Recorded on the link that produced the team — a plain column,
-- since `challenge` belongs to another module (ADR 0002) — so intake can say what a team said it
-- would enter before any entry exists.

ALTER TABLE registration_link ADD COLUMN IF NOT EXISTS challenge_id BIGINT;
