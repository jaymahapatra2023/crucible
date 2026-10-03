-- 099 — The two messages a participant receives say where to ask a question.
--
-- Both templates already said "ask an organiser" without saying how. By email that is harmless:
-- a reply reaches a real inbox. By Discord it is not. The bot holds no gateway connection and
-- never will for this event, so a reply to its DM is received by nothing and read by nobody, and
-- the person who sent it is left believing they asked for help.
--
-- One channel named, and the dead end named as a dead end. The wording is conditional because the
-- same rendered body goes out over both channels: email behind, Discord in front.
--
-- No new variable. The channel is a fact about this event, and a template body IS event data —
-- it lives in this table and is edited by migration, exactly like the sentence next to it. A
-- variable would instead have added a fourth render site for `mail.token_issued` to keep in step,
-- which is the mistake migration 098 made and had to be corrected for.
--
-- Stood down before inserting: a unique index permits one active version per key.

UPDATE mail_template SET active = FALSE
 WHERE mail_key IN ('mail.token_issued', 'mail.registration_link');

INSERT INTO mail_template (mail_key, version, subject, body, variables, content_hash, created_by, active)
SELECT t.mail_key, t.version + 1, t.subject,
       replace(t.body,
'If you lose this code, ask an organiser. It cannot be looked up; they will issue a new one and the
old one will stop working.',
'If you lose this code, ask an organiser. It cannot be looked up; they will issue a new one and the
old one will stop working.

Questions go in #General on the event Discord, where an organiser will see them. If this reached
you as a Discord message, do not reply to it — that account only sends and nobody reads replies.'),
       t.variables, repeat('0', 64), 'migration-099', TRUE
  FROM mail_template t
 WHERE t.mail_key = 'mail.token_issued'
 ORDER BY t.version DESC
 LIMIT 1;

INSERT INTO mail_template (mail_key, version, subject, body, variables, content_hash, created_by, active)
SELECT t.mail_key, t.version + 1, t.subject,
       replace(t.body,
'If your address or a teammate''s is not recognised, ask an organiser to check the participant list.',
'If your address or a teammate''s is not recognised, ask an organiser to check the participant list.

Questions go in #General on the event Discord, where an organiser will see them. If this reached
you as a Discord message, do not reply to it — that account only sends and nobody reads replies.'),
       t.variables, repeat('0', 64), 'migration-099', TRUE
  FROM mail_template t
 WHERE t.mail_key = 'mail.registration_link'
 ORDER BY t.version DESC
 LIMIT 1;

UPDATE mail_template
   SET content_hash = encode(sha256(convert_to(body, 'UTF8')), 'hex')
 WHERE content_hash = repeat('0', 64);
