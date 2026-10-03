-- 009 — LLM call registration for rubric synthesis (E02-S04, E02-S05).
--
-- Registration is what makes a call runnable at all: the gateway refuses an unregistered
-- call_key (P3.2). Criteria generation is CRITICAL, so it runs worker → reviewer → judge (P4.3),
-- which is why three keys exist for what reads like one operation.
--
-- None of these declare a fallback. A fabricated criterion is worse than no criterion: it would
-- be reviewed as though a model had reasoned about the brief when nothing had.

INSERT INTO llm_call_registry
  (call_key, module, purpose, criticality, input_variables, has_fallback, failure_is_terminal, requires_review)
VALUES
  ('rubrics.criteria_generate', 'rubrics',
   'Propose CHALLENGE_FIDELITY criteria from an extracted brief.',
   'CRITICAL', ARRAY['challenge_name','min_criteria','max_criteria'], FALSE, TRUE, TRUE),

  ('rubrics.criteria_review', 'rubrics',
   'Independently review proposed criteria for coverage and checkability (P4.3 reviewer).',
   'CRITICAL', ARRAY['challenge_name'], FALSE, TRUE, FALSE),

  ('rubrics.criteria_judge', 'rubrics',
   'Decide whether the reviewed criteria set is fit to put in front of the committee (P4.3 judge).',
   'CRITICAL', ARRAY['challenge_name'], FALSE, TRUE, FALSE),

  ('rubrics.quality_gate', 'rubrics',
   'Decide whether a criterion is checkable against a repository, and rewrite it once if not.',
   'CRITICAL',
   ARRAY['criterion_name','description','evidence_spec',
         'anchor_0','anchor_1','anchor_2','anchor_3','anchor_4'],
   FALSE, TRUE, FALSE)
ON CONFLICT (call_key) DO NOTHING;

INSERT INTO llm_call_config
  (call_key, model, reviewer_model, max_tokens, temperature, timeout_ms, max_attempts, log_prompts, log_responses)
VALUES
  -- Generation is the one place a little variety helps: identical criteria from a re-run would
  -- hide that the brief is too thin to support distinct ones (risk R3).
  ('rubrics.criteria_generate', 'claude-sonnet-5', 'claude-opus-5', 8192, 0.20, 180000, 3, FALSE, TRUE),
  ('rubrics.criteria_review',   'claude-opus-5',   NULL,            8192, 0.00, 180000, 3, FALSE, TRUE),
  ('rubrics.criteria_judge',    'claude-opus-5',   NULL,            4096, 0.00, 120000, 3, FALSE, TRUE),
  -- The gate must be reproducible: the same criterion must always get the same verdict.
  ('rubrics.quality_gate',      'claude-sonnet-5', NULL,            4096, 0.00, 120000, 3, FALSE, TRUE)
ON CONFLICT (call_key) DO NOTHING;

INSERT INTO feature_flag (key, enabled, description) VALUES
('feature.rubrics.criteria_generation', TRUE,
 'Propose criteria from an uploaded brief. Disable to force hand-authored rubrics.'),
('feature.rubrics.quality_gate', TRUE,
 'Run the checkability gate over generated criteria before a reviewer sees them (E02-S05).')
ON CONFLICT (key) DO NOTHING;
