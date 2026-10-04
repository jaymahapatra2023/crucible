-- 106 — The registration link email says, plainly, that one person registers the whole team.
--
-- The page says it now. The email has to as well, because the email is what somebody reads on
-- their phone at the door, and the page is reached from it rather than the other way round.
--
-- The failure it prevents is expensive and silent: four members of one team each registering,
-- taking four slots, four rooms and four coaches between them, discovered when somebody notices
-- "Team 12" and "Team 31" have the same three people in them.
--
-- Stood down before inserting: a unique index permits one active version per key.

UPDATE mail_template SET active = FALSE WHERE mail_key = 'mail.registration_link';

INSERT INTO mail_template (mail_key, version, subject, body, variables, content_hash, created_by, active)
SELECT t.mail_key, t.version + 1, t.subject,
       replace(t.body,
'You asked to register a team. This link lets you do that:',
'You asked to register a team. This link lets you do that:
'),
       t.variables, repeat('0', 64), 'migration-106', TRUE
  FROM mail_template t
 WHERE t.mail_key = 'mail.registration_link'
 ORDER BY t.version DESC
 LIMIT 1;

-- Said at the top, where it is read, rather than appended where it is not.
UPDATE mail_template
   SET body = replace(body,
'You asked to register a team. This link lets you do that:',
'You asked to register a team. This link registers the WHOLE team, once.

Only one person does this. Whoever it is adds everybody else by email address, and the whole
team then gets the room, floor and coach. If two of you register, your team exists twice and is
split across two rooms with two different coaches.

This link lets you do that:')
 WHERE mail_key = 'mail.registration_link' AND active;

UPDATE mail_template
   SET content_hash = encode(sha256(convert_to(body, 'UTF8')), 'hex')
 WHERE content_hash = repeat('0', 64);
