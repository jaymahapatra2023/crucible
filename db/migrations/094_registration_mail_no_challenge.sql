-- 094 — The registration email no longer tells teams to pick a challenge.
--
-- Teams register in the half hour before coding begins, which is before most of them have settled
-- on a path. The choice is made on the submission form, where the team knows which path it took
-- and is shown the rubric it will be judged by. The email was still instructing them to choose one
-- at registration, which is now a step that does not exist — and an instruction to do something
-- the screen does not offer is worse than no instruction.
--
-- A new version rather than an edit: a template is versioned and content-hashed so that what a
-- participant was sent can be reconstructed afterwards. Exactly one version per key is active,
-- which the reader relies on, so the old one is stood down in the same transaction.
-- Stood down FIRST: a unique index permits one active version per key, so the new row cannot be
-- inserted while the old one still holds the slot.
UPDATE mail_template
   SET active = FALSE
 WHERE mail_key = 'mail.registration_link';

INSERT INTO mail_template (mail_key, version, subject, body, variables, content_hash, created_by, active)
SELECT t.mail_key,
       t.version + 1,
       t.subject,
       replace(t.body,
         'name your team, pick the challenge, and add your teammates',
         'name your team and add your teammates'),
       t.variables,
       encode(sha256(convert_to(
         replace(t.body,
           'name your team, pick the challenge, and add your teammates',
           'name your team and add your teammates'), 'UTF8')), 'hex'),
       'migration-094',
       TRUE
  FROM mail_template t
 WHERE t.mail_key = 'mail.registration_link'
 ORDER BY t.version DESC
 LIMIT 1;
