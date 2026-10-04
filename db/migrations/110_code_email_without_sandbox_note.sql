-- 110 — Drop the no-network paragraph from the code email.
--
-- 109 added it on my judgement that an undisclosed grading condition is indefensible. The
-- organiser's judgement is that it does not belong in this email, and that call is theirs: it is
-- their event, their teams, and their four remaining hours. Reverting the paragraph rather than
-- softening it, because a half-stated sandbox warning is worse than none — it invites a team to
-- redesign around a constraint they cannot see the shape of.
--
-- What 109 added about WHAT to submit stays. That part was never in question.
--
-- The condition itself is unchanged and still real: containmentArgs passes --network none
-- whenever probes.egress_allow_list is empty, which it is. If it is to be communicated at all it
-- now has to be said somewhere else — the rules page, Discord, or a word at the opening — and
-- that is a decision outside this template.
--
-- Stood down before inserting: a unique index permits one active version per key.

UPDATE mail_template SET active = FALSE WHERE mail_key = 'mail.token_issued';

INSERT INTO mail_template (mail_key, version, subject, body, variables, content_hash, created_by, active)
SELECT t.mail_key, t.version + 1, t.subject,
       replace(t.body,
'
One thing worth five minutes tonight: we start your container with NO NETWORK ACCESS. If your
app calls out to the internet while it is starting up — fetching a model, checking a key, reading
a remote config — it will not start, and that is recorded against it. Make it start cleanly
without the internet. Calls made later, when somebody is actually using it, are not affected.
', ''),
       t.variables, repeat('0', 64), 'migration-110', TRUE
  FROM mail_template t
 WHERE t.mail_key = 'mail.token_issued'
 ORDER BY t.version DESC
 LIMIT 1;

UPDATE mail_template
   SET content_hash = encode(sha256(convert_to(body, 'UTF8')), 'hex')
 WHERE content_hash = repeat('0', 64);
