-- 107 — The submission-code email drops the Discord paragraph.
--
-- It was added in migration 099 so that a participant replying to the bot was not replying into
-- a void. On the code email it earns its place less than it costs: this is the one message a
-- team must read to the end and act on, and three lines about where NOT to ask a question push
-- the thing that matters — the code, the link, the deadline — further up and out of view on a
-- phone.
--
-- Left in place on `mail.registration_link`, which is read earlier, when a question is far more
-- likely and nothing has to be done with the message.
--
-- Stood down before inserting: a unique index permits one active version per key.

UPDATE mail_template SET active = FALSE WHERE mail_key = 'mail.token_issued';

INSERT INTO mail_template (mail_key, version, subject, body, variables, content_hash, created_by, active)
SELECT t.mail_key, t.version + 1, t.subject,
       rtrim(replace(t.body,
'

Questions go in #General on the event Discord, where an organiser will see them. If this reached
you as a Discord message, do not reply to it — that account only sends and nobody reads replies.', '')),
       t.variables, repeat('0', 64), 'migration-107', TRUE
  FROM mail_template t
 WHERE t.mail_key = 'mail.token_issued'
 ORDER BY t.version DESC
 LIMIT 1;

UPDATE mail_template
   SET content_hash = encode(sha256(convert_to(body, 'UTF8')), 'hex')
 WHERE content_hash = repeat('0', 64);
