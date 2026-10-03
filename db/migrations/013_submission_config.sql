-- 013 — Configuration for submission intake (E03). Data, not constants (P3.6).

INSERT INTO app_config (key, value, value_type, description, module, editable) VALUES

('submissions.allowed_hosts',
 '["github.com","gitlab.com"]'::jsonb, 'json',
 'Repository hosts a submission may point at (E03-S02 acceptance 1). Anything else is rejected at submit time rather than discovered on evaluation night.',
 'submissions', TRUE),

('submissions.clone_timeout_ms', '60000'::jsonb, 'number',
 'Wall-clock limit for the validation clone. A repository that cannot be fetched inside this is treated as unreachable.',
 'submissions', TRUE),

('submissions.max_repo_mb', '512'::jsonb, 'number',
 'Advisory size ceiling. A repository beyond this is accepted but flagged, because the file budget will truncate it (risk R6).',
 'submissions', TRUE),

('submissions.revalidate_interval_minutes', '60'::jsonb, 'number',
 'How often previously-valid submissions are re-checked until the window closes (E03-S02 acceptance 4, risk R8).',
 'submissions', TRUE),

('submissions.max_artifact_urls', '5'::jsonb, 'number',
 'How many supporting links a team may attach.',
 'submissions', TRUE)

ON CONFLICT (key) DO NOTHING;

INSERT INTO feature_flag (key, enabled, description) VALUES
('feature.submissions.self_service', TRUE,
 'Allow teams to submit directly with a submission token. Disable to require an organiser to enter submissions.'),
('feature.submissions.revalidation', TRUE,
 'Re-check submitted repositories on a schedule until the window closes.')
ON CONFLICT (key) DO NOTHING;
