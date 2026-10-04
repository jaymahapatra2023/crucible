-- 111 — Drop the Dockerfile paragraph from the code email.
--
-- Same call as 110, same reasoning: the organiser decides what reaches thirty teams four hours
-- before the deadline, and a build instruction arriving this late reads as a new requirement
-- rather than as help. The submit form already asks for the Dockerfile path where it is needed,
-- which is the right place for it — at the moment the team is filling the field in.
--
-- The email is now what it was asked to be: the code, what to submit, where to submit it, and
-- when it is due.
--
-- Stood down before inserting: a unique index permits one active version per key.

UPDATE mail_template SET active = FALSE WHERE mail_key = 'mail.token_issued';

INSERT INTO mail_template (mail_key, version, subject, body, variables, content_hash, created_by, active)
SELECT t.mail_key, t.version + 1, t.subject,
       replace(t.body,
'
Your repository needs a Dockerfile so we can build and start it. If yours is not at the root,
the form has a box for its path. Include a README saying how to build and run it.
', ''),
       t.variables, repeat('0', 64), 'migration-111', TRUE
  FROM mail_template t
 WHERE t.mail_key = 'mail.token_issued'
 ORDER BY t.version DESC
 LIMIT 1;

UPDATE mail_template
   SET content_hash = encode(sha256(convert_to(body, 'UTF8')), 'hex')
 WHERE content_hash = repeat('0', 64);
