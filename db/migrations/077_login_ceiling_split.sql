-- 077 — The login ceiling was a policy, not a breaker (E41, corrected).
--
-- 20 sign-ins per 15 minutes per IP failed the test it was written under: the test suite tripped
-- it within seconds, and the test suite is a fair stand-in for reality here. Ten organisers behind
-- one office NAT signing in twice each is twenty. A conference network is one IP.
--
-- The mistake was conflating two different questions under one number:
--
--   * **Per EMAIL** is the security question. Credential stuffing against one account needs
--     thousands of guesses, and a person who has forgotten their password needs about five. A low
--     ceiling here is both effective and invisible.
--   * **Per IP** is a shared-infrastructure question, and every honest user of a shared network is
--     on the wrong side of a low number. It must be a breaker: high enough that no group of people
--     reaches it, low enough to stop a script.
--
-- Split accordingly.

UPDATE app_config
   SET value = '20'::jsonb,
       description = 'Sign-in attempts per EMAIL per 15 minutes (E41). The security limit: stuffing one account needs thousands of guesses, a forgetful person needs about five.',
       updated_by = 'migration',
       updated_at = now()
 WHERE key = 'http.ceiling_login_per_15min';

INSERT INTO app_config (key, value, value_type, description, module, editable, affects_outcome)
VALUES
  ('http.ceiling_login_per_ip_15min', '600'::jsonb, 'number',
   'Sign-in attempts per IP per 15 minutes (E41). A breaker, not a policy: every organiser behind one NAT shares this, so it sits far above any group of people and only stops a script.',
   'platform', TRUE, FALSE)
ON CONFLICT (key) DO NOTHING;
