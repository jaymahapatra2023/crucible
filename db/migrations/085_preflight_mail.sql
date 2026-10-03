-- 085 — What a team is told after pre-flight (E46-S03).
--
-- Three messages, one per verdict. None carries a score, a rank or a hint about how the entry
-- would be judged: they say what would stop it being EVALUATED at all, and what to do. The
-- UNKNOWN message is separate from PROBLEMS because "we could not check" is not "you got it
-- wrong", and a team that reads the second when the first is true spends its evening fixing
-- nothing (P5.1).
--
-- Every template states, in order: what happened, what to do, who to ask (E43-S02).

INSERT INTO mail_template (mail_key, version, subject, body, variables, content_hash, created_by)
VALUES
(
  'mail.preflight_ready', 1,
  '{{team_name}} — your entry is ready for evaluation',
$BODY$Hello {{team_name}},

Your entry for {{challenge_name}} is ready for evaluation. We checked commit {{commit}}: the
repository was read, it built, it started and stayed up, and nothing in it looked like a
committed credential.

What to do: nothing — unless you push more work. A later commit is not checked until you submit
again, and whatever is on your default branch when intake closes is what gets evaluated.

If anything here looks wrong, ask an organiser.$BODY$,
  ARRAY['team_name', 'challenge_name', 'commit'],
  repeat('0', 64), 'migration'
),
(
  'mail.preflight_problems', 1,
  '{{team_name}} — things to fix before your entry can be evaluated',
$BODY$Hello {{team_name}},

We checked commit {{commit}} of your entry for {{challenge_name}} and found things that would stop
it being evaluated:

{{findings}}

What to do: fix each item above and submit again. The checks run again automatically after every
submission, and you will get a fresh result. This is not a score and nothing here affects one — it
is only what has to work for your entry to be looked at.

If you believe a check is wrong, ask an organiser.$BODY$,
  ARRAY['team_name', 'challenge_name', 'commit', 'findings'],
  repeat('0', 64), 'migration'
),
(
  'mail.preflight_unknown', 1,
  '{{team_name}} — we could not finish checking your entry',
$BODY$Hello {{team_name}},

We tried to check commit {{commit}} of your entry for {{challenge_name}}, and some checks could not
be completed on our side:

{{findings}}

This is not a problem with your entry and there is nothing for you to fix. An organiser has been
told and the checks will be run again. If you push more work in the meantime, submit again as
usual.

If you have questions, ask an organiser.$BODY$,
  ARRAY['team_name', 'challenge_name', 'commit', 'findings'],
  repeat('0', 64), 'migration'
)
ON CONFLICT (mail_key, version) DO NOTHING;

UPDATE mail_template
   SET content_hash = encode(sha256(convert_to(subject || E'\n' || body, 'UTF8')), 'hex')
 WHERE content_hash = repeat('0', 64);
