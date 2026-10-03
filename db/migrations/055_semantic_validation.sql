-- 055 — Semantic validation as a first-class call outcome (E13, P4.1 clause 3).
--
-- P4.1 names three validations before an LLM output may be stored: schema, content, and
-- SEMANTIC — "output satisfies quality criteria for its type (e.g. a criterion score carries at
-- least one evidence reference with a path and a line range)". Only the first two were enforced.
--
-- The third now runs too, and a response that fails it is a distinct outcome. It is not
-- SCHEMA_INVALID: the shape was correct and every required field was present. Recording it as a
-- schema failure would hide the single most important thing an operator could learn from the
-- logs — that a model returned a well-formed answer whose citations did not hold.

ALTER TABLE llm_call_log DROP CONSTRAINT IF EXISTS llm_call_log_status_check;

ALTER TABLE llm_call_log ADD CONSTRAINT llm_call_log_status_check
  CHECK (status IN ('OK', 'SCHEMA_INVALID', 'SEMANTIC_INVALID', 'PARSE_FAILED', 'TIMEOUT',
                    'RATE_LIMITED', 'PROVIDER_ERROR', 'DISABLED', 'FALLBACK'));

-- How far a cited line range may sit from where the quoted text actually is before the citation
-- is treated as contradicted rather than merely imprecise.
--
-- Configurable because the right value is an empirical question this system has not yet answered:
-- too strict rejects honest work and fails a criterion for a defect in our own line arithmetic,
-- too loose lets a citation point at code a reviewer would not recognise. The dry run (E11-S04)
-- is what should set it.
INSERT INTO app_config (key, value, value_type, description, module, editable) VALUES
('scoring.citation_line_drift', '3'::jsonb, 'number',
 'Lines of tolerance either side of a cited range when checking that the quoted text is where the citation says it is. An off-by-two is a nuisance; beyond this it is treated as contradicted.',
 'scoring', TRUE)
ON CONFLICT (key) DO NOTHING;
