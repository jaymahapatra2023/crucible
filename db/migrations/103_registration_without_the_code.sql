-- 103 — The registration email confirms the registration. The code comes later, separately.
--
-- Until now one message did both jobs: "you are registered" and "here is your submission code".
-- That was wrong in two ways on the day. A team registers in the half hour before coding starts,
-- when the code is of no use to them and the thing they actually need is where to sit and who
-- their coach is. And a code that goes out at 9am is a code sitting in ninety-nine inboxes all
-- day before it is needed, with every hour another chance of it being forwarded, screenshotted
-- or pasted into a channel.
--
-- So: this template says they are registered and where to go. `mail.token_issued` keeps the code
-- and the deadline, and is sent once later in the day as a deliberate act by an organiser.
--
-- The coach template gains the floor and keeps everything else. A room number with no floor is
-- an instruction to wander a building.
--
-- Stood down before inserting: a unique index permits one active version per key.

INSERT INTO mail_template (mail_key, version, subject, body, variables, content_hash, created_by, active)
VALUES (
  'mail.team_registered', 1,
  '{{team_name}} is registered — {{room_label}}',
'Hello {{team_name}},

Your team is registered. {{member_count}} of you, and this is where you are:

Room:  {{room_label}}
Floor: {{room_location}}
Coach: {{coach_name}}

Who is on the team:
{{members}}

Your coach is there to be used. Ask them what they think of your idea before you build it, and
show them something running well before the end rather than at it.

Nothing else is needed from you right now. Your submission code will be sent to this address
later today, in its own email, along with how and when to submit. Watch for it.

If any of the above is wrong — the room, the coach, who is on the team — tell an organiser now
rather than at 8pm.',
  ARRAY['team_name', 'member_count', 'room_label', 'room_location', 'coach_name', 'members'],
  repeat('0', 64), 'migration-103', TRUE
);

UPDATE mail_template SET active = FALSE WHERE mail_key = 'mail.coach_team_registered';

INSERT INTO mail_template (mail_key, version, subject, body, variables, content_hash, created_by, active)
SELECT t.mail_key, t.version + 1,
       '{{team_name}} is your team — {{room_label}}, {{room_location}}',
       replace(t.body,
'Where: {{room_label}}
Who:
{{members}}',
'Where: {{room_label}}, {{room_location}}

Who is on the team:
{{members}}'),
       array_append(t.variables, 'room_location'),
       repeat('0', 64), 'migration-103', TRUE
  FROM mail_template t
 WHERE t.mail_key = 'mail.coach_team_registered'
 ORDER BY t.version DESC
 LIMIT 1;

UPDATE mail_template
   SET content_hash = encode(sha256(convert_to(body, 'UTF8')), 'hex')
 WHERE content_hash = repeat('0', 64);
