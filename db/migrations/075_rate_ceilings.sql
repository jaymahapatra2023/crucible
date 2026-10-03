-- 075 — Circuit-breaker ceilings for public routes (E41).
--
-- These are NOT a rate-limiting policy. They are a ceiling no person can reach, present only to
-- stop a loop: a retrying script, a held-down button, a misconfigured client. A participant who
-- hits one is by construction not submitting — they are looping — and the message says so.
--
-- Every ceiling is derived from the most demanding LEGITIMATE use and then multiplied, and the
-- derivation is written down beside it so a later reader can tell a breaker from a policy.
--
-- `/auth/login` is the one exception: it is staff-only, no entrant ever touches it, and
-- credential stuffing is the one real attack this system is exposed to. There the limit is set
-- for security, and costs entrants nothing because they never see that route.
--
-- Everything here is `affects_outcome = FALSE`: a ceiling decides nothing about a score, and
-- pinning it into runs would make raising one mid-event invalidate a calibration gate.

INSERT INTO app_config (key, value, value_type, description, module, editable, affects_outcome)
VALUES
  -- A team fixing a build error might resubmit every two minutes for an hour: ~30. Multiplied by
  -- ten. Nothing human reaches 300 submissions in an hour; a loop reaches it in seconds.
  ('http.ceiling_submissions_per_hour', '300'::jsonb, 'number',
   'Submissions per token per hour before the breaker trips (E41). Derived from ~30 legitimate resubmissions, multiplied by ten.',
   'platform', TRUE, FALSE),

  -- A team of eight, each address mistyped twice, plus restarts: ~40. Multiplied by ten.
  ('http.ceiling_registration_per_hour', '400'::jsonb, 'number',
   'Registration calls per client per hour before the breaker trips (E41). Derived from a team of eight with retries, multiplied by ten.',
   'platform', TRUE, FALSE),

  -- Security, not a breaker. A person signing in mistypes a password three or four times.
  ('http.ceiling_login_per_15min', '20'::jsonb, 'number',
   'Sign-in attempts per IP and per email per 15 minutes (E41). Staff-only route: no entrant is affected.',
   'platform', TRUE, FALSE)
ON CONFLICT (key) DO NOTHING;

/*
 * One switch for the whole thing.
 *
 * If the breaker misbehaves during the event, the fix is this flag and not a deploy. Enabled by
 * default because a ceiling nobody can reach costs nothing when it works.
 */
INSERT INTO feature_flag (key, enabled, description, updated_by)
VALUES ('feature.http.rate_limit', TRUE,
        'Circuit-breaker ceilings on public routes (E41). Disable to remove all HTTP limits immediately.',
        'migration')
ON CONFLICT (key) DO NOTHING;
