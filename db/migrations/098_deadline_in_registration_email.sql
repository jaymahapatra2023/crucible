-- 098 — The code email says when entries close.
--
-- A team is told its submission code at registration and then not contacted again until somebody
-- chases them. That message is the one they keep, so it is where the deadline belongs. The coach
-- notice carries it too, because the coach is chasing the same clock.
--
-- Interpolated, not written in. `{{deadline}}` is rendered from the submission window the system
-- actually enforces, so a deadline that moves moves here too. A date typed into a template is a
-- promise nothing keeps.
--
-- Stood down before inserting: a unique index permits one active version per key.
UPDATE mail_template SET active = FALSE
 WHERE mail_key IN ('mail.token_issued', 'mail.coach_team_registered');

INSERT INTO mail_template (mail_key, version, subject, body, variables, content_hash, created_by, active)
SELECT t.mail_key, t.version + 1, t.subject,
       replace(t.body,
'What to do: when your entry is ready, go to {{submit_url}} and paste the code. Your team name
will appear once it is accepted — nothing else to type.',
'What to do: when your entry is ready, go to {{submit_url}} and paste the code. Your team name
will appear once it is accepted — nothing else to type.

Entries are accepted until {{deadline}}. You can submit as many times as you like before then and
the last one counts, so put something in early rather than leaving it to the final hour.'),
       array_append(t.variables, 'deadline'),
       repeat('0', 64), 'migration-098', TRUE
  FROM mail_template t
 WHERE t.mail_key = 'mail.token_issued'
 ORDER BY t.version DESC
 LIMIT 1;

INSERT INTO mail_template (mail_key, version, subject, body, variables, content_hash, created_by, active)
SELECT t.mail_key, t.version + 1, t.subject,
       replace(t.body,
'They have been sent their own submission code.',
'Entries are accepted until {{deadline}}.

They have been sent their own submission code.'),
       array_append(t.variables, 'deadline'),
       repeat('0', 64), 'migration-098', TRUE
  FROM mail_template t
 WHERE t.mail_key = 'mail.coach_team_registered'
 ORDER BY t.version DESC
 LIMIT 1;

UPDATE mail_template
   SET content_hash = encode(sha256(convert_to(body, 'UTF8')), 'hex')
 WHERE content_hash = repeat('0', 64);
