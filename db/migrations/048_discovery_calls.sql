-- 048 — Discovery call registration (E12, P3.2).
--
-- One call key per concern rather than one that returns everything. The reference implementation
-- asks for eleven shapes in a single response; when any part of that JSON is malformed the whole
-- scan is lost. Here a failed extractor costs one concern, recorded as such, and the rest stand.
--
-- None of these is CRITICAL: discovery describes a submission, it does not score one. A failure
-- leaves a gap in the description, which is visible, rather than a gap in an evaluation.

INSERT INTO llm_call_registry
  (call_key, module, purpose, criticality, input_variables, has_fallback, failure_is_terminal, requires_review)
VALUES
  ('discovery.endpoints', 'discovery',
   'Extract the API surface a repository exposes, with file and line for each route.',
   'STANDARD', ARRAY['repo_summary'], FALSE, TRUE, FALSE),

  ('discovery.entities', 'discovery',
   'Extract the data model: entities, their fields and the relationships between them.',
   'STANDARD', ARRAY['repo_summary'], FALSE, TRUE, FALSE),

  ('discovery.capabilities', 'discovery',
   'Extract the business capabilities a repository implements, in domain-neutral terms.',
   'STANDARD', ARRAY['repo_summary'], FALSE, TRUE, FALSE),

  ('discovery.integrations', 'discovery',
   'Extract the external systems a repository talks to, and in which direction.',
   'STANDARD', ARRAY['repo_summary'], FALSE, TRUE, FALSE),

  ('discovery.security', 'discovery',
   'Observe security-relevant patterns in the code. Observations, never a vulnerability verdict.',
   'STANDARD', ARRAY['repo_summary'], FALSE, TRUE, FALSE),

  ('discovery.stack', 'discovery',
   'Identify the languages, frameworks, datastores and infrastructure a repository uses.',
   'STANDARD', ARRAY['repo_summary'], FALSE, TRUE, FALSE),

  ('discovery.claims', 'discovery',
   'Compare what the documentation claims against what the code shows. Advisory only.',
   'STANDARD', ARRAY['repo_summary','code_findings'], FALSE, TRUE, FALSE)
ON CONFLICT (call_key) DO NOTHING;

INSERT INTO llm_call_config
  (call_key, model, reviewer_model, max_tokens, temperature, timeout_ms, max_attempts, log_prompts, log_responses)
VALUES
  ('discovery.endpoints',    'claude-sonnet-5', NULL, 4096, 0.00, 180000, 2, FALSE, FALSE),
  ('discovery.entities',     'claude-sonnet-5', NULL, 4096, 0.00, 180000, 2, FALSE, FALSE),
  ('discovery.capabilities', 'claude-sonnet-5', NULL, 4096, 0.00, 180000, 2, FALSE, FALSE),
  ('discovery.integrations', 'claude-sonnet-5', NULL, 3072, 0.00, 180000, 2, FALSE, FALSE),
  ('discovery.security',     'claude-sonnet-5', NULL, 3072, 0.00, 180000, 2, FALSE, FALSE),
  ('discovery.stack',        'claude-sonnet-5', NULL, 3072, 0.00, 180000, 2, FALSE, FALSE),
  ('discovery.claims',       'claude-sonnet-5', NULL, 3072, 0.00, 180000, 2, FALSE, FALSE)
ON CONFLICT (call_key) DO NOTHING;

INSERT INTO app_config (key, value, value_type, description, module, editable) VALUES
('discovery.context_budget_bytes', '90000'::jsonb, 'number',
 'Bytes of source shown to each discovery extractor. Larger than the scoring budget because discovery reads breadth — an API surface spread across twenty files — where a criterion reads depth.',
 'discovery', TRUE),
('discovery.max_files', '40'::jsonb, 'number',
 'Most files any one discovery extractor is shown.', 'discovery', TRUE),
('discovery.max_findings_per_kind', '80'::jsonb, 'number',
 'Most findings kept per concern. A repository that appears to expose four hundred endpoints has usually confused the extractor, and a list that long is not read anyway.',
 'discovery', TRUE)
ON CONFLICT (key) DO NOTHING;

INSERT INTO feature_flag (key, enabled, description) VALUES
('feature.discovery.enabled', FALSE,
 'Run repository discovery. OFF by default: it costs roughly seven model calls per submission and describes a submission rather than scoring one, so it is opt-in per event.')
ON CONFLICT (key) DO NOTHING;
