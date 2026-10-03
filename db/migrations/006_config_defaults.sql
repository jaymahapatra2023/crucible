-- 006 — Declared configuration keys and their defaults.
--
-- These are DATA, not constants. E01-S03 acceptance 3 requires model name, concurrency limit and
-- cost ceiling to be configuration; P3.6 makes that true of every behavioural knob. Declaring
-- them by migration means every environment has the full key set at boot, and configService can
-- treat a missing key as a defect rather than silently substituting a literal.
--
-- ON CONFLICT DO NOTHING keeps this idempotent (E01-S02 acceptance 3) and — importantly — means
-- re-running migrations never reverts an operator's tuned value.

INSERT INTO app_config (key, value, value_type, description, module, editable) VALUES

-- LLM gateway -----------------------------------------------------------------------------
('llm.default_model', '"claude-sonnet-5"'::jsonb, 'string',
 'Model used for standard calls when a call key does not override it.', 'llm', TRUE),
('llm.reviewer_model', '"claude-opus-5"'::jsonb, 'string',
 'Independent reviewer model for the worker/reviewer/judge pattern (P4.3).', 'llm', TRUE),
('llm.max_attempts', '3'::jsonb, 'number',
 'Hard cap on attempts per call before failing loudly (E01-S04 acceptance 2).', 'llm', TRUE),
('llm.retry_base_delay_ms', '500'::jsonb, 'number',
 'Base delay for exponential backoff between attempts.', 'llm', TRUE),
('llm.concurrency', '4'::jsonb, 'number',
 'Maximum simultaneous in-flight model calls across the process (E10-S02).', 'llm', TRUE),
('llm.cost_ceiling_usd_per_run', '50'::jsonb, 'number',
 'Spend ceiling for one run. Reaching it pauses the run and alerts (E10-S03).', 'llm', TRUE),
('llm.model_pricing', '{
   "claude-opus-5":   {"inputPerMTok": 15.0, "outputPerMTok": 75.0},
   "claude-sonnet-5": {"inputPerMTok": 3.0,  "outputPerMTok": 15.0},
   "claude-haiku-4-5-20251001": {"inputPerMTok": 0.8, "outputPerMTok": 4.0}
 }'::jsonb, 'json',
 'USD per million tokens, per model, for cost attribution (P9.3, E10-S03).', 'llm', TRUE),

-- Batch orchestration ---------------------------------------------------------------------
('batch.scan_concurrency', '4'::jsonb, 'number',
 'Simultaneous repository scans (E10-S02).', 'batch', TRUE),
('batch.probe_concurrency', '2'::jsonb, 'number',
 'Simultaneous sandboxed build probes. Low by design: each probe is a container.', 'batch', TRUE),
('batch.score_concurrency', '4'::jsonb, 'number',
 'Simultaneous scoring workers (E10-S02).', 'batch', TRUE),

-- Platform ----------------------------------------------------------------------------------
('platform.request_timeout_ms', '30000'::jsonb, 'number',
 'Maximum duration of a synchronous HTTP request before it is cut off (P11.1).', 'platform', TRUE),
('platform.max_upload_bytes', '26214400'::jsonb, 'number',
 'Per-file upload cap in bytes for challenge artifacts (E02-S01 acceptance 2).', 'platform', TRUE)

ON CONFLICT (key) DO NOTHING;

INSERT INTO feature_flag (key, enabled, description) VALUES
('feature.llm.cli_fallback', FALSE,
 'Route model calls through a local CLI when the HTTP provider is unavailable.'),
('feature.probes.network_egress', FALSE,
 'Allow-list package-registry egress during build probes (E05-S01 acceptance 3).'),
('feature.scoring.double_run', TRUE,
 'Score every submission twice and flag disagreement (E06-S06).')
ON CONFLICT (key) DO NOTHING;
