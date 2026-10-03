-- 072 — Where a team goes to submit (E34).
--
-- The token email has to tell a team where to use the code, and the address of this deployment
-- is not something the code can know. It belongs in `app_config` rather than the environment
-- because it is runtime behaviour an organiser changes without a redeploy (P7.5).
--
-- `affects_outcome` is FALSE: the address in an email decides nothing about a score, and pinning
-- it into every scoring run would make an unrelated correction invalidate a calibration gate.
--
-- Empty by default, and the composed message says "the submission page" rather than inventing a
-- URL. A wrong link in the one email a team receives is worse than no link.

INSERT INTO app_config (key, value, value_type, description, module, editable, affects_outcome)
VALUES (
  'event.submit_url',
  '""'::jsonb,
  'string',
  'Where teams go to submit, used in the token email (E34). Empty means the message says "the submission page" rather than guessing a URL.',
  'event',
  TRUE,
  FALSE
)
ON CONFLICT (key) DO NOTHING;
