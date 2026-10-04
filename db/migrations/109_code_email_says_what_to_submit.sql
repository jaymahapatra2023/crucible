-- 109 — The code email says WHAT to submit and WHY, and warns about the sandbox.
--
-- Until now it said "go to the submit page and paste the code" and stopped. A team reading it at
-- midnight does not know whether we want a repository, a zip, a demo link, or all three; does not
-- know a Dockerfile is what gets built; and — the expensive one — does not know the container is
-- started with no network at all.
--
-- That last point is not in the published rules either, and thirty of this year's entries are
-- conversational tools that call a model API. An app that reaches the internet while STARTING
-- will be recorded as not staying up, which costs it the whole runs dimension for a reason it
-- could have avoided in one line of code. Calls made later, when somebody actually chats, are
-- unaffected: the probe starts the container and watches it stay up, it does not drive the app.
--
-- Telling them is not a favour. A system that grades on something it never disclosed is grading
-- on a secret, and the defensibility of every score here rests on the team being able to see
-- what was asked of them.
--
-- Stood down before inserting: a unique index permits one active version per key.

UPDATE mail_template SET active = FALSE WHERE mail_key = 'mail.token_issued';

INSERT INTO mail_template (mail_key, version, subject, body, variables, content_hash, created_by, active)
SELECT t.mail_key, t.version + 1, t.subject,
       replace(t.body,
'What to do: when your entry is ready, go to {{submit_url}} and paste the code. Your team name
will appear once it is accepted — nothing else to type.',
'What to submit: the URL of the Git repository you built during the event. Public, or readable
by the organisers. We record the commit as it stands the moment you submit and judge that one,
so pushing again afterwards changes nothing.

What to do: go to {{submit_url}}, paste the code, choose your path and give the repository URL.
Your team name appears once the code is accepted — nothing else to type. You can also add links
to a demo video, slides or a hosted instance, which the judges see.

Your repository needs a Dockerfile so we can build and start it. If yours is not at the root,
the form has a box for its path. Include a README saying how to build and run it.

One thing worth five minutes tonight: we start your container with NO NETWORK ACCESS. If your
app calls out to the internet while it is starting up — fetching a model, checking a key, reading
a remote config — it will not start, and that is recorded against it. Make it start cleanly
without the internet. Calls made later, when somebody is actually using it, are not affected.'),
       t.variables, repeat('0', 64), 'migration-109', TRUE
  FROM mail_template t
 WHERE t.mail_key = 'mail.token_issued'
 ORDER BY t.version DESC
 LIMIT 1;

UPDATE mail_template
   SET content_hash = encode(sha256(convert_to(body, 'UTF8')), 'hex')
 WHERE content_hash = repeat('0', 64);
