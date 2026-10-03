-- 100 — A delivery can have been carried by BOTH channels.
--
-- Until now Discord was tried and email was its fallback, so exactly one channel carried any
-- message and the column held which one. The event wants both: a code that arrives as a DM and
-- in the inbox is a code the team still has when one of the two goes wrong, and neither channel
-- is reliable enough on its own to be the only one. A DM needs the member to have joined the
-- server and to allow DMs from it; an address can be mistyped on a roster or sit in a spam
-- folder nobody checks until Monday.
--
-- 'both' is a fourth state, not a replacement: 'email' still means email alone carried it (no
-- Discord identity, or Discord refused), and 'discord' still means Discord alone did (the mail
-- relay failed). An organiser reading the panel needs those three apart, because what they would
-- do next differs in each case.
--
-- Widening a CHECK is backward compatible: every row already stored stays valid.

ALTER TABLE token_delivery   DROP CONSTRAINT token_delivery_channel_check;
ALTER TABLE token_delivery   ADD  CONSTRAINT token_delivery_channel_check
  CHECK (channel = ANY (ARRAY['email', 'discord', 'both']));

ALTER TABLE preflight_notice DROP CONSTRAINT preflight_notice_channel_check;
ALTER TABLE preflight_notice ADD  CONSTRAINT preflight_notice_channel_check
  CHECK (channel = ANY (ARRAY['email', 'discord', 'both']));

ALTER TABLE team_reminder    DROP CONSTRAINT team_reminder_channel_check;
ALTER TABLE team_reminder    ADD  CONSTRAINT team_reminder_channel_check
  CHECK (channel = ANY (ARRAY['email', 'discord', 'both']));
