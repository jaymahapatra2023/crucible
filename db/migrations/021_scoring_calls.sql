-- 021 — LLM call registration for scoring (E06-S02, E06-S03, E06-S04, E06-S05).
--
-- Every one of these declares `failure_is_terminal = TRUE` and NO fallback. That is P3.5's
-- stated exception, and it is the single most important configuration decision in the system:
-- where a judgement cannot be obtained, the honest output is SCORING_FAILED. A fabricated score
-- would be indistinguishable from a real one and would decide who gets eliminated.

INSERT INTO llm_call_registry
  (call_key, module, purpose, criticality, input_variables, has_fallback, failure_is_terminal, requires_review)
VALUES
  ('scoring.criterion', 'scoring',
   'Score one rubric criterion 0-4 against source excerpts, with evidence.',
   'CRITICAL',
   ARRAY['criterion_name','criterion_description','evidence_spec',
         'anchor_0','anchor_1','anchor_2','anchor_3','anchor_4','repo_summary'],
   FALSE, TRUE, FALSE),

  ('scoring.principles', 'scoring',
   'Assess architectural principle adoption from real source (0-4 maturity).',
   'CRITICAL', ARRAY['principle_name','principle_description','repo_summary'], FALSE, TRUE, FALSE),

  ('scoring.standards', 'scoring',
   'Assess standards compliance from real source (COMPLIANT/PARTIAL/NON_COMPLIANT).',
   'CRITICAL', ARRAY['standard_name','standard_description','repo_summary'], FALSE, TRUE, FALSE),

  ('scoring.engineering', 'scoring',
   'Review engineering quality from metrics plus selected source.',
   'CRITICAL', ARRAY['criterion_name','evidence_spec','metrics_summary','repo_summary'],
   FALSE, TRUE, FALSE),

  ('scoring.originality', 'scoring',
   'Advisory signal on originality and completeness. Lowest weight; never decisive alone.',
   'STANDARD', ARRAY['repo_summary','provenance_summary','boilerplate_summary'],
   FALSE, TRUE, FALSE)
ON CONFLICT (call_key) DO NOTHING;

INSERT INTO llm_call_config
  (call_key, model, reviewer_model, max_tokens, temperature, timeout_ms, max_attempts, log_prompts, log_responses)
VALUES
  -- Temperature 0 throughout (P4.4). The double run measures reproducibility; sampling variance
  -- would make it measure the sampler instead.
  ('scoring.criterion',   'claude-sonnet-5', 'claude-opus-5', 4096, 0.00, 180000, 3, FALSE, FALSE),
  ('scoring.principles',  'claude-sonnet-5', NULL,            4096, 0.00, 180000, 3, FALSE, FALSE),
  ('scoring.standards',   'claude-sonnet-5', NULL,            4096, 0.00, 180000, 3, FALSE, FALSE),
  ('scoring.engineering', 'claude-sonnet-5', NULL,            4096, 0.00, 180000, 3, FALSE, FALSE),
  ('scoring.originality', 'claude-sonnet-5', NULL,            2048, 0.00, 120000, 3, FALSE, FALSE)
ON CONFLICT (call_key) DO NOTHING;

INSERT INTO app_config (key, value, value_type, description, module, editable) VALUES
('scoring.context_budget_bytes', '60000'::jsonb, 'number',
 'Bytes of source excerpt shown per criterion (E06-S01 acceptance 3). The dominant cost driver of a scoring run.',
 'scoring', TRUE),
('scoring.context_window_lines', '12'::jsonb, 'number',
 'Lines kept either side of a matching line when building an excerpt.', 'scoring', TRUE),
('scoring.context_max_files', '8'::jsonb, 'number',
 'Most files to draw excerpts from for one criterion.', 'scoring', TRUE),
('scoring.context_min_relevance', '12'::jsonb, 'number',
 'Below this relevance a file is not evidence, merely a file sharing a word. Tuning this down trades precision for recall.',
 'scoring', TRUE),
('scoring.variance_delta_threshold', '10'::jsonb, 'number',
 'Composite difference between the two runs, in points out of 100, above which a submission is flagged regardless of position (E06-S06 acceptance 4).',
 'scoring', TRUE)
ON CONFLICT (key) DO NOTHING;

INSERT INTO feature_flag (key, enabled, description) VALUES
('feature.scoring.originality', TRUE,
 'Run the advisory originality signal. Disabling omits the dimension rather than scoring it zero.')
ON CONFLICT (key) DO NOTHING;
