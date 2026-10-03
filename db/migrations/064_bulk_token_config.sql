-- 064 — How many tokens may be issued in one go (E20).
--
-- Registering teams one form at a time is fifty form-fills and fifty copy-pastes for a fifty-team
-- event, each of which shows a plaintext token exactly once. A bulk path removes the copy-paste;
-- this is the ceiling on it.
--
-- A ceiling rather than no limit because the request holds every issued plaintext in one response
-- and an operator who pastes the wrong file should be told so, not handed ten thousand tokens.
-- `affects_outcome` is FALSE: it governs how teams are registered, never how they are judged, so
-- it stays live and can be raised mid-event without invalidating a run (P4.4, E14).

INSERT INTO app_config (key, value, value_type, description, module, editable, affects_outcome)
VALUES
('submissions.max_bulk_tokens', '200'::jsonb, 'number',
 'How many teams may be registered from one uploaded file. Raise it for a larger event; the limit exists so a wrong file is refused rather than acted on.',
 'submissions', TRUE, FALSE)

ON CONFLICT (key) DO NOTHING;
