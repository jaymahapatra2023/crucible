-- 087 — Discord as the delivery channel, email as the recorded fallback (E49).
--
-- A team contact may have a Discord identity beside the address. Deliveries record WHICH channel
-- reached the team, because "sent" by email after Discord refused is a different fact from
-- "sent" by Discord, and an organiser reading the panel needs the one that happened.
--
-- The Discord user id is personal data like an address: it appears in no view a public page
-- reads, in no log line and in no audit payload.

ALTER TABLE participant
  ADD COLUMN IF NOT EXISTS discord_username TEXT,
  ADD COLUMN IF NOT EXISTS discord_user_id  TEXT CHECK (discord_user_id ~ '^[0-9]{15,22}$');

ALTER TABLE team
  ADD COLUMN IF NOT EXISTS contact_discord_user_id TEXT CHECK (contact_discord_user_id ~ '^[0-9]{15,22}$');

ALTER TABLE token_delivery
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'discord'));
ALTER TABLE preflight_notice
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'discord'));

-- Appended last: CREATE OR REPLACE VIEW may add a column only at the end.
CREATE OR REPLACE VIEW v_submissions_team AS
SELECT team_id, display_name, normalised_name, contact_email, origin, created_at,
       contact_discord_user_id
FROM team;

INSERT INTO app_config (key, value, value_type, description, module, editable, affects_outcome)
VALUES
  ('event.discord_invite_url', '""'::jsonb, 'string',
   'Invite link to the event''s Discord server (E49). Shown to a registrant whose username the bot cannot find there. Empty: the message says to ask an organiser.',
   'platform', TRUE, FALSE)
ON CONFLICT (key) DO NOTHING;

INSERT INTO feature_flag (key, enabled, description) VALUES
('feature.notify.discord', TRUE,
 'Deliver by Discord DM when a team contact has a Discord identity and a bot is configured (E49). Off, everything goes by email. A refused DM always falls back to email, recorded as such.')
ON CONFLICT (key) DO NOTHING;

-- The member view carries the id, so making somebody the point of contact carries it to the team
-- the way it already carries the address.
CREATE OR REPLACE VIEW v_roster_team_member AS
SELECT m.member_id,
       m.team_id,
       m.participant_id,
       p.full_name,
       p.email,
       p.organisation,
       m.is_contact,
       m.assigned_at,
       p.discord_user_id
FROM team_member m
JOIN participant p ON p.participant_id = m.participant_id
WHERE p.deleted_at IS NULL;
