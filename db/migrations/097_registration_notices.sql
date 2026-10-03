-- 097 — Telling everybody the team is registered.
--
-- Two messages, and the difference between them is deliberate.
--
-- Every member gets the submission code, because any of them may be the one at the keyboard at
-- 11pm and a code held by one person who has gone to sleep is a code the team does not have.
--
-- The coach gets the team, the room and the roster, and NOT the code. The code is the team's
-- identity (E17-S01): whoever holds it can submit as that team. A coach who submits on a team's
-- behalf, even helpfully, breaks the one fact the evaluation rests on. If the organisers decide
-- otherwise, this template is where the decision lives.
INSERT INTO mail_template (mail_key, version, subject, body, variables, content_hash, created_by)
VALUES (
  'mail.coach_team_registered', 1,
  '{{team_name}} is your team — {{room_label}}',
$BODY$Hello {{coach_name}},

{{team_name}} has registered and you are their coach.

Where: {{room_label}}
Who:
{{members}}

They have been sent their own submission code. You have not, on purpose — it is how the system
knows an entry is theirs, so only they should hold it. If they lose it, an organiser can read it
back to them.

What they need from you is the thing a code cannot do: ask what they are building, make them show
you something running before the last hour, and tell them when they are gold-plating.

You will get a sheet for each of your teams before the presentations, with what the evaluation
found and the questions worth asking.
$BODY$,
  ARRAY['coach_name', 'team_name', 'room_label', 'members'],
  repeat('0', 64), 'migration-097'
)
ON CONFLICT (mail_key, version) DO NOTHING;

UPDATE mail_template
   SET content_hash = encode(sha256(convert_to(body, 'UTF8')), 'hex')
 WHERE content_hash = repeat('0', 64);
